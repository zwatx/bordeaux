const { app, BrowserWindow, clipboard, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const output = process.env.BORDEAUX_PROJECT_UI_OUTPUT;
// Save failures come from a real read-only folder and main's own errno mapping, not from friendly fixture text.
const { withProjectWriteFact } = require('../dist-electron/shared/project/writeErrors.js');
const readOnlyFolder = path.join(output, 'read-only-project');
async function realWriteFailure() {
  try { await fs.writeFile(path.join(readOnlyFolder, '.bordeaux-workspace.json'), '{}'); } catch (error) { return withProjectWriteFact(error); }
  throw new Error('The read-only fixture folder accepted a write');
}
app.setPath('userData', path.join(output, 'user-data'));
let win, project, location = null, nextOpen = null, openFailure = false, saveMode = 'success', finishSave, dirty = false;
const calls = [], checks = [], errors = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Page exceptions come back with their message instead of Electron's generic "Script failed to execute".
const evaluate = async (fn, ...args) => {
  const result = await win.webContents.executeJavaScript(`(async () => { try { return { value: await (${fn.toString()})(...${JSON.stringify(args)}) }; } catch (error) { return { error: String(error && error.message || error) }; } })()`, true);
  if (result.error) throw new Error('Page: ' + result.error);
  return result.value;
};
async function wait(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(40); } throw new Error('Timed out: ' + label); }
async function pointer(selector) {
  await wait(() => evaluate((s) => { const el = document.querySelector(s); return el && !el.disabled && !el.closest('[inert]') && el.checkVisibility(); }, selector), selector);
  const point = await evaluate((s) => { const el = document.querySelector(s); el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2); if (!el.contains(document.elementFromPoint(x, y))) throw new Error('Obscured control: ' + s); return { x, y }; }, selector);
  for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
  await delay(80);
}
async function key(keyCode) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode }); if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await delay(80); }
// The chip is the save surface: its live region carries the current failure, so reading it needs no menu.
const status = () => evaluate(() => document.querySelector('.project-control [role="status"]')?.textContent || '');
// Retry or Retry BDX from the chip menu with the pointer; focus returns to the chip.
async function retryFromChip() {
  await pointer('.project-chip');
  await pointer('#project-menu [data-fix]');
  assert.equal(await evaluate(() => document.activeElement?.classList.contains('project-chip')), true, 'Retry returns focus to the chip');
}
// Opens the project chip's menu if needed and presses the item whose label starts with `label`.
async function projectAction(label) {
  if (!(await evaluate(() => !!document.querySelector('#project-menu')))) await pointer('.project-chip');
  const found = await evaluate((text) => {
    document.querySelectorAll('[data-harness-target]').forEach((item) => item.removeAttribute('data-harness-target'));
    const item = [...document.querySelectorAll('#project-menu [role="menuitem"]')].find((candidate) => candidate.textContent.startsWith(text));
    if (item) item.dataset.harnessTarget = '';
    return Boolean(item);
  }, label);
  assert.ok(found, 'Project action: ' + label);
  await pointer('[data-harness-target]');
}
async function openProjects() {
  await projectAction('Projects…');
  await wait(() => evaluate(() => !!document.querySelector('dialog.pj-sheet[open] .pj-search input')), 'Projects sheet');
}
async function pressRow(name) {
  await evaluate((text) => { const row = [...document.querySelectorAll('.pj-row')].find((item) => item.querySelector('.pj-name')?.textContent === text); row.querySelector('.pj-open').dataset.harnessTarget = ''; }, name);
  await pointer('.pj-row [data-harness-target]');
}
const sheetOpen = () => evaluate(() => !!document.querySelector('dialog.pj-sheet[open]'));
const check = (name) => { checks.push(name); console.log('PASS ' + name); };
async function screenshot(name) { await fs.writeFile(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
ipcMain.handle('fixture:restore', () => ({ project, location }));
ipcMain.handle('fixture:open', (_e, kind) => { calls.push(kind); if (openFailure) throw new Error('Cannot open the selected project folder.'); if (!nextOpen) return null; const result = nextOpen; nextOpen = null; project = result.project; location = result.location; return result; });
ipcMain.handle('fixture:reset', () => { throw new Error('New must not reset before folder selection'); });
ipcMain.handle('fixture:autosave', (_e, value) => { calls.push('autosave'); if (location) project = value; return { saved: !!location, location }; });
ipcMain.handle('fixture:save', (_e, value, saveAs) => {
  calls.push(saveAs ? 'save-as' : 'save'); project = value;
  if (saveMode === 'pending') return new Promise((resolve) => { finishSave = resolve; });
  if (saveMode === 'cancel') return { canceled: true };
  if (saveMode === 'failure') return realWriteFailure().then((error) => { throw error; });
  if (!location) location = { folderPath: '/fixture/My saved project', projectPath: '/fixture/My saved project/.bordeaux-workspace.json' };
  return { saved: true, location, ...(saveMode === 'error' ? { exportError: 'Project saved; BDX saving did not complete. Some BDX files may have been updated. Opening move has an invalid command. Correct the command and save again.', exportDetails: { cause: 'Opening move has an invalid command. Correct the command and save again.', partial: true } } : {}) };
});
ipcMain.on('fixture:dirty', (_e, value) => { dirty = value; });
ipcMain.handle('fixture:copyDetails', (event, text) => {
  assert.equal(event.sender, win.webContents);
  assert.equal(event.senderFrame, win.webContents.mainFrame);
  assert.ok(typeof text === 'string' && text.trim() && text.length <= 65_536);
  clipboard.writeText(text);
});
// Recents and creation through the typed project APIs; IDs are stable and creation never opens an existing folder.
let recents = [], lastCreate = null;
const at = (folderPath) => ({ folderPath, projectPath: folderPath + '/.bordeaux-workspace.json' });
ipcMain.handle('fixture:recents', () => { calls.push('recents'); return recents; });
ipcMain.handle('fixture:revealRecent', (_e, target) => { calls.push('reveal:' + JSON.stringify(target)); return { revealed: true }; });
ipcMain.handle('fixture:removeRecent', (_e, id) => { calls.push('remove:' + id); recents = recents.filter((entry) => entry.id !== id); return { removed: true }; });
ipcMain.handle('fixture:openRecent', (_e, id) => {
  calls.push('open:' + id);
  const entry = recents.find((candidate) => candidate.id === id);
  if (!entry) throw new Error('Recent project is no longer in the list');
  project = { ...project, name: entry.name }; location = entry.location;
  return { project, location };
});
ipcMain.handle('fixture:defaults', () => ({ parentDirectory: '/fixture/Documents/Bordeaux' }));
ipcMain.handle('fixture:chooseParent', () => { calls.push('choose-parent'); return null; });
ipcMain.handle('fixture:create', (_e, request) => {
  calls.push('create:' + request.name); lastCreate = request;
  if (request.name === 'Taken') throw new Error('That project folder already exists. Choose another name.');
  location = at(request.parentDirectory + '/' + request.name);
  // Fresh-project contents are covered by tests/projectCreation.test.ts; later checks here reuse these paths.
  project = { ...project, name: request.name };
  return { project, location };
});
app.whenReady().then(async () => {
  try {
    await fs.mkdir(readOnlyFolder, { recursive: true }); await fs.chmod(readOnlyFolder, 0o500);
    const corpus = JSON.parse(await fs.readFile(path.resolve('benchmarks/planner-corpus/v2/corpus.bordeaux.json'), 'utf8'));
    const source = corpus.paths.find((item) => item.id === 'corpus-neutral-stop');
    project = { ...corpus, name: 'Project folder workflow', paths: [{ ...source, id: 'opening', name: 'Opening move' }], routines: [], pathLinks: [], editor: { activePathId: 'opening' } };
    win = new BrowserWindow({ show: true, width: 1440, height: 900, useContentSize: true, webPreferences: { contextIsolation: true, sandbox: false, backgroundThrottling: false, preload: path.join(__dirname, 'verify-project-folder-ui-preload.cjs') } });
    win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    win.webContents.on('console-message', (details) => { if (details.level === 'error' && !details.message.startsWith("Loading the font 'data:font/woff2")) errors.push(details.message); });
    await win.loadFile(path.resolve('dist-renderer/index.html'));
    win.focus(); win.webContents.focus();
    await wait(() => evaluate(() => document.querySelector('.library-pick[aria-current="true"] .library-name')?.textContent === 'Opening move'), 'restore');
    await wait(() => evaluate(() => !!document.querySelector('.toolbar')), 'editor ready');
    await delay(250);
    await screenshot('choose-folder-1440');
    await openProjects();
    await pointer('[data-action="open-folder"]');
    assert.equal(calls.at(-1), 'new-folder');
    assert.equal(await evaluate(() => document.querySelector('.library-pick[aria-current="true"] .library-name').textContent), 'Opening move');
    assert.ok(await sheetOpen(), 'A cancelled folder pick keeps the Projects sheet');
    await key('Escape');
    check('Open folder… from Projects selects a folder and cancel preserves the project');
    win.webContents.send('fixture:menu', 'open-project'); await delay(150);
    assert.equal(calls.at(-1), 'folder');
    check('Native Open project folder… still uses the folder picker');
    const beforeNew = calls.length;
    win.webContents.send('fixture:menu', 'new-project');
    await wait(() => evaluate(() => document.activeElement?.id === 'pj-new-name'), 'New project name focused');
    assert.ok(!calls.slice(beforeNew).some((call) => call === 'new-folder' || call === 'folder'), 'New must not open the folder picker');
    await key('Escape');
    assert.equal(await sheetOpen(), false);
    assert.equal(await evaluate(() => document.querySelector('.library-pick[aria-current="true"] .library-name').textContent), 'Opening move');
    check('New opens the name sheet instead of the folder picker, and Escape changes nothing');
    openFailure = true;
    await openProjects();
    await pointer('[data-action="open-folder"]');
    await wait(() => evaluate(() => document.querySelector('.pj-block')?.textContent.includes('Cannot open the selected project folder')), 'opening failure shown');
    assert.equal(await status(), '', 'Opening errors are not save errors');
    await delay(1100);
    assert.ok(await evaluate(() => document.querySelector('.pj-block')?.textContent.includes('Cannot open')), 'Autosave must not clear opening errors');
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(100); await screenshot('open-failure-' + width);
    }
    win.setContentSize(1440, 900);
    const beforeOpenRetry = calls.length;
    openFailure = false;
    await pointer('.pj-block [data-fix="retry"]');
    await delay(150);
    assert.ok(calls.slice(beforeOpenRetry).includes('new-folder'), 'Retry reopens the folder picker');
    assert.ok(!calls.slice(beforeOpenRetry).includes('save'), 'Retry must not save the old project');
    await key('Escape');
    check('folder-opening failure shows in Projects; Retry repeats the actual picker and autosave does not clear it');
    await pointer('[aria-label="New path"]'); await key('Escape');
    await wait(async () => dirty, 'unsaved authored path');
    await evaluate(() => { window.discardPrompts = 0; window.confirm = () => { window.discardPrompts++; return false; }; });
    saveMode = 'cancel';
    await projectAction('Save');
    assert.equal(calls.at(-1), 'save');
    assert.equal(location, null);
    assert.equal(project.paths[0].name, 'Opening move');
    check('Choosing a first save folder preserves the draft on cancel');
    saveMode = 'failure';
    await projectAction('Save');
    await wait(async () => (await status()).endsWith('isn’t saved: Folder is read-only'), 'source save failure');
    await delay(1100);
    assert.ok((await status()).endsWith('isn’t saved: Folder is read-only'), 'Autosave must not hide an explicit save failure');
    assert.equal(await evaluate(() => document.querySelector('.project-chip').dataset.status), 'failed');
    await pointer('.project-chip');
    assert.ok(await evaluate(() => document.querySelector('.project-menu-fact').textContent === 'Not saved · Folder is read-only' && /EACCES|EPERM/.test(document.querySelector('.project-menu-fact span').title) && !document.querySelector('.project-menu-fact').hasAttribute('title')), 'A real errno reads as its fact, with the raw detail kept');
    await screenshot('save-failure-menu-1440');
    const previousClipboard = { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF() };
    const previousImage = clipboard.readImage();
    if (!previousImage.isEmpty()) previousClipboard.image = previousImage;
    try {
      await key('Home'); await key('Down'); await key('Down');
      assert.equal(await evaluate(() => document.activeElement?.dataset.action), 'copy-details', 'Copy details is keyboard reachable');
      await key('Enter');
      await wait(() => evaluate(() => document.querySelector('[data-action="copy-details"]')?.textContent === 'Copied'), 'native clipboard confirmation');
      assert.match(clipboard.readText(), /EACCES|EPERM/, 'Native clipboard contains the actual source failure');
      assert.ok(clipboard.readText().includes('Project folder workflow'), 'Copied detail identifies the project');
      assert.equal(await evaluate(() => !!document.querySelector('#project-menu')), true, 'Copy confirmation stays in the menu');
      assert.equal(await evaluate(() => document.activeElement?.dataset.action), 'copy-details', 'Copy keeps keyboard focus in the menu');
    } finally { clipboard.write(previousClipboard); }
    check('Copy details works with the native clipboard and keyboard');
    await key('Escape');
    // Keyboard: ArrowDown on the chip lands on Retry; Escape returns to the chip without retrying.
    const beforeKeys = calls.length;
    await key('Down');
    assert.equal(await evaluate(() => document.activeElement?.textContent), 'Retry');
    await key('Escape');
    assert.equal(calls.length, beforeKeys);
    const beforeRetry = calls.length;
    saveMode = 'success';
    await retryFromChip();
    await wait(async () => !(await status()), 'first folder saved');
    assert.ok(calls.slice(beforeRetry).includes('save'));
    assert.equal(project.paths[0].name, 'Opening move');
    assert.equal(project.paths.length, 2);
    assert.equal(await evaluate(() => window.discardPrompts), 0);
    assert.ok(await evaluate(() => document.querySelector('.project-chip').textContent.includes('My saved project')));
    check('Retry saves the current project without quitting or discarding it and names it after the folder');
    nextOpen = { project: { ...project, name: 'Autonomous paths and competition routines with a long project name', editor: { ...project.editor, unitSystem: 'imperial' } }, location: { folderPath: '/fixture/Autonomous paths and competition routines', projectPath: '/fixture/Autonomous paths and competition routines/.bordeaux-workspace.json' } };
    await openProjects();
    await pointer('[data-action="open-folder"]');
    await wait(async () => !(await sheetOpen()) && !(await status()), 'folder opened');
    await delay(1100);
    assert.equal(project.name, 'Autonomous paths and competition routines');
    saveMode = 'pending'; await projectAction('Save');
    assert.equal(await evaluate(() => document.querySelector('.project-chip').getAttribute('aria-busy')), 'true'); await screenshot('saving-1440');
    finishSave({ saved: true, location, exportError: 'Project saved; BDX saving did not complete. Some BDX files may have been updated. Opening move has an invalid command. Correct the command and save again.', exportDetails: { cause: 'Opening move has an invalid command. Correct the command and save again.', partial: true } });
    await wait(async () => (await status()).includes('saved; BDX files failed: Some BDX files may be out of date · Opening move has an invalid command'), 'export failure');
    assert.equal(dirty, false);
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(120);
      await pointer('.project-chip');
      assert.equal(await evaluate(() => document.querySelector('.project-menu-cause')?.textContent), 'Some BDX files may be out of date · Opening move has an invalid command');
      const bounds = await evaluate(() => { const r = document.querySelector('#project-menu').getBoundingClientRect(); return { bottom: r.bottom, right: r.right }; });
      assert.ok(bounds.bottom <= height && bounds.right <= width, 'BDX menu fits at ' + width);
      await screenshot('bdx-failure-' + width);
      await key('Escape');
    }
    check('Source save succeeds while BDX failure remains actionable');
    // A real new path edit schedules autosave; its success must retain the export error.
    await pointer('[aria-label="New path"]');
    await key('Escape');
    await delay(1200);
    assert.ok((await status()).includes('BDX files failed'));
    check('Background source autosave preserves the BDX failure');
    saveMode = 'success'; await retryFromChip();
    await wait(async () => !(await status()).includes('BDX'), 'retry succeeds');
    assert.equal(calls.at(-1), 'save');
    check('Retry BDX save regenerates through explicit Save');
    await pointer('.project-chip');
    assert.equal(await evaluate(() => document.activeElement.textContent.startsWith('Projects')), true);
    await key('Down'); await key('Down');
    assert.equal(await evaluate(() => document.activeElement.textContent.startsWith('Save')), true);
    await key('Enter');
    assert.equal(calls.at(-1), 'save');
    assert.equal(await evaluate(() => document.activeElement.classList.contains('project-chip')), true);
    await key('Space');
    await wait(() => evaluate(() => !!document.querySelector('#project-menu')), 'Space opens menu');
    await key('Escape');
    assert.equal(await evaluate(() => document.activeElement.classList.contains('project-chip')), true);
    await key('Down'); await key('End');
    assert.equal(await evaluate(() => document.activeElement.textContent.startsWith('Link robot code')), true);
    await key('Home'); await key('Tab');
    assert.equal(await evaluate(() => !!document.querySelector('#project-menu')), false);
    check('Project menu supports pointer, arrows, Enter, Space, Escape and Tab with focus return');
    saveMode = 'cancel'; await projectAction('Save copy…');
    assert.equal(calls.at(-1), 'save-as');
    win.webContents.send('fixture:menu', 'open-project-file'); await delay(120);
    assert.equal(calls.at(-1), 'file');
    check('Save As and explicit legacy project file commands remain separate');
    saveMode = 'failure'; win.webContents.send('fixture:menu', 'save-project-as');
    await wait(async () => (await status()).endsWith('Folder is read-only'), 'Save As failure');
    await pointer('.places .place:nth-child(3)');
    await pointer('.project-chip');
    assert.ok(await evaluate(() => document.querySelector('.project-menu-fact')?.textContent === 'Not saved · Folder is read-only'));
    await screenshot('settings-save-error');
    await key('Escape');
    await pointer('.places .place:first-child');
    check('Save failure details remain reachable from Settings');
    saveMode = 'success'; await retryFromChip();
    assert.equal(calls.at(-1), 'save-as');
    check('Retry preserves the Save As folder selection');
    recents = [
      { id: 'id-week2', name: 'Week 2 autos', folderHint: 'fixture/Week 2 autos', location: at('/fixture/Week 2 autos'), status: 'available' },
      { id: 'id-moved', name: 'Moved project', folderHint: 'Old laptop/Moved project', location: at('/Volumes/Old laptop/Moved project'), status: 'missing', code: 'not-found' },
    ];
    await openProjects();
    await wait(() => evaluate(() => document.querySelectorAll('.pj-row').length === 3), 'recent rows');
    assert.ok(await evaluate(() => document.querySelector('.pj-row[data-status="missing"] .pj-open').textContent.includes('Locate…')));
    await screenshot('projects-sheet');
    // Row actions: the … opens by pointer, right-click and Shift+F10; Escape closes only the menu and returns to its …;
    // an unavailable row offers only Remove from list; Show asks main by stable id; nothing is deleted.
    const menuItems = () => evaluate(() => [...document.querySelectorAll('#pj-row-menu [role="menuitem"]')].map((item) => item.textContent));
    const targetRow = (text, selector) => evaluate((name, inner) => {
      document.querySelectorAll('[data-harness-target]').forEach((item) => item.removeAttribute('data-harness-target'));
      [...document.querySelectorAll('.pj-row')].find((item) => item.querySelector('.pj-name')?.textContent === name).querySelector(inner).dataset.harnessTarget = '';
    }, text, selector);
    const show = process.platform === 'win32' ? 'Show in Explorer' : 'Show in Finder';
    await targetRow('Moved project', '.pj-more'); await pointer('.pj-row [data-harness-target]');
    await wait(async () => (await menuItems()).length > 0, 'unavailable row menu');
    assert.deepEqual(await menuItems(), ['Remove from list']);
    assert.equal(await evaluate(() => document.activeElement?.dataset.rowAction), 'remove', 'The menu focuses its first item');
    await key('Escape');
    assert.ok(await sheetOpen(), 'Escape closes only the row menu');
    assert.equal(await evaluate(() => document.activeElement?.matches('.pj-row[data-status="missing"] .pj-more')), true, 'Escape returns focus to the …');
    await targetRow('Week 2 autos', '.pj-name');
    const point = await evaluate(() => { const r = document.querySelector('[data-harness-target]').getBoundingClientRect(); return { x: Math.round(r.x + 8), y: Math.round(r.y + r.height / 2) }; });
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'right', clickCount: 1 });
    await wait(async () => (await menuItems()).length === 2, 'right-click row menu');
    assert.deepEqual(await menuItems(), [show, 'Remove from list']);
    await key('Escape');
    await targetRow('Week 2 autos', '.pj-open'); await evaluate(() => document.querySelector('[data-harness-target]').focus());
    for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'F10', modifiers: ['shift'] });
    await wait(async () => (await menuItems()).length === 2, 'keyboard row menu');
    await screenshot('projects-row-menu');
    const beforeReveal = calls.length;
    await key('Enter');
    await wait(() => calls.slice(beforeReveal).includes('reveal:{"id":"id-week2"}'), 'reveal by stable id');
    assert.ok(await sheetOpen(), 'Show keeps the sheet open');
    assert.equal(await evaluate(() => !document.querySelector('#pj-row-menu') && document.activeElement?.closest('.pj-row')?.querySelector('.pj-name')?.textContent), 'Week 2 autos');
    await targetRow('Moved project', '.pj-more'); await pointer('.pj-row [data-harness-target]');
    await pointer('#pj-row-menu [data-row-action="remove"]');
    await wait(() => evaluate(() => document.querySelectorAll('.pj-row').length === 2), 'removed from list');
    assert.ok(calls.includes('remove:id-moved') && !calls.some((call) => call.startsWith('reveal:{"id":"id-moved"')));
    check('Projects row … menu: pointer, right-click and Shift+F10; Show by id; Remove from list only for an unavailable row');
    const beforeRecent = calls.length;
    await pressRow('Week 2 autos');
    await wait(async () => !(await sheetOpen()), 'recent opened');
    assert.ok(calls.slice(beforeRecent).includes('open:id-week2'));
    assert.ok(await evaluate(() => document.querySelector('.project-chip').textContent.startsWith('Week 2 autos')));
    check('Projects opens a recent by stable id and the missing row offers Locate…');
    win.webContents.send('fixture:menu', 'new-project');
    await wait(() => evaluate(() => document.activeElement?.id === 'pj-new-name' && document.querySelector('.pj-location').title === '/fixture/Documents/Bordeaux'), 'New project ready');
    const nameSelected = () => evaluate(() => { const field = document.querySelector('#pj-new-name'); return document.hasFocus() && document.activeElement === field && field.selectionStart === 0 && field.selectionEnd === field.value.length; });
    await wait(nameSelected, 'new project name selected');
    await win.webContents.insertText('Taken');
    await wait(() => evaluate(() => document.activeElement?.value === 'Taken'), 'collision name typed'); await key('Enter');
    await wait(() => evaluate(() => document.querySelector('.pj-new-error')?.textContent === 'That project folder already exists'), 'collision error');
    assert.ok(await evaluate(() => document.activeElement.id === 'pj-new-name' && document.activeElement.selectionEnd === 'Taken'.length));
    assert.ok(await evaluate(() => document.querySelector('.project-chip').textContent.startsWith('Week 2 autos')), 'A failed create keeps the old project');
    await screenshot('new-collision');
    await wait(nameSelected, 'failed project name selected for replacement');
    await win.webContents.insertText('Week 5');
    await wait(() => evaluate(() => document.activeElement?.value === 'Week 5'), 'replacement name typed'); await key('Enter');
    await wait(async () => !(await sheetOpen()), 'project created');
    assert.equal(lastCreate.parentDirectory, '/fixture/Documents/Bordeaux');
    assert.deepEqual(Object.keys(lastCreate.template).sort(), ['constraints', 'robot']);
    assert.ok(await evaluate(() => document.querySelector('.project-chip').textContent.startsWith('Week 5')));
    check('New creates a named project in the default home; a collision keeps the old project and the name editable');
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(250);
      const toolbar = await evaluate(() => {
        const buttons = [...document.querySelectorAll('.toolbar .tb-actions > button, .toolbar > .keyboard-help-trigger')];
        return buttons.map((button) => {
          const rect = button.getBoundingClientRect();
          return { label: button.textContent, inset: button.matches('.optimizer-toggle,.keyboard-help-trigger'), left: rect.left, right: rect.right, height: rect.height, width: rect.width, clipped: button.scrollWidth > button.clientWidth, reachable: button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)) };
        });
      });
      for (const [index, button] of toolbar.entries()) {
        assert.ok(button.height >= (button.inset ? 32 : 40) && button.left >= 0 && button.right <= width, JSON.stringify(button));
        assert.equal(button.clipped, false, JSON.stringify(button));
        assert.ok(button.reachable, 'Toolbar control must be unobscured: ' + JSON.stringify(button));
        // The compact toolbar intentionally removes inter-button gaps; their hit areas must still stay separate.
        if (index) assert.ok(button.left >= toolbar[index - 1].right, 'Toolbar controls must not overlap: ' + JSON.stringify(toolbar));
      }
      assert.ok(toolbar.find((button) => button.label === 'Optimize').width >= 76, 'Optimize keeps its full labelled target at the compact width');
      // The full inspector opens from the docked properties' More.
      if (await evaluate(() => document.querySelector('.pp-more')?.getAttribute('aria-expanded') !== 'true')) await pointer('.pp-more');
      await screenshot('folder-ready-' + width);
      await pointer('.project-chip');
      const bounds = await evaluate(() => { const r = document.querySelector('#project-menu').getBoundingClientRect(); return { left: r.left, right: r.right, bottom: r.bottom }; });
      assert.ok(bounds.left >= 0 && bounds.right <= width && bounds.bottom <= height);
      assert.ok(await evaluate(() => document.querySelector('.project-menu-heading strong').textContent === document.querySelector('.project-chip-name').textContent));
      await screenshot('project-menu-' + width);
      await key('Escape');
    }
    await pointer('.keyboard-help-trigger'); await key('Escape');
    assert.equal(await evaluate(() => document.activeElement.getAttribute('aria-label')), 'Keyboard shortcuts');
    await pointer('[aria-label="Hide inspector"]');
    assert.equal(await evaluate(() => document.activeElement === document.querySelector('.pp-more')), true, 'Closing the inspector returns focus to More');
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(250); await screenshot('folder-ready-inspector-closed-' + width);
    }
    check('Toolbar spacing, keyboard focus and inspector layouts remain usable at supported sizes');
    await pointer('.places .place:nth-child(2)');
    await pointer('[aria-label="New routine"]');
    await wait(() => evaluate(() => document.activeElement.matches('.library-rename input')), 'new routine name focus');
    await key('Escape');
    await wait(() => evaluate(() => !document.querySelector('.library-rename') && document.activeElement.matches('.library-pick')), 'new routine name dismissed');
    for (const [selector, count] of [
      ['.routine-workspace-flow .rt-add', 1],
      ['.routine-workspace-flow .rt-list > .rt-addwrap .rt-add', 2],
    ]) {
      await pointer(selector);
      await wait(() => evaluate((s) => document.querySelector(s)?.getAttribute('aria-expanded') === 'true', selector), 'step chooser opened');
      assert.equal(await evaluate(() => document.activeElement.getAttribute('aria-label')), 'Find a path or step');
      await key('Enter');
      await wait(() => evaluate(() => document.activeElement.matches('.rt-step.sel > .rt-step-body')), 'inserted step receives focus');
      assert.equal(await evaluate(() => document.querySelectorAll('.routine-workspace-flow .rt-step').length), count);
    }
    // A on a focused row adds directly after it.
    const firstStep = await evaluate(() => document.querySelector('.routine-workspace-flow .rt-step').dataset.id);
    await pointer('.routine-workspace-flow .rt-step .rt-step-body'); await key('A');
    await wait(() => evaluate(() => document.activeElement.getAttribute('aria-label') === 'Find a path or step'), 'add-after search focused');
    await key('Enter');
    await wait(() => evaluate(() => document.activeElement.matches('.rt-step.sel > .rt-step-body')), 'inserted step receives focus');
    assert.equal(await evaluate(() => document.querySelectorAll('.routine-workspace-flow .rt-step').length), 3);
    assert.equal(await evaluate((first) => document.querySelectorAll('.routine-workspace-flow .rt-step')[1] === document.activeElement.closest('.rt-step') && document.querySelectorAll('.routine-workspace-flow .rt-step')[0].dataset.id === first, firstStep), true);
    check('First, after-row and end routine insertion focus the inserted step');
    await pointer('.places .place:first-child');
    await pointer('[aria-label="Actions for Opening move"]');
    await key('End'); await key('Enter');
    assert.equal(await evaluate(() => document.activeElement.matches('.library-blocked button')), true);
    await key('Escape');
    assert.equal(await evaluate(() => document.activeElement.dataset.libraryItem), 'opening');
    assert.equal(await evaluate(() => !!document.querySelector('.library-blocked')), false);
    check('Blocked deletion focuses recovery and Escape returns to the affected path');
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ checks, errors }, null, 2)); app.exit(0);
  } catch (error) { console.error(error); if (win) await screenshot('failure'); await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ checks, errors, failure: error.message }, null, 2)); app.exit(1); }
});
