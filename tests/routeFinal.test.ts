import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { buildWaypoints, createDemoProject } from "../src/core/project/defaults";
import { decodeProjectFile, encodeProjectFile } from "../src/core/project/fileFormat";
import { optimizeRouteFinal } from "../src/core/planners/routeFinal";
import { applyAcceptedRouteTrajectory, createAcceptedTrajectory, getAcceptedTrajectory, selectPathTrajectory } from "../src/core/planners/acceptedTrajectory";
import { routeInputKey, routeIntentKey } from "../src/core/planners/routeIdentity";
import { routeCandidateFailure } from "../src/core/planners/routeValidation";
import { getPlanner } from "../src/core/planners";
import { optimizeCorridorFinal } from "../src/core/planners/corridorFinal";
import { optimizeFixedGeometryFinal } from "../src/core/planners/fixedGeometryFinal";
import { routeSafetyFailure } from "../src/core/planners/routeSafety";
import { geometryFromPath, routePlanningPath, routeResultToSource } from "../src/core/planners/routeGeometry";
import { observeRobotFieldPortalSequence } from "../src/core/agent/fieldClearance";
import { buildBdxExport } from "../src/core/export/bdx";
import { PM } from "../src/core/math/pm";
import type { PathDoc, PlannerResult } from "../src/core/types";

function fixture(points = [{ x: 1.7705, y: 2.0345 }, { x: -1.7295, y: 2.0345 }]) {
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
    path.waypoints[0].nextC = { x: 1.7705, y: -2.9655 };
    path.waypoints[1].prevC = { x: -1.7295, y: -2.9655 };
    const original = structuredClone(path);
    const result = solve(path, robot, 3);
    expect(result.candidate, JSON.stringify(result.statistics)).toBeDefined();
    expect(result.candidate!.routeGeometry!.knots[0].nextC.y).toBeCloseTo(2.0345);
    expect(2.0345 - Math.min(...PM.sample(path.waypoints, 128).pts.map((p) => p.y))).toBeGreaterThan(1.5);
    expect(result.candidate!.totalDistanceM).toBeCloseTo(3.5, 4);
    expect(path).toEqual(original);
    expect(routeCandidateFailure({ path, robot }, result.candidate!)).toBeUndefined();
  });

  it("repairs an invalid seed without fabricating a baseline or gain", () => {
    const { path, robot } = fixture();
    path.waypoints[0].nextC.y = -15.9655;
    path.waypoints[1].prevC.y = -15.9655;
    const result = solve(path, robot, 3);
    expect(result.candidate, JSON.stringify(result.statistics)).toBeDefined();
    expect(result.baseline).toBeUndefined();
    expect(result.candidate!.optimization!.baselineTimeS).toBeUndefined();
    expect(result.candidate!.optimization!.gainS).toBeUndefined();
    const applied = applyAcceptedRouteTrajectory(path, robot, result.candidate!);
    expect(getAcceptedTrajectory(applied, robot)).toEqual(result.candidate);
  });

  it("finds a solver-knot detour from a seed crossing the HUB and a legal portal", () => {
    const { path, robot } = fixture([{ x: 5.5705, y: -0.0655 }, { x: 1.6705, y: -0.0655 }]);
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
    const { path, robot } = fixture([{ x: 1.7705, y: 2.0345 }, { x: 0.2705, y: 2.0345 }, { x: -1.7295, y: 2.0345 }]);
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
    const { path, robot } = fixture([{ x: 5.5705, y: -0.0655 }, { x: 1.6705, y: -0.0655 }]);
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
    const { path, robot } = fixture([{ x: 5.5705, y: -0.0655 }, { x: 1.6705, y: -0.0655 }]);
    path.waypoints[0].nextC = { x: 4.7705, y: 2.2345 };
    path.waypoints[1].prevC = { x: 2.4705, y: 2.2345 };
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
    const { path, robot } = fixture([{ x: 5.5705, y: 3.4845 }, { x: 1.6705, y: 3.4845 }]);
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
    const { path, robot } = fixture([{ x: 5.5705, y: -0.0655 }, { x: 1.6705, y: -0.0655 }]);
    const geometry = geometryFromPath(path), planning = routePlanningPath(path, geometry);
    const raw = optimizeFixedGeometryFinal({ path: planning, robot });
    expect(raw.optimization!.fallback).toBe(false);
    const result = routeResultToSource(raw, geometry, planning);
    expect(routeCandidateFailure({ path, robot }, result)).toMatch(/clearance/);
    expect(() => applyAcceptedRouteTrajectory(path, robot, result)).toThrow(/clearance/);
  });

  it("bounds stationary rotation clearance even with safe endpoint footprints", () => {
    const { path, robot } = fixture([{ x: 1.7705, y: 3.6345 }, { x: -1.7295, y: 3.6345 }]);
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
    const { path, robot } = fixture([{ x: 5.5705, y: 1.4345 }, { x: 1.6705, y: 1.4345 }]);
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
    path.waypoints[0].nextC = { x: 1.7705, y: -2.9655 };
    path.waypoints[1].prevC = { x: -1.7295, y: -2.9655 };
    const tangent = solve(path, robot, 3).candidate!;
    expect(tangent, "Tangent solve").toBeDefined();
    expect(Math.abs(tangent.samples[0].headingRad)).toBeCloseTo(Math.PI, 6);
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
    path.waypoints[0].x = 13.2705;
    const result = solve(path, robot, 2);
    expect(result).toMatchObject({ status: "no-candidate", candidate: undefined });
    expect(result.reason).toMatch(/does not prove/);
  });
});

describe("drawn curve grazing the field wall", () => {
  // Owner report 2026-10-17: the drawn curve clipped the top wall by ~7 mm, and
  // the search offered a 4.45 s hairpin through waypoint 1 instead of 2.84 s.
  const grazingRobot = { drive: "swerve", w: 0.84, l: 0.84, heightM: 0.5, maxSpeed: 5.346559406159112,
    driveModel: { motorId: "rev-vortex", motorFreeRpm: 6784, motorMaxTorqueNm: 3.6, motorCount: 4, gearRatio: 6.75, wheelDiameterM: 0.1016,
      massKg: 54, moiKgM2: 6.3504, wheelbaseM: 0.66, trackwidthM: 0.66, wheelFrictionCoefficient: 1.2 } } as any;
  const grazingPath = { version: "2.0", id: "p", name: "New path", targets: [], markers: [], ranges: [], headingMode: "targets", startVel: 0, goalVel: 0, exportable: true,
    constraints: { maxVel: 5.346559406159112, maxAccel: 11.76798, maxDecel: 11.76798, maxAngVel: 656.3992730002224, maxAngAccel: 2675.753917905203,
      maxAngDecel: 2675.753917905203, maxJerk: 0, maxAngJerk: 0, maxCentripetalAccel: 11.76798 },
    waypoints: [
      { linked: true, thetaOn: true, theta: 0, stop: false, x: 3.2478995154929045, y: -3.566439592596264, segType: "bezier",
        prevC: { x: 4.031899515492905, y: -3.566439592596264 }, nextC: { x: 2.463899515492905, y: -3.566439592596264 }, segmentHeadingMode: "tangent" },
      { linked: true, thetaOn: true, theta: -87, stop: false, x: -1.14138469045642, y: -1.242225929738121, segType: "bezier", segmentHeadingMode: "tangent", corner: false,
        prevC: { x: -1.215918174813297, y: -4.068669505614527 }, nextC: { x: -1.090324995282305, y: 0.6940494055202145 } },
      { linked: false, thetaOn: true, theta: -87, stop: true, x: 1.868096316110608, y: -1.2268553095049275, segType: "bezier", segmentHeadingMode: "tangent", corner: false,
        prevC: { x: 0.85426715437131, y: -1.214794787237334 }, nextC: { x: 2.953009913632689, y: -1.239761452960974 } },
    ] } as any;


  // Preserve the report's wall-relative clearance after the field-height correction.
  for (const w of grazingPath.waypoints) for (const point of [w, w.prevC, w.nextC]) point.y -= 8.069 - 8.052;

  it("repairs the curve near its drawn shape instead of offering a slower hairpin", () => {
    const normal = getPlanner("profiledSpline").generate({ path: grazingPath, robot: grazingRobot });
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    // Five evaluations: canonical, Normal qualification, authored, then the
    // nearest repairs. A wall-clock Quick search reaches only a handful.
    const result = (() => { try { return optimizeRouteFinal({ path: grazingPath, robot: grazingRobot }, { maximumEvaluations: 5 }); } finally { clock.mockRestore(); } })();
    expect(result.seedStatus).toBe("invalid");
    expect(result.seedIssue).toMatch(/footprint|clearance/);
    const candidate = result.candidate!;
    expect(candidate, JSON.stringify(result.statistics)).toBeDefined();
    expect(candidate.totalTimeS).toBeLessThan(normal.totalTimeS);
    expect(candidate.optimization!.seedIssue).toBe(result.seedIssue);
    // Exclude the stopped launch and arrival by distance; sample density follows refinement.
    const interior = candidate.samples.filter((sample) => sample.f > 0.05 && sample.f < 0.95);
    expect(Math.min(...interior.map((s) => Math.abs(s.velocityMps)))).toBeGreaterThan(1);
    expect(routeCandidateFailure({ path: grazingPath, robot: grazingRobot }, candidate)).toBeUndefined();
  }, 60_000);
});

describe("route candidate identity", () => {
  it("times straight handles of different lengths separately on a corpus path", () => {
    // Collinear handles leave a straight segment's shape alone but not its timing:
    // treating them as one route lost the fastest candidate here (3.7492 s).
    const project = decodeProjectFile(readFileSync("benchmarks/planner-corpus/v3/corpus.bordeaux.json", "utf8")).project;
    const path = project.paths.find((item) => item.name === "Neutral Stop and Reorient")!;
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const result = (() => { try { return optimizeRouteFinal({ path, robot: project.robot }); } finally { clock.mockRestore(); } })();
    expect(result.termination).toBe("completed");
    expect(result.statistics.evaluations).toBe(21);
    expect(result.candidate!.totalTimeS).toBeCloseTo(3.681558, 6);
  }, 60_000);
});
