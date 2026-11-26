import type { CommandInvocation, CommandLoad, Marker, RobotConfig, TrajectorySample } from "./types";
import { markerInvocations } from "./markerCommands";

type DriveModel = NonNullable<RobotConfig["driveModel"]>;

export const MAX_COMMAND_LOADS = 128;
/** Repeats past this many starts are treated as one continuous range of starts, which can only overstate the load. */
const MAX_REPEAT_STARTS = 1000;

/** When one command's current flows, in seconds on the analyzed path or routine clock. */
export interface CommandLoadWindow { commandId: string; startTimeS: number; endTimeS: number; currentA: number }

export function commandLoadFor(model: DriveModel | undefined, commandId: string): CommandLoad | undefined {
  return model?.commandLoads?.find((load) => load.commandId === commandId);
}

function startedCommandIds(markers: readonly Marker[] | undefined): Set<string> {
  const ids = new Set<string>();
  for (const marker of markers ?? []) for (const invocation of markerInvocations(marker)) ids.add(invocation.commandId);
  return ids;
}

/**
 * Current path timing reserves for the commands a path's events start. Each command counts once, at its full
 * current, for the whole path: command timing on the robot can differ from the local preview, and a reserve
 * that assumed the preview's overlaps could be invalidated by it.
 */
export function pathCommandReserveA(model: DriveModel | undefined, markers: readonly Marker[] | undefined): number {
  if (!model?.commandLoads?.length) return 0;
  let total = 0;
  for (const id of startedCommandIds(markers)) total += commandLoadFor(model, id)?.currentA ?? 0;
  return total;
}

/**
 * The robot as planning sees one path: the path's command reserve folded into Other mechanisms. Applying it
 * twice changes nothing, so planner stages that receive an already planned input stay consistent.
 */
export function planningRobotForPath(robot: RobotConfig, path: { markers?: readonly Marker[] }): RobotConfig {
  const model = robot.driveModel;
  if (!model?.commandLoads) return robot;
  const { commandLoads: _loads, ...rest } = model;
  const reserve = pathCommandReserveA(model, path.markers);
  return { ...robot, driveModel: { ...rest, ...(reserve > 0 || model.otherLoadA !== undefined ? { otherLoadA: (model.otherLoadA ?? 0) + reserve } : {}) } };
}

/** Commands a path starts that have no configured load; the estimate adds no current for them. */
export function commandsWithoutLoad(model: DriveModel | undefined, markers: readonly Marker[] | undefined): string[] {
  return [...startedCommandIds(markers)].filter((id) => !commandLoadFor(model, id)).sort();
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
function invocationSpan(model: DriveModel, invocation: CommandInvocation, startS: number, samples: readonly TrajectorySample[], pathEndS: number) {
  const until = invocation.loop?.until, runTimeS = commandLoadFor(model, invocation.commandId)?.runTimeS;
  let limitS: number | null = null;
  if (until?.kind === "time") limitS = startS + until.seconds;
  else if (until?.kind === "distance") limitS = timeAfterDistance(samples, startS, until.meters);
  else if (until?.kind === "pathEnd") limitS = Math.max(startS, pathEndS);
  let endS = pathEndS, exact = false;
  if (!until && runTimeS !== undefined) { endS = startS + runTimeS; exact = true; }
  else if (until && limitS !== null) {
    // Runs start at startS + k·runTime while before the limit; the last one finishes.
    if (runTimeS !== undefined) { endS = startS + Math.max(1, Math.ceil((limitS - startS) / runTimeS - 1e-9)) * runTimeS; exact = true; }
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
function invocationRange(model: DriveModel, invocation: CommandInvocation, earliestS: number, latestS: number,
  samples: readonly TrajectorySample[], pathEndS: number) {
  const first = invocationSpan(model, invocation, earliestS, samples, pathEndS);
  if (latestS === earliestS) return { earliestEndS: first.endS, latestEndS: first.endS, exact: first.exact };
  const last = invocationSpan(model, invocation, latestS, samples, pathEndS);
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

/** Per command, overlapping windows become one: a command draws its current once however often it is started. */
function coalesce(windows: CommandLoadWindow[]): CommandLoadWindow[] {
  const merged: CommandLoadWindow[] = [];
  windows.sort((x, y) => x.commandId.localeCompare(y.commandId) || x.startTimeS - y.startTimeS);
  for (const window of windows) {
    const last = merged[merged.length - 1];
    if (last && last.commandId === window.commandId && window.startTimeS <= last.endTimeS) last.endTimeS = Math.max(last.endTimeS, window.endTimeS);
    else merged.push({ ...window });
  }
  return merged;
}

/**
 * Load windows for the commands one path's events start, on the path clock shifted by `offsetS`.
 * Event times come from the planned trajectory. A sequential group starts each command when the previous one
 * finishes. When a finish is not known exactly, the next command may start any time from the earliest to the
 * latest possible finish, and its window covers that whole range; this can overstate the load, never miss it.
 */
export function commandLoadWindows(
  robot: RobotConfig,
  path: { markers?: readonly Marker[] },
  trajectory: { samples: readonly TrajectorySample[]; markers?: readonly { id?: string; timeS: number }[] },
  offsetS = 0,
): CommandLoadWindow[] {
  const model = robot.driveModel, samples = trajectory.samples, markers = path.markers ?? [];
  if (!model?.commandLoads?.length || samples.length < 2 || !markers.length) return [];
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
        const range = invocationRange(model, invocation, earliestS, latestS, samples, pathEndS);
        const load = commandLoadFor(model, invocation.commandId);
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

/** Current from command windows at one instant. A command restarted while running draws its current once. */
export function commandLoadCurrent(windows: readonly CommandLoadWindow[], timeS: number): number {
  const active = new Map<string, number>();
  for (const window of windows) {
    if (timeS >= window.startTimeS && timeS < window.endTimeS) active.set(window.commandId, window.currentA);
  }
  let total = 0;
  for (const current of active.values()) total += current;
  return total;
}
