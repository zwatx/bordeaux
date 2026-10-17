import fs from "node:fs/promises";
import path from "node:path";

/** The suggested parent for new projects. Nothing is created until a user explicitly creates a project there. */
export function projectsHomePath(documentsDirectory: string): string {
  return path.join(documentsDirectory, "Bordeaux");
}

/**
 * Creates the default projects home, and only that exact folder, when a create request targets it.
 * Other parents must already exist; this never creates parents recursively from a request.
 */
export async function ensureProjectsHomeForRequest(request: unknown, home: string): Promise<void> {
  const parent = request && typeof request === "object" ? (request as { parentDirectory?: unknown }).parentDirectory : undefined;
  if (typeof parent !== "string" || !path.isAbsolute(parent) || parent.includes("\0") || path.resolve(parent) !== path.resolve(home)) return;
  try {
    await fs.mkdir(home);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}
