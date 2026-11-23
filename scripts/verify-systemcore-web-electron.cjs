// Drives the SystemCore web build as a plain browser page (no preload) through save, restore, autosave and push.
// Run through verify-systemcore-web.mjs, which supplies the URL and the artifact folder.
const { app, BrowserWindow } = require('electron');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const url = process.env.BORDEAUX_SYSTEMCORE_URL;
const output = process.env.BORDEAUX_SYSTEMCORE_OUTPUT;
// Set only for a local server; an installed robot skips the checks that need its disk.
const home = process.env.BORDEAUX_SYSTEMCORE_HOME;
if (!url || !output) throw new Error('Run verify-systemcore-web.mjs');
app.setPath('userData', path.join(output, 'user-data'));

const report = { url, checks: [], errors: [] };
let win;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true);
async function wait(fn, label, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await evaluate(fn).catch(() => false)) return; await delay(100); }
  throw new Error('Timed out: ' + label);
}
async function click(selector, text) {
  await wait(new Function(`return [...document.querySelectorAll(${JSON.stringify(selector)})].some((el) => ${text == null ? 'true' : `el.textContent.trim() === ${JSON.stringify(text)}`} && !el.disabled)`), 'control ' + selector + ' ' + (text ?? ''));
  await evaluate((selector, text) => [...document.querySelectorAll(selector)].find((el) => (text == null || el.textContent.trim() === text) && !el.disabled).click(), selector, text ?? null);
  await delay(100);
}
const api = (route, body) => evaluate((route, body) => fetch(route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined).then((r) => r.json()), route, body ?? null);
// Dialogs fade between views; let the last frame paint before capturing evidence.
async function shot(name) { await delay(400); await fs.writeFile(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
function check(name, detail) { report.checks.push({ name, ...(detail ? { detail } : {}) }); console.log('PASS ' + name); }
// Records this page's project writes, so each step waits for its own commit, never for state an earlier run left.
async function watchCommits() {
  await evaluate(() => {
    if (window.__commits) return;
    const commits = window.__commits = { statuses: [], inFlight: 0 }, original = window.fetch;
    window.fetch = (...args) => {
      if (!String(args[0]).endsWith('/api/commit')) return original(...args);
      commits.inFlight++;
      return original(...args).then((response) => { commits.statuses.push(response.status); return response; }).finally(() => { commits.inFlight--; });
    };
  });
}
const commitsSettled = () => wait(() => window.__commits.inFlight === 0, 'project writes settled', 60_000);
async function save() {
  await watchCommits();
  const before = await evaluate(() => window.__commits.statuses.length);
  await click('.project-chip');
  await click('.project-menu [role="menuitem"][data-action="save"]');
  await wait(new Function(`return window.__commits.statuses.length > ${before} && window.__commits.inFlight === 0`), 'Save committed', 60_000);
  const statuses = await evaluate(() => window.__commits.statuses);
  if (statuses.some((status) => status !== 200)) throw new Error('A project write was refused: ' + JSON.stringify(statuses));
}
async function menuItem(label) {
  await click('.project-chip');
  await wait(new Function(`return [...document.querySelectorAll('.project-menu [role="menuitem"]')].some((el) => el.textContent.trim().startsWith(${JSON.stringify(label)}))`), 'menu item ' + label);
  await evaluate((label) => [...document.querySelectorAll('.project-menu [role="menuitem"]')].find((el) => el.textContent.trim().startsWith(label)).click(), label);
  await delay(200);
}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function editorReady() { await wait(() => Boolean(document.querySelector('.library-pick, .pt-wp')) && !document.querySelector('.fieldcol[data-planning-ready="false"]'), 'editor ready', 60_000); }

app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    // The desktop shares the inline-font CSP notice; it is not specific to the robot build.
    win.webContents.on('console-message', (details) => { if (details.level === 'error' && !details.message.startsWith("Loading the font 'data:font/woff2")) report.errors.push(details.message); });
    await win.loadURL(url);
    await editorReady();
    const platform = await evaluate(() => [window.bordeauxAPI?.platform, document.documentElement.dataset.platform]);
    if (platform[0] !== 'web' || platform[1] !== 'web') throw new Error('Robot host is not installed: ' + platform);
    report.secureContext = await evaluate(() => window.isSecureContext);
    if (report.secureContext && !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error('Expected plain http to be an insecure context');
    const before = await api('/api/info');
    await shot('01-opened');
    check('the robot serves the editor and installs its host', { lastProject: before.lastProject });

    const workspaceOf = async (name) => JSON.parse((await api(`/api/projects/${encodeURIComponent(name)}/workspace`)).contents);
    await save();
    const name = (await api('/api/info')).lastProject;
    let workspace = await workspaceOf(name);
    const sources = Object.keys(workspace.files);
    if (!sources.some((file) => file.endsWith('.path'))) throw new Error('Save wrote no path source: ' + JSON.stringify(sources));
    await shot('02-saved');
    check('Save writes the project folder on the robot', { project: name, sources, binaries: Object.keys(workspace.generatedFiles || {}) });

    if (!workspace.project.robot.driveModel) {
      // BDX needs a complete drivetrain model, as on the desktop; the source is kept regardless.
      if (Object.keys(workspace.generatedFiles || {}).length) throw new Error('BDX was written without a drivetrain model');
      await click('.place', 'Settings');
      await click('#robot-drive-motor');
      await click('#robot-drive-motor-listbox [data-value="rev-neo"]');
      await wait(new Function(`return fetch('/api/projects/${encodeURIComponent(name)}/workspace').then((r) => r.json()).then((w) => JSON.parse(w.contents).project.robot.driveModel?.motorId === 'rev-neo')`), 'autosaved motor preset', 30_000);
      await shot('03-motor-preset');
      check('a saved project without a drivetrain model keeps its source, and a Settings edit autosaves to the robot');
      await click('.place', 'Paths');
      await editorReady();
    }

    await save();
    workspace = await workspaceOf(name);
    if (!Object.keys(workspace.generatedFiles || {}).length) throw new Error('Save wrote no BDX: ' + JSON.stringify(workspace.files));
    check('Save builds BDX files in the browser and stores them with the project', { generatedFiles: workspace.generatedFiles });

    await commitsSettled();
    await win.loadURL(url);
    await editorReady();
    await watchCommits();
    const chip = await evaluate(() => document.querySelector('.project-chip')?.textContent.trim() || '');
    if (!chip.includes(name)) throw new Error(`Reload did not restore ${name}: ${chip}`);
    if (/not saved/i.test(chip)) throw new Error('The restored project shows a failed save: ' + chip);
    await shot('04-restored');
    check('reloading the page restores the last project from the robot', { chip });

    await click('.push-button');
    await wait(() => Boolean(document.querySelector('.rfp-view-files')), 'push review');
    const review = await evaluate(() => ({ destination: document.querySelector('.robot-push-dialog .rfp-body')?.textContent, files: [...document.querySelectorAll('.rfp-files li')].map((li) => li.textContent) }));
    await shot('05-push-review');
    await click('.robot-push-dialog button', 'Upload 1 path');
    await wait(() => document.querySelector('.rfp-view-done')?.textContent.includes('uploaded'), 'push verified');
    const done = await evaluate(() => document.querySelector('.rfp-view-done').textContent);
    await shot('06-push-done');
    check('Push copies the reviewed BDX into the robot code folder and verifies it', { review, done });
    await click('[aria-label="Close robot files"]');

    // A batch whose second destination can't be replaced stops before the first robot file changes.
    if (home) {
      const pushed = path.join(home, 'paths');
      const [first] = await fs.readdir(pushed);
      const firstBefore = sha256(await fs.readFile(path.join(pushed, first)));
      const prepared = await evaluate(async (name) => {
        const workspace = JSON.parse((await (await fetch(`/api/projects/${encodeURIComponent(name)}/workspace`)).json()).contents);
        const project = workspace.project, original = project.paths.find((item) => item.exportable !== false && item.waypoints.length >= 2);
        // The first file gets new bytes under its old name; the second is a new path.
        const moved = { ...original, waypoints: original.waypoints.map((point, index) => index === 0 ? { ...point, x: point.x + 0.05 } : point) };
        const second = { ...original, id: original.id + '-second', name: original.name + ' second' };
        const changed = { ...project, paths: project.paths.map((item) => item.id === original.id ? moved : item).concat(second) };
        const preview = await window.bordeauxAPI.prepareRobotFiles(changed, [original.id, second.id]);
        return { operationId: preview.operationId, files: preview.files.map((file) => ({ fileName: file.fileName, sha256: file.sha256 })) };
      }, name);
      if (prepared.files.length !== 2 || prepared.files[0].fileName !== first || prepared.files[0].sha256 === firstBefore) throw new Error('Unexpected two-file review: ' + JSON.stringify({ first, prepared }));
      if ((await fs.readdir(pushed)).length !== 1) throw new Error('Review alone changed the robot code folder');
      await fs.mkdir(path.join(pushed, prepared.files[1].fileName));
      const failure = await evaluate((operationId) => window.bordeauxAPI.confirmRobotFiles(operationId).then(() => 'pushed', (error) => String(error?.message || error)), prepared.operationId);
      await fs.rmdir(path.join(pushed, prepared.files[1].fileName));
      if (!/No robot files were replaced/.test(failure)) throw new Error('A failed batch did not say nothing was replaced: ' + failure);
      if (sha256(await fs.readFile(path.join(pushed, first))) !== firstBefore) throw new Error('A failed batch replaced ' + first);
      const left = (await fs.readdir(pushed)).filter((file) => file !== first);
      if (left.length) throw new Error('A failed batch left files behind: ' + left.join(', '));
      const replay = await evaluate((operationId) => window.bordeauxAPI.confirmRobotFiles(operationId).then(() => 'pushed', (error) => String(error?.message || error)), prepared.operationId);
      if (!/Review the selected files again/.test(replay)) throw new Error('A failed review could be confirmed again: ' + replay);
      check('a two-file push whose second destination fails replaces neither file, and the review cannot be replayed', { failure });
    }

    // New project: the robot keeps every project in one folder, so the form shows it and offers no picker.
    await menuItem('Projects…');
    await wait(() => Boolean(document.querySelector('.pj-sheet[open] .pj-list')), 'projects list');
    const listActions = await evaluate(() => [...document.querySelectorAll('.pj-sheet .pj-foot button')].map((button) => button.textContent.trim()));
    if (listActions.some((label) => /^Open (folder|file)/.test(label))) throw new Error('The robot offers a local folder or file picker: ' + listActions);
    const rows = await evaluate(() => [...document.querySelectorAll('.pj-sheet .pj-list .pj-name')].map((row) => row.textContent.trim()));
    if (rows.filter((row) => row === name).length !== 1) throw new Error('The open project is not listed exactly once: ' + JSON.stringify(rows));
    await shot('07-projects');
    await click('.pj-sheet .pj-foot button[data-action="new"]');
    await wait(() => Boolean(document.querySelector('.pj-new .pj-location[data-fixed]')) && !document.querySelector('#pj-location-value')?.textContent.includes('…'), 'new project form');
    const location = await evaluate(() => ({ value: document.querySelector('#pj-location-value').textContent.replace(/\u200e/g, ''), change: Boolean(document.querySelector('.pj-location-change')) }));
    if (location.change || !location.value.endsWith('/projects')) throw new Error('New project location is not the robot projects folder: ' + JSON.stringify(location));
    const created = `Robot check ${Date.now().toString(36)}`;
    await evaluate((value) => {
      const input = document.querySelector('#pj-new-name');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, created);
    await shot('08-new-project');
    await click('.pj-new button.primary', 'Create');
    await wait(new Function(`return !document.querySelector('.pj-sheet[open]') && (document.querySelector('.project-chip')?.textContent || '').includes(${JSON.stringify(created)})`), 'new project opened', 30_000);
    await editorReady();
    const listed = (await api('/api/projects')).map((item) => item.name);
    if (!listed.includes(created) || (await api('/api/info')).lastProject !== created) throw new Error('New project is not stored on the robot: ' + JSON.stringify(listed));
    await shot('09-new-project-open');
    check('New project creates and opens a project in the robot projects folder', { created, location: location.value });

    await commitsSettled();
    const statuses = await evaluate(() => window.__commits.statuses);
    if (statuses.some((status) => status !== 200)) throw new Error('A project write was refused after reload: ' + JSON.stringify(statuses));
    report.ok = true;
  } catch (error) {
    report.ok = false; report.failure = String(error?.stack || error);
    console.error(report.failure);
    if (win) await shot('failure').catch(() => undefined);
  } finally {
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    app.exit(report.ok ? 0 : 1);
  }
});
