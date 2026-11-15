import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import electron from 'electron';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = process.env.BORDEAUX_FILE_PUSH_UI_OUTPUT
  ? path.resolve(process.env.BORDEAUX_FILE_PUSH_UI_OUTPUT)
  : await fs.mkdtemp(path.join(os.tmpdir(), 'bordeaux-file-push-ui-'));
await fs.mkdir(output, { recursive: true });
const html = path.join(output, 'index.html');
await fs.writeFile(html, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>/* Captures show settled states, not a fade in progress. */ *,*::before,*::after{transition:none!important}</style></head><body><div id="root"></div><script type="module" src="${path.join(root, 'scripts/robot-file-push-ui-harness.jsx')}"></script></body></html>`);
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
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1440, height: 900, useContentSize: true, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  win.webContents.on('console-message', (event) => { if (event.level === 'error') console.error(event.message); });
  await win.loadFile(${JSON.stringify(path.join(output, 'dist/index.html'))}, { query: { filter: ${JSON.stringify(process.env.BORDEAUX_FILE_PUSH_UI_FILTER || '')} } });
  let processing = false;
  const poll = setInterval(async () => {
    if (processing) return;
    processing = true;
    try {
      const request = await win.webContents.executeJavaScript('window.__pushUiRequest');
      if (request) {
        if (request.capture) {
          for (const [width, height] of [[1440, 900], [1100, 720]]) {
            win.setContentSize(width, height);
            await win.webContents.executeJavaScript('document.fonts.ready');
            // Controls fade over 140 ms after a resize; capture once they settle.
            await new Promise((resolve) => setTimeout(resolve, 200));
            await fs.writeFile(path.join(${JSON.stringify(output)}, request.capture + '-' + width + '.png'), (await win.webContents.capturePage()).toPNG());
          }
        } else if (request.pointer) {
          win.webContents.sendInputEvent({ type: 'mouseDown', x: request.pointer.x, y: request.pointer.y, button: 'left', clickCount: 1 });
          win.webContents.sendInputEvent({ type: 'mouseUp', x: request.pointer.x, y: request.pointer.y, button: 'left', clickCount: 1 });
          await new Promise((resolve) => setTimeout(resolve, 50));
        } else if (request.key) {
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: request.key });
          if (request.key === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: String.fromCharCode(13) });
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: request.key });
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await win.webContents.executeJavaScript('window.__finishPushUiRequest()');
      }
      const report = await win.webContents.executeJavaScript('document.querySelector("#verification-report")?.textContent');
      if (!report) return;
      clearInterval(poll);
      await fs.writeFile(${JSON.stringify(path.join(output, 'results.json'))}, report);
      const results = JSON.parse(report);
      for (const result of results) console.log((result.ok ? 'PASS ' : 'FAIL ') + result.name + (result.error ? ': ' + result.error : ''));
      app.exit(results.every((result) => result.ok) ? 0 : 1);
    } catch (error) {
      clearInterval(poll);
      console.error(error);
      await fs.writeFile(path.join(${JSON.stringify(output)}, 'failure.png'), (await win.webContents.capturePage()).toPNG());
      app.exit(1);
    } finally { processing = false; }
  }, 100);
}).catch((error) => { console.error(error); app.exit(1); });
`);
const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
delete env.ELECTRON_RUN_AS_NODE;
console.log(`Robot push controller verification artifacts: ${output}`);
const child = spawn(electron, [...(process.env.BORDEAUX_UI_DISABLE_GPU === '1' ? ['--disable-gpu'] : []), runner], { cwd: root, env, stdio: 'inherit' });
const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
clearTimeout(timer);
process.exitCode = code === 0 ? 0 : 1;
