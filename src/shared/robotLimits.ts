import { driveMotorPreset } from "./motorPresets";
import type { PathConstraints, PlannerInput, RobotConfig } from "./types";

const GRAVITY_MPS2 = 9.80665;
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
  tractionAccelMps2: number;
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
  return {
    resistanceOhm,
    effectiveResistanceOhm: resistanceOhm + model.motorCount! * inputs.batteryResistanceOhm,
    torqueConstantNmPerA: model.motorMaxTorqueNm! / stallCurrentA,
    velocityConstantRadpsPerV: freeSpeedRadps / backEmfAtFreeV,
    availableVoltageV: (inputs.batteryVoltageV - inputs.batteryResistanceOhm * inputs.otherLoadA) * (1 - reserve),
    currentCapA: inputs.driveCurrentLimitA * (1 - reserve),
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
  const maxAccelMps2 = Math.min(motorCapAccelMps2, motorAccelMps2, tractionAccelMps2);
  const maxDecelMps2 = Math.min(brakingCapAccelMps2, tractionAccelMps2);
  const moduleRadiusM = robot.drive === "tank"
    ? model.trackwidthM! / 2
    : Math.hypot(model.wheelbaseM! / 2, model.trackwidthM! / 2);
  const maxAngularSpeedDegps = maxSpeedMps / moduleRadiusM * RADIANS_TO_DEGREES;
  const maxAngularAccelDegps2 = maxAccelMps2 * model.massKg! * moduleRadiusM
    / model.moiKgM2! * RADIANS_TO_DEGREES;
  return {
    maxSpeedMps,
    maxAccelMps2,
    maxDecelMps2,
    maxCornerAccelMps2: tractionAccelMps2,
    maxAngularSpeedDegps,
    maxAngularAccelDegps2,
    motorAccelMps2,
    motorCapAccelMps2,
    brakingCapAccelMps2,
    tractionAccelMps2,
    electrical,
  };
}

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

export function effectivePathConstraints(constraints: PathConstraints, robot: RobotConfig): PathConstraints {
  const limits = robotDefaultConstraints(constraints, robot);
  if (limits === constraints) return constraints;
  return {
    ...constraints,
    maxVel: Math.min(constraints.maxVel, limits.maxVel),
    maxAccel: Math.min(constraints.maxAccel, limits.maxAccel),
    maxDecel: Math.min(constraints.maxDecel ?? constraints.maxAccel, limits.maxDecel),
    maxCentripetalAccel: Math.min(constraints.maxCentripetalAccel ?? constraints.maxAccel, limits.maxCentripetalAccel!),
    maxAngVel: Math.min(constraints.maxAngVel, limits.maxAngVel),
    maxAngAccel: Math.min(constraints.maxAngAccel, limits.maxAngAccel),
    maxAngDecel: Math.min(constraints.maxAngDecel || constraints.maxAngAccel, limits.maxAngDecel!),
  };
}

/** Plans at the drivetrain's free speed and the stricter of authored and hard limits; returns `input` without a drive model. */
export function physicalPlannerInput(input: PlannerInput): PlannerInput {
  const limits = robotHardLimits(input.robot);
  if (!limits) return input;
  const robot = { ...input.robot, maxSpeed: limits.maxSpeedMps };
  return { ...input, robot, path: { ...input.path, constraints: effectivePathConstraints(input.path.constraints, robot) } };
}
