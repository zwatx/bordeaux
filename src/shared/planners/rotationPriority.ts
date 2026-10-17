import { wrapRadians } from "../math/angles";
import { orderedWaypointSampleIndices } from "./waypointSamples";
import type { ConstraintRange, PathDoc, PlannerResult, RobotConfig, TrajectorySample } from "../types";
import { headingTransitionWindows, segmentHeadingLaws, type HeadingTransitionWindow } from "./headingTransitions";
import { evaluateDrivetrainForces, evaluateDrivetrainKinematics } from "./drivetrainProjection";
import { MAX_TRAJECTORY_SAMPLES } from "./limits";
import { buildCanonicalPathState, interpolatePathPoint, type CanonicalPathPoint } from "./pathState";

const EPSILON = 1e-9;
const DEG = Math.PI / 180;
const TRACKING_RATE_SAFETY = 0.995;

export type EffectiveRange = ConstraintRange & { start: number; end: number };

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}



function smootherStep(value: number): number {
  const t = clamp(value, 0, 1);
  return t ** 3 * (t * (t * 6 - 15) + 10);
}

function waypointFractions(path: PathDoc, samples: readonly TrajectorySample[], indices?: readonly number[]): number[] {
  return (indices ?? orderedWaypointSampleIndices(path.waypoints, samples)).map((index) => samples[index]?.f ?? 0);
}

export function effectiveRanges(path: PathDoc, samples: readonly TrajectorySample[], totalDistance: number, indices?: readonly number[]): EffectiveRange[] {
  // Fraction and distance ranges do not depend on waypoint arrivals. Dense
  // optimizer validation resolves them repeatedly, often with no ranges at all.
  let waypointF: number[] | undefined;
  return (path.ranges ?? []).map((range) => {
    let start = range.f0;
    let end = range.f1;
    if (range.anchor === "dist") {
      start = (range.d0 ?? range.f0 * totalDistance) / Math.max(totalDistance, EPSILON);
      end = (range.d1 ?? range.f1 * totalDistance) / Math.max(totalDistance, EPSILON);
    } else if (range.anchor === "wp") {
      waypointF ??= waypointFractions(path, samples, indices);
      const fractions = waypointF;
      const localFraction = (segmentValue: number | undefined, local: number | undefined, fallback: number) => {
        if (local == null) return fractions[clamp(Math.round(segmentValue ?? fallback), 0, fractions.length - 1)] ?? 0;
        const segment = clamp(Math.round(segmentValue ?? 0), 0, Math.max(0, fractions.length - 2));
        return (fractions[segment] ?? 0) + ((fractions[segment + 1] ?? 1) - (fractions[segment] ?? 0)) * clamp(local, 0, 1);
      };
      start = localFraction(range.w0, range.t0, 0);
      end = localFraction(range.w1, range.t1, fractions.length - 1);
    }
    return { ...range, start: clamp(Math.min(start, end), 0, 1), end: clamp(Math.max(start, end), 0, 1) };
  });
}

export function activeRanges(ranges: readonly EffectiveRange[], fraction: number): EffectiveRange[] {
  return ranges.filter((range) => fraction >= range.start - EPSILON && fraction <= range.end + EPSILON);
}

function rotationPriorityForInterval(
  ranges: readonly EffectiveRange[],
  transitions: readonly HeadingTransitionWindow[],
  before: number,
  after: number,
): "heading" | "translation" | null {
  const start = Math.min(before, after);
  const end = Math.max(before, after);
  const overlapsInterior = (candidateStart: number, candidateEnd: number) => (
    Math.min(end, candidateEnd) - Math.max(start, candidateStart) > EPSILON
  );
  const active = ranges.filter((range) => overlapsInterior(range.start, range.end));
  const activeTransitions = transitions.filter((transition) => (
    overlapsInterior(transition.start, transition.end)
  ));
  if (active.length + activeTransitions.length === 0) return null;
  return active.every((range) => range.rotationPriority === "translation")
    && activeTransitions.every((transition) => transition.rotationPriority === "translation")
    ? "translation"
    : "heading";
}

function headingTransitionForInterval(
  transitions: readonly HeadingTransitionWindow[],
  before: number,
  after: number,
): HeadingTransitionWindow | undefined {
  const start = Math.min(before, after);
  const end = Math.max(before, after);
  return transitions.find((transition) => (
    Math.min(end, transition.end) - Math.max(start, transition.start) > EPSILON
  ));
}

function translationHasPriorityForInterval(
  ranges: readonly EffectiveRange[],
  transitions: readonly HeadingTransitionWindow[],
  before: number,
  after: number,
): boolean {
  return rotationPriorityForInterval(ranges, transitions, before, after) === "translation";
}

export function translationPriorityStartIndex(
  path: PathDoc,
  samples: readonly TrajectorySample[],
  totalDistanceM: number,
): number | null {
  const ranges = effectiveRanges(path, samples, totalDistanceM);
  const waypointF = waypointFractions(path, samples);
  const laws = segmentHeadingLaws(path, false);
  const breaks = path.waypoints.slice(0, -1).map((waypoint) => Boolean(waypoint.turnInPlace));
  const transitions = headingTransitionWindows(path.waypoints, laws, breaks, waypointF, totalDistanceM);
  for (let index = 1; index < samples.length; index += 1) {
    if (translationHasPriorityForInterval(
      ranges,
      transitions,
      samples[index - 1].f,
      samples[index].f,
    )) return index;
  }
  return null;
}

export function translationPriorityIntervalMask(
  path: PathDoc,
  samples: readonly TrajectorySample[],
  totalDistanceM: number,
): boolean[] {
  const ranges = effectiveRanges(path, samples, totalDistanceM);
  const waypointF = waypointFractions(path, samples);
  const laws = segmentHeadingLaws(path, false);
  const breaks = path.waypoints.slice(0, -1).map((waypoint) => Boolean(waypoint.turnInPlace));
  const transitions = headingTransitionWindows(path.waypoints, laws, breaks, waypointF, totalDistanceM);
  return samples.slice(1).map((sample, index) => {
    const before = samples[index].f;
    const priority = rotationPriorityForInterval(ranges, transitions, before, sample.f);
    return priority === "translation";
  });
}

export function headingTransitionIntervalMask(
  path: PathDoc,
  samples: readonly TrajectorySample[],
  totalDistanceM: number,
): boolean[] {
  const waypointF = waypointFractions(path, samples);
  const laws = segmentHeadingLaws(path, false);
  const breaks = path.waypoints.slice(0, -1).map((waypoint) => Boolean(waypoint.turnInPlace));
  const transitions = headingTransitionWindows(path.waypoints, laws, breaks, waypointF, totalDistanceM);
  return samples.slice(1).map((sample, index) => Boolean(headingTransitionForInterval(
    transitions,
    samples[index].f,
    sample.f,
  )));
}

export function rotationPriorityRecoveryIntervalMask(
  path: PathDoc,
  samples: readonly TrajectorySample[],
  totalDistanceM: number,
): boolean[] {
  const ranges = effectiveRanges(path, samples, totalDistanceM);
  const waypointF = waypointFractions(path, samples);
  const laws = segmentHeadingLaws(path, false);
  const breaks = path.waypoints.slice(0, -1).map((waypoint) => Boolean(waypoint.turnInPlace));
  const transitions = headingTransitionWindows(path.waypoints, laws, breaks, waypointF, totalDistanceM);
  const priorities = samples.slice(1).map((sample, index) => (
    rotationPriorityForInterval(ranges, transitions, samples[index].f, sample.f)
  ));
  const recovery = priorities.map(() => false);
  for (let runStart = 0; runStart < priorities.length;) {
    while (runStart < priorities.length && priorities[runStart] !== "translation") runStart += 1;
    if (runStart >= priorities.length) break;
    let runEnd = runStart;
    while (priorities[runEnd + 1] === "translation") runEnd += 1;
    const after = runEnd + 1;
    if (priorities[after] === "heading") {
      for (let index = runStart; index < priorities.length && priorities[index] !== null; index += 1) {
        recovery[index] = true;
      }
    } else if (after < priorities.length) {
      // Translation priority owns its authored window. If heading still needs
      // time afterward, retime only the remaining motion rather than creating
      // a velocity notch inside the transition or at its waypoint.
      for (let index = after; index < priorities.length; index += 1) {
        if (priorities[index] !== "translation") recovery[index] = true;
      }
    }
    runStart = runEnd + 1;
  }
  return recovery;
}

function angularLimits(path: PathDoc, ranges: readonly EffectiveRange[], fraction: number) {
  let velocity = path.constraints.maxAngVel * DEG;
  let acceleration = path.constraints.maxAngAccel * DEG;
  let deceleration = (path.constraints.maxAngDecel ?? path.constraints.maxAngAccel) * DEG;
  activeRanges(ranges, fraction).forEach((range) => {
    velocity = Math.min(velocity, (range.maxAngVel ?? Infinity) * DEG);
    acceleration = Math.min(acceleration, (range.maxAngAccel ?? Infinity) * DEG);
    deceleration = Math.min(deceleration, (range.maxAngAccel ?? Infinity) * DEG);
  });
  return {
    velocity: Math.max(velocity, EPSILON),
    acceleration: Math.max(acceleration, EPSILON),
    deceleration: Math.max(deceleration, EPSILON),
  };
}

function symmetricLimit(configuredLimit: number, fits: (value: number) => boolean): number {
  const limitForDirection = (direction: -1 | 1) => {
    let low = 0;
    let high = configuredLimit;
    for (let iteration = 0; iteration < 16; iteration += 1) {
      const midpoint = (low + high) * 0.5;
      if (fits(midpoint * direction)) low = midpoint;
      else high = midpoint;
    }
    return low;
  };
  return Math.min(configuredLimit, limitForDirection(-1), limitForDirection(1));
}

function drivetrainAngularVelocityLimit(
  point: CanonicalPathPoint,
  robot: RobotConfig,
  linearVelocityMps: number,
  linearAccelerationMps2: number,
  headingRad: number,
  configuredLimit: number,
): number {
  if (!robot.driveModel || robot.drive === "tank") return configuredLimit;
  const actualPoint = { ...point, headingRad };
  const fits = (angularVelocityRadps: number) => evaluateDrivetrainKinematics(
    actualPoint,
    robot,
    linearVelocityMps,
    linearAccelerationMps2,
    angularVelocityRadps,
    0,
  ).every((module) => (
    module.speedMps <= robot.maxSpeed
  ));
  return symmetricLimit(configuredLimit, fits);
}

function drivetrainForceAngularAccelerationLimits(
  point: CanonicalPathPoint,
  robot: RobotConfig,
  linearVelocityMps: number,
  linearAccelerationMps2: number,
  angularVelocityRadps: number,
  headingRad: number,
  configuredLimit: number,
): { positive: number; negative: number } {
  if (!robot.driveModel || robot.drive === "tank") return { positive: configuredLimit, negative: configuredLimit };
  const actualPoint = { ...point, headingRad };
  const fits = (angularAccelerationRadps2: number) => evaluateDrivetrainForces(
    actualPoint,
    robot,
    linearVelocityMps,
    linearAccelerationMps2,
    angularVelocityRadps,
    angularAccelerationRadps2,
  ).every((module) => (
    module.requiredForceN <= module.tractionForceLimitN
    && module.requiredMotorForceN <= module.motorForceLimitN
  ));
  const solve = (direction: -1 | 1) => {
    let low = 0;
    let high = configuredLimit;
    for (let iteration = 0; iteration < 16; iteration += 1) {
      const midpoint = (low + high) * 0.5;
      if (fits(midpoint * direction)) low = midpoint;
      else high = midpoint;
    }
    return low;
  };
  return { positive: solve(1), negative: solve(-1) };
}

function intervalAngularLimits(path: PathDoc, ranges: readonly EffectiveRange[], before: number, after: number) {
  const overlapping = ranges.filter((range) => Math.min(after, range.end) >= Math.max(before, range.start) - EPSILON);
  const first = angularLimits(path, overlapping.map((range) => ({ ...range, start: before, end: after })), before);
  const second = angularLimits(path, overlapping.map((range) => ({ ...range, start: before, end: after })), after);
  return {
    velocity: Math.min(first.velocity, second.velocity),
    acceleration: Math.min(first.acceleration, second.acceleration),
    deceleration: Math.min(first.deceleration, second.deceleration),
  };
}

type TrackingAngularLimits = ReturnType<typeof angularLimits> & {
  positiveAcceleration?: number;
  negativeAcceleration?: number;
};

function directionalRateLimit(limits: TrackingAngularLimits, delta: number): number {
  return delta >= 0
    ? limits.positiveAcceleration ?? Number.POSITIVE_INFINITY
    : limits.negativeAcceleration ?? Number.POSITIVE_INFINITY;
}

function slewOmega(omega: number, target: number, limits: TrackingAngularLimits, dt: number): number {
  const reversing = Math.sign(target) !== 0 && Math.sign(omega) !== 0 && Math.sign(target) !== Math.sign(omega);
  const increasing = Math.sign(target) === Math.sign(omega) && Math.abs(target) > Math.abs(omega);
  const authoredRate = reversing
    ? Math.min(limits.acceleration, limits.deceleration)
    : increasing ? limits.acceleration : limits.deceleration;
  const rate = Math.min(authoredRate, directionalRateLimit(limits, target - omega)) * TRACKING_RATE_SAFETY;
  return omega + clamp(target - omega, -rate * dt, rate * dt);
}

function matchingEndpointOmega(
  heading: number,
  omega: number,
  targetHeading: number,
  targetOmega: number,
  limits: TrackingAngularLimits,
  dt: number,
  accelerationDt: number,
  mustMatchHere: boolean,
): number | null {
  if (dt <= EPSILON) return null;
  const candidate = (targetHeading - heading) / dt;
  if (Math.abs(candidate) > limits.velocity + EPSILON) return null;
  const releaseOmega = mustMatchHere ? candidate : targetOmega;
  if (!mustMatchHere && Math.abs(candidate - targetOmega) > 0.5 * DEG) return null;
  return Math.abs(slewOmega(omega, releaseOmega, limits, accelerationDt) - releaseOmega) <= EPSILON
    ? releaseOmega
    : null;
}

function trackedStep(
  actual: number,
  omega: number,
  desiredNow: number,
  limits: TrackingAngularLimits,
  dt: number,
  brakingDt = dt,
  desiredPrevious = desiredNow,
  accelerationDt = dt,
): { actual: number; omega: number } {
  const desiredOmega = (desiredNow - desiredPrevious) / dt;
  const error = desiredPrevious - actual;
  // A pure error/dt target keeps accelerating until the heading is reached,
  // which carries angular momentum through the target and creates a visible
  // overshoot/reversal. Cap the catch-up component by the speed that can
  // still brake inside the remaining error, including a one-tick margin for
  // the fixed-period integration used by the planners.
  const brakingRate = Math.min(
    limits.deceleration,
    directionalRateLimit(limits, -Math.sign(error || omega || 1)),
  );
  const brakingOmega = Math.max(0, Math.sqrt(2 * brakingRate * Math.abs(error)) - brakingRate * brakingDt);
  let catchupOmega = Math.sign(error) * Math.min(limits.velocity, brakingOmega);
  // Inside one discrete braking step, approach half the remaining error. This
  // converges without the nonzero-speed snap that previously crossed the
  // target and forced a whole-path timing slowdown.
  if (Math.abs(catchupOmega) <= EPSILON && Math.abs(error) > EPSILON) {
    catchupOmega = clamp(error / (2 * dt), -limits.velocity, limits.velocity);
  }
  // Trajectory samples store the average angular velocity for the interval
  // ending at that sample. Slew that interval value, then integrate it directly
  // so heading, force evaluation, playback, and export all share one trace.
  const targetEndpointOmega = clamp(desiredOmega + catchupOmega, -limits.velocity, limits.velocity);
  const nextOmega = slewOmega(omega, targetEndpointOmega, limits, accelerationDt);
  return { actual: actual + nextOmega * dt, omega: nextOmega };
}

function samplePeriod(samples: readonly TrajectorySample[]): number {
  let best = Infinity;
  for (let index = 1; index < samples.length; index += 1) {
    const dt = samples[index].t - samples[index - 1].t;
    if (dt > EPSILON) best = Math.min(best, dt);
  }
  return Number.isFinite(best) ? Math.max(0.01, Math.min(0.05, best)) : 0.02;
}

function hasAngularViolation(path: PathDoc, ranges: readonly EffectiveRange[], samples: readonly TrajectorySample[]): boolean {
  let previousAcceleration: number | undefined;
  let previousIntervalS: number | undefined;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const limits = index === 0
      ? angularLimits(path, ranges, sample.f)
      : intervalAngularLimits(path, ranges, samples[index - 1].f, sample.f);
    if (Math.abs(sample.angularVelocityRadps) > limits.velocity * 1.02) return true;
    if (index === 0) continue;
    const previous = samples[index - 1];
    const dt = sample.t - previous.t;
    if (dt <= EPSILON) continue;
    // Exported angular velocities are timestamped at their samples, not at
    // interval midpoints. Their signed difference uses the full sample period.
    const signedAcceleration = (sample.angularVelocityRadps - previous.angularVelocityRadps) / dt;
    const reversing = Math.sign(sample.angularVelocityRadps) !== 0
      && Math.sign(previous.angularVelocityRadps) !== 0
      && Math.sign(sample.angularVelocityRadps) !== Math.sign(previous.angularVelocityRadps);
    const limit = reversing
      ? Math.min(limits.acceleration, limits.deceleration)
      : Math.abs(sample.angularVelocityRadps) > Math.abs(previous.angularVelocityRadps)
        ? limits.acceleration
        : limits.deceleration;
    if (Math.abs(signedAcceleration) > limit * 1.02) return true;
    if (previousAcceleration !== undefined && (path.constraints.maxAngJerk ?? 0) > 0) {
      const jerk = Math.abs(signedAcceleration - previousAcceleration)
        / Math.max(EPSILON, (dt + (previousIntervalS ?? dt)) * 0.5);
      if (jerk > path.constraints.maxAngJerk! * DEG * 1.02) return true;
    }
    previousAcceleration = signedAcceleration;
    previousIntervalS = dt;
  }
  return false;
}

/** Tracks heading causally under the coupled drivetrain limits. */
export function applyRotationPriority(path: PathDoc, result: PlannerResult, robot: RobotConfig): PlannerResult {
  if (result.samples.length < 2) return result;
  const ranges = effectiveRanges(path, result.samples, result.totalDistanceM, result.waypointSampleIndices);
  const waypointF = waypointFractions(path, result.samples, result.waypointSampleIndices);
  const laws = segmentHeadingLaws(path, false);
  const breaks = path.waypoints.slice(0, -1).map((waypoint) => Boolean(waypoint.turnInPlace));
  const transitions = headingTransitionWindows(path.waypoints, laws, breaks, waypointF, result.totalDistanceM);
  // Automatic heading transitions are already part of the reachability solve.
  // Returning that jointly optimized trace avoids a second causal controller
  // that could lag the law, manufacture a stop, or chase only the segment end.
  if (transitions.length > 0) return result;
  if (!ranges.some((range) => range.rotationPriority === "translation")
    && transitions.length === 0) {
    // Authored turn-in-place actions own the stopped heading discontinuity and
    // are expanded and validated after moving-path planning.
    if (path.waypoints.some((waypoint) => waypoint.turnInPlace)) return result;
    if (!hasAngularViolation(path, ranges, result.samples)) return result;
    return {
      ...result,
      diagnostics: [...result.diagnostics, {
        severity: "error",
        path: `paths.${path.name}.waypoints`,
        message: "Heading tracking could not satisfy the configured angular limits",
      }],
    };
  }
  if (robot.drive === "tank") {
    return {
      ...result,
      diagnostics: [...result.diagnostics, {
        severity: "error",
        path: `paths.${path.name}.waypoints`,
        message: "Independent heading tracking requires a swerve drivetrain",
      }],
    };
  }

  const desired: number[] = [];
  result.samples.forEach((sample, index) => {
    desired.push(index === 0
      ? sample.headingRad
      : desired[index - 1] + wrapRadians(sample.headingRad - desired[index - 1]));
  });
  const samples = result.samples.map((sample) => ({ ...sample }));
  const transitionByInterval = samples.slice(1).map((sample, index) => (
    headingTransitionForInterval(transitions, samples[index].f, sample.f)
  ));
  const transitionStartIndex = new Map<number, number>();
  const transitionEndIndex = new Map<number, number>();
  transitionByInterval.forEach((transition, index) => {
    if (!transition) return;
    if (!transitionStartIndex.has(transition.waypointIndex)) {
      transitionStartIndex.set(transition.waypointIndex, index);
    }
    transitionEndIndex.set(transition.waypointIndex, index + 1);
  });
  const transitionReferenceKnots = new Map<number, { index: number; heading: number }[]>();
  const transitionHardKnotIndices = new Map<number, Set<number>>();
  let missedHeadingPriority = false;
  transitions.forEach((transition) => {
    const startIndex = transitionStartIndex.get(transition.waypointIndex);
    const endIndex = transitionEndIndex.get(transition.waypointIndex);
    if (startIndex == null || endIndex == null) return;
    const outgoingStart = waypointF[transition.waypointIndex] ?? transition.start;
    const outgoingLaw = laws[transition.waypointIndex];
    const targetKnots = (outgoingLaw === "targets" ? path.targets ?? [] : []).map((target) => {
      const fraction = target.anchor === "dist"
        ? (target.d ?? target.f * result.totalDistanceM) / Math.max(result.totalDistanceM, EPSILON)
        : target.f;
      return { fraction: clamp(fraction, 0, 1), heading: target.deg * DEG };
    }).filter((target) => (
      target.fraction > outgoingStart + EPSILON
      && target.fraction < transition.end - EPSILON
    )).sort((first, second) => first.fraction - second.fraction);
    const knots = [{ index: startIndex, heading: desired[startIndex] }];
    if (outgoingLaw === "tangent" || outgoingLaw.startsWith("lookAt:")) {
      for (let index = startIndex + 1; index <= endIndex; index += 1) {
        const previous = knots.at(-1)!;
        knots.push({
          index,
          heading: previous.heading + wrapRadians(desired[index] - previous.heading),
        });
      }
      transitionReferenceKnots.set(transition.waypointIndex, knots);
      transitionHardKnotIndices.set(
        transition.waypointIndex,
        outgoingLaw.startsWith("lookAt:")
          ? new Set(knots.slice(1).map((knot) => knot.index))
          : new Set([endIndex]),
      );
      return;
    }
    targetKnots.forEach((target) => {
      let index = startIndex;
      for (let candidate = startIndex + 1; candidate <= endIndex; candidate += 1) {
        if (Math.abs(samples[candidate].f - target.fraction) < Math.abs(samples[index].f - target.fraction)) {
          index = candidate;
        }
      }
      const previous = knots.at(-1)!;
      const heading = previous.heading + wrapRadians(target.heading - previous.heading);
      if (index === previous.index) {
        if (Math.abs(wrapRadians(heading - previous.heading)) > 0.05 * DEG) {
          missedHeadingPriority = true;
        } else previous.heading = heading;
      }
      else knots.push({ index, heading });
    });
    const previous = knots.at(-1)!;
    const outgoingEndIndex = endIndex;
    const endHeading = previous.heading + wrapRadians(desired[outgoingEndIndex] - previous.heading);
    if (endIndex === previous.index) {
      if (Math.abs(wrapRadians(endHeading - previous.heading)) > 0.05 * DEG) {
        missedHeadingPriority = true;
      } else previous.heading = endHeading;
    }
    else knots.push({ index: endIndex, heading: endHeading });
    transitionReferenceKnots.set(transition.waypointIndex, knots);
    transitionHardKnotIndices.set(
      transition.waypointIndex,
      new Set(knots.slice(1).map((knot) => knot.index)),
    );
  });
  const transitionReferenceHeading = (transition: HeadingTransitionWindow, sampleIndex: number) => {
    const knots = transitionReferenceKnots.get(transition.waypointIndex);
    if (!knots?.length) return desired[sampleIndex];
    let start = knots[0];
    let end = knots.at(-1)!;
    for (let index = 1; index < knots.length; index += 1) {
      if (sampleIndex <= knots[index].index) {
        start = knots[index - 1];
        end = knots[index];
        break;
      }
    }
    const startTime = samples[start.index].t;
    const endTime = samples[end.index].t;
    const progress = endTime > startTime + EPSILON
      ? (samples[sampleIndex].t - startTime) / (endTime - startTime)
      : 1;
    // Translation priority is time-optimal for travel: pursue the next heading
    // knot immediately and let the physical slew/force limits decide how much
    // rotation fits while moving. Heading priority keeps its authored schedule.
    const scheduledProgress = transition.rotationPriority === "translation" ? 1 : smootherStep(progress);
    return start.heading + wrapRadians(end.heading - start.heading) * scheduledProgress;
  };
  const pathState = buildCanonicalPathState(path, samples);
  let following = false;
  let resetAtRangeEnd = false;
  let actual = desired[0];
  let omega = 0;

  samples[0].headingRad = actual;
  samples[0].angularVelocityRadps = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const dt = samples[index].t - samples[index - 1].t;
    const priorityHere = rotationPriorityForInterval(
      ranges,
      transitions,
      samples[index - 1].f,
      samples[index].f,
    );
    const transitionHere = transitionByInterval[index - 1];
    const transitionEnd = transitionHere
      ? transitionEndIndex.get(transitionHere.waypointIndex) ?? index
      : index;
    const transitionEndsHere = Boolean(transitionHere && transitionEnd === index);
    const transitionKnotHere = Boolean(transitionHere
      && transitionHardKnotIndices.get(transitionHere.waypointIndex)?.has(index));
    if (transitionHere || priorityHere === "translation") {
      following = true;
      resetAtRangeEnd = true;
    }
    const transitionHeadingMustMatch = Boolean(transitionHere && (transitionEndsHere || transitionKnotHere));
    const headingRangeMustMatch = !transitionHere && priorityHere === "heading" && following;
    const mayRejoin = transitionHere
      ? transitionEndsHere || transitionKnotHere
      : following && priorityHere !== "translation" && resetAtRangeEnd;
    if (!following || dt <= EPSILON) {
      actual = desired[index];
      omega = samples[index].angularVelocityRadps;
      continue;
    }

    const authoredLimits = intervalAngularLimits(path, ranges, samples[index - 1].f, samples[index].f);
    const distance = samples[index].s - samples[index - 1].s;
    const intervalLinearAcceleration = distance > EPSILON
      ? (samples[index].velocityMps ** 2 - samples[index - 1].velocityMps ** 2) / (2 * distance)
      : 0;
    const intervalLinearVelocity = Math.sqrt(Math.max(0,
      (samples[index].velocityMps ** 2 + samples[index - 1].velocityMps ** 2) * 0.5,
    ));
    const intervalPoint = interpolatePathPoint(pathState.points[index - 1], pathState.points[index]);
    const angularAccelerationLimits = drivetrainForceAngularAccelerationLimits(
      intervalPoint,
      robot,
      intervalLinearVelocity,
      intervalLinearAcceleration,
      omega,
      actual,
      Math.max(authoredLimits.acceleration, authoredLimits.deceleration),
    );
    const limits = {
      ...authoredLimits,
      velocity: drivetrainAngularVelocityLimit(
        intervalPoint,
        robot,
        Math.max(Math.abs(samples[index - 1].velocityMps), Math.abs(samples[index].velocityMps)),
        intervalLinearAcceleration,
        actual,
        authoredLimits.velocity,
      ),
      positiveAcceleration: angularAccelerationLimits.positive,
      negativeAcceleration: angularAccelerationLimits.negative,
    };
    const previousDt = index > 1 ? samples[index - 1].t - samples[index - 2].t : dt;
    const accelerationDt = index === 1 ? dt * 0.5 : (previousDt + dt) * 0.5;
    const targetHeading = transitionHere
      ? transitionReferenceHeading(transitionHere, index)
      : desired[index];
    const targetPreviousHeading = transitionHere
      ? transitionReferenceHeading(transitionHere, index - 1)
      : desired[index - 1];
    const targetOmega = result.samples[index].angularVelocityRadps;
    const matchingOmega = mayRejoin
      ? matchingEndpointOmega(
          actual,
          omega,
          targetHeading,
          targetOmega,
          limits,
          dt,
          accelerationDt,
          transitionHeadingMustMatch || headingRangeMustMatch,
        )
      : null;
    if (matchingOmega !== null) {
      actual = targetHeading;
      omega = matchingOmega;
      if (!transitionHere || transitionEndsHere) {
        following = false;
        resetAtRangeEnd = false;
      }
    } else {
      const nextDt = index + 1 < samples.length ? samples[index + 1].t - samples[index].t : dt;
      ({ actual, omega } = trackedStep(
        actual,
        omega,
        targetHeading,
        limits,
        dt,
        Math.max(dt, nextDt),
        targetPreviousHeading,
        accelerationDt,
      ));
      if ((transitionHeadingMustMatch || headingRangeMustMatch) && (
        Math.abs(targetHeading - actual) > 0.05 * DEG
        || (headingRangeMustMatch && Math.abs(targetOmega - omega) > 0.5 * DEG)
      )) missedHeadingPriority = true;
      if (transitionEndsHere
        && transitionHeadingMustMatch
        && Math.abs(targetHeading - actual) <= 0.05 * DEG) {
        following = false;
        resetAtRangeEnd = false;
      }
    }

    samples[index].headingRad = actual;
    samples[index].angularVelocityRadps = omega;
  }

  const diagnostics = [...result.diagnostics];
  if (missedHeadingPriority) {
    diagnostics.push({
      severity: "error",
      path: `paths.${path.name}.waypoints`,
      message: "The coupled trajectory could not meet the authored heading within the available motion",
    });
  }
  const target = desired.at(-1)!;
  const last = samples.at(-1)!;
  const needsHeadingReacquisition = following
    || missedHeadingPriority
    || Math.abs(target - actual) > 0.05 * DEG;
  const needsCatchup = needsHeadingReacquisition || Math.abs(omega) > 0.05 * DEG;
  const endpointHasTranslationPriority = rotationPriorityForInterval(
    ranges,
    transitions,
    samples.at(-2)!.f,
    last.f,
  ) === "translation";
  // A translation-priority transition owns translational timing. Settle any
  // residual heading after a stopped endpoint instead of stretching the moving
  // profile to reacquire it.
  // A stopped endpoint may use a short physical settle for residual angular
  // velocity. The coupled planner then retimes the moving portion when that
  // reduces total completion time; this is independent of removed legacy
  // priority metadata.
  const transitionAllowsTerminalCatchup = !missedHeadingPriority && transitions.length > 0;
  const translationPriorityAllowsCatchup = endpointHasTranslationPriority || transitionAllowsTerminalCatchup;
  if (needsCatchup
    && translationPriorityAllowsCatchup
    && Math.abs(last.velocityMps) <= 1e-3
    && !path.waypoints.at(-1)?.turnInPlace) {
    const period = samplePeriod(samples);
    const point = pathState.points.at(-1)!;
    while (Math.abs(target - actual) > 0.05 * DEG || Math.abs(omega) > 0.05 * DEG) {
      if (samples.length >= MAX_TRAJECTORY_SAMPLES) {
        throw new Error(`Heading catch-up requires more than ${MAX_TRAJECTORY_SAMPLES} samples`);
      }
      const authoredLimits = angularLimits(path, ranges, 1);
      const accelerationLimits = drivetrainForceAngularAccelerationLimits(
        point, robot, 0, 0, omega, actual,
        Math.max(authoredLimits.acceleration, authoredLimits.deceleration),
      );
      const limits = {
        ...authoredLimits,
        velocity: drivetrainAngularVelocityLimit(point, robot, 0, 0, actual, authoredLimits.velocity),
        positiveAcceleration: accelerationLimits.positive,
        negativeAcceleration: accelerationLimits.negative,
      };
      ({ actual, omega } = trackedStep(actual, omega, target, limits, period));
      samples.push({
        ...samples.at(-1)!,
        i: samples.length,
        t: samples.at(-1)!.t + period,
        headingRad: actual,
        velocityMps: 0,
        accelerationMps2: 0,
        angularVelocityRadps: omega,
      });
    }
  } else if (needsHeadingReacquisition
    && !missedHeadingPriority
    && !transitionAllowsTerminalCatchup
    && !path.waypoints.at(-1)?.turnInPlace) {
    diagnostics.push({
      severity: "error",
      path: `paths.${path.name}.waypoints`,
      message: "The coupled trajectory could not reacquire the authored heading in the available path",
    });
  }

  if (hasAngularViolation(path, ranges, samples)) {
    diagnostics.push({
      severity: "error",
      path: `paths.${path.name}.waypoints`,
      message: "Heading tracking could not satisfy the configured angular limits",
    });
  }

  const finalTime = samples.at(-1)?.t ?? result.totalTimeS;
  return {
    ...result,
    totalTimeS: finalTime,
    samples,
    diagnostics,
    optimization: result.optimization ? { ...result.optimization, totalTimeS: finalTime } : result.optimization,
  };
}
