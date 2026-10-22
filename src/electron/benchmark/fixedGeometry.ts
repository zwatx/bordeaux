import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { minimumRobotFieldClearance } from "../../shared/agent/fieldClearance";
import { PM } from "../../shared/math/pm";
import { activeRanges, effectiveRanges } from "../../shared/planners/rotationPriority";
import { MAX_TRAJECTORY_SAMPLES } from "../../shared/planners/limits";
import { decodeProjectFile } from "../../shared/project/fileFormat";
import type { BordeauxProject, PathDoc, TrajectorySample } from "../../shared/types";

const NUMBER_PLACES = 9;
const MAX_DENSE_STEP_M = 0.02;
const MAX_DENSE_STEP_S = 0.02;
const GEOMETRY_TOLERANCE_M = 0.04;
const HEADING_TOLERANCE_RAD = 2 * Math.PI / 180;
const ENDPOINT_VELOCITY_TOLERANCE_MPS = 0.025;
const STOP_POSITION_TOLERANCE_M = 0.04;
const STOP_VELOCITY_TOLERANCE_MPS = 0.05;
const CONSTRAINT_ABSOLUTE_TOLERANCE = 0.03;
const CONSTRAINT_RELATIVE_TOLERANCE = 0.01;
const CENTRIPETAL_RELATIVE_TOLERANCE = 0.025;
export const CANDIDATE_CENTRIPETAL_RELATIVE_TOLERANCE = 0.025;
export const CANDIDATE_ADJACENT_CENTRIPETAL_RELATIVE_TOLERANCE = 0.27;
const MAX_ISSUES = 64;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
export const FIXED_GEOMETRY_V2_SHA256 = "sha256:d7c3e92102a7179bd5947d3d4318bcd04d49ba39b46813ebdb34911a9308273f";
const CORPUS_AUTHORITY = Symbol("bordeaux-fixed-geometry-corpus");

interface FixedGeometryFixture {
  id: string;
  deterministicSeed: number;
  source: {
    corpusId: string;
    manifestSha256: string;
    projectSha256: string;
  };
  project: BordeauxProject;
  pathId: string;
}

export interface FixedGeometryIssue {
  code: string;
  message: string;
  sampleIndex?: number;
}

export interface NormalizedTrajectory {
  totalTimeS: number;
  totalDistanceM: number;
  samples: TrajectorySample[];
}

export type TrajectoryNormalizationResult =
  | { ok: true; trajectory: NormalizedTrajectory; issues: [] }
  | { ok: false; issues: FixedGeometryIssue[] };

export interface FixedGeometryValidation {
  fixtureId: string;
  deterministicSeed: number;
  valid: boolean;
  rankingEligible: boolean;
  exclusionReason?: string;
  issues: FixedGeometryIssue[];
  normalized?: NormalizedTrajectory;
}

type ReferencePoint = { x: number; y: number; s: number; headingRad: number; curvatureInvM: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function round(value: number): number {
  const result = Number(value.toFixed(NUMBER_PLACES));
  return Object.is(result, -0) ? 0 : result;
}

function wrappedAngle(value: number): number {
  return Math.atan2(Math.sin(value), Math.cos(value));
}

function interpolateAngle(first: number, second: number, progress: number): number {
  return first + wrappedAngle(second - first) * progress;
}

function addIssue(issues: FixedGeometryIssue[], issue: FixedGeometryIssue): void {
  if (issues.length >= MAX_ISSUES || issues.some((candidate) => candidate.code === issue.code)) return;
  issues.push(issue);
}

const numericSampleKeys = [
  "t",
  "x",
  "y",
  "headingRad",
  "velocityMps",
  "accelerationMps2",
  "angularVelocityRadps",
  "curvatureInvM",
] as const;

export function normalizeTrajectoryCandidate(candidate: unknown): TrajectoryNormalizationResult {
  if (!isRecord(candidate) || !Array.isArray(candidate.samples)) {
    return { ok: false, issues: [{ code: "candidate:samples", message: "Candidate samples must be an array." }] };
  }
  if (candidate.samples.length < 2 || candidate.samples.length > MAX_TRAJECTORY_SAMPLES) {
    return {
      ok: false,
      issues: [{
        code: "candidate:sample-count",
        message: `Candidate must contain 2 to ${MAX_TRAJECTORY_SAMPLES} samples.`,
      }],
    };
  }

  const issues: FixedGeometryIssue[] = [];
  const prepared: Array<Omit<TrajectorySample, "i" | "s" | "f">> = [];
  candidate.samples.forEach((value, sampleIndex) => {
    if (!isRecord(value)) {
      addIssue(issues, { code: "sample:shape", message: "Every candidate sample must be an object.", sampleIndex });
      return;
    }
    for (const key of numericSampleKeys) {
      if (!finite(value[key])) addIssue(issues, { code: `sample:${key}`, message: `Sample ${key} must be finite.`, sampleIndex });
    }
    if (!numericSampleKeys.every((key) => finite(value[key]))) return;
    if ((value.velocityMps as number) < 0) {
      addIssue(issues, { code: "sample:velocity", message: "Sample velocity must be a nonnegative speed.", sampleIndex });
    }
    prepared.push({
      t: round(value.t as number),
      x: round(value.x as number),
      y: round(value.y as number),
      headingRad: round(value.headingRad as number),
      velocityMps: round(value.velocityMps as number),
      accelerationMps2: round(value.accelerationMps2 as number),
      angularVelocityRadps: round(value.angularVelocityRadps as number),
      curvatureInvM: round(value.curvatureInvM as number),
    });
  });
  if (issues.length > 0 || prepared.length !== candidate.samples.length) return { ok: false, issues };
  if (Math.abs(prepared[0].t) > 1e-9) {
    addIssue(issues, { code: "sample:start-time", message: "Candidate time must begin at zero.", sampleIndex: 0 });
  }
  for (let index = 1; index < prepared.length; index += 1) {
    if (prepared[index].t <= prepared[index - 1].t) {
      addIssue(issues, { code: "sample:time-order", message: "Candidate time must increase strictly.", sampleIndex: index });
      break;
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  const distances = new Array(prepared.length).fill(0);
  for (let index = 1; index < prepared.length; index += 1) {
    distances[index] = distances[index - 1] + Math.hypot(
      prepared[index].x - prepared[index - 1].x,
      prepared[index].y - prepared[index - 1].y,
    );
  }
  const totalDistanceM = distances.at(-1) ?? 0;
  if (totalDistanceM <= 1e-9 || prepared.at(-1)!.t <= 1e-9) {
    return { ok: false, issues: [{ code: "candidate:degenerate", message: "Candidate must have positive distance and duration." }] };
  }
  const samples = prepared.map((sample, index): TrajectorySample => ({
    ...sample,
    i: index,
    s: round(distances[index]),
    f: round(distances[index] / totalDistanceM),
  }));
  return {
    ok: true,
    issues: [],
    trajectory: {
      totalTimeS: round(samples.at(-1)!.t),
      totalDistanceM: round(totalDistanceM),
      samples,
    },
  };
}

export function densifyNormalizedTrajectory(trajectory: NormalizedTrajectory): NormalizedTrajectory | null {
  let projected = 1;
  for (let index = 1; index < trajectory.samples.length; index += 1) {
    const first = trajectory.samples[index - 1];
    const second = trajectory.samples[index];
    projected += Math.max(
      1,
      Math.ceil(Math.hypot(second.x - first.x, second.y - first.y) / MAX_DENSE_STEP_M),
      Math.ceil((second.t - first.t) / MAX_DENSE_STEP_S),
    );
    if (projected > MAX_TRAJECTORY_SAMPLES) return null;
  }

  const raw: TrajectorySample[] = [{ ...trajectory.samples[0] }];
  for (let index = 1; index < trajectory.samples.length; index += 1) {
    const first = trajectory.samples[index - 1];
    const second = trajectory.samples[index];
    const steps = Math.max(
      1,
      Math.ceil(Math.hypot(second.x - first.x, second.y - first.y) / MAX_DENSE_STEP_M),
      Math.ceil((second.t - first.t) / MAX_DENSE_STEP_S),
    );
    for (let step = 1; step <= steps; step += 1) {
      const progress = step / steps;
      raw.push({
        i: raw.length,
        t: first.t + (second.t - first.t) * progress,
        s: 0,
        f: 0,
        x: first.x + (second.x - first.x) * progress,
        y: first.y + (second.y - first.y) * progress,
        headingRad: interpolateAngle(first.headingRad, second.headingRad, progress),
        velocityMps: first.velocityMps + (second.velocityMps - first.velocityMps) * progress,
        accelerationMps2: first.accelerationMps2 + (second.accelerationMps2 - first.accelerationMps2) * progress,
        angularVelocityRadps: first.angularVelocityRadps + (second.angularVelocityRadps - first.angularVelocityRadps) * progress,
        curvatureInvM: first.curvatureInvM + (second.curvatureInvM - first.curvatureInvM) * progress,
      });
    }
  }
  let distance = 0;
  for (let index = 1; index < raw.length; index += 1) {
    distance += Math.hypot(raw[index].x - raw[index - 1].x, raw[index].y - raw[index - 1].y);
    raw[index].s = distance;
  }
  raw.forEach((sample, index) => {
    sample.i = index;
    sample.s = round(sample.s);
    sample.f = round(sample.s / Math.max(distance, 1e-9));
    sample.t = round(sample.t);
  });
  return { totalTimeS: trajectory.totalTimeS, totalDistanceM: round(distance), samples: raw };
}

function referenceGeometry(path: PathDoc, project: BordeauxProject): ReferencePoint[] {
  const derived = PM.derivePath(path, project.robot, 256, { skipStationaryActions: true });
  const points = derived.sample.pts as Array<{ x: number; y: number; s: number; curv?: number }>;
  const headings = derived.metrics.head as number[];
  return points.map((point, index) => ({
    x: point.x,
    y: point.y,
    s: point.s,
    headingRad: headings[index] ?? 0,
    curvatureInvM: point.curv ?? 0,
  }));
}

function referenceAt(reference: readonly ReferencePoint[], fraction: number): ReferencePoint {
  const total = reference.at(-1)?.s ?? 0;
  const target = Math.max(0, Math.min(1, fraction)) * total;
  let low = 1;
  let high = reference.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (reference[middle].s >= target) high = middle;
    else low = middle + 1;
  }
  const second = reference[Math.max(1, low)];
  const first = reference[Math.max(0, low - 1)];
  const span = Math.max(1e-12, second.s - first.s);
  const progress = Math.max(0, Math.min(1, (target - first.s) / span));
  return {
    x: first.x + (second.x - first.x) * progress,
    y: first.y + (second.y - first.y) * progress,
    s: target,
    headingRad: interpolateAngle(first.headingRad, second.headingRad, progress),
    curvatureInvM: first.curvatureInvM + (second.curvatureInvM - first.curvatureInvM) * progress,
  };
}

function tolerance(limit: number): number {
  return CONSTRAINT_ABSOLUTE_TOLERANCE + Math.abs(limit) * CONSTRAINT_RELATIVE_TOLERANCE;
}

function geometricCentripetalAt(
  samples: readonly TrajectorySample[],
  index: number,
  span: number,
): number | null {
  const center = samples[index];
  const before = samples[Math.max(0, index - span)];
  const after = samples[Math.min(samples.length - 1, index + span)];
  const beforeDt = center.t - before.t;
  const afterDt = after.t - center.t;
  const beforeVelocity = {
    x: (center.x - before.x) / beforeDt,
    y: (center.y - before.y) / beforeDt,
  };
  const afterVelocity = {
    x: (after.x - center.x) / afterDt,
    y: (after.y - center.y) / afterDt,
  };
  const beforeSpeed = Math.hypot(beforeVelocity.x, beforeVelocity.y);
  const afterSpeed = Math.hypot(afterVelocity.x, afterVelocity.y);
  if (beforeSpeed <= 1e-8 || afterSpeed <= 1e-8) return null;
  const directionChange = Math.abs(wrappedAngle(
    Math.atan2(afterVelocity.y, afterVelocity.x) - Math.atan2(beforeVelocity.y, beforeVelocity.x),
  ));
  const speed = (beforeSpeed + afterSpeed) / 2;
  const midpointDt = (beforeDt + afterDt) / 2;
  return directionChange / Math.max(1e-9, speed * midpointDt) * speed * speed;
}

function limitsAt(path: PathDoc, project: BordeauxProject, ranges: ReturnType<typeof effectiveRanges>, fraction: number) {
  const active = activeRanges(ranges, fraction);
  return {
    velocity: Math.min(project.robot.maxSpeed, path.constraints.maxVel, ...active.map((range) => range.maxVel ?? Infinity)),
    acceleration: Math.min(path.constraints.maxAccel, ...active.map((range) => range.maxAccel ?? Infinity)),
    deceleration: Math.min(path.constraints.maxDecel, ...active.map((range) => range.maxDecel ?? Infinity)),
    angularVelocity: Math.min(path.constraints.maxAngVel, ...active.map((range) => range.maxAngVel ?? Infinity)) * Math.PI / 180,
    angularAcceleration: Math.min(path.constraints.maxAngAccel, ...active.map((range) => range.maxAngAccel ?? Infinity)) * Math.PI / 180,
    centripetal: path.constraints.maxCentripetalAccel ?? path.constraints.maxAccel,
  };
}

function validateFixture(fixture: FixedGeometryFixture, issues: FixedGeometryIssue[]): PathDoc | null {
  if (!fixture.id.trim() || !fixture.source.corpusId.trim() || !Number.isInteger(fixture.deterministicSeed)) {
    addIssue(issues, { code: "fixture:identity", message: "Fixture identity and deterministic seed are required." });
  }
  if (!SHA256.test(fixture.source.manifestSha256) || !SHA256.test(fixture.source.projectSha256)) {
    addIssue(issues, { code: "fixture:digest", message: "Fixture source digests must be lowercase SHA-256 values." });
  }
  const path = fixture.project.paths.find((candidate) => candidate.id === fixture.pathId) ?? null;
  if (!path) addIssue(issues, { code: "fixture:path", message: "Fixture path does not exist in the pinned project." });
  return path;
}

function validateSemantics(path: PathDoc, trajectory: NormalizedTrajectory, issues: FixedGeometryIssue[]): void {
  const startVelocity = path.waypoints[0]?.stop ? 0 : path.startVel;
  const goalVelocity = path.waypoints.at(-1)?.stop ? 0 : path.goalVel;
  if (Math.abs(trajectory.samples[0].velocityMps - startVelocity) > ENDPOINT_VELOCITY_TOLERANCE_MPS) {
    addIssue(issues, { code: "semantics:start-velocity", message: "Candidate start velocity differs from the frozen path." });
  }
  if (Math.abs(trajectory.samples.at(-1)!.velocityMps - goalVelocity) > ENDPOINT_VELOCITY_TOLERANCE_MPS) {
    addIssue(issues, { code: "semantics:goal-velocity", message: "Candidate goal velocity differs from the frozen path." });
  }
  path.waypoints.slice(1, -1).forEach((waypoint) => {
    if (!waypoint.stop) return;
    const nearby = trajectory.samples.filter((sample) => Math.hypot(sample.x - waypoint.x, sample.y - waypoint.y) <= STOP_POSITION_TOLERANCE_M);
    if (nearby.length === 0 || !nearby.some((sample) => Math.abs(sample.velocityMps) <= STOP_VELOCITY_TOLERANCE_MPS)) {
      addIssue(issues, { code: "semantics:interior-stop", message: "Candidate does not stop at every frozen interior stop." });
      return;
    }
    const wait = waypoint.wait ?? 0;
    if (wait > 0 && (nearby.at(-1)!.t - nearby[0].t) < wait - MAX_DENSE_STEP_S) {
      addIssue(issues, { code: "semantics:wait", message: "Candidate does not preserve the frozen waypoint wait." });
    }
  });
}

function validateGeometry(
  fixture: FixedGeometryFixture,
  path: PathDoc,
  trajectory: NormalizedTrajectory,
  dense: NormalizedTrajectory,
  issues: FixedGeometryIssue[],
): void {
  const reference = referenceGeometry(path, fixture.project);
  dense.samples.forEach((sample, sampleIndex) => {
    if (issues.some((issue) => issue.code === "geometry:fixed-path")
      && issues.some((issue) => issue.code === "geometry:fixed-heading")) return;
    const expected = referenceAt(reference, sample.f);
    if (Math.hypot(sample.x - expected.x, sample.y - expected.y) > GEOMETRY_TOLERANCE_M) {
      addIssue(issues, { code: "geometry:fixed-path", message: "Candidate leaves the frozen authored geometry.", sampleIndex });
    }
    if (Math.abs(wrappedAngle(sample.headingRad - expected.headingRad)) > HEADING_TOLERANCE_RAD) {
      addIssue(issues, { code: "geometry:fixed-heading", message: "Candidate changes the frozen heading law.", sampleIndex });
    }
  });
  if (minimumRobotFieldClearance(fixture.project.robot, dense.samples) < -1e-4) {
    addIssue(issues, { code: "geometry:field-collision", message: "Candidate swept footprint intersects the field boundary or a solid obstacle." });
  }
  validateSemantics(path, trajectory, issues);
}

export function validateNormalizedTrajectoryConstraints(
  project: BordeauxProject,
  path: PathDoc,
  dense: NormalizedTrajectory,
  source: NormalizedTrajectory,
  issues: FixedGeometryIssue[],
  curvatureSource: "authored" | "candidate" = "authored",
): void {
  const ranges = effectiveRanges(path, dense.samples, dense.totalDistanceM);
  const reference = curvatureSource === "authored" ? referenceGeometry(path, project) : null;
  let worstCentripetal: { value: number; limit: number; tolerance: number; sampleIndex: number } | null = null;
  for (let index = 1; index < dense.samples.length; index += 1) {
    const first = dense.samples[index - 1];
    const second = dense.samples[index];
    const dt = second.t - first.t;
    const ds = Math.hypot(second.x - first.x, second.y - first.y);
    const fraction = (first.f + second.f) / 2;
    const limits = limitsAt(path, project, ranges, fraction);
    const speed = ds / dt;
    const angularVelocity = wrappedAngle(second.headingRad - first.headingRad) / dt;
    if (speed > limits.velocity + tolerance(limits.velocity)) {
      addIssue(issues, { code: "constraint:velocity", message: "Candidate exceeds the frozen velocity limit.", sampleIndex: index });
    }
    const acceleration = (second.velocityMps - first.velocityMps) / dt;
    const linearLimit = acceleration >= 0 ? limits.acceleration : limits.deceleration;
    if (Math.abs(acceleration) > linearLimit + tolerance(linearLimit)) {
      addIssue(issues, { code: acceleration >= 0 ? "constraint:acceleration" : "constraint:deceleration", message: "Candidate exceeds a frozen linear acceleration limit.", sampleIndex: index });
    }
    if (Math.abs(angularVelocity) > limits.angularVelocity + tolerance(limits.angularVelocity)) {
      addIssue(issues, { code: "constraint:angular-velocity", message: "Candidate exceeds the frozen angular velocity limit.", sampleIndex: index });
    }
    if (reference) {
      const centripetal = referenceAt(reference, fraction).curvatureInvM * speed * speed;
      const centripetalTolerance = CONSTRAINT_ABSOLUTE_TOLERANCE + limits.centripetal * CENTRIPETAL_RELATIVE_TOLERANCE;
      if (!worstCentripetal || centripetal - limits.centripetal - centripetalTolerance > worstCentripetal.value - worstCentripetal.limit - worstCentripetal.tolerance) {
        worstCentripetal = { value: centripetal, limit: limits.centripetal, tolerance: centripetalTolerance, sampleIndex: index };
      }
    }
  }
  if (worstCentripetal && worstCentripetal.value > worstCentripetal.limit + worstCentripetal.tolerance) {
    addIssue(issues, {
      code: "constraint:centripetal-acceleration",
      message: `Candidate centripetal acceleration ${worstCentripetal.value.toFixed(4)} m/s² exceeds the frozen ${worstCentripetal.limit.toFixed(4)} m/s² limit.`,
      sampleIndex: worstCentripetal.sampleIndex,
    });
  }
  const actualAngularVelocities: number[] = [];
  for (let index = 1; index < source.samples.length; index += 1) {
    const first = source.samples[index - 1];
    const second = source.samples[index];
    const dt = second.t - first.t;
    const velocityX = (second.x - first.x) / dt;
    const velocityY = (second.y - first.y) / dt;
    const speed = Math.hypot(velocityX, velocityY);
    const actualAngularVelocity = wrappedAngle(second.headingRad - first.headingRad) / dt;
    actualAngularVelocities.push(actualAngularVelocity);
    const declaredAverageSpeed = (Math.abs(first.velocityMps) + Math.abs(second.velocityMps)) / 2;
    const limits = limitsAt(path, project, ranges, (first.f + second.f) / 2);
    if (Math.abs(speed - declaredAverageSpeed) > Math.max(0.08, limits.velocity * 0.03)) {
      addIssue(issues, { code: "constraint:velocity-consistency", message: "Candidate velocity does not match its timestamped position change.", sampleIndex: index });
    }
    const declaredAverageAngularVelocity = (first.angularVelocityRadps + second.angularVelocityRadps) / 2;
    if (Math.abs(actualAngularVelocity - declaredAverageAngularVelocity) > Math.max(0.08, limits.angularVelocity * 0.03)) {
      addIssue(issues, { code: "constraint:angular-velocity-consistency", message: "Candidate angular velocity does not match its timestamped heading change.", sampleIndex: index });
    }
  }
  if (curvatureSource === "candidate") {
    for (let index = 1; index < source.samples.length - 1; index += 1) {
      const limits = limitsAt(path, project, ranges, source.samples[index].f);
      const checks = [
        {
          value: geometricCentripetalAt(source.samples, index, 4),
          relativeTolerance: CANDIDATE_CENTRIPETAL_RELATIVE_TOLERANCE,
        },
        {
          value: geometricCentripetalAt(source.samples, index, 1),
          relativeTolerance: CANDIDATE_ADJACENT_CENTRIPETAL_RELATIVE_TOLERANCE,
        },
      ];
      for (const check of checks) {
        if (check.value === null) continue;
        const centripetalTolerance = CONSTRAINT_ABSOLUTE_TOLERANCE
          + limits.centripetal * check.relativeTolerance;
        if (!worstCentripetal || check.value - limits.centripetal - centripetalTolerance > worstCentripetal.value - worstCentripetal.limit - worstCentripetal.tolerance) {
          worstCentripetal = { value: check.value, limit: limits.centripetal, tolerance: centripetalTolerance, sampleIndex: index };
        }
      }
    }
    if (worstCentripetal && worstCentripetal.value > worstCentripetal.limit + worstCentripetal.tolerance) {
      addIssue(issues, {
        code: "constraint:centripetal-acceleration",
        message: `Candidate centripetal acceleration ${worstCentripetal.value.toFixed(4)} m/s² exceeds the frozen ${worstCentripetal.limit.toFixed(4)} m/s² limit.`,
        sampleIndex: worstCentripetal.sampleIndex,
      });
    }
  }
  for (let index = 1; index < actualAngularVelocities.length; index += 1) {
    const midpointDt = Math.max(1e-9, (source.samples[index + 1].t - source.samples[index - 1].t) / 2);
    const angularAcceleration = (actualAngularVelocities[index] - actualAngularVelocities[index - 1]) / midpointDt;
    const limits = limitsAt(path, project, ranges, source.samples[index].f);
    if (Math.abs(angularAcceleration) > limits.angularAcceleration + tolerance(limits.angularAcceleration)) {
      addIssue(issues, { code: "constraint:angular-acceleration", message: "Candidate exceeds the frozen angular acceleration limit derived from timestamped headings.", sampleIndex: index });
    }
  }
}

function validateCandidate(fixture: FixedGeometryFixture, candidate: unknown): FixedGeometryValidation {
  const issues: FixedGeometryIssue[] = [];
  const path = validateFixture(fixture, issues);
  const normalized = normalizeTrajectoryCandidate(candidate);
  if (!normalized.ok) issues.push(...normalized.issues.slice(0, MAX_ISSUES - issues.length));
  let trajectory: NormalizedTrajectory | undefined;
  if (path && normalized.ok) {
    trajectory = normalized.trajectory;
    const dense = densifyNormalizedTrajectory(trajectory);
    if (!dense) addIssue(issues, { code: "candidate:dense-sample-count", message: `Dense validation would exceed ${MAX_TRAJECTORY_SAMPLES} samples.` });
    else {
      validateGeometry(fixture, path, trajectory, dense, issues);
      validateNormalizedTrajectoryConstraints(fixture.project, path, dense, trajectory, issues);
    }
  }
  const valid = issues.length === 0;
  const swerve = fixture.project.robot.drive === "swerve";
  return {
    fixtureId: fixture.id,
    deterministicSeed: fixture.deterministicSeed,
    valid,
    rankingEligible: valid && swerve,
    ...(!swerve ? { exclusionReason: "The first planner leaderboard is swerve-only." } : {}),
    issues,
    ...(trajectory ? { normalized: trajectory } : {}),
  };
}

type FrozenCase = { id: string; pathId: string; deterministicSeed: number };

type FrozenManifest = {
  schemaVersion: string;
  corpusId: string;
  sourceManifest: { file: string; sha256: string };
  sourceProject: { file: string; sha256: string };
  normalization: { distance: string; progress: string; index: string; numericPrecisionPlaces: number };
  validation: {
    maximumInputSamples: number;
    maximumDenseStepM: number;
    maximumDenseStepS: number;
    fixedGeometryToleranceM: number;
    fixedHeadingToleranceDeg: number;
    endpointVelocityToleranceMps: number;
    stopPositionToleranceM: number;
    stopVelocityToleranceMps: number;
    constraintAbsoluteTolerance: number;
    constraintRelativeTolerance: number;
    centripetalRelativeTolerance: number;
  };
  leaderboard: { drive: string; tank: string };
  cases: FrozenCase[];
};

function digest(contents: string): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

function parseFrozenManifest(contents: string): FrozenManifest {
  const value = JSON.parse(contents) as FrozenManifest;
  if (value.schemaVersion !== "bordeaux-fixed-geometry/1.0"
    || value.normalization?.distance !== "recomputed-from-ordered-xy"
    || value.normalization?.progress !== "recomputed-from-distance"
    || value.normalization?.index !== "recomputed-from-order"
    || value.normalization?.numericPrecisionPlaces !== NUMBER_PLACES
    || value.validation?.maximumInputSamples !== MAX_TRAJECTORY_SAMPLES
    || value.validation?.maximumDenseStepM !== MAX_DENSE_STEP_M
    || value.validation?.maximumDenseStepS !== MAX_DENSE_STEP_S
    || value.validation?.fixedGeometryToleranceM !== GEOMETRY_TOLERANCE_M
    || value.validation?.fixedHeadingToleranceDeg !== HEADING_TOLERANCE_RAD * 180 / Math.PI
    || value.validation?.endpointVelocityToleranceMps !== ENDPOINT_VELOCITY_TOLERANCE_MPS
    || value.validation?.stopPositionToleranceM !== STOP_POSITION_TOLERANCE_M
    || value.validation?.stopVelocityToleranceMps !== STOP_VELOCITY_TOLERANCE_MPS
    || value.validation?.constraintAbsoluteTolerance !== CONSTRAINT_ABSOLUTE_TOLERANCE
    || value.validation?.constraintRelativeTolerance !== CONSTRAINT_RELATIVE_TOLERANCE
    || value.validation?.centripetalRelativeTolerance !== CENTRIPETAL_RELATIVE_TOLERANCE
    || value.leaderboard?.drive !== "swerve"
    || value.leaderboard?.tank !== "correctness-only"
    || !Array.isArray(value.cases)
    || value.cases.length === 0) {
    throw new Error("Fixed-geometry manifest does not match the validator contract.");
  }
  return value;
}

export class FixedGeometryCorpus {
  readonly corpusId: string;
  readonly cases: ReadonlyArray<FrozenCase>;
  readonly #fixtures: ReadonlyMap<string, FixedGeometryFixture>;

  private constructor(authority: symbol, corpusId: string, fixtures: FixedGeometryFixture[]) {
    if (authority !== CORPUS_AUTHORITY) throw new Error("Fixed-geometry corpus must be loaded from the pinned manifest.");
    this.corpusId = corpusId;
    this.cases = Object.freeze(fixtures.map((fixture) => Object.freeze({
      id: fixture.id,
      pathId: fixture.pathId,
      deterministicSeed: fixture.deterministicSeed,
    })));
    this.#fixtures = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  }

  static loadV2(directory: string): FixedGeometryCorpus {
    const fixedContents = readFileSync(join(directory, "fixed-geometry.json"), "utf8");
    const lockDigest = readFileSync(join(directory, "fixed-geometry.sha256"), "utf8").trim();
    const actualFixedDigest = digest(fixedContents);
    if (actualFixedDigest !== FIXED_GEOMETRY_V2_SHA256 || lockDigest !== FIXED_GEOMETRY_V2_SHA256) {
      throw new Error("Fixed-geometry manifest digest does not match the pinned v2 corpus.");
    }
    const frozen = parseFrozenManifest(fixedContents);
    const manifestContents = readFileSync(join(directory, frozen.sourceManifest.file), "utf8");
    const projectContents = readFileSync(join(directory, frozen.sourceProject.file), "utf8");
    if (digest(manifestContents) !== frozen.sourceManifest.sha256) {
      throw new Error("Planner corpus manifest digest does not match the fixed-geometry source.");
    }
    if (digest(projectContents) !== frozen.sourceProject.sha256) {
      throw new Error("Planner corpus project digest does not match the fixed-geometry source.");
    }
    const sourceManifest = JSON.parse(manifestContents) as { corpusId?: unknown; project?: { sha256?: unknown } };
    if (sourceManifest.corpusId !== frozen.corpusId || sourceManifest.project?.sha256 !== frozen.sourceProject.sha256) {
      throw new Error("Fixed-geometry source identities do not match the planner corpus manifest.");
    }
    const decoded = decodeProjectFile(projectContents);
    if (decoded.migrated || decoded.project.robot.drive !== "swerve") {
      throw new Error("Fixed-geometry v2 requires a current, migration-free swerve project.");
    }
    const caseIds = new Set<string>();
    const pathIds = new Set<string>();
    const seeds = new Set<number>();
    for (const benchmarkCase of frozen.cases) {
      if (!benchmarkCase.id?.trim() || !benchmarkCase.pathId?.trim()
        || !Number.isInteger(benchmarkCase.deterministicSeed)
        || caseIds.has(benchmarkCase.id) || pathIds.has(benchmarkCase.pathId) || seeds.has(benchmarkCase.deterministicSeed)) {
        throw new Error("Fixed-geometry cases require unique IDs, path IDs, and integer seeds.");
      }
      caseIds.add(benchmarkCase.id);
      pathIds.add(benchmarkCase.pathId);
      seeds.add(benchmarkCase.deterministicSeed);
    }
    if (decoded.project.paths.length !== pathIds.size
      || decoded.project.paths.some((path) => !pathIds.has(path.id))) {
      throw new Error("Fixed-geometry cases must cover every path in the pinned project exactly once.");
    }
    return new FixedGeometryCorpus(CORPUS_AUTHORITY, frozen.corpusId, frozen.cases.map((benchmarkCase) => ({
      id: benchmarkCase.id,
      deterministicSeed: benchmarkCase.deterministicSeed,
      source: {
        corpusId: frozen.corpusId,
        manifestSha256: frozen.sourceManifest.sha256,
        projectSha256: frozen.sourceProject.sha256,
      },
      project: decoded.project,
      pathId: benchmarkCase.pathId,
    })));
  }

  validate(fixtureId: string, candidate: unknown): FixedGeometryValidation {
    const fixture = this.#fixtures.get(fixtureId);
    if (!fixture) {
      return {
        fixtureId,
        deterministicSeed: 0,
        valid: false,
        rankingEligible: false,
        issues: [{ code: "fixture:identity", message: "Fixture is not part of the pinned fixed-geometry corpus." }],
      };
    }
    return validateCandidate(fixture, candidate);
  }
}

export function validateTankTrajectoryCandidate(
  project: BordeauxProject,
  pathId: string,
  candidate: unknown,
): FixedGeometryValidation {
  if (project.robot.drive !== "tank") {
    return {
      fixtureId: "tank-correctness-only",
      deterministicSeed: 0,
      valid: false,
      rankingEligible: false,
      exclusionReason: "The first planner leaderboard is swerve-only.",
      issues: [{ code: "fixture:drive", message: "Tank correctness validation requires a tank project." }],
    };
  }
  return validateCandidate({
    id: "tank-correctness-only",
    deterministicSeed: 0,
    source: {
      corpusId: "tank-correctness-only",
      manifestSha256: `sha256:${"0".repeat(64)}`,
      projectSha256: `sha256:${"0".repeat(64)}`,
    },
    project,
    pathId,
  }, candidate);
}
