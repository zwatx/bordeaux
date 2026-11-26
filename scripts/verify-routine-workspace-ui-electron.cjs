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
// Preview help is a small native popover under its trigger; it must overlay the flow, never move it.
const previewHelp = () => evaluate(() => {
  const trigger = document.querySelector('.routine-workspace-about'), help = document.querySelector('#routine-preview-notes');
  const flow = document.querySelector('.rt-scroll').getBoundingClientRect(), anchor = trigger.getBoundingClientRect(), rect = help.getBoundingClientRect();
  return { open: help.matches(':popover-open'), expanded: trigger.getAttribute('aria-expanded'), focused: document.activeElement === trigger,
    sentences: help.textContent.trim().split(/(?<=[.!?])\s+/), flow: [flow.x, flow.y, flow.width, flow.height].join(),
    fits: rect.left >= 8 && rect.right <= innerWidth - 8 && rect.top >= anchor.bottom && rect.bottom <= innerHeight - 8 && rect.width <= 300 };
});
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
      assert.ok(helpOpen.fits, 'Preview help fits under its trigger');
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
      await click('.routine-workspace-head');
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
      const grip = await evaluate(() => {
        const row = document.querySelector('[data-id="return"]'), r = row.querySelector('.rt-grip').getBoundingClientRect(), box = row.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), width: box.width, height: box.height };
      });
      const header = await evaluate(() => { const r = document.querySelector('[data-id="cycle"]').getBoundingClientRect(); return { x: Math.round(r.x + 60), y: Math.round(r.y + r.height / 4) }; });
      const stepDrag = async (to) => {
        await focus();
        win.webContents.sendInputEvent({ type: 'mouseDown', x: grip.x, y: grip.y, button: 'left', clickCount: 1 });
        await delay(40);
        win.webContents.sendInputEvent({ type: 'mouseMove', x: grip.x + 8, y: grip.y - 8, button: 'left', modifiers: ['leftButtonDown'] });
        await wait(() => evaluate(() => Boolean(document.querySelector('.rt-drag-card'))), 'the step lifts into a card');
        win.webContents.sendInputEvent({ type: 'mouseMove', x: to.x, y: to.y, button: 'left', modifiers: ['leftButtonDown'] });
        await wait(() => evaluate(() => Boolean(document.querySelector('.rt-group.drop-before'))), 'a gap opens before the repeat');
        await delay(260);
      };
      await stepDrag(header);
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
      assert.ok(lifted.target && Math.abs(lifted.gap - grip.height - 4) < 1 && Math.abs(lifted.well - grip.height + 4) < 1, 'A gap the card\'s height opens at the target: ' + JSON.stringify(lifted));
      await snapshot('step-drag-' + width);
      await key('Escape');
      await wait(() => evaluate(() => !document.querySelector('.rt-drag-card, .rt-panel.dragging, .drop-before, .drop-after')), 'Escape drops nothing');
      win.webContents.sendInputEvent({ type: 'mouseUp', x: header.x, y: header.y, button: 'left', clickCount: 1 });
      await delay(120);
      assert.deepEqual(await source(), baseline, 'Escape cancels the drag without an edit');
      await stepDrag(header);
      win.webContents.sendInputEvent({ type: 'mouseUp', x: header.x, y: header.y, button: 'left', clickCount: 1 });
      await wait(async () => (await source())[0].nodes.map(node => node.id).join() === 'return,cycle', 'the drop moves the step before the repeat');
      assert.ok(await evaluate(() => !document.querySelector('.rt-drag-card, .rt-panel.dragging')), 'The card is gone after the drop');
      await key('z', ['meta']);
      await wait(async () => JSON.stringify(await source()) === JSON.stringify(baseline), 'one Undo restores the order');
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
      await snapshot('insert-' + width);
      assert.ok(await evaluate(() => {
        const pass = document.querySelector('.rt-timeline-pass-now'), step = document.querySelector('.rt-timeline-step');
        return !pass || step.getBoundingClientRect().left + parseFloat(getComputedStyle(step).paddingLeft) >= pass.getBoundingClientRect().right + 8;
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
      await key('Enter');
      await wait(async () => (await source())[0].nodes.length === 3, 'insert a real path after shared continuation');
      const added = (await source())[0].nodes[2];
      assert.equal(added.type, 'path'); assert.equal(added.ref, route.id);
      assert.ok(await evaluate(() => !document.querySelector('#rt-source') && document.activeElement.closest('.rt-step')?.dataset.id), 'A pick closes the library and focuses the new step');
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
      await click('.routine-workspace-views button', 'Field preview');
      await snapshot('field-' + width);
      await click('.routine-workspace-views button', 'Flow');
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
      // An empty routine shows its first step's slot in place, without an explanation or a button to open it.
      assert.ok(await evaluate(() => !/No steps yet|Steps run top to bottom/.test(document.querySelector('.rt-panel').textContent)
        && Boolean(document.querySelector('.rt-empty .rt-slot.first [data-action="wait"]')) && !document.querySelector('#rt-source')), 'Empty routine shows its first step slot');
      await click('.rt-slot.first [data-action="path"]');
      await wait(() => evaluate(() => document.activeElement?.matches('#rt-source input')), 'Path opens the library from the first step');
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
      for (const place of ['Paths', 'Routines', 'Settings']) {
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
      activeCatalog = catalog;
      saved.routines = structuredClone(baseline);
      assert.equal(await evaluate(() => Boolean(document.querySelector('.push-button,.push-all'))), false, 'Routine has no robot Push');
      scenarios.push({ width, height, units, passed: true, layout, checks: ['nested repeat and convergence', 'long labels', 'inspector open/closed', 'native arrow/Space', 'preview source isolation', 'slot and left-rail library', 'native insert/Escape/focus', 'Shift+A insert before', 'path folders and one-click insert', 'Change path from the library', 'command library search one-pick', 'strip letters', 'lane header route focus', 'preview radio keyboard', 'footer rules', 'step drag card, gap, Escape and one Undo', 'exact Undo', 'field view', 'local Save/reopen', 'no Push'] });
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
