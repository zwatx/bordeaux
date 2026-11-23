// Builds release/bordeaux_<version>_all.ipk for the SystemCore.
// Install by uploading it in the SystemCore web dashboard, or: scp it over, then `opkg install <file>`.
// The tar, gzip and ar containers are written here, so the build needs no GNU tar or ar, and file modes come from
// this script rather than the file system, so the bytes don't depend on the packager's OS or umask.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const { version } = JSON.parse(await fs.readFile('package.json', 'utf8'));
const source = 'src/hosts/systemcore';
const work = path.resolve('release/systemcore');
const data = path.join(work, 'data'), control = path.join(work, 'control');
const ipk = path.resolve(`release/bordeaux_${version}_all.ipk`);
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });

// Windows runs npx through its .cmd shim, which needs a shell.
run('npx', ['vite', 'build', '--config', 'vite.systemcore.config.mts', '--logLevel', 'warn'], { shell: process.platform === 'win32' });
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
// The package redistributes Bordeaux and its fonts, so it carries their notices (RIGHTS.md), as the desktop app does.
const notices = ['LICENSE', 'NOTICE', 'RIGHTS.md', 'licenses/OFL-1.1.txt'];
for (const file of notices) {
  const target = path.join(data, 'usr/share/doc/bordeaux', file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(file, target);
}
await fs.writeFile(path.join(control, 'control'), (await fs.readFile(path.join(source, 'package/control'), 'utf8')).replace('@VERSION@', version));
// opkg runs these directly, so they are the package's only executable files.
const scripts = ['postinst', 'prerm', 'postrm'];
for (const script of scripts) await fs.copyFile(path.join(source, 'package', script), path.join(control, script));

// Root-owned, name-sorted and dated to the commit, so one commit always produces the same package bytes. Folders and
// the control scripts are 0755 and every other file 0644, so the systemcore user can reach the server.
const epoch = Number(execFileSync('git', ['log', '-1', '--format=%ct']).toString().trim());

/** A ustar header field: NUL-padded text, or a zero-padded octal number with a trailing NUL. */
function field(block, offset, length, value) {
  const text = typeof value === 'number' ? value.toString(8).padStart(length - 1, '0') : value;
  if (Buffer.byteLength(text) > (typeof value === 'number' ? length - 1 : length)) throw new Error(`Tar field too long: ${text}`);
  block.write(text, offset, length, 'utf8');
}
function tarHeader(name, mode, size, type) {
  const block = Buffer.alloc(512);
  let prefix = '', rest = name;
  if (Buffer.byteLength(name) > 100) {
    // ustar keeps a long path as prefix + '/' + name, split at a folder boundary.
    const split = [...name.matchAll(/\//g)].map((match) => match.index)
      .find((index) => index <= 155 && index < name.length - 1 && Buffer.byteLength(name.slice(index + 1)) <= 100);
    if (split === undefined) throw new Error(`Path too long for the package: ${name}`);
    prefix = name.slice(0, split); rest = name.slice(split + 1);
  }
  field(block, 0, 100, rest);
  field(block, 100, 8, mode);
  field(block, 108, 8, 0);
  field(block, 116, 8, 0);
  field(block, 124, 12, size);
  field(block, 136, 12, epoch);
  block.fill(' ', 148, 156);
  block.write(type, 156, 1);
  block.write('ustar\0' + '00', 257, 8, 'latin1');
  field(block, 345, 155, prefix);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1');
  return block;
}
/** Members are named from the top-level entries, never `./` itself: opkg records every data member as a file the
 * package owns, and an entry for the root folder would make it try to remove `/` on upgrade or removal. */
async function tar(folder, executables = []) {
  const blocks = [];
  const add = async (relative) => {
    const full = path.join(folder, relative), stat = await fs.lstat(full), name = './' + relative.split(path.sep).join('/');
    if (stat.isDirectory()) {
      blocks.push(tarHeader(name + '/', 0o755, 0, '5'));
      for (const entry of (await fs.readdir(full)).sort()) await add(path.join(relative, entry));
    } else if (stat.isFile()) {
      const contents = await fs.readFile(full);
      blocks.push(tarHeader(name, executables.includes(relative) ? 0o755 : 0o644, contents.length, '0'), contents, Buffer.alloc((512 - contents.length % 512) % 512));
    } else throw new Error(`Only files and folders can be packaged: ${full}`);
  };
  for (const entry of (await fs.readdir(folder)).sort()) await add(entry);
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
/** gzip without a name or time; the OS byte is fixed to Unix so every platform writes the same header. */
function gzip(bytes) {
  const out = gzipSync(bytes, { level: 9 });
  out[9] = 3;
  return out;
}
/** The ar container opkg and dpkg read: fixed member order, zero times and owners. */
function ar(members) {
  const parts = [Buffer.from('!<arch>\n')];
  for (const [name, contents] of members) {
    const header = name.padEnd(16) + '0'.padEnd(12) + '0'.padEnd(6) + '0'.padEnd(6) + '100644'.padEnd(8) + String(contents.length).padEnd(10) + '`\n';
    parts.push(Buffer.from(header, 'latin1'), contents, ...(contents.length % 2 ? [Buffer.from('\n')] : []));
  }
  return Buffer.concat(parts);
}

const dataTar = await tar(data);
for (const file of notices) {
  if (!dataTar.includes(Buffer.from(`./usr/share/doc/bordeaux/${file}`))) throw new Error(`The package is missing ${file}`);
}
await fs.rm(ipk, { force: true });
await fs.writeFile(ipk, ar([['debian-binary', Buffer.from('2.0\n')], ['control.tar.gz', gzip(await tar(control, scripts))], ['data.tar.gz', gzip(dataTar)]]));
console.log(`Built ${path.relative(process.cwd(), ipk)} (${Math.round((await fs.stat(ipk)).size / 1024)} KiB)`);
