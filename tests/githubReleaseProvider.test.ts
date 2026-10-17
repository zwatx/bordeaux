import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubReleaseProvider } from "../src/electron/githubReleaseProvider";
import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider";

const base = "https://api.github.com/repos/zwatx/bordeaux/releases";
const checksum = Buffer.alloc(64, 7).toString("base64");
const asset = (name: string, id: number) => ({ name, url: `${base}/assets/${id}` });
const release = (version: string, name = "beta-mac.yml", extra = {}) => ({
  tag_name: `v${version}`, draft: false, prerelease: version.includes("-"),
  assets: [asset(name, 1), asset("Bordeaux-arm64.zip", 2), asset("Bordeaux-x64.zip", 3), asset("Bordeaux.dmg", 4)], ...extra,
});
const manifest = (version = "1.0.0-beta.2", names = ["Bordeaux.dmg", "Bordeaux-arm64.zip", "Bordeaux-x64.zip"]) => JSON.stringify({
  version, files: names.map(url => ({ url, sha512: checksum, size: 123 })),
});
function setup(releases = [release("1.0.0-beta.2")], raw = manifest(), platform: ProviderRuntimeOptions["platform"] = "darwin", channel = "beta") {
  const request = vi.fn().mockResolvedValueOnce(JSON.stringify(releases)).mockResolvedValueOnce(raw);
  const provider = new GitHubReleaseProvider({ channel }, { channel: null, allowPrerelease: channel === "beta" }, {
    platform, isUseMultipleRangeRequest: true, executor: { request } as unknown as ProviderRuntimeOptions["executor"],
  });
  return { provider, request };
}
afterEach(() => vi.unstubAllEnvs());
describe("public GitHub API release provider", () => {
  it("accepts canonical zwatx asset URLs after the repository owner rename and preserves both checked Mac ZIPs", async () => {
    const { provider, request } = setup();
    const info = await provider.getLatestVersion();
    const files = provider.resolveFiles(info);
    expect(files.map(file => file.info.url)).toEqual(["Bordeaux-arm64.zip", "Bordeaux-x64.zip"]);
    expect(files.every(file => file.info.sha512 === checksum)).toBe(true);
    expect(files[0].url.href).toBe(`${base}/assets/2`);
    expect(request.mock.calls[0][0]).toMatchObject({ hostname: "api.github.com", path: "/repos/zwatx/bordeaux/releases?per_page=100&page=1", headers: { Accept: "application/vnd.github+json" } });
    expect(request.mock.calls[1][0]).toMatchObject({ path: "/repos/zwatx/bordeaux/releases/assets/1", headers: { Accept: "application/octet-stream" } });
    expect(provider.fileExtraDownloadHeaders.Accept).toBe("application/octet-stream");
    expect(provider.isUseMultipleRangeRequest).toBe(false);
  });
  it("stable ignores beta, draft, and prerelease-marked stable tags", async () => {
    const { provider } = setup([release("3.0.0-beta.1"), release("2.0.0", "latest-mac.yml", { draft: true }), release("1.9.0", "latest-mac.yml", { prerelease: true }), release("1.0.0", "latest-mac.yml")], manifest("1.0.0"), "darwin", "latest");
    expect((await provider.getLatestVersion()).version).toBe("1.0.0");
  });
  it("uses release notes and name from the API when the manifest omits them", async () => {
    const { provider } = setup([release("1.0.0-beta.2", undefined, { body: "## Fixed\n- Project saving", name: "Bordeaux beta 2" })]);
    expect(await provider.getLatestVersion()).toMatchObject({ releaseNotes: "## Fixed\n- Project saving", releaseName: "Bordeaux beta 2" });
    const explicit = JSON.stringify({ ...JSON.parse(manifest()), releaseNotes: "Manifest notes", releaseName: "Manifest name" });
    expect(await setup([release("1.0.0-beta.2", undefined, { body: "API notes", name: "API name" })], explicit).provider.getLatestVersion())
      .toMatchObject({ releaseNotes: "Manifest notes", releaseName: "Manifest name" });
    expect((await setup().provider.getLatestVersion()).releaseName).toBe("v1.0.0-beta.2");
  });
  it("does not admit beta releases when prereleases are disabled even with a beta channel", async () => {
    const request = vi.fn().mockResolvedValueOnce(JSON.stringify([release("2.0.0-beta.1"), release("1.0.0", "latest-mac.yml")])).mockResolvedValueOnce(manifest("1.0.0"));
    const provider = new GitHubReleaseProvider({ channel: "beta" }, { channel: null, allowPrerelease: false }, {
      platform: "darwin", isUseMultipleRangeRequest: false, executor: { request } as unknown as ProviderRuntimeOptions["executor"],
    });
    expect((await provider.getLatestVersion()).version).toBe("1.0.0");
  });
  it("sorts beta numerically, excludes other prereleases, and graduates to stable", async () => {
    const releases = [release("1.0.0-beta.9"), release("1.0.0-beta.10"), release("4.0.0-alpha.1")];
    expect((await setup(releases, manifest("1.0.0-beta.10")).provider.getLatestVersion()).version).toBe("1.0.0-beta.10");
    expect((await setup([...releases, release("1.0.0", "latest-mac.yml")], manifest("1.0.0")).provider.getLatestVersion()).version).toBe("1.0.0");
  });
  it.each([["win32", "x64", "beta.yml", "Bordeaux-setup.exe"], ["linux", "x64", "beta-linux.yml", "Bordeaux-x64.AppImage"], ["linux", "arm64", "beta-linux-arm64.yml", "Bordeaux-arm64.AppImage"]] as const)("selects %s/%s manifest and installer", async (platform, arch, name, installer) => {
    vi.stubEnv("TEST_UPDATER_ARCH", arch);
    const { provider } = setup([release("1.0.0-beta.2", name, { assets: [asset(name, 1), asset(installer, 2)] })], manifest("1.0.0-beta.2", [installer]), platform);
    expect(provider.resolveFiles(await provider.getLatestVersion())[0].info.url).toBe(installer);
  });
  it("paginates without trusting publication order", async () => {
    const { provider, request } = setup();
    request.mockReset().mockResolvedValueOnce(JSON.stringify(Array.from({ length: 100 }, () => release("0.1.0-beta.1"))))
      .mockResolvedValueOnce(JSON.stringify([release("1.0.0-beta.2")])).mockResolvedValueOnce(manifest());
    expect((await provider.getLatestVersion()).version).toBe("1.0.0-beta.2");
    expect(request.mock.calls[1][0].path).toContain("page=2");
  });
  it.each([undefined, "", "invalid"])("rejects missing or invalid checksum %s", async sha512 => {
    const { provider } = setup(undefined, JSON.stringify({ version: "1.0.0-beta.2", files: [{ url: "Bordeaux-arm64.zip", sha512 }] }));
    await expect(provider.getLatestVersion()).rejects.toThrow("SHA-512");
  });
  it("rejects mismatched release/manifest versions without falling back", async () => {
    const { provider, request } = setup(undefined, manifest("0.0.1"));
    await expect(provider.getLatestVersion()).rejects.toThrow("does not match");
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each([
    "https://evil.test/1",
    "https://api.github.com/repos/other/bordeaux/releases/assets/1",
    "https://api.github.com/repos/Zw96042/bordeaux/releases/assets/1",
    "https://api.github.com/repos/zwatx/other/releases/assets/1",
    "https://api.github.com/repos/zwatx/bordeaux/releases/assets/1?redirect=evil",
    "https://api.github.com/repos/zwatx/bordeaux/releases/assets/1#fragment",
    "https://user:password@api.github.com/repos/zwatx/bordeaux/releases/assets/1",
  ])("rejects off-repository manifest %s before requesting it", async url => {
    const { provider, request } = setup([release("1.0.0-beta.2", undefined, { assets: [{ name: "beta-mac.yml", url }] })]);
    await expect(provider.getLatestVersion()).rejects.toThrow("Untrusted");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("rejects off-repository installer and filename traversal", async () => {
    const badRelease = release("1.0.0-beta.2");
    badRelease.assets[1].url = "https://api.github.com/repos/other/bordeaux/releases/assets/2";
    await expect(setup([badRelease]).provider.getLatestVersion()).rejects.toThrow("Untrusted");
    await expect(setup(undefined, manifest("1.0.0-beta.2", ["../Bordeaux.zip"])).provider.getLatestVersion()).rejects.toThrow("filename");
  });
});
