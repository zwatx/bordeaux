const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = process.env.BORDEAUX_BRANCH_UI_OUTPUT;
app.setPath('userData', path.join(output, 'user-data'));
let win, saved, published, saves = 0, nativeHandoff = false;
const errors = [], confirms = [], robotCalls = [], scenarios = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true);
// Display units are this machine's app preference in local storage; the next page load applies them.
// Before the first load there is no app page to write to, and a fresh profile is already metric.
async function setUnits(units) {
  if (!win?.webContents.getURL().startsWith('file:')) return assert.equal(units, 'metric', 'a fresh profile starts metric');
  await evaluate((units) => localStorage.setItem('bordeaux.unitSystem', units), units);
}
async function wait(fn, label) {
  for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(75); }
  throw Error('Timed out: ' + label);
}
async function focus() {
  const state = { window: win.isFocused(), contents: win.webContents.isFocused(), document: await evaluate(() => document.hasFocus()) };
  assert.deepEqual(state, { window: true, contents: true, document: true }, 'Native focus admission: ' + JSON.stringify(state));
}
async function click(selector, text) {
  await focus();
  const point = await evaluate((selector, text) => {
    const el = [...document.querySelectorAll(selector)].find(el => el.getClientRects().length && (!text || el.textContent.trim() === text));
    if (!el || el.disabled || el.closest('[inert]')) throw Error('Unavailable control: ' + selector + ' ' + text);
    el.scrollIntoView({ block: 'nearest' });
    const rect = el.getBoundingClientRect(), x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2);
    if (!el.contains(document.elementFromPoint(x, y))) throw Error('Obscured control: ' + selector);
    return { x, y };
  }, selector, text);
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
  await delay(80);
}
async function key(keyCode, modifiers = []) {
  await focus();
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  if (!modifiers.length && ['Space', 'Enter'].includes(keyCode)) win.webContents.sendInputEvent({ type: 'char', keyCode: keyCode === 'Space' ? ' ' : '\r', modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await delay(70);
}
async function snapshot(name) {
  await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await fs.writeFile(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
}
// Preview help is a small native popover above its trigger at the end of the transport row; it overlays the workspace
// and never moves the flow.
const previewHelp = () => evaluate(() => {
  const trigger = document.querySelector('.routine-workspace-about'), help = document.querySelector('#routine-preview-notes');
  const flow = document.querySelector('.rt-scroll').getBoundingClientRect(), anchor = trigger.getBoundingClientRect(), rect = help.getBoundingClientRect();
  return { open: help.matches(':popover-open'), expanded: trigger.getAttribute('aria-expanded'), focused: document.activeElement === trigger,
    sentences: help.textContent.trim().split(/(?<=[.!?])\s+/), flow: [flow.x, flow.y, flow.width, flow.height].join(),
    fits: rect.left >= 8 && rect.right <= innerWidth - 8 && rect.top >= 8 && rect.bottom <= anchor.top && rect.width <= 300 };
});
// The field preview sits over the flow, split by a divider (aria-valuenow is the flow's height; the field's height is
// what is remembered), then the transport.
const splitState = () => evaluate(() => {
  const box = (selector) => { const r = document.querySelector(selector)?.getBoundingClientRect(); return r ? { top: r.top, bottom: r.bottom, height: r.height, width: r.width } : null; };
  const divider = document.querySelector('.routine-split'), scroll = document.querySelector('.rt-scroll');
  return { field: box('.routine-workspace-field'), svg: box('.routine-workspace-field .fieldsvg'), flow: box('.routine-workspace-flow'), transport: box('.routine-workspace-transport'),
    divider: divider && { now: Number(divider.getAttribute('aria-valuenow')), min: Number(divider.getAttribute('aria-valuemin')), max: Number(divider.getAttribute('aria-valuemax')),
      label: divider.getAttribute('aria-label'), top: divider.getBoundingClientRect().top, focused: document.activeElement === divider },
    rowRoom: scroll ? scroll.clientHeight - parseFloat(getComputedStyle(scroll).paddingTop) : 0,
    toggle: Boolean(document.querySelector('.routine-workspace-views, [aria-label="Routine view"]')) || [...document.querySelectorAll('button')].some(el => el.textContent.trim() === 'Field preview'),
    stored: localStorage.getItem('bordeaux.routines.fieldHeight') };
});
// Drags the split divider by `dy` pixels with native pointer input.
async function dragDivider(dy) {
  await focus();
  const { divider, field } = await splitState(), x = Math.round(field.width / 2 + (await evaluate(() => document.querySelector('.routine-workspace-field').getBoundingClientRect().left))), y = Math.round(divider.top);
  win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  for (const step of [0.25, 0.5, 0.75, 1]) { await delay(30); win.webContents.sendInputEvent({ type: 'mouseMove', x, y: Math.round(y + dy * step), button: 'left', modifiers: ['leftButtonDown'] }); }
  await delay(60);
  win.webContents.sendInputEvent({ type: 'mouseUp', x, y: Math.round(y + dy), button: 'left', clickCount: 1 });
  await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
// The planning banner sits below the flow until trajectories arrive; measure layout only once it and the fonts settle.
async function planned() {
  await wait(() => evaluate(() => !document.querySelector('.routine-status.planning')
    && ![...document.querySelectorAll('.rt-step-meta')].some(el => el.textContent.includes('Preparing preview'))), 'routine planning settled');
  assert.equal(await evaluate(() => document.querySelector('.routine-status')?.textContent ?? null), null, 'Fixture routine plans without a blocking status');
  await evaluate(() => document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
}
async function source() {
  await wait(() => Boolean(published?.routines), 'published routine source');
  return structuredClone(published.routines);
}
async function load(expected = 'choice') {
  published = undefined;
  await win.loadFile(path.resolve('dist-renderer/index.html'));
  await wait(() => evaluate(() => Boolean(document.querySelector('.places .place'))), 'editor ready');
  if (process.platform === 'darwin') app.focus({ steal: true });
  win.focus(); win.webContents.focus();
  await wait(async () => win.isFocused() && win.webContents.isFocused() && await evaluate(() => document.hasFocus()), 'initial focus');
  if (process.env.BORDEAUX_ROUTINE_NATIVE_HANDOFF && !nativeHandoff) {
    nativeHandoff = true;
    await fs.writeFile(path.join(output, 'native-ready.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
    await wait(async () => { try { await fs.access(path.join(output, 'native-chosen')); return true; } catch { return false; } }, 'actual native foreground handoff');
    await focus();
  }
  await click('.places .place', 'Routines');
  await click('[data-library-item="routine-workspace-test"]');
  await wait(() => evaluate(expected => Boolean(document.querySelector(expected ? '[data-id="' + expected + '"]' : '.rt-panel')), expected), 'restored flow');
}
// The path library's rows while choosing a path: each row's start hint and height, and the field's ghost path.
const pathPicker = () => evaluate(() => ({
  rows: [...document.querySelectorAll('#rt-source .rt-src-item.path')].map(el => ({ row: el.dataset.row, hint: el.querySelector('.rt-src-start')?.textContent ?? null, height: el.getBoundingClientRect().height })),
  labels: [...document.querySelectorAll('#rt-source .rt-src-label')].map(el => el.textContent),
  ghost: document.querySelector('.routine-workspace-field .routine-ghost')?.dataset.path ?? null,
  ghostRobot: Boolean(document.querySelector('.routine-workspace-field .routine-ghost-robot')) }));
async function hoverRow(row) {
  const point = await evaluate((row) => { const el = document.querySelector('#rt-source [data-row="' + row + '"]'); el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }, row);
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
}
const catalog = { runtime: 'labview', authoritative: true, generatedSchemaVersion: '1.3', projectName: 'Routine UI fixture',
  sourceFileCount: 1, scannedAt: '', warnings: [], commands: [],
  conditions: [{ id: 'piece', label: 'Enough game pieces collected', description: 'Illustrative registered condition for the UI fixture.' }],
  builtIns: [{ id: 'bordeaux.wait', kind: 'wait' }] };
ipcMain.handle('branches:restore', () => ({ project: saved }));
let activeCatalog = catalog;
ipcMain.handle('branches:catalog', () => ({ catalog: activeCatalog, bookmarkId: 'fixture' }));
ipcMain.on('branches:published', (_event, project) => { published = structuredClone(project); });
ipcMain.on('branches:confirm', (_event, message) => confirms.push(message));
ipcMain.handle('branches:robot-call', (_event, name, args) => { robotCalls.push({ name, args }); throw Error('Unexpected robot operation: ' + name); });
ipcMain.handle('branches:save', (_event, project) => { saved = structuredClone(project); saves++; return { saved: true }; });
app.whenReady().then(async () => {
  try {
    const corpus = JSON.parse(await fs.readFile('benchmarks/planner-corpus/v3/corpus.bordeaux.json', 'utf8'));
    const route = structuredClone(corpus.paths.find(p => p.id === 'corpus-neutral-stop'));
    route.name = 'Collect along the alliance wall and return through the protected crossing';
    route.folderId = 'collection';
    // A second, unfiled path: the path library groups by the project's folders and Change path has a real choice.
    const spare = structuredClone(corpus.paths.find(p => p.id !== route.id && p.waypoints?.length >= 2));
    spare.name = 'Return to the alliance zone'; delete spare.folderId;
    const routine = { id: 'routine-workspace-test', name: 'Collect until full, choose a route, then return to the alliance zone', nodes: [
      { id: 'cycle', type: 'repeat', times: 3, until: { source: 'condition', conditionId: 'piece' }, nodes: [
        { id: 'choice', type: 'decision', cond: 'piece', thenLabel: 'Full — take the scoring route', elseLabel: 'Keep collecting along the wall',
          then: [{ id: 'score', type: 'path', ref: route.id }], else: [{ id: 'collect', type: 'path', ref: route.id }] },
      ] },
      { id: 'return', type: 'path', ref: route.id },
    ] };
    saved = { ...corpus, schemaVersion: '1.1', paths: [route, spare], pathFolders: [{ id: 'collection', name: 'Collection' }], pathLinks: [], routines: [routine], activeRoutineId: routine.id,
      editor: { activePathId: route.id, robotProjectBookmarkId: 'fixture' } };
    win = new BrowserWindow({ show: true, width: 1440, height: 900, useContentSize: true,
      webPreferences: { preload: path.join(__dirname, 'verify-command-branches-ui-preload.cjs'), sandbox: false, contextIsolation: true } });
    win.on('focus', () => fs.appendFile(path.join(output, 'focus.jsonl'), JSON.stringify({ at: Date.now(), event: 'focus' }) + '\n').catch(() => {}));
    win.on('blur', () => fs.appendFile(path.join(output, 'focus.jsonl'), JSON.stringify({ at: Date.now(), event: 'blur' }) + '\n').catch(() => {}));
    win.webContents.on('console-message', details => { if (details.level === 'error' && !details.message.startsWith("Loading the font 'data:")) errors.push(details.message); });
    for (const [width, height, units] of [[1440, 900, 'metric'], [1100, 720, 'imperial']]) {
      win.setContentSize(width, height); await setUnits(units);
      await load();
      const baseline = await source();
      await planned();
      const helpClosed = await previewHelp();
      assert.ok(!helpClosed.open && helpClosed.expanded === 'false', 'Preview help starts closed');
      await click('.routine-workspace-about');
      const helpOpen = await previewHelp();
      assert.ok(helpOpen.open && helpOpen.expanded === 'true' && helpOpen.focused, 'Pointer opens preview help and keeps trigger focus');
      assert.ok(helpOpen.sentences.length <= 2 && helpOpen.sentences.includes('Push routine uploads a file; robot code validates it before execution.'), 'Preview help states the runtime boundary in two sentences');
      assert.ok(helpOpen.fits, 'Preview help fits above its trigger');
      assert.equal(helpOpen.flow, helpClosed.flow, 'Opening preview help does not move the flow');
      await snapshot('preview-notes-' + width);
      await key('Space');
      const helpSpace = await previewHelp();
      assert.ok(!helpSpace.open && helpSpace.expanded === 'false' && helpSpace.focused, 'Space closes preview help');
      await key('Space');
      assert.ok((await previewHelp()).open, 'Space reopens preview help');
      await key('Escape');
      const helpEscaped = await previewHelp();
      assert.ok(!helpEscaped.open && helpEscaped.expanded === 'false' && helpEscaped.focused, 'Escape closes preview help and keeps trigger focus');
      await key('Space'); await key('Tab');
      const helpTabbed = await previewHelp();
      assert.ok(!helpTabbed.open && !helpTabbed.focused, 'Tab moves on and closes preview help');
      await click('.routine-workspace-about');
      await click('.rt-timeline-time');
      assert.ok(!(await previewHelp()).open, 'An outside press closes preview help');
      await click('[data-id="cycle"] .rt-step-body');
      await wait(() => evaluate(() => Boolean(document.querySelector('#routine-repeat-times-cycle'))), 'repeat inspector');
      await wait(() => evaluate(() => [...document.querySelectorAll('.rt-close')].some(el => el.textContent.includes('previewing 1'))), 'planned repeat closing');
      assert.deepEqual(await evaluate(() => [...document.querySelectorAll('.rt-close-t')].map(el => el.textContent)),
        ['Both routes finish the pass', 'Back to the top until Enough game pieces collected · up to 3 passes · previewing 1'], 'Closings describe the authored convergence and repeat');
      await snapshot('repeat-' + width);
      const layout = await evaluate(() => {
        const stage = document.querySelector('.stage-auto'), flow = document.querySelector('.rt-scroll');
        return { stageWidth: stage.scrollWidth, viewportWidth: innerWidth, flowWidth: flow.clientWidth, flowScrollWidth: flow.scrollWidth };
      });
      assert.ok(layout.stageWidth <= layout.viewportWidth + 1, 'Stage must fit supported width');
      assert.ok(layout.flowScrollWidth <= layout.flowWidth + 1, 'Long branch/path names must wrap without horizontal flow overflow');
      const helpBeside = await previewHelp();
      await click('.routine-workspace-about');
      const helpInspector = await previewHelp();
      assert.ok(helpInspector.open && helpInspector.fits && helpInspector.flow === helpBeside.flow, 'Preview help fits beside the open inspector without moving the flow');
      await snapshot('preview-notes-inspector-' + width);
      await key('Escape');
      assert.ok(!(await previewHelp()).open, 'Escape closes preview help beside the inspector');
      await click('[data-id="choice"] .rt-step-body');
      await snapshot('branch-' + width);
      // A lane header opens its route's editor in the inspector; only the lane's radio chooses the preview route.
      const keepLane = '.rt-brprev[aria-label="Preview Keep collecting along the wall route"]';
      await click(keepLane + ' + .rt-brlbl');
      await wait(() => evaluate(() => document.activeElement?.matches('.routine-insp [data-route-editor="else"]')), 'lane header opens its route in the inspector');
      assert.equal(await evaluate(() => document.querySelector('.rt-branch.live .rt-brname')?.textContent), 'Full — take the scoring route', 'Opening a route keeps the preview route');
      await click(keepLane);
      await wait(() => evaluate(() => document.querySelector('.rt-branch.live .rt-brname')?.textContent === 'Keep collecting along the wall'), 'lane radio chooses the preview route');
      await key('Down'); await key('Space');
      assert.equal(await evaluate(() => document.activeElement.getAttribute('aria-label')), 'Preview Full — take the scoring route route', 'Arrow moves the preview within the branch');
      assert.equal(await evaluate(() => document.querySelector('.rt-branch.live .rt-brname')?.textContent), 'Full — take the scoring route');
      assert.ok(await evaluate(() => Boolean(document.querySelector('[aria-label="Play routine"]'))), 'Space on the preview radio does not start playback');
      await key('Escape');
      assert.ok(await evaluate(() => document.activeElement.matches('.rt-brlbl') && document.activeElement.textContent.startsWith('Full')), 'Escape returns to the chosen lane header');
      // Enter presses the header like any button; Space stays page playback, as for other ordinary buttons.
      await key('Enter');
      await wait(() => evaluate(() => document.activeElement?.matches('.routine-insp [data-route-editor="then"]')), 'Enter on a lane header opens its route');
      assert.deepEqual(await source(), baseline, 'Preview selection does not rewrite the routine');
      // The rails' footer rules (library feedback, step inspector) continue the transport's top rule as one line.
      const rules = await evaluate(() => ['.routine-workspace-transport', '.stage-auto .deletion-footer', '.rail-r .ctxinsp-foot']
        .map(selector => Math.round(document.querySelector(selector).getBoundingClientRect().top)));
      assert.ok(rules.every(top => top === rules[0]), 'Library and inspector footer rules line up with the transport: ' + rules.join());
      // Dragging a step lifts it into a card the size of its row; its slot closes and a matching gap opens at the target.
      // The flow shares the column with the field, so End on the divider gives it more room. At the minimum size the step
      // and the repeat still do not fit together, so the drag holds at the flow's top edge until it scrolls to the repeat.
      await evaluate(() => document.querySelector('.routine-split').focus()); await key('End');
      let grip, header;
      const stepDrag = async () => {
        await focus();
        await evaluate(() => { const scroll = document.querySelector('.rt-scroll'); scroll.scrollTop = scroll.scrollHeight; });
        grip = await evaluate(() => {
          const row = document.querySelector('[data-id="return"]'), r = row.querySelector('.rt-grip').getBoundingClientRect(), box = row.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), width: box.width, height: box.height };
        });
        win.webContents.sendInputEvent({ type: 'mouseDown', x: grip.x, y: grip.y, button: 'left', clickCount: 1 });
        await delay(40);
        win.webContents.sendInputEvent({ type: 'mouseMove', x: grip.x + 8, y: grip.y - 8, button: 'left', modifiers: ['leftButtonDown'] });
        await wait(() => evaluate(() => Boolean(document.querySelector('.rt-drag-card'))), 'the step lifts into a card');
        const edge = await evaluate(() => Math.round(document.querySelector('.rt-scroll').getBoundingClientRect().top + 4));
        win.webContents.sendInputEvent({ type: 'mouseMove', x: grip.x + 60, y: edge, button: 'left', modifiers: ['leftButtonDown'] });
        await wait(() => evaluate(() => document.querySelector('.rt-scroll').scrollTop === 0), 'the flow scrolls up under the dragged step');
        header = await evaluate(() => { const r = document.querySelector('[data-id="cycle"]').getBoundingClientRect(); return { x: Math.round(r.x + 60), y: Math.round(r.y + r.height / 4) }; });
        win.webContents.sendInputEvent({ type: 'mouseMove', x: header.x, y: header.y, button: 'left', modifiers: ['leftButtonDown'] });
        await wait(() => evaluate(() => Boolean(document.querySelector('.rt-group.drop-before'))), 'a gap opens before the repeat');
        await delay(260);
      };
      await stepDrag();
      const lifted = await evaluate(() => {
        // The card's layout size (it is drawn lifted, scaled 2%).
        const card = { width: document.querySelector('.rt-drag-card').offsetWidth, height: document.querySelector('.rt-drag-card').offsetHeight }, source = document.querySelector('[data-id="return"]');
        const gap = document.querySelector('[data-id="cycle"]').parentElement, before = getComputedStyle(gap).marginTop, well = getComputedStyle(gap, '::after');
        return { width: card.width, height: card.height, label: document.querySelector('.rt-drag-card').textContent, away: source.classList.contains('away'), sourceHeight: source.getBoundingClientRect().height,
          gap: parseFloat(before), well: parseFloat(well.height), target: gap.classList.contains('drop-before') };
      });
      assert.ok(Math.abs(lifted.width - grip.width) < 1 && Math.abs(lifted.height - grip.height) < 1, 'The card is the size of the row: ' + JSON.stringify(lifted));
      assert.equal(lifted.label, 'Collect along the alliance wall and return through the protected crossing', 'The card names the step');
      assert.ok(lifted.away && lifted.sourceHeight < 1, 'The source slot closes');
      assert.ok(lifted.target && Math.abs(lifted.gap - grip.height) < 1 && Math.abs(lifted.well - grip.height + 4) < 1, 'A gap the card\'s height opens at the target: ' + JSON.stringify(lifted));
      await snapshot('step-drag-' + width);
      await key('Escape');
      await wait(() => evaluate(() => !document.querySelector('.rt-drag-card, .rt-panel.dragging, .drop-before, .drop-after')), 'Escape drops nothing');
      win.webContents.sendInputEvent({ type: 'mouseUp', x: header.x, y: header.y, button: 'left', clickCount: 1 });
      await delay(120);
      assert.deepEqual(await source(), baseline, 'Escape cancels the drag without an edit');
      await stepDrag();
      win.webContents.sendInputEvent({ type: 'mouseUp', x: header.x, y: header.y, button: 'left', clickCount: 1 });
      await wait(async () => (await source())[0].nodes.map(node => node.id).join() === 'return,cycle', 'the drop moves the step before the repeat');
      assert.ok(await evaluate(() => !document.querySelector('.rt-drag-card, .rt-panel.dragging')), 'The card is gone after the drop');
      await key('z', ['meta']);
      await wait(async () => JSON.stringify(await source()) === JSON.stringify(baseline), 'one Undo restores the order');
      await evaluate(() => document.querySelector('.routine-split').focus()); await key('Enter');
      if (await evaluate(() => document.querySelector('[data-id="return"]').classList.contains('sel'))) await click('[data-id="choice"] .rt-step-body');
      await click('[data-id="return"] .rt-step-body');
      await key('A');
      await wait(() => evaluate(() => document.activeElement?.matches('.rt-slot [data-action="path"]')), 'A opens a slot with its strip focused');
      // The slot opens in the flow, right after the step; its library takes the routine list's place in the left rail.
      const slot = await evaluate(() => {
        const at = document.querySelector('.rt-addwrap.at'), row = document.querySelector('[data-id="return"]'), library = document.querySelector('#rt-source');
        const rail = library?.getBoundingClientRect(), flow = document.querySelector('.routine-workspace').getBoundingClientRect(), strip = document.querySelector('.rt-slot').getBoundingClientRect();
        return { slots: document.querySelectorAll('.rt-slot').length, after: Boolean(at && row.compareDocumentPosition(at) & Node.DOCUMENT_POSITION_FOLLOWING),
          inRail: Boolean(library?.closest('.rt-source-host')), routinesHidden: getComputedStyle(document.querySelector('.stage-auto > .library-rail')).display === 'none',
          beside: rail && rail.right <= flow.left + 1, kind: library?.getAttribute('aria-label'), actions: [...document.querySelectorAll('.rt-slot [data-action]')].map(el => el.dataset.action),
          stripFits: strip.right <= document.querySelector('.rt-scroll').getBoundingClientRect().right, old: Boolean(document.querySelector('.rt-add-menu, .rt-add-search')) };
      });
      assert.deepEqual(slot, { slots: 1, after: true, inRail: true, routinesHidden: true, beside: true, kind: 'Add path', stripFits: true, old: false,
        actions: ['path', 'command', 'wait', 'repeat', 'group:parallel', 'group:sequential', 'end'] }, 'A opens one slot after the step and the path library beside the flow');
      assert.deepEqual(await evaluate(() => [...document.querySelectorAll('#rt-source .rt-src-group, #rt-source .rt-src-label')].map(el => el.textContent)), ['Collection1', 'Not in a folder'], 'Paths are grouped by the project folders');
      // Each path row says how far its start is from where the robot is at the slot (after "return": the route's end),
      // in the display units; none starts there, so no "Continues from here" block. Hovering a row draws that path as
      // a ghost with the robot outlined at the slot, without moving any row; leaving it removes the ghost.
      const robotWidth = Math.min(published.robot.l, published.robot.w), slotEnd = published.paths.find(p => p.id === route.id).waypoints.at(-1);
      const hintFor = (id) => {
        const start = published.paths.find(p => p.id === id).waypoints[0], d = Math.hypot(start.x - slotEnd.x, start.y - slotEnd.y);
        return d <= robotWidth * 0.1 ? 'Starts here' : (units === 'metric' ? d.toFixed(1) + ' m off' : (d * 3.280839895013123).toFixed(1) + ' ft off');
      };
      const picker = await pathPicker();
      assert.deepEqual(picker.rows.map(r => r.hint), picker.rows.map(r => hintFor(r.row.slice(5))), 'Path rows show their start relative to the slot: ' + JSON.stringify(picker.rows));
      assert.ok(!picker.labels.includes('Continues from here') && picker.ghost === null, 'No continuing paths and no ghost before hovering');
      await hoverRow('path:' + spare.id);
      await wait(async () => (await pathPicker()).ghost === spare.id, 'hovering a path row draws its ghost');
      const hovered = await pathPicker();
      assert.ok(hovered.ghostRobot && JSON.stringify(hovered.rows.map(r => r.height)) === JSON.stringify(picker.rows.map(r => r.height)), 'The ghost starts from the robot at the slot and no row moves: ' + JSON.stringify(hovered));
      await snapshot('path-ghost-' + width);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 4, y: Math.round((await evaluate(() => innerHeight)) - 4) });
      await wait(async () => (await pathPicker()).ghost === null, 'leaving the row removes the ghost');
      await snapshot('insert-' + width);
      assert.ok(await evaluate(() => {
        const pass = document.querySelector('.rt-timeline-pass-now'), step = document.querySelector('.rt-timeline-step');
        // A narrow transport leaves the pass to the flow's running row; a shown pass keeps its distance from the place.
        return !pass || getComputedStyle(pass).clipPath !== 'none' || step.getBoundingClientRect().left + parseFloat(getComputedStyle(step).paddingLeft) >= pass.getBoundingClientRect().right + 8;
      }), 'Playback pass and step counters have separate readable spacing');
      const library = await evaluate(() => {
        const list = document.querySelector('#rt-source .rt-src-list').getBoundingClientRect(), last = [...document.querySelectorAll('#rt-source [data-row]')].at(-1).getBoundingClientRect();
        return { top: list.top, bottom: list.bottom, lastBottom: last.bottom, viewport: innerHeight };
      });
      assert.ok(library.top >= 0 && library.bottom <= library.viewport && library.lastBottom <= library.bottom + 1, 'The path library and its last path fit the rail');
      await key('Escape');
      assert.equal(await evaluate(() => document.activeElement.closest('.rt-step')?.dataset.id), 'return', 'Escape returns to insertion origin');
      assert.ok(await evaluate(() => !document.querySelector('.rt-slot, #rt-source') && getComputedStyle(document.querySelector('.stage-auto > .library-rail')).display !== 'none'), 'Escape closes the slot and gives the rail back to the routine list');
      // Keyboard: A, P moves into the library, ↓ to a path, Enter adds it as a reference.
      await key('A'); await key('P');
      await wait(() => evaluate(() => document.activeElement?.matches('#rt-source input')), 'P moves into the path library search');
      await key('Down');
      assert.equal(await evaluate(() => document.activeElement.dataset.row), 'path:' + route.id, 'Down enters the path list');
      await wait(async () => (await pathPicker()).ghost === route.id, 'the focused path row draws its ghost');
      await key('Enter');
      await wait(async () => (await source())[0].nodes.length === 3, 'insert a real path after shared continuation');
      const added = (await source())[0].nodes[2];
      assert.equal(added.type, 'path'); assert.equal(added.ref, route.id);
      assert.ok(await evaluate(() => !document.querySelector('#rt-source') && document.activeElement.closest('.rt-step')?.dataset.id), 'A pick closes the library and focuses the new step');
      assert.equal((await pathPicker()).ghost, null, 'Closing the library removes the ghost');
      await key('z', ['meta']);
      await wait(async () => JSON.stringify(await source()) === JSON.stringify(baseline), 'exact undo of inserted path');
      // Shift+A adds before the step; one click on a path in the library inserts it there.
      await click('[data-id="return"] .rt-step-body');
      await key('A', ['shift']);
      await wait(() => evaluate(() => document.querySelector('.rt-slot')?.getAttribute('aria-label') === 'Add a step before this one'), 'Shift+A opens a slot before the step');
      assert.ok(await evaluate(() => Boolean(document.querySelector('.rt-addwrap.at').compareDocumentPosition(document.querySelector('[data-id="return"]')) & Node.DOCUMENT_POSITION_FOLLOWING)), 'Shift+A opens the slot right before the step');
      await snapshot('insert-before-' + width);
      await click('#rt-source [data-row="path:' + spare.id + '"]');
      await wait(async () => (await source())[0].nodes.length === 3, 'insert before the shared continuation');
      assert.equal((await source())[0].nodes[1].ref, spare.id, 'One click inserts the clicked path');
      assert.equal((await source())[0].nodes[2].id, 'return', 'Shift+A inserts before the step');
      await key('z', ['meta']);
      await wait(async () => JSON.stringify(await source()) === JSON.stringify(baseline), 'exact undo of inserted-before path');
      // Change path opens the same library for the step, marks it in the flow, and replaces only its reference.
      await click('[data-id="return"] .rt-step-body');
      await click('.routine-change-path');
      await wait(() => evaluate(() => document.activeElement?.matches('#rt-source.replace input')), 'Change path opens the path library');
      assert.deepEqual(await evaluate(() => ({ marked: document.querySelector('[data-id="return"]').classList.contains('replacing'), current: document.querySelector('#rt-source [aria-current="true"]')?.dataset.row,
        title: document.querySelector('#rt-source h2').textContent })), { marked: true, current: 'path:' + route.id, title: 'Change path' });
      // Change path compares with the pose before the step: the end of "score", the route's end again.
      assert.deepEqual((await pathPicker()).rows.map(r => r.hint), (await pathPicker()).rows.map(r => hintFor(r.row.slice(5))), 'Change path rows compare with the pose before the step');
      await snapshot('change-path-' + width);
      await key('Escape');
      assert.ok(await evaluate(() => document.activeElement.matches('.routine-change-path') && !document.querySelector('#rt-source, .rt-step.replacing')), 'Escape returns to Change path');
      await key('Enter');
      await wait(() => evaluate(() => document.activeElement?.matches('#rt-source.replace input')), 'Enter on Change path reopens the library');
      await click('#rt-source [data-row="path:' + spare.id + '"]');
      await wait(async () => (await source())[0].nodes[1].ref === spare.id, 'Change path replaces the reference');
      assert.equal((await source())[0].nodes[1].id, 'return', 'The step keeps its identity');
      await wait(() => evaluate(() => document.activeElement?.matches('.routine-change-path')), 'focus returns to Change path');
      await key('z', ['meta']);
      await wait(async () => JSON.stringify(await source()) === JSON.stringify(baseline), 'exact undo of a changed path');
      // Undo removes an inserted selected step and closes its inspector; a changed path keeps its step selected. Select a
      // retained step before testing Close.
      if (!(await evaluate(() => document.querySelector('[data-id="return"]').classList.contains('sel')))) await click('[data-id="return"] .rt-step-body');
      await click('button[aria-label="Close step inspector"]');
      await snapshot('flow-closed-' + width);
      // One view: the field over the flow, both usable at the default split, with no Flow / Field preview switch.
      const split = await splitState();
      assert.equal(split.toggle, false, 'The Flow / Field preview switch is gone');
      assert.equal(split.stored, null, 'A fresh profile uses the default split');
      assert.equal(split.divider.label, 'Resize flow', 'The divider names what it resizes');
      assert.ok(split.field.bottom <= split.flow.top + 1 && split.flow.bottom <= split.transport.top + 1, 'Field, flow, then transport, without overlap: ' + JSON.stringify(split));
      assert.ok(split.svg.height >= 160 && split.svg.width >= 400, 'The field preview is usable: ' + JSON.stringify(split.svg));
      assert.ok(split.rowRoom >= 5 * 34, 'The flow has room for five rows: ' + split.rowRoom);
      assert.ok(Math.abs(split.flow.height - split.divider.now) <= 1, 'The divider reports the flow height');
      if (width === 1440) assert.ok(split.field.height > split.flow.height, 'At 1440x900 the field gets the larger share: ' + JSON.stringify(split));
      // Pointer drag moves the divider with the pointer and clamps so neither part collapses.
      await dragDivider(-60);
      const dragged = await splitState();
      assert.ok(Math.abs(dragged.divider.now - split.divider.now - 60) <= 1 && Math.abs(dragged.flow.height - dragged.divider.now) <= 1, 'Dragging up 60px grows the flow by 60px: ' + JSON.stringify(dragged.divider));
      assert.equal(dragged.stored, String(Math.round(dragged.field.height)), 'A drag remembers the split as the field height');
      assert.equal(dragged.divider.focused, false, 'A pointer drag does not take focus');
      await dragDivider(-2000);
      const tallest = await splitState();
      assert.ok(tallest.divider.now === tallest.divider.max && tallest.field.height >= 159, 'The field keeps its minimum: ' + JSON.stringify(tallest));
      await dragDivider(2000);
      const shortest = await splitState();
      assert.ok(shortest.divider.now === shortest.divider.min && shortest.flow.height >= 139 && shortest.flow.bottom <= shortest.transport.top + 1, 'The flow keeps its minimum: ' + JSON.stringify(shortest));
      await snapshot('split-shortest-flow-' + width);
      // Keyboard on the focused divider: arrows step 16px (Shift 64px), Home/End reach the limits, Enter resets.
      await evaluate(() => document.querySelector('.routine-split').focus());
      const nowAfter = async (keyCode, modifiers) => { await key(keyCode, modifiers); return (await splitState()).divider.now; };
      assert.equal(await nowAfter('Up'), shortest.divider.min + 16, 'ArrowUp grows the flow by 16px');
      assert.equal(await nowAfter('Up', ['shift']), shortest.divider.min + 80, 'Shift+ArrowUp grows the flow by 64px');
      assert.equal(await nowAfter('Down'), shortest.divider.min + 64, 'ArrowDown shrinks the flow by 16px');
      assert.equal(await nowAfter('End'), shortest.divider.max, 'End gives the flow its maximum');
      assert.equal(await nowAfter('Home'), shortest.divider.min, 'Home gives the flow its minimum');
      await key('Enter');
      const reset = await splitState();
      assert.ok(reset.divider.now === split.divider.now && reset.stored === null && reset.divider.focused, 'Enter returns to the default split and keeps focus: ' + JSON.stringify(reset.divider));
      // The chosen split survives a reload; a double-click returns to the default and forgets it.
      await key('Up', ['shift']);
      const chosen = (await splitState()).divider.now;
      await load(); await planned();
      const reloaded = await splitState();
      assert.ok(reloaded.divider.now === chosen && reloaded.stored === String(Math.round(reloaded.field.height)), 'The split is remembered across reload: ' + JSON.stringify(reloaded.divider));
      await focus();
      const handle = { x: Math.round(reloaded.field.width / 2 + await evaluate(() => document.querySelector('.routine-workspace-field').getBoundingClientRect().left)), y: Math.round(reloaded.divider.top) };
      for (const clickCount of [1, 2]) for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount, ...handle });
      await wait(async () => (await splitState()).divider.now === split.divider.now, 'double-click resets the split');
      assert.equal((await splitState()).stored, null, 'A double-click forgets the chosen split');
      // Clicking a step's path on the field selects that step, and the flow scrolls to it.
      await evaluate(() => { document.querySelector('.rt-scroll').scrollTop = 0; });
      const onField = await evaluate(() => {
        for (const element of document.querySelectorAll('.routine-workspace-field path[data-role="rpath"]')) {
          const length = element.getTotalLength(), m = element.getScreenCTM();
          for (let f = 0.3; f <= 0.9; f += 0.05) {
            const p = element.getPointAtLength(length * f), x = Math.round(m.a * p.x + m.c * p.y + m.e), y = Math.round(m.b * p.x + m.d * p.y + m.f);
            if (document.elementFromPoint(x, y) === element) return { x, y, id: element.dataset.idx };
          }
        }
        return null;
      });
      assert.ok(onField, 'A routine path on the field can be pressed');
      await focus();
      for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, x: onField.x, y: onField.y });
      await wait(() => evaluate(id => document.querySelector('.rt-step.sel')?.dataset.id === id && Boolean(document.querySelector('.routine-insp')), onField.id), 'a field path selects its step');
      assert.ok(await evaluate(() => {
        const row = document.querySelector('.rt-step.sel').getBoundingClientRect(), scroll = document.querySelector('.rt-scroll').getBoundingClientRect();
        return row.top >= scroll.top - 1 && row.bottom <= scroll.bottom + 1;
      }), 'The step selected on the field is in view in the flow');
      await snapshot('field-selects-step-' + width);
      // Each path step on the field has one badge with its row's number in the flow, even when three steps share one
      // path; badges never overlap. Only the selected step shows its name beside its badge.
      const badges = () => evaluate(() => {
        const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; };
        return { badges: [...document.querySelectorAll('.routine-workspace-field .routine-step-badge')].map(el => ({ id: el.dataset.idx, step: el.dataset.step, ...box(el),
            row: document.querySelector('.rt-step[data-id="' + el.dataset.idx + '"] .rt-step-num')?.textContent, hit: document.elementFromPoint(box(el).x, box(el).y)?.closest('.routine-step-badge') === el })),
          labels: [...document.querySelectorAll('.routine-workspace-field .routine-step-label')].map(el => { const r = el.getBoundingClientRect(), svg = document.querySelector('.routine-workspace-field .fieldsvg').getBoundingClientRect();
            return { step: el.dataset.step, name: el.querySelectorAll('text')[1].textContent, inside: r.left >= svg.left - 1 && r.right <= svg.right + 1 }; }),
          selected: document.querySelector('.rt-step.sel')?.dataset.id, field: box(document.querySelector('.routine-workspace-field .fieldsvg')) };
      });
      const marks = await badges();
      const traced = await evaluate(() => [...new Set([...document.querySelectorAll('.routine-workspace-field path[data-role="rpath"]')].map(el => el.dataset.idx))].sort());
      assert.deepEqual(marks.badges.map(b => b.id).sort(), traced, 'One badge per path step on the field: ' + JSON.stringify(marks.badges));
      assert.ok(marks.badges.length >= 2 && marks.badges.every(b => b.step === b.row && b.hit), 'Badges show their step numbers from the flow and can be pressed: ' + JSON.stringify(marks.badges));
      for (const [i, a] of marks.badges.entries()) for (const b of marks.badges.slice(i + 1)) {
        assert.ok(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top, 'Badges do not overlap: ' + JSON.stringify([a, b]));
      }
      const selectedStep = marks.badges.find(b => b.id === onField.id).step;
      assert.deepEqual(marks.labels.map(l => l.step), [selectedStep], 'Only the selected step shows its name on the field');
      // A long name ends in an ellipsis rather than leaving the field.
      assert.ok(marks.labels[0].inside && route.name.startsWith(marks.labels[0].name.replace(/\u2026$/, '')) && marks.labels[0].name.length > 12, 'The label names the path inside the field: ' + JSON.stringify(marks.labels[0]));
      // The path under the pointer (its badge here) shows its name too, until the pointer leaves it.
      const other = marks.badges.find(b => b.id !== onField.id);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: other.x, y: other.y });
      await wait(async () => (await badges()).labels.map(l => l.step).sort().join() === [selectedStep, other.step].sort().join(), 'hovering a badge shows its name');
      await snapshot('field-badge-hover-' + width);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(marks.field.left + 6), y: Math.round(marks.field.top + 6) });
      await wait(async () => (await badges()).labels.map(l => l.step).join() === selectedStep, 'leaving the badge hides its name');
      // Pressing a badge selects its step, like pressing its path.
      await focus();
      for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, x: other.x, y: other.y });
      await wait(() => evaluate(id => document.querySelector('.rt-step.sel')?.dataset.id === id, other.id), 'a badge selects its step');
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(marks.field.left + 6), y: Math.round(marks.field.top + 6) });
      await wait(async () => (await badges()).labels.map(l => l.step).join() === other.step, 'the newly selected step shows its name');
      // Playback: the running row and the robot on the field show together.
      const lane = await evaluate(() => { const r = document.querySelector('.rt-timeline-editor').getBoundingClientRect(); return { x: Math.round(r.left + r.width * 0.3), y: Math.round(r.top + 30) }; });
      await focus();
      for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...lane });
      await wait(() => evaluate(() => Boolean(document.querySelector('.rt-list.playing') && document.querySelector('.rt-step.active'))), 'seeking shows the running row');
      const playing = await evaluate(() => {
        const robot = document.querySelector('.routine-workspace-field .fieldsvg polygon[fill="rgba(14,16,20,0.85)"]')?.getBoundingClientRect();
        const field = document.querySelector('.routine-workspace-field').getBoundingClientRect(), flow = document.querySelector('.routine-workspace-flow').getBoundingClientRect();
        const row = document.querySelector('.rt-step.active').getBoundingClientRect(), scroll = document.querySelector('.rt-scroll').getBoundingClientRect();
        return { robot: Boolean(robot && robot.width && robot.top >= field.top && robot.bottom <= field.bottom), field: field.height, flow: flow.height,
          row: row.top >= scroll.top - 1 && row.bottom <= scroll.bottom + 1 };
      });
      assert.ok(playing.robot && playing.row && playing.field > 150 && playing.flow > 130, 'The robot on the field and the running row are visible together: ' + JSON.stringify(playing));
      // The running path step shows its name beside its badge during playback.
      const activeRow = await evaluate(() => { const row = document.querySelector('.rt-step.active'); return { id: row.dataset.id, step: row.querySelector('.rt-step-num').textContent }; });
      const activeLabels = (await badges()).labels.map(l => l.step);
      assert.ok((await badges()).badges.some(b => b.id === activeRow.id), 'The seek lands on a path step: ' + activeRow.id);
      assert.ok(activeLabels.includes(activeRow.step), 'The running path step shows its name: ' + JSON.stringify({ activeRow, activeLabels }));
      await snapshot('playback-' + width);
      await click('[aria-label="Restart routine"]');
      await click('button[aria-label="Close step inspector"]');
      // Pose jumps: the field's connector, the flow's mark and the inspector agree on the jump's size. A path that
      // follows itself gets no link; a different previous path links this start to its end as one Undo step.
      const jumpState = (id) => evaluate((id) => ({
        field: [...document.querySelectorAll('.routine-workspace-field .routine-jump')].filter(el => el.dataset.node === id).map(el => el.dataset.size),
        flow: document.querySelector('.rt-step[data-id="' + id + '"] .rt-step-flag')?.dataset.jump ?? null,
        inspector: [...document.querySelectorAll('.routine-insp .rt-jump')].map(el => el.dataset.size),
        links: document.querySelectorAll('.routine-insp .rt-jump-link').length,
        text: document.querySelector('.routine-insp .rt-jump')?.textContent ?? '' }), id);
      await click('[data-id="return"] .rt-step-body');
      await wait(async () => (await jumpState('return')).inspector.length === 1, 'the jump into the step shows in its inspector');
      const selfJump = await jumpState('return');
      assert.ok(selfJump.links === 0 && selfJump.text.includes('this same path') && selfJump.field.length === 1 && selfJump.field[0] === selfJump.inspector[0] && selfJump.flow === selfJump.inspector[0],
        'A path following itself shows its jump, sized the same everywhere, without a link: ' + JSON.stringify(selfJump));
      await click('.routine-change-path');
      await wait(() => evaluate(() => document.activeElement?.matches('#rt-source.replace input')), 'Change path opens the path library');
      await click('#rt-source [data-row="path:' + spare.id + '"]');
      await wait(async () => (await source())[0].nodes[1].ref === spare.id, 'the step follows the spare path');
      await planned();
      await wait(async () => (await jumpState('return')).links === 1, 'a jump from another path offers its link');
      const jump = await jumpState('return');
      assert.ok(['medium', 'large'].includes(jump.inspector[0]) && jump.field.join() === jump.inspector.join() && jump.flow === jump.inspector[0] && jump.text.includes(route.name),
        'The jump names the previous path and has one size on the field, in the flow and in the inspector: ' + JSON.stringify(jump));
      await snapshot('pose-jump-' + width);
      // One warning line naming the previous step and an inline link; the explanation waits behind Why, which opens by
      // pointer and closes from the keyboard.
      const whyState = () => evaluate(() => {
        const button = document.querySelector('.routine-insp .rt-jump-why'), detail = document.getElementById(button.getAttribute('aria-controls'));
        return { expanded: button.getAttribute('aria-expanded'), shown: detail.getClientRects().length > 0, text: detail.textContent, focused: document.activeElement === button,
          line: document.querySelector('.routine-insp .rt-jump-text').textContent, link: document.querySelector('.routine-insp .rt-jump-link')?.textContent };
      });
      const whyClosed = await whyState();
      assert.ok(whyClosed.expanded === 'false' && !whyClosed.shown && /^Starts \d.* from step \d+’s end$/.test(whyClosed.line) && /^Link start to step \d+’s end$/.test(whyClosed.link),
        'One warning line and an inline link; the explanation waits behind Why: ' + JSON.stringify(whyClosed));
      await click('.routine-insp .rt-jump-why');
      const whyOpen = await whyState();
      assert.ok(whyOpen.expanded === 'true' && whyOpen.shown && whyOpen.focused && whyOpen.text.includes(route.name) && whyOpen.text.includes('stay linked'), 'Why shows the explanation: ' + JSON.stringify(whyOpen));
      await snapshot('pose-jump-why-' + width);
      await key('Enter');
      assert.ok(await evaluate(() => document.querySelector('.routine-insp .rt-jump-why').getAttribute('aria-expanded') === 'false'), 'Enter on Why closes it again');
      const pathsBefore = structuredClone(published.paths);
      await click('.routine-insp .rt-jump-link');
      await wait(() => {
        const start = published.paths.find(p => p.id === spare.id).waypoints[0], end = published.paths.find(p => p.id === route.id).waypoints.at(-1);
        return start.x === end.x && start.y === end.y && start.positionLink && start.positionLink === end.positionLink;
      }, 'the link moves the spare path\'s start to the previous end and links them');
      assert.equal(published.paths.find(p => p.id === spare.id).waypoints[0].theta, pathsBefore.find(p => p.id === spare.id).waypoints[0].theta, 'The start keeps its own facing');
      assert.deepEqual((await source())[0].nodes.map(n => n.id), baseline[0].nodes.map(n => n.id), 'Linking does not edit the routine');
      await wait(() => evaluate(() => document.activeElement?.classList.contains('rt-jump-done') && !document.querySelector('.rt-jump-link')), 'a note takes the link\'s place and focus');
      await planned();
      const linked = await jumpState('return');
      assert.ok(linked.links === 0 && linked.field.every(size => size === 'small') && (linked.flow === null || linked.flow === 'small'), 'After the link only a facing difference can remain: ' + JSON.stringify(linked));
      await snapshot('pose-jump-linked-' + width);
      await key('z', ['meta']);
      await wait(() => JSON.stringify(published.paths) === JSON.stringify(pathsBefore), 'one Undo restores both paths');
      assert.equal((await source())[0].nodes[1].ref, spare.id, 'That Undo keeps the changed path step');
      await key('z', ['meta']);
      await wait(async () => JSON.stringify(await source()) === JSON.stringify(baseline), 'the next Undo restores the step');
      await click('button[aria-label="Close step inspector"]');
      const beforeSave = saves;
      await click('.project-chip'); await click('[role="menuitem"][data-action="save"]');
      await wait(() => saves > beforeSave, 'explicit local save');
      assert.deepEqual(saved.routines, baseline, 'Exact source saved');
      await load(); assert.deepEqual(await source(), baseline, 'Exact source reopened');
      await snapshot('restored-' + width);
      activeCatalog = { ...catalog, conditions: [] };
      await load();
      await click('[data-id="choice"] .rt-step-body');
      await wait(() => evaluate(() => document.body.textContent.includes('The saved condition is unavailable')), 'missing condition recovery');
      assert.deepEqual(await source(), baseline, 'Missing catalog condition keeps authored source');
      await snapshot('missing-condition-' + width);
      activeCatalog = catalog;
      saved.routines = [{ ...routine, nodes: [] }];
      await load(null);
      await snapshot('empty-' + width);
      // An empty routine shows the robot field over its flow, with nothing planned and nothing to play.
      const emptySplit = await splitState();
      assert.ok(emptySplit.svg?.height >= 160 && emptySplit.field.bottom <= emptySplit.flow.top + 1 && !emptySplit.transport && !emptySplit.toggle,
        'An empty routine shows the field over the flow without a transport: ' + JSON.stringify(emptySplit));
      assert.equal(await evaluate(() => document.querySelectorAll('.routine-workspace-field [data-role="rpath"]').length), 0, 'The empty field has no planned paths');
      // An empty routine shows its first step's slot in place, without an explanation or a button to open it.
      assert.ok(await evaluate(() => !/No steps yet|Steps run top to bottom/.test(document.querySelector('.rt-panel').textContent)
        && Boolean(document.querySelector('.rt-empty .rt-slot.first [data-action="wait"]')) && !document.querySelector('#rt-source')), 'Empty routine shows its first step slot');
      await click('.rt-slot.first [data-action="path"]');
      await wait(() => evaluate(() => document.activeElement?.matches('#rt-source input')), 'Path opens the library from the first step');
      // The first step has no pose before it: rows have no start hint and the ghost has no robot outline.
      await hoverRow('path:' + route.id);
      await wait(async () => (await pathPicker()).ghost === route.id, 'the first step still previews the hovered path');
      const first = await pathPicker();
      assert.ok(first.rows.every(r => r.hint === null) && !first.ghostRobot, 'The first step shows the ghost only: ' + JSON.stringify(first));
      await snapshot('empty-library-' + width);
      await key('Escape');
      assert.ok(await evaluate(() => document.activeElement.matches('.rt-slot.first [data-action="path"]') && !document.querySelector('#rt-source') && Boolean(document.querySelector('.rt-slot.first'))),
        'Escape closes the library and keeps the first step slot and its focus');
      assert.deepEqual((await source())[0].nodes, [], 'Cancelling empty insertion preserves source');
      activeCatalog = null;
      await load(null);
      await click('.rt-slot.first [data-action="command"]');
      await wait(() => evaluate(() => document.querySelector('#rt-source .rt-src-none')?.textContent.startsWith('Commands come from linked robot code.')), 'Without robot code the command library says where commands come from');
      assert.ok(await evaluate(() => Boolean(document.querySelector('.rt-slot.first [data-action="wait"]'))), 'Without robot code, Wait stays available');
      await snapshot('no-catalog-insert-' + width);
      await key('Escape');
      assert.deepEqual((await source())[0].nodes, [], 'No-catalog insertion cancellation preserves source');
      activeCatalog = catalog;
      saved.routines = [{ ...routine, nodes: [
        { id: 'once', type: 'repeat', times: 1, until: { source: 'condition', conditionId: 'piece' }, nodes: [{ id: 'once-path', type: 'path', ref: route.id }] },
        { id: 'legacy-reference', type: 'function', cat: 'generate', funcRef: 'GeneratePath', preview: structuredClone(route) },
      ] }];
      await load('once');
      assert.equal(await evaluate(() => document.querySelector('.rt-close-t').textContent), 'Runs once, then continues', 'A one-pass repeat never promises loop-back');
      await click('[data-id="legacy-reference"] .rt-step-body');
      await wait(() => evaluate(() => document.querySelector('.routine-insp').textContent.includes('Plays the saved preview path. Runtime generation is unavailable.')), 'saved legacy reference explanation');
      assert.ok(await evaluate(() => document.querySelector('[data-id="legacy-reference"]').textContent.includes('preview plays its saved reference path')), 'Saved reference row agrees with actual preview');
      await snapshot('once-and-saved-reference-' + width);
      saved.routines = [{ ...routine, nodes: [
        { id: 'control-loop', type: 'repeat', times: 3, nodes: [
          { id: 'control-choice', type: 'decision', cond: 'piece', then: [{ id: 'leave', type: 'end', scope: 'repeat' }],
            else: [{ id: 'wait-control', type: 'builtin', builtinId: 'bordeaux.wait', arguments: { durationS: 1 } }] },
        ] }, { id: 'finish', type: 'end', scope: 'routine' },
      ] }];
      await load('control-loop');
      await click('[data-id="leave"] .rt-step-body'); await snapshot('exit-and-wait-' + width);
      await key('A'); await snapshot('insert-in-repeat-' + width);
      assert.ok(await evaluate(() => Boolean(document.querySelector('.rt-slot [data-action="exit"]'))), 'Nested insertion offers Exit repeat');
      await key('Escape');
      await click('[data-id="finish"] .rt-step-body'); await snapshot('end-routine-' + width);
      saved.routines = [{ ...routine, nodes: [{ id: 'unsupported-generated', type: 'generatedTrajectory', generatorId: 'fixture', arguments: {}, fallback: { type: 'safeStop' } }] }];
      await load('unsupported-generated'); await click('[data-id="unsupported-generated"] .rt-step-body');
      assert.ok(await evaluate(() => document.querySelector('.routine-insp').textContent.includes('Preview and robot execution are unavailable.')), 'Saved unsupported definition never claims runtime generation');
      await snapshot('unsupported-definition-' + width);
      // Native output-driven repeat authoring: the preview count is never a runtime cap.
      const bool = { kind: 'boolean', valueType: 'Boolean' };
      activeCatalog = { ...catalog, builtIns: [], commands: [{ id: 'completion', label: 'Check whether collection is finished', member: 'Completion.vi', parameters: [], labviewConnector: {},
        outputs: [{ name: 'finished', label: 'Finished', schema: bool }] }] };
      saved.routines = [{ ...routine, nodes: [{ id: 'output-loop', type: 'repeat', times: 2, nodes: [
        { id: 'loop-path-a', type: 'path', ref: route.id }, { id: 'loop-path-b', type: 'path', ref: route.id },
        { id: 'completion-step', type: 'function', cat: 'command', title: 'Check whether collection is finished', invocation: { commandId: 'completion', arguments: {} } },
      ] }, { id: 'after-loop', type: 'builtin', builtinId: 'bordeaux.wait', arguments: { durationS: .25 } }] }];
      await load('output-loop'); await planned();
      // Command opens the command library; a search finds a catalog command that Enter inserts bound with its default
      // arguments in one pick. Branching is never an Add item.
      const loopBaseline = await source();
      await click('[data-id="after-loop"] .rt-step-body'); await key('A'); await key('C');
      await wait(() => evaluate(() => document.activeElement?.matches('#rt-source.command input')), 'C opens the command library search');
      assert.ok(await evaluate(() => [...document.querySelectorAll('#rt-source [data-row]')].some(el => el.textContent.startsWith('Check whether collection is finished'))), 'The library lists catalog commands');
      assert.equal(await evaluate(() => [...document.querySelectorAll('#rt-source [data-row], .rt-slot button')].some(el => /^Branch on/.test(el.textContent))), false, 'No Branch-on items');
      assert.equal(await evaluate(() => document.querySelector('.rt-slot [data-action="command"]').getAttribute('aria-pressed')), 'true');
      await snapshot('add-all-' + width);
      await win.webContents.insertText('finished');
      await wait(() => evaluate(() => document.activeElement.matches('#rt-source input') && document.querySelector('#rt-source [data-row].top')?.textContent.startsWith('Check whether collection is finished')), 'Search ranks the command first');
      await snapshot('add-commands-' + width);
      // ⌘/Ctrl+Enter adds and keeps the slot, now after the new step, with focus still in the library; the strip's W
      // then adds a Wait after it. Two Undos restore the routine exactly.
      await key('Enter', ['meta']);
      await wait(async () => (await source())[0].nodes.length === 3, 'keep-open command insert');
      await wait(() => evaluate(() => document.activeElement.matches('#rt-source input') && document.activeElement.value === ''
        && document.querySelector('.rt-slot [role="status"]').textContent.startsWith('Added Check whether collection is finished')), 'keep-open leaves focus in the library');
      assert.ok(await evaluate(() => Boolean(document.querySelector('[data-id="after-loop"]').compareDocumentPosition(document.querySelector('.rt-addwrap.at')) & Node.DOCUMENT_POSITION_FOLLOWING)), 'The slot follows the added step');
      await key('Tab', ['shift']);
      assert.ok(await evaluate(() => document.activeElement.matches('.rt-slot [data-action="command"]')), 'Shift+Tab returns to the strip');
      await key('W');
      await wait(async () => { const nodes = (await source())[0].nodes; return nodes.length === 4 && nodes[2].cat === 'command' && nodes[3].builtinId === 'bordeaux.wait'; }, 'W adds a Wait after the kept command');
      await key('z', ['meta']); await key('z', ['meta']);
      await wait(async () => JSON.stringify(await source()) === JSON.stringify(loopBaseline), 'exact undo of keep-open adds');
      // Undo from the strip while the slot sits after the step it removes closes the slot and its library, restores the
      // routine list, and keeps focus in the flow instead of leaving a library whose picks cannot land.
      await click('[data-id="after-loop"] .rt-step-body'); await key('A'); await key('C');
      await wait(() => evaluate(() => document.activeElement?.matches('#rt-source.command input')), 'command library for undo-while-open');
      await win.webContents.insertText('finished');
      await key('Enter', ['meta']);
      await wait(async () => (await source())[0].nodes.length === 3, 'keep-open insert before undo-while-open');
      await key('Tab', ['shift']);
      await wait(() => evaluate(() => document.activeElement.matches('.rt-slot [data-action="command"]')), 'strip focus before undo-while-open');
      await key('z', ['meta']);
      await wait(async () => JSON.stringify(await source()) === JSON.stringify(loopBaseline), 'undo while the slot is open');
      await wait(() => evaluate(() => !document.querySelector('.rt-slot') && !document.querySelector('#rt-source [data-row]')
        && document.activeElement !== document.body && Boolean(document.activeElement.closest('.rt-panel'))), 'Undo closes a slot whose step it removed and keeps focus in the flow');
      await click('[data-id="after-loop"] .rt-step-body'); await key('A'); await key('C');
      await wait(() => evaluate(() => document.activeElement?.matches('#rt-source.command input')), 'command library again');
      await win.webContents.insertText('finished');
      await key('Enter');
      await wait(async () => (await source())[0].nodes.length === 3, 'one-pick command insert');
      const pickedCommand = (await source())[0].nodes[2];
      assert.deepEqual([pickedCommand.type, pickedCommand.cat, pickedCommand.title, pickedCommand.invocation], ['function', 'command', 'Check whether collection is finished', { commandId: 'completion', arguments: {} }]);
      assert.equal(pickedCommand.outputBranch, undefined);
      assert.equal(await evaluate(() => document.querySelector('.routine-insp .ctxinsp-t')?.textContent), 'Command', 'The new bound command is selected');
      await key('z', ['meta']);
      await wait(async () => JSON.stringify(await source()) === JSON.stringify(loopBaseline), 'exact undo of one-pick command');
      await click('[data-id="output-loop"] .rt-step-body');
      await click('[aria-label="Repeat mode"] button', 'Until output');
      await wait(async () => (await source())[0].nodes[0].times === undefined, 'dynamic repeat clears only its count');
      await click('#routine-repeat-output'); await key('Down'); await key('Enter');
      await wait(async () => (await source())[0].nodes[0].until?.output === 'finished', 'completed command output stop selection');
      let dynamic = (await source())[0].nodes[0];
      assert.equal(dynamic.until.nodeId, 'completion-step'); assert.equal(dynamic.until.value, true); assert.equal(dynamic.until.source, 'output');
      assert.equal(await evaluate(() => Boolean(document.querySelector('#routine-repeat-condition'))), false, 'No separate condition picker');
      await click('#routine-repeat-passes-output-loop');
      await evaluate(() => document.activeElement.select()); await win.webContents.insertText('3'); await key('Enter');
      assert.deepEqual((await source())[0].nodes[0], dynamic, 'Preview passes never change authored runtime loop');
      await snapshot('dynamic-command-repeat-' + width);
      const stableDynamic = await source(), savedBeforeDynamic = saves;
      await click('.project-chip'); await click('[role="menuitem"][data-action="save"]'); await wait(() => saves > savedBeforeDynamic, 'dynamic repeat save');
      await load('output-loop'); assert.deepEqual(await source(), stableDynamic, 'Dynamic repeat survives save/reopen without a count');
      await click('[data-id="completion-step"] .rt-step-body');
      await evaluate(() => document.querySelector('.routine-insp .choice-change').focus());
      await key('Space');
      await wait(() => evaluate(() => Boolean(document.querySelector('.routine-insp input[placeholder="Search commands"]'))), 'Space on command chooser opens its search');
      assert.ok(await evaluate(() => Boolean(document.querySelector('[aria-label="Play routine"]'))), 'Command chooser Space does not start playback');
      await key('Escape');
      assert.deepEqual(await source(), stableDynamic, 'Opening and cancelling the command chooser preserves the loop');
      // Ordinary focused buttons give Space to playback and keep Enter for their own action.
      await planned(); await click('[data-id="output-loop"] .rt-step-body');
      await evaluate(() => document.querySelector('[aria-label="Close step inspector"]').focus());
      await key('Space'); await wait(() => evaluate(() => Boolean(document.querySelector('[aria-label="Pause routine playback"]'))), 'Space starts routine from focused inspector button');
      assert.ok(await evaluate(() => Boolean(document.querySelector('.routine-insp'))), 'Space did not activate Close');
      await key('Space'); await wait(() => evaluate(() => Boolean(document.querySelector('[aria-label="Play routine"]'))), 'Space pauses routine');
      assert.equal(await evaluate(() => document.activeElement.getAttribute('aria-label')), 'Close step inspector', 'Playback keeps the focused inspector action');
      await key('Enter'); await wait(() => evaluate(() => !document.querySelector('.routine-insp')), 'Enter still activates Close');
      // A repair action shares chooser styling, but Space must never activate its mutation.
      saved.routines = structuredClone(stableDynamic);
      saved.routines[0].nodes[0].nodes[2].ends = { endWhen: { source: 'condition', conditionId: 'piece' } };
      await load('output-loop'); await click('[data-id="completion-step"] .rt-step-body');
      await evaluate(() => document.querySelector('.rt-insp-problem .choice-change').focus());
      await key('Space');
      assert.equal((await source())[0].nodes[0].nodes[2].ends.endWhen.conditionId, 'piece', 'Space does not activate an ordinary mutation styled like a chooser');
      await key('Enter');
      await wait(async () => !(await source())[0].nodes[0].nodes[2].ends?.endWhen, 'Enter still activates the repair action');
      // A populated Boolean command branch: each lane header opens its route's editor beside the flow.
      saved.routines = [{ ...routine, nodes: [
        { id: 'branch-command', type: 'function', cat: 'command', title: 'Check whether collection is finished', invocation: { commandId: 'completion', arguments: {} },
          outputBranch: { output: 'finished', schema: bool, routes: [
            { id: 'route-finished', label: 'Finished — score and leave the collection zone', operator: 'eq', value: true, nodes: [{ id: 'branch-score', type: 'path', ref: route.id }] },
            { id: 'route-more', label: 'Keep collecting', operator: 'eq', value: false, nodes: [
              { id: 'branch-wait', type: 'builtin', builtinId: 'bordeaux.wait', arguments: { durationS: .5 } }, { id: 'branch-collect', type: 'path', ref: route.id }] }] } },
        { id: 'branch-after', type: 'path', ref: route.id }] }];
      await load('branch-command'); await planned();
      const branchBaseline = await source();
      await click('.rt-brprev[aria-label="Preview Keep collecting route"] + .rt-brlbl');
      await wait(() => evaluate(() => document.activeElement?.matches('.routine-insp .command-branch-route.current[data-route-editor="route-more"]')), 'Boolean lane header opens its route editor');
      const branchFit = await evaluate(() => {
        const flow = document.querySelector('.rt-scroll'), body = document.querySelector('.routine-insp .ctxinsp-body');
        const lanes = [...document.querySelectorAll('.rt-route')].map(lane => { const radio = lane.querySelector('.rt-brprev').getBoundingClientRect(), name = lane.querySelector('.rt-brname').getBoundingClientRect(), count = lane.querySelector('.rt-brcount').getBoundingClientRect();
          return radio.right <= name.left && (name.right <= count.left || name.bottom <= count.top || count.bottom <= name.top); });
        return { flow: flow.scrollWidth <= flow.clientWidth + 1, inspector: body.scrollWidth <= body.clientWidth + 1, lanes };
      });
      assert.deepEqual(branchFit, { flow: true, inspector: true, lanes: [true, true] }, 'Lane headers and route editors fit without overlap');
      assert.deepEqual(await source(), branchBaseline, 'Opening a route never rewrites the routine');
      await snapshot('boolean-branch-route-' + width);
      const geometry = [];
      for (const place of ['Paths', 'Routines', 'Robot']) {
        await click('.places .place', place); await delay(250);
        geometry.push(await evaluate(() => {
          const project = document.querySelector('.tb-project').getBoundingClientRect(), nav = document.querySelector('.places').getBoundingClientRect();
          return { projectLeft: project.left, projectWidth: project.width, navLeft: nav.left, navWidth: nav.width };
        }));
        await snapshot('navigation-' + place.toLowerCase() + '-' + width);
      }
      assert.deepEqual(geometry[1], geometry[0]); assert.deepEqual(geometry[2], geometry[0], 'Project and tabs stay fixed across all pages');
      // No catalog: Wait remains available and can be inserted with the keyboard.
      activeCatalog = null; saved.routines = [{ ...routine, nodes: [] }]; await load(null);
      assert.equal(await evaluate(() => /condition/i.test(document.querySelector('.rt-slot.first').textContent)), false);
      // The keyboard reaches the strip from its library (Shift+Tab) and W adds a Wait.
      await click('.rt-slot.first [data-action="command"]');
      await wait(() => evaluate(() => Boolean(document.activeElement?.closest('#rt-source'))), 'command library focused');
      await key('Tab', ['shift']);
      assert.ok(await evaluate(() => document.activeElement.matches('.rt-slot.first [data-action="command"]')), 'Shift+Tab returns to the strip');
      await key('W');
      await wait(async () => (await source())[0].nodes.length === 1, 'offline Wait inserted');
      assert.equal((await source())[0].nodes[0].builtinId, 'bordeaux.wait');
      await snapshot('native-wait-no-catalog-' + width);
      // Inside a group, Path stays in the strip, unavailable: pressing it says why and opens the path beside the group
      // at its Commands lane in Paths. Nothing is added.
      activeCatalog = catalog;
      saved.routines = [{ ...routine, nodes: [{ id: 'drive', type: 'path', ref: spare.id },
        { id: 'together', type: 'group', mode: 'parallel', nodes: [{ id: 'together-wait', type: 'builtin', builtinId: 'bordeaux.wait', arguments: { durationS: .5 } }] }] }];
      await load('together'); await planned();
      const groupBaseline = await source();
      await click('[data-id="together"] .rt-step-body');
      assert.equal(await evaluate(() => [...document.querySelectorAll('.routine-insp .seg-hint')].map(el => el.textContent).find(text => text.startsWith('A group holds'))),
        'A group holds commands, waits and other groups. Paths, repeats and commands that branch stay outside it.', 'The group inspector states its rule in one reading');
      await click('[data-id="together-wait"] .rt-step-body'); await key('A');
      await wait(() => evaluate(() => document.activeElement?.matches('.rt-slot [data-action="command"]')), 'A in a group opens a slot on Command');
      const pathWhy = "Paths cannot run inside a group. To run commands while driving, add them to the path's Commands lane in Paths.";
      const blockedPath = () => evaluate(() => {
        const button = document.querySelector('.rt-slot [data-action="path"]'), why = document.getElementById(button?.getAttribute('aria-describedby'));
        return button && { disabled: button.getAttribute('aria-disabled'), label: button.getAttribute('aria-label'), title: button.title, why: why?.querySelector('p')?.textContent,
          shown: Boolean(why && !why.classList.contains('sr-only') && why.getBoundingClientRect().height > 0), open: why?.querySelector('button')?.textContent || null,
          focused: document.activeElement === button ? 'path' : document.activeElement?.closest('.rt-slot-why') ? 'open' : document.activeElement?.dataset.action };
      });
      assert.deepEqual(await blockedPath(), { disabled: 'true', label: 'Path, unavailable here', title: pathWhy, why: pathWhy, shown: false, open: null, focused: 'command' },
        'Path is listed as unavailable in a group, with its reason as its description');
      await key('Left');
      assert.equal((await blockedPath()).focused, 'path', 'ArrowLeft reaches the unavailable Path');
      await key('Enter');
      await wait(async () => (await blockedPath()).focused === 'open', 'Enter on Path shows why and focuses the way out');
      assert.deepEqual(await blockedPath(), { disabled: 'true', label: 'Path, unavailable here', title: pathWhy, why: pathWhy, shown: true, focused: 'open',
        open: 'Open “Return to the alliance zone” in Paths' }, 'The reason shows under the strip with the path beside the group');
      assert.ok(await evaluate(() => { const why = document.querySelector('.rt-slot-why').getBoundingClientRect(), scroll = document.querySelector('.rt-scroll').getBoundingClientRect();
        return why.right <= scroll.right + 1 && why.left >= scroll.left; }), 'The reason fits the flow');
      await snapshot('group-path-why-' + width);
      assert.deepEqual(await source(), groupBaseline, 'Pressing the unavailable Path adds nothing');
      await key('Enter');
      await wait(() => evaluate(() => document.activeElement?.matches('.stage-plan .pt-lane')), 'Open in Paths focuses the Commands lane');
      assert.equal(await evaluate(() => document.querySelector('.stage-plan [data-library-item][aria-current="true"]')?.dataset.libraryItem), spare.id, 'The path beside the group is open in Paths');
      await snapshot('group-path-commands-lane-' + width);
      assert.deepEqual(await source(), groupBaseline, 'Opening the path changes no routine');
      await click('.places .place', 'Routines'); await wait(() => evaluate(() => Boolean(document.querySelector('.stage-auto'))), 'back to Routines');
      // Placeholder commands take a name: "Add a command to bind later" opens on it, two placeholders read apart, Change
      // command keeps a team's name (the row then says what it runs) while a default title follows the command, an
      // empty name returns to the default, and names survive save and reload. Each rename is one Undo step.
      activeCatalog = null; saved.routines = [{ ...routine, nodes: [] }]; await load(null);
      await click('.rt-slot.first [data-action="command"]');
      await wait(() => evaluate(() => Boolean(document.querySelector('#rt-source .rt-src-none button'))), 'bind-later button');
      await click('#rt-source .rt-src-none button');
      await wait(() => evaluate(() => document.activeElement?.matches('.routine-insp .routine-step-name')), 'a new placeholder opens on its name');
      assert.equal(await evaluate(() => document.activeElement.placeholder), 'Name it for what it should do');
      await win.webContents.insertText('Intake on'); await key('Enter');
      await wait(async () => (await source())[0].nodes[0]?.title === 'Intake on', 'Enter names the placeholder');
      assert.equal((await source())[0].nodes[0].invocation, null, 'Naming binds nothing');
      const nameCommand = { id: 'completion', label: 'Check whether collection is finished', member: 'Completion.vi', parameters: [], labviewConnector: {}, outputs: [] };
      activeCatalog = { ...catalog, commands: [nameCommand] };
      saved.routines = [{ ...routine, nodes: [{ id: 'later-a', type: 'function', cat: 'command', title: 'Robot command', invocation: null },
        { id: 'later-b', type: 'function', cat: 'command', title: 'Robot command', invocation: null }] }];
      await load('later-a');
      const namingBaseline = await source();
      await click('[data-id="later-a"] .rt-step-body');
      await click('.routine-insp .routine-step-name');
      await win.webContents.insertText('Shoot'); await key('Enter');
      await wait(async () => (await source())[0].nodes[0].title === 'Shoot', 'rename a placeholder');
      assert.deepEqual(await evaluate(() => ['later-a', 'later-b'].map(id => document.querySelector('[data-id="' + id + '"] .rt-step-title').textContent)), ['Shoot', 'Robot command'], 'Two placeholders read apart');
      await evaluate(() => document.querySelector('[data-id="later-a"] .rt-step-body').focus());
      await key('z', ['meta']);
      await wait(async () => JSON.stringify(await source()) === JSON.stringify(namingBaseline), 'one Undo removes the name');
      await key('z', ['meta', 'shift']);
      await wait(async () => (await source())[0].nodes[0].title === 'Shoot', 'Redo restores the name');
      // Pressing a selected row deselects it, so select only when needed.
      const selectStep = async (id) => { if (!(await evaluate(id => document.querySelector('[data-id="' + id + '"]').classList.contains('sel'), id))) await click('[data-id="' + id + '"] .rt-step-body'); };
      const bind = async (id) => {
        await selectStep(id);
        // An unbound step's chooser is already open; a bound one opens with Change.
        if (await evaluate(() => Boolean(document.querySelector('.choice-browser[aria-label="Command"] .choice-change')))) await click('.choice-browser[aria-label="Command"] .choice-change');
        await wait(() => evaluate(() => Boolean(document.querySelector('#routine-command-results [role="option"]'))), 'command choices');
        await evaluate(label => [...document.querySelectorAll('#routine-command-results [role="option"]')].find(el => el.querySelector('strong')?.textContent === label)?.setAttribute('data-harness-pick', ''), nameCommand.label);
        await click('[data-harness-pick]');
        await wait(async () => (await source())[0].nodes.find(node => node.id === id).invocation?.commandId === 'completion', 'bind ' + id);
      };
      await bind('later-a'); await bind('later-b');
      const bound = (await source())[0].nodes;
      assert.deepEqual(bound.map(node => [node.title, node.titleIsCustom]), [['Shoot', true], ['Check whether collection is finished', undefined]], 'Change command keeps a team name and replaces a default title');
      assert.deepEqual(await evaluate(() => ['later-a', 'later-b'].map(id => { const kind = document.querySelector('[data-id="' + id + '"] .rt-step-kind'); return kind && kind.getBoundingClientRect().width > 0 ? kind.textContent : null; })),
        ['Check whether collection is finished', null], 'A named step shows the command it runs; a default one does not repeat it');
      await selectStep('later-a');
      assert.deepEqual(await evaluate(() => ({ name: document.querySelector('.routine-insp .routine-step-name').value, command: document.querySelector('.choice-browser[aria-label="Command"] .choice-current strong')?.textContent })),
        { name: 'Shoot', command: 'Check whether collection is finished' }, 'The inspector shows the name and the bound command');
      await snapshot('named-command-' + width);
      const beforeNameSave = saves;
      await click('.project-chip'); await click('[role="menuitem"][data-action="save"]');
      await wait(() => saves > beforeNameSave, 'save named commands');
      await load('later-a');
      assert.deepEqual((await source())[0].nodes.map(node => [node.title, node.titleIsCustom]), [['Shoot', true], ['Check whether collection is finished', undefined]], 'Names survive save and reload');
      await selectStep('later-a');
      await click('.routine-insp .routine-step-name'); await evaluate(() => document.activeElement.select()); await key('Backspace'); await key('Enter');
      await wait(async () => (await source())[0].nodes[0].title === 'Check whether collection is finished', 'an empty name returns to the default');
      // Flow polish: no header row (Power and About lead the field's view controls), the transport counts the flow's
      // numbered rows, its facts stay readable beside the step playing now with the inspector open, an empty group's
      // closing, the path step inspector without repeats of its row, "Delete step" everywhere, Duplicate with fresh IDs
      // (stop rules follow their copied step) as one Undo, and the rail showing an open slot instead of the old step.
      activeCatalog = { ...catalog, commands: [{ id: 'completion', label: 'Check whether collection is finished', member: 'Completion.vi', parameters: [], labviewConnector: {},
        outputs: [{ name: 'finished', label: 'Finished', schema: bool }] }] };
      saved.routines = [{ ...routine, nodes: [
        { id: 'polish-drive', type: 'path', ref: route.id },
        { id: 'polish-later', type: 'function', cat: 'command', title: 'Robot command', invocation: null },
        { id: 'polish-return', type: 'path', ref: spare.id },
        { id: 'polish-loop', type: 'repeat', times: 2, until: { source: 'output', nodeId: 'polish-check', output: 'finished', schema: bool, operator: 'eq', value: true },
          nodes: [{ id: 'polish-check', type: 'function', cat: 'command', title: 'Check whether collection is finished', invocation: { commandId: 'completion', arguments: {} }, ends: { timeoutS: 1, onTimeout: 'endRoutine' } }] },
        { id: 'polish-group', type: 'group', mode: 'parallel', nodes: [] }] }];
      await load('polish-drive'); await planned();
      const polishBaseline = await source();
      const chrome = await evaluate(() => {
        const workspace = document.querySelector('.routine-workspace').getBoundingClientRect(), field = document.querySelector('.routine-workspace-field').getBoundingClientRect();
        const tools = document.querySelector('.rt-transport .rt-tp-tools .routine-workspace-actions'), transport = document.querySelector('.rt-transport').getBoundingClientRect();
        const last = tools && [...tools.querySelectorAll('button')].at(-1).getBoundingClientRect();
        return { header: Boolean(document.querySelector('.routine-workspace-head, .routine-workspace header')), fieldAtTop: Math.abs(field.top - workspace.top) < 1,
          tools: tools ? [...tools.querySelectorAll('button')].map(button => button.getAttribute('aria-label') || button.textContent) : null,
          // Power and About end the one transport row; the field keeps only zoom, layers and fit.
          rowEnd: Boolean(last && transport.right - last.right < 12 && last.top >= transport.top && last.bottom <= transport.bottom && transport.height <= 41),
          field: [...document.querySelectorAll('.routine-workspace-field .viewctl button')].map(button => button.getAttribute('aria-label') || button.title.split(' (')[0].trim()) };
      });
      assert.deepEqual(chrome, { header: false, fieldAtTop: true, tools: ['Power', 'About preview'], rowEnd: true, field: ['Zoom out', 'Fit field', 'Zoom in', 'Field layers', 'Fit field to view'] },
        'No header row: Power and About end the transport row and the field view controls are zoom, layers and fit');
      assert.equal(await evaluate(() => document.querySelector('.rt-timeline-step').textContent), '6 steps', 'Before playback the transport counts the flow rows');
      // Item 2: an empty parallel group says plainly that it has nothing to wait for.
      assert.equal(await evaluate(() => document.querySelector('[data-id="polish-group"]').parentElement.querySelector('.rt-close-t').textContent), 'No steps yet, so it finishes the routine', 'An empty group closing has no "it"');
      // Item 4 and 3: the compact path inspector names the path (not its run order) and lists its facts as key/value
      // lines (no folder for a path outside folders), with Change path and Open in Paths as secondary buttons; every
      // step's footer says Delete step.
      await click('[data-id="polish-return"] .rt-step-body');
      const pathInspector = await evaluate(() => ({ title: document.querySelector('.routine-insp .ctxinsp-t').textContent, kind: document.querySelector('.routine-insp .ctxinsp-kind').textContent,
        facts: [...document.querySelectorAll('.routine-insp .rt-kv dt')].map(el => el.textContent), values: [...document.querySelectorAll('.routine-insp .rt-kv dd')].map(el => el.textContent),
        actions: [...document.querySelectorAll('.routine-insp .rt-insp-actions button')].map(el => el.className + ':' + el.textContent),
        foot: document.querySelector('.routine-insp .ctxinsp-foot .delbtn').textContent, label: document.querySelector('.routine-insp .ctxinsp-foot .delbtn').getAttribute('aria-label') }));
      assert.ok(/^\d+\.\d\d s$/.test(pathInspector.values[0]) && /^\d+(\.\d+)? (m|ft)$/.test(pathInspector.values[1]), 'Path facts read in display units: ' + JSON.stringify(pathInspector));
      assert.deepEqual({ ...pathInspector, values: undefined }, { title: 'Return to the alliance zone', kind: 'Path', facts: ['Duration', 'Distance'], values: undefined,
        actions: ['qbtn routine-change-path:Change path', 'qbtn routine-open-path:Open in Paths'], foot: 'Delete step', label: 'Delete path step. The path stays in Paths.' }, 'Compact path inspector without the run order');
      for (const id of ['polish-later', 'polish-loop', 'polish-group']) {
        await click('[data-id="' + id + '"] .rt-step-body');
        assert.equal(await evaluate(() => document.querySelector('.routine-insp .ctxinsp-foot .delbtn').textContent), 'Delete step', id + ' footer says Delete step');
      }
      // Items 1 and 5: playing the second path, the transport names the flow's row number; the routine's facts are the
      // flow's summary line, readable with the inspector open, and the transport does not repeat them.
      await click('[data-id="polish-return"] .rt-step-body');
      // Press the middle of the step's own segment on the track (its title is the step's name).
      const segmentCenter = (name) => evaluate((name) => {
        const bar = [...document.querySelectorAll('.rt-timeline-span')].find(el => el.title.replace(/^Up to /, '').startsWith(name)).getBoundingClientRect();
        return { x: Math.round(bar.left + bar.width / 2), y: Math.round(bar.top + bar.height / 2) };
      }, name);
      const returnSpan = await segmentCenter('Return to the alliance zone');
      await focus();
      for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...returnSpan });
      await wait(() => evaluate(() => document.querySelector('.rt-step.active')?.dataset.id === 'polish-return'), 'seek into the second path');
      const counts = await evaluate(() => {
        const summary = document.querySelector('.rt-summary'), step = document.querySelector('.rt-timeline-step'), slot = document.querySelector('.rt-tp-now').getBoundingClientRect();
        const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 1 && getComputedStyle(el).clipPath === 'none' && r.right <= summary.getBoundingClientRect().right + 1; };
        const small = step.querySelector('small').getBoundingClientRect();
        return { row: document.querySelector('.rt-step.active .rt-step-num').textContent, transport: step.querySelector('small').textContent, inspector: Boolean(document.querySelector('.routine-insp')),
          fits: summary.scrollWidth <= summary.clientWidth + 1, ordinalShown: small.left >= slot.left - 1 && small.right <= slot.right + 1,
          shown: [...summary.children].filter(visible).map(el => el.textContent).join(' | '), full: summary.querySelector('.rt-summary-full').textContent, title: summary.title,
          total: summary.querySelector('.rt-summary-total').textContent, transportTotal: document.querySelector('.rt-timeline-time small').textContent,
          repeats: /untimed|pose jump|estimated/i.test(document.querySelector('.rt-transport').textContent) };
      });
      assert.equal(counts.transport, counts.row + ' of 6', 'The transport counts the flow\'s numbered rows: ' + JSON.stringify(counts));
      assert.ok(counts.inspector && counts.fits && counts.ordinalShown && /untimed/.test(counts.shown) && counts.full.includes('not counted') && counts.title.includes('not counted'),
        'The summary line\'s facts are readable with the inspector open: ' + JSON.stringify(counts));
      assert.ok(counts.shown.includes('1 pose jump') && counts.title.includes('1 pose jump'), 'The pose jump count is shown, not cut off: ' + JSON.stringify(counts));
      assert.ok(counts.transportTotal === ' / ' + counts.total && !counts.repeats, 'The summary total matches the transport, which does not repeat the facts: ' + JSON.stringify(counts));
      await snapshot('polish-playing-' + width);
      const nestedSpan = await segmentCenter('Check whether collection is finished');
      for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...nestedSpan });
      await wait(() => evaluate(() => document.querySelector('.rt-step.active')?.dataset.id === 'polish-check'), 'seek into the nested command');
      assert.equal(await evaluate(() => document.querySelector('.rt-timeline-step small').textContent), '5 of 6');
      await click('[aria-label="Restart routine"]');
      // Item 7: with a step selected, an open slot replaces the inspector's step in the same rail; Escape or the rail's
      // close returns it. The flow keeps its width.
      const flowWidth = () => evaluate(() => Math.round(document.querySelector('.rt-scroll').getBoundingClientRect().width));
      const widthBefore = await flowWidth();
      await evaluate(() => document.querySelector('[data-id="polish-return"] .rt-step-body').focus()); await key('A');
      await wait(() => evaluate(() => Boolean(document.querySelector('.rt-slot')) && Boolean(document.querySelector('.rail-r .routine-slot-insp'))), 'the rail shows the open slot');
      assert.deepEqual(await evaluate(() => ({ title: document.querySelector('.rail-r .ctxinsp-t').textContent, dest: document.querySelector('.rail-r .routine-slot-dest').textContent, step: Boolean(document.querySelector('.rail-r [data-step-id]')) })),
        { title: 'Add step', dest: 'After “Return to the alliance zone”', step: false }, 'The rail says where the new step lands');
      assert.equal(await flowWidth(), widthBefore, 'Opening a slot keeps the flow width');
      await snapshot('polish-slot-' + width);
      await key('Escape');
      await wait(() => evaluate(() => !document.querySelector('.rt-slot') && document.querySelector('.rail-r [data-step-id]')?.dataset.stepId === 'polish-return'), 'Escape returns the inspector to the step');
      await evaluate(() => document.querySelector('[data-id="polish-return"] .rt-step-body').focus()); await key('A');
      await wait(() => evaluate(() => Boolean(document.querySelector('.rail-r .routine-slot-insp'))), 'slot again');
      await click('.rail-r [aria-label="Cancel adding a step"]');
      await wait(() => evaluate(() => !document.querySelector('.rt-slot') && document.querySelector('.rail-r [data-step-id]')?.dataset.stepId === 'polish-return'), 'the rail close cancels the slot');
      assert.deepEqual(await source(), polishBaseline, 'A cancelled slot adds nothing');
      // Item 6: Duplicate from the row menu copies a repeat with fresh IDs right after it, its stop rule following the
      // copied command; the copy is selected and one Undo removes it.
      await click('[data-id="polish-loop"] .rt-more');
      const menuItems = await evaluate(() => [...document.querySelectorAll('.rt-row-menu [role="menuitem"] .rt-menu-label')].map(el => el.firstChild.textContent));
      assert.ok(menuItems.includes('Duplicate') && menuItems.at(-1) === 'Delete step', 'The row menu offers Duplicate and says Delete step: ' + menuItems.join());
      await evaluate(() => [...document.querySelectorAll('.rt-row-menu [role="menuitem"]')].find(el => el.textContent.startsWith('Duplicate')).setAttribute('data-harness-pick', ''));
      await click('[data-harness-pick]');
      await wait(async () => (await source())[0].nodes.length === 6, 'Duplicate inserts a copy');
      const [, , , original, copy] = (await source())[0].nodes;
      assert.ok(copy.id !== original.id && copy.nodes[0].id !== original.nodes[0].id, 'The copy has fresh IDs');
      assert.equal(copy.until.nodeId, copy.nodes[0].id, 'The copy\'s stop rule reads its own command');
      assert.deepEqual({ ...copy, id: original.id, until: { ...copy.until, nodeId: original.until.nodeId }, nodes: [{ ...copy.nodes[0], id: original.nodes[0].id }] }, original, 'The copy matches the original apart from IDs');
      await wait(() => evaluate(id => document.querySelector('.rt-step.sel')?.dataset.id === id && document.querySelector('.rail-r [data-step-id]')?.dataset.stepId === id, copy.id), 'the copy is selected');
      await key('z', ['meta']);
      await wait(async () => JSON.stringify(await source()) === JSON.stringify(polishBaseline), 'one Undo removes the copy');
      activeCatalog = catalog;
      saved.routines = structuredClone(baseline);
      assert.equal(await evaluate(() => Boolean(document.querySelector('.push-button,.push-all'))), false, 'Routine has no robot Push');
      scenarios.push({ width, height, units, passed: true, layout, checks: ['nested repeat and convergence', 'long labels', 'inspector open/closed', 'native arrow/Space', 'preview source isolation', 'slot and left-rail library', 'native insert/Escape/focus', 'Shift+A insert before', 'path folders and one-click insert', 'Change path from the library', 'command library search one-pick', 'strip letters', 'unavailable Path in a group, its reason and Commands lane', 'placeholder names through binding, Undo and reload', 'no header row, Power and About in the transport row, flow-row counts, readable summary facts, empty group closing, compact path inspector, Delete step, Duplicate, slot in the rail', 'lane header route focus', 'preview radio keyboard', 'footer rules', 'step drag card, gap, Escape and one Undo', 'exact Undo', 'field over flow: divider drag, keys, reload, field selects step, playback row', 'field step badges: flow numbers, no overlap, labels on select/hover/playback, badge selects', 'pose jumps: one size on field, flow and inspector, one warning line with Why by pointer and Enter, self-follow without link, link as one Undo', 'path picker: start hints in units, ghost on hover and focus, no row movement, first step ghost only', 'local Save/reopen', 'no Push'] });
    }
    assert.deepEqual(errors, []); assert.deepEqual(confirms, []); assert.deepEqual(robotCalls, []);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, scenarios, errors, confirms, robotCalls }, null, 2));
    console.log('PASS: Routine workspace native scenarios at both supported sizes; screenshots require visual review.');
  } catch (error) {
    console.error(error);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: false, error: String(error.stack || error), scenarios, errors, confirms, robotCalls, published, saved }, null, 2));
    if (win && !win.isDestroyed()) await snapshot('failure');
    process.exitCode = 1;
  } finally { if (win && !win.isDestroyed()) win.destroy(); app.exit(process.exitCode || 0); }
});
