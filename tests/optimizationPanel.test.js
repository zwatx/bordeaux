import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OptimizationPanel } from '../src/renderer/components/OptimizationPanel';

const render = (patch) => renderToStaticMarkup(React.createElement(OptimizationPanel, {
  path: { id: 'path', optimization: {} }, paths: [], state: { paths: {}, running: false },
  unitSystem: 'metric', mode: 'selected', ...patch,
}));

describe('optimizer planning failure', () => {
  it('keeps route search available when the starting curve cannot be timed', () => {
    const markup = render({ pending: false, error: new Error('Entry speed exceeds the limit <4 m/s>.'), recovery: { label: 'Edit path' } });
    expect(markup).toContain('Entry speed exceeds the limit &lt;4 m/s&gt;.');
    expect(markup).toMatch(/<button[^>]*class="qbtn optimizer-recovery"[^>]*>Edit path<\/button>/);
    expect(markup).toMatch(/class="optimizer-main primary">Optimize<\/button>/);
    expect(markup).toMatch(/class="optimizer-choice" disabled=""[^>]*aria-label="Preview normal trajectory"/);
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
    expect(markup).toMatch(/class="optimizer-main primary">Apply optimized<\/button>/);
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
    expect(markup).toContain('Route found');
    expect(markup).toContain('3.00 s');
    expect(markup).toContain('Apply optimized');
    expect(markup).not.toContain('faster,');
    expect(markup).not.toContain('%');
  });
  it('offers a clear route slower than an invalid drawn curve, and says it is slower and why', () => {
    const markup = render({ candidate: { ...candidate, routeSearch: { seedStatus: 'invalid',
      seedIssue: 'Robot footprint or portal clearance is invalid.' } }, baselineTime: 2 });
    expect(markup).toContain('Clear route, 1.00 s slower');
    expect(markup).not.toContain('Route found');
    expect(markup).not.toContain('optimizer-outcome gain');
    expect(markup).toContain('The drawn curve runs the robot into a wall or field obstacle.');
    expect(markup).toContain('Normal timing is shown for comparison only.');
    expect(markup).toContain('Apply optimized');
    expect(markup).not.toContain('No faster route found');
  });
  it('never calls a repaired route with a sub-threshold gain slower', () => {
    const markup = render({ candidate: { ...candidate, routeSearch: { seedStatus: 'invalid' } }, baselineTime: 3.004 });
    expect(markup).toContain('Clear route, same time');
    expect(markup).not.toContain('slower');
  });
  it('reports a real gain when repairing an invalid drawn curve also makes it faster', () => {
    const markup = render({ candidate: { ...candidate, routeSearch: { seedStatus: 'invalid' } }, baselineTime: 4 });
    expect(markup).toContain('1.00 s faster, 25.0%');
    expect(markup).toContain('optimizer-outcome gain');
    expect(markup).toContain('The drawn curve doesn’t meet the path’s requirements.');
    expect(markup).toContain('Apply optimized');
  });
  it('does not promote a slower route just because seed qualification is unknown', () => {
    const markup = render({ candidate: { ...candidate, routeSearch: { seedStatus: 'unknown' } }, baselineTime: 2 });
    expect(markup).not.toContain('Route found');
    expect(markup).not.toContain('Apply optimized');
    expect(markup).toContain('No faster route found');
  });
  it.each([
    { optimization: { fallback: true } },
    { diagnostics: [{ severity: 'error', message: 'Invalid route' }] },
    { optimization: { fallback: false, termination: 'unsupported' } },
  ])('never offers invalid or fallback output for Apply: %j', (patch) => {
    const markup = render({ candidate: { finalTrajectory: { ...candidate.finalTrajectory, ...patch } }, error: new Error('Seed failed') });
    expect(markup).not.toContain('Apply optimized');
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
  it('explains legacy selection in the chosen units without exposing deviation tuning', () => {
    const markup = render({ accepted: { totalTimeS: 3 }, path: { id: 'path', optimization: { corridorM: .3, accepted: { version: 1 } } }, unitSystem: 'imperial' });
    expect(markup).toContain('Earlier optimization applied');
    expect(markup).toContain('0.98 ft');
    expect(markup).toContain('Optimize again');
    expect(markup).not.toContain('Path freedom');
    expect(markup).not.toContain('<input');
  });
});


describe('outdated selection copy', () => {
  it('identifies current Normal timing while describing completed batch searches in the past tense', () => {
    const markup = render({ stale: true, baselineTime: 4, paths: [{ id: 'path', name: 'Approach' }],
      state: { running: false, batch: { completed: 1, total: 1 }, paths: { path: { status: 'success' } } } });
    expect(markup).toContain('Needs update');
    expect(markup).toMatch(/Normal<small>In use<\/small>/);
    expect(markup).toContain('<small>Searched</small>');
    expect(markup).not.toContain('<small>Ready</small>');
  });
});
