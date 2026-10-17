import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { authoredPath } from '../src/shared/planners/acceptedTrajectoryIdentity';

// Execute the actual App comparison wiring with controlled current planning outcomes.
// Render-time assertions run before any effect could conceal a stale applied bridge.
const source = readFileSync('src/renderer/app/App.jsx', 'utf8');
const block = source.slice(source.indexOf('    const planningPath = useMemo('), source.indexOf('    const selectedPreview = comparedPreview || acceptedPreview;'));
function harness() {
  const cells = []; let cursor = 0;
  const useMemo = (factory, deps) => {
    const cell = cells[cursor++] ||= {};
    if (!cell.deps || deps.some((value, i) => !Object.is(value, cell.deps[i]))) { cell.deps = deps; cell.value = factory(); }
    return cell.value;
  };
  const appliedPreview = { current: null };
  const state = { projectKey: 1, doc: { id: 'path' }, optimizationKey: 'physical', searchKey: 'physical', robot: {}, project: { field: {} }, plannerId: 'profiledSpline',
    PERSEG: 56, optimizationOpen: true, appliedPreview, optimizationState: { paths: {} }, comparison: null,
    editing: { status: 'pending', pending: true }, result: { selected: null, normal: { status: 'pending', value: null }, baselineTime: null } };
  const useEditingPlanning = vi.fn(() => state.editing), useOptimizerComparison = vi.fn(() => state.result);
  const isOptimizationOutdated = (path) => Boolean(path.optimization?.accepted?.inputKey && path.optimization.accepted.inputKey !== 'physical');
  const execute = new Function('state', 'useMemo', 'useEditingPlanning', 'useOptimizerComparison', 'authoredPath', 'isOptimizationOutdated', `
    const { projectKey, doc, optimizationKey, searchKey, robot, project, plannerId, PERSEG, optimizationOpen, appliedPreview, optimizationState, comparison } = state;
    ${block}
    return { planningPath, normalPath, planningRobot, planningField, selectedSettled, justApplied, acceptedPreview, accepted,
      staleOptimization, normalReady, normalError, baselineTime, candidate, comparisonMode, comparedPreview };
  `);
  return { state, appliedPreview, useOptimizerComparison, render(patch) { Object.assign(state, patch); cursor = 0;
    return execute(state, useMemo, useEditingPlanning, useOptimizerComparison, authoredPath, isOptimizationOutdated); } };
}
function applied(h) {
  const artifact = {}, value = { finalTrajectory: { totalTimeS: 2 }, sample: { pts: ['complete'] } };
  h.state.doc = { id: 'path', optimization: { accepted: artifact } };
  h.appliedPreview.current = { artifact, documentKey: 1, pathId: 'path', key: 'physical', plannerId: 'profiledSpline', previewDensity: 56, projectionVersion: 1, value };
  return { artifact, value };
}
describe('App qualified optimizer comparison ownership', () => {
  it('invalidates all planning input memos on matching-ID document replacement but retains physical Normal across acceptance', () => {
    const h = harness(), original = h.render();
    const artifact = {}; const accepted = h.render({ doc: { ...h.state.doc, optimization: { accepted: artifact } } });
    expect(accepted.planningPath).not.toBe(original.planningPath); expect(accepted.normalPath).toBe(original.normalPath);
    const replacement = h.render({ projectKey: 2 });
    expect(replacement.planningPath).not.toBe(accepted.planningPath); expect(replacement.normalPath).not.toBe(accepted.normalPath);
    const args = h.useOptimizerComparison.mock.calls.at(-1)[0];
    expect(args.context).toMatchObject({ documentKey: 2, pathId: 'path', inputKey: 'physical', plannerId: 'profiledSpline', previewDensity: 56, projectionVersion: 1 });
    expect(args.context.path).toBe(replacement.planningPath); expect(args.context.normalPath.optimization).toBeUndefined();
  });
  it('bridges only the exact just-applied pending artifact and retires on successful validation', () => {
    const h = harness(), { value } = applied(h);
    expect(h.render().acceptedPreview).toBe(value);
    const qualified = { finalTrajectory: { totalTimeS: 1.9 } };
    h.state.result.selected = { accepted: true, value: qualified };
    const ready = h.render({ editing: { status: 'ok', pending: false } });
    expect(ready.acceptedPreview).toBe(qualified); expect(ready.staleOptimization).toBe(false); expect(h.appliedPreview.current).toBeNull();
  });
  it.each(['infeasible', 'unfinished', 'error', 'ok'])('retires pending bridge on terminal %s without qualified accepted selection', status => {
    const h = harness(); applied(h); expect(h.render().acceptedPreview).not.toBeNull();
    const failed = h.render({ editing: { status, pending: false } });
    expect(failed.acceptedPreview).toBeNull(); expect(failed.staleOptimization).toBe(true); expect(h.appliedPreview.current).toBeNull();
    expect(h.render({ editing: { status: 'pending', pending: true } }).acceptedPreview).toBeNull();
  });
  it.each([
    { projectKey: 2 }, { doc: { id: 'other' } }, { optimizationKey: 'other' }, { plannerId: 'other' }, { PERSEG: 112 },
    { doc: { id: 'path', optimization: { accepted: {} } } },
  ])('rejects a pending applied bridge after context replacement %j', patch => {
    const h = harness(); applied(h); expect(h.render().acceptedPreview).not.toBeNull();
    expect(h.render(patch).acceptedPreview).toBeNull(); expect(h.appliedPreview.current).toBeNull();
  });
  it('uses only the complete Normal value for Compare and reports current projection error through existing presentation', () => {
    const h = harness(), value = { finalTrajectory: { totalTimeS: 7 }, prof: { holds: ['complete'] } };
    const result = { selected: null, normal: { status: 'ready', value }, baselineTime: 7 };
    const ready = h.render({ result, comparison: { documentKey: 1, id: 'path', key: 'physical', mode: 'normal' } });
    expect(ready.comparedPreview).toBe(value); expect(ready.baselineTime).toBe(7);
    expect(h.render({ comparison: { documentKey: 0, id: 'path', key: 'physical', mode: 'normal' } }).comparisonMode).toBe('selected');
    const failure = { message: 'Projection failed' };
    expect(h.render({ editing: { pending: false, status: 'ok', comparisonError: failure } }).normalError).toBe(failure);
    result.normal = { status: 'error', value: null, error: failure }; result.baselineTime = null;
    const failed = h.render({ comparison: { documentKey: 1, id: 'path', key: 'physical', mode: 'normal' } });
    expect(failed.comparedPreview).toBeNull(); expect(failed.baselineTime).toBeNull();
  });
  it('can preview a feasible route while its authored Normal trajectory is unavailable', () => {
    const h = harness();
    const value = { finalTrajectory: { totalTimeS: 2 }, sample: { pts: ['route'] } };
    const failure = { message: 'The starting curve could not be timed.' };
    const ready = h.render({
      result: { selected: null, normal: { status: 'error', value: null, error: failure }, baselineTime: null },
      optimizationState: { paths: { path: { key: 'physical', status: 'success', value } } },
      comparison: { documentKey: 1, id: 'path', key: 'physical', mode: 'candidate' },
    });
    expect(ready.normalError).toBe(failure); expect(ready.baselineTime).toBeNull();
    expect(ready.candidate).toBe(value); expect(ready.comparedPreview).toBe(value);
    expect(ready.acceptedPreview).toBeNull();
  });
});
