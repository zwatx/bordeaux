import { minimumRobotFieldClearance, observeRobotFieldPortalSequence } from "../agent/fieldClearance";
import { robotFootprintAt, robotFootprintRadius } from "../agent/robotFootprint";
import { PM } from "../math/pm";
import { clone } from "../project/defaults";
import { physicalPlannerInput } from "../robotLimits";
import type { ControlPoint, PathDoc, PlannerInput, PlannerOptimizationDiagnostics, PlannerResult, TrajectorySample } from "../types";
import { optimizeFixedGeometryFinal } from "./fixedGeometryFinal";
import { fixedPathSamples, getPlanner } from "./index";
import { DEFAULT_SAMPLES_PER_SEGMENT } from "./limits";
import { validateOptimizedTrajectory } from "./trajectoryValidation";

const DEFAULT_CORRIDOR_M = 0.15;
const MIN_CORRIDOR_M = 0.03;
const MAX_CORRIDOR_M = 1.5;
const MAX_SEGMENTS = 40;
const MAX_EVALUATIONS = 72;
const DEFAULT_EVALUATIONS = Object.freeze({ common: 24, stress: 48, hard: 72 });
const MIN_GAIN_S = 0.02;
const MIN_GAIN_FRACTION = 0.005;
const EPSILON = 1e-6;

export interface CorridorGateBounds {
  bounds: { xMin: number; xMax: number; yMin: number; yMax: number };
}

/** Search counters that change without changing the retained incumbent. */
export type CorridorSearchStatistics = Required<Pick<
  PlannerOptimizationDiagnostics,
  "solveTimeMs" | "evaluations" | "validatedCandidates" | "rejectedCandidates" | "rejectionReasons"
>>;

export interface CorridorFinalOptions {
  corridorM?: number;
  minimumClearanceM?: number;
  gates?: readonly CorridorGateBounds[];
  budgetTier?: "common" | "stress" | "hard";
  budgetMs?: number;
  maximumEvaluations?: number;
  isCancelled?: () => boolean;
  /**
   * Emits the initial and each materially improved validated incumbent, with
   * search counters as of that checkpoint. Completion never applies them.
   */
  onProgress?: (result: PlannerResult) => void;
  /**
   * Emits current counters after each evaluation that did not publish a new
   * incumbent, so consumers can refresh retained metadata without a route.
   */
  onStatistics?: (statistics: CorridorSearchStatistics) => void;
}

interface Handle {
  waypointIndex: number;
  key: "prevC" | "nextC";
  chordM: number;
}

interface GeometryPoint extends ControlPoint {
  seg: number;
}

interface Evaluation {
  path: PathDoc;
  result: PlannerResult;
  maxDeviationM: number;
  minimumClearanceM: number;
}

function distance(first: ControlPoint, second: ControlPoint): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function pointSegmentDistance(point: ControlPoint, first: ControlPoint, second: ControlPoint): number {
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 1e-12) return distance(point, first);
  const progress = Math.max(0, Math.min(1, ((point.x - first.x) * dx + (point.y - first.y) * dy) / lengthSquared));
  return Math.hypot(point.x - first.x - dx * progress, point.y - first.y - dy * progress);
}

function pointsBySegment(points: readonly GeometryPoint[]): Map<number, GeometryPoint[]> {
  const result = new Map<number, GeometryPoint[]>();
  points.forEach((point) => {
    const segment = result.get(point.seg) ?? [];
    segment.push(point);
    result.set(point.seg, segment);
  });
  return result;
}

function directedDeviation(points: readonly GeometryPoint[], reference: ReadonlyMap<number, readonly GeometryPoint[]>): number {
  let maximum = 0;
  for (const point of points) {
    const segment = reference.get(point.seg);
    if (!segment || segment.length < 2) return Number.POSITIVE_INFINITY;
    let nearest = Number.POSITIVE_INFINITY;
    for (let index = 1; index < segment.length; index += 1) {
      nearest = Math.min(nearest, pointSegmentDistance(point, segment[index - 1], segment[index]));
    }
    maximum = Math.max(maximum, nearest);
  }
  return maximum;
}

function routeDeviation(reference: readonly GeometryPoint[], candidate: readonly GeometryPoint[]): number {
  return Math.max(
    directedDeviation(candidate, pointsBySegment(reference)),
    directedDeviation(reference, pointsBySegment(candidate)),
  );
}

/** Returns any reference edge within limitM of point, scanning every edge from startEdge, or -1. */
function edgeWithin(point: ControlPoint, reference: readonly ControlPoint[], limitM: number, startEdge: number): number {
  const edges = reference.length - 1;
  for (let offset = 0; offset < edges; offset += 1) {
    const edge = (startEdge + offset) % edges;
    if (pointSegmentDistance(point, reference[edge], reference[edge + 1]) <= limitM) return edge;
  }
  return -1;
}

export function sweptFootprintInsideCorridor(
  robot: PlannerInput["robot"],
  samples: readonly TrajectorySample[],
  reference: readonly ControlPoint[],
  corridorM: number,
): boolean {
  // Nonfinite reference points yield NaN edge distances, which the exact
  // minimum always rejected; an early-return scan could otherwise skip them.
  const finite = reference.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  const limitM = robotFootprintRadius(robot) + corridorM + EPSILON;
  // Adjacent vertices usually share a nearby edge; the scan still wraps, so
  // self-crossing routes accept exactly what an exhaustive minimum accepts.
  let edge = 0;
  return samples.every((sample) => finite && robotFootprintAt(robot, sample).every((vertex) => {
    edge = edgeWithin(vertex, reference, limitM, edge);
    return edge >= 0;
  }));
}

function passesGates(samples: PlannerResult["samples"], gates: readonly CorridorGateBounds[]): boolean {
  let cursor = 0;
  for (const gate of gates) {
    let found = -1;
    for (let index = cursor; index < samples.length; index += 1) {
      const sample = samples[index];
      if (sample.x >= gate.bounds.xMin - EPSILON && sample.x <= gate.bounds.xMax + EPSILON
        && sample.y >= gate.bounds.yMin - EPSILON && sample.y <= gate.bounds.yMax + EPSILON) {
        found = index;
        break;
      }
    }
    if (found < 0) return false;
    cursor = found;
  }
  return true;
}

/** Revalidates saved geometry against the current authored corridor and field. */
export function validateCorridorCandidate(
  input: PlannerInput,
  result: PlannerResult,
  options: CorridorFinalOptions = {},
  baseline: PlannerResult = optimizeFixedGeometryFinal(input),
): boolean {
  const corridorM = Math.max(MIN_CORRIDOR_M, Math.min(MAX_CORRIDOR_M, options.corridorM ?? DEFAULT_CORRIDOR_M));
  const resolution = Math.max(128, (input.samplesPerSegment ?? DEFAULT_SAMPLES_PER_SEGMENT) * 2);
  const reference = PM.sample(input.path.waypoints, resolution).pts as GeometryPoint[];
  const candidate = PM.sample((result.optimizedPath ?? input.path).waypoints, resolution).pts as GeometryPoint[];
  const deviationM = routeDeviation(reference, candidate);
  const authoredTopology = observeRobotFieldPortalSequence(input.robot, baseline.samples);
  const topology = observeRobotFieldPortalSequence(input.robot, result.samples);
  return Number.isFinite(deviationM) && deviationM <= corridorM + EPSILON
    && authoredTopology.valid && topology.valid
    && topology.visits.length === authoredTopology.visits.length
    && topology.visits.every((visit, index) => visit.id === authoredTopology.visits[index].id)
    && passesGates(result.samples, options.gates ?? [])
    && sweptFootprintInsideCorridor(input.robot, result.samples, reference, corridorM)
    && minimumRobotFieldClearance(input.robot, result.samples) >= Math.max(0, options.minimumClearanceM ?? 0) - EPSILON;
}

function movableHandles(path: PathDoc): Handle[] {
  const handles: Handle[] = [];
  path.waypoints.slice(0, -1).forEach((waypoint, segmentIndex) => {
    const next = path.waypoints[segmentIndex + 1];
    if ((waypoint.segType ?? "bezier") !== "bezier") return;
    if (waypoint.nextC && distance(waypoint, waypoint.nextC) > EPSILON) {
      handles.push({ waypointIndex: segmentIndex, key: "nextC", chordM: distance(waypoint, next) });
    }
    if (next.prevC && distance(next, next.prevC) > EPSILON) {
      handles.push({ waypointIndex: segmentIndex + 1, key: "prevC", chordM: distance(waypoint, next) });
    }
  });
  return handles;
}

function setHandleLength(path: PathDoc, handle: Handle, lengthM: number): void {
  const waypoint = path.waypoints[handle.waypointIndex];
  const control = waypoint[handle.key];
  if (!control) return;
  const currentM = distance(waypoint, control);
  if (currentM <= EPSILON) return;
  waypoint[handle.key] = {
    x: waypoint.x + (control.x - waypoint.x) / currentM * lengthM,
    y: waypoint.y + (control.y - waypoint.y) / currentM * lengthM,
  };
}

function corridorDiagnostics(
  result: PlannerResult,
  options: Required<Pick<CorridorFinalOptions, "budgetTier" | "budgetMs">>,
  patch: Partial<PlannerOptimizationDiagnostics>,
): PlannerOptimizationDiagnostics {
  const source = result.optimization ?? {
    plannerUsed: result.planner,
    solveTimeMs: 0,
    totalTimeS: result.totalTimeS,
    maxVelocityMps: Math.max(...result.samples.map((sample) => Math.abs(sample.velocityMps))),
    maxAccelerationMps2: Math.max(...result.samples.map((sample) => Math.abs(sample.accelerationMps2))),
    constraintViolations: 0,
    fallback: false,
  };
  return {
    ...source,
    optimizationClass: "corridor",
    budgetTier: options.budgetTier,
    budgetMs: options.budgetMs,
    ...patch,
  };
}

function fallback(
  baseline: PlannerResult,
  options: Required<Pick<CorridorFinalOptions, "budgetTier" | "budgetMs">>,
  evaluations: number,
  status: "equivalent" | "invalid-input",
  reason?: string,
): PlannerResult {
  return {
    ...baseline,
    optimization: corridorDiagnostics(baseline, options, {
      plannerUsed: baseline.planner,
      status,
      totalTimeS: baseline.totalTimeS,
      constraintViolations: baseline.optimization?.constraintViolations ?? 0,
      fallback: status !== "equivalent",
      fallbackReason: reason,
      evaluations,
      maxDeviationM: 0,
    }),
  };
}

/**
 * Deterministically searches Bezier handle lengths inside an authored swept-
 * footprint corridor. Waypoint positions, handle directions, stops, markers,
 * and the input path remain immutable.
 */
export function optimizeCorridorFinal(input: PlannerInput, requested: CorridorFinalOptions = {}): PlannerResult {
  const startedAt = performance.now();
  const budgetTier = requested.budgetTier ?? "common";
  const budgetMs = Math.max(1, Math.min(30_000, requested.budgetMs
    ?? (budgetTier === "hard" ? 30_000 : budgetTier === "stress" ? 15_000 : 5_000)));
  const diagnosticsOptions = { budgetTier, budgetMs };
  const corridorM = Math.max(MIN_CORRIDOR_M, Math.min(MAX_CORRIDOR_M, requested.corridorM ?? DEFAULT_CORRIDOR_M));
  const minimumClearanceM = Math.max(0, Math.min(0.5, requested.minimumClearanceM ?? 0));
  const maximumEvaluations = Math.max(1, Math.min(
    MAX_EVALUATIONS,
    requested.maximumEvaluations ?? DEFAULT_EVALUATIONS[budgetTier],
  ));
  const authored = clone(input.path);
  const baseline = optimizeFixedGeometryFinal({ ...input, path: authored });
  const baselineTopology = observeRobotFieldPortalSequence(input.robot, baseline.samples);
  let evaluations = 0;
  let validatedCandidates = 0;
  let rejectedCandidates = 0;
  let termination: PlannerOptimizationDiagnostics["termination"];
  let longestEvaluationMs = 0;
  const rejectionReasons = new Map<string, number>();
  const canEvaluate = () => {
    if (requested.isCancelled?.()) { termination = "cancelled"; return false; }
    if (evaluations >= maximumEvaluations) { termination = "work-budget"; return false; }
    // Keep room for one more evaluation and serializing the incumbent before
    // the worker's separate hard deadline. Search order stays deterministic.
    const remainingMs = budgetMs - (performance.now() - startedAt);
    if (remainingMs <= Math.max(100, longestEvaluationMs * 1.25)) {
      termination = "time-budget";
      return false;
    }
    return true;
  };
  const earlyResult = (reason: string, invalid = false) => {
    const result = fallback(baseline, diagnosticsOptions, evaluations, invalid ? "invalid-input" : "equivalent", reason);
    result.optimization = {
      ...result.optimization!,
      termination: invalid ? "invalid-baseline" : "unsupported",
      solveTimeMs: performance.now() - startedAt,
      validatedCandidates: 0,
      rejectedCandidates: 0,
      rejectionReasons: [],
      baselineTimeS: baseline.totalTimeS,
      gainS: 0,
    };
    if (!invalid) requested.onProgress?.(result);
    return result;
  };

  if (baseline.optimization?.fallback || baseline.diagnostics.some((issue) => issue.severity === "error")) {
    return earlyResult(baseline.optimization?.fallbackReason ?? "The normal trajectory could not be validated.", true);
  }
  if (!baselineTopology.valid) {
    return earlyResult("Corridor optimization kept the authored geometry because its typed-portal sequence is ambiguous.");
  }
  if (authored.waypoints.length < 2 || authored.waypoints.length - 1 > MAX_SEGMENTS) {
    return earlyResult(`Corridor optimization supports 1-${MAX_SEGMENTS} segments.`);
  }
  if (authored.waypoints.slice(0, -1).some((waypoint) => (waypoint.segType ?? "bezier") !== "bezier")) {
    return earlyResult("Corridor optimization currently supports all-Bezier paths.");
  }
  if (authored.waypoints.some((waypoint) => waypoint.jiggle)) {
    return earlyResult("Corridor optimization keeps paths with jiggle actions on their authored geometry.");
  }

  const samplesPerSegment = input.samplesPerSegment ?? DEFAULT_SAMPLES_PER_SEGMENT;
  const reference = PM.sample(authored.waypoints, Math.max(128, samplesPerSegment * 2)).pts as GeometryPoint[];
  const handles = movableHandles(authored);
  if (handles.length === 0) return earlyResult("The path has no movable Bezier handles.");

  const baselineClearanceM = minimumRobotFieldClearance(input.robot, baseline.samples);
  let best: Evaluation = {
    path: authored,
    result: baseline,
    maxDeviationM: 0,
    minimumClearanceM: baselineClearanceM,
  };
  const materiallyImproved = () => best.path !== authored
    && baseline.totalTimeS - best.result.totalTimeS >= Math.max(MIN_GAIN_S, baseline.totalTimeS * MIN_GAIN_FRACTION);
  const statistics = (): CorridorSearchStatistics => ({
    solveTimeMs: performance.now() - startedAt,
    evaluations,
    validatedCandidates,
    rejectedCandidates,
    rejectionReasons: [...rejectionReasons].map(([reason, count]) => ({ reason, count })),
  });
  const snapshot = (): PlannerResult => {
    const gainS = baseline.totalTimeS - best.result.totalTimeS;
    const improved = materiallyImproved();
    const retained = improved ? best.result : baseline;
    return {
      ...retained,
      ...(improved ? { optimizedPath: clone(best.path) } : {}),
      optimization: corridorDiagnostics(retained, diagnosticsOptions, {
        status: improved ? "feasible" : "equivalent",
        termination,
        ...statistics(),
        totalTimeS: retained.totalTimeS,
        baselineTimeS: baseline.totalTimeS,
        gainS: improved ? gainS : 0,
        fallback: false,
        fallbackReason: improved ? undefined : `No material improvement was found inside the ${corridorM.toFixed(2)} m corridor.`,
        maxDeviationM: improved ? best.maxDeviationM : 0,
        minimumClearanceM: improved ? best.minimumClearanceM : baselineClearanceM,
      }),
    };
  };
  const reject = (reason: string): null => {
    rejectedCandidates += 1;
    // Bound payload size even when each rejection has a different error.
    const key = rejectionReasons.has(reason) || rejectionReasons.size < 7 ? reason : "Other validation failures";
    rejectionReasons.set(key, (rejectionReasons.get(key) ?? 0) + 1);
    return null;
  };
  // Consumers project each incumbent into a full preview, so rejected or
  // non-material candidates do not republish the unchanged trajectory.
  let publishedPath: PathDoc | undefined;
  const publishIncumbent = () => {
    const path = materiallyImproved() ? best.path : authored;
    if (path === publishedPath) return false;
    publishedPath = path;
    requested.onProgress?.(snapshot());
    return true;
  };
  publishIncumbent();
  const evaluate = (path: PathDoc): Evaluation | null => {
    if (!canEvaluate()) return null;
    const evaluationStartedAt = performance.now();
    evaluations += 1;
    try {
      const route = PM.sample(path.waypoints, Math.max(128, samplesPerSegment * 2)).pts as GeometryPoint[];
      const maxDeviationM = routeDeviation(reference, route);
      if (!Number.isFinite(maxDeviationM) || maxDeviationM > corridorM + EPSILON) return reject("Outside the authored corridor");
      // Candidate generation already performs dense physical validation.
      const result = getPlanner("optimizedTrajectory").generate({ ...input, path });
      if (result.optimization?.fallback || result.diagnostics.some((issue) => issue.severity === "error")) {
        return reject((result.optimization?.fallbackReason
          ?? result.diagnostics.find((issue) => issue.severity === "error")?.message
          ?? "Candidate generation failed").slice(0, 240));
      }
      const validation = validateOptimizedTrajectory(
        physicalPlannerInput({ ...input, path }),
        fixedPathSamples(result),
        { angularKinematics: "sample" },
      );
      if (validation.violations.length > 0) return reject(validation.violations[0].message.slice(0, 240));
      const topology = observeRobotFieldPortalSequence(input.robot, result.samples);
      if (!topology.valid
        || topology.visits.length !== baselineTopology.visits.length
        || topology.visits.some((visit, index) => visit.id !== baselineTopology.visits[index].id)) return reject("Changed the authored portal sequence");
      if (!passesGates(result.samples, requested.gates ?? [])) return reject("Missed a required gate");
      if (!sweptFootprintInsideCorridor(input.robot, result.samples, reference, corridorM)) return reject("Robot footprint leaves the corridor");
      const clearanceM = minimumRobotFieldClearance(input.robot, result.samples);
      if (clearanceM < minimumClearanceM - EPSILON) return reject("Insufficient field clearance");
      validatedCandidates += 1;
      const candidate = { path, result, maxDeviationM, minimumClearanceM: clearanceM };
      if (result.totalTimeS < best.result.totalTimeS - EPSILON) best = candidate;
      return candidate;
    } catch (error) {
      return reject((error instanceof Error ? error.message : "Candidate evaluation failed").slice(0, 240));
    } finally {
      longestEvaluationMs = Math.max(longestEvaluationMs, performance.now() - evaluationStartedAt);
      if (!publishIncumbent()) requested.onStatistics?.(statistics());
    }
  };

  const patterns = [
    (index: number) => index % 2 ? 1.18 : 0.82,
    (_index: number) => 0.82,
    (_index: number) => 1.18,
    (index: number) => index % 2 ? 0.82 : 1.18,
  ];
  for (let patternIndex = 0; patternIndex < patterns.length && canEvaluate(); patternIndex += 1) {
    const path = clone(authored);
    handles.forEach((handle, index) => {
      const waypoint = authored.waypoints[handle.waypointIndex];
      const control = waypoint[handle.key]!;
      const originalM = distance(waypoint, control);
      const requestedM = originalM * patterns[patternIndex](index);
      const corridorLimitedM = Math.max(originalM - corridorM, Math.min(originalM + corridorM, requestedM));
      setHandleLength(path, handle, Math.max(0.05, Math.min(handle.chordM * 1.5, corridorLimitedM)));
    });
    evaluate(path);
  }

  let local = best;
  for (let pass = 0; pass < 3 && canEvaluate(); pass += 1) {
    let improved = false;
    for (const handle of handles) {
      const waypoint = local.path.waypoints[handle.waypointIndex];
      const control = waypoint[handle.key]!;
      const currentM = distance(waypoint, control);
      const relativeStep = Math.max(0.015, Math.min(0.4, corridorM / Math.max(0.05, currentM)));
      let handleBest = local;
      for (const factor of [1 - relativeStep, 1 + relativeStep]) {
        if (!canEvaluate()) break;
        const path = clone(local.path);
        setHandleLength(path, handle, Math.max(0.05, Math.min(handle.chordM * 1.5, currentM * factor)));
        const candidate = evaluate(path);
        if (candidate && candidate.result.totalTimeS < handleBest.result.totalTimeS - EPSILON) handleBest = candidate;
      }
      if (handleBest !== local) { local = handleBest; improved = true; }
    }
    if (!improved) break;
  }

  termination ??= evaluations >= maximumEvaluations ? "work-budget" : "completed";
  return snapshot();
}
