import { describe, expect, it } from "vitest";
// @ts-expect-error The timeline model is a JavaScript module.
import { buildTimeline, fAtT, featurePositionPatch, tAtF, vAtT, zoneFractions } from "../src/renderer/components/pathTimelineModel";
// @ts-expect-error The problem wording is a JavaScript module.
import { isWholeIssue, plainProblem } from "../src/renderer/components/planProblems";
import { createUnitPreferences } from "../src/renderer/lib/unitPreferences";

const trace = [
  { t: 0, f: 0, velocityMps: 0, accelerationMps2: 2, angularVelocityRadps: 0, curvatureInvM: 0 },
  { t: 1, f: 0.5, velocityMps: 2, accelerationMps2: 0, angularVelocityRadps: 0, curvatureInvM: 0.1 },
  // A one-second hold at the stop: time advances while the fraction does not.
  { t: 2, f: 0.5, velocityMps: 0, accelerationMps2: 0, angularVelocityRadps: Math.PI / 2, curvatureInvM: 0 },
  { t: 3, f: 1, velocityMps: 0, accelerationMps2: -2, angularVelocityRadps: 0, curvatureInvM: 0 },
];

describe("path timeline model", () => {
  it("prefers the planner trace and keeps holds as flat time", () => {
    const tl = buildTimeline({ trajectorySamples: trace, prof: { totalTime: 3 }, wpFrac: [0, 0.5, 1] });
    expect(tl.empty).toBe(false);
    expect(tl.total).toBe(3);
    expect(tAtF(tl, 0.5)).toBe(1);
    expect(tAtF(tl, 0.75)).toBeCloseTo(2.5, 9);
    expect(fAtT(tl, 1.5)).toBe(0.5);
    expect(vAtT(tl, 0.5)).toBeCloseTo(1, 9);
    expect(vAtT(tl, 2, "w")).toBeCloseTo(90, 9);
  });

  it("uses the final trajectory when there is no editing trace", () => {
    const tl = buildTimeline({ finalTrajectory: { samples: trace }, prof: { totalTime: 3 } });
    expect(tl.total).toBe(3);
    expect(tAtF(tl, 1)).toBe(3);
  });

  it("reports no timing for geometry that has not been timed yet", () => {
    const tl = buildTimeline({ sample: { pts: [{ s: 0 }, { s: 2 }] }, prof: { t: [0, 0], totalTime: 0 } });
    expect(tl.empty).toBe(true);
  });

  it("places zones by their own anchor when the planning result omits them", () => {
    const doc = { waypoints: [], ranges: [{ anchor: "dist", d0: 1, d1: 3 }, { anchor: "param", f0: 0.2, f1: 0.4 }] };
    const derived = { sample: { pts: [{ s: 0 }, { s: 4 }], length: 4, wpIdx: [0, 1] }, effRanges: [] };
    const zones = zoneFractions(doc, derived);
    expect(zones[0].f0).toBeCloseTo(0.25, 9);
    expect(zones[0].f1).toBeCloseTo(0.75, 9);
    expect(zones[1]).toMatchObject({ f0: 0.2, f1: 0.4 });
  });

  it("keeps distance-anchored features in distance", () => {
    expect(featurePositionPatch({ anchor: "dist" }, 0.5, { sample: { length: 8 } })).toEqual({ f: 0.5, d: 4 });
    expect(featurePositionPatch({ anchor: "param" }, 1.2, {})).toEqual({ f: 1 });
  });
});

describe("plain problem wording", () => {
  it.each(["metric", "imperial"])("preserves tiny angular limits in %s problem details", (system) => {
    const units = createUnitPreferences({ getItem: () => system, setItem: () => undefined }, { dataset: {} });
    expect(plainProblem({ code: "angular-velocity", f0: 0.2, f1: 0.3, measured: 2.6, limit: 0.004, unit: "deg/s" }, 4, units).values)
      .toBe("2.6 °/s needed · limit 0.004 °/s");
  });

  it("names the consequence from the structured code, never the message text", () => {
    const issue = { code: "unreachable-acceleration", severity: "error", f0: 0.2, f1: 0.4, segment: 1, measured: 350, limit: 5.82, unit: "m/s²", constraint: "motor-acceleration", message: "Required 350 m/s²" };
    expect(plainProblem(issue, 4)).toEqual({
      text: "Can’t speed up in time", where: "Segment 2", values: "350 m/s² needed · limit 5.82 m/s²", by: "Motors",
      engine: "Required 350 m/s²", fixable: true,
    });
  });

  it("keeps the engine message for unknown codes and offers no fix for the whole path", () => {
    const issue = { code: "jerk", severity: "warning", f0: 0, f1: 1, message: "Jerk limit exceeded" };
    expect(isWholeIssue(issue)).toBe(true);
    expect(plainProblem(issue, 3)).toMatchObject({ text: "Jerk limit exceeded", where: "Whole path", fixable: false, engine: null });
  });

  it("names waypoints like the editor does", () => {
    expect(plainProblem({ code: "speed-step", f0: 0.5, f1: 0.5, waypoint: 2, measured: 1.5 }, 5)).toMatchObject({ where: "Waypoint 2", values: "Jumps 1.50 m/s" });
    expect(plainProblem({ code: "speed-step", f0: 1, f1: 1, waypoint: 4 }, 5).where).toBe("End");
  });

  it("shows measured and limit values in the display units, keeping the engine text", () => {
    const units = (system: string) => createUnitPreferences({ getItem: () => system, setItem: () => undefined }, { dataset: {} });
    const metric = units("metric"), imperial = units("imperial");
    const accel = { code: "linear-acceleration", f0: 0.2, f1: 0.4, segment: 1, measured: 2, limit: 1, unit: "m/s²", message: "Required 2 m/s²" };
    expect(plainProblem(accel, 4, metric)).toMatchObject({ values: "2.00 m/s² needed · limit 1.00 m/s²", engine: "Required 2 m/s²" });
    expect(plainProblem(accel, 4, imperial)).toMatchObject({ values: "6.56 ft/s² needed · limit 3.28 ft/s²", engine: "Required 2 m/s²" });
    const boundary = { code: "boundary-velocity", f0: 1, f1: 1, waypoint: 3, measured: 1.5, limit: 0, unit: "m/s" };
    expect(plainProblem(boundary, 4, imperial).values).toBe("4.92 ft/s · expected 0.00 ft/s");
    // A speed step without a stored unit is still a speed.
    expect(plainProblem({ code: "speed-step", f0: 0.5, f1: 0.5, waypoint: 2, measured: 1.5 }, 5, imperial).values).toBe("Jumps 4.92 ft/s");
    // Angular values have no imperial form; their degree label stays.
    const turn = { code: "angular-velocity", f0: 0.2, f1: 0.3, measured: 400, limit: 360, unit: "deg/s" };
    expect(plainProblem(turn, 4, imperial).values).toBe("400 °/s needed · limit 360 °/s");
  });
});
