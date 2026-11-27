import type { FieldTag } from "../tagVisibility";
import type { PlannerInput } from "../types";

// Kept apart from the search itself, which loads the planner: the editor asks this on its main thread.

/** Why a path has nothing for the heading search to work on. */
export type HeadingForTagsBlocker = "no-cameras" | "no-tags" | "tank" | "no-free-heading";

/**
 * Why the heading search cannot work on a path at all, or nothing when it can: the robot has no cameras, the field
 * has no tags, the robot drives tank (its heading follows the path), or no stretch of the path uses the "targets"
 * heading rule, the only one that leaves the robot free to face any way.
 */
export function headingForTagsBlocker({ path, robot }: PlannerInput, tags: readonly FieldTag[]): HeadingForTagsBlocker | null {
  if (!robot.cameras?.length) return "no-cameras";
  if (!tags.length) return "no-tags";
  if (robot.drive === "tank") return "tank";
  const free = path.waypoints.slice(0, -1).some((waypoint) => (waypoint.segmentHeadingMode || path.headingMode || "targets") === "targets");
  return free ? null : "no-free-heading";
}
