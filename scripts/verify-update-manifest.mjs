import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { macReleaseArtifactNames } from "./mac-release-assets.mjs";

const packageManifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

async function digest(file, algorithm, encoding) {
  const hash = createHash(algorithm);
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest(encoding);
}

export async function verifyUpdateManifest({
  platform,
  outputDirectory = "release",
  channel = "beta",
  expectedVersion = packageManifest.version,
}) {
  if (channel !== "beta" && channel !== "latest") throw new Error("Update channel must be beta or latest");
  const manifestName = platform === "mac"
    ? `${channel}-mac.yml`
    : platform === "windows"
      ? `${channel}.yml`
      : platform === "linux"
        ? `${channel}-linux.yml`
        : platform === "linux-arm64"
          ? `${channel}-linux-arm64.yml`
          : null;
  const expectedExtension = platform === "mac" ? ".zip" : platform === "windows" ? ".exe" : platform?.startsWith("linux") ? ".AppImage" : null;

  if (!manifestName || !expectedExtension) throw new Error("Update manifest platform must be mac, windows, linux, or linux-arm64");

  const resolvedOutputDirectory = path.resolve(outputDirectory);
  const manifestPath = path.join(resolvedOutputDirectory, manifestName);
  if (!fs.existsSync(manifestPath)) throw new Error(`Missing ${platform} update manifest: ${manifestPath}`);

  const manifestContents = fs.readFileSync(manifestPath);
  const updateManifest = yaml.load(manifestContents.toString("utf8"));
  if (!updateManifest || typeof updateManifest !== "object" || Array.isArray(updateManifest)) {
    throw new Error(`${manifestName} must contain an update manifest object`);
  }
  if (updateManifest.version !== expectedVersion) {
    throw new Error(`${manifestName} version ${updateManifest.version ?? "<missing>"} does not match ${expectedVersion}`);
  }
  if (!Array.isArray(updateManifest.files) || updateManifest.files.length === 0) {
    throw new Error(`${manifestName} does not reference any update files`);
  }
  const macArtifacts = platform === "mac" ? macReleaseArtifactNames(expectedVersion) : null;
  if (macArtifacts && updateManifest.path !== undefined && !macArtifacts.includes(updateManifest.path)) {
    throw new Error(`${manifestName} contains an unexpected macOS update path: ${updateManifest.path}`);
  }

  let hasInstallable = false;
  const files = [];
  for (const entry of updateManifest.files) {
    const url = typeof entry?.url === "string" ? entry.url : "";
    if (!url || path.basename(url) !== url || url.includes("\\")) {
      throw new Error(`${manifestName} contains an unsafe or invalid update URL: ${url || "<missing>"}`);
    }
    if (macArtifacts && !macArtifacts.includes(url)) {
      throw new Error(`${manifestName} references an unexpected macOS update artifact: ${url}`);
    }
    const artifact = path.join(resolvedOutputDirectory, url);
    const artifactStats = fs.statSync(artifact, { throwIfNoEntry: false });
    if (!artifactStats?.isFile()) {
      throw new Error(`${manifestName} references a missing artifact: ${url}`);
    }
    if (typeof entry.sha512 !== "string" || entry.sha512.length < 32) {
      throw new Error(`${manifestName} is missing the SHA-512 digest for ${url}`);
    }
    if (!Number.isSafeInteger(entry.size) || entry.size <= 0 || artifactStats.size !== entry.size) {
      throw new Error(`${manifestName} has an invalid size for ${url}`);
    }
    const sha512 = await digest(artifact, "sha512", "base64");
    if (sha512 !== entry.sha512) throw new Error(`${manifestName} has an invalid SHA-512 digest for ${url}`);
    hasInstallable ||= url.toLowerCase().endsWith(expectedExtension.toLowerCase());
    files.push({
      name: url,
      size: artifactStats.size,
      sha512,
      sha256: `sha256:${await digest(artifact, "sha256", "hex")}`,
    });
  }

  if (!hasInstallable) throw new Error(`${manifestName} does not reference a ${platform} ${expectedExtension} update`);
  return {
    name: manifestName,
    version: updateManifest.version,
    sha256: `sha256:${createHash("sha256").update(manifestContents).digest("hex")}`,
    files,
    result: "passed",
  };
}

async function main() {
  const platform = process.argv[2];
  const outputDirectory = process.argv[3] ?? "release";
  const channel = process.argv[4] ?? "beta";
  const evidence = await verifyUpdateManifest({ platform, outputDirectory, channel });
  console.log(`Verified ${channel} manifest ${evidence.name} for Bordeaux ${evidence.version} (${evidence.files.length} files).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
