import type { RobotConfig } from "../types";
import { robotHardLimits } from "../robotLimits";
import type { AffineAccelerationConstraint, AffineScalarAccelerationConstraint } from "./reachability";
import { interpolatePathPoint, type CanonicalPathPoint, type CanonicalPathState } from "./pathState";

const EPSILON = 1e-9;

export interface DrivetrainVelocityConstraint {
  coefficient: number;
  limitMps: number;
  label: string;
}

export interface DrivetrainPointProjection {
  velocityLimitMps: number;
  velocityConstraints: DrivetrainVelocityConstraint[];
  accelerationConstraints: AffineAccelerationConstraint[];
  scalarAccelerationConstraints: AffineScalarAccelerationConstraint[];
}

export interface DrivetrainProjection {
  pointVelocityLimits: number[];
  intervalVelocityLimits: number[];
  intervalAccelerationConstraints: AffineAccelerationConstraint[][];
  intervalScalarAccelerationConstraints: AffineScalarAccelerationConstraint[][];
}

export interface DrivetrainKinematicValue {
  label: string;
  speedMps: number;
  accelerationMps2: number;
  longitudinalAccelerationMps2: number;
  motorAccelerationLimitMps2?: number;
}

export interface DrivetrainForceValue {
  label: string;
  requiredForceN: number;
  requiredMotorForceN: number;
  tractionForceLimitN: number;
  motorForceLimitN: number;
  /** Force scale for the motor check's tolerance: the flat motor cap, not the local, speed-dependent limit. */
  motorForceScaleN: number;
}

interface ModuleOffset {
  x: number;
  y: number;
  label: string;
}

function moduleOffsets(robot: RobotConfig): ModuleOffset[] {
  const wheelbase = robot.driveModel?.wheelbaseM;
  const trackwidth = robot.driveModel?.trackwidthM;
  if (!(trackwidth && trackwidth > 0)) return [];
  const halfTrack = trackwidth * 0.5;
  if (robot.drive === "tank") {
    return [
      { x: 0, y: halfTrack, label: "tank-left-wheel" },
      { x: 0, y: -halfTrack, label: "tank-right-wheel" },
    ];
  }
  if (!(wheelbase && wheelbase > 0)) return [];
  const halfWheelbase = wheelbase * 0.5;
  return [
    { x: halfWheelbase, y: halfTrack, label: "swerve-front-left-module" },
    { x: halfWheelbase, y: -halfTrack, label: "swerve-front-right-module" },
    { x: -halfWheelbase, y: halfTrack, label: "swerve-rear-left-module" },
    { x: -halfWheelbase, y: -halfTrack, label: "swerve-rear-right-module" },
  ];
}

export function projectDrivetrainAtPoint(
  point: CanonicalPathPoint,
  robot: RobotConfig,
  accelerationLimitMps2: number,
  forceSafety = 1,
): DrivetrainPointProjection {
  const freeSpeed = Math.max(0.01, robot.maxSpeed);
  const velocityConstraints: DrivetrainVelocityConstraint[] = [];
  const accelerationConstraints: AffineAccelerationConstraint[] = [];
  const scalarAccelerationConstraints: AffineScalarAccelerationConstraint[] = [];
  let velocityLimitMps = freeSpeed;
  const cosHeading = Math.cos(point.headingRad);
  const sinHeading = Math.sin(point.headingRad);
  const offsets = moduleOffsets(robot);
  if (offsets.length === 0) {
    return { velocityLimitMps, velocityConstraints, accelerationConstraints, scalarAccelerationConstraints };
  }

  // Traction limits the acceleration of the chassis center of mass. A module
  // is a force contact on one rigid body, not an independent point mass; its
  // rotational point acceleration may legitimately exceed the COM limit.
  accelerationConstraints.push({
    uX: point.tangentX,
    uY: point.tangentY,
    xX: point.curvatureInvM * point.normalX,
    xY: point.curvatureInvM * point.normalY,
    limit: Math.max(0.01, accelerationLimitMps2),
    label: "chassis-traction",
  });

  const hardLimits = robotHardLimits(robot);
  const model = robot.driveModel;
  const radiusSquaredSum = offsets.reduce((sum, module) => sum + module.x ** 2 + module.y ** 2, 0);
  const moduleCount = offsets.length;
  const massPerModule = (model?.massKg ?? 0) / moduleCount;
  const yawForceCoefficient = radiusSquaredSum > EPSILON
    ? (model?.moiKgM2 ?? 0) / radiusSquaredSum
    : 0;
  const tractionForceLimitN = hardLimits && model
    ? hardLimits.tractionAccelMps2 * model.massKg! / moduleCount * forceSafety
    : 0;
  const stallForceLimitN = hardLimits && model
    ? hardLimits.motorAccelMps2 * model.massKg! / moduleCount * forceSafety
    : 0;
  // With an electrical model the motor line bounds only motoring force along the
  // wheel's rolling direction; current caps motoring and braking separately.
  const electrical = Boolean(hardLimits?.electrical);
  const motorCapForceN = hardLimits && model
    ? hardLimits.motorCapAccelMps2 * model.massKg! / moduleCount * forceSafety
    : 0;
  const brakingCapForceN = hardLimits && model
    ? hardLimits.brakingCapAccelMps2 * model.massKg! / moduleCount * forceSafety
    : 0;

  for (const module of offsets) {
    const offsetX = cosHeading * module.x - sinHeading * module.y;
    const offsetY = sinHeading * module.x + cosHeading * module.y;
    const perpendicularX = -offsetY;
    const perpendicularY = offsetX;
    const headingDerivative = point.headingDerivativeRadPerM;
    const uX = point.tangentX + headingDerivative * perpendicularX;
    const uY = point.tangentY + headingDerivative * perpendicularY;
    const velocityCoefficient = Math.hypot(uX, uY);
    const moduleVelocityLimit = velocityCoefficient > EPSILON
      ? freeSpeed / velocityCoefficient
      : Number.POSITIVE_INFINITY;
    velocityLimitMps = Math.min(velocityLimitMps, moduleVelocityLimit);
    velocityConstraints.push({ coefficient: velocityCoefficient, limitMps: freeSpeed, label: module.label });

    if (hardLimits && tractionForceLimitN > EPSILON) {
      const forceUX = massPerModule * point.tangentX
        + yawForceCoefficient * headingDerivative * perpendicularX;
      const forceUY = massPerModule * point.tangentY
        + yawForceCoefficient * headingDerivative * perpendicularY;
      const forceXX = massPerModule * point.curvatureInvM * point.normalX
        + yawForceCoefficient * point.headingSecondDerivativeRadPerM2 * perpendicularX;
      const forceXY = massPerModule * point.curvatureInvM * point.normalY
        + yawForceCoefficient * point.headingSecondDerivativeRadPerM2 * perpendicularY;
      accelerationConstraints.push({
        uX: forceUX,
        uY: forceUY,
        xX: forceXX,
        xY: forceXY,
        limit: tractionForceLimitN,
        label: `${module.label}-traction-force`,
      });
      if (velocityCoefficient > EPSILON && stallForceLimitN > EPSILON) {
        const velocityDirectionX = uX / velocityCoefficient;
        const velocityDirectionY = uY / velocityCoefficient;
        scalarAccelerationConstraints.push({
          u: forceUX * velocityDirectionX + forceUY * velocityDirectionY,
          x: forceXX * velocityDirectionX + forceXY * velocityDirectionY,
          minimum: electrical ? -brakingCapForceN : -stallForceLimitN,
          maximum: electrical ? motorCapForceN : stallForceLimitN,
          velocityCoefficient,
          freeSpeed: hardLimits.maxSpeedMps,
          motorAcceleration: stallForceLimitN,
          ...(electrical ? { motoringOnly: true } : {}),
          label: `${module.label}-motor-force`,
        });
      }
    }

  }

  return { velocityLimitMps, velocityConstraints, accelerationConstraints, scalarAccelerationConstraints };
}

export function evaluateDrivetrainKinematics(
  point: CanonicalPathPoint,
  robot: RobotConfig,
  velocityMps: number,
  accelerationMps2: number,
  angularVelocityRadps: number,
  angularAccelerationRadps2: number,
): DrivetrainKinematicValue[] {
  const cosHeading = Math.cos(point.headingRad);
  const sinHeading = Math.sin(point.headingRad);
  const hardLimits = robotHardLimits(robot);
  return moduleOffsets(robot).map((module) => {
    const offsetX = cosHeading * module.x - sinHeading * module.y;
    const offsetY = sinHeading * module.x + cosHeading * module.y;
    const perpendicularX = -offsetY;
    const perpendicularY = offsetX;
    const velocityX = point.tangentX * velocityMps + angularVelocityRadps * perpendicularX;
    const velocityY = point.tangentY * velocityMps + angularVelocityRadps * perpendicularY;
    const accelerationX = point.tangentX * accelerationMps2
      + point.curvatureInvM * point.normalX * velocityMps ** 2
      + angularAccelerationRadps2 * perpendicularX
      - angularVelocityRadps ** 2 * offsetX;
    const accelerationY = point.tangentY * accelerationMps2
      + point.curvatureInvM * point.normalY * velocityMps ** 2
      + angularAccelerationRadps2 * perpendicularY
      - angularVelocityRadps ** 2 * offsetY;
    const speedMps = Math.hypot(velocityX, velocityY);
    const longitudinalAccelerationMps2 = speedMps > EPSILON
      ? (velocityX * accelerationX + velocityY * accelerationY) / speedMps
      : 0;
    return {
      label: module.label,
      speedMps,
      accelerationMps2: Math.hypot(accelerationX, accelerationY),
      longitudinalAccelerationMps2,
      ...(hardLimits ? {
        motorAccelerationLimitMps2: hardLimits.motorAccelMps2
          * Math.max(0, 1 - speedMps / hardLimits.maxSpeedMps),
      } : {}),
    };
  });
}

/**
 * Allocates the requested chassis wrench across the module force contacts.
 * Alternating projections redistribute force in the wrench nullspace while
 * preserving ΣF=m*a and Σ(r×F)=I*alpha, closely matching the force-contact
 * feasibility model used by Choreo without adding an optimization dependency.
 */
export function evaluateDrivetrainForces(
  point: CanonicalPathPoint,
  robot: RobotConfig,
  velocityMps: number,
  accelerationMps2: number,
  angularVelocityRadps: number,
  angularAccelerationRadps2: number,
): DrivetrainForceValue[] {
  const model = robot.driveModel;
  const hardLimits = robotHardLimits(robot);
  const offsets = moduleOffsets(robot);
  if (!model || !hardLimits || offsets.length === 0) return [];

  const massKg = model.massKg!;
  const moiKgM2 = model.moiKgM2!;
  const moduleCount = offsets.length;
  const radiusSquaredSum = offsets.reduce((sum, module) => sum + module.x ** 2 + module.y ** 2, 0);
  if (radiusSquaredSum <= EPSILON) return [];

  const cosHeading = Math.cos(point.headingRad);
  const sinHeading = Math.sin(point.headingRad);
  const comAccelerationX = point.tangentX * accelerationMps2
    + point.curvatureInvM * point.normalX * velocityMps ** 2;
  const comAccelerationY = point.tangentY * accelerationMps2
    + point.curvatureInvM * point.normalY * velocityMps ** 2;
  const translationForceX = massKg * comAccelerationX / moduleCount;
  const translationForceY = massKg * comAccelerationY / moduleCount;
  const yawForceScale = moiKgM2 * angularAccelerationRadps2 / radiusSquaredSum;
  const tractionForceLimitN = hardLimits.tractionAccelMps2 * massKg / moduleCount;
  const stallForceLimitN = hardLimits.motorAccelMps2 * massKg / moduleCount;
  const electrical = Boolean(hardLimits.electrical);
  const motorCapForceN = hardLimits.motorCapAccelMps2 * massKg / moduleCount;
  const brakingCapForceN = hardLimits.brakingCapAccelMps2 * massKg / moduleCount;
  const rotatedOffsets = offsets.map((module) => {
    const offsetX = cosHeading * module.x - sinHeading * module.y;
    const offsetY = sinHeading * module.x + cosHeading * module.y;
    const perpendicularX = -offsetY;
    const perpendicularY = offsetX;
    return { ...module, offsetX, offsetY, perpendicularX, perpendicularY };
  });
  const forces = rotatedOffsets.map((module) => ({
    x: translationForceX + yawForceScale * module.perpendicularX,
    y: translationForceY + yawForceScale * module.perpendicularY,
  }));
  // Allocation clips the whole contact force. With an electrical model only traction
  // bounds it; the motor limits apply to the rolling-direction part, checked below.
  const forceLimitN = electrical ? tractionForceLimitN : Math.min(tractionForceLimitN, stallForceLimitN);
  for (let iteration = 0; iteration < 12; iteration += 1) {
    forces.forEach((force) => {
      const magnitude = Math.hypot(force.x, force.y);
      if (magnitude > forceLimitN && magnitude > EPSILON) {
        const scale = forceLimitN / magnitude;
        force.x *= scale;
        force.y *= scale;
      }
    });
    const achievedForceX = forces.reduce((sum, force) => sum + force.x, 0);
    const achievedForceY = forces.reduce((sum, force) => sum + force.y, 0);
    const achievedTorque = forces.reduce((sum, force, index) => (
      sum + rotatedOffsets[index].offsetX * force.y - rotatedOffsets[index].offsetY * force.x
    ), 0);
    const forceCorrectionX = (massKg * comAccelerationX - achievedForceX) / moduleCount;
    const forceCorrectionY = (massKg * comAccelerationY - achievedForceY) / moduleCount;
    const torqueCorrectionScale = (moiKgM2 * angularAccelerationRadps2 - achievedTorque) / radiusSquaredSum;
    rotatedOffsets.forEach((module, index) => {
      forces[index].x += forceCorrectionX + torqueCorrectionScale * module.perpendicularX;
      forces[index].y += forceCorrectionY + torqueCorrectionScale * module.perpendicularY;
    });
  }

  return rotatedOffsets.map((module, index) => {
    const requiredForceN = Math.hypot(forces[index].x, forces[index].y);
    if (electrical) {
      // The drive motor supplies only the force along the wheel's rolling direction;
      // the lateral part is tire friction and counts toward traction alone.
      const velocityX = point.tangentX * velocityMps + angularVelocityRadps * module.perpendicularX;
      const velocityY = point.tangentY * velocityMps + angularVelocityRadps * module.perpendicularY;
      const speedMps = Math.hypot(velocityX, velocityY);
      const alongForceN = speedMps > EPSILON
        ? (forces[index].x * velocityX + forces[index].y * velocityY) / speedMps
        : requiredForceN;
      const motoringLimitN = Math.min(
        motorCapForceN,
        stallForceLimitN * Math.max(0, 1 - speedMps / hardLimits.maxSpeedMps),
      );
      return {
        label: module.label,
        requiredForceN,
        requiredMotorForceN: Math.abs(alongForceN),
        tractionForceLimitN,
        motorForceLimitN: alongForceN >= 0 ? motoringLimitN : brakingCapForceN,
        // Near the zero-torque speed the local limit tends to zero, so scale the tolerance
        // by the flat cap: newton-level differences between the solver's interval
        // geometry and the dense validation grid are not violations.
        motorForceScaleN: alongForceN >= 0 ? motorCapForceN : brakingCapForceN,
      };
    }
    return {
      label: module.label,
      requiredForceN,
      requiredMotorForceN: requiredForceN,
      tractionForceLimitN,
      // Match Choreo's force-contact model: wheel speed and maximum wheel
      // torque are independent constraints. Applying a DC torque-speed line
      // to the entire allocated force vector double-counts the wheel-speed
      // constraint and produces severe false slowdowns during combined motion.
      motorForceLimitN: stallForceLimitN,
      motorForceScaleN: stallForceLimitN,
    };
  });
}

export function buildDrivetrainProjection(
  state: CanonicalPathState,
  robot: RobotConfig,
  intervalAccelerationLimits: readonly number[],
  translationPriorityIntervals: readonly boolean[] = [],
  forceSafety = 1,
): DrivetrainProjection {
  if (intervalAccelerationLimits.length !== state.points.length - 1) {
    throw new Error("Drivetrain interval limits must be one less than the path point count.");
  }
  const withoutHeadingDynamics = (point: CanonicalPathPoint): CanonicalPathPoint => ({
    ...point,
    headingDerivativeRadPerM: 0,
    headingSecondDerivativeRadPerM2: 0,
  });
  const pointVelocityLimits = state.points.map((point, index) => {
    const limit = Math.min(
      intervalAccelerationLimits[index - 1] ?? Number.POSITIVE_INFINITY,
      intervalAccelerationLimits[index] ?? Number.POSITIVE_INFINITY,
    );
    const projectedPoint = translationPriorityIntervals[index - 1] || translationPriorityIntervals[index]
      ? withoutHeadingDynamics(point)
      : point;
    return projectDrivetrainAtPoint(projectedPoint, robot, limit).velocityLimitMps;
  });
  const intervalProjections = state.points.slice(1).map((point, index) => {
    const midpoint = interpolatePathPoint(state.points[index], point);
    const projectedMidpoint = translationPriorityIntervals[index]
      ? withoutHeadingDynamics(midpoint)
      : midpoint;
    return projectDrivetrainAtPoint(projectedMidpoint, robot, intervalAccelerationLimits[index], forceSafety);
  });
  return {
    pointVelocityLimits,
    intervalVelocityLimits: intervalProjections.map((projection) => projection.velocityLimitMps),
    intervalAccelerationConstraints: intervalProjections.map((projection) => projection.accelerationConstraints),
    intervalScalarAccelerationConstraints: intervalProjections.map((projection) => projection.scalarAccelerationConstraints),
  };
}
