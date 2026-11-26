// Built-App check for the field's Layers menu and the AprilTag layer, at both supported sizes and in both unit systems.
// Uses the mocked branches preload: local save/restore only, robot calls are refused.
//
// Ways this can fail, each checked below:
// - Tags show before anyone asks for them (the layer must start off, so a project looks as it did).
// - A tag is drawn away from its official pose (positions are recomputed here from the vendored WPILib file).
// - Numbers clutter the fitted field, or are missing once zoomed in.
// - The Layers menu shows the wrong state or keys, does not toggle, or loses focus (pointer, Enter/arrows, Escape).
// - Pressing the Layers button while its menu is open reopens the menu instead of closing it.
// - G or T stops toggling its layer.
// - A tag takes the pointer: placing a waypoint on a tag must still place it.
// - A tag or its hover card is drawn over the tool rail instead of under it.
// - The hover card names the wrong tag, shows anything but the tag number, or stays up after the pointer leaves or
//   presses.
// - Hover changes anything but the hovered tag (a ring over neighbors, fading the others), or leaves it unmarked.
// - The Routines page loses the layer.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = process.env.BORDEAUX_FIELD_LAYERS_UI_OUTPUT;
app.setPath('userData', path.join(output, 'user-data'));
let win, saved;
const errors = [], robotCalls = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true);
async function wait(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(75); } throw Error('Timed out: ' + label); }
async function focusWindow() {
  app.focus({ steal: true }); win.focus(); win.webContents.focus();
  await wait(() => evaluate(() => document.hasFocus()), 'renderer keyboard focus');
}
async function pointAt(selector, text) {
  await wait(() => evaluate((selector, text) => [...document.querySelectorAll(selector)].some((el) => (!text || el.textContent.trim() === text) && !el.disabled && el.getClientRects().length > 0), selector, text), 'control: ' + selector + ' ' + (text || ''));
  return evaluate((selector, text) => {
    const item = [...document.querySelectorAll(selector)].find((el) => (!text || el.textContent.trim() === text) && !el.disabled && el.getClientRects().length > 0);
    const r = item.getBoundingClientRect(), x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    if (!item.contains(document.elementFromPoint(x, y))) throw Error('Obscured control: ' + selector + ' ' + (text || ''));
    return { x, y };
  }, selector, text);
}
async function press(point) {
  await focusWindow();
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, modifiers: [], ...point });
  await delay(250);
}
const click = async (selector, text) => press(await pointAt(selector, text));
async function move(point) { await focusWindow(); win.webContents.sendInputEvent({ type: 'mouseMove', ...point }); await delay(200); }
async function key(keyCode, modifiers = []) {
  await focusWindow();
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  const char = { Space: ' ', Enter: '\r' }[keyCode] ?? (keyCode.length === 1 ? keyCode : null);
  if (char && !modifiers.length) win.webContents.sendInputEvent({ type: 'char', keyCode: char, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await delay(150);
}
async function snapshot(name) { await delay(150); await fs.writeFile(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
ipcMain.handle('branches:restore', () => ({ project: saved }));
ipcMain.handle('branches:catalog', () => ({ catalog: { projectName: 'Fixture', commands: [], warnings: [] }, bookmarkId: 'fixture' }));
ipcMain.handle('branches:save', (_event, project) => { saved = project; return { saved: true }; });
ipcMain.handle('branches:robot-call', (_event, name) => { robotCalls.push(name); throw Error('Robot transport is not available in this check'); });

const LAYERS = '[aria-label="Field layers"]';
const MENU = '[role="menu"][aria-label="Field layers"]';
const menuState = () => evaluate((menu) => [...document.querySelectorAll(menu + ' [role="menuitemcheckbox"]')]
  .map((item) => [item.textContent.trim(), item.getAttribute('aria-checked')]), MENU);
const layersShown = () => evaluate(() => ({ grid: !!document.querySelector('.fieldsvg .field-grid'), tags: !!document.querySelector('.fieldsvg .field-apriltags') }));
const active = () => evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent.trim());

// Where each tag must land on screen: the vendored WPILib pose, turned into the center-origin frame, then through the
// calibrated field image and the field SVG's current transform. Independent of the renderer's own tag code.
async function expectedTagPoints() {
  const layout = JSON.parse(await fs.readFile('src/core/field/wpilib/2026-rebuilt-andymark.json', 'utf8'));
  const calibration = await fs.readFile('src/core/field/imageCalibration.ts', 'utf8');
  const image = Object.fromEntries(['left', 'right', 'top', 'bottom'].map((name) => [name, Number(calibration.match(new RegExp(name + ': (\\d+)'))[1])]));
  const { length, width } = layout['field-dimensions'];
  const ctm = await evaluate(() => { const m = document.querySelector('.fieldsvg').getScreenCTM(); return { a: m.a, d: m.d, e: m.e, f: m.f }; });
  const sx = (image.right - image.left) / length, sy = (image.bottom - image.top) / width;
  const cx = (image.left + image.right) / 2, cy = (image.top + image.bottom) / 2;
  return new Map(layout['field-tags'].map(({ ID, pose: { translation: t } }) => {
    const x = length / 2 - t.x, y = width / 2 - t.y;
    return [ID, { x: ctm.a * (cx + x * sx) + ctm.e, y: ctm.d * (cy - y * sy) + ctm.f }];
  }));
}
const drawnTagPoints = () => evaluate(() => Object.fromEntries([...document.querySelectorAll('.field-apriltag')].map((tag) => {
  const r = tag.querySelector('.field-apriltag-face').getBoundingClientRect();
  return [tag.dataset.tag, { x: r.x + r.width / 2, y: r.y + r.height / 2 }];
})));
const railBox = () => evaluate(() => { const r = document.querySelector('.toolrail').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
const inside = (p, box) => p.x > box.x && p.x < box.x + box.w && p.y > box.y && p.y < box.y + box.h;

app.whenReady().then(async () => {
  try {
    const corpus = JSON.parse(await fs.readFile('benchmarks/planner-corpus/v3/corpus.bordeaux.json', 'utf8'));
    const first = structuredClone(corpus.paths.find((p) => p.id === 'corpus-neutral-stop'));
    // One routine that drives the path, so the Routines page draws its own field.
    const routines = [{ id: 'leave-routine', name: 'Leave', nodes: [{ id: 'leave', type: 'path', ref: first.id }] }];
    const original = { ...corpus, schemaVersion: '1.1', paths: [first], pathLinks: [], routines, activeRoutineId: 'leave-routine', editor: { activePathId: first.id, unitSystem: 'metric' } };
    win = new BrowserWindow({ show: true, width: 1440, height: 900, useContentSize: true, webPreferences: { preload: path.join(__dirname, 'verify-command-branches-ui-preload.cjs'), sandbox: false, contextIsolation: true, backgroundThrottling: false } });
    win.webContents.on('console-message', (details) => { if (details.level === 'error' && !details.message.startsWith("Loading the font 'data:")) errors.push(details.message); });
    let underRail = 0;

    for (const [width, height, units] of [[1440, 900, 'metric'], [1100, 720, 'imperial']]) {
      const size = width;
      saved = structuredClone(original); saved.editor.unitSystem = units;
      win.setContentSize(width, height);
      await win.loadFile(path.resolve('dist-renderer/index.html'));
      await focusWindow();
      await wait(() => evaluate(() => document.querySelectorAll('.pt-wp').length > 0 && document.querySelector('.fieldcol')?.dataset.planningReady === 'true'), 'editable path');

      // Off by default: the grid shows, tags do not.
      assert.deepEqual(await layersShown(), { grid: true, tags: false }, 'Grid on and tags off on open');
      assert.equal(await evaluate((s) => document.querySelector(s).getAttribute('aria-expanded'), LAYERS), 'false');

      // Pointer: the menu opens above its button with each layer's state and key.
      await click(LAYERS);
      await wait(() => evaluate((m) => !!document.querySelector(m), MENU), 'Layers menu');
      assert.deepEqual(await menuState(), [['GridG', 'true'], ['AprilTagsT', 'false']]);
      const [menuBox, buttonBox] = await evaluate((m, b) => [document.querySelector(m), document.querySelector(b)].map((el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, right: r.right }; }), MENU, LAYERS);
      assert.ok(menuBox.bottom <= buttonBox.top + 1, 'The menu opens above the Layers button');
      await snapshot(`menu-${size}`);
      await click(MENU + ' [role="menuitemcheckbox"]', 'AprilTagsT');
      await wait(async () => (await layersShown()).tags, 'AprilTags shown from the menu');
      assert.equal(await evaluate((m) => !!document.querySelector(m), MENU), false, 'Choosing closes the menu');
      assert.equal(await active(), 'Field layers', 'Focus returns to the Layers button');

      // Every tag at its official pose, without numbers at fit.
      const expected = await expectedTagPoints(), drawn = await drawnTagPoints();
      assert.equal(Object.keys(drawn).length, 32, '32 tags drawn');
      for (const [id, point] of expected) {
        const mark = drawn[id];
        assert.ok(mark && Math.hypot(mark.x - point.x, mark.y - point.y) < 1.5, `Tag ${id} at ${JSON.stringify(point)}, drawn at ${JSON.stringify(mark)}`);
      }
      assert.equal(await evaluate(() => document.querySelectorAll('.field-apriltag-id').length), 0, 'No numbers at fit');
      assert.equal(await evaluate(() => getComputedStyle(document.querySelector('.field-apriltags')).pointerEvents), 'none', 'Tags take no pointer input');
      await snapshot(`tags-fit-${size}`);

      // Hover: the card names the tag, and goes away when the pointer leaves or presses.
      const tag26 = expected.get(26);
      await move({ x: Math.round(tag26.x), y: Math.round(tag26.y) });
      await wait(() => evaluate(() => !!document.querySelector('.field-apriltag-card')), 'hover card');
      const card = await evaluate(() => document.querySelector('.field-apriltag-card').textContent);
      assert.equal(card, 'Tag 26', 'Only the tag number');
      const hoverState = () => evaluate(() => ({
        tag: document.querySelector('.field-apriltag-hover')?.dataset.tag,
        face: document.querySelector('.field-apriltag-hover .field-apriltag-face')?.getAttribute('stroke'),
        layer: document.querySelector('.field-apriltags').outerHTML,
        rings: document.querySelectorAll('.field-apriltag-card circle').length,
      }));
      const hovered = await hoverState();
      assert.equal(hovered.tag, '26'); assert.equal(hovered.rings, 0, 'No ring');
      assert.ok(await evaluate(() => Boolean(document.querySelector('.field-apriltag-hover').compareDocumentPosition(document.querySelector('[data-role="wp"]')) & Node.DOCUMENT_POSITION_FOLLOWING)),
        'The hovered tag is drawn under waypoint handles');
      assert.notEqual(hovered.face, await evaluate(() => document.querySelector('.field-apriltag[data-tag="26"] .field-apriltag-face').getAttribute('stroke')), 'The hovered tag changes color');
      await snapshot(`hover-${size}`);
      await move({ x: Math.round(tag26.x), y: Math.round(tag26.y) - 80 });
      await wait(() => evaluate(() => !document.querySelector('.field-apriltag-card')), 'card hides when the pointer leaves');
      assert.equal((await hoverState()).layer, hovered.layer, 'Hover changes no other tag: the layer is identical with and without it');

      // A tag never takes the click: placing a waypoint on one still places it. Undo restores the path.
      const before = await evaluate(() => document.querySelectorAll('.pt-wp').length);
      await key('2');
      await press({ x: Math.round(tag26.x), y: Math.round(tag26.y) });
      await wait(() => evaluate((n) => document.querySelectorAll('.pt-wp').length === n + 1, before), 'waypoint placed on a tag');
      assert.equal(await evaluate(() => !!document.querySelector('.field-apriltag-card')), false, 'No card after a press');
      await key('Escape'); await key('z', [process.platform === 'darwin' ? 'meta' : 'control']);
      await wait(() => evaluate((n) => document.querySelectorAll('.pt-wp').length === n, before), 'Undo removes the waypoint');
      await key('1');

      // Keyboard: Enter opens on Grid, ArrowDown moves to AprilTags, Enter toggles and returns focus. Escape closes.
      await evaluate((b) => document.querySelector(b).focus(), LAYERS);
      await key('Enter');
      await wait(() => evaluate((m) => !!document.querySelector(m), MENU), 'Layers menu from Enter');
      assert.equal(await active(), 'GridG');
      await key('Down'); assert.equal(await active(), 'AprilTagsT');
      await key('Enter');
      await wait(async () => !(await layersShown()).tags, 'AprilTags hidden from the keyboard');
      assert.equal(await active(), 'Field layers');
      await key('Enter'); await wait(() => evaluate((m) => !!document.querySelector(m), MENU), 'menu again');
      // A press on the Layers button while its menu is open closes the menu and leaves it closed.
      await click(LAYERS); await delay(300);
      assert.equal(await evaluate((m) => !!document.querySelector(m), MENU), false, 'Pressing the open Layers button closes its menu');
      await click(LAYERS); await wait(() => evaluate((m) => !!document.querySelector(m), MENU), 'the next press opens it');
      await key('Escape');
      await wait(() => evaluate((m) => !document.querySelector(m), MENU), 'Escape closes the menu');
      assert.equal(await active(), 'Field layers', 'Escape returns focus');

      // Keys: T and G toggle their layers from the field.
      await evaluate(() => document.querySelector('.fieldsvg').focus());
      await key('t'); await wait(async () => (await layersShown()).tags, 'T shows tags');
      await key('g'); await wait(async () => !(await layersShown()).grid, 'G hides the grid');
      await key('g'); await wait(async () => (await layersShown()).grid, 'G shows the grid');

      // Zoomed in, numbers appear, and tags under the rail stay under it.
      for (let i = 0; i < 4; i++) await click('[aria-label="Zoom in"]');
      await wait(() => evaluate(() => document.querySelectorAll('.field-apriltag-id').length > 0), 'numbers when zoomed in');
      const rail = await railBox(), zoomed = await expectedTagPoints();
      for (const [id, point] of zoomed) {
        if (!inside(point, rail)) continue;
        underRail++;
        assert.ok(await evaluate((p) => !!document.elementFromPoint(p.x, p.y)?.closest('.toolrail'), point), `Tag ${id} is under the tool rail`);
      }
      const hubTag = [...zoomed].find(([, p]) => !inside(p, rail) && p.x > rail.x + rail.w + 40 && p.x < width - 60 && p.y > 60 && p.y < height - 300);
      assert.ok(hubTag, 'A tag in view to hover');
      await move({ x: Math.round(hubTag[1].x), y: Math.round(hubTag[1].y) });
      await wait(() => evaluate(() => !!document.querySelector('.field-apriltag-card')), 'hover card when zoomed');
      const cardBox = await evaluate(() => { const r = document.querySelector('.field-apriltag-card-box').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
      assert.ok(cardBox.x > rail.x + rail.w || cardBox.y > rail.y + rail.h || cardBox.y + cardBox.h < rail.y, 'The card stays clear of the rail');
      const number = await evaluate(() => { const r = document.querySelector('.field-apriltag-hover .field-apriltag-id').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
      assert.ok(number.x >= cardBox.x + cardBox.w || number.x + number.w <= cardBox.x || number.y >= cardBox.y + cardBox.h || number.y + number.h <= cardBox.y,
        `The card ${JSON.stringify(cardBox)} leaves the hovered tag's number ${JSON.stringify(number)} visible`);
      await snapshot(`tags-zoomed-${size}`);
      await move({ x: Math.round(hubTag[1].x), y: Math.round(hubTag[1].y) - 120 });

      // The Routines page keeps the layer on its own field (the Paths field stays mounted but hidden).
      await click('.places .place', 'Routines');
      await click('button', 'Field preview');
      await wait(() => evaluate(() => [...document.querySelectorAll('.fieldsvg')].some((svg) => svg.checkVisibility() && svg.getBoundingClientRect().width > 0
        && !!svg.querySelector('.field-apriltags') && !!svg.closest('.fieldcol')?.querySelector('[aria-label="Field layers"]'))), 'tags on the Routines field');
      await snapshot(`routines-${size}`);
      await click('button', 'Flow');
      await click('.places .place', 'Paths');
    }

    assert.ok(underRail > 0, 'At least one zoomed view puts a tag under the tool rail');
    assert.deepEqual(robotCalls, [], 'no robot transport calls');
    assert.deepEqual(errors, [], 'renderer console errors');
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ ok: true, tagsUnderRail: underRail }, null, 2));
    console.log('Field layers UI checks passed. Screenshots: ' + output);
    app.exit(0);
  } catch (error) {
    console.error(error);
    if (win) await snapshot('failure').catch(() => {});
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ ok: false, error: String(error && error.stack || error), errors }, null, 2)).catch(() => {});
    app.exit(1);
  }
});
