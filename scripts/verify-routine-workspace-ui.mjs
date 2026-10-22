import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import electron from 'electron';

const output = process.env.BORDEAUX_ROUTINE_UI_OUTPUT ? path.resolve(process.env.BORDEAUX_ROUTINE_UI_OUTPUT)
  : await fs.mkdtemp(path.join(os.tmpdir(), 'bordeaux-routine-workspace-'));
await fs.mkdir(output, { recursive: true });
assert.equal((await fs.readdir(output)).length, 0, 'Use a fresh evidence directory');
const json = (name, value) => fs.writeFile(path.join(output, name), JSON.stringify(value, null, 2) + '\n');
async function identities() {
  const files = {};
  async function visit(file) {
    const stat = await fs.lstat(file);
    if (stat.isDirectory()) for (const name of (await fs.readdir(file)).sort()) await visit(path.join(file, name));
    else { assert.ok(stat.isFile()); const bytes = await fs.readFile(file); files[file] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; }
  }
  for (const file of ['src/renderer', 'src/shared', 'dist-renderer', 'scripts/verify-routine-workspace-ui.mjs',
    'scripts/verify-routine-workspace-ui-electron.cjs', 'scripts/verify-command-branches-ui-preload.cjs',
    'package.json', 'package-lock.json', 'benchmarks/planner-corpus/v2/corpus.bordeaux.json']) await visit(file);
  return files;
}
const before = await identities(); await json('inputs-before.json', before);
const env = { ...process.env, BORDEAUX_BRANCH_UI_OUTPUT: output, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
delete env.ELECTRON_RUN_AS_NODE;
console.log('Routine workspace artifacts: ' + output);
const child = spawn(electron, ['scripts/verify-routine-workspace-ui-electron.cjs'], { env, stdio: 'inherit' });
let timedOut = false;
const startedAt = new Date().toISOString();
const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 180000);
let status;
try {
  status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ pid: child.pid, code, signal })); });
  clearTimeout(timer);
  await json('child-status.json', { ...status, timedOut, startedAt, endedAt: new Date().toISOString() });
  const after = await identities(); await json('inputs-after.json', after);
  assert.deepEqual(after, before, 'Source/build/harness must stay unchanged during the run');
  assert.equal(timedOut, false); assert.equal(status.code, 0); assert.equal(status.signal, null);
  const result = JSON.parse(await fs.readFile(path.join(output, 'result.json'), 'utf8'));
  assert.equal(result.passed, true);
  assert.equal(result.scenarios.length, 2);
  assert.deepEqual(result.scenarios.map(row => row.width), [1440, 1100]);
  assert.ok(result.scenarios.every(row => row.passed));
  for (const key of ['errors', 'confirms', 'robotCalls']) assert.deepEqual(result[key], []);
  await json('launcher-verdict.json', { passed: true, status, timedOut, stableInputs: true });
} catch (error) {
  clearTimeout(timer);
  const after = await identities(); await json('inputs-after-failure.json', after);
  await json('launcher-verdict.json', { passed: false, status, timedOut, stableInputs: JSON.stringify(before) === JSON.stringify(after), error: String(error.stack || error) });
  console.error(error); process.exitCode = 1;
}
