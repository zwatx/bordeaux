import { planPath } from "../../shared/planners/planPath";
import { isOptimizationOutdated } from "../../shared/planners/acceptedTrajectoryIdentity";
import { editingGeometry, projectEditingTiming } from "./editing-planning";
import { PM } from "../lib/pathMath";
import { optimizeCorridorFinal } from "../../shared/planners/corridorFinal";
import { getPlanner } from "../../shared/planners";
import { authoredPath, getAcceptedTrajectory } from "../../shared/planners/acceptedTrajectory";

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

/** Projects the exact selected result without rerunning the optimizer. */
export function previewForTrajectory(path, robot, trajectory, derive = PM.derivePath, perSegment = 56) {
  return applyFinalTrajectoryToPreview(
    derive(trajectory.optimizedPath || authoredPath(path), robot, perSegment, trajectory.planner),
    trajectory,
  );
}

/** Opt-in editing contract; legacy final/optimization jobs retain their existing API. */
export function processEditingPlanningJob(job) {
  const input = { path: authoredPath(job.path), robot: job.robot, field: job.field, samplesPerSegment: job.perSegment || 56 };
  const accepted = getAcceptedTrajectory(job.path, job.robot, job.field);
  const currentAccepted = job.path.optimization?.accepted && !isOptimizationOutdated(job.path, job.robot, job.field);
  let plan = accepted
    ? { status: 'ok', trajectory: accepted, bestEffort: { samples: accepted.samples, totalTimeS: accepted.totalTimeS }, issues: [] }
    : planPath(input);
  if (currentAccepted && !accepted) {
    plan = { ...plan, status: 'infeasible', trajectory: null, issues: [...plan.issues, {
      code: 'planner', severity: 'error', f0: 0, f1: 1,
      message: 'Selected optimization could not be validated',
    }] };
  }
  let comparison;
  let derived = projectEditingTiming(editingGeometry(plan.trajectory?.optimizedPath || input.path, 14, job.robot), plan.bestEffort, plan.issues);
  if (plan.trajectory) {
    let projected = false;
    try { derived = previewForTrajectory(input.path, job.robot, plan.trajectory, PM.derivePath, input.samplesPerSegment); projected = true; }
    catch (error) {
      derived = { ...derived, finalTrajectory: plan.trajectory, finalOptimization: plan.trajectory.optimization };
      comparison = { status: 'error', message: error?.message || String(error) };
    }
    derived = { ...derived, trajectorySamples: plan.bestEffort.samples, acceptedTrajectory: Boolean(accepted) };
    if (projected) comparison = { status: 'ready', projectionVersion: 1, previewDensity: input.samplesPerSegment };
  }
  return { ...plan, derived, acceptedTrajectory: Boolean(accepted), comparison };
}

export function processPathPreviewJob(
  job,
  derive = PM.derivePath,
  optimize = optimizeCorridorFinal,
  profile = interactiveTrajectory,
  emitProgress = () => {},
) {
  const startedAt = performance.now();
  try {
    if (job.mode === 'editing') {
      return { id: job.id, quality: job.quality, value: processEditingPlanningJob(job), durationMs: performance.now() - startedAt };
    }
    const path = authoredPath(job.path);
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
      const toPreview = (trajectory) => previewForTrajectory(path, job.robot, trajectory, derive, job.perSegment);
      const finalTrajectory = optimize(
        { path, robot: job.robot, field: job.field, samplesPerSegment: job.perSegment },
        {
          budgetTier: job.deadline,
          budgetMs: job.deadlineMs,
          corridorM: job.path.optimization?.corridorM ?? 0.15,
          onProgress: (trajectory) => emitProgress({
            id: job.id,
            type: 'progress',
            quality: job.quality,
            value: toPreview(trajectory),
            durationMs: performance.now() - startedAt,
          }),
          // Counters only: the incumbent and its projected preview are unchanged.
          onStatistics: (statistics) => emitProgress({
            id: job.id,
            type: 'statistics',
            quality: job.quality,
            statistics,
            durationMs: performance.now() - startedAt,
          }),
        },
      );
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
        value: toPreview(finalTrajectory),
        durationMs: performance.now() - startedAt,
      };
    }
    const accepted = getAcceptedTrajectory(job.path, job.robot, job.field);
    const trajectory = accepted || profile({ path, robot: job.robot, field: job.field, samplesPerSegment: job.perSegment });
    const blockingDiagnostic = trajectory.diagnostics.find((issue) => issue.severity === 'error');
    if (blockingDiagnostic) throw new Error(blockingDiagnostic.message);
    const authoritative = previewForTrajectory(path, job.robot, trajectory, derive, job.perSegment);
    return {
      id: job.id,
      quality: job.quality,
      value: { ...authoritative, acceptedTrajectory: Boolean(accepted) },
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
  self.onmessage = (event) => self.postMessage(
    processPathPreviewJob(event.data, PM.derivePath, optimizeCorridorFinal, interactiveTrajectory, (progress) => self.postMessage(progress)),
  );
}
