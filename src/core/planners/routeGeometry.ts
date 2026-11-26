import { sample } from "../math/geometry";
import { clone } from "../project/defaults";
import { normalizeWaypoints } from "../project/normalize";
import { alignedWaypointHandles } from "../project/waypointHandles";
import type { ConstraintRange, PathDoc, PlannerInput, RouteGeometry, Waypoint } from "../types";
import { ACTIVE_FIELD_REFERENCE } from "../field/rebuilt2026";

export const MAX_ROUTE_KNOTS = 161;
/** Samples per segment used to place a zone end by distance when Apply adds or removes waypoints. */
const PLACEMENT_SAMPLES = 128;

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Stable across JSON object ordering; do not round trajectory-affecting numbers. */
export function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item) => record(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
    : item);
}

/** Why route search cannot run on this path, judged on its required waypoints. */
export function routeUnsupportedReason(input: PlannerInput): string | undefined {
  if (input.field !== undefined && stable(input.field) !== stable(ACTIVE_FIELD_REFERENCE)) return "Route safety does not support this field revision.";
  const { task } = routeTask(input.path);
  if (task.waypoints.length < 2 || task.waypoints.length > 41) return "Route search supports 2–41 required waypoints.";
  if (input.path.waypoints.length > MAX_ROUTE_KNOTS) return `Route search supports at most ${MAX_ROUTE_KNOTS} waypoints.`;
  if (task.waypoints.slice(0, -1).some((w) => (w.segType ?? "bezier") !== "bezier")) return "Route search currently supports Bézier segments; straight, arc and clothoid semantics are not converted.";
  if (task.waypoints.some((w) => w.jiggle)) return "Route search does not yet support jiggle actions.";
  return undefined;
}

export function routeGeometryShapeError(value: unknown): string | null {
  const g = value as RouteGeometry | undefined;
  if (!g || g.version !== 1 || !Array.isArray(g.knots) || g.knots.length < 2 || g.knots.length > MAX_ROUTE_KNOTS
    || !Array.isArray(g.requiredPointIndices) || g.requiredPointIndices.length < 2 || g.requiredPointIndices.length > 41
    || g.requiredPointIndices[0] !== 0 || g.requiredPointIndices.at(-1) !== g.knots.length - 1
    || g.requiredPointIndices.some((n, i) => !Number.isInteger(n) || n < 0 || n >= g.knots.length || (i > 0 && n <= g.requiredPointIndices[i - 1]))
    || g.knots.some((p) => !p || (p.smooth !== undefined && typeof p.smooth !== "boolean") || [p, p.prevC, p.nextC].some((c) => !c || !Number.isFinite(c.x) || !Number.isFinite(c.y)))) return "Route geometry or required-point mapping is invalid";
  return null;
}

/** The path's curve as knots, every waypoint required. */
export function geometryFromPath(path: PathDoc): RouteGeometry {
  return { version: 1, knots: path.waypoints.map(({ x, y, prevC, nextC, linked, corner }) => clone({ x, y, prevC, nextC, smooth: Boolean(linked && !corner) })), requiredPointIndices: path.waypoints.map((_, i) => i) };
}

/** Path fraction at each waypoint, by distance. */
function waypointFractions(waypoints: readonly Waypoint[]): number[] {
  const sampled = sample(waypoints, PLACEMENT_SAMPLES, true);
  const total = sampled.length || 1;
  return sampled.wpIdx!.map((index) => sampled.pts[index].s / total);
}

type Place = { w: number; t: number | undefined };

/**
 * Moves the waypoint-anchored ends of zones from one set of waypoints to another that holds them all.
 * `place` maps one end. Zones by fraction or distance never change. Ends without a local fraction
 * keep naming a waypoint; the default ends (start and end of the path) are made explicit first.
 */
function remapRanges(ranges: readonly ConstraintRange[], count: number, place: (end: Place) => Place): ConstraintRange[] {
  return ranges.map((range) => {
    if (range.anchor !== "wp") return range;
    const local = range.t0 !== undefined || range.t1 !== undefined;
    const start = place({ w: Math.round(range.w0 ?? 0), t: range.t0 });
    const end = place({ w: Math.round(range.w1 ?? count - 1), t: range.t1 });
    const next: ConstraintRange = { ...range, w0: start.w, w1: end.w };
    delete next.t0; delete next.t1;
    // A local end needs both ends local; a waypoint end is then the start of its segment, or the path end.
    if (local || start.t !== undefined || end.t !== undefined) {
      if (start.t !== undefined) next.t0 = start.t;
      if (end.t !== undefined) next.t1 = end.t;
    }
    return next;
  });
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** A zone end on the coarse waypoints `required` (indices into `fractions`) placed on the fine ones by distance. */
function coarseToFine(required: readonly number[], fractions: readonly number[]) {
  return ({ w, t }: Place): Place => {
    if (t === undefined) return { w: required[clamp(w, 0, required.length - 1)], t };
    const leg = clamp(w, 0, required.length - 2), a = required[leg], b = required[leg + 1], local = clamp(t, 0, 1);
    if (b - a === 1) return { w: a, t: local };
    const target = fractions[a] + (fractions[b] - fractions[a]) * local;
    let segment = a;
    while (segment < b - 1 && fractions[segment + 1] <= target) segment++;
    const span = fractions[segment + 1] - fractions[segment];
    return { w: segment, t: span > 0 ? clamp((target - fractions[segment]) / span, 0, 1) : 0 };
  };
}

/** A zone end on the fine waypoints placed on the coarse ones `required`, by distance. */
function fineToCoarse(required: readonly number[], fractions: readonly number[]) {
  const legOf = (index: number) => {
    let leg = 0;
    while (leg < required.length - 2 && required[leg + 1] <= index) leg++;
    return leg;
  };
  const onLeg = (leg: number, target: number): Place => {
    const a = required[leg], b = required[leg + 1], span = fractions[b] - fractions[a];
    return { w: leg, t: span > 0 ? clamp((target - fractions[a]) / span, 0, 1) : 0 };
  };
  return ({ w, t }: Place): Place => {
    const last = fractions.length - 1;
    if (t === undefined) {
      const index = clamp(w, 0, last), at = required.indexOf(index);
      return at >= 0 ? { w: at, t } : onLeg(legOf(index), fractions[index]);
    }
    const segment = clamp(w, 0, last - 1), leg = legOf(segment);
    if (required[leg + 1] - required[leg] === 1) return { w: leg, t: clamp(t, 0, 1) };
    return onLeg(leg, fractions[segment] + (fractions[segment + 1] - fractions[segment]) * clamp(t, 0, 1));
  };
}

const isMoving = (waypoint: Pick<Waypoint, "stop">, index: number, count: number) => !waypoint.stop && index > 0 && index < count - 1;

/**
 * Splits a path into what a route must keep and the curve it has now. The task holds the
 * waypoints the user owns, with zones placed on them; waypoints Optimize added are left out,
 * so a later route may move, replace or remove them. The seed is the current curve, every
 * waypoint a knot, with the task's waypoints marked required. routePlanningPath(task, seed)
 * rebuilds the path.
 */
export function routeTask(path: PathDoc): { task: PathDoc; seed: RouteGeometry } {
  const count = path.waypoints.length;
  // The ends always belong to the user.
  const required = path.waypoints.flatMap((waypoint, index) => waypoint.optimizerAdded && index > 0 && index < count - 1 ? [] : [index]);
  const seed = { ...geometryFromPath(path), requiredPointIndices: required };
  if (required.length === count) return { task: path, seed };
  const fractions = path.ranges.some((range) => range.anchor === "wp") ? waypointFractions(path.waypoints) : [];
  return { seed, task: { ...path,
    waypoints: required.map((index) => path.waypoints[index]),
    ranges: fractions.length ? remapRanges(path.ranges, count, fineToCoarse(required, fractions)) : path.ranges,
  } };
}

/**
 * The path a route becomes: the task's waypoints with the route's handles, and a plain
 * pass-through waypoint, flagged optimizerAdded, at every other knot. An added waypoint has
 * no heading or stop and follows the heading and following laws of the segment it splits.
 * Zones anchored to waypoints keep their place along the route; zones by fraction or distance,
 * markers and rotation targets keep their values. Moving waypoints come out exactly as loading
 * a project leaves them, so a save and reopen does not change the curve.
 */
export function routePlanningPath(task: PathDoc, geometry: RouteGeometry): PathDoc {
  const error = routeGeometryShapeError(geometry);
  if (error) throw new Error(error);
  if (task.waypoints.some((waypoint) => waypoint.optimizerAdded)) throw new Error("A route task holds only required waypoints.");
  const indices = geometry.requiredPointIndices;
  if (indices.length !== task.waypoints.length) throw new Error("Route omitted a required point");
  const count = geometry.knots.length;
  let leg = 0;
  const waypoints = geometry.knots.map((knot, index): Waypoint => {
    while (leg + 1 < indices.length && index >= indices[leg + 1]) leg++;
    const required = index === indices[leg];
    const point = task.waypoints[leg];
    if (required && (point.x !== knot.x || point.y !== knot.y)) throw new Error("Route moved a required point");
    const moving = isMoving(required ? point : { stop: false }, index, count);
    // An added waypoint is smooth with collinear handles, as every moving waypoint is; a curve the path cannot
    // hold is never applied. A required moving waypoint is aligned below exactly as loading aligns it.
    if (moving && !required) {
      const a = { x: knot.x - knot.prevC.x, y: knot.y - knot.prevC.y };
      const b = { x: knot.nextC.x - knot.x, y: knot.nextC.y - knot.y };
      const lengths = Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y);
      if (knot.smooth === false) throw new Error("Moving route knots must keep curvature smoothing");
      if (lengths < 1e-12 || Math.abs(a.x * b.y - a.y * b.x) > lengths * 1e-7 || a.x * b.x + a.y * b.y <= 0) throw new Error("Moving route knots require aligned nonzero tangents");
    }
    const geometryOf = { x: knot.x, y: knot.y, prevC: clone(knot.prevC), nextC: clone(knot.nextC) };
    if (required) return { ...clone(point), ...geometryOf, ...(moving ? { linked: true, corner: false } : {}) };
    const law = { segmentHeadingMode: point.segmentHeadingMode, segmentFollowMode: point.segmentFollowMode, segmentLookAt: point.segmentLookAt && clone(point.segmentLookAt) };
    return { ...geometryOf, theta: 0, thetaOn: false, linked: true, stop: false, optimizerAdded: true,
      ...Object.fromEntries(Object.entries(law).filter(([, value]) => value !== undefined)) };
  });
  const normalized = normalizeWaypoints(waypoints) as Waypoint[];
  const inserted = count !== task.waypoints.length;
  const ranges = inserted && task.ranges.some((range) => range.anchor === "wp")
    ? remapRanges(task.ranges, task.waypoints.length, coarseToFine(indices, waypointFractions(normalized))) : clone(task.ranges);
  return { ...clone({ ...task, waypoints: [] }), waypoints: normalized, ranges };
}

/** The path after applying a route found for it. Leaves `path` unchanged. */
export function applyRoute(path: PathDoc, geometry: RouteGeometry): PathDoc {
  return routePlanningPath(routeTask(path).task, geometry);
}

const LAW_KEYS = ["segmentHeadingMode", "segmentFollowMode", "segmentLookAt"] as const;
const withoutLaw = (waypoint: Waypoint) => {
  const { segmentHeadingMode: _h, segmentFollowMode: _f, segmentLookAt: _l, ...rest } = waypoint;
  return stable(rest);
};

/**
 * Keeps the optimizerAdded flag true to what it means after an edit from `before` to `after`.
 * An added waypoint the edit changed becomes an ordinary waypoint the user owns, so a later
 * Optimize keeps it. An unchanged one follows the heading and following laws of the waypoint
 * that starts its segment, so changing a segment's law changes it along the whole route.
 * An added waypoint that became an end of the path is the user's too. Returns `after` itself
 * when there is nothing to change. Undo, redo and Apply restore whole paths and skip this.
 */
export function settleOptimizerWaypoints(before: PathDoc | undefined, after: PathDoc): PathDoc {
  if (!after.waypoints.some((waypoint) => waypoint.optimizerAdded)) return after;
  const unchanged = new Map<string, Waypoint>();
  before?.waypoints.forEach((waypoint) => { if (waypoint.optimizerAdded) unchanged.set(withoutLaw(waypoint), waypoint); });
  let changed = false;
  let owner: Waypoint | undefined;
  const count = after.waypoints.length;
  const waypoints = after.waypoints.map((waypoint, index) => {
    if (!waypoint.optimizerAdded) { owner = waypoint; return waypoint; }
    const previous = unchanged.get(withoutLaw(waypoint));
    const edited = !previous || index === 0 || index === count - 1 || !owner
      || LAW_KEYS.some((key) => stable(previous[key]) !== stable(waypoint[key]));
    if (edited) {
      changed = true;
      const { optimizerAdded: _added, ...owned } = waypoint;
      owner = isMoving(owned, index, count) ? { ...owned, linked: true, corner: false, ...(alignedWaypointHandles(owned, true) ?? {}) } : owned;
      return owner;
    }
    const next = { ...waypoint };
    for (const key of LAW_KEYS) {
      if (owner![key] === undefined) delete next[key];
      else (next as Record<string, unknown>)[key] = clone(owner![key]);
    }
    if (LAW_KEYS.some((key) => stable(next[key]) !== stable(waypoint[key]))) changed = true;
    return next;
  });
  return changed ? { ...after, waypoints } : after;
}
