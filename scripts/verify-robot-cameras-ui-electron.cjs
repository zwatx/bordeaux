// The Robot page's Cameras section in the built renderer: add a camera with its starting numbers, edit and clamp them,
// see the 3D drawing follow each edit, turn the view by drag, keys and named views, zoom it by buttons, keys and
// Ctrl+wheel while a plain wheel still scrolls the page, rename with a refused repeat,
// keep cameras per robot, save and reopen, delete down to none, and check the open path's time never changes.
// Screenshots at both supported sizes go to BORDEAUX_ROBOT_CAMERAS_UI_OUTPUT.
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
  await delay(120);
}
async function key(keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await delay(90);
}
async function typeInto(label, text) {
  await click(`input[aria-label="${label}"]`);
  await key('Home'); await key('End', ['shift']);
  await win.webContents.insertText(text);
  await key('Enter');
}
const field = (label) => evaluate((label) => document.querySelector(`input[aria-label="${label}"]`)?.value ?? null, label);
const numbers = async () => Promise.all(['horizontal field of view', 'vertical field of view', 'forward of center', 'left of center', 'height above floor', 'yaw', 'pitch', 'max range'].map((name) => field('Camera ' + name)));
// What the section shows: the picker, the picked camera's heading, and the 3D drawing's shapes.
const section = () => evaluate(() => {
  const root = document.getElementById('settings-cameras');
  return {
    empty: root.querySelector('.settings-label strong')?.textContent ?? null,
    picks: [...root.querySelectorAll('.rp-cam-pick:not(.new)')].map((pick) => pick.textContent + (pick.getAttribute('aria-pressed') === 'true' ? '*' : '')),
    canAdd: !!root.querySelector('.rp-cam-pick.new'),
    heading: root.querySelector('.rp-cam-head strong')?.textContent ?? null,
    view: root.querySelector('.rp-cam-views .seg-i[aria-pressed="true"]')?.textContent ?? null,
    volumes: root.querySelectorAll('.rp-cam-viewEnd').length,
    picked: [...root.querySelectorAll('.rp-cam-view.on, .rp-cam-viewEnd.on')].map((shape) => shape.getAttribute('points')).join('|'),
    body: [...root.querySelectorAll('.rp-cam-body, .rp-cam-bodyTop')].map((shape) => shape.getAttribute('points')).join('|'),
    names: [...root.querySelectorAll('.rp-cam-name')].map((name) => name.textContent + (name.classList.contains('on') ? '*' : '')),
    bad: [...root.querySelectorAll('svg [points]')].some((shape) => /NaN|Infinity/.test(shape.getAttribute('points'))),
  };
});
async function save() { const before = saves; await click('.project-chip'); await click('[role="menuitem"][data-action="save"]'); await wait(() => saves > before, 'save'); }
async function robotPage() { await click('.places .place', 'Robot'); await wait(() => evaluate(() => !!document.getElementById('settings-cameras')), 'cameras section'); }
// The planned duration of the open path, read where the editor shows it.
async function pathSeconds() {
  await click('.places .place', 'Paths');
  await wait(() => evaluate(() => !document.querySelector('.fieldcol[data-planning-ready="false"]') && Number(document.querySelector('.pt-clock-total')?.textContent) > 0), 'planned path');
  await delay(200);
  return evaluate(() => document.querySelector('.pt-clock-total').textContent);
}
// A real left-button drag across the 3D view, from its center.
async function dragView(dx, dy) {
  const start = await evaluate(() => {
    const svg = document.querySelector('.rp-cam-stage svg');
    svg.scrollIntoView({ block: 'center' });
    const r = svg.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height * 0.75) };
  });
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...start });
  for (let step = 1; step <= 4; step++) { win.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', x: start.x + dx * step / 4, y: start.y + dy * step / 4 }); await delay(30); }
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: start.x + dx, y: start.y + dy });
  await delay(120);
}
async function capture() {
  for (let attempt = 0; attempt < 3; attempt++) {
    await delay(250);
    try { return await win.webContents.capturePage(); }
    catch (error) { if (attempt === 2 || !String(error).includes('UnknownVizError')) throw error; }
  }
}
async function snapshot(name) {
  for (const [width, height] of [[1440, 900], [1100, 720]]) {
    win.setContentSize(width, height); await delay(200);
    await evaluate(() => document.getElementById('settings-cameras')?.scrollIntoView({ block: 'start' }));
    const clipped = await evaluate(() => [...document.querySelectorAll('#settings-cameras :is(.rp-big, .rp-cam-pick:not(.new), .settings-card)')].some((item) => item.scrollWidth > item.clientWidth + 1)
      || [...document.querySelectorAll('.rp-cam-picks > *, .rp-cam-views')].some((item) => { const r = item.getBoundingClientRect(), s = document.querySelector('.rp-cam-stage').getBoundingClientRect(); return r.left < s.left || r.right > s.right; }));
    assert.equal(clipped, false, `${name} at ${width}: a camera control is clipped`);
    await fs.writeFile(path.join(output, `${name}-${width}.png`), (await capture()).toPNG());
  }
  win.setContentSize(1440, 900); await delay(150);
}
const pass = (name) => console.log('PASS ' + name);
ipcMain.handle('branches:restore', () => ({ project: saved }));
ipcMain.handle('branches:catalog', () => ({ catalog: { projectName: 'Fixture', commands: [], warnings: [] }, bookmarkId: 'fixture' }));
ipcMain.handle('branches:save', (_event, project) => { saved = project; saves++; return { saved: true }; });
ipcMain.handle('branches:use-endpoint', (_event, endpoint) => (endpoint ? { endpoint } : null));
ipcMain.handle('branches:connection', () => null);
ipcMain.on('branches:published', () => {});
ipcMain.on('branches:confirm', (_event, message) => errors.push('confirm: ' + message));
ipcMain.handle('branches:robot-call', (_event, name) => { errors.push('robot call: ' + name); throw new Error('No robot in this check'); });

app.whenReady().then(async () => {
  try {
    const corpus = JSON.parse(await fs.readFile('benchmarks/planner-corpus/v3/corpus.bordeaux.json', 'utf8'));
    const first = structuredClone(corpus.paths.find((p) => p.id === 'corpus-neutral-stop'));
    // Synthetic drivetrain values for this check, not a real robot.
    const driveModel = { motorId: 'custom', motorFreeRpm: 6000, motorMaxTorqueNm: 4, motorCount: 4, gearRatio: 5.5, wheelDiameterM: 0.1016,
      massKg: 50, moiKgM2: 5, wheelbaseM: 0.6, trackwidthM: 0.6, wheelFrictionCoefficient: 1.2 };
    saved = { ...corpus, robot: { ...corpus.robot, w: 0.84, l: 0.84, driveModel }, paths: [first], pathLinks: [], routines: [], editor: { activePathId: first.id } };
    win = new BrowserWindow({ show: true, width: 1440, height: 900, useContentSize: true, webPreferences: { preload: path.join(__dirname, 'verify-command-branches-ui-preload.cjs'), sandbox: false, contextIsolation: true, backgroundThrottling: false } });
    win.webContents.on('console-message', (details) => { if (details.level === 'error' && !details.message.startsWith("Loading the font 'data:")) errors.push(details.message); });
    await win.loadFile(path.resolve('dist-renderer/index.html'));
    win.focus(); win.webContents.focus();
    await wait(() => evaluate(() => document.querySelectorAll('.pt-wp').length > 0), 'editable path');

    const original = await pathSeconds();
    await robotPage();
    assert.ok((await evaluate(() => [...document.querySelectorAll('.settings-nav button')].map((button) => button.textContent))).includes('Cameras'));
    assert.equal((await section()).empty, 'No cameras');
    await snapshot('no-cameras');
    pass('A robot without cameras shows the Cameras section in the rail with one "No cameras" row');

    await click('#settings-cameras .qbtn', 'Add camera');
    await wait(async () => (await section()).heading === 'Camera 1', 'first camera');
    let shown = await section();
    assert.deepEqual([shown.picks, shown.canAdd, shown.view, shown.volumes, shown.names, shown.bad], [['Camera 1*'], true, '3D', 1, ['Camera 1*'], false]);
    // Forward starts at the front edge of the 0.84 m frame.
    assert.deepEqual(await numbers(), ['70.0', '50.0', '0.42', '0.00', '0.30', '0.0', '15.0', '6.0']);
    pass('Add camera draws one view volume and starts it facing forward at the front edge');

    const facingFront = shown.picked;
    await typeInto('Camera yaw', '90');
    await wait(async () => (await section()).picked !== facingFront, 'drawing follows yaw');
    const facingLeft = (await section()).picked;
    await typeInto('Camera horizontal field of view', '100');
    await wait(async () => (await section()).picked !== facingLeft, 'drawing follows field of view');
    await typeInto('Camera height above floor', '0.6');
    await typeInto('Camera pitch', '200');
    await typeInto('Camera vertical field of view', '0');
    await wait(async () => (await field('Camera vertical field of view')) === '1.0', 'clamped field of view');
    await typeInto('Camera max range', '40');
    assert.deepEqual(await numbers(), ['100.0', '1.0', '0.42', '0.00', '0.60', '90.0', '90.0', '15.0']);
    await typeInto('Camera max range', '3.5');
    await typeInto('Camera vertical field of view', '45');
    await typeInto('Camera pitch', '10');
    assert.equal((await section()).bad, false);
    // The block is the robot: its height in Dimensions sets how tall it is drawn.
    const short = (await section()).body;
    await typeInto('Robot height', '1.1');
    await wait(async () => (await section()).body !== short, 'drawing follows robot height');
    assert.equal((await section()).bad, false);
    pass('Each number redraws the picked view volume, a number outside its range stops at the limit, and the robot is drawn at its height');

    const before = await section();
    await dragView(120, -40);
    const dragged = await section();
    assert.notEqual(dragged.body, before.body, 'Dragging turns the robot');
    assert.equal(dragged.view, null, 'A dragged view is no named view');
    await click('.rp-cam-views .seg-i', 'Top');
    await wait(async () => (await section()).view === 'Top', 'top view');
    const top = await section();
    await click('.rp-cam-stage svg');
    assert.equal(await evaluate(() => document.activeElement?.matches('.rp-cam-stage svg')), true, 'The view takes keyboard focus');
    assert.equal((await section()).body, top.body, 'A click without a drag leaves the view');
    await key('Left');
    await wait(async () => (await section()).body !== top.body, 'arrow key turns the view');
    assert.equal((await section()).view, null);
    await click('.rp-cam-views .seg-i', '3D');
    await wait(async () => (await section()).body === before.body, 'the 3D view returns exactly');
    pass('Drag and arrow keys turn the view, and each named view is exact');

    // Zoom enlarges the drawing about its middle: the robot's outline spreads wider on screen.
    const spread = async () => evaluate(() => { const xs = [...document.querySelectorAll('#settings-cameras .rp-cam-bodyTop')].flatMap((shape) => shape.getAttribute('points').split(' ').map((pair) => Number(pair.split(',')[0]))); return Math.max(...xs) - Math.min(...xs); });
    const fitted = await spread();
    await click('.rp-cam-action[aria-label="Zoom in"]');
    await wait(async () => (await spread()) > fitted * 1.2, 'zoom in button');
    await click('.rp-cam-stage svg');
    await key('-'); await key('-');
    await wait(async () => (await spread()) < fitted * 0.9, 'minus key zooms out');
    assert.equal((await section()).view, '3D', 'Zoom keeps the named view');
    const wheelAt = await evaluate(() => { const r = document.querySelector('.rp-cam-stage svg').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; });
    const small = await spread(), scrolled = await evaluate(() => document.querySelector('.robotpage').scrollTop);
    win.webContents.sendInputEvent({ type: 'mouseWheel', ...wheelAt, deltaX: 0, deltaY: 120, modifiers: ['control'] });
    await wait(async () => (await spread()) > small * 1.2, 'Ctrl+wheel zooms in');
    assert.equal(await evaluate(() => document.querySelector('.robotpage').scrollTop), scrolled, 'Ctrl+wheel does not scroll the page');
    const zoomed = await spread();
    win.webContents.sendInputEvent({ type: 'mouseWheel', ...wheelAt, deltaX: 0, deltaY: -120 });
    await wait(async () => (await evaluate(() => document.querySelector('.robotpage').scrollTop)) !== scrolled, 'a plain wheel scrolls the page');
    assert.equal(await spread(), zoomed, 'A plain wheel leaves the zoom');
    assert.equal(await evaluate(() => getComputedStyle(document.querySelector('.rp-cam-stage svg')).outlineStyle), 'none', 'The focused view shows no ring');
    for (let press = 0; press < 12; press++) { if (await evaluate(() => document.querySelector('.rp-cam-action[aria-label="Zoom in"]').disabled)) break; await click('.rp-cam-action[aria-label="Zoom in"]'); }
    assert.equal(await evaluate(() => document.querySelector('.rp-cam-action[aria-label="Zoom in"]').disabled), true, 'Zoom stops at its limit');
    assert.equal((await section()).bad, false);
    for (let press = 0; press < 6; press++) await click('.rp-cam-action[aria-label="Zoom out"]');
    pass('Buttons, the + and - keys and Ctrl+wheel zoom the view, and a plain wheel still scrolls the page');

    await click('.rp-cam-pick.new');
    await wait(async () => (await section()).heading === 'Camera 2', 'second camera');
    await click('.rp-cam-action[aria-label="Rename Camera 2"]');
    await wait(() => evaluate(() => document.activeElement?.matches('input[aria-label="Camera name"]')), 'camera name field');
    await win.webContents.insertText('camera 1'); await key('Enter');
    await wait(() => evaluate(() => document.querySelector('#settings-cameras [role="alert"]')?.textContent === 'Another camera has this name.'), 'refused repeated name');
    await key('Home'); await key('End', ['shift']);
    await win.webContents.insertText('Rear left'); await key('Enter');
    await wait(async () => (await section()).heading === 'Rear left', 'renamed camera');
    await typeInto('Camera forward of center', '-0.4');
    await typeInto('Camera left of center', '0.25');
    await typeInto('Camera yaw', '150');
    shown = await section();
    assert.deepEqual([shown.picks, shown.volumes, shown.names], [['Camera 1', 'Rear left*'], 2, ['Camera 1', 'Rear left*']]);
    await click('.rp-cam-pick', 'Camera 1');
    await wait(async () => (await section()).heading === 'Camera 1', 'picked first camera');
    assert.deepEqual(await numbers(), ['100.0', '45.0', '0.42', '0.00', '0.60', '90.0', '10.0', '3.5']);
    await click('.rp-cam-pick', 'Rear left');
    await snapshot('two-cameras');
    await click('.rp-cam-views .seg-i', 'Top');
    await snapshot('two-cameras-top');
    await click('.rp-cam-views .seg-i', '3D');
    pass('A second camera is added, renamed past a refused repeat, and picked without changing the first');

    await save();
    const expected = [
      { name: 'Camera 1', horizontalFovDeg: 100, verticalFovDeg: 45, positionM: { x: 0.42, y: 0, z: 0.6 }, yawDeg: 90, pitchDeg: 10, maxRangeM: 3.5 },
      { name: 'Rear left', horizontalFovDeg: 70, verticalFovDeg: 50, positionM: { x: -0.4, y: 0.25, z: 0.3 }, yawDeg: 150, pitchDeg: 15, maxRangeM: 6 },
    ];
    const stored = (project) => project.robot.cameras?.map(({ id: _id, ...camera }) => camera);
    assert.deepEqual(stored(saved), expected);
    assert.equal(new Set(saved.robot.cameras.map((camera) => camera.id)).size, 2);
    assert.equal(await pathSeconds(), original, 'Cameras never change the planned time');
    pass('Save writes both cameras, and the open path keeps its planned time');

    await robotPage();
    await click('.robot-card-new');
    await wait(() => evaluate(() => document.activeElement?.matches('.robot-card input[aria-label="Robot name"]')), 'new robot name field');
    await win.webContents.insertText('Practice bot'); await key('Enter');
    await wait(async () => (await section()).empty === 'No cameras', 'a new robot has no cameras');
    await click('.robot-card-pick', 'RobotNo address');
    await wait(async () => (await section()).picks.length === 2, 'the first robot keeps its cameras');
    await save();
    await win.reload();
    await wait(() => evaluate(() => document.querySelectorAll('.pt-wp').length > 0), 'reloaded project');
    await robotPage();
    await wait(async () => (await section()).picks.length === 2, 'cameras after reopening');
    assert.deepEqual(stored(saved), expected);
    assert.equal(saved.robots.find((robot) => robot.name === 'Practice bot').robot.cameras, undefined);
    pass('Cameras belong to their robot and come back after save and reopen');

    await click('.rp-cam-action[aria-label="Delete Camera 1"]');
    await wait(() => evaluate(() => document.activeElement?.textContent === 'Cancel'), 'delete confirmation focuses Cancel');
    assert.equal((await section()).picks.length, 2, 'Opening the confirmation keeps both cameras');
    await snapshot('delete-camera-confirmation');
    await key('Escape');
    await wait(() => evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Delete Camera 1'), 'Escape restores focus');
    await click('.rp-cam-action[aria-label="Delete Camera 1"]');
    await click('.rp-cam-confirm button', 'Delete');
    await wait(async () => (await section()).picks.length === 1, 'one camera left');
    assert.deepEqual((await section()).picks, ['Rear left*']);
    await click('.rp-cam-action[aria-label="Delete Rear left"]');
    await click('.rp-cam-confirm button', 'Delete');
    await wait(async () => (await section()).empty === 'No cameras', 'no cameras left');
    await save();
    assert.equal(saved.robot.cameras, undefined, 'A robot without cameras saves no camera list');
    pass('Deleting picks the neighbor, and deleting the last camera leaves no list in the file');

    assert.deepEqual(errors, [], 'No renderer errors, confirm dialogs or robot calls');
    app.exit(0);
  } catch (error) {
    console.error(error);
    try { await fs.writeFile(path.join(output, 'failure.png'), (await capture()).toPNG()); } catch (_) {}
    app.exit(1);
  }
});
