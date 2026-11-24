// Drives the SystemCore web build as a plain browser page (no preload) through save, restore, autosave, push and
// reading pushed files back.
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
async function save(whileMenuOpen) {
  await watchCommits();
  const before = await evaluate(() => window.__commits.statuses.length);
  await click('.project-chip');
  if (whileMenuOpen) await whileMenuOpen();
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

    // The page ships in the package, so the version it reports is the installed one. Updates come as a new ipk.
    await click('.place', 'Settings');
    await wait(() => [...document.querySelectorAll('.settings-row')].some((row) => row.querySelector('strong')?.textContent === 'Software updates'), 'software updates row');
    const shown = await evaluate(() => [...document.querySelectorAll('.settings-row')].find((row) => row.querySelector('strong')?.textContent === 'Software updates').querySelector('.settings-status').textContent);
    // A local server runs this checkout's build; an installed robot runs whatever version is installed.
    const expected = home ? 'Bordeaux ' + require('../package.json').version : null;
    if (expected ? shown !== expected : !/^Bordeaux \d+\.\d+\.\d+/.test(shown)) throw new Error(`Settings shows ${JSON.stringify(shown)}, expected ${expected ?? 'a version'}`);
    // Focus first, as a pointer click does, so the panel anchors under the button.
    await evaluate(() => { const button = [...document.querySelectorAll('.settings-row button')].find((el) => el.textContent.trim() === 'Check for updates'); button.focus(); button.click(); });
    await wait(() => document.querySelector('.app-update-dialog')?.open, 'update panel');
    const panel = await evaluate(() => ({ title: document.querySelector('#app-update-title').textContent, description: document.querySelector('.app-update-description')?.textContent,
      versions: document.querySelector('.app-update-versions').textContent, action: document.querySelector('.app-update-action')?.textContent ?? null }));
    if (panel.title !== 'Manual update available' || !panel.description?.includes('Add Package') || panel.action !== null || panel.versions !== 'Installed v' + shown.slice('Bordeaux '.length)) {
      throw new Error('Unexpected update panel: ' + JSON.stringify(panel));
    }
    // The hidden window paints the new panel late; give it time so the screenshot shows it.
    await delay(1500);
    await shot('01b-software-updates');
    await evaluate(() => document.querySelector('.app-update-dialog').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await wait(() => !document.querySelector('.app-update-dialog')?.open, 'update panel closed');
    check('Settings shows the installed version and points updates at the release ipk', { shown, panel });
    await click('.place', 'Paths');
    await editorReady();

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

    await click('.push-menu-trigger');
    const pushOptions = await evaluate(() => [...document.querySelectorAll('#push-menu [role="menuitem"]')].map((item) => item.textContent.trim()));
    if (!pushOptions.length || pushOptions.includes('Robot files…')) throw new Error('Unexpected robot-hosted Push options: ' + pushOptions.join(', '));
    await click('.push-menu-trigger');
    check('the robot-hosted editor keeps desktop comparison out of its Push menu');

    await click('.push-button');
    await wait(() => Boolean(document.querySelector('.rfp-view-files')), 'push review');
    const review = await evaluate(() => ({ destination: document.querySelector('.robot-push-dialog .rfp-body')?.textContent, files: [...document.querySelectorAll('.rfp-files li')].map((li) => li.textContent),
      fileNames: [...document.querySelectorAll('.rfp-files .rfp-file-meta')].map((meta) => meta.textContent.split(' · ')[0]) }));
    await shot('05-push-review');
    await click('.robot-push-dialog button', 'Upload 1 path');
    await wait(() => document.querySelector('.rfp-view-done')?.textContent.includes('uploaded'), 'push verified');
    const done = await evaluate(() => document.querySelector('.rfp-view-done').textContent);
    await shot('06-push-done');
    check('Push copies the reviewed BDX into the robot code folder and verifies it', { review, done });
    await click('[aria-label="Close robot files"]');

    // The page reads pushed files back by name, to compare them with the paths being edited.
    const [pushedName] = review.fileNames;
    if (!/\.bdx$/.test(pushedName || '')) throw new Error('The push review named no BDX file: ' + JSON.stringify(review));
    const reading = await evaluate((fileName) => window.bordeauxAPI.readRobotFiles([fileName, 'Never-pushed.bdx']).then((result) => ({
      directory: result.connection.endpoint.directory, readAt: result.readAt,
      files: result.files.map((file) => ({ fileName: file.fileName, bytes: file.contents && Array.from(file.contents) })) })), pushedName);
    const [held, absent] = reading.files;
    if (reading.files.length !== 2 || held.fileName !== pushedName || !held.bytes || absent.fileName !== 'Never-pushed.bdx' || absent.bytes !== null) {
      throw new Error('Unexpected read of the robot code folder: ' + JSON.stringify(reading.files.map((file) => [file.fileName, file.bytes && file.bytes.length])));
    }
    const readBack = Buffer.from(held.bytes);
    if (readBack.subarray(0, 8).toString('latin1') !== 'BDXLV1\r\n') throw new Error(pushedName + ' did not read back as a BDX');
    if (home && !readBack.equals(await fs.readFile(path.join(home, 'paths', pushedName)))) throw new Error(pushedName + ' read back other bytes than the robot code folder holds');
    await fs.writeFile(path.join(output, 'read-back-' + pushedName), readBack);
    check('the page reads the pushed BDX back as the robot holds it, and reports a path never pushed as absent',
      { fileName: pushedName, bytes: readBack.length, sha256: sha256(readBack), directory: reading.directory, readAt: reading.readAt });

    // A batch whose second destination can't be replaced stops before the first robot file changes.
    if (home) {
      const pushed = path.join(home, 'paths');
      const bdx = async () => (await fs.readdir(pushed)).filter((file) => file.endsWith('.bdx'));
      const [first] = await bdx();
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
      if ((await bdx()).length !== 1) throw new Error('Review alone changed the robot code folder');
      await fs.mkdir(path.join(pushed, prepared.files[1].fileName));
      const failure = await evaluate((operationId) => window.bordeauxAPI.confirmRobotFiles(operationId).then(() => 'pushed', (error) => String(error?.message || error)), prepared.operationId);
      await fs.rmdir(path.join(pushed, prepared.files[1].fileName));
      if (!/No robot files were replaced/.test(failure)) throw new Error('A failed batch did not say nothing was replaced: ' + failure);
      if (sha256(await fs.readFile(path.join(pushed, first))) !== firstBefore) throw new Error('A failed batch replaced ' + first);
      const left = (await fs.readdir(pushed)).filter((file) => file !== first && !file.endsWith('.json'));
      if (left.length) throw new Error('A failed batch left files behind: ' + left.join(', '));
      const replay = await evaluate((operationId) => window.bordeauxAPI.confirmRobotFiles(operationId).then(() => 'pushed', (error) => String(error?.message || error)), prepared.operationId);
      if (!/Review the selected files again/.test(replay)) throw new Error('A failed review could be confirmed again: ' + replay);
      check('a two-file push whose second destination fails replaces neither file, and the review cannot be replayed', { failure });

      // A BDX someone placed in the project over SSH is kept; the sources save and the chip reports the BDX.
      const owned = (await workspaceOf(name)).generatedFiles || {};
      const [bdxFile, bdxHash] = Object.entries(owned)[0] || [];
      if (!bdxFile) throw new Error('No generated BDX to test: ' + JSON.stringify(owned));
      const onDisk = path.join(home, 'projects', name, bdxFile), original = await fs.readFile(onDisk);
      await fs.writeFile(onDisk, 'placed over ssh');
      await save();
      if ((await fs.readFile(onDisk, 'utf8')) !== 'placed over ssh') throw new Error('Save replaced a hand-placed BDX');
      if ((await workspaceOf(name)).generatedFiles?.[bdxFile] !== bdxHash) throw new Error('The workspace no longer records the BDX Bordeaux wrote');
      await click('.project-chip');
      await wait(() => /BDX files failed/.test(document.querySelector('.project-menu')?.textContent || ''), 'BDX failure in the project menu');
      await shot('06b-kept-bdx');
      await click('.project-chip');
      // Restoring Bordeaux's copy lets the next save replace it again.
      await fs.writeFile(onDisk, original);
      await save();
      if ((await workspaceOf(name)).generatedFiles?.[bdxFile] !== bdxHash) throw new Error('Saving over the restored BDX changed its record');
      check('a hand-placed BDX in the project is kept while the sources save, and the chip reports it', { file: bdxFile });
    }


    // The desktop's LabVIEW command list on the robot: a path that runs a typed command saves and pushes the same BDX.
    const commandCase = JSON.parse(await fs.readFile(path.join(output, 'command-project.json'), 'utf8'));
    await commitsSettled();
    await evaluate(() => window.bordeauxAPI.newProject());
    await evaluate((project) => window.bordeauxAPI.saveProject(project), commandCase.project);
    await win.loadURL(url);
    await editorReady();
    const commandProject = (await api('/api/info')).lastProject;
    await save(async () => {
      await wait(new Function(`return document.querySelector('.project-menu-code')?.textContent.includes(${JSON.stringify(commandCase.catalog)})`), 'robot command list in the project menu');
      await shot('10-command-list');
    });
    const commandWorkspace = await workspaceOf(commandProject);
    const built = commandWorkspace.generatedFiles?.[`Paths/${commandCase.fileName}`];
    if (built !== commandCase.sha256) throw new Error(`The robot built ${built} for ${commandCase.fileName}; the desktop builds ${commandCase.sha256}`);
    check('with the desktop\'s command list, the robot builds the same command BDX as the desktop', { project: commandProject, file: commandCase.fileName, sha256: built });
    await click('.push-button');
    await wait(() => Boolean(document.querySelector('.rfp-view-files')), 'command push review');
    await click('.robot-push-dialog button', 'Upload 1 path');
    await wait(() => document.querySelector('.rfp-view-done')?.textContent.includes('uploaded'), 'command push verified');
    await shot('11-command-push');
    check('the command path pushes into the robot code folder', { done: await evaluate(() => document.querySelector('.rfp-view-done').textContent) });
    await click('[aria-label="Close robot files"]');

    if (home) {
      // A command list as the desktop writes it, under another catalog name, so the editor's change is visible.
      const listFile = path.join(home, 'paths', 'bordeaux-commands.json');
      const renamedList = async (target, projectName) => {
        const file = JSON.parse(await fs.readFile(listFile, 'utf8'));
        file.bindings.catalog.projectName = projectName;
        file.sha256 = sha256(JSON.stringify(file.bindings));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, JSON.stringify(file) + '\n');
      };
      const codeShows = (name) => wait(new Function(`return document.querySelector('.project-menu-code')?.textContent.includes(${JSON.stringify(name)})`), 'command list ' + name, 20_000);

      await renamedList(listFile, 'Refreshed list');
      await menuItem('Refresh commands');
      await click('.project-chip');
      await codeShows('Refreshed list');
      // The fixture's commands have conditions, which the desktop builds a catalog for; the robot can't, so it doesn't offer to.
      const offered = await evaluate(() => [...document.querySelectorAll('.project-menu [role="menuitem"]')].map((item) => item.textContent.trim()));
      if (offered.some((label) => label.startsWith('Build catalog'))) throw new Error('The robot offers a catalog build it cannot run: ' + offered.join(' | '));
      await shot('12-refreshed-commands');
      await click('.project-chip');
      check('Refresh commands reads the command list on the robot again');

      // Another push folder holds another list; saving the folder switches the editor's catalog with it.
      // The server names folders by their real path (macOS temp folders sit behind /var -> /private/var).
      const otherFolder = path.join(await fs.realpath(home), 'other-paths');
      await renamedList(path.join(otherFolder, 'bordeaux-commands.json'), 'Other folder list');
      await click('.push-button');
      await wait(() => Boolean(document.querySelector('.rfp-view-files')), 'push review before changing folder');
      await click('.robot-push-dialog .rfp-dest button', 'Change');
      await wait(() => [...document.querySelectorAll('.robot-push-dialog label')].some((label) => label.textContent.startsWith('Folder on robot')), 'push folder field');
      await evaluate((value) => {
        const input = [...document.querySelectorAll('.robot-push-dialog label')].find((label) => label.textContent.startsWith('Folder on robot')).querySelector('input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, otherFolder);
      await click('.robot-push-dialog button', 'Save');
      await wait(new Function(`return (document.querySelector('.robot-push-dialog')?.textContent || '').includes(${JSON.stringify(otherFolder)}) && !document.querySelector('.robot-push-dialog label input')`), 'push folder saved');
      await shot('13-push-folder-changed');
      await click('[aria-label="Close robot files"]');
      await click('.project-chip');
      await codeShows('Other folder list');
      await shot('14-folder-commands');
      await click('.project-chip');
      check('changing the push folder loads that folder\'s command list in the editor', { folder: otherFolder });
    }

    // Last: the command checks drive the host directly, which a newly opened project's autosave would race.
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
