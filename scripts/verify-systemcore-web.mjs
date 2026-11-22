// End-to-end check of Bordeaux served from a SystemCore (or a local stand-in).
//
//   node scripts/verify-systemcore-web.mjs                  builds dist-systemcore, runs server.py locally on a temp home
//   BORDEAUX_SYSTEMCORE_URL=http://127.0.0.1:2468 node ...  checks an installed robot (tunnel its port first)
//
// Artifacts (screenshots, report.json, and the pushed files' hashes) go to BORDEAUX_SYSTEMCORE_OUTPUT or a temp folder.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';

const output = process.env.BORDEAUX_SYSTEMCORE_OUTPUT ? path.resolve(process.env.BORDEAUX_SYSTEMCORE_OUTPUT) : await fs.mkdtemp(path.join(os.tmpdir(), 'bordeaux-systemcore-'));
await fs.mkdir(output, { recursive: true });
let url = process.env.BORDEAUX_SYSTEMCORE_URL, server, home;
if (!url) {
  execFileSync('npx', ['vite', 'build', '--config', 'vite.systemcore.config.mts', '--logLevel', 'warn'], { stdio: 'inherit' });
  home = path.join(output, 'robot-home');
  const port = 20000 + Math.floor(Math.random() * 20000);
  // A LAN address, not localhost: browsers treat localhost as a secure context, while teams open the robot over plain
  // http, where secure-context APIs such as crypto.randomUUID are missing.
  const addresses = Object.values(os.networkInterfaces()).flat().filter((item) => item?.family === 'IPv4' && !item.internal).map((item) => item.address);
  const lan = addresses.find((address) => /^(192\.168|10)\.|^172\.(1[6-9]|2\d|3[01])\./.test(address)) ?? '127.0.0.1';
  server = spawn('python3', ['src/hosts/systemcore/server.py', '--host', lan, '--port', String(port), '--home', home, '--static', 'dist-systemcore'], { stdio: ['ignore', 'inherit', 'inherit'] });
  url = `http://${lan}:${port}/`;
  let up = false;
  for (let attempt = 0; attempt < 50 && !up; attempt++) {
    try { up = (await fetch(url)).ok; } catch { /* starting */ }
    if (!up) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!up) { server.kill(); throw new Error(`The local server did not answer at ${url}`); }
}
console.log('SystemCore web artifacts: ' + output);
const env = { ...process.env, BORDEAUX_SYSTEMCORE_URL: url, BORDEAUX_SYSTEMCORE_OUTPUT: output, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
delete env.ELECTRON_RUN_AS_NODE;
const code = await new Promise((resolve) => {
  const child = spawn(electron, [path.resolve('scripts/verify-systemcore-web-electron.cjs')], { env, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
  child.on('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
});
if (home) {
  // A local run can also prove the pushed bytes on disk.
  const pushed = {};
  for (const name of await fs.readdir(path.join(home, 'paths'))) pushed[name] = createHash('sha256').update(await fs.readFile(path.join(home, 'paths', name))).digest('hex');
  await fs.writeFile(path.join(output, 'pushed.json'), JSON.stringify(pushed, null, 2));
  console.log('Pushed files: ' + JSON.stringify(pushed));
}
server?.kill();
process.exitCode = code === 0 ? 0 : 1;
