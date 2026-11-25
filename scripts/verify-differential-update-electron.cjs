// Electron half of verify-differential-update.mjs. Mirrors AppUpdater.differentialDownloadInstaller:
// the provider resolves the latest installer, electron-updater picks both blockmaps from its URL,
// and GenericDifferentialDownloader rebuilds the new installer from the old one plus changed ranges.
// The downloader checks the manifest SHA-512, so a wrong block fails the run.
const { app } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');

const root = process.env.BORDEAUX_ROOT;
const output = process.env.BORDEAUX_UPDATE_OUTPUT;
const platform = process.env.BORDEAUX_UPDATE_PLATFORM || 'win32';
const { CancellationToken } = require(path.join(root, 'node_modules/builder-util-runtime'));
const { ElectronHttpExecutor } = require(path.join(root, 'node_modules/electron-updater/out/electronHttpExecutor'));
const { GenericDifferentialDownloader } = require(path.join(root, 'node_modules/electron-updater/out/differentialDownloader/GenericDifferentialDownloader'));
const { FileWithEmbeddedBlockMapDifferentialDownloader } = require(path.join(root, 'node_modules/electron-updater/out/differentialDownloader/FileWithEmbeddedBlockMapDifferentialDownloader'));
const { GitHubReleaseProvider } = require(path.join(root, 'dist-electron/electron/githubReleaseProvider'));

const lines = [];
const logger = { info: m => lines.push(`info ${m}`), warn: m => lines.push(`warn ${m}`), error: m => lines.push(`error ${m}`) };

async function run() {
  const executor = new ElectronHttpExecutor();
  const provider = new GitHubReleaseProvider({ channel: 'beta' }, { channel: 'beta', allowPrerelease: true }, { platform, executor, isUseMultipleRangeRequest: false });
  const latest = await provider.getLatestVersion();
  const file = provider.resolveFiles(latest)[0];
  const from = process.env.BORDEAUX_UPDATE_FROM || `${latest.version.replace(/\.(\d+)$/, (_, n) => `.${Number(n) - 1}`)}`;
  const escaped = latest.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const oldUrl = new URL(file.url.href.replace(new RegExp(escaped, 'g'), from));
  const oldFile = path.join(output, path.basename(oldUrl.pathname));
  const newFile = path.join(output, path.basename(file.url.pathname));
  if (!(await fs.stat(oldFile).catch(() => null))) {
    console.log(`Downloading installed version ${from}: ${oldUrl.href}`);
    await executor.download(oldUrl, oldFile, { cancellationToken: new CancellationToken() });
  }
  await fs.rm(newFile, { force: true });

  let transferred = 0;
  const options = {
    newUrl: file.url, oldFile, newFile, logger, requestHeaders: {}, cancellationToken: new CancellationToken(),
    isUseMultipleRangeRequest: provider.isUseMultipleRangeRequest,
    onProgress: progress => { transferred = progress.transferred; },
  };
  const started = Date.now();
  let blockmaps = null;
  if (platform === 'linux') {
    // AppImages embed their blockmap; electron-updater reads the old one from the running file.
    await new FileWithEmbeddedBlockMapDifferentialDownloader(file.info, executor, options).download();
  } else {
    blockmaps = (await provider.getBlockMapFiles(file.url, from, latest.version)).map(url => url.href);
    const read = async url => JSON.parse(zlib.gunzipSync(await executor.downloadToBuffer(new URL(url), { cancellationToken: new CancellationToken() })).toString());
    const [oldMap, newMap] = await Promise.all(blockmaps.map(read));
    await new GenericDifferentialDownloader(file.info, executor, options).download(oldMap, newMap);
  }
  const seconds = (Date.now() - started) / 1000;
  const size = (await fs.stat(newFile)).size;
  const sha512 = createHash('sha512').update(await fs.readFile(newFile)).digest('base64');
  const report = {
    platform, from, to: latest.version, installer: file.url.href, blockmaps,
    installerBytes: size, manifestBytes: file.info.size, sha512MatchesManifest: sha512 === file.info.sha512,
    plan: lines.find(line => line.includes('To download')) ?? null,
    downloadedBytes: transferred, seconds,
  };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(path.join(output, 'updater.log'), lines.join('\n') + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (!report.sha512MatchesManifest) throw new Error('Rebuilt installer does not match the manifest SHA-512.');
}

app.whenReady().then(run).then(() => app.exit(0), async error => {
  console.error(error);
  await fs.writeFile(path.join(output, 'updater.log'), lines.join('\n') + `\n${error.stack || error}\n`).catch(() => undefined);
  app.exit(1);
});
