const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = process.env.BORDEAUX_UPDATES_UI_OUTPUT;
const checks = [], errors = [];
const releaseNotes = '## Path uploads\n- Save and reuse the robot address and destination, with `/home/lvuser/natinst/bin/Paths` as the default.\n- Support linked robot directories and SFTP servers without the optional OpenSSH rename feature.\n- Upload only the selected paths, preserve other files, and verify the uploaded bytes.\n\n## Updates on macOS and Windows\n- Preview release notes, download progress, cancellation, and retry in one place.\n- Restart and install after saving your project.\n\n## Editor and project fixes\n- Keep repair controls available when planning fails.\n- Improve project-open recovery and protection against losing edits during reload.\n\n### Updating from an older beta\nIf the old updater fails, install this release manually.';
app.setPath('userData', path.join(output, 'user-data'));
let win;
const delay = ms => new Promise(r => setTimeout(r, ms));
const evaluate = (fn, ...args) => win.webContents.executeJavaScript(`(${fn})(...${JSON.stringify(args)})`);
async function waitFor(fn, label) { for (let i = 0; i < 60; i++) { if (await fn()) return; await delay(50); } throw new Error('Timed out: ' + label); }
async function click(selector, text) {
  const point = await evaluate((selector, text) => {
    const target = [...document.querySelectorAll(selector)].find(node => !text || node.textContent.trim() === text);
    if (!target || target.disabled) throw new Error('Unavailable ' + selector + ' ' + text);
    target.scrollIntoView({ block: 'nearest' });
    const b = target.getBoundingClientRect(), x = Math.round(b.x + b.width / 2), y = Math.round(b.y + b.height / 2);
    if (!target.contains(document.elementFromPoint(x, y))) throw new Error('Obscured target');
    return { x, y };
  }, selector, text);
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  await delay(70);
}
async function key(keyCode, modifiers = []) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); if (keyCode === 'Return') win.webContents.sendInputEvent({ type: 'char', keyCode: String.fromCharCode(13) }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await delay(70); }
async function set(patch) { await evaluate(patch => window.__updateFixture.set(patch), patch); await delay(70); }
const rect = () => evaluate(() => { const b = document.querySelector('dialog.app-update-dialog').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; });
async function capture(name) { await fs.writeFile(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
function pass(name) { checks.push(name); console.log('PASS ' + name); }
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1440, height: 900, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true } });
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  try {
    await win.loadFile(path.join(output, 'dist/index.html'));
    await waitFor(() => evaluate(() => !!document.querySelector('#update-trigger')), 'fixture');
    for (const platform of ['darwin', 'win32']) for (const [width, height] of [[1440, 900], [1100, 720]]) {
      win.setContentSize(width, height);
      await evaluate(platform => { window.bordeauxAPI.platform = platform; window.__updateFixture.calls.length = 0; }, platform);
      await set({ phase: 'idle', visible: false, currentVersion: '0.2.0-beta.10', version: null, releaseNotes: '', projectDirty: false });
      // The toolbar chip reports background updates without opening the panel.
      const chip = () => evaluate(() => document.querySelector('.update-chip')?.textContent ?? null);
      assert.equal(await chip(), null);
      await set({ phase: 'available', version: '0.2.0-beta.11', releaseNotes: '- Faster pushes' });
      assert.equal(await chip(), 'Update available');
      assert.equal(await evaluate(() => document.querySelector('dialog.app-update-dialog').open), false);
      await click('.update-chip');
      await waitFor(() => evaluate(() => document.querySelector('dialog.app-update-dialog').open), 'chip opens the update panel');
      await key('Escape');
      await waitFor(() => evaluate(() => !document.querySelector('dialog.app-update-dialog').open && document.activeElement.classList.contains('update-chip')), 'Escape returns focus to the chip');
      await set({ phase: 'downloading', progress: { percent: 43.4, transferred: 45 * 1048576, total: 100 * 1048576, bytesPerSecond: 0 } });
      assert.equal(await chip(), 'Downloading 43%');
      await capture(`${platform}-${width}-chip-downloading`);
      await set({ phase: 'downloaded', progress: null });
      assert.equal(await chip(), 'Restart to update');
      await capture(`${platform}-${width}-chip-ready`);
      await click('.update-chip');
      await waitFor(() => evaluate(() => window.__updateFixture.calls.join() === 'install'), 'Restart to update installs in one click');
      await set({ phase: 'idle', visible: false, version: null, releaseNotes: '', progress: null });
      await evaluate(() => { window.__updateFixture.calls.length = 0; });
      await click('#update-trigger');
      const initial = await rect();
      await click('dialog.app-update-dialog button', 'Check for updates');
      assert.ok(await evaluate(() => document.querySelector('progress')?.getAttribute('aria-label') === 'Checking for updates'));
      await capture(`${platform}-${width}-checking`);
      await set({ phase: 'error', error: 'The update request was denied. Try another network or open releases.', errorStage: 'check' });
      await click('dialog.app-update-dialog button', 'Copy details');
      assert.ok(await evaluate(() => window.__updateFixture.calls.includes('copy')));
      await capture(`${platform}-${width}-error`);
      await click('dialog.app-update-dialog button', 'Try again');
      assert.equal(await evaluate(() => window.__updateFixture.calls.filter(c => c === 'check').length), 2);
      await set({ phase: 'available', version: '0.2.0-beta.11', releaseNotes: '# Improvements\n- More consistent trajectory playback\n- Clearer project saving\n## Fixes\n' + '- Long release notes stay inside this panel.\n'.repeat(30) + '<img src=x onerror=alert(1)>\n[External](https://bad.example)' });
      assert.equal(await evaluate(() => document.querySelectorAll('.app-update-notes img,.app-update-notes a').length), 0);
      assert.ok(await evaluate(() => { const n = document.querySelector('.app-update-notes'); return n.scrollHeight > n.clientHeight; }));
      await capture(`${platform}-${width}-available`);
      await click('dialog.app-update-dialog button', 'Download update');
      await set({ progress: { percent: 43, transferred: 45 * 1048576, total: 100 * 1048576, bytesPerSecond: 2 * 1048576 } });
      assert.equal(await evaluate(() => document.querySelector('progress').value), 43);
      await capture(`${platform}-${width}-download`);
      await key('Escape');
      assert.equal(await evaluate(() => document.querySelector('dialog.app-update-dialog').open), false);
      assert.equal(await evaluate(() => document.activeElement.id), 'update-trigger');
      assert.ok(await evaluate(() => !window.__updateFixture.calls.includes('cancel')));
      await click('#update-trigger');
      await click('dialog.app-update-dialog button', 'Cancel download');
      assert.ok(await evaluate(() => window.__updateFixture.calls.includes('cancel')));
      await set({ phase: 'error', errorStage: 'download', error: 'The connection was interrupted. Try the download again.' });
      await click('dialog.app-update-dialog button', 'Retry download');
      assert.equal(await evaluate(() => window.__updateFixture.calls.filter(c => c === 'download').length), 2);
      await set({ phase: 'downloaded', projectDirty: true });
      assert.equal(await evaluate(() => [...document.querySelectorAll('dialog.app-update-dialog button')].find(b => b.textContent === 'Restart and install').disabled), false);
      await capture(`${platform}-${width}-dirty`);
      assert.deepEqual(await rect(), initial, 'Phase changes must not move or resize the dialog');
      await capture(`${platform}-${width}-ready`);
      await evaluate(() => document.querySelector('.app-update-close').focus());
      await key('Tab', ['shift']);
      assert.equal(await evaluate(() => document.activeElement.textContent), 'Restart and install');
      await key('Return');
      assert.ok(await evaluate(() => window.__updateFixture.calls.includes('install')));
      await key('Escape');
      assert.equal(await evaluate(() => document.querySelector('dialog.app-update-dialog').open), true, 'Installation must keep the editor blocked until quit or failure');
      await set({ phase: 'installing', installStalled: true });
      assert.equal(await evaluate(() => document.querySelector('progress')), null);
      assert.equal(await evaluate(() => [...document.querySelectorAll('dialog.app-update-dialog button')].some(b => b.textContent === 'Retry install')), false);
      await capture(`${platform}-${width}-restart-stalled`);
      await key('Escape');
      assert.equal(await evaluate(() => document.querySelector('dialog.app-update-dialog').open), false, 'Stalled restart must release the editor');
      await click('#update-trigger');
      await click('dialog.app-update-dialog button', 'Close');
      assert.equal(await evaluate(() => document.querySelector('dialog.app-update-dialog').open), false);
      await click('#update-trigger');
      await set({ installStalled: false });
      await set({ phase: 'upToDate', version: null, currentVersion: '0.2.0-beta.11', releaseNotes, projectDirty: false });
      assert.deepEqual(await rect(), initial);
      assert.ok(await evaluate(() => document.querySelectorAll('.app-update-notes ul li').length >= 7));
      assert.equal(await evaluate(() => document.querySelector('.app-update-notes code').textContent), '/home/lvuser/natinst/bin/Paths');
      assert.ok(await evaluate(() => {
        // Computed colors keep their authored space (e.g. oklch(…)), so paint the actual value and read back sRGB.
        const context = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
        context.fillStyle = getComputedStyle(document.querySelector('.app-update-action')).backgroundColor;
        context.fillRect(0, 0, 1, 1);
        const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data;
        return alpha === 255 && Math.max(r, g, b) - Math.min(r, g, b) < 16;
      }), 'Primary action should use a neutral surface');
      assert.ok(await evaluate(() => document.querySelector('.app-update-notes').clientHeight > 340), 'Notes must have useful reading space');
      await capture(`${platform}-${width}-up-to-date`);
      await evaluate(() => document.querySelector('.app-update-close').focus());
      await key('Tab', ['shift']);
      assert.equal(await evaluate(() => document.activeElement.textContent), 'Done');
      await key('Return');
      assert.equal(await evaluate(() => document.querySelector('dialog.app-update-dialog').open), false);
      assert.equal(await evaluate(() => document.activeElement.id), 'update-trigger');
      pass(`${platform} ${width}×${height}: toolbar chip, safe notes, fixed layout, retry, progress, cancel, unsaved install, modal keyboard and focus`);
    }
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: true, checks, errors }, null, 2));
    app.exit(0);
  } catch(error) { console.error(error); await capture('failure'); await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ passed: false, checks, errors, error: error.message }, null, 2)); app.exit(1); }
});
