import { describe, expect, it } from "vitest";
import { buildWaypoints, createDemoProject } from "../src/core/project/defaults";
import { profiledSplineOptimizationSeed } from "../src/core/planners/profiledSpline";
import { buildReachabilityInput, insertOptimizationBoundaries } from "../src/core/planners/optimizationConstraints";
import { buildCanonicalPathState } from "../src/core/planners/pathState";
import type { PlannerInput, TrajectorySample } from "../src/core/types";
import { buildDenseValidationSamples, remapTiming } from "../src/core/planners/optimizedTrajectory";
import { solveReachabilityProfile } from "../src/core/planners/reachability";
import { getPlanner } from "../src/core/planners";
import { validateOptimizedTrajectory } from "../src/core/planners/trajectoryValidation";
import turnFixture from "./fixtures/rotation-target-turn.json";

describe("heading constraint math", () => {
  it("preserves endpoint speed and heading despite integrated geometry drift", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.waypoints = buildWaypoints([
      { x: 0, y: 0, theta: 0, segType: "line" },
      { x: 4, y: 0, theta: 90 },
    ]);
    const samples: TrajectorySample[] = [0, 2, 4].map((s, i) => ({
      i, s, f: s / 4, x: s + (i === 2 ? 0.00005 : 0), y: 0, t: i,
      headingRad: s / 4, velocityMps: i === 1 ? 2 : 0, accelerationMps2: 0,
      angularVelocityRadps: 0, curvatureInvM: 0,
    }));
    const dense = buildDenseValidationSamples({ path, robot: project.robot }, samples, 8);
    expect(dense.at(-1)?.velocityMps).toBe(0);
    expect(dense.at(-1)?.headingRad).toBe(samples.at(-1)?.headingRad);
  });

  it("preserves interior stops when segment lengths shift at higher resolution", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.waypoints = buildWaypoints([
      { x: 1, y: 1, theta: 0 },
      { x: 3, y: 3, theta: 0, stop: true },
      { x: 8, y: 4, theta: 0 },
    ]);
    const input = { path, robot: project.robot, samplesPerSegment: 8 };
    const seed = profiledSplineOptimizationSeed(input);
    const stop = seed.samples[seed.waypointSampleIndices![1]];
    const dense = buildDenseValidationSamples(input, seed.samples, 8);
    const denseStop = dense.find((sample) => sample.x === 3 && sample.y === 3)!;
    expect(Math.abs(denseStop.f - stop.f)).toBeGreaterThan(1e-6);
    expect(denseStop.velocityMps).toBe(0);
    expect(denseStop.headingRad).toBe(stop.headingRad);
  });

  it("keeps progress monotone when a nearby target and waypoint change order across resolutions", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.waypoints = buildWaypoints([{ x: 1, y: 1 }, { x: 3, y: 3 }, { x: 8, y: 4 }]);
    const input = { path, robot: project.robot, samplesPerSegment: 8 };
    const coarse = profiledSplineOptimizationSeed(input);
    const fine = profiledSplineOptimizationSeed({ ...input, samplesPerSegment: 64 });
    const coarseFraction = coarse.samples[coarse.waypointSampleIndices![1]].f;
    const fineFraction = fine.samples[fine.waypointSampleIndices![1]].f;
    path.targets = [{ f: (coarseFraction + fineFraction) / 2, deg: 0 }];
    const samples = profiledSplineOptimizationSeed(input).samples.map((sample) => ({
      ...sample, headingRad: sample.s, velocityMps: 1,
    }));
    const dense = buildDenseValidationSamples(input, samples, 8);
    expect(dense.every((sample, index) => !index || sample.headingRad >= dense[index - 1].headingRad)).toBe(true);
  });

  it("does not manufacture angular acceleration while densifying a smooth heading curve", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.waypoints = buildWaypoints([
      { x: 0, y: 0, theta: 0, segType: "line" },
      { x: 4, y: 0, theta: 90 },
    ]);
    const samples: TrajectorySample[] = Array.from({ length: 9 }, (_, i) => {
      const s = i / 2;
      return { i, s, f: s / 4, x: s, y: 0, t: s, headingRad: 0.1 * s * s,
        velocityMps: 1, accelerationMps2: 0, angularVelocityRadps: 0.2 * s, curvatureInvM: 0 };
    });
    for (const multiplier of [2, 4, 8]) {
      const dense = buildDenseValidationSamples({ path, robot: project.robot }, samples, 8, multiplier);
      for (let index = 1; index < dense.length; index += 1) {
        const before = dense[index - 1], after = dense[index];
        if (before.s < 1 || after.s > 3) continue;
        const acceleration = (after.angularVelocityRadps - before.angularVelocityRadps) / (after.t - before.t);
        expect(acceleration).toBeCloseTo(0.2, 5);
      }
    }
  });

  it("keeps the captured turn moving without relaxing its authored limits", () => {
    const input: PlannerInput = { ...structuredClone(turnFixture) as Pick<PlannerInput, "path" | "robot">, samplesPerSegment: 56 };
    const result = getPlanner("profiledSpline").generate(input);
    const minimum = Math.min(...result.samples.filter((sample) => sample.f > 0.48 && sample.f < 0.64)
      .map((sample) => sample.velocityMps / 0.3048));
    expect(minimum).toBeGreaterThan(4.5);
    expect(result.totalTimeS).toBeLessThan(5);
    expect(result.diagnostics.filter((issue) => issue.severity === "error")).toEqual([]);
    for (const multiplier of [2, 4, 8]) {
      const dense = buildDenseValidationSamples(input, result.samples,
        56 * 2 ** (result.optimization?.refinementPasses ?? 0), multiplier);
      expect(validateOptimizedTrajectory(input, dense, { angularKinematics: "sample" }).violations).toEqual([]);
    }
  });
  it("does not brake for projection artifacts at directed-turn subdivision knots", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    // Curved geometry and an off-grid target put inserted turn knots on
    // different chords at planning and validation resolutions.
    path.waypoints = buildWaypoints([
      { x: 2.2, y: 4, theta: 0, nextC: { x: 3.69, y: 3.13 } },
      { x: 8.17, y: 6.04, theta: 0, rotationDirection: "ccw", prevC: { x: 7.39, y: 6.04 } },
    ]);
    path.targets = [{ f: 0.486366, deg: 81.7 }];
    const input = { path, robot: project.robot, samplesPerSegment: 56 };
    const geometry = insertOptimizationBoundaries(input, profiledSplineOptimizationSeed(input).samples);
    const profile = solveReachabilityProfile(buildReachabilityInput(input, geometry));
    expect(profile.status).toBe("optimal");
    const timed = remapTiming(geometry, profile.velocities);
    for (const multiplier of [2, 4, 8]) {
      const dense = buildDenseValidationSamples(input, timed, 56, multiplier);
      expect(validateOptimizedTrajectory(input, dense, { angularKinematics: "sample" }).violations).toEqual([]);
    }
    const result = getPlanner("profiledSpline").generate(input);
    expect(result.diagnostics.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(result.totalTimeS).toBeCloseTo(timed.at(-1)!.t, 5);
    const braking = result.samples.filter((sample) => sample.f > 0.85);
    expect(braking.every((sample, index) => !index || sample.velocityMps <= braking[index - 1].velocityMps)).toBe(true);
    expect(result.samples.at(-1)!.headingRad).toBeCloseTo(2 * Math.PI, 6);
  });

  it("preserves an already exact heading law when inserting optimization boundaries", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "targets";
    path.waypoints = buildWaypoints([
      { x: 0, y: 0, theta: 0, segType: "line" },
      { x: 8, y: 0, theta: 100 },
    ]);
    path.targets = [{ f: 0.301, deg: 20 }, { f: 0.607, deg: 65 }];
    const input = { path, robot: project.robot, samplesPerSegment: 56 };
    const seed = profiledSplineOptimizationSeed(input);
    const samples = insertOptimizationBoundaries(input, seed.samples);
    for (const sample of seed.samples) {
      const actual = samples.find((candidate) => candidate.f === sample.f)!;
      expect(actual.headingRad).toBeCloseTo(sample.headingRad, 10);
    }
  });

  it("differentiates heading at the sample position on an uneven distance grid", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.waypoints = buildWaypoints([
      { x: 0, y: 0, theta: 0, segType: "line" },
      { x: 4, y: 0, theta: 0 },
    ]);
    const samples: TrajectorySample[] = [0, 0.5, 0.99, 1, 1.5, 2, 3, 4].map((s, i) => ({
      i, s, f: s / 4, x: s, y: 0, t: s,
      headingRad: 0.1 * s * s, velocityMps: 1, accelerationMps2: 0,
      angularVelocityRadps: 0.2 * s, curvatureInvM: 0,
    }));
    const state = buildCanonicalPathState(path, samples);
    for (const point of state.points.slice(2, -2)) {
      expect(point.headingDerivativeRadPerM).toBeCloseTo(0.2 * point.s, 10);
      expect(point.headingSecondDerivativeRadPerM2).toBeCloseTo(0.2, 10);
    }
  });
});
