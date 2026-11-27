// The project's robot tabs in the built renderer: add with naming, edit one robot without the other, save and reopen,
// switch with pointer and keyboard and check the path re-times and comes back exactly, the tab menu, refused names,
// removal with its confirmation, and each robot's address: in its tab and the rail, made active on open and on each
// switch, and kept on save. Then Pull from robot: a read-only read of the robot's .robot file (mocked here), its
// field-by-field review (command loads and breaker fields one by one), Apply as one Undo step, a file that fails
// validation, choosing another file, details that would make the project unsaveable (Apply off, the error listed), and
// two robot names that push to one file.
// Screenshots at both supported sizes go to BORDEAUX_ROBOT_LIST_UI_OUTPUT.
const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = process.env.BORDEAUX_BRANCH_UI_OUTPUT;
app.setPath('userData', path.join(output, 'user-data'));
let win, saved, saves = 0;
const used = []; // Addresses the renderer made active, in order; null clears the active one.
let computerConnection = null; // The connection this computer had saved before robot lists, answered at startup.
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
async function typeInto(label, text) {
  await click(`input[aria-label="${label}"]`);
  await key('Home'); await key('End', ['shift']);
  await win.webContents.insertText(text);
  await key('Enter');
}
// Each tab's name, the address its tooltip shows and whether it is the selected robot.
const cards = () => evaluate(() => [...document.querySelectorAll('.robot-tab[data-robot]')].map((tab) => ({
  name: tab.querySelector('.robot-tab-name')?.textContent ?? null, summary: tab.dataset.address ?? null,
  selected: tab.getAttribute('aria-selected') === 'true', pressed: tab.getAttribute('aria-selected') })));
const selectedName = async () => (await cards()).find((card) => card.selected)?.name;
const field = (label) => evaluate((label) => document.querySelector(`input[aria-label="${label}"]`)?.value ?? null, label);
const focused = () => evaluate(() => ({ cls: document.activeElement?.className, text: document.activeElement?.textContent?.trim(), label: document.activeElement?.getAttribute('aria-label') }));
async function save() { const before = saves; await click('.project-chip'); await click('[role="menuitem"][data-action="save"]'); await wait(() => saves > before, 'save'); }
async function robotPage() { await click('.places .place', 'Robot'); await wait(() => evaluate(() => !!document.querySelector('.rp-identity') && !!document.querySelector('.robot-tabs')), 'robot page'); }
// The tab menu for a robot, opened with a real right-click on its tab.
async function tabMenu(name) { await click('.robot-tab', name, 'right'); await wait(() => evaluate(() => !!document.querySelector('.ctxmenu')), 'robot tab menu'); }
const menuItems = () => evaluate(() => [...document.querySelectorAll('.ctxmenu .ctxmenu-i')].map((item) => [item.textContent, item.disabled]));
const newName = () => wait(() => evaluate(() => document.activeElement?.matches('.robot-tab input[aria-label="Robot name"]')), 'new robot name field');
// The planned duration of the open path, read where the editor shows it.
async function pathSeconds() {
  await click('.places .place', 'Paths');
  await wait(() => evaluate(() => !document.querySelector('.fieldcol[data-planning-ready="false"]') && Number(document.querySelector('.pt-clock-total')?.textContent) > 0), 'planned path');
  await delay(200);
  return evaluate(() => document.querySelector('.pt-clock-total').textContent);
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
    const bar = await evaluate(() => { const r = document.querySelector('.robot-tabs').getBoundingClientRect(); return { bottom: Math.round(r.bottom), height: Math.round(r.height), window: innerHeight }; });
    assert.deepEqual([bar.bottom, bar.height], [bar.window, 32], `${name} at ${width}: the robot tabs sit along the window's bottom`);
    await fs.writeFile(path.join(output, `${name}-${width}.png`), (await capture()).toPNG());
  }
  win.setContentSize(1440, 900); await delay(150);
}
const pass = (name) => console.log('PASS ' + name);
ipcMain.handle('branches:restore', () => ({ project: saved }));
ipcMain.handle('branches:catalog', () => ({ catalog: { projectName: 'Fixture', commands: [], warnings: [] }, bookmarkId: 'fixture' }));
ipcMain.handle('branches:save', (_event, project) => { saved = project; saves++; return { saved: true }; });
// Until the Pull checks, an address is never verified here; then it answers with a host key reviewed before.
let verified = false;
const fingerprint = 'SHA256:' + 'r'.repeat(43);
ipcMain.handle('branches:use-endpoint', (_event, endpoint) => { used.push(endpoint); return endpoint ? { endpoint, ...(verified ? { hostKeyFingerprint: fingerprint } : {}) } : null; });
// The robot's push folder for Pull: file name to bytes. Reads are recorded; nothing here can write.
const robotFolder = new Map(), reads = [];
ipcMain.handle('branches:read-robot-files', (_event, fileNames) => {
  reads.push(fileNames);
  const endpoint = used.filter(Boolean).at(-1);
  const files = fileNames.map((fileName) => ({ fileName, contents: robotFolder.has(fileName) ? new Uint8Array(Buffer.from(robotFolder.get(fileName))) : null }));
  const missing = files.some((file) => file.contents === null && file.fileName.endsWith('.robot'));
  return { connection: { endpoint, hostKeyFingerprint: fingerprint }, readAt: new Date().toISOString(), files,
    ...(missing ? { robotConfigs: [...robotFolder.keys()].filter((name) => name.endsWith('.robot')).sort() } : {}) };
});
ipcMain.handle('branches:validate', (_event, project) => require('../dist-electron/core/validation.js').validateProject(project));
ipcMain.handle('branches:connection', () => computerConnection);
ipcMain.handle('branches:save-endpoint', (_event, endpoint) => (computerConnection = { endpoint }));
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
    win = new BrowserWindow({ show: true, width: 1440, height: 900, useContentSize: true, webPreferences: { preload: path.join(__dirname, 'verify-command-branches-ui-preload.cjs'), additionalArguments: ['--robot-list-ui-fixture'], sandbox: false, contextIsolation: true, backgroundThrottling: false } });
    win.webContents.on('console-message', (details) => { if (details.level === 'error' && !details.message.startsWith("Loading the font 'data:")) errors.push(details.message); });
    await win.loadFile(path.resolve('dist-renderer/index.html'));
    win.focus(); win.webContents.focus();
    await wait(() => evaluate(() => document.querySelectorAll('.pt-wp').length > 0), 'editable path');

    const original = await pathSeconds();
    await robotPage();
    assert.deepEqual(await cards(), [{ name: 'Robot', summary: 'No connection', selected: true, pressed: 'true' }]);
    assert.equal(await evaluate(() => document.querySelector('.rp-identity .rp-title')?.textContent), 'Robot', 'The rail names the selected robot');
    assert.equal(await evaluate(() => document.querySelector('.settings-nav button')?.textContent), 'Dimensions');
    assert.equal(await evaluate(() => document.querySelector('.robot-tab-add')?.textContent), 'New robot', 'With one robot, + says what it does');
    pass('A project saved before robots had names shows one selected robot tab, named in the rail');

    await click('.robot-tab-add');
    await newName();
    assert.equal(await evaluate(() => { const input = document.activeElement; return input.value.slice(input.selectionStart, input.selectionEnd); }), 'New robot');
    await win.webContents.insertText('Practice bot'); await key('Enter');
    await wait(async () => (await selectedName()) === 'Practice bot', 'named new robot');
    assert.equal((await focused()).cls, 'robot-tab', 'Naming returns focus to the tab');
    assert.equal(await evaluate(() => document.querySelector('.robot-tab-add')?.getAttribute('aria-label')), 'New robot');
    assert.deepEqual((await cards()).map((card) => [card.name, card.selected]), [['Robot', false], ['Practice bot', true]]);
    assert.equal(await field('Drive reduction'), '6.75', 'A new robot starts from the default details, not the 5.5:1 robot it was made beside');
    // A new robot has a drivetrain from the start, so every physical limit applies without a button press.
    assert.deepEqual(await evaluate(() => ({ limits: !!document.querySelector('.rp-hard-limits'), button: [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Use physical limits') })), { limits: true, button: false });
    // 16:1 tops out near 2 m/s, under the path's own speed limit, so the timing has to change.
    await typeInto('Drive reduction', '16');
    await wait(async () => (await field('Drive reduction')) === '16.00', 'edited practice gearing');
    pass('New robot starts from the default details with its physical limits on, names it in place, and edits only that robot');

    await save();
    assert.deepEqual(saved.robots.map((robot) => robot.name), ['Robot', 'Practice bot']);
    const practiceId = saved.robots[1].id, robotId = saved.robots[0].id;
    assert.equal(saved.activeRobotId, practiceId);
    assert.equal(saved.robot.driveModel.gearRatio, 16);
    assert.equal(saved.robots[0].robot.driveModel.gearRatio, 5.5);
    assert.equal(saved.robots[1].robot, undefined);
    await snapshot('two-robots');
    await win.reload();
    await wait(() => evaluate(() => document.querySelectorAll('.pt-wp').length > 0), 'reloaded editor');
    await robotPage();
    assert.deepEqual((await cards()).map((card) => [card.name, card.selected]), [['Robot', false], ['Practice bot', true]]);
    assert.equal(await field('Drive reduction'), '16.00');
    pass('Save writes both robots and the selection, and reopening restores them');

    const practice = await pathSeconds();
    assert.ok(Number(practice) > Number(original), `The path re-times for the practice gearing: ${practice} s against ${original} s`);
    await robotPage();
    await click('.robot-tab', 'Robot');
    await wait(async () => (await selectedName()) === 'Robot', 'switch by pointer');
    assert.equal(await field('Drive reduction'), '5.50');
    assert.equal(await pathSeconds(), original, 'Switching back restores the exact timing');
    await robotPage();
    await evaluate(() => document.querySelector('.robot-tab[aria-selected="true"]').focus());
    await key('Right');
    await wait(async () => (await selectedName()) === 'Practice bot', 'switch by keyboard');
    assert.equal(await pathSeconds(), practice);
    pass(`Switching re-times the path (${original} s and ${practice} s) by pointer and keyboard, and switching back restores it`);

    // Path limits above what the selected robot allows are kept as typed and marked; planning caps them.
    const speedBox = () => evaluate(() => { const box = document.querySelector('.pt-limits .numbox'); return { capped: box.classList.contains('capped'), title: box.getAttribute('title'), value: box.querySelector('input').value, described: document.getElementById(box.querySelector('input').getAttribute('aria-describedby')?.split(' ').find((id) => id.endsWith('-cap')))?.textContent ?? null }; });
    const typeSpeed = async (text) => { await click('.pt-limits .numinput'); await key('Home'); await key('End', ['shift']); await win.webContents.insertText(text); await key('Enter'); };
    const authoredSpeed = saved.paths[0].constraints.maxVel;
    let box = await speedBox();
    assert.equal(box.capped, true, 'The path speed is above the 16:1 robot\'s top speed');
    assert.match(box.title, /^Practice bot’s max speed is \d\.\d\d m\/s$/, 'The mark names the selected robot');
    const slowCap = Number(box.title.match(/[\d.]+/)[0]);
    assert.ok(slowCap < 2.5, 'The 16:1 robot tops out near 2 m/s: ' + slowCap);
    assert.equal(box.described, box.title, 'Screen readers get the same reason');
    await typeSpeed('6');
    await wait(async () => (await speedBox()).value === '6.00', 'a speed above the robot\'s is accepted');
    await save();
    assert.equal(saved.paths[0].constraints.maxVel, 6, 'The typed limit is stored');
    assert.equal(await pathSeconds(), practice, 'Planning still uses the robot\'s limit');
    await robotPage();
    await click('.robot-tab', 'Robot');
    await wait(async () => (await selectedName()) === 'Robot', 'faster robot selected');
    const faster = await pathSeconds();
    box = await speedBox();
    assert.match(box.title, /^Robot’s max speed is \d\.\d\d m\/s$/);
    assert.ok(Number(box.title.match(/[\d.]+/)[0]) > slowCap + 2, 'The mark follows the selected robot: ' + box.title);
    // This path's time is set by acceleration, so the higher speed limit may not shorten it; it must not lengthen it.
    assert.ok(Number(faster) <= Number(original), `The faster robot is no slower with the higher limit: ${faster} s against ${original} s`);
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(200);
      await fs.writeFile(path.join(output, `limit-capped-${width}.png`), (await capture()).toPNG());
    }
    win.setContentSize(1440, 900); await delay(150);
    await typeSpeed(String(authoredSpeed));
    await wait(async () => !(await speedBox()).capped, 'a limit under the robot\'s is not marked');
    assert.equal((await speedBox()).title, null);
    assert.equal(await pathSeconds(), original);
    await robotPage();
    await click('.robot-tab', 'Practice bot');
    await wait(async () => (await selectedName()) === 'Practice bot', 'practice robot selected again');
    pass('A path limit above the robot\'s is kept, marked with the robot\'s maximum, and the mark follows the selected robot');

    await robotPage();
    // The selected tab carries a ⋯ for its menu; a right-click on any tab, or Shift+F10 on the focused one, opens the same menu.
    assert.deepEqual(await evaluate(() => [...document.querySelectorAll('.robot-tab')].map((tab) => !!tab.querySelector('.robot-tab-more'))), [false, true]);
    await tabMenu('Robot');
    assert.equal(await selectedName(), 'Robot', 'Right-clicking a tab selects that robot');
    // Pull reads through the robot's connection, so a robot without one can't pull.
    assert.deepEqual(await menuItems(), [['RenameF2', false], ['Duplicate', false], ['Set up connection…', false], ['Pull from robot…', true], ['Delete…', false]]);
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(200);
      await fs.writeFile(path.join(output, `tab-menu-${width}.png`), (await capture()).toPNG());
    }
    win.setContentSize(1440, 900); await delay(150);
    await key('Escape');
    await wait(() => evaluate(() => !document.querySelector('.ctxmenu')), 'menu closed');
    assert.equal((await focused()).text, 'Robot', 'Escape returns focus to the tab');
    await key('Right');
    await wait(async () => (await selectedName()) === 'Practice bot', 'arrow selects the next tab');
    await key('F10', ['shift']);
    await wait(() => evaluate(() => document.activeElement?.closest('.ctxmenu')), 'keyboard menu');
    assert.equal(await evaluate(() => document.querySelector('.ctxmenu')?.getAttribute('aria-label')), 'Actions for Practice bot');
    await key('Escape');
    pass('Each tab opens Rename, Duplicate, its connection, Pull and Delete by right-click, ⋯ or Shift+F10, and Escape returns to the tab');

    await key('F2');
    await wait(() => evaluate(() => document.activeElement?.matches('input[aria-label="Robot name"]')), 'rename field');
    await key('Home'); await key('End', ['shift']); await win.webContents.insertText('robot'); await key('Enter');
    await wait(() => evaluate(() => document.querySelector('.robot-tab [role="alert"]')?.textContent === 'Another robot has this name.'), 'refused name');
    assert.equal(await evaluate(() => document.activeElement?.getAttribute('aria-invalid')), 'true');
    await snapshot('rename-refused');
    await key('Escape');
    await wait(async () => (await cards()).map((card) => card.name).join() === 'Robot,Practice bot', 'Escape keeps the name');
    assert.equal((await focused()).cls, 'robot-tab');
    pass('Rename refuses a name another robot has, ignoring case, and Escape keeps the old name');

    await tabMenu('Practice bot');
    await click('.ctxmenu .ctxmenu-i', 'Duplicate');
    await wait(async () => (await selectedName()) === 'Practice bot 2', 'duplicated robot');
    assert.deepEqual((await cards()).map((card) => [card.name, card.selected]), [['Robot', false], ['Practice bot', false], ['Practice bot 2', true]]);
    assert.equal(await field('Drive reduction'), '16.00', 'The copy keeps the duplicated robot\'s details');
    await wait(async () => (await focused()).cls === 'robot-tab' && (await focused()).text === 'Practice bot 2', 'focus on the copy');
    await tabMenu('Practice bot 2');
    await click('.ctxmenu .ctxmenu-i', 'Delete…');
    await click('.robot-tab-confirm button', 'Delete');
    await wait(async () => (await cards()).length === 2, 'deleted the copy');
    pass('Duplicate copies any robot with its details and selects the copy');

    await tabMenu('Practice bot');
    await click('.ctxmenu .ctxmenu-i', 'Delete…');
    await wait(() => evaluate(() => document.activeElement?.textContent === 'Cancel'), 'delete confirmation');
    await snapshot('remove-confirmation');
    await key('Escape');
    await wait(() => evaluate(() => !document.querySelector('.robot-tab-confirm')), 'Escape cancels');
    assert.equal((await cards()).length, 2);
    assert.equal((await focused()).text, 'Practice bot', 'Cancel returns focus to the tab');
    await tabMenu('Practice bot');
    await click('.ctxmenu .ctxmenu-i', 'Delete…');
    await click('.robot-tab-confirm button', 'Delete');
    await wait(async () => (await cards()).length === 1, 'removed robot');
    assert.deepEqual(await cards(), [{ name: 'Robot', summary: 'No connection', selected: true, pressed: 'true' }]);
    assert.equal(await field('Drive reduction'), '5.50', 'Deleting the selected robot selects the one left');
    await tabMenu('Robot');
    assert.deepEqual((await menuItems()).at(-1), ['Delete (the last robot stays)', true], 'The last robot cannot be deleted');
    await key('Escape');
    await save();
    assert.deepEqual(saved.robots, [{ id: robotId, name: 'Robot' }]);
    assert.equal(saved.activeRobotId, robotId);
    assert.equal(saved.robot.driveModel.gearRatio, 5.5);
    assert.equal(await pathSeconds(), original);
    pass('Delete asks first, Cancel keeps the robot, and the last robot stays');

    // Robots with their own addresses. No robot is contacted: the fixture records each address the renderer makes active.
    const comp = { target: 'systemcore', host: '10.24.68.2', port: 22, directory: '/home/systemcore/bordeaux/paths' };
    const practiceAddress = { ...comp, host: '10.24.68.3' };
    assert.deepEqual(used, [], 'A robot without an address, with nothing active, changes nothing');
    saved = { ...saved, robots: [{ id: robotId, name: 'Comp bot', connection: comp }, { id: practiceId, name: 'Practice bot', robot: structuredClone(saved.robot), connection: practiceAddress }], activeRobotId: robotId };
    await win.reload();
    await wait(() => evaluate(() => document.querySelectorAll('.pt-wp').length > 0), 'reloaded editor with addresses');
    await robotPage();
    await wait(() => used.length === 1, 'opening makes the selected robot\'s address active');
    assert.deepEqual(used, [comp]);
    assert.deepEqual((await cards()).map((card) => [card.name, card.summary, card.selected]), [['Comp bot', '10.24.68.2', true], ['Practice bot', '10.24.68.3', false]]);
    const connectionStatus = () => evaluate(() => document.querySelector('.robot-connection .robot-connection-status')?.textContent);
    await wait(async () => (await connectionStatus())?.startsWith('10.24.68.2'), 'connection row names the selected robot');
    await click('.robot-tab', 'Practice bot');
    await wait(() => used.length === 2, 'switching makes the other address active');
    assert.deepEqual(used.at(-1), practiceAddress);
    await wait(async () => (await connectionStatus())?.startsWith('10.24.68.3'), 'connection row follows the switch');
    await snapshot('robot-addresses');
    await click('.robot-tab', 'Comp bot');
    await wait(() => used.length === 3, 'switching back makes the first address active again');
    assert.deepEqual(used.at(-1), comp);
    pass('Each robot shows its IP in its tab and the rail, and opening and switching make that robot\'s address active');

    // Each connection belongs to one robot: a new robot has none and clears the active one; Duplicate copies it.
    await click('.robot-tab-add');
    await newName();
    await win.webContents.insertText('Spare bot'); await key('Enter');
    await wait(async () => (await selectedName()) === 'Spare bot', 'named new robot');
    assert.equal((await cards()).find((card) => card.name === 'Spare bot').summary, 'No connection', 'A new robot starts without an address');
    await wait(() => used.length === 4, 'a robot without an address clears the active connection');
    assert.equal(used.at(-1), null);
    await wait(async () => (await connectionStatus()) === 'Not set up', 'the rail has no connection for the new robot');
    await tabMenu('Comp bot');
    await click('.ctxmenu .ctxmenu-i', 'Duplicate');
    await wait(async () => (await selectedName()) === 'Comp bot 2', 'duplicated robot with an address');
    assert.equal((await cards()).find((card) => card.name === 'Comp bot 2').summary, '10.24.68.2', 'Duplicate copies the address');
    await wait(() => used.length === 5, 'the copy\'s address becomes active');
    assert.deepEqual(used.at(-1), comp);
    await save();
    assert.deepEqual(saved.robots.map((robot) => [robot.name, robot.connection]), [['Comp bot', comp], ['Practice bot', practiceAddress], ['Spare bot', undefined], ['Comp bot 2', comp]]);
    pass('A new robot has no connection of its own and clears the active one; Duplicate copies the address, and copies stay separate');

    // A project saved before robot lists uses this computer's connection until the list exists; then that robot owns it.
    computerConnection = { endpoint: practiceAddress };
    used.length = 0;
    saved = { ...saved, robots: undefined, activeRobotId: undefined };
    await win.reload();
    await wait(() => evaluate(() => document.querySelectorAll('.pt-wp').length > 0), 'reloaded project without a robot list');
    await robotPage();
    await wait(async () => (await cards())[0]?.summary === '10.24.68.3', 'the single robot shows this computer\'s connection');
    assert.deepEqual(used, [], 'Opening an older project changes no connection');
    await click('.robot-connection .library-connection');
    await click('.robot-push-dialog button', 'Edit');
    await click('.robot-push-dialog button', 'Save');
    await wait(() => evaluate(() => !document.querySelector('.robot-push-dialog .rfp-fields input')), 'saved the computer connection');
    await key('Escape');
    await save();
    assert.equal(saved.robots, undefined, 'Saving a connection does not upgrade an unnamed single-robot project');

    await click('.robot-tab-add');
    await newName();
    await key('Escape');
    await wait(async () => (await cards()).length === 2, 'second robot');
    assert.deepEqual((await cards()).map((card) => [card.name, card.summary]), [['Robot', '10.24.68.3'], ['New robot', 'No connection']]);
    await save();
    assert.deepEqual(saved.robots.map((robot) => [robot.name, robot.connection]), [['Robot', practiceAddress], ['New robot', undefined]]);
    pass('An older project\'s robot keeps this computer\'s connection as its own address once a second robot exists');

    // With no list and no connection on this computer, the single robot's card id is all Duplicate has to go on.
    computerConnection = null;
    saved = { ...saved, robots: undefined, activeRobotId: undefined };
    await win.reload();
    await wait(() => evaluate(() => document.querySelectorAll('.pt-wp').length > 0), 'reloaded project without a list or connection');
    await robotPage();
    await tabMenu('Robot');
    await click('.ctxmenu .ctxmenu-i', 'Duplicate');
    await wait(async () => (await selectedName()) === 'Robot 2', 'duplicated the only robot');
    assert.deepEqual((await cards()).map((card) => [card.name, card.selected]), [['Robot', false], ['Robot 2', true]]);
    pass('Duplicate works on the only robot of an older project that has no connection');

    // Pull from robot. Two robots with addresses whose host keys this computer reviewed before.
    const { robotFileContents } = require('../dist-electron/core/project/robotFile.js');
    verified = true; used.length = 0;
    const compAddress = { target: 'roborio', host: '10.24.68.2', port: 22, directory: '/home/lvuser/bordeaux' };
    const compDetails = { ...saved.robot, id: undefined, w: 0.84, l: 0.84, drive: 'swerve', driveModel: { ...driveModel,
      commandLoads: [{ commandId: 'intake', currentA: 20 }], driveBreaker: { ratedCurrentA: 40, tripTimeAt2xS: 5, initialHeat: 0 } } };
    delete compDetails.id; delete compDetails.cameras; delete compDetails.estimatesFrom;
    // The path ends with a jiggle, which a tank drive can't run: a tank file must not be applied (checked last).
    const pullPath = structuredClone(first), lastWaypoint = pullPath.waypoints.length - 1;
    pullPath.goalVel = 0;
    pullPath.waypoints[lastWaypoint] = { ...pullPath.waypoints[lastWaypoint], stop: true, jiggle: { distanceM: 0.1, strokes: 4, startDeg: 0, stepDeg: 90, strokeTimeS: 0.4 } };
    saved = { ...saved, paths: [pullPath], robot: compDetails, activeRobotId: 'robot_comp', robots: [
      { id: 'robot_comp', name: 'Comp bot', connection: compAddress },
      { id: 'robot_practice', name: 'Practice bot', connection: { ...compAddress, host: '10.24.68.3' }, robot: { ...compDetails, driveModel: { ...driveModel, gearRatio: 8 } } }] };
    const camera = { id: 'cam_front', name: 'Front', horizontalFovDeg: 70, verticalFovDeg: 50, positionM: { x: 0.3, y: 0, z: 0.45 }, yawDeg: 0, pitchDeg: 15 };
    // Planning notes long enough that two versions differ only past the first 60 characters.
    const notes = 'Score the preload first, then cross the line and wait for the alliance partner. ';
    const pulledDetails = { ...compDetails, w: 0.7, cameras: [camera], planning: { notes: notes + 'Park.' }, driveModel: { ...compDetails.driveModel, gearRatio: 6.12, massKg: 54,
      commandLoads: [{ commandId: 'intake', currentA: 160 }], driveBreaker: { ratedCurrentA: 40, tripTimeAt2xS: 5, initialHeat: 0.5 } } };
    robotFolder.set('Comp-bot.robot', robotFileContents('Comp bot', pulledDetails));
    robotFolder.set('Practice-bot.robot', robotFileContents('Practice bot', { ...compDetails, w: -1 }));
    robotFolder.set('Spare.robot', robotFileContents('Spare', { ...compDetails, l: 0.9 }));
    await win.reload();
    await wait(() => evaluate(() => document.querySelectorAll('.pt-wp').length > 0), 'reloaded two robots with addresses');
    await robotPage();
    await wait(() => evaluate(() => !!document.querySelector('.rp-identity .rp-pull')), 'Pull from robot in the rail');
    const width = await field('Robot width'), gearing = await field('Drive reduction');
    assert.deepEqual([width, gearing], ['0.84', '5.50']);
    await click('.rp-identity .rp-pull', 'Pull from robot…');
    await wait(() => evaluate(() => !!document.querySelector('.rfp-pull-table')), 'pull review');
    assert.deepEqual(reads, [['Comp-bot.robot']], 'Pull reads the selected robot\'s file by name');
    const review = await evaluate(() => ({
      title: document.querySelector('#robot-pull-title')?.textContent,
      where: document.querySelector('.rfp-pull .rfp-dest-text')?.textContent,
      sections: [...document.querySelectorAll('.rfp-pull-section th')].map((th) => th.textContent),
      rows: [...document.querySelectorAll('.rfp-pull-table tbody tr[data-changed]')].map((tr) => [...tr.children].map((cell) => cell.textContent)),
      focus: document.activeElement?.textContent, apply: [...document.querySelectorAll('.rfp-pull button')].map((b) => b.textContent) }));
    assert.equal(review.title, 'Pull from robot');
    assert.match(review.where, /Comp-bot\.robot.*10\.24\.68\.2.*\/home\/lvuser\/bordeaux/);
    assert.deepEqual(review.sections, ['Dimensions', 'Cameras', 'Drivetrain', 'Loads and breakers', 'Agent profile']);
    // Every value Apply replaces has its own row: an added camera's mount and view, a command load's current and a
    // breaker's warm start included, and long notes whole.
    assert.deepEqual(review.rows, [['Width', '0.84 m', '0.70 m'], ['Front', 'Not present', 'Added'],
      ['Front forward', 'Not set', '0.300 m'], ['Front left', 'Not set', '0.000 m'], ['Front height', 'Not set', '0.450 m'], ['Front yaw', 'Not set', '0.0 °'],
      ['Front pitch', 'Not set', '15.0 °'], ['Front horizontal view', 'Not set', '70.0 °'], ['Front vertical view', 'Not set', '50.0 °'],
      ['Drive reduction', '5.50:1', '6.12:1'], ['Mass', '50.0 kg', '54.0 kg'],
      ['Drive breaker initial heat', '0%', '50%'], ['Command intake current', '20 A', '160 A'], ['Planning notes', 'Not set', notes + 'Park.']]);
    assert.equal(await evaluate(() => document.querySelector('.rfp-pull-problems')), null, 'Nothing elsewhere in the project blocks this Apply');
    assert.equal(review.focus, 'Cancel', 'Apply is never focused for a held Enter');
    await snapshot('pull-review');
    await click('.rfp-pull button', 'Apply');
    await wait(() => evaluate(() => !document.querySelector('dialog.rfp-pull[open]')), 'pull dialog closed');
    await wait(async () => (await field('Robot width')) === '0.70', 'applied width');
    assert.equal(await field('Drive reduction'), '6.12');
    assert.equal((await focused()).text, 'Pull from robot…', 'Focus returns to Pull');
    pass('Pull from robot reads the selected robot\'s file, reviews each change by section in display units, and Apply replaces its details');

    await key('Z', ['meta']);
    await wait(async () => (await field('Robot width')) === '0.84', 'undone pull');
    assert.equal(await field('Drive reduction'), '5.50');
    await key('Z', ['meta', 'shift']);
    await wait(async () => (await field('Robot width')) === '0.70', 'redone pull');
    await save();
    assert.equal(saved.robot.w, 0.7);
    assert.equal(saved.robot.driveModel.gearRatio, 6.12);
    assert.deepEqual(saved.robot.cameras.map((item) => item.name), ['Front']);
    assert.equal(saved.robots[1].robot.driveModel.gearRatio, 8, 'The other robot is untouched');
    assert.deepEqual(saved.robots.map((robot) => robot.name), ['Comp bot', 'Practice bot'], 'Apply keeps robot names');
    await key('Z', ['meta']);
    await wait(async () => (await field('Robot width')) === '0.84', 'undone again');
    pass('Apply is one Undo step: Undo puts the details back, Redo applies them again, and the other robot is untouched');

    // A camera renamed only in case, and notes that differ past their first 60 characters, are each a row in full.
    await key('Z', ['meta', 'shift']);
    await wait(async () => (await field('Robot width')) === '0.70', 'redone for the rename');
    robotFolder.set('Comp-bot.robot', robotFileContents('Comp bot', { ...pulledDetails, cameras: [{ ...camera, name: 'FRONT' }], planning: { notes: notes + 'Defend.' } }));
    await click('.rp-identity .rp-pull', 'Pull from robot…');
    await wait(() => evaluate(() => !!document.querySelector('.rfp-pull-table')), 'rename review');
    const renamed = await evaluate(() => [...document.querySelectorAll('.rfp-pull-table tbody tr[data-changed]')].map((tr) => [...tr.children].map((cell) => cell.textContent)));
    assert.deepEqual(renamed, [['Front name', 'Front', 'FRONT'], ['Planning notes', notes + 'Park.', notes + 'Defend.']]);
    await snapshot('pull-rename-notes');
    await click('.rfp-pull button', 'Apply');
    await wait(() => evaluate(() => !document.querySelector('dialog.rfp-pull[open]')), 'rename applied');
    // Undo after a Robot page edit: it would put back details that edit was never checked with, so it refuses and says
    // why, and the robot keeps the edit.
    await typeInto('Robot width', '0.72');
    await wait(async () => (await field('Robot width')) === '0.72', 'edited after pull');
    await evaluate(() => { window.__alerts = []; window.alert = (text) => { window.__alerts.push(String(text)); }; });
    await key('Z', ['meta']);
    await wait(() => evaluate(() => window.__alerts.length > 0), 'undo refused');
    assert.deepEqual(await evaluate(() => window.__alerts), ['“Comp bot” changed after Pull, so Undo left its details as they are.']);
    assert.equal(await field('Robot width'), '0.72', 'A refused Undo leaves the robot as it is');
    await save();
    assert.equal(saved.robot.w, 0.72);
    assert.deepEqual(saved.robot.cameras.map((item) => item.name), ['FRONT']);
    await snapshot('pull-undo-refused');
    pass('Pull review shows a case-only camera rename and long notes whole; Undo after a later edit refuses with its reason');

    await click('.robot-tab', 'Practice bot');
    await wait(async () => (await selectedName()) === 'Practice bot', 'practice selected');
    await wait(() => evaluate(() => document.querySelector('.rp-identity .rp-pull')?.disabled === false), 'practice address active');
    await tabMenu('Practice bot');
    assert.ok((await menuItems()).some(([label, disabled]) => label === 'Pull from robot…' && !disabled), 'The tab menu offers Pull');
    await click('.ctxmenu .ctxmenu-i', 'Pull from robot…');
    await wait(() => evaluate(() => !!document.querySelector('.rfp-pull .rfp-alert')), 'refused file');
    const refused = await evaluate(() => document.querySelector('.rfp-pull .rfp-alert').textContent);
    assert.match(refused, /^Practice-bot\.robot can’t be used\. Robot width must be .*\(w\)\. Nothing changed\.$/);
    assert.equal(await evaluate(() => !!document.querySelector('.rfp-pull .qbtn.primary') && document.querySelector('.rfp-pull .qbtn.primary').textContent), 'Close');
    assert.equal(await evaluate(() => [...document.querySelectorAll('.rfp-pull button')].some((b) => b.textContent === 'Apply')), false, 'A refused file offers no Apply');
    await snapshot('pull-invalid');
    await key('Escape');
    await wait(() => evaluate(() => !document.querySelector('dialog.rfp-pull[open]')), 'refused dialog closed');
    assert.equal(await field('Drive reduction'), '8.00', 'A refused file changes nothing');
    pass('A robot file that fails validation is reported with its reason and never applied');

    robotFolder.delete('Practice-bot.robot');
    reads.length = 0;
    await click('.rp-identity .rp-pull', 'Pull from robot…');
    await wait(() => evaluate(() => !!document.querySelector('.rfp-pull-choices')), 'choose another file');
    assert.deepEqual(await evaluate(() => [...document.querySelectorAll('.rfp-pull-choices [data-robot-file]')].map((b) => b.dataset.robotFile)), ['Comp-bot.robot', 'Spare.robot']);
    await snapshot('pull-choose');
    await click('.rfp-pull-choices button', 'Read');
    await wait(() => evaluate(() => !!document.querySelector('.rfp-pull-table')), 'review of the chosen file');
    assert.deepEqual(reads, [['Practice-bot.robot'], ['Comp-bot.robot']]);
    assert.match(await evaluate(() => document.querySelector('.rfp-pull .rfp-note')?.textContent ?? ''), /named for “Comp bot”\. Apply keeps the name Practice bot/);
    await click('.rfp-pull button', 'Cancel');
    await wait(() => evaluate(() => !document.querySelector('dialog.rfp-pull[open]')), 'cancelled');
    assert.equal(await field('Drive reduction'), '8.00', 'Cancel changes nothing');
    pass('A robot without its own file offers the folder\'s other robot files, and Cancel changes nothing');

    // A tank drive pulled under the path's endpoint jiggle: the review lists the error Save would refuse, Apply is off.
    robotFolder.set('Practice-bot.robot', robotFileContents('Practice bot', { ...compDetails, drive: 'tank', driveModel: { ...driveModel, gearRatio: 8 } }));
    await click('.rp-identity .rp-pull', 'Pull from robot…');
    await wait(() => evaluate(() => !!document.querySelector('.rfp-pull-problems')), 'blocked review');
    const blocked = await evaluate(() => ({ problems: [...document.querySelectorAll('.rfp-pull-problems li')].map((li) => li.textContent),
      intro: document.querySelector('.rfp-pull-problems .rfp-alert').textContent,
      apply: [...document.querySelectorAll('.rfp-pull button')].find((b) => b.textContent === 'Apply')?.disabled,
      rows: [...document.querySelectorAll('.rfp-pull-table tbody tr[data-changed]')].map((tr) => [...tr.children].map((cell) => cell.textContent)), focus: document.activeElement?.textContent }));
    assert.deepEqual(blocked.problems, [`“${pullPath.name}”: Arbitrary-direction jiggle requires a swerve drivetrain.`]);
    assert.match(blocked.intro, /^Apply would give the project an error Save refuses, so it is off\./);
    assert.equal(blocked.apply, true, 'Apply is disabled');
    assert.deepEqual(blocked.rows, [['Drive type', 'Swerve', 'Tank']]);
    assert.equal(blocked.focus, 'Cancel');
    await snapshot('pull-blocked');
    await key('Escape');
    await wait(() => evaluate(() => !document.querySelector('dialog.rfp-pull[open]')), 'blocked dialog closed');
    pass('Details that would make the project unsaveable list the error with its path and cannot be applied');

    // Two robot names that push to one file: Pull names both and reads nothing.
    await click('.robot-tab', 'Practice bot');
    await key('F2');
    await wait(() => evaluate(() => document.activeElement?.matches('input[aria-label="Robot name"]')), 'rename field');
    await key('Home'); await key('End', ['shift']); await win.webContents.insertText('Comp-bot'); await key('Enter');
    await wait(async () => (await selectedName()) === 'Comp-bot', 'renamed to Comp-bot');
    reads.length = 0;
    await click('.rp-identity .rp-pull', 'Pull from robot…');
    await wait(() => evaluate(() => !!document.querySelector('.rfp-pull .rfp-alert')), 'collision refused');
    const collision = await evaluate(() => ({ text: document.querySelector('.rfp-pull .rfp-body').textContent, buttons: [...document.querySelectorAll('.rfp-pull .rfp-actions button')].map((b) => b.textContent) }));
    assert.match(collision.text, /“Comp-bot” and “Comp bot” would both use Comp-bot\.robot on the robot\./);
    assert.deepEqual(collision.buttons, ['Close']);
    assert.deepEqual(reads, [], 'Nothing is read');
    await snapshot('pull-collision');
    await key('Escape');
    await wait(() => evaluate(() => !document.querySelector('dialog.rfp-pull[open]')), 'collision dialog closed');
    pass('Two robots whose names push to one file: Pull names both, reads nothing and offers only Close');

    assert.deepEqual(errors, [], 'No renderer errors, confirm dialogs or robot calls');
    app.exit(0);
  } catch (error) {
    console.error(error);
    try { await fs.writeFile(path.join(output, 'failure.png'), (await capture()).toPNG()); } catch (_) {}
    app.exit(1);
  }
});
