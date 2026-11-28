/** Field items a finger may grab although it lands beside them. Paths, footprints and labels keep their exact hit areas. */
export const TOUCH_HANDLE_ROLES = new Set(["wp", "ct", "head", "rt", "rth", "em", "rs", "re", "look", "issue"]);
/** Items a long press (which a touchscreen Mac sends as a right-button press) may drag. The heading control keeps its menu. */
export const SECONDARY_DRAG_ROLES = new Set(["wp", "ct", "rt", "rth", "em", "rs", "re", "look"]);

/** How far beside a handle a finger may land, in CSS pixels, and how far it must move before it drags. */
export const TOUCH_REACH_PX = 22;
export const TOUCH_SLOP_PX = 6;
const HANDLE_MAX_PX = 48;

/** Handles drawn centred on the point they move, so a grab can keep its offset from that centre. */
export const CENTRED_HANDLE_ROLES = new Set(["wp", "ct", "rs", "re", "look"]);

/** True for a box small enough to be a point-like handle rather than a path stroke, footprint or arm. */
export const isHandleSized = (box: { width: number; height: number }) => box.width <= HANDLE_MAX_PX && box.height <= HANDLE_MAX_PX;

export type HandleCandidate<T> = { item: T; role: string; left: number; top: number; width: number; height: number };

/**
 * The handle a finger at (x, y) means: the closest small handle whose box lies within `reach`, ties going to the nearer
 * centre. Large boxes (a path's hit stroke, a footprint, a heading arm) are skipped, so only point-like handles attract.
 */
export function pickTouchHandle<T>(candidates: Iterable<HandleCandidate<T>>, x: number, y: number, reach = TOUCH_REACH_PX): HandleCandidate<T> | null {
  let best: HandleCandidate<T> | null = null, bestEdge = Infinity, bestCentre = Infinity;
  for (const candidate of candidates) {
    if (!TOUCH_HANDLE_ROLES.has(candidate.role) || !(candidate.width > 0 || candidate.height > 0)) continue;
    if (!isHandleSized(candidate)) continue;
    const dx = Math.max(candidate.left - x, 0, x - (candidate.left + candidate.width));
    const dy = Math.max(candidate.top - y, 0, y - (candidate.top + candidate.height));
    const edge = Math.hypot(dx, dy);
    if (edge > reach) continue;
    const centre = Math.hypot(candidate.left + candidate.width / 2 - x, candidate.top + candidate.height / 2 - y);
    if (edge < bestEdge - 1e-6 || (Math.abs(edge - bestEdge) <= 1e-6 && centre < bestCentre)) { best = candidate; bestEdge = edge; bestCentre = centre; }
  }
  return best;
}

/** True for a press that came from a finger or a pen rather than a mouse or trackpad. Pens get slop but no reach. */
export const isDirectPointer = (event: { pointerType?: string }) => event.pointerType === "touch" || event.pointerType === "pen";
