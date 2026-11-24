// Run after renderer/electron builds with Electron, using a disposable output directory.
// Only native file dialogs are substituted. Production main/preload/IPC/worker/writer run unchanged.
const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = process.env.BORDEAUX_BDX_UI_OUTPUT;
if (!output || !path.isAbsolute(output)) throw new Error('BORDEAUX_BDX_UI_OUTPUT must be an isolated absolute directory');
fs.mkdirSync(output, { recursive: true }); const userData = path.join(output, 'user-data'); fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);
const robotProjectFile = path.join(output, 'OfflineRobot.lvproj');
fs.writeFileSync(robotProjectFile, '<Project><Item Name="Robot" Type="RT roboRIO"/></Project>');
fs.writeFileSync(path.join(userData, 'robot-sftp-connection.json'), JSON.stringify({ endpoint: { host: 'test-only.invalid', port: 22, directory: '/home/lvuser/natinst/bin/Paths' }, hostKeyFingerprint: 'SHA256:' + 'a'.repeat(43) }));
const { createDemoProject, blankPath } = require('../dist-electron/core/project/defaults');
const { buildRobotBinary } = require('../dist-electron/core/export/robotBinary');
const { bdxBindingsFromCatalog } = require('../dist-electron/electron/bdxBindings');
const { buildRoutineRuntime } = require('../dist-electron/core/export/routineRuntime');
const { routineBindingsFromBinary } = require('../dist-electron/electron/routineBindings');
const fixture = createDemoProject(), route = blankPath('A long selected path name for local BDX export verification');
fixture.robot.driveModel = { motorId: 'test-force-export', motorFreeRpm: 6000, motorMaxTorqueNm: 4, motorCount: 4,
  gearRatio: 6.75, wheelDiameterM: 0.1016, massKg: 50, moiKgM2: 5, wheelbaseM: 0.6, trackwidthM: 0.6, wheelFrictionCoefficient: 1.2 };
route.id = 'bdx-ui-selected'; fixture.paths = [route, { ...blankPath('Unselected path'), id: 'bdx-ui-unselected' }];
fixture.editor = { activePathId: route.id, labviewProjectPath: 'OfflineRobot.lvproj' }; fixture.routines = [{ id: 'local', name: 'Runtime routine with a path and repeated pause', nodes: [
  { id: 'approach', type: 'path', ref: route.id }, { id: 'repeat', type: 'repeat', times: 2, nodes: [
    { id: 'pause', type: 'builtin', builtinId: 'bordeaux.wait', arguments: { durationS: .02 } },
    { id: 'exit-repeat', type: 'end', scope: 'repeat' },
  ] }, { id: 'end-routine', type: 'end', scope: 'routine' },
] }]; fixture.activeRoutineId = 'local';
const projectFile = path.join(output, 'fixture.bordeaux.json'); fs.writeFileSync(projectFile, JSON.stringify(fixture));
fs.writeFileSync(path.join(userData, 'recent-projects.json'), JSON.stringify({ version: 1, projects: [projectFile] }));
const expected = Buffer.from(buildRobotBinary(fixture, { kind: 'path', id: route.id }, bdxBindingsFromCatalog(null)).bytes);
const expectedRoutine = Buffer.from(buildRoutineRuntime(fixture, 'local', routineBindingsFromBinary(bdxBindingsFromCatalog(null))).bytes);
const calls = [], dialogs = []; let saveMode = 'success', resolveSave, restoredRobotLink = false;
const actualHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => actualHandle(channel, async (event, ...args) => {
  calls.push(channel);
  if (/^robot:(probe|confirmPairing|inspect|prepare|confirmPush|confirmRetention)|^robotFiles:(check|probe|trust|confirm)/.test(channel)) throw new Error('Local export must not contact a robot');
  if (channel === 'project:exportRoutine' && saveMode === 'routine-failure') throw new Error('Routine command output type changed. Inspect commands and export again.');
  const result = await handler(event, ...args);
  if (channel === 'robotProject:restore' && result?.catalog) restoredRobotLink = true;
  return result;
});
dialog.showSaveDialog = async (_window, options) => {
  dialogs.push(options);
  if (saveMode === 'cancel') return { canceled: true };
  if (saveMode === 'pending') return new Promise((resolve) => { resolveSave = resolve; });
  const extension = options.filters?.[0]?.extensions?.[0] || 'bdx';
  return { canceled: false, filePath: path.join(output, saveMode === 'replace' ? 'selected.' + extension : 'selected') };
};
dialog.showMessageBox = async (_window, options) => { dialogs.push(options); return { response: saveMode === 'replace' ? 1 : 0 }; };
require('../dist-electron/electron/main.js');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); let win;
const evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true);
async function wait(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw new Error('Timed out: ' + label); }
async function pointer(selector, text) {
  const p = await evaluate((selector, text) => { const el = [...document.querySelectorAll(selector)].find((item) => text == null || item.textContent.includes(text)); if (!el) throw new Error('Missing ' + selector + ' ' + text); const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }, selector, text);
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...p, button: 'left', clickCount: 1 }); await delay(100);
}
async function key(keyCode, modifiers = []) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await delay(75); }
async function capture(name) { fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
app.whenReady().then(async () => {
  try {
    await wait(() => (win = BrowserWindow.getAllWindows()[0]) && !win.webContents.isLoading(), 'production editor');
    await wait(() => evaluate(() => !!document.querySelector('[data-library-item="bdx-ui-selected"]')), 'restored selected path'); win.focus();
    await wait(() => restoredRobotLink, 'saved NI project link restored');
    fs.unlinkSync(robotProjectFile);
    const fileMenu = Menu.getApplicationMenu().items.find((item) => item.label === 'File');
    const exportMenu = fileMenu.submenu.items.find((item) => item.label === 'Export selected path as BDX…'); assert.ok(exportMenu);
    exportMenu.click();
    await wait(() => fs.existsSync(path.join(output, 'selected.bdx')), 'actual worker binary write');
    assert.deepEqual(fs.readFileSync(path.join(output, 'selected.bdx')), expected);
    await wait(() => evaluate(() => document.body.textContent.includes('BDX exported')), 'local export notice');
    for (const [w, h] of [[1440, 900], [1100, 720]]) { win.setContentSize(w, h); await delay(150); await capture('exported-' + w); }
    // Successful exports are transient confirmations, with no expandable or focusable controls.
    assert.equal(await evaluate(() => document.querySelectorAll('.field-confirmation details, .field-confirmation button').length), 0);
    await pointer('.pp-more'); await capture('inspector-open-1100');
    await pointer('.pp-more'); await capture('inspector-closed-1100');
    await pointer('.places .place', 'Settings'); await pointer('[aria-label="Display units"] button', 'Imperial'); await pointer('.places .place', 'Paths'); await key('Tab'); await key('Escape'); await capture('imperial-1100');
    saveMode = 'cancel'; const before = fs.readFileSync(path.join(output, 'selected.bdx'));
    const canceled = await evaluate((project, id) => window.bordeauxAPI.exportBdx(project, id), fixture, route.id); assert.equal(canceled.canceled, true); assert.deepEqual(fs.readFileSync(path.join(output, 'selected.bdx')), before);
    saveMode = 'replace'; const replaced = await evaluate((project, id) => window.bordeauxAPI.exportBdx(project, id), fixture, route.id); assert.equal(replaced.exported, true); assert.deepEqual(fs.readFileSync(path.join(output, 'selected.bdx')), expected);
    saveMode = 'success';
    await pointer('.places .place', 'Routines');
    await wait(() => evaluate(() => document.querySelector('.push-button')?.textContent === 'Push routine'), 'scoped routine toolbar');
    const routineMenu = fileMenu.submenu.items.find((item) => item.label === 'Export active routine…'); assert.ok(routineMenu);
    routineMenu.click();
    await wait(() => fs.existsSync(path.join(output, 'selected.bdr')), 'production routine worker binary write');
    assert.deepEqual(fs.readFileSync(path.join(output, 'selected.bdr')), expectedRoutine);
    await wait(() => evaluate(() => document.body.textContent.includes('Routine exported')), 'local routine export notice');
    for (const [w, h] of [[1440, 900], [1100, 720]]) { win.setContentSize(w, h); await delay(150); await capture('routine-exported-' + w); }
    assert.equal(await evaluate(() => !!document.querySelector('.routine-export-notices .field-confirmation')), true);
    assert.equal(await evaluate(() => document.querySelectorAll('.field-confirmation details, .field-confirmation button').length), 0);
    await pointer('.push-button');
    await wait(() => evaluate(() => document.querySelector('.robot-push-dialog')?.open), 'routine setup dialog');
    await wait(() => evaluate(() => document.querySelector('.robot-push-dialog')?.textContent.includes('Upload 1 routine')), 'command-free routine prepares despite unavailable saved NI link');
    assert.equal(calls.includes('robotFiles:prepareRoutine'), true);
    for (const [w, h] of [[1440, 900], [1100, 720]]) { win.setContentSize(w, h); await delay(150); await capture('routine-push-review-' + w); }
    assert.equal(calls.includes('robotFiles:prepare'), false);
    await key('Escape');
    assert.equal(await evaluate(() => document.activeElement?.textContent === 'Push routine'), true);
    saveMode = 'cancel';
    const routineCanceled = await evaluate((project, id) => window.bordeauxAPI.exportRoutine(project, id), fixture, 'local'); assert.equal(routineCanceled.canceled, true);
    assert.deepEqual(fs.readFileSync(path.join(output, 'selected.bdr')), expectedRoutine);
    saveMode = 'replace';
    const routineReplaced = await evaluate((project, id) => window.bordeauxAPI.exportRoutine(project, id), fixture, 'local'); assert.equal(routineReplaced.exported, true);
    assert.deepEqual(fs.readFileSync(path.join(output, 'selected.bdr')), expectedRoutine);
    saveMode = 'routine-failure'; routineMenu.click();
    await wait(() => evaluate(() => document.querySelector('.routine-export-notices [role="alert"]')?.textContent === 'Export failed'), 'visible routine export failure');
    for (const [w, h] of [[1440, 900], [1100, 720]]) { win.setContentSize(w, h); await delay(150); await capture('routine-export-failure-' + w); }
    await pointer('.field-status summary'); await capture('routine-export-failure-details-1100');
    await pointer('.field-status-action');
    saveMode = 'success';
    const legacyRoutine = structuredClone(fixture); legacyRoutine.routines[0].nodes.push({ id: 'legacy', type: 'decision', conditionId: 'legacy', then: [], else: [] });
    await assert.rejects(evaluate((project, id) => window.bordeauxAPI.exportRoutine(project, id), legacyRoutine, 'local'), /legacy routine steps require migration/);
    saveMode = 'pending'; const pending = evaluate((project, id) => window.bordeauxAPI.exportBdx(project, id), fixture, route.id);
    await wait(() => !!resolveSave, 'pending native save'); await evaluate(() => window.bordeauxAPI.newProject()); resolveSave({ canceled: false, filePath: path.join(output, 'stale.bdx') });
    await assert.rejects(pending, /project changed during BDX export/); assert.equal(fs.existsSync(path.join(output, 'stale.bdx')), false);
    const bad = structuredClone(fixture); bad.paths[0].markers = [{ id: 'bad', f: .5, name: 'Missing NI binding', invocation: { commandId: 'missing.command', arguments: {} } }];
    await assert.rejects(evaluate((project, id) => window.bordeauxAPI.exportBdx(project, id), bad, route.id), /command missing.command can't be built because no LabVIEW commands are available\. Link the robot's LabVIEW project/);
    assert.equal(calls.some((channel) => /^robot:(probe|confirmPairing|inspect|prepare|confirmPush|confirmRetention)|^robotFiles:(check|probe|trust|confirm)/.test(channel)), false);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, byteLength: expected.length, routineByteLength: expectedRoutine.length, checks: ['production menu -> renderer -> preload -> IPC -> worker -> byte writer -> atomic local file', 'selected path and selected self-contained routine only', 'native path/routine save cancellation', 'existing path/routine file replacement', 'routine success/failure visible on Routines', 'routine failure dismiss', 'routine Push review Escape focus return', 'unsupported legacy routine preflight rejects', 'project change while dialog pending rejects', 'missing NI command type evidence rejects', 'no robot transport operations', '1440x900 and 1100x720 captures', 'pointer notice/settings and keyboard Tab/Space/Escape', 'imperial display'], dialogs, calls }, null, 2));
    // Worker assertions are complete; allow asynchronous termination of the existing BDX worker before test-owned exit.
    await delay(250); setImmediate(() => app.exit(0));
  } catch (error) { fs.writeFileSync(path.join(output, 'failure.txt'), error.stack); if (win) await capture('failure'); console.error(error); app.exit(1); }
});
