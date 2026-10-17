import * as React from 'react';
import { UI } from './ui';

const h = React.createElement;
const seconds = (value) => Number.isFinite(value) ? `${value.toFixed(2)} s` : '—';
const terminationLabels = { completed: 'Finished', 'work-budget': 'Effort limit reached', 'time-budget': 'Time limit reached',
  cancelled: 'Canceled', unsupported: 'Unsupported path', 'invalid-baseline': 'Drawn curve couldn’t be timed' };
const batchLabels = { success: 'Searched', searching: 'Searching', failure: 'Failed', timeout: 'Time limit', canceled: 'Canceled', stale: 'Outdated' };
const routeLabels = { 'no-candidate': 'No route found', unsupported: 'Unsupported', cancelled: 'Canceled' };

// The task is the required waypoints, set headings, stops, and field; the drawn curve only seeds the search.
// `error` and `pending` describe Normal timing of the drawn curve, never the route search.
// `searchStatus`/`searchReason` carry the route search envelope when the worker supplies it.
export function OptimizationPanel({ path, paths, state, candidate, accepted, acceptedVersion, stale, baselineTime, pending, error, recovery, mode,
  searchStatus, searchReason, unitSystem, onStart, onStartAll, onCancel, onCompare, onApply, onNormal, onSelectPath, onClose }) {
  const entry = state.paths[path.id];
  // The controller runs one job at a time; only its searching entry owns progress.
  const activePathId = state.running ? Object.keys(state.paths).find((id) => state.paths[id].status === 'searching') : null;
  const searchingCurrentPath = activePathId === path.id;
  const backgroundPath = activePathId && !searchingCurrentPath
    ? paths.find((item) => item.id === activePathId) : null;
  const result = candidate?.finalTrajectory;
  const search = candidate?.routeSearch;
  const details = result?.optimization || search?.statistics;
  // Only a strict Normal plan of this exact input is a baseline; a search's own baseline may differ in density.
  const normalFailed = Boolean(error);
  const normalReady = !normalFailed && Number.isFinite(baselineTime);
  // A fallback, an error diagnostic, or an unsupported/unstarted search is never a route.
  const route = Boolean(result && details && details.fallback === false && Number.isFinite(result.totalTimeS) && result.totalTimeS > 0
    && details.termination !== 'unsupported' && details.termination !== 'invalid-baseline'
    && !result.diagnostics?.some((issue) => issue.severity === 'error'));
  const gain = route && normalReady ? baselineTime - result.totalTimeS : 0;
  const improved = route && normalReady && gain >= Math.max(0.02, baselineTime * 0.005) - 1e-8;
  // Without a timed drawn curve, any validated route changes feasibility; there is no percentage to report.
  const invalidSeed = search?.seedStatus === 'invalid';
  const madeFeasible = route && (invalidSeed || (!normalReady && normalFailed));
  // Equal duration alone does not mean the same route is applied.
  const alreadyApplied = React.useMemo(() => Boolean(accepted && result && accepted.totalTimeS === result.totalTimeS
    && JSON.stringify([accepted.samples, accepted.optimizedPath, accepted.stationaryActions, accepted.markers])
      === JSON.stringify([result.samples, result.optimizedPath, result.stationaryActions, result.markers])), [accepted, result]);
  const newCandidate = (improved || madeFeasible) && !alreadyApplied;
  // A route still waiting on Normal timing is neither a gain nor a miss yet.
  const comparing = route && !normalReady && !normalFailed && !madeFeasible;
  const unsupported = searchStatus === 'unsupported' || details?.termination === 'unsupported';
  // Exhausting a search budget is not proof that no route exists.
  const noRoute = !route && !unsupported && !searchingCurrentPath
    && (searchStatus === 'no-candidate' || entry?.status === 'success' || entry?.status === 'timeout');
  const rejection = details?.rejectionReasons?.reduce((top, item) => !top || item.count > top.count ? item : top, null);
  const reason = !searchingCurrentPath && !stale && (unsupported || noRoute)
    ? rejection?.reason || searchReason : '';
  const legacy = Boolean(accepted) && (acceptedVersion ?? path.optimization?.accepted?.version) === 1;
  const distance = (value) => `${(value * (unitSystem === 'imperial' ? 3.280839895 : 1)).toFixed(2)} ${unitSystem === 'imperial' ? 'ft' : 'm'}`;
  const idle = normalFailed ? 'Find a route' : 'Find a faster route';
  const outcome = searchingCurrentPath || comparing ? idle
    : madeFeasible ? 'Route found'
    : improved ? `${seconds(gain)} faster, ${(gain / baselineTime * 100).toFixed(1)}%`
    : stale ? 'Needs update'
    : unsupported ? 'Not supported for this path'
    : entry?.status === 'canceled' ? 'Search canceled'
    : entry?.status === 'failure' ? 'Couldn’t optimize'
    : route && !alreadyApplied ? 'No faster route found'
    : noRoute ? (entry?.status === 'timeout' ? 'No route found in time' : 'No route found')
    : accepted ? (legacy ? 'Earlier optimization applied' : 'Optimization applied') : idle;
  const row = (label, time, value, applied, disabled = false, note = null) => h('button', {
    key: value, type: 'button', className: 'optimizer-choice', disabled,
    'aria-label': `Preview ${label.toLowerCase()} trajectory`,
    'aria-pressed': !disabled && (mode === value || (mode === 'selected' && value === 'normal' && !accepted)),
    onClick: () => onCompare(value),
  }, h('span', { className: 'optimizer-choice-name' }, label, applied && h('small', null, 'In use')),
  note ? h('small', null, note) : h('b', null, seconds(time)));
  const startDisabled = state.running;
  const terminationLabel = terminationLabels[details?.termination || search?.termination];
  return h('section', { className: 'optimizer-panel', 'aria-label': 'Path optimization' },
    h('div', { className: 'optimizer-heading' }, h('strong', null, 'Optimize'),
      h(UI.IconBtn, { icon: 'x', title: 'Close optimization', onClick: onClose })),
    h('div', { className: 'optimizer-body' },
      backgroundPath && h('div', { className: 'optimizer-background', role: 'status' },
        h('span', null, 'Search in progress', h('strong', null, backgroundPath.name)),
        h('button', { type: 'button', onClick: onCancel,
          'aria-label': state.batch ? 'Cancel all optimization searches' : `Cancel optimization for ${backgroundPath.name}` },
        state.batch ? 'Cancel all' : 'Cancel search')),
      h('div', { className: 'optimizer-status', 'aria-busy': pending || searchingCurrentPath },
        h('p', { className: 'optimizer-outcome' + (newCandidate && !searchingCurrentPath ? ' gain' : ''), role: 'status' }, outcome),
        (pending || searchingCurrentPath) && h('progress', { className: 'optimizer-progress', 'aria-label': searchingCurrentPath ? 'Optimizing path' : 'Preparing path' })),
      reason && h('p', { className: 'optimizer-note optimizer-reason', 'aria-live': 'polite' }, reason),
      normalFailed && h('div', { className: 'optimizer-failure', role: 'status' },
        h('p', null, 'Normal timing isn’t available for the drawn curve. ', error.message || String(error)),
        !searchingCurrentPath && !newCandidate && !unsupported && !noRoute && h('p', null, 'Optimize can still look for a route through your waypoints.'),
        recovery && h('button', { type: 'button', className: 'qbtn optimizer-recovery', onClick: recovery.onClick }, recovery.label)),
      h('div', { className: 'optimizer-comparison', 'aria-label': 'Trajectory comparison' },
        h('div', { className: 'optimizer-label' }, 'Preview'),
        row('Normal', baselineTime, 'normal', normalReady && (!accepted || stale), !normalReady, normalFailed ? 'Unavailable' : null),
        accepted && row(newCandidate ? 'Applied' : 'Optimized', accepted.totalTimeS, 'selected', true),
        newCandidate && row('Optimized', result.totalTimeS, 'candidate', false)),
      legacy && !stale && !newCandidate && h('p', { className: 'optimizer-note' },
        `Applied by the earlier shape search, which kept within ${distance(path.optimization?.corridorM ?? 0.15)} of the drawn curve. Optimize again to search for a route through your waypoints.`),
      searchingCurrentPath ? h('button', { type: 'button', className: 'optimizer-main', onClick: onCancel }, 'Cancel')
        : newCandidate ? h('button', { type: 'button', className: 'optimizer-main primary', onClick: onApply }, 'Apply optimized')
        : accepted && !stale && !legacy ? h('button', { type: 'button', className: 'optimizer-main', disabled: true }, 'Applied')
        : h('button', { type: 'button', className: 'optimizer-main primary', disabled: startDisabled, onClick: () => onStart('common') },
          stale ? 'Update optimization' : legacy && !entry ? 'Optimize again' : entry ? 'Try again' : 'Optimize'),
      (accepted || stale) && h('button', { type: 'button', className: 'optimizer-reset', onClick: onNormal }, 'Use normal'),
      h('p', { className: 'optimizer-note optimizer-task' },
        'Keeps waypoints, set headings, and stops. Uses the drawn curve as a starting guess and avoids field obstacles.'),
      h('details', { className: 'optimizer-settings', key: `settings-${path.id}` },
        h('summary', null, 'Search options'),
        h('div', { className: 'optimizer-search-actions' },
          h('button', { type: 'button', disabled: startDisabled, onClick: () => onStart('common') }, 'Quick search', h('small', null, '5 s')),
          h('button', { type: 'button', disabled: startDisabled, onClick: () => onStart('stress') }, 'Search deeper', h('small', null, '15 s')),
          h('button', { type: 'button', disabled: startDisabled, onClick: onStartAll }, 'Optimize all'))),
      (details || entry?.error) && h('details', { className: 'optimizer-details', key: `details-${path.id}` },
        h('summary', null, 'Details'),
        h('dl', null,
          terminationLabel && h(React.Fragment, null, h('dt', null, 'Search'), h('dd', null, terminationLabel)),
          details && h(React.Fragment, null, h('dt', null, 'Candidates'), h('dd', null, `${details.evaluations || 0} checked`))),
        details?.activeConstraints?.length > 0 && h('p', null, 'Limited by ', [...new Set(details.activeConstraints)].map((name) => name.replaceAll('-', ' ')).join(', ')),
        details?.fallbackReason && h('p', null, details.fallbackReason),
        entry?.error && h('p', { className: 'optimizer-error' }, entry.error),
        details?.rejectionReasons?.length > 0 && h('ul', null, details.rejectionReasons.map((item) => h('li', { key: item.reason }, `${item.reason}: ${item.count}`)))),
      state.batch && h('details', { className: 'optimizer-batch', open: true },
        h('summary', null, `${state.batch.completed} of ${state.batch.total} paths searched`),
        h('div', null, paths.map((item) => h('button', { key: item.id, type: 'button', onClick: () => onSelectPath(item.id) },
          h('span', null, item.name), h('small', null,
            routeLabels[state.paths[item.id]?.value?.routeSearch?.status] || batchLabels[state.paths[item.id]?.status] || 'Queued')))))));
}
