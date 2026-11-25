// Built-App check for explicit turn direction controls and the Focus (hidden path list) state.
// Uses the mocked branches preload: local save/restore only, robot calls are refused.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = process.env.BORDEAUX_ROTATION_FOCUS_UI_OUTPUT;
app.setPath('userData', path.join(output, 'user-data'));
let win, saved, saves = 0;
const errors = [], robotCalls = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true);
async function wait(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(75); } throw Error('Timed out: ' + label); }
async function focusWindow() {
  app.focus({ steal: true }); win.focus(); win.webContents.focus();
  await wait(() => evaluate(() => document.hasFocus()), 'renderer keyboard focus');
}
async function click(selector, text) {
  await focusWindow();
  await wait(() => evaluate((selector, text) => {
    const item = [...document.querySelectorAll(selector)].find((el) => !text || el.textContent.trim() === text || (el.getAttribute('role') === 'menuitem' && el.querySelector('span')?.textContent.trim() === text));
    return !!item && !item.disabled && !item.closest('[inert]') && item.getClientRects().length > 0;
  }, selector, text), 'enabled control: ' + selector + (text ? ' ' + text : ''));
  const point = await evaluate((selector, text) => {
    const item = [...document.querySelectorAll(selector)].find((el) => !text || el.textContent.trim() === text || (el.getAttribute('role') === 'menuitem' && el.querySelector('span')?.textContent.trim() === text));
    item.scrollIntoView({ block: 'nearest' });
    const r = item.getBoundingClientRect(), x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    if (!item.contains(document.elementFromPoint(x, y))) throw Error('Obscured control: ' + selector + ' ' + text);
    return { x, y };
  }, selector, text);
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, modifiers: [], ...point });
  await delay(300);
}
async function key(keyCode, modifiers = []) {
  await focusWindow();
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  const char = { Space: ' ', Enter: '\r', '\\': '\\' }[keyCode];
  if (char && !modifiers.length) win.webContents.sendInputEvent({ type: 'char', keyCode: char, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await delay(120);
}
const primary = process.platform === 'darwin' ? 'meta' : 'control';
async function snapshot(name) { await delay(120); await fs.writeFile(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
ipcMain.handle('branches:restore', () => ({ project: saved }));
ipcMain.handle('branches:catalog', () => ({ catalog: { projectName: 'Fixture', commands: [], warnings: [] }, bookmarkId: 'fixture' }));
ipcMain.handle('branches:save', (_event, project) => { saved = project; saves++; return { saved: true }; });
ipcMain.handle('branches:robot-call', (_event, name) => { robotCalls.push(name); throw Error('Robot transport is not available in this check'); });
async function save() { const before = saves; await click('.project-chip'); await click('[role="menuitem"][data-action="save"]'); await wait(() => saves > before, 'save'); }

const TARGET_GROUP = '[role="group"][aria-label="Turn direction into target heading"]';
const WAYPOINT_GROUP = '[role="group"][aria-label="Turn direction into heading"]';
const pressedIn = (group) => evaluate((group) => [...document.querySelectorAll(group + ' .seg-i')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent.trim()), group);
const activeText = () => evaluate(() => document.activeElement?.textContent.trim() || document.activeElement?.tagName);

app.whenReady().then(async () => {
  try {
    const corpus = JSON.parse(await fs.readFile('benchmarks/planner-corpus/v3/corpus.bordeaux.json', 'utf8'));
    const first = structuredClone(corpus.paths.find((p) => p.id === 'corpus-neutral-stop'));
    first.name = 'Full turn through a 180° marker on the far side of the field';
    first.headingMode = 'targets';
    Object.assign(first.waypoints[1], { thetaOn: true, theta: 90 });
    first.targets = [{ anchor: 'param', f: 0.25, deg: 180 }];
    const second = { ...structuredClone(first), id: 'second-path', name: 'Second path', targets: [] };
    saved = { ...corpus, paths: [first, second], pathLinks: [], routines: [], editor: { activePathId: first.id, unitSystem: 'metric' } };
    win = new BrowserWindow({ show: true, width: 1440, height: 900, useContentSize: true, webPreferences: { preload: path.join(__dirname, 'verify-command-branches-ui-preload.cjs'), sandbox: false, contextIsolation: true, backgroundThrottling: false } });
    win.webContents.on('console-message', (details) => { if (details.level === 'error' && !details.message.startsWith("Loading the font 'data:")) errors.push(details.message); });
    const load = async () => {
      await win.loadFile(path.resolve('dist-renderer/index.html'));
      await focusWindow();
      await wait(() => evaluate(() => document.querySelectorAll('.pt-wp').length > 0 && document.querySelector('.fieldcol')?.dataset.planningReady === 'true'), 'editable path');
    };
    const openInspector = async () => { if (await evaluate(() => !document.querySelector('.ctxinsp'))) await click('.pp-more'); await wait(() => evaluate(() => !!document.querySelector('.ctxinsp')), 'inspector'); };
    const selectTarget = async () => {
      if (await evaluate(() => document.querySelector('.pt-target')?.getAttribute('aria-pressed') !== 'true')) {
        await evaluate(() => document.querySelector('.pt-target').focus()); await key('Enter');
      }
      await wait(() => evaluate(() => document.querySelector('.pt-target')?.getAttribute('aria-pressed') === 'true'), 'selected target');
      await openInspector(); await wait(() => evaluate((g) => !!document.querySelector(g), TARGET_GROUP), 'target direction');
    };
    const selectWaypoint = async (index) => {
      if (await evaluate((i) => document.querySelector(`.pt-wp[data-selection="wp:${i}"]`)?.getAttribute('aria-pressed') !== 'true', index)) {
        await evaluate((i) => document.querySelector(`.pt-wp[data-selection="wp:${i}"]`).focus(), index);
        await key('Enter');
      }
      await wait(() => evaluate((i) => document.querySelector(`.pt-wp[data-selection="wp:${i}"]`)?.getAttribute('aria-pressed') === 'true', index), 'selected waypoint');
      await openInspector();
    };

    // Tangent direction and straight segments, in both supported layouts and unit systems.
    const original = structuredClone(saved);
    const outgoing = '[role="group"][aria-label="Outgoing segment type"]';
    const tangent = '[role="group"][aria-labelledby="wp-tangent-nextC"]';
    for (const [width, height] of [[1440, 900], [1100, 720]]) for (const units of ['metric', 'imperial']) {
      saved = structuredClone(original); saved.editor.unitSystem = units;
      saved.paths[0].waypoints[0].segType = 'bezier';
      win.setContentSize(width, height);
      await load(); await selectWaypoint(0);
      const directionInput = await evaluate((scope) => {
        const label = [...document.querySelectorAll(scope + ' label')].find(el => el.textContent === 'Direction');
        return '#' + CSS.escape(label.htmlFor);
      }, tangent);
      await click(directionInput);
      await key('a', [primary]); await win.webContents.insertText('42'); await key('Enter');
      await save();
      const w = saved.paths[0].waypoints[0];
      assert.ok(Math.abs(Math.atan2(w.nextC.y - w.y, w.nextC.x - w.x) * 180 / Math.PI - 42) < 1e-8, 'tangent angle commits');
      assert.equal(w.theta, original.paths[0].waypoints[0].theta, 'tangent direction keeps robot facing');
      await click(directionInput); await key('a', [primary]); await win.webContents.insertText('90'); await key('Escape');
      await key('Tab'); await save();
      assert.deepEqual(saved.paths[0].waypoints[0].nextC, w.nextC, 'Escape discards tangent angle');
      assert.equal(await evaluate((s) => Number(document.querySelector(s).value), directionInput), 42, 'visible direction matches saved angle after cancel');
      await snapshot('tangent-curve-' + width + '-' + units);
      await click(outgoing + ' .seg-i', 'Straight');
      assert.equal(await evaluate((scope) => document.querySelectorAll(scope + ' input').length, tangent), 0, 'straight segment hides tangent fields');
      assert.equal(await evaluate(() => document.querySelectorAll('[data-role="ct"][data-idx="1"]').length), 0, 'straight segment hides handle');
      await save(); assert.equal(saved.paths[0].waypoints[0].segType, 'line');
      await snapshot('tangent-straight-' + width + '-' + units);
      await click('[aria-label="Undo"]');
      assert.deepEqual(await pressedIn(outgoing), ['Bézier'], 'Undo restores curve');
      await key('z', [primary, 'shift']);
      assert.deepEqual(await pressedIn(outgoing), ['Straight'], 'Redo restores straight');
      await save(); await load(); await selectWaypoint(0);
      assert.deepEqual(await pressedIn(outgoing), ['Straight'], 'straight survives reload');
      await click(outgoing + ' .seg-i', 'Bézier');
      await key('Tab'); await key('Enter');
      await evaluate(() => document.querySelector('.fieldsvg').focus()); await key('3');
      assert.equal(await evaluate(() => document.body.textContent.includes('Click the path to set a rotation target')), false, 'rotation banner removed');
      await key('Escape');
      await click('[aria-label="Hide inspector"]');
      await snapshot('tangent-inspector-closed-' + width + '-' + units);
    }
    saved = original; win.setContentSize(1440, 900);
    await load();
    // Rotation target: pointer, keyboard, Undo/Redo, save and reload.
    await selectTarget();
    assert.deepEqual(await pressedIn(TARGET_GROUP), ['Shortest'], 'missing direction reads as Shortest');
    await snapshot('target-shortest-1440');
    await click(TARGET_GROUP + ' .seg-i', 'Counterclockwise');
    assert.deepEqual(await pressedIn(TARGET_GROUP), ['Counterclockwise']);
    assert.equal(await activeText(), 'Counterclockwise', 'pointer press keeps focus on the chosen option');
    await snapshot('target-ccw-1440');
    await save(); assert.equal(saved.paths[0].targets[0].rotationDirection, 'ccw');
    // Pressing the current choice again changes nothing; it returns keyboard focus to the group after Save.
    const savesBefore = saves; await click(TARGET_GROUP + ' .seg-i', 'Counterclockwise');
    assert.equal(await activeText(), 'Counterclockwise'); assert.equal(saves, savesBefore);
    await key('Tab', ['shift']); assert.equal(await activeText(), 'Clockwise');
    await key('Space');
    assert.deepEqual(await pressedIn(TARGET_GROUP), ['Clockwise']);
    await key('Tab', ['shift']); assert.equal(await activeText(), 'Shortest');
    await key('Enter');
    assert.deepEqual(await pressedIn(TARGET_GROUP), ['Shortest']);
    await save(); assert.equal(saved.paths[0].targets[0].rotationDirection, undefined, 'Shortest clears the authored direction');
    await click('[aria-label="Undo"]');
    assert.deepEqual(await pressedIn(TARGET_GROUP), ['Clockwise'], 'Undo restores the previous direction');
    await key('z', [primary, 'shift']);
    assert.deepEqual(await pressedIn(TARGET_GROUP), ['Shortest'], 'Redo reapplies Shortest');
    await click('[aria-label="Undo"]'); await click('[aria-label="Undo"]');
    assert.deepEqual(await pressedIn(TARGET_GROUP), ['Counterclockwise'], 'Undo steps through each direction once');
    await save(); assert.equal(saved.paths[0].targets[0].rotationDirection, 'ccw');

    // Pinned interior waypoint heading.
    await selectWaypoint(1);
    await wait(() => evaluate((g) => !!document.querySelector(g), WAYPOINT_GROUP), 'waypoint direction');
    await click(WAYPOINT_GROUP + ' .seg-i', 'Clockwise');
    await save(); assert.equal(saved.paths[0].waypoints[1].rotationDirection, 'cw');
    await snapshot('waypoint-cw-1440');

    await load();
    await selectTarget();
    assert.deepEqual(await pressedIn(TARGET_GROUP), ['Counterclockwise'], 'target direction survives reload');
    await selectWaypoint(1);
    assert.deepEqual(await pressedIn(WAYPOINT_GROUP), ['Clockwise'], 'waypoint direction survives reload');

    const layout = (group) => evaluate((group) => {
      const panel = document.querySelector('.ctxinsp').getBoundingClientRect();
      return [...document.querySelectorAll(group + ' .seg-i')].map((b) => { const r = b.getBoundingClientRect(), span = b.querySelector('span');
        return { text: b.textContent.trim(), inside: r.left >= panel.left && r.right <= panel.right, oneLine: span.getClientRects().length === 1, clipped: span.scrollWidth > span.clientWidth + 1 }; });
    }, group);
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(250);
      await selectTarget();
      for (const row of await layout(TARGET_GROUP)) assert.ok(row.inside && row.oneLine && !row.clipped, 'readable option at ' + width + ': ' + JSON.stringify(row));
      await snapshot('target-open-' + width);
      await selectWaypoint(1);
      for (const row of await layout(WAYPOINT_GROUP)) assert.ok(row.inside && row.oneLine && !row.clipped, 'readable waypoint option at ' + width + ': ' + JSON.stringify(row));
      await snapshot('waypoint-open-' + width);
      await click('[aria-label="Hide inspector"]');
      await snapshot('inspector-closed-' + width);

      // Hide the path list from its own header by pointer; the restore strip is then the only way back.
      const focus = '.library-find .library-hide';
      assert.equal(await evaluate(() => document.querySelectorAll('.field-focus,.viewctl [aria-label*="path list"]').length), 0, 'no second hide control on the field');
      assert.equal(await evaluate((s) => document.querySelector(s)?.getAttribute('aria-label'), focus), 'Hide path list');
      await click(focus);
      assert.equal(await evaluate(() => document.querySelector('.library-rail').hidden), true);
      assert.equal(await evaluate(() => document.querySelectorAll('.library-restore-btn').length), 1, 'one restore control');
      assert.equal(await evaluate(() => document.querySelector('.library-restore-btn')?.getAttribute('aria-label')), 'Show path list');
      await snapshot('focus-on-' + width);
      await openInspector(); await snapshot('focus-on-inspector-' + width);
      await click('.library-restore-btn');
      await wait(() => evaluate(() => !document.querySelector('.library-rail').hidden && !document.querySelector('.library-restore')), 'restored library');
      await wait(() => evaluate(() => document.activeElement?.matches('.library-pick[aria-current="true"]')), 'restore moves focus to the current path');
      await snapshot('focus-restored-' + width);
      await click('[aria-label="Hide inspector"]');
    }

    // Keyboard: \ shortcut, Enter on the restore strip, then Enter on the library's hide button.
    win.setContentSize(1440, 900); await delay(250);
    await click('.fieldsvg').catch(() => {});
    await key('Escape');
    await evaluate(() => document.querySelector('.fieldsvg')?.focus());
    await key('\\');
    assert.equal(await evaluate(() => document.querySelector('.library-rail').hidden), true, 'backslash enters Focus');
    await evaluate(() => document.querySelector('.library-restore-btn').focus());
    await key('Enter');
    await wait(() => evaluate(() => !document.querySelector('.library-rail').hidden), 'Enter restores the library');
    await wait(() => evaluate(() => document.activeElement?.matches('.library-pick[aria-current="true"]')), 'keyboard restore moves focus to the current path');
    await evaluate(() => document.querySelector('.library-find .library-hide').focus());
    await key('Enter');
    assert.equal(await evaluate(() => document.querySelector('.library-rail').hidden), true, 'Enter on Hide path list hides the library');
    // The pressed button leaves with the list, so focus moves to the strip that replaces it, never the field's outline.
    await wait(() => evaluate(() => document.activeElement?.matches('.library-restore-btn')), 'focus leaves the hidden rail for the restore strip');
    assert.equal(await evaluate(() => Boolean(document.activeElement?.closest('[hidden]'))), false, 'focus is never inside the hidden rail');

    // Restored state: the Focus preference persists, and the strip is there on the next open.
    await load();
    assert.equal(await evaluate(() => document.querySelector('.library-rail').hidden && !!document.querySelector('.library-restore-btn')), true, 'restored Focus shows the way back');
    await snapshot('focus-restored-on-open-1440');
    await click('.library-restore-btn');
    assert.equal(await evaluate(() => document.querySelector('.library-rail').hidden), false);

    assert.deepEqual(robotCalls, [], 'no robot transport calls');
    assert.deepEqual(errors, [], 'renderer console errors');
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ ok: true, saves }, null, 2));
    console.log('Rotation direction and Focus UI checks passed. Screenshots: ' + output);
    app.exit(0);
  } catch (error) {
    console.error(error);
    try { await snapshot('failure'); } catch (_) { /* Window may be gone. */ }
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ ok: false, error: String(error && error.stack || error), errors }, null, 2)).catch(() => {});
    app.exit(1);
  }
});
