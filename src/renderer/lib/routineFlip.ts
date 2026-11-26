import { flipPath, type FieldFlipDirection } from "../../core/project/flipField";
import { createMarkerId, createPathId, createPathLinkId, createRoutineId, createRoutineNodeId } from "../../core/project/ids";
import { routineChildLists } from "../../core/routineChildren";
import type { AutonomousRoutine, BordeauxProject, PathDoc, RoutineNode } from "../../core/types";
import { uniqueItemName } from "./editorProject";

type PathSource = Pick<BordeauxProject, "paths">;

/** Calls `visit` for each step in flow order, including steps inside branches, routes, repeats, groups and fallbacks. */
function eachNode(nodes: readonly RoutineNode[], visit: (node: RoutineNode) => void) {
  for (const node of nodes) {
    visit(node);
    for (const list of routineChildLists(node)) eachNode(list.nodes, visit);
  }
}

/** What flipping `routine` would create: the paths its steps follow (each once, in flow order) and what keeps its old meaning. */
export function routineFlipSummary(project: PathSource, routine: AutonomousRoutine) {
  const byId = new Map(project.paths.map((path) => [path.id, path]));
  const paths = new Map<string, PathDoc>();
  let generated = 0;
  eachNode(routine.nodes, (node) => {
    const path = node.type === "path" ? byId.get(node.ref) : undefined;
    if (path) paths.set(path.id, path);
    if (node.type === "generatedTrajectory") generated += 1;
  });
  const sources = [...paths.values()];
  return { paths: sources, generated, optimized: sources.filter((path) => path.optimization?.accepted).length };
}

/**
 * Copies paths with new path and marker ids. Shared positions stay shared among the copies under new group ids; a
 * point shared only with a path outside the set is no longer linked, so the copies never move the originals.
 */
export function copyPathsForFlip(sources: readonly PathDoc[], names: readonly string[]): PathDoc[] {
  const copies = sources.map((source, index) => {
    const copy = structuredClone(source);
    copy.id = createPathId();
    copy.name = names[index];
    copy.markers = copy.markers.map((marker) => ({ ...marker, id: createMarkerId() }));
    return copy;
  });
  const groups = new Map<string, PathDoc["waypoints"]>();
  for (const point of copies.flatMap((copy) => copy.waypoints)) {
    if (!point.positionLink) continue;
    groups.set(point.positionLink, [...(groups.get(point.positionLink) || []), point]);
  }
  for (const members of groups.values()) {
    if (members.length === 1) delete members[0].positionLink;
    else {
      const id = createPathLinkId();
      members.forEach((point) => { point.positionLink = id; });
    }
  }
  return copies;
}

/**
 * Returns `project` with a flipped copy of the routine named `name`, made active right after the original. Each path
 * the routine follows gets one flipped copy named "<path> flipped" right after it, and the new routine's steps (with
 * new ids) follow the copies. Endpoint links and shared positions between those paths carry over to their copies.
 * Commands, conditions, routes and generated trajectory arguments are kept as they are. The original routine and
 * paths do not change. Throws an Error naming the path when a flip cannot be made.
 */
export function flipRoutine(project: BordeauxProject, routineId: string, direction: FieldFlipDirection, name: string): BordeauxProject {
  const source = project.routines.find((routine) => routine.id === routineId);
  if (!source) throw new Error("The routine is no longer in the project.");
  const { paths: sources } = routineFlipSummary(project, source);
  const taken: { name: string }[] = [...project.paths];
  const names = sources.map((path) => {
    const copyName = uniqueItemName(taken, path.name + " flipped");
    taken.push({ name: copyName });
    return copyName;
  });
  // Copies plan from their waypoints: flipPath drops an applied optimization from a copy, so nothing is qualified.
  const copies = copyPathsForFlip(sources, names).map((copy, index) => {
    try { return flipPath(copy, direction, project, () => false, true); }
    catch (error) { throw new Error(sources[index].name + ": " + (error instanceof Error ? error.message : String(error))); }
  });
  const copyOf = new Map(sources.map((path, index) => [path.id, copies[index]]));
  const paths = project.paths.flatMap((path) => copyOf.has(path.id) ? [path, copyOf.get(path.id)!] : [path]);
  const pathLinks = [...project.pathLinks, ...project.pathLinks.flatMap((link) => {
    const from = copyOf.get(link.fromPathId), to = copyOf.get(link.toPathId);
    return from && to ? [{ id: createPathLinkId(), fromPathId: from.id, toPathId: to.id }] : [];
  })];

  const nodes = structuredClone(source.nodes), nodeIds = new Map<string, string>();
  eachNode(nodes, (node) => {
    const id = createRoutineNodeId();
    nodeIds.set(node.id, id);
    node.id = id;
  });
  // Steps refer to each other by id only through a repeat's output stop; routes have ids of their own.
  eachNode(nodes, (node) => {
    if (node.type === "path") node.ref = copyOf.get(node.ref)?.id ?? node.ref;
    if (node.type === "repeat" && node.until?.source === "output") node.until.nodeId = nodeIds.get(node.until.nodeId) ?? node.until.nodeId;
    if (node.type === "function") node.outputBranch?.routes.forEach((route) => { route.id = createRoutineNodeId(); });
  });
  const flipped: AutonomousRoutine = { ...source, id: createRoutineId(), name, nodes };
  const at = project.routines.indexOf(source);
  const routines = [...project.routines.slice(0, at + 1), flipped, ...project.routines.slice(at + 1)];
  return { ...project, paths, pathLinks, routines, activeRoutineId: flipped.id };
}
