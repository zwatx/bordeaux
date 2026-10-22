const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = process.env.BORDEAUX_BRANCH_UI_OUTPUT;
app.setPath('userData', path.join(output, 'user-data'));
let win, saved, published, saves = 0;
const confirms = [], robotCalls = [], checks = [], scenarios = [];
const errors = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true);
async function wait(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(75); } throw Error('Timed out: ' + label); }
async function focusEditor() {
  const focus = { window: win.isFocused(), webContents: win.webContents.isFocused(), document: await evaluate(() => document.hasFocus()) };
  assert.deepEqual(focus, { window: true, webContents: true, document: true }, 'Native focus admission before every trusted input: ' + JSON.stringify(focus));
}
async function click(selector, text) {
  await focusEditor();
  const point = await evaluate((selector, text) => {
    const item = [...document.querySelectorAll(selector)].find((el) => !text || el.textContent.trim() === text || el.querySelector('strong')?.textContent.trim() === text || (el.getAttribute('role') === 'menuitem' && el.querySelector('span')?.textContent.trim() === text));
    if (!item || item.disabled || !item.getClientRects().length || item.closest('[inert]')) throw Error('Missing control: ' + selector + ' ' + text);
    item.scrollIntoView({ block: 'nearest' });
    const r = item.getBoundingClientRect(), x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    if (!item.contains(document.elementFromPoint(x, y))) throw Error('Obscured control: ' + selector);
    return { x, y };
  }, selector, text);
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
  await delay(80);
}
async function key(keyCode, modifiers = []) { await focusEditor(); win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await delay(70); }
async function drain() { await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))))); }
async function loadApp() {
  published = undefined; await win.loadFile(path.resolve('dist-renderer/index.html'));
  await evaluate(() => { window.__branchHarnessConfirms = []; window.confirm = message => { window.__branchHarnessConfirms.push(String(message)); window.bordeauxAPI.recordBranchHarnessConfirm(String(message)); return false; }; });
  await wait(() => evaluate(() => document.querySelector('.places .place')), 'restored project');
  if (process.platform === 'darwin') app.focus({ steal: true }); win.focus(); win.webContents.focus();
  await wait(async () => win.isFocused() && win.webContents.isFocused() && await evaluate(() => document.hasFocus()), 'initial native focus admission');
}
async function source() { await wait(() => Boolean(published?.routines), 'actual published routine source'); return structuredClone(published.routines); }
async function isolate() { assert.deepEqual(confirms, [], 'No confirm call'); assert.deepEqual(robotCalls, [], 'No robot operation'); assert.deepEqual(await evaluate(() => window.__branchHarnessConfirms), [], 'Main-world confirm recorder'); assert.equal(await evaluate(() => document.querySelector('.push-local')?.textContent), 'Routines stay local'); assert.equal(await evaluate(() => Boolean(document.querySelector('.push-button,.push-all'))), false, 'Routines have no robot Push scope'); }
async function choose(name) { await click('#command-branch-output'); await click('[role="option"]', name); }
async function snapshot(name) { await drain(); await fs.writeFile(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
const catalog = { runtime: 'labview', projectName: 'Inspection fixture', sourceFileCount: 1, scannedAt: '', warnings: [], commands: [{
  id: 'inspect', label: 'Inspect game piece and determine scoring route', member: 'Inspect.vi', ownerType: 'LabVIEW', kind: 'factory', confidence: 'confirmed', source: { file: 'Inspect.vi', line: 1 }, parameters: [],
  labviewConnector: {}, outputs: [
    { name: 'ready', label: 'Ready', schema: { kind: 'boolean', valueType: 'Boolean' } },
    { name: 'result', label: 'Result', schema: { kind: 'enum', valueType: 'enum', enumValues: ['Success', 'Retry', 'Failed'] } },
    { name: 'distance', label: 'Measured distance to scoring target', schema: { kind: 'number', valueType: 'DBL' } },
  ],
}] };
ipcMain.handle('branches:restore', () => ({ project: saved }));
// Placement mode serves its own catalog; a gate holds it in loading until a case releases it.
const placementMode = process.env.BORDEAUX_BRANCH_UI_MODE === 'placement';
let catalogGate = null, catalogServed = 0;
ipcMain.handle('branches:catalog', async () => { if (catalogGate) await catalogGate.promise; catalogServed++; return { catalog: placementMode ? placementCatalog : catalog, bookmarkId: 'fixture' }; });
ipcMain.on('branches:published', (_event, project) => { published = structuredClone(project); });
ipcMain.on('branches:confirm', (_event, message) => confirms.push(message));
ipcMain.handle('branches:robot-call', (_event, name, args) => { robotCalls.push({ name, args }); throw new Error('Unexpected robot operation: ' + name); });
ipcMain.handle('branches:save', (_event, project) => { saved = project; saves++; return { saved: true }; });
app.whenReady().then(async () => {
  try {
    if (placementMode) return await runPlacement();
    if (process.env.BORDEAUX_BRANCH_UI_MODE === 'completion') return await runCompletion();
    const corpus = JSON.parse(await fs.readFile('benchmarks/planner-corpus/v2/corpus.bordeaux.json', 'utf8'));
    const first = structuredClone(corpus.paths.find((p) => p.id === 'corpus-neutral-stop'));
    saved = { ...corpus, paths: [first], pathLinks: [], routines: [{ id: 'route-test', name: 'Command output branching', nodes: [{ id: 'inspect-step', type: 'function', cat: 'command', title: catalog.commands[0].label, invocation: { commandId: 'inspect', arguments: {} } }] }], activeRoutineId: 'route-test', editor: { activePathId: first.id, robotProjectBookmarkId: 'fixture', unitSystem: 'metric' } };
    win = new BrowserWindow({ show: true, width: 1440, height: 900, useContentSize: true, webPreferences: { preload: path.join(__dirname, 'verify-command-branches-ui-preload.cjs'), sandbox: false, contextIsolation: true } });
    win.webContents.on('console-message', (details) => { if (details.level === 'error' && !details.message.startsWith("Loading the font 'data:")) errors.push(details.message); });
    await loadApp();
    await wait(() => evaluate(() => document.querySelector('.places .place')), 'restored project');
    await click('.places .place', 'Routines'); await click('[data-library-item="route-test"]');
    await click('[data-id="inspect-step"] .rt-step-body');
    await wait(() => evaluate(() => document.querySelector('#command-branch-output')), 'inspector');
    await snapshot('empty-1440');
    await click('#command-branch-output'); await key('Down'); await key('Enter');
    await wait(() => evaluate(() => document.querySelectorAll('.rt-branch').length === 2), 'boolean routes');
    assert.equal(await evaluate(() => document.activeElement.id), 'command-branch-output');
    await snapshot('boolean-1440');
    await choose('Result');
    await wait(() => evaluate(() => document.querySelectorAll('.rt-branch').length === 4), 'named routes');
    await snapshot('named-1440');
    await choose('Measured distance to scoring target');
    await click('.command-branches button', 'Add comparison');
    assert.equal(await evaluate(() => document.querySelectorAll('.rt-branch').length), 3);
    await click('button[id^="route-operator-"]'); await key('Up'); await key('Up'); await key('Up'); await key('Enter');
    await click('input[id^="route-value-"]');
    await key('Home');
    await key('End', ['shift']);
    await focusEditor(); await win.webContents.insertText('12.5');
    await wait(() => evaluate(() => document.querySelector('input[id^="route-value-"]').value === '12.5'), 'numeric draft received before Enter');
    await key('Enter');
    await wait(() => evaluate(() => [...document.querySelectorAll('.rt-brkey')].some((el) => el.textContent === '< 12.5')), 'typed numeric comparison');

    // Add lists project paths first; Enter adds the first one inside the route.
    await click('.rt-branch .rt-add'); await key('Enter');
    await wait(() => evaluate(() => document.querySelector('.rt-branch .rt-step.path')), 'nested path');
    await click('[data-id="inspect-step"] .rt-step-body');
    await snapshot('numeric-populated-1440');
    await click('.project-chip'); await click('[role="menuitem"][data-action="save"]');
    await wait(() => saves > 0, 'save');
    assert.equal(saved.routines[0].nodes[0].outputBranch.routes.length, 3);
    assert.equal(saved.routines[0].nodes[0].outputBranch.routes[0].value, 12.5);
    assert.equal(saved.routines[0].nodes[0].outputBranch.routes[0].operator, 'lt');
    assert.equal(saved.routines[0].nodes[0].outputBranch.routes[0].nodes.length, 1);
    const baselineRoutines = structuredClone(saved.routines); await wait(async () => JSON.stringify(await source()) === JSON.stringify(baselineRoutines), 'actual published complete baseline source');
    saved.editor.unitSystem = 'imperial';
    await loadApp();
    await wait(() => evaluate(() => document.querySelector('.places .place')), 'reload');
    await click('.places .place', 'Routines'); await click('[data-library-item="route-test"]');
    await click('[data-id="inspect-step"] .rt-step-body');
    win.setContentSize(1100, 720); await delay(200);
    await wait(async () => JSON.stringify(await source()) === JSON.stringify(baselineRoutines), 'exact entire baseline routine reload in imperial fixture');
    assert.equal(await evaluate(() => document.querySelector('input[id^="route-value-"]').value), '12.5', 'Command output comparison stays exact under imperial display preference');
    await snapshot('numeric-restored-1100');
    await click('input[id^="route-value-"]');
    await snapshot('numeric-comparison-editor-1100');
    await click('#command-branch-output'); await key('Escape');
    assert.equal(await evaluate(() => document.activeElement.id), 'command-branch-output');
    await key('Tab');
    assert.ok(await evaluate(() => document.activeElement !== document.body));
    await click('button[aria-label="Close step inspector"]');
    await snapshot('numeric-inspector-closed-1100');
    catalog.commands[0].outputs = [];
    await loadApp();
    await wait(() => evaluate(() => document.querySelector('.places .place')), 'missing output reload');
    await click('.places .place', 'Routines'); await click('[data-library-item="route-test"]');
    await click('[data-id="inspect-step"] .rt-step-body');
    await wait(() => evaluate(() => document.body.textContent.includes('The saved output is missing')), 'missing output message');
    assert.equal(await evaluate(() => document.querySelectorAll('.rt-branch').length), 3);
    await click('#command-branch-output'); await key('Escape');
    await wait(async () => JSON.stringify(await source()) === JSON.stringify(baselineRoutines), 'missing output preserves complete baseline source');
    await snapshot('missing-output-1100');
    await isolate(); checks.push('Existing boolean/enum/numeric/nested path/save/reload/metric/imperial/missing-output baseline');
    const { runConsequences } = require('./verify-command-branches-ui-consequences.cjs');
    scenarios.push(...await runConsequences({ win, evaluate, wait, click, key, drain, snapshot, focusEditor, source, isolate, catalog,
      reset: async (project, nextCatalog, width, height) => { saved = structuredClone(project); catalog.commands = structuredClone(nextCatalog.commands); win.setContentSize(width, height); await loadApp(); await click('.places .place', 'Routines'); await click('[data-library-item="route-test"]'); await click('[data-id="inspect-step"] .rt-step-body'); await wait(() => evaluate(() => document.querySelector('#command-branch-output')), 'consequence inspector'); await source(); },
      save: async () => { const before = saves; await click('.project-chip'); await click('[role="menuitem"][data-action="save"]'); await wait(() => saves > before, 'explicit save IPC'); return structuredClone(saved); },
      reload: async (project) => { saved = structuredClone(project); await loadApp(); await click('.places .place', 'Routines'); await click('[data-library-item="route-test"]'); await source(); } }));
    assert.deepEqual(errors, []); await isolate();
    assert.equal(scenarios.length, 34, 'Exactly17 consequence groups per supported size');
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ passed: true, checks, scenarios, errors, confirms, robotCalls, runtime: { electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform } }, null, 2));
    console.log('PASS: retained branch baseline plus34 populated consequence groups; exact entire routines Undo/Redo/save/reload; native pointer/keyboard; both sizes; no confirm or robot operations. Captures require personal review.');
  } catch (error) { console.error(error, errors); await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ passed: false, error: error.stack || String(error), checks, scenarios, errors, confirms, robotCalls, published, saved, runtime: { electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform } }, null, 2)); if (win) await snapshot('failure'); process.exitCode = 1; }
  finally { if (win) win.destroy(); app.exit(process.exitCode || 0); }
});

async function runCompletion() {
  Object.assign(catalog, require('./command-completion-fixture.cjs').completionCatalog());
  assert.equal(catalog.commands.length, 4);
  assert.ok(catalog.commands.every(command => command.outputs.length === 1));
  const corpus = JSON.parse(await fs.readFile('benchmarks/planner-corpus/v2/corpus.bordeaux.json', 'utf8'));
  const nodes = catalog.commands.map((command, index) => ({ id: 'completion-' + index, type: 'function', cat: 'command', title: command.label, invocation: { commandId: command.id, arguments: {} } }));
  saved = { ...corpus, routines: [{ id: 'route-test', name: 'Command completion routes', nodes }], activeRoutineId: 'route-test',
    editor: { activePathId: corpus.paths[0].id, robotProjectBookmarkId: 'fixture', unitSystem: 'metric' } };
  win = new BrowserWindow({ show: true, width: 1440, height: 900, useContentSize: true,
    webPreferences: { preload: path.join(__dirname, 'verify-command-branches-ui-preload.cjs'), sandbox: false, contextIsolation: true } });
  for (const [width, height] of [[1440, 900], [1100, 720]]) {
    win.setContentSize(width, height); await loadApp();
    await click('.places .place', 'Routines'); await click('[data-library-item="route-test"]');
    for (const node of nodes) {
      await click(`[data-id="${node.id}"] .rt-step-body`);
      await click('#command-branch-output');
      assert.ok(await evaluate(() => [...document.querySelectorAll('[role="option"]')].some(el => el.textContent.includes('Completion status'))));
      if (node === nodes[0]) await snapshot('completion-picker-' + width);
      await key('End'); await key('Enter');
      assert.equal(await evaluate(() => document.activeElement.id), 'command-branch-output', 'Branch chooser restores keyboard focus');
      await wait(async () => (await source())[0].nodes.find(item => item.id === node.id).outputBranch?.routes.length === 4, 'completion routes');
      const branch = (await source())[0].nodes.find(item => item.id === node.id).outputBranch;
      assert.deepEqual(branch.routes.map(route => route.value), ['Successful', 'Aborted', 'Incomplete', undefined]);
    }
    await snapshot('completion-routes-' + width);
    const baseline = await source(), beforeSave = saves;
    await click('.project-chip'); await click('[role="menuitem"][data-action="save"]'); await wait(() => saves > beforeSave, 'completion save');
    await loadApp(); await click('.places .place', 'Routines'); await click('[data-library-item="route-test"]');
    await wait(async () => JSON.stringify(await source()) === JSON.stringify(baseline), 'exact completion branches reopen');
    await click(`[data-id="${nodes[0].id}"] .rt-step-body`); await snapshot('completion-restored-' + width);
    await isolate(); scenarios.push({ width, passed: true, commands: 4 });
  }
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ passed: true, mode: 'completion', scenarios, errors, confirms, robotCalls }, null, 2));
  console.log('PASS: all four decoded legacy commands offer completion branches, exact routes and save/reopen at both supported sizes.');
}

// Command placement (BORDEAUX_BRANCH_UI_MODE=placement): the real built App on Paths with a mocked 12-command catalog.
// Every gesture is a native sendInputEvent behind the existing focus admission; evaluate() only reads state.
const placementCatalog = { runtime: 'labview', projectName: 'Placement fixture', sourceFileCount: 1, scannedAt: '', warnings: [],
  commands: ['Align to target', 'Arm stow', 'Climb extend', 'Climb retract', 'Drive brake', 'Feed note', 'Insert piece', 'Intake start', 'Intake stop', 'Lights on', 'Shoot note', 'Wait for piece']
    .map((label, index) => ({ id: 'cmd' + index, label, member: 'Command' + index + '.vi', ownerType: 'LabVIEW', kind: 'factory', confidence: 'confirmed', source: { file: 'Command' + index + '.vi', line: 1 }, parameters: [], outputs: [], labviewConnector: {} })) };
async function runPlacement() {
  const rows = [];
  win = new BrowserWindow({ show: true, width: 1440, height: 900, useContentSize: true, webPreferences: { preload: path.join(__dirname, 'verify-command-branches-ui-preload.cjs'), sandbox: false, contextIsolation: true } });
  win.webContents.on('console-message', (details) => { if (details.level === 'error' && !details.message.startsWith("Loading the font 'data:")) errors.push(details.message); });
  const corpus = JSON.parse(await fs.readFile('benchmarks/planner-corpus/v2/corpus.bordeaux.json', 'utf8'));
  const pathOf = (id, over = {}) => ({ ...structuredClone(corpus.paths.find((p) => p.id === id)), markers: [], ...over });
  const fixture = ({ bookmark = true, paths = [pathOf('corpus-neutral-stop'), pathOf('corpus-neutral-slalom')] } = {}) => ({ ...corpus, paths, pathLinks: [], routines: [], activeRoutineId: undefined,
    editor: { activePathId: paths[0].id, ...(bookmark ? { robotProjectBookmarkId: 'fixture' } : {}), unitSystem: 'metric' } });
  const state = () => evaluate(() => {
    const a = document.activeElement, trigger = document.querySelector('#band-command'), panel = document.querySelector('.dropdown-panel');
    const box = panel?.getBoundingClientRect();
    return { active: a?.id || (a?.dataset?.selection ? 'chip:' + a.dataset.selection : a?.className || a?.tagName), focusVisible: Boolean(a?.matches(':focus-visible')),
      open: Boolean(panel), expanded: trigger?.getAttribute('aria-expanded') ?? null, trigger: Boolean(trigger), value: document.querySelector('#band-command-value')?.textContent ?? null,
      title: document.querySelector('aside.pp .pp-title')?.textContent, chips: document.querySelectorAll('.pt-chip').length,
      options: [...(panel?.querySelectorAll('[role="option"]') || [])].map((o) => o.querySelector('strong')?.textContent), activeOption: panel?.querySelector('.cmd-picker-option.active strong')?.textContent ?? null,
      inViewport: box ? box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth : null, link: [...document.querySelectorAll('aside.pp .pp-text-btn')].some((b) => /Link robot code/.test(b.textContent)) };
  });
  const markers = async (count) => { await wait(() => published?.paths?.find((p) => p.id === published.editor?.activePathId)?.markers?.length === count, 'published marker count ' + count); return published.paths.find((p) => p.id === published.editor.activePathId).markers; };
  const reset = async (project, width, height, { gate = false, inspector = false } = {}) => {
    saved = structuredClone(project); win.setContentSize(width, height);
    catalogGate = gate ? (() => { let release; const promise = new Promise((resolve) => { release = resolve; }); return { promise, release }; })() : null;
    const served = catalogServed; await loadApp(); await click('.places .place', 'Paths');
    if (project.editor.robotProjectBookmarkId && !gate) { await wait(() => catalogServed > served, 'catalog served'); await drain(); }
    await markers(0);
    if (inspector) { await click('aside.pp .pp-more'); await wait(() => evaluate(() => !document.querySelector('.rail-r').classList.contains('collapsed')), 'inspector open'); }
  };
  const clickLane = async (fraction) => {
    await focusEditor();
    const point = await evaluate((fraction) => {
      const lane = document.querySelector('.pt-lane'), r = lane.getBoundingClientRect();
      for (let k = 0; k < 40; k++) { const x = Math.round(r.x + r.width * ((fraction + k * 0.013) % 0.95 + 0.025)), y = Math.round(r.y + r.height / 2); if (document.elementFromPoint(x, y) === lane) return { x, y }; }
      throw Error('No unobscured lane point');
    }, fraction);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
    await delay(80);
  };
  const tabToLane = async () => {
    await click('.pt-wp'); // A real pointer press on the first waypoint chip, then real Tabs to the lane.
    for (let k = 0; k < 80 && !await evaluate(() => document.activeElement?.matches('.pt-lane')); k++) await key('Tab');
    assert.equal(await evaluate(() => document.activeElement?.matches('.pt-lane')), true, 'Native Tab reaches the command lane');
  };
  const opened = async (label) => {
    await wait(async () => { const s = await state(); return s.open && s.active === 'band-command-search'; }, label + ': search opens with focus');
    const s = await state();
    assert.equal(s.options.length, 12, label + ': all 12 commands'); assert.equal(s.options.includes('No command'), false, label + ': unset marker lists no No command');
    assert.equal(s.activeOption, null, label + ': nothing active before typing'); assert.equal(s.inViewport, true, label + ': panel within the viewport');
    assert.equal(s.value, 'No command', label + ': placeholder');
    return s;
  };
  const closedStays = async (label) => { await drain(); await delay(150); const s = await state(); assert.equal(s.open, false, label + ': never opens'); assert.notEqual(s.expanded, 'true', label + ': trigger closed'); return s; };
  const escapeTwice = async (label, chipIndex) => {
    await key('Escape');
    let s = await state(); assert.equal(s.open, false, label + ': first Escape closes'); assert.equal(s.active, 'band-command', label + ': first Escape focuses trigger');
    await key('Escape');
    await wait(async () => (await state()).title === 'Path', label + ': second Escape clears the selection');
    s = await state(); assert.equal(s.active, 'chip:em:' + chipIndex, label + ': second Escape focuses the chip');
  };
  const undo = () => key('Z', ['meta']);
  const sizes = [[1440, 900], [1100, 720]];
  for (const [width, height] of sizes) {
    const run = async (name, body) => {
      const started = Date.now();
      await fs.appendFile(path.join(output, 'placement-steps.jsonl'), JSON.stringify({ name, width, phase: 'start', at: started }) + '\n');
      await body(); await snapshot('placement-' + width + '-' + name);
      rows.push({ name, width, height, passed: true, ms: Date.now() - started });
      await fs.appendFile(path.join(output, 'placement-steps.jsonl'), JSON.stringify({ name, width, phase: 'done', at: Date.now() }) + '\n');
    };
    await run('lane-pointer-type-enter-undo2', async () => {
      await reset(fixture(), width, height); await clickLane(0.3); await markers(1); await opened('lane');
      await focusEditor(); await win.webContents.insertText('ins');
      await wait(async () => (await state()).activeOption === 'Insert piece', 'typing activates the first match');
      await key('Enter');
      await wait(async () => (await state()).value === 'Insert piece', 'Enter picks');
      await wait(() => published?.paths?.find((p) => p.id === published.editor?.activePathId)?.markers?.[0]?.invocation?.commandId === 'cmd6', 'command assignment published');
      assert.equal((await state()).active, 'band-command'); assert.equal((await markers(1))[0].invocation?.commandId, 'cmd6');
      await undo(); await wait(async () => !(await markers(1))[0].invocation, 'first Undo removes the command');
      await undo(); await markers(0);
    });
    await run('lane-pointer-inspector-open', async () => {
      await reset(fixture(), width, height, { inspector: true }); await clickLane(0.5); await markers(1); await opened('lane inspector open');
      await snapshot('placement-' + width + '-inspector-open-picker'); await key('Escape'); await undo(); await markers(0);
    });
    await run('keyboard-tab-lane-escape2', async () => {
      await reset(fixture(), width, height); await tabToLane(); await key('Enter'); await markers(1);
      const s = await opened('keyboard lane'); assert.equal(s.focusVisible, true, 'keyboard search focus is visible');
      await escapeTwice('keyboard', 0); assert.equal((await markers(1))[0].cmd, 'none');
      await undo(); await markers(0); // Escapes recorded nothing: one Undo removes the placement.
    });
    await run('held-lane-enter', async () => {
      await reset(fixture(), width, height); await tabToLane(); await focusEditor();
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      for (let k = 0; k < 10; k++) { await delay(40); win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['isAutoRepeat'] }); win.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers: ['isAutoRepeat'] }); }
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' }); await delay(120);
      await opened('held Enter'); assert.equal((await markers(1)).length, 1, 'held Enter places one command');
      await key('Enter'); assert.equal((await state()).open, true, 'bare Enter with an empty query picks nothing');
      await focusEditor(); await win.webContents.insertText('zzz'); await key('Enter');
      assert.equal((await state()).open, true, 'no-match Enter is inert'); assert.equal((await markers(1))[0].invocation, undefined);
      await key('Escape'); await undo(); await markers(0);
    });
    await run('field-marker-tool', async () => {
      await reset(fixture(), width, height); await click('button[aria-label="Place command"]'); await focusEditor();
      const point = await evaluate(() => {
        const seg = document.querySelector('.fieldsvg path[data-role="seg"]'), m = seg.getScreenCTM();
        for (let k = 3; k < 18; k++) { const p = seg.getPointAtLength(seg.getTotalLength() * k / 20).matrixTransform(m), x = Math.round(p.x), y = Math.round(p.y); if (document.elementFromPoint(x, y) === seg) return { x, y }; }
        throw Error('No unobscured path point');
      });
      for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
      await markers(1); await opened('field tool');
      await focusEditor(); await win.webContents.insertText('sho'); await key('Enter');
      await wait(async () => (await state()).value === 'Shoot note', 'field placement pick');
      await undo(); await undo(); await markers(0); await click('button[aria-label="Select / move"]');
    });
    await run('escape2-pointer', async () => {
      await reset(fixture(), width, height); await clickLane(0.6); await markers(1); await opened('pointer'); await escapeTwice('pointer', 0);
      await undo(); await markers(0);
    });
    await run('reselect-more-same-index', async () => {
      await reset(fixture(), width, height); await clickLane(0.4); await markers(1); await opened('first'); await escapeTwice('reselect', 0);
      await click('.pt-chip'); await wait(async () => (await state()).trigger, 'reselected marker'); await closedStays('reselect');
      await click('aside.pp .pp-more'); await closedStays('More open'); await click('aside.pp .pp-more'); await closedStays('More closed');
      const firstId = (await markers(1))[0].id;
      await undo(); await markers(0); await clickLane(0.4); const [next] = await markers(1);
      assert.notEqual(next.id, firstId, 'same index, new marker'); await opened('same-index new placement');
      await key('Escape'); await undo(); await markers(0); await key('Z', ['meta', 'shift']); await markers(1);
      await click('.pt-chip'); await wait(async () => (await state()).trigger, 'redo marker selected'); await closedStays('Redo then reselect');
    });
    await run('loading-then-late-catalog', async () => {
      await reset(fixture(), width, height, { gate: true }); await clickLane(0.5); await markers(1);
      let s = await closedStays('loading'); assert.equal(s.trigger, false, 'no chooser while the first catalog loads');
      catalogGate.release(); catalogGate = null; await wait(async () => (await state()).trigger, 'late catalog mounts the chooser');
      await closedStays('late catalog'); await click('.pt-chip'); await closedStays('reselect after late catalog');
      await click('aside.pp .pp-more'); await closedStays('More after late catalog'); await click('aside.pp .pp-more');
    });
    await run('no-catalog-then-link', async () => {
      await reset(fixture({ bookmark: false }), width, height); await clickLane(0.5); await markers(1);
      const s = await closedStays('no catalog'); assert.equal(s.link, true, 'Link robot code row'); assert.equal(s.active, 'pt-lane', 'focus stays on the lane');
      await click('aside.pp .pp-text-btn', 'Link robot code…'); await wait(async () => (await state()).trigger, 'linked catalog mounts the chooser');
      await closedStays('after link'); await click('.pt-chip'); await closedStays('reselect after link');
    });
    await run('path-and-document-switch', async () => {
      const project = fixture(); await reset(project, width, height); await clickLane(0.5); await markers(1); await opened('before switch'); await key('Escape');
      await click('[data-library-item="' + project.paths[1].id + '"]'); await wait(async () => published?.editor?.activePathId === project.paths[1].id, 'other path');
      await click('[data-library-item="' + project.paths[0].id + '"]'); await wait(async () => published?.editor?.activePathId === project.paths[0].id, 'back');
      await click('.pt-chip'); await closedStays('after path switch');
      const before = saves; await click('.project-chip'); await click('[role="menuitem"][data-action="save"]'); await wait(() => saves > before, 'explicit save');
      await loadApp(); await click('.places .place', 'Paths'); await markers(1); await click('.pt-chip'); await closedStays('after document reload');
    });
    await run('issue-after-retirement', async () => {
      // An explicit tiny angular zone makes heading tracking report a planning problem on the timeline.
      const issuePath = pathOf('corpus-neutral-slalom', { id: 'issue-path', name: 'Issue path', targets: [{ f: .5, deg: 135 }], ranges: [{ f0: .3, f1: .65, anchor: 'param', maxAngVel: .01, maxAngAccel: .01 }] });
      await reset(fixture({ paths: [issuePath] }), width, height);
      await wait(() => evaluate(() => Boolean(document.querySelector('aside.pp button[aria-haspopup="menu"]'))), 'fixture shows a planning problem');
      await click('aside.pp button[aria-haspopup="menu"]'); await key('Home'); await key('Enter');
      await wait(() => evaluate(() => Boolean(document.querySelector('aside.pp .pp-problem'))), 'issue selected before placement');
      await clickLane(0.2); await markers(1); await opened('placement while a problem exists'); await escapeTwice('issue', 0);
      await click('aside.pp button[aria-haspopup="menu"]'); await key('Home'); await key('Enter');
      await wait(() => evaluate(() => Boolean(document.querySelector('aside.pp .pp-problem'))), 'issue body shown');
      await click('.pt-chip'); await wait(async () => (await state()).trigger, 'marker after issue'); await closedStays('issue after retirement');
    });
  }
  assert.deepEqual(errors, []); assert.deepEqual(confirms, []); assert.deepEqual(robotCalls, []);
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ passed: true, mode: 'placement', placement: rows, errors, confirms, robotCalls, runtime: { electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform } }, null, 2));
  console.log('PASS: command placement ' + rows.length + ' native cases at both sizes. Captures require personal review.');
}
