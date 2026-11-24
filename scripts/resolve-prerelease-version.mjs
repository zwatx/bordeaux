// Picks the beta version a prerelease run publishes. The beta workflow runs this before packaging,
// then commits the version to main when it differs from package.json.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const beta = /^(\d+\.\d+\.\d+-beta\.)(\d+)$/;

// Orders x.y.z and x.y.z-beta.N versions; a beta sorts before its stable release. This runs before
// npm ci, so it cannot use the semver package.
function compareVersions(a, b) {
  const parse = (version) => {
    const [core, pre] = version.split("-beta.");
    return [...core.split(".").map(Number), pre === undefined ? Infinity : Number(pre)];
  };
  const left = parse(a), right = parse(b);
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}

// A blank request reuses an untagged checked-in beta (a hand bump, or a retry after a failed run),
// otherwise takes the next beta number. `released` reports whether v<version> is already tagged.
export function resolvePrereleaseVersion({ requested = "", current, released }) {
  let version = requested.trim();
  if (version) {
    if (!beta.test(version)) throw new Error(`Prerelease version ${version} must look like 0.2.0-beta.1`);
    // An explicit version lands on main, so a typo must not move the checked-in version backwards.
    if (compareVersions(version, current) < 0) throw new Error(`Prerelease version ${version} is older than the checked-in ${current}`);
  } else {
    const match = beta.exec(current);
    if (!match) throw new Error(`Checked-in version ${current} is not a beta; dispatch with an explicit version such as 0.3.0-beta.1`);
    version = released(current) ? `${match[1]}${Number(match[2]) + 1}` : current;
  }
  if (released(version)) throw new Error(`Tag v${version} already exists; dispatch with a newer explicit version`);
  return version;
}

function tagExists(version) {
  try {
    execFileSync("git", ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/v${version}`], { stdio: "ignore" });
    return true;
  } catch (error) {
    if (error.status === 2) return false; // --exit-code: no matching ref
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { version: current } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const version = resolvePrereleaseVersion({ requested: process.env.RELEASE_VERSION, current, released: tagExists });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
  console.log(version === current ? `Releasing checked-in version ${version}.` : `Releasing ${version} (checked in: ${current}).`);
}
