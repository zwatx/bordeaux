import {
  COMMAND_CURRENT_MAX_A, COMMAND_POWER_ROBOTS_MAX, COMMAND_RUN_TIME_MAX_S, COMMAND_RUN_TIME_MIN_S,
  commandInputKey, commandLoadFor, commandUseEstimate, storedCommandEstimate, type ResolvedCommandEstimate,
} from "../commandLoads";
import type { BordeauxProject, CommandArgumentValue, CommandInvocation, CommandLoad, CommandPowerEstimate, PathDoc, RobotConfig } from "../types";
import { forEachCommandUse, mapCommandUses, mapPathCommandUses, sameCommandUseLocation, type CommandUseLocation } from "./invocations";
import { UNLISTED_ROBOT_ID, asSelectedRobot, projectRobots, selectedRobotId } from "./robots";

export type { CommandUseLocation } from "./invocations";

/*
 * Per-use command power estimates across a project, for the Robot page. Every function is pure and returns a new
 * project, or the same one when there is nothing to do. `robotId` is a project robot id (`projectRobots(project)`);
 * an unknown id changes nothing. Robot actions (duplicate, remove) never change estimates on uses: a duplicate shares
 * its original's through `RobotConfig.estimatesFrom`, and a removed robot's stay for the robots that share them.
 */

/** One use of a command and what it draws on one robot. */
export interface CommandUse {
  location: CommandUseLocation;
  commandId: string;
  arguments: Record<string, CommandArgumentValue>;
  /** The use's own estimate for the robot, as stored. Absent when it plans with an inherited or legacy one. */
  stored?: CommandPowerEstimate;
  /**
   * What planning uses on the robot: the use's own estimate (`source: "use"`), the one it shares from robot
   * `fromRobotId` (`source: "inherited"`), or the robot's legacy load for the command (`source: "legacy"`). `stale`
   * marks a stored estimate entered before the command or its arguments changed. Undefined: the use adds no current.
   */
  estimate?: ResolvedCommandEstimate;
}

/** A use's current and run time as the user enters them. */
export interface CommandPowerInput { currentA: number; runTimeS?: number }

function robotDetails(project: BordeauxProject, robotId: string): RobotConfig | undefined {
  return projectRobots(project).find((robot) => robot.id === robotId)?.robot;
}

/** `robotId`'s details carrying that id, as estimates resolve on it; undefined for an unknown robot. */
function estimateRobot(project: BordeauxProject, robotId: string): RobotConfig | undefined {
  const details = robotDetails(project, robotId);
  return details && asSelectedRobot(details, robotId);
}

/** Writing the selected robot's estimates also makes sure `project.robot` carries the id planning reads them by. */
function keepSelectedId(project: BordeauxProject, robotId: string): BordeauxProject {
  const selected = selectedRobotId(project);
  if (robotId !== selected) return project;
  const robot = asSelectedRobot(project.robot, selected);
  return robot === project.robot ? project : { ...project, robot };
}

function validInput(input: CommandPowerInput): boolean {
  return Number.isFinite(input.currentA) && input.currentA >= 0 && input.currentA <= COMMAND_CURRENT_MAX_A
    && (input.runTimeS === undefined || (Number.isFinite(input.runTimeS) && input.runTimeS >= COMMAND_RUN_TIME_MIN_S && input.runTimeS <= COMMAND_RUN_TIME_MAX_S));
}

/**
 * Why `robotId` can't get a new estimate on this use, or null when it can: the use already holds estimates for
 * COMMAND_POWER_ROBOTS_MAX robots, which validation allows at most. An estimate the robot already has can always change.
 */
export function commandEstimateCapProblem(invocation: CommandInvocation, robotId: string): string | null {
  const power = invocation.power ?? {};
  return Object.prototype.hasOwnProperty.call(power, robotId) || Object.keys(power).length < COMMAND_POWER_ROBOTS_MAX ? null
    : `This command use already holds estimates for ${COMMAND_POWER_ROBOTS_MAX} robots, the most one use can hold, so it can’t take one for this robot.`;
}

/**
 * The one way an estimate is written onto a use (the inspector's Add and Copy, setCommandUseEstimate,
 * copyCommandUseEstimate and migrateLegacyCommandLoads): `estimate` stored for `robotId`, or the same use when
 * commandEstimateCapProblem refuses it.
 */
export function storeCommandEstimate(invocation: CommandInvocation, robotId: string, estimate: CommandPowerEstimate): CommandInvocation {
  if (commandEstimateCapProblem(invocation, robotId)) return invocation;
  return { ...invocation, power: { ...(invocation.power ?? {}), [robotId]: estimate } };
}

function withEstimate(invocation: CommandInvocation, robotId: string, input: CommandPowerInput): CommandInvocation {
  return storeCommandEstimate(invocation, robotId, { currentA: input.currentA, ...(input.runTimeS !== undefined ? { runTimeS: input.runTimeS } : {}), inputKey: commandInputKey(invocation) });
}

function withoutEstimate(invocation: CommandInvocation, robotId: string): CommandInvocation {
  if (!invocation.power || !Object.prototype.hasOwnProperty.call(invocation.power, robotId)) return invocation;
  const { [robotId]: _removed, ...rest } = invocation.power;
  const { power: _power, ...bare } = invocation;
  return Object.keys(rest).length ? { ...invocation, power: rest } : bare;
}

/** Every command use in the project with what it draws on `robotId` (the selected robot by default). */
export function listCommandUses(project: BordeauxProject, robotId = selectedRobotId(project)): CommandUse[] {
  const robot = estimateRobot(project, robotId) ?? { id: robotId };
  const uses: CommandUse[] = [];
  forEachCommandUse(project, (invocation, location) => {
    const stored = storedCommandEstimate(invocation, robotId);
    const estimate = commandUseEstimate(invocation, robot);
    uses.push({ location, commandId: invocation.commandId, arguments: invocation.arguments,
      ...(stored ? { stored } : {}), ...(estimate ? { estimate } : {}) });
  });
  return uses;
}

/**
 * Stores `input` as the estimate of the use at `location` on `robotId`, against the use's current command and
 * arguments (so it is not stale). It overrides, for this robot and use only, an estimate the robot shares; robots that
 * share `robotId`'s estimates see it on this use unless they have their own. Out-of-range input (current 0–500 A, run
 * time 0.01–3600 s) changes nothing.
 */
export function setCommandUseEstimate(project: BordeauxProject, location: CommandUseLocation, robotId: string, input: CommandPowerInput): BordeauxProject {
  if (!robotDetails(project, robotId) || !validInput(input)) return project;
  const next = mapCommandUses(project, (invocation, at) => sameCommandUseLocation(at, location) ? withEstimate(invocation, robotId, input) : invocation);
  return next === project ? project : keepSelectedId(next, robotId);
}

/**
 * Removes `robotId`'s own estimate of the use at `location`. The use then shares an estimate through
 * `estimatesFrom`, or falls back to a legacy load, if any.
 */
export function removeCommandUseEstimate(project: BordeauxProject, location: CommandUseLocation, robotId: string): BordeauxProject {
  return mapCommandUses(project, (invocation, at) => sameCommandUseLocation(at, location) ? withoutEstimate(invocation, robotId) : invocation);
}

/**
 * Copies what the use at `from` draws on `robotId` (its own estimate, a shared one, or the legacy load it falls back
 * to) onto each use in `to` as `robotId`'s own, entered against each target's own command and arguments. Nothing to
 * copy changes nothing.
 */
export function copyCommandUseEstimate(project: BordeauxProject, from: CommandUseLocation, to: CommandUseLocation | readonly CommandUseLocation[], robotId: string): BordeauxProject {
  const source = listCommandUses(project, robotId).find((use) => sameCommandUseLocation(use.location, from))?.estimate;
  if (!source) return project;
  const targets = Array.isArray(to) ? to as readonly CommandUseLocation[] : [to as CommandUseLocation];
  const input = { currentA: source.currentA, ...(source.runTimeS !== undefined ? { runTimeS: source.runTimeS } : {}) };
  if (!robotDetails(project, robotId) || !validInput(input)) return project;
  const next = mapCommandUses(project, (invocation, at) => targets.some((target) => sameCommandUseLocation(at, target)) ? withEstimate(invocation, robotId, input) : invocation);
  return next === project ? project : keepSelectedId(next, robotId);
}

/** Legacy loads on `robotId` whose command no use in the project starts. Removing the table drops them with the rest. */
export function unusedLegacyCommandLoads(project: BordeauxProject, robotId = selectedRobotId(project)): CommandLoad[] {
  const loads = robotDetails(project, robotId)?.driveModel?.commandLoads ?? [];
  const used = new Set<string>();
  forEachCommandUse(project, (invocation) => { used.add(invocation.commandId); });
  return loads.filter((load) => !used.has(load.commandId));
}

/** Whether `migrateLegacyCommandLoads` can copy `robotId`'s legacy loads: it has some, all within an estimate's range. */
export function legacyCommandLoadsMigratable(project: BordeauxProject, robotId = selectedRobotId(project)): boolean {
  const loads = robotDetails(project, robotId)?.driveModel?.commandLoads;
  return !!loads && loads.every(validInput);
}

/**
 * One explicit change: every use that falls back to a legacy load on `robotId` gets that load as its own estimate.
 * A use with its own estimate, or one it shares through `estimatesFrom`, keeps planning with it. The legacy table
 * stays on the robot, so planning is the same and an Undo that restores a path from before the copy still finds the
 * loads it fell back to; for the same reason the editor offers no way to remove the table. A robot without legacy
 * loads, with one outside an estimate's range (`legacyCommandLoadsMigratable`), or with no use left to copy onto,
 * changes nothing.
 */
export function migrateLegacyCommandLoads(project: BordeauxProject, robotId = selectedRobotId(project)): BordeauxProject {
  const robot = estimateRobot(project, robotId);
  const model = robot?.driveModel;
  if (!robot || !model?.commandLoads) return project;
  // A legacy load outside a use estimate's range could not be copied without changing planning; copy none.
  if (!model.commandLoads.every(validInput)) return project;
  const next = mapCommandUses(project, (invocation) => {
    if (commandUseEstimate(invocation, robot)?.source !== "legacy") return invocation;
    const load = commandLoadFor(model, invocation.commandId);
    return load ? withEstimate(invocation, robotId, load) : invocation;
  });
  return next === project ? project : keepSelectedId(next, robotId);
}

/**
 * `path` as a document read on its own (a standalone `.path`) stores it. Such a document opens as a project with one
 * robot, UNLISTED_ROBOT_ID, so the ids that key estimates here mean nothing there, and the original robot of a project
 * even keeps that id: its estimates would plan for whichever robot saved the path. Each use therefore keeps only the
 * estimate `robot` (the saving robot) plans with, its own or one it inherits, stored for UNLISTED_ROBOT_ID, with its
 * input key, so the opened path plans and flags stale estimates as it did here. A use planning with a legacy load or
 * nothing keeps no estimate; the robot's legacy table travels with the document's robot.
 */
export function standalonePathEstimates(path: PathDoc, robot: Pick<RobotConfig, "id" | "estimatesFrom" | "driveModel">): PathDoc {
  return mapPathCommandUses(path, (invocation) => {
    if (invocation.power === undefined) return invocation;
    const { power: _power, ...bare } = invocation;
    const resolved = commandUseEstimate(invocation, robot);
    const from = resolved?.source === "use" ? robot.id : resolved?.source === "inherited" ? resolved.fromRobotId : undefined;
    const estimate = from === undefined ? undefined : storedCommandEstimate(invocation, from);
    return estimate ? { ...bare, power: { [UNLISTED_ROBOT_ID]: estimate } } : bare;
  });
}
