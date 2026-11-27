import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/renderer/styles/app.css';
import '../src/renderer/styles/robot-push.css';
import { RobotPushDialog, useRobotPushController } from '../src/renderer/components/RobotPushDialog';
import { DiagnosticBundleDialog } from '../src/renderer/components/DiagnosticBundleDialog';
import { DEFAULT_ROBOT_PATH_DIRECTORY } from '../src/core/robotFileDelivery';
import { rotateBlueOriginPoint } from '../src/core/math/fieldBounds';
import { ACTIVE_FIELD_REFERENCE } from '../src/core/field/rebuilt2026';
import { PushControl } from '../src/renderer/components/PushControl';
import { UnitPrefs } from '../src/renderer/lib/unitPreferences';
import { createDemoProject } from '../src/core/project/defaults';
import { selectedRobotFile } from '../src/renderer/lib/robotFileMemory';
import { addRobot, renameRobot, selectRobot, setRobotConnection } from '../src/core/project/robots';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const results = [], root = createRoot(document.getElementById('root'));
const endpoint = { target: 'roborio', host: 'roborio-2468-frc.local', port: 22, directory: DEFAULT_ROBOT_PATH_DIRECTORY };
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
function Harness() { controller = useRobotPushController(props); return <><button id="origin" onClick={() => controller.requestPush({ kind: 'paths', pathIds: ['A','B'] })}>Push selection</button><button id="connection-origin" onClick={() => controller.openConnection()}>Manage connection</button><PushControl place={props.place || 'paths'} activeRoutine={{ id: 'R', name: 'Long routine with typed branch and repeated pickup attempts' }} paths={files.map(f => ({ ...f, id: f.pathId, waypoints: [{}, {}] }))} selection={{ selected: props.noSelection ? [] : ['A', 'B'] }} controller={controller} /><RobotPushDialog controller={controller} /><DiagnosticBundleDialog getProject={props.getProject} targetSelector=".robot-connection-diagnostics" onOpen={controller.close} onClose={() => controller.returnFocus()} renderKey={controller.open + ":" + controller.phase} /></>; }
// A project with robot details, for the robot's .robot row in the review; the other checks push paths only.
const robotProject = { ...createDemoProject(), paths: files.map((f) => ({ id: f.pathId, name: f.name, waypoints: [{}, {}] })), routines: [] };
async function mount(saved = connection, options = {}) {
  await act(async () => root.render(null));
  props = { getProject: () => options.project ?? (options.robot ? robotProject : ({ paths: files.map((f) => ({ id: f.pathId, name: f.name })), routines: [] })), projectKey: 'project-1', catalogKey: 'catalog-1' };
  mock = { probes: [], trusts: [], prepares: [], preparesRoutine: [], confirms: [], canceled: [], saves: [], checks: [], lists: [], comparisons: [], copies: [], canceledComparisons: [] };
  const enqueue = (name,args) => { const request = { args: structuredClone(args), ...deferred() }; mock[name].push(request); return request.promise; };
  window.bordeauxAPI = { robotDeliveryCapabilities: { fileTransfer: true, pathPush: true, routinePush: true },
    previewBetaDiagnostic: async () => ({ previewId: 'diagnostic', contents: '{}' }),
    getRobotFileConnection: async () => saved,
    getRobotFilePassword: async () => window.__passwordStatus ?? { custom: false, persistent: true },
    checkRobotFileConnection: (...args) => enqueue('checks', args),
    saveRobotFileSettings: (...args) => enqueue('saves',args),
    cancelRobotFileProbe: async () => {},
    probeRobotFiles: (...args) => enqueue('probes',args), trustRobotFiles: (...args) => enqueue('trusts',args),
    prepareRobotFiles: (...args) => enqueue('prepares',args), confirmRobotFiles: (...args) => enqueue('confirms',args),
    prepareRobotRoutine: (...args) => enqueue('preparesRoutine',args),
    listRobotPaths: (...args) => enqueue('lists', args),
    compareRobotPath: (...args) => enqueue('comparisons', args), saveRobotPathCopy: (...args) => enqueue('copies', args),
    cancelRobotPathCompare: async (id) => { mock.canceledComparisons.push(id); },
    cancelRobotFiles: async (id) => { mock.canceled.push(id); return { canceled: true }; } };
  await act(async () => root.render(<Harness />));
}
async function prepare() { await pointer('Push selection'); await resolve(mock.prepares.at(-1), preview); assert(controller.phase === 'review', 'Must review immutable files'); }
async function test(name, run, saved, options) { if (new URLSearchParams(location.search).get('filter') && !name.includes(new URLSearchParams(location.search).get('filter'))) return; try { await mount(saved, options); await run(); results.push({ name, ok: true }); } catch (error) { results.push({ name, ok: false, error: error.stack }); } }
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
  // Visual order: the robot type choice sits above Host, so Tab reaches its two options first.
  await act(async () => native({ key: 'Tab' }));
  assert(document.activeElement.textContent === 'roboRIO', 'Tab reaches the robot type choice');
  await act(async () => native({ key: 'Tab' })); await act(async () => native({ key: 'Tab' }));
  assert(document.activeElement.tagName === 'INPUT', 'Tab then reaches robot host field');
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
await test('Choosing Systemcore by keyboard moves the default folder, is sent with Connect and is reviewed with the destination', async () => {
  await pointer('Push selection');
  const systemcore = [...document.querySelectorAll('dialog .seg-i')].find((item) => item.textContent === 'Systemcore');
  systemcore.focus(); await act(async () => native({ key: 'Enter' }));
  assert(controller.target === 'systemcore' && controller.directory === '/home/systemcore/bordeaux/paths', 'Keyboard chooses Systemcore and its default folder');
  assert(systemcore.getAttribute('aria-pressed') === 'true' && document.activeElement === systemcore, 'Pressed state follows the choice and focus stays on it');
  assert(document.querySelector('dialog input').placeholder === 'robot.local', 'Host placeholder follows the robot type');
  await action(() => controller.setHost('robot.local'));
  await native({ capture: 'systemcore-connection' });
  await pointer('Connect');
  assert(mock.probes[0].args[0].target === 'systemcore', 'Connect sends the robot type');
  const chosen = { endpoint: { target: 'systemcore', host: 'robot.local', port: 22, directory: '/home/systemcore/bordeaux/paths' }, hostKeyFingerprint: connection.hostKeyFingerprint };
  await resolve(mock.probes[0], chosen);
  await pointer('Trust host key'); await resolve(mock.trusts[0], chosen);
  await resolve(mock.prepares[0], { ...preview, connection: chosen });
  assert(document.querySelector('dialog').textContent.includes('Systemcore · /home/systemcore/bordeaux/paths'), 'Review names the robot type beside the folder');
  await native({ capture: 'systemcore-review' });
}, null);
await test('A custom Systemcore password is typed masked, sent with Connect, and afterwards shown only as saved', async () => {
  window.__passwordStatus = { custom: false, persistent: true };
  await pointer('Push selection');
  await pointer('Systemcore');
  await action(() => { controller.setHost('robot.local'); controller.setPassword('team-2468'); });
  const field = document.querySelector('dialog input[type="password"]');
  assert(field && field.value === 'team-2468' && field.placeholder === 'Default password', 'Typed password is masked in a password field');
  assert(button('Use default'), 'A typed password can be abandoned for the default');
  await native({ capture: 'systemcore-password-typed' });
  await pointer('Connect');
  assert(mock.probes[0].args[1].kind === 'custom' && mock.probes[0].args[1].password === 'team-2468', 'Connect sends the typed password');
  const chosen = { endpoint: { target: 'systemcore', host: 'robot.local', port: 22, directory: '/home/systemcore/bordeaux/paths' }, hostKeyFingerprint: connection.hostKeyFingerprint };
  await resolve(mock.probes[0], chosen);
  window.__passwordStatus = { custom: true, persistent: true };
  await pointer('Trust host key'); await resolve(mock.trusts[0], chosen);
  await resolve(mock.prepares[0], { ...preview, connection: chosen });
  await pointer('Change');
  const saved = document.querySelector('dialog input[type="password"]');
  assert(saved.value === '' && saved.placeholder === 'Saved on this computer', 'Saved password is never shown, only its source');
  await native({ capture: 'systemcore-password-saved' });
  button('Use default').focus(); await act(async () => native({ key: 'Enter' }));
  assert(document.activeElement === saved, 'Focus moves to the password field, not the page');
  assert(saved.placeholder === 'Default password after Save or Connect' && button('Keep saved'), 'The pending default is shown as uncommitted and can be undone');
  await native({ capture: 'systemcore-password-pending-default' });
  await pointer('Keep saved');
  assert(document.activeElement === saved && saved.placeholder === 'Saved on this computer', 'Keep saved restores the saved password');
  window.__passwordStatus = undefined;
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
await test('Review cancellation and unsupported full replacement never upload', async () => {
  await prepare(); await pointer('Cancel'); assert(controller.phase === 'cancelled' && !controller.open, 'Cancel ends review and closes');
  assert(document.activeElement.id === 'origin', 'Cancel returns focus to the push origin');
  await action(() => controller.requestPush({ kind: 'project' }));
  assert(controller.phase === 'unsupported' && !mock.confirms.length, 'Full replacement cannot upload');
});
await test('Routine toolbar uses a scoped immutable review, preserves retry scope and returns keyboard focus', async () => {
  props = { ...props, place: 'routines' }; await act(async () => root.render(<Harness />));
  await native({ capture: 'routine-toolbar' });
  const origin = button('Push routine');
  await pointer('Push routine');
  assert(mock.preparesRoutine.length === 1 && mock.preparesRoutine[0].args[1] === 'R' && !mock.prepares.length, 'Only the selected routine is prepared');
  const routineFiles = [{ pathId: 'R', name: 'Long routine with typed branch and repeated pickup attempts', fileName: 'Long-routine-with-typed-branch-and-repeated-pickup-attempts.bdr', size: 768000, sha256: 'd'.repeat(64) }];
  await resolve(mock.preparesRoutine[0], { ...preview, files: routineFiles });
  assert(button('Upload 1 routine') && !document.querySelector('.rfp-linked'), 'Routine file scope is visible, without widening to paths');
  await native({ capture: 'routine-review' });
  await pointer('Upload 1 routine'); await reject(mock.confirms[0], 'SFTP read-back did not match the routine. Check the destination and try again.');
  await pointer('Try again');
  assert(mock.preparesRoutine.length === 2 && mock.preparesRoutine[1].args[1] === 'R' && !mock.prepares.length, 'Retry retains one-routine scope');
  await resolve(mock.preparesRoutine[1], { ...preview, operationId: 'routine-2', files: routineFiles });
  button('Cancel').focus(); await act(async () => native({ key: 'Tab' }));
  assert(document.activeElement?.textContent === 'Upload 1 routine', 'Keyboard reaches exact routine upload');
  await act(async () => native({ key: 'Enter' }));
  await resolve(mock.confirms[1], { state: 'transferred', files: routineFiles, directory: endpoint.directory });
  assert(document.querySelector('dialog').textContent.includes('1 routine uploaded') && document.querySelector('dialog').textContent.includes('Nothing started'), 'Readback success grants no execution claim');
  await native({ capture: 'routine-success' });
  await act(async () => native({ key: 'Escape' }));
  assert(!controller.open && document.activeElement === origin, 'Escape returns to routine Push: ' + document.activeElement?.outerHTML + ' origin connected=' + origin.isConnected + ' disabled=' + origin.disabled + ' controller.open=' + controller.open + ' dialog.open=' + document.querySelector('dialog').open);
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
// A disclosure chevron points right while closed and down while open; a menu trigger's stays down. The glyph points down.
const turn = (element, pseudo) => { const m = new DOMMatrix(getComputedStyle(element, pseudo).transform); return Math.round(Math.atan2(m.b, m.a) * 180 / Math.PI); };
// Robot files keeps one dialog size per view; captures resize the window, so compare sizes between captures.
const dialogSize = () => { const box = document.querySelector('.rfp').getBoundingClientRect(); return box.width + '×' + box.height; };
async function enterRobotFiles(keyboard = false) {
  props = { ...props, noSelection: true }; await act(async () => root.render(<Harness />));
  const trigger = document.querySelector('.push-menu-trigger');
  if (keyboard) {
    trigger.focus();
    assert(turn(trigger.querySelector('.push-chevron')) === 0, 'The closed Push menu chevron points down to its menu');
    await act(async () => native({ key: 'Enter' }));
    assert(turn(trigger.querySelector('.push-chevron')) === 0, 'The open Push menu chevron still points down');
    await act(async () => native({ key: 'Down' }));
    assert(document.activeElement.textContent === 'Robot files…', 'Arrow Down reaches Robot files');
    await act(async () => native({ key: 'Enter' }));
  } else {
    await pointer(trigger.getAttribute('aria-label'));
    await pointer('Robot files…');
  }
  return trigger;
}
const listedAt = new Date('2026-11-23T16:32:00Z').getTime();
const robotFile = (fileName, size, mtime = listedAt) => ({ fileName, size, mtime });
// Robot folders usually hold files pushed on earlier days, like this one from two days before the listing.
const oldPushAt = listedAt - 2 * 24 * 60 * 60 * 1000;
const inventoryFixture = {
  endpoint, listedAt, missing: false, truncated: false,
  rows: [
    { fileName: 'Old center path.BDX', name: 'Old center path.BDX', kind: 'robotOnly', robot: robotFile('Old center path.BDX', 11832, oldPushAt) },
    { fileName: 'Left-side-scoring.bdx', name: files[0].name, kind: 'paired', pathId: 'A', robot: robotFile('Left-side-scoring.bdx', 18112) },
    { fileName: 'Return-to-pickup.bdx', name: files[1].name, kind: 'localOnly', pathId: 'B' },
  ],
};
const centerTrace = (points) => points.map(([x, y]) => {
  const centered = rotateBlueOriginPoint({ x, y });
  return [centered.x, centered.y];
});
const localRoute = { field: ACTIVE_FIELD_REFERENCE, endHeading: Math.PI - .8, length: .88, width: .71, points: centerTrace([[1.6, 5.9], [2.5, 5.86], [3.5, 5.55], [4.1, 5.12],
  [4.62, 4.46], [4.9, 3.82], [5.01, 3.06], [5.121, 2.4]]) };
const robotRoute = { ...localRoute, endHeading: Math.PI - 1.1, points: centerTrace([[1.6, 5.9], [2.5, 5.86], [3.5, 5.55], [4.24, 5.12],
  [4.88, 4.58], [5.16, 3.96], [5.22, 3.35], [5.124, 2.81]]) };
const [localEndX, localEndY] = localRoute.points.at(-1);
const [robotEndX, robotEndY] = robotRoute.points.at(-1);
const comparisonFixture = (request, extra = {}) => ({
  id: request.args[0], endpoint, readAt: listedAt, verdict: 'different',
  name: files[0].name, fileName: 'Left-side-scoring.bdx',
  routes: { local: localRoute, robot: robotRoute },
  widestGap: { local: localRoute.points.at(-1), robot: robotRoute.points.at(-1) },
  local: { size: 18840, sha256: 'a'.repeat(64) }, robot: { size: 18112, sha256: 'b'.repeat(64) },
  facts: [['Duration', 4.82, 5.10, 's'], ['Distance', 6.31, 6.31, 'm'], ['Peak speed', 2.5, 2.7, 'm/s'],
    ['Events', 3, 4], ['Robot speed limit', 3.2, 3.6, 'm/s'], ['Approx. route gap', '—', 0.42, 'm'], ['End X', localEndX, robotEndX, 'm'], ['End Y', localEndY, robotEndY, 'm']],
  notes: [],
  eventChanges: { omitted: 0, unchanged: 2, rows: [
    { id: 'intake-on', robot: { name: 'Intake on', time: 1.2 }, values: [], notes: [] },
    { id: 'arm-up', local: { name: 'Arm up', time: 0.8 }, robot: { name: 'Arm up', time: 1.1 },
      values: [['height', '1.2', '1.4']], notes: [] },
  ] },
  ...extra,
});
await test('Robot files opens without a selection, compares a matched row and returns to that row', async () => {
  UnitPrefs.set('metric');
  const trigger = await enterRobotFiles(true);
  assert(mock.lists.length === 1 && !mock.comparisons.length && !mock.prepares.length && !mock.confirms.length, 'Inventory reads the folder only');
  assert(document.activeElement.textContent === 'Cancel', 'Listing initially focuses Cancel');
  await native({ capture: 'robot-files-listing' });
  const listSize = dialogSize();
  await resolve(mock.lists[0], inventoryFixture);
  assert(document.activeElement.textContent === 'All 3', 'Inventory focuses its filters');
  assert(dialogSize() === listSize, 'Listing and the list share one dialog size');
  const modified = (fileName) => document.querySelector(`[data-robot-file="${fileName}"]`).closest('tr').cells[1].querySelector('small');
  const oldDate = new Date(oldPushAt).toLocaleDateString([], { month: 'short', day: 'numeric' });
  assert(modified('Old center path.BDX').textContent === oldDate && modified('Old center path.BDX').title === new Date(oldPushAt).toLocaleString(),
    'A file pushed on an earlier day shows its date, with the full time in its title');
  assert(modified('Left-side-scoring.bdx').textContent === new Date(listedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    'A file changed the day of the listing shows its time of day');
  await native({ capture: 'robot-files-inventory' });
  const filterSize = dialogSize();
  await pointer('On both 1');
  assert(!button('Inspect') && button('Compare'), 'On both filter shows just the matched path');
  assert(dialogSize() === filterSize, 'Filtering keeps the dialog size');
  button('Compare').focus();
  await act(async () => native({ key: 'Enter' }));
  const compareSize = dialogSize();
  const request = mock.comparisons[0];
  assert(request?.args[2] === 'A' && request.args[3] === 'Left-side-scoring.bdx', 'Comparison reads just the matched row');
  assert(document.activeElement.textContent === 'Cancel', 'Reading initially focuses Cancel');
  await resolve(request, comparisonFixture(request));
  assert(document.activeElement.classList.contains('rfp-compare-verdict'), 'Review focuses the verdict');
  assert(dialogSize() === compareSize, 'Reading and the comparison share one dialog size');
  const reviewText = document.querySelector('.rfp').textContent;
  assert(!reviewText.includes('Widest gap') && !reviewText.includes('Editable waypoints'), 'The review leaves out the gap and source notes');
  const table = document.querySelector('.rfp-changed-values'), map = document.querySelector('.rfp-field-map');
  assert(!document.querySelector('.rfp-field figcaption'), 'The field has no explanatory caption when both routes can be shown');
  assert(map.querySelectorAll('.rfp-route-stroke').length === 2 && map.querySelectorAll('.rfp-route-arrow').length === 6, 'Both compiled traces show travel direction');
  const start = map.querySelector('g[data-route="local"] .rfp-route-start');
  // Historical blue-origin (1.6, 5.9) is centered (6.6705, -1.8655).
  assert(Math.abs(Number(start.getAttribute('cx')) - (1950.5 + 6.6705 * (3377-524)/16.518)) < .01
    && Math.abs(Number(start.getAttribute('cy')) - (791.5 + 1.8655 * (1488-95)/8.043)) < .01,
  'An off-center BDX waypoint has the same calibrated pixels as the editor');
  assert(map.querySelectorAll('.rfp-route-end').length === 2 && map.querySelector('.rfp-field-gap'), 'Both end footprints and the largest separation are marked');
  assert(!table.textContent.includes('Distance') && table.textContent.includes('5.10 s') && table.textContent.includes('Robot speed limit'), 'Changed timing and settings are highlighted above unchanged values');
  const events = table.querySelector('.rfp-events');
  assert(events && table.querySelectorAll('tbody').length === 2, 'Event changes align under the same local and robot column headers');
  const intake = [...events.rows].find(row => row.cells[0].textContent === 'Intake on');
  assert(intake.cells[1].textContent === 'Not present' && intake.cells[2].textContent === '1.20 s', 'Robot-only events identify the missing side');
  const eventTime = [...events.rows].find(row => row.cells[0].textContent === 'Time');
  assert(eventTime.cells[1].textContent === '0.80 s' && eventTime.cells[2].textContent === '1.10 s', 'Changed times appear in separate columns');
  assert(events.querySelector('th[aria-label="Arm up, height"]') && !document.querySelector('.rfp-compare-notes'), 'Changed inputs have their own rows and event context');
  assert(table.textContent.includes('3.149 m') && table.textContent.includes('3.147 m'), 'Measured changes survive display rounding');
  await native({ capture: 'robot-files-paired-metric' });
  UnitPrefs.set('imperial');
  await act(async () => root.render(<Harness />));
  assert(table.textContent.includes('4.02 ft') && table.textContent.includes('11.81 ft/s'), 'Changed values use the current units');
  assert(document.querySelector('.rfp-field-map').getAttribute('aria-label').includes('ft'), 'The map description uses the current units');
  await native({ capture: 'robot-files-paired-imperial' });
  const fit = map.getAttribute('viewBox');
  await act(async () => native({ key: 'Tab' }));
  assert(document.activeElement.textContent === 'Fit paths', 'Tab reaches view controls from the verdict');
  await act(async () => native({ key: 'Tab' }));
  await act(async () => native({ key: 'Enter' }));
  assert(map.getAttribute('viewBox') !== fit && button('Whole field').getAttribute('aria-pressed') === 'true', 'Whole field changes the visible extent');
  await native({ capture: 'robot-files-whole-field' });
  await pointer('Fit paths');
  await pointer('Robot');
  assert(!map.querySelector('g[data-route="robot"]') && map.getAttribute('viewBox') === fit, 'Toggling Robot keeps the local route and stable framing');
  await pointer('Robot');
  const all = document.querySelector('.rfp-all-values');
  assert(!all.open && all.textContent.includes('20.70 ft'), 'Unchanged distance stays available in All values');
  const summary = all.querySelector('summary'), closedSize = dialogSize();
  assert(turn(summary, '::after') === -45, 'The closed All values chevron points right');
  summary.focus();
  await act(async () => native({ key: 'Enter' }));
  assert(all.open, 'All values is keyboard operable');
  assert(turn(summary, '::after') === 45, 'The open All values chevron points down');
  assert(dialogSize() === closedSize && document.querySelector('.rfp-view-compare').scrollHeight > document.querySelector('.rfp-view-compare').clientHeight,
    'Expanding All values scrolls the review instead of resizing the dialog');
  await native({ capture: 'robot-files-all-values-open' });
  await act(async () => native({ key: 'Enter' }));
  await act(async () => native({ key: 'Tab' }));
  assert(document.activeElement === button('All files'), 'Tab reaches the review footer from All values');
  await act(async () => native({ key: 'Tab' }));
  assert(document.activeElement === button('Download .bdx…') && button('Download .bdx…').closest('footer'), 'Download is keyboard accessible in the footer');
  assert(!button('Compare again'), 'Completed reviews do not offer a redundant repeat action');
  await act(async () => native({ key: 'Enter' }));
  assert(mock.copies[0]?.args[0] === request.args[0] && !mock.confirms.length, 'Save selects the reviewed bytes only');
  await resolve(mock.copies[0], { canceled: true });
  assert(document.activeElement === button('Download .bdx…') && !controller.copy, 'Native cancellation preserves review and focus');
  await pointer('All files');
  assert(document.activeElement === button('Compare') && document.querySelector('[data-verdict="different"]'), 'Back restores the row and keeps its verdict');
  assert(mock.lists.length === 1, 'Back keeps the inventory snapshot');
  await pointer('Compare');
  const conflict = mock.comparisons[1];
  const conflicting = comparisonFixture(conflict, { verdict: 'otherPath', robotName: 'A path from another project', widestGap: undefined });
  conflicting.facts = conflicting.facts.filter(([label]) => !label.startsWith('End ') && label !== 'Approx. route gap');
  await resolve(conflict, conflicting);
  assert(document.querySelector('.rfp-compare-verdict').textContent.includes('replaces that file'), 'Filename conflict warns about replacement');
  assert(document.querySelectorAll('.rfp-route-stroke').length === 2 && !document.querySelector('.rfp-field-gap'), 'Filename conflict shows both routes without presenting them as one revised route');
  await native({ capture: 'robot-files-filename-conflict' });
  await pointer('All files');
  assert(document.querySelector('[data-verdict="otherPath"]').textContent === 'Another path' && button('On both 1'), 'Filename conflict stays visible under On both');
  await act(async () => native({ key: 'Escape' }));
  assert(!controller.open && document.activeElement === trigger && mock.canceledComparisons.includes(request.args[0]), 'Escape returns to Push options');
  UnitPrefs.set('metric');
});
await test('Field comparison handles identical routes and refuses to align incompatible coordinates', async () => {
  await enterRobotFiles();
  await resolve(mock.lists[0], inventoryFixture);
  await pointer('Compare');
  const same = mock.comparisons[0], sameFile = { size: 18840, sha256: 'a'.repeat(64) };
  await resolve(same, comparisonFixture(same, { verdict: 'same', routes: { local: localRoute, robot: localRoute }, local: sameFile, robot: sameFile,
    widestGap: undefined, eventChanges: undefined, notes: [], facts: [['Duration', 4.82, 4.82, 's']] }));
  assert(document.querySelectorAll('.rfp-route-stroke').length === 2 && !document.querySelector('.rfp-changed-values'), 'Matching files show both routes with no changed rows');
  await native({ capture: 'robot-files-field-same' });
  await pointer('All files');
  await pointer('Compare');
  const mismatched = mock.comparisons[1];
  await resolve(mismatched, comparisonFixture(mismatched, { routes: { local: localRoute, robot: { ...robotRoute,
    field: { ...ACTIVE_FIELD_REFERENCE, coordinateSchemaId: 'bordeaux-field/1.0' } } }, widestGap: undefined, eventChanges: undefined, notes: [],
    facts: [['Duration', 4.82, 5.10, 's'], ['Field frame', ACTIVE_FIELD_REFERENCE.coordinateSchemaId, 'bordeaux-field/1.0']] }));
  assert(document.querySelectorAll('.rfp-route-stroke').length === 1 && button('Robot · unsupported frame').disabled, 'Legacy coordinates never appear on the current field');
  assert(document.querySelector('.rfp-field-caution').textContent.includes('can’t be placed') && button('Download .bdx…'), 'Unsupported frame is explained and copy remains available');
  await native({ capture: 'robot-files-field-frame-mismatch' });
  await pointer('All files');
  await pointer('Compare');
  const many = mock.comparisons[2];
  const changes = comparisonFixture(many).eventChanges;
  changes.rows = Array.from({ length: 5 }, (_, i) => ({ id: 'ev-' + i, robot: { name: 'Event ' + i, time: i }, values: [], notes: [] }));
  await resolve(many, comparisonFixture(many, { eventChanges: changes }));
  const showMore = button('Show 1 more event');
  assert(showMore && !document.querySelector('.rfp-events').textContent.includes('Event 4'), 'Long event changes are initially limited');
  showMore.focus();
  await act(async () => native({ key: 'Enter' }));
  assert(document.activeElement.textContent === 'Event 4' && !button('Show 1 more event'), 'Keyboard expansion focuses the first newly revealed event');
});
await test('Inventory retries a failed listing, cancels a row read and reviews a local-only Push', async () => {
  await enterRobotFiles();
  await reject(mock.lists[0], 'Robot SSH host key changed. Connect again before transferring files.');
  assert(button('Try again') && button('Edit connection'), 'List failure offers recovery');
  await native({ capture: 'robot-files-list-failed' });
  await pointer('Try again');
  await resolve(mock.lists[1], inventoryFixture);
  await pointer('Compare');
  const old = mock.comparisons[0];
  await act(async () => native({ key: 'Escape' }));
  await resolve(old, comparisonFixture(old));
  assert(controller.phase === 'listed' && !controller.comparison && mock.canceledComparisons.includes(old.args[0]), 'Escape dismisses only the in-flight row read');
  await pointer('Compare');
  await reject(mock.comparisons[1], 'Robot file could not be read.');
  assert(button('Try again') && !button('Download .bdx…'), 'An unsuccessful comparison offers a retry');
  await pointer('Try again');
  assert(mock.comparisons[2]?.args[3] === mock.comparisons[1].args[3], 'Retry requests the same file');
  await act(async () => native({ key: 'Escape' }));
  await pointer('Local only 1');
  await pointer('Push…');
  assert(mock.prepares[0]?.args[1].join(',') === 'B' && mock.confirms.length === 0, 'Local-only opens the existing scoped Push review');
  await resolve(mock.prepares[0], { ...preview, files: [files[1]] });
  assert(button('Upload 1 path') && !mock.confirms.length, 'Uploading still requires confirmation');
});
await test('Robot files pairs a new robot and downloads an absent local path after inspection', async () => {
  await enterRobotFiles();
  assert(!mock.lists.length && !mock.comparisons.length, 'No listing or download before trust');
  await action(() => controller.setHost(endpoint.host));
  await pointer('Connect'); await resolve(mock.probes[0], connection);
  await pointer('Trust host key'); await resolve(mock.trusts[0], connection);
  assert(mock.lists.length === 1 && !mock.prepares.length, 'Trust continues to the inventory');
  await resolve(mock.lists[0], inventoryFixture);
  const listSize = dialogSize();
  await pointer('Robot only 1');
  await pointer('Inspect');
  assert(dialogSize() === listSize, 'Inspect opens at the list size');
  const request = mock.comparisons[0];
  assert(!request.args[2] && request.args[3] === 'Old center path.BDX', 'Robot-only inspection needs no local path ID');
  await resolve(request, comparisonFixture(request, { verdict: 'robotOnly', robotOnly: true, name: 'Center pickup', routes: { robot: robotRoute },
    fileName: 'Old center path.BDX', robot: { size: 11832, sha256: 'b'.repeat(64) }, local: undefined,
    facts: [['Duration', '—', 4.4, 's'], ['Distance', '—', 5.2, 'm'], ['Peak speed', '—', 2.4, 'm/s'],
      ['Events', '—', 2], ['Field frame', '—', ACTIVE_FIELD_REFERENCE.coordinateSchemaId], ['Planner', '—', 'bezier'], ['Format', '—', 'BDX 1.1']],
    eventChanges: { omitted: 0, rows: [['Intake on', 1.2], ['Intake off', 3.9]].map(([name, time]) =>
      ({ id: name, robot: { name, time }, values: [], notes: [] })) } }));
  assert(dialogSize() === listSize, 'Reading and the inspected file share the list size');
  assert(!button('Read again') && button('Download .bdx…')?.closest('footer') && !document.querySelector('.rfp-compare-table').textContent.includes('This computer'), 'Robot-only details show only deployed values');
  assert(document.querySelector('.rfp-events').textContent.includes('Intake off3.90 s')
    && !document.querySelector('.rfp-events').textContent.includes('Not present'), 'Robot-only review lists events in one value column');
  await native({ capture: 'robot-files-orphan' });
  const inspectSize = dialogSize();
  await pointer('Download .bdx…');
  await reject(mock.copies[0], 'Paths/ is rebuilt from your project on every Save. Choose another folder.');
  assert(button('Download .bdx…') && document.querySelector('footer .rfp-alert'), 'Save failure appears next to the download action');
  await native({ capture: 'robot-files-copy-failure' });
  await pointer('Download .bdx…');
  await resolve(mock.copies[1], { name: 'Old center path.BDX', folder: 'Downloads', size: 11832 });
  assert(document.querySelector('dialog').textContent.includes('11,832 bytes verified'), 'Copy confirms the original filename and exact byte count');
  assert(dialogSize() === inspectSize, 'A download failure or result keeps the dialog size');
  await native({ capture: 'robot-files-copy-saved' });
  const dialogBox = document.querySelector('.rfp').getBoundingClientRect(), doneBox = button('Done').getBoundingClientRect();
  assert(doneBox.bottom <= dialogBox.bottom && doneBox.bottom <= innerHeight, 'Copy result keeps the footer inside the window');
  assert(Math.abs(doneBox.top - button('Download .bdx…').getBoundingClientRect().top) <= 1, 'Download and Done stay on the same footer row');
  props = { ...props, projectKey: 'other' }; await act(async () => root.render(<Harness />));
  assert(!controller.comparison && !controller.inventory && !button('Download .bdx…') && document.querySelector('.rfp-alert').textContent.includes('The project changed'), 'Project switch invalidates the file and inventory');
}, null);
await test('Inspecting a robot file that matches a local path draws both routes at the field size', async () => {
  // Inventory pairs rows by filename; the desktop then matches by the path ID saved in the file. A file pushed before
  // its path was renamed, or one of two local paths sharing a filename, comes back from Inspect as a full comparison.
  const conflictRow = { fileName: 'Center-pickup.bdx', name: 'Center pickup · Center pickup copy', kind: 'conflict',
    robot: robotFile('Center-pickup.bdx', 15020), detail: '2 local paths use this filename' };
  await enterRobotFiles();
  await resolve(mock.lists[0], { ...inventoryFixture, rows: [...inventoryFixture.rows, conflictRow] });
  const listSize = dialogSize();
  await pointer('Compare');
  const compared = mock.comparisons[0];
  await resolve(compared, comparisonFixture(compared));
  const fieldSize = dialogSize();
  assert(document.querySelector('.rfp').classList.contains('rfp-field-dialog') && fieldSize !== listSize, 'Compare uses the field size');
  const robotRouteDrawn = (message) => {
    const stroke = (route) => getComputedStyle(document.querySelector(`.rfp-field-map [data-route=${route}] .rfp-route-stroke`)).stroke;
    assert(stroke('robot') !== 'none' && stroke('robot') !== stroke('local'), message + ': the robot route is drawn in its own color');
    for (const swatch of [document.querySelector('.rfp-field-tools [data-route=robot]'), document.querySelector('.rfp-changed-values thead th:last-child')]) {
      const line = getComputedStyle(swatch, '::before');
      assert(line.borderTopStyle === 'dashed' && line.borderTopWidth === '2px' && line.borderTopColor === stroke('robot'), message + ': the robot legend swatch matches the route');
    }
  };
  robotRouteDrawn('Compare');
  await pointer('All files');
  await pointer('Inspect Old center path.BDX');
  const renamed = mock.comparisons[1];
  assert(!renamed.args[2] && dialogSize() === listSize, 'Inspect reads at the list size');
  await resolve(renamed, comparisonFixture(renamed, { fileName: 'Old center path.BDX', expectedFileName: 'Left-side-scoring.bdx' }));
  assert(document.querySelector('.rfp').textContent.includes('Push uses its current filename, Left-side-scoring.bdx.'), 'The review names the renamed file');
  robotRouteDrawn('Renamed path');
  assert(document.querySelector('.rfp-field-dialog') && dialogSize() === fieldSize, 'A renamed path’s comparison grows to the field size');
  await native({ capture: 'robot-files-renamed-inspect' });
  await pointer('All files');
  await pointer('Inspect ' + conflictRow.name);
  const conflict = mock.comparisons[2];
  await resolve(conflict, comparisonFixture(conflict, { fileName: conflictRow.fileName, name: 'Center pickup' }));
  assert(document.querySelector('.rfp-field-dialog') && document.querySelectorAll('.rfp-route-stroke').length === 2, 'A filename conflict that matches by ID shows the field');
  robotRouteDrawn('Filename conflict');
  await native({ capture: 'robot-files-conflict-inspect' });
});
await test('A missing robot folder leaves local paths available and reports no robot files', async () => {
  await enterRobotFiles();
  await resolve(mock.lists[0], { ...inventoryFixture, missing: true, rows: [inventoryFixture.rows[2]] });
  assert(document.querySelector('dialog').textContent.includes('folder is missing') && button('Push…') && !button('Inspect'), 'Missing folder is read-only and preserves local-only actions');
  await native({ capture: 'robot-files-missing-folder' });
});
await test('The robot\'s details are one more reviewed row: checked while unknown, left out and back by pointer and keyboard, uploaded with the paths, then unchanged', async () => {
  const robot = selectedRobotFile(robotProject);
  const robotRow = { pathId: 'robot:robot', name: 'Robot', fileName: robot.fileName, size: robot.size, sha256: robot.sha256 };
  const reviewWith = (operationId, included) => ({ operationId, connection, files: included ? [...files, robotRow] : files });
  const checkbox = () => document.querySelector('#rfp-robot-file');
  const row = () => document.querySelector('.rfp-robot-file').textContent;
  await pointer('Push selection');
  assert(JSON.stringify(mock.prepares[0].args[2]) === JSON.stringify({ robotFile: true }), 'A robot file the robot may not hold is included by default');
  await resolve(mock.prepares[0], reviewWith('robot-1', true));
  assert(checkbox().checked && row().includes('Robot details · Robot') && row().includes('Not pushed or pulled from here yet') && row().includes('Robot.robot'), 'The robot row is checked and says why');
  assert(button('Upload 2 paths and robot details'), 'Upload names the robot details');
  await native({ capture: 'robot-row-checked' });
  const box = checkbox().getBoundingClientRect();
  await act(async () => native({ pointer: { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) } }));
  assert(mock.canceled.includes('robot-1') && JSON.stringify(mock.prepares[1].args[2]) === JSON.stringify({ robotFile: false }), 'Leaving it out discards the review and prepares again without it');
  assert(mock.prepares[1].args[1].join(',') === 'A,B', 'The same paths are reviewed again');
  await resolve(mock.prepares[1], reviewWith('robot-2', false));
  assert(!checkbox().checked && row().includes('not sent') && button('Upload 2 paths'), 'Unchecked: the robot file is not sent');
  assert(document.activeElement === checkbox(), 'Focus returns to the checkbox');
  await native({ capture: 'robot-row-unchecked' });
  await act(async () => native({ key: 'Space' }));
  assert(JSON.stringify(mock.prepares[2].args[2]) === JSON.stringify({ robotFile: true }), 'Space includes it again');
  await resolve(mock.prepares[2], reviewWith('robot-3', true));
  assert(checkbox().checked && document.activeElement === checkbox(), 'Checked again with focus kept');
  await pointer('Upload 2 paths and robot details');
  assert(mock.confirms.length === 1 && mock.confirms[0].args[0] === 'robot-3', 'Upload confirms the reviewed batch');
  await resolve(mock.confirms[0], { state: 'transferred', files: [...files, robotRow], directory: endpoint.directory });
  assert(document.querySelector('dialog').textContent.includes('2 paths and robot details uploaded'), 'The result names the robot details');
  await native({ capture: 'robot-row-uploaded' });
  await act(async () => native({ key: 'Escape' }));
  await pointer('Push selection');
  assert(JSON.stringify(mock.prepares[3].args[2]) === JSON.stringify({ robotFile: false }), 'The robot now holds these details, so the next push leaves them out');
  await resolve(mock.prepares[3], reviewWith('robot-4', false));
  assert(!checkbox().checked && row().includes('Same as on the robot'), 'The row says the robot has them');
  await native({ capture: 'robot-row-same' });
}, connection, { robot: true });
// "Comp bot" and "Comp-bot" both push as Comp-bot.robot: the row stays unchecked, can't be checked, and names both.
const collisionProject = selectRobot(addRobot(renameRobot(setRobotConnection({ ...robotProject }, connection.endpoint), 'robot', 'Comp bot'), 'Comp-bot'), 'robot');
await test('A robot whose name pushes to the same file as another robot\'s is never sent, and the row names both', async () => {
  const checkbox = () => document.querySelector('#rfp-robot-file');
  const row = () => document.querySelector('.rfp-robot-file').textContent;
  await pointer('Push selection');
  assert(JSON.stringify(mock.prepares[0].args[2]) === JSON.stringify({ robotFile: false }), 'The colliding file is not prepared');
  await resolve(mock.prepares[0], { operationId: 'collide-1', connection, files });
  assert(!checkbox().checked && checkbox().disabled, 'Unchecked and unavailable');
  assert(row().includes('“Comp bot” and “Comp-bot” would both use Comp-bot.robot on the robot. Rename one of them to push or pull its details.'), 'The row says why');
  assert(row().includes('not sent') && button('Upload 2 paths'), 'Upload sends only the paths');
  await act(async () => { checkbox().click(); });
  assert(mock.prepares.length === 1, 'Clicking the disabled checkbox prepares nothing');
  await native({ capture: 'robot-row-collision' });
}, connection, { robot: true, project: collisionProject });
await act(async () => root.render(null));
const report = document.createElement('pre'); report.id = 'verification-report'; report.textContent = JSON.stringify(results, null, 2); document.body.append(report);
