import type { PlannerInput, TrajectorySample } from "../types";
import { activeRanges, effectiveRanges, type EffectiveRange } from "./rotationPriority";
import { buildLinearConstraintProfile } from "./optimizationConstraints";
import {
  buildCanonicalPathState,
  interpolatePathPoint,
  isStationaryHeadingTransition,
} from "./pathState";
import {
  buildDrivetrainProjection,
  evaluateDrivetrainForces,
  evaluateDrivetrainKinematics,
  evaluateDrivetrainPower,
  projectDrivetrainAtPoint,
} from "./drivetrainProjection";
import { accelerationBoundsForSpeedSquared } from "./reachability";
import { minimumBusVoltage } from "../electricalPower";
import { peakMechanismCurrent, electricalConfigurationError } from "../robotLimits";

const EPSILON = 1e-9;
const DEG = Math.PI / 180;

export type TrajectoryViolationKind =
  | "boundary-velocity"
  | "linear-velocity"
  | "linear-acceleration"
  | "linear-deceleration"
  | "centripetal-acceleration"
  | "angular-velocity"
  | "angular-acceleration"
  | "drivetrain-velocity"
  | "drivetrain-acceleration"
  | "electrical-power";

export interface TrajectoryConstraintViolation {
  kind: TrajectoryViolationKind;
  sampleIndex: number;
  measured: number;
  limit: number;
  message: string;
  refinable: boolean;
}

export interface TrajectoryValidationResult {
  violations: TrajectoryConstraintViolation[];
  refinableIntervals: number[];
  activeConstraints: string[];
  checkedPoints: number;
  angularValidationSkipped: boolean;
}

export interface TrajectoryValidationOptions {
  skipAngular?: boolean;
  skipAngularFromIndex?: number;
  skipAngularIntervals?: readonly boolean[];
  angularKinematics?: "path" | "sample";
}

function tolerance(limit: number, absolute = 1e-3, relative = 2e-3): number {
  return Math.max(absolute, Math.abs(limit) * relative);
}

function angularLimitsAt(input: PlannerInput, ranges: readonly EffectiveRange[], fraction: number) {
  return angularLimitsForRanges(input, activeRanges(ranges, fraction));
}

function angularLimitsForRanges(input: PlannerInput, ranges: readonly EffectiveRange[]) {
  let velocity = input.path.constraints.maxAngVel * DEG;
  let acceleration = input.path.constraints.maxAngAccel * DEG;
  let deceleration = (input.path.constraints.maxAngDecel ?? input.path.constraints.maxAngAccel) * DEG;
  for (const range of ranges) {
    velocity = Math.min(velocity, (range.maxAngVel ?? Infinity) * DEG);
    acceleration = Math.min(acceleration, (range.maxAngAccel ?? Infinity) * DEG);
    deceleration = Math.min(deceleration, (range.maxAngAccel ?? Infinity) * DEG);
  }
  return { velocity, acceleration, deceleration };
}

function angularLimitsForInterval(
  input: PlannerInput,
  ranges: readonly EffectiveRange[],
  before: number,
  after: number,
) {
  const start = Math.min(before, after);
  const end = Math.max(before, after);
  return angularLimitsForRanges(input, ranges.filter((range) => (
    Math.min(end, range.end) - Math.max(start, range.start) > EPSILON
  )));
}

function pushViolation(
  violations: TrajectoryConstraintViolation[],
  kind: TrajectoryViolationKind,
  sampleIndex: number,
  measured: number,
  limit: number,
  refinable: boolean,
  label: string,
): void {
  violations.push({
    kind,
    sampleIndex,
    measured,
    limit,
    refinable,
    message: `${label} is ${measured.toFixed(4)}; limit is ${limit.toFixed(4)} at sample ${sampleIndex}.`,
  });
}

export function validateOptimizedTrajectory(
  input: PlannerInput,
  samples: readonly TrajectorySample[],
  options: TrajectoryValidationOptions = {},
): TrajectoryValidationResult {
  const violations: TrajectoryConstraintViolation[] = [];
  const refinableIntervals = new Set<number>();
  const activeConstraints = new Set<string>();
  const electricalError = electricalConfigurationError(input.robot);
  if (electricalError) violations.push({ kind: 'electrical-power', sampleIndex: 0, measured: 2, limit: 1, refinable: false, message: electricalError });
  if (samples.length < 2) {
    return {
      violations,
      refinableIntervals: [],
      activeConstraints: [],
      checkedPoints: samples.length,
      angularValidationSkipped: Boolean(options.skipAngular || options.skipAngularFromIndex !== undefined || options.skipAngularIntervals?.some(Boolean)),
    };
  }

  const skipAngularIntervals = options.skipAngularIntervals
    ?? samples.slice(1).map((_sample, index) => (
      options.skipAngularFromIndex !== undefined && index + 1 >= options.skipAngularFromIndex
    ));
  const initialHeadingBreaks = new Set<number>();
  for (let index = 1; index < skipAngularIntervals.length; index += 1) {
    if (skipAngularIntervals[index] !== skipAngularIntervals[index - 1]) initialHeadingBreaks.add(index);
  }
  const usesSampleAngularKinematics = options.angularKinematics === "sample";
  const timestampedAngularVelocities = samples.slice(1).map((sample, index) => {
    const before = samples[index];
    const dt = Math.max(EPSILON, sample.t - before.t);
    const headingDelta = Math.atan2(
      Math.sin(sample.headingRad - before.headingRad),
      Math.cos(sample.headingRad - before.headingRad),
    );
    return headingDelta / dt;
  });
  const state = buildCanonicalPathState(
    input.path,
    samples,
    initialHeadingBreaks,
  );
  const linear = buildLinearConstraintProfile(input, samples);
  const lateralLimits = linear.intervals.map((limits) => (
    input.path.constraints.maxCentripetalAccel ?? limits.acceleration
  ));
  const drivetrain = buildDrivetrainProjection(
    state,
    input.robot,
    lateralLimits,
    skipAngularIntervals,
  );
  const ranges = effectiveRanges(input.path, samples, state.totalDistanceM);
  const stationaryTurnBoundary = (index: number) => (
    isStationaryHeadingTransition(input.path, state.points[index], state.points[index + 1]?.headingRad)
  );
  const skipsAngularAt = (index: number) => Boolean(options.skipAngular)
    || Boolean(skipAngularIntervals[index - 1] || skipAngularIntervals[index])
    || stationaryTurnBoundary(index);
  const skipsAngularForInterval = (index: number) => Boolean(options.skipAngular)
    || Boolean(skipAngularIntervals[index])
    || stationaryTurnBoundary(index)
    || stationaryTurnBoundary(index + 1);
  const validateModuleVelocity = (
    point: typeof state.points[number],
    sampleIndex: number,
    speed: number,
    acceleration: number,
    angularVelocity: number,
    angularAcceleration: number,
  ) => {
    for (const module of evaluateDrivetrainKinematics(
      point,
      input.robot,
      speed,
      acceleration,
      angularVelocity,
      angularAcceleration,
    )) {
      if (module.speedMps > input.robot.maxSpeed + tolerance(input.robot.maxSpeed, 1e-3, 0.005)) {
        pushViolation(violations, "drivetrain-velocity", sampleIndex, module.speedMps, input.robot.maxSpeed, true, module.label);
        refinableIntervals.add(Math.max(0, sampleIndex - 1));
      }
      if (module.speedMps >= input.robot.maxSpeed * 0.995) activeConstraints.add(module.label);
    }
  };
  const validateModuleForces = (
    point: typeof state.points[number],
    sampleIndex: number,
    speed: number,
    acceleration: number,
    angularVelocity: number,
    angularAcceleration: number,
  ) => {
    const forces = evaluateDrivetrainForces(
      point,
      input.robot,
      speed,
      acceleration,
      angularVelocity,
      angularAcceleration,
    );
    const power = evaluateDrivetrainPower(point, input.robot, speed, acceleration, angularVelocity, angularAcceleration,
      input.robot.driveModel ? peakMechanismCurrent(input.robot.driveModel) : 0, forces);
    if (power) {
      // All ratios grow above 1 when infeasible, matching the existing local timing repair.
      const utilization = Math.max(power.voltageUtilization, power.currentUtilization,
        minimumBusVoltage(input.robot) / Math.max(0.01, power.busVoltageV));
      if (utilization > 1.01) {
        pushViolation(violations, "electrical-power", sampleIndex, utilization, 1, true, "Shared battery voltage/current demand");
        refinableIntervals.add(Math.max(0, sampleIndex - 1));
      }
    }
    for (const module of forces) {
      // The closed-form allocation is deliberately conservative; a small
      // margin represents force redistribution available to the four modules
      // without masking material wrench infeasibility.
      if (module.requiredForceN > module.tractionForceLimitN + tolerance(module.tractionForceLimitN, 0.05, 0.06)) {
        pushViolation(
          violations,
          "drivetrain-acceleration",
          sampleIndex,
          module.requiredForceN,
          module.tractionForceLimitN,
          true,
          `${module.label} traction force`,
        );
        refinableIntervals.add(Math.max(0, sampleIndex - 1));
      }
      if (module.requiredMotorForceN > module.motorForceLimitN + tolerance(module.motorForceScaleN, 0.05, 0.06)) {
        pushViolation(
          violations,
          "drivetrain-acceleration",
          sampleIndex,
          module.requiredMotorForceN,
          module.motorForceLimitN,
          true,
          `${module.label} motor force`,
        );
        refinableIntervals.add(Math.max(0, sampleIndex - 1));
      }
      if ((module.tractionForceLimitN > EPSILON && module.requiredForceN >= module.tractionForceLimitN * 0.94)
        || (module.motorForceLimitN > EPSILON && module.requiredMotorForceN >= module.motorForceLimitN * 0.94)) {
        activeConstraints.add(`${module.label}-force`);
      }
    }
  };

  const expectedStart = input.path.waypoints[0]?.stop
    ? 0
    : Math.min(linear.points[0].velocity, Math.max(0, input.path.startVel || 0));
  const expectedGoal = input.path.waypoints.at(-1)?.stop
    ? 0
    : Math.min(linear.points.at(-1)!.velocity, Math.max(0, input.path.goalVel || 0));
  for (const [index, expected] of [[0, expectedStart], [samples.length - 1, expectedGoal]] as const) {
    const measured = Math.abs(samples[index].velocityMps);
    if (Math.abs(measured - expected) > tolerance(expected, 2e-4, 2e-4)) {
      pushViolation(violations, "boundary-velocity", index, measured, expected, false, "Boundary velocity");
    }
  }
  samples.forEach((sample, index) => {
    const adjacentVelocity = Math.min(
      linear.intervals[index - 1]?.velocity ?? Number.POSITIVE_INFINITY,
      linear.intervals[index]?.velocity ?? Number.POSITIVE_INFINITY,
    );
    const linearVelocityLimit = Math.min(linear.points[index].velocity, adjacentVelocity);
    const drivetrainVelocityLimit = drivetrain.pointVelocityLimits[index];
    const speed = Math.abs(sample.velocityMps);
    if (speed > linearVelocityLimit + tolerance(linearVelocityLimit, 1e-4, 1e-4)) {
      pushViolation(violations, "linear-velocity", index, speed, linearVelocityLimit, false, "Linear velocity");
    }
    if (!usesSampleAngularKinematics && speed > drivetrainVelocityLimit + tolerance(drivetrainVelocityLimit)) {
      pushViolation(violations, "drivetrain-velocity", index, speed, drivetrainVelocityLimit, true, "Drivetrain velocity");
      refinableIntervals.add(Math.max(0, Math.min(samples.length - 2, index)));
    }
    if (linearVelocityLimit > EPSILON && speed >= linearVelocityLimit * 0.995) activeConstraints.add("linear-velocity");
    if (!usesSampleAngularKinematics
      && drivetrainVelocityLimit > EPSILON
      && speed >= drivetrainVelocityLimit * 0.995) activeConstraints.add("drivetrain-velocity");

    if (!skipsAngularAt(index)) {
      const angular = angularLimitsAt(input, ranges, sample.f);
      const omega = Math.abs(usesSampleAngularKinematics
        ? sample.angularVelocityRadps
        : state.points[index].headingDerivativeRadPerM * speed);
      if (omega > angular.velocity + tolerance(angular.velocity, 2e-3, 0.02)) {
        pushViolation(violations, "angular-velocity", index, omega, angular.velocity, true, "Angular velocity");
      }
      if (angular.velocity > EPSILON && omega >= angular.velocity * 0.995) activeConstraints.add("angular-velocity");
    }
  });

  for (let index = 0; index < samples.length - 1; index += 1) {
    const before = samples[index];
    const after = samples[index + 1];
    const distance = after.s - before.s;
    // Check exported feedforward as well as geometry-derived interval motion.
    // Both traces must honor signed acceleration/deceleration through reversals.
    if (usesSampleAngularKinematics && !skipsAngularForInterval(index) && after.t > before.t + EPSILON) {
      const angular = angularLimitsForInterval(input, ranges, before.f, after.f);
      const previous = before.angularVelocityRadps;
      const current = after.angularVelocityRadps;
      const reversing = previous * current < 0;
      const limit = reversing ? Math.min(angular.acceleration, angular.deceleration)
        : Math.abs(current) > Math.abs(previous) ? angular.acceleration : angular.deceleration;
      const measured = Math.abs(current - previous) / (after.t - before.t);
      if (measured > limit * 1.02 + EPSILON) {
        pushViolation(violations, "angular-acceleration", index + 1, measured, limit, true, "Sample angular acceleration");
        refinableIntervals.add(index);
      }
    }
    if (distance <= EPSILON) {
      if (!usesSampleAngularKinematics || skipsAngularForInterval(index)) continue;
      const intervalDt = after.t - before.t;
      if (intervalDt <= EPSILON) continue;
      const point = interpolatePathPoint(state.points[index], state.points[index + 1]);
      const angularVelocity = timestampedAngularVelocities[index];
      const previousAngularVelocity = index === 0
        ? before.angularVelocityRadps
        : timestampedAngularVelocities[index - 1];
      const previousDt = index === 0 ? intervalDt : before.t - samples[index - 1].t;
      const accelerationDt = index === 0 ? intervalDt * 0.5 : (previousDt + intervalDt) * 0.5;
      const angularAcceleration = (angularVelocity - previousAngularVelocity) / Math.max(EPSILON, accelerationDt);
      const angular = angularLimitsAt(input, ranges, (before.f + after.f) * 0.5);
      if (Math.abs(angularVelocity) > angular.velocity + tolerance(angular.velocity, 2e-3, 0.02)) {
        pushViolation(
          violations,
          "angular-velocity",
          index + 1,
          Math.abs(angularVelocity),
          angular.velocity,
          true,
          "Angular velocity",
        );
        refinableIntervals.add(index);
      }
      const reversing = Math.sign(angularVelocity) !== 0
        && Math.sign(previousAngularVelocity) !== 0
        && Math.sign(angularVelocity) !== Math.sign(previousAngularVelocity);
      const angularAccelerationLimit = reversing
        ? Math.min(angular.acceleration, angular.deceleration)
        : Math.abs(angularVelocity) >= Math.abs(previousAngularVelocity)
          ? angular.acceleration
          : angular.deceleration;
      if (Math.abs(angularAcceleration) > angularAccelerationLimit + tolerance(angularAccelerationLimit, 2e-3, 0.02)) {
        pushViolation(
          violations,
          "angular-acceleration",
          index + 1,
          Math.abs(angularAcceleration),
          angularAccelerationLimit,
          true,
          "Angular acceleration",
        );
        refinableIntervals.add(index);
      }
      validateModuleVelocity(point, index + 1, 0, 0, angularVelocity, angularAcceleration);
      validateModuleForces(point, index + 1, 0, 0, angularVelocity, angularAcceleration);
      continue;
    }
    const interval = linear.intervals[index];
    const beforeSquared = before.velocityMps ** 2;
    const afterSquared = after.velocityMps ** 2;
    const speedSquared = (beforeSquared + afterSquared) * 0.5;
    const speed = Math.sqrt(Math.max(0, speedSquared));
    const acceleration = (afterSquared - beforeSquared) / (2 * distance);
    const motorLimit = Math.min(
      interval.acceleration,
      interval.motorAcceleration * Math.max(0, Math.min(
        1,
        1 - Math.max(Math.abs(before.velocityMps), Math.abs(after.velocityMps)) / interval.freeSpeed,
      )),
    );
    if (acceleration >= 0 && acceleration > motorLimit + tolerance(motorLimit, 2e-3, 0.01)) {
      pushViolation(violations, "linear-acceleration", index + 1, acceleration, motorLimit, true, "Linear acceleration");
      refinableIntervals.add(index);
    } else if (acceleration < 0 && -acceleration > interval.deceleration + tolerance(interval.deceleration, 2e-3, 0.01)) {
      pushViolation(violations, "linear-deceleration", index + 1, -acceleration, interval.deceleration, true, "Linear deceleration");
      refinableIntervals.add(index);
    }
    if (acceleration >= 0 && motorLimit > EPSILON && acceleration >= motorLimit * 0.995) activeConstraints.add("linear-acceleration");
    if (acceleration < 0 && interval.deceleration > EPSILON && -acceleration >= interval.deceleration * 0.995) activeConstraints.add("linear-deceleration");

    const midpoint = interpolatePathPoint(state.points[index], state.points[index + 1]);
    const lateralLimit = input.path.constraints.maxCentripetalAccel ?? interval.acceleration;
    const centripetalAcceleration = speedSquared * Math.abs(midpoint.curvatureInvM);
    if (centripetalAcceleration > lateralLimit + tolerance(lateralLimit)) {
      pushViolation(violations, "centripetal-acceleration", index + 1, centripetalAcceleration, lateralLimit, true, "Centripetal acceleration");
      refinableIntervals.add(index);
    }
    if (lateralLimit > EPSILON && centripetalAcceleration >= lateralLimit * 0.995) {
      activeConstraints.add("centripetal-acceleration");
    }
    const projectedMidpoint = skipAngularIntervals[index]
      ? {
          ...midpoint,
          headingDerivativeRadPerM: 0,
          headingSecondDerivativeRadPerM2: 0,
        }
      : midpoint;
    const midpointProjection = projectDrivetrainAtPoint(projectedMidpoint, input.robot, lateralLimit);
    const intervalDt = Math.max(EPSILON, after.t - before.t);
    // A stationary heading transition owns the skipped interval immediately
    // before this moving interval. Do not finite-difference across that
    // intentional discontinuity; the moving angular state restarts from the
    // boundary sample and the inserted stationary action is validated on its
    // own timestamps.
    const previousAngularVelocity = index === 0 || skipsAngularForInterval(index - 1)
      ? before.angularVelocityRadps
      : timestampedAngularVelocities[index - 1];
    const sampleAngularAccelerationCandidates = usesSampleAngularKinematics
      ? [
          index === 0
            ? 2 * (timestampedAngularVelocities[0] - before.angularVelocityRadps) / intervalDt
            : (timestampedAngularVelocities[index] - previousAngularVelocity)
              / Math.max(EPSILON, (after.t - samples[index - 1].t) * 0.5),
          ...(index === samples.length - 2
            ? [2 * (after.angularVelocityRadps - timestampedAngularVelocities[index]) / intervalDt]
            : []),
        ]
      : [0];
    const sampleAngularAcceleration = sampleAngularAccelerationCandidates.reduce((largest, candidate) => (
      Math.abs(candidate) > Math.abs(largest) ? candidate : largest
    ), 0);
    const actualMidpoint = usesSampleAngularKinematics
      ? {
          ...midpoint,
          headingRad: before.headingRad + Math.atan2(
            Math.sin(after.headingRad - before.headingRad),
            Math.cos(after.headingRad - before.headingRad),
          ) * 0.5,
        }
      : midpoint;
    const projectedAccelerationConstraints = usesSampleAngularKinematics
      ? midpointProjection.accelerationConstraints.filter((constraint) => constraint.label === "chassis-traction")
      : midpointProjection.accelerationConstraints;
    const bounds = accelerationBoundsForSpeedSquared(
      projectedAccelerationConstraints,
      speedSquared,
      usesSampleAngularKinematics ? [] : midpointProjection.scalarAccelerationConstraints,
      Math.max(beforeSquared, afterSquared),
    );
    if (!bounds || acceleration < bounds.minimum - tolerance(Math.abs(bounds?.minimum ?? 0))
      || acceleration > bounds.maximum + tolerance(Math.abs(bounds?.maximum ?? 0))) {
      const belowMinimum = Boolean(bounds && acceleration < bounds.minimum);
      const limit = bounds
        ? Math.abs(belowMinimum ? bounds.minimum : bounds.maximum)
        : 0;
      const measured = bounds && belowMinimum && Math.abs(acceleration) <= limit
        ? limit + bounds.minimum - acceleration
        : Math.abs(acceleration);
      pushViolation(violations, "drivetrain-acceleration", index + 1, measured, limit, true, "Drivetrain acceleration");
      refinableIntervals.add(index);
    } else {
      for (const constraint of projectedAccelerationConstraints) {
        const measured = Math.hypot(
          constraint.uX * acceleration + constraint.xX * speedSquared,
          constraint.uY * acceleration + constraint.xY * speedSquared,
        );
        const limit = constraint.limit
          + (constraint.limitU ?? 0) * acceleration
          + (constraint.limitX ?? 0) * speedSquared;
        // An unused wheel-force split may exceed its own limit; only a near-binding one is active.
        if (constraint.label && measured >= limit * 0.94
          && (constraint.allocation === undefined || measured <= limit * 1.001)) activeConstraints.add(constraint.label);
      }
    }
    if (usesSampleAngularKinematics) {
      const angularVelocity = skipsAngularForInterval(index) ? 0 : timestampedAngularVelocities[index];
      const angularAcceleration = skipsAngularForInterval(index) ? 0 : sampleAngularAcceleration;
      validateModuleVelocity(actualMidpoint, index + 1, speed, acceleration, angularVelocity, angularAcceleration);
    } else {
      const midpointVelocityLimit = Math.min(interval.velocity, midpointProjection.velocityLimitMps);
      if (speed > midpointVelocityLimit + tolerance(midpointVelocityLimit)) {
        pushViolation(violations, "drivetrain-velocity", index + 1, speed, midpointVelocityLimit, true, "Midpoint drivetrain velocity");
        refinableIntervals.add(index);
      }
      for (const constraint of midpointProjection.velocityConstraints) {
        const measured = constraint.coefficient * speed;
        if (constraint.limitMps > EPSILON && measured >= constraint.limitMps * 0.995) {
          activeConstraints.add(constraint.label);
        }
      }

    }

    const forceAngularVelocity = skipsAngularForInterval(index)
      ? 0
      : usesSampleAngularKinematics
        ? timestampedAngularVelocities[index]
        : midpoint.headingDerivativeRadPerM * speed;
    const forceAngularAcceleration = skipsAngularForInterval(index)
      ? 0
      : usesSampleAngularKinematics
        ? sampleAngularAcceleration
        : midpoint.headingDerivativeRadPerM * acceleration
          + midpoint.headingSecondDerivativeRadPerM2 * speedSquared;
    validateModuleForces(
      actualMidpoint,
      index + 1,
      speed,
      acceleration,
      forceAngularVelocity,
      forceAngularAcceleration,
    );

    if (!skipsAngularForInterval(index)) {
      const angular = angularLimitsForInterval(input, ranges, before.f, after.f);
      const midpointOmega = usesSampleAngularKinematics
        ? timestampedAngularVelocities[index]
        : midpoint.headingDerivativeRadPerM * speed;
      const omega = Math.abs(midpointOmega);
      if (omega > angular.velocity + tolerance(angular.velocity, 2e-3, 0.02)) {
        pushViolation(violations, "angular-velocity", index + 1, omega, angular.velocity, true, "Angular velocity");
      }
      const signedAngularAcceleration = usesSampleAngularKinematics
        ? sampleAngularAcceleration
        : midpoint.headingDerivativeRadPerM * acceleration
          + midpoint.headingSecondDerivativeRadPerM2 * speedSquared;
      const headingDirection = Math.sign(midpoint.headingDerivativeRadPerM);
      const angularMagnitudeAcceleration = headingDirection === 0
        ? Math.abs(signedAngularAcceleration)
        : headingDirection * signedAngularAcceleration;
      const reversing = usesSampleAngularKinematics
        && Math.sign(timestampedAngularVelocities[index]) !== 0
        && Math.sign(previousAngularVelocity) !== 0
        && Math.sign(timestampedAngularVelocities[index])
          !== Math.sign(previousAngularVelocity);
      const angularAccelerationLimit = usesSampleAngularKinematics
        ? reversing
          ? Math.min(angular.acceleration, angular.deceleration)
          : Math.abs(timestampedAngularVelocities[index]) >= Math.abs(previousAngularVelocity)
            ? angular.acceleration
            : angular.deceleration
        : angularMagnitudeAcceleration >= 0
          ? angular.acceleration
          : angular.deceleration;
      const angularAcceleration = Math.abs(signedAngularAcceleration);
      if (angularAcceleration > angularAccelerationLimit + tolerance(angularAccelerationLimit, 2e-3, 0.02)) {
        pushViolation(violations, "angular-acceleration", index + 1, angularAcceleration, angularAccelerationLimit, true, "Angular acceleration");
        refinableIntervals.add(index);
      }
      if (angularAccelerationLimit > EPSILON && angularAcceleration >= angularAccelerationLimit * 0.995) {
        activeConstraints.add("angular-acceleration");
      }
    }
  }

  return {
    violations,
    refinableIntervals: [...refinableIntervals].sort((left, right) => left - right),
    activeConstraints: [...activeConstraints].sort(),
    checkedPoints: samples.length * 2 - 1,
    angularValidationSkipped: Boolean(options.skipAngular || skipAngularIntervals.some(Boolean)),
  };
}
