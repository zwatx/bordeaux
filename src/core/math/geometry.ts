import { wrapRadians } from "./angles";
import type { ControlPoint, Waypoint } from "../types";

export interface GeometryPoint extends ControlPoint {
  seg: number;
  t: number;
  heading: number;
  curv: number;
  s: number;
}

export interface SampledPath {
  pts: GeometryPoint[];
  length: number;
  segs: number;
  wpIdx?: number[];
}

interface QuinticCurve { x: number[]; y: number[] }

// ---- geometry helpers ----
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function bez(p0: ControlPoint, c0: ControlPoint, c1: ControlPoint, p1: ControlPoint, t: number) {
  const u = 1 - t, tt = t * t, uu = u * u;
  const a = uu * u, b = 3 * uu * t, c = 3 * u * tt, d = tt * t;
  return { x: a * p0.x + b * c0.x + c * c1.x + d * p1.x, y: a * p0.y + b * c0.y + c * c1.y + d * p1.y };
}

export function bezD(p0: ControlPoint, c0: ControlPoint, c1: ControlPoint, p1: ControlPoint, t: number) {
  const u = 1 - t;
  const a = 3 * u * u, b = 6 * u * t, c = 3 * t * t;
  return { x: a * (c0.x - p0.x) + b * (c1.x - c0.x) + c * (p1.x - c1.x), y: a * (c0.y - p0.y) + b * (c1.y - c0.y) + c * (p1.y - c1.y) };
}

function bezDD(p0: ControlPoint, c0: ControlPoint, c1: ControlPoint, p1: ControlPoint, t: number) {
  const u = 1 - t;
  return { x: 6 * u * (c1.x - 2 * c0.x + p0.x) + 6 * t * (p1.x - 2 * c1.x + c0.x), y: 6 * u * (c1.y - 2 * c0.y + p0.y) + 6 * t * (p1.y - 2 * c1.y + c0.y) };
}

function signedCurvature(d: ControlPoint, dd: ControlPoint) {
  const speed2 = d.x * d.x + d.y * d.y;
  return speed2 > 1e-9 ? (d.x * dd.y - d.y * dd.x) / Math.pow(speed2, 1.5) : 0;
}

function accelerationAtCurvature(d: ControlPoint, dd: ControlPoint, curvature: number) {
  const speed = Math.hypot(d.x, d.y);
  if (speed < 1e-6) return dd;
  const tx = d.x / speed, ty = d.y / speed;
  const tangentAcceleration = dd.x * tx + dd.y * ty;
  const normalAcceleration = curvature * speed * speed;
  return {
    x: tx * tangentAcceleration - ty * normalAcceleration,
    y: ty * tangentAcceleration + tx * normalAcceleration,
  };
}

function quinticHermite(p0: ControlPoint, d0: ControlPoint, dd0: ControlPoint, p1: ControlPoint, d1: ControlPoint, dd1: ControlPoint): QuinticCurve {
  const coefficients = (start: number, startD: number, startDD: number, end: number, endD: number, endDD: number) => {
    const delta = end - start;
    return [
      start,
      startD,
      startDD / 2,
      10 * delta - 6 * startD - 4 * endD - 1.5 * startDD + 0.5 * endDD,
      -15 * delta + 8 * startD + 7 * endD + 1.5 * startDD - endDD,
      6 * delta - 3 * startD - 3 * endD - 0.5 * startDD + 0.5 * endDD,
    ];
  };
  return {
    x: coefficients(p0.x, d0.x, dd0.x, p1.x, d1.x, dd1.x),
    y: coefficients(p0.y, d0.y, dd0.y, p1.y, d1.y, dd1.y),
  };
}

function evalQuintic(curve: QuinticCurve, t: number) {
  const evaluate = (c: number[]) => {
    const t2 = t * t, t3 = t2 * t, t4 = t3 * t, t5 = t4 * t;
    return {
      value: c[0] + c[1] * t + c[2] * t2 + c[3] * t3 + c[4] * t4 + c[5] * t5,
      derivative: c[1] + 2 * c[2] * t + 3 * c[3] * t2 + 4 * c[4] * t3 + 5 * c[5] * t4,
      secondDerivative: 2 * c[2] + 6 * c[3] * t + 12 * c[4] * t2 + 20 * c[5] * t3,
    };
  };
  const x = evaluate(curve.x), y = evaluate(curve.y);
  return {
    pos: { x: x.value, y: y.value },
    derivative: { x: x.derivative, y: y.derivative },
    secondDerivative: { x: x.secondDerivative, y: y.secondDerivative },
  };
}

// shortest signed angle difference (radians)
export const angWrap = wrapRadians;

export function angLerp(a: number, b: number, t: number) { return a + angWrap(b - a) * t; }

export const D2R = Math.PI / 180, R2D = 180 / Math.PI;

// ---- arc primitive: circle tangent to the start handle, through the endpoint ----
function arcSetup(p0: ControlPoint, p1: ControlPoint, c0: ControlPoint) {
  let tx = c0.x - p0.x, ty = c0.y - p0.y; let tl = Math.hypot(tx, ty);
  if (tl < 1e-6) { tx = p1.x - p0.x; ty = p1.y - p0.y; tl = Math.hypot(tx, ty); }
  if (tl < 1e-6) return null;
  tx /= tl; ty /= tl; const nx = -ty, ny = tx;
  const dx = p1.x - p0.x, dy = p1.y - p0.y; const denom = 2 * (dx * nx + dy * ny);
  if (Math.abs(denom) < 1e-3) return null; // effectively straight
  const R = (dx * dx + dy * dy) / denom;
  const Cx = p0.x + R * nx, Cy = p0.y + R * ny, rad = Math.abs(R);
  const a0 = Math.atan2(p0.y - Cy, p0.x - Cx), a1 = Math.atan2(p1.y - Cy, p1.x - Cx);
  let sweep = a1 - a0;
  if (R > 0) { while (sweep <= 1e-6) sweep += 2 * Math.PI; while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI; }
  else { while (sweep >= -1e-6) sweep -= 2 * Math.PI; while (sweep < -2 * Math.PI) sweep += 2 * Math.PI; }
  if (rad > 1e4) return null;
  return { Cx, Cy, rad, a0, sweep };
}

// ---- clothoid (Euler spiral): G1 Hermite fit, linearly-varying curvature ----
// single-clothoid from pose (p0,th0) to (p1,th1); returns dense table or null
function clothoidTable(p0: ControlPoint, p1: ControlPoint, th0: number, th1: number, M: number) {
  const dx = p1.x - p0.x, dy = p1.y - p0.y; const r = Math.hypot(dx, dy);
  if (r < 1e-6) return null;
  const tau = Math.atan2(dy, dx);
  const ph0 = angWrap(th0 - tau), ph1 = angWrap(th1 - tau);
  const dphi = ph1 - ph0;
  const Hsin = (b: number) => { let s = 0; const N = 24; for (let k = 0; k <= N; k++) { const t = k / N; const th = ph0 + (dphi - b) * t + b * t * t; const w = (k === 0 || k === N) ? 1 : (k % 2 ? 4 : 2); s += w * Math.sin(th); } return s / (3 * N); };
  const Hcos = (b: number) => { let s = 0; const N = 24; for (let k = 0; k <= N; k++) { const t = k / N; const th = ph0 + (dphi - b) * t + b * t * t; const w = (k === 0 || k === N) ? 1 : (k % 2 ? 4 : 2); s += w * Math.cos(th); } return s / (3 * N); };
  // root of Hsin(b)=0 with the smallest |b| (closest to a gentle spiral)
  let best: number | null = null; const lo = -6 * Math.PI, hi = 6 * Math.PI, STEPS = 240; let pb = lo, pf = Hsin(lo);
  for (let k = 1; k <= STEPS; k++) {
    const b = lo + (hi - lo) * k / STEPS, f = Hsin(b);
    if (pf * f < 0) { let a = pb, bb = b, fa = pf; for (let it = 0; it < 44; it++) { const m = (a + bb) / 2, fm = Hsin(m); if (fa * fm <= 0) bb = m; else { a = m; fa = fm; } } const root = (a + bb) / 2; if (best === null || Math.abs(root) < Math.abs(best)) best = root; }
    pb = b; pf = f;
  }
  if (best === null) return null;
  const b = best, denom = Hcos(b); if (denom <= 1e-3) return null; // path would double back
  const L = r / denom; if (!isFinite(L) || L <= 0 || L > r * 30) return null;
  const thAbs = (t: number) => tau + ph0 + (dphi - b) * t + b * t * t;
  const xs = new Array<number>(M + 1), ys = new Array<number>(M + 1), hs = new Array<number>(M + 1), ks = new Array<number>(M + 1);
  xs[0] = p0.x; ys[0] = p0.y; hs[0] = thAbs(0); ks[0] = (dphi - b) / L;
  let cx = 0, cy = 0; const dt = 1 / M;
  for (let m = 1; m <= M; m++) { const tm = (m - 0.5) / M; const a = thAbs(tm); cx += Math.cos(a) * L * dt; cy += Math.sin(a) * L * dt; const t = m / M; xs[m] = p0.x + cx; ys[m] = p0.y + cy; hs[m] = thAbs(t); ks[m] = ((dphi - b) + 2 * b * t) / L; }
  return { xs, ys, hs, ks };
}

// ---- sample the whole path into dense points with arclength + curvature ----
// waypoints: [{x,y, prevC, nextC, segType?}]  segType: bezier | line | arc | clothoid
export function sample(waypoints: readonly Waypoint[], perSeg = 60, trackWaypointIndices = false): SampledPath {
  const pts: GeometryPoint[] = [];
  const segs = waypoints.length - 1;
  if (segs < 1) return trackWaypointIndices ? { pts: [], length: 0, segs: 0, wpIdx: [] } : { pts: [], length: 0, segs: 0 };
  const steps = perSeg;

  const segTypeAt = (i: number) => (waypoints[i] && waypoints[i].segType) || 'bezier';
  const pointOf = (w: ControlPoint) => ({ x: w.x, y: w.y });
  const chordHeading = (a: ControlPoint, b: ControlPoint) => Math.atan2(b.y - a.y, b.x - a.x);
  const outHeading = (i: number) => {
    const w0 = waypoints[i], w1 = waypoints[i + 1];
    const p0 = pointOf(w0), p1 = pointOf(w1), c0 = w0.nextC || p1;
    return Math.hypot(c0.x - p0.x, c0.y - p0.y) > 1e-6 ? Math.atan2(c0.y - p0.y, c0.x - p0.x) : chordHeading(p0, p1);
  };
  const inHeading = (i: number) => {
    const w0 = waypoints[i - 1], w1 = waypoints[i];
    const p0 = pointOf(w0), p1 = pointOf(w1), c1 = w1.prevC || p0;
    return Math.hypot(p1.x - c1.x, p1.y - c1.y) > 1e-6 ? Math.atan2(p1.y - c1.y, p1.x - c1.x) : chordHeading(p0, p1);
  };
  const blendedJointHeading = (i: number) => {
    const prevIsClothoid = i > 0 && segTypeAt(i - 1) === 'clothoid';
    const nextIsClothoid = i < segs && segTypeAt(i) === 'clothoid';
    if (prevIsClothoid && nextIsClothoid) {
      const a = inHeading(i), b = outHeading(i);
      return a + 0.5 * angWrap(b - a);
    }
    if (prevIsClothoid) return inHeading(i);
    if (nextIsClothoid) return outHeading(i);
    return 0;
  };
  const jointHeading = waypoints.map((_, i) => blendedJointHeading(i));
  const clothoidSegments = new Set<number>();
  const wpIdx = [0];
  // Collinear cubic handles provide only tangent (G1) continuity. A drivetrain
  // path also needs curvature continuity: otherwise the waypoint itself becomes
  // a one-sample lateral-acceleration limit and creates a fake velocity notch.
  // Matching the mean signed curvature with a quintic Hermite lift preserves
  // every waypoint and authored tangent while leaving ordinary cubics unchanged.
  const smoothJointCurvature = new Map<number, number>();
  for (let i = 1; i < segs; i++) {
    const waypoint = waypoints[i];
    if (!waypoint.linked || waypoint.stop || waypoint.corner
      || segTypeAt(i - 1) !== 'bezier' || segTypeAt(i) !== 'bezier') continue;
    const previous = waypoints[i - 1], next = waypoints[i + 1];
    const point = pointOf(waypoint);
    const incomingD = bezD(pointOf(previous), previous.nextC, waypoint.prevC, point, 1);
    const incomingDD = bezDD(pointOf(previous), previous.nextC, waypoint.prevC, point, 1);
    const outgoingD = bezD(point, waypoint.nextC, next.prevC, pointOf(next), 0);
    const outgoingDD = bezDD(point, waypoint.nextC, next.prevC, pointOf(next), 0);
    if (Math.hypot(incomingD.x, incomingD.y) < 1e-6 || Math.hypot(outgoingD.x, outgoingD.y) < 1e-6) continue;
    smoothJointCurvature.set(i, 0.5 * (
      signedCurvature(incomingD, incomingDD) + signedCurvature(outgoingD, outgoingDD)
    ));
  }

  for (let i = 0; i < segs; i++) {
    const w0 = waypoints[i], w1 = waypoints[i + 1];
    const p0 = { x: w0.x, y: w0.y }, p1 = { x: w1.x, y: w1.y };
    const c0 = w0.nextC, c1 = w1.prevC;
    let type = w0.segType || 'bezier';
    let arc: ReturnType<typeof arcSetup> = null, cloth: ReturnType<typeof clothoidTable> = null, effType = type;
    if (type === 'arc') { arc = arcSetup(p0, p1, c0); if (!arc) effType = 'line'; }
    else if (type === 'clothoid') {
      const th0 = (i > 0 && segTypeAt(i - 1) === 'clothoid') ? jointHeading[i] : outHeading(i);
      const th1 = (i + 1 < segs && segTypeAt(i + 1) === 'clothoid') ? jointHeading[i + 1] : inHeading(i + 1);
      cloth = clothoidTable(p0, p1, th0, th1, steps); if (!cloth) effType = 'bezier';
    }
    if (effType === 'clothoid') clothoidSegments.add(i);
    let smoothBezier: QuinticCurve | null = null;
    if (effType === 'bezier' && (smoothJointCurvature.has(i) || smoothJointCurvature.has(i + 1))) {
      const d0 = bezD(p0, c0, c1, p1, 0), d1 = bezD(p0, c0, c1, p1, 1);
      let dd0 = bezDD(p0, c0, c1, p1, 0), dd1 = bezDD(p0, c0, c1, p1, 1);
      const startCurvature = smoothJointCurvature.get(i);
      if (startCurvature !== undefined) dd0 = accelerationAtCurvature(d0, dd0, startCurvature);
      const endCurvature = smoothJointCurvature.get(i + 1);
      if (endCurvature !== undefined) dd1 = accelerationAtCurvature(d1, dd1, endCurvature);
      smoothBezier = quinticHermite(p0, d0, dd0, p1, d1, dd1);
    }
    for (let k = 0; k <= steps; k++) {
      if (i > 0 && k === 0) continue; // avoid dup at seg joints
      const t = k / steps;
      let pos, head, curv;
      if (effType === 'line') {
        pos = { x: lerp(p0.x, p1.x, t), y: lerp(p0.y, p1.y, t) };
        head = Math.atan2(p1.y - p0.y, p1.x - p0.x); curv = 0;
      } else if (effType === 'arc' && arc) {
        const ang = arc.a0 + arc.sweep * t;
        pos = { x: arc.Cx + arc.rad * Math.cos(ang), y: arc.Cy + arc.rad * Math.sin(ang) };
        head = ang + (arc.sweep >= 0 ? Math.PI / 2 : -Math.PI / 2);
        curv = arc.rad > 1e-6 ? 1 / arc.rad : 0;
      } else if (effType === 'clothoid' && cloth) {
        // Numerical integration may drift; authored segment endpoints remain exact.
        pos = k === steps ? p1 : { x: cloth.xs[k], y: cloth.ys[k] }; head = cloth.hs[k]; curv = Math.abs(cloth.ks[k]);
      } else {
        const smooth = smoothBezier ? evalQuintic(smoothBezier, t) : null;
        pos = smooth ? smooth.pos : bez(p0, c0, c1, p1, t);
        const d = smooth ? smooth.derivative : bezD(p0, c0, c1, p1, t);
        const dd = smooth ? smooth.secondDerivative : bezDD(p0, c0, c1, p1, t);
        const speed2 = d.x * d.x + d.y * d.y, cross = d.x * dd.y - d.y * dd.x;
        head = Math.atan2(d.y, d.x); curv = speed2 > 1e-9 ? Math.abs(cross) / Math.pow(speed2, 1.5) : 0;
      }
      pts.push({ x: pos.x, y: pos.y, seg: i, t, heading: head, curv, s: 0 });
    }
    wpIdx.push(pts.length - 1);
  }

  // Blend curvature across adjacent clothoid joints. Position/heading already use a shared
  // tangent; this removes artificial velocity dips from independent curvature estimates.
  for (let j = 1; j < segs; j++) {
    if (!clothoidSegments.has(j - 1) || !clothoidSegments.has(j)) continue;
    const center = trackWaypointIndices ? wpIdx[j] : pts.findIndex((p) => p.seg === j - 1 && p.t > 1 - 1e-9);
    if (center < 0) continue;
    const next = Math.min(pts.length - 1, center + 1);
    const jointK = 0.5 * ((pts[center].curv || 0) + (pts[next].curv || 0));
    const span = Math.max(2, Math.round(steps * 0.16));
    for (let off = -span; off <= span; off++) {
      const idx = center + off;
      if (idx < 0 || idx >= pts.length) continue;
      if (!clothoidSegments.has(pts[idx].seg)) continue;
      const u = 1 - Math.min(1, Math.abs(off) / span);
      const w = u * u * (3 - 2 * u);
      pts[idx].curv = lerp(pts[idx].curv || 0, jointK, w);
    }
  }

  // arclength
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y;
    s += Math.hypot(dx, dy);
    pts[i].s = s;
  }
  return trackWaypointIndices ? { pts, length: s, segs, wpIdx } : { pts, length: s, segs };
}

// point + fraction lookup by arclength fraction f (for placing markers/targets)
export function pointAtFraction(f: number, pts: readonly Pick<GeometryPoint, "x" | "y" | "heading" | "s">[]) {
  const n = pts.length; if (!n) return { x: 0, y: 0, heading: 0 };
  const target = f * pts[n - 1].s;
  let lo = 1, hi = n - 1;
  if (target <= 0) return { ...pts[0] };
  if (target >= pts[n - 1].s) return { ...pts[n - 1] };
  while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid].s < target) lo = mid + 1; else hi = mid; }
  const a = pts[lo - 1], b = pts[lo];
  const u = (target - a.s) / Math.max(1e-6, b.s - a.s);
  return { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), heading: angLerp(a.heading, b.heading, u) };
}

// nearest fraction on path to a world point (for placing markers by click)
export function nearestFraction(wx: number, wy: number, pts: readonly Pick<GeometryPoint, "x" | "y" | "s">[]) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const dx = pts[i].x - wx, dy = pts[i].y - wy; const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  }
  return pts.length > 1 ? pts[best].s / pts[pts.length - 1].s : 0;
}

// auto control handles for a fresh waypoint (smooth Catmull-Rom-ish)
export function autoHandles(waypoints: readonly ControlPoint[], i: number) {
  const w = waypoints[i];
  const prev = waypoints[i - 1] || w, next = waypoints[i + 1] || w;
  let dx = next.x - prev.x, dy = next.y - prev.y;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len; dy /= len;
  const handle = Math.max(0.6, len * 0.28);
  return {
    prevC: { x: w.x - dx * handle, y: w.y - dy * handle },
    nextC: { x: w.x + dx * handle, y: w.y + dy * handle },
  };
}

// Path type belongs to the SEGMENT between two waypoints. The list stays honest:
// only true geometry types live here, grouped Basic / Spline. Snapping, heading-hold,
// approach and auto-smooth are tooling/constraint behaviours and live elsewhere.
export const SEGTYPES = [
  { id: 'line', label: 'Straight', abbr: 'LIN', group: 'Basic', hint: 'Straight line \u2014 control handles ignored.' },
  { id: 'arc', label: 'Arc', abbr: 'ARC', group: 'Basic', hint: 'Constant-radius turn, tangent to the out-handle.' },
  { id: 'bezier', label: 'B\u00e9zier', abbr: 'BEZ', group: 'Spline', hint: 'Hand-shaped spline driven by the control handles.' },
  { id: 'clothoid', label: 'Clothoid', abbr: 'CLO', group: 'Spline', hint: 'Euler spiral \u2014 curvature ramps smoothly (swerve-friendly).' },
];
