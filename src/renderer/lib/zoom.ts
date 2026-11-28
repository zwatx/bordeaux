export type FieldViewBox = { x: number; y: number; w: number; h: number };
export type ScreenPoint = { x: number; y: number };
/** What plain scrolling does on the field. Pinch and Ctrl/⌘+scroll always zoom. */
export type FieldScrollMode = "pan" | "zoom";
export type FieldWheelInput = {
  deltaX: number; deltaY: number; deltaMode: number;
  ctrlKey?: boolean; metaKey?: boolean;
};
export type FieldWheelAction =
  | { kind: "zoom"; factor: number }
  | { kind: "pan"; dx: number; dy: number };

/** Wheel deltas in CSS pixels, whatever unit the device reported. */
export function wheelPixels(delta: number, deltaMode: number, viewportHeight: number): number {
  return delta * (deltaMode === 1 ? 16 : deltaMode === 2 ? Math.max(1, viewportHeight) : 1);
}

export function wheelZoomFactor(deltaY: number, deltaMode: number, viewportHeight: number): number {
  const pixels = wheelPixels(deltaY, deltaMode, viewportHeight);
  return Math.exp(Math.max(-120, Math.min(120, pixels)) * 0.0006);
}

/**
 * Chromium reports a trackpad or touchscreen pinch as a Ctrl+wheel whose deltaY is -100·ln(scale), so this undoes it
 * exactly and the field follows the fingers. Each event is bounded so one runaway delta cannot jump the zoom.
 */
export function pinchZoomFactor(deltaY: number, deltaMode: number, viewportHeight: number): number {
  const pixels = wheelPixels(deltaY, deltaMode, viewportHeight);
  return Math.exp(Math.max(-25, Math.min(25, pixels)) / 100);
}

/**
 * One wheel event on the field. Pinch (Chromium's Ctrl+wheel) and Ctrl/⌘+scroll zoom; plain scrolling pans or zooms by
 * preference. On a touchscreen Mac a one-finger drag reaches the app as this kind of scroll, so panning follows the finger.
 */
export function fieldWheelAction(event: FieldWheelInput, mode: FieldScrollMode, viewportHeight: number): FieldWheelAction {
  // Only a pinch follows the fingers' scale. ⌘+scroll, and a Ctrl+scroll whose step looks like a mouse-wheel notch (lines
  // or pages, or a whole number of 50 px or more; a pinch's -100·ln(scale) never is), zoom at the ordinary wheel rate.
  const notch = event.deltaMode !== 0 || (Number.isInteger(event.deltaY) && Math.abs(event.deltaY) >= 50);
  if (event.metaKey || (event.ctrlKey && notch)) return { kind: "zoom", factor: wheelZoomFactor(event.deltaY, event.deltaMode, viewportHeight) };
  if (event.ctrlKey) return { kind: "zoom", factor: pinchZoomFactor(event.deltaY, event.deltaMode, viewportHeight) };
  if (mode === "zoom") return { kind: "zoom", factor: wheelZoomFactor(event.deltaY, event.deltaMode, viewportHeight) };
  return { kind: "pan", dx: wheelPixels(event.deltaX, event.deltaMode, viewportHeight), dy: wheelPixels(event.deltaY, event.deltaMode, viewportHeight) };
}

/** Narrowest and widest visible field widths, in field-image units, for a field image this wide. */
export function fieldZoomLimits(imageWidth: number): { min: number; max: number } {
  return { min: imageWidth * 0.12, max: imageWidth * 1.6 };
}

/** The view scaled by `factor` (its width multiplies by it) about `anchor`, which stays put; the aspect is kept. */
export function zoomViewAbout(view: FieldViewBox, anchor: ScreenPoint, factor: number, limits: { min: number; max: number }): FieldViewBox {
  const w = Math.max(limits.min, Math.min(limits.max, view.w * factor));
  const k = w / view.w;
  return { x: anchor.x - (anchor.x - view.x) * k, y: anchor.y - (anchor.y - view.y) * k, w, h: view.h * k };
}

export type PinchStart = {
  view: FieldViewBox;
  /** The fingers' midpoint and spread on screen when the pinch began. */
  center: ScreenPoint; spread: number;
  /** The field-image point under `center` then, and the screen pixels per field-image unit. */
  anchor: ScreenPoint; pixelsPerUnit: number;
};

/**
 * The view for a two-finger gesture, from where it began, so rounding never accumulates: the point first under the
 * fingers stays under their midpoint while the spread zooms.
 */
export function pinchView(start: PinchStart, center: ScreenPoint, spread: number, limits: { min: number; max: number }): FieldViewBox {
  const scaled = zoomViewAbout(start.view, start.anchor, start.spread / Math.max(1, spread), limits);
  const k = scaled.w / start.view.w;
  return { ...scaled,
    x: scaled.x - (center.x - start.center.x) / start.pixelsPerUnit * k,
    y: scaled.y - (center.y - start.center.y) / start.pixelsPerUnit * k };
}

export type ScrollStorage = Pick<Storage, "getItem" | "setItem">;

// What plain scrolling does on the field is a per-machine app preference, like display units; projects never carry it.
// Macs default to panning: trackpads scroll there, and a touchscreen Mac delivers a one-finger drag as a scroll.
export function createFieldScrollPreference(storage: ScrollStorage, fallback: FieldScrollMode) {
  const STORAGE_KEY = "bordeaux.fieldScroll";
  let current: FieldScrollMode = fallback;
  try {
    const stored = storage.getItem(STORAGE_KEY);
    if (stored === "pan" || stored === "zoom") current = stored;
  } catch (_) {}
  const listeners = new Set<() => void>();
  return {
    current: () => current,
    set(next: string): FieldScrollMode {
      const value: FieldScrollMode = next === "zoom" ? "zoom" : "pan";
      if (value === current) return current;
      current = value;
      try { storage.setItem(STORAGE_KEY, value); } catch (_) {}
      listeners.forEach((listener) => listener());
      return current;
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
