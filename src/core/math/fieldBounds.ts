// 2026 REBUILT welded field in the WPILib center-origin frame.
export const FIELD_W = 16.541;
export const FIELD_H = 8.069;

export interface WorldPoint {
  x: number;
  y: number;
}

export function clampWorldPoint(point: WorldPoint): WorldPoint {
  return {
    x: Math.max(FIELD_X_MIN, Math.min(FIELD_X_MAX, point.x)),
    y: Math.max(FIELD_Y_MIN, Math.min(FIELD_Y_MAX, point.y)),
  };
}


/** Half extents measured from the center of the welded field. */
export const FIELD_X_MAX = FIELD_W / 2;
export const FIELD_Y_MAX = FIELD_H / 2;
export const FIELD_X_MIN = -FIELD_X_MAX;
export const FIELD_Y_MIN = -FIELD_Y_MAX;

export function pointInsideField({ x, y }: WorldPoint): boolean {
  return x >= FIELD_X_MIN && x <= FIELD_X_MAX && y >= FIELD_Y_MIN && y <= FIELD_Y_MAX;
}

/** This rigid transform is its own inverse. */
export function rotateBlueOriginPoint({ x, y }: WorldPoint): WorldPoint {
  return { x: FIELD_X_MAX - x, y: FIELD_Y_MAX - y };
}
