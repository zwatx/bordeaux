/** Shared ceiling for any in-memory trajectory produced by the desktop planners. */
export const MAX_TRAJECTORY_SAMPLES = 250_000;
export const DEFAULT_SAMPLES_PER_SEGMENT = 56;
/** How far the Optimize result that keeps the drawn shape may be from the drawn curve. */
export const DRAWN_SHAPE_LIMIT_M = 0.15;
/** Legacy heading unwrapping iterates over complete turns, so bound authored angles before planning. */
export const MAX_AUTHORED_ANGLE_DEG = 360_000;

/** The least time a result must save against Normal's `normalTimeS` to be offered instead of it. */
export const materialGainS = (normalTimeS: number) => Math.max(0.02, normalTimeS * 0.005);
