// Shell geometry. The field is 2.18:1, wider than either supported window, so at whole-field fit its scale
// is limited by width. The height below it is free: the band takes exactly that much by default.
import { FIELD_H, FIELD_W } from "../../core/Field.jsx";

export const BAND_MIN = 236;
const FIT_PAD = 32; // Field.fitCam keeps 16 px on each side.

export function shellSizes(w, h, pathsHidden) {
  const compact = w < 1240;
  const left = pathsHidden ? 0 : compact ? 224 : 248;
  const panel = compact ? 220 : 232;
  const fieldW = w - left;
  const need = (FIELD_H / FIELD_W) * (fieldW - FIT_PAD) + FIT_PAD;
  const balanced = Math.round(Math.max(BAND_MIN, Math.min(bandMax(h), h - need)));
  return { left, panel, balanced };
}

export const bandMax = (h) => Math.max(BAND_MIN, Math.round(h * 0.6));
export const clampBand = (v, h) => Math.round(Math.max(BAND_MIN, Math.min(bandMax(h), v)));

/** Pixels per metre the field gets at whole-field fit for a given field box. */
export function fieldScale(fieldW, fieldH) {
  return Math.min((fieldW - FIT_PAD) / FIELD_W, (fieldH - FIT_PAD) / FIELD_H);
}
