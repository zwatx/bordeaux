// Builds release/bordeaux_<version>_all.ipk for the SystemCore.
// Install by uploading it in the SystemCore web dashboard, or: scp it over, then `opkg install <file>`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const { version } = JSON.parse(await fs.readFile('package.json', 'utf8'));
const source = 'src/hosts/systemcore';
const work = path.resolve('release/systemcore');
const data = path.join(work, 'data'), control = path.join(work, 'control');
const ipk = path.resolve(`release/bordeaux_${version}_all.ipk`);
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });

run('npx', ['vite', 'build', '--config', 'vite.systemcore.config.mts', '--logLevel', 'warn']);
await fs.rm(work, { recursive: true, force: true });
const app = path.join(data, 'usr/local/bin/bordeaux');
await fs.mkdir(app, { recursive: true });
await fs.mkdir(path.join(data, 'etc/systemd/system'), { recursive: true });
await fs.mkdir(path.join(data, 'usr/share'), { recursive: true });
await fs.mkdir(control, { recursive: true });
await fs.copyFile(path.join(source, 'server.py'), path.join(app, 'server.py'));
await fs.cp('dist-systemcore', path.join(app, 'static'), { recursive: true });
await fs.copyFile(path.join(source, 'package/bordeaux.service'), path.join(data, 'etc/systemd/system/bordeaux.service'));
// The dashboard crops app images to a wide tile, so the square app icon sits centered on a 16:9 image.
await fs.copyFile(path.join(source, 'package/bordeaux-tile.png'), path.join(data, 'usr/share/bordeaux.png'));
await fs.writeFile(path.join(control, 'control'), (await fs.readFile(path.join(source, 'package/control'), 'utf8')).replace('@VERSION@', version));
for (const script of ['postinst', 'prerm', 'postrm']) {
  await fs.copyFile(path.join(source, 'package', script), path.join(control, script));
  await fs.chmod(path.join(control, script), 0o755);
}
await fs.writeFile(path.join(work, 'debian-binary'), '2.0\n');

// Root-owned, name-sorted and dated to the commit, so one commit always produces the same package bytes.
const epoch = execFileSync('git', ['log', '-1', '--format=%ct']).toString().trim();
// Members are named from the top-level entries, never `./` itself: opkg records every data member as a file the
// package owns, and an entry for the root folder would make it try to remove `/` on upgrade or removal.
const tar = async (folder, out) => run('tar', ['--sort=name', `--mtime=@${epoch}`, '--owner=0', '--group=0', '--numeric-owner', '--mode=u+rw,go+r,go-w', '-C', folder, '-cf', out,
  ...(await fs.readdir(folder)).sort().map((entry) => `./${entry}`)]);
await tar(control, path.join(work, 'control.tar'));
await tar(data, path.join(work, 'data.tar'));
for (const name of ['control.tar', 'data.tar']) run('gzip', ['-n', '-9', '-f', path.join(work, name)]);
await fs.rm(ipk, { force: true });
run('ar', ['rcD', ipk, 'debian-binary', 'control.tar.gz', 'data.tar.gz'], { cwd: work });
console.log(`Built ${path.relative(process.cwd(), ipk)} (${Math.round((await fs.stat(ipk)).size / 1024)} KiB)`);
