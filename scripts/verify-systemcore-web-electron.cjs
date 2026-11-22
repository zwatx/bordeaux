// Drives the SystemCore web build as a plain browser page (no preload) through save, restore, autosave and push.
// Run through verify-systemcore-web.mjs, which supplies the URL and the artifact folder.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const url = process.env.BORDEAUX_SYSTEMCORE_URL;
const output = process.env.BORDEAUX_SYSTEMCORE_OUTPUT;
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
