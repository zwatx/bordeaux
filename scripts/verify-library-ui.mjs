import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { build } from 'vite';
const output = process.env.BORDEAUX_LIBRARY_UI_OUTPUT ? path.resolve(process.env.BORDEAUX_LIBRARY_UI_OUTPUT) : await fs.mkdtemp(path.join(os.tmpdir(), 'bordeaux-library-ui-'));
await fs.mkdir(output, { recursive: true });
// Legacy activation is a deliberately isolated integration fixture. Production desktop
// delivery uses RobotFilePushDialog; retired revision code never enters its bundle.
const rendererOutput = path.join(output, 'legacy-renderer');
await build({
  configFile: path.resolve('vite.renderer.config.mts'),
  resolve: { alias: [{ find: '../components/RobotPushDialog', replacement: path.resolve('src/renderer/components/LegacyRobotPushDialog.jsx') }] },
  build: { outDir: rendererOutput, emptyOutDir: true },
});
const env = { ...process.env, BORDEAUX_LIBRARY_UI_OUTPUT: output,
  BORDEAUX_LIBRARY_UI_RENDERER: path.join(rendererOutput, 'index.html'), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
delete env.ELECTRON_RUN_AS_NODE;
console.log('Library UI artifacts: ' + output);
const child = spawn(electron, [path.resolve('scripts/verify-library-ui-electron.cjs')], { env, stdio: 'inherit' });
// Includes linked and folder undo scenarios that reopen the project several times.
const timer = setTimeout(() => child.kill('SIGKILL'), 240_000);
child.on('error', (error) => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
child.on('exit', (code) => { clearTimeout(timer); process.exitCode = code === 0 ? 0 : 1; });
