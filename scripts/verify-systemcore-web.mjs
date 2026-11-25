// End-to-end check of Bordeaux served from a SystemCore (or a local stand-in).
//
//   node scripts/verify-systemcore-web.mjs                  builds dist-systemcore, runs server.py locally on a temp home
//   BORDEAUX_SYSTEMCORE_URL=http://127.0.0.1:2468 node ...  checks an installed robot (tunnel its port first)
//   BORDEAUX_SYSTEMCORE_SFTP=127.0.0.1:2222                 with a robot URL: the robot's SSH (tunnel it too), for the
//                                                            desktop transport that delivers the LabVIEW command list
//
// Artifacts (screenshots and report.json; a local run adds the pushed files' hashes and their decoded contents) go to
// BORDEAUX_SYSTEMCORE_OUTPUT or a temp folder.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createRequire } from 'node:module';

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

// The LabVIEW command list a desktop Push sends to a SystemCore, recorded from the repo's typed NI fixture
// (tests/fixtures/binaryWriterFixture.ts, a curved path with typed events), and the BDX the desktop app builds with it.
// The robot must build the same bytes. The desktop builds BDX in Electron's Node, so the expected file is built there.
execFileSync('npm', ['run', 'build:electron', '--silent'], { stdio: 'inherit' });
const desktop = (module) => createRequire(import.meta.url)(path.resolve('dist-electron', module));
const { COMMANDS_FILE_NAME, encodeCommandsFile } = desktop('core/export/commandsFile');
const fixtureFile = path.resolve('tests/fixtures/systemcoreCommandProject.json');
const fixture = JSON.parse(await fs.readFile(fixtureFile, 'utf8'));
const expected = JSON.parse(execFileSync(electron, [path.resolve('scripts/systemcore-desktop-bdx.cjs'), fixtureFile], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).toString());
console.log(`Desktop BDX (${expected.engine}): ${expected.fileName} ${expected.sha256.slice(0, 16)}, ${expected.eventCount} events`);
const { base64: desktopBdx, ...expectedFile } = expected;
await fs.writeFile(path.join(output, 'command-project.json'), JSON.stringify({ project: fixture.project, ...expectedFile, catalog: fixture.bindings.catalog.projectName }));
const commands = Buffer.from(encodeCommandsFile(fixture.bindings));
if (home) {
  await fs.mkdir(path.join(home, 'paths'), { recursive: true });
  await fs.writeFile(path.join(home, 'paths', COMMANDS_FILE_NAME), commands);
} else if (process.env.BORDEAUX_SYSTEMCORE_SFTP) {
  // The desktop app's own SFTP transport and default SystemCore account, as a Push uses them.
  const [host, port] = process.env.BORDEAUX_SYSTEMCORE_SFTP.split(':');
  const { discoverRobotSshIdentity } = desktop('electron/robotSsh2Session');
  const { uploadRobotFiles } = desktop('electron/robotFileTransfer');
  const { ROBOT_TARGETS } = desktop('core/robotTargets');
  const endpoint = { target: 'systemcore', host, port: Number(port), directory: ROBOT_TARGETS.systemcore.defaultDirectory };
  // A desktop Push sends the list only beside the paths that use it (the transport refuses a list alone), so it goes
  // with the desktop's own BDX for the command path.
  await uploadRobotFiles({ endpoint, hostKeyFingerprint: await discoverRobotSshIdentity(endpoint) },
    [{ fileName: expected.fileName, contents: Buffer.from(desktopBdx, 'base64') }, { fileName: COMMANDS_FILE_NAME, contents: commands }]);
  console.log(`Sent ${expected.fileName} and ${COMMANDS_FILE_NAME} to ${endpoint.directory} over SFTP`);
} else console.log('No BORDEAUX_SYSTEMCORE_SFTP: using the command list already on the robot');
// A local run also hands over the robot home, so the page check can stage a bad destination and prove files on disk.
const env = { ...process.env, BORDEAUX_SYSTEMCORE_URL: url, BORDEAUX_SYSTEMCORE_OUTPUT: output, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true', ...(home ? { BORDEAUX_SYSTEMCORE_HOME: home } : {}) };
delete env.ELECTRON_RUN_AS_NODE;
const code = await new Promise((resolve) => {
  const child = spawn(electron, [path.resolve('scripts/verify-systemcore-web-electron.cjs')], { env, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
  child.on('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
});
let readBack = true;
if (home) {
  // A local run can also prove the pushed bytes on disk, and that every pushed path reads back as a BDX.
  const { decodeBdx } = desktop('core/export/bdxReader');
  const pushed = {}, decoded = {};
  for (const name of await fs.readdir(path.join(home, 'paths'))) {
    const bytes = await fs.readFile(path.join(home, 'paths', name));
    pushed[name] = createHash('sha256').update(bytes).digest('hex');
    if (!name.endsWith('.bdx')) continue;
    try {
      const bdx = decodeBdx(bytes);
      decoded[name] = { version: `1.${bdx.minor}`, pathId: bdx.id, name: bdx.name, seconds: bdx.totalTimeS, meters: bdx.totalDistanceM, samples: bdx.samples.length,
        field: bdx.field, first: bdx.samples[0], last: bdx.samples.at(-1), followSections: bdx.followSections, events: bdx.events };
    } catch (error) { readBack = false; decoded[name] = { error: String(error?.message || error) }; console.error(`FAIL ${name} does not read back: ${decoded[name].error}`); }
  }
  // The command path's events are counted by the desktop's writer, independently of the reader.
  const commandEvents = decoded[expected.fileName]?.events?.length;
  if (code === 0 && commandEvents !== expected.eventCount) { readBack = false; console.error(`FAIL ${expected.fileName} reads back ${commandEvents} events; the desktop wrote ${expected.eventCount}`); }
  await fs.writeFile(path.join(output, 'pushed.json'), JSON.stringify(pushed, null, 2));
  await fs.writeFile(path.join(output, 'pushed-decoded.json'), JSON.stringify(decoded, null, 2));
  console.log('Pushed files: ' + JSON.stringify(pushed));
  if (readBack) console.log(`PASS ${Object.keys(decoded).length} pushed BDX files read back (pushed-decoded.json)`);
}
server?.kill();
process.exitCode = code === 0 && readBack ? 0 : 1;
