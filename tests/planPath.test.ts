import corpus from "../benchmarks/planner-corpus/v2/corpus.bordeaux.json";
import { describe, expect, it, vi } from "vitest";
import { buildBdxExportWithPlannerResults } from "../src/shared/export/bdx";
import { buildWaypoints, createDemoProject } from "../src/shared/project/defaults";
import { getPlanner } from "../src/shared/planners";
import * as plannerRegistry from "../src/shared/planners";
import { planPath, type PlanPathResult } from "../src/shared/planners/planPath";
import type { PlannerInput, PlannerResult, SegmentType } from "../src/shared/types";

type DemoProject = ReturnType<typeof createDemoProject>;

function project(edit: (path: DemoProject["paths"][number], project: DemoProject) => void): DemoProject {
  const result = createDemoProject();
  edit(result.paths[0], result);
  return result;
}

function inputOf(source: DemoProject): PlannerInput {
  return { path: source.paths[0], robot: source.robot };
}

/** Timing diagnostics include wall-clock solve time; everything else must match. */
function withoutSolveTime(result: PlannerResult) {
  return { ...result, optimization: result.optimization ? { ...result.optimization, solveTimeMs: 0 } : undefined };
}

function expectDrawable(result: PlanPathResult) {
  expect(result.bestEffort).not.toBeNull();
  const samples = result.bestEffort!.samples;
  expect(samples.length).toBeGreaterThanOrEqual(2);
  for (let index = 1; index < samples.length; index += 1) {
    expect(samples[index].t).toBeGreaterThanOrEqual(samples[index - 1].t);
  }
  expect(Number.isFinite(result.bestEffort!.totalTimeS)).toBe(true);
  expect(result.bestEffort!.totalTimeS).toBe(samples.at(-1)!.t);
}

function expectWellFormedIssues(result: PlanPathResult) {
  for (const issue of result.issues) {
    expect(issue.f0).toBeGreaterThanOrEqual(0);
    expect(issue.f1).toBeLessThanOrEqual(1);
    expect(issue.f0).toBeLessThanOrEqual(issue.f1);
    expect(issue.message.split(/\s+/).length).toBeLessThanOrEqual(8);
  }
}

// A 5 m straight line entered at 4 m/s, with a 0.5 m/s zone starting 0.1 m in.
const brakingIntoZone = () => project((path) => {
  path.startVel = 4;
  path.waypoints = buildWaypoints([{ x: 2, y: 2, segType: "line" }, { x: 7, y: 2 }]);
  path.ranges = [{ anchor: "param", f0: 0.02, f1: 0.3, maxVel: 0.5 }];
});

// A slow zone that ends 0.1 m before a 3 m/s goal speed on the second segment.
const zoneBeforeFastGoal = () => project((path) => {
  path.goalVel = 3;
  path.waypoints = buildWaypoints([
    { x: 2, y: 2, segType: "line" },
    { x: 4, y: 2, segType: "line" },
    { x: 7, y: 2 },
  ]);
  path.ranges = [{ anchor: "param", f0: 0.5, f1: 0.98, maxVel: 0.5 }];
});

// A half-turn in 0.5 m while moving at 1 m/s at both ends.
const headingFlipAtSpeed = () => project((path) => {
  path.headingMode = "manual";
  path.startVel = 1;
  path.goalVel = 1;
  path.waypoints = buildWaypoints([
    { x: 1, y: 2, theta: 0, thetaOn: true, segType: "line" },
    { x: 1.5, y: 2, theta: 180, thetaOn: true },
  ]);
});

// An interior stop whose turn heading disagrees with the outgoing segment.
const mismatchedTurn = () => project((path) => {
  path.waypoints = buildWaypoints([
    { x: 2, y: 2, segType: "line" },
    { x: 4, y: 2, segType: "line", stop: true, turnInPlace: { headingDeg: 90 } },
    { x: 7, y: 2 },
  ]);
});

describe("planPath", () => {
  it("returns the existing planner result unchanged for a feasible path", () => {
    const source = project(() => {});
    const expected = getPlanner("profiledSpline").generate(inputOf(source));
    const result = planPath(inputOf(source));

    expect(result.status).toBe("ok");
    expect(result.issues).toEqual([]);
    expect(withoutSolveTime(result.trajectory!)).toEqual(withoutSolveTime(expected));
    expect(result.bestEffort).toEqual({ samples: result.trajectory!.samples, totalTimeS: result.trajectory!.totalTimeS });
  });

  it("honors an explicit sample density for the strict result", () => {
    const source = project(() => {});
    const expected = getPlanner("profiledSpline").generate({ ...inputOf(source), samplesPerSegment: 14 });
    const result = planPath(inputOf(source), { samplesPerSegment: 14 });

    expect(result.status).toBe("ok");
    expect(withoutSolveTime(result.trajectory!)).toEqual(withoutSolveTime(expected));
  });

  it("localizes braking that cannot reach a slow zone to the stretch before the zone", () => {
    const source = brakingIntoZone();
    // The strict planner refuses this path today, and export must keep refusing it.
    expect(getPlanner("profiledSpline").generate(inputOf(source)).diagnostics.some((issue) => issue.severity === "error")).toBe(true);
    expect(() => buildBdxExportWithPlannerResults(source)).toThrow();

    const result = planPath(inputOf(source));
    expect(result.status).toBe("infeasible");
    expect(result.trajectory).toBeNull();
    expectDrawable(result);
    expectWellFormedIssues(result);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      code: "unreachable-deceleration",
      severity: "error",
      f0: 0,
      segment: 0,
      constraint: "linear-deceleration",
      unit: "m/s²",
      message: "Braking 87.4 m/s² over 6.4 m/s²",
    });
    expect(result.issues[0].f1).toBeCloseTo(0.02, 9);
    // Report the actual local overload, rather than averaging it with earlier braking.
    expect(result.issues[0].measured).toBeCloseTo(87.4278, 6);
    expect(result.issues[0].limit).toBeLessThan(result.issues[0].measured!);
  });

  it.each([0.01, 0.00001])("retains tiny angular limits and both units in real planner issues (%s)", (limit) => {
    // The native Details fixture: authored corpus slalom with a tiny angular zone.
    const source = project((path) => {
      Object.assign(path, structuredClone(corpus.paths.find((entry) => entry.id === "corpus-neutral-slalom")!));
      path.targets = [{ f: 0.5, deg: 135 }];
      path.ranges = [{ anchor: "param", f0: 0.3, f1: 0.65, maxAngVel: limit, maxAngAccel: limit }];
    });
    const before = structuredClone(source);
    const result = planPath(inputOf(source));

    expect(result.status).toBe("infeasible");
    expect(result.trajectory).toBeNull();
    expectDrawable(result);
    expectWellFormedIssues(result);
    expect(() => buildBdxExportWithPlannerResults(source)).toThrow();
    expect(source).toEqual(before);
    const angular = result.issues.filter((issue) => (
      (issue.code === "angular-velocity" || issue.code === "angular-acceleration")
      && Math.abs(issue.limit! - limit) < limit * 1e-9
    ));
    expect(angular.length).toBeGreaterThan(0);
    for (const issue of angular) {
      const match = /^(?:Turn rate|Turn accel) (\S+) (°\/s(?:²)?) over (\S+) \2$/.exec(issue.message);
      expect(match).not.toBeNull();
      expect(Number(match![3])).toBe(limit);
      expect(Number(match![1])).toBeGreaterThan(Number(match![3]));
      expect(issue.measured).toBeGreaterThan(issue.limit!);
      expect(issue.severity).toBe("error");
      expect(issue.unit).toBe(issue.code === "angular-velocity" ? "deg/s" : "deg/s²");
    }
  });

  it.each(["acceleration", "deceleration"] as const)("distinguishes a near-limit linear %s violation", (kind) => {
    // Keep acceleration at low speed so motor falloff does not bind before the linear cap.
    const distance = kind === "acceleration" ? 0.001 : 1;
    const source = project((path) => {
      path.headingMode = "tangent";
      path.constraints.maxAccel = 1;
      path.constraints.maxDecel = 1;
      path.waypoints = buildWaypoints([{ x: 2, y: 2, segType: "line" }, { x: 2 + distance, y: 2 }]);
      // One interval needs 0.994 m/s², just above the existing 0.99 safety cap.
      // Both numbers previously rendered as 1.0; no tolerance is changed here.
      path.startVel = kind === "deceleration" ? Math.sqrt(2 * distance * 0.994) : 0;
      path.goalVel = kind === "acceleration" ? Math.sqrt(2 * distance * 0.994) : 0;
    });
    const before = structuredClone(source);
    const result = planPath(inputOf(source), { samplesPerSegment: 1 });

    expect(result.status).toBe("infeasible");
    expect(result.trajectory).toBeNull();
    expectDrawable(result);
    expectWellFormedIssues(result);
    expect(source).toEqual(before);
    const issue = result.issues.find((entry) => entry.code === `unreachable-${kind}`)!;
    expect(issue).toMatchObject({ severity: "error", f0: 0, f1: 1, segment: 0, unit: "m/s²" });
    expect(issue.measured).toBeCloseTo(0.994, 10);
    expect(issue.limit).toBeCloseTo(0.99, 10);
    expect(issue.message).toBe(`${kind === "acceleration" ? "Accel" : "Braking"} 0.994 m/s² over 0.99 m/s²`);
    expect(() => buildBdxExportWithPlannerResults(source)).toThrow();
  });

  it("localizes an unreachable goal speed to the run after the zone", () => {
    const result = planPath(inputOf(zoneBeforeFastGoal()));

    expect(result.status).toBe("infeasible");
    expectDrawable(result);
    expectWellFormedIssues(result);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ code: "unreachable-acceleration", f1: 1, segment: 1, unit: "m/s²" });
    expect(result.issues[0].f0).toBeCloseTo(0.98, 9);
    // Earlier intervals ride the acceleration limit; report the local overload.
    expect(result.issues[0].measured).toBeCloseTo(91.230769230769, 6);
  });

  it("reports only the ends of a heading flip that angular limits cannot meet at speed", () => {
    const result = planPath(inputOf(headingFlipAtSpeed()));

    expect(result.status).toBe("infeasible");
    expectDrawable(result);
    expectWellFormedIssues(result);
    expect(result.issues.length).toBeGreaterThan(0);
    for (const issue of result.issues) {
      expect(issue.segment).toBe(0);
      expect(issue.f1 - issue.f0).toBeLessThan(0.05);
    }
    expect(result.issues[0]).toMatchObject({ code: "unreachable-speed", f0: 0, constraint: "angular-acceleration" });
    expect(result.issues.at(-1)!.f1).toBe(1);
  });

  it("pins a stationary-action error to its waypoint", () => {
    const result = planPath(inputOf(mismatchedTurn()));

    expect(result.status).toBe("infeasible");
    expectDrawable(result);
    expect(result.issues).toEqual([{
      code: "turn-in-place",
      severity: "error",
      f0: 0.4,
      f1: 0.4,
      segment: 1,
      waypoint: 1,
      message: "Turn heading must match next segment",
      detail: "Interior turn heading must match the outgoing segment heading",
    }]);
  });

  it("never throws for garbage input", () => {
    const valid = inputOf(project(() => {}));
    const garbage: unknown[] = [
      undefined,
      null,
      {},
      { path: valid.path },
      { robot: valid.robot },
      { ...valid, path: { ...valid.path, waypoints: valid.path.waypoints.slice(0, 1) } },
      { ...valid, path: { ...valid.path, waypoints: [] } },
      { ...valid, path: { ...valid.path, waypoints: [{ ...valid.path.waypoints[0], x: Number.NaN }, valid.path.waypoints[1]] } },
      { ...valid, path: { ...valid.path, waypoints: [valid.path.waypoints[0], { ...valid.path.waypoints[1], nextC: undefined }] } },
      { ...valid, path: { ...valid.path, constraints: { ...valid.path.constraints, maxAccel: Number.POSITIVE_INFINITY } } },
      { ...valid, path: { ...valid.path, constraints: { ...valid.path.constraints, maxAngDecel: -1 } } },
      { ...valid, path: { ...valid.path, startVel: Number.NaN } },
      { ...valid, robot: { ...valid.robot, maxSpeed: 0 } },
      { ...valid, samplesPerSegment: 0 },
    ];
    for (const input of garbage) {
      const result = planPath(input as PlannerInput);
      expect(["ok", "degraded", "infeasible"]).toContain(result.status);
      expectWellFormedIssues(result);
      if (result.status !== "ok") {
        expect(result.trajectory).toBeNull();
        expect(result.issues.length).toBeGreaterThan(0);
      }
      if (result.bestEffort) expectDrawable(result);
    }
    expect(planPath({ ...valid, path: { ...valid.path, waypoints: valid.path.waypoints.slice(0, 1) } }).issues[0])
      .toMatchObject({ code: "invalid-input", message: "Needs at least two waypoints" });
    // Bad limits leave the geometry drawable.
    expectDrawable(planPath({ ...valid, path: { ...valid.path, constraints: { ...valid.path.constraints, maxAngDecel: -1 } } }));
  });

  it("keeps valid geometry drawable when robot data is missing", () => {
    const source = project(() => {});
    const result = planPath({ path: source.paths[0] } as PlannerInput);
    expect(result.status).toBe("infeasible");
    expect(result.issues[0]).toMatchObject({ code: "invalid-input", message: "Robot is missing" });
    expectDrawable(result);
  });

  it("enforces the sample budget before malformed-heading fallback", () => {
    const source = project((path) => {
      path.waypoints = buildWaypoints([
        { x: 1, y: 2, segType: "line" }, { x: 2, y: 2, segType: "line" },
        { x: 3, y: 2, segType: "line" }, { x: 4, y: 2 },
      ]);
      path.waypoints[0].theta = Number.NaN;
    });
    const result = planPath(inputOf(source), { samplesPerSegment: 85_000 });
    expect(result.bestEffort).toBeNull();
    expect(result.issues[0]).toMatchObject({ code: "invalid-input", message: "Path has too many segments" });
  });

  it("reports identical stationary-action errors at each affected waypoint", () => {
    const source = project((path) => {
      path.waypoints = buildWaypoints([
        { x: 1, y: 2, segType: "line" },
        { x: 2, y: 2, segType: "line", stop: true, turnInPlace: { headingDeg: 90 } },
        { x: 3, y: 2, segType: "line", stop: true, turnInPlace: { headingDeg: 90 } },
        { x: 4, y: 2 },
      ]);
    });
    const result = planPath(inputOf(source));
    expectDrawable(result);
    expect(result.issues.filter((issue) => issue.code === "turn-in-place").map((issue) => issue.waypoint)).toEqual([1, 2]);
  });

  it("rejects malformed stationary settings and zone limits before planning", () => {
    const validJiggle = { distanceM: 0.1, strokes: 2, startDeg: 0, stepDeg: 180, strokeTimeS: 0.2 };
    const badValues = ["bad", null, Number.NaN, Number.POSITIVE_INFINITY, -1];
    for (const value of badValues) {
      for (const field of Object.keys(validJiggle)) {
        if (value === -1 && (field === "startDeg" || field === "stepDeg")) continue;
        const source = project((path) => {
          path.waypoints.at(-1)!.jiggle = { ...validJiggle, [field]: value } as typeof validJiggle;
        });
        const result = planPath(inputOf(source));
        expect(result.issues[0].code).toBe("invalid-input");
        expectDrawable(result);
      }
      const source = project((path) => {
        path.waypoints.at(-1)!.jiggle = validJiggle;
        path.ranges = [{ anchor: "param", f0: 0, f1: 1, maxAccel: value as number }];
      });
      const result = planPath(inputOf(source));
      expect(result.issues[0]).toMatchObject({ code: "invalid-input", constraint: "maxAccel" });
      expectDrawable(result);
    }
  });


  it("refuses a finite strict result with decreasing timestamps", () => {
    const source = project(() => {});
    const strict = getPlanner("profiledSpline").generate(inputOf(source));
    const samples = strict.samples.map((sample) => ({ ...sample }));
    samples[2].t = samples[1].t / 2;
    const spy = vi.spyOn(plannerRegistry, "getPlanner").mockReturnValue({
      id: "profiledSpline",
      generate: () => ({ ...strict, samples }),
    });
    try {
      const result = planPath(inputOf(source));
      expect(result.status).not.toBe("ok");
      expect(result.trajectory).toBeNull();
      expectDrawable(result);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects huge finite headings before legacy angle unwrapping", () => {
    for (const heading of [1e30, -1e30, Number.MAX_VALUE]) {
      const source = project((path) => {
        path.headingMode = "manual";
        path.waypoints[0].thetaOn = true;
        path.waypoints[0].theta = heading;
      });
      const result = planPath(inputOf(source));
      expect(result.status).toBe("infeasible");
      expect(result.trajectory).toBeNull();
      expect(result.issues[0]).toMatchObject({ code: "invalid-input", waypoint: 0, message: "Waypoint heading is too large" });
      expectDrawable(result);
    }
  });

  it("rejects enormous heading targets before legacy angle unwrapping", () => {
    for (const deg of [1e30, -1e30, Number.MAX_VALUE]) {
      const source = project((path) => {
        path.headingMode = "targets";
        path.targets = [{ f: 0, deg }, { f: 1, deg: 0 }];
      });
      const result = planPath(inputOf(source));
      expect(result.status).toBe("infeasible");
      expect(result.trajectory).toBeNull();
      expect(result.issues[0]).toMatchObject({ code: "invalid-input", constraint: "targets" });
      expectDrawable(result);
    }
  });

  it("rejects fractional jiggle strokes instead of exposing decreasing timestamps", () => {
    const source = project((path) => {
      path.waypoints.at(-1)!.jiggle = { distanceM: 0.1, strokes: 2.5, startDeg: 0, stepDeg: 90, strokeTimeS: 1 };
      path.waypoints.at(-1)!.wait = 0.1;
    });
    const result = planPath(inputOf(source), { samplesPerSegment: 24 });
    expect(result.status).toBe("infeasible");
    expect(result.trajectory).toBeNull();
    expect(result.issues[0]).toMatchObject({ code: "invalid-input", constraint: "jiggle" });
    expectDrawable(result);
  });

  it("never throws across random waypoint layouts", () => {
    let seed = 0x2468;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const pick = <T>(values: readonly T[]) => values[Math.floor(random() * values.length)];
    const segmentTypes: SegmentType[] = ["bezier", "line", "arc", "clothoid"];
    const statuses = { ok: 0, degraded: 0, infeasible: 0 };
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const source = project((path, demo) => {
        const count = 2 + Math.floor(random() * 4);
        path.headingMode = pick(["targets", "manual", "tangent"] as const);
        path.waypoints = buildWaypoints(Array.from({ length: count }, (_value, index) => ({
          x: 0.5 + random() * 16,
          y: 0.5 + random() * 7,
          theta: random() * 360 - 180,
          thetaOn: random() < 0.5,
          segType: pick(segmentTypes),
          stop: index > 0 && index < count - 1 && random() < 0.2,
        })));
        // Occasionally collapse a waypoint onto its predecessor.
        if (random() < 0.1) path.waypoints[1] = { ...path.waypoints[1], x: path.waypoints[0].x, y: path.waypoints[0].y };
        path.startVel = random() < 0.3 ? random() * 5 : 0;
        path.goalVel = random() < 0.3 ? random() * 5 : 0;
        path.constraints = {
          ...path.constraints,
          maxAccel: 0.5 + random() * 8,
          maxDecel: 0.5 + random() * 8,
          maxAngVel: 30 + random() * 600,
          maxAngAccel: 30 + random() * 900,
        };
        if (random() < 0.3) {
          const f0 = random() * 0.9;
          path.ranges = [{ anchor: "param", f0, f1: Math.min(1, f0 + random() * 0.3), maxVel: 0.1 + random() * 3 }];
        }
        if (random() < 0.15) demo.robot = { ...demo.robot, drive: "tank" };
      });
      let result: PlanPathResult | undefined;
      expect(() => { result = planPath(inputOf(source), { samplesPerSegment: 24 }); }).not.toThrow();
      statuses[result!.status] += 1;
      expectWellFormedIssues(result!);
      if (result!.status === "ok") expect(result!.trajectory).not.toBeNull();
      else expect(result!.issues.length).toBeGreaterThan(0);
      expectDrawable(result!);
    }
    // The layouts must exercise both outcomes, or this test proves nothing.
    expect(statuses.ok).toBeGreaterThan(0);
    expect(statuses.infeasible).toBeGreaterThan(0);
  }, 60_000);
});
