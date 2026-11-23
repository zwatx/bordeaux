import type { BreakerModel, RobotConfig } from './types';
import { resolveElectricalDriveInputs } from './robotLimits';

export const DEFAULT_MINIMUM_BUS_VOLTAGE_V = 7.25;
export function minimumBusVoltage(robot: RobotConfig): number {
  return robot.driveModel?.minimumBusVoltageV ?? DEFAULT_MINIMUM_BUS_VOLTAGE_V;
}

/** Half-open intervals; overlapping mechanisms add. No schedule is inferred from command names. */
export function mechanismCurrent(robot: RobotConfig, timeS: number): number {
  const model = robot.driveModel;
  return (model?.otherLoadA ?? 0) + (model?.loadBursts ?? []).reduce((sum, burst) =>
    sum + (timeS >= burst.startTimeS && timeS < burst.endTimeS ? burst.currentA : 0), 0);
}

export interface MotorDemand { label: string; speedMps: number; forceN: number }
export interface MotorPower {
  label: string;
  statorCurrentA: number;
  supplyCurrentA: number;
  requiredVoltageV: number;
  dutyCycle: number;
}
export interface BusPrediction {
  busVoltageV: number;
  totalSupplyCurrentA: number;
  otherCurrentA: number;
  drivePowerW: number;
  collapsed: boolean;
  voltageUtilization: number;
  currentUtilization: number;
  motors: MotorPower[];
}

/**
 * Evaluate the requested wrench, never clip it to what the battery can deliver.
 * The battery supplies positive electrical power only: no regeneration credit.
 * V = Voc - R*(Iother + P/V), using the stable high-voltage quadratic root.
 * Motor count can exceed contact count (e.g. two drive motors per tank side).
 */
export function predictBus(robot: RobotConfig, demands: readonly MotorDemand[], otherCurrentA: number): BusPrediction | null {
  const model = robot.driveModel, resolved = resolveElectricalDriveInputs(model);
  if (!model || !resolved || !demands.length) return null;
  const p = resolved.values;
  const count = model.motorCount ?? demands.length;
  const perContact = count / demands.length;
  const r = 12 / p.motorStallCurrentA;
  const kt = model.motorMaxTorqueNm! / p.motorStallCurrentA;
  const kv = model.motorFreeRpm * 2 * Math.PI / 60 / (12 - p.motorFreeCurrentA * r);
  const radius = model.wheelDiameterM / 2;
  if (!(kt > 0 && kv > 0 && radius > 0 && perContact > 0)) return null;
  const motor = demands.map(demand => {
    const speed = Math.abs(demand.speedMps);
    const torqueCurrent = demand.forceN * radius / (model.gearRatio * p.driveEfficiency * kt * perContact);
    // Loss current opposes motion. At rest, a requested holding/launch force still consumes copper power.
    const current = torqueCurrent + (speed > 1e-9 ? p.motorFreeCurrentA : 0);
    const voltage = speed * model.gearRatio / radius / kv + r * current;
    const power = Math.max(0, voltage * current) * perContact;
    return { label: demand.label, current, voltage, power };
  });
  const power = motor.reduce((sum, value) => sum + value.power, 0);
  const unloaded = p.batteryVoltageV - p.batteryResistanceOhm * otherCurrentA;
  const discriminant = unloaded ** 2 - 4 * p.batteryResistanceOhm * power;
  const collapsed = unloaded <= 0 || discriminant < 0;
  const bus = collapsed ? 0 : (unloaded + Math.sqrt(discriminant)) / 2;
  const usable = bus * (1 - p.controlReserve);
  const motors = motor.map(value => ({
    label: value.label, statorCurrentA: Math.abs(value.current),
    // Demand-side values may exceed duty 1: that is infeasibility, not a silently clipped prediction.
    supplyCurrentA: bus > 0 ? value.power / bus / perContact : Number.POSITIVE_INFINITY,
    requiredVoltageV: Math.abs(value.voltage), dutyCycle: bus > 0 ? Math.abs(value.voltage) / bus : Number.POSITIVE_INFINITY,
  }));
  return {
    busVoltageV: bus, totalSupplyCurrentA: bus > 0 ? otherCurrentA + power / bus : Number.POSITIVE_INFINITY,
    otherCurrentA, drivePowerW: power, collapsed,
    voltageUtilization: Math.max(...motors.map(value => value.requiredVoltageV / Math.max(1e-9, usable))),
    currentUtilization: Math.max(...motors.map(value => value.statorCurrentA / (p.driveCurrentLimitA * (1 - p.controlReserve)))),
    motors,
  };
}

/** First-order I² heating with cooling. Fits one point of a cold trip curve; not a certified trip predictor. */
export function breakerHeat(model: BreakerModel, heat: number, currentA: number, durationS: number): number {
  if (durationS <= 0) return heat;
  const tau = model.tripTimeAt2xS / Math.log(4 / 3);
  const decay = Math.exp(-durationS / tau);
  return heat * decay + (currentA / model.ratedCurrentA) ** 2 * (1 - decay);
}

export interface PowerInterval { startTimeS: number; endTimeS: number; bus: BusPrediction }
export interface PowerReport {
  minimumBusVoltageV: number;
  peakSupplyCurrentA: number;
  peakStatorCurrentA: number;
  mainBreakerPeakHeat: number | null;
  driveBreakerPeakHeat: number | null;
  mainBreakerEndHeat: number | null;
  driveBreakerEndHeat: number[] | null;
  brownoutRisk: boolean;
  voltageOverload: boolean;
  currentOverload: boolean;
  collapsed: boolean;
  durationS: number;
}

/** Carries thermal state across every interval, including waits; callers may concatenate entire routines. */
export function summarizePower(robot: RobotConfig, intervals: readonly PowerInterval[]): PowerReport {
  const main = robot.driveModel?.mainBreaker, drive = robot.driveModel?.driveBreaker;
  let mainHeat = main?.initialHeat ?? 0, mainPeak = mainHeat;
  let driveHeat = intervals[0]?.bus.motors.map(() => drive?.initialHeat ?? 0) ?? [];
  let drivePeak = drive?.initialHeat ?? 0;
  let minV = Infinity, supply = 0, stator = 0, voltageOverload = false, currentOverload = false, collapsed = false;
  for (const interval of intervals) {
    const dt = interval.endTimeS - interval.startTimeS, bus = interval.bus;
    if (!(dt > 0)) continue;
    minV = Math.min(minV, bus.busVoltageV); supply = Math.max(supply, bus.totalSupplyCurrentA);
    voltageOverload ||= bus.voltageUtilization > 1.01;
    currentOverload ||= bus.currentUtilization > 1.01;
    collapsed ||= bus.collapsed;
    if (main) { mainHeat = breakerHeat(main, mainHeat, bus.totalSupplyCurrentA, dt); mainPeak = Math.max(mainPeak, mainHeat); }
    bus.motors.forEach((motor, index) => {
      stator = Math.max(stator, motor.statorCurrentA);
      if (drive) {
        driveHeat[index] = breakerHeat(drive, driveHeat[index] ?? drive.initialHeat, motor.supplyCurrentA, dt);
        drivePeak = Math.max(drivePeak, driveHeat[index]);
      }
    });
  }
  return { minimumBusVoltageV: minV, peakSupplyCurrentA: supply, peakStatorCurrentA: stator,
    mainBreakerPeakHeat: main ? mainPeak : null, driveBreakerPeakHeat: drive ? drivePeak : null,
    mainBreakerEndHeat: main ? mainHeat : null, driveBreakerEndHeat: drive ? driveHeat : null,
    brownoutRisk: minV < minimumBusVoltage(robot) - 0.01, voltageOverload, currentOverload, collapsed,
    durationS: intervals.length ? intervals[intervals.length - 1].endTimeS - intervals[0].startTimeS : 0 };
}
