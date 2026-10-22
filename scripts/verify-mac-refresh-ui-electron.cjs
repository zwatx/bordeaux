// Integrated renderer-only coverage. Persistence replies are isolated mocks;
// projectFolder.test.ts exercises real directory/file writes independently.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const output = process.env.BORDEAUX_MAC_REFRESH_OUTPUT;
app.setPath('userData', path.join(output, 'user-data'));
let win, fixture, saved, location = null, cancelFolder = false, releaseFolder;
const autosaves = [], saves = [], checks = [], frames = [], errors = [];
const folder = path.join(output, 'mock-project-folder');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true);
async function wait(fn, label) { for (let i = 0; i < 180; i++) { if (await fn()) return; await delay(50); } throw new Error('Timed out: ' + label); }
async function pointer(selector, text) {
  const point = await evaluate((selector, text) => {
    const el = [...document.querySelectorAll(selector)].find((item) => text == null || item.textContent.trim().includes(text));
    if (!el || el.disabled || el.closest('[inert]')) throw new Error('Unavailable: ' + selector + ' ' + text);
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, selector, text);
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
  await delay(70);
}
async function key(keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await delay(40);
}
async function numeric(label, value) {
  const selector = await evaluate((label) => {
    const el = [...document.querySelectorAll('.rail-r label')].find((el) => el.textContent === label);
    if (!el) throw new Error('Missing numeric label: ' + label);
    return '#' + CSS.escape(el.htmlFor);
  }, label);
  await pointer(selector);
  // Hidden Electron windows have no native Edit menu accelerator; select the
  // focused text explicitly, then deliver real insertText/Enter events.
  await evaluate(() => document.activeElement.select());
  await win.webContents.insertText(String(value)); await key('Enter');
}
async function shot(name) { await fs.writeFile(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
function check(name) { checks.push(name); console.log('PASS ' + name); }
ipcMain.handle('refresh:restore', () => ({ project: fixture, location }));
ipcMain.handle('refresh:open-folder', () => {
  if (cancelFolder) return new Promise((resolve) => { releaseFolder = () => resolve(null); });
  location = { folderPath: folder, projectPath: null };
  return { project: fixture, location };
});
ipcMain.handle('refresh:save', (_event, project) => {
  saved = project; saves.push(project);
  location = { folderPath: folder, projectPath: path.join(folder, 'Refresh.bordeaux') };
  return { saved: true, location };
});
ipcMain.handle('refresh:autosave', async (_event, project) => {
  autosaves.push(project); saved = project;
  await delay(120); return { saved: Boolean(location), location };
});
app.whenReady().then(async () => {
  try {
    const corpus = JSON.parse(await fs.readFile(path.resolve('benchmarks/planner-corpus/v2/corpus.bordeaux.json'), 'utf8'));
    const source = corpus.paths.find((p) => p.id === 'corpus-neutral-stop');
    const paths = ['Original path', 'Follower path'].map((name, i) => {
      const p = { ...structuredClone(source), id: 'refresh-' + i, name, headingMode: 'targets', targets: [{ f: .45, deg: 35, anchor: 'param' }] };
      p.waypoints[0].positionLink = 'shared-launch';
      if (!i) p.waypoints[0].positionName = 'Shared launch point';
      return p;
    });
    fixture = { ...corpus, name: 'Refresh', paths, routines: [], pathFolders: [], pathLinks: [], editor: { activePathId: paths[0].id } };
    win = new BrowserWindow({ show: false, width: 1440, height: 900, useContentSize: true, webPreferences: { contextIsolation: true, sandbox: false, backgroundThrottling: false, preload: path.join(__dirname, 'verify-mac-refresh-ui-preload.cjs') } });
    win.webContents.on('console-message', (details) => { if (details.level === 'error' && !details.message.startsWith("Loading the font 'data:font/woff2")) errors.push(details.message); });
    await win.loadFile(path.resolve('dist-renderer/index.html'));
    win.webContents.focus();
    await wait(() => evaluate(() => document.querySelector('.library-pick[aria-current="true"] .library-name')?.textContent === 'Original path' && !document.querySelector('.fieldcol[data-planning-ready="false"]')), 'initial App');
    await wait(() => evaluate(() => document.querySelector('.library-save-status')?.textContent.includes('Choose a folder')), 'unsaved location');
    // Confirm is isolated here so cancel tests exercise the folder result boundary.
    await evaluate(() => { window.confirm = () => true; });
    await pointer('.library-location-folder');
    await wait(() => evaluate(() => document.querySelector('.library-save-status')?.textContent.includes('Autosave on')), 'folder autosave status');
    assert.equal(await evaluate(() => document.querySelector('.library-location-folder').title), folder);
    assert.ok(await evaluate(() => document.querySelector('.library-save-status').textContent.includes('Save project settings')));
    await pointer('.wpfeatrow:first-child .featselect');
    await numeric('X', '10.5');
    await wait(() => saved?.paths[0].waypoints[0].x === 10.5, 'edit reached autosave mock');
    assert.equal(saved.paths[1].waypoints[0].x, 10.5);
    await pointer('[aria-label="Save project"]');
    await wait(() => saves.length === 1, 'explicit Save');
    assert.ok(location.projectPath.endsWith('.bordeaux'));
    assert.ok(!location.projectPath.endsWith('.json'));
    assert.ok(await evaluate(() => !document.querySelector('.library-save-status').textContent.includes('Save project settings')));
    check('folder location and autosave status, edit autosave, and .bordeaux Save reply through App (mock persistence)');
    await shot('folder-saved-original-1440');
    await pointer('.library-pick', 'Follower path');
    await delay(350);
    await wait(() => evaluate(() => !document.querySelector('.fieldcol[data-planning-ready="false"]')), 'follower planning');
    await pointer('.wpfeatrow:first-child .featselect');
    assert.ok(await evaluate(() => document.querySelector('.wpfeatrow .featnm').textContent.includes('Shared launch point')));
    await numeric('X', '10.2');
    await wait(() => saved?.paths[1].waypoints[0].x === 10.2, 'follower update autosaved');
    assert.equal(saved.paths[0].waypoints[0].x, 10.2);
    await pointer('.sechead-toggle', 'Segments');
    assert.equal(await evaluate(() => document.querySelector('.segfeatrow .featnm').title), 'Shared launch point → Waypoint 1');
    await pointer('.sechead-toggle', 'Segments');
    check('named linked position propagates original to follower and follower to original through App edits, with named segment references');
    // Keep chooser pending beyond the debounce, then cancel: the queued save must survive.
    await numeric('X', '10.1'); cancelFolder = true;
    await pointer('.library-location-folder');
    await wait(() => Boolean(releaseFolder), 'pending folder chooser');
    await delay(1000); releaseFolder();
    await wait(() => saved?.paths[1].waypoints[0].x === 10.1, 'autosave after canceled folder chooser');
    assert.equal(saved.paths[0].waypoints[0].x, 10.1);
    check('canceling a folder chooser preserves pending edited autosave');
    await wait(() => evaluate(() => !document.querySelector('.fieldcol[data-planning-ready="false"]')), 'settled planning');
    await pointer('.sechead-toggle', 'Rotation targets');
    await pointer('.featselect:has(.featdot.n)', '35°');
    await wait(() => evaluate(() => !!document.querySelector('[aria-label="Anchor position"]')), 'rotation inspector');
    await evaluate(() => {
      window.refreshRotationSamples = [];
      window.refreshRotationObserver = new MutationObserver(() => window.refreshRotationSamples.push({ preparing: /Preparing/i.test(document.querySelector('.stage-plan')?.textContent || ''), selected: !!document.querySelector('[aria-label="Anchor position"]') && !!document.querySelector('.featselect[aria-pressed="true"] .featdot.n') }));
      window.refreshRotationObserver.observe(document.querySelector('.stage-plan').parentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    });
    await pointer('[aria-label="Anchor position"] button', 'Distance'); await delay(180);
    assert.equal(await evaluate(() => [...document.querySelectorAll('[aria-label="Anchor position"] button')].find((el) => el.textContent === 'Distance').getAttribute('aria-pressed')), 'true');
    await pointer('[aria-label="Anchor position"] button', 'Path %'); await delay(180);
    const rotation = await evaluate(() => { window.refreshRotationObserver.disconnect(); return window.refreshRotationSamples; });
    assert.ok(rotation.length > 0);
    assert.ok(rotation.every((sample) => !sample.preparing && sample.selected), JSON.stringify(rotation));
    check('rotation anchor conversion keeps inspector selection without a Preparing flash (DOM mutation observations)');
    for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height); await delay(150);
      for (const open of [true, false]) {
        await evaluate(() => {
          window.refreshFrames = []; window.refreshSampling = true;
          const sample = () => {
            const v = document.querySelector('.viewctl').getBoundingClientRect();
            const t = document.querySelector('.transport').getBoundingClientRect();
            const g = document.querySelector('.velgraph')?.getBoundingClientRect();
            window.refreshFrames.push({ open: !!g, view: { top: v.top, bottom: v.bottom }, transportTop: t.top, graphTop: g?.top });
            if (window.refreshSampling) requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        });
        await pointer('[aria-label="Telemetry graph"]');
        await delay(260);
        const sampled = await evaluate(() => { window.refreshSampling = false; return window.refreshFrames; });
        const changed = sampled.filter((frame) => frame.open === open);
        assert.ok(changed.length > 1, 'Capture first changed frame and settled frames');
        for (const frame of changed) assert.ok(frame.view.bottom <= Math.min(frame.transportTop, frame.graphTop ?? Infinity) + 1, JSON.stringify({ width, frame }));
        frames.push({ width, open, frames: sampled });
        await shot(`rotation-graph-${open ? 'open' : 'closed'}-${width}`);
      }
    }
    check('graph open/close first changed and settled animation frames keep view controls above telemetry at 1440 and 1100');
    for (const [width, height] of [[1440, 900], [1100, 720], [1100, 600]]) {
      win.setContentSize(width, height); await delay(100);
      await pointer('.places .place', 'Settings');
      const bounds = await evaluate(() => {
        const page = document.querySelector('.robotpage');
        const r = page.getBoundingClientRect();
        return { bottom: r.bottom, viewport: innerHeight, height: page.clientHeight, content: page.scrollHeight };
      });
      assert.ok(bounds.bottom <= bounds.viewport + 1, JSON.stringify(bounds));
      assert.ok(bounds.content > bounds.height, 'Settings fixture requires scrolling');
      // Deliver wheel input within the page, without scrollIntoView hiding layout failures.
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 500, y: 400 });
      win.webContents.sendInputEvent({ type: 'mouseWheel', x: 500, y: 400, deltaY: -5000, canScroll: true });
      await wait(() => evaluate(() => {
        const p = document.querySelector('.robotpage');
        return p.scrollTop + p.clientHeight >= p.scrollHeight - 2;
      }), 'wheel reaches Settings bottom');
      await shot(`settings-bottom-${width}x${height}`);
      // Tabbing through actual controls must reveal them inside the scroll viewport.
      await pointer('[aria-label="Robot width"]');
      const count = await evaluate(() => document.querySelectorAll('.robotpage input,.robotpage button').length);
      let lowest = 0;
      for (let i = 0; i < count; i++) {
        await key('Tab');
        const focus = await evaluate(() => {
          const el = document.activeElement, page = document.querySelector('.robotpage');
          if (!page.contains(el)) return null;
          const r = el.getBoundingClientRect(), p = page.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, pageTop: p.top, pageBottom: p.bottom, scroll: page.scrollTop };
        });
        if (!focus) break;
        assert.ok(focus.top >= focus.pageTop - 1 && focus.bottom <= focus.pageBottom + 1, JSON.stringify(focus));
        lowest = Math.max(lowest, focus.scroll);
      }
      assert.ok(lowest > 0, 'Keyboard focus scrolls to lower Settings controls');
      await pointer('.places .place', 'Paths');
      const scrollbar = await evaluate(() => {
        const outline = document.querySelector('.outline-scroll');
        return { color: getComputedStyle(outline).scrollbarColor, width: getComputedStyle(outline).scrollbarWidth };
      });
      assert.equal(scrollbar.color, 'rgb(48, 52, 59) rgba(0, 0, 0, 0)');
      assert.equal(scrollbar.width, 'thin');
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 245, y: height - 100 });
      win.webContents.sendInputEvent({ type: 'mouseWheel', x: 245, y: height - 100, deltaY: -100, canScroll: true });
      await delay(100);
      await shot(`outline-scrollbar-${width}x${height}`);
    }
    check('Settings wheel and keyboard scrolling and dark outline scrollbar at supported sizes and 600px height');
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ checks, mockPersistence: true, autosaveCount: autosaves.length, saveCount: saves.length, projectPath: location.projectPath, rotation, frames, errors }, null, 2));
    app.exit(0);
  } catch (error) {
    console.error(error.stack || error); console.error(errors);
    if (win) { console.error(JSON.stringify({ saved: saved?.paths?.map(p => p.waypoints[0].x), autosaves: autosaves.length })); await shot('failure').catch(() => undefined); await fs.writeFile(path.join(output, 'failure-dom.txt'), await evaluate(() => document.body.innerText)).catch(() => undefined); }
    app.exit(1);
  }
});
