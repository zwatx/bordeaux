import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import electron from 'electron';
const output = process.env.BORDEAUX_BRANCH_UI_OUTPUT ? path.resolve(process.env.BORDEAUX_BRANCH_UI_OUTPUT) : await fs.mkdtemp(path.join(os.tmpdir(), 'bordeaux-command-branches-'));
await fs.mkdir(output, { recursive: true });
if ((await fs.readdir(output)).length) throw new Error('Fresh empty branch evidence directory required: ' + output);
const json = (name, value) => fs.writeFile(path.join(output, name), JSON.stringify(value, null, 2) + '\n');
async function identities() {
  const inputs = {};
  async function visit(file) {
    const item = await fs.lstat(file);
    if (item.isDirectory()) for (const name of (await fs.readdir(file)).sort()) await visit(path.join(file, name));
    else if (item.isFile()) { const data = await fs.readFile(file); inputs[file] = { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }; }
    else throw new Error('Unexpected input entry: ' + file);
  }
  for (const file of ['scripts/verify-command-branches-ui.mjs', 'scripts/verify-command-branches-ui-electron.cjs', 'scripts/verify-command-branches-ui-preload.cjs', 'scripts/verify-command-branches-ui-consequences.cjs',
    'src/renderer/app/App.jsx', 'src/renderer/components/PathPanel.jsx', 'src/renderer/components/PathTimeline.jsx', 'src/renderer/lib/commandPick.js', 'src/renderer/components/CommandBranches.jsx', 'src/renderer/components/RoutineInspector.jsx', 'src/renderer/components/ui.jsx', 'src/renderer/lib/routineModel.js', 'package.json', 'package-lock.json', 'benchmarks/planner-corpus/v1/corpus.bordeaux.json', 'dist-renderer']) await visit(file);
  return inputs;
}
const before = await identities(); await json('inputs-before.json', before);
const env = { ...process.env, BORDEAUX_BRANCH_UI_OUTPUT: output, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }; delete env.ELECTRON_RUN_AS_NODE;
console.log(`Command branch artifacts: ${output}`);
let timedOut = false;
const startedAt = new Date().toISOString();
const child = spawn(electron, ['scripts/verify-command-branches-ui-electron.cjs'], { env, stdio: 'inherit' });
const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 600000); // Expanded serial baseline +34 groups, not an assertion/interaction retry.
let status;
try {
  status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  clearTimeout(timer); await json('child-status.json', { ...status, timedOut, pid: child.pid, startedAt, endedAt: new Date().toISOString() });
  const after = await identities(); await json('inputs-after.json', after);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Branch source/harness/build inputs changed during native run');
  const result = JSON.parse(await fs.readFile(path.join(output, 'results.json'), 'utf8'));
  // BORDEAUX_BRANCH_UI_MODE=placement runs only the 11 command placement cases per supported size.
  if (process.env.BORDEAUX_BRANCH_UI_MODE === 'placement') {
    if (status.code !== 0 || timedOut || result.passed !== true || result.mode !== 'placement' || result.placement?.length !== 22 || result.placement.some(row => row.passed !== true)
      || [1440, 1100].some(width => result.placement.filter(row => row.width === width).length !== 11) || new Set(result.placement.map(row => row.width + ':' + row.name)).size !== 22
      || ![result.errors, result.confirms, result.robotCalls].every(rows => Array.isArray(rows) && rows.length === 0)) throw new Error('Placement JSON verdict failed: require native child success, 22 passing unique cases/11 per size, empty errors/confirms/robot calls');
  } else if (status.code !== 0 || timedOut || result.passed !== true || result.checks?.length !== 1 || result.scenarios?.length !== 34
    || result.scenarios.some(row => row.passed !== true) || [1440, 1100].some(width => result.scenarios.filter(row => row.width === width).length !== 17)
    || new Set(result.scenarios.map(row => row.width + ':' + row.name)).size !== 34
    || ![result.errors, result.confirms, result.robotCalls].every(rows => Array.isArray(rows) && rows.length === 0)) throw new Error('Branch JSON verdict failed: require native child success, retained baseline +34 passing unique groups/17 per size, empty errors/confirms/robot calls');
} catch (error) {
  clearTimeout(timer); let identityFailure = null; try { await json('inputs-after-failure.json', await identities()); } catch (failure) { identityFailure = failure.stack || String(failure); } await json('launcher-failure.json', { error: error.stack || String(error), status, timedOut, identityFailure }); console.error(error.stack || error); process.exitCode = 1;
}
