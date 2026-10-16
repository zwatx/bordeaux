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
const { createDemoProject, blankPath } = require('../dist-electron/shared/project/defaults');
const { buildRobotBinary } = require('../dist-electron/shared/export/robotBinary');
const { bdxBindingsFromCatalog } = require('../dist-electron/electron/bdxBindings');
const fixture = createDemoProject(), route = blankPath('A long selected path name for local BDX export verification');
route.id = 'bdx-ui-selected'; fixture.paths = [route, { ...blankPath('Unselected path'), id: 'bdx-ui-unselected' }];
fixture.editor = { activePathId: route.id }; fixture.routines = [{ id: 'local', name: 'Unrelated routine draft', nodes: [] }]; fixture.activeRoutineId = 'local';
const projectFile = path.join(output, 'fixture.bordeaux.json'); fs.writeFileSync(projectFile, JSON.stringify(fixture));
fs.writeFileSync(path.join(userData, 'recent-projects.json'), JSON.stringify({ version: 1, projects: [projectFile] }));
const expected = Buffer.from(buildRobotBinary(fixture, { kind: 'path', id: route.id }, bdxBindingsFromCatalog(null)).bytes);
const calls = [], dialogs = []; let saveMode = 'success', resolveSave;
const actualHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => actualHandle(channel, (event, ...args) => {
  calls.push(channel);
  if (/^robot:(probe|confirmPairing|inspect|prepare|confirmPush|confirmRetention)/.test(channel)) throw new Error('Local BDX export must not contact a robot');
  return handler(event, ...args);
});
dialog.showSaveDialog = async (_window, options) => {
  dialogs.push(options);
  if (saveMode === 'cancel') return { canceled: true };
  if (saveMode === 'pending') return new Promise((resolve) => { resolveSave = resolve; });
  return { canceled: false, filePath: path.join(output, saveMode === 'replace' ? 'selected.bdx' : 'selected') };
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
async function key(keyCode) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await delay(75); }
async function capture(name) { fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
app.whenReady().then(async () => {
  try {
    await wait(() => (win = BrowserWindow.getAllWindows()[0]) && !win.webContents.isLoading(), 'production editor');
    await wait(() => evaluate(() => !!document.querySelector('.outline')), 'restored path'); win.focus();
    const fileMenu = Menu.getApplicationMenu().items.find((item) => item.label === 'File');
    const exportMenu = fileMenu.submenu.items.find((item) => item.label === 'Export selected path as BDX…'); assert.ok(exportMenu);
    exportMenu.click();
    await wait(() => fs.existsSync(path.join(output, 'selected.bdx')), 'actual worker binary write');
    assert.deepEqual(fs.readFileSync(path.join(output, 'selected.bdx')), expected);
    await wait(() => evaluate(() => document.body.textContent.includes('BDX exported')), 'local export notice');
    for (const [w, h] of [[1440, 900], [1100, 720]]) { win.setContentSize(w, h); await delay(150); await capture('exported-' + w); }
    // Actual pointer and keyboard interaction with notice and settings, not DOM click simulation.
    await pointer('.field-status summary');
    await wait(() => evaluate(() => !!document.querySelector('.field-status details[open]')), 'expanded export details');
    await capture('export-details-1100');
    await pointer('.field-status summary');
    await key('Tab');
    for (let i = 0; i < 100 && !(await evaluate(() => document.activeElement?.matches('.field-status summary'))); i++) await key('Tab');
    assert.equal(await evaluate(() => document.activeElement?.matches('.field-status summary')), true);
    await key(' ');
    assert.equal(await evaluate(() => !!document.querySelector('.field-status details[open]')), true);
    await capture('export-keyboard-1100');
    await pointer('[aria-label="Hide inspector"]'); await capture('inspector-closed-1100');
    await pointer('.places .place', 'Settings'); await pointer('[aria-label="Display units"] button', 'Imperial'); await pointer('.places .place', 'Paths'); await key('Tab'); await key('Escape'); await capture('imperial-1100');
    saveMode = 'cancel'; const before = fs.readFileSync(path.join(output, 'selected.bdx'));
    const canceled = await evaluate((project, id) => window.bordeauxAPI.exportBdx(project, id), fixture, route.id); assert.equal(canceled.canceled, true); assert.deepEqual(fs.readFileSync(path.join(output, 'selected.bdx')), before);
    saveMode = 'replace'; const replaced = await evaluate((project, id) => window.bordeauxAPI.exportBdx(project, id), fixture, route.id); assert.equal(replaced.exported, true); assert.deepEqual(fs.readFileSync(path.join(output, 'selected.bdx')), expected);
    saveMode = 'pending'; const pending = evaluate((project, id) => window.bordeauxAPI.exportBdx(project, id), fixture, route.id);
    await wait(() => !!resolveSave, 'pending native save'); await evaluate(() => window.bordeauxAPI.newProject()); resolveSave({ canceled: false, filePath: path.join(output, 'stale.bdx') });
    await assert.rejects(pending, /project changed during BDX export/); assert.equal(fs.existsSync(path.join(output, 'stale.bdx')), false);
    const bad = structuredClone(fixture); bad.paths[0].markers = [{ id: 'bad', f: .5, name: 'Missing NI binding', invocation: { commandId: 'missing.command', arguments: {} } }];
    await assert.rejects(evaluate((project, id) => window.bordeauxAPI.exportBdx(project, id), bad, route.id), /command missing.command is missing in the linked LabVIEW project/);
    assert.equal(calls.some((channel) => /^robot:(probe|confirmPairing|inspect|prepare|confirmPush|confirmRetention)/.test(channel)), false);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, byteLength: expected.length, checks: ['production menu -> renderer -> preload -> IPC -> worker -> byte writer -> atomic local file', 'selected path only', 'native save cancellation', 'existing file replacement', 'project change while dialog pending rejects', 'missing NI command type evidence rejects', 'no robot transport operations', '1440x900 and 1100x720 captures', 'pointer notice/settings and keyboard Tab/Escape', 'imperial display'], dialogs, calls }, null, 2));
    app.exit(0);
  } catch (error) { fs.writeFileSync(path.join(output, 'failure.txt'), error.stack); if (win) await capture('failure'); console.error(error); app.exit(1); }
});
