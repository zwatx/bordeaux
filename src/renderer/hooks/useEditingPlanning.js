import { useEffect, useMemo, useState } from 'react';
import { PathPreview } from '../assets/path-preview';
import { editingGeometry, editingPoseAtTime } from '../assets/editing-planning';

/** Current drawable edit geometry; strict readiness is separate from display timing. */
export function useEditingPlanning(path, robot, field, enabled = true) {
  const acceptedIdentity = path.optimization?.accepted || null;
  const geometry = useMemo(() => editingGeometry(path, 14, robot), [path, robot]);
  const previewer = useMemo(() => PathPreview.create({
    directIsSafe: () => false,
    workerPayload: job => ({ id: job.revision, mode: 'editing', path: job.path, robot: job.robot, field: job.field, perSegment: job.perSegment, quality: job.quality }),
  }), []);
  const [snapshot, setSnapshot] = useState(() => previewer.getSnapshot());
  const [attempt, setAttempt] = useState(0);
  const [request, setRequest] = useState(null);
  useEffect(() => previewer.retain(), [previewer]);
  useEffect(() => previewer.subscribe(() => setSnapshot(previewer.getSnapshot())), [previewer]);
  useEffect(() => {
    if (!enabled) { previewer.cancel(); return; }
    const revision = previewer.request({ path, robot, field, key: path.id, quality: 'final' });
    setRequest({ path, robot, field, revision, attempt, acceptedIdentity });
  }, [previewer, path, robot, field, enabled, attempt, acceptedIdentity]);
  const matching = enabled && request?.path === path && request.robot === robot && request.field === field
    && request.acceptedIdentity === acceptedIdentity && request.attempt === attempt && snapshot.sourceRevision === request.revision;
  const failure = enabled && request?.path === path && request.robot === robot && request.field === field
    && request.acceptedIdentity === acceptedIdentity && request.attempt === attempt && snapshot.status === 'error' && snapshot.errorPath === path && snapshot.sourceRevision === request.revision;
  const plan = matching && snapshot.status === 'ready' ? snapshot.value : null;
  const status = !enabled ? 'idle' : failure ? 'error' : plan?.status || 'pending';
  const ready = status === 'ok' && Boolean(plan?.trajectory);
  const strictPreview = useMemo(() => {
    const comparison = plan?.comparison;
    if (!ready || snapshot.quality !== 'final' || comparison?.status !== 'ready' || comparison.projectionVersion !== 1
      || comparison.previewDensity !== PathPreview.samplesForQuality('final') || !plan.derived) return null;
    const accepted = Boolean(plan.acceptedTrajectory);
    const trajectoryDensity = accepted ? request.acceptedIdentity?.samplesPerSegment : comparison.previewDensity;
    if (!Number.isInteger(trajectoryDensity) || trajectoryDensity < 1) return null;
    return { value: plan.derived, trajectory: plan.trajectory, path: request.path, robot: request.robot, field: request.field,
      revision: request.revision, attempt: request.attempt, acceptedIdentity: request.acceptedIdentity, accepted,
      plannerId: 'profiledSpline', projectionVersion: comparison.projectionVersion, previewDensity: comparison.previewDensity, trajectoryDensity };
  }, [ready, plan, snapshot.quality, request]);
  const comparisonError = ready && snapshot.quality === 'final' && plan?.comparison?.status === 'error' ? plan.comparison : null;
  const value = plan?.derived || geometry;
  const error = useMemo(() => failure ? { ...snapshot.error, message: snapshot.error.message.replace(' This path is too large to derive safely on the UI thread.', ' Try again.') } : null, [failure, snapshot.error]);
  const issues = useMemo(() => plan?.issues || (error ? [{ code: 'planner-error', severity: 'error', f0: 0, f1: 1, message: error.message }] : []), [plan, error]);
  const retry = useMemo(() => () => setAttempt(n => n + 1), []);
  const samples = plan?.bestEffort?.samples;
  const poseAtTime = useMemo(() => time => editingPoseAtTime(time, samples), [samples]);
  return {
    value, derived: value, status, ready, pending: status === 'pending', stale: false,
    trajectory: ready ? plan.trajectory : null, bestEffort: plan?.bestEffort || null,
    issues,
    error, errorKind: error ? (/timed out/i.test(error.message) ? 'timeout' : 'failure') : null, durationMs: matching ? snapshot.durationMs : 0,
    acceptedTrajectory: Boolean(plan?.acceptedTrajectory), strictPreview, comparisonError, retry, poseAtTime,
  };
}
