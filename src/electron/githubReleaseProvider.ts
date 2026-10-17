import type { AppUpdater } from "electron-updater";
import { Provider, getFileList, parseUpdateInfo, type ProviderRuntimeOptions } from "electron-updater/out/providers/Provider";
import { valid, prerelease, rcompare } from "semver";

const RELEASES_API = "https://api.github.com/repos/zwatx/bordeaux/releases";
const JSON_HEADERS = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
const ASSET_HEADERS = { Accept: "application/octet-stream", "X-GitHub-Api-Version": "2022-11-28" };
type UpdateInfo = ReturnType<typeof parseUpdateInfo>;
type Asset = { name: string; url: string };
type Release = { tag_name: string; draft: boolean; prerelease: boolean; assets: Asset[]; body?: string; name?: string };
type ReleaseUpdateInfo = UpdateInfo & { assets: Asset[] };

function assetUrl(asset: Asset): URL {
  const url = new URL(asset.url);
  if (url.origin !== "https://api.github.com" || url.username || url.password || url.search || url.hash
      || !/^\/repos\/zwatx\/bordeaux\/releases\/assets\/\d+$/.test(url.pathname)) {
    throw new Error(`Untrusted update asset URL for ${asset.name}.`);
  }
  return url;
}

/** Public GitHub API transport; installation and signature/checksum checks stay in electron-updater. */
export class GitHubReleaseProvider extends Provider<ReleaseUpdateInfo> {
  constructor(
    private readonly options: { provider?: "custom"; channel?: string },
    private readonly updater: Pick<AppUpdater, "channel" | "allowPrerelease">,
    private readonly platformOptions: ProviderRuntimeOptions,
  ) {
    super({ ...platformOptions, isUseMultipleRangeRequest: false });
  }

  override get fileExtraDownloadHeaders() { return ASSET_HEADERS; }

  async getLatestVersion(): Promise<ReleaseUpdateInfo> {
    const channel = this.updater.channel ?? this.options.channel ?? (this.updater.allowPrerelease ? "beta" : "latest");
    if (channel !== "beta" && channel !== "latest") throw new Error(`Unsupported update channel: ${channel}.`);
    const releases: Release[] = [];
    // Paginate instead of trusting publication order (old versions can be published later).
    for (let page = 1; ; page++) {
      if (page > 20) throw new Error("Too many GitHub releases to safely select an update.");
      const raw = await this.httpRequest(new URL(`${RELEASES_API}?per_page=100&page=${page}`), JSON_HEADERS);
      const batch: unknown = JSON.parse(raw ?? "null");
      if (!Array.isArray(batch)) throw new Error("Invalid GitHub releases response.");
      releases.push(...batch);
      if (batch.length < 100) break;
    }
    const candidates = releases.filter(release => {
      if (!release || release.draft || typeof release.tag_name !== "string" || !valid(release.tag_name)) return false;
      const pre = prerelease(release.tag_name);
      if (!pre) return !release.prerelease;
      return channel === "beta" && this.updater.allowPrerelease && pre[0] === "beta";
    }).sort((a, b) => rcompare(a.tag_name, b.tag_name));
    const release = candidates[0];
    if (!release) throw new Error(`No ${channel} Bordeaux release is available.`);
    if (!Array.isArray(release.assets)) throw new Error("Release assets are missing.");
    // A stable graduation uses the stable manifest, never an unrelated release's beta manifest.
    const channelName = prerelease(release.tag_name) ? this.getCustomChannelName("beta") : this.getDefaultChannelName();
    const manifestName = `${channelName}.yml`;
    const manifest = release.assets.find(asset => asset.name === manifestName);
    if (!manifest) throw new Error(`Release ${release.tag_name} is missing ${manifestName}.`);
    const url = assetUrl(manifest);
    const info = parseUpdateInfo(await this.httpRequest(url, ASSET_HEADERS), manifestName, url);
    if (!info || valid(info.version) !== valid(release.tag_name)) throw new Error("Update manifest version does not match its release tag.");
    const result = {
      ...info,
      releaseNotes: info.releaseNotes ?? release.body,
      releaseName: info.releaseName ?? release.name ?? release.tag_name,
      assets: release.assets,
    };
    this.resolveFiles(result);
    return result;
  }

  resolveFiles(info: ReleaseUpdateInfo) {
    const extension = this.platformOptions.platform === "darwin" ? ".zip"
      : this.platformOptions.platform === "win32" ? ".exe" : ".appimage";
    const files = getFileList(info).filter(file => typeof file.url === "string" && file.url.toLowerCase().endsWith(extension));
    if (files.length === 0) throw new Error(`Update manifest has no ${extension} installer.`);
    return files.map(file => {
      // Only exact filenames from the reviewed manifest may be resolved to this release's assets.
      if (!file.url || /[/\\?#]/.test(file.url)) throw new Error("Invalid update artifact filename.");
      if (typeof file.sha512 !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512)) {
        throw new Error(`Update artifact ${file.url} has no valid SHA-512 checksum.`);
      }
      const asset = info.assets.find(item => item.name === file.url);
      if (!asset) throw new Error(`Release is missing update artifact ${file.url}.`);
      return { url: assetUrl(asset), info: file };
    });
  }
}
