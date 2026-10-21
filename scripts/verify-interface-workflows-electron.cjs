const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = process.env.BORDEAUX_BRANCH_UI_OUTPUT;
app.setPath('userData', path.join(output, 'user-data'));
let win, saved, saves = 0;
const errors = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true);
async function wait(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(75); } throw Error('Timed out: ' + label); }
async function click(selector, text) {
  const point = await evaluate((selector, text) => {
    const item = [...document.querySelectorAll(selector)].find((el) => !text || el.textContent.trim() === text || (el.getAttribute('role') === 'menuitem' && el.querySelector('span')?.textContent.trim() === text));
    if (!item || item.disabled) throw Error('Missing control: ' + selector + ' ' + text);
    item.scrollIntoView({ block: 'nearest' });
    const r = item.getBoundingClientRect(), x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    if (!item.contains(document.elementFromPoint(x, y))) throw Error('Obscured control: ' + selector);
    return { x, y };
  }, selector, text);
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, button: 'left', clickCount: 1, ...point });
  await delay(80);
}
async function key(keyCode) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode }); if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await delay(70); }
async function choose(name) { await click('#command-branch-output'); await click('[role="option"]', name); }
async function snapshot(name) { await fs.writeFile(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
ipcMain.handle('branches:restore', () => ({ project: saved }));
ipcMain.handle('branches:catalog', () => ({ catalog: { projectName: 'Fixture', commands: [], warnings: [] }, bookmarkId: 'fixture' }));
ipcMain.handle('branches:save', (_event, project) => { saved = project; saves++; return { saved: true }; });
async function save() { const before = saves; await click('.project-chip'); await click('[role="menuitem"][data-action="save"]'); await wait(() => saves > before, 'save'); }
app.whenReady().then(async () => {
  try {
    const corpus = JSON.parse(await fs.readFile('benchmarks/planner-corpus/v2/corpus.bordeaux.json', 'utf8'));
    const first = structuredClone(corpus.paths.find((p) => p.id === 'corpus-neutral-stop'));
    saved = { ...corpus, robot: { ...corpus.robot, w: 0.8128 }, paths: [first], pathLinks: [], routines: [{ id: 'route-test', name: 'Keyboard flow', nodes: [{ id: 'path-a', type: 'path', ref: first.id }, { id: 'path-b', type: 'path', ref: first.id }] }], activeRoutineId: 'route-test', editor: { activePathId: first.id, unitSystem: 'metric' } };
    win = new BrowserWindow({ show: true, width: 1440, height: 900, useContentSize: true, webPreferences: { preload: path.join(__dirname, 'verify-command-branches-ui-preload.cjs'), sandbox: false, contextIsolation: true, backgroundThrottling: false } });
    win.webContents.on('console-message', (details) => { if (details.level === 'error' && !details.message.startsWith("Loading the font 'data:")) errors.push(details.message); });
    await win.loadFile(path.resolve('dist-renderer/index.html'));
    win.focus(); win.webContents.focus();
    await wait(() => evaluate(() => document.querySelectorAll('.pt-wp').length > 0 && !document.querySelector('.fieldcol[data-planning-ready="false"]')), 'editable path');
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(120);
      const rect = () => evaluate(() => { const r = document.querySelector('.pp-more').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
      const beforePress = await rect();
      const point = { x: Math.round(beforePress.x + beforePress.width / 2), y: Math.round(beforePress.y + beforePress.height / 2) };
      assert.equal(await evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.pp-more'), point), true);
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
      await delay(100);
      assert.deepEqual(await rect(), beforePress, 'Path properties More must not shift while pressed');
      await snapshot('constraints-pressed-' + width);
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
      await delay(100);
      assert.deepEqual(await rect(), beforePress, 'Path properties More must not shift after click');
    }
    win.setContentSize(1440, 900); await delay(100);
    console.log('PASS Path properties More (the path limits entry point) remains fixed during mouse-down and after click at both supported sizes');
    await click('.pt-wp');
    // Paths is already the current place, so this only moves keyboard focus into the toolbar's places.
    await click('.places .place', 'Paths'); await key('Tab');
    assert.equal(await evaluate(() => document.activeElement.textContent.trim()), 'Routines');
    const before = structuredClone(first.waypoints);
    for (const k of ['Right', 'Delete', 'Backspace']) await key(k);
    await save(); assert.deepEqual(saved.paths[0].waypoints, before);
    await snapshot('editor-1440');
    console.log('PASS Keyboard-focused toolbar controls cannot nudge or delete the selected waypoint');
    await click('.places .place', 'Settings');
    await click('input[aria-label="Robot width"]');
    await key('Home'); win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'End', modifiers: ['shift'] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'End', modifiers: ['shift'] });
    await win.webContents.insertText('invalid'); await key('Enter');
    assert.equal(await evaluate(() => document.activeElement.getAttribute('aria-invalid')), 'true');
    await key('Escape'); await key('Enter'); await save();
    assert.equal(saved.robot.w, 0.8128);
    const unit = await evaluate(() => { const e = document.querySelector('input[aria-label="Robot width"]').nextElementSibling; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) }; });
    for (const button of ['left', 'right']) {
      win.webContents.sendInputEvent({ type: 'mouseDown', ...unit, button, clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseMove', x: unit.x + 30, y: unit.y });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: unit.x + 30, y: unit.y, button, clickCount: 1 });
    }
    await save(); assert.equal(saved.robot.w, 0.8128);
    await snapshot('settings-1440');
    console.log('PASS Robot numeric Escape/Enter preserves exact values and decoration drags cannot change dimensions');
    await click('.places .place', 'Paths');
    await click('.places .place', 'Routines'); await click('[data-library-item="route-test"]');
    await click('[data-id="path-a"] .rt-step-body'); await click('button[aria-label="Close step inspector"]');
    assert.equal(await evaluate(() => document.activeElement.closest('.rt-step')?.dataset.id), 'path-a');
    await click('.rt-add'); await key('Escape');
    assert.equal(await evaluate(() => document.activeElement.classList.contains('rt-add')), true);
    assert.equal(await evaluate(() => document.querySelector('.rt-add').getAttribute('aria-expanded')), 'false');
    // Add after a row (A) and Escape return focus to that row.
    await click('[data-id="path-a"] .rt-step-body'); await key('A');
    assert.equal(await evaluate(() => document.activeElement.getAttribute('aria-label')), 'Find a path or step');
    await key('Escape');
    assert.equal(await evaluate(() => document.activeElement.closest('.rt-step')?.dataset.id), 'path-a');
    // Explicit local deletion offers exact-target Undo; never exercise live robot transports.
    await evaluate(() => { window.__confirms = []; window.confirm = (message) => { window.__confirms.push(message); return true; }; });
    const assertStepNotice = async () => {
      const notice = await evaluate(() => {
        const footer = document.querySelector('.deletion-footer'), status = footer?.querySelector('[role="status"]'), button = footer?.querySelector('.deletion-notice button');
        return { copy: footer?.querySelector('.deletion-copy')?.textContent, detail: status?.textContent, polite: status?.getAttribute('aria-live'), atomic: status?.getAttribute('aria-atomic'), action: button?.getAttribute('aria-label'), enabled: Boolean(button && !button.disabled && button.getAttribute('aria-disabled') !== 'true'), confirms: window.__confirms };
      });
      assert.equal(notice.copy, 'Step deleted');
      assert.equal(notice.detail, 'Deleted “' + first.name + '”.');
      assert.equal(notice.polite, 'polite'); assert.equal(notice.atomic, 'true');
      assert.equal(notice.action, 'Undo: ' + notice.detail); assert.equal(notice.enabled, true);
      assert.deepEqual(notice.confirms, [], 'Step deletion offers Undo without a native confirmation');
    };
    await click('[data-id="path-a"] .rt-step-body'); await key('Delete');
    await assertStepNotice();
    assert.equal(await evaluate(() => document.activeElement.closest('.rt-step')?.dataset.id), 'path-b');
    await key('Delete');
    await assertStepNotice();
    assert.equal(await evaluate(() => document.activeElement.classList.contains('rt-add')), true);
    await key('Enter'); await key('Enter');
    console.log('PASS Routine close/delete and Escape on add-step choosers restore usable keyboard focus');
    await wait(() => evaluate(() => !!document.querySelector('button[aria-label="Play routine"]:not(:disabled)')), 'routine preview ready');
    await evaluate(() => document.querySelector('button[aria-label="Play routine"]').focus());
    await key('Tab');
    assert.equal(await evaluate(() => document.activeElement.classList.contains('rt-tp-scrub')), true);
    const focusStyle = await evaluate(() => getComputedStyle(document.querySelector('.rt-timeline-editor')).outlineStyle);
    assert.equal(focusStyle, 'solid', 'Routine scrubber needs a visible keyboard focus outline');
    await snapshot('routine-1440');
    win.setContentSize(1100, 720); await delay(100); await snapshot('routine-1100');
    await click('button[aria-label="Close step inspector"]'); await snapshot('routine-closed-1100');
    assert.deepEqual(errors, []);
    console.log('PASS Supported sizes and routine keyboard focus inspected; timeline outline: ' + focusStyle);
  } catch (error) { console.error(error, errors); if (win) await snapshot('failure'); process.exitCode = 1; }
  finally { win?.destroy(); app.exit(process.exitCode || 0); }
});
