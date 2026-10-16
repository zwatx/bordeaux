import fs from "node:fs/promises";
import path from "node:path";

export interface ProjectFolderIdentity { folderPath: string; pathKey: string; objectKey?: string }
const pathKey = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
async function nearestExistingPath(folder: string, assertCurrent?: () => void): Promise<string> {
  try {
    const actual = await fs.realpath(folder); assertCurrent?.();
    if (!(await fs.lstat(actual)).isDirectory()) throw new Error("Project origin must identify a directory");
    assertCurrent?.(); return actual;
  } catch (error) {
    assertCurrent?.();
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(folder) === folder) throw error;
    return path.join(await nearestExistingPath(path.dirname(folder), assertCurrent), path.basename(folder));
  }
}
/** Async admission only. Preserve final-symlink refusal, resolve ancestor aliases, and retain a missing origin's nearest real ancestor. */
export async function projectFolderIdentity(folder: string, options: { allowMissing?: boolean; assertCurrent?: () => void } = {}): Promise<ProjectFolderIdentity> {
  const absolute = path.resolve(folder);
  let stat;
  try { stat = await fs.lstat(absolute); }
  catch (error) {
    options.assertCurrent?.();
    if (!options.allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    const folderPath = path.join(await nearestExistingPath(parent, options.assertCurrent), path.basename(absolute));
    return { folderPath, pathKey: pathKey(folderPath) };
  }
  options.assertCurrent?.();
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Project folder must be a regular directory");
  const folderPath = await fs.realpath(absolute);
  options.assertCurrent?.();
  const actual = await fs.lstat(folderPath);
  options.assertCurrent?.();
  if (!actual.isDirectory() || actual.isSymbolicLink() || stat.dev !== actual.dev || stat.ino !== actual.ino) throw new Error("Project folder changed while resolving its location");
  return { folderPath, pathKey: pathKey(folderPath), objectKey: `${actual.dev}:${actual.ino}` };
}
export const sameProjectFolder = (a: ProjectFolderIdentity, b: ProjectFolderIdentity): boolean => a.pathKey === b.pathKey || Boolean(a.objectKey && a.objectKey === b.objectKey);
export async function projectFileIdentity(file: string, assertCurrent?: () => void): Promise<string> {
  const parent = await projectFolderIdentity(path.dirname(path.resolve(file)), { assertCurrent });
  return path.join(parent.folderPath, path.basename(file));
}
