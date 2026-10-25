import { describe, expect, it } from "vitest";
import { buildModuleForces } from "../src/shared/export/moduleForces";
import { contactLoads, driveContacts, GRAVITY_MPS2 } from "../src/shared/loadTransfer";
import { getPlanner } from "../src/shared/planners";
import { evaluateDrivetrainForces, projectDrivetrainAtPoint } from "../src/shared/planners/drivetrainProjection";
import type { CanonicalPathPoint } from "../src/shared/planners/pathState";
import { accelerationBoundsForSpeedSquared, solveReachabilityProfile } from "../src/shared/planners/reachability";
import { validateOptimizedTrajectory } from "../src/shared/planners/trajectoryValidation";
import { buildWaypoints, createDemoProject } from "../src/shared/project/defaults";
import { physicalPlannerInput, robotHardLimits } from "../src/shared/robotLimits";
import type { RobotConfig } from "../src/shared/types";

const MASS_KG = 54;
const MU = 1.2;

// Synthetic Kraken X60 swerve at an 80 A stator limit: traction, not current, binds at launch.
function robotWith(cgHeightM?: number): RobotConfig {
  const project = createDemoProject();
  return {
    ...project.robot, w: 0.7, l: 0.7,
    driveModel: {
      motorId: "ctre-kraken-x60", motorFreeRpm: 6000, motorMaxTorqueNm: 7.09, motorCount: 4, gearRatio: 6.75,
      wheelDiameterM: 0.1016, massKg: MASS_KG, moiKgM2: 4.5, wheelbaseM: 0.57, trackwidthM: 0.57,
      wheelFrictionCoefficient: MU, driveCurrentLimitA: 80, ...(cgHeightM === undefined ? {} : { cgHeightM }),
    },
  };
}

function straightPath() {
  const path = structuredClone(createDemoProject().paths[0]);
  path.headingMode = "manual";
  path.waypoints = buildWaypoints([{ x: 1, y: 2, theta: 0 }, { x: 6, y: 2, theta: 0 }]);
  path.waypoints.forEach((waypoint) => { waypoint.thetaOn = true; });
  path.waypoints[0].stop = true;
  path.waypoints[1].stop = true;
  path.ranges = [];
  path.constraints = { maxVel: 10, maxAccel: 20, maxDecel: 20, maxAngVel: 720, maxAngAccel: 2000 };
  return path;
}

const point: CanonicalPathPoint = {
  headingRad: 0, tangentX: 1, tangentY: 0, normalX: 0, normalY: 1, curvatureInvM: 0,
  headingDerivativeRadPerM: 0, headingSecondDerivativeRadPerM2: 0,
} as CanonicalPathPoint;

const intervalAccelerations = (samples: readonly { s: number; velocityMps: number }[]) => samples.slice(1).map((sample, index) => {
  const before = samples[index];
  const distance = sample.s - before.s;
  return distance > 1e-9 ? (sample.velocityMps ** 2 - before.velocityMps ** 2) / (2 * distance) : 0;
});

describe("affine traction limits and wheel-force splits in reachability", () => {
  it("bounds acceleration by a limit that follows the acceleration", () => {
    // |a| <= 10 - 0.5 a: braking to -20, accelerating to 20/3.
    const bounds = accelerationBoundsForSpeedSquared([{ uX: 1, uY: 0, xX: 0, xY: 0, limit: 10, limitU: -0.5 }], 0)!;
    expect(bounds.minimum).toBeCloseTo(-20, 12);
    expect(bounds.maximum).toBeCloseTo(20 / 3, 12);
    // A limit growing faster than the force is a ray: 0.2 |a| <= 1 + a.
    const ray = accelerationBoundsForSpeedSquared([{ uX: 0.2, uY: 0, xX: 0, xY: 0, limit: 1, limitU: 1 }], 0)!;
    expect(ray.minimum).toBeCloseTo(-1 / 1.2, 12);
    expect(ray.maximum).toBe(Number.POSITIVE_INFINITY);
    // The speed term also moves the limit: |a + s| <= 4 + 0.5 s at s = 2.
    const speed = accelerationBoundsForSpeedSquared([{ uX: 1, uY: 0, xX: 1, xY: 0, limit: 4, limitX: 0.5 }], 2)!;
    expect(speed.minimum).toBeCloseTo(-7, 12);
    expect(speed.maximum).toBeCloseTo(3, 12);
  });

  it("takes the hull of alternative splits inside the shared constraints", () => {
    const shared = { uX: 1, uY: 0, xX: 0, xY: 0, limit: 4 };
    const first = { uX: 1, uY: 0, xX: 0, xY: 0, limit: 2, allocation: 0 };
    const second = { uX: 1, uY: 0, xX: -2, xY: 0, limit: 3, allocation: 1 }; // |a - 2| <= 3 at s = 1
    expect(accelerationBoundsForSpeedSquared([first, second], 1)).toEqual({ minimum: expect.closeTo(-2, 12), maximum: expect.closeTo(5, 12) });
    expect(accelerationBoundsForSpeedSquared([shared, first, second], 1)).toEqual({ minimum: expect.closeTo(-2, 12), maximum: expect.closeTo(4, 12) });
    const input = {
      positions: [0, 0.5, 1, 1.5, 2], velocityLimits: [10, 10, 10, 10, 10],
      accelerationLimits: [9, 9, 9, 9], decelerationLimits: [9, 9, 9, 9], freeSpeeds: [1e9, 1e9, 1e9, 1e9],
      accelerationConstraints: [0, 1, 2, 3].map(() => [
        { uX: 1, uY: 0, xX: 0, xY: 0, limit: 2, allocation: 0 }, // symmetric 2
        { uX: 1, uY: 0, xX: 0, xY: 0, limit: 3, limitU: -0.5, allocation: 1 }, // [-6, 2]
        { uX: 1, uY: 0, xX: 0, xY: 0, limit: 3, limitU: 0.5, allocation: 2 }, // [-2, 6]
      ]),
      startVelocity: 0, goalVelocity: 0,
    };
    const result = solveReachabilityProfile(input);
    expect(result.status).toBe("optimal");
    const accelerations = intervalAccelerations(result.velocities.map((velocityMps, index) => ({ s: input.positions[index], velocityMps })));
    expect(Math.max(...accelerations)).toBeCloseTo(6, 6);
    expect(Math.min(...accelerations)).toBeCloseTo(-6, 6);
  });
});

describe("planning with load transfer", () => {
  it("keeps load-dependent forces invariant under field rotation and mirrors left/right turns", () => {
    const robot = robotWith();
    const curved = { ...point, curvatureInvM: 0.15 };
    const reference = evaluateDrivetrainForces(curved, robot, 2, 3, 0.4, 0.2);
    for (const heading of [Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const rotated = { ...curved, headingRad: heading,
        tangentX: Math.cos(heading), tangentY: Math.sin(heading),
        normalX: -Math.sin(heading), normalY: Math.cos(heading) };
      const forces = evaluateDrivetrainForces(rotated, robot, 2, 3, 0.4, 0.2);
      forces.forEach((force, index) => {
        expect(force.normalForceN).toBeCloseTo(reference[index].normalForceN, 8);
        expect(force.rollingForceN).toBeCloseTo(reference[index].rollingForceN, 8);
      });
    }
    const mirrored = evaluateDrivetrainForces({ ...curved, curvatureInvM: -0.15 }, robot, 2, 3, -0.4, -0.2);
    [1, 0, 3, 2].forEach((opposite, index) => {
      expect(mirrored[index].normalForceN).toBeCloseTo(reference[opposite].normalForceN, 8);
      expect(mirrored[index].rollingForceN).toBeCloseTo(reference[opposite].rollingForceN, 8);
    });
  });

  it("keeps the equal-load model unchanged at zero CG height", () => {
    const robot = { ...robotWith(0), maxSpeed: robotHardLimits(robotWith(0))!.maxSpeedMps };
    const projection = projectDrivetrainAtPoint(point, robot, 11, 0.95);
    const traction = projection.accelerationConstraints.filter((constraint) => constraint.label?.endsWith("traction-force"));
    expect(traction).toHaveLength(4);
    for (const constraint of [...projection.accelerationConstraints, ...projection.scalarAccelerationConstraints]) {
      expect(constraint).not.toHaveProperty("allocation");
      expect(constraint).not.toHaveProperty("limitU");
    }
    traction.forEach((constraint) => expect(constraint.limit).toBeCloseTo(MU * GRAVITY_MPS2 * MASS_KG / 4 * 0.95, 9));
    const forces = evaluateDrivetrainForces(point, robot, 1, 6, 0, 0);
    forces.forEach((module) => {
      expect(module.rollingForceN).toBeCloseTo(MASS_KG * 6 / 4, 9);
      expect(module.normalForceN).toBeCloseTo(MASS_KG * GRAVITY_MPS2 / 4, 9);
    });
  });

  it("limits each wheel by friction on its own load in the planner's splits", () => {
    const robot = { ...robotWith(), maxSpeed: robotHardLimits(robotWith())!.maxSpeedMps };
    const projection = projectDrivetrainAtPoint(point, robot, 11, 1);
    const front = projection.accelerationConstraints.filter((constraint) => constraint.label === "swerve-front-left-module-traction-force");
    expect(front.length).toBeGreaterThan(1);
    const staticLoad = MASS_KG * GRAVITY_MPS2 / 4;
    for (const constraint of front) {
      expect(constraint.limit).toBeCloseTo(MU * staticLoad, 9);
      // Forward acceleration unloads the front wheel by m h / (2 L) per m/s².
      expect(constraint.limitU).toBeCloseTo(-MU * MASS_KG * 0.25 / (2 * 0.57), 9);
    }
    const flatRobot = { ...robotWith(0), maxSpeed: robot.maxSpeed };
    const launch = accelerationBoundsForSpeedSquared(projection.accelerationConstraints, 0, projection.scalarAccelerationConstraints)!;
    const flat = projectDrivetrainAtPoint(point, flatRobot, 11, 1);
    const flatLaunch = accelerationBoundsForSpeedSquared(flat.accelerationConstraints, 0, flat.scalarAccelerationConstraints)!;
    const limits = robotHardLimits(robot)!;
    // The best split reaches the robot's straight-line launch limit with load transfer.
    expect(launch.maximum).toBeCloseTo(limits.maxAccelMps2, 6);
    expect(launch.maximum).toBeLessThan(flatLaunch.maximum * 0.8);
  });

  it("plans a hard launch more conservatively with a high CG and never over-asks the lightest wheel", () => {
    const path = straightPath();
    const times = [0, undefined, 0.35].map((cg) => getPlanner("optimizedTrajectory").generate({ path, robot: robotWith(cg) }).totalTimeS);
    expect(times[1]).toBeGreaterThan(times[0] * 1.05);
    expect(times[2]).toBeGreaterThan(times[1]);

    const robot = robotWith();
    const result = getPlanner("optimizedTrajectory").generate({ path, robot });
    expect(result.diagnostics.filter((issue) => issue.severity === "error")).toEqual([]);
    const input = physicalPlannerInput({ path, robot });
    expect(validateOptimizedTrajectory(input, result.samples, { angularKinematics: "sample" }).violations).toEqual([]);
    const limits = robotHardLimits(robot)!;
    const accelerations = intervalAccelerations(result.samples);
    expect(Math.max(...accelerations)).toBeLessThanOrEqual(limits.maxAccelMps2 * 1.001);
    expect(Math.max(...accelerations)).toBeGreaterThan(limits.maxAccelMps2 * 0.85);

    let unloadedFront = false;
    result.samples.slice(1).forEach((sample, index) => {
      const before = result.samples[index];
      const distance = sample.s - before.s;
      if (distance <= 1e-9) return;
      const speed = Math.sqrt((before.velocityMps ** 2 + sample.velocityMps ** 2) / 2);
      const forces = evaluateDrivetrainForces(point, input.robot, speed, accelerations[index], 0, 0);
      for (const module of forces) {
        expect(module.requiredForceN).toBeLessThanOrEqual(module.tractionForceLimitN * 1.0001 + 1e-6);
      }
      if (forces[0].normalForceN < MASS_KG * GRAVITY_MPS2 / 4 * 0.6) unloadedFront = true;
    });
    expect(unloadedFront).toBe(true);
  }, 60_000);

  it("exports module forces that sum to m a and follow the shifted loads", () => {
    const robot = robotWith();
    const path = straightPath();
    const result = getPlanner("optimizedTrajectory").generate({ path, robot });
    const samples = result.samples;
    const forces = buildModuleForces(robot, samples, samples.map(() => 0), samples.map(() => 0));
    const contacts = driveContacts(robot);
    let launches = 0, stops = 0;
    samples.slice(0, -1).forEach((sample, index) => {
      const next = samples[index + 1];
      if (!(next.t > sample.t)) return;
      const acceleration = (next.velocityMps - sample.velocityMps) / (next.t - sample.t);
      const [lf, lb, rf, rb] = forces[index];
      // At rest the existing BDX contract sends zero: rolling direction is undefined.
      if (sample.velocityMps < 1e-9) {
        expect(forces[index]).toEqual([0, 0, 0, 0]);
        return;
      }
      expect(lf + lb + rf + rb).toBeCloseTo(MASS_KG * acceleration, 6);
      if (Math.abs(acceleration) < 2 || sample.velocityMps < 1e-6) return;
      // No wheel is asked for more than friction on its load.
      const loads = contactLoads(contacts, MASS_KG, 0.25, acceleration, 0).normalN;
      expect(Math.abs(lf)).toBeLessThanOrEqual(MU * loads[0] * 1.0001);
      expect(Math.abs(lb)).toBeLessThanOrEqual(MU * loads[2] * 1.0001);
      if (acceleration > 0) {
        // At speed both motors can bind before traction; their forces then match.
        expect(lb).toBeGreaterThanOrEqual(lf - 1e-7);
        if (lb > lf + 1e-7) launches += 1;
      } else {
        expect(-lf).toBeGreaterThanOrEqual(-lb - 1e-7);
        if (-lf > -lb + 1e-7) stops += 1;
      }
      expect(lf).toBeCloseTo(rf, 9);
      expect(lb).toBeCloseTo(rb, 9);
    });
    expect(launches).toBeGreaterThan(3);
    expect(stops).toBeGreaterThan(3);
  }, 60_000);
});
