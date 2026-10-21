import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CorridorCorpus } from "../src/electron/benchmark/corridor";
// @ts-expect-error Production renderer module is JavaScript.
import { FinalPlanning } from "../src/renderer/assets/final-planning";
// @ts-expect-error Production renderer module is JavaScript.
import { PathOptimization } from "../src/renderer/assets/path-optimization";
// @ts-expect-error Production renderer module is JavaScript.
import { processPathPreviewJob } from "../src/renderer/assets/path-preview-worker";
// @ts-expect-error Production renderer module is JavaScript.
import { PM } from "../src/renderer/lib/pathMath";
import { optimizeCorridorFinal } from "../src/shared/planners/corridorFinal";
import { createDemoProject } from "../src/shared/project/defaults";
import { decodeProjectFile } from "../src/shared/project/fileFormat";

class FakeWorker {
  readonly jobs: Array<{ id: number }> = [];
  terminated = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  postMessage(job: { id: number }) { this.jobs.push(job); }
  reply(data: unknown) { this.onmessage?.({ data }); }
  terminate() { this.terminated = true; }
}

function setup({ cooperativeCancel = true, cancelResult = { status: 'canceled' } as any } = {}) {
  let project = createDemoProject();
  const jobs: Array<{ input: any; options: any; resolve: (value: any) => void; canceled: boolean }> = [];
  const planner = {
    request(input: any, options: any) {
      let resolve!: (value: any) => void;
      const promise = new Promise((done) => { resolve = done; });
      const job = { input, options, resolve, canceled: false };
      jobs.push(job);
      return { promise, cancel() { job.canceled = true; if (cooperativeCancel) resolve(cancelResult); } };
    },
  };
  const session = PathOptimization.create({ getProject: () => project, planner });
  return { session, jobs, project, replace(next: typeof project) { project = next; session.sync(); },
    adopt(next: typeof project) { session.reset(); project = next; session.sync(); } };
}

const preview = { prof: { totalTime: 3.7 }, finalTrajectory: { totalTimeS: 3.7 } };

// One real optimizer run through the worker, recorded at a fixed work budget
// and replayed into FinalPlanning as the worker would have posted it.
let recorded: { project: any; messages: any[]; final: any; projections: number } | undefined;
function recordedSearch() {
  if (recorded) return recorded;
  const directory = new URL("../benchmarks/planner-corpus/v2/", import.meta.url);
  const corpus = CorridorCorpus.loadV2(fileURLToPath(directory));
  const project = decodeProjectFile(readFileSync(new URL("corpus.bordeaux.json", directory), "utf8")).project;
  const path = project.paths.find((candidate) => candidate.id === corpus.cases[1].pathId)!;
  const messages: any[] = [];
  let projections = 0;
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  try {
    const final = processPathPreviewJob(
      { id: 1, quality: "final", optimize: true, path, robot: project.robot, perSegment: 56, deadline: "common", deadlineMs: 5_000 },
      (...args: unknown[]) => { projections += 1; return PM.derivePath(...args); },
      optimizeCorridorFinal,
      undefined,
      (message: unknown) => messages.push(message),
    );
    recorded = { project: { ...project, paths: [path] }, messages, final, projections };
  } finally {
    clock.mockRestore();
  }
  return recorded;
}

describe('explicit path optimization ownership', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps idle completion separate from project selection', async () => {
    const { session, project, jobs } = setup();
    const before = structuredClone(project);
    const pending = session.start(project.paths[0].id);
    expect(jobs[0].input.optimize).toBe(true);
    expect(session.getSnapshot().paths[project.paths[0].id].value).toBeNull();
    jobs[0].resolve({ status: 'success', value: preview });
    await pending;
    expect(session.getSnapshot().paths[project.paths[0].id].value).toEqual(preview);
    expect(project).toEqual(before);
    session.sync();
    expect(session.getSnapshot().paths[project.paths[0].id].value).toEqual(preview);
    expect(jobs).toHaveLength(1);
  });

  it('cancels changed input and rejects a stale successful reply', async () => {
    const { session, project, jobs, replace } = setup();
    const pending = session.start(project.paths[0].id);
    const changed = structuredClone(project);
    changed.robot.maxSpeed += 0.5;
    replace(changed);
    expect(jobs[0].canceled).toBe(true);
    await pending;
    expect(session.getSnapshot().paths[project.paths[0].id]).toMatchObject({ status: 'stale', value: null });
  });

  it('does not cancel for a cosmetic rename', async () => {
    const { session, project, jobs, replace } = setup();
    const pending = session.start(project.paths[0].id);
    const renamed = structuredClone(project);
    renamed.paths[0].name = 'Renamed';
    replace(renamed);
    expect(jobs[0].canceled).toBe(false);
    jobs[0].resolve({ status: 'success', value: preview });
    await pending;
    expect(session.getSnapshot().paths[project.paths[0].id].status).toBe('success');
  });

  it.each(['seed', 'required waypoint'])('rejects an in-flight %s A→B→A reply even after Undo restores its key', async (change) => {
    const h = setup({ cooperativeCancel: false });
    const original = structuredClone(h.project), id = original.paths[0].id;
    const pending = h.session.start(id);
    const changed = structuredClone(original);
    if (change === 'seed') changed.paths[0].waypoints[0].nextC.y += 0.5;
    else changed.paths[0].waypoints[0].y += 0.5;
    h.replace(changed);
    expect(h.jobs[0].canceled).toBe(true);
    h.replace(original);
    h.jobs[0].resolve({ status: 'success', value: preview });
    await pending;
    expect(h.session.getSnapshot().paths[id]).toMatchObject({ status: 'stale', value: null });
    h.session.dispose();
  });

  it('keeps a deadline incumbent available to compare without changing selected data', async () => {
    const { session, project, jobs } = setup();
    const pending = session.start(project.paths[0].id);
    jobs[0].resolve({ status: 'timeout', incumbent: preview, fallbackReason: 'Deadline reached' });
    await pending;
    expect(session.getSnapshot().paths[project.paths[0].id]).toMatchObject({ status: 'timeout', value: preview });
    expect(project.paths[0].optimization?.accepted).toBeUndefined();
  });

  it.each(['canceled', 'timeout'] as const)('keeps worker progress out of the store but reports the last incumbent when %s', async (ending) => {
    vi.useFakeTimers();
    const project = createDemoProject();
    const worker = new FakeWorker();
    const planner = FinalPlanning.create({ workerFactory: () => worker, deadlines: { common: 50 } });
    const session = PathOptimization.create({ getProject: () => project, planner });
    let notifications = 0;
    session.subscribe(() => { notifications += 1; });
    const id = project.paths[0].id;
    const pending = session.start(id);
    const searching = notifications;
    const improved = { ...preview, prof: { totalTime: 3.2 } };
    worker.reply({ id: worker.jobs[0].id, type: 'progress', value: preview });
    worker.reply({ id: worker.jobs[0].id, type: 'progress', value: improved });

    expect(notifications).toBe(searching);
    expect(session.getSnapshot().paths[id]).toMatchObject({ status: 'searching', value: null });
    if (ending === 'canceled') session.cancel();
    else await vi.advanceTimersByTimeAsync(2_000);
    await pending;

    expect(worker.terminated).toBe(true);
    expect(session.getSnapshot().paths[id]).toMatchObject({ status: ending, value: improved });
    expect(project.paths[0].optimization?.accepted).toBeUndefined();
  });

  it.each([
    ['canceled', 'cancelled'],
    ['timeout', 'time-budget'],
    ['success', 'work-budget'],
  ] as const)('keeps the last validated route with current search counters when %s', async (ending, termination) => {
    const { project, messages, final, projections } = recordedSearch();
    const progress = messages.filter((message) => message.type === 'progress');
    const statistics = messages.filter((message) => message.type === 'statistics');
    const counters = final.value.finalOptimization;
    // Statistics never project a preview or carry a trajectory.
    expect(projections).toBe(progress.length + 1);
    expect(statistics.length).toBeGreaterThan(0);
    statistics.forEach((message) => expect(message.value).toBeUndefined());
    expect(messages.at(-1).type).toBe('statistics');
    const last = progress.at(-1).value;
    expect(last.finalOptimization.evaluations).toBeLessThan(counters.evaluations);

    vi.useFakeTimers();
    const worker = new FakeWorker();
    const planner = FinalPlanning.create({ workerFactory: () => worker, deadlines: { common: 50 } });
    const session = PathOptimization.create({ getProject: () => project, planner });
    let notifications = 0;
    session.subscribe(() => { notifications += 1; });
    const id = project.paths[0].id;
    const pending = session.start(id);
    const searching = notifications;
    messages.forEach((message) => worker.reply({ ...message, id: worker.jobs[0].id }));
    expect(notifications).toBe(searching);

    if (ending === 'canceled') session.cancel();
    else if (ending === 'timeout') await vi.advanceTimersByTimeAsync(2_000);
    else worker.reply({ ...final, id: worker.jobs[0].id });
    await pending;

    const value = session.getSnapshot().paths[id].value;
    expect(session.getSnapshot().paths[id].status).toBe(ending);
    expect(value.finalOptimization).toMatchObject({
      termination,
      evaluations: counters.evaluations,
      validatedCandidates: counters.validatedCandidates,
      rejectedCandidates: counters.rejectedCandidates,
      rejectionReasons: counters.rejectionReasons,
    });
    expect(value.finalTrajectory.optimization).toBe(value.finalOptimization);
    if (ending === 'success') {
      expect(value).toBe(final.value);
    } else {
      // The retained route is the last validated incumbent, shared rather than copied.
      expect(value.finalTrajectory.samples).toBe(last.finalTrajectory.samples);
      expect(value.finalTrajectory.optimizedPath).toBe(last.finalTrajectory.optimizedPath);
      expect(value.finalOptimization).toMatchObject({
        status: 'feasible',
        totalTimeS: last.finalOptimization.totalTimeS,
        gainS: last.finalOptimization.gainS,
      });
      expect(last.finalOptimization.termination).toBeUndefined();
    }
    expect(project.paths[0].optimization?.accepted).toBeUndefined();
  }, 30_000);

  it('queues Optimize all one path at a time and never applies batch results', async () => {
    const { session, project, jobs } = setup();
    project.paths = [project.paths[0], { ...structuredClone(project.paths[0]), id: 'second' }];
    const pending = session.startAll();
    expect(jobs).toHaveLength(1);
    jobs[0].resolve({ status: 'success', value: preview });
    await Promise.resolve(); await Promise.resolve();
    expect(jobs).toHaveLength(2);
    jobs[1].resolve({ status: 'success', value: preview });
    await pending;
    expect(session.getSnapshot().batch).toEqual({ completed: 2, total: 2 });
    expect(project.paths.every((path) => !path.optimization?.accepted)).toBe(true);
  });
});


describe('optimizer document reset ownership', () => {
  it('clears completed candidate and batch snapshots synchronously even for an identical document', async () => {
    const h = setup(), id = h.project.paths[0].id;
    const pending = h.session.startAll(); h.jobs[0].resolve({ status: 'success', value: preview }); await pending;
    expect(h.session.getSnapshot().paths[id].value).toBe(preview);
    expect(h.session.getSnapshot().batch).toEqual({ completed: 1, total: 1 });
    const notify = vi.fn(); h.session.subscribe(notify);
    h.adopt(structuredClone(h.project));
    expect(h.session.getSnapshot()).toEqual({ paths: {}, batch: null, running: false }); expect(notify).toHaveBeenCalledOnce();
    h.session.dispose();
  });
  it('discards cancellation incumbent on document reset while explicit same-document Cancel retains it', async () => {
    const result = { status: 'canceled', incumbent: preview }, h = setup({ cancelResult: result }), id = h.project.paths[0].id;
    let pending = h.session.start(id); h.session.cancel(); await pending;
    expect(h.session.getSnapshot().paths[id]).toMatchObject({ status: 'canceled', value: preview });
    pending = h.session.start(id); h.adopt(structuredClone(h.project)); await pending;
    expect(h.jobs[1].canceled).toBe(true); expect(h.session.getSnapshot()).toEqual({ paths: {}, batch: null, running: false }); h.session.dispose();
  });
  it.each(['success', 'canceled', 'timeout', 'failure'])('rejects old uncooperative %s after same-ID/key document replacement', async status => {
    const h = setup({ cooperativeCancel: false }), id = h.project.paths[0].id, pending = h.session.start(id);
    h.adopt(structuredClone(h.project)); expect(h.jobs[0].canceled).toBe(true);
    const empty = h.session.getSnapshot(), notify = vi.fn(); h.session.subscribe(notify);
    h.jobs[0].resolve({ status, value: preview, incumbent: preview, error: { message: 'Old failure' } }); await pending;
    expect(h.session.getSnapshot()).toBe(empty); expect(notify).not.toHaveBeenCalled(); h.session.dispose();
  });
  it('allows immediate new search and prevents old completion/finally from changing its running state', async () => {
    const h = setup({ cooperativeCancel: false }), id = h.project.paths[0].id;
    const old = h.session.start(id); h.adopt(structuredClone(h.project)); const current = h.session.start(id);
    expect(h.jobs).toHaveLength(2); const searching = h.session.getSnapshot();
    h.jobs[0].resolve({ status: 'success', value: { source: 'old' } }); await old;
    expect(h.session.getSnapshot()).toBe(searching); expect(searching.running).toBe(true); expect(searching.paths[id].value).toBeNull();
    h.jobs[1].resolve({ status: 'success', value: preview }); await current;
    expect(h.session.getSnapshot().running).toBe(false); expect(h.session.getSnapshot().paths[id].value).toBe(preview); h.session.dispose();
  });
  it('rejects document A→B→A late results without reviving either prior search', async () => {
    const h = setup({ cooperativeCancel: false }), a = h.project, id = a.paths[0].id;
    const first = h.session.start(id); h.adopt(structuredClone(a)); const second = h.session.start(id);
    h.adopt(a); const third = h.session.start(id); expect(h.jobs).toHaveLength(3);
    const searching = h.session.getSnapshot();
    h.jobs[1].resolve({ status: 'timeout', incumbent: preview }); await second;
    h.jobs[0].resolve({ status: 'success', value: preview }); await first;
    expect(h.session.getSnapshot()).toBe(searching);
    const current = { source: 'current' }; h.jobs[2].resolve({ status: 'success', value: current }); await third;
    expect(h.session.getSnapshot().paths[id].value).toBe(current); h.session.dispose();
  });
  it('retires old batch progress/next IDs/finally while a new single search owns the controller', async () => {
    const h = setup({ cooperativeCancel: false }), id = h.project.paths[0].id;
    h.project.paths.push({ ...structuredClone(h.project.paths[0]), id: 'old-only' });
    const old = h.session.startAll(); h.adopt({ ...structuredClone(h.project), paths: [structuredClone(h.project.paths[0])] });
    const current = h.session.start(id), searching = h.session.getSnapshot();
    h.jobs[0].resolve({ status: 'canceled', incumbent: preview }); await old;
    expect(h.session.getSnapshot()).toBe(searching); expect(searching.batch).toBeNull(); expect(searching.running).toBe(true);
    expect(h.jobs).toHaveLength(2); expect(h.jobs.every(job => job.input.path.id === id)).toBe(true);
    h.jobs[1].resolve({ status: 'success', value: preview }); await current; h.session.dispose();
  });
  it('keeps new batch counts and IDs independent from old batch continuation', async () => {
    const h = setup({ cooperativeCancel: false }), id = h.project.paths[0].id;
    h.project.paths.push({ ...structuredClone(h.project.paths[0]), id: 'old-only' });
    const old = h.session.startAll();
    const next = structuredClone(h.project); next.paths[1].id = 'new-only'; h.adopt(next);
    const current = h.session.startAll(), searching = h.session.getSnapshot();
    h.jobs[0].resolve({ status: 'success', value: { source: 'old' } }); await old;
    expect(h.session.getSnapshot()).toBe(searching); expect(searching.batch).toEqual({ completed: 0, total: 2 }); expect(searching.running).toBe(true);
    h.jobs[1].resolve({ status: 'success', value: preview }); await Promise.resolve(); await Promise.resolve();
    expect(h.jobs).toHaveLength(3); expect(h.jobs.map(job => job.input.path.id)).toEqual([id, id, 'new-only']);
    expect(h.session.getSnapshot().batch).toEqual({ completed: 1, total: 2 });
    h.jobs[2].resolve({ status: 'success', value: preview }); await current;
    expect(h.session.getSnapshot()).toMatchObject({ running: false, batch: { completed: 2, total: 2 } });
    expect(h.session.getSnapshot().paths['old-only']).toBeUndefined(); h.session.dispose();
  });
  it('preserves same-document batch Cancel incumbent and stops queuing subsequent paths', async () => {
    const h = setup({ cancelResult: { status: 'canceled', incumbent: preview } }), id = h.project.paths[0].id;
    h.project.paths.push({ ...structuredClone(h.project.paths[0]), id: 'next' });
    const pending = h.session.startAll(); h.session.cancel(); await pending;
    expect(h.jobs).toHaveLength(1); expect(h.session.getSnapshot()).toMatchObject({ running: false, batch: { completed: 1, total: 2 } });
    expect(h.session.getSnapshot().paths[id]).toMatchObject({ status: 'canceled', value: preview }); h.session.dispose();
  });
  it('stops old batch continuation after disposal without notifying detached subscribers', async () => {
    const h = setup({ cooperativeCancel: false });
    h.project.paths.push({ ...structuredClone(h.project.paths[0]), id: 'next' });
    const pending = h.session.startAll(), notify = vi.fn(); h.session.subscribe(notify); const searching = h.session.getSnapshot();
    h.session.dispose(); h.jobs[0].resolve({ status: 'success', value: preview }); await pending;
    expect(h.session.getSnapshot()).toBe(searching); expect(notify).not.toHaveBeenCalled(); expect(h.jobs).toHaveLength(1);
    await h.session.start(h.project.paths[0].id); expect(h.jobs).toHaveLength(1);
  });
  it('does not launch a retired request when reset occurs inside a search notification', async () => {
    const h = setup();
    const unsubscribe = h.session.subscribe(() => {
      if (Object.values(h.session.getSnapshot().paths).some((path: any) => path.status === 'searching')) h.session.reset();
    });
    await h.session.start(h.project.paths[0].id);
    expect(h.jobs).toHaveLength(0); expect(h.session.getSnapshot()).toEqual({ paths: {}, batch: null, running: false });
    unsubscribe(); h.session.dispose();
  });
  it('keeps same-document path selection/immutable edits distinct from document reset', async () => {
    const h = setup(), id = h.project.paths[0].id, pending = h.session.start(id);
    const next = structuredClone(h.project); next.paths.push({ ...structuredClone(next.paths[0]), id: 'selected-other' });
    next.editor = { ...next.editor, activePathId: 'selected-other' }; next.name = 'Renamed project'; h.replace(next);
    expect(h.jobs[0].canceled).toBe(false); h.jobs[0].resolve({ status: 'success', value: preview }); await pending;
    expect(h.session.getSnapshot().paths[id].value).toBe(preview); h.session.dispose();
  });
});
