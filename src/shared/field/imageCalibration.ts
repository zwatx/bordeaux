import { FIELD_H, FIELD_W } from "../math/fieldBounds";

// Original Bordeaux overlay: inner alliance walls and guardrails, excluding the
// station aprons. Rotate the raster once into the fixed blue-left frame.
export const FIELD_IMAGE = Object.freeze({ width: 3901, height: 1583, left: 524, right: 3377, top: 95, bottom: 1488, rotationDeg: 180 });
export const FIELD_IMAGE_SCALE = Object.freeze({ x: (FIELD_IMAGE.right - FIELD_IMAGE.left) / FIELD_W, y: (FIELD_IMAGE.bottom - FIELD_IMAGE.top) / FIELD_H });

export function worldToFieldImage(point: { x: number; y: number }) {
  return { x: FIELD_IMAGE.left + point.x * FIELD_IMAGE_SCALE.x, y: FIELD_IMAGE.bottom - point.y * FIELD_IMAGE_SCALE.y };
}

export function fieldImageToWorld(point: { x: number; y: number }) {
  return { x: (point.x - FIELD_IMAGE.left) / FIELD_IMAGE_SCALE.x, y: (FIELD_IMAGE.bottom - point.y) / FIELD_IMAGE_SCALE.y };
}
