import { editingPoseAtTime } from '../assets/editing-planning';
import { PM } from './pathMath';

/** The field robot and hover ghost deliberately use the same displayed playback basis. */
export function displayedPoseAtTime(time, derived, doc) {
  const traced = derived.trajectorySamples?.length > 1 ? editingPoseAtTime(time, derived.trajectorySamples) : null;
  return traced || (derived.sample.pts.length > 1
    ? PM.poseAtTime(time, derived.sample.pts, derived.prof, derived.anchors, derived.mode, derived.rev)
    : doc.waypoints[0] ? { x: doc.waypoints[0].x, y: doc.waypoints[0].y,
      heading: ((doc.waypoints[0].theta || 0) + (derived.rev ? 180 : 0)) * Math.PI / 180, speed: 0 } : null);
}

/** Editing keeps its bounded/fallback converter; hover cannot invent an edge point from letterboxing. */
export function hoverWorldPoint(svg, x, y, convert) {
  try {
    const matrix = svg?.getScreenCTM()?.inverse();
    if (!matrix || ![matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].every(Number.isFinite)) return null;
    const point = convert(x, y, false);
    return Number.isFinite(point?.x) && Number.isFinite(point?.y) ? point : null;
  } catch (_) { return null; }
}

/** Keep chronological passes, retaining a chosen pass even when it lies outside the first three. */
export function hoverVisits(candidates, world, tolerance, focus) {
  const nearby = candidates.filter(candidate => candidate.distance <= tolerance);
  if (!nearby.length) return null;
  const chosen = focus?.candidates[focus.index];
  const affinity = chosen && Math.hypot(focus.anchor.x - world.x, focus.anchor.y - world.y) <= tolerance * .8
    ? nearby.reduce((best, item) => Math.abs(item.f - chosen.f) < Math.abs(best.f - chosen.f) ? item : best) : null;
  const primary = affinity && Math.abs(affinity.f - chosen.f) <= .01 ? affinity
    : nearby.reduce((best, item) => item.distance < best.distance ? item : best);
  const kept = nearby.slice(0, 3);
  if (!kept.includes(primary)) kept[kept.length - 1] = primary;
  kept.sort((a, b) => a.f - b.f);
  return { f: kept.map(item => item.f), primary: kept.indexOf(primary) };
}
