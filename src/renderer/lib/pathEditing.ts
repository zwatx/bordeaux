import { autoHandles } from "../../shared/math/geometry";
import { remapWaypointRange } from "../../shared/math/pathRanges";
import { clampWorldPoint, clone } from "../../shared/project/defaults";
import { alignedWaypointHandles } from "../../shared/project/waypointHandles";
import type { ControlPoint, PathDoc, Waypoint } from "../../shared/types";

type EditablePath = PathDoc & { _selAfter?: number };

export function alignWaypointHandles(waypoint: Waypoint): void {
  Object.assign(waypoint, alignedWaypointHandles(waypoint), { linked: true, corner: false });
}

export function remapWaypointRanges(path: PathDoc, oldToNew: Array<number | null>, removedIndex?: number): void {
  path.ranges = (path.ranges || []).map((range) => remapWaypointRange(range, oldToNew, removedIndex, path.waypoints.length));
}

export function setWaypointFacing(path: PathDoc, index: number, degrees: number): PathDoc {
  const waypoint = path.waypoints[index];
  if (!waypoint) return path;
  waypoint.theta = degrees;
  waypoint.thetaOn = true;
  // A start-facing edit must become an authored anchor, rather than being ignored
  // by a tangent or look-at law. Other segments keep their own heading modes.
  const mode = waypoint.segmentHeadingMode || path.headingMode || "targets";
  if (index === 0 && (mode === "tangent" || mode === "lookAt")) waypoint.segmentHeadingMode = "manual";
  return path;
}

export function moveWaypointTo(path: PathDoc, index: number, point: ControlPoint): PathDoc {
  const waypoint = path.waypoints[index];
  if (!waypoint) return path;
  const next = clampWorldPoint(point), dx = next.x - waypoint.x, dy = next.y - waypoint.y;
  waypoint.x = next.x; waypoint.y = next.y;
  if (waypoint.prevC) { waypoint.prevC.x += dx; waypoint.prevC.y += dy; }
  if (waypoint.nextC) { waypoint.nextC.x += dx; waypoint.nextC.y += dy; }
  return path;
}

// These operations mutate the isolated draft owned by the editor's history commit.
// Endpoint actions and outgoing-segment metadata must follow their topology rules.
export function removeWaypoint(path: PathDoc, index: number): PathDoc {
  if (path.waypoints.length <= 2 || index < 0 || index >= path.waypoints.length) return path;
  const oldCount = path.waypoints.length;
  const endpointJiggle = index === oldCount - 1 && path.waypoints[index].jiggle ? { ...path.waypoints[index].jiggle } : null;
  const indexMap = Array.from({ length: oldCount }, (_, oldIndex) => oldIndex === index ? null : oldIndex < index ? oldIndex : oldIndex - 1);
  path.waypoints.splice(index, 1);
  const last = path.waypoints.length - 1;
  remapWaypointRanges(path, indexMap, index);
  delete path.waypoints[last].segmentHeadingMode;
  delete path.waypoints[last].segmentLookAt;
  delete path.waypoints[0].headingTransition;
  delete path.waypoints[last].headingTransition;
  if (endpointJiggle) path.waypoints[last].jiggle = endpointJiggle;
  path.waypoints[0].thetaOn = true; path.waypoints[last].thetaOn = true;
  return path;
}

export function duplicateWaypoint(path: EditablePath, index: number): EditablePath {
  const oldCount = path.waypoints.length;
  const src = clone(path.waypoints[index]);
  delete src.headingTransition;
  delete src.positionName;
  delete src.positionLink; // A new, offset waypoint starts independent of the source.
  if (index === oldCount - 1) delete path.waypoints[index].jiggle;
  else delete src.jiggle;
  const next = clampWorldPoint({ x: src.x + 0.4, y: src.y + 0.4 }); src.x = next.x; src.y = next.y;
  path.waypoints.splice(index + 1, 0, src);
  remapWaypointRanges(path, Array.from({ length: oldCount }, (_, oldIndex) => oldIndex <= index ? oldIndex : oldIndex + 1));
  const hd = autoHandles(path.waypoints, index + 1); src.prevC = hd.prevC; src.nextC = hd.nextC;
  path.waypoints[0].thetaOn = true; path.waypoints[path.waypoints.length - 1].thetaOn = true;
  path._selAfter = index + 1; return path;
}

export function reversePath(path: PathDoc): PathDoc {
  if (path.waypoints.length < 2) return path;
  const lastWaypoint = path.waypoints[path.waypoints.length - 1];
  const endpointJiggle = lastWaypoint.jiggle ? { ...lastWaypoint.jiggle } : null;
  const oldSeg = path.waypoints.map((w) => w.segType);
  const oldHeading = path.waypoints.map((w) => w.segmentHeadingMode);
  const oldFollow = path.waypoints.map((w) => w.segmentFollowMode);
  const oldLookAt = path.waypoints.map((w) => w.segmentLookAt && { ...w.segmentLookAt });
  const oldLaws = path.waypoints.slice(0, -1).map((waypoint) => {
    const mode = waypoint.segmentHeadingMode || path.headingMode || 'targets';
    return mode === 'lookAt' ? 'lookAt:' + (waypoint.segmentLookAt ? waypoint.segmentLookAt.x + ':' + waypoint.segmentLookAt.y : '') : mode;
  });
  const oldTransitions = path.waypoints.map((waypoint, index) => index > 0 && index < path.waypoints.length - 1
    && oldLaws[index] !== oldLaws[index - 1] && !waypoint.turnInPlace
    ? { placement: 'after' as const, rotationPriority: 'heading' as const, distanceM: 0.75, ...(waypoint.headingTransition || {}) }
    : null);
  const w = path.waypoints.slice().reverse(); const n = w.length;
  w.forEach((x) => {
    const p = x.prevC; x.prevC = x.nextC; x.nextC = p;
    if (x.turnInPlace && x.turnInPlace.direction === 'clockwise') x.turnInPlace.direction = 'counterclockwise';
    else if (x.turnInPlace && x.turnInPlace.direction === 'counterclockwise') x.turnInPlace.direction = 'clockwise';
  });
  for (let j = 0; j < n; j++) {
    if (j < n - 1) {
      w[j].segType = oldSeg[n - 2 - j];
      if (oldHeading[n - 2 - j]) w[j].segmentHeadingMode = oldHeading[n - 2 - j];
      else delete w[j].segmentHeadingMode;
      if (oldFollow[n - 2 - j]) w[j].segmentFollowMode = oldFollow[n - 2 - j];
      else delete w[j].segmentFollowMode;
      const lookAt = oldLookAt[n - 2 - j];
      if (lookAt) w[j].segmentLookAt = { ...lookAt };
      else delete w[j].segmentLookAt;
    } else {
      delete w[j].segType;
      delete w[j].segmentHeadingMode;
      delete w[j].segmentFollowMode;
      delete w[j].segmentLookAt;
    }
    delete w[j].headingTransition;
  }
  for (let oldIndex = 1; oldIndex < n - 1; oldIndex++) {
    const transition = oldTransitions[oldIndex]; if (!transition) continue;
    w[n - 1 - oldIndex].headingTransition = { ...transition,
      placement: transition.placement === 'before' ? 'after' : transition.placement === 'split' ? 'split' : 'before' };
  }
  path.waypoints = w; remapWaypointRanges(path, Array.from({ length: n }, (_, index) => n - 1 - index));
  w.forEach((waypoint) => delete waypoint.jiggle);
  if (endpointJiggle) w[n - 1].jiggle = endpointJiggle;
  const sv = path.startVel, gv = path.goalVel; path.startVel = gv; path.goalVel = sv;
  if (endpointJiggle) path.goalVel = 0;
  w[0].thetaOn = true; w[n - 1].thetaOn = true; return path;
}

export function reorderWaypoint(path: EditablePath, from: number, to: number): EditablePath {
  const w = path.waypoints; if (to < 0 || to >= w.length || from === to) return path;
  const lastWaypoint = w[w.length - 1];
  const endpointJiggle = lastWaypoint.jiggle ? { ...lastWaypoint.jiggle } : null;
  const order = Array.from({ length: w.length }, (_, index) => index);
  const [oldIndex] = order.splice(from, 1); order.splice(to, 0, oldIndex);
  const indexMap: number[] = []; order.forEach((value, index) => { indexMap[value] = index; });
  const [m] = w.splice(from, 1); w.splice(to, 0, m);
  w.forEach((waypoint) => delete waypoint.jiggle);
  if (endpointJiggle) w[w.length - 1].jiggle = endpointJiggle;
  delete w[w.length - 1].segmentHeadingMode;
  delete w[w.length - 1].segmentFollowMode;
  delete w[w.length - 1].segmentLookAt;
  delete w[0].headingTransition;
  delete w[w.length - 1].headingTransition;
  remapWaypointRanges(path, indexMap);
  w[0].thetaOn = true; w[w.length - 1].thetaOn = true; path._selAfter = to; return path;
}
