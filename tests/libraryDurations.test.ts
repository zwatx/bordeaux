import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoProject } from '../src/core/project/defaults';
import type { PathDoc } from '../src/core/types';

const identity = vi.hoisted(() => ({ keys: 0 }));
vi.mock('../src/core/planners/planningKey', async (original) => {
  const actual = await original<typeof import('../src/core/planners/planningKey')>();
  return { ...actual, pathPlanningKey: (...args: Parameters<typeof actual.pathPlanningKey>) => { identity.keys += 1; return actual.pathPlanningKey(...args); } };
});
const { pathPlanningKey } = await import('../src/core/planners/planningKey');
// @ts-expect-error Library duration scheduling remains a JavaScript module.
const { createLibraryDurations } = await import('../src/renderer/lib/libraryDurations');

type Result = { status: string; value?: { prof: { totalTime: number }; finalTrajectory: object }; fallbackReason?: string; error?: { message: string } };
type Job = { id: string; input: Record<string, unknown>; resolve(result: Result): void; cancel: ReturnType<typeof vi.fn> };
const success = (seconds: number): Result => ({ status: 'success', value: { prof: { totalTime: seconds }, finalTrajectory: {} } });
const flush = () => new Promise<void>((done) => queueMicrotask(done));

function setup() {
  const jobs: Job[] = [];
  const controller = createLibraryDurations({ request(input: Record<string, unknown>) {
    let resolve!: (result: Result) => void;
    const promise = new Promise<Result>((done) => { resolve = done; });
    const cancel = vi.fn();
    jobs.push({ id: String(input.key), input, resolve, cancel });
    return { promise, cancel };
  } });
  return { controller, jobs };
}

function library(count = 3) {
  const project = createDemoProject();
  const base = project.paths[0];
  const paths: PathDoc[] = Array.from({ length: count }, (_, index) => ({ ...structuredClone(base), id: String.fromCharCode(97 + index), name: 'Path ' + index }));
  return { robot: project.robot, field: project.field, paths };
}

beforeEach(() => { identity.keys = 0; });

describe('library trajectory durations', () => {
  it('computes unopened paths sequentially and reuses the active selected duration', async () => {
    const { controller, jobs } = setup();
    const { paths, robot, field } = library();
    const input = { paths, robot, field, plannerId: 'profiledSpline' };
    controller.update(input, { id: 'a', status: 'ready', seconds: 3 });
    expect(jobs.map((job) => job.id)).toEqual(['b']);
    expect(controller.getSnapshot().a).toEqual({ status: 'ready', seconds: 3 });
    jobs[0].resolve(success(4)); await flush();
    expect(jobs.map((job) => job.id)).toEqual(['b', 'c']);
    jobs[1].resolve(success(5)); await flush();
    controller.update(input, { id: 'b', status: 'pending' });
    expect(controller.getSnapshot().b.seconds).toBe(4);
    expect(jobs).toHaveLength(2);
  });

  it('forwards the project field to final planning', () => {
    const { controller, jobs } = setup();
    const { paths, robot, field } = library(2);
    controller.update({ paths, robot, field, plannerId: 'profiledSpline' }, { id: 'a', status: 'pending' });
    expect(jobs[0].input).toMatchObject({ key: 'b', path: paths[1], robot, field, plannerId: 'profiledSpline' });
  });

  it('computes keys once for a one-path edit, reuses the editor key, and keeps unrelated results', async () => {
    const { controller, jobs } = setup();
    const { paths, robot, field } = library(20);
    const plannerId = 'profiledSpline';
    controller.update({ paths, robot, field, plannerId }, { id: 'a', status: 'pending' });
    expect(identity.keys).toBe(20);
    // Background jobs run one at a time; the live iterator follows each new job.
    for (const [index, job] of jobs.entries()) { job.resolve(success(index + 1)); await flush(); }
    expect(jobs).toHaveLength(19);

    identity.keys = 0;
    controller.update({ paths, robot, field, plannerId }, { id: 'a', status: 'ready', seconds: 1 });
    expect(identity.keys).toBe(0);
    const before = controller.getSnapshot();

    const edit = (path: PathDoc) => ({ ...path, waypoints: path.waypoints.map((waypoint, index) => index === 1 ? { ...waypoint, x: waypoint.x + 0.2 } : waypoint) });
    const edited = edit(paths[7]);
    const currentKey = pathPlanningKey(edited, robot, field);
    identity.keys = 0;
    controller.update({ paths: paths.map((path) => path.id === edited.id ? edited : path), robot, field, plannerId, currentPath: edited, currentKey }, { id: edited.id, status: 'pending' });
    expect(identity.keys).toBe(0);
    const after = controller.getSnapshot();
    expect(after[edited.id]).toEqual({ status: 'pending' });
    for (const path of paths) if (path.id !== edited.id) expect(after[path.id]).toBe(before[path.id]);

    // An edit elsewhere, such as a linked start pose, costs one key.
    const linked = edit(paths[12]);
    controller.update({ paths: paths.map((path) => path.id === edited.id ? edited : path.id === linked.id ? linked : path), robot, field, plannerId, currentPath: edited, currentKey }, { id: edited.id, status: 'pending' });
    expect(identity.keys).toBe(1);
    expect(controller.getSnapshot()[linked.id]).toEqual({ status: 'pending' });
  });

  it('keeps a renamed path without replanning but invalidates physical robot and field changes', async () => {
    const { controller, jobs } = setup();
    const { paths, robot, field } = library(2);
    controller.update({ paths, robot, field, plannerId: 'profiledSpline' }, { id: 'a', status: 'ready', seconds: 3 });
    jobs[0].resolve(success(4)); await flush();

    const renamed = [paths[0], { ...paths[1], name: 'Renamed' }];
    controller.update({ paths: renamed, robot, field, plannerId: 'profiledSpline' }, { id: 'a', status: 'ready', seconds: 3 });
    expect(controller.getSnapshot().b).toEqual({ status: 'ready', seconds: 4 });

    identity.keys = 0;
    const noted = { ...robot, planning: { notes: 'Collect from the depot first.' } };
    controller.update({ paths: renamed, robot: noted, field, plannerId: 'profiledSpline' }, { id: 'a', status: 'ready', seconds: 3 });
    expect(identity.keys).toBe(0);
    expect(controller.getSnapshot().b).toEqual({ status: 'ready', seconds: 4 });
    expect(jobs).toHaveLength(1);

    controller.update({ paths: renamed, robot: { ...noted, w: robot.w + 0.1 }, field, plannerId: 'profiledSpline' }, { id: 'a', status: 'pending' });
    expect(controller.getSnapshot().b).toEqual({ status: 'pending' });
    expect(jobs).toHaveLength(2);

    const movedField = { ...field, revision: field.revision + '-moved' };
    controller.update({ paths: renamed, robot: { ...noted, w: robot.w + 0.1 }, field: movedField, plannerId: 'profiledSpline' }, { id: 'a', status: 'pending' });
    expect(jobs[1].cancel).toHaveBeenCalledOnce();
    expect(jobs[2].input.field).toBe(movedField);
  });

  it('cancels replaced or newly selected work and ignores obsolete results', async () => {
    const { controller, jobs } = setup();
    const { paths, robot, field } = library();
    controller.update({ paths, robot, field, plannerId: 'profiledSpline' }, { id: 'a', status: 'ready', seconds: 3 });
    controller.update({ paths, robot, field, plannerId: 'profiledSpline' }, { id: 'b', status: 'pending' });
    expect(jobs[0].cancel).toHaveBeenCalledOnce();
    expect(jobs[1].id).toBe('c');
    controller.cancel();
    expect(jobs[1].cancel).toHaveBeenCalledOnce();
    jobs[1].resolve(success(100)); await flush();
    expect(controller.getSnapshot().c.status).toBe('pending');
    jobs[0].resolve(success(99)); await flush();
    expect(controller.getSnapshot().b.status).toBe('pending');

    controller.update({ paths: [paths[2]], robot, field, plannerId: 'profiledSpline' }, { id: 'c', status: 'ready', seconds: 2 });
    expect(Object.keys(controller.getSnapshot())).toEqual(['c']);
  });

  it('reports failures without retry loops or blocking later paths', async () => {
    const { controller, jobs } = setup();
    const { paths, robot, field } = library(4);
    const input = { paths, robot, field, plannerId: 'profiledSpline' };
    controller.update(input, { id: 'a', status: 'ready', seconds: 3 });
    jobs[0].resolve({ status: 'failure', fallbackReason: 'Unreachable speed' }); await flush();
    expect(controller.getSnapshot().b).toEqual({ status: 'error', message: 'Unreachable speed' });
    jobs[1].resolve({ status: 'success', value: { prof: { totalTime: Number.NaN }, finalTrajectory: {} } }); await flush();
    expect(controller.getSnapshot().c).toEqual({ status: 'error', message: 'Could not prepare this trajectory.' });
    jobs[2].resolve({ status: 'timeout', fallbackReason: 'Final planning exceeded the common deadline (5000 ms).' }); await flush();
    expect(controller.getSnapshot().d.status).toBe('error');
    controller.update(input, { id: 'a', status: 'ready', seconds: 3 });
    expect(jobs).toHaveLength(3);
  });
});
