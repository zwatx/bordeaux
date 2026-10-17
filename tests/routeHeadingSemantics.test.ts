import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
// @ts-expect-error The production panel is an intentional JavaScript module.
import { OptimizationPanel } from "../src/renderer/components/OptimizationPanel";
import { PM } from "../src/shared/math/pm";
import { buildWaypoints, createDemoProject } from "../src/shared/project/defaults";
import { getPlanner } from "../src/shared/planners";
import { routeCandidates } from "../src/shared/planners/routeCandidates";
import { optimizeRouteFinal } from "../src/shared/planners/routeFinal";
import { geometryFromPath, routePlanningPath, routeResultToSource } from "../src/shared/planners/routeGeometry";
import { routeCandidateIssue } from "../src/shared/planners/routeValidation";
import type { PathDoc, PlannerInput, PlannerResult, RouteGeometry } from "../src/shared/types";

const corpus = JSON.parse(readFileSync(new URL("../benchmarks/planner-corpus/v1/corpus.bordeaux.json", import.meta.url), "utf8")) as { paths: PathDoc[] };
// Captured from the original pm.ts before extracting its anchor predicate.
const normalHashes: Record<string, string> = {
  "corpus-blue-table-trench": "4a7d57202c1d63d2adaa1a2e81a962339fae46f6b492d733b55018c3683c2416",
  "corpus-blue-away-bump": "5eb22b8863b56cdfcd5a930aa7fa5f83e93feffc68e8897653a2cd8ed438af48",
  "corpus-neutral-slalom": "421f54c2ab5deb1597edf2cb15f8d9ae60d7cfcac83fad0030e7083f71c1a2f6",
  "corpus-red-away-trench": "c516b7bf69ca857c31a296ed3a478265859635b044fb42dce19f502893593bab",
  "corpus-blue-table-bump": "be3f55a65baf1e4286071ebd3da6f5de7acc47f031ce5bf89ae004cd8dd8a27b"
};
const anchorHashes: Record<string, string> = {
  "manual-false": "9d1bd989a794a221cb878ac0f701c56e925ce6edce7321a17097c467206553f2",
  "manual-true": "5d1db22f52692a3f2803f0c3dfa35e68903cb503ba588c9aca05bc6bcec5f4e8",
  "tangent-turn-manual": "a6d86030cce7ee5eea7d280e7177f4d82f4613eb11536d5230448effcdfc68e3",
  "manual-tangent": "c08f77a86a4aeabd4f67374dd0994a14bc5d3459f882314626801ba9a89077c7",
  "targets-false": "f734ed11a29f72b65eff63a1a9e7cac7993d04a56168b6558198e4aaa619e0c9",
  "targets-true": "53724797ba2ff89b7a4aab277ebb37af4cf6f3964d98901f45c42f1b4c8340b0",
  "tangent-turn-targets": "a6d86030cce7ee5eea7d280e7177f4d82f4613eb11536d5230448effcdfc68e3",
  "targets-tangent": "2df9600accf0de54f9441b86818f9e12e950354ecd35e288a40a7f42fbdb692f"
};
const tangentPaths = corpus.paths.filter((p) => p.headingMode === "tangent");
const robot = createDemoProject().robot;
const corpusInput = (id: string): PlannerInput => ({ path: structuredClone(corpus.paths.find((p) => p.id === `corpus-${id}`)!), robot });

function normal(input: PlannerInput) {
  const raw = getPlanner("profiledSpline").generate(input);
  const geometry = geometryFromPath(input.path);
  return routeResultToSource({ ...raw, optimization: {
    plannerUsed: raw.planner, totalTimeS: raw.totalTimeS, maxVelocityMps: 0, maxAccelerationMps2: 0,
    constraintViolations: 0, solveTimeMs: 0, fallback: false, ...raw.optimization, status: "feasible",
  } }, geometry, routePlanningPath(input.path, geometry));
}

function straight(mode: PathDoc["headingMode"] = "manual"): PlannerInput {
  const path = createDemoProject().paths[0];
  path.waypoints = buildWaypoints([{ x: 6.5, y: 2 }, { x: 8, y: 2 }, { x: 10, y: 2 }]);
  path.headingMode = mode;
  return { path, robot };
}

function panel(input: PlannerInput, result: PlannerResult, seedStatus: string, baselineTime: number) {
  return renderToStaticMarkup(React.createElement(OptimizationPanel, {
    path: input.path, paths: [input.path], state: { running: false, paths: { [input.path.id]: { status: "success" } } },
    candidate: { finalTrajectory: result, routeSearch: { seedStatus } }, baselineTime,
    unitSystem: "metric", mode: "selected",
  }));
}

describe("route heading semantics match Normal", () => {
  it("preserves Normal samples and PM derivation across the anchor refactor", () => {
    const inputs: Record<string, PlannerInput> = {};
    for (const mode of ["manual", "targets"] as const) {
      for (const reverse of [false, true]) {
        const input = straight(mode);
        input.path.driveBackward = reverse;
        input.path.waypoints.forEach((w, i) => { w.thetaOn = i === 1; w.theta = 15 + i * 30; });
        inputs[`${mode}-${reverse}`] = input;
      }
      const input = straight("tangent");
      Object.assign(input.path.waypoints[1], { stop: true, thetaOn: true, theta: 90, segmentHeadingMode: mode,
        turnInPlace: { headingDeg: 90, direction: "counterclockwise" } });
      input.path.waypoints.at(-1)!.theta = 90;
      inputs[`tangent-turn-${mode}`] = input;
      const moving = straight(mode);
      moving.path.waypoints.forEach((w) => { w.thetaOn = true; w.theta = 30; });
      moving.path.waypoints[1].segmentHeadingMode = "tangent";
      inputs[`${mode}-tangent`] = moving;
    }
    for (const [id, input] of Object.entries(inputs)) {
      const samples = normal(input).samples;
      const derived = PM.derivePath(input.path, input.robot, 56);
      expect(createHash("sha256").update(JSON.stringify([samples, derived])).digest("hex")).toBe(anchorHashes[id]);
      expect(samples.length).toBeGreaterThan(2);
    }
  });

  it.each(tangentPaths.map((path) => [path.id, path] as const))("ignores hidden endpoint theta on unchanged %s", (_id, source) => {
    expect(tangentPaths).toHaveLength(5);
    const input = { path: structuredClone(source), robot };
    expect(input.path.waypoints[0].thetaOn).toBe(true);
    expect(input.path.waypoints.at(-1)!.thetaOn).toBe(true);
    const original = structuredClone(input.path);
    const actual = normal(input);
    const changed = structuredClone(input.path);
    const geometry = PM.sample(changed.waypoints, 56);
    changed.waypoints[0].theta = geometry.pts[0].heading * 180 / Math.PI;
    changed.waypoints.at(-1)!.theta = geometry.pts.at(-1)!.heading * 180 / Math.PI;
    const matching = normal({ ...input, path: changed });
    expect(matching.samples).toEqual(actual.samples);
    expect(input.path).toEqual(original);
    expect(createHash("sha256").update(JSON.stringify(actual.samples)).digest("hex")).toBe(normalHashes[source.id]);
    const issue = routeCandidateIssue(input, actual);
    expect(issue).toEqual(routeCandidateIssue({ ...input, path: changed }, matching));
    if (["corpus-blue-away-bump", "corpus-neutral-slalom", "corpus-blue-table-bump"].includes(source.id)) expect(issue).toBeUndefined();
    else expect(issue).toMatchObject({ concrete: true, message: expect.stringMatching(/clearance/) });
  });

  it.each(["blue-away-bump", "neutral-slalom", "blue-table-bump"])("compares stock %s to real Normal in the panel envelope", (id) => {
    const input = corpusInput(id), before = structuredClone(input.path);
    const expected = normal(input);
    const progress: PlannerResult[] = [];
    const search = optimizeRouteFinal(input, { onProgress: (p) => progress.push(p) });
    expect(search.seedStatus, JSON.stringify(search.statistics)).toBe("valid");
    expect(search.baseline!.samples).toEqual(expected.samples);
    expect(search.candidate).toBeDefined();
    expect(search.candidate!.totalTimeS).toBeLessThanOrEqual(expected.totalTimeS);
    for (const candidate of [...progress, search.candidate!]) {
      expect(routeCandidateIssue(input, candidate)).toBeUndefined();
      expect(candidate.optimization!.seedStatus).not.toBe("invalid");
      const markup = panel(input, candidate, candidate.optimization!.seedStatus!, expected.totalTimeS);
      expect(markup).not.toContain("Route found");
      if (candidate.totalTimeS > expected.totalTimeS - Math.max(0.02, expected.totalTimeS * 0.005)) {
        expect(markup).not.toContain("Apply optimized");
      }
    }
    if (id === "neutral-slalom") {
      expect(expected.totalTimeS).toBeCloseTo(2.663521, 5);
      expect(search.candidate!.optimization!.gainS).toBeGreaterThan(0.18);
      expect(panel(input, search.candidate!, search.seedStatus, expected.totalTimeS)).toMatch(/faster, [\d.]+%/);
    }
    if (id === "blue-away-bump") expect(expected.totalTimeS).toBeCloseTo(1.948, 3);
    expect(input.path).toEqual(before);
  }, 15_000);

  it("qualifies stock tank Normal without hidden theta handle constraints", () => {
    const input = corpusInput("blue-away-bump");
    input.robot = { ...robot, drive: "tank" };
    const original = normal(input);
    const mutated = structuredClone(input);
    mutated.path.waypoints.forEach((w) => { w.theta += 77; w.thetaOn = true; });
    expect(normal(mutated).samples).toEqual(original.samples);
    expect(routeCandidateIssue(input, original)).toBeUndefined();
    const search = optimizeRouteFinal(input);
    expect(search.seedStatus).toBe("valid");
    expect(search.candidate!.totalTimeS).toBeLessThanOrEqual(original.totalTimeS);
    expect(routeCandidates(input, () => false).next().value).toEqual(routeCandidates(mutated, () => false).next().value);
  }, 15_000);

  it("finds a route when the final leg looks at a point instead of the stored endpoint theta", () => {
    const input = corpusInput("blue-away-bump");
    input.path.headingMode = "manual";
    const lastLeg = input.path.waypoints.at(-2)!;
    lastLeg.segmentHeadingMode = "lookAt";
    lastLeg.segmentLookAt = { x: 8.27, y: 4.035 };
    const search = optimizeRouteFinal(input);
    expect(search.candidate, JSON.stringify(search.statistics)).toBeDefined();
    expect(routeCandidateIssue(input, search.candidate!)).toBeUndefined();
    expect(search.statistics.rejectionReasons.some((r) => /explicit required heading/.test(r.reason))).toBe(false);
    const end = search.candidate!.samples.at(-1)!;
    const delta = end.headingRad - Math.atan2(4.035 - end.y, 8.27 - end.x);
    expect(Math.atan2(Math.sin(delta), Math.cos(delta))).toBeCloseTo(0, 4);
  }, 15_000);

  it.each(["tangent", "lookAt", "tank"])("keeps every generated handle variant independent of hidden %s theta", (law) => {
    const input = straight("tangent");
    if (law === "tank") {
      input.robot = { ...robot, drive: "tank" };
      input.path.headingMode = "manual";
      input.path.waypoints[0].segmentHeadingMode = "targets";
    }
    if (law === "lookAt") input.path.waypoints.slice(0, -1).forEach((w) => { w.segmentHeadingMode = "lookAt"; w.segmentLookAt = { x: 12, y: 4 }; });
    const changed = structuredClone(input);
    changed.path.waypoints.forEach((w, i) => { w.thetaOn = true; w.theta = 45 + 30 * i; });
    expect(normal(changed).samples).toEqual(normal(input).samples);
    const candidates = [...routeCandidates(input, () => false)];
    expect(candidates.length).toBeGreaterThan(8);
    expect([...routeCandidates(changed, () => false)]).toEqual(candidates);
  });

  it.each(["manual", "targets"] as const)("requires %s endpoint theta even with thetaOn false, including swerve reverse", (mode) => {
    const input = straight(mode);
    input.path.driveBackward = true;
    input.path.waypoints.forEach((w) => { w.theta = 90; w.thetaOn = false; });
    const result = normal(input);
    expect(routeCandidateIssue(input, result)).toBeUndefined();
    expect(result.samples[0].headingRad).toBeCloseTo(3 * Math.PI / 2, 5);
    for (const index of [0, result.samples.length - 1]) {
      const bad = structuredClone(result);
      bad.samples[index].headingRad += 0.1;
      expect(routeCandidateIssue(input, bad)).toEqual({ message: "An explicit required heading was not met.", concrete: true });
    }
  });

  it.each(["manual", "targets"] as const)("does not impose outgoing %s turn-anchor theta on incoming tangent arrival", (mode) => {
    const input = straight("tangent");
    const middle = input.path.waypoints[1];
    Object.assign(middle, { stop: true, thetaOn: true, theta: 90, segmentHeadingMode: mode,
      turnInPlace: { headingDeg: 90, direction: "counterclockwise" } });
    input.path.waypoints.at(-1)!.theta = 90;
    const result = normal(input);
    expect(result.stationaryActions?.some((a) => a.kind === "turn")).toBe(true);
    const turn = result.stationaryActions!.find((a) => a.kind === "turn")!;
    expect(result.samples.find((s) => s.t === turn.startTimeS)!.headingRad).toBeCloseTo(0, 5);
    expect(result.samples.find((s) => s.t === turn.endTimeS)!.headingRad).toBeCloseTo(Math.PI / 2, 5);
    expect(routeCandidateIssue(input, result)).toBeUndefined();
    const bad = structuredClone(result);
    bad.samples.find((s) => s.t === turn.endTimeS)!.headingRad += 0.1;
    expect(routeCandidateIssue(input, bad)).toBeDefined();
  });

  it.each(["manual", "targets"] as const)("preserves incoming %s heading at a transition to tangent", (mode) => {
    const input = straight(mode);
    input.path.waypoints.forEach((w) => { w.thetaOn = true; w.theta = 30; });
    input.path.waypoints[1].segmentHeadingMode = "tangent";
    // The final endpoint's hidden theta does not constrain its tangent arrival.
    const result = normal(input);
    const arrival = result.waypointSampleIndices![1];
    expect(result.samples[arrival].headingRad).toBeCloseTo(Math.PI / 6, 5);
    expect(routeCandidateIssue(input, result)).toBeUndefined();
    const bad = structuredClone(result);
    bad.samples[arrival].headingRad += 0.1;
    expect(routeCandidateIssue(input, bad)).toEqual({ message: "An explicit required heading was not met.", concrete: true });
    const geometry: RouteGeometry = routeCandidates(input, () => false).next().value!;
    expect(geometry.knots[1].prevC.y).toBe(2);
    expect(geometry.knots[1].nextC.y).toBe(2);
  });

  it.each([false, true])("preserves visible tangent turn departure in every handle family with thetaOn=%s", (thetaOn) => {
    const input = straight("tangent");
    input.path.waypoints = buildWaypoints([{ x: 6.5, y: 2 }, { x: 8, y: 2, stop: true }, { x: 8, y: 4 }]);
    input.path.waypoints[0].nextC = { x: 7, y: 2 };
    Object.assign(input.path.waypoints[1], { thetaOn, theta: 172, prevC: { x: 7.5, y: 2 }, nextC: { x: 8, y: 2.6 },
      turnInPlace: { headingDeg: 90, direction: "counterclockwise" } });
    input.path.waypoints[2].prevC = { x: 8, y: 3.4 };
    const candidates: RouteGeometry[] = [...routeCandidates(input, () => false)];
    for (const candidate of candidates) {
      const knot = candidate.knots[candidate.requiredPointIndices[1]];
      expect(Math.atan2(knot.nextC.y - knot.y, knot.nextC.x - knot.x)).toBeCloseTo(Math.PI / 2, 6);
    }
    const result = normal(input);
    expect(routeCandidateIssue(input, result)).toBeUndefined();
    const bad = structuredClone(result);
    const turn = bad.stationaryActions!.find((a) => a.kind === "turn")!;
    bad.samples.find((s) => s.t === turn.endTimeS)!.headingRad += 0.1;
    expect(routeCandidateIssue(input, bad)).toBeDefined();
  });
});
