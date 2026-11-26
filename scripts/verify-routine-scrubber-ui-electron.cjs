// Built-App check for the routine transport scrubber, the routine path chooser and the routine flow layout.
// Uses the mocked branches preload and a local catalog: no NI, no robot transport, nothing executes.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = process.env.BORDEAUX_ROUTINE_SCRUBBER_UI_OUTPUT;
const baselineOnly = Boolean(process.env.BORDEAUX_ROUTINE_SCRUBBER_BASELINE);
app.setPath('userData', path.join(output, 'user-data'));
let win, saved, published, saves = 0;
const errors = [], robotCalls = [], passed = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true);
// Display units are this machine's app preference in local storage; the next page load applies them.
// Before the first load there is no app page to write to, and a fresh profile is already metric.
async function setUnits(units) {
  if (!win?.webContents.getURL().startsWith('file:')) return assert.equal(units, 'metric', 'a fresh profile starts metric');
  await evaluate((units) => localStorage.setItem('bordeaux.unitSystem', units), units);
}
async function wait(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(75); } throw Error('Timed out: ' + label); }
async function focusWindow() {
  app.focus({ steal: true }); win.focus(); win.webContents.focus();
  await wait(() => evaluate(() => document.hasFocus()), 'renderer keyboard focus');
}
async function pointOf(selector, text) {
  await wait(() => evaluate((selector, text) => {
    const item = [...document.querySelectorAll(selector)].find((el) => el.getClientRects().length && (!text || el.textContent.trim() === text));
    return !!item && !item.disabled && !item.closest('[inert]');
  }, selector, text), 'enabled control: ' + selector + (text ? ' ' + text : ''));
  return evaluate((selector, text) => {
    const item = [...document.querySelectorAll(selector)].find((el) => el.getClientRects().length && (!text || el.textContent.trim() === text));
    item.scrollIntoView({ block: 'nearest' });
    const r = item.getBoundingClientRect(), x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    if (!item.contains(document.elementFromPoint(x, y))) throw Error('Obscured control: ' + selector + ' ' + text);
    return { x, y, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
  }, selector, text);
}
async function click(selector, text) {
  await focusWindow();
  const point = await pointOf(selector, text);
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, modifiers: [], x: point.x, y: point.y });
  await delay(200);
}
async function mouse(type, x, y, buttons = true) {
  win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, modifiers: buttons && type === 'mouseMove' ? ['leftButtonDown'] : [] });
  await delay(40);
}
async function key(keyCode, modifiers = []) {
  await focusWindow();
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  const char = { Space: ' ', Enter: '\r' }[keyCode];
  if (char && !modifiers.length) win.webContents.sendInputEvent({ type: 'char', keyCode: char, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await delay(90);
}
async function type(text) { await focusWindow(); await win.webContents.insertText(text); await delay(150); }
async function snapshot(name) {
  await evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await fs.writeFile(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
}
const pass = (label) => { passed.push(label); console.log('PASS ' + label); };

const catalog = { runtime: 'labview', authoritative: true, generatedSchemaVersion: '1.3', projectName: 'Routine scrubber fixture',
  sourceFileCount: 1, scannedAt: '', warnings: [],
  commands: [{ id: 'intake', label: 'Run the intake until a game piece is seated', member: 'Intake.vi', parameters: [], labviewConnector: {}, outputs: [] },
    { id: 'feed', label: 'Feed note', member: 'Feed.vi', parameters: [], labviewConnector: {}, outputs: [] }],
  conditions: [{ id: 'piece', label: 'Enough game pieces collected', description: 'Illustrative registered condition.' }],
  builtIns: [{ id: 'bordeaux.wait', kind: 'wait' }] };
ipcMain.handle('branches:restore', () => ({ project: saved }));
ipcMain.handle('branches:catalog', () => ({ catalog, bookmarkId: 'fixture' }));
ipcMain.on('branches:published', (_event, project) => { published = structuredClone(project); });
ipcMain.on('branches:confirm', () => {});
ipcMain.handle('branches:robot-call', (_event, name) => { robotCalls.push(name); throw Error('Unexpected robot operation: ' + name); });
ipcMain.handle('branches:save', (_event, project) => { saved = structuredClone(project); saves++; return { saved: true }; });
async function save() { const before = saves; await click('.project-chip'); await click('[role="menuitem"][data-action="save"]'); await wait(() => saves > before, 'save'); }
async function source() { await wait(() => Boolean(published?.routines), 'published routines'); return structuredClone(published.routines); }

const ROUTINE = 'scrub-routine';
const command = (id, title, extra = {}) => ({ id, type: 'function', cat: 'command', title, invocation: { commandId: 'intake', arguments: {}, ...extra } });
async function load(routineId = ROUTINE, expect = '[data-id="leave"]') {
  published = undefined;
  await win.loadFile(path.resolve('dist-renderer/index.html'));
  await focusWindow();
  await wait(() => evaluate(() => Boolean(document.querySelector('.places .place'))), 'editor ready');
  await click('.places .place', 'Routines');
  await click(`[data-library-item="${routineId}"]`);
  await wait(() => evaluate((s) => Boolean(document.querySelector(s)), expect), 'routine flow ' + routineId);
}
async function planned() {
  await wait(() => evaluate(() => !document.querySelector('.routine-status.planning')
    && ![...document.querySelectorAll('.rt-step-meta')].some((el) => el.textContent.includes('Preparing preview'))), 'routine planning settled');
  await evaluate(() => document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
}

app.whenReady().then(async () => {
  try {
    const corpus = JSON.parse(await fs.readFile('benchmarks/planner-corpus/v3/corpus.bordeaux.json', 'utf8'));
    const pick = (id, name, folderId) => ({ ...structuredClone(corpus.paths.find((p) => p.id === id)), name, ...(folderId ? { folderId } : {}) });
    const paths = [
      pick('corpus-neutral-stop', 'Collect along the alliance wall and return through the protected crossing', 'f-collect'),
      pick('corpus-blue-table-trench', 'Score from the trench', 'f-score'),
      pick('corpus-blue-away-bump', 'Cross the bump to the far side', 'f-score'),
      pick('corpus-neutral-slalom', 'Slalom warm-up'),
    ];
    const [wall, trench, bump] = paths.map((p) => p.id);
    const routines = [
      { id: ROUTINE, name: 'Leave, collect twice, choose a scoring route, then hold', nodes: [
        { id: 'leave', type: 'path', ref: wall },
        { id: 'settle', type: 'builtin', builtinId: 'bordeaux.wait', arguments: { durationS: 0.75 } },
        { id: 'intake', type: 'function', cat: 'command', title: 'Run the intake until a game piece is seated', invocation: { commandId: 'intake', arguments: {} } },
        { id: 'cycle', type: 'repeat', times: 2, nodes: [{ id: 'cycle-path', type: 'path', ref: trench }] },
        { id: 'choice', type: 'decision', cond: 'piece', thenLabel: 'Full — cross to score', elseLabel: 'Keep holding',
          then: [{ id: 'score', type: 'path', ref: bump }], else: [{ id: 'hold', type: 'builtin', builtinId: 'bordeaux.wait', arguments: { durationS: 1 } }] },
      ] },
      { id: 'untimed-routine', name: 'Only an untimed command', nodes: [
        { id: 'only-command', type: 'function', cat: 'command', title: 'Run the intake until a game piece is seated', invocation: { commandId: 'intake', arguments: {} } }] },
      { id: 'missing-routine', name: 'Uses a deleted path', nodes: [{ id: 'missing', type: 'path', ref: 'deleted-path' }] },
      { id: 'empty-routine', name: 'Nothing yet', nodes: [] },
      // Feed note has a 0.8 s run time on the Robot page; the intake has none.
      { id: 'estimate-routine', name: 'Run time estimates', nodes: [
        { id: 'e-leave', type: 'path', ref: wall },
        { id: 'e-feed', type: 'function', cat: 'command', title: 'Feed note', invocation: { commandId: 'feed', arguments: {} } },
        { id: 'e-loop', type: 'function', cat: 'command', title: 'Feed note', invocation: { commandId: 'feed', arguments: {}, loop: { until: { kind: 'time', seconds: 2 } } } },
        { id: 'e-capped', type: 'function', cat: 'command', title: 'Feed note', invocation: { commandId: 'feed', arguments: {} }, ends: { timeoutS: 0.5, onTimeout: 'continue' } },
        { id: 'e-par', type: 'group', mode: 'parallel', nodes: [
          { id: 'e-par-feed', type: 'function', cat: 'command', title: 'Feed note', invocation: { commandId: 'feed', arguments: {} } },
          { id: 'e-par-wait', type: 'builtin', builtinId: 'bordeaux.wait', arguments: { durationS: 0.5 } }] },
        command('e-untimed', 'Run the intake until a game piece is seated'),
      ] },
      // Groups, loops and instant commands for the scrubber's rows and chips.
      { id: 'groups-routine', name: 'Groups and loops', nodes: [
        { id: 'g-leave', type: 'path', ref: wall },
        { id: 'g-par', type: 'group', mode: 'parallel', nodes: [
          command('g-spin', 'Spin up the shooter', { loop: { until: { kind: 'time', seconds: 1.5 } } }),
          { id: 'g-wait', type: 'builtin', builtinId: 'bordeaux.wait', arguments: { durationS: 1 } },
          command('g-lights', 'Lights on')] },
        command('g-aim', 'Aim at the goal'), command('g-feed', 'Feed note'), command('g-stow', 'Arm stow'),
        { id: 'g-seq', type: 'group', mode: 'sequential', nodes: [
          { id: 'g-settle', type: 'builtin', builtinId: 'bordeaux.wait', arguments: { durationS: 0.5 } },
          command('g-intake', 'Run the intake until a game piece is seated', { loop: { until: { kind: 'time', seconds: 0.8 } } })] },
        { id: 'g-score', type: 'path', ref: trench },
        command('g-end', 'Celebrate with every light on the robot'),
      ] },
    ];
    saved = { ...corpus, schemaVersion: '1.1', robot: { ...corpus.robot, driveModel: { commandLoads: [{ commandId: 'feed', currentA: 10, runTimeS: 0.8 }] } }, paths, pathFolders: [{ id: 'f-collect', name: 'Collection' }, { id: 'f-score', name: 'Scoring' }], pathLinks: [], routines, activeRoutineId: ROUTINE,
      editor: { activePathId: wall, robotProjectBookmarkId: 'fixture' } };
    win = new BrowserWindow({ show: true, width: 1440, height: 900, useContentSize: true,
      webPreferences: { preload: path.join(__dirname, 'verify-command-branches-ui-preload.cjs'), sandbox: false, contextIsolation: true, backgroundThrottling: false } });
    win.webContents.on('console-message', (details) => { if (details.level === 'error' && !details.message.startsWith("Loading the font 'data:")) errors.push(details.message); });

    if (baselineOnly) {
      for (const [width, height] of [[1440, 900], [1100, 720]]) {
        win.setContentSize(width, height);
        await load(); await planned();
        await snapshot('baseline-flow-' + width);
        await click('[data-id="leave"] .rt-step-body'); await delay(300);
        await snapshot('baseline-path-inspector-' + width);
        await click('.rt-addwrap .rt-add'); await delay(300);
        await snapshot('baseline-add-slot-' + width);
        await key('Escape');
      }
      app.exit(0); return;
    }
    const slider = '.rt-tp-scrub';
    const sliderState = () => evaluate((s) => { const el = document.querySelector(s); return el && { now: Number(el.getAttribute('aria-valuenow')), max: Number(el.getAttribute('aria-valuemax')), text: el.getAttribute('aria-valuetext'), disabled: el.getAttribute('aria-disabled'), tab: el.tabIndex, focused: document.activeElement === el }; }, slider);
    const lane = () => evaluate(() => { const r = document.querySelector('.rt-timeline-editor').getBoundingClientRect(); return { left: r.left + 10, width: r.width - 20, y: r.top + 30 }; });
    const near = (a, b, tolerance, label) => assert.ok(Math.abs(a - b) <= tolerance, label + ': ' + a + ' vs ' + b);
    const isPaused = () => evaluate(() => Boolean(document.querySelector('[aria-label="Play routine"]')));
    const routineNode = async (id) => {
      const routines = await source(); let hit = null;
      const walk = (nodes) => nodes.forEach((n) => { if (n.id === id) hit = n; ['nodes', 'then', 'else'].forEach((k) => Array.isArray(n[k]) && walk(n[k])); });
      routines.forEach((r) => walk(r.nodes)); return hit;
    };
    const waitRef = (id, ref, label) => wait(async () => (await routineNode(id))?.ref === ref, label);
    // Path rows in the left-rail path library, which Change path and Add both open.
    const option = '#rt-source [data-row^="path:"] .rt-src-name';
    const row = (id) => '#rt-source [data-row="path:' + id + '"]';

    for (const [width, height, units] of [[1440, 900, 'metric'], [1100, 720, 'imperial']]) {
      win.setContentSize(width, height); await setUnits(units);
      await load(); await planned();
      await snapshot('flow-closed-' + width);

      // Scrubber: the scale, the handle and its accessible state.
      const idle = await sliderState();
      assert.equal(idle.now, 0); assert.ok(idle.max > 5, 'timed total'); assert.equal(idle.disabled, null); assert.equal(idle.tab, 0);
      const scale = await evaluate(() => ({ ticks: [...document.querySelectorAll('.rt-timeline-tick')].map((t) => t.textContent),
        knob: getComputedStyle(document.querySelector('.rt-timeline-playhead'), '::before').width, step: document.querySelector('.rt-timeline-step').textContent }));
      assert.ok(scale.ticks.length >= 4 && scale.ticks[0] === '0', 'seconds scale: ' + scale.ticks.join(' '));
      assert.equal(scale.knob, '12px', 'visible playhead handle'); assert.equal(scale.step, '5 steps', 'idle run size counts the flow rows');

      // Tab from Play reaches the scrubber with a visible ring (as the workflow harness expects).
      await evaluate(() => document.querySelector('button[aria-label="Play routine"]').focus());
      await key('Tab');
      assert.equal((await sliderState()).focused, true, 'Tab from Play reaches the scrubber');
      assert.equal(await evaluate(() => getComputedStyle(document.querySelector('.rt-timeline-editor')).outlineStyle), 'solid');

      // Pointer press seeks there and pauses; the step playing there is named.
      let geometry = await lane();
      await focusWindow();
      await mouse('mouseDown', geometry.left + geometry.width * 0.4, geometry.y, false); await mouse('mouseUp', geometry.left + geometry.width * 0.4, geometry.y, false);
      const pressed = await sliderState();
      near(pressed.now, idle.max * 0.4, idle.max * 0.02, 'press seeks to 40%'); assert.equal(pressed.focused, true, 'press focuses the slider');
      assert.ok(await isPaused(), 'seeking leaves playback paused');
      const nowName = await evaluate(() => document.querySelector('.rt-timeline-now')?.textContent || '');
      assert.ok(nowName.length > 0 && pressed.text.includes(nowName), 'current step named in toolbar and value text: ' + pressed.text);
      assert.equal(await evaluate(() => document.querySelectorAll('.rt-timeline-span.on').length <= 1), true);

      // Hover reads a time without seeking.
      await mouse('mouseMove', geometry.left + geometry.width * 0.7, geometry.y, false);
      await wait(() => evaluate(() => Boolean(document.querySelector('.rt-timeline-readout'))), 'hover readout');
      const hoverText = await evaluate(() => document.querySelector('.rt-timeline-readout').textContent);
      assert.match(hoverText, /^\d+\.\d\d s/, 'hover time: ' + hoverText);
      near((await sliderState()).now, pressed.now, 0.011, 'hover does not seek');
      await snapshot('scrub-hover-' + width);

      // Drag the handle: continuous seeking with a dragged-time readout, ending where released.
      geometry = await lane();
      await mouse('mouseDown', geometry.left + geometry.width * 0.4, geometry.y, false);
      for (const f of [0.5, 0.65, 0.8]) await mouse('mouseMove', geometry.left + geometry.width * f, geometry.y);
      assert.equal(await evaluate(() => document.querySelector('.rt-timeline-editor').classList.contains('dragging')), true, 'dragging state');
      near((await sliderState()).now, idle.max * 0.8, idle.max * 0.02, 'drag follows the pointer');
      await snapshot('scrub-drag-' + width);
      await mouse('mouseUp', geometry.left + geometry.width * 0.8, geometry.y, false);
      assert.equal(await evaluate(() => document.querySelector('.rt-timeline-editor').classList.contains('dragging')), false);
      near((await sliderState()).now, idle.max * 0.8, idle.max * 0.02, 'release keeps the dragged time');
      // Park the pointer on empty library space: an open hover tooltip (a popover) withholds playback Space.
      await mouse('mouseMove', 120, height - 80, false); await wait(() => evaluate(() => !document.querySelector('[popover]:popover-open')), 'no open tooltip');

      // Keyboard seeking.
      await key('Home'); assert.equal((await sliderState()).now, 0);
      await key('Right'); near((await sliderState()).now, 0.1, 0.001, 'Arrow steps 0.1 s');
      await key('Right', ['shift']); near((await sliderState()).now, 1.1, 0.001, 'Shift+Arrow steps 1 s');
      await key('PageDown'); const nextStart = (await sliderState()).now; assert.ok(nextStart > 1.1, 'Page Down moves to the next step start');
      await key('PageUp'); assert.ok((await sliderState()).now < nextStart, 'Page Up moves back to a step start');
      await key('End'); near((await sliderState()).now, idle.max, 0.011, 'End');
      await key('Home');
      await key('Space'); await wait(async () => !(await isPaused()), 'Space plays from the scrubber');
      await key('Space'); await wait(isPaused, 'Space pauses');
      await key('Home'); await key('PageDown'); await key('PageDown'); await key('PageDown');
      await snapshot('scrub-keyboard-' + width);

      // The field above the flow shows the scrubbed pose over the same transport.
      await snapshot('field-scrubbed-' + width);

      // Path chooser: the current path reads as a card with the context its flow row lacks (its folder; reuse only
      // when the path repeats), not the row's time or a plain "In this routine".
      await click('[data-id="leave"] .rt-step-body');
      await wait(() => evaluate(() => Boolean(document.querySelector('.routine-insp .choice-current'))), 'path card');
      const card = await evaluate(() => document.querySelector('.routine-insp .choice-current').textContent);
      assert.ok(card.includes('Collect along the alliance wall') && card.includes('Collection') && !card.includes('In this routine') && !/\d s\b/.test(card), 'card: ' + card);
      await snapshot('path-card-' + width);
      // Keyboard: Change path opens the path library in the left rail; search by folder, choose with arrows and Enter;
      // focus returns to Change.
      await click('.routine-change-path', 'Change path');
      await wait(() => evaluate(() => document.activeElement?.matches('#rt-source.replace input')), 'Change opens the path library search');
      assert.ok(await evaluate(() => document.querySelector('[data-id="leave"]').classList.contains('replacing')), 'The changing step is marked in the flow');
      await type('scoring');
      assert.deepEqual(await evaluate((s) => [...document.querySelectorAll(s)].map((el) => el.textContent), option), ['Score from the trench', 'Cross the bump to the far side']);
      await snapshot('path-search-' + width);
      await key('Down'); await key('Down'); await key('Enter');
      await waitRef('leave', bump, 'keyboard path choice');
      await wait(() => evaluate(() => document.activeElement.classList.contains('routine-change-path')), 'focus returns to Change');
      await click('[aria-label="Undo"]'); await waitRef('leave', wall, 'Undo path choice');
      // Undo keeps the step selected, and its inspector shows the restored path.
      await wait(() => evaluate((name) => document.querySelector('.routine-insp .choice-current')?.textContent.startsWith(name), paths[0].name), 'Undo keeps the step and shows its restored path');
      assert.equal(await evaluate(() => document.querySelector('[data-id="leave"] .rt-step-body').getAttribute('aria-pressed')), 'true', 'Undo keeps the step selected');
      // Pointer: the library marks the current path; Escape keeps it; a click chooses another.
      await click('.routine-change-path', 'Change path');
      await wait(() => evaluate(() => Boolean(document.querySelector('#rt-source.replace'))), 'path library');
      assert.equal(await evaluate(() => document.querySelector('#rt-source [aria-current="true"] .rt-src-name').textContent), paths[0].name, 'current choice is marked');
      await key('Escape');
      await wait(() => evaluate(() => Boolean(document.querySelector('.routine-insp .choice-current')) && !document.querySelector('#rt-source')), 'Escape keeps the current path');
      await click('.routine-change-path', 'Change path');
      await click(option, 'Slalom warm-up');
      await waitRef('leave', paths[3].id, 'pointer path choice');
      await snapshot('path-chosen-' + width);
      await click('[aria-label="Undo"]'); await waitRef('leave', wall, 'Undo pointer choice');

      // Add: the path library groups paths by folder with time and use here, and is searchable.
      await click('.rt-list>.rt-addwrap .rt-add');
      await wait(() => evaluate(() => Boolean(document.querySelector('#rt-source.path'))), 'path library');
      const trenchRow = await evaluate(() => {
        const rows = [...document.querySelectorAll('#rt-source [data-row], #rt-source .rt-src-label')], at = rows.findIndex((el) => el.textContent.includes('Score from the trench'));
        return { text: rows[at]?.textContent, folder: rows.slice(0, at).reverse().find((el) => el.dataset.group)?.textContent };
      });
      assert.ok(trenchRow.text?.includes('In this routine') && trenchRow.folder?.startsWith('Scoring'), 'add path context: ' + JSON.stringify(trenchRow));
      await snapshot('add-paths-' + width);
      await key('Tab'); await type('warm'); await key('Enter');
      await wait(async () => { const nodes = (await source())[0].nodes; return nodes.length === 6 && nodes[5].ref === paths[3].id; }, 'added path step');
      await click('[aria-label="Undo"]'); await wait(async () => (await source())[0].nodes.length === 5, 'Undo add');

      // Inspector open and closed with the transport.
      await click('[data-id="choice"] .rt-step-body'); await snapshot('flow-open-' + width);
      await click('[aria-label="Close step inspector"]'); await snapshot('flow-closed-after-' + width);
    }
    pass('Scrubber scale, handle, press/hover/drag, keyboard (Arrow, Shift, Page, Home/End, Space), path card/search/choose/Undo and Add context at 1440x900 metric and 1100x720 imperial');

    // Save and reopen a chosen path.
    win.setContentSize(1440, 900); await setUnits('metric');
    await load(); await planned();
    await click('[data-id="leave"] .rt-step-body');
    await click('.routine-change-path', 'Change path'); await type('trench'); await key('Down'); await key('Enter');
    await waitRef('leave', trench, 'choose trench');
    await save(); await load(); await planned();
    await click('[data-id="leave"] .rt-step-body');
    assert.ok((await evaluate(() => document.querySelector('.routine-insp .choice-current').textContent)).startsWith('Score from the trench'), 'chosen path survives save and reopen');
    pass('Chosen path survives save and reopen');

    // Deleted path: no card; the problem is stated beside Choose a path, which opens the library, and a choice repairs it.
    await load('missing-routine', '[data-id="missing"]');
    await click('[data-id="missing"] .rt-step-body');
    await wait(() => evaluate(() => Boolean(document.querySelector('.routine-insp .routine-change-path'))), 'missing path recovery');
    assert.equal(await evaluate(() => Boolean(document.querySelector('.routine-insp .choice-current'))), false);
    assert.ok(await evaluate(() => document.querySelector('.routine-insp').textContent.includes('unavailable')), 'missing path problem stated');
    await snapshot('missing-path-1440');
    await click('.routine-change-path', 'Choose a path');
    await wait(() => evaluate(() => Boolean(document.querySelector('#rt-source.replace'))), 'library for a missing path');
    await click(option, 'Slalom warm-up');
    await waitRef('missing', paths[3].id, 'repair missing path');
    // The Choose a path button is replaced by the repaired path's card; focus moves to its Change path.
    await wait(() => evaluate(() => document.activeElement?.matches('.routine-insp .routine-change-path')), 'focus on Change path after repair');
    await snapshot('missing-repaired-1440');
    pass('Deleted path states its problem and is repaired by a choice from the path library');

    // Groups and loops: overlapping steps stack in rows inside their group's outline, loops show their glyph, instant
    // commands are chips that never overlap or leave the lane (the last faces left), and every step playing is lit.
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height);
      await load('groups-routine', '[data-id="g-leave"]'); await planned();
      const laneState = () => evaluate(() => {
        const editor = document.querySelector('.rt-timeline-editor').getBoundingClientRect();
        const box = (el) => { const r = el.getBoundingClientRect(); return { x0: r.left, x1: r.right, y0: r.top, y1: r.bottom, text: el.textContent, title: el.title, cls: el.className }; };
        return { editor: { x0: editor.left, x1: editor.right, y0: editor.top, y1: editor.bottom },
          blocks: [...document.querySelectorAll('.rt-timeline-span')].map(box), chips: [...document.querySelectorAll('.rt-timeline-chip')].map(box),
          groups: [...document.querySelectorAll('.rt-timeline-group')].map(box) };
      });
      const state = await laneState();
      const inside = (b) => b.x0 >= state.editor.x0 - 0.5 && b.x1 <= state.editor.x1 + 0.5 && b.y0 >= state.editor.y0 - 0.5 && b.y1 <= state.editor.y1 + 0.5;
      const overlap = (a, b) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.5 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0.5;
      for (const item of [...state.blocks, ...state.chips]) assert.ok(inside(item), 'inside the scrubber: ' + (item.title || item.text));
      for (const list of [state.blocks, state.chips]) for (const a of list) for (const b of list) if (a !== b) assert.ok(!overlap(a, b), 'no overlap: ' + a.title + ' / ' + b.title);
      assert.equal(state.groups.length, 2, 'both groups outlined');
      const rows = new Set(state.blocks.map((b) => Math.round(b.y0)));
      assert.ok(rows.size >= 2, 'parallel steps stack in rows');
      assert.ok(state.blocks.some((b) => b.cls.includes('rt-timeline-span') && b.text.startsWith('Collect along')), 'path block named');
      assert.ok(state.blocks.some((b) => /Spin up the shooter, loops for 1\.50 s/.test(b.title)), 'time loop block');
      assert.ok(state.chips.length >= 2, 'instant commands as chips');
      const last = state.chips.reduce((a, b) => (b.x1 > a.x1 ? b : a));
      assert.ok(last.cls.includes('left') && /Celebrate/.test(last.title), 'the last chip faces left: ' + last.cls);
      await snapshot('groups-field-' + width);
      // Seek into the parallel group: every step running there is lit.
      const spin = state.blocks.find((b) => /Spin up/.test(b.title));
      await focusWindow();
      await mouse('mouseDown', spin.x0 + 6, spin.y0 + 9, false); await mouse('mouseUp', spin.x0 + 6, spin.y0 + 9, false);
      await wait(() => evaluate(() => document.querySelectorAll('.rt-timeline-span.on').length >= 2), 'parallel steps lit together');
      assert.match((await sliderState()).text, /s of /);
      await snapshot('groups-field-seek-' + width);
      await key('End');
      await snapshot('groups-field-end-' + width);
    }
    pass('Groups stack parallel steps in outlined rows, loops are marked, instant commands are unclipped chips, and running steps are lit at both sizes');

    // Run time estimates: a command with a Robot page run time is an estimate ("≈", dashed) in its row, the inspector,
    // the transport total and status, the scrubber block and its group; a limit below it wins; an untimed command
    // keeps "Untimed" and its inspector opens the Robot page by pointer.
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height);
      await load('estimate-routine', '[data-id="e-feed"]'); await planned();
      const shown = await evaluate(() => {
        const dur = (id) => document.querySelector(`[data-id="${id}"] .rt-step-dur`).textContent;
        return { feed: dur('e-feed'), loop: dur('e-loop'), capped: dur('e-capped'), group: dur('e-par'), untimed: dur('e-untimed'),
          bar: document.querySelector('[data-id="e-feed"] .rt-step-time i')?.className, rowTitle: document.querySelector('[data-id="e-feed"] .rt-step-body').title,
          untimedTitle: document.querySelector('[data-id="e-untimed"] .rt-step-body').title,
          total: document.querySelector('.rt-timeline-time small').textContent, summary: document.querySelector('.rt-timeline-summary .rt-summary-full').textContent,
          summaryTitle: document.querySelector('.rt-timeline-summary').title,
          blocks: [...document.querySelectorAll('.rt-timeline-span.estimate')].map((el) => el.title),
          groups: [...document.querySelectorAll('.rt-timeline-group')].map((el) => ({ cls: el.className, title: el.title })) };
      });
      assert.deepEqual([shown.feed, shown.loop, shown.capped, shown.group, shown.untimed], ['≈ 0.80 s', '≈ 2.40 s', '≤ 0.50 s', '≈ 0.80 s', 'Untimed'], 'row times: ' + JSON.stringify(shown));
      assert.match(shown.bar, /\bestimate\b/, 'estimate row bar'); assert.match(shown.rowTitle, /Preview estimate from its Robot page run time/);
      assert.match(shown.untimedTitle, /set a run time on the Robot page/);
      assert.match(shown.total, /^ \/ ≈ \d+\.\d\d s$/, 'total is an estimate: ' + shown.total);
      assert.equal(shown.summary, 'Using time limits · 3 steps estimated from run times · 1 untimed step not counted');
      assert.match(shown.summaryTitle, /Robot page/);
      assert.equal(shown.blocks.length, 3, 'estimate blocks: ' + shown.blocks.join(' | '));
      assert.ok(shown.blocks.every((title) => /about \d+\.\d\d s from its run time/.test(title)), 'estimate block titles');
      assert.ok(shown.groups.length === 1 && shown.groups[0].cls.includes('estimate') && shown.groups[0].title === 'Parallel group, estimated', 'group span: ' + JSON.stringify(shown.groups));
      await snapshot('estimates-' + width);
      await click('[data-id="e-loop"] .rt-step-body');
      await wait(() => evaluate(() => Boolean(document.querySelector('.routine-insp .rt-preview-time'))), 'preview time section');
      const loopTime = await evaluate(() => document.querySelector('.routine-insp .rt-preview-time').closest('section').textContent);
      assert.ok(loopTime.includes('≈ 2.40 s') && loopTime.includes('Estimate') && loopTime.includes('its 0.80 s run time on the Robot page') && loopTime.includes('the robot does not use it'), 'loop inspector: ' + loopTime);
      assert.equal(await evaluate(() => Boolean(document.querySelector('.routine-insp .rt-open-robot'))), false, 'a timed command has no Robot page link');
      await snapshot('estimate-inspector-' + width);
      await click('[data-id="e-untimed"] .rt-step-body');
      await wait(() => evaluate(() => Boolean(document.querySelector('.routine-insp .rt-open-robot'))), 'untimed Robot page link');
      assert.ok((await evaluate(() => document.querySelector('.routine-insp .rt-preview-time').closest('section').textContent)).includes('Untimed'));
      await snapshot('untimed-inspector-' + width);
      await click('.routine-insp .rt-open-robot', 'Open Robot page');
      await wait(() => evaluate(() => document.querySelector('.places [aria-current="page"]')?.textContent === 'Robot' && Boolean(document.querySelector('#settings-power'))), 'Robot page opened');
      await click('.places .place', 'Routines');
      await wait(() => evaluate(() => Boolean(document.querySelector('[data-id="e-untimed"]'))), 'back to the routine');
    }
    pass('Run time estimates are marked in rows, inspector, transport total and status, scrubber blocks and group spans; limits cap them; untimed commands open the Robot page');

    // Routine library rows: each routine's default preview time and a problem mark, from path times the library already
    // has. A timed row matches the transport total and pose jump count of the opened routine; details are its title.
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height);
      await load(ROUTINE); await planned();
      const rowState = () => evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-library-item]')].map((row) => {
        const meta = row.querySelector('.library-meta');
        return [row.dataset.libraryItem, { label: meta?.lastChild?.textContent ?? '', title: meta?.title || '', flag: meta?.querySelector('.library-flag')?.className.replace('library-flag', '').trim() || null,
          flagName: meta?.querySelector('.library-flag')?.getAttribute('aria-label') || null }];
      })));
      await wait(async () => Object.values(await rowState()).every((row) => row.label && row.label !== '…'), 'routine rows timed');
      const rows = await rowState();
      assert.deepEqual({ label: rows['untimed-routine'].label, flag: rows['untimed-routine'].flag }, { label: 'Untimed', flag: null }, 'untimed row');
      assert.deepEqual({ label: rows['empty-routine'].label, flag: rows['empty-routine'].flag, title: rows['empty-routine'].title }, { label: '—', flag: null, title: 'No steps yet' }, 'empty row');
      assert.deepEqual({ label: rows['missing-routine'].label, flag: rows['missing-routine'].flag, flagName: rows['missing-routine'].flagName }, { label: '—', flag: 'bad', flagName: 'Has problems' }, 'missing path row');
      assert.match(rows['missing-routine'].title, /The referenced path is unavailable\./);
      for (const id of [ROUTINE, 'groups-routine', 'estimate-routine']) {
        await click(`[data-library-item="${id}"]`); await planned();
        const opened = await evaluate(() => ({ total: document.querySelector('.rt-timeline-time small').textContent, summary: document.querySelector('.rt-timeline-summary .rt-summary-full').textContent }));
        const row = (await rowState())[id], jumps = opened.summary.match(/(\d+) pose jumps?/)?.[1];
        assert.equal(' / ' + row.label, opened.total, id + ' row time matches the transport total');
        assert.match(row.title, /^Preview time with the first route of each branch/, id + ' row title says what it counts');
        for (const note of opened.summary.split(' · ').filter((part) => !/pose jump/.test(part))) assert.ok(row.title.includes(note), id + ' row title notes ' + note);
        if (jumps) { assert.equal(row.flag, 'warn', id + ' pose jumps mark the row'); assert.ok(row.title.includes(jumps + ' pose jump'), id + ' row names its pose jumps: ' + row.title); }
        else assert.equal(row.flag, null, id + ' has no problem mark: ' + row.title);
      }
      assert.match((await rowState())['estimate-routine'].label, /^≈ /, 'estimates mark the row time');
      await snapshot('library-routines-' + width);
    }
    pass('Routine library rows show the default preview time (matching the transport), Untimed, empty and missing-path states, and problem marks with details in the title');

    // Untimed and empty routines.
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height);
      await load('untimed-routine', '[data-id="only-command"]'); await planned();
      const untimed = await sliderState();
      assert.equal(untimed.disabled, 'true'); assert.equal(untimed.tab, -1);
      assert.equal(await evaluate(() => document.querySelector('button[aria-label="Play routine"]').disabled), true);
      assert.ok(await evaluate(() => document.querySelector('.rt-timeline-empty')?.textContent.includes('no step in this preview has a duration')), 'untimed explanation');
      assert.equal(await evaluate(() => document.querySelectorAll('.rt-timeline-tick,.rt-timeline-playhead').length), 0);
      const geometry = await lane();
      await mouse('mouseDown', geometry.left + geometry.width / 2, geometry.y, false); await mouse('mouseUp', geometry.left + geometry.width / 2, geometry.y, false);
      assert.equal((await sliderState()).now, untimed.now, 'untimed press does nothing');
      await snapshot('untimed-' + width);
      await load('empty-routine', '.rt-empty');
      assert.equal(await evaluate(() => Boolean(document.querySelector('.rt-transport'))), false, 'empty routine has no transport');
      await snapshot('empty-' + width);
    }
    pass('Untimed preview disables the scrubber with a reason; an empty routine has no transport');

    assert.deepEqual(robotCalls, [], 'no robot transport calls');
    assert.deepEqual(errors, [], 'renderer console errors');
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ ok: true, passed, saves }, null, 2));
    console.log('Routine transport and path chooser checks passed. Screenshots: ' + output);
    app.exit(0);
  } catch (error) {
    console.error(error);
    try { await snapshot('failure'); } catch (_) { /* Window may be gone. */ }
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ ok: false, error: String(error && error.stack || error), errors, passed }, null, 2)).catch(() => {});
    app.exit(1);
  }
});
