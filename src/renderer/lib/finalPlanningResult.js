/** The one reading of a planned trajectory for a path. */
export function selectedTrajectoryOutcome(value, failure = 'Could not prepare this trajectory.') {
  const seconds = value?.prof?.totalTime;
  return value?.finalTrajectory && Number.isFinite(seconds)
    ? { status: 'ready', value, seconds }
    : { status: 'error', message: failure };
}

/** Interprets a FinalPlanning result; timeouts, cancellation and fallbacks are failures here. */
export function finalPlanningOutcome(result) {
  return selectedTrajectoryOutcome(
    result?.status === 'success' ? result.value : null,
    result?.fallbackReason || result?.error?.message || 'Could not prepare this trajectory.',
  );
}

/**
 * A planned trajectory's first and last poses, `{ start, end }` with `{ x, y, heading }` in field meters and radians,
 * or undefined. Routine library rows find pose jumps from these without planning the routine.
 */
export function trajectoryEnds(trajectory) {
  const samples = trajectory?.samples;
  if (!samples?.length) return undefined;
  const pose = (sample) => ({ x: sample.x, y: sample.y, heading: sample.headingRad });
  return { start: pose(samples[0]), end: pose(samples[samples.length - 1]) };
}

/** The library's duration entry for an outcome: its time, and its end poses when the outcome carries them. */
export function durationResult(outcome) {
  if (outcome.status === 'ready') return { status: 'ready', seconds: outcome.seconds, ends: outcome.ends ?? trajectoryEnds(outcome.value?.finalTrajectory) };
  return outcome.status === 'error' ? { status: 'error', message: outcome.message } : { status: 'pending' };
}
