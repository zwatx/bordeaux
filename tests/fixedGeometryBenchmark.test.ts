import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  normalizeTrajectoryCandidate,
  FixedGeometryCorpus,
  validateTankTrajectoryCandidate,
} from "../src/electron/benchmark/fixedGeometry";
import { getPlanner } from "../src/shared/planners";
import { decodeProjectFile } from "../src/shared/project/fileFormat";
import { buildWaypoints, createDemoProject } from "../src/shared/project/defaults";

const directory = join(dirname(fileURLToPath(import.meta.url)), "../benchmarks/planner-corpus/v2");
const projectContents = readFileSync(join(directory, "corpus.bordeaux.json"), "utf8");
const manifestContents = readFileSync(join(directory, "manifest.json"), "utf8");
const fixedContents = readFileSync(join(directory, "fixed-geometry.json"), "utf8");
const fixedDigest = readFileSync(join(directory, "fixed-geometry.sha256"), "utf8").trim();
const project = decodeProjectFile(projectContents).project;
const fixed = JSON.parse(fixedContents);
const corpus = FixedGeometryCorpus.loadV2(directory);

function caseId(pathId: string): string {
  return corpus.cases.find((candidate) => candidate.pathId === pathId)!.id;
}

function generated(pathId: string) {
  const path = project.paths.find((candidate) => candidate.id === pathId)!;
  return getPlanner("profiledSpline").generate({ path, robot: project.robot });
}

describe("fixed-geometry benchmark manifest", () => {
  it("pins source digests, deterministic seeds, and every frozen path", () => {
    expect(fixed.schemaVersion).toBe("bordeaux-fixed-geometry/1.0");
    expect(fixed.sourceManifest.sha256).toBe(`sha256:${createHash("sha256").update(manifestContents).digest("hex")}`);
    expect(fixed.sourceProject.sha256).toBe(`sha256:${createHash("sha256").update(projectContents).digest("hex")}`);
    expect(fixedDigest).toBe(`sha256:${createHash("sha256").update(fixedContents).digest("hex")}`);
    expect(fixed.leaderboard.drive).toBe("swerve");
    expect(fixed.cases.map((candidate: { pathId: string }) => candidate.pathId).sort())
      .toEqual(project.paths.map((path) => path.id).sort());
    expect(new Set(fixed.cases.map((candidate: { deterministicSeed: number }) => candidate.deterministicSeed)).size)
      .toBe(project.paths.length);
    expect(corpus.cases).toEqual(fixed.cases);
  });

  it("rejects a self-consistent-looking project that does not match the pinned corpus", () => {
    const temporary = mkdtempSync(join(tmpdir(), "bordeaux-fixed-corpus-"));
    cpSync(directory, temporary, { recursive: true });
    const tampered = JSON.parse(projectContents);
    tampered.robot.w = 0.7;
    writeFileSync(join(temporary, "corpus.bordeaux.json"), `${JSON.stringify(tampered, null, 2)}\n`);

    expect(() => FixedGeometryCorpus.loadV2(temporary)).toThrow("project digest does not match");
    expect(() => new (FixedGeometryCorpus as any)(Symbol("forged"), "forged", [])).toThrow("pinned manifest");
    expect(corpus.validate("invented-fixture", generated("corpus-neutral-slalom")).rankingEligible).toBe(false);
  });
});

describe("planner-neutral fixed-geometry validation", () => {
  it("normalizes the same candidate deterministically without trusting supplied distance or indices", () => {
    const raw = structuredClone(generated("corpus-neutral-slalom"));
    raw.samples.forEach((sample, index) => { sample.i = 99 - index; sample.s = 123; sample.f = -4; });
    const first = normalizeTrajectoryCandidate(raw);
    const second = normalizeTrajectoryCandidate(structuredClone(raw));

    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.trajectory.samples[0]).toMatchObject({ i: 0, s: 0, f: 0 });
    expect(first.trajectory.samples.at(-1)?.f).toBe(1);
    expect(first.trajectory.totalDistanceM).not.toBe(123);
  });

  it("accepts every frozen Bordeaux baseline only after dense validity checks", () => {
    for (const benchmarkCase of fixed.cases as Array<{ pathId: string }>) {
      const result = corpus.validate(caseId(benchmarkCase.pathId), generated(benchmarkCase.pathId));
      expect(result.issues, benchmarkCase.pathId).toEqual([]);
      expect(result.valid, benchmarkCase.pathId).toBe(true);
      expect(result.rankingEligible, benchmarkCase.pathId).toBe(true);
      expect(result.normalized?.samples.length, benchmarkCase.pathId).toBeGreaterThan(2);
    }
  });

  it("disqualifies malformed, geometry-changing, and constraint-violating candidates before ranking", () => {
    const pathId = "corpus-neutral-slalom";
    const fixtureId = caseId(pathId);
    const malformed = structuredClone(generated(pathId));
    malformed.samples[2].t = malformed.samples[1].t;
    const malformedResult = corpus.validate(fixtureId, malformed);
    expect(malformedResult.rankingEligible).toBe(false);
    expect(malformedResult.issues.map((issue) => issue.code)).toContain("sample:time-order");

    const changedGeometry = structuredClone(generated(pathId));
    changedGeometry.samples[Math.floor(changedGeometry.samples.length / 2)].y += 0.4;
    const geometryResult = corpus.validate(fixtureId, changedGeometry);
    expect(geometryResult.rankingEligible).toBe(false);
    expect(geometryResult.issues.map((issue) => issue.code)).toContain("geometry:fixed-path");

    const changedHeading = structuredClone(generated(pathId));
    changedHeading.samples[Math.floor(changedHeading.samples.length / 2)].headingRad += 0.2;
    expect(corpus.validate(fixtureId, changedHeading).issues.map((issue) => issue.code))
      .toContain("geometry:fixed-heading");

    const tooFast = structuredClone(generated(pathId));
    tooFast.samples.forEach((sample) => { sample.t *= 0.1; });
    const constraintResult = corpus.validate(fixtureId, tooFast);
    expect(constraintResult.rankingEligible).toBe(false);
    expect(constraintResult.issues.some((issue) => issue.code.startsWith("constraint:"))).toBe(true);
  });

  it("binds rolling endpoints and interior stops to authored path semantics", () => {
    const rollingPathId = "corpus-blue-table-trench";
    const rolling = structuredClone(generated(rollingPathId));
    rolling.samples.at(-1)!.velocityMps = 0;
    expect(corpus.validate(caseId(rollingPathId), rolling).issues.map((issue) => issue.code))
      .toContain("semantics:goal-velocity");

    const stopPathId = "corpus-neutral-stop";
    const noStop = structuredClone(generated(stopPathId));
    const stopWaypoint = project.paths.find((path) => path.id === stopPathId)!.waypoints[1];
    noStop.samples = noStop.samples.filter((sample) => Math.hypot(sample.x - stopWaypoint.x, sample.y - stopWaypoint.y) > 0.03);
    expect(corpus.validate(caseId(stopPathId), noStop).issues.map((issue) => issue.code))
      .toContain("semantics:interior-stop");

    const noWait = structuredClone(generated(stopPathId));
    let keptStop = false;
    noWait.samples = noWait.samples.filter((sample) => {
      // Leave only the stop inside the validator's 4 cm position tolerance.
      if (Math.hypot(sample.x - stopWaypoint.x, sample.y - stopWaypoint.y) > 0.05) return true;
      if (keptStop || Math.abs(sample.velocityMps) > 0.01) return false;
      keptStop = true;
      return true;
    });
    expect(corpus.validate(caseId(stopPathId), noWait).issues.map((issue) => issue.code))
      .toContain("semantics:wait");
  });

  it("rejects a candidate whose dense validation would exceed the bounded sample ceiling", () => {
    const pathId = "corpus-neutral-slalom";
    const sparse = structuredClone(generated(pathId));
    sparse.samples = [sparse.samples[0], { ...sparse.samples.at(-1)!, t: 6_000 }];

    expect(corpus.validate(caseId(pathId), sparse).issues.map((issue) => issue.code))
      .toContain("candidate:dense-sample-count");
  });

  it("derives angular acceleration from headings instead of trusting submitted angular velocity", () => {
    const pathId = "corpus-neutral-slalom";
    const oscillating = structuredClone(generated(pathId));
    oscillating.samples.forEach((sample, index) => {
      if (index > 0 && index < oscillating.samples.length - 1) sample.headingRad += index % 2 === 0 ? 0.03 : -0.03;
      sample.angularVelocityRadps = 0;
    });

    const result = corpus.validate(caseId(pathId), oscillating);
    expect(result.rankingEligible).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("constraint:angular-acceleration");
  });

  it("densely enforces a short constraint range between sparse source samples", () => {
    const tankProject = createDemoProject();
    tankProject.robot.drive = "tank";
    tankProject.paths[0].headingMode = "tangent";
    tankProject.paths[0].waypoints = buildWaypoints([{ x: 6, y: 1 }, { x: 10, y: 1 }]);
    tankProject.paths[0].ranges = [{
      anchor: "param", f0: 0.45, f1: 0.55,
      maxVel: 0.2, maxAccel: 6.5, maxDecel: 6.5, maxAngVel: 540, maxAngAccel: 720,
    }];
    const candidate = {
      samples: [
        { i: 0, t: 0, s: 0, f: 0, x: 6, y: 1, headingRad: 0, velocityMps: 1, accelerationMps2: 0, angularVelocityRadps: 0, curvatureInvM: 0 },
        { i: 1, t: 4, s: 4, f: 1, x: 10, y: 1, headingRad: 0, velocityMps: 1, accelerationMps2: 0, angularVelocityRadps: 0, curvatureInvM: 0 },
      ],
    };

    expect(validateTankTrajectoryCandidate(tankProject, tankProject.paths[0].id, candidate).issues.map((issue) => issue.code))
      .toContain("constraint:velocity");
  });

  it("correctness-checks tank candidates while excluding them from the first leaderboard", () => {
    const tankProject = createDemoProject();
    tankProject.robot.drive = "tank";
    tankProject.paths[0].headingMode = "tangent";
    tankProject.paths[0].waypoints = buildWaypoints([{ x: 6, y: 1 }, { x: 10, y: 1 }]);
    const path = tankProject.paths[0];
    const candidate = getPlanner("profiledSpline").generate({ path, robot: tankProject.robot });
    const result = validateTankTrajectoryCandidate(tankProject, path.id, candidate);

    expect(result.valid, JSON.stringify(result.issues)).toBe(true);
    expect(result.rankingEligible).toBe(false);
    expect(result.exclusionReason).toBe("The first planner leaderboard is swerve-only.");
  });
});
