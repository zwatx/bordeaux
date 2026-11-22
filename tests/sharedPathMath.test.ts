import { describe, expect, it } from "vitest";
import { sample } from "../src/core/math/geometry";
import { buildAnchors, headingAt } from "../src/core/math/headingAnchors";
import { effectiveRanges, insertHeadingTargetSamples, remapWaypointRange, waypointFracs } from "../src/core/math/pathRanges";
import { buildWaypoints, createDemoProject } from "../src/core/project/defaults";
import type { ConstraintRange, SegmentType } from "../src/core/types";

const segmentTypes: SegmentType[] = ["line", "arc", "bezier", "clothoid"];

function lineWaypoints() {
  return buildWaypoints([
    { x: 0, y: 1, theta: 0, segType: "line" },
    { x: 2, y: 1, theta: 0, segType: "line" },
    { x: 5, y: 1, theta: 0 },
  ]);
}

describe("shared path geometry", () => {
  it.each(segmentTypes)("preserves waypoint samples for adjacent %s segments", (segType) => {
    const waypoints = buildWaypoints([
      { x: 1, y: 1, theta: 0, segType },
      { x: 3, y: 2, theta: 30, segType },
      { x: 5, y: 3, theta: 0 },
    ]);
    const original = structuredClone(waypoints);
    const withIndices = sample(waypoints, 32, true);
    const withoutIndices = sample(waypoints, 32);

    expect(withoutIndices).not.toHaveProperty("wpIdx");
    expect(withIndices.wpIdx).toEqual([0, 32, 64]);
    expect(withIndices.pts).toEqual(withoutIndices.pts);
    expect(withIndices.length).toBe(withoutIndices.length);
    for (const [index, waypoint] of waypoints.entries()) {
      const point = withIndices.pts[index * 32];
      expect(point.x).toBeCloseTo(waypoint.x, 8);
      expect(point.y).toBeCloseTo(waypoint.y, 8);
    }
    expect(waypoints).toEqual(original);
  });

  it("keeps empty sample metadata compatible with each engine", () => {
    expect(sample([])).toEqual({ pts: [], length: 0, segs: 0 });
    expect(sample([], 32, true)).toEqual({ pts: [], length: 0, segs: 0, wpIdx: [] });
  });

  it("keeps waypoint anchors attached after inserting unsorted and duplicate heading targets", () => {
    const waypoints = lineWaypoints();
    const sampled = sample(waypoints, 2, true);
    const indices = insertHeadingTargetSamples(sampled, [0.7, 0.1, 0.7, 0, 1], [0, 2, 4]);

    expect(indices).toEqual([0, 3, 5]);
    expect(sampled.pts.map((point) => point.s)).toEqual([0, 0.5, 1, 2, 3.5, 5]);
    expect(waypointFracs({ waypoints }, sampled)).toEqual([0, 0.4, 1]);
    expect(indices.map((index) => sampled.pts[index].x)).toEqual([0, 2, 5]);
  });
});

describe("shared path anchors", () => {
  it("resolves distance and segment-local ranges without changing authored ranges", () => {
    const waypoints = lineWaypoints();
    const constraints = createDemoProject().paths[0].constraints;
    const ranges: ConstraintRange[] = [
      { ...constraints, anchor: "dist", f0: 0, f1: 1, d0: 1, d1: 4 },
      { ...constraints, anchor: "wp", f0: 0, f1: 1, w0: 0, t0: 0.5, w1: 1, t1: 0.5 },
    ];
    const original = structuredClone(ranges);
    const resolved = effectiveRanges({ waypoints, ranges }, sample(waypoints, 2, true));

    expect(resolved.map(({ f0, f1 }) => [f0, f1])).toEqual([[0.2, 0.8], [0.2, 0.7]]);
    expect(ranges).toEqual(original);
  });

  it("remaps deletion tombstones and reordered local ranges while retaining metadata", () => {
    const deleted: Partial<ConstraintRange> = { anchor: "wp", w0: 1, w1: 1, name: "slow" };
    expect(remapWaypointRange(deleted, [0, null, 1], 1, 2)).toEqual({ ...deleted, w0: 1, w1: 1 });
    const local: Partial<ConstraintRange> = { anchor: "wp", w0: 0, t0: 0.2, w1: 1, t1: 0.7, name: "turn" };
    const reversed = remapWaypointRange(local, [2, 1, 0], undefined, 3);
    expect(reversed.w0).toBe(0);
    expect(reversed.t0).toBeCloseTo(0.3);
    expect(reversed.w1).toBe(1);
    expect(reversed.t1).toBeCloseTo(0.8);
    expect(reversed.name).toBe("turn");
    expect(local.t0).toBe(0.2);
  });

  it("unwraps headings through the shortest turn while preserving a hold span", () => {
    const anchors = buildAnchors([
      { f: 0, rad: 170 * Math.PI / 180 },
      { f: 0.5, rad: -170 * Math.PI / 180 },
      { f: 1, rad: -170 * Math.PI / 180 },
    ]);
    const original = structuredClone(anchors);
    expect(headingAt(0.25, anchors)).toBeCloseTo(Math.PI, 10);
    expect(headingAt(0.75, anchors)).toBeCloseTo(190 * Math.PI / 180, 10);
    expect(headingAt(0.25, anchors)).toBeCloseTo(Math.PI, 10);
    expect(anchors).toEqual(original);
  });
});
