import { clone } from "../project/defaults";
import type { PlannerInput, PlannerOptimizationDiagnostics, PlannerResult } from "../types";
import { authoredPath, stable } from "./acceptedTrajectoryIdentity";
import type { CorridorSearchStatistics } from "./corridorFinal";
import { optimizeFixedGeometryFinal } from "./fixedGeometryFinal";
import { getPlanner } from "./index";
import { routeCandidates } from "./routeCandidates";
import { geometryFromPath, routePlanningPath, routeResultToSource, routeUnsupportedReason } from "./routeGeometry";
import { routeCandidateFailure, routeCandidateIssue } from "./routeValidation";

export interface RouteFinalOptions {
  budgetTier?: "common" | "stress" | "hard";
  budgetMs?: number;
  maximumEvaluations?: number;
  isCancelled?: () => boolean;
  onProgress?: (candidate: PlannerResult) => void;
  onStatistics?: (statistics: CorridorSearchStatistics) => void;
}
export interface RouteSearchResult {
  candidate?: PlannerResult;
  baseline?: PlannerResult;
  seedStatus: "unknown" | "valid" | "invalid";
  /** Why the drawn curve itself was rejected, when it concretely was. */
  seedIssue?: string;
  status: "feasible" | "no-candidate" | "unsupported" | "cancelled";
  reason?: string;
  termination: NonNullable<PlannerOptimizationDiagnostics["termination"]>;
  statistics: CorridorSearchStatistics;
}

/** Task-based route selection. Legacy strict/corridor search is unchanged. */
export function optimizeRouteFinal(input: PlannerInput, options: RouteFinalOptions = {}): RouteSearchResult {
  const start = performance.now();
  const tier = options.budgetTier ?? "common";
  const budget = Math.max(1, Math.min(30_000, Number.isFinite(options.budgetMs) ? options.budgetMs! : ({ common: 5000, stress: 15000, hard: 30000 })[tier]));
  const maximum = Math.max(1, Math.min(72, Math.floor(Number.isFinite(options.maximumEvaluations) ? options.maximumEvaluations! : ({ common: 24, stress: 48, hard: 72 })[tier])));
  let evaluations = 0;
  let validatedCandidates = 0;
  let rejectedCandidates = 0;
  let longestCandidateMs = 0;
  let termination: RouteSearchResult["termination"] | undefined;
  let seedStatus: RouteSearchResult["seedStatus"] = "unknown";
  let seedIssue: string | undefined;
  let best: PlannerResult | undefined;
  let baseline: PlannerResult | undefined;
  const reasons = new Map<string, number>();
  const statistics = (): CorridorSearchStatistics => ({
    solveTimeMs: performance.now() - start, evaluations, validatedCandidates, rejectedCandidates,
    rejectionReasons: [...reasons].map(([reason, count]) => ({ reason, count })),
  });
  const stop = () => {
    if (options.isCancelled?.()) { termination = "cancelled"; return true; }
    if (evaluations >= maximum) { termination = "work-budget"; return true; }
    if (performance.now() - start >= budget - Math.max(100, longestCandidateMs * 1.25)) { termination = "time-budget"; return true; }
    return false;
  };
  const unsupported = routeUnsupportedReason(input);
  if (unsupported) return { seedStatus, status: "unsupported", reason: unsupported, termination: "unsupported", statistics: statistics() };
  const source = { ...input, path: clone(authoredPath(input.path)) };
  const reject = (reason: string) => {
    rejectedCandidates++;
    const message = reason.slice(0, 240);
    const key = reasons.has(message) || reasons.size < 7 ? message : "Other route validation failures";
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  };
  const decorate = (result: PlannerResult): PlannerResult => ({ ...result, optimization: {
    plannerUsed: result.planner, totalTimeS: result.totalTimeS,
    maxVelocityMps: Math.max(...result.samples.map((s) => Math.abs(s.velocityMps))),
    maxAccelerationMps2: Math.max(...result.samples.map((s) => Math.abs(s.accelerationMps2))),
    constraintViolations: 0, fallback: false, ...result.optimization,
    status: baseline && result.totalTimeS >= baseline.totalTimeS - Math.max(0.02, baseline.totalTimeS * 0.005) ? "equivalent" : "feasible",
    optimizationClass: "route", ...statistics(), budgetTier: tier, budgetMs: budget, termination, seedStatus, ...(seedIssue ? { seedIssue } : {}),
    ...(baseline ? { baselineTimeS: baseline.totalTimeS, gainS: baseline.totalTimeS - result.totalTimeS } : {}),
  } });
  const retained = () => baseline && best && baseline.totalTimeS - best.totalTimeS < Math.max(0.02, baseline.totalTimeS * 0.005) ? baseline : best;
  let lastPublished: PlannerResult | undefined;
  let lastPublishedSeedStatus: RouteSearchResult["seedStatus"] | undefined;
  const publish = () => {
    const current = retained();
    if (current && (current !== lastPublished || seedStatus !== lastPublishedSeedStatus)) {
      lastPublished = current;
      lastPublishedSeedStatus = seedStatus;
      options.onProgress?.(decorate(current));
    } else options.onStatistics?.(statistics());
  };

  const seen = new Set<string>();
  const evaluate = (geometry: ReturnType<typeof geometryFromPath>) => {
    const key = stable(geometry);
    if (seen.has(key)) return;
    seen.add(key);
    evaluations++;
    const began = performance.now();
    try {
      const path = routePlanningPath(source.path, geometry);
      const candidate = decorate(routeResultToSource(optimizeFixedGeometryFinal({ ...source, path }), geometry, path));
      const failure = routeCandidateFailure(source, candidate);
      if (failure) reject(failure);
      else {
        validatedCandidates++;
        if (!best || candidate.totalTimeS < best.totalTimeS - 1e-6) best = candidate;
      }
    } catch (error) {
      reject(error instanceof Error ? error.message : "Route evaluation failed.");
    }
    longestCandidateMs = Math.max(longestCandidateMs, performance.now() - began);
    publish();
  };
  const candidates = routeCandidates(source, stop, () => reject("Visibility graph work budget exhausted; route alternatives remain untested."));
  // Reserve the first evaluation for canonical rescue. Even pathological seed
  // timing cannot consume the budget before a seed-independent route is tried.
  // Its checkpoint honestly says unknown until actual Normal is qualified.
  if (!stop()) {
    const canonical = candidates.next();
    if (!canonical.done) evaluate(canonical.value);
  }

  // One early actual Normal qualification, before strict seed retiming.
  // Inconclusive certificates/errors never authorize a slower feasible offer.
  const seed = geometryFromPath(source.path);
  if (!stop()) {
    evaluations++;
    try {
      const path = routePlanningPath(source.path, seed);
      const normal = decorate(routeResultToSource(getPlanner("profiledSpline").generate(source), seed, path));
      const failure = routeCandidateIssue(source, normal);
      if (!failure) {
        seedStatus = "valid";
        baseline = normal;
        if (!best || normal.totalTimeS < best.totalTimeS) best = normal;
        validatedCandidates++;
      } else {
        if (failure.concrete) {
          seedStatus = "invalid";
          seedIssue = failure.message;
        }
        reject(failure.message);
      }
    } catch (error) {
      reject(error instanceof Error ? error.message : "Normal qualification failed.");
    }
    publish();
  }

  for (const geometry of candidates) {
    if (stop()) break;
    evaluate(geometry);
  }
  termination ??= "completed";
  const current = retained();
  return {
    candidate: current && decorate(current), baseline: baseline && decorate(baseline), seedStatus, ...(seedIssue ? { seedIssue } : {}),
    status: termination === "cancelled" ? "cancelled" : current ? "feasible" : "no-candidate",
    termination, statistics: statistics(),
    reason: current ? undefined : termination === "cancelled" ? "Route search was cancelled before finding a validated candidate."
      : "No validated route was found within this bounded search. This does not prove the task infeasible.",
  };
}
