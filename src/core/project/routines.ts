import type { AutonomousRoutine, BordeauxProject } from "../types";

export function activeRoutine(project: BordeauxProject): AutonomousRoutine | undefined {
  return project.routines.find((routine) => routine.id === project.activeRoutineId) ?? project.routines[0];
}
