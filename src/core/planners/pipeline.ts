import type { PlannerInput, PlannerResult, RobotConfig } from "../types";
import { effectivePathConstraints, robotHardLimits } from "../robotLimits";
import { addAngularLimitDiagnostics, enforceAngularTiming } from "./angularConstraints";
import { addJerkDiagnostics } from "./jerkDiagnostics";
import { applyRotationPriority } from "./rotationPriority";
import { applyStationaryActions } from "./stationaryActions";

export function preparePlannerInput(input: PlannerInput): {
  path: PlannerInput["path"];
  robot: RobotConfig;
  planningInput: PlannerInput;
} {
  const maxAngDecel = input.path.constraints.maxAngDecel;
  if (maxAngDecel !== undefined && !Number.isFinite(maxAngDecel)) {
    throw new Error("maxAngDecel must be a finite number");
  }
  if (maxAngDecel !== undefined && maxAngDecel <= 0) {
    throw new Error("maxAngDecel must be greater than zero");
  }
  const hardLimits = robotHardLimits(input.robot);
  const robot = hardLimits ? { ...input.robot, maxSpeed: hardLimits.maxSpeedMps } : input.robot;
  const constraints = effectivePathConstraints(input.path.constraints, robot);
  const path = constraints === input.path.constraints ? input.path : { ...input.path, constraints };
  const physicalInput = path === input.path && robot === input.robot ? input : { ...input, path, robot };
  const hasStationaryPause = path.waypoints.some((waypoint) => waypoint.turnInPlace || (waypoint.stop && (waypoint.wait ?? 0) > 0));
  const planningInput = hasStationaryPause
    ? {
        ...physicalInput,
        path: {
          ...path,
          waypoints: path.waypoints.map((waypoint) => waypoint.stop && (waypoint.wait ?? 0) > 0 ? { ...waypoint, wait: 0 } : waypoint),
        },
      }
    : physicalInput;
  return { path, robot, planningInput };
}

export function finalizePlannerResult(
  path: PlannerInput["path"],
  robot: RobotConfig,
  generated: PlannerResult,
): PlannerResult {
  return addAngularLimitDiagnostics(path, addJerkDiagnostics(path, finalizePlannerMotion(path, robot, generated)));
}

/** Applies the shared motion transforms without export-only diagnostics. */
export function finalizePlannerMotion(
  path: PlannerInput["path"],
  robot: RobotConfig,
  generated: PlannerResult,
): PlannerResult {
  const prioritized = applyRotationPriority(path, generated, robot);
  return applyStationaryActions(path, enforceAngularTiming(path, prioritized, true), robot);
}
