import { describe, expect, it } from "vitest";
import { buildWaypoints, createDemoProject } from "../src/shared/project/defaults";
import { ACTIVE_FIELD_REFERENCE } from "../src/shared/field/rebuilt2026";
import { optimizeRouteFinal } from "../src/shared/planners/routeFinal";
import { applyAcceptedRouteTrajectory, createAcceptedTrajectory, getAcceptedTrajectory } from "../src/shared/planners/acceptedTrajectory";
import { geometryFromPath, routePlanningPath, routeResultToSource } from "../src/shared/planners/routeGeometry";
import { routeCandidateFailure } from "../src/shared/planners/routeValidation";
import { routeSafetyFailure } from "../src/shared/planners/routeSafety";
import { decodeProjectFile, encodeProjectFile } from "../src/shared/project/fileFormat";
import { buildBdxExport } from "../src/shared/export/bdx";
import { PM } from "../src/shared/math/pm";
import { optimizeFixedGeometryFinal } from "../src/shared/planners/fixedGeometryFinal";
import { effectiveRanges } from "../src/shared/planners/rotationPriority";
import type { PlannerResult } from "../src/shared/types";

function crossing() {
  const project = createDemoProject();
  const path = project.paths[0];
  path.waypoints = buildWaypoints([{ x: 1.2, y: 2.6 }, { x: 10, y: 2.6 }]);
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

  it("retains exact v2 project and standalone reopen and BDX export", () => {
    const { project, path, robot, candidate } = solve();
    const sourceWaypoints = structuredClone(path.waypoints);
    path.optimization = { corridorM: 0.4 };
    const legacy = createAcceptedTrajectory(path, robot, optimizeFixedGeometryFinal({ path, robot }));
    path.optimization.accepted = legacy;
    project.paths = [applyAcceptedRouteTrajectory(path, robot, candidate)];
    expect(project.paths[0].waypoints).toEqual(sourceWaypoints);
    expect(project.paths[0].optimization!.legacyAccepted).toEqual(legacy);
    const reopened = decodeProjectFile(encodeProjectFile(project).contents).project;
    expect(reopened.paths[0].optimization!.legacyAccepted).toEqual(legacy);
    const selected = getAcceptedTrajectory(reopened.paths[0], reopened.robot, reopened.field)!;
    expect(selected).toEqual(candidate);
    expect(buildBdxExport(reopened).paths[0].samples).toEqual(candidate.samples);
    const standalone = decodeProjectFile(JSON.stringify({ ...project.paths[0], version: "2.1", field: project.field, robot })).project;
    expect(getAcceptedTrajectory(standalone.paths[0], standalone.robot, standalone.field)).toEqual(candidate);
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
    const selected = applyAcceptedRouteTrajectory(path, robot, candidate);
    expect(getAcceptedTrajectory(selected, robot, field)).toBeNull();
    expect(() => applyAcceptedRouteTrajectory(path, robot, candidate, field)).toThrow(/field revision/);
  });


  it("retains tangent headings, exact actions, events and authored ranges with solver knots", () => {
    const { path, robot } = crossing();
    path.waypoints[1] = { ...path.waypoints[1], stop: true, wait: 0.137, turnInPlace: { headingDeg: 90, direction: "counterclockwise" } };
    path.ranges = [{ anchor: "wp", w0: 0, t0: 0.8, w1: 1, f0: 0, f1: 1, maxVel: 0.8, maxAngVel: 30 }];
    path.markers = [{ id: "crossing", name: "Intake", cmd: "intake.collect", anchor: "dist", d: 4, f: 0 }];
    const original = structuredClone(path);
    const expanded = { ...path, waypoints: buildWaypoints([{ x: 1.2, y: 2.6 }, { x: 6.5, y: 2.6 }, { x: 10, y: 2.6 }]) };
    const geometry = { ...geometryFromPath(expanded), requiredPointIndices: [0, 2] };
    const planning = routePlanningPath(path, geometry);
    const raw = optimizeFixedGeometryFinal({ path: planning, robot });
    const candidate = routeResultToSource(raw, geometry, planning);
    expect(routeCandidateFailure({ path, robot }, candidate)).toBeUndefined();
    expect(candidate.samples.filter((s) => s.f > 0.81).every((s) => Math.abs(s.velocityMps) <= 0.8 + 1e-6)).toBe(true);
    expect(candidate.samples.filter((s) => s.f < 0.99).every((s) => Math.abs(s.headingRad) < 1e-6)).toBe(true);
    expect(candidate.markers[0]).toMatchObject({ command: "intake.collect", fraction: 4 / candidate.totalDistanceM });
    const turn = candidate.stationaryActions!.find((a) => a.kind === "turn")!;
    const wait = candidate.stationaryActions!.find((a) => a.kind === "wait")!;
    expect(turn.waypointIndex).toBe(1);
    expect(turn.endTimeS - turn.startTimeS).toBeGreaterThanOrEqual(5.625);
    expect(wait.waypointIndex).toBe(1);
    expect(wait.endTimeS - wait.startTimeS).toBeCloseTo(0.137, 9);
    expect(getAcceptedTrajectory(applyAcceptedRouteTrajectory(path, robot, candidate), robot)).toEqual(candidate);
    expect(path).toEqual(original);
  });

  it("resolves authored required-leg ranges consistently across generated knots", () => {
    const { path } = crossing();
    path.ranges = [{ anchor: "wp", w0: 0, t0: 0.8, w1: 1, f0: 0, f1: 1, maxVel: 0.8, maxAngVel: 30 }];
    const expanded = { ...path, waypoints: buildWaypoints([{ x: 1.2, y: 2.6 }, { x: 6.5, y: 2.6 }, { x: 10, y: 2.6 }]) };
    const geometry = { ...geometryFromPath(expanded), requiredPointIndices: [0, 2] };
    const planning = routePlanningPath(path, geometry);
    const sampled = PM.sample(planning.waypoints, 56);
    const ranges = PM.effectiveRanges(planning, sampled);
    expect(ranges[0]).toMatchObject({ f0: 0.8, f1: 1, maxVel: 0.8, maxAngVel: 30 });
    const generated = sampled.pts.map((p, i) => ({ i, f: p.s / sampled.length, s: p.s, x: p.x, y: p.y, t: i, headingRad: 0, velocityMps: 0, accelerationMps2: 0, angularVelocityRadps: 0, curvatureInvM: 0 }));
    const timed = effectiveRanges(planning, generated, sampled.length, [0, 56, 112]);
    expect(timed[0]).toMatchObject({ start: 0.8, end: 1 });
    expect(timed.slice(1).map(({ start, end, maxVel }) => ({ f0: start, f1: end, maxVel })))
      .toEqual(ranges.slice(1).map(({ f0, f1, maxVel }) => ({ f0, f1, maxVel })));
    expect(timed.slice(1).every((r) => r.end < 0.8)).toBe(true);
  });
});
