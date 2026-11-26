import { ACTIVE_FIELD_REFERENCE } from "../field/rebuilt2026";
import { TRANSIENT_EDITOR_KEYS } from "../project/normalize";
import type { FieldReference, PathDoc, RobotConfig } from "../types";
import { planningRobotForPath } from "../commandLoads";
import { stable } from "./routeGeometry";

/**
 * What a path's plan depends on: its physical content (not its name, folder or export choice),
 * this path's robot (not its cameras, which see the plan but never shape it) and the field. An optimize search result and a remembered duration apply
 * only while the key is unchanged. Nothing saves it.
 */
export function pathPlanningKey(path: PathDoc, robot: RobotConfig, field: FieldReference = ACTIVE_FIELD_REFERENCE): string {
  // Only this path's mechanism reserve matters, so editing another command's load keeps the key.
  const { planning: _planning, footprintPreset: _preset, cameras: _cameras, ...physicalRobot } = planningRobotForPath(robot, path);
  const { id: _id, name: _name, folderId: _folder, exportable: _exportable, ...physical } = path;
  for (const key of TRANSIENT_EDITOR_KEYS) delete (physical as Record<string, unknown>)[key];
  return stable({ version: "path-planning/1", path: physical, robot: physicalRobot, field });
}
