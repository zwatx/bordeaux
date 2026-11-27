// The "Tags seen" path color in the built renderer, on a corpus path and a robot with two cameras.
//
// Ways this can fail, each checked below:
// - Tags seen is missing from the path color picker, or picking it leaves the path in the speed colors.
// - The path uses a color other than the three for no tags, one tag and two or more, or misses a stretch this path
//   has: it starts and ends with several tags in view and has a stretch with none.
// - The tags are not drawn unless the AprilTags layer is also on, or turning that layer on recolors the path.
// - A line to a single tag is missing, or is hidden under the path it runs along.
// - The playhead robot shows no camera wedges, or its sight lines go to the wrong tags. The tags read at the start
//   and the end of this path were computed apart from the app, from the planner and the visibility function.
// - The graph keeps plotting speed, or its hover readout shows a fraction of a tag.
// - A robot without cameras gets no hint, or still draws wedges and lines.
// - Going back to Velocity leaves tags, wedges or lines on the field.
// Screenshots at both supported sizes go to BORDEAUX_TAG_COVERAGE_UI_OUTPUT.
const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = process.env.BORDEAUX_BRANCH_UI_OUTPUT;
app.setPath('userData', path.join(output, 'user-data'));
let win, saved;
const errors = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true);
async function wait(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(75); } throw Error('Timed out: ' + label); }
// Real pointer input at the center of the first matching, unobscured control.
async function click(selector, text) {
  const point = await evaluate((selector, text) => {
    const item = [...document.querySelectorAll(selector)].find((el) => !text || el.textContent.trim() === text);
    if (!item || item.disabled) throw Error('Missing control: ' + selector + ' ' + (text || ''));
    const r = item.getBoundingClientRect(), x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    if (!item.contains(document.elementFromPoint(x, y))) throw Error('Obscured control: ' + selector + ' ' + text);
    return { x, y };
  }, selector, text);
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
  await delay(150);
}
async function key(keyCode) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  await delay(120);
}
async function pickColor(value) {
  await click('#field-overlay-metric');
  await click(`[role="option"][data-value="${value}"]`);
  await delay(200);
}
// Home and End on the timeline ruler move the playhead to the start and the end of the path.
async function seek(keyCode) {
  await evaluate(() => document.querySelector('.pt-ruler').focus());
  await key(keyCode);
}
const NONE = '#d2655f', ONE = '#cf962f', MANY = '#4bbf86';
const field = () => evaluate(() => {
  const strokes = [...document.querySelectorAll('.fieldsvg line[stroke-linecap="butt"]')].map((line) => line.getAttribute('stroke'));
  const sight = document.querySelector('.fieldsvg .field-tag-sight');
  return {
    strokes,
    tags: document.querySelectorAll('.fieldsvg .field-apriltag').length,
    sight: !!sight,
    wedges: document.querySelectorAll('.fieldsvg .field-tag-wedge').length,
    // The lines must come after the path in drawing order, or a line along the path is hidden under it.
    overPath: !!sight && !!(document.querySelector('.fieldsvg line[stroke-linecap="butt"]').compareDocumentPosition(sight) & Node.DOCUMENT_POSITION_FOLLOWING),
    lines: sight ? sight.querySelectorAll('.field-tag-sightline').length : 0,
    read: sight ? sight.dataset.tagsRead.split(' ').filter(Boolean).map(Number) : [],
    bright: sight ? [...sight.querySelectorAll('.field-apriltag-read')].map((tag) => Number(tag.dataset.tag)).sort((a, b) => a - b) : [],
    range: document.querySelector('.metric-range')?.textContent ?? null,
    graph: [...document.querySelectorAll('.pt-gutter')].map((gutter) => gutter.textContent).find((text) => /^(Seen|Speed)/.test(text)) ?? null,
  };
});
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
    await fs.writeFile(path.join(output, `${name}-${width}.png`), (await capture()).toPNG());
  }
  win.setContentSize(1440, 900); await delay(300);
}
const pass = (name) => console.log('PASS ' + name);
ipcMain.handle('branches:restore', () => ({ project: saved }));
ipcMain.handle('branches:catalog', () => ({ catalog: { projectName: 'Fixture', commands: [], warnings: [] }, bookmarkId: 'fixture' }));
ipcMain.handle('branches:save', (_event, project) => { saved = project; return { saved: true }; });
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

app.whenReady().then(async () => {
  try {
    const corpus = JSON.parse(await fs.readFile('benchmarks/planner-corpus/v3/corpus.bordeaux.json', 'utf8'));
    const first = structuredClone(corpus.paths.find((p) => p.id === 'corpus-blue-away-bump'));
    // The two cameras the expected tag sets below were computed for. Synthetic mounts, not a real robot.
    const cameras = [
      { id: 'camera_front', name: 'Front', horizontalFovDeg: 70, verticalFovDeg: 50, positionM: { x: 0.42, y: 0, z: 0.3 }, yawDeg: 0, pitchDeg: 15 },
      { id: 'camera_rear', name: 'Rear left', horizontalFovDeg: 82, verticalFovDeg: 56, positionM: { x: -0.35, y: 0.25, z: 0.45 }, yawDeg: 150, pitchDeg: 20 },
    ];
    const project = { ...corpus, paths: [first], pathLinks: [], routines: [], editor: { activePathId: first.id } };
    win = new BrowserWindow({ show: true, width: 1440, height: 900, useContentSize: true, webPreferences: { preload: path.join(__dirname, 'verify-command-branches-ui-preload.cjs'), sandbox: false, contextIsolation: true, backgroundThrottling: false } });
    win.webContents.on('console-message', (details) => { if (details.level === 'error' && !details.message.startsWith("Loading the font 'data:")) errors.push(details.message); });
    await open({ ...project, robot: { ...corpus.robot, cameras } });

    let shown = await field();
    assert.ok(shown.strokes.length > 20, 'the path is drawn');
    assert.ok(!shown.strokes.some((stroke) => [NONE, ONE, MANY].includes(stroke)), 'the path starts in the speed colors');
    assert.deepEqual([shown.tags, shown.sight], [0, false]);
    pass('A project opens with the path in its speed colors and no tags or sight lines');

    await pickColor('tags');
    await wait(async () => (await field()).sight, 'sight overlay');
    await seek('Home');
    shown = await field();
    assert.deepEqual([...new Set(shown.strokes)].sort(), [NONE, ONE, MANY].sort(), 'the path uses exactly the three tag colors');
    assert.equal(shown.strokes[0], MANY, 'the path starts with several tags in view');
    assert.equal(shown.strokes.at(-1), MANY, 'the path ends with several tags in view');
    const firstBlind = shown.strokes.indexOf(NONE), lastBlind = shown.strokes.lastIndexOf(NONE);
    assert.ok(firstBlind > 0 && shown.strokes.slice(firstBlind, lastBlind + 1).every((stroke) => stroke === NONE), 'one unbroken stretch has no tags');
    assert.equal(shown.tags, 32, 'the tags are drawn without the AprilTags layer');
    assert.deepEqual([shown.range, shown.graph], ['0–2+ tags', 'Seentags']);
    pass('Tags seen colors the path green, amber and red, draws the tags and plots the count');

    assert.deepEqual([shown.wedges, shown.read, shown.bright], [2, [21, 24, 25, 26], [21, 24, 25, 26]]);
    assert.ok(shown.lines >= 4, 'a line runs to each tag read');
    assert.equal(shown.overPath, true, 'sight lines are drawn over the path');
    // Every count of tags gets its lines: stepping along the path passes through one tag, none, and several.
    const counts = new Set();
    for (let step = 0; step < 20; step++) {
      const now = await field();
      assert.equal(now.lines >= now.read.length, true, `a line for each of ${now.read.length} tags`);
      assert.deepEqual(now.bright, now.read);
      counts.add(Math.min(2, now.read.length));
      await key('Right');
    }
    assert.deepEqual([...counts].sort(), [0, 1, 2], 'the path passes through no tags, one tag and several');
    await seek('End');
    await wait(async () => (await field()).read.join() === '1,32', 'tags read at the end of the path');
    await snapshot('tags-seen-end');
    await seek('Home');
    await wait(async () => (await field()).read.join() === '21,24,25,26', 'tags read at the start of the path');
    await snapshot('tags-seen-start');
    pass('The playhead robot shows both camera wedges and lines to the tags it reads at the start and the end');

    await pickColor('velocity');
    await wait(async () => !(await field()).sight, 'sight overlay removed');
    shown = await field();
    assert.deepEqual([shown.tags, shown.graph], [0, 'Speedm/s']);
    assert.ok(!shown.strokes.some((stroke) => [NONE, ONE, MANY].includes(stroke)));
    await key('T');
    await wait(async () => (await field()).tags === 32, 'AprilTags layer');
    shown = await field();
    assert.ok(!shown.sight && !shown.strokes.some((stroke) => [NONE, ONE, MANY].includes(stroke)), 'the AprilTags layer alone leaves the path and robot as they were');
    pass('Velocity removes the tags and sight lines, and the AprilTags layer alone does not recolor the path');

    await open({ ...project, robot: corpus.robot });
    await pickColor('tags');
    await wait(async () => (await field()).range === 'Add a camera on the Robot page', 'no camera hint');
    shown = await field();
    assert.deepEqual([[...new Set(shown.strokes)], shown.sight, shown.tags], [[NONE], false, 32]);
    await snapshot('no-cameras');
    pass('A robot without cameras reads no tags and is told where to add a camera');

    assert.deepEqual(errors, [], 'No renderer errors, confirm dialogs or robot calls');
    app.exit(0);
  } catch (error) {
    console.error(error);
    try { await fs.writeFile(path.join(output, 'failure.png'), (await capture()).toPNG()); } catch (_) {}
    app.exit(1);
  }
});
