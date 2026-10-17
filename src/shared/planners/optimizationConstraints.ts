import type { PlannerInput, TrajectorySample } from "../types";
import { robotHardLimits } from "../robotLimits";
import { headingTransitionWindows, segmentHeadingLaws } from "./headingTransitions";
import { MAX_TRAJECTORY_SAMPLES } from "./limits";
import { buildDrivetrainProjection } from "./drivetrainProjection";
import {
  buildCanonicalPathState,
  interpolatePathPoint,
  isStationaryHeadingTransition,
} from "./pathState";
import {
  activeRanges,
  effectiveRanges,
  type EffectiveRange,
} from "./rotationPriority";
import type { AffineScalarAccelerationConstraint, ReachabilityInput } from "./reachability";

const EPSILON = 1e-9;
const NUMERICAL_SAFETY = 0.99;
const DRIVETRAIN_SAFETY = 0.95;
const ANGULAR_ACCELERATION_SAFETY = 0.85;
const DEG = Math.PI / 180;
const OPTIMIZATION_BOUNDARY_POSITION_TOLERANCE_M = 1e-4;

export interface LinearLimits {
  freeSpeed: number;
  motorAcceleration: number;
  velocity: number;
  acceleration: number;
  deceleration: number;
}

export interface LinearConstraintProfile {
  points: LinearLimits[];
  intervals: LinearLimits[];
}

function baseLinearLimits(input: PlannerInput): LinearLimits {
  const velocityCap = Math.max(0.01, input.robot.maxSpeed || input.path.constraints.maxVel || 0.01);
  const hardLimits = robotHardLimits(input.robot);
  const acceleration = Math.max(0.01, input.path.constraints.maxAccel || 0.01);
  return {
    freeSpeed: velocityCap,
    // Keep the motor torque-speed envelope independent from traction. The
    // reachability solve applies both, so the active limit is their minimum at
    // each speed rather than a traction limit that incorrectly falls with RPM.
    motorAcceleration: hardLimits?.motorAccelMps2 ?? acceleration,
    velocity: Math.max(0.01, Math.min(velocityCap, input.path.constraints.maxVel || velocityCap)),
    acceleration,
    deceleration: Math.max(0.01, input.path.constraints.maxDecel ?? input.path.constraints.maxAccel ?? 0.01),
  };
}

function tightenLinearLimits(limits: LinearLimits, ranges: readonly EffectiveRange[]): LinearLimits {
  let velocity = limits.velocity;
  let acceleration = limits.acceleration;
  let deceleration = limits.deceleration;
  ranges.forEach((range) => {
    if (range.maxVel !== undefined && range.maxVel > 0) velocity = Math.min(velocity, range.maxVel);
    if (range.maxAccel !== undefined && range.maxAccel > 0) acceleration = Math.min(acceleration, range.maxAccel);
    const rangeDeceleration = range.maxDecel;
    if (rangeDeceleration !== undefined && rangeDeceleration > 0) deceleration = Math.min(deceleration, rangeDeceleration);
  });
  return { ...limits, velocity, acceleration, deceleration };
}

function intervalRanges(ranges: readonly EffectiveRange[], before: number, after: number): EffectiveRange[] {
  const start = Math.min(before, after);
  const end = Math.max(before, after);
  return ranges.filter((range) => Math.min(end, range.end) - Math.max(start, range.start) > EPSILON);
}

function interpolateSample(before: TrajectorySample, after: TrajectorySample, fraction: number): TrajectorySample {
  const span = Math.max(EPSILON, after.f - before.f);
  const ratio = Math.max(0, Math.min(1, (fraction - before.f) / span));
  const mix = (first: number, second: number) => first + (second - first) * ratio;
  const headingDelta = Math.atan2(
    Math.sin(after.headingRad - before.headingRad),
    Math.cos(after.headingRad - before.headingRad),
  );
  return {
    i: 0,
    t: mix(before.t, after.t),
    s: mix(before.s, after.s),
    f: fraction,
    x: mix(before.x, after.x),
    y: mix(before.y, after.y),
    headingRad: before.headingRad + headingDelta * ratio,
    velocityMps: mix(before.velocityMps, after.velocityMps),
    accelerationMps2: mix(before.accelerationMps2, after.accelerationMps2),
    angularVelocityRadps: mix(before.angularVelocityRadps, after.angularVelocityRadps),
    curvatureInvM: mix(before.curvatureInvM, after.curvatureInvM),
  };
}

export function insertOptimizationBoundaries(
  input: PlannerInput,
  samples: readonly TrajectorySample[],
): TrajectorySample[] {
  if (samples.length < 2) return [...samples];
  const totalDistance = samples.at(-1)?.s ?? 0;
  const ranges = effectiveRanges(input.path, samples, totalDistance);
  const state = buildCanonicalPathState(input.path, samples);
  const waypointFractions = state.waypointSampleIndices.map((index) => samples[index]?.f ?? 0);
  const laws = segmentHeadingLaws(input.path, false);
  const breaks = input.path.waypoints.slice(0, -1).map((waypoint) => Boolean(waypoint.turnInPlace));
  const transitions = headingTransitionWindows(
    input.path.waypoints,
    laws,
    breaks,
    waypointFractions,
    totalDistance,
  );
  const targetBoundaries = (input.path.targets ?? []).map((target) => ({
    fraction: target.anchor === "dist"
      ? (target.d ?? target.f * totalDistance) / Math.max(totalDistance, EPSILON)
      : target.f,
    headingRad: target.deg * DEG,
  })).flatMap((target) => {
    const segmentIndex = laws.findIndex((law, segment) => (
      law === "targets"
      && target.fraction >= (waypointFractions[segment] ?? 0) - EPSILON
      && target.fraction <= (waypointFractions[segment + 1] ?? 1) + EPSILON
    ));
    return segmentIndex >= 0 ? [{ ...target, segmentIndex }] : [];
  });
  const boundaries = [
    ...ranges.flatMap((range) => [range.start, range.end]),
    ...transitions.flatMap((transition) => [transition.start, transition.end]),
    ...targetBoundaries.map((target) => target.fraction),
  ]
    .filter((fraction) => fraction > EPSILON && fraction < 1 - EPSILON)
    .sort((left, right) => left - right)
    .filter((fraction, index, values) => index === 0 || Math.abs(fraction - values[index - 1]) > EPSILON);
  const missing = boundaries.filter((fraction) => {
    const boundaryDistance = fraction * totalDistance;
    // Keep exact Zone edges even beside an existing sample. Otherwise the
    // dense grid can straddle an edge and apply its speed cap outside the Zone.
    const hardConstraintBoundary = targetBoundaries.some((target) => (
      Math.abs(target.fraction - fraction) <= EPSILON
    )) || ranges.some((range) => (
      Math.abs(range.start - fraction) <= EPSILON || Math.abs(range.end - fraction) <= EPSILON
    ));
    return !samples.some((sample) => (
      Math.abs(sample.f - fraction) <= EPSILON
      || (!hardConstraintBoundary
        && Math.abs(sample.s - boundaryDistance) <= OPTIMIZATION_BOUNDARY_POSITION_TOLERANCE_M)
    ));
  });
  if (samples.length + missing.length > MAX_TRAJECTORY_SAMPLES) {
    throw new Error(`Optimization boundaries require more than ${MAX_TRAJECTORY_SAMPLES} trajectory samples`);
  }

  const result = [...samples];
  for (const fraction of missing) {
    const afterIndex = result.findIndex((sample) => sample.f > fraction);
    if (afterIndex <= 0) continue;
    result.splice(afterIndex, 0, interpolateSample(result[afterIndex - 1], result[afterIndex], fraction));
  }
  const adjusted = result.map((sample, index) => {
    const target = targetBoundaries.find((candidate) => Math.abs(candidate.fraction - sample.f) <= EPSILON);
    const headingRad = target
      ? sample.headingRad + Math.atan2(
          Math.sin(target.headingRad - sample.headingRad),
          Math.cos(target.headingRad - sample.headingRad),
        )
      : sample.headingRad;
    return { ...sample, i: index, headingRad };
  });

  // A hard off-grid target is inserted after the coarse heading law was
  // sampled. Refit the preceding span through the exact knot so insertion
  // cannot create a one-sample heading kink (and a fake velocity collapse).
  for (let segmentIndex = 0; segmentIndex < laws.length; segmentIndex += 1) {
    const targets = targetBoundaries
      .filter((target) => target.segmentIndex === segmentIndex)
      .sort((first, second) => first.fraction - second.fraction);
    if (targets.length === 0) continue;
    let startIndex = adjusted.findIndex((sample) => Math.abs(
      sample.f - (waypointFractions[segmentIndex] ?? 0),
    ) <= EPSILON);
    if (startIndex < 0) continue;

    for (const target of targets) {
      const goalIndex = adjusted.findIndex((sample) => Math.abs(sample.f - target.fraction) <= EPSILON);
      if (goalIndex <= startIndex) {
        startIndex = Math.max(startIndex, goalIndex);
        continue;
      }
      const exactSample = samples.find((sample) => Math.abs(sample.f - target.fraction) <= EPSILON);
      if (transitions.length === 0 && exactSample && Math.abs(Math.atan2(
        Math.sin(exactSample.headingRad - target.headingRad),
        Math.cos(exactSample.headingRad - target.headingRad),
      )) <= EPSILON) {
        // The geometry sampler already evaluated the continuous heading law
        // at this target. Refitting it would introduce new derivative jumps.
        startIndex = goalIndex;
        continue;
      }
      const startHeading = adjusted[startIndex].headingRad;
      const goalHeading = startHeading + Math.atan2(
        Math.sin(target.headingRad - startHeading),
        Math.cos(target.headingRad - startHeading),
      );
      const startDistance = adjusted[startIndex].s;
      const endDistance = adjusted[goalIndex].s;
      const span = endDistance - startDistance;
      const secant = span > EPSILON ? (goalHeading - startHeading) / span : 0;
      const limitSlope = (slope: number) => {
        if (Math.abs(secant) <= EPSILON || slope * secant <= 0) return 0;
        return Math.sign(secant) * Math.min(Math.abs(slope), Math.abs(secant) * 3);
      };
      const previousDistance = startIndex > 0 ? adjusted[startIndex].s - adjusted[startIndex - 1].s : 0;
      const startSlope = previousDistance > EPSILON
        ? limitSlope((startHeading - adjusted[startIndex - 1].headingRad) / previousDistance)
        : secant;
      const nextDistance = goalIndex + 1 < adjusted.length
        ? adjusted[goalIndex + 1].s - adjusted[goalIndex].s
        : 0;
      const endSlope = nextDistance > EPSILON
        ? limitSlope((adjusted[goalIndex + 1].headingRad - goalHeading) / nextDistance)
        : secant;
      for (let index = startIndex; index <= goalIndex; index += 1) {
        const t = span > EPSILON ? (adjusted[index].s - startDistance) / span : 1;
        const t2 = t * t;
        const t3 = t2 * t;
        adjusted[index].headingRad = (2 * t3 - 3 * t2 + 1) * startHeading
          + (t3 - 2 * t2 + t) * span * startSlope
          + (-2 * t3 + 3 * t2) * goalHeading
          + (t3 - t2) * span * endSlope;
      }
      startIndex = goalIndex;
    }
  }
  return adjusted;
}

function angularVelocityLimitForInterval(
  input: PlannerInput,
  ranges: readonly EffectiveRange[],
  before: number,
  after: number,
): number {
  let limit = input.path.constraints.maxAngVel * DEG;
  for (const range of intervalRanges(ranges, before, after)) limit = Math.min(limit, (range.maxAngVel ?? Infinity) * DEG);
  return limit;
}

function angularAccelerationLimitsForInterval(
  input: PlannerInput,
  ranges: readonly EffectiveRange[],
  before: number,
  after: number,
): { acceleration: number; deceleration: number } {
  let acceleration = input.path.constraints.maxAngAccel * DEG;
  let deceleration = (input.path.constraints.maxAngDecel ?? input.path.constraints.maxAngAccel) * DEG;
  for (const range of intervalRanges(ranges, before, after)) {
    acceleration = Math.min(acceleration, (range.maxAngAccel ?? Infinity) * DEG);
    deceleration = Math.min(deceleration, (range.maxAngAccel ?? Infinity) * DEG);
  }
  return { acceleration, deceleration };
}

export function buildLinearConstraintProfile(input: PlannerInput, samples: readonly TrajectorySample[]): LinearConstraintProfile {
  const base = baseLinearLimits(input);
  const ranges = effectiveRanges(input.path, samples, samples.at(-1)?.s ?? 0);
  return {
    points: samples.map((sample) => tightenLinearLimits(base, activeRanges(ranges, sample.f))),
    intervals: samples.slice(1).map((sample, index) => tightenLinearLimits(
      base,
      intervalRanges(ranges, samples[index].f, sample.f),
    )),
  };
}

/**
 * Adapts Bordeaux's authored limits and geometry-derived velocity envelope to
 * the isolated scalar reachability solver.
 */
export function buildReachabilityInput(
  input: PlannerInput,
  samples: readonly TrajectorySample[],
): ReachabilityInput {
  const profile = buildLinearConstraintProfile(input, samples);
  const ranges = effectiveRanges(input.path, samples, samples.at(-1)?.s ?? 0);
  // Translation and heading are one coupled motion. The sole exception is an
  // explicitly authored stationary turn: its discontinuous before/after
  // headings are connected by stationary samples later, so they must not leak
  // into the moving reachability solve on either adjacent interval.
  const state = buildCanonicalPathState(input.path, samples);
  const stationaryTurnBoundary = (index: number) => (
    isStationaryHeadingTransition(
      input.path,
      state.points[index],
      state.points[index + 1]?.headingRad,
    )
  );
  const trackedHeadingIntervals = samples.slice(1).map((_sample, index) => (
    stationaryTurnBoundary(index) || stationaryTurnBoundary(index + 1)
  ));
  const drivetrain = buildDrivetrainProjection(
    state,
    input.robot,
    profile.intervals.map((limits) => (
      (input.path.constraints.maxCentripetalAccel ?? limits.acceleration)
      * DRIVETRAIN_SAFETY
    )),
    trackedHeadingIntervals,
    DRIVETRAIN_SAFETY,
  );
  const curvatureVelocityLimits = state.points.map((point, index) => {
    const lateralLimit = input.path.constraints.maxCentripetalAccel ?? Math.min(
      profile.intervals[index - 1]?.acceleration ?? Number.POSITIVE_INFINITY,
      profile.intervals[index]?.acceleration ?? Number.POSITIVE_INFINITY,
    );
    return Math.abs(point.curvatureInvM) > EPSILON
      ? Math.sqrt(Math.max(0, lateralLimit * NUMERICAL_SAFETY) / Math.abs(point.curvatureInvM))
      : Number.POSITIVE_INFINITY;
  });
  const intervalCurvatureVelocityLimits = state.points.slice(1).map((point, index) => {
    const curvature = Math.abs((state.points[index].curvatureInvM + point.curvatureInvM) * 0.5);
    const lateralLimit = input.path.constraints.maxCentripetalAccel ?? profile.intervals[index].acceleration;
    return curvature > EPSILON
      ? Math.sqrt(Math.max(0, lateralLimit * NUMERICAL_SAFETY) / curvature)
      : Number.POSITIVE_INFINITY;
  });
  const startVelocity = input.path.waypoints[0]?.stop
    ? 0
    : Math.min(profile.points[0].velocity, Math.max(0, input.path.startVel || 0));
  const goalVelocity = input.path.waypoints.at(-1)?.stop
    ? 0
    : Math.min(profile.points.at(-1)!.velocity, Math.max(0, input.path.goalVel || 0));
  const angularIntervalVelocityLimits = samples.slice(1).map((sample, index) => {
    const before = samples[index];
    const distance = sample.s - before.s;
    const stationaryTurnBoundary = isStationaryHeadingTransition(
      input.path,
      state.points[index + 1],
      state.points[index + 2]?.headingRad,
    );
    if (stationaryTurnBoundary
      || trackedHeadingIntervals[index]
      || distance <= EPSILON) return Number.POSITIVE_INFINITY;
    const headingDelta = state.points[index + 1].headingRad - state.points[index].headingRad;
    const headingRatePerM = Math.abs(headingDelta / distance);
    return angularVelocityLimitForInterval(input, ranges, before.f, sample.f)
      / Math.max(headingRatePerM, EPSILON)
      * NUMERICAL_SAFETY;
  });
  const angularAccelerationConstraints = state.points.slice(1).map((point, index): AffineScalarAccelerationConstraint[] => {
    const before = state.points[index];
    const stationaryTurnBoundary = (candidate: typeof point) => (
      isStationaryHeadingTransition(
        input.path,
        candidate,
        state.points[candidate.sourceIndex + 1]?.headingRad,
      )
    );
    if (stationaryTurnBoundary(before)
      || stationaryTurnBoundary(point)
      || trackedHeadingIntervals[index]) return [];
    const midpoint = interpolatePathPoint(before, point);
    const limits = angularAccelerationLimitsForInterval(input, ranges, before.f, point.f);
    const direction = Math.sign(midpoint.headingDerivativeRadPerM);
    if (direction === 0) {
      return [{
        u: 0,
        x: midpoint.headingSecondDerivativeRadPerM2,
        minimum: -limits.acceleration * ANGULAR_ACCELERATION_SAFETY,
        maximum: limits.acceleration * ANGULAR_ACCELERATION_SAFETY,
        label: "angular-acceleration",
      }];
    }
    return [{
      u: direction * midpoint.headingDerivativeRadPerM,
      x: direction * midpoint.headingSecondDerivativeRadPerM2,
      minimum: -limits.deceleration * ANGULAR_ACCELERATION_SAFETY,
      maximum: limits.acceleration * ANGULAR_ACCELERATION_SAFETY,
      label: "angular-acceleration",
    }];
  });
  return {
    positions: samples.map((sample) => sample.s),
    velocityLimits: samples.map((_, index) => Math.min(
      profile.points[index].velocity,
      profile.intervals[index - 1]?.velocity ?? Number.POSITIVE_INFINITY,
      profile.intervals[index]?.velocity ?? Number.POSITIVE_INFINITY,
      drivetrain.pointVelocityLimits[index] * NUMERICAL_SAFETY,
      (drivetrain.intervalVelocityLimits[index - 1] ?? Number.POSITIVE_INFINITY) * NUMERICAL_SAFETY,
      (drivetrain.intervalVelocityLimits[index] ?? Number.POSITIVE_INFINITY) * NUMERICAL_SAFETY,
      curvatureVelocityLimits[index],
      intervalCurvatureVelocityLimits[index - 1] ?? Number.POSITIVE_INFINITY,
      intervalCurvatureVelocityLimits[index] ?? Number.POSITIVE_INFINITY,
      angularIntervalVelocityLimits[index - 1] ?? Number.POSITIVE_INFINITY,
      angularIntervalVelocityLimits[index] ?? Number.POSITIVE_INFINITY,
      state.points[index].stop ? 0 : Number.POSITIVE_INFINITY,
    )),
    // Keep the rounded trajectory inside the independently checked authored
    // envelope without weakening the limits used by final validation.
    accelerationLimits: profile.intervals.map((limits) => limits.acceleration * NUMERICAL_SAFETY),
    decelerationLimits: profile.intervals.map((limits) => limits.deceleration * NUMERICAL_SAFETY),
    freeSpeeds: profile.intervals.map((limits) => limits.freeSpeed),
    motorAccelerationLimits: profile.intervals.map((limits) => limits.motorAcceleration),
    accelerationConstraints: drivetrain.intervalAccelerationConstraints,
    scalarAccelerationConstraints: angularAccelerationConstraints,
    startVelocity,
    goalVelocity,
  };
}

export function countLinearConstraintViolations(input: PlannerInput, samples: readonly TrajectorySample[]): number {
  const profile = buildLinearConstraintProfile(input, samples);
  let violations = 0;
  samples.forEach((sample, index) => {
    const pointVelocityTolerance = Math.max(1e-4, profile.points[index].velocity * 1e-4);
    if (sample.velocityMps > profile.points[index].velocity + pointVelocityTolerance) violations += 1;
    if (index === 0) return;

    const previous = samples[index - 1];
    const interval = profile.intervals[index - 1];
    const intervalVelocityTolerance = Math.max(1e-4, interval.velocity * 1e-4);
    if (Math.max(previous.velocityMps, sample.velocityMps) > interval.velocity + intervalVelocityTolerance) violations += 1;
    const distance = sample.s - previous.s;
    if (distance <= EPSILON) return;
    const acceleration = (sample.velocityMps ** 2 - previous.velocityMps ** 2) / (2 * distance);
    const limit = acceleration >= 0
      ? Math.min(
          interval.acceleration,
          interval.motorAcceleration * Math.max(0, Math.min(
            1,
            1 - Math.max(previous.velocityMps, sample.velocityMps) / interval.freeSpeed,
          )),
        )
      : interval.deceleration;
    if (Math.abs(acceleration) > limit + Math.max(1e-3, limit * 1e-3)) violations += 1;
  });
  return violations;
}
