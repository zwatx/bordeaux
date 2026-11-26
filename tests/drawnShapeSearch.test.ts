import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PM } from "../src/core/math/pm";
import { curveDeviation } from "../src/core/planners/corridorFinal";
import { drawnShapeDescent } from "../src/core/planners/drawnShapeDescent";
import { DRAWN_SHAPE_LIMIT_M } from "../src/core/planners/limits";
import { evaluateRouteCandidate, probeRouteCandidate, qualifyRouteSeed } from "../src/core/planners/routeCandidateEvaluation";
import { optimizeDrawnShapeFinal, optimizeDrawnShapeFinalParallel } from "../src/core/planners/routeFinal";
import { routeCandidateFailure } from "../src/core/planners/routeValidation";
import { buildWaypoints } from "../src/core/project/defaults";
import { normalizeProject } from "../src/core/project/normalize";
import type { BordeauxProject, ControlPoint, PlannerInput } from "../src/core/types";

const corpus = normalizeProject(JSON.parse(readFileSync(new URL("../benchmarks/planner-corpus/v2/corpus.bordeaux.json", import.meta.url), "utf8"))) as BordeauxProject;
const base = corpus.paths.find((path) => path.id === "corpus-neutral-stop")!;
// The corner the optimizer UI harness uses: a wide drawn curve whose handles are longer than it needs.
const corner = {
  ...structuredClone(base), id: "corner", headingMode: "targets" as const,
  constraints: { ...base.constraints, maxVel: 4.2, maxAccel: 6.5, maxDecel: 6.5, maxCentripetalAccel: undefined },
  waypoints: [
    { linked: true, thetaOn: true, theta: 180, stop: false, x: 3.8805, y: -3.5155, segType: "bezier", prevC: { x: 4.9235, y: -4.3415 }, nextC: { x: 0.9805, y: -3.3755 } },
    { linked: true, thetaOn: true, theta: 180, stop: false, x: 0.1555, y: -0.5655, segType: "bezier", prevC: { x: 0.0705, y: -3.1655 }, nextC: { x: -0.8875, y: 0.2605 } },
  ],
} as unknown as PlannerInput["path"];
const input: PlannerInput = { path: corner, robot: corpus.robot, samplesPerSegment: 56 };
const angle = (from: ControlPoint, to: ControlPoint) => Math.atan2(to.y - from.y, to.x - from.x);

describe("search that keeps the drawn shape", () => {
  const result = optimizeDrawnShapeFinal(input, DRAWN_SHAPE_LIMIT_M, { budgetMs: 20_000 });

  it("finds a faster curve that keeps every waypoint, handle direction and the limit", () => {
    const candidate = result.candidate!;
    expect(candidate.optimization?.status).toBe("feasible");
    expect(candidate.totalTimeS).toBeLessThan(result.baseline!.totalTimeS);
    const knots = candidate.routeGeometry!.knots;
    corner.waypoints.forEach((waypoint, index) => {
      expect(knots[index]).toMatchObject({ x: waypoint.x, y: waypoint.y });
      for (const key of ["prevC", "nextC"] as const) expect(angle(knots[index], knots[index][key])).toBeCloseTo(angle(waypoint, waypoint[key]!), 9);
    });
    const drawn = PM.sample(corner.waypoints, 1024).pts, shaped = PM.sample(candidate.optimizedPath!.waypoints, 1024).pts;
    expect(curveDeviation(drawn, shaped)).toBeLessThanOrEqual(DRAWN_SHAPE_LIMIT_M);
    expect(routeCandidateFailure(input, candidate)).toBeUndefined();
  });

  it("finds the same curve when its probes and plans run on other threads", async () => {
    const parallel = await optimizeDrawnShapeFinalParallel(input, DRAWN_SHAPE_LIMIT_M, { budgetMs: 20_000 }, {
      parallelism: 2,
      evaluate: async (source, geometry, limits) => evaluateRouteCandidate(source, geometry, limits),
      qualifySeed: async (source) => qualifyRouteSeed(source),
      probe: async (source, geometry) => probeRouteCandidate(source, geometry),
    });
    expect(parallel.candidate?.routeGeometry?.knots).toEqual(result.candidate?.routeGeometry?.knots);
  });

  it("gives up between segments instead of checking every segment's moves first", () => {
    // Checking a move against the limit costs more the more waypoints there are; on 24 a whole round took most of a second.
    const points = Array.from({ length: 24 }, (_, index) => ({ x: -6 + index * 0.5, y: (index % 2) * 2.5 - 1.25 }));
    const long: PlannerInput = { ...input, path: { ...structuredClone(base), waypoints: buildWaypoints(points), headingMode: "manual" } };
    let timedDrawn = false;
    const descent = drawnShapeDescent(long, DRAWN_SHAPE_LIMIT_M, {
      enough: () => false,
      // Out of time as soon as the drawn curve has been timed, before the first sweep builds its moves.
      giveUp: () => timedDrawn,
    }, 4);
    const drawn = descent.next();
    expect(drawn.done).toBe(false);
    const resumedAt = performance.now();
    timedDrawn = true;
    const step = descent.next((drawn.value as unknown[]).map(() => 1));
    expect(step).toEqual({ done: true, value: [] });
    expect(performance.now() - resumedAt).toBeLessThan(100);
  });
});
