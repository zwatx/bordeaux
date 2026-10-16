import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
// @ts-expect-error Intentional renderer JS API.
import { processPathPreviewJob, previewForTrajectory } from '../src/renderer/assets/path-preview-worker';
// @ts-expect-error Intentional renderer JS API.
import { PM } from '../src/renderer/lib/pathMath';
// @ts-expect-error Intentional renderer JS API.
import { editingGeometry, editingPoseAtTime, projectEditingTiming } from '../src/renderer/assets/editing-planning';
// @ts-expect-error Intentional renderer JS API.
import { PathPreview } from '../src/renderer/assets/path-preview';
import { buildWaypoints, createDemoProject } from '../src/shared/project/defaults';
import { getPlanner } from '../src/shared/planners';
import { optimizeFixedGeometryFinal } from '../src/shared/planners/fixedGeometryFinal';
import { createAcceptedTrajectory } from '../src/shared/planners/acceptedTrajectory';
import { buildBdxExportWithPlannerResults } from '../src/shared/export/bdx';
import { headingAt } from '../src/shared/math/headingAnchors';
import { effectiveRanges } from '../src/shared/math/pathRanges';

function overlayProject() {
  const project = createDemoProject(), path = project.paths[0];
  path.waypoints = buildWaypoints([{ x: 2, y: 2, theta: 30, segType: 'line' }, { x: 4, y: 2, theta: 60, thetaOn: true, segType: 'line' }, { x: 8, y: 2, theta: 90 }]);
  path.headingMode = 'manual';
  path.ranges = [
    { anchor: 'param', f0: 0.1, f1: 0.2, name: 'Percent', maxVel: 1.2 },
    { anchor: 'dist', f0: 0, f1: 1, d0: 1, d1: 3, name: 'Distance', maxVel: 0.5 },
    { anchor: 'wp', f0: 0, f1: 1, w0: 0, t0: 0.5, w1: 1, t1: 0.5, name: 'Segment', maxVel: 0.7 },
  ];
  return project;
}

function job(project = createDemoProject()): any {
  return { id: 1, mode: 'editing', path: project.paths[0], robot: project.robot, field: project.field, perSegment: 56, quality: 'final' };
}
function timingIdentity(result: any) {
  return { ...result, optimization: result.optimization ? { ...result.optimization, solveTimeMs: 0 } : undefined };
}
function harness(quality = 'final') {
  const workers: any[] = [];
  let constructorThrows = 0, postThrows = 0;
  vi.stubGlobal('Worker', class {
    jobs: any[] = [];
    constructor() { if (constructorThrows-- > 0) throw new Error('Unavailable'); workers.push(this); }
    postMessage(input: any) { if (postThrows-- > 0) throw new Error('Send failed'); this.jobs.push(input); }
    terminate = vi.fn();
  });
  const slots: any[] = [], effects: (() => void)[] = [];
  let cursor = 0;
  const slot = (init: () => any) => slots[cursor++] ||= init();
  const same = (a: any[], b: any[]) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const previewAPI = quality === 'final' ? PathPreview : { ...PathPreview, create(options: any) {
    const preview = PathPreview.create(options);
    return { ...preview, request: (input: any) => preview.request({ ...input, quality }) };
  } };
  const context: any = { PathPreview: previewAPI, editingGeometry, editingPoseAtTime,
    useMemo: (fn: () => any, deps: any[]) => { const state = slot(() => ({})); if (!same(state.deps, deps)) { state.value = fn(); state.deps = deps; } return state.value; },
    useState: (initial: any) => { const state = slot(() => ({ value: typeof initial === 'function' ? initial() : initial })); return [state.value, (next: any) => { state.value = typeof next === 'function' ? next(state.value) : next; }]; },
    useEffect: (fn: () => any, deps: any[]) => { const state = slot(() => ({})); if (!same(state.deps, deps)) { state.deps = deps; effects.push(() => { state.cleanup?.(); state.cleanup = fn(); }); } },
  };
  vm.createContext(context);
  const source = readFileSync('src/renderer/hooks/useEditingPlanning.js', 'utf8').replace(/^import .*;\n/gm, '').replaceAll('export ', '');
  vm.runInContext(source + '\nglobalThis.hook = useEditingPlanning;', context);
  let input = job(), enabled = true;
  const render = (next = input, on = enabled) => { input = next; enabled = on; cursor = 0; const value = context.hook(input.path, input.robot, input.field, enabled); effects.splice(0).forEach(fn => fn()); return value; };
  const reply = (worker = workers.at(-1), request = worker.jobs.at(-1), response = processPathPreviewJob(request)) => { worker.onmessage({ data: response }); return response; };
  return { workers, render, reply, constructorFail: () => { constructorThrows = 10; }, postFail: () => { postThrows = 10; },
    restore: () => { constructorThrows = 0; postThrows = 0; }, cleanup: () => slots.forEach(state => state.cleanup?.()) };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('production editing planning adapter', () => {
  it('qualifies the complete final projection by exact current request identity without another worker job', () => {
    const project = overlayProject(), request = job(project), h = harness();
    h.render(request); expect(h.render().strictPreview).toBeNull();
    const projection = vi.spyOn(PM, 'derivePath');
    const response = h.reply(), current = h.render(), strict = current.strictPreview;
    expect(projection).toHaveBeenCalledTimes(1);
    expect(strict).toMatchObject({ path: request.path, robot: request.robot, field: request.field, revision: 1, attempt: 0,
      acceptedIdentity: null, accepted: false, plannerId: 'profiledSpline', projectionVersion: 1, previewDensity: 56, trajectoryDensity: 56 });
    expect(strict.path).toBe(request.path); expect(strict.robot).toBe(request.robot); expect(strict.field).toBe(request.field);
    expect(strict.value).toBe(response.value.derived); expect(strict.value).toBe(current.value); expect(strict.trajectory).toBe(response.value.trajectory);
    expect(strict.value).toEqual({ ...previewForTrajectory(request.path, request.robot, strict.trajectory), trajectorySamples: strict.trajectory.samples, acceptedTrajectory: false });
    expect(strict.value.effRanges).toEqual(current.value.effRanges); expect(strict.value.wpIdx).toHaveLength(request.path.waypoints.length);
    expect(strict.value.metrics.head).toBe(strict.value.prof.head); expect(current.comparisonError).toBeNull();
    expect(h.render().strictPreview).toBe(strict); expect(h.workers).toHaveLength(1); expect(h.workers[0].jobs).toHaveLength(1);
    expect(projection).toHaveBeenCalledTimes(2); // Only the worker and this test's explicit reference projection.
    expect(h.workers[0].jobs[0]).toMatchObject({ quality: 'final', perSegment: 56 }); h.cleanup();
  });
  it.each([undefined, 0, 28, 112])('reports actual resolved projection density for perSegment=%s', perSegment => {
    const result = processPathPreviewJob({ ...job(), perSegment }).value;
    expect(result.status).toBe('ok'); expect(result.comparison).toEqual({ status: 'ready', projectionVersion: 1, previewDensity: perSegment || 56 });
    expect(result.derived.sample.pts.length).toBeGreaterThan(14); expect(result.derived.finalTrajectory).toBe(result.trajectory);
  });
  it('keeps a real projection failure drawable and strict editing-ready without qualifying it', () => {
    const h = harness(); h.render(); const injectedDerive = vi.fn(() => { throw new Error('Wrong injection seam'); });
    // Editing jobs do not use processPathPreviewJob's legacy derive argument. Fail the actual projection seam.
    const projection = vi.spyOn(PM, 'derivePath').mockImplementationOnce(() => { throw new Error('Full projection failed'); });
    const response = processPathPreviewJob(h.workers[0].jobs[0], injectedDerive); h.reply(undefined, undefined, response);
    const current = h.render();
    expect(injectedDerive).not.toHaveBeenCalled(); expect(projection).toHaveBeenCalledTimes(1);
    expect(response.value.comparison).toEqual({ status: 'error', message: 'Full projection failed' });
    expect(current.status).toBe('ok'); expect(current.ready).toBe(true); expect(current.trajectory).toBe(response.value.trajectory);
    expect(current.value.sample.pts.length).toBeGreaterThan(1); expect(current.value.finalTrajectory).toBe(current.trajectory);
    expect(current.poseAtTime(0)).not.toBeNull(); expect(current.error).toBeNull(); expect(current.strictPreview).toBeNull();
    expect(current.comparisonError).toMatchObject({ message: 'Full projection failed' });
    current.retry(); const pending = h.render(); expect(pending.strictPreview).toBeNull(); expect(pending.comparisonError).toBeNull();
    h.reply(); const recovered = h.render(); expect(recovered.strictPreview).not.toBeNull(); expect(recovered.comparisonError).toBeNull();
    expect(recovered.strictPreview.attempt).toBe(1); expect(h.workers[0].jobs).toHaveLength(2); h.cleanup();
  });
  it('requires current final projection version/density and does not qualify an unmarked legacy result', () => {
    const h = harness(); h.render(); const worker = h.workers[0], request = worker.jobs[0], response = processPathPreviewJob(request);
    for (const comparison of [undefined, { status: 'ready', projectionVersion: 2, previewDensity: 56 }, { status: 'ready', projectionVersion: 1, previewDensity: 28 }]) {
      const one = harness(); one.render(); one.reply(undefined, undefined, { ...response, value: { ...response.value, comparison } });
      expect(one.render().ready).toBe(true); expect(one.render().strictPreview).toBeNull(); one.cleanup();
    }
    h.reply(worker, request, processPathPreviewJob({ ...request, perSegment: 28 }));
    expect(h.render().ready).toBe(true); expect(h.render().strictPreview).toBeNull(); h.cleanup();
  });
  it('never admits an interactive-quality result as a strict comparison preview', () => {
    const h = harness('interactive'); h.render(); const response = h.reply();
    expect(h.workers[0].jobs[0]).toMatchObject({ quality: 'interactive', perSegment: 14 });
    expect(response.value.comparison).toMatchObject({ status: 'ready', previewDensity: 14 });
    expect(h.render().ready).toBe(true); expect(h.render().strictPreview).toBeNull(); expect(h.render().comparisonError).toBeNull(); h.cleanup();
  });
  it('keeps accepted artifact density distinct from final preview density and rejects late artifact replies', () => {
    const project = createDemoProject(), path = project.paths[0];
    path.waypoints = buildWaypoints([{ x: 1, y: 1, segType: 'line' }, { x: 2, y: 1 }]);
    const result = optimizeFixedGeometryFinal({ path, robot: project.robot, samplesPerSegment: 28 });
    const accepted = createAcceptedTrajectory(path, project.robot, result, project.field, 28);
    path.optimization = { corridorM: .15, accepted };
    const h = harness(), input = job(project); h.render(input); const worker = h.workers[0], old = worker.jobs[0];
    const replacement = { ...input, path: { ...path, optimization: { ...path.optimization, accepted: structuredClone(accepted) } } };
    expect(h.render(replacement).strictPreview).toBeNull(); h.reply(worker, old); expect(h.render().strictPreview).toBeNull();
    const active = worker.jobs.at(-1), response = structuredClone(processPathPreviewJob(structuredClone(active)));
    h.reply(worker, active, response); const strict = h.render().strictPreview;
    expect(strict.acceptedIdentity).toBe(replacement.path.optimization.accepted); expect(strict.acceptedIdentity).not.toBe(accepted);
    expect(strict.accepted).toBe(true); expect(strict.trajectoryDensity).toBe(28); expect(strict.previewDensity).toBe(56);
    expect(strict.value).toBe(response.value.derived); expect(strict.trajectory).toBe(response.value.trajectory);
    expect(strict.trajectory).not.toBe(replacement.path.optimization.accepted.result); expect(strict.trajectory).toEqual(replacement.path.optimization.accepted.result);
    const corrupt = structuredClone(replacement.path.optimization.accepted); corrupt.result.samples[1].t = NaN;
    const invalid = { ...replacement, path: { ...replacement.path, optimization: { ...replacement.path.optimization, accepted: corrupt } } };
    h.render(invalid); expect(h.render().strictPreview).toBeNull(); h.reply(); expect(h.render().status).toBe('infeasible'); expect(h.render().strictPreview).toBeNull();
    h.render({ ...invalid, path: { ...invalid.path, startVel: .2 } }); h.reply();
    expect(h.render().strictPreview).toMatchObject({ accepted: false, trajectoryDensity: 56, previewDensity: 56 }); h.cleanup();
  });
  it('rejects deferred A→B→A and prior-attempt replies while the same immutable inputs return', () => {
    const h = harness(), initial = job(); h.render(initial); const worker = h.workers[0], old = worker.jobs[0];
    h.render({ ...initial, field: { ...initial.field } }); h.render(initial);
    h.reply(worker, old); expect(h.render().strictPreview).toBeNull(); h.reply(); const ready = h.render();
    expect(ready.strictPreview.revision).toBe(3); ready.retry(); expect(h.render().strictPreview).toBeNull();
    h.reply(worker, old); expect(h.render().strictPreview).toBeNull(); h.reply(); expect(h.render().strictPreview).toMatchObject({ revision: 4, attempt: 1 });
    expect(h.render(initial, false).strictPreview).toBeNull(); h.cleanup();
  });
  it.each(['path', 'robot', 'field'])('invalidates qualification immediately on a new %s object', key => {
    const h = harness(), initial = job(); h.render(initial); h.reply(); expect(h.render().strictPreview).not.toBeNull();
    const worker = h.workers[0], old = worker.jobs[0], current = { ...initial, [key]: { ...initial[key] } };
    const pending = h.render(current); expect(pending.strictPreview).toBeNull(); expect(pending.comparisonError).toBeNull();
    h.reply(worker, old); expect(h.render().strictPreview).toBeNull(); h.reply();
    expect(h.render().strictPreview[key]).toBe(current[key]); expect(worker.jobs).toHaveLength(2); h.cleanup();
  });
  it('resolves current authored range anchors and facing without timing or stationary actions', () => {
    const project = overlayProject(), path = project.paths[0];
    path.waypoints[1].stop = true; path.waypoints[1].wait = 10;
    path.waypoints[1].turnInPlace = { headingDeg: 180, direction: 'shortest' };
    const geometry = editingGeometry(path);
    expect(geometry.effRanges).toEqual(effectiveRanges(path, geometry.sample));
    [[0.1, 0.2], [1 / 6, 0.5], [1 / 6, 2 / 3]].forEach(([f0, f1], index) => {
      expect(geometry.effRanges[index].f0).toBeCloseTo(f0, 8); expect(geometry.effRanges[index].f1).toBeCloseTo(f1, 8);
    });
    expect(headingAt(0, geometry.anchors)).toBeCloseTo(Math.PI / 6, 8);
    expect(headingAt(geometry.wpFrac[1], geometry.anchors)).toBeCloseTo(Math.PI / 3, 8);
    expect(headingAt(1, geometry.anchors)).toBeCloseTo(Math.PI / 2, 8);
    expect(geometry.prof).toMatchObject({ totalTime: 0, holds: [], turns: [], jiggles: [] });
    expect(geometry.prof.t.every((t: number) => t === 0)).toBe(true);
    expect(projectEditingTiming(geometry, null).effRanges).toBe(geometry.effRanges);
    expect(projectEditingTiming(geometry, null).anchors).toBe(geometry.anchors);
  });
  it('uses current target, segment facing and robot drive laws in geometry-only overlays', () => {
    const project = overlayProject(), path = project.paths[0];
    path.headingMode = 'targets'; path.targets = [{ anchor: 'dist', d: 1, f: 0, deg: 120 }];
    let geometry = editingGeometry(path, 12);
    expect(headingAt(1 / 6, geometry.anchors)).toBeCloseTo(2 * Math.PI / 3, 8);
    path.waypoints[0].segmentHeadingMode = 'lookAt'; path.waypoints[0].segmentLookAt = { x: 2, y: 4 };
    path.waypoints[1].segmentHeadingMode = 'tangent';
    geometry = editingGeometry(path);
    expect(geometry.metrics.head[0]).toBeCloseTo(Math.PI / 2, 8);
    expect(geometry.metrics.head.at(-1)).toBeCloseTo(0, 8);
    const tank = editingGeometry(path, 14, { ...project.robot, drive: 'tank' });
    expect(tank.mode).toBe('tank'); expect(tank.headingMode).toBe('tangent'); expect(tank.anchors).toEqual([]);
    expect(tank.metrics.head.every((rad: number) => rad === 0)).toBe(true);
  });
  it('preserves current overlays across pending, infeasible and recovered hook results', () => {
    const h = harness(), project = overlayProject(), initial = job(project);
    h.render(initial); h.reply(); expect(h.render().ready).toBe(true);
    const next = { ...initial, path: { ...initial.path, startVel: 4 } };
    const pending = h.render(next), again = h.render();
    expect(pending.status).toBe('pending'); expect(pending.trajectory).toBeNull();
    expect(pending.value.effRanges).toEqual(effectiveRanges(next.path, pending.value.sample));
    expect(pending.value.anchors.length).toBeGreaterThan(1);
    expect(again.issues).toBe(pending.issues); expect(again.retry).toBe(pending.retry); expect(again.poseAtTime).toBe(pending.poseAtTime);
    h.reply(); const failed = h.render();
    expect(failed.status).toBe('infeasible'); expect(failed.trajectory).toBeNull();
    expect(failed.value.effRanges).toEqual(effectiveRanges(next.path, failed.value.sample));
    expect(failed.value.anchors.length).toBeGreaterThan(1); expect(h.render().issues).toBe(failed.issues);
    const recoveredInput = { ...next, path: { ...next.path, startVel: 0, waypoints: next.path.waypoints.map((w: any) => ({ ...w, theta: 45 })) } };
    const changed = h.render(recoveredInput);
    expect(changed.status).toBe('pending'); expect(changed.poseAtTime(0)).toBeNull(); expect(changed.issues).toEqual([]);
    expect(headingAt(0, changed.value.anchors)).toBeCloseTo(Math.PI / 4, 8);
    h.reply(); const recovered = h.render(); expect(recovered.ready).toBe(true);
    expect(recovered.poseAtTime(0).heading).toBeCloseTo(Math.PI / 4, 8);
    expect(h.render().poseAtTime).toBe(recovered.poseAtTime); h.cleanup();
  });
  it('keeps malformed overlay inputs finite while preserving authored selection indices', () => {
    const project = overlayProject(), path: any = project.paths[0];
    path.waypoints[1] = null;
    path.waypoints[0].theta = 1e308;
    path.ranges[1] = { anchor: 'wp', w0: Number.NaN, t0: Infinity, w1: 1, t1: 0.5 };
    path.ranges.push(null);
    path.targets = [null, { f: Number.NaN, deg: Infinity }];
    const geometry = editingGeometry(path);
    expect(geometry.wpIdx).toHaveLength(3); expect(geometry.wpFrac).toHaveLength(3);
    expect(geometry.effRanges).toHaveLength(4);
    expect(geometry.effRanges.every((r: any) => Number.isFinite(r.f0) && Number.isFinite(r.f1))).toBe(true);
    expect(geometry.anchors.every((a: any) => Number.isFinite(a.f) && Number.isFinite(a.rad))).toBe(true);
    expect(geometry.metrics.head.every(Number.isFinite)).toBe(true);
  });
  it('preserves exact strict output for ordinary feasible input', () => {
    const request = job(), result = processPathPreviewJob(request).value;
    const strict = getPlanner('profiledSpline').generate({ path: request.path, robot: request.robot, samplesPerSegment: 56 });
    expect(result.status).toBe('ok');
    expect(timingIdentity(result.trajectory)).toEqual(timingIdentity(strict));
    expect(result.derived.finalTrajectory).toBe(result.trajectory);
    expect(result.derived.trajectorySamples).toBe(result.trajectory.samples);
  });
  it('keeps current infeasible geometry and localized issues display-only, with strict export still blocked', () => {
    const project = createDemoProject(), path = project.paths[0];
    path.waypoints = buildWaypoints([{ x: 2, y: 2, segType: 'line' }, { x: 7, y: 2 }]);
    path.startVel = 4; path.ranges = [{ anchor: 'param', f0: 0.02, f1: 0.3, maxVel: 0.5 }];
    const result = processPathPreviewJob(job(project)).value;
    expect(result.status).toBe('infeasible'); expect(result.trajectory).toBeNull();
    expect(result.comparison).toBeUndefined();
    expect(result.bestEffort.samples.length).toBeGreaterThan(1);
    expect(result.derived.sample.pts.at(-1)).toMatchObject({ x: 7, y: 2 });
    expect(result.derived.finalTrajectory).toBeUndefined();
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'unreachable-deceleration', f0: 0, f1: 0.02 }));
    expect(() => buildBdxExportWithPlannerResults(project)).toThrow();
  });
  it.each([false, true])('qualifies and plays the full stopped turn/hold/jiggle/marker trace with reverse=%s', reverse => {
    const project = createDemoProject(), path = project.paths[0];
    path.waypoints = buildWaypoints([{ x: 2, y: 2, theta: 0, thetaOn: true, segType: 'line' }, { x: 4, y: 2, theta: 0, thetaOn: true, stop: true, wait: 0.5 }]);
    path.headingMode = 'manual'; path.driveBackward = reverse;
    path.waypoints[1].turnInPlace = { headingDeg: 90, direction: 'shortest' };
    path.waypoints[1].jiggle = { distanceM: 0.1, strokes: 2, startDeg: 0, stepDeg: 180, strokeTimeS: 0.3 };
    path.markers = [{ id: 'complete-marker', f: 1, name: 'Exact arrival event', invocation: { commandId: 'team.command', arguments: { count: '9007199254740993' } } }];
    const h = harness(), request = job(project); h.render(request); const result = h.reply().value, current = h.render();
    expect(result.status).toBe('ok');
    expect(current.strictPreview.value).toBe(result.derived); expect(current.strictPreview.trajectory).toBe(result.trajectory);
    expect(result.derived).toEqual({ ...previewForTrajectory(path, project.robot, result.trajectory), trajectorySamples: result.bestEffort.samples, acceptedTrajectory: false });
    expect(result.derived.prof.holds).toHaveLength(1); expect(result.derived.prof.turns.length).toBeGreaterThan(0); expect(result.derived.prof.jiggles).toHaveLength(1);
    expect(result.derived.markers).toBe(result.trajectory.markers); expect(result.derived.markers[0].invocation).toEqual(path.markers[0].invocation);
    expect(result.derived.rev).toBe(reverse); expect(result.derived.wpIdx).toEqual([0, 56]); expect(result.derived.wpFrac).toEqual([0, 1]);
    expect(result.derived.prof.head[0]).toBeCloseTo(result.trajectory.samples[0].headingRad - (reverse ? Math.PI : 0), 12);
    result.derived.prof.head.forEach((heading: number, i: number) => expect(heading).toBeCloseTo(result.derived.metrics.head[i], 12));
    for (const sample of result.bestEffort.samples) {
      const pose = editingPoseAtTime(sample.t, result.bestEffort.samples);
      expect(pose.x).toBeCloseTo(sample.x, 8); expect(pose.y).toBeCloseTo(sample.y, 8);
      expect(Math.atan2(Math.sin(pose.heading - sample.headingRad), Math.cos(pose.heading - sample.headingRad))).toBeCloseTo(0, 8);
      expect(current.poseAtTime(sample.t)).toEqual(pose);
    }
    const hold = result.trajectory.stationaryActions.find((a: any) => a.kind === 'wait');
    expect(editingPoseAtTime((hold.startTimeS + hold.endTimeS) / 2, result.bestEffort.samples)).toMatchObject({ x: 4, y: 2, v: 0 });
    expect(h.workers[0].jobs).toHaveLength(1); h.cleanup();
  });
  it('uses the accepted trajectory exactly, blocks corrupt current artifacts, and recovers after authored edits', () => {
    const project = createDemoProject(), path = project.paths[0];
    path.waypoints = buildWaypoints([{ x: 1, y: 1, theta: 0, segType: 'line' }, { x: 2, y: 1, theta: 0 }]);
    const strict = optimizeFixedGeometryFinal({ path, robot: project.robot, samplesPerSegment: 56 });
    path.optimization = { corridorM: 0.15, accepted: createAcceptedTrajectory(path, project.robot, strict, project.field, 56) };
    let result = processPathPreviewJob(job(project)).value;
    expect(result.acceptedTrajectory).toBe(true); expect(result.trajectory).toBe(path.optimization.accepted!.result);
    path.optimization.accepted!.result.samples[1].t = Number.NaN;
    result = processPathPreviewJob(job(project)).value;
    expect(result.status).toBe('infeasible'); expect(result.trajectory).toBeNull();
    expect(result.issues.some((issue: any) => /optimization/.test(issue.message))).toBe(true);
    path.startVel = 0.2;
    result = processPathPreviewJob(job(project)).value;
    expect(result.acceptedTrajectory).toBe(false); expect(result.status).toBe('ok');
  });
  it('coalesces busy revisions, rejects stale results, and shows current coordinates immediately', () => {
    const h = harness(), initial = job(); h.render(initial); h.render();
    const worker = h.workers[0], old = worker.jobs[0];
    const next = { ...initial, path: { ...initial.path, waypoints: initial.path.waypoints.map((w: any) => ({ ...w, x: w.x + 0.2, prevC: { ...w.prevC, x: w.prevC.x + 0.2 }, nextC: { ...w.nextC, x: w.nextC.x + 0.2 } })) } };
    h.render({ ...next, path: { ...next.path } }); const pending = h.render(next);
    expect(pending.ready).toBe(false); expect(pending.trajectory).toBeNull(); expect(pending.bestEffort).toBeNull();
    expect(pending.value.sample.pts[0].x).toBeCloseTo(next.path.waypoints[0].x, 8);
    h.reply(worker, old); expect(h.render().ready).toBe(false);
    expect(worker.jobs.length).toBe(2); expect(worker.jobs[1].path).toBe(next.path);
    h.reply(); expect(h.render().ready).toBe(true); h.cleanup();
  });
  it('invalidates same-path timing immediately on robot/field changes and when disabled', () => {
    const h = harness(), initial = job(); h.render(initial); h.reply(); expect(h.render().ready).toBe(true);
    const context = { ...initial, robot: { ...initial.robot, maxSpeed: initial.robot.maxSpeed * 0.9 }, field: { ...initial.field } };
    const changed = h.render(context); expect(changed.ready).toBe(false); expect(changed.trajectory).toBeNull();
    expect(changed.bestEffort).toBeNull(); expect(changed.value.finalTrajectory).toBeUndefined();
    h.reply(); expect(h.render().ready).toBe(true);
    const disabled = h.render(context, false); expect(disabled.status).toBe('idle'); expect(disabled.trajectory).toBeNull(); h.cleanup();
  });
  it('keeps malformed stationary inputs and extreme headings out of synchronous geometry timing', () => {
    const project = createDemoProject(), path = project.paths[0];
    path.waypoints[0].theta = 1e30;
    path.waypoints.at(-1)!.jiggle = { distanceM: 0.1, strokes: 2.5, startDeg: 0, stepDeg: 180, strokeTimeS: Number.NaN };
    const geometry = editingGeometry(path);
    expect(geometry.sample.pts.length).toBeGreaterThan(1); expect(geometry.prof.totalTime).toBe(0);
    const result = processPathPreviewJob(job(project)).value;
    expect(result.status).toBe('infeasible'); expect(result.trajectory).toBeNull();
    expect(result.derived.sample.pts.length).toBeGreaterThan(1);
  });
  for (const failure of ['error', 'messageerror', 'timeout', 'constructor', 'postMessage']) {
    it(`keeps current geometry through ${failure} and recovers on explicit retry`, () => {
      vi.useFakeTimers(); const h = harness();
      if (failure === 'constructor') h.constructorFail();
      if (failure === 'postMessage') h.postFail();
      const input = job(overlayProject()); h.render(input); h.render();
      if (failure === 'error' || failure === 'messageerror') {
        const handler = failure === 'error' ? 'onerror' : 'onmessageerror';
        h.workers[0][handler]({ message: 'Failed' }); h.workers[1][handler]({ message: 'Failed' });
      }
      if (failure === 'timeout') vi.advanceTimersByTime(10000);
      const failed = h.render(); expect(failed.status).toBe('error'); expect(failed.ready).toBe(false);
      expect(failed.strictPreview).toBeNull(); expect(failed.comparisonError).toBeNull();
      expect(failed.errorKind).toBe(failure === 'timeout' ? 'timeout' : 'failure');
      expect(failed.value.sample.pts.length).toBeGreaterThan(1); expect(failed.trajectory).toBeNull();
      expect(failed.value.effRanges).toEqual(effectiveRanges(input.path, failed.value.sample));
      expect(failed.value.anchors.length).toBeGreaterThan(1);
      const again = h.render(); expect(again.error).toBe(failed.error); expect(again.issues).toBe(failed.issues);
      expect(again.retry).toBe(failed.retry); expect(again.poseAtTime).toBe(failed.poseAtTime);
      const changed = { ...input, field: { ...input.field } };
      const pending = h.render(changed); expect(pending.error).toBeNull(); expect(pending.issues).toEqual([]);
      h.restore(); pending.retry(); h.render(); h.reply(); h.render(); h.reply(); const recovered = h.render();
      expect(recovered.ready).toBe(true); expect(recovered.error).toBeNull(); expect(recovered.issues).toEqual([]); h.cleanup();
    });
  }
});
