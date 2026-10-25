import type { RobotConfig } from "../types";
import { robotHardLimits, type RobotHardLimits } from "../robotLimits";
import {
  contactLoads,
  directionalAccelerationLimit,
  driveContacts,
  GRAVITY_MPS2,
  robotLoadModel,
  solveLinear3,
  type ContactLoadModel,
} from "../loadTransfer";
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
  /** Signed drive force along the positive module velocity; zero at rest (no rolling direction). */
  rollingForceN: number;
  requiredForceN: number;
  requiredMotorForceN: number;
  tractionForceLimitN: number;
  motorForceLimitN: number;
  /** Force scale for the motor check's tolerance: the flat motor cap, not the local, speed-dependent limit. */
  motorForceScaleN: number;
  /** Wheel normal load, newtons; zero for a lifted wheel. */
  normalForceN: number;
}

const moduleOffsets = driveContacts;

/** Planner-wide traction inputs for one point, or null when wheel loads stay equal. */
interface LoadTransferContext {
  loads: ContactLoadModel;
  frictionCoefficient: number;
  massKg: number;
}

function loadTransferContext(robot: RobotConfig, hardLimits: RobotHardLimits | null): LoadTransferContext | null {
  const model = robot.driveModel;
  if (!hardLimits || !model || !(hardLimits.cgHeightM > 0)) return null;
  return {
    loads: robotLoadModel(robot, model.massKg!, hardLimits.cgHeightM).loads,
    frictionCoefficient: model.wheelFrictionCoefficient!,
    massKg: model.massKg!,
  };
}

/** Field-frame load gradient: N_i = static_i + gradient_i . a_CG (field frame). */
function fieldLoadGradients(loads: ContactLoadModel, cosHeading: number, sinHeading: number) {
  return loads.static.map((_load, index) => {
    const perX = loads.perAccelX[index];
    const perY = loads.perAccelY[index];
    return { x: perX * cosHeading - perY * sinHeading, y: perX * sinHeading + perY * cosHeading };
  });
}

/**
 * Translation-force splits for the planner. Each split is a fixed weight per
 * wheel (summing to 1); the yaw share is adjusted so the split's moment stays
 * exact. The first is the equal split. The others give each wheel its share of
 * what it can supply, min(mu N_i, drive cap), at the hardest launch, stop or
 * corner along this point's path: the optimal split for that maneuver. The
 * planner may use any split, so its limit is the best of them.
 */
const LAUNCH_CAP_LEVELS = [1, 0.7, 0.45];

function translationSplits(
  context: LoadTransferContext,
  gradients: readonly { x: number; y: number }[],
  point: Pick<CanonicalPathPoint, "tangentX" | "tangentY" | "normalX" | "normalY" | "curvatureInvM">,
  motoringCapN: number,
  brakingCapN: number,
  speedCapMps: number,
): number[][] {
  const count = gradients.length;
  const equal = new Array<number>(count).fill(1 / count);
  const { loads, frictionCoefficient: mu, massKg } = context;
  const splitAlong = (directionX: number, directionY: number, capN: number, magnitudeCap = Number.POSITIVE_INFINITY) => {
    const slopes = gradients.map((gradient) => gradient.x * directionX + gradient.y * directionY);
    const magnitude = Math.min(magnitudeCap, directionalAccelerationLimit(loads.static, slopes, mu, capN, massKg));
    const supply = loads.static.map((load, index) => Math.min(mu * Math.max(0, load + slopes[index] * magnitude), capN));
    const total = supply.reduce((sum, value) => sum + value, 0);
    return total > EPSILON ? supply.map((value) => value / total) : equal;
  };
  // The motoring limit falls with speed (torque-speed line), which moves the
  // best launch split back toward equal; a few levels cover the speed range.
  const launches = LAUNCH_CAP_LEVELS.map((level) => splitAlong(point.tangentX, point.tangentY, motoringCapN * level));
  const stop = splitAlong(-point.tangentX, -point.tangentY, brakingCapN);
  const candidates = [equal, ...launches, stop];
  if (Math.abs(point.curvatureInvM) > EPSILON) {
    const side = Math.sign(point.curvatureInvM);
    // Lateral force is friction alone; the turn's hardest cornering is at the
    // friction or wheel-lift limit, or at top speed on a gentle curve.
    const corner = splitAlong(
      side * point.normalX,
      side * point.normalY,
      Number.POSITIVE_INFINITY,
      Math.abs(point.curvatureInvM) * speedCapMps ** 2,
    );
    candidates.push(corner);
  }
  return candidates.filter((candidate, index) => candidates.slice(0, index).every((previous) => (
    previous.some((value, wheel) => Math.abs(value - candidate[wheel]) > 1e-9)
  )));
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
  const transfer = tractionForceLimitN > EPSILON ? loadTransferContext(robot, hardLimits) : null;

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

    if (hardLimits && tractionForceLimitN > EPSILON && !transfer) {
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

  if (transfer && hardLimits && model) {
    // Each wheel's friction limit follows its load, which is affine in the CG
    // acceleration a_CG = tangent * s'' + curvature * normal * s'^2:
    // |F_i| <= mu (N_static + gradient . a_CG). The split's translation force
    // w_i m a_CG has moment m (c x a_CG) about the center, c = sum w_i r_i;
    // the yaw share removes it so every split delivers exactly I alpha.
    const gradients = fieldLoadGradients(transfer.loads, cosHeading, sinHeading);
    const mu = transfer.frictionCoefficient;
    const massKg = transfer.massKg;
    const curvatureX = point.curvatureInvM * point.normalX;
    const curvatureY = point.curvatureInvM * point.normalY;
    const rotated = offsets.map((module) => {
      const offsetX = cosHeading * module.x - sinHeading * module.y;
      const offsetY = sinHeading * module.x + cosHeading * module.y;
      return { label: module.label, offsetX, offsetY, perpendicularX: -offsetY, perpendicularY: offsetX };
    });
    const splits = translationSplits(
      transfer,
      gradients,
      point,
      electrical ? Math.min(motorCapForceN, stallForceLimitN) : stallForceLimitN,
      electrical ? brakingCapForceN : stallForceLimitN,
      freeSpeed,
    );
    const moi = model.moiKgM2 ?? 0;
    splits.forEach((weights, allocation) => {
      const centerX = weights.reduce((sum, weight, index) => sum + weight * rotated[index].offsetX, 0);
      const centerY = weights.reduce((sum, weight, index) => sum + weight * rotated[index].offsetY, 0);
      const yawU = radiusSquaredSum > EPSILON
        ? (moi * point.headingDerivativeRadPerM - massKg * (centerX * point.tangentY - centerY * point.tangentX)) / radiusSquaredSum
        : 0;
      const yawX = radiusSquaredSum > EPSILON
        ? (moi * point.headingSecondDerivativeRadPerM2 - massKg * (centerX * curvatureY - centerY * curvatureX)) / radiusSquaredSum
        : 0;
      rotated.forEach((module, index) => {
        const translation = weights[index] * massKg;
        const forceUX = translation * point.tangentX + yawU * module.perpendicularX;
        const forceUY = translation * point.tangentY + yawU * module.perpendicularY;
        const forceXX = translation * curvatureX + yawX * module.perpendicularX;
        const forceXY = translation * curvatureY + yawX * module.perpendicularY;
        const gradient = gradients[index];
        accelerationConstraints.push({
          uX: forceUX,
          uY: forceUY,
          xX: forceXX,
          xY: forceXY,
          limit: mu * transfer.loads.static[index] * forceSafety,
          limitU: mu * (gradient.x * point.tangentX + gradient.y * point.tangentY) * forceSafety,
          limitX: mu * (gradient.x * curvatureX + gradient.y * curvatureY) * forceSafety,
          allocation,
          label: `${module.label}-traction-force`,
        });
        const headingDerivative = point.headingDerivativeRadPerM;
        const velocityX = point.tangentX + headingDerivative * module.perpendicularX;
        const velocityY = point.tangentY + headingDerivative * module.perpendicularY;
        const velocityCoefficient = Math.hypot(velocityX, velocityY);
        if (velocityCoefficient > EPSILON && stallForceLimitN > EPSILON) {
          const velocityDirectionX = velocityX / velocityCoefficient;
          const velocityDirectionY = velocityY / velocityCoefficient;
          scalarAccelerationConstraints.push({
            u: forceUX * velocityDirectionX + forceUY * velocityDirectionY,
            x: forceXX * velocityDirectionX + forceXY * velocityDirectionY,
            minimum: electrical ? -brakingCapForceN : -stallForceLimitN,
            maximum: electrical ? motorCapForceN : stallForceLimitN,
            velocityCoefficient,
            freeSpeed: hardLimits.maxSpeedMps,
            motorAcceleration: stallForceLimitN,
            ...(electrical ? { motoringOnly: true } : {}),
            allocation,
            label: `${module.label}-motor-force`,
          });
        }
      });
    });
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
  point: Pick<CanonicalPathPoint, "headingRad" | "tangentX" | "tangentY" | "normalX" | "normalY" | "curvatureInvM">,
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
  if (hardLimits.cgHeightM > 0) {
    return allocateWithLoadTransfer({
      robot, hardLimits, point, rotatedOffsets, velocityMps, angularVelocityRadps,
      comAccelerationX, comAccelerationY, torqueNm: moiKgM2 * angularAccelerationRadps2,
      stallForceLimitN, motorCapForceN, brakingCapForceN,
    });
  }
  const staticLoadN = massKg * GRAVITY_MPS2 / moduleCount;
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
    const velocityX = point.tangentX * velocityMps + angularVelocityRadps * module.perpendicularX;
    const velocityY = point.tangentY * velocityMps + angularVelocityRadps * module.perpendicularY;
    const speedMps = Math.hypot(velocityX, velocityY);
    const rollingForceN = speedMps > EPSILON
      ? (forces[index].x * velocityX + forces[index].y * velocityY) / speedMps
      : 0;
    if (electrical) {
      // The drive motor supplies only the force along the wheel's rolling direction;
      // the lateral part is tire friction and counts toward traction alone.
      const alongForceN = speedMps > EPSILON
        ? rollingForceN
        : requiredForceN;
      const motoringLimitN = Math.min(
        motorCapForceN,
        stallForceLimitN * Math.max(0, 1 - speedMps / hardLimits.maxSpeedMps),
      );
      return {
        label: module.label,
        rollingForceN,
        requiredForceN,
        requiredMotorForceN: Math.abs(alongForceN),
        tractionForceLimitN,
        motorForceLimitN: alongForceN >= 0 ? motoringLimitN : brakingCapForceN,
        // Near the zero-torque speed the local limit tends to zero, so scale the tolerance
        // by the flat cap: newton-level differences between the solver's interval
        // geometry and the dense validation grid are not violations.
        motorForceScaleN: alongForceN >= 0 ? motorCapForceN : brakingCapForceN,
        normalForceN: staticLoadN,
      };
    }
    return {
      label: module.label,
      rollingForceN,
      requiredForceN,
      requiredMotorForceN: requiredForceN,
      tractionForceLimitN,
      // Match Choreo's force-contact model: wheel speed and maximum wheel
      // torque are independent constraints. Applying a DC torque-speed line
      // to the entire allocated force vector double-counts the wheel-speed
      // constraint and produces severe false slowdowns during combined motion.
      motorForceLimitN: stallForceLimitN,
      motorForceScaleN: stallForceLimitN,
      normalForceN: staticLoadN,
    };
  });
}

/** Solver for a fixed 3x3 system: the explicit inverse when well conditioned. */
function linearSolver3(matrix: readonly number[][]): (first: number, second: number, third: number) => number[] {
  const [[a, b, c], [d, e, f], [g, h, i]] = matrix;
  const cofactor00 = e * i - f * h;
  const cofactor01 = f * g - d * i;
  const cofactor02 = d * h - e * g;
  const determinant = a * cofactor00 + b * cofactor01 + c * cofactor02;
  const scale = Math.abs(a) * Math.abs(e) * Math.abs(i) + Math.abs(b * f * g) + Math.abs(c * d * h) + EPSILON;
  if (!(Math.abs(determinant) > scale * 1e-10)) {
    return (first, second, third) => solveLinear3(matrix, [first, second, third]);
  }
  const inverse = [
    cofactor00, c * h - b * i, b * f - c * e,
    cofactor01, a * i - c * g, c * d - a * f,
    cofactor02, b * g - a * h, a * e - b * d,
  ].map((value) => value / determinant);
  return (first, second, third) => [
    inverse[0] * first + inverse[1] * second + inverse[2] * third,
    inverse[3] * first + inverse[4] * second + inverse[5] * third,
    inverse[6] * first + inverse[7] * second + inverse[8] * third,
  ];
}

interface RotatedContact {
  label: string;
  offsetX: number;
  offsetY: number;
  perpendicularX: number;
  perpendicularY: number;
}

/**
 * Wrench allocation with load transfer. Wheel loads follow the CG acceleration
 * (with wheel lift), so each wheel's friction limit is mu N_i. Force goes to
 * the wheels in proportion to what each can supply in its force direction,
 * min(mu N_i, drive limit / rolling share): for straight driving this is the
 * optimal split, so the lightest wheel is never asked for more than its
 * traction while a heavier one has room. Each step solves the weighted
 * minimum-norm correction F_i += c_i (lambda + mu_yaw perp_i) that restores
 * sum F = m a and sum r x F = I alpha exactly, so the result always delivers
 * the planned wrench; clipping between steps moves force off saturated wheels.
 */
function allocateWithLoadTransfer(args: {
  robot: RobotConfig;
  hardLimits: RobotHardLimits;
  point: Pick<CanonicalPathPoint, "headingRad" | "tangentX" | "tangentY">;
  rotatedOffsets: readonly RotatedContact[];
  velocityMps: number;
  angularVelocityRadps: number;
  comAccelerationX: number;
  comAccelerationY: number;
  torqueNm: number;
  stallForceLimitN: number;
  motorCapForceN: number;
  brakingCapForceN: number;
}): DrivetrainForceValue[] {
  const { robot, hardLimits, point, rotatedOffsets, velocityMps, angularVelocityRadps } = args;
  const { comAccelerationX, comAccelerationY, torqueNm, stallForceLimitN, motorCapForceN, brakingCapForceN } = args;
  const model = robot.driveModel!;
  const massKg = model.massKg!;
  const mu = model.wheelFrictionCoefficient!;
  const electrical = Boolean(hardLimits.electrical);
  const cosHeading = Math.cos(point.headingRad);
  const sinHeading = Math.sin(point.headingRad);
  const robotAccelerationX = cosHeading * comAccelerationX + sinHeading * comAccelerationY;
  const robotAccelerationY = -sinHeading * comAccelerationX + cosHeading * comAccelerationY;
  const loads = contactLoads(moduleOffsets(robot), massKg, hardLimits.cgHeightM, robotAccelerationX, robotAccelerationY);
  const totalLoad = loads.normalN.reduce((sum, load) => sum + load, 0);
  const radiusSquaredSum = rotatedOffsets.reduce((sum, module) => sum + module.offsetX ** 2 + module.offsetY ** 2, 0);
  const modules = rotatedOffsets.map((module, index) => {
    const velocityX = point.tangentX * velocityMps + angularVelocityRadps * module.perpendicularX;
    const velocityY = point.tangentY * velocityMps + angularVelocityRadps * module.perpendicularY;
    const speedMps = Math.hypot(velocityX, velocityY);
    const tractionLimitN = mu * loads.normalN[index];
    const motoringLimitN = electrical
      ? Math.min(motorCapForceN, stallForceLimitN * Math.max(0, 1 - speedMps / hardLimits.maxSpeedMps))
      : stallForceLimitN;
    return {
      ...module,
      speedMps,
      directionX: speedMps > EPSILON ? velocityX / speedMps : 0,
      directionY: speedMps > EPSILON ? velocityY / speedMps : 0,
      tractionLimitN,
      motoringLimitN,
      // Without an electrical model the stall force bounds the whole contact force.
      forceLimitN: electrical ? tractionLimitN : Math.min(tractionLimitN, stallForceLimitN),
    };
  });

  // Supply weights from a load-proportional first guess: its direction tells
  // how much of each wheel's force the drive motor must provide.
  const yawGuess = radiusSquaredSum > EPSILON ? torqueNm / radiusSquaredSum : 0;
  const weights = modules.map((module, index) => {
    if (!(module.tractionLimitN > EPSILON)) return 0;
    const share = totalLoad > EPSILON ? loads.normalN[index] / totalLoad : 0;
    const guessX = share * massKg * comAccelerationX + yawGuess * module.perpendicularX;
    const guessY = share * massKg * comAccelerationY + yawGuess * module.perpendicularY;
    const magnitude = Math.hypot(guessX, guessY);
    if (!electrical) return module.forceLimitN;
    if (magnitude <= EPSILON) return module.tractionLimitN;
    if (module.speedMps <= EPSILON) return Math.min(module.tractionLimitN, module.motoringLimitN);
    const rolling = (guessX * module.directionX + guessY * module.directionY) / magnitude;
    const driveLimitN = rolling >= 0 ? module.motoringLimitN : brakingCapForceN;
    return Math.abs(rolling) > EPSILON
      ? Math.min(module.tractionLimitN, driveLimitN / Math.abs(rolling))
      : module.tractionLimitN;
  });
  // A wheel that can supply nothing still takes a token share so the wrench
  // stays solvable; with every wheel saturated the result reports the overload.
  const weightScale = Math.max(EPSILON, ...weights);
  const effectiveWeights = weights.map((weight) => Math.max(weight, weightScale * 1e-6));
  const matrix = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  modules.forEach((module, index) => {
    const weight = effectiveWeights[index];
    matrix[0][0] += weight;
    matrix[1][1] += weight;
    matrix[0][2] += weight * module.perpendicularX;
    matrix[1][2] += weight * module.perpendicularY;
    matrix[2][2] += weight * (module.offsetX ** 2 + module.offsetY ** 2);
  });
  matrix[2][0] = matrix[0][2];
  matrix[2][1] = matrix[1][2];
  const targetForceX = massKg * comAccelerationX;
  const targetForceY = massKg * comAccelerationY;
  const solve = linearSolver3(matrix);
  const forces = modules.map(() => ({ x: 0, y: 0 }));
  const correct = () => {
    const achievedX = forces.reduce((sum, force) => sum + force.x, 0);
    const achievedY = forces.reduce((sum, force) => sum + force.y, 0);
    const achievedTorque = forces.reduce((sum, force, index) => (
      sum + modules[index].offsetX * force.y - modules[index].offsetY * force.x
    ), 0);
    const [lambdaX, lambdaY, yaw] = solve(targetForceX - achievedX, targetForceY - achievedY, torqueNm - achievedTorque);
    modules.forEach((module, index) => {
      forces[index].x += effectiveWeights[index] * (lambdaX + yaw * module.perpendicularX);
      forces[index].y += effectiveWeights[index] * (lambdaY + yaw * module.perpendicularY);
    });
  };
  correct();
  for (let iteration = 0; iteration < 120; iteration += 1) {
    let clippedAny = false;
    modules.forEach((module, index) => {
      const force = forces[index];
      const magnitude = Math.hypot(force.x, force.y);
      if (magnitude > module.forceLimitN && magnitude > EPSILON) {
        clippedAny ||= magnitude > module.forceLimitN + 1e-7;
        const scale = module.forceLimitN / magnitude;
        force.x *= scale;
        force.y *= scale;
      }
      if (!electrical) return;
      if (module.speedMps <= EPSILON) {
        const clipped = Math.hypot(force.x, force.y);
        if (clipped > module.motoringLimitN && clipped > EPSILON) {
          clippedAny ||= clipped > module.motoringLimitN + 1e-7;
          const scale = module.motoringLimitN / clipped;
          force.x *= scale;
          force.y *= scale;
        }
        return;
      }
      // The motor bounds only the rolling part; tire friction carries the rest.
      const rolling = force.x * module.directionX + force.y * module.directionY;
      const bounded = Math.max(-brakingCapForceN, Math.min(module.motoringLimitN, rolling));
      if (bounded !== rolling) {
        clippedAny ||= Math.abs(bounded - rolling) > 1e-7;
        force.x += (bounded - rolling) * module.directionX;
        force.y += (bounded - rolling) * module.directionY;
      }
    });
    correct();
    if (!clippedAny) break;
  }

  return modules.map((module, index) => {
    const requiredForceN = Math.hypot(forces[index].x, forces[index].y);
    const rollingForceN = module.speedMps > EPSILON
      ? forces[index].x * module.directionX + forces[index].y * module.directionY
      : 0;
    const base = {
      label: module.label,
      rollingForceN,
      requiredForceN,
      tractionForceLimitN: module.tractionLimitN,
      normalForceN: loads.normalN[index],
    };
    if (!electrical) {
      return { ...base, requiredMotorForceN: requiredForceN, motorForceLimitN: stallForceLimitN, motorForceScaleN: stallForceLimitN };
    }
    const alongForceN = module.speedMps > EPSILON ? rollingForceN : requiredForceN;
    return {
      ...base,
      requiredMotorForceN: Math.abs(alongForceN),
      motorForceLimitN: alongForceN >= 0 ? module.motoringLimitN : brakingCapForceN,
      motorForceScaleN: alongForceN >= 0 ? motorCapForceN : brakingCapForceN,
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
