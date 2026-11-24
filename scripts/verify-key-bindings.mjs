// Presses every default key binding in the built app (dist-renderer) with real input events, once with Windows
// labels and once with macOS labels, then checks user rules from the host, then edits keys in the shortcuts dialog. Screenshots and
// result.json go to BORDEAUX_KEY_BINDINGS_OUTPUT (or a temp folder).
// Usage: npm run verify:renderer && node scripts/verify-key-bindings.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';

const output = process.env.BORDEAUX_KEY_BINDINGS_OUTPUT ? path.resolve(process.env.BORDEAUX_KEY_BINDINGS_OUTPUT) : await fs.mkdtemp(path.join(os.tmpdir(), 'bordeaux-key-bindings-'));
console.log(`Key binding artifacts: ${output}`);
// The third run's host returns user rules: Place waypoint on Q and Save on mod+Shift+K.
const userRules = JSON.stringify([{ key: 'q', command: 'tool.waypoint', when: 'pathsPage' }, { key: 'mod+shift+k', command: 'project.save' }]);
for (const [name, platform, rules, mode] of [['win32', 'win32', ''], ['darwin', 'darwin', ''], ['user-rules', 'win32', userRules], ['editing', 'win32', '', 'editing']]) {
  const runOutput = path.join(output, name);
  await fs.mkdir(runOutput, { recursive: true });
  const env = { ...process.env, BORDEAUX_KEYS_OUTPUT: runOutput, BORDEAUX_KEYS_PLATFORM: platform, BORDEAUX_KEYS_RULES: rules, BORDEAUX_KEYS_MODE: mode || '', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve) => {
    const child = spawn(electron, ['scripts/verify-key-bindings-electron.cjs'], { env, stdio: 'inherit' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.on('exit', (exit) => { clearTimeout(timer); resolve(exit); });
  });
  if (code !== 0) { console.error(`FAIL ${name}`); process.exit(1); }
}
