import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoProject } from "../src/core/project/defaults";
import { autosaveProjectFolder, readProject, projectWorkspacePath } from "../src/electron/projectFiles";
import { loadProjectSelection } from "../src/electron/projectOpening";

const directories: string[] = [];
async function folder() { const result = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-opening-")); directories.push(result); return result; }
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

describe("project selection before activation", () => {
  it.each(["path", "routine"])("rejects a malformed managed .%s without switching destination or changing another project", async (extension) => {
    const a = await folder(), b = await folder();
    const projectA = createDemoProject(), projectB = createDemoProject();
    projectA.name = "Project A"; projectB.name = "Project B";
    const targetA = projectWorkspacePath(a), targetB = projectWorkspacePath(b);
    await autosaveProjectFolder(a, projectA, targetA);
    await autosaveProjectFolder(b, projectB, targetB);
    const directory = path.join(b, extension === "path" ? "Paths" : "Routines");
    const selected = path.join(directory, (await fs.readdir(directory))[0]);
    await fs.writeFile(selected, "invalid JSON");
    const beforeProject = await fs.readFile(targetB, "utf8"), beforeRecovery = await fs.readFile(path.join(b, ".bordeaux-workspace.json"), "utf8");
    const active = { project: projectA, target: targetA, folder: a, dirty: true, robotLink: "robot-A", recent: [a] };
    const open = async () => {
      const selection = await loadProjectSelection(selected);
      Object.assign(active, { project: selection.project, target: selection.projectPath, folder: selection.folderPath, dirty: false, robotLink: null, recent: [selection.recentPath] });
    };
    await expect(open()).rejects.toThrow();
    expect(active).toEqual({ project: projectA, target: targetA, folder: a, dirty: true, robotLink: "robot-A", recent: [a] });
    projectA.paths[0].name = "Still editing A";
    await autosaveProjectFolder(active.folder, active.project, active.target);
    expect((await readProject(targetA)).project.paths[0].name).toBe("Still editing A");
    expect(await fs.readFile(targetB, "utf8")).toBe(beforeProject);
    expect(await fs.readFile(path.join(b, ".bordeaux-workspace.json"), "utf8")).toBe(beforeRecovery);
    expect(await fs.readFile(selected, "utf8")).toBe("invalid JSON");
  });

  it.each(["path", "routine"])("loads a valid managed .%s and selects its item before activation", async (extension) => {
    const directory = await folder(), project = createDemoProject();
    await autosaveProjectFolder(directory, project, path.join(directory, "Project.bordeaux"));
    const mirrorDirectory = path.join(directory, extension === "path" ? "Paths" : "Routines");
    const result = await loadProjectSelection(path.join(mirrorDirectory, (await fs.readdir(mirrorDirectory))[0]));
    expect(result.folderPath).toBe(directory);
    expect(extension === "path" ? result.project.editor?.activePathId : result.project.activeRoutineId).toBe(extension === "path" ? project.paths[0].id : project.routines[0].id);
  });
});
