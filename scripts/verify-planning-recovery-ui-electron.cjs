const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = process.env.BORDEAUX_PLANNING_RECOVERY_UI_OUTPUT;
app.setPath('userData', path.join(output, 'user-data'));
let win, saved, saves = 0, exportSucceeds = false;
const autosaves = [];
const location = { folderPath: '/fixtures/Recovery project', projectPath: '/fixtures/Recovery project/.bordeaux-workspace.json' };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true);
async function wait(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(75); } throw Error('Timed out: ' + label); }
async function focusWindow() {
  app.focus({ steal: true }); win.focus(); win.webContents.focus();
  await wait(() => evaluate(() => document.hasFocus()), 'renderer keyboard focus');
}
async function click(selector, text, clickCount = 1) {
  await focusWindow();
  await wait(() => evaluate((selector, text) => {
    const item = [...document.querySelectorAll(selector)].find((el) => !text || el.textContent.trim() === text || (el.getAttribute('role') === 'menuitem' && el.querySelector('span')?.textContent.trim() === text));
    return !!item && !item.disabled && !item.closest('[inert]');
  }, selector, text), 'enabled control: ' + selector + (text ? ' ' + text : ''));
  const point = await evaluate((selector, text) => {
    const item = [...document.querySelectorAll(selector)].find((el) => !text || el.textContent.trim() === text || (el.getAttribute('role') === 'menuitem' && el.querySelector('span')?.textContent.trim() === text));
    if (!item || item.disabled) throw Error('Missing control: ' + selector + ' ' + text);
    item.scrollIntoView({ block: 'nearest' });
    const r = item.getBoundingClientRect(), x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    if (!item.contains(document.elementFromPoint(x, y))) throw Error('Obscured control: ' + selector);
    return { x, y };
  }, selector, text);
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount, modifiers: [], ...point });
  await delay(350);
}
async function key(keyCode) { await focusWindow(); win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: [] }); if (keyCode === 'Space') win.webContents.sendInputEvent({ type: 'char', keyCode: ' ', modifiers: [] }); if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers: [] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: [] }); await delay(70); }
async function snapshot(name) { await fs.writeFile(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
ipcMain.handle('branches:restore', () => ({ project: saved, location }));
ipcMain.handle('branches:catalog', () => ({ catalog: { projectName: 'Fixture', commands: [], warnings: [] }, bookmarkId: 'fixture' }));
ipcMain.handle('branches:save', (_event, project) => { saved = project; saves++; return { saved: true, location }; });
ipcMain.handle('branches:autosave', (_event, project) => { autosaves.push(project); return { saved: true, location }; });
ipcMain.handle('branches:export', () => {
  if (exportSucceeds) return { exported: true, relativePath: 'paths/Path 1.bdx', sampleCount: 125, eventCount: 1 };
  throw new Error('Event event1: command labview.legacy.9550c83fef51616cba926b82 is missing in the linked LabVIEW project. Inspect commands before exporting BDX.');
});
async function save() { const before = saves; await click('.project-chip'); await click('[role="menuitem"][data-action="save"]'); await wait(() => saves > before, 'save');
}
app.whenReady().then(async () => {
  try {
    const corpus = JSON.parse(await fs.readFile('benchmarks/planner-corpus/v1/corpus.bordeaux.json', 'utf8'));
    const first = structuredClone(corpus.paths.find((p) => p.id === 'corpus-neutral-stop'));
    first.name = 'Path 1'; first.ranges = [];
    saved = { ...corpus, paths: [first], pathLinks: [], routines: [], editor: { activePathId: first.id, unitSystem: 'metric' } };
    win = new BrowserWindow({ show: true, width: 1440, height: 900, useContentSize: true, webPreferences: { preload: path.join(__dirname, 'verify-planning-recovery-ui-preload.cjs'), sandbox: false, contextIsolation: true, backgroundThrottling: false } });
    await win.loadFile(path.resolve('dist-renderer/index.html'));
    await wait(() => evaluate(() => document.querySelectorAll('.pt-wp').length > 0 && !document.querySelector('.fieldcol[data-planning-ready="false"]')), 'current trajectory');
    assert.ok(await evaluate(() => document.querySelector('.project-chip-name')?.textContent.includes('Recovery project') || document.querySelector('.toolbar').textContent.includes('Recovery project')));
    // Editing planning jobs carry mode "editing"; this failure is injected only for the 0.5 m/s limit.
    await evaluate(() => {
      const post = Worker.prototype.postMessage;
      window.restorePlanner = () => { Worker.prototype.postMessage = post; delete window.restorePlanner; };
      Worker.prototype.postMessage = function(message, ...args) {
        if (message.mode === 'editing' && message.path.constraints.maxVel === 0.5) {
          setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data: { id: message.id, error: { message: 'Controlled planning failure' } } })), 0);
          return;
        }
        return post.call(this, message, ...args);
      };
    });
    // Path limits are edited in place: Speed and Acceleration in the timeline header.
    async function number(label, value, pauseForAutosave = false) {
      const selector = await evaluate(label => {
        const el = [...document.querySelectorAll('.path-band label.numlbl')].find(el => el.textContent === label);
        if (!el) throw Error('Missing number ' + label);
        return '#' + CSS.escape(el.htmlFor);
      }, label);
      await click(selector);
      await evaluate(selector => { const input = document.querySelector(selector); input.focus(); input.select(); }, selector);
      await win.webContents.insertText(String(value));
      if (pauseForAutosave) {
        await delay(1150);
        assert.equal(await evaluate(selector => document.activeElement === document.querySelector(selector), selector), true, 'Background save must not blur the numeric draft');
        assert.equal(await evaluate(selector => document.querySelector(selector).value, selector), String(value));
        assert.ok(autosaves.length > 0);
        assert.equal(autosaves.at(-1).paths[0].constraints.maxVel, first.constraints.maxVel, 'Background save includes committed values without stealing the live draft');
      }
      await evaluate(selector => document.querySelector(selector).focus(), selector);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: [] });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: [] });
      await delay(100);
    }
    const speedLimitShown = () => evaluate(() => { const row = [...document.querySelectorAll('.pt-limits .numrow')].find((r) => r.querySelector('.numlbl')?.textContent === 'Speed'); return row?.querySelector('input').value; });
    await number('Speed', 0.5, true);
    await wait(() => evaluate(() => document.querySelector('.field-status-label')?.textContent === 'Couldn’t time this path'), 'failure banner');
    await snapshot('failure-before-recovery');
    assert.equal(await speedLimitShown(), '0.50', 'The authored limit shows the failed value');
    const blocked = await evaluate(() => ({
      status: !!document.querySelector('.field-status').closest('[inert]'),
      band: !!document.querySelector('.path-band').closest('[inert]'),
      field: !!document.querySelector('.fieldsvg').closest('[inert]'),
      ready: document.querySelector('.fieldcol').dataset.planningReady,
      points: document.querySelectorAll('.pt-wp').length,
    }));
    assert.equal(blocked.status, false, 'Planning failure details and recovery accept native input');
    assert.equal(blocked.band, false, 'Properties and timeline stay usable');
    assert.equal(blocked.field, false, 'A failed timing job never freezes the field');
    assert.equal(blocked.ready, 'true', 'Current geometry stays editable');
    assert.ok(blocked.points > 0, 'Current geometry stays drawn');
    await click('.field-status summary');
    assert.equal(await evaluate(() => document.querySelector('.field-status details').open), true);
    assert.ok(await evaluate(() => document.querySelector('.field-status-details').textContent.includes('Controlled planning failure')));
    assert.equal(await evaluate(() => document.querySelector('.field-status-action')?.textContent), 'Try again');
    for (const [width, height] of [[1440,900],[1100,720]]) {
      win.setContentSize(width,height); await delay(100); await snapshot('repair-' + width);
    }
    win.setContentSize(1440, 900); await delay(100);
    await number('Speed', 2);
    await wait(() => evaluate(() => document.querySelector('.fieldcol')?.dataset.planningReady === 'true' && !document.querySelector('.field-status-label')), 'edited limit restores trajectory');
    await save();
    assert.equal(saved.name, 'Recovery project');
    assert.equal(saved.paths[0].constraints.maxVel, 2);
    assert.deepEqual(saved.paths[0].waypoints, first.waypoints);
    await snapshot('recovered');
    await number('Acceleration', 1.25);
    await save();
    assert.equal(saved.paths[0].constraints.maxAccel, 1.25);
    assert.equal(saved.paths[0].constraints.maxDecel, 1.25);
    assert.equal(await evaluate(() => [...document.querySelectorAll('.path-band label')].some(el => /decel/i.test(el.textContent))), false);
    await evaluate(() => window.restorePlanner());
    await number('Speed', 0.5);
    await wait(() => evaluate(() => document.querySelector('.fieldcol')?.dataset.planningReady === 'true' && !document.querySelector('.field-status-label')), 'real whole-path 0.5 velocity trajectory');
    await save(); assert.equal(saved.paths[0].constraints.maxVel, 0.5);
    await snapshot('low-velocity-path');
    console.log('PASS Native failure details and Try again, current limit edits, field and timeline stay editable, restored trajectory');

    // A planning worker that never answers reaches the real deadline; editing stays available throughout.
    await evaluate(() => {
      const post = Worker.prototype.postMessage;
      window.restorePlanner = () => { Worker.prototype.postMessage = post; delete window.restorePlanner; };
      Worker.prototype.postMessage = function(message, ...args) {
        if (message.mode === 'editing' && message.path?.constraints?.maxVel === 0.6) return;
        return post.call(this, message, ...args);
      };
    });
    await number('Speed', 0.6);
    await delay(1500);
    assert.equal(await evaluate(() => !!document.querySelector('.fieldsvg').closest('[inert]')), false, 'Pending timing never freezes the field');
    await wait(async () => { await delay(400); return evaluate(() => document.querySelector('.field-status-label')?.textContent === 'Couldn’t time this path'); }, 'timeout notice');
    const timeout = await evaluate(() => ({
      detail: document.querySelector('.field-status-details').textContent,
      action: document.querySelector('.field-status-action')?.textContent,
      fieldInert: !!document.querySelector('.fieldsvg').closest('[inert]'),
      bandInert: !!document.querySelector('.path-band').closest('[inert]'),
      statusInert: !!document.querySelector('.field-status').closest('[inert]'),
    }));
    assert.match(timeout.detail, /timed out/i);
    assert.doesNotMatch(timeout.detail, /stay unavailable|continuing|interactive result/i, 'Editing is never described as blocked');
    assert.equal(timeout.action, 'Try again');
    assert.equal(timeout.fieldInert, false, 'Timed-out timing leaves the field editable');
    assert.equal(timeout.bandInert, false, 'Timed-out timing leaves the timeline usable');
    assert.equal(timeout.statusInert, false, 'The retry action accepts native input');
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(100); await snapshot('timeout-' + width);
    }
    win.setContentSize(1440, 900); await delay(100);
    await evaluate(() => window.restorePlanner());
    await click('.field-status-action', 'Try again');
    await wait(() => evaluate(() => document.querySelector('.fieldcol')?.dataset.planningReady === 'true' && !document.querySelector('.field-status-label')), 'retry restores the trajectory');
    await save(); assert.equal(saved.paths[0].constraints.maxVel, 0.6);
    console.log('PASS A planning timeout keeps editing available and recovers with Try again');

    // Expanded export failures must reserve their height above placement guidance.
    await click('[aria-label="Place command"]');
    win.webContents.send('branches:menu', { command: 'export-bdx' });
    await wait(() => evaluate(() => document.querySelector('.field-status-label')?.textContent === 'Export failed'), 'export failure');
    await click('.field-status summary');
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(150);
      for (const inspector of [false, true]) {
        const isOpen = await evaluate(() => !!document.querySelector('[aria-label="Hide inspector"]'));
        if (isOpen !== inspector) {
          if (isOpen) await click('[aria-label="Hide inspector"]');
          else await click('.pp-more');
        }
        await delay(200);
        const geometry = await evaluate(() => {
          const details = document.querySelector('.field-status-details').getBoundingClientRect();
          const hint = document.querySelector('.stage-hint').getBoundingClientRect();
          const field = document.querySelector('.fieldcol').getBoundingClientRect();
          return { bottom: details.bottom, hintTop: hint.top, left: details.left, right: details.right, fieldLeft: field.left, fieldRight: field.right };
        });
        assert.ok(geometry.bottom <= geometry.hintTop, 'Expanded error must not overlap command placement hint');
        assert.ok(geometry.left >= geometry.fieldLeft && geometry.right <= geometry.fieldRight, 'Error details fit the field');
        assert.ok(await actionCentered(), 'Recovery action stays centered on its summary row when details expand');
        await snapshot('export-command-' + width + '-inspector-' + inspector);
      }
    }
    await delay(5200);
    assert.equal(await evaluate(() => document.querySelector('.field-status-label')?.textContent), 'Export failed', 'Failures never expire automatically');
    // Native keyboard toggles the disclosure and reaches its recovery action.
    await click('.field-status summary');
    await key('Tab');
    for (let i = 0; i < 100 && !(await evaluate(() => document.activeElement?.matches('.field-status summary'))); i++) await key('Tab');
    assert.equal(await evaluate(() => document.activeElement?.matches('.field-status summary')), true);
    await key(' ');
    assert.equal(await evaluate(() => document.querySelector('.field-status details').open), true);
    await key('Tab');
    assert.equal(await evaluate(() => document.activeElement?.textContent), 'Dismiss');
    await key('Enter');
    await wait(() => evaluate(() => !document.querySelector('.field-status')), 'keyboard dismisses export failure');
    console.log('PASS Expanded long export error stays above command placement guidance at both sizes and inspector states; keyboard disclosure and dismissal');

    async function actionCentered() {
      return evaluate(() => {
        const summary = document.querySelector('.field-status summary').getBoundingClientRect();
        const action = document.querySelector('.field-status-action').getBoundingClientRect();
        return Math.abs((summary.top + summary.bottom - action.top - action.bottom) / 2) <= 0.5;
      });
    }
    const hasSuccess = () => evaluate(() => document.querySelector('.field-status-label')?.textContent === 'BDX exported');
    const moveAway = () => win.webContents.sendInputEvent({ type: 'mouseMove', x: 10, y: 180 });
    async function exportSuccess() {
      win.webContents.send('branches:menu', { command: 'export-bdx' });
      await wait(hasSuccess, 'successful export notice');
    }
    exportSucceeds = true;
    await exportSuccess();
    await click('.field-status summary');
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(150);
      for (const inspector of [false, true]) {
        const isOpen = await evaluate(() => !!document.querySelector('[aria-label="Hide inspector"]'));
        if (isOpen !== inspector) {
          if (isOpen) await click('[aria-label="Hide inspector"]');
          else await click('.pp-more');
        }
        assert.ok(await actionCentered(), 'Dismiss centered beside expanded Details');
        await snapshot('export-success-' + width + '-inspector-' + inspector + '-expanded');
        await click('.field-status summary');
        assert.ok(await actionCentered(), 'Dismiss centered beside collapsed Details');
        await snapshot('export-success-' + width + '-inspector-' + inspector + '-collapsed');
        await click('.field-status summary');
        assert.equal(await evaluate(() => document.querySelector('.field-status details').open), true);
      }
    }
    moveAway();
    await click('.toolbar .place[aria-current="page"]');
    await delay(5200);
    assert.ok(await hasSuccess(), 'Expanded details stay readable after the expiry time, without pointer or keyboard focus');
    await click('.field-status summary');
    moveAway();
    for (let i = 0; i < 100 && !(await evaluate(() => document.activeElement?.matches('.field-status summary'))); i++) await key('Tab');
    assert.equal(await evaluate(() => document.activeElement?.matches('.field-status summary')), true);
    await delay(5200);
    assert.ok(await hasSuccess(), 'Keyboard focus pauses expiry even when details are collapsed');
    await key('Tab');
    assert.equal(await evaluate(() => document.activeElement?.matches('.field-status-action')), true);
    await key('Enter');
    await wait(() => evaluate(() => !document.querySelector('.field-status')), 'keyboard dismisses success');

    await exportSuccess();
    await click('.field-status-action');
    await wait(() => evaluate(() => !document.querySelector('.field-status')), 'pointer dismisses success');
    // A new surface under the pointer must not inherit the dismissed surface's pause state.
    await exportSuccess();
    await delay(5200);
    assert.ok(await hasSuccess(), 'Hover pauses expiry');
    moveAway();
    await click('.toolbar .place[aria-current="page"]');
    await delay(4000);
    assert.ok(await hasSuccess(), 'Success remains visible before five idle seconds');
    await exportSuccess();
    await delay(1500);
    assert.ok(await hasSuccess(), 'Repeating an identical export starts a new lifetime');
    await wait(() => evaluate(() => !document.querySelector('.field-status')), 'success automatically dismisses after five idle seconds');
    assert.equal(await evaluate(() => document.activeElement?.matches('.toolbar .place[aria-current="page"]')), true, 'Expiry preserves keyboard focus');
    await snapshot('export-success-expired');
    console.log('PASS Success auto-dismisses after five idle seconds; hover, focus and expanded details pause; repeated exports renew; native pointer/keyboard Dismiss; centered at both sizes and inspector states');
  } catch (error) { console.error(error); if(win) await snapshot('failure'); process.exitCode=1; }
  finally { win?.destroy(); app.exit(process.exitCode || 0); }
});
