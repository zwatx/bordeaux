import { clone } from "../project/defaults";
import type { PlannerInput, PlannerOptimizationDiagnostics, PlannerResult, RouteGeometry } from "../types";
import type { CorridorSearchStatistics } from "./corridorFinal";
import { drawnShapeDescent } from "./drawnShapeDescent";
import { materialGainS } from "./limits";
import {
  evaluateRouteCandidate,
  NOT_FASTER,
  probeRouteCandidate,
  qualifyRouteSeed,
  type RouteCandidateLimits,
  type RouteCandidateOutcome,
  type RouteSeedOutcome,
} from "./routeCandidateEvaluation";
import { routeCandidates } from "./routeCandidates";
import { routeTask, routeUnsupportedReason, stable } from "./routeGeometry";

export interface RouteFinalOptions {
  budgetTier?: "common" | "stress" | "hard";
  budgetMs?: number;
  maximumEvaluations?: number;
  /**
   * Only for the search that keeps the drawn shape: when it gives up, at least `budgetMs`.
   * It paces itself by `budgetMs` and runs past it only to finish its first sweep and to
   * plan the curve its descent found.
   */
  hardBudgetMs?: number;
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

/** Curves a sequential shape descent times between reads of its pace. Small, so it overruns a limit by little. */
const SEQUENTIAL_DESCENT_BATCH = 4;

/** The drawn curve and its three shortened-handle repairs, which routeCandidates yields right after the canonical rescue. */
const HEAD_START_CANDIDATES = 4;

/** Runs candidate evaluations for a parallel search, typically on worker threads. */
export interface RouteCandidateEvaluator {
  /** How many evaluations may run at once. */
  parallelism: number;
  evaluate(source: PlannerInput, geometry: RouteGeometry, limits: RouteCandidateLimits): Promise<RouteCandidateOutcome>;
  qualifySeed(source: PlannerInput): Promise<RouteSeedOutcome>;
  /** The first-pass time of a curve, for ranking; infinity when it cannot be timed. */
  probe(source: PlannerInput, geometry: RouteGeometry): Promise<number>;
}

/**
 * Bookkeeping shared by the sequential and parallel searches: budgets, counters,
 * the incumbent, and publishing. The drivers differ only in where and when
 * candidates are evaluated; every outcome is recorded here in candidate order.
 */
function routeSearchState(input: PlannerInput, options: RouteFinalOptions) {
  const start = performance.now();
  const tier = options.budgetTier ?? "common";
  const budget = Math.max(1, Math.min(30_000, Number.isFinite(options.budgetMs) ? options.budgetMs! : ({ common: 5000, stress: 15000, hard: 30000 })[tier]));
  const maximum = Math.max(1, Math.min(72, Math.floor(Number.isFinite(options.maximumEvaluations) ? options.maximumEvaluations! : ({ common: 24, stress: 48, hard: 72 })[tier])));
  const hardBudget = Math.max(budget, Number.isFinite(options.hardBudgetMs) ? options.hardBudgetMs! : budget);
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
  const source = { ...input, path: clone(input.path) };
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
    status: baseline && result.totalTimeS >= baseline.totalTimeS - materialGainS(baseline.totalTimeS) ? "equivalent" : "feasible",
    optimizationClass: "route", ...statistics(), budgetTier: tier, budgetMs: budget, termination, seedStatus, ...(seedIssue ? { seedIssue } : {}),
    ...(baseline ? { baselineTimeS: baseline.totalTimeS, gainS: baseline.totalTimeS - result.totalTimeS } : {}),
  } });
  const materialGain = (normal: PlannerResult) => materialGainS(normal.totalTimeS);
  const retained = () => baseline && best && baseline.totalTimeS - best.totalTimeS < materialGain(baseline) ? baseline : best;
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
  return {
    source,
    stop,
    /** How a shape descent paces itself inside this search's budget. */
    descentPace: {
      // Half the budget is enough descent: the rest plans and qualifies what it found.
      enough: () => stop() || performance.now() - start >= budget / 2,
      giveUp: () => Boolean(options.isCancelled?.()) || performance.now() - start >= hardBudget,
    },
    /**
     * True when no evaluation may start. Unlike `stop` it keeps no margin for a further candidate,
     * so the curves a descent was run to find are still planned when the descent ran long.
     */
    spent: () => Boolean(options.isCancelled?.()) || evaluations >= maximum || performance.now() - start >= hardBudget,
    candidates: routeCandidates(source, stop, () => reject("Visibility graph work budget exhausted; route alternatives remain untested.")),
    limits: (): RouteCandidateLimits => {
      const timeToBeat = best ? best.totalTimeS - 1e-6 : Number.POSITIVE_INFINITY;
      return { timeToBeat, timeToMatter: Math.min(timeToBeat, baseline ? baseline.totalTimeS - materialGain(baseline) : Number.POSITIVE_INFINITY) };
    },
    /** False for a curve that was already taken; otherwise counts it as an evaluation. */
    take(geometry: RouteGeometry): boolean {
      // Every handle is part of the key. Handle lengths along a straight segment
      // leave its shape alone but change its parameterization, and with it the
      // timing; merging such candidates lost a 0.07 s faster route on a corpus path.
      const key = stable(geometry);
      if (seen.has(key)) return false;
      seen.add(key);
      evaluations++;
      return true;
    },
    recordCandidate(outcome: RouteCandidateOutcome, elapsedMs: number): void {
      // A parallel search may have evaluated this against limits that have since tightened.
      if (outcome.status === "valid" && (!best || outcome.candidate.totalTimeS < best.totalTimeS - 1e-6)) {
        validatedCandidates++;
        best = decorate(outcome.candidate);
      } else reject(outcome.status === "valid" ? NOT_FASTER : outcome.reason);
      longestCandidateMs = Math.max(longestCandidateMs, elapsedMs);
      publish();
    },
    /** Counts the Normal qualification as an evaluation and records its outcome. */
    recordSeed(outcome: RouteSeedOutcome): void {
      evaluations++;
      if (outcome.status === "valid") {
        seedStatus = "valid";
        baseline = decorate(outcome.normal);
        if (!best || baseline.totalTimeS < best.totalTimeS) best = baseline;
        validatedCandidates++;
      } else {
        if (outcome.concrete) {
          seedStatus = "invalid";
          seedIssue = outcome.reason;
        }
        reject(outcome.reason);
      }
      publish();
    },
    finish(): RouteSearchResult {
      termination ??= "completed";
      const current = retained();
      return {
        candidate: current && decorate(current), baseline: baseline && decorate(baseline), seedStatus, ...(seedIssue ? { seedIssue } : {}),
        status: termination === "cancelled" ? "cancelled" : current ? "feasible" : "no-candidate",
        termination, statistics: statistics(),
        reason: current ? undefined : termination === "cancelled" ? "Route search was cancelled before finding a validated candidate."
          : "No validated route was found within this bounded search. This does not prove the task infeasible.",
      };
    },
    unsupported: (reason: string): RouteSearchResult => (
      { seedStatus, status: "unsupported", reason, termination: "unsupported", statistics: statistics() }
    ),
  };
}

/** Task-based route selection. Legacy strict/corridor search is unchanged. */
export function optimizeRouteFinal(input: PlannerInput, options: RouteFinalOptions = {}): RouteSearchResult {
  const search = routeSearchState(input, options);
  const unsupported = routeUnsupportedReason(input);
  if (unsupported) return search.unsupported(unsupported);
  const evaluate = (geometry: RouteGeometry) => {
    if (!search.take(geometry)) return;
    const began = performance.now();
    search.recordCandidate(evaluateRouteCandidate(search.source, geometry, search.limits()), performance.now() - began);
  };
  // Reserve the first evaluation for canonical rescue. Even pathological seed
  // timing cannot consume the budget before a seed-independent route is tried.
  // Its checkpoint honestly says unknown until actual Normal is qualified.
  if (!search.stop()) {
    const canonical = search.candidates.next();
    if (!canonical.done) evaluate(canonical.value);
  }

  // One early actual Normal qualification, before strict seed retiming.
  // Inconclusive certificates/errors never authorize a slower feasible offer.
  if (!search.stop()) search.recordSeed(qualifyRouteSeed(search.source));

  for (const geometry of search.candidates) {
    if (search.stop()) break;
    evaluate(geometry);
  }
  return search.finish();
}

/**
 * The same search with candidates evaluated on `evaluator.parallelism` threads.
 * The canonical rescue, the Normal qualification, and the next few candidates
 * run together. The rest are started ahead of need, up to twice the thread
 * count, so no thread waits while an early candidate is slow. Each is evaluated against the incumbent as it
 * stood when it started and recorded in candidate order, so the search returns
 * what the sequential search returns whenever both complete. Which rejection
 * reason a losing candidate reports can vary with timing. A started evaluation
 * cannot be interrupted, so budgets and cancellation stop new starts only.
 */
export async function optimizeRouteFinalParallel(
  input: PlannerInput,
  options: RouteFinalOptions,
  evaluator: RouteCandidateEvaluator,
): Promise<RouteSearchResult> {
  const search = routeSearchState(input, options);
  const unsupported = routeUnsupportedReason(input);
  if (unsupported) return search.unsupported(unsupported);
  const evaluate = async (geometry: RouteGeometry) => {
    const began = performance.now();
    const outcome = await evaluator.evaluate(search.source, geometry, search.limits());
    return { outcome, elapsedMs: performance.now() - began };
  };

  const started: ReturnType<typeof evaluate>[] = [];
  let exhausted = false;
  // Candidates pulled from the generator but not started yet, in generator order.
  const upcoming: RouteGeometry[] = [];
  const nextCandidate = (): RouteGeometry | undefined => {
    if (upcoming.length > 0) return upcoming.shift();
    if (exhausted) return undefined;
    const next = search.candidates.next();
    if (next.done) exhausted = true;
    return next.done ? undefined : next.value;
  };
  if (!search.stop()) {
    const canonical = nextCandidate();
    const rescue = canonical && search.take(canonical) ? evaluate(canonical) : undefined;
    const seed = evaluator.qualifySeed(search.source);
    // The other threads start on the next candidates now instead of idling behind
    // these two. There is no incumbent to prune against yet, so the head start
    // goes only to the candidates the generator yields first: the drawn curve and
    // its shortened-handle repairs. Those are usually near ties that need a full
    // plan anyway, where later candidates are usually dropped after a first pass.
    for (let pulled = 0; pulled < HEAD_START_CANDIDATES && started.length < evaluator.parallelism - 2 && !search.stop(); pulled += 1) {
      const geometry = nextCandidate();
      if (!geometry) break;
      // A detour can cost many plans of the drawn curve, so it waits for a limit.
      if (geometry.knots.length > search.source.path.waypoints.length) {
        upcoming.unshift(geometry);
        break;
      }
      if (search.take(geometry)) started.push(evaluate(geometry));
    }
    // Generating the remaining candidates includes the visibility-graph routes.
    // Do it now, while this thread would otherwise only wait for the results above.
    while (!exhausted) {
      const next = search.candidates.next();
      if (next.done) exhausted = true;
      else upcoming.push(next.value);
    }
    const rescued = await rescue;
    if (rescued) search.recordCandidate(rescued.outcome, rescued.elapsedMs);
    search.recordSeed(await seed);
  }

  for (;;) {
    while ((upcoming.length > 0 || !exhausted) && started.length < evaluator.parallelism * 2 && !search.stop()) {
      const geometry = nextCandidate();
      if (geometry && search.take(geometry)) started.push(evaluate(geometry));
    }
    const oldest = started.shift();
    if (!oldest) break;
    const result = await oldest;
    search.recordCandidate(result.outcome, result.elapsedMs);
  }
  return search.finish();
}

/**
 * The search that keeps the drawn shape. It returns the fastest validated curve
 * that keeps every waypoint and the travel direction there and stays within
 * `limitM` of the drawn curve, or Normal when none is materially faster. Unlike
 * optimizeRouteFinal it never reroutes: when the drawn curve cannot be driven,
 * only a handle-length change within the limit can give a result here.
 */
export function optimizeDrawnShapeFinal(input: PlannerInput, limitM: number, options: RouteFinalOptions = {}): RouteSearchResult {
  const search = routeSearchState(input, options);
  const unsupported = routeUnsupportedReason(input);
  if (unsupported) return search.unsupported(unsupported);
  /** True when the curve was valid. */
  const evaluate = (geometry: RouteGeometry) => {
    if (!search.take(geometry)) return false;
    const began = performance.now();
    const outcome = evaluateRouteCandidate(search.source, geometry, search.limits());
    search.recordCandidate(outcome, performance.now() - began);
    return outcome.status === "valid";
  };
  if (!search.stop()) evaluate(routeTask(search.source.path).seed);
  if (!search.stop()) search.recordSeed(qualifyRouteSeed(search.source));
  const descent = drawnShapeDescent(search.source, limitM, search.descentPace, SEQUENTIAL_DESCENT_BATCH);
  let step = descent.next();
  while (!step.done) step = descent.next(step.value.map((geometry) => probeRouteCandidate(search.source, geometry)));
  // The best curve first; its fallbacks matter only if it is not valid.
  for (const geometry of step.value) {
    if (search.spent() || evaluate(geometry)) break;
  }
  return search.finish();
}

/**
 * The same search with its timing probes and evaluations on `evaluator`'s
 * threads. The drawn curve and the Normal qualification run while the descent
 * probes. The descent takes the same steps as the sequential search, so both
 * return the same curve whenever both complete.
 */
export async function optimizeDrawnShapeFinalParallel(
  input: PlannerInput,
  limitM: number,
  options: RouteFinalOptions,
  evaluator: RouteCandidateEvaluator,
): Promise<RouteSearchResult> {
  const search = routeSearchState(input, options);
  const unsupported = routeUnsupportedReason(input);
  if (unsupported) return search.unsupported(unsupported);
  const evaluate = async (geometry: RouteGeometry) => {
    const began = performance.now();
    const outcome = await evaluator.evaluate(search.source, geometry, search.limits());
    return { outcome, elapsedMs: performance.now() - began };
  };
  if (search.stop()) return search.finish();
  const drawn = routeTask(search.source.path).seed;
  search.take(drawn);
  const drawnCurve = evaluate(drawn);
  const seed = evaluator.qualifySeed(search.source);
  const descent = drawnShapeDescent(search.source, limitM, search.descentPace, evaluator.parallelism * 4);
  let step = descent.next();
  while (!step.done) step = descent.next(await Promise.all(step.value.map((geometry) => evaluator.probe(search.source, geometry))));
  const first = await drawnCurve;
  search.recordCandidate(first.outcome, first.elapsedMs);
  search.recordSeed(await seed);
  // The best curve first, against the limits Normal and the drawn curve set; its fallbacks matter only if it is not valid.
  for (const geometry of step.value) {
    if (search.spent()) break;
    if (!search.take(geometry)) continue;
    const result = await evaluate(geometry);
    search.recordCandidate(result.outcome, result.elapsedMs);
    if (result.outcome.status === "valid") break;
  }
  return search.finish();
}
