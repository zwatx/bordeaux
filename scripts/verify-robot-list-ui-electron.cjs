// The project's robot cards in the built renderer: add with naming, edit one robot without the other, save and reopen,
// switch with pointer and keyboard and check the path re-times and comes back exactly, refused names, removal with its
// confirmation, and each robot's address: its IP on the card, made active on open and on each switch, and kept on save.
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
const cards = () => evaluate(() => [...document.querySelectorAll('.robot-card[data-robot]')].map((card) => ({
  name: card.querySelector('.robot-card-pick strong')?.textContent ?? null, summary: card.querySelector('.robot-card-pick small')?.textContent ?? null,
  selected: card.classList.contains('on'), pressed: card.querySelector('.robot-card-pick')?.getAttribute('aria-pressed') ?? null })));
const selectedName = async () => (await cards()).find((card) => card.selected)?.name;
const field = (label) => evaluate((label) => document.querySelector(`input[aria-label="${label}"]`)?.value ?? null, label);
const focused = () => evaluate(() => ({ cls: document.activeElement?.className, text: document.activeElement?.textContent?.trim(), label: document.activeElement?.getAttribute('aria-label') }));
async function save() { const before = saves; await click('.project-chip'); await click('[role="menuitem"][data-action="save"]'); await wait(() => saves > before, 'save'); }
async function robotPage() { await click('.places .place', 'Robot'); await wait(() => evaluate(() => !!document.querySelector('.robot-cards')), 'robot cards'); }
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
    await evaluate(() => document.getElementById('settings-robots')?.scrollIntoView({ block: 'start' }));
    const clipped = await evaluate(() => [...document.querySelectorAll('.robot-card')].some((card) => card.scrollWidth > card.clientWidth + 1));
    assert.equal(clipped, false, `${name} at ${width}: a robot card is clipped`);
    await fs.writeFile(path.join(output, `${name}-${width}.png`), (await capture()).toPNG());
  }
  win.setContentSize(1440, 900); await delay(150);
}
const pass = (name) => console.log('PASS ' + name);
ipcMain.handle('branches:restore', () => ({ project: saved }));
ipcMain.handle('branches:catalog', () => ({ catalog: { projectName: 'Fixture', commands: [], warnings: [] }, bookmarkId: 'fixture' }));
ipcMain.handle('branches:save', (_event, project) => { saved = project; saves++; return { saved: true }; });
ipcMain.handle('branches:use-endpoint', (_event, endpoint) => { used.push(endpoint); return endpoint ? { endpoint } : null; });
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
    assert.deepEqual(await cards(), [{ name: 'Robot', summary: 'No address', selected: true, pressed: 'true' }]);
    assert.equal(await evaluate(() => document.querySelector('.settings-nav button')?.textContent), 'Robots');
    pass('A project saved before robots had names shows one selected robot card, first in the rail');

    await click('.robot-card-new');
    await wait(() => evaluate(() => document.activeElement?.matches('.robot-card input[aria-label="Robot name"]')), 'new robot name field');
    assert.equal(await evaluate(() => { const input = document.activeElement; return input.value.slice(input.selectionStart, input.selectionEnd); }), 'New robot');
    await win.webContents.insertText('Practice bot'); await key('Enter');
    await wait(async () => (await selectedName()) === 'Practice bot', 'named new robot');
    assert.equal((await focused()).cls, 'robot-card-pick', 'Naming returns focus to the card');
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
    await click('.robot-card-pick', 'RobotNo address');
    await wait(async () => (await selectedName()) === 'Robot', 'switch by pointer');
    assert.equal(await field('Drive reduction'), '5.50');
    assert.equal(await pathSeconds(), original, 'Switching back restores the exact timing');
    await robotPage();
    await evaluate(() => document.querySelectorAll('.robot-card-pick')[1].focus());
    await key('Enter');
    await wait(async () => (await selectedName()) === 'Practice bot', 'switch by keyboard');
    assert.equal(await pathSeconds(), practice);
    pass(`Switching re-times the path (${original} s and ${practice} s) by pointer and keyboard, and switching back restores it`);

    // Path limits above what the selected robot allows are kept as typed and marked; planning caps them.
    const speedBox = () => evaluate(() => { const box = document.querySelector('.pt-limits .numbox'); return { capped: box.classList.contains('capped'), title: box.getAttribute('title'), value: box.querySelector('input').value, described: document.getElementById(box.querySelector('input').getAttribute('aria-describedby')?.split(' ').find((id) => id.endsWith('-cap')))?.textContent ?? null }; });
    const typeSpeed = async (text) => { await click('.pt-limits .numinput'); await key('Home'); await key('End', ['shift']); await win.webContents.insertText(text); await key('Enter'); };
    const authoredSpeed = saved.paths[0].constraints.maxVel;
    let box = await speedBox();
    assert.equal(box.capped, true, 'The path speed is above the 16:1 robot\'s top speed');
    assert.match(box.title, /^Your robot’s max speed is \d\.\d\d m\/s$/);
    const slowCap = Number(box.title.match(/[\d.]+/)[0]);
    assert.ok(slowCap < 2.5, 'The 16:1 robot tops out near 2 m/s: ' + slowCap);
    assert.equal(box.described, box.title, 'Screen readers get the same reason');
    await typeSpeed('6');
    await wait(async () => (await speedBox()).value === '6.00', 'a speed above the robot\'s is accepted');
    await save();
    assert.equal(saved.paths[0].constraints.maxVel, 6, 'The typed limit is stored');
    assert.equal(await pathSeconds(), practice, 'Planning still uses the robot\'s limit');
    await robotPage();
    await click('.robot-card-pick', 'RobotNo address');
    await wait(async () => (await selectedName()) === 'Robot', 'faster robot selected');
    const faster = await pathSeconds();
    box = await speedBox();
    assert.match(box.title, /^Your robot’s max speed is \d\.\d\d m\/s$/);
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
    await click('.robot-card-pick', 'Practice botNo address');
    await wait(async () => (await selectedName()) === 'Practice bot', 'practice robot selected again');
    pass('A path limit above the robot\'s is kept, marked with the robot\'s maximum, and the mark follows the selected robot');

    await robotPage();
    // Quick actions: hidden until the card is hovered or holds focus, then Rename, Duplicate and Delete icon buttons.
    const gap = () => evaluate(() => Math.round(document.querySelector('.robot-connection').getBoundingClientRect().top - document.querySelector('.robot-cards').getBoundingClientRect().bottom));
    const shown = (name) => evaluate((name) => getComputedStyle([...document.querySelectorAll('.robot-card[data-robot]')].find((card) => card.querySelector('strong')?.textContent === name).querySelector('.robot-card-actions')).opacity, name);
    const hover = async (name) => {
      const point = await evaluate((name) => { const card = [...document.querySelectorAll('.robot-card[data-robot]')].find((item) => item.querySelector('strong')?.textContent === name);
        card.scrollIntoView({ block: 'center' }); const r = card.getBoundingClientRect(); return { x: Math.round(r.x + 40), y: Math.round(r.y + r.height / 2) }; }, name);
      win.webContents.sendInputEvent({ type: 'mouseMove', ...point }); await delay(200);
    };
    const away = async () => { win.webContents.sendInputEvent({ type: 'mouseMove', x: 120, y: 600 }); await delay(200); };
    await away();
    await evaluate(() => document.activeElement?.blur());
    assert.equal(await shown('Practice bot'), '0', 'Quick actions stay hidden until the card is hovered');
    await hover('Practice bot');
    assert.equal(await shown('Practice bot'), '1', 'Hovering a card shows its quick actions');
    assert.equal(await shown('Robot'), '0');
    assert.deepEqual(await evaluate(() => [...document.querySelectorAll('.robot-card.on .robot-card-action')].map((button) => button.getAttribute('aria-label'))), ['Rename Practice bot', 'Duplicate Practice bot', 'Delete Practice bot']);
    assert.equal(await gap(), 10, 'Quick actions keep the space above the connection card');
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(200);
      await evaluate(() => document.getElementById('settings-robots')?.scrollIntoView({ block: 'start' }));
      await hover('Practice bot');
      await fs.writeFile(path.join(output, `quick-actions-${width}.png`), (await capture()).toPNG());
    }
    win.setContentSize(1440, 900); await delay(150);
    await away();
    await evaluate(() => [...document.querySelectorAll('.robot-card-pick')].find((button) => button.textContent.startsWith('Robot')).focus());
    await key('Tab');
    assert.equal((await focused()).label, 'Rename Robot', 'Tab reaches the quick actions');
    assert.equal(await shown('Robot'), '1', 'Focus shows the quick actions without a pointer');
    pass('Quick actions appear on hover or focus as Rename, Duplicate and Delete icon buttons, without moving the cards');

    await click('.robot-card-action[aria-label="Rename Practice bot"]');
    await wait(() => evaluate(() => document.activeElement?.matches('input[aria-label="Robot name"]')), 'rename field');
    await key('Home'); await key('End', ['shift']); await win.webContents.insertText('robot'); await key('Enter');
    await wait(() => evaluate(() => document.querySelector('.robot-card [role="alert"]')?.textContent === 'Another robot has this name.'), 'refused name');
    assert.equal(await evaluate(() => document.activeElement?.getAttribute('aria-invalid')), 'true');
    await snapshot('rename-refused');
    await key('Escape');
    await wait(async () => (await cards()).map((card) => card.name).join() === 'Robot,Practice bot', 'Escape keeps the name');
    assert.equal((await focused()).cls, 'robot-card-pick');
    pass('Rename refuses a name another robot has, ignoring case, and Escape keeps the old name');

    await click('.robot-card-action[aria-label="Duplicate Practice bot"]');
    await wait(async () => (await selectedName()) === 'Practice bot 2', 'duplicated robot');
    assert.deepEqual((await cards()).map((card) => [card.name, card.selected]), [['Robot', false], ['Practice bot', false], ['Practice bot 2', true]]);
    assert.equal(await field('Drive reduction'), '16.00', 'The copy keeps the duplicated robot\'s details');
    await wait(async () => (await focused()).cls === 'robot-card-pick' && (await focused()).text.startsWith('Practice bot 2'), 'focus on the copy');
    await click('.robot-card-action[aria-label="Delete Practice bot 2"]');
    await click('.robot-card-confirm button', 'Delete');
    await wait(async () => (await cards()).length === 2, 'deleted the copy');
    pass('Duplicate copies any robot with its details and selects the copy');

    const cardHeights = () => evaluate(() => [...document.querySelectorAll('.robot-card[data-robot]')].map((card) => Math.round(card.getBoundingClientRect().height)));
    const heightsBefore = await cardHeights();
    await click('.robot-card-action[aria-label="Delete Practice bot"]');
    await wait(() => evaluate(() => document.activeElement?.textContent === 'Cancel'), 'delete confirmation');
    assert.deepEqual(await cardHeights(), heightsBefore, 'The delete confirmation keeps the card\'s size');
    await snapshot('remove-confirmation');
    await click('.robot-card-confirm button', 'Cancel');
    assert.equal((await cards()).length, 2);
    await click('.robot-card-pick', 'Practice botNo address');
    await wait(async () => (await selectedName()) === 'Practice bot', 'practice selected before delete');
    await click('.robot-card-action[aria-label="Delete Practice bot"]');
    await click('.robot-card-confirm button', 'Delete');
    await wait(async () => (await cards()).length === 1, 'removed robot');
    assert.deepEqual(await cards(), [{ name: 'Robot', summary: 'No address', selected: true, pressed: 'true' }]);
    assert.equal(await field('Drive reduction'), '5.50', 'Deleting the selected robot selects the one left');
    assert.equal(await evaluate(() => document.querySelector('.robot-card-action[aria-label="The last robot cannot be deleted"]')?.disabled), true, 'The last robot cannot be deleted');
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
    const connectionStatus = () => evaluate(() => document.querySelector('.robot-connection .settings-status')?.textContent);
    await wait(async () => (await connectionStatus())?.startsWith('10.24.68.2'), 'connection row names the selected robot');
    await click('.robot-card-pick', 'Practice bot10.24.68.3');
    await wait(() => used.length === 2, 'switching makes the other address active');
    assert.deepEqual(used.at(-1), practiceAddress);
    await wait(async () => (await connectionStatus())?.startsWith('10.24.68.3'), 'connection row follows the switch');
    await snapshot('robot-addresses');
    await click('.robot-card-pick', 'Comp bot10.24.68.2');
    await wait(() => used.length === 3, 'switching back makes the first address active again');
    assert.deepEqual(used.at(-1), comp);
    pass('Each robot shows its IP, and opening and switching make that robot\'s address active');

    // Each connection belongs to one robot: a new robot has none and clears the active one; Duplicate copies it.
    await click('.robot-card-new');
    await wait(() => evaluate(() => document.activeElement?.matches('.robot-card input[aria-label="Robot name"]')), 'new robot name field');
    await win.webContents.insertText('Spare bot'); await key('Enter');
    await wait(async () => (await selectedName()) === 'Spare bot', 'named new robot');
    assert.equal((await cards()).find((card) => card.name === 'Spare bot').summary, 'No address', 'A new robot starts without an address');
    await wait(() => used.length === 4, 'a robot without an address clears the active connection');
    assert.equal(used.at(-1), null);
    await wait(async () => (await connectionStatus()) === 'Not set up', 'connection row has nothing for the new robot');
    await click('.robot-card-action[aria-label="Duplicate Comp bot"]');
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
    await click('.robot-connection .settings-control button');
    await click('.robot-push-dialog button', 'Edit');
    await click('.robot-push-dialog button', 'Save');
    await wait(() => evaluate(() => !document.querySelector('.robot-push-dialog .rfp-fields input')), 'saved the computer connection');
    await key('Escape');
    await save();
    assert.equal(saved.robots, undefined, 'Saving a connection does not upgrade an unnamed single-robot project');

    await click('.robot-card-new');
    await wait(() => evaluate(() => document.activeElement?.matches('.robot-card input[aria-label="Robot name"]')), 'second robot name field');
    await key('Escape');
    await wait(async () => (await cards()).length === 2, 'second robot');
    assert.deepEqual((await cards()).map((card) => [card.name, card.summary]), [['Robot', '10.24.68.3'], ['New robot', 'No address']]);
    await save();
    assert.deepEqual(saved.robots.map((robot) => [robot.name, robot.connection]), [['Robot', practiceAddress], ['New robot', undefined]]);
    pass('An older project\'s robot keeps this computer\'s connection as its own address once a second robot exists');

    // With no list and no connection on this computer, the single robot's card id is all Duplicate has to go on.
    computerConnection = null;
    saved = { ...saved, robots: undefined, activeRobotId: undefined };
    await win.reload();
    await wait(() => evaluate(() => document.querySelectorAll('.pt-wp').length > 0), 'reloaded project without a list or connection');
    await robotPage();
    await hover('Robot');
    await click('.robot-card-action[aria-label="Duplicate Robot"]');
    await wait(async () => (await selectedName()) === 'Robot 2', 'duplicated the only robot');
    assert.deepEqual((await cards()).map((card) => [card.name, card.selected]), [['Robot', false], ['Robot 2', true]]);
    pass('Duplicate works on the only robot of an older project that has no connection');

    assert.deepEqual(errors, [], 'No renderer errors, confirm dialogs or robot calls');
    app.exit(0);
  } catch (error) {
    console.error(error);
    try { await fs.writeFile(path.join(output, 'failure.png'), (await capture()).toPNG()); } catch (_) {}
    app.exit(1);
  }
});
