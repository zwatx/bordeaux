import { describe, expect, it } from "vitest";
// @ts-expect-error Routine playback remains an intentional JavaScript module.
import { AUTO } from "../src/renderer/lib/routineModel";
import { getPlanner } from "../src/core/planners";
import { optimizeCorridorFinal } from "../src/core/planners/corridorFinal";
import { buildWaypoints, createDemoProject } from "../src/core/project/defaults";

describe("routine trajectory playback", () => {
  it("uses the shared planned trajectory for a backward path", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.driveBackward = true;
    path.headingMode = "targets";
    path.waypoints = buildWaypoints([
      { x: 1, y: 2, theta: 0, thetaOn: true, segType: "line" },
      { x: 6, y: 2, theta: 90, thetaOn: true },
    ]);
    const planned = getPlanner("profiledSpline").generate({ path, robot: project.robot, samplesPerSegment: 56 });
    const run = AUTO.buildRun(
      { nodes: [{ id: "drive", type: "path", ref: path.id }] },
      project.paths,
      project.robot,
      {},
      "profiledSpline",
      undefined,
      { [path.id]: { finalTrajectory: planned } },
    );

    const start = AUTO.poseAt(run, 0, project.robot);
    expect(start.heading).toBeCloseTo(planned.samples[0].headingRad, 5);
    expect(run.total).toBeCloseTo(planned.totalTimeS, 4);
  });

  it("matches the authoritative optimized trajectory timing and poses", () => {
    const project = createDemoProject();
    project.plannerId = "optimizedTrajectory";
    const path = project.paths[0];
    const planned = optimizeCorridorFinal({ path, robot: project.robot, samplesPerSegment: 56 });
    const run = AUTO.buildRun(
      { nodes: [{ id: "drive", type: "path", ref: path.id }] },
      project.paths,
      project.robot,
      {},
      "optimizedTrajectory",
      undefined,
      { [path.id]: { finalTrajectory: planned } },
    );

    expect(run.total).toBeCloseTo(planned.totalTimeS, 5);
    const midpoint = AUTO.poseAt(run, run.total * 0.5, project.robot);
    const nearest = planned.samples.reduce((best, sample) => (
      Math.abs(sample.t - run.total * 0.5) < Math.abs(best.t - run.total * 0.5) ? sample : best
    ));
    expect(midpoint.x).toBeCloseTo(nearest.x, 1);
    expect(midpoint.y).toBeCloseTo(nearest.y, 1);
  });

  it.each(["pending", "error"])("blocks the whole routine while authoritative planning is %s", (status) => {
    const project = createDemoProject();
    const path = project.paths[0];
    const run = AUTO.buildRun(
      { nodes: [{ id: "drive", type: "path", ref: path.id }] },
      project.paths,
      project.robot,
      {},
      project.plannerId,
      undefined,
      { status, values: {}, error: status === "error" ? "planning failed" : "" },
    );

    expect(run).toMatchObject({ blocked: true, planningStatus: status, total: 0, steps: [] });
  });
});
