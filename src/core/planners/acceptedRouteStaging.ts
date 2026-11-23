import { ACTIVE_FIELD_REFERENCE } from "../field/rebuilt2026";
import { clone } from "../project/defaults";
import type { FieldReference, PathDoc, PlannerResult, RobotConfig } from "../types";
import { acceptedTrajectoryShapeError } from "./acceptedTrajectoryIdentity";
import { DEFAULT_SAMPLES_PER_SEGMENT } from "./limits";
import { routeIntentKey } from "./routeIdentity";

/** Pure staging for a worker-qualified exact result. This does not run physics;
 * independent numerical validation remains mandatory at the export boundary. */
export function stageAcceptedRouteTrajectory(
  path: PathDoc, robot: RobotConfig, result: PlannerResult,
  field: FieldReference = ACTIVE_FIELD_REFERENCE, samplesPerSegment = DEFAULT_SAMPLES_PER_SEGMENT,
): PathDoc {
  const accepted = { version: 2 as const, inputKey: routeIntentKey(path, robot, field), samplesPerSegment, result: clone(result) };
  const failure = acceptedTrajectoryShapeError(accepted);
  if (failure || result.diagnostics.some((issue) => issue.severity === "error")) {
    throw new Error(`The route could not be staged: ${failure ?? "Trajectory has error diagnostics."}`);
  }
  const previous = path.optimization?.accepted;
  return { ...path, optimization: { ...path.optimization,
    ...(previous?.version === 1 ? { legacyAccepted: clone(previous) as typeof previous & { version: 1 } } : {}), accepted } };
}
