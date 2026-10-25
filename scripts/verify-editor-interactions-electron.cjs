const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = process.env.BORDEAUX_BRANCH_UI_OUTPUT;
app.setPath('userData', path.join(output, 'user-data'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
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
async function key(keyCode, modifiers = []) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await delay(70); }
async function choose(name) { await click('#command-branch-output'); await click('[role="option"]', name); }
async function snapshot(name) { await fs.writeFile(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
ipcMain.handle('branches:restore', () => ({ project: saved }));
ipcMain.handle('branches:catalog', () => ({ catalog: { projectName: 'Fixture', commands: [], warnings: [] }, bookmarkId: 'fixture' }));
ipcMain.handle('branches:save', (_event, project) => { saved = project; saves++; return { saved: true }; });
async function save() { const before = saves; await click('.project-chip'); await click('[data-action="save"]'); await wait(() => saves > before, 'save'); }
const clock = () => evaluate(() => Number(document.querySelector('.pt-clock-now').textContent));
const playing = () => evaluate(() => document.querySelector('.pt-play').getAttribute('aria-label').startsWith('Pause'));
app.whenReady().then(async () => {
  try {
    const corpus = JSON.parse(await fs.readFile('benchmarks/planner-corpus/v2/corpus.bordeaux.json', 'utf8'));
    const first = structuredClone(corpus.paths.find(p => p.id === 'corpus-neutral-stop'));
    const second = structuredClone(first); second.id = 'link-destination'; second.name = 'A long destination path name with interior pickup and scoring points';
    second.waypoints.forEach(point => { point.y += 0.25; if (point.prevC) point.prevC.y += 0.25; if (point.nextC) point.nextC.y += 0.25; });
    saved = { ...corpus, paths: [first, second], pathLinks: [], editor: { activePathId: first.id, unitSystem: 'metric' } };
    const original = structuredClone(saved);
    win = new BrowserWindow({ show: true, width: 1440, height: 900, useContentSize: true, webPreferences: { preload: path.join(__dirname, 'verify-command-branches-ui-preload.cjs'), sandbox: false, contextIsolation: true, backgroundThrottling: false } });
    win.webContents.on('console-message', details => { if (details.level === 'error' && !details.message.startsWith("Loading the font 'data:")) errors.push(details.message); });
    await win.loadFile(path.resolve('dist-renderer/index.html')); win.focus(); win.webContents.focus();
    await wait(() => evaluate(() => document.querySelector('.fieldcol')?.dataset.planningReady === 'true'), 'planning');
    // Native Tab focus must not disable unrelated editor shortcuts.
    await click('.places .place', 'Paths'); await key('Tab');
    assert.equal(await evaluate(() => document.activeElement.textContent), 'Routines');
    await key('2');
    assert.equal(await evaluate(() => document.querySelector('[aria-label="Place waypoint"]').getAttribute('aria-pressed')), 'true');
    assert.equal(await evaluate(() => document.body.innerText.includes('next endpoint')), false);
    await click('.library-more'); await key('Escape'); await key('1');
    assert.equal(await evaluate(() => document.querySelector('[aria-label="Select / move"]').getAttribute('aria-pressed')), 'true');
    await click('.library-search'); await win.webContents.insertText('2gf');
    assert.equal(await evaluate(() => document.querySelector('.library-search').value), '2gf');
    await key('Escape');
    console.log('PASS Tab and library focus retain tool shortcuts; text input owns typing; endpoint hint removed');

    await click('.pt-wp[data-selection="wp:1"]');
    await click('.pt-play'); await delay(150);
    const beforeTime = await clock();
    const xId = await evaluate(() => [...document.querySelectorAll('.pp-body label')].find(label => label.textContent === 'X').htmlFor);
    await click('[id="' + xId + '"]');
    await key('Home'); await key('End', ['shift']);
    await win.webContents.insertText(String(first.waypoints[1].x + .1)); await key('Enter');
    assert.equal(await playing(), true, 'Editing does not pause playback');
    await delay(180); assert.ok(await clock() > beforeTime, 'Elapsed clock continues across the replan');
    await snapshot('playback-edit-1440');
    await click('.pt-play');
    await save(); assert.ok(Math.abs(saved.paths[0].waypoints[1].x - first.waypoints[1].x - .1) < 1e-8);
    await key('z', ['control']); await delay(150);
    assert.equal(await playing(), false, 'Undo/replanning does not resume a manual pause');
    console.log('PASS Native numeric path edit keeps playback advancing; manual pause survives replanning');

    for (const [width, height] of [[1440,900], [1100,720]]) for (const units of ['metric','imperial']) for (const inspector of [false,true]) {
      const captureKey = width + '-' + units + '-' + (inspector ? 'open' : 'closed');
      saved.editor.unitSystem = units;
      await win.loadFile(path.resolve('dist-renderer/index.html')); win.focus(); win.webContents.focus();
      win.setContentSize(width,height);
      await wait(() => evaluate(() => document.querySelector('.fieldcol')?.dataset.planningReady === 'true'), 'loaded points');
      await click('.pt-wp[data-selection="wp:1"]');
      if (inspector) await click('.pp-more');
      await click('#band-waypoint-link');
      assert.equal(await evaluate(() => document.querySelector('#link-source-point').value), '1');
      assert.equal(await evaluate(() => document.querySelector('.point-links .primary').disabled), true);
      await snapshot('links-empty-' + captureKey);
      await click('[data-link-target="link-destination:1"]');
      assert.equal(await evaluate(() => document.querySelector('.point-links .primary').disabled), false);
      assert.ok((await evaluate(() => document.querySelector('.point-links-review').textContent)).includes(units === 'metric' ? ' m' : ' ft'));
      await snapshot('links-review-' + captureKey);
      await click('.point-links .primary');
      assert.equal(await evaluate(() => document.activeElement.id), 'band-waypoint-link');
      await save();
      const a = saved.paths[0].waypoints[1], b = saved.paths[1].waypoints[1];
      assert.equal(a.positionLink, b.positionLink); assert.ok(a.positionLink);
      assert.equal(a.x,b.x); assert.equal(a.y,b.y); assert.equal(a.theta,original.paths[0].waypoints[1].theta);
      await key('z', ['control']); await save();
      assert.equal(saved.paths[0].waypoints[1].positionLink, undefined, 'One Undo removes the complete link');
      await key('z', ['control','shift']); await save();
      assert.equal(saved.paths[0].waypoints[1].positionLink,saved.paths[1].waypoints[1].positionLink);
      await win.loadFile(path.resolve('dist-renderer/index.html')); win.focus(); win.webContents.focus();
      await wait(() => evaluate(() => document.querySelector('.fieldcol')?.dataset.planningReady === 'true'), 'reload');
      await click('.pt-wp[data-selection="wp:1"]'); await click('#band-waypoint-link');
      assert.ok((await evaluate(() => document.querySelector('.point-links-source').textContent)).includes(second.name));
      await snapshot('links-restored-' + captureKey);
      await click('.point-links-source .qbtn', 'Unlink this point');
      await key('Escape'); await save();
      assert.equal(saved.paths[0].waypoints[1].positionLink, undefined);
      assert.equal(saved.paths[0].waypoints[1].y, b.y, 'Unlink keeps position');
      await click('.library-more'); await click('[role="menuitem"]', 'Link points…');
      assert.equal(await evaluate(() => document.querySelector('#link-source-point').value), String(first.waypoints.length - 1));
      await click('#link-source-point'); await key('Home'); await key('Down'); await key('Enter');
      assert.equal(await evaluate(() => document.querySelector('#link-source-point').value), '1');
      await click('#link-point-search'); await win.webContents.insertText('no matching point');
      assert.ok((await evaluate(() => document.querySelector('.point-links-choices').textContent)).includes('No matching'));
      await snapshot('links-no-results-' + captureKey); await key('Escape');
      console.log('PASS ' + captureKey + ': interior linking, explicit review, Undo/Redo, save/reload, unlink, library entry, search and Escape');
      saved = structuredClone(original);
    }
    // The active path stays A while a library-origin link changes B; visible Undo must restore B.
    saved = structuredClone(original);
    await win.loadFile(path.resolve('dist-renderer/index.html')); win.focus(); win.webContents.focus();
    await wait(() => evaluate(() => document.querySelector('.fieldcol')?.dataset.planningReady === 'true'), 'inactive source fixture');
    await click('[aria-label="Actions for ' + second.name + '"]'); await click('[role="menuitem"]','Link points…');
    await click('[data-link-target="' + first.id + ':1"]'); await click('.point-links .primary'); await save();
    assert.ok(saved.paths[1].waypoints.at(-1).positionLink);
    await click('[title^="Undo"]'); await save();
    assert.equal(saved.paths[1].waypoints.at(-1).positionLink,undefined);
    assert.deepEqual(saved.paths[1].waypoints,original.paths[1].waypoints);
    console.log('PASS Library-origin linking of an inactive path is available to visible Undo');
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'passed', sizes: [[1440,900],[1100,720]], units: ['metric','imperial'] }));
  } catch (error) { console.error(error, errors); if (win) await snapshot('failure'); process.exitCode = 1; }
  finally { win?.destroy(); app.exit(process.exitCode || 0); }
});
