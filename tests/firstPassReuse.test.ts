import { afterEach, describe, expect, it, vi } from "vitest";
import { buildWaypoints, createDemoProject } from "../src/core/project/defaults";
import * as reachability from "../src/core/planners/reachability";
import { optimizedTrajectoryPlanner } from "../src/core/planners/optimizedTrajectory";
import { fixedGeometryFirstPassTime } from "../src/core/planners";

vi.mock("../src/core/planners/reachability", async (original) => {
  const actual = await original<typeof import("../src/core/planners/reachability")>();
  return { ...actual, solveReachabilityProfile: vi.fn(actual.solveReachabilityProfile) };
});

function input(x: number, accepted: boolean) {
  const project = createDemoProject();
  const path = project.paths[0];
  path.waypoints = buildWaypoints([{ x: 6.5, y: 2 }, { x, y: 2.5 }]);
  if (accepted) path.optimization = { corridorM: 0.15 };
  return { path, robot: project.robot };
}
const solves = () => vi.mocked(reachability.solveReachabilityProfile).mock.calls.length;

describe("first timing pass", () => {
  afterEach(() => { vi.mocked(reachability.solveReachabilityProfile).mockClear(); });

  it("is solved once for a path with an optimization record", () => {
    const result = optimizedTrajectoryPlanner.generate(input(10, true));
    expect(result.optimization?.status).toBe("optimal");
    expect(result.optimization?.refinementPasses ?? 0).toBe(0);
    expect(solves()).toBe(1);
  });

  it("is shared between a first-pass probe and the full plan", () => {
    const planning = input(10.25, false);
    expect(fixedGeometryFirstPassTime(planning)).toBeGreaterThan(0);
    const probed = solves();
    expect(probed).toBe(1);
    optimizedTrajectoryPlanner.generate(planning);
    expect(solves()).toBe(probed);
  });
});
