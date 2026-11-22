import { describe, expect, it } from "vitest";
import { optimizedTrajectoryPlanner } from "../src/core/planners/optimizedTrajectory";
import { profiledSplinePlanner } from "../src/core/planners/profiledSpline";
import { getPlanner } from "../src/core/planners";
import { applyStationaryActions } from "../src/core/planners/stationaryActions";
import { buildWaypoints, createDemoProject } from "../src/core/project/defaults";
import type { ConstraintRange, RoutineNode, TrajectorySample } from "../src/core/types";
import { validateProject } from "../src/core/validation";
import { decodeProjectValue } from "../src/core/project/fileFormat";
import { wrapRadians } from "../src/core/math/angles";
import { buildBdxExport } from "../src/core/export/bdx";

function maxAngularAcceleration(samples: readonly TrajectorySample[]): number {
  return samples.slice(1).reduce((maximum, sample, index) => {
    const previous = samples[index];
    return Math.max(maximum, Math.abs(sample.angularVelocityRadps - previous.angularVelocityRadps) / (sample.t - previous.t));
  }, 0);
}

function maxAngularDeceleration(samples: readonly TrajectorySample[]): number {
  return samples.slice(1).reduce((maximum, sample, index) => {
    const previous = samples[index];
    if (Math.abs(previous.angularVelocityRadps) <= 1e-9 && Math.abs(sample.angularVelocityRadps) > 1e-9) return maximum;
    const sameDirection = Math.sign(sample.angularVelocityRadps) === Math.sign(previous.angularVelocityRadps);
    if (sameDirection && Math.abs(sample.angularVelocityRadps) > Math.abs(previous.angularVelocityRadps)) return maximum;
    return Math.max(maximum, Math.abs(sample.angularVelocityRadps - previous.angularVelocityRadps) / (sample.t - previous.t));
  }, 0);
}

describe("planner correctness boundaries", () => {
  it("normalizes large finite headings in constant time", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "manual";
    path.waypoints[0].theta = 1e12;
    path.waypoints[0].thetaOn = true;

    const result = profiledSplinePlanner.generate({ path, robot: project.robot });

    expect(result.samples.every((sample) => Number.isFinite(sample.headingRad))).toBe(true);
    expect(wrapRadians(Math.PI * 3)).toBe(Math.PI);
    expect(wrapRadians(-Math.PI * 3)).toBe(-Math.PI);
  });

  it("rejects oversized base geometry before path sampling", () => {
    const project = createDemoProject();
    const waypoint = project.paths[0].waypoints[0];
    project.paths[0].waypoints = Array.from({ length: 4_466 }, (_, index) => ({
      ...structuredClone(waypoint),
      x: 1 + index * 0.001,
    }));

    expect(() => profiledSplinePlanner.generate({ path: project.paths[0], robot: project.robot }))
      .toThrow("more than 250000 trajectory samples");
  });

  it("keeps an unevenly spaced stop at its authored waypoint and preserves linear limits", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "tangent";
    path.constraints = {
      ...path.constraints,
      maxVel: 4,
      maxAccel: 1,
      maxDecel: 1,
      maxAngVel: 360,
      maxAngAccel: 720,
    };
    path.waypoints = buildWaypoints([
      { x: 1, y: 1, nextC: { x: 4 / 3, y: 1 } },
      { x: 2, y: 1, prevC: { x: 5 / 3, y: 1 }, nextC: { x: 14 / 3, y: 1 }, stop: true },
      { x: 10, y: 1, prevC: { x: 22 / 3, y: 1 } },
    ]);

    const result = optimizedTrajectoryPlanner.generate({ path, robot: project.robot });
    const interiorStops = result.samples.filter((sample) => (
      sample.f > 1e-8 && sample.f < 1 - 1e-8 && Math.abs(sample.velocityMps) < 1e-8
    ));

    expect(interiorStops).toHaveLength(1);
    expect(interiorStops[0].x).toBeCloseTo(2, 4);
    for (let index = 1; index < result.samples.length; index += 1) {
      const previous = result.samples[index - 1];
      const sample = result.samples[index];
      const ds = sample.s - previous.s;
      if (ds <= 1e-9) continue;
      const acceleration = (sample.velocityMps ** 2 - previous.velocityMps ** 2) / (2 * ds);
      const accelerationLimit = path.constraints.maxAccel
        * Math.max(0, Math.min(1, 1 - previous.velocityMps / project.robot.maxSpeed));
      if (acceleration >= 0) expect(acceleration).toBeLessThanOrEqual(accelerationLimit + 0.002);
      else expect(-acceleration).toBeLessThanOrEqual(path.constraints.maxDecel + 0.002);
    }
    expect(result.optimization?.constraintViolations).toBe(0);
    expect(result.diagnostics.some((issue) => issue.severity === "error")).toBe(false);
  });

  it.each([
    ["param", { anchor: "param", f0: 0, f1: 1 }],
    ["distance", { anchor: "dist", f0: 0.4, f1: 0.6, d0: 0, d1: 9 }],
    ["waypoint-local", { anchor: "wp", f0: 0.4, f1: 0.6, w0: 0, t0: 0, w1: 1, t1: 1 }],
  ] as const)("enforces %s velocity, acceleration, and deceleration ranges after optimization", (_name, anchor) => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "tangent";
    path.startVel = 2;
    path.goalVel = 2;
    path.constraints = {
      ...path.constraints,
      maxVel: 4,
      maxAccel: 5,
      maxDecel: 5,
      maxAngVel: 360,
      maxAngAccel: 720,
    };
    path.waypoints = buildWaypoints([
      { x: 1, y: 1, nextC: { x: 2, y: 1 } },
      { x: 4, y: 1, prevC: { x: 3, y: 1 }, nextC: { x: 6, y: 1 } },
      { x: 10, y: 1, prevC: { x: 8, y: 1 } },
    ]);
    path.ranges = [{
      ...anchor,
      maxVel: 0.8,
      maxAccel: 0.1,
      maxDecel: 0.1,
      maxAngVel: 360,
      maxAngAccel: 720,
    } as ConstraintRange];

    const result = optimizedTrajectoryPlanner.generate({ path, robot: project.robot });
    expect(Math.max(...result.samples.map((sample) => sample.velocityMps))).toBeLessThanOrEqual(0.8001);
    for (let index = 1; index < result.samples.length; index += 1) {
      const previous = result.samples[index - 1];
      const sample = result.samples[index];
      const ds = sample.s - previous.s;
      if (ds <= 1e-9) continue;
      const acceleration = (sample.velocityMps ** 2 - previous.velocityMps ** 2) / (2 * ds);
      const accelerationLimit = 0.1
        * Math.max(0, Math.min(1, 1 - previous.velocityMps / project.robot.maxSpeed));
      if (acceleration >= 0) expect(acceleration).toBeLessThanOrEqual(accelerationLimit + 0.002);
      else expect(-acceleration).toBeLessThanOrEqual(0.102);
    }
    expect(result.optimization?.constraintViolations).toBe(0);
    expect(result.diagnostics.some((issue) => issue.severity === "error")).toBe(false);
  });

  it.each(["profiledSpline", "optimizedTrajectory"] as const)("enforces signed angular acceleration through a direction reversal in %s", (plannerId) => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "tangent";
    path.constraints = {
      ...path.constraints,
      maxVel: 2,
      maxAccel: 2,
      maxDecel: 2,
      maxAngVel: 180,
      maxAngAccel: 30,
      maxAngDecel: 30,
    };
    path.waypoints = buildWaypoints([
      { x: 1, y: 3.488662326708436 },
      { x: 5, y: 1.07577219652012 },
      { x: 10, y: 1.1318204896524549 },
      { x: 15, y: 6.9169465894810855 },
    ]);

    const result = getPlanner(plannerId).generate({ path, robot: project.robot });

    expect(maxAngularAcceleration(result.samples))
      .toBeLessThanOrEqual(path.constraints.maxAngAccel * Math.PI / 180 * 1.02);
    expect(result.diagnostics.some((issue) => issue.severity === "error")).toBe(false);
  });

  it.each([
    ["terminal turn", (waypoint: ReturnType<typeof buildWaypoints>[number]) => {
      waypoint.stop = true;
      waypoint.turnInPlace = { headingDeg: 90, direction: "counterclockwise" };
    }],
    ["terminal jiggle", (waypoint: ReturnType<typeof buildWaypoints>[number]) => {
      waypoint.stop = true;
      waypoint.jiggle = { distanceM: 0.15, strokes: 2, startDeg: 0, stepDeg: 90, strokeTimeS: 0.4 };
    }],
  ] as const)("keeps moving signed angular limits with a %s", (_name, addAction) => {
    for (const plannerId of ["profiledSpline", "optimizedTrajectory"] as const) {
      const project = createDemoProject();
      const path = project.paths[0];
      path.headingMode = "tangent";
      path.constraints = {
        ...path.constraints,
        maxVel: 2,
        maxAccel: 2,
        maxDecel: 2,
        maxAngVel: 180,
        maxAngAccel: 30,
        maxAngDecel: 30,
      };
      path.waypoints = buildWaypoints([
        { x: 1, y: 3.488662326708436 },
        { x: 5, y: 1.07577219652012 },
        { x: 10, y: 1.1318204896524549 },
        { x: 15, y: 6.9169465894810855 },
      ]);
      addAction(path.waypoints.at(-1)!);

      const result = getPlanner(plannerId).generate({ path, robot: project.robot });

      expect(maxAngularAcceleration(result.samples), plannerId)
        .toBeLessThanOrEqual(path.constraints.maxAngAccel * Math.PI / 180 * 1.03);
      expect(result.diagnostics.some((issue) => issue.severity === "error" && issue.message.includes("angular limits")), plannerId)
        .toBe(false);
    }
  });

  it.each(["profiledSpline", "optimizedTrajectory"] as const)(
    "keeps a terminal wait after coupled heading arrival despite legacy priority in %s",
    (plannerId) => {
      const project = createDemoProject();
      const path = project.paths[0];
      path.headingMode = "manual";
      path.constraints = {
        ...path.constraints,
        maxVel: 4,
        maxAccel: 5,
        maxDecel: 5,
        maxAngVel: 60,
        maxAngAccel: 120,
        maxAngDecel: 120,
      };
      path.waypoints = buildWaypoints([
        { x: 1, y: 2, theta: 0, thetaOn: true, segType: "line" },
        { x: 8, y: 2, theta: 180, thetaOn: true, stop: true, wait: 1 },
      ]);
      path.ranges = [{
        anchor: "param", f0: 0.05, f1: 0.95,
        maxVel: 4, maxAccel: 5, maxDecel: 5, maxAngVel: 60, maxAngAccel: 120,
        rotationPriority: "translation",
      }];
      path.markers = [{ id: "finish", f: 1, name: "Finish" }];

      const result = getPlanner(plannerId).generate({ path, robot: project.robot });
      const arrival = result.waypointSampleIndices!.at(-1)!;
      let lastHeadingChange = arrival;
      for (let index = arrival + 1; index < result.samples.length; index += 1) {
        if (Math.abs(wrapRadians(result.samples[index].headingRad - result.samples[index - 1].headingRad)) > 1e-8) {
          lastHeadingChange = index;
        }
      }

      expect(lastHeadingChange).toBe(arrival);
      expect(result.samples[arrival].headingRad).toBeCloseTo(Math.PI, 5);
      expect(result.samples.at(-1)!.t - result.samples[lastHeadingChange].t).toBeGreaterThanOrEqual(1 - 1e-4);
      expect(result.samples.slice(lastHeadingChange).every((sample) => (
        Math.hypot(sample.x - result.samples[arrival].x, sample.y - result.samples[arrival].y) < 1e-5
      ))).toBe(true);
      expect(result.markers[0].timeS).toBeCloseTo(result.totalTimeS, 6);
    },
  );

  it.each(["profiledSpline", "optimizedTrajectory"] as const)(
    "keeps a terminal turn after coupled heading arrival despite legacy priority in %s",
    (plannerId) => {
      const project = createDemoProject();
      const path = project.paths[0];
      path.headingMode = "manual";
      path.constraints = {
        ...path.constraints,
        maxVel: 4,
        maxAccel: 5,
        maxDecel: 5,
        maxAngVel: 60,
        maxAngAccel: 120,
        maxAngDecel: 120,
      };
      path.waypoints = buildWaypoints([
        { x: 1, y: 2, theta: 0, thetaOn: true, segType: "line" },
        {
          x: 8, y: 2, theta: 180, thetaOn: true, stop: true,
          turnInPlace: { headingDeg: 90, direction: "shortest" },
        },
      ]);
      path.ranges = [{
        anchor: "param", f0: 0.05, f1: 0.95,
        maxVel: 4, maxAccel: 5, maxDecel: 5, maxAngVel: 60, maxAngAccel: 120,
        rotationPriority: "translation",
      }];
      path.markers = [{ id: "finish", f: 1, name: "Finish" }];

      const result = getPlanner(plannerId).generate({ path, robot: project.robot });
      const arrival = result.waypointSampleIndices!.at(-1)!;
      const peakIndex = result.samples.reduce((peak, sample, index) => (
        index >= arrival && sample.headingRad > result.samples[peak].headingRad ? index : peak
      ), arrival);
      const targetIndex = result.samples.findIndex((sample, index) => (
        index > peakIndex && Math.abs(wrapRadians(sample.headingRad - Math.PI / 2)) < 1e-4
      ));
      const maxHeadingStep = result.samples.slice(peakIndex + 1).reduce((maximum, sample, index) => (
        Math.max(maximum, Math.abs(wrapRadians(sample.headingRad - result.samples[peakIndex + index].headingRad)))
      ), 0);

      expect(peakIndex).toBe(arrival);
      expect(Math.abs(wrapRadians(result.samples[peakIndex].headingRad - Math.PI))).toBeLessThan(0.01);
      expect(result.samples.at(-1)!.headingRad).toBeCloseTo(Math.PI / 2, 3);
      expect(targetIndex).toBeGreaterThan(arrival);
      expect(result.samples.slice(targetIndex).every((sample) => (
        Math.abs(wrapRadians(sample.headingRad - Math.PI / 2)) < 1e-4
      ))).toBe(true);
      expect(maxHeadingStep).toBeLessThan(5 * Math.PI / 180);
      expect(result.markers[0].timeS).toBeCloseTo(result.totalTimeS, 6);
    },
  );

  it.each(["profiledSpline", "optimizedTrajectory"] as const)("uses maxAngDecel while settling moving heading in %s", (plannerId) => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "manual";
    path.constraints = {
      ...path.constraints,
      maxVel: 2,
      maxAccel: 2,
      maxDecel: 2,
      maxAngVel: 360,
      maxAngAccel: 720,
      maxAngDecel: 1,
    };
    path.waypoints = buildWaypoints([
      { x: 1, y: 2, theta: 0, thetaOn: true, segType: "line" },
      { x: 9, y: 2, theta: 180, thetaOn: true },
    ]);

    const result = getPlanner(plannerId).generate({ path, robot: project.robot });

    expect(maxAngularDeceleration(result.samples))
      .toBeLessThanOrEqual(path.constraints.maxAngDecel! * Math.PI / 180 * 1.02);
  });

  it("enforces a full-width local angular acceleration range", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "manual";
    path.constraints.maxAngAccel = 720;
    path.constraints.maxAngDecel = 720;
    path.waypoints = buildWaypoints([
      { x: 1, y: 2, theta: 0, thetaOn: true, segType: "line" },
      { x: 9, y: 2, theta: 180, thetaOn: true },
    ]);
    path.ranges = [{
      anchor: "param", f0: 0, f1: 1,
      maxVel: path.constraints.maxVel,
      maxAccel: path.constraints.maxAccel,
      maxDecel: path.constraints.maxDecel,
      maxAngVel: path.constraints.maxAngVel,
      maxAngAccel: 1,
    }];

    const result = profiledSplinePlanner.generate({ path, robot: project.robot });

    expect(maxAngularAcceleration(result.samples)).toBeLessThanOrEqual(Math.PI / 180 * 1.02);
  });

  it("never exports samples that exceed authored angular acceleration", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "tangent";
    path.constraints.maxAngAccel = 30;
    path.constraints.maxAngDecel = 30;
    path.waypoints = buildWaypoints([
      { x: 1, y: 3.488662326708436 },
      { x: 5, y: 1.07577219652012 },
      { x: 10, y: 1.1318204896524549 },
      { x: 15, y: 6.9169465894810855 },
    ]);

    const exported = buildBdxExport(project).paths[0];

    expect(maxAngularAcceleration(exported.samples))
      .toBeLessThanOrEqual(path.constraints.maxAngAccel * Math.PI / 180 * 1.02);
  });

  it("rejects oversized stationary timelines before allocating their samples", () => {
    const project = createDemoProject();
    project.paths[0].waypoints.at(-1)!.stop = true;
    project.paths[0].waypoints.at(-1)!.wait = 20_000;

    const base = profiledSplinePlanner.generate({ path: project.paths[0], robot: project.robot });
    expect(() => applyStationaryActions(project.paths[0], base, project.robot))
      .toThrow(/Stationary actions require .*exceeding the trajectory limit of 250000/);
  });
});

describe("project validation boundaries", () => {
  it.each(["profiledSpline", "optimizedTrajectory"] as const)("rejects zero angular deceleration before %s planning", (plannerId) => {
    const project = createDemoProject();
    project.plannerId = plannerId;
    project.paths[0].constraints.maxAngDecel = 0;
    project.paths[0].waypoints.at(-1)!.stop = true;
    project.paths[0].waypoints.at(-1)!.turnInPlace = { headingDeg: 90, direction: "counterclockwise" };

    expect(validateProject(project).issues).toContainEqual(expect.objectContaining({
      path: "$.paths[0].constraints.maxAngDecel",
      message: "maxAngDecel must be greater than zero",
    }));
    expect(() => getPlanner(plannerId).generate({ path: project.paths[0], robot: project.robot }))
      .toThrow("maxAngDecel must be greater than zero");
    expect(() => buildBdxExport(project)).toThrow("maxAngDecel must be greater than zero");
  });

  it("requires a stopped waypoint for a positive wait", () => {
    const project = createDemoProject();
    project.paths[0].waypoints = buildWaypoints([
      { x: 1, y: 2, segType: "line" },
      { x: 5, y: 2, wait: 1, stop: false, segType: "line" },
      { x: 9, y: 2 },
    ]);

    expect(validateProject(project).issues).toContainEqual(expect.objectContaining({
      path: "$.paths[0].waypoints[1].wait",
      message: expect.stringContaining("stopped waypoint"),
    }));
    expect(() => buildBdxExport(project)).toThrow(/stopped waypoint/);
  });

  it("rejects deeply nested routines without overflowing during migration", () => {
    const project = createDemoProject() as unknown as Record<string, any>;
    let nodes: unknown[] = [];
    for (let depth = 0; depth < 2_000; depth += 1) {
      nodes = [{ id: `decision_${depth}`, type: "decision", cond: "ready", thenLabel: "yes", elseLabel: "no", then: nodes, else: [] }];
    }
    project.routines = [{ id: "routine_deep", name: "Deep", nodes }];
    project.activeRoutineId = "routine_deep";

    expect(() => decodeProjectValue(project)).toThrow("Routine nesting cannot exceed 64 levels");
  });

  it("rejects non-boolean persisted path and waypoint flags", () => {
    const project = createDemoProject() as unknown as Record<string, any>;
    project.paths[0].driveBackward = "false";
    project.paths[0].exportable = "false";
    project.paths[0].waypoints[0].thetaOn = "false";
    project.paths[0].waypoints[0].linked = 1;
    project.paths[0].waypoints[0].stop = null;
    project.paths[0].waypoints[0].corner = "false";

    expect(validateProject(project).issues.map((item) => item.path)).toEqual(expect.arrayContaining([
      "$.paths[0].driveBackward",
      "$.paths[0].exportable",
      "$.paths[0].waypoints[0].thetaOn",
      "$.paths[0].waypoints[0].linked",
      "$.paths[0].waypoints[0].stop",
      "$.paths[0].waypoints[0].corner",
    ]));
  });

  it("bounds project path collections and routine nesting", () => {
    const oversized = createDemoProject();
    oversized.paths = Array.from({ length: 1_025 }, () => oversized.paths[0]);
    expect(validateProject(oversized).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "$.paths", message: expect.stringContaining("1024") }),
    ]));

    const nested = createDemoProject();
    let nodes: RoutineNode[] = [];
    for (let depth = 0; depth < 66; depth += 1) {
      nodes = [{
        id: `decision_${depth}`,
        type: "decision",
        cond: "condition",
        thenLabel: "Then",
        elseLabel: "Else",
        then: nodes,
        else: [],
      }];
    }
    nested.routines![0].nodes = nodes;
    expect(validateProject(nested).issues.some((issue) => (
      issue.path.includes(".then") && issue.message.includes("64 levels")
    ))).toBe(true);
  });
});
