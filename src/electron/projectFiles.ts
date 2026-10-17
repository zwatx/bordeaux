import { ProjectBdxChangedError } from "./projectBdxExport";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { BordeauxProject } from "../shared/types";
import { decodeProjectFile, encodeProjectFile, prepareProjectFile } from "../shared/project/fileFormat";
import type { DecodedProjectFile } from "../shared/project/fileFormat";
import { MAX_FILE_NAME_BYTES, portableFileStem, truncateUtf8 } from "../shared/portableFileName";
import { projectFolderIdentity, projectFileIdentity, sameProjectFolder, type ProjectFolderIdentity } from "./projectFolderIdentity";

const writeQueues = new Map<string, Promise<void>>();
const openedProjectHashes = new Map<string, string>();
export const MAX_PROJECT_FILE_BYTES = 16 * 1024 * 1024;
/** A workspace holds the whole project plus its file ownership records. */
export const MAX_WORKSPACE_FILE_BYTES = MAX_PROJECT_FILE_BYTES * 2;

export interface ProjectReadOptions { recordOpened?: boolean; assertCurrent?: () => void }
export async function readProject(filePath: string, options: ProjectReadOptions = {}): Promise<DecodedProjectFile> {
  const { sourceEvidence: _evidence, ...decoded } = await readProjectSource(filePath, options);
  return decoded;
}

/** Read evidence belongs to these exact source bytes, before decoding can normalize IDs or fields. */
export async function readProjectSource(filePath: string, options: ProjectReadOptions = {}): Promise<DecodedProjectFile & { sourceEvidence: ProjectSourceEvidence }> {
  filePath = await projectFileIdentity(filePath, options.assertCurrent);
  const identity = await projectFolderIdentity(path.dirname(filePath), options);
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Bordeaux project must be a regular file");
  const maxBytes = path.basename(filePath) === PROJECT_WORKSPACE_FILE ? MAX_WORKSPACE_FILE_BYTES : MAX_PROJECT_FILE_BYTES;
  if (stat.size > maxBytes) throw new Error(`Bordeaux project exceeds the ${maxBytes / 1024 / 1024} MiB size limit`);
  let decoded: DecodedProjectFile, head: SourceHead;
  if (path.basename(filePath) === PROJECT_WORKSPACE_FILE) {
    const snapshot = await readFolderSnapshot(identity.folderPath, options.assertCurrent);
    if (!snapshot) throw new Error("Project workspace is missing");
    decoded = { project: { ...snapshot.state.project, name: path.basename(identity.folderPath) }, migrated: false };
    head = { workspace: snapshot.head };
  } else {
    const contents = await fs.readFile(filePath, "utf8");
    decoded = decodeProjectFile(contents);
    head = { workspace: (await readFolderSnapshot(identity.folderPath, options.assertCurrent))?.head ?? { kind: "absent" },
      legacy: { file: filePath, kind: "file", digest: digest(contents) } };
    if (options.recordOpened !== false) openedProjectHashes.set(filePath, digest(contents));
  }
  await assertReadIdentity(identity, options.assertCurrent);
  options.assertCurrent?.();
  return { ...decoded, sourceEvidence: immutableSourceEvidence(identity, head) };
}

export function saveTargetForOpenedProject(filePath: string, decoded: DecodedProjectFile): string | null {
  return decoded.migrated || /\.bordeaux\.json$/i.test(filePath) ? null : filePath;
}

async function replaceFile(filePath: string, contents: string | Uint8Array, exclusive = false, effect?: { assertCurrent(): void; onWriteStarted?(): void; onReplaced?(): void }): Promise<void> {
  effect?.assertCurrent();
  const target = path.resolve(filePath);
  // At most 100 + 42 bytes, so any target name that fits also has a temporary name that fits.
  const temporary = path.join(path.dirname(target), `.${truncateUtf8(path.basename(target), 100)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, contents, typeof contents === "string" ? { encoding: "utf8", flag: "wx" } : { flag: "wx" });
    effect?.assertCurrent(); effect?.onWriteStarted?.();
    if (exclusive) await fs.link(temporary, target);
    else await fs.rename(temporary, target);
    effect?.onReplaced?.();
    effect?.assertCurrent();
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function jsonContents(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }

// Readers refuse larger files, so writing one would strand the project at its
// next open or save. Checked against the exact UTF-8 bytes before any write.
function withinReadLimit(contents: string, maxBytes: number, label: string): string {
  const bytes = Buffer.byteLength(contents, "utf8");
  if (bytes <= maxBytes) return contents;
  const needed = Math.ceil(bytes / (1024 * 1024) * 10) / 10;
  throw new Error(`${label} would be ${needed} MiB, over the ${maxBytes / 1024 / 1024} MiB limit Bordeaux can reopen, so nothing was saved. Split the project or remove unused paths and routines, then save again.`);
}

function workspaceContents(state: FolderState): string {
  return withinReadLimit(jsonContents(state), MAX_WORKSPACE_FILE_BYTES, "The project workspace");
}

export async function writeProject(filePath: string, value: unknown, exclusive = false): Promise<BordeauxProject> {
  const { project, contents } = encodeProjectFile(value);
  withinReadLimit(contents, MAX_PROJECT_FILE_BYTES, path.basename(filePath));
  const target = path.resolve(filePath);
  const previous = writeQueues.get(target) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(() => replaceFile(target, contents, exclusive));
  writeQueues.set(target, write);
  try {
    await write;
    return project;
  } finally {
    if (writeQueues.get(target) === write) writeQueues.delete(target);
  }
}

export async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await replaceFile(filePath, jsonContents(value));
}

export async function writeBufferAtomically(filePath: string, value: Uint8Array, effect?: { assertCurrent(): void }): Promise<void> {
  await replaceFile(filePath, value, false, effect);
}

export const PROJECT_EXTENSION = ".bordeaux";
export const PROJECT_WORKSPACE_FILE = ".bordeaux-workspace.json";
export function projectWorkspacePath(folder: string): string { return path.join(path.resolve(folder), PROJECT_WORKSPACE_FILE); }
const folderQueues = new Map<string, Promise<unknown>>();
// Preserve call order while asynchronous identity admission resolves a spelling of the folder.
const folderAdmissions = new Map<string, Promise<void>>();
function reserveFolderAdmission(folder: string) {
  const spelling = path.resolve(folder), previous = folderAdmissions.get(spelling) ?? Promise.resolve();
  let release!: () => void;
  const own = new Promise<void>(resolve => { release = resolve; }), queued = previous.catch(() => undefined).then(() => own);
  folderAdmissions.set(spelling, queued);
  return { ready: previous.catch(() => undefined), release: () => {
    release(); if (folderAdmissions.get(spelling) === queued) folderAdmissions.delete(spelling);
  } };
}
interface FolderState { format: "bordeaux-folder/1"; projectPath: string | null; project: BordeauxProject; files: Record<string, string>; pendingFiles?: Record<string, string>; generatedFiles?: Record<string, string>; pendingGeneratedFiles?: Record<string, string>; documentFiles?: Record<string, string>; legacyProjectMirror?: { file: string; hash: string }; importedFrom?: { file: string; hash: string }; }

export function projectFileName(name: string): string {
  const stem = name.replace(/\.bordeaux(?:\.json)?$/i, "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").trim().slice(0, 120) || "Project";
  return `${portableFileStem(stem, MAX_FILE_NAME_BYTES - PROJECT_EXTENSION.length)}${PROJECT_EXTENSION}`;
}

export type WorkspaceHead = { kind: "absent" } | { kind: "workspace"; digest: string };
export type LegacyHead = { file: string; kind: "file"; digest: string } | { file: string; kind: "removed-by-owner" };
export interface SourceHead { workspace: WorkspaceHead; legacy?: LegacyHead }
export interface ProjectSourceEvidence { readonly identity: ProjectFolderIdentity; readonly head: SourceHead }
/** Main-only mutable physical bookkeeping. A captured writer may advance only its own object. */
export interface ProjectSourceOwner { identity: ProjectFolderIdentity; head: SourceHead }
export class ProjectSourceChangedError extends Error {
  readonly code = "PROJECT_SOURCE_CHANGED";
  constructor(public readonly scope: "workspace" | "document", public readonly file?: string) {
    super(scope === "workspace" ? "Project source changed on disk. Reopen the project or save a copy in a different folder."
      : `${file} changed outside Bordeaux. Preserve or rename it before saving again.`);
  }
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function workspaceHead(raw: Record<string, unknown>): WorkspaceHead {
  const { generatedFiles: _generated, pendingGeneratedFiles: _pending, ...source } = raw;
  return { kind: "workspace", digest: digest(stableJson(source)) };
}
function immutableSourceEvidence(identity: ProjectFolderIdentity, head: SourceHead): ProjectSourceEvidence {
  const copy = structuredClone(head);
  Object.freeze(copy.workspace); if (copy.legacy) Object.freeze(copy.legacy);
  return Object.freeze({ identity: Object.freeze({ ...identity }), head: Object.freeze(copy) });
}
export function ownProjectSource(evidence: ProjectSourceEvidence): ProjectSourceOwner {
  return { identity: { ...evidence.identity }, head: structuredClone(evidence.head) };
}
export function absentProjectSource(identity: ProjectFolderIdentity): ProjectSourceOwner {
  return { identity: { ...identity }, head: { workspace: { kind: "absent" } } };
}
async function assertReadIdentity(identity: ProjectFolderIdentity, assertCurrent?: () => void): Promise<void> {
  const after = await projectFolderIdentity(identity.folderPath, { assertCurrent });
  if (after.objectKey !== identity.objectKey) throw new Error("Project folder changed while reading. Open it again.");
  assertCurrent?.();
}
async function readFolderSnapshot(folder: string, assertCurrent?: () => void): Promise<{ raw: Record<string, unknown>; state: FolderState; head: WorkspaceHead } | null> {
  const target = path.join(folder, PROJECT_WORKSPACE_FILE);
  try {
    assertCurrent?.();
    const stat = await fs.lstat(target); assertCurrent?.();
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_WORKSPACE_FILE_BYTES) throw new Error("Folder recovery file is not a valid regular file");
    const contents = await fs.readFile(target, "utf8"); assertCurrent?.();
    const raw = JSON.parse(contents) as Record<string, unknown>;
    if (raw.format !== "bordeaux-folder/1" || !raw.files || typeof raw.files !== "object") throw new Error("This folder already contains an unrelated recovery file");
    const head = workspaceHead(raw);
    const state = { ...raw, project: prepareProjectFile(raw.project) } as unknown as FolderState;
    return { raw, state, head };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
async function readFolderState(folder: string, assertCurrent?: () => void): Promise<FolderState | null> {
  return (await readFolderSnapshot(folder, assertCurrent))?.state ?? null;
}
/** Read-only comparison; never grants authority to the bytes just observed. */
export async function assertProjectSource(owner: ProjectSourceOwner, assertCurrent?: () => void): Promise<void> {
  assertCurrent?.();
  const snapshot = await readFolderSnapshot(owner.identity.folderPath, assertCurrent);
  const actual = snapshot?.head ?? { kind: "absent" };
  if (stableJson(actual) !== stableJson(owner.head.workspace)) throw new ProjectSourceChangedError("workspace");
  const legacy = owner.head.legacy;
  if (legacy) {
    try {
      const stat = await fs.lstat(legacy.file); assertCurrent?.();
      if (legacy.kind !== "file" || !stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PROJECT_FILE_BYTES
        || digest(await fs.readFile(legacy.file)) !== legacy.digest) throw new ProjectSourceChangedError("workspace");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (legacy.kind !== "removed-by-owner") throw new ProjectSourceChangedError("workspace");
    }
  }
  if (owner.head.workspace.kind === "absent") {
    const entries = await fs.readdir(owner.identity.folderPath, { withFileTypes: true }); assertCurrent?.();
    if (entries.some(entry => /\.bordeaux(?:\.json)?$/i.test(entry.name) && path.join(owner.identity.folderPath, entry.name) !== legacy?.file)) throw new ProjectSourceChangedError("workspace");
  }
  assertCurrent?.();
}
export async function openProjectFolder(folder: string, options: ProjectReadOptions = {}): Promise<{ project: BordeauxProject | null; projectPath: string | null; legacyFile?: string }> {
  const { sourceEvidence: _evidence, ...opened } = await openProjectFolderSource(folder, options); return opened;
}
export async function openProjectFolderSource(folder: string, options: ProjectReadOptions = {}): Promise<{ project: BordeauxProject | null; projectPath: string | null; legacyFile?: string; sourceEvidence: ProjectSourceEvidence }> {
  const requestedFolder = path.resolve(folder);
  const identity = await projectFolderIdentity(folder, options); folder = identity.folderPath;
  const snapshot = await readFolderSnapshot(folder, options.assertCurrent), state = snapshot?.state;
  let opened: { project: BordeauxProject | null; projectPath: string | null; legacyFile?: string }, head: SourceHead;
  if (state) {
    let projectPath: string | null = null;
    if (state.projectPath) {
      const recordedParent = await projectFolderIdentity(path.dirname(path.resolve(state.projectPath)), options).catch(() => { options.assertCurrent?.(); return null; });
      if (recordedParent && sameProjectFolder(identity, recordedParent)) projectPath = path.join(folder, path.basename(state.projectPath));
    }
    opened = { project: { ...state.project, name: path.basename(folder) }, projectPath: projectWorkspacePath(folder) };
    head = { workspace: snapshot!.head };
    if (projectPath) {
      try {
        const [projectStat, recoveryStat] = await Promise.all([fs.lstat(projectPath), fs.lstat(projectWorkspacePath(folder))]);
        if (projectStat.mtimeMs > recoveryStat.mtimeMs) {
          const selected = await readProjectSource(projectPath, options);
          opened = { project: { ...selected.project, name: path.basename(folder) }, projectPath };
          // The workspace snapshot that selected this legacy source remains part of the read evidence.
          head = { workspace: snapshot!.head, legacy: selected.sourceEvidence.head.legacy };
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  } else {
    const files = (await fs.readdir(folder, { withFileTypes: true })).filter(entry => entry.isFile() && /\.bordeaux(?:\.json)?$/i.test(entry.name));
    if (files.length > 1) throw new Error("This folder contains several projects. Open the desired .bordeaux file instead.");
    if (files.length) {
      const target = path.join(folder, files[0].name), selected = await readProjectSource(target, options);
      opened = { project: { ...selected.project, name: path.basename(folder) }, projectPath: saveTargetForOpenedProject(target, selected), legacyFile: target };
      head = selected.sourceEvidence.head;
    } else { opened = { project: null, projectPath: null }; head = { workspace: { kind: "absent" } }; }
  }
  await assertReadIdentity(identity, options.assertCurrent);
  return { ...opened, projectPath: opened.projectPath ? path.join(requestedFolder, path.basename(opened.projectPath)) : null,
    ...(opened.legacyFile ? { legacyFile: path.join(requestedFolder, path.basename(opened.legacyFile)) } : {}), sourceEvidence: immutableSourceEvidence(identity, head) };
}

// Journal locators are optional history, not current source/destination authority.
// Moving a folder can leave their former parent unavailable.
async function historicalProjectFile(file: string | null | undefined): Promise<string | null> {
  if (!file) return null;
  try { return await projectFileIdentity(file); } catch { return null; }
}

/** Whether edits from this legacy project file continue in its folder's workspace. */
export async function workspaceContinuesLegacyFile(filePath: string): Promise<boolean> {
  const file = await projectFileIdentity(filePath);
  const state = await readFolderState(path.dirname(file));
  if (!state) return false;
  // Older workspaces journaled recovery for the legacy file they belonged to.
  if (await historicalProjectFile(state.projectPath) === file) return true;
  // Earlier versions recorded an unfinished .bordeaux migration only as its mirror.
  const hashes: string[] = [];
  for (const source of [state.importedFrom, state.legacyProjectMirror]) if (source && await historicalProjectFile(source.file) === file) hashes.push(source.hash);
  if (!hashes.length) return false;
  try {
    const stat = await fs.lstat(file);
    return stat.isFile() && !stat.isSymbolicLink() && hashes.includes(digest(await fs.readFile(file)));
  } catch (error) {
    // A migrated .bordeaux file is removed after its workspace is written.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

// Only bytes this process opened, still unchanged, prove the workspace continues a legacy file.
async function importedLegacyFile(folder: string, file: string): Promise<FolderState["importedFrom"]> {
  const source = path.resolve(file);
  const hash = openedProjectHashes.get(source);
  if (!hash || path.dirname(source) !== folder) return undefined;
  try {
    const stat = await fs.lstat(source);
    if (stat.isFile() && !stat.isSymbolicLink() && digest(await fs.readFile(source)) === hash) return { file: source, hash };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return undefined;
}

// A legacy file's contents may replace an existing workspace only when that
// workspace recorded the exact bytes this process opened from it.
async function workspaceRecordsOpenedFile(state: FolderState, file: string): Promise<boolean> {
  const source = path.resolve(file);
  const hash = openedProjectHashes.get(source);
  if (hash === undefined) return false;
  for (const record of [state.importedFrom, state.legacyProjectMirror]) if (record && record.hash === hash && await historicalProjectFile(record.file) === source) return true;
  return false;
}

function digest(contents: string | Uint8Array): string { return createHash("sha256").update(contents).digest("hex"); }

// Room for the widest duplicate suffix (validation allows 1,024 documents of a
// kind) and the longest extension, so every derived name fits in one component.
const DOCUMENT_STEM_BYTES = MAX_FILE_NAME_BYTES - " (99999)".length - ".routine".length;

function safeDocumentName(name: string): string {
  const clean = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").trim().replace(/[. ]+$/, "").slice(0, 120) || "Untitled";
  return portableFileStem(clean, DOCUMENT_STEM_BYTES);
}

async function fileOwnership(folder: string, file: string, stat: { dev: number | bigint; ino: number | bigint }, records: readonly (Record<string, string> | undefined)[], assertCurrent?: () => void) {
  const hashes = records.flatMap((record) => record?.[file] ? [record[file]] : []);
  const aliases: string[] = [];
  for (const prior of new Set(records.flatMap((record) => Object.keys(record ?? {})))) {
    if (prior === file || prior.toLowerCase() !== file.toLowerCase()) continue;
    try {
      const old = await fs.lstat(path.join(folder, prior));
      assertCurrent?.();
      const entries = await fs.readdir(path.dirname(path.join(folder, file))); assertCurrent?.();
      // On case-sensitive filesystems, two distinct names (including hard links)
      // are not ownership aliases. On case-insensitive filesystems they are one entry.
      if (!old.isSymbolicLink() && old.dev === stat.dev && old.ino === stat.ino
        && !(entries.includes(path.basename(prior)) && entries.includes(path.basename(file)))) {
        aliases.push(prior);
        hashes.push(...records.flatMap((record) => record?.[prior] ? [record[prior]] : []));
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return { hashes, aliases };
}

// Rejects a symlinked or non-directory entry before ownership data is read.
// Saves create it only after every size check, so a rejected save adds no folders.
async function checkRegularDirectory(directory: string, label: string, create = false): Promise<void> {
  if (create) await fs.mkdir(directory, { recursive: true });
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular directory`);
  } catch (error) { if (create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

async function removeOwnedDocument(folder: string, file: string, hashes: readonly (string | undefined)[], binary = false, effect?: { assertCurrent(): void; onWriteStarted?(): void }): Promise<void> {
  if (binary && !/^Paths\/[^/\\]+\.bdx$/i.test(file)) return;
  if (!binary && !/^(Paths\/[^/\\]+\.path|Routines\/[^/\\]+\.routine)$/i.test(file)) return;
  const destination = path.join(folder, file);
  try {
    effect?.assertCurrent();
    const directoryStat = await fs.lstat(path.dirname(destination)); effect?.assertCurrent();
    const stat = await fs.lstat(destination); effect?.assertCurrent();
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink()) throw new Error(`${file} is no longer a regular managed file; it was preserved.`);
    const contents = await fs.readFile(destination); effect?.assertCurrent();
    if (!hashes.includes(digest(contents))) throw new Error(`${file} changed outside Bordeaux. The old file was preserved.`);
    effect?.assertCurrent(); effect?.onWriteStarted?.();
    await fs.unlink(destination); effect?.assertCurrent();
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

async function legacyProjectMirror(folder: string, old: FolderState | null, openedPath: string | null, openedProject: BordeauxProject): Promise<FolderState["legacyProjectMirror"]> {
  if (old?.legacyProjectMirror) {
    const file = await historicalProjectFile(old.legacyProjectMirror.file);
    return file && path.dirname(file) === folder ? { ...old.legacyProjectMirror, file } : undefined;
  }
  const selected = old?.projectPath && /\.bordeaux$/i.test(old.projectPath) ? old.projectPath : openedPath;
  const file = await historicalProjectFile(selected);
  if (!file || path.dirname(path.resolve(file)) !== folder || !/\.bordeaux$/i.test(file)) return undefined;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PROJECT_FILE_BYTES) return undefined;
    const contents = await fs.readFile(file, "utf8");
    const hash = digest(contents);
    // A first save may contain edits made after opening a standalone project.
    // Original-read provenance proves its old file is still the selected source.
    if (openedProjectHashes.get(path.resolve(file)) === hash) return { file, hash };
    const decoded = decodeProjectFile(contents);
    const expected = old?.project ?? openedProject;
    // Folder naming is canonical even for an imported project called Untitled.
    if (encodeProjectFile({ ...decoded.project, name: path.basename(folder) }).contents
      === encodeProjectFile({ ...expected, name: path.basename(folder) }).contents) return { file, hash: digest(contents) };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return undefined;
}

async function removeLegacyProjectMirror(folder: string, mirror: FolderState["legacyProjectMirror"], owner?: ProjectSourceOwner, effect?: { assertCurrent(): void }): Promise<void> {
  if (!mirror || path.dirname(path.resolve(mirror.file)) !== folder || !/\.bordeaux$/i.test(mirror.file)) return;
  try {
    const stat = await fs.lstat(mirror.file);
    if (!stat.isFile() || stat.isSymbolicLink() || digest(await fs.readFile(mirror.file)) !== mirror.hash) throw new Error("The old project file changed outside Bordeaux and was preserved.");
    effect?.assertCurrent();
    await fs.unlink(mirror.file);
    if (owner?.head.legacy?.file === mirror.file) owner.head = { ...owner.head, legacy: { file: mirror.file, kind: "removed-by-owner" } };
    effect?.assertCurrent();
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export interface ProjectBdxWriteOptions {
  /** A selected export updates only the supplied outputs, retaining sibling ownership and bytes. */
  mode?: "selected";
  folderIdentity?: ProjectFolderIdentity;
  expectedSourceDigest?: string;
  assertCurrent?: () => void;
  onWriteStarted?: () => void;
}

/** Save explicitly generated binaries without compiling trajectories during autosave. */
export async function writeProjectFolderBdx(folder: string, files: readonly { fileName: string; bytes: Uint8Array }[], options: ProjectBdxWriteOptions = {}): Promise<void> {
  const guard = () => options.assertCurrent?.();
  const effect = { assertCurrent: guard, onWriteStarted: options.onWriteStarted };
  guard();
  const names = new Set<string>();
  const documents = files.map(({ fileName, bytes }) => {
    const stem = fileName.slice(0, -".bdx".length);
    if (!/^[^<>:"/\\|?*\x00-\x1f]+\.bdx$/i.test(fileName) || portableFileStem(stem, MAX_FILE_NAME_BYTES - ".bdx".length) !== stem) throw new Error("BDX output must have a plain .bdx filename");
    const key = fileName.toLowerCase();
    if (names.has(key)) throw new Error(`Duplicate BDX output filename: ${fileName}`);
    names.add(key);
    return { file: `Paths/${fileName}`, bytes: Buffer.from(bytes) };
  });
  const admission = reserveFolderAdmission(folder); await admission.ready;
  let pending: Promise<void>, target: string, queueKey: string;
  try {
    guard();
    const resolved = await projectFolderIdentity(folder, { assertCurrent: guard }); guard();
    const identity = options.folderIdentity ?? resolved;
    if (!sameProjectFolder(resolved, identity) || resolved.objectKey !== identity.objectKey) throw new ProjectBdxChangedError("Project folder changed before BDX saving started");
    target = identity.folderPath; queueKey = identity.pathKey;
    const previous = folderQueues.get(queueKey) ?? Promise.resolve();
    pending = previous.catch(() => undefined).then(async () => {
      guard();
      const folderStat = await fs.lstat(target);
      guard();
      if (!folderStat.isDirectory() || folderStat.isSymbolicLink()) throw new Error("Project folder must be a regular directory");
      if (identity.objectKey !== `${folderStat.dev}:${folderStat.ino}` || (await fs.realpath(target)) !== target) throw new ProjectBdxChangedError("Project folder changed before BDX saving started");
      guard();
      const snapshot = await readFolderSnapshot(target, guard), state = snapshot?.state; guard();
      if (!state) throw new Error("Save the project source before generating BDX files");
      if (options.expectedSourceDigest && digest(encodeProjectFile({ ...state.project, name: path.basename(target) }).contents) !== options.expectedSourceDigest) throw new ProjectBdxChangedError("The saved source changed before BDX writing; save again");
      const directory = path.join(target, "Paths");
      await checkRegularDirectory(directory, "Paths"); guard();
      const observed: Record<string, string> = { ...state.generatedFiles };
      const existing = new Map<string, string>();
      const replacedAliases = new Set<string>();
      for (const document of documents) {
        try {
          const destination = path.join(target, document.file);
          const stat = await fs.lstat(destination); guard();
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Cannot replace ${document.file}: expected a regular file`);
          const hash = digest(await fs.readFile(destination)); guard();
          const ownership = await fileOwnership(target, document.file, stat, [state.generatedFiles, state.pendingGeneratedFiles], guard); guard();
          if (!ownership.hashes.includes(hash)) throw new Error(`${document.file} is unrelated or changed outside Bordeaux. Preserve or rename it before saving again.`);
          ownership.aliases.forEach((alias) => replacedAliases.add(alias));
          observed[document.file] = hash;
          existing.set(document.file, hash);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      const intendedFiles = Object.fromEntries(documents.map((document) => [document.file, digest(document.bytes)]));
      const generatedFiles = options.mode === "selected" ? { ...state.generatedFiles, ...intendedFiles } : intendedFiles;
      const pendingGeneratedFiles = options.mode === "selected" ? { ...state.pendingGeneratedFiles } : undefined;
      for (const file of [...Object.keys(intendedFiles), ...replacedAliases]) {
        if (replacedAliases.has(file)) delete generatedFiles[file];
        if (pendingGeneratedFiles) delete pendingGeneratedFiles[file];
      }
      const workspace = path.join(target, PROJECT_WORKSPACE_FILE);
      const journal = workspaceContents({ ...snapshot!.raw, generatedFiles: observed, pendingGeneratedFiles: { ...state.pendingGeneratedFiles, ...intendedFiles } } as unknown as FolderState);
      const committed = workspaceContents({ ...snapshot!.raw, generatedFiles, pendingGeneratedFiles } as unknown as FolderState);
      guard();
      try { await fs.lstat(directory); guard(); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        guard(); options.onWriteStarted?.(); await fs.mkdir(directory); guard();
      }
      await checkRegularDirectory(directory, "Paths"); guard();
      // Journal intended hashes first so a failed multi-file save can be retried.
      await replaceFile(workspace, journal, false, effect);
      for (const document of documents) {
        const destination = path.join(target, document.file);
        if (existing.has(document.file)) {
          const stat = await fs.lstat(destination); guard();
          if (!stat.isFile() || stat.isSymbolicLink() || digest(await fs.readFile(destination)) !== existing.get(document.file)) throw new Error(`${document.file} changed outside Bordeaux while saving.`);
        }
        guard();
        await replaceFile(destination, document.bytes, !existing.has(document.file), effect);
        const alias = [...replacedAliases].find((file) => file.toLowerCase() === document.file.toLowerCase());
        if (alias) { guard(); options.onWriteStarted?.(); await fs.rename(path.join(target, alias), destination); guard(); }
      }
      for (const file of options.mode === "selected" ? [] : new Set([...Object.keys(state.generatedFiles ?? {}), ...Object.keys(state.pendingGeneratedFiles ?? {})])) {
        if (!(file in generatedFiles) && !replacedAliases.has(file)) await removeOwnedDocument(target, file, [state.generatedFiles?.[file], state.pendingGeneratedFiles?.[file]], true, effect);
      }
      guard();
      await replaceFile(workspace, committed, false, effect);
    });
    folderQueues.set(queueKey, pending);
  } finally { admission.release(); }
  try { await pending; } finally { if (folderQueues.get(queueKey) === pending) folderQueues.delete(queueKey); }
}

// The workspace is the sole folder project; mirrors follow each committed edit.
// A failed mirror write leaves the latest source recoverable. Only hash-owned
// documents may be replaced or removed after their successors have been written.
// `legacyFile` names the opened project file these edits continue, if any. Its
// edits never replace a workspace that cannot be proven to continue that file.
export async function autosaveProjectFolder(folder: string, value: unknown, projectPath: string | null, options: { createProject?: boolean; legacyFile?: string | null; assertCurrent?: () => void; folderIdentity?: ProjectFolderIdentity; sourceOwner?: ProjectSourceOwner } = {}): Promise<BordeauxProject> {
  const decoded = prepareProjectFile(value), admission = reserveFolderAdmission(folder); await admission.ready;
  let pending: Promise<BordeauxProject>, target: string, queueKey: string;
  try {
    const identity = options.folderIdentity ?? await projectFolderIdentity(folder, options); target = identity.folderPath; queueKey = identity.pathKey;
    if (options.folderIdentity && path.resolve(folder) !== target) throw new Error("Captured folder destination does not match its identity");
    if (!options.folderIdentity) {
      projectPath = projectPath ? await projectFileIdentity(projectPath, options.assertCurrent) : null;
      options = { ...options, legacyFile: options.legacyFile ? await projectFileIdentity(options.legacyFile, options.assertCurrent) : options.legacyFile };
    }
    options.assertCurrent?.();
    const project = { ...decoded, name: path.basename(target) };
    const previous = folderQueues.get(queueKey) ?? Promise.resolve();
    pending = previous.catch(() => undefined).then(async () => {
      options.assertCurrent?.();
      const folderStat = await fs.lstat(target);
      if (!folderStat.isDirectory() || folderStat.isSymbolicLink()) throw new Error("Project folder must be a regular directory");
      if (identity.objectKey !== `${folderStat.dev}:${folderStat.ino}` || (await fs.realpath(target)) !== target) throw new Error("Project folder changed before saving started");
      options.assertCurrent?.();
      if (projectPath && path.dirname(path.resolve(projectPath)) !== target) throw new Error("Project file must stay in the opened folder");
      const owner = options.sourceOwner;
      if (owner && (!sameProjectFolder(owner.identity, identity) || owner.identity.objectKey !== identity.objectKey)) throw new Error("Captured source owner does not match the destination");
      if (owner) await assertProjectSource(owner, options.assertCurrent);
      const old = await readFolderState(target, options.assertCurrent);
      if (old && options.legacyFile && !await workspaceRecordsOpenedFile(old, options.legacyFile)) {
        const name = path.basename(options.legacyFile);
        throw new Error(`This folder already has a Bordeaux workspace that may hold newer work than ${name}, so nothing was saved. Open the folder to recover its current work, or use Save As to import ${name} into a different folder.`);
      }
      const workspace = projectWorkspacePath(target);
      if (old && projectPath && path.resolve(projectPath) !== workspace) {
        const oldProjectPath = await historicalProjectFile(old.projectPath), oldMirrorPath = await historicalProjectFile(old.legacyProjectMirror?.file);
        if (oldProjectPath !== projectPath && oldMirrorPath !== projectPath) {
          try { await fs.lstat(projectPath); throw new Error("This folder is already open for another Bordeaux project"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
      }
      if (options.createProject && projectPath && path.resolve(projectPath) !== workspace) {
        try { await fs.lstat(projectPath); throw Object.assign(new Error("Project file already exists"), { code: "EEXIST" }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      const used = new Set<string>();
      const documents = [
        ...project.paths.map((item) => ({ directory: "Paths", extension: "path", item })),
        ...project.routines.map((item) => ({ directory: "Routines", extension: "routine", item })),
      ].map(({ directory, extension, item }) => {
        const stem = `${directory}/${safeDocumentName(item.name)}`;
        const key = `${extension}:${item.id}`;
        const prior = old?.documentFiles?.[key];
        const suffix = prior?.slice(stem.length);
        const reusable = prior?.startsWith(stem) && (suffix === `.${extension}` || suffix?.match(/^ \([1-9][0-9]*\)\.(path|routine)$/)?.[1] === extension);
        const file = prior && reusable && !used.has(prior.toLowerCase()) ? prior : "";
        if (file) used.add(file.toLowerCase());
        const pathVersion = "waypoints" in item && item.optimization?.accepted?.version === 2 ? "2.1" : "2.0";
        return { key, stem, extension, file, contents: `${JSON.stringify(extension === "path" ? { version: pathVersion, robot: project.robot, ...item } : { format: "bordeaux-routine/1", ...item }, null, 2)}\n` };
      });
      for (const document of documents) {
        if (document.file) continue;
        let number = 1;
        let file = `${document.stem}.${document.extension}`;
        while (used.has(file.toLowerCase())) file = `${document.stem} (${++number}).${document.extension}`;
        document.file = file; used.add(file.toLowerCase());
      }
      for (const document of documents) withinReadLimit(document.contents, MAX_PROJECT_FILE_BYTES, document.file);
      for (const directory of ["Paths", "Routines"]) await checkRegularDirectory(path.join(target, directory), directory);
      const observedFiles = { ...old?.files };
      const existing = new Map<string, string>();
      const replacedAliases = new Set<string>();
      for (const document of documents) {
        try {
          const destination = path.join(target, document.file);
          const stat = await fs.lstat(destination);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PROJECT_FILE_BYTES) throw new Error(`Cannot replace ${document.file}`);
          const hash = digest(await fs.readFile(destination, "utf8"));
          const ownership = await fileOwnership(target, document.file, stat, [old?.files, old?.pendingFiles]);
          if (!ownership.hashes.includes(hash)) throw new ProjectSourceChangedError("document", document.file);
          ownership.aliases.forEach((alias) => replacedAliases.add(alias));
          observedFiles[document.file] = hash; existing.set(document.file, hash);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      const files = Object.fromEntries(documents.map((item) => [item.file, digest(item.contents)]));
      const state: FolderState = { format: "bordeaux-folder/1", projectPath: workspace, project, files,
        documentFiles: Object.fromEntries(documents.map((item) => [item.key, item.file])),
        generatedFiles: old?.generatedFiles, pendingGeneratedFiles: old?.pendingGeneratedFiles,
        legacyProjectMirror: await legacyProjectMirror(target, old, projectPath, decoded),
        importedFrom: options.legacyFile ? (await importedLegacyFile(target, options.legacyFile)) ?? old?.importedFrom : old?.importedFrom };
      const journal = workspaceContents({ ...state, files: observedFiles, pendingFiles: { ...old?.pendingFiles, ...files } });
      const committed = workspaceContents({ ...state, legacyProjectMirror: undefined });
      if (owner) await assertProjectSource(owner, options.assertCurrent);
      const effect = { assertCurrent: () => options.assertCurrent?.() };
      const replaceWorkspace = (contents: string) => replaceFile(workspace, contents, false, { ...effect,
        onReplaced: () => { if (owner) owner.head = { ...owner.head, workspace: workspaceHead(JSON.parse(contents)) }; } });
      for (const directory of ["Paths", "Routines"]) {
        effect.assertCurrent(); await checkRegularDirectory(path.join(target, directory), directory, true); effect.assertCurrent();
      }
      // Journal the complete source before mirrors; retries recognize both old and
      // partially written new content without deleting anything before replacement.
      await replaceWorkspace(journal);
      for (const document of documents) {
        const destination = path.join(target, document.file);
        const current = existing.get(document.file);
        if (current) {
          const stat = await fs.lstat(destination);
          if (!stat.isFile() || stat.isSymbolicLink() || digest(await fs.readFile(destination)) !== current) throw new Error(`${document.file} changed outside Bordeaux while saving.`);
        }
        const alias = [...replacedAliases].find((file) => file.toLowerCase() === document.file.toLowerCase());
        // An owned file already holding these bytes needs no replacement unless
        // its entry still carries a case-only alias of the intended name.
        if (current === files[document.file] && !alias) continue;
        await replaceFile(destination, document.contents, !current, effect);
        if (alias) { effect.assertCurrent(); await fs.rename(path.join(target, alias), destination); effect.assertCurrent(); }
      }
      for (const file of new Set([...Object.keys(old?.files ?? {}), ...Object.keys(old?.pendingFiles ?? {})])) {
        if (!(file in files) && !replacedAliases.has(file)) await removeOwnedDocument(target, file, [old?.files[file], old?.pendingFiles?.[file]], false, effect);
      }
      await removeLegacyProjectMirror(target, state.legacyProjectMirror, owner, effect);
      if (owner) await assertProjectSource(owner, options.assertCurrent);
      await replaceWorkspace(committed);
      return project;
    });
    folderQueues.set(queueKey, pending);
  } finally { admission.release(); }
  try { return await pending; } finally { if (folderQueues.get(queueKey) === pending) folderQueues.delete(queueKey); }
}
