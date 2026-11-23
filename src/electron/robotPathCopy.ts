import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { projectWorkspacePath, writeBufferAtomically } from "./projectFiles";
import type { RobotPathCopyResult } from "../core/robotFileDelivery";

export async function robotExportTargetSnapshot(target: string): Promise<string> {
  try {
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Existing Robot export target must be a regular file");
    if (stat.size > 64 * 1024 * 1024) throw new Error("Existing Robot export target exceeds the 64 MiB safety limit");
    const hash = createHash("sha256").update(await fs.readFile(target)).digest("hex");
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${hash}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function assertRobotCopyFolder(folder: string, currentProjectFolder: string | null): Promise<void> {
  const rejectGenerated = () => { throw new Error("Paths/ is rebuilt from your project on every Save. Choose another folder."); };
  // Check both the chosen spelling and its physical location, including aliases into Paths.
  const physical = await fs.realpath(folder);
  for (const start of new Set([folder, physical])) {
    let directory = start;
    while (directory !== path.dirname(directory)) {
      const parent = path.dirname(directory);
      if (path.basename(directory).toLowerCase() === "paths") {
        if (parent === currentProjectFolder || await fs.lstat(projectWorkspacePath(parent)).then(() => true, (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        })) rejectGenerated();
      }
      directory = parent;
    }
  }
  if (currentProjectFolder) {
    const generated = await fs.realpath(path.join(currentProjectFolder, "Paths")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (generated && (physical === generated || physical.startsWith(generated + path.sep))) rejectGenerated();
  }
}

/** Preserve the snapshot even if a concurrent comparison or the robot file changes. */
export async function saveReviewedRobotCopy(chosenPath: string, copy: { bytes: Buffer; sha256: string },
  projectFolder: string | null, assertCurrent: () => void, confirmReplace: (name: string) => Promise<boolean>): Promise<RobotPathCopyResult> {
  assertCurrent();
  const chosen = /\.bdx$/i.test(chosenPath) ? chosenPath : chosenPath + ".bdx";
  const folder = path.dirname(chosen);
  await assertRobotCopyFolder(folder, projectFolder);
  const target = path.join(await fs.realpath(folder), path.basename(chosen));
  const before = await robotExportTargetSnapshot(target);
  if (before !== "missing" && !await confirmReplace(path.basename(target))) return { canceled: true };
  await assertRobotCopyFolder(path.dirname(target), projectFolder);
  if (await robotExportTargetSnapshot(target) !== before) throw new Error("The destination changed. Choose a file again.");
  await writeBufferAtomically(target, copy.bytes, { assertCurrent, exclusive: before === "missing" });
  if (!(await robotExportTargetSnapshot(target)).endsWith(":" + copy.sha256)) throw new Error("The saved file did not match the robot copy");
  return { name: path.basename(target), folder: path.basename(folder) || folder, size: copy.bytes.length };
}
