import type { BdxMarker, PathDoc, RobotConfig, TrajectorySample } from '../types';
import { buildCanonicalPathState } from './pathState';
import { evaluateDrivetrainPower } from './drivetrainProjection';
import { mechanismCurrent, predictBus, summarizePower, type PowerInterval, type PowerReport } from '../electricalPower';
import { driveContacts } from '../loadTransfer';
import { commandLoadWindows, commandsWithoutLoad, planningRobotForPath, type CommandLoadWindow } from '../commandLoads';

/** Where mechanism current can change: legacy timed loads and command windows. */
function loadBoundaries(robot: RobotConfig, commands: readonly CommandLoadWindow[]): number[] {
  return [...(robot.driveModel?.loadBursts ?? []), ...commands].flatMap(load => [load.startTimeS, load.endTimeS]);
}

/**
 * Analyze final samples, including waits/turns. Load boundaries are integrated exactly. Wheel forces are allocated
 * under `allocationRobot`, the per-path planning robot, as planning and export allocate them; the bus sees the
 * scheduled mechanism current.
 */
export function trajectoryPowerIntervals(robot: RobotConfig, path: PathDoc, samples: readonly TrajectorySample[], offsetS = 0,
  commands: readonly CommandLoadWindow[] = [], allocationRobot: RobotConfig = robot): PowerInterval[] {
  if (samples.length < 2) return [];
  const state = buildCanonicalPathState(path, samples);
  const intervals: PowerInterval[] = [];
  const boundaries = loadBoundaries(robot, commands);
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i], b = samples[i + 1], dt = b.t - a.t;
    if (!(dt > 0)) continue;
    const start = a.t + offsetS, end = b.t + offsetS;
    // Subdivide moving intervals; constant waits require only their load boundaries.
    const moving = Math.abs(a.velocityMps) + Math.abs(b.velocityMps) + Math.abs(a.angularVelocityRadps) + Math.abs(b.angularVelocityRadps) > 1e-9;
    const count = moving ? Math.max(1, Math.ceil(dt / 0.02)) : 1;
    const cuts = [start, end, ...boundaries.filter(t => t > start && t < end)];
    for (let j = 1; j < count; j++) cuts.push(start + dt * j / count);
    cuts.sort((x, y) => x - y);
    for (let j = 0; j < cuts.length - 1; j++) {
      if (!(cuts[j + 1] > cuts[j])) continue;
      const time = (cuts[j] + cuts[j + 1]) / 2, f = (time - start) / dt;
      const p = state.points[i], q = state.points[i + 1];
      const mix = (x: number, y: number) => x + f * (y - x);
      const tangent = Math.atan2(mix(p.tangentY, q.tangentY), mix(p.tangentX, q.tangentX));
      const headingDelta = Math.atan2(Math.sin(b.headingRad - a.headingRad), Math.cos(b.headingRad - a.headingRad));
      const bus = evaluateDrivetrainPower({
        headingRad: a.headingRad + f * headingDelta, tangentX: Math.cos(tangent), tangentY: Math.sin(tangent),
        normalX: -Math.sin(tangent), normalY: Math.cos(tangent), curvatureInvM: mix(p.curvatureInvM, q.curvatureInvM),
      }, allocationRobot, mix(a.velocityMps, b.velocityMps), (b.velocityMps - a.velocityMps) / dt,
      mix(a.angularVelocityRadps, b.angularVelocityRadps), (b.angularVelocityRadps - a.angularVelocityRadps) / dt,
      mechanismCurrent(robot, time, commands));
      if (bus) intervals.push({ startTimeS: cuts[j], endTimeS: cuts[j + 1], bus });
    }
  }
  return intervals;
}

export function idlePowerIntervals(robot: RobotConfig, startTimeS: number, endTimeS: number, commands: readonly CommandLoadWindow[] = []): PowerInterval[] {
  const cuts = [startTimeS, endTimeS, ...loadBoundaries(robot, commands).filter(t => t > startTimeS && t < endTimeS)].sort((a, b) => a - b);
  return cuts.slice(1).flatMap((end, i) => {
    if (end <= cuts[i]) return [];
    const bus = predictBus(robot, driveContacts(robot).map(contact => ({ label: contact.label, speedMps: 0, forceN: 0 })), mechanismCurrent(robot, (cuts[i] + end) / 2, commands));
    return bus ? [{ startTimeS: cuts[i], endTimeS: end, bus }] : [];
  });
}

function lastCommandEnd(commands: readonly CommandLoadWindow[], endS: number): number {
  for (const window of commands) endS = Math.max(endS, window.endTimeS);
  return endS;
}

export interface PlannedTrajectory { samples: TrajectorySample[]; markers?: BdxMarker[]; optimizedPath?: PathDoc }
/** The estimate plus the commands it started that have no configured load, so it added no current for them. */
export type PowerAnalysis = PowerReport & { commandsWithoutLoad: string[] };

/** `path` is the authored path: its events say which commands start; the trajectory says when. */
export function analyzeTrajectoryPower(robot: RobotConfig, path: PathDoc, trajectory: PlannedTrajectory): PowerAnalysis | null {
  const commands = commandLoadWindows(robot, path, trajectory);
  const intervals = trajectoryPowerIntervals(robot, trajectory.optimizedPath || path, trajectory.samples, 0, commands, planningRobotForPath(robot, path));
  // A command still running when the path ends keeps drawing while the robot waits.
  const endS = trajectory.samples.length ? trajectory.samples[trajectory.samples.length - 1].t : 0;
  for (const interval of idlePowerIntervals(robot, endS, lastCommandEnd(commands, endS), commands)) intervals.push(interval);
  return intervals.length ? { ...summarizePower(robot, intervals), commandsWithoutLoad: commandsWithoutLoad(robot.driveModel, path.markers) } : null;
}

/**
 * A chosen, completely timed preview, not a guarantee about runtime command durations or unselected branches.
 * A command an earlier path started keeps drawing through later waits and paths until its window ends.
 */
export function analyzeRoutinePower(robot: RobotConfig, segments: readonly {
  t0: number; t1: number; doc: PathDoc; trajectory: PlannedTrajectory | null;
}[], totalTimeS: number): PowerAnalysis | null {
  const commands: CommandLoadWindow[] = [];
  const unloaded = new Set<string>();
  let time = 0;
  for (const segment of segments) {
    if (!segment.trajectory || segment.t0 < time - 1e-9) return null;
    for (const window of commandLoadWindows(robot, segment.doc, segment.trajectory, segment.t0)) commands.push(window);
    commandsWithoutLoad(robot.driveModel, segment.doc.markers).forEach(id => unloaded.add(id));
    time = segment.t1;
  }
  const intervals: PowerInterval[] = [];
  time = 0;
  for (const segment of segments) {
    const trajectory = segment.trajectory!;
    for (const interval of idlePowerIntervals(robot, time, segment.t0, commands)) intervals.push(interval);
    for (const interval of trajectoryPowerIntervals(robot, trajectory.optimizedPath || segment.doc, trajectory.samples, segment.t0, commands,
      planningRobotForPath(robot, segment.doc))) intervals.push(interval);
    time = segment.t1;
  }
  for (const interval of idlePowerIntervals(robot, time, lastCommandEnd(commands, totalTimeS), commands)) intervals.push(interval);
  return intervals.length ? { ...summarizePower(robot, intervals), commandsWithoutLoad: [...unloaded].sort() } : null;
}
