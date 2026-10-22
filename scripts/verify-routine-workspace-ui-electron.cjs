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
    const corpus = JSON.parse(await fs.readFile('benchmarks/planner-corpus/v2/corpus.bordeaux.json', 'utf8'));
    const route = structuredClone(corpus.paths.find(p => p.id === 'corpus-neutral-stop'));
    route.name = 'Collect along the alliance wall and return through the protected crossing';
    const routine = { id: 'routine-workspace-test', name: 'Collect until full, choose a route, then return to the alliance zone', nodes: [
      { id: 'cycle', type: 'repeat', times: 3, until: { source: 'condition', conditionId: 'piece' }, nodes: [
        { id: 'choice', type: 'decision', cond: 'piece', thenLabel: 'Full — take the scoring route', elseLabel: 'Keep collecting along the wall',
          then: [{ id: 'score', type: 'path', ref: route.id }], else: [{ id: 'collect', type: 'path', ref: route.id }] },
      ] },
      { id: 'return', type: 'path', ref: route.id },
    ] };
    saved = { ...corpus, schemaVersion: '1.1', paths: [route], pathLinks: [], routines: [routine], activeRoutineId: routine.id,
      editor: { activePathId: route.id, robotProjectBookmarkId: 'fixture', unitSystem: 'metric' } };
    win = new BrowserWindow({ show: true, width: 1440, height: 900, useContentSize: true,
      webPreferences: { preload: path.join(__dirname, 'verify-command-branches-ui-preload.cjs'), sandbox: false, contextIsolation: true } });
    win.on('focus', () => fs.appendFile(path.join(output, 'focus.jsonl'), JSON.stringify({ at: Date.now(), event: 'focus' }) + '\n').catch(() => {}));
    win.on('blur', () => fs.appendFile(path.join(output, 'focus.jsonl'), JSON.stringify({ at: Date.now(), event: 'blur' }) + '\n').catch(() => {}));
    win.webContents.on('console-message', details => { if (details.level === 'error' && !details.message.startsWith("Loading the font 'data:")) errors.push(details.message); });
    for (const [width, height, units] of [[1440, 900, 'metric'], [1100, 720, 'imperial']]) {
      win.setContentSize(width, height); saved.editor.unitSystem = units;
      await load();
      const baseline = await source();
      await planned();
      const helpClosed = await previewHelp();
      assert.ok(!helpClosed.open && helpClosed.expanded === 'false', 'Preview help starts closed');
      await click('.routine-workspace-about');
      const helpOpen = await previewHelp();
      assert.ok(helpOpen.open && helpOpen.expanded === 'true' && helpOpen.focused, 'Pointer opens preview help and keeps trigger focus');
      assert.ok(helpOpen.sentences.length <= 2 && helpOpen.sentences.includes('The robot doesn’t run routines yet.'), 'Preview help states the runtime boundary in two sentences');
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
      await click('.routine-workspace-title strong');
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
      await click('.rt-brlbl[role="radio"]', undefined);
      await key('Down'); await key('Space');
      assert.ok(await evaluate(() => document.activeElement !== document.body), 'Arrow/Space keeps focus in the flow');
      assert.deepEqual(await source(), baseline, 'Preview selection does not rewrite the routine');
      await click('[data-id="return"] .rt-step-body');
      await key('A');
      await wait(() => evaluate(() => Boolean(document.querySelector('.rt-add-pop,[role="dialog"]'))), 'insertion chooser');
      await snapshot('insert-' + width);
      assert.ok(await evaluate(() => {
        const pass = document.querySelector('.rt-timeline-pass-now'), step = document.querySelector('.rt-timeline-step');
        return !pass || step.getBoundingClientRect().left + parseFloat(getComputedStyle(step).paddingLeft) >= pass.getBoundingClientRect().right + 8;
      }), 'Playback pass and step counters have separate readable spacing');
      const insertion = await evaluate(() => {
        const menu = document.querySelector('.rt-add-menu'), list = menu.querySelector('.rt-add-list');
        const rect = menu.getBoundingClientRect(), last = [...list.querySelectorAll('[role="option"]')].at(-1).getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, lastBottom: last.bottom, listBottom: list.getBoundingClientRect().bottom, viewport: innerHeight };
      });
      assert.ok(insertion.top >= 0 && insertion.bottom <= insertion.viewport, 'Insertion menu fits the viewport');
      assert.ok(insertion.lastBottom <= insertion.listBottom + 1, 'Root insertion shows its last option when space is available');
      await key('Escape');
      assert.equal(await evaluate(() => document.activeElement.closest('.rt-step')?.dataset.id), 'return', 'Escape returns to insertion origin');
      await key('A'); await key('Enter');
      await wait(async () => (await source())[0].nodes.length === 3, 'insert a real path after shared continuation');
      const added = (await source())[0].nodes[2];
      assert.equal(added.type, 'path'); assert.equal(added.ref, route.id);
      await key('z', ['meta']);
      await wait(async () => JSON.stringify(await source()) === JSON.stringify(baseline), 'exact undo of inserted path');
      // Undo removes the inserted selected step and closes its inspector. Select a retained step before testing Close.
      await click('[data-id="return"] .rt-step-body');
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
      await click('.rt-empty-add');
      await key('Escape');
      assert.ok(await evaluate(() => document.activeElement.matches('.rt-empty-add')), 'Empty insertion Escape returns focus');
      assert.deepEqual((await source())[0].nodes, [], 'Cancelling empty insertion preserves source');
      activeCatalog = null;
      await load(null);
      assert.ok(await evaluate(() => document.querySelector('.rt-empty').textContent.includes('Wait works without robot code')), 'No catalog empty state explains native Wait and linking commands');
      await click('.rt-empty-add');
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
      await wait(() => evaluate(() => document.querySelector('.routine-insp').textContent.includes('The preview plays the path saved with it; nothing is generated.')), 'saved legacy reference explanation');
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
      assert.ok(await evaluate(() => [...document.querySelectorAll('.rt-add-menu [role="option"]')].some(el => el.textContent === 'Exit repeat')), 'Nested insertion offers Exit repeat');
      await key('Escape');
      await click('[data-id="finish"] .rt-step-body'); await snapshot('end-routine-' + width);
      saved.routines = [{ ...routine, nodes: [{ id: 'unsupported-generated', type: 'generatedTrajectory', generatorId: 'fixture', arguments: {}, fallback: { type: 'safeStop' } }] }];
      await load('unsupported-generated'); await click('[data-id="unsupported-generated"] .rt-step-body');
      assert.ok(await evaluate(() => document.querySelector('.routine-insp').textContent.includes('no robot runner supports it yet')), 'Saved unsupported definition never claims runtime generation');
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
      await click('.rt-empty-add');
      assert.equal(await evaluate(() => [...document.querySelectorAll('.rt-add-menu [role="option"]')].some(el => /condition/i.test(el.textContent))), false);
      await click('.rt-add-menu input'); await win.webContents.insertText('Wait'); await key('Enter');
      await wait(async () => (await source())[0].nodes.length === 1, 'offline Wait inserted');
      assert.equal((await source())[0].nodes[0].builtinId, 'bordeaux.wait');
      await snapshot('native-wait-no-catalog-' + width);
      activeCatalog = catalog;
      saved.routines = structuredClone(baseline);
      assert.equal(await evaluate(() => Boolean(document.querySelector('.push-button,.push-all'))), false, 'Routine has no robot Push');
      scenarios.push({ width, height, units, passed: true, layout, checks: ['nested repeat and convergence', 'long labels', 'inspector open/closed', 'native arrow/Space', 'preview source isolation', 'native insert/Escape/focus', 'exact Undo', 'field view', 'local Save/reopen', 'no Push'] });
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
