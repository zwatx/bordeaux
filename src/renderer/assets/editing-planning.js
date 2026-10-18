import { sample as sampleGeometry } from '../../shared/math/geometry';
import { buildAnchors, headingAt } from '../../shared/math/headingAnchors';
import { effectiveRanges, featureFraction } from '../../shared/math/pathRanges';

// Authored facing only. Tracking limits, heading transitions and stationary
// actions belong to the worker's timing solve, never this pending projection.
function authoredHeadings(path, waypoints, sampled, wpFrac, robot) {
  const headingMode = robot?.drive === 'tank' ? 'tangent' : path?.headingMode || 'targets';
  const modes = waypoints.slice(0, -1).map(w => robot?.drive === 'tank' ? 'tangent' : w?.segmentHeadingMode || headingMode);
  const radians = degrees => Number.isFinite(degrees) ? (degrees % 360) * Math.PI / 180 : 0;
  const manual = [], targets = [];
  waypoints.forEach((w, i) => {
    const entry = { f: wpFrac[i] || 0, rad: radians(w?.theta) };
    const endpoint = i === 0 || i === waypoints.length - 1;
    if (endpoint || (w?.thetaOn && (modes[i - 1] === 'manual' || (w.turnInPlace && modes[i] === 'manual')))) manual.push(entry);
    if (endpoint || (w?.thetaOn && (modes[i - 1] === 'targets' || (w.turnInPlace && modes[i] === 'targets')))) targets.push(entry);
  });
  (Array.isArray(path?.targets) ? path.targets : []).forEach(target => {
    if (target && Number.isFinite(target.deg)
      && (target.anchor === 'dist' ? Number.isFinite(target.d ?? target.f ?? 0) : Number.isFinite(target.f ?? 0))) {
      targets.push({ f: featureFraction(target, sampled), rad: radians(target.deg) });
    }
  });
  const manualAnchors = buildAnchors(manual), targetAnchors = buildAnchors(targets);
  let segment = 0;
  const head = sampled.pts.map((point, i) => {
    while (segment < modes.length - 1 && i >= sampled.wpIdx[segment + 1]) segment++;
    const mode = modes[segment] || headingMode;
    if (mode === 'tangent') return point.heading || 0;
    if (mode === 'lookAt') {
      const target = waypoints[segment]?.segmentLookAt;
      const dx = target?.x - point.x, dy = target?.y - point.y;
      return Number.isFinite(dx) && Number.isFinite(dy) && Math.hypot(dx, dy) > 1e-6 ? Math.atan2(dy, dx) : point.heading || 0;
    }
    return headingAt(point.s / (sampled.length || 1), mode === 'targets' ? targetAnchors : manualAnchors);
  });
  const allTangent = modes.length ? modes.every(mode => mode === 'tangent') : headingMode === 'tangent';
  const mode = allTangent ? 'tank' : 'swerve';
  return { head, mode, headingMode, anchors: mode === 'tank' ? [] : buildAnchors(sampled.pts.map((point, i) => ({ f: point.s / (sampled.length || 1), rad: head[i] }))) };
}

/** Geometry only: never invoke a timing solve or stationary-action loop on the UI thread. */
export function editingGeometry(path, perSegment = 14, robot = null) {
  const waypoints = Array.isArray(path?.waypoints) ? path.waypoints : [];
  let sampled;
  try {
    if (waypoints.length < 2 || !Number.isInteger(perSegment) || perSegment < 1 || (waypoints.length - 1) * perSegment + 1 > 2000
      || !waypoints.every(w => [w?.x, w?.y, w?.prevC?.x, w?.prevC?.y, w?.nextC?.x, w?.nextC?.y].every(Number.isFinite))) throw new Error('Use waypoint geometry');
    sampled = sampleGeometry(waypoints, perSegment, true);
    if (!sampled.pts.every(p => [p.x, p.y, p.s].every(Number.isFinite))) throw new Error('Use waypoint geometry');
  } catch {
    let length = 0;
    const pts = [], wpIdx = [];
    waypoints.forEach((w, i) => {
      if (Number.isFinite(w?.x) && Number.isFinite(w?.y)) {
        const previous = pts.at(-1);
        const dx = previous ? w.x - previous.x : 0, dy = previous ? w.y - previous.y : 0;
        const nextLength = length + Math.hypot(dx, dy);
        if (Number.isFinite(nextLength)) length = nextLength;
        pts.push({ x: w.x, y: w.y, s: length, heading: Math.atan2(dy, dx), curv: 0, seg: Math.max(0, i - 1), t: 1 });
      }
      wpIdx.push(Math.max(0, pts.length - 1));
    });
    if (pts.length > 1) pts[0].heading = pts[1].heading;
    sampled = { pts, length, segs: Math.max(0, waypoints.length - 1), wpIdx };
  }
  const pts = sampled.pts, zero = pts.map(() => 0);
  const wpIdx = sampled.wpIdx || [];
  const wpFrac = wpIdx.map(i => (pts[i]?.s || 0) / (sampled.length || 1));
  const { head, anchors, mode, headingMode } = authoredHeadings(path, waypoints, sampled, wpFrac, robot);
  // Keep authored indices even for malformed records, so selection/deletion
  // still addresses the same range. Invalid positions draw at the fallback.
  const ranges = (Array.isArray(path?.ranges) ? path.ranges : []).map(range => {
    const safe = { ...range };
    for (const key of ['f0', 'f1', 'd0', 'd1', 'w0', 'w1', 't0', 't1']) if (!Number.isFinite(safe[key])) delete safe[key];
    return safe;
  });
  const effRanges = effectiveRanges({ waypoints, ranges }, sampled);
  return {
    sample: sampled, wpIdx, wpFrac,
    prof: { t: zero, v: zero, head, totalTime: 0, holds: [], turns: [], jiggles: [] },
    metrics: { head, v: zero, accel: zero, omega: zero, curv: pts.map(p => p.curv || 0), vMax: 0.1, aMax: 0.1, wMax: 0.01, kMax: 0 },
    anchors, mode, effRanges, headingMode,
    rev: Boolean(path?.driveBackward), totalDistance: sampled.length, markers: [], checks: [], planner: 'profiledSpline',
  };
}

/** Project arrival/departure timing for field colors; playback uses the full trace below. */
export function projectEditingTiming(geometry, bestEffort, issues = []) {
  const samples = bestEffort?.samples;
  const checks = issues.map(issue => ({ ...issue, f: issue.f0, seg: issue.segment, kind: issue.code, level: issue.severity, text: issue.message }));
  if (!samples?.length) return { ...geometry, checks };
  const arrivals = [];
  for (const point of samples) {
    const previous = arrivals.at(-1);
    if (!previous || point.f > previous.arrival.f + 1e-9) arrivals.push({ arrival: point, departure: point });
    else previous.departure = point;
  }
  let index = 0;
  const projected = geometry.sample.pts.map(point => {
    const f = point.s / (geometry.sample.length || 1);
    while (index + 1 < arrivals.length && arrivals[index + 1].arrival.f < f - 1e-9) index++;
    const a = Math.abs(f - arrivals[index].arrival.f) <= 1e-9 ? arrivals[index].arrival : arrivals[index].departure;
    const b = arrivals[Math.min(index + 1, arrivals.length - 1)].arrival;
    const u = Math.max(0, Math.min(1, (f - a.f) / Math.max(1e-9, b.f - a.f)));
    const mix = (x, y) => x + (y - x) * u;
    return { t: mix(a.t, b.t), v: mix(a.velocityMps, b.velocityMps), head: a.headingRad + Math.atan2(Math.sin(b.headingRad - a.headingRad), Math.cos(b.headingRad - a.headingRad)) * u - (geometry.rev ? Math.PI : 0) };
  });
  const t = projected.map(p => p.t), v = projected.map(p => p.v), head = projected.map(p => p.head);
  return { ...geometry, checks, trajectorySamples: samples,
    prof: { ...geometry.prof, t, v, head, totalTime: bestEffort.totalTimeS },
    metrics: { ...geometry.metrics, v, head, vMax: v.reduce((max, value) => Math.max(max, Math.abs(value)), 0.1) } };
}

/**
 * What a pointer edit shows for `path`. A result solved for this exact draft is the release value
 * itself. Until the worker solves it, the live draft geometry is timed by the newest solved trace from
 * the same planner, projected by path fraction, so the edited point never trails the pointer.
 */
export function liveEditingPreview(path, robot, solvedPath, solved) {
  if (solvedPath === path) return solved;
  const geometry = editingGeometry(path, 14, robot), checks = solved?.checks || [];
  const trace = solved?.trajectorySamples?.length > 1 ? solved.trajectorySamples : solved?.finalTrajectory?.samples;
  if (!(trace?.length > 1)) return { ...geometry, checks };
  // Map each live point to the solved fraction within its waypoint segment, keeping stops on their waypoints.
  const from = solved.wpFrac, to = geometry.wpFrac, length = geometry.sample.length || 1;
  const pinned = from?.length === to.length && to.every((f, i) => !i || (f > to[i - 1] && from[i] > from[i - 1]));
  let segment = 0, j = 0;
  const t = [], v = [];
  for (const point of geometry.sample.pts) {
    let f = point.s / length;
    if (pinned) {
      while (segment < to.length - 2 && f > to[segment + 1]) segment++;
      f = from[segment] + (from[segment + 1] - from[segment]) * Math.min(1, Math.max(0, (f - to[segment]) / (to[segment + 1] - to[segment])));
    }
    while (j < trace.length - 2 && trace[j + 1].f < f) j++;
    const a = trace[j], b = trace[j + 1], u = Math.min(1, Math.max(0, (f - a.f) / Math.max(1e-9, b.f - a.f)));
    t.push(a.t + (b.t - a.t) * u);
    v.push(a.velocityMps + (b.velocityMps - a.velocityMps) * u);
  }
  const totalTime = Math.max(solved.prof?.totalTime || 0, trace[trace.length - 1].t);
  return { ...geometry, checks, trajectorySamples: trace,
    prof: { ...geometry.prof, t, v, totalTime },
    metrics: { ...geometry.metrics, v, vMax: Math.max(0.1, ...v) } };
}

/** Exact shared trace, including stopped holds, rotations and jiggle excursions. */
export function editingPoseAtTime(time, samples) {
  if (!samples?.length) return null;
  let lo = 0, hi = samples.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (samples[mid].t < time) lo = mid + 1; else hi = mid; }
  const b = samples[lo], a = samples[Math.max(0, lo - 1)];
  const u = Math.max(0, Math.min(1, (time - a.t) / Math.max(1e-9, b.t - a.t)));
  const mix = (x, y) => x + (y - x) * u;
  return { x: mix(a.x, b.x), y: mix(a.y, b.y), heading: a.headingRad + Math.atan2(Math.sin(b.headingRad - a.headingRad), Math.cos(b.headingRad - a.headingRad)) * u,
    v: mix(a.velocityMps, b.velocityMps) };
}
