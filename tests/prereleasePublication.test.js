import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localReleaseAssets, publishPrerelease } from "../scripts/publish-prerelease.mjs";

const directories = [];
const version = "0.2.0-beta.99";
const tag = `v${version}`;
const sha = "a".repeat(40);
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bordeaux-publication-"));
  directories.push(directory);
  const names = [
    ...["dmg", "zip", "dmg.blockmap", "zip.blockmap"].map((ext) => `Bordeaux-${version}-mac-arm64.${ext}`),
    ...["arm64", "x86_64"].map((arch) => `Bordeaux-${version}-linux-${arch}.AppImage`),
    ...["setup", "portable"].map((kind) => `Bordeaux-${version}-windows-x64-${kind}.exe`), `bordeaux_${version}_all.ipk`,
    "beta.yml", "beta-mac.yml", "beta-linux.yml", "beta-linux-arm64.yml", "signature-evidence-mac.json", "signature-evidence-windows.json",
  ];
  await Promise.all(names.map((name) => writeFile(path.join(directory, name), `contents:${name}`)));
  const calls = [];
  let uploaded = [];
  let draft = true;
  const api = {
    async request(method, endpoint, body) {
      calls.push({ method, endpoint, body });
      if (endpoint.endsWith("/git/refs")) return {};
      if (method === "PATCH") draft = false;
      return { id: 42, draft, tag_name: tag, prerelease: true, html_url: "https://github.com/example/project/releases/tag/example" };
    },
    async upload(repository, receivedTag, file) {
      expect(receivedTag).toBe(tag);
      const bytes = await readFile(file);
      uploaded.push({ name: path.basename(file), size: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, state: "uploaded" });
    },
    async assets() { return uploaded; },
  };
  return { directory, api, calls, names, options: { repository: "example/project", sha, version, directory, api, wait: async () => {} } };
}

describe("prerelease publication", () => {
  it("creates an exact-SHA tag and draft, uploads serially, verifies all bytes, then publishes", async () => {
    const f = await fixture();
    const originalUpload = f.api.upload;
    let uploading = false;
    f.api.upload = async (...args) => {
      expect(uploading).toBe(false);
      uploading = true;
      expect(f.calls.some(({ method }) => method === "PATCH")).toBe(false);
      await originalUpload(...args);
      await new Promise((resolve) => setTimeout(resolve, 1));
      uploading = false;
    };
    await expect(publishPrerelease(f.options)).resolves.toMatchObject({ draft: false, prerelease: true });
    expect(f.calls[0]).toMatchObject({ method: "POST", body: { ref: `refs/tags/${tag}`, sha } });
    expect(f.calls[1]).toMatchObject({ method: "POST", body: { draft: true, prerelease: true, generate_release_notes: true } });
    expect(f.calls.at(-1)).toMatchObject({ method: "PATCH", body: { draft: false, prerelease: true, make_latest: "false" } });
    expect(await f.api.assets()).toHaveLength(f.names.length);
  });

  it("accepts an ambiguous upload only when GitHub has the same size and SHA-256", async () => {
    const f = await fixture();
    const originalUpload = f.api.upload;
    let uploads = 0;
    f.api.upload = async (...args) => {
      uploads += 1;
      await originalUpload(...args);
      throw new Error("HTTP 422: ReleaseAsset.name already exists");
    };
    await publishPrerelease(f.options);
    expect(uploads).toBe(f.names.length);
  });

  it.each([
    ["wrong size", { size: 1 }],
    ["wrong digest", { digest: `sha256:${"b".repeat(64)}` }],
    ["missing digest", { digest: null }],
    ["unfinished upload", { state: "starter" }],
  ])("keeps the draft and never replaces an asset with %s", async (_label, changes) => {
    const f = await fixture();
    const originalUpload = f.api.upload;
    let uploads = 0;
    f.api.upload = async (...args) => {
      uploads += 1;
      await originalUpload(...args);
      Object.assign((await f.api.assets())[0], changes);
      throw new Error("connection closed");
    };
    await expect(publishPrerelease(f.options)).rejects.toThrow(/refusing to replace/);
    expect(uploads).toBe(1);
    expect(f.calls.some(({ method }) => method === "PATCH")).toBe(false);
  });

  it("retries absent uploads within a bounded limit", async () => {
    const f = await fixture();
    const originalUpload = f.api.upload;
    let attempts = 0;
    f.api.upload = async (...args) => {
      attempts += 1;
      if (attempts <= 2) throw new Error("temporary connection failure");
      await originalUpload(...args);
    };
    await publishPrerelease(f.options);
    expect(attempts).toBe(f.names.length + 2);
  });

  it("leaves failed uploads unpublished after three attempts", async () => {
    const f = await fixture();
    let attempts = 0;
    f.api.upload = async () => { attempts += 1; throw new Error("unavailable"); };
    await expect(publishPrerelease(f.options)).rejects.toThrow(/release remains a draft/);
    expect(attempts).toBe(3);
    expect(f.calls.some(({ method }) => method === "PATCH")).toBe(false);
  });

  it("refuses an existing tag before creating or mutating any release", async () => {
    const f = await fixture();
    let requests = 0;
    f.api.request = async () => { requests += 1; throw new Error("Reference already exists"); };
    await expect(publishPrerelease(f.options)).rejects.toThrow(/Reference already exists/);
    expect(requests).toBe(1);
    expect(await f.api.assets()).toHaveLength(0);
  });

  it("requires every platform and signed Windows evidence unless explicitly exempted", async () => {
    const f = await fixture();
    await rm(path.join(f.directory, "signature-evidence-windows.json"));
    await expect(publishPrerelease(f.options)).rejects.toThrow(/Missing release asset/);
    expect(f.calls).toHaveLength(0);
    await expect(localReleaseAssets(f.directory, version, true)).resolves.toHaveLength(f.names.length - 1);
    await rm(path.join(f.directory, "beta-linux-arm64.yml"));
    await expect(localReleaseAssets(f.directory, version, true)).rejects.toThrow(/beta-linux-arm64/);
  });

  it("requires the SystemCore package", async () => {
    const f = await fixture();
    await rm(path.join(f.directory, `bordeaux_${version}_all.ipk`));
    await expect(publishPrerelease(f.options)).rejects.toThrow(`Missing release asset: bordeaux_${version}_all.ipk`);
    expect(f.calls).toHaveLength(0);
  });

  it.each(["dmg", "zip"])("requires the Apple Silicon %s before creating the tag", async (extension) => {
    const f = await fixture();
    const missing = `Bordeaux-${version}-mac-arm64.${extension}`;
    await rm(path.join(f.directory, missing));
    await expect(publishPrerelease(f.options)).rejects.toThrow(`Missing macOS release asset: ${missing}`);
    expect(f.calls).toHaveLength(0);
  });

  it.each(["x64.dmg", "universal.zip", "x64.zip.blockmap"])("rejects an unexpected Mac asset %s before creating the tag", async (suffix) => {
    const f = await fixture();
    const extra = `Bordeaux-${version}-mac-${suffix}`;
    await writeFile(path.join(f.directory, extra), "unexpected asset");
    await expect(publishPrerelease(f.options)).rejects.toThrow(`Unexpected macOS release asset for Apple Silicon: ${extra}`);
    expect(f.calls).toHaveLength(0);
  });

  it("rechecks the complete set before making it public", async () => {
    const f = await fixture();
    const originalAssets = f.api.assets;
    let reads = 0;
    f.api.assets = async () => {
      reads += 1;
      const assets = await originalAssets();
      return reads > f.names.length ? assets.slice(1) : assets;
    };
    await expect(publishPrerelease(f.options)).rejects.toThrow(/asset set is incomplete/);
    expect(f.calls.some(({ method }) => method === "PATCH")).toBe(false);
  });

  it("refuses to modify a release published by another actor during upload", async () => {
    const f = await fixture();
    const originalRequest = f.api.request;
    f.api.request = async (...args) => {
      const result = await originalRequest(...args);
      return args[0] === "GET" ? { ...result, draft: false } : result;
    };
    await expect(publishPrerelease(f.options)).rejects.toThrow(/Release changed before publication/);
    expect(f.calls.some(({ method }) => method === "PATCH")).toBe(false);
  });
});
