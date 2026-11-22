import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { analyzePath } from "../src/core/agent/pathAnalysis";
import { buildRobotTrajectory } from "../src/core/export/robotTrajectory";
import { getPlanner } from "../src/core/planners";
import { buildCanonicalPathState } from "../src/core/planners/pathState";
import { preparePlannerInput } from "../src/core/planners/pipeline";
import { profiledSplineOptimizationSeed, profiledSplinePlanner } from "../src/core/planners/profiledSpline";
import { applyStationaryActions } from "../src/core/planners/stationaryActions";
import { orderedWaypointSampleIndices } from "../src/core/planners/waypointSamples";
import { buildWaypoints, createDemoProject } from "../src/core/project/defaults";
import type { BordeauxProject, PlannerResult, RobotCommandCatalog } from "../src/core/types";

const benchmark = process.env.BENCHMARK_WAYPOINT_INDEX === "1" ? it : it.skip;
const DEG = Math.PI / 180;

function project(waypoints: Parameters<typeof buildWaypoints>[0]): BordeauxProject {
  const project = createDemoProject();
  project.plannerId = "profiledSpline";
  const path = project.paths[0];
  path.id = "benchmark_path";
  project.editor = { ...project.editor, activePathId: path.id };
  project.routines[0].id = "benchmark_routine";
  project.activeRoutineId = project.routines[0].id;
  path.headingMode = "manual";
  path.waypoints = buildWaypoints(waypoints);
  return project;
}

/** Raw spline/index stress: 600 arrivals with a heading anchor on every one. */
function stressFixture(wait = false): BordeauxProject {
  const stress = project(Array.from({ length: 600 }, (_, index) => ({
    x: 0.7 + index / 599 * 16,
    y: 4 + Math.sin(index * 0.07) * 0.2,
    theta: index * 17 % 360,
    thetaOn: true,
    segType: "line" as const,
  })));
  if (wait) {
    stress.paths[0].waypoints.at(-1)!.stop = true;
    stress.paths[0].waypoints.at(-1)!.wait = 0.2;
  }
  return stress;
}

function turnFixture(): BordeauxProject {
  return project(Array.from({ length: 600 }, (_, index) => ({
    x: 0.7 + index / 599 * 16,
    y: 4,
    theta: 0,
    thetaOn: true,
    stop: true,
    turnInPlace: { headingDeg: 0, direction: "shortest" as const },
    segType: "line" as const,
  })));
}

/** A public planner/export case the coupled optimizer can certify. */
function publicFixture(wait = false): BordeauxProject {
  const count = 24;
  const fixture = project(Array.from({ length: count }, (_, index) => ({
    x: 0.7 + index / (count - 1) * 16,
    y: 4 + Math.sin(index * 0.7) * 0.6,
    theta: Math.round(90 * Math.sin(index * 0.5)),
    thetaOn: true,
    segType: "line" as const,
  })));
  if (wait) {
    for (const index of [11, count - 1]) {
      fixture.paths[0].waypoints[index].stop = true;
      fixture.paths[0].waypoints[index].wait = 0.3;
    }
  }
  return fixture;
}

const catalog: RobotCommandCatalog = {
  projectName: "BenchmarkRobot",
  sourceFileCount: 1,
  scannedAt: "2026-08-12T00:00:00.000Z",
  source: "generated",
  runtimeCommandCount: 0,
  generatedSchemaVersion: "1.0",
  catalogId: "benchmark-robot",
  supportVersion: "0.1.0",
  catalogHash: `sha256:${"a".repeat(64)}`,
  authoritative: true,
  warnings: [],
  commands: [],
};

/** Elapsed solver time is the only nondeterministic output; everything else is fingerprinted. */
function digest(value: unknown): string {
  const serialized = JSON.stringify(value, (key, item) => key === "solveTimeMs" ? undefined : item);
  return createHash("sha256").update(serialized ?? "undefined").digest("hex");
}

// Stationary actions run after a planner, from its wait-free planning input.
function rawStationary(fixture: BordeauxProject): PlannerResult {
  const { path, robot, planningInput } = preparePlannerInput({ path: fixture.paths[0], robot: fixture.robot });
  return applyStationaryActions(path, profiledSplinePlanner.generate(planningInput), robot);
}

function rawOperations() {
  const stress = stressFixture();
  const input = { path: stress.paths[0], robot: stress.robot };
  const spline = profiledSplinePlanner.generate(input);
  const seed = profiledSplineOptimizationSeed(input);
  const waitStress = stressFixture(true);
  const turns = turnFixture();
  return {
    spline: () => profiledSplinePlanner.generate(input),
    seedState: () => buildCanonicalPathState(input.path, seed.samples),
    state: () => buildCanonicalPathState(input.path, spline.samples),
    arrivals: () => orderedWaypointSampleIndices(input.path.waypoints, spline.samples),
    wait: () => rawStationary(waitStress),
    turns: () => rawStationary(turns),
  };
}

function publicOperations() {
  const plain = publicFixture();
  const waiting = publicFixture(true);
  return {
    plan: () => getPlanner("profiledSpline").generate({ path: plain.paths[0], robot: plain.robot }),
    wait: () => getPlanner("profiledSpline").generate({ path: waiting.paths[0], robot: waiting.robot }),
    analysis: () => analyzePath(plain, plain.paths[0].id),
    robot: () => buildRobotTrajectory(plain, catalog),
  };
}

function measure<T extends Record<string, () => unknown>>(operations: T) {
  const output = {} as { [K in keyof T]: { samplesMs: number[]; digest: string; result: ReturnType<T[K]> } };
  for (const name of Object.keys(operations) as Array<keyof T>) {
    operations[name]();
    const samplesMs: number[] = [];
    let result: unknown;
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      result = operations[name]();
      samplesMs.push(Number((performance.now() - started).toFixed(1)));
    }
    output[name] = { samplesMs, digest: digest(result), result: result as ReturnType<T[keyof T]> };
  }
  return output;
}

function summary(output: Record<string, { samplesMs: number[]; digest: string }>) {
  return Object.fromEntries(Object.entries(output).map(([name, entry]) => [name, { samplesMs: entry.samplesMs, digest: entry.digest }]));
}

function expectArrivals(result: PlannerResult, fixture: BordeauxProject) {
  const waypoints = fixture.paths[0].waypoints;
  const arrivals = result.waypointSampleIndices!;
  expect(arrivals).toHaveLength(waypoints.length);
  arrivals.forEach((index, waypointIndex) => {
    if (waypointIndex > 0) expect(index).toBeGreaterThan(arrivals[waypointIndex - 1]);
    expect(Math.hypot(result.samples[index].x - waypoints[waypointIndex].x, result.samples[index].y - waypoints[waypointIndex].y))
      .toBeLessThan(1e-4);
  });
}

benchmark("indexes 600 ordered waypoint arrivals and heading anchors", () => {
  const output = measure(rawOperations());
  const stress = stressFixture();
  const authored = output.spline.result.waypointSampleIndices!;
  expectArrivals(output.spline.result, stress);
  // Every independent lookup recovers the planner's own authored boundaries.
  expect(output.state.result.waypointSampleIndices).toEqual(authored);
  expect(output.seedState.result.waypointSampleIndices).toEqual(authored);
  expect(output.arrivals.result).toEqual(authored);
  const [terminalWait] = output.wait.result.stationaryActions ?? [];
  expect(output.wait.result.stationaryActions).toHaveLength(1);
  expect(terminalWait).toMatchObject({ kind: "wait", waypointIndex: 599 });
  expect(terminalWait.endTimeS - terminalWait.startTimeS).toBeGreaterThanOrEqual(0.2 - 1e-8);
  // Every turn already faces its outgoing heading: 600 stops are checked
  // for compatibility, no rotation is inserted, and each arrival is at rest.
  const turns = output.turns.result;
  expect(turns.stationaryActions ?? []).toEqual([]);
  expect(turns.diagnostics).toEqual([]);
  for (const index of turns.waypointSampleIndices!) expect(turns.samples[index].velocityMps).toBeCloseTo(0, 6);
  // Recorded 2026-10-08; identical with the previous exhaustive canonical
  // lookup and per-sample heading segment scan. The turn spline itself still
  // reproduces the earlier reviewed digest (bebd6619...) under the old projection.
  expect(Object.fromEntries(Object.entries(output).map(([name, entry]) => [name, entry.digest]))).toEqual({
    spline: "88b22d460157cc37dcfe76c32f7f30e87de9628da230dc418fdfc6d6adaf0daa",
    seedState: "54ac44dbd1ee69392629a07dee459004b29b36b8d418e69088505fe43ee11e0a",
    state: "cb3aaf7ff352e924dc568279778a881dd75471c965a20f8cd0d3fd2af843e238",
    arrivals: "1e3ed175f90d557fd835e332b4eb3563d95fc4e63da8c12b64396d0d00270187",
    wait: "15fa47e5ae5996a16fb044d52eba1a7e79bfc593928fe6972382e8faee761008",
    turns: "3f8461a65eec4d0009461d54ae459220a0fa34e61163c5cab4d18ab81c296506",
  });
  console.log(JSON.stringify(summary(output)));
}, 300_000);

benchmark("plans and exports a public coupled trajectory with physical outcomes", () => {
  const output = measure(publicOperations());
  const plain = publicFixture();
  const waiting = publicFixture(true);
  const { path } = preparePlannerInput({ path: plain.paths[0], robot: plain.robot });
  for (const [result, fixture] of [[output.plan.result, plain], [output.wait.result, waiting]] as const) {
    expect(result.diagnostics.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(result.optimization).toMatchObject({ fallback: false, constraintViolations: 0 });
    expect(result.samples.length).toBeLessThan(250_000);
    expectArrivals(result, fixture);
    for (let index = 1; index < result.samples.length; index += 1) {
      expect(result.samples[index].t).toBeGreaterThanOrEqual(result.samples[index - 1].t);
      expect(result.samples[index].s).toBeGreaterThanOrEqual(result.samples[index - 1].s - 1e-9);
    }
    for (const sample of result.samples) {
      expect(Math.abs(sample.velocityMps)).toBeLessThanOrEqual(path.constraints.maxVel + 1e-6);
      expect(Math.abs(sample.angularVelocityRadps)).toBeLessThanOrEqual(path.constraints.maxAngVel * DEG + 1e-6);
    }
  }
  // The interior stop also joins two manual heading laws by turning in place.
  const actions = output.wait.result.stationaryActions ?? [];
  expect(actions.map((action) => [action.kind, action.waypointIndex])).toEqual([["turn", 11], ["wait", 11], ["wait", 23]]);
  for (const action of actions.filter(({ kind }) => kind === "wait")) {
    expect(action.endTimeS - action.startTimeS).toBeGreaterThanOrEqual(0.3 - 1e-8);
  }
  expect(actions[0].endTimeS).toBeLessThanOrEqual(actions[1].startTimeS + 1e-8);
  expect(output.wait.result.totalTimeS).toBeGreaterThan(output.plan.result.totalTimeS + 0.6);
  expect(output.analysis.result.plannerDiagnostics.filter((issue) => issue.severity === "error")).toEqual([]);
  expect(output.analysis.result.totalTimeS).toBe(output.plan.result.totalTimeS);
  const exported = output.robot.result;
  expect(exported.pathCount).toBe(1);
  expect(exported.sampleCount).toBe(output.plan.result.samples.length);
  expect(exported.document.paths[0].samples).toEqual(output.plan.result.samples);
  expect(exported.document.paths[0].followSections.at(-1)!.endSample).toBe(exported.sampleCount - 1);
  // Recorded 2026-10-08; identical with the previous canonical lookup and
  // heading segment scan.
  expect(Object.fromEntries(Object.entries(output).map(([name, entry]) => [name, entry.digest]))).toEqual({
    plan: "744ec30b20bdb7e1557d7f69c6656d2422aeebb826a42a2bacec913981282d34",
    wait: "912b6f3910930488a61c31e7a7da20d0b518eaf7280ce5564923346cdf4a434e",
    analysis: "c1760783955b0022c2ef75583c05e7228d0480ff684d615c7422e12cd71d8889",
    robot: "ec71fd96d85ad2d1f7a81296874f2b07d055a725e255ce18fa4b130452eabaeb",
  });
  console.log(JSON.stringify(summary(output)));
}, 300_000);
