import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectPersistence } from "../src/electron/projectPersistence";
import { ProjectSourcePersistence } from "../src/electron/projectSourcePersistence";
import { ProjectRecoveryStore } from "../src/electron/projectRecoveryStore";
import { ProjectDepartureCoordinator } from "../src/electron/projectDeparture";
import { autosaveProjectFolder, openProjectFolder, projectWorkspacePath, ProjectSourceChangedError } from "../src/electron/projectFiles";
import { createDemoProject, buildWaypoints } from "../src/shared/project/defaults";
import { loadProjectSelection } from "../src/electron/projectOpening";
import type { ProjectLocation } from "../src/shared/project/desktopProjects";
import type { ProjectDurabilityContext } from "../src/shared/project/projectDurability";
import type { ProjectPersistenceUpdate } from "../src/shared/project/projectPersistence";

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await Promise.all(directories.splice(0).map(value => fs.rm(value, { recursive: true, force: true }))); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(options: { sourceWrite?: ConstructorParameters<typeof ProjectSourcePersistence>[0]["write"]; recoveryWrite?: ProjectRecoveryStore["writeSnapshot"]; noFolder?: boolean; recoveryTimeoutMs?: number; sourceTimeoutMs?: number; now?: () => number } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-persistence-"))); directories.push(root);
  const sourceFolder = path.join(root, "source"); await fs.mkdir(sourceFolder);
  let context: ProjectDurabilityContext = { windowEpoch: randomUUID(), documentSessionId: randomUUID(), targetGeneration: 1 };
  let location: ProjectLocation = options.noFolder ? { folderPath: null, projectPath: null } : { folderPath: sourceFolder, projectPath: null };
  let dirty = true; const recents: string[] = [], updates: ProjectPersistenceUpdate[] = [], commits: string[] = [];
  const recovery = new ProjectRecoveryStore(path.join(root, "recovery"));
  const source = new ProjectSourcePersistence({ getContext: () => context, write: options.sourceWrite, commit: (_capture, _project, target) => {
    commits.push(target); if (location.projectPath !== target) context = { ...context, targetGeneration: context.targetGeneration + 1 };
    location = { folderPath: path.dirname(target), projectPath: target }; recents.push(location.folderPath!);
    return { context, location };
  } });
  const persistence = new ProjectPersistence({ source, recovery: { writeSnapshot: options.recoveryWrite ?? recovery.writeSnapshot.bind(recovery), readSnapshot: recovery.readSnapshot.bind(recovery) }, getContext: () => context,
    getLocation: () => location, onUpdate: update => updates.push(update), now: options.now, recoveryTimeoutMs: options.recoveryTimeoutMs, sourceTimeoutMs: options.sourceTimeoutMs });
  if (!options.noFolder) persistence.admitSource(context, (await loadProjectSelection(sourceFolder)).sourceEvidence);
  const request = (project = createDemoProject(), requestId?: string) => ({ project, context: { ...context }, snapshotRevision: 4, ...(requestId ? { requestId } : {}) });
  const replace = (next: ProjectLocation, recovered?: Parameters<ProjectPersistence["contextChanged"]>[1]) => {
    context = { ...context, documentSessionId: randomUUID(), targetGeneration: context.targetGeneration + 1 }; location = next; persistence.contextChanged(true, recovered); dirty = true;
  };
  return { root, sourceFolder, source, persistence, recovery, updates, recents, commits, request, replace, get context() { return context; }, get location() { return location; }, get dirty() { return dirty; } };
}

describe("project checkpoint source/recovery boundaries", () => {
  it.each(["opened", "saved"])("preserves a replacement folder when the %s source directory disappears, and permits Save As elsewhere", async admittedBy => {
    const f = await fixture(), original = createDemoProject(), unrelated = createDemoProject();
    original.paths[0].name = "Original A"; unrelated.paths[0].name = "Unrelated B";
    if (admittedBy === "opened") {
      await autosaveProjectFolder(f.sourceFolder, original, null);
      f.replace({ folderPath: f.sourceFolder, projectPath: projectWorkspacePath(f.sourceFolder) });
      f.persistence.admitSource(f.context, (await loadProjectSelection(f.sourceFolder)).sourceEvidence);
    } else expect((await f.persistence.checkpoint(f.request(original))).source).toBe("saved");
    const other = path.join(f.root, "other"), copy = path.join(f.root, "copy");
    await fs.mkdir(other); await fs.mkdir(copy); await autosaveProjectFolder(other, unrelated, null);
    const replacementBefore = await fs.readFile(projectWorkspacePath(other), "utf8");
    await fs.rename(f.sourceFolder, path.join(f.root, "archive")); await fs.rename(other, f.sourceFolder);
    original.paths[0].name = "Unsaved A edit";
    expect(await f.persistence.checkpoint(f.request(original))).toMatchObject({ recovery: "saved", source: "failed", sourceFact: expect.stringContaining("folder changed") });
    expect(await fs.readFile(projectWorkspacePath(f.sourceFolder), "utf8")).toBe(replacementBefore);
    expect((await f.recovery.readSnapshot(f.persistence.getSession().recoveryRecordId)).project.paths[0].name).toBe("Unsaved A edit");
    const request = f.request(original);
    expect(await f.persistence.saveWithExport(request, { folderPath: copy, projectPath: null }, f.persistence.captureRequest(request), async saved => ({ saved: true, location: saved.location, bdxCount: 0 }))).toMatchObject({ saved: true });
    expect((await openProjectFolder(copy)).project?.paths[0].name).toBe("Unsaved A edit");
    expect(await fs.readFile(projectWorkspacePath(f.sourceFolder), "utf8")).toBe(replacementBefore);
  });

  it("emits exact recovery before source, keeps independent receipts and canonical saved source", async () => {
    const f = await fixture(), project = createDemoProject(); project.paths[0].name = "Captured edit";
    const pending = f.persistence.checkpoint(f.request(project)); project.paths[0].name = "Late edit";
    const result = await pending;
    expect(result).toMatchObject({ mode: "background", recovery: "saved", source: "saved", canonicalProject: { name: "source" } });
    const recoveryEvent = f.updates.findIndex(update => update.recovery === "saved");
    expect(f.updates[recoveryEvent].source).toBe("pending"); expect(f.updates.findIndex(update => update.source === "saved")).toBeGreaterThan(recoveryEvent);
    expect(f.persistence.getSession().latestSource?.digest).toBe(result.sourceReceipt?.digest);
    expect(f.persistence.getSession().latestRecovery?.capturedAt).toBe(result.recoveryReceipt?.capturedAt);
    expect((await f.recovery.readSnapshot(f.persistence.getSession().recoveryRecordId)).project.paths[0].name).toBe("Captured edit");
    expect((await openProjectFolder(f.sourceFolder)).project?.paths[0].name).toBe("Captured edit");
    expect(f.dirty).toBe(true); expect(f.recents).toEqual([f.sourceFolder]); expect(await fs.readdir(path.join(f.root, "recovery"))).toHaveLength(1);
    const replay = f.persistence.replay(f.context, result.operationId)!; replay.sourceFact = "caller mutation";
    expect(f.persistence.replay(f.context, result.operationId)?.sourceFact).toBeUndefined();
  });

  it("keeps real recovery when source fails, and still saves source when recovery fails", async () => {
    const failedSource = await fixture({ sourceWrite: async () => { throw Object.assign(new Error("source fixture denied"), { code: "EACCES" }); } });
    const sourceResult = await failedSource.persistence.checkpoint(failedSource.request());
    expect(sourceResult).toMatchObject({ recovery: "saved", source: "failed", sourceFact: expect.stringContaining("read-only") });
    expect((await failedSource.recovery.listSnapshots()).entries[0].status).toBe("available"); expect(failedSource.commits).toEqual([]);
    const failedRecovery = await fixture({ recoveryWrite: async () => { throw new Error("Recovery storage is unavailable"); } });
    expect(await failedRecovery.persistence.checkpoint(failedRecovery.request())).toMatchObject({ recovery: "failed", source: "saved" });
    expect((await openProjectFolder(failedRecovery.sourceFolder)).project).not.toBeNull();
  });

  it("bounds a hung recovery pre-phase without preventing a healthy source, and ignores its late completion", async () => {
    vi.useFakeTimers(); const gate = deferred(), physicallyFinished = deferred(); let store!: ProjectRecoveryStore;
    const f = await fixture({ recoveryTimeoutMs: 20, recoveryWrite: async value => { await gate.promise; try { return await store.writeSnapshot(value); } finally { physicallyFinished.resolve(); } } }); store = f.recovery;
    const pending = f.persistence.checkpoint(f.request()); await vi.advanceTimersByTimeAsync(21);
    const result = await pending;
    expect(result).toMatchObject({ recovery: "failed", source: "saved" }); expect(f.persistence.getSession().latestRecovery).toBeUndefined();
    const count = f.updates.length; gate.resolve(); await physicallyFinished.promise; await Promise.resolve();
    expect(f.updates).toHaveLength(count); expect(f.persistence.getSession().latestRecovery).toBeUndefined();
  });

  it("uses immutable main metadata for idempotent retries and never accepts stored:false", async () => {
    const f = await fixture({ noFolder: true }), project = createDemoProject();
    const first = await f.persistence.checkpoint(f.request(project)), second = await f.persistence.checkpoint(f.request(project));
    expect(second.recovery).toBe("saved"); expect(second.recoveryReceipt?.storedSnapshot).toEqual(first.recoveryReceipt?.storedSnapshot);
    expect(second.recoveryReceipt?.capturedAt).toBe(first.recoveryReceipt?.capturedAt); expect((await f.recovery.listSnapshots()).entries).toHaveLength(1);
    const notStored = await fixture({ noFolder: true, recoveryWrite: async value => ({ recordId: value.recordId, revision: value.revision, digest: "0".repeat(64), capturedAt: value.capturedAt, stored: false, written: false, supersededByRevision: value.revision + 1 }) });
    expect(await notStored.persistence.checkpoint(notStored.request())).toMatchObject({ recovery: "failed", source: "unavailable" });
    expect(notStored.persistence.getSession().latestRecovery).toBeUndefined();
  });

  it("rejects stale context/window and unattached or nonexistent departure nonces", async () => {
    const f = await fixture(), old = f.request(); f.replace({ folderPath: null, projectPath: null });
    expect(() => f.persistence.checkpoint(old)).toThrow("context");
    expect(() => f.persistence.checkpoint({ ...f.request(), context: { ...f.context, windowEpoch: randomUUID() } })).toThrow("context");
    expect(() => f.persistence.checkpoint(f.request(createDemoProject(), "fake-nonce"))).toThrow("not attached");
    expect((await f.recovery.listSnapshots()).entries).toHaveLength(0);
  });

  it("publishes source completion before an automatic BDX export that remains pending, while blocking same-folder writes", async () => {
    const f = await fixture(), gate = deferred(), exporting = deferred(), request = f.request(), capture = f.persistence.captureRequest(request);
    let finished = false;
    const saved = f.persistence.saveWithExport(request, { folderPath: f.sourceFolder, projectPath: null }, capture, async result => {
      expect(result.source).toBe("saved"); exporting.resolve(); await gate.promise; return { saved: true, location: result.location, bdxCount: 2 };
    }).then(value => { finished = true; return value; });
    await exporting.promise; expect(f.updates.at(-1)?.source).toBe("saved"); expect(finished).toBe(false);
    expect(await f.source.isBusy(f.sourceFolder)).toBe(true);
    const unchanged = await f.persistence.checkpoint(f.request(request.project));
    expect(unchanged).toMatchObject({ source: "saved", recovery: "saved", canonicalProject: { name: "source" } });
    expect(f.commits).toHaveLength(1); expect(finished).toBe(false);
    expect(await f.persistence.checkpoint(f.request())).toMatchObject({ recovery: "saved", source: "failed", sourceFact: "Folder is busy" });
    const external = (await openProjectFolder(f.sourceFolder)).project!; external.paths[0].name = "External source edit";
    await autosaveProjectFolder(f.sourceFolder, external, f.location.projectPath);
    expect(await f.persistence.checkpoint(f.request(request.project))).toMatchObject({ recovery: "saved", source: "failed" });
    expect((await openProjectFolder(f.sourceFolder)).project?.paths[0].name).toBe("External source edit");
    gate.resolve(); expect(await saved).toMatchObject({ saved: true, bdxCount: 2 }); expect(await f.source.isBusy(f.sourceFolder)).toBe(false);
  });

  it("preserves authored infeasible and empty geometry without invoking an export planner", async () => {
    const f = await fixture(), project = createDemoProject();
    project.paths[0].waypoints = buildWaypoints([{ x: 2, y: 2, segType: "line" }, { x: 7, y: 2 }]); project.paths[0].startVel = 4;
    project.paths[0].ranges = [{ anchor: "param", f0: 0.02, f1: 0.3, maxVel: 0.5 }];
    expect(await f.persistence.checkpoint(f.request(project))).toMatchObject({ source: "saved", recovery: "saved" });
    expect((await openProjectFolder(f.sourceFolder)).project?.paths[0].startVel).toBe(4);
    project.paths[0].waypoints = []; project.paths[0].ranges = [];
    expect(await f.persistence.checkpoint(f.request(project))).toMatchObject({ source: "saved", recovery: "saved" });
    expect((await openProjectFolder(f.sourceFolder)).project?.paths[0].waypoints).toEqual([]);
  });

  it("issues a fresh request-backed proof of unchanged source while BDX is pending", async () => {
    const f = await fixture(), gate = deferred(), exporting = deferred(), request = f.request();
    const fullSave = f.persistence.saveWithExport(request, { folderPath: f.sourceFolder, projectPath: null }, f.persistence.captureRequest(request), async saved => {
      exporting.resolve(); await gate.promise; return { saved: true, location: saved.location, bdxCount: 1 };
    });
    await exporting.promise;
    const continued: unknown[] = [], coordinator = new ProjectDepartureCoordinator({ getContext: () => f.context, isRendererAlive: () => true,
      isTrustedSender: sender => sender === "trusted", getTransitionId: () => null, onRequest: () => undefined, onCheckpoint: update => f.persistence.handleDepartureUpdate(update),
      onCancelled: id => f.persistence.handleDepartureCancelled(id), onFallback: () => undefined, onDismissFallback: () => undefined, onContinue: permit => continued.push(permit), onReopen: () => undefined });
    f.persistence.attachDepartureCoordinator(coordinator); const intent = coordinator.request("close")!;
    const result = await f.persistence.checkpoint(f.request(request.project, intent.requestId));
    expect(result).toMatchObject({ mode: "departure", source: "saved", recovery: "saved" });
    if (result.mode !== "departure") throw new Error("Wrong receipt scope");
    expect(result.sourceReceipt?.requestId).toBe(intent.requestId); expect(f.commits).toHaveLength(1);
    expect(coordinator.respond("trusted", { requestId: intent.requestId, context: f.context, outcome: "saved", receiptId: result.sourceReceipt!.receiptId,
      operationId: result.operationId, snapshotRevision: 4 })).toBe(true);
    expect(continued).toHaveLength(1); gate.resolve(); await fullSave; coordinator.editingResumed(f.context.windowEpoch);
  });

  it("fences older background identity admission before a newer real departure saves at the unchanged target generation", async () => {
    const f = await fixture(), project = createDemoProject(); await f.persistence.checkpoint(f.request(project));
    const entered = deferred(), release = deferred(), resolved = deferred(), realpath = fs.realpath.bind(fs); let first = true;
    vi.spyOn(fs, "realpath").mockImplementation(async (...args: any[]) => {
      const actual = await (realpath as any)(...args);
      if (String(args[0]) === f.sourceFolder && first) { first = false; entered.resolve(); await release.promise; resolved.resolve(); }
      return actual;
    });
    const older = structuredClone(project); older.paths[0].name = "Old admission";
    const background = f.persistence.checkpoint(f.request(older)); await entered.promise;
    const context = { ...f.context }, coordinator = new ProjectDepartureCoordinator({ getContext: () => f.context, isRendererAlive: () => true,
      isTrustedSender: sender => sender === "trusted", getTransitionId: () => null, onRequest: () => undefined, onCheckpoint: update => f.persistence.handleDepartureUpdate(update),
      onCancelled: id => f.persistence.handleDepartureCancelled(id), onFallback: () => undefined, onDismissFallback: () => undefined, onContinue: () => undefined, onReopen: () => undefined });
    f.persistence.attachDepartureCoordinator(coordinator);
    // A nonexistent nonce must not interrupt the admitted background operation.
    expect(() => f.persistence.checkpoint(f.request(project, "nonexistent"))).toThrow("no longer active");
    expect(f.updates.at(-1)?.source).toBe("pending");
    const intent = coordinator.request("close")!, newer = structuredClone(project); newer.paths[0].name = "New source";
    const saved = await f.persistence.checkpoint(f.request(newer, intent.requestId));
    expect(await background).toMatchObject({ source: "failed", sourceFact: "Saving was interrupted by the project checkpoint" });
    expect(saved).toMatchObject({ mode: "departure", source: "saved" }); expect(f.context).toEqual(context);
    expect(() => f.persistence.checkpoint(f.request(older))).toThrow("already running");
    const commits = f.commits.length, events = f.updates.length;
    release.resolve(); await resolved.promise; await Promise.resolve(); await f.source.whenSettled(f.sourceFolder);
    expect(f.commits).toHaveLength(commits); expect(f.updates).toHaveLength(events);
    expect((await openProjectFolder(f.sourceFolder)).project?.paths[0].name).toBe("New source"); coordinator.editingResumed(f.context.windowEpoch);
  });

  it("restores only a prepared detached copy, refuses even a recreated empty origin and leaves failed reads untouched", async () => {
    const f = await fixture(), result = await f.persistence.checkpoint(f.request()), session = f.persistence.getSession();
    await expect(f.persistence.prepareRestore(f.context, randomUUID())).rejects.toMatchObject({ code: "missing" });
    expect(f.persistence.getSession()).toEqual(session);
    const prepared = await f.persistence.prepareRestore(f.context, result.recoveryReceipt!.storedSnapshot!.recordId);
    f.replace({ folderPath: null, projectPath: null }, prepared.recoveredFrom);
    expect(f.persistence.getSession().recoveryRecordId).not.toBe(prepared.recoveredFrom.receipt.recordId);
    expect(f.persistence.getSession().location).toEqual({ folderPath: null, projectPath: null });
    await fs.rm(f.sourceFolder, { recursive: true }); await fs.mkdir(f.sourceFolder);
    await expect(f.persistence.assertDestination(f.sourceFolder)).rejects.toThrow("different folder");
    const aliasParent = path.join(f.root, "alias"); await fs.symlink(f.root, aliasParent, process.platform === "win32" ? "junction" : "dir");
    await expect(f.persistence.assertDestination(path.join(aliasParent, "source"))).rejects.toThrow("different folder");
    const allowed = path.join(f.root, "copy"); await fs.mkdir(allowed); await fs.rm(f.sourceFolder, { recursive: true });
    await expect(f.persistence.assertDestination(allowed)).resolves.toBeUndefined();
    await fs.mkdir(f.sourceFolder);
    await expect(f.persistence.assertDestination(path.join(aliasParent, "source"))).rejects.toThrow("different folder");
    expect((await f.recovery.listSnapshots()).entries).toHaveLength(1); expect(f.dirty).toBe(true);
  });

  it("retains legacy provenance for real migration and advances target without replacing the logical session", async () => {
    const f = await fixture(), legacy = path.join(f.sourceFolder, "Autos.bordeaux.json"), project = createDemoProject();
    await fs.writeFile(legacy, JSON.stringify(project)); const selected = await loadProjectSelection(legacy);
    f.replace({ folderPath: selected.folderPath, projectPath: selected.projectPath, legacyFile: selected.legacyFile! });
    f.persistence.admitSource(f.context, selected.sourceEvidence, selected.legacyFile);
    const session = f.persistence.getSession();
    expect(await f.persistence.checkpoint(f.request(selected.project))).toMatchObject({ source: "saved", recovery: "saved" });
    expect(f.persistence.getSession().context.documentSessionId).toBe(session.context.documentSessionId);
    expect(f.persistence.getSession().context.targetGeneration).toBeGreaterThan(session.context.targetGeneration);
    expect((await f.recovery.readSnapshot(session.recoveryRecordId)).origin).toMatchObject({ kind: "legacy", legacyFile: legacy });
    expect(f.location).toEqual({ folderPath: f.sourceFolder, projectPath: projectWorkspacePath(f.sourceFolder) });
  });

  it("saves a detached recovery elsewhere, tracks only exact in-memory resolution, and retains both records", async () => {
    const f = await fixture(), first = await f.persistence.checkpoint(f.request());
    const prepared = await f.persistence.prepareRestore(f.context, first.recoveryReceipt!.storedSnapshot!.recordId);
    f.replace({ folderPath: null, projectPath: null }, prepared.recoveredFrom);
    const restoredSession = f.persistence.getSession(), copyFolder = path.join(f.root, "copy"); await fs.mkdir(copyFolder);
    const saved = await f.persistence.checkpoint(f.request(prepared.project), { folderPath: copyFolder, projectPath: null, createProject: true });
    expect(saved).toMatchObject({ source: "saved", recovery: "saved", location: { folderPath: copyFolder } });
    const session = f.persistence.getSession(); expect(session.context.documentSessionId).toBe(restoredSession.context.documentSessionId);
    expect(session.recoveredFrom).toBeUndefined(); expect(session.sourceResolution?.savedDigest).toBe(saved.sourceReceipt?.digest);
    expect(session.sourceResolution?.inputDigest).toBe(prepared.recoveredFrom.receipt.digest);
    expect(session.sourceResolution?.recoveries.map(receipt => receipt.recordId).sort()).toEqual([restoredSession.recoveryRecordId, prepared.recoveredFrom.receipt.recordId].sort());
    expect((await f.recovery.listSnapshots()).entries).toHaveLength(2); expect((await openProjectFolder(copyFolder)).project?.name).toBe("copy");
  });

  it("keeps overlapping background captures bounded and cancellation fences before terminal publication", async () => {
    vi.useFakeTimers(); const gate = deferred(), f = await fixture({ recoveryWrite: async () => { await gate.promise; throw new Error("late failed recovery"); } });
    const pending = f.persistence.checkpoint(f.request()), first = f.updates[0];
    expect(() => f.persistence.checkpoint(f.request())).toThrow("already running");
    expect(f.persistence.cancel(f.context, first.operationId)).toBe(true);
    expect(await pending).toMatchObject({ source: "failed", sourceFact: "Saving was cancelled" });
    gate.resolve(); await vi.advanceTimersByTimeAsync(30); expect(f.commits).toEqual([]); expect(f.recents).toEqual([]);
    expect(f.persistence.getSession().latestSource).toBeUndefined(); expect(f.source.pendingWrites()).toEqual([]);
  });

  it("keeps Save As/new-session target, recents and dirty intact when an expired legacy autosave physically completes late", async () => {
    vi.useFakeTimers(); const started = deferred(), finish = deferred(); let oldFolder = "";
    const f = await fixture({ sourceTimeoutMs: 30, sourceWrite: async (folder, project, target, options) => {
      options.assertCurrent();
      if (folder === oldFolder) { started.resolve(); await finish.promise; }
      // Models already-entered filesystem work: revocation cannot cancel its remaining captured effects.
      return autosaveProjectFolder(folder, project, target, { legacyFile: options.legacyFile, createProject: options.createProject, sourceOwner: options.sourceOwner });
    } }); oldFolder = f.sourceFolder;
    const legacy = path.join(oldFolder, "A.bordeaux.json"), original = createDemoProject(); original.paths[0].name = "Old A";
    await fs.writeFile(legacy, JSON.stringify(original)); const selected = await loadProjectSelection(legacy);
    f.replace({ folderPath: oldFolder, projectPath: selected.projectPath, legacyFile: legacy });
    f.persistence.admitSource(f.context, selected.sourceEvidence, selected.legacyFile);
    const old = f.persistence.checkpoint(f.request(selected.project)); await started.promise;
    await vi.advanceTimersByTimeAsync(31); expect((await old).source).not.toBe("saved");
    const copy = path.join(f.root, "B"); await fs.mkdir(copy);
    const edited = structuredClone(selected.project); edited.paths[0].name = "Saved B";
    expect(await f.persistence.checkpoint(f.request(edited), { folderPath: copy, projectPath: null, createProject: true })).toMatchObject({ source: "saved" });
    f.replace({ folderPath: copy, projectPath: projectWorkspacePath(copy) });
    const active = f.persistence.getSession(), events = f.updates.length;
    finish.resolve(); await f.source.whenSettled(oldFolder);
    expect(f.persistence.getSession()).toEqual(active); expect(f.location.folderPath).toBe(copy); expect(f.recents).toEqual([copy]); expect(f.dirty).toBe(true);
    expect(f.updates).toHaveLength(events); expect((await openProjectFolder(copy)).project?.paths[0].name).toBe("Saved B");
    expect((await openProjectFolder(oldFolder)).project?.paths[0].name).toBe("Old A"); expect(f.commits).toEqual([projectWorkspacePath(copy)]);
  });

  it("attaches real coordinator admission, fences before timeout result, and cannot approve from a background receipt", async () => {
    vi.useFakeTimers(); const started = deferred(), finish = deferred();
    const f = await fixture({ sourceWrite: async (folder, project, target, options) => { options.assertCurrent(); started.resolve(); await finish.promise; return autosaveProjectFolder(folder, project, target, { sourceOwner: options.sourceOwner }); } });
    const continued: unknown[] = [], coordinator = new ProjectDepartureCoordinator({ getContext: () => f.context, isRendererAlive: () => true, isTrustedSender: sender => sender === "trusted", getTransitionId: () => null,
      onRequest: () => undefined, onCheckpoint: update => f.persistence.handleDepartureUpdate(update), onCancelled: id => f.persistence.handleDepartureCancelled(id), onFallback: () => undefined,
      onDismissFallback: () => undefined, onContinue: permit => continued.push(permit), onReopen: () => undefined, timeoutMs: 10 });
    f.persistence.attachDepartureCoordinator(coordinator); const intent = coordinator.request("close")!;
    const pending = f.persistence.checkpoint(f.request(createDemoProject(), intent.requestId)); await started.promise;
    expect(f.updates.at(-1)).toMatchObject({ mode: "departure", recovery: "saved", source: "pending" });
    await vi.advanceTimersByTimeAsync(11); const result = await pending;
    expect(result).toMatchObject({ mode: "departure", recovery: "saved", source: "timed-out" });
    expect(await f.source.isBusy(f.sourceFolder)).toBe(true); expect(f.commits).toEqual([]); expect(f.recents).toEqual([]); expect(f.dirty).toBe(true);
    expect(coordinator.respond("trusted", { requestId: intent.requestId, context: f.context, outcome: "saved", receiptId: "background-fact", operationId: result.operationId, snapshotRevision: 4 })).toBe(false);
    finish.resolve(); await f.source.whenSettled(f.sourceFolder); expect(f.commits).toEqual([]); expect(continued).toEqual([]);
    coordinator.editingResumed(f.context.windowEpoch);
  });

  it("issues a request-backed source receipt after its own migration and accepts only the trusted exact response", async () => {
    const f = await fixture(), continued: unknown[] = [], coordinator = new ProjectDepartureCoordinator({ getContext: () => f.context, isRendererAlive: () => true,
      isTrustedSender: sender => sender === "trusted", getTransitionId: () => null, onRequest: () => undefined, onCheckpoint: update => f.persistence.handleDepartureUpdate(update),
      onCancelled: id => f.persistence.handleDepartureCancelled(id), onFallback: () => undefined, onDismissFallback: () => undefined, onContinue: permit => continued.push(permit), onReopen: () => undefined });
    f.persistence.attachDepartureCoordinator(coordinator); const intent = coordinator.request("close")!, result = await f.persistence.checkpoint(f.request(createDemoProject(), intent.requestId));
    expect(result.mode).toBe("departure"); if (result.mode !== "departure") throw new Error("Wrong receipt scope");
    expect(result.sourceReceipt?.context).toEqual(f.context);
    const response = { requestId: intent.requestId, context: f.context, outcome: "saved" as const, receiptId: result.sourceReceipt!.receiptId, operationId: result.operationId, snapshotRevision: 4 };
    expect(coordinator.respond("untrusted", response)).toBe(false); expect(coordinator.respond("trusted", response)).toBe(true); expect(continued).toHaveLength(1);
    coordinator.editingResumed(f.context.windowEpoch);
  });
});

// The main process sends typed refusals as data; ordinary or look-alike errors remain generic.
it.each([
  [new ProjectSourceChangedError("workspace"), { scope: "workspace" }],
  [new ProjectSourceChangedError("document", "Paths/A.path"), { scope: "document", file: "Paths/A.path" }],
  [new ProjectSourceChangedError("document", "Routines/A.routine"), { scope: "document", file: "Routines/A.routine" }],
  [new ProjectSourceChangedError("document", "Paths/A.routine"), { scope: "document" }],
  [new ProjectSourceChangedError("document", "../A.path"), { scope: "document" }],
  [new ProjectSourceChangedError("document", "/tmp/Paths/A.path"), { scope: "document" }],
  [new Error("A.path changed outside Bordeaux while saving"), undefined],
  [Object.assign(new Error("look-alike"), { code: "PROJECT_SOURCE_CHANGED", scope: "workspace" }), undefined],
] as const)("carries only main-owned typed source refusal %#", async (error, expected) => {
  const f = await fixture({ sourceWrite: async () => { throw error; } });
  const result = await f.persistence.checkpoint(f.request());
  expect(result.source).toBe("failed"); expect(result.recovery).toBe("saved");
  expect(result.sourceChange).toEqual(expected);
  expect(f.persistence.replay(f.context, result.operationId)?.sourceChange).toEqual(expected);
  if (result.sourceChange) result.sourceChange.scope = "workspace";
  expect(f.updates.at(-1)?.sourceChange).toEqual(expected);
});

it("carries a typed main refusal through a real departure coordinator without granting a source receipt", async () => {
  const error = new ProjectSourceChangedError("workspace"), f = await fixture({ sourceWrite: async () => { throw error; } });
  const coordinator = new ProjectDepartureCoordinator({ getContext: () => f.context, isRendererAlive: () => true,
    isTrustedSender: () => true, getTransitionId: () => null, onRequest: () => undefined,
    onCheckpoint: update => f.persistence.handleDepartureUpdate(update), onCancelled: id => f.persistence.handleDepartureCancelled(id),
    onFallback: () => undefined, onDismissFallback: () => undefined, onContinue: () => undefined, onReopen: () => undefined });
  f.persistence.attachDepartureCoordinator(coordinator);
  const departure = coordinator.request("close")!;
  try {
    const result = await f.persistence.checkpoint(f.request(createDemoProject(), departure.requestId));
    expect(result).toMatchObject({ mode: "departure", source: "failed", recovery: "saved", sourceChange: { scope: "workspace" }, sourceFact: error.message });
    expect(result.sourceReceipt).toBeUndefined(); expect(coordinator.snapshot().checkpoint?.sourceChange).toEqual({ scope: "workspace" });
  } finally { coordinator.editingResumed(f.context.windowEpoch); }
});

it.each(["cancel", "replace"])("does not publish after %s at the shared recovery return boundary", async event => {
  let queued = false;
  const f = await fixture({ now: () => {
    if (!queued) {
      queued = true;
      queueMicrotask(() => event === "cancel"
        ? f.persistence.cancel(f.context, f.updates[0].operationId)
        : f.replace({ folderPath: null, projectPath: null }));
    }
    return Date.now();
  } });
  const result = await f.persistence.checkpoint(f.request()); await Promise.resolve();
  expect(result.source).toBe("failed");
  expect(f.updates.filter(update => update.recovery === "saved")).toEqual([]);
  expect(f.updates).toHaveLength(2); expect(f.updates.at(-1)?.source).toBe("failed");
  expect(f.commits).toEqual([]);
  if (event === "replace") expect(f.persistence.replay(f.context, result.operationId)).toBeNull();
});

describe("named copy required physical owner", () => {
  async function claim(f: Awaited<ReturnType<typeof fixture>>, name: string) {
    const { createProjectCopyFolder } = await import("../src/electron/projectCreation");
    const request = f.request(), capture = f.persistence.captureRequest(request), mark = { creating: false, created: false };
    const guard = () => f.source.assertCurrent(capture);
    const made = await createProjectCopyFolder({ name, parentDirectory: f.root }, { mark, assertCurrent: guard, allowExisting: folder => f.persistence.pendingDestinationFor(folder, guard) });
    if (!("created" in made)) throw new Error("Expected exclusive creation");
    const owner = await f.persistence.claimCreatedDestination(capture, made.created, guard, mark);
    return { request, capture, owner, folder: made.created.child.folderPath };
  }
  it.each(["before-run", "during-recovery"])("never installs a fresh owner for a replacement %s", async stage => {
    const gate = deferred(), entered = deferred();
    let real!: ProjectRecoveryStore;
    const f = await fixture(stage === "during-recovery" ? { recoveryWrite: async (...args) => { entered.resolve(); await gate.promise; return real.writeSnapshot(...args); } } : {}); real = f.recovery;
    const a = await claim(f, "A");
    const replace = async () => { await fs.rename(a.folder, `${a.folder}-original`); await fs.mkdir(a.folder); };
    if (stage === "before-run") await replace();
    const pending = f.persistence.checkpoint(a.request, { folderPath: a.folder, projectPath: null, createProject: true, requiredOwner: a.owner }, a.capture);
    if (stage === "during-recovery") { await entered.promise; await replace(); gate.resolve(); }
    expect(await pending).toMatchObject({ source: "failed", sourceFact: expect.stringContaining("Choose another name") });
    expect(await fs.readdir(a.folder)).toEqual([]);
    expect(f.persistence.ownsPendingDestination(a.owner)).toBe(true);
    expect(await f.persistence.pendingDestinationFor(a.folder)).toBeNull();
    expect(f.commits).toEqual([]);
  });
  it("cannot replace the single pending slot while a checkpoint is active", async () => {
    const entered = deferred(), gate = deferred(); let real!: ProjectRecoveryStore;
    const f = await fixture({ recoveryWrite: async (...args) => { entered.resolve(); await gate.promise; return real.writeSnapshot(...args); } }); real = f.recovery;
    const a = await claim(f, "A");
    const pending = f.persistence.checkpoint(a.request, { folderPath: a.folder, projectPath: null, requiredOwner: a.owner }, a.capture);
    await entered.promise;
    await expect(claim(f, "B")).rejects.toThrow("already running");
    expect(f.persistence.ownsPendingDestination(a.owner)).toBe(true);
    expect(await fs.readdir(path.join(f.root, "B"))).toEqual([]);
    gate.resolve(); expect((await pending).source).toBe("saved");
  });
  it("keeps exact same-name retry after source failure, without claiming twice", async () => {
    let denied = true;
    const f = await fixture({ sourceWrite: async (...args) => { if (denied) throw new Error("Injected source failure"); return autosaveProjectFolder(...args); } });
    const a = await claim(f, "A");
    const first = await f.persistence.checkpoint(a.request, { folderPath: a.folder, projectPath: null, requiredOwner: a.owner }, a.capture);
    expect(first).toMatchObject({ source: "failed", recovery: "saved" });
    expect((await f.recovery.readSnapshot(f.persistence.getSession().recoveryRecordId)).project).toEqual(a.request.project);
    expect(await f.persistence.pendingDestinationFor(a.folder)).toBe(a.owner);
    const spy = vi.spyOn(f.persistence, "claimCreatedDestination");
    const { createProjectCopyFolder } = await import("../src/electron/projectCreation");
    const request = f.request(), capture = f.persistence.captureRequest(request), guard = () => f.source.assertCurrent(capture);
    const retry = await createProjectCopyFolder({ name: "A", parentDirectory: f.root }, { mark: { creating: false, created: false }, assertCurrent: guard, allowExisting: folder => f.persistence.pendingDestinationFor(folder, guard) });
    expect(retry).toEqual({ existing: a.owner }); denied = false;
    expect((await f.persistence.checkpoint(request, { folderPath: a.folder, projectPath: null, requiredOwner: a.owner }, capture)).source).toBe("saved");
    expect(spy).not.toHaveBeenCalled(); expect(await f.persistence.pendingDestinationFor(a.folder)).toBeNull();
  });
  it("a later settled claim retires the old retry slot; requiredOwner cannot bypass it", async () => {
    const f = await fixture(), a = await claim(f, "A"), b = await claim(f, "B");
    expect(f.persistence.ownsPendingDestination(a.owner)).toBe(false); expect(f.persistence.ownsPendingDestination(b.owner)).toBe(true);
    expect(() => f.persistence.checkpoint(a.request, { folderPath: a.folder, projectPath: null, requiredOwner: a.owner }, a.capture)).toThrow("Choose another name");
    expect(await fs.readdir(a.folder)).toEqual([]); expect(f.persistence.getSession().latestRecovery).toBeUndefined();
    f.source.revoke(b.capture);
  });
  it.each(["replacement", "nonempty", "document"])("does not register a newly observed child after %s", async change => {
    const { createProjectCopyFolder } = await import("../src/electron/projectCreation");
    const f = await fixture(), request = f.request(), capture = f.persistence.captureRequest(request), mark = { creating: false, created: false };
    const guard = () => f.source.assertCurrent(capture);
    const made = await createProjectCopyFolder({ name: "A", parentDirectory: f.root }, { mark, assertCurrent: guard, allowExisting: async () => null });
    if (!("created" in made)) throw new Error("Expected new child");
    const folder = made.created.child.folderPath;
    if (change === "replacement") { await fs.rename(folder, `${folder}-old`); await fs.mkdir(folder); }
    if (change === "nonempty") await fs.writeFile(path.join(folder, "foreign.txt"), "keep");
    if (change === "document") f.replace({ folderPath: null, projectPath: null });
    await expect(f.persistence.claimCreatedDestination(capture, made.created, guard, mark)).rejects.toThrow();
    expect(await f.persistence.pendingDestinationFor(folder)).toBeNull(); expect(f.commits).toEqual([]);
    if (change === "nonempty") expect(await fs.readFile(path.join(folder, "foreign.txt"), "utf8")).toBe("keep");
    f.source.revoke(capture);
  });
});
