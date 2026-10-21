import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blankPath, createDemoProject } from "../src/shared/project/defaults";
import { autosaveProjectFolder, openProjectFolder, projectFileName, readProject, projectWorkspacePath, writeProject } from "../src/electron/projectFiles";
const directories: string[] = [];
async function folder() { const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-folder-")); directories.push(directory); return directory; }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });
describe("folder projects", () => {
  it("opens an empty folder and stores autosaves in its sole workspace", async () => {
    const directory = await folder();
    expect(await openProjectFolder(directory)).toEqual({ project: null, projectPath: null });
    const project = createDemoProject();
    await autosaveProjectFolder(directory, project, null);
    expect((await fs.readdir(directory)).some((name) => name.endsWith(".bordeaux"))).toBe(false);
    expect((await fs.readdir(path.join(directory, "Paths")))).toHaveLength(1);
    expect((await fs.readdir(path.join(directory, "Routines")))).toHaveLength(1);
    expect((await openProjectFolder(directory)).project).toEqual({ ...project, name: path.basename(directory) });
    const target = path.join(directory, projectFileName("Test"));
    await autosaveProjectFolder(directory, project, target);
    expect((await readProject(projectWorkspacePath(directory))).project).toEqual({ ...project, name: path.basename(directory) });
  });
  it("autosaves path and routine edits into named document files", async () => {
    const directory = await folder(); const project = createDemoProject();
    await autosaveProjectFolder(directory, project, null);
    project.paths[0].name = "Renamed path"; project.routines[0].name = "Renamed routine";
    await autosaveProjectFolder(directory, project, null);
    expect(await fs.readdir(path.join(directory, "Paths"))).toEqual(["Renamed path.path"]);
    expect(JSON.parse(await fs.readFile(path.join(directory, "Paths", "Renamed path.path"), "utf8")).name).toBe("Renamed path");
    expect((await openProjectFolder(directory)).project?.routines[0].name).toBe("Renamed routine");
  });
  it("preserves externally changed files and reports the conflict", async () => {
    const directory = await folder(); const project = createDemoProject();
    await autosaveProjectFolder(directory, project, null);
    const file = path.join(directory, "Paths", (await fs.readdir(path.join(directory, "Paths")))[0]);
    await fs.writeFile(file, "external changes");
    await expect(autosaveProjectFolder(directory, project, null)).rejects.toThrow("changed outside");
    expect(await fs.readFile(file, "utf8")).toBe("external changes");
  });
  it("rejects unrelated recovery files and linked document directories", async () => {
    const directory = await folder(); await fs.writeFile(path.join(directory, ".bordeaux-workspace.json"), '{}');
    await expect(openProjectFolder(directory)).rejects.toThrow("unrelated recovery");
    const other = await folder(); const outside = await folder();
    await fs.symlink(outside, path.join(other, "Paths"));
    await expect(autosaveProjectFolder(other, createDemoProject(), null)).rejects.toThrow("regular directory");
    expect(await fs.readdir(outside)).toEqual([]);
  });
  it("serializes overlapping saves and removes obsolete owned documents", async () => {
    const directory = await folder(); const first = createDemoProject();
    const second = structuredClone(first); second.paths[0].name = "Newest";
    await Promise.all([autosaveProjectFolder(directory, first, null), autosaveProjectFolder(directory, second, null)]);
    expect((await openProjectFolder(directory)).project?.paths[0].name).toBe("Newest");
    const mirror = path.join(directory, "Paths", (await fs.readdir(path.join(directory, "Paths")))[0]);
    expect((await readProject(mirror)).project.paths[0].name).toBe("Newest");
    second.paths = [blankPath("Replacement")];
    second.editor = { ...second.editor, activePathId: second.paths[0].id };
    await autosaveProjectFolder(directory, second, null);
    expect((await openProjectFolder(directory)).project?.paths.map((item) => item.name)).toEqual(["Replacement"]);
    await expect(fs.stat(mirror)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("never replaces a colliding legacy file and keeps folder saves canonical", async () => {
    const directory = await folder(); const project = createDemoProject();
    const first = path.join(directory, "First.bordeaux");
    await fs.writeFile(first, "unrelated");
    await expect(autosaveProjectFolder(directory, project, first, { createProject: true })).rejects.toMatchObject({ code: "EEXIST" });
    expect(await fs.readFile(first, "utf8")).toBe("unrelated");
    await fs.rm(first);
    await autosaveProjectFolder(directory, project, first, { createProject: true });
    const second = path.join(directory, "Second.bordeaux");
    await autosaveProjectFolder(directory, project, second, { createProject: true });
    expect((await openProjectFolder(directory)).projectPath).toBe(projectWorkspacePath(directory));
    await expect(fs.stat(first)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(second)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("recovers a partial mirror write and accepts the next different edit", async () => {
    const directory = await folder(); const project = createDemoProject();
    project.paths.push(blankPath("Second"));
    await autosaveProjectFolder(directory, project, null);
    project.paths[0].name = "First edit"; project.paths[1].constraints.maxVel = 0.5;
    const rename = fs.rename.bind(fs); let fail = true;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to).endsWith("Second.path") && fail) { fail = false; throw new Error("disk interrupted"); }
      return rename(from, to);
    });
    await expect(autosaveProjectFolder(directory, project, null)).rejects.toThrow("disk interrupted");
    expect((await openProjectFolder(directory)).project?.paths[0].name).toBe("First edit");
    project.paths[0].name = "Next edit";
    await autosaveProjectFolder(directory, project, null);
    expect((await openProjectFolder(directory)).project?.paths[0].name).toBe("Next edit");
  });
  it("uses one workspace file, the folder title, and readable mirrors on each autosave", async () => {
    const directory = await folder(), project = createDemoProject();
    project.name = "Untitled"; project.paths[0].name = "Opening path";
    await autosaveProjectFolder(directory, project, null);
    project.paths[0].constraints.maxVel = 0.5;
    await autosaveProjectFolder(directory, project, path.join(directory, "Untitled.bordeaux"));
    expect((await fs.readdir(directory)).filter((name) => name.endsWith(".json") || name.endsWith(".bordeaux"))).toEqual([".bordeaux-workspace.json"]);
    expect((await openProjectFolder(directory)).project?.name).toBe(path.basename(directory));
    expect(JSON.parse(await fs.readFile(path.join(directory, "Paths/Opening path.path"), "utf8")).constraints.maxVel).toBe(0.5);
  });
  it("replaces renamed managed files after writing their replacements", async () => {
    const directory = await folder(), project = createDemoProject();
    project.paths[0].name = "Before"; project.routines[0].name = "Before";
    await autosaveProjectFolder(directory, project, null);
    project.paths[0].name = "Rename"; project.routines[0].name = "Rename";
    await autosaveProjectFolder(directory, project, null);
    expect(await fs.readdir(path.join(directory, "Paths"))).toEqual(["Rename.path"]);
    expect(await fs.readdir(path.join(directory, "Routines"))).toEqual(["Rename.routine"]);
  });
  it("keeps old managed files when writing a renamed replacement fails", async () => {
    const directory = await folder(), project = createDemoProject();
    project.paths[0].name = "Before";
    await autosaveProjectFolder(directory, project, null);
    project.paths[0].name = "After";
    const link = fs.link.bind(fs);
    vi.spyOn(fs, "link").mockImplementation(async (from, to) => {
      if (String(to).endsWith("After.path")) throw new Error("disk interrupted");
      return link(from, to);
    });
    await expect(autosaveProjectFolder(directory, project, null)).rejects.toThrow("disk interrupted");
    expect(JSON.parse(await fs.readFile(path.join(directory, "Paths/Before.path"), "utf8")).name).toBe("Before");
    expect((await openProjectFolder(directory)).project?.paths[0].name).toBe("After");
  });
  it("disambiguates equal sanitized names without numbered hash filenames", async () => {
    const directory = await folder(), project = createDemoProject();
    project.paths = [blankPath("Same/name"), blankPath("Same:name")];
    project.editor = { ...project.editor, activePathId: project.paths[0].id };
    await autosaveProjectFolder(directory, project, null);
    expect((await fs.readdir(path.join(directory, "Paths"))).sort()).toEqual(["Same-name (2).path", "Same-name.path"]);
    await autosaveProjectFolder(directory, project, null);
    expect((await fs.readdir(path.join(directory, "Paths"))).sort()).toEqual(["Same-name (2).path", "Same-name.path"]);
  });
  it("migrates verified legacy project and hashed mirrors without losing source data", async () => {
    const directory = await folder(), project = createDemoProject();
    const legacy = path.join(directory, "Untitled.bordeaux");
    await writeProject(legacy, project);
    await fs.mkdir(path.join(directory, "Paths"));
    const hashed = `Paths/${createHash("sha256").update(project.paths[0].id).digest("hex").slice(0, 24)}.path`;
    const contents = JSON.stringify({ version: "2.0", robot: project.robot, ...project.paths[0] });
    await fs.writeFile(path.join(directory, hashed), contents);
    await fs.writeFile(projectWorkspacePath(directory), JSON.stringify({ format: "bordeaux-folder/1", projectPath: legacy, project,
      files: { [hashed]: createHash("sha256").update(contents).digest("hex") } }));
    await autosaveProjectFolder(directory, project, legacy);
    expect((await openProjectFolder(directory)).project).toEqual({ ...project, name: path.basename(directory) });
    await expect(fs.stat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(directory, hashed))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await fs.readFile(path.join(directory, "Paths/NewPath.path"), "utf8"))).toEqual({ version: "2.0", field: project.field, robot: project.robot, ...project.paths[0] });
  });
  it("migrates a selected standalone legacy project but preserves an unrelated project", async () => {
    const directory = await folder(), project = createDemoProject();
    const legacy = path.join(directory, "Imported.bordeaux");
    await writeProject(legacy, project);
    const unrelated = path.join(directory, "Other.bordeaux");
    await writeProject(unrelated, { ...project, name: "Other" });
    await autosaveProjectFolder(directory, project, legacy);
    await expect(fs.stat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readProject(unrelated)).project.name).toBe("Other");
    expect((await readProject(projectWorkspacePath(directory))).project.paths).toEqual(project.paths);
  });
  it("retries interrupted old-file cleanup without orphaning renamed documents", async () => {
    const directory = await folder(), project = createDemoProject();
    project.paths[0].name = "Before";
    await autosaveProjectFolder(directory, project, null);
    project.paths[0].name = "After";
    const unlink = fs.unlink.bind(fs); let fail = true;
    vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
      if (String(file).endsWith("Before.path") && fail) { fail = false; throw new Error("cleanup interrupted"); }
      return unlink(file);
    });
    await expect(autosaveProjectFolder(directory, project, null)).rejects.toThrow("cleanup interrupted");
    expect((await openProjectFolder(directory)).project?.paths[0].name).toBe("After");
    expect((await fs.readdir(path.join(directory, "Paths"))).sort()).toEqual(["After.path", "Before.path"]);
    await autosaveProjectFolder(directory, project, null);
    expect(await fs.readdir(path.join(directory, "Paths"))).toEqual(["After.path"]);
  });
  it("preserves externally changed obsolete mirrors and unrelated same-name files", async () => {
    const directory = await folder(), project = createDemoProject();
    project.paths[0].name = "Before";
    await autosaveProjectFolder(directory, project, null);
    await fs.writeFile(path.join(directory, "Paths/Before.path"), "external");
    project.paths[0].name = "After";
    await expect(autosaveProjectFolder(directory, project, null)).rejects.toThrow("old file was preserved");
    expect(await fs.readFile(path.join(directory, "Paths/Before.path"), "utf8")).toBe("external");
    const other = await folder(); await fs.mkdir(path.join(other, "Paths"));
    const contents = JSON.stringify({ version: "2.0", robot: project.robot, ...project.paths[0] }, null, 2) + "\n";
    await fs.writeFile(path.join(other, "Paths/After.path"), contents);
    await expect(autosaveProjectFolder(other, project, null)).rejects.toThrow("changed outside");
    expect(await fs.readFile(path.join(other, "Paths/After.path"), "utf8")).toBe(contents);
  });
  it("never cleans root, nested, traversal, or symlinked manifest entries", async () => {
    const directory = await folder(), outside = await folder(), project = createDemoProject();
    await autosaveProjectFolder(directory, project, null);
    const outsideFile = path.join(outside, "Keep.path"); await fs.writeFile(outsideFile, "keep");
    await fs.writeFile(path.join(directory, "Keep.path"), "keep");
    await fs.mkdir(path.join(directory, "Paths/Nested")); await fs.writeFile(path.join(directory, "Paths/Nested/Keep.path"), "keep");
    const state = JSON.parse(await fs.readFile(projectWorkspacePath(directory), "utf8"));
    const hash = createHash("sha256").update("keep").digest("hex");
    Object.assign(state.files, { "Keep.path": hash, "Paths/Nested/Keep.path": hash, [path.relative(directory, outsideFile)]: hash });
    await fs.writeFile(projectWorkspacePath(directory), JSON.stringify(state));
    await autosaveProjectFolder(directory, project, null);
    expect(await fs.readFile(outsideFile, "utf8")).toBe("keep");
    expect(await fs.readFile(path.join(directory, "Keep.path"), "utf8")).toBe("keep");
    expect(await fs.readFile(path.join(directory, "Paths/Nested/Keep.path"), "utf8")).toBe("keep");
    await fs.symlink(outsideFile, path.join(directory, "Paths/Linked.path"));
    const next = JSON.parse(await fs.readFile(projectWorkspacePath(directory), "utf8")); next.files["Paths/Linked.path"] = hash;
    await fs.writeFile(projectWorkspacePath(directory), JSON.stringify(next));
    await expect(autosaveProjectFolder(directory, project, null)).rejects.toThrow("preserved");
    expect(await fs.readFile(outsideFile, "utf8")).toBe("keep");
  });
  it("saves a case-only rename without mistaking its managed file for an external edit", async () => {
    const directory = await folder(), project = createDemoProject();
    project.paths[0].name = "CaseTest"; project.routines[0].name = "CaseTest";
    await autosaveProjectFolder(directory, project, null);
    project.paths[0].name = "casetest"; project.routines[0].name = "casetest";
    await autosaveProjectFolder(directory, project, null);
    expect(await fs.readdir(path.join(directory, "Paths"))).toEqual(["casetest.path"]);
    expect(await fs.readdir(path.join(directory, "Routines"))).toEqual(["casetest.routine"]);
    expect((await openProjectFolder(directory)).project?.paths[0].name).toBe("casetest");
  });
  it("retries a legacy migration interrupted after its canonical source journal", async () => {
    const directory = await folder(), project = createDemoProject();
    const legacy = path.join(directory, "Imported.bordeaux");
    await writeProject(legacy, project);
    const link = fs.link.bind(fs); let fail = true;
    vi.spyOn(fs, "link").mockImplementation(async (from, to) => {
      if (String(to).endsWith(".path") && fail) { fail = false; throw new Error("disk interrupted"); }
      return link(from, to);
    });
    await expect(autosaveProjectFolder(directory, project, legacy)).rejects.toThrow("disk interrupted");
    expect((await readProject(legacy)).project.paths).toEqual(project.paths);
    expect((await openProjectFolder(directory)).project?.paths).toEqual(project.paths);
    await autosaveProjectFolder(directory, project, legacy);
    await expect(fs.stat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(path.join(directory, "Paths"))).toEqual(["NewPath.path"]);
  });
  it("migrates an edited first save only when the opened legacy bytes are unchanged", async () => {
    const directory = await folder(), original = createDemoProject();
    const legacy = path.join(directory, "Imported.bordeaux");
    await writeProject(legacy, original);
    const project = (await readProject(legacy)).project;
    project.paths[0].name = "Edited before first save";
    await autosaveProjectFolder(directory, project, legacy);
    await expect(fs.stat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await openProjectFolder(directory)).project?.paths[0].name).toBe("Edited before first save");

    const other = await folder(), changedLegacy = path.join(other, "Imported.bordeaux");
    await writeProject(changedLegacy, original);
    const editing = (await readProject(changedLegacy)).project;
    const external = structuredClone(original); external.paths[0].name = "External edit";
    await writeProject(changedLegacy, external);
    editing.paths[0].name = "Our edit";
    await autosaveProjectFolder(other, editing, changedLegacy);
    expect((await readProject(changedLegacy)).project.paths[0].name).toBe("External edit");
    expect((await openProjectFolder(other)).project?.paths[0].name).toBe("Our edit");
  });
  it("uses .bordeaux and sanitizes suggested file names", () => {
    expect(projectFileName("Robot.bordeaux.json")).toBe("Robot.bordeaux");
    expect(projectFileName("../Robot")).toBe("..-Robot.bordeaux");
  });
});
