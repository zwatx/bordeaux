import * as React from 'react';
import { UI } from './ui';
import { DRAWN_SHAPE_LIMIT_M, materialGainS as materialGain } from '../../core/planners/limits';

const h = React.createElement;
const seconds = (value) => Number.isFinite(value) ? `${value.toFixed(2)} s` : '—';
const terminationLabels = { completed: 'Finished', 'work-budget': 'Effort limit reached', 'time-budget': 'Time limit reached',
  cancelled: 'Canceled', unsupported: 'Unsupported path', 'invalid-baseline': 'Drawn curve couldn’t be timed' };
const batchLabels = { success: 'Searched', searching: 'Searching', failure: 'Failed', timeout: 'Time limit', canceled: 'Canceled', stale: 'Outdated' };
const routeLabels = { 'no-candidate': 'No route found', unsupported: 'Unsupported', cancelled: 'Canceled' };
// Validator wording is precise but internal; say what the drawn curve does wrong.
const seedIssueCopy = (issue) => !issue ? 'The current curve doesn’t meet the path’s requirements.'
  : /footprint|clearance/i.test(issue) ? 'The current curve runs the robot into a wall or field obstacle.'
  : issue;

// One Optimize runs two searches, and `candidate` carries both results. Its own trajectory is the route search's:
// the task is the required waypoints, set headings, stops, and field, and the current curve only seeds it.
// `candidate.shape` is the search that keeps the current curve's tangents and stays close to it.
// Apply writes the chosen curve into the path; `applied` is true while the path is the one Apply just wrote.
// `entry` is the search of this path as it is now; a search of an earlier version of the path is not shown.
// `error` and `pending` describe the current path's own timing, never a search.
// `searchStatus`/`searchReason` carry the route search envelope when the worker supplies it.
export function OptimizationPanel({ path, paths, state, entry = null, candidate, applied, baselineTime, pending, error, recovery, mode,
  searchStatus, searchReason, unitSystem, onStart, onStartAll, onCancel, onCompare, onApply, onSelectPath, onClose }) {
  // The controller runs one job at a time; only its searching entry owns progress.
  const activePathId = state.running ? Object.keys(state.paths).find((id) => state.paths[id].status === 'searching') : null;
  const searchingCurrentPath = activePathId === path.id;
  const backgroundPath = activePathId && !searchingCurrentPath
    ? paths.find((item) => item.id === activePathId) : null;
  const search = candidate?.routeSearch;
  // Only the strict plan of this exact path is a baseline; a search's own baseline may differ in density.
  const normalFailed = Boolean(error);
  const normalReady = !normalFailed && Number.isFinite(baselineTime);
  const distance = (value) => `${(value * (unitSystem === 'imperial' ? 3.280839895 : 1)).toFixed(2)} ${unitSystem === 'imperial' ? 'ft' : 'm'}`;
  /** What one search result offers against the current path. `preview` is the route reply or its `shape` part. */
  const describe = (preview) => {
    const result = preview?.finalTrajectory;
    const details = result?.optimization || preview?.routeSearch?.statistics;
    // A fallback, an error diagnostic, or an unsupported/unstarted search is never a route.
    const route = Boolean(result && details && details.fallback === false && Number.isFinite(result.totalTimeS) && result.totalTimeS > 0
      && details.termination !== 'unsupported' && details.termination !== 'invalid-baseline'
      && !result.diagnostics?.some((issue) => issue.severity === 'error'));
    const gain = route && normalReady ? baselineTime - result.totalTimeS : 0;
    const improved = route && normalReady && gain >= materialGain(baselineTime) - 1e-8;
    // Without a timed drawn curve, any validated route changes feasibility; there is no percentage to report.
    const madeFeasible = route && (preview?.routeSearch?.seedStatus === 'invalid' || (!normalReady && normalFailed));
    return { result, details, route, gain, improved, madeFeasible, newCandidate: improved || madeFeasible };
  };
  const routeOffer = describe(candidate);
  const shapeOffer = describe(candidate?.shape);
  // A new route that is not materially faster than the same-shape result has nothing to offer over it.
  const routeAddsNothing = (shapeOffer.improved || shapeOffer.madeFeasible) && routeOffer.newCandidate
    && routeOffer.result.totalTimeS > shapeOffer.result.totalTimeS - materialGain(shapeOffer.result.totalTimeS);
  const offers = [
    shapeOffer.newCandidate && { ...shapeOffer, value: 'shape', label: 'Same shape',
      hint: `Keeps the tangent direction at every waypoint and stays within ${distance(DRAWN_SHAPE_LIMIT_M)} of your curve.` },
    routeOffer.newCandidate && !routeAddsNothing && { ...routeOffer, value: 'candidate', label: 'New route',
      hint: 'May take any path through your waypoints, around obstacles.' },
  ].filter(Boolean);
  // Apply and the headline follow the result being previewed, otherwise the first result offered.
  const chosen = offers.find((offer) => offer.value === mode) || offers[0] || null;
  const { details, route } = routeOffer;
  // With nothing new to offer, the headline describes the route search.
  const lead = chosen || routeOffer;
  const { gain, improved, madeFeasible } = lead;
  const invalidSeed = search?.seedStatus === 'invalid';
  const newCandidate = Boolean(chosen);
  // A route still waiting on Normal timing is neither a gain nor a miss yet.
  const comparing = route && !normalReady && !normalFailed && !madeFeasible;
  const unsupported = searchStatus === 'unsupported' || details?.termination === 'unsupported';
  // Exhausting a search budget is not proof that no route exists.
  // A same-shape result is a route too, offered or in use.
  const noRoute = !route && !shapeOffer.route && !unsupported && !searchingCurrentPath
    && (searchStatus === 'no-candidate' || entry?.status === 'success' || entry?.status === 'timeout');
  const rejection = details?.rejectionReasons?.reduce((top, item) => !top || item.count > top.count ? item : top, null);
  const reason = !searchingCurrentPath && (unsupported || noRoute)
    ? rejection?.reason || searchReason : '';
  const idle = normalFailed ? 'Find a route' : 'Find a faster route';
  // A repaired route is never labeled as a plain success: say how it compares to the drawn timing.
  const outcome = searchingCurrentPath || comparing ? idle
    : improved ? `${seconds(gain)} faster, ${(gain / baselineTime * 100).toFixed(1)}%`
    : madeFeasible && normalReady ? (gain > -0.005 ? 'Clear route, same time' : `Clear route, ${seconds(-gain)} slower`)
    : madeFeasible ? 'Route found'
    : unsupported ? 'Not supported for this path'
    : entry?.status === 'canceled' ? 'Search canceled'
    : entry?.status === 'failure' ? 'Couldn’t optimize'
    : route ? 'No faster route found'
    : noRoute ? (entry?.status === 'timeout' ? 'No route found in time' : 'No route found')
    : applied ? 'Applied to the path' : idle;
  const row = (label, time, value, disabled = false, note = null, hint = undefined) => h('button', {
    key: value, type: 'button', className: 'optimizer-choice', disabled, title: hint,
    'aria-label': `Preview ${label.toLowerCase()} trajectory`,
    'aria-pressed': !disabled && (mode === value || (mode === 'selected' && value === 'normal')),
    onClick: () => onCompare(value),
  }, h('span', { className: 'optimizer-choice-name' }, label),
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
        h('p', { className: 'optimizer-outcome' + (newCandidate && !searchingCurrentPath && (improved || !normalReady) ? ' gain' : ''), role: 'status' }, outcome),
        (pending || searchingCurrentPath) && h('progress', { className: 'optimizer-progress', 'aria-label': searchingCurrentPath ? 'Optimizing path' : 'Preparing path' })),
      reason && h('p', { className: 'optimizer-note optimizer-reason', 'aria-live': 'polite' }, reason),
      invalidSeed && !searchingCurrentPath && h('p', { className: 'optimizer-note optimizer-reason', 'aria-live': 'polite' },
        seedIssueCopy(search?.seedIssue), normalReady ? ' Its timing is shown for comparison only.' : ''),
      normalFailed && h('div', { className: 'optimizer-failure', role: 'status' },
        h('p', null, 'Timing isn’t available for the current curve. ', error.message || String(error)),
        !searchingCurrentPath && !newCandidate && !unsupported && !noRoute && h('p', null, 'Optimize can still look for a route through your waypoints.'),
        recovery && h('button', { type: 'button', className: 'qbtn optimizer-recovery', onClick: recovery.onClick }, recovery.label)),
      h('div', { className: 'optimizer-comparison', 'aria-label': 'Trajectory comparison' },
        h('div', { className: 'optimizer-label' }, 'Preview'),
        row('Current path', baselineTime, 'normal', !normalReady, normalFailed ? 'Unavailable' : null),
        offers.map((offer) => row(offer.label, offer.result.totalTimeS, offer.value, false, null, offer.hint))),
      applied && !newCandidate && !searchingCurrentPath && h('p', { className: 'optimizer-note', role: 'status' },
        'Undo restores the earlier curve. Optimize again may move or remove the waypoints it added.'),
      searchingCurrentPath ? h('button', { type: 'button', className: 'optimizer-main', onClick: onCancel }, 'Cancel')
        : newCandidate ? h('button', { type: 'button', className: 'optimizer-main primary', onClick: () => onApply(chosen.value) }, `Apply ${chosen.label.toLowerCase()}`)
        : h('button', { type: 'button', className: 'optimizer-main primary', disabled: startDisabled, onClick: () => onStart('common') },
          applied ? 'Optimize again' : entry ? 'Try again' : 'Optimize'),
      h('p', { className: 'optimizer-note optimizer-task' },
        offers.length > 1 ? 'Both keep waypoints, headings and stops. Same shape also keeps your tangents.'
          : offers[0]?.value === 'shape' ? 'Same shape keeps waypoints, headings, stops and your tangents.'
          : 'Avoids obstacles. Keeps waypoints, headings and stops.'),
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
        details?.rejectionReasons?.length > 0 && h('ul', null, details.rejectionReasons.map((item) => h('li', { key: item.reason }, `${item.reason.replace(/\.$/, '')} (${item.count})`)))),
      state.batch && h('details', { className: 'optimizer-batch', open: true },
        h('summary', null, `${state.batch.completed} of ${state.batch.total} paths searched`),
        h('div', null, paths.map((item) => h('button', { key: item.id, type: 'button', onClick: () => onSelectPath(item.id) },
          h('span', null, item.name), h('small', null,
            // A path with a same-shape result has something to offer even when the route search found nothing.
            (!state.paths[item.id]?.value?.shape && routeLabels[state.paths[item.id]?.value?.routeSearch?.status])
              || batchLabels[state.paths[item.id]?.status] || 'Queued')))))));
}
