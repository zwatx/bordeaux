import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import electron from 'electron';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = process.env.BORDEAUX_LABVIEW_UI_OUTPUT
  ? path.resolve(process.env.BORDEAUX_LABVIEW_UI_OUTPUT)
  : await fs.mkdtemp(path.join(os.tmpdir(), 'bordeaux-labview-ui-'));
await fs.mkdir(output, { recursive: true });
const html = path.join(output, 'index.html');
await fs.writeFile(html, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="${path.join(root, 'scripts/labview-project-ui-harness.jsx')}"></script></body></html>`);
await build({
  configFile: false, root: output, base: './', publicDir: false, logLevel: 'error',
  define: { 'process.env.NODE_ENV': JSON.stringify('development') },
  build: { outDir: path.join(output, 'dist'), emptyOutDir: true, minify: false, rollupOptions: { input: html } },
});
const runner = path.join(output, 'runner.cjs');
await fs.writeFile(runner, `
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
app.setPath('userData', path.join(${JSON.stringify(output)}, 'user-data'));
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1440, height: 900, useContentSize: true, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  const errors = [], guards = [], parts = [];
  let admitted = false, lost = false;
  win.on('blur', () => { if (admitted) { lost = true; guards.push({ kind: 'window-blur' }); } });
  win.webContents.on('render-process-gone', (_event, details) => { lost = true; errors.push('Renderer exited: ' + details.reason); });
  win.webContents.on('console-message', (event) => { if (event.level === 'error') { errors.push(event.message); console.error(event.message); } });
  const guard = async (label) => {
    const state = { label, window: win.isFocused(), contents: win.webContents.isFocused(), document: await win.webContents.executeJavaScript('document.hasFocus()'), documentBlurs: await win.webContents.executeJavaScript('window.__labviewBlurs || []'), rendererErrors: await win.webContents.executeJavaScript('window.__labviewErrors || []'), lost };
    guards.push(state);
    if (!state.window || !state.contents || !state.document || state.documentBlurs.length || state.rendererErrors.length || lost) throw new Error('Native focus lost at ' + label);
  };
  await win.loadFile(${JSON.stringify(path.join(output, 'dist/index.html'))});
  // One initial admission only. No gesture or capture reacquires focus after a loss.
  win.show(); win.focus(); win.webContents.focus();
  await new Promise(resolve => setTimeout(resolve, 80));
  await guard('initial admission'); admitted = true;
  await win.webContents.executeJavaScript('window.__labviewFocusArmed = true');
  const part = async (event, label) => { await guard(label + ':before'); win.webContents.sendInputEvent(event); await new Promise(resolve => setTimeout(resolve, 25)); await guard(label + ':after'); };
  let processing = false;
  const poll = setInterval(async () => {
    if (processing) return;
    processing = true;
    try {
      const request = await win.webContents.executeJavaScript('window.__pushUiRequest');
      if (request) {
        await guard('request:before');
        const start = await win.webContents.executeJavaScript('window.__labviewNativeEvents.length');
        if (request.capture) {
          for (const [width, height] of [[1440, 900], [1100, 720]]) {
            win.setContentSize(width, height);
            await win.webContents.executeJavaScript('document.fonts.ready');
            await new Promise((resolve) => setTimeout(resolve, 80));
            await guard('capture:' + request.capture + ':' + width);
            await fs.writeFile(path.join(${JSON.stringify(output)}, request.capture + '-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
          }
        } else if (request.pointer) {
          await part({ type: 'mouseMove', x: request.pointer.x, y: request.pointer.y }, 'pointer move');
          await part({ type: 'mouseDown', x: request.pointer.x, y: request.pointer.y, button: 'left', clickCount: 1 }, 'pointer down');
          await part({ type: 'mouseUp', x: request.pointer.x, y: request.pointer.y, button: 'left', clickCount: 1 }, 'pointer up');
        } else if (request.key) {
          const keyCode = { ArrowDown: 'Down', ArrowUp: 'Up' }[request.key] || request.key;
          await part({ type: 'keyDown', keyCode }, 'key down:' + keyCode);
          if (keyCode === 'Enter') await part({ type: 'char', keyCode: String.fromCharCode(13) }, 'Enter char');
          if (keyCode === 'Space') await part({ type: 'char', keyCode: ' ' }, 'Space char');
          await part({ type: 'keyUp', keyCode }, 'key up:' + keyCode);
        } else if (typeof request.text === 'string') {
          await guard('insertText:before'); await win.webContents.insertText(request.text); await guard('insertText:after');
        } else throw new Error('Unknown native request');
        await guard('request:after');
        const events = await win.webContents.executeJavaScript('window.__labviewNativeEvents.slice(' + start + ')');
        const expected = request.pointer ? ['pointerdown', 'pointerup'] : request.key ? ['keydown', 'keyup'] : typeof request.text === 'string' ? ['input'] : [];
        for (const type of expected) if (!events.some(event => event.type === type && event.trusted && event.focused)) throw new Error('Missing trusted focused ' + type);
        // Pointer events are required; compatibility mouse events may be suppressed by the actual control.
        parts.push({ request, events });
        await win.webContents.executeJavaScript('window.__finishPushUiRequest()');
      }
      const report = await win.webContents.executeJavaScript('document.querySelector("#verification-report")?.textContent');
      if (!report) return;
      clearInterval(poll);
      const results = JSON.parse(report);
      await guard('terminal');
      if (results.length !== 7 || new Set(results.map(item => item.name)).size !== 7) throw new Error('Expected exactly seven component cases');
      if (errors.length) throw new Error('Renderer console errors: ' + errors.join('; '));
      await fs.writeFile(${JSON.stringify(path.join(output, 'results.json'))}, report);
      await fs.writeFile(path.join(${JSON.stringify(output)}, 'native-input.json'), JSON.stringify({ status: results.every(result => result.ok) ? 'passed' : 'failed', guards, parts, errors }, null, 2));
      for (const result of results) console.log((result.ok ? 'PASS ' : 'FAIL ') + result.name + (result.error ? ': ' + result.error : ''));
      app.exit(results.every((result) => result.ok) ? 0 : 1);
    } catch (error) {
      clearInterval(poll);
      console.error(error);
      await fs.writeFile(path.join(${JSON.stringify(output)}, 'native-input.json'), JSON.stringify({ status: 'failed', guards, parts, errors, failure: String(error.stack || error) }, null, 2));
      await fs.writeFile(${JSON.stringify(path.join(output, 'results.json'))}, JSON.stringify([{ name: 'Native admission, input or terminal guard', ok: false, error: String(error.stack || error) }], null, 2));
      await fs.writeFile(path.join(${JSON.stringify(output)}, 'failure.png'), (await win.webContents.capturePage()).toPNG()).catch(() => {});
      app.exit(1);
    } finally { processing = false; }
  }, 100);
}).catch((error) => { console.error(error); app.exit(1); });
`);
const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
delete env.ELECTRON_RUN_AS_NODE;
console.log(`LabVIEW project UI artifacts: ${output}`);
const child = spawn(electron, [runner], { cwd: root, env, stdio: 'inherit' });
const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
clearTimeout(timer);
process.exitCode = code === 0 ? 0 : 1;
