// Actual main/preload/renderer lifecycle. Only installer, dialog refusal, and named timer/I/O faults are fixtures.
const { app, BrowserWindow, Menu, autoUpdater, ipcMain, dialog } = require('electron');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path');
const assert = require('node:assert/strict'), { createHash } = require('node:crypto');
const output = process.env.BORDEAUX_SMOKE_DIRECTORY;
assert.ok(output && path.isAbsolute(output), 'An isolated fixture directory is required');
const fixture = JSON.parse(fs.readFileSync(path.join(output, 'fixture.json'), 'utf8'));
app.setPath('documents', path.join(output, 'Documents'));
Object.defineProperty(app, 'isPackaged', { value: true });
app.getVersion = () => require('../package.json').version;
const result = { status: 'running', versions: process.versions, events: [], checks: [], cleanupPasses: 0, installerCalls: 0, errors: [] };
let win, started = false, completed = false, releaseWrite;
const realTimeout = global.setTimeout;
// Exercise real callbacks with explicit acceleration: controller stall60s→100ms and approved exit15s→1s.
global.setTimeout = (callback, ms, ...args) => realTimeout(callback, ms === 60_000 ? 100 : ms === 15_000 ? 1_000 : ms, ...args);
const delay = ms => new Promise(resolve => realTimeout(resolve, ms));
const write = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
const record = (kind, value) => { result.events.push({ kind, at: Date.now(), value }); write(); };
const evaluate = (fn, ...args) => win.webContents.executeJavaScript('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')');
const source = () => JSON.parse(fs.readFileSync(fixture.workspace, 'utf8')).project;
const sourceHash = () => createHash('sha256').update(fs.readFileSync(fixture.workspace)).digest('hex');
const bdxHashes = () => Object.fromEntries(fs.readdirSync(path.join(fixture.folder, 'Paths')).filter(name => name.endsWith('.bdx')).sort().map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(fixture.folder, 'Paths', name))).digest('hex')]));
async function fail(error) {
  if (completed) return;
  completed = true; releaseWrite?.(); result.status = 'failed'; result.errors.push(error.stack || String(error));
  if (win && !win.isDestroyed()) {
    try { result.dom = await evaluate(() => ({ text: document.body.innerText.slice(0, 16000), focus: document.activeElement?.outerHTML })); fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG()); } catch {}
  }
  write(); console.error(error); process.exit(1);
}
process.on('uncaughtException', error => void fail(error)); process.on('unhandledRejection', error => void fail(error));
async function wait(test, label, ms = 12_000) { const end = Date.now() + ms; while (Date.now() < end) { if (await test()) return; await delay(20); } throw Error('Timed out: ' + label); }
function key(keyCode, modifiers = []) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); }
async function pointer(selector, text) {
  const point = await evaluate((selector, text) => {
    const node = [...document.querySelectorAll(selector)].find(el => text === undefined || el.textContent.trim() === text);
    if (!node || node.disabled || node.closest('[inert]')) throw Error('Unavailable pointer target: ' + selector);
    node.scrollIntoView({ block: 'nearest' }); const r = node.getBoundingClientRect(), x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    if (!node.contains(document.elementFromPoint(x, y))) throw Error('Pointer target is occluded'); return { x, y };
  }, selector, ...(text === undefined ? [] : [text]));
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point }); win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 }); win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 }); await delay(30);
}
async function inputSelector() {
  await pointer('.pt-wp[data-selection="wp:0"]');
  await wait(() => evaluate(() => [...document.querySelectorAll('.pp .numrow')].some(row => row.querySelector('label')?.textContent === 'X')), 'X inspector');
  return evaluate(() => '#' + CSS.escape([...document.querySelectorAll('.pp .numrow')].find(row => row.querySelector('label')?.textContent === 'X').querySelector('input').id));
}
async function type(selector, value) {
  app.focus({ steal: true }); win.focus(); win.webContents.focus(); await wait(() => evaluate(() => document.hasFocus()), 'native focus'); await pointer(selector);
  await wait(() => evaluate(selector => document.activeElement === document.querySelector(selector), selector), 'field focus'); key('Home'); key('End', ['shift']);
  await wait(() => evaluate(selector => { const el = document.querySelector(selector); return el.selectionStart === 0 && el.selectionEnd === el.value.length; }, selector), 'native selection');
  for (const keyCode of String(value)) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode }); win.webContents.sendInputEvent({ type: 'char', keyCode }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); }
  await wait(() => evaluate((selector, value) => document.activeElement === document.querySelector(selector) && document.activeElement.value === String(value), selector, value), 'exact authored native text');
}
const handle = ipcMain.handle.bind(ipcMain);
const localRobotReads = new Set(['robot:getPairing', 'robotFiles:connection']);
ipcMain.handle = (channel, listener) => handle(channel, async (event, ...args) => {
  if (/^(robot|robotFiles):/.test(channel) && !localRobotReads.has(channel)) { void fail(Error('Local persistence attempted robot operation: ' + channel)); throw Error('Robot action forbidden'); }
  if (channel === 'project:departureResponse' || channel === 'project:editingResumed') record(channel + ':received', args);
  const value = await listener(event, ...args);
  if (channel === 'project:departureResponse' || channel === 'project:editingResumed' || channel === 'project:saveWithCheckpoint') record(channel + ':returned', { args, result: value });
  return value;
});
dialog.showMessageBox = async () => { void fail(Error('Unexpected native fallback cannot count as live source approval')); return { response: 0, checkboxChecked: false }; };
dialog.showOpenDialog = async () => { void fail(Error('Unexpected picker in seeded source scenario')); return { canceled: true, filePaths: [] }; };
const updater = new EventEmitter(); updater.setFeedURL = () => {}; updater.checkForUpdates = async () => {};
updater.downloadUpdate = async () => { updater.emit('update-downloaded', { version: '99.0.0' }); };
updater.quitAndInstall = () => {
  try { result.installerCalls++; assert.equal(result.installerCalls, 1); assert.equal(source().paths[0].waypoints[0].x, fixture.firstX, 'Authored source must already be durable before installer invocation'); } catch (error) { void fail(error); throw error; }
  record('installer', { sourceHash: sourceHash(), firstX: fixture.firstX });
  setImmediate(() => void (async () => {
    await wait(async () => (await evaluate(() => window.bordeauxAPI.getAppUpdateState())).installStalled, 'actual controller stalled state');
    const state = await evaluate(() => window.bordeauxAPI.getAppUpdateState()); assert.ok(state.installAttemptId); result.installAttemptId = state.installAttemptId;
    const file = Menu.getApplicationMenu().items.find(item => item.label === 'File'); const save = file.submenu.items.find(item => item.label === 'Save'); assert.ok(save.enabled);
    // The approved start-install sheet yields to the panel: exactly one modal, the panel, fencing the editor and holding focus.
    const modals = () => evaluate(() => [...document.querySelectorAll('dialog:modal, [role="dialog"][aria-modal="true"]')].map(node => node.matches('.app-update-install') ? 'app-update-dialog' : node.className || node.tagName));
    await wait(async () => JSON.stringify(await modals()) === '["app-update-dialog"]', 'stalled update panel as the only modal');
    const owner = await evaluate(() => { const panel = document.querySelector('.app-update-dialog'); return { modal: panel.matches(':modal'), focus: panel.contains(document.activeElement), pending: Boolean(document.querySelector('.pj-pending')), title: panel.querySelector('#app-update-title')?.textContent }; });
    assert.deepEqual(owner, { modal: true, focus: true, pending: false, title: 'Restart delayed' }); result.stalledOwner = owner;
    await delay(120);
    const centered = await evaluate(() => { const r = document.querySelector('.app-update-dialog').getBoundingClientRect(); return Math.abs(r.x + r.width / 2 - innerWidth / 2) < 1 && Math.abs(r.y + r.height / 2 - innerHeight / 2) < 1; });
    assert.equal(centered, true, 'Install recovery remains centered after the anchored popover/confirmation handoff');
    fs.writeFileSync(path.join(output, 'stalled-panel.png'), (await win.webContents.capturePage()).toPNG());
    // Optional root visual evidence at the supported sizes; Close must stay unoccluded at each before the real pointer press.
    if (process.env.BORDEAUX_UPDATE_QUIT_SIZES === '1') {
      const original = win.getContentSize();
      for (const [width, height] of [[1440, 900], [1100, 720]]) {
        win.setContentSize(width, height); await wait(async () => { const v = await evaluate(() => [innerWidth, innerHeight]); return v[0] === width && v[1] === height; }, `content ${width}x${height}`);
        await evaluate(() => { const node = [...document.querySelectorAll('.app-update-dialog button')].find(el => el.textContent.trim() === 'Close'), r = node.getBoundingClientRect();
          if (node.disabled || !node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))) throw Error('Close unreachable'); });
        fs.writeFileSync(path.join(output, `stalled-panel-${width}x${height}.png`), (await win.webContents.capturePage()).toPNG());
      }
      win.setContentSize(...original); result.checks.push('stalled-close-reachable-at-supported-sizes');
    }
    const handoff = await evaluate(() => window.__updateHandoff); result.updateHandoff = handoff;
    assert.deepEqual(handoff, { pending: true, panel: true, gaps: [] }, 'The pending sheet must hand the editor fence to the update panel with no modal-free task boundary');
    result.checks.push('single-update-modal-owns-stalled-close', 'pending-to-panel-handoff-without-unfenced-boundary');
    await pointer('.app-update-dialog button', 'Close');
    await wait(async () => !(await evaluate(() => window.bordeauxAPI.getAppUpdateState())).visible, 'acknowledged stalled panel release');
    assert.ok(result.events.some(item => item.kind === 'project:editingResumed:returned' && item.value.result.accepted === true && item.value.args[1] === state.installAttemptId));
    // Exercise the actual Save menu now editing is released: real source-first Save refreshes BDX for Git sharing.
    const savesBefore = result.events.filter(item => item.kind === 'project:saveWithCheckpoint:returned').length;
    save.click(save, win, {});
    await wait(() => result.events.filter(item => item.kind === 'project:saveWithCheckpoint:returned').length > savesBefore, 'actual native Save result');
    const saved = result.events.filter(item => item.kind === 'project:saveWithCheckpoint:returned').at(-1).value.result;
    assert.equal(saved.saved, true);
    assert.equal(saved.exportError, undefined, 'Explicit Save must export BDX: ' + saved.exportError);
    assert.ok(saved.bdxCount > 0, 'Explicit Save must produce at least one BDX path');
    result.bdxAfterExplicitSave = bdxHashes(); assert.ok(Object.keys(result.bdxAfterExplicitSave).length > 0); result.saveAvailable = true;
    await type(await inputSelector(), fixture.secondX);
    let entered; const atWrite = new Promise(resolve => entered = resolve), gate = new Promise(resolve => releaseWrite = resolve); const rename = fsp.rename; let held = false;
    fsp.rename = async (...args) => { if (!held && String(args[1]) === fixture.workspace) { held = true; entered(); await gate; } return rename.apply(fsp, args); };
    try {
      autoUpdater.emit('before-quit-for-update'); app.quit();
      await Promise.race([atWrite, delay(5000).then(() => { throw Error('Fresh late-handoff source write did not arrive'); })]);
      await delay(1_200); assert.equal(win.isDestroyed(), false, 'No forced exit/window destruction while fresh source remains pending beyond accelerated 15s grace');
      result.checks.push('no-force-exit-before-fresh-approval'); record('release-source-write', { priorX: source().paths[0].waypoints[0].x }); releaseWrite();
    } finally { releaseWrite?.(); fsp.rename = rename; }
  })().catch(fail));
};
const updaterModule = require.resolve('electron-updater'); require(updaterModule); require.cache[updaterModule].exports = { autoUpdater: updater };
app.on('browser-window-created', (_event, window) => {
  if (started) return; started = true; win = window;
  window.webContents.on('console-message', details => { if (details.level === 'error' && !details.message.startsWith("Loading the font 'data:")) console.error('Renderer:', details.message); });
  const send = window.webContents.send.bind(window.webContents); window.webContents.send = (channel, payload) => { if (channel === 'project:departure' || channel === 'project:checkpointUpdate') record(channel, payload); return send(channel, payload); };
  window.once('closed', () => { result.closed = true; result.diskAtClosed = source(); result.sourceHashAtClosed = sourceHash(); write(); });
  window.webContents.once('did-finish-load', () => void (async () => {
    window.show(); app.focus({ steal: true }); window.focus(); window.webContents.focus();
    await wait(() => evaluate(async () => Boolean(window.bordeauxAPI && (await window.bordeauxAPI.getProjectSession()).lifecycleReady && document.querySelector('.pt-wp'))), 'actual project startup/readiness');
    const session = await evaluate(() => window.bordeauxAPI.getProjectSession()); assert.equal(session.location.folderPath, fixture.folder);
    await type(await inputSelector(), fixture.firstX); updater.emit('update-available', { version: '99.0.0' });
    await evaluate(() => window.bordeauxAPI.downloadAppUpdate());
    // Exact handoff boundary: mutation callbacks run before the next task or paint, so once the pending sheet has fenced
    // the editor, every callback until the panel opens must still see a modal. An empty one is an unfenced frame or key.
    await evaluate(() => {
      const probe = window.__updateHandoff = { pending: false, panel: false, gaps: [] };
      const check = () => {
        const open = [...document.querySelectorAll('dialog:modal, [role="dialog"][aria-modal="true"]')].map(node => node.matches('.app-update-install') ? 'app-update-dialog' : node.className || node.tagName);
        if (open.includes('pj-sheet pj-pending')) probe.pending = true;
        if (open.includes('app-update-dialog')) probe.panel = true;
        else if (probe.pending && !open.length) probe.gaps.push(performance.now());
        if (probe.panel) observer.disconnect();
      };
      const observer = new MutationObserver(check);
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'aria-modal'] }); check();
    });
    await wait(() => evaluate(() => Boolean(document.querySelector('.update-chip.downloaded'))), 'downloaded update chip');
    await pointer('.update-chip');
    await wait(() => evaluate(() => document.querySelector('.app-update-confirm')?.matches(':modal')), 'native restart confirmation');
    assert.equal(result.installerCalls, 0, 'Opening confirmation must not install');
    await pointer('.app-update-confirm button', 'Update');
  })().catch(fail));
});
require('../dist-electron/electron/main.js');
app.on('will-quit', () => { result.cleanupPasses++; });
app.on('quit', () => {
  try {
    assert.equal(result.closed, true); assert.equal(result.diskAtClosed.paths[0].waypoints[0].x, fixture.secondX); assert.equal(result.installerCalls, 1); assert.ok(result.cleanupPasses >= 2);
    const requests = result.events.filter(item => item.kind === 'project:departure').map(item => item.value);
    const start = requests.find(item => item.update?.continuation === 'start-install'), finish = requests.find(item => item.update?.continuation === 'finish-handoff');
    assert.ok(start && finish); assert.notEqual(start.requestId, finish.requestId); assert.equal(start.update.attemptId, finish.update.attemptId);
    for (const request of [start, finish]) {
      const accepted = result.events.find(item => item.kind === 'project:departureResponse:returned' && item.value.result.accepted && item.value.args[0].requestId === request.requestId && item.value.args[0].outcome === 'saved'); assert.ok(accepted);
      const response = accepted.value.args[0]; assert.ok(result.events.some(item => item.kind === 'project:checkpointUpdate' && item.value.operationId === response.operationId && item.value.sourceReceipt?.receiptId === response.receiptId && item.value.source === 'saved'));
    }
    assert.deepEqual(bdxHashes(), result.bdxAfterExplicitSave, 'The later lifecycle checkpoint must preserve explicit Save BDX unchanged');
    result.status = 'passed'; result.quit = true; completed = true; result.checks.push('real-authored-source-before-installer', 'fresh-receipt-before-native-close', 'one-installer-call', 'bounded-cleanup-reentry', 'explicit-save-refreshes-bdx', 'lifecycle-preserves-bdx'); write();
  } catch (error) { result.status = 'failed'; result.errors.push(error.stack); write(); process.exitCode = 1; }
});
