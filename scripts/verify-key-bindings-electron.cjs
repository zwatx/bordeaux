// Drives the built app with native key events and checks that every default binding still runs its command, that
// typing keeps its keys, and that labels and the shortcuts dialog read the registry. Launched by verify-key-bindings.mjs.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = process.env.BORDEAUX_KEYS_OUTPUT;
const platform = process.env.BORDEAUX_KEYS_PLATFORM || 'win32';
const mac = platform === 'darwin';
const MOD = mac ? 'meta' : 'control';
const customRules = Boolean(process.env.BORDEAUX_KEYS_RULES);
const editingRun = process.env.BORDEAUX_KEYS_MODE === 'editing';
app.setPath('userData', path.join(output, 'user-data'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
let win, saved, saves = 0;
const errors = [], robotCalls = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true);
async function wait(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(75); } throw Error('Timed out: ' + label); }
async function click(selector, text) {
  let point;
  await wait(async () => {
    point = await evaluate((selector, text) => {
      const item = [...document.querySelectorAll(selector)].find((el) => !text || el.textContent.trim() === text);
      if (!item || item.disabled) return null;
      item.scrollIntoView({ block: 'nearest' });
      const r = item.getBoundingClientRect(), x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
      return item.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
    }, selector, text);
    return Boolean(point);
  }, 'available control: ' + selector + ' ' + (text || ''));
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
  await delay(80);
}
async function key(keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  // Chromium presses a focused button on Enter's char event.
  if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await delay(90);
}
async function snapshot(name) { await fs.writeFile(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
const pressed = (label) => evaluate((label) => document.querySelector(`[aria-label="${label}"]`)?.getAttribute('aria-pressed'), label);
const attr = (selector, name) => evaluate((selector, name) => document.querySelector(selector)?.getAttribute(name), selector, name);
const playing = () => evaluate(() => document.querySelector('.pt-play').getAttribute('aria-label').startsWith('Pause'));
// The open modal's accessible name, from aria-label or aria-labelledby, or null when none is open.
const modal = () => evaluate(() => {
  const dialog = document.querySelector('dialog:modal,[role="dialog"][aria-modal="true"]');
  if (!dialog) return null;
  return dialog.getAttribute('aria-label') || document.getElementById(dialog.getAttribute('aria-labelledby'))?.textContent.trim() || 'unnamed';
});
// The shortcuts dialog's rows as [label, keys], keys joined with " or ".
const dialogRows = () => evaluate(() => [...document.querySelectorAll('.keyboard-help .kh-row')]
  .map(row => [row.firstElementChild.textContent, [...row.querySelectorAll('kbd,.kh-chip')].map(key => key.textContent).join(' or ')]));
// The label format each platform shows: "⇧⌘S" on macOS, "Ctrl+Shift+S" elsewhere.
const M = (k, shift = false) => mac ? (shift ? '⇧' : '') + '⌘' + k : 'Ctrl+' + (shift ? 'Shift+' : '') + k;

ipcMain.handle('keys:restore', () => ({ project: saved }));
ipcMain.handle('keys:save', (_event, project) => { saved = project; saves++; return { saved: true }; });
// The host's key storage: starts from BORDEAUX_KEYS_RULES and keeps what sanitizeUserKeyRules accepts, as main does.
const { sanitizeUserKeyRules } = require('../dist-electron/core/keyBindings.js');
let userRules = sanitizeUserKeyRules(JSON.parse(process.env.BORDEAUX_KEYS_RULES || '[]'));
const recordingCalls = [];
ipcMain.handle('keys:get-rules', () => userRules);
ipcMain.handle('keys:set-rules', (_event, rules) => (userRules = sanitizeUserKeyRules(rules)));
ipcMain.handle('keys:recording', (_event, recording) => { recordingCalls.push(recording); });
ipcMain.handle('keys:robot-call', (_event, name) => { robotCalls.push(name); throw Error('Robot access during key test: ' + name); });
async function save() {
  const before = saves;
  await click('.project-chip');
  const label = await evaluate(() => document.querySelector('[data-action="save"] .project-menu-shortcut')?.textContent);
  assert.equal(label, M('S'), 'Project menu shows the Save key');
  await click('[data-action="save"]');
  await wait(() => saves > before, 'save');
}
const x1 = () => saved.paths[0].waypoints[1].x;

// Default keys: every binding runs its command, and every label shows the default key.
async function defaultChecks(first) {
  // Tools: digits, letters, and a letter with Shift held (always accepted).
  for (const [code, mods, label] of [['2', [], 'Place waypoint'], ['1', [], 'Select / move'], ['3', [], 'Rotation target'], ['4', [], 'Place command'], ['5', [], 'Zone'],
    ['w', [], 'Place waypoint'], ['v', [], 'Select / move'], ['r', [], 'Rotation target'], ['m', [], 'Place command'], ['c', [], 'Zone'], ['w', ['shift'], 'Place waypoint']]) {
    await key(code, mods);
    assert.equal(await pressed(label), 'true', `${mods.join('+')} ${code} selects ${label}`);
  }
  await key('1');
  console.log('PASS tool keys 1-5, V W R M C, Shift+W');

  // Grid, fit and the path list.
  const grid = await pressed('Toggle field grid');
  await key('g'); assert.notEqual(await pressed('Toggle field grid'), grid, 'G toggles the grid');
  await key('g'); assert.equal(await pressed('Toggle field grid'), grid);
  const fit = await evaluate(() => document.querySelector('.vc-pct').textContent);
  await click('[aria-label="Zoom in"]'); await click('[aria-label="Zoom in"]');
  assert.notEqual(await evaluate(() => document.querySelector('.vc-pct').textContent), fit);
  await key('f'); assert.equal(await evaluate(() => document.querySelector('.vc-pct').textContent), fit, 'F fits the field');
  const pathListTitle = () => evaluate(() => document.querySelector('.library-hide, .library-restore-btn')?.title);
  assert.equal(await pathListTitle(), 'Hide path list  (\\)');
  await key('\\'); await wait(async () => (await pathListTitle()) === 'Show path list  (\\)', '\\ hides the path list');
  await key('\\'); await wait(async () => (await pathListTitle()) === 'Hide path list  (\\)', '\\ shows the path list');
  console.log('PASS G, F and \\');

  // Typing keeps its keys: G in the library search does not toggle the grid.
  await click('.library-search'); await key('g');
  assert.equal(await pressed('Toggle field grid'), grid, 'Typing G in search leaves the grid');
  await key('Escape'); await click('.vc-pct');
  console.log('PASS text input owns G');

  // Playback: two presses, so the release of the first is claimed and the second still toggles.
  await key('Space'); await wait(playing, 'Space plays');
  await key('Space'); await wait(async () => !(await playing()), 'Space pauses');
  console.log('PASS Space plays and pauses');

  // Undo and Redo with every default key.
  await evaluate(() => document.querySelector('.pt-wp[data-selection="wp:1"]').focus());
  await key('Enter');
  await wait(() => evaluate(() => document.querySelector('.pt-wp[data-selection="wp:1"]').getAttribute('aria-pressed') === 'true'), 'waypoint selected');
  const x0 = first.waypoints[1].x;
  await key('Right'); await save(); assert.ok(Math.abs(x1() - x0 - 0.05) < 1e-9, 'Arrow nudges');
  await key('z', [MOD]); await save(); assert.ok(Math.abs(x1() - x0) < 1e-9, 'mod+Z undoes');
  await key('z', [MOD, 'shift']); await save(); assert.ok(Math.abs(x1() - x0 - 0.05) < 1e-9, 'mod+Shift+Z redoes');
  await key('z', [MOD]); await key('y', [MOD]); await save(); assert.ok(Math.abs(x1() - x0 - 0.05) < 1e-9, 'mod+Y redoes');
  console.log('PASS Undo and Redo keys');

  // Projects and New project open the Projects sheet in this host, which has no native menu.
  await click('.vc-pct');
  await key('o', [MOD]); await wait(async () => (await modal()) === 'Projects', 'mod+O opens Projects');
  await key('Escape'); await wait(async () => !(await modal()), 'Projects closes');
  await key('n', [MOD]); await wait(async () => (await modal()) === 'New project', 'mod+N opens New project');
  await key('Escape'); await wait(async () => !(await modal()), 'New project closes');
  console.log('PASS mod+O and mod+N');

  // Push opens the push flow without touching a robot.
  await key('p', [MOD, 'shift']);
  await wait(async () => (await modal()) === 'Robot connection', 'mod+Shift+P opens the push flow at robot connection');
  await snapshot('push-flow');
  await key('Escape'); await wait(async () => !(await modal()), 'push flow closes');
  assert.deepEqual(robotCalls, []);
  console.log('PASS mod+Shift+P opens the push flow with no robot call');

  // Labels read the registry.
  assert.equal(await attr('[aria-label="Select / move"]', 'title'), 'Select / move  (1 or V)');
  assert.equal(await evaluate(() => document.querySelector('[aria-label="Zone"] .toolrail-k').textContent), '5');
  assert.equal(await attr('[aria-label="Undo"]', 'title'), 'Undo  (' + M('Z') + ')');
  assert.equal(await attr('[aria-label="Redo"]', 'title'), 'Redo  (' + M('Z', true) + ')');
  assert.equal(await attr('.vc-pct', 'title'), 'Fit field  (F)');
  assert.equal(await attr('[aria-label="Toggle field grid"]', 'title'), 'Toggle field grid  (G)');
  assert.equal(await attr('.push-button', 'aria-keyshortcuts'), (mac ? 'Meta' : 'Control') + '+Shift+P');
  assert.equal(await attr('.push-button', 'data-shortcut'), M('P', true));
  console.log('PASS tooltips, rail digits and Push labels');

  // The shortcuts dialog lists every command from the registry, then the fixed keys.
  const expected = [
    ['Select / move', '1 or V'], ['Place waypoint', '2 or W'], ['Place rotation', '3 or R'], ['Place command', '4 or M'], ['Create zone', '5 or C'],
    ['Fit field', 'F'], ['Toggle grid', 'G'], ['Toggle path list', '\\'], ['Next pass through a point', ']'], ['Previous pass through a point', '['],
    ['Play / pause', 'Space'], ['Undo', M('Z')], ['Redo', M('Z', true) + ' or ' + M('Y')],
    ['New project', M('N')], ['Projects', M('O')], ['Open project file', M('O', true)], ['Save project and BDX files', M('S')], ['Save copy', M('S', true)],
    ['Export selected path as BDX', M('E')], ['Push selected paths', M('P', true)],
    ['Delete an item', 'Shift-click'], ['Delete selection', 'Delete / Backspace'], ['Cancel / select tool', 'Esc'], ['Move selection', 'Arrow keys'],
    ['Larger move', 'Shift + arrows'], ['Fine waypoint move', 'Alt + arrows'], ['Rename library item', 'F2'],
  ];
  for (const [width, height] of [[1440, 900], [1100, 720]]) {
    win.setContentSize(width, height); await delay(200);
    await click('.keyboard-help-trigger');
    await wait(() => evaluate(() => document.querySelector('.keyboard-help')?.open), 'shortcuts dialog');
    assert.deepEqual(await dialogRows(), expected);
    assert.equal(await evaluate(() => document.querySelectorAll('.keyboard-help .kh-chip').length), 0, 'The dialog opens read-only');
    await snapshot(`shortcuts-dialog-${width}`);
    await key('Escape');
  }
  console.log('PASS shortcuts dialog lists the registry and fixed keys');
}


// Editing in the shortcuts dialog: read-only at first, the pencil turns the same rows into keys that record the next
// key pressed. Each change goes to the host at once; the File menu is paused only while a key is recorded.
async function editingChecks() {
  const chip = (command, index) => `.keyboard-help [data-command="${command}"][data-index="${index}"]`;
  const box = (selector) => evaluate((selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y)]; }, selector);
  const note = () => evaluate(() => document.querySelector('.keyboard-help .kh-note')?.textContent || null);
  const rulesAre = (expected, label) => wait(() => JSON.stringify(userRules) === JSON.stringify(expected), label);
  const fitRule = { key: 'k', command: 'view.fit', when: 'pathsPage' };

  await click('.keyboard-help-trigger');
  await wait(() => evaluate(() => document.querySelector('.keyboard-help')?.open), 'shortcuts dialog');
  assert.equal(await attr('.kh-edit', 'aria-pressed'), 'false');
  const gridKey = await evaluate(() => {
    const row = [...document.querySelectorAll('.keyboard-help .kh-row')].find(r => r.firstElementChild.textContent === 'Toggle grid');
    const r = row.querySelector('kbd').getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y)];
  });
  await snapshot('editing-1-read-only');
  await click('.kh-edit');
  assert.equal(await attr('.kh-edit', 'aria-pressed'), 'true');
  assert.deepEqual(await box(chip('view.grid', 0)), gridKey, 'Keys stay in place when editing starts');
  console.log('PASS pencil turns read-only keys into editable keys without moving them');

  // Record K for Fit field; the File menu is paused only while recording.
  await click(chip('view.fit', 0));
  assert.equal(await evaluate((s) => document.querySelector(s).textContent, chip('view.fit', 0)), 'Press a key');
  await wait(() => recordingCalls.at(-1) === true, 'recording pauses the File menu');
  await key('k');
  await rulesAre([fitRule], 'K saved for Fit field');
  await wait(() => recordingCalls.at(-1) === false, 'recording ends');
  assert.equal(await evaluate((s) => document.querySelector(s).textContent, chip('view.fit', 0)), 'K');
  assert.equal(await attr('.vc-pct', 'title'), 'Fit field  (K)', 'Labels update at once');
  await snapshot('editing-2-recorded');
  // Esc cancels a recording and keeps the dialog open.
  await click(chip('view.fit', 0)); await key('Escape');
  assert.equal(await evaluate(() => document.querySelector('.keyboard-help').open), true, 'Esc during recording keeps the dialog');
  assert.equal(await evaluate(() => document.querySelectorAll('[data-recording]').length), 0);
  const focused = () => evaluate(() => [document.activeElement?.dataset.command, document.activeElement?.dataset.index]);
  assert.deepEqual(await focused(), ['view.fit', '0'], 'Esc leaves focus on the key');
  console.log('PASS recording K for Fit field saves it, pauses the menu only while recording, and Esc cancels');

  // Taking W from Place waypoint moves it, with a notice and Undo.
  await click(chip('view.grid', 0)); await key('w');
  await wait(() => userRules.some(r => r.command === 'view.grid' && r.key === 'w'), 'W saved for Toggle grid');
  assert.equal(await note(), "W was Place waypoint's key. Place waypoint still has 2.Undo");
  assert.ok(userRules.some(r => r.command === 'tool.waypoint' && r.key === '2') && !userRules.some(r => r.key === 'w' && r.command !== 'view.grid'));
  await snapshot('editing-3-moved');
  await click('.keyboard-help .kh-note button');
  await rulesAre([fitRule], 'Undo restores the keys');
  console.log('PASS taking W moves it from Place waypoint with a notice, and Undo restores it');

  // Problems leave the keys unchanged.
  await click(chip('project.save', 0)); await key('j');
  assert.equal(await note(), 'Save project and BDX files works while you type, so its key needs Ctrl.');
  await click(chip('robot.push', 0)); await key('p');
  assert.equal(await note(), 'Push selected paths works while you type, so its key needs Ctrl.');
  await click(chip('view.fit', 0)); await key('Space');
  assert.equal(await note(), 'Space is reserved for Bordeaux. Pick another key.');
  assert.equal(await evaluate(() => document.querySelector('[data-add="project.save"]')), null, 'File menu commands take one key');
  await click(chip('project.list', 0)); await key('F2');
  assert.equal(await note(), 'F2 is reserved for Bordeaux. Pick another key.');
  await snapshot('editing-4-blocked');
  assert.deepEqual(userRules, [fitRule]);
  console.log('PASS refused: a plain key for File menu commands and Push, Space for Fit field, and a reserved key');

  // Add a key, remove it with Backspace, reset one command, then reset all.
  await click('.keyboard-help [data-add="tool.rotation"]'); await key('e');
  await rulesAre([fitRule, ...['3', 'r', 'e'].map(k => ({ key: k, command: 'tool.rotation', when: 'pathsPage' }))], 'E added to Place rotation');
  await wait(async () => JSON.stringify(await focused()) === JSON.stringify(['tool.rotation', '2']), 'focus moves to the added key');
  await click(chip('tool.rotation', 2)); await key('Backspace');
  await rulesAre([fitRule], 'Backspace removes E, back to defaults');
  await click('.keyboard-help [aria-label="Use the default keys for Fit field"]');
  await rulesAre([], 'Fit field reset');
  await click(chip('view.fit', 0)); await key('k');
  await rulesAre([fitRule], 'K again');
  await click('.keyboard-help .kh-tools .qbtn');
  await rulesAre([], 'Use default keys');
  console.log('PASS add, Backspace removal, per-command reset and Use default keys');

  // Search, then Done returns to read-only with focus on the pencil.
  await click('.keyboard-help input[type="search"]'); await win.webContents.insertText('grid');
  assert.deepEqual((await dialogRows()).map(row => row[0]), ['Toggle grid']);
  await evaluate(() => { const input = document.querySelector('.keyboard-help input[type="search"]'); input.select(); });
  await key('Backspace');
  await click('.kh-foot .qbtn.primary');
  assert.equal(await attr('.kh-edit', 'aria-pressed'), 'false');
  assert.equal(await evaluate(() => document.activeElement?.classList.contains('kh-edit')), true, 'Done returns focus to the pencil');
  await key('Escape');
  assert.equal(await evaluate(() => document.activeElement?.classList.contains('keyboard-help-trigger')), true, 'Closing returns focus to ?');
  console.log('PASS search, Done and focus return');

  // Settings › General opens the dialog ready to edit; the row counts changed commands.
  await click('.places .place', 'Settings');
  const keyboardRow = () => evaluate(() => [...document.querySelectorAll('.settings-row')].find(row => row.textContent.startsWith('Keyboard shortcuts'))?.textContent);
  assert.equal(await keyboardRow(), 'Keyboard shortcutsDefaultsCustomize');
  await click('.settings-row .qbtn', 'Customize');
  await wait(() => evaluate(() => document.querySelector('.keyboard-help')?.open), 'dialog from Settings');
  assert.equal(await attr('.kh-edit', 'aria-pressed'), 'true', 'Customize opens editing');
  await click(chip('view.fit', 0)); await key('k');
  await rulesAre([fitRule], 'K from Settings');
  for (const [width, height] of [[1440, 900], [1100, 720]]) { win.setContentSize(width, height); await delay(250); await snapshot(`editing-settings-${width}`); }
  await key('Escape');
  assert.equal(await keyboardRow(), 'Keyboard shortcuts1 changedCustomize');
  assert.equal(await evaluate(() => document.activeElement?.textContent), 'Customize', 'Closing returns focus to Customize');
  console.log('PASS Settings row opens editing and counts changes');

  // Shift+V for Create zone and V for Select both work: an exact match wins over a letter accepting Shift.
  await click('.keyboard-help-trigger'); await click('.kh-edit');
  await click(chip('tool.zone', 0)); await key('v', ['shift']);
  await wait(() => userRules.some(r => r.command === 'tool.zone' && r.key === 'shift+v'), 'Shift+V saved for Create zone');
  await click(chip('tool.select', 0)); await key('x');
  await wait(() => userRules.some(r => r.command === 'tool.select' && r.key === 'x'), 'X saved for Select, after Create zone');
  await key('Escape');
  // Back on Paths, the new key works at once and the old one does nothing.
  await click('.places .place', 'Paths');
  await key('v', ['shift']); assert.equal(await pressed('Zone'), 'true', 'Shift+V selects Create zone');
  await key('v'); assert.equal(await pressed('Select / move'), 'true', 'V selects Select / move');
  const fit = await evaluate(() => document.querySelector('.vc-pct').textContent);
  await click('[aria-label="Zoom in"]');
  await key('f'); assert.notEqual(await evaluate(() => document.querySelector('.vc-pct').textContent), fit, 'F no longer fits');
  await key('k'); assert.equal(await evaluate(() => document.querySelector('.vc-pct').textContent), fit, 'K fits');
  assert.equal(recordingCalls.at(-1), false);
  console.log('PASS the edited key runs its command without a reload');
}

// User rules from the host (BORDEAUX_KEYS_RULES): Place waypoint moves to Q and Save to mod+Shift+K. A user rule
// replaces every default for its command, so 2 and W stop placing waypoints while other tools keep their keys.
async function customChecks() {
  await key('w'); assert.equal(await pressed('Select / move'), 'true', 'W no longer places waypoints');
  await key('2'); assert.equal(await pressed('Select / move'), 'true', '2 no longer places waypoints');
  await key('q'); assert.equal(await pressed('Place waypoint'), 'true', 'Q places waypoints');
  await key('3'); assert.equal(await pressed('Rotation target'), 'true', 'Other tools keep their default keys');
  await key('1');
  console.log('PASS user rule moves Place waypoint to Q; 2 and W stop; other tools keep defaults');

  assert.equal(await attr('[aria-label="Place waypoint"]', 'title'), 'Place waypoint  (Q)');
  assert.equal(await evaluate(() => document.querySelector('[aria-label="Place waypoint"] .toolrail-k').textContent), 'Q');
  await click('.project-chip');
  assert.equal(await evaluate(() => document.querySelector('[data-action="save"] .project-menu-shortcut')?.textContent), M('K', true));
  await key('Escape');
  await click('.keyboard-help-trigger');
  await wait(() => evaluate(() => document.querySelector('.keyboard-help')?.open), 'shortcuts dialog');
  const rows = Object.fromEntries(await dialogRows());
  assert.equal(rows['Place waypoint'], 'Q');
  assert.equal(rows['Save project and BDX files'], M('K', true));
  assert.equal(rows['Place rotation'], '3 or R');
  await snapshot('shortcuts-dialog-user-rules');
  await key('Escape');
  console.log('PASS labels, project menu and shortcuts dialog show the user keys');
}

app.whenReady().then(async () => {
  try {
    const corpus = JSON.parse(await fs.readFile('benchmarks/planner-corpus/v3/corpus.bordeaux.json', 'utf8'));
    const first = structuredClone(corpus.paths.find(p => p.id === 'corpus-neutral-stop'));
    saved = { ...corpus, paths: [first], pathLinks: [], editor: { activePathId: first.id } };
    win = new BrowserWindow({ show: true, width: 1440, height: 900, useContentSize: true, webPreferences: { preload: path.join(__dirname, 'verify-key-bindings-preload.cjs'), sandbox: false, contextIsolation: true, backgroundThrottling: false } });
    win.webContents.on('console-message', details => { if (details.level === 'error' && !details.message.startsWith("Loading the font 'data:")) errors.push(details.message); });
    await win.loadFile(path.resolve('dist-renderer/index.html')); win.focus(); win.webContents.focus();
    await wait(() => evaluate(() => document.querySelector('.fieldcol')?.dataset.planningReady === 'true'), 'planning');
    await click('.places .place', 'Paths');

    if (editingRun) await editingChecks(); else if (customRules) await customChecks(); else await defaultChecks(first);

    assert.deepEqual(errors, []);
    assert.deepEqual(robotCalls, []);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'passed', platform, customRules, editingRun, sizes: [[1440, 900], [1100, 720]] }, null, 2));
  } catch (error) {
    process.exitCode = 1; console.error(error, errors);
    if (win) { try { await snapshot('failure'); } catch (captureError) { console.error('Failure capture unavailable:', captureError); } }
  } finally { win?.destroy(); app.exit(process.exitCode || 0); }
});
