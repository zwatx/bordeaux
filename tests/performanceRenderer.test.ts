import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error The preview worker is an intentional JavaScript module.
import { applyFinalTrajectoryToPreview } from '../src/renderer/assets/path-preview-worker';
// @ts-expect-error Routine playback is an intentional JavaScript module.
import { AUTO } from '../src/renderer/lib/routineModel';
// @ts-expect-error Renderer path math is an intentional JavaScript module.
import { PM } from '../src/renderer/lib/pathMath';
// @ts-expect-error The preview scheduler is an intentional JavaScript module.
import { PathPreview } from '../src/renderer/assets/path-preview';
import { createDemoProject } from '../src/shared/project/defaults';

function fixture(count = 5) {
  const samples = Array.from({ length: count }, (_, index) => ({
    i: index, t: index, f: index / (count - 1), s: index, x: index, y: 0,
    headingRad: index * 0.1, velocityMps: index, accelerationMps2: -index,
    angularVelocityRadps: index * 0.2, curvatureInvM: index * 0.3,
  }));
  return {
    derived: { sample: { length: count - 1, pts: samples.map(({ x, y, s }) => ({ x, y, s })) }, prof: { holds: [], turns: [], jiggles: [] }, metrics: {}, rev: false },
    trajectory: { samples, stationaryActions: [], totalTimeS: count - 1 },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('final trajectory projection performance', () => {
  it('projects dense monotonic trajectories without a full sample scan per geometry point', () => {
    const { derived, trajectory } = fixture(2000);
    let fractionReads = 0;
    for (const sample of trajectory.samples) {
      const fraction = sample.f;
      Object.defineProperty(sample, 'f', { get() { fractionReads += 1; return fraction; } });
    }
    const result = applyFinalTrajectoryToPreview(derived, trajectory);
    expect(result.prof.t).toEqual(trajectory.samples.map((sample) => sample.t));
    expect(result.prof.v).toEqual(trajectory.samples.map((sample) => sample.velocityMps));
    expect(result.metrics.accel).toEqual(trajectory.samples.map((sample) => sample.accelerationMps2));
    expect(result.metrics.omega).toEqual(trajectory.samples.map((sample) => sample.angularVelocityRadps));
    expect(result.metrics.curv).toEqual(trajectory.samples.map((sample) => sample.curvatureInvM));
    expect(fractionReads).toBeLessThan(2000 * 80);
  });

  it('keeps the earliest matching time at duplicate fractions and skips nearby wrong positions', () => {
    const { derived, trajectory } = fixture();
    const middle = trajectory.samples[2];
    trajectory.samples.splice(2, 1,
      { ...middle, x: 30, t: 0.01 },
      { ...middle, t: 2.1 },
      { ...middle, t: 1.9 },
    );
    expect(applyFinalTrajectoryToPreview(derived, trajectory).prof.t[2]).toBe(1.9);
  });

  it('retains exact matching behavior for a nonmonotonic sample sequence', () => {
    const { derived, trajectory } = fixture();
    [trajectory.samples[1], trajectory.samples[3]] = [trajectory.samples[3], trajectory.samples[1]];
    expect(applyFinalTrajectoryToPreview(derived, trajectory).prof.t).toEqual([0, 1, 2, 3, 4]);
  });

  it('interpolates missing samples with squared velocity and the shortest heading arc', () => {
    const { derived, trajectory } = fixture(3);
    trajectory.samples = [
      { ...trajectory.samples[0], velocityMps: 2, headingRad: Math.PI - 0.1 },
      { ...trajectory.samples[2], velocityMps: 4, headingRad: -Math.PI + 0.1 },
    ];
    const result = applyFinalTrajectoryToPreview(derived, trajectory);
    expect(result.prof.t).toEqual([0, 1, 2]);
    expect(result.prof.v[1]).toBeCloseTo(Math.sqrt(10));
    expect(result.prof.head[1]).toBeCloseTo(Math.PI);
    derived.sample.pts[1].y = 0.01;
    expect(() => applyFinalTrajectoryToPreview(derived, trajectory)).toThrow('did not preserve the renderer geometry');
  });

  it('uses the existing tolerance comparisons at both sides of an exact fraction', () => {
    const { derived, trajectory } = fixture();
    const middle = trajectory.samples[2];
    const candidates = [-1.000001e-5, -1e-5, -0.999999e-5, 0.999999e-5, 1e-5, 1.000001e-5]
      .map((offset, index) => ({ ...middle, f: middle.f + offset, t: 1 + index * 0.1 }));
    trajectory.samples.splice(2, 1, ...candidates);
    const earliest = candidates.filter((sample) => Math.abs(sample.f - middle.f) <= 1e-5)
      .reduce((best, sample) => Math.min(best, sample.t), Infinity);
    expect(applyFinalTrajectoryToPreview(derived, trajectory).prof.t[2]).toBe(earliest);
  });
});

describe('routine performance', () => {
  it('matches half-open timed ownership and final terminal occurrence through zero-duration boundaries', () => {
    const steps = [
      { t0: 0, t1: 0 }, { t0: 0, t1: 1 }, { t0: 1, t1: 1 },
      { t0: 1, t1: 1 }, { t0: 1, t1: 2 }, { t0: 2, t1: 2 },
    ].map((step, index) => ({ ...step, pose: { x: index, y: 0 } }));
    const run = { steps, segs: [] };
    const times = [-1, 0, 1e-6, 0.5, 1, 1 + 1e-6, 1 + 1.01e-6, 2, 2 + 1e-6, 3, NaN, Infinity];
    for (const time of times) {
      const poseIndex = steps.findIndex((step) => time >= step.t0 && time < step.t1);
      const highlightIndex = steps.findIndex((step) => time >= step.t0 && time < step.t1);
      expect(AUTO.poseAt(run, time).x).toBe(poseIndex < 0 ? steps.length - 1 : poseIndex);
      expect(AUTO.stepAt(run, time)).toBe(highlightIndex < 0 ? steps.length - 1 : highlightIndex);
    }
    expect(AUTO.poseAt({ steps: [], segs: [] }, 0)).toBeNull();
    expect(AUTO.stepAt({ steps: [], segs: [] }, 0)).toBe(-1);
  });

  it('bounds per-frame step inspection for long routines', () => {
    let endReads = 0;
    const steps = Array.from({ length: 10000 }, (_, index) => ({
      t0: index, get t1() { endReads += 1; return index + 1; }, pose: { x: index, y: 0 },
    }));
    const run = { steps, segs: [] };
    expect(AUTO.poseAt(run, 9876.5).x).toBe(9876);
    expect(AUTO.stepAt(run, 9876.5)).toBe(9876);
    expect(endReads).toBeLessThan(40);
  });

  it('derives a repeated path once per build and refreshes after path or robot edits', () => {
    const project = createDemoProject();
    const path = project.paths[0];
    const routine = { nodes: Array.from({ length: 20 }, (_, i) => ({ id: String(i), type: 'path', ref: path.id })) };
    const derive = vi.spyOn(PM, 'derivePath');
    const run = AUTO.buildRun(routine, project.paths, project.robot, {}, project.plannerId);
    expect(derive).toHaveBeenCalledTimes(1);
    expect(run.segs).toHaveLength(20);
    expect(run.total).toBeCloseTo(run.segs[0].deriv.prof.totalTime * 20);
    for (const segment of run.segs) expect(segment.deriv).toBe(run.segs[0].deriv);
    path.waypoints[0].x += 0.1;
    project.robot.maxSpeed *= 0.9;
    const updated = AUTO.buildRun(routine, project.paths, project.robot, {}, project.plannerId);
    expect(derive).toHaveBeenCalledTimes(2);
    expect(updated.segs[0].deriv).not.toBe(run.segs[0].deriv);
  });

  it('reuses authoritative plans without deriving and refreshes when the plan changes', () => {
    const project = createDemoProject();
    const path = project.paths[0];
    const routine = { nodes: [{ id: 'first', type: 'path', ref: path.id }, { id: 'repeat', type: 'path', ref: path.id }] };
    const derive = vi.spyOn(PM, 'derivePath');
    const { trajectory } = fixture();
    const plans = { [path.id]: { finalTrajectory: trajectory } };
    const build = () => AUTO.buildRun(routine, project.paths, project.robot, {}, project.plannerId, undefined, plans);
    expect(build().total).toBe(8);
    plans[path.id] = { finalTrajectory: { ...trajectory, totalTimeS: 6 } };
    expect(build().total).toBe(12);
    expect(derive).not.toHaveBeenCalled();
  });
});


describe('interactive preview transport', () => {
  it('does not clone accepted samples during pointer edits, and preserves the source identity', () => {
    const project = createDemoProject();
    let artifactReads = 0;
    const artifact = { get samples() { artifactReads += 1; return fixture().trajectory.samples; } };
    const path = { ...project.paths[0], optimization: { corridorM: 0.2, accepted: { result: artifact } } };
    const jobs: any[] = [];
    const worker = {
      onmessage: (_event: { data: any }) => {},
      postMessage(job: any) { jobs.push(structuredClone(job)); },
      terminate() {},
    };
    const preview = PathPreview.create({ workerFactory: () => worker });
    try {
      preview.request({ path, robot: project.robot, quality: 'interactive' });
      expect(artifactReads).toBe(0);
      expect(jobs[0].path.optimization).toBeUndefined();
      expect(jobs[0].path.waypoints).toEqual(path.waypoints);
      worker.onmessage({ data: { id: jobs[0].id, value: {} } });
      expect(preview.getSnapshot().path).toBe(path);
      expect(path.optimization.accepted.result).toBe(artifact);
      preview.request({ path, robot: project.robot, quality: 'final' });
      expect(artifactReads).toBe(1);
      expect(jobs[1].path.optimization.accepted.result.samples).toHaveLength(5);
    } finally {
      preview.destroy();
    }
  });
});
