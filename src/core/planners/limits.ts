/** Shared ceiling for any in-memory trajectory produced by the desktop planners. */
export const MAX_TRAJECTORY_SAMPLES = 250_000;
export const DEFAULT_SAMPLES_PER_SEGMENT = 56;
/** Legacy heading unwrapping iterates over complete turns, so bound authored angles before planning. */
export const MAX_AUTHORED_ANGLE_DEG = 360_000;
