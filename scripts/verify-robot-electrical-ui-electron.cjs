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
async function click(selector, text) {
  const point = await evaluate((selector, text) => {
    const item = [...document.querySelectorAll(selector)].find((el) => !text || el.textContent.trim() === text);
    if (!item || item.disabled) throw Error('Missing control: ' + selector + ' ' + (text || ''));
    item.scrollIntoView({ block: 'center' });
    const r = item.getBoundingClientRect(), x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    if (!item.contains(document.elementFromPoint(x, y))) throw Error('Obscured control: ' + selector + ' ' + text);
    return { x, y };
  }, selector, text);
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
  await delay(100);
}
// Choosing returns focus to the dropdown a frame later; wait so the next click is not undone.
async function choose(id, value) {
  await click('#' + id);
  await click(`[role="option"][data-value="${value}"]`);
  await wait(() => evaluate((id) => document.activeElement?.id === id, id), id + ' focus');
}
async function key(keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await delay(70);
}
async function typeInto(label, text, finish = 'Enter') {
  await click(`input[aria-label="${label}"]`);
  await key('Home'); await key('End', ['shift']);
  await win.webContents.insertText(text);
  await key(finish);
}
// A field in the event's power estimate, found by its visible label.
async function typeField(label, text) {
  const id = await evaluate((label) => [...document.querySelectorAll('.cmd-power label')].find((el) => el.textContent === label)?.htmlFor, label);
  await click('#' + CSS_escape(id));
  await key('Home'); await key('End', ['shift']);
  await win.webContents.insertText(text);
  await key('Enter');
}
const CSS_escape = (id) => id.replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
const placeholder = (label) => evaluate((label) => document.querySelector(`input[aria-label="${label}"]`)?.placeholder ?? null, label);
// Row explanations are the label's hover tooltip.
const labelNote = (label) => evaluate((label) => document.querySelector(`input[aria-label="${label}"]`)?.closest('.settings-row')?.querySelector('.settings-hint')?.title ?? null, label);
const fieldText = (label) => evaluate((label) => document.querySelector(`input[aria-label="${label}"]`)?.value ?? null, label);
const resultText = (label) => evaluate((label) => [...document.querySelectorAll('.rp-drive-result')].find((el) => el.querySelector('span')?.textContent === label)?.querySelector('strong')?.textContent ?? null, label);
// Display units are in global settings (the toolbar gear): open it, choose, close.
async function chooseUnits(units) {
  await click('.app-settings-trigger'); await click('.app-settings .seg-i', units); await click('.app-settings-close');
}
async function capture() {
  for (let attempt = 0; attempt < 3; attempt++) {
    await delay(250);
    try { return await win.webContents.capturePage(); }
    catch (error) { if (attempt === 2 || !String(error).includes('UnknownVizError')) throw error; }
  }
}
async function snapshot(name, anchorText) {
  await evaluate((anchorText) => [...document.querySelectorAll('.settings-section h2, .rp-subh, .settings-label strong')].find((el) => el.textContent === anchorText)?.scrollIntoView({ block: 'start' }), anchorText);
  await delay(120);
  await fs.writeFile(path.join(output, name + '.png'), (await capture()).toPNG());
}
async function snapshotBothSizes(name) {
  for (const [width, height] of [[1440, 900], [1100, 720]]) {
    win.setContentSize(width, height); await delay(150);
    await snapshot(`${name}-${width}`, 'Electrical');
    const clipped = await evaluate(() => [...document.querySelectorAll('.settings-row, .rp-drive-result')].some((el) => el.scrollWidth > el.clientWidth + 1));
    assert.equal(clipped, false, `${name} at ${width}: a drive field or result is clipped horizontally`);
  }
  win.setContentSize(1440, 900); await delay(120);
}
ipcMain.handle('branches:restore', () => ({ project: saved }));
// One linked command; the path's event starts it, and its power estimate is entered on that event.
const shooter = { id: 'shoot', label: 'Shoot note', member: 'Shoot.vi', ownerType: 'LabVIEW', kind: 'factory', confidence: 'confirmed', source: { file: 'Shoot.vi', line: 1 }, parameters: [] };
ipcMain.handle('branches:catalog', () => ({ catalog: { runtime: 'labview', projectName: 'Fixture', sourceFileCount: 1, scannedAt: '', commands: [shooter], warnings: [] }, bookmarkId: 'fixture' }));
ipcMain.handle('branches:save', (_event, project) => { saved = project; saves++; return { saved: true }; });
async function save() { const before = saves; await click('.project-chip'); await click('[role="menuitem"][data-action="save"]'); await wait(() => saves > before, 'save'); }
app.whenReady().then(async () => {
  try {
    const corpus = JSON.parse(await fs.readFile('benchmarks/planner-corpus/v3/corpus.bordeaux.json', 'utf8'));
    const first = structuredClone(corpus.paths.find((p) => p.id === 'corpus-neutral-stop'));
    first.markers = [{ id: 'shoot-event', f: 0.3, name: 'Shoot', invocation: { commandId: 'shoot', arguments: {} } }];
    // A legacy timed load from an older project: listed read-only until removed.
    const driveModel = {
      motorId: 'rev-vortex', motorFreeRpm: 6784, motorMaxTorqueNm: 3.6, motorCount: 4, gearRatio: 5.5, wheelDiameterM: 0.0762,
      massKg: 54.4310844, moiKgM2: 4, wheelbaseM: 0.521, trackwidthM: 0.618, wheelFrictionCoefficient: 1.1,
      loadBursts: [{ startTimeS: 0.5, endTimeS: 2, currentA: 15 }],
    };
    saved = { ...corpus, robot: { ...corpus.robot, w: 0.84, l: 0.84, maxSpeed: 4.92, driveModel }, paths: [first], pathLinks: [], routines: [{ id: 'power-routine', name: 'Power routine with repeated driving and a cooling wait', nodes: [
      { id: 'power-path-1', type: 'path', ref: first.id }, { id: 'power-wait', type: 'builtin', builtinId: 'bordeaux.wait', arguments: { durationS: 1 } }, { id: 'power-path-2', type: 'path', ref: first.id },
    ] }], activeRoutineId: 'power-routine', editor: { activePathId: first.id, robotProjectBookmarkId: 'fixture' } };
    win = new BrowserWindow({ show: true, width: 1440, height: 900, useContentSize: true, webPreferences: { preload: path.join(__dirname, 'verify-command-branches-ui-preload.cjs'), sandbox: false, contextIsolation: true, backgroundThrottling: false } });
    win.webContents.on('console-message', (details) => { if (details.level === 'error' && !details.message.startsWith("Loading the font 'data:")) errors.push(details.message); });
    await win.loadFile(path.resolve('dist-renderer/index.html'));
    win.focus(); win.webContents.focus();
    await wait(() => evaluate(() => document.querySelectorAll('.pt-wp').length > 0), 'editable path');
    await click('.places .place', 'Robot');
    await wait(() => evaluate(() => !!document.querySelector('input[aria-label="Drive current limit"]')), 'electrical fields');
    // A preset robot plans electrically with visible defaults; nothing has to be turned on.
    assert.equal(await evaluate(() => [...document.querySelectorAll('button')].some((el) => /Model current limit|Use stall torque/.test(el.textContent))), false);
    assert.equal(await fieldText('Drive current limit'), '');
    assert.equal(await placeholder('Drive current limit'), '80');
    assert.equal(await placeholder('Battery resistance'), '20');
    assert.equal(await placeholder('Control reserve'), '10');
    assert.equal(await labelNote('Drive current limit'), 'Using the default. Stator current limit for each drive motor.');
    assert.equal(await fieldText('Motor stall current'), '211');
    assert.equal(await evaluate(() => document.querySelector('input[aria-label="Motor stall current"]').disabled), true, 'preset stall current is read-only');
    const defaultTopSpeed = await resultText('Top speed');
    assert.ok(parseFloat(defaultTopSpeed) < 4.9, 'top speed follows the electrical line, not the 12 V free speed: ' + defaultTopSpeed);
    assert.equal(await evaluate(() => [...document.querySelectorAll('button')].some((el) => el.textContent.trim() === 'Use default electrical values')), false);
    await snapshotBothSizes('defaults');
    assert.equal(await fieldText('CG height'), '');
    assert.equal(await placeholder('CG height'), '0.25');
    assert.match(await labelNote('CG height'), /Using the default/);
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(150);
      await click('input[aria-label="CG height"]'); await key('Tab');
      await fs.writeFile(path.join(output, `cg-default-${width}.png`), (await capture()).toPNG());
    }
    await typeInto('CG height', '0.9', 'Escape');
    await save();
    assert.equal('cgHeightM' in saved.robot.driveModel, false);
    await typeInto('CG height', '0.31');
    await save();
    assert.equal(saved.robot.driveModel.cgHeightM, 0.31);
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(150);
      await click('input[aria-label="CG height"]'); await key('Tab');
      await fs.writeFile(path.join(output, `cg-metric-${width}.png`), (await capture()).toPNG());
    }
    await chooseUnits('Imperial');
    await typeInto('CG height', '12');
    await save();
    assert.ok(Math.abs(saved.robot.driveModel.cgHeightM - 0.3048) < 1e-12);
    assert.equal(saved.editor?.unitSystem, undefined, 'display units stay out of the project');
    // Reopen as an older file from a teammate whose project stored metric: this machine's imperial choice still wins.
    saved = { ...saved, editor: { ...saved.editor, unitSystem: 'metric' } };
    await win.reload();
    await wait(() => evaluate(() => document.querySelectorAll('.places .place').length > 0), 'restored places');
    await click('.places .place', 'Robot');
    await wait(() => evaluate(() => !!document.querySelector('input[aria-label="CG height"]')), 'restored CG height');
    await wait(async () => Math.abs(Number(await fieldText('CG height')) - 12) < 0.001, 'restored imperial CG value');
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(150);
      await click('input[aria-label="CG height"]'); await key('Tab');
      await fs.writeFile(path.join(output, `cg-imperial-${width}.png`), (await capture()).toPNG());
    }
    await chooseUnits('Metric');
    await typeInto('CG height', '0');
    await save();
    assert.equal(saved.robot.driveModel.cgHeightM, 0);
    await click('input[aria-label="CG height"]'); await key('Tab');
    assert.equal(await evaluate(() => document.activeElement?.textContent.trim()), 'Use default CG height');
    await key('Space');
    await save();
    assert.equal('cgHeightM' in saved.robot.driveModel, false);
    assert.equal(await placeholder('CG height'), '0.25');
    await click('input[aria-label="CG height"]'); await key('Tab');
    await fs.writeFile(path.join(output, 'cg-reset-1100.png'), (await capture()).toPNG());
    win.setContentSize(1440, 900);
    console.log('PASS CG height default, Escape, metric/imperial edits, app-level units over a project that stored metric, restore, zero, and reset');
    console.log('PASS A preset robot shows its electrical model with marked defaults and electrical limits');

    await typeInto('Drive current limit', '55');
    await typeInto('Battery resistance', '25');
    await typeInto('Control reserve', '15');
    await typeInto('Other mechanisms', '99', 'Escape');
    await save();
    assert.equal(saved.robot.driveModel.driveCurrentLimitA, 55);
    assert.equal(saved.robot.driveModel.batteryResistanceOhm, 0.025);
    assert.equal(saved.robot.driveModel.controlReserve, 0.15);
    assert.equal('otherLoadA' in saved.robot.driveModel, false, 'Escape keeps the default unset');
    assert.equal('motorStallCurrentA' in saved.robot.driveModel, false, 'the preset supplies stall current');
    assert.equal(await fieldText('Battery resistance'), '25.0');
    assert.equal(await labelNote('Drive current limit'), 'Stator current limit for each drive motor.');
    assert.equal(await labelNote('Other mechanisms'), 'Using the default. Constant current from everything without a power estimate on its command, such as controllers and sensors.');
    assert.ok(saved.robot.maxSpeed < 4.9);
    await snapshotBothSizes('edited-metric');
    console.log('PASS Keyboard edits store exact canonical values (A, mΩ to Ω, % to fraction); Escape keeps the default');

    await chooseUnits('Imperial');
    await wait(async () => (await resultText('Top speed'))?.endsWith('ft/s'), 'imperial results');
    assert.equal(await fieldText('Drive current limit'), '55');
    await snapshotBothSizes('edited-imperial');
    await chooseUnits('Metric');
    console.log('PASS Imperial converts speed and acceleration while electrical units stay A, V, mΩ and %');

    await click('button', 'Use default electrical values');
    await save();
    for (const k of ['driveCurrentLimitA', 'batteryResistanceOhm', 'controlReserve']) assert.equal(k in saved.robot.driveModel, false, k);
    assert.equal(await placeholder('Drive current limit'), '80');
    assert.equal(await resultText('Top speed'), defaultTopSpeed);
    console.log('PASS Use default electrical values clears authored values back to the defaults');

    await click('#robot-drive-motor');
    await click('[role="option"][data-value="custom"]');
    await save();
    assert.equal(saved.robot.driveModel.motorId, 'custom');
    assert.equal(saved.robot.driveModel.motorStallCurrentA, 211, 'custom keeps the last preset stall current as an editable value');
    assert.equal(saved.robot.driveModel.motorFreeCurrentA, 3.6);
    assert.equal(await evaluate(() => document.querySelector('input[aria-label="Motor stall current"]').disabled), false);
    assert.equal(await placeholder('Drive current limit'), '211');
    await snapshot('custom-motor-1440', 'Electrical');
    console.log('PASS Choosing a custom motor keeps editable stall and free current');

    // Electrical configuration uses the existing numeric drafts and commits exact canonical values.
    await typeInto('Minimum bus voltage', '8');
    // The legacy load is listed, not editable; power estimates go on the command uses.
    assert.equal(await evaluate(() => [...document.querySelectorAll('.power-legacy .settings-label strong')].map((el) => el.textContent).join('|')), '0.5 s – 2 s');
    assert.equal(await evaluate(() => document.querySelectorAll('.power-legacy input').length), 0);
    assert.match(await evaluate(() => document.querySelector('#settings-power .settings-row').textContent), /0 of 1 command uses have an estimate/);
    // Next missing opens the event in its path; its power estimate is added there.
    await click('#settings-power button', 'Next missing');
    await wait(() => evaluate(() => !!document.querySelector('.cmd-power-add')), 'event power estimate');
    await click('.cmd-power-add');
    await typeField('Current', '40');
    await typeField('Runs for', '1.5');
    const estimate = () => Object.values(saved.paths[0].markers[0].invocation.power || {})[0];
    await save();
    assert.deepEqual([estimate().currentA, estimate().runTimeS], [40, 1.5]);
    assert.equal('commandLoads' in saved.robot.driveModel, false, 'Nothing is stored per command');
    // Emptying the run time returns it to "until stopped".
    await typeField('Runs for', '');
    await save();
    assert.deepEqual([estimate().currentA, 'runTimeS' in estimate()], [40, false]);
    assert.equal(await evaluate(() => [...document.querySelectorAll('.cmd-power input')].at(-1).placeholder), 'Until stopped');
    await typeField('Runs for', '1.5');
    await click('.places .place', 'Robot');
    await wait(() => evaluate(() => !!document.querySelector('input[aria-label="Minimum bus voltage"]')), 'robot page again');
    await choose('robot-driveBreaker', 'preset');
    await choose('robot-mainBreaker', 'custom');
    await typeInto('Main breaker rating', '120');
    await typeInto('Main breaker cold trip at 2×', '10');
    await typeInto('Main breaker initial heat', '25');
    await save();
    assert.equal(saved.robot.driveModel.minimumBusVoltageV, 8);
    assert.deepEqual(saved.robot.driveModel.loadBursts, [{ startTimeS: 0.5, endTimeS: 2, currentA: 15 }]);
    assert.deepEqual([estimate().currentA, estimate().runTimeS], [40, 1.5]);
    assert.deepEqual(saved.robot.driveModel.driveBreaker, { ratedCurrentA: 40, tripTimeAt2xS: 5, initialHeat: 0 });
    assert.deepEqual(saved.robot.driveModel.mainBreaker, { ratedCurrentA: 120, tripTimeAt2xS: 10, initialHeat: 0.25 });
    await win.reload();
    await wait(() => evaluate(() => document.querySelectorAll('.places .place').length > 0), 'power restored places');
    await click('.places .place', 'Robot');
    await wait(() => evaluate(() => !!document.querySelector('input[aria-label="Minimum bus voltage"]')), 'power settings restored');
    await wait(async () => await fieldText('Minimum bus voltage') === '8.00', 'restored voltage floor');
    assert.equal(await fieldText('Minimum bus voltage'), '8.00');
    await wait(() => evaluate(() => document.querySelector('.cmd-power-row')?.textContent.includes('40 A')), 'restored power estimate');
    assert.match(await evaluate(() => document.querySelector('.cmd-power-row').textContent), /Shoot note.*40 A.*1\.5 s/);
    assert.match(await evaluate(() => document.querySelector('#settings-power .settings-row').textContent), /1 of 1 command uses have an estimate/);
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(150);
      await snapshot(`power-loads-${width}`, 'Loads and breakers');
      await snapshot(`power-breakers-${width}`, 'Drive breaker');
      await typeInto('Main breaker cold trip at 2×', '99', 'Escape');
      assert.equal(await fieldText('Main breaker cold trip at 2×'), '10.00');
    }
    await click('.power-legacy button[aria-label="Remove timed load 1"]');
    await wait(() => evaluate(() => !document.querySelector('.power-legacy')), 'legacy load removed');
    assert.equal(await evaluate(() => !!document.activeElement?.closest('#settings-power')), true, 'removing the last legacy load keeps focus in Loads and breakers');
    await save();
    assert.equal('loadBursts' in saved.robot.driveModel, false);
    win.setContentSize(1440, 900); await delay(150);
    await snapshot('power-command-loads-1440', 'Loads and breakers');
    console.log('PASS Power estimates on a command use, voltage floor and breaker curves survive save/reload; run time clears; legacy loads list and remove; Escape cancels drafts');
    await click('.places .place', 'Paths');
    await wait(() => evaluate(() => !!document.querySelector('.pp-head-actions button') && [...document.querySelectorAll('.pp-head-actions button')].some(b => b.textContent === 'Power' && !b.disabled)), 'current power report');
    // The report is a bounded, nonmodal popover anchored to its button; focus stays on Power.
    const reportLayout = (scope) => evaluate((scope) => {
      const panel = document.querySelector('.power-report'), button = [...document.querySelectorAll(scope + ' button')].find(b => b.textContent === 'Power');
      const r = panel.getBoundingClientRect(), b = button.getBoundingClientRect();
      return { open: panel.matches(':popover-open'), modal: !!document.querySelector('dialog:modal'), expanded: button.getAttribute('aria-expanded'),
        focus: document.activeElement?.textContent, alert: !!panel.querySelector('[role="alert"]'), width: r.width, height: r.height,
        inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, gap: Math.min(Math.abs(r.top - b.bottom), Math.abs(b.top - r.bottom)),
        rightAligned: Math.abs(r.right - b.right) < 1 || Math.abs(r.right - (innerWidth - 8)) < 1, rows: panel.querySelectorAll('.power-results dt').length };
    }, scope);
    async function checkReport(scope, label, width, peak = '40.0 A') {
      await wait(() => evaluate(() => !!document.querySelector('.power-report .power-results')), label + ' power results');
      const layout = await reportLayout(scope);
      assert.equal(layout.open, true); assert.equal(layout.modal, false); assert.equal(layout.expanded, 'true');
      assert.equal(layout.alert, false, label + ' report failed');
      assert.equal(layout.focus, 'Power', label + ' report took focus');
      assert.equal(layout.rows, 6);
      assert.equal(await evaluate(() => [...document.querySelectorAll('.power-report .power-results > div')].find((row) => row.querySelector('dt').textContent === 'Peak mechanism current')?.querySelector('.power-value').textContent), peak);
      assert.ok(layout.width <= 320 && layout.height <= 440, `${label} report is unbounded at ${width}: ${layout.width}×${layout.height}`);
      assert.ok(layout.inside && layout.gap < 12 && layout.rightAligned, `${label} report is not anchored to Power at ${width}: ${JSON.stringify(layout)}`);
    }
    const closed = () => evaluate(() => !document.querySelector('.power-report')?.matches(':popover-open'));
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(150);
      await click('.pp-head-actions button', 'Power');
      await checkReport('.pp-head-actions', 'path', width);
      await fs.writeFile(path.join(output, `power-path-${width}.png`), (await capture()).toPNG());
      await key('Escape');
      await wait(closed, 'Escape closes path report');
      assert.equal(await evaluate(() => document.activeElement?.textContent), 'Power');
      await key('Enter');
      await checkReport('.pp-head-actions', 'keyboard path', width);
      // Tabbing on closes it rather than leaving it over the next control.
      await key('Tab');
      await wait(closed, 'Tab closes path report');
      assert.notEqual(await evaluate(() => document.activeElement?.textContent), 'Power');
    }
    await click('.places .place', 'Routines');
    await wait(() => evaluate(() => [...document.querySelectorAll('.routine-workspace-actions button')].some(b => b.textContent === 'Power' && !b.disabled)), 'routine planned');
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(150);
      await click('.routine-workspace-actions button', 'Power');
      await checkReport('.routine-workspace-actions', 'routine', width);
      await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await delay(600);
      await fs.writeFile(path.join(output, `power-routine-${width}.png`), (await capture()).toPNG());
      // A second press of the same button closes it.
      await click('.routine-workspace-actions button', 'Power');
      await wait(closed, 'Power toggles routine report closed');
    }
    console.log('PASS Nonmodal anchored power report: pointer, Enter, Escape, Tab and toggle close; path/routine results at both supported sizes');

    // A routine command step: its estimated Runs for is its duration in the routine report only.
    saved = { ...saved, routines: saved.routines.map((routine) => ({ ...routine, nodes: [...routine.nodes,
      { id: 'power-spin', type: 'function', cat: 'command', title: 'Spin up', invocation: { commandId: 'shoot', arguments: {} } }] })) };
    win.setContentSize(1440, 900); await win.reload();
    await wait(() => evaluate(() => document.querySelectorAll('.places .place').length > 0), 'routine step restored');
    await click('.places .place', 'Routines');
    await wait(() => evaluate(() => !!document.querySelector('.rt-step[data-id="power-spin"]')), 'routine command step');
    await click('.rt-step[data-id="power-spin"] .rt-step-body');
    await wait(() => evaluate(() => !!document.querySelector('.cmd-power-add')), 'step power estimate');
    await click('.cmd-power-add');
    await typeField('Current', '90');
    await save();
    const stepEstimate = () => Object.values(saved.routines[0].nodes.find((node) => node.id === 'power-spin').invocation.power || {})[0];
    assert.deepEqual([stepEstimate().currentA, 'runTimeS' in stepEstimate()], [90, false]);
    const scrub = () => evaluate(() => Number(document.querySelector('.rt-tp-scrub')?.getAttribute('aria-valuemax')));
    const previewTotal = await scrub();
    const alertText = () => evaluate(() => document.querySelector('.power-report [role="alert"]')?.textContent ?? null);
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(150);
      await click('.routine-workspace-actions button', 'Power');
      await wait(async () => !!(await alertText()), 'named untimed step');
      assert.equal(await alertText(), "A whole-routine estimate needs every step's duration. Add a Runs for to Spin up (step 4), or analyze the routine’s paths individually.");
      const layout = await reportLayout('.routine-workspace-actions');
      assert.ok(layout.inside && layout.gap < 12 && layout.rightAligned && layout.width <= 320, `untimed routine report at ${width}: ${JSON.stringify(layout)}`);
      assert.equal(layout.focus, 'Power');
      await delay(300);
      await fs.writeFile(path.join(output, `power-routine-untimed-${width}.png`), (await capture()).toPNG());
      await key('Escape');
      await wait(closed, 'Escape closes untimed routine report');
    }
    win.setContentSize(1440, 900); await delay(150);
    // The step stays selected while the report opens and closes; selecting it again would close its inspector.
    const stepInspector = () => evaluate(() => !!document.querySelector('.cmd-power'));
    if (!await stepInspector()) await click('.rt-step[data-id="power-spin"] .rt-step-body');
    await wait(() => evaluate(() => [...document.querySelectorAll('.cmd-power label')].some((el) => el.textContent === 'Runs for')), 'step Runs for');
    await typeField('Runs for', '0.5');
    await save();
    assert.deepEqual([stepEstimate().currentA, stepEstimate().runTimeS], [90, 0.5]);
    // The preview's own timing does not take the estimate.
    assert.equal(await scrub(), previewTotal, 'preview total unchanged by the step estimate');
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(150);
      await click('.routine-workspace-actions button', 'Power');
      await checkReport('.routine-workspace-actions', 'routine with step estimate', width, '90.0 A');
      assert.equal(await evaluate(() => !!document.querySelector('.power-report .power-unloaded')), false, 'every command use has a load');
      await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await delay(600);
      await fs.writeFile(path.join(output, `power-routine-step-${width}.png`), (await capture()).toPNG());
      await click('.routine-workspace-actions button', 'Power');
      await wait(closed, 'Power toggles step routine report closed');
    }
    console.log('PASS Routine report counts a command step\'s Runs for as its duration and names a step that still needs one; preview timing unchanged');


    assert.deepEqual(errors, []);
    app.exit(0);
  } catch (error) {
    console.error(error);
    try { await fs.writeFile(path.join(output, 'failure.png'), (await capture()).toPNG()); } catch (_) {}
    app.exit(1);
  }
});
