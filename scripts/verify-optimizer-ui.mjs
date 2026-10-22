import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { installOptimizerWorkerEvidence } from './verify-optimizer-ui-workers.cjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = (process.env.BORDEAUX_OPTIMIZER_UI_OUTPUT && path.resolve(process.env.BORDEAUX_OPTIMIZER_UI_OUTPUT)) || await fs.mkdtemp(path.join(os.tmpdir(), 'bordeaux-optimizer-ui-'));
await fs.mkdir(output, { recursive: true });
if ((await fs.readdir(output)).length) throw new Error('Fresh empty optimizer evidence directory required: ' + output);
const json = (name, value) => fs.writeFile(path.join(output, name), JSON.stringify(value, null, 2) + '\n');
async function identities() {
  const inputs = {};
  async function visit(relative) {
    const file = path.join(root, relative), item = await fs.lstat(file);
    if (item.isDirectory()) for (const name of (await fs.readdir(file)).sort()) await visit(path.join(relative, name));
    else if (item.isFile()) { const data = await fs.readFile(file); inputs[relative] = { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }; }
    else throw new Error('Unexpected source/build entry: ' + relative);
  }
  for (const file of ['scripts/verify-optimizer-ui.mjs', 'scripts/verify-optimizer-ui-electron.cjs',
    'scripts/verify-optimizer-ui-preload.cjs', 'scripts/verify-optimizer-ui-workers.cjs',
    'src/renderer', 'src/shared', 'package.json', 'package-lock.json',
    'benchmarks/planner-corpus/v2/corpus.bordeaux.json', 'dist-renderer']) await visit(file);
  return inputs;
}
let status = null, timedOut = false, timer, before, stableInputs = false;
const startedAt = new Date().toISOString();
try {
  before = await identities();
  await json('inputs-before.json', before);
  const corpus = JSON.parse(await fs.readFile(path.join(root, 'benchmarks/planner-corpus/v2/corpus.bordeaux.json'), 'utf8'));
  const primary = structuredClone(corpus.paths.find((item) => item.id === 'corpus-neutral-slalom'));
  if (!primary) throw new Error('Neutral slalom verification fixture was not found');
  primary.name = 'Optimizer verification slalom';
  const alternate = { ...structuredClone(corpus.paths.find((item) => item.id === 'corpus-neutral-stop')), id: 'optimizer-verification-alternate', name: 'Optimizer verification alternate' };
  const fixture = { ...corpus, name: 'Optimizer UI verification', paths: [primary, alternate], pathLinks: [],
    routines: [{ id: 'optimizer-verification-routine', name: 'Verification', nodes: [{ id: 'optimizer-drive', type: 'path', ref: primary.id }] }],
    activeRoutineId: 'optimizer-verification-routine', plannerId: 'profiledSpline', editor: { activePathId: primary.id } };
  const html = path.join(root, 'dist-renderer/index.html');
  await fs.access(html);
  const env = { ...process.env, BORDEAUX_OPTIMIZER_UI_OUTPUT: output, BORDEAUX_OPTIMIZER_UI_HTML: html,
    BORDEAUX_OPTIMIZER_UI_PROJECT: Buffer.from(JSON.stringify(fixture)).toString('base64'), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;
  console.log(`Optimizer UI verification artifacts: ${output}`);
  const child = spawn(electron, [path.join(root, 'scripts/verify-optimizer-ui-electron.cjs')], { cwd: root, env, stdio: 'inherit' });
  // Keep the existing total bound and every condition deadline unchanged.
  timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 150_000);
  status = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, pid: child.pid }));
  });
  clearTimeout(timer);
  await json('child-status.json', { ...status, timedOut, startedAt, endedAt: new Date().toISOString() });
  const after = await identities();
  await json('inputs-after.json', after);
  stableInputs = JSON.stringify(before) === JSON.stringify(after);
  assert.ok(stableInputs, 'Source/build/harness changed during native verification');
  assert.equal(timedOut, false, 'Native process exceeded its existing 150-second bound');
  assert.equal(status.code, 0, 'Native child must exit successfully');
  assert.equal(status.signal, null);
  const result = JSON.parse(await fs.readFile(path.join(output, 'result.json'), 'utf8'));
  assert.equal(result.passed, true);
  assert.deepEqual(result.errors, []);
  assert.ok(Array.isArray(result.checks));
  assert.equal(result.checks.length, 35, 'Retain all 27 original checks plus eight request-evidence checks');
  assert.equal(new Set(result.checks).size, 35);
  assert.ok(result.checks.every(name => typeof name === 'string' && name.length));
  const evidence = result.workerEvidence;
  assert.equal(evidence.documents.length, 3, 'Observe initial, units reload and cold accepted reload documents');
  assert.deepEqual(evidence.documents.map(doc => doc.document), [1, 2, 3]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(output, 'worker-evidence.json'), 'utf8')), evidence);
  const registration = JSON.parse(await fs.readFile(path.join(output, 'observer-registration.json'), 'utf8'));
  assert.equal(registration.mechanism, 'registered-frame-preload/contextBridge.executeInMainWorld');
  assert.equal(registration.type, 'frame');
  assert.ok(typeof registration.id === 'string' && registration.id.length > 0);
  const observerSource = installOptimizerWorkerEvidence.toString();
  const observerSha256 = createHash('sha256').update(observerSource).digest('hex');
  assert.equal(registration.observerSha256, observerSha256);
  for (const file of [registration.filePath, registration.observerSourceFile]) {
    const relative = path.relative(output, file);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Observer source must belong to this fresh evidence directory');
    const stat = await fs.lstat(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
  }
  assert.equal(await fs.readFile(registration.observerSourceFile, 'utf8'), observerSource);
  const preloadSource = await fs.readFile(registration.filePath, 'utf8');
  assert.equal(preloadSource, "const { contextBridge } = require('electron');\nif (process.isMainFrame) contextBridge.executeInMainWorld({ func: "
    + observerSource + ', args: [' + JSON.stringify(observerSha256) + '] });\n');
  assert.equal(registration.sha256, createHash('sha256').update(preloadSource).digest('hex'));
  assert.equal(evidence.checkpoints.length, 8);
  assert.equal(new Set(evidence.checkpoints.map(point => point.label)).size, 8);
  assert.ok(evidence.checkpoints.every(point => point.passed === true && result.checks.includes(point.label)));
  assert.ok(evidence.documents.every(doc => doc.problems.length === 0 && doc.jobs.some(job => job.mode === 'editing')));
  assert.ok(evidence.documents.every(doc => doc.installed === true && doc.installedReadyState === 'loading'
    && doc.installedScriptCount === 0 && doc.observerSha256 === observerSha256));
  assert.ok(evidence.documents.at(-1).jobs.every(job => job.status !== 'pending'));
  assert.ok(Number.isFinite(result.normalTimeS) && Number.isFinite(result.optimizedTimeS));
  assert.ok(result.optimizedTimeS < result.normalTimeS);
  assert.equal(result.optimizedTimeS, result.savedAcceptedTimeS);
  await json('launcher-verdict.json', { passed: true, status, timedOut, stableInputs, checks: result.checks.length,
    checkpoints: evidence.checkpoints.length, documents: evidence.documents.length, observer: registration,
    startedAt, endedAt: new Date().toISOString() });
} catch (error) {
  clearTimeout(timer);
  let identityFailure = null;
  try { const after = await identities(); await json('inputs-after-failure.json', after); stableInputs = Boolean(before) && JSON.stringify(before) === JSON.stringify(after); }
  catch (failure) { identityFailure = String(failure); }
  await json('launcher-verdict.json', { passed: false, failure: error.stack || String(error), status, timedOut,
    stableInputs, identityFailure, startedAt, endedAt: new Date().toISOString() });
  console.error(error.stack || error);
  process.exitCode = 1;
}
