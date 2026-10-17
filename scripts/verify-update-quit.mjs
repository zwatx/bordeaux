import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import electron from 'electron';
const require = createRequire(import.meta.url);
const output = process.env.BORDEAUX_UPDATE_QUIT_OUTPUT
  ? path.resolve(process.env.BORDEAUX_UPDATE_QUIT_OUTPUT)
  : await fs.mkdtemp(path.join(os.tmpdir(), 'bordeaux-update-quit-'));
await fs.mkdir(output, { recursive: true });
console.log('Update lifecycle evidence: ' + output);
const lock = net.createServer(socket => socket.destroy());
await new Promise((resolve, reject) => { lock.once('error', reject); lock.listen({ host: '127.0.0.1', port: 24968, exclusive: true }, resolve); });
try {
  const { createDemoProject } = require('../dist-electron/shared/project/defaults.js');
  const { autosaveProjectFolder, projectWorkspacePath } = require('../dist-electron/electron/projectFiles.js');
  const { writeRecentProjectFiles } = require('../dist-electron/electron/recentProjectFiles.js');
  const folder = path.join(await fs.realpath(output), 'Project'); await fs.mkdir(folder);
  await fs.mkdir(path.join(output, 'Documents'));
  const project = createDemoProject(); project.editor = { ...project.editor, unitSystem: "metric" }; await autosaveProjectFolder(folder, project, null); await writeRecentProjectFiles(path.join(output, 'recent-projects.json'), [folder]);
  const firstX = Math.round((project.paths[0].waypoints[0].x + 0.125) * 1000) / 1000, secondX = firstX + 0.125;
  await fs.writeFile(path.join(output, 'fixture.json'), JSON.stringify({ folder, workspace: projectWorkspacePath(folder), firstX, secondX }));
  async function tree(directory) {
    const files = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...await tree(file));
      else { assert.ok(entry.isFile(), 'Build identity requires regular files'); files.push(file); }
    }
    return files;
  }
  const files = [...await tree('dist-electron'), ...await tree('dist-renderer'), 'scripts/verify-update-quit-electron.cjs', 'scripts/verify-update-quit.mjs'].sort();
  const identities = async () => Promise.all(files.map(async file => ({ file, sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex') })));
  const before = await identities(); await fs.writeFile(path.join(output, 'identity.json'), JSON.stringify(before, null, 2));
  const env = { ...process.env, BORDEAUX_SMOKE_DIRECTORY: output, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
  if (process.platform === 'linux') env.APPIMAGE = path.join(output, 'Fixture.AppImage');
  delete env.ELECTRON_RUN_AS_NODE; delete env.BORDEAUX_SMOKE_TEST;
  const child = spawn(electron, ['scripts/verify-update-quit-electron.cjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 45_000);
  const { code, signal } = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); }); clearTimeout(timer);
  await fs.writeFile(path.join(output, 'result-process.json'), JSON.stringify({ code, signal, timedOut }, null, 2));
  await fs.writeFile(path.join(output, 'stdout.log'), stdout); await fs.writeFile(path.join(output, 'stderr.log'), stderr);
  assert.equal(timedOut, false, 'Update lifecycle exceeded its 45-second bound');
  assert.equal(code, 0, 'Test-owned Electron process must complete normally (signal: ' + signal + ')\n' + stderr + '\n' + stdout); assert.deepEqual(await identities(), before, 'No build drift during native run');
  const result = JSON.parse(await fs.readFile(path.join(output, 'result.json'), 'utf8'));
  assert.equal(result.status, 'passed', JSON.stringify(result)); assert.equal(result.installerCalls, 1); assert.ok(result.closed && result.quit && result.saveAvailable && result.cleanupPasses >= 2);
  console.log('PASS actual source receipts gate one mocked installer and late handoff; disk at native close and cleanup verified');
} finally { await new Promise(resolve => lock.close(resolve)); }
