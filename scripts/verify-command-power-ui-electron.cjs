// Power estimates on command uses and limits that follow the robot's max, in the built renderer at both supported sizes:
// the Robot page counts uses with an estimate and Next missing opens one; Add stores an estimate that plans at once on
// a project without a robot list; a second use of the command offers Copy, which writes only the estimate (saved
// arguments the catalog no longer knows are kept); changing a use's settings asks for review; a duplicate shares its
// original's estimates until it sets its own, and a later path Undo changes neither robot's; and Max makes the
// speed limit follow each robot and come back exactly. No robot is contacted; screenshots go to
// BORDEAUX_COMMAND_POWER_UI_OUTPUT.
const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = process.env.BORDEAUX_BRANCH_UI_OUTPUT;
app.setPath('userData', path.join(output, 'user-data'));
let win, saved, saves = 0;
const errors = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true);
async function wait(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(75); } throw Error('Timed out: ' + label); }
// Real pointer input at the center of the first matching, unobscured control.
async function click(selector, text, button = 'left') {
  const point = await evaluate((selector, text) => {
    const item = [...document.querySelectorAll(selector)].find((el) => !text || el.textContent.trim() === text);
    if (!item || item.disabled) throw Error('Missing control: ' + selector + ' ' + (text || ''));
    item.scrollIntoView({ block: 'center' });
    const r = item.getBoundingClientRect(), x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    if (!item.contains(document.elementFromPoint(x, y))) throw Error('Obscured control: ' + selector + ' ' + text);
    return { x, y };
  }, selector, text);
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button, clickCount: 1, ...point });
  await delay(120);
}
async function key(keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await delay(90);
}
// A field in the open use's power estimate, found by its visible label.
async function typeField(label, text) {
  const id = await evaluate((label) => [...document.querySelectorAll('.cmd-power label')].find((el) => el.textContent === label)?.htmlFor, label);
  assert.ok(id, 'Power field ' + label);
  await click(`[id="${id}"]`);
  await key('Home'); await key('End', ['shift']);
  await win.webContents.insertText(text);
  await key('Enter');
}
async function save() { const before = saves; await click('.project-chip'); await click('[role="menuitem"][data-action="save"]'); await wait(() => saves > before, 'save'); }
async function capture() { for (let attempt = 0; attempt < 3; attempt++) { await delay(200); try { return await win.webContents.capturePage(); } catch (error) { if (attempt === 2) throw error; } } }
async function shot(name, prepare = async () => {}) {
  for (const [width, height] of [[1440, 900], [1100, 720]]) {
    win.setContentSize(width, height); await delay(250); await prepare();
    await fs.writeFile(path.join(output, `${name}-${width}.png`), (await capture()).toPNG());
  }
  win.setContentSize(1440, 900); await delay(150);
}
const pass = (name) => console.log('PASS ' + name);
const robotPage = async () => { await click('.places .place', 'Robot'); await wait(() => evaluate(() => !!document.querySelector('#settings-power .settings-row')), 'robot page'); };
const powerSummary = () => evaluate(() => document.querySelector('#settings-power .settings-row').textContent);
const toPower = () => evaluate(() => document.getElementById('settings-power').scrollIntoView({ block: 'start' }));
async function peakCurrent() {
  // The report waits for the current plan, which an estimate just changed.
  await wait(() => evaluate(() => [...document.querySelectorAll('.pp-head-actions button')].some((b) => b.textContent === 'Power' && !b.disabled)), 'current power report');
  await click('.pp-head-actions button', 'Power');
  await wait(() => evaluate(() => !!document.querySelector('.power-report .power-results')), 'power report');
  const peak = await evaluate(() => [...document.querySelectorAll('.power-report .power-results > div')].find((row) => row.querySelector('dt').textContent === 'Peak mechanism current')?.querySelector('.power-value').textContent);
  await key('Escape');
  return peak;
}
const num = (name, label, unit) => ({ name, label, unit, valueType: 'DBL', role: 'argument', schema: { kind: 'number', valueType: 'DBL' } });
const catalog = { runtime: 'labview', projectName: 'Fixture', sourceFileCount: 1, scannedAt: '', warnings: [], commands: [
  { id: 'shoot', label: 'Spin shooter', member: 'Shooter/Spin.vi', ownerType: 'LabVIEW', kind: 'factory', confidence: 'confirmed', source: { file: 'Spin.vi', line: 1 }, parameters: [num('rpm', 'Speed', 'RPM')], outputs: [], labviewConnector: {} },
] };
ipcMain.handle('branches:restore', () => ({ project: saved }));
ipcMain.handle('branches:catalog', () => ({ catalog, bookmarkId: 'fixture' }));
ipcMain.handle('branches:save', (_event, project) => { saved = project; saves++; return { saved: true }; });
ipcMain.handle('branches:connection', () => null);
ipcMain.handle('branches:use-endpoint', (_event, endpoint) => endpoint ? { endpoint } : null);
ipcMain.on('branches:published', () => {});
ipcMain.on('branches:confirm', (_event, message) => errors.push('confirm: ' + message));
ipcMain.handle('branches:robot-call', (_event, name) => { errors.push('robot call: ' + name); throw new Error('No robot in this check'); });

app.whenReady().then(async () => {
  try {
    const corpus = JSON.parse(await fs.readFile('benchmarks/planner-corpus/v3/corpus.bordeaux.json', 'utf8'));
    const first = structuredClone(corpus.paths.find((p) => p.id === 'corpus-neutral-stop'));
    first.name = 'Amp side 3 note';
    // The second event keeps an argument the catalog no longer has: editing its power must not drop it.
    first.markers = [
      { id: 'spin-up', f: 0.2, name: 'Spin up', invocation: { commandId: 'shoot', arguments: { rpm: 5000 } } },
      { id: 'spin-slow', f: 0.7, name: 'Spin slow', invocation: { commandId: 'shoot', arguments: { rpm: 2000, hood: 12 } } },
    ];
    // Synthetic preset drivetrain values for this check, not a real robot; no robot list, as before robots had names.
    const driveModel = { motorId: 'rev-vortex', motorFreeRpm: 6784, motorMaxTorqueNm: 3.6, motorCount: 4, gearRatio: 5.5, wheelDiameterM: 0.0762,
      massKg: 54.4, moiKgM2: 4, wheelbaseM: 0.521, trackwidthM: 0.618, wheelFrictionCoefficient: 1.1 };
    saved = { ...corpus, robot: { ...corpus.robot, w: 0.84, l: 0.84, maxSpeed: 4.92, driveModel }, paths: [first], pathLinks: [], routines: [], editor: { activePathId: first.id, robotProjectBookmarkId: 'fixture' } };
    win = new BrowserWindow({ show: true, width: 1440, height: 900, useContentSize: true, webPreferences: { preload: path.join(__dirname, 'verify-command-branches-ui-preload.cjs'), sandbox: false, contextIsolation: true, backgroundThrottling: false } });
    win.webContents.on('console-message', (details) => { if (details.level === 'error' && !details.message.startsWith("Loading the font 'data:")) errors.push(details.message); });
    await win.loadFile(path.resolve('dist-renderer/index.html'));
    win.focus(); win.webContents.focus();
    await wait(() => evaluate(() => document.querySelectorAll('.pt-wp').length > 0), 'editable path');

    await robotPage(); await toPower();
    assert.match(await powerSummary(), /0 of 2 command uses have an estimate for Robot/);
    await shot('robot-uses-none', toPower);
    await click('#settings-power button', 'Next missing');
    await wait(() => evaluate(() => !!document.querySelector('.cmd-power-add')), 'event power estimate');
    assert.equal(await evaluate(() => document.querySelector('.ctxinsp-t')?.textContent), 'Spin up', 'Next missing opens the first event without an estimate');
    await shot('estimate-missing');
    await click('.cmd-power-add');
    await typeField('Current', '62');
    await wait(() => evaluate(() => !!document.querySelector('.cmd-power .cmd-power-foot button')), 'estimate stored');
    // The project has no robot list; the estimate still plans before any save or reload.
    assert.equal(await peakCurrent(), '62.0 A', 'The first estimate on a single robot plans at once');
    await shot('estimate-set');
    pass('Next missing opens the event; Add power estimate stores 62 A, which plans at once on a project without a robot list');

    await robotPage(); await toPower();
    assert.match(await powerSummary(), /1 of 2 command uses/);
    await click('#settings-power button', 'Next missing');
    await wait(() => evaluate(() => !!document.querySelector('.cmd-power-offer')), 'copy offer');
    assert.match(await evaluate(() => document.querySelector('.cmd-power-offer').textContent), /This command in Amp side 3 note: 62 A/);
    await shot('estimate-offer');
    await click('.cmd-power-offer button', 'Copy');
    await wait(() => evaluate(() => !document.querySelector('.cmd-power-offer') && !!document.querySelector('.cmd-power input')), 'copied');
    await save();
    const slow = saved.paths[0].markers[1].invocation;
    assert.deepEqual(slow.arguments, { rpm: 2000, hood: 12 }, 'Copying an estimate keeps saved arguments the catalog no longer has');
    assert.deepEqual(Object.values(slow.power).map((estimate) => estimate.currentA), [62]);
    pass('A second use of the command offers Copy, which writes only the estimate and keeps the saved arguments');

    // Changing the first event's speed asks to review its estimate.
    // Each row on the Robot page opens its use.
    await robotPage(); await toPower();
    await click('.cmd-power-row');
    await wait(() => evaluate(() => document.querySelector('.ctxinsp-t')?.textContent === 'Spin up'), 'first event');
    const speedId = await evaluate(() => [...document.querySelectorAll('.cmd-parameters label')].find((el) => el.textContent.trim().startsWith('Speed'))?.htmlFor);
    await click(`[id="${speedId}"]`);
    await key('Home'); await key('End', ['shift']); await win.webContents.insertText('2500'); await key('Enter');
    // Leaving the field commits too, should the Enter arrive before the draft settles.
    if (!(await evaluate(() => !!document.querySelector('.cmd-power-review')))) await key('Tab');
    await wait(() => evaluate(() => !!document.querySelector('.cmd-power-review')), 'review state');
    await shot('estimate-review');
    pass('Changing a use\'s settings asks to review its estimate');

    // A duplicate shares the robot's estimates without changing any path; undoing the speed edit afterwards keeps that.
    await robotPage();
    await click('.robot-tab', 'Robot', 'right');
    await click('.ctxmenu .ctxmenu-i', 'Duplicate');
    await wait(() => evaluate(() => document.querySelector('.robot-tab[aria-selected="true"] .robot-tab-name')?.textContent === 'Robot 2'), 'duplicated robot');
    await click('.robot-tab', 'Robot');
    await wait(() => evaluate(() => document.querySelector('.robot-tab[aria-selected="true"] .robot-tab-name')?.textContent === 'Robot'), 'first robot again');
    await click('.places .place', 'Paths');
    await evaluate(() => document.activeElement?.blur());
    await key('Z', ['meta']);
    await wait(() => evaluate(() => !document.querySelector('.cmd-power-review')), 'undo restores the speed');
    await save();
    const estimates = Object.fromEntries(Object.entries(saved.paths[0].markers[0].invocation.power).map(([id, estimate]) => [saved.robots.find((robot) => robot.id === id)?.name, estimate.currentA]));
    assert.deepEqual(estimates, { 'Robot': 62 }, 'Duplicate stores nothing on the path; the copy shares');
    assert.equal(saved.paths[0].markers[0].invocation.arguments.rpm, 5000);
    // The copy plans with the shared 62 A and says where it comes from.
    await robotPage();
    await click('.robot-tab', 'Robot 2');
    await toPower();
    assert.match(await powerSummary(), /2 of 2 command uses have an estimate for Robot 2/);
    await click('.cmd-power-row');
    await wait(() => evaluate(() => document.querySelector('.cmd-power-shared')?.textContent === 'Shared from Robot until you change it here.'), 'shared estimate');
    assert.equal(await peakCurrent(), '62.0 A', 'The copy plans with the shared estimate');
    await shot('estimate-shared');
    await robotPage();
    await click('.robot-tab', 'Robot');
    await click('.places .place', 'Paths');
    await wait(() => evaluate(() => !!document.querySelector('.pt-limits .num-follow')), 'path limits');
    pass('A duplicate shares its original\'s estimates without changing any path, and a later path Undo restores the edit');

    // Max: the speed limit follows each robot's top speed and comes back exactly.
    await click('.pt-limits .num-follow');
    await wait(() => evaluate(() => document.querySelector('.pt-limits .num-follow')?.getAttribute('aria-pressed') === 'true'), 'following');
    const first1 = await evaluate(() => document.querySelector('.pt-limits .numinput').value);
    await robotPage();
    const gearId = await evaluate(() => document.querySelector('input[aria-label="Drive reduction"]') ? 'Drive reduction' : null);
    assert.ok(gearId);
    await click('.robot-tab', 'Robot 2');
    await wait(() => evaluate(() => document.querySelector('.rp-identity .rp-title')?.textContent === 'Robot 2'), 'second robot');
    await click('input[aria-label="Drive reduction"]');
    await key('Home'); await key('End', ['shift']); await win.webContents.insertText('9'); await key('Enter');
    await click('.places .place', 'Paths');
    await wait(async () => (await evaluate(() => document.querySelector('.pt-limits .numinput').value)) !== first1, 'follows the slower robot');
    const second = await evaluate(() => document.querySelector('.pt-limits .numinput').value);
    assert.ok(Number(second) < Number(first1), `The slower robot's max is lower: ${second} against ${first1}`);
    await shot('follow-max');
    await robotPage();
    await click('.robot-tab', 'Robot');
    await click('.places .place', 'Paths');
    await wait(async () => (await evaluate(() => document.querySelector('.pt-limits .numinput')?.value)) === first1, 'back to the first robot');
    pass(`Max makes the speed limit follow the selected robot: ${first1}, ${second}, then ${first1} again`);

    // Max wins over a draft typed before it: the field shows the robot's max, and leaving it keeps following.
    await click('.pt-limits .num-follow');
    await wait(() => evaluate(() => document.querySelector('.pt-limits .num-follow')?.getAttribute('aria-pressed') === 'false'), 'fixed');
    await click('.pt-limits .numinput');
    await key('Home'); await key('End', ['shift']); await win.webContents.insertText('2');
    await click('.pt-limits .num-follow');
    await wait(() => evaluate(() => document.querySelector('.pt-limits .num-follow')?.getAttribute('aria-pressed') === 'true'), 'following again');
    assert.equal(await evaluate(() => document.querySelector('.pt-limits .numinput').value), first1, 'Max replaces the unsent draft');
    await key('Tab');
    await wait(() => evaluate(() => document.activeElement !== document.querySelector('.pt-limits .numinput')), 'left the field');
    assert.equal(await evaluate(() => document.querySelector('.pt-limits .num-follow')?.getAttribute('aria-pressed')), 'true', 'Leaving the field keeps Max');
    assert.equal(await evaluate(() => document.querySelector('.pt-limits .numinput').value), first1);
    pass('Max clicked over a typed draft follows the robot, and leaving the field keeps it');

    assert.deepEqual(errors, [], 'No renderer errors, confirm dialogs or robot calls');
    app.exit(0);
  } catch (error) {
    console.error(error);
    try { await fs.writeFile(path.join(output, 'failure.png'), (await capture()).toPNG()); } catch (_) {}
    app.exit(1);
  }
});
