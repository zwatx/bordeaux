import { describe, expect, it, vi } from "vitest";
import { buildWaypoints, createDemoProject } from "../src/shared/project/defaults";
import { optimizeRouteFinal } from "../src/shared/planners/routeFinal";
import { routeCandidateFailure, routeCandidateIssue } from "../src/shared/planners/routeValidation";
import { routeFieldModel, routeSafetyIssue, routeSweepStatus } from "../src/shared/planners/routeSafety";
import { routeCandidates } from "../src/shared/planners/routeCandidates";
import { geometryFromPath, routePlanningPath, routeResultToSource } from "../src/shared/planners/routeGeometry";
import * as fixedFinal from "../src/shared/planners/fixedGeometryFinal";
import { optimizeFixedGeometryFinal } from "../src/shared/planners/fixedGeometryFinal";
import * as planners from "../src/shared/planners";
import { routeInputKey, routeIntentKey } from "../src/shared/planners/routeIdentity";
import { applyAcceptedRouteTrajectory, getAcceptedTrajectory } from "../src/shared/planners/acceptedTrajectory";
import { stageAcceptedRouteTrajectory } from "../src/shared/planners/acceptedRouteStaging";
import type { ControlPoint, PlannerResult, RouteGeometry } from "../src/shared/types";

function fixture(points: ControlPoint[], size = 0.84) {
  const project = createDemoProject();
  const path = project.paths[0];
  project.robot.w = project.robot.l = size;
  path.waypoints = buildWaypoints(points);
  path.headingMode = "manual";
  path.constraints.maxVel = 4.2;
  return { project, path, robot: project.robot };
}

describe("practical route qualification", () => {
  // Review did not supply E/F coordinates. These reconstruct 3/4 required
  // points at the 0..1.276 m trench, including off-centre travel outside the old circumscribed-disk band.
  it.each([
    ["straight default", [{ x: 2.7, y: 0.638 }, { x: 6.6, y: 0.638 }], 0.84],
    ["straight one metre", [{ x: 2.7, y: 0.638 }, { x: 6.6, y: 0.638 }], 1],
    ["three points", [{ x: 2.7, y: 0.55 }, { x: 4.5, y: 0.819 }, { x: 6.6, y: 0.6 }], 0.84],
    ["four points off-centre", [{ x: 2.7, y: 0.638 }, { x: 3.5, y: 0.8 }, { x: 5.5, y: 0.8 }, { x: 6.6, y: 0.638 }], 0.84],
    ["four points", [{ x: 2.7, y: 0.638 }, { x: 3.5, y: 0.638 }, { x: 5.5, y: 0.638 }, { x: 6.6, y: 0.638 }], 0.84],
  ] as const)("qualifies %s trench with actual footprint", (_name, points, size) => {
    const { path, robot } = fixture([...points], size);
    const progress: PlannerResult[] = [];
    const result = optimizeRouteFinal({ path, robot }, { maximumEvaluations: 5, onProgress: (p) => progress.push(p) });
    expect(result.candidate, JSON.stringify(result.statistics)).toBeDefined();
    expect(result.seedStatus).toBe("valid");
    expect(result.baseline).toBeDefined();
    expect(progress[0].optimization!.seedStatus).toBe("unknown");
    expect(progress.at(-1)!.optimization!.seedStatus).toBe("valid");
    expect(result.candidate!.totalTimeS).toBeLessThanOrEqual(result.baseline!.totalTimeS);
    for (const candidate of [...progress, result.candidate!]) {
      expect(["unknown", "valid"]).toContain(candidate.optimization!.seedStatus);
      if (candidate.optimization!.seedStatus === "unknown") expect(candidate.optimization!.gainS).toBeUndefined();
      expect(routeCandidateFailure({ path, robot }, candidate)).toBeUndefined();
    }
  });

  it("rescues the actual default robot HUB-crossing seed with a legal slower detour and no fake gain", () => {
    const { path, robot } = fixture([{ x: 2.7, y: 4.1 }, { x: 6.6, y: 4.1 }]);
    const progress: PlannerResult[] = [];
    const result = optimizeRouteFinal({ path, robot }, { maximumEvaluations: 16, onProgress: (p) => progress.push(p) });
    expect(result.candidate, JSON.stringify(result.statistics)).toBeDefined();
    expect(result.seedStatus).toBe("invalid");
    expect(result.baseline).toBeUndefined();
    expect(result.candidate!.optimization!.gainS).toBeUndefined();
    expect(result.candidate!.routeGeometry!.knots.length).toBeGreaterThan(2);
    expect(progress.length).toBeGreaterThan(0);
    for (const candidate of [...progress, result.candidate!]) {
      expect(candidate.optimization!.seedStatus).toBe("invalid");
      expect(routeCandidateFailure({ path, robot }, candidate)).toBeUndefined();
    }
  });

  it("finds a qualified HUB detour with unequal generated legs within the common budget", () => {
    const { path, robot } = fixture([{ x: 2.2, y: 4 }, { x: 6.36, y: 4.99 }]);
    path.headingMode = "targets";
    const original = structuredClone(path);
    const progress: PlannerResult[] = [];
    const result = optimizeRouteFinal({ path, robot }, { onProgress: (p) => progress.push(p) });
    expect(result.candidate, JSON.stringify(result.statistics)).toBeDefined();
    expect(result.status).toBe("feasible");
    expect(result.seedStatus).toBe("invalid");
    expect(result.baseline).toBeUndefined();
    expect(result.statistics.evaluations).toBeLessThanOrEqual(24);
    expect(result.candidate!.optimization!.budgetMs).toBe(5000);
    expect(result.candidate!.routeGeometry!.knots.length).toBeGreaterThan(2);
    expect(progress.length).toBeGreaterThan(0);
    for (const candidate of [...progress, result.candidate!]) {
      expect(routeCandidateFailure({ path, robot }, candidate)).toBeUndefined();
      expect(candidate.optimization!.gainS).toBeUndefined();
    }
    expect(path).toEqual(original);
  });

  it("surfaces the real fixed-planner fallback for an inconsistent interior turn", () => {
    const { path, robot } = fixture([{ x: 2.7, y: 0.638 }, { x: 6.6, y: 0.638 }, { x: 6.6, y: 3 }]);
    path.waypoints[1].stop = true;
    path.waypoints[1].turnInPlace = { headingDeg: 90, direction: "counterclockwise" };
    const result = optimizeRouteFinal({ path, robot });
    expect(result.candidate).toBeUndefined();
    const top = [...result.statistics.rejectionReasons].sort((a, b) => b.count - a.count)[0];
    expect(top.reason).toMatch(/Interior turn heading must match the outgoing segment heading/);
    expect(result.statistics.rejectionReasons.some((r) => /Accepted trajectory was not validated/.test(r.reason))).toBe(false);
  });

  it("retains aligned cubic graph handles alongside the overshooting smoothed variant", () => {
    const { path, robot } = fixture([{ x: (1-2.2/17.548)*16.541, y: 4/8.052*8.069 }, { x: (1-6.36/17.548)*16.541, y: 4.99/8.052*8.069 }]);
    path.headingMode = "targets";
    const candidates = routeCandidates({ path, robot }, () => false);
    let smooth: RouteGeometry = candidates.next().value!;
    while (smooth.knots.length === path.waypoints.length) smooth = candidates.next().value!;
    const cubic: RouteGeometry = candidates.next().value!;
    expect(cubic.requiredPointIndices).toEqual(smooth.requiredPointIndices);
    expect(cubic.knots.map(({ smooth: _smooth, ...knot }) => knot))
      .toEqual(smooth.knots.map(({ smooth: _smooth, ...knot }) => knot));
    for (let i = 0; i < cubic.knots.length; i++) {
      expect(cubic.knots[i].smooth).toBe(cubic.requiredPointIndices.includes(i));
    }
    const evaluate = (geometry: typeof smooth) => {
      const planning = routePlanningPath(path, geometry);
      return routeResultToSource(optimizeFixedGeometryFinal({ path: planning, robot }), geometry, planning);
    };
    expect(routeCandidateFailure({ path, robot }, evaluate(smooth))).toMatch(/clearance/);
    expect(routeCandidateFailure({ path, robot }, evaluate(cubic))).toBeUndefined();
  });

  it("classifies observed requirements separately from malformed or inferred profiles", () => {
    const { path, robot } = fixture([{ x: 6.5, y: 2 }, { x: 10, y: 2 }]);
    path.waypoints[0].thetaOn = true;
    const result = optimizeRouteFinal({ path, robot }, { maximumEvaluations: 1 }).candidate!;
    expect(routeCandidateIssue({ path, robot }, result)).toBeUndefined();
    const heading = structuredClone(result);
    heading.samples[0].headingRad += 0.1;
    expect(routeCandidateIssue({ path, robot }, heading)).toEqual({ message: "An explicit required heading was not met.", concrete: true });
    const position = structuredClone(result);
    position.samples[0].x += 0.0015;
    expect(routeCandidateIssue({ path, robot }, position)).toEqual({ message: "Required waypoint arrival or stop is invalid.", concrete: true });
    const mapping = structuredClone(result);
    mapping.waypointSampleIndices![0] = -1;
    expect(routeCandidateIssue({ path, robot }, mapping)).toEqual({ message: "Required arrival mapping is invalid.", concrete: false });
    const numerical = structuredClone(result);
    numerical.samples[0].accelerationMps2 = NaN;
    expect(routeCandidateIssue({ path, robot }, numerical)).toEqual({ message: "Accepted trajectory samples must be finite and ordered", concrete: false });
    const fallback = structuredClone(result);
    fallback.optimization!.fallback = true;
    fallback.diagnostics.push({ severity: "error", path: "samples", message: "Profile inference failed" });
    expect(routeCandidateIssue({ path, robot }, fallback)).toEqual({ message: "Profile inference failed", concrete: false });
    fallback.optimization!.fallbackReason = "Specific planner failure";
    expect(routeCandidateIssue({ path, robot }, fallback)).toEqual({ message: "Specific planner failure", concrete: false });
    fallback.optimization!.fallbackReason = "";
    fallback.diagnostics = [];
    expect(routeCandidateFailure({ path, robot }, fallback)).toBe("The planner did not produce a validated route.");
  });

  it("treats manual 90 degree facing as a pose while traveling forward", () => {
    const { path, robot } = fixture([{ x: 6.5, y: 2 }, { x: 8, y: 2 }, { x: 10, y: 2 }]);
    path.waypoints.forEach((w) => { w.thetaOn = true; w.theta = 90; });
    const canonical = routeCandidates({ path, robot }, () => false).next().value!;
    expect(canonical.knots[1].prevC.y).toBe(2);
    expect(canonical.knots[1].nextC.y).toBe(2);
    const result = optimizeRouteFinal({ path, robot }, { maximumEvaluations: 3 });
    expect(result.candidate, JSON.stringify(result.statistics)).toBeDefined();
    expect(result.candidate!.samples.every((s) => Math.abs(s.headingRad - Math.PI / 2) < 1e-6)).toBe(true);
  });

  it("keeps stopped travel tangents independent of the outgoing manual chassis heading", () => {
    const { path, robot } = fixture([{ x: 6.5, y: 2 }, { x: 8, y: 3 }, { x: 10, y: 3 }]);
    path.waypoints.forEach((w) => { w.thetaOn = true; w.theta = 90; });
    path.waypoints[1] = { ...path.waypoints[1], stop: true, turnInPlace: { headingDeg: 90, direction: "counterclockwise" } };
    const geometry = routeCandidates({ path, robot }, () => false).next().value!;
    expect(geometry.knots[1].prevC.y).toBeLessThan(3);
    expect(geometry.knots[1].nextC.y).toBe(3);
    const result = optimizeRouteFinal({ path, robot }, { maximumEvaluations: 3 });
    expect(result.candidate, JSON.stringify(result.statistics)).toBeDefined();
    expect(routeCandidateFailure({ path, robot }, result.candidate!)).toBeUndefined();
  });

  it("keeps handle linkage and corner mode out of accepted task intent, but retires seed jobs", () => {
    const { path, robot } = fixture([{ x: 6.5, y: 2 }, { x: 8, y: 2 }, { x: 10, y: 2 }]);
    const result = optimizeRouteFinal({ path, robot }, { maximumEvaluations: 2 });
    const selected = applyAcceptedRouteTrajectory(path, robot, result.candidate!);
    for (const flag of ["linked", "corner"] as const) {
      const changed = structuredClone(selected);
      changed.waypoints[1][flag] = !changed.waypoints[1][flag];
      expect(routeInputKey(changed, robot)).not.toBe(routeInputKey(selected, robot));
      expect(routeIntentKey(changed, robot)).toBe(routeIntentKey(selected, robot));
      expect(getAcceptedTrajectory(changed, robot)).toEqual(result.candidate);
    }
    expect(stageAcceptedRouteTrajectory(path, robot, result.candidate!)).toEqual(selected);
    const malformed = structuredClone(result.candidate!);
    malformed.optimization!.fallback = true;
    expect(() => stageAcceptedRouteTrajectory(path, robot, malformed)).toThrow();
  });

  it("catches collisions between safe endpoint poses and rotating corners, including polygon footprints", () => {
    const { robot } = fixture([]);
    const model = routeFieldModel(robot);
    expect(routeSweepStatus({ x: 2.7, y: 4.1, headingRad: 0 }, { x: 6.6, y: 4.1, headingRad: 0 }, model)).toBe("collision");
    const rectangular = { ...robot, w: 0.2, l: 1.2 };
    expect(routeSweepStatus({ x: 8, y: 0.4, headingRad: 0 }, { x: 8, y: 0.4, headingRad: Math.PI }, routeFieldModel(rectangular))).toBe("collision");
    const polygon = { ...robot, footprint: { kind: "polygon" as const, verticesM: [{ x: -0.5, y: -0.5 }, { x: 0.5, y: -0.5 }, { x: 0.5, y: 0.5 }, { x: -0.5, y: 0.5 }] } };
    expect(routeSweepStatus({ x: 2.7, y: 0.638, headingRad: 0 }, { x: 6.6, y: 0.638, headingRad: 0 }, routeFieldModel(polygon))).toBe("clear");
  });

  it("keeps inconclusive and untested seed states unknown, including progress", () => {
    const { path, robot } = fixture([{ x: 6.5, y: 0.4200005 }, { x: 10, y: 0.4200005 }]);
    const progress: PlannerResult[] = [];
    const result = optimizeRouteFinal({ path, robot }, { maximumEvaluations: 3, onProgress: (p) => progress.push(p) });
    expect(result.seedStatus).toBe("unknown");
    expect(result.baseline).toBeUndefined();
    expect(result.statistics.rejectionReasons.some((r) => /subdivision budget/.test(r.reason))).toBe(true);
    const geometry = geometryFromPath(path);
    const planning = routePlanningPath(path, geometry);
    const raw = optimizeFixedGeometryFinal({ path: planning, robot });
    expect(routeSafetyIssue(robot, raw)).toMatchObject({ concrete: false, message: expect.stringMatching(/inconclusive/) });
    expect(progress.every((p) => p.optimization!.seedStatus === "unknown" && p.optimization!.gainS === undefined)).toBe(true);
    expect(optimizeRouteFinal({ path, robot }, { isCancelled: () => true }).seedStatus).toBe("unknown");
    expect(optimizeRouteFinal({ path, robot }, { budgetMs: 1 }).seedStatus).toBe("unknown");
  });

  it("reserves a canonical rescue evaluation before spending work on a bad seed", () => {
    const { path, robot } = fixture([{ x: 6.5, y: 2 }, { x: 10, y: 2 }]);
    path.waypoints[0].nextC.y = path.waypoints[1].prevC.y = 20;
    const result = optimizeRouteFinal({ path, robot }, { maximumEvaluations: 1 });
    expect(result.candidate).toBeDefined();
    expect(result.seedStatus).toBe("unknown");
    expect(result.baseline).toBeUndefined();
    expect(result.candidate!.optimization!.gainS).toBeUndefined();
    expect(routeCandidateFailure({ path, robot }, result.candidate!)).toBeUndefined();
  });

  it.each(["numerical", "diagnostic"] as const)("keeps a %s Normal failure unknown without concrete task evidence", (kind) => {
    const { path, robot } = fixture([{ x: 6.5, y: 2 }, { x: 10, y: 2 }]);
    const getPlanner = planners.getPlanner;
    let injected = 0;
    const spy = vi.spyOn(planners, "getPlanner").mockImplementation((id) => {
      const planner = getPlanner(id);
      return { ...planner, generate(input) {
        const result = planner.generate(input);
        // Only actual authored Normal fails; canonical rescue remains qualified.
        if (id === "profiledSpline" && !input.path.routeRequiredPointIndices) {
          injected++;
          if (kind === "numerical") result.samples[0].accelerationMps2 = NaN;
          else result.diagnostics.push({ severity: "error", path: "samples", message: "Profile inference failed" });
        }
        return result;
      } };
    });
    try {
      const progress: PlannerResult[] = [];
      const result = optimizeRouteFinal({ path, robot }, { maximumEvaluations: 2, onProgress: (p) => progress.push(p) });
      expect(injected).toBe(1);
      expect(result.candidate).toBeDefined();
      expect(result.seedStatus).toBe("unknown");
      expect(result.baseline).toBeUndefined();
      expect(progress.every((p) => p.optimization!.seedStatus === "unknown" && p.optimization!.gainS === undefined)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("evaluates strict drawn-geometry timing separately from Normal and compares its meaningful gain", () => {
    const { path, robot } = fixture([{ x: 6.5, y: 2 }, { x: 7.5, y: 2 }, { x: 8.5, y: 2 }, { x: 10, y: 2 }]);
    path.waypoints.forEach((w) => { w.stop = true; });
    path.constraints.maxVel = 0.5;
    const original = structuredClone(path);
    const timing = vi.spyOn(fixedFinal, "optimizeFixedGeometryFinal");
    try {
      const result = optimizeRouteFinal({ path, robot }, { maximumEvaluations: 3 });
      expect(result.seedStatus).toBe("valid");
      const seedCall = timing.mock.calls.findIndex(([input]) => JSON.stringify(geometryFromPath(input.path)) === JSON.stringify(geometryFromPath(path)));
      expect(seedCall).toBeGreaterThanOrEqual(0);
      const timedSeed = timing.mock.results[seedCall].value as PlannerResult;
      expect(timedSeed.totalTimeS).toBeLessThan(result.baseline!.totalTimeS - 0.02);
      expect(result.candidate!.optimization!.gainS).toBeGreaterThan(0.02);
      expect(result.candidate!.totalTimeS).toBeLessThanOrEqual(timedSeed.totalTimeS);
      expect(routeCandidateFailure({ path, robot }, result.candidate!)).toBeUndefined();
    } finally {
      timing.mockRestore();
    }
    expect(path).toEqual(original);
  });

  it("permits strictly valid nonstopped seed corners while newly generated handles are smooth", () => {
    const { path, robot } = fixture([{ x: 6.5, y: 2 }, { x: 8, y: 2.5 }, { x: 10, y: 2 }]);
    path.waypoints[1].prevC = { x: 7.5, y: 2.5 };
    path.waypoints[1].nextC = { x: 8.5, y: 2.4 };
    path.waypoints[1].linked = false;
    path.waypoints[1].corner = true;
    path.constraints.maxVel = 0.5;
    const result = optimizeRouteFinal({ path, robot }, { maximumEvaluations: 2 });
    expect(result.seedStatus, JSON.stringify(result.statistics)).toBe("valid");
    expect(result.baseline).toBeDefined();
    const canonical = routeCandidates({ path, robot }, () => false).next().value!;
    const w = canonical.knots[1];
    expect((w.x - w.prevC.x) * (w.nextC.y - w.y) - (w.y - w.prevC.y) * (w.nextC.x - w.x)).toBeCloseTo(0, 10);
  });

  it("qualifies actual implicit stopped turns and rejects a shortened angular profile", () => {
    const { path, robot } = fixture([{ x: 6.5, y: 2 }, { x: 8, y: 2 }, { x: 10, y: 2 }]);
    path.waypoints[1] = { ...path.waypoints[1], stop: true, thetaOn: true, theta: 30 };
    let qualifiedTurns = 0;
    for (const geometry of [...routeCandidates({ path, robot }, () => false)].slice(0, 9)) {
      const planning = routePlanningPath(path, geometry);
      const raw = optimizeFixedGeometryFinal({ path: planning, robot });
      const result = routeResultToSource(raw, geometry, planning);
      expect(routeCandidateFailure({ path, robot }, result)).toBeUndefined();
      const turn = result.stationaryActions!.find((a) => a.kind === "turn")!;
      expect(turn).toBeDefined();
      qualifiedTurns++;
      const shortened = structuredClone(result);
      const removed = (turn.endTimeS - turn.startTimeS) * 0.9;
      const time = (t: number) => t <= turn.startTimeS ? t : t >= turn.endTimeS ? t - removed : turn.startTimeS + (t - turn.startTimeS) * 0.1;
      shortened.totalTimeS -= removed;
      shortened.samples.forEach((s) => { s.t = time(s.t); });
      shortened.stationaryActions!.forEach((a) => { a.startTimeS = time(a.startTimeS); a.endTimeS = time(a.endTimeS); });
      expect(routeCandidateFailure({ path, robot }, shortened)).toBe("Stationary turn exceeds physical angular limits.");
      expect(routeCandidateIssue({ path, robot }, shortened)).toEqual({ message: "Stationary turn exceeds physical angular limits.", concrete: false });
    }
    expect(qualifiedTurns).toBe(9);
  });
});
