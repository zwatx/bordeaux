// Real-main lifecycle harness. Default is preparation only; --run requires coordinated build/focus ownership.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';

const require = createRequire(import.meta.url);
const root = process.cwd();
const cases = ['close-committed', 'close-draft', 'close-invalid', 'reload-draft', 'force-reload-draft', 'reload-invalid', 'source-failure-recovery',
  'direct-reload-fence', 'direct-force-reload-fence'];
const args = process.argv.slice(2);
assert.ok(args.every(arg => arg === '--run' || arg === '--prepare' || arg.startsWith('--case=')), 'Unknown argument');
assert.ok(!(args.includes('--run') && args.includes('--prepare')), 'Choose --prepare or --run');
const selected = args.filter(arg => arg.startsWith('--case=')).map(arg => arg.slice(7));
assert.ok(selected.every(name => cases.includes(name)), 'Unknown scenario');
const runCases = selected.length ? [...new Set(selected)] : cases;
const output = process.env.BORDEAUX_DEPARTURE_UI_OUTPUT
  ? path.resolve(process.env.BORDEAUX_DEPARTURE_UI_OUTPUT)
  : await fs.mkdtemp(path.join(os.tmpdir(), 'bordeaux-departure-native-'));
await fs.mkdir(output, { recursive: true });
assert.equal((await fs.readdir(output)).length, 0, 'Use a fresh evidence directory');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function tree(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await tree(file));
    else if (entry.isFile()) files.push({ file: path.relative(root, file), sha256: digest(await fs.readFile(file)) });
    else throw new Error('Unexpected nonregular build artifact: ' + file);
  }
  return files.sort((a, b) => a.file.localeCompare(b.file));
}
async function identities() {
  const sourceFiles = ['src/electron/main.ts', 'src/electron/preload.ts', 'src/electron/projectDeparture.ts',
    'src/electron/projectNativeDeparture.ts', 'src/electron/projectPersistence.ts', 'src/electron/projectSourcePersistence.ts', 'src/electron/projectRecoveryStore.ts',
    'src/renderer/app/App.jsx', 'scripts/verify-project-departure-ui.mjs', 'scripts/verify-project-departure-ui-electron.cjs', 'work/rethink/native-recovery-observation.cjs'];
  return { source: await Promise.all(sourceFiles.map(async file => ({ file, sha256: digest(await fs.readFile(path.join(root, file))) }))),
    artifacts: [...await tree(path.join(root, 'dist-electron')), ...await tree(path.join(root, 'dist-renderer'))] };
}
const report = { status: 'prepared-not-run', createdAt: new Date().toISOString(), platform: process.platform,
  architecture: process.arch, node: process.version, requestedModel: 'gpt-6-astra', scenarios: runCases, checks: [],
  limits: ['No actual installer or robot', 'No native IME coverage', 'No Windows/Linux claim from a macOS run',
    'No simulated checkpoint or saved reply', 'No build performed by this harness'], results: [] };
const writeReport = () => fs.writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
console.log('Departure evidence: ' + output);
let lock;
try {
  report.identity = await identities();
  await writeReport();
  if (!args.includes('--run')) {
    console.log('Prepared only. Native lifecycle attachment and matching renderer build must be ready before --run.');
  } else {
    // Same machine-wide lock as electron-smoke. Fail fast; never steal another native actor's focus.
    lock = net.createServer(socket => socket.destroy());
    await new Promise((resolve, reject) => { lock.once('error', reject); lock.listen({ host: '127.0.0.1', port: 24968, exclusive: true }, resolve); });
    const { autosaveProjectFolder, readProject, projectWorkspacePath } = require(path.join(root, 'dist-electron/electron/projectFiles.js'));
    const { encodeProjectFile } = require(path.join(root, 'dist-electron/shared/project/fileFormat.js'));
    const { ProjectRecoveryStore } = require(path.join(root, 'dist-electron/electron/projectRecoveryStore.js'));
    const corpus = JSON.parse(await fs.readFile(path.join(root, 'benchmarks/planner-corpus/v2/corpus.bordeaux.json'), 'utf8'));
    async function launch(directory, stage) {
      const env = { ...process.env, BORDEAUX_DEPARTURE_FIXTURE: directory, BORDEAUX_DEPARTURE_STAGE: stage,
        BORDEAUX_SMOKE_DIRECTORY: path.join(directory, 'userData') };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.BORDEAUX_SMOKE_TEST;
      delete env.BORDEAUX_SMOKE_CAPTURE_PATH;
      const child = spawn(electron, [path.join(root, 'scripts/verify-project-departure-ui-electron.cjs')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', timedOut = false;
      child.stdout.on('data', bytes => { stdout += bytes; });
      child.stderr.on('data', bytes => { stderr += bytes; });
      // Only the exact test-owned child can be terminated. This is a harness failure, never a passing close.
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 45_000);
      let exit;
      try { exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); }); }
      finally { clearTimeout(timer); await fs.writeFile(path.join(directory, stage + '.stdout.log'), stdout); await fs.writeFile(path.join(directory, stage + '.stderr.log'), stderr); }
      const result = JSON.parse(await fs.readFile(path.join(directory, stage + '.json'), 'utf8').catch(() => '{"status":"missing-result"}'));
      report.results.push({ scenario: path.basename(directory), stage, exit, timedOut, result });
      await writeReport();
      assert.equal(timedOut, false, 'Test-owned Electron process exceeded 45s: ' + directory);
      assert.equal(exit.code, 0, 'Native child failed: ' + JSON.stringify({ exit, result, stderr }));
      assert.equal(result.status, 'passed', 'No observed passing result: ' + JSON.stringify(result));
      return result;
    }
    for (const scenario of runCases) {
      const directory = path.join(output, scenario), folder = path.join(directory, 'Documents', 'Departure project');
      await fs.mkdir(path.join(directory, 'userData'), { recursive: true });
      await fs.mkdir(folder, { recursive: true });
      const pathSource = structuredClone(corpus.paths.find(item => item.id === 'corpus-neutral-stop'));
      assert.ok(pathSource, 'Real canonical corpus fixture must exist');
      pathSource.id = 'departure-path'; pathSource.name = 'Departure path';
      const project = { ...corpus, name: 'Departure project', paths: [pathSource], routines: [], pathLinks: [],
        editor: { ...corpus.editor, activePathId: pathSource.id, unitSystem: 'metric' } };
      await autosaveProjectFolder(folder, project, null, { createProject: true });
      const workspace = projectWorkspacePath(folder);
      const before = (await readProject(workspace, { recordOpened: false })).project;
      await fs.writeFile(path.join(directory, 'userData', 'recent-projects.json'), JSON.stringify({ version: 1, projects: [folder] }));
      const fixture = { scenario, folder, workspace, originalX: pathSource.waypoints[0].x, expectedX: 11.17, input: '11.17', width: 1440, height: 900,
        beforeSourceDigest: digest(encodeProjectFile(before).contents) };
      await fs.writeFile(path.join(directory, 'fixture.json'), JSON.stringify(fixture, null, 2));
      const native = await launch(directory, 'exercise');
      if (!scenario.includes('invalid') && !scenario.startsWith('direct-')) {
        const accepted = native.events.find(event => event.kind === 'project:departureResponse:returned'
          && event.data.result?.accepted === true && native.checks.some(check => check?.requestId === event.data.request.requestId
            && check.receiptId === event.data.request.receiptId));
        assert.ok(accepted, 'Production main must actually accept the exact live receipt; observing an IPC send is insufficient');
      }
      const after = (await readProject(workspace, { recordOpened: false })).project;
      const shouldPersist = !scenario.includes('invalid') && !scenario.startsWith('direct-') && scenario !== 'source-failure-recovery';
      assert.equal(after.paths[0].waypoints[0].x, shouldPersist ? fixture.expectedX : fixture.originalX, 'Canonical source after the native action');
      if (scenario.startsWith('close-') && shouldPersist) assert.equal(native.sourceAtNativeDestruction.paths[0].waypoints[0].x, fixture.expectedX, 'Source must already be durable when the real window is destroyed');
      const expected = structuredClone(before);
      if (shouldPersist) {
        const point = expected.paths[0].waypoints[0], dx = fixture.expectedX - point.x;
        point.x = fixture.expectedX;
        // A coordinate edit translates that waypoint's two authored Bezier handles with it.
        if (point.prevC) point.prevC.x += dx;
        if (point.nextC) point.nextC.x += dx;
      }
      // Other renderer-maintained editor preferences are not source geometry; compare the entire authored path.
      assert.deepEqual(after.paths, expected.paths, 'All authored path fields survive the lifecycle action');
      const entries = await fs.readdir(path.join(folder, 'Paths'));
      assert.ok(entries.every(name => !name.endsWith('.bdx')), 'Lifecycle source checkpoint must not generate BDX');
      if (scenario === 'source-failure-recovery') {
        assert.ok(native.recoveryReceipt?.storedSnapshot, 'Live recovery choice must refer to a real receipt');
        const stored = await new ProjectRecoveryStore(path.join(directory, 'userData', 'recovery')).readSnapshot(native.recoveryReceipt.storedSnapshot.recordId);
        assert.deepEqual(stored.receipt, native.recoveryReceipt.storedSnapshot, 'Exact record/revision/digest remains on disk after window destruction');
        assert.equal(stored.project.paths[0].waypoints[0].x, fixture.expectedX, 'Recovery contains the actual typed edit');
        assert.equal(digest(encodeProjectFile(after).contents), fixture.beforeSourceDigest, 'Read-only source remains unchanged');
      }
      report.checks.push({ scenario, observed: 'canonical-source-and-paths', sourceDigest: digest(encodeProjectFile(after).contents), noBdx: true });
      await writeReport();
      if (shouldPersist && scenario.startsWith('close-')) await launch(directory, 'relaunch');
    }
    const finalIdentity = await identities();
    assert.deepEqual(finalIdentity, report.identity, 'Source or compiled artifacts changed during native verification; rerun on a stable build');
    report.status = 'passed';
    await writeReport();
    console.log('Observed native checks: ' + report.checks.length + '; evidence: ' + output);
  }
} catch (error) {
  report.status = 'failed'; report.error = error.stack || String(error); await writeReport();
  console.error(report.error); process.exitCode = 1;
} finally {
  if (lock?.listening) await new Promise(resolve => lock.close(resolve));
}
