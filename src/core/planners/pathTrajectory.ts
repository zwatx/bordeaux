import type { PathDoc, PlannerResult, RobotConfig } from "../types";
import { getPlanner } from "./index";

/**
 * A path's trajectory for a robot: Normal planning on the path's own waypoints. Export, agent
 * analysis and the editor's planning all use this planner, so they agree on every sample.
 */
export function pathTrajectory(path: PathDoc, robot: RobotConfig): PlannerResult {
  return getPlanner("profiledSpline").generate({ path, robot });
}
