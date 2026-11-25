import { FIELD_H, FIELD_W } from "../math/fieldBounds";

// Inner alliance walls and guardrails, excluding station aprons. The raster
// already shows the blue wall on the right and the scoring table at the top.
// Map the AndyMark rectangle to the same crop (about 0.15% smaller than welded).
export const FIELD_IMAGE = Object.freeze({ width: 3901, height: 1583, left: 524, right: 3377, top: 95, bottom: 1488, rotationDeg: 0 });
export const FIELD_IMAGE_SCALE = Object.freeze({ x: (FIELD_IMAGE.right - FIELD_IMAGE.left) / FIELD_W, y: (FIELD_IMAGE.bottom - FIELD_IMAGE.top) / FIELD_H });
export const FIELD_IMAGE_CENTER = Object.freeze({ x: (FIELD_IMAGE.left + FIELD_IMAGE.right) / 2, y: (FIELD_IMAGE.top + FIELD_IMAGE.bottom) / 2 });

export function worldToFieldImage(point: { x: number; y: number }) {
  return { x: FIELD_IMAGE_CENTER.x + point.x * FIELD_IMAGE_SCALE.x, y: FIELD_IMAGE_CENTER.y - point.y * FIELD_IMAGE_SCALE.y };
}

export function fieldImageToWorld(point: { x: number; y: number }) {
  return { x: (point.x - FIELD_IMAGE_CENTER.x) / FIELD_IMAGE_SCALE.x, y: (FIELD_IMAGE_CENTER.y - point.y) / FIELD_IMAGE_SCALE.y };
}
