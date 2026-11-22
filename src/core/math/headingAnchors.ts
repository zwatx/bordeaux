import { D2R } from "./geometry";
import { movingTurnDelta } from "./angles";
import type { RotationDirection } from "../types";

// heading anchors -> continuous heading along arclength fraction f in [0,1]
// anchors: [{f, rad}] must include f=0 and f=1, sorted
// A moving C2 heading law can reverse angular direction without forcing a
// zero spatial rate at every anchor. Any authored flat span keeps the
// shape-preserving law so hold-heading intent remains exact. Cache the
// coefficients because every geometry sample reuses them.
export interface HeadingAnchor { f: number; rad: number; rotationDirection?: RotationDirection }
export const HEADING_FRACTION_EPSILON = 1e-9;
type HeadingSpline = { headings: number[]; second: number[]; slopes?: never }
  | { headings: number[]; slopes: number[]; second?: never };
const headingSplineCache = new WeakMap<readonly HeadingAnchor[], HeadingSpline>();

function headingSpline(anchors: readonly HeadingAnchor[]): HeadingSpline {
  const cached = headingSplineCache.get(anchors);
  if (cached) return cached;
  const headings = [anchors[0].rad];
  for (let i = 1; i < anchors.length; i++) {
    const delta = movingTurnDelta(headings[i - 1], anchors[i].rad, anchors[i].rotationDirection);
    headings.push(headings[i - 1] + delta);
  }
  const spans = anchors.slice(1).map((anchor, i) => anchor.f - anchors[i].f);
  const secants = spans.map((span, i) => span > HEADING_FRACTION_EPSILON ? (headings[i + 1] - headings[i]) / span : 0);
  if (anchors.length > 2 && spans.every((span) => span > HEADING_FRACTION_EPSILON) && secants.every((slope) => Math.abs(slope) > 1e-9)) {
    const second = new Array<number>(anchors.length).fill(0);
    const diagonal = new Array<number>(anchors.length).fill(0), upper = new Array<number>(anchors.length).fill(0), rhs = new Array<number>(anchors.length).fill(0);
    diagonal[0] = 2 * spans[0];
    upper[0] = spans[0];
    diagonal[anchors.length - 1] = 2 * spans[spans.length - 1];
    for (let i = 1; i < anchors.length - 1; i++) {
      diagonal[i] = 2 * (spans[i - 1] + spans[i]);
      upper[i] = spans[i];
      rhs[i] = 6 * (secants[i] - secants[i - 1]);
    }
    for (let i = 1; i < anchors.length; i++) {
      const lower = spans[i - 1];
      const scale = lower / diagonal[i - 1];
      diagonal[i] -= scale * upper[i - 1];
      rhs[i] -= scale * rhs[i - 1];
    }
    second[anchors.length - 1] = rhs[anchors.length - 1] / diagonal[anchors.length - 1];
    for (let i = anchors.length - 2; i >= 0; i--) second[i] = (rhs[i] - upper[i] * second[i + 1]) / diagonal[i];
    // The clamped C2 spline keeps angular velocity continuous through
    // authored anchors, but very uneven spacing can otherwise manufacture a
    // reverse turn. Monotonic spans may not overshoot at all; only a true
    // direction reversal gets a small bound before monotone fallback.
    const overshootLimit = 15 * D2R;
    const bounded = spans.every((span, i) => {
      const c0 = headings[i];
      const c1 = headings[i + 1] - headings[i] - span * span * (2 * second[i] + second[i + 1]) / 6;
      const c2 = second[i] * span * span / 2;
      const c3 = (second[i + 1] - second[i]) * span * span / 6;
      if (anchors[i + 1].rotationDirection === "cw" || anchors[i + 1].rotationDirection === "ccw") {
        const direction = Math.sign(secants[i]);
        const probes = [0, 1];
        if (Math.abs(c3) > 1e-12) probes.push(Math.max(0, Math.min(1, -c2 / (3 * c3))));
        if (probes.some((t) => direction * (c1 + 2 * c2 * t + 3 * c3 * t * t) < -1e-9)) return false;
      }
      const extrema = [];
      const discriminant = 4 * c2 * c2 - 12 * c3 * c1;
      if (Math.abs(c3) > 1e-12 && discriminant >= 0) {
        const root = Math.sqrt(discriminant);
        extrema.push((-2 * c2 + root) / (6 * c3), (-2 * c2 - root) / (6 * c3));
      } else if (Math.abs(c2) > 1e-12) extrema.push(-c1 / (2 * c2));
      const reversesAtStart = i > 0 && Math.sign(secants[i - 1]) !== Math.sign(secants[i]);
      const reversesAtEnd = i + 1 < secants.length && Math.sign(secants[i]) !== Math.sign(secants[i + 1]);
      const localOvershoot = reversesAtStart || reversesAtEnd ? overshootLimit : 0;
      const low = Math.min(headings[i], headings[i + 1]) - localOvershoot;
      const high = Math.max(headings[i], headings[i + 1]) + localOvershoot;
      return extrema.every((t) => t <= 0 || t >= 1
        || (c0 + c1 * t + c2 * t ** 2 + c3 * t ** 3 >= low - 1e-9
          && c0 + c1 * t + c2 * t ** 2 + c3 * t ** 3 <= high + 1e-9));
    });
    if (bounded) {
      const spline = { headings, second };
      headingSplineCache.set(anchors, spline);
      return spline;
    }
  }
  const slopes = new Array<number>(anchors.length).fill(0);
  for (let i = 1; i < anchors.length - 1; i++) {
    const before = secants[i - 1], after = secants[i];
    if (Math.abs(before) <= 1e-9 || Math.abs(after) <= 1e-9 || Math.sign(before) !== Math.sign(after)) continue;
    const beforeSpan = spans[i - 1], afterSpan = spans[i];
    const firstWeight = 2 * afterSpan + beforeSpan;
    const secondWeight = afterSpan + 2 * beforeSpan;
    slopes[i] = (firstWeight + secondWeight) / (firstWeight / before + secondWeight / after);
  }
  const spline = { headings, slopes };
  headingSplineCache.set(anchors, spline);
  return spline;
}

export function headingAt(f: number, anchors: readonly HeadingAnchor[]) {
  if (!anchors.length) return 0;
  if (f <= anchors[0].f) return anchors[0].rad;
  const spline = headingSpline(anchors);
  const { headings } = spline;
  // Select the first interval ending at or after f. Using a lower bound
  // preserves the incoming interval at exact anchors, including duplicates.
  let low = 1, high = anchors.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (anchors[middle].f < f) low = middle + 1;
    else high = middle;
  }
  const i = low - 1;
  if (low < anchors.length && f >= anchors[i].f && f <= anchors[low].f) {
    const a = anchors[i], b = anchors[low];
    const span = b.f - a.f;
    if (span < HEADING_FRACTION_EPSILON) return headings[i];
    if (spline.second) {
      const left = b.f - f, right = f - a.f;
      return spline.second[i] * left ** 3 / (6 * span)
        + spline.second[i + 1] * right ** 3 / (6 * span)
        + (headings[i] - spline.second[i] * span ** 2 / 6) * left / span
        + (headings[i + 1] - spline.second[i + 1] * span ** 2 / 6) * right / span;
    }
    const t = (f - a.f) / span, slopes = spline.slopes;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * headings[i]
      + (t3 - 2 * t2 + t) * span * slopes[i]
      + (-2 * t3 + 3 * t2) * headings[i + 1]
      + (t3 - t2) * span * slopes[i + 1];
  }
  return headings[headings.length - 1];
}

// build heading anchors from a flat list of {f, rad} entries (waypoint thetas + rotation targets)
// ensures coverage of f=0 and f=1 so heading is defined across the whole path
export function buildAnchors(entries: readonly HeadingAnchor[]) {
  const arr = (entries || [])
    .filter(e => e && isFinite(e.f) && isFinite(e.rad))
    .map(e => ({ f: Math.max(0, Math.min(1, e.f)), rad: e.rad, ...(e.rotationDirection ? { rotationDirection: e.rotationDirection } : {}) }))
    .sort((a, b) => a.f - b.f);
  if (!arr.length) return [{ f: 0, rad: 0 }, { f: 1, rad: 0 }];
  if (arr[0].f > 1e-6) arr.unshift({ f: 0, rad: arr[0].rad });
  if (arr[arr.length - 1].f < 1 - 1e-6) arr.push({ f: 1, rad: arr[arr.length - 1].rad });
  return arr;
}
