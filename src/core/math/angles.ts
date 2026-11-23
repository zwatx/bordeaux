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
  if (Math.abs(Math.abs(wrapped) - Math.PI) < 1e-12) return Math.sign(wrapped) * Math.PI;
  if (wrapped > Math.PI) return wrapped - FULL_TURN;
  if (wrapped < -Math.PI) return wrapped + FULL_TURN;
  return wrapped;
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
