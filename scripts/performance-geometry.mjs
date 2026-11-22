// Optional BORDEAUX_GEOMETRY_MODULE selects a saved pre-change module for comparison.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createServer } from 'vite';
const server = await createServer({ configFile: false, server: { middlewareMode: true } });
try {
  const { measureRobotFieldClearance, observeRobotFieldPortalSequence } = await server.ssrLoadModule(
    process.env.BORDEAUX_GEOMETRY_MODULE || '/src/core/agent/fieldClearance.ts');
  const { createDemoProject } = await server.ssrLoadModule('/src/core/project/defaults.ts');
  const robot = createDemoProject().robot;
  const samples = Array.from({ length: 10_000 }, (_, i) => ({ i, x: 0.1 + ((i * 17) % 173) / 10,
    y: 0.1 + ((i * 13) % 81) / 10, headingRad: i * 0.17, t: i * 0.02, s: i * 0.1,
    f: i / 10000, velocityMps: 1, accelerationMps2: 0, angularVelocityRadps: 0, curvatureInvM: 0 }));
  const results = [];
  for (const [name, operation] of [
    ['10000 field clearance samples', () => measureRobotFieldClearance(robot, samples)],
    ['10000 portal sequence samples', () => observeRobotFieldPortalSequence(robot, samples)],
  ]) {
    const reference = operation();
    for (let i = 0; i < 3; i++) operation();
    const timings = [];
    for (let i = 0; i < 9; i++) {
      const start = performance.now();
      const result = operation();
      timings.push(performance.now() - start);
      assert.deepEqual(result, reference);
    }
    timings.sort((a, b) => a - b);
    results.push({ name, medianMs: +timings[4].toFixed(3), minMs: +timings[0].toFixed(3),
      result: name.includes('clearance') ? reference : { valid: reference.valid, visits: reference.visits.length } });
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  await server.close();
}
