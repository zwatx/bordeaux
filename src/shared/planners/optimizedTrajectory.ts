import type {
  PlannerInput,
  PlannerOptimizationDiagnostics,
  PlannerResult,
  TrajectoryPlanner,
  TrajectorySample,
  ValidationIssue,
} from "../types";
import { buildReachabilityInput, countLinearConstraintViolations, insertOptimizationBoundaries } from "./optimizationConstraints";
import { DEFAULT_SAMPLES_PER_SEGMENT, MAX_TRAJECTORY_SAMPLES } from "./limits";
import { profiledSplineOptimizationInputs, profiledSplineOptimizationSeed, profiledSplinePlanner } from "./profiledSpline";
import { solveReachabilityProfile, type ReachabilityInput, type ReachabilityStatus } from "./reachability";
import { validateOptimizedTrajectory, type TrajectoryValidationResult } from "./trajectoryValidation";
import { buildCanonicalPathState, isStationaryHeadingTransition } from "./pathState";
import { effectiveRanges } from "./rotationPriority";

const R = (value: number, places = 4) => Number(value.toFixed(places));
const MAX_REFINEMENT_PASSES = 2;

/** Retain authored boundaries when constraint knots are inserted into a refined seed. */
export function remapWaypointIndices(base: PlannerResult, samples: readonly TrajectorySample[]): number[] | undefined {
  if (!base.waypointSampleIndices) return undefined;
  const remapped = new Map<number, number>();
  const boundaries = new Set(base.waypointSampleIndices);
  let cursor = 0;
  base.samples.forEach((source, index) => {
    while (cursor < samples.length && (samples[cursor].s !== source.s
      || samples[cursor].x !== source.x || samples[cursor].y !== source.y)) cursor += 1;
    if (cursor === samples.length) throw new Error("Optimization lost a source geometry sample");
    if (boundaries.has(index)) remapped.set(index, cursor);
    cursor += 1;
  });
  return base.waypointSampleIndices.map((index) => remapped.get(index)!);
}

/** Integrates a sample-aligned speed profile into timestamps and rates. */
export function remapTiming(samples: TrajectorySample[], velocities: number[], fullPrecision = false): TrajectorySample[] {
  if (samples.length < 2) return samples;

  const times = new Array(samples.length).fill(0);
  for (let i = 1; i < samples.length; i += 1) {
    const ds = Math.max(0, samples[i].s - samples[i - 1].s);
    const avgV = Math.max(1e-6, (velocities[i] + velocities[i - 1]) * 0.5);
    times[i] = times[i - 1] + ds / avgV;
  }

  const intervalAngularVelocities = samples.slice(1).map((sample, index) => {
    const headingDelta = Math.atan2(
      Math.sin(sample.headingRad - samples[index].headingRad),
      Math.cos(sample.headingRad - samples[index].headingRad),
    );
    return headingDelta / Math.max(1e-6, times[index + 1] - times[index]);
  });
  const angularVelocities = samples.map((_sample, index) => {
    if (Math.abs(velocities[index]) <= 1e-6) return 0;
    if (index === 0) return intervalAngularVelocities[0];
    if (index === samples.length - 1) return intervalAngularVelocities.at(-1)!;
    if (Math.abs(velocities[index - 1]) <= 1e-6) return intervalAngularVelocities[index];
    if (Math.abs(velocities[index + 1]) <= 1e-6) return intervalAngularVelocities[index - 1];
    const beforeDt = Math.max(1e-6, times[index] - times[index - 1]);
    const afterDt = Math.max(1e-6, times[index + 1] - times[index]);
    return (intervalAngularVelocities[index - 1] * afterDt
      + intervalAngularVelocities[index] * beforeDt) / (beforeDt + afterDt);
  });

  return samples.map((sample, i) => {
    const dtPrev = i > 0 ? Math.max(1e-6, times[i] - times[i - 1]) : 0;
    const dtNext = i < samples.length - 1 ? Math.max(1e-6, times[i + 1] - times[i]) : dtPrev;
    const accel =
      i === 0
        ? 0
        : i === samples.length - 1
          ? 0
          : (velocities[i + 1] - velocities[i - 1]) / Math.max(1e-6, dtPrev + dtNext);
    return {
      ...sample,
      t: fullPrecision ? times[i] : R(times[i], 6),
      velocityMps: fullPrecision ? velocities[i] : R(velocities[i], 6),
      accelerationMps2: fullPrecision ? accel : R(accel, 6),
      angularVelocityRadps: fullPrecision ? angularVelocities[i] : R(angularVelocities[i], 7),
    };
  });
}

export function retimeTrajectoryWithVelocityLimits(
  input: PlannerInput,
  result: PlannerResult,
  requestedVelocityLimits: readonly number[],
): PlannerResult | null {
  if (requestedVelocityLimits.length !== result.samples.length) return null;
  const reachabilityInput = buildReachabilityInput(input, result.samples);
  const reachability = solveReachabilityProfile({
    ...reachabilityInput,
    velocityLimits: reachabilityInput.velocityLimits.map((limit, index) => (
      Math.min(limit, requestedVelocityLimits[index] ?? Number.POSITIVE_INFINITY)
    )),
  });
  if (reachability.status !== "optimal") return null;
  const samples = remapTiming(result.samples, reachability.velocities);
  const totalTimeS = samples.at(-1)?.t ?? result.totalTimeS;
  return {
    ...result,
    samples,
    totalTimeS,
    markers: result.markers.map((marker) => ({ ...marker, timeS: timeAtFraction(samples, marker.fraction) })),
    optimization: result.optimization ? {
      ...result.optimization,
      iterations: (result.optimization.iterations ?? 0) + reachability.iterations,
      totalTimeS,
      maxVelocityMps: Math.max(0, ...samples.map((sample) => Math.abs(sample.velocityMps))),
      maxAccelerationMps2: Math.max(0, ...samples.map((sample) => Math.abs(sample.accelerationMps2))),
    } : result.optimization,
  };
}

export function scaleTrajectoryTiming(result: PlannerResult, scale: number): PlannerResult {
  const safeScale = Math.max(Number.EPSILON, Math.min(1, scale));
  const lastIndex = result.samples.length - 1;
  const startVelocity = Math.abs(result.samples[0]?.velocityMps ?? 0);
  const goalVelocity = Math.abs(result.samples[lastIndex]?.velocityMps ?? 0);
  const totalDistance = Math.max(1e-9, result.samples[lastIndex]?.s ?? result.totalDistanceM);
  const velocities = result.samples.map((sample, index) => {
    if (index === 0 || index === lastIndex) return sample.velocityMps;
    const fraction = Math.max(0, Math.min(1, sample.s / totalDistance));
    const boundaryFloor = Math.max(startVelocity * (1 - fraction), goalVelocity * fraction);
    return Math.max(Math.abs(sample.velocityMps) * safeScale, boundaryFloor);
  });
  const samples = remapTiming(result.samples, velocities);
  const totalTimeS = samples.at(-1)?.t ?? result.totalTimeS;
  const maxVelocityMps = Math.max(0, ...samples.map((sample) => Math.abs(sample.velocityMps)));
  const maxAccelerationMps2 = Math.max(0, ...samples.map((sample) => Math.abs(sample.accelerationMps2)));
  return {
    ...result,
    totalTimeS,
    samples,
    markers: result.markers.map((marker) => ({ ...marker, timeS: timeAtFraction(samples, marker.fraction) })),
    optimization: result.optimization ? {
      ...result.optimization,
      totalTimeS,
      maxVelocityMps,
      maxAccelerationMps2,
    } : result.optimization,
  };
}

function remapProfileForValidation(
  input: PlannerInput,
  geometrySamples: TrajectorySample[],
  timedSamples: TrajectorySample[],
): TrajectorySample[] {
  const timedState = buildCanonicalPathState(input.path, timedSamples);
  const zoneBoundaries = effectiveRanges(input.path, timedSamples, timedSamples.at(-1)?.s ?? 0)
    .flatMap((range) => [range.start, range.end]);
  const stationaryTurnAt = (index: number) => (
    isStationaryHeadingTransition(
      input.path,
      timedState.points[index],
      timedState.points[index + 1]?.headingRad,
    )
  );
  let sourceIndex = 0;
  const profile = geometrySamples.map((sample) => {
    // Integrated geometry (for example clothoids) can shift slightly with
    // resolution. Endpoint speeds are authored boundaries, not projections.
    const endpoint = sample.f <= 0 ? timedSamples[0] : sample.f >= 1 ? timedSamples.at(-1) : undefined;
    if (endpoint) return {
      sample: { ...sample, headingRad: endpoint.headingRad },
      velocity: Math.abs(endpoint.velocityMps),
    };
    while (sourceIndex < timedSamples.length - 2 && timedSamples[sourceIndex + 1].f < sample.f) sourceIndex += 1;
    const atZoneBoundary = zoneBoundaries.some((fraction) => Math.abs(fraction - sample.f) <= 1e-12);
    for (let candidate = Math.max(0, sourceIndex - 2); candidate <= Math.min(timedSamples.length - 1, sourceIndex + 3); candidate += 1) {
      // Authored constraint knots have the same fraction at both resolutions,
      // even when their interpolated geometry differs slightly. Preserve the
      // solved speed at that knot instead of projecting it outside its Zone.
      if ((atZoneBoundary && Math.abs(timedSamples[candidate].f - sample.f) <= 1e-12)
        || Math.hypot(timedSamples[candidate].x - sample.x, timedSamples[candidate].y - sample.y) <= 1e-8) {
        sourceIndex = candidate;
        return {
          sample: { ...sample, headingRad: timedSamples[candidate].headingRad },
          velocity: Math.abs(timedSamples[candidate].velocityMps),
        };
      }
    }
    const before = timedSamples[sourceIndex];
    const after = timedSamples[Math.min(timedSamples.length - 1, sourceIndex + 1)];
    const dx = after.x - before.x, dy = after.y - before.y;
    const chordSquared = dx * dx + dy * dy;
    // Coarse and dense geometry have slightly different integrated lengths.
    // Use the local chord so interpolation meets coincident knots continuously.
    const ratio = chordSquared > 1e-12
      ? Math.max(0, Math.min(1, ((sample.x - before.x) * dx + (sample.y - before.y) * dy) / chordSquared))
      : Math.max(0, Math.min(1, (sample.f - before.f) / Math.max(1e-9, after.f - before.f)));
    const speedSquared = before.velocityMps ** 2
      + (after.velocityMps ** 2 - before.velocityMps ** 2) * ratio;
    const headingDelta = stationaryTurnAt(sourceIndex) || stationaryTurnAt(sourceIndex + 1)
      ? 0
      : Math.atan2(
          Math.sin(after.headingRad - before.headingRad),
          Math.cos(after.headingRad - before.headingRad),
        );
    const distance = after.s - before.s;
    const startSlope = timedState.points[sourceIndex].headingDerivativeRadPerM;
    const endSlope = timedState.points[Math.min(timedState.points.length - 1, sourceIndex + 1)].headingDerivativeRadPerM;
    const t2 = ratio * ratio, t3 = t2 * ratio;
    // Preserve heading rate through sample boundaries. Linear densification
    // creates artificial rate jumps which validation mistakes for acceleration.
    const headingRad = stationaryTurnAt(sourceIndex + 1)
      ? before.headingRad
      : stationaryTurnAt(sourceIndex)
        ? after.headingRad
        : (2 * t3 - 3 * t2 + 1) * before.headingRad
          + (t3 - 2 * t2 + ratio) * distance * startSlope
          + (-2 * t3 + 3 * t2) * (before.headingRad + headingDelta)
          + (t3 - t2) * distance * endSlope;
    return {
      sample: { ...sample, headingRad },
      velocity: Math.sqrt(Math.max(0, speedSquared)),
    };
  });
  return remapTiming(
    profile.map((entry) => entry.sample),
    profile.map((entry) => entry.velocity),
    // Microsecond rounding before differentiation creates acceleration noise
    // as validation intervals become shorter. Round only returned trajectories.
    true,
  );
}

function buildDenseValidationGeometry(
  input: PlannerInput,
  samplesPerSegment = input.samplesPerSegment ?? DEFAULT_SAMPLES_PER_SEGMENT,
  validationMultiplier?: number,
): TrajectorySample[] {
  const segmentCount = Math.max(0, input.path.waypoints.length - 1);
  // Prefer a fine validation grid without shrinking the existing 2x input
  // budget. Explicit requests still fail rather than silently losing density.
  const multiplier = validationMultiplier ?? Math.max(2, Math.min(8,
    Math.floor((MAX_TRAJECTORY_SAMPLES - 1) / Math.max(1, segmentCount) / samplesPerSegment),
  ));
  const denseSamplesPerSegment = samplesPerSegment * multiplier;
  if (segmentCount > Math.floor((MAX_TRAJECTORY_SAMPLES - 1) / denseSamplesPerSegment)) {
    throw new Error(`Dense validation requires more than ${MAX_TRAJECTORY_SAMPLES} trajectory samples`);
  }
  return insertOptimizationBoundaries(
    input,
    profiledSplineOptimizationSeed({ ...input, samplesPerSegment: denseSamplesPerSegment }).samples,
  );
}

export function buildDenseValidationSamples(
  input: PlannerInput,
  timedSamples: TrajectorySample[],
  samplesPerSegment = input.samplesPerSegment ?? DEFAULT_SAMPLES_PER_SEGMENT,
  validationMultiplier?: number,
): TrajectorySample[] {
  return remapProfileForValidation(input,
    buildDenseValidationGeometry(input, samplesPerSegment, validationMultiplier), timedSamples);
}

function timeAtFraction(samples: TrajectorySample[], fraction: number): number {
  if (samples.length === 0) return 0;
  const target = Math.max(0, Math.min(1, fraction));
  if (target <= samples[0].f) return samples[0].t;
  for (let index = 1; index < samples.length; index += 1) {
    const current = samples[index];
    if (current.f >= target) {
      const previous = samples[index - 1];
      const span = Math.max(1e-9, current.f - previous.f);
      return previous.t + (current.t - previous.t) * ((target - previous.f) / span);
    }
  }
  return samples[samples.length - 1].t;
}

function nearestFractionIndex(samples: readonly TrajectorySample[], fraction: number): number {
  let low = 0;
  let high = samples.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (samples[middle].f < fraction) low = middle + 1;
    else high = middle;
  }
  if (low > 0 && Math.abs(samples[low - 1].f - fraction) < Math.abs(samples[low].f - fraction)) return low - 1;
  return low;
}

function locallyRetimeViolations(
  input: PlannerInput,
  geometrySamples: TrajectorySample[],
  initialSamples: TrajectorySample[],
  reachabilityInput: ReachabilityInput,
  samplesPerSegment: number,
  initialValidationSamples: TrajectorySample[],
  initialValidation: TrajectoryValidationResult,
  validationGeometry: TrajectorySample[],
): { samples: TrajectorySample[]; validation: TrajectoryValidationResult; iterations: number } | null {
  const velocityLimits = [...reachabilityInput.velocityLimits];
  let samples = initialSamples;
  let validationSamples = initialValidationSamples;
  let validation = initialValidation;
  let iterations = 0;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    let changed = false;
    for (const violation of validation.violations) {
      if (!violation.refinable || violation.measured <= violation.limit + 1e-9) continue;
      const fraction = validationSamples[violation.sampleIndex]?.f;
      if (fraction === undefined) continue;
      const center = nearestFractionIndex(geometrySamples, fraction);
      const ratio = Math.max(0.05, Math.min(0.95, violation.limit / violation.measured));
      const centerLimit = Math.abs(samples[center].velocityMps) * Math.sqrt(ratio) * 0.97;
      // A heading-law seam is spatial, so its repair window must not shrink
      // when dense validation raises the samples-per-segment count.
      const radius = violation.kind === "angular-acceleration"
        ? Math.max(8, Math.ceil(samplesPerSegment * 0.1))
        : 3;
      for (let offset = -radius; offset <= radius; offset += 1) {
        const index = center + offset;
        if (index <= 0 || index >= velocityLimits.length - 1) continue;
        const blend = Math.abs(offset) / (radius + 1);
        const localLimit = centerLimit + (Math.abs(samples[index].velocityMps) - centerLimit) * blend;
        const next = Math.max(0, localLimit);
        if (next < velocityLimits[index] - 1e-6) {
          velocityLimits[index] = next;
          changed = true;
        }
      }
    }
    if (!changed) return null;

    const reachability = solveReachabilityProfile({ ...reachabilityInput, velocityLimits });
    if (reachability.status !== "optimal") return null;
    iterations += reachability.iterations;
    samples = remapTiming(geometrySamples, reachability.velocities);
    validationSamples = remapProfileForValidation(input, validationGeometry, samples);
    validation = validateOptimizedTrajectory(input, validationSamples, {
      angularKinematics: "sample",
    });
    if (validation.violations.length === 0) return { samples, validation, iterations };
  }
  return null;
}

function diagnostics(
  input: PlannerInput,
  samples: TrajectorySample[],
  solveTimeMs: number,
  status: ReachabilityStatus | "feasible" | "equivalent" | "internal-error",
  iterations: number,
  fallbackReason?: string,
  validation?: TrajectoryValidationResult,
  refinementPasses = 0,
): PlannerOptimizationDiagnostics {
  const maxVelocityMps = samples.reduce((max, sample) => Math.max(max, Math.abs(sample.velocityMps)), 0);
  const maxAccelerationMps2 = samples.reduce((max, sample) => Math.max(max, Math.abs(sample.accelerationMps2)), 0);
  return {
    plannerUsed: "optimizedTrajectory",
    status,
    iterations,
    refinementPasses,
    validatedPoints: validation?.checkedPoints,
    activeConstraints: validation?.activeConstraints,
    solveTimeMs: R(solveTimeMs, 3),
    totalTimeS: R(samples[samples.length - 1]?.t ?? 0, 4),
    maxVelocityMps: R(maxVelocityMps, 4),
    maxAccelerationMps2: R(maxAccelerationMps2, 4),
    constraintViolations: validation?.violations.length
      ?? (status === "optimal" || status === "feasible" ? countLinearConstraintViolations(input, samples) : 0),
    fallback: Boolean(fallbackReason),
    fallbackReason,
  };
}

export const optimizedTrajectoryPlanner: TrajectoryPlanner = {
  id: "optimizedTrajectory",
  generate(input): PlannerResult {
    const started = performance.now();
    const { base, seed: optimizationSeed } = profiledSplineOptimizationInputs(input);
    const solveTimeMs = performance.now() - started;

    if (base.samples.length < 2) {
      const fallbackReason = "Profiled spline did not produce enough samples for optimization.";
      const issue: ValidationIssue = {
        severity: "warning",
        path: `paths.${input.path.name}.planner`,
        message: fallbackReason,
      };
      return {
        ...base,
        planner: "profiledSpline",
        diagnostics: [...base.diagnostics, issue],
        optimization: {
          ...diagnostics(input, base.samples, solveTimeMs, "invalid-input", 0, fallbackReason),
          plannerUsed: "profiledSpline",
        },
      };
    }

    if ((input.path.constraints.maxJerk ?? 0) > 0) {
      const reason = "Optimized trajectory does not yet support nonzero translational jerk.";
      return {
        ...base,
        planner: "optimizedTrajectory",
        diagnostics: [...base.diagnostics, {
          severity: "error",
          path: `paths.${input.path.name}.constraints.maxJerk`,
          message: reason,
        }],
        optimization: diagnostics(input, base.samples, performance.now() - started, "invalid-input", 0),
      };
    }

    try {
      let candidateBase = optimizationSeed;
      let samplesPerSegment = input.samplesPerSegment ?? DEFAULT_SAMPLES_PER_SEGMENT;
      let totalIterations = 0;
      for (let refinementPasses = 0; refinementPasses <= MAX_REFINEMENT_PASSES; refinementPasses += 1) {
        const optimizationSamples = insertOptimizationBoundaries(input, candidateBase.samples);
        const waypointSampleIndices = remapWaypointIndices(candidateBase, optimizationSamples);
        const reachabilityInput = buildReachabilityInput(input, optimizationSamples);
        const reachability = solveReachabilityProfile(reachabilityInput);
        totalIterations += reachability.iterations;
        if (reachability.status !== "optimal") {
          const reason = reachability.reason ?? "The fixed-path optimizer could not produce a trajectory.";
          const issue: ValidationIssue = {
            severity: "error",
            path: `paths.${input.path.name}.planner`,
            message: `Optimized trajectory is ${reachability.status}: ${reason}`,
          };
          return {
            ...candidateBase,
            planner: "optimizedTrajectory",
            diagnostics: [...candidateBase.diagnostics, issue],
            optimization: diagnostics(
              input,
              candidateBase.samples,
              performance.now() - started,
              reachability.status,
              totalIterations,
              undefined,
              undefined,
              refinementPasses,
            ),
          };
        }

        const samples = remapTiming(optimizationSamples, reachability.velocities);
        const segmentCount = Math.max(0, input.path.waypoints.length - 1);
        // Retiming changes speeds, not geometry. Share this refinement's dense
        // geometry while remapping and validating every newly solved profile.
        const validationGeometry = buildDenseValidationGeometry(input, samplesPerSegment);
        const validationSamples = remapProfileForValidation(input, validationGeometry, samples);
        const validation = validateOptimizedTrajectory(input, validationSamples, {
          angularKinematics: "sample",
        });
        if (validation.violations.length === 0) {
          const totalTimeS = samples[samples.length - 1]?.t ?? candidateBase.totalTimeS;
          return {
            planner: "optimizedTrajectory",
            totalTimeS,
            totalDistanceM: candidateBase.totalDistanceM,
            waypointSampleIndices,
            samples,
            markers: candidateBase.markers.map((marker) => ({ ...marker, timeS: R(timeAtFraction(samples, marker.fraction), 6) })),
            diagnostics: candidateBase.diagnostics,
            optimization: diagnostics(
              input,
              samples,
              performance.now() - started,
              "optimal",
              totalIterations,
              undefined,
              validation,
              refinementPasses,
            ),
          };
        }

        const allRefinable = validation.violations.every((violation) => violation.refinable);
        const nextSamplesPerSegment = samplesPerSegment * 2;
        const withinSampleLimit = segmentCount <= Math.floor((MAX_TRAJECTORY_SAMPLES - 1) / nextSamplesPerSegment);
        if (allRefinable && refinementPasses < MAX_REFINEMENT_PASSES && withinSampleLimit) {
          samplesPerSegment = nextSamplesPerSegment;
          candidateBase = profiledSplineOptimizationSeed({ ...input, samplesPerSegment });
          continue;
        }

        const locallyRetimed = locallyRetimeViolations(
          input,
          optimizationSamples,
          samples,
          reachabilityInput,
          samplesPerSegment,
          validationSamples,
          validation,
          validationGeometry,
        );
        if (locallyRetimed) {
          totalIterations += locallyRetimed.iterations;
          const totalTimeS = locallyRetimed.samples.at(-1)?.t ?? candidateBase.totalTimeS;
          return {
            planner: "optimizedTrajectory",
            totalTimeS,
            totalDistanceM: candidateBase.totalDistanceM,
            waypointSampleIndices,
            samples: locallyRetimed.samples,
            markers: candidateBase.markers.map((marker) => ({
              ...marker,
              timeS: R(timeAtFraction(locallyRetimed.samples, marker.fraction), 6),
            })),
            diagnostics: candidateBase.diagnostics,
            optimization: diagnostics(
              input,
              locallyRetimed.samples,
              performance.now() - started,
              "optimal",
              totalIterations,
              undefined,
              locallyRetimed.validation,
              refinementPasses,
            ),
          };
        }

        const uniformlyRetimable = validation.violations.every((violation) => (
          violation.refinable && [
            "angular-velocity",
            "angular-acceleration",
            "centripetal-acceleration",
            "drivetrain-velocity",
            "drivetrain-acceleration",
          ].includes(violation.kind)
        ));
        if (uniformlyRetimable) {
          for (let timingScale = 0.9; timingScale >= 0.35; timingScale *= 0.9) {
            const slowedSamples = scaleTrajectoryTiming({
              ...candidateBase,
              samples,
              totalTimeS: samples.at(-1)?.t ?? candidateBase.totalTimeS,
            }, timingScale).samples;
            const slowedValidationSamples = scaleTrajectoryTiming({
              ...candidateBase,
              samples: validationSamples,
              totalTimeS: validationSamples.at(-1)?.t ?? candidateBase.totalTimeS,
            }, timingScale).samples;
            const slowedValidation = validateOptimizedTrajectory(input, slowedValidationSamples, {
              angularKinematics: "sample",
            });
            const acceptedSamples = slowedValidation.violations.length === 0
              ? slowedSamples
              : undefined;
            const acceptedValidation = slowedValidation.violations.length === 0
              ? slowedValidation
              : undefined;
            if (acceptedSamples && acceptedValidation) {
              const totalTimeS = acceptedSamples.at(-1)?.t ?? candidateBase.totalTimeS;
              return {
                planner: "optimizedTrajectory",
                totalTimeS,
                totalDistanceM: candidateBase.totalDistanceM,
                waypointSampleIndices,
                samples: acceptedSamples,
                markers: candidateBase.markers.map((marker) => ({
                  ...marker,
                  timeS: R(timeAtFraction(acceptedSamples, marker.fraction), 6),
                })),
                diagnostics: candidateBase.diagnostics,
                optimization: diagnostics(
                  input,
                  acceptedSamples,
                  performance.now() - started,
                  "optimal",
                  totalIterations,
                  undefined,
                  acceptedValidation,
                  refinementPasses,
                ),
              };
            }
          }
        }

        const firstViolation = validation.violations[0];
        const fallbackReason = `Dense validation found ${validation.violations.length} constraint violation${validation.violations.length === 1 ? "" : "s"}: ${firstViolation.message}`;
        const issue: ValidationIssue = {
          severity: "warning",
          path: `paths.${input.path.name}.planner`,
          message: `Optimized trajectory fell back to profiled spline: ${fallbackReason}`,
        };
        const fallback = profiledSplinePlanner.generate({ ...input, samplesPerSegment });
        return {
          ...fallback,
          planner: "profiledSpline",
          diagnostics: [...fallback.diagnostics, issue],
          optimization: {
            ...diagnostics(
              input,
              fallback.samples,
              performance.now() - started,
              "internal-error",
              totalIterations,
              fallbackReason,
              validation,
              refinementPasses,
            ),
            plannerUsed: "profiledSpline",
          },
        };
      }
      throw new Error("Optimizer refinement loop ended without a result.");
    } catch (error) {
      const fallbackReason = error instanceof Error ? error.message : "Optimizer failed.";
      const issue: ValidationIssue = {
        severity: "warning",
        path: `paths.${input.path.name}.planner`,
        message: `Optimized trajectory fell back to profiled spline: ${fallbackReason}`,
      };
      return {
        ...base,
        planner: "profiledSpline",
        diagnostics: [...base.diagnostics, issue],
        optimization: {
          ...diagnostics(input, base.samples, performance.now() - started, "internal-error", 0, fallbackReason),
          plannerUsed: "profiledSpline",
        },
      };
    }
  },
};
