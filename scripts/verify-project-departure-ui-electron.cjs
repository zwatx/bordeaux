// Observe the production main/preload/renderer. No checkpoint, model, receipt or approval is fabricated here.
const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const output = process.env.BORDEAUX_DEPARTURE_FIXTURE;
const stage = process.env.BORDEAUX_DEPARTURE_STAGE;
assert.ok(output && path.isAbsolute(output), 'Isolated fixture directory required');
assert.ok(stage === 'exercise' || stage === 'relaunch', 'Explicit fixture stage required');
assert.equal(process.env.BORDEAUX_SMOKE_DIRECTORY, path.join(output, 'userData'));
const fixture = JSON.parse(fs.readFileSync(path.join(output, 'fixture.json'), 'utf8'));
app.setPath('userData', path.join(output, 'userData'));
app.setPath('documents', path.join(output, 'Documents'));
const result = { status: 'running', scenario: fixture.scenario, stage, versions: process.versions,
  events: [], checks: [], errors: [], dialogs: [], robotCalls: [], nativeLoads: 0, nativeCloses: 0 };
let win, started = false, finishing = false, actionStarted = false;
const permissionRestores = [];
const write = () => fs.writeFileSync(path.join(output, stage + '.json'), JSON.stringify(result, null, 2) + '\n');
const record = (kind, data) => { result.events.push({ kind, at: Date.now(), data }); write(); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function restorePermissions() { for (const [file, mode] of permissionRestores.reverse()) { try { fs.chmodSync(file, mode); } catch {} } }
async function fail(error) {
  if (finishing) return;
  finishing = true; result.status = 'failed'; result.failure = error.stack || String(error);
  if (win && !win.isDestroyed()) {
    try { result.dom = await win.webContents.executeJavaScript('({text:document.body.innerText.slice(0,16000),focus:document.activeElement?.outerHTML,focused:document.hasFocus()})'); } catch {}
    try { fs.writeFileSync(path.join(output, stage + '-failure.png'), (await win.webContents.capturePage()).toPNG()); } catch {}
  }
  restorePermissions(); write(); console.error(result.failure);
  // Abort only this failed test process. app.exit() destroys an unapproved window and
  // legitimately starts the production crash fallback; that is not successful cleanup.
  process.exit(1);
}
process.on('uncaughtException', error => void fail(error));
process.on('unhandledRejection', error => void fail(error));

// Spy preserves actual handlers and their results. Reject only forbidden robot actions before any transport can run.
const handle = ipcMain.handle.bind(ipcMain);
const localRobotReads = new Set(['robot:getPairing', 'robotFiles:connection']);
ipcMain.handle = (channel, listener) => handle(channel, async (event, ...args) => {
  if (/^(robot|robotFiles):/.test(channel) && !localRobotReads.has(channel)) {
    result.robotCalls.push(channel); void fail(new Error('Local lifecycle attempted forbidden robot action: ' + channel));
    throw new Error('Robot boundary blocked by isolated harness');
  }
  if (channel === 'project:departureResponse' || channel === 'project:departureResume') record(channel + ':received', args[0]);
  try {
    const value = await listener(event, ...args);
    if (channel === 'project:departureResponse' || channel === 'project:departureResume') record(channel + ':returned', { request: args[0], result: value });
    return value;
  } catch (error) {
    if (channel.startsWith('project:')) record(channel + ':error', error.message);
    throw error;
  }
});
// Dialog boundary substitution is deliberately a failure, not a successful fallback/save acknowledgement.
dialog.showMessageBox = async (...args) => {
  const options = args.at(-1); result.dialogs.push({ kind: 'message', title: options.title, message: options.message, buttons: options.buttons });
  void fail(new Error('Unexpected native dialog; live renderer scenario cannot pass through mocked native approval'));
  return { response: options.cancelId ?? 0, checkboxChecked: false };
};
dialog.showOpenDialog = async (...args) => {
  result.dialogs.push({ kind: 'open', title: args.at(-1).title });
  void fail(new Error('Unexpected folder picker in this bounded scenario'));
  return { canceled: true, filePaths: [] };
};
const evaluate = (fn, ...args) => win.webContents.executeJavaScript('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')');
async function wait(fn, label, timeout = 12_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await fn()) return; await delay(25); }
  throw new Error('Timed out: ' + label);
}
async function focus() {
  app.focus({ steal: true }); win.show(); win.focus(); win.webContents.focus();
  await wait(() => evaluate(() => document.hasFocus()), 'native document focus', 2000);
  assert.equal(win.isFocused(), true, 'BrowserWindow must own native focus');
}
function key(keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
}
async function pointer(selector, text) {
  const point = await evaluate((selector, text) => {
    const el = [...document.querySelectorAll(selector)].find(node => text === undefined || node.textContent.trim() === text);
    if (!el || el.disabled || el.closest('[inert]')) throw new Error('Pointer target unavailable: ' + selector + ' ' + text);
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect(), x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    if (!el.contains(document.elementFromPoint(x, y))) throw new Error('Pointer target occluded');
    return { x, y };
  }, selector, ...(text === undefined ? [] : [text]));
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
  await delay(40);
}
async function screenshot(name) { fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
const { attachProjectSheetObservation, assertObservationStarted } = require('../work/rethink/native-recovery-observation.cjs');
async function editorReady() {
  await wait(() => evaluate(async () => Boolean(window.bordeauxAPI
    && (await window.bordeauxAPI.getProjectSession()).lifecycleReady
    && document.querySelector('.toolbar'))), 'production startup and lifecycle readiness');
  await focus();
  // Every editorReady call in these nine cases starts from a real healthy saved source. A successful
  // close/relaunch or protected reload must stay quiet; never hide an unintended recovery re-offer with Escape.
  await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await evaluate(() => Boolean(document.querySelector('dialog[open][aria-label="Projects"]'))), false, 'Clean saved source must not open Projects on startup/relaunch/reload');
  assert.equal(await evaluate(() => Boolean(document.querySelector('[role="dialog"], dialog[open]'))), false, 'Healthy startup must have no unexpected modal');
  const observation = await evaluate(() => window.__bordeauxFallbackSheets.snapshot());
  assertObservationStarted(observation);
  assert.equal(observation.openings, 0, 'No transient Projects opening before readiness'); assert.equal(observation.overlapped, false);
  record('startup-sheet-transition-history', observation);
  result.checks.push('clean-source-startup-without-recovery-sheet');
  await wait(() => evaluate(() => document.querySelectorAll('.pt-wp').length >= 2), 'fixture path restored');
  const session = await evaluate(() => window.bordeauxAPI.getProjectSession());
  assert.equal(session.location.folderPath, fixture.folder, 'Startup restores the real isolated source locator');
  result.session = session;
  await pointer('.pt-wp[data-selection="wp:0"]');
  await wait(() => evaluate(() => [...document.querySelectorAll('.pp .numrow')].some(row => row.querySelector('label')?.textContent === 'X')), 'waypoint X editor');
  return evaluate(() => {
    const row = [...document.querySelectorAll('.pp .numrow')].find(row => row.querySelector('label')?.textContent === 'X');
    return '#' + CSS.escape(row.querySelector('input').id);
  });
}
async function typeDraft(selector, text) {
  await pointer(selector);
  await wait(() => evaluate(selector => document.activeElement === document.querySelector(selector), selector), 'input owns focus', 2000);
  key('Home'); key('End', ['shift']);
  await wait(() => evaluate(selector => { const e = document.querySelector(selector); return e.selectionStart === 0 && e.selectionEnd === e.value.length; }, selector), 'native select-all', 2000);
  for (const character of text) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: character });
    win.webContents.sendInputEvent({ type: 'char', keyCode: character });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: character });
  }
  await wait(() => evaluate((selector, text) => document.hasFocus() && document.activeElement === document.querySelector(selector) && document.activeElement.value === text, selector, text), 'exact native typed text', 2000);
  result.typedAt = Date.now(); result.typedText = text;
}
function matchedAcknowledgement(kind) {
  const responses = result.events.filter(event => event.kind === 'project:departureResponse:received');
  const updates = result.events.filter(event => event.kind === 'project:checkpointUpdate');
  for (const { data: response } of responses) {
    if (response.outcome !== (kind === 'source' ? 'saved' : 'recovery')) continue;
    const update = updates.map(event => event.data).find(value => value.requestId === response.requestId && value.operationId === response.operationId
      && value.snapshotRevision === response.snapshotRevision && value[kind + 'Receipt']?.receiptId === response.receiptId);
    const request = result.events.find(event => event.kind === 'project:departure' && event.data.requestId === response.requestId);
    if (update && request) {
      const expectedReason = fixture.scenario === 'force-reload-draft' ? 'reload-ignoring-cache' : fixture.scenario.includes('reload') ? 'reload' : 'close';
      assert.equal(request.data.reason, expectedReason, 'Native menu/action preserves its precise departure reason');
      assert.deepEqual(response.context, update.context, 'Final live acknowledgement belongs to current checkpoint context');
      const receipt = update[kind + 'Receipt'];
      assert.equal(receipt.kind, kind);
      if (kind === 'recovery') result.recoveryReceipt = receipt;
      return { requestId: response.requestId, operationId: response.operationId, receiptId: receipt.receiptId, reason: request.data.reason };
    }
  }
  throw new Error('Native action had no observed main request, actual storage receipt and matched live ' + kind + ' reply');
}
function readonlyFixture() {
  assert.notEqual(process.platform, 'win32', 'Permission scenario uses POSIX mode bits; Windows requires separate fixture');
  function protect(file) {
    const stat = fs.lstatSync(file); assert.ok(!stat.isSymbolicLink());
    if (stat.isDirectory()) for (const name of fs.readdirSync(file)) protect(path.join(file, name));
    permissionRestores.push([file, stat.mode & 0o777]); fs.chmodSync(file, stat.isDirectory() ? 0o500 : 0o400);
  }
  protect(fixture.folder);
  const probe = path.join(fixture.folder, '.permission-probe');
  assert.throws(() => fs.writeFileSync(probe, 'probe', { flag: 'wx' }), error => error.code === 'EACCES' || error.code === 'EPERM', 'Actual fixture filesystem must refuse writes');
  record('fault', { type: 'real-posix-permissions', folder: fixture.folder });
}
function nativeAction() {
  result.actionAt = Date.now(); result.preAutosaveElapsedMs = result.actionAt - result.typedAt;
  assert.ok(result.preAutosaveElapsedMs < 900, 'Native action must start before the 900ms autosave delay');
  actionStarted = true;
  if (fixture.scenario.startsWith('direct-')) {
    const force = fixture.scenario === 'direct-force-reload-fence';
    record('native-action', { route: force ? 'webContents.reloadIgnoringCache' : 'webContents.reload', expectation: 'synchronous-unload-fence-no-destruction' });
    if (force) win.webContents.reloadIgnoringCache(); else win.webContents.reload();
  } else if (fixture.scenario.includes('reload')) {
    const label = fixture.scenario.startsWith('force-') ? 'Force reload' : 'Reload';
    const view = Menu.getApplicationMenu().items.find(item => item.label === 'View');
    const item = view?.submenu.items.find(item => item.label === label);
    assert.ok(item?.enabled && typeof item.click === 'function', 'Supported native menu action must exist: ' + label);
    record('native-action', { route: 'Menu.View.' + label }); item.click(item, win, {});
  } else { record('native-action', { route: 'BrowserWindow.close' }); win.close(); }
}
function finishVerifiedRun() {
  result.status = 'passed'; finishing = true; restorePermissions(); write();
  // Successful cleanup must use the protected route too, so the native crash
  // fallback never becomes a second, unrelated scenario after our assertions.
  win.once('closed', () => setImmediate(() => app.quit()));
  win.close();
}
async function run() {
  const selector = await editorReady();
  await screenshot(stage + '-before');
  if (stage === 'relaunch') {
    assert.equal(await evaluate(selector => Number(document.querySelector(selector).value), selector), fixture.expectedX, 'Fresh actual renderer shows the persisted native edit');
    result.checks.push('actual-process-relaunch-restores-exact-field');
    finishVerifiedRun(); return;
  }
  const invalid = fixture.scenario.includes('invalid'), permission = fixture.scenario === 'source-failure-recovery';
  if (permission) readonlyFixture();
  await typeDraft(selector, invalid ? 'invalid' : fixture.input);
  if (fixture.scenario === 'close-committed') { key('Enter'); await wait(() => evaluate(selector => document.activeElement !== document.querySelector(selector), selector), 'Enter committed field', 500); }
  const loadCount = result.nativeLoads;
  nativeAction();
  if (fixture.scenario.startsWith('direct-')) {
    await delay(1100);
    assert.equal(win.isDestroyed(), false);
    assert.equal(result.nativeLoads, loadCount, 'Direct unmanaged reload must be synchronously blocked while a draft exists');
    assert.equal(await evaluate((selector, expected) => document.hasFocus() && document.activeElement === document.querySelector(selector)
      && document.activeElement.value === expected, selector, fixture.input), true, 'Direct reload fence preserves exact focused typed input');
    await screenshot('direct-unload-fenced');
    key('Escape');
    result.checks.push('direct-unmanaged-reload-fenced-without-destruction');
  } else if (invalid) {
    await wait(() => result.events.some(event => event.kind === 'project:departureResponse:returned'
      && event.data.request.outcome === 'invalid-input' && event.data.result?.accepted === true), 'accepted live invalid-input cancellation');
    await delay(1100);
    assert.equal(win.isDestroyed(), false, 'Invalid draft keeps native window alive');
    assert.equal(result.nativeLoads, loadCount, 'Invalid draft prevents renderer destruction/reload');
    assert.equal(await evaluate(selector => document.hasFocus() && document.activeElement === document.querySelector(selector)
      && document.activeElement.value === 'invalid' && !document.querySelector('[role="dialog"]'), selector), true, 'Invalid draft remains focused without a modal');
    await screenshot('invalid-draft-blocked');
    key('Escape');
    await typeDraft(selector, fixture.input);
    key('Escape');
    result.checks.push('invalid-draft-blocks-native-action-and-remains-editable');
  } else if (fixture.scenario.includes('reload')) {
    await wait(() => result.nativeLoads > loadCount, 'actual renderer reload after protected native menu');
    result.checks.push(matchedAcknowledgement('source'));
    const restored = await editorReady();
    assert.equal(await evaluate(selector => Number(document.querySelector(selector).value), restored), fixture.expectedX);
    await screenshot('reloaded-exact-edit');
    result.checks.push('native-menu-reload-restores-exact-field');
  } else if (permission) {
    await wait(() => result.events.some(event => event.kind === 'project:checkpointUpdate' && event.data.recoveryReceipt && event.data.source !== 'pending' && event.data.source !== 'saved'), 'real source failure and recovery receipt');
    await wait(() => evaluate(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Close and restore later')), 'live recovery choice');
    await screenshot('source-failed-recovery-choice');
    await pointer('button', 'Close and restore later');
    await wait(() => result.nativeCloses === 1, 'explicit recovery choice closes actual window');
    return;
  } else {
    await wait(() => result.nativeCloses === 1, 'actual protected window close');
    return;
  }
  assert.deepEqual(result.robotCalls, []);
  finishVerifiedRun();
}
app.on('browser-window-created', (_event, window) => {
  assert.equal(started, false, 'Unexpected second window in bounded single-window scenario');
  win = window;
  const observation = attachProjectSheetObservation(window.webContents, fail, output);
  record('sheet-observation-registration', observation.registration);
  const send = window.webContents.send.bind(window.webContents);
  window.webContents.send = (channel, ...args) => {
    if (['project:departure', 'project:checkpointUpdate', 'project:departureCancelled'].includes(channel)) record(channel, args[0]);
    return send(channel, ...args);
  };
  window.webContents.on('console-message', details => { if (details.level === 'error') { result.errors.push(details.message); write(); } });
  window.webContents.on('render-process-gone', (_event, details) => { record('render-process-gone', details); if (!finishing) void fail(new Error('Renderer exited unexpectedly')); });
  window.webContents.on('did-finish-load', () => {
    result.nativeLoads++; record('did-finish-load');
    if (!started) { started = true; window.setContentSize(fixture.width, fixture.height); void run().catch(fail); }
  });
  window.on('closed', () => {
    result.nativeCloses++; record('closed');
    if (finishing) return;
    try {
      assert.equal(actionStarted, true, 'No unexpected window destruction');
      assert.ok(!fixture.scenario.includes('invalid') && !fixture.scenario.includes('reload'), 'This native action must leave its window alive');
      result.checks.push(matchedAcknowledgement(fixture.scenario === 'source-failure-recovery' ? 'recovery' : 'source'));
      result.sourceAtNativeDestruction = JSON.parse(fs.readFileSync(fixture.workspace, 'utf8')).project;
      assert.equal(result.sourceAtNativeDestruction.paths[0].waypoints[0].x,
        fixture.scenario === 'source-failure-recovery' ? fixture.originalX : fixture.expectedX,
        'Canonical source value at actual destruction, before process cleanup or relaunch');
      assert.deepEqual(result.robotCalls, []);
      result.checks.push('real-window-destroyed-after-live-exact-receipt');
      result.status = 'passed'; finishing = true; restorePermissions(); write();
      setImmediate(() => app.quit()); // Test-owned process shutdown after the observed protected close.
    } catch (error) { void fail(error); }
  });
});
app.on('before-quit', () => record('before-quit'));
app.on('will-quit', () => record('will-quit'));
app.on('quit', () => { restorePermissions(); write(); });
write();
require('../dist-electron/electron/main.js');
