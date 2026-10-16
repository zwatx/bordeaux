import { effectiveRanges } from '../../shared/math/pathRanges';
import { PM } from '../lib/pathMath';

// Time <-> path-fraction mapping for the path timeline, built from the displayed planning result.
// Stops and waits are flat stretches: time advances while the fraction does not.

const clamp01 = (f) => Math.max(0, Math.min(1, f));
const R2D = 180 / Math.PI;

/** Uses the planner's own trace when there is one, else the preview's sampled profile. */
export function buildTimeline(derived) {
  const wpFrac = derived?.wpFrac || [];
  const trace = derived?.trajectorySamples?.length > 1 ? derived.trajectorySamples
    : derived?.finalTrajectory?.samples?.length > 1 ? derived.finalTrajectory.samples : null;
  if (trace) {
    const step = Math.max(1, Math.floor(trace.length / 1200));
    const points = [];
    // Authoritative per-sample values, including turning while stopped.
    const point = (sample) => ({ t: sample.t, f: clamp01(sample.f), v: Math.max(0, sample.velocityMps || 0),
      a: sample.accelerationMps2 || 0, w: (sample.angularVelocityRadps || 0) * R2D, k: sample.curvatureInvM || 0 });
    for (let i = 0; i < trace.length; i += step) points.push(point(trace[i]));
    const last = trace[trace.length - 1];
    if (points[points.length - 1].t < last.t) points.push(point(last));
    const total = Math.max(derived.prof?.totalTime || 0, last.t, 0.01);
    if (total > last.t + 1e-6) points.push({ t: total, f: 1, v: 0, a: 0, w: 0, k: 0 });
    return { points, total, empty: false, wpFrac };
  }
  const pts = derived?.sample?.pts || [];
  const prof = derived?.prof;
  const n = pts.length;
  const timed = prof?.t?.length === n && prof.totalTime > 0;
  if (n < 2 || !timed) return { points: [{ t: 0, f: 0, v: 0 }, { t: 1, f: 1, v: 0 }], total: 1, empty: true, wpFrac };
  const length = pts[n - 1].s || 1;
  const metrics = derived.metrics || {};
  const v = metrics.v || prof.v || [];
  const holdAt = new Map((prof.holds || []).map((hold) => [hold.idx, hold]));
  const points = [];
  for (let i = 0; i < n; i++) {
    const f = pts[i].s / length;
    const hold = holdAt.get(i);
    const extra = { a: metrics.accel?.[i] || 0, w: (metrics.omega?.[i] || 0) * R2D, k: metrics.curv?.[i] || 0 };
    if (hold) {
      points.push({ t: hold.t0, f, v: 0, ...extra, a: 0 });
      points.push({ t: hold.t1, f, v: 0, ...extra, a: 0 });
    } else points.push({ t: prof.t[i], f, v: Math.max(0, v[i] || 0), ...extra });
  }
  const total = Math.max(prof.totalTime || 0, points[points.length - 1].t, 0.01);
  if (total > points[points.length - 1].t + 1e-6) points.push({ t: total, f: 1, v: 0, a: 0, w: 0, k: 0 });
  return { points, total, empty: false, wpFrac };
}

function lowerBound(points, key, value) {
  let lo = 0, hi = points.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (points[mid][key] < value) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Time at which the robot first reaches path fraction f. */
export function tAtF(tl, f) {
  const p = tl.points;
  if (!(f > p[0].f)) return p[0].t;
  if (f >= p[p.length - 1].f) return p[lowerBound(p, 'f', p[p.length - 1].f)].t;
  const i = Math.max(1, lowerBound(p, 'f', f));
  const a = p[i - 1], b = p[i], span = b.f - a.f;
  return span < 1e-9 ? a.t : a.t + ((f - a.f) / span) * (b.t - a.t);
}

/** Path fraction at time t. */
export function fAtT(tl, t) {
  const p = tl.points;
  if (!(t > p[0].t)) return p[0].f;
  if (t >= p[p.length - 1].t) return p[p.length - 1].f;
  const i = Math.max(1, lowerBound(p, 't', t));
  const a = p[i - 1], b = p[i], span = b.t - a.t;
  return span < 1e-9 ? b.f : a.f + ((t - a.t) / span) * (b.f - a.f);
}

/** Speed (or another sampled value, by key) at time t, linear between samples. */
export function vAtT(tl, t, key = 'v') {
  const p = tl.points;
  if (!(t > p[0].t)) return p[0][key] || 0;
  if (t >= p[p.length - 1].t) return p[p.length - 1][key] || 0;
  const i = Math.max(1, lowerBound(p, 't', t));
  const a = p[i - 1], b = p[i], span = b.t - a.t;
  return span < 1e-9 ? b[key] || 0 : (a[key] || 0) + ((t - a.t) / span) * ((b[key] || 0) - (a[key] || 0));
}

/** A round tick step for an axis covering `span` with about `count` ticks. */
export function niceStep(span, count) {
  const raw = span / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  return (normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10) * magnitude;
}

/** Zone spans as path fractions, whatever their anchor. Planning results may omit them. */
export function zoneFractions(doc, derived) {
  const ranges = doc.ranges || [];
  if (derived?.effRanges?.length === ranges.length) return derived.effRanges;
  if (!derived?.sample?.pts?.length) return ranges.map((range) => ({ f0: range.f0 || 0, f1: range.f1 || 0 }));
  return effectiveRanges(doc, derived.sample);
}

/** Where an authored feature (command or rotation target) sits along the path. */
export const featureFraction = (item, derived) => derived?.sample?.pts?.length ? PM.featureFraction(item, derived.sample) : clamp01(item.f || 0);

/** A position patch that keeps the item's own anchor: distance-anchored items also store their distance. */
export function featurePositionPatch(item, f, derived) {
  const fraction = clamp01(f);
  return item.anchor === 'dist' ? { f: fraction, d: +(fraction * (derived?.sample?.length || 0)).toFixed(3) } : { f: fraction };
}
