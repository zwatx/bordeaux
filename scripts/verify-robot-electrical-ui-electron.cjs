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
const placeholder = (label) => evaluate((label) => document.querySelector(`input[aria-label="${label}"]`)?.placeholder ?? null, label);
const labelNote = (label) => evaluate((label) => document.querySelector(`input[aria-label="${label}"]`)?.closest('.rp-field')?.querySelector('.rp-flabel small')?.textContent ?? null, label);
const fieldText = (label) => evaluate((label) => document.querySelector(`input[aria-label="${label}"]`)?.value ?? null, label);
const resultText = (label) => evaluate((label) => [...document.querySelectorAll('.rp-drive-result')].find((el) => el.querySelector('span')?.textContent === label)?.querySelector('strong')?.textContent ?? null, label);
async function capture() {
  for (let attempt = 0; attempt < 3; attempt++) {
    await delay(250);
    try { return await win.webContents.capturePage(); }
    catch (error) { if (attempt === 2 || !String(error).includes('UnknownVizError')) throw error; }
  }
}
async function snapshot(name, anchorText) {
  await evaluate((anchorText) => [...document.querySelectorAll('.rp-subh')].find((el) => el.textContent === anchorText)?.scrollIntoView({ block: 'start' }), anchorText);
  await delay(120);
  await fs.writeFile(path.join(output, name + '.png'), (await capture()).toPNG());
}
async function snapshotBothSizes(name) {
  for (const [width, height] of [[1440, 900], [1100, 720]]) {
    win.setContentSize(width, height); await delay(150);
    await snapshot(`${name}-${width}`, 'Electrical model');
    const clipped = await evaluate(() => [...document.querySelectorAll('.rp-drive-model .rp-field, .rp-drive-result')].some((el) => el.scrollWidth > el.clientWidth + 1));
    assert.equal(clipped, false, `${name} at ${width}: a drive field or result is clipped horizontally`);
  }
  win.setContentSize(1440, 900); await delay(120);
}
ipcMain.handle('branches:restore', () => ({ project: saved }));
ipcMain.handle('branches:catalog', () => ({ catalog: { projectName: 'Fixture', commands: [], warnings: [] }, bookmarkId: 'fixture' }));
ipcMain.handle('branches:save', (_event, project) => { saved = project; saves++; return { saved: true }; });
async function save() { const before = saves; await click('.project-chip'); await click('[role="menuitem"][data-action="save"]'); await wait(() => saves > before, 'save'); }
app.whenReady().then(async () => {
  try {
    const corpus = JSON.parse(await fs.readFile('benchmarks/planner-corpus/v2/corpus.bordeaux.json', 'utf8'));
    const first = structuredClone(corpus.paths.find((p) => p.id === 'corpus-neutral-stop'));
    const driveModel = {
      motorId: 'rev-vortex', motorFreeRpm: 6784, motorMaxTorqueNm: 3.6, motorCount: 4, gearRatio: 5.5, wheelDiameterM: 0.0762,
      massKg: 54.4310844, moiKgM2: 4, wheelbaseM: 0.521, trackwidthM: 0.618, wheelFrictionCoefficient: 1.1,
    };
    saved = { ...corpus, robot: { ...corpus.robot, w: 0.84, l: 0.84, maxSpeed: 4.92, driveModel }, paths: [first], pathLinks: [], routines: [{ id: 'power-routine', name: 'Power routine with repeated driving and a cooling wait', nodes: [
      { id: 'power-path-1', type: 'path', ref: first.id }, { id: 'power-wait', type: 'builtin', builtinId: 'bordeaux.wait', arguments: { durationS: 1 } }, { id: 'power-path-2', type: 'path', ref: first.id },
    ] }], activeRoutineId: 'power-routine', editor: { activePathId: first.id, unitSystem: 'metric' } };
    win = new BrowserWindow({ show: true, width: 1440, height: 900, useContentSize: true, webPreferences: { preload: path.join(__dirname, 'verify-command-branches-ui-preload.cjs'), sandbox: false, contextIsolation: true, backgroundThrottling: false } });
    win.webContents.on('console-message', (details) => { if (details.level === 'error' && !details.message.startsWith("Loading the font 'data:")) errors.push(details.message); });
    await win.loadFile(path.resolve('dist-renderer/index.html'));
    win.focus(); win.webContents.focus();
    await wait(() => evaluate(() => document.querySelectorAll('.pt-wp').length > 0), 'editable path');
    await click('.places .place', 'Settings');
    await wait(() => evaluate(() => !!document.querySelector('input[aria-label="Drive current limit"]')), 'electrical fields');
    // A preset robot plans electrically with visible defaults; nothing has to be turned on.
    assert.equal(await evaluate(() => [...document.querySelectorAll('button')].some((el) => /Model current limit|Use stall torque/.test(el.textContent))), false);
    assert.equal(await fieldText('Drive current limit'), '');
    assert.equal(await placeholder('Drive current limit'), '80');
    assert.equal(await placeholder('Battery resistance'), '20');
    assert.equal(await placeholder('Control reserve'), '10');
    assert.equal(await labelNote('Drive current limit'), 'Default · stator, per motor');
    assert.equal(await fieldText('Motor stall current'), '211');
    assert.equal(await evaluate(() => document.querySelector('input[aria-label="Motor stall current"]').disabled), true, 'preset stall current is read-only');
    const defaultTopSpeed = await resultText('Top speed');
    assert.ok(parseFloat(defaultTopSpeed) < 4.9, 'top speed follows the electrical line, not the 12 V free speed: ' + defaultTopSpeed);
    assert.equal(await evaluate(() => [...document.querySelectorAll('button')].some((el) => el.textContent.trim() === 'Use default electrical values')), false);
    await snapshotBothSizes('defaults');
    assert.equal(await fieldText('CG height'), '');
    assert.equal(await placeholder('CG height'), '0.25');
    assert.match(await labelNote('CG height'), /Default/);
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
    await click('button', 'Imperial');
    await typeInto('CG height', '12');
    await save();
    assert.ok(Math.abs(saved.robot.driveModel.cgHeightM - 0.3048) < 1e-12);
    await win.reload();
    await wait(() => evaluate(() => document.querySelectorAll('.places .place').length > 0), 'restored places');
    await click('.places .place', 'Settings');
    await wait(() => evaluate(() => !!document.querySelector('input[aria-label="CG height"]')), 'restored CG height');
    await wait(async () => Math.abs(Number(await fieldText('CG height')) - 12) < 0.001, 'restored imperial CG value');
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(150);
      await click('input[aria-label="CG height"]'); await key('Tab');
      await fs.writeFile(path.join(output, `cg-imperial-${width}.png`), (await capture()).toPNG());
    }
    await click('button', 'Metric');
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
    console.log('PASS CG height default, Escape, metric/imperial edits, restore, zero, and reset');
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
    assert.equal(await labelNote('Drive current limit'), 'stator, per motor');
    assert.equal(await labelNote('Other mechanisms'), 'Default · current while driving');
    assert.ok(saved.robot.maxSpeed < 4.9);
    await snapshotBothSizes('edited-metric');
    console.log('PASS Keyboard edits store exact canonical values (A, mΩ to Ω, % to fraction); Escape keeps the default');

    await click('button', 'Imperial');
    await wait(async () => (await resultText('Top speed'))?.endsWith('ft/s'), 'imperial results');
    assert.equal(await fieldText('Drive current limit'), '55');
    await snapshotBothSizes('edited-imperial');
    await click('button', 'Metric');
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
    await snapshot('custom-motor-1440', 'Electrical model');
    console.log('PASS Choosing a custom motor keeps editable stall and free current');

    // Electrical configuration uses the existing numeric drafts and commits exact canonical values.
    await typeInto('Minimum bus voltage', '8');
    await click('button', 'Add load burst');
    await typeInto('Load burst 1 start', '0.5');
    await typeInto('Load burst 1 end', '2');
    await typeInto('Load burst 1 additional current', '15');
    await click('button', 'Use REV 40 A ATO drive breakers');
    await click('button', 'Use Bussmann 185120F main breaker');
    await click('button', 'Edit main breaker');
    await typeInto('Main breaker initial heat', '25');
    await click('button', 'Use main breaker curve');
    await save();
    assert.equal(saved.robot.driveModel.minimumBusVoltageV, 8);
    assert.deepEqual(saved.robot.driveModel.loadBursts, [{ startTimeS: 0.5, endTimeS: 2, currentA: 15 }]);
    assert.deepEqual(saved.robot.driveModel.driveBreaker, { ratedCurrentA: 40, tripTimeAt2xS: 5, initialHeat: 0 });
    assert.deepEqual(saved.robot.driveModel.mainBreaker, { ratedCurrentA: 120, tripTimeAt2xS: 10, initialHeat: 0.25 });
    await win.reload();
    await wait(() => evaluate(() => document.querySelectorAll('.places .place').length > 0), 'power restored places');
    await click('.places .place', 'Settings');
    await wait(() => evaluate(() => !!document.querySelector('input[aria-label="Minimum bus voltage"]')), 'power settings restored');
    await wait(async () => await fieldText('Minimum bus voltage') === '8.00', 'restored voltage floor');
    assert.equal(await fieldText('Minimum bus voltage'), '8.00');
    assert.equal(await fieldText('Load burst 1 additional current'), '15.00');
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(150);
      await snapshot(`power-loads-${width}`, 'Mechanism load bursts');
      await snapshot(`power-breakers-${width}`, 'Breaker estimates');
      await click('button', 'Edit main breaker');
      await typeInto('Main breaker cold trip at 2×', '99', 'Escape');
      await click('button', 'Cancel');
    }
    console.log('PASS Voltage floor, load schedule and breaker curves survive save/reload; Escape cancels drafts');
    await click('.places .place', 'Paths');
    await wait(() => evaluate(() => !!document.querySelector('.pp-head-actions button') && [...document.querySelectorAll('.pp-head-actions button')].some(b => b.textContent === 'Power' && !b.disabled)), 'current power report');
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(150);
      await click('.pp-head-actions button', 'Power');
      await wait(() => evaluate(() => !!document.querySelector('.power-results')), 'path power results');
      assert.equal(await evaluate(() => !!document.querySelector('.power-dialog [role="alert"]')), false);
      await fs.writeFile(path.join(output, `power-path-${width}.png`), (await capture()).toPNG());
      await key('Escape');
      assert.equal(await evaluate(() => document.activeElement?.textContent), 'Power');
      await key('Enter');
      await wait(() => evaluate(() => !!document.querySelector('.power-results')), 'keyboard reopened power');
      await key('Escape');
    }
    await click('.places .place', 'Routines');
    await wait(() => evaluate(() => [...document.querySelectorAll('.routine-workspace-actions button')].some(b => b.textContent === 'Power' && !b.disabled)), 'routine planned');
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(150);
      await click('.routine-workspace-actions button', 'Power');
      await wait(() => evaluate(() => !!document.querySelector('.power-results')), 'routine power results');
      await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await delay(600);
      await fs.writeFile(path.join(output, `power-routine-${width}.png`), (await capture()).toPNG());
      await key('Escape');
    }
    console.log('PASS Real pointer and Enter/Escape report controls; path/routine results at both supported sizes');

    assert.deepEqual(errors, []);
    app.exit(0);
  } catch (error) {
    console.error(error);
    try { await fs.writeFile(path.join(output, 'failure.png'), (await capture()).toPNG()); } catch (_) {}
    app.exit(1);
  }
});
