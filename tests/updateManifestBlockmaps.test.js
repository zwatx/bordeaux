import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import yaml from "js-yaml";
import { expect, it } from "vitest";
import { verifyUpdateManifest } from "../scripts/verify-update-manifest.mjs";

const version = "1.2.3-beta.4";
async function release(platform, { blockmap, blockMapSize }) {
  const root = await mkdtemp(path.join(tmpdir(), "bordeaux-manifest-test-"));
  const [manifest, url] = platform === "windows"
    ? ["beta.yml", `Bordeaux-${version}-windows-x64-setup.exe`]
    : ["beta-linux.yml", `Bordeaux-${version}-linux-x86_64.AppImage`];
  const bytes = Buffer.from("installer");
  await writeFile(path.join(root, url), bytes);
  if (blockmap) await writeFile(path.join(root, url + ".blockmap"), "blockmap");
  const entry = { url, sha512: createHash("sha512").update(bytes).digest("base64"), size: bytes.length };
  if (blockMapSize !== undefined) entry.blockMapSize = blockMapSize;
  await writeFile(path.join(root, manifest), yaml.dump({ version, files: [entry], path: url, sha512: entry.sha512 }));
  return root;
}

it("requires a published blockmap beside setup executables and ZIPs", async () => {
  for (const [blockmap, passes] of [[true, true], [false, false]]) {
    const root = await release("windows", { blockmap });
    try {
      const check = verifyUpdateManifest({ platform: "windows", outputDirectory: root, expectedVersion: version });
      if (passes) await expect(check).resolves.toMatchObject({ result: "passed" });
      else await expect(check).rejects.toThrow(/no blockmap/);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

it("requires AppImage manifests to record the embedded blockmap size", async () => {
  for (const [blockMapSize, passes] of [[1024, true], [undefined, false], [0, false]]) {
    const root = await release("linux", { blockMapSize });
    try {
      const check = verifyUpdateManifest({ platform: "linux", outputDirectory: root, expectedVersion: version });
      if (passes) await expect(check).resolves.toMatchObject({ result: "passed" });
      else await expect(check).rejects.toThrow(/no blockmap/);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
