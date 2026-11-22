// Build first: npm run build:electron. Optionally pass a separate compiled tree.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import path from "node:path";

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.argv[2] ?? "dist-electron");
const { headingAt } = require(path.join(compiled, "core/math/headingAnchors.js"));
const { buildCanonicalPathState } = require(path.join(compiled, "core/planners/pathState.js"));
const { solveReachabilityProfile } = require(path.join(compiled, "core/planners/reachability.js"));
const { getPlanner } = require(path.join(compiled, "core/planners/index.js"));
const { buildWaypoints, createDemoProject } = require(path.join(compiled, "core/project/defaults.js"));

const anchors = Array.from({ length: 10001 }, (_, i) => ({ f: i / 10000, rad: i / 10000 }));
const project = createDemoProject();
const turnInput = { ...JSON.parse(readFileSync(new URL("../tests/fixtures/rotation-target-turn.json", import.meta.url), "utf8")), samplesPerSegment: 56 };
const stationaryPath = { ...project.paths[0], waypoints: buildWaypoints([{ x: 0, y: 0 }, { x: 2, y: 0 }]) };
const samples = Array.from({ length: 6002 }, (_, i) => {
  const s = i === 0 ? 0 : i === 6001 ? 2 : 1;
  return { i, s, f: s / 2, x: s, y: 0, t: i / 50, headingRad: i / 6001,
    velocityMps: 0, accelerationMps2: 0, angularVelocityRadps: 0, curvatureInvM: 0 };
});
const intervals = 300;
const input = {
  positions: Array.from({ length: intervals + 1 }, (_, i) => i / 30),
  velocityLimits: Array(intervals + 1).fill(4),
  accelerationLimits: Array(intervals).fill(3),
  decelerationLimits: Array(intervals).fill(3),
  freeSpeeds: Array(intervals).fill(5),
  accelerationConstraints: Array.from({ length: intervals }, () => [
    { uX: 1, uY: 0, xX: 0, xY: 0.1, limit: 3 },
    { uX: 1, uY: 0.1, xX: 0.02, xY: 0.2, limit: 4 },
  ]),
  scalarAccelerationConstraints: Array.from({ length: intervals }, () => [
    { u: 1, x: 0.03, minimum: -3, maximum: 3 },
  ]),
  startVelocity: 0,
  goalVelocity: 0,
};

function measure(name, run) {
  for (let i = 0; i < 3; i++) run();
  const times = [];
  let result;
  for (let i = 0; i < 7; i++) {
    const start = performance.now();
    result = run();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { name, medianMs: +times[3].toFixed(3), minMs: +times[0].toFixed(3), result };
}

console.log(JSON.stringify({ node: process.version, compiled, cases: [
  measure("heading lookup: 10001 anchors, 20000 queries", () => {
    let sum = 0;
    for (let i = 0; i < 20000; i++) sum += headingAt((i + 0.5) / 20000, anchors);
    return sum;
  }),
  measure("canonical state: 6000 stationary samples", () => {
    const state = buildCanonicalPathState(stationaryPath, samples);
    return state.points.reduce((sum, point) => sum + point.headingDerivativeRadPerM, 0);
  }),
  measure("reachability: 300 curved intervals", () => {
    const result = solveReachabilityProfile(input);
    if (result.status !== "optimal") throw new Error(result.reason ?? result.status);
    return result.velocities.reduce((sum, velocity) => sum + velocity, 0);
  }),
  measure("normal planning: captured rotation-target turn", () => {
    const result = getPlanner("profiledSpline").generate(turnInput);
    if (result.diagnostics.some((issue) => issue.severity === "error")) throw new Error("Captured turn failed planning");
    return { totalTimeS: result.totalTimeS, samples: result.samples.length };
  }),
] }, null, 2));
