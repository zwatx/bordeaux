import type { AutonomousRoutine, BordeauxProject, CommandInvocation, Marker, PathDoc, RoutineFallbackNode, RoutineNode } from "../types";

/**
 * Where one use of a command sits in a project. A path event names its marker by id when it has one (the index
 * otherwise) and, in a command group, the member's index. A routine step names its node, whose id is unique in its
 * routine; `readOnly` marks a step inside a generated trajectory's saved fallback, which the editor shows but cannot
 * change.
 */
export type CommandUseLocation =
  | { kind: "pathEvent"; pathId: string; markerIndex: number; markerId?: string; memberIndex?: number }
  | { kind: "routineStep"; routineId: string; nodeId: string; readOnly?: true };

type Visit = (invocation: CommandInvocation, location: CommandUseLocation) => CommandInvocation;

function mapMarker(marker: Marker, path: PathDoc, markerIndex: number, visit: Visit): Marker {
  const at = { kind: "pathEvent" as const, pathId: path.id, markerIndex, ...(marker.id !== undefined ? { markerId: marker.id } : {}) };
  const commands = marker.commandGroup?.commands;
  if (Array.isArray(commands)) {
    let changed = false;
    const next = commands.map((command, memberIndex) => {
      if (!command || typeof command !== "object") return command;
      const result = visit(command, { ...at, memberIndex });
      changed ||= result !== command;
      return result;
    });
    return changed ? { ...marker, commandGroup: { ...marker.commandGroup!, commands: next } } : marker;
  }
  if (!marker.invocation) return marker;
  const invocation = visit(marker.invocation, at);
  return invocation === marker.invocation ? marker : { ...marker, invocation };
}

function mapList<T>(items: readonly T[], map: (item: T, index: number) => T): T[] | null {
  let changed = false;
  const next = items.map((item, index) => { const result = map(item, index); changed ||= result !== item; return result; });
  return changed ? next : null;
}

function mapNodes<T extends RoutineNode | RoutineFallbackNode>(nodes: readonly T[] | undefined, routine: AutonomousRoutine, visit: Visit, depth: number, readOnly = false): T[] | null {
  if (!Array.isArray(nodes) || depth > 64) return null;
  return mapList(nodes, (node) => mapNode(node, routine, visit, depth, readOnly) as T);
}

function mapNode(node: RoutineNode | RoutineFallbackNode, routine: AutonomousRoutine, visit: Visit, depth: number, readOnly: boolean): RoutineNode | RoutineFallbackNode {
  if (!node || typeof node !== "object") return node;
  switch (node.type) {
    case "function": {
      let next = node;
      if (node.invocation && typeof node.invocation === "object") {
        const invocation = visit(node.invocation, { kind: "routineStep", routineId: routine.id, nodeId: node.id, ...(readOnly ? { readOnly: true as const } : {}) });
        if (invocation !== node.invocation) next = { ...next, invocation };
      }
      const routes = node.outputBranch?.routes;
      const mapped = Array.isArray(routes) ? mapList(routes, (route) => {
        const nodes = mapNodes(route.nodes, routine, visit, depth + 1, readOnly);
        return nodes ? { ...route, nodes } : route;
      }) : null;
      return mapped ? { ...next, outputBranch: { ...next.outputBranch!, routes: mapped } } : next;
    }
    case "repeat":
    case "group": {
      const nodes = mapNodes(node.nodes, routine, visit, depth + 1, readOnly);
      return nodes ? { ...node, nodes } : node;
    }
    case "decision": {
      const then = mapNodes<RoutineNode | RoutineFallbackNode>(node.then, routine, visit, depth + 1, readOnly);
      const otherwise = mapNodes<RoutineNode | RoutineFallbackNode>(node.else, routine, visit, depth + 1, readOnly);
      return then || otherwise ? { ...node, then: then ?? node.then, else: otherwise ?? node.else } as typeof node : node;
    }
    case "generatedTrajectory": {
      if (node.fallback?.type !== "branch") return node;
      const nodes = mapNodes(node.fallback.nodes, routine, visit, depth + 1, true);
      return nodes ? { ...node, fallback: { ...node.fallback, nodes } } : node;
    }
    default:
      return node;
  }
}

/**
 * Every command use in a project, path events first, then routine steps in tree order. `visit` returns the use
 * unchanged or its replacement; the result is the same project when nothing changed, and otherwise shares every
 * untouched path, marker, routine and node.
 */
export function mapCommandUses(project: BordeauxProject, visit: Visit): BordeauxProject {
  const paths = mapList(project.paths, (path) => mapPathCommandUses(path, visit));
  const routines = mapList(project.routines ?? [], (routine) => mapRoutineCommandUses(routine, visit));
  if (!paths && !routines) return project;
  return { ...project, ...(paths ? { paths } : {}), ...(routines ? { routines } : {}) };
}

/** `mapCommandUses` for one path's events: the same path when nothing changed. */
export function mapPathCommandUses(path: PathDoc, visit: Visit): PathDoc {
  if (!Array.isArray(path.markers)) return path;
  const markers = mapList(path.markers, (marker, markerIndex) => mapMarker(marker, path, markerIndex, visit));
  return markers ? { ...path, markers } : path;
}

/** `mapCommandUses` for one routine's command steps, in tree order: the same routine when nothing changed. */
export function mapRoutineCommandUses(routine: AutonomousRoutine, visit: Visit): AutonomousRoutine {
  const nodes = mapNodes(routine.nodes, routine, visit, 0);
  return nodes ? { ...routine, nodes } : routine;
}

/** Calls `visit` for every command use in a project, in `mapCommandUses` order. */
export function forEachCommandUse(project: BordeauxProject, visit: (invocation: CommandInvocation, location: CommandUseLocation) => void): void {
  mapCommandUses(project, (invocation, location) => { visit(invocation, location); return invocation; });
}

export function sameCommandUseLocation(a: CommandUseLocation, b: CommandUseLocation): boolean {
  if (a.kind === "routineStep" || b.kind === "routineStep") {
    return a.kind === "routineStep" && b.kind === "routineStep" && a.routineId === b.routineId && a.nodeId === b.nodeId;
  }
  if (a.pathId !== b.pathId || a.memberIndex !== b.memberIndex) return false;
  // A marker id, when either side has one, is the identity; otherwise the position is.
  return a.markerId !== undefined || b.markerId !== undefined ? a.markerId === b.markerId : a.markerIndex === b.markerIndex;
}
