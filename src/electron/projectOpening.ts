import fs from "node:fs/promises";
import path from "node:path";
import { createDemoProject } from "../shared/project/defaults";
import type { BordeauxProject } from "../shared/types";
import { openProjectFolderSource, readProjectSource, saveTargetForOpenedProject, workspaceContinuesLegacyFile, PROJECT_WORKSPACE_FILE, type ProjectReadOptions, type ProjectSourceEvidence } from "./projectFiles";
export interface ProjectSelectionReadOptions extends ProjectReadOptions { requireSource?: boolean }

export interface ProjectSelection {
  project: BordeauxProject;
  sourceEvidence: ProjectSourceEvidence;
  projectPath: string | null;
  folderPath: string;
  recentPath: string;
  /** Legacy project file whose contents were loaded; saves record it as the workspace source and refuse to replace an unproven existing workspace. */
  legacyFile: string | null;
}

async function lstatIfPresent(filePath: string) {
  try { return await fs.lstat(filePath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export async function loadProjectFolderSelection(folder: string, options: ProjectSelectionReadOptions = {}): Promise<ProjectSelection> {
  const opened = await openProjectFolderSource(folder, options);
  options.assertCurrent?.();
  if (options.requireSource && !opened.project) throw Object.assign(new Error("The project source is no longer available"), { code: "ENOENT" });
  return { project: { ...(opened.project ?? createDemoProject()), name: path.basename(path.resolve(folder)) },
    sourceEvidence: opened.sourceEvidence, projectPath: opened.projectPath, folderPath: folder, recentPath: folder, legacyFile: opened.legacyFile ?? null };
}

// Loading never changes the active target, dirty state, recent list, or robot link.
// The caller commits a selection only after every read and parse has succeeded.
export async function loadProjectSelection(filePath: string, options: ProjectSelectionReadOptions = {}): Promise<ProjectSelection> {
  if ((await lstatIfPresent(filePath))?.isDirectory()) return loadProjectFolderSelection(filePath, options);
  if (path.basename(filePath) === PROJECT_WORKSPACE_FILE) return loadProjectFolderSelection(path.dirname(filePath), options);
  if (/\.(path|routine)$/i.test(filePath) && ["Paths", "Routines"].includes(path.basename(path.dirname(filePath)))) {
    const folder = path.dirname(path.dirname(filePath));
    if (await lstatIfPresent(path.join(folder, PROJECT_WORKSPACE_FILE))) {
      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error("Managed project document must be a regular file under 16 MiB");
      const item: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
      if (!item || typeof item !== "object" || !("id" in item) || typeof item.id !== "string") throw new Error("Managed project document must have an item ID");
      const selection = await loadProjectFolderSelection(folder, options);
      if (selection.project.paths.some((entry) => entry.id === item.id)) selection.project.editor = { ...selection.project.editor, activePathId: item.id };
      if (selection.project.routines.some((entry) => entry.id === item.id)) selection.project.activeRoutineId = item.id;
      return selection;
    }
  }
  const folder = path.dirname(filePath);
  // Reopening an autosaved legacy file must not load its older contents over the
  // workspace. An unrelated legacy file in the same folder still opens as chosen,
  // but saving it cannot replace that workspace.
  if (await workspaceContinuesLegacyFile(filePath)) return loadProjectFolderSelection(folder, options);
  const decoded = await readProjectSource(filePath, options);
  return { project: decoded.project, sourceEvidence: decoded.sourceEvidence, projectPath: saveTargetForOpenedProject(filePath, decoded), folderPath: folder, recentPath: filePath, legacyFile: filePath };
}
