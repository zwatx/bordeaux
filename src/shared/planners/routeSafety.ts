import { minimumRobotFieldClearance, observeRobotFieldPortalSequence } from "../agent/fieldClearance";
import { boundsPolygon, convexPolygonClearance, footprintBoundsClearance, interpolateHeading, robotFootprintRadius, robotFootprintVertices, transformFootprint, type FootprintPose } from "../agent/robotFootprint";
import { ACTIVE_FIELD_REFERENCE, REBUILT_2026_FIELD, officialToAppRect } from "../field/rebuilt2026";
import { FIELD_H, FIELD_W } from "../math/fieldBounds";
import type { ControlPoint, FieldReference, PlannerResult, RobotConfig } from "../types";
import { stable } from "./acceptedTrajectoryIdentity";

type Box = { xMin: number; xMax: number; yMin: number; yMax: number };
export interface RouteFieldModel { obstacles: Box[]; radius: number; vertices: ControlPoint[] }
const EPS = 1e-6;

/** Closed solids include full barrier depth, with only physically admissible openings removed. */
export function routeFieldModel(robot: RobotConfig): RouteFieldModel {
  const obstacles = REBUILT_2026_FIELD.solidObstacles.flatMap((o) => o.bounds ? [officialToAppRect(o.bounds)] : []);
  for (const barrier of REBUILT_2026_FIELD.crossingBarriers) {
    const portals = barrier.portals.map((p) => ({ ...p, app: officialToAppRect(p.bounds) })).sort((a, b) => a.app.yMin - b.app.yMin);
    const xMin = Math.min(...portals.map((p) => p.app.xMin));
    const xMax = Math.max(...portals.map((p) => p.app.xMax));
    let y = 0;
    for (const portal of portals) {
      if (portal.app.yMin > y) obstacles.push({ xMin, xMax, yMin: y, yMax: portal.app.yMin });
      if (portal.traversal === "trench" && (robot.heightM === undefined || robot.heightM > portal.clearanceHeightM!)) obstacles.push(portal.app);
      y = Math.max(y, portal.app.yMax);
    }
    if (y < FIELD_H) obstacles.push({ xMin, xMax, yMin: y, yMax: FIELD_H });
  }
  return { obstacles, radius: robotFootprintRadius(robot), vertices: robotFootprintVertices(robot) };
}

function box(points: readonly ControlPoint[]): Box {
  return { xMin: Math.min(...points.map((p) => p.x)), xMax: Math.max(...points.map((p) => p.x)),
    yMin: Math.min(...points.map((p) => p.y)), yMax: Math.max(...points.map((p) => p.y)) };
}
function boxGap(a: Box, b: Box): number {
  return Math.hypot(Math.max(0, a.xMin - b.xMax, b.xMin - a.xMax), Math.max(0, a.yMin - b.yMax, b.yMin - a.yMax));
}
function clearBox(bounds: Box, model: RouteFieldModel): boolean {
  const r = model.radius + EPS;
  return bounds.xMin > r && bounds.yMin > r && bounds.xMax < FIELD_W - r && bounds.yMax < FIELD_H - r
    && model.obstacles.every((o) => boxGap(bounds, o) > r);
}
const mid = (a: ControlPoint, b: ControlPoint): ControlPoint => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** The exported pose interpolation is authoritative: linear translation and
 * shortest-angle rotation on each interval. At its midpoint, every footprint
 * vertex moves by at most |b-a|/2 + 2 R sin(|deltaHeading|/4). Signed polygon
 * clearance is 1-Lipschitz under this displacement bound. A midpoint clearance
 * greater than the bound therefore certifies the ENTIRE interval. Subdivision
 * tightens the bound; exhausting work/depth is unknown, never a sample proof.
 * Convex polygons (including the rectangle default) use the existing SAT helper.
 */
export function routeSweepStatus(a: FootprintPose, b: FootprintPose, model: RouteFieldModel, budget = { remaining: 4096 }): "clear" | "collision" | "unknown" {
  const clearance = (pose: FootprintPose) => {
    const polygon = transformFootprint(model.vertices, pose);
    return Math.min(footprintBoundsClearance(polygon, FIELD_W, FIELD_H), ...model.obstacles.map((o) =>
      convexPolygonClearance(polygon, boundsPolygon({ min: { x: o.xMin, y: o.yMin }, max: { x: o.xMax, y: o.yMax } }))));
  };
  const visit = (first: FootprintPose, second: FootprintPose, depth: number): "clear" | "collision" | "unknown" => {
    if (--budget.remaining < 0) return "unknown";
    if (clearBox(box([first, second]), model)) return "clear";
    const middle = { ...mid(first, second), headingRad: interpolateHeading(first.headingRad, second.headingRad, 0.5) };
    const gap = clearance(middle);
    if (gap <= 0) return "collision";
    if (gap <= EPS) return "unknown";
    const angle = Math.abs(Math.atan2(Math.sin(second.headingRad - first.headingRad), Math.cos(second.headingRad - first.headingRad)));
    const motion = Math.hypot(second.x - first.x, second.y - first.y) / 2 + 2 * model.radius * Math.sin(angle / 4);
    if (gap > motion + EPS) return "clear";
    if (depth >= 16) return "unknown";
    const left = visit(first, middle, depth + 1);
    if (left === "collision") return left;
    const right = visit(middle, second, depth + 1);
    return right === "collision" ? right : left === "clear" && right === "clear" ? "clear" : "unknown";
  };
  if (clearance(a) <= 0 || clearance(b) <= 0) return "collision";
  return visit(a, b, 0);
}

/** Graph edges are proposals only; final timing supplies the authoritative poses. */
export function routeLineClear(a: ControlPoint, b: ControlPoint, model: RouteFieldModel, headingRad = 0): boolean {
  return routeSweepStatus({ ...a, headingRad }, { ...b, headingRad }, model) === "clear";
}

export function routeSafetyIssue(robot: RobotConfig, result: PlannerResult, field: FieldReference = ACTIVE_FIELD_REFERENCE): { message: string; concrete: boolean } | undefined {
  if (stable(field) !== stable(ACTIVE_FIELD_REFERENCE)) return { message: "Route safety does not support this field revision.", concrete: false };
  const model = routeFieldModel(robot);
  if (!observeRobotFieldPortalSequence(robot, result.samples).valid || minimumRobotFieldClearance(robot, result.samples) < 0) return { message: "Robot footprint or portal clearance is invalid.", concrete: true };
  const budget = { remaining: 131_072 };
  for (let i = 1; i < result.samples.length; i++) {
    const status = routeSweepStatus(result.samples[i - 1], result.samples[i], model, budget);
    if (status === "collision") return { message: "Continuous exported-pose footprint clearance is invalid (including height and barrier depth).", concrete: true };
    if (status === "unknown") return { message: "Continuous exported-pose footprint clearance is inconclusive (numerical margin or subdivision budget).", concrete: false };
  }
  return undefined;
}

export function routeSafetyFailure(robot: RobotConfig, result: PlannerResult, field: FieldReference = ACTIVE_FIELD_REFERENCE): string | undefined {
  return routeSafetyIssue(robot, result, field)?.message;
}
