import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const {
  captureChoreoRun,
  CHOREO_BINARY_SHA256,
  CHOREO_VERSION,
  choreoInvocation,
  prepareChoreoFixture,
} = require("../dist-electron/electron/benchmark/choreoAdapter.js");
const { CorridorCorpus } = require("../dist-electron/electron/benchmark/corridor.js");
const { FixedGeometryCorpus } = require("../dist-electron/electron/benchmark/fixedGeometry.js");
const execFileAsync = promisify(execFile);

const binary = process.env.BORDEAUX_CHOREO_CLI;
if (!binary) throw new Error("Set BORDEAUX_CHOREO_CLI to the pinned Choreo v2026.0.3 Linux x86_64 standalone choreo-cli.");
const resolvedBinary = path.resolve(binary);
const binaryContents = await fs.readFile(resolvedBinary);
const binarySha256 = `sha256:${createHash("sha256").update(binaryContents).digest("hex")}`;
if (binarySha256 !== CHOREO_BINARY_SHA256) {
  throw new Error(`Choreo CLI digest mismatch: expected ${CHOREO_BINARY_SHA256}, received ${binarySha256}.`);
}
const version = await execFileAsync(resolvedBinary, ["--version"], { maxBuffer: 1024 * 1024 });
if (version.stdout.trim() !== `choreo-cli ${CHOREO_VERSION}`) {
  throw new Error(`Choreo CLI version mismatch: ${version.stdout.trim() || version.stderr.trim()}.`);
}

const repositoryRoot = process.cwd();
const corpusDirectory = path.join(repositoryRoot, "benchmarks", "planner-corpus", "v2");
const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-choreo-adapter-"));
const cases = [
  { benchmarkClass: "fixed-geometry", fixtureId: "fixed-blue-away-bump" },
  { benchmarkClass: "corridor", fixtureId: "corridor-neutral-slalom" },
];

try {
  for (const entry of cases) {
    const prepared = prepareChoreoFixture(corpusDirectory, entry.benchmarkClass, entry.fixtureId);
    if (!prepared.supported) throw new Error(`Choreo integration fixture is unsupported: ${prepared.reason}`);
    const runDirectory = path.join(temporaryDirectory, entry.benchmarkClass);
    await fs.mkdir(runDirectory);
    const projectPath = path.join(runDirectory, "bordeaux-benchmark.chor");
    const trajectoryPath = path.join(runDirectory, `${prepared.trajectoryName}.traj`);
    await fs.writeFile(projectPath, prepared.projectContents);
    await fs.writeFile(trajectoryPath, prepared.trajectoryContents);
    const invocation = choreoInvocation(resolvedBinary, projectPath, prepared.trajectoryName);

    let exitCode = 0;
    let stdout = "";
    let stderr = "";
    try {
      const result = await execFileAsync(invocation.executable, invocation.arguments, {
        cwd: invocation.workingDirectory,
        env: process.env,
        timeout: 180_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      exitCode = Number.isInteger(error?.code) ? error.code : 1;
      stdout = typeof error?.stdout === "string" ? error.stdout : "";
      stderr = typeof error?.stderr === "string" ? error.stderr : String(error);
    }
    let rawOutput = null;
    try {
      rawOutput = await fs.readFile(trajectoryPath, "utf8");
    } catch {
      // The capture records the missing output boundary below.
    }
    const captured = captureChoreoRun(prepared, { invocation, exitCode, stdout, stderr, rawOutput });
    if (captured.outcome !== "generated" || !captured.normalized) {
      throw new Error(`Choreo ${entry.benchmarkClass} adapter failed: ${captured.failure ?? "unknown failure"}\n${stderr || stdout}`);
    }
    const corpus = entry.benchmarkClass === "fixed-geometry"
      ? FixedGeometryCorpus.loadV2(corpusDirectory)
      : CorridorCorpus.loadV2(corpusDirectory);
    const validation = corpus.validate(prepared.fixtureId, { ...captured.normalized, events: captured.events });
    process.stdout.write(`${JSON.stringify({
      adapter: "Choreo",
      version: CHOREO_VERSION,
      sleipnirVersion: prepared.provenance.sleipnirVersion,
      benchmarkClass: entry.benchmarkClass,
      fixtureId: entry.fixtureId,
      inputSha256: prepared.inputSha256,
      rawBytes: Buffer.byteLength(rawOutput ?? ""),
      samples: captured.normalized.samples.length,
      valid: validation.valid,
      rankingEligible: validation.rankingEligible,
      issues: validation.issues,
    })}\n`);
  }
} finally {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
