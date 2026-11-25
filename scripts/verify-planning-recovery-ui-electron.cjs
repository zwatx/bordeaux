const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { decodeProjectFile } = require('../dist-electron/core/project/fileFormat');
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
const flipDialog = '.path-flip[open]';
const flipChoice = (group, value) => flipDialog + ' label:has(input[name="pf-' + group + '"][value="' + value + '"])';
async function chooseHalfTurn() {
  await click(flipChoice('direction', 'rotate'));
  await click(flipChoice('target', 'replace'));
}
const closedFlip = () => wait(() => evaluate(selector => !document.querySelector(selector), flipDialog), 'Flip dialog closes');
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
    const source = await fs.readFile('benchmarks/planner-corpus/v2/corpus.bordeaux.json', 'utf8');
    const { project: corpus, migrated } = decodeProjectFile(source);
    assert.equal(migrated, true);
    const first = structuredClone(corpus.paths.find((p) => p.id === 'corpus-neutral-stop'));
    first.name = 'Path 1'; first.ranges = [];
    const second = structuredClone(first); second.id = 'fixture-second'; second.name = 'Path 2';
    saved = { ...corpus, paths: [first, second], pathLinks: [], routines: [], editor: { activePathId: first.id, unitSystem: 'metric' } };
    win = new BrowserWindow({ show: true, width: 1440, height: 900, useContentSize: true, webPreferences: { preload: path.join(__dirname, 'verify-planning-recovery-ui-preload.cjs'), sandbox: false, contextIsolation: true, backgroundThrottling: false } });
    await win.loadFile(path.resolve('dist-renderer/index.html'));
    await wait(() => evaluate(() => document.querySelectorAll('.pt-wp').length > 0 && !document.querySelector('.fieldcol[data-planning-ready="false"]')), 'current trajectory');
    assert.ok(await evaluate(() => document.querySelector('.project-chip-name')?.textContent.includes('Recovery project') || document.querySelector('.toolbar').textContent.includes('Recovery project')));
    const historicalStart = JSON.parse(source).paths.find((p) => p.id === first.id).waypoints[0];
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height);
      await wait(() => evaluate((w, h) => innerWidth === w && innerHeight === h, width, height), 'field capture viewport');
      await click('.fieldsvg [data-role="wp"][data-idx="0"]');
      const measured = await evaluate(() => {
        const node = document.querySelector('.fieldsvg [data-role="wp"][data-idx="0"]');
        return {
          x: +node.getAttribute('x') + +node.getAttribute('width') / 2,
          y: +node.getAttribute('y') + +node.getAttribute('height') / 2,
          yReadout: document.getElementById([...document.querySelectorAll('aside label')].find(label => label.textContent === 'Y')?.htmlFor)?.value,
        };
      });
      assert.ok(Math.abs(measured.x - (1950.5 + (16.541/2 - historicalStart.x) * (3377-524)/16.518)) < .1);
      assert.ok(Math.abs(measured.y - (791.5 - (8.069/2 - historicalStart.y) * (1488-95)/8.043)) < .1);
      assert.ok(Number(measured.yReadout) < 0, 'Migrated waypoint shows signed Y');
      await snapshot('field-centered-migrated-' + width);
    }
    await key('Escape');
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(150);
      await key('Tab'); // The original failure only appeared after keyboard navigation.
      const grid = await evaluate(() => { const button = document.querySelector('[aria-label="Toggle field grid"]'); button.focus(); return button.getAttribute('aria-pressed'); });
      await key('Space');
      await wait(() => evaluate(() => Boolean(document.querySelector('[aria-label="Pause trajectory playback"]'))), 'Space plays from focused field toolbar');
      assert.equal(await evaluate(() => document.querySelector('[aria-label="Toggle field grid"]').getAttribute('aria-pressed')), grid, 'Space does not activate focused Grid');
      await key('Space');
      await wait(() => evaluate(() => Boolean(document.querySelector('[aria-label="Play trajectory"]'))), 'Space pauses from focused toolbar');
      await click('#band-path-name');
      const name = await evaluate(() => document.activeElement.value);
      await key('Space');
      assert.ok(await evaluate(name => document.activeElement.value.length === name.length + 1, name), 'Space still types into a name draft');
      assert.ok(await evaluate(() => Boolean(document.querySelector('[aria-label="Play trajectory"]'))), 'Typing does not start playback');
      await key('Escape');
      await click('.project-chip'); await evaluate(() => document.querySelector('.project-chip').focus()); await key('Space');
      assert.ok(await evaluate(() => Boolean(document.querySelector('[aria-label="Play trajectory"]'))), 'Open project menu owns Space');
      await key('Escape');
      await snapshot('space-playback-and-clean-field-' + width);
    }
    win.setContentSize(1440, 900);
    // Targeted local rechecks still use the production App and native input.
    // CI omits this flag and exercises the complete recovery/notice workflow.
    if (process.env.BORDEAUX_FIELD_COORDINATES_ONLY !== '1') {
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

    // Expanded export failures remain readable during command placement.
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
          const field = document.querySelector('.fieldcol').getBoundingClientRect();
          return { bottom: details.bottom, left: details.left, right: details.right, fieldBottom: field.bottom,
            fieldLeft: field.left, fieldRight: field.right, placementHint: Boolean(document.querySelector('.stage-hint')) };
        });
        assert.equal(geometry.placementHint, false, 'Command placement adds no instruction overlay');
        assert.ok(geometry.bottom <= geometry.fieldBottom, 'Expanded error fits above the field footer');
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
    console.log('PASS Expanded export error fits the field during command placement at both sizes and inspector states; keyboard disclosure and dismissal');

    async function actionCentered() {
      return evaluate(() => {
        const summary = document.querySelector('.field-status summary').getBoundingClientRect();
        const action = document.querySelector('.field-status-action').getBoundingClientRect();
        return Math.abs((summary.top + summary.bottom - action.top - action.bottom) / 2) <= 0.5;
      });
    }
    const hasSuccess = () => evaluate(() => document.querySelector('.field-confirmation .field-status-label')?.firstChild?.textContent === 'BDX exported');
    const moveAway = () => win.webContents.sendInputEvent({ type: 'mouseMove', x: 10, y: 180 });
    async function exportSuccess() {
      win.webContents.send('branches:menu', { command: 'export-bdx' });
      await wait(hasSuccess, 'successful export notice');
    }
    exportSucceeds = true;
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(150);
      for (const inspector of [false, true]) {
        const isOpen = await evaluate(() => !!document.querySelector('[aria-label="Hide inspector"]'));
        if (isOpen !== inspector) {
          if (isOpen) await click('[aria-label="Hide inspector"]');
          else await click('.pp-more');
        }
        await exportSuccess();
        assert.ok(await evaluate(() => {
          const notice = document.querySelector('.field-confirmation');
          const { left, right, height, top } = notice.getBoundingClientRect();
          const field = notice.closest('.fieldcol').getBoundingClientRect();
          return left >= field.left && right <= field.right && height <= 32 && top >= field.top && top - field.top <= 12
            && notice.querySelector('[role="status"]') && !notice.querySelector('details, button, [tabindex]');
        }), 'Success is compact and anchored near the top of the field at ' + width);
        await snapshot('export-success-' + width + '-inspector-' + inspector);
      }
    }
    await exportSuccess();
    const center = await evaluate(() => {
      const r = document.querySelector('.field-confirmation').getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    win.webContents.sendInputEvent({ type: 'mouseMove', ...center });
    await wait(() => evaluate(() => document.querySelector('.field-confirmation')?.matches(':hover')), 'pointer hovers confirmation');
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
    // capturePage can otherwise return the compositor's previous frame after DOM removal.
    await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await delay(100);
    await snapshot('export-success-expired');
    console.log('PASS Compact success at both sizes and inspector states; hover pauses, repeat renews, and expiry preserves focus');
    }

    await key('Escape');
    await save();
    const beforeFlip = structuredClone(saved);
    const speedInput = await evaluate(() => '#' + CSS.escape([...document.querySelectorAll('.path-band label.numlbl')].find(label => label.textContent === 'Speed').htmlFor));
    await click(speedInput);
    await evaluate(selector => document.querySelector(selector).select(), speedInput);
    await win.webContents.insertText('-');
    await click('.field-flip');
    assert.equal(await evaluate(selector => document.activeElement === document.querySelector(selector), speedInput), true, 'Flip owns its press before moving focus away from an invalid draft');
    assert.equal(await evaluate(selector => Boolean(document.querySelector(selector)), flipDialog), false, 'Invalid draft refuses Flip');
    assert.deepEqual(saved.paths, beforeFlip.paths);
    await key('Escape');
    await click('.field-flip'); await chooseHalfTurn(); await click('.pf-commit'); await closedFlip();
    await save();
    const afterFlip = structuredClone(saved);
    assert.equal(afterFlip.field.coordinateSchemaId, 'wpilib-center-origin/2026-andymark/1');
    for (let i = 0; i < beforeFlip.paths[0].waypoints.length; i++) {
      const before = beforeFlip.paths[0].waypoints[i], after = afterFlip.paths[0].waypoints[i];
      assert.ok(Math.abs(after.x - (-before.x)) < 1e-10, 'Flip saves opposite-alliance X');
      assert.ok(Math.abs(after.y - (-before.y)) < 1e-10, 'Flip saves opposite-alliance Y');
      assert.equal(after.theta, before.theta + 180);
    }
    assert.deepEqual(afterFlip.paths.slice(1), beforeFlip.paths.slice(1), 'Other paths stay identical');
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(150);
      for (const inspector of [false, true]) {
        const isOpen = await evaluate(() => !!document.querySelector('[aria-label="Hide inspector"]'));
        if (isOpen !== inspector) {
          if (isOpen) await click('[aria-label="Hide inspector"]');
          else await click('.pp-more');
        }
        const projection = await evaluate(() => {
          const svg = document.querySelector('.fieldsvg'), frame = svg.querySelector('.field-frame');
          const point = svg.querySelector('[data-role="wp"][data-idx="0"]');
          const image = svg.querySelector('foreignObject');
          return { x: +point.getAttribute('x') + +point.getAttribute('width') / 2, y: +point.getAttribute('y') + +point.getAttribute('height') / 2,
            frame: ['x','y','width','height'].map(name => +frame.getAttribute(name)), imageTransform: image.getAttribute('transform'),
            origin: svg.querySelector('.field-origin')?.textContent };
        });
        assert.deepEqual(projection.frame, [524,95,3377-524,1488-95], 'Frame uses the original overlay playable boundaries');
        assert.equal(projection.imageTransform, null, 'The blue-right raster stays fixed while paths flip');
        assert.equal(projection.origin, undefined, 'Origin and direction labels are hidden without changing the calibrated frame');
        const firstAfter = afterFlip.paths[0].waypoints[0];
        assert.ok(Math.abs(projection.x - (1950.5 + firstAfter.x * (3377-524)/16.518)) < .1, 'Rendered X equals saved X in the calibrated frame');
        assert.ok(Math.abs(projection.y - (791.5 - firstAfter.y * (1488-95)/8.043)) < .1, 'Rendered Y equals saved Y in the calibrated frame');
        await snapshot('field-centered-flipped-' + width + '-inspector-' + inspector);
      }
    }
    await click('[aria-label="Undo"]'); await save();
    assert.deepEqual(saved.paths, beforeFlip.paths, 'Undo restores every path exactly');
    await click('[aria-label="Redo"]'); await save();
    assert.deepEqual(saved.paths, afterFlip.paths, 'Redo restores the flipped coordinates exactly');
    await win.reload();
    await wait(() => evaluate(() => document.querySelectorAll('.pt-wp').length > 0), 'reopened flipped project');
    await save();
    assert.deepEqual(saved.paths, afterFlip.paths, 'Save/reopen retains the flipped paths without another conversion');
    for (let i = 0; i < 100 && !(await evaluate(() => document.activeElement?.matches('.field-flip'))); i++) await key('Tab');
    assert.equal(await evaluate(() => document.activeElement?.matches('.field-flip')), true);
    await key('Enter');
    await chooseHalfTurn(); await click('.pf-commit'); await closedFlip();
    await save();
    for (let i = 0; i < beforeFlip.paths[0].waypoints.length; i++) {
      const before = beforeFlip.paths[0].waypoints[i], after = saved.paths[0].waypoints[i];
      assert.ok(Math.abs(after.x-before.x) < 1e-10 && Math.abs(after.y-before.y) < 1e-10, 'Two flips restore coordinates');
      assert.equal(after.theta, before.theta + 360);
    }
    await click('.places .place', 'Settings');
    await click('[aria-label="Display units"] button', 'Imperial');
    await click('.places .place', 'Paths');
    await save();
    assert.equal(saved.editor.unitSystem, 'imperial');
    for (const [width, height] of [[1440,900],[1100,720]]) {
      win.setContentSize(width,height); await delay(150);
      for (const inspector of [false,true]) {
        const isOpen = await evaluate(() => !!document.querySelector('[aria-label="Hide inspector"]'));
        if (isOpen !== inspector) {
          if (isOpen) await click('[aria-label="Hide inspector"]'); else await click('.pp-more');
        }
        await snapshot('field-blue-frame-imperial-' + width + '-inspector-' + inspector);
      }
    }
    const beforePlacement = structuredClone(saved.paths);
    await click('[aria-label="Place waypoint"]');
    const placement = await evaluate(() => {
      const svg = document.querySelector('.fieldsvg');
      const screen = new DOMPoint(1950.5 + 3 * (3377-524)/16.518, 791.5 - 1.5 * (1488-95)/8.043).matrixTransform(svg.getScreenCTM());
      return { x: Math.round(screen.x), y: Math.round(screen.y) };
    });
    for (const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, modifiers: [], ...placement });
    await delay(250); await save();
    assert.equal(saved.paths[0].waypoints.length, beforePlacement[0].waypoints.length + 1);
    const placed = saved.paths[0].waypoints.at(-1);
    assert.ok(Math.abs(placed.x-3) < .02 && Math.abs(placed.y-1.5) < .02, 'Pointer placement in imperial display stores canonical blue-origin meters');
    await click('[aria-label="Undo"]'); await save();
    assert.deepEqual(saved.paths, beforePlacement, 'Undo restores the paths exactly after inverse-mapped placement');

    await click('.field-flip');
    assert.equal(await evaluate(() => document.activeElement?.value), 'horizontal', 'Flip opens on the direction group');
    await key('Right');
    assert.equal(await evaluate(() => document.activeElement?.value), 'vertical', 'Arrow keys choose the mirror axis');
    await click('[aria-label="New path name"]');
    await evaluate(() => document.activeElement.select());
    await win.webContents.insertText(beforePlacement[1].name);
    await click('.pf-commit');
    assert.match(await evaluate(() => document.querySelector('.pf-error').textContent), /already exists/);
    await click('[aria-label="New path name"]');
    await evaluate(() => document.activeElement.select());
    await win.webContents.insertText('Mirrored pickup');
    await snapshot('flip-copy-1100');
    await click('.pf-commit'); await closedFlip(); await save();
    const copy = saved.paths.find(item => item.name === 'Mirrored pickup');
    assert.ok(copy && copy.id !== beforePlacement[0].id, 'The mirror becomes a separate named path');
    assert.equal(saved.editor.activePathId, copy.id);
    assert.deepEqual(saved.paths.filter(item => item.id !== copy.id), beforePlacement);
    for (let i = 0; i < copy.waypoints.length; i++) {
      const before = beforePlacement[0].waypoints[i], after = copy.waypoints[i];
      assert.equal(after.x, before.x);
      assert.ok(Math.abs(after.y - (-before.y)) < 1e-10);
      assert.ok(after.theta === -before.theta);
    }
    await click('[aria-label="Undo"]'); await save();
    assert.deepEqual(saved.paths, beforePlacement, 'One Undo removes the copy and preserves its source');

    await evaluate(() => {
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function(message, ...args) {
        if (message.mode === 'flip') {
          setTimeout(() => post.call(this, message, ...args), 2000);
          return;
        }
        return post.call(this, message, ...args);
      };
      window.restoreFlipWorker = () => { Worker.prototype.postMessage = post; delete window.restoreFlipWorker; };
    });
    await click('.field-flip'); await chooseHalfTurn(); await click('.pf-commit');
    assert.equal(await evaluate(() => document.querySelector('.path-flip')?.getAttribute('aria-busy')), 'true');
    await key('Escape'); await closedFlip();
    assert.equal(await evaluate(() => document.activeElement?.matches('.field-flip')), true, 'Cancel returns focus to Flip');
    const pendingSpeedInput = await evaluate(() => '#' + CSS.escape([...document.querySelectorAll('.path-band label.numlbl')].find(label => label.textContent === 'Speed').htmlFor));
    await click(pendingSpeedInput);
    await evaluate(selector => document.querySelector(selector).select(), pendingSpeedInput);
    await win.webContents.insertText('4'); await key('Enter'); await save();
    const interveningEdit = structuredClone(saved.paths);
    assert.notEqual(interveningEdit[0].constraints.maxVel, beforePlacement[0].constraints.maxVel);
    await delay(2400); await save();
    assert.deepEqual(saved.paths, interveningEdit, 'A canceled delayed Flip cannot overwrite an intervening committed edit');
    await evaluate(() => window.restoreFlipWorker());

    // Sharing means that replacing one path could move another. The chooser must offer an independent copy.
    const linked = structuredClone(saved);
    const position = linked.paths[0].waypoints[0];
    position.positionLink = 'flip-shared';
    linked.paths[0].waypoints.at(-1).positionLink = position.positionLink;
    const other = linked.paths[1].waypoints[0];
    other.x = position.x; other.y = position.y; other.positionLink = position.positionLink;
    linked.paths[0].waypoints[1].positionLink = 'flip-cross-only';
    linked.paths[1].waypoints[1].positionLink = 'flip-cross-only';
    saved = linked;
    await win.reload();
    await wait(() => evaluate(() => document.querySelector('.fieldcol')?.dataset.planningReady === 'true'), 'linked paths restored');
    await save();
    const linkedBefore = structuredClone(saved.paths);
    await click('.field-flip');
    assert.equal(await evaluate(() => document.querySelector('input[name="pf-target"][value="replace"]').disabled), true);
    await snapshot('flip-linked-1100');
    await click('.pf-commit'); await closedFlip(); await save();
    const linkedCopy = saved.paths.find(path => path.id === saved.editor.activePathId);
    assert.ok(linkedCopy && !linkedBefore.some(path => path.id === linkedCopy.id));
    const copiedGroup = linkedCopy.waypoints[0].positionLink;
    assert.ok(copiedGroup && copiedGroup !== position.positionLink, 'A shared group within the copied path gets its own identity');
    assert.equal(linkedCopy.waypoints.at(-1).positionLink, copiedGroup);
    assert.equal(linkedCopy.waypoints[1].positionLink, undefined, 'A cross-path-only link does not cross into the copy');
    assert.ok(Math.abs(linkedCopy.waypoints[0].x - (-position.x)) < 1e-10);
    assert.deepEqual(saved.paths.filter(path => path.id !== linkedCopy.id), linkedBefore);
    await click('[aria-label="Undo"]'); await save();
    assert.deepEqual(saved.paths, linkedBefore);
    console.log('PASS Selected-path half-turn, named vertical copy, duplicate-name validation, native keyboard/cancel focus, calibrated rendering, exact Undo/Redo and save/reopen');
  } catch (error) { console.error(error); if(win) await snapshot('failure'); process.exitCode=1; }
  finally { win?.destroy(); app.exit(process.exitCode || 0); }
});
