// Built-App check for touch and gesture input on the field. Screenshots and result.json go to
// BORDEAUX_FIELD_TOUCH_UI_OUTPUT (or a temp folder).
// Usage: npm run verify:renderer && node scripts/verify-field-touch-ui.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
const output = process.env.BORDEAUX_FIELD_TOUCH_UI_OUTPUT ? path.resolve(process.env.BORDEAUX_FIELD_TOUCH_UI_OUTPUT) : await fs.mkdtemp(path.join(os.tmpdir(), 'bordeaux-field-touch-'));
await fs.mkdir(output, { recursive: true });
const env = { ...process.env, BORDEAUX_FIELD_TOUCH_UI_OUTPUT: output, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
delete env.ELECTRON_RUN_AS_NODE;
console.log(`Field touch artifacts: ${output}`);
const child = spawn(electron, ['scripts/verify-field-touch-ui-electron.cjs'], { env, stdio: 'inherit' });
const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
child.on('exit', (code) => { clearTimeout(timer); process.exitCode = code === 0 ? 0 : 1; });
