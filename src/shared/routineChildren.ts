import type { RoutineNode } from './types';

export type RoutineListRef =
  | { kind: 'root' }
  | { kind: 'decision'; nodeId: string; route: 'then' | 'else' }
  | { kind: 'output'; nodeId: string; routeId: string }
  | { kind: 'repeat'; nodeId: string }
  | { kind: 'fallback'; nodeId: string };

export interface RoutineChildList { ref: RoutineListRef; nodes: RoutineNode[]; label: string; readOnly?: boolean }
/** Known child topology; raw source shapes must be validated separately. */
export function routineChildLists(node: RoutineNode): RoutineChildList[] {
  if (!node || typeof node !== 'object') return [];
  if (node.type === 'repeat') return [{ ref: { kind: 'repeat', nodeId: node.id }, nodes: node.nodes || [], label: 'Repeat' }];
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
