export function parseFiniteDraftNumber(raw: string): number | null {
  if (!raw.trim()) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

type DraftRange = { min?: number; max?: number };

/** Returns the canonical value for a committed display draft, or null when the draft is not a finite number. */
export function committedDraftValue(
  raw: string,
  stored: unknown,
  displayed: unknown,
  toCanonical: (displayed: number) => number,
  { min, max }: DraftRange = {},
): number | null {
  const parsed = parseFiniteDraftNumber(raw);
  if (parsed == null) return null;
  // An untouched display value must not round-trip through unit conversion:
  // floating-point drift can invalidate planning and move keyboard focus. Visiting
  // a field also must not clamp an existing value to that editor's typing bounds.
  if (typeof stored === 'number' && parsed === displayed) return stored;
  let next = toCanonical(parsed);
  if (min != null) next = Math.max(min, next);
  if (max != null) next = Math.min(max, next);
  return next;
}
