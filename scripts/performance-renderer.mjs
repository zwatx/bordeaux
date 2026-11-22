import { performance } from 'node:perf_hooks';
import { createServer } from 'vite';

const server = await createServer({ configFile: false, server: { middlewareMode: true } });
try {
  const { applyFinalTrajectoryToPreview } = await server.ssrLoadModule('/src/renderer/assets/path-preview-worker.js');
  const { PathPreview } = await server.ssrLoadModule('/src/renderer/assets/path-preview.js');
  const { AUTO } = await server.ssrLoadModule('/src/renderer/lib/routineModel.js');
  const { createDemoProject } = await server.ssrLoadModule('/src/core/project/defaults.ts');
  const measure = (name, operation, iterations) => {
    for (let i = 0; i < 3; i += 1) operation();
    const durations = [];
    for (let i = 0; i < iterations; i += 1) {
      const start = performance.now();
      operation();
      durations.push(performance.now() - start);
    }
    durations.sort((a, b) => a - b);
    return { name, iterations, medianMs: +durations[Math.floor(durations.length / 2)].toFixed(3) };
  };
  const count = 5000;
  const samples = Array.from({ length: count }, (_, i) => ({
    i, t: i / 100, f: i / (count - 1), s: i / 100, x: i / 100, y: 0,
    headingRad: 0, velocityMps: 1, accelerationMps2: 0, angularVelocityRadps: 0, curvatureInvM: 0,
  }));
  const derived = {
    sample: { length: samples.at(-1).s, pts: samples },
    prof: { holds: [], turns: [], jiggles: [] }, metrics: {}, rev: false,
  };
  const trajectory = { samples, totalTimeS: samples.at(-1).t, stationaryActions: [] };
  const run = { steps: Array.from({ length: 10000 }, (_, i) => ({ t0: i, t1: i + 1, pose: { x: i, y: 0 } })), segs: [] };
  const project = createDemoProject();
  const routine = { nodes: Array.from({ length: 100 }, (_, i) => ({ id: String(i), type: 'path', ref: project.paths[0].id })) };
  const selectedPath = { ...project.paths[0], optimization: { accepted: { result: trajectory } } };
  const preview = PathPreview.create({ workerFactory: () => ({
    postMessage(job) {
      const cloned = structuredClone(job);
      this.onmessage({ data: { id: cloned.id, value: {} } });
    },
    terminate() {},
  }) });
  console.log(JSON.stringify([
    measure('project 5000 final samples onto 5000 geometry points', () => applyFinalTrajectoryToPreview(derived, trajectory), 12),
    measure('1000 playback pose/highlight pairs across 10000 steps', () => {
      for (let i = 0; i < 1000; i += 1) {
        const time = ((i * 7919) % 10000) + 0.5;
        AUTO.poseAt(run, time);
        AUTO.stepAt(run, time);
      }
    }, 12),
    measure('dispatch interactive edit with 5000-sample accepted trajectory', () => preview.request({ path: selectedPath, robot: project.robot, quality: 'interactive' }), 30),
    measure('build routine repeating one path 100 times', () => AUTO.buildRun(routine, project.paths, project.robot, {}, project.plannerId), 8),
  ], null, 2));
  preview.destroy();
} finally {
  await server.close();
}
