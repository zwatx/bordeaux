import corpus from "../benchmarks/planner-corpus/v2/corpus.bordeaux.json";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PM } from "../src/shared/math/pm";
import { buildWaypoints, createDemoProject } from "../src/shared/project/defaults";
import { estimateCorridorCandidate, type CorridorEstimate } from "../src/shared/planners/corridorProvisional";
import * as seed from "../src/shared/planners/profiledSpline";
import * as reachability from "../src/shared/planners/reachability";
import * as optimized from "../src/shared/planners/optimizedTrajectory";
import * as rotation from "../src/shared/planners/rotationPriority";
import * as stationary from "../src/shared/planners/stationaryActions";
import * as physical from "../src/shared/planners/trajectoryValidation";
import { canonicalPlanningInput } from "../src/shared/planners";
import type { PathDoc, PlannerInput, PlannerResult } from "../src/shared/types";

function straight(): PlannerInput {
  const project = createDemoProject(), path = project.paths[0];
  path.headingMode = "tangent";
  path.waypoints = buildWaypoints([{ x: 2, y: 2, segType: "line" }, { x: 8, y: 2 }]);
  return { path, robot: project.robot };
}
function ranked(result: CorridorEstimate) {
  expect(result.kind, JSON.stringify(result)).toBe("ranked");
  if (result.kind !== "ranked") throw new Error(result.reason);
  expect(Object.keys(result).sort()).toEqual(["density", "estimatedTimeS", "kind", "version"]);
  expect(Number.isFinite(result.estimatedTimeS)).toBe(true); expect(result.estimatedTimeS).toBeGreaterThan(0);
  return result.estimatedTimeS;
}
function unranked(result: CorridorEstimate) {
  expect(result.kind).toBe("unranked");
  if (result.kind !== "unranked") throw new Error("Unexpected ranked input");
  expect(Object.keys(result).sort()).toEqual(["density", "kind", "reason", "version"]);
  expect(result.reason.length).toBeGreaterThan(0); expect(result.version).toBe(1); return result;
}
function freeze(value: unknown) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.values(value).forEach(freeze); Object.freeze(value);
}
function trace() {
  return { actions: vi.spyOn(stationary, "applyStationaryActions"), validation: vi.spyOn(physical, "validateOptimizedTrajectory") };
}
afterEach(() => vi.restoreAllMocks());

describe("private single-pass corridor timing estimate", () => {
  it.each([undefined, 14, 28, 112])("ranks at the actual caller/default density %s using one raw derivation and solve, with no authoritative work", density => {
    const input = { ...straight(), samplesPerSegment: density }, before = structuredClone(input);
    const raw = vi.spyOn(seed, "profiledSplineOptimizationSeed"), derive = vi.spyOn(PM, "derivePath"), solve = vi.spyOn(reachability, "solveReachabilityProfile");
    const rounded = vi.spyOn(seed.profiledSplinePlanner, "generate"), final = vi.spyOn(optimized.optimizedTrajectoryPlanner, "generate"), dense = vi.spyOn(optimized, "buildDenseValidationSamples");
    const { actions, validation } = trace();
    const result = estimateCorridorCandidate(input); ranked(result); expect(result).toMatchObject({ version: 1, density: density ?? 56 });
    expect(raw).toHaveBeenCalledOnce(); expect(derive).toHaveBeenCalledOnce(); expect(derive.mock.calls[0][2]).toBe(density ?? 56);
    expect(solve).toHaveBeenCalledOnce(); expect(rounded).not.toHaveBeenCalled(); expect(final).not.toHaveBeenCalled(); expect(dense).not.toHaveBeenCalled();
    expect(actions).toHaveBeenCalledOnce(); expect(validation).toHaveBeenCalledOnce();
    const local = actions.mock.results[0].value as PlannerResult;
    expect(local.optimization).toBeUndefined(); expect(local.markers).toEqual([]);
    expect(validation.mock.calls[0][1]).toBe(local.samples); expect(validation.mock.calls[0][2]).toEqual({ angularKinematics: "sample" });
    expect(validation.mock.results[0].value.violations).toEqual([]); expect(ranked(result)).toBe(local.samples.at(-1)!.t);
    expect(input).toEqual(before);
  });
  it("leaves a density-1 zero-speed moving interval unranked instead of using the retiming speed floor", () => {
    const input = { ...straight(), samplesPerSegment: 1 };
    input.path.startVel = 0; input.path.goalVel = 0;
    const solve = vi.spyOn(reachability, "solveReachabilityProfile"), actions = vi.spyOn(stationary, "applyStationaryActions");
    const result = unranked(estimateCorridorCandidate(input));
    expect(result.density).toBe(1); expect(solve).toHaveBeenCalledOnce();
    expect(solve.mock.results[0].value.status).toBe("invalid-input");
    expect(result.reason).toContain("moving sample between stopped boundaries"); expect(actions).not.toHaveBeenCalled();
  });
  it("uses only the raw single pass on the unchanged known neutral slalom corpus geometry", () => {
    const path = structuredClone(corpus.paths.find(path => path.id === "corpus-neutral-slalom")!) as PathDoc;
    const input = { path, robot: straight().robot }, before = structuredClone(input);
    const derive = vi.spyOn(PM, "derivePath"), solve = vi.spyOn(reachability, "solveReachabilityProfile");
    const final = vi.spyOn(optimized.optimizedTrajectoryPlanner, "generate"), dense = vi.spyOn(optimized, "buildDenseValidationSamples"), { validation } = trace();
    ranked(estimateCorridorCandidate(input));
    expect(derive).toHaveBeenCalledOnce(); expect(solve).toHaveBeenCalledOnce(); expect(final).not.toHaveBeenCalled(); expect(dense).not.toHaveBeenCalled();
    expect(validation.mock.results[0].value.violations).toEqual([]); expect(input).toEqual(before);
  });
  it("is deterministic and ranks a longer or slower straight traversal behind the original", () => {
    const input = straight(), value = estimateCorridorCandidate(input);
    expect(estimateCorridorCandidate(input)).toEqual(value);
    const longer = structuredClone(input); longer.path.waypoints = buildWaypoints([{ x: 2, y: 2, segType: "line" }, { x: 12, y: 2 }]);
    const slower = structuredClone(input); slower.path.constraints.maxVel = .5;
    expect(ranked(estimateCorridorCandidate(longer))).toBeGreaterThan(ranked(value)); expect(ranked(estimateCorridorCandidate(slower))).toBeGreaterThan(ranked(value));
  });
  it("keeps exact endpoint velocities and inserted off-grid zone knots in the sampled physical check", () => {
    const input = straight(); input.path.startVel = .3; input.path.goalVel = .4;
    input.path.ranges = [{ anchor: "param", f0: .173, f1: .659, maxVel: .7 }];
    const { actions, validation } = trace(); ranked(estimateCorridorCandidate(input));
    const local = actions.mock.results[0].value as PlannerResult;
    expect(local.samples[0].velocityMps).toBe(.3); expect(local.samples.at(-1)!.velocityMps).toBe(.4);
    for (const f of [.173, .659]) expect(local.samples.some(point => Math.abs(point.f - f) < 1e-12)).toBe(true);
    expect(validation.mock.results[0].value.violations).toEqual([]);
  });
  it("keeps off-grid target headings as hard knots in the real moving estimate", () => {
    const input = straight(); input.path.headingMode = "targets"; input.path.constraints.maxVel = .5;
    input.path.targets = [{ f: .173, deg: 10 }, { f: .659, deg: 20 }]; input.path.waypoints[1].theta = 30;
    const { actions, validation } = trace(); ranked(estimateCorridorCandidate(input));
    const local = actions.mock.results[0].value as PlannerResult;
    for (const target of input.path.targets) {
      const knot = local.samples.find(sample => Math.abs(sample.f - target.f) < 1e-12)!;
      expect(knot).toBeDefined(); expect(knot.headingRad).toBeCloseTo(target.deg * Math.PI / 180, 10);
    }
    expect(validation.mock.results[0].value.violations).toEqual([]);
  });
  it("retains canonical legacy removal and actual robot hard limits without mutating the authored inputs", () => {
    const input = straight(); input.path.ranges = [{ anchor: "param", f0: .1, f1: .9, rotationPriority: "translation" }];
    input.path.waypoints[0].headingTransition = { placement: "after", distanceM: .75, rotationPriority: "translation" };
    input.robot.driveModel = { motorId: "custom", motorFreeRpm: 4000, motorMaxTorqueNm: 3.6, motorCount: 4, gearRatio: 8, wheelDiameterM: .1,
      massKg: 54, moiKgM2: 6.35, wheelbaseM: .66, trackwidthM: .66, wheelFrictionCoefficient: 1.2 };
    const before = structuredClone(input), expected = canonicalPlanningInput(input), raw = vi.spyOn(seed, "profiledSplineOptimizationSeed");
    ranked(estimateCorridorCandidate(input)); expect(raw.mock.calls[0][0]).toEqual(expected.planningInput); expect(input).toEqual(before);
  });
  it("uses real stop and fractional-wait expansion, and never carries stale marker times into retiming", () => {
    const input = straight(); input.path.waypoints[1].stop = true;
    const base = ranked(estimateCorridorCandidate(input)); input.path.waypoints[1].wait = .375;
    input.path.markers = [{ id: "finish", name: "Finish", f: 1, invocation: { commandId: "team.command", arguments: { count: "9007199254740993" } } }];
    const before = structuredClone(input), { actions, validation } = trace(), rotate = vi.spyOn(rotation, "applyRotationPriority"); freeze(input);
    const time = ranked(estimateCorridorCandidate(input)), local = actions.mock.results[0].value as PlannerResult;
    expect(time - base).toBeCloseTo(.375, 12); expect(local.stationaryActions).toHaveLength(1);
    const wait = local.stationaryActions![0]; expect(wait.kind).toBe("wait"); expect(wait.endTimeS - wait.startTimeS).toBeCloseTo(.375, 12);
    expect(local.samples.at(-1)!.velocityMps).toBe(0); expect(rotate.mock.calls[0][1].markers).toEqual([]); expect(local.markers).toEqual([]);
    expect(validation.mock.results[0].value.violations).toEqual([]); expect(input).toEqual(before);
  });
  it.each([false, true])("includes a real terminal turn and reverse heading semantics, reverse=%s", reverse => {
    const input = straight(); input.path.driveBackward = reverse; input.path.waypoints[1].stop = true;
    const base = ranked(estimateCorridorCandidate(input)); input.path.waypoints[1].turnInPlace = { headingDeg: 90, direction: "shortest" };
    const { actions, validation } = trace(); const time = ranked(estimateCorridorCandidate(input)), local = actions.mock.results[0].value as PlannerResult;
    const turn = local.stationaryActions!.find(action => action.kind === "turn")!; expect(turn).toBeDefined();
    expect(time - base).toBeCloseTo(turn.endTimeS - turn.startTimeS, 10);
    expect(local.samples[0].headingRad).toBeCloseTo(reverse ? Math.PI : 0, 10); expect(local.samples.at(-1)!.headingRad).toBeCloseTo((reverse ? Math.PI : 0) + Math.PI / 2, 10);
    expect(validation.mock.results[0].value.violations).toEqual([]);
  });
  it("retains an implicit turn at independent stopped incoming/outgoing tangents", () => {
    const input = straight(); input.path.waypoints = buildWaypoints([
      { x: 2, y: 2, segType: "bezier", segmentHeadingMode: "tangent", nextC: { x: 3, y: 2 } },
      { x: 5, y: 2, stop: true, segType: "bezier", segmentHeadingMode: "tangent", prevC: { x: 4, y: 2 }, nextC: { x: 5, y: 3 } },
      { x: 5, y: 5, prevC: { x: 5, y: 4 } },
    ]);
    const before = structuredClone(input), { actions, validation } = trace(); ranked(estimateCorridorCandidate(input));
    const local = actions.mock.results[0].value as PlannerResult;
    expect(local.waypointSampleIndices).toHaveLength(3); expect(local.stationaryActions).toContainEqual(expect.objectContaining({ kind: "turn", waypointIndex: 1 }));
    expect(local.samples[local.waypointSampleIndices![1]].velocityMps).toBe(0); expect(local.samples.at(-1)!.headingRad).toBeCloseTo(Math.PI / 2, 8);
    expect(validation.mock.results[0].value.violations).toEqual([]); expect(input).toEqual(before);
  });
  it.each(["tank", "lookAt"] as const)("keeps actual %s heading constraints in the single-pass estimate", mode => {
    const input = straight();
    if (mode === "tank") input.robot.drive = "tank";
    else { input.path.waypoints[0].segmentHeadingMode = "lookAt"; input.path.waypoints[0].segmentLookAt = { x: 9, y: 7 }; input.path.constraints.maxVel = .5; }
    const { actions, validation } = trace(); ranked(estimateCorridorCandidate(input));
    const local = actions.mock.results[0].value as PlannerResult; expect(validation.mock.results[0].value.violations).toEqual([]);
    if (mode === "lookAt") expect(Math.abs(local.samples.at(-1)!.headingRad - local.samples[0].headingRad)).toBeGreaterThan(.4);
    else expect(local.samples.every(sample => Math.abs(sample.headingRad) < 1e-10)).toBe(true);
  });
  it.each([0, -1, 1.5, NaN, Infinity, 250000])("returns unranked for invalid/over-limit density %s before deriving geometry", density => {
    const derive = vi.spyOn(PM, "derivePath"), solve = vi.spyOn(reachability, "solveReachabilityProfile");
    const result = unranked(estimateCorridorCandidate({ ...straight(), samplesPerSegment: density })); expect(result.density).toBe(density);
    expect(derive).not.toHaveBeenCalled(); expect(solve).not.toHaveBeenCalled();
  });
  it.each<[string, (input: PlannerInput) => void]>([
    ["unfinished", (input: PlannerInput) => { input.path.waypoints = []; }],
    ["nonfinite geometry", (input: PlannerInput) => { input.path.waypoints[0].x = NaN; }],
    ["nonfinite angular limit", (input: PlannerInput) => { input.path.constraints.maxAngDecel = NaN; }],
    ["invalid wait", (input: PlannerInput) => { input.path.waypoints[1].wait = -1; }],
    ["zero speed", (input: PlannerInput) => { input.robot.maxSpeed = 0; }],
    ["jiggle unsupported", (input: PlannerInput) => { input.path.waypoints[1].stop = true; input.path.waypoints[1].jiggle = { distanceM: .1, strokes: 2, startDeg: 0, stepDeg: 180, strokeTimeS: .3 }; }],
  ])("returns only unavailable ranking for %s", (_label, edit) => {
    const input = straight(); edit(input); const before = structuredClone(input); unranked(estimateCorridorCandidate(input)); expect(input).toEqual(before);
  });
  it("rejects jiggle before any raw derive or reachability work", () => {
    const input = straight(); input.path.waypoints[1].stop = true;
    input.path.waypoints[1].jiggle = { distanceM: .1, strokes: 2, startDeg: 0, stepDeg: 180, strokeTimeS: .3 };
    const derive = vi.spyOn(PM, "derivePath"), solve = vi.spyOn(reachability, "solveReachabilityProfile");
    expect(unranked(estimateCorridorCandidate(input)).reason).toContain("Jiggle"); expect(derive).not.toHaveBeenCalled(); expect(solve).not.toHaveBeenCalled();
  });
  it("returns unranked on an actual incompatible interior-turn diagnostic after action expansion", () => {
    const input = straight(); input.path.waypoints = buildWaypoints([
      { x: 2, y: 2, segType: "line" }, { x: 5, y: 2, stop: true, segType: "line", turnInPlace: { headingDeg: 90, direction: "shortest" } }, { x: 8, y: 2 },
    ]);
    const { actions } = trace();
    expect(unranked(estimateCorridorCandidate(input)).reason).toContain("Interior turn heading");
    expect(actions).toHaveBeenCalledOnce(); expect(actions.mock.results[0].value.diagnostics.some((issue: any) => issue.severity === "error")).toBe(true);
  });
  it.each([null, { path: null }, { ...straight(), robot: null }])("does not throw on malformed input shape %#", input => {
    unranked(estimateCorridorCandidate(input as unknown as PlannerInput));
  });
  it("keeps the narrow numeric result shape even for a malformed nonnumeric density", () => {
    const input = { ...straight(), samplesPerSegment: "28" } as unknown as PlannerInput, derive = vi.spyOn(PM, "derivePath");
    const result = unranked(estimateCorridorCandidate(input)); expect(typeof result.density).toBe("number"); expect(derive).not.toHaveBeenCalled();
  });
  it.each(["missing samples", "nonfinite time", "nonmonotonic time", "wrong index"])("refuses %s from actual postprocessing without a second solve", corruption => {
    const apply = stationary.applyStationaryActions;
    vi.spyOn(stationary, "applyStationaryActions").mockImplementationOnce((...args) => {
      const value = apply(...args);
      if (corruption === "missing samples") return { ...value, samples: [] };
      return { ...value, samples: value.samples.map((sample, i) => i !== 1 ? sample : { ...sample,
        ...(corruption === "nonfinite time" ? { t: NaN } : corruption === "nonmonotonic time" ? { t: 0 } : { i: 12 }) }) };
    });
    const solve = vi.spyOn(reachability, "solveReachabilityProfile"), validation = vi.spyOn(physical, "validateOptimizedTrajectory");
    unranked(estimateCorridorCandidate(straight())); expect(solve).toHaveBeenCalledOnce(); expect(validation).not.toHaveBeenCalled();
  });
  it("returns unranked for a real unsuccessful reachability solve instead of certifying impossibility", () => {
    const input = straight(); input.path.waypoints = buildWaypoints([{ x: 2, y: 2, segType: "line" }, { x: 2.001, y: 2 }]); input.path.startVel = 4;
    const solve = vi.spyOn(reachability, "solveReachabilityProfile"); unranked(estimateCorridorCandidate(input));
    expect(solve).toHaveBeenCalledOnce(); expect(solve.mock.results[0].value.status).not.toBe("optimal");
  });
  it("returns unranked on a real seed diagnostic or thrown computation rather than hiding it", () => {
    const input = straight(); input.path.waypoints[0].segmentHeadingMode = "lookAt"; input.path.waypoints[0].segmentLookAt = { x: 4, y: 2 };
    const raw = vi.spyOn(seed, "profiledSplineOptimizationSeed"); unranked(estimateCorridorCandidate(input));
    expect(raw.mock.results[0].value.diagnostics.some((issue: any) => issue.severity === "error")).toBe(true);
    vi.spyOn(PM, "derivePath").mockImplementationOnce(() => { throw new Error("Geometry failed"); });
    expect(unranked(estimateCorridorCandidate(straight())).reason).toContain("Geometry failed");
  });
  it("refuses malformed helper output and real sampled violations without a recovery/final solve", () => {
    const input = straight(), raw = seed.profiledSplineOptimizationSeed(input);
    vi.spyOn(seed, "profiledSplineOptimizationSeed").mockReturnValueOnce({ ...raw, samples: raw.samples.map((sample, i) => i === 1 ? { ...sample, x: NaN } : sample) });
    unranked(estimateCorridorCandidate(input));
    const apply = stationary.applyStationaryActions;
    vi.spyOn(stationary, "applyStationaryActions").mockImplementationOnce((...args) => {
      const value = apply(...args); return { ...value, samples: value.samples.map((sample, i) => i === 1 ? { ...sample, velocityMps: 99 } : sample) };
    });
    const validation = vi.spyOn(physical, "validateOptimizedTrajectory"), solve = vi.spyOn(reachability, "solveReachabilityProfile");
    unranked(estimateCorridorCandidate(input)); expect(solve).toHaveBeenCalledOnce();
    expect(validation.mock.results[0].value.violations.length).toBeGreaterThan(0);
  });
});
