import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error The release verifier is an executable JavaScript module exercised directly here.
import { verifyReleaseSignatures } from "../scripts/verify-release-signatures.mjs";

const temporaryDirectories: string[] = [];
const { version: releaseVersion } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
type NativeCommand = { command: string; args: string[] };

async function temporaryRelease() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bordeaux-signature-evidence-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeManifest(directory: string, name: string, artifactName: string, contents: Buffer, legacyPath?: string) {
  await writeFile(path.join(directory, name), JSON.stringify({
    version: releaseVersion,
    path: legacyPath,
    files: [{
      url: artifactName,
      size: contents.length,
      sha512: createHash("sha512").update(contents).digest("base64"),
    }],
  }));
}

async function macRelease(channel = "beta") {
  const directory = await temporaryRelease();
  const zip = Buffer.from("signed zip fixture");
  const dmgName = `Bordeaux-${releaseVersion}-mac-arm64.dmg`;
  const zipName = `Bordeaux-${releaseVersion}-mac-arm64.zip`;
  await writeFile(path.join(directory, dmgName), "signed dmg fixture");
  await writeFile(path.join(directory, zipName), zip);
  await writeManifest(directory, `${channel}-mac.yml`, zipName, zip, zipName);
  return { directory, zip, dmgName, zipName };
}

function macVerificationCommand(commands: NativeCommand[], architecture = (_executable: string) => "arm64", teamId = "ABCDE12345") {
  return async (command: string, args: string[]) => {
    commands.push({ command, args });
    if (command === "ditto") await mkdir(path.join(args.at(-1)!, "Bordeaux.app"), { recursive: true });
    if (command === "lipo") return { stdout: architecture(args.at(-1)!), stderr: "" };
    if (command === "codesign" && args.includes("--display")) {
      return { stdout: "", stderr: `Authority=Developer ID Application: Bordeaux\nTeamIdentifier=${teamId}\n` };
    }
    return { stdout: "", stderr: "ok" };
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("release signature evidence", () => {
  it("requires one approved, valid, timestamped Authenticode signer on every Windows executable", async () => {
    const directory = await temporaryRelease();
    const setup = Buffer.from("signed setup fixture");
    const portable = Buffer.from("signed portable fixture");
    const setupName = "Bordeaux-0.2.0-beta.3-windows-x64-setup.exe";
    const portableName = "Bordeaux-0.2.0-beta.3-windows-x64-portable.exe";
    await writeFile(path.join(directory, setupName), setup);
    await writeFile(path.join(directory, portableName), portable);
    await writeManifest(directory, "beta.yml", setupName, setup);

    const commands: Array<{ command: string; args: string[] }> = [];
    const evidence = await verifyReleaseSignatures({
      platform: "windows",
      releaseDirectory: directory,
      channel: "beta",
      environment: { WIN_SIGNER_SHA1: "11 22 33 44 55 66 77 88 99 00 aa bb cc dd ee ff 00 11 22 33" },
      now: () => new Date("2026-08-15T12:00:00.000Z"),
      runCommand: async (command: string, args: string[]) => {
        commands.push({ command, args });
        return {
          stdout: JSON.stringify({
            Status: "Valid",
            StatusMessage: "Signature verified.",
            SignerSubject: "CN=Bordeaux Release",
            SignerThumbprint: "11223344556677889900AABBCCDDEEFF00112233",
            SignerNotAfter: "2027-08-15T00:00:00.000Z",
            TimestampSubject: "CN=Timestamp Authority",
            TimestampThumbprint: "FFEEDDCCBBAA0099887766554433221100FFEEDD",
            TimestampNotAfter: "2030-08-15T00:00:00.000Z",
          }),
          stderr: "",
        };
      },
    });

    expect(commands).toHaveLength(2);
    expect(commands.every(({ command }) => command === "powershell.exe")).toBe(true);
    expect(commands.every(({ args }) => args.includes("-File") && args.some((arg) => arg.endsWith("get-authenticode-signature.ps1")))).toBe(true);
    expect(evidence).toMatchObject({
      schemaVersion: "bordeaux-release-signature-evidence/1.0",
      generatedAt: "2026-08-15T12:00:00.000Z",
      platform: "windows",
      channel: "beta",
      result: "passed",
      approvedSigner: { sha1: "11223344556677889900AABBCCDDEEFF00112233" },
      updaterManifest: { name: "beta.yml", result: "passed" },
    });
    expect(evidence.artifacts.map(({ name }: { name: string }) => name)).toEqual([portableName, setupName]);
    expect(evidence.artifacts[0].signature).toMatchObject({
      status: "Valid",
      signer: { subject: "CN=Bordeaux Release", sha1: "11223344556677889900AABBCCDDEEFF00112233" },
      timestamp: { subject: "CN=Timestamp Authority" },
    });
    expect(evidence.updaterManifest.files).toEqual([
      expect.objectContaining({ name: setupName, sha256: `sha256:${createHash("sha256").update(setup).digest("hex")}` }),
    ]);
  });

  it("rejects an unapproved or untimestamped Windows signature", async () => {
    const directory = await temporaryRelease();
    const setup = Buffer.from("setup");
    const portable = Buffer.from("portable");
    const setupName = "Bordeaux-0.2.0-beta.3-windows-x64-setup.exe";
    await writeFile(path.join(directory, setupName), setup);
    await writeFile(path.join(directory, "Bordeaux-0.2.0-beta.3-windows-x64-portable.exe"), portable);
    await writeManifest(directory, "beta.yml", setupName, setup);

    const runCommand = async () => ({
      stdout: JSON.stringify({
        Status: "Valid",
        SignerSubject: "CN=Someone Else",
        SignerThumbprint: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        SignerNotAfter: "2027-08-15T00:00:00.000Z",
        TimestampSubject: null,
        TimestampThumbprint: null,
        TimestampNotAfter: null,
      }),
      stderr: "",
    });

    await expect(verifyReleaseSignatures({
      platform: "windows",
      releaseDirectory: directory,
      channel: "beta",
      environment: { WIN_SIGNER_SHA1: "11223344556677889900AABBCCDDEEFF00112233" },
      runCommand,
    })).rejects.toThrow(/approved Windows signer/);
  });

  it.each(["beta", "latest"])("verifies %s macOS architecture, signing, Gatekeeper, and notarization for DMG and ZIP", async (channel) => {
    const { directory, dmgName, zipName } = await macRelease(channel);
    const commands: NativeCommand[] = [];
    const evidence = await verifyReleaseSignatures({
      platform: "mac",
      releaseDirectory: directory,
      channel,
      environment: { APPLE_TEAM_ID: "ABCDE12345" },
      now: () => new Date("2026-08-15T12:00:00.000Z"),
      runCommand: macVerificationCommand(commands),
    });

    expect(evidence).toMatchObject({
      platform: "mac",
      result: "passed",
      approvedSigner: { teamId: "ABCDE12345" },
      updaterManifest: { name: `${channel}-mac.yml`, result: "passed" },
    });
    expect(evidence.artifacts).toMatchObject([dmgName, zipName].map((name) => ({
      name, architecture: "arm64", signature: { teamId: "ABCDE12345" },
    })));
    expect(commands.filter(({ command }) => command === "codesign")).toHaveLength(4);
    expect(commands.filter(({ command }) => command === "spctl")).toHaveLength(2);
    expect(commands.filter(({ command }) => command === "xcrun")).toHaveLength(2);
    expect(commands.filter(({ command }) => command === "lipo")).toHaveLength(2);
    expect(commands.filter(({ command }) => command === "hdiutil").map(({ args }) => args[0])).toEqual(["attach", "detach"]);
  });

  it("rejects a macOS distributable signed by a different team", async () => {
    const { directory } = await macRelease();
    await expect(verifyReleaseSignatures({
      platform: "mac",
      releaseDirectory: directory,
      channel: "beta",
      environment: { APPLE_TEAM_ID: "ABCDE12345" },
      runCommand: macVerificationCommand([], undefined, "ZZZZZ99999"),
    })).rejects.toThrow(/approved Apple team/);
  });

  it.each([
    ["dmg", "x86_64"],
    ["zip", "x86_64 arm64"],
  ])("rejects an arm64-named %s containing a %s executable", async (artifact, architecture) => {
    const { directory } = await macRelease();
    const commands: NativeCommand[] = [];
    const runCommand = macVerificationCommand(commands, (executable) => {
      const isDmg = executable.includes("bordeaux-mac-dmg-");
      return isDmg === (artifact === "dmg") ? architecture : "arm64";
    });
    await expect(verifyReleaseSignatures({
      platform: "mac",
      releaseDirectory: directory,
      environment: { APPLE_TEAM_ID: "ABCDE12345" },
      runCommand,
    })).rejects.toThrow(`must contain an arm64-only app, found ${architecture}`);
    expect(commands.filter(({ command }) => command === "hdiutil").map(({ args }) => args[0])).toEqual(["attach", "detach"]);
  });

  it.each(["x64", "universal"])("rejects a %s Mac asset from a production package directory", async (architecture) => {
    const { directory } = await macRelease("latest");
    const extra = `Bordeaux-${releaseVersion}-mac-${architecture}.zip`;
    await writeFile(path.join(directory, extra), "unexpected archive");
    await expect(verifyReleaseSignatures({
      platform: "mac",
      releaseDirectory: directory,
      channel: "latest",
      environment: { APPLE_TEAM_ID: "ABCDE12345" },
    })).rejects.toThrow(`Unexpected macOS release asset for Apple Silicon: ${extra}`);
  });

  it.each(["files", "path"])("rejects a non-arm64 reference in macOS update manifest %s", async (field) => {
    const { directory, zip, zipName } = await macRelease();
    const wrongName = `Bordeaux-${releaseVersion}-mac-x64.zip`;
    await writeFile(path.join(directory, wrongName), zip);
    await writeManifest(directory, "beta-mac.yml", field === "files" ? wrongName : zipName, zip,
      field === "path" ? wrongName : zipName);
    await expect(verifyReleaseSignatures({
      platform: "mac",
      releaseDirectory: directory,
      environment: { APPLE_TEAM_ID: "ABCDE12345" },
    })).rejects.toThrow(/unexpected macOS update/);
  });

  it("retains signing checks and permits only an explicit unsigned beta exception", async () => {
    for (const workflowName of ["prerelease.yml", "package.yml"]) {
      const workflow = await readFile(new URL(`../.github/workflows/${workflowName}`, import.meta.url), "utf8");
      expect(workflow).toContain("verify-signing-env.mjs windows");
      expect(workflow).toContain("WIN_SIGNER_SHA1: ${{ secrets.WIN_SIGNER_SHA1 }}");
      expect(workflow).toContain("verify-release-signatures.mjs mac release");
      expect(workflow).toContain("verify-release-signatures.mjs windows release");
      expect(workflow).toContain("release/signature-evidence-*.json");
    }

    const beta = await readFile(new URL("../.github/workflows/prerelease.yml", import.meta.url), "utf8");
    const production = await readFile(new URL("../.github/workflows/package.yml", import.meta.url), "utf8");
    expect(beta).toContain("matrix.platform == 'windows' && !inputs.unsigned_windows");
    expect(beta).toContain("matrix.platform == 'windows' && inputs.unsigned_windows");
    expect(beta).toContain("default: false");
    expect(beta).toContain("Windows setup and portable executables in this beta are unsigned.");
    expect(production).not.toContain("unsigned_windows");

    const packaging = await readFile(new URL("../docs/packaging.md", import.meta.url), "utf8");
    expect(packaging).toContain("signed beta runs and production releases require signed Windows artifacts");
    expect(packaging).not.toContain("Windows (optional)");
    expect(packaging).not.toContain("Windows packages may be published unsigned");
  });
});
