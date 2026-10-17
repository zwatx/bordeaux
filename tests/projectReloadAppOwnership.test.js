import fs from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import * as lifecycleExports from "../src/renderer/lib/projectLifecycle";
import { firstFact, sameContext, reloadRecovery } from "../src/renderer/lib/projectLifecycle";

// Exercise the actual App/sheet callbacks with controlled owners. These are not DOM/focus tests.
async function callback(file, name, dependencies) {
  const source = await fs.readFile(file, "utf8"), ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
  let expression;
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === name && ts.isArrowFunction(node.initializer)) expression = node.initializer;
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name && node.initializer) {
      expression = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast); if (!expression) throw new Error("Missing actual callback " + name);
  return vm.runInNewContext(ts.transpileModule("(" + expression.getText(ast) + ")", { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { ...lifecycleExports, ...dependencies });
}
const app = "src/renderer/app/App.jsx", sheet = "src/renderer/components/ProjectsDialog.jsx";
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const context = { windowEpoch: "w", documentSessionId: "d", targetGeneration: 1 };

it.each(["reloaded", "superseded"])("ignores a late %s in App before changing the newer document", async status => {
  const effect = vi.fn(), d = { documentEpoch: { current: 8 }, prepareProjectReplacement: effect, setProjectLocation: effect, setSaveState: effect,
    loadProject: effect, adoptSessionRecord: effect, setReloadKept: effect, announceAction: effect, projectLocationRef: {},
    projectFolderName: () => "New", startupSettled: {}, startupDetachFailed: {} };
  const apply = await callback(app, "apply", d);
  expect(apply({ status, opened: { project: { name: "Old" } }, session: {}, kept: {} }, 7)).toEqual({ reloadFailed: "stale" });
  expect(effect).not.toHaveBeenCalled();
});

it("settles writing when a running autosave drained and Reload then failed", async () => {
  const setSaveState = vi.fn(), sourceChange = { scope: "workspace" };
  const apply = await callback(app, "apply", { documentEpoch: { current: 7 }, reloadRecovery, sameContext,
    saveStateRef: { current: { status: "error", error: "Changed", writing: true, sourceChange } }, setSaveState, announceAction: vi.fn(), setRecoveryState: vi.fn() });
  apply({ status: "not-reloaded", code: "read-failed", fact: "No access" }, 7);
  expect(setSaveState).toHaveBeenCalledWith(expect.objectContaining({ writing: false, sourceChange, reloadError: "No access" }));
});

it("retires the chip Show-file effect before invoke when its document changes during the session read", async () => {
  const session = deferred(), reveal = vi.fn(), epoch = { current: 7 };
  const show = await callback(app, "showSourceFile", { window: { bordeauxAPI: { getProjectSession: () => session.promise, revealProjectSource: reveal } },
    lifecycle: {}, documentEpoch: epoch, sessionContext: { current: context }, saveStateEpoch: { current: 1 },
    saveStateRef: { current: { sourceChange: { scope: "document", file: "Paths/A.path" } } }, showSequence: { current: 0 }, setShowFailure: vi.fn(), announceAction: vi.fn(), firstFact });
  const pending = show(); epoch.current = 8; session.resolve({ context: { ...context, documentSessionId: "new" } }); await pending;
  expect(reveal).not.toHaveBeenCalled();
});

it("does not revive a Show-file failure after A to B to A within one document", async () => {
  const result = deferred(), reveal = vi.fn(() => result.promise), failure = vi.fn(), generation = { current: 1 };
  const state = { current: { sourceChange: { scope: "document", file: "Paths/A.path" } } };
  const show = await callback(app, "showSourceFile", { window: { bordeauxAPI: { getProjectSession: async () => ({ context }), revealProjectSource: reveal } },
    lifecycle: {}, documentEpoch: { current: 7 }, sessionContext: { current: context }, saveStateEpoch: generation,
    saveStateRef: state, showSequence: { current: 0 }, setShowFailure: failure, announceAction: vi.fn(), firstFact });
  const pending = show(); await Promise.resolve(); await Promise.resolve();
  state.current = { sourceChange: { scope: "document", file: "Paths/B.path" } }; generation.current++;
  state.current = { sourceChange: { scope: "document", file: "Paths/A.path" } }; generation.current++;
  result.resolve({ revealed: false, fact: "Old failure" }); await pending;
  expect(failure.mock.calls.filter(([value]) => value !== null)).toEqual([]);
});

it("does not announce a sheet reveal after its block/request owner changes", async () => {
  const result = deferred(), block = {}, request = {}, owner = { current: { block, request, pending: null } }, said = vi.fn();
  const show = await callback(sheet, "showSource", { pending: null, revealing: { current: null }, block,
    revealOwner: owner, alive: { current: true }, actions: { revealSource: () => result.promise }, setRevealFact: vi.fn(), setSaid: said, shortFact: firstFact });
  const pending = show("Paths/A.path"); owner.current = { block: {}, request: {}, pending: null };
  result.resolve({ revealed: false, fact: "Old failure" }); await pending;
  expect(said).not.toHaveBeenCalled();
});

it('cannot adopt a foreign or missing session through a latest-session refresh', async () => {
  const record = vi.fn(), bound = { current: { ...context } }, epoch = { current: 7 };
  const adopt = await callback(app, 'adoptSessionRecord', { documentEpoch: epoch, sessionContext: bound, setSessionRecordId: record });
  expect(adopt({ context: { ...context, documentSessionId: 'foreign' }, recoveryRecordId: 'foreign-record' }, 7)).toBe(false);
  expect(bound.current).toEqual(context); expect(record).not.toHaveBeenCalled();
  bound.current = null;
  expect(adopt({ context, recoveryRecordId: 'unowned' }, 7)).toBe(false);
  expect(bound.current).toBeNull(); expect(record).not.toHaveBeenCalled();
});

it('refreshes a bound document target and recovery record, without regressing or crossing a renderer epoch', async () => {
  const record = vi.fn(), bound = { current: { ...context } }, epoch = { current: 7 };
  const adopt = await callback(app, 'adoptSessionRecord', { documentEpoch: epoch, sessionContext: bound, setSessionRecordId: record });
  const advanced = { ...context, targetGeneration: 2 };
  expect(adopt({ context: advanced, recoveryRecordId: 'remapped' }, 7)).toBe(true);
  expect(bound.current).toEqual(advanced); expect(record).toHaveBeenLastCalledWith('remapped');
  expect(adopt({ context, recoveryRecordId: 'earlier' }, 7)).toBe(false);
  expect(adopt({ context: advanced, recoveryRecordId: 'late' }, 6)).toBe(false);
  expect(bound.current).toEqual(advanced); expect(record).toHaveBeenCalledTimes(1);
});

it('does not register or invoke a background write when latest main session belongs to another document', async () => {
  const ipc = vi.fn(), watch = vi.fn(), record = vi.fn(), bound = { current: context }, documentEpoch = { current: 7 };
  const adoptSessionRecord = await callback(app, 'adoptSessionRecord', { documentEpoch, sessionContext: bound, setSessionRecordId: record });
  const lifecycle = { getProjectSession: async () => ({ context: { ...context, documentSessionId: 'foreign' } }), checkpointProject: ipc };
  const readBoundSession = await callback(app, 'readBoundSession', { documentEpoch, adoptSessionRecord, lifecycle });
  const checkpoint = await callback(app, 'checkpointBackground', { documentEpoch, readBoundSession, nextSnapshotRevision: () => 1, lifecycle, checkpointChannel: { watch } });
  await expect(checkpoint({ name: 'A model' })).rejects.toThrow(/project/i);
  expect(ipc).not.toHaveBeenCalled(); expect(watch).not.toHaveBeenCalled(); expect(bound.current).toEqual(context);
});

it('binds the load result before scheduling a refresh, which cannot rebind the loaded model to another session', async () => {
  const epoch = { current: 7 }, bound = { current: null }, record = vi.fn(), response = deferred(), restoreRobotCode = vi.fn();
  const adoptSessionRecord = await callback(app, 'adoptSessionRecord', { documentEpoch: epoch, sessionContext: bound, setSessionRecordId: record });
  const lifecycle = { getProjectSession: () => response.promise };
  const readBoundSession = await callback(app, 'readBoundSession', { lifecycle, documentEpoch: epoch, adoptSessionRecord });
  const refreshSessionRecord = await callback(app, 'refreshSessionRecord', { lifecycle, readBoundSession });
  const effects = Object.fromEntries(['retireDeletion', 'setSessionRecordId', 'setBdxPending', 'setRecoveryState', 'setRecoveredFrom', 'setReloadKept', 'setShowFailure', 'setActionNotice', 'invalidateScheduledAutosave', 'cancelEdit', 'setComparison', 'setProjectKey', 'setLibraryPreferenceKey', 'setProject', 'setActiveIdx', 'setSel', 'setRoutineSel', 'setExportError', 'setBdxNotice', 'updateDirty', 'setRobotProjectState'].map(name => [name, vi.fn()]));
  const load = await callback(app, 'loadProject', { ...effects, window: { bordeauxAPI: { restoreProjectRobotCode: vi.fn() } }, restoreRobotCode,
    setSessionRecordId: record, documentEpoch: epoch, sessionContext: bound,
    bdxSaveFailure: {}, exportJobs: { current: new Set() }, exportShown: {}, optimizer: { reset() {} }, projectFolderName: () => '', normalizeProject: p => p,
    robotRestoreGeneration: { current: 0 }, skipDirty: {}, projectRef: {}, playbackStore: { reset() {} }, routinePlaybackStore: { reset() {} }, history: { clear() {} },
    refreshSessionRecord: () => { expect(bound.current).toEqual(context); refreshSessionRecord(); } });
  load({ name: 'A', paths: [{ id: 'path' }] }, null, { session: { context, recoveryRecordId: 'A-record' } });
  expect(epoch.current).toBe(8); expect(record).toHaveBeenLastCalledWith('A-record');
  expect(restoreRobotCode).toHaveBeenCalledWith(context, 1);
  response.resolve({ context: { ...context, documentSessionId: 'B' }, recoveryRecordId: 'B-record' });
  await Promise.resolve(); await Promise.resolve();
  expect(bound.current).toEqual(context); expect(record).toHaveBeenCalledTimes(1);
});

it('refuses explicit Save before watching, materializing or sending an unrelated main session', async () => {
  const ipc = vi.fn(), materialize = vi.fn(), watch = vi.fn(), bound = { current: context }, documentEpoch = { current: 7 };
  const adoptSessionRecord = await callback(app, 'adoptSessionRecord', { documentEpoch, sessionContext: bound, setSessionRecordId: vi.fn() });
  const readBoundSession = await callback(app, 'readBoundSession', { documentEpoch, adoptSessionRecord, lifecycle: { getProjectSession: async () => ({ context: { ...context, documentSessionId: 'B' } }) } });
  const saveStateRef = { current: { status: 'draft' } }, saveStateEpoch = { current: 1 }, setSaveState = vi.fn();
  const save = await callback(app, 'saveProject', { window: { bordeauxAPI: { getProjectSession: async () => ({ context: { ...context, documentSessionId: 'B' } }), saveProjectWithCheckpoint: ipc } },
    lifecycle: {}, startupSettled: { current: true }, enqueuePersistenceAfterPreflight: (_queue, _flush, action) => action(),
    enqueuePersistence() {}, flushProjectDraft() {}, projectRef: { current: { name: 'A' } }, editStore: { getRevision: () => 1 }, draftInputGeneration: { current: 1 },
    saveStateRef, saveStateEpoch, failedSaves: {}, setSaveState, documentEpoch, nextSnapshotRevision: () => 1, readBoundSession,
    checkpointChannel: { watch }, materializeProject: materialize, invalidateScheduledAutosave() {}, operationErrorMessage: e => e.message });
  await save(false);
  expect(setSaveState).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error', error: expect.stringContaining('project changed') }), { user: true });
  expect(watch).not.toHaveBeenCalled(); expect(materialize).not.toHaveBeenCalled(); expect(ipc).not.toHaveBeenCalled();
});

it.each(['drain', 'saveCopy'])('rechecks editor ownership inside the queued departure %s before capturing any model', async name => {
  const bound = { current: context }, request = { requestId: 'request', context }, capture = vi.fn(), api = { respondProjectDeparture: vi.fn(async () => ({ accepted: true })) };
  const checkpointTargetReady = await callback(app, 'checkpointTargetReady', { startupSettled: { current: true }, sessionContext: bound });
  const entry = { request, phase: 'choosing' }, active = { current: entry }, release = vi.fn(); let queued;
  const deps = { current: { api, capture, checkpointTargetReady, enqueue: action => { queued = action; return Promise.resolve().then(action); } } };
  const action = await callback('src/renderer/hooks/useProjectDeparture.js', name, { deps, active, release, update() {},
    reply: (api, request, outcome) => api.respondProjectDeparture({ requestId: request.requestId, outcome }) });
  const pending = action(entry);
  bound.current = { ...context, documentSessionId: 'B' };
  await pending; await new Promise(resolve => setImmediate(resolve));
  expect(queued).toBeTypeOf('function'); expect(capture).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledWith(entry);
  expect(api.respondProjectDeparture).toHaveBeenCalledWith({ requestId: 'request', outcome: 'cancelled' });
});
