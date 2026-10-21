import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CorridorCorpus } from "../src/electron/benchmark/corridor";
import { robotFootprintAt, robotFootprintRadius } from "../src/shared/agent/robotFootprint";
import { PM } from "../src/shared/math/pm";
import { sweptFootprintInsideCorridor } from "../src/shared/planners/corridorFinal";
import { optimizeFixedGeometryFinal } from "../src/shared/planners/fixedGeometryFinal";
import { decodeProjectFile } from "../src/shared/project/fileFormat";
import type { ControlPoint, RobotConfig, TrajectorySample } from "../src/shared/types";

const directory = join(dirname(fileURLToPath(import.meta.url)), "../benchmarks/planner-corpus/v2");
const corpus = CorridorCorpus.loadV2(directory);
const project = decodeProjectFile(readFileSync(join(directory, "corpus.bordeaux.json"), "utf8")).project;
const TOLERANCE_M = 1e-6;

// The previous predicate: the exact nearest reference edge for every vertex.
// Returns the largest such distance, so acceptance is a single comparison.
function exhaustiveMargin(robot: RobotConfig, samples: readonly TrajectorySample[], reference: readonly ControlPoint[]): number {
  let margin = Number.NEGATIVE_INFINITY;
  for (const sample of samples) {
    for (const point of robotFootprintAt(robot, sample)) {
      let nearest = Number.POSITIVE_INFINITY;
      for (let index = 1; index < reference.length; index += 1) {
        const first = reference[index - 1];
        const second = reference[index];
        const dx = second.x - first.x;
        const dy = second.y - first.y;
        const lengthSquared = dx * dx + dy * dy;
        let distance: number;
        if (lengthSquared <= 1e-12) distance = Math.hypot(point.x - first.x, point.y - first.y);
        else {
          const along = Math.max(0, Math.min(1, ((point.x - first.x) * dx + (point.y - first.y) * dy) / lengthSquared));
          distance = Math.hypot(point.x - first.x - dx * along, point.y - first.y - dy * along);
        }
        nearest = Math.min(nearest, distance);
      }
      margin = Math.max(margin, nearest);
    }
  }
  return margin;
}

function exhaustiveInside(robot: RobotConfig, samples: readonly TrajectorySample[], reference: readonly ControlPoint[], corridorM: number) {
  const boundaryM = robotFootprintRadius(robot) + corridorM;
  return exhaustiveMargin(robot, samples, reference) <= boundaryM + TOLERANCE_M;
}

/** Corridor widths straddling the exact value where the exhaustive predicate flips. */
function thresholdCorridors(robot: RobotConfig, margin: number): number[] {
  const critical = margin - robotFootprintRadius(robot) - TOLERANCE_M;
  return [-1e-9, -1e-12, ...Array.from({ length: 41 }, (_, index) => (index - 20) * 1e-16), 1e-12, 1e-9]
    .map((offset) => critical + offset);
}

function pose(x: number, y: number, headingRad = 0): TrajectorySample {
  return { i: 0, t: 0, s: 0, f: 0, x, y, headingRad, velocityMps: 0, accelerationMps2: 0, angularVelocityRadps: 0, curvatureInvM: 0 };
}

const smallRobot: RobotConfig = {
  ...project.robot,
  footprint: { kind: "polygon", verticesM: [{ x: 0.1, y: 0.1 }, { x: -0.1, y: 0.1 }, { x: -0.1, y: -0.1 }, { x: 0.1, y: -0.1 }] },
};

function expectEquivalent(robot: RobotConfig, samples: readonly TrajectorySample[], reference: readonly ControlPoint[], corridorM: number): boolean {
  const expected = exhaustiveInside(robot, samples, reference, corridorM);
  expect(sweptFootprintInsideCorridor(robot, samples, reference, corridorM)).toBe(expected);
  return expected;
}

describe("swept footprint corridor predicate", () => {
  it("matches the exhaustive predicate over corpus trajectories at their exact acceptance thresholds", () => {
    const routes = corpus.cases.map((fixture) => {
      const path = project.paths.find((candidate) => candidate.id === fixture.pathId)!;
      return {
        reference: PM.sample(path.waypoints, 128).pts as ControlPoint[],
        samples: optimizeFixedGeometryFinal({ path, robot: project.robot, samplesPerSegment: 56 }).samples,
      };
    });
    const outcomes = new Set<boolean>();
    routes.forEach(({ reference, samples }, index) => {
      const shifted = (dy: number) => samples.map((sample) => ({ ...sample, y: sample.y + dy }));
      const trajectories = [samples, shifted(0.08), shifted(-0.35), routes[(index + 1) % routes.length].samples];
      for (const trajectory of trajectories) {
        const margin = exhaustiveMargin(project.robot, trajectory, reference);
        const accepted = thresholdCorridors(project.robot, margin)
          .map((corridorM) => expectEquivalent(project.robot, trajectory, reference, corridorM));
        // The window must straddle the flip for the boundary comparison to mean anything.
        expect(new Set(accepted)).toEqual(new Set([false, true]));
        [0.03, 0.15, 1.5].forEach((corridorM) => outcomes.add(expectEquivalent(project.robot, trajectory, reference, corridorM)));
      }
    });
    expect(outcomes).toEqual(new Set([false, true]));
  }, 60_000);

  it("finds far branches of a self-crossing route regardless of where the previous vertex matched", () => {
    const reference = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }];
    // Alternate between the last and first edges, then sit on the crossing.
    const crossing = [pose(2, 8), pose(2, 2), pose(8, 2, 1), pose(5, 5, 0.7), pose(8, 8), pose(10, 5, 2)];
    expect(expectEquivalent(smallRobot, crossing, reference, 0.05)).toBe(true);
    expect(expectEquivalent(smallRobot, [...crossing, pose(5, 1)], reference, 0.05)).toBe(false);
    expect(expectEquivalent(smallRobot, [pose(5, 1), ...crossing], reference, 0.05)).toBe(false);
  });

  it("treats repeated reference points as the same degenerate edges", () => {
    const repeated = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }];
    const samples = [pose(0, 0), pose(5, 0.1), pose(5, 0.1), pose(9.8, -0.05, 3)];
    expect(expectEquivalent(smallRobot, samples, repeated, 0.1)).toBe(true);
    expect(expectEquivalent(smallRobot, [...samples, pose(-0.5, 0)], repeated, 0.1)).toBe(false);

    const stationary = [{ x: 3, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 3 }];
    expect(expectEquivalent(smallRobot, [pose(3, 3), pose(3.05, 3)], stationary, 0.05)).toBe(true);
    expect(expectEquivalent(smallRobot, [pose(3.5, 3)], stationary, 0.05)).toBe(false);
    for (const corridorM of thresholdCorridors(smallRobot, exhaustiveMargin(smallRobot, [pose(3.05, 3.02, 0.4)], stationary))) {
      expectEquivalent(smallRobot, [pose(3.05, 3.02, 0.4)], stationary, corridorM);
    }
  });

  it("rejects nonfinite geometry wherever the exhaustive minimum did", () => {
    const line = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }];
    const near = [pose(1, 0), pose(9, 0)];
    for (const poisoned of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      // The first edge alone would accept; its poisoned neighbor must still reject.
      expect(expectEquivalent(smallRobot, near, [...line, { x: poisoned, y: 0 }], 0.1)).toBe(false);
      expect(expectEquivalent(smallRobot, near, [...line, { x: 12, y: poisoned }], 0.1)).toBe(false);
      expect(expectEquivalent(smallRobot, [...near, pose(poisoned, 0)], line, 0.1)).toBe(false);
      expect(expectEquivalent(smallRobot, [pose(1, 0, poisoned)], line, 0.1)).toBe(false);
    }
    expect(expectEquivalent(smallRobot, near, line, Number.NaN)).toBe(false);
    expect(expectEquivalent(smallRobot, near, [{ x: 1, y: 0 }], 0.1)).toBe(false);
    expect(expectEquivalent(smallRobot, near, [], 0.1)).toBe(false);
    expect(expectEquivalent(smallRobot, [], [...line, { x: Number.NaN, y: 0 }], 0.1)).toBe(true);
  });

  it("visits far fewer reference edges than the exhaustive predicate on an accepted corpus route", () => {
    const path = project.paths.find((candidate) => candidate.id === corpus.cases[1].pathId)!;
    const samples = optimizeFixedGeometryFinal({ path, robot: project.robot, samplesPerSegment: 56 }).samples;
    let reads = 0;
    // Both predicates read each edge's endpoints; counting those reads counts edge visits.
    const reference = (PM.sample(path.waypoints, 128).pts as ControlPoint[]).map((point) => new Proxy(point, {
      get(target, key: keyof ControlPoint) { reads += 1; return target[key]; },
    }));

    expect(sweptFootprintInsideCorridor(project.robot, samples, reference, 0.15)).toBe(true);
    const boundedReads = reads;
    reads = 0;
    expect(exhaustiveInside(project.robot, samples, reference, 0.15)).toBe(true);
    const exhaustiveReads = reads;

    expect(boundedReads * 50).toBeLessThan(exhaustiveReads);
  });
});
