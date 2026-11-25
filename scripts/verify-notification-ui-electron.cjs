// Built-App check for notices and status: quiet export confirmations, field status order and action ownership, auto-dismiss pauses, focus return,
// routine export notices, deletion Undo, save failure recovery, the update panel, playback Space under a hover tooltip,
// and the compact properties header. Mocked bridge only (verify-notification-ui-preload.cjs): no robot transport.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = process.env.BORDEAUX_NOTIFICATION_UI_OUTPUT;
app.setPath('userData', path.join(output, 'user-data'));
let win, saved, saves = 0, exportMode = 'ok', saveMode = 'ok', updateState = null;
const errors = [], robotCalls = [], updateCalls = [], passed = [];
const location = { folderPath: 'C:\\fixtures\\Notice project', projectPath: 'C:\\fixtures\\Notice project\\.bordeaux-workspace.json' };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true);
async function wait(fn, label, tries = 200) { for (let i = 0; i < tries; i++) { if (await fn()) return; await delay(75); } throw Error('Timed out: ' + label); }
async function focusWindow() {
  app.focus({ steal: true }); win.focus(); win.webContents.focus();
  await wait(() => evaluate(() => document.hasFocus()), 'renderer keyboard focus');
}
async function pointOf(selector, text) {
  await wait(() => evaluate((selector, text) => {
    const item = [...document.querySelectorAll(selector)].find((el) => el.getClientRects().length && (!text || el.textContent.trim() === text));
    return !!item && !item.disabled && !item.closest('[inert]');
  }, selector, text), 'enabled control: ' + selector + (text ? ' ' + text : ''));
  return evaluate((selector, text) => {
    const item = [...document.querySelectorAll(selector)].find((el) => el.getClientRects().length && (!text || el.textContent.trim() === text));
    item.scrollIntoView({ block: 'nearest' });
    const r = item.getBoundingClientRect(), x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    if (!item.contains(document.elementFromPoint(x, y))) throw Error('Obscured control: ' + selector + ' ' + (text || ''));
    return { x, y };
  }, selector, text);
}
async function click(selector, text) {
  await focusWindow();
  const point = await pointOf(selector, text);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, modifiers: [], x: point.x, y: point.y });
  await delay(200);
}
async function hover(selector) { await focusWindow(); const point = await pointOf(selector); win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y }); await delay(60); }
// An empty spot in the library, away from every notice and tooltip.
const park = async () => { win.webContents.sendInputEvent({ type: 'mouseMove', x: 160, y: (await evaluate(() => innerHeight)) - 60 }); await delay(60); };
async function key(keyCode, modifiers = []) {
  await focusWindow();
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  const char = { Space: ' ', Enter: '\r' }[keyCode];
  if (char && !modifiers.length) win.webContents.sendInputEvent({ type: 'char', keyCode: char, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await delay(100);
}
async function snapshot(name) {
  await evaluate(() => document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
  await fs.writeFile(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
}
const pass = (label) => { passed.push(label); console.log('PASS ' + label); };
const status = () => evaluate(() => {
  const root = document.querySelector('.fieldcol:not([hidden]) .field-status, .routine-export-notices .field-status');
  const label = root?.querySelector('.field-status-label');
  return root && { confirmation: root.classList.contains('field-confirmation'), error: root.classList.contains('error'), label: label?.firstChild?.textContent, role: label?.getAttribute('role'),
    disclosure: root.querySelector('.field-status-disclosure')?.textContent, action: root.querySelector('.field-status-action')?.textContent,
    actionName: root.querySelector('.field-status-action')?.getAttribute('aria-label'), open: root.querySelector('details')?.open,
    inner: [...root.querySelectorAll('.field-status-item button')].map((b) => b.textContent),
    focusable: root.querySelectorAll('button, summary, a[href], input, select, textarea, [tabindex]').length };
});
const active = () => evaluate(() => { const el = document.activeElement; return el && el !== document.body ? (el.getAttribute('aria-label') || el.className || el.tagName) + '|' + el.textContent.trim().slice(0, 40) : 'body'; });
async function tabTo(test, label) {
  for (let i = 0; i < 120; i++) { if (await evaluate(test)) return; await key('Tab'); }
  throw Error('Tab never reached ' + label);
}

ipcMain.handle('notices:restore', () => ({ project: saved, location }));
ipcMain.handle('notices:catalog', () => ({ catalog: { projectName: 'Notice fixture', commands: [], warnings: [] }, bookmarkId: 'fixture' }));
ipcMain.handle('notices:save', (_event, project) => {
  if (saveMode === 'fail') throw Error('EACCES: permission denied, open \'C:\\fixtures\\Notice project\\.bordeaux-workspace.json\'');
  saved = structuredClone(project); saves++; return { saved: true, location };
});
ipcMain.handle('notices:export', (_event, kind) => {
  if (exportMode === 'fail') throw Error('Event event1: command labview.legacy.9550c83fef51616cba926b82 is missing in the linked LabVIEW project. Inspect commands before exporting BDX.');
  return kind === 'path' ? { exported: true, relativePath: 'paths/Collect along the alliance wall.bdx', sampleCount: 312, eventCount: 1 }
    : { exported: true, relativePath: 'routines/Two piece.bdxr', nodeCount: 2, pathCount: 2 };
});
ipcMain.handle('notices:update-state', () => updateState);
ipcMain.handle('notices:update-visible', (_event, visible) => { updateState = updateState && { ...updateState, visible }; win.webContents.send('notices:update-changed', updateState); });
ipcMain.handle('notices:update-call', (_event, name) => { updateCalls.push(name); });
ipcMain.handle('notices:robot-call', (_event, name) => { robotCalls.push(name); throw Error('Unexpected robot operation: ' + name); });
ipcMain.on('notices:published', () => {});
const setUpdate = (patch) => { updateState = { ...updateState, ...patch }; win.webContents.send('notices:update-changed', updateState); return delay(150); };

// Bounds a step that could otherwise wait forever (a stalled navigation, or a capture after a failure).
function within(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Timed out: ' + label)), ms); })]).finally(() => clearTimeout(timer));
}
// Each size gets a fresh window: the previous page holds unsaved edits, and navigating it away is not what this checks.
async function load(width, height, units) {
  saved.editor.unitSystem = units;
  const previous = win;
  win = new BrowserWindow({ show: true, width, height, useContentSize: true,
    webPreferences: { preload: path.join(__dirname, 'verify-notification-ui-preload.cjs'), sandbox: false, contextIsolation: true, backgroundThrottling: false } });
  previous?.destroy();
  win.webContents.on('console-message', (details) => { if (details.level === 'error' && !details.message.startsWith("Loading the font 'data:")) errors.push(details.message); });
  await within(win.loadFile(path.resolve('dist-renderer/index.html')), 30000, 'fixture page load');
  await focusWindow();
  await wait(() => evaluate(() => document.querySelectorAll('.pt-wp').length > 0 && document.querySelector('.fieldcol')?.dataset.planningReady === 'true'), 'current trajectory');
  await park();
}
async function inspector(open) {
  const isOpen = await evaluate(() => document.querySelector('.pp-more')?.getAttribute('aria-expanded') === 'true');
  if (isOpen !== open) await click('.pp-more');
  await delay(250);
}
async function injectPlanningFailure() {
  await evaluate(() => {
    const post = Worker.prototype.postMessage;
    window.restorePlanner = () => { Worker.prototype.postMessage = post; delete window.restorePlanner; };
    Worker.prototype.postMessage = function (message, ...args) {
      if (message.mode === 'editing') {
        setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data: { id: message.id, error: { message: 'Controlled planning failure: the trajectory exceeds the acceleration limit near waypoint 3. Lower Speed or move the waypoint.' } } })), 0);
        return;
      }
      return post.call(this, message, ...args);
    };
  });
}
async function editSpeed(value) {
  const selector = await evaluate(() => '#' + CSS.escape([...document.querySelectorAll('.path-band label.numlbl')].find((el) => el.textContent === 'Speed').htmlFor));
  await click(selector);
  await evaluate((selector) => document.querySelector(selector).select(), selector);
  await win.webContents.insertText(String(value));
  await key('Enter');
}
async function exportFromLibrary() {
  await click('[aria-label="Actions for Collect along the alliance wall"]');
  await click('.library-menu [role="menuitem"]', 'Export BDX…');
}

app.on('window-all-closed', () => {}); // Replacing the window between sizes is not a quit; the check exits explicitly.
app.whenReady().then(async () => {
  try {
    const corpus = JSON.parse(await fs.readFile('benchmarks/planner-corpus/v3/corpus.bordeaux.json', 'utf8'));
    const pick = (id, name) => ({ ...structuredClone(corpus.paths.find((p) => p.id === id)), name });
    const wall = pick('corpus-neutral-stop', 'Collect along the alliance wall'), slalom = pick('corpus-neutral-slalom', 'Slalom warm-up');
    const spare = pick('corpus-blue-table-trench', 'Spare path to delete'); spare.id = 'spare-path';
    wall.ranges = []; // Keeps the whole-path speed edit the only limit.
    saved = { ...corpus, paths: [wall, slalom, spare], pathLinks: [], pathFolders: [],
      routines: [{ id: 'two-piece', name: 'Two piece', nodes: [{ id: 'first', type: 'path', ref: wall.id }, { id: 'second', type: 'path', ref: slalom.id }] }],
      activeRoutineId: 'two-piece', editor: { activePathId: wall.id, unitSystem: 'metric' } };
    updateState = { phase: 'idle', visible: false, currentVersion: '0.2.0-beta.27', version: null, releaseNotes: '' };
    const sizes = [[1440, 900, 'metric'], [1100, 720, 'imperial']].filter(([width]) => !process.env.BORDEAUX_NOTIFICATION_UI_WIDTH || String(width) === process.env.BORDEAUX_NOTIFICATION_UI_WIDTH);
    for (const [width, height, units] of sizes) {
      console.log('Checking ' + width + 'x' + height + ' ' + units);
      exportMode = 'ok'; saveMode = 'ok';
      await load(width, height, units);

      // Space plays and pauses while the pointer holds a hover tooltip open.
      await hover('[aria-label="Toggle field grid"]');
      await wait(() => evaluate(() => document.querySelector('#app-tooltip')?.matches(':popover-open')), 'hover tooltip');
      assert.equal(await active(), 'body');
      const grid = await evaluate(() => document.querySelector('[aria-label="Toggle field grid"]').getAttribute('aria-pressed'));
      await key('Space');
      await wait(() => evaluate(() => Boolean(document.querySelector('[aria-label="Pause trajectory playback"]'))), 'Space plays under a hover tooltip');
      assert.equal(await evaluate(() => document.querySelector('#app-tooltip').matches(':popover-open')), true, 'tooltip still shown');
      assert.equal(await evaluate(() => document.querySelector('[aria-label="Toggle field grid"]').getAttribute('aria-pressed')), grid, 'Space does not toggle the hovered Grid');
      await snapshot('space-under-tooltip-' + width);
      await key('Space');
      await wait(() => evaluate(() => Boolean(document.querySelector('[aria-label="Play trajectory"]'))), 'Space pauses under a hover tooltip');
      // A control clicked with the mouse keeps focus, but Space still plays and pauses instead of operating it.
      await click('#field-overlay-metric');
      await wait(() => evaluate(() => document.querySelector('#field-overlay-metric').getAttribute('aria-expanded') === 'true'), 'overlay picker opens');
      await click('#field-overlay-metric');
      await wait(() => evaluate(() => document.querySelector('#field-overlay-metric').getAttribute('aria-expanded') === 'false'), 'overlay picker closes');
      assert.equal(await evaluate(() => document.activeElement?.id), 'field-overlay-metric', 'clicked picker keeps focus');
      await key('Space');
      await wait(() => evaluate(() => Boolean(document.querySelector('[aria-label="Pause trajectory playback"]'))), 'Space plays after clicking a picker');
      assert.equal(await evaluate(() => document.querySelector('#field-overlay-metric').getAttribute('aria-expanded')), 'false', 'Space does not open the clicked picker');
      await key('Space');
      await wait(() => evaluate(() => Boolean(document.querySelector('[aria-label="Play trajectory"]'))), 'Space pauses after clicking a picker');
      await park();
      // An open menu still owns Space.
      await click('[aria-label="Actions for Slalom warm-up"]');
      await key('Space');
      assert.equal(await evaluate(() => Boolean(document.querySelector('[aria-label="Play trajectory"]'))), true, 'An open menu keeps Space');
      await key('Escape');
      await park();

      // A successful export is one quiet line: no Details, no Dismiss, nothing to focus. Its detail is the tooltip.
      await exportFromLibrary(); await park();
      await wait(async () => (await status())?.label === 'BDX exported', 'export success');
      const exportDetail = () => evaluate(() => document.querySelector('.fieldcol:not([hidden]) .field-confirmation, .routine-export-notices .field-confirmation')?.title || '');
      assert.match(await exportDetail(), /312 samples, 1 event\./, 'Counts read as words (one event)');
      let current = await status();
      assert.deepEqual([current.confirmation, current.error, current.role, current.action, current.disclosure, current.open, current.focusable],
        [true, false, 'status', undefined, undefined, undefined, 0], 'Success is a compact confirmation without controls');
      const compact = await evaluate(() => {
        const box = document.querySelector('.fieldcol .field-confirmation').getBoundingClientRect(), field = document.querySelector('.fieldcol').getBoundingClientRect();
        const tools = document.querySelector('.field-view-tools').getBoundingClientRect();
        return { height: box.height, width: box.width, inside: box.left >= field.left && box.right <= field.right, clearOfTools: box.bottom <= tools.top };
      });
      assert.ok(compact.height <= 32 && compact.width <= 200, 'Confirmation stays compact: ' + JSON.stringify(compact));
      assert.deepEqual([compact.inside, compact.clearOfTools], [true, true], 'Confirmation sits within the field, above the view tools');
      await snapshot('export-success-' + width);
      // Pointer: hovering shows the full detail and holds the confirmation past its lifetime.
      await hover('.fieldcol .field-confirmation');
      await wait(() => evaluate(() => document.querySelector('#app-tooltip')?.matches(':popover-open') && /312 samples, 1 event\./.test(document.querySelector('#app-tooltip').textContent)), 'detail tooltip');
      await snapshot('export-success-detail-' + width);
      await delay(5400);
      assert.equal((await status())?.label, 'BDX exported', 'Hover pauses the confirmation expiry');
      // Leaving it lets it expire on its own without moving keyboard focus.
      await click('.toolbar .place[aria-current="page"]'); await park();
      await wait(async () => !(await status()), 'confirmation expires', 120);
      assert.equal(await evaluate(() => document.activeElement?.matches('.toolbar .place[aria-current="page"]')), true, 'Expiry keeps focus');
      pass(width + ': export success is a compact confirmation without controls; hover shows detail and pauses; expiry keeps focus');

      // A second export: a failure that arrives while it shows leads it.
      await exportFromLibrary(); await park();
      await wait(async () => (await status())?.label === 'BDX exported', 'second export success');

      // Planning fails while that success is still shown: the failure leads, with its own Try again.
      await injectPlanningFailure();
      await editSpeed(units === 'metric' ? 2.4 : 7.9);
      await wait(async () => (await status())?.label === 'Couldn’t time this path', 'planning failure leads');
      await park();
      current = await status();
      assert.deepEqual([current.error, current.role, current.action, current.actionName, current.disclosure], [true, 'alert', 'Try again', null, 'Details (2)']);
      await click('.fieldcol .field-status summary'); await park();
      current = await status();
      assert.equal(current.open, true); assert.equal(current.disclosure, 'Details (2)');
      assert.deepEqual(current.inner, [], 'The listed success has no Dismiss; Try again is not repeated');
      assert.equal(await evaluate(() => [...document.querySelectorAll('.fieldcol .field-status button')].some((b) => b.textContent === 'Dismiss')), false, 'No Dismiss for the success anywhere');
      const geometry = await evaluate(() => {
        const box = document.querySelector('.fieldcol .field-status').getBoundingClientRect(), field = document.querySelector('.fieldcol').getBoundingClientRect();
        const tools = document.querySelector('.field-view-tools').getBoundingClientRect();
        return { left: box.left >= field.left, right: box.right <= field.right, clearOfTools: box.bottom <= tools.top };
      });
      assert.deepEqual(geometry, { left: true, right: true, clearOfTools: true }, 'Expanded details stay within the field and above the view tools');
      await snapshot('failure-over-success-details-' + width);
      // Expanded details keep the success past its lifetime; collapsing lets it expire without touching the failure or focus.
      await delay(5400);
      assert.equal((await status()).disclosure, 'Details (2)', 'Open details pause the success expiry');
      await click('.fieldcol .field-status summary'); await park();
      await click('.toolbar .place[aria-current="page"]'); await park();
      await wait(async () => (await status())?.disclosure === 'Details', 'success expires behind the failure', 120);
      assert.equal((await status()).label, 'Couldn’t time this path', 'The failure never expires');
      assert.equal(await evaluate(() => document.activeElement?.matches('.toolbar .place[aria-current="page"]')), true, 'Expiry keeps focus');
      for (const open of [false, true]) {
        await inspector(open);
        await snapshot('planning-failure-inspector-' + (open ? 'open' : 'closed') + '-' + width);
      }

      // Keyboard: reach the summary, then its own action; Try again recovers and focus returns to where it came from.
      await evaluate(() => window.restorePlanner());
      await tabTo(() => document.activeElement?.matches('.fieldcol .field-status summary'), 'status summary');
      await key('Tab');
      assert.equal(await evaluate(() => document.activeElement?.matches('.field-status-action') && document.activeElement.textContent), 'Try again');
      await key('Enter');
      await wait(() => evaluate(() => !document.querySelector('.fieldcol .field-status') && document.querySelector('.fieldcol').dataset.planningReady === 'true'), 'Try again restores timing');
      await delay(100);
      // Its origin was the problem marker the retry removed, so the field takes focus.
      assert.equal(await evaluate(() => document.activeElement?.matches('.fieldsvg')), true, 'Focus returns to the field, not the page');
      await key('z', ['control']); // Undo the speed edit; the planner is restored.
      await wait(() => evaluate(() => document.querySelector('.fieldcol').dataset.planningReady === 'true'), 'Undo speed');
      pass(width + ': failure leads a coexisting success with its own Try again; details pause; success expires quietly; keyboard recovery returns focus');

      // A failed export stays until dismissed; with a planning failure, the one dismissed is the export.
      exportMode = 'fail';
      await injectPlanningFailure(); await editSpeed(units === 'metric' ? 2.3 : 7.5);
      await wait(async () => (await status())?.label === 'Couldn’t time this path', 'planning failure');
      win.webContents.send('notices:menu', { command: 'export-bdx' });
      await wait(async () => (await status())?.disclosure === 'Details (2)', 'two failures');
      current = await status();
      assert.deepEqual([current.label, current.action], ['Export failed', 'Dismiss'], 'Errors keep their order; the action belongs to the summarized one');
      await click('.fieldcol .field-status summary'); await park();
      assert.deepEqual((await status()).inner, ['Try again']);
      await snapshot('two-failures-details-' + width);
      await click('.fieldcol .field-status-action', 'Dismiss'); await park();
      current = await status();
      assert.deepEqual([current.label, current.action, current.disclosure], ['Couldn’t time this path', 'Try again', 'Details'], 'Dismiss retires only the export failure');
      await evaluate(() => window.restorePlanner());
      await click('.fieldcol .field-status-action', 'Try again');
      await wait(() => evaluate(() => !document.querySelector('.fieldcol .field-status')), 'retry clears');
      await key('z', ['control']);
      exportMode = 'ok';
      pass(width + ': two failures order, own-action Dismiss and pointer Try again');

      // Compact properties header and labels.
      await inspector(false);
      await click('.pt-wp:not(.start):not(.end)');
      await wait(() => evaluate(() => /^Waypoint \d/.test(document.querySelector('.pp-title')?.textContent || '')), 'waypoint properties');
      const header = await evaluate(() => {
        const title = document.querySelector('.pp-title');
        const cut = [...document.querySelectorAll('.pp .numlbl')].filter((label) => label.scrollWidth > label.clientWidth + 0.5).map((label) => label.textContent);
        // Every word of the title sits on one line (a long name may wrap between words, never inside one).
        const text = title.firstChild, split = [];
        for (const match of text.textContent.matchAll(/\S+/g)) {
          const range = document.createRange(); range.setStart(text, match.index); range.setEnd(text, match.index + match[0].length);
          if (new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size > 1) split.push(match[0]);
        }
        const range = document.createRange(); range.selectNodeContents(text);
        return { split, cut, lines: new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size,
          power: document.querySelector('.pp-head-actions .qbtn')?.getBoundingClientRect().height, more: document.querySelector('.pp-more').getBoundingClientRect().height };
      });
      assert.deepEqual(header.split, [], 'No title word breaks across lines');
      assert.equal(header.lines, 1, 'A waypoint title keeps its number on its line beside Clear selection');
      assert.deepEqual(header.cut, [], 'No truncated property labels');
      assert.equal(header.power, header.more, 'Power and More share a height');
      await snapshot('waypoint-band-' + width);
      await key('Escape');
      await wait(() => evaluate(() => document.querySelector('.pp-title')?.textContent === 'Path'), 'path properties');
      assert.deepEqual(await evaluate(() => [...document.querySelectorAll('.pp .numlbl')].filter((label) => label.scrollWidth > label.clientWidth + 0.5).map((l) => l.textContent)), [], 'Path labels whole');
      await snapshot('path-band-' + width);
      pass(width + ' ' + units + ': compact header keeps whole words and labels');

      // Deletion Undo: hover and focus pause it; Enter restores and returns focus to the library.
      await evaluate(() => document.querySelector('[data-library-item="spare-path"]').focus());
      await key('Delete');
      await wait(() => evaluate(() => Boolean(document.querySelector('.deletion-notice')) && !document.querySelector('[data-library-item="spare-path"]')), 'deletion notice');
      await hover('.deletion-notice');
      await delay(6600);
      assert.equal(await evaluate(() => Boolean(document.querySelector('.deletion-notice button:not([aria-disabled])'))), true, 'Hover keeps Undo');
      await snapshot('deletion-undo-' + width);
      await park();
      await evaluate(() => document.querySelector('.deletion-notice button').focus());
      await delay(6600);
      assert.equal(await evaluate(() => Boolean(document.querySelector('.deletion-notice button:not([aria-disabled])'))), true, 'Focus keeps Undo');
      await key('Enter');
      await wait(() => evaluate(() => Boolean(document.querySelector('[data-library-item="spare-path"]'))), 'Undo restores the path');
      assert.equal(await evaluate(() => document.activeElement?.matches('.library-pick, .library-search')), true, 'Undo returns focus to the library');
      pass(width + ': deletion Undo paused by hover and focus, restored by Enter with focus return');

      // Save failure is a fact with Retry on the project chip.
      saveMode = 'fail';
      await click('.project-chip'); await click('[role="menuitem"][data-action="save"]');
      await wait(() => evaluate(() => document.querySelector('.project-chip')?.dataset.status === 'failed'), 'save failure');
      assert.match(await evaluate(() => document.querySelector('.project-chip').textContent), /Not saved/);
      await evaluate(() => document.querySelector('.project-chip').focus());
      await key('Enter');
      await wait(() => evaluate(() => Boolean(document.querySelector('#project-menu [role="alert"]'))), 'failure fact in menu');
      await snapshot('save-failed-menu-' + width);
      saveMode = 'ok';
      const before = saves;
      await wait(() => evaluate(() => document.activeElement?.textContent.trim() === 'Retry'), 'Retry focused first');
      await key('Enter');
      await wait(() => saves > before && evaluate(() => document.querySelector('.project-chip')?.dataset.status === 'saved'), 'Retry saves');
      assert.equal(await evaluate(() => document.activeElement?.classList.contains('project-chip')), true, 'Focus returns to the chip');
      pass(width + ': save failure shows its fact; keyboard Retry saves and returns focus');

      // Update panel: an interrupted download explains itself with Retry; Escape returns focus to the toolbar button.
      await setUpdate({ phase: 'error', errorStage: 'download', version: '0.2.0-beta.28', error: 'Download failed: net::ERR_CONNECTION_RESET while downloading Bordeaux-Setup.exe', visible: false });
      await click('.update-button');
      await wait(() => evaluate(() => document.querySelector('dialog.app-update-dialog')?.open), 'update panel');
      assert.equal(await evaluate(() => document.querySelector('dialog.app-update-dialog').matches(':modal')), false, 'nonmodal');
      assert.ok(await evaluate(() => [...document.querySelectorAll('dialog.app-update-dialog button')].some((b) => b.textContent === 'Retry download')));
      await snapshot('update-error-' + width);
      await key('Escape');
      await wait(() => evaluate(() => !document.querySelector('dialog.app-update-dialog').open && document.activeElement?.classList.contains('update-button')), 'Escape returns to the update button');
      await setUpdate({ phase: 'idle', visible: false, error: null, errorStage: null });
      pass(width + ': update interruption with Retry download; Escape returns focus');

      // Routines: export notices sit above the transport, never over it; a failure explains itself and dismisses by keyboard.
      await click('.places .place', 'Routines');
      await wait(() => evaluate(() => Boolean(document.querySelector('.rt-transport'))), 'routine transport');
      const transportTop = () => evaluate(() => document.querySelector('.routine-workspace-transport').getBoundingClientRect().top);
      const top = await transportTop();
      win.webContents.send('notices:menu', { command: 'export-routine' });
      await wait(async () => (await status())?.label === 'Routine exported', 'routine export success');
      assert.match(await exportDetail(), /2 steps, 2 embedded paths\./, 'Routine counts read as words');
      current = await status();
      assert.deepEqual([current.confirmation, current.role, current.action, current.disclosure, current.focusable], [true, 'status', undefined, undefined, 0], 'Routine success is a compact confirmation');
      assert.equal(await transportTop(), top, 'Transport stays put');
      await snapshot('routine-export-success-' + width);
      exportMode = 'fail';
      win.webContents.send('notices:menu', { command: 'export-routine' });
      await wait(async () => (await status())?.label === 'Export failed', 'routine export failure');
      await click('.routine-export-notices summary'); await park();
      const routineGeometry = await evaluate(() => ({ notice: document.querySelector('.routine-export-notices').getBoundingClientRect().bottom, transport: document.querySelector('.routine-workspace-transport').getBoundingClientRect().top }));
      assert.ok(routineGeometry.notice <= routineGeometry.transport + 0.5, 'Expanded routine failure does not cover the transport');
      await snapshot('routine-export-failure-' + width);
      await tabTo(() => document.activeElement?.matches('.routine-export-notices .field-status-action'), 'routine Dismiss');
      await key('Enter');
      await wait(() => evaluate(() => !document.querySelector('.routine-export-notices')), 'routine failure dismissed');
      assert.notEqual(await active(), 'body', 'Focus does not fall to the page');
      exportMode = 'ok';
      pass(width + ': routine export success/failure above the transport; keyboard Dismiss keeps focus');
    }

    assert.deepEqual(robotCalls, [], 'no robot transport calls');
    assert.deepEqual(errors, [], 'renderer console errors');
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ ok: true, passed, saves, updateCalls }, null, 2));
    console.log('Notification and status checks passed. Screenshots: ' + output);
    app.exit(0);
  } catch (error) {
    console.error(error);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ ok: false, error: String(error && error.stack || error), errors, passed }, null, 2)).catch(() => {});
    try {
      console.error('Status:', JSON.stringify(await within(status(), 5000, 'status')), 'Active:', await within(active(), 5000, 'active'));
      await within(snapshot('failure'), 10000, 'failure capture');
    } catch (_) { /* The page may be gone or stalled. */ }
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ ok: false, error: String(error && error.stack || error), errors, passed }, null, 2)).catch(() => {});
    app.exit(1);
  }
});
