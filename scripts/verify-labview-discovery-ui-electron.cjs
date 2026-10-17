const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createDemoProject } = require('../dist-electron/shared/project/defaults.js');
const { discoverLabviewProject } = require('../dist-electron/electron/labviewProject.js');
const { inspectLabviewCommands } = require('../dist-electron/electron/labviewNiInspection.js');
const { relativeLabviewLink } = require('../dist-electron/electron/projectLabviewLink.js');
const { canonicalProjectDigest } = require('../dist-electron/electron/projectSourcePersistence.js');
const selection = process.env.BORDEAUX_LABVIEW_UI_PROJECT;
const output = process.env.BORDEAUX_LABVIEW_UI_OUTPUT;
assert.ok(selection && output, 'Set BORDEAUX_LABVIEW_UI_PROJECT to the exact project and BORDEAUX_LABVIEW_UI_OUTPUT to an isolated folder');
assert.ok(path.resolve(output) !== path.dirname(path.resolve(selection)) && !path.resolve(output).startsWith(path.dirname(path.resolve(selection)) + path.sep), 'Keep UI verification output outside the reference project');
app.setPath('userData', path.join(output, 'user-data'));
let win, saved, catalog, inspected, inspectionMode = 'normal', releaseInspection, linked = false, transition = null, ready = false, adopted = false;
let admitted = false, lost = false, explicitSaves = 0;
const checks = [], errors = [], guards = [], input = [], calls = [];
const copy = value => structuredClone(value);
const context = { windowEpoch: randomUUID(), documentSessionId: randomUUID(), targetGeneration: 1 };
const location = { folderPath: path.resolve(output, 'fixture-project'), projectPath: path.resolve(output, 'fixture-project/.bordeaux-workspace.json') };
const editorLink = { labviewProjectPath: relativeLabviewLink(location.folderPath, path.resolve(selection)) };
assert.ok(editorLink.labviewProjectPath, 'Fixture must permit a portable relative link');
const session = () => ({ context: copy(context), location: copy(location), recoveryRecordId: 'discovery-ui-fixture', lifecycleReady: ready });
const same = value => assert.deepEqual(value, context, 'Exact current fixture context');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
async function wait(fn, label) { for (let index = 0; index < 200; index++) { if (await fn()) return; await delay(50); } throw new Error('Timed out: ' + label); }
async function guard(label) {
  const state = { label, window: win.isFocused(), contents: win.webContents.isFocused(), document: await evaluate(() => document.hasFocus()), lost };
  guards.push(state); assert.ok(state.window && state.contents && state.document && !lost, 'Native focus lost: ' + label);
}
async function observeDocument() {
  // Observation only; all activation below is Electron native input, never DOM click/dispatch.
  await evaluate(() => {
    window.__discoveryInput = []; window.__discoveryBlur = false;
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'keydown', 'keyup', 'input']) window.addEventListener(type, event => window.__discoveryInput.push({ type, key: event.key, trusted: event.isTrusted, focused: document.hasFocus() }), true);
    window.addEventListener('blur', () => { window.__discoveryBlur = true; });
  });
}
async function part(event, label) { await guard(label + ':before'); win.webContents.sendInputEvent(event); await delay(40); await guard(label + ':after'); }
async function receipt(start, types, label) {
  const events = await evaluate(start => window.__discoveryInput.slice(start), start);
  for (const type of types) assert.ok(events.some(event => event.type === type && event.trusted && event.focused), 'Missing trusted focused ' + type + ': ' + label);
  assert.equal(await evaluate(() => window.__discoveryBlur), false, 'Continuous document focus');
  input.push({ label, events });
}
async function pointer(selector, text) {
  await wait(() => evaluate((selector, text) => [...document.querySelectorAll(selector)].some(el => (!text || el.textContent.includes(text)) && !el.disabled && el.getClientRects().length), selector, text), selector + ' ' + (text || ''));
  await evaluate((selector, text) => [...document.querySelectorAll(selector)].find(el => (!text || el.textContent.includes(text)) && !el.disabled && el.getClientRects().length).scrollIntoView({ block: 'nearest', behavior: 'instant' }), selector, text);
  await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const point = await evaluate((selector, text) => {
    const el = [...document.querySelectorAll(selector)].find(el => (!text || el.textContent.includes(text)) && !el.disabled && el.getClientRects().length);
    const r = el.getBoundingClientRect(), x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    const hit = document.elementFromPoint(x, y);
    if (!hit || !el.contains(hit)) throw new Error('Pointer target obscured: ' + selector + ' by ' + hit?.outerHTML.slice(0, 300));
    return { x, y };
  }, selector, text);
  const start = await evaluate(() => window.__discoveryInput.length);
  await part({ type: 'mouseMove', ...point }, 'pointer move');
  await part({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 }, 'pointer down');
  await part({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 }, 'pointer up'); await delay(80);
  await receipt(start, ['pointerdown', 'pointerup'], selector + ' ' + (text || ''));
  // Compatibility mouse events may be suppressed by controls that prevent pointerdown; native pointer parts remain required.
}
async function key(keyCode, modifiers = []) {
  const start = await evaluate(() => window.__discoveryInput.length);
  await part({ type: 'keyDown', keyCode, modifiers }, 'key down:' + keyCode);
  if (keyCode === 'Enter') await part({ type: 'char', keyCode: '\r', modifiers }, 'Enter char');
  if (keyCode === 'Space') await part({ type: 'char', keyCode: ' ', modifiers }, 'Space char');
  await part({ type: 'keyUp', keyCode, modifiers }, 'key up:' + keyCode); await delay(30);
  await receipt(start, ['keydown', 'keyup'], keyCode);
}
async function text(value) { const start = await evaluate(() => window.__discoveryInput.length); await guard('text:before'); await win.webContents.insertText(value); await guard('text:after'); await receipt(start, ['input'], 'text'); }
async function shot(name) { await guard('capture:' + name); await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await delay(80); await fs.writeFile(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
async function menu() { if (!await evaluate(() => !!document.querySelector('#project-menu'))) await pointer('.project-chip'); }
async function codeAction(label) { await menu(); await pointer('#project-menu button', label); }
async function sources() { await codeAction('View sources…'); await wait(() => evaluate(() => !!document.querySelector('dialog.robot-code-sources[open]')), 'Sources modal'); }
async function selectMarker() {
  await pointer('.pt-chip[data-selection="em:0"]');
  if (!await evaluate(() => !!document.querySelector('.ctxinsp'))) await pointer('aside.pp .pp-more');
  await wait(() => evaluate(() => !!document.querySelector('.ctxinsp .cmd-command-editor')), 'marker command inspector');
  assert.equal(await evaluate(() => !!document.querySelector('.labview-project-panel')), false, 'No retired project panel');
}
async function commandBrowser() {
  if (!await evaluate(() => !!document.querySelector('#event-marker-command'))) await pointer('.cmd-command-editor .choice-change');
  await wait(() => evaluate(() => !!document.querySelector('#event-marker-command')), 'command search');
}
async function choose(label) { await commandBrowser(); await pointer('.choice-result', label); }
const check = name => { checks.push(name); console.log('PASS ' + name); };
const connection = () => ({ catalog, integration: { runtime: 'labview', installed: false, generatedCatalog: false, buildFile: 'bordeaux-catalog.json', wrapperAvailable: true }, bookmarkId: 'labview-ui', editorLink: copy(editorLink),
  recentProjects: [{ id: 'labview-ui', projectName: catalog.projectName, folderName: path.resolve(selection), lastLinkedAt: '2026-10-16T12:00:00.000Z' }] });
const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => {
  assert.ok(win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame, 'Owned main frame only'); calls.push(channel); return fn(...args);
});
// These are explicit in-memory lifecycle/storage adapters, not production main/FS certification.
handle('project:session', session);
handle('project:transitionBegin', value => { same(value); assert.equal(transition, null); transition = { id: randomUUID(), windowEpoch: context.windowEpoch }; return copy(transition); });
handle('project:transitionEnd', token => { assert.deepEqual(token, transition); transition = null; return { ended: true }; });
handle('project:lifecycleReady', (value, next) => { same(value); ready = next; return { accepted: true }; });
handle('project:startup', request => { same(request.context); assert.deepEqual(request.transition, transition); adopted = false; return { startupId: 'discovery-startup', status: 'opened', opened: { project: copy(saved), location }, needsAdoption: true, session: session(), recoveries: { entries: [], limited: false }, resuming: false }; });
handle('project:startupAdopt', (id, token) => { assert.equal(id, 'discovery-startup'); assert.deepEqual(token, transition); assert.equal(adopted, false); adopted = true; return { project: copy(saved), location, session: session() }; });
handle('project:checkpoint', request => {
  same(request.context); assert.equal(request.requestId, undefined); saved = copy(request.project);
  const operationId = randomUUID(), now = new Date().toISOString(), digest = canonicalProjectDigest(saved);
  const receipt = kind => ({ operationId, context: copy(context), snapshotRevision: request.snapshotRevision, digest, capturedAt: now, completedAt: now, kind });
  return { mode: 'background', operationId, context: copy(context), snapshotRevision: request.snapshotRevision, recovery: 'saved', source: 'saved', sourceReceipt: receipt('source'), recoveryReceipt: receipt('recovery'), location, canonicalProject: copy(saved) };
});
handle('project:saveWithCheckpoint', request => { same(request.context); assert.equal(request.saveAs, false); saved = copy(request.project); explicitSaves++; return { saved: true, location, canonicalProject: copy(saved) }; });
handle('project:listRecoveries', () => ({ entries: [], limited: false }));
handle('robotProject:listRecent', () => linked ? connection().recentProjects : []);
handle('robotProject:restore', value => { same(value); return saved.editor?.labviewProjectPath ? connection() : { status: 'unlinked', error: '' }; });
handle('robotProject:link', value => { same(value); linked = true; return connection(); });
handle('robotProject:openRecent', (id, value) => { same(value); assert.equal(id, 'labview-ui'); return connection(); });
handle('robotProject:refresh', async value => {
  same(value);
  if (inspectionMode === 'failure') throw new Error('LabVIEW inspection unavailable. Open the linked project and retry.');
  if (inspectionMode === 'pending') await new Promise(resolve => { releaseInspection = resolve; });
  catalog = inspected; return connection();
});
handle('agent:getMcpStatus', () => ({ enabled: false, generation: 0 }));
handle('agent:getActiveProposal', () => null);
handle('robot:getPairing', () => null);
handle('robotFiles:connection', () => null);
handle('appUpdates:state', () => ({ phase: 'idle', currentVersion: app.getVersion(), version: null, releaseNotes: '', progress: null, error: null, errorDetails: null, errorStage: null, projectDirty: false, channel: 'beta', visible: false }));
handle('appUpdates:visible', () => undefined);
// No robot transport, support installation, real project write, export or obsolete inspection-control handlers.
app.whenReady().then(async () => {
  try {
    await fs.mkdir(output, { recursive: true });
    catalog = await discoverLabviewProject(selection);
    assert.ok(catalog.sourceFileCount > 0, 'Use a real project with native-discovered sources');
    if (process.env.BORDEAUX_LABVIEW_UI_CATALOG) inspected = JSON.parse(await fs.readFile(process.env.BORDEAUX_LABVIEW_UI_CATALOG, 'utf8'));
    else inspected = await inspectLabviewCommands(selection, path.join(output, 'cache'));
    assert.equal(inspected.labviewDiscovery.projectFile, path.basename(selection));
    const intake = inspected.commands.find(command => command.label === 'Start Intake');
    assert.ok(intake && intake.labviewLegacy && !intake.runtimeReady, 'UI fixture must come from the actual NI-inspected Start Intake command');
    saved = createDemoProject(); saved.name = 'LabVIEW discovery verification';
    saved.paths = [saved.paths[0]]; saved.paths[0].markers = [{ id: 'discovery-marker', name: 'Discovery marker', f: 0.5, cmd: 'none' }];
    saved.routines = [{ id: 'discovery-routine', name: 'Discovery routine', nodes: [
      { id: 'first-path', type: 'path', ref: saved.paths[0].id },
      { id: 'decision', type: 'decision', cond: '', thenLabel: 'Ready', elseLabel: 'Wait', then: [{ id: 'command-step', type: 'function', cat: 'command', title: 'Inspected intake', invocation: { commandId: intake.id, arguments: Object.fromEntries(intake.parameters.map(parameter => [parameter.name, parameter.defaultValue])) } }], else: [] },
    ] }]; saved.activeRoutineId = 'discovery-routine'; saved.editor = { activePathId: saved.paths[0].id };
    win = new BrowserWindow({ show: true, width: 1440, height: 900, useContentSize: true,
      webPreferences: { contextIsolation: true, sandbox: false, backgroundThrottling: false, preload: path.resolve('dist-electron/electron/preload.js') } });
    win.on('blur', () => { if (admitted) { lost = true; guards.push({ kind: 'window-blur' }); } });
    win.webContents.on('render-process-gone', (_event, details) => { lost = true; errors.push('Renderer exited: ' + details.reason); });
    win.webContents.on('console-message', details => { if (details.level === 'error' && !details.message.startsWith("Loading the font 'data:font/woff2")) errors.push(details.message); });
    await win.loadFile(path.resolve('dist-renderer/index.html'));
    // Initial admission only; later gestures and reload never reacquire native focus.
    win.show(); win.focus(); win.webContents.focus();
    await wait(() => evaluate(() => document.hasFocus()), 'renderer keyboard focus'); await guard('initial admission'); admitted = true; await observeDocument();
    await selectMarker(); await codeAction('Link robot code…');
    await wait(() => evaluate(() => !document.querySelector('.editor-startup') && !!document.querySelector('#band-command')), 'real discovered project linked');
    await sources(); await pointer('.robot-code-sources input'); await text('no-such-source-123');
    await wait(() => evaluate(() => document.querySelector('.labview-source-list').textContent.includes('No sources match')), 'empty source search');
    await key('Escape'); assert.equal(await evaluate(() => document.querySelector('.robot-code-sources input').value), '');
    assert.equal(await evaluate(() => !!document.querySelector('dialog.robot-code-sources[open]')), true);
    await key('Tab'); assert.equal(await evaluate(() => document.activeElement.className), 'labview-source-list');
    await pointer('.robot-code-sources input'); await key('Escape');
    assert.equal(await evaluate(() => !!document.querySelector('.robot-code-sources')), false); assert.equal(await evaluate(() => document.activeElement.matches('.project-chip')), true);
    check('real project links without NI; Sources search, empty results, Escape, Tab and modal focus return work');
    inspectionMode = 'pending'; await codeAction('Refresh commands'); await wait(() => Boolean(releaseInspection), 'pending Refresh inspection'); await menu();
    // A refresh keeps the linked rows in place, disabled.
    assert.deepEqual(await evaluate(() => ['Change robot code…', 'Refresh commands'].map(label => [...document.querySelectorAll('#project-menu button')].find(el => el.textContent === label)?.disabled)), [true, true]);
    assert.ok(await evaluate(() => document.querySelector('.project-menu-code').textContent.includes('Loading…')));
    await shot('inspection-pending'); releaseInspection(); releaseInspection = null; inspectionMode = 'normal';
    await wait(() => evaluate(() => [...document.querySelectorAll('#project-menu button')].some(el => el.textContent.includes('Refresh commands') && !el.disabled)), 'Refresh complete'); await key('Escape');
    await choose('Start Intake'); await wait(() => evaluate(() => !!document.querySelector('#event-command-param-Setpoint')), 'typed parameters');
    assert.equal(await evaluate(() => document.querySelector('#event-command-param-Setpoint').type), 'number');
    await commandBrowser(); await key('Escape'); assert.equal(await evaluate(() => document.activeElement.classList.contains('choice-change')), true);
    await key('Space'); await wait(() => evaluate(() => !!document.querySelector('#event-marker-command')), 'Space opens command search'); await key('Down');
    assert.ok(await evaluate(() => document.activeElement.id === 'event-marker-command' && !!document.activeElement.getAttribute('aria-activedescendant')));
    await key('Escape'); assert.equal(await evaluate(() => document.activeElement.classList.contains('choice-change')), true);
    await key('Enter'); await wait(() => evaluate(() => !!document.querySelector('#event-marker-command')), 'Enter opens command search'); await key('Escape');
    await choose('Intake Immediate');
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(130); await pointer('#event-command-param-Operation');
      assert.deepEqual(await evaluate(() => [...document.querySelectorAll('#event-command-param-Operation-listbox .cmd-picker-option strong')].map(el => el.textContent)), ['Reserve', 'Read Current', 'Immediate', 'Start Intake']);
      await shot('enum-choices-' + width); await pointer('#event-command-param-Operation-listbox .cmd-picker-option', 'Immediate');
      assert.equal(await evaluate(() => document.querySelector('#event-command-param-Operation-value').textContent), 'Immediate');
    }
    win.setContentSize(1440, 900); await delay(130); await choose('Start Intake');
    for (const [name, value] of [['Setpoint', '42.5'], ['Description', 'Discovery parameters']]) {
      await pointer('#event-command-param-' + name); await key('A', [process.platform === 'darwin' ? 'meta' : 'control']); await text(value); await key('Tab');
      assert.equal(await evaluate(name => document.querySelector('#event-command-param-' + name).value, name), value);
    }
    check('actual NI-inspected DBL/string/enum inputs and command browser keyboard navigation remain reachable; runtimeReady stays false');
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(130); await pointer('#event-command-param-Setpoint');
      assert.equal(await evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await shot('typed-command-' + width);
      await sources(); await pointer('.robot-code-sources input'); await text('Command Sequencer');
      await wait(() => evaluate(() => document.querySelector('.robot-code-sources input').value === 'Command Sequencer'), 'source filter entered');
      await shot('source-paths-' + width); await key('Escape'); await key('Escape');
      await pointer('.ctxinsp-x'); await shot('inspector-closed-' + width); await pointer('aside.pp .pp-more');
    }
    inspectionMode = 'failure'; await codeAction('Refresh commands'); await menu();
    await wait(() => evaluate(() => [...document.querySelectorAll('#project-menu [role="alert"]')].some(el => el.textContent.includes('LabVIEW inspection unavailable'))), 'Refresh failure'); await shot('inspection-failure');
    inspectionMode = 'normal'; await pointer('#project-menu button', 'Refresh commands'); await menu();
    await wait(() => evaluate(() => ![...document.querySelectorAll('#project-menu [role="alert"]')].some(el => el.textContent.includes('LabVIEW inspection unavailable')) && [...document.querySelectorAll('#project-menu button')].some(el => el.textContent.includes('Refresh commands'))), 'Refresh retry clears failure'); await key('Escape');
    check('Refresh owns pending inspection, explicit failure and retry at supported window sizes');
    await pointer('.places .place', 'Settings'); await pointer('[aria-label="Display units"] button', 'Imperial');
    await pointer('.places .place', 'Paths'); await selectMarker(); await shot('imperial-command');
    await pointer('.places .place', 'Settings'); await pointer('[aria-label="Display units"] button', 'Metric'); await pointer('.places .place', 'Paths');
    await menu(); await pointer('#project-menu [data-action="save"]'); await wait(() => explicitSaves === 1, 'explicit in-memory Save capture');
    assert.equal(saved.editor.labviewProjectPath, editorLink.labviewProjectPath);
    await win.loadFile(path.resolve('dist-renderer/index.html')); await guard('reload admission'); await observeDocument(); await selectMarker();
    await wait(() => evaluate(() => document.querySelector('.cmd-command-editor .choice-current')?.textContent.includes('Start Intake')), 'restored command');
    assert.equal(await evaluate(() => document.querySelector('#event-command-param-Setpoint').value), '42.5');
    assert.equal(await evaluate(() => document.querySelector('#event-command-param-Description').value), 'Discovery parameters');
    assert.equal(saved.editor.labviewProjectPath, editorLink.labviewProjectPath);
    check('explicit in-memory Save and modern startup restore typed command plus the main-authored portable project link');
    await pointer('.places .place', 'Routines'); await pointer('[data-id="command-step"] .rt-step-body');
    await wait(() => evaluate(() => !!document.querySelector('#routine-command-param-Setpoint')), 'nested routine typed input');
    assert.equal(await evaluate(() => !!document.querySelector('.labview-project-panel')), false);
    inspectionMode = 'failure'; await codeAction('Refresh commands'); await menu();
    await wait(() => evaluate(() => [...document.querySelectorAll('#project-menu [role="alert"]')].some(el => el.textContent.includes('LabVIEW inspection unavailable'))), 'routine Refresh failure'); await shot('routine-inspection-failure');
    inspectionMode = 'normal'; await pointer('#project-menu button', 'Refresh commands'); await menu();
    await wait(() => evaluate(() => !document.querySelector('#project-menu [role="alert"]') && [...document.querySelectorAll('#project-menu button')].some(el => el.textContent.includes('Refresh commands'))), 'routine Refresh retry'); await key('Escape');
    assert.equal(await evaluate(() => !!document.querySelector('#routine-command-param-Setpoint')), true); await shot('routine-typed-command');
    check('populated routine branch retains typed controls while global Refresh displays failure/retry');
    await guard('terminal'); assert.equal(await evaluate(() => window.__discoveryBlur), false); assert.deepEqual(errors, []); assert.equal(checks.length, 5); assert.equal(new Set(checks).size, 5);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'passed', checks, errors, guards, input, calls, explicitSaves,
      note: 'Built App/Worker and production preload, actual disk discovery and actual NI-inspected catalog. Modern lifecycle, persistence and Refresh pending/failure/retry are in-memory IPC fixtures; editorLink uses the compiled main relative-link helper. No real project save/export, main IPC certification or robot transport.' }, null, 2));
    app.exit(0);
  } catch (error) {
    console.error(error); if (win) await shot('failure').catch(() => {});
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'failed', checks, errors, guards, input, calls, explicitSaves, error: String(error.stack || error) }, null, 2));
    app.exit(1);
  }
});
