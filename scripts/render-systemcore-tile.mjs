// Regenerates src/hosts/systemcore/package/bordeaux-tile.png, the image the SystemCore dashboard shows for Bordeaux.
// Like the other dashboard apps, it is the real editor (planner corpus project, served by server.py) behind the app icon.
// Rerun after visible editor changes: node scripts/render-systemcore-tile.mjs
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';

execFileSync('npx', ['vite', 'build', '--config', 'vite.systemcore.config.mts', '--logLevel', 'error'], { stdio: 'inherit' });
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'bordeaux-tile-home-'));
const port = 20000 + Math.floor(Math.random() * 20000);
const server = spawn('python3', ['src/hosts/systemcore/server.py', '--host', '127.0.0.1', '--port', String(port), '--home', home, '--static', 'dist-systemcore'], { stdio: 'ignore' });
const url = `http://127.0.0.1:${port}/`;
for (let attempt = 0; attempt < 50; attempt++) {
  try { if ((await fetch(url)).ok) break; } catch { /* starting */ }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const out = path.resolve('src/hosts/systemcore/package/bordeaux-tile.png');
const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
delete env.ELECTRON_RUN_AS_NODE;
const code = await new Promise((resolve) => spawn(electron, [path.resolve('scripts/render-systemcore-tile-electron.cjs'), url,
  path.resolve('benchmarks/planner-corpus/v2/corpus.bordeaux.json'), path.resolve('build/icon.png'), out], { env, stdio: 'inherit' }).on('exit', resolve));
server.kill();
if (code !== 0) process.exit(1);
console.log('Wrote ' + path.relative(process.cwd(), out));
