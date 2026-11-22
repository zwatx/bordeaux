import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoProject } from "../src/core/project/defaults";
import type { BordeauxProject } from "../src/core/types";
import { autosaveProjectFolder, openProjectFolder, projectWorkspacePath, writeProject } from "../src/electron/projectFiles";
import { loadProjectFolderSelection, loadProjectSelection, type ProjectSelection } from "../src/electron/projectOpening";

const directories: string[] = [];
async function folder() { const result = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-recovery-")); directories.push(result); return result; }
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

function projectWithPath(name: string): BordeauxProject {
  const project = createDemoProject();
  project.paths[0].name = name;
  return project;
}

function edited(selection: ProjectSelection, name: string): BordeauxProject {
  const project = structuredClone(selection.project);
  project.paths[0].name = name;
  return project;
}

// Mirrors the desktop autosave, which carries the opened legacy file until the workspace continues it.
function autosave(selection: ProjectSelection, project: BordeauxProject) {
  return autosaveProjectFolder(selection.folderPath, project, selection.projectPath, { legacyFile: selection.legacyFile });
}

// Mirrors ordinary Save, which saves a selection without a save target into its folder workspace.
function save(selection: ProjectSelection, project: BordeauxProject) {
  const target = selection.projectPath ?? projectWorkspacePath(selection.folderPath);
  return autosaveProjectFolder(path.dirname(target), project, target, { createProject: target !== selection.projectPath, legacyFile: selection.legacyFile });
}

// Mirrors the workspace target main commits after a successful save.
function committed(selection: ProjectSelection): ProjectSelection {
  return { ...selection, projectPath: projectWorkspacePath(selection.folderPath), recentPath: selection.folderPath, legacyFile: null };
}

async function editAndAutosave(filePath: string, name: string) {
  const selection = await loadProjectSelection(filePath);
  await autosave(selection, edited(selection, name));
}

async function folderContents(directory: string) {
  const contents: Record<string, string> = {};
  for (const subfolder of ["", "Paths", "Routines"]) {
    for (const entry of await fs.readdir(path.join(directory, subfolder), { withFileTypes: true })) {
      if (entry.isFile()) contents[path.join(subfolder, entry.name)] = await fs.readFile(path.join(directory, subfolder, entry.name), "utf8");
    }
  }
  return contents;
}

async function expectWorkspaceProtected(selection: ProjectSelection) {
  const before = await folderContents(selection.folderPath);
  const conflicting = edited(selection, "Conflicting edit");
  await expect(autosave(selection, conflicting)).rejects.toThrow("Open the folder to recover its current work, or use Save As");
  await expect(save(selection, conflicting)).rejects.toThrow("Open the folder to recover its current work, or use Save As");
  expect(await folderContents(selection.folderPath)).toEqual(before);
}

function sha256(contents: Buffer) { return createHash("sha256").update(contents).digest("hex"); }

describe("reopening a legacy project after autosave", () => {
  it("retains the source record when queued saves outlive removal of the legacy file", async () => {
    const directory = await folder(), legacy = path.join(directory, "Legacy.bordeaux");
    await writeProject(legacy, projectWithPath("Original path"));
    const selection = await loadProjectSelection(legacy);

    await Promise.all([
      autosave(selection, edited(selection, "First edit")),
      autosave(selection, edited(selection, "Second edit")),
      autosave(selection, edited(selection, "Third edit")),
    ]);

    await expect(fs.stat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await loadProjectSelection(legacy)).project.paths[0].name).toBe("Third edit");
  });

  it("opens the autosaved workspace instead of the older .bordeaux.json contents", async () => {
    const directory = await folder(), legacy = path.join(directory, "Legacy.bordeaux.json");
    await fs.writeFile(legacy, JSON.stringify(projectWithPath("Original path")));
    await editAndAutosave(legacy, "Edited path");

    const reopened = await loadProjectSelection(legacy);
    expect(reopened.project.paths[0].name).toBe("Edited path");
    expect(reopened.recentPath).toBe(directory);
    expect(reopened.legacyFile).toBeNull();
    await autosave(reopened, reopened.project);
    expect((await openProjectFolder(directory)).project?.paths[0].name).toBe("Edited path");
    expect(JSON.parse(await fs.readFile(legacy, "utf8")).paths[0].name).toBe("Original path");
  });

  it("keeps saving a first migration before and after its workspace target is committed", async () => {
    const directory = await folder(), legacy = path.join(directory, "Legacy.bordeaux.json");
    await fs.writeFile(legacy, JSON.stringify(projectWithPath("Original path")));
    const selection = await loadProjectSelection(legacy);

    await save(selection, edited(selection, "First save"));
    await autosave(selection, edited(selection, "Queued autosave"));
    expect((await openProjectFolder(directory)).project?.paths[0].name).toBe("Queued autosave");
    await save(committed(selection), edited(selection, "Committed save"));
    await autosave(committed(selection), edited(selection, "Committed autosave"));
    expect((await openProjectFolder(directory)).project?.paths[0].name).toBe("Committed autosave");
    expect(JSON.parse(await fs.readFile(legacy, "utf8")).paths[0].name).toBe("Original path");
  });

  it("reopens a migrated .bordeaux file from its workspace after the file was removed", async () => {
    const directory = await folder(), legacy = path.join(directory, "Legacy.bordeaux");
    await writeProject(legacy, projectWithPath("Original path"));
    await editAndAutosave(legacy, "Edited path");
    await expect(fs.stat(legacy)).rejects.toMatchObject({ code: "ENOENT" });

    const reopened = await loadProjectSelection(legacy);
    expect(reopened.project.paths[0].name).toBe("Edited path");
    expect(reopened.folderPath).toBe(directory);
  });

  it("records the single legacy file of an opened folder as the workspace source", async () => {
    const directory = await folder(), legacy = path.join(directory, "Legacy.bordeaux.json");
    await fs.writeFile(legacy, JSON.stringify(projectWithPath("Original path")));
    const selection = await loadProjectFolderSelection(directory);
    expect(selection.legacyFile).toBe(legacy);
    await autosave(selection, projectWithPath("Edited path"));
    expect((await loadProjectSelection(legacy)).project.paths[0].name).toBe("Edited path");
  });

  it("opens a legacy file changed outside Bordeaux as chosen without replacing its workspace", async () => {
    const directory = await folder(), legacy = path.join(directory, "Legacy.bordeaux.json");
    await fs.writeFile(legacy, JSON.stringify(projectWithPath("Original path")));
    await editAndAutosave(legacy, "Edited path");
    await fs.writeFile(legacy, JSON.stringify(projectWithPath("External path")));

    const reopened = await loadProjectSelection(legacy);
    expect(reopened.project.paths[0].name).toBe("External path");
    expect(reopened.recentPath).toBe(legacy);
    await expectWorkspaceProtected(reopened);
    expect((await openProjectFolder(directory)).project?.paths[0].name).toBe("Edited path");
  });

  it("opens an unrelated sibling legacy project without replacing the shared folder workspace", async () => {
    const directory = await folder();
    const first = path.join(directory, "First.bordeaux.json"), second = path.join(directory, "Second.bordeaux.json");
    await fs.writeFile(first, JSON.stringify(projectWithPath("First path")));
    await fs.writeFile(second, JSON.stringify(projectWithPath("Second path")));
    await editAndAutosave(first, "First edited");

    const sibling = await loadProjectSelection(second);
    expect(sibling.project.paths[0].name).toBe("Second path");
    expect(sibling.recentPath).toBe(second);
    expect(sibling.legacyFile).toBe(second);

    await expectWorkspaceProtected(sibling);
    expect((await loadProjectSelection(first)).project.paths[0].name).toBe("First edited");
  });

  it("keeps opening a legacy file whose folder workspace has no recorded source without replacing that workspace", async () => {
    const directory = await folder(), legacy = path.join(directory, "Legacy.bordeaux.json");
    await fs.writeFile(legacy, JSON.stringify(projectWithPath("Legacy path")));
    await autosaveProjectFolder(directory, projectWithPath("Workspace path"), null);

    const selection = await loadProjectSelection(legacy);
    expect(selection.project.paths[0].name).toBe("Legacy path");
    await expectWorkspaceProtected(selection);
    expect((await openProjectFolder(directory)).project?.paths[0].name).toBe("Workspace path");
  });

  it("saves a conflicting legacy file into a separate folder with Save As", async () => {
    const directory = await folder(), destination = await folder(), legacy = path.join(directory, "Legacy.bordeaux.json");
    await fs.writeFile(legacy, JSON.stringify(projectWithPath("Legacy path")));
    await autosaveProjectFolder(directory, projectWithPath("Workspace path"), null);
    const before = await folderContents(directory);

    const selection = await loadProjectSelection(legacy);
    await autosaveProjectFolder(destination, edited(selection, "Imported path"), projectWorkspacePath(destination), { createProject: true, legacyFile: selection.legacyFile });
    expect((await openProjectFolder(destination)).project?.paths[0].name).toBe("Imported path");
    expect(await folderContents(directory)).toEqual(before);
  });

  it("recovers a prior-version .bordeaux migration recorded only by its mirror", async () => {
    const directory = await folder(), legacy = path.join(directory, "Legacy.bordeaux");
    await writeProject(legacy, projectWithPath("Original path"));
    await autosaveProjectFolder(directory, projectWithPath("Workspace path"), null);
    const workspace = projectWorkspacePath(directory);
    const state = JSON.parse(await fs.readFile(workspace, "utf8"));
    await fs.writeFile(workspace, JSON.stringify({ ...state, legacyProjectMirror: { file: legacy, hash: sha256(await fs.readFile(legacy)) } }));

    const reopened = await loadProjectSelection(legacy);
    expect(reopened.project.paths[0].name).toBe("Workspace path");
    expect(reopened.legacyFile).toBeNull();
    await autosave(reopened, edited(reopened, "Recovered edit"));
    expect((await openProjectFolder(directory)).project?.paths[0].name).toBe("Recovered edit");
    await expect(fs.stat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("opens a changed prior-version .bordeaux mirror as chosen without replacing its workspace", async () => {
    const directory = await folder(), legacy = path.join(directory, "Legacy.bordeaux");
    await writeProject(legacy, projectWithPath("Original path"));
    await autosaveProjectFolder(directory, projectWithPath("Workspace path"), null);
    const workspace = projectWorkspacePath(directory);
    const state = JSON.parse(await fs.readFile(workspace, "utf8"));
    await fs.writeFile(workspace, JSON.stringify({ ...state, legacyProjectMirror: { file: legacy, hash: sha256(await fs.readFile(legacy)) } }));
    await writeProject(legacy, projectWithPath("External path"));

    const selection = await loadProjectSelection(legacy);
    expect(selection.project.paths[0].name).toBe("External path");
    expect(selection.projectPath).toBe(legacy);
    await expectWorkspaceProtected(selection);
    expect((await openProjectFolder(directory)).project?.paths[0].name).toBe("Workspace path");
  });
});
