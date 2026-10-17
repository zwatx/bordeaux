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
async function strictEditing(pathId, accepted, displayed, artifact) {
  const evidence = await waitFor(() => evaluate((pathId, accepted) => {
    const result = window.__optimizerWorkers.latestEditing(pathId);
    return result?.value?.status === 'ok' && result.value.comparison?.status === 'ready'
      && result.value.acceptedTrajectory === accepted ? result : null;
  }, pathId, accepted), 'the complete strict editing projection');
  assert.equal(evidence.job.quality, 'final');
  assert.equal(evidence.job.density, 56);
  assert.equal(evidence.value.comparison.previewDensity, 56);
  assert.equal(evidence.value.comparison.projectionVersion, 1);
  assert.equal(evidence.value.trajectory.totalTimeS, Number(displayed.time));
  assert.deepEqual(evidence.value.derived.finalTrajectory, evidence.value.trajectory, 'Projection must preserve the full strict trajectory');
  assert.deepEqual(evidence.value.derived.trajectorySamples, evidence.value.bestEffort.samples);
  if (artifact) {
    assert.equal(evidence.job.acceptedDensity, artifact.samplesPerSegment);
    assert.deepEqual(evidence.value.trajectory, artifact.result, 'Editing must preserve every accepted sample and action field');
  }
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
async function finishSearch() {
  await waitFor(() => evaluate(() => [...document.querySelectorAll('.optimizer-panel button')]
    .some((item) => item.textContent === 'Cancel')), 'the explicit search to start');
  await waitFor(() => evaluate(() => ![...document.querySelectorAll('.optimizer-panel button')]
    .some((item) => item.textContent === 'Cancel')), 'the explicit search to finish', 12_000);
  await waitFor(() => evaluate(() => [...document.querySelectorAll('.optimizer-panel button')]
    .some((item) => item.textContent === 'Apply optimized')), 'an improved candidate', 2000);
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
    return primary && primary.textContent === 'Apply optimized' && !primary.disabled && primary.checkVisibility();
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
  assert.deepEqual(state.rows, ['Preview normal trajectory', 'Preview optimized trajectory']);
  assert.equal(state.width, 320, 'The result inspector must match the fixed inspector width');
}

function check(name) { checks.push(name); console.log(`PASS ${name}`); }

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
    await click('.places .place', 'Settings');
    await click('.settings-general .seg-i', 'Imperial');
    await delay(250);
    await capture('document-settings.png');
    await click('.places .place', 'Routines');
    assert.equal(await evaluate(() => document.documentElement.dataset.units), 'imperial');
    await waitFor(() => evaluate(() => !document.querySelector('.routine-status')), 'routine preview');
    await delay(250);
    await capture('routine-toolbar.png');
    await click('.places .place', 'Paths');
    const imperialProject = await save();
    assert.equal(imperialProject.editor.unitSystem, 'imperial');
    assert.deepEqual(imperialProject.paths[0].waypoints, fixture.paths[0].waypoints);
    await evaluate(() => localStorage.setItem('bordeaux.unitSystem', 'metric'));
    await loadApp();
    await ready();
    assert.equal(await evaluate(() => document.documentElement.dataset.units), 'imperial');
    check('document units save and reopen over a different machine preference without changing geometry');
    await click('.places .place', 'Settings');
    await click('.settings-general .seg-i', 'Metric');
    await click('.places .place', 'Paths');
    await ready();
    const normal = await snapshot();
    const normalEvidence = await strictEditing(fixture.paths[0].id, false, normal);
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
    assert.equal(await evaluate(() => !!document.querySelector('button[aria-label="Preview optimized trajectory"]')), false, 'The background job must not create a candidate on the selected path');
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
    assert.equal(project.paths[0].optimization?.accepted, undefined);
    check('search completion leaves selected timing and geometry unchanged');
    await click('button[aria-label="Preview optimized trajectory"]');
    const candidate = await snapshot();
    assert.ok(Number(candidate.time) < Number(normal.time), 'Candidate comparison must display faster timing');
    assert.notEqual(candidate.geometry, normal.geometry, 'Candidate comparison must show improved geometry');
    await click('.optimizer-toggle');
    await stable(normal, 250, 'Closing the comparison');
    await click('.optimizer-toggle');
    assert.equal(await evaluate(() => [...document.querySelectorAll('.optimizer-panel button')].some((item) => item.textContent === 'Cancel')), false);
    await stable(normal, 350, 'Reopening the candidate');
    await click('button[aria-label="Preview optimized trajectory"]');
    await stable(candidate, 250, 'Reopened candidate comparison');
    check('closing comparison restores selected timing and reopening keeps the result without rerunning');
    const expectedGain = Number(normal.time) - Number(candidate.time);
    const expectedGainLabel = `${expectedGain.toFixed(2)} s faster, ${(expectedGain / Number(normal.time) * 100).toFixed(1)}%`;
    await waitFor(async () => (await snapshot()).status === expectedGainLabel, 'gain and percentage against the actual normal trajectory');
    await evaluate(() => {
      const heading = document.querySelector('.optimizer-outcome[role="status"]');
      const labels = [heading.textContent];
      const observer = new MutationObserver(() => labels.push(heading.textContent));
      observer.observe(heading, { childList: true, subtree: true, characterData: true });
      window.__optimizerGainProbe = { labels, stop: () => observer.disconnect() };
    });
    const toolbarBeforeApply = await evaluate(() => [...document.querySelectorAll('.toolbar .tb-actions button, .toolbar > .keyboard-help-trigger')].map((button) => {
      const box = button.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }));
    const applyJobs = await markJobs('Apply retains the authored Normal reference');
    await click('.optimizer-panel button', 'Apply optimized');
    await waitFor(() => evaluate(() => document.querySelector('.optimizer-toggle')?.textContent === 'Optimized'), 'the applied selection');
    const toolbarAfterApply = await evaluate(() => [...document.querySelectorAll('.toolbar .tb-actions button, .toolbar > .keyboard-help-trigger')].map((button) => {
      const box = button.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }));
    assert.deepEqual(toolbarAfterApply, toolbarBeforeApply, 'Applying optimization must not shift the help or toolbar buttons when its label changes');
    check('Optimize to Optimized preserves toolbar geometry');
    const applied = await snapshot();
    assert.equal(applied.time, candidate.time);
    assert.equal(applied.geometry, candidate.geometry);
    project = await save();
    const accepted = project.paths[0].optimization.accepted;
    assert.equal(accepted.version, 2, 'New Apply must select the waypoint-route contract');
    assert.ok(accepted?.result?.samples?.length > 0, 'Apply must persist the actual accepted artifact');
    assert.equal(Number(applied.time), accepted.result.totalTimeS, 'Displayed time must match the saved trajectory exactly');
    await stable(applied, 6500, 'Applied candidate');
    await strictEditing(fixture.paths[0].id, true, applied, accepted);
    const appliedJobs = await jobsSince(applyJobs);
    const selectedJobs = appliedJobs.filter(job => job.pathId === fixture.paths[0].id);
    assert.equal(selectedJobs.filter(job => job.mode === 'editing' && job.acceptedIdentity !== null).length, 1, 'Apply requires one current accepted editing request');
    assert.equal(selectedJobs.filter(job => job.mode !== 'editing' && !job.optimize).length, 0, 'Apply must retain Normal without another selected or authored reference request');
    workerEvidence.checkpoints.push({ ...applyJobs, jobs: appliedJobs, passed: true });
    check(applyJobs.label);
    const gainLabels = await evaluate(() => {
      const probe = window.__optimizerGainProbe;
      probe.stop();
      delete window.__optimizerGainProbe;
      return probe.labels;
    });
    assert.ok(gainLabels.every((label) => label === expectedGainLabel), `Displayed gain changed while applying: ${JSON.stringify(gainLabels)}`);
    check('gain and percentage match actual normal timing and stay stable while applying');
    check('compare/apply selects and persists the exact candidate beyond the worker deadline');
    await click('button[aria-label="Preview normal trajectory"]');
    await stable(normal, 250, 'Retained authored Normal after Apply');
    await click('button[aria-label="Preview optimized trajectory"]');
    await click('button[title="Close optimization"]');
    const historyJobs = await markJobs('Undo and Redo preserve the same authored Normal reference');
    for (const redo of [false, true]) {
      await focusEditor();
      const modifiers = [process.platform === 'darwin' ? 'meta' : 'control', ...(redo ? ['shift'] : [])];
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers });
      await waitFor(() => evaluate((accepted) => document.querySelector('.optimizer-toggle')?.textContent === (accepted ? 'Optimized' : 'Optimize'), redo), redo ? 'Redo Apply' : 'Undo Apply');
      await ready();
      await stable(redo ? applied : normal, 250, redo ? 'Redo selected trace' : 'Undo selected trace');
      const historyProject = await save();
      if (redo) assert.deepEqual(historyProject.paths[0].optimization.accepted, accepted);
      else assert.equal(historyProject.paths[0].optimization?.accepted, undefined);
      await strictEditing(fixture.paths[0].id, redo, redo ? applied : normal, redo ? accepted : null);
    }
    await click('.optimizer-toggle');
    await click('button[aria-label="Preview normal trajectory"]');
    await stable(normal, 250, 'Authored Normal after Undo/Redo');
    await click('button[aria-label="Preview optimized trajectory"]');
    const historyRequests = await jobsSince(historyJobs);
    assert.equal(historyRequests.filter(job => job.pathId === fixture.paths[0].id && job.mode !== 'editing' && !job.optimize).length, 0, 'History must reuse Normal at an unchanged physical key');
    workerEvidence.checkpoints.push({ ...historyJobs, jobs: historyRequests, passed: true });
    check(historyJobs.label);
    const layout = await evaluate(() => {
      const panel = document.querySelector('.optimizer-panel').getBoundingClientRect();
      const field = document.querySelector('.fieldsvg').getBoundingClientRect();
      return { panelX: panel.x, fieldRight: field.right, fieldHeight: field.height, fieldWidth: field.width, width: innerWidth, height: innerHeight };
    });
    assert.ok(layout.panelX >= layout.fieldRight - 1, 'The optimization inspector must not overlap the field');
    assert.ok(layout.fieldHeight > layout.height * 0.5, 'The comparison field must remain usable with the inspector open');
    assert.ok(layout.fieldWidth > layout.width * 0.35, 'The optimizer inspector must leave room to inspect the route');
    check('optimizer inspector preserves field space');
    await capture('optimizer-applied.png');
    await captureMinimum('optimizer-applied-1100x720.png');
    await switchPath(fixture.paths[1].name);
    await switchPath(fixture.paths[0].name);
    await stable(applied, 300, 'Path switch');
    await save();
    await loadApp();
    await ready();
    await stable(applied, 500, 'Save/reload');
    check('applied timing and geometry survive path switching and save/reload');
    await click('.places .place', 'Settings');
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
    assert.deepEqual(project.paths[0].optimization.accepted, accepted);
    await ready();
    await stable(applied, 1000, 'Cosmetic robot note');
    check('cosmetic robot notes preserve the applied selection');
    await strictEditing(fixture.paths[0].id, true, applied, accepted);
    const coldJobs = await markJobs('cold accepted open requests only one authored Normal at density 56');
    await click('.optimizer-toggle');
    await waitFor(() => evaluate(() => { const normal = document.querySelector('button[aria-label="Preview normal trajectory"]'); return normal && !normal.disabled; }), 'cold accepted Normal comparison to become ready from its actual worker completion');
    await stable(applied, 700, 'Reopening an applied selection');
    const coldRequests = await jobsSince(coldJobs);
    assert.equal(coldRequests.length, 1, 'Cold accepted open needs exactly one additional request after initial/library work settles');
    assert.equal(coldRequests[0].pathId, fixture.paths[0].id);
    assert.equal(coldRequests[0].mode, 'legacy');
    assert.equal(coldRequests[0].optimize, false);
    assert.equal(coldRequests[0].quality, 'final');
    assert.equal(coldRequests[0].density, 56);
    assert.equal(coldRequests[0].acceptedIdentity, null);
    assert.equal(coldRequests[0].status, 'ready');
    const coldPreview = await evaluate(sequence => window.__optimizerWorkers.valueFor(sequence), coldRequests[0].sequence);
    // Separate solves have different wall-clock diagnostics. Preserve every physical trace/metadata field.
    const withoutSolveWallTime = trajectory => {
      if (!trajectory.optimization || !Object.hasOwn(trajectory.optimization, 'solveTimeMs')) return trajectory;
      assert.ok(Number.isFinite(trajectory.optimization.solveTimeMs) && trajectory.optimization.solveTimeMs >= 0);
      return { ...trajectory, optimization: { ...trajectory.optimization, solveTimeMs: 0 } };
    };
    assert.deepEqual(withoutSolveWallTime(coldPreview.finalTrajectory), withoutSolveWallTime(normalEvidence.value.trajectory), 'Cold authored Normal must reproduce the complete original Normal trace');
    for (const field of ['prof', 'metrics', 'markers']) {
      assert.deepEqual(coldPreview[field], normalEvidence.value.derived[field], `Cold Normal must preserve full ${field} projection metadata`);
    }
    await fs.writeFile(path.join(output, 'cold-normal-preview.json'), JSON.stringify(coldPreview, null, 2));
    workerEvidence.checkpoints.push({ ...coldJobs, jobs: coldRequests, passed: true });
    check(coldJobs.label);
    await capture('optimizer-cold-ready.png');
    await captureMinimum('optimizer-cold-ready-1100x720.png');
    await click('button[aria-label="Preview normal trajectory"]');
    await stable(normal, 250, 'Cold authored Normal reference');
    await click('button[aria-label="Preview optimized trajectory"]');
    await click('button[title="Close optimization"]');
    const acceptedReopen = await markJobs('accepted reopen reuses selected and authored Normal with zero jobs');
    await click('.optimizer-toggle');
    await waitFor(() => evaluate(() => { const normal = document.querySelector('button[aria-label="Preview normal trajectory"]'); return normal && !normal.disabled; }), 'retained Normal after accepted reopen');
    await stable(applied, 350, 'Reopened accepted reference');
    await noJobsSince(acceptedReopen);
    assert.equal(await evaluate(() => [...document.querySelectorAll('.optimizer-panel button')].some((item) => item.textContent === 'Cancel')), false);
    assert.equal(await evaluate(() => document.querySelector('.optimizer-main')?.textContent), 'Applied');
    check('reopening an accepted result preserves it without starting a search');
    await openSettings();
    await click('.optimizer-panel button', 'Optimize all');
    await waitFor(() => evaluate(() => document.querySelector('.optimizer-batch')?.textContent.includes('2 of 2 paths searched')), 'Optimize all to finish both paths', 22_000);
    const allStatuses = await evaluate(() => [...document.querySelectorAll('.optimizer-batch button')].map((item) => item.textContent));
    assert.equal(allStatuses.length, 2);
    const failedStatus = allStatuses.find((status) => !status.includes('Ready'));
    if (failedStatus) {
      await click('.optimizer-batch button', failedStatus);
      await delay(200);
      const error = await evaluate(() => document.querySelector('.optimizer-error')?.textContent || document.querySelector('.optimizer-outcome[role="status"]')?.textContent);
      assert.fail(`${failedStatus}: ${error}`);
    }
    await stable(applied, 600, 'Optimize all');
    project = await save();
    assert.deepEqual(project.paths[0].optimization.accepted, accepted, 'Optimize all must preserve the applied artifact');
    assert.equal(project.paths[1].optimization?.accepted, undefined, 'Optimize all must leave the other path on normal');
    check('Optimize all stages each path without changing selected trajectories');
    await capture('optimizer-all.png');
    await captureMinimum('optimizer-all-1100x720.png');
    await switchPath(fixture.paths[1].name);
    const alternateNormal = await snapshot();
    await click('.optimizer-panel button', 'Apply optimized');
    await waitFor(() => evaluate(() => document.querySelector('.optimizer-toggle')?.textContent === 'Optimized'), 'the alternate applied selection');
    await switchPath(fixture.paths[0].name);
    await click('button[aria-label="Preview normal trajectory"]');
    await stable(normal, 250, 'Primary normal comparison after path switch');
    await switchPath(fixture.paths[1].name);
    await click('button[aria-label="Preview normal trajectory"]');
    await stable(alternateNormal, 250, 'Alternate normal comparison after path switch');
    await switchPath(fixture.paths[0].name);
    await stable(applied, 250, 'Selected comparison restored on path switch');
    check('Normal comparison stays on the current path when switching between applied paths');
    await click('.pt-wp');
    // The shared numeric control is named by its associated label, not an
    // aria-label attribute. Resolve that real control before native input.
    const waypointXSelector = await evaluate(() => {
      const label = [...document.querySelectorAll('.pp label')].find(item => item.textContent === 'X');
      if (!label?.control) throw new Error('Required waypoint X input missing');
      return '.pp input[id=' + JSON.stringify(label.htmlFor) + ']';
    });
    await click(waypointXSelector);
    await evaluate(selector => document.querySelector(selector).select(), waypointXSelector);
    const movedX = fixture.paths[0].waypoints[0].x + 0.1;
    await focusEditor();
    await window.webContents.insertText(String(movedX));
    await waitFor(() => evaluate(value => document.activeElement?.value === value, String(movedX)), 'the required waypoint draft');
    await focusEditor();
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await waitFor(() => evaluate(selector => document.activeElement !== document.querySelector(selector), waypointXSelector), 'waypoint edit to commit and move focus');
    await waitFor(async () => /Needs update/.test((await snapshot()).status || ''), 'explicit stale optimization status');
    project = await save();
    assert.equal(project.paths[0].waypoints[0].x, movedX, 'The required waypoint input must commit its edited value');
    project = await save();
    assert.ok(project.paths[0].optimization.accepted, 'Stale artifacts remain available for an explicit choice');
    check('changing a required waypoint invalidates the selection with an explicit stale state');
    await capture('optimizer-stale.png');
    await captureMinimum('optimizer-stale-1100x720.png');
    await click('.places .place', 'Routines');
    await waitFor(() => evaluate(() => { const play = document.querySelector('button[aria-label="Play routine"]'); return play && !play.disabled && !document.querySelector('.routine-status'); }), 'the stale selection to use current normal routine planning');
    assert.ok((await save()).paths[0].optimization.accepted, 'Routine fallback must retain the stale artifact');
    check('stale accepted selections use current normal routine playback while retaining the artifact');
    await click('.places .place', 'Paths');
    await click('.optimizer-panel button', 'Use normal');
    project = await save();
    assert.equal(project.paths[0].optimization?.accepted, undefined);
    await ready();
    check('Use normal removes the accepted artifact');
    await click('.places .place', 'Routines');
    await waitFor(() => evaluate(() => {
      const play = document.querySelector('button[aria-label="Play routine"]');
      return play && !play.disabled && !document.querySelector('.routine-status');
    }), 'routine playback after choosing normal');
    check('choosing normal restores routine playback');
    await click('.places .place', 'Paths');
    await switchPath(fixture.paths[1].name);
    await click('.places .place', 'Settings');
    await click('input[aria-label="Motor free speed"]');
    await evaluate(() => {
      const input = document.querySelector('input[aria-label="Motor free speed"]');
      if (!input) throw new Error('Motor free-speed input missing');
      input.select();
    });
    await focusEditor();
    await window.webContents.insertText('1000');
    // Exercise one native blur, rather than fabricating a second focusout after
    // blur has already committed the robot configuration.
    await focusEditor();
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await waitFor(() => evaluate(() => document.activeElement !== document.querySelector('input[aria-label="Motor free speed"]')), 'motor edit to commit and move focus');
    await click('.places .place', 'Paths');
    await waitFor(async () => /Needs update/.test((await snapshot()).status || ''), 'physical robot edits to invalidate the applied trajectory');
    const currentNormalLabel = await evaluate(() => document.querySelector('button[aria-label="Preview normal trajectory"] b')?.textContent);
    assert.notEqual(currentNormalLabel, `${Number(alternateNormal.time).toFixed(2)} s`, 'Robot edits must not relabel old normal timing as current');
    project = await save();
    assert.ok(project.robot.maxSpeed < fixture.robot.maxSpeed / 2, 'The robot speed limit must be substantially lower');
    assert.equal(project.robot.driveModel.motorFreeRpm, 1000);
    assert.ok(project.paths[1].optimization.accepted, 'Robot edits retain the stale artifact for an explicit choice');
    await click('.optimizer-panel button', 'Use normal');
    await ready();
    const slowerNormal = await snapshot();
    assert.ok(Number(slowerNormal.time) > Number(alternateNormal.time) * 1.5, 'Current normal timing must reflect the slower robot');
    assert.equal(slowerNormal.geometry, alternateNormal.geometry, 'Changing robot speed must preserve the authored geometry');
    project = await save();
    assert.equal(project.paths[1].optimization?.accepted, undefined);
    check('physical robot edits invalidate applied timing and regenerate the current slower normal trajectory');
    assert.deepEqual(errors, [], 'Renderer console must remain free of unexpected errors');
    check('renderer console has no unexpected errors');
    await settledWorkers();
    await archiveWorkers('complete');
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, checks, errors, knownConsoleWarnings, workerEvidence,
      normalTimeS: Number(normal.time), optimizedTimeS: Number(applied.time), savedAcceptedTimeS: accepted.result.totalTimeS }, null, 2));
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
