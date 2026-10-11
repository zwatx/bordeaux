// Prototype adapter: geometry is immediate; every timing value comes from planPath.
import { sample } from "../../../src/shared/math/geometry";

export function editorGeometry(path) {
  try {
    const geometry = sample(path.waypoints, 14, true);
    const wpIdx = geometry.wpIdx || [];
    return {
      sample: geometry, wpIdx,
      wpFrac: wpIdx.map((i) => geometry.length ? geometry.pts[i].s / geometry.length : 0),
      metrics: { v: [] }, checks: [],
    };
  } catch {
    return { sample: { pts: [], length: 0 }, wpIdx: [], wpFrac: [], metrics: { v: [] }, checks: [] };
  }
}

export function withTiming(geometry, result) {
  const samples = result?.bestEffort?.samples;
  if (!samples?.length) return geometry;
  // Project arrival times onto editing geometry; preserve the full trace for playback.
  const arrivals = [];
  for (const point of samples) {
    if (!arrivals.length || point.f > arrivals.at(-1).arrival.f + 1e-9) {
      arrivals.push({ arrival: point, departure: point });
    } else {
      arrivals.at(-1).departure = point;
    }
  }
  let index = 0;
  const projected = geometry.sample.pts.map((point) => {
    const f = geometry.sample.length ? point.s / geometry.sample.length : 0;
    while (index + 1 < arrivals.length && arrivals[index + 1].arrival.f < f) index++;
    // A waypoint is reached before its hold; movement after it starts at departure.
    const a = Math.abs(f - arrivals[index].arrival.f) <= 1e-9
      ? arrivals[index].arrival : arrivals[index].departure;
    const b = arrivals[Math.min(index + 1, arrivals.length - 1)].arrival;
    const u = Math.max(0, Math.min(1, (f - a.f) / Math.max(1e-9, b.f - a.f)));
    return { t: a.t + (b.t - a.t) * u, v: a.velocityMps + (b.velocityMps - a.velocityMps) * u };
  });
  const holds = (result.trajectory?.stationaryActions || []).filter((a) => a.kind === "wait").map((action) => ({
    idx: geometry.wpIdx[action.waypointIndex], t0: action.startTimeS, t1: action.endTimeS,
  }));
  return {
    ...geometry, trajectorySamples: samples,
    prof: { t: projected.map((p) => p.t), v: projected.map((p) => p.v), totalTime: result.bestEffort.totalTimeS, holds },
    metrics: { v: projected.map((p) => p.v) },
  };
}

/** Replay the exact shared timing, including holds and turns; no second physics model. */
export function poseOnTiming(samples, time) {
  if (!samples?.length) return null;
  let lo = 0, hi = samples.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (samples[mid].t < time) lo = mid + 1; else hi = mid; }
  const b = samples[lo], a = samples[Math.max(0, lo - 1)];
  const u = Math.max(0, Math.min(1, (time - a.t) / Math.max(1e-9, b.t - a.t)));
  const mix = (x, y) => x + (y - x) * u;
  const delta = Math.atan2(Math.sin(b.headingRad - a.headingRad), Math.cos(b.headingRad - a.headingRad));
  return { x: mix(a.x, b.x), y: mix(a.y, b.y), heading: a.headingRad + delta * u, speed: mix(a.velocityMps, b.velocityMps) };
}
