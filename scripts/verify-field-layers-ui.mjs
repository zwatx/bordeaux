// Built-App check for the field's Layers menu and the AprilTag layer. Screenshots and result.json go to
// BORDEAUX_FIELD_LAYERS_UI_OUTPUT (or a temp folder).
// Usage: npm run verify:renderer && node scripts/verify-field-layers-ui.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
const output = process.env.BORDEAUX_FIELD_LAYERS_UI_OUTPUT ? path.resolve(process.env.BORDEAUX_FIELD_LAYERS_UI_OUTPUT) : await fs.mkdtemp(path.join(os.tmpdir(), 'bordeaux-field-layers-'));
await fs.mkdir(output, { recursive: true });
const env = { ...process.env, BORDEAUX_FIELD_LAYERS_UI_OUTPUT: output, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
delete env.ELECTRON_RUN_AS_NODE;
console.log(`Field layers artifacts: ${output}`);
const child = spawn(electron, ['scripts/verify-field-layers-ui-electron.cjs'], { env, stdio: 'inherit' });
const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
child.on('exit', (code) => { clearTimeout(timer); process.exitCode = code === 0 ? 0 : 1; });
