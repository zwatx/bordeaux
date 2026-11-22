import { describe, expect, it } from "vitest";
import {
  solveReachabilityProfile,
  type ReachabilityInput,
} from "../src/core/planners/reachability";

const GRID_STEP = 0.02;
const MAX_SQUARED_SPEED = 4;

function transitionIsFeasible(input: ReachabilityInput, interval: number, before: number, after: number): boolean {
  const distance = input.positions[interval + 1] - input.positions[interval];
  const acceleration = (after - before) / (2 * distance);
  if (acceleration > input.accelerationLimits[interval] + 1e-9
    || -acceleration > input.decelerationLimits[interval] + 1e-9) return false;
  const midpoint = (before + after) * 0.5;
  for (const constraint of input.accelerationConstraints?.[interval] ?? []) {
    const measured = Math.hypot(
      constraint.uX * acceleration + constraint.xX * midpoint,
      constraint.uY * acceleration + constraint.xY * midpoint,
    );
    if (measured > constraint.limit + 1e-9) return false;
  }
  for (const constraint of input.scalarAccelerationConstraints?.[interval] ?? []) {
    const measured = constraint.u * acceleration + constraint.x * midpoint;
    if (measured < constraint.minimum - 1e-9 || measured > constraint.maximum + 1e-9) return false;
  }
  return true;
}

function discreteOracle(input: ReachabilityInput): number {
  const states = Array.from({ length: Math.round(MAX_SQUARED_SPEED / GRID_STEP) + 1 }, (_unused, index) => index * GRID_STEP);
  let costs = states.map((state) => state === input.startVelocity ** 2 ? 0 : Number.POSITIVE_INFINITY);
  for (let interval = 0; interval < input.positions.length - 1; interval += 1) {
    const nextCosts = states.map(() => Number.POSITIVE_INFINITY);
    const distance = input.positions[interval + 1] - input.positions[interval];
    for (let beforeIndex = 0; beforeIndex < states.length; beforeIndex += 1) {
      if (!Number.isFinite(costs[beforeIndex])) continue;
      const before = states[beforeIndex];
      for (let afterIndex = 0; afterIndex < states.length; afterIndex += 1) {
        const after = states[afterIndex];
        if (Math.sqrt(after) > input.velocityLimits[interval + 1] + 1e-9
          || !transitionIsFeasible(input, interval, before, after)) continue;
        const denominator = Math.sqrt(before) + Math.sqrt(after);
        if (denominator <= 1e-9) continue;
        nextCosts[afterIndex] = Math.min(nextCosts[afterIndex], costs[beforeIndex] + 2 * distance / denominator);
      }
    }
    costs = nextCosts;
  }
  return costs[Math.round(input.goalVelocity ** 2 / GRID_STEP)];
}

function randomGenerator(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function oracleInput(seed: number): ReachabilityInput {
  const random = randomGenerator(seed);
  const positions = [0, 0.7 + random() * 0.6, 1.8 + random() * 0.5, 3];
  const accelerationConstraints = positions.slice(1).map(() => [{
    uX: 0.7 + random() * 0.3,
    uY: random() * 0.2,
    xX: random() * 0.25,
    xY: random() * 0.25,
    limit: 1.2 + random() * 1.2,
  }]);
  return {
    positions,
    velocityLimits: [0, 2, 2, 0],
    accelerationLimits: positions.slice(1).map(() => 1.5 + random()),
    decelerationLimits: positions.slice(1).map(() => 1.5 + random()),
    freeSpeeds: positions.slice(1).map(() => 1e9),
    accelerationConstraints,
    scalarAccelerationConstraints: positions.slice(1).map(() => [{
      u: 0.6 + random() * 0.4,
      x: (random() - 0.5) * 0.3,
      minimum: -2,
      maximum: 2,
    }]),
    startVelocity: 0,
    goalVelocity: 0,
  };
}

describe("reachability oracle", () => {
  it("never rejects or loses to independently enumerated feasible profiles", () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const input = oracleInput(seed);
      const oracleTime = discreteOracle(input);
      expect(Number.isFinite(oracleTime), `oracle case ${seed}`).toBe(true);
      const result = solveReachabilityProfile(input);
      expect(result.status, `solver case ${seed}`).toBe("optimal");
      result.velocities.slice(1).forEach((velocity, index) => {
        expect(transitionIsFeasible(input, index, result.velocities[index] ** 2, velocity ** 2), `transition ${seed}:${index}`).toBe(true);
      });
      const solverTime = input.positions.slice(1).reduce((total, position, index) => (
        total + 2 * (position - input.positions[index])
          / (result.velocities[index] + result.velocities[index + 1])
      ), 0);
      expect(solverTime, `time case ${seed}`).toBeLessThanOrEqual(oracleTime + 1e-6);
    }
  });
});
