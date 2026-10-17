import { describe, expect, it, vi } from "vitest";
import { buildWaypoints, createDemoProject } from "../src/shared/project/defaults";
import { decodeProjectFile, encodeProjectFile } from "../src/shared/project/fileFormat";
import { optimizeRouteFinal } from "../src/shared/planners/routeFinal";
import { applyAcceptedRouteTrajectory, createAcceptedTrajectory, getAcceptedTrajectory, selectPathTrajectory } from "../src/shared/planners/acceptedTrajectory";
import { routeInputKey, routeIntentKey } from "../src/shared/planners/routeIdentity";
import { routeCandidateFailure } from "../src/shared/planners/routeValidation";
import { getPlanner } from "../src/shared/planners";
import { optimizeCorridorFinal } from "../src/shared/planners/corridorFinal";
import { optimizeFixedGeometryFinal } from "../src/shared/planners/fixedGeometryFinal";
import { routeSafetyFailure } from "../src/shared/planners/routeSafety";
import { geometryFromPath, routePlanningPath, routeResultToSource } from "../src/shared/planners/routeGeometry";
import { observeRobotFieldPortalSequence } from "../src/shared/agent/fieldClearance";
import { buildBdxExport } from "../src/shared/export/bdx";
import { PM } from "../src/shared/math/pm";
import type { PathDoc, PlannerResult } from "../src/shared/types";

function fixture(points = [{ x: 6.5, y: 2 }, { x: 10, y: 2 }]) {
  const project = createDemoProject();
  project.robot = { ...project.robot, w: 0.4, l: 0.4, heightM: 0.5 };
  const path = project.paths[0];
  path.waypoints = buildWaypoints(points);
  path.headingMode = "manual";
  path.constraints.maxVel = 1.5;
  return { project, path, robot: project.robot };
}
function solve(path: PathDoc, robot = fixture().robot, maximumEvaluations = 12) {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  try { return optimizeRouteFinal({ path, robot }, { maximumEvaluations }); } finally { clock.mockRestore(); }
}

describe("waypoint-defined route search", () => {
  it("chooses full handle vectors more than 1.5 m from a poor drawn seed", () => {
    const { path, robot } = fixture();
    path.waypoints[0].nextC = { x: 6.5, y: 7 };
    path.waypoints[1].prevC = { x: 10, y: 7 };
    const original = structuredClone(path);
    const result = solve(path, robot, 3);
    expect(result.candidate, JSON.stringify(result.statistics)).toBeDefined();
    expect(result.candidate!.routeGeometry!.knots[0].nextC.y).toBe(2);
    expect(Math.max(...PM.sample(path.waypoints, 128).pts.map((p) => p.y)) - 2).toBeGreaterThan(1.5);
    expect(result.candidate!.totalDistanceM).toBeCloseTo(3.5, 4);
    expect(path).toEqual(original);
    expect(routeCandidateFailure({ path, robot }, result.candidate!)).toBeUndefined();
  });

  it("repairs an invalid seed without fabricating a baseline or gain", () => {
    const { path, robot } = fixture();
    path.waypoints[0].nextC.y = 20;
    path.waypoints[1].prevC.y = 20;
    const result = solve(path, robot, 3);
    expect(result.candidate, JSON.stringify(result.statistics)).toBeDefined();
    expect(result.baseline).toBeUndefined();
    expect(result.candidate!.optimization!.baselineTimeS).toBeUndefined();
    expect(result.candidate!.optimization!.gainS).toBeUndefined();
    const applied = applyAcceptedRouteTrajectory(path, robot, result.candidate!);
    expect(getAcceptedTrajectory(applied, robot)).toEqual(result.candidate);
  });

  it("finds a solver-knot detour from a seed crossing the HUB and a legal portal", () => {
    const { path, robot } = fixture([{ x: 2.7, y: 4.1 }, { x: 6.6, y: 4.1 }]);
    const result = solve(path, robot, 14);
    expect(result.candidate, JSON.stringify(result.statistics)).toBeDefined();
    expect(result.baseline).toBeUndefined();
    expect(result.candidate!.routeGeometry!.knots.length).toBeGreaterThan(path.waypoints.length);
    expect(result.candidate!.routeGeometry!.requiredPointIndices).toEqual([0, result.candidate!.routeGeometry!.knots.length - 1]);
    expect(observeRobotFieldPortalSequence(robot, result.candidate!.samples).valid).toBe(true);
    expect(observeRobotFieldPortalSequence(robot, result.candidate!.samples).visits.length).toBeGreaterThan(0);
    expect(routeCandidateFailure({ path, robot }, result.candidate!)).toBeUndefined();
  }, 30_000);

  it("preserves required headings, stopped waits, command events and leg-local ranges", () => {
    const { path, robot } = fixture([{ x: 6.5, y: 2 }, { x: 8, y: 2 }, { x: 10, y: 2 }]);
    path.waypoints[1] = { ...path.waypoints[1], stop: true, thetaOn: true, theta: 30, wait: 0.137 };
    path.markers = [{ id: "command-event", name: "Intake", cmd: "intake.collect", group: "parallel", f: 0.25, anchor: "param" }];
    path.ranges = [{ anchor: "wp", w0: 0, t0: 0.5, w1: 1, t1: 0.5, f0: 0, f1: 1, maxVel: 0.7 }];
    const result = solve(path, robot, 3);
    expect(result.candidate, JSON.stringify(result.statistics)).toBeDefined();
    expect(result.candidate!.markers[0]).toMatchObject({ id: "command-event", command: "intake.collect", group: "parallel", fraction: 0.25 });
    expect(result.candidate!.stationaryActions).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "wait", waypointIndex: 1 })]));
    const index = result.candidate!.waypointSampleIndices![1];
    expect(result.candidate!.samples[index].headingRad).toBeCloseTo(Math.PI / 6, 3);
    expect(result.candidate!.samples[index].velocityMps).toBe(0);
    expect(result.candidate!.optimizedPath!.ranges).toEqual(path.ranges);
    expect(routeCandidateFailure({ path, robot }, result.candidate!)).toBeUndefined();
  }, 30_000);

  it("resolves leg-local ranges and stationary turns across generated knots", () => {
    const { path, robot } = fixture([{ x: 2.7, y: 4.1 }, { x: 6.6, y: 4.1 }]);
    path.waypoints[1] = { ...path.waypoints[1], stop: true, wait: 0.137, turnInPlace: { headingDeg: 90, direction: "counterclockwise" } };
    path.ranges = [{ anchor: "wp", w0: 0, t0: 0.5, w1: 1, f0: 0, f1: 1, maxVel: 0.6, maxAngVel: 30 }];
    const result = solve(path, robot, 12);
    expect(result.candidate, JSON.stringify(result.statistics)).toBeDefined();
    const candidate = result.candidate!;
    expect(candidate.routeGeometry!.knots.length).toBeGreaterThan(2);
    const planning = routePlanningPath(path, candidate.routeGeometry!);
    const sample = PM.sample(planning.waypoints, 128);
    expect(PM.effectiveRanges(planning, sample)[0]).toMatchObject({ f0: 0.5, f1: 1, maxVel: 0.6 });
    expect(candidate.samples.filter((s) => s.f > 0.51).every((s) => Math.abs(s.velocityMps) <= 0.601)).toBe(true);
    const turn = candidate.stationaryActions!.find((a) => a.kind === "turn")!;
    expect(turn.waypointIndex).toBe(1);
    expect(turn.endTimeS - turn.startTimeS).toBeGreaterThanOrEqual(5.625);
    const applied = applyAcceptedRouteTrajectory(path, robot, candidate);
    expect(getAcceptedTrajectory(applied, robot)).toEqual(candidate);
    const tampered = structuredClone(applied);
    const action = tampered.optimization!.accepted!.result.stationaryActions!.find((a) => a.kind === "turn")!;
    const moving = tampered.optimization!.accepted!.result.samples.find((s) => s.t > action.startTimeS + 0.1 && s.t < action.endTimeS)!;
    moving.headingRad += 0.1;
    expect(getAcceptedTrajectory(tampered, robot)).toBeNull();
  }, 30_000);

  it("can choose a different legal portal from the drawn seed", () => {
    const { path, robot } = fixture([{ x: 2.7, y: 4.1 }, { x: 6.6, y: 4.1 }]);
    path.waypoints[0].nextC = { x: 3.5, y: 1.8 };
    path.waypoints[1].prevC = { x: 5.8, y: 1.8 };
    const original = getPlanner("profiledSpline").generate({ path, robot });
    const seedPortals = observeRobotFieldPortalSequence(robot, original.samples);
    const result = solve(path, robot, 14);
    expect(result.candidate, JSON.stringify(result.statistics)).toBeDefined();
    const selectedPortals = observeRobotFieldPortalSequence(robot, result.candidate!.samples);
    expect(seedPortals.valid).toBe(true);
    expect(selectedPortals.valid).toBe(true);
    expect(selectedPortals.visits.map((p) => p.id)).not.toEqual(seedPortals.visits.map((p) => p.id));
  }, 30_000);

  it("rejects too-tall or unknown-height trench use while permitting a different legal route", () => {
    const { path, robot } = fixture([{ x: 2.7, y: 0.55 }, { x: 6.6, y: 0.55 }]);
    const low = solve(path, robot, 2).candidate!;
    expect(low).toBeDefined();
    expect(observeRobotFieldPortalSequence(robot, low.samples).visits[0].id).toMatch(/trench/);
    expect(routeCandidateFailure({ path, robot: { ...robot, heightM: 0.8 } }, low)).toMatch(/clearance/);
    expect(routeCandidateFailure({ path, robot: { ...robot, heightM: undefined } }, low)).toMatch(/clearance/);
    const high = solve(path, { ...robot, heightM: 0.8 }, 14);
    expect(high.candidate, JSON.stringify(high.statistics)).toBeDefined();
    expect(observeRobotFieldPortalSequence(robot, high.candidate!.samples).visits.every((p) => !p.id.includes("trench"))).toBe(true);
  }, 30_000);

  it("preserves legacy artifacts and values durably when explicitly applying a route", () => {
    const { project, path, robot } = fixture();
    path.optimization = { corridorM: 0.4 };
    const legacyResult = optimizeCorridorFinal({ path, robot }, { maximumEvaluations: 1, corridorM: 0.4 });
    path.optimization.accepted = createAcceptedTrajectory(path, robot, legacyResult);
    const legacy = structuredClone(path.optimization.accepted);
    expect(getAcceptedTrajectory(path, robot)).toEqual(legacyResult);
    const selected = applyAcceptedRouteTrajectory(path, robot, solve(path, robot, 2).candidate!);
    expect(selected.optimization).toMatchObject({ corridorM: 0.4, legacyAccepted: legacy, accepted: { version: 2 } });
    project.paths = [selected];
    const reopened = decodeProjectFile(encodeProjectFile(project).contents).project;
    expect(reopened.paths[0].optimization!.legacyAccepted).toEqual(legacy);
    const normal = { ...selected, optimization: { ...selected.optimization, accepted: undefined } };
    expect(getAcceptedTrajectory(normal, robot)).toBeNull();
    expect(encodeProjectFile({ ...project, paths: [path] }).project.schemaVersion).toBe("1.0");
  });

  it("retires seed jobs without invalidating accepted intent, and preserves exact persisted/exported samples", () => {
    const { project, path, robot } = fixture();
    const candidate = solve(path, robot, 2).candidate!;
    const applied = applyAcceptedRouteTrajectory(path, robot, candidate);
    const changed = structuredClone(applied);
    changed.waypoints[0].nextC.y += 2;
    expect(routeInputKey(changed, robot)).not.toBe(routeInputKey(applied, robot));
    expect(routeIntentKey(changed, robot)).toBe(routeIntentKey(applied, robot));
    expect(getAcceptedTrajectory(changed, robot)).toEqual(candidate);
    expect(getAcceptedTrajectory({ ...changed, name: "Renamed", id: "copy" }, robot)).toEqual(candidate);
    const taskChanged = structuredClone(changed);
    taskChanged.waypoints[0].x += 0.1;
    expect(getAcceptedTrajectory(taskChanged, robot)).toBeNull();
    project.paths = [changed];
    const encoded = encodeProjectFile(project);
    expect(encoded.project.schemaVersion).toBe("1.2");
    const reopened = decodeProjectFile(encoded.contents).project;
    expect(buildBdxExport(reopened).paths[0].samples).toEqual(candidate.samples);
    expect(buildBdxExport(reopened).paths[0].markers).toEqual(candidate.markers);
  });

  it.each(["geometry", "sample", "event", "mapping"])("blocks current-input %s tampering", (kind) => {
    const { path, robot } = fixture();
    path.markers = [{ id: "event", name: "Intake", cmd: "intake", f: 0.5 }];
    const candidate = solve(path, robot, 2).candidate!;
    const applied = applyAcceptedRouteTrajectory(path, robot, candidate);
    const result = applied.optimization!.accepted!.result;
    if (kind === "geometry") result.routeGeometry!.knots[0].x += 0.1;
    if (kind === "sample") result.samples[3].x += 0.2;
    if (kind === "event") result.markers[0].command = "forged";
    if (kind === "mapping") result.routeGeometry!.requiredPointIndices[1] = 0;
    expect(getAcceptedTrajectory(applied, robot)).toBeNull();
    expect(() => selectPathTrajectory(applied, robot)).toThrow(/applied optimization is invalid/);
  });

  it("independently refuses exact, physically timed geometry that crosses a solid obstacle", () => {
    const { path, robot } = fixture([{ x: 2.7, y: 4.1 }, { x: 6.6, y: 4.1 }]);
    const geometry = geometryFromPath(path), planning = routePlanningPath(path, geometry);
    const raw = optimizeFixedGeometryFinal({ path: planning, robot });
    expect(raw.optimization!.fallback).toBe(false);
    const result = routeResultToSource(raw, geometry, planning);
    expect(routeCandidateFailure({ path, robot }, result)).toMatch(/clearance/);
    expect(() => applyAcceptedRouteTrajectory(path, robot, result)).toThrow(/clearance/);
  });

  it("bounds stationary rotation clearance even with safe endpoint footprints", () => {
    const { path, robot } = fixture([{ x: 6.5, y: 0.4 }, { x: 10, y: 0.4 }]);
    robot.w = 0.2; robot.l = 1.2;
    path.waypoints[1].stop = true;
    path.waypoints[1].turnInPlace = { headingDeg: 180, direction: "counterclockwise" };
    const geometry = geometryFromPath(path), planning = routePlanningPath(path, geometry);
    const raw = getPlanner("profiledSpline").generate({ path: planning, robot });
    expect(raw.stationaryActions!.some((a) => a.kind === "turn")).toBe(true);
    expect(routeSafetyFailure(robot, raw)).toMatch(/clearance/);
    expect(solve(path, robot, 2).candidate).toBeUndefined();
  });

  it("uses configured BUMP speed without inventing field policy", () => {
    const { path, robot } = fixture([{ x: 2.7, y: 2.6 }, { x: 6.6, y: 2.6 }]);
    path.constraints.maxVel = 4;
    const geometry = geometryFromPath(path), planning = routePlanningPath(path, geometry);
    const raw = optimizeFixedGeometryFinal({ path: planning, robot });
    expect(raw.samples.some((s) => s.velocityMps > 2.1)).toBe(true);
    const failure = routeSafetyFailure(robot, raw);
    expect(failure).toBeUndefined();
    expect(path.constraints.maxVel).toBe(4);
  });

  it("keeps tangent-derived headings free and explicit heading targets authoritative", () => {
    const { path, robot } = fixture();
    path.headingMode = "tangent";
    // Current editor endpoints retain thetaOn and stale theta even in tangent mode.
    path.waypoints.forEach((w) => { w.thetaOn = true; w.theta = 75; });
    path.waypoints[0].nextC = { x: 6.5, y: 7 };
    path.waypoints[1].prevC = { x: 10, y: 7 };
    const tangent = solve(path, robot, 3).candidate!;
    expect(tangent, "Tangent solve").toBeDefined();
    expect(tangent.samples[0].headingRad).toBeCloseTo(0, 6);
    path.headingMode = "targets";
    path.targets = [{ f: 0.5, deg: 90, anchor: "param" }];
    const targeted = solve(path, robot, 3).candidate!;
    expect(targeted, "Target solve").toBeDefined();
    const middle = targeted.samples.find((s) => Math.abs(s.f - 0.5) < 1e-6)!;
    expect(middle.headingRad).toBeCloseTo(Math.PI / 2, 3);
    expect(routeCandidateFailure({ path, robot }, targeted)).toBeUndefined();
  });

  it("cancels before evaluating, or retains only a qualified incumbent", () => {
    const { path, robot } = fixture();
    const progress: PlannerResult[] = [];
    const empty = optimizeRouteFinal({ path, robot }, { isCancelled: () => true, onProgress: (p) => progress.push(p) });
    expect(empty).toMatchObject({ status: "cancelled", termination: "cancelled", candidate: undefined });
    let cancel = false;
    const retained = optimizeRouteFinal({ path, robot }, { onProgress: (p) => { progress.push(p); cancel = true; }, isCancelled: () => cancel });
    expect(retained.status).toBe("cancelled");
    expect(progress.length).toBe(1);
    expect(routeCandidateFailure({ path, robot }, retained.candidate!)).toBeUndefined();
    expect(optimizeRouteFinal({ path, robot }, { budgetMs: 1 })).toMatchObject({ candidate: undefined, termination: "time-budget" });
  });

  it("reports unsupported source features and bounded exhaustion truthfully", () => {
    const { path, robot } = fixture();
    path.waypoints[0].segType = "arc";
    expect(solve(path, robot)).toMatchObject({ status: "unsupported" });
    path.waypoints[0].segType = "bezier";
    path.waypoints[0].x = -5;
    const result = solve(path, robot, 2);
    expect(result).toMatchObject({ status: "no-candidate", candidate: undefined });
    expect(result.reason).toMatch(/does not prove/);
  });
});
