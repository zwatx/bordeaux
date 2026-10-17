import { describe, expect, it, vi } from "vitest";
import { effectiveRanges } from "../src/shared/planners/rotationPriority";
import { enforceAngularTiming } from "../src/shared/planners/angularConstraints";
import { buildWaypoints, createDemoProject } from "../src/shared/project/defaults";
import type { PlannerResult, TrajectorySample } from "../src/shared/types";

describe("optimizer range resolution", () => {
  it("does not index every geometry sample for fraction and distance ranges", () => {
    const path = createDemoProject().paths[0];
    path.waypoints = buildWaypoints([{ x: 0, y: 0 }, { x: 2, y: 0 }]);
    path.ranges = [
      { name: "fraction", anchor: "param", f0: 0.25, f1: 0.75, maxVel: 1 },
      { name: "distance", anchor: "dist", f0: 0, f1: 1, d0: 1.5, d1: 0.5, maxAccel: 2 },
    ];
    const samples = Array.from({ length: 2049 }, (_, index) => ({
      x: index / 1024, y: 0, f: index / 2048,
    })) as TrajectorySample[];
    const formatting = vi.spyOn(Number.prototype, "toFixed");
    try {
      expect(effectiveRanges(path, samples, 2)).toEqual([
        { ...path.ranges[0], start: 0.25, end: 0.75 },
        { ...path.ranges[1], start: 0.25, end: 0.75 },
      ]);
      // Coordinate formatting was the measured hot path. These ranges need
      // neither arrival indices nor sample-coordinate serialization.
      expect(formatting.mock.calls.length).toBe(0);
    } finally { formatting.mockRestore(); }
  });

  it("does not find turn arrivals when a path has no stationary turns", () => {
    const path = createDemoProject().paths[0];
    path.waypoints = buildWaypoints([{ x: 0, y: 0 }, { x: 2, y: 0 }]);
    path.ranges = [];
    const result: PlannerResult = {
      planner: "profiledSpline", totalTimeS: 2, totalDistanceM: 2, markers: [], diagnostics: [],
      samples: [0, 1, 2].map((x, i) => ({
        i, t: x, s: x, f: x / 2, x, y: 0, headingRad: 0,
        velocityMps: 1, accelerationMps2: 0, angularVelocityRadps: 0, curvatureInvM: 0,
      })),
    };
    const formatting = vi.spyOn(Number.prototype, "toFixed");
    try {
      expect(enforceAngularTiming(path, result)).toBe(result);
      expect(formatting.mock.calls.length).toBe(0);
    } finally { formatting.mockRestore(); }
  });

  it("still resolves waypoint ranges from actual arrivals, including mixed anchors", () => {
    const path = createDemoProject().paths[0];
    path.waypoints = buildWaypoints([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 4, y: 0 }]);
    path.ranges = [
      { name: "fraction", anchor: "param", f0: 0.1, f1: 0.9 },
      { name: "waypoint", anchor: "wp", f0: 0, f1: 1, w0: 0, t0: 0.5, w1: 1, t1: 0.5, maxVel: 1 },
      { name: "arrival", anchor: "wp", f0: 0, f1: 1, w0: 1, w1: 2, maxAccel: 2 },
    ];
    const samples = [0, 0.5, 1, 2, 4].map(x => ({ x, y: 0, f: x / 4 })) as TrajectorySample[];
    const resolved = effectiveRanges(path, samples, 4);
    expect(resolved.map(range => [range.start, range.end])).toEqual([
      [0.1, 0.9], [0.125, 0.625], [0.25, 1],
    ]);
    expect(effectiveRanges(path, samples, 4, [0, 2, 4])).toEqual(resolved);
  });
});
