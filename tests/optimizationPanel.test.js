import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OptimizationPanel } from '../src/renderer/components/OptimizationPanel';

const render = (patch) => renderToStaticMarkup(React.createElement(OptimizationPanel, {
  path: { id: 'path' }, paths: [], state: { paths: {}, running: false },
  unitSystem: 'metric', mode: 'selected', ...patch,
}));

describe('optimizer planning failure', () => {
  it('keeps route search available when the starting curve cannot be timed', () => {
    const markup = render({ pending: false, error: new Error('Entry speed exceeds the limit <4 m/s>.'), recovery: { label: 'Edit path' } });
    expect(markup).toContain('Entry speed exceeds the limit &lt;4 m/s&gt;.');
    expect(markup).toMatch(/<button[^>]*class="qbtn optimizer-recovery"[^>]*>Edit path<\/button>/);
    expect(markup).toMatch(/class="optimizer-main primary">Optimize<\/button>/);
    expect(markup).toMatch(/class="optimizer-choice" disabled=""[^>]*aria-label="Preview current path trajectory, unavailable"/);
    expect(markup).toContain('Unavailable');
    expect(markup).not.toContain('Preparing path');
    expect(markup).toContain('Trajectory comparison');
  });

  it('keeps pending work quiet and enables search after planning succeeds', () => {
    const loading = render({ pending: true });
    expect(loading).toContain('<progress');
    expect(loading).toContain('aria-busy="true"');
    expect(loading).not.toContain('Preparing path…');
    expect(loading).toMatch(/class="optimizer-main primary">Optimize<\/button>/);
    expect(loading).not.toContain('role="alert"');
    const ready = render({ pending: false, baselineTime: 3 });
    expect(ready).toContain('3.00 s');
    expect(ready).toMatch(/class="optimizer-main primary">Optimize<\/button>/);
  });

  it('shows cancellable progress without a ticking status message during search', () => {
    const markup = render({ state: { running: true, paths: { path: { status: 'searching', startedAt: 0 } } } });
    expect(markup).toContain('aria-label="Optimizing path"');
    expect(markup).toContain('>Cancel</button>');
    expect(markup).not.toContain('Optimizing…');
  });
});


describe('optimization job ownership', () => {
  const background = {
    paths: [{ id: 'other', name: 'Scoring approach' }],
    state: { running: true, paths: { other: { status: 'searching' } } },
    pending: false, baselineTime: 4,
  };
  it('names the other path without claiming its progress or result for the selected path', () => {
    const markup = render(background);
    expect(markup).toContain('Search in progress');
    expect(markup).toContain('<strong>Scoring approach</strong>');
    expect(markup).toContain('aria-label="Cancel optimization for Scoring approach"');
    expect(markup).toContain('aria-busy="false"');
    expect(markup).not.toContain('aria-label="Optimizing path"');
    expect(markup).toMatch(/class="optimizer-main primary" disabled="">Optimize<\/button>/);
    expect(markup).toContain('4.00 s');
  });
  it('preserves an explicit current-path Apply while another path is searching', () => {
    const markup = render({ ...background, candidate: { finalTrajectory: { totalTimeS: 3, optimization: { fallback: false } } } });
    expect(markup).toContain('1.00 s faster, 25.0%');
    expect(markup).toMatch(/class="optimizer-main primary">Apply new route<\/button>/);
    expect(markup).toContain('Cancel optimization for Scoring approach');
  });
  it('labels batch cancellation honestly and keeps it available if current-path planning fails', () => {
    const markup = render({ ...background, state: { ...background.state, batch: { completed: 0, total: 2 } }, error: new Error('Invalid geometry') });
    expect(markup).toContain('aria-label="Cancel all optimization searches"');
    expect(markup).toContain('Cancel all');
    expect(markup).toContain('Invalid geometry');
  });
});

describe('waypoint-route outcomes', () => {
  const candidate = { finalTrajectory: { totalTimeS: 3, optimization: { fallback: false } } };
  it('offers a feasible route without inventing a Normal time or gain', () => {
    const markup = render({ candidate, error: new Error('Seed cannot be timed'), baselineTime: null });
    expect(markup).toContain('Fixes your path');
    expect(markup).toContain('3.00 s');
    expect(markup).toContain('Apply new route');
    expect(markup).not.toContain('faster,');
    expect(markup).not.toContain('%');
  });
  it('offers a clear route slower than an invalid drawn curve, and says it is slower and why', () => {
    const markup = render({ candidate: { ...candidate, routeSearch: { seedStatus: 'invalid',
      seedIssue: 'Robot footprint or portal clearance is invalid.' } }, baselineTime: 2 });
    expect(markup).toContain('Fixes your path, 1.00 s slower');
    expect(markup).not.toContain('Route found');
    expect(markup).not.toContain('optimizer-outcome gain');
    expect(markup).toContain('Your path hits the field. New route clears it.');
    expect(markup).toContain('Current path timing is shown for comparison only.');
    expect(markup).toContain('Apply new route');
    expect(markup).not.toContain('No faster route found');
  });
  it('never calls a repaired route with a sub-threshold gain slower', () => {
    const markup = render({ candidate: { ...candidate, routeSearch: { seedStatus: 'invalid' } }, baselineTime: 3.004 });
    expect(markup).toContain('Fixes your path, same time');
    expect(markup).not.toContain('slower');
  });
  it('reports a real gain when repairing an invalid drawn curve also makes it faster', () => {
    const markup = render({ candidate: { ...candidate, routeSearch: { seedStatus: 'invalid' } }, baselineTime: 4 });
    expect(markup).toContain('1.00 s faster, 25.0%');
    expect(markup).toContain('optimizer-outcome gain');
    expect(markup).toContain('The current curve doesn’t meet the path’s requirements.');
    expect(markup).toContain('Apply new route');
  });
  it('does not promote a slower route just because seed qualification is unknown', () => {
    const markup = render({ candidate: { ...candidate, routeSearch: { seedStatus: 'unknown' } }, baselineTime: 2 });
    expect(markup).not.toContain('Route found');
    expect(markup).not.toContain('Apply new route');
    expect(markup).toContain('No faster route found');
  });
  it.each([
    { optimization: { fallback: true } },
    { diagnostics: [{ severity: 'error', message: 'Invalid route' }] },
    { optimization: { fallback: false, termination: 'unsupported' } },
  ])('never offers invalid or fallback output for Apply: %j', (patch) => {
    const markup = render({ candidate: { finalTrajectory: { ...candidate.finalTrajectory, ...patch } }, error: new Error('Seed failed') });
    expect(markup).not.toContain('Apply new route');
    expect(markup).not.toContain('Route found');
  });
  it('shows bounded exhaustion and unsupported reasons without claiming infeasibility', () => {
    const exhausted = render({ searchStatus: 'no-candidate', searchReason: 'No validated route was found within this search.' });
    expect(exhausted).toContain('No route found');
    expect(exhausted).not.toContain('Search deeper looks longer.');
    expect(exhausted).not.toContain('infeasible');
    const unsupported = render({ searchStatus: 'unsupported', searchReason: 'Jiggle is not supported.' });
    expect(unsupported).toContain('Not supported for this path');
    expect(unsupported).toContain('Jiggle is not supported.');
  });
  it('shows decisive search rejection details even without a candidate trajectory', () => {
    const markup = render({ searchStatus: 'no-candidate', candidate: { routeSearch: { status: 'no-candidate',
      statistics: { evaluations: 4, rejectionReasons: [{ reason: 'Required point overlaps the HUB.', count: 4 }] } } } });
    expect(markup).toContain('Required point overlaps the HUB.');
    expect(markup).toContain('4 checked');
    expect(markup).toContain('<summary>Details</summary>');
    expect(markup).not.toContain('Search deeper looks longer.');
  });
});


describe('after Apply', () => {
  it('says the path changed and how to undo it, with nothing stored to switch back to', () => {
    const markup = render({ applied: true, baselineTime: 4 });
    expect(markup).toContain('Applied to the path');
    expect(markup).toContain('Undo restores the earlier curve. Optimize again may move or remove the waypoints it added.');
    expect(markup).toMatch(/class="optimizer-main primary">Optimize again<\/button>/);
    expect(markup).not.toContain('Use normal');
    expect(markup).not.toContain('In use');
    expect(markup).toMatch(/Current path<\/span><b>4.00 s<\/b>/);
  });

  it('offers a new result over the applied path, compared with the path as it is now', () => {
    const markup = render({ applied: true, baselineTime: 4, candidate: { finalTrajectory: { totalTimeS: 3, samples: [{}, {}], diagnostics: [],
      optimization: { fallback: false } }, routeSearch: { seedStatus: 'valid' } } });
    expect(markup).toContain('1.00 s faster, 25.0%');
    expect(markup).toContain('Apply new route');
    expect(markup).not.toContain('Undo restores the earlier curve.');
  });
});

describe('batch search copy', () => {
  it('describes completed batch searches in the past tense', () => {
    const markup = render({ baselineTime: 4, paths: [{ id: 'path', name: 'Approach' }],
      state: { running: false, batch: { completed: 1, total: 1 }, paths: { path: { status: 'success' } } } });
    expect(markup).not.toContain('Needs update');
    expect(markup).toContain('<small>Searched</small>');
    expect(markup).not.toContain('<small>Ready</small>');
  });
});

describe('result rows after a search', () => {
  const trajectory = (totalTimeS, tag = totalTimeS) => ({ totalTimeS, samples: [tag], optimization: { fallback: false } });
  const searched = (status = 'success') => ({ status });
  const rowOf = (markup, name) => markup.match(new RegExp(`<button[^>]*aria-label="Preview ${name} trajectory[^"]*"[^>]*>.*?</button>`))?.[0];
  const hints = { 'same shape': 'Keeps the tangent direction at every waypoint and stays within 0.15 m of your curve.',
    'new route': 'May take any path through your waypoints, around obstacles.' };
  const labels = { 'same shape': 'Same shape', 'new route': 'New route' };
  const disabledWith = (markup, name, reason) => {
    const row = rowOf(markup, name);
    expect(row).toMatch(/^<button[^>]* disabled=""/);
    expect(row).toContain('aria-pressed="false"');
    expect(row).toContain(`aria-label="Preview ${name} trajectory, ${reason.toLowerCase()}"`);
    expect(row).toContain(`title="${hints[name]}"`);
    expect(row).toContain(`${labels[name]}</span><small>${reason}</small>`);
    expect(row).not.toContain('<b>');
  };

  it('greys both rows with "No faster path found" when the search found nothing materially faster', () => {
    const none = render({ baselineTime: 3, entry: searched(), candidate: { finalTrajectory: trajectory(3) } });
    disabledWith(none, 'same shape', 'No faster path found');
    disabledWith(none, 'new route', 'No faster path found');
    expect(none.indexOf('Preview same shape')).toBeLessThan(none.indexOf('Preview new route'));
    expect(none).not.toContain('>Apply ');
    expect(none).toContain('Avoids obstacles. Keeps waypoints, headings and stops.');
    expect(none).not.toContain('Same shape keeps');
    const immaterial = render({ baselineTime: 3, entry: searched(), mode: 'shape',
      candidate: { finalTrajectory: trajectory(2.99), shape: { finalTrajectory: trajectory(2.995) } } });
    disabledWith(immaterial, 'same shape', 'No faster path found');
    disabledWith(immaterial, 'new route', 'No faster path found');
    expect(immaterial).not.toContain('>Apply ');
  });
  it('greys Same shape beside a faster new route, which keeps Apply and the copy for one result', () => {
    const markup = render({ baselineTime: 4, entry: searched(), candidate: { finalTrajectory: trajectory(3) } });
    disabledWith(markup, 'same shape', 'No faster path found');
    expect(rowOf(markup, 'new route')).toContain('aria-label="Preview new route trajectory" aria-pressed="false"');
    expect(markup).toMatch(/class="optimizer-main primary">Apply new route<\/button>/);
    expect(markup).toContain('Avoids obstacles. Keeps waypoints, headings and stops.');
    expect(markup).not.toContain('Both keep');
  });
  it('greys a route that adds nothing over the same-shape result, and says so instead of "No faster path found"', () => {
    const markup = render({ baselineTime: 4, entry: searched(), mode: 'shape',
      candidate: { finalTrajectory: trajectory(2.995), shape: { finalTrajectory: trajectory(3) } } });
    const row = rowOf(markup, 'same shape');
    expect(row).not.toContain('disabled');
    expect(row).toContain('aria-label="Preview same shape trajectory" aria-pressed="true"');
    expect(row).toContain('<b>3.00 s</b>');
    disabledWith(markup, 'new route', 'Not faster than same shape');
    expect(markup).toMatch(/class="optimizer-main primary">Apply same shape<\/button>/);
    expect(markup).not.toContain('Apply new route');
    expect(markup).toContain('Same shape keeps waypoints, headings, stops and your tangents.');
  });
  it('never presses a greyed route row, even as the previewed mode', () => {
    const markup = render({ baselineTime: 3, entry: searched(), mode: 'candidate', candidate: { finalTrajectory: trajectory(3) } });
    disabledWith(markup, 'new route', 'No faster path found');
  });
  it.each([
    ['a search that hit the time limit', { entry: searched('timeout') }, 'Ran out of time'],
    ['a canceled search', { entry: searched('canceled') }, 'Search canceled'],
    ['a failed search', { entry: searched('failure') }, 'Search failed'],
  ])('names %s on a row left without a result, and judges the result it did return', (_name, { entry }, reason) => {
    const markup = render({ baselineTime: 3, entry, candidate: { finalTrajectory: trajectory(3) } });
    disabledWith(markup, 'same shape', reason);
    disabledWith(markup, 'new route', 'No faster path found');
    const missing = render({ baselineTime: 3, entry, candidate: null });
    disabledWith(missing, 'same shape', reason);
    disabledWith(missing, 'new route', reason);
    const neither = render({ baselineTime: 3, entry, candidate: { routeSearch: { status: 'no-candidate' } } });
    disabledWith(neither, 'same shape', reason);
    disabledWith(neither, 'new route', reason);
  });
  it('says the same-shape search ran out of time when the route search used the whole time', () => {
    const markup = render({ baselineTime: 3, entry: searched(), candidate: { finalTrajectory: trajectory(3), routeSearch: { termination: 'time-budget' } } });
    disabledWith(markup, 'same shape', 'Ran out of time');
    disabledWith(markup, 'new route', 'No faster path found');
  });
  it('does not call a missing result "not faster" when the path cannot be driven as drawn', () => {
    const failed = render({ error: new Error('Seed cannot be timed'), baselineTime: null, entry: searched(), candidate: { finalTrajectory: trajectory(3) } });
    disabledWith(failed, 'same shape', 'No path found');
    expect(rowOf(failed, 'new route')).not.toContain('disabled');
    const collides = render({ baselineTime: 3, entry: searched(), candidate: { routeSearch: { status: 'no-candidate', seedStatus: 'invalid' } } });
    disabledWith(collides, 'same shape', 'No path found');
    disabledWith(collides, 'new route', 'No path found');
    const unsupported = render({ baselineTime: 3, entry: searched(), searchStatus: 'unsupported', candidate: { routeSearch: { status: 'unsupported' } } });
    disabledWith(unsupported, 'same shape', 'Not supported');
    disabledWith(unsupported, 'new route', 'Not supported');
  });
  it('gives no verdict while Normal is still being timed', () => {
    const waiting = render({ pending: true, entry: searched(),
      candidate: { finalTrajectory: trajectory(3), shape: { finalTrajectory: trajectory(2) } } });
    disabledWith(waiting, 'same shape', 'Waiting for timing');
    disabledWith(waiting, 'new route', 'Waiting for timing');
  });
  it('shows no verdict for a search of an earlier version of the path', () => {
    const markup = render({ baselineTime: 3, state: { running: false, paths: { path: { status: 'timeout' } } } });
    expect(rowOf(markup, 'same shape')).toBeUndefined();
    expect(rowOf(markup, 'new route')).toBeUndefined();
  });
});
