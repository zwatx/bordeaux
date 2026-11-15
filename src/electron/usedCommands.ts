import type { BordeauxProject, RoutineNode } from "../shared/types";
import { routineChildLists } from "../shared/routineChildren";
import { routineCommandIds } from "./routineSelection";
import { markerInvocations } from "../shared/markerCommands";

/**
 * Command IDs an export actually writes: the markers on the selected paths, or a routine's command steps plus the
 * markers on the paths it follows. Only these commands' VIs are checked against LabVIEW.
 */
export function projectCommandIds(project: BordeauxProject, selection: { pathIds?: string[]; routineId?: string }): Set<string> {
  const ids = new Set<string>(), pathIds = new Set(selection.pathIds ?? []);
  if (selection.routineId !== undefined) {
    for (const id of routineCommandIds(project, selection.routineId)) ids.add(id);
    const pending: RoutineNode[][] = [project.routines.find(item => item.id === selection.routineId)?.nodes ?? []];
    let count = 0;
    while (pending.length) {
      for (const node of pending.pop()!) {
        if (++count > 4096) throw new Error("Invalid routine node or budget");
        if (node.type === "path" && typeof node.ref === "string") pathIds.add(node.ref);
        for (const list of routineChildLists(node)) pending.push(list.nodes);
      }
    }
  }
  for (const path of project.paths ?? []) {
    if (!pathIds.has(path.id)) continue;
    for (const marker of path.markers ?? []) for (const invocation of markerInvocations(marker)) if (invocation.commandId) ids.add(invocation.commandId);
  }
  return ids;
}
