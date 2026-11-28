// Built-App check for touch and gesture input on the path field, at both supported sizes.
// Touch goes through Chromium's own input pipeline (DevTools Input.dispatchTouchEvent / dispatchMouseEvent), not
// synthetic DOM events. Uses the mocked branches preload (platform darwin): local save/restore only, robot calls refused.
//
// Ways this can fail, each checked below:
// - A finger that lands beside a waypoint pans the field instead of dragging the waypoint, or the waypoint jumps to
//   the finger instead of keeping where it was grabbed.
// - A tap beside a waypoint nudges it, or does not select it; a drag takes more than one Undo.
// - One finger on empty field does not pan; two fingers do not zoom about their midpoint or pan with it.
// - A trackpad or touchscreen pinch (Chromium's Ctrl+wheel) zooms at a different rate than the fingers moved.
// - Plain scrolling ignores the "Scrolling on the field" preference (Pans on a Mac by default, Zooms when chosen).
// - A long press then drag, which a touchscreen Mac sends as a right-button drag, does not move a waypoint, or opens
//   a menu.
// - Hover-only row controls stay hidden after a touch press.
// - A long press beside a waypoint (not on it) cannot grab it; Undo leaves a long-press drag behind.
// - Chromium's own trackpad pinch (synthesized as a mouse-source pinch gesture) zooms the wrong way or not at all.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = process.env.BORDEAUX_FIELD_TOUCH_UI_OUTPUT;
app.setPath('userData', path.join(output, 'user-data'));
let win, saved, dbg;
const errors = [], robotCalls = [], checks = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true);
async function wait(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(75); } throw Error('Timed out: ' + label); }
async function focusWindow() {
  app.focus({ steal: true }); win.focus(); win.webContents.focus();
  await wait(() => evaluate(() => document.hasFocus()), 'renderer keyboard focus');
}
async function snapshot(name) { await delay(150); await fs.writeFile(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
ipcMain.handle('branches:restore', () => ({ project: saved }));
ipcMain.handle('branches:catalog', () => ({ catalog: { projectName: 'Fixture', commands: [], warnings: [] }, bookmarkId: 'fixture' }));
ipcMain.handle('branches:save', (_event, project) => { saved = project; return { saved: true }; });
ipcMain.handle('branches:robot-call', (_event, name) => { robotCalls.push(name); throw Error('Robot transport is not available in this check'); });

const touchPoint = (p, id) => ({ x: p.x, y: p.y, id, radiusX: 9, radiusY: 9, force: 1 });
const touch = (type, points) => dbg.sendCommand('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => touchPoint(p, p.id ?? i)) });
async function touchDrag(from, to, steps = 8) {
  await touch('touchStart', [from]);
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', [{ x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps }]);
    await delay(16);
  }
  await touch('touchEnd', []);
  await delay(250);
}
// CDP modifiers: Alt 1, Ctrl 2, Meta 4, Shift 8.
const wheel = (point, deltaX, deltaY, modifiers = 0) => dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX, deltaY, modifiers });
async function key(keyCode, modifiers = []) {
  await focusWindow();
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await delay(200);
}
async function press(point) {
  await focusWindow();
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
  await delay(250);
}
const centerOf = (selector, text) => evaluate((selector, text) => {
  const item = [...document.querySelectorAll(selector)].find((el) => (!text || el.textContent.trim() === text) && el.getClientRects().length);
  const r = item.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
}, selector, text);

const viewBox = () => evaluate(() => { const b = document.querySelector('.fieldsvg').viewBox.baseVal; return { x: b.x, y: b.y, w: b.width, h: b.height }; });
// By waypoint index, from the drawn square: the selected waypoint is drawn last, so document order is not path order, and
// each waypoint also has a larger transparent hit circle.
const waypoints = () => evaluate(() => [...document.querySelectorAll('.fieldsvg rect[data-role="wp"]')]
  .sort((a, b) => Number(a.dataset.idx) - Number(b.dataset.idx)).map((el) => {
    const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }));
const selectedWaypoint = () => evaluate(() => [...document.querySelectorAll('.pt-wp')].findIndex((el) => el.classList.contains('selected')));
// The field-image point under a screen point, through the SVG's current transform.
const toField = (p) => evaluate((p) => {
  const svg = document.querySelector('.fieldsvg'), pt = svg.createSVGPoint(); pt.x = p.x; pt.y = p.y;
  const u = pt.matrixTransform(svg.getScreenCTM().inverse()); return { x: u.x, y: u.y };
}, p);
const lastWheel = () => evaluate(() => window.__lastFieldWheel);
const near = (a, b, tolerance, label) => assert.ok(Math.abs(a - b) <= tolerance, `${label}: ${a} vs ${b}`);
const fit = async () => { await press(await centerOf('[aria-label="Fit field to view"]')); await delay(200); };

app.whenReady().then(async () => {
  try {
    const corpus = JSON.parse(await fs.readFile('benchmarks/planner-corpus/v3/corpus.bordeaux.json', 'utf8'));
    const first = structuredClone(corpus.paths.find((p) => p.id === 'corpus-neutral-stop'));
    const original = { ...corpus, schemaVersion: '1.1', paths: [first], pathLinks: [], routines: [], editor: { activePathId: first.id, unitSystem: 'metric' } };
    win = new BrowserWindow({ show: true, width: 1440, height: 900, useContentSize: true, webPreferences: { preload: path.join(__dirname, 'verify-command-branches-ui-preload.cjs'), sandbox: false, contextIsolation: true, backgroundThrottling: false } });
    win.webContents.on('console-message', (details) => { if (details.level === 'error' && !details.message.startsWith("Loading the font 'data:")) errors.push(details.message); });
    dbg = win.webContents.debugger;
    dbg.attach('1.3');

    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      saved = structuredClone(original);
      win.setContentSize(width, height);
      await win.loadFile(path.resolve('dist-renderer/index.html'));
      await focusWindow();
      await wait(() => evaluate(() => document.querySelectorAll('.pt-wp').length > 2 && document.querySelector('.fieldcol')?.dataset.planningReady === 'true'), 'editable path');
      if (process.env.FIELD_TOUCH_DEBUG) await evaluate(() => { window.__ptrLog = []; for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mousemove']) window.addEventListener(t, (e) => window.__ptrLog.push([t, e.pointerType, Math.round(e.clientX), Math.round(e.clientY), e.button, e.target.getAttribute?.('data-role')]), true); });
      await evaluate(() => { window.addEventListener('wheel', (e) => { window.__lastFieldWheel = { deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, ctrlKey: e.ctrlKey }; }, { capture: true }); });

      // A finger 12 px beside waypoint 1 grabs it and drags it, keeping the grab offset; one Undo puts it back.
      const before = await waypoints(), wp = before[1];
      const finger = { x: Math.round(wp.x + 12), y: Math.round(wp.y + 5) }, vb0 = await viewBox();
      await touchDrag(finger, { x: finger.x + 70, y: finger.y + 40 });
      const moved = await waypoints();
      if (process.env.FIELD_TOUCH_DEBUG) console.log(JSON.stringify({ before, finger, moved, log: await evaluate(() => window.__ptrLog) }));
      near(moved[1].x - wp.x, 70, 2.5, 'Waypoint follows the finger in x'); near(moved[1].y - wp.y, 40, 2.5, 'Waypoint follows the finger in y');
      assert.deepEqual(await viewBox(), vb0, 'Dragging a waypoint does not pan the field');
      assert.equal(await selectedWaypoint(), 1, 'The dragged waypoint is selected');
      assert.equal(await evaluate(() => document.documentElement.dataset.input), 'touch', 'A touch press marks touch input');
      assert.equal(await evaluate(() => getComputedStyle(document.querySelector('.library-more')).opacity), '1', 'Hover-only row controls show after a touch press');
      await snapshot(`touch-drag-${width}`);
      await key('z', ['meta']);
      await wait(async () => { const now = await waypoints(); return Math.hypot(now[1].x - wp.x, now[1].y - wp.y) < 0.5; }, 'one Undo restores the touch drag');
      checks.push(`${width}: finger beside a waypoint drags it with its grab offset; one Undo`);

      // A tap beside waypoint 2 with a little jitter selects it and moves nothing.
      const tapAt = { x: Math.round(before[2].x - 10), y: Math.round(before[2].y + 8) };
      await touch('touchStart', [tapAt]); await touch('touchMove', [{ x: tapAt.x + 3, y: tapAt.y - 2 }]); await touch('touchEnd', []);
      await delay(250);
      assert.equal(await selectedWaypoint(), 2, 'A tap beside a waypoint selects it');
      const afterTap = await waypoints();
      near(afterTap[2].x, before[2].x, 0.5, 'A tap does not nudge x'); near(afterTap[2].y, before[2].y, 0.5, 'A tap does not nudge y');
      checks.push(`${width}: a jittery tap selects without moving`);

      // One finger on empty field pans it.
      const field = await evaluate(() => { const r = document.querySelector('.fieldsvg').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
      // Empty field the finger really hits, clear of handles and of whatever overlays the field at this size.
      const empty = await evaluate(() => {
        const svg = document.querySelector('.fieldsvg'), r = svg.getBoundingClientRect();
        const handles = [...svg.querySelectorAll('[data-role]:not([data-role="bg"])')].map((el) => el.getBoundingClientRect());
        for (let fy = 0.8; fy > 0.2; fy -= 0.05) for (let fx = 0.3; fx < 0.8; fx += 0.05) {
          const x = Math.round(r.x + r.width * fx), y = Math.round(r.y + r.height * fy);
          const hit = document.elementFromPoint(x, y);
          if (hit?.getAttribute('data-role') !== 'bg' || !svg.contains(hit)) continue;
          if (handles.every((b) => x < b.left - 40 || x > b.right + 40 || y < b.top - 40 || y > b.bottom + 40)) return { x, y };
        }
        return null;
      });
      assert.ok(empty, 'An empty stretch of field to pan from');
      const emptyField = await toField(empty);
      await touchDrag(empty, { x: empty.x + 60, y: empty.y - 50 });
      const panned = await viewBox();
      if (process.env.FIELD_TOUCH_DEBUG) console.log('PAN', JSON.stringify({ empty, emptyField, vb0, panned, log: (await evaluate(() => window.__ptrLog)).slice(-12) }));
      assert.equal(panned.w, vb0.w, 'One-finger pan keeps the zoom');
      const followed = await toField({ x: empty.x + 60, y: empty.y - 50 });
      near(followed.x, emptyField.x, 1, 'The field point stays under the finger (x)'); near(followed.y, emptyField.y, 1, 'The field point stays under the finger (y)');
      checks.push(`${width}: one finger on empty field pans with the finger`);

      // Two fingers spreading from 120 to 240 px zoom 2x about their midpoint, which also pans with them.
      const c = { x: Math.round(field.x + field.w * 0.45), y: Math.round(field.y + field.h * 0.5) };
      const under = await toField(c), w0 = (await viewBox()).w;
      await touch('touchStart', [{ x: c.x - 60, y: c.y, id: 0 }]);
      await touch('touchStart', [{ x: c.x - 60, y: c.y, id: 0 }, { x: c.x + 60, y: c.y, id: 1 }]);
      for (let i = 1; i <= 8; i++) {
        const spread = 60 + 60 * i / 8, shift = 20 * i / 8;
        await touch('touchMove', [{ x: c.x + shift - spread, y: c.y, id: 0 }, { x: c.x + shift + spread, y: c.y, id: 1 }]);
        await delay(20);
      }
      await delay(60);
      await touch('touchEnd', []);
      await delay(250);
      const pinched = await viewBox(), stillUnder = await toField({ x: c.x + 20, y: c.y });
      near(pinched.w, w0 / 2, w0 * 0.01, 'Pinch zooms by the spread');
      near(stillUnder.x, under.x, 1.5, 'The pinched point stays under the fingers (x)'); near(stillUnder.y, under.y, 1.5, 'The pinched point stays under the fingers (y)');
      await snapshot(`pinch-${width}`);
      checks.push(`${width}: two-finger pinch zooms about and pans with the midpoint`);

      // A trackpad or touchscreen pinch: Ctrl+wheel with deltaY = -100·ln(scale) zooms by exactly that scale.
      await fit();
      const w1 = (await viewBox()).w;
      await wheel(c, 0, -100 * Math.log(1.25), 2);
      await wait(async () => (await viewBox()).w !== w1, 'Ctrl+wheel zoom');
      const pinchEvent = await lastWheel();
      assert.equal(pinchEvent.ctrlKey, true, 'The pinch arrives as a Ctrl+wheel');
      near((await viewBox()).w, w1 * Math.exp(pinchEvent.deltaY / 100), 0.01, 'Ctrl+wheel zooms by exp(deltaY/100)');
      checks.push(`${width}: Ctrl+wheel pinch zooms at the fingers' rate`);

      // Chromium's trackpad pinch path, end to end: a mouse-source pinch to 1.5x zooms in by about that much.
      await fit();
      const w2 = (await viewBox()).w;
      await dbg.sendCommand('Input.synthesizePinchGesture', { x: c.x, y: c.y, scaleFactor: 1.5, relativeSpeed: 400, gestureSourceType: 'mouse' });
      await wait(async () => (await viewBox()).w < w2 * 0.8, 'synthesized trackpad pinch zooms in');
      near(w2 / (await viewBox()).w, 1.5, 0.08, 'A trackpad pinch to 1.5x zooms the field 1.5x');
      checks.push(`${width}: Chromium's own trackpad pinch zooms the field by the pinch scale`);

      // Plain scrolling pans by default on a Mac, and zooms once the preference says so.
      await fit();
      const vb1 = await viewBox(), ppu = await evaluate(() => document.querySelector('.fieldsvg').getScreenCTM().a);
      await wheel(c, 30, 40);
      await wait(async () => (await viewBox()).x !== vb1.x, 'plain scroll pans');
      const scrollEvent = await lastWheel(), vb2 = await viewBox();
      assert.equal(vb2.w, vb1.w, 'Plain scrolling keeps the zoom by default on a Mac');
      near(vb2.x - vb1.x, scrollEvent.deltaX / ppu, 0.01, 'Scroll pans x'); near(vb2.y - vb1.y, scrollEvent.deltaY / ppu, 0.01, 'Scroll pans y');
      await press(await centerOf('.app-settings-trigger'));
      await wait(() => evaluate(() => document.querySelector('.app-settings')?.open), 'global settings');
      await snapshot(`settings-${width}`);
      await press(await centerOf('.app-settings [aria-label="Scrolling on the field"] button', 'Zooms'));
      await key('Escape');
      await wait(() => evaluate(() => !document.querySelector('.app-settings')?.open), 'settings closed');
      await fit();
      const vb3 = await viewBox();
      await wheel(c, 0, 120);
      await wait(async () => (await viewBox()).w !== vb3.w, 'plain scroll zooms when chosen');
      assert.ok((await viewBox()).w > vb3.w, 'Scrolling down zooms out');
      assert.equal(await evaluate(() => localStorage.getItem('bordeaux.fieldScroll')), 'zoom', 'The preference is kept on this computer');
      await evaluate(() => localStorage.removeItem('bordeaux.fieldScroll'));
      checks.push(`${width}: plain scroll pans by default and zooms when chosen`);

      // Long press then drag (a right-button drag on a touchscreen Mac) beside a waypoint grabs it, keeps the grab offset,
      // moves it and opens no menu; one Undo puts it back.
      await fit();
      const right = (await waypoints())[1];
      const start = { x: Math.round(right.x + 16), y: Math.round(right.y - 6) }, end = { x: start.x - 50, y: start.y + 35 };
      win.webContents.sendInputEvent({ type: 'mouseMove', ...start });
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'right', clickCount: 1, ...start });
      for (let i = 1; i <= 6; i++) { win.webContents.sendInputEvent({ type: 'mouseMove', button: 'right', x: Math.round(start.x + (end.x - start.x) * i / 6), y: Math.round(start.y + (end.y - start.y) * i / 6), modifiers: ['rightButtonDown'] }); await delay(20); }
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'right', clickCount: 1, ...end });
      await delay(300);
      const dragged = (await waypoints())[1];
      near(dragged.x, start.x + (end.x - start.x) + (right.x - start.x), 2, 'Right-button drag moves x'); near(dragged.y, start.y + (end.y - start.y) + (right.y - start.y), 2, 'Right-button drag moves y');
      assert.equal(await evaluate(() => !!document.querySelector('[role="menu"]')), false, 'No menu opens for a long-press drag');
      assert.equal(await evaluate(() => document.documentElement.dataset.input), 'mouse', 'A mouse press marks mouse input');
      await key('z', ['meta']);
      await wait(async () => { const now = (await waypoints())[1]; return Math.hypot(now.x - right.x, now.y - right.y) < 0.5; }, 'one Undo restores the long-press drag');
      checks.push(`${width}: right-button (long-press) drag beside a waypoint moves it without a menu; one Undo`);
    }
    assert.deepEqual(robotCalls, []);
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ checks, errors }, null, 2));
    console.log(checks.map((c) => 'ok ' + c).join('\n'));
    app.exit(0);
  } catch (error) {
    console.error(error.stack || error); console.error(errors);
    if (win) await snapshot('failure').catch(() => undefined);
    app.exit(1);
  }
});
