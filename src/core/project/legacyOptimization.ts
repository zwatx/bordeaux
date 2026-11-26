import { planningRobotForPath } from "../commandLoads";
import { ACTIVE_FIELD_REFERENCE } from "../field/rebuilt2026";
import { pathTrajectory } from "../planners/pathTrajectory";
import { applyRoute, stable } from "../planners/routeGeometry";
import { routeSafetyIssue } from "../planners/routeSafety";
import type { BordeauxProject, PathDoc, RouteGeometry, Waypoint } from "../types";
import { normalizeWaypoints } from "./normalize";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Rebuild only geometry from the old output; never import its stored timing or waypoint actions. */
function migratePath(path: PathDoc, accepted: Record<string, unknown>, settings: Record<string, unknown>,
  project: BordeauxProject, fieldChanged: boolean): PathDoc {
  const review: PathDoc = { ...path, optimizationNeedsReview: true };
  const result = record(accepted.result);
  if (fieldChanged || accepted.requiresFieldReview || !result || typeof accepted.inputKey !== "string") return review;

  const { id, name, folderId, exportable, ...physical } = path;
  const { planning, footprintPreset, ...robot } = planningRobotForPath(project.robot, path);
  const field = project.field ?? ACTIVE_FIELD_REFERENCE;
  const route = accepted.version === 2;
  if (!route && accepted.version !== 1) return review;
  const key = route
    ? stable({ version: "route-selection/5", path: stable({ ...physical,
      waypoints: path.waypoints.map(({ prevC, nextC, linked, corner, ...waypoint }, index, points) => ({
        ...waypoint, linked: true, ...(!waypoint.stop && index > 0 && index < points.length - 1 ? { corner: false } : {}),
      })) }), robot, field })
    : stable({ version: "corridor-selection/4", path: physical, robot, field, corridorM: settings.corridorM ?? 0.15 });
  try {
    // The old editor already used the drawn curve when an applied result's inputs were stale.
    if (!record(JSON.parse(accepted.inputKey))) return review;
    if (accepted.inputKey !== key) return path;
    let next: PathDoc;
    if (route) {
      next = applyRoute(path, result.routeGeometry as RouteGeometry);
    } else {
      const waypoints = record(result.optimizedPath)?.waypoints;
      if (waypoints === undefined && result.optimizedPath === undefined) return path;
      if (!Array.isArray(waypoints) || waypoints.length !== path.waypoints.length) return review;
      next = { ...path, waypoints: normalizeWaypoints(path.waypoints.map((waypoint, index) => {
        const saved = record(waypoints[index]);
        const prevC = record(saved?.prevC), nextC = record(saved?.nextC);
        if (!saved || saved.x !== waypoint.x || saved.y !== waypoint.y || !prevC || !nextC
          || ![prevC.x, prevC.y, nextC.x, nextC.y].every(Number.isFinite)) throw new Error("Invalid saved handles");
        return { ...waypoint, prevC: { x: prevC.x, y: prevC.y }, nextC: { x: nextC.x, y: nextC.y } };
      })) as Waypoint[] };
    }
    const plan = pathTrajectory(next, project.robot);
    if (plan.samples.length < 2 || plan.diagnostics.some(({ severity }) => severity === "error")
      || routeSafetyIssue(project.robot, plan, field)) return review;
    return next;
  } catch {
    return review;
  }
}

export function migrateLegacyOptimizations(project: BordeauxProject, source: unknown, fieldChanged: boolean): BordeauxProject {
  const raw = record(source)?.paths;
  if (!Array.isArray(raw)) return project;
  let migrated = false;
  const paths = project.paths.map((path, index) => {
    const settings = record(record(raw[index])?.optimization);
    if (!settings || settings.accepted == null) return path;
    migrated = true;
    const accepted = record(settings.accepted);
    return accepted ? migratePath(path, accepted, settings, project, fieldChanged) : { ...path, optimizationNeedsReview: true as const };
  });
  return migrated ? { ...project, paths } : project;
}
