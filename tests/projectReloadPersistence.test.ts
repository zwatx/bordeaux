import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectPersistence, ReloadStale, type ReloadHandle } from "../src/electron/projectPersistence";
import { ProjectSourcePersistence, canonicalProjectDigest } from "../src/electron/projectSourcePersistence";
import { MAX_RECOVERY_RECORDS, ProjectRecoveryStore, RecoveryStoreError } from "../src/electron/projectRecoveryStore";
import { ProjectDepartureCoordinator } from "../src/electron/projectDeparture";
import { autosaveProjectFolder, projectWorkspacePath } from "../src/electron/projectFiles";
import { loadProjectSelection } from "../src/electron/projectOpening";
import { createDemoProject } from "../src/shared/project/defaults";
import type { ProjectDurabilityContext } from "../src/shared/project/projectDurability";
import type { ProjectLocation } from "../src/shared/project/desktopProjects";
import type { ProjectPersistenceUpdate, ProjectReloadRequest } from "../src/shared/project/projectPersistence";

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(options: { admitted?: boolean; recovered?: boolean; noFolder?: boolean; write?: ProjectRecoveryStore["writeSnapshot"]; timeout?: number } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-reload-core-"))); directories.push(root);
  const folder = path.join(root, "source"); await fs.mkdir(folder);
  const project = createDemoProject(); await autosaveProjectFolder(folder, project, null);
  let context: ProjectDurabilityContext = { windowEpoch: randomUUID(), documentSessionId: randomUUID(), targetGeneration: 1 };
  const location: ProjectLocation = options.noFolder ? { folderPath: null, projectPath: null } : { folderPath: folder, projectPath: projectWorkspacePath(folder) };
  const updates: ProjectPersistenceUpdate[] = [], commits = vi.fn();
  const source = new ProjectSourcePersistence({ getContext: () => context, commit: (_capture, _project, target) => { commits(); return { context, location: { folderPath: folder, projectPath: target } }; } });
  const store = new ProjectRecoveryStore(path.join(root, "recovery"));
  const write = vi.fn(options.write ?? store.writeSnapshot.bind(store));
  const markResolved = vi.fn(store.markResolved.bind(store));
  const persistence = new ProjectPersistence({ source, recovery: { writeSnapshot: write, readSnapshot: store.readSnapshot.bind(store), createBranch: store.createBranch.bind(store), releaseBranch: store.releaseBranch.bind(store), markResolved },
    getContext: () => context, getLocation: () => location, onUpdate: value => updates.push(value), recoveryTimeoutMs: options.timeout });
  const admit = async (legacy?: string) => persistence.admitSource(context, (await loadProjectSelection(folder)).sourceEvidence, legacy);
  if (options.admitted !== false && !options.noFolder) await admit();
  if (options.recovered) persistence.contextChanged(true, { origin: { kind: "folder", folderPath: folder }, capturedAt: new Date().toISOString(), receipt: { recordId: randomUUID(), revision: 1, digest: "0".repeat(64) } });
  const request = (value = project): ProjectReloadRequest => ({ context: { ...context }, project: value, snapshotRevision: 7, transition: persistence.beginTransition(context) });
  const checkpoint = (value = project, requestId?: string) => ({ context: { ...context }, project: value, snapshotRevision: 7, ...(requestId ? { requestId } : {}) });
  const change = (replacement = true) => { context = { ...context, documentSessionId: randomUUID() }; persistence.contextChanged(replacement); };
  return { root, folder, project, persistence, source, store, write, markResolved, updates, commits, request, checkpoint, change, admit, get context() { return context; } };
}
function handle(value: ReturnType<ProjectPersistence["beginReload"]>): ReloadHandle { if ("refused" in value) throw new Error(value.refused); return value; }
function coordinator(f: Awaited<ReturnType<typeof fixture>>) {
  const value = new ProjectDepartureCoordinator({ getContext: () => f.context, isRendererAlive: () => true, isTrustedSender: () => true,
    getTransitionId: () => f.persistence.getTransitionId(), onRequest: () => undefined, onCheckpoint: update => f.persistence.handleDepartureUpdate(update),
    onCancelled: id => f.persistence.handleDepartureCancelled(id), onFallback: () => undefined, onDismissFallback: () => undefined, onContinue: () => undefined, onReopen: () => undefined });
  f.persistence.attachDepartureCoordinator(value); return value;
}

describe("owned recovery-only project reload", () => {
  it("reserves synchronously, freezes the exact canonical snapshot, and holds busy until release", async () => {
    const f = await fixture(), before = await fs.readFile(projectWorkspacePath(f.folder), "utf8"), capture = vi.spyOn(f.source, "capture"), persist = vi.spyOn(f.source, "persist");
    const request = f.request(), admitted = handle(f.persistence.beginReload({ ...request, requestId: undefined }));
    const digest = canonicalProjectDigest(f.project); f.project.paths[0].name = "Late edit";
    expect(f.write).not.toHaveBeenCalled(); expect(() => f.persistence.checkpoint(f.checkpoint())).toThrow("already running");
    expect(f.persistence.beginReload(request)).toMatchObject({ refused: "busy" });
    const root = admitted.root; root.objectKey = "caller mutation"; expect(admitted.root.objectKey).not.toBe(root.objectKey);
    const revealed = f.persistence.sourceRoot(f.context)!; revealed.folderPath = "caller mutation"; expect(f.persistence.sourceRoot(f.context)?.folderPath).toBe(f.folder);
    const kept = await admitted.keep(); expect(kept).toMatchObject({ status: "kept", kept: { kind: "recovery", digest, snapshotRevision: 7, storedSnapshot: { digest } } });
    if (kept.status !== "kept") throw new Error("not kept");
    expect((await f.store.readSnapshot(kept.kept.storedSnapshot.recordId)).project.paths[0].name).not.toBe("Late edit");
    expect(capture.mock.results[0].value.valid).toBe(false); admitted.assertCurrent();
    expect(f.persistence.cancel(f.context, kept.kept.operationId)).toBe(false);
    expect(() => f.persistence.checkpoint(f.checkpoint())).toThrow("already running");
    kept.kept.storedSnapshot.revision = 999; expect(f.persistence.getSession().latestRecovery?.storedSnapshot?.revision).not.toBe(999);
    expect(await admitted.keep()).toMatchObject({ status: "failed", code: "stale" });
    expect(f.write).toHaveBeenCalledTimes(1); expect(f.markResolved).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled(); expect(f.updates).toEqual([]); expect(f.commits).not.toHaveBeenCalled();
    expect(await fs.readFile(projectWorkspacePath(f.folder), "utf8")).toBe(before);
    admitted.release(); admitted.release(); expect(() => admitted.assertCurrent()).toThrow(ReloadStale);
    expect((await f.persistence.checkpoint(f.checkpoint())).source).toBe("saved");
  });

  it.each(["missing", "null", "wrong", "requestId"])("refuses %s authority without capture or storage", async mode => {
    const f = await fixture(), request = f.request(), capture = vi.spyOn(f.source, "capture");
    const raw: any = { ...request };
    if (mode === "missing") delete raw.transition;
    if (mode === "null") raw.transition = null;
    if (mode === "wrong") raw.transition = { ...request.transition, id: "other" };
    if (mode === "requestId") raw.requestId = "forged";
    expect(f.persistence.beginReload(raw)).toMatchObject({ refused: "stale" }); expect(capture).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled();
    f.persistence.endTransition(request.transition);
    expect(f.persistence.beginReload(raw)).toMatchObject({ refused: "stale" });
  });

  it("rejects an old document context even when its window transition token is still current", async () => {
    const f = await fixture(), request = f.request(), capture = vi.spyOn(f.source, "capture");
    expect(f.persistence.beginReload({ ...request, context: { ...request.context, documentSessionId: randomUUID() } })).toMatchObject({ refused: "stale" });
    expect(capture).not.toHaveBeenCalled(); handle(f.persistence.beginReload(request)).release();
  });

  it.each(["unadmitted", "recovered", "untitled"])("refuses %s projects without granting source authority", async kind => {
    const f = await fixture({ admitted: kind !== "unadmitted", recovered: kind === "recovered", noFolder: kind === "untitled" });
    expect(f.persistence.sourceRoot(f.context)).toBeNull(); expect(f.persistence.beginReload(f.request())).toMatchObject({ refused: "not-reloadable" }); expect(f.write).not.toHaveBeenCalled();
  });

  it("refuses an already admitted checkpoint and active departure coordinator", async () => {
    const gate = deferred(), f = await fixture({ write: async () => { await gate.promise; throw new Error("fixture release"); } });
    const request = f.request(), pending = f.persistence.checkpoint(f.checkpoint());
    expect(f.persistence.beginReload(request)).toMatchObject({ refused: "busy" }); gate.resolve(); await pending;
    const departures = coordinator(f), intent = departures.request("close")!;
    expect(intent).toBeTruthy(); expect(f.persistence.beginReload(request)).toMatchObject({ refused: "busy" }); departures.editingResumed(f.context.windowEpoch);
  });

  it("a fake departure cannot cancel the reservation; a real admitted nonce supersedes it", async () => {
    const f = await fixture(), departures = coordinator(f), request = f.request(), admitted = handle(f.persistence.beginReload(request));
    expect(() => f.persistence.checkpoint(f.checkpoint(f.project, "fake"))).toThrow("no longer active"); admitted.assertCurrent();
    expect(f.write).not.toHaveBeenCalled();
    const intent = departures.request("close")!, pending = f.persistence.checkpoint(f.checkpoint(f.project, intent.requestId));
    expect(() => admitted.assertCurrent()).toThrow(ReloadStale); expect(await admitted.keep()).toMatchObject({ status: "failed", code: "stale" });
    expect((await pending).mode).toBe("departure"); departures.editingResumed(f.context.windowEpoch);
  });

  it.each(["transition", "context", "same-context"])("settles a pending keep once on %s change and fences late physical completion", async event => {
    const gate = deferred(), finished = deferred(); let store!: ProjectRecoveryStore;
    const f = await fixture({ write: async (value, _branch) => { await gate.promise; try { const stored = await store.writeSnapshot(value); return { ...stored, requested: { recordId: value.recordId, revision: value.revision } }; } finally { finished.resolve(); } } }); store = f.store;
    const request = f.request(), admitted = handle(f.persistence.beginReload(request)), originalRecord = f.persistence.getSession().recoveryRecordId;
    const pending = admitted.keep(), settles = vi.fn(); void pending.then(settles);
    if (event === "transition") {
      expect(f.persistence.endTransition({ ...request.transition, id: "fake" })).toBe(false); admitted.assertCurrent();
      expect(f.persistence.endTransition(request.transition)).toBe(true); expect(f.persistence.endTransition(request.transition)).toBe(false);
    } else if (event === "same-context") f.persistence.contextChanged();
    else f.change();
    expect(await pending).toMatchObject({ status: "failed", code: "stale" }); const nextRecord = f.persistence.getSession().recoveryRecordId;
    expect(f.persistence.getSession().latestRecovery).toBeUndefined(); admitted.release(); gate.resolve(); await finished.promise; await Promise.resolve();
    expect(settles).toHaveBeenCalledTimes(1); expect(f.persistence.getSession().recoveryRecordId).toBe(nextRecord); expect(f.persistence.getSession().latestRecovery).toBeUndefined(); expect(f.updates).toEqual([]);
    expect((await f.store.readSnapshot(originalRecord)).resolved).toBeUndefined();
    expect((await f.store.listSnapshots()).entries.some(e => e.recordId === originalRecord && !e.resolved)).toBe(true);
  });

  it("times out recovery distinctly, releases admission and ignores a late successful receipt", async () => {
    vi.useFakeTimers(); const gate = deferred(), finished = deferred(); let store!: ProjectRecoveryStore;
    const f = await fixture({ timeout: 20, write: async value => { await gate.promise; try { const stored = await store.writeSnapshot(value); return { ...stored, requested: { recordId: value.recordId, revision: value.revision } }; } finally { finished.resolve(); } } }); store = f.store;
    const request = f.request(), admitted = handle(f.persistence.beginReload(request)), pending = admitted.keep(), original = f.persistence.getSession().recoveryRecordId;
    await vi.advanceTimersByTimeAsync(21);
    expect(await pending).toMatchObject({ status: "failed", code: "recovery-timed-out", recoveryCode: "timed-out", recoveryFact: "Recovery copy did not finish in time" });
    expect(() => admitted.assertCurrent()).toThrow(ReloadStale); expect(f.persistence.beginReload(request)).not.toHaveProperty("refused");
    gate.resolve(); await finished.promise; await Promise.resolve(); expect(f.persistence.getSession().recoveryRecordId).toBe(original); expect(f.persistence.getSession().latestRecovery).toBeUndefined(); expect(f.updates).toEqual([]);
    f.persistence.contextChanged();
  });

  it.each(["capacity", "storage-unavailable"])("aborts on %s without source, coordinator or resolution writes", async code => {
    const f = await fixture({ write: async () => { throw new RecoveryStoreError(code as "capacity" | "storage-unavailable"); } });
    const departures = coordinator(f), record = vi.spyOn(departures, "recordRecovery"), source = vi.spyOn(f.source, "persist"), request = f.request(), admitted = handle(f.persistence.beginReload(request));
    expect(await admitted.keep()).toMatchObject({ status: "failed", code: code === "capacity" ? "recovery-capacity" : "recovery-failed", recoveryCode: code });
    expect(source).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled(); expect(f.markResolved).not.toHaveBeenCalled(); expect(f.updates).toEqual([]); expect(() => admitted.assertCurrent()).toThrow(ReloadStale);
    handle(f.persistence.beginReload(request)).release();
  });

  it.each(["digest", "capturedAt", "requested", "stored"])("refuses an unconfirmed %s recovery receipt", async field => {
    const f = await fixture({ write: async (value) => Object.assign({ recordId: value.recordId, revision: value.revision, requested: { recordId: value.recordId, revision: value.revision }, digest: canonicalProjectDigest(value.project), capturedAt: value.capturedAt, stored: true, written: true },
      field === "digest" ? { digest: "0".repeat(64) } : field === "capturedAt" ? { capturedAt: "2020-01-01T00:00:00.000Z" } : field === "requested" ? { requested: { recordId: randomUUID(), revision: value.revision } } : { stored: false }) });
    const admitted = handle(f.persistence.beginReload(f.request())); expect(await admitted.keep()).toMatchObject({ status: "failed", code: "recovery-failed", recoveryFact: "This recovery revision was not confirmed" }); expect(f.persistence.getSession().latestRecovery).toBeUndefined();
  });

  it("uses effective branch coordinates when reusing a resolved record and keeps it unresolved in the catalog", async () => {
    const f = await fixture(), saved = await f.persistence.checkpoint(f.checkpoint()), old = saved.recoveryReceipt!.storedSnapshot!;
    expect((await f.store.readSnapshot(old.recordId)).resolved).toBeDefined();
    f.change(); await f.admit(); const fresh = f.persistence.getSession().recoveryRecordId; expect(fresh).not.toBe(old.recordId);
    const admitted = handle(f.persistence.beginReload(f.request())), kept = await admitted.keep();
    expect(kept).toMatchObject({ status: "kept", kept: { storedSnapshot: { recordId: old.recordId, revision: old.revision + 1 } } });
    if (kept.status !== "kept") throw new Error("not kept");
    expect(f.persistence.getSession().recoveryRecordId).toBe(old.recordId); expect(f.persistence.getSession().latestRecovery?.storedSnapshot).toEqual(kept.kept.storedSnapshot);
    const snapshot = await f.store.readSnapshot(old.recordId); expect(snapshot.receipt).toEqual(kept.kept.storedSnapshot); expect(snapshot.resolved).toBeUndefined();
    const listed = (await f.store.listSnapshots()).entries.find(entry => entry.recordId === old.recordId);
    expect(listed).toBeDefined(); expect(listed?.resolved).toBeUndefined();
    admitted.release();
  });

  it("writes a fresh revision after source resolution even for identical snapshot bytes", async () => {
    const f = await fixture(), saved = await f.persistence.checkpoint(f.checkpoint());
    const request = f.request(), admitted = handle(f.persistence.beginReload(request)), kept = await admitted.keep();
    expect(kept).toMatchObject({ status: "kept", kept: { storedSnapshot: { recordId: saved.recoveryReceipt!.storedSnapshot!.recordId, revision: saved.recoveryReceipt!.storedSnapshot!.revision + 1 } } }); admitted.release();
  });

  it("does not leak a capture or reservation when admission preparation fails", async () => {
    const f = await fixture(), request = f.request(), capture = vi.spyOn(f.source, "capture"), assert = vi.spyOn(f.source, "assertCurrent").mockImplementationOnce(() => { throw new Error("preflight failed"); });
    expect(() => f.persistence.beginReload(request)).toThrow("preflight failed"); expect(capture.mock.results[0].value.valid).toBe(false); assert.mockRestore();
    handle(f.persistence.beginReload(request)).release();
    expect(() => f.persistence.beginReload({ ...request, project: null as any })).toThrow(); handle(f.persistence.beginReload(request)).release();
  });

  it("reports real store capacity while retaining all unresolved records", async () => {
    const f = await fixture();
    for (let i = 0; i < MAX_RECOVERY_RECORDS; i++) await f.store.writeSnapshot({ recordId: randomUUID(), revision: 1, capturedAt: new Date().toISOString(), displayName: `Kept ${i}`, reason: "fixture", origin: { kind: "untitled", id: randomUUID() }, project: f.project });
    const before = (await f.store.listSnapshots()).entries.map(entry => entry.recordId).sort();
    expect(await handle(f.persistence.beginReload(f.request())).keep()).toMatchObject({ status: "failed", code: "recovery-capacity", recoveryCode: "capacity", fact: "Recovery storage full" });
    expect((await f.store.listSnapshots()).entries.map(entry => entry.recordId).sort()).toEqual(before); expect(f.updates).toEqual([]); expect(f.commits).not.toHaveBeenCalled();
  });

  it("captures the admitted legacy selection and fences re-admitted source owners", async () => {
    const f = await fixture(), legacy = path.join(f.folder, "Original.bordeaux.json"); await f.admit(legacy);
    const admitted = handle(f.persistence.beginReload(f.request())); expect(admitted.selectionPath).toBe(legacy); expect(admitted.legacyFile).toBe(legacy);
    await f.admit(path.join(f.folder, "Other.bordeaux.json")); expect(() => admitted.assertCurrent()).toThrow(ReloadStale);
    expect(await admitted.keep()).toMatchObject({ status: "failed", code: "stale" });
    expect(f.persistence.sourceRoot({ ...f.context, documentSessionId: "wrong" })).toBeNull();
  });
});
