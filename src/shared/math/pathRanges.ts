import type { ConstraintRange, PathDoc } from "../types";
import type { SampledPath } from "./geometry";

import { angWrap, lerp } from "./geometry";

// ---- constraint-range anchoring -------------------------------------------
// A range can be anchored three ways. We resolve each to
// concrete arclength fractions [f0,f1] against the CURRENT path so the profile
// engine + overlays stay simple, while the stored anchor keeps the range
// attached the way the user intends as the path is edited.
//   param : fixed percent of the path        {f0,f1}
//   dist  : legacy fixed metres of travel    {d0,d1}
//   wp    : local positions within segments  {w0,t0,w1,t1}; omitted t values
//           preserve legacy whole-waypoint spans
export function waypointFracs(doc: Pick<PathDoc, "waypoints">, smp: Pick<SampledPath, "pts" | "length" | "wpIdx">) {
  const pts = smp.pts; const total = smp.length || 1; const n = doc.waypoints.length;
  if (!pts.length) return doc.waypoints.map(() => 0);
  if (Array.isArray(smp.wpIdx) && smp.wpIdx.length === n) return smp.wpIdx.map((index) => pts[Math.max(0, Math.min(pts.length - 1, index))].s / total);
  const perSeg = (pts.length - 1) / Math.max(1, n - 1);
  return doc.waypoints.map((_, k) => { const i = Math.min(pts.length - 1, Math.round(k * perSeg)); return pts[i].s / total; });
}

export function effectiveRanges(doc: Pick<PathDoc, "waypoints" | "ranges" | "routeRequiredPointIndices">, smp: Pick<SampledPath, "pts" | "length" | "wpIdx">): ConstraintRange[] {
  const ranges = doc.ranges || []; const total = smp.length || 1;
  const generatedFractions = ranges.some((r) => r.anchor === 'wp') ? waypointFracs(doc, smp) : null;
  const wf = generatedFractions && doc.routeRequiredPointIndices
    ? doc.routeRequiredPointIndices.map((i) => generatedFractions[i]) : generatedFractions;
  return ranges.map((r) => {
    let f0 = r.f0, f1 = r.f1;
    if (r.anchor === 'dist') { f0 = (r.d0 != null ? r.d0 : (r.f0 || 0) * total) / total; f1 = (r.d1 != null ? r.d1 : (r.f1 || 0) * total) / total; }
    else if (r.anchor === 'wp' && wf) {
      const localFraction = (waypoint: number | undefined, local: number | undefined, fallback: number) => {
        if (local == null) return wf[Math.max(0, Math.min(wf.length - 1, waypoint != null ? waypoint : fallback))];
        const segment = Math.max(0, Math.min(wf.length - 2, Math.round(waypoint != null ? waypoint : 0)));
        const t = Math.max(0, Math.min(1, local));
        return wf[segment] + (wf[segment + 1] - wf[segment]) * t;
      };
      f0 = localFraction(r.w0, r.t0, 0); f1 = localFraction(r.w1, r.t1, wf.length - 1);
    }
    f0 = Math.max(0, Math.min(1, f0 || 0)); f1 = Math.max(0, Math.min(1, f1 || 0));
    return { f0, f1, maxVel: r.maxVel, maxAccel: r.maxAccel, maxDecel: r.maxDecel, maxAngVel: r.maxAngVel, maxAngAccel: r.maxAngAccel, anchor: r.anchor || 'param', name: r.name };
  });
}

export function featureFraction(feature: { anchor?: string; d?: number; f?: number } | null | undefined, smp: { length: number }) {
  const total = smp.length || 1;
  const raw = feature && feature.anchor === 'dist'
    ? (feature.d != null ? feature.d : (feature.f || 0) * total) / total
    : (feature && feature.f) || 0;
  return Math.max(0, Math.min(1, raw));
}

export function insertHeadingTargetSamples(smp: SampledPath, fractions: readonly number[], waypointIndices: number[]) {
  if (!smp.pts.length || !fractions.length || smp.length <= 1e-9) return waypointIndices;
  let indices = waypointIndices.slice();
  const targets = fractions.map((fraction) => Math.max(0, Math.min(1, fraction)))
    .sort((a, b) => a - b);
  targets.forEach((fraction) => {
    const distance = fraction * smp.length;
    const afterIndex = smp.pts.findIndex((point) => point.s >= distance - 1e-9);
    if (afterIndex <= 0 || afterIndex >= smp.pts.length) return;
    if (Math.abs(smp.pts[afterIndex].s - distance) <= 1e-9) return;
    const before = smp.pts[afterIndex - 1], after = smp.pts[afterIndex];
    const ratio = (distance - before.s) / Math.max(1e-9, after.s - before.s);
    const crossesSegment = before.seg !== after.seg;
    smp.pts.splice(afterIndex, 0, {
      ...before,
      x: lerp(before.x, after.x, ratio),
      y: lerp(before.y, after.y, ratio),
      seg: crossesSegment ? after.seg : before.seg,
      t: crossesSegment ? after.t * ratio : lerp(before.t, after.t, ratio),
      heading: before.heading + angWrap(after.heading - before.heading) * ratio,
      curv: lerp(before.curv, after.curv, ratio),
      s: distance,
    });
    indices = indices.map((index) => index >= afterIndex ? index + 1 : index);
  });
  smp.wpIdx = indices;
  return indices;
}

export function remapWaypointRange<T extends Partial<ConstraintRange>>(range: T, oldToNew: readonly (number | null)[], removedIndex: number | undefined, newCount: number): T {
  if (!range || range.anchor !== 'wp') return range;
  const next = { ...range };
  const last = Math.max(0, newCount - 1);
  if (range.t0 != null || range.t1 != null) {
    const remapLocal = (segment: number | undefined, local: number | undefined) => {
      const authored = segment !== undefined && Number.isInteger(segment) ? segment : 0;
      const oldSegment = Math.max(0, Math.min(oldToNew.length - 2, authored));
      const oldLocal = Math.max(0, Math.min(1, local != null ? local : (authored >= oldToNew.length - 1 ? 1 : 0)));
      const a = oldToNew[oldSegment], b = oldToNew[oldSegment + 1];
      if (a == null || b == null || !Number.isInteger(a) || !Number.isInteger(b) || newCount < 2) {
        const fallback = a != null && Number.isInteger(a) ? a : Math.max(0, Math.min(last, oldSegment));
        return { segment: Math.max(0, Math.min(Math.max(0, newCount - 2), fallback)), local: oldLocal };
      }
      const position = Math.max(0, Math.min(last, a + (b - a) * oldLocal));
      const mappedSegment = Math.min(Math.max(0, newCount - 2), Math.floor(position));
      return { segment: mappedSegment, local: position >= last ? 1 : position - mappedSegment };
    };
    let start = remapLocal(range.w0, range.t0), end = remapLocal(range.w1, range.t1);
    if (start.segment + start.local > end.segment + end.local) { const swap = start; start = end; end = swap; }
    next.w0 = start.segment; next.t0 = start.local; next.w1 = end.segment; next.t1 = end.local;
    return next;
  }
  const oldStart = range.w0 !== undefined && Number.isInteger(range.w0) ? range.w0 : 0;
  const oldEnd = range.w1 !== undefined && Number.isInteger(range.w1) ? range.w1 : oldToNew.length - 1;
  const resolve = (value: number, start: boolean) => {
    const mapped = oldToNew[value];
    if (mapped != null && Number.isInteger(mapped)) return mapped;
    if (value === removedIndex) return start ? Math.min(value, last) : Math.max(0, value - 1);
    return Math.max(0, Math.min(last, value));
  };
  if (oldStart === removedIndex && oldEnd === removedIndex) {
    next.w0 = next.w1 = Math.min(removedIndex, last);
    return next;
  }
  const a = resolve(oldStart, true), b = resolve(oldEnd, false);
  next.w0 = Math.min(a, b); next.w1 = Math.max(a, b);
  return next;
}
