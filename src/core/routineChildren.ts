import type { RoutineNode } from './types';

export type RoutineListRef =
  | { kind: 'root' }
  | { kind: 'decision'; nodeId: string; route: 'then' | 'else' }
  | { kind: 'output'; nodeId: string; routeId: string }
  | { kind: 'repeat'; nodeId: string }
  | { kind: 'group'; nodeId: string }
  | { kind: 'fallback'; nodeId: string };

export interface RoutineChildList { ref: RoutineListRef; nodes: RoutineNode[]; label: string; readOnly?: boolean }
/** Known child topology; raw source shapes must be validated separately. */
export function routineChildLists(node: RoutineNode): RoutineChildList[] {
  if (!node || typeof node !== 'object') return [];
  if (node.type === 'repeat') return [{ ref: { kind: 'repeat', nodeId: node.id }, nodes: node.nodes || [], label: 'Repeat' }];
  if (node.type === 'group') return [{ ref: { kind: 'group', nodeId: node.id }, nodes: node.nodes || [], label: node.mode === 'sequential' ? 'Sequential group' : 'Parallel group' }];
  if (node.type === 'decision') return [
    { ref: { kind: 'decision', nodeId: node.id, route: 'then' }, nodes: node.then || [], label: node.thenLabel || 'True' },
    { ref: { kind: 'decision', nodeId: node.id, route: 'else' }, nodes: node.else || [], label: node.elseLabel || 'False' },
  ];
  if (node.type === 'generatedTrajectory' && node.fallback?.type === 'branch') return [
    { ref: { kind: 'fallback', nodeId: node.id }, nodes: node.fallback.nodes, label: 'Fallback', readOnly: true },
  ];
  return node.type === 'function' ? (node.outputBranch?.routes || []).map(route => ({
    ref: { kind: 'output', nodeId: node.id, routeId: route.id } as RoutineListRef, nodes: route.nodes, label: route.label,
  })) : [];
}

/** What a group may hold, in words. Shown in the group inspector and for steps no specific message covers. */
export const ROUTINE_GROUP_CHILD_RULE = 'A group holds commands, waits and other groups. Paths, repeats and commands that branch stay outside it.';

/**
 * Why `node` cannot sit directly inside a group, or null. Groups never branch, follow paths or change control flow:
 * their children are command steps without output branches, waits, and nested groups.
 */
export function routineGroupChildError(node: unknown): string | null {
  if (!node || typeof node !== 'object') return ROUTINE_GROUP_CHILD_RULE;
  const value = node as { type?: unknown; cat?: unknown; builtinId?: unknown; outputBranch?: unknown };
  if (value.type === 'group') return null;
  if (value.type === 'builtin' && value.builtinId === 'bordeaux.wait') return null;
  if (value.type === 'function' && value.cat === 'command') {
    return value.outputBranch === undefined ? null : 'A command in a group cannot branch on its output.';
  }
  if (value.type === 'path') return "Paths cannot run inside a group. To run commands while driving, add them to the path's Commands lane in Paths.";
  if (value.type === 'repeat') return 'Repeats cannot go inside a group.';
  if (value.type === 'end') return 'End routine and Exit repeat cannot go inside a group.';
  return ROUTINE_GROUP_CHILD_RULE;
}
