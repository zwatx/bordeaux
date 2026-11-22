import { describe, expect, it } from "vitest";
import { buildCanonicalPathState } from "../src/core/planners/pathState";
import { profiledSplineOptimizationSeed, profiledSplinePlanner } from "../src/core/planners/profiledSpline";
import { buildWaypoints, createDemoProject } from "../src/core/project/defaults";
import type { PathDoc, TrajectorySample, Waypoint } from "../src/core/types";

// The previous exhaustive lookup: earliest nearest sample at or after the
// previous waypoint's sample. The indexed lookup must reproduce it exactly.
function referenceIndices(waypoints: readonly Pick<Waypoint, "x" | "y">[], samples: readonly TrajectorySample[]): number[] {
  let cursor = 0;
  return waypoints.map((waypoint) => {
    let best = cursor;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = cursor; index < samples.length; index += 1) {
      const distance = Math.hypot(samples[index].x - waypoint.x, samples[index].y - waypoint.y);
      if (distance < bestDistance) { best = index; bestDistance = distance; }
    }
    cursor = best;
    return best;
  });
}

function pathWith(waypoints: Waypoint[], extra: Partial<PathDoc> = {}): PathDoc {
  const project = createDemoProject();
  return { ...project.paths[0], waypoints, ranges: [], targets: [], markers: [], ...extra };
}

// Unclamped waypoints, so offsets near field edges remain as written.
function synthetic(points: ReadonlyArray<{ x: number; y: number; stop?: boolean }>): Waypoint[] {
  return points.map((point) => ({
    theta: 0, thetaOn: false, linked: true, stop: false, prevC: { x: point.x, y: point.y }, nextC: { x: point.x, y: point.y }, ...point,
  }));
}

function syntheticSamples(points: ReadonlyArray<{ x: number; y: number }>): TrajectorySample[] {
  let s = 0;
  return points.map((point, i) => {
    if (i > 0) s += Math.hypot(point.x - points[i - 1].x, point.y - points[i - 1].y);
    return { i, s, f: 0, x: point.x, y: point.y, t: i / 50, headingRad: 0,
      velocityMps: 0, accelerationMps2: 0, angularVelocityRadps: 0, curvatureInvM: 0 };
  });
}

function expectReferenceState(path: PathDoc, samples: readonly TrajectorySample[], breaks = new Set<number>()) {
  const expected = referenceIndices(path.waypoints, samples);
  const state = buildCanonicalPathState(path, samples, breaks);
  expect(state.waypointSampleIndices).toEqual(expected);
  const stopped = new Set(expected.filter((_, waypointIndex) => path.waypoints[waypointIndex].stop));
  const firstWaypoint = new Map<number, number>();
  expected.forEach((sampleIndex, waypointIndex) => {
    if (!firstWaypoint.has(sampleIndex)) firstWaypoint.set(sampleIndex, waypointIndex);
  });
  state.points.forEach((point, index) => {
    expect(point.stop).toBe(stopped.has(index));
    expect(point.waypointIndex).toBe(firstWaypoint.get(index));
  });
  return state;
}

const curvedWaypoints = () => buildWaypoints([
  { x: 0.7 + 1 / 3, y: 1 + Math.SQRT2 / 10 },
  { x: 2 + Math.PI / 10, y: 2.15, stop: true, wait: 0.25 },
  { x: 3.5, y: 1 + Math.E / 10, theta: 90, thetaOn: true },
  { x: 5 + 1 / 7, y: 2.4 },
]);

describe("canonical waypoint sample lookup", () => {
  it("matches the exhaustive lookup on full-precision seeds and rounded public samples", () => {
    const path = pathWith(curvedWaypoints(), {
      targets: [{ f: 0.37, deg: 45 }, { anchor: "dist", f: 0.8, d: 3.1, deg: -30 }],
      ranges: [{ anchor: "wp", f0: 0, f1: 1, w0: 1, t0: 0.4, w1: 2, t1: 0.6, maxVel: 1 }],
    });
    const robot = createDemoProject().robot;
    const seed = profiledSplineOptimizationSeed({ path, robot });
    const rounded = profiledSplinePlanner.generate({ path, robot });
    // Full-precision geometry passes through each authored coordinate; the
    // public result rounds it to four decimals, so only nearest lookup applies.
    expect(seed.samples.some((sample) => sample.x === path.waypoints[0].x)).toBe(true);
    expect(rounded.samples.some((sample) => sample.x === path.waypoints[0].x)).toBe(false);
    for (const result of [seed, rounded]) {
      const state = expectReferenceState(path, result.samples);
      expect(state.waypointSampleIndices).toEqual(result.waypointSampleIndices);
      expect(state.points[result.waypointSampleIndices![1]].stop).toBe(true);
    }
  });

  it("keeps loop returns, crossings, and coincident groups on the ordered cursor", () => {
    const loop = buildWaypoints([
      { x: 1, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 3, stop: true }, { x: 3, y: 3, stop: true },
      { x: 1, y: 3 }, { x: 2, y: 0.5 }, { x: 1, y: 1 }, { x: 1, y: 1, stop: true },
    ]);
    const crossing = buildWaypoints([
      { x: 0, y: 0 }, { x: 2, y: 2 }, { x: 2, y: 0 }, { x: 0, y: 2 }, { x: 1, y: 1 }, { x: 3, y: 1 },
    ]);
    const robot = createDemoProject().robot;
    for (const waypoints of [loop, crossing]) {
      const path = pathWith(waypoints);
      for (const result of [profiledSplineOptimizationSeed({ path, robot }), profiledSplinePlanner.generate({ path, robot })]) {
        const state = expectReferenceState(path, result.samples);
        const indices = state.waypointSampleIndices;
        for (let index = 1; index < indices.length; index += 1) expect(indices[index]).toBeGreaterThanOrEqual(indices[index - 1]);
      }
    }
    const loopState = buildCanonicalPathState(pathWith(loop), profiledSplineOptimizationSeed({ path: pathWith(loop), robot }).samples);
    // A return is located after the departure, and grouped waypoints share one sample.
    expect(loopState.waypointSampleIndices[6]).toBeGreaterThan(loopState.waypointSampleIndices[0]);
    expect(loopState.waypointSampleIndices[3]).toBe(loopState.waypointSampleIndices[2]);
    expect(loopState.waypointSampleIndices.at(-1)).toBe(loopState.waypointSampleIndices.at(-2));
    expect(loopState.points[loopState.waypointSampleIndices[2]].waypointIndex).toBe(2);
  });

  it("selects the earliest nearest sample on exhaustive and indexed ties", () => {
    const samples = syntheticSamples([
      { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: 3, y: 0 },
    ]);
    // No sample reaches (1, 0.5); samples 1 and 4 tie and the first wins. The
    // repeated waypoint cannot reach back before the cursor.
    const path = pathWith(synthetic([{ x: 0, y: 0 }, { x: 1, y: 0.5 }, { x: 1, y: 0.5 }, { x: 3, y: 0 }]));
    expect(expectReferenceState(path, samples).waypointSampleIndices).toEqual([0, 1, 1, 5]);
    const offGrid = pathWith(synthetic([{ x: 0.00003, y: 0 }, { x: 1.5, y: 0.6 }, { x: 3, y: 0.00011 }]));
    expectReferenceState(offGrid, samples);
    // Exactly equidistant neighbors in different lattice cells; the earlier
    // sample lies in the cell visited second.
    const step = 2 ** -14;
    const neighbors = syntheticSamples([{ x: 0, y: 0 }, { x: 1 + step, y: 0 }, { x: 1 - step, y: 0 }, { x: 2, y: 0 }]);
    const tie = pathWith(synthetic([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]));
    expect(expectReferenceState(tie, neighbors).waypointSampleIndices).toEqual([0, 1, 3]);
  });

  it("prefers a later, nearer revisit only when it is genuinely nearer", () => {
    // Rounded samples pass within 4e-5 of the waypoint, then a later revisit
    // passes within 1e-5. Exhaustive nearest lookup chose the revisit.
    const samples = syntheticSamples([
      { x: 0, y: 0 }, { x: 0.99996, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 1.00001, y: 0.00001 }, { x: 0, y: 1 },
    ]);
    const path = pathWith(synthetic([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }]));
    expect(expectReferenceState(path, samples).waypointSampleIndices).toEqual([0, 4, 5]);
    // A diagonal sample inside the searched cells is farther than an axial
    // sample just outside them, so it must not short-circuit the scan.
    const diagonal = syntheticSamples([
      { x: 0, y: 0 }, { x: 1.00024, y: 1.00024 }, { x: 2, y: 2 }, { x: 1.00027, y: 1 }, { x: 0, y: 1 },
    ]);
    const corner = pathWith(synthetic([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]));
    expect(expectReferenceState(corner, diagonal).waypointSampleIndices).toEqual([0, 3, 4]);
  });

  it("attaches stops and heading breaks at matching indices", () => {
    const path = pathWith(synthetic([{ x: 0, y: 0 }, { x: 1, y: 0, stop: true }, { x: 1, y: 0, stop: true }, { x: 2, y: 0 }]));
    const points = [
      ...Array.from({ length: 11 }, (_, i) => ({ x: i / 10, y: 0 })),
      ...Array.from({ length: 5 }, () => ({ x: 1, y: 0 })),
      ...Array.from({ length: 10 }, (_, i) => ({ x: 1 + (i + 1) / 10, y: 0 })),
    ];
    const samples = syntheticSamples(points).map((sample, i) => ({ ...sample, headingRad: i < 13 ? 0 : 1 }));
    const state = expectReferenceState(path, samples, new Set([13]));
    expect(state.waypointSampleIndices).toEqual([0, 10, 10, 25]);
    expect(state.points[10].stop).toBe(true);
    expect(state.points.filter((point) => point.stop)).toHaveLength(1);
  });

  it("matches the exhaustive lookup on randomized revisits, holds, and offsets", () => {
    let seed = 0x2468;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const offsets = [0, 0, 3e-5, -6e-5, 1e-4, 1.6e-4, 0.002, 0.4];
    for (let trial = 0; trial < 400; trial += 1) {
      const decimals = trial % 3 === 0 ? undefined : trial % 3 === 1 ? 4 : 3;
      const round = (value: number) => decimals === undefined ? value : Number(value.toFixed(decimals));
      const points: Array<{ x: number; y: number }> = [];
      let x = round(random() * 2), y = round(random() * 2);
      for (let step = 0; step < 60; step += 1) {
        points.push({ x, y });
        if (random() < 0.1) for (let hold = 0; hold < 4; hold += 1) points.push({ x, y });
        // Revisit an earlier sample to create returns and crossings.
        if (random() < 0.1 && points.length > 3) ({ x, y } = points[Math.floor(random() * points.length)]);
        else { x = round(x + (random() - 0.5) * 0.02); y = round(y + (random() - 0.5) * 0.02); }
      }
      const samples = syntheticSamples(points);
      const waypoints = Array.from({ length: 8 }, () => {
        const anchor = samples[Math.floor(random() * samples.length)];
        const offset = offsets[Math.floor(random() * offsets.length)];
        const angle = random() * Math.PI * 2;
        return { x: anchor.x + offset * Math.cos(angle), y: anchor.y + offset * Math.sin(angle) };
      });
      if (trial % 5 === 0) waypoints.splice(3, 0, { ...waypoints[3] });
      expectReferenceState(pathWith(synthetic(waypoints)), samples);
    }
  });

  it("locates many waypoints with linear coordinate reads", () => {
    const readsFor = (waypointCount: number) => {
      const perSegment = 56;
      const waypoints = synthetic(Array.from({ length: waypointCount }, (_, index) => ({ x: index * 0.1, y: 0 })));
      let reads = 0;
      const samples = Array.from({ length: (waypointCount - 1) * perSegment + 1 }, (_, i): TrajectorySample => {
        const x = i / perSegment * 0.1;
        return { i, s: x, f: 0, get x() { reads += 1; return x; }, y: 0, t: i / 50, headingRad: 0,
          velocityMps: 0, accelerationMps2: 0, angularVelocityRadps: 0, curvatureInvM: 0 };
      });
      const state = buildCanonicalPathState(pathWith(waypoints), samples);
      expect(state.waypointSampleIndices).toEqual(waypoints.map((_, index) => index * perSegment));
      return { reads, samples: samples.length };
    };
    for (const waypointCount of [64, 512]) {
      const { reads, samples } = readsFor(waypointCount);
      // The exhaustive lookup alone read 28 * (W - 1) * (W + 2) + W
      // coordinates: 7,354,768 for 512 waypoints.
      expect(reads).toBeLessThan(6 * samples);
    }
  });
});
