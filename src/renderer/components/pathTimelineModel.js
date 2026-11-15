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
    const point = (sample) => ({ t: sample.t, f: clamp01(sample.f), s: Number.isFinite(sample.s) ? sample.s : undefined, v: Math.max(0, sample.velocityMps || 0),
      a: sample.accelerationMps2 || 0, w: (sample.angularVelocityRadps || 0) * R2D, k: sample.curvatureInvM || 0 });
    for (let i = 0; i < trace.length; i += step) points.push(point(trace[i]));
    const last = trace[trace.length - 1];
    if (points[points.length - 1].t < last.t) points.push(point(last));
    const total = Math.max(derived.prof?.totalTime || 0, last.t, 0.01);
    if (total > last.t + 1e-6) points.push({ t: total, f: 1, s: points[points.length - 1].s, v: 0, a: 0, w: 0, k: 0 });
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
      points.push({ t: hold.t0, f, s: pts[i].s, v: 0, ...extra, a: 0 });
      points.push({ t: hold.t1, f, s: pts[i].s, v: 0, ...extra, a: 0 });
    } else points.push({ t: prof.t[i], f, s: pts[i].s, v: Math.max(0, v[i] || 0), ...extra });
  }
  const total = Math.max(prof.totalTime || 0, points[points.length - 1].t, 0.01);
  if (total > points[points.length - 1].t + 1e-6) points.push({ t: total, f: 1, s: points[points.length - 1].s, v: 0, a: 0, w: 0, k: 0 });
  return { points, total, empty: false, wpFrac };
}

/**
 * The time at which the robot has travelled `meters` more than at time `t`, from the trace's travelled distance
 * (which also advances during stationary actions such as a jiggle, where the path fraction does not), or null when
 * the trace carries no distance or the robot never travels that far.
 */
export function timeAfterDistance(tl, t, meters) {
  const p = tl?.points || [];
  if (!(meters > 0) || p.length < 2 || !p.every((point) => Number.isFinite(point.s))) return undefined;
  let i = Math.max(1, lowerBound(p, 't', t));
  const a0 = p[i - 1], b0 = p[i] || a0, span0 = b0.t - a0.t;
  const start = span0 < 1e-9 ? b0.s : a0.s + ((t - a0.t) / span0) * (b0.s - a0.s), goal = start + meters;
  for (; i < p.length; i++) {
    const a = p[i - 1], b = p[i];
    if (b.s >= goal - 1e-9) return b.s - a.s < 1e-12 ? b.t : Math.max(t, a.t + ((goal - a.s) / (b.s - a.s)) * (b.t - a.t));
  }
  return null;
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

let measureContext = null;
/** Width of a chip label in the timelines' 11.5 px UI font; an estimate where there is no canvas. */
export function labelWidth(text) {
  if (!measureContext && typeof document !== 'undefined') measureContext = document.createElement('canvas').getContext('2d');
  if (!measureContext) return text.length * 6.5;
  measureContext.font = '11.5px "Space Grotesk", system-ui, sans-serif';
  return measureContext.measureText(text).width;
}

/**
 * How long a command keeps running on the timeline, from its start `t`, or null when it runs once.
 * A loop ends at its time, at its distance converted to time through the path's timing, or at the path's end;
 * a fixed-interval repeat ends at its end time (or the path's end) and carries its interval. `open` means the
 * limit lies beyond the path's end, so the drawn extent stops at the end without a cap. Group commands: in a
 * parallel group every command starts at `t`; in a sequential group only the first does, so a later command's
 * limit is known only when it is the path's end.
 */
export function commandExtent(marker, t, tl, derived) {
  if (!marker || tl?.empty || !Number.isFinite(t)) return null;
  const total = tl.total;
  const length = derived?.sample?.length || derived?.sample?.pts?.at?.(-1)?.s || 0;
  const loopEnd = (loop, known) => {
    const until = loop?.until;
    if (!until) return null;
    if (until.kind === 'pathEnd') return { t: total, open: false };
    if (!known) return null;
    if (until.kind === 'time' && until.seconds > 0) return { t: t + until.seconds, open: t + until.seconds > total + 1e-9 };
    if (until.kind === 'distance' && until.meters > 0) {
      // Travelled distance, so a jiggle or other stationary travel counts; path fraction only as a fallback.
      const byDistance = timeAfterDistance(tl, t, until.meters);
      if (byDistance === null) return { t: total, open: true };
      if (byDistance !== undefined) return { t: byDistance, open: false };
      if (!(length > 0)) return null;
      const f = fAtT(tl, t) + until.meters / length;
      return f >= 1 - 1e-9 ? { t: total, open: true } : { t: tAtF(tl, f), open: false };
    }
    return null;
  };
  const group = marker.commandGroup;
  const ends = group && Array.isArray(group.commands)
    ? group.commands.map((command, i) => loopEnd(command?.loop, group.mode === 'parallel' || i === 0)).filter(Boolean)
    : [loopEnd(marker.invocation?.loop, true)].filter(Boolean);
  if (ends.length) {
    const end = ends.reduce((a, b) => (b.t > a.t || (b.t === a.t && b.open) ? b : a));
    return end.t > t ? { kind: 'loop', t: Math.min(end.t, total), open: end.open } : null;
  }
  const every = marker.schedule?.repeatEveryS;
  if (every > 0) {
    const until = Number.isFinite(marker.schedule.endTimeS) ? Math.min(marker.schedule.endTimeS, total) : total;
    return until > t ? { kind: 'repeat', t: until, open: false, every } : null;
  }
  return null;
}

/**
 * Places command chips in the lane so none is clipped or overlaps another. Each chip has a diamond exactly at
 * its time (`x`) with its name beside it: to the right, or to the left when the name would run past the lane's
 * right end. Items (sorted by time) carry `t`, a natural width `w`, an optional `minW` and an optional extent end
 * `endT`, drawn as a bar in the chip's row, so the bar takes room there too. A chip goes in the first row with
 * room for its full name; otherwise in the row where the fewest pixels must be shortened from it and its
 * neighbours, keeping each at least `minW`; otherwise it waits. Waiting commands near each other (within `span`
 * pixels) become one "+N" chip, which takes the place of commands in the last row when it must.
 * Returns the chips and stacks in time order, each with `left`, `w`, `row` and `dir`, and the rows used.
 */
export function layoutCommandLane(items, { x, left, right, rows = 3, pad = 9, gap = 3, minW = 46, span = 56,
  stackWidth = (count) => 31 + 7 * String(count).length } = {}) {
  const lanes = Array.from({ length: rows }, () => []);
  const sync = (e) => { e.lo = Math.min(e.l, e.x); e.hi = Math.max(e.r, e.endX ?? -Infinity); };
  const shape = (e, w) => {
    const toRight = e.x - pad + w <= right ? true : e.x + pad - w >= left ? false : right - (e.x - pad) >= e.x + pad - left;
    e.dir = toRight ? 'right' : 'left';
    e.full = Math.max(1, Math.min(w, toRight ? right - (e.x - pad) : e.x + pad - left));
    if (toRight) { e.l = e.x - pad; e.r = e.l + e.full; } else { e.r = e.x + pad; e.l = e.r - e.full; }
    sync(e);
    return e;
  };
  const floor = (e) => Math.min(e.full, e.stack ? e.full : e.minW);
  // Pixels an entry can give up on each side: a right-facing chip shortens its end, a left-facing one its start.
  const giveRight = (e) => e.dir === 'right' && !(e.endX > e.r) ? Math.max(0, e.r - Math.max(e.l + floor(e), e.endX ?? -Infinity)) : 0;
  const giveLeft = (e) => e.dir === 'left' ? Math.max(0, e.r - floor(e) - e.l) : 0;

  // How `e` fits in a row: { cost, apply } or null.
  const fit = (e, row) => {
    const hits = lanes[row].filter((o) => o.lo < e.hi + gap && o.hi + gap > e.lo);
    if (!hits.length) return { cost: 0, apply: () => {} };
    const before = [], after = [];
    for (const o of hits) {
      const leftSide = o.lo < e.lo || (o.lo === e.lo && o.x <= e.x);
      (leftSide ? before : after).push({ o, d: leftSide ? o.hi + gap - e.lo : e.hi + gap - o.lo, slack: leftSide ? giveRight(o) : giveLeft(o) });
    }
    const side = (pairs, own) => {
      let mine = 0;
      for (const p of pairs) mine = Math.max(mine, p.d - p.slack, Math.min(p.d / 2, own));
      return mine <= own + 1e-9 ? mine : null;
    };
    const fromLeft = side(before, giveLeft(e)), fromRight = side(after, giveRight(e));
    if (fromLeft == null || fromRight == null) return null;
    const plan = [...before.map((p) => ({ o: p.o, by: Math.max(0, p.d - fromLeft), end: 'r' })),
      ...after.map((p) => ({ o: p.o, by: Math.max(0, p.d - fromRight), end: 'l' }))];
    return { cost: fromLeft + fromRight + plan.reduce((sum, p) => sum + p.by, 0), apply: () => {
      e.l += fromLeft; e.r -= fromRight; sync(e);
      plan.forEach((p) => { if (p.end === 'r') p.o.r -= p.by; else p.o.l += p.by; sync(p.o); });
    } };
  };
  const place = (e) => {
    let best = null;
    for (let row = 0; row < rows; row++) {
      const option = fit(e, row);
      if (option && (!best || option.cost < best.cost - 1e-9)) best = { ...option, row };
      if (option && option.cost === 0) break;
    }
    if (!best) return false;
    best.apply(); e.row = best.row; lanes[best.row].push(e);
    return true;
  };

  const waiting = [];
  for (const item of items) {
    const ax = x(item.t), endX = item.endT > item.t ? x(item.endT) : undefined;
    const e = shape({ item, x: ax, endX, minW: item.minW ?? minW }, item.w);
    if (!place(e)) waiting.push(e);
  }

  // Waiting commands become "+N" stacks; a stack with no room takes over the last row's commands at its place.
  const buckets = [];
  for (const e of waiting) {
    const last = buckets[buckets.length - 1];
    if (last && e.x - last[0].x <= span) last.push(e); else buckets.push([e]);
  }
  const remove = (o) => { const lane = lanes[o.row]; lane.splice(lane.indexOf(o), 1); };
  for (let members of buckets) {
    for (let guard = 0; guard <= items.length + buckets.length; guard++) {
      members = members.slice().sort((a, b) => a.item.t - b.item.t);
      const stack = shape({ stack: true, members, x: members[0].x }, stackWidth(members.length));
      if (place(stack)) break;
      const blocking = (row) => lanes[row].filter((o) => o.lo < stack.hi + gap && o.hi + gap > stack.lo);
      const other = blocking(rows - 1).find((o) => o.stack) || lanes.flat().find((o) => o.stack && o.lo < stack.hi + gap && o.hi + gap > stack.lo);
      if (other) { remove(other); members = [...members, ...other.members]; continue; }
      blocking(rows - 1).forEach((o) => { remove(o); members.push(o); });
    }
  }

  // Shortened chips take back free room, up to their own width.
  for (const lane of lanes) {
    lane.sort((a, b) => a.lo - b.lo);
    lane.forEach((e, i) => {
      if (e.stack || e.r - e.l >= e.full - 1e-9) return;
      if (e.dir === 'right') e.r = Math.min(e.l + e.full, i + 1 < lane.length ? lane[i + 1].lo - gap : Infinity);
      else e.l = Math.max(e.r - e.full, i > 0 ? lane[i - 1].hi + gap : -Infinity);
      sync(e);
    });
  }

  const placed = lanes.flat().map((e) => e.stack
    ? { stack: true, members: e.members.map((m) => m.item), t: e.members[0].item.t, x: e.x, left: e.l, w: e.r - e.l, row: e.row, dir: e.dir }
    : { ...e.item, x: e.x, endX: e.endX, left: e.l, w: e.r - e.l, row: e.row, dir: e.dir });
  placed.sort((a, b) => a.t - b.t || a.row - b.row);
  return { chips: placed, rows: lanes.reduce((count, lane, i) => lane.length ? i + 1 : count, 0) };
}

/** Closest a new waypoint may sit to an existing one, along the path (m). */
export const MIN_WAYPOINT_GAP = 0.05;

/**
 * Where a waypoint added at time `t` goes: the path position the timed trajectory reaches at `t`, as the
 * field's on-path visit (segment, segment parameter, point and heading) so the shared insertion splits
 * that segment exactly. Refuses places where the split could not keep the path's shape.
 */
export function waypointInsertionAt(tl, derived, doc, t) {
  const waypoints = doc?.waypoints || [];
  const pts = derived?.sample?.pts || [];
  if (waypoints.length < 2 || pts.length < 2) return { ok: false, code: 'unplanned' };
  const total = pts[pts.length - 1].s || 0;
  if (!(total > 0)) return { ok: false, code: 'unplanned' };
  const f = clamp01(fAtT(tl, t));
  const s = f * total;
  // Waypoint distances along the path: the last sample of each segment ends at the next waypoint.
  const wpS = [0];
  for (let i = 1; i < pts.length; i++) if (pts[i].seg !== pts[i - 1].seg) wpS.push(pts[i - 1].s);
  wpS.push(total);
  if (wpS.length !== waypoints.length) return { ok: false, code: 'unplanned' };
  const near = wpS.findIndex((at) => Math.abs(at - s) < MIN_WAYPOINT_GAP);
  if (near >= 0) return { ok: false, code: near === 0 ? 'start' : near === waypoints.length - 1 ? 'end' : 'near', index: near };
  let i = 1;
  while (i < pts.length - 1 && pts[i].s < s) i++;
  const a = pts[i - 1], b = pts[i];
  const u = b.s - a.s > 1e-12 ? Math.max(0, Math.min(1, (s - a.s) / (b.s - a.s))) : 0;
  // An edge across a joint starts the next segment at parameter 0.
  const seg = b.seg, aT = a.seg === seg ? a.t : 0;
  const segType = waypoints[seg]?.segType || 'bezier';
  if (segType === 'arc' || segType === 'clothoid') return { ok: false, code: 'segtype', segType, segment: seg };
  if (segType === 'bezier' && !(waypoints[seg].nextC && waypoints[seg + 1]?.prevC)) return { ok: false, code: 'handles', segment: seg };
  const lerp = (p, q) => p + (q - p) * u;
  const dh = Math.atan2(Math.sin((b.heading || 0) - (a.heading || 0)), Math.cos((b.heading || 0) - (a.heading || 0)));
  const visit = { x: lerp(a.x, b.x), y: lerp(a.y, b.y), s, f, seg, t: lerp(aT, b.t), heading: (a.heading || 0) + dh * u };
  return { ok: true, visit, segment: seg, index: seg + 1 };
}
