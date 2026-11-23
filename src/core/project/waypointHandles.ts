import type { ControlPoint, Waypoint } from "../types";

type HandleGeometry = Pick<Waypoint, "x" | "y" | "prevC" | "nextC">;

/** Preserve handle lengths while making both tangents point through the waypoint. */
export function alignedWaypointHandles(waypoint: HandleGeometry, preserveAligned = false): { prevC: ControlPoint; nextC: ControlPoint } | null {
  const inLength = Math.hypot(waypoint.x - waypoint.prevC.x, waypoint.y - waypoint.prevC.y);
  const outLength = Math.hypot(waypoint.nextC.x - waypoint.x, waypoint.nextC.y - waypoint.y);
  const inX = inLength > 1e-6 ? (waypoint.x - waypoint.prevC.x) / inLength : 0;
  const inY = inLength > 1e-6 ? (waypoint.y - waypoint.prevC.y) / inLength : 0;
  const outX = outLength > 1e-6 ? (waypoint.nextC.x - waypoint.x) / outLength : 0;
  const outY = outLength > 1e-6 ? (waypoint.nextC.y - waypoint.y) / outLength : 0;
  // Loading must preserve accepted trajectory identity, including floating-point bits.
  if (preserveAligned && ((inLength < 1e-6 || outLength < 1e-6)
    || (inX * outX + inY * outY > 0 && Math.abs(inX * outY - inY * outX) < 1e-12))) {
    return null;
  }
  let dx = inX + outX, dy = inY + outY;
  let magnitude = Math.hypot(dx, dy);
  if (magnitude < 1e-6) {
    dx = outLength > 1e-6 ? outX : inX;
    dy = outLength > 1e-6 ? outY : inY;
    magnitude = Math.hypot(dx, dy);
  }
  if (magnitude < 1e-6) { dx = 1; dy = 0; magnitude = 1; }
  dx /= magnitude; dy /= magnitude;
  return {
    prevC: { x: waypoint.x - dx * inLength, y: waypoint.y - dy * inLength },
    nextC: { x: waypoint.x + dx * outLength, y: waypoint.y + dy * outLength },
  };
}
