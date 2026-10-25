import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/renderer/styles/app.css';
import '../src/renderer/styles/robot-push.css';
import { RobotPushDialog, useRobotPushController } from '../src/renderer/components/RobotPushDialog';
import { DiagnosticBundleDialog } from '../src/renderer/components/DiagnosticBundleDialog';
import { DEFAULT_ROBOT_PATH_DIRECTORY } from '../src/shared/robotFileDelivery';
import { PushControl } from '../src/renderer/components/PushControl';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const results = [], root = createRoot(document.getElementById('root'));
const endpoint = { host: 'roborio-2468-frc.local', port: 22, directory: DEFAULT_ROBOT_PATH_DIRECTORY };
const connection = { endpoint, hostKeyFingerprint: 'SHA256:' + 'a'.repeat(43) };
const files = ['A', 'B'].map((id) => ({ pathId: id, name: id === 'A' ? 'Left-side scoring approach with obstacle clearance' : 'Return to pickup', fileName: id + '-path.bdx', size: 48128, sha256: 'c'.repeat(64) }));
const preview = { operationId: 'upload-1', connection, files };
let controller, props, mock;
const assert = (value, message) => { if (!value) throw new Error(message); };
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const action = async (fn) => act(async () => { fn(); });
const resolve = async (request, value) => act(async () => request.resolve(value));
const reject = async (request, message) => act(async () => request.reject(new Error(message)));
async function native(request) { await new Promise((resolve) => { window.__pushUiRequest = request; window.__finishPushUiRequest = () => { window.__pushUiRequest = null; resolve(); }; }); }
const button = (label) => [...document.querySelectorAll('button')].find((button) => button.textContent === label || button.getAttribute('aria-label') === label);
async function pointer(label) { const rect = button(label).getBoundingClientRect(); await act(async () => native({ pointer: { x: Math.round(rect.x + rect.width/2), y: Math.round(rect.y + rect.height/2) } })); }
function Harness() { controller = useRobotPushController(props); return <><button id="origin" onClick={() => controller.requestPush({ kind: 'paths', pathIds: ['A','B'] })}>Push selection</button><button id="connection-origin" onClick={() => controller.openConnection()}>Manage connection</button><PushControl place="paths" paths={files.map(f => ({ ...f, id: f.pathId, waypoints: [{}, {}] }))} selection={{ selected: ['A', 'B'] }} controller={controller} /><RobotPushDialog controller={controller} /><DiagnosticBundleDialog getProject={props.getProject} targetSelector=".robot-connection-diagnostics" onOpen={controller.close} onClose={() => controller.returnFocus()} renderKey={controller.open + ":" + controller.phase} /></>; }
async function mount(saved = connection) {
  await act(async () => root.render(null));
  props = { getProject: () => ({ paths: files.map((f) => ({ id: f.pathId, name: f.name })), routines: [] }), projectKey: 'project-1', catalogKey: 'catalog-1' };
  mock = { probes: [], trusts: [], prepares: [], confirms: [], canceled: [], saves: [], checks: [] };
  const enqueue = (name,args) => { const request = { args: structuredClone(args), ...deferred() }; mock[name].push(request); return request.promise; };
  window.bordeauxAPI = { robotDeliveryCapabilities: { fileTransfer: true, pathPush: true, routinePush: false },
    previewBetaDiagnostic: async () => ({ previewId: 'diagnostic', contents: '{}' }),
    getRobotFileConnection: async () => saved,
    checkRobotFileConnection: (...args) => enqueue('checks', args),
    saveRobotFileSettings: (...args) => enqueue('saves',args),
    probeRobotFiles: (...args) => enqueue('probes',args), trustRobotFiles: (...args) => enqueue('trusts',args),
    prepareRobotFiles: (...args) => enqueue('prepares',args), confirmRobotFiles: (...args) => enqueue('confirms',args),
    cancelRobotFiles: async (id) => { mock.canceled.push(id); return { canceled: true }; } };
  await act(async () => root.render(<Harness />));
}
async function prepare() { await pointer('Push selection'); await resolve(mock.prepares.at(-1), preview); assert(controller.phase === 'review', 'Must review immutable files'); }
async function test(name, run, saved) { try { await mount(saved); await run(); results.push({ name, ok: true }); } catch (error) { results.push({ name, ok: false, error: error.stack }); } }
await test('Saved robot settings can be edited offline, saved by keyboard and restored without transport', async () => {
  await action(() => controller.openConnection()); await pointer('Edit');
  await action(() => { controller.setHost('practice-robot.local'); controller.setPort('2222'); controller.setDirectory('/home/lvuser/practice'); });
  await native({ capture: 'offline-settings-edit' });
  button('Save').focus(); await act(async () => native({ key: 'Enter' }));
  assert(mock.saves.length === 1 && controller.phase === 'saving', 'Keyboard saves locally once');
  assert(!mock.probes.length && !mock.trusts.length && !mock.prepares.length && !mock.confirms.length, 'Saving never connects or uploads');
  const saved = { endpoint: mock.saves[0].args[0] };
  await resolve(mock.saves[0], saved);
  assert(!controller.connection && !controller.editing, 'Changed host requires SSH verification');
  await native({ capture: 'offline-settings-saved' });
  await act(async () => native({ key: 'Escape' })); assert(!controller.open, 'Escape closes saved settings');
  await mount(saved); await action(() => controller.openConnection());
  assert(controller.host === 'practice-robot.local' && controller.port === '2222' && controller.directory === '/home/lvuser/practice', 'Saved values restore');
  assert(!mock.probes.length && !mock.confirms.length, 'Restoring never connects or uploads');
  await native({ capture: 'offline-settings-restored' });
});
await test('Offline save failure keeps edits and offers retry without connecting', async () => {
  await action(() => controller.openConnection()); await pointer('Edit');
  await action(() => controller.setDirectory('/home/lvuser/practice'));
  await pointer('Save'); await reject(mock.saves[0], 'Settings could not be saved. Disk is full.');
  assert(controller.editing && controller.directory === '/home/lvuser/practice', 'Failed save retains edits');
  assert(!button('Save').disabled && !mock.probes.length, 'Retry available without connection');
  await native({ capture: 'offline-settings-failure' });
});
await test('Pointer and keyboard connect, trust identity, review multiple files, upload and verify', async () => {
  await pointer('Push selection');
  assert(controller.directory === DEFAULT_ROBOT_PATH_DIRECTORY, 'Required default directory');
  await action(() => controller.setHost(endpoint.host));
  await native({ capture: 'connection' });
  document.querySelector('.robot-push-close').focus();
  await act(async () => native({ key: 'Tab' }));
  assert(document.activeElement.tagName === 'INPUT', 'Tab reaches robot host field');
  await pointer('Connect'); await resolve(mock.probes[0], connection);
  assert(controller.phase === 'identity', 'Identity review required');
  await native({ capture: 'identity' });
  button('Trust host key').focus(); await act(async () => native({ key: 'Enter' }));
  assert(mock.trusts.length === 1, 'Keyboard trusts exactly once');
  await native({ capture: 'trust-pending' });
  await resolve(mock.trusts[0], connection); await resolve(mock.prepares[0], preview);
  assert(mock.prepares[0].args[1].join(',') === 'A,B', 'Only selected files prepared');
  assert(document.querySelector('dialog').textContent.includes(DEFAULT_ROBOT_PATH_DIRECTORY), 'Review destination is visible');
  await native({ capture: 'review' });
  await pointer('Upload 2 paths');
  await action(() => controller.confirmPush());
  assert(mock.confirms.length === 1, 'Double confirm cannot duplicate upload');
  await native({ capture: 'uploading' });
  await resolve(mock.confirms[0], { state: 'transferred', files, directory: endpoint.directory });
  await native({ capture: 'success' });
  assert(document.querySelector('dialog').textContent.includes('Nothing started'), 'File success must not imply execution');
  await act(async () => native({ key: 'Escape' }));
  assert(!controller.open, 'Escape closes dialog');
  assert(document.activeElement.id === 'origin', 'Focus returns to initiating button');
}, null);
await test('Trust failure keeps reviewed identity and retry available', async () => {
  await pointer('Push selection'); await action(() => controller.setHost(endpoint.host));
  await pointer('Connect'); await resolve(mock.probes[0], connection);
  await pointer('Trust host key'); await reject(mock.trusts[0], 'SSH identity changed. Reconnect and verify the host key.');
  assert(controller.phase === 'identity', 'Failure retains identity review');
  assert(document.querySelector('dialog').textContent.includes(connection.hostKeyFingerprint), 'Fingerprint remains visible');
  await native({ capture: 'identity-failure' });
}, null);
await test('Upload failure shows one error with a fresh review recovery', async () => {
  await prepare(); await pointer('Upload 2 paths'); await reject(mock.confirms[0], 'SFTP readback did not match the uploaded file. No files verified. Check the robot folder before retrying.');
  assert(controller.phase === 'failed', 'Failed verification cannot report success');
  assert(document.querySelectorAll('[role="alert"]').length === 1, 'One useful error');
  await native({ capture: 'failure' });
  assert(document.querySelector('[role="alert"]').textContent === 'SFTP readback did not match the uploaded file', 'Failure summary is concise');
  const details=document.querySelector('.rfp-error-details');
  assert(details&&!details.open&&details.textContent.includes('No files verified'), 'Details preserve the full readback failure');
  details.querySelector('summary').focus(); await act(async()=>native({key:'Enter'}));
  assert(details.open,'Keyboard opens failure Details');await native({capture:'failure-details'});
  await pointer('Try again'); assert(mock.prepares.length === 2, 'Retry prepares again');
});
await test('Repeated pushes use the remembered robot without connection or identity screens', async () => {
  await prepare(); await pointer('Upload 2 paths');
  await resolve(mock.confirms[0], { state: 'transferred', files, directory: endpoint.directory });
  await pointer('Done'); assert(!controller.open, 'Done returns to the library');
  await prepare();
  assert(!mock.probes.length && !mock.trusts.length, 'No repeated connection or trust step');
  await native({ capture: 'repeat-review' });
});
await test('Editing the destination reuses the known robot identity and keeps the selected paths', async () => {
  await prepare(); await pointer('Change');
  await action(() => controller.setDirectory('/home/lvuser/practice'));
  const changed = { ...connection, endpoint: { ...endpoint, directory: '/home/lvuser/practice' } };
  await pointer('Connect'); await resolve(mock.probes[0], changed);
  assert(mock.trusts.length === 1 && controller.phase === 'trusting', 'Known identity needs no repeated confirmation');
  await resolve(mock.trusts[0], changed);
  await resolve(mock.prepares[1], { ...preview, connection: changed });
  assert(controller.phase === 'review' && mock.prepares[1].args[1].join(',') === 'A,B', 'Selection retained');
  assert(document.querySelector('dialog').textContent.includes('/home/lvuser/practice'), 'Changed directory is reviewed');
  await native({ capture: 'changed-destination' });
});
await test('Held Enter from Push cannot confirm the review it opens', async () => {
  document.querySelector('#origin').focus();
  await act(async () => native({ key: 'Enter' }));
  assert(mock.prepares.length === 1, 'Keyboard Push prepares once');
  await act(async () => native({ key: 'Enter' }));
  await resolve(mock.prepares[0], preview);
  assert(controller.phase === 'review', 'Review is shown');
  assert(document.activeElement?.textContent !== 'Upload 2 paths', 'Upload is not focused automatically');
  await act(async () => native({ key: 'Enter' }));
  assert(!mock.confirms.length, 'Repeated Enter never uploads');
});
await test('Include widens only this review from the captured project, by keyboard, before an explicit Upload', async () => {
  // B shares its last point with Trench run (C), which the selection leaves out.
  const linkedProject = { paths: [{ id: 'A', name: files[0].name, waypoints: [{}, {}] }, { id: 'B', name: files[1].name, waypoints: [{}, { positionLink: 'shared-1' }] },
    { id: 'C', name: 'Trench run', waypoints: [{ positionLink: 'shared-1' }, {}] }], routines: [] };
  props = { ...props, getProject: () => linkedProject }; await act(async () => root.render(<Harness />));
  await prepare();
  const note = () => document.querySelector('.rfp-linked');
  assert(note()?.textContent === 'Linked paths not included: Trench run. Include 1 path', 'Review names the linked path outside the push');
  assert(document.activeElement?.textContent === 'Cancel', 'Cancel keeps first focus, not Include or Upload');
  await native({ capture: 'linked-review' });
  linkedProject.paths.splice(2, 1);
  document.querySelector('.robot-push-close').focus();
  for (let index = 0; index < 6 && !document.activeElement?.textContent.startsWith('Include'); index++) await act(async () => native({ key: 'Tab' }));
  assert(document.activeElement?.textContent === 'Include 1 path', 'Tab reaches Include before the footer');
  await act(async () => native({ key: 'Enter' }));
  assert(mock.canceled.includes('upload-1') && mock.prepares.length === 2, 'Include discards the old review and prepares once');
  assert(mock.prepares[1].args[1].join(',') === 'A,B,C' && mock.prepares[1].args[0].paths.length === 3, 'Captured project, widened in project order');
  const widened = { operationId: 'upload-2', connection, files: [...files, { pathId: 'C', name: 'Trench run', fileName: 'C-path.bdx', size: 2048, sha256: 'd'.repeat(64) }] };
  await resolve(mock.prepares[1], widened);
  assert(controller.phase === 'review' && !note() && button('Upload 3 paths'), 'A new review lists the widened files');
  assert(document.activeElement?.textContent === 'Cancel', 'The new review focuses Cancel');
  assert(!mock.confirms.length && document.querySelector('#origin').textContent === 'Push selection', 'Nothing uploads and the origin is unchanged');
  await native({ capture: 'linked-widened-review' });
  await pointer('Upload 3 paths');
  assert(mock.confirms.length === 1 && mock.confirms[0].args[0] === 'upload-2', 'Only the explicit Upload confirms the widened review');
  await resolve(mock.confirms[0], { state: 'transferred', files: widened.files, directory: endpoint.directory });
  assert(document.querySelector('dialog').textContent.includes('3 paths uploaded'), 'The result counts the widened files');
});
await test('Diagnostics stay reachable after Edit and Back', async () => {
  await action(() => controller.openConnection());
  await pointer('Edit');
  await act(async () => new Promise((resolve) => requestAnimationFrame(resolve)));
  assert(button('Diagnostics')?.checkVisibility(), 'Diagnostics visible while editing');
  await action(() => controller.setHost('other-robot.local'));
  await pointer('Connect'); await resolve(mock.probes[0], { ...connection, endpoint: { ...endpoint, host: 'other-robot.local' }, hostKeyFingerprint: 'SHA256:' + 'b'.repeat(43) });
  assert(controller.phase === 'identity' && button('Diagnostics')?.checkVisibility(), 'Diagnostics visible on identity review');
  await pointer('Back');
  assert(button('Diagnostics')?.checkVisibility(), 'Diagnostics visible after Back');
});
for (const key of ['projectKey','catalogKey','bookmarkKey']) await test('Discard stale preparation after ' + key + ' change', async () => {
  await pointer('Push selection');
  props = { ...props, [key]: 'changed' }; await act(async () => root.render(<Harness />));
  await resolve(mock.prepares[0], preview);
  assert(!controller.preview && controller.phase !== 'review', 'Stale review discarded');
  assert(mock.canceled.includes(preview.operationId), 'Stale immutable operation canceled');
});
await test('Source edits preserve reviewed snapshot while navigation preserves an in-flight upload', async () => {
  await prepare();
  await pointer('Upload 2 paths');
  props = { ...props, projectKey: 'other' }; await act(async () => root.render(<Harness />));
  await action(() => controller.requestPush({ kind: 'paths', pathIds: ['B'] }));
  assert(mock.prepares.length === 1, 'No second upload while confirmation unsettled');
  await resolve(mock.confirms[0], { state: 'transferred', files, directory: endpoint.directory });
  assert(controller.phase === 'transferred', 'Confirmed files retain exact result across navigation');
});
await test('Review cancellation and unsupported routine never upload', async () => {
  await prepare(); await pointer('Cancel'); assert(controller.phase === 'cancelled' && !controller.open, 'Cancel ends review and closes');
  assert(document.activeElement.id === 'origin', 'Cancel returns focus to the push origin');
  await action(() => controller.requestPush({ kind: 'routine', routineId: 'R' }));
  assert(controller.phase === 'unsupported' && !mock.confirms.length, 'Routine cannot upload');
  await action(() => controller.requestPush({ kind: 'project' }));
  assert(controller.phase === 'unsupported' && !mock.confirms.length, 'Full replacement cannot upload');
});
await test('Connection diagnostics portal opens the real local diagnostic flow', async () => {
  await action(() => controller.openConnection());
  assert(button('Diagnostics') && !button('Diagnostics').disabled, 'Diagnostics remains reachable');
  await pointer('Diagnostics');
  assert(!controller.open && document.querySelector('.robot-diagnostics').open, 'Diagnostics opens after connection closes');
  await pointer('Generate preview');
  assert(document.querySelector('[aria-label="Read-only beta diagnostic JSON"]').value === '{}', 'Diagnostic preview remains usable');
  await native({ capture: 'diagnostics' });
});
await test('Keyboard diagnostics return focus to the connection origin without reopening it', async () => {
  document.querySelector('#connection-origin').focus();
  await act(async () => native({ key: 'Enter' }));
  assert(controller.open, 'Enter opens the robot connection');
  for (let index = 0; index < 20 && document.activeElement?.getAttribute('aria-label') !== 'Diagnostics'; index++) await act(async () => native({ key: 'Tab' }));
  assert(document.activeElement?.getAttribute('aria-label') === 'Diagnostics', 'Tab reaches Diagnostics');
  await act(async () => native({ key: 'Enter' }));
  assert(!controller.open && document.querySelector('.robot-diagnostics')?.open, 'Diagnostics replaces the connection dialog');
  assert(document.activeElement?.getAttribute('aria-label') === 'Close diagnostic bundle', 'Focus starts inside diagnostics');
  await act(async () => native({ key: 'Tab' }));
  assert(document.querySelector('.robot-diagnostics').contains(document.activeElement), 'Tab stays inside diagnostics');
  await act(async () => native({ key: 'Escape' }));
  await act(async () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert(!document.querySelector('.robot-diagnostics'), 'Escape closes diagnostics');
  assert(!controller.open, 'Closing diagnostics does not reopen the robot connection');
  assert(document.activeElement?.id === 'connection-origin', 'Focus returns to the control that opened the connection, not body');
});
await test('Long filename and destination remain readable at supported sizes', async () => {
  await pointer('Push selection');
  const long = { ...preview, connection: { ...connection, endpoint: { ...endpoint, directory: endpoint.directory + '/' + 'practice-session-'.repeat(8) } }, files: [{ ...files[0], fileName: 'left-scoring-approach-'.repeat(8) + '.bdx' }, files[1]] };
  await resolve(mock.prepares[0], long);
  await native({ capture: 'long-review' });
  const dialog = document.querySelector('dialog');
  assert(dialog.scrollWidth <= dialog.clientWidth + 1, 'Long metadata cannot cause horizontal clipping');
});
await test('A disconnected robot clears the live green indicator while preserving the verified push receipt', async () => {
  assert(!mock.checks.length, 'Restoring saved trust must not connect');
  await prepare(); await pointer('Upload 2 paths');
  await resolve(mock.confirms[0], { state: 'transferred', files, directory: endpoint.directory });
  await pointer('Done');
  assert(document.querySelector('.push-menu-trigger').dataset.tone === 'good', 'Successful upload is live evidence');
  for (let i = 0; i < 70 && !mock.checks.length; i++) await act(async () => new Promise(resolve => setTimeout(resolve, 100)));
  assert(mock.checks.length === 1, 'Explicit upload starts bounded liveness checks');
  await resolve(mock.checks[0], null);
  assert(document.querySelector('.push-menu-trigger').dataset.tone === 'unset', 'Disconnected robot must not remain green');
  assert(document.querySelector('.push-menu-trigger').getAttribute('aria-label').includes('Disconnected'), 'Disconnect is announced');
  assert(controller.result?.files.length === 2, 'Past receipt remains available');
  await pointer('Manage connection');
  assert(button('Connect'), 'Disconnected state offers reconnect');
  await native({ capture: 'disconnected' });
});
await act(async () => root.render(null));
const report = document.createElement('pre'); report.id = 'verification-report'; report.textContent = JSON.stringify(results, null, 2); document.body.append(report);
