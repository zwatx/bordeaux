import { describe, expect, it, vi } from "vitest";
import { PM } from "../src/shared/math/pm";
import { optimizedTrajectoryPlanner } from "../src/shared/planners/optimizedTrajectory";
import * as trajectoryValidation from "../src/shared/planners/trajectoryValidation";
import retimingFixture from "./fixtures/optimizer-local-retiming.json";
import { headingAt } from "../src/shared/math/headingAnchors";
import { buildCanonicalPathState } from "../src/shared/planners/pathState";
import { accelerationBoundsForSpeedSquared, solveReachabilityProfile } from "../src/shared/planners/reachability";
import { buildWaypoints, createDemoProject } from "../src/shared/project/defaults";
import type { PlannerInput, TrajectorySample } from "../src/shared/types";

describe("planner hot-path regressions", () => {
  it("reuses dense geometry while freshly validating each local retiming", () => {
    // Actual slalom coordinate-search trial: two refinement passes followed by
    // local retiming. Timing changes; each refinement's geometry stays fixed.
    const input = structuredClone(retimingFixture) as PlannerInput;
    const derive = vi.spyOn(PM, "derivePath");
    const validate = vi.spyOn(trajectoryValidation, "validateOptimizedTrajectory");
    try {
      const result = optimizedTrajectoryPlanner.generate(input);
      expect(result.optimization).toMatchObject({ fallback: false, refinementPasses: 2 });
      expect(result.totalTimeS).toBeCloseTo(2.66136, 6);
      expect(input).toEqual(retimingFixture);
      expect(validate.mock.calls.length).toBeGreaterThanOrEqual(5);
      expect(new Set(validate.mock.calls.map(call => call[1])).size).toBe(validate.mock.calls.length);
      expect(validate.mock.results.at(-1)!.value.violations).toEqual([]);
      const densities = derive.mock.calls.map(call => call[2]);
      for (const density of [448, 896, 1792]) {
        expect(densities.filter(value => value === density).length).toBe(1);
      }
    } finally { vi.restoreAllMocks(); }
  });

  it("locates dense heading anchors with bounded lookup work", () => {
    let reads = 0;
    const anchors = Array.from({ length: 10001 }, (_, index) => ({
      get f() { reads++; return index / 10000; },
      rad: 0.75,
    }));
    headingAt(0.5, anchors); // Coefficients are built once for the anchor array.
    reads = 0;
    for (let index = 0; index < 1000; index++) {
      expect(headingAt((index + 0.25) / 1000, anchors)).toBeCloseTo(0.75, 12);
    }
    expect(reads).toBeLessThan(22000);
  });

  it("preserves incoming headings at coincident targets and endpoint behavior", () => {
    const anchors = [{ f: 0, rad: 0 }, { f: 0.5, rad: 1 }, { f: 0.5, rad: 2 }, { f: 1, rad: 2 }];
    expect(headingAt(-1, anchors)).toBe(0);
    expect(headingAt(0.5, anchors)).toBe(1);
    expect(headingAt(0.5 + 1e-8, anchors)).toBeCloseTo(2, 12);
    expect(headingAt(2, anchors)).toBe(2);
    expect(headingAt(Number.NaN, anchors)).toBe(2);
    expect(headingAt(0.5, [])).toBe(0);
    expect(headingAt(0.5, [{ f: 0, rad: 1 }])).toBe(1);
  });

  it("retains derivatives across long stationary runs and explicit heading breaks", () => {
    const project = createDemoProject();
    const path = { ...project.paths[0], waypoints: buildWaypoints([{ x: 0, y: 0 }, { x: 2, y: 0 }]) };
    const samples: TrajectorySample[] = Array.from({ length: 5002 }, (_, i) => {
      const s = i === 0 ? 0 : i === 5001 ? 2 : 1;
      return { i, s, f: s / 2, x: s, y: 0, t: i / 50, headingRad: s * 0.5,
        velocityMps: 0, accelerationMps2: 0, angularVelocityRadps: 0, curvatureInvM: 0 };
    });
    for (const breaks of [new Set<number>(), new Set([2500])]) {
      const state = buildCanonicalPathState(path, samples, breaks);
      expect(state.waypointSampleIndices).toEqual([0, 5001]);
      for (const point of state.points) {
        expect(point.tangentX).toBe(1);
        expect(point.curvatureInvM).toBe(0);
        expect(point.headingDerivativeRadPerM).toBe(0.5);
        expect(point.headingSecondDerivativeRadPerM2).toBe(0);
      }
    }
  });

  it("retains module motor limits in public bounds and curved interval reachability", () => {
    const vector = [{ uX: 1, uY: 0, xX: 0, xY: 0.1, limit: 3 }];
    const scalar = [{ u: 1, x: 0.03, minimum: -3, maximum: 3,
      velocityCoefficient: 1, freeSpeed: 5, motorAcceleration: 3 }];
    const bounds = accelerationBoundsForSpeedSquared(vector, 4, scalar, 9)!;
    expect(bounds.minimum).toBeCloseTo(-1.32, 12);
    expect(bounds.maximum).toBeCloseTo(1.08, 12);
    const input = {
      positions: [0, 0.1, 0.2, 0.3], velocityLimits: [4, 4, 4, 4],
      accelerationLimits: [3, 3, 3], decelerationLimits: [3, 3, 3], freeSpeeds: [5, 5, 5],
      accelerationConstraints: [vector, vector, vector],
      scalarAccelerationConstraints: [scalar, scalar, scalar], startVelocity: 0, goalVelocity: 0,
    };
    const result = solveReachabilityProfile(input);
    expect(result.status).toBe("optimal");
    for (let i = 0; i < result.velocities.length - 1; i++) {
      const start = result.velocities[i] ** 2, end = result.velocities[i + 1] ** 2;
      const acceleration = (end - start) / (2 * (input.positions[i + 1] - input.positions[i]));
      const actual = accelerationBoundsForSpeedSquared(vector, (start + end) / 2, scalar, Math.max(start, end))!;
      expect(acceleration).toBeGreaterThanOrEqual(actual.minimum - 1e-7);
      expect(acceleration).toBeLessThanOrEqual(actual.maximum + 1e-7);
    }
  });
});
