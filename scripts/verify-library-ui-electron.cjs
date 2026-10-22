const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const output = process.env.BORDEAUX_LIBRARY_UI_OUTPUT;
const rendererHtml = process.env.BORDEAUX_LIBRARY_UI_RENDERER;
if (!rendererHtml) throw new Error('Run verify-library-ui.mjs to build the isolated legacy integration fixture');
app.setPath('userData', path.join(output, 'user-data'));
const errors = [], checks = [], prepared = [], diagnosticPreviews = [], diagnosticSaves = [];
let win, saved, finishPush, lastProblemActivationDiagnostic;
const problemActivationNative = [];
let connectionFromSettings = false;
let editorPlace = 'Paths';
let deferInspection = false, finishInspection;
const inspection = () => ({ verifiedAt: new Date().toISOString(), comparison: { paths: {}, routines: {} }, status: { activeRevision: 'fixture-revision', retainedRevisions: [] } });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true);
async function wait(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw new Error('Timed out: ' + label); }
async function click(selector, text) {
  if (selector === '[aria-label="Save project"]') {
    await click('.project-chip');
    await click('.project-menu [role="menuitem"][data-action="save"]');
    return;
  }
  if (selector === '.library-connection' && !(await evaluate(() => document.querySelector('.settings-general')))) {
    await click('.place', 'Settings'); connectionFromSettings = true;
  }
  // Settings is a place in the toolbar; returning goes back to the place it was entered from (the old Editor button).
  if (selector === '.place' && text === 'Settings') editorPlace = (await evaluate(() => document.querySelector('.place[aria-current="page"]')?.textContent)) || editorPlace;
  await wait(() => evaluate((selector, text) => {
    const el = [...document.querySelectorAll(selector)].find((item) => text == null || (item.firstElementChild?.textContent.trim() === text || item.textContent.trim() === text));
    return Boolean(el && !el.disabled && !el.closest('[inert]'));
  }, selector, text), 'ready control: ' + selector + ' ' + text);
  await evaluate((selector, text) => {
    const el = [...document.querySelectorAll(selector)].find((item) => text == null || (item.firstElementChild?.textContent.trim() === text || item.textContent.trim() === text));
    if (!el || el.disabled || el.closest('[inert]')) throw new Error('Unavailable: ' + selector + ' ' + text);
    el.click();
  }, selector, text); await delay(50);
  if (connectionFromSettings && (selector === '[aria-label="Close robot connection"]' || selector === '[aria-label="Close diagnostic bundle"]')) {
    connectionFromSettings = false; await click('.place', editorPlace);
  }
}
async function pointerClick(selector, modifiers = []) {
  await wait(() => evaluate((selector) => {
    const el = document.querySelector(selector);
    return Boolean(el && !el.disabled && !el.closest('[inert]'));
  }, selector), 'ready pointer target: ' + selector);
  const point = await evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el || el.disabled || el.closest('[inert]')) throw new Error('Unavailable pointer target: ' + selector);
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, selector);
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1, modifiers });
  win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1, modifiers });
  await delay(80);
}
async function key(keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await delay(60);
}
async function assertDeletionFeedback(message, name) {
  const notice = await evaluate(() => {
    const footer = document.querySelector('.deletion-footer'), row = footer?.querySelector('.deletion-notice');
    const button = row?.querySelector('button'), status = footer?.querySelector('[role="status"]');
    return { message: row?.querySelector('.deletion-copy')?.textContent, detail: status?.textContent,
      polite: status?.getAttribute('aria-live'), atomic: status?.getAttribute('aria-atomic'),
      action: button?.getAttribute('aria-label'), enabled: Boolean(button && !button.disabled && button.getAttribute('aria-disabled') !== 'true'),
      confirms: window.__confirms };
  });
  assert.equal(notice.message, message);
  assert.ok(notice.detail?.includes(name), 'The deletion announcement identifies its actual target');
  assert.equal(notice.polite, 'polite'); assert.equal(notice.atomic, 'true');
  assert.equal(notice.action, 'Undo: ' + notice.detail); assert.equal(notice.enabled, true);
  assert.deepEqual(notice.confirms, [], 'Local deletion offers Undo without a native confirmation');
}
// Problems disclosure checks use semantic relationships, independently of menu CSS classes.
function inspectProblemsDisclosure() {
  const panel = document.querySelector('aside.pp[aria-label="Properties"]');
  const triggers = [...(panel?.querySelectorAll('button[aria-haspopup="menu"]') || [])];
  const visible = triggers.filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const trigger = visible[0], count = trigger?.textContent.trim().match(/^Problems\s+([1-9]\d*)$/);
  const issues = [...document.querySelectorAll('.pt svg g.pt-issue')];
  const menu = trigger && document.getElementById(trigger.getAttribute('aria-controls'));
  return {
    current: Boolean(panel && document.querySelector('.fieldcol') && document.querySelector('.pt') && !document.querySelector('.fieldcol[data-planning-ready="false"],.pt[data-stale],.pt .pt-issue.stale')),
    present: triggers.length === 1 && visible.length === 1 && Boolean(trigger.getAttribute('aria-controls')) && Number(count?.[1]) === issues.length && issues.length > 0,
    absent: triggers.length === 0 && issues.length === 0 && !panel?.querySelector('.pp-problem,[role="menu"]'),
    oldLabels: document.querySelectorAll('.pt-issue-label').length,
    open: Boolean(trigger?.getAttribute('aria-expanded') === 'true' && menu?.getAttribute('role') === 'menu' && panel.contains(menu) && menu.matches(':popover-open')),
  };
}
async function waitProblemsDisclosure(present, label) {
  await wait(async () => { const state = await evaluate(inspectProblemsDisclosure); return state.current && state.oldLabels === 0 && state[present ? 'present' : 'absent']; }, label);
}
async function assertProblemsForeground() {
  assert.equal(win.isFocused(), true, 'Problems gesture requires native foreground focus');
  assert.equal(await evaluate(() => document.hasFocus()), true, 'Problems gesture requires renderer focus');
}
async function problemsPointerClick(selector) {
  await assertProblemsForeground();
  const point = await evaluate(selector => {
    const targets = [...document.querySelectorAll(selector)].filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    if (targets.length !== 1) throw new Error('Expected exactly one visible Problems-flow target: ' + selector);
    const el = targets[0];
    if (el.disabled || el.closest('[inert]')) throw new Error('Unavailable Problems-flow target: ' + selector);
    el.scrollIntoView({ block: 'nearest' });
    const box = el.getBoundingClientRect(), x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height / 2);
    if (!el.contains(document.elementFromPoint(x, y))) throw new Error('Obscured Problems-flow target: ' + selector);
    return { x, y };
  }, selector);
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
  await delay(80);
}
async function selectFirstDisclosedProblem() {
  await problemsPointerClick('aside.pp[aria-label="Properties"] button[aria-haspopup="menu"]');
  await wait(async () => (await evaluate(inspectProblemsDisclosure)).open, 'native Problems popover opens');
  await assertProblemsForeground(); await key('Home');
  const firstName = await evaluate(() => {
    const trigger = document.querySelector('aside.pp[aria-label="Properties"] button[aria-haspopup="menu"]');
    const menu = document.getElementById(trigger.getAttribute('aria-controls'));
    const rows = [...menu.querySelectorAll('[role="menuitemradio"]')];
    if (rows.length !== document.querySelectorAll('.pt svg g.pt-issue').length || !rows.every((row, index) => row.getAttribute('aria-label')?.startsWith((index + 1) + '. '))) throw new Error('Problems rows must retain the full original issue order');
    if (document.activeElement !== rows[0]) throw new Error('Native Home must focus original issue index zero');
    return rows[0].getAttribute('aria-label');
  });
  await assertProblemsForeground(); await key('Enter');
  await wait(() => evaluate(() => {
    const panel = document.querySelector('aside.pp[aria-label="Properties"]');
    const trigger = panel.querySelector('button[aria-haspopup="menu"]');
    const issues = [...document.querySelectorAll('.pt svg g.pt-issue')];
    return panel.querySelector('.pp-problem') && issues[0]?.classList.contains('selected') && issues.filter(issue => issue.classList.contains('selected')).length === 1
      && trigger.getAttribute('aria-expanded') === 'false' && !panel.querySelector('[role="menu"]') && document.activeElement === trigger;
  }), 'original first issue selects the shared panel/underlay and closes with trigger focus');
  const title = await evaluate(() => document.querySelector('aside.pp[aria-label="Properties"] .pp-title').textContent);
  assert.ok(title.length > 0 && firstName.startsWith('1. ' + title), 'Shared panel describes the original first menu issue');
}
async function stampProblemActivation(label) {
  const native = { label, at: Date.now(), visible: win.isVisible(), focused: win.isFocused() };
  const stamped = await evaluate(label => { const trace = window.__problemActivationDiagnostic; if (!trace) return false; trace.active = true; trace.capture(label); return true; }, label);
  if (stamped) problemActivationNative.push(native);
}
async function retainProblemActivationDiagnostic() {
  const renderer = await evaluate(() => {
    const trace = window.__problemActivationDiagnostic;
    return trace && { timeOrigin: performance.timeOrigin, workers: trace.workers, dom: trace.dom, events: trace.events };
  });
  if (renderer) lastProblemActivationDiagnostic = { renderer, native: problemActivationNative.slice() };
  if (lastProblemActivationDiagnostic) await fs.writeFile(path.join(output, 'problem-post-undo-diagnostic.json'), JSON.stringify(lastProblemActivationDiagnostic, null, 2));
}
async function restoreProblemActivationDiagnostic() {
  await retainProblemActivationDiagnostic();
  const cleanup = await evaluate(() => window.__restoreProblemActivationDiagnostic?.());
  if (lastProblemActivationDiagnostic && cleanup) { lastProblemActivationDiagnostic.cleanup = cleanup; await fs.writeFile(path.join(output, 'problem-post-undo-diagnostic.json'), JSON.stringify(lastProblemActivationDiagnostic, null, 2)); }
}
async function input(selector, value) {
  await evaluate((selector, value) => {
    const el = document.querySelector(selector);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, selector, value); await delay(50);
}
const check = (name) => { checks.push(name); console.log('PASS ' + name); };
const activePathId = () => evaluate(() => document.querySelector('.library-pick[aria-current="true"]').dataset.libraryItem);
const editorReady = (label) => wait(() => evaluate(() => !document.querySelector('.fieldcol[data-planning-ready="false"]') && document.querySelectorAll('.pt-wp').length > 1), label);
// Selects the second waypoint on the timeline and nudges it right with a real key press to the editor.
async function nudgeSecondWaypoint() {
  await evaluate(() => { const point = document.querySelectorAll('.pt-wp')[1]; point.click(); point.blur(); });
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
  await delay(80);
}
async function keyboardUndo() {
  await evaluate(() => document.activeElement?.blur());
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'z', modifiers: ['control'] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'z', modifiers: ['control'] });
  await delay(80);
}
ipcMain.handle('library:restore', () => ({ project: saved }));
let saveFailure = '', deferredSave = null, saveAttempts = 0;
ipcMain.handle('library:save', async (_event, project) => {
  saveAttempts++;
  if (saveFailure) throw new Error(saveFailure);
  if (deferredSave) await deferredSave.promise;
  saved = project; return { saved: true };
});
ipcMain.handle('library:diagnostic-preview', (_event, project) => {
  diagnosticPreviews.push(project);
  return { previewId: 'fixture-preview-capability', contents: JSON.stringify({ version: 'fixture', project: project.name }) };
});
ipcMain.handle('library:diagnostic-save', (_event, previewId) => {
  assert.equal(previewId, 'fixture-preview-capability'); diagnosticSaves.push(previewId);
  return { saved: true };
});
ipcMain.handle('library:prepare', (_event, project, scope) => {
  prepared.push({ project, scope });
  const selected = scope.kind === 'paths' ? project.paths.filter((item) => scope.pathIds.includes(item.id)) : project.routines.filter((item) => item.id === scope.routineId);
  return { operationId: 'fixture-operation', robot: 'Team 2468', project: project.name, catalog: 'Fixture catalog', revision: 'fixture-revision', payloadHash: 'fixture-hash', size: 100,
    summary: { kind: scope.kind, pathIds: scope.pathIds || [], selectedNames: selected.map((item) => item.name), addedNames: [], updatedNames: selected.map((item) => item.name), preservedPathCount: project.paths.length - (scope.pathIds?.length || 0), routine: 'Routine A' } };
});
ipcMain.handle('library:confirm', () => new Promise((resolve) => { finishPush = resolve; }));
ipcMain.handle('library:inspect', () => deferInspection ? new Promise((resolve) => { finishInspection = resolve; }) : inspection());
app.whenReady().then(async () => {
  try {
    const corpus = JSON.parse(await fs.readFile(path.resolve('benchmarks/planner-corpus/v2/corpus.bordeaux.json'), 'utf8'));
    const source = corpus.paths.find((item) => item.id === 'corpus-neutral-stop');
    saved = { ...corpus, name: 'Library verification', paths: Array.from({ length: 200 }, (_, index) => ({ ...structuredClone(source), id: 'library-path-' + index, name: index === 0 ? 'Opening move' : index === 1 ? 'Collect second' : 'Practice path ' + index, folderId: 'center' })),
      pathFolders: [{ id: 'center', name: 'Center' }, { id: 'side', name: 'Side' }], pathLinks: [],
      routines: [{ id: 'routine-a', name: 'Routine A', nodes: [{ id: 'step-a', type: 'path', ref: 'library-path-0' }, { id: 'decision-a', type: 'decision', cond: '', thenLabel: 'Piece collected', elseLabel: 'Try again', then: [{ id: 'step-then', type: 'path', ref: 'library-path-1' }], else: [{ id: 'step-else', type: 'path', ref: 'library-path-0' }] }, { id: 'step-finish', type: 'path', ref: 'library-path-1' }] }, { id: 'routine-b', name: 'Routine B', nodes: [] }], activeRoutineId: 'routine-a', editor: { activePathId: 'library-path-0' } };
    win = new BrowserWindow({ show: false, width: 1440, height: 900, useContentSize: true, webPreferences: { contextIsolation: true, sandbox: false, backgroundThrottling: false, preload: path.join(__dirname, 'verify-library-ui-preload.cjs') } });
    win.webContents.on('console-message', (details) => { if (details.level === 'error' && !details.message.startsWith("Loading the font 'data:font/woff2")) errors.push(details.message); });
    await win.loadFile(rendererHtml);
    await wait(() => evaluate(() => document.querySelector('.library-pick[aria-current="true"] .library-name')?.textContent === 'Opening move'), 'restored library');
    assert.equal(await evaluate(() => document.querySelectorAll('.library-pick').length), 200);
    assert.equal(await evaluate(() => document.querySelectorAll('.library-row input[type="checkbox"]').length), 0, 'Normal browsing must not show batch-selection controls');
    assert.equal(await evaluate(() => document.querySelectorAll('.toolbar .library-connection,.toolbar .document-settings-trigger,.toolbar .exportrobot').length), 0);
    await click('.place', 'Settings');
    assert.equal(await evaluate(() => !!document.querySelector('.settings-general .library-connection')), true);
    await click('[aria-label="Display units"] button', 'Imperial');
    assert.equal(await evaluate(() => [...document.querySelectorAll('[aria-label="Display units"] button')].find((button) => button.textContent === 'Imperial').getAttribute('aria-pressed')), 'true');
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height);
      await click('[aria-label="Display units"] button', width === 1440 ? 'Metric' : 'Imperial');
      await pointerClick('#robot-drive-motor');
      await pointerClick('[role="option"][data-value="rev-neo"]');
      const motorState = () => ({
        locked: ['Motor free speed', 'Motor torque limit'].every(label => document.querySelector(`[aria-label="${label}"]`).disabled),
        editable: ['Drive reduction', 'Wheel diameter', 'Drive motors', 'Mass'].every(label => !document.querySelector(`[aria-label="${label}"]`).disabled),
        rpm: document.querySelector('[aria-label="Motor free speed"]').value,
      });
      assert.deepEqual(await evaluate(motorState), { locked: true, editable: true, rpm: '5676' });
      // Scrubbing a preset's unit must not mutate its value or select Custom.
      const p = await evaluate(() => { const el = document.querySelector('[aria-label="Motor free speed"]').nextElementSibling; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; });
      win.webContents.sendInputEvent({ type: 'mouseDown', ...p, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x + 50, y: p.y });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: p.x + 50, y: p.y, button: 'left', clickCount: 1 });
      await delay(80);
      assert.equal(await evaluate(() => document.querySelector('#robot-drive-motor').textContent.includes('REV NEO')), true);
      assert.equal((await evaluate(motorState)).rpm, '5676');
      await evaluate(() => window.getSelection().removeAllRanges());
      await fs.writeFile(path.join(output, `motor-preset-${width}.png`), (await win.webContents.capturePage()).toPNG());
      await pointerClick('#robot-drive-motor');
      await pointerClick('[role="option"][data-value="custom"]');
      assert.equal((await evaluate(motorState)).locked, false);
      await pointerClick('[aria-label="Motor free speed"]');
      await key('Home');
      await key('End', ['shift']);
      await win.webContents.insertText('5800');
      await key('Tab');
      assert.equal(await evaluate(() => document.activeElement.getAttribute('aria-label')), 'Motor torque limit');
      assert.equal((await evaluate(motorState)).rpm, '5800');
      await fs.writeFile(path.join(output, `motor-custom-${width}.png`), (await win.webContents.capturePage()).toPNG());
      check(`Motor preset locks only published specs; custom accepts keyboard edits at ${width}`);
    }
    win.setContentSize(1440, 900);
    await click('.rp-shapes button', 'Custom');
    const vertexValue = async (raw, cancel = false) => {
      await evaluate(() => { const el = document.querySelector('[aria-label="Vertex 1 X"]'); el.focus(); el.select(); });
      await win.webContents.insertText(raw);
      if (cancel) { await key('Escape'); await evaluate(() => document.querySelector('[aria-label="Vertex 1 X"]').dispatchEvent(new FocusEvent('focusout', { bubbles: true }))); }
      else await evaluate(() => { const el = document.querySelector('[aria-label="Vertex 1 X"]'); el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); el.blur(); });
      await click('[aria-label="Save project"]');
      return saved.robot.footprint.verticesM[0].x;
    };
    assert.ok(Math.abs(await vertexValue('-10') + .254) < 1e-10, 'Imperial footprint edits store canonical meters');
    for (const invalid of ['', 'NaN', '2oops']) assert.ok(Math.abs(await vertexValue(invalid) + .254) < 1e-10);
    assert.ok(Math.abs(await vertexValue('-12', true) + .254) < 1e-10, 'Escape preserves footprint position');
    assert.equal(await evaluate(() => document.querySelector('[aria-label="Vertex 1 X"]').nextElementSibling.textContent), 'in');
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(100);
      await evaluate(() => document.querySelector('[aria-label="Vertex 1 X"]').scrollIntoView({ block: 'center' }));
      assert.equal(await evaluate(() => { const row = document.querySelector('.rp-vertex'); return row.scrollWidth <= row.clientWidth; }), true);
      await fs.writeFile(path.join(output, `custom-footprint-${width}.png`), (await win.webContents.capturePage()).toPNG());
    }
    win.setContentSize(1440, 900);
    await click('[aria-label="Display units"] button', 'Metric');
    assert.equal(await evaluate(() => document.querySelector('[aria-label="Vertex 1 X"]').value), '-0.254');
    await click('.rp-shapes button', 'Rectangle');
    check('custom footprint respects displayed units, invalid drafts, Escape, and narrow layout');
    await click('.place', editorPlace);
    check('Settings contains connection and working display units; toolbar has no connection, units, or JSON export');
    await wait(() => evaluate(() => document.querySelector('[data-role="wp"]') && !document.querySelector('.fieldcol[data-planning-ready="false"]')), 'editable field');
    await pointerClick('rect[data-role="wp"][data-idx="1"]', ['shift']);
    await click('[aria-label="Save project"]');
    assert.equal(saved.paths[0].waypoints.length, 2, 'Shift-click deletes the authored waypoint');
    await key('Z', ['meta']);
    await wait(() => evaluate(() => document.querySelectorAll('.pt-wp').length === 3 && !document.querySelector('.fieldcol[data-planning-ready="false"]')), 'undo deleted waypoint');
    check('Shift-click deletes a waypoint and Undo restores it');
    await pointerClick('[data-selection="wp:0"]');
    await pointerClick('[data-role="ct"][data-idx="1"]', ['shift']);
    await click('[aria-label="Save project"]');
    assert.equal(saved.paths[0].waypoints.length, 2, 'Shift-click on a control handle deletes its waypoint');
    await key('Z', ['meta']);
    await wait(() => evaluate(() => document.querySelectorAll('.pt-wp').length === 3 && !document.querySelector('.fieldcol[data-planning-ready="false"]')), 'undo control-handle waypoint deletion');
    for (const remaining of [2, 1, 0]) {
      await pointerClick('[data-selection="wp:0"]', ['shift']);
      await click('[aria-label="Save project"]');
      assert.equal(saved.paths[0].waypoints.length, remaining, 'Timeline Shift-click can remove the final waypoint');
    }
    for (const restored of [1, 2, 3]) {
      await key('Z', ['meta']);
      await wait(() => evaluate((count) => document.querySelectorAll('.pt-wp').length === count, restored), 'undo final waypoint deletion');
    }
    await wait(() => evaluate(() => !document.querySelector('.fieldcol[data-planning-ready="false"]')), 'restored trajectory');
    await pointerClick('[data-library-item="library-path-2"]', ['shift']);
    assert.equal(await evaluate(() => document.querySelectorAll('.library-pick').length), 199, 'Library Shift-click deletes an unreferenced path');
    await pointerClick('.deletion-notice button');
    assert.equal(await evaluate(() => document.querySelectorAll('.library-pick').length), 200, 'Native Undo restores the deleted path');
    await pointerClick('[aria-label="Actions for folder Side"]', ['shift']);
    assert.equal(await evaluate(() => [...document.querySelectorAll('.library-folder')].some(el => el.textContent.includes('Side'))), false, 'Shift-click on folder actions deletes the folder');
    await pointerClick('.deletion-notice button');
    await click('.place', 'Routines');
    await pointerClick('[data-id="step-a"] .rt-step-ic', ['shift']);
    assert.equal(await evaluate(() => !!document.querySelector('[data-id="step-a"]')), false, 'Routine Shift-click deletes from the whole row');
    await pointerClick('.deletion-notice button');
    assert.equal(await evaluate(() => !!document.querySelector('[data-id="step-a"]')), true, 'Routine Undo restores the step');
    await pointerClick('[data-library-item="routine-b"]', ['shift']);
    assert.equal(await evaluate(() => !!document.querySelector('[data-library-item="routine-b"]')), false, 'Shift-click deletes the routine');
    await pointerClick('.deletion-notice button');
    await click('.place', 'Paths');
    check('Native Shift deletion and Undo cover the last waypoint, library paths/folders, routine rows and routines');
    if (process.env.BORDEAUX_SHIFT_DELETE_ONLY) {
      assert.deepEqual(errors, []);
      await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ checks, errors }, null, 2));
      app.exit(0); return;
    }
    await evaluate(() => document.querySelectorAll('.pt-wp')[1].click());
    const numericBefore = await evaluate(() => document.querySelector('.numinput').value);
    await evaluate(() => { const field = document.querySelector('.numinput'); field.focus(); field.select(); });
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: '2' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: '2' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: '2' });
    await delay(80);
    assert.equal(await evaluate(() => document.activeElement === document.querySelector('.numinput')), true, 'Typing a number must keep numeric input focus');
    assert.equal(await evaluate(() => document.querySelector('.numinput').value), '2');
    assert.equal(await evaluate(() => document.querySelector('[title="Place waypoint  (2 or W)"]')?.getAttribute('aria-pressed')), 'false');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await delay(80);
    await evaluate(() => document.querySelectorAll('.pt-wp')[1].click());
    assert.equal(await evaluate(() => document.querySelector('.numinput').value), numericBefore, 'Escape must discard the numeric draft');
    check('numeric typing preserves focus and tool selection, and Escape discards the draft');
    await wait(() => evaluate(() => document.querySelector('[data-heading-control]') && !document.querySelector('.fieldcol[data-planning-ready="false"]')), 'heading menu target');
    await evaluate(() => document.querySelector('[data-heading-control]').focus());
    await key('F10', ['shift']);
    await wait(() => evaluate(() => document.querySelector('.ctxmenu [role="menuitem"]') === document.activeElement), 'heading menu focus');
    await key('End');
    assert.equal(await evaluate(() => document.activeElement.textContent), 'Type exact angle…');
    await key('Home'); await key('Down');
    assert.equal(await evaluate(() => document.activeElement.textContent), 'Face previous waypoint');
    await key('Escape');
    assert.equal(await evaluate(() => Boolean(document.querySelector('.ctxmenu'))), false);
    assert.equal(await evaluate(() => document.activeElement.hasAttribute('data-heading-control')), true);
    assert.equal(await evaluate(() => document.querySelectorAll('.pt-wp')[1].getAttribute('aria-pressed')), 'true');
    check('heading menu opens by keyboard, navigates, and restores focus without clearing selection');
    if (await evaluate(() => !!document.querySelector('[aria-label="Hide inspector"]'))) await click('[aria-label="Hide inspector"]');
    await delay(250); // Wait for the inspector width transition before measuring the field target.
    const headingPoint = await evaluate(() => {
      const circle = document.querySelector('[data-heading-control] circle');
      const r = circle.getBoundingClientRect();
      // A selected tangent handle can overlap the center of this heading target.
      // Use an exposed interior point of the same circle, verified by hit testing.
      for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const point = { x: Math.round(r.x + r.width * fx), y: Math.round(r.y + r.height * fy) };
        if (document.elementFromPoint(point.x, point.y) === circle) return point;
      }
      throw new Error('Heading pointer has no exposed interior hit target');
    });
    win.webContents.sendInputEvent({ type: 'mouseMove', ...headingPoint });
    win.webContents.sendInputEvent({ type: 'mouseDown', ...headingPoint, button: 'right', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', ...headingPoint, button: 'right', clickCount: 1 });
    await wait(() => evaluate(() => !!document.querySelector('.ctxmenu')), 'pointer heading menu');
    await delay(200); // Allow the menu to paint before capturing evidence.
    await fs.writeFile(path.join(output, 'heading-pointer-menu.png'), (await win.webContents.capturePage()).toPNG());
    for (const code of ['Left', 'Right', 'Delete']) await key(code);
    await key('End'); await key('Space');
    await wait(() => evaluate(() => document.querySelector('.rail-r input') && !document.querySelector('.ctxmenu')), 'exact angle inspector opens from menu Space');
    await click('[aria-label="Save project"]');
    assert.deepEqual(saved.paths[0].waypoints, source.waypoints, 'Menu key navigation must not nudge or delete geometry');
    check('pointer-opened heading menu isolates editor keys and Space opens the exact-angle inspector');



    const beforeModal = structuredClone(saved.paths[0].waypoints);
    for (const diagnostic of [false, true]) {
      await click('.library-connection');
      await wait(() => evaluate(() => document.querySelector('dialog.robot-manager').open), 'robot connection modal');
      if (diagnostic) await click('[aria-label="Diagnostics"]');
      const closeSelector = diagnostic ? '[aria-label="Close diagnostic bundle"]' : '[aria-label="Close robot connection"]';
      if (diagnostic) {
        await evaluate(() => [...document.querySelectorAll('[aria-labelledby="beta-diagnostic-title"] button')].at(-1).focus());
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
        await delay(80);
        assert.equal(await evaluate(() => document.querySelector('[aria-labelledby="beta-diagnostic-title"]').contains(document.activeElement)), true, 'Tab must stay inside the diagnostic modal');
        await fs.writeFile(path.join(output, 'diagnostic-dialog.png'), (await win.webContents.capturePage()).toPNG());
      }
      await evaluate((selector) => document.querySelector(selector).focus(), closeSelector);
      for (const keyCode of ['Delete', 'Right', '2']) {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
      }
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'z', modifiers: ['control'] });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'z', modifiers: ['control'] });
      await delay(80);
      assert.equal(await evaluate((selector) => document.activeElement === document.querySelector(selector), closeSelector), true, 'Editor shortcuts must not blur a modal control');
      await click(closeSelector);
      await click('[aria-label="Save project"]');
      assert.deepEqual(saved.paths[0].waypoints, beforeModal, 'Modal keys must not modify the path behind the dialog');
    }
    check('robot and diagnostic modals isolate editor tool, nudge, delete, and undo shortcuts');
    const maxVelocityBefore = saved.paths[0].constraints.maxVel;
    // The path speed limit is edited in place in the timeline header.
    const enterVelocity = async (raw) => {
      await wait(() => evaluate(() => !document.querySelector('.fieldcol[data-planning-ready="false"]')), 'editable numeric constraints');
      await evaluate(() => {
        const input = [...document.querySelectorAll('.pt-limits .numrow')].find((row) => row.querySelector('label')?.textContent === 'Speed').querySelector('input');
        input.focus(); input.select();
      });
      await win.webContents.insertText(raw);
      await delay(50);
      assert.equal(await evaluate(() => document.activeElement.value), raw, 'The numeric regression must exercise the requested text');
      await evaluate(() => {
        const input = document.activeElement;
        // The hidden BrowserWindow does not emit native focusout consistently.
        input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        input.blur();
      });
      await delay(80); await click('[aria-label="Save project"]');
      return saved.paths[0].constraints.maxVel;
    };
    assert.equal(await enterVelocity('999'), saved.robot.maxSpeed, 'Typed velocity must respect its maximum');
    assert.equal(await enterVelocity('-5'), 0.1, 'Typed velocity must respect its minimum');
    for (const invalid of ['Infinity', 'NaN', '2oops', '']) {
      assert.equal(await enterVelocity(invalid), 0.1, 'Invalid numeric text must preserve the current value: ' + invalid);
    }
    assert.equal(await enterVelocity(String(maxVelocityBefore)), maxVelocityBefore);
    check('numeric text commits respect bounds and reject nonfinite, malformed, and empty values');
    assert.deepEqual(await evaluate(() => [...document.querySelectorAll('.toolrail-b')].map((button) => button.getAttribute('aria-label'))),
      ['Select / move', 'Place waypoint', 'Rotation target', 'Place command', 'Zone']);
    await pointerClick('[aria-label="Place waypoint"]');
    await evaluate(() => document.activeElement.blur());
    for (const code of ['6', 'b']) {
      await key(code);
      assert.equal(await evaluate(() => document.querySelector('.toolrail-b.on').getAttribute('aria-label')), 'Place waypoint');
    }
    await key('1');
    assert.equal(await evaluate(() => document.querySelector('.toolrail-b.on').getAttribute('aria-label')), 'Select / move');
    await evaluate(() => document.querySelector('[aria-label="Select / move"]').focus());
    await key('Tab'); await key('Enter');
    assert.equal(await evaluate(() => document.querySelector('.toolrail-b.on').getAttribute('aria-label')), 'Place waypoint');
    await pointerClick('[aria-label="Select / move"]');
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(100);
      for (const inspector of ['open', 'closed']) {
        // The full inspector opens from the docked properties' More.
        const open = await evaluate(() => document.querySelector('.pp-more').getAttribute('aria-expanded') === 'true');
        if (open !== (inspector === 'open')) await pointerClick('.pp-more');
        await fs.writeFile(path.join(output, `editor-tools-${width}-${inspector}.png`), (await win.webContents.capturePage()).toPNG());
      }
    }
    win.setContentSize(1440, 900);
    check('five editor tools support pointer and keyboard selection; removed sculpt shortcuts preserve the active tool');
    const beforeNudge = structuredClone(saved.paths[0].waypoints[1]);
    await evaluate(() => { const point = document.querySelectorAll('.pt-wp')[1]; point.click(); point.focus(); });
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
    await delay(80); await click('[aria-label="Save project"]');
    assert.ok(Math.abs(saved.paths[0].waypoints[1].x - beforeNudge.x - .05) < 1e-6);
    await wait(() => evaluate(() => !document.querySelector('.fieldcol[data-planning-ready="false"]')), 'nudge settles');
    await evaluate(() => document.querySelectorAll('.pt-wp')[1].focus());
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Delete' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Delete' });
    await delay(80); await click('[aria-label="Save project"]');
    assert.equal(saved.paths[0].waypoints.length, 2);
    await evaluate(() => document.querySelector('.pt-wp').focus());
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'z', modifiers: ['control'] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'z', modifiers: ['control'] });
    await delay(80); await click('[aria-label="Save project"]');
    assert.equal(saved.paths[0].waypoints.length, 3);
    await evaluate(() => document.querySelector('.pt-wp').focus());
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'z', modifiers: ['control'] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'z', modifiers: ['control'] });
    await delay(80); await click('[aria-label="Save project"]');
    assert.deepEqual(saved.paths[0].waypoints[1], beforeNudge);
    // Pointer modality only (programmatic click and focus); real Tab → Enter → arrow navigation of points is
    // covered by work/rethink/tools/production/flow-corrections.mjs (PART=keys).
    check('after a pointer selection, timeline point focus preserves arrow nudge, Delete, and undo shortcuts');
    await wait(() => evaluate(() => !document.querySelector('.fieldcol[data-planning-ready="false"]')), 'restored trajectory');
    const original = structuredClone(saved.paths[0].waypoints[1]);
    const point = await evaluate(() => { const r = document.querySelector('[data-role="wp"][data-idx="1"]').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; });
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point }); await delay(50);
    win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 }); await delay(50);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x + 40, y: point.y + 20, button: 'left' });
    await wait(() => evaluate((originalPoint) => {
      const rect = document.querySelector('[data-role="wp"][data-idx="1"]').getBoundingClientRect();
      return Math.hypot(rect.x + rect.width / 2 - originalPoint.x, rect.y + rect.height / 2 - originalPoint.y) > 5;
    }, point), 'waypoint drag preview before switching');
    await click('[data-library-item="library-path-1"]');
    win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x + 40, y: point.y + 20, button: 'left', clickCount: 1 });
    await click('[aria-label="Save project"]');
    assert.ok(Math.hypot(saved.paths[0].waypoints[1].x - original.x, saved.paths[0].waypoints[1].y - original.y) > .01);
    assert.deepEqual(saved.paths[1].waypoints[1], original);
    assert.deepEqual(saved.paths.slice(0, 2).map(({ id, name }) => ({ id, name })), [
      { id: 'library-path-0', name: 'Opening move' }, { id: 'library-path-1', name: 'Collect second' },
    ], 'Finishing the captured pointer after switching preserves both path identities');
    await click('[data-library-item="library-path-0"]');
    check('switching commits an active pointer edit without modifying the destination path');
    await pointerClick('[data-library-item="library-path-0"]');
    await pointerClick('[data-library-item="library-path-1"]', [process.platform === 'darwin' ? 'meta' : 'control']);
    await pointerClick('[data-library-item="library-path-2"]', [process.platform === 'darwin' ? 'meta' : 'control']);
    assert.equal(await evaluate(() => document.querySelectorAll('.library-pick[aria-pressed="true"]').length), 3, 'Command/Control-click builds a batch');
    await pointerClick('[data-library-item="library-path-2"]', [process.platform === 'darwin' ? 'meta' : 'control']);
    assert.equal(await evaluate(() => document.querySelectorAll('.library-pick[aria-pressed="true"]').length), 2, 'Command/Control-click toggles one path without clearing the range');
    assert.equal(await evaluate(() => document.querySelectorAll('.library-row input[type="checkbox"]').length), 0);
    check('native Command/Control pointer selection works directly on rows without a selection mode');
    await input('.library-search', 'Opening');
    assert.equal(await evaluate(() => document.querySelector('.library-selection > span').textContent), '2 selected · 1 hidden');
    assert.equal(await evaluate(() => document.querySelector('.push-button').title), '2 paths · Ctrl+Shift+P');
    assert.equal(await evaluate(() => document.querySelector('.push-button').textContent.trim()), 'Push 2 paths');
    await click('.push-button');
    await wait(() => prepared.length === 1, 'captured scope');
    assert.deepEqual(prepared[0].scope, { kind: 'paths', pathIds: ['library-path-0', 'library-path-1'] });
    await wait(() => evaluate(() => document.querySelector('#robot-push-title')?.textContent === 'Review push'), 'review');
    await fs.writeFile(path.join(output, 'push-review.png'), (await win.webContents.capturePage()).toPNG());
    await click('.robot-push-dialog button', 'Push 2 paths');
    await wait(() => Boolean(finishPush), 'mock upload');
    await click('[aria-label="Close robot connection"]');
    await input('.library-search', 'Collect');
    await click('.library-pick');
    assert.equal(await evaluate(() => document.querySelector('.library-pick[aria-current="true"] .library-name').textContent), 'Collect second');
    assert.deepEqual(prepared[0].scope.pathIds, ['library-path-0', 'library-path-1']);
    await click('.library-connection');
    assert.match(await evaluate(() => document.querySelector('.robot-push-dialog').textContent), /Uploading/);
    finishPush({ state: 'active', revision: 'fixture-revision' });
    await wait(() => evaluate(() => document.querySelector('.robot-push-outcome')?.textContent.includes('Accepted by robot')), 'acceptance');
    await click('[aria-label="Close robot connection"]');
    check('hidden batch IDs stay fixed through review, upload, dismissal, and browsing');
    await click('.library-connection');
    await click('.robot-push-dialog button', 'Connection and history');
    await wait(() => evaluate(() => document.querySelector('[aria-label="Diagnostics"]')), 'diagnostics entry point');
    await click('[aria-label="Diagnostics"]');
    assert.equal(await evaluate(() => document.querySelector('dialog.robot-manager').open), false);
    assert.equal(await evaluate(() => document.querySelector('[aria-labelledby="beta-diagnostic-title"]').checkVisibility()), true);
    assert.equal(await evaluate(() => [...document.querySelectorAll('[aria-labelledby="beta-diagnostic-title"] button')].some((button) => button.textContent === 'Save bundle')), false);
    await click('[aria-labelledby="beta-diagnostic-title"] button', 'Generate preview');
    await wait(() => diagnosticPreviews.length === 1, 'local diagnostic preview');
    assert.equal(diagnosticPreviews[0].name, 'Library verification');
    const previewText = await evaluate(() => { const input = document.querySelector('[aria-label="Read-only beta diagnostic JSON"]'); return { contents: input.value, readOnly: input.readOnly }; });
    assert.equal(previewText.readOnly, true);
    assert.equal(JSON.parse(previewText.contents).project, 'Library verification');
    await click('[aria-labelledby="beta-diagnostic-title"] button', 'Save bundle');
    await wait(() => diagnosticSaves.length === 1, 'save preview capability');
    assert.equal(diagnosticSaves[0], 'fixture-preview-capability');
    assert.match(await evaluate(() => document.querySelector('[aria-labelledby="beta-diagnostic-title"]').textContent), /Diagnostic bundle saved/);
    await click('[aria-label="Close diagnostic bundle"]');
    check('connection opens usable diagnostics, then previews read-only bytes and saves the capability');
    await input('.library-search', '');
    await pointerClick('[data-library-item="library-path-0"]');
    assert.equal(await evaluate(() => document.querySelectorAll('.library-pick[aria-pressed="true"]').length), 1, 'Plain click returns to one selected path');
    assert.equal(await evaluate(() => document.querySelector('.push-button').textContent.trim()), 'Push path');
    assert.equal(await evaluate(() => [...document.querySelectorAll('.library-find button')].some((button) => ['Select', 'Done'].includes(button.textContent.trim() || button.getAttribute('aria-label')))), false);
    check('plain row click replaces a batch with the current path and there is no Select mode');
    await click('[aria-label="Actions for Opening move"]');
    await click('.library-menu button', 'Delete');
    assert.match(await evaluate(() => document.querySelector('.library-blocked').textContent), /Routine A/);
    win.setContentSize(1100, 720); await delay(150);
    assert.deepEqual(await evaluate(() => {
      const notice = document.querySelector('.library-blocked');
      return { border: getComputedStyle(notice).borderLeftWidth, role: notice.getAttribute('role'),
        title: notice.querySelector('strong').textContent, focused: document.activeElement === notice.querySelector('button') };
    }), { border: '0px', role: 'alert', title: 'Cannot delete Opening move', focused: true }, 'Blocked deletion explains the reference without a left stripe and focuses its recovery action');
    await fs.writeFile(path.join(output, 'library-blocked-1100.png'), (await win.webContents.capturePage()).toPNG());
    win.setContentSize(1440, 900); await delay(100);
    await click('.library-blocked button');
    assert.equal(await evaluate(() => document.querySelector('.library-pick[aria-current="true"] .library-name').textContent), 'Routine A');
    check('referenced deletion explains and opens its routine');
    await click('[aria-label="New routine"]');
    await input('.library-rename input', 'Fresh routine');
    await click('[aria-label="Save name"]');
    assert.equal(await evaluate(() => document.querySelector('.library-pick[aria-current="true"] .library-name').textContent), 'Fresh routine');
    assert.equal(await evaluate(() => document.querySelector('.routine-workspace-flow .rt-empty').checkVisibility()), true, 'New routine starts in the central flow empty state');
    await wait(() => evaluate(() => document.activeElement.matches('.library-pick')), 'renamed routine restores row focus');
    await click('[aria-label="Save project"]');
    assert.ok(saved.routines.some((routine) => routine.name === 'Fresh routine'));
    await click('.place', 'Settings'); await click('.place', editorPlace);
    assert.equal(await evaluate(() => document.querySelector('.place[aria-current="page"]').textContent), 'Routines');
    check('inline naming restores focus; Save and return-to-editor retain routine mode');
    await click('.place', 'Paths');
    await input('.library-search', 'no matches');
    assert.match(await evaluate(() => document.querySelector('.library-empty').textContent), /No matching names/);
    await click('.place', 'Routines'); await click('.place', 'Paths');
    assert.equal(await evaluate(() => document.querySelector('.library-search').value), 'no matches');
    await input('.library-search', '');
    // Paths fill the column; the resizable boundary is now between the field and the band under it.
    const bandState = () => evaluate(() => { const divider = document.querySelector('.band-divider'); return { now: Number(divider.getAttribute('aria-valuenow')), height: document.querySelector('.path-band').getBoundingClientRect().height }; });
    await evaluate(() => document.querySelector('.band-divider').focus());
    const bandBefore = await bandState();
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Up' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Up' }); await delay(60);
    const bandAfter = await bandState();
    assert.equal(bandAfter.now, bandBefore.now + 16);
    assert.ok(Math.abs(bandAfter.height - bandBefore.height - 16) < 1, 'The divider key moves the rendered band boundary: ' + JSON.stringify([bandBefore, bandAfter]));
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' }); await delay(60);
    assert.equal((await bandState()).now, bandBefore.now, 'Enter restores the balanced band');
    check('search persists per tab and the band divider works from the keyboard');
    await click('[aria-label="New folder"]');
    await input('.library-rename input', 'Practice'); await click('[aria-label="Save name"]');
    await click('[aria-label="New path"]');
    await input('.library-rename input', 'Managed path'); await click('[aria-label="Save name"]');
    await pointerClick('[data-library-item="library-path-0"]', [process.platform === 'darwin' ? 'meta' : 'control']);
    assert.equal(await evaluate(() => document.querySelectorAll('.library-pick[aria-pressed="true"]').length), 2, 'Newly created path remains in a Control/Command-click batch');
    await pointerClick('.library-pick[aria-current="true"]');
    check('creating a path preserves direct batch selection');
    await click('[aria-label="Actions for Managed path"]'); await click('.library-menu button', 'Duplicate');
    await click('[aria-label="Save name"]');
    assert.equal(await evaluate(() => document.querySelector('.library-pick[aria-current="true"] .library-name').textContent), 'Managed path copy');
    await click('[aria-label="Actions for Managed path copy"]');
    await click('.library-menu button', 'Move or link…');
    await evaluate(() => {
      const select = document.querySelector('.library-properties select');
      select.value = [...select.options].find((option) => option.text === 'Practice').value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await delay(60); await click('[aria-label="Save project"]');
    const managed = saved.paths.find((item) => item.name === 'Managed path copy');
    assert.ok(managed.id !== saved.paths.find((item) => item.name === 'Managed path').id);
    assert.equal(managed.folderId, saved.pathFolders.find((folder) => folder.name === 'Practice').id);
    await click('[aria-label="Close path properties"]');
    await click('[aria-label="Actions for Managed path copy"]');
    await click('.library-menu button', 'Append path'); await click('[aria-label="Save name"]');
    await click('[aria-label="Save project"]');
    assert.ok(saved.pathLinks.some((link) => link.fromPathId === managed.id));
    const practiceId = saved.pathFolders.find((folder) => folder.name === 'Practice').id;
    const practiceMembers = saved.paths.filter((item) => item.folderId === practiceId).map((item) => item.id);
    assert.ok(practiceMembers.length >= 2, 'Practice has several members: ' + JSON.stringify(practiceMembers));
    await evaluate(() => { window.__confirms = []; window.confirm = (message) => { window.__confirms.push(message); return true; }; });
    await click('[aria-label="Actions for folder Practice"]'); await click('.library-menu button', 'Delete folder');
    await assertDeletionFeedback('Folder deleted · Paths kept', 'Practice');
    await click('[aria-label="Save project"]');
    assert.ok(!saved.pathFolders.some((folder) => folder.name === 'Practice'));
    assert.ok(!saved.paths.find((item) => item.id === managed.id).folderId);
    await click('[title^="Undo"]'); await click('[aria-label="Save project"]');
    assert.equal(saved.paths.find((item) => item.id === managed.id).folderId, saved.pathFolders.find((folder) => folder.name === 'Practice')?.id, 'Undo restores the folder and its members');
    await click('[title^="Redo"]'); await click('[aria-label="Save project"]');
    assert.ok(!saved.pathFolders.some((folder) => folder.name === 'Practice'));
    // Library work after the deletion is not journaled; undoing the older deletion must keep it.
    const moveToFolder = async (name, folderName) => {
      await click('[aria-label="Actions for ' + name + '"]'); await click('.library-menu button', 'Move or link…');
      await evaluate((folderName) => {
        const select = document.querySelector('.library-properties select');
        select.value = [...select.options].find((option) => option.text === folderName).value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }, folderName);
      await delay(60); await click('[aria-label="Close path properties"]');
    };
    const folderReferencesResolve = () => saved.paths.every((item) => !item.folderId || saved.pathFolders.some((folder) => folder.id === item.folderId));
    await click('[aria-label="New folder"]');
    await input('.library-rename input', 'Later'); await click('[aria-label="Save name"]');
    await moveToFolder('Collect second', 'Later');
    await moveToFolder('Managed path copy', 'Later');
    await click('[aria-label="Save project"]');
    const laterId = saved.pathFolders.find((folder) => folder.name === 'Later').id;
    const geometryBeforeFolderUndo = saved.paths.map((item) => [item.id, item.name, item.waypoints]);
    const folderUndoChecks = () => {
      assert.ok(folderReferencesResolve(), 'Every folder membership resolves: ' + JSON.stringify(saved.paths.filter((item) => item.folderId).map((item) => [item.name, item.folderId])));
      assert.ok(saved.pathFolders.some((folder) => folder.id === laterId), 'A folder created after the deletion remains');
      assert.equal(saved.paths.find((item) => item.name === 'Collect second').folderId, laterId, 'An unrelated later move remains');
      assert.equal(saved.paths.find((item) => item.id === managed.id).folderId, laterId, 'A former member moved later keeps its new folder');
      assert.deepEqual(saved.paths.map((item) => [item.id, item.name, item.waypoints]), geometryBeforeFolderUndo, 'Names and geometry are unchanged');
    };
    await click('[title^="Undo"]'); await click('[aria-label="Save project"]');
    assert.equal(saved.pathFolders.find((folder) => folder.id === practiceId)?.name, 'Practice', 'Undo restores the deleted folder');
    for (const id of practiceMembers.filter((id) => id !== managed.id)) assert.equal(saved.paths.find((item) => item.id === id).folderId, practiceId, 'Unmoved members rejoin the folder');
    folderUndoChecks();
    await click('[title^="Redo"]'); await click('[aria-label="Save project"]');
    assert.ok(!saved.pathFolders.some((folder) => folder.id === practiceId), 'Redo deletes the folder again');
    folderUndoChecks();
    await click('[title^="Undo"]'); await click('[aria-label="Save project"]');
    const restoredLibrary = structuredClone({ paths: saved.paths, pathFolders: saved.pathFolders });
    const confirmsBeforeReload = await evaluate(() => window.__confirms);
    await win.loadFile(rendererHtml);
    await editorReady('library reopened after folder undo');
    await evaluate((list) => { window.__confirms = list; window.confirm = (message) => { window.__confirms.push(message); return true; }; }, confirmsBeforeReload);
    await click('[aria-label="Save project"]');
    assert.deepEqual({ paths: saved.paths, pathFolders: saved.pathFolders }, restoredLibrary, 'Save and reload keep the restored library');
    folderUndoChecks();
    check('undoing a folder deletion keeps later folders, moves, names, and geometry, and every membership resolves after reload');
    const managedOriginal = structuredClone(saved.paths.find((item) => item.name === 'Managed path'));
    const managedIndex = saved.paths.findIndex((item) => item.id === managedOriginal.id);
    await click('[aria-label="Actions for Managed path"]'); await click('.library-menu button', 'Delete');
    await assertDeletionFeedback('Path deleted', 'Managed path');
    await click('[aria-label="Save project"]');
    assert.ok(!saved.paths.some((item) => item.name === 'Managed path'));
    const confirms = await evaluate(() => window.__confirms);
    assert.deepEqual(confirms, [], 'Folder and path deletion never prompt for confirmation');
    // A newer edit to the visible path is undone before the older deletion; Redo replays both in order.
    await editorReady('path editor after deletion');
    const visiblePathId = await activePathId();
    const beforeVisibleEdit = structuredClone(saved.paths.find((item) => item.id === visiblePathId).waypoints[1]);
    await nudgeSecondWaypoint(); await click('[aria-label="Save project"]');
    assert.ok(Math.abs(saved.paths.find((item) => item.id === visiblePathId).waypoints[1].x - beforeVisibleEdit.x - .05) < 1e-6);
    await click('[title^="Undo"]'); await click('[aria-label="Save project"]');
    assert.deepEqual(saved.paths.find((item) => item.id === visiblePathId).waypoints[1], beforeVisibleEdit, 'First Undo reverses the newer path edit');
    assert.ok(!saved.paths.some((item) => item.id === managedOriginal.id), 'The older deletion waits for the next Undo');
    await click('[title^="Undo"]'); await click('[aria-label="Save project"]');
    assert.deepEqual(saved.paths[managedIndex], managedOriginal, 'Second Undo restores the deleted path in place');
    assert.equal(await activePathId(), visiblePathId, 'Restoring another path keeps the visible path');
    await click('[title^="Redo"]'); await click('[aria-label="Save project"]');
    assert.ok(!saved.paths.some((item) => item.id === managedOriginal.id), 'Redo deletes the path again');
    await click('[title^="Redo"]'); await click('[aria-label="Save project"]');
    assert.ok(Math.abs(saved.paths.find((item) => item.id === visiblePathId).waypoints[1].x - beforeVisibleEdit.x - .05) < 1e-6, 'Redo replays the path edit');
    check('create, duplicate, move, append/link, and undoable folder and path deletion preserve data in chronological order');
    await click('.place', 'Routines'); await click('[data-library-item="routine-a"]');
    const dragRoutine = async (from, to, valid) => {
      const points = await evaluate((from, to) => {
        const grip = document.querySelector(`[data-id="${from}"] .rt-grip`), target = document.querySelector(`[data-id="${to}"] .rt-step-body`);
        grip.scrollIntoView({ block: 'nearest' });
        const a = grip.getBoundingClientRect(), b = target.getBoundingClientRect();
        return { a: { x: Math.round(a.x+a.width/2), y: Math.round(a.y+a.height/2) }, b: { x: Math.round(b.x+b.width/2), y: Math.round(b.bottom-3) } };
      }, from, to);
      win.webContents.sendInputEvent({ type: 'mouseDown', ...points.a, button: 'left', clickCount: 1 });
      await wait(() => evaluate(() => Boolean(document.querySelector('.rt-panel.dragging'))), 'routine pointer drag begins');
      win.webContents.sendInputEvent({ type: 'mouseMove', ...points.b, button: 'left' });
      if (valid) await wait(() => evaluate(() => Boolean(document.querySelector('.drop-before:not(.drop-invalid),.drop-after:not(.drop-invalid)'))), 'supported routine drop feedback');
      else await delay(100);
      assert.equal(await evaluate(() => Boolean(document.querySelector('.drop-before:not(.drop-invalid),.drop-after:not(.drop-invalid)'))), valid, 'Drop feedback must match the typed structural move guard');
      win.webContents.sendInputEvent({ type: 'mouseUp', ...points.b, button: 'left', clickCount: 1 });
      await delay(100); await click('[aria-label="Save project"]');
    };
    const routineBeforeDrag = structuredClone(saved.routines.find((r) => r.id === 'routine-a'));
    await dragRoutine('decision-a', 'step-then', false);
    assert.deepEqual(saved.routines.find((r) => r.id === 'routine-a'), routineBeforeDrag);
    assert.equal(await evaluate(() => document.querySelector('.rt-flow-note')?.textContent.includes('A step cannot move inside itself.')), true, 'Rejected descendant move explains its guard');
    await dragRoutine('step-a', 'step-then', true);
    const routineCrossList = saved.routines.find((r) => r.id === 'routine-a');
    assert.deepEqual(routineCrossList.nodes.map((node) => node.id), ['decision-a', 'step-finish']);
    assert.deepEqual(routineCrossList.nodes[0].then.map((node) => node.id), ['step-then', 'step-a']);
    assert.deepEqual(routineCrossList.nodes[0].then[1], routineBeforeDrag.nodes[0], 'Cross-list drag preserves the complete moved step');
    await click('[title^="Undo"]'); await click('[aria-label="Save project"]');
    assert.deepEqual(saved.routines.find((r) => r.id === 'routine-a'), routineBeforeDrag, 'One Undo restores the exact routine after a cross-list move');
    await dragRoutine('step-a', 'step-finish', true);
    assert.equal(saved.routines.find((r) => r.id === 'routine-a').nodes.at(-1).id, 'step-a');
    const routineAfterDrag = structuredClone(saved.routines.find((r) => r.id === 'routine-a'));
    // Undo on a path never reaches back into the routine edited before switching.
    await click('.place', 'Paths');
    await editorReady('path editor after routine edit');
    const scopedPathId = await activePathId();
    const beforeScopedEdit = structuredClone(saved.paths.find((item) => item.id === scopedPathId).waypoints[1]);
    await nudgeSecondWaypoint(); await click('[aria-label="Save project"]');
    assert.notDeepEqual(saved.paths.find((item) => item.id === scopedPathId).waypoints[1], beforeScopedEdit);
    await keyboardUndo(); await click('[aria-label="Save project"]');
    assert.deepEqual(saved.paths.find((item) => item.id === scopedPathId).waypoints[1], beforeScopedEdit, 'First Undo reverses the path edit');
    await keyboardUndo(); await click('[aria-label="Save project"]');
    assert.deepEqual(saved.routines.find((r) => r.id === 'routine-a'), routineAfterDrag, 'A second path Undo leaves the routine intact');
    await click('.place', 'Routines'); await click('[data-library-item="routine-a"]');
    await click('[title^="Undo"]'); await click('[aria-label="Save project"]');
    assert.deepEqual(saved.routines.find((r) => r.id === 'routine-a'), routineBeforeDrag);
    await click('[title^="Redo"]'); await click('[aria-label="Save project"]');
    assert.deepEqual(saved.routines.find((r) => r.id === 'routine-a'), routineAfterDrag, 'Redo restores the routine edit on its own surface');
    await click('[title^="Undo"]'); await click('[aria-label="Save project"]');
    assert.deepEqual(saved.routines.find((r) => r.id === 'routine-a'), routineBeforeDrag);
    await click('.place', 'Paths');
    check('native routine drag supports cross-list and sibling moves, rejects descendants, and keeps path and routine Undo on their own surfaces');
    for (const [width, height] of [[1440, 900], [1280, 800], [1100, 720]]) {
      win.setContentSize(width, height); await delay(150);
      const geometry = await evaluate(() => {

        const rail = document.querySelector('.library-rail');
        return { sharedPositions: ['.places', '.project-chip'].map((selector) => document.querySelector(selector).getBoundingClientRect().x), overflow: document.documentElement.scrollWidth > innerWidth, fieldWidth: document.querySelector('.fieldcol').getBoundingClientRect().width, railWidth: rail.getBoundingClientRect().width, pushVisible: document.querySelector('.push-button').checkVisibility() };
      });
      assert.equal(geometry.overflow, false); assert.ok(geometry.fieldWidth >= 350); assert.equal(geometry.pushVisible, true);
      assert.equal(geometry.railWidth, 264, 'Library width remains fixed across supported sizes');

      // Push lives in the toolbar, so it stays inside it at every supported height.
      assert.equal(await evaluate(() => { const button = document.querySelector('.push-button').getBoundingClientRect(), bar = document.querySelector('.toolbar').getBoundingClientRect(); return button.bottom <= bar.bottom && button.top >= bar.top && button.right <= innerWidth; }), true, 'Push stays inside the toolbar at ' + width);
      await pointerClick('[data-library-item="library-path-0"]');
      await pointerClick('[data-library-item="library-path-1"]', [process.platform === 'darwin' ? 'meta' : 'control']);
      assert.equal(await evaluate(() => document.querySelector('.push-button').checkVisibility()), true);
      await fs.writeFile(path.join(output, `paths-${width}.png`), (await win.webContents.capturePage()).toPNG());
      await click('.place', 'Routines'); await click('[data-library-item="routine-a"]');
      const flowGeometry = await evaluate(() => {
        const flow = document.querySelector('.routine-workspace-flow'), stage = document.querySelector('.stage-auto');
        return { sharedPositions: ['.places', '.project-chip'].map((selector) => document.querySelector(selector).getBoundingClientRect().x), width: flow.getBoundingClientRect().width, height: flow.getBoundingClientRect().height, stageHeight: stage.getBoundingClientRect().height, railWidth: document.querySelector('.library-rail').getBoundingClientRect().width, inRail: Boolean(flow.closest('.library-rail')), flowInRail: Boolean(document.querySelector('.library-rail .rt-panel')), overflow: document.documentElement.scrollWidth > innerWidth, contentOverflow: flow.querySelector('.rt-scroll').scrollWidth > flow.querySelector('.rt-scroll').clientWidth };
      });
      assert.equal(flowGeometry.railWidth, geometry.railWidth);
      assert.deepEqual(flowGeometry.sharedPositions, geometry.sharedPositions, 'Shared toolbar actions stay anchored when switching to routines at ' + width);
      assert.equal(flowGeometry.inRail, false); assert.equal(flowGeometry.flowInRail, false);
      assert.ok(flowGeometry.width > width * .6, 'Unselected routine flow gets most screen width at ' + width);
      assert.ok(flowGeometry.height > flowGeometry.stageHeight * .7, 'Routine flow gets most workspace height');
      assert.equal(flowGeometry.overflow, false); assert.equal(flowGeometry.contentOverflow, false);
      await delay(500);
      await fs.writeFile(path.join(output, `routines-${width}.png`), (await win.webContents.capturePage()).toPNG());
      await click('.rt-step[data-id="step-then"] .rt-step-body');
      assert.equal(await evaluate(() => document.querySelector('[aria-label="Routine step inspector"]').checkVisibility()), true);
      assert.equal(await evaluate(() => { const el = document.querySelector('.rt-scroll'); return el.scrollWidth > el.clientWidth; }), false, 'Populated branch flow must not clip when the inspector opens');
      const branches = await evaluate(() => [...document.querySelectorAll('.rt-brlbl')].map((header) => {
        const key = header.querySelector('.rt-brkey').getBoundingClientRect();
        const name = header.querySelector('.rt-brname').getBoundingClientRect();
        const count = header.querySelector('.rt-brcount').getBoundingClientRect();
        return { keyLeft: key.left, keyRight: key.right, nameRight: name.right, countLeft: count.left };
      }));
      assert.ok(branches.length > 0);
      // Route rows read name, then its rule, then the count.
      for (const branch of branches) {
        assert.ok(branch.nameRight <= branch.keyLeft && branch.keyRight <= branch.countLeft, 'Branch labels and counts must not overlap: ' + JSON.stringify(branch));
      }
      await fs.writeFile(path.join(output, `routine-inspector-${width}.png`), (await win.webContents.capturePage()).toPNG());
      await click('[aria-label="Routine view"] button', 'Field preview');
      assert.equal(await evaluate(() => document.querySelector('.routine-workspace-field').checkVisibility()), true);
      assert.equal(await evaluate(() => document.querySelector('.routine-workspace-flow').checkVisibility()), false);
      await click('[aria-label="Routine view"] button', 'Flow');
      assert.equal(await evaluate(() => document.querySelector('.rt-step[data-id="step-then"] .rt-step-body').getAttribute('aria-pressed')), 'true');
      assert.equal(await evaluate(() => document.querySelector('.library-pick[aria-current="true"] .library-name').textContent), 'Routine A');
      if (width === 1440) {
        await click('.rail-r button', 'Open in path editor');
        assert.equal(await evaluate(() => document.querySelector('.library-pick[aria-current="true"] .library-name').textContent), 'Collect second');
        assert.deepEqual(await evaluate(() => [...document.querySelectorAll('.library-pick[aria-pressed="true"]')].map((item) => item.dataset.libraryItem)), ['library-path-1'], 'Opening a routine step path must replace the prior saved batch');
        await click('.place', 'Routines'); await click('[data-library-item="routine-a"]');
        await click('.rt-step[data-id="step-then"] .rt-step-body');
      }
      await click('[aria-label="Close step inspector"]');
      await click('.place', 'Paths');
    }
    check('200-item library keeps fixed width; populated flow owns central workspace at three desktop sizes and preserves selection across preview');
    // At the minimum library height, a long selected name and a save failure leave Push usable in the toolbar,
    // and the project chip, the only save surface, keeps Retry reachable by pointer and keyboard.
    const longName = 'Opening move from the far source side through the center line and back to the scoring position';
    await pointerClick('[data-library-item="library-path-0"]');
    await click('[aria-label="Actions for Opening move"]'); await click('.library-menu button', 'Rename');
    await input('.library-rename input', longName); await click('[aria-label="Save name"]');
    saveFailure = 'Could not save Library verification: the project folder /Volumes/Field laptop/Bordeaux projects/Library verification is read-only.';
    await click('[aria-label="Save project"]');
    const chipStatus = () => evaluate(() => document.querySelector('.project-chip').dataset.status);
    await wait(async () => await chipStatus() === 'failed', 'save failure on the chip');
    const minimumLayout = () => evaluate(() => {
      const top = document.querySelector('.library-top'), library = top.firstElementChild, rail = document.querySelector('.library-rail');
      const bounds = top.getBoundingClientRect();
      const reach = (element, area) => {
        if (!element) return null;
        const r = element.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
        return { inside: r.top >= area.top - .5 && r.bottom <= area.bottom + .5 && r.left >= area.left - .5 && r.right <= area.right + .5 && r.height > 0, hit: element.contains(document.elementFromPoint(x, y)), text: element.textContent.trim() };
      };
      const viewport = { top: 0, left: 0, bottom: innerHeight, right: innerWidth };
      return { push: reach(document.querySelector('.push-button'), viewport), chip: reach(document.querySelector('.project-chip'), viewport),
        name: reach(document.querySelector('.library-pick[aria-current="true"] .library-name'), bounds), clipped: library.scrollHeight - top.clientHeight,
        banner: Boolean(document.querySelector('.library-save-status, .library-location')), height: bounds.height, rail: rail.clientHeight };
    });
    const retryFocused = () => evaluate(() => document.activeElement?.matches('#project-menu [data-fix]') && document.activeElement.textContent === 'Retry');
    // The full inspector opens from the docked properties' More; Tab from the last row action reaches Push.
    const openInspector = async () => { if (await evaluate(() => document.querySelector('.pp-more').getAttribute('aria-expanded') !== 'true')) await click('.pp-more'); };
    // Push is the toolbar's robot end: Tab from the last place passes the place actions and the destination to reach it.
    const tabToPush = async () => { await evaluate(() => document.querySelector('.place:last-child').focus()); for (let i = 0; i < 8 && !(await evaluate(() => document.activeElement?.matches('.push-button'))); i++) await key('Tab'); };
    for (const [width, height] of [[1100, 720], [1440, 900]]) {
      win.setContentSize(width, height); await delay(150);
      await openInspector();
      const layout = await minimumLayout();
      assert.equal(layout.name.text, longName);
      const ordinaryTitle = await evaluate(() => { const t = document.querySelector('.ctxinsp .ctxinsp-t'); return t && { text: t.textContent, height: t.clientHeight, content: t.scrollHeight }; });
      assert.ok(ordinaryTitle && ordinaryTitle.text === longName && ordinaryTitle.content <= ordinaryTitle.height + 1, 'An ordinary long inspector title is shown whole without scrolling at ' + width + ': ' + JSON.stringify(ordinaryTitle));
      assert.ok(layout.clipped <= 1, 'Nothing is clipped at the minimum library height at ' + width + ': ' + JSON.stringify(layout));
      assert.equal(layout.banner, false, 'The library has no save banner; the chip carries the failure');
      for (const control of ['push', 'chip', 'name']) assert.deepEqual([layout[control].inside, layout[control].hit], [true, true], control + ' is visible and hit-testable at ' + width + ': ' + JSON.stringify(layout));
      await fs.writeFile(path.join(output, `paths-save-error-${width}.png`), (await win.webContents.capturePage()).toPNG());
      // Keyboard: Tab from the last row action reaches Push; ArrowDown on the chip opens its menu on Retry, and Enter retries.
      await tabToPush();
      assert.equal(await evaluate(() => document.activeElement === document.querySelector('.push-button')), true, 'Push is reachable by keyboard at ' + width);
      await evaluate(() => document.querySelector('.project-chip').focus()); await key('Down');
      assert.equal(await retryFocused(), true, 'Retry is reachable by keyboard at ' + width);
      const menu = await evaluate(() => { const r = document.querySelector('#project-menu').getBoundingClientRect(); return { bottom: r.bottom, right: r.right }; });
      assert.ok(menu.bottom <= height && menu.right <= width, 'The chip menu fits at ' + width + ': ' + JSON.stringify(menu));
      await fs.writeFile(path.join(output, `paths-save-error-menu-${width}.png`), (await win.webContents.capturePage()).toPNG());
      const keyed = saveAttempts;
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      await wait(async () => saveAttempts > keyed && await chipStatus() === 'failed', 'keyboard retry attempted');
      assert.equal(await evaluate(() => document.activeElement?.classList.contains('project-chip')), true, 'Keyboard Retry returns focus to the chip');
      // Pointer: Retry runs another save; it fails again and keeps its recovery action.
      const attempts = saveAttempts;
      await pointerClick('.project-chip'); await pointerClick('#project-menu [data-fix]');
      await wait(async () => saveAttempts > attempts && await chipStatus() === 'failed', 'retry attempted');
      assert.equal(await evaluate(() => document.activeElement?.classList.contains('project-chip')), true, 'Pointer Retry returns focus to the chip');
      assert.ok((await minimumLayout()).push.hit, 'Push stays reachable after a failed retry');
    }
    // A pending retry retains the failed outcome until it succeeds; aria-busy reports the in-flight write.
    saveFailure = ''; deferredSave = {}; deferredSave.promise = new Promise((resolve) => { deferredSave.resolve = resolve; });
    const pendingAttempts = saveAttempts;
    await pointerClick('.project-chip'); await pointerClick('#project-menu [data-fix]');
    await wait(async () => saveAttempts > pendingAttempts && await evaluate(() => document.querySelector('.project-chip').getAttribute('aria-busy') === 'true'), 'pending retry');
    assert.equal(await chipStatus(), 'failed', 'Retry keeps the previous failure visible until the write completes');
    const pendingLayout = await minimumLayout();
    assert.deepEqual([pendingLayout.push.inside, pendingLayout.push.hit], [true, true], 'Push stays reachable while a retry is pending');
    assert.ok(pendingLayout.clipped <= 1);
    await fs.writeFile(path.join(output, 'paths-save-pending-1440.png'), (await win.webContents.capturePage()).toPNG());
    deferredSave.resolve(); deferredSave = null;
    const openingName = () => saved.paths.find((item) => item.id === 'library-path-0').name;
    await wait(async () => openingName() === longName && await chipStatus() !== 'failed', 'retry saved');
    assert.equal(await evaluate(() => document.querySelector('.project-chip').getAttribute('aria-busy')), null, 'Completed retry clears the busy state');
    await click('[aria-label="Actions for ' + longName + '"]'); await click('.library-menu button', 'Rename');
    await input('.library-rename input', 'Opening move'); await click('[aria-label="Save name"]');
    await click('[aria-label="Save project"]');
    assert.equal(openingName(), 'Opening move');
    win.setContentSize(1100, 720); await delay(150);
    check('a long name and a failed or pending save keep Push reachable in the toolbar and chip Retry reachable by pointer and keyboard');
    // Any nonblank name is valid, so a 5000-character name must keep the same bounded minimum,
    // a complete and scrollable name, reachable actions and outline, and a working divider.
    const hugeName = 'W'.repeat(5000), moreButton = '.library-pick[data-library-item="library-path-0"] + .library-more';
    await pointerClick(moreButton); await click('.library-menu button', 'Rename');
    await input('.library-rename input', hugeName); await click('[aria-label="Save name"]');
    await click('[aria-label="Save project"]');
    assert.equal(openingName(), hugeName, 'Save keeps the complete name');
    const hugeLayout = async () => ({ ...await minimumLayout(), ...await evaluate(() => {
      const push = document.querySelector('.push-button');
      const text = document.createRange(); text.selectNodeContents(push);
      const textBox = text.getBoundingClientRect(), pushBox = push.getBoundingClientRect();
      // Waypoints stay reachable on the timeline whatever the path's name.
      const point = document.querySelector('.pt-wp'), r = point.getBoundingClientRect();
      // The intentional ::before hit area extends beyond the button and contributes to scrollHeight.
      // Measure the actual scope text instead, including its position within the visible button.
      return { nameScroll: { oneLine: getComputedStyle(push).whiteSpace === 'nowrap' && textBox.height <= push.clientHeight
          && textBox.top >= pushBox.top && textBox.bottom <= pushBox.bottom, label: push.title, scope: push.textContent.trim() },
        points: r.height > 0 && point.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) };
    }) });
    // The inspector header stays bounded: the complete title scrolls within it, while the close
    // button and body actions remain visible and topmost at their centers.
    const inspectorLayout = () => evaluate(() => {
      const panel = document.querySelector('.ctxinsp'), header = panel?.querySelector('.ctxinsp-hd'), title = panel?.querySelector('.ctxinsp-t');
      const close = panel?.querySelector('.ctxinsp-x'), body = panel?.querySelector('.ctxinsp-body');
      if (!header || !title || !close || !body) return null;
      const reach = (element, container) => {
        if (!element) return null;
        const r = element.getBoundingClientRect(), c = container.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
        return { x: Math.round(x), y: Math.round(y), hit: document.elementFromPoint(x, y)?.closest('button') === element,
          inside: r.width > 0 && r.height > 0 && r.left >= c.left - .5 && r.right <= c.right + .5 && r.top >= Math.max(0, c.top) - .5 && r.bottom <= Math.min(innerHeight, c.bottom) + .5 };
      };
      const swap = header.querySelector('.ctxinsp-act[aria-label="Swap start/end"]'), place = document.querySelector('.toolrail-b[aria-label="Place waypoint"]');
      const b = body.getBoundingClientRect(), t = title.getBoundingClientRect();
      return { header: header.getBoundingClientRect().height, close: reach(close, panel), swap: reach(swap, panel), place: reach(place, document.querySelector('.toolrail') || document.body),
        title: { text: title.textContent, label: title.title, height: title.clientHeight, content: title.scrollHeight, top: title.scrollTop, wide: title.scrollWidth > title.clientWidth,
          lineHeight: parseFloat(getComputedStyle(title).lineHeight), point: { x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) } },
        // The left padding of the body is its own surface, so the wheel cannot land on a control.
        body: { height: body.clientHeight, content: body.scrollHeight, top: body.scrollTop, point: { x: Math.round(b.left + 6), y: Math.round(b.top + b.height / 2) } },
        tool: document.querySelector('.toolrail-b[aria-pressed="true"]')?.getAttribute('aria-label'), features: document.querySelectorAll('.pt-wp').length,
        time: document.querySelector('.pt-clock-now')?.textContent };
    });
    const assertInspectorUsable = (layout, width) => {
      assert.ok(layout, 'The path inspector is open at ' + width);
      assert.equal(layout.title.text, hugeName, 'The inspector title keeps the complete name at ' + width);
      assert.equal(layout.title.label, hugeName);
      assert.ok(layout.title.height <= layout.title.lineHeight * 5 + 1 && layout.title.content > layout.title.height && !layout.title.wide, 'The title scrolls vertically within five lines at ' + width + ': ' + JSON.stringify(layout.title));
      assert.ok(layout.header <= Math.max(53, layout.title.height + 24), 'The header stays bounded by its title at ' + width + ': ' + layout.header);
      for (const control of ['close', 'swap', 'place']) assert.deepEqual([layout[control]?.inside, layout[control]?.hit], [true, true], control + ' is visible and topmost at ' + width + ': ' + JSON.stringify(layout));
      assert.ok(layout.body.height >= 200, 'The inspector body keeps a usable height at ' + width + ': ' + JSON.stringify(layout.body));
    };
    const nativeClick = async ({ x, y }) => {
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      await delay(80);
    };
    const wheelAt = ({ x, y }, deltaY) => {
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      win.webContents.sendInputEvent({ type: 'mouseWheel', x, y, deltaY, canScroll: true });
    };
    // The scroller under the wheel point, what the point actually hits, and both inspector offsets.
    const scrollState = (selector, point) => evaluate((selector, point) => {
      const el = document.querySelector(selector), hit = document.elementFromPoint(point.x, point.y);
      const describe = (node) => node && node.tagName.toLowerCase() + [...node.classList].map((name) => '.' + name).join('');
      return el && { top: el.scrollTop, height: el.clientHeight, content: el.scrollHeight, owned: Boolean(hit && el.contains(hit)), hit: describe(hit),
        title: document.querySelector('.ctxinsp .ctxinsp-t')?.scrollTop, body: document.querySelector('.ctxinsp-body')?.scrollTop };
    }, selector, point);
    // One huge wheel step can be capped or merged into an animation still in flight, so this sends
    // bounded native steps, each settled before the next, until the scroller reaches its end.
    const wheelUntil = async (selector, point, direction, reached, label) => {
      let state = await scrollState(selector, point), stalled = 0;
      const history = [state?.top];
      const fail = (reason) => new Error('Timed out: ' + label + ' (' + reason + '): ' + JSON.stringify({ point, state, history: history.slice(-12) }));
      if (!state?.owned) throw fail('the wheel point is not over the scroller');
      const step = Math.min(600, Math.max(100, 3 * state.height));
      for (let index = 0; index < 200 && !reached(state); index++) {
        const before = state.top;
        wheelAt(point, -direction * step);
        // Settled: moved and then steady for two reads, or unmoved for 500ms.
        for (let read = 0, steady = 0; read < 30 && steady < 2; read++) {
          await delay(50);
          const next = await scrollState(selector, point);
          steady = next?.top === state?.top && (next?.top !== before || read >= 9) ? steady + 1 : 0;
          state = next;
        }
        history.push(state?.top);
        if (!state?.owned) throw fail('the wheel point stopped hitting the scroller');
        stalled = state.top === before ? stalled + 1 : 0;
        if (stalled >= 3) throw fail('three settled wheel steps did not move the scroller');
      }
      if (!reached(state)) throw fail('200 wheel steps did not reach the end');
    };
    const titleEnd = (s) => s.top > 0 && s.top + s.height >= s.content - 1, scrollStart = (s) => s.top === 0;
    let inspectorBodyScrolled = false;
    for (const [width, height] of [[1100, 720], [1440, 900]]) {
      win.setContentSize(width, height); await delay(150);
      await openInspector();
      const layout = await hugeLayout();
      assert.equal(layout.name.text, hugeName, 'The selected name is not truncated at ' + width);
      // Push names its scope on one line; its title and the inspector retain the full path name.
      assert.ok(layout.nameScroll.oneLine && layout.nameScroll.label === hugeName + ' · Ctrl+Shift+P', 'The long push-target name stays on one line (Push says its scope) with its full text available: ' + JSON.stringify({ ...layout.nameScroll, label: layout.nameScroll.label.length }));
      assert.equal(layout.nameScroll.scope, 'Push path', 'The visible Push label stays the exact scope even with a 5000-character name');
      assert.ok(layout.clipped <= 1, 'Nothing is clipped at the minimum at ' + width + ': ' + JSON.stringify(layout));
      for (const control of ['push', 'name']) assert.deepEqual([layout[control].inside, layout[control].hit], [true, true], control + ' is visible and hit-testable at ' + width + ': ' + JSON.stringify(layout));
      assert.equal(layout.points, true, 'Timeline waypoints stay reachable at ' + width);
      // Keyboard: Tab from the last row action reaches Push.
      await fs.writeFile(path.join(output, `paths-5000-character-name-${width}.png`), (await win.webContents.capturePage()).toPNG());
      await tabToPush();
      assert.equal(await evaluate(() => document.activeElement === document.querySelector('.push-button')), true, 'Push is reachable by keyboard at ' + width);
      // The row menu still opens within the viewport from its pointer trigger, and Escape returns focus.
      await pointerClick(moreButton);
      const menu = await evaluate(() => { const el = document.querySelector('.library-menu'), r = el?.getBoundingClientRect(); return el && { top: r.top, bottom: r.bottom, height: innerHeight, focused: el.contains(document.activeElement) }; });
      assert.ok(menu && menu.top >= 0 && menu.bottom <= menu.height && menu.focused, 'The row menu stays usable at ' + width + ': ' + JSON.stringify(menu));
      await key('Escape');
      assert.equal(await evaluate((selector) => !document.querySelector('.library-menu') && document.activeElement === document.querySelector(selector), moreButton), true);
      // Inspector: the bounded header keeps the close button and body actions reachable.
      const inspector = await inspectorLayout();
      assertInspectorUsable(inspector, width);
      // The wheel reads the whole title in place, to its last line, without scrolling the body.
      wheelAt(inspector.title.point, -100);
      await wait(() => evaluate(() => document.querySelector('.ctxinsp .ctxinsp-t').scrollTop > 0), 'wheel scrolls the inspector title at ' + width);
      await wheelUntil('.ctxinsp .ctxinsp-t', inspector.title.point, 1, titleEnd, 'wheel reaches the end of the inspector title at ' + width);
      await wait(() => evaluate(() => { const t = document.querySelector('.ctxinsp .ctxinsp-t'); return t.scrollTop > 0 && t.scrollTop + t.clientHeight >= t.scrollHeight - 1; }), 'wheel reaches the end of the inspector title at ' + width);
      assert.equal((await inspectorLayout()).body.top, 0, 'Scrolling the title leaves the body in place at ' + width);
      await wheelUntil('.ctxinsp .ctxinsp-t', inspector.title.point, -1, scrollStart, 'wheel returns to the start of the inspector title at ' + width);
      await wait(() => evaluate(() => document.querySelector('.ctxinsp .ctxinsp-t').scrollTop === 0), 'wheel returns to the start of the inspector title at ' + width);
      // Pointer: the tool rail's Place waypoint arms placement; Select clears it before the field is touched.
      await nativeClick(inspector.place);
      await wait(() => evaluate(() => document.querySelector('.toolrail-b[aria-pressed="true"]')?.getAttribute('aria-label') === 'Place waypoint'), 'pointer reaches Place waypoint at ' + width);
      const selectTool = await evaluate(() => {
        const button = document.querySelector('.toolrail-b[aria-label="Select / move"]'), r = button.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
        return { x: Math.round(x), y: Math.round(y), hit: document.elementFromPoint(x, y)?.closest('button') === button };
      });
      assert.equal(selectTool.hit, true, 'The select tool is topmost at ' + width);
      await nativeClick(selectTool);
      const cleared = await inspectorLayout();
      assert.equal(cleared.tool, 'Select / move', 'Placement is cleared at ' + width);
      assert.equal(cleared.features, inspector.features, 'Arming placement adds no waypoint at ' + width);
      assertInspectorUsable(cleared, width);
      // The wheel scrolls an overflowing body and returns it to the top.
      if (cleared.body.content > cleared.body.height + 1) {
        wheelAt(cleared.body.point, -200);
        await wait(() => evaluate(() => document.querySelector('.ctxinsp-body').scrollTop > 0), 'wheel scrolls the inspector body at ' + width);
        assert.equal((await inspectorLayout()).title.top, 0, 'Scrolling the body leaves the title in place at ' + width);
        await wheelUntil('.ctxinsp-body', cleared.body.point, -1, scrollStart, 'wheel returns the inspector body to the top at ' + width);
        await wait(() => evaluate(() => document.querySelector('.ctxinsp-body').scrollTop === 0), 'wheel returns the inspector body to the top at ' + width);
        inspectorBodyScrolled = true;
      }
      // Pointer closes at the exact close button and focus returns to More; keyboard reopens.
      await nativeClick((await inspectorLayout()).close);
      await wait(() => evaluate(() => !document.querySelector('.ctxinsp') && document.activeElement === document.querySelector('.pp-more')), 'pointer closes the inspector and focuses More at ' + width);
      await key('Tab', ['shift']); await key('Tab');
      assert.equal(await evaluate(() => document.activeElement === document.querySelector('.pp-more')), true, 'Keyboard reaches More at ' + width);
      await key('Enter');
      await wait(() => evaluate(() => !!document.querySelector('.ctxinsp .ctxinsp-x')), 'keyboard reopens the inspector at ' + width);
      const reopenedInspector = await inspectorLayout();
      assertInspectorUsable(reopenedInspector, width);
      assert.equal(reopenedInspector.time, inspector.time, 'Enter on More does not start playback at ' + width);
      await fs.writeFile(path.join(output, `inspector-5000-character-name-${width}.png`), (await win.webContents.capturePage()).toPNG());
    }
    assert.equal(inspectorBodyScrolled, true, 'The inspector body overflowed and wheel-scrolled at a supported size');
    await win.loadFile(rendererHtml);
    await wait(() => evaluate((name) => document.querySelector('.library-pick[aria-current="true"] .library-name')?.textContent === name, hugeName), 'reopened 5000-character name');
    assert.equal(await evaluate((name) => document.querySelector('.library-pick[data-library-item="library-path-0"] .library-name').textContent === name, hugeName), true, 'Reload shows the complete name');
    // After reload, open the full inspector and wait for current planning and an enabled Swap action.
    await openInspector();
    await wait(() => evaluate((name) => {
      const title = document.querySelector('.ctxinsp .ctxinsp-t'), body = document.querySelector('.ctxinsp-body');
      const swap = document.querySelector('.ctxinsp-hd [aria-label="Swap start/end"]');
      return title?.textContent === name && !document.querySelector('.fieldcol[data-planning-ready="false"]')
        && body && !body.closest('[inert]') && swap && !swap.disabled;
    }, hugeName), 'reloaded inspector shows the complete name with planning settled');
    assertInspectorUsable(await inspectorLayout(), 'reload');
    await pointerClick(moreButton); await click('.library-menu button', 'Rename');
    await input('.library-rename input', 'Opening move'); await click('[aria-label="Save name"]');
    await click('[aria-label="Save project"]');
    assert.equal(openingName(), 'Opening move');
    win.setContentSize(1100, 720); await delay(150);
    check('a valid 5000-character name keeps Push, timeline waypoints, menus, and a bounded inspector title with reachable close, Swap start/end, Place waypoint, and scrolling body usable at both supported sizes and survives save/reload');
    await click('.place', 'Routines'); await click('[data-library-item="routine-a"]');
    await click('.rt-branch .rt-add');
    const branchBefore = saved.routines.find((routine) => routine.id === 'routine-a').nodes.find((node) => node.id === 'decision-a').then.length;
    // Add lists project paths first; Enter adds the first one to the route.
    await key('Enter');
    await delay(80); await click('[aria-label="Save project"]');
    assert.equal(saved.routines.find((routine) => routine.id === 'routine-a').nodes.find((node) => node.id === 'decision-a').then.length, branchBefore + 1);
    assert.ok(await evaluate(() => Boolean(document.querySelector('.rt-branch .rt-step.sel'))));
    check('adding a path in a populated decision branch selects the new step in the main flow');
    await click('.place', 'Paths');
    deferInspection = true;
    await click('.library-connection');
    await wait(() => Boolean(finishInspection), 'pending robot inspection');
    await click('.robot-push-dialog button', 'Pair another robot');
    await click('.robot-push-dialog button', 'Connect');
    await click('.robot-push-dialog button', 'Trust and pair');
    assert.equal(await evaluate(() => [...document.querySelectorAll('.robot-push-dialog button')].some((button) => button.textContent === 'Refresh robot' && !button.disabled)), true, 'A superseded inspection must not leave the replacement pairing stuck refreshing');
    deferInspection = false;
    finishInspection(inspection());
    await click('.robot-push-dialog button', 'Refresh robot');
    await wait(() => evaluate(() => [...document.querySelectorAll('.robot-push-dialog button')].some((button) => button.textContent === 'Refresh robot' && !button.disabled)), 'replacement robot inspection');
    await click('[aria-label="Close robot connection"]');
    check('pairing another robot during inspection leaves its refresh control usable');
    await click('.library-connection');
    await click('.robot-push-dialog button', 'Pair another robot');
    await wait(() => evaluate(() => document.querySelector('.robot-push-endpoint')), 'unpaired connection surface');
    assert.equal(await evaluate(() => document.querySelector('.library-connection').textContent.trim()), 'Set up');
    assert.equal(await evaluate(() => { const button = document.querySelector('.library-connection'); return button.scrollWidth <= button.clientWidth; }), true);
    assert.equal(await evaluate(() => document.querySelectorAll('.robot-connection-diagnostics').length), 1);
    await wait(() => evaluate(() => document.querySelector('[aria-label="Diagnostics"]')?.checkVisibility()), 'unpaired diagnostics control');
    await click('[aria-label="Diagnostics"]');
    assert.equal(await evaluate(() => document.querySelector('dialog.robot-manager').open), false);
    assert.equal(await evaluate(() => document.activeElement.getAttribute('aria-label')), 'Close diagnostic bundle');
    await click('[aria-labelledby="beta-diagnostic-title"] button', 'Generate preview');
    await wait(() => diagnosticPreviews.length === 2, 'unpaired diagnostic preview');
    await click('[aria-labelledby="beta-diagnostic-title"] button', 'Save bundle');
    await wait(() => diagnosticSaves.length === 2, 'unpaired local diagnostic save');
    await click('[aria-label="Close diagnostic bundle"]');
    assert.equal(prepared.length, 1, 'Diagnostics must not initiate another robot push');
    check('unpaired connection keeps diagnostics reachable, focused, and locally saveable');

    saved = { ...saved, name: 'Simple library', paths: saved.paths.slice(0, 2).map((item) => ({ ...item, folderId: undefined })), pathFolders: [], pathLinks: [], editor: { ...saved.editor, activePathId: 'library-path-0' }, activeRoutineId: 'routine-a' };
    await win.loadFile(rendererHtml);
    await wait(() => evaluate(() => document.querySelector('.library-pick[aria-current="true"] .library-name')?.textContent === 'Opening move'), 'simple restored library');
    assert.equal(await evaluate(() => document.querySelectorAll('.library-pick').length), 2);
    await click('.place', 'Settings');
    await click('[aria-label="Display units"] button', 'Imperial');
    await click('.place', editorPlace);
    await wait(() => evaluate(() => document.querySelectorAll('.pt-wp').length > 0), 'Imperial waypoint coordinates');
    await click('.pt-wp');
    const coordinate = (label) => evaluate((label) => { const row = [...document.querySelectorAll('.pp .numrow')].find((r) => r.querySelector('.numlbl')?.textContent === label); return row && row.querySelector('input').value + ' ' + row.querySelector('.numunit').textContent; }, label);
    assert.equal(await coordinate('X'), `${(saved.paths[0].waypoints[0].x / .3048).toFixed(2)} ft`);
    assert.equal(await coordinate('Y'), `${(saved.paths[0].waypoints[0].y / .3048).toFixed(2)} ft`);
    await click('.place', 'Settings');
    await click('[aria-label="Display units"] button', 'Metric');
    await click('.place', editorPlace);
    assert.equal(await coordinate('X'), `${saved.paths[0].waypoints[0].x.toFixed(2)} m`);
    check('docked waypoint coordinates use the selected unit system');

    assert.equal(await evaluate(() => document.querySelectorAll('.library-folder').length), 0, 'Root paths must not be wrapped in a synthetic Unfiled folder');
    assert.equal(await evaluate(() => document.querySelectorAll('.library-row input[type="checkbox"]').length), 0);
    assert.equal(await evaluate(() => document.querySelector('.editor-library').textContent.includes('Unfiled')), false);
    await click('[aria-label="Actions for Opening move"]');
    assert.equal(await evaluate(() => document.querySelector('.library-menu').matches(':popover-open')), true, 'Actions use a native popover above the list');
    assert.equal(await evaluate(() => document.querySelector('.library-menu [role="menuitem"]').textContent), 'Push path…');
    await key('End');
    assert.equal(await evaluate(() => document.activeElement.textContent), 'Delete');
    await key('Escape');
    assert.equal(await evaluate(() => document.querySelector('.library-menu')), null);
    assert.equal(await evaluate(() => document.activeElement.getAttribute('aria-label')), 'Actions for Opening move');
    await click('[aria-label="Actions for Opening move"]');
    await pointerClick('.fieldcol');
    await wait(() => evaluate(() => !document.querySelector('.library-menu')), 'native popover toggle retires the dismissed menu');
    assert.equal(await evaluate(() => document.querySelector('.library-menu')), null, 'Click outside in the field dismisses the menu');
    await click('[aria-label="Actions for Opening move"]');
    await click('.library-menu button', 'Move or link…');
    assert.equal(await evaluate(() => document.querySelector('.library-properties').open), true);
    assert.equal(await evaluate(() => document.querySelector('.library-properties select option[value=""]').textContent), 'No folder');
    await wait(() => evaluate(() => document.querySelector('.library-properties')?.contains(document.activeElement)), 'path properties focus');
    await key('Escape');
    await wait(() => evaluate(() => !document.querySelector('.library-properties')), 'native path properties Escape close');
    assert.equal(await evaluate(() => document.activeElement.dataset.libraryItem), 'library-path-0');
    check('item popover supports keyboard, Escape focus restoration, outside dismissal, and separate native properties');
    const flatRowState = () => evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d');
      return [...document.querySelectorAll('.library-row')].map((row) => {
        const style = getComputedStyle(row), pick = row.querySelector('.library-pick');
        context.clearRect(0, 0, 1, 1); context.fillStyle = style.backgroundColor; context.fillRect(0, 0, 1, 1);
        return { id: pick.dataset.libraryItem, current: pick.getAttribute('aria-current') === 'true', selected: pick.getAttribute('aria-pressed') === 'true',
          marked: Boolean(row.querySelector('.library-mark svg')), height: row.getBoundingClientRect().height,
          borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth], shadow: style.boxShadow,
          pseudo: ['::before', '::after'].map((pseudo) => getComputedStyle(row, pseudo).content),
          rgba: [...context.getImageData(0, 0, 1, 1).data], weight: getComputedStyle(row.querySelector('.library-name')).fontWeight };
      });
    });
    const assertFlatRows = (rows) => {
      assert.ok(rows.length > 1 && rows.filter((row) => row.current).length === 1, 'Exactly one open row has the selection surface');
      assert.ok(rows.every((row) => row.height <= 36 && row.borders.every((width) => width === '0px') && row.shadow === 'none'
        && row.pseudo.every((content) => content === 'none')), 'Paths remain compact rows without borders, shadows or selection stripes: ' + JSON.stringify(rows));
      assert.ok(rows.every((row) => row.current ? row.rgba[3] > 0 && Math.max(...row.rgba.slice(0, 3)) - Math.min(...row.rgba.slice(0, 3)) <= 6
        : row.rgba[3] === 0), 'Only the open row has a neutral surface, including when other paths are selected for Push: ' + JSON.stringify(rows));
      assert.equal(new Set(rows.map((row) => row.weight)).size, 1, 'Selection does not change name weight');
    };
    const movePointerOffLibrary = async () => {
      const point = await evaluate(() => { const r = document.querySelector('.fieldcol').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; });
      win.webContents.sendInputEvent({ type: 'mouseMove', ...point }); await delay(100);
      await wait(() => evaluate(() => !document.querySelector('.library-row:hover')), 'pointer leaves library before resting-row checks');
    };
    // Chromium retains synthetic :hover on hidden windows; verify these resting surfaces in the visible app.
    win.show(); win.focus(); win.webContents.focus();
    for (const [width, height] of [[1440, 900], [1280, 800], [1100, 720]]) {
      win.setContentSize(width, height); await delay(150);
      await pointerClick('[data-library-item="library-path-0"]');
      await movePointerOffLibrary(); assertFlatRows(await flatRowState());
      await fs.writeFile(path.join(output, `simple-paths-${width}.png`), (await win.webContents.capturePage()).toPNG());
      await pointerClick('[data-library-item="library-path-1"]', [process.platform === 'darwin' ? 'meta' : 'control']);
      await movePointerOffLibrary();
      const selectedRows = await flatRowState(); assertFlatRows(selectedRows);
      const selectedNeighbor = selectedRows.find((row) => row.id === 'library-path-1');
      assert.deepEqual([selectedNeighbor.current, selectedNeighbor.selected, selectedNeighbor.marked, selectedNeighbor.rgba[3]], [false, true, true, 0], 'Push selection uses a check mark without a second selection surface');
      await fs.writeFile(path.join(output, `simple-multiselect-${width}.png`), (await win.webContents.capturePage()).toPNG());
      await pointerClick('[data-library-item="library-path-0"]', [process.platform === 'darwin' ? 'meta' : 'control']);
      assert.equal(await evaluate(() => document.querySelector('.push-button').title), 'Collect second · Ctrl+Shift+P', 'Single-item push label follows selected ID even when editor stays on another path');
      await click('[aria-label="Actions for Opening move"]');
      await fs.writeFile(path.join(output, `simple-menu-${width}.png`), (await win.webContents.capturePage()).toPNG());
      await key('Escape');
      await click('.place', 'Routines'); await click('[data-library-item="routine-a"]');
      if (await evaluate(() => Boolean(document.querySelector('[aria-label="Close step inspector"]')))) await click('[aria-label="Close step inspector"]');
      await delay(500);
      await fs.writeFile(path.join(output, `simple-routines-${width}.png`), (await win.webContents.capturePage()).toPNG());
      await click('.place', 'Paths');
    }
    check('two root paths use flat rows, direct modifier selection, accurate scoped push names, and uncluttered item popovers');
    // Exercise simultaneous notices with the application's real CSS at narrow field widths.
    for (const width of [320, 600]) {
      const layout = await evaluate((width) => {
        const field = document.querySelector('.stage-plan .fieldcol');
        const original = field.querySelector('.field-notices');
        const fixture = original.cloneNode(false);
        fixture.innerHTML = '<div class="field-status"><details><summary><span class="field-status-label">Preparing trajectory…</span><span class="field-status-disclosure">Details (3)</span></summary><div class="field-status-details"><div class="field-status-item"><strong>Optimization out of date</strong><p>' + 'Long diagnostic text '.repeat(100) + '</p><button>Optimize</button></div></div></details><button class="field-status-action">Optimize</button></div>'
          + '<div class="insert-preview"><div class="insert-preview-copy"><b>Preview waypoint</b><span>Insert the waypoint at the previewed location.</span></div><div class="insert-preview-actions"><button>Cancel</button><button>Insert waypoint</button></div></div>';
        const previous = field.style.flex;
        field.style.flex = '0 0 ' + width + 'px';
        original.style.visibility = 'hidden';
        field.append(fixture);
        const rects = [...fixture.children].map((el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; });
        const button = fixture.querySelector('.field-status-action'), r = button.getBoundingClientRect();
        const statusHeight = fixture.firstElementChild.getBoundingClientRect().height;
        const fonts = [fixture.querySelector('summary'), button].map((el) => getComputedStyle(el).fontSize);
        fixture.querySelector('details').open = true;
        const detail = fixture.querySelector('.field-status-details');
        const detailHeight = detail.getBoundingClientRect().height;
        const bounded = detail.scrollHeight > detail.clientHeight;
        fixture.querySelector('details').open = false;
        const result = { statusHeight, fonts, detailHeight, bounded, rects, bounds: field.getBoundingClientRect().toJSON(), clickable: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === button };
        fixture.remove(); original.style.visibility = ''; field.style.flex = previous;
        return result;
      }, width);
      assert.ok(layout.statusHeight <= 40, 'Status remains one compact row');
      assert.equal(layout.fonts[0], layout.fonts[1], 'Status and action use consistent font sizes');
      assert.ok(layout.detailHeight <= 240 && layout.bounded, 'Long diagnostics scroll in a bounded disclosure');
      layout.rects.forEach((rect, index) => {
        if (index) assert.ok(rect.top >= layout.rects[index - 1].bottom + 5, 'Simultaneous field notices must have separate rows');
        assert.ok(rect.left >= layout.bounds.left && rect.right <= layout.bounds.right, 'Field notices must wrap within the field');
      });
      assert.equal(layout.clickable, true, 'Review trajectory must remain clickable');
    }
    check('simultaneous passive statuses occupy one consistent-size row with bounded diagnostic details');
    saved = { ...saved, name: 'Shared waypoint verification', paths: [...saved.paths, { ...structuredClone(saved.paths[0]), id: 'unlinked-path', name: 'Independent path' }].map((path, index) => ({ ...path, headingMode: 'tangent', startVel: .4, goalVel: .6, waypoints: path.waypoints.map((waypoint, at) => ({ ...waypoint, theta: index === 0 ? 15 : 130, thetaOn: true, stop: false })) })) };
    await win.loadFile(rendererHtml);
    await wait(() => evaluate(() => document.querySelector('.library-pick[aria-current="true"] .library-name')?.textContent === 'Opening move' && !document.querySelector('.fieldcol[data-planning-ready="false"]')), 'shared waypoint fixture ready');
    const saveCurrent = async () => { await click('[aria-label="Save project"]'); };
    const editNumber = async (label, value) => {
      await wait(() => evaluate((label) => { const field = [...document.querySelectorAll('.numrow')].find((row) => row.querySelector('label')?.textContent === label)?.querySelector('input'); return field && !field.matches(':disabled') && !field.closest('[inert]'); }, label), 'editable ' + label);
      await evaluate((label) => {
        const field = [...document.querySelectorAll('.numrow')].find((row) => row.querySelector('label')?.textContent === label)?.querySelector('input');
        if (!field || field.matches(':disabled')) throw new Error('Numeric field unavailable: ' + label);
        field.focus();
      }, label);
      // Num first replaces its formatted value with an editing draft, then selects it on the next frame.
      await wait(() => evaluate((label) => {
        const field = [...document.querySelectorAll('.numrow')].find((row) => row.querySelector('label')?.textContent === label)?.querySelector('input');
        return document.hasFocus() && document.activeElement === field && field.selectionStart === 0 && field.selectionEnd === field.value.length;
      }, label), 'focused and selected ' + label);
      await win.webContents.insertText(String(value));
      // insertText delivers input asynchronously; blurring before it lands would leave an uncommitted draft.
      await wait(() => evaluate((text) => document.activeElement?.value === text, String(value)), 'typed ' + label + ' value');
      await key('Tab'); // One real blur commits the draft once; dispatching focusout and then blurring creates two edits.
      await delay(80); await saveCurrent();
    };
    const numericState = (label) => evaluate((label) => { const field = [...document.querySelectorAll('.numrow')].find((row) => row.querySelector('label')?.textContent === label)?.querySelector('input'); return field ? { value: Number(field.value), disabled: field.matches(':disabled') } : null; }, label);
    // The path's full inspector: clear the selection, then open More.
    const pathInspector = async () => { await evaluate(() => document.activeElement?.blur()); await key('Escape'); await openInspector(); };
    await pathInspector();
    assert.deepEqual(await numericState('Entry speed'), { value: .4, disabled: false });
    assert.deepEqual(await numericState('Exit speed'), { value: .6, disabled: false });
    const facingBaseline = structuredClone(saved.paths[0].waypoints[0]);
    const headPoint = await evaluate(() => {
      const handle = document.querySelector('circle[data-role="head"][data-idx="0"]');
      if (!handle) throw new Error('Start facing handle missing in tangent mode');
      const rect = handle.getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    });
    win.webContents.sendInputEvent({ type: 'mouseMove', ...headPoint });
    win.webContents.sendInputEvent({ type: 'mouseDown', ...headPoint, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseMove', x: headPoint.x + 20, y: headPoint.y + 25 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: headPoint.x + 20, y: headPoint.y + 25, button: 'left', clickCount: 1 });
    await delay(100); await saveCurrent();
    assert.equal(saved.paths[0].waypoints[0].segmentHeadingMode, 'manual', 'Dragging start facing overrides tangent heading');
    assert.deepEqual(saved.paths[0].waypoints[0].prevC, facingBaseline.prevC);
    assert.deepEqual(saved.paths[0].waypoints[0].nextC, facingBaseline.nextC);
    assert.equal(saved.paths[0].waypoints[0].x, facingBaseline.x);
    assert.equal(saved.paths[0].waypoints[0].y, facingBaseline.y);
    await pathInspector();

    await editNumber('Initial robot facing', 42);
    assert.equal(saved.paths[0].waypoints[0].theta, 42);
    assert.deepEqual(saved.paths[0].waypoints[0].prevC, facingBaseline.prevC);
    assert.deepEqual(saved.paths[0].waypoints[0].nextC, facingBaseline.nextC);
    await editNumber('Entry speed', .5); await editNumber('Exit speed', .7);
    assert.equal(saved.paths[0].startVel, .5); assert.equal(saved.paths[0].goalVel, .7);
    for (const [index, toggle, label, speed] of [[0, 'Stop at entry', 'Entry speed', .5], [saved.paths[0].waypoints.length - 1, 'Stop at exit', 'Exit speed', .7]]) {
      await wait(() => evaluate(() => !document.querySelector('.fieldcol[data-planning-ready="false"]')), 'endpoint ready');
      await evaluate((index) => document.querySelectorAll('.pt-wp')[index].click(), index);
      await click('[aria-label="' + toggle + '"]'); await saveCurrent();
      assert.equal(saved.paths[0].waypoints[index].stop, true);
      await pathInspector();
      assert.deepEqual(await numericState(label), { value: 0, disabled: true }, 'Stopped endpoints display effective zero speed');
      await evaluate((index) => document.querySelectorAll('.pt-wp')[index].click(), index);
      await click('[aria-label="' + toggle + '"]'); await saveCurrent();
      await pathInspector();
      assert.deepEqual(await numericState(label), { value: speed, disabled: false }, 'Removing the stop restores the stored endpoint speed');
    }
    check('summary facing changes preserve tangents; vi/vf edit independently and endpoint stops show effective zero');
    await wait(() => evaluate(() => !document.querySelector('.fieldcol[data-planning-ready="false"]')), 'waypoint link inspector ready');
    await evaluate(() => document.querySelector('.pt-wp').click());
    const independentBefore = structuredClone(saved.paths[2]);
    const linkBaseline = saved.paths.slice(0, 2).map((path) => structuredClone(path.waypoints[0]));
    assert.equal(await evaluate(() => document.querySelectorAll('#waypoint-position-link-results [role="option"]').length), 0, 'Ordinary waypoints are absent from the inline chooser');
    assert.equal(await evaluate(() => document.querySelector('#waypoint-position-link-results .choice-empty')?.textContent), 'Name a shared point in another path to link it here.');
    await evaluate((id) => document.querySelector('[data-library-item="' + id + '"]').click(), saved.paths[1].id);
    await wait(() => evaluate(() => !document.querySelector('.fieldcol[data-planning-ready="false"]')), 'target point ready');
    await evaluate(() => document.querySelector('.pt-wp').click());
    await click('[aria-label="Linkable waypoint"]');
    await wait(() => evaluate(() => { const input = document.querySelector('[aria-label="Linkable point name"]'); return input && !input.disabled && !input.closest('[inert]'); }), 'named point editable');
    await pointerClick('[aria-label="Linkable point name"]');
    await evaluate(() => document.querySelector('[aria-label="Linkable point name"]').select());
    assert.equal(await evaluate(() => document.activeElement.getAttribute('aria-label')), 'Linkable point name');
    await win.webContents.insertText('Scoring position');
    await wait(() => evaluate(() => document.querySelector('[aria-label="Linkable point name"]').value === 'Scoring position'), 'typed point name');
    await key('Tab');
    await delay(80);
    await saveCurrent();
    assert.equal(saved.paths[1].waypoints[0].positionName, 'Scoring position', 'Named point saved from actual typing');
    linkBaseline[1] = structuredClone(saved.paths[1].waypoints[0]);
    await evaluate((id) => document.querySelector('[data-library-item="' + id + '"]').click(), saved.paths[0].id);
    await wait(() => evaluate(() => !document.querySelector('.fieldcol[data-planning-ready="false"]')), 'source point ready');
    await evaluate(() => document.querySelector('.pt-wp').click());
    await pointerClick('#waypoint-position-link');
    assert.equal(await evaluate(() => document.querySelectorAll('#waypoint-position-link-results [role="option"]').length), 1, 'Only the opted-in named point is offered');
    await win.webContents.insertText('Scoring');
    await wait(() => evaluate(() => document.querySelector('#waypoint-position-link-results [role="option"] strong')?.textContent === 'Scoring position'), 'filtered named point');
    await key('Down');
    assert.equal(await evaluate(() => document.querySelector('#waypoint-position-link').getAttribute('aria-activedescendant')), 'waypoint-position-link-result-0', 'Keyboard selects the exact named-point result');
    await key('Enter');
    await saveCurrent();
    const linkId = saved.paths[0].waypoints[0].positionLink;
    assert.ok(linkId); assert.equal(saved.paths[1].waypoints[0].positionLink, linkId);
    assert.equal(saved.paths[0].waypoints[0].x, saved.paths[1].waypoints[0].x);
    assert.equal(saved.paths[0].waypoints[0].y, saved.paths[1].waypoints[0].y);
    assert.equal(saved.paths[0].waypoints[0].theta, 42); assert.equal(saved.paths[1].waypoints[0].theta, 130);
    const linkedBeforeEdit = saved.paths.slice(0, 2).map((path) => structuredClone(path.waypoints[0]));
    const newX = Math.round((saved.paths[0].waypoints[0].x + .25) * 100) / 100;
    await editNumber('X', newX);
    for (const [index, path] of saved.paths.slice(0, 2).entries()) {
      const point = path.waypoints[0], before = linkedBeforeEdit[index];
      assert.equal(point.x, newX); assert.equal(point.theta, before.theta);
      for (const handle of ['prevC', 'nextC']) {
        assert.ok(Math.abs((point[handle].x - point.x) - (before[handle].x - before.x)) < 1e-8, 'Shared movement preserves each local tangent vector');
        assert.ok(Math.abs((point[handle].y - point.y) - (before[handle].y - before.y)) < 1e-8);
      }
    }
    await click('[title^="Undo"]'); await saveCurrent();
    assert.deepEqual(saved.paths.slice(0, 2).map((path) => path.waypoints[0]), linkedBeforeEdit, 'Undo coordinates restores both linked members');
    await click('[title^="Undo"]'); await saveCurrent();
    assert.deepEqual(saved.paths.slice(0, 2).map((path) => path.waypoints[0]), linkBaseline, 'Undo link restores the full project before joining');
    await click('[title^="Redo"]'); await saveCurrent();
    assert.deepEqual(saved.paths.slice(0, 2).map((path) => path.waypoints[0]), linkedBeforeEdit, 'Redo link restores both members');
    await click('[title^="Redo"]'); await saveCurrent();
    assert.ok(saved.paths.slice(0, 2).every((path) => path.waypoints[0].x === newX && path.waypoints[0].positionLink === linkId));
    await wait(() => evaluate(() => !document.querySelector('.fieldcol[data-planning-ready="false"]')), 'unlink ready');
    await fs.writeFile(path.join(output, 'linked-position-inspector.png'), (await win.webContents.capturePage()).toPNG());
    await click('.shared-waypoint-position button', 'Unlink'); await saveCurrent();
    assert.equal(saved.paths[0].waypoints[0].positionLink, undefined);
    const independentX = Math.round((newX + .2) * 100) / 100;
    await editNumber('X', independentX);
    assert.equal(saved.paths[0].waypoints[0].x, independentX); assert.equal(saved.paths[1].waypoints[0].x, newX);
    assert.equal(saved.paths[1].waypoints[0].theta, 130);
    assert.deepEqual(saved.paths[2], independentBefore, 'Unrelated path remains unchanged');
    await fs.writeFile(path.join(output, 'shared-position-inspector.png'), (await win.webContents.capturePage()).toPNG());
    check('searchable shared position links propagate coordinates only, support project undo/redo, and unlink cleanly');
    // Restoring a linked relationship never jumps over a newer edit to the former neighbor.
    const sharedVerification = structuredClone(saved);
    const linkedFixture = (kind) => {
      const make = (id, name) => { const item = { ...structuredClone(source), id, name }; delete item.folderId; return item; };
      const paths = [make('linked-a', 'Linked A'), make('linked-b', 'Linked B'), make('unrelated-c', 'Unrelated C')];
      if (kind === 'shared') paths[0].waypoints[0].positionLink = paths[1].waypoints[0].positionLink = 'fixture-shared';
      return { ...saved, name: 'Linked undo verification', paths, pathFolders: [], routines: [], activeRoutineId: '', editor: { activePathId: 'linked-a' },
        pathLinks: kind === 'endpoint' ? [{ id: 'fixture-endpoint', fromPathId: 'linked-a', toPathId: 'linked-b' }] : [] };
    };
    const planningReady = (label) => wait(() => evaluate(() => !document.querySelector('.fieldcol[data-planning-ready="false"]')), label);
    const openLinkedFixture = async (kind) => {
      saved = linkedFixture(kind);
      await win.loadFile(rendererHtml);
      await wait(() => evaluate(() => document.querySelector('.library-pick[aria-current="true"] .library-name')?.textContent === 'Linked A' && !document.querySelector('.fieldcol[data-planning-ready="false"]')), kind + ' link fixture');
      await evaluate(() => { window.confirm = () => true; });
      await saveCurrent();
    };
    const showPath = async (id) => { await evaluate((id) => document.querySelector('[data-library-item="' + id + '"]').click(), id); await planningReady('path ' + id); };
    const inspectWaypoint = async (index) => {
      await evaluate((index) => document.querySelectorAll('.pt-wp')[index].click(), index);
      await openInspector();
      await delay(100);
    };
    const savedPath = (id) => saved.paths.find((item) => item.id === id);
    const undoAvailable = () => evaluate(() => !document.querySelector('[title^="Undo"]').disabled);
    const linkedGeometry = () => ({ links: saved.pathLinks.map((link) => [link.fromPathId, link.toPathId]), paths: saved.paths.map((item) => [item.id, item.waypoints.map((point) => [point.x, point.y, point.positionLink])]) });
    const reopenLinked = async () => {
      const before = linkedGeometry();
      await win.loadFile(rendererHtml);
      await wait(() => evaluate(() => document.querySelectorAll('.library-pick').length > 0 && !document.querySelector('.fieldcol[data-planning-ready="false"]')), 'linked fixture reopened');
      await saveCurrent();
      assert.deepEqual(linkedGeometry(), before, 'Reopening keeps linked geometry unchanged');
    };

    await openLinkedFixture('shared');
    const sharedB = structuredClone(savedPath('linked-b'));
    const sharedStart = structuredClone(savedPath('linked-a').waypoints[0]);
    await click('[aria-label="Actions for Linked B"]'); await click('.library-menu button', 'Delete'); await saveCurrent();
    assert.ok(!savedPath('linked-b'));
    await showPath('linked-a'); await inspectWaypoint(0);
    const neighborX = Math.round((sharedStart.x + .3) * 100) / 100;
    await editNumber('X', neighborX);
    assert.equal(savedPath('linked-a').waypoints[0].x, neighborX);
    await showPath('unrelated-c');
    assert.equal(await undoAvailable(), false, 'Undo on an unrelated path cannot restore the deleted neighbor past its newer edit');
    await keyboardUndo(); await saveCurrent();
    assert.ok(!savedPath('linked-b'), 'Blocked Undo leaves the deletion');
    assert.equal(savedPath('linked-a').waypoints[0].x, neighborX, 'Blocked Undo leaves the newer edit');
    await showPath('linked-a');
    await click('[title^="Undo"]'); await saveCurrent();
    assert.deepEqual(savedPath('linked-a').waypoints[0], sharedStart, 'The neighbor edit is undone on its own path first');
    await showPath('unrelated-c');
    await click('[title^="Undo"]'); await saveCurrent();
    assert.deepEqual(savedPath('linked-b'), sharedB, 'Then the deletion restores the path with matching shared geometry');
    assert.equal(savedPath('linked-b').waypoints[0].x, savedPath('linked-a').waypoints[0].x);
    await reopenLinked();
    check('a shared-position deletion cannot be undone past a newer neighbor edit; undoing the edit first restores consistent geometry after reload');

    await openLinkedFixture('endpoint');
    const endpointLast = savedPath('linked-a').waypoints.length - 1;
    const endpointStart = structuredClone(savedPath('linked-b').waypoints[0]);
    assert.deepEqual([endpointStart.x, endpointStart.y], [savedPath('linked-a').waypoints[endpointLast].x, savedPath('linked-a').waypoints[endpointLast].y]);
    await inspectWaypoint(endpointLast);
    await click('.shared-waypoint-position button', 'Unlink'); await saveCurrent();
    assert.deepEqual(saved.pathLinks, [], 'Unlink removes only the endpoint link');
    await showPath('linked-b'); await inspectWaypoint(0);
    const unlinkedX = Math.round((endpointStart.x + .3) * 100) / 100;
    await editNumber('X', unlinkedX);
    await showPath('linked-a');
    assert.equal(await undoAvailable(), false, 'Undo on A cannot relink B past its newer edit');
    await keyboardUndo(); await saveCurrent();
    assert.deepEqual(saved.pathLinks, []);
    assert.equal(savedPath('linked-b').waypoints[0].x, unlinkedX);
    await showPath('linked-b');
    await click('[title^="Undo"]'); await saveCurrent();
    assert.deepEqual(savedPath('linked-b').waypoints[0], endpointStart);
    await showPath('linked-a');
    await click('[title^="Undo"]'); await saveCurrent();
    assert.deepEqual(saved.pathLinks.map((link) => [link.fromPathId, link.toPathId]), [['linked-a', 'linked-b']], 'Undo on A restores the endpoint link');
    assert.deepEqual(savedPath('linked-b').waypoints[0], endpointStart);
    await click('[title^="Redo"]'); await saveCurrent();
    assert.deepEqual(saved.pathLinks, [], 'Redo unlinks again');
    await showPath('linked-b');
    await click('[title^="Redo"]'); await saveCurrent();
    assert.equal(savedPath('linked-b').waypoints[0].x, unlinkedX, 'Redo replays the newer edit');
    await reopenLinked();
    check('an endpoint unlink cannot be undone past a newer edit to the unlinked path; undo order, redo, and reload stay consistent');
    saved = sharedVerification;
    await win.loadFile(rendererHtml);
    await wait(() => evaluate(() => document.querySelector('.library-pick[aria-current="true"] .library-name')?.textContent === 'Opening move' && !document.querySelector('.fieldcol[data-planning-ready="false"]')), 'shared waypoint fixture reopened');
    await evaluate(() => {
      window.__routinePendingCheck = { samples: 0, violations: [] };
      window.__routinePendingObserver = new MutationObserver(() => {
        if (!document.querySelector('.routine-status.planning')) return;
        window.__routinePendingCheck.samples++;
        const skipped = [...document.querySelectorAll('.rt-step-meta')].filter((element) => element.textContent.includes('Skipped in this preview') && !element.closest('.rt-branch:not(.live)'));
        if (skipped.length) window.__routinePendingCheck.violations.push(skipped.map((element) => element.textContent));
      });
      window.__routinePendingObserver.observe(document.querySelector('#root'), { subtree: true, childList: true, characterData: true });
    });
    await click('.place', 'Routines'); await click('[data-library-item="routine-a"]');
    await wait(() => evaluate(() => !document.querySelector('.routine-status.planning')), 'routine planning settles');
    const pending = await evaluate(() => { window.__routinePendingObserver.disconnect(); return window.__routinePendingCheck; });
    assert.ok(pending.samples > 0, 'Regression must observe an actual pending routine render');
    assert.deepEqual(pending.violations, [], 'Pending preview-included routine nodes must not flash skipped status');
    check('actual pending routine renders never label included paths as skipped before planning settles');
    // Restoring a project calculates the unopened path, without selecting it.
    saved = { ...saved, pathLinks: [], routines: [], activeRoutineId: '', paths: saved.paths.slice(0, 2).map((path, index) => ({
      ...path, optimization: undefined, headingMode: 'manual', driveBackward: false, startVel: 0, goalVel: 0,
      markers: [], targets: [], ranges: [], waypoints: [2, 4 + index * 2].map((x) => ({
        x, y: 3, theta: 0, thetaOn: true, linked: true, stop: false, segType: 'line',
        prevC: { x: x - .5, y: 3 }, nextC: { x: x + .5, y: 3 },
      })),
    })) };
    saved.editor = { activePathId: saved.paths[0].id };
    await win.loadFile(rendererHtml);
    await wait(() => evaluate(() => {
      const labels = [...document.querySelectorAll('.library-meta')];
      return labels.length === 2 && labels.every((label) => /^\d+\.\d{2} s$/.test(label.textContent));
    }), 'restored unopened path durations');
    const durationLayout = await evaluate(() => [...document.querySelectorAll('.library-row')].map((row) => {
      const name = row.querySelector('.library-name'), time = row.querySelector('.library-meta');
      const center = (element) => { const rect = element.getBoundingClientRect(); return rect.y + rect.height / 2; };
      return { row: center(row), name: center(name), time: center(time), seconds: parseFloat(time.textContent) };
    }));
    for (const layout of durationLayout) {
      assert.ok(Math.abs(layout.time - layout.row - 1) < .1, 'Duration uses the optical centering offset within its row');
      assert.ok(Math.abs(layout.name - layout.time) < .1, 'Name and duration share the same vertical center');
    }
    assert.ok(durationLayout[1].seconds > durationLayout[0].seconds, 'Unopened longer path has its own calculated time');
    assert.equal(await evaluate(() => document.querySelector('.library-pick[aria-current="true"]').dataset.libraryItem), saved.paths[0].id);
    await fs.writeFile(path.join(output, 'restored-path-durations.png'), (await win.webContents.capturePage()).toPNG());
    check('unopened paths receive current trajectory times after restore, with vertically centered names and durations');
    await wait(() => evaluate(() => !document.querySelector('.fieldcol[data-planning-ready="false"]')), 'fault injection baseline ready');
    const beforeFailure = structuredClone(saved.paths[0]);
    await evaluate((pathId) => {
      const post = Worker.prototype.postMessage;
      window.__injectedPlanningFailures = 0;
      window.__restoreWorkerPost = () => { Worker.prototype.postMessage = post; delete window.__restoreWorkerPost; };
      Worker.prototype.postMessage = function (message, ...args) {
        if (message.mode === 'editing' && message.quality === 'final' && message.path.id === pathId && message.path.waypoints[0].x === 2.25) {
          window.__injectedPlanningFailures++;
          setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data: { id: message.id, error: { message: 'Injected final planning failure' } } })), 0);
          return;
        }
        return post.call(this, message, ...args);
      };
    }, saved.paths[0].id);
    await click('.pt-wp');
    await editNumber('X', 2.25);
    await click('.optimizer-toggle');
    await wait(() => evaluate(() => document.querySelector('.optimizer-failure')?.textContent.includes('Injected final planning failure')), 'current error shown over retained preview');
    assert.ok(await evaluate(() => window.__injectedPlanningFailures > 0), 'The current final-planning request receives the injected failure');
    // The optimizer's own baseline failed; the editor keeps the current geometry editable.
    assert.equal(await evaluate(() => Boolean(document.querySelector('.fieldsvg').closest('[inert]'))), false, 'The field stays editable while the optimizer baseline fails');
    assert.equal(await evaluate(() => Boolean(document.querySelector('.optimizer-panel').closest('[inert]'))), false, 'Error recovery must remain usable');
    assert.equal(await evaluate(() => document.querySelector('.optimizer-main').textContent), 'Optimize');
    assert.equal(await evaluate(() => document.querySelector('.optimizer-recovery').textContent), 'Edit path');
    await fs.writeFile(path.join(output, 'optimizer-interactive-failure.png'), (await win.webContents.capturePage()).toPNG());
    await keyboardUndo();
    await wait(() => evaluate(() => !document.querySelector('.optimizer-failure') && !document.querySelector('.fieldcol[data-planning-ready="false"]')), 'Undo recovers planning');
    await evaluate(() => window.__restoreWorkerPost());
    await click('[aria-label="Save project"]');
    assert.deepEqual(saved.paths[0].waypoints, beforeFailure.waypoints);
    await click('.optimizer-toggle');
    check('an optimizer baseline failure exposes the current error, leaves editing available, and recovers through Undo');

    const beforeRepair = structuredClone(saved);
    // Explicit angular limits make heading tracking fail authoritative validation.
    // Omitted angular limits inherit the path defaults and no longer make this fixture invalid.
    const repairPath = { ...structuredClone(corpus.paths.find((item) => item.id === 'corpus-neutral-slalom')),
      id: 'repair-path', name: 'Restored path', targets: [{ f: .5, deg: 135 }],
      ranges: [{ f0: .3, f1: .65, anchor: 'param', maxAngVel: .01, maxAngAccel: .01 }] };
    saved = { ...corpus, paths: [repairPath], routines: [], pathLinks: [], editor: { activePathId: repairPath.id } };
    await win.loadFile(rendererHtml);
    await wait(() => evaluate(() => document.querySelector('.library-pick[aria-current="true"] .library-name')?.textContent.includes('Restored path')), 'restored repair fixture');
    await pointerClick('.optimizer-toggle');
    await wait(() => evaluate(() => {
      const failure = document.querySelector('.optimizer-failure')?.textContent || '';
      return failure.includes('Turn rate') && failure.includes('0.01 °/s');
    }), 'real final-planning angular-limit failure');
    assert.equal(await evaluate(() => document.querySelector('.optimizer-main').textContent), 'Optimize');
    assert.equal(await evaluate(() => document.querySelector('.optimizer-recovery').textContent), 'Edit path');
    await pointerClick('.optimizer-recovery');
    await wait(() => evaluate(() => !!document.querySelector('.ctxinsp')), 'Edit path opens the full inspector');
    // No repair mode: the problem is shown on the timeline and the zone edits normally.
    await click('.pt-zone-tag');
    await wait(() => evaluate(() => !!document.querySelector('.ctxinsp .range-limits')), 'zone limits in the inspector');
    await waitProblemsDisclosure(true, 'full Problems count matches current timeline issue underlays');
    assert.equal(await evaluate(() => Boolean(document.querySelector('.fieldsvg').closest('[inert]'))), false, 'A planning problem never freezes the field');
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(100);
      await fs.writeFile(path.join(output, `planning-problem-${width}.png`), (await win.webContents.capturePage()).toPNG());
    }
    // Native text preflight requires real focus: hidden Electron windows can change activeElement
    // without dispatching focusout/blur, so they cannot certify invalid-draft ownership.
    win.show(); win.focus(); win.webContents.focus();
    await wait(() => evaluate(() => document.hasFocus()), 'native focus for field problem input checks');
    // A problem is a semantic control in every tool; hit its real painted descendants.
    await click('[aria-label="Save project"]');
    const problemSource = structuredClone(saved.paths[0]);
    const hitProblemPart = async (part, modifiers = [], diagnostic = false) => {
      const point = await evaluate((part, diagnostic) => {
        const el = document.querySelector('.field-issue-badge[role="button"] ' + part);
        if (!el) throw new Error('Missing badge part ' + part);
        const box = el.getBoundingClientRect();
        for (let y = 1; y < 8; y++) for (let x = 1; x < 8; x++) {
          const p = { x: Math.round(box.x + box.width*x/8), y: Math.round(box.y + box.height*y/8) };
          if (document.elementFromPoint(p.x,p.y) === el) { if (diagnostic) { window.__problemActivationDiagnostic.point = p; window.__problemActivationDiagnostic.capture('coordinate'); } return p; }
        }
        throw new Error('No actual pointer hit on badge ' + part);
      }, part, diagnostic);
      const sent = label => { if (diagnostic) problemActivationNative.push({ label, at: Date.now(), point, visible: win.isVisible(), focused: win.isFocused() }); };
      sent('send-move'); win.webContents.sendInputEvent({ type:'mouseMove', ...point });
      sent('send-down'); win.webContents.sendInputEvent({ type:'mouseDown', ...point, button:'left', clickCount:1, modifiers });
      sent('send-up'); win.webContents.sendInputEvent({ type:'mouseUp', ...point, button:'left', clickCount:1, modifiers });
      await delay(50);
      const selected = await evaluate(diagnostic => {
        if (diagnostic) window.__problemActivationDiagnostic.capture('50ms-assert');
        return Boolean(document.querySelector('.field-issue-badge[aria-pressed="true"]') && document.querySelector('.pp-problem'));
      }, diagnostic);
      if (diagnostic) await retainProblemActivationDiagnostic();
      assert.equal(selected, true);
    };
    await wait(() => evaluate(() => document.querySelector('.field-issue-badge[role="button"]')), 'interactive located problem');
    for (const toolName of ['Select / move','Place waypoint','Rotation target','Place command','Zone']) {
      await pointerClick('.toolrail [aria-label="' + toolName + '"]');
      for (const modifiers of [[], ['shift']]) {
        await hitProblemPart('path', modifiers);
        await hitProblemPart('.field-issue-hit', modifiers);
        await hitProblemPart('.field-problem-caption text', modifiers);
      }
    }
    await click('[aria-label="Save project"]');
    assert.deepEqual(saved.paths[0], problemSource, 'Triangle, caption and hit area never edit under any tool or Shift');
    // Native Tab with an authored waypoint selected: deletion keys belong to the badge before activation.
    await pointerClick('.pt-wp');
    await evaluate(() => document.querySelector('.fieldsvg').focus());
    for (let count=0; count<160 && !await evaluate(() => document.activeElement?.matches('.field-issue-badge[role="button"]')); count++) await key('Tab');
    assert.equal(await evaluate(() => document.activeElement?.matches('.field-issue-badge[role="button"]')), true, 'Tab reaches a real badge');
    await key('Delete'); await key('Backspace');
    assert.equal(await evaluate(() => Boolean(document.querySelector('.pp-problem'))), false, 'Delete before activation leaves waypoint selection alone');
    await key('Enter');
    assert.equal(await evaluate(() => Boolean(document.querySelector('.pp-problem'))), true, 'Enter selects the problem');
    await key('Space');
    assert.equal(await evaluate(() => document.querySelector('.pt-play')?.getAttribute('aria-label')), 'Play trajectory', 'Space does not start playback');
    await key('Escape');
    assert.equal(await evaluate(() => Boolean(document.querySelector('.pp-problem'))), false);
    assert.equal(await evaluate(() => document.querySelector('.toolrail-b[aria-pressed="true"]')?.getAttribute('aria-label')), 'Zone', 'Owned Escape does not change the tool');
    await key('Enter');
    for (const [width,height] of [[1440,900],[1100,720]]) {
      win.setContentSize(width,height); await delay(150);
      await fs.writeFile(path.join(output, `field-problem-selected-${width}.png`), (await win.webContents.capturePage()).toPNG());
    }
    await click('[aria-label="Save project"]');
    assert.deepEqual(saved.paths[0], problemSource, 'Problem keyboard interaction never edits the source');
    check('field problem triangle, caption and hit area own all tools and Shift; Tab/Enter/Space/Delete/Backspace/Escape keep source and playback safe');
    // Invalid drafts keep focus; warning inspection cannot silently blur away an unfinished value.
    await evaluate(() => document.activeElement?.blur()); await key('Escape');
    await pointerClick('.pt-limits input'); await key('Home'); await key('End', ['shift']);
    await evaluate(() => document.activeElement.select());
    assert.equal(await evaluate(() => document.hasFocus() && document.activeElement?.matches('.pt-limits input')), true, 'Native speed input has focus before typing');
    await win.webContents.insertText('not-a-number');
    await wait(() => evaluate(() => document.activeElement?.value === 'not-a-number'), 'invalid speed draft entered');
    const blockedPoint = await evaluate(() => { const r=document.querySelector('.field-issue-badge path').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; });
    win.webContents.sendInputEvent({type:'mouseDown',...blockedPoint,button:'left',clickCount:1});
    win.webContents.sendInputEvent({type:'mouseUp',...blockedPoint,button:'left',clickCount:1});await delay(80);
    assert.equal(await evaluate(() => document.activeElement?.matches('.pt-limits input[aria-invalid="true"]')), true, 'Invalid draft retains focus');
    assert.equal(await evaluate(() => Boolean(document.querySelector('.pp-problem'))), false, 'Blocked selection leaves problems unselected');
    const pointCount = await evaluate(() => document.querySelectorAll('.pt-wp').length);
    await pointerClick('[data-selection="wp:0"]', ['shift']);
    assert.equal(await evaluate(() => document.querySelectorAll('.pt-wp').length), pointCount, 'Timeline Shift deletion refuses an invalid speed draft');
    assert.equal(await evaluate(() => document.activeElement?.matches('.pt-limits input[aria-invalid="true"]')), true, 'Refused timeline deletion retains draft focus');
    await key('Escape'); await key('Tab');
    // Hold only the real editing-worker request; current geometry stays editable with the exact held problem list.
    await evaluate(() => {
      const post = Worker.prototype.postMessage, queued = [], listeners = new Map(); let holding = true, nextWorker = 0;
      const trace = window.__problemActivationDiagnostic = { active: false, point: null, workers: [], dom: [], events: [] };
      const describe = element => element && ({ tag: element.tagName, id: element.id, role: element.getAttribute('role'), dataRole: element.getAttribute('data-role'), dataIndex: element.getAttribute('data-idx'), index: element.closest?.('.field-issue-badge')?.getAttribute('data-idx'), opacity: element.getAttribute('opacity'), label: element.getAttribute('aria-label'), class: element.getAttribute('class'), value: element.value, invalid: element.getAttribute('aria-invalid') });
      trace.capture = label => {
        const first = document.querySelector('.field-issue-badge[role="button"]'), hit = trace.point && document.elementFromPoint(trace.point.x, trace.point.y);
        trace.dom.push({ label, at: performance.now(), focus: document.hasFocus(), active: describe(document.activeElement), invalid: [...document.querySelectorAll('[data-project-draft][aria-invalid="true"]')].map(describe),
          ready: document.querySelector('.fieldcol')?.getAttribute('data-planning-ready'), inert: Boolean(document.querySelector('.fieldsvg')?.closest('[inert]')), modal: Boolean(document.querySelector('dialog[open],[role="dialog"][aria-modal="true"]')), popovers: document.querySelectorAll('[popover]:popover-open').length,
          point: trace.point, hit: describe(hit), first: describe(first), firstBox: first?.getBoundingClientRect().toJSON(), stale: document.querySelectorAll('.pt-issue.stale').length,
          selectedBadges: [...document.querySelectorAll('.field-issue-badge[aria-pressed="true"]')].map(element => element.getAttribute('data-idx')), selectedUnderlays: [...document.querySelectorAll('.pt svg g.pt-issue')].flatMap((element, index) => element.classList.contains('selected') ? [index] : []),
          issueCount: document.querySelectorAll('.pt svg g.pt-issue').length, panel: Boolean(document.querySelector('.pp-problem')), panelTitle: document.querySelector('.pp-title')?.textContent });
      };
      const pointer = event => {
        if (!trace.active) return;
        trace.events.push({ type: event.type, at: performance.now(), trusted: event.isTrusted, buttons: event.buttons, pointerId: event.pointerId, x: event.clientX, y: event.clientY, target: describe(event.target) });
        trace.capture(event.type + '-capture'); queueMicrotask(() => trace.capture(event.type + '-after-dispatch'));
      };
      for (const type of ['pointermove', 'pointerdown', 'pointerup']) window.addEventListener(type, pointer, true);
      const wrapped = function(message, ...args) {
        if (message?.mode === 'editing') {
          if (!listeners.has(this)) {
            const worker = ++nextWorker, ids = new Set();
            const listener = event => { if (ids.has(event.data?.id)) trace.workers.push({ phase: 'response', worker, id: event.data.id, type: event.data.type || (event.data.error ? 'error' : 'result'), at: performance.now() }); };
            this.addEventListener('message', listener); listeners.set(this, { worker, ids, listener });
          }
          const item = listeners.get(this); item.ids.add(message.id); trace.workers.push({ phase: 'request', worker: item.worker, id: message.id, type: message.mode, held: holding, at: performance.now() });
          if (holding) { queued.push([this, message, args]); return; }
        }
        return post.call(this, message, ...args);
      };
      Worker.prototype.postMessage = wrapped;
      window.__releaseProblemTiming = () => {
        holding = false;
        for (const [worker, message, args] of queued.splice(0)) { trace.workers.push({ phase: 'release', worker: listeners.get(worker).worker, id: message.id, type: message.mode, at: performance.now() }); post.call(worker, message, ...args); }
        delete window.__releaseProblemTiming;
      };
      window.__restoreProblemActivationDiagnostic = () => {
        window.__releaseProblemTiming?.(); if (Worker.prototype.postMessage === wrapped) Worker.prototype.postMessage = post;
        for (const [worker, item] of listeners) worker.removeEventListener('message', item.listener);
        for (const type of ['pointermove', 'pointerdown', 'pointerup']) window.removeEventListener(type, pointer, true);
        delete window.__problemActivationDiagnostic; delete window.__restoreProblemActivationDiagnostic;
        return { workerListeners: 0, pointerListeners: 0, wrapperRestored: Worker.prototype.postMessage === post, queued: queued.length };
      };
    });
    await pointerClick('.pt-limits input');await key('Home');await key('End',['shift']);await evaluate(() => document.activeElement.select());await win.webContents.insertText('3');await key('Enter');
    await wait(() => evaluate(() => document.querySelector('.field-issue-badge[opacity="0.5"]')), 'held field problems while timing request is pending');
    await hitProblemPart('path');
    assert.equal(await evaluate(() => document.querySelector('.pp-problem')?.textContent.includes('Updating…')), true);
    assert.equal(await evaluate(() => document.querySelector('.fieldsvg').closest('[inert]')!=null), false, 'Held warnings do not freeze geometry');
    for(const [width,height] of [[1440,900],[1100,720]]){win.setContentSize(width,height);await delay(150);await fs.writeFile(path.join(output,`field-problem-pending-${width}.png`),(await win.webContents.capturePage()).toPNG());}
    await evaluate(() => window.__releaseProblemTiming());
    await wait(() => evaluate(() => !document.querySelector('.field-issue-badge[opacity="0.5"]') && !document.querySelector('.pp-problem')), 'fresh result retires held selection');
    await stampProblemActivation('before-undo');
    await pointerClick('[title^="Undo"]'); await Promise.all([stampProblemActivation('after-undo'), delay(150)]); await click('[aria-label="Save project"]'); await stampProblemActivation('after-save');
    assert.deepEqual(saved.paths[0],problemSource,'One Undo restores the one speed edit; warning inspection added no history');
    await stampProblemActivation('before-hit');
    try { await hitProblemPart('path', [], true); } finally { await restoreProblemActivationDiagnostic(); }
    await pointerClick('.pp-problem .pp-action'); await click('[aria-label="Save project"]');
    assert.equal(saved.paths[0].ranges.length,problemSource.ranges.length+1,'Explicit Slow here adds one zone');
    await pointerClick('[title^="Undo"]');await click('[aria-label="Save project"]');
    assert.deepEqual(saved.paths[0],problemSource,'One Undo restores explicit Slow here');
    check('invalid drafts retain focus, pending geometry stays inspectable, fresh timing clears selection, and explicit Slow here is exactly one undoable edit');
    // Undo starts asynchronous planning; opening against its held list may correctly be
    // refused when preflight renders the replacement. This proof owns the current list.
    await waitProblemsDisclosure(true, 'Undo restores current Problems before zone-tag dismissal proof');
    // Dismissing the real popover leaves the actual timeline zone tag unobscured.
    await problemsPointerClick('aside.pp[aria-label="Properties"] button[aria-haspopup="menu"]');
    await wait(async () => (await evaluate(inspectProblemsDisclosure)).open, 'Problems popover opens before zone-tag dismissal proof');
    await assertProblemsForeground(); await key('Escape');
    await wait(() => evaluate(() => {
      const panel = document.querySelector('aside.pp[aria-label="Properties"]'), trigger = panel.querySelector('button[aria-haspopup="menu"]');
      return trigger.getAttribute('aria-expanded') === 'false' && !panel.querySelector('[role="menu"]') && document.activeElement === trigger;
    }), 'native Escape closes Problems and restores trigger focus before zone-tag activation');
    await problemsPointerClick('.pt-zone-tag');
    await wait(() => evaluate(() => document.querySelector('.ctxinsp .range-limits')), 'unobscured timeline tag restores the zone inspector');
    await pointerClick('.ctxinsp .delbtn');
    await waitProblemsDisclosure(false, 'deleting the invalid range clears the disclosure, underlays and selected problem');
    await click('[aria-label="Save project"]');
    assert.equal(saved.paths[0].ranges.length, 0);
    assert.deepEqual(saved.paths[0].waypoints, repairPath.waypoints);
    check('a restored path with a planning problem stays editable: the problem shows on the timeline and removing the zone clears it');
    await pointerClick('[title^="Undo"]');
    await waitProblemsDisclosure(true, 'Undo restores the invalid range and its full current Problems count/underlays');
    await selectFirstDisclosedProblem();
    await pointerClick('[title^="Redo"]');
    await waitProblemsDisclosure(false, 'fresh repaired result retires the disclosure, menu, underlays and selected problem');
    await pointerClick('[title^="Undo"]');
    await waitProblemsDisclosure(true, 'Undo restores another full current Problems count/underlays');
    assert.equal(await evaluate(() => Boolean(document.querySelector('.pp-problem'))), false, 'The old selected problem never returns automatically with another result');
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(100);
      await fs.writeFile(path.join(output, `problem-selection-cleared-${width}.png`), (await win.webContents.capturePage()).toPNG());
    }
    await pointerClick('[title^="Redo"]');
    await waitProblemsDisclosure(false, 'leave the repaired path without disclosure, menu, underlays or selected problem');
    check('timeline problem selection clears on replacement and never resurrects through actual Undo and Redo');
    saved = beforeRepair;
    win.setContentSize(1440, 900);
    await win.loadFile(rendererHtml);
    await wait(() => evaluate(() => document.querySelector('.fieldcol') && !document.querySelector('.fieldcol[data-planning-ready="false"]')), 'normal fixture after repair');


    saved.paths[0] = { ...structuredClone(source), id: saved.paths[0].id, name: 'Collect the second game piece from the far loading station' };
    saved.paths[0].waypoints[1] = { ...saved.paths[0].waypoints[1], thetaOn: true, theta: -178, stop: true, wait: 12.5 };
    saved.routines = [{ id: 'long-flow', name: 'Long content check', nodes: [{ id: 'long-step', type: 'path', ref: saved.paths[0].id }] }];
    saved.activeRoutineId = 'long-flow';
    await win.loadFile(rendererHtml);
    await wait(() => evaluate(() => !document.querySelector('.fieldcol[data-planning-ready="false"]') && document.querySelectorAll('.pt-wp').length === 3), 'badge-rich waypoint fixture');
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(100);
      await click('.pt-wp', '1'); await openInspector();
      // The docked panel shows the stopped, pinned waypoint's values without clipping.
      const waypointLayout = await evaluate(() => { const panel = document.querySelector('.pp'), title = panel.querySelector('.pp-title'), rows = [...panel.querySelectorAll('.numrow')];
        return { name: title.textContent, fits: title.scrollWidth <= title.clientWidth, separated: !panel.querySelector('.pp-body').scrollWidth || panel.querySelector('.pp-body').scrollWidth <= panel.querySelector('.pp-body').clientWidth, detailsFit: rows.every((row) => row.scrollWidth <= row.clientWidth + 1) }; });
      assert.deepEqual(waypointLayout, { name: 'Waypoint 1', fits: true, separated: true, detailsFit: true });
      assert.equal(await evaluate(() => ['.library-name', '.ctxinsp-t'].every((selector) => { const el = document.querySelector(selector); return el.scrollWidth <= el.clientWidth && getComputedStyle(el).whiteSpace === 'normal'; })), true, 'Primary path names wrap instead of clipping across library and inspector');
      // Library rows clamp long names to two lines and Push keeps its one-line scope label with the whole name as its title; the inspector title shows the whole name.
      assert.deepEqual(await evaluate(() => { const row = document.querySelector('.library-pick[aria-current="true"] .library-name'), footer = document.querySelector('.push-button'), title = document.querySelector('.ctxinsp-t'), line = (el) => parseFloat(getComputedStyle(el).lineHeight);
        const range = document.createRange(); range.selectNodeContents(footer);
        const textBox = range.getBoundingClientRect(), buttonBox = footer.getBoundingClientRect();
        return { row: row.clientHeight <= line(row) * 2 + 1,
          footer: getComputedStyle(footer).whiteSpace === 'nowrap' && textBox.height <= footer.clientHeight
            && textBox.top >= buttonBox.top && textBox.bottom <= buttonBox.bottom && footer.textContent.trim() === 'Push path' && footer.title === row.textContent + ' · Ctrl+Shift+P',
          title: title.textContent === title.title && title.scrollHeight <= title.clientHeight + 1 }; }), { row: true, footer: true, title: true }, 'Clamped library names keep the complete name in the inspector title');
      await fs.writeFile(path.join(output, `waypoint-badges-${width}.png`), (await win.webContents.capturePage()).toPNG());
      await click('.place', 'Routines');
      await click('.rt-step-body');
      const beforeHover = await evaluate(() => { const el = document.querySelector('.rt-step-body'); return el.getBoundingClientRect().width; });
      const point = await evaluate(() => { const r = document.querySelector('.rt-step-body').getBoundingClientRect(); return { x: Math.round(r.x+20), y: Math.round(r.y+20) }; });
      win.webContents.sendInputEvent({ type: 'mouseMove', ...point }); await delay(100);
      const routineLayout = await evaluate(() => { const el = document.querySelector('.rt-step-body'), name = el.querySelector('.rt-step-title'); return { width: el.getBoundingClientRect().width, fits: name.scrollWidth <= name.clientWidth, wraps: getComputedStyle(name).whiteSpace === 'normal' }; });
      assert.equal(routineLayout.width, beforeHover, 'Hover must reserve action space');
      assert.equal(routineLayout.fits, true); assert.equal(routineLayout.wraps, true);
      await fs.writeFile(path.join(output, `routine-long-name-${width}.png`), (await win.webContents.capturePage()).toPNG());
      await click('[aria-label="Close step inspector"]'); await click('.place', 'Paths');
    }
    check('waypoint badges and long routine names remain readable without hover layout shifts at both supported sizes');

    // Undoing an applied robot profile proposal reverts its own change and keeps later Settings notes.
    const facing = { directionDeg: 0, requiresTargetFacing: true };
    saved = { ...corpus, paths: [{ ...structuredClone(source), id: 'profile-path', name: 'Profile path' }], routines: [], pathLinks: [], editor: { activePathId: 'profile-path' },
      robot: { ...corpus.robot, planning: { notes: 'existing notes', shooter: facing } } };
    await win.loadFile(rendererHtml);
    await editorReady('robot profile fixture');
    await evaluate(() => window.bordeauxAPI.__libraryAgent.setAccess(true, 1));
    // Propose against the settled published context, as the MCP bridge does.
    let session = null;
    await wait(async () => { await delay(250); const latest = await evaluate(() => window.bordeauxAPI.__libraryAgent.latestSession()); const settled = latest && session && latest.revision === session.revision; session = latest; return settled; }, 'published agent session');
    const proposedPlanning = { ...session.project.robot.planning, shooter: { directionDeg: 90, requiresTargetFacing: true } };
    await evaluate((proposal) => window.bordeauxAPI.__libraryAgent.propose(proposal), {
      id: 'profile-proposal', operation: 'configureRobot', status: 'ready', createdAt: new Date().toISOString(),
      baseSessionId: session.sessionId, baseRevision: session.revision, baseActivePathId: session.activePathId,
      intent: 'Shooter fires to the robot left', summary: ['Shooter direction: 90°'], planning: proposedPlanning,
    });
    await wait(() => evaluate(() => !!document.querySelector('.rp-proposal-actions .primary')), 'robot profile proposal in Settings');
    await pointerClick('.rp-proposal-actions .primary');
    await wait(() => evaluate(() => document.querySelector('.rp-proposal')?.textContent.includes('Applied as one undoable project change.')), 'applied robot profile');
    assert.deepEqual(await evaluate(() => window.bordeauxAPI.__libraryAgent.statuses()), [{ id: 'profile-proposal', status: 'applied' }], 'The proposal applies without becoming stale');
    win.webContents.focus();
    await pointerClick('.rp-notes');
    const notesSelection = () => evaluate(() => { const el = document.querySelector('.rp-notes'); return { focused: document.activeElement === el, start: el.selectionStart, end: el.selectionEnd, length: el.value.length }; });
    assert.equal((await notesSelection()).focused, true, 'The pointer click focuses the Settings notes');
    // If the select-all shortcut leaves the caret collapsed, use real Backspace presses to clear the
    // checked fixture notes.
    await key('a', [process.platform === 'darwin' ? 'meta' : 'control']);
    let selection = await notesSelection();
    let notesClearedBy = 'select-all shortcut';
    if (!(selection.start === 0 && selection.end === selection.length)) {
      assert.deepEqual(selection, { focused: true, start: selection.length, end: selection.length, length: 'existing notes'.length }, 'The caret is collapsed at the end of the existing notes before deleting');
      for (let i = 0; i < selection.length; i++) await key('Backspace');
      selection = await notesSelection();
      assert.deepEqual(selection, { focused: true, start: 0, end: 0, length: 0 }, 'Backspace clears the existing notes');
      notesClearedBy = 'Backspace';
    }
    await win.webContents.insertText('new operator notes');
    await wait(() => evaluate(() => document.querySelector('.rp-notes').value === 'new operator notes'), 'typed operator notes');
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(100);
      await evaluate(() => document.querySelector('.rp-notes').scrollIntoView({ block: 'center' }));
      await fs.writeFile(path.join(output, `settings-notes-edited-${width}.png`), (await win.webContents.capturePage()).toPNG());
    }
    assert.equal((await notesSelection()).focused, true, 'Settings notes keep focus through the screenshots');
    await click('.place', editorPlace); await editorReady('editor after Settings');
    await keyboardUndo(); await click('[aria-label="Save project"]');
    assert.deepEqual(saved.robot.planning, { notes: 'new operator notes', shooter: facing }, 'Undo reverts the proposal and keeps the newer Settings notes');
    await click('[title^="Redo"]'); await click('[aria-label="Save project"]');
    assert.deepEqual(saved.robot.planning, { notes: 'new operator notes', shooter: { directionDeg: 90, requiresTargetFacing: true } }, 'Redo reapplies only the proposal');
    await click('[title^="Undo"]'); await click('[aria-label="Save project"]');
    assert.deepEqual(saved.robot.planning, { notes: 'new operator notes', shooter: facing });
    await win.loadFile(rendererHtml);
    await editorReady('reopened robot profile');
    await click('.place', 'Settings');
    await evaluate(() => window.bordeauxAPI.__libraryAgent.setAccess(true, 1));
    await wait(() => evaluate(() => document.querySelector('.rp-notes')?.value === 'new operator notes'), 'reopened Settings notes');
    assert.equal(await evaluate(() => document.querySelector('input[aria-label="Shooter direction"]').value), '0', 'The reopened shooter direction is the pre-proposal value');
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(100);
      await evaluate(() => document.querySelector('.rp-notes').scrollIntoView({ block: 'center' }));
      await fs.writeFile(path.join(output, `settings-notes-reopened-${width}.png`), (await win.webContents.capturePage()).toPNG());
    }
    await click('.place', editorPlace);
    console.log('Settings notes cleared by ' + notesClearedBy);
    check('Undo of an applied robot profile proposal keeps newer Settings notes through Redo, save, and reload');
    if (process.env.BORDEAUX_DURATION_PROJECT) {
      saved = JSON.parse(await fs.readFile(process.env.BORDEAUX_DURATION_PROJECT, 'utf8'));
      saved.editor = { activePathId: saved.paths[0].id };
      saved.routines = [{ id: 'duration-regression', name: 'Duration regression', nodes: saved.paths.map((path, index) => ({ id: 'duration-step-' + index, type: 'path', ref: path.id })) }];
      saved.activeRoutineId = 'duration-regression';
      await win.loadFile(rendererHtml);
      await wait(() => evaluate(() => document.querySelectorAll('.library-meta').length > 1 && [...document.querySelectorAll('.library-meta')].every((label) => /^\d+\.\d{2} s$/.test(label.textContent))), 'actual project durations with stale optimization');
      assert.equal(await evaluate(() => document.querySelector('.field-status')?.textContent.includes('Using normal trajectory') || false), false, 'Normal fallback does not show a passive banner');
      const labelTransforms = await evaluate(() => [...document.querySelectorAll('.pp .numlbl,.pp-row-label,.pt-gutter')].map((label) => getComputedStyle(label).textTransform));
      assert.ok(labelTransforms.length > 0 && labelTransforms.every((value) => value === 'none'), 'Band labels preserve sentence case');
      check('band labels preserve sentence case with actual project durations');
      await fs.writeFile(path.join(output, 'actual-project-durations.png'), (await win.webContents.capturePage()).toPNG());
      await click('.place', 'Routines');
      await wait(() => evaluate(() => !document.querySelector('.routine-status') && document.querySelectorAll('.rt-step.path').length > 1), 'actual routine uses current normal trajectories');
      assert.equal(await evaluate(() => [...document.querySelectorAll('.rt-step-meta')].some((label) => /unavailable|Preparing/.test(label.textContent))), false);
      await fs.writeFile(path.join(output, 'actual-project-routine.png'), (await win.webContents.capturePage()).toPNG());
      check('actual saved project shows both durations and routine preview despite an outdated optimization');
    }
    // The project retains one editable empty object when its last library item is removed.
    const sole = { ...structuredClone(source), id: 'sole-path', name: 'Last authored path' };
    saved = { ...corpus, paths: [sole], pathFolders: [], pathLinks: [], routines: [{ id: 'sole-routine', name: 'Last routine', nodes: [{ id: 'sole-step', type: 'path', ref: sole.id }] }], activeRoutineId: 'sole-routine', editor: { activePathId: sole.id } };
    await win.loadFile(rendererHtml);
    await wait(() => evaluate(() => !!document.querySelector('[data-library-item="sole-path"]')), 'last-item fixture');
    await click('.place', 'Routines');
    await pointerClick('[data-library-item="sole-routine"]', ['shift']);
    await click('[aria-label="Save project"]');
    assert.equal(saved.routines.length, 1); assert.notEqual(saved.routines[0].id, 'sole-routine'); assert.deepEqual(saved.routines[0].nodes, []);
    await pointerClick('.deletion-notice button'); await click('[aria-label="Save project"]');
    assert.equal(saved.routines[0].id, 'sole-routine'); assert.equal(saved.routines[0].nodes.length, 1);
    await pointerClick('[data-id="sole-step"] .rt-step-body', ['shift']); await click('[aria-label="Save project"]');
    assert.deepEqual(saved.routines[0].nodes, []);
    await click('.place', 'Paths');
    await pointerClick('[data-library-item="sole-path"]', ['shift']); await click('[aria-label="Save project"]');
    assert.equal(saved.paths.length, 1); assert.notEqual(saved.paths[0].id, 'sole-path'); assert.deepEqual(saved.paths[0].waypoints, []);
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(100);
      await fs.writeFile(path.join(output, 'last-path-deleted-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
    }
    await pointerClick('.deletion-notice button'); await click('[aria-label="Save project"]');
    assert.equal(saved.paths[0].id, 'sole-path'); assert.deepEqual(saved.paths[0].waypoints, sole.waypoints);
    await win.loadFile(rendererHtml);
    await wait(() => evaluate(() => !!document.querySelector('[data-library-item="sole-path"]')), 'last-path Undo survives reopen');
    check('Deleting the final path or routine creates an empty replacement and native Undo restores the authored item through save/reopen');
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ checks, errors }, null, 2));
    app.exit(0);
  } catch (error) { try { if (win && !win.isDestroyed()) await restoreProblemActivationDiagnostic(); } catch (diagnosticError) { console.error('Problem diagnostic cleanup:', diagnosticError); } console.error(error); console.error(errors); if (win) { console.error('Field status:', await evaluate(() => document.querySelector('.field-status')?.textContent)); await fs.writeFile(path.join(output, 'failure-project.json'), JSON.stringify(saved, null, 2)); } await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ checks, errors, failure: error.message }, null, 2)); if (win) await fs.writeFile(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG()); app.exit(1); }
});
