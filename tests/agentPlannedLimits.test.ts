import { describe, expect, it, vi } from "vitest";
import { analyzePath } from "../src/core/agent/pathAnalysis";
import { buildWaypoints, createDemoProject } from "../src/core/project/defaults";
import { planningPathConstraints } from "../src/core/robotLimits";
import type { PathDoc, RobotConfig } from "../src/core/types";

/*
 * Agent analysis measures a trajectory against the limits planning used for the path: followed limits at the ceiling
 * of the path's planning robot, its command reserve included. The trajectory here is planned without the reserve
 * (as a stale or wrong plan would be), so it runs faster than the path may on this robot.
 */
const withoutReserve = (robot: RobotConfig): RobotConfig => {
  const { id: _id, ...rest } = robot;
  const { commandLoads: _loads, ...model } = rest.driveModel!;
  return { ...rest, driveModel: model };
};
vi.mock("../src/core/planners/pathTrajectory", async (original) => {
  const actual = await original<typeof import("../src/core/planners/pathTrajectory")>();
  return { pathTrajectory: (path: PathDoc, robot: RobotConfig) => actual.pathTrajectory(path, withoutReserve(robot)) };
});

describe("agent path analysis", () => {
  it("checks speed against the followed limit with the path's command reserve", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.waypoints = buildWaypoints([{ x: 1, y: 2, theta: 0 }, { x: 9, y: 2, theta: 0 }]);
    path.waypoints.forEach((waypoint) => { waypoint.stop = true; });
    path.ranges = []; path.targets = [];
    path.markers = [{ id: "m", name: "Shoot", f: 0.05, invocation: { commandId: "shoot", arguments: {} } }];
    path.constraints = { ...path.constraints, maxVel: 0.5, followRobotMax: ["maxVel"] };
    // Synthetic electrical drive, not a real robot.
    project.robot.driveModel = {
      motorId: "rev-vortex", motorFreeRpm: 6784, motorMaxTorqueNm: 3.6, motorCount: 4,
      gearRatio: 5.5, wheelDiameterM: 0.0762, massKg: 54, moiKgM2: 5, wheelbaseM: 0.52, trackwidthM: 0.61,
      wheelFrictionCoefficient: 1.2, cgHeightM: 0.25, motorStallCurrentA: 211, motorFreeCurrentA: 3.6,
      driveCurrentLimitA: 55, batteryVoltageV: 12.5, batteryResistanceOhm: 0.02, driveEfficiency: 0.9, controlReserve: 0.1, otherLoadA: 5,
      commandLoads: [{ commandId: "shoot", currentA: 150 }],
    };
    const reserved = planningPathConstraints(path, project.robot).maxVel;
    const free = planningPathConstraints(path, withoutReserve(project.robot)).maxVel;
    expect(reserved).toBeLessThan(free * 0.95);
    const velocity = analyzePath(project, path.id).findings.find((finding) => finding.id === "constraint:velocity");
    expect(velocity?.limit).toBeCloseTo(reserved, 9);
  });
});
