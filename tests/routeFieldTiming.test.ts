import { describe, expect, it } from "vitest";
import { buildWaypoints, createDemoProject } from "../src/core/project/defaults";
import { ACTIVE_FIELD_REFERENCE } from "../src/core/field/rebuilt2026";
import { optimizeRouteFinal } from "../src/core/planners/routeFinal";
import { applyRoute, geometryFromPath } from "../src/core/planners/routeGeometry";
import { getPlanner } from "../src/core/planners";
import { routeCandidateFailure } from "../src/core/planners/routeValidation";
import { routeSafetyFailure } from "../src/core/planners/routeSafety";
import { decodeProjectFile, encodeProjectFile } from "../src/core/project/fileFormat";
import { buildBdxExport } from "../src/core/export/bdx";
import { PM } from "../src/core/math/pm";
import { effectiveRanges } from "../src/core/planners/rotationPriority";
import type { PlannerResult } from "../src/core/types";

function crossing() {
  const project = createDemoProject();
  const path = project.paths[0];
  path.waypoints = buildWaypoints([{ x: 7.0705, y: 1.4345 }, { x: -1.7295, y: 1.4345 }]);
  path.constraints.maxVel = 4.2;
  path.headingMode = "tangent";
  path.ranges = [];
  return { project, path, robot: project.robot };
}
function solve() {
  const { project, path, robot } = crossing();
  const original = structuredClone({ path, robot });
  const checkpoints: PlannerResult[] = [];
  // Real wall clock and ordinary common-tier deadline, never a frozen clock.
  const result = optimizeRouteFinal({ path, robot }, { maximumEvaluations: 3, budgetMs: 5000, onProgress: (p) => checkpoints.push(p) });
  expect(result.candidate, JSON.stringify(result.statistics)).toBeDefined();
  return { project, path, robot, result, candidate: result.candidate!, checkpoints, original };
}

describe("route field safety and authored timing", () => {
  it("retains configured full-speed BUMP traversal without an invented terrain cap", () => {
    const { path, robot, candidate, result, checkpoints, original } = solve();
    expect(robot.w).toBe(0.84);
    expect(robot.l).toBe(0.84);
    expect(path).toEqual(original.path);
    expect(robot).toEqual(original.robot);
    expect(candidate.optimizedPath!.constraints).toEqual(path.constraints);
    expect(candidate.optimizedPath!.ranges).toEqual(path.ranges);
    expect(candidate.samples.some((s) => s.velocityMps > 2.5)).toBe(true);
    expect(routeSafetyFailure(robot, candidate)).toBeUndefined();
    expect(routeCandidateFailure({ path, robot }, candidate)).toBeUndefined();
    expect(checkpoints.length).toBeGreaterThan(0);
    expect(checkpoints.every((p) => !routeCandidateFailure({ path, robot }, p))).toBe(true);
    expect(result.seedStatus).toBe("valid");
    expect(result.baseline).toBeDefined();
  });

  it("preserves an explicitly authored BUMP speed range", () => {
    const { path, robot } = crossing();
    path.ranges = [{ anchor: "param", f0: 0.2, f1: 0.6, maxVel: 2, name: "BUMP crossing" }];
    const original = structuredClone(path);
    const result = optimizeRouteFinal({ path, robot }, { maximumEvaluations: 3 });
    expect(result.candidate, JSON.stringify(result.statistics)).toBeDefined();
    expect(result.candidate!.optimizedPath!.ranges).toEqual(path.ranges);
    expect(result.candidate!.samples.filter((s) => s.f >= 0.2 && s.f <= 0.6).every((s) => Math.abs(s.velocityMps) <= 2 + 1e-6)).toBe(true);
    expect(path).toEqual(original);
  });

  it("writes the route into the path, which reopens and exports exactly, standalone too", () => {
    const { project, path, robot, candidate } = solve();
    project.paths = [applyRoute(path, candidate.routeGeometry!)];
    const reopened = decodeProjectFile(encodeProjectFile(project).contents).project;
    expect(reopened.paths[0].waypoints).toEqual(project.paths[0].waypoints);
    expect(buildBdxExport(reopened).paths[0].samples).toEqual(candidate.samples);
    const standalone = decodeProjectFile(JSON.stringify({ ...project.paths[0], version: "2.0", field: project.field, robot })).project;
    expect(buildBdxExport(standalone).paths[0].samples).toEqual(candidate.samples);
  });

  it.each(["id", "revision", "coordinateSchemaId"] as const)("rejects unsupported field %s before publishing or accepting any candidate", (key) => {
    const { path, robot, candidate } = solve();
    const field = { ...ACTIVE_FIELD_REFERENCE, [key]: "unsupported" };
    const progress: PlannerResult[] = [];
    const result = optimizeRouteFinal({ path, robot, field }, { onProgress: (p) => progress.push(p) });
    expect(result).toMatchObject({ status: "unsupported", statistics: { evaluations: 0 } });
    expect(result.candidate).toBeUndefined();
    expect(result.baseline).toBeUndefined();
    expect(result.reason).toMatch(/field revision/);
    expect(progress).toEqual([]);
    expect(routeCandidateFailure({ path, robot, field }, candidate)).toMatch(/field revision/);
    expect(routeCandidateFailure({ path, robot, field }, candidate, ACTIVE_FIELD_REFERENCE)).toMatch(/field revision/);
  });


  it("retains tangent headings, exact actions, events and authored ranges with solver knots", () => {
    const { path, robot } = crossing();
    path.waypoints[1] = { ...path.waypoints[1], stop: true, wait: 0.137, turnInPlace: { headingDeg: 270, direction: "counterclockwise" } };
    path.ranges = [{ anchor: "wp", w0: 0, t0: 0.8, w1: 1, f0: 0, f1: 1, maxVel: 0.8, maxAngVel: 30 }];
    path.markers = [{ id: "crossing", name: "Intake", cmd: "intake.collect", anchor: "dist", d: 4, f: 0 }];
    const original = structuredClone(path);
    const expanded = { ...path, waypoints: buildWaypoints([{ x: 7.0705, y: 1.4345 }, { x: 1.7705, y: 1.4345 }, { x: -1.7295, y: 1.4345 }]) };
    const geometry = { ...geometryFromPath(expanded), requiredPointIndices: [0, 2] };
    const planning = applyRoute(path, geometry);
    const raw = getPlanner("profiledSpline").generate({ path: planning, robot });
    const candidate = { ...raw, routeGeometry: geometry, optimizedPath: planning };
    expect(routeCandidateFailure({ path, robot }, candidate)).toBeUndefined();
    expect(candidate.samples.filter((s) => s.f > 0.81).every((s) => Math.abs(s.velocityMps) <= 0.8 + 1e-6)).toBe(true);
    expect(candidate.samples.filter((s) => s.f < 0.99).every((s) => Math.abs(Math.abs(s.headingRad) - Math.PI) < 1e-6)).toBe(true);
    expect(candidate.markers[0]).toMatchObject({ command: "intake.collect", fraction: 4 / candidate.totalDistanceM });
    const turn = candidate.stationaryActions!.find((a) => a.kind === "turn")!;
    const wait = candidate.stationaryActions!.find((a) => a.kind === "wait")!;
    // The stop is the path's third waypoint after Apply inserts one before it.
    expect(turn.waypointIndex).toBe(2);
    expect(turn.endTimeS - turn.startTimeS).toBeGreaterThanOrEqual(5.625);
    expect(wait.waypointIndex).toBe(2);
    expect(wait.endTimeS - wait.startTimeS).toBeCloseTo(0.137, 9);
    expect(path).toEqual(original);
  });

  it("resolves authored required-leg ranges consistently across generated knots", () => {
    const { path } = crossing();
    path.ranges = [{ anchor: "wp", w0: 0, t0: 0.8, w1: 1, f0: 0, f1: 1, maxVel: 0.8, maxAngVel: 30 }];
    const expanded = { ...path, waypoints: buildWaypoints([{ x: 7.0705, y: 1.4345 }, { x: 1.7705, y: 1.4345 }, { x: -1.7295, y: 1.4345 }]) };
    const geometry = { ...geometryFromPath(expanded), requiredPointIndices: [0, 2] };
    const planning = applyRoute(path, geometry);
    const sampled = PM.sample(planning.waypoints, 56);
    const ranges = PM.effectiveRanges(planning, sampled);
    // 80% of the way along the leg by distance, now inside the inserted waypoint's second segment.
    expect(ranges[0]).toMatchObject({ f1: 1, maxVel: 0.8, maxAngVel: 30 });
    expect(ranges[0].f0).toBeCloseTo(0.8, 4);
    const generated = sampled.pts.map((p, i) => ({ i, f: p.s / sampled.length, s: p.s, x: p.x, y: p.y, t: i, headingRad: 0, velocityMps: 0, accelerationMps2: 0, angularVelocityRadps: 0, curvatureInvM: 0 }));
    const timed = effectiveRanges(planning, generated, sampled.length, [0, 56, 112]);
    expect(timed[0].start).toBeCloseTo(0.8, 4);
    expect(timed[0].end).toBe(1);
    expect(timed.slice(1).map(({ start, end, maxVel }) => ({ f0: start, f1: end, maxVel })))
      .toEqual(ranges.slice(1).map(({ f0, f1, maxVel }) => ({ f0, f1, maxVel })));
    expect(timed.slice(1).every((r) => r.end < 0.8)).toBe(true);
  });
});
