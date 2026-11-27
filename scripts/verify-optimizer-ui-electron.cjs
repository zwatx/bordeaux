const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { installOptimizerWorkerEvidence } = require('./verify-optimizer-ui-workers.cjs');

const output = process.env.BORDEAUX_OPTIMIZER_UI_OUTPUT;
const html = process.env.BORDEAUX_OPTIMIZER_UI_HTML;
const fixture = JSON.parse(Buffer.from(process.env.BORDEAUX_OPTIMIZER_UI_PROJECT, 'base64').toString('utf8'));
let saved = structuredClone(fixture);
let saveCount = 0;
const checks = [];
const errors = [];
const knownConsoleWarnings = [];
const workerEvidence = { documents: [], checkpoints: [] };
let documentNumber = 0;
let observerRegistration;
const observerSource = installOptimizerWorkerEvidence.toString();
const sha256 = value => createHash('sha256').update(value).digest('hex');
app.setPath('userData', path.join(output, 'user-data'));
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
ipcMain.handle('optimizer-ui:restore', () => ({ project: structuredClone(saved) }));
ipcMain.handle('optimizer-ui:save', (_event, project) => { saved = structuredClone(project); saveCount += 1; return { saved: true }; });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let window;
async function evaluate(fn, ...args) {
  return window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true);
}
async function waitFor(fn, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (errors.length) throw new Error(`Renderer error while waiting for ${description}: ${errors.join('; ')}`);
    const value = await fn();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}
async function focusEditor() {
  assert.ok(window.isFocused(), 'Native editor window lost focus');
  assert.ok(window.webContents.isFocused(), 'Native editor webContents lost focus');
  assert.equal(await evaluate(() => document.hasFocus()), true, 'Renderer document lost focus');
}
async function drain() {
  await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
}
async function capture(name) {
  await drain();
  await fs.writeFile(path.join(output, name), (await window.webContents.capturePage()).toPNG());
}
async function captureMinimum(name) {
  window.setContentSize(1100, 720);
  await delay(120);
  await capture(name);
  window.setContentSize(1440, 900);
  await drain();
}
async function workerState() {
  const evidence = await evaluate(() => {
    const observer = window.__optimizerWorkers;
    return observer && { observerSha256: observer.observerSha256,
      installedAt: observer.installedAt, installedReadyState: observer.installedReadyState, installedScriptCount: observer.installedScriptCount,
      installed: observer.isInstalled(), jobs: observer.jobs, problems: observer.problems };
  });
  assert.ok(evidence, 'Worker observer must be installed before application scripts');
  assert.equal(evidence.installed, true, 'Worker observation must remain installed');
  assert.equal(evidence.installedReadyState, 'loading', 'New-document observation must start during document loading');
  assert.equal(evidence.installedScriptCount, 0, 'Worker observation must precede page scripts');
  assert.equal(evidence.observerSha256, observerRegistration.observerSha256, 'Document must run the registered observer source');
  assert.deepEqual(evidence.problems, [], 'Worker observer must retain complete evidence');
  return evidence;
}
async function verifyObserverRegistration() {
  const registered = window.webContents.session.getPreloadScripts().find(script => script.id === observerRegistration.id);
  assert.deepEqual(registered, { id: observerRegistration.id, type: 'frame', filePath: observerRegistration.filePath });
  const stat = await fs.lstat(observerRegistration.filePath);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Registered observer must remain a regular file');
  assert.equal(sha256(await fs.readFile(observerRegistration.filePath)), observerRegistration.sha256, 'Registered preload source must remain unchanged');
  assert.equal(await fs.readFile(observerRegistration.observerSourceFile, 'utf8'), observerSource);
}
async function archiveWorkers(reason = 'navigation') {
  if (!documentNumber) return;
  await verifyObserverRegistration();
  workerEvidence.documents.push({ document: documentNumber, reason, ...await workerState() });
  await fs.writeFile(path.join(output, 'worker-evidence.json'), JSON.stringify(workerEvidence, null, 2));
}
async function loadApp() {
  await archiveWorkers();
  await verifyObserverRegistration();
  await window.loadFile(html);
  documentNumber += 1;
  // Initial admission for each fresh document only. No mid-flow focus recovery.
  if (process.platform === 'darwin') app.focus({ steal: true });
  window.focus(); window.webContents.focus();
  await waitFor(async () => window.isFocused() && window.webContents.isFocused() && await evaluate(() => document.hasFocus()), 'initial native document focus');
  await workerState();
}
async function settledWorkers() {
  let previousCount = -1;
  return waitFor(async () => {
    await drain();
    const state = await workerState();
    const unchanged = state.jobs.length === previousCount;
    previousCount = state.jobs.length;
    return unchanged && state.jobs.every(job => job.status !== 'pending') ? state : false;
  }, 'all issued planning jobs to settle before request accounting');
}
async function markJobs(label) {
  const state = await settledWorkers();
  assert.ok(state.jobs.some(job => job.mode === 'editing'), 'Must observe actual editing Worker.postMessage requests');
  return { label, document: documentNumber, count: state.jobs.length };
}
async function jobsSince(mark) {
  assert.equal(mark.document, documentNumber, 'Request checkpoint must belong to the current document');
  return (await settledWorkers()).jobs.slice(mark.count);
}
async function noJobsSince(mark) {
  const jobs = await jobsSince(mark);
  workerEvidence.checkpoints.push({ ...mark, jobs, passed: jobs.length === 0 });
  assert.deepEqual(jobs, [], `${mark.label}: opening/reopening must issue zero additional planning jobs`);
  check(mark.label);
}
/** The latest editing plan of a path, which must be the time on screen. Every path plans its own waypoints. */
async function strictEditing(pathId, displayed) {
  const evidence = await waitFor(() => evaluate((pathId, time) => {
    const result = window.__optimizerWorkers.latestEditing(pathId);
    return result?.value?.status === 'ok' && result.value.comparison?.status === 'ready'
      && result.value.trajectory?.totalTimeS === time ? result : null;
  }, pathId, Number(displayed.time)), 'the complete strict editing projection');
  assert.equal(evidence.job.quality, 'final');
  assert.equal(evidence.job.density, 56);
  assert.equal(evidence.value.comparison.previewDensity, 56);
  assert.equal(evidence.value.comparison.projectionVersion, 1);
  assert.equal(evidence.value.trajectory.totalTimeS, Number(displayed.time));
  assert.deepEqual(evidence.value.derived.finalTrajectory, evidence.value.trajectory, 'Projection must preserve the full strict trajectory');
  assert.deepEqual(evidence.value.derived.trajectorySamples, evidence.value.bestEffort.samples);
  await fs.writeFile(path.join(output, `editing-${documentNumber}-${evidence.job.sequence}.json`), JSON.stringify(evidence, null, 2));
  return evidence;
}
async function click(selector, text, clickCount = 1) {
  await focusEditor();
  await waitFor(() => evaluate((selector, text) => {
    const button = [...document.querySelectorAll(selector)].find((item) => text == null || (item.querySelector(':scope > span:first-child')?.textContent || item.textContent).trim() === text);
    return Boolean(button && !button.disabled && !button.closest('[inert]') && button.checkVisibility());
  }, selector, text), `an available ${text || selector} control`);
  const point = await evaluate((selector, text) => {
    const button = [...document.querySelectorAll(selector)].find((item) => text == null || (item.querySelector(':scope > span:first-child')?.textContent || item.textContent).trim() === text);
    button.scrollIntoView({ block: 'nearest' });
    const box = button.getBoundingClientRect();
    const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height / 2);
    if (!button.contains(document.elementFromPoint(x, y))) throw new Error(`Control is obscured: ${selector}`);
    return { x, y };
  }, selector, text);
  await focusEditor();
  window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount, ...point });
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount, ...point });
  await delay(40);
}
async function snapshot() {
  return evaluate(() => ({
    time: document.querySelector('[aria-label="Trajectory playback position"]')?.getAttribute('aria-valuemax'),
    geometry: document.querySelector('svg path[stroke="#05060a"][stroke-opacity="0.75"]')?.getAttribute('d'),
    path: document.querySelector('.library-pick[aria-current="true"] .library-name')?.textContent,
    status: document.querySelector('.optimizer-outcome[role="status"]')?.textContent,
    pending: Boolean(document.querySelector('.stage-plan .fieldcol[data-planning-ready="false"]')),
  }));
}
async function ready() {
  await waitFor(async () => {
    const state = await snapshot();
    return state.time && state.geometry && !state.pending && await evaluate(() =>
      !document.querySelector('.library-structure [inert]') && !document.body.textContent.includes('Preparing trajectory'));
  }, 'the authoritative normal trajectory');
}
async function save() {
  const before = saveCount;
  await click('.project-chip');
  await click('[role="menuitem"][data-action="save"]');
  await waitFor(() => saveCount > before, 'the mocked save to complete');
  return structuredClone(saved);
}
async function stable(expected, milliseconds, label) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const state = await snapshot();
    assert.equal(state.time, expected.time, `${label}: displayed time changed while idle`);
    assert.equal(state.geometry, expected.geometry, `${label}: geometry changed while idle`);
    await delay(150);
  }
}
async function switchPath(name) {
  await click('.library-name', name);
  await waitFor(async () => (await snapshot()).path === name, 'the selected path');
  await ready();
}
async function finishSearch(apply = 'Apply same shape') {
  await waitFor(() => evaluate(() => [...document.querySelectorAll('.optimizer-panel button')]
    .some((item) => item.textContent === 'Cancel')), 'the explicit search to start');
  await waitFor(() => evaluate(() => ![...document.querySelectorAll('.optimizer-panel button')]
    .some((item) => item.textContent === 'Cancel')), 'the explicit search to finish', 12_000);
  await waitFor(() => evaluate((apply) => [...document.querySelectorAll('.optimizer-panel button')]
    .some((item) => item.textContent === apply), apply), 'an improved candidate', 2000);
}
async function openSettings() {
  if (!await evaluate(() => document.querySelector('.optimizer-settings')?.open)) {
    await click('.optimizer-settings summary');
  }
}
async function assertCompactResult() {
  // The result replaces Cancel; wait until its Apply action is available.
  await waitFor(() => evaluate(() => {
    const primary = document.querySelector('.optimizer-main.primary');
    return primary && primary.textContent === 'Apply same shape' && !primary.disabled && primary.checkVisibility();
  }), 'the enabled Apply action', 2000);
  const state = await evaluate(() => {
    const panel = document.querySelector('.optimizer-panel');
    return {
      text: panel.innerText,
      settingsOpen: panel.querySelector('.optimizer-settings').open,
      detailsOpen: panel.querySelector('.optimizer-details')?.open,
      freedomPresent: Boolean(panel.querySelector('.optimizer-corridor input')),
      rows: [...panel.querySelectorAll('.optimizer-choice')].map((row) => row.getAttribute('aria-label')),
      width: panel.getBoundingClientRect().width,
    };
  });
  assert.equal(state.settingsOpen, false, 'Search options must start collapsed');
  assert.equal(state.detailsOpen, false, 'Solver diagnostics must start collapsed');
  assert.equal(state.freedomPresent, false, 'Route optimization must not expose a seed-deviation setting');
  assert.ok(state.text.trim().split(/\s+/).length <= 45, `Result panel must stay concise: ${state.text}`);
  assert.ok(!state.text.includes('Limited by'), 'Detailed physics must be hidden by default');
  assert.deepEqual(state.rows, ['Preview current path trajectory', 'Preview same shape trajectory', 'Preview new route trajectory, not faster than same shape']);
  assert.equal(state.width, 320, 'The result inspector must match the fixed inspector width');
}

/** One result row ('same shape' or 'new route') as rendered, whether it is a choice or greyed with a reason. */
async function resultRow(name) {
  return evaluate((name) => {
    const row = document.querySelector(`.optimizer-choice[aria-label^="Preview ${name} trajectory"]`);
    if (!row) return null;
    row.scrollIntoView({ block: 'nearest' });
    const box = row.getBoundingClientRect(), panel = document.querySelector('.optimizer-panel').getBoundingClientRect();
    const note = row.querySelector(':scope > small'), noteBox = note?.getBoundingClientRect();
    return { label: row.getAttribute('aria-label'), disabled: row.disabled, pressed: row.getAttribute('aria-pressed'), title: row.title,
      note: note?.textContent ?? null, time: row.querySelector(':scope > b')?.textContent ?? null,
      opacity: getComputedStyle(row.querySelector('.optimizer-choice-name')).opacity, noteOpacity: note && getComputedStyle(note).opacity,
      focused: document.activeElement === row,
      inside: box.left >= panel.left && box.right <= panel.right && box.top >= 0 && box.bottom <= innerHeight,
      noteInside: !noteBox || (noteBox.left >= box.left && noteBox.right <= box.right && note.scrollWidth <= note.clientWidth + 1),
      x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  }, name);
}
const shapeRow = () => resultRow('same shape');
/** The styled tooltip's text once it is open, or null. */
const tooltipText = () => evaluate(() => { const tip = document.querySelector('#app-tooltip'); return tip?.matches(':popover-open') ? tip.textContent : null; });
/** Rests the pointer away from any titled control, which closes a hover tooltip and puts its title back. */
async function restPointer() {
  window.webContents.sendInputEvent({ type: 'mouseMove', x: 700, y: 400 });
  await delay(80);
}
async function pressKey(keyCode, modifiers = []) {
  await focusEditor();
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  if (keyCode === 'Enter') window.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await delay(60);
}

function check(name) { checks.push(name); console.log(`PASS ${name}`); }

/** Ctrl+Z (Cmd+Z on macOS), or Ctrl+Shift+Z to redo. */
async function history(redo) {
  await focusEditor();
  const modifiers = [process.platform === 'darwin' ? 'meta' : 'control', ...(redo ? ['shift'] : [])];
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers });
}
/** Field positions, in SVG units, of the selected path's zone ends and command markers. */
async function placements() {
  return evaluate(() => {
    const at = (selector) => [...document.querySelectorAll(selector)].map((element) => {
      const match = element.closest('g[transform]').getAttribute('transform').match(/translate\(([-\d.e]+) ([-\d.e]+)\)/);
      return [Number(match[1]), Number(match[2])];
    });
    return { zones: [...at('circle[data-role="rs"]:first-child'), ...at('circle[data-role="re"]:first-child')], markers: at('rect[data-role="em"]') };
  });
}
function samePlaces(first, second, label) {
  for (const key of ['zones', 'markers']) {
    assert.equal(first[key].length, second[key].length, `${label}: ${key} count`);
    first[key].forEach((point, index) => assert.ok(Math.hypot(point[0] - second[key][index][0], point[1] - second[key][index][1]) < 0.5,
      `${label}: ${key} ${index} moved from ${point} to ${second[key][index]}`));
  }
}
/** Types a value into the selected waypoint's X or Y field in the docked properties, committing with Tab. */
async function setWaypointCoordinate(axis, value) {
  const selector = await evaluate((axis) => {
    const label = [...document.querySelectorAll('.pp label')].find(item => item.textContent === axis);
    if (!label?.control) throw new Error('Waypoint ' + axis + ' input missing');
    return '.pp input[id=' + JSON.stringify(label.htmlFor) + ']';
  }, axis);
  await click(selector);
  await evaluate(selector => document.querySelector(selector).select(), selector);
  await focusEditor();
  await window.webContents.insertText(String(value));
  await waitFor(() => evaluate((selector, value) => document.querySelector(selector)?.value === value, selector, String(value)), `the ${axis} draft`);
  await focusEditor();
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
  await waitFor(() => evaluate(selector => document.activeElement !== document.querySelector(selector), selector), `the ${axis} edit to commit`);
}
/** Types a value into a labelled Robot page number and commits it with Tab. */
async function setRobotNumber(label, value) {
  const selector = `input[aria-label="${label}"]`;
  await click(selector);
  await evaluate((selector) => document.querySelector(selector).select(), selector);
  await focusEditor();
  await window.webContents.insertText(String(value));
  await focusEditor();
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
  await waitFor(() => evaluate((selector) => document.activeElement !== document.querySelector(selector), selector), `${label} to commit`);
}
const added = (project, index) => project.paths[index].waypoints.map((waypoint) => Boolean(waypoint.optimizerAdded));

app.whenReady().then(async () => {
  window = new BrowserWindow({ show: true, width: 1440, height: 900, useContentSize: true,
    webPreferences: { contextIsolation: true, sandbox: false, backgroundThrottling: false,
      preload: path.join(__dirname, 'verify-optimizer-ui-preload.cjs') } });
  window.webContents.on('console-message', (details) => {
    if (details.level !== 'error') return;
    if (details.message.startsWith("Loading the font 'data:font/woff2")) knownConsoleWarnings.push(details.message);
    else errors.push(details.message);
  });
  window.webContents.on('render-process-gone', (_event, details) => errors.push(`Renderer process gone: ${details.reason}`));
  window.webContents.on('preload-error', (_event, filePath, error) => errors.push(`Preload failed (${filePath}): ${error.message}`));
  try {
    const directory = await fs.mkdtemp(path.join(output, 'worker-observer-'));
    const filePath = path.join(directory, 'preload.cjs'), observerSourceFile = path.join(directory, 'observer.js');
    const observerSha256 = sha256(observerSource);
    const source = "const { contextBridge } = require('electron');\nif (process.isMainFrame) contextBridge.executeInMainWorld({ func: "
      + observerSource + ', args: [' + JSON.stringify(observerSha256) + '] });\n';
    await fs.writeFile(filePath, source, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(observerSourceFile, observerSource, { flag: 'wx', mode: 0o600 });
    // Synchronous registration precedes loadFile; Electron runs frame preloads before the fixture API preload.
    const id = window.webContents.session.registerPreloadScript({ type: 'frame', filePath });
    assert.ok(typeof id === 'string' && id.length > 0, 'Registered frame preload ID required');
    observerRegistration = { mechanism: 'registered-frame-preload/contextBridge.executeInMainWorld', id, type: 'frame',
      filePath, observerSourceFile, sha256: sha256(source), observerSha256 };
    await fs.writeFile(path.join(output, 'observer-registration.json'), JSON.stringify(observerRegistration, null, 2));
    await loadApp();
    await ready();
    assert.equal((await snapshot()).path, fixture.paths[0].name);
    check('normal trajectory is ready');
    assert.ok(await evaluate(() => document.querySelector('.library-rail').checkVisibility()));
    // Reordering lives in the full inspector (More) for the selected waypoint; Enter presses the button.
    const pressButton = async (label) => {
      assert.ok(await evaluate((label) => { const b = [...document.querySelectorAll('.ctxinsp button')].find((x) => x.textContent === label); b?.focus(); return document.activeElement === b; }, label), label + ' is focusable');
      await focusEditor();
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      await delay(250);
    };
    await click('.pt-wp', '1');
    await click('.pp-more');
    await pressButton('Move later');
    const reordered = await save();
    assert.deepEqual(reordered.paths[0].waypoints[2], fixture.paths[0].waypoints[1]);
    await waitFor(() => evaluate(() => document.querySelector('.ctxinsp .ctxinsp-t')?.textContent === 'Waypoint 2'), 'the moved waypoint stays selected');
    await pressButton('Move earlier');
    assert.deepEqual((await save()).paths[0].waypoints, fixture.paths[0].waypoints);
    await click('.pp-more');
    check('waypoints reorder from the keyboard in the full inspector and keep their selection');
    await click('.places .place', 'Routines');
    assert.ok(await evaluate(() => document.querySelector('.library-rail').checkVisibility() && !document.querySelector('.pathlib-panel')));
    check('routine and path libraries remain docked beside the field');
    await click('.app-settings-trigger');
    await click('.app-settings .seg-i', 'Imperial');
    await delay(250);
    await capture('document-settings.png');
    await click('.app-settings-close');
    await click('.places .place', 'Routines');
    assert.equal(await evaluate(() => document.documentElement.dataset.units), 'imperial');
    await waitFor(() => evaluate(() => !document.querySelector('.routine-status')), 'routine preview');
    await delay(250);
    await capture('routine-toolbar.png');
    await click('.places .place', 'Paths');
    const imperialProject = await save();
    assert.equal(imperialProject.editor?.unitSystem, undefined, 'display units stay out of the project');
    assert.deepEqual(imperialProject.paths[0].waypoints, fixture.paths[0].waypoints);
    await loadApp();
    await ready();
    assert.equal(await evaluate(() => document.documentElement.dataset.units), 'imperial');
    check('display units reopen from this machine, stay out of the saved project, and leave geometry unchanged');
    await click('.app-settings-trigger');
    await click('.app-settings .seg-i', 'Metric');
    await click('.app-settings-close');
    await ready();
    const normal = await snapshot();
    await strictEditing(fixture.paths[0].id, normal);
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      window.setContentSize(width, height);
      await delay(250);
      // The full inspector opens from the docked properties' More.
      if (await evaluate(() => document.querySelector('.pp-more')?.getAttribute('aria-expanded') !== 'true')) await click('.pp-more');
      await capture(`inspector-${width}x${height}.png`);
      const inspectorLayout = await evaluate(() => {
        const rail = document.querySelector('.stage-plan .rail-r').getBoundingClientRect();
        const field = document.querySelector('.fieldsvg').getBoundingClientRect();
        return { railWidth: rail.width, fieldX: field.x, fieldWidth: field.width };
      });
      await evaluate(() => {
        const labels = [];
        const observer = new MutationObserver(() => {
          const panel = document.querySelector('.optimizer-panel');
          if (panel) labels.push(panel.innerText);
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        window.__optimizerOpeningProbe = { labels, stop: () => observer.disconnect() };
      });
      const openingJobs = await markJobs(`strict Normal open/reopen issues zero jobs at ${width}×${height}`);
      await click('.optimizer-toggle');
      await stable(normal, 350, 'Opening the optimizer');
      await noJobsSince(openingJobs);
      const openingLabels = await evaluate(() => {
        const probe = window.__optimizerOpeningProbe;
        probe.stop();
        delete window.__optimizerOpeningProbe;
        return probe.labels;
      });
      assert.ok(openingLabels.length > 0, 'Opening text probe must observe the panel');
      assert.ok(openingLabels.every((text) => !/Loading|Preparing|Searching|Optimizing/.test(text)), 'Opening must not flash loading text');
      assert.equal(await evaluate(() => document.querySelector('.optimizer-panel [aria-busy="true"]') != null || [...document.querySelectorAll('.optimizer-panel button')].some((item) => item.textContent === 'Cancel')), false);
      const optimizerLayout = await evaluate(() => {
        const rail = document.querySelector('.stage-plan .rail-r').getBoundingClientRect();
        const field = document.querySelector('.fieldsvg').getBoundingClientRect();
        return { railWidth: rail.width, fieldX: field.x, fieldWidth: field.width };
      });
      assert.deepEqual(optimizerLayout, inspectorLayout, 'Changing sidebar content must not move or resize the field');
      assert.ok(!await evaluate(() => /Loading|Preparing|Searching|Optimizing/.test(document.querySelector('.optimizer-panel').innerText)), 'Opening must not flash loading text');
      await capture(`optimizer-idle-${width}x${height}.png`);
      await click('button[title="Close optimization"]');
      assert.ok(await evaluate(() => document.querySelector('.stage-plan .rail-r.collapsed') && !document.querySelector('.optimizer-panel') && document.querySelector('.pp-more')), 'Close must collapse the sidebar instead of returning to path details');
      assert.ok(await evaluate(() => document.activeElement === document.querySelector('.optimizer-toggle')), 'Closing optimization returns focus to its toolbar control');
      const reopeningJobs = await markJobs(`strict Normal immediate reopen issues zero jobs at ${width}×${height}`);
      await click('.optimizer-toggle');
      await stable(normal, 350, 'Reopening strict Normal');
      await noJobsSince(reopeningJobs);
      await click('button[title="Close optimization"]');
      await click('.pp-more');
      assert.ok(await evaluate(() => !document.querySelector('.stage-plan .rail-r.collapsed') && !document.querySelector('.optimizer-panel')), 'Inspector reopens explicitly');
      check(`inspector and optimizer preserve field geometry at ${width}×${height}`);
    }
    window.setContentSize(1440, 900);
    await delay(250);
    await click('.optimizer-toggle');
    await click('rect[data-role="wp"][data-idx="0"]');
    await click('rect[data-role="wp"][data-idx="0"]', null, 2);
    await waitFor(() => evaluate(() => !document.querySelector('.optimizer-panel') && document.querySelector('.ctxinsp')), 'double-click Start to replace Optimize with the inspector');
    assert.ok(await evaluate(() => document.querySelector('.ctxinsp').innerText.includes('Start')), 'Waypoint inspection opens the selected Start details');
    await click('.ctxinsp-x');
    assert.ok(await evaluate(() => document.activeElement === document.querySelector('.pp-more')), 'Closing the inspector restores focus to More');
    await click('.optimizer-toggle');
    check('double-clicking a waypoint opens its inspector over Optimize and closing returns focus');
    // Keep this search running until it has been observed in the background and cancelled.
    await evaluate(() => window.__optimizerWorkers.holdOptimizeReplies());
    await click('.optimizer-main', 'Optimize');
    await waitFor(() => evaluate(() => document.querySelector('.optimizer-main')?.textContent === 'Cancel'), 'the current-path search');
    await switchPath(fixture.paths[1].name);
    await waitFor(() => evaluate(() => !!document.querySelector('.optimizer-background')), 'the named background search');
    // The editor no longer waits on the optimizer's own baseline; let it settle before sampling the panel.
    await waitFor(() => evaluate(() => document.querySelector('.optimizer-status')?.getAttribute('aria-busy') === 'false'), 'the current path baseline');
    const backgroundJob = await evaluate(() => ({
      owner: document.querySelector('.optimizer-background strong')?.textContent,
      cancelLabel: document.querySelector('.optimizer-background button')?.getAttribute('aria-label'),
      currentBusy: document.querySelector('.optimizer-status')?.getAttribute('aria-busy'),
      startDisabled: document.querySelector('.optimizer-main')?.disabled,
      label: document.querySelector('.optimizer-main')?.textContent,
    }));
    assert.equal(backgroundJob.owner, fixture.paths[0].name);
    assert.equal(backgroundJob.cancelLabel, `Cancel optimization for ${fixture.paths[0].name}`);
    assert.equal(backgroundJob.currentBusy, 'false');
    assert.equal(backgroundJob.startDisabled, true);
    assert.equal(backgroundJob.label, 'Optimize');
    await capture('optimizer-background.png');
    window.setContentSize(1100, 720);
    await delay(120);
    await capture('optimizer-background-1100x720.png');
    window.setContentSize(1440, 900);
    await click('.optimizer-background button');
    await waitFor(() => evaluate(() => !document.querySelector('.optimizer-background') && !document.querySelector('.optimizer-main')?.disabled), 'background cancellation to release the search slot');
    await evaluate(() => window.__optimizerWorkers.releaseOptimizeReplies());
    assert.equal(await evaluate(() => !!document.querySelector('button[aria-label="Preview same shape trajectory"]')), false, 'The background job must not create a candidate on the selected path');
    await switchPath(fixture.paths[0].name);
    await stable(normal, 200, 'Canceling the original search');
    // Cancellation may retain an incumbent candidate; it must never apply it.
    assert.notEqual(await evaluate(() => document.querySelector('.optimizer-main')?.textContent), 'Cancel');
    await openSettings();
    await click('.optimizer-search-actions button:first-child');
    await click('.optimizer-settings summary');
    check('background search names its owner, blocks concurrent search, and cancels the original path');
    await finishSearch();
    check('optimizer opens quietly at the inspector width, closes the whole sidebar, and searches only on explicit request');
    await assertCompactResult();
    check('result-first inspector keeps settings and solver details collapsed');
    await waitFor(() => evaluate(() => {
      const button = document.querySelector('.optimizer-main');
      return button && !button.disabled && getComputedStyle(button).opacity === '1';
    }), 'the settled enabled Apply action');
    await capture('optimizer-result.png');
    await captureMinimum('optimizer-result-1100x720.png');
    await stable(normal, 1800, 'Unapplied candidate');
    let project = await save();
    assert.deepEqual(project.paths[0].waypoints, fixture.paths[0].waypoints, 'A finished search leaves the path as it is');
    check('search completion leaves the path, its timing and geometry unchanged');
    await click('button[aria-label="Preview same shape trajectory"]');
    const candidate = await snapshot();
    assert.ok(Number(candidate.time) < Number(normal.time), 'Candidate comparison must display faster timing');
    assert.notEqual(candidate.geometry, normal.geometry, 'Candidate comparison must show improved geometry');
    await click('.optimizer-toggle');
    await stable(normal, 250, 'Closing the comparison');
    await click('.optimizer-toggle');
    assert.equal(await evaluate(() => [...document.querySelectorAll('.optimizer-panel button')].some((item) => item.textContent === 'Cancel')), false);
    await stable(normal, 350, 'Reopening the candidate');
    await click('button[aria-label="Preview same shape trajectory"]');
    await stable(candidate, 250, 'Reopened candidate comparison');
    check('closing comparison restores the current path and reopening keeps the result without rerunning');
    const expectedGain = Number(normal.time) - Number(candidate.time);
    const expectedGainLabel = `${expectedGain.toFixed(2)} s faster, ${(expectedGain / Number(normal.time) * 100).toFixed(1)}%`;
    await waitFor(async () => (await snapshot()).status === expectedGainLabel, 'gain and percentage against the current path');
    check('gain and percentage compare the result with the current path');
    const toolbarBeforeApply = await evaluate(() => [...document.querySelectorAll('.toolbar .tb-actions button, .toolbar > .keyboard-help-trigger')].map((button) => {
      const box = button.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }));
    const applyJobs = await markJobs('Apply replans only the edited path, once');
    await click('.optimizer-panel button', 'Apply same shape');
    await waitFor(async () => (await snapshot()).status === 'Applied to the path', 'the path to take the applied curve');
    await ready();
    const toolbarAfterApply = await evaluate(() => [...document.querySelectorAll('.toolbar .tb-actions button, .toolbar > .keyboard-help-trigger')].map((button) => {
      const box = button.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }));
    assert.deepEqual(toolbarAfterApply, toolbarBeforeApply, 'Applying must not move the toolbar');
    assert.equal(await evaluate(() => document.querySelector('.optimizer-toggle')?.textContent), 'Optimize');
    check('Apply leaves the toolbar as it was');
    const applied = await snapshot();
    assert.equal(applied.time, candidate.time, 'The path plans exactly the previewed time');
    assert.equal(applied.geometry, candidate.geometry, 'The path draws exactly the previewed curve');
    project = await save();
    assert.equal(project.paths[0].optimization, undefined, 'Apply stores no separate result');
    assert.equal(project.paths[0].waypoints.length, fixture.paths[0].waypoints.length, 'A same-shape result adds no waypoints');
    assert.notDeepEqual(project.paths[0].waypoints, fixture.paths[0].waypoints, 'Apply writes the new handles into the path');
    project.paths[0].waypoints.forEach((waypoint, index) => assert.deepEqual([waypoint.x, waypoint.y], [fixture.paths[0].waypoints[index].x, fixture.paths[0].waypoints[index].y]));
    const appliedWaypoints = project.paths[0].waypoints;
    await stable(applied, 2500, 'Applied path');
    const appliedEvidence = await strictEditing(fixture.paths[0].id, applied);
    const appliedJobs = await jobsSince(applyJobs);
    const selectedJobs = appliedJobs.filter(job => job.pathId === fixture.paths[0].id);
    assert.equal(selectedJobs.filter(job => job.mode === 'editing').length, 1, 'Apply plans the edited path once');
    assert.equal(selectedJobs.filter(job => job.mode !== 'editing' && !job.optimize).length, 0, 'Apply needs no second plan for comparison');
    workerEvidence.checkpoints.push({ ...applyJobs, jobs: appliedJobs, passed: true });
    check(applyJobs.label);
    await capture('optimizer-applied.png');
    await captureMinimum('optimizer-applied-1100x720.png');
    check('Apply writes the previewed curve into the path, which plans exactly the previewed time');
    await click('button[title="Close optimization"]');
    for (const redo of [false, true]) {
      await history(redo);
      await waitFor(async () => (await snapshot()).geometry === (redo ? applied : normal).geometry, redo ? 'Redo Apply' : 'Undo Apply');
      await ready();
      await stable(redo ? applied : normal, 250, redo ? 'Redo' : 'Undo');
      const saved = await save();
      assert.deepEqual(saved.paths[0].waypoints, redo ? appliedWaypoints : fixture.paths[0].waypoints);
      await strictEditing(fixture.paths[0].id, redo ? applied : normal);
    }
    check('Undo restores the drawn curve and Redo applies it again, as one step each');
    await click('.optimizer-toggle');
    const layout = await evaluate(() => {
      const panel = document.querySelector('.optimizer-panel').getBoundingClientRect();
      const field = document.querySelector('.fieldsvg').getBoundingClientRect();
      return { panelX: panel.x, fieldRight: field.right, fieldHeight: field.height, fieldWidth: field.width, width: innerWidth, height: innerHeight };
    });
    assert.ok(layout.panelX >= layout.fieldRight - 1, 'The optimization inspector must not overlap the field');
    assert.ok(layout.fieldHeight > layout.height * 0.5, 'The comparison field must remain usable with the inspector open');
    assert.ok(layout.fieldWidth > layout.width * 0.35, 'The optimizer inspector must leave room to inspect the route');
    check('optimizer inspector preserves field space');
    await switchPath(fixture.paths[1].name);
    await switchPath(fixture.paths[0].name);
    await stable(applied, 300, 'Path switch');
    await save();
    await loadApp();
    await ready();
    await stable(applied, 500, 'Save/reload');
    check('the applied curve survives path switching and save/reload');
    await click('.places .place', 'Robot');
    await evaluate(() => {
      const input = document.querySelector('textarea[aria-label="Robot planning notes"]');
      if (!input) throw new Error('Robot planning notes missing');
      input.focus();
    });
    await focusEditor();
    await window.webContents.insertText('Cosmetic optimizer verification note');
    await click('.places .place', 'Paths');
    project = await save();
    assert.equal(project.robot.planning.notes, 'Cosmetic optimizer verification note');
    assert.deepEqual(project.paths[0].waypoints, appliedWaypoints);
    await ready();
    await stable(applied, 1000, 'Cosmetic robot note');
    check('cosmetic robot notes leave the path and its timing alone');
    const reopenJobs = await markJobs('opening Optimize on an applied path issues zero jobs');
    await click('.optimizer-toggle');
    await waitFor(() => evaluate(() => { const row = document.querySelector('button[aria-label="Preview current path trajectory"]'); return row && !row.disabled; }), 'the current path row');
    await stable(applied, 350, 'Reopening Optimize');
    await noJobsSince(reopenJobs);
    await openSettings();
    const batchJobCount = (await workerState()).jobs.length;
    const beforeBatch = await save();
    await click('.optimizer-panel button', 'Optimize all');
    await waitFor(() => evaluate((done) => document.querySelector('.optimizer-batch')?.textContent.includes(done), `${fixture.paths.length} of ${fixture.paths.length} paths searched`), 'Optimize all to finish every path', 30_000);
    const batchRows = await evaluate(() => [...document.querySelectorAll('.optimizer-batch button')].map((item) => ({
      name: item.querySelector(':scope > span')?.textContent,
      status: item.querySelector(':scope > small')?.textContent,
    })));
    assert.deepEqual(batchRows.map(row => row.name), fixture.paths.map(item => item.name), 'Every expected path must appear in the completed batch');
    const failedIndex = batchRows.findIndex(row => row.status !== 'Searched');
    if (failedIndex !== -1) assert.fail(`${batchRows[failedIndex].name}: ${batchRows[failedIndex].status}`);
    const batchRoutes = await evaluate((count) => {
      const observer = window.__optimizerWorkers;
      return observer.jobs.slice(count).filter(job => job.optimize).map(job => {
        const value = observer.valueFor(job.sequence), result = value?.finalTrajectory;
        return { pathId: job.pathId, status: job.status, routeStatus: value?.routeSearch?.status, fallback: result?.optimization?.fallback,
          time: result?.totalTimeS, samples: result?.samples?.length, errors: result?.diagnostics?.filter(issue => issue.severity === 'error') || [] };
      });
    }, batchJobCount);
    assert.deepEqual(batchRoutes.map(route => route.pathId), fixture.paths.map(item => item.id), 'Optimize all must complete one search for each expected path');
    for (const route of batchRoutes) {
      assert.equal(route.status, 'ready', `${route.pathId}: batch worker must complete successfully`);
      assert.equal(route.routeStatus, 'feasible', `${route.pathId}: batch search must return a feasible route`);
      assert.equal(route.fallback, false, `${route.pathId}: fallback output is not a route`);
      assert.ok(Number.isFinite(route.time) && route.time > 0 && route.samples > 0, `${route.pathId}: route must contain timed samples`);
      assert.deepEqual(route.errors, [], `${route.pathId}: route must have no error diagnostics`);
    }
    await stable(applied, 600, 'Optimize all');
    project = await save();
    assert.deepEqual(project.paths, beforeBatch.paths, 'Optimize all changes no path');
    check('Optimize all searches every path without changing any');
    await capture('optimizer-all.png');
    await captureMinimum('optimizer-all-1100x720.png');
    // One search offers two results on a path shaped by its tangents. The batch above already searched it.
    await switchPath(fixture.paths[2].name);
    const cornerNormal = await snapshot();
    const offered = () => evaluate(() => ({
      rows: [...document.querySelectorAll('.optimizer-choice')].map((row) => row.getAttribute('aria-label')),
      apply: document.querySelector('.optimizer-main.primary')?.textContent,
      times: Object.fromEntries([...document.querySelectorAll('.optimizer-choice')].map((row) => [row.getAttribute('aria-label'), Number.parseFloat(row.querySelector('b')?.textContent)])),
    }));
    await waitFor(async () => (await offered()).rows.length === 3, 'both results of the corner search');
    const both = await offered();
    assert.deepEqual(both.rows, ['Preview current path trajectory', 'Preview same shape trajectory', 'Preview new route trajectory']);
    assert.equal(both.apply, 'Apply same shape', 'Apply starts on the result that keeps the drawn shape');
    assert.ok(both.times['Preview new route trajectory'] < both.times['Preview same shape trajectory']
      && both.times['Preview same shape trajectory'] < both.times['Preview current path trajectory'], `The new route must be the faster result: ${JSON.stringify(both.times)}`);
    await click('button[aria-label="Preview same shape trajectory"]');
    const sameShape = await snapshot();
    await click('button[aria-label="Preview new route trajectory"]');
    const newRoute = await snapshot();
    assert.equal((await offered()).apply, 'Apply new route', 'Apply follows the previewed result');
    assert.notEqual(sameShape.geometry, cornerNormal.geometry, 'The same-shape result changes handle lengths');
    assert.notEqual(newRoute.geometry, sameShape.geometry, 'The two results are different curves');
    const tangent = (d) => { const n = d.match(/-?\d+(?:\.\d+)?/g).map(Number); return Math.atan2(n[3] - n[1], n[2] - n[0]); };
    const turned = (first, second) => Math.abs(Math.atan2(Math.sin(first - second), Math.cos(first - second))) * 180 / Math.PI;
    assert.ok(turned(tangent(sameShape.geometry), tangent(cornerNormal.geometry)) < 3, 'The same-shape result leaves the start along the drawn tangent');
    await capture('optimizer-two-results.png');
    await captureMinimum('optimizer-two-results-1100x720.png');
    // The offered Same shape row is a choice by keyboard as well as by pointer, at both supported sizes.
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      window.setContentSize(width, height);
      await delay(250);
      await click('button[aria-label="Preview current path trajectory"]');
      await stable(cornerNormal, 200, 'Normal preview before choosing Same shape from the keyboard');
      await pressKey('Tab');
      let offeredRow = await shapeRow();
      assert.ok(offeredRow.focused, 'Tab moves from Normal to the offered Same shape row');
      assert.deepEqual({ label: offeredRow.label, disabled: offeredRow.disabled, pressed: offeredRow.pressed, note: offeredRow.note, opacity: offeredRow.opacity },
        { label: 'Preview same shape trajectory', disabled: false, pressed: 'false', note: null, opacity: '1' });
      assert.match(offeredRow.time, /^\d+\.\d\d s$/);
      assert.ok(offeredRow.inside, 'The offered row stays inside the panel');
      // Space belongs to playback on plain buttons (src/renderer/lib/shortcuts.js); Enter presses the focused row.
      await pressKey('Enter');
      await waitFor(async () => (await shapeRow()).pressed === 'true', 'Enter to choose the Same shape preview');
      await stable(sameShape, 200, 'Same shape chosen from the keyboard');
      assert.equal((await offered()).apply, 'Apply same shape');
      await capture(`optimizer-same-shape-offered-${width}x${height}.png`);
    }
    window.setContentSize(1440, 900);
    await delay(250);
    await click('button[aria-label="Preview new route trajectory"]');
    await stable(newRoute, 200, 'New route preview restored');
    check('an offered Same shape row is chosen with Tab and Enter at both supported sizes');
    await click('.optimizer-panel button', 'Apply new route');
    await waitFor(async () => (await snapshot()).status === 'Applied to the path', 'the applied new route');
    await ready();
    assert.equal((await snapshot()).time, newRoute.time, 'The corner plans the previewed new route');
    assert.deepEqual((await offered()).rows, ['Preview current path trajectory'], 'After Apply nothing older is offered');
    await history(false);
    await waitFor(async () => (await offered()).apply === 'Apply same shape', 'Undo to bring back both results of the same search');
    await click('.optimizer-panel button', 'Apply same shape');
    await waitFor(async () => (await snapshot()).status === 'Applied to the path', 'the applied same shape');
    await ready();
    assert.equal((await snapshot()).time, sameShape.time);
    project = await save();
    assert.equal(project.paths[2].waypoints.length, 2);
    check('one search offers a same-shape result and a new route; Apply follows the previewed one, and Undo brings the offer back');
    // A straight line has nothing to gain. The batch above searched it; both result rows are listed greyed with their reason.
    await switchPath(fixture.paths[5].name);
    const straightNormal = await snapshot();
    await waitFor(async () => (await snapshot()).status === 'No faster route found', 'the finished search of the straight path');
    const hints = { 'same shape': 'Keeps the tangent direction at every waypoint and stays within 0.15 m of your curve.',
      'new route': 'May take any path through your waypoints, around obstacles.' };
    const pressAt = async ({ x, y }) => {
      await focusEditor();
      window.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x, y });
      window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x, y });
    };
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      window.setContentSize(width, height);
      await delay(250);
      await restPointer();
      // Captured before the assertions, so a build without the rows still leaves its screenshot.
      await capture(`optimizer-no-faster-path-${width}x${height}.png`);
      const panelState = await evaluate(() => ({
        rows: [...document.querySelectorAll('.optimizer-choice')].map((row) => row.getAttribute('aria-label')),
        apply: [...document.querySelectorAll('.optimizer-panel button')].some((item) => item.textContent.startsWith('Apply')),
        task: document.querySelector('.optimizer-task').textContent,
      }));
      assert.deepEqual(panelState, { rows: ['Preview current path trajectory', 'Preview same shape trajectory, no faster path found',
        'Preview new route trajectory, no faster path found'], apply: false, task: 'Avoids obstacles. Keeps waypoints, headings and stops.' });
      for (const name of ['same shape', 'new route']) {
        await restPointer();
        const greyed = await resultRow(name);
        // The name is greyed; the reason is not, so it stays readable.
        assert.deepEqual({ label: greyed.label, disabled: greyed.disabled, pressed: greyed.pressed, note: greyed.note, time: greyed.time, opacity: greyed.opacity, noteOpacity: greyed.noteOpacity },
          { label: `Preview ${name} trajectory, no faster path found`, disabled: true, pressed: 'false', note: 'No faster path found', time: null, opacity: '0.45', noteOpacity: '1' });
        assert.equal(greyed.title, hints[name], `The greyed ${name} row keeps its hint`);
        assert.ok(greyed.inside && greyed.noteInside, `The greyed ${name} row and its reason are fully visible`);
        // Resting the pointer on the greyed row still opens its hint.
        window.webContents.sendInputEvent({ type: 'mouseMove', x: greyed.x - 4, y: greyed.y });
        window.webContents.sendInputEvent({ type: 'mouseMove', x: greyed.x, y: greyed.y });
        await waitFor(async () => (await tooltipText()) === hints[name], `the hover hint of the greyed ${name} row`, 3000);
        if (name === 'same shape') await capture(`optimizer-no-faster-path-hint-${width}x${height}.png`);
        // A real press on the greyed row chooses nothing.
        await pressAt(greyed);
        await stable(straightNormal, 300, `Pressing the greyed ${name} row`);
        assert.equal((await resultRow(name)).pressed, 'false');
      }
      // Tab from Normal passes over both rows in both directions, and no stop in the panel lands on either.
      await click('button[aria-label="Preview current path trajectory"]');
      const stops = [];
      for (let index = 0; index < 8; index += 1) {
        await pressKey('Tab');
        stops.push(await evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent || document.activeElement?.tagName));
        assert.ok(!(await resultRow('same shape')).focused && !(await resultRow('new route')).focused, `Tab stop ${index + 1} must not be a greyed row`);
      }
      assert.equal(stops[0], 'Try again', `Tab from Normal skips the greyed rows to the next control: ${JSON.stringify(stops)}`);
      await click('button[aria-label="Preview current path trajectory"]');
      await pressKey('Tab');
      await pressKey('Tab', ['shift']);
      assert.equal(await evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Preview current path trajectory', 'Shift+Tab returns to Normal without stopping on a greyed row');
      await pressKey('Enter');
      await stable(straightNormal, 200, 'Keyboard input around the greyed rows');
      assert.equal(await evaluate(() => document.querySelector('button[aria-label="Preview current path trajectory"]').getAttribute('aria-pressed')), 'true');
      check(`a path with nothing to gain lists both results greyed with "No faster path found", unreachable by pointer or keyboard, at ${width}×${height}`);
    }
    window.setContentSize(1440, 900);
    await delay(250);
    // The trench path's drawn curve fails the field check. Its route stays a choice although it is not faster.
    await switchPath(fixture.paths[6].name);
    await restPointer();
    const trenchNormal = await snapshot();
    const clearNote = 'Your path hits the field. New route clears it. Current path timing is shown for comparison only.';
    let clearRoute;
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      window.setContentSize(width, height);
      await delay(250);
      await click('button[aria-label="Preview current path trajectory"]');
      await stable(trenchNormal, 200, 'Normal preview of the trench path');
      const message = await evaluate(() => ({
        status: document.querySelector('.optimizer-outcome[role="status"]').textContent,
        gain: document.querySelector('.optimizer-outcome').classList.contains('gain'),
        note: document.querySelector('.optimizer-reason')?.textContent,
        rows: [...document.querySelectorAll('.optimizer-choice')].map((row) => row.getAttribute('aria-label')),
        times: [...document.querySelectorAll('.optimizer-choice')].map((row) => Number.parseFloat(row.querySelector('b')?.textContent)),
        apply: document.querySelector('.optimizer-main.primary')?.textContent,
        noteInside: (() => { const note = document.querySelector('.optimizer-reason')?.getBoundingClientRect(), panel = document.querySelector('.optimizer-panel').getBoundingClientRect();
          return Boolean(note) && note.left >= panel.left && note.right <= panel.right && note.bottom <= innerHeight; })(),
      }));
      // The same-shape search cannot leave the drawn curve far enough to clear the field, and says so without "faster".
      assert.deepEqual(message.rows, ['Preview current path trajectory', 'Preview same shape trajectory, no path found', 'Preview new route trajectory']);
      const slower = /^Fixes your path, (\d+\.\d\d) s slower$/.exec(message.status);
      assert.ok(slower, `The headline says the route fixes the path and what it costs: ${message.status}`);
      assert.ok(Math.abs(Number(slower[1]) - (message.times[2] - message.times[0])) < 0.011, `The slower figure matches the listed times: ${JSON.stringify(message)}`);
      assert.equal(message.gain, false, 'A slower fix is not coloured as a gain');
      assert.equal(message.note, clearNote);
      assert.ok(message.noteInside, 'The reason is fully visible');
      assert.equal(message.apply, 'Apply new route');
      // Tab from Normal passes the greyed Same shape row and lands on the route; Enter previews it.
      await pressKey('Tab');
      let routeRow = await resultRow('new route');
      assert.ok(routeRow.focused, 'Tab moves from Normal past the greyed Same shape row to the clearing route');
      assert.deepEqual({ disabled: routeRow.disabled, opacity: routeRow.opacity, note: routeRow.note, inside: routeRow.inside },
        { disabled: false, opacity: '1', note: null, inside: true });
      await pressKey('Enter');
      await waitFor(async () => (await resultRow('new route')).pressed === 'true', 'Enter to preview the clearing route');
      clearRoute = await snapshot();
      assert.ok(Number(clearRoute.time) > Number(trenchNormal.time), 'The clearing route is slower than Normal');
      assert.notEqual(clearRoute.geometry, trenchNormal.geometry, 'The clearing route is a different curve');
      // The pointer chooses it as well.
      await click('button[aria-label="Preview current path trajectory"]');
      await stable(trenchNormal, 200, 'Normal preview before choosing the clearing route by pointer');
      await click('button[aria-label="Preview new route trajectory"]');
      await stable(clearRoute, 200, 'The clearing route chosen by pointer');
      assert.equal((await resultRow('new route')).pressed, 'true');
      await restPointer();
      await capture(`optimizer-clear-route-${width}x${height}.png`);
    }
    window.setContentSize(1440, 900);
    await delay(250);
    await click('.optimizer-panel button', 'Apply new route');
    await waitFor(async () => (await snapshot()).status === 'Applied to the path', 'the clearing route written into the path');
    await ready();
    assert.equal((await snapshot()).time, clearRoute.time);
    project = await save();
    assert.notDeepEqual(project.paths[6].waypoints, fixture.paths[6].waypoints, 'Apply saves the clearing curve');
    check('a slower route that clears the field stays selectable by pointer and keyboard, says why it is offered, and applies');
    // A drawn line through the HUB. Only a route around it is valid, so Apply adds waypoints.
    const detourIndex = 3, detour = fixture.paths[detourIndex];
    await switchPath(detour.name);
    const drawnPlaces = await placements();
    assert.equal(drawnPlaces.zones.length, 2, 'The detour fixture shows both ends of its zone');
    assert.equal(drawnPlaces.markers.length, 1);
    await waitFor(async () => (await offered()).apply === 'Apply new route', 'the route around the HUB from Optimize all');
    await click('button[aria-label="Preview new route trajectory"]');
    const detourCandidate = await snapshot();
    const previewPlaces = await placements();
    await capture('optimizer-detour-preview.png');
    await click('.optimizer-panel button', 'Apply new route');
    await waitFor(async () => (await snapshot()).status === 'Applied to the path', 'the applied detour');
    await ready();
    const detourApplied = await snapshot();
    assert.equal(detourApplied.time, detourCandidate.time, 'The detour plans exactly the previewed time');
    assert.equal(detourApplied.geometry, detourCandidate.geometry, 'The detour draws exactly the previewed curve');
    samePlaces(previewPlaces, await placements(), 'Applied detour');
    project = await save();
    const flags = added(project, detourIndex);
    assert.ok(flags.length > 2 && flags.slice(1, -1).every(Boolean) && !flags[0] && !flags.at(-1), `Apply inserts flagged waypoints between the ends: ${flags}`);
    assert.deepEqual(project.paths[detourIndex].markers, detour.markers, 'Markers keep their authored values');
    const zone = project.paths[detourIndex].ranges[0];
    assert.equal(zone.w1, flags.length - 1, 'The zone still ends at the path end');
    assert.ok(zone.w0 >= 1 && zone.t0 > 0 && zone.t0 < 1, `The zone start moves to the inserted segment that holds it: ${JSON.stringify(zone)}`);
    await captureMinimum('optimizer-detour-applied-1100x720.png');
    await capture('optimizer-detour-applied.png');
    check('applying a detour inserts flagged pass-through waypoints, plans the previewed time, and keeps markers and zones where they were previewed');
    await click('button[title="Close optimization"]');
    await click(`.pt-wp[data-selection="wp:1"]`);
    await click('.pp-more');
    await waitFor(() => evaluate(() => document.querySelector('.ctxinsp-kind')?.textContent.startsWith('Added by Optimize')
      && document.querySelector('.optimizer-added-hint')?.checkVisibility()), 'the inspector to name the added waypoint');
    await capture('optimizer-added-waypoint.png');
    await captureMinimum('optimizer-added-waypoint-1100x720.png');
    await click('.ctxinsp-x');
    check('the inspector names a waypoint Optimize added and says what a later Optimize may do');
    for (const redo of [false, true]) {
      await history(redo);
      await waitFor(async () => ((await snapshot()).geometry === detourApplied.geometry) === redo, redo ? 'Redo detour' : 'Undo detour');
      await ready();
      assert.equal(added(await save(), detourIndex).length, redo ? flags.length : 2);
    }
    samePlaces(previewPlaces, await placements(), 'Redone detour');
    check('Undo removes the inserted waypoints and Redo restores them');
    const beforeFlip = (await save()).paths[detourIndex];
    await click('.field-flip');
    await click('.path-flip label:has(input[name="pf-direction"][value="rotate"])');
    await click('.path-flip label:has(input[name="pf-target"][value="replace"])');
    await click('.path-flip .pf-commit');
    await waitFor(() => evaluate(() => !document.querySelector('.path-flip[open]')), 'in-place Flip');
    const flipped = await save();
    assert.equal(flipped.paths[detourIndex].waypoints[0].x, -beforeFlip.waypoints[0].x);
    assert.deepEqual(added(flipped, detourIndex), flags, 'In-place Flip keeps the optimizer-added flags');
    await history(false);
    await waitFor(async () => (await snapshot()).geometry === detourApplied.geometry, 'Undo Flip');
    assert.deepEqual((await save()).paths[detourIndex], beforeFlip, 'Undo restores the path before Flip');
    check('in-place Flip keeps detour waypoints eligible for later optimization');
    // A slower robot keeps the curve and replans its timing; nothing goes stale.
    await click('.places .place', 'Robot');
    await setRobotNumber('Motor free speed', 1000);
    await click('.places .place', 'Paths');
    await waitFor(async () => Number((await snapshot()).time) > Number(detourApplied.time) * 1.5, 'the slower robot to replan the detour');
    await ready();
    const slower = await snapshot();
    assert.equal(slower.geometry, detourApplied.geometry, 'A robot edit keeps the applied curve');
    assert.ok(!await evaluate(() => /Needs update|Use normal/.test(document.body.innerText)), 'Nothing goes stale after a robot edit');
    project = await save();
    assert.deepEqual(added(project, detourIndex), flags);
    assert.equal(project.robot.driveModel.motorFreeRpm, 1000);
    check('a robot edit keeps the applied curve and replans its timing for the new robot');
    // A taller robot no longer fits under the TRENCH the next path drives through.
    const trenchIndex = 4;
    await switchPath(fixture.paths[trenchIndex].name);
    assert.equal(await evaluate(() => document.querySelector('.problems-trigger') === null), true, 'A clear path has no problems');
    await click('.places .place', 'Robot');
    await setRobotNumber('Robot height', 0.8);
    await click('.places .place', 'Paths');
    await ready();
    await waitFor(() => evaluate(() => document.querySelector('.problems-trigger')?.textContent.startsWith('Problems')), 'the field collision problem');
    await click('.problems-trigger');
    await waitFor(() => evaluate(() => [...document.querySelectorAll('.problems-menu [role="menuitemradio"]')].some((row) => row.textContent.includes('Robot hits the field'))), 'the collision in the problems menu');
    await focusEditor();
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await waitFor(() => evaluate(() => document.querySelector('.pp-problem')?.innerText.includes('Optimize again or edit the path so the robot clears it.')), 'the way forward beside the problem');
    assert.ok(Number((await snapshot()).time) > 0, 'A colliding curve keeps its timing and playback');
    await capture('optimizer-collision.png');
    await captureMinimum('optimizer-collision-1100x720.png');
    check('a curve the robot no longer fits through is reported where problems are shown, with the way forward');
    await click('.places .place', 'Robot');
    await setRobotNumber('Robot height', 0.5);
    await click('.places .place', 'Paths');
    // Moving the end past the HUB makes the straight line clear; a new search drops the old detour.
    await switchPath(detour.name);
    await click(`.pt-wp[data-selection="wp:${flags.length - 1}"]`);
    await setWaypointCoordinate('Y', -2.4);
    await setWaypointCoordinate('X', 5.5705);
    await ready();
    project = await save();
    assert.deepEqual(added(project, detourIndex), flags, 'Moving the end keeps the inserted waypoints');
    await click('.optimizer-toggle');
    await click('.optimizer-main', 'Optimize');
    await finishSearch('Apply new route');
    await click('button[aria-label="Preview new route trajectory"]');
    const direct = await snapshot();
    await click('.optimizer-panel button', 'Apply new route');
    await waitFor(async () => (await snapshot()).status === 'Applied to the path', 'the direct route');
    await ready();
    assert.equal((await snapshot()).time, direct.time);
    project = await save();
    assert.deepEqual(added(project, detourIndex), [false, false], 'A later Optimize removes the waypoints it added');
    assert.deepEqual(project.paths[detourIndex].ranges[0].w0, 0, 'The zone returns to the single segment');
    await capture('optimizer-detour-removed.png');
    check('a later Optimize removes an old detour it no longer needs');
    assert.deepEqual(errors, [], 'Renderer console must remain free of unexpected errors');
    check('renderer console has no unexpected errors');
    await settledWorkers();
    await archiveWorkers('complete');
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, checks, errors, knownConsoleWarnings, workerEvidence,
      normalTimeS: Number(normal.time), optimizedTimeS: Number(applied.time), plannedTimeS: appliedEvidence.value.trajectory.totalTimeS }, null, 2));
    app.exit(0);
  } catch (error) {
    console.error(error.stack || error);
    const diagnosticErrors = [];
    if (window && !window.isDestroyed()) {
      for (const action of [() => capture('failure.png'), () => archiveWorkers('failure'),
        async () => fs.writeFile(path.join(output, 'failure-dom.txt'), await evaluate(() => document.body.innerText))]) {
        try { await action(); } catch (failure) { diagnosticErrors.push(String(failure)); }
      }
    }
    await fs.writeFile(path.join(output, 'last-saved-project.json'), JSON.stringify(saved, null, 2));
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: false, checks, errors, knownConsoleWarnings, workerEvidence, diagnosticErrors, failure: error.message }, null, 2));
    app.exit(1);
  }
});
