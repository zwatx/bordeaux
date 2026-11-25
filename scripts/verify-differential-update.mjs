// Checks a differential app update against two published GitHub releases. It runs
// electron-updater's own blockmap downloader inside Electron with Bordeaux's release
// provider, then writes report.json and updater.log to the output folder.
//
//   npm run build:electron && node scripts/verify-differential-update.mjs
//
// BORDEAUX_UPDATE_FROM picks the installed version (default: the release before the latest beta).
// BORDEAUX_UPDATE_PLATFORM picks the installer (win32 default, darwin, or linux).
// BORDEAUX_UPDATE_OUTPUT keeps the downloads and report; the old installer is reused when present.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = process.env.BORDEAUX_UPDATE_OUTPUT ? path.resolve(process.env.BORDEAUX_UPDATE_OUTPUT) : await fs.mkdtemp(path.join(os.tmpdir(), 'bordeaux-differential-update-'));
await fs.mkdir(output, { recursive: true });
const env = { ...process.env, BORDEAUX_UPDATE_OUTPUT: output, BORDEAUX_ROOT: root };
delete env.ELECTRON_RUN_AS_NODE;
console.log('Differential update artifacts: ' + output);
const child = spawn(electron, [path.join(root, 'scripts/verify-differential-update-electron.cjs')], { env, stdio: 'inherit' });
const timer = setTimeout(() => child.kill('SIGKILL'), 15 * 60_000);
child.on('exit', code => { clearTimeout(timer); process.exitCode = code === 0 ? 0 : 1; });
child.on('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
