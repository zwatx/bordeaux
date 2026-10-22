import { indexIntervalPolicies } from "../planners/intervalPolicies";
import { stationaryTurnDelta } from "./angles";
import { DEFAULT_SAMPLES_PER_SEGMENT } from "../planners/limits";
import type { ConstraintRange, ControlPoint, DriveType, PathConstraints, PathDoc, RobotConfig, TurnInPlace } from "../types";
import type { GeometryPoint } from "./geometry";
import type { HeadingAnchor } from "./headingAnchors";
import type { HeadingTransitionWindow } from "../planners/headingTransitions";
import { lerp, bez, bezD, angWrap, angLerp, D2R, R2D, sample, pointAtFraction, nearestFraction, autoHandles, SEGTYPES } from "./geometry";
import { headingAt, buildAnchors } from "./headingAnchors";
import { waypointHeadingSemantics } from "./waypointHeading";
import { waypointFracs, effectiveRanges, featureFraction, insertHeadingTargetSamples, remapWaypointRange } from "./pathRanges";
import { metricColor, metricGradient, METRICS } from "./metricDisplay";
import { headingTransitionWindows, headingTransitionGoals, smoothHeadingTransitions } from "../planners/headingTransitions";

type ProfileConstraints = Omit<PathConstraints, "maxDecel"> & { maxDecel?: number };
interface ProfileTurn {
  idx: number;
  start: number;
  end: number;
  direction?: TurnInPlace["direction"];
  maxAngVel?: number;
  maxAngAccel?: number;
  maxAngJerk?: number;
}
interface ProfileOptions {
  vmax?: number;
  stopIdx?: readonly number[];
  ranges?: readonly ConstraintRange[];
  headingTransitions?: readonly HeadingTransitionWindow[];
  heading?: readonly number[];
  turns?: readonly ProfileTurn[];
  dwell?: readonly { idx: number; wait: number }[];
}
interface TimedHold { idx: number; t0: number; t1: number }
interface TimedTurn extends TimedHold { start: number; delta: number }
interface VelocityProfile {
  v: number[];
  t: number[];
  totalTime: number;
  holds: TimedHold[];
  turns?: TimedTurn[];
  rotLimited: number[];
}
interface PathWarning {
  f: number;
  kind: "curv" | "vel" | "rot" | "angaccel" | "lookAt";
  sev: "high" | "med";
  text: string;
  seg?: number;
  fixes?: { id: string; label: string }[];
}

// ---- trapezoidal velocity profile with curvature (centripetal) limit ----
// constraints: {maxVel, maxAccel, maxAngVel, maxAngAccel}, start/end vel
function profile(pts: readonly Pick<GeometryPoint, "s" | "curv">[], c: ProfileConstraints, startV = 0, endV = 0, opts: ProfileOptions = {}): VelocityProfile {
  const n = pts.length;
  if (n < 2) return { v: [], t: [], totalTime: 0, holds: [], rotLimited: [] };
  const vmax = opts.vmax != null ? Math.min(c.maxVel, opts.vmax) : c.maxVel;
  const stopSet = new Set(opts.stopIdx || []);
  const v = new Array<number>(n).fill(vmax);
  // curvature cap: v <= sqrt(aLat / k)
  const aLat = Math.max(0.1, c.maxCentripetalAccel ?? c.maxAccel);
  for (let i = 0; i < n; i++) {
    const k = pts[i].curv;
    if (k > 1e-4) v[i] = Math.min(v[i], Math.sqrt(aLat / k));
  }
  v[0] = Math.min(v[0], startV);
  v[n - 1] = Math.min(v[n - 1], endV);
  // hard stops: velocity pinned to 0
  stopSet.forEach(idx => { if (idx >= 0 && idx < n) v[idx] = 0; });
    // Per-interval limits, tightened by any overlapping constraint range (tightest wins).
    const ranges = opts.ranges || [];
    const totalS = pts[n - 1].s || 1;
    const accelG = Math.max(0.1, c.maxAccel);
    const decelG = (c.maxDecel != null && c.maxDecel > 0) ? c.maxDecel : accelG;
    const aFwd = new Array(n).fill(accelG), aBack = new Array(n).fill(decelG);
    const rangeAngV = new Array(n).fill(Infinity), rangeAngA = new Array(n).fill(Infinity);
    // Index i describes the interval (i - 1, i). Evaluating overlap instead of
    // requiring both endpoints to be inside a policy preserves very short
    // transition windows that fall between geometry samples.
    const headingTransitions = opts.headingTransitions || [];
    const intervalPolicies = indexIntervalPolicies(
      pts.map((point) => point.s / totalS),
      ranges.map((range) => ({ ...range, start: Math.min(range.f0, range.f1), end: Math.max(range.f0, range.f1) })),
      headingTransitions,
    );
    const translationPriority = intervalPolicies.translationPriority;
    for (let i = 1; i < n; i++) {
      const rv = intervalPolicies.maxVel[i], ra = intervalPolicies.maxAccel[i], rd = intervalPolicies.maxDecel[i];
      const rw = intervalPolicies.maxAngVel[i], rwa = intervalPolicies.maxAngAccel[i];
      if (rv < Infinity) { v[i - 1] = Math.min(v[i - 1], rv); v[i] = Math.min(v[i], rv); }
      if (ra < Infinity) aFwd[i] = Math.min(accelG, ra);
      if (rd < Infinity) aBack[i - 1] = Math.min(decelG, rd);
      if (rw < Infinity) rangeAngV[i] = rw * Math.PI / 180;
      if (rwa < Infinity) rangeAngA[i] = rwa * Math.PI / 180;
    }
  // ---- rotational limit: cap v so the commanded heading can actually be tracked ----
  // omega = (dtheta/ds) * v ; enforce |omega| <= Wmax and |d omega/dt| <= Aang (memo §16)
  const rotLimited = new Array<number>(n).fill(0);
  const head = opts.heading;
  const Wmax = (c.maxAngVel || 0) * Math.PI / 180;
  const Aang = (c.maxAngAccel || 0) * Math.PI / 180;
  const AangDecel = (c.maxAngDecel || c.maxAngAccel || 0) * Math.PI / 180;
  if (head && head.length === n && Wmax > 1e-4) {
    const g = new Array<number>(n).fill(0), dth = new Array<number>(n).fill(0);
    for (let i = 1; i < n; i++) { const ds = pts[i].s - pts[i - 1].s; const dd = angWrap(head[i] - head[i - 1]); dth[i] = Math.abs(dd); g[i] = ds > 1e-6 ? dd / ds : 0; }
    g[0] = g[1] || 0;
    const w = new Array<number>(n);
    for (let i = 0; i < n; i++) w[i] = Math.min(Wmax, rangeAngV[i]);
    stopSet.forEach(idx => { if (idx >= 0 && idx < n) w[idx] = 0; });
    if (Aang > 1e-4) {
      for (let i = 1; i < n; i++) { const limit = Math.min(Aang, rangeAngA[i - 1], rangeAngA[i]); w[i] = Math.min(w[i], Math.sqrt(Math.max(0, w[i - 1] * w[i - 1] + 2 * limit * dth[i]))); }
      for (let i = n - 2; i >= 0; i--) { const limit = Math.min(AangDecel, rangeAngA[i], rangeAngA[i + 1]); w[i] = Math.min(w[i], Math.sqrt(Math.max(0, w[i + 1] * w[i + 1] + 2 * limit * dth[i + 1]))); }
    }
    for (let i = 1; i < n; i++) { const gi = Math.abs(g[i]); if (!translationPriority[i] && gi > 1e-4) { const vr = w[i] / gi, rangeVr = rangeAngV[i] / gi; if (Math.min(vr, rangeVr) < Math.max(v[i - 1], v[i]) - 0.05) rotLimited[i] = 1; v[i - 1] = Math.min(v[i - 1], rangeVr); v[i] = Math.min(v[i], vr, rangeVr); } }
  }
  // forward
  for (let i = 1; i < n; i++) {
    const ds = pts[i].s - pts[i - 1].s;
    v[i] = Math.min(v[i], Math.sqrt(Math.max(0, v[i - 1] * v[i - 1] + 2 * aFwd[i] * ds)));
  }
  // backward (dedicated deceleration limit, tightened by ranges)
  for (let i = n - 2; i >= 0; i--) {
    const ds = pts[i + 1].s - pts[i].s;
    v[i] = Math.min(v[i], Math.sqrt(Math.max(0, v[i + 1] * v[i + 1] + 2 * aBack[i] * ds)));
  }
  // Enforce signed angular acceleration in the generated timing itself. A
  // local window scale changes omega linearly and alpha quadratically, which
  // avoids the alternating zero-speed samples produced by point-wise caps.
  if (head && head.length === n && Aang > 1e-4) {
    const stopped = new Set(opts.stopIdx || []);
    const intervalDt = (index: number) => {
      const ds = pts[index].s - pts[index - 1].s;
      return 2 * ds / Math.max(1e-6, v[index - 1] + v[index]);
    };
    const intervalOmega = (index: number) => {
      const dt = intervalDt(index);
      return dt > 1e-9 ? angWrap(head[index] - head[index - 1]) / dt : 0;
    };
    const translationInterval = (interval: number) => interval > 0 && interval < n && translationPriority[interval];
    for (let pass = 0; pass < 40; pass++) {
      const caps = v.slice();
      let changed = false;
      for (let interval = 2; interval < n; interval++) {
        if (stopped.has(interval - 1) || translationInterval(interval - 1) || translationInterval(interval)) continue;
        const beforeDt = intervalDt(interval - 1), afterDt = intervalDt(interval);
        if (beforeDt <= 1e-9 || afterDt <= 1e-9) continue;
        const beforeOmega = intervalOmega(interval - 1), afterOmega = intervalOmega(interval);
        const omegaDirection = Math.sign(beforeOmega) || Math.sign(afterOmega);
        const signedAcceleration = omegaDirection * (afterOmega - beforeOmega) / ((beforeDt + afterDt) / 2);
        const measured = Math.abs(signedAcceleration);
        const directionalLimit = beforeOmega * afterOmega < 0
          ? Math.min(Aang, AangDecel)
          : signedAcceleration < 0 ? AangDecel : Aang;
        const localLimit = Math.min(directionalLimit, rangeAngA[interval - 2], rangeAngA[interval - 1], rangeAngA[interval]) * 0.8;
        if (measured <= localLimit * 1.001 + 1e-9) continue;
        const scale = Math.min(0.98, Math.sqrt(localLimit / measured) * 0.98);
        for (let index = interval - 2; index <= interval; index++) {
          if (stopped.has(index)) continue;
          caps[index] = Math.min(caps[index], v[index] * scale);
          rotLimited[index] = Math.max(rotLimited[index], 2);
        }
        changed = true;
      }
      for (let i = 0; i < n; i++) v[i] = caps[i];
      for (let i = 1; i < n; i++) {
        const ds = pts[i].s - pts[i - 1].s;
        v[i] = Math.min(v[i], Math.sqrt(Math.max(0, v[i - 1] * v[i - 1] + 2 * aFwd[i] * ds)));
      }
      for (let i = n - 2; i >= 0; i--) {
        const ds = pts[i + 1].s - pts[i].s;
        v[i] = Math.min(v[i], Math.sqrt(Math.max(0, v[i + 1] * v[i + 1] + 2 * aBack[i] * ds)));
      }
      if (!changed) break;
    }
  }
  // time
  const t = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const ds = pts[i].s - pts[i - 1].s;
    const vm = (v[i] + v[i - 1]) / 2;
    t[i] = t[i - 1] + (vm > 1e-4 ? ds / vm : 0);
  }
  // Stationary turns happen after arrival and before any wait.
  const turns: TimedTurn[] = [], turnDelay = new Map<number, number>(); let terminalDelay = 0;
  (opts.turns || []).slice().sort((a, b) => a.idx - b.idx).forEach((turn) => {
    if (turn.idx < 0 || turn.idx >= n) return;
    const delta = stationaryTurnDelta(turn.start, turn.end, turn.direction);
    if (Math.abs(delta) < 1e-9) return;
    const wMax = Math.max(1e-6, (turn.maxAngVel || 540) * D2R), aMax = Math.max(1e-6, (turn.maxAngAccel || 720) * D2R), jMax = Math.max(0, (turn.maxAngJerk || 0) * D2R);
    const duration = Math.max(Math.abs(delta) * 1.875 / wMax, Math.sqrt(Math.abs(delta) * 5.77351 / aMax), jMax > 1e-9 ? Math.cbrt(Math.abs(delta) * 60 / jMax) : 0);
    const t0 = t[turn.idx]; turns.push({ idx: turn.idx, t0, t1: t0 + duration, start: turn.start, delta }); turnDelay.set(turn.idx, duration);
    for (let j = turn.idx + 1; j < n; j++) t[j] += duration;
    if (turn.idx === n - 1) terminalDelay += duration;
  });
  // dwell / wait-at-waypoint holds (memo §15) — only meaningful at stop points
  const holds: TimedHold[] = [];
  const dwell = (opts.dwell || []).slice().sort((a, b) => a.idx - b.idx);
  for (let d = 0; d < dwell.length; d++) {
    const dw = dwell[d]; if (!(dw.wait > 0) || dw.idx < 0 || dw.idx >= n) continue;
    const t0 = t[dw.idx] + (turnDelay.get(dw.idx) || 0); holds.push({ idx: dw.idx, t0, t1: t0 + dw.wait });
    for (let j = dw.idx + 1; j < n; j++) t[j] += dw.wait;
    if (dw.idx === n - 1) terminalDelay += dw.wait;
  }
  return { v, t, totalTime: t[n - 1] + terminalDelay, holds, turns, rotLimited };
}

// pose at time given sampled pts, profile times, and heading anchors / mode
function poseAtTime(time: number, pts: readonly Pick<GeometryPoint, "x" | "y" | "heading" | "s">[], prof: VelocityProfile, anchors: readonly HeadingAnchor[], mode: DriveType, rev = false) {
  const n = pts.length;
  if (n < 2) return null;
  const T = prof.t;
  // wait/dwell hold: robot is stationary at the stop point for the dwell window (memo §15)
  if (prof.holds && prof.holds.length) {
    for (let k = 0; k < prof.holds.length; k++) {
      const hd = prof.holds[k];
      if (time >= hd.t0 - 1e-9 && time <= hd.t1 + 1e-9) {
        const p = pts[hd.idx]; const f = pts[n - 1].s > 1e-6 ? p.s / pts[n - 1].s : 0;
        let heading = mode === 'tank' ? p.heading : headingAt(f, anchors); if (rev) heading += Math.PI;
        return { x: p.x, y: p.y, heading, speed: 0, s: p.s, f, hold: true };
      }
    }
  }
  if (prof.turns && prof.turns.length) {
    for (let k = 0; k < prof.turns.length; k++) {
      const turn = prof.turns[k];
      if (time >= turn.t0 - 1e-9 && time <= turn.t1 + 1e-9) {
        const p = pts[turn.idx], u = Math.max(0, Math.min(1, (time - turn.t0) / Math.max(1e-9, turn.t1 - turn.t0)));
        const q = 10 * u ** 3 - 15 * u ** 4 + 6 * u ** 5, f = pts[n - 1].s > 1e-6 ? p.s / pts[n - 1].s : 0;
        let heading = turn.start + turn.delta * q; if (rev) heading += Math.PI;
        return { x: p.x, y: p.y, heading, speed: 0, s: p.s, f, turn: true };
      }
    }
  }
  let i = 1;
  if (time <= 0) i = 1; else if (time >= T[n - 1]) i = n - 1;
  else { // binary search
    let lo = 1, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (T[mid] < time) lo = mid + 1; else hi = mid; }
    i = lo;
  }
  const t0 = T[i - 1], t1 = T[i];
  const u = t1 - t0 > 1e-6 ? Math.max(0, Math.min(1, (time - t0) / (t1 - t0))) : 0;
  const a = pts[i - 1], b = pts[i];
  const x = lerp(a.x, b.x, u), y = lerp(a.y, b.y, u);
  const s = lerp(a.s, b.s, u);
  const f = pts[n - 1].s > 1e-6 ? s / pts[n - 1].s : 0;
  let heading;
  if (mode === 'tank') heading = Math.atan2(b.y - a.y, b.x - a.x);
  else heading = headingAt(f, anchors);
  if (rev) heading += Math.PI;
  const speed = lerp(prof.v[i - 1], prof.v[i], u);
  return { x, y, heading, speed, s, f };
}

// ---- per-point engineering metrics aligned to the sampled path ----
// returns arrays + maxima for velocity / acceleration / angular velocity / curvature
function metrics(pts: readonly Pick<GeometryPoint, "s" | "heading" | "curv">[], prof: Pick<VelocityProfile, "v" | "t">, anchors: readonly HeadingAnchor[], mode: DriveType) {
  const n = pts.length;
  const v = prof.v && prof.v.length ? prof.v : new Array<number>(n).fill(0);
  const t = prof.t && prof.t.length ? prof.t : new Array<number>(n).fill(0);
  const accel = new Array<number>(n).fill(0), omega = new Array<number>(n).fill(0), curv = new Array<number>(n).fill(0), head = new Array<number>(n).fill(0);
  const totalS = n ? pts[n - 1].s : 0;
  for (let i = 0; i < n; i++) {
    const f = totalS > 1e-6 ? pts[i].s / totalS : 0;
    head[i] = mode === 'tank' ? pts[i].heading : headingAt(f, anchors);
    curv[i] = pts[i].curv || 0;
  }
  for (let i = 1; i < n; i++) {
    const dt = t[i] - t[i - 1];
    accel[i] = dt > 1e-5 ? (v[i] - v[i - 1]) / dt : 0;
    omega[i] = dt > 1e-5 ? angWrap(head[i] - head[i - 1]) / dt : 0;
  }
  if (n > 1) { accel[0] = accel[1]; omega[0] = omega[1]; }
  let vMax = 0.1, aMax = 0.1, wMax = 0.01, kMax = 0.01;
  for (let i = 0; i < n; i++) {
    vMax = Math.max(vMax, v[i]); aMax = Math.max(aMax, Math.abs(accel[i]));
    wMax = Math.max(wMax, Math.abs(omega[i])); kMax = Math.max(kMax, curv[i]);
  }
  return { v, accel, omega, curv, head, vMax, aMax, wMax, kMax };
}

// ---- safety analysis: flag tight curvature + sharp velocity dips ----
function analyze(pts: readonly Pick<GeometryPoint, "s" | "curv">[], _prof: VelocityProfile, m: ReturnType<typeof metrics>, robot: Partial<Pick<RobotConfig, "maxSpeed">> | null) {
  const n = pts.length; const out: PathWarning[] = [];
  if (n < 3) return out;
  const totalS = pts[n - 1].s || 1;
  const vCap = (robot && robot.maxSpeed) || 5;
  // tight curvature: radius below ~0.7 m is hard on a drivetrain
  let cuf = -1, cuMax = 0, cuAt = 0;
  for (let i = 1; i < n - 1; i++) {
    const rad = pts[i].curv > 1e-4 ? 1 / pts[i].curv : Infinity;
    if (rad < 0.7) { if (pts[i].curv > cuMax) { cuMax = pts[i].curv; cuAt = i; } if (cuf < 0) cuf = i; }
    else if (cuf >= 0) { out.push({ f: pts[cuAt].s / totalS, kind: 'curv', sev: cuMax > 2.5 ? 'high' : 'med', text: 'Tight curvature \u00b7 R\u2248' + (1 / cuMax).toFixed(2) + ' m' }); cuf = -1; cuMax = 0; }
  }
  if (cuf >= 0) out.push({ f: pts[cuAt].s / totalS, kind: 'curv', sev: cuMax > 2.5 ? 'high' : 'med', text: 'Tight curvature \u00b7 R\u2248' + (1 / cuMax).toFixed(2) + ' m' });
  // velocity dip: local minimum well below surrounding speed (slow-down the user may not intend)
  const v = m.v;
  for (let i = 6; i < n - 6; i++) {
    const local = v[i];
    const around = Math.max(v[i - 6], v[i + 6]);
    if (around > 1.2 && local < around * 0.45 && local < vCap * 0.5) {
      // ensure it's a genuine trough
      if (v[i] <= v[i - 1] && v[i] <= v[i + 1]) { out.push({ f: pts[i].s / totalS, kind: 'vel', sev: local < around * 0.3 ? 'high' : 'med', text: 'Velocity dip \u00b7 ' + local.toFixed(1) + ' m/s' }); i += 10; }
    }
  }
  return out;
}

// ---- one-call derivation: everything the field + panels need for a path ----
function derivePath(doc: PathDoc, robot: RobotConfig | null, perSeg?: number, options?: { skipStationaryActions?: boolean }) {
  perSeg = perSeg || DEFAULT_SAMPLES_PER_SEGMENT;
  const smp = sample(doc.waypoints, perSeg, true);
  const nWp = doc.waypoints.length;
  const originalLast = Math.max(0, smp.pts.length - 1);
  let wpIdx = smp.wpIdx ?? doc.waypoints.map((_, k) => Math.min(originalLast, k * perSeg));
  const initialWpFrac = wpIdx.map((index) => smp.pts.length ? smp.pts[index].s / (smp.length || 1) : 0);
  const targetFractions = (doc.targets || []).map((target) => featureFraction(target, smp)).filter((fraction) => {
    let segment = 0;
    while (segment < nWp - 2 && fraction >= initialWpFrac[segment + 1] - 1e-9) segment++;
    const mode = robot && robot.drive === 'tank'
      ? 'tangent'
      : ((doc.waypoints[segment] && doc.waypoints[segment].segmentHeadingMode) || doc.headingMode || 'targets');
    return mode === 'targets';
  });
  wpIdx = insertHeadingTargetSamples(smp, targetFractions, wpIdx);
  const pts = smp.pts;
  const total = smp.length || 1;
  const wpFrac = wpIdx.map((i) => (pts.length ? pts[i].s / total : 0));
  const stopIdx: number[] = [];
  doc.waypoints.forEach((w, k) => { if (w.stop) stopIdx.push(wpIdx[k]); });
  const cap = (robot && robot.maxSpeed) || doc.constraints.maxVel;
  const vmax = Math.min(doc.constraints.maxVel, cap);
  const sv = doc.waypoints[0] && doc.waypoints[0].stop ? 0 : doc.startVel;
  const gv = doc.waypoints[nWp - 1] && doc.waypoints[nWp - 1].stop ? 0 : doc.goalVel;
  const effRanges = effectiveRanges(doc, smp);
  // Heading mode is owned by the outgoing segment; omitted overrides inherit the path default.
  const headingMode = (robot && robot.drive === 'tank') ? 'tangent' : (doc.headingMode || 'targets');
  const effectiveHeadingMode = (segment: number) => (robot && robot.drive === 'tank')
    ? 'tangent'
    : ((doc.waypoints[segment] && doc.waypoints[segment].segmentHeadingMode) || headingMode);
  const segmentModes = doc.waypoints.slice(0, -1).map((_, segment) => effectiveHeadingMode(segment));
  const manualEntries: HeadingAnchor[] = [], targetEntries: HeadingAnchor[] = [];
  doc.waypoints.forEach((w, k) => {
    const heading = waypointHeadingSemantics(w, k, segmentModes);
    const entry = { f: wpFrac[k], rad: (w.theta || 0) * D2R };
    if (heading.manual) manualEntries.push(entry);
    if (heading.targets) targetEntries.push({ ...entry });
  });
  (doc.targets || []).forEach((t) => targetEntries.push({ f: featureFraction(t, smp), rad: t.deg * D2R }));
  const manualAnchors = buildAnchors(manualEntries), targetAnchors = buildAnchors(targetEntries);
  const rawHead: number[] = [];
  // pointIndex only grows, so every boundary passed by an earlier sample is
  // also passed by this one; resuming the scan yields the same segment.
  let segment = 0;
  pts.forEach((p, pointIndex) => {
    const f = total > 1e-6 ? p.s / total : 0;
    while (segment < nWp - 2 && pointIndex >= wpIdx[segment + 1]) segment++;
    const segmentMode = effectiveHeadingMode(segment);
    if (segmentMode === 'lookAt') {
      const target = doc.waypoints[segment] && doc.waypoints[segment].segmentLookAt;
      const dx = target ? target.x - p.x : 0, dy = target ? target.y - p.y : 0;
      rawHead.push(Math.hypot(dx, dy) > 1e-6 ? Math.atan2(dy, dx) : (rawHead.length ? rawHead[rawHead.length - 1] : p.heading));
    } else {
      rawHead.push(segmentMode === 'tangent' ? p.heading : headingAt(f, segmentMode === 'targets' ? targetAnchors : manualAnchors));
    }
  });
  const segmentLaws = doc.waypoints.slice(0, -1).map((w, segment) => segmentModes[segment] === 'lookAt' ? 'lookAt:' + (w.segmentLookAt ? w.segmentLookAt.x : '') + ':' + (w.segmentLookAt ? w.segmentLookAt.y : '') : segmentModes[segment]);
  const transitionBreaks = doc.waypoints.slice(0, -1).map((w) => !!w.turnInPlace);
  const headingTransitions = headingTransitionWindows(doc.waypoints, segmentLaws, transitionBreaks, wpFrac, total, "heading");
  const transitionGoals = headingTransitionGoals(segmentLaws, transitionBreaks, wpIdx, pts, {
    manual: manualAnchors.map(({ f, rad }) => ({ f, heading: rad })),
    targets: targetAnchors.map(({ f, rad }) => ({ f, heading: rad })),
  });
  const head = smoothHeadingTransitions(rawHead, segmentLaws, transitionBreaks, wpIdx, pts, doc.waypoints, transitionGoals);
  const allTangent = doc.waypoints.slice(0, -1).every((_, segment) => effectiveHeadingMode(segment) === 'tangent');
  const mode: DriveType = allTangent ? 'tank' : 'swerve';
  const anchors = mode === 'tank' ? [] : buildAnchors(pts.map((p, i) => ({ f: total > 1e-6 ? p.s / total : 0, rad: head[i] })));
  const dwell: { idx: number; wait: number }[] = [], turns: ProfileTurn[] = [];
  doc.waypoints.forEach((w, k) => { if (w.stop && w.wait != null && w.wait > 0) dwell.push({ idx: wpIdx[k], wait: w.wait }); });
  if (!(options && options.skipStationaryActions)) doc.waypoints.forEach((w, k) => { if (w.stop && w.turnInPlace) turns.push({ idx: wpIdx[k], start: k > 0 ? head[Math.max(0, wpIdx[k] - 1)] : head[0], end: w.turnInPlace.headingDeg * D2R, direction: w.turnInPlace.direction, maxAngVel: doc.constraints.maxAngVel, maxAngAccel: Math.min(doc.constraints.maxAngAccel, doc.constraints.maxAngDecel || doc.constraints.maxAngAccel), maxAngJerk: doc.constraints.maxAngJerk }); });
  const prof = profile(pts, doc.constraints, sv, gv, { stopIdx, vmax, ranges: effRanges, headingTransitions, heading: head, dwell, turns });
  const mtr = metrics(pts, prof, anchors, mode);
  const warnings = analyze(pts, prof, mtr, robot || {});
  doc.waypoints.slice(0, -1).forEach((w, segment) => {
    if (w.segmentHeadingMode !== 'lookAt' || !w.segmentLookAt) return;
    let nearest = Infinity;
    for (let i = wpIdx[segment]; i <= wpIdx[segment + 1] && i < pts.length; i++) nearest = Math.min(nearest, Math.hypot(pts[i].x - w.segmentLookAt.x, pts[i].y - w.segmentLookAt.y));
    if (nearest < 0.05) warnings.push({ f: wpFrac[segment], kind: 'lookAt', sev: 'high', text: 'Tracked field point lies on the driven segment' });
  });
  // rotational diagnostics: flag contiguous rotation-limited stretches (memo §16)
  if (prof.rotLimited) {
    const rl = prof.rotLimited;
    const pushRun = (a: number, b: number) => {
      const mid = Math.floor((a + b) / 2);
      const accelerationLimited = rl.slice(a, b + 1).some((value) => value >= 2);
      warnings.push({
        f: pts[mid].s / total,
        kind: accelerationLimited ? 'angaccel' : 'rot',
        sev: 'med',
        text: accelerationLimited
          ? 'Angular acceleration-limited \u00b7 add more distance between heading anchors'
          : 'Angular velocity-limited \u00b7 heading can\u2019t keep up at speed',
      });
    };
    let run = -1;
    for (let i = 0; i < rl.length; i++) { if (rl[i]) { if (run < 0) run = i; } else if (run >= 0) { if (i - run > 3) pushRun(run, i - 1); run = -1; } }
    if (run >= 0 && rl.length - run > 3) pushRun(run, rl.length - 1);
  }
  // locate each warning to a segment + attach suggested fixes
  warnings.forEach((wn) => {
    let seg = 0;
    for (let i = 0; i < wpFrac.length - 1; i++) { if (wn.f >= wpFrac[i] - 1e-4) seg = i; }
    wn.seg = Math.max(0, Math.min(doc.waypoints.length - 2, seg));
    wn.fixes = wn.kind === 'curv'
      ? [{ id: 'clothoid', label: 'Convert segment to clothoid' }, { id: 'handles', label: 'Increase handle length' }, { id: 'cap', label: 'Cap velocity on this stretch' }, { id: 'insert', label: 'Insert a waypoint here' }]
      : wn.kind === 'angaccel'
      ? [{ id: 'angaccel', label: 'Raise max angular acceleration' }, { id: 'lead', label: 'Move rotation target earlier' }]
      : wn.kind === 'rot'
      ? [{ id: 'cap', label: 'Cap speed on this stretch' }, { id: 'angvel', label: 'Raise max angular velocity' }]
      : [{ id: 'cap', label: 'Lower the speed cap around here' }, { id: 'handles', label: 'Lengthen handles to ease the curve' }, { id: 'insert', label: 'Insert a waypoint here' }];
  });
  return { sample: smp, prof, anchors, metrics: mtr, warnings, wpFrac, wpIdx, mode, effRanges, headingMode, rev: !!doc.driveBackward };
}
function jigglePositions(anchor: ControlPoint, baseRad: number, options: { distanceM?: number; distance?: number; strokes: number; startDeg: number; stepDeg: number }, bounds = { w: 16.541, h: 8.069 }) {
  const distance = Number(options.distanceM ?? options.distance), strokes = Math.round(Number(options.strokes)), startDeg = Number(options.startDeg), stepDeg = Number(options.stepDeg);
  if (!(distance >= 0.03) || strokes < 2 || strokes > 12 || !Number.isFinite(startDeg + stepDeg)) return null;
  const directions = new Set<number>(), positions: ControlPoint[] = [];
  for (let stroke = 0; stroke < strokes; stroke++) {
    const relativeDeg = startDeg + stepDeg * stroke;
    const key = ((relativeDeg % 360) + 360) % 360;
    const roundedKey = Math.round(key * 1000) / 1000;
    if (directions.has(roundedKey)) return null;
    directions.add(roundedKey);
    const angle = baseRad + relativeDeg * D2R;
    const point = { x: anchor.x + Math.cos(angle) * distance, y: anchor.y + Math.sin(angle) * distance };
    if (point.x < 0 || point.x > bounds.w || point.y < 0 || point.y > bounds.h) return null;
    positions.push(point, { x: anchor.x, y: anchor.y });
  }
  return positions;
}
export const PM = { bez, bezD, sample, profile, poseAtTime, headingAt, metrics, analyze, metricColor, metricGradient, METRICS, SEGTYPES, buildAnchors, pointAtFraction, nearestFraction, autoHandles, angWrap, angLerp, D2R, R2D, lerp, derivePath, jigglePositions, effectiveRanges, featureFraction, remapWaypointRange, waypointFracs };
export default PM;
