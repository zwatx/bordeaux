import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function gh(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile("gh", args, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
    child.stdin.on("error", () => {}); // A rejected request may close stdin early.
    child.stdin.end(input);
  });
}

const github = {
  async request(method, endpoint, body) {
    const args = ["api", "--method", method, endpoint];
    if (body !== undefined) args.push("--input", "-");
    return JSON.parse(await gh(args, body === undefined ? undefined : JSON.stringify(body)));
  },
  async assets(repository, releaseId) {
    return JSON.parse(await gh(["api", `repos/${repository}/releases/${releaseId}/assets?per_page=100`, "--paginate", "--slurp"])).flat();
  },
  async upload(repository, tag, file) {
    // One file per process avoids concurrent uploads and never replaces an asset.
    await gh(["release", "upload", tag, file, "--repo", repository]);
  },
};

export async function localReleaseAssets(directory, version, unsignedWindows) {
  const names = (await readdir(directory)).sort();
  const prefix = `Bordeaux-${version}`;
  const required = [
    ...["arm64", "x64"].flatMap((arch) => [
      `${prefix}-mac-${arch}.dmg`, `${prefix}-mac-${arch}.zip`, `${prefix}-linux-${arch === "x64" ? "x86_64" : arch}.AppImage`,
    ]),
    `${prefix}-windows-x64-setup.exe`, `${prefix}-windows-x64-portable.exe`, `bordeaux_${version}_all.ipk`,
    "beta.yml", "beta-mac.yml", "beta-linux.yml", "beta-linux-arm64.yml", "signature-evidence-mac.json",
    ...(unsignedWindows ? [] : ["signature-evidence-windows.json"]),
  ];
  for (const name of required) {
    if (!names.includes(name)) throw new Error(`Missing release asset: ${name}`);
  }
  return Promise.all(names.map(async (name) => {
    const file = path.resolve(directory, name);
    const info = await stat(file);
    if (!info.isFile() || !info.size) throw new Error(`Invalid release asset: ${name}`);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return { name, file, size: info.size, digest: `sha256:${hash.digest("hex")}` };
  }));
}

function verifyAsset(remote, local) {
  if (remote.state !== "uploaded" || remote.size !== local.size || remote.digest !== local.digest) {
    throw new Error(`Remote asset ${local.name} does not match its verified local size and SHA-256 digest; refusing to replace it.`);
  }
}

export async function publishPrerelease({
  repository, sha, version, notes = "", unsignedWindows = false, directory = "release-assets",
  api = github, wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) throw new Error("A GitHub owner/repository is required");
  if (!/^[a-f0-9]{40}$/i.test(sha ?? "")) throw new Error("The exact release commit SHA is required");
  if (!/^\d+\.\d+\.\d+-beta\.\d+$/.test(version ?? "")) throw new Error("A beta version is required");
  const assets = await localReleaseAssets(directory, version, unsignedWindows);
  const tag = `v${version}`;
  const base = `repos/${repository}`;

  // POST is atomic: an existing tag fails rather than changing its commit.
  await api.request("POST", `${base}/git/refs`, { ref: `refs/tags/${tag}`, sha });
  const release = await api.request("POST", `${base}/releases`, {
    tag_name: tag, target_commitish: sha, name: `Bordeaux ${tag}`,
    body: notes, generate_release_notes: !notes.trim(), prerelease: true, draft: true,
  });
  if (!release.draft || release.tag_name !== tag) throw new Error("GitHub did not create the requested draft release");

  for (const asset of assets) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let uploadError;
      try {
        await api.upload(repository, tag, asset.file);
      } catch (error) {
        uploadError = error;
      }
      // A connection failure can arrive after GitHub accepted the bytes. Never
      // clobber on retry: accept only a complete, byte-identical remote asset.
      const matching = (await api.assets(repository, release.id)).filter(({ name }) => name === asset.name);
      if (matching.length > 1) throw new Error(`Duplicate remote release asset: ${asset.name}`);
      if (matching.length === 1) {
        verifyAsset(matching[0], asset);
        break;
      }
      if (attempt === 3) throw new Error(`Upload did not complete for ${asset.name}; release remains a draft.`, { cause: uploadError });
      await wait(attempt * 2000);
    }
  }

  const remoteAssets = await api.assets(repository, release.id);
  if (remoteAssets.length !== assets.length) throw new Error("Remote release asset set is incomplete or contains unexpected files");
  for (const asset of assets) {
    const matching = remoteAssets.filter(({ name }) => name === asset.name);
    if (matching.length !== 1) throw new Error(`Missing or duplicate remote release asset: ${asset.name}`);
    verifyAsset(matching[0], asset);
  }
  const current = await api.request("GET", `${base}/releases/${release.id}`);
  if (!current.draft || current.tag_name !== tag) throw new Error("Release changed before publication; refusing to modify it");
  const published = await api.request("PATCH", `${base}/releases/${release.id}`, { draft: false, prerelease: true, make_latest: "false" });
  if (published.draft || !published.prerelease) throw new Error("GitHub did not confirm prerelease publication");
  return published;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const release = await publishPrerelease({
    repository: process.env.GITHUB_REPOSITORY, sha: process.env.RELEASE_SHA,
    version: process.env.RELEASE_VERSION, notes: process.env.RELEASE_NOTES,
    unsignedWindows: process.env.UNSIGNED_WINDOWS === "true", directory: process.argv[2] ?? "release-assets",
  });
  console.log(`Published verified prerelease: ${release.html_url}`);
}
