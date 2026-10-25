import { describe, expect, it } from "vitest";
import { getPlanner } from "../src/shared/planners";
import { evaluateDrivetrainForces } from "../src/shared/planners/drivetrainProjection";
import type { CanonicalPathPoint } from "../src/shared/planners/pathState";
import { solveReachabilityProfile } from "../src/shared/planners/reachability";
import { buildWaypoints, createDemoProject } from "../src/shared/project/defaults";
import { driveMotorPreset } from "../src/shared/motorPresets";
import { ELECTRICAL_DRIVE_DEFAULTS, hasElectricalDriveModel, resolveElectricalDriveInputs, robotHardLimits } from "../src/shared/robotLimits";
import { validateProject } from "../src/shared/validation";
// @ts-expect-error The production preview engine is an intentional JavaScript module.
import { PM as RendererPM } from "../src/renderer/lib/pathMath";

const WHEEL_RADIUS_M = 0.0762 / 2;
const MASS_KG = 54.4310844;

// REV MAXSwerve with NEO Vortex drive (12T pinion, 5.50:1, 3 in wheels).
function maxSwerveProject(electrical = true) {
  // electrical=false: a custom motor without stall/free current keeps the stall-torque line.
  const project = createDemoProject();
  project.robot.w = 0.7;
  project.robot.l = 0.7;
  project.robot.driveModel = {
    motorId: electrical ? "rev-vortex" : "custom",
    motorFreeRpm: 6784,
    motorMaxTorqueNm: 3.6,
    motorCount: 4,
    gearRatio: 5.5,
    wheelDiameterM: 0.0762,
    massKg: MASS_KG,
    moiKgM2: 4,
    wheelbaseM: 0.55,
    trackwidthM: 0.55,
    wheelFrictionCoefficient: 1.2,
    // Isolate the electrical envelope and its equal-load closed forms.
    // Nonzero/default CG and exported load-dependent splits have separate tests.
    cgHeightM: 0,
    ...(electrical ? {
      motorStallCurrentA: 211,
      motorFreeCurrentA: 3.6,
      driveCurrentLimitA: 55,
      batteryVoltageV: 12.5,
      batteryResistanceOhm: 0.02,
      otherLoadA: 0,
      driveEfficiency: 0.9,
      controlReserve: 0,
    } : {}),
  };
  return project;
}

function straightLineAccel(limits: NonNullable<ReturnType<typeof robotHardLimits>>, speed: number) {
  return Math.min(limits.maxAccelMps2, limits.motorAccelMps2 * Math.max(0, 1 - speed / limits.maxSpeedMps));
}

describe("electrical drive model", () => {
  it("derives R, Kt and Kv from datasheet figures and folds battery sag into the line", () => {
    const limits = robotHardLimits(maxSwerveProject().robot)!;
    const resistance = 12 / 211;
    const kt = 3.6 / 211;
    const kv = 6784 * 2 * Math.PI / 60 / (12 - 3.6 * resistance);
    const effectiveResistance = resistance + 4 * 0.02;
    const perTorque = 4 * 5.5 / (WHEEL_RADIUS_M * MASS_KG);

    expect(limits.electrical!.resistanceOhm).toBeCloseTo(resistance, 12);
    expect(limits.electrical!.torqueConstantNmPerA).toBeCloseTo(kt, 12);
    expect(limits.electrical!.velocityConstantRadpsPerV).toBeCloseTo(kv, 9);
    expect(limits.motorCapAccelMps2).toBeCloseTo(perTorque * 0.9 * kt * (55 - 3.6), 9);
    expect(limits.motorAccelMps2).toBeCloseTo(perTorque * 0.9 * kt * (12.5 / effectiveResistance - 3.6), 9);
    expect(limits.maxSpeedMps).toBeCloseTo((12.5 - 3.6 * effectiveResistance) * kv * WHEEL_RADIUS_M / 5.5, 9);
    expect(limits.maxAccelMps2).toBeCloseTo(limits.motorCapAccelMps2, 9);
    expect(limits.maxDecelMps2).toBeCloseTo(limits.motorCapAccelMps2, 9);
  });

  it("matches the sag reference off the cap and accounts for loss current inside the stator cap", () => {
    const limits = robotHardLimits(maxSwerveProject().robot)!;
    // motor-envelope.mjs, 12.5 V / 0.02 ohm / 55 A / 90% scenario.
    // The historical reference capped torque current at 55 A, excluding 3.6 A loss current.
    expect(straightLineAccel(limits, 0)).toBeCloseTo(8.37, 2);
    expect(straightLineAccel(limits, 2)).toBeCloseTo(8.37, 2);
    expect(straightLineAccel(limits, 3)).toBeCloseTo(5.73, 2);
    expect(straightLineAccel(limits, 4)).toBeCloseTo(2.88, 2);
  });

  it("keeps the 12 V stall-torque line only for a custom motor without stall and free current", () => {
    const custom = maxSwerveProject(false).robot;
    expect(hasElectricalDriveModel(custom.driveModel)).toBe(false);
    const limits = robotHardLimits(custom)!;
    expect(limits.electrical).toBeNull();
    expect(limits.maxSpeedMps).toBeCloseTo(6784 / 60 * Math.PI * 0.0762 / 5.5, 9);
    expect(limits.motorAccelMps2).toBeCloseTo(4 * 3.6 * 5.5 / (WHEEL_RADIUS_M * MASS_KG), 9);
    expect(limits.maxDecelMps2).toBe(limits.maxAccelMps2);

    custom.driveModel = { ...custom.driveModel!, motorStallCurrentA: 211, motorFreeCurrentA: 3.6 };
    const resolved = resolveElectricalDriveInputs(custom.driveModel)!;
    // Known currents but no limit: the motor may draw up to its stall current.
    expect(resolved.values.driveCurrentLimitA).toBe(211);
    expect(robotHardLimits(custom)!.electrical).not.toBeNull();
  });

  it("plans every preset motor electrically, filling unset values from the preset and planning defaults", () => {
    const project = maxSwerveProject();
    const model = project.robot.driveModel!;
    for (const key of ["motorStallCurrentA", "motorFreeCurrentA", "driveCurrentLimitA", "batteryVoltageV", "batteryResistanceOhm", "otherLoadA", "driveEfficiency", "controlReserve"] as const) delete model[key];
    const vortex = resolveElectricalDriveInputs(model)!;
    expect(vortex.values).toEqual({
      motorStallCurrentA: 211,
      motorFreeCurrentA: 3.6,
      driveCurrentLimitA: 80,
      batteryVoltageV: ELECTRICAL_DRIVE_DEFAULTS.batteryVoltageV,
      batteryResistanceOhm: 0.02,
      otherLoadA: 0,
      driveEfficiency: 0.9,
      controlReserve: 0.1,
    });
    expect(vortex.defaulted).toHaveLength(8);
    expect(robotHardLimits(project.robot)!.electrical!.currentCapA).toBeCloseTo((12 - 7.25) / 0.02 / 4 - 3.6, 12);
    // Authored values win over defaults and are not reported as defaulted.
    expect(resolveElectricalDriveInputs({ ...model, driveCurrentLimitA: 55 })!.defaulted).not.toContain("driveCurrentLimitA");
    // Phoenix 6 TalonFX defaults to a 120 A stator limit.
    expect(resolveElectricalDriveInputs({ ...model, motorId: "ctre-kraken-x60" })!.values.driveCurrentLimitA).toBe(120);
  });

  it("applies the control reserve to available voltage and current", () => {
    const project = maxSwerveProject();
    const base = robotHardLimits(project.robot)!;
    project.robot.driveModel!.controlReserve = 0.1;
    const reserved = robotHardLimits(project.robot)!;
    expect(reserved.electrical!.availableVoltageV).toBeCloseTo(12.5 * 0.9, 12);
    expect(reserved.motorCapAccelMps2 / base.motorCapAccelMps2).toBeCloseTo((55 * 0.9 - 3.6) / (55 - 3.6), 9);
    expect(reserved.maxSpeedMps).toBeLessThan(base.maxSpeedMps);
  });

  it("shares the electrical limits with the renderer preview", () => {
    const robot = maxSwerveProject().robot;
    const shared = robotHardLimits(robot)!;
    const renderer = RendererPM.robotHardLimits(robot);
    expect(renderer.maxSpeed).toBe(shared.maxSpeedMps);
    expect(renderer.maxAccel).toBe(shared.maxAccelMps2);
    expect(renderer.maxDecel).toBe(shared.maxDecelMps2);
  });

  it("ships presets with all four datasheet figures", () => {
    const vortex = driveMotorPreset("rev-vortex")!;
    expect(vortex).toMatchObject({ freeRpm: 6784, stallTorqueNm: 3.6, stallCurrentA: 211, freeCurrentA: 3.6 });
    expect(driveMotorPreset("rev-neo-550")).toMatchObject({ freeRpm: 11000, stallCurrentA: 100 });
  });

  it("rejects out-of-range electrical fields", () => {
    const project = maxSwerveProject();
    project.robot.driveModel!.driveEfficiency = 1.2;
    project.robot.driveModel!.controlReserve = 0.8;
    project.robot.driveModel!.batteryResistanceOhm = -1;
    const paths = validateProject(project).issues.map((issue) => issue.path);
    expect(paths).toEqual(expect.arrayContaining([
      "$.robot.driveModel.driveEfficiency",
      "$.robot.driveModel.controlReserve",
      "$.robot.driveModel.batteryResistanceOhm",
    ]));
  });
});

describe("motoring-only torque-speed line", () => {
  const constraint = { u: 1, x: 0, minimum: -2, maximum: 2, velocityCoefficient: 1, freeSpeed: 2, motorAcceleration: 2 };
  const input = (motoringOnly: boolean) => ({
    positions: [0, 0.5, 1],
    velocityLimits: [10, 10, 10],
    accelerationLimits: [10, 10],
    decelerationLimits: [10, 10],
    freeSpeeds: [1e9, 1e9],
    scalarAccelerationConstraints: [[{ ...constraint, motoringOnly }], [{ ...constraint, motoringOnly }]],
    startVelocity: 1.9,
    goalVelocity: 0,
  });

  it("lets the robot brake near free speed, where a symmetric line forbids it", () => {
    expect(solveReachabilityProfile(input(false)).status).toBe("infeasible");
    const result = solveReachabilityProfile(input(true));
    expect(result.status).toBe("optimal");
    expect(result.velocities.at(-1)).toBe(0);
  });
});

describe("electrical drivetrain validation", () => {
  const point: CanonicalPathPoint = {
    sourceIndex: 0, s: 0, f: 0, x: 0, y: 0,
    tangentRad: 0, tangentX: 1, tangentY: 0, normalX: 0, normalY: 1, curvatureInvM: 0,
    headingRad: 0, headingDerivativeRadPerM: 0, headingSecondDerivativeRadPerM2: 0,
    segmentIndex: 0, segmentFraction: 0, stop: false,
  };

  it("checks motoring force against the falling line and braking force against the current cap", () => {
    const robot = maxSwerveProject().robot;
    const limits = robotHardLimits(robot)!;
    const perModule = MASS_KG / 4;
    const motoring = evaluateDrivetrainForces(point, robot, 4, 2, 0, 0)[0];
    expect(motoring.requiredMotorForceN).toBeCloseTo(perModule * 2, 6);
    expect(motoring.motorForceLimitN).toBeCloseTo(perModule * straightLineAccel(limits, 4), 6);

    const braking = evaluateDrivetrainForces(point, robot, 4, -8, 0, 0)[0];
    expect(braking.requiredMotorForceN).toBeCloseTo(perModule * 8, 6);
    expect(braking.motorForceLimitN).toBeCloseTo(perModule * limits.brakingCapAccelMps2, 6);
  });
});

describe("electrical planning", () => {
  function straightPath(project: ReturnType<typeof maxSwerveProject>) {
    const path = project.paths[0];
    path.headingMode = "tangent";
    path.waypoints = buildWaypoints([{ x: 1, y: 2 }, { x: 8, y: 2 }]);
    path.waypoints[0].stop = true;
    path.waypoints[1].stop = true;
    path.ranges = [];
    path.constraints = { maxVel: 10, maxAccel: 20, maxDecel: 20, maxAngVel: 720, maxAngAccel: 2000 };
    return path;
  }

  it.each(["profiledSpline", "optimizedTrajectory"] as const)("%s keeps motoring inside the speed-dependent envelope", (plannerId) => {
    const project = maxSwerveProject();
    const path = straightPath(project);
    const limits = robotHardLimits(project.robot)!;
    const result = getPlanner(plannerId).generate({ path, robot: project.robot });
    expect(result.diagnostics.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(Math.max(...result.samples.map((sample) => sample.velocityMps))).toBeGreaterThan(3);

    let fastBrake = false;
    result.samples.slice(1).forEach((sample, index) => {
      const before = result.samples[index];
      const distance = sample.s - before.s;
      if (distance <= 1e-6) return;
      const acceleration = (sample.velocityMps ** 2 - before.velocityMps ** 2) / (2 * distance);
      const speed = Math.max(sample.velocityMps, before.velocityMps);
      if (acceleration > 0) expect(acceleration).toBeLessThanOrEqual(straightLineAccel(limits, speed) * 1.01 + 1e-3);
      else {
        expect(-acceleration).toBeLessThanOrEqual(limits.maxDecelMps2 * 1.01 + 1e-3);
        if (-acceleration > straightLineAccel(limits, speed) + 0.5) fastBrake = true;
      }
    });
    // Braking is not back-EMF limited, so it outpaces motoring at speed.
    expect(fastBrake).toBe(true);
  });

  it("takes longer than the 12 V stall-torque line for the same robot", () => {
    const electrical = maxSwerveProject();
    const legacy = maxSwerveProject(false);
    const planner = getPlanner("optimizedTrajectory");
    const electricalTime = planner.generate({ path: straightPath(electrical), robot: electrical.robot }).totalTimeS;
    const legacyTime = planner.generate({ path: straightPath(legacy), robot: legacy.robot }).totalTimeS;
    expect(electricalTime).toBeGreaterThan(legacyTime * 1.05);
  });

  it("plans a curved, rotating path within the per-module limits", () => {
    const project = maxSwerveProject();
    const path = project.paths[0];
    path.headingMode = "manual";
    path.waypoints = buildWaypoints([{ x: 1, y: 1, theta: 0 }, { x: 4, y: 3, theta: 90 }, { x: 7, y: 1, theta: 180 }]);
    path.waypoints.forEach((waypoint) => { waypoint.thetaOn = true; });
    path.waypoints[0].stop = true;
    path.waypoints[2].stop = true;
    path.ranges = [];
    path.constraints = { maxVel: 10, maxAccel: 20, maxDecel: 20, maxAngVel: 720, maxAngAccel: 2000 };
    const result = getPlanner("optimizedTrajectory").generate({ path, robot: project.robot });
    expect(result.diagnostics.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(result.totalTimeS).toBeGreaterThan(0);
  });
});
