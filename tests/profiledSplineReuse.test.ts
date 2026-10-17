import { afterEach, describe, expect, it, vi } from "vitest";
import { PM } from "../src/shared/math/pm";
import { optimizedTrajectoryPlanner } from "../src/shared/planners/optimizedTrajectory";
import { profiledSplineOptimizationInputs, profiledSplineOptimizationSeed, profiledSplinePlanner } from "../src/shared/planners/profiledSpline";
import { buildWaypoints, createDemoProject } from "../src/shared/project/defaults";

describe("optimizer initial spline work", () => {
  afterEach(() => vi.restoreAllMocks());

  it("derives the authored geometry once for rounded fallback and full-precision seed", () => {
    const project = createDemoProject();
    const path = { ...project.paths[0], headingMode: "tangent" as const, ranges: [], targets: [], markers: [], startVel: 0, goalVel: 0,
      waypoints: buildWaypoints([{ x: 7, y: 4 }, { x: 9, y: 4.3 }]) };
    const derive = vi.spyOn(PM, "derivePath");
    const result = optimizedTrajectoryPlanner.generate({ path, robot: project.robot, samplesPerSegment: 24 });

    expect(result.samples.length).toBeGreaterThan(1);
    const initial = derive.mock.calls.filter(([source, , density, options]) => source === path && density === 24 && options?.skipStationaryActions);
    expect(initial).toHaveLength(1);
  });

  it("keeps both complete results, precision and ownership identical to separate generation", () => {
    const project = createDemoProject();
    const input = { path: { ...project.paths[0], headingMode: "tangent" as const, ranges: [], targets: [], startVel: 0, goalVel: 0,
      markers: [{ id: "event", name: "Example event", f: .37123456789 }],
      waypoints: buildWaypoints([{ x: 7 + 1/7, y: 4 }, { x: 9, y: 4.3 }]) }, robot: project.robot, samplesPerSegment: 24 };
    const original = structuredClone(input);
    const expectedBase = profiledSplinePlanner.generate(input), expectedSeed = profiledSplineOptimizationSeed(input);
    const derive = vi.spyOn(PM, "derivePath");
    const { base, seed } = profiledSplineOptimizationInputs(input);

    expect(derive).toHaveBeenCalledOnce();
    expect(base).toEqual(expectedBase); expect(seed).toEqual(expectedSeed);
    expect(seed.samples[0].x).toBe(input.path.waypoints[0].x);
    expect(base.samples[0].x).not.toBe(seed.samples[0].x);
    expect(seed.markers[0].fraction).toBe(input.path.markers[0].f);
    expect(base.markers[0].fraction).not.toBe(seed.markers[0].fraction);
    base.samples[0].x = 0; base.markers[0].fraction = 0; base.waypointSampleIndices![0] = 100;
    expect(seed).toEqual(expectedSeed); expect(input).toEqual(original);
  });

  it.each([0, -1, .5, Number.POSITIVE_INFINITY, Number.NaN])("rejects invalid density %s before deriving", samplesPerSegment => {
    const project = createDemoProject(), derive = vi.spyOn(PM, "derivePath");
    expect(() => profiledSplineOptimizationInputs({ path: project.paths[0], robot: project.robot, samplesPerSegment }))
      .toThrow("Planner samples per segment must be a positive integer");
    expect(derive).not.toHaveBeenCalled();
  });
});
