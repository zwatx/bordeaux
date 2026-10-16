import { createDemoProject } from "../../shared/project/defaults";
import { createRoutineId } from "../../shared/project/ids";
import type { AutonomousRoutine, BordeauxProject } from "../../shared/types";
import { UnitPrefs } from "./unitPreferences";

export function freshProject(): BordeauxProject {
  const project = createDemoProject();
  return { ...project, editor: { ...project.editor, unitSystem: UnitPrefs.current() } };
}

/**
 * The protected empty document for every non-opened startup: the usual robot, routine and field defaults with one
 * path that has no waypoints yet, so the first click draws. The shared demo/template fixtures are unchanged.
 */
export function blankProject(): BordeauxProject {
  const project = freshProject();
  return { ...project, paths: project.paths.slice(0, 1).map((path) => ({ ...path, waypoints: [], markers: [], ranges: [], targets: [] })) };
}

export function blankRoutine(name = "Autonomous Routine"): AutonomousRoutine {
  return { id: createRoutineId(), name, nodes: [] };
}

export type RoutineState = Pick<BordeauxProject, "routines" | "activeRoutineId">;

export function routineState(project: RoutineState): RoutineState {
  const routines = Array.isArray(project.routines) && project.routines.length ? project.routines : [blankRoutine()];
  const activeRoutineId = routines.some((routine) => routine.id === project.activeRoutineId) ? project.activeRoutineId : routines[0].id;
  return { routines, activeRoutineId };
}

export function withRoutineState(project: BordeauxProject, state: RoutineState): BordeauxProject {
  const activeRoutine = state.routines.find((routine) => routine.id === state.activeRoutineId) || state.routines[0];
  return { ...project, routines: state.routines, activeRoutineId: activeRoutine.id };
}

export function uniqueItemName(items: readonly { name: string }[], base: string): string {
  const used = new Set(items.map((item) => item.name.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  let suffix = 2;
  while (used.has((base + " " + suffix).toLowerCase())) suffix++;
  return base + " " + suffix;
}
