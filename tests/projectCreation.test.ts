import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoProject, defaultPathConstraints } from "../src/shared/project/defaults";
import { createNamedProjectSelection } from "../src/electron/projectCreation";
import { loadProjectFolderSelection } from "../src/electron/projectOpening";
import { projectWorkspacePath, readProject } from "../src/electron/projectFiles";

const directories: string[] = [];
async function parent() {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-named-project-")); directories.push(folder); return folder;
}
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await Promise.all(directories.splice(0).map(folder => fs.rm(folder, { recursive: true, force: true }))); });

describe("named project creation before activation", () => {
  it("creates a separate named folder with round-trippable defaults and fresh path/routine IDs", async () => {
    const directory = await parent();
    const first = await createNamedProjectSelection({ name: "Week 3", parentDirectory: directory });
    const second = await createNamedProjectSelection({ name: "Week 4", parentDirectory: directory });
    expect(first.folderPath).toBe(path.join(directory, "Week 3"));
    expect(first.projectPath).toBe(projectWorkspacePath(first.folderPath));
    expect(first.recentPath).toBe(first.folderPath); expect(first.legacyFile).toBeNull();
    expect(await fs.readdir(first.folderPath)).toEqual([".bordeaux-workspace.json", "Paths", "Routines"]);
    expect((await readProject(first.projectPath!)).project).toEqual(first.project);
    expect(first.project.name).toBe("Week 3");
    expect(first.project.paths[0].waypoints).toEqual(createDemoProject().paths[0].waypoints);
    expect(first.project.editor?.activePathId).toBe(first.project.paths[0].id);
    expect(first.project.activeRoutineId).toBe(first.project.routines[0].id);
    expect(first.project.paths[0].id).not.toBe(second.project.paths[0].id);
    expect(first.project.routines[0].id).not.toBe(second.project.routines[0].id);
  });

  it("copies only explicit valid robot and limits, leaving old documents and links behind", async () => {
    const directory = await parent(), source = createDemoProject();
    source.robot.w = 1.1; source.robot.drive = "tank";
    source.paths[0].constraints.maxVel = 1.4;
    source.paths[0].markers = [{ id: "old-command", name: "Old", f: 0.5 }];
    source.paths[0].targets = [{ f: 0.5, deg: 90 }];
    source.paths[0].ranges = [{ anchor: "param", f0: 0.2, f1: 0.4, maxVel: 0.3 }];
    (source.paths[0] as any).optimization = { accepted: { oldResult: true } };
    source.editor!.robotProjectBookmarkId = "old-link";
    const template = { ...source, constraints: source.paths[0].constraints, commands: ["old"] };
    const selection = await createNamedProjectSelection({ name: "New robot", parentDirectory: directory, template });
    expect(selection.project.robot).toEqual(source.robot);
    expect(selection.project.robot).not.toBe(source.robot);
    expect(selection.project.paths[0].constraints).toEqual(source.paths[0].constraints);
    expect(selection.project.paths).toHaveLength(1); expect(selection.project.routines).toHaveLength(1);
    expect(selection.project.paths[0].id).not.toBe(source.paths[0].id);
    expect(selection.project.paths[0]).toMatchObject({ markers: [], targets: [], ranges: [] });
    expect(selection.project.paths[0].optimization).toBeUndefined();
    expect(selection.project.pathLinks).toEqual([]); expect(selection.project.routines[0].nodes).toEqual([]);
    expect(selection.project.editor?.robotProjectBookmarkId).toBeUndefined();
    const robotOnly = await createNamedProjectSelection({ name: "Robot defaults", parentDirectory: directory, template: { robot: source.robot } });
    expect(robotOnly.project.paths[0].constraints).toEqual(defaultPathConstraints(source.robot));
  });

  it.each(["", ".", "..", "../escape", "a/b", "a\\b", "C:drive", "CON", "nul.path", "LPT1", "COM².txt", "trailing.", "nul\0byte", "bad\nname", "界".repeat(86), "\uD800"])("rejects unsafe name %j before creating anything", async name => {
    const directory = await parent();
    await expect(createNamedProjectSelection({ name, parentDirectory: directory })).rejects.toThrow();
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it.each([null, 42, { name: Number.NaN, parentDirectory: "/tmp" }, { name: "Test", parentDirectory: "relative" }, { name: "Test", parentDirectory: Infinity }])("rejects malformed request %j", async request => {
    await expect(createNamedProjectSelection(request)).rejects.toThrow();
  });

  it.each(["robot", "limits", "null-limits"])("rejects invalid %s before creating a folder", async kind => {
    const directory = await parent(), source = createDemoProject();
    const template: any = { robot: source.robot, constraints: source.paths[0].constraints };
    if (kind === "robot") template.robot.maxSpeed = Number.NaN;
    if (kind === "limits") template.constraints.maxAccel = Infinity;
    if (kind === "null-limits") template.constraints = null;
    await expect(createNamedProjectSelection({ name: "Invalid", parentDirectory: directory, template })).rejects.toThrow("invalid");
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it.each(["folder", "file", "symlink"])("never opens or replaces a colliding %s", async kind => {
    const directory = await parent(), target = path.join(directory, "Existing"), elsewhere = await parent();
    if (kind === "folder") { await fs.mkdir(target); await fs.writeFile(path.join(target, "user.txt"), "keep"); }
    if (kind === "file") await fs.writeFile(target, "keep");
    if (kind === "symlink") await fs.symlink(elsewhere, target);
    await expect(createNamedProjectSelection({ name: "Existing", parentDirectory: directory })).rejects.toThrow("already exists");
    if (kind === "folder") expect(await fs.readFile(path.join(target, "user.txt"), "utf8")).toBe("keep");
    if (kind === "file") expect(await fs.readFile(target, "utf8")).toBe("keep");
    if (kind === "symlink") expect(await fs.readlink(target)).toBe(elsewhere);
    expect(await fs.readdir(elsewhere)).toEqual([]);
  });

  it("admits only one simultaneous creator for the same target", async () => {
    const directory = await parent(), request = { name: "Same", parentDirectory: directory };
    const results = await Promise.allSettled([createNamedProjectSelection(request), createNamedProjectSelection(request)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await loadProjectFolderSelection(path.join(directory, "Same"))).project.name).toBe("Same");
  });

  it("keeps active model unchanged on persistence failure and preserves recoverable source", async () => {
    const directory = await parent(), project = createDemoProject();
    const active = { project, folder: "old-folder", dirty: true, link: "old-link", recent: ["old-folder"] };
    const before = structuredClone(active), link = fs.link.bind(fs);
    vi.spyOn(fs, "link").mockImplementation(async (from, to) => {
      if (String(to).endsWith(".path")) throw new Error("Disk interrupted");
      return link(from, to);
    });
    const createAndActivate = async () => {
      const selected = await createNamedProjectSelection({ name: "Interrupted", parentDirectory: directory });
      Object.assign(active, { project: selected.project, folder: selected.folderPath, dirty: false, link: null, recent: [selected.recentPath] });
    };
    await expect(createAndActivate()).rejects.toThrow("Disk interrupted");
    expect(active).toEqual(before);
    expect((await loadProjectFolderSelection(path.join(directory, "Interrupted"))).project.name).toBe("Interrupted");
  });

  it("rejects a symlink parent without writing its target", async () => {
    const directory = await parent(), target = await parent(), alias = path.join(directory, "Alias");
    await fs.symlink(target, alias);
    await expect(createNamedProjectSelection({ name: "Test", parentDirectory: alias })).rejects.toThrow("regular directory");
    expect(await fs.readdir(target)).toEqual([]);
  });

  it("returns no selection when loading fails after the complete source was saved", async () => {
    const directory = await parent();
    vi.spyOn(fs, "readFile").mockRejectedValue(new Error("Could not load saved project"));
    await expect(createNamedProjectSelection({ name: "Saved", parentDirectory: directory })).rejects.toThrow("Could not load saved project");
    vi.restoreAllMocks();
    const selected = await loadProjectFolderSelection(path.join(directory, "Saved"));
    expect(selected.project.name).toBe("Saved"); expect(selected.project.paths).toHaveLength(1);
    expect(await fs.readdir(path.join(selected.folderPath, "Paths"))).toEqual(["NewPath.path"]);
  });
});

// Copy is an exclusive folder admission, never New's model/template writer.
describe("named copy admission and bounded defaults", () => {
  it("creates only the exact physical child and refuses foreign EEXIST", async () => {
    const { createProjectCopyFolder } = await import("../src/electron/projectCreation");
    const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-copy-"))); directories.push(parent);
    const mark = { creating: false, created: false };
    const options = { mark, assertCurrent: () => {}, allowExisting: async () => null };
    const made = await createProjectCopyFolder({ name: "Authored copy", parentDirectory: parent }, options);
    expect(made).toHaveProperty("created.child.objectKey");
    expect(mark).toEqual({ creating: false, created: true });
    expect(await fs.readdir(path.join(parent, "Authored copy"))).toEqual([]);
    await expect(createProjectCopyFolder({ name: "Authored copy", parentDirectory: parent }, options)).rejects.toThrow("already exists");
  });

  it("stops before mkdir when the parent observation becomes stale", async () => {
    const { createProjectCopyFolder } = await import("../src/electron/projectCreation");
    let live = true;
    const mkdir = vi.fn();
    await expect(createProjectCopyFolder({ name: "Copy", parentDirectory: "/parent" }, {
      mark: { creating: false, created: false }, assertCurrent: () => { if (!live) throw new Error("stale"); }, allowExisting: async () => null,
    }, { identity: async () => { live = false; return { folderPath: "/parent", pathKey: "/parent", objectKey: "1:2" }; }, lstat: vi.fn(), mkdir })).rejects.toThrow("stale");
    expect(mkdir).not.toHaveBeenCalled();
  });

  it("bounds a stalled parent lookup and stops abandoned scans without creating the home", async () => {
    const { suggestProjectCopy } = await import("../src/electron/projectCreation");
    vi.useFakeTimers();
    let finish!: (value: any) => void;
    const lstat = vi.fn();
    const pending = suggestProjectCopy({ kind: "folder", base: "Source", parent: "/parent" }, { ctx: () => {}, home: "/missing-home", deadlineMs: 750 }, {
      identity: () => new Promise(resolve => { finish = resolve; }), lstat,
    });
    await vi.advanceTimersByTimeAsync(750);
    expect(await pending).toEqual({ name: "Source copy", parentDirectory: "/missing-home" });
    finish({ folderPath: "/parent", pathKey: "/parent", objectKey: "1:2" });
    await Promise.resolve(); await Promise.resolve();
    expect(lstat).not.toHaveBeenCalled();
  });
});

describe("copy physical observation boundaries", () => {
  it.each(["before", "after"])("refuses parent replacement %s mkdir", async stage => {
    const { createProjectCopyFolder } = await import("../src/electron/projectCreation");
    let observations = 0;
    const mkdir = vi.fn(async () => undefined);
    const lstat = vi.fn(async () => ({ dev: 1, ino: ++observations === 1 && stage === "after" ? 2 : 3, isDirectory: () => true, isSymbolicLink: () => false }));
    const mark = { creating: false, created: false };
    await expect(createProjectCopyFolder({ name: "Copy", parentDirectory: "/parent" }, { mark, assertCurrent: () => {}, allowExisting: async () => null }, {
      identity: async folder => ({ folderPath: folder, pathKey: folder, objectKey: folder === "/parent" ? "1:2" : "1:4" }), lstat: lstat as any, mkdir,
    })).rejects.toThrow(stage === "before" ? "Location changed" : "chosen folder changed");
    expect(mkdir).toHaveBeenCalledTimes(stage === "before" ? 0 : 1); expect(mark.created).toBe(stage === "after");
  });
  it("allows only the exact owner returned for EEXIST and guards that reply", async () => {
    const { createProjectCopyFolder } = await import("../src/electron/projectCreation");
    const directory = await parent(); await fs.mkdir(path.join(directory, "Copy"));
    const owner = { identity: { folderPath: path.join(directory, "Copy"), pathKey: path.join(directory, "Copy"), objectKey: "fixture" } } as any;
    let live = true;
    const options = { mark: { creating: false, created: false }, assertCurrent: () => { if (!live) throw new Error("stale"); }, allowExisting: async () => owner };
    expect(await createProjectCopyFolder({ name: "Copy", parentDirectory: directory }, options)).toEqual({ existing: owner });
    options.allowExisting = async () => { live = false; return owner; };
    await expect(createProjectCopyFolder({ name: "Copy", parentDirectory: directory }, options)).rejects.toThrow("stale");
    expect(await fs.readdir(path.join(directory, "Copy"))).toEqual([]);
  });
  it("never observes or claims the late child after pending mkdir loses its owner", async () => {
    const { createProjectCopyFolder } = await import("../src/electron/projectCreation");
    let live = true, resolve!: () => void;
    const identity = vi.fn(async folder => ({ folderPath: folder, pathKey: folder, objectKey: "1:2" }));
    const mark = { creating: false, created: false };
    const pending = createProjectCopyFolder({ name: "Copy", parentDirectory: "/parent" }, { mark, assertCurrent: () => { if (!live) throw new Error("stale"); }, allowExisting: async () => null }, {
      identity, lstat: vi.fn(async () => ({ dev: 1, ino: 2, isDirectory: () => true, isSymbolicLink: () => false })) as any,
      mkdir: () => new Promise<undefined>(done => { resolve = () => done(undefined); }),
    });
    await vi.waitFor(() => expect(mark.creating).toBe(true));
    live = false; resolve(); await expect(pending).rejects.toThrow("stale");
    expect(mark.created).toBe(true); expect(identity).toHaveBeenCalledTimes(1);
  });
  it("suggests first free names read-only and propagates stale defaults", async () => {
    const { suggestProjectCopy, copyBaseName, StaleCopyDefaults } = await import("../src/electron/projectCreation");
    const directory = await parent(), home = path.join(directory, "home");
    await fs.mkdir(path.join(directory, "Source copy"));
    expect(await suggestProjectCopy({ kind: "folder", base: "Source", parent: directory }, { ctx: () => {}, home, deadlineMs: 750 })).toEqual({ name: "Source copy 2", parentDirectory: await fs.realpath(directory) });
    expect(copyBaseName("CON", "folder")).toBe("_CON"); expect(copyBaseName("", "untitled")).toBe("Untitled");
    expect(Buffer.byteLength(copyBaseName("界".repeat(300), "folder") + " copy 99")).toBeLessThanOrEqual(255);
    await expect(fs.lstat(home)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(suggestProjectCopy({ kind: "untitled", base: "", parent: null }, { ctx: () => { throw new StaleCopyDefaults(); }, home, deadlineMs: 750 })).rejects.toThrow("no longer current");
    expect(await fs.readdir(directory)).toEqual(["Source copy"]);
  });
});
