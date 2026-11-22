import type { ControlPoint, RobotConfig } from "../types";

const EPSILON = 1e-9;

export interface FootprintPose {
  x: number;
  y: number;
  headingRad: number;
}

export interface Bounds2d {
  min: ControlPoint;
  max: ControlPoint;
}

/** Robot-local bumper polygon. +X is forward and +Y is left. */
export function robotFootprintVertices(robot: RobotConfig): ControlPoint[] {
  if (robot.footprint?.kind === "polygon") return robot.footprint.verticesM.map((point) => ({ ...point }));
  const halfLength = robot.l / 2;
  const halfWidth = robot.w / 2;
  return [
    { x: -halfLength, y: -halfWidth },
    { x: halfLength, y: -halfWidth },
    { x: halfLength, y: halfWidth },
    { x: -halfLength, y: halfWidth },
  ];
}

export function robotFootprintRadius(robot: RobotConfig): number {
  return robotFootprintVertices(robot).reduce((radius, point) => Math.max(radius, Math.hypot(point.x, point.y)), 0);
}

export function transformFootprint(vertices: readonly ControlPoint[], pose: FootprintPose): ControlPoint[] {
  const cosine = Math.cos(pose.headingRad);
  const sine = Math.sin(pose.headingRad);
  return vertices.map((point) => ({
    x: pose.x + point.x * cosine - point.y * sine,
    y: pose.y + point.x * sine + point.y * cosine,
  }));
}

export function robotFootprintAt(robot: RobotConfig, pose: FootprintPose): ControlPoint[] {
  return transformFootprint(robotFootprintVertices(robot), pose);
}

export function polygonBounds(vertices: readonly ControlPoint[]): Bounds2d {
  const bounds = {
    min: { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY },
    max: { x: Number.NEGATIVE_INFINITY, y: Number.NEGATIVE_INFINITY },
  };
  for (const point of vertices) {
    bounds.min.x = Math.min(bounds.min.x, point.x);
    bounds.min.y = Math.min(bounds.min.y, point.y);
    bounds.max.x = Math.max(bounds.max.x, point.x);
    bounds.max.y = Math.max(bounds.max.y, point.y);
  }
  return bounds;
}

export function verticalLineSection(vertices: readonly ControlPoint[], x: number): { minY: number; maxY: number } | null {
  const intersections: number[] = [];
  vertices.forEach((first, index) => {
    const second = vertices[(index + 1) % vertices.length];
    const low = Math.min(first.x, second.x) - EPSILON;
    const high = Math.max(first.x, second.x) + EPSILON;
    if (x < low || x > high) return;
    const dx = second.x - first.x;
    if (Math.abs(dx) <= EPSILON) {
      if (Math.abs(x - first.x) <= EPSILON) intersections.push(first.y, second.y);
      return;
    }
    const ratio = (x - first.x) / dx;
    if (ratio >= -EPSILON && ratio <= 1 + EPSILON) intersections.push(first.y + (second.y - first.y) * ratio);
  });
  if (intersections.length === 0) return null;
  return { minY: Math.min(...intersections), maxY: Math.max(...intersections) };
}

export function footprintVerticalSpan(robot: RobotConfig, headingRad: number): { minY: number; maxY: number } {
  const bounds = polygonBounds(transformFootprint(robotFootprintVertices(robot), { x: 0, y: 0, headingRad }));
  return { minY: bounds.min.y, maxY: bounds.max.y };
}

function pointSegmentDistance(point: ControlPoint, first: ControlPoint, second: ControlPoint): number {
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= EPSILON) return Math.hypot(point.x - first.x, point.y - first.y);
  const ratio = Math.max(0, Math.min(1, ((point.x - first.x) * dx + (point.y - first.y) * dy) / lengthSquared));
  return Math.hypot(point.x - first.x - ratio * dx, point.y - first.y - ratio * dy);
}

function axes(vertices: readonly ControlPoint[]): ControlPoint[] {
  return vertices.flatMap((first, index) => {
    const second = vertices[(index + 1) % vertices.length];
    const dx = second.x - first.x;
    const dy = second.y - first.y;
    const length = Math.hypot(dx, dy);
    return length <= EPSILON ? [] : [{ x: -dy / length, y: dx / length }];
  });
}

function projection(vertices: readonly ControlPoint[], axis: ControlPoint): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const point of vertices) {
    const value = point.x * axis.x + point.y * axis.y;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return { min, max };
}

/** Signed convex-polygon clearance: positive when separate, negative when overlapping. */
export function convexPolygonClearance(first: readonly ControlPoint[], second: readonly ControlPoint[]): number {
  const separatingAxes = [...axes(first), ...axes(second)];
  let minimumOverlap = Number.POSITIVE_INFINITY;
  let separated = false;
  for (const axis of separatingAxes) {
    const a = projection(first, axis);
    const b = projection(second, axis);
    const overlap = Math.min(a.max, b.max) - Math.max(a.min, b.min);
    if (overlap < -EPSILON) { separated = true; break; }
    else minimumOverlap = Math.min(minimumOverlap, Math.max(0, overlap));
  }
  if (!separated) return -minimumOverlap;

  let minimumDistance = Number.POSITIVE_INFINITY;
  first.forEach((point) => second.forEach((edge, index) => {
    minimumDistance = Math.min(minimumDistance, pointSegmentDistance(point, edge, second[(index + 1) % second.length]));
  }));
  second.forEach((point) => first.forEach((edge, index) => {
    minimumDistance = Math.min(minimumDistance, pointSegmentDistance(point, edge, first[(index + 1) % first.length]));
  }));
  return minimumDistance;
}

export function boundsPolygon(bounds: Bounds2d): ControlPoint[] {
  return [
    { x: bounds.min.x, y: bounds.min.y },
    { x: bounds.max.x, y: bounds.min.y },
    { x: bounds.max.x, y: bounds.max.y },
    { x: bounds.min.x, y: bounds.max.y },
  ];
}

export function footprintBoundsClearance(vertices: readonly ControlPoint[], width: number, height: number): number {
  return vertices.reduce((clearance, point) => Math.min(clearance, point.x, width - point.x, point.y, height - point.y), Number.POSITIVE_INFINITY);
}

export function interpolateHeading(first: number, second: number, ratio: number): number {
  const delta = Math.atan2(Math.sin(second - first), Math.cos(second - first));
  return first + delta * ratio;
}
