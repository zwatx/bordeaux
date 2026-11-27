import { directionalAccelerationLimit, GRAVITY_MPS2, resolveCgHeightM, robotLoadModel } from "./loadTransfer";
import { driveMotorPreset } from "./motorPresets";
import type { FollowableLimit, PathConstraints, PathDoc, PlannerInput, RobotConfig } from "./types";
import { planningRobotForPath } from "./commandLoads";
const RADIANS_TO_DEGREES = 180 / Math.PI;

const DATASHEET_VOLTAGE_V = 12;

export interface DriveElectricalModel {
  /** Winding resistance from the 12 V stall current. */
  resistanceOhm: number;
  /** Winding resistance plus each motor's share of battery and wiring resistance. */
  effectiveResistanceOhm: number;
  torqueConstantNmPerA: number;
  /** Speed constant, motor rad/s per volt. */
  velocityConstantRadpsPerV: number;
  /** Voltage available to the drive after other loads and the control reserve. */
  availableVoltageV: number;
  /** Stator current per motor after the control reserve. */
  currentCapA: number;
  freeCurrentA: number;
  efficiency: number;
}

export interface RobotHardLimits {
  /** Speed where the motor torque-speed line reaches zero; the 12 V free speed without an electrical model. */
  maxSpeedMps: number;
  maxAccelMps2: number;
  maxDecelMps2: number;
  maxCornerAccelMps2: number;
  maxAngularSpeedDegps: number;
  maxAngularAccelDegps2: number;
  /** Chassis acceleration where the motor torque-speed line meets zero speed. */
  motorAccelMps2: number;
  /** Flat motoring cap from torque or current, before traction. */
  motorCapAccelMps2: number;
  /** Flat braking cap from torque or current, before traction. Braking is not back-EMF limited. */
  brakingCapAccelMps2: number;
  /** Friction alone, mu g: the CG acceleration limit with equal wheel loads. */
  tractionAccelMps2: number;
  /** Center-of-gravity height used for load transfer; 0 means equal wheel loads. */
  cgHeightM: number;
  electrical: DriveElectricalModel | null;
}

type DriveModel = NonNullable<RobotConfig["driveModel"]>;

const positive = (value: number | undefined): value is number => Number.isFinite(value) && value! > 0;
const nonnegative = (value: number | undefined): value is number => Number.isFinite(value) && value! >= 0;

export type ElectricalDriveKey =
  | "motorStallCurrentA"
  | "motorFreeCurrentA"
  | "driveCurrentLimitA"
  | "batteryVoltageV"
  | "batteryResistanceOhm"
  | "otherLoadA"
  | "driveEfficiency"
  | "controlReserve";

export type ElectricalDriveInputs = Record<ElectricalDriveKey, number>;

/**
 * The drivetrain a robot starts with, sized from its top speed and frame: a 6.75:1 swerve on 4 in wheels at 54 kg.
 * A new robot carries it, so its speed, acceleration and cornering are limited from the start; the Robot page shows
 * the same values for an older robot saved without a drivetrain.
 */
export function startingDriveModel(robot: Pick<RobotConfig, "maxSpeed" | "l" | "w">): DriveModel {
  const gearRatio = 6.75, wheelDiameterM = 0.1016, massKg = 54;
  return {
    motorId: "custom",
    motorFreeRpm: robot.maxSpeed * 60 * gearRatio / (Math.PI * wheelDiameterM),
    motorMaxTorqueNm: 2.6,
    motorCount: 4,
    gearRatio,
    wheelDiameterM,
    massKg,
    moiKgM2: massKg * (robot.l * robot.l + robot.w * robot.w) / 12,
    wheelbaseM: Math.max(0.2, robot.l - 0.18),
    trackwidthM: Math.max(0.2, robot.w - 0.18),
    wheelFrictionCoefficient: 1.2,
  };
}

/** Planning defaults for fields a project does not set. */
export const ELECTRICAL_DRIVE_DEFAULTS = {
  batteryVoltageV: 12,
  // Battery internal plus main wiring resistance under load. The MK ES17-12 datasheet
  // lists about 12 mOhm at 1 kHz, which understates DC sag; wiring adds a few mOhm.
  batteryResistanceOhm: 0.02,
  otherLoadA: 0,
  // Typical swerve gearing and wheel losses.
  driveEfficiency: 0.9,
  // Voltage and current kept for the path follower's correction.
  controlReserve: 0.1,
} as const;

/**
 * Effective electrical inputs: authored values, then the motor preset, then the
 * planning defaults. Returns null only when the motor's stall and free current are
 * unknown (a custom motor without them), which keeps the 12 V stall-torque line.
 */
export function resolveElectricalDriveInputs(model: DriveModel | undefined): { values: ElectricalDriveInputs; defaulted: ElectricalDriveKey[] } | null {
  if (!model) return null;
  const preset = driveMotorPreset(model.motorId);
  const defaulted: ElectricalDriveKey[] = [];
  const pick = (key: ElectricalDriveKey, valid: (value: number | undefined) => value is number, fallback: number | undefined) => {
    const value = model[key];
    if (valid(value)) return value;
    if (fallback !== undefined) defaulted.push(key);
    return fallback;
  };
  const stallCurrentA = pick("motorStallCurrentA", positive, preset?.stallCurrentA);
  const freeCurrentA = pick("motorFreeCurrentA", nonnegative, preset?.freeCurrentA);
  if (stallCurrentA === undefined || freeCurrentA === undefined) return null;
  const values: ElectricalDriveInputs = {
    motorStallCurrentA: stallCurrentA,
    motorFreeCurrentA: freeCurrentA,
    // A custom motor with known currents but no limit runs up to its stall current.
    driveCurrentLimitA: pick("driveCurrentLimitA", positive, preset?.defaultCurrentLimitA ?? stallCurrentA)!,
    batteryVoltageV: pick("batteryVoltageV", positive, ELECTRICAL_DRIVE_DEFAULTS.batteryVoltageV)!,
    batteryResistanceOhm: pick("batteryResistanceOhm", nonnegative, ELECTRICAL_DRIVE_DEFAULTS.batteryResistanceOhm)!,
    otherLoadA: pick("otherLoadA", nonnegative, ELECTRICAL_DRIVE_DEFAULTS.otherLoadA)!,
    driveEfficiency: pick("driveEfficiency", positive, ELECTRICAL_DRIVE_DEFAULTS.driveEfficiency)!,
    controlReserve: pick("controlReserve", nonnegative, ELECTRICAL_DRIVE_DEFAULTS.controlReserve)!,
  };
  return { values, defaulted };
}

export function hasElectricalDriveModel(model: DriveModel | undefined): boolean {
  return resolveElectricalDriveInputs(model) !== null;
}

/**
 * Timing must remain feasible even when command timing differs from the local preview. Command loads are
 * reserved per path, folded into Other mechanisms by planningRobotForPath before planning.
 */
export function peakMechanismCurrent(model: DriveModel): number {
  const bursts = model.loadBursts ?? [];
  const events = bursts.flatMap(burst => [{ t: burst.startTimeS, change: burst.currentA }, { t: burst.endTimeS, change: -burst.currentA }])
    .sort((a, b) => a.t - b.t || a.change - b.change);
  let current = model.otherLoadA ?? 0, peak = current;
  for (const event of events) { current += event.change; peak = Math.max(peak, current); }
  return peak;
}

/** Distinguish an electrically impossible configuration from an absent/custom model. */
export function electricalConfigurationError(robot: RobotConfig): string | null {
  const model = robot.driveModel, resolved = resolveElectricalDriveInputs(model);
  if (!model || !resolved) return null;
  const p = resolved.values;
  const windingR = 12 / p.motorStallCurrentA;
  if (p.motorFreeCurrentA * windingR >= 12) return 'Motor free current must be below stall current; review the motor data.';
  if (p.batteryVoltageV - p.batteryResistanceOhm * peakMechanismCurrent(model) <= (model.minimumBusVoltageV ?? 7.25)) {
    return 'Mechanism loads alone reach the minimum bus voltage; reduce Other mechanisms or the command loads this path starts, or review the battery settings.';
  }
  if (p.driveCurrentLimitA * (1 - p.controlReserve) <= p.motorFreeCurrentA) {
    return 'The planning current budget does not cover motor loss current; review the current limit and control reserve.';
  }
  const cap = p.batteryResistanceOhm > 0
    ? ((p.batteryVoltageV - (model.minimumBusVoltageV ?? 7.25)) / p.batteryResistanceOhm - peakMechanismCurrent(model)) / (model.motorCount ?? 4)
    : Infinity;
  if (cap <= p.motorFreeCurrentA) return 'The minimum bus voltage leaves no drive current budget; review the battery and mechanism loads.';
  if ((p.batteryVoltageV - p.batteryResistanceOhm * peakMechanismCurrent(model)) * (1 - p.controlReserve)
    <= p.motorFreeCurrentA * (windingR + (model.motorCount ?? 4) * p.batteryResistanceOhm)) {
    return 'Battery resistance and control reserve leave no usable motor voltage; review the electrical settings.';
  }
  return null;
}

// DC motor model from the datasheet stall/free figures at 12 V (as in the LabVIEW
// motor-sim): R = 12/I_stall, Kt = tau_stall/I_stall, Kv = w_free/(12 - I_free*R).
// At full duty the battery sag Vbus = V0 - R_bat*(N*I_supply + I_other) acts as N*R_bat
// of extra series resistance per motor, so the torque-speed line stays linear in speed.
function electricalModel(model: DriveModel): DriveElectricalModel | null {
  const resolved = resolveElectricalDriveInputs(model);
  if (!resolved) return null;
  const inputs = resolved.values;
  const stallCurrentA = inputs.motorStallCurrentA;
  const freeCurrentA = inputs.motorFreeCurrentA;
  const resistanceOhm = DATASHEET_VOLTAGE_V / stallCurrentA;
  const freeSpeedRadps = model.motorFreeRpm * 2 * Math.PI / 60;
  const backEmfAtFreeV = DATASHEET_VOLTAGE_V - freeCurrentA * resistanceOhm;
  if (!(backEmfAtFreeV > 0)) return null;
  const reserve = Math.min(0.5, inputs.controlReserve);
  const efficiency = Math.min(1, inputs.driveEfficiency);
  const otherLoad = peakMechanismCurrent(model);
  const minimumBus = model.minimumBusVoltageV ?? 7.25;
  // Supply current never exceeds stator current in a feasible motoring state.
  // This conservative cap gives the timing solver a brownout constraint before
  // the shared-bus, unequal-module check in dense validation.
  const brownoutCap = inputs.batteryResistanceOhm > 0
    ? Math.max(0, ((inputs.batteryVoltageV - minimumBus) / inputs.batteryResistanceOhm - otherLoad) / model.motorCount!)
    : Infinity;
  return {
    resistanceOhm,
    effectiveResistanceOhm: resistanceOhm + model.motorCount! * inputs.batteryResistanceOhm,
    torqueConstantNmPerA: model.motorMaxTorqueNm! / stallCurrentA,
    velocityConstantRadpsPerV: freeSpeedRadps / backEmfAtFreeV,
    availableVoltageV: (inputs.batteryVoltageV - inputs.batteryResistanceOhm * otherLoad) * (1 - reserve),
    currentCapA: Math.max(0, Math.min(inputs.driveCurrentLimitA * (1 - reserve), brownoutCap) - freeCurrentA),
    freeCurrentA,
    efficiency,
  };
}

export function robotHardLimits(robot: RobotConfig): RobotHardLimits | null {
  const model = robot.driveModel;
  if (!model) return null;
  const values = [
    model.motorFreeRpm,
    model.motorMaxTorqueNm,
    model.motorCount,
    model.gearRatio,
    model.wheelDiameterM,
    model.massKg,
    model.moiKgM2,
    model.wheelbaseM,
    model.trackwidthM,
    model.wheelFrictionCoefficient,
  ];
  if (!values.every((value) => Number.isFinite(value) && value! > 0)) return null;

  const wheelRadiusM = model.wheelDiameterM / 2;
  // Chassis acceleration per newton-meter of total motor torque.
  const accelPerMotorTorque = model.motorCount! * model.gearRatio / (wheelRadiusM * model.massKg!);
  const electrical = electricalModel(model);
  let maxSpeedMps: number;
  let motorAccelMps2: number;
  let motorCapAccelMps2: number;
  let brakingCapAccelMps2: number;
  if (electrical) {
    const kt = electrical.torqueConstantNmPerA * electrical.efficiency;
    const voltage = electrical.availableVoltageV;
    // Torque current I = (V - w/Kv)/R_eff - I_free falls to zero at w = (V - I_free*R_eff)*Kv.
    const zeroTorqueMotorRadps = (voltage - electrical.freeCurrentA * electrical.effectiveResistanceOhm)
      * electrical.velocityConstantRadpsPerV;
    if (!(zeroTorqueMotorRadps > 0) || !(electrical.currentCapA > 0)) return null;
    maxSpeedMps = zeroTorqueMotorRadps * wheelRadiusM / model.gearRatio;
    motorAccelMps2 = accelPerMotorTorque * kt
      * (voltage / electrical.effectiveResistanceOhm - electrical.freeCurrentA);
    motorCapAccelMps2 = accelPerMotorTorque * kt * electrical.currentCapA;
    // Back-EMF adds to a reversed drive voltage, so braking is limited by current only.
    brakingCapAccelMps2 = accelPerMotorTorque * kt * Math.min(
      electrical.currentCapA,
      voltage / electrical.resistanceOhm - electrical.freeCurrentA,
    );
  } else {
    maxSpeedMps = model.motorFreeRpm / 60 * Math.PI * model.wheelDiameterM / model.gearRatio;
    motorAccelMps2 = accelPerMotorTorque * model.motorMaxTorqueNm!;
    motorCapAccelMps2 = motorAccelMps2;
    brakingCapAccelMps2 = motorAccelMps2;
  }
  const tractionAccelMps2 = model.wheelFrictionCoefficient! * GRAVITY_MPS2;
  const equalLoadAccelMps2 = Math.min(motorCapAccelMps2, motorAccelMps2, tractionAccelMps2);
  const cgHeightM = resolveCgHeightM(model).value;
  let maxAccelMps2 = equalLoadAccelMps2;
  let maxDecelMps2 = Math.min(brakingCapAccelMps2, tractionAccelMps2);
  let maxCornerAccelMps2 = tractionAccelMps2;
  if (cgHeightM > 0) {
    // Hard launches unload the leading wheels. Each envelope is the better of the
    // robot's two axes; the planner's per-module limits handle every other direction.
    const transfer = loadTransferEnvelope(robot, model, cgHeightM, Math.min(motorCapAccelMps2, motorAccelMps2), brakingCapAccelMps2);
    maxAccelMps2 = Math.min(maxAccelMps2, transfer.accelMps2);
    maxDecelMps2 = Math.min(maxDecelMps2, transfer.decelMps2);
    maxCornerAccelMps2 = Math.min(maxCornerAccelMps2, transfer.cornerMps2);
  }
  const moduleRadiusM = robot.drive === "tank"
    ? model.trackwidthM! / 2
    : Math.hypot(model.wheelbaseM! / 2, model.trackwidthM! / 2);
  const maxAngularSpeedDegps = maxSpeedMps / moduleRadiusM * RADIANS_TO_DEGREES;
  // Pure rotation does not accelerate the CG, so it transfers no load.
  const maxAngularAccelDegps2 = equalLoadAccelMps2 * model.massKg! * moduleRadiusM
    / model.moiKgM2! * RADIANS_TO_DEGREES;
  return {
    maxSpeedMps,
    maxAccelMps2,
    maxDecelMps2,
    maxCornerAccelMps2,
    maxAngularSpeedDegps,
    maxAngularAccelDegps2,
    motorAccelMps2,
    motorCapAccelMps2,
    brakingCapAccelMps2,
    tractionAccelMps2,
    cgHeightM,
    electrical,
  };
}

/**
 * Straight-line launch, braking and cornering limits with load transfer, along
 * the robot's better axis. Drive force per wheel is capped by its share of the
 * motor limit; the lightly loaded wheels are capped by friction on their load.
 */
function loadTransferEnvelope(
  robot: RobotConfig,
  model: DriveModel,
  cgHeightM: number,
  motoringAccelMps2: number,
  brakingAccelMps2: number,
): { accelMps2: number; decelMps2: number; cornerMps2: number } {
  const massKg = model.massKg!;
  const mu = model.wheelFrictionCoefficient!;
  // Planning asks for the same robot's limits at every path point.
  const inputs = [robot.drive === "tank" ? 1 : 0, model.wheelbaseM!, model.trackwidthM!, massKg, cgHeightM, mu, motoringAccelMps2, brakingAccelMps2];
  const cached = loadTransferEnvelopeCache.get(model);
  if (cached && cached.inputs.every((value, index) => value === inputs[index])) return cached.envelope;
  const { contacts, loads } = robotLoadModel(robot, massKg, cgHeightM);
  const share = massKg / Math.max(1, contacts.length);
  const best = (capN: number) => Math.max(
    directionalAccelerationLimit(loads.static, loads.perAccelX, mu, capN, massKg),
    directionalAccelerationLimit(loads.static, loads.perAccelY, mu, capN, massKg),
  );
  const envelope = {
    accelMps2: best(motoringAccelMps2 * share),
    decelMps2: best(brakingAccelMps2 * share),
    cornerMps2: best(Number.POSITIVE_INFINITY),
  };
  loadTransferEnvelopeCache.set(model, { inputs, envelope });
  return envelope;
}

const loadTransferEnvelopeCache = new WeakMap<object, {
  inputs: number[];
  envelope: { accelMps2: number; decelMps2: number; cornerMps2: number };
}>();

// Use the robot envelope when creating a path. Existing numeric constraints
// remain authored caps, including in older files without default provenance.
export function robotDefaultConstraints(constraints: PathConstraints, robot: RobotConfig): PathConstraints {
  const limits = robotHardLimits(robot);
  if (!limits) return constraints;
  return {
    ...constraints,
    maxVel: limits.maxSpeedMps,
    maxAccel: limits.maxAccelMps2,
    maxDecel: limits.maxDecelMps2,
    maxCentripetalAccel: limits.maxCornerAccelMps2,
    maxAngVel: limits.maxAngularSpeedDegps,
    maxAngAccel: limits.maxAngularAccelDegps2,
    maxAngDecel: limits.maxAngularAccelDegps2,
  };
}

/**
 * What the robot allows for each limit a path or zone sets. Planning uses the lower of the authored limit and this, so
 * an authored limit above it is capped. A robot without a drivetrain model enforces only its top speed.
 */
export function robotLimitCeilings(robot: RobotConfig): LimitCeilings {
  const limits = robotHardLimits(robot);
  if (!limits) return { maxVel: robot.maxSpeed };
  return { maxVel: limits.maxSpeedMps, maxAccel: limits.maxAccelMps2, maxDecel: limits.maxDecelMps2, maxCentripetalAccel: limits.maxCornerAccelMps2,
    maxAngVel: limits.maxAngularSpeedDegps, maxAngAccel: limits.maxAngularAccelDegps2 };
}

export type LimitCeilings = Partial<Record<"maxVel" | "maxAccel" | "maxDecel" | "maxCentripetalAccel" | "maxAngVel" | "maxAngAccel", number>>;

/** Path limits that can follow the robot's max, in the order `followRobotMax` keeps them. */
export const FOLLOWABLE_LIMITS: readonly FollowableLimit[] = ["maxVel", "maxAccel", "maxCentripetalAccel", "maxAngVel", "maxAngAccel"];

/**
 * The path limits with each limit in `followRobotMax` at the robot's ceiling: `ceilings` are robotLimitCeilings of the
 * path's planning robot (its command reserve included). Following maxAccel also sets maxDecel to its own ceiling, and
 * following maxAngAccel sets maxAngDecel too, as the editor sets each pair together. A followed limit the robot has no
 * ceiling for keeps its number.
 */
export function followRobotLimits(constraints: PathConstraints, ceilings: LimitCeilings): PathConstraints {
  const followed = constraints.followRobotMax;
  if (!Array.isArray(followed) || !followed.length) return constraints;
  const next = { ...constraints };
  for (const key of followed) {
    const ceiling = ceilings[key];
    if (ceiling === undefined || !Number.isFinite(ceiling)) continue;
    next[key] = ceiling;
    if (key === "maxAccel") next.maxDecel = ceilings.maxDecel ?? ceiling;
    if (key === "maxAngAccel") next.maxAngDecel = ceiling;
  }
  return next;
}

/**
 * Turns following the robot's max on or off for one limit. Turning it off keeps the robot's current ceiling as the
 * fixed number (and its pair's, as followRobotLimits sets them); without a ceiling the stored number stays.
 */
export function setFollowRobotMax(constraints: PathConstraints, key: FollowableLimit, on: boolean, ceilings: LimitCeilings): PathConstraints {
  const current = Array.isArray(constraints.followRobotMax) ? constraints.followRobotMax : [];
  if (current.includes(key) === on) return constraints;
  const followRobotMax = FOLLOWABLE_LIMITS.filter((item) => item === key ? on : current.includes(item));
  const { followRobotMax: _old, ...rest } = constraints;
  // Off: the limit (and its pair) becomes fixed at what it planned at while following.
  const { followRobotMax: _key, ...fixed } = on ? { ...rest, followRobotMax: [] } : followRobotLimits({ ...rest, followRobotMax: [key] }, ceilings);
  return followRobotMax.length ? { ...fixed, followRobotMax } : fixed;
}

/** followRobotLimits with the ceilings of `robot`, computed only when a limit follows it. */
function followedLimits(constraints: PathConstraints, robot: RobotConfig): PathConstraints {
  return constraints.followRobotMax?.length ? followRobotLimits(constraints, robotLimitCeilings(robot)) : constraints;
}

/** The limits planning uses for a path on `robot` (its planning robot): followed limits at the robot's max, the rest capped by it. */
export function effectivePathConstraints(constraints: PathConstraints, robot: RobotConfig): PathConstraints {
  const authored = followedLimits(constraints, robot);
  const limits = robotDefaultConstraints(authored, robot);
  if (limits === authored) return authored;
  return {
    ...authored,
    maxVel: Math.min(authored.maxVel, limits.maxVel),
    maxAccel: Math.min(authored.maxAccel, limits.maxAccel),
    maxDecel: Math.min(authored.maxDecel ?? authored.maxAccel, limits.maxDecel),
    maxCentripetalAccel: Math.min(authored.maxCentripetalAccel ?? authored.maxAccel, limits.maxCentripetalAccel!),
    maxAngVel: Math.min(authored.maxAngVel, limits.maxAngVel),
    maxAngAccel: Math.min(authored.maxAngAccel, limits.maxAngAccel),
    maxAngDecel: Math.min(authored.maxAngDecel || authored.maxAngAccel, limits.maxAngDecel!),
  };
}

/** Plans at the drivetrain's free speed and the stricter of authored and hard limits; returns `input` without a drive model. */
export function physicalPlannerInput(input: PlannerInput): PlannerInput {
  const planningRobot = planningRobotForPath(input.robot, input.path);
  const limits = robotHardLimits(planningRobot);
  if (!limits) {
    // Without a drivetrain model only top speed has a ceiling; a followed speed limit plans at it.
    const constraints = followedLimits(input.path.constraints, planningRobot);
    if (planningRobot === input.robot && constraints === input.path.constraints) return input;
    return { ...input, robot: planningRobot, ...(constraints === input.path.constraints ? {} : { path: { ...input.path, constraints } }) };
  }
  const robot = { ...planningRobot, maxSpeed: limits.maxSpeedMps };
  return { ...input, robot, path: { ...input.path, constraints: effectivePathConstraints(input.path.constraints, robot) } };
}

/**
 * The path limits planning uses for `path` on `robot` (the project's robot, with its id and legacy loads): followed
 * limits at the ceiling of the path's planning robot, its command reserve included, and the rest capped by it. Tools
 * that measure a plan against its limits, or write a zone from them, read these instead of the stored numbers.
 */
export function planningPathConstraints(path: PathDoc, robot: RobotConfig): PathConstraints {
  return physicalPlannerInput({ path, robot }).path.constraints;
}
