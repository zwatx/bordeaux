import { ACTIVE_FIELD_REFERENCE } from "../field/rebuilt2026";
import { TRANSIENT_EDITOR_KEYS, normalizeProject } from "../project/normalize";
import type { FieldReference, PathDoc, RobotConfig } from "../types";
import { routeIntentKey } from "./routeIdentity";
import { routeGeometryShapeError } from "./routeGeometry";
import { MAX_TRAJECTORY_SAMPLES } from "./limits";

// 2: drive models use the electrical motor envelope (current limit, battery sag) by default.
// 3: per-wheel traction follows quasi-static load transfer from the CG height (default 0.25 m).
// 4: shared-bus validation, brownout margin, and stator loss-current accounting.
const PLANNER_VERSION = "corridor-selection/4";
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Stable across JSON object ordering; do not round trajectory-affecting numbers. */
export function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item) => record(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
    : item);
}

export function authoredPath(path: PathDoc): PathDoc {
  const { optimization: _optimization, ...authored } = path;
  return authored;
}

export function physicalPath(path: PathDoc) {
  const normalized = normalizeProject({ paths: [authoredPath(path)] }) as { paths: PathDoc[] };
  const { id: _id, name: _name, folderId: _folder, exportable: _exportable, ...physical } = normalized.paths[0];
  for (const key of TRANSIENT_EDITOR_KEYS) delete (physical as Record<string, unknown>)[key];
  return physical;
}

export function optimizationInputKey(path: PathDoc, robot: RobotConfig, field: FieldReference = ACTIVE_FIELD_REFERENCE): string {
  const { planning: _planning, footprintPreset: _preset, ...physicalRobot } = robot;
  return stable({ version: PLANNER_VERSION, field, path: physicalPath(path), robot: physicalRobot, corridorM: path.optimization?.corridorM ?? 0.15 });
}

/** Changed inputs use normal planning; a corrupt artifact for current inputs still requires review. */
export function isOptimizationOutdated(path: PathDoc, robot: RobotConfig, field: FieldReference = ACTIVE_FIELD_REFERENCE): boolean {
  const key = path.optimization?.accepted?.inputKey;
  return typeof key === "string" && key.length > 0 && key !== (path.optimization?.accepted?.version === 2 ? routeIntentKey(path, robot, field) : optimizationInputKey(path, robot, field));
}

/** Structural checks are also used at the project file boundary, before any planner work. */
export function acceptedTrajectoryShapeError(value: unknown): string | null {
  if (!record(value) || (value.version !== 1 && value.version !== 2) || typeof value.inputKey !== "string" || value.inputKey.length > 4_000_000
    || !Number.isInteger(value.samplesPerSegment) || Number(value.samplesPerSegment) < 1 || Number(value.samplesPerSegment) > 448) return "Accepted trajectory identity or version is invalid";
  const result = value.result;
  if (value.version === 2 && (!record(result) || routeGeometryShapeError(result.routeGeometry))) return "Accepted route geometry is invalid";
  if (!record(result) || !["profiledSpline", "optimizedTrajectory"].includes(String(result.planner))
    || !finite(result.totalTimeS) || result.totalTimeS <= 0 || !finite(result.totalDistanceM) || result.totalDistanceM < 0
    || !Array.isArray(result.samples) || result.samples.length < 2 || result.samples.length > MAX_TRAJECTORY_SAMPLES
    || !Array.isArray(result.markers) || result.markers.length > 4096
    || !Array.isArray(result.diagnostics) || result.diagnostics.length > 4096) return "Accepted trajectory output is invalid or exceeds supported limits";
  const numericFields = ["i", "t", "s", "f", "x", "y", "headingRad", "velocityMps", "accelerationMps2", "angularVelocityRadps", "curvatureInvM"];
  for (let index = 0; index < result.samples.length; index += 1) {
    const sample = result.samples[index];
    const before = result.samples[index - 1];
    if (!record(sample) || numericFields.some((key) => !finite(sample[key])) || sample.i !== index
      || Number(sample.t) < 0 || Number(sample.s) < 0 || Number(sample.f) < 0 || Number(sample.f) > 1
      || (before && (Number(sample.t) <= before.t || Number(sample.s) < before.s - 1e-6 || Number(sample.f) < before.f - 1e-6))) return "Accepted trajectory samples must be finite and ordered";
  }
  for (let index = 1; index < result.samples.length; index += 1) {
    const before = result.samples[index - 1], sample = result.samples[index];
    const distance = sample.s - before.s;
    const integrated = (Math.abs(before.velocityMps) + Math.abs(sample.velocityMps)) * (sample.t - before.t) / 2;
    if (Math.hypot(sample.x - before.x, sample.y - before.y) > distance + 0.002
      || Math.abs(distance - integrated) > Math.max(0.001, distance * 0.02)) return "Accepted trajectory timing does not match its motion";
  }
  const first = result.samples[0], last = result.samples.at(-1);
  if (Math.abs(first.t) > 1e-6 || Math.abs(first.f) > 1e-6 || Math.abs(last.f - 1) > 1e-6
    || Math.abs(last.t - result.totalTimeS) > 1e-6 || Math.abs(last.s - result.totalDistanceM) > 0.001) return "Accepted trajectory totals do not match its samples";
  if (result.markers.some((marker) => !record(marker) || typeof marker.id !== "string" || typeof marker.name !== "string"
    || !(marker.command === null || typeof marker.command === "string") || !(marker.group === null || typeof marker.group === "string")
    || !finite(marker.timeS) || marker.timeS < 0 || marker.timeS > Number(result.totalTimeS) + 1e-5
    || !finite(marker.fraction) || marker.fraction < 0 || marker.fraction > 1)) return "Accepted trajectory markers are invalid";
  if (result.diagnostics.some((item) => !record(item) || !["warning", "error"].includes(String(item.severity))
    || typeof item.path !== "string" || typeof item.message !== "string")) return "Accepted trajectory diagnostics are invalid";
  if (!record(result.optimization) || result.optimization.fallback !== false || result.optimization.constraintViolations !== 0
    || !["optimal", "feasible", "equivalent"].includes(String(result.optimization.status))) return "Accepted trajectory was not validated successfully";
  const refinement = result.optimization.refinementPasses;
  if (refinement !== undefined && (!Number.isInteger(refinement) || Number(refinement) < 0 || Number(refinement) > 3)) return "Accepted trajectory refinement is invalid";
  if (result.optimizedPath !== undefined && (!record(result.optimizedPath) || result.optimizedPath.optimization !== undefined
    || !Array.isArray(result.optimizedPath.waypoints) || result.optimizedPath.waypoints.length > 4096
    || result.optimizedPath.waypoints.some((waypoint) => !record(waypoint) || !finite(waypoint.x) || !finite(waypoint.y)
      || [waypoint.prevC, waypoint.nextC].some((point) => point !== undefined && (!record(point) || !finite(point.x) || !finite(point.y)))))) return "Accepted trajectory geometry is invalid";
  if (result.stationaryActions !== undefined && (!Array.isArray(result.stationaryActions) || result.stationaryActions.length > 12288
    || result.stationaryActions.some((action) => !record(action) || !["turn", "wait", "jiggle"].includes(String(action.kind))
      || !Number.isInteger(action.waypointIndex) || Number(action.waypointIndex) < 0
      || !finite(action.fraction) || action.fraction < 0 || action.fraction > 1
      || !finite(action.startTimeS) || !finite(action.endTimeS) || action.startTimeS < 0 || action.endTimeS <= action.startTimeS
      || action.endTimeS > Number(result.totalTimeS) + 1e-6))) return "Accepted trajectory actions are invalid";
  return null;
}

export function optimizationIntentKey(path: PathDoc): string {
  const physical = physicalPath(path);
  return stable({ ...physical, waypoints: physical.waypoints.map(({ prevC: _previous, nextC: _next, ...waypoint }) => waypoint) });
}
