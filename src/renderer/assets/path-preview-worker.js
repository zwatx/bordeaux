import { planPath } from "../../core/planners/planPath";
import { editingGeometry, projectEditingTiming } from "./editing-planning";
import { PM } from "../lib/pathMath";
import { optimizeDrawnShapeFinal, optimizeDrawnShapeFinalParallel, optimizeRouteFinal, optimizeRouteFinalParallel } from "../../core/planners/routeFinal";
import { evaluateRouteCandidate, probeRouteCandidate, qualifyRouteSeed, warmRouteEvaluation } from "../../core/planners/routeCandidateEvaluation";
import { DRAWN_SHAPE_LIMIT_M } from "../../core/planners/limits";
import { getPlanner } from "../../core/planners";
import { flipPath } from "../../core/project/flipField";
import { analyzeRoutinePower, analyzeTrajectoryPower } from '../../core/planners/trajectoryPower';

const FINAL_POSITION_TOLERANCE_M = 1e-4;
const FINAL_INTERPOLATION_POSITION_TOLERANCE_M = 1e-3;
const FINAL_FRACTION_TOLERANCE = 1e-5;

function firstFractionAtOrAfter(samples, fraction, tolerance = 0) {
  let low = 0, high = samples.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const value = samples[middle].f;
    if (value < fraction && Math.abs(value - fraction) > tolerance) low = middle + 1;
    else high = middle;
  }
  return low;
}

function trajectorySamplesAtGeometryPoint(samples, point, fraction, ordered = false) {
  const matches = [];
  const start = ordered ? firstFractionAtOrAfter(samples, fraction, FINAL_FRACTION_TOLERANCE) : 0;
  for (let index = start; index < samples.length; index += 1) {
    const sample = samples[index];
    const delta = Math.abs(sample.f - fraction);
    if (ordered && sample.f > fraction && delta > FINAL_FRACTION_TOLERANCE) break;
    if (delta <= FINAL_FRACTION_TOLERANCE
      && Math.hypot(sample.x - point.x, sample.y - point.y) <= FINAL_POSITION_TOLERANCE_M) matches.push(sample);
  }
  return matches;
}

function fixedPathTrajectorySamples(finalTrajectory) {
  const actions = finalTrajectory.stationaryActions || [];
  return (finalTrajectory.samples || []).filter((sample) => !actions.some((action) => (
    sample.t > action.startTimeS + 1e-9 && sample.t <= action.endTimeS + 1e-9
  )));
}

function trajectoryAtGeometryPoint(samples, point, fraction, ordered) {
  const match = trajectorySamplesAtGeometryPoint(samples, point, fraction, ordered)
    .reduce((earliest, sample) => !earliest || sample.t < earliest.t ? sample : earliest, null);
  if (match) return match;

  const afterIndex = ordered
    ? firstFractionAtOrAfter(samples, fraction)
    : samples.findIndex((sample) => sample.f >= fraction);
  if (afterIndex >= samples.length) throw new Error('Final optimization did not preserve the renderer geometry.');
  if (afterIndex <= 0) throw new Error('Final optimization did not preserve the renderer geometry.');
  const before = samples[afterIndex - 1];
  const after = samples[afterIndex];
  const span = after.f - before.f;
  if (span <= 1e-9) throw new Error('Final optimization did not preserve the renderer geometry.');
  const progress = Math.max(0, Math.min(1, (fraction - before.f) / span));
  const mix = (first, second) => first + (second - first) * progress;
  const headingDelta = Math.atan2(
    Math.sin(after.headingRad - before.headingRad),
    Math.cos(after.headingRad - before.headingRad),
  );
  const interpolated = {
    ...before,
    t: mix(before.t, after.t),
    s: mix(before.s, after.s),
    f: fraction,
    x: mix(before.x, after.x),
    y: mix(before.y, after.y),
    headingRad: before.headingRad + headingDelta * progress,
    velocityMps: Math.sqrt(Math.max(0, mix(before.velocityMps ** 2, after.velocityMps ** 2))),
    accelerationMps2: mix(before.accelerationMps2, after.accelerationMps2),
    angularVelocityRadps: mix(before.angularVelocityRadps, after.angularVelocityRadps),
    curvatureInvM: mix(before.curvatureInvM, after.curvatureInvM),
  };
  if (Math.hypot(interpolated.x - point.x, interpolated.y - point.y) > FINAL_INTERPOLATION_POSITION_TOLERANCE_M) {
    throw new Error('Final optimization did not preserve the renderer geometry.');
  }
  return interpolated;
}

function authoritativeHeadingCatchup(points, distance, finalTrajectory, reverse) {
  const point = points[points.length - 1];
  if (!point) return null;
  const fraction = Math.max(0, Math.min(1, point.s / distance));
  const endpointSamples = trajectorySamplesAtGeometryPoint(finalTrajectory.samples || [], point, fraction);
  const arrival = endpointSamples.reduce((earliest, sample) => !earliest || sample.t < earliest.t ? sample : earliest, null);
  const firstAuthoredActionTime = Math.min(...(finalTrajectory.stationaryActions || [])
    .filter((candidate) => Math.abs(candidate.fraction - fraction) <= FINAL_FRACTION_TOLERANCE)
    .map((candidate) => candidate.startTimeS));
  const catchupEndTime = Number.isFinite(firstAuthoredActionTime)
    ? firstAuthoredActionTime
    : Math.max(...endpointSamples.map((sample) => sample.t));
  if (!arrival || !Number.isFinite(catchupEndTime) || catchupEndTime <= arrival.t + 1e-9) return null;
  const settled = endpointSamples.reduce((nearest, sample) => (
    !nearest || Math.abs(sample.t - catchupEndTime) < Math.abs(nearest.t - catchupEndTime) ? sample : nearest
  ), null);
  if (!settled) throw new Error('Final optimization omitted automatic heading catch-up timing metadata.');
  const start = arrival.headingRad - (reverse ? Math.PI : 0);
  const end = settled.headingRad - (reverse ? Math.PI : 0);
  const headingSamples = endpointSamples
    .filter((sample) => sample.t >= arrival.t - 1e-9 && sample.t <= catchupEndTime + 1e-9)
    .sort((first, second) => first.t - second.t)
    .map((sample) => ({
      t: sample.t,
      heading: sample.headingRad - (reverse ? Math.PI : 0),
    }));
  return {
    idx: points.length - 1,
    t0: arrival.t,
    t1: catchupEndTime,
    start,
    delta: Math.atan2(Math.sin(end - start), Math.cos(end - start)),
    catchup: true,
    headingSamples,
  };
}

function authoritativeActions(actions, kind, points, finalTrajectory, reverse) {
  const available = (finalTrajectory.stationaryActions || []).filter((action) => action.kind === kind);
  const authored = actions || [];
  if (available.length !== authored.length) throw new Error(`Final optimization omitted ${kind} timing metadata.`);
  return authored.map((action, actionIndex) => {
    const point = points[action.idx];
    const timing = available[actionIndex];
    const pointSamples = point
      ? (finalTrajectory.samples || []).filter((sample) => (
          Math.hypot(sample.x - point.x, sample.y - point.y) <= FINAL_INTERPOLATION_POSITION_TOLERANCE_M
        ))
      : [];
    const actionStart = pointSamples.reduce((nearest, sample) => (
      !nearest || Math.abs(sample.t - timing.startTimeS) < Math.abs(nearest.t - timing.startTimeS) ? sample : nearest
    ), null);
    return {
      ...action,
      t0: timing.startTimeS,
      t1: timing.endTimeS,
      ...(kind === 'wait' && actionStart
        ? { heading: actionStart.headingRad - (reverse ? Math.PI : 0) }
        : {}),
      ...(kind === 'jiggle' ? { strokeDuration: timing.strokeDurationS } : {}),
    };
  });
}

function rendererTurns(derived, finalTrajectory) {
  const authored = (derived.prof.turns || []).filter((turn) => !turn.catchup);
  const points = derived.sample.pts;
  const distance = derived.sample.length || 1;
  const available = (finalTrajectory.stationaryActions || []).filter((action) => action.kind === 'turn');
  const indices = available.map((action) => derived.wpIdx?.[action.waypointIndex]
    ?? points.findIndex((point) => Math.abs(point.s / distance - action.fraction) <= FINAL_FRACTION_TOLERANCE));
  if (authored.some((turn) => !indices.includes(turn.idx))) {
    throw new Error('Final optimization omitted turn timing metadata.');
  }
  return available.map((timing, index) => {
    const idx = indices[index];
    const turn = authored.find((candidate) => candidate.idx === idx);
    if (turn) return turn;
    const point = points[idx];
    if (!point) throw new Error('Final optimization omitted stationary turn geometry.');
    // The shared planner can rotate at a required stop even without an explicit
    // turn-in-place action. Replay that validated heading trace before its wait.
    const headingSamples = finalTrajectory.samples.filter((sample) => (
      sample.t >= timing.startTimeS - 1e-9 && sample.t <= timing.endTimeS + 1e-9
      && Math.hypot(sample.x - point.x, sample.y - point.y) <= FINAL_INTERPOLATION_POSITION_TOLERANCE_M
    )).map((sample) => ({ t: sample.t, heading: sample.headingRad - (derived.rev ? Math.PI : 0) }));
    if (headingSamples.length < 2) throw new Error('Final optimization omitted stationary turn heading samples.');
    const start = headingSamples[0].heading;
    return { idx, start, delta: headingSamples.at(-1).heading - start, headingSamples };
  });
}

/** Applies final timing to the immutable renderer geometry used for editing. */
export function applyFinalTrajectoryToPreview(derived, finalTrajectory) {
  const points = derived?.sample?.pts || [];
  const samples = finalTrajectory?.samples || [];
  if (points.length < 2 || samples.length < 2) throw new Error('Final optimization returned an incomplete trajectory.');
  const distance = derived.sample.length || points[points.length - 1].s || 1;
  const fixedPathSamples = fixedPathTrajectorySamples(finalTrajectory);
  // Stationary actions may move back along the path. Only index the remaining
  // monotonic geometry samples; preserve the scan for nonmonotonic inputs.
  const ordered = fixedPathSamples.every((sample, index) => Number.isFinite(sample.f)
    && (index === 0 || sample.f >= fixedPathSamples[index - 1].f));
  const projected = points.map((point) => trajectoryAtGeometryPoint(
    fixedPathSamples,
    point,
    Math.max(0, Math.min(1, point.s / distance)),
    ordered,
  ));
  const times = projected.map((sample) => sample.t);
  const velocities = projected.map((sample) => sample.velocityMps);
  const accelerations = projected.map((sample) => sample.accelerationMps2);
  const angularVelocities = projected.map((sample) => sample.angularVelocityRadps);
  const headings = projected.map((sample) => sample.headingRad - (derived.rev ? Math.PI : 0));
  const curvatures = projected.map((sample) => sample.curvatureInvM);
  const maximumMagnitude = (values, floor) => values.reduce(
    (maximum, value) => Math.max(maximum, Math.abs(value)),
    floor,
  );
  const authoredTurns = authoritativeActions(
    rendererTurns(derived, finalTrajectory),
    'turn',
    points,
    finalTrajectory,
    derived.rev,
  );
  const headingCatchup = authoritativeHeadingCatchup(points, distance, finalTrajectory, derived.rev);
  return {
    ...derived,
    prof: {
      ...derived.prof,
      t: times,
      v: velocities,
      head: headings,
      totalTime: finalTrajectory.totalTimeS,
      holds: authoritativeActions(derived.prof.holds, 'wait', points, finalTrajectory, derived.rev),
      turns: headingCatchup ? [...authoredTurns, headingCatchup] : authoredTurns,
      jiggles: authoritativeActions(derived.prof.jiggles, 'jiggle', points, finalTrajectory, derived.rev),
    },
    metrics: {
      ...derived.metrics,
      head: headings,
      v: velocities,
      accel: accelerations,
      omega: angularVelocities,
      curv: curvatures,
      vMax: maximumMagnitude(velocities, 0.1),
      aMax: maximumMagnitude(accelerations, 0.1),
      wMax: maximumMagnitude(angularVelocities, 0.01),
      kMax: maximumMagnitude(curvatures, 0),
    },
    // Exported marker times include stationary actions that the geometry projection omits.
    markers: finalTrajectory.markers,
    finalTrajectory,
    finalOptimization: finalTrajectory.optimization,
  };
}

function interactiveTrajectory(input) {
  return getPlanner('profiledSpline').generate(input);
}

/**
 * Projects a planned trajectory onto the renderer geometry of the path it was planned on: the
 * path itself, or for a search candidate the path Apply would write (`optimizedPath`).
 */
export function previewForTrajectory(path, robot, trajectory, derive = PM.derivePath, perSegment = 56) {
  return applyFinalTrajectoryToPreview(derive(trajectory.optimizedPath || path, robot, perSegment, trajectory.planner), trajectory);
}

/** Opt-in editing contract; legacy final/optimization jobs retain their existing API. */
export function processEditingPlanningJob(job) {
  const input = { path: job.path, robot: job.robot, field: job.field, samplesPerSegment: job.perSegment || 56 };
  const plan = planPath(input);
  let comparison;
  let derived = projectEditingTiming(editingGeometry(input.path, 14, job.robot), plan.bestEffort, plan.issues);
  if (plan.trajectory) {
    let projected = false;
    try { derived = previewForTrajectory(input.path, job.robot, plan.trajectory, PM.derivePath, input.samplesPerSegment); projected = true; }
    catch (error) {
      derived = { ...derived, finalTrajectory: plan.trajectory, finalOptimization: plan.trajectory.optimization };
      comparison = { status: 'error', message: error?.message || String(error) };
    }
    derived = { ...derived, trajectorySamples: plan.bestEffort.samples };
    if (projected) comparison = { status: 'ready', projectionVersion: 1, previewDensity: input.samplesPerSegment };
  }
  return { ...plan, derived, comparison };
}

/**
 * The share of a job's deadline the search that keeps the drawn shape is paced for. It runs second, and only
 * when the route search left at least this much.
 */
const SHAPE_BUDGET_SHARE = 0.4;
/** The share of the time left that the shape search may spend before it gives up. The rest covers its last plan. */
const SHAPE_HARD_SHARE = 0.8;

/**
 * The search input and options of one optimize job, and the worker reply for
 * its outcome. Shared by the sequential search and the parallel one.
 *
 * A job with `keepShape` runs two searches. The route search runs first, with
 * the whole deadline as its budget, exactly as it does alone. The search that
 * keeps the drawn shape then runs in the time that is left, so a long path
 * that needs most of the deadline for its route simply has no second result.
 * On a fast machine the shape search stops refining after half its share. On a
 * slow one it may use most of the time left to finish its first sweep.
 * The reply is the route search's, with the shape-keeping result beside it as
 * `value.shape` when that search found a curve materially faster than Normal.
 */
function optimizeJob(job, path, derive, emitProgress, startedAt) {
  const toPreview = (trajectory) => previewForTrajectory(path, job.robot, trajectory, derive, job.perSegment);
  const envelope = (search) => ({
    status: search.status, reason: search.reason, termination: search.termination, statistics: search.statistics,
    seedStatus: search.seedStatus || 'unknown', seedIssue: search.seedIssue,
  });
  const incumbentEnvelope = (trajectory) => ({ status: 'feasible',
    seedStatus: trajectory.optimization?.seedStatus || 'unknown', seedIssue: trajectory.optimization?.seedIssue });
  const progress = (value) => emitProgress({ id: job.id, type: 'progress', quality: job.quality, value, durationMs: performance.now() - startedAt });
  const isOffer = (trajectory) => Boolean(trajectory && !trajectory.optimization?.fallback && trajectory.optimization?.status !== 'equivalent');
  return {
    input: { path, robot: job.robot, field: job.field, samplesPerSegment: job.perSegment },
    options: {
      budgetTier: job.deadline,
      budgetMs: job.deadlineMs,
      onProgress: (trajectory) => progress({ ...toPreview(trajectory), routeSearch: incumbentEnvelope(trajectory) }),
      // Counters only: the incumbent and its projected preview are unchanged.
      onStatistics: (statistics) => emitProgress({
        id: job.id,
        type: 'statistics',
        quality: job.quality,
        statistics,
        durationMs: performance.now() - startedAt,
      }),
    },
    result(search) {
      // The injected legacy planner remains useful to historical worker tests;
      // production uses the explicit route-search envelope, including no result.
      const finalTrajectory = search.candidate || (search.optimization ? search : null);
      const routeSearch = search.status ? envelope(search) : undefined;
      if (!finalTrajectory) return {
        id: job.id, quality: job.quality,
        value: { routeSearch }, durationMs: performance.now() - startedAt,
      };
      if (finalTrajectory.optimization?.fallback) {
        return {
          id: job.id,
          quality: job.quality,
          finalFallbackReason: finalTrajectory.optimization.fallbackReason || 'Final optimization did not produce a valid trajectory.',
          durationMs: performance.now() - startedAt,
        };
      }
      return {
        id: job.id,
        quality: job.quality,
        value: { ...toPreview(finalTrajectory), routeSearch },
        durationMs: performance.now() - startedAt,
      };
    },
    /**
     * Whether `reply`, the route search's, is one the shape search may add to.
     * A reply without a value is an error and stays as it is.
     */
    wantsShape: (reply) => job.keepShape === true && Boolean(reply.value)
      && job.deadlineMs - (performance.now() - startedAt) >= job.deadlineMs * SHAPE_BUDGET_SHARE,
    /**
     * Options for the shape search that follows the route search answered by `reply`. Publishes `reply` first,
     * so a job that runs out of time during the shape search still ends with the route search's full result.
     */
    shapeOptions(reply) {
      progress(reply.value);
      // The drawn curve's own retimed plan can lead until Normal is qualified and then stop being an offer.
      let offered = false;
      const hardBudgetMs = (job.deadlineMs - (performance.now() - startedAt)) * SHAPE_HARD_SHARE;
      return {
        budgetTier: job.deadline,
        // Never above the hard budget, which would otherwise rise to the budget and leave no time for the last plan.
        budgetMs: Math.min(job.deadlineMs * SHAPE_BUDGET_SHARE, hardBudgetMs),
        hardBudgetMs,
        // Kept as the incumbent, so a job that times out still offers both results found so far.
        onProgress: (trajectory) => {
          if (!isOffer(trajectory) && !offered) return;
          offered = isOffer(trajectory);
          progress(offered ? { ...reply.value, shape: { ...toPreview(trajectory), routeSearch: incumbentEnvelope(trajectory) } } : reply.value);
        },
      };
    },
    /** `reply` with the outcome of the shape search added. */
    withShape: (reply, search) => ({
      ...reply,
      value: isOffer(search.candidate) ? { ...reply.value, shape: { ...toPreview(search.candidate), routeSearch: envelope(search) } } : reply.value,
      durationMs: performance.now() - startedAt,
    }),
  };
}

/**
 * One optimize job with its candidates evaluated on `evaluator`'s threads.
 * Returns the same reply as processPathPreviewJob does for the sequential search.
 */
export async function processParallelOptimizeJob(job, evaluator, emitProgress = () => {}, derive = PM.derivePath) {
  const startedAt = performance.now();
  try {
    const search = optimizeJob(job, job.path, derive, emitProgress, startedAt);
    const reply = search.result(await optimizeRouteFinalParallel(search.input, search.options, evaluator));
    if (!search.wantsShape(reply)) return reply;
    return search.withShape(reply, await optimizeDrawnShapeFinalParallel(search.input, DRAWN_SHAPE_LIMIT_M, search.shapeOptions(reply), evaluator));
  } catch (error) {
    return {
      id: job.id,
      quality: job.quality,
      error: {
        name: error && error.name ? error.name : 'Error',
        message: error && error.message ? error.message : String(error),
      },
      durationMs: performance.now() - startedAt,
    };
  }
}

/**
 * Sub-workers that evaluate route candidates for the optimizer worker. Each is
 * another instance of this same script, so the pool needs no second bundle, and
 * it lives as long as the optimizer worker, so its threads stay compiled between
 * searches. A sub-worker that fails is terminated and leaves the pool, and its
 * candidate is rejected. With no sub-worker left, every task is rejected.
 *
 * A task has no deadline of its own. One that never answers holds its search
 * until the request deadline, when the renderer terminates this worker and
 * with it the whole pool.
 */
export function createCandidatePool(size) {
  const idle = [];
  const queue = [];
  const pending = new Map();
  const live = new Set();
  let nextId = 0;
  const failed = (message) => message.mode === 'routeProbe' ? Number.POSITIVE_INFINITY
    : message.mode === 'routeSeed' ? { status: 'rejected', reason: 'Route evaluation worker failed.', concrete: false }
    : { status: 'rejected', reason: 'Route evaluation worker failed.' };
  const dispatch = () => {
    while (queue.length > 0 && (idle.length > 0 || live.size === 0)) {
      const task = queue.shift();
      if (live.size === 0) { task.resolve(failed(task.message)); continue; }
      const worker = idle.pop();
      pending.set(worker, task);
      worker.postMessage(task.message);
    }
  };
  const retire = (worker) => {
    if (!live.delete(worker)) return;
    worker.terminate();
    const index = idle.indexOf(worker);
    if (index >= 0) idle.splice(index, 1);
    const task = pending.get(worker);
    pending.delete(worker);
    task?.resolve(failed(task.message));
    dispatch();
  };
  try {
    for (let index = 0; index < size; index += 1) {
      const worker = new Worker(self.location.href, { type: 'module' });
      live.add(worker);
      worker.onmessage = (event) => {
        if (!live.has(worker)) return;
        const task = pending.get(worker);
        pending.delete(worker);
        idle.push(worker);
        task?.resolve(event.data.outcome);
        dispatch();
      };
      worker.onerror = () => retire(worker);
      worker.onmessageerror = () => retire(worker);
      idle.push(worker);
    }
  } catch (error) {
    live.forEach((worker) => worker.terminate());
    throw error;
  }
  const run = (message) => new Promise((resolve) => {
    queue.push({ message: { ...message, id: nextId += 1 }, resolve });
    dispatch();
  });
  return {
    parallelism: size,
    /** False once every sub-worker has failed. */
    get alive() { return live.size > 0; },
    evaluate: (source, geometry, limits) => run({ mode: 'routeCandidate', source, geometry, limits }),
    qualifySeed: (source) => run({ mode: 'routeSeed', source }),
    probe: (source, geometry) => run({ mode: 'routeProbe', source, geometry }),
    // One warm task per sub-worker compiles the planner on every thread.
    warm: (source) => { live.forEach(() => { run({ mode: 'routeWarm', source }); }); },
  };
}

export function processPathPreviewJob(
  job,
  derive = PM.derivePath,
  optimize = optimizeRouteFinal,
  profile = interactiveTrajectory,
  emitProgress = () => {},
) {
  const startedAt = performance.now();
  try {
    if (job.mode === 'power') {
      const value = job.segments
        ? analyzeRoutinePower(job.robot, job.segments, job.totalTimeS)
        : analyzeTrajectoryPower(job.robot, job.path, job.trajectory);
      return { id: job.id, value, durationMs: performance.now() - startedAt };
    }
    if (job.mode === 'flip') {
      return { id: job.id, quality: job.quality, value: flipPath(job.path, job.direction, job.robot), durationMs: performance.now() - startedAt };
    }
    if (job.mode === 'editing') {
      return { id: job.id, quality: job.quality, value: processEditingPlanningJob(job), durationMs: performance.now() - startedAt };
    }
    const path = job.path;
    // Keep pointer editing on the low-latency geometry pass. Final planning
    // replaces it with the authoritative physics result after the edit settles.
    if (job.quality !== 'final') {
      return {
        id: job.id,
        quality: job.quality,
        value: derive(path, job.robot, job.perSegment, 'profiledSpline'),
        durationMs: performance.now() - startedAt,
      };
    }
    if (job.optimize === true) {
      const search = optimizeJob(job, path, derive, emitProgress, startedAt);
      const reply = search.result(optimize(search.input, search.options));
      if (!search.wantsShape(reply)) return reply;
      return search.withShape(reply, optimizeDrawnShapeFinal(search.input, DRAWN_SHAPE_LIMIT_M, search.shapeOptions(reply)));
    }
    const trajectory = profile({ path, robot: job.robot, field: job.field, samplesPerSegment: job.perSegment });
    const blockingDiagnostic = trajectory.diagnostics.find((issue) => issue.severity === 'error');
    if (blockingDiagnostic) throw new Error(blockingDiagnostic.message);
    const authoritative = previewForTrajectory(path, job.robot, trajectory, derive, job.perSegment);
    return {
      id: job.id,
      quality: job.quality,
      value: authoritative,
      durationMs: performance.now() - startedAt,
    };
  } catch (error) {
    return {
      id: job.id,
      quality: job.quality,
      error: {
        name: error && error.name ? error.name : 'Error',
        message: error && error.message ? error.message : String(error),
      },
      durationMs: performance.now() - startedAt,
    };
  }
}

if (typeof self !== 'undefined') {
  let candidatePool = null;
  // Two threads stay free for the interface and this worker. With none to spare,
  // or if sub-workers cannot start or have all failed, the search runs here in
  // sequence instead. The renderer cancels a search by terminating this worker.
  // Each sub-worker holds about 150 MB while this worker lives. Four measured
  // 0.85 GB in the renderer against 1.45 GB for eight, for a 5% slower search.
  const candidatePoolSize = Math.min(4, (self.navigator?.hardwareConcurrency || 1) - 2);
  const pool = () => {
    if (candidatePool === null && candidatePoolSize >= 2) {
      try { candidatePool = createCandidatePool(candidatePoolSize); }
      catch { candidatePool = undefined; }
    }
    if (candidatePool && !candidatePool.alive) candidatePool = undefined;
    return candidatePool || null;
  };
  const post = (message) => self.postMessage(message);
  self.onmessage = (event) => {
    const job = event.data;
    // This worker as a sub-worker of a candidate pool.
    if (job?.mode === 'routeCandidate') return post({ id: job.id, outcome: evaluateRouteCandidate(job.source, job.geometry, job.limits) });
    if (job?.mode === 'routeSeed') return post({ id: job.id, outcome: qualifyRouteSeed(job.source) });
    if (job?.mode === 'routeProbe') return post({ id: job.id, outcome: probeRouteCandidate(job.source, job.geometry) });
    if (job?.mode === 'routeWarm') return post({ id: job.id, outcome: warmRouteEvaluation(job.source) });
    // This worker as the persistent optimizer: it keeps its pool between jobs.
    if (job?.type === 'warm') {
      return void pool()?.warm({ path: job.path, robot: job.robot, field: job.field, samplesPerSegment: job.perSegment });
    }
    if (job?.optimize === true && job.parallel === true && job.quality === 'final' && job.mode === undefined && pool()) {
      return void processParallelOptimizeJob(job, pool(), post).then(post);
    }
    return post(processPathPreviewJob(job, PM.derivePath, optimizeRouteFinal, interactiveTrajectory, post));
  };
}
