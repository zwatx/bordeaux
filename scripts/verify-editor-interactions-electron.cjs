const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = process.env.BORDEAUX_BRANCH_UI_OUTPUT;
// A separate renderer build can be checked without replacing dist-renderer.
const rendererIndex = path.resolve(process.env.BORDEAUX_RENDERER_DIST || 'dist-renderer', 'index.html');
app.setPath('userData', path.join(output, 'user-data'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
let win, saved, saves = 0;
const errors = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true);
async function wait(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(75); } throw Error('Timed out: ' + label); }
async function click(selector, text) {
  let point;
  await wait(async () => {
    point = await evaluate((selector, text) => {
      const item = [...document.querySelectorAll(selector)].find((el) => !text || el.textContent.trim() === text || (el.getAttribute('role') === 'menuitem' && el.querySelector('span')?.textContent.trim() === text));
      if (!item || item.disabled) return null;
      item.scrollIntoView({ block: 'nearest' });
      const r = item.getBoundingClientRect(), x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
      if (!item.contains(document.elementFromPoint(x, y))) return null;
      return { x, y };
    }, selector, text);
    return Boolean(point);
  }, 'available control: ' + selector + ' ' + (text || ''));
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
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
    await win.loadFile(rendererIndex); win.focus(); win.webContents.focus();
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
    await wait(async () => await clock() > beforeTime, 'elapsed clock continues across the replan');
    await snapshot('playback-edit-1440');
    await click('.pt-play');
    await save(); assert.ok(Math.abs(saved.paths[0].waypoints[1].x - first.waypoints[1].x - .1) < 1e-8);
    await key('z', ['control']); await delay(150);
    assert.equal(await playing(), false, 'Undo/replanning does not resume a manual pause');
    console.log('PASS Native numeric path edit keeps playback advancing; manual pause survives replanning');

    for (const [width, height] of [[1440,900], [1100,720]]) for (const units of ['metric','imperial']) for (const inspector of [false,true]) {
      const captureKey = width + '-' + units + '-' + (inspector ? 'open' : 'closed');
      saved.editor.unitSystem = units;
      win.setContentSize(width,height);
      await win.loadFile(rendererIndex); win.focus(); win.webContents.focus();
      await wait(() => evaluate(() => document.querySelector('.fieldcol')?.dataset.planningReady === 'true'), 'loaded points');
      await evaluate(() => document.querySelector('.pt-wp[data-selection="wp:1"]').focus());
      await key('Enter');
      await wait(() => evaluate(() => document.querySelector('.pt-wp[data-selection="wp:1"]').getAttribute('aria-pressed') === 'true'), 'waypoint selected');
      if (inspector) await click('.pp-more');
      const sourceBefore = structuredClone(saved.paths[0].waypoints[1]);
      await click('#band-waypoint-link');
      // The source is the waypoint it was opened from; search owns focus.
      assert.equal(await evaluate(() => document.querySelector('#point-links-title').textContent), 'Link Waypoint 1');
      assert.equal(await evaluate(() => document.activeElement.id), 'link-point-search');
      assert.equal(await evaluate(() => document.querySelector('.point-links .primary').disabled), true);
      await snapshot('links-empty-' + captureKey);
      // Keyboard: ArrowDown enters the list, arrows move, Enter chooses and moves to the exact-scope action.
      await key('Down');
      assert.equal(await evaluate(() => document.activeElement.dataset.linkTarget), 'link-destination:0');
      await key('Down');
      assert.equal(await evaluate(() => document.activeElement.dataset.linkTarget), 'link-destination:1');
      assert.equal(await evaluate(() => document.querySelector('.point-links .primary').disabled), true, 'Focus alone does not choose');
      await key('Enter');
      await wait(() => evaluate(() => document.activeElement?.classList.contains('primary')), 'Enter moves to the link action');
      assert.equal(await evaluate(() => document.querySelector('[data-link-target="link-destination:1"]').getAttribute('aria-selected')), 'true');
      const review = await evaluate(() => document.querySelector('.pl-review').textContent);
      assert.ok(review.startsWith('Waypoint 1 moves'), review);
      assert.ok(review.includes(units === 'metric' ? ' m' : ' ft') && review.includes(second.name) && review.includes('stays where it is'), review);
      assert.equal(await evaluate(() => document.querySelector('.point-links .primary').textContent), 'Link point');
      await snapshot('links-review-' + captureKey);
      await key('Enter');
      await wait(() => evaluate(() => !document.querySelector('.point-links')), 'dialog closes after linking');
      assert.equal(await evaluate(() => document.activeElement.id), 'band-waypoint-link');
      assert.equal(await evaluate(() => document.querySelector('#band-waypoint-link').textContent), 'With 1 point…');
      await save();
      const a = saved.paths[0].waypoints[1], b = saved.paths[1].waypoints[1];
      assert.equal(a.positionLink, b.positionLink); assert.ok(a.positionLink);
      assert.equal(a.x,b.x); assert.equal(a.y,b.y); assert.equal(a.theta,original.paths[0].waypoints[1].theta);
      assert.equal(b.x, original.paths[1].waypoints[1].x, 'The destination stays in place');
      // Whole group: a linked point brings its group along, and the review and action say so.
      await click('#band-waypoint-link');
      assert.ok((await evaluate(() => document.querySelector('.pl-members').textContent)).includes(second.name));
      await click('[data-link-target="link-destination:0"]');
      assert.ok((await evaluate(() => document.querySelector('.pl-review').textContent)).startsWith('2 points move'));
      assert.equal(await evaluate(() => document.querySelector('.point-links .primary').textContent), 'Link 2 points');
      await snapshot('links-group-review-' + captureKey);
      await key('Escape');
      await wait(() => evaluate(() => !document.querySelector('.point-links')), 'Escape closes');
      assert.equal(await evaluate(() => document.activeElement.id), 'band-waypoint-link', 'Escape returns focus');
      await save(); assert.equal(saved.paths[1].waypoints[0].positionLink, undefined, 'Cancelled review changes nothing');
      await key('z', ['control']); await save();
      assert.equal(saved.paths[0].waypoints[1].positionLink, undefined, 'One Undo removes the complete link');
      assert.equal(saved.paths[0].waypoints[1].x, sourceBefore.x, 'Undo restores the source position');
      await key('z', ['control','shift']); await save();
      assert.equal(saved.paths[0].waypoints[1].positionLink,saved.paths[1].waypoints[1].positionLink);
      await win.loadFile(rendererIndex); win.focus(); win.webContents.focus();
      await wait(() => evaluate(() => document.querySelector('.fieldcol')?.dataset.planningReady === 'true'), 'reload');
      await evaluate(() => document.querySelector('.pt-wp[data-selection="wp:1"]').focus());
      await key('Enter');
      await wait(() => evaluate(() => document.querySelector('.pt-wp[data-selection="wp:1"]').getAttribute('aria-pressed') === 'true'), 'waypoint selected');
      // With the inspector open, its Linked position row is the entry; otherwise the band's Linked row.
      let entry = '#band-waypoint-link';
      if (inspector) {
        if (!await evaluate(() => [...document.querySelectorAll('.inrow-l')].some(row => row.textContent.startsWith('Linked position')))) await click('.pp-more');
        await wait(() => evaluate(() => [...document.querySelectorAll('.inrow-l')].some(row => row.textContent.startsWith('Linked position'))), 'inspector linked row');
        assert.ok((await evaluate(() => [...document.querySelectorAll('.inrow-l')].find(row => row.textContent.startsWith('Linked position')).textContent)).includes(second.name));
        await snapshot('links-inspector-' + captureKey);
        entry = '.choice-change';
        await click(entry, 'Manage…');
      } else await click(entry);
      assert.ok((await evaluate(() => document.querySelector('.pl-members').textContent)).includes(second.name));
      await snapshot('links-restored-' + captureKey);
      await click('.pl-members .qbtn', 'Unlink this point');
      await wait(() => evaluate(() => !document.querySelector('.pl-members')), 'unlinked');
      assert.ok((await evaluate(() => document.querySelector('.pl-review').textContent)).includes('is independent and stays at'));
      assert.equal(await evaluate(() => document.activeElement.id), 'link-point-search');
      await snapshot('links-unlinked-' + captureKey);
      await key('Escape');
      await wait(() => evaluate(() => !document.querySelector('.point-links')), 'closed after unlink');
      assert.equal(await evaluate(() => document.activeElement.id), inspector ? 'inspector-waypoint-link' : 'band-waypoint-link', 'Focus returns to the entry');
      await save();
      assert.equal(saved.paths[0].waypoints[1].positionLink, undefined);
      assert.equal(saved.paths[0].waypoints[1].y, b.y, 'Unlink keeps position');
      // The last waypoint opens the same dialog with End as its fixed source.
      const last = first.waypoints.length - 1;
      await evaluate((last) => document.querySelector('.pt-wp[data-selection="wp:' + last + '"]').focus(), last);
      await key('Enter');
      await wait(() => evaluate((last) => document.querySelector('.pt-wp[data-selection="wp:' + last + '"]').getAttribute('aria-pressed') === 'true', last), 'last waypoint selected');
      await click('#band-waypoint-link');
      assert.equal(await evaluate(() => document.querySelector('#point-links-title').textContent), 'Link End');
      await win.webContents.insertText('waypoint 1');
      await wait(() => evaluate(() => document.querySelectorAll('[data-link-target]').length === 1), 'search narrows by point name');
      await key('Down'); await key('Enter');
      assert.ok((await evaluate(() => document.querySelector('.pl-review').textContent)).startsWith('End moves'));
      await click('#link-point-search'); await evaluate(() => document.querySelector('#link-point-search').select()); await win.webContents.insertText('no matching point');
      await wait(() => evaluate(() => document.querySelector('#link-point-search').value === 'no matching point'), 'replaced search');
      await wait(() => evaluate(() => document.querySelector('.pl-list').textContent.includes('No points match')), 'no match');
      assert.equal(await evaluate(() => document.querySelector('.point-links .primary').disabled), true, 'A hidden destination is not linked');
      assert.equal(await evaluate(() => document.querySelector('.pl-review').textContent), 'Choose a point to see what moves.');
      await key('Enter');
      assert.ok(await evaluate(() => !!document.querySelector('.point-links')), 'Enter without a visible choice changes nothing');
      await snapshot('links-no-results-' + captureKey); await key('Escape');
      await wait(() => evaluate(() => !document.querySelector('.point-links')), 'closed');
      await save(); assert.equal(saved.paths[0].waypoints[last].positionLink, undefined);
      console.log('PASS ' + captureKey + ': keyboard linking, explicit and whole-group review, Undo/Redo, save/reload, inspector entry, unlink, last-point entry, search and Escape');
      saved = structuredClone(original);
    }
    // A selected very long destination and an existing long group must leave both footer actions visible.
    const nameOf = prefix => prefix + 'x'.repeat(5000 - prefix.length);
    saved = structuredClone(original);
    saved.paths[1].name = nameOf('Destination ');
    const member = structuredClone(saved.paths[0]); member.id = 'linked-member'; member.name = 'Linked member';
    member.waypoints[1].positionLink = 'long-name-group';
    Object.assign(saved.paths[0].waypoints[1], { positionLink: 'long-name-group', positionName: nameOf('Shared ') });
    saved.paths.push(member);
    win.setContentSize(1100, 720);
    await win.loadFile(rendererIndex); win.focus(); win.webContents.focus();
    await wait(() => evaluate(() => document.querySelector('.fieldcol')?.dataset.planningReady === 'true'), 'long-name project');
    await click('.pt-wp[data-selection="wp:1"]'); await click('#band-waypoint-link');
    // Several other paths: the dialog lists paths first and opens one in place.
    assert.equal(await evaluate(() => document.querySelectorAll('[data-link-target]').length), 0, 'Paths come before points');
    assert.deepEqual(await evaluate(() => [...document.querySelectorAll('[data-link-path]')].map(row => row.dataset.linkPath)), ['link-destination', 'linked-member']);
    await click('[data-link-path="link-destination"]');
    await wait(() => evaluate(() => document.activeElement?.dataset.linkTarget === 'link-destination:0'), 'opening a path focuses its first point');
    assert.ok(await evaluate(() => document.querySelector('.pl-crumb').title.startsWith('Back to all paths')));
    await key('Left');
    await wait(() => evaluate(() => document.activeElement?.dataset.linkPath === 'link-destination'), 'Left returns to the path it left');
    await key('Right');
    await wait(() => evaluate(() => document.activeElement?.dataset.linkTarget === 'link-destination:0'), 'Right opens the focused path');
    await click('[data-link-target="link-destination:1"]');
    const longReview = await evaluate(() => {
      const sheet = document.querySelector('.point-links'), bounds = sheet.getBoundingClientRect();
      const buttons = [...sheet.querySelectorAll('.pj-foot button')];
      return { title: sheet.querySelector('.pl-review-destination').title, group: sheet.querySelector('.pl-members h3').title,
        visible: buttons.every(button => {
          const r = button.getBoundingClientRect();
          return r.top >= bounds.top && r.bottom <= bounds.bottom
            && button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        }) };
    });
    assert.ok(longReview.title.includes(saved.paths[1].name));
    assert.equal(longReview.group, saved.paths[0].waypoints[1].positionName);
    assert.equal(longReview.visible, true, 'Full names remain available and both footer actions are reachable');
    await snapshot('links-long-name-review-1100');
    await click('.point-links .primary'); await save();
    assert.equal(saved.paths[0].waypoints[1].positionLink, saved.paths[1].waypoints[1].positionLink);
    console.log('PASS long destination and group names keep the link action visible and usable');
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'passed', sizes: [[1440,900],[1100,720]], units: ['metric','imperial'] }));
  } catch (error) { process.exitCode = 1; console.error(error, errors); if (win) { try { await snapshot('failure'); } catch (captureError) { console.error('Failure capture unavailable:', captureError); } } }
  finally { win?.destroy(); app.exit(process.exitCode || 0); }
});
