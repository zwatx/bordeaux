import { clone } from "../project/defaults";
import type { PathDoc, PlannerInput, PlannerResult, RouteGeometry, Waypoint } from "../types";
import { authoredPath, physicalPath, stable } from "./acceptedTrajectoryIdentity";
import { ACTIVE_FIELD_REFERENCE } from "../field/rebuilt2026";

export const MAX_ROUTE_KNOTS = 161;

export function routeUnsupportedReason(input: PlannerInput): string | undefined {
  const path = input.path;
  if (input.field !== undefined && stable(input.field) !== stable(ACTIVE_FIELD_REFERENCE)) return "Route safety does not support this field revision.";
  if (path.waypoints.length < 2 || path.waypoints.length > 41) return "Route search supports 2–41 required waypoints.";
  if (path.routeRequiredPointIndices !== undefined) return "Route search requires authored points, not expanded solver geometry.";
  if (path.waypoints.slice(0, -1).some((w) => (w.segType ?? "bezier") !== "bezier")) return "Route search currently supports Bézier segments; straight, arc and clothoid semantics are not converted.";
  if (path.waypoints.some((w) => w.jiggle)) return "Route search does not yet support jiggle actions.";
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

/** Rebuild all semantics from source. Solver knots can supply geometry only. */
export function routePlanningPath(source: PathDoc, geometry: RouteGeometry): PathDoc {
  if (source.routeRequiredPointIndices !== undefined) throw new Error("Solver metadata is not authored source.");
  const error = routeGeometryShapeError(geometry);
  if (error) throw new Error(error);
  const indices = geometry.requiredPointIndices;
  if (indices.length !== source.waypoints.length) throw new Error("Route omitted a required point");
  let leg = 0;
  const waypoints = geometry.knots.map((knot, index): Waypoint => {
    while (leg + 1 < indices.length && index >= indices[leg + 1]) leg++;
    const required = index === indices[leg];
    const point = source.waypoints[leg];
    if (required && (point.x !== knot.x || point.y !== knot.y)) throw new Error("Route moved a required point");
    const semantic = required ? point : {
      theta: 0, thetaOn: false, linked: true, stop: false,
      segmentHeadingMode: point.segmentHeadingMode,
      segmentFollowMode: point.segmentFollowMode,
      segmentLookAt: point.segmentLookAt,
    };
    // An untrusted knot must not inject semantic keys via object spreading.
    const rebuilt = { ...clone(semantic), linked: knot.smooth ?? true, x: knot.x, y: knot.y, prevC: clone(knot.prevC), nextC: clone(knot.nextC) } as Waypoint;
    delete rebuilt.corner;
    if (!required && !rebuilt.stop && index > 0 && index < geometry.knots.length - 1) {
      const a = { x: rebuilt.x - rebuilt.prevC.x, y: rebuilt.y - rebuilt.prevC.y };
      const b = { x: rebuilt.nextC.x - rebuilt.x, y: rebuilt.nextC.y - rebuilt.y };
      const lengths = Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y);
      if (lengths < 1e-12 || Math.abs(a.x * b.y - a.y * b.x) > lengths * 1e-7 || a.x * b.x + a.y * b.y <= 0) throw new Error("Moving route knots require aligned nonzero tangents");
    }
    return rebuilt;
  });
  return { ...clone(authoredPath(source)), waypoints, routeRequiredPointIndices: [...indices] };
}

export function geometryFromPath(path: PathDoc): RouteGeometry {
  return { version: 1, knots: path.waypoints.map(({ x, y, prevC, nextC, linked, corner }) => clone({ x, y, prevC, nextC, smooth: Boolean(linked && !corner) })), requiredPointIndices: path.waypoints.map((_, i) => i) };
}

/** Public result indices always refer to required source points. */
export function routeResultToSource(result: PlannerResult, geometry: RouteGeometry, path: PathDoc): PlannerResult {
  return {
    ...result, routeGeometry: clone(geometry), optimizedPath: path,
    waypointSampleIndices: result.waypointSampleIndices && geometry.requiredPointIndices.map((i) => result.waypointSampleIndices![i]),
    stationaryActions: result.stationaryActions?.map((action) => ({ ...action, waypointIndex: geometry.requiredPointIndices.indexOf(action.waypointIndex) })),
  };
}

export function routeResultToPlanning(result: PlannerResult): PlannerResult {
  const indices = result.routeGeometry!.requiredPointIndices;
  return { ...result, waypointSampleIndices: undefined,
    stationaryActions: result.stationaryActions?.map((action) => ({ ...action, waypointIndex: indices[action.waypointIndex] })) };
}

export function samePlanningGeometry(first: PathDoc | undefined, second: PathDoc): boolean {
  const comparable = (path: PathDoc) => {
    const normalized = physicalPath(path);
    // Source normalization aligns handles for the editor. Acceptance must compare
    // the actual solved handles and smoothing instead of hiding a geometry edit.
    return { ...normalized, waypoints: normalized.waypoints.map((waypoint, i) => ({
      ...waypoint, prevC: path.waypoints[i].prevC, nextC: path.waypoints[i].nextC,
      linked: path.waypoints[i].linked, corner: Boolean(path.waypoints[i].corner),
    })) };
  };
  return !!first && stable(comparable(first)) === stable(comparable(second));
}
