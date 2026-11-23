import { describe, expect, it } from "vitest";
import { createDemoProject, buildWaypoints } from "../src/core/project/defaults";
import { decodeProjectFile, encodeProjectFile } from "../src/core/project/fileFormat";
import { validateProject } from "../src/core/validation";
import { profiledSplinePlanner } from "../src/core/planners/profiledSpline";
import { optimizedTrajectoryPlanner } from "../src/core/planners/optimizedTrajectory";
import { buildLinearConstraintProfile } from "../src/core/planners/optimizationConstraints";

const keys = ["maxVel", "maxAccel", "maxDecel", "maxAngVel", "maxAngAccel"] as const;

function straightProject() {
  const project = createDemoProject();
  const path = project.paths[0];
  path.waypoints = buildWaypoints([
    { x: 1, y: 1, nextC: { x: 3, y: 1 } },
    { x: 7, y: 1, prevC: { x: 5, y: 1 } },
  ]);
  path.targets = [];
  path.markers = [];
  path.ranges = [];
  path.headingMode = "tangent";
  return project;
}

describe("independent constraint range limits", () => {
  it.each(keys)("round trips a range containing only %s", (key) => {
    const project = straightProject();
    project.paths[0].ranges = [{ anchor: "param", f0: 0.2, f1: 0.8, [key]: 0.5 }];
    const decoded = decodeProjectFile(encodeProjectFile(project).contents).project;
    expect(decoded.paths[0].ranges).toEqual(project.paths[0].ranges);
  });

  it.each(keys)("rejects an invalid enabled %s limit", (key) => {
    const project = straightProject();
    project.paths[0].ranges = [{ anchor: "param", f0: 0, f1: 1, [key]: -1 }];
    expect(validateProject(project).issues.some((issue) => issue.path === `$.paths[0].ranges[0].${key}`)).toBe(true);
  });

  it.each([profiledSplinePlanner, optimizedTrajectoryPlanner])("keeps omitted limits at the path defaults with $id", (planner) => {
    const project = straightProject();
    const path = project.paths[0];
    const input = { path, robot: project.robot };
    const baseline = planner.generate(input);
    path.ranges = [{ anchor: "param", f0: 0, f1: 1 }];
    expect(planner.generate(input).samples).toEqual(baseline.samples);
    path.ranges[0].maxAccel = 0.5;
    const result = planner.generate(input);
    expect(result.samples.length).toBeGreaterThan(2);
    expect(result.samples.every((sample) => Object.values(sample).every((value) => typeof value !== "number" || Number.isFinite(value)))).toBe(true);
    const profile = buildLinearConstraintProfile(input, result.samples);
    expect(profile.intervals.every((limit) => limit.acceleration === 0.5 && limit.deceleration === path.constraints.maxDecel && limit.velocity === Math.min(project.robot.maxSpeed, path.constraints.maxVel))).toBe(true);
    const braking = result.samples.slice(1).map((sample, index) => {
      const previous = result.samples[index];
      return (previous.velocityMps ** 2 - sample.velocityMps ** 2) / (2 * (sample.s - previous.s));
    }).filter(Number.isFinite);
    expect(Math.max(...braking)).toBeGreaterThan(0.6);
  });
});
