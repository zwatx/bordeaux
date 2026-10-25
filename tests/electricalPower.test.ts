import { describe, expect, it } from 'vitest';
import { breakerHeat, mechanismCurrent, predictBus, summarizePower } from '../src/shared/electricalPower';
import { peakMechanismCurrent, robotHardLimits, electricalConfigurationError } from '../src/shared/robotLimits';
import { REV_40A_ATO_BREAKER, BUSSMANN_185_120A_BREAKER } from '../src/shared/breakerPresets';
import { createDemoProject, buildWaypoints } from '../src/shared/project/defaults';
import { analyzeRoutinePower, analyzeTrajectoryPower, idlePowerIntervals } from '../src/shared/planners/trajectoryPower';
import { getPlanner } from '../src/shared/planners';
import { planPath } from '../src/shared/planners/planPath';
import { validateOptimizedTrajectory } from '../src/shared/planners/trajectoryValidation';
import { validateProject } from '../src/shared/validation';
import type { RobotConfig } from '../src/shared/types';

function robot(): RobotConfig {
  return { ...createDemoProject().robot, driveModel: {
    motorId: 'rev-vortex', motorFreeRpm: 6784, motorMaxTorqueNm: 3.6, motorCount: 4,
    gearRatio: 5.5, wheelDiameterM: 0.0762, massKg: 54, moiKgM2: 5, wheelbaseM: 0.52, trackwidthM: 0.61,
    wheelFrictionCoefficient: 1.2, cgHeightM: 0.25, motorStallCurrentA: 211, motorFreeCurrentA: 3.6,
    driveCurrentLimitA: 55, batteryVoltageV: 12.5, batteryResistanceOhm: 0.02, driveEfficiency: 0.9, controlReserve: 0.1,
  } };
}
const demands = (forceN: number, speedMps: number) => ['LF', 'RF', 'LB', 'RB'].map(label => ({ label, forceN, speedMps }));
const curve = { ratedCurrentA: 40, tripTimeAt2xS: 5, initialHeat: 0 };

describe('shared electrical bus', () => {
  it('satisfies battery voltage and motor electrical power balance for unequal loads', () => {
    const r = robot();
    const bus = predictBus(r, demands(50, 2).map((d, i) => ({ ...d, forceN: 25 + 15 * i, speedMps: 1 + i * 0.3 })), 20)!;
    expect(bus.collapsed).toBe(false);
    expect(bus.busVoltageV).toBeCloseTo(12.5 - 0.02 * bus.totalSupplyCurrentA, 10);
    expect(bus.busVoltageV * (bus.totalSupplyCurrentA - 20)).toBeCloseTo(bus.drivePowerW, 10);
    expect(bus.motors[0].supplyCurrentA).not.toBeCloseTo(bus.motors[3].supplyCurrentA);
    for (const m of bus.motors) expect(m.supplyCurrentA).toBeCloseTo(m.statorCurrentA * m.dutyCycle, 10);
  });
  it('uses less battery current than stator current in a low-duty launch', () => {
    const bus = predictBus(robot(), demands(70, 0), 0)!;
    expect(bus.motors[0].statorCurrentA).toBeGreaterThan(30);
    expect(bus.motors[0].supplyCurrentA).toBeLessThan(bus.motors[0].statorCurrentA / 3);
    expect(bus.drivePowerW).toBeGreaterThan(0);
  });
  it('handles zero resistance and rejects impossible constant-power loads without clipping', () => {
    const r = robot(); r.driveModel!.batteryResistanceOhm = 0;
    expect(predictBus(r, demands(50, 2), 80)!.busVoltageV).toBe(12.5);
    r.driveModel!.batteryResistanceOhm = 0.1;
    const bus = predictBus(r, demands(500, 5), 100)!;
    expect(bus.collapsed).toBe(true);
    expect(bus.busVoltageV).toBe(0);
    expect(bus.voltageUtilization).toBeGreaterThan(1);
  });
  it('gives no regeneration credit during braking but includes plugging copper loss near rest', () => {
    const r = robot();
    const braking = predictBus(r, demands(-50, 3), 10)!;
    expect(braking.totalSupplyCurrentA).toBe(10);
    expect(braking.busVoltageV).toBe(12.3);
    expect(predictBus(r, demands(-50, 0.01), 10)!.totalSupplyCurrentA).toBeGreaterThan(10);
  });
  it('splits contact torque across multiple motors while conserving total power', () => {
    const r = robot(); r.driveModel!.motorCount = 8;
    const bus = predictBus(r, demands(100, 1), 0)!;
    expect(bus.totalSupplyCurrentA).toBeCloseTo(2 * bus.motors.reduce((sum, m) => sum + m.supplyCurrentA, 0), 10);
  });
  it('sums overlapping burst loads with half-open boundaries and finds the actual peak', () => {
    const r = robot(); r.driveModel!.otherLoadA = 10;
    r.driveModel!.loadBursts = [{ startTimeS: 0, endTimeS: 2, currentA: 20 }, { startTimeS: 1, endTimeS: 3, currentA: 40 }, { startTimeS: 3, endTimeS: 4, currentA: 60 }];
    expect([0, 1, 2, 3, 4].map(t => mechanismCurrent(r, t))).toEqual([30, 70, 50, 70, 10]);
    expect(peakMechanismCurrent(r.driveModel!)).toBe(70);
    expect(idlePowerIntervals(r, 0, 4).map(i => i.bus.otherCurrentA)).toEqual([30, 70, 50, 70]);
  });
  it('lowers the timing cap for a weak battery, higher voltage floor, or overlapping mechanism load', () => {
    const r = robot(); const base = robotHardLimits(r)!;
    r.driveModel!.minimumBusVoltageV = 10;
    expect(robotHardLimits(r)!.motorCapAccelMps2).toBeLessThan(base.motorCapAccelMps2);
    const floor = robotHardLimits(r)!.motorCapAccelMps2;
    r.driveModel!.loadBursts = [{ startTimeS: 1, endTimeS: 2, currentA: 20 }];
    expect(robotHardLimits(r)!.motorCapAccelMps2).toBeLessThan(floor);
  });
});

describe('breaker thermal estimate', () => {
  it('fits the documented REV point and the approximate Bussmann graph point', () => {
    expect(breakerHeat(REV_40A_ATO_BREAKER, 0, 80, 5)).toBeCloseTo(1, 12);
    expect(breakerHeat(BUSSMANN_185_120A_BREAKER, 0, 240, 10)).toBeCloseTo(1, 12);
  });
  it('matches the specified cold 2x trip time and cools exponentially', () => {
    expect(breakerHeat(curve, 0, 80, 5)).toBeCloseTo(1, 12);
    expect(breakerHeat(curve, 0, 80, 0.1)).toBeLessThan(0.1);
    expect(breakerHeat(curve, 1, 0, 5 / Math.log(4 / 3))).toBeCloseTo(Math.exp(-1), 12);
    expect(breakerHeat(curve, 0.5, 40, 100)).toBeLessThan(1);
  });
  it('preserves heat across bursts and is independent of interval subdivision', () => {
    const once = breakerHeat(curve, 0.4, 70, 3);
    let split = 0.4;
    for (let i = 0; i < 300; i++) split = breakerHeat(curve, split, 70, 0.01);
    expect(split).toBeCloseTo(once, 12);
    expect(breakerHeat(curve, 0.4, 80, 5)).toBeGreaterThan(1);
  });
  it('uses battery current for the main breaker and per-motor supply current for branches', () => {
    const r = robot(); r.driveModel!.mainBreaker = { ...curve, ratedCurrentA: 120 }; r.driveModel!.driveBreaker = curve;
    const bus = predictBus(r, demands(70, 0), 80)!;
    const report = summarizePower(r, [{ startTimeS: 0, endTimeS: 5, bus }]);
    expect(report.mainBreakerPeakHeat).toBeCloseTo(breakerHeat(r.driveModel!.mainBreaker, 0, bus.totalSupplyCurrentA, 5), 12);
    expect(report.driveBreakerPeakHeat).toBeCloseTo(breakerHeat(curve, 0, bus.motors[0].supplyCurrentA, 5), 12);
    delete r.driveModel!.driveBreaker;
    expect(summarizePower(r, [{ startTimeS: 0, endTimeS: 5, bus }]).driveBreakerPeakHeat).toBeNull();
  });
});

describe('path and routine integration', () => {
  it('distinguishes a zero-speed electrical envelope from an absent motor model', () => {
    const r = robot(); Object.assign(r.driveModel!, { batteryVoltageV: 12, batteryResistanceOhm: 0.5, minimumBusVoltageV: 1, controlReserve: 0.5 });
    expect(robotHardLimits(r)).toBeNull();
    expect(electricalConfigurationError(r)).toMatch(/no usable motor voltage/);
    expect(planPath({ robot: r, path: createDemoProject().paths[0] }).status).not.toBe('ok');
  });
  it('fails closed when mechanism current alone exhausts the battery budget', () => {
    const r = robot(), path = createDemoProject().paths[0];
    r.driveModel!.otherLoadA = 300;
    expect(robotHardLimits(r)).toBeNull();
    expect(planPath({ robot: r, path }).status).not.toBe('ok');
    expect(() => getPlanner('profiledSpline').generate({ robot: r, path })).toThrow(/Mechanism loads/);
    expect(validateOptimizedTrajectory({ robot: r, path }, []).violations[0].message).toMatch(/Mechanism loads/);
  });
  it('plans a hard launch within shared-bus limits and accumulates heat through repeated paths and waits', () => {
    const r = robot(), path = createDemoProject().paths[0];
    path.waypoints = buildWaypoints([{ x: 1, y: 2, theta: 0 }, { x: 5, y: 2, theta: 0 }]);
    path.waypoints.forEach(w => { w.stop = true; w.thetaOn = true; });
    path.headingMode = 'manual'; path.ranges = []; path.targets = [];
    path.constraints = { maxVel: 5, maxAccel: 15, maxDecel: 15, maxAngVel: 720, maxAngAccel: 2000 };
    r.driveModel!.mainBreaker = { ...curve, ratedCurrentA: 120 };
    const trajectory = getPlanner('profiledSpline').generate({ path, robot: r });
    expect(trajectory.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    expect(validateOptimizedTrajectory({ path, robot: r }, trajectory.samples, { angularKinematics: 'sample' }).violations).toEqual([]);
    const report = analyzeTrajectoryPower(r, path, trajectory.samples)!;
    expect(report.minimumBusVoltageV).toBeGreaterThanOrEqual(7.25);
    expect(report.currentOverload).toBe(false);
    expect(report.voltageOverload).toBe(false);
    const t = trajectory.totalTimeS;
    const routine = analyzeRoutinePower(r, [{ t0: 0, t1: t, doc: path, trajectory }, { t0: t + 0.1, t1: t * 2 + 0.1, doc: path, trajectory }], t * 2 + 0.1)!;
    expect(routine.mainBreakerPeakHeat).toBeGreaterThan(report.mainBreakerPeakHeat!);
    expect(routine.durationS).toBeCloseTo(t * 2 + 0.1, 9);
  });
  it('validates malformed curves, burst intervals and voltage floors', () => {
    const project = createDemoProject(); project.robot = robot();
    project.robot.driveModel!.mainBreaker = { ratedCurrentA: 0, tripTimeAt2xS: NaN, initialHeat: 2 };
    project.robot.driveModel!.loadBursts = [{ startTimeS: 2, endTimeS: 1, currentA: -1 }];
    project.robot.driveModel!.minimumBusVoltageV = 15;
    const issues = validateProject(project).issues;
    expect(issues.some(i => i.path.endsWith('.mainBreaker'))).toBe(true);
    expect(issues.some(i => i.path.includes('.loadBursts'))).toBe(true);
    expect(issues.some(i => i.path.endsWith('.minimumBusVoltageV'))).toBe(true);
  });
});
