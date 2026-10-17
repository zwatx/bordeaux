import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/renderer/styles/app.css';
import '../src/renderer/styles/robot-push.css';
import { RobotPushDialog, useRobotPushController } from '../src/renderer/components/LegacyRobotPushDialog';

// This harness mounts the real controller and dialog. Only the desktop API is
// substituted; its deferred responses model IPC/network scheduling precisely.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const results = [];
const root = createRoot(document.getElementById('root'));
const pairing = { teamNumber: 2468, runtimeId: 'robot', endpoint: { host: 'robot.local', port: 22 } };
const revision = 'sha256:' + 'a'.repeat(64);
const oldRevision = 'sha256:' + 'b'.repeat(64);
let controller;
let props;
let mock;
let serial = 0;
const project = () => ({ name: 'Project', robot: { drive: 'swerve', w: 0.8, l: 0.8, maxSpeed: 4 }, field: { id: 'field' }, paths: [{ id: 'A', name: 'A', waypoints: [] }, { id: 'B', name: 'B', waypoints: [] }], routines: [{ id: 'R', name: 'R', nodes: [{ id: 'a', type: 'path', ref: 'A' }] }], activeRoutineId: 'R', editor: { activePathId: 'A' } });
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (actual, expected, message) => assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const checked = (activeRevisionId = oldRevision) => ({ status: { activeRevisionId, activePayloadSha256: activeRevisionId, retention: { revisions: [] } }, comparison: { paths: { A: { state: 'matches' }, B: { state: 'matches' } }, routines: { R: { state: 'matches' } } }, verifiedAt: new Date().toISOString() });
const preview = (operationId = 'push-1') => ({ operationId, revision, robot: 'Team 2468', project: 'Project', catalog: 'Catalog', payloadHash: revision, size: 100, summary: { kind: 'paths', selectedNames: ['A'], pathIds: ['A'], addedNames: [], updatedNames: ['A'], preservedPathCount: 1, routine: 'R' } });

function Harness() {
  controller = useRobotPushController(props);
  return <RobotPushDialog controller={controller} onExportBdx={(id) => mock.exports.push(id)} />;
}
async function mount(capabilities = { pathPush: true, routinePush: true }) {
  await act(async () => { root.render(null); });
  const source = project();
  props = { getProject: () => source, projectKey: ++serial, catalogKey: 'catalog-1', bookmarkKey: 'robot-1' };
  mock = { exports: [], savedPairingReads: 0, probes: [], pairings: [], prepares: [], confirms: [], inspections: [], retentionPrepares: [], retentionConfirms: [], canceled: [], fallbackCalls: 0, pushListeners: new Set(), retentionListeners: new Set() };
  const enqueue = (name, args) => { const request = { args: structuredClone(args), ...deferred() }; mock[name].push(request); return request.promise; };
  window.bordeauxAPI = {
    robotDeliveryCapabilities: capabilities,
    getRobotPairing: async () => { mock.savedPairingReads = (mock.savedPairingReads || 0) + 1; return pairing; },
    probeRobot: (...args) => enqueue('probes', args),
    confirmRobotPairing: (...args) => enqueue('pairings', args),
    prepareRobotPush: (...args) => enqueue('prepares', args),
    confirmRobotPush: (...args) => enqueue('confirms', args),
    cancelRobotPush: async (id) => { mock.canceled.push(id); return { canceled: true, boundary: 'review' }; },
    inspectRobotLibrary: (...args) => enqueue('inspections', args),
    inspectPairedRobot: async () => { mock.fallbackCalls += 1; return checked().status; },
    prepareRobotRetention: (...args) => enqueue('retentionPrepares', args),
    confirmRobotRetention: (...args) => enqueue('retentionConfirms', args),
    cancelRobotRetention: async (id) => { mock.canceled.push(id); return { canceled: true, boundary: 'review' }; },
    onRobotPushState: (callback) => { mock.pushListeners.add(callback); return () => mock.pushListeners.delete(callback); },
    onRobotRetentionState: (callback) => { mock.retentionListeners.add(callback); return () => mock.retentionListeners.delete(callback); },
  };
  await act(async () => { root.render(<Harness />); });
  if (capabilities.pathPush || capabilities.routinePush) assert(controller.pairing, 'Saved pairing should load');
  return source;
}
async function native(request) {
  await new Promise((resolve) => {
    window.__pushUiRequest = request;
    window.__finishPushUiRequest = () => { window.__pushUiRequest = null; resolve(); };
  });
}
async function action(callback) { await act(async () => { callback(); }); }
async function resolve(request, value) { await act(async () => { request.resolve(value); }); }
async function reject(request, message) { await act(async () => { request.reject(new Error(message)); }); }
async function update(change) { props = { ...props, ...change }; await act(async () => { root.render(<Harness />); }); }
async function prepare() {
  await action(() => controller.requestPush({ kind: 'paths', pathIds: ['A'] }));
  await resolve(mock.prepares.at(-1), preview());
  equal(controller.phase, 'review', 'Prepared selection should enter review');
}
async function prepareRetention(actionName = 'rollback') {
  await action(() => controller.prepareRetention(actionName, { revisionId: revision, payloadSha256: revision }));
  await resolve(mock.retentionPrepares.at(-1), { operationId: 'retention-1', action: actionName, targetRevision: revision, payloadHash: revision, activeRevision: oldRevision, robot: 'Team 2468' });
}
async function test(name, run, capabilities) {
  try { const source = await mount(capabilities); await run(source); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: error.stack || String(error) }); }
}

await test('Freeze selected scope and project bytes while browsing during preparation', async (source) => {
  await action(() => controller.requestPush({ kind: 'paths', pathIds: ['A'] }));
  source.editor.activePathId = 'B'; source.paths[0].name = 'Edited later';
  await update({ getProject: () => source });
  await resolve(mock.prepares[0], preview());
  equal(mock.prepares[0].args[1], { kind: 'paths', pathIds: ['A'] }, 'Selection must stay A');
  equal(mock.prepares[0].args[0].paths[0].name, 'A', 'Prepared bytes must precede subsequent edits');
  equal(controller.preview.summary.pathIds, ['A'], 'Review must keep selected A');
  assert(document.querySelector('dialog').textContent.includes('This reviewed snapshot is fixed'), 'Dialog must explain fixed snapshot');
});
for (const field of ['projectKey', 'catalogKey', 'bookmarkKey']) {
  await test(`Discard deferred preparation when ${field} changes`, async () => {
    await action(() => controller.requestPush({ kind: 'paths', pathIds: ['A'] }));
    await update({ [field]: field + '-changed' });
    await resolve(mock.prepares[0], preview());
    assert(controller.phase !== 'review' && !controller.preview, 'Stale preparation must not reopen review');
    equal(mock.canceled, ['push-1'], 'Stale prepared operation should be cancelled');
  });
}
await test('Cancel an existing review on catalog change', async () => {
  await prepare(); await update({ catalogKey: 'catalog-2' });
  assert(!controller.preview, 'Catalog switch must clear existing review');
  equal(mock.canceled, ['push-1'], 'Old review should be canceled');
});
await test('Keep active push available across project switch until its exact result arrives', async () => {
  await prepare(); await action(() => controller.confirmPush());
  await update({ projectKey: 'another-project', getProject: () => project() });
  assert(controller.busy && controller.preview.operationId === 'push-1', 'Sending operation must survive navigation');
  await resolve(mock.confirms[0], { state: 'staged', operationId: 'push-1', message: 'Acceptance unconfirmed' });
  equal(controller.phase, 'staged', 'Staged must not become accepted');
  assert(document.querySelector('dialog').textContent.includes('Acceptance unconfirmed'), 'Unconfirmed result must be explicit');
});
await test('Terminal progress cannot unlock a second push before confirmation RPC settles', async () => {
  await prepare(); await action(() => controller.confirmPush());
  await action(() => mock.pushListeners.forEach((listener) => listener({ operationId: 'push-1', state: 'active' })));
  assert(controller.busy, 'Terminal progress alone must not unlock controller before RPC resolution');
  await action(() => controller.requestPush({ kind: 'paths', pathIds: ['B'] }));
  equal(mock.prepares.length, 1, 'Second preparation must not start before prior RPC settles');
  await resolve(mock.confirms[0], { state: 'active', operationId: 'push-1' });
  assert(!controller.busy, 'Completion response should release busy state');
});
await test('Every paired connection open refreshes history', async () => {
  await action(() => controller.openConnection());
  equal(mock.inspections.length, 1, 'First connection open should inspect');
  await resolve(mock.inspections[0], checked());
  await action(() => controller.close());
  await action(() => controller.openConnection());
  equal(mock.inspections.length, 2, 'Reopening connection should inspect again');
  await resolve(mock.inspections[1], checked(revision));
  equal(controller.status.activeRevisionId, revision, 'Reopened history must use latest revision');
});
await test('Accepted push automatically refreshes library and history', async () => {
  await prepare(); await action(() => controller.confirmPush());
  await resolve(mock.confirms[0], { state: 'active', operationId: 'push-1' });
  equal(mock.inspections.length, 1, 'Accepted push should trigger inspection');
  await resolve(mock.inspections[0], checked(revision));
  equal(controller.status.activeRevisionId, revision, 'Post-push history should update');
});
for (const actionName of ['rollback', 'pin']) {
  await test(`Accepted ${actionName} automatically refreshes library and history`, async () => {
    await prepareRetention(actionName); await action(() => controller.confirmRetention());
    await resolve(mock.retentionConfirms[0], { state: actionName === 'pin' ? 'pinned' : 'active', operationId: 'retention-1' });
    equal(mock.inspections.length, 1, 'Accepted retention should trigger inspection');
    await resolve(mock.inspections[0], checked(revision));
    equal(controller.status.activeRevisionId, revision, 'Post-retention history should update');
  });
}
await test('Unsupported baseline reader falls back to legacy status and history', async () => {
  await action(() => controller.refreshStatus());
  await reject(mock.inspections[0], 'Runtime does not support verified active-revision reads');
  equal(mock.fallbackCalls, 1, 'Legacy status API should be called');
  equal(controller.status.activeRevisionId, oldRevision, 'Legacy history should be available');
  assert(!controller.inspection, 'Legacy fallback must not manufacture item comparisons');
});
await test('Rollback discards stale inspections started before confirmation', async () => {
  await action(() => controller.refreshStatus());
  await prepareRetention(); await action(() => controller.confirmRetention());
  await resolve(mock.inspections[0], checked());
  assert(!controller.inspection, 'Pre-rollback comparison must not repopulate after send starts');
  await resolve(mock.retentionConfirms[0], { state: 'staged', operationId: 'retention-1' });
  equal(controller.phase, 'staged', 'Unconfirmed rollback remains staged');
});
await test('Unconfirmed push reconciles only the reviewed active revision', async () => {
  await prepare(); await action(() => controller.confirmPush());
  await resolve(mock.confirms[0], { state: 'staged', operationId: 'push-1' });
  await action(() => controller.refreshStatus()); await resolve(mock.inspections.at(-1), checked(oldRevision));
  equal(controller.phase, 'staged', 'Another active revision is not acceptance');
  await action(() => controller.refreshStatus()); await resolve(mock.inspections.at(-1), checked(revision));
  equal(controller.phase, 'active', 'Exact reviewed revision should reconcile acceptance');
  assert(controller.result.reconciled, 'Reconciled result should distinguish inspection evidence');
});
await test('Wrong payload hash never reconciles unconfirmed push acceptance', async () => {
  await prepare(); await action(() => controller.confirmPush());
  await resolve(mock.confirms[0], { state: 'staged', operationId: 'push-1' });
  const mismatched = checked(revision); mismatched.status.activePayloadSha256 = oldRevision;
  await action(() => controller.refreshStatus()); await resolve(mock.inspections.at(-1), mismatched);
  equal(controller.phase, 'staged', 'Matching revision text without matching payload is insufficient');
});
await test('Adoption checkbox gates the actual dialog confirmation button', async () => {
  await action(() => controller.requestPush({ kind: 'paths', pathIds: ['A'] }));
  await resolve(mock.prepares[0], { ...preview(), adoptionRequired: true });
  const confirmButton = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Push path');
  assert(confirmButton.disabled, 'Push must be disabled before baseline adoption');
  await action(() => document.querySelector('.robot-baseline-confirm input').click());
  assert(!confirmButton.disabled, 'Adoption should enable confirmation');
  await action(() => confirmButton.click());
  equal(mock.confirms[0].args, ['push-1', true], 'Dialog must send explicit adoption');
  await resolve(mock.confirms[0], { state: 'staged', operationId: 'push-1' });
});
await test('Retention terminal progress stays locked until its confirmation settles', async () => {
  await prepareRetention(); await action(() => controller.confirmRetention());
  await action(() => mock.retentionListeners.forEach((listener) => listener({ operationId: 'retention-1', state: 'active' })));
  assert(controller.busy, 'Rollback remains busy until RPC settles');
  await action(() => controller.requestPush({ kind: 'paths', pathIds: ['B'] }));
  equal(mock.prepares.length, 0, 'Cannot replace unresolved retention operation');
  await resolve(mock.retentionConfirms[0], { state: 'active', operationId: 'retention-1' });
  assert(!controller.busy, 'Settled rollback should release busy state');
});
await test('Discard deferred library comparison after project change', async () => {
  await action(() => controller.refreshStatus());
  await update({ projectKey: 'another-project' });
  await resolve(mock.inspections[0], checked());
  assert(!controller.inspection && !controller.status, 'Previous project inspection must not populate new project');
});
await test('Pin acknowledgement cannot be inferred merely from active revision', async () => {
  await prepareRetention('pin'); await action(() => controller.confirmRetention());
  await resolve(mock.retentionConfirms[0], { state: 'staged', operationId: 'retention-1' });
  await action(() => controller.refreshStatus()); await resolve(mock.inspections.at(-1), checked(revision));
  equal(controller.phase, 'staged', 'Active revision does not prove pinning');
});
await test('Rollback reconciles by exact revision and payload after acknowledgement loss', async () => {
  await prepareRetention(); await action(() => controller.confirmRetention());
  await resolve(mock.retentionConfirms[0], { state: 'staged', operationId: 'retention-1' });
  await action(() => controller.refreshStatus()); await resolve(mock.inspections.at(-1), checked(revision));
  equal(controller.phase, 'active', 'Exact rollback target should reconcile');
  assert(controller.result.reconciled, 'Rollback must retain inspection evidence');
});
await test('Source edits invalidate prior compiled matches without choosing a new push target', async (source) => {
  await action(() => controller.refreshStatus()); await resolve(mock.inspections[0], checked());
  equal(controller.itemStatus('path', 'A').label, 'Matches robot', 'Fresh comparison should appear');
  source.paths[0].name = 'Edited'; await update({ getProject: () => source });
  equal(controller.itemStatus('path', 'A').label, 'Changed', 'Local edits invalidate old equality');
  equal(controller.itemStatus('path', 'B').label, 'Matches robot', 'Unrelated match should survive');
});
await test('Pairing keeps reviewed identity visible through deferred confirmation and retry', async () => {
  await action(() => { controller.openConnection(); controller.chooseAnotherRobot(); });
  await action(() => controller.probeRobot());
  const identity = { hostKeyFingerprint: 'SHA256:' + 'c'.repeat(43), status: { teamNumber: 2468, runtimeId: 'reviewed-robot-runtime' } };
  await resolve(mock.probes[0], identity);
  equal(controller.phase, 'pair-review', 'Probe must show identity review');
  const trustButton = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Trust and pair');
  trustButton.focus();
  await act(async () => { await native({ key: 'Enter' }); });
  equal(mock.pairings.length, 1, 'Keyboard confirmation should pair exactly once');
  equal(controller.phase, 'pairing', 'Deferred confirmation should be pending');
  const dialog = document.querySelector('dialog');
  assert(dialog.textContent.includes(identity.hostKeyFingerprint), 'Reviewed host key must remain visible');
  assert(dialog.textContent.includes(identity.status.runtimeId), 'Reviewed runtime must remain visible');
  assert(dialog.querySelector('[aria-busy="true"]'), 'Pairing review should expose pending state');
  assert(!dialog.querySelector('.robot-push-endpoint'), 'Pending pairing must not return to connection fields');
  assert([...dialog.querySelectorAll('.robot-push-actions button')].every((button) => button.disabled), 'Pending pairing actions must remain disabled');
  await native({ capture: 'pairing-pending' });
  await reject(mock.pairings[0], 'Robot identity confirmation timed out');
  equal(controller.phase, 'pair-review', 'Failure should retain identity for retry');
  equal(dialog.querySelectorAll('[role="alert"]').length, 1, 'Pairing failure should have one alert');
  assert(dialog.textContent.includes(identity.hostKeyFingerprint), 'Failure must retain reviewed identity');
  await native({ capture: 'pairing-failure' });
  const retry = [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Trust and pair');
  retry.focus();
  await act(async () => { await native({ key: 'Enter' }); });
  await resolve(mock.pairings[1], pairing);
  equal(controller.phase, 'ready', 'Successful retry should finish pairing');
  assert(controller.pairing, 'Pairing should be retained');
});
await test('Failed upload shows one error and stable recovery actions', async () => {
  await prepare();
  await action(() => controller.confirmPush());
  await reject(mock.confirms[0], 'Upload connection closed');
  equal(controller.phase, 'failed', 'Upload rejection should enter failed phase');
  const dialog = document.querySelector('dialog');
  equal(dialog.querySelectorAll('[role="alert"]').length, 1, 'Update failure must use one alert');
  equal(dialog.textContent.split('Upload connection closed').length - 1, 1, 'Failure text must appear once');
  assert(dialog.textContent.includes('Review current edits'), 'Failed update must offer recovery');
  assert(!dialog.querySelector('.robot-push-endpoint'), 'Failed update must not show an unrelated connection form');
  await native({ capture: 'upload-failure' });
});
await test('Unavailable BDX delivery offers local export before any robot connection', async () => {
  await action(() => controller.requestPush({ kind: 'paths', pathIds: ['A'] }));
  equal(controller.phase, 'unavailable', 'Disabled capabilities must show the unavailable state');
  equal(mock.savedPairingReads, 0, 'Unavailable delivery must not even request saved pairing');
  const dialog = document.querySelector('dialog');
  assert(dialog.open, 'Unavailable dialog should be visible');
  assert(dialog.textContent.includes('compatible LabVIEW BDX receiver'), 'Explain the actual missing capability');
  assert(!dialog.querySelector('.robot-push-endpoint'), 'Do not offer an unusable connection form');
  assert(!/Revision history|Review current edits|Trust and pair/.test(dialog.textContent), 'Do not offer legacy recovery actions');
  const exportButton = [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Export path as BDX');
  assert(exportButton, 'Offer the local BDX path action');
  await native({ capture: 'delivery-unavailable' });
  exportButton.focus();
  await act(async () => { await native({ key: 'Enter' }); });
  equal(mock.exports, ['A'], 'Export only the explicitly selected path');
  assert(!controller.open, 'Local export closes the delivery dialog');
  for (const name of ['probes', 'pairings', 'prepares', 'confirms', 'inspections', 'retentionPrepares', 'retentionConfirms']) equal(mock[name].length, 0, name + ' must remain untouched');
}, { pathPush: false, routinePush: false });
await act(async () => { root.render(null); });
const report = document.createElement('pre'); report.id = 'verification-report'; report.textContent = JSON.stringify(results, null, 2); document.body.append(report);
