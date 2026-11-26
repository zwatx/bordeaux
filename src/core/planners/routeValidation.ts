import { physicalPlannerInput } from "../robotLimits";
import { waypointHeadingSemantics } from "../math/waypointHeading";
import { activeAngularLimits, waypointTurnDelta } from "./stationaryActions";
import { ACTIVE_FIELD_REFERENCE } from "../field/rebuilt2026";
import type { FieldReference, PlannerInput, PlannerResult } from "../types";
import { validateFinal } from "./fixedGeometryFinal";
import { getPlanner } from "./index";
import { segmentHeadingLaws } from "./headingTransitions";
import { routePlanningPath, routeTask, routeUnsupportedReason, stable } from "./routeGeometry";
import { routeSafetyIssue } from "./routeSafety";

export interface RouteCandidateIssue {
  message: string;
  /** Observed geometry or explicit required semantics, not inferred profile validity. */
  concrete: boolean;
}

const issue = (message: string, concrete = false): RouteCandidateIssue => ({ message: message || "Route validation failed.", concrete });

/** Check the actual stationary profile, including its continuous quintic maxima.
 * Dense moving validation deliberately excludes these samples. */
function stationaryFailure(input: PlannerInput, result: PlannerResult, reference: PlannerResult): RouteCandidateIssue | undefined {
  const actions = result.stationaryActions ?? [], expected = reference.stationaryActions ?? [];
  if (actions.length !== expected.length || actions.some((a, i) => a.kind !== expected[i].kind || a.waypointIndex !== expected[i].waypointIndex)) return issue("Route omitted or added a stationary action.");
  const physical = physicalPlannerInput(input);
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i], w = input.path.waypoints[action.waypointIndex];
    const samples = result.samples.filter((s) => s.t >= action.startTimeS - 1e-7 && s.t <= action.endTimeS + 1e-7);
    const first = samples[0], last = samples.at(-1);
    if (!w?.stop || !first || !last || Math.abs(first.t - action.startTimeS) > 1e-6 || Math.abs(last.t - action.endTimeS) > 1e-6) return issue("Stationary action boundaries are invalid.");
    const duration = action.endTimeS - action.startTimeS;
    if (action.kind === "wait") {
      if (Math.abs(duration - (w.wait ?? 0)) > 1e-6) return issue("Route changed an exact wait duration.", true);
      continue;
    }
    const expectedEnd = reference.samples.find((s) => Math.abs(s.t - expected[i].endTimeS) < 1e-6);
    if (!expectedEnd) return issue("Stationary turn target is missing.");
    const target = w.turnInPlace ? w.turnInPlace.headingDeg * Math.PI / 180 + (input.path.driveBackward ? Math.PI : 0) : expectedEnd.headingRad;
    const delta = waypointTurnDelta(w, first.headingRad, target);
    const limits = activeAngularLimits(physical.path, action.fraction, action.waypointIndex, result.totalDistanceM);
    const minimum = Math.max(Math.abs(delta) * 1.875 / limits.velocity, Math.sqrt(Math.abs(delta) * 5.77351 / limits.acceleration),
      limits.jerk > 0 ? Math.cbrt(Math.abs(delta) * 60 / limits.jerk) : 0);
    if (duration < minimum - 1e-6) return issue("Stationary turn exceeds physical angular limits.");
    for (const sample of samples.slice(1)) {
      const u = (sample.t - first.t) / duration;
      const heading = first.headingRad + delta * (10 * u ** 3 - 15 * u ** 4 + 6 * u ** 5);
      const velocity = delta * (30 * u ** 2 - 60 * u ** 3 + 30 * u ** 4) / duration;
      if (Math.abs(Math.atan2(Math.sin(sample.headingRad - heading), Math.cos(sample.headingRad - heading))) > 1e-5
        || Math.abs(sample.angularVelocityRadps - velocity) > 1e-5) return issue("Stationary turn samples differ from the required angular profile.");
    }
  }
  return undefined;
}

/**
 * Independent qualification of a route candidate for the path `input.path`: the candidate must be
 * the Normal plan of exactly the path Apply would write, keep every required waypoint, stop and
 * heading, clear the field for this robot, and meet every physical limit.
 */
export function routeCandidateIssue(input: PlannerInput, result: PlannerResult, field: FieldReference = input.field ?? ACTIVE_FIELD_REFERENCE): RouteCandidateIssue | undefined {
  try {
    const unsupported = routeUnsupportedReason(input) ?? routeUnsupportedReason({ ...input, field });
    if (unsupported) return issue(unsupported);
    if (result.optimization?.fallback) {
      return issue(result.optimization.fallbackReason
        || result.diagnostics.find((d) => d.severity === "error")?.message
        || "The planner did not produce a validated route.");
    }
    const error = result.diagnostics.find((d) => d.severity === "error");
    if (error) return issue(error.message, true);
    if (result.samples.length < 2 || !(result.totalTimeS > 0)) return issue("Route trajectory is incomplete.");
    if (!result.routeGeometry) return issue("Route geometry is missing.");
    const path = routePlanningPath(routeTask(input.path).task, result.routeGeometry);
    if (stable(result.optimizedPath) !== stable(path)) return issue("The route's path differs from the one Apply writes.");
    // Ordered sample arrivals are verified directly, never nearest-point fallback.
    const arrivals = result.waypointSampleIndices;
    if (!arrivals || arrivals.length !== path.waypoints.length) return issue("Required arrival mapping is missing.");
    const headingLaws = segmentHeadingLaws(path, input.robot.drive === "tank");
    for (let i = 0; i < arrivals.length; i++) {
      const at = arrivals[i];
      const w = path.waypoints[i], sample = result.samples[at];
      if (!Number.isInteger(at) || !sample || (i > 0 && at <= arrivals[i - 1])) return issue("Required arrival mapping is invalid.");
      if (Math.hypot(sample.x - w.x, sample.y - w.y) > 0.001
        || (w.stop && Math.abs(sample.velocityMps) > 0.001)) return issue("Required waypoint arrival or stop is invalid.", true);
      const turn = result.stationaryActions?.find((a) => a.kind === "turn" && a.waypointIndex === i);
      const incoming = turn ? result.samples.find((s) => Math.abs(s.t - turn.startTimeS) < 1e-6)! : sample;
      if (waypointHeadingSemantics(w, i, headingLaws).arrival) {
        const target = w.theta * Math.PI / 180 + (input.path.driveBackward ? Math.PI : 0);
        if (!incoming) return issue("Required heading arrival sample is missing.");
        if (Math.abs(Math.atan2(Math.sin(incoming.headingRad - target), Math.cos(incoming.headingRad - target))) > 0.002) return issue("An explicit required heading was not met.", true);
      }
    }
    const safety = routeSafetyIssue(input.robot, result, field);
    if (safety) return safety;
    const planningInput = { ...input, path };
    // Remembered by input: the candidate's own plan, so this costs no second solve.
    const reference = getPlanner("profiledSpline").generate(planningInput);
    const stationary = stationaryFailure(planningInput, result, reference);
    if (stationary) return stationary;
    const physics = validateFinal(planningInput, result).failure;
    if (physics) return issue(physics);
    return undefined;
  } catch (error) {
    return issue(error instanceof Error ? error.message : "Route validation failed.");
  }
}

/** Message-only compatibility API for acceptance callers. */
export function routeCandidateFailure(input: PlannerInput, result: PlannerResult, field: FieldReference = input.field ?? ACTIVE_FIELD_REFERENCE): string | undefined {
  return routeCandidateIssue(input, result, field)?.message;
}
