import type { PlannerInput, PlannerOptimizationDiagnostics, PlannerResult } from "../types";
import { physicalPlannerInput } from "../robotLimits";
import { fixedPathSamples, getPlanner } from "./index";
import { DEFAULT_SAMPLES_PER_SEGMENT } from "./limits";
import { insertOptimizationBoundaries } from "./optimizationConstraints";
import { buildDenseValidationSamples } from "./optimizedTrajectory";
import { profiledSplineOptimizationSeed } from "./profiledSpline";
import { applyRotationPriority } from "./rotationPriority";
import { validateOptimizedTrajectory } from "./trajectoryValidation";

const EPSILON = 1e-4;

function referenceSample(samples: PlannerResult["samples"], fraction: number) {
  if (fraction <= samples[0].f) return samples[0];
  if (fraction >= samples.at(-1)!.f) return samples.at(-1)!;
  let low = 1;
  let high = samples.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (samples[middle].f >= fraction) high = middle;
    else low = middle + 1;
  }
  const before = samples[low - 1];
  const after = samples[low];
  const progress = (fraction - before.f) / Math.max(1e-9, after.f - before.f);
  const headingDelta = Math.atan2(
    Math.sin(after.headingRad - before.headingRad),
    Math.cos(after.headingRad - before.headingRad),
  );
  return {
    x: before.x + (after.x - before.x) * progress,
    y: before.y + (after.y - before.y) * progress,
    headingRad: before.headingRad + headingDelta * progress,
  };
}

function optimizerFailure(candidate: PlannerResult): string | null {
  if (candidate.samples.length < 2) return "The optimizer returned fewer than two trajectory samples.";
  const error = candidate.diagnostics.find((issue) => issue.severity === "error");
  if (error) return error.message;
  if (!candidate.optimization
    || !["optimal", "feasible", "equivalent"].includes(candidate.optimization.status ?? "")
    || candidate.optimization.constraintViolations !== 0) {
    return candidate.optimization?.fallbackReason ?? "The optimizer did not return a validated final trajectory.";
  }
  return null;
}

export function invariantFailure(input: PlannerInput, interactive: PlannerResult, candidate: PlannerResult): string | null {
  if (Math.abs(candidate.totalDistanceM - interactive.totalDistanceM) > 0.001) {
    return "The optimizer changed the fixed path distance.";
  }
  const samplesPerSegment = (input.samplesPerSegment ?? DEFAULT_SAMPLES_PER_SEGMENT)
    * (2 ** (candidate.optimization?.refinementPasses ?? 0));
  const physicalInput = physicalPlannerInput({ ...input, samplesPerSegment });
  const { path, robot } = physicalInput;
  const referenceSeed = profiledSplineOptimizationSeed(physicalInput);
  const fixedGeometryReference = {
    ...referenceSeed,
    samples: insertOptimizationBoundaries(physicalInput, referenceSeed.samples),
  };
  const movingCandidateSamples = fixedPathSamples(candidate).filter((sample) => (
    !candidate.stationaryActions?.some((action) => (
      sample.t > action.startTimeS + EPSILON && sample.t <= action.endTimeS + EPSILON
    ))
  ));
  const desiredTimedSamples = movingCandidateSamples.map((sample) => ({
    ...sample,
    headingRad: referenceSample(fixedGeometryReference.samples, sample.f).headingRad,
  }));
  for (let index = 0; index < desiredTimedSamples.length; index += 1) {
    if (index === 0) {
      desiredTimedSamples[index].angularVelocityRadps = 0;
      continue;
    }
    const before = desiredTimedSamples[index - 1];
    const sample = desiredTimedSamples[index];
    const dt = Math.max(1e-9, sample.t - before.t);
    const headingDelta = Math.atan2(
      Math.sin(sample.headingRad - before.headingRad),
      Math.cos(sample.headingRad - before.headingRad),
    );
    sample.angularVelocityRadps = headingDelta / dt;
  }
  const coupledHeadingReference = applyRotationPriority(path, {
    ...candidate,
    samples: desiredTimedSamples,
    totalTimeS: desiredTimedSamples.at(-1)?.t ?? candidate.totalTimeS,
    stationaryActions: undefined,
  }, robot);
  let maximumCheckedFraction = Number.NEGATIVE_INFINITY;
  for (const sample of candidate.samples) {
    if (![sample.t, sample.s, sample.f, sample.x, sample.y, sample.headingRad, sample.velocityMps].every(Number.isFinite)) {
      return "The optimizer returned a non-finite trajectory sample.";
    }
    const stationary = candidate.stationaryActions?.some((action) => (
      sample.t > action.startTimeS + EPSILON && sample.t <= action.endTimeS + EPSILON
    ));
    if (stationary || sample.f <= maximumCheckedFraction + EPSILON) continue;
    maximumCheckedFraction = sample.f;
    const authoredTurnBoundary = candidate.stationaryActions?.some((action) => (
      action.kind === "turn"
      && Math.abs(sample.t - action.startTimeS) <= EPSILON
      && Math.abs(sample.f - action.fraction) <= EPSILON
    ));
    const expectedGeometry = referenceSample(fixedGeometryReference.samples, sample.f);
    const expectedHeading = referenceSample(coupledHeadingReference.samples, sample.f).headingRad;
    const headingDelta = Math.atan2(
      Math.sin(sample.headingRad - expectedHeading),
      Math.cos(sample.headingRad - expectedHeading),
    );
    if (Math.hypot(sample.x - expectedGeometry.x, sample.y - expectedGeometry.y) > 0.001
      || (!authoredTurnBoundary && Math.abs(headingDelta) > 0.001)) {
      return "The optimizer changed the fixed geometry or heading law.";
    }
  }
  const endpoints = [[interactive.samples[0], candidate.samples[0]], [interactive.samples.at(-1)!, candidate.samples.at(-1)!]];
  for (const [expected, actual] of endpoints) {
    const headingDelta = Math.atan2(
      Math.sin(actual.headingRad - expected.headingRad),
      Math.cos(actual.headingRad - expected.headingRad),
    );
    if (Math.hypot(actual.x - expected.x, actual.y - expected.y) > 0.001
      || Math.abs(headingDelta) > 0.001
      || Math.abs(actual.velocityMps - expected.velocityMps) > 0.001) {
      return "The optimizer changed a fixed endpoint pose or velocity.";
    }
  }
  if (candidate.markers.length !== interactive.markers.length
    || candidate.markers.some((marker, index) => marker.id !== interactive.markers[index].id
      || Math.abs(marker.fraction - interactive.markers[index].fraction) > EPSILON)) {
    return "The optimizer changed the authored event order or placement.";
  }
  for (const waypoint of input.path.waypoints.filter((value) => value.stop)) {
    const nearest = candidate.samples.reduce((best, sample) => (
      Math.hypot(sample.x - waypoint.x, sample.y - waypoint.y)
        < Math.hypot(best.x - waypoint.x, best.y - waypoint.y) ? sample : best
    ));
    if (Math.hypot(nearest.x - waypoint.x, nearest.y - waypoint.y) > 0.001
      || Math.abs(nearest.velocityMps) > 0.001) {
      return "The optimizer changed an authored stop.";
    }
  }
  return null;
}

interface FinalValidation {
  failure?: string;
  /** False for evaluator exceptions; true only for observed invalid output/constraints. */
  concreteFailure?: boolean;
  constraintViolations: number;
  validatedPoints: number;
  activeConstraints: string[];
}

export function validateFinal(input: PlannerInput, result: PlannerResult): FinalValidation {
  const errors = result.diagnostics.filter((issue) => issue.severity === "error");
  const invalidSamples = result.samples.length < 2
    || !Number.isFinite(result.totalTimeS) || !Number.isFinite(result.totalDistanceM)
    || result.totalTimeS < 0 || result.totalDistanceM < 0
    || result.samples.some((sample, index) => (
      ![sample.t, sample.s, sample.f, sample.x, sample.y, sample.headingRad,
        sample.velocityMps, sample.accelerationMps2, sample.angularVelocityRadps].every(Number.isFinite)
      || sample.t < 0 || (index > 0 && sample.t < result.samples[index - 1].t)
    ));
  if (invalidSamples || errors.length > 0 || result.optimization?.fallback) {
    return {
      concreteFailure: invalidSamples || errors.length > 0,
      failure: errors[0]?.message ?? result.optimization?.fallbackReason ?? "The trajectory has missing or non-finite samples.",
      constraintViolations: Math.max(1, errors.length, result.optimization?.constraintViolations ?? 0),
      validatedPoints: result.optimization?.validatedPoints ?? 0,
      activeConstraints: result.optimization?.activeConstraints ?? [],
    };
  }
  try {
    const movingResult = result.stationaryActions?.length
      ? {
          ...result,
          samples: result.samples.filter((sample) => !result.stationaryActions!.some((action) => (
            sample.t > action.startTimeS + EPSILON && sample.t <= action.endTimeS + EPSILON
          ))),
        }
      : result;
    const timedSamples = fixedPathSamples(movingResult);
    const samplesPerSegment = (input.samplesPerSegment ?? DEFAULT_SAMPLES_PER_SEGMENT)
      * (2 ** (result.optimization?.refinementPasses ?? 0));
    const physicalInput = physicalPlannerInput(input);
    const samples = buildDenseValidationSamples(physicalInput, timedSamples, samplesPerSegment);
    const validation = validateOptimizedTrajectory(physicalInput, samples, { angularKinematics: "sample" });
    return {
      failure: validation.violations[0]?.message,
      concreteFailure: validation.violations.length > 0,
      constraintViolations: validation.violations.length,
      validatedPoints: validation.checkedPoints,
      activeConstraints: validation.activeConstraints,
    };
  } catch (error) {
    return {
      failure: error instanceof Error ? error.message : "Final trajectory validation failed.",
      constraintViolations: Math.max(1, result.optimization?.constraintViolations ?? 0),
      validatedPoints: result.optimization?.validatedPoints ?? 0,
      activeConstraints: result.optimization?.activeConstraints ?? [],
    };
  }
}

function retainedBaseline(
  input: PlannerInput,
  baseline: PlannerResult,
  reason?: string,
): PlannerResult {
  const validation = validateFinal(input, baseline);
  const failure = validation.failure;
  const optimization: PlannerOptimizationDiagnostics = {
    ...(baseline.optimization ?? { solveTimeMs: 0 }),
    constraintViolations: validation.constraintViolations,
    validatedPoints: validation.validatedPoints,
    activeConstraints: validation.activeConstraints,
    plannerUsed: baseline.planner,
    status: failure ? "invalid-input" : "equivalent",
    totalTimeS: baseline.totalTimeS,
    maxVelocityMps: Math.max(0, ...baseline.samples.map((sample) => Math.abs(sample.velocityMps))),
    maxAccelerationMps2: Math.max(0, ...baseline.samples.map((sample) => Math.abs(sample.accelerationMps2))),
    fallback: Boolean(failure),
    fallbackReason: failure ?? reason,
  };
  // Diagnostics describe the trajectory actually returned, never a rejected candidate.
  return {
    ...baseline,
    diagnostics: failure ? [...baseline.diagnostics, {
      severity: "error",
      path: `paths.${input.path.name}.planner`,
      message: `Normal trajectory could not be validated: ${failure}`,
    }] : baseline.diagnostics,
    optimization,
  };
}

/** Accepts a fixed-path result only after authoritative physical validation. */
export function optimizeFixedGeometryFinal(input: PlannerInput): PlannerResult {
  const interactive = getPlanner("profiledSpline").generate(input);
  let candidate: PlannerResult;
  try {
    candidate = getPlanner("optimizedTrajectory").generate(input);
  } catch (error) {
    return retainedBaseline(input, interactive, error instanceof Error ? error.message : "Final optimization failed.");
  }

  const failure = optimizerFailure(candidate) ?? invariantFailure(input, interactive, candidate);
  if (failure) return retainedBaseline(input, interactive, failure);
  const validation = validateFinal(input, candidate);
  if (validation.failure) return retainedBaseline(input, interactive, validation.failure);
  if (candidate.totalTimeS >= interactive.totalTimeS - EPSILON) {
    const retained = retainedBaseline(input, interactive);
    if (!retained.optimization?.fallback) return retained;
  }
  return {
    ...candidate,
    optimization: {
      ...candidate.optimization!,
      status: "feasible",
      constraintViolations: validation.constraintViolations,
      validatedPoints: validation.validatedPoints,
      activeConstraints: validation.activeConstraints,
      maxVelocityMps: Math.max(0, ...candidate.samples.map((sample) => Math.abs(sample.velocityMps))),
      maxAccelerationMps2: Math.max(0, ...candidate.samples.map((sample) => Math.abs(sample.accelerationMps2))),
    },
  };
}
