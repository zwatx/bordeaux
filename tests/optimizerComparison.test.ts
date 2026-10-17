import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Renderer JS API.
import { PathPreview } from '../src/renderer/assets/path-preview';
// @ts-expect-error Renderer JS API.
import { FinalPlanning } from '../src/renderer/assets/final-planning';
// @ts-expect-error Renderer JS API.
import { processPathPreviewJob } from '../src/renderer/assets/path-preview-worker';
// @ts-expect-error Renderer JS API.
import { editingGeometry, editingPoseAtTime } from '../src/renderer/assets/editing-planning';
// @ts-expect-error Renderer JS API.
import { PM } from '../src/renderer/lib/pathMath';
import { finalPlanningError } from '../src/renderer/lib/planningFeedback';
import { authoredPath, isOptimizationOutdated, optimizationInputKey } from '../src/shared/planners/acceptedTrajectoryIdentity';
import { buildWaypoints, createDemoProject } from '../src/shared/project/defaults';
import { optimizeFixedGeometryFinal } from '../src/shared/planners/fixedGeometryFinal';
import { createAcceptedTrajectory } from '../src/shared/planners/acceptedTrajectory';

const flush = () => new Promise<void>(done => queueMicrotask(done));
function input() {
  const project = createDemoProject(), path = project.paths[0];
  path.waypoints = buildWaypoints([{ x: 1, y: 1, segType: 'line' }, { x: 2, y: 1 }]);
  return { documentKey: 1, pathId: path.id, inputKey: optimizationInputKey(path, project.robot, project.field), path,
    normalPath: authoredPath(path), robot: project.robot, field: project.field, plannerId: 'profiledSpline', previewDensity: 56, projectionVersion: 1 };
}
function accepted(context: any, density = 28) {
  const result = optimizeFixedGeometryFinal({ path: context.path, robot: context.robot, samplesPerSegment: density });
  const artifact = createAcceptedTrajectory(context.path, context.robot, result, context.field, density);
  return { ...context, path: { ...context.path, optimization: { corridorM: .15, accepted: artifact } } };
}
function changed(context: any, patch: any) {
  const next = { ...context, ...patch };
  return { ...next, inputKey: optimizationInputKey(next.path, next.robot, next.field), normalPath: authoredPath(next.path) };
}
function harness(initial = input(), planning = FinalPlanning) {
  const workers: any[] = [], jobs: any[] = [];
  vi.stubGlobal('Worker', class {
    terminated = false;
    postMessage(job: any) { jobs.push({ worker: this, job }); }
    terminate() { this.terminated = true; }
    constructor() { workers.push(this); }
  });
  const slots: any[] = [], effects: (() => void)[] = [];
  let cursor = 0, scheduled = 0;
  const slot = (init: () => any) => slots[cursor++] ||= init();
  const same = (a: any[], b: any[]) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const context: any = { PathPreview, FinalPlanning: planning, editingGeometry, editingPoseAtTime, finalPlanningError, isOptimizationOutdated,
    useMemo: (fn: () => any, deps: any[]) => { const cell = slot(() => ({})); if (!same(cell.deps, deps)) { cell.value = fn(); cell.deps = deps; } return cell.value; },
    useRef: (value: any) => slot(() => ({ current: value })),
    useState: (initial: any) => { const cell = slot(() => ({ value: typeof initial === 'function' ? initial() : initial })); return [cell.value, (next: any) => { const value = typeof next === 'function' ? next(cell.value) : next; if (!Object.is(value, cell.value)) scheduled++; cell.value = value; }]; },
    useEffect: (fn: () => any, deps: any[]) => { const cell = slot(() => ({})); if (!same(cell.deps, deps)) { cell.deps = deps; effects.push(() => { cell.cleanup?.(); cell.cleanup = fn(); }); } },
  };
  vm.createContext(context);
  for (const name of ['useEditingPlanning', 'useOptimizerComparison']) {
    const source = readFileSync('src/renderer/hooks/' + name + '.js', 'utf8').replace(/^import .*;\n/gm, '').replaceAll('export ', '');
    vm.runInContext(source, context);
  }
  let current = initial, enabled = false;
  const render = (next = current, open = enabled, effectsNow = true) => {
    current = next; enabled = open; cursor = 0; scheduled = 0;
    const editing = context.useEditingPlanning(current.path, current.robot, current.field);
    const result = context.useOptimizerComparison({ enabled, context: current, editing });
    if (effectsNow) effects.splice(0).forEach(fn => fn());
    return { ...result, editing };
  };
  const reply = (entry = jobs.at(-1)) => {
    const result = processPathPreviewJob(structuredClone(entry.job)); entry.worker.onmessage({ data: result }); return result;
  };
  return { render, reply, workers, jobs, get scheduled() { return scheduled; }, cleanup: () => slots.forEach(cell => cell.cleanup?.()) };
}
function deferredPlanning() {
  const jobs: any[] = [];
  return { jobs, api: { create: () => ({ request(input: any, options: any) {
    let resolve: (value: any) => void = () => {};
    const promise = new Promise(done => { resolve = done; }); const cancel = vi.fn();
    jobs.push({ input, options, resolve, cancel }); return { promise, cancel };
  } }) }, success(entry: any) { return { status: 'success', value: processPathPreviewJob({ ...entry.input, quality: 'final', perSegment: 56 }).value }; } };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('optimizer comparison qualified reuse', () => {
  it('opens/reopens current strict Normal with zero additional jobs and the exact complete preview', () => {
    const h = harness(); h.render(); h.reply(); const before = h.render();
    expect(before.normal.status).toBe('ready'); expect(before.normal.value).toBe(before.editing.strictPreview.value);
    expect(before.selected).toBe(before.editing.strictPreview); expect(before.baselineTime).toBe(before.editing.trajectory.totalTimeS);
    for (const open of [true, false, true, false, true]) expect(h.render(undefined, open).normal.value).toBe(before.normal.value);
    expect(h.jobs).toHaveLength(1); expect(h.jobs[0].job).toMatchObject({ mode: 'editing', quality: 'final' }); h.cleanup();
  });
  it('waits for the one existing editing job if Optimize opens before it finishes', () => {
    const h = harness(); h.render(); expect(h.render(undefined, true).normal.status).toBe('pending');
    h.render(undefined, false); h.render(undefined, true); expect(h.jobs).toHaveLength(1);
    h.reply(); expect(h.render().normal.status).toBe('ready'); expect(h.jobs).toHaveLength(1); h.cleanup();
  });
  it('retains full Normal through Apply, Use normal and Undo/Redo while selected artifacts requalify', () => {
    const original = input(), h = harness(original); h.render(); h.reply(); let normal = h.render().normal.value;
    const applied = accepted(original);
    for (const next of [applied, original, applied, original]) {
      const pending = h.render(next, true); expect(pending.selected).toBeNull(); expect(pending.normal.value).toBe(normal);
      h.reply(); const ready = h.render(); expect(ready.selected.accepted).toBe(Boolean(next.path.optimization?.accepted));
      if (ready.selected.accepted) { expect(ready.selected.trajectoryDensity).toBe(28); expect(ready.normal.value).toBe(normal); }
      else normal = ready.normal.value;
    }
    expect(h.jobs).toHaveLength(5); expect(h.jobs.every(entry => entry.job.mode === 'editing')).toBe(true); h.cleanup();
  });
  it('retains the first admitted Normal for immediate Apply before passive effects flush', () => {
    const original = input(), h = harness(original); h.render(); h.reply();
    const current = h.render(undefined, true, false), value = current.normal.value;
    expect(value).toBe(current.editing.strictPreview.value);
    const pending = h.render(accepted(original), true, false);
    expect(pending.selected).toBeNull(); expect(pending.normal.value).toBe(value);
    h.render(); expect(h.jobs).toHaveLength(2); expect(h.jobs.every(entry => entry.job.mode === 'editing')).toBe(true); h.cleanup();
  });
  it('cold accepted uses one direct final56 authored request and never treats accepted28/search baseline as Normal', async () => {
    const context = accepted(input()), h = harness(context); h.render(undefined, true);
    expect(h.jobs).toHaveLength(2);
    const editing = h.jobs.find(entry => entry.job.mode === 'editing'), normal = h.jobs.find(entry => entry.job.mode !== 'editing');
    expect(normal.job).toMatchObject({ quality: 'final', perSegment: 56, plannerId: 'profiledSpline', deadline: 'common' });
    expect(normal.job.path.optimization).toBeUndefined(); expect(normal.job.path).toBe(context.normalPath);
    h.reply(editing); expect(h.render().selected.trajectoryDensity).toBe(28); expect(h.render().normal.value).toBeNull();
    const response = h.reply(normal); await flush(); const ready = h.render();
    expect(ready.normal.value).toBe(response.value); expect(ready.baselineTime).toBe(response.value.finalTrajectory.totalTimeS);
    expect(ready.normal.value).not.toBe(ready.selected.value); h.render(undefined, false); h.render(undefined, true);
    expect(h.jobs).toHaveLength(2); h.cleanup();
  });
  it('cancels close-before-completion and rejects even an uncooperative late promise', async () => {
    const context = accepted(input()), deferred = deferredPlanning(), h = harness(context, deferred.api);
    h.render(undefined, true); expect(deferred.jobs).toHaveLength(1); const old = deferred.jobs[0];
    h.render(undefined, false); expect(old.cancel).toHaveBeenCalledOnce();
    h.render(undefined, true); expect(deferred.jobs).toHaveLength(2);
    old.resolve(deferred.success(old)); await flush(); expect(h.render().normal.value).toBeNull();
    h.render(); expect(h.scheduled).toBe(0);
    deferred.jobs[1].resolve(deferred.success(deferred.jobs[1])); await flush();
    // An initial null→null failure setter would let React bail out and leave the panel pending.
    expect(h.scheduled).toBe(1); expect(h.render().normal.status).toBe('ready'); h.cleanup();
  });
  it('rejects A→B→A and same-ID document replacement completions before any cleanup could hide a flash', async () => {
    const original = accepted(input()), deferred = deferredPlanning(), h = harness(original, deferred.api);
    h.render(undefined, true); const old = deferred.jobs[0];
    const other = changed(original, { path: { ...original.path, constraints: { ...original.path.constraints, maxVel: 2 } } });
    h.render(other); h.render(original); old.resolve(deferred.success(old)); await flush(); expect(h.render().normal.value).toBeNull();
    const matchingId = { ...original, documentKey: 2 }; h.render(matchingId);
    deferred.jobs.at(-2).resolve(deferred.success(deferred.jobs.at(-2))); await flush(); expect(h.render().normal.value).toBeNull();
    deferred.jobs.at(-1).resolve(deferred.success(deferred.jobs.at(-1))); await flush(); expect(h.render().normal.status).toBe('ready'); h.cleanup();
  });
  it('rejects uncleaned A→B→A owners before any effect cleanup can mask a stale flash', async () => {
    const original = accepted(input()), deferred = deferredPlanning(), h = harness(original, deferred.api);
    h.render(undefined, true); const old = deferred.jobs[0];
    h.render({ ...original, documentKey: 2 }, true, false); h.render(original, true, false);
    old.resolve(deferred.success(old)); await flush();
    expect(h.render(undefined, true, false).normal.value).toBeNull(); expect(h.scheduled).toBe(0); h.cleanup();
  });
  it('does not let a canceled late failure overwrite a newer completed full reference', async () => {
    const original = accepted(input()), deferred = deferredPlanning(), h = harness(original, deferred.api);
    h.render(undefined, true); const old = deferred.jobs[0]; h.render(undefined, false); h.render(undefined, true);
    const current = deferred.jobs[1]; current.resolve(deferred.success(current)); await flush(); const value = h.render().normal.value;
    old.resolve({ status: 'failure', error: { message: 'Canceled old failure' } }); await flush();
    expect(h.render().normal.value).toBe(value); expect(h.render().normal.error).toBeNull(); h.cleanup();
  });
  it.each([28, 112])('keeps selected density %s distinct from a cold Normal56 reference', async density => {
    const context = accepted(input(), density), h = harness(context); h.render(undefined, true);
    h.reply(h.jobs.find(entry => entry.job.mode === 'editing')); const selected = h.render().selected;
    expect(selected.trajectoryDensity).toBe(density); expect(selected.previewDensity).toBe(56); expect(h.render().normal.value).toBeNull();
    const response = h.reply(h.jobs.find(entry => entry.job.mode !== 'editing')); await flush();
    expect(h.render().normal.value).toBe(response.value); expect(h.render().normal.value).not.toBe(selected.value); expect(h.jobs).toHaveLength(2); h.cleanup();
  });
  it('does not hide an authored projection failure with a retained Normal and retries only editing', () => {
    const h = harness(); h.render(); h.reply(); const previous = h.render(); previous.editing.retry(); h.render();
    vi.spyOn(PM, 'derivePath').mockImplementationOnce(() => { throw new Error('Comparison projection failed'); });
    h.reply(); const failed = h.render(undefined, true);
    expect(failed.editing.ready).toBe(true); expect(failed.normal.status).toBe('error'); expect(failed.normal.value).toBeNull(); expect(failed.baselineTime).toBeNull();
    expect(failed.normal.error.message).toBe('Comparison projection failed'); expect(failed.normal.retry).toBe(failed.editing.retry);
    failed.normal.retry(); h.render(); h.reply(); expect(h.render().normal.status).toBe('ready');
    expect(h.jobs).toHaveLength(3); expect(h.jobs.every(entry => entry.job.mode === 'editing')).toBe(true); h.cleanup();
  });
});

describe('comparison identity, terminal failure and complete metadata', () => {
  it.each([
    ['geometry', (c: any) => changed(c, { path: { ...c.path, waypoints: c.path.waypoints.map((w: any, i: number) => ({ ...w, y: w.y + i * .1 })) } })],
    ['constraints', (c: any) => changed(c, { path: { ...c.path, constraints: { ...c.path.constraints, maxVel: 1 } } })],
    ['corridor', (c: any) => changed(c, { path: { ...c.path, optimization: { ...c.path.optimization, corridorM: .3 } } })],
    ['robot', (c: any) => changed(c, { robot: { ...c.robot, maxSpeed: 2 } })],
    ['field', (c: any) => changed(c, { field: { ...c.field, revision: 'other' } })],
    ['path ID', (c: any) => ({ ...c, pathId: 'other', path: { ...c.path, id: 'other' }, normalPath: { ...c.normalPath, id: 'other' } })],
    ['document', (c: any) => ({ ...c, documentKey: 2 })],
    ['preset', (c: any) => ({ ...c, plannerId: 'optimizedTrajectory' })],
    ['density', (c: any) => ({ ...c, previewDensity: 112 })],
    ['projection', (c: any) => ({ ...c, projectionVersion: 2 })],
  ])('drops completed Normal and rejects deferred ownership across %s', async (_name, change: any) => {
    const original = input(), deferred = deferredPlanning(), h = harness(original, deferred.api);
    h.render(); h.reply(); const ready = h.render(); expect(ready.normal.status).toBe('ready');
    const applied = accepted(original); h.render(applied, true); expect(deferred.jobs).toHaveLength(0);
    const other = change(applied); expect(h.render(other).normal.value).toBeNull();
    h.cleanup();
    const cold = harness(applied, deferred.api); cold.render(undefined, true); const previous = deferred.jobs.at(-1);
    cold.render(other); previous.resolve(deferred.success(previous)); await flush(); expect(cold.render().normal.value).toBeNull(); cold.cleanup();
  });
  it('preserves completed full Normal through cosmetic names/equal physical robot/field replacement', () => {
    const original = input(), deferred = deferredPlanning(), h = harness(original, deferred.api);
    h.render(); h.reply(); const value = h.render().normal.value;
    const selected = accepted(original), renamed = { ...selected, path: { ...selected.path, name: 'Cosmetic rename' },
      normalPath: { ...selected.normalPath, name: 'Cosmetic rename' }, robot: { ...selected.robot }, field: { ...selected.field } };
    expect(optimizationInputKey(renamed.path, renamed.robot, renamed.field)).toBe(original.inputKey);
    expect(h.render(renamed, true).normal.value).toBe(value); expect(deferred.jobs).toHaveLength(0);
    h.reply(); expect(h.render().selected.accepted).toBe(true); expect(h.render().normal.value).toBe(value); h.cleanup();
  });
  it.each(['robot', 'field'])('uses %s object identity for inflight ownership even at an equal physical key', async key => {
    const original = accepted(input()), deferred = deferredPlanning(), h = harness(original, deferred.api);
    h.render(undefined, true); const old = deferred.jobs[0];
    h.render({ ...original, [key]: { ...original[key as keyof typeof original] } });
    old.resolve(deferred.success(old)); await flush(); expect(h.render().normal.value).toBeNull();
    expect(old.cancel).toHaveBeenCalledOnce(); const current = deferred.jobs.at(-1);
    current.resolve(deferred.success(current)); await flush(); expect(h.render().normal.status).toBe('ready'); h.cleanup();
  });
  it('rejects old/tampered artifact selected replies and keeps independent Normal from validating selection', async () => {
    const original = input(), h = harness(original); h.render(); h.reply(); const value = h.render().normal.value;
    const applied = accepted(original); h.render(applied, true); const old = h.jobs.at(-1);
    const corrupt = structuredClone(applied.path.optimization.accepted); corrupt.result.samples[1].t = NaN;
    const invalid = { ...applied, path: { ...applied.path, optimization: { ...applied.path.optimization, accepted: corrupt } } };
    expect(h.render(invalid).selected).toBeNull(); h.reply(old); expect(h.render().selected).toBeNull(); h.reply();
    const failed = h.render(); expect(failed.editing.status).toBe('infeasible'); expect(failed.selected).toBeNull();
    expect(failed.normal.value).toBe(value); expect(failed.baselineTime).toBe(value.finalTrajectory.totalTimeS); h.cleanup();
    const deferred = deferredPlanning(), cold = harness(invalid, deferred.api); cold.render(undefined, true); cold.reply();
    deferred.jobs[0].resolve(deferred.success(deferred.jobs[0])); await flush();
    expect(cold.render().normal.status).toBe('ready'); expect(cold.render().selected).toBeNull(); expect(cold.render().editing.ready).toBe(false); cold.cleanup();
  });
  it.each(['timeout', 'failure', 'canceled', 'fallback', 'malformed', 'partial-projection'])('never caches a %s Normal response and retries only the failed Normal source', async status => {
    const deferred = deferredPlanning(), h = harness(accepted(input()), deferred.api); h.render(undefined, true); h.reply();
    const old = deferred.jobs[0], success = deferred.success(old);
    const result = status === 'malformed' ? { status: 'success', value: { finalTrajectory: success.value.finalTrajectory } }
      : status === 'partial-projection' ? { status: 'success', value: { ...success.value, prof: { ...success.value.prof, jiggles: undefined } } }
      : status === 'fallback' ? { status: 'failure', fallback: success.value, fallbackReason: 'failed' }
      : { status, deadlineMs: 5000, error: { message: 'failed' }, fallback: success.value };
    old.resolve(result); await flush(); const failed = h.render();
    expect(failed.normal.status).toBe('error'); expect(failed.normal.value).toBeNull(); expect(failed.baselineTime).toBeNull();
    expect(failed.normal.errorKind).toBe(status === 'timeout' ? 'timeout' : 'failure');
    expect(failed.normal.retry).not.toBe(failed.editing.retry); h.render(); expect(deferred.jobs).toHaveLength(1);
    failed.normal.retry(); h.render(); expect(deferred.jobs).toHaveLength(2); expect(h.jobs).toHaveLength(1);
    const retry = deferred.jobs[1]; retry.resolve(deferred.success(retry)); await flush(); expect(h.render().normal.status).toBe('ready'); h.cleanup();
  });
  it.each(['infeasible', 'unfinished', 'transport'])('settles authored %s comparison as an error without another solve, then recovers', kind => {
    const original = input(), h = harness(original); h.render(); h.reply(); expect(h.render().normal.status).toBe('ready');
    const next = kind === 'infeasible' ? changed(original, { path: { ...original.path, startVel: 9 } })
      : kind === 'unfinished' ? changed(original, { path: { ...original.path, waypoints: [] } }) : original;
    if (kind === 'transport') h.render().editing.retry();
    h.render(next, true);
    if (kind === 'transport') {
      h.jobs.at(-1).worker.onerror({ message: 'Worker crashed' }); h.jobs.at(-1).worker.onerror({ message: 'Worker crashed again' });
    } else h.reply();
    const failed = h.render(); expect(failed.normal.status).toBe('error'); expect(failed.normal.error.message.length).toBeGreaterThan(0);
    expect(failed.normal.value).toBeNull(); expect(failed.baselineTime).toBeNull(); expect(failed.normal.retry).toBe(failed.editing.retry);
    if (kind === 'transport') failed.normal.retry();
    h.render(original); h.reply(); expect(h.render().normal.status).toBe('ready');
    expect(h.jobs.every(entry => entry.job.mode === 'editing')).toBe(true); h.cleanup();
  });
  it.each([false, true])('forwards the complete real stopped turn/hold/jiggle/marker projection, reverse=%s', reverse => {
    const original = input(), path = original.path;
    path.waypoints = buildWaypoints([{ x: 2, y: 2, theta: 0, thetaOn: true, segType: 'line' }, { x: 4, y: 2, theta: 0, thetaOn: true }]);
    path.headingMode = 'manual'; path.driveBackward = reverse;
    path.waypoints[1].stop = true; path.waypoints[1].wait = .7;
    path.waypoints[1].turnInPlace = { headingDeg: 90, direction: 'shortest' };
    path.waypoints[1].jiggle = { distanceM: .1, strokes: 2, startDeg: 0, stepDeg: 180, strokeTimeS: .3 };
    path.markers = [{ id: 'marker', f: 1, name: 'Action', invocation: { commandId: 'team.command', arguments: { count: '9007199254740993' } } }];
    const current = changed(original, {}), h = harness(current); h.render(); const response = h.reply(); const ready = h.render(undefined, true);
    expect(ready.normal.status).toBe('ready'); expect(ready.normal.value).toBe(response.value.derived);
    const value = ready.normal.value, trajectory = ready.selected.trajectory;
    expect(value.trajectorySamples).toBe(trajectory.samples); expect(value.finalTrajectory).toBe(trajectory);
    expect(value.prof.holds).toHaveLength(1); expect(value.prof.jiggles).toHaveLength(1); expect(value.prof.turns.length).toBeGreaterThan(0);
    expect(value.markers).toBe(trajectory.markers); expect(value.markers).toHaveLength(1); expect(value.markers[0].invocation).toEqual(path.markers[0].invocation);
    expect(value.wpIdx).toEqual([0, 56]); expect(value.wpFrac).toEqual([0, 1]); expect(value.rev).toBe(reverse);
    expect(value.prof.head[0]).toBeCloseTo(trajectory.samples[0].headingRad - (reverse ? Math.PI : 0), 12);
    expect(value.metrics.head).toBe(value.prof.head); expect(value.metrics.v).toBe(value.prof.v);
    expect(value.prof.totalTime).toBe(trajectory.totalTimeS); expect(h.jobs).toHaveLength(1); h.cleanup();
  });
});
