import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { RecentProjectEntry, RecentProjectCode } from "../shared/project/desktopProjects";
import { MAX_PROJECT_FILE_BYTES, MAX_WORKSPACE_FILE_BYTES, PROJECT_WORKSPACE_FILE, writeJsonAtomically } from "./projectFiles";
import { loadProjectSelection } from "./projectOpening";

const VERSION = 1;
const MAX_PROJECTS = 8;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_PATH_LENGTH = 4_096;
const writeQueues = new Map<string, Promise<void>>();

function recentPathKey(projectPath: string): string {
  const normalized = path.resolve(projectPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizeProjects(values: unknown[]): string[] {
  const projects: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.length > MAX_PATH_LENGTH || value.includes("\0") || !path.isAbsolute(value)) continue;
    const projectPath = path.normalize(value);
    const key = recentPathKey(projectPath);
    if (!seen.has(key)) { projects.push(projectPath); seen.add(key); }
    if (projects.length === MAX_PROJECTS) break;
  }
  return projects;
}

export async function readRecentProjectFiles(filePath: string): Promise<string[]> {
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Recent project storage is not a regular file");
  if (stat.size > MAX_FILE_BYTES) throw new Error("Recent project storage exceeds its size limit");
  const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Recent project storage is invalid");
  const stored = parsed as { version?: unknown; projects?: unknown };
  if (stored.version !== VERSION || !Array.isArray(stored.projects)) throw new Error("Recent project storage version is unsupported");
  return normalizeProjects(stored.projects);
}

export async function writeRecentProjectFiles(filePath: string, projects: string[]): Promise<void> {
  const target = path.resolve(filePath), snapshot = normalizeProjects(projects);
  const previous = writeQueues.get(target) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(async () => {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await writeJsonAtomically(target, { version: VERSION, projects: snapshot });
  });
  writeQueues.set(target, pending);
  try { await pending; } finally { if (writeQueues.get(target) === pending) writeQueues.delete(target); }
}

export function rememberRecentProject(projects: string[], projectPath: string): string[] {
  const normalizedPath = path.normalize(projectPath);
  return [normalizedPath, ...projects.filter((item) => recentPathKey(item) !== recentPathKey(normalizedPath))].slice(0, MAX_PROJECTS);
}

export function recentProjectId(projectPath: string): string {
  return createHash("sha256").update(recentPathKey(projectPath)).digest("hex");
}

/** Resolve against the current known list; never trust a path supplied by the renderer. */
export function recentProjectPathById(projects: readonly string[], id: unknown): string {
  const entry = typeof id === "string" ? projects.find(projectPath => recentProjectId(projectPath) === id) : undefined;
  if (!entry) throw new Error("Recent project is no longer in the list");
  return entry;
}

export function removeRecentProjectById(projects: readonly string[], id: unknown): string[] {
  return projects.filter(projectPath => recentProjectId(projectPath) !== id);
}

/** Read-only metadata: unavailable entries remain visible, and error text never echoes file contents. */
export async function listRecentProjects(projects: readonly string[]): Promise<RecentProjectEntry[]> {
  return Promise.all(normalizeProjects([...projects]).map(async (projectPath): Promise<RecentProjectEntry> => {
    const isWorkspace = path.basename(projectPath) === PROJECT_WORKSPACE_FILE;
    const looksLikeFile = /\.(?:bordeaux|json|path|routine)$/i.test(projectPath);
    const entry: RecentProjectEntry = {
      id: recentProjectId(projectPath), name: isWorkspace ? path.basename(path.dirname(projectPath)) : path.basename(projectPath),
      folderHint: path.dirname(projectPath),
      location: { folderPath: looksLikeFile ? path.dirname(projectPath) : projectPath, projectPath: looksLikeFile ? projectPath : null }, status: "available",
    };
    const unavailable = (status: "missing" | "invalid", code: RecentProjectCode, detail: string): RecentProjectEntry => ({ ...entry, status, code, detail });
    try {
      const stat = await fs.lstat(projectPath).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && /\.bordeaux(?:\.json)?$/i.test(projectPath)) return null;
        throw error;
      });
      if (!stat) {
        // A migrated legacy file may have been removed after its workspace was
        // committed. Keep the same recovery behavior as the legacy opener.
        const selection = await loadProjectSelection(projectPath, { recordOpened: false });
        return { ...entry, name: selection.project.name, location: { folderPath: selection.folderPath, projectPath: selection.projectPath, ...(selection.legacyFile ? { legacyFile: selection.legacyFile } : {}) } };
      }
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) return unavailable("invalid", "unsafe-entry", "Choose a regular project file or folder");
      if (stat.isDirectory()) entry.location = { folderPath: projectPath, projectPath: null };
      const limit = isWorkspace ? MAX_WORKSPACE_FILE_BYTES : MAX_PROJECT_FILE_BYTES;
      if (stat.isFile() && stat.size > limit) return unavailable("invalid", "size-limit", "Project exceeds the file size limit");
      if (stat.isFile() && !looksLikeFile) return unavailable("invalid", "invalid-project", "Choose a Bordeaux project file");
      const selection = await loadProjectSelection(projectPath, { recordOpened: false });
      return { ...entry, name: selection.project.name, location: { folderPath: selection.folderPath, projectPath: selection.projectPath, ...(selection.legacyFile ? { legacyFile: selection.legacyFile } : {}) } };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return unavailable("missing", "not-found", "Project is no longer available");
      if (code === "EACCES" || code === "EPERM") return unavailable("invalid", "not-readable", "Project cannot be read");
      return unavailable("invalid", "invalid-project", "Project could not be opened");
    }
  }));
}
