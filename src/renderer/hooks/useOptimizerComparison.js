import { useEffect, useMemo, useRef, useState } from 'react';
import { FinalPlanning } from '../assets/final-planning';
import { isOptimizationOutdated } from '../../shared/planners/acceptedTrajectoryIdentity';
import { finalPlanningError } from '../lib/planningFeedback';

// Final worker success must contain the complete renderer projection, not a duration/sample fallback.
function completeAuthoredPreview(value, plannerId) {
  const trajectory = value?.finalTrajectory;
  return !value?.acceptedTrajectory && trajectory?.planner === plannerId
    && Number.isFinite(trajectory.totalTimeS) && trajectory.totalTimeS > 0 && trajectory.samples?.length >= 2
    && value.sample?.pts?.length >= 2 && value.prof?.totalTime === trajectory.totalTimeS
    && [value.wpIdx, value.wpFrac, value.markers, value.anchors, value.effRanges,
      value.prof.t, value.prof.v, value.prof.head, value.prof.holds, value.prof.turns, value.prof.jiggles,
      value.metrics?.head, value.metrics?.v, value.metrics?.accel, value.metrics?.omega, value.metrics?.curv].every(Array.isArray);
}

/** One complete authored Normal reference, separate from accepted selections and search statistics. */
export function useOptimizerComparison({ enabled, context, editing }) {
  const { documentKey, pathId, inputKey, path, normalPath, robot, field, plannerId, previewDensity, projectionVersion } = context;
  const identity = useMemo(() => ({ documentKey, pathId, inputKey, plannerId, previewDensity, projectionVersion, purpose: 'authored-normal' }),
    [documentKey, pathId, inputKey, plannerId, previewDensity, projectionVersion]);
  const planner = useMemo(() => FinalPlanning.create(), []);
  const reference = useRef(null);
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState(null);
  const retryNormal = useMemo(() => () => setAttempt(n => n + 1), []);
  const artifact = path.optimization?.accepted || null;
  // A new owner is required even for A→B→A or close/reopen before a promise settles.
  // Completed references use physical identity; in-flight work additionally uses immutable input objects.
  const owner = useMemo(() => ({}), [identity, path, normalPath, robot, field, artifact, enabled, attempt]);
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  if (reference.current?.identity !== identity) reference.current = null;

  const preview = editing.strictPreview;
  const selected = editing.ready && editing.status === 'ok' && preview?.path === path && preview.robot === robot && preview.field === field
    && preview.acceptedIdentity === artifact && preview.plannerId === plannerId && preview.previewDensity === previewDensity
    && preview.projectionVersion === projectionVersion ? preview : null;
  const currentAccepted = useMemo(() => Boolean(artifact) && !isOptimizationOutdated(path, robot, field), [path, robot, field, artifact]);
  const authoredFailure = !currentAccepted && !editing.pending && editing.status !== 'idle'
    && (!selected || selected.accepted || selected.trajectoryDensity !== previewDensity);
  const editingError = authoredFailure
    ? editing.comparisonError || editing.error || { message: editing.issues.find(issue => issue.severity === 'error')?.message || 'Could not prepare this trajectory.' }
    : null;
  if (authoredFailure) reference.current = null;
  // Inline admission avoids a redundant final request on the first ready render and preserves
  // the exact object before Apply replaces the selected artifact in the same interaction.
  if (selected && !selected.accepted && selected.trajectoryDensity === 56 && previewDensity === 56 && projectionVersion === 1) {
    reference.current = { identity, value: selected.value, trajectory: selected.trajectory };
  }
  const retained = reference.current;
  const needsNormal = enabled && currentAccepted && !retained;
  useEffect(() => {
    if (!needsNormal) return undefined;
    // FinalPlanning's deliberate final preset is 56; never relabel that output as another preset.
    if (plannerId !== 'profiledSpline' || previewDensity !== 56 || projectionVersion !== 1 || normalPath.optimization?.accepted) {
      setFailure({ owner, error: { message: 'Could not prepare this trajectory.' }, errorKind: 'failure' });
      return undefined;
    }
    let active = true;
    let settled = false;
    const request = planner.request({ key: pathId, path: normalPath, robot, field, plannerId }, { deadline: 'common' });
    const complete = result => {
      if (!active || currentOwner.current !== owner) return;
      settled = true;
      const value = result.value, trajectory = value?.finalTrajectory;
      if (result.status === 'success' && completeAuthoredPreview(value, plannerId)) {
        reference.current = { identity, value, trajectory };
        setFailure({ owner, error: null, errorKind: null });
      } else {
        const error = finalPlanningError(result.status === 'success' ? { status: 'failure', error: { message: 'Could not prepare this trajectory.' } } : result);
        setFailure({ owner, error: error.error, errorKind: error.kind });
      }
    };
    request.promise.then(complete, error => complete({ status: 'failure', error }));
    return () => { active = false; if (!settled) request.cancel(); };
  }, [planner, owner, needsNormal]);

  const normalFailure = failure?.owner === owner ? failure : null;
  const error = editingError || (!retained ? normalFailure?.error : null);
  const normal = {
    status: error ? 'error' : retained ? 'ready' : 'pending', value: error ? null : retained?.value || null,
    error: error || null, errorKind: editingError ? editing.errorKind || 'failure' : error ? normalFailure.errorKind : null,
    retry: editingError || editing.comparisonError ? editing.retry : retryNormal,
  };
  return { selected, normal, baselineTime: normal.value ? retained.trajectory.totalTimeS : null };
}
