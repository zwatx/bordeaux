import { MAX_AUTHORED_ANGLE_DEG } from "../planners/limits";

const FULL_TURN = Math.PI * 2;

/** Moving anchors may request a complete revolution when headings match. */
export function movingTurnDelta(start: number, end: number, direction?: "shortest" | "cw" | "ccw"): number {
  let delta = wrapRadians(end - start);
  if ((direction === "cw" || direction === "ccw") && Math.abs(delta) < 1e-9) delta = 0;
  if (direction === "ccw" && delta <= 0) delta += FULL_TURN;
  if (direction === "cw" && delta >= 0) delta -= FULL_TURN;
  return delta;
}

export function wrapRadians(value: number): number {
  const wrapped = value % FULL_TURN;
  // Degree-to-radian conversion and subtracting a common rotation can put an
  // exact half-turn a few ULPs on either side of pi. Retain its signed branch.
  // Those ULPs grow with the turns in the input, so the tolerance does too.
  if (Math.abs(Math.abs(wrapped) - Math.PI) < Math.max(1e-12, Math.abs(value) * 8 * Number.EPSILON)) return Math.sign(wrapped) * Math.PI;
  if (wrapped > Math.PI) return wrapped - FULL_TURN;
  if (wrapped < -Math.PI) return wrapped + FULL_TURN;
  return wrapped;
}

/** Facing fields show a stored heading within one turn, like wrapRadians. Stored headings keep their turns, so an
 * exact half-turn keeps its direction; the robot unwraps what it receives. */
export function wrapDegrees(value: number): number {
  // In degrees, so a whole-degree entry stays exact; an exact half-turn keeps its sign, as in wrapRadians.
  const wrapped = value % 360;
  if (Math.abs(Math.abs(wrapped) - 180) < 1e-9) return Math.sign(wrapped) * 180;
  if (wrapped > 180) return wrapped - 360;
  if (wrapped < -180) return wrapped + 360;
  return wrapped;
}

/** A value entered in a wrapped facing field, kept on the stored heading's turn so a scrub never reverses a half-turn.
 * Past the planner's heading bound (less a turn for the facing offset) the entered value stands on its own. */
export function onTurnOf(stored: number, entered: number): number {
  const kept = stored + entered - wrapDegrees(stored);
  return Math.abs(kept) <= MAX_AUTHORED_ANGLE_DEG - 360 ? kept : entered;
}

/** A shortest stationary half-turn is counterclockwise unless direction is explicit.
 * Unlike signed authored moving headings, atan2 tangents can exchange +pi/-pi
 * representations under a rigid rotation, so their tie must be representation-independent.
 */
export function stationaryTurnDelta(start: number, end: number, direction = "shortest"): number {
  let delta = wrapRadians(end - start);
  // Roundoff at an already matching heading must not expand to a full revolution.
  if (Math.abs(delta) < 1e-9) return 0;
  if (Math.abs(Math.abs(delta) - Math.PI) < 1e-12) delta = Math.PI;
  if (direction === "clockwise" && delta > 0) delta -= FULL_TURN;
  if (direction === "counterclockwise" && delta < 0) delta += FULL_TURN;
  return delta;
}
