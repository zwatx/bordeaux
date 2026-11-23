import type {
  PlannerInput,
  PlannerOptimizationDiagnostics,
  PlannerResult,
  TrajectorySample,
  ValidationIssue,
} from "../types";
import { enforceAngularTiming } from "./angularConstraints";
import { indexIntervalPolicies, indexPointPolicies } from "./intervalPolicies";
import { effectiveRanges } from "./rotationPriority";
import { optimizeVelocities, remapTrajectoryTiming } from "./velocityOptimization";

const R = (value: number, places = 4) => Number(value.toFixed(places));
const EPSILON = 1e-9;

function linearLimits(input: PlannerInput) {
  const freeSpeed = Math.max(0.01, input.robot.maxSpeed || input.path.constraints.maxVel || 0.01);
  return {
    freeSpeed,
    velocity: Math.max(0.01, Math.min(freeSpeed, input.path.constraints.maxVel || freeSpeed)),
    acceleration: Math.max(0.01, input.path.constraints.maxAccel || 0.01),
    deceleration: Math.max(0.01, input.path.constraints.maxDecel ?? input.path.constraints.maxAccel ?? 0.01),
  };
}

function linearLimitProfile(
  input: PlannerInput,
  samples: readonly TrajectorySample[],
  waypointSampleIndices?: readonly number[],
) {
  const base = linearLimits(input);
  const ranges = effectiveRanges(input.path, samples, samples.at(-1)?.s ?? 0, waypointSampleIndices);
  const fractions = samples.map((sample) => sample.f);
  const pointIndex = indexPointPolicies(fractions, ranges);
  const intervalIndex = indexIntervalPolicies(fractions, ranges);
  const limitsAt = (index: typeof pointIndex, sampleIndex: number) => ({
    ...base,
    velocity: Math.min(base.velocity, index.maxVel[sampleIndex]),
    acceleration: Math.min(base.acceleration, index.maxAccel[sampleIndex]),
    deceleration: Math.min(base.deceleration, index.maxDecel[sampleIndex]),
  });
  return {
    points: samples.map((_, index) => limitsAt(pointIndex, index)),
    intervals: samples.map((_, index) => index === 0 ? limitsAt(pointIndex, 0) : limitsAt(intervalIndex, index)),
  };
}

function countConstraintViolations(
  input: PlannerInput,
  samples: readonly TrajectorySample[],
  waypointSampleIndices?: readonly number[],
): number {
  const profile = linearLimitProfile(input, samples, waypointSampleIndices);
  let violations = 0;
  samples.forEach((sample, index) => {
    if (index === 0) {
      const tolerance = Math.max(1e-4, profile.points[0].velocity * 1e-4);
      if (sample.velocityMps > profile.points[0].velocity + tolerance) violations += 1;
      return;
    }
    const previous = samples[index - 1];
    const interval = profile.intervals[index];
    const velocityTolerance = Math.max(1e-4, interval.velocity * 1e-4);
    if (Math.max(previous.velocityMps, sample.velocityMps) > interval.velocity + velocityTolerance) violations += 1;
    const distance = sample.s - previous.s;
    if (distance <= EPSILON) return;
    const acceleration = (sample.velocityMps ** 2 - previous.velocityMps ** 2) / (2 * distance);
    const limit = acceleration >= 0
      ? interval.acceleration * Math.max(0, Math.min(1, 1 - previous.velocityMps / interval.freeSpeed))
      : interval.deceleration;
    if (Math.abs(acceleration) > limit + Math.max(1e-3, limit * 1e-3)) violations += 1;
  });
  return violations;
}

function timeAtFraction(samples: readonly TrajectorySample[], fraction: number): number {
  if (samples.length === 0) return 0;
  const target = Math.max(0, Math.min(1, fraction));
  if (target <= samples[0].f) return samples[0].t;
  for (let index = 1; index < samples.length; index += 1) {
    const current = samples[index];
    if (current.f >= target) {
      const previous = samples[index - 1];
      const span = Math.max(EPSILON, current.f - previous.f);
      return previous.t + (current.t - previous.t) * ((target - previous.f) / span);
    }
  }
  return samples.at(-1)!.t;
}

export function optimizationDiagnostics(
  input: PlannerInput,
  samples: TrajectorySample[],
  solveTimeMs: number,
  fallbackReason?: string,
  waypointSampleIndices?: readonly number[],
): PlannerOptimizationDiagnostics {
  const maxVelocityMps = samples.reduce((max, sample) => Math.max(max, Math.abs(sample.velocityMps)), 0);
  const maxAccelerationMps2 = samples.reduce((max, sample) => Math.max(max, Math.abs(sample.accelerationMps2)), 0);
  return {
    plannerUsed: "optimizedTrajectory",
    solveTimeMs: R(solveTimeMs, 3),
    totalTimeS: R(samples.at(-1)?.t ?? 0, 4),
    maxVelocityMps: R(maxVelocityMps, 4),
    maxAccelerationMps2: R(maxAccelerationMps2, 4),
    constraintViolations: countConstraintViolations(input, samples, waypointSampleIndices),
    fallback: Boolean(fallbackReason),
    fallbackReason,
  };
}

/** Applies the maintained optimized timing pass to an already-profiled trajectory. */
function optimizePlannerMotionBase(input: PlannerInput, base: PlannerResult): PlannerResult {
  const limits = linearLimitProfile(input, base.samples, base.waypointSampleIndices);
  const velocities = optimizeVelocities(
    base.samples,
    limits,
    input.path.waypoints[0]?.stop ? 0 : input.path.startVel || 0,
    input.path.waypoints.at(-1)?.stop ? 0 : input.path.goalVel || 0,
    input.smoothingPasses ?? 2,
  );
  const samples = remapTrajectoryTiming(base.samples, velocities);
  const totalTimeS = R(samples.at(-1)?.t ?? base.totalTimeS, 4);
  return {
    planner: "optimizedTrajectory",
    totalTimeS,
    totalDistanceM: base.totalDistanceM,
    samples,
    waypointSampleIndices: base.waypointSampleIndices,
    markers: base.markers.map((marker) => ({ ...marker, timeS: R(timeAtFraction(samples, marker.fraction), 4) })),
    diagnostics: base.diagnostics,
  };
}

/** Applies optimized timing without computing export-only solver diagnostics. */
export function optimizePlannerMotion(input: PlannerInput, base: PlannerResult): PlannerResult {
  return enforceAngularTiming(input.path, optimizePlannerMotionBase(input, base));
}

export function optimizePlannerResult(input: PlannerInput, base: PlannerResult, startedAt: number): PlannerResult {
  const result = optimizePlannerMotionBase(input, base);
  const optimization = optimizationDiagnostics(
    input,
    result.samples,
    performance.now() - startedAt,
    undefined,
    result.waypointSampleIndices,
  );
  const constraintIssue: ValidationIssue[] = optimization.constraintViolations > 0 ? [{
    severity: "error",
    path: `paths.${input.path.name}.planner`,
    message: `Optimized trajectory has ${optimization.constraintViolations} final linear constraint violation${optimization.constraintViolations === 1 ? "" : "s"}.`,
  }] : [];

  return enforceAngularTiming(input.path, {
    ...result,
    diagnostics: [...base.diagnostics, ...constraintIssue],
    optimization,
  });
}
