import { expect, it } from "vitest";
import { densifyRobotSamples } from "../src/core/export/robotSamples";
import type { TrajectorySample } from "../src/core/types";

const sample = (i: number, t: number, velocityMps = 0): TrajectorySample => ({
  i, t, velocityMps, s: t, f: t, x: t, y: 0, headingRad: 0,
  accelerationMps2: 0, angularVelocityRadps: 0, curvatureInvM: 0,
});
const area = (samples: TrajectorySample[]) => samples.slice(1).reduce((sum, after, index) => {
  const before = samples[index];
  return sum + (after.t - before.t) * (after.velocityMps + before.velocityMps) / 2;
}, 0);

it("preserves an off-grid triangular peak, endpoints, velocity area and acceleration", () => {
  const original = [sample(0, 0), sample(1, 0.137, 1.5), sample(2, 0.401)];
  const { samples, sourceIndices } = densifyRobotSamples(original, [0, 0, 0]);
  expect(area(samples)).toBeCloseTo(area(original), 14);
  expect(Math.max(...samples.map(row => row.velocityMps))).toBe(1.5);
  original.forEach((row, index) => expect(samples[sourceIndices[index]]).toEqual({ ...row, i: sourceIndices[index] }));
  samples.slice(1).forEach((row, index) => {
    const before = samples[index], dt = row.t - before.t;
    expect(dt).toBeGreaterThan(0);
    expect(dt).toBeLessThanOrEqual(0.020000001);
    expect((row.velocityMps - before.velocityMps) / dt).toBeCloseTo(row.t <= 0.137 ? 1.5 / 0.137 : -1.5 / 0.264, 10);
  });
  expect(densifyRobotSamples(samples, samples.map(() => 0)).samples).toEqual(samples);
});

it("keeps duplicate-time boundaries and interpolates independent fractions and wrapped headings", () => {
  const original = [sample(0, 0), sample(1, 0), { ...sample(2, 0.06), f: 0 }];
  original[0].headingRad = original[1].headingRad = 179 * Math.PI / 180;
  original[2].headingRad = -179 * Math.PI / 180;
  const result = densifyRobotSamples(original, original.map(row => row.headingRad));
  expect(result.sourceIndices).toEqual([0, 1, 4]);
  expect(result.samples.map(row => row.f)).toEqual([0, 0, 0, 0, 0]);
  expect(result.samples[2].s).toBeCloseTo(0.02);
  expect(result.samples[2].headingRad).toBeCloseTo((179 + 2 / 3) * Math.PI / 180);
  expect(result.travelHeadings[2]).toBeCloseTo(result.samples[2].headingRad);
  expect(result.samples[4].headingRad).toBe(original[2].headingRad);
});

it("rejects invalid time and oversized expansions before allocating output", () => {
  expect(() => densifyRobotSamples([sample(0, 0), sample(1, 2000)], [0, 0])).toThrow(/100000/);
  expect(() => densifyRobotSamples([sample(0, 0), sample(1, Number.MAX_VALUE)], [0, 0])).toThrow(/100000/);
  expect(() => densifyRobotSamples([sample(0, 0), sample(1, -1)], [0, 0])).toThrow(/nondecreasing/);
  expect(() => densifyRobotSamples([sample(0, 0), sample(1, NaN)], [0, 0])).toThrow(/invalid/);
});
