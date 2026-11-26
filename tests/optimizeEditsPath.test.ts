/**
 * Applying an optimization edits the path. Ways this can fail, each covered below:
 *
 * Apply
 *  1. The path plans differently from the candidate the user previewed (detour and same-shape results,
 *     swerve and tank, with stops, waits, turns, markers and zones).
 *  2. A required waypoint moves or loses a field (heading, stop, wait, turn, shared position, name).
 *  3. An inserted waypoint is not a plain pass-through, lacks the flag, or follows another segment's heading law.
 *  4. The applied path fails project validation, or a save and reopen changes its curve.
 *  5. A waypoint-anchored zone ends up at another place, or stops limiting the stop it covered.
 *  6. A marker, rotation target or zone placed by fraction or distance changes value.
 *  7. Apply changes the path it was given.
 *  8. Apply accepts a curve that moves or drops a required waypoint.
 * Optimize again
 *  9. A path with inserted waypoints no longer equals its own task plus seed curve.
 * 10. An old detour stays required, or removing it leaves zones somewhere else.
 * 11. The search compares candidates with a curve other than the current path.
 * 12. A waypoint the user edited is treated as free.
 * User edits
 * 13. Editing an inserted waypoint keeps the flag, or leaves an invalid waypoint.
 * 14. An edit elsewhere, including one that shifts indices, drops the flag.
 * 15. Inserted waypoints stop following the heading law of their segment.
 * 16. An inserted waypoint that becomes an endpoint keeps the flag.
 * Planning
 * 17. Playback, routines and export disagree on the applied path, or a robot edit needs anything special.
 * 18. A file with a stored optimization fails to open, keeps the stored result, or plans another curve.
 * 19. A curve that collides for the current robot is not reported, a clear one is, or the report blocks timing.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { buildBdxExport } from "../src/core/export/bdx";
import { PM } from "../src/core/math/pm";
import { getPlanner } from "../src/core/planners";
import { DRAWN_SHAPE_LIMIT_M } from "../src/core/planners/limits";
import { pathTrajectory } from "../src/core/planners/pathTrajectory";
import { planPath } from "../src/core/planners/planPath";
import { optimizeDrawnShapeFinal, optimizeRouteFinal } from "../src/core/planners/routeFinal";
import { applyRoute, routePlanningPath, routeTask, settleOptimizerWaypoints } from "../src/core/planners/routeGeometry";
import { activeAngularLimits } from "../src/core/planners/stationaryActions";
import { buildWaypoints, createDemoProject } from "../src/core/project/defaults";
import { decodeProjectFile, encodeProjectFile } from "../src/core/project/fileFormat";
import { projectDocuments } from "../src/core/project/folderLayout";
import { normalizeProject } from "../src/core/project/normalize";
import { validateProject } from "../src/core/validation";
import type { BordeauxProject, PathDoc, PlannerResult, RobotConfig, Waypoint } from "../src/core/types";

const corpus = normalizeProject(JSON.parse(readFileSync(new URL("../benchmarks/planner-corpus/v2/corpus.bordeaux.json", import.meta.url), "utf8"))) as BordeauxProject;

/** A straight drawn line through the HUB. Every valid route needs knots the user did not draw. */
function detour(drive: RobotConfig["drive"] = "swerve") {
  const project = createDemoProject();
  project.robot = { ...project.robot, drive, w: 0.4, l: 0.4, heightM: 0.5 };
  const path = project.paths[0];
  path.waypoints = buildWaypoints([{ x: 5.5705, y: -0.0655 }, { x: 1.6705, y: -0.0655 }, { x: 1.1705, y: -0.0655 }]);
  path.headingMode = "manual";
  path.constraints.maxVel = 1.5;
  path.waypoints[0].segmentHeadingMode = "tangent";
  path.waypoints[1] = { ...path.waypoints[1], stop: true, wait: 0.137, theta: 90, thetaOn: true, positionLink: "shared-a", positionName: "Pickup",
    turnInPlace: { headingDeg: 90, direction: "counterclockwise" } };
  path.markers = [
    { id: "by-fraction", name: "Intake", cmd: "intake.collect", f: 0.25, anchor: "param" },
    { id: "by-distance", name: "Spin up", cmd: "shooter.spin", f: 0, d: 0.8, anchor: "dist" },
  ];
  path.targets = [{ f: 0.95, deg: 20, anchor: "param" }];
  path.ranges = [
    { anchor: "wp", w0: 0, t0: 0.5, w1: 1, f0: 0, f1: 1, maxVel: 0.6, maxAngVel: 30, name: "leg" },
    { anchor: "wp", w0: 1, w1: 2, f0: 0, f1: 1, maxVel: 0.9, name: "whole" },
    { anchor: "param", f0: 0.1, f1: 0.2, maxVel: 1.2 },
    { anchor: "dist", f0: 0, f1: 0, d0: 0.2, d1: 0.5, maxVel: 1.1 },
  ];
  return { project, path, robot: project.robot };
}

function searchRoute(path: PathDoc, robot: RobotConfig, maximumEvaluations = 14) {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  try { return optimizeRouteFinal({ path, robot }, { maximumEvaluations }); } finally { clock.mockRestore(); }
}

const normal = (path: PathDoc, robot: RobotConfig) => getPlanner("profiledSpline").generate({ path, robot });
const free = (path: PathDoc) => path.waypoints.flatMap((waypoint, index) => waypoint.optimizerAdded ? [index] : []);
const required = (path: PathDoc) => path.waypoints.filter((waypoint) => !waypoint.optimizerAdded);

/** Where a zone's two ends lie on the field. */
function zoneEnds(path: PathDoc, index: number) {
  const sample = PM.sample(path.waypoints, 256, true);
  const range = PM.effectiveRanges(path, sample)[index];
  return [range.f0, range.f1].map((fraction) => PM.pointAtFraction(fraction, sample.pts));
}

/** The candidate is the Normal plan of the path Apply writes, so they match exactly. */
function expectSameTrajectory(candidate: PlannerResult, planned: PlannerResult) {
  expect(planned.totalTimeS).toBe(candidate.totalTimeS);
  expect(planned.samples).toEqual(candidate.samples);
  expect(planned.markers).toEqual(candidate.markers);
  expect(planned.stationaryActions).toEqual(candidate.stationaryActions);
  expect(planned.waypointSampleIndices).toEqual(candidate.waypointSampleIndices);
}

describe.each(["swerve", "tank"] as const)("applying a detour on a %s robot", (drive) => {
  const { project, path, robot } = detour(drive);
  const original = structuredClone(path);
  const search = searchRoute(path, robot);
  const candidate = search.candidate!;
  const applied = candidate && applyRoute(path, candidate.routeGeometry!);

  it("finds a route with knots the user did not draw", () => {
    expect(candidate, JSON.stringify(search.statistics)).toBeDefined();
    expect(candidate.routeGeometry!.knots.length).toBeGreaterThan(path.waypoints.length);
  });

  it("plans exactly the trajectory the candidate previewed (1)", () => {
    expectSameTrajectory(candidate, normal(applied, robot));
    expect(applied).toEqual(candidate.optimizedPath);
  });

  it("keeps every required waypoint as authored (2)", () => {
    expect(required(applied)).toHaveLength(3);
    required(applied).forEach((waypoint, index) => {
      const { prevC: _prev, nextC: _next, linked: _linked, corner: _corner, ...kept } = waypoint;
      const { prevC: _p, nextC: _n, linked: _l, corner: _c, ...authored } = original.waypoints[index];
      expect(kept).toEqual(authored);
    });
    expect(applied.waypoints.at(-2)).toMatchObject({ stop: true, wait: 0.137, positionLink: "shared-a", positionName: "Pickup" });
  });

  it("inserts flagged pass-through waypoints that follow their segment (3)", () => {
    expect(free(applied).length).toBe(candidate.routeGeometry!.knots.length - 3);
    for (const index of free(applied)) {
      expect(applied.waypoints[index]).toMatchObject({ optimizerAdded: true, stop: false, thetaOn: false, segmentHeadingMode: "tangent" });
      expect(applied.waypoints[index]).not.toHaveProperty("wait");
      expect(applied.waypoints[index]).not.toHaveProperty("positionLink");
    }
  });

  it("is a valid project that reopens on the same curve (4)", () => {
    const next = { ...project, paths: [applied] };
    expect(validateProject(next).issues.filter((issue) => issue.severity === "error")).toEqual([]);
    const reopened = decodeProjectFile(encodeProjectFile(next).contents).project.paths[0];
    expect(reopened.waypoints).toEqual(applied.waypoints);
    expect(normal(reopened, robot).samples).toEqual(normal(applied, robot).samples);
    expect(applied).not.toHaveProperty("optimization");
    expect(applied).not.toHaveProperty("routeRequiredPointIndices");
  });

  it("keeps waypoint-anchored zones on the same part of the route (5)", () => {
    const sample = PM.sample(applied.waypoints, 256, true);
    const fractions = PM.waypointFracs(applied, sample);
    const stop = applied.waypoints.length - 2;
    const [leg, whole] = PM.effectiveRanges(applied, sample);
    // Half way along the first leg, by distance, to the stop that ends it. Placement samples the curve
    // at another density than the display does, so the two agree to within 0.05 mm per metre.
    expect(leg.f0).toBeCloseTo(fractions[stop] / 2, 4);
    expect(leg.f1).toBeCloseTo(fractions[stop], 9);
    expect(whole.f0).toBeCloseTo(fractions[stop], 9);
    expect(whole.f1).toBe(1);
    // The stop is still inside the zone that limits its turn.
    expect(activeAngularLimits(applied, fractions[stop], stop, sample.length).velocity).toBeCloseTo(30 * Math.PI / 180, 9);
    const turn = normal(applied, robot).stationaryActions!.find((action) => action.kind === "turn")!;
    expect(turn.waypointIndex).toBe(stop);
    expect(turn.endTimeS - turn.startTimeS).toBeGreaterThanOrEqual(5.625);
  });

  it("keeps fraction and distance placements as authored (6)", () => {
    expect(applied.markers).toEqual(original.markers);
    expect(applied.targets).toEqual(original.targets);
    expect(applied.ranges.slice(2)).toEqual(original.ranges.slice(2));
    expect(normal(applied, robot).markers.map((marker) => marker.fraction)).toEqual(candidate.markers.map((marker) => marker.fraction));
  });

  it("leaves the path it was given unchanged (7)", () => {
    expect(path).toEqual(original);
  });

  it("refuses a curve that moves or drops a required waypoint (8)", () => {
    const moved = structuredClone(candidate.routeGeometry!);
    moved.knots[0].x += 0.01;
    expect(() => applyRoute(path, moved)).toThrow(/moved a required point/);
    const dropped = structuredClone(candidate.routeGeometry!);
    dropped.requiredPointIndices = [0, dropped.knots.length - 1];
    expect(() => applyRoute(path, dropped)).toThrow(/omitted a required point/);
  });

  it("is its own task plus seed curve (9)", () => {
    const { task, seed } = routeTask(applied);
    expect(task.waypoints).toHaveLength(3);
    expect(seed.knots).toHaveLength(applied.waypoints.length);
    const rebuilt = routePlanningPath(task, seed);
    expect(rebuilt.waypoints).toEqual(applied.waypoints);
    expect(normal(rebuilt, robot).totalTimeS).toBeCloseTo(normal(applied, robot).totalTimeS, 9);
    // The task carries zones by required waypoint again, where the user authored them.
    task.ranges.forEach((range, index) => {
      expect(range.w0).toBe(original.ranges[index].w0);
      if (range.t0 !== undefined) expect(range.t0).toBeCloseTo(original.ranges[index].t0!, 9);
    });
  });

  it("lets a later Optimize drop the old detour and puts zones back (10)", () => {
    // The route straight through, which this smaller task allows: the same required waypoints and nothing else.
    const { task } = routeTask(applied);
    const direct = applyRoute(applied, { version: 1, requiredPointIndices: [0, 1, 2],
      knots: task.waypoints.map(({ x, y, prevC, nextC }) => ({ x, y, prevC, nextC, smooth: true })) });
    expect(free(direct)).toEqual([]);
    expect(direct.waypoints).toHaveLength(3);
    direct.ranges.forEach((range, index) => {
      const authored = original.ranges[index];
      expect(range.w0).toBe(authored.w0);
      expect(range.w1).toBe(authored.w1);
      if (authored.t0 !== undefined) expect(range.t0).toBeCloseTo(authored.t0, 9);
    });
    for (const index of [0, 1]) {
      const again = zoneEnds(direct, index), first = zoneEnds({ ...original, waypoints: direct.waypoints }, index);
      again.forEach((point, end) => expect(Math.hypot(point.x - first[end].x, point.y - first[end].y)).toBeLessThan(1e-6));
    }
  });

  it("compares a later search with the current path (11)", () => {
    const again = searchRoute(applied, robot, 2);
    // The second evaluation qualifies the current curve, inserted waypoints included.
    expect(again.seedStatus).toBe("valid");
    expect(again.baseline!.totalTimeS).toBeCloseTo(normal(applied, robot).totalTimeS, 9);
    expect(again.candidate!.routeGeometry!.requiredPointIndices).toHaveLength(3);
  });

  it("keeps a waypoint the user edited in every later route (12)", () => {
    const index = free(applied)[0];
    const edited = settleOptimizerWaypoints(applied, { ...applied,
      waypoints: applied.waypoints.map((waypoint, at) => at === index ? { ...waypoint, theta: 45, thetaOn: true } : waypoint) });
    expect(edited.waypoints[index].optimizerAdded).toBeUndefined();
    const { task, seed } = routeTask(edited);
    expect(task.waypoints).toHaveLength(4);
    expect(task.waypoints[1]).toMatchObject({ x: applied.waypoints[index].x, y: applied.waypoints[index].y, theta: 45, thetaOn: true });
    expect(seed.requiredPointIndices).toContain(index);
  });
}, 120_000);

describe("applying a same-shape result", () => {
  const base = corpus.paths.find((path) => path.id === "corpus-neutral-stop")!;
  const corner = {
    ...structuredClone(base), id: "corner", headingMode: "targets" as const,
    constraints: { ...base.constraints, maxVel: 4.2, maxAccel: 6.5, maxDecel: 6.5, maxCentripetalAccel: undefined },
    markers: [{ id: "event", name: "Intake", cmd: "intake.collect", f: 0.4, anchor: "param" as const }],
    ranges: [{ anchor: "wp" as const, w0: 0, t0: 0.25, w1: 0, t1: 0.75, f0: 0, f1: 1, maxVel: 3.5 }],
    waypoints: [
      { linked: true, thetaOn: true, theta: 180, stop: false, x: 3.8805, y: -3.5155, segType: "bezier", prevC: { x: 4.9235, y: -4.3415 }, nextC: { x: 0.9805, y: -3.3755 } },
      { linked: true, thetaOn: true, theta: 180, stop: false, x: 0.1555, y: -0.5655, segType: "bezier", prevC: { x: 0.0705, y: -3.1655 }, nextC: { x: -0.8875, y: 0.2605 } },
    ],
  } as unknown as PathDoc;
  const original = structuredClone(corner);
  const search = optimizeDrawnShapeFinal({ path: corner, robot: corpus.robot }, DRAWN_SHAPE_LIMIT_M, { budgetMs: 20_000 });
  const candidate = search.candidate!;
  const applied = applyRoute(corner, candidate.routeGeometry!);

  it("changes only handle lengths, and plans what the candidate previewed (1, 2, 6)", () => {
    expect(candidate.optimization?.status).toBe("feasible");
    expect(applied.waypoints).toHaveLength(2);
    expect(free(applied)).toEqual([]);
    applied.waypoints.forEach((waypoint, index) => {
      const { prevC, nextC, ...kept } = waypoint;
      const { prevC: drawnPrev, nextC: drawnNext, ...authored } = original.waypoints[index];
      expect(kept).toEqual(authored);
      for (const [control, drawn] of [[prevC, drawnPrev], [nextC, drawnNext]]) {
        expect(Math.atan2(control.y - waypoint.y, control.x - waypoint.x)).toBeCloseTo(Math.atan2(drawn.y - waypoint.y, drawn.x - waypoint.x), 9);
      }
    });
    expect(applied.waypoints).not.toEqual(original.waypoints);
    expect(applied.ranges).toEqual(original.ranges);
    expect(applied.markers).toEqual(original.markers);
    expectSameTrajectory(candidate, normal(applied, corpus.robot));
    expect(candidate.totalTimeS).toBeLessThan(normal(original, corpus.robot).totalTimeS);
  });

  it("plans the same curve for an edited robot, with that robot's timing (17)", () => {
    const heavier: RobotConfig = { ...corpus.robot, maxSpeed: corpus.robot.maxSpeed * 0.6 };
    const project = { ...createDemoProject(), robot: heavier, paths: [applied], editor: { activePathId: applied.id } };
    const exported = buildBdxExport(project).paths[0];
    const planned = pathTrajectory(applied, heavier);
    const editing = planPath({ path: applied, robot: heavier, samplesPerSegment: 56 });
    expect(exported.samples).toEqual(planned.samples);
    expect(editing.trajectory!.samples).toEqual(planned.samples);
    expect(planned.totalTimeS).toBeGreaterThan(candidate.totalTimeS);
    const curve = (result: PlannerResult) => result.samples.filter((_, index) => index % 7 === 0).map(({ x, y }) => ({ x, y }));
    const first = PM.sample(applied.waypoints, 2048).pts;
    for (const point of curve(planned)) expect(Math.min(...first.map((at) => Math.hypot(at.x - point.x, at.y - point.y)))).toBeLessThan(0.005);
  });
}, 120_000);

describe("editing a path with inserted waypoints", () => {
  const waypoint = (x: number, extra: Partial<Waypoint> = {}): Waypoint => ({
    x, y: 0, theta: 0, thetaOn: false, linked: true, stop: false, prevC: { x: x - 0.3, y: 0 }, nextC: { x: x + 0.3, y: 0 }, ...extra });
  const base = (): PathDoc => ({ ...createDemoProject().paths[0], waypoints: [
    waypoint(0, { thetaOn: true, segmentHeadingMode: "tangent" }),
    waypoint(1, { optimizerAdded: true, segmentHeadingMode: "tangent" }),
    waypoint(2, { optimizerAdded: true, segmentHeadingMode: "tangent" }),
    waypoint(3, { thetaOn: true }),
  ] });

  it("makes an edited inserted waypoint an ordinary one (13)", () => {
    const before = base(), after = structuredClone(before);
    after.waypoints[2].y = 0.4;
    after.waypoints[2].prevC = { x: 1.7, y: 0.4 };
    after.waypoints[2].nextC = { x: 2.3, y: 0.6 };
    const settled = settleOptimizerWaypoints(before, after);
    expect(settled.waypoints[2].optimizerAdded).toBeUndefined();
    expect(settled.waypoints[2]).toMatchObject({ linked: true, corner: false, x: 2, y: 0.4 });
    expect(settled.waypoints[1].optimizerAdded).toBe(true);
    const project = { ...createDemoProject(), paths: [settled], editor: { activePathId: settled.id } };
    expect(validateProject(project).issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it("keeps the flag through edits elsewhere and index shifts (14)", () => {
    const before = base(), after = structuredClone(before);
    after.waypoints[3].x = 3.2;
    after.waypoints.splice(1, 0, waypoint(0.5, { segmentHeadingMode: "tangent" }));
    const settled = settleOptimizerWaypoints(before, after);
    expect(settled.waypoints.map((item) => Boolean(item.optimizerAdded))).toEqual([false, false, true, true, false]);
  });

  it("carries a changed heading law through the inserted waypoints of that segment (15)", () => {
    const before = base(), after = structuredClone(before);
    after.waypoints[0].segmentHeadingMode = "lookAt";
    after.waypoints[0].segmentLookAt = { x: 1, y: 2 };
    after.waypoints[0].segmentFollowMode = "position";
    const settled = settleOptimizerWaypoints(before, after);
    for (const index of [1, 2]) {
      expect(settled.waypoints[index]).toMatchObject({ optimizerAdded: true, segmentHeadingMode: "lookAt", segmentLookAt: { x: 1, y: 2 }, segmentFollowMode: "position" });
    }
    delete after.waypoints[0].segmentHeadingMode;
    delete after.waypoints[0].segmentLookAt;
    const cleared = settleOptimizerWaypoints(settled, { ...settled, waypoints: [after.waypoints[0], ...settled.waypoints.slice(1)] });
    expect(cleared.waypoints[1]).not.toHaveProperty("segmentHeadingMode");
    expect(cleared.waypoints[2]).not.toHaveProperty("segmentLookAt");
    expect(routeTask(cleared).task.waypoints).toHaveLength(2);
  });

  it("makes an inserted waypoint that becomes an endpoint ordinary (16)", () => {
    const before = base(), after = structuredClone(before);
    after.waypoints.pop();
    const settled = settleOptimizerWaypoints(before, after);
    expect(settled.waypoints.at(-1)!.optimizerAdded).toBeUndefined();
    expect(settled.waypoints[1].optimizerAdded).toBe(true);
    const loaded = normalizeProject({ ...createDemoProject(), paths: [after] }) as BordeauxProject;
    expect(loaded.paths[0].waypoints.at(-1)!.optimizerAdded).toBeUndefined();
  });

  it("returns the same path when nothing concerns an inserted waypoint", () => {
    const before = base();
    expect(settleOptimizerWaypoints(before, before)).toBe(before);
  });
});

describe("a file with a stored optimization (18)", () => {
  const stored = (accepted: unknown) => {
    const project = JSON.parse(encodeProjectFile(createDemoProject()).contents);
    project.schemaVersion = "1.2";
    project.paths[0].optimization = { corridorM: 0.15, accepted, legacyAccepted: { version: 1, inputKey: "old" } };
    return project;
  };

  it.each([
    ["a route result", { version: 2, inputKey: "k", samplesPerSegment: 56, result: { planner: "profiledSpline", samples: [], routeGeometry: { version: 1, knots: [] } } }],
    ["an earlier corridor result", { version: 1, inputKey: "k", samplesPerSegment: 56, result: { samples: "corrupt" } }],
    ["a result from the previous field frame", { version: 2, requiresFieldReview: true }],
    ["something unreadable", 7],
  ])("opens with %s, drops it, and plans the drawn curve", (_label, accepted) => {
    const source = stored(accepted);
    const { project } = decodeProjectFile(JSON.stringify(source));
    expect(project.paths[0]).not.toHaveProperty("optimization");
    const drawn = createDemoProject();
    drawn.paths[0].waypoints = project.paths[0].waypoints;
    expect(pathTrajectory(project.paths[0], project.robot).samples).toEqual(pathTrajectory(drawn.paths[0], drawn.robot).samples);
    expect(buildBdxExport(project).paths[0].samples).toEqual(pathTrajectory(drawn.paths[0], drawn.robot).samples);
    const saved = encodeProjectFile(project).contents;
    expect(saved).not.toContain("optimization");
    expect(JSON.parse(projectDocuments(project).find((document) => document.key.startsWith("path:"))!.contents).version).toBe("2.0");
  });
});

describe("a curve that collides for the current robot (19)", () => {
  const { path, robot } = detour();
  const applied = applyRoute(path, searchRoute(path, robot).candidate!.routeGeometry!);

  it("says nothing while the robot clears the field", () => {
    const plan = planPath({ path: applied, robot, samplesPerSegment: 56 });
    expect(plan.status).toBe("ok");
    expect(plan.issues).toEqual([]);
  });

  it("reports where a larger robot hits the field, and still times the path", () => {
    const larger = { ...robot, w: 1.2, l: 1.2 };
    const plan = planPath({ path: applied, robot: larger, samplesPerSegment: 56 });
    expect(plan.status).toBe("ok");
    expect(plan.trajectory!.samples).toEqual(pathTrajectory(applied, larger).samples);
    expect(plan.issues).toHaveLength(1);
    const [issue] = plan.issues;
    expect(issue).toMatchObject({ code: "field-collision", severity: "warning" });
    expect(issue.f0).toBeGreaterThanOrEqual(0);
    expect(issue.f1).toBeLessThanOrEqual(1);
    expect(issue.f1).toBeGreaterThan(issue.f0);
    expect(issue.f1 - issue.f0).toBeLessThan(1);
  });

  it("reports the drawn curve through the HUB too, on a tank robot", () => {
    const tank = detour("tank");
    const [issue] = planPath({ path: tank.path, robot: tank.robot, samplesPerSegment: 56 }).issues.filter((item) => item.code === "field-collision");
    expect(issue).toMatchObject({ severity: "warning" });
  });
}, 120_000);
