/**
 * The Normal row of the Optimize panel: the current path's own plan, which editing already solves.
 * Every path plans with the Normal planner, so this is also the time a search must beat.
 */
export function useOptimizerComparison({ context, editing }) {
  const { path, robot, field, plannerId, previewDensity, projectionVersion } = context;
  const preview = editing.strictPreview;
  const selected = editing.ready && editing.status === 'ok' && preview?.path === path && preview.robot === robot && preview.field === field
    && preview.plannerId === plannerId && preview.previewDensity === previewDensity && preview.projectionVersion === projectionVersion ? preview : null;
  const failed = !selected && !editing.pending && editing.status !== 'idle';
  const error = failed
    ? editing.comparisonError || editing.error || { message: editing.issues.find((issue) => issue.severity === 'error')?.message || 'Could not prepare this trajectory.' }
    : null;
  const normal = {
    status: error ? 'error' : selected ? 'ready' : 'pending', value: selected?.value || null,
    error, errorKind: error ? editing.errorKind || 'failure' : null, retry: editing.retry,
  };
  return { normal, baselineTime: selected ? selected.trajectory.totalTimeS : null };
}
