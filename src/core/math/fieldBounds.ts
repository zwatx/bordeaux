// 2026 REBUILT welded field, in the fixed WPILib blue-origin frame.
export const FIELD_W = 16.541;
export const FIELD_H = 8.069;

export interface WorldPoint {
  x: number;
  y: number;
}

export function clampWorldPoint(point: WorldPoint): WorldPoint {
  return {
    x: Math.max(0, Math.min(FIELD_W, point.x)),
    y: Math.max(0, Math.min(FIELD_H, point.y)),
  };
}

