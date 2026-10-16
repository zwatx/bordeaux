import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { RobotProjectBookmarkSummary } from "../shared/types";
import { writeJsonAtomically } from "./projectFiles";
import type { RobotProjectRuntime } from "./robotProjectRuntime";

const BOOKMARK_VERSION = 1;
const MAX_BOOKMARKS = 8;
const MAX_BOOKMARK_FILE_BYTES = 64 * 1024;
const MAX_TEXT_LENGTH = 256;
const MAX_PATH_LENGTH = 4_096;

export interface RobotProjectBookmark extends RobotProjectBookmarkSummary {
  projectPath: string;
  runtime: RobotProjectRuntime;
}

interface StoredRobotProjectBookmarks {
  version: typeof BOOKMARK_VERSION;
  projects: RobotProjectBookmark[];
}

function bookmarkId(projectPath: string): string {
  return createHash("sha256").update(projectPath).digest("hex").slice(0, 20);
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT_LENGTH;
}

function normalizeBookmark(value: unknown): RobotProjectBookmark | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (!validText(candidate.projectName) || !validText(candidate.folderName) || !validText(candidate.lastLinkedAt)) return null;
  if (typeof candidate.projectPath !== "string" || candidate.projectPath.length > MAX_PATH_LENGTH || !path.isAbsolute(candidate.projectPath)) return null;
  if (candidate.runtime !== "labview") return null;
  const projectPath = path.normalize(candidate.projectPath);
  const parsedDate = Date.parse(candidate.lastLinkedAt);
  if (!Number.isFinite(parsedDate)) return null;
  return {
    id: bookmarkId(projectPath),
    projectName: candidate.projectName,
    folderName: candidate.folderName,
    lastLinkedAt: new Date(parsedDate).toISOString(),
    projectPath,
    runtime: "labview",
  };
}

function normalizeBookmarks(values: unknown[]): RobotProjectBookmark[] {
  const bookmarks: RobotProjectBookmark[] = [];
  const ids = new Set<string>();
  for (const value of values) {
    const bookmark = normalizeBookmark(value);
    if (!bookmark || ids.has(bookmark.id)) continue;
    bookmarks.push(bookmark);
    ids.add(bookmark.id);
    if (bookmarks.length === MAX_BOOKMARKS) break;
  }
  return bookmarks;
}

export async function readRobotProjectBookmarks(filePath: string): Promise<RobotProjectBookmark[]> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (!stat.isFile()) throw new Error("Robot project bookmark storage is not a file");
  if (stat.size > MAX_BOOKMARK_FILE_BYTES) throw new Error("Robot project bookmark storage exceeds its size limit");
  const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Robot project bookmark storage is invalid");
  const stored = parsed as Partial<StoredRobotProjectBookmarks>;
  if (stored.version !== BOOKMARK_VERSION || !Array.isArray(stored.projects)) throw new Error("Robot project bookmark storage version is unsupported");
  return normalizeBookmarks(stored.projects);
}

export async function writeRobotProjectBookmarks(filePath: string, bookmarks: RobotProjectBookmark[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const projects = normalizeBookmarks(bookmarks);
  await writeJsonAtomically(filePath, { version: BOOKMARK_VERSION, projects } satisfies StoredRobotProjectBookmarks);
}

export function rememberRobotProject(
  bookmarks: RobotProjectBookmark[],
  projectPath: string,
  projectName: string,
  linkedAt = new Date(),
  runtime: RobotProjectRuntime = "labview",
): RobotProjectBookmark[] {
  const normalizedPath = path.normalize(projectPath);
  const bookmark: RobotProjectBookmark = {
    id: bookmarkId(normalizedPath),
    projectName: projectName.slice(0, MAX_TEXT_LENGTH),
    folderName: path.basename(normalizedPath).slice(0, MAX_TEXT_LENGTH),
    lastLinkedAt: linkedAt.toISOString(),
    projectPath: normalizedPath,
    runtime,
  };
  return [bookmark, ...bookmarks.filter((item) => item.id !== bookmark.id)].slice(0, MAX_BOOKMARKS);
}

export function summarizeRobotProjectBookmarks(bookmarks: RobotProjectBookmark[]): RobotProjectBookmarkSummary[] {
  return bookmarks.map(({ id, projectName, folderName, lastLinkedAt, projectPath }) => ({ id, projectName, folderName, lastLinkedAt, locationHint: path.dirname(projectPath) }));
}
