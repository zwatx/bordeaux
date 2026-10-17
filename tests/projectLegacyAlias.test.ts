import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { createDemoProject } from "../src/shared/project/defaults";
import { loadProjectSelection } from "../src/electron/projectOpening";
import { projectFolderIdentity } from "../src/electron/projectFolderIdentity";
import { autosaveProjectFolder, projectWorkspacePath, writeProject } from "../src/electron/projectFiles";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(folder => fs.rm(folder, { recursive: true, force: true }))); });
async function root() { const folder = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-legacy-alias-")); directories.push(folder); return folder; }
async function seed(folder: string, legacy: string) {
  const old = createDemoProject(); old.paths[0].name = "Old journal";
  const newer = structuredClone(old); newer.paths[0].name = "Newer authored legacy";
  const workspace = projectWorkspacePath(folder);
  await fs.writeFile(workspace, JSON.stringify({ format: "bordeaux-folder/1", projectPath: legacy, project: old, files: {} }));
  await writeProject(legacy, newer); const future = new Date(Date.now() + 5_000); await fs.utimes(legacy, future, future);
  return { workspace, workspaceBytes: await fs.readFile(workspace), legacyBytes: await fs.readFile(legacy) };
}
async function checkNewer(folderSpelling: string, legacySpelling: string) {
  const seeded = await seed(folderSpelling, legacySpelling);
  const direct = await loadProjectSelection(folderSpelling, { recordOpened: false, requireSource: true });
  const physical = await projectFolderIdentity(folderSpelling);
  const admitted = await loadProjectSelection(physical.folderPath, { recordOpened: false, requireSource: true });
  expect(direct.project.paths[0].name).toBe("Newer authored legacy");
  expect(admitted.project.paths[0].name).toBe("Newer authored legacy");
  expect(await fs.readFile(seeded.workspace)).toEqual(seeded.workspaceBytes);
  expect(await fs.readFile(legacySpelling)).toEqual(seeded.legacyBytes);
}

it("loads newer legacy contents from an older journal whose source uses an ancestor alias", async () => {
  const directory = await fs.realpath(await root()), parent = path.join(directory, "real"), alias = path.join(directory, "alias");
  await fs.mkdir(parent); await fs.symlink(parent, alias, process.platform === "win32" ? "junction" : "dir");
  const physical = path.join(parent, "Autos"), spelling = path.join(alias, "Autos"); await fs.mkdir(physical);
  await checkNewer(spelling, path.join(spelling, "Autos.bordeaux"));
});

it.skipIf(process.platform !== "darwin")("preserves newer legacy contents across macOS temporary-directory spellings", async () => {
  const directory = await root(); expect(await fs.realpath(directory)).not.toBe(directory);
  const spelling = path.join(directory, "Autos"); await fs.mkdir(spelling);
  await checkNewer(spelling, path.join(spelling, "Autos.bordeaux"));
});

it("does not follow a newer journal source from a different physical folder", async () => {
  const directory = await fs.realpath(await root()), folder = path.join(directory, "Owned"), other = path.join(directory, "Other");
  await fs.mkdir(folder); await fs.mkdir(other);
  const legacy = path.join(other, "Autos.bordeaux"), seeded = await seed(folder, legacy);
  expect((await loadProjectSelection(folder, { recordOpened: false, requireSource: true })).project.paths[0].name).toBe("Old journal");
  expect(await fs.readFile(seeded.workspace)).toEqual(seeded.workspaceBytes); expect(await fs.readFile(legacy)).toEqual(seeded.legacyBytes);
});

it.each(["projectPath", "mirror", "imported"])("saves edits after moving a workspace with obsolete %s metadata", async kind => {
  const directory = await fs.realpath(await root()), before = path.join(directory, "OldLocation"), after = path.join(directory, "MovedLocation");
  await fs.mkdir(before); const project = createDemoProject(), oldFile = path.join(before, "Autos.bordeaux");
  await writeProject(oldFile, project); const bytes = await fs.readFile(oldFile), hash = createHash("sha256").update(bytes).digest("hex");
  await fs.writeFile(projectWorkspacePath(before), JSON.stringify({ format: "bordeaux-folder/1", projectPath: oldFile, project, files: {},
    ...(kind === "mirror" ? { legacyProjectMirror: { file: oldFile, hash } } : {}), ...(kind === "imported" ? { importedFrom: { file: oldFile, hash } } : {}) }));
  await fs.rename(before, after);
  const opened = await loadProjectSelection(after, { recordOpened: false, requireSource: true });
  expect(opened.projectPath).toBe(projectWorkspacePath(after)); opened.project.paths[0].name = "Edit after moving";
  await autosaveProjectFolder(after, opened.project, opened.projectPath);
  expect((await loadProjectSelection(after)).project.paths[0].name).toBe("Edit after moving");
  const movedFile = path.join(after, "Autos.bordeaux"); expect(await fs.readFile(movedFile)).toEqual(bytes);
  // Missing old-parent hints neither prevent explicit legacy loading nor authorize replacing the workspace.
  const selected = await loadProjectSelection(movedFile);
  await expect(autosaveProjectFolder(after, selected.project, selected.projectPath, { legacyFile: selected.legacyFile })).rejects.toThrow("may hold newer work");
  expect((await loadProjectSelection(after)).project.paths[0].name).toBe("Edit after moving");
});

it("never grants source authority or removes a mirror in an outside historical directory", async () => {
  const directory = await fs.realpath(await root()), folder = path.join(directory, "Owned"), other = path.join(directory, "Other");
  await fs.mkdir(folder); await fs.mkdir(other); const project = createDemoProject(), outside = path.join(other, "Autos.bordeaux"), current = path.join(folder, "Autos.bordeaux");
  await writeProject(outside, project); await writeProject(current, project);
  const bytes = await fs.readFile(outside), hash = createHash("sha256").update(bytes).digest("hex");
  await fs.writeFile(projectWorkspacePath(folder), JSON.stringify({ format: "bordeaux-folder/1", projectPath: outside, project, files: {},
    importedFrom: { file: outside, hash }, legacyProjectMirror: { file: outside, hash } }));
  const opened = await loadProjectSelection(folder); opened.project.paths[0].name = "Current workspace edit";
  await autosaveProjectFolder(folder, opened.project, opened.projectPath);
  expect(await fs.readFile(outside)).toEqual(bytes); expect(await fs.readFile(current)).toEqual(bytes);
  const selected = await loadProjectSelection(current);
  await expect(autosaveProjectFolder(folder, selected.project, selected.projectPath, { legacyFile: selected.legacyFile })).rejects.toThrow("may hold newer work");
  expect((await loadProjectSelection(folder)).project.paths[0].name).toBe("Current workspace edit");
});
