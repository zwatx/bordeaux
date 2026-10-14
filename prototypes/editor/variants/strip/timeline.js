// Time <-> path-fraction mapping for the strip, built from the shared derived profile.
// Holds (waits at stops) become flat stretches: the robot sits still, so time advances while f doesn't.

export function buildTimeline(derived) {
  const wpFrac = derived?.wpFrac || [];
  // Prefer the planner's own trace: it already carries waits and turns as time at a fixed f.
  const trace = derived?.trajectorySamples;
  if (trace?.length > 1) {
    const step = Math.max(1, Math.floor(trace.length / 1200));
    const points = [];
    for (let i = 0; i < trace.length; i += step) points.push({ t: trace[i].t, f: clamp01(trace[i].f), v: Math.max(0, trace[i].velocityMps || 0) });
    const last = trace[trace.length - 1];
    if (points[points.length - 1].t < last.t) points.push({ t: last.t, f: clamp01(last.f), v: Math.max(0, last.velocityMps || 0) });
    const total = Math.max(derived.prof?.totalTime || 0, last.t, 0.01);
    if (total > last.t + 1e-6) points.push({ t: total, f: 1, v: 0 });
    return { points, total, empty: false, wpFrac };
  }
  const pts = derived?.sample?.pts || [];
  const prof = derived?.prof;
  const n = pts.length;
  if (n < 2 || !prof?.t?.length) return { points: [{ t: 0, f: 0, v: 0 }, { t: 1, f: 1, v: 0 }], total: 1, empty: true, wpFrac };
  const S = pts[n - 1].s || 1;
  const v = derived.metrics?.v || prof.v || [];
  const holdAt = new Map((prof.holds || []).map((h) => [h.idx, h]));
  const points = [];
  for (let i = 0; i < n; i++) {
    const f = pts[i].s / S;
    const hold = holdAt.get(i);
    if (hold) {
      points.push({ t: hold.t0, f, v: 0 });
      points.push({ t: hold.t1, f, v: 0 });
    } else {
      points.push({ t: prof.t[i], f, v: v[i] || 0 });
    }
  }
  const total = Math.max(prof.totalTime || 0, points[points.length - 1].t, 0.01);
  if (total > points[points.length - 1].t + 1e-6) points.push({ t: total, f: 1, v: 0 });
  return { points, total, empty: false, wpFrac };
}

const clamp01 = (f) => Math.max(0, Math.min(1, f));

/** First index whose key is >= value (keys non-decreasing). */
function lowerBound(p, key, value) {
  let lo = 0, hi = p.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (p[mid][key] < value) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Time at which the robot first reaches path fraction f. */
export function tAtF(tl, f) {
  const p = tl.points;
  if (f <= p[0].f) return p[0].t;
  if (f >= p[p.length - 1].f) return lowerBoundT(p, p[p.length - 1].f);
  const i = Math.max(1, lowerBound(p, "f", f));
  const a = p[i - 1], b = p[i];
  const span = b.f - a.f;
  return span < 1e-9 ? a.t : a.t + ((f - a.f) / span) * (b.t - a.t);
}
function lowerBoundT(p, f) { return p[lowerBound(p, "f", f)].t; }

/** Path fraction at time t. */
export function fAtT(tl, t) {
  const p = tl.points;
  if (t <= p[0].t) return p[0].f;
  if (t >= p[p.length - 1].t) return p[p.length - 1].f;
  const i = Math.max(1, lowerBound(p, "t", t));
  const a = p[i - 1], b = p[i];
  const span = b.t - a.t;
  return span < 1e-9 ? b.f : a.f + ((t - a.t) / span) * (b.f - a.f);
}

/** Speed at time t (linear between samples). */
export function vAtT(tl, t) {
  const p = tl.points;
  if (t <= p[0].t) return p[0].v;
  if (t >= p[p.length - 1].t) return p[p.length - 1].v;
  const i = Math.max(1, lowerBound(p, "t", t));
  const a = p[i - 1], b = p[i];
  const span = b.t - a.t;
  return span < 1e-9 ? b.v : a.v + ((t - a.t) / span) * (b.v - a.v);
}

/** Peak speed reached between two fractions. */
export function peakBetween(tl, f0, f1) {
  let peak = 0;
  for (const q of tl.points) if (q.f >= f0 && q.f <= f1) peak = Math.max(peak, q.v);
  return peak;
}

/** "Nice" tick step for an axis covering `span` with roughly `count` ticks. */
export function niceStep(span, count) {
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return step * mag;
}

export const fmt = (value, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : "–");
