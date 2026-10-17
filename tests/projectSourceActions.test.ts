import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { randomUUID, createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createDemoProject } from "../src/shared/project/defaults";
import type { ProjectLocation } from "../src/shared/project/desktopProjects";
import { autosaveProjectFolder, projectWorkspacePath } from "../src/electron/projectFiles";
import { loadProjectSelection } from "../src/electron/projectOpening";
import { projectFolderIdentity, sameProjectFolder } from "../src/electron/projectFolderIdentity";
import { completeProjectActivation } from "../src/electron/projectActivation";
import { ProjectPersistence, ReloadStale } from "../src/electron/projectPersistence";
import { ProjectRecoveryStore } from "../src/electron/projectRecoveryStore";
import { ProjectRecoveryCatalog } from "../src/electron/projectRecoveryCatalog";
import { ProjectSourcePersistence, sameProjectContext, canonicalProjectDigest } from "../src/electron/projectSourcePersistence";
import { reloadProjectSource, revealProjectSource, ProjectActivationFolderChanged } from "../src/electron/projectSourceActions";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function sourceBytes(folder: string) {
  const result: Record<string, string> = {};
  for (const entry of await fs.readdir(folder, { recursive: true, withFileTypes: true })) if (entry.isFile()) {
    const file = path.join(entry.parentPath, entry.name);
    result[path.relative(folder, file)] = createHash("sha256").update(await fs.readFile(file)).digest("hex");
  }
  return result;
}
async function fixture(legacy = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-source-actions-"))); roots.push(root);
  const folder = path.join(root, "Autos"); await fs.mkdir(folder);
  const original = createDemoProject(), legacyFile = path.join(folder, "Alpha.bordeaux");
  if (legacy) await fs.writeFile(legacyFile, JSON.stringify(original));
  else await autosaveProjectFolder(folder, original, null);
  const selection = await loadProjectSelection(legacy ? legacyFile : folder);
  let context = { windowEpoch: randomUUID(), documentSessionId: randomUUID(), targetGeneration: 1 };
  let location: ProjectLocation = { folderPath: folder, projectPath: selection.projectPath, ...(selection.legacyFile ? { legacyFile: selection.legacyFile } : {}) };
  let sourceCommits = 0, linked = true;
  const source = new ProjectSourcePersistence({ getContext: () => context, commit: (capture, _project, target) => {
    source.assertCurrent(capture); sourceCommits++;
    location = { folderPath: path.dirname(target), projectPath: target };
    context = { ...context, targetGeneration: context.targetGeneration + 1 };
    persistence.sourceTargetCommitted(capture.operationId, context); return { context, location };
  } });
  const recovery = new ProjectRecoveryStore(path.join(root, "recovery"));
  const updates: unknown[] = [];
  const persistence = new ProjectPersistence({ source, recovery, getContext: () => context, getLocation: () => location, onUpdate: update => updates.push(update) });
  persistence.admitSource(context, selection.sourceEvidence, selection.legacyFile);
  const catalog = new ProjectRecoveryCatalog(path.join(root, "recovery"), recovery, () => undefined);
  const activate = vi.fn<Parameters<typeof reloadProjectSource>[1]["activate"]>(async (next, options) => {
    await source.assertReadable(next.folderPath, options.assertCurrent);
    const physical = await projectFolderIdentity(next.folderPath, { assertCurrent: options.assertCurrent });
    if (physical.objectKey !== next.sourceEvidence.identity.objectKey || !sameProjectFolder(physical, next.sourceEvidence.identity)) throw new ProjectActivationFolderChanged();
    options.assertCurrent(); options.committed();
    context = { ...context, documentSessionId: randomUUID(), targetGeneration: context.targetGeneration + 1 };
    location = { folderPath: next.folderPath, projectPath: next.projectPath, ...(next.legacyFile ? { legacyFile: next.legacyFile } : {}) };
    persistence.contextChanged(true); persistence.admitSource(context, next.sourceEvidence, next.legacyFile); linked = false;
    return { project: next.project, location, session: persistence.getSession() };
  });
  const deps: Parameters<typeof reloadProjectSource>[1] = { persistence, assertWindowCurrent: () => undefined,
    assertReadable: async (selected, assertCurrent) => { await source.assertReadable(folder, assertCurrent); return selected; }, activate };
  const request = (project = selection.project) => ({ project, context: { ...context }, snapshotRevision: 7, transition: persistence.beginTransition(context) });
  const reveal = vi.fn();
  const detach = () => { context = { ...context, documentSessionId: randomUUID() }; persistence.contextChanged(true); };
  return { root, folder, legacyFile, selection, persistence, recovery, catalog, source, updates, deps, request, activate, reveal, detach,
    revealDeps: { persistence, reveal, assertWindowCurrent: () => undefined }, get context() { return context; },
    get location() { return location; }, get sourceCommits() { return sourceCommits; }, get linked() { return linked; } };
}

it("reloads external source without writing it, keeps exact local edits in the real catalog, and admits later Save", async () => {
  const f = await fixture(), local = structuredClone(f.selection.project), external = structuredClone(f.selection.project);
  local.paths[0].waypoints[1].y += .125; external.paths[0].waypoints[1].x += .75;
  await autosaveProjectFolder(f.folder, external, projectWorkspacePath(f.folder)); const before = await sourceBytes(f.folder);
  const request = f.request(local), result = await reloadProjectSource(request, f.deps);
  expect(result.status).toBe("reloaded"); if (result.status !== "reloaded") throw new Error(JSON.stringify(result));
  expect(await sourceBytes(f.folder)).toEqual(before); expect(f.sourceCommits).toBe(0); expect(f.updates).toEqual([]);
  expect(result.opened.project.paths[0].waypoints).toEqual(external.paths[0].waypoints);
  expect(result.session.recoveryRecordId).not.toBe(result.kept.storedSnapshot.recordId);
  const kept = await f.recovery.readSnapshot(result.kept.storedSnapshot.recordId);
  expect(canonicalProjectDigest(kept.project)).toBe(canonicalProjectDigest(local)); expect(kept.resolved).toBeUndefined();
  expect((await f.catalog.list()).entries.find(entry => entry.recordId === result.kept.storedSnapshot.recordId)?.receipt).toEqual(result.kept.storedSnapshot);
  const saved = await f.persistence.checkpoint({ context: f.context, snapshotRevision: 8, project: result.opened.project });
  expect(saved.source).toBe("saved"); expect((await f.recovery.readSnapshot(result.kept.storedSnapshot.recordId)).resolved).toBeUndefined();
  expect((await f.catalog.list()).entries.some(entry => entry.recordId === result.kept.storedSnapshot.recordId)).toBe(true);
  f.persistence.endTransition(request.transition);
});

it.each(["deleted", "busy", "invalid"])("keeps confirmed recovery and the old session when source is %s", async kind => {
  const f = await fixture(), before = f.persistence.getSession();
  if (kind === "deleted") await fs.unlink(projectWorkspacePath(f.folder));
  if (kind === "invalid") await fs.writeFile(projectWorkspacePath(f.folder), "{broken");
  const bytes = await sourceBytes(f.folder), release = kind === "busy" ? await f.source.holdExport(f.folder) : undefined;
  try {
    const result = await reloadProjectSource(f.request(), f.deps);
    expect(result).toMatchObject({ status: "not-reloaded", code: kind === "deleted" ? "source-missing" : kind === "busy" ? "source-busy" : "read-failed" });
    if (result.status !== "not-reloaded") throw new Error("Expected failed reload");
    expect(result.kept?.storedSnapshot).toBeDefined(); expect(result.session.latestRecovery).toEqual(result.kept);
    expect(result.session.context).toEqual(before.context); expect(result.session.location).toEqual(before.location);
    expect(f.linked).toBe(true); expect(f.activate).not.toHaveBeenCalled(); expect(await sourceBytes(f.folder)).toEqual(bytes);
  } finally { release?.(); }
});

it.each(["selection", "activation"])("refuses physical folder replacement during %s without changing the session or robot link", async phase => {
  const f = await fixture(), before = f.persistence.getSession(), other = path.join(f.root, "Other");
  await fs.mkdir(other); await autosaveProjectFolder(other, createDemoProject(), null);
  const replace = async () => { await fs.rename(f.folder, path.join(f.root, "Old")); await fs.rename(other, f.folder); };
  f.deps.readSelection = async (selected, options) => {
    if (phase === "selection") await replace();
    const selection = await loadProjectSelection(selected, options);
    if (phase === "activation") await replace();
    return selection;
  };
  const result = await reloadProjectSource(f.request(), f.deps);
  expect(result).toMatchObject({ status: "not-reloaded", code: "folder-changed" });
  expect(f.persistence.getSession().context).toEqual(before.context); expect(f.location).toEqual(before.location);
  expect(f.linked).toBe(true); expect(f.sourceCommits).toBe(0);
});

it("bounds a stalled read and fences its late completion from activation", async () => {
  const f = await fixture(), entered = deferred(), finish = deferred(), late = deferred(); vi.useFakeTimers();
  f.deps.readTimeoutMs = 20;
  f.deps.assertReadable = async (selected, assertCurrent) => {
    entered.resolve(); await finish.promise;
    try { assertCurrent(); return selected; } finally { late.resolve(); }
  };
  const pending = reloadProjectSource(f.request(), f.deps); await entered.promise;
  await vi.advanceTimersByTimeAsync(21);
  expect(await pending).toMatchObject({ status: "not-reloaded", code: "read-timed-out", kept: { kind: "recovery" } });
  finish.resolve(); await late.promise; await Promise.resolve();
  expect(f.activate).not.toHaveBeenCalled(); expect(f.sourceCommits).toBe(0); expect(f.linked).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not misreport post-commit supersession as a retained old session", async () => {
  const f = await fixture(), activate = f.deps.activate;
  f.deps.activate = async (selection, options) => { await activate(selection, options); throw new Error("superseded after commit"); };
  expect(await reloadProjectSource(f.request(), f.deps)).toEqual({ status: "superseded", fact: "Another project is now active" });
  expect(f.linked).toBe(false);
});

it("re-reads the exact admitted legacy file when another legacy source exists in the same folder", async () => {
  const f = await fixture(true), external = structuredClone(f.selection.project), unrelated = createDemoProject();
  external.paths[0].waypoints[1].y += .25; unrelated.paths[0].name = "Unrelated";
  await fs.writeFile(f.legacyFile, JSON.stringify(external)); await fs.writeFile(path.join(f.folder, "Beta.bordeaux"), JSON.stringify(unrelated));
  const before = await sourceBytes(f.folder), result = await reloadProjectSource(f.request(), f.deps);
  expect(result.status).toBe("reloaded"); if (result.status !== "reloaded") throw new Error(JSON.stringify(result));
  expect(result.opened.project.paths[0].waypoints).toEqual(external.paths[0].waypoints);
  expect(f.location.legacyFile).toBe(f.legacyFile); expect(await sourceBytes(f.folder)).toEqual(before);
});

it("follows the existing legacy workspace continuation rule", async () => {
  const f = await fixture(true), external = structuredClone(f.selection.project); external.paths[0].waypoints[1].y += .25;
  await autosaveProjectFolder(f.folder, external, projectWorkspacePath(f.folder), { legacyFile: f.legacyFile });
  const before = await sourceBytes(f.folder), result = await reloadProjectSource(f.request(), f.deps);
  expect(result.status).toBe("reloaded"); if (result.status !== "reloaded") throw new Error(JSON.stringify(result));
  expect(result.opened.project.paths[0].waypoints).toEqual(external.paths[0].waypoints);
  expect(f.location.legacyFile).toBeUndefined(); expect(await sourceBytes(f.folder)).toEqual(before);
});

it("reveals only the regular managed document in the admitted physical folder", async () => {
  const f = await fixture();
  expect(await revealProjectSource(f.context, "Paths/NewPath.path", f.revealDeps)).toEqual({ revealed: true });
  expect(f.reveal).toHaveBeenCalledExactlyOnceWith(path.join(f.folder, "Paths/NewPath.path"));
});

it.each(["/tmp/A.path", "../A.path", "Paths/../A.path", "Paths/A.routine", "Routines/A.path", "Paths/A\\B.path", "Paths/A\0.path"])("refuses an invalid reveal path %j", async file => {
  const f = await fixture();
  expect(await revealProjectSource(f.context, file, f.revealDeps)).toMatchObject({ revealed: false, code: "invalid" });
  expect(f.reveal).not.toHaveBeenCalled();
});

it.each(["parent-link", "file-link", "directory", "missing", "root-replaced"])("refuses reveal of %s", async kind => {
  const f = await fixture(), file = path.join(f.folder, "Paths/NewPath.path"), parent = path.dirname(file);
  if (kind === "parent-link") { await fs.rename(parent, path.join(f.root, "Outside")); await fs.symlink(path.join(f.root, "Outside"), parent); }
  if (kind === "file-link") { await fs.rename(file, path.join(f.root, "Outside.path")); await fs.symlink(path.join(f.root, "Outside.path"), file); }
  if (kind === "directory" || kind === "missing") { await fs.unlink(file); if (kind === "directory") await fs.mkdir(file); }
  if (kind === "root-replaced") { await fs.rename(f.folder, path.join(f.root, "Old")); await fs.mkdir(f.folder); }
  const result = await revealProjectSource(f.context, "Paths/NewPath.path", f.revealDeps);
  expect(result).toMatchObject({ revealed: false, code: kind === "missing" ? "missing" : kind === "root-replaced" ? "folder-changed" : kind === "parent-link" ? "invalid" : "not-file" });
  expect(f.reveal).not.toHaveBeenCalled();
});

it.each(["root", "parent", "canonical", "file"])("rechecks context after the %s reveal await", async phase => {
  const f = await fixture(), context = { ...f.context }, parent = path.join(f.folder, "Paths"), file = path.join(parent, "NewPath.path");
  let once = true;
  if (phase === "canonical") {
    const realpath = fs.realpath.bind(fs);
    vi.spyOn(fs, "realpath").mockImplementation(async (...args) => { const result = await realpath(...args); if (once && String(args[0]) === parent) { once = false; f.detach(); } return result; });
  } else {
    const lstat = fs.lstat.bind(fs), target = phase === "root" ? f.folder : phase === "parent" ? parent : file;
    vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) => { const result = await lstat(...args); if (once && String(args[0]) === target) { once = false; f.detach(); } return result; });
  }
  expect(await revealProjectSource(context, "Paths/NewPath.path", f.revealDeps)).toMatchObject({ revealed: false, code: "stale" });
  expect(f.reveal).not.toHaveBeenCalled();
});

it("checks the initiating native window again after asynchronous file work", async () => {
  const f = await fixture(); let current = true;
  const lstat = fs.lstat.bind(fs);
  vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) => { const result = await lstat(...args); current = false; return result; });
  f.revealDeps.assertWindowCurrent = () => { if (!current) throw new ReloadStale(); };
  expect(await revealProjectSource(f.context, "Paths/NewPath.path", f.revealDeps)).toMatchObject({ revealed: false, code: "stale" });
  expect(f.reveal).not.toHaveBeenCalled();
});

async function actualMainActivation(dependencies: Record<string, unknown>): Promise<Parameters<typeof reloadProjectSource>[1]["activate"]> {
  const text = await fs.readFile(path.resolve("src/electron/main.ts"), "utf8"), ast = ts.createSourceFile("main.ts", text, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "activateProjectSelection")!;
  const sandbox = { ...dependencies, projectFolderIdentity, sameProjectFolder, ProjectActivationFolderChanged, completeProjectActivation };
  vm.runInNewContext(ts.transpileModule(declaration.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, sandbox);
  return (sandbox as unknown as { activateProjectSelection: Parameters<typeof reloadProjectSource>[1]["activate"] }).activateProjectSelection;
}

it("fences a timeout inside actual main activation preflight before any target, session, robot-link or admission commit", async () => {
  const f = await fixture(), entered = deferred(), finish = deferred(), late = deferred();
  const clearLink = vi.fn(), target = vi.fn(), replace = vi.fn(), admit = vi.spyOn(f.persistence, "admitSource");
  f.deps.activate = await actualMainActivation({ projectSources: { assertReadable: async (folder: string, assertCurrent: () => void) => {
    entered.resolve(); await finish.promise;
    try { await f.source.assertReadable(folder, assertCurrent); } finally { late.resolve(); }
  } }, clearLinkedRobotProject: clearLink, activateProjectTarget: target, replaceProjectSession: replace, projectPersistence: f.persistence });
  vi.useFakeTimers(); f.deps.readTimeoutMs = 20;
  const pending = reloadProjectSource(f.request(), f.deps); await entered.promise;
  await vi.advanceTimersByTimeAsync(21);
  expect(await pending).toMatchObject({ status: "not-reloaded", code: "read-timed-out", kept: { kind: "recovery" } });
  finish.resolve(); await late.promise; await Promise.resolve();
  for (const commit of [clearLink, target, replace, admit]) expect(commit).not.toHaveBeenCalled();
  expect(f.sourceCommits).toBe(0); expect(vi.getTimerCount()).toBe(0);
});

it("actual main activation completes Reload while its background recents write remains pending", async () => {
  const f = await fixture(), remember = deferred(), entered = deferred(), clearLink = vi.fn();
  f.deps.activate = await actualMainActivation({ projectSources: f.source, projectPersistence: f.persistence,
    clearLinkedRobotProject: clearLink, activateProjectTarget: () => undefined, replaceProjectSession: f.detach,
    projectContext: () => f.context, projectLocation: () => f.location, projectTargetGeneration: f.context.targetGeneration,
    rememberFile: () => { entered.resolve(); return remember.promise; }, sameProjectContext, console });
  try {
    const pending = reloadProjectSource(f.request(), f.deps); await entered.promise;
    const result = await pending;
    expect(result.status).toBe("reloaded"); expect(clearLink).toHaveBeenCalledOnce();
    if (result.status !== "reloaded") throw new Error(JSON.stringify(result));
    expect(result.session.recoveryRecordId).not.toBe(result.kept.storedSnapshot.recordId);
  } finally { remember.resolve(); }
});

it("refuses to pair an activated model with a newer session after the activation await", async () => {
  const f = await fixture(), activate = f.deps.activate;
  f.deps.activate = async (...args) => { const opened = await activate(...args); f.detach(); return opened; };
  expect(await reloadProjectSource(f.request(), f.deps)).toEqual({ status: "superseded", fact: "Another project is now active" });
});
