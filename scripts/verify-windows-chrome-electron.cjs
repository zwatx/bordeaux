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
let releaseStartup, holdStartup = true;
const startupGate = new Promise(resolve => { releaseStartup = resolve; });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const write = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
const evaluate = (fn, ...args) => win.webContents.executeJavaScript('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')');
async function wait(check, label) { const end = Date.now() + 10_000; while (Date.now() < end) { if (await check()) return; await delay(25); } throw Error('Timed out: ' + label); }
async function fail(error) { if (finished) return; finished = true; result.status = 'failed'; result.error = error.stack || String(error); if (win && !win.isDestroyed()) { try { fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG()); result.dom = await evaluate(() => document.body.innerText); } catch {} } write(); console.error(error); app.exit(1); }
process.on('uncaughtException', fail); process.on('unhandledRejection', fail);
const realHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => realHandle(channel, async (event, ...args) => {
  if (/^(robot|robotFiles|robotProject):/.test(channel) && !['robot:getPairing', 'robotFiles:connection', 'robotProject:restore', 'robotProject:listRecent'].includes(channel)) { result.robotCalls.push(channel); throw Error('Forbidden robot/NI call: ' + channel); }
  if (channel === 'project:session' && holdStartup) await startupGate;
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
    await wait(() => evaluate(() => Boolean(document.querySelector('.editor-startup') && document.querySelector('.windows-title-bar'))), 'startup chrome before project readiness');
    assert.equal(await evaluate(() => document.querySelector('.editor-startup-toolbar').getBoundingClientRect().height), 44);
    await capture('startup-chrome');
    const startupMenu = Menu.getApplicationMenu();
    let startupOpened = false; startupMenu.once('menu-will-show', () => { startupOpened = true; });
    await pointer('[aria-label="Application menu"]'); await wait(() => startupOpened, 'Application reachable during startup');
    startupMenu.closePopup(win); await wait(() => evaluate(() => document.querySelector('[aria-label="Application menu"]').getAttribute('aria-expanded') === 'false'), 'startup popup closed');
    await pointer('[aria-label="Maximize window"]'); await wait(() => win.isMaximized(), 'maximize during startup');
    await wait(() => evaluate(() => Boolean(document.querySelector('[aria-label="Restore window"]'))), 'startup state synchronized');
    await pointer('[aria-label="Restore window"]'); await wait(() => !win.isMaximized(), 'restore during startup');
    result.checks.push('startup-44px-toolbar-menu-and-controls');
    holdStartup = false; releaseStartup();
    await wait(() => evaluate(async () => Boolean((await window.bordeauxAPI.getProjectSession()).lifecycleReady && document.querySelector('.pt-wp'))), 'restored editor');
    await wait(() => evaluate(() => document.querySelector('.fieldcol')?.getAttribute('data-planning-ready') === 'true'), 'planned editor before capture');
    assert.equal(win.isMenuBarVisible(), false); result.checks.push('native-menu-bar-hidden');
    for (const [width, height, name] of [[1440, 900, 'editor-1440x900'], [1100, 720, 'editor-1100x720-minimum']]) {
      win.setContentSize(width, height); await delay(150);
      result.actualSize = { content: win.getContentSize(), outer: win.getSize(), dom: await evaluate(() => [innerWidth, innerHeight, devicePixelRatio]) }; write();
      await wait(() => evaluate((w, h) => innerWidth === w && innerHeight === h, width, height), name);
      const geometry = await evaluate(() => {
        const chrome = document.querySelector('.windows-title-bar').getBoundingClientRect(), toolbar = document.querySelector('.toolbar').getBoundingClientRect();
        const editor = document.querySelector('.app').getBoundingClientRect(), places = document.querySelector('.places').getBoundingClientRect();
        const controls = [...document.querySelectorAll('.toolbar button,.windows-title-bar button')].filter(el => el.getClientRects().length);
        return { bar: chrome.height, chromeTop: chrome.top, chromeRight: chrome.right, chromeLeft: chrome.left,
          toolbar: toolbar.height, toolbarTop: toolbar.top, editor: editor.height, editorTop: editor.top,
          stageTop: document.querySelector('.stage').getBoundingClientRect().top, placesLeft: places.left, placesCenter: places.left + places.width / 2,
          tabsCentered: [...document.querySelectorAll('.place')].every(button => {
            const range=document.createRange(); range.selectNodeContents(button);
            const text=range.getBoundingClientRect(), box=button.getBoundingClientRect();
            return Math.abs(text.left+text.width/2-box.left-box.width/2)<=1;
          }),
          oldChrome: document.querySelectorAll('.windows-title-brand,.windows-title-mark,.windows-title-menus,[role="menubar"]').length,
          controls: controls.map(el => { const r = el.getBoundingClientRect(); return { label: el.getAttribute('aria-label') || el.textContent,
            left: r.left, right: r.right, top: r.top, bottom: r.bottom, chrome: Boolean(el.closest('.windows-title-bar')) }; }) };
      });
      assert.equal(geometry.bar, 44); assert.equal(geometry.toolbar, 44); assert.equal(geometry.toolbarTop, 0);
      assert.equal(geometry.chromeTop, 0); assert.equal(geometry.chromeRight, width);
      assert.equal(geometry.editorTop, 0); assert.equal(geometry.editor, height); assert.equal(geometry.stageTop, 44);
      assert.equal(geometry.oldChrome, 0, 'No brand, separate menu bar or extra row');
      // Center each label in its tab; the tab group stays beside the project/library divider.
      assert.ok(geometry.tabsCentered, 'Each project section label is centered in its tab');
      for (const control of geometry.controls) {
        assert.ok(control.left >= 0 && control.right <= width && control.top >= 0 && control.bottom <= 44, 'Toolbar control fits: ' + control.label);
        if (!control.chrome) assert.ok(control.right <= geometry.chromeLeft, 'Window controls do not cover ' + control.label);
      }
      result[name] = geometry;
      await capture(name);
      for (const [index, page] of [[2, 'routines'], [3, 'settings']]) {
        await pointer('.places .place:nth-child(' + index + ')');
        await wait(() => evaluate(index => document.querySelector('.places .place:nth-child(' + index + ')').getAttribute('aria-current') === 'page', index), page + ' selected');
        const frame = await evaluate(() => ({ height: document.querySelector('.toolbar').getBoundingClientRect().height,
          top: document.querySelector('.places').getBoundingClientRect().top, left: document.querySelector('.places').getBoundingClientRect().left,
          chromeRight: document.querySelector('.windows-title-bar').getBoundingClientRect().right }));
        assert.equal(frame.height, 44); assert.equal(frame.top, 0); assert.equal(frame.chromeRight, width);
        assert.equal(frame.left, geometry.placesLeft);
        await capture(page + '-toolbar-' + width);
      }
      await pointer('.places .place:nth-child(1)');
      await wait(() => evaluate(() => document.querySelector('.fieldcol')?.getAttribute('data-planning-ready') === 'true'), 'planned Paths restored');
    }
    result.minimum = { outer: win.getMinimumSize(), content: win.getContentSize() };
    const [outerWidth, outerHeight] = win.getSize(), [contentWidth, contentHeight] = win.getContentSize();
    assert.deepEqual(win.getMinimumSize(), [1100 + outerWidth - contentWidth, 720 + outerHeight - contentHeight]);
    result.checks.push('single-44px-toolbar-exact-supported-sizes');
    result.parentLayout = 'All three labels centered within their tabs.';
    win.focus(); win.webContents.focus(); await wait(() => evaluate(() => document.hasFocus()), 'native foreground');
    const menuSelector = '[aria-label="Application menu"]', popup = Menu.getApplicationMenu();
    assert.deepEqual(popup.items.map(item => item.label), ['File', 'Robot', 'Agents', 'View', 'Help']);
    let opened = 0, observed;
    const application = () => {
      const current = Menu.getApplicationMenu();
      if (observed !== current) { observed = current; current.on('menu-will-show', () => opened++); }
      return current;
    };
    application();
    const dismiss = async () => { application().closePopup(win); await wait(() => evaluate(selector => document.querySelector(selector).getAttribute('aria-expanded') === 'false', menuSelector), 'popup closed'); };
    await evaluate(() => document.querySelector('.place[aria-current="page"]').focus()); key('F10');
    await wait(() => evaluate(selector => document.activeElement === document.querySelector(selector), menuSelector), 'F10 focuses Application');
    key('Tab'); await wait(() => evaluate(() => document.activeElement.getAttribute('aria-label') === 'Minimize window'), 'Tab reaches caption controls');
    key('Tab', ['shift']); key('ArrowDown'); await wait(() => opened === 1, 'native application popup from keyboard');
    // Chromium input does not drive OS popup keyboard tracking. Keep input scoped to our process.
    result.limitations = ['Native popup Escape/selection, OS accelerators, drag/snap and Alt+Space require manual foreground checks; this harness does not send global input.'];
    await dismiss();
    await pointer(menuSelector); await wait(() => opened === 2, 'native application popup from pointer'); await dismiss();
    for (const keyCode of ['Space', 'Enter']) {
      await evaluate(selector => document.querySelector(selector).focus(), menuSelector); key(keyCode);
      await wait(() => opened === (keyCode === 'Space' ? 3 : 4), keyCode + ' opens Application'); await dismiss();
    }
    key('Escape'); await wait(() => evaluate(() => document.activeElement.matches('.place[aria-current="page"]')), 'Escape returns to editor');
    result.checks.push('application-menu-pointer-f10-tab-arrows-space-enter-escape');
    for (const [id, letter] of [['file', 'f'], ['robot', 'r'], ['agents', 'a'], ['view', 'v'], ['help', 'h']]) {
      // Background source saves can rebuild main's menus after navigation.
      const submenu = application().getMenuItemById('chrome-' + id).submenu;
      win.focus(); win.webContents.focus(); await wait(() => evaluate(() => document.hasFocus()), 'focus after programmatic popup dismissal');
      let shown = false; submenu.once('menu-will-show', () => { shown = true; });
      key(letter, ['alt']); await wait(() => shown, 'Alt+' + letter + ' opens native ' + id);
      submenu.closePopup(win); await wait(() => evaluate(selector => document.querySelector(selector).getAttribute('aria-expanded') === 'false', menuSelector), 'Alt menu closed');
    }
    result.checks.push('direct-native-alt-submenus-preserved');
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
    result.regions = await evaluate(() => ({ toolbar: getComputedStyle(document.querySelector('.toolbar')).webkitAppRegion,
      chrome: getComputedStyle(document.querySelector('.windows-title-bar')).webkitAppRegion,
      buttons: [...document.querySelectorAll('.toolbar button,.windows-title-bar button')].map(button => getComputedStyle(button).webkitAppRegion) }));
    assert.equal(result.regions.toolbar, 'drag'); assert.equal(result.regions.chrome, 'no-drag');
    assert.ok(result.regions.buttons.every(region => region === 'no-drag'));
    // A real modal makes the editor inert. Caption buttons and native menus must stay reachable.
    await pointer('[aria-label="Keyboard shortcuts"]');
    await wait(() => evaluate(() => Boolean(document.querySelector('dialog:modal>.windows-title-bar'))), 'chrome in modal top layer');
    await capture('keyboard-help-chrome');
    application(); // A source Save can rebuild main's recent-project menus.
    const beforeModalMenu = opened;
    await pointer(menuSelector); await wait(() => opened > beforeModalMenu, 'Application reachable over modal'); await dismiss();
    await evaluate(() => document.querySelector('.keyboard-help [aria-label="Close keyboard shortcuts"]').focus()); key('F10');
    await wait(() => evaluate(selector => document.activeElement === document.querySelector(selector), menuSelector), 'F10 reaches Application from modal');
    key('Enter'); await wait(() => opened > beforeModalMenu + 1, 'keyboard Application from modal'); await dismiss();
    await pointer('[aria-label="Minimize window"]'); await wait(() => win.isMinimized(), 'minimize with modal open'); win.restore(); win.focus(); win.webContents.focus();
    await pointer('[aria-label="Maximize window"]'); await wait(() => win.isMaximized(), 'maximize with modal open');
    await wait(() => evaluate(() => Boolean(document.querySelector('dialog:modal [aria-label="Restore window"]'))), 'modal chrome state synchronized');
    await pointer('[aria-label="Restore window"]'); await wait(() => !win.isMaximized(), 'restore with modal open');
    await pointer('.keyboard-help [aria-label="Close keyboard shortcuts"]');
    await wait(() => evaluate(() => document.querySelector('.windows-title-bar')?.parentElement === document.body), 'chrome returns after modal closes');
    result.checks.push('real-modal-pointer-keyboard-menu-and-window-controls');
    await evaluate(() => { document.querySelector('.windows-desktop').inert = true; });
    try {
      application();
      const beforeInertMenu = opened;
      await pointer(menuSelector); await wait(() => opened > beforeInertMenu, 'Application outside inert editor'); await dismiss();
      await pointer('[aria-label="Maximize window"]'); await wait(() => win.isMaximized(), 'maximize outside inert editor');
      await pointer('[aria-label="Restore window"]'); await wait(() => !win.isMaximized(), 'restore outside inert editor');
    } finally { await evaluate(() => { document.querySelector('.windows-desktop').inert = false; }); }
    result.checks.push('chrome-independent-of-inert-app');
    // Main still owns the reload command and its project-departure admission.
    let reloaded = false;
    win.webContents.once('did-finish-load', () => { reloaded = true; });
    Menu.getApplicationMenu().getMenuItemById('chrome-view').submenu.items.find(item => item.label === 'Reload').click();
    await wait(() => reloaded, 'protected reload committed');
    await wait(() => evaluate(async () => Boolean((await window.bordeauxAPI.getProjectSession()).lifecycleReady && document.querySelector('.pt-wp') && document.querySelector('.windows-title-bar'))), 'chrome after protected reload');
    await pointer('[aria-label="Maximize window"]'); await wait(() => win.isMaximized(), 'caption control after reload');
    await wait(() => evaluate(() => Boolean(document.querySelector('[aria-label="Restore window"]'))), 'state subscribed after reload');
    await pointer('[aria-label="Restore window"]'); await wait(() => !win.isMaximized(), 'restore after reload');
    result.checks.push('main-owned-reload-and-fresh-chrome-state');
    await capture('reloaded-1100x720');
    await pointer('[aria-label="Keyboard shortcuts"]');
    await wait(() => evaluate(() => Boolean(document.querySelector('dialog:modal>.windows-title-bar'))), 'caption Close reachable in modal');
    await pointer('[aria-label="Close window"]'); await wait(() => win.isDestroyed(), 'graceful title bar close');
  })().catch(fail));
});
require('../dist-electron/electron/main.js');
