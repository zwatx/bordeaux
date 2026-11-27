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

/** The library's duration entry for an outcome. */
export function durationResult(outcome) {
  if (outcome.status === 'ready') return { status: 'ready', seconds: outcome.seconds };
  return outcome.status === 'error' ? { status: 'error', message: outcome.message } : { status: 'pending' };
}
