import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readRequiredFile(relativePath) {
  const absolutePath = path.join(repositoryRoot, relativePath);
  if (!fs.existsSync(absolutePath)) throw new Error(`Missing required rights file: ${relativePath}`);
  return fs.readFileSync(absolutePath, "utf8");
}

function digestRequiredFile(relativePath) {
  const absolutePath = path.join(repositoryRoot, relativePath);
  if (!fs.existsSync(absolutePath)) throw new Error(`Missing asset named by RIGHTS.md: ${relativePath}`);
  return createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex");
}

function requireText(relativePath, text, requiredSnippets) {
  const normalizedText = text.replace(/\s+/g, " ");
  for (const snippet of requiredSnippets) {
    if (!normalizedText.includes(snippet)) {
      throw new Error(`${relativePath} is missing required rights text: ${snippet}`);
    }
  }
}

const license = readRequiredFile("LICENSE");
const licenseDigest = createHash("sha256").update(license.replace(/\r\n?/g, "\n")).digest("hex");
if (licenseDigest !== "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30") {
  throw new Error("LICENSE must be the unmodified Apache License 2.0 text published by apache.org");
}

const notice = readRequiredFile("NOTICE");
requireText("NOTICE", notice, [
  "Bordeaux",
  "Copyright 2026 FRC Team 2468",
  "Apache License, Version 2.0",
  "RIGHTS.md",
]);

const fontLicense = readRequiredFile("licenses/OFL-1.1.txt");
requireText("licenses/OFL-1.1.txt", fontLicense, [
  "Space Grotesk Project Authors",
  "JetBrains Mono Project Authors",
  "SIL OPEN FONT LICENSE Version 1.1",
]);

const rights = readRequiredFile("RIGHTS.md");
requireText("RIGHTS.md", rights, [
  "application source",
  "LabVIEW integration source",
  "Bordeaux name and product identity",
  "wine-glass mark",
  "No trademark license",
  "Brand assets",
  "Fonts",
  "Video and third-party media",
  "Provenance records",
  "ssh2",
  "licenses/ssh2-MIT.txt",
]);

const ssh2License = readRequiredFile("licenses/ssh2-MIT.txt");
if (createHash("sha256").update(ssh2License.trimEnd()).digest("hex") !== "d06b5d27bbbbe22c36b1fd88406b1208876e2d37d795f5b8eaed951a459a3111") {
  throw new Error("licenses/ssh2-MIT.txt must match the license shipped by ssh2 1.17.0");
}

if (digestRequiredFile("licenses/WPILib-BSD-3-Clause.txt") !== "fb89d94504564dc7c78694c5f4291e23cda05ecfe45a003ca4911d493009115d") {
  throw new Error("licenses/WPILib-BSD-3-Clause.txt must match the allwpilib LICENSE.md");
}
const wpilibLayout = "src/core/field/wpilib/2026-rebuilt-andymark.json";
const wpilibLayoutDigest = digestRequiredFile(wpilibLayout);
if (!rights.includes(wpilibLayout) || !rights.includes(wpilibLayoutDigest)) {
  throw new Error(`RIGHTS.md has stale provenance for ${wpilibLayout}`);
}

const fontDigests = {
  "5212942a-e8a9-49c9-9687-e590adce5f6e.woff2": "d44eb1936043a56038eb02dd70b243f379bef65783f94ec12f277550720411f1",
  "70a5258e-5ffc-4ab8-9e26-eb5a1dc45e1d.woff2": "9c38cb2d0d2d93c1ee6e21fa78db76f13ea7e15e15cc64214c7ca89b6aaa35c4",
  "75942de6-7641-4396-9ec1-6f8aecca76d2.woff2": "2c32b9b3ee358c119e210f6f5195f9bd34894d78a785ff2e95d60e718e400af4",
  "9159e081-66f2-48ad-986a-f8a7ce5ae00c.woff2": "4995a9a43ac659ec32fcd8b463755cd6a07b31a6e6b3894a6a153b661cf490e2",
  "9720fba3-d472-4015-8174-9a76a96ee3a7.woff2": "9343de2ca5d9549f792e7962375af8efb0f320c7643bfd36c884b5a30e5c396f",
  "98640faa-af85-4deb-8b67-c9c878328d73.woff2": "a0d054c4af557de20afd6ca59f47ab353bcaec49c63ff04b6c9d39d0f8910557",
  "e5baa99d-fba3-44ea-85b3-2e3f8f2341dc.woff2": "054c266fbb441ee059365dba0885d206f67ca05b375de869b88e02ebfccc9b9d",
  "f43a65b8-4147-4e04-867c-3e12cc9ad7ef.woff2": "49c3da6c9a2b279b0f1f860f5cfb1f5dc38d88a5c7be9c9b1837bbc4e3db6111",
  "ffa637e1-07fe-493d-8dd2-c2aa214e1fec.woff2": "d699664b145bfeeccc66a4cce7fa55e14eb63efd7ec6b0b2ec52e25dd98f3917",
};
for (const [fileName, expectedDigest] of Object.entries(fontDigests)) {
  const actualDigest = digestRequiredFile(`src/renderer/assets/${fileName}`);
  if (actualDigest !== expectedDigest || !rights.includes(fileName) || !rights.includes(expectedDigest)) {
    throw new Error(`RIGHTS.md has stale provenance for src/renderer/assets/${fileName}`);
  }
}

const manifest = JSON.parse(readRequiredFile("package.json"));
if (manifest.license !== "Apache-2.0") throw new Error("package.json license must be Apache-2.0");

const lockfile = JSON.parse(readRequiredFile("package-lock.json"));
if (lockfile.packages?.[""]?.license !== "Apache-2.0") {
  throw new Error("package-lock.json root package license must be Apache-2.0");
}
if (manifest.dependencies?.ssh2 !== "1.17.0" || lockfile.packages?.["node_modules/ssh2"]?.version !== "1.17.0") {
  throw new Error("The reviewed ssh2 runtime dependency must remain pinned to 1.17.0");
}

const packagedRightsFiles = new Set((manifest.build?.extraResources ?? []).map((resource) => resource.from));
for (const relativePath of ["LICENSE", "NOTICE", "RIGHTS.md", "licenses/OFL-1.1.txt", "licenses/ssh2-MIT.txt", "licenses/WPILib-BSD-3-Clause.txt"]) {
  if (!packagedRightsFiles.has(relativePath)) {
    throw new Error(`package.json must include ${relativePath} in build.extraResources`);
  }
}

console.log("Verified Apache-2.0 scope, asset-rights boundary, and distribution metadata");
