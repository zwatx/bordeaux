import fs from "node:fs/promises";
import path from "node:path";
import { createDemoProject, defaultPathConstraints } from "../shared/project/defaults";
import { MAX_FILE_NAME_BYTES, portableFileStem } from "../shared/portableFileName";
import { validateProject } from "../shared/validation";
import type { CreateNamedProjectRequest, ProjectCopyRequest, ProjectCopyDefaults } from "../shared/project/desktopProjects";
import { absentProjectSource, autosaveProjectFolder, projectWorkspacePath, type ProjectSourceOwner } from "./projectFiles";
import { projectFolderIdentity, type ProjectFolderIdentity } from "./projectFolderIdentity";
import { loadProjectFolderSelection, type ProjectSelection } from "./projectOpening";

export function parseNamedProjectRequest(value: unknown): CreateNamedProjectRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Provide a project name and parent directory");
  const request = value as CreateNamedProjectRequest;
  if (typeof request.name !== "string") throw new Error("Project name must be text");
  const name = request.name.trim();
  if (!name || name === "." || name === ".." || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(name)
    || /[. ]$/.test(name) || /[\uD800-\uDFFF]/u.test(name)
    || Buffer.byteLength(name, "utf8") > MAX_FILE_NAME_BYTES || portableFileStem(name, MAX_FILE_NAME_BYTES) !== name) {
    throw new Error("Choose a plain project name without reserved characters or device names");
  }
  if (typeof request.parentDirectory !== "string" || !path.isAbsolute(request.parentDirectory)
    || request.parentDirectory.length > 4_096 || request.parentDirectory.includes("\0")) {
    throw new Error("Choose an absolute parent directory");
  }
  return { ...request, name, parentDirectory: path.resolve(request.parentDirectory) };
}

/** Creates an exclusive child folder and returns a loaded selection, without activating it. */
export async function createNamedProjectSelection(value: unknown): Promise<ProjectSelection> {
  const request = parseNamedProjectRequest(value);
  const project = createDemoProject();
  project.name = request.name;
  if (request.template !== undefined) {
    if (!request.template || typeof request.template !== "object" || Array.isArray(request.template)
      || !request.template.robot || typeof request.template.robot !== "object" || Array.isArray(request.template.robot)) {
      throw new Error("Project template must contain a valid robot configuration");
    }
    // Validate before serialization: JSON cloning must not turn NaN into null.
    project.robot = request.template.robot;
    project.paths[0].constraints = request.template.constraints === undefined ? defaultPathConstraints(project.robot) : request.template.constraints;
  }
  const validation = validateProject(project);
  if (!validation.ok) throw new Error("Project template robot or limits are invalid");
  project.robot = structuredClone(project.robot);
  project.paths[0].constraints = structuredClone(project.paths[0].constraints);
  const parent = await fs.lstat(request.parentDirectory);
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Project parent must be a regular directory");
  const folder = path.join(request.parentDirectory, request.name);
  try { await fs.mkdir(folder); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("That project folder already exists. Choose another name.");
    throw error;
  }
  // Never remove a partially saved folder after failure: its workspace journal
  // may already contain recoverable source. The caller keeps the old project active.
  await autosaveProjectFolder(folder, project, projectWorkspacePath(folder), { createProject: true, sourceOwner: absentProjectSource(await projectFolderIdentity(folder)) });
  return loadProjectFolderSelection(folder);
}

export interface ProjectCopyMark { creating: boolean; created: boolean; claimed?: ProjectSourceOwner }
type KnownCopyFolder = ProjectFolderIdentity & { objectKey: string };
export interface ProjectCopyFolder { parent: KnownCopyFolder; child: KnownCopyFolder }

/** Exclusive copy admission only. This helper never writes a project or adopts a foreign folder. */
export async function createProjectCopyFolder(request: ProjectCopyRequest,
  o: { assertCurrent(): void; mark: ProjectCopyMark; allowExisting(folder: string): Promise<ProjectSourceOwner | null> },
  io = { identity: projectFolderIdentity, lstat: fs.lstat, mkdir: fs.mkdir },
): Promise<{ created: ProjectCopyFolder } | { existing: ProjectSourceOwner }> {
  let parent: ProjectFolderIdentity;
  try { parent = await io.identity(request.parentDirectory, { assertCurrent: o.assertCurrent }); }
  catch (error) { o.assertCurrent(); if ((error as NodeJS.ErrnoException).code) throw error; throw new Error("Project parent must be a regular directory"); }
  o.assertCurrent();
  if (!parent.objectKey) throw new Error("Project parent must be a regular directory");
  const folder = path.join(parent.folderPath, request.name);
  const sameParent = async () => {
    const st = await io.lstat(parent.folderPath); o.assertCurrent();
    return st.isDirectory() && !st.isSymbolicLink() && `${st.dev}:${st.ino}` === parent.objectKey;
  };
  if (!await sameParent()) throw new Error("Location changed. Choose it again.");
  o.assertCurrent(); o.mark.creating = true;
  try { await io.mkdir(folder); }
  catch (error) {
    o.mark.creating = false;
    o.assertCurrent();
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await o.allowExisting(folder); o.assertCurrent();
    if (!existing) throw new Error("That project folder already exists. Choose another name.");
    return { existing };
  }
  o.mark.creating = false; o.mark.created = true; o.assertCurrent();
  const child = await io.identity(folder, { assertCurrent: o.assertCurrent }); o.assertCurrent();
  if (!child.objectKey || path.dirname(child.pathKey) !== parent.pathKey) throw new Error("That project folder changed while saving");
  if (!await sameParent()) throw new Error("The chosen folder changed while saving");
  o.assertCurrent();
  return { created: { parent: parent as KnownCopyFolder, child: child as KnownCopyFolder } };
}

export class StaleCopyDefaults extends Error {
  constructor() { super("Project context is no longer current"); }
}
type CopyKind = "folder" | "legacy" | "recovered" | "untitled";
export function copyBaseName(base: string, kind: CopyKind): string {
  const clean = base.replace(/[<>:"/\\|?*\x00-\x1f\x7f\uD800-\uDFFF]/gu, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
  return portableFileStem(clean.slice(0, 100).replace(/[. ]+$/, ""), MAX_FILE_NAME_BYTES - 8) || (kind === "untitled" ? "Untitled" : "Project");
}
export function copyCandidates(base: string, kind: CopyKind): string[] {
  const stem = kind === "untitled" ? base : `${base} copy`;
  return [stem, ...Array.from({ length: 98 }, (_, index) => `${stem} ${index + 2}`)];
}
/** Read-only advice. Deadline expiry fences the abandoned worker at its next observation. */
export async function suggestProjectCopy(input: { kind: CopyKind; base: string; parent: string | null },
  o: { ctx(): void; home: string; deadlineMs: number }, io = { identity: projectFolderIdentity, lstat: fs.lstat }): Promise<ProjectCopyDefaults> {
  const names = copyCandidates(copyBaseName(input.base, input.kind), input.kind);
  let chosen = { name: names[0], parentDirectory: o.home }, live = true;
  const abandoned = new Error("Copy defaults observation ended");
  const ctx = () => { o.ctx(); if (!live) throw abandoned; };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = async () => {
    ctx();
    if (input.parent) {
      try { const id = await io.identity(input.parent, { assertCurrent: ctx }); ctx();
        if (id.objectKey) chosen = { name: names[0], parentDirectory: id.folderPath }; }
      catch (error) { ctx(); if (error instanceof StaleCopyDefaults) throw error; }
    }
    for (const name of names) {
      try { await io.lstat(path.join(chosen.parentDirectory, name)); ctx(); }
      catch (error) { ctx(); if (error instanceof StaleCopyDefaults) throw error;
        return (error as NodeJS.ErrnoException).code === "ENOENT" ? { ...chosen, name } : chosen; }
    }
    return chosen;
  };
  try {
    const result = await Promise.race([work(), new Promise<ProjectCopyDefaults>(resolve => {
      timer = setTimeout(() => resolve({ ...chosen }), o.deadlineMs);
    })]);
    o.ctx(); return result;
  } finally { live = false; clearTimeout(timer); }
}
