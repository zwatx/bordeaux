import { randomUuid } from "../randomUuid";
import type { RobotFileEndpoint } from "../robotFileDelivery";
import { newRobot } from "./defaults";
import type { BordeauxProject, ProjectRobot, RobotConfig } from "../types";

/** Longest robot name the editor accepts. */
export const ROBOT_NAME_MAX = 80;
/** Most robots a project holds. Adding or duplicating past it leaves the project as it is. */
export const ROBOT_LIMIT = 32;
const DEFAULT_NAME = "Robot";
/** The original robot keeps this identity when it first becomes a named entry. */
export const UNLISTED_ROBOT_ID = "robot";

export interface RobotSummary { id: string; name: string; selected: boolean; robot: RobotConfig; connection?: RobotFileEndpoint }

/*
 * A project's robots. `project.robot` is always the selected robot's details, which planning, export and Push read.
 * `project.robots` names every robot in card order and keeps the details of the ones that are not selected. A project
 * saved before robots had names has no list: it is one robot called "Robot". Every function returns a new project, or
 * the same one when there is nothing to do.
 */

/** The stored list, or the single unnamed robot of an older project. */
function entries(project: BordeauxProject): { robots: ProjectRobot[]; activeRobotId: string } {
  if (project.robots?.length && project.activeRobotId) return { robots: project.robots, activeRobotId: project.activeRobotId };
  return { robots: [{ id: UNLISTED_ROBOT_ID, name: DEFAULT_NAME }], activeRobotId: UNLISTED_ROBOT_ID };
}

/** Every robot in card order with its details, for display. */
export function projectRobots(project: BordeauxProject): RobotSummary[] {
  if (!project.robots?.length || !project.activeRobotId) return [{ id: UNLISTED_ROBOT_ID, name: DEFAULT_NAME, selected: true, robot: project.robot }];
  return project.robots.map(({ id, name, robot, connection }) => ({ id, name, selected: id === project.activeRobotId,
    robot: id === project.activeRobotId ? project.robot : robot!, ...(connection ? { connection } : {}) }));
}

function uniqueName(robots: readonly ProjectRobot[], wanted: string): string {
  const base = wanted.trim().slice(0, ROBOT_NAME_MAX) || DEFAULT_NAME;
  const used = new Set(robots.map((robot) => robot.name.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  // The number takes its room from the end of a long name, so the result stays within the limit.
  for (let suffix = 2; ; suffix++) {
    const name = `${base.slice(0, ROBOT_NAME_MAX - ` ${suffix}`.length).trimEnd()} ${suffix}`;
    if (!used.has(name.toLowerCase())) return name;
  }
}

/**
 * Adds a robot and selects it. A taken name gets a number. It starts as `newRobot()` with no connection, or
 * from `copyOf`: Duplicate copies a robot's details and address, which stay separate from the original afterwards.
 */
export function addRobot(project: BordeauxProject, name: string, copyOf?: { robot: RobotConfig; connection?: RobotFileEndpoint }): BordeauxProject {
  const { robots, activeRobotId } = entries(project);
  if (robots.length >= ROBOT_LIMIT) return project;
  const id = `robot_${randomUuid()}`;
  const connection = copyOf?.connection;
  return {
    ...project,
    robot: copyOf ? structuredClone(copyOf.robot) : newRobot(),
    robots: [...robots.map((robot) => robot.id === activeRobotId ? { ...robot, robot: project.robot } : robot),
      { id, name: uniqueName(robots, name), ...(connection ? { connection: { ...connection } } : {}) }],
    activeRobotId: id,
  };
}

/** Adds a copy of any robot, details and address included, named like it with a number, and selects the copy. */
export function duplicateRobot(project: BordeauxProject, id: string): BordeauxProject {
  const source = projectRobots(project).find((robot) => robot.id === id);
  return source ? addRobot(project, source.name, source) : project;
}

// This computer stores a push folder without its trailing slash, so the two spellings are one folder.
const folder = (directory: string) => directory.replace(/\/+$/, "") || "/";
const sameEndpoint = (a: RobotFileEndpoint | undefined, b: RobotFileEndpoint) =>
  a?.target === b.target && a.host === b.host && a.port === b.port && folder(a.directory) === folder(b.directory);

/**
 * Why Push must not use `active`, this computer's current robot connection, for the selected robot, or null when it
 * may. A listed robot pushes only through its own address, so a switch that failed cannot send its files to the robot
 * selected before. A project without a list uses whatever connection this computer has.
 */
export function pushConnectionProblem(project: BordeauxProject, active: RobotFileEndpoint | null, action = "pushing"): string | null {
  if (!project.robots?.length) return null;
  const selected = project.robots.find((robot) => robot.id === project.activeRobotId);
  if (!selected?.connection) return `Set up ${selected?.name ?? "this robot"}’s connection before ${action}.`;
  return active && sameEndpoint(selected.connection, active) ? null
    : `${selected.name}’s connection is not the active one. Open its connection on the Robot page and save it again.`;
}

/** Sets where Push sends the selected robot's files. An older project gets its robot list here. */
export function setRobotConnection(project: BordeauxProject, endpoint: RobotFileEndpoint): BordeauxProject {
  const { robots, activeRobotId } = entries(project);
  const connection = { target: endpoint.target, host: endpoint.host, port: endpoint.port, directory: endpoint.directory };
  if (project.robots && sameEndpoint(robots.find((robot) => robot.id === activeRobotId)?.connection, connection)) return project;
  return { ...project, robots: robots.map((robot) => robot.id === activeRobotId ? { ...robot, connection } : robot), activeRobotId };
}

/** Selects another robot: the one being left keeps its details in the list, and the chosen one's become `project.robot`. */
export function selectRobot(project: BordeauxProject, id: string): BordeauxProject {
  const { robots, activeRobotId } = entries(project);
  const chosen = robots.find((robot) => robot.id === id);
  if (!chosen?.robot || id === activeRobotId) return project;
  return {
    ...project,
    robot: chosen.robot,
    robots: robots.map(({ robot: details, ...robot }) => robot.id === id ? robot
      : robot.id === activeRobotId ? { ...robot, robot: project.robot } : { ...robot, robot: details }),
    activeRobotId: id,
  };
}

/** Renames a robot. An empty, too long or taken name (ignoring case) leaves the project as it is. */
export function renameRobot(project: BordeauxProject, id: string, name: string): BordeauxProject {
  const { robots, activeRobotId } = entries(project);
  const next = name.trim();
  // An older project's robot has no stored id yet, so its only robot is the one being renamed.
  const target = project.robots ? robots.find((robot) => robot.id === id) : robots[0];
  if (!target || !next || next.length > ROBOT_NAME_MAX || next === target.name) return project;
  if (robots.some((robot) => robot !== target && robot.name.toLowerCase() === next.toLowerCase())) return project;
  return { ...project, robots: robots.map((robot) => robot === target ? { ...robot, name: next } : robot), activeRobotId };
}

/** Removes a robot. The last robot stays. Removing the selected robot selects the first one left. */
export function removeRobot(project: BordeauxProject, id: string): BordeauxProject {
  if (!project.robots || project.robots.length < 2 || !project.robots.some((robot) => robot.id === id)) return project;
  const base = id === project.activeRobotId ? selectRobot(project, project.robots.find((robot) => robot.id !== id)!.id) : project;
  return { ...base, robots: base.robots!.filter((robot) => robot.id !== id) };
}
