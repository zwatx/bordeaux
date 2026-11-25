import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyMacReleaseAssetNames } from "./mac-release-assets.mjs";
import { verifyUpdateManifest } from "./verify-update-manifest.mjs";

const EVIDENCE_SCHEMA_VERSION = "bordeaux-release-signature-evidence/1.0";
const MAX_COMMAND_OUTPUT = 16 * 1024;
const WINDOWS_SIGNATURE_SCRIPT = fileURLToPath(new URL("./get-authenticode-signature.ps1", import.meta.url));

function boundedOutput(value) {
  const output = String(value ?? "").replaceAll("\r\n", "\n").trim();
  if (Buffer.byteLength(output, "utf8") > MAX_COMMAND_OUTPUT) {
    throw new Error("Signature verification output exceeded 16 KiB");
  }
  return output;
}

function normalizeSha1(value) {
  const normalized = String(value ?? "").replaceAll(/[^0-9a-f]/gi, "").toUpperCase();
  if (!/^[0-9A-F]{40}$/.test(normalized)) throw new Error("WIN_SIGNER_SHA1 must be a 40-digit certificate thumbprint");
  return normalized;
}

function appleTeamId(value) {
  const teamId = String(value ?? "").trim();
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error("APPLE_TEAM_ID must be a 10-character Apple team identifier");
  return teamId;
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

async function defaultRunCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: MAX_COMMAND_OUTPUT,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = boundedOutput(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    throw new Error(`${command} signature verification failed${output ? `: ${output}` : ""}`);
  }
  return { stdout: boundedOutput(result.stdout), stderr: boundedOutput(result.stderr) };
}

function combinedOutput(result) {
  return boundedOutput([result.stdout, result.stderr].filter(Boolean).join("\n"));
}

async function artifactsWithExtension(directory, extension) {
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(extension))
    .map((entry) => ({ name: entry.name, path: path.join(directory, entry.name) }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

async function onlyExtractedApp(directory) {
  const matches = [];
  async function visit(current) {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name.endsWith(".app")) matches.push(entryPath);
      else await visit(entryPath);
    }
  }
  await visit(directory);
  if (matches.length !== 1) throw new Error(`A macOS update ZIP must contain exactly one app bundle; found ${matches.length}`);
  return matches[0];
}

function parseWindowsSignature(output, approvedSha1) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("PowerShell returned invalid Authenticode evidence");
  }
  if (parsed?.Status !== "Valid") throw new Error(`Authenticode status must be Valid, received ${parsed?.Status ?? "<missing>"}`);
  const signerSha1 = normalizeSha1(parsed.SignerThumbprint);
  if (signerSha1 !== approvedSha1) throw new Error("The executable does not use the approved Windows signer");
  if (!parsed.TimestampSubject || !parsed.TimestampThumbprint || !parsed.TimestampNotAfter) {
    throw new Error("The Windows signature does not contain a timestamp certificate");
  }
  return {
    status: parsed.Status,
    statusMessage: String(parsed.StatusMessage ?? ""),
    signer: {
      subject: String(parsed.SignerSubject ?? ""),
      sha1: signerSha1,
      notAfter: String(parsed.SignerNotAfter ?? ""),
    },
    timestamp: {
      subject: String(parsed.TimestampSubject),
      sha1: normalizeSha1(parsed.TimestampThumbprint),
      notAfter: String(parsed.TimestampNotAfter),
    },
    output,
  };
}

async function verifyWindows(directory, environment, runCommand) {
  const approvedSha1 = normalizeSha1(environment.WIN_SIGNER_SHA1);
  const artifacts = await artifactsWithExtension(directory, ".exe");
  const setup = artifacts.filter(({ name }) => /-setup\.exe$/i.test(name));
  const portable = artifacts.filter(({ name }) => /-portable\.exe$/i.test(name));
  if (setup.length !== 1 || portable.length !== 1 || artifacts.length !== 2) {
    throw new Error("Windows release evidence requires exactly one setup and one portable executable");
  }
  const verified = [];
  for (const artifact of artifacts) {
    const result = await runCommand("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      WINDOWS_SIGNATURE_SCRIPT,
      artifact.path,
    ]);
    const output = boundedOutput(result.stdout);
    verified.push({
      name: artifact.name,
      size: (await fsp.stat(artifact.path)).size,
      sha256: await sha256(artifact.path),
      signature: parseWindowsSignature(output, approvedSha1),
    });
  }
  return { approvedSigner: { sha1: approvedSha1 }, artifacts: verified };
}

function parseMacIdentity(output, approvedTeamId) {
  const teamId = output.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  const authorities = [...output.matchAll(/^Authority=(.+)$/gm)].map((match) => match[1].trim());
  if (teamId !== approvedTeamId) throw new Error("The distributable does not use the approved Apple team");
  if (!authorities.some((authority) => authority.startsWith("Developer ID Application:"))) {
    throw new Error("The distributable is not signed with a Developer ID Application certificate");
  }
  return { teamId, authorities };
}

async function verifyMacTarget(target, kind, approvedTeamId, runCommand) {
  const codesign = await runCommand("codesign", ["--verify", "--deep", "--strict", "--verbose=4", target]);
  const display = await runCommand("codesign", ["--display", "--verbose=4", target]);
  const gatekeeper = await runCommand("spctl", kind === "dmg"
    ? ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=4", target]
    : ["--assess", "--type", "execute", "--verbose=4", target]);
  const notarization = await runCommand("xcrun", ["stapler", "validate", target]);
  const identityOutput = combinedOutput(display);
  return {
    ...parseMacIdentity(identityOutput, approvedTeamId),
    codesignOutput: combinedOutput(codesign),
    identityOutput,
    gatekeeperOutput: combinedOutput(gatekeeper),
    notarizationOutput: combinedOutput(notarization),
  };
}

async function verifyMacArchitecture(app, artifact, runCommand) {
  const executable = path.join(app, "Contents", "MacOS", "Bordeaux");
  const architecture = (await runCommand("lipo", ["-archs", executable])).stdout.trim();
  if (architecture !== "arm64") {
    throw new Error(`${path.basename(artifact)} must contain an arm64-only app, found ${architecture || "no architecture"}`);
  }
  return architecture;
}

async function verifyMacDmg(artifact, approvedTeamId, runCommand) {
  const signature = await verifyMacTarget(artifact, "dmg", approvedTeamId, runCommand);
  const mountPoint = await fsp.mkdtemp(path.join(os.tmpdir(), "bordeaux-mac-dmg-"));
  let mounted = false;
  try {
    await runCommand("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mountPoint, artifact]);
    mounted = true;
    const architecture = await verifyMacArchitecture(path.join(mountPoint, "Bordeaux.app"), artifact, runCommand);
    return { architecture, signature };
  } finally {
    if (mounted) await runCommand("hdiutil", ["detach", mountPoint]);
    await fsp.rmdir(mountPoint).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function verifyMacZip(artifact, approvedTeamId, runCommand) {
  const temporaryDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), "bordeaux-mac-signature-"));
  try {
    await runCommand("ditto", ["-x", "-k", artifact, temporaryDirectory]);
    const app = await onlyExtractedApp(temporaryDirectory);
    const architecture = await verifyMacArchitecture(app, artifact, runCommand);
    const signature = await verifyMacTarget(app, "app", approvedTeamId, runCommand);
    return { architecture, signature };
  } finally {
    await fsp.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function verifyMac(directory, version, environment, runCommand) {
  const approvedTeamId = appleTeamId(environment.APPLE_TEAM_ID);
  const names = verifyMacReleaseAssetNames(await fsp.readdir(directory), version);
  const verified = [];
  for (const name of names) {
    const artifact = path.join(directory, name);
    const verifyArtifact = name.endsWith(".dmg") ? verifyMacDmg : verifyMacZip;
    verified.push({
      name,
      size: (await fsp.stat(artifact)).size,
      sha256: await sha256(artifact),
      ...await verifyArtifact(artifact, approvedTeamId, runCommand),
    });
  }
  return { approvedSigner: { teamId: approvedTeamId }, artifacts: verified };
}

export async function verifyReleaseSignatures({
  platform,
  releaseDirectory = "release",
  channel = "beta",
  environment = process.env,
  now = () => new Date(),
  runCommand = defaultRunCommand,
}) {
  if (platform !== "mac" && platform !== "windows") throw new Error("Signature platform must be mac or windows");
  const resolvedDirectory = path.resolve(releaseDirectory);
  const updaterManifest = await verifyUpdateManifest({ platform, outputDirectory: resolvedDirectory, channel });
  const result = platform === "mac"
    ? await verifyMac(resolvedDirectory, updaterManifest.version, environment, runCommand)
    : await verifyWindows(resolvedDirectory, environment, runCommand);
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    generatedAt: now().toISOString(),
    platform,
    channel,
    result: "passed",
    approvedSigner: result.approvedSigner,
    updaterManifest,
    artifacts: result.artifacts,
  };
}

async function main() {
  const platform = process.argv[2];
  const releaseDirectory = process.argv[3] ?? "release";
  const channel = process.argv[4] ?? "beta";
  const output = process.argv[5];
  if (!output) throw new Error("Usage: verify-release-signatures.mjs <mac|windows> <release-dir> <beta|latest> <evidence-file>");
  const evidence = await verifyReleaseSignatures({ platform, releaseDirectory, channel });
  const outputPath = path.resolve(output);
  if (path.dirname(outputPath) !== path.resolve(releaseDirectory)) {
    throw new Error("Signature evidence must be written inside the release directory");
  }
  await fsp.writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  console.log(`Verified ${platform} release signatures and wrote ${path.basename(outputPath)}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
