import { planningRobotForPath } from "../commandLoads";
import { robotLimitCeilings } from "../robotLimits";
import type { BordeauxProject, FollowableLimit, RobotConfig } from "../types";

/** A fixed path limit above what the robot allows; planning caps it at `ceiling`. */
export interface LimitAboveRobot { pathId: string; key: FollowableLimit; value: number; ceiling: number }

/**
 * Every fixed path limit above `robot`'s ceiling for that path (its command reserve included), for a project-wide
 * notice. `robot` defaults to the selected robot; pass another robot's details (with its `id`) to preview a switch.
 * Limits that follow the robot are never above it. Acceleration is read as the editor shows it: against the lower of
 * the acceleration and braking ceilings, and the corner limit falls back to acceleration when unset. Zone limits are
 * not checked.
 */
export function limitsAboveRobot(project: BordeauxProject, robot: RobotConfig = project.robot): LimitAboveRobot[] {
  const found: LimitAboveRobot[] = [];
  for (const path of project.paths) {
    const constraints = path.constraints;
    if (!constraints) continue;
    const followed = new Set(constraints.followRobotMax ?? []);
    const ceilings = robotLimitCeilings(planningRobotForPath(robot, path));
    const accelCeiling = Math.min(ceilings.maxAccel ?? Infinity, ceilings.maxDecel ?? Infinity);
    const checks: [FollowableLimit, number | undefined, number | undefined][] = [
      ["maxVel", constraints.maxVel, ceilings.maxVel],
      ["maxAccel", constraints.maxAccel, Number.isFinite(accelCeiling) ? accelCeiling : undefined],
      ["maxCentripetalAccel", constraints.maxCentripetalAccel ?? (followed.has("maxAccel") ? undefined : constraints.maxAccel), ceilings.maxCentripetalAccel],
      ["maxAngVel", constraints.maxAngVel, ceilings.maxAngVel],
      ["maxAngAccel", constraints.maxAngAccel, ceilings.maxAngAccel],
    ];
    for (const [key, value, ceiling] of checks) {
      if (followed.has(key) || value === undefined || ceiling === undefined || !(value > ceiling * (1 + 1e-9))) continue;
      found.push({ pathId: path.id, key, value, ceiling });
    }
  }
  return found;
}
