import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import electron from 'electron';
const require = createRequire(import.meta.url);
if (process.platform !== 'win32') { console.log('Windows native chrome check requires Windows; IPC contracts run in unit tests.'); process.exit(0); }
const output = process.env.BORDEAUX_CHROME_UI_OUTPUT ? path.resolve(process.env.BORDEAUX_CHROME_UI_OUTPUT) : await fs.mkdtemp(path.join(os.tmpdir(), 'bordeaux-windows-chrome-'));
await fs.mkdir(output, { recursive: true });
const { createDemoProject } = require('../dist-electron/shared/project/defaults.js');
const { autosaveProjectFolder } = require('../dist-electron/electron/projectFiles.js');
const { writeRecentProjectFiles } = require('../dist-electron/electron/recentProjectFiles.js');
const folder = path.join(output, 'Project'); await fs.mkdir(folder);
await fs.mkdir(path.join(output, 'Documents'));
const project = createDemoProject(); project.name = 'Windows chrome · restored offline project';
await autosaveProjectFolder(folder, project, null); await writeRecentProjectFiles(path.join(output, 'recent-projects.json'), [folder]);
const env = { ...process.env, BORDEAUX_SMOKE_DIRECTORY: output, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
delete env.ELECTRON_RUN_AS_NODE; delete env.BORDEAUX_SMOKE_TEST;
console.log('Windows chrome evidence: ' + output);
const child = spawn(electron, ['scripts/verify-windows-chrome-electron.cjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; process.stdout.write(chunk); }); child.stderr.on('data', chunk => { stderr += chunk; });
let timedOut = false;
const timer = setTimeout(() => { timedOut = true; child.kill(); }, 120_000);
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); clearTimeout(timer);
await fs.writeFile(path.join(output, 'stdout.log'), stdout); await fs.writeFile(path.join(output, 'stderr.log'), stderr);
await fs.writeFile(path.join(output, 'result-process.json'), JSON.stringify({ code, timedOut }, null, 2));
const result = JSON.parse(await fs.readFile(path.join(output, 'result.json'), 'utf8'));
if (code !== 0 || result.status !== 'passed') { console.error(stderr || 'Windows chrome process did not finish successfully'); process.exitCode = 1; }
