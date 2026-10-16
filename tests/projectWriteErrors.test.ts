import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoProject } from "../src/shared/project/defaults";
import { autosaveProjectFolder } from "../src/electron/projectFiles";
import { describeProjectWriteError, projectWriteFact, projectWriteFactFromMessage, withProjectWriteFact } from "../src/shared/project/writeErrors";

const directories: string[] = [];
const temporary = async () => { const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-write-errors-")); directories.push(directory); return directory; };
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await fs.chmod(directory, 0o700).catch(() => undefined);
    for (const child of await fs.readdir(directory).catch(() => [])) await fs.chmod(path.join(directory, child), 0o700).catch(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});
const failure = async (run: () => Promise<unknown>) => { try { await run(); } catch (error) { return error; } throw new Error("Expected the write to fail"); };

describe("project write errors", () => {
  it("maps errno codes to one plain fact", () => {
    expect(["EACCES", "EPERM", "EROFS"].map(projectWriteFact)).toEqual(Array(3).fill("Folder is read-only"));
    expect(projectWriteFact("ENOSPC")).toBe("Disk is full");
    expect(projectWriteFact("ENOENT")).toBe("Project folder was moved or deleted");
    expect(projectWriteFact("ENOTDIR")).toBe("Project folder was moved or deleted");
    expect(projectWriteFact("EBUSY")).toBe("Folder is busy");
    expect(projectWriteFact("EMFILE")).toBe("Folder is busy");
    expect(projectWriteFact("EIO")).toBe("Couldn't write the project");
    expect(projectWriteFact(undefined)).toBeNull();
    expect(projectWriteFactFromMessage("EACCES: permission denied, open '/x'")).toBe("Folder is read-only");
    expect(projectWriteFactFromMessage("That folder already contains a Bordeaux project.")).toBeNull();
  });

  it("leaves messages without a system code unchanged", () => {
    const plain = new Error("The project changed during saving. Its files were saved; open that folder to continue.");
    expect(describeProjectWriteError(plain)).toBe(plain.message);
    expect(withProjectWriteFact(plain)).toBe(plain);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("leads a real read-only folder failure with the fact and keeps the raw detail", async () => {
    const folder = await temporary();
    await fs.chmod(folder, 0o500);
    const error = await failure(() => autosaveProjectFolder(folder, createDemoProject(), null));
    expect((error as NodeJS.ErrnoException).code).toMatch(/^E(ACCES|PERM)$/);
    const message = describeProjectWriteError(error);
    expect(message.startsWith("Folder is read-only. ")).toBe(true);
    expect(message).toContain((error as Error).message);
    expect((withProjectWriteFact(error) as Error).message).toBe(message);
  });

  it("maps a real missing folder and a file in place of a folder", async () => {
    const root = await temporary();
    const missing = await failure(() => fs.writeFile(path.join(root, "gone", "Opening.path"), "{}"));
    expect(describeProjectWriteError(missing)).toMatch(/^Project folder was moved or deleted\. ENOENT: /);
    await fs.writeFile(path.join(root, "file"), "");
    const notFolder = await failure(() => fs.writeFile(path.join(root, "file", "Opening.path"), "{}"));
    expect(describeProjectWriteError(notFolder)).toMatch(/^Project folder was moved or deleted\. ENOTDIR: /);
  });
});
