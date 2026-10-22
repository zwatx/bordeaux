// Actual shipping main/preload/renderer, isolated source/profile, no robot/NI or installer.
const { app, ipcMain, Menu, dialog } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const output = process.env.BORDEAUX_SMOKE_DIRECTORY;
assert.ok(output && path.isAbsolute(output));
app.setPath('documents', path.join(output, 'Documents'));
// Exact CSS-pixel screenshot sizes, independent of the host monitor's 125% scale.
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const result = { status: 'running', checks: [], screenshots: [], menus: [], robotCalls: [], versions: process.versions };
let win, finished = false, saveCount = 0, closeRequested = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const write = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
const evaluate = (fn, ...args) => win.webContents.executeJavaScript('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')');
async function wait(check, label) { const end = Date.now() + 10_000; while (Date.now() < end) { if (await check()) return; await delay(25); } throw Error('Timed out: ' + label); }
async function fail(error) { if (finished) return; finished = true; result.status = 'failed'; result.error = error.stack || String(error); if (win && !win.isDestroyed()) { try { fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG()); result.dom = await evaluate(() => document.body.innerText); } catch {} } write(); console.error(error); app.exit(1); }
process.on('uncaughtException', fail); process.on('unhandledRejection', fail);
const realHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => realHandle(channel, async (event, ...args) => {
  if (/^(robot|robotFiles|robotProject):/.test(channel) && !['robot:getPairing', 'robotFiles:connection', 'robotProject:restore', 'robotProject:listRecent'].includes(channel)) { result.robotCalls.push(channel); throw Error('Forbidden robot/NI call: ' + channel); }
  const value = await listener(event, ...args);
  if (channel === 'project:saveWithCheckpoint') saveCount++;
  if (channel === 'window:action' && args[0] === 'close') closeRequested = true;
  return value;
});
dialog.showMessageBox = async () => { throw Error('Unexpected native fallback'); };
dialog.showOpenDialog = async () => { throw Error('Unexpected native picker'); };
function key(keyCode, modifiers = []) {
  keyCode = keyCode.replace(/^Arrow/, '');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
}
async function pointer(selector) {
  const point = await evaluate(selector => { const el = document.querySelector(selector); if (!el || el.disabled) throw Error('Missing control ' + selector); const r = el.getBoundingClientRect(), x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2); if (!el.contains(document.elementFromPoint(x, y))) throw Error('Occluded control ' + selector); return { x, y }; }, selector);
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point }); win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 }); win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 }); await delay(60);
}
async function capture(name) { await delay(150); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); result.screenshots.push(name + '.png'); write(); }
app.on('browser-window-created', (_event, window) => {
  if (win) return; win = window;
  const send = win.webContents.send.bind(win.webContents);
  win.webContents.send = (channel, ...args) => { if (channel === 'menu-command') result.menus.push(args[0]); return send(channel, ...args); };
  win.on('closed', () => {
    if (finished) return;
    try {
      assert.ok(closeRequested, 'Closed through title bar IPC'); assert.equal(result.robotCalls.length, 0);
      result.checks.push('custom-close-through-production-departure', 'local-save-never-connects-robot');
      result.status = 'passed'; result.teardown = 'Test-owned app.exit after production window closed; application quit cleanup is outside this harness.';
      finished = true; write(); console.log('PASS Windows production chrome: ' + result.checks.join(', '));
      setImmediate(() => app.exit(0));
    } catch (error) { void fail(error); }
  });
  win.webContents.once('did-finish-load', () => void (async () => {
    win.show(); win.focus(); win.webContents.focus();
    await wait(() => evaluate(async () => Boolean((await window.bordeauxAPI.getProjectSession()).lifecycleReady && document.querySelector('.pt-wp'))), 'restored editor');
    assert.equal(win.isMenuBarVisible(), false); result.checks.push('native-menu-bar-hidden');
    for (const [width, height, name] of [[1440, 900, 'editor-1440x900'], [1100, 756, 'editor-1100x756-minimum']]) {
      win.setContentSize(width, height); await delay(150);
      result.actualSize = { content: win.getContentSize(), outer: win.getSize(), dom: await evaluate(() => [innerWidth, innerHeight, devicePixelRatio]) }; write();
      await wait(() => evaluate((w, h) => innerWidth === w && innerHeight === h, width, height), name);
      const geometry = await evaluate(() => ({ bar: document.querySelector('.windows-title-bar').getBoundingClientRect().height, editor: document.querySelector('.app').getBoundingClientRect().height }));
      assert.equal(geometry.bar, 36); assert.equal(geometry.editor, height - 36); result[name] = geometry;
      await capture(name);
      if (width === 1100) { // Retain a separately labelled 1100x720 editor crop, without reducing its supported content area.
        fs.writeFileSync(path.join(output, 'editor-content-1100x720.png'), (await win.webContents.capturePage({ x: 0, y: 36, width: 1100, height: 720 })).toPNG()); result.screenshots.push('editor-content-1100x720.png');
      }
    }
    result.minimum = { outer: win.getMinimumSize(), content: win.getContentSize() };
    win.focus(); win.webContents.focus(); await wait(() => evaluate(() => document.hasFocus()), 'native foreground');
    await evaluate(() => document.querySelector('.windows-title-menus button').focus()); key('ArrowRight');
    await wait(() => evaluate(() => document.activeElement.textContent === 'Robot'), 'menu arrows'); key('Home');
    const popup = Menu.getApplicationMenu().getMenuItemById('chrome-file').submenu;
    let opened = 0; popup.on('menu-will-show', () => opened++);
    key('ArrowDown'); await wait(() => opened === 1, 'native popup from keyboard');
    // Chromium input does not drive OS popup keyboard tracking. Keep input scoped to our process.
    result.limitations = ['Native popup Escape/selection, OS accelerators, drag/snap and Alt+Space require manual foreground checks; this harness does not send global input.'];
    popup.closePopup(win); await wait(() => evaluate(() => document.querySelector('[role="menuitem"]').getAttribute('aria-expanded') === 'false'), 'popup closed');
    result.checks.push('menu-arrow-down-native-popup');
    await pointer('[role="menuitem"]'); await wait(() => opened === 2, 'native popup from pointer');
    popup.closePopup(win); await delay(100);
    key('F10'); await delay(50); key('F10'); await delay(50);
    key('f', ['alt']); await wait(() => opened === 3, 'Alt+F native popup'); popup.closePopup(win); await delay(100); result.checks.push('pointer-menu-and-alt-f');
    win.focus(); win.webContents.focus(); await wait(() => evaluate(() => document.hasFocus()), 'focus after menus');
    const before = saveCount; key('S', ['control']); await delay(300);
    result.acceleratorDeliveredByRendererInput = saveCount > before;
    if (saveCount === before) Menu.getApplicationMenu().getMenuItemById('chrome-file').submenu.items.find(item => item.label === 'Save').click();
    await wait(() => saveCount > before, 'main-owned Save callback'); result.checks.push('main-menu-source-save-offline');
    await pointer('[aria-label="Maximize window"]'); await wait(() => win.isMaximized(), 'native maximized');
    await wait(() => evaluate(() => Boolean(document.querySelector('[aria-label="Restore window"]'))), 'maximize synchronized'); await capture('maximized');
    await pointer('[aria-label="Restore window"]'); await wait(() => !win.isMaximized(), 'restored');
    win.maximize(); await wait(() => evaluate(() => Boolean(document.querySelector('[aria-label="Restore window"]'))), 'OS maximize synchronized'); win.unmaximize();
    await wait(() => evaluate(() => Boolean(document.querySelector('[aria-label="Maximize window"]'))), 'OS restore synchronized'); result.checks.push('pointer-maximize-restore-and-external-state-sync');
    await pointer('[aria-label="Minimize window"]'); await wait(() => win.isMinimized(), 'native minimized'); win.restore(); win.focus(); win.webContents.focus();
    await wait(() => evaluate(() => document.hasFocus()), 'restored focus'); result.checks.push('pointer-minimize-and-native-restore');
    await evaluate(() => document.querySelector('[aria-label="Maximize window"]').focus()); key('Space'); await wait(() => win.isMaximized(), 'Space maximize'); key('Enter'); await wait(() => !win.isMaximized(), 'Enter restore'); result.checks.push('keyboard-space-enter-window-controls');
    await evaluate(() => { const bar = document.querySelector('.windows-title-bar'); window.__chromeRegions = { drag: getComputedStyle(bar).webkitAppRegion, button: getComputedStyle(bar.querySelector('button')).webkitAppRegion }; });
    result.regions = await evaluate(() => window.__chromeRegions); assert.deepEqual(result.regions, { drag: 'drag', button: 'no-drag' });
    await pointer('[aria-label="Close window"]'); await wait(() => win.isDestroyed(), 'graceful title bar close');
  })().catch(fail));
});
require('../dist-electron/electron/main.js');
