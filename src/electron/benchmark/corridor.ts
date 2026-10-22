import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { minimumRobotFieldClearance } from "../../shared/agent/fieldClearance";
import { robotFootprintAt, robotFootprintRadius } from "../../shared/agent/robotFootprint";
import { FIELD_H, FIELD_W } from "../../shared/math/fieldBounds";
import { PM } from "../../shared/math/pm";
import { decodeProjectFile } from "../../shared/project/fileFormat";
import type { BordeauxProject, ControlPoint, PathDoc } from "../../shared/types";
import {
  densifyNormalizedTrajectory,
  CANDIDATE_ADJACENT_CENTRIPETAL_RELATIVE_TOLERANCE,
  CANDIDATE_CENTRIPETAL_RELATIVE_TOLERANCE,
  FIXED_GEOMETRY_V2_SHA256,
  FixedGeometryCorpus,
  normalizeTrajectoryCandidate,
  validateNormalizedTrajectoryConstraints,
  type FixedGeometryIssue,
  type FixedGeometryValidation,
  type NormalizedTrajectory,
} from "./fixedGeometry";

const CORRIDOR_V2_SHA256 = "sha256:626ec8af867207729815446bf0257d1ed5993ddcd22b35ad6759ea4e4c20c89b";
const CORPUS_AUTHORITY = Symbol("bordeaux-corridor-corpus");
const MAX_DENSE_STEP_M = 0.02;
const MAX_DENSE_STEP_S = 0.02;
const MAX_SOURCE_STEP_M = 0.1;
const ENDPOINT_POSITION_TOLERANCE_M = 0.03;
const ENDPOINT_HEADING_TOLERANCE_RAD = 2 * Math.PI / 180;
const GATE_TOLERANCE_M = 1e-6;
const STOP_POSITION_TOLERANCE_M = 0.04;
const STOP_VELOCITY_TOLERANCE_MPS = 0.05;
const MAX_ISSUES = 64;

export interface CorridorGate {
  id: string;
  bounds: { xMin: number; xMax: number; yMin: number; yMax: number };
}

export interface CorridorStop {
  waypointIndex: number;
  waitS: number;
}

export interface CorridorCase {
  id: string;
  pathId: string;
  deterministicSeed: number;
  centerlineToFootprintBoundaryM: number;
  gates: CorridorGate[];
  stops: CorridorStop[];
  eventOrder: string[];
}

interface CorridorFixture extends CorridorCase {
  project: BordeauxProject;
  path: PathDoc;
}

type CorridorManifest = {
  schemaVersion: string;
  corpusId: string;
  sourceFixedGeometry: { file: string; sha256: string };
  sourceProject: { file: string; sha256: string };
  validation: {
    maximumDenseStepM: number;
    maximumDenseStepS: number;
    maximumSourceStepM: number;
    endpointPositionToleranceM: number;
    endpointHeadingToleranceDeg: number;
    gateToleranceM: number;
    stopPositionToleranceM: number;
    stopVelocityToleranceMps: number;
    candidateCentripetalRelativeTolerance: number;
    candidateAdjacentCentripetalRelativeTolerance: number;
  };
  leaderboard: { drive: string };
  cases: CorridorCase[];
};

function digest(contents: string): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function wrappedAngle(value: number): number {
  return Math.atan2(Math.sin(value), Math.cos(value));
}

function addIssue(issues: FixedGeometryIssue[], issue: FixedGeometryIssue): void {
  if (issues.length >= MAX_ISSUES || issues.some((candidate) => candidate.code === issue.code)) return;
  issues.push(issue);
}

function pointSegmentDistance(point: ControlPoint, first: ControlPoint, second: ControlPoint): number {
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 1e-12) return Math.hypot(point.x - first.x, point.y - first.y);
  const progress = Math.max(0, Math.min(1, ((point.x - first.x) * dx + (point.y - first.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (first.x + dx * progress), point.y - (first.y + dy * progress));
}

function distanceToPolyline(point: ControlPoint, polyline: readonly ControlPoint[]): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < polyline.length; index += 1) {
    minimum = Math.min(minimum, pointSegmentDistance(point, polyline[index - 1], polyline[index]));
  }
  return minimum;
}

function referenceGeometry(path: PathDoc): ControlPoint[] {
  return (PM.sample(path.waypoints, 128).pts as ControlPoint[]).map((point) => ({ x: point.x, y: point.y }));
}

function endpointHeadings(path: PathDoc, project: BordeauxProject): { start: number; goal: number } {
  const derived = PM.derivePath(path, project.robot, 128, { skipStationaryActions: true });
  const headings = derived.metrics.head as number[];
  return { start: headings[0] ?? 0, goal: headings.at(-1) ?? 0 };
}

function validateEndpoint(
  fixture: CorridorFixture,
  trajectory: NormalizedTrajectory,
  issues: FixedGeometryIssue[],
): void {
  const expectedHeadings = endpointHeadings(fixture.path, fixture.project);
  const endpoints = [
    ["start", fixture.path.waypoints[0], trajectory.samples[0], expectedHeadings.start],
    ["goal", fixture.path.waypoints.at(-1)!, trajectory.samples.at(-1)!, expectedHeadings.goal],
  ] as const;
  for (const [name, expected, actual, heading] of endpoints) {
    if (Math.hypot(actual.x - expected.x, actual.y - expected.y) > ENDPOINT_POSITION_TOLERANCE_M
      || Math.abs(wrappedAngle(actual.headingRad - heading)) > ENDPOINT_HEADING_TOLERANCE_RAD) {
      addIssue(issues, { code: `topology:${name}-pose`, message: `Candidate ${name} pose differs from the frozen corridor endpoint.` });
    }
  }
}

function validateGates(fixture: CorridorFixture, dense: NormalizedTrajectory, issues: FixedGeometryIssue[]): void {
  let cursor = 0;
  for (const gate of fixture.gates) {
    let found = -1;
    for (let index = cursor; index < dense.samples.length; index += 1) {
      const sample = dense.samples[index];
      if (sample.x >= gate.bounds.xMin - GATE_TOLERANCE_M && sample.x <= gate.bounds.xMax + GATE_TOLERANCE_M
        && sample.y >= gate.bounds.yMin - GATE_TOLERANCE_M && sample.y <= gate.bounds.yMax + GATE_TOLERANCE_M) {
        found = index;
        break;
      }
    }
    if (found < 0) {
      addIssue(issues, { code: "topology:gate-order", message: `Candidate does not visit corridor gate ${gate.id} in the frozen order.` });
      return;
    }
    cursor = found;
  }
}

function validateStops(fixture: CorridorFixture, trajectory: NormalizedTrajectory, issues: FixedGeometryIssue[]): void {
  for (const stop of fixture.stops) {
    const waypoint = fixture.path.waypoints[stop.waypointIndex];
    const nearby = trajectory.samples.filter((sample) => Math.hypot(sample.x - waypoint.x, sample.y - waypoint.y) <= STOP_POSITION_TOLERANCE_M);
    if (nearby.length === 0 || !nearby.some((sample) => Math.abs(sample.velocityMps) <= STOP_VELOCITY_TOLERANCE_MPS)) {
      addIssue(issues, { code: "topology:stop", message: `Candidate does not stop at frozen waypoint ${stop.waypointIndex}.` });
      continue;
    }
    if ((nearby.at(-1)!.t - nearby[0].t) < stop.waitS - MAX_DENSE_STEP_S) {
      addIssue(issues, { code: "topology:stop-wait", message: `Candidate does not preserve the ${stop.waitS}s corridor stop wait.` });
    }
  }
}

function validateEvents(fixture: CorridorFixture, candidate: unknown, totalTimeS: number, issues: FixedGeometryIssue[]): void {
  if (!isRecord(candidate) || !Array.isArray(candidate.events)) {
    addIssue(issues, { code: "topology:event-order", message: "Candidate events must preserve the frozen event order." });
    return;
  }
  const parsed: Array<{ id: string; timeS: number }> = [];
  for (const value of candidate.events) {
    if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim() || !finite(value.timeS)) {
      addIssue(issues, { code: "topology:event-order", message: "Candidate events must have bounded IDs and finite times." });
      return;
    }
    parsed.push({ id: value.id, timeS: value.timeS });
  }
  if (parsed.length !== fixture.eventOrder.length
    || parsed.some((event, index) => event.id !== fixture.eventOrder[index]
      || event.timeS < 0 || event.timeS > totalTimeS
      || (index > 0 && event.timeS <= parsed[index - 1].timeS))) {
    addIssue(issues, { code: "topology:event-order", message: "Candidate events differ from the frozen ordered event contract." });
  }
}

function validateSweptFootprint(fixture: CorridorFixture, dense: NormalizedTrajectory, issues: FixedGeometryIssue[]): void {
  const reference = referenceGeometry(fixture.path);
  for (let sampleIndex = 0; sampleIndex < dense.samples.length; sampleIndex += 1) {
    const sample = dense.samples[sampleIndex];
    const footprint = robotFootprintAt(fixture.project.robot, sample);
    if (footprint.some((vertex) => distanceToPolyline(vertex, reference) > fixture.centerlineToFootprintBoundaryM + 1e-6)) {
      addIssue(issues, { code: "corridor:swept-footprint", message: "Candidate swept footprint leaves the frozen safe corridor.", sampleIndex });
      break;
    }
  }
  if (minimumRobotFieldClearance(fixture.project.robot, dense.samples) < -1e-4) {
    addIssue(issues, { code: "corridor:field-collision", message: "Candidate swept footprint intersects a field boundary or solid obstacle." });
  }
}

function validateCandidate(fixture: CorridorFixture, candidate: unknown): FixedGeometryValidation {
  const normalized = normalizeTrajectoryCandidate(candidate);
  if (!normalized.ok) {
    return {
      fixtureId: fixture.id,
      deterministicSeed: fixture.deterministicSeed,
      valid: false,
      rankingEligible: false,
      issues: normalized.issues,
    };
  }
  const issues: FixedGeometryIssue[] = [];
  if (normalized.trajectory.samples.some((sample, index, samples) => index > 0
    && Math.hypot(sample.x - samples[index - 1].x, sample.y - samples[index - 1].y) > MAX_SOURCE_STEP_M + 1e-9)) {
    addIssue(issues, {
      code: "candidate:source-density",
      message: `Candidate source poses must be no more than ${MAX_SOURCE_STEP_M}m apart.`,
    });
  }
  const dense = densifyNormalizedTrajectory(normalized.trajectory);
  if (!dense) addIssue(issues, { code: "candidate:dense-sample-count", message: "Dense corridor validation exceeds the bounded sample ceiling." });
  else {
    validateEndpoint(fixture, normalized.trajectory, issues);
    validateGates(fixture, dense, issues);
    validateStops(fixture, normalized.trajectory, issues);
    validateEvents(fixture, candidate, normalized.trajectory.totalTimeS, issues);
    validateSweptFootprint(fixture, dense, issues);
    validateNormalizedTrajectoryConstraints(fixture.project, fixture.path, dense, normalized.trajectory, issues, "candidate");
  }
  const valid = issues.length === 0;
  return {
    fixtureId: fixture.id,
    deterministicSeed: fixture.deterministicSeed,
    valid,
    rankingEligible: valid,
    issues,
    normalized: normalized.trajectory,
  };
}

function parseManifest(contents: string): CorridorManifest {
  const value = JSON.parse(contents) as CorridorManifest;
  if (value.schemaVersion !== "bordeaux-corridor/1.0"
    || value.sourceFixedGeometry?.sha256 !== FIXED_GEOMETRY_V2_SHA256
    || value.validation?.maximumDenseStepM !== MAX_DENSE_STEP_M
    || value.validation?.maximumDenseStepS !== MAX_DENSE_STEP_S
    || value.validation?.maximumSourceStepM !== MAX_SOURCE_STEP_M
    || value.validation?.endpointPositionToleranceM !== ENDPOINT_POSITION_TOLERANCE_M
    || value.validation?.endpointHeadingToleranceDeg !== ENDPOINT_HEADING_TOLERANCE_RAD * 180 / Math.PI
    || value.validation?.gateToleranceM !== GATE_TOLERANCE_M
    || value.validation?.stopPositionToleranceM !== STOP_POSITION_TOLERANCE_M
    || value.validation?.stopVelocityToleranceMps !== STOP_VELOCITY_TOLERANCE_MPS
    || value.validation?.candidateCentripetalRelativeTolerance !== CANDIDATE_CENTRIPETAL_RELATIVE_TOLERANCE
    || value.validation?.candidateAdjacentCentripetalRelativeTolerance !== CANDIDATE_ADJACENT_CENTRIPETAL_RELATIVE_TOLERANCE
    || value.leaderboard?.drive !== "swerve"
    || !Array.isArray(value.cases) || value.cases.length === 0) {
    throw new Error("Corridor manifest does not match the validator contract.");
  }
  return value;
}

export class CorridorCorpus {
  readonly corpusId: string;
  readonly cases: ReadonlyArray<CorridorCase>;
  readonly #fixtures: ReadonlyMap<string, CorridorFixture>;

  private constructor(authority: symbol, corpusId: string, fixtures: CorridorFixture[]) {
    if (authority !== CORPUS_AUTHORITY) throw new Error("Corridor corpus must be loaded from the pinned manifest.");
    this.corpusId = corpusId;
    this.cases = Object.freeze(fixtures.map(({ project: _project, path: _path, ...fixture }) => structuredClone(fixture)));
    this.#fixtures = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  }

  static loadV2(directory: string): CorridorCorpus {
    const fixed = FixedGeometryCorpus.loadV2(directory);
    const contents = readFileSync(join(directory, "corridor.json"), "utf8");
    const lockDigest = readFileSync(join(directory, "corridor.sha256"), "utf8").trim();
    if (digest(contents) !== CORRIDOR_V2_SHA256 || lockDigest !== CORRIDOR_V2_SHA256) {
      throw new Error("Corridor manifest digest does not match the pinned v2 corpus.");
    }
    const manifest = parseManifest(contents);
    if (manifest.corpusId !== fixed.corpusId || manifest.sourceFixedGeometry.file !== "fixed-geometry.json") {
      throw new Error("Corridor source identity does not match the fixed-geometry corpus.");
    }
    const projectContents = readFileSync(join(directory, manifest.sourceProject.file), "utf8");
    if (digest(projectContents) !== manifest.sourceProject.sha256) {
      throw new Error("Corridor project digest does not match the pinned source.");
    }
    const decoded = decodeProjectFile(projectContents);
    if (decoded.migrated || decoded.project.robot.drive !== "swerve") {
      throw new Error("Corridor v2 requires a current, migration-free swerve project.");
    }
    const fixedPaths = new Set(fixed.cases.map((value) => value.pathId));
    const ids = new Set<string>();
    const paths = new Set<string>();
    const seeds = new Set<number>();
    const fixtures = manifest.cases.map((value): CorridorFixture => {
      const path = decoded.project.paths.find((candidate) => candidate.id === value.pathId);
      if (!value.id?.trim() || !path || !fixedPaths.has(value.pathId) || !Number.isInteger(value.deterministicSeed)
        || ids.has(value.id) || paths.has(value.pathId) || seeds.has(value.deterministicSeed)
        || !finite(value.centerlineToFootprintBoundaryM)
        || value.centerlineToFootprintBoundaryM <= robotFootprintRadius(decoded.project.robot)
        || !Array.isArray(value.gates) || value.gates.length === 0
        || !Array.isArray(value.stops) || !Array.isArray(value.eventOrder) || value.eventOrder.length === 0) {
        throw new Error("Corridor cases require unique fixed paths, seeds, gates, events, and footprint-safe widths.");
      }
      const eventIds = new Set<string>();
      if (value.eventOrder.some((eventId) => {
        if (!eventId?.trim() || eventId.length > 128 || eventIds.has(eventId)) return true;
        eventIds.add(eventId);
        return false;
      })) {
        throw new Error("Corridor event IDs must be unique and bounded.");
      }
      for (const gate of value.gates) {
        const bounds = gate?.bounds;
        if (!gate?.id?.trim() || !bounds || ![bounds.xMin, bounds.xMax, bounds.yMin, bounds.yMax].every(finite)
          || bounds.xMin >= bounds.xMax || bounds.yMin >= bounds.yMax
          || bounds.xMin < 0 || bounds.xMax > FIELD_W || bounds.yMin < 0 || bounds.yMax > FIELD_H) {
          throw new Error("Corridor gates must be named, finite, ordered field bounds.");
        }
      }
      for (const stop of value.stops) {
        const waypoint = path.waypoints[stop.waypointIndex];
        if (!Number.isInteger(stop.waypointIndex) || !waypoint?.stop || !finite(stop.waitS)
          || Math.abs((waypoint.wait ?? 0) - stop.waitS) > 1e-9) {
          throw new Error("Corridor stops must match frozen stopped waypoints and waits.");
        }
      }
      ids.add(value.id);
      paths.add(value.pathId);
      seeds.add(value.deterministicSeed);
      return { ...structuredClone(value), project: decoded.project, path };
    });
    return new CorridorCorpus(CORPUS_AUTHORITY, manifest.corpusId, fixtures);
  }

  validate(fixtureId: string, candidate: unknown): FixedGeometryValidation {
    const fixture = this.#fixtures.get(fixtureId);
    if (!fixture) {
      return {
        fixtureId,
        deterministicSeed: 0,
        valid: false,
        rankingEligible: false,
        issues: [{ code: "fixture:identity", message: "Fixture is not part of the pinned corridor corpus." }],
      };
    }
    return validateCandidate(fixture, candidate);
  }
}
