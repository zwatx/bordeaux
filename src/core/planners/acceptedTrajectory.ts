import { ACTIVE_FIELD_REFERENCE } from "../field/rebuilt2026";
import { clone } from "../project/defaults";
import { markersMatch, stationaryActionsMatch } from "./acceptedTrajectoryChecks";
import type { FieldReference, PathDoc, PlannerResult, RobotConfig } from "../types";
import { validateCorridorCandidate } from "./corridorFinal";
import { invariantFailure, validateFinal } from "./fixedGeometryFinal";
import { getPlanner } from "./index";
import { stageAcceptedRouteTrajectory } from "./acceptedRouteStaging";
import { routeIntentKey } from "./routeIdentity";
import { routeCandidateFailure } from "./routeValidation";
import { DEFAULT_SAMPLES_PER_SEGMENT } from "./limits";
import {
  acceptedTrajectoryShapeError,
  authoredPath,
  isOptimizationOutdated,
  optimizationInputKey,
  optimizationIntentKey,
} from "./acceptedTrajectoryIdentity";

export { acceptedTrajectoryShapeError, authoredPath, optimizationInputKey } from "./acceptedTrajectoryIdentity";
type AcceptedTrajectory = NonNullable<NonNullable<PathDoc["optimization"]>["accepted"]>;

export function getAcceptedTrajectory(path: PathDoc, robot: RobotConfig, field: FieldReference = ACTIVE_FIELD_REFERENCE): PlannerResult | null {
  const accepted = path.optimization?.accepted;
  if (!accepted) return null;
  try {
    if (accepted.version === 2) {
      if (accepted.inputKey !== routeIntentKey(path, robot, field)) return null;
      return routeCandidateFailure({ path: authoredPath(path), robot, samplesPerSegment: accepted.samplesPerSegment }, accepted.result, field) ? null : accepted.result;
    }
    if (accepted.inputKey !== optimizationInputKey(path, robot, field)) return null;
    if (acceptedTrajectoryShapeError(accepted)) return null;
    const result = accepted.result;
    const authored = authoredPath(path);
    const geometry = result.optimizedPath ?? authored;
    if (optimizationIntentKey(authored) !== optimizationIntentKey(geometry) || !markersMatch(authored, result) || !stationaryActionsMatch(authored, robot, result)) return null;
    const input = { path: geometry, robot, samplesPerSegment: accepted.samplesPerSegment };
    const baseline = getPlanner("profiledSpline").generate({ ...input, path: authored });
    const geometryReference = geometry === authored ? baseline : getPlanner("profiledSpline").generate(input);
    if (invariantFailure(input, geometryReference, result) || validateFinal(input, result).failure) return null;
    if (!validateCorridorCandidate({ ...input, path: authored }, result, { corridorM: path.optimization?.corridorM ?? 0.15 }, baseline)) return null;
    return result;
  } catch {
    // Invalid current-input artifacts require explicit review at the export boundary.
    return null;
  }
}

/** The trajectory export and analysis drive: the applied optimization for current inputs, otherwise normal planning. */
export function selectPathTrajectory(path: PathDoc, robot: RobotConfig, field: FieldReference = ACTIVE_FIELD_REFERENCE): PlannerResult {
  const accepted = getAcceptedTrajectory(path, robot, field);
  if (accepted) return accepted;
  if (path.optimization?.accepted && !isOptimizationOutdated(path, robot, field)) {
    throw new Error(`${path.name}: The applied optimization is invalid. Choose Use normal or optimize and apply again before exporting.`);
  }
  return getPlanner("profiledSpline").generate({ path: authoredPath(path), robot });
}

export function createAcceptedTrajectory(
  path: PathDoc,
  robot: RobotConfig,
  result: PlannerResult,
  field: FieldReference = ACTIVE_FIELD_REFERENCE,
  samplesPerSegment = DEFAULT_SAMPLES_PER_SEGMENT,
): AcceptedTrajectory {
  const accepted: AcceptedTrajectory = {
    version: 1,
    inputKey: optimizationInputKey(path, robot, field),
    samplesPerSegment,
    result: clone({ ...result, optimizedPath: result.optimizedPath ? authoredPath(result.optimizedPath) : undefined }),
  };
  const selected = { ...path, optimization: { corridorM: path.optimization?.corridorM ?? 0.15, accepted } };
  if (!getAcceptedTrajectory(selected, robot, field)) throw new Error("The optimization no longer matches this path or failed validation. Run Optimize again.");
  return accepted;
}

/** Explicit new-model selection, validated independently of search diagnostics. */
export function createAcceptedRouteTrajectory(
  path: PathDoc, robot: RobotConfig, result: PlannerResult,
  field: FieldReference = ACTIVE_FIELD_REFERENCE, samplesPerSegment = DEFAULT_SAMPLES_PER_SEGMENT,
): AcceptedTrajectory {
  return applyAcceptedRouteTrajectory(path, robot, result, field, samplesPerSegment).optimization!.accepted!;
}

/** Keep the authored seed and the legacy artifact durably; active accepted wins. */
export function applyAcceptedRouteTrajectory(
  path: PathDoc, robot: RobotConfig, result: PlannerResult,
  field: FieldReference = ACTIVE_FIELD_REFERENCE, samplesPerSegment = DEFAULT_SAMPLES_PER_SEGMENT,
): PathDoc {
  const failure = routeCandidateFailure({ path: authoredPath(path), robot, samplesPerSegment }, result, field);
  if (failure) throw new Error(`The route could not be accepted: ${failure}`);
  return stageAcceptedRouteTrajectory(path, robot, result, field, samplesPerSegment);
}
