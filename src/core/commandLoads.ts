import type { CommandInvocation, CommandLoad, CommandPowerEstimate, Marker, RobotConfig, TrajectorySample } from "./types";
import { markerInvocations } from "./markerCommands";
import { sha256Hex } from "./bytes";

type DriveModel = NonNullable<RobotConfig["driveModel"]>;

export const MAX_COMMAND_LOADS = 128;
/** Bounds of a use's power estimate. */
export const COMMAND_CURRENT_MAX_A = 500;
/**
 * Most robot ids one use may hold estimates for. Removing a robot leaves its estimates for the robots that share them,
 * so a use can hold more ids than a project has robots.
 */
export const COMMAND_POWER_ROBOTS_MAX = 256;
export const COMMAND_RUN_TIME_MIN_S = 0.01;
export const COMMAND_RUN_TIME_MAX_S = 3600;
/** Longest stored input key; `commandInputKey` writes 64 characters. */
export const COMMAND_INPUT_KEY_MAX = 128;
/** Repeats past this many starts are treated as one continuous range of starts, which can only overstate the load. */
const MAX_REPEAT_STARTS = 1000;

/*
 * Command power. Each use of a command (a path event's invocation, each command of an event's group, a routine
 * command step) carries its own optional estimate per project robot in `CommandInvocation.power`, because a command's
 * draw depends on its arguments. On robot R a use plans with, in order: R's own estimate; else the estimate of the
 * first robot in `R.estimatesFrom` that has one on that use (a duplicated robot shares its original's until it enters
 * its own); else R's legacy `driveModel.commandLoads` entry for its command, so projects made before per-use estimates
 * plan the same; else nothing.
 *
 * The robot is identified by `RobotConfig.id`, which the selected robot (`project.robot`) carries. A robot without an
 * id resolves legacy loads only. `planningRobotForPath` folds a path's reserve into Other mechanisms and drops the id,
 * `estimatesFrom` and the legacy table, so folding twice changes nothing.
 */

/** What resolves a use's estimate on one robot: its id, the robots it shares estimates from, and its legacy loads. */
export type EstimateRobot = Pick<RobotConfig, "id" | "estimatesFrom" | "driveModel">;

/** When one command's current flows, in seconds on the analyzed path or routine clock. */
export interface CommandLoadWindow { commandId: string; startTimeS: number; endTimeS: number; currentA: number }

/** A use's estimate for one robot, resolved for planning and reports. */
export interface ResolvedCommandEstimate {
  currentA: number;
  runTimeS?: number;
  /** The use's command or arguments changed since the estimate was entered. It still plans; the UI asks for review. */
  stale: boolean;
  /**
   * "use": the use's own estimate for the robot. "inherited": the estimate of `fromRobotId`, a robot in its
   * `estimatesFrom`, for a use without its own. "legacy": the robot's per-command load, for a use with neither.
   */
  source: "use" | "inherited" | "legacy";
  /** With "inherited": the robot whose estimate this is. */
  fromRobotId?: string;
}

export function commandLoadFor(model: DriveModel | undefined, commandId: string): CommandLoad | undefined {
  const loads = model?.commandLoads;
  return Array.isArray(loads) ? loads.find((load) => load.commandId === commandId) : undefined;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, (item as Record<string, unknown>)[key]]))
    : item);
}

/**
 * What an estimate was entered against: the command and its arguments, with object keys in a fixed order, hashed to
 * 64 hex characters. Loop, cancel and power settings are not part of it: they change how long a use runs, not what it
 * draws while it runs.
 */
export function commandInputKey(invocation: Pick<CommandInvocation, "commandId" | "arguments">): string {
  return sha256Hex(canonicalJson({ commandId: invocation.commandId, arguments: invocation.arguments ?? {} }));
}

/** The use's own stored estimate for `robotId`, ignoring malformed data so unvalidated scans stay safe. */
export function storedCommandEstimate(invocation: CommandInvocation, robotId: string | undefined): CommandPowerEstimate | undefined {
  const power = invocation.power;
  if (robotId === undefined || !power || typeof power !== "object" || !Object.prototype.hasOwnProperty.call(power, robotId)) return undefined;
  const estimate = power[robotId];
  return estimate && typeof estimate === "object" && Number.isFinite(estimate.currentA) ? estimate : undefined;
}

/** The stored estimate `robot` plans with on a use, its own or the first inherited one, and whose it is. */
function storedPlanningEstimate(invocation: CommandInvocation, robot: EstimateRobot): { estimate: CommandPowerEstimate; robotId: string } | undefined {
  if (robot.id === undefined) return undefined;
  const own = storedCommandEstimate(invocation, robot.id);
  if (own) return { estimate: own, robotId: robot.id };
  const from = robot.estimatesFrom;
  if (!Array.isArray(from)) return undefined;
  for (const robotId of from) {
    const inherited = typeof robotId === "string" && robotId !== robot.id ? storedCommandEstimate(invocation, robotId) : undefined;
    if (inherited) return { estimate: inherited, robotId };
  }
  return undefined;
}

/** Current and run time for planning; skips the stale check, which planning does not need. */
function planningEstimate(invocation: CommandInvocation, robot: EstimateRobot): { currentA: number; runTimeS?: number } | undefined {
  return storedPlanningEstimate(invocation, robot)?.estimate ?? commandLoadFor(robot.driveModel, invocation.commandId);
}

/**
 * The estimate one use plans with on `robot`: its own, else the first one inherited through `robot.estimatesFrom`,
 * else the legacy load of its command on `robot.driveModel`. Undefined when it has none, so it adds no current.
 * `stale` compares the stored estimate's input key, inherited ones included, with the use's command and arguments.
 */
export function commandUseEstimate(invocation: CommandInvocation, robot: EstimateRobot): ResolvedCommandEstimate | undefined {
  const stored = storedPlanningEstimate(invocation, robot);
  if (stored) {
    const { estimate, robotId } = stored;
    const inherited = robotId !== robot.id;
    return { currentA: estimate.currentA, ...(estimate.runTimeS !== undefined ? { runTimeS: estimate.runTimeS } : {}),
      stale: estimate.inputKey !== commandInputKey(invocation), source: inherited ? "inherited" : "use", ...(inherited ? { fromRobotId: robotId } : {}) };
  }
  const legacy = commandLoadFor(robot.driveModel, invocation.commandId);
  return legacy ? { currentA: legacy.currentA, ...(legacy.runTimeS !== undefined ? { runTimeS: legacy.runTimeS } : {}), stale: false, source: "legacy" } : undefined;
}

/**
 * Current path timing reserves for the commands a path's events start. Each command counts once, for the whole path,
 * at the largest estimate among its uses: command timing on the robot can differ from the local preview, and a reserve
 * that assumed the preview's overlaps could be invalidated by it. One command cannot run twice at once, so its uses
 * never add.
 */
export function pathCommandReserveA(robot: EstimateRobot, markers: readonly Marker[] | undefined): number {
  if (robot.id === undefined && !robot.driveModel?.commandLoads?.length) return 0;
  const largest = new Map<string, number>();
  for (const marker of markers ?? []) {
    for (const invocation of markerInvocations(marker)) {
      const estimate = planningEstimate(invocation, robot);
      const previous = largest.get(invocation.commandId);
      if (estimate) largest.set(invocation.commandId, previous === undefined ? estimate.currentA : Math.max(previous, estimate.currentA));
    }
  }
  let total = 0;
  for (const current of largest.values()) total += current;
  return total;
}

/**
 * The robot as planning sees one path: the path's command reserve folded into Other mechanisms, without the robot's id,
 * `estimatesFrom` or legacy load table. Applying it twice changes nothing, so planner stages that receive an already
 * planned input stay consistent, and planning keys depend on the reserve, not on which robot entry produced it or
 * whose estimates it shares.
 */
export function planningRobotForPath(robot: RobotConfig, path: { markers?: readonly Marker[] }): RobotConfig {
  const model = robot.driveModel;
  if (robot.id === undefined && robot.estimatesFrom === undefined && !model?.commandLoads) return robot;
  const { id: _id, estimatesFrom: _from, ...rest } = robot;
  if (!model) return rest;
  const { commandLoads: _loads, ...modelRest } = model;
  const reserve = pathCommandReserveA(robot, path.markers);
  return { ...rest, driveModel: { ...modelRest, ...(reserve > 0 || model.otherLoadA !== undefined ? { otherLoadA: (model.otherLoadA ?? 0) + reserve } : {}) } };
}

/** How many command uses an analysis covered, and how many plan with an estimate or with a stale one. */
export interface CommandEstimateCoverage { uses: number; estimated: number; stale: number }

function countUse(coverage: CommandEstimateCoverage, estimate: ResolvedCommandEstimate | undefined): void {
  coverage.uses++;
  if (estimate) coverage.estimated++;
  if (estimate?.stale) coverage.stale++;
}

/** Uses on a path's events with and without an estimate for `robot`. */
export function pathCommandCoverage(robot: EstimateRobot, markers: readonly Marker[] | undefined): CommandEstimateCoverage {
  const coverage = { uses: 0, estimated: 0, stale: 0 };
  for (const marker of markers ?? []) for (const invocation of markerInvocations(marker)) countUse(coverage, commandUseEstimate(invocation, robot));
  return coverage;
}

/** Commands a path starts with at least one use that has no estimate; those uses add no current. */
export function commandsWithoutLoad(robot: EstimateRobot, markers: readonly Marker[] | undefined): string[] {
  const ids = new Set<string>();
  for (const marker of markers ?? []) {
    for (const invocation of markerInvocations(marker)) if (!planningEstimate(invocation, robot)) ids.add(invocation.commandId);
  }
  return [...ids].sort();
}

/** Time at which the robot has driven `meters` beyond where it was at `timeS`, or null if the path ends first. */
function timeAfterDistance(samples: readonly TrajectorySample[], timeS: number, meters: number): number | null {
  let s0 = samples[0].s;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (timeS <= b.t) { s0 = a.s + (b.s - a.s) * Math.max(0, Math.min(1, (timeS - a.t) / Math.max(1e-9, b.t - a.t))); break; }
    s0 = b.s;
  }
  const target = s0 + meters;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (b.t < timeS || b.s < target) continue;
    if (a.s >= target) return Math.max(timeS, a.t);
    return Math.max(timeS, a.t + (b.t - a.t) * (target - a.s) / Math.max(1e-9, b.s - a.s));
  }
  return null;
}

/**
 * When an invocation started at `startS` stops. `exact` means that time is known; otherwise it is the latest
 * assumed stop, and the command may finish any time after it starts. A loop restarts its command until its
 * limit and then lets the last run finish: with a run time that finish is known; without one, the load ends at
 * the limit. Without a run time or limit, the command is assumed to run to the end of the path.
 */
function invocationSpan(runTimeS: number | undefined, invocation: CommandInvocation, startS: number, samples: readonly TrajectorySample[], pathEndS: number) {
  const until = invocation.loop?.until;
  let limitS: number | null = null;
  if (until?.kind === "time") limitS = startS + until.seconds;
  else if (until?.kind === "distance") limitS = timeAfterDistance(samples, startS, until.meters);
  else if (until?.kind === "pathEnd") limitS = Math.max(startS, pathEndS);
  let endS = pathEndS, exact = false;
  if (!until && runTimeS !== undefined) { endS = startS + runTimeS; exact = true; }
  else if (until && limitS !== null) {
    // Runs start at startS + k·runTime while before the limit; the last one finishes. A time limit is counted from
    // its own seconds, so the run count does not drift with the start through floating-point rounding.
    if (runTimeS !== undefined) {
      const spanS = until.kind === "time" ? until.seconds : limitS - startS;
      endS = startS + Math.max(1, Math.ceil(spanS / runTimeS - 1e-9)) * runTimeS; exact = true;
    }
    else endS = limitS;
  }
  // A known finish past the path end becomes the path end; an unknown one stays unknown, as it may come sooner.
  if (invocation.cancelOnPathEnd) endS = Math.min(endS, pathEndS);
  return { endS: Math.max(startS, endS), exact, limitS, runTimeS };
}

/**
 * Bounds on when an invocation stops for any start in [earliestS, latestS]. Stops are not monotonic in the start
 * (a loop's last run can end anywhere up to one run time past its limit), so the bounds hold over the whole
 * range: every run lasts at least its run time, and a loop's last run ends within one run time of its limit.
 */
function invocationRange(runTimeS: number | undefined, invocation: CommandInvocation, earliestS: number, latestS: number,
  samples: readonly TrajectorySample[], pathEndS: number) {
  const first = invocationSpan(runTimeS, invocation, earliestS, samples, pathEndS);
  if (latestS === earliestS) return { earliestEndS: first.endS, latestEndS: first.endS, exact: first.exact };
  const last = invocationSpan(runTimeS, invocation, latestS, samples, pathEndS);
  const exact = first.exact && last.exact;
  const cap = (time: number) => invocation.cancelOnPathEnd ? Math.min(time, pathEndS) : time;
  let latestEndS = Math.max(first.endS, last.endS);
  // A distance the latest start never reaches is reached by earlier starts no later than the path end.
  if (invocation.loop && last.runTimeS !== undefined) latestEndS = Math.max(latestEndS, cap((last.limitS ?? pathEndS) + last.runTimeS));
  // A plain run or a time loop lasts the same however late it starts, so its earliest finish is the earliest start's.
  // A distance or path-end loop's last run cannot end before its limit, which only moves later with the start.
  const fixedLength = !invocation.loop || invocation.loop.until.kind === "time";
  const earliestEndS = !exact || first.runTimeS === undefined ? earliestS
    : fixedLength ? first.endS : cap(Math.max(earliestS + first.runTimeS, first.limitS ?? earliestS));
  return { earliestEndS, latestEndS, exact };
}

/**
 * Per command, overlapping windows with the same current become one. Windows of one command with different currents
 * stay apart; `commandLoadCurrent` takes the larger while they overlap.
 */
function coalesce(windows: CommandLoadWindow[]): CommandLoadWindow[] {
  const merged: CommandLoadWindow[] = [];
  windows.sort((x, y) => x.commandId.localeCompare(y.commandId) || x.startTimeS - y.startTimeS);
  for (const window of windows) {
    const last = merged[merged.length - 1];
    if (last && last.commandId === window.commandId && last.currentA === window.currentA && window.startTimeS <= last.endTimeS) last.endTimeS = Math.max(last.endTimeS, window.endTimeS);
    else merged.push({ ...window });
  }
  return merged;
}

/**
 * Load windows for the commands one path's events start, on the path clock shifted by `offsetS`. Each use draws what
 * it plans with on `robot` (see commandUseEstimate). Event times come from the planned trajectory. A sequential group
 * starts each command when the previous one finishes. When a finish is not known exactly, the next command may start
 * any time from the earliest to the latest possible finish, and its window covers that whole range; this can overstate
 * the load, never miss it.
 */
export function commandLoadWindows(
  robot: EstimateRobot,
  path: { markers?: readonly Marker[] },
  trajectory: { samples: readonly TrajectorySample[]; markers?: readonly { id?: string; timeS: number }[] },
  offsetS = 0,
): CommandLoadWindow[] {
  const model = robot.driveModel, samples = trajectory.samples, markers = path.markers ?? [];
  if ((robot.id === undefined && !model?.commandLoads?.length) || samples.length < 2 || !markers.length) return [];
  const pathEndS = samples[samples.length - 1].t;
  const timed = trajectory.markers ?? [];
  const windows: CommandLoadWindow[] = [];
  markers.forEach((marker, index) => {
    const timing = timed.length === markers.length ? timed[index] : timed.find((item) => item.id !== undefined && item.id === marker.id);
    const firstS = timing?.timeS;
    if (firstS === undefined || !Number.isFinite(firstS)) return;
    // Expiry allows 1e-9 s, and an occurrence due exactly at it still runs (docs/labview/binary-format.md).
    const expiresS = Math.min(pathEndS, marker.schedule?.endTimeS ?? Infinity) + 1e-9;
    if (firstS > expiresS) return;
    // Each event start is a range [earliest, latest]; past the repeat budget, one range covers every later start.
    const periodS = marker.schedule?.repeatEveryS;
    const starts: [number, number][] = [[firstS, firstS]];
    if (periodS && periodS > 0) {
      const lastK = Math.max(0, Math.floor((expiresS - firstS) / periodS));
      for (let k = 1; k <= lastK; k++) {
        const startS = firstS + k * periodS;
        if (starts.length < MAX_REPEAT_STARTS) starts.push([startS, startS]);
        else { starts[starts.length - 1][1] = firstS + lastK * periodS; break; }
      }
    }
    const sequential = marker.commandGroup?.mode === "sequential";
    for (const [eventEarliestS, eventLatestS] of starts) {
      let earliestS = eventEarliestS, latestS = eventLatestS;
      for (const invocation of markerInvocations(marker)) {
        const load = planningEstimate(invocation, robot);
        const range = invocationRange(load?.runTimeS, invocation, earliestS, latestS, samples, pathEndS);
        if (load && load.currentA > 0 && range.latestEndS > earliestS) {
          windows.push({ commandId: invocation.commandId, startTimeS: earliestS + offsetS, endTimeS: range.latestEndS + offsetS, currentA: load.currentA });
        }
        if (!sequential) continue;
        // An inexact finish may come as soon as the command starts.
        if (range.exact) earliestS = range.earliestEndS;
        latestS = range.latestEndS;
      }
    }
  });
  return coalesce(windows);
}

/** A routine command step as a timed preview placed it: its start, its preview end, and its step time limit. */
export interface RoutineCommandStepTiming { t0: number; t1: number; invocation: CommandInvocation; timeoutS?: number }

/**
 * How long a routine step's command runs with run time `runTimeS`: one run, or for a time loop the runs started
 * before its limit, the last one finishing. Undefined without a run time, or for a loop that stops on anything else.
 */
function estimatedRunS(runTimeS: number | undefined, invocation: CommandInvocation): number | undefined {
  if (runTimeS === undefined) return undefined;
  const until = invocation.loop?.until;
  if (!until) return runTimeS;
  return until.kind === "time" ? Math.max(1, Math.ceil(until.seconds / runTimeS - 1e-9)) * runTimeS : undefined;
}

/** Whether a Runs for would make a routine step with this command exactly timed: it is not a loop, or a time loop. */
export function routineStepTimedByRunTime(invocation: CommandInvocation): boolean {
  const until = invocation.loop?.until;
  return !until || until.kind === "time";
}

/**
 * How long a routine command step lasts on `robot` when its estimate makes that exact: its run (see estimatedRunS),
 * cut short by the step's time limit. Undefined when it is not known. The routine Power report counts this as the
 * step's duration, so it matches the step's window in routineCommandWindows; preview timing elsewhere does not use it.
 */
export function routineCommandStepRunS(robot: EstimateRobot, step: { invocation: CommandInvocation; timeoutS?: number }): number | undefined {
  const runS = estimatedRunS(planningEstimate(step.invocation, robot)?.runTimeS, step.invocation);
  if (runS === undefined) return undefined;
  return step.timeoutS !== undefined && Number.isFinite(step.timeoutS) ? Math.min(runS, Math.max(0, step.timeoutS)) : runS;
}

/**
 * Load windows for routine command steps on the routine clock. A step runs its estimate's run time (a time loop
 * restarts it until the limit and lets the last run finish), else until the preview's end of the step, else to
 * `totalTimeS`; a step time limit stops it sooner.
 */
export function routineCommandWindows(robot: EstimateRobot, steps: readonly RoutineCommandStepTiming[], totalTimeS: number): CommandLoadWindow[] {
  const windows: CommandLoadWindow[] = [];
  for (const step of steps) {
    const load = planningEstimate(step.invocation, robot);
    if (!load || !(load.currentA > 0) || !Number.isFinite(step.t0)) continue;
    const until = step.invocation.loop?.until, runS = estimatedRunS(load.runTimeS, step.invocation);
    let endS: number;
    if (runS !== undefined) endS = step.t0 + runS;
    else if (until?.kind === "time") endS = step.t0 + until.seconds;
    else endS = step.t1 > step.t0 ? step.t1 : Math.max(step.t0, totalTimeS);
    if (step.timeoutS !== undefined && Number.isFinite(step.timeoutS)) endS = Math.min(endS, step.t0 + step.timeoutS);
    if (endS > step.t0) windows.push({ commandId: step.invocation.commandId, startTimeS: step.t0, endTimeS: endS, currentA: load.currentA });
  }
  return coalesce(windows);
}

/** Uses among routine command steps with and without an estimate for `robot`. */
export function routineCommandCoverage(robot: EstimateRobot, steps: readonly { invocation: CommandInvocation }[]): CommandEstimateCoverage {
  const coverage = { uses: 0, estimated: 0, stale: 0 };
  for (const step of steps) countUse(coverage, commandUseEstimate(step.invocation, robot));
  return coverage;
}

/**
 * Current from command windows at one instant. A command restarted while running draws its current once: the
 * largest of its windows active then, since one command cannot run twice at once.
 */
export function commandLoadCurrent(windows: readonly CommandLoadWindow[], timeS: number): number {
  const active = new Map<string, number>();
  for (const window of windows) {
    if (timeS >= window.startTimeS && timeS < window.endTimeS) active.set(window.commandId, Math.max(active.get(window.commandId) ?? 0, window.currentA));
  }
  let total = 0;
  for (const current of active.values()) total += current;
  return total;
}
