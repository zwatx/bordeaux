// The Optimize panel's Heading tab in the built renderer: a search apart from the path searches, which keeps the curve
// and adds rotation targets so the robot's cameras read more tags.
//
// Ways this can fail, each checked below:
// - The Path tab changes: it must open first and read as it did before the tabs.
// - The Heading tab runs a search before anyone asks, or leaves the path in the speed colors.
// - The search reports numbers other than the planner's. For this path and robot, time with two tags goes from 0% to
//   44% and the path stays at 2.53 s with 2 rotation targets, computed apart from the app.
// - Choosing a preview row does not change the field: only the turned path has green stretches here.
// - Apply moves a waypoint or a handle, writes anything but the two targets, or cannot be undone as one step.
// - A second search on the applied path offers more headings.
// - Leaving the tab or closing the panel keeps the Tags seen colors that the tab turned on.
// - A changed camera leaves a result based on the old camera available.
// - Leaving the Heading tab lets its worker keep running or replace another tab's preview.
// - A robot without cameras, or a path that sets its heading everywhere, is offered a search.
// Screenshots at both supported sizes go to BORDEAUX_HEADING_SEARCH_UI_OUTPUT.
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
async function wait(fn, label) { for (let i = 0; i < 260; i++) { if (await fn()) return; await delay(75); } throw Error('Timed out: ' + label); }
// Real pointer input at the center of the first matching, unobscured control.
async function click(selector, text) {
  const point = await evaluate((selector, text) => {
    const item = [...document.querySelectorAll(selector)].find((el) => !text || el.textContent.trim() === text || el.textContent.trim().startsWith(text));
    if (!item || item.disabled) throw Error('Missing control: ' + selector + ' ' + (text || ''));
    const r = item.getBoundingClientRect(), x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    if (!item.contains(document.elementFromPoint(x, y))) throw Error('Obscured control: ' + selector + ' ' + text);
    return { x, y };
  }, selector, text);
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
  await delay(150);
}
const MANY = '#4bbf86', TAG_COLORS = ['#d2655f', '#cf962f', MANY];
// What the panel and the field show.
const shown = () => evaluate((colors) => {
  const panel = document.querySelector('.optimizer-panel');
  const strokes = [...document.querySelectorAll('.fieldsvg line[stroke-linecap="butt"]')].map((line) => line.getAttribute('stroke'));
  return {
    tabs: [...(panel?.querySelectorAll('[role="tab"]') ?? [])].map((tab) => tab.textContent + (tab.getAttribute('aria-selected') === 'true' ? '*' : '')),
    outcome: panel?.querySelector('.optimizer-outcome')?.textContent ?? null,
    rows: [...(panel?.querySelectorAll('.optimizer-choice') ?? [])].map((row) => [row.querySelector('.optimizer-choice-name').firstChild.textContent, row.querySelector('.optimizer-choice-name small')?.textContent ?? null,
      row.querySelector('b')?.textContent ?? null, row.getAttribute('aria-pressed') === 'true']),
    main: [panel?.querySelector('.optimizer-main')?.textContent ?? null, panel?.querySelector('.optimizer-main')?.disabled ?? null],
    color: document.querySelector('#field-overlay-metric')?.textContent.trim() ?? null,
    tagColors: strokes.length > 0 && strokes.every((stroke) => colors.includes(stroke)),
    green: strokes.filter((stroke) => stroke === colors[2]).length,
  };
}, TAG_COLORS);
async function save() { const before = saves; await click('.project-chip'); await click('[role="menuitem"][data-action="save"]'); await wait(() => saves > before, 'save'); }
async function capture() {
  for (let attempt = 0; attempt < 3; attempt++) {
    await delay(250);
    try { return await win.webContents.capturePage(); }
    catch (error) { if (attempt === 2 || !String(error).includes('UnknownVizError')) throw error; }
  }
}
async function snapshot(name) {
  for (const [width, height] of [[1440, 900], [1100, 720]]) {
    win.setContentSize(width, height); await delay(300);
    const clipped = await evaluate(() => [...document.querySelectorAll('.optimizer-panel :is(.optimizer-tab, .optimizer-main, .optimizer-choice)')].some((item) => item.scrollWidth > item.clientWidth + 1));
    assert.equal(clipped, false, `${name} at ${width}: a panel control is clipped`);
    await fs.writeFile(path.join(output, `${name}-${width}.png`), (await capture()).toPNG());
  }
  win.setContentSize(1440, 900); await delay(300);
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

async function open(project) {
  saved = project;
  await win.loadFile(path.resolve('dist-renderer/index.html'));
  win.focus(); win.webContents.focus();
  await wait(() => evaluate(() => document.querySelectorAll('.pt-wp').length > 0 && document.querySelector('.fieldcol')?.dataset.planningReady === 'true'), 'planned path');
  await delay(300);
}
async function headingTab() {
  await click('.optimizer-toggle');
  await wait(async () => (await shown()).tabs.length === 2, 'Optimize panel tabs');
  await click('.optimizer-tab', 'Heading');
  await wait(async () => (await shown()).tabs.join() === 'Path,Heading*', 'Heading tab');
}

// A diagonal across the neutral zone that turns a quarter turn, with free heading in between.
const DIAGONAL = {"headingMode":"targets","startVel":0,"goalVel":0,"constraints":{"maxVel":4.2,"maxAccel":6.5,"maxDecel":6.5,"maxAngVel":540,"maxAngAccel":720,"maxAngDecel":720,"maxJerk":0,"maxAngJerk":0},"id":"neutral-diagonal","name":"Neutral diagonal","targets":[],"markers":[],"ranges":[],"exportable":true,"waypoints":[{"linked":true,"thetaOn":true,"theta":180,"stop":false,"x":2.059,"y":2.8215,"segType":"bezier","prevC":{"x":2.6386,"y":3.6139},"nextC":{"x":1.4794,"y":2.0291}},{"linked":true,"thetaOn":false,"theta":0,"stop":false,"x":-0.011,"y":-0.0085,"segType":"bezier","prevC":{"x":1.165,"y":1.5875},"nextC":{"x":-1.187,"y":-1.6045}},{"linked":true,"thetaOn":true,"theta":270,"stop":false,"x":-2.141,"y":-2.8785,"segType":"bezier","prevC":{"x":-1.5446,"y":-2.0749},"nextC":{"x":-2.7374,"y":-3.6821}}]};

app.whenReady().then(async () => {
  try {
    const corpus = JSON.parse(await fs.readFile('benchmarks/planner-corpus/v3/corpus.bordeaux.json', 'utf8'));
    // Front and rear cameras that read to 3 m. Synthetic mounts, not a real robot.
    const camera = (id, yawDeg, x) => ({ id, name: id, horizontalFovDeg: 70, verticalFovDeg: 50, positionM: { x, y: 0, z: 0.3 }, yawDeg, pitchDeg: 15, maxRangeM: 3 });
    const cameras = [camera('Front', 0, 0.4), camera('Rear', 180, -0.4)];
    const project = (drawn, robot) => ({ ...corpus, robot, paths: [drawn], pathLinks: [], routines: [], editor: { activePathId: drawn.id } });
    win = new BrowserWindow({ show: true, width: 1440, height: 900, useContentSize: true, webPreferences: { preload: path.join(__dirname, 'verify-command-branches-ui-preload.cjs'), sandbox: false, contextIsolation: true, backgroundThrottling: false } });
    win.webContents.on('console-message', (details) => { if (details.level === 'error' && !details.message.startsWith("Loading the font 'data:")) errors.push(details.message); });
    await open(project(DIAGONAL, { ...corpus.robot, cameras }));
    // The path as the editor holds it after loading, which fills in defaults the fixture leaves out.
    await save();
    const loaded = structuredClone(saved.paths[0]);
    assert.deepEqual(loaded.targets, []);

    await click('.optimizer-toggle');
    await wait(async () => (await shown()).tabs.length === 2, 'Optimize panel tabs');
    let now = await shown();
    assert.deepEqual([now.tabs, now.outcome, now.main, now.color, now.tagColors], [['Path*', 'Heading'], 'Find a faster route', ['Optimize', false], 'Velocity', false]);
    assert.deepEqual(now.rows.map((row) => row[0]), ['Current path']);
    pass('Optimize opens on the Path tab, which reads as it did before');

    await click('.optimizer-tab', 'Heading');
    await wait(async () => (await shown()).color === 'Tags seen', 'Tags seen colors on the Heading tab');
    now = await shown();
    assert.deepEqual([now.tabs, now.outcome, now.rows, now.main, now.tagColors], [['Path', 'Heading*'], 'Read more tags', [], ['Find headings', false], true]);
    assert.equal(now.green, 0, 'the drawn path has no stretch with two tags');
    await snapshot('heading-before');
    pass('The Heading tab waits for Find headings and shows the path in the Tags seen colors');

    await click('.optimizer-main');
    await wait(async () => (await shown()).rows.length === 2, 'heading result');
    now = await shown();
    assert.equal(now.outcome, 'Less time with poor tag coverage');
    assert.deepEqual(now.rows, [['Current headings', '2.53 s', '0%', false], ['Turned for tags', '2.53 s, 2 rotation targets added', '44%', true]]);
    assert.deepEqual(now.main, ['Apply headings', false]);
    assert.ok(now.tagColors && now.green > 10, 'the turned path is previewed with green stretches');
    await snapshot('heading-result');
    await click('.optimizer-choice', 'Current headings');
    await wait(async () => (await shown()).green === 0, 'preview of the current headings');
    assert.deepEqual((await shown()).rows.map((row) => row[3]), [true, false]);
    await click('.optimizer-choice', 'Turned for tags');
    await wait(async () => (await shown()).green > 10, 'preview of the turned path');
    pass('Find headings reports the planner\'s numbers, and each row previews its own headings on the field');

    await click('.optimizer-main');
    await wait(async () => (await shown()).outcome === 'Headings added to the path', 'applied headings');
    await save();
    const applied = saved.paths[0];
    assert.deepEqual(applied.targets, [{ f: 0.0769, deg: 167 }, { f: 0.9231, deg: -106 }]);
    assert.deepEqual({ ...applied, targets: [] }, loaded, 'Apply changes nothing on the path but its rotation targets');
    await wait(async () => (await shown()).green > 10, 'the applied path keeps its green stretches');
    await click('.optimizer-main');
    await wait(async () => (await shown()).outcome === 'No headings found that read more tags', 'second search finds nothing');
    assert.deepEqual((await shown()).rows, []);
    pass('Apply writes only the two rotation targets, and a second search finds nothing more');

    await click('.iconbtn[aria-label="Undo"]');
    await wait(async () => (await shown()).green === 0, 'undo restores the drawn headings');
    await save();
    assert.deepEqual(saved.paths[0], loaded, 'One undo puts the path back exactly');
    pass('One undo removes the added rotation targets');

    await click('.optimizer-tab', 'Path');
    await wait(async () => (await shown()).color === 'Velocity', 'the earlier path color returns on the Path tab');
    await click('.optimizer-tab', 'Heading');
    await wait(async () => (await shown()).color === 'Tags seen', 'Tags seen again');
    await click('.optimizer-main');
    await wait(async () => (await shown()).rows.length === 2, 'result before camera edit');
    await click('.places .place', 'Robot');
    const range = 'input[aria-label="Camera max range"]';
    await wait(() => evaluate((selector) => Boolean(document.querySelector(selector)), range), 'camera range input');
    await evaluate((selector) => document.querySelector(selector).scrollIntoView({ block: 'center' }), range);
    await click(range);
    await evaluate(() => document.activeElement.select());
    await win.webContents.insertText('0.5');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await click('.places .place', 'Paths');
    await wait(async () => (await shown()).main[0] === 'Find headings', 'camera edit retires the heading result');
    assert.deepEqual((await shown()).rows, [], 'The result computed with the old camera is no longer offered');
    pass('Editing a camera retires the heading preview and its Apply action');

    // Hold only the Heading worker's command until a tab change. Keep all normal planning calls live.
    await evaluate(() => {
      const { postMessage, terminate } = Worker.prototype;
      let held;
      Worker.prototype.postMessage = function (job, ...rest) {
        if (job?.mode === 'headingForTags') { held = this; return; }
        return postMessage.call(this, job, ...rest);
      };
      Worker.prototype.terminate = function () {
        if (this === held) window.headingWorkerTerminated = true;
        return terminate.call(this);
      };
      window.restoreHeadingWorkerFixture = () => { Object.assign(Worker.prototype, { postMessage, terminate }); };
    });
    await click('.optimizer-main');
    await wait(async () => (await shown()).outcome === 'Finding headings', 'heading search is pending');
    await click('.optimizer-tab', 'Path');
    await wait(() => evaluate(() => window.headingWorkerTerminated === true), 'obsolete heading worker terminates');
    await evaluate(() => window.restoreHeadingWorkerFixture());
    await click('.optimizer-tab', 'Heading');
    await wait(async () => (await shown()).main[0] === 'Find headings' && (await shown()).main[1] === false, 'return to an idle heading search');
    pass('Switching tabs cancels an in-flight heading search');

    await click('.optimizer-toggle');
    await wait(async () => (await shown()).color === 'Velocity' && (await shown()).tabs.length === 0, 'the earlier path color returns when the panel closes');
    assert.equal((await shown()).tagColors, false);
    pass('Leaving the Heading tab or closing the panel puts back the earlier path color');

    await open(project(DIAGONAL, corpus.robot));
    await headingTab();
    now = await shown();
    assert.deepEqual([now.outcome, now.main], ['Add a camera on the Robot page', ['Find headings', true]]);
    await open(project({ ...DIAGONAL, headingMode: 'tangent' }, { ...corpus.robot, cameras }));
    await headingTab();
    now = await shown();
    assert.deepEqual([now.outcome, now.main], ['This path sets its heading everywhere', ['Find headings', true]]);
    await snapshot('heading-blocked');
    pass('A robot without cameras, or a path with no free heading, is told why and offered no search');

    assert.deepEqual(errors, [], 'No renderer errors, confirm dialogs or robot calls');
    app.exit(0);
  } catch (error) {
    console.error(error);
    try { console.error('STATE', JSON.stringify(await shown())); await fs.writeFile(path.join(output, 'failure.png'), (await capture()).toPNG()); } catch (_) {}
    app.exit(1);
  }
});
