import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listRecentProjects, recentProjectId, recentProjectPathById, removeRecentProjectById, readRecentProjectFiles, rememberRecentProject, writeRecentProjectFiles } from "../src/electron/recentProjectFiles";
import { createDemoProject } from "../src/shared/project/defaults";
import { autosaveProjectFolder, MAX_PROJECT_FILE_BYTES, projectWorkspacePath } from "../src/electron/projectFiles";
import { loadProjectSelection } from "../src/electron/projectOpening";

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function folder() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-recent-metadata-")); directories.push(directory); return directory;
}

describe("recent project files", () => {
  it("persists absolute paths in most-recent order", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-projects-"));
    directories.push(directory);
    const filePath = path.join(directory, "recent-projects.json");
    const first = path.join(directory, "first.bordeaux.json");
    const second = path.join(directory, "second.bordeaux.json");
    let projects = rememberRecentProject([], first);
    projects = rememberRecentProject(projects, second);
    projects = rememberRecentProject(projects, first);

    await writeRecentProjectFiles(filePath, projects);

    expect(await readRecentProjectFiles(filePath)).toEqual([first, second]);
  });

  it("drops malformed entries and rejects oversized storage", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-projects-"));
    directories.push(directory);
    const filePath = path.join(directory, "recent-projects.json");
    await fs.writeFile(filePath, JSON.stringify({ version: 1, projects: ["relative.json"] }));
    expect(await readRecentProjectFiles(filePath)).toEqual([]);
    await fs.writeFile(filePath, " ".repeat(64 * 1024 + 1));
    await expect(readRecentProjectFiles(filePath)).rejects.toThrow(/size limit/);
  });

  it("lists current metadata without dropping missing/invalid entries or changing files", async () => {
    const directory = await folder(), valid = path.join(directory, "Available"), invalid = path.join(directory, "Bad.bordeaux"), missing = path.join(directory, "Missing.bordeaux");
    await fs.mkdir(valid); await autosaveProjectFolder(valid, createDemoProject(), null);
    await fs.writeFile(invalid, "private malformed contents");
    const workspace = projectWorkspacePath(valid), before = await fs.readFile(workspace, "utf8");
    const listed = await listRecentProjects([valid, missing, invalid]);
    expect(listed).toHaveLength(3);
    expect(listed[0]).toMatchObject({ name: "Available", folderHint: directory, status: "available", location: { folderPath: valid, projectPath: workspace } });
    expect(listed[1]).toMatchObject({ status: "missing", code: "not-found" });
    expect(listed[2]).toMatchObject({ status: "invalid", code: "invalid-project" });
    expect(JSON.stringify(listed)).not.toContain("private malformed contents");
    expect(await fs.readFile(workspace, "utf8")).toBe(before); expect(await fs.readFile(invalid, "utf8")).toBe("private malformed contents");
  });

  it("keeps IDs stable through reordered recents and rejects unknown or removed IDs", async () => {
    const directory = await folder(), a = path.join(directory, "A"), b = path.join(directory, "B");
    const id = recentProjectId(a);
    expect(recentProjectId(path.join(a, "..", "A"))).toBe(id);
    expect(recentProjectPathById([a, b], id)).toBe(a);
    expect(recentProjectPathById(rememberRecentProject([a, b], b), id)).toBe(a);
    const next = removeRecentProjectById([b, a], id);
    expect(next).toEqual([b]); expect(() => recentProjectPathById(next, id)).toThrow("no longer in the list");
    expect(() => recentProjectPathById([a, b], directory)).toThrow();
    expect(() => recentProjectPathById([a, b], 0)).toThrow();
  });

  it("keeps legacy file opening and migrated-file workspace recovery compatible", async () => {
    const directory = await folder(), legacy = path.join(directory, "Legacy.bordeaux"), project = createDemoProject(); project.name = "Legacy name";
    await fs.writeFile(legacy, JSON.stringify(project));
    expect((await listRecentProjects([legacy]))[0]).toMatchObject({ name: "Legacy name", status: "available", location: { projectPath: legacy, legacyFile: legacy } });
    const selected = await loadProjectSelection(recentProjectPathById([legacy], recentProjectId(legacy)));
    expect(selected.project.paths[0].id).toBe(project.paths[0].id);
    await autosaveProjectFolder(directory, selected.project, selected.projectPath, { legacyFile: selected.legacyFile });
    await expect(fs.lstat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await listRecentProjects([legacy]))[0]).toMatchObject({ id: recentProjectId(legacy), status: "available", location: { projectPath: projectWorkspacePath(directory) } });
    expect((await listRecentProjects([legacy]))[0].location).not.toHaveProperty("legacyFile");
    expect((await loadProjectSelection(legacy)).project.paths[0].id).toBe(project.paths[0].id);
  });

  it("does not grant opened-file replacement provenance merely by listing metadata", async () => {
    const directory = await folder(), legacy = path.join(directory, "Not opened.bordeaux.json"), project = createDemoProject();
    const contents = JSON.stringify(project); await fs.writeFile(legacy, contents);
    expect((await listRecentProjects([legacy]))[0]).toMatchObject({ status: "available", location: { folderPath: directory, projectPath: null, legacyFile: legacy } });
    await autosaveProjectFolder(directory, createDemoProject(), null);
    const workspace = projectWorkspacePath(directory), state = JSON.parse(await fs.readFile(workspace, "utf8"));
    state.importedFrom = { file: legacy, hash: createHash("sha256").update(contents).digest("hex") };
    await fs.writeFile(workspace, JSON.stringify(state));
    await expect(autosaveProjectFolder(directory, project, null, { legacyFile: legacy })).rejects.toThrow("may hold newer work");
  });

  it("rejects linked and oversized entries before reading their contents", async () => {
    const directory = await folder(), outside = path.join(directory, "secret.bordeaux"), alias = path.join(directory, "Alias.bordeaux"), large = path.join(directory, "Large.bordeaux");
    await fs.writeFile(outside, "private content"); await fs.symlink(outside, alias);
    await fs.writeFile(large, ""); await fs.truncate(large, MAX_PROJECT_FILE_BYTES + 1);
    const read = vi.spyOn(fs, "readFile");
    const listed = await listRecentProjects([alias, large]);
    expect(listed[0]).toMatchObject({ status: "invalid", code: "unsafe-entry" });
    expect(listed[1]).toMatchObject({ status: "invalid", code: "size-limit" });
    expect(read).not.toHaveBeenCalled();
    const storage = path.join(directory, "recent.json"); await fs.symlink(outside, storage);
    await expect(readRecentProjectFiles(storage)).rejects.toThrow("regular file");
    expect(read).not.toHaveBeenCalled();
  });

  it("reports permission failures with machine codes and no exception contents", async () => {
    const directory = await folder(), target = path.join(directory, "Blocked.bordeaux");
    vi.spyOn(fs, "lstat").mockRejectedValue(Object.assign(new Error("private exception text"), { code: "EACCES" }));
    const listed = await listRecentProjects([target]);
    expect(listed[0]).toMatchObject({ status: "invalid", code: "not-readable", detail: "Project cannot be read" });
    expect(JSON.stringify(listed)).not.toContain("private exception text");
  });

  it("removes only local-list records, keeps project files, and serializes updates", async () => {
    const directory = await folder(), a = path.join(directory, "A.bordeaux"), b = path.join(directory, "B.bordeaux"), storage = path.join(directory, "recent.json");
    await fs.writeFile(a, JSON.stringify(createDemoProject())); await fs.writeFile(b, JSON.stringify(createDemoProject()));
    const initial = [a, b], next = removeRecentProjectById(initial, recentProjectId(a));
    await Promise.all([writeRecentProjectFiles(storage, initial), writeRecentProjectFiles(storage, next)]);
    expect(await readRecentProjectFiles(storage)).toEqual([b]);
    expect((await fs.lstat(a)).isFile()).toBe(true); expect((await fs.lstat(b)).isFile()).toBe(true);
    expect(removeRecentProjectById(next, recentProjectId(a))).toEqual(next);
  });

  it("retains the eight-entry ceiling and most-recent ordering", async () => {
    const directory = await folder(), storage = path.join(directory, "recent.json");
    const projects = Array.from({ length: 12 }, (_, index) => path.join(directory, `${index}.bordeaux`));
    await writeRecentProjectFiles(storage, projects);
    expect(await readRecentProjectFiles(storage)).toEqual(projects.slice(0, 8));
    expect((await listRecentProjects(projects)).map(entry => entry.id)).toEqual(projects.slice(0, 8).map(recentProjectId));
    expect(rememberRecentProject(projects.slice(0, 8), projects[9])).toEqual([projects[9], ...projects.slice(0, 7)]);
  });
});
