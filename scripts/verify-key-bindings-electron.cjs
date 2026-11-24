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
// The label format each platform shows: "⇧⌘S" on macOS, "Ctrl+Shift+S" elsewhere.
const M = (k, shift = false) => mac ? (shift ? '⇧' : '') + '⌘' + k : 'Ctrl+' + (shift ? 'Shift+' : '') + k;

ipcMain.handle('keys:restore', () => ({ project: saved }));
ipcMain.handle('keys:save', (_event, project) => { saved = project; saves++; return { saved: true }; });
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

  // Grid, fit and focus field.
  const grid = await pressed('Toggle field grid');
  await key('g'); assert.notEqual(await pressed('Toggle field grid'), grid, 'G toggles the grid');
  await key('g'); assert.equal(await pressed('Toggle field grid'), grid);
  const fit = await evaluate(() => document.querySelector('.vc-pct').textContent);
  await click('[aria-label="Zoom in"]'); await click('[aria-label="Zoom in"]');
  assert.notEqual(await evaluate(() => document.querySelector('.vc-pct').textContent), fit);
  await key('f'); assert.equal(await evaluate(() => document.querySelector('.vc-pct').textContent), fit, 'F fits the field');
  const focusTitle = () => evaluate(() => [...document.querySelectorAll('button[title]')].find(b => b.title.includes('the path list'))?.title);
  assert.equal(await focusTitle(), 'Hide the path list  (\\)');
  await key('\\'); await wait(async () => (await focusTitle()) === 'Show the path list  (\\)', '\\ hides the path list');
  await key('\\'); await wait(async () => (await focusTitle()) === 'Hide the path list  (\\)', '\\ shows the path list');
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
    ['Fit field', 'F'], ['Toggle grid', 'G'], ['Focus field', '\\'], ['Next pass through a point', ']'], ['Previous pass through a point', '['],
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
    const rows = await evaluate(() => [...document.querySelectorAll('.keyboard-help tr')].map(row => [...row.cells].map(cell => cell.textContent)));
    assert.deepEqual(rows, expected);
    await snapshot(`shortcuts-dialog-${width}`);
    await key('Escape');
  }
  console.log('PASS shortcuts dialog lists the registry and fixed keys');
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
  const rows = Object.fromEntries(await evaluate(() => [...document.querySelectorAll('.keyboard-help tr')].map(row => [row.cells[0].textContent, row.cells[1].textContent])));
  assert.equal(rows['Place waypoint'], 'Q');
  assert.equal(rows['Save project and BDX files'], M('K', true));
  assert.equal(rows['Place rotation'], '3 or R');
  await snapshot('shortcuts-dialog-user-rules');
  await key('Escape');
  console.log('PASS labels, project menu and shortcuts dialog show the user keys');
}

app.whenReady().then(async () => {
  try {
    const corpus = JSON.parse(await fs.readFile('benchmarks/planner-corpus/v2/corpus.bordeaux.json', 'utf8'));
    const first = structuredClone(corpus.paths.find(p => p.id === 'corpus-neutral-stop'));
    saved = { ...corpus, paths: [first], pathLinks: [], editor: { activePathId: first.id, unitSystem: 'metric' } };
    win = new BrowserWindow({ show: true, width: 1440, height: 900, useContentSize: true, webPreferences: { preload: path.join(__dirname, 'verify-key-bindings-preload.cjs'), sandbox: false, contextIsolation: true, backgroundThrottling: false } });
    win.webContents.on('console-message', details => { if (details.level === 'error' && !details.message.startsWith("Loading the font 'data:")) errors.push(details.message); });
    await win.loadFile(path.resolve('dist-renderer/index.html')); win.focus(); win.webContents.focus();
    await wait(() => evaluate(() => document.querySelector('.fieldcol')?.dataset.planningReady === 'true'), 'planning');
    await click('.places .place', 'Paths');

    if (customRules) await customChecks(); else await defaultChecks(first);

    assert.deepEqual(errors, []);
    assert.deepEqual(robotCalls, []);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'passed', platform, customRules, sizes: [[1440, 900], [1100, 720]] }, null, 2));
  } catch (error) {
    process.exitCode = 1; console.error(error, errors);
    if (win) { try { await snapshot('failure'); } catch (captureError) { console.error('Failure capture unavailable:', captureError); } }
  } finally { win?.destroy(); app.exit(process.exitCode || 0); }
});
