import { alignWaypointHandles } from "../../../src/renderer/lib/pathEditing";

// Mutate only the isolated draft supplied by the prototype history commit.
export function setWaypointStop(path, index, on) {
  const waypoint = path.waypoints[index];
  if (!waypoint) return path;
  waypoint.stop = on;
  if (on) {
    // A complete stop permits independent incoming and outgoing tangents.
    waypoint.linked = false;
  } else {
    alignWaypointHandles(waypoint);
    delete waypoint.wait;
    delete waypoint.turnInPlace;
  }
  return path;
}

export function moveWaypointHandle(path, index, side, point) {
  const waypoint = path.waypoints[index];
  if (!waypoint || (side !== "prev" && side !== "next")) return path;
  const own = side === "prev" ? "prevC" : "nextC";
  const other = side === "prev" ? "nextC" : "prevC";
  waypoint[own] = { x: point.x, y: point.y };
  // Respect stops even in older documents that still have linked=true.
  if (!waypoint.stop && waypoint.linked !== false && waypoint[other]) {
    const length = Math.hypot(waypoint[other].x - waypoint.x, waypoint[other].y - waypoint.y);
    const angle = Math.atan2(point.y - waypoint.y, point.x - waypoint.x) + Math.PI;
    waypoint[other] = { x: waypoint.x + Math.cos(angle) * length, y: waypoint.y + Math.sin(angle) * length };
  }
  return path;
}
