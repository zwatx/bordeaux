import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createNamedProjectSelection } from "../src/electron/projectCreation";
import { ProjectPersistence } from "../src/electron/projectPersistence";
import { ProjectSourcePersistence, canonicalProjectDigest } from "../src/electron/projectSourcePersistence";
import { ProjectRecoveryStore } from "../src/electron/projectRecoveryStore";
import { autosaveProjectFolder, projectWorkspacePath, writeProjectFolderBdx, ownProjectSource, assertProjectSource } from "../src/electron/projectFiles";
import { loadProjectSelection } from "../src/electron/projectOpening";
import { createDemoProject, blankPath } from "../src/shared/project/defaults";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function bytes(folder: string) {
  const result: Record<string, string> = {};
  for (const entry of await fs.readdir(folder, { recursive: true, withFileTypes: true })) if (entry.isFile()) {
    const file = path.join(entry.parentPath, entry.name);
    result[path.relative(folder, file)] = createHash("sha256").update(await fs.readFile(file)).digest("hex");
  }
  return result;
}
it.each([false, true])("refuses consistent external source and mirror replacement, prior save=%s", async prior => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-source-change-"))); roots.push(root);
  const folder = path.join(root, "Autos"); await fs.mkdir(folder); await autosaveProjectFolder(folder, createDemoProject(), null);
  const selection = await loadProjectSelection(folder), context = { windowEpoch: randomUUID(), documentSessionId: randomUUID(), targetGeneration: 1 };
  const location = { folderPath: folder, projectPath: projectWorkspacePath(folder) }, updates: any[] = [];
  let commits = 0;
  const source = new ProjectSourcePersistence({ getContext: () => context, commit: () => { commits++; return { context, location }; } });
  const recovery = new ProjectRecoveryStore(path.join(root, "recovery"));
  const persistence = new ProjectPersistence({ source, recovery, getContext: () => context, getLocation: () => location, onUpdate: update => updates.push(update) });
  persistence.admitSource(context, selection.sourceEvidence, selection.legacyFile);
  const request = (project = selection.project) => ({ context, snapshotRevision: 2, project });
  if (prior) expect((await persistence.checkpoint(request())).source).toBe("saved");
  const previousReceipt = persistence.getSession().latestSource, previousCommits = commits;
  const stale = structuredClone(selection.project); stale.paths[0].waypoints[1].y += .125;
  const external = structuredClone(selection.project); external.paths[0].waypoints[1].x += .75;
  await autosaveProjectFolder(folder, external, location.projectPath);
  const before = await bytes(folder); const start = updates.length, resolve = vi.spyOn(recovery, "markResolved");
  for (let retry = 0; retry < 2; retry++) {
    const saved = await persistence.checkpoint(request(stale));
    expect(saved.recovery).toBe("saved");
    const stored = await recovery.readSnapshot(saved.recoveryReceipt!.storedSnapshot!.recordId);
    expect(canonicalProjectDigest(stored.project)).toBe(canonicalProjectDigest(stale)); expect(stored.resolved).toBeUndefined();
    expect(saved.source).toBe("failed");
    expect(saved.sourceChange).toEqual({ scope: "workspace" });
    expect(saved.sourceFact).toContain("changed");
    expect(await bytes(folder)).toEqual(before); expect(commits).toBe(previousCommits);
    expect(persistence.getSession().latestSource).toEqual(previousReceipt);
  }
  expect(updates.slice(start).find(update => update.recovery === "saved" && update.source === "pending")).toBeDefined();
  expect(resolve).not.toHaveBeenCalled();
});

async function fixture(options: { empty?: boolean; legacy?: string; rawWorkspace?: boolean } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-head-"))); roots.push(root);
  const folder = path.join(root, "Autos"); await fs.mkdir(folder);
  const initial = createDemoProject(); initial.paths.push(blankPath("Second"));
  if (options.legacy) {
    const value: any = options.legacy.endsWith(".path") ? { version: "2.0", robot: initial.robot, ...initial.paths[0] } : initial;
    if (options.legacy.endsWith(".path")) { delete value.id; for (const waypoint of value.waypoints) delete waypoint.id; }
    await fs.writeFile(path.join(folder, options.legacy), JSON.stringify(value));
  }
  else if (!options.empty) await autosaveProjectFolder(folder, initial, null);
  if (options.rawWorkspace) {
    const state = JSON.parse(await fs.readFile(projectWorkspacePath(folder), "utf8"));
    delete state.project.paths[0].id; delete state.project.routines[0].id; delete state.project.editor; delete state.project.activeRoutineId; state.unknownFutureSource = { z: 1, a: 2 };
    await fs.writeFile(projectWorkspacePath(folder), JSON.stringify(state));
  }
  const selection = await loadProjectSelection(options.legacy ? path.join(folder, options.legacy) : folder);
  let context = { windowEpoch: randomUUID(), documentSessionId: randomUUID(), targetGeneration: 1 };
  let location = { folderPath: folder, projectPath: selection.projectPath, legacyFile: selection.legacyFile ?? undefined };
  let commits = 0; const updates: any[] = [];
  const source = new ProjectSourcePersistence({ getContext: () => context, commit: (capture, _project, target) => {
    source.assertCurrent(capture); commits++; if (location.projectPath !== target) context = { ...context, targetGeneration: context.targetGeneration + 1 };
    location = { folderPath: path.dirname(target), projectPath: target, legacyFile: undefined };
    persistence.sourceTargetCommitted(capture.operationId, context); return { context, location };
  } });
  const recovery = new ProjectRecoveryStore(path.join(root, "recovery"));
  const persistence = new ProjectPersistence({ source, recovery, getContext: () => context, getLocation: () => location, onUpdate: update => updates.push(update) });
  persistence.admitSource(context, selection.sourceEvidence, selection.legacyFile);
  return { root, folder, source, recovery, persistence, selection, project: selection.project, updates,
    checkpoint: (project = selection.project, destination?: Parameters<ProjectPersistence["checkpoint"]>[1]) => persistence.checkpoint({ project, context: { ...context }, snapshotRevision: 3 }, destination),
    replace: async () => { context = { ...context, documentSessionId: randomUUID() }; persistence.contextChanged(true); const next = await loadProjectSelection(folder); persistence.admitSource(context, next.sourceEvidence, next.legacyFile); },
    get context() { return context; }, get location() { return location; }, get commits() { return commits; } };
}
it("includes changed mirror ownership even when the project is unchanged, and tolerates JSON key order/whitespace", async () => {
  const f = await fixture(), workspace = projectWorkspacePath(f.folder);
  let state = JSON.parse(await fs.readFile(workspace, "utf8"));
  await fs.writeFile(workspace, JSON.stringify(Object.fromEntries(Object.entries(state).reverse())));
  expect((await f.checkpoint()).source).toBe("saved");
  state = JSON.parse(await fs.readFile(workspace, "utf8"));
  const file = state.documentFiles["path:" + f.project.paths[0].id];
  await fs.appendFile(path.join(f.folder, file), "\n");
  state.files[file] = createHash("sha256").update(await fs.readFile(path.join(f.folder, file))).digest("hex");
  await fs.writeFile(workspace, JSON.stringify(state)); const before = await bytes(f.folder), commits = f.commits;
  expect(await f.checkpoint()).toMatchObject({ source: "failed", recovery: "saved" });
  expect(await bytes(f.folder)).toEqual(before); expect(f.commits).toBe(commits);
});
it.each(["workspace", "legacy"])("refuses a %s appearing after a truly empty-folder admission", async kind => {
  const f = await fixture({ empty: true });
  if (kind === "workspace") await autosaveProjectFolder(f.folder, createDemoProject(), null);
  else await fs.writeFile(path.join(f.folder, "External.bordeaux"), JSON.stringify(createDemoProject()));
  const before = await bytes(f.folder); expect(await f.checkpoint()).toMatchObject({ source: "failed", recovery: "saved" });
  expect(await bytes(f.folder)).toEqual(before); expect(f.commits).toBe(0);
});
it("advances only owned source heads across first/unchanged/edit/revert saves", async () => {
  const f = await fixture({ empty: true }), original = structuredClone(f.project);
  expect((await f.checkpoint()).source).toBe("saved"); const stable = await fs.stat(path.join(f.folder, "Paths/NewPath.path"));
  expect((await f.checkpoint()).source).toBe("saved"); expect((await fs.stat(path.join(f.folder, "Paths/NewPath.path"))).ino).toBe(stable.ino);
  f.project.paths[0].constraints.maxVel = .5; expect((await f.checkpoint()).source).toBe("saved");
  expect((await f.checkpoint(original)).source).toBe("saved"); expect(f.commits).toBe(4);
});
it.each([false, true])("keeps its exact source journal retryable, external replacement=%s", async external => {
  const f = await fixture(); f.project.paths[0].constraints.maxVel = .5; f.project.paths[1].constraints.maxVel = .6;
  const rename = fs.rename.bind(fs); let fail = true;
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (fail && String(to).endsWith("Second.path")) { fail = false; throw new Error("disk interrupted"); }
    return rename(from, to);
  });
  expect(await f.checkpoint()).toMatchObject({ source: "failed", recovery: "saved" }); expect(f.persistence.getSession().latestSource).toBeUndefined();
  const first = await fs.stat(path.join(f.folder, "Paths/NewPath.path"));
  if (external) { const project = structuredClone(f.project); project.paths[0].waypoints[0].x += .3; await autosaveProjectFolder(f.folder, project, projectWorkspacePath(f.folder)); }
  const before = await bytes(f.folder); const retry = await f.checkpoint();
  expect(retry.source).toBe(external ? "failed" : "saved");
  if (external) expect(await bytes(f.folder)).toEqual(before);
  else expect((await fs.stat(path.join(f.folder, "Paths/NewPath.path"))).ino).toBe(first.ino);
});
it("acknowledges own legacy unlink before a failed final commit, allowing exact Retry", async () => {
  const f = await fixture({ legacy: "Autos.bordeaux" }), rename = fs.rename.bind(fs); let workspaceRenames = 0;
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (String(to) === projectWorkspacePath(f.folder) && ++workspaceRenames === 2) throw new Error("final commit interrupted");
    return rename(from, to);
  });
  expect((await f.checkpoint()).source).toBe("failed"); await expect(fs.lstat(path.join(f.folder, "Autos.bordeaux"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.persistence.getSession().latestSource).toBeUndefined(); expect((await f.checkpoint()).source).toBe("saved");
});
it.each(["Autos.bordeaux", "Autos.bordeaux.json", "Import.path"])("retains exact raw %s identity and refuses changed or missing selected bytes", async name => {
  const f = await fixture({ legacy: name }), file = path.join(f.folder, name);
  const original = await fs.readFile(file); await fs.writeFile(file, Buffer.concat([original, Buffer.from("\n")]));
  const before = await bytes(f.folder); expect((await f.checkpoint()).source).toBe("failed"); expect(await bytes(f.folder)).toEqual(before);
  await fs.writeFile(file, original); await fs.unlink(file); const missing = await bytes(f.folder);
  expect((await f.checkpoint()).source).toBe("failed"); expect(await bytes(f.folder)).toEqual(missing);
});
it("does not adopt a workspace appearing after legacy read", async () => {
  const f = await fixture({ legacy: "Autos.bordeaux.json" });
  await autosaveProjectFolder(f.folder, createDemoProject(), null); const before = await bytes(f.folder);
  expect((await f.checkpoint()).source).toBe("failed"); expect(await bytes(f.folder)).toEqual(before);
});
it("saves a copy independently of changed old source, retaining only its own pending destination Retry", async () => {
  const f = await fixture(), external = structuredClone(f.project); external.paths[0].waypoints[0].x += .2;
  await autosaveProjectFolder(f.folder, external, projectWorkspacePath(f.folder)); const old = await bytes(f.folder);
  const copy = path.join(f.root, "Copy"); await fs.mkdir(copy); const target = { folderPath: copy, projectPath: projectWorkspacePath(copy), createProject: true };
  const link = fs.link.bind(fs); let fail = true;
  vi.spyOn(fs, "link").mockImplementation(async (from, to) => {
    if (fail && String(to).endsWith(path.join("Copy", "Paths", "Second.path"))) { fail = false; throw new Error("copy interrupted"); }
    return link(from, to);
  });
  expect((await f.checkpoint(f.project, target)).source).toBe("failed"); expect(await f.persistence.isPendingDestination(copy)).toBe(true);
  expect(f.location.folderPath).toBe(f.folder); expect((await f.checkpoint(f.project, target)).source).toBe("saved");
  expect(f.location.folderPath).toBe(copy); expect(await f.persistence.isPendingDestination(copy)).toBe(false); expect(await bytes(f.folder)).toEqual(old);
});
it.each([false, true])("BDX preserves the raw pre-normalization source partition, interrupted journal=%s", async interrupted => {
  const f = await fixture({ rawWorkspace: true }), workspace = projectWorkspacePath(f.folder), original = JSON.parse(await fs.readFile(workspace, "utf8"));
  const link = fs.link.bind(fs); let fail = interrupted;
  vi.spyOn(fs, "link").mockImplementation(async (from, to) => {
    if (fail && String(to).endsWith("Test.bdx")) { fail = false; throw new Error("bdx interrupted"); }
    return link(from, to);
  });
  const write = writeProjectFolderBdx(f.folder, [{ fileName: "Test.bdx", bytes: Buffer.from("first") }]);
  if (interrupted) await expect(write).rejects.toThrow("bdx interrupted"); else await write;
  const { generatedFiles: _g, pendingGeneratedFiles: _p, ...actual } = JSON.parse(await fs.readFile(workspace, "utf8"));
  const { generatedFiles: _oldG, pendingGeneratedFiles: _oldP, ...expected } = original;
  expect(actual).toEqual(expected); expect(actual.project.paths[0].id).toBeUndefined();
  expect((await f.checkpoint()).source).toBe("saved");
  await writeProjectFolderBdx(f.folder, [{ fileName: "Test.bdx", bytes: Buffer.from("selected") }], { mode: "selected" });
  expect((await f.checkpoint()).source).toBe("saved"); await writeProjectFolderBdx(f.folder, []);
  expect((await f.checkpoint()).source).toBe("saved");
});
it("confirms busy saved source after BDX bookkeeping, but refuses source ownership drift", async () => {
  const f = await fixture(); expect((await f.checkpoint()).source).toBe("saved");
  await writeProjectFolderBdx(f.folder, [{ fileName: "Test.bdx", bytes: Buffer.from("generated") }]);
  const release = await f.source.holdExport(f.folder), commits = f.commits;
  expect((await f.checkpoint()).source).toBe("saved"); expect(f.commits).toBe(commits);
  const workspace = projectWorkspacePath(f.folder), state = JSON.parse(await fs.readFile(workspace, "utf8")); state.files["Paths/NewPath.path"] = "0".repeat(64);
  await fs.writeFile(workspace, JSON.stringify(state)); const before = await bytes(f.folder);
  expect((await f.checkpoint()).source).toBe("failed"); expect(await bytes(f.folder)).toEqual(before); expect(f.commits).toBe(commits); release();
});
it("acknowledges a submitted rename only after resolution, before its late context guard, on the detached old owner", async () => {
  const f = await fixture(), owner = ownProjectSource(f.selection.sourceEvidence), oldHead = structuredClone(owner.head);
  const rename = fs.rename.bind(fs); let resolve!: () => void, entered!: () => void;
  const gate = new Promise<void>(done => { resolve = done; }), started = new Promise<void>(done => { entered = done; }); let valid = true;
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => { await rename(from, to); if (String(to) === projectWorkspacePath(f.folder)) { entered(); await gate; } });
  const changed = structuredClone(f.project); changed.paths[0].constraints.maxVel = .5;
  const pending = autosaveProjectFolder(f.folder, changed, projectWorkspacePath(f.folder), { sourceOwner: owner, assertCurrent: () => { if (!valid) throw new Error("retired"); } });
  const rejected = expect(pending).rejects.toThrow("retired"); await started; expect(owner.head).toEqual(oldHead);
  await f.replace(); const session = f.persistence.getSession(); valid = false; resolve(); await rejected;
  expect(owner.head).not.toEqual(oldHead); await assertProjectSource(owner);
  expect(f.persistence.getSession()).toEqual(session); expect(f.commits).toBe(0);
});

it("keeps raw imported-path evidence stable across minted IDs and permits the unchanged migration", async () => {
  const f = await fixture({ legacy: "Import.path" });
  const second = await loadProjectSelection(path.join(f.folder, "Import.path"));
  expect(second.sourceEvidence).toEqual(f.selection.sourceEvidence);
  expect((await f.checkpoint()).source).toBe("saved");
  expect((await loadProjectSelection(f.folder)).project.paths[0].id).toBe(f.project.paths[0].id);
});
it("refuses a project appearing in the exclusively named child before its first write", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-create-race-"))); roots.push(root);
  const child = path.join(root, "New"), mkdir = fs.mkdir.bind(fs); let once = true, external: Record<string, string> | undefined;
  vi.spyOn(fs, "mkdir").mockImplementation(async (...args: any[]) => {
    const result = await (mkdir as any)(...args);
    if (once && String(args[0]) === child) { once = false; await autosaveProjectFolder(child, createDemoProject(), null); external = await bytes(child); }
    return result;
  });
  await expect(createNamedProjectSelection({ name: "New", parentDirectory: root })).rejects.toMatchObject({ code: "PROJECT_SOURCE_CHANGED" });
  expect(external).toBeDefined(); expect(await bytes(child)).toEqual(external);
});
it("rechecks foreign source changes after asynchronous mirror preflight and before creating the journal", async () => {
  const f = await fixture(), read = fs.readFile.bind(fs), workspace = projectWorkspacePath(f.folder); let once = true, changed: Record<string, string> | undefined;
  vi.spyOn(fs, "readFile").mockImplementation(async (...args: any[]) => {
    const result = await (read as any)(...args);
    if (once && String(args[0]).endsWith(path.join("Paths", "NewPath.path"))) {
      once = false; const state = JSON.parse(await read(workspace, "utf8")); state.foreignUnknownSource = true;
      await fs.writeFile(workspace, JSON.stringify(state)); changed = await bytes(f.folder);
    }
    return result;
  });
  expect((await f.checkpoint()).source).toBe("failed"); expect(changed).toBeDefined(); expect(await bytes(f.folder)).toEqual(changed); expect(f.commits).toBe(0);
});
it("does not overwrite a foreign workspace change discovered at the final commit boundary", async () => {
  const f = await fixture(), rename = fs.rename.bind(fs), workspace = projectWorkspacePath(f.folder); let once = true, foreign: string | undefined;
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    await rename(from, to);
    if (once && String(to) === workspace) { once = false; const state = JSON.parse(await fs.readFile(workspace, "utf8")); state.foreignUnknownSource = true; foreign = JSON.stringify(state); await fs.writeFile(workspace, foreign); }
  });
  expect((await f.checkpoint()).source).toBe("failed"); expect(foreign).toBeDefined(); expect(await fs.readFile(workspace, "utf8")).toBe(foreign);
  expect(f.commits).toBe(0); expect(f.persistence.getSession().latestSource).toBeUndefined();
});

it("reports the exact changed managed document and clears the typed fact after an explicit successful Retry", async () => {
  const f = await fixture(), file = path.join(f.folder, "Paths/NewPath.path");
  await fs.appendFile(file, "\n"); const before = await bytes(f.folder);
  const failed = await f.checkpoint();
  expect(failed).toMatchObject({ source: "failed", recovery: "saved", sourceChange: { scope: "document", file: "Paths/NewPath.path" } });
  expect(failed.sourceFact).toContain("NewPath.path changed outside Bordeaux");
  expect(await bytes(f.folder)).toEqual(before); expect(f.commits).toBe(0);
  await fs.unlink(file);
  const retried = await f.checkpoint();
  expect(retried.source).toBe("saved"); expect(retried.sourceChange).toBeUndefined();
  expect(f.updates.at(-1).sourceChange).toBeUndefined();
});
