import type { BordeauxProject, RoutineNode } from '../core/types';
import { routineChildLists } from '../core/routineChildren';

/** Inspect only the bounded selected graph; Wait and eventless paths need no NI project. */
export function routineCommandIds(project: BordeauxProject, routineId: string): Set<string> {
  const ids = new Set<string>(), selected = project.routines.filter(item => item.id === routineId);
  if (selected.length !== 1) throw new Error('Selected routine is missing or ambiguous');
  const pending: Array<{ nodes: RoutineNode[]; depth: number }> = [{ nodes: selected[0].nodes, depth: 0 }]; let count = 0;
  while (pending.length) {
    const frame = pending.pop()!;
    if (!Array.isArray(frame.nodes) || frame.depth > 64) throw new Error('Invalid routine children or depth');
    for (const node of frame.nodes) {
      if (++count > 4096 || !node || typeof node !== 'object') throw new Error('Invalid routine node or budget');
      if (node.type === 'function' && node.cat === 'command' && node.invocation) ids.add(node.invocation.commandId);
      for (const list of routineChildLists(node)) pending.push({ nodes: list.nodes, depth: frame.depth + 1 });
    }
  }
  return ids;
}
