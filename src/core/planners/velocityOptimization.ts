import type { TrajectorySample } from "../types";

const EPSILON = 1e-9;
const CONSTRAINT_SAFETY = 0.995;
const R = (value: number, places = 4) => Number(value.toFixed(places));

export interface LinearVelocityLimit {
  freeSpeed: number;
  velocity: number;
  acceleration: number;
  deceleration: number;
}

export interface LinearVelocityProfile {
  points: LinearVelocityLimit[];
  intervals: LinearVelocityLimit[];
}

function enforceLinearLimits(
  limits: LinearVelocityProfile,
  samples: readonly TrajectorySample[],
  velocities: number[],
): void {
  for (let iteration = 0; iteration < 4; iteration += 1) {
    for (let index = 1; index < samples.length; index += 1) {
      const ds = Math.max(0, samples[index].s - samples[index - 1].s);
      const interval = limits.intervals[index];
      const availableAcceleration = interval.acceleration
        * Math.max(0, Math.min(1, 1 - velocities[index - 1] / interval.freeSpeed))
        * CONSTRAINT_SAFETY;
      velocities[index] = Math.min(
        velocities[index],
        interval.velocity,
        Math.sqrt(velocities[index - 1] ** 2 + 2 * availableAcceleration * ds),
      );
    }

    for (let index = samples.length - 2; index >= 0; index -= 1) {
      const ds = Math.max(0, samples[index + 1].s - samples[index].s);
      const interval = limits.intervals[index + 1];
      velocities[index] = Math.min(
        velocities[index],
        interval.velocity,
        Math.sqrt(velocities[index + 1] ** 2 + 2 * interval.deceleration * CONSTRAINT_SAFETY * ds),
      );
    }
  }
}

export function optimizeVelocities(
  samples: readonly TrajectorySample[],
  limits: LinearVelocityProfile,
  startVelocity: number,
  endVelocity: number,
  smoothingPasses = 2,
): number[] {
  if (samples.length === 0) return [];
  const velocities = samples.map((sample, index) => Math.min(
    limits.points[index].velocity,
    Math.max(0, sample.velocityMps),
  ));
  velocities[0] = Math.min(limits.points[0].velocity, Math.max(0, startVelocity));
  velocities[velocities.length - 1] = Math.min(limits.points.at(-1)!.velocity, Math.max(0, endVelocity));

  enforceLinearLimits(limits, samples, velocities);
  for (let pass = 0; pass < smoothingPasses; pass += 1) {
    const next = velocities.slice();
    for (let index = 1; index < velocities.length - 1; index += 1) {
      if (velocities[index] <= EPSILON) continue;
      next[index] = Math.min(velocities[index], velocities[index - 1] * 0.22 + velocities[index] * 0.56 + velocities[index + 1] * 0.22);
    }
    for (let index = 0; index < velocities.length; index += 1) velocities[index] = next[index];
  }
  enforceLinearLimits(limits, samples, velocities);
  return velocities;
}

export function remapTrajectoryTiming(samples: readonly TrajectorySample[], velocities: number[]): TrajectorySample[] {
  if (samples.length < 2) return samples.slice();
  const times = new Array(samples.length).fill(0);
  for (let index = 1; index < samples.length; index += 1) {
    const ds = Math.max(0, samples[index].s - samples[index - 1].s);
    const averageVelocity = Math.max(1e-6, (velocities[index] + velocities[index - 1]) * 0.5);
    times[index] = times[index - 1] + ds / averageVelocity;
  }

  return samples.map((sample, index) => {
    const previousDt = index > 0 ? Math.max(1e-6, times[index] - times[index - 1]) : 0;
    const nextDt = index < samples.length - 1 ? Math.max(1e-6, times[index + 1] - times[index]) : previousDt;
    const acceleration = index === 0 || index === samples.length - 1
      ? 0
      : (velocities[index + 1] - velocities[index - 1]) / Math.max(1e-6, previousDt + nextDt);
    const headingDelta = index === 0
      ? 0
      : Math.atan2(Math.sin(sample.headingRad - samples[index - 1].headingRad), Math.cos(sample.headingRad - samples[index - 1].headingRad));
    return {
      ...sample,
      t: R(times[index], 4),
      velocityMps: R(velocities[index], 4),
      accelerationMps2: R(acceleration, 4),
      angularVelocityRadps: R(index === 0 ? 0 : headingDelta / previousDt, 5),
    };
  });
}
