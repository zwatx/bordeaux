import { describe, expect, it } from "vitest";
import { getPlanner } from "../src/core/planners";
import { blankPath, buildWaypoints, createDemoProject, DEFAULT_CONSTRAINTS } from "../src/core/project/defaults";
import { effectivePathConstraints, robotHardLimits } from "../src/core/robotLimits";
// @ts-expect-error The production preview engine is an intentional JavaScript module.
import { PM as RendererPM } from "../src/renderer/lib/pathMath";

function physicalRobot() {
  const project = createDemoProject();
  project.robot.driveModel = {
    motorId: "test",
    motorFreeRpm: 6000,
    motorMaxTorqueNm: 1,
    motorCount: 4,
    gearRatio: 10,
    wheelDiameterM: 0.1,
    massKg: 40,
    moiKgM2: 10,
    wheelbaseM: 0.6,
    trackwidthM: 0.8,
    wheelFrictionCoefficient: 0.5,
  };
  return project;
}

describe("robot hard limits", () => {
  it("derives speed, traction, motor, and angular limits", () => {
    const project = physicalRobot();
    const limits = robotHardLimits(project.robot)!;

    expect(limits.maxSpeedMps).toBeCloseTo(Math.PI, 9);
    expect(limits.motorAccelMps2).toBeCloseTo(20, 9);
    expect(limits.tractionAccelMps2).toBeCloseTo(4.903325, 9);
    expect(limits.maxAccelMps2).toBeCloseTo(4.903325, 9);
    expect(limits.maxAngularSpeedDegps).toBeCloseTo(360, 9);
    expect(limits.maxAngularAccelDegps2).toBeCloseTo(9.80665 * 180 / Math.PI, 9);
  });

  it.each(["profiledSpline", "optimizedTrajectory"] as const)("%s applies the minimum of authored, robot, and range limits", (plannerId) => {
    const project = physicalRobot();
    const path = project.paths[0];
    path.headingMode = "tangent";
    path.waypoints = buildWaypoints([{ x: 1, y: 1 }, { x: 7, y: 1 }]);
    const planner = getPlanner(plannerId);
    const unrestricted = planner.generate({ path, robot: project.robot });
    expect(Math.max(...unrestricted.samples.map((sample) => sample.velocityMps))).toBeGreaterThan(1);

    path.constraints = { maxVel: 0.5, maxAccel: 0.7, maxDecel: 0.8, maxAngVel: 90, maxAngAccel: 180 };
    const authored = planner.generate({ path, robot: project.robot });
    expect(Math.max(...authored.samples.map((sample) => sample.velocityMps))).toBeLessThanOrEqual(0.5001);
    expect(Math.max(...authored.samples.map((sample) => sample.accelerationMps2))).toBeLessThanOrEqual(0.7001);
    expect(Math.min(...authored.samples.map((sample) => sample.accelerationMps2))).toBeGreaterThanOrEqual(-0.8001);

    const limits = effectivePathConstraints(path.constraints, project.robot);
    path.ranges = [{ anchor: "param", f0: 0, f1: 1, maxVel: 0.35, maxAccel: limits.maxAccel, maxDecel: limits.maxDecel, maxAngVel: limits.maxAngVel, maxAngAccel: limits.maxAngAccel }];
    const constrained = planner.generate({ path, robot: project.robot });
    expect(Math.max(...constrained.samples.map((sample) => sample.velocityMps))).toBeLessThanOrEqual(0.3501);
  });

  it("initializes new paths from the configured robot without arbitrary default caps", () => {
    const project = physicalRobot();
    project.robot.driveModel!.wheelFrictionCoefficient = 1.2;
    const path = blankPath("Robot defaults", project.robot);
    const hardLimits = robotHardLimits(project.robot)!;
    expect(path.constraints.maxAccel).toBe(hardLimits.maxAccelMps2);
    expect(path.constraints.maxAccel).toBeGreaterThan(DEFAULT_CONSTRAINTS.maxAccel);
    expect(path.constraints.maxAngAccel).toBe(hardLimits.maxAngularAccelDegps2);
    expect(effectivePathConstraints(path.constraints, project.robot)).toEqual(path.constraints);
  });

  it("preserves each authored cap while tightening higher values to the robot envelope", () => {
    const project = physicalRobot();
    const hardLimits = robotHardLimits(project.robot)!;
    const constraints = {
      maxVel: 2,
      maxAccel: 100,
      maxDecel: 1,
      maxCentripetalAccel: 2,
      maxAngVel: 60,
      maxAngAccel: 1000,
      maxAngDecel: 100,
      maxJerk: 3,
      maxAngJerk: 4,
    };
    const expected = {
      ...constraints,
      maxAccel: hardLimits.maxAccelMps2,
      maxAngAccel: hardLimits.maxAngularAccelDegps2,
    };
    expect(effectivePathConstraints(constraints, project.robot)).toEqual(expected);
    expect(RendererPM.effectiveConstraints(constraints, project.robot)).toEqual(expected);
  });

  it("preserves authored limits until the physical model is complete", () => {
    const project = createDemoProject();
    expect(robotHardLimits(project.robot)).toBeNull();
    expect(effectivePathConstraints(project.paths[0].constraints, project.robot)).toBe(project.paths[0].constraints);
  });
});
