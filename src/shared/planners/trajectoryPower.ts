import type { PathDoc, RobotConfig, TrajectorySample } from '../types';
import { buildCanonicalPathState } from './pathState';
import { evaluateDrivetrainPower } from './drivetrainProjection';
import { mechanismCurrent, predictBus, summarizePower, type PowerInterval } from '../electricalPower';
import { driveContacts } from '../loadTransfer';

/** Analyze final samples, including waits/turns. Burst boundaries are integrated exactly. */
export function trajectoryPowerIntervals(robot: RobotConfig, path: PathDoc, samples: readonly TrajectorySample[], offsetS = 0): PowerInterval[] {
  if (samples.length < 2) return [];
  const state = buildCanonicalPathState(path, samples);
  const intervals: PowerInterval[] = [];
  const boundaries = (robot.driveModel?.loadBursts ?? []).flatMap(b => [b.startTimeS, b.endTimeS]);
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i], b = samples[i + 1], dt = b.t - a.t;
    if (!(dt > 0)) continue;
    const start = a.t + offsetS, end = b.t + offsetS;
    // Subdivide moving intervals; constant waits require only their burst boundaries.
    const moving = Math.abs(a.velocityMps) + Math.abs(b.velocityMps) + Math.abs(a.angularVelocityRadps) + Math.abs(b.angularVelocityRadps) > 1e-9;
    const count = moving ? Math.max(1, Math.ceil(dt / 0.02)) : 1;
    const cuts = [start, end, ...boundaries.filter(t => t > start && t < end)];
    for (let j = 1; j < count; j++) cuts.push(start + dt * j / count);
    cuts.sort((x, y) => x - y);
    for (let j = 0; j < cuts.length - 1; j++) {
      const time = (cuts[j] + cuts[j + 1]) / 2, f = (time - start) / dt;
      const p = state.points[i], q = state.points[i + 1];
      const mix = (x: number, y: number) => x + f * (y - x);
      const tangent = Math.atan2(mix(p.tangentY, q.tangentY), mix(p.tangentX, q.tangentX));
      const headingDelta = Math.atan2(Math.sin(b.headingRad - a.headingRad), Math.cos(b.headingRad - a.headingRad));
      const bus = evaluateDrivetrainPower({
        headingRad: a.headingRad + f * headingDelta, tangentX: Math.cos(tangent), tangentY: Math.sin(tangent),
        normalX: -Math.sin(tangent), normalY: Math.cos(tangent), curvatureInvM: mix(p.curvatureInvM, q.curvatureInvM),
      }, robot, mix(a.velocityMps, b.velocityMps), (b.velocityMps - a.velocityMps) / dt,
      mix(a.angularVelocityRadps, b.angularVelocityRadps), (b.angularVelocityRadps - a.angularVelocityRadps) / dt,
      mechanismCurrent(robot, time));
      if (bus) intervals.push({ startTimeS: cuts[j], endTimeS: cuts[j + 1], bus });
    }
  }
  return intervals;
}

export function idlePowerIntervals(robot: RobotConfig, startTimeS: number, endTimeS: number): PowerInterval[] {
  const cuts = [startTimeS, endTimeS, ...(robot.driveModel?.loadBursts ?? [])
    .flatMap(b => [b.startTimeS, b.endTimeS]).filter(t => t > startTimeS && t < endTimeS)].sort((a, b) => a - b);
  return cuts.slice(1).flatMap((end, i) => {
    if (end <= cuts[i]) return [];
    const bus = predictBus(robot, driveContacts(robot).map(contact => ({ label: contact.label, speedMps: 0, forceN: 0 })), mechanismCurrent(robot, (cuts[i] + end) / 2));
    return bus ? [{ startTimeS: cuts[i], endTimeS: end, bus }] : [];
  });
}

export function analyzeTrajectoryPower(robot: RobotConfig, path: PathDoc, samples: readonly TrajectorySample[]) {
  const intervals = trajectoryPowerIntervals(robot, path, samples);
  return intervals.length ? summarizePower(robot, intervals) : null;
}

/** A chosen, completely timed preview, not a guarantee about runtime command durations or unselected branches. */
export function analyzeRoutinePower(robot: RobotConfig, segments: readonly {
  t0: number; t1: number; doc: PathDoc; trajectory: { samples: TrajectorySample[]; optimizedPath?: PathDoc } | null;
}[], totalTimeS: number) {
  const intervals: PowerInterval[] = [];
  let time = 0;
  for (const segment of segments) {
    if (!segment.trajectory || segment.t0 < time - 1e-9) return null;
    intervals.push(...idlePowerIntervals(robot, time, segment.t0));
    intervals.push(...trajectoryPowerIntervals(robot, segment.trajectory.optimizedPath || segment.doc, segment.trajectory.samples, segment.t0));
    time = segment.t1;
  }
  intervals.push(...idlePowerIntervals(robot, time, totalTimeS));
  return intervals.length ? summarizePower(robot, intervals) : null;
}
