import { ACTIVE_FIELD_REFERENCE } from "../field/rebuilt2026";
import type { FieldReference, PathDoc, RobotConfig } from "../types";
import { optimizationIntentKey, physicalPath, stable } from "./acceptedTrajectoryIdentity";

/** Selection depends on the task, not the seed or retained legacy search settings. */
export function routeIntentKey(path: PathDoc, robot: RobotConfig, field: FieldReference = ACTIVE_FIELD_REFERENCE): string {
  const { planning: _planning, footprintPreset: _preset, ...physicalRobot } = robot;
  const task = { ...path, waypoints: path.waypoints.map(({ linked: _linked, corner: _corner, ...waypoint }) => ({ ...waypoint, linked: true })) };
  return stable({ version: "route-selection/4", path: optimizationIntentKey(task), robot: physicalRobot, field });
}

/** In-flight work always retires on seed changes, even if an applied route remains valid. */
export function routeInputKey(path: PathDoc, robot: RobotConfig, field: FieldReference = ACTIVE_FIELD_REFERENCE): string {
  return stable({ version: "route-job/1", intent: routeIntentKey(path, robot, field), seed: physicalPath(path), handles: path.waypoints.map(({ prevC, nextC, linked, corner }) => ({ prevC, nextC, linked, corner })) });
}
