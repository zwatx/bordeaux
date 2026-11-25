import type { PlannerInput, PlannerResult, RouteGeometry } from "../types";
import { optimizeFixedGeometryFinal } from "./fixedGeometryFinal";
import { fixedGeometryFirstPassTime, getPlanner } from "./index";
import { geometryFromPath, routePlanningPath, routeResultToSource } from "./routeGeometry";
import { routeCandidateFailure, routeCandidateIssue } from "./routeValidation";

/**
 * A candidate is dropped after its first timing solve when that is this far above
 * the time it must beat. The final time of a curve has measured at most 2.3%
 * below its first pass (1.0% among valid curves) over the 784 candidates of the
 * optimizer eval scenarios on two robots, so 5% leaves a factor of two.
 */
const FIRST_PASS_GUARD = 0.05;
export const NOT_FASTER = "Not faster than the current result.";

/** What the search already holds when it evaluates a candidate. */
export interface RouteCandidateLimits {
  /** The total time a candidate must beat to replace the incumbent. */
  timeToBeat: number;
  /** The total time a candidate must beat for the search to return it instead of Normal. */
  timeToMatter: number;
}

export type RouteCandidateOutcome =
  | { status: "valid"; candidate: PlannerResult }
  | { status: "rejected"; reason: string };

export type RouteSeedOutcome =
  | { status: "valid"; normal: PlannerResult }
  | { status: "rejected"; reason: string; concrete: boolean };

/**
 * Route qualification requires a successfully validated optimization record.
 * The search replaces the status and adds its own counters before publishing.
 */
function asRouteResult(result: PlannerResult): PlannerResult {
  return { ...result, optimization: {
    plannerUsed: result.planner, totalTimeS: result.totalTimeS,
    maxVelocityMps: Math.max(...result.samples.map((sample) => Math.abs(sample.velocityMps))),
    maxAccelerationMps2: Math.max(...result.samples.map((sample) => Math.abs(sample.accelerationMps2))),
    constraintViolations: 0, fallback: false, solveTimeMs: 0, ...result.optimization,
    status: "feasible", optimizationClass: "route",
  } };
}

/**
 * Plans and qualifies one candidate curve. A candidate that cannot replace the
 * incumbent is rejected without a full plan when its first pass is clearly too
 * slow, and without qualification otherwise: it changes nothing, valid or not.
 * Stale (looser) limits only cost time; they never change which candidates are
 * valid. Pure, so a search may run it on any thread.
 */
export function evaluateRouteCandidate(
  source: PlannerInput,
  geometry: RouteGeometry,
  limits: RouteCandidateLimits,
): RouteCandidateOutcome {
  try {
    const path = routePlanningPath(source.path, geometry);
    const planning = { ...source, path };
    // The full plan below reuses this first solve, so the probe costs a surviving candidate nothing.
    const firstPassTimeS = Number.isFinite(limits.timeToMatter) ? fixedGeometryFirstPassTime(planning) : null;
    if (firstPassTimeS !== null && firstPassTimeS > limits.timeToMatter * (1 + FIRST_PASS_GUARD)) {
      return { status: "rejected", reason: NOT_FASTER };
    }
    const candidate = asRouteResult(routeResultToSource(optimizeFixedGeometryFinal(planning), geometry, path));
    if (!(candidate.totalTimeS < limits.timeToBeat)) return { status: "rejected", reason: NOT_FASTER };
    const failure = routeCandidateFailure(source, candidate);
    return failure ? { status: "rejected", reason: failure } : { status: "valid", candidate };
  } catch (error) {
    return { status: "rejected", reason: error instanceof Error ? error.message : "Route evaluation failed." };
  }
}

/**
 * The first-pass time of one candidate curve, or infinity when it cannot be
 * timed. Ranks curves for a descent that has not chosen which to plan in full.
 */
export function probeRouteCandidate(source: PlannerInput, geometry: RouteGeometry): number {
  try {
    return fixedGeometryFirstPassTime({ ...source, path: routePlanningPath(source.path, geometry) }) ?? Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Plans the drawn curve with the Normal planner and qualifies it as a route. */
export function qualifyRouteSeed(source: PlannerInput): RouteSeedOutcome {
  try {
    const seed = geometryFromPath(source.path);
    const path = routePlanningPath(source.path, seed);
    const normal = asRouteResult(routeResultToSource(getPlanner("profiledSpline").generate(source), seed, path));
    const failure = routeCandidateIssue(source, normal);
    return failure
      ? { status: "rejected", reason: failure.message, concrete: failure.concrete }
      : { status: "valid", normal };
  } catch (error) {
    return { status: "rejected", reason: error instanceof Error ? error.message : "Normal qualification failed.", concrete: false };
  }
}

/**
 * Runs both evaluations above on the drawn curve and discards the results, so a
 * new thread compiles the planner before a search needs it.
 */
export function warmRouteEvaluation(source: PlannerInput): void {
  qualifyRouteSeed(source);
  evaluateRouteCandidate(source, geometryFromPath(source.path), { timeToBeat: Number.POSITIVE_INFINITY, timeToMatter: Number.POSITIVE_INFINITY });
}
