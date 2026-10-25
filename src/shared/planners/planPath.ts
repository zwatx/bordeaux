import { sample as sampleGeometry } from "../math/geometry";
import { wrapRadians } from "../math/angles";
import type { PlannerInput, PlannerResult, TrajectorySample, ValidationIssue } from "../types";
import { canonicalPlanningInput, getPlanner } from "./index";
import { DEFAULT_SAMPLES_PER_SEGMENT, MAX_TRAJECTORY_SAMPLES } from "./limits";
import { buildReachabilityInput, insertOptimizationBoundaries } from "./optimizationConstraints";
import { remapTiming, remapWaypointIndices } from "./optimizedTrajectory";
import { profiledSplineOptimizationSeed } from "./profiledSpline";
import { solveReachabilityProfile, type ReachabilityViolation } from "./reachability";
import { applyRotationPriority } from "./rotationPriority";
import { applyStationaryActions, nextMovingSampleIndices } from "./stationaryActions";
import { orderedWaypointSampleIndices } from "./waypointSamples";
import {
  validateOptimizedTrajectory,
  type TrajectoryConstraintViolation,
  type TrajectoryViolationKind,
} from "./trajectoryValidation";

/**
 * `ok`: `trajectory` is the strict, exportable planner result.
 * `degraded`: no strict result, but no constraint violation is known (an
 * internal planner failure or fallback timing); `bestEffort` is display-only.
 * `infeasible`: the path breaks at least one limit, or nothing could be timed.
 * Only `ok` may be exported or pushed.
 */
export type PlanStatus = "ok" | "degraded" | "infeasible";

export type PlanIssueCode =
  | "invalid-input"
  | "planner-error"
  | "planner-fallback"
  | "unreachable-acceleration"
  | "unreachable-deceleration"
  | "unreachable-speed"
  | "start-velocity"
  | "goal-velocity"
  | "speed-step"
  | "stopped-interval"
  | TrajectoryViolationKind
  | "turn-in-place"
  | "jiggle"
  | "heading"
  | "look-at"
  | "jerk"
  | "planner";

export interface PlanIssue {
  code: PlanIssueCode;
  severity: "error" | "warning";
  /** Path fraction range; [0, 1] when the problem is not localized. */
  f0: number;
  f1: number;
  segment?: number;
  waypoint?: number;
  constraint?: string;
  measured?: number;
  limit?: number;
  unit?: string;
  /** A short fact for the field label. */
  message: string;
  /** Original planner text, for diagnostics only. */
  detail?: string;
}

export interface PlanBestEffort {
  samples: TrajectorySample[];
  totalTimeS: number;
}

export interface PlanPathResult {
  status: PlanStatus;
  /** Strict planner result; non-null only when status is `ok`. */
  trajectory: PlannerResult | null;
  /** Drawable, monotonic timing for display and playback only; never export it. */
  bestEffort: PlanBestEffort | null;
  issues: PlanIssue[];
}

export interface PlanPathOptions {
  samplesPerSegment?: number;
}

const DEG = 180 / Math.PI;
const MAX_BEST_EFFORT_TIME_S = 3600;
// Legacy path-state unwrapping subtracts full turns in a loop. Bound authored
// angles before that code runs, including otherwise finite extreme inputs.
const MAX_AUTHORED_ANGLE_DEG = 360_000;
const ACCELERATION_KINDS = new Set<TrajectoryViolationKind>([
  "linear-acceleration",
  "linear-deceleration",
  "centripetal-acceleration",
  "angular-acceleration",
  "drivetrain-acceleration",
  "electrical-power",
]);
const ANGULAR_CODES = new Set<PlanIssueCode>(["angular-velocity", "angular-acceleration"]);
const NON_CONSTRAINT_CODES = new Set<PlanIssueCode>(["planner-error", "planner-fallback"]);
const REACHABILITY_CODES = new Set<PlanIssueCode>([
  "unreachable-acceleration",
  "unreachable-deceleration",
  "unreachable-speed",
  "start-velocity",
  "goal-velocity",
  "speed-step",
  "stopped-interval",
]);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function format(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const magnitude = Math.abs(value);
  if (magnitude >= 100) return value.toFixed(0);
  if (magnitude >= 1) return value.toFixed(1);
  // Significant digits retain tiny positive limits without long decimal tails.
  return String(Number(value.toPrecision(2)));
}

/** Increase precision only when rounding would hide a reported difference. */
function formatPair(measured: number, limit: number): [string, string] {
  const pair: [string, string] = [format(measured), format(limit)];
  if (!Number.isFinite(measured) || !Number.isFinite(limit) || measured === limit
    || Number(pair[0]) !== Number(pair[1])) return pair;
  for (let digits = 2; digits <= 17; digits += 1) {
    const precise: [string, string] = [
      String(Number(measured.toPrecision(digits))),
      String(Number(limit.toPrecision(digits))),
    ];
    if (Number(precise[0]) !== Number(precise[1])) return precise;
  }
  return [String(measured), String(limit)];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1;
}

function wholePath(code: PlanIssueCode, message: string, detail?: string, severity: PlanIssue["severity"] = "error"): PlanIssue {
  return { code, severity, f0: 0, f1: 1, message, ...(detail ? { detail } : {}) };
}

function invalidInputIssue(input: PlannerInput, samplesPerSegment: number): { issue: PlanIssue; geometryUsable: boolean } | null {
  const fail = (message: string, geometryUsable: boolean, extra: Partial<PlanIssue> = {}) => ({
    issue: { ...wholePath("invalid-input", message), ...extra },
    geometryUsable,
  });
  if (!input || typeof input !== "object" || !input.path || typeof input.path !== "object") return fail("Path is missing", false);
  const { path, robot } = input;
  if (!Array.isArray(path.waypoints) || path.waypoints.length < 2) return fail("Needs at least two waypoints", false);
  // Apply the resource ceiling before any geometry-usable early return.
  if (path.waypoints.length - 1 > Math.floor((MAX_TRAJECTORY_SAMPLES - 1) / samplesPerSegment)) {
    return fail("Path has too many segments", false);
  }
  let invalidHeading: number | undefined;
  for (let index = 0; index < path.waypoints.length; index += 1) {
    const waypoint = path.waypoints[index];
    if (!waypoint || !isFiniteNumber(waypoint.x) || !isFiniteNumber(waypoint.y)) {
      return fail("Waypoint position is not a number", false, { waypoint: index });
    }
    for (const handle of [waypoint.prevC, waypoint.nextC]) {
      if (!handle || !isFiniteNumber(handle.x) || !isFiniteNumber(handle.y)) {
        return fail("Waypoint handle is not a number", false, { waypoint: index });
      }
    }
    if (!isFiniteNumber(waypoint.theta) && invalidHeading === undefined) invalidHeading = index;
  }
  const excessiveHeading = path.waypoints.findIndex((waypoint) => Math.abs(waypoint.theta) > MAX_AUTHORED_ANGLE_DEG);
  if (excessiveHeading >= 0) return fail("Waypoint heading is too large", true, { waypoint: excessiveHeading });
  if (invalidHeading !== undefined) return fail("Waypoint heading is not a number", true, { waypoint: invalidHeading });
  if (path.targets !== undefined) {
    if (!Array.isArray(path.targets)) return fail("Heading targets are invalid", true, { constraint: "targets" });
    for (const target of path.targets) {
      if (!target || !isFiniteNumber(target.deg) || Math.abs(target.deg) > MAX_AUTHORED_ANGLE_DEG) {
        return fail("Target heading is invalid or too large", true, { constraint: "targets" });
      }
    }
  }
  if (!robot || typeof robot !== "object") return fail("Robot is missing", true);
  for (let index = 0; index < path.waypoints.length; index += 1) {
    const waypoint = path.waypoints[index];
    if (waypoint.wait !== undefined && (!isFiniteNumber(waypoint.wait) || waypoint.wait < 0)) {
      return fail("Wait must be a nonnegative number", true, { waypoint: index, constraint: "wait" });
    }
    if (waypoint.turnInPlace !== undefined
      && (!waypoint.turnInPlace || !isFiniteNumber(waypoint.turnInPlace.headingDeg))) {
      return fail("Turn heading is not a number", true, { waypoint: index, constraint: "turnInPlace" });
    }
    if (waypoint.turnInPlace && Math.abs(waypoint.turnInPlace.headingDeg) > MAX_AUTHORED_ANGLE_DEG) {
      return fail("Turn heading is too large", true, { waypoint: index, constraint: "turnInPlace" });
    }
    if (waypoint.jiggle !== undefined) {
      const jiggle = waypoint.jiggle;
      if (!jiggle || !isFiniteNumber(jiggle.distanceM) || jiggle.distanceM < 0.03 || jiggle.distanceM > 1.5
        || !Number.isInteger(jiggle.strokes) || jiggle.strokes < 2 || jiggle.strokes > 12
        || !isFiniteNumber(jiggle.startDeg) || !isFiniteNumber(jiggle.stepDeg)
        || Math.abs(jiggle.startDeg) > MAX_AUTHORED_ANGLE_DEG || Math.abs(jiggle.stepDeg) > MAX_AUTHORED_ANGLE_DEG
        || !isFiniteNumber(jiggle.strokeTimeS) || jiggle.strokeTimeS < 0.08 || jiggle.strokeTimeS > 5) {
        return fail("Jiggle settings are invalid", true, { waypoint: index, constraint: "jiggle" });
      }
    }
  }
  if (!Array.isArray(path.ranges)) return fail("Speed zones are missing", true);
  for (const range of path.ranges) {
    if (!range || typeof range !== "object") return fail("Speed zone is invalid", true);
    for (const name of ["maxVel", "maxAccel", "maxDecel", "maxAngVel", "maxAngAccel"] as const) {
      const value = range[name];
      if (value !== undefined && (!isFiniteNumber(value) || value <= 0)) {
        return fail("Zone limit must be positive", true, { constraint: name });
      }
    }
    for (const name of ["f0", "f1", "d0", "d1", "w0", "w1", "t0", "t1"] as const) {
      const value = range[name];
      if (value !== undefined && !isFiniteNumber(value)) {
        return fail("Zone position is not a number", true, { constraint: name });
      }
    }
  }
  const constraints = path.constraints;
  if (!constraints || typeof constraints !== "object") return fail("Path limits are missing", true);
  for (const name of ["maxVel", "maxAccel", "maxDecel", "maxAngVel", "maxAngAccel"] as const) {
    if (!isFiniteNumber(constraints[name]) || constraints[name] <= 0) {
      return fail("Limit must be a positive number", true, { constraint: name });
    }
  }
  for (const name of ["maxAngDecel", "maxCentripetalAccel"] as const) {
    const value = constraints[name];
    if (value !== undefined && (!isFiniteNumber(value) || value <= 0)) {
      return fail("Limit must be a positive number", true, { constraint: name });
    }
  }
  for (const name of ["maxJerk", "maxAngJerk"] as const) {
    const value = constraints[name];
    if (value !== undefined && (!isFiniteNumber(value) || value < 0)) {
      return fail("Limit must not be negative", true, { constraint: name });
    }
  }
  if (!isFiniteNumber(robot.maxSpeed) || robot.maxSpeed <= 0) {
    return fail("Robot top speed must be positive", true, { constraint: "maxSpeed" });
  }
  for (const name of ["startVel", "goalVel"] as const) {
    const value = path[name];
    if (value !== undefined && (!isFiniteNumber(value) || value < 0)) {
      return fail(name === "startVel" ? "Start speed is invalid" : "End speed is invalid", true, { constraint: name });
    }
  }
  return null;
}

function usableTiming(samples: readonly TrajectorySample[] | undefined): samples is TrajectorySample[] {
  if (!samples || samples.length < 2) return false;
  let previous = Number.NEGATIVE_INFINITY;
  for (const sample of samples) {
    if (![sample.t, sample.s, sample.f, sample.x, sample.y, sample.headingRad, sample.velocityMps].every(Number.isFinite)) {
      return false;
    }
    if (sample.t < previous - 1e-9) return false;
    previous = sample.t;
  }
  return previous <= MAX_BEST_EFFORT_TIME_S;
}

function bestEffortFrom(samples: TrajectorySample[]): PlanBestEffort {
  return { samples, totalTimeS: samples.at(-1)!.t };
}

/** Last resort: authored geometry at a nominal 1 m/s, so the path stays drawable. */
function geometryOnlyTiming(input: PlannerInput, samplesPerSegment: number): PlanBestEffort | null {
  if (input.path.waypoints.length - 1 > Math.floor((MAX_TRAJECTORY_SAMPLES - 1) / samplesPerSegment)) return null;
  const geometry = sampleGeometry(input.path.waypoints, samplesPerSegment);
  const length = geometry.length;
  const samples: TrajectorySample[] = geometry.pts.map((point, index) => ({
    i: index,
    t: point.s,
    s: point.s,
    f: length > 1e-9 ? point.s / length : 0,
    x: point.x,
    y: point.y,
    headingRad: point.heading,
    velocityMps: 1,
    accelerationMps2: 0,
    angularVelocityRadps: 0,
    curvatureInvM: point.curv,
  }));
  return usableTiming(samples) ? bestEffortFrom(samples) : null;
}

function isExportable(result: PlannerResult): boolean {
  let previousTime = Number.NEGATIVE_INFINITY;
  const monotonic = result.samples.every((sample) => {
    const valid = sample.t >= previousTime && sample.t >= 0;
    previousTime = sample.t;
    return valid;
  });
  return monotonic && result.samples.length >= 2
    && !result.diagnostics.some((issue) => issue.severity === "error")
    && !result.optimization?.fallback
    && Number.isFinite(result.totalTimeS)
    && result.samples.every((sample) => [
      sample.t, sample.s, sample.f, sample.x, sample.y, sample.headingRad,
      sample.velocityMps, sample.accelerationMps2, sample.angularVelocityRadps, sample.curvatureInvM,
    ].every(Number.isFinite));
}

/** Locates path fractions on authored waypoints and segments. */
class PathLocator {
  constructor(private readonly waypointFractions: readonly number[]) {}

  waypointFraction(index: number): number {
    return this.waypointFractions[Math.max(0, Math.min(this.waypointFractions.length - 1, index))] ?? 0;
  }

  segmentAt(fraction: number): number | undefined {
    const segmentCount = this.waypointFractions.length - 1;
    if (segmentCount < 1) return undefined;
    let segment = 0;
    for (let index = 0; index < segmentCount; index += 1) {
      if (fraction >= this.waypointFractions[index] - 1e-9) segment = index;
    }
    return segment;
  }
}

function waypointFractionsOf(result: PlannerResult | null | undefined, waypointCount: number): number[] | null {
  const indices = result?.waypointSampleIndices;
  if (!result || !indices || indices.length !== waypointCount) return null;
  const fractions = indices.map((index) => result.samples[index]?.f);
  return fractions.every(isFiniteNumber) ? fractions as number[] : null;
}

function locatorFor(waypointCount: number, ...results: (PlannerResult | null | undefined)[]): PathLocator {
  for (const result of results) {
    const fractions = waypointFractionsOf(result, waypointCount);
    if (fractions) return new PathLocator(fractions);
  }
  // Without a sampled result, approximate waypoints as evenly spaced.
  const last = Math.max(1, waypointCount - 1);
  return new PathLocator(Array.from({ length: waypointCount }, (_value, index) => index / last));
}

const SOURCE_LABELS: { test: (label: string) => boolean; accel: string; decel: string }[] = [
  { test: (label) => label === "linear-acceleration", accel: "Accel", decel: "Braking" },
  { test: (label) => label === "linear-deceleration", accel: "Accel", decel: "Braking" },
  { test: (label) => label === "motor-acceleration" || label.endsWith("motor-force"), accel: "Motor accel", decel: "Motor braking" },
  { test: (label) => label.endsWith("traction-force"), accel: "Wheel grip accel", decel: "Wheel grip braking" },
  { test: (label) => label === "chassis-traction", accel: "Traction accel", decel: "Traction braking" },
  { test: (label) => label === "angular-acceleration", accel: "Turn-limited accel", decel: "Turn-limited braking" },
];

function reachabilityIssue(
  violation: ReachabilityViolation,
  samples: readonly TrajectorySample[],
  locator: PathLocator,
  waypointCount: number,
): PlanIssue {
  const f0 = samples[violation.startInterval]?.f ?? 0;
  const f1 = samples[violation.endInterval + 1]?.f ?? 1;
  const worst = samples[violation.worstInterval]?.f ?? f0;
  const located = { severity: "error" as const, f0, f1, segment: locator.segmentAt(worst) };
  const values = { measured: violation.measured, limit: violation.limit };
  const [measured, limit] = formatPair(violation.measured, violation.limit);
  switch (violation.kind) {
    case "acceleration":
    case "deceleration": {
      const constraint = violation.constraint
        ?? (violation.kind === "acceleration" ? "linear-acceleration" : "linear-deceleration");
      const source = SOURCE_LABELS.find((entry) => entry.test(constraint));
      const label = violation.kind === "acceleration" ? source?.accel ?? "Accel" : source?.decel ?? "Braking";
      return {
        code: violation.kind === "acceleration" ? "unreachable-acceleration" : "unreachable-deceleration",
        ...located, ...values, constraint, unit: "m/s²",
        message: `${label} ${measured} m/s² over ${limit} m/s²`,
      };
    }
    case "speed":
      return {
        code: "unreachable-speed", ...located, ...values, constraint: violation.constraint, unit: "m/s",
        message: `Speed ${measured} m/s over ${limit} m/s`,
      };
    case "start-velocity":
      return {
        code: "start-velocity", ...located, segment: 0, waypoint: 0, ...values, constraint: "startVel", unit: "m/s",
        message: `Start speed ${measured} m/s over ${limit} m/s`,
      };
    case "goal-velocity":
      return {
        code: "goal-velocity", ...located, segment: Math.max(0, waypointCount - 2), waypoint: waypointCount - 1,
        ...values, constraint: "goalVel", unit: "m/s",
        message: `End speed ${measured} m/s over ${limit} m/s`,
      };
    case "speed-step":
      return {
        code: "speed-step", ...located, measured: violation.measured, unit: "m/s",
        message: `Speed jumps ${format(violation.measured)} m/s instantly`,
      };
    case "stopped-interval":
      return { code: "stopped-interval", ...located, message: "No motion between stops" };
  }
}

const VALIDATION_LABELS: Record<TrajectoryViolationKind, string> = {
  "boundary-velocity": "Boundary speed",
  "linear-velocity": "Speed",
  "linear-acceleration": "Accel",
  "linear-deceleration": "Braking",
  "centripetal-acceleration": "Cornering",
  "angular-velocity": "Turn rate",
  "angular-acceleration": "Turn accel",
  "drivetrain-velocity": "Module speed",
  "drivetrain-acceleration": "Drive accel",
  "electrical-power": "Electrical demand",
};

function validationConstraint(violation: TrajectoryConstraintViolation): string {
  const label = violation.message.split(" is ")[0] ?? "";
  return /module|wheel/.test(label) ? label.toLowerCase().replace(/\s+/g, "-") : violation.kind;
}

function validationValue(violation: TrajectoryConstraintViolation): { measured: number; limit: number; unit: string; label: string } {
  if (violation.kind === 'electrical-power') return { measured: violation.measured * 100, limit: 100, unit: '%', label: 'Electrical demand' };
  const constraint = validationConstraint(violation);
  if (violation.kind === "angular-velocity") {
    return { measured: violation.measured * DEG, limit: violation.limit * DEG, unit: "deg/s", label: "Turn rate" };
  }
  if (violation.kind === "angular-acceleration") {
    return { measured: violation.measured * DEG, limit: violation.limit * DEG, unit: "deg/s²", label: "Turn accel" };
  }
  if (violation.kind === "drivetrain-acceleration" && constraint.endsWith("force")) {
    return {
      measured: violation.measured,
      limit: violation.limit,
      unit: "N",
      label: constraint.endsWith("motor-force") ? "Motor force" : "Wheel grip",
    };
  }
  const unit = violation.kind.endsWith("velocity") ? "m/s" : "m/s²";
  return { measured: violation.measured, limit: violation.limit, unit, label: VALIDATION_LABELS[violation.kind] };
}

function displayUnit(unit: string): string {
  return unit === "deg/s" ? "°/s" : unit === "deg/s²" ? "°/s²" : unit;
}

/** Merges per-sample violations of one kind into contiguous, localized issues. */
function validationIssues(
  violations: readonly TrajectoryConstraintViolation[],
  samples: readonly TrajectorySample[],
  locator: PathLocator,
  waypointCount: number,
): PlanIssue[] {
  const byKind = new Map<TrajectoryViolationKind, TrajectoryConstraintViolation[]>();
  for (const violation of violations) {
    if (!(violation.measured > violation.limit) || !samples[violation.sampleIndex]) continue;
    byKind.set(violation.kind, [...(byKind.get(violation.kind) ?? []), violation]);
  }
  const issues: PlanIssue[] = [];
  for (const [kind, entries] of byKind) {
    entries.sort((left, right) => left.sampleIndex - right.sampleIndex);
    let run: TrajectoryConstraintViolation[] = [];
    const flush = () => {
      if (run.length === 0) return;
      const worst = run.reduce((best, entry) => (
        entry.measured / Math.max(1e-9, entry.limit) > best.measured / Math.max(1e-9, best.limit) ? entry : best
      ), run[0]);
      const value = validationValue(worst);
      const [measured, limit] = formatPair(value.measured, value.limit);
      const first = run[0].sampleIndex;
      const last = run.at(-1)!.sampleIndex;
      const boundary = kind === "boundary-velocity";
      const f0 = samples[boundary ? first : Math.max(0, first - 1)].f;
      const f1 = samples[last].f;
      const atStart = boundary && first === 0;
      issues.push({
        code: kind,
        severity: "error",
        f0,
        f1,
        segment: locator.segmentAt(samples[worst.sampleIndex].f),
        ...(boundary ? { waypoint: atStart ? 0 : waypointCount - 1 } : {}),
        constraint: validationConstraint(worst),
        measured: value.measured,
        limit: value.limit,
        unit: value.unit,
        message: boundary
          ? `${atStart ? "Start" : "End"} speed ${measured} m/s, expected ${limit} m/s`
          : `${value.label} ${measured} ${displayUnit(value.unit)} over ${limit} ${displayUnit(value.unit)}`,
      });
      run = [];
    };
    for (const entry of entries) {
      if (run.length > 0 && entry.sampleIndex > run.at(-1)!.sampleIndex + 2) flush();
      run.push(entry);
    }
    flush();
  }
  return issues;
}

function overlaps(issue: PlanIssue, others: readonly PlanIssue[], pad: number): boolean {
  return others.some((other) => issue.f0 <= other.f1 + pad && issue.f1 >= other.f0 - pad);
}

function waypointIndexOf(diagnosticPath: string): number | undefined {
  const match = /\.waypoints\[(\d+)\]/.exec(diagnosticPath);
  return match ? Number(match[1]) : undefined;
}

const HEADING_MESSAGES: [RegExp, string][] = [
  [/requires a swerve drivetrain/, "Tank drive cannot hold heading"],
  [/could not meet the authored heading/, "Heading target missed"],
  [/could not reacquire the authored heading/, "Heading not reacquired"],
  [/angular/i, "Heading exceeds angular limits"],
];

/**
 * Converts planner diagnostics that validation and the soft solve cannot
 * localize. Families already covered by a localized issue are skipped.
 */
function diagnosticIssues(
  diagnostics: readonly ValidationIssue[],
  input: PlannerInput,
  locator: PathLocator,
  localized: readonly PlanIssue[],
  lookAtFraction: (segment: number) => number | null,
): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const waypointCount = input.path.waypoints.length;
  const add = (issue: PlanIssue) => {
    // One issue per family and place; a refused jerk limit also explains its overshoot.
    if (!issues.some((existing) => existing.code === issue.code && existing.waypoint === issue.waypoint
      && (existing.message === issue.message || (issue.code === "jerk" && existing.constraint === issue.constraint)))) {
      issues.push(issue);
    }
  };
  const hasLocalized = (test: (issue: PlanIssue) => boolean) => localized.some(test);
  // Planner stages repeat text; errors at distinct authored locations must survive.
  const seen = new Set<string>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity !== "error") continue;
    const text = diagnostic.message;
    const waypoint = waypointIndexOf(diagnostic.path);
    const identity = `${waypoint ?? "path"}:${text}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (/Tracked field point/.test(text)) {
      input.path.waypoints.slice(0, -1).forEach((waypointDoc, segment) => {
        if (waypointDoc.segmentHeadingMode !== "lookAt") return;
        const f = lookAtFraction(segment);
        if (f === null) return;
        add({ code: "look-at", severity: "error", f0: f, f1: f, segment, waypoint: segment, message: "Look-at point is on the path", detail: text });
      });
      if (!issues.some((issue) => issue.code === "look-at")) add(wholePath("look-at", "Look-at point is on the path", text));
      continue;
    }
    if (/jerk/i.test(text) || /maxJerk|maxAngJerk/.test(diagnostic.path)) {
      add({
        ...wholePath("jerk", /does not yet support/.test(text) ? "Jerk limit not supported" : "Jerk limit exceeded", text),
        constraint: /angular jerk|maxAngJerk/i.test(`${text} ${diagnostic.path}`) ? "maxAngJerk" : "maxJerk",
      });
      continue;
    }
    if (waypoint !== undefined && /\.(turnInPlace|jiggle)$/.test(diagnostic.path)) {
      const jiggle = diagnostic.path.endsWith(".jiggle");
      const f = locator.waypointFraction(waypoint);
      add({
        code: jiggle ? "jiggle" : "turn-in-place",
        severity: "error",
        f0: f,
        f1: f,
        segment: Math.min(waypoint, Math.max(0, waypointCount - 2)),
        waypoint,
        message: jiggle
          ? /swerve/.test(text) ? "Jiggle needs a swerve drivetrain" : "Jiggle stroke leaves field or repeats"
          : "Turn heading must match next segment",
        detail: text,
      });
      continue;
    }
    // Other legacy profile hints describe the trapezoid seed, not this timing.
    if (/\.diagnostics\[\d+\]$/.test(diagnostic.path)) continue;
    if (/^Optimized trajectory is (infeasible|invalid-input)/.test(text)) {
      if (!hasLocalized((issue) => REACHABILITY_CODES.has(issue.code))) {
        add(wholePath("planner", "No feasible speed profile", text));
      }
      continue;
    }
    if (/^Coupled trajectory validation found/.test(text) || /^Dense validation found/.test(text)) {
      if (!hasLocalized((issue) => issue.code !== "planner")) add(wholePath("planner", "Limits exceeded", text));
      continue;
    }
    const heading = HEADING_MESSAGES.find(([pattern]) => pattern.test(text));
    if (heading) {
      const angularLocalized = hasLocalized((issue) => (
        ANGULAR_CODES.has(issue.code) || issue.constraint === "angular-acceleration"
      ));
      if (heading[1] !== "Heading exceeds angular limits" || !angularLocalized) {
        add(wholePath("heading", heading[1], text));
      }
      continue;
    }
    add(wholePath("planner", "Planning failed", text));
  }
  return issues;
}

interface BestEffortAnalysis {
  bestEffort: PlanBestEffort | null;
  issues: PlanIssue[];
}

/** The strict stationary pass stops at its first mismatch; editing needs every location. */
function stationaryHeadingIssues(input: PlannerInput, moving: PlannerResult): ValidationIssue[] {
  const { path } = input;
  if (!path.waypoints.some((waypoint) => waypoint.turnInPlace) || moving.samples.length === 0) return [];
  const boundaries = moving.waypointSampleIndices
    ?? orderedWaypointSampleIndices(path.waypoints, moving.samples, { fallback: "stationary" });
  const nextMoving = nextMovingSampleIndices(moving.samples);
  const diagnostics: ValidationIssue[] = [];
  path.waypoints.slice(0, -1).forEach((waypoint, index) => {
    if (!waypoint.turnInPlace) return;
    const next = nextMoving[boundaries[index]];
    const outgoing = moving.samples[next]?.headingRad;
    const target = waypoint.turnInPlace.headingDeg / DEG + (path.driveBackward ? Math.PI : 0);
    if (outgoing === undefined || Math.abs(wrapRadians(outgoing - target)) > 2 / DEG) {
      diagnostics.push({
        severity: "error",
        path: `paths.${path.name}.waypoints[${index}].turnInPlace`,
        message: "Interior turn heading must match the outgoing segment heading",
      });
    }
  });
  return diagnostics;
}

/** Soft reachability, heading and stationary post-passes, then localization. */
function analyzeBestEffort(input: PlannerInput, strict: PlannerResult | null): BestEffortAnalysis {
  const waypointCount = input.path.waypoints.length;
  const { physicalInput, planningInput } = canonicalPlanningInput(input);
  const { path, robot } = physicalInput;
  const seed = profiledSplineOptimizationSeed(planningInput);
  const locator = locatorFor(waypointCount, seed, strict);
  const issues: PlanIssue[] = [];
  let moving: PlannerResult = seed;
  if (seed.samples.length >= 2) {
    const samples = insertOptimizationBoundaries(planningInput, seed.samples);
    const soft = solveReachabilityProfile(buildReachabilityInput(planningInput, samples), { soft: true });
    for (const violation of soft.violations ?? []) {
      issues.push(reachabilityIssue(violation, samples, locator, waypointCount));
    }
    const stopped = soft.violations?.some((violation) => violation.kind === "stopped-interval");
    if (soft.velocities.length === samples.length && !stopped) {
      const timed = remapTiming(samples, soft.velocities);
      let waypointSampleIndices: number[] | undefined;
      try {
        waypointSampleIndices = remapWaypointIndices(seed, samples);
      } catch {
        waypointSampleIndices = undefined;
      }
      moving = {
        ...seed,
        planner: "optimizedTrajectory",
        samples: timed,
        totalTimeS: timed.at(-1)?.t ?? seed.totalTimeS,
        waypointSampleIndices,
        diagnostics: [],
      };
    }
  }

  let rotated = moving;
  try {
    rotated = applyRotationPriority(path, moving, robot);
  } catch {
    rotated = moving;
  }
  try {
    const validation = validateOptimizedTrajectory(planningInput, rotated.samples, { angularKinematics: "sample" });
    const softRanges = issues.filter((issue) => issue.code.startsWith("unreachable-"));
    const pad = 1 / Math.max(1, rotated.samples.length - 1);
    for (const issue of validationIssues(validation.violations, rotated.samples, locator, waypointCount)) {
      // The soft solve already reports this maneuver with its binding limit.
      if (ACCELERATION_KINDS.has(issue.code as TrajectoryViolationKind) && overlaps(issue, softRanges, pad)) continue;
      issues.push(issue);
    }
  } catch {
    // Validation is advisory here; the strict diagnostics still apply below.
  }
  let final = rotated;
  try {
    final = applyStationaryActions(path, rotated, robot);
  } catch {
    final = rotated;
  }

  const lookAtFraction = (segment: number): number | null => {
    const target = path.waypoints[segment]?.segmentLookAt;
    const indices = seed.waypointSampleIndices;
    if (!target || !indices) return null;
    let nearest: { distance: number; f: number } | null = null;
    for (let index = indices[segment]; index <= indices[segment + 1] && index < seed.samples.length; index += 1) {
      const point = seed.samples[index];
      const distance = Math.hypot(point.x - target.x, point.y - target.y);
      if (!nearest || distance < nearest.distance) nearest = { distance, f: point.f };
    }
    return nearest && nearest.distance < 0.05 ? nearest.f : null;
  };
  const diagnostics = [
    ...rotated.diagnostics, ...final.diagnostics, ...(strict?.diagnostics ?? []),
    ...stationaryHeadingIssues(physicalInput, rotated),
  ];
  issues.push(...diagnosticIssues(diagnostics, input, locator, issues, lookAtFraction));

  const bestEffort = usableTiming(final.samples)
    ? bestEffortFrom(final.samples)
    : usableTiming(rotated.samples)
      ? bestEffortFrom(rotated.samples)
      : usableTiming(strict?.samples)
        ? bestEffortFrom(strict!.samples)
        : usableTiming(seed.samples) ? bestEffortFrom(seed.samples) : null;
  return { bestEffort, issues };
}

function sortIssues(issues: PlanIssue[]): PlanIssue[] {
  return issues.sort((left, right) => (
    left.f0 - right.f0
    || left.f1 - right.f1
    || (left.severity === right.severity ? 0 : left.severity === "error" ? -1 : 1)
  ));
}

function finish(
  trajectory: PlannerResult | null,
  bestEffort: PlanBestEffort | null,
  issues: PlanIssue[],
): PlanPathResult {
  const status: PlanStatus = trajectory
    ? "ok"
    : bestEffort && !issues.some((issue) => issue.severity === "error" && !NON_CONSTRAINT_CODES.has(issue.code))
      ? "degraded"
      : "infeasible";
  return { status, trajectory, bestEffort, issues: sortIssues(issues) };
}

function planPathUnchecked(input: PlannerInput, options: PlanPathOptions): PlanPathResult {
  const requested = isPositiveInteger(options.samplesPerSegment) ? options.samplesPerSegment : undefined;
  const inputDensity = input && typeof input === "object" ? input.samplesPerSegment : undefined;
  const samplesPerSegment = requested
    ?? (isPositiveInteger(inputDensity) ? inputDensity : DEFAULT_SAMPLES_PER_SEGMENT);
  const problem = invalidInputIssue(input, samplesPerSegment);
  if (problem) {
    let bestEffort: PlanBestEffort | null = null;
    if (problem.geometryUsable) {
      try {
        bestEffort = geometryOnlyTiming(input, samplesPerSegment);
      } catch {
        bestEffort = null;
      }
    }
    return finish(null, bestEffort, [problem.issue]);
  }

  // Keep the caller's input object when nothing changes, so `ok` results are
  // exactly what getPlanner returns for the same input.
  const plannerInput = samplesPerSegment === input.samplesPerSegment
    || (input.samplesPerSegment === undefined && requested === undefined)
    ? input
    : { ...input, samplesPerSegment };
  let strict: PlannerResult | null = null;
  let strictError: unknown;
  try {
    strict = getPlanner("profiledSpline").generate(plannerInput);
  } catch (error) {
    strictError = error;
  }
  if (strict && isExportable(strict)) {
    return finish(strict, bestEffortFrom(strict.samples), []);
  }

  const issues: PlanIssue[] = [];
  if (strictError !== undefined) issues.push(wholePath("planner-error", "Planner failed", messageOf(strictError)));
  if (strict?.optimization?.fallback && !strict.diagnostics.some((issue) => issue.severity === "error")) {
    issues.push(wholePath("planner-fallback", "Fallback timing, export blocked", strict.optimization.fallbackReason, "warning"));
  }
  let analysis: BestEffortAnalysis | null = null;
  try {
    analysis = analyzeBestEffort(plannerInput, strict);
  } catch (error) {
    issues.push(wholePath("planner-error", "Best-effort timing failed", messageOf(error)));
  }
  if (analysis) issues.push(...analysis.issues);
  if (!analysis && strict) {
    const locator = locatorFor(input.path.waypoints.length, strict);
    issues.push(...diagnosticIssues(strict.diagnostics, input, locator, issues, () => null));
  }
  // A refused result always says why, even when no stage named a cause.
  if (issues.length === 0) issues.push(wholePath("planner-error", "Planner result not exportable"));
  let bestEffort = analysis?.bestEffort ?? null;
  if (!bestEffort && usableTiming(strict?.samples)) bestEffort = bestEffortFrom(strict!.samples);
  if (!bestEffort) {
    try {
      bestEffort = geometryOnlyTiming(plannerInput, samplesPerSegment);
    } catch {
      bestEffort = null;
    }
  }
  return finish(null, bestEffort, issues);
}

/**
 * Plans a path without ever throwing. Returns the strict planner result when
 * it is exportable; otherwise a display-only best-effort timing (soft
 * reachability, falling back to the legacy trapezoid) plus localized issues.
 */
export function planPath(input: PlannerInput, options: PlanPathOptions = {}): PlanPathResult {
  try {
    return planPathUnchecked(input, options ?? {});
  } catch (error) {
    return {
      status: "infeasible",
      trajectory: null,
      bestEffort: null,
      issues: [wholePath("planner-error", "Planner failed", messageOf(error))],
    };
  }
}
