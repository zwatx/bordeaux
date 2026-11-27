import { describe, expect, it } from "vitest";
import { REBUILT_2026_FIELD } from "../src/core/field/rebuilt2026";
import { headingForTagsBlocker, optimizeHeadingForTags, tagCoverageOf } from "../src/core/planners/headingForTags";
import { planPath } from "../src/core/planners/planPath";
import { blankPath, buildWaypoints, createDemoProject } from "../src/core/project/defaults";
import { fieldTags } from "../src/core/tagVisibility";
import type { PathDoc, PlannerInput, RobotCamera, RobotConfig } from "../src/core/types";
import { validateProject } from "../src/core/validation";

/*
 * Ways the heading optimizer can fail, written before the code:
 *  1. A robot without cameras, or a field without tags, gets a result.
 *  2. A tank robot gets a result, though its heading follows the path.
 *  3. The drawn curve moves: a waypoint, a handle or a stop changes.
 *  4. A heading the user set changes: a waypoint's angle, or a rotation target already on the path.
 *  5. Headings are added on a stretch whose heading rule is not "targets" (tangent, manual or look-at).
 *  6. The promised coverage is only the search's estimate, and the planner's real result is no better or is worse.
 *  7. The reported before and after numbers do not match a fresh plan of the drawn and the returned path.
 *  8. The result is far slower than the drawn path.
 *  9. A path with nothing to gain still gets a result, or running it again on its own result piles on more headings.
 * 10. The returned path does not validate, or carries a heading that changes nothing.
 * 11. The same input gives different results on two runs.
 * 12. The path it was given is changed in place.
 * 13. The reason given for having no result is wrong, or a reason is given for a path the search can work on.
 * 14. The plan handed back for preview is not the planner's plan of the returned path.
 */
const tags = fieldTags(REBUILT_2026_FIELD);
const camera = (id: string, yawDeg: number, x: number): RobotCamera =>
  ({ id, name: id, horizontalFovDeg: 70, verticalFovDeg: 50, positionM: { x, y: 0, z: 0.3 }, yawDeg, pitchDeg: 15, maxRangeM: 3 });
/** Front and rear cameras that read to 3 m. Synthetic mounts, not a real robot. */
const robot = (patch: Partial<RobotConfig> = {}): RobotConfig =>
  ({ ...createDemoProject().robot, cameras: [camera("front", 0, 0.4), camera("rear", 180, -0.4)], ...patch });
/** A diagonal across the neutral zone that turns a quarter turn. Drawn, the robot reads two tags almost nowhere on it. */
const diagonal = (patch: Partial<PathDoc> = {}): PathDoc => ({
  ...blankPath("Diagonal"),
  headingMode: "targets",
  waypoints: buildWaypoints([
    { x: 2.059, y: 2.8215, theta: 180, thetaOn: true, segType: "bezier" },
    { x: -0.011, y: -0.0085, theta: 0, thetaOn: false, segType: "bezier" },
    { x: -2.141, y: -2.8785, theta: 270, thetaOn: true, segType: "bezier" },
  ]),
  ...patch,
});
const input = (path: PathDoc, forRobot: RobotConfig = robot()): PlannerInput => ({ path, robot: forRobot, field: createDemoProject().field });
const coverage = (path: PathDoc, forRobot: RobotConfig = robot()) => {
  const plan = planPath(input(path, forRobot));
  expect(plan.status).toBe("ok");
  return tagCoverageOf(plan.trajectory!.samples, forRobot.cameras ?? [], tags);
};

describe("heading for tags", () => {
  const drawn = diagonal();
  const result = optimizeHeadingForTags(input(drawn), tags);

  it("adds rotation targets that the planner confirms read more tags", () => {
    expect(result).not.toBeNull();
    expect(result!.addedTargets.length).toBeGreaterThan(0);
    expect(result!.path.targets).toEqual(result!.addedTargets);
    // The numbers are the planner's own, for the drawn and the returned path.
    expect(result!.before).toEqual(coverage(drawn));
    expect(result!.after).toEqual(coverage(result!.path));
    expect(result!.after.twoTagS).toBeGreaterThan(result!.before.twoTagS + 0.3);
    expect(result!.after.anyTagS).toBeGreaterThanOrEqual(result!.before.anyTagS - 1e-9);
  });

  it("hands back the planner's plan of the returned path, for preview", () => {
    const plan = planPath(input(result!.path));
    expect(result!.trajectory.totalTimeS).toBe(plan.trajectory!.totalTimeS);
    expect(result!.trajectory.samples).toEqual(plan.trajectory!.samples);
    expect(result!.after.totalS).toBeCloseTo(result!.trajectory.totalTimeS, 6);
  });

  it("says why a path has nothing to search", () => {
    expect(headingForTagsBlocker(input(drawn), tags)).toBeNull();
    expect(headingForTagsBlocker(input(drawn, robot({ cameras: undefined })), tags)).toBe("no-cameras");
    expect(headingForTagsBlocker(input(drawn, robot({ cameras: [] })), tags)).toBe("no-cameras");
    expect(headingForTagsBlocker(input(drawn), [])).toBe("no-tags");
    expect(headingForTagsBlocker(input(drawn, robot({ drive: "tank" })), tags)).toBe("tank");
    expect(headingForTagsBlocker(input(diagonal({ headingMode: "tangent" })), tags)).toBe("no-free-heading");
    const mixed = diagonal({ headingMode: "manual" });
    mixed.waypoints[1] = { ...mixed.waypoints[1], segmentHeadingMode: "targets" };
    expect(headingForTagsBlocker(input(mixed), tags)).toBeNull();
    // Cameras come before the drive type: a tank robot without cameras is first told to add one.
    expect(headingForTagsBlocker(input(drawn, robot({ drive: "tank", cameras: undefined })), tags)).toBe("no-cameras");
  });

  it("stays close to the drawn path's time", () => {
    expect(result!.after.totalS).toBeLessThanOrEqual(result!.before.totalS * 1.1 + 0.05);
  });

  it("keeps the drawn curve and every heading the user set", () => {
    const { targets: _targets, ...rest } = result!.path;
    const { targets: _drawnTargets, ...drawnRest } = drawn;
    expect(rest).toEqual(drawnRest);
    const pinned = diagonal({ targets: [{ f: 0.5, deg: 200 }] });
    const again = optimizeHeadingForTags(input(pinned), tags);
    if (again) {
      expect(again.path.targets.slice(0, 1)).toEqual(pinned.targets);
      expect(again.path.waypoints).toEqual(pinned.waypoints);
      for (const target of again.addedTargets) expect(Math.abs(target.f - 0.5)).toBeGreaterThan(0.03);
    }
    expect(pinned.targets).toEqual([{ f: 0.5, deg: 200 }]);
  });

  it("returns a valid path whose every added heading earns its place", () => {
    expect(validateProject({ ...createDemoProject(), robot: robot(), paths: [result!.path], editor: { activePathId: result!.path.id } }).issues).toEqual([]);
    for (const target of result!.addedTargets) {
      expect(target.f).toBeGreaterThan(0);
      expect(target.f).toBeLessThan(1);
      expect(Number.isInteger(target.deg)).toBe(true);
      const without = { ...result!.path, targets: result!.path.targets.filter((other) => other !== target) };
      const lost = coverage(without);
      expect(lost.twoTagS + lost.anyTagS, `target at ${target.f}`).toBeLessThan(result!.after.twoTagS + result!.after.anyTagS);
    }
    const fractions = result!.addedTargets.map((target) => target.f);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
  });

  it("finds nothing more on its own result", () => {
    expect(optimizeHeadingForTags(input(result!.path), tags)).toBeNull();
  });

  it("gives the same result twice and leaves its input alone", () => {
    const before = structuredClone(drawn);
    // The planner stamps each plan with how long it took to solve. That one clock reading is left out; every sample,
    // heading and number the search decided must match.
    const steady = (value: typeof result) => ({ ...value!, trajectory: { ...value!.trajectory, optimization: { ...value!.trajectory.optimization, solveTimeMs: 0 } } });
    expect(steady(optimizeHeadingForTags(input(drawn), tags))).toEqual(steady(result));
    expect(drawn).toEqual(before);
  });

  it("returns nothing without cameras, without tags, or for a tank robot", () => {
    expect(optimizeHeadingForTags(input(drawn, robot({ cameras: undefined })), tags)).toBeNull();
    expect(optimizeHeadingForTags(input(drawn), [])).toBeNull();
    expect(optimizeHeadingForTags(input(drawn, robot({ drive: "tank" })), tags)).toBeNull();
  });

  it("adds no heading where the heading rule is not targets", () => {
    for (const headingMode of ["tangent", "manual"] as const) expect(optimizeHeadingForTags(input(diagonal({ headingMode })), tags)).toBeNull();
    // Only the second stretch follows targets, so every added heading lies on it.
    const mixed = diagonal();
    mixed.waypoints[0] = { ...mixed.waypoints[0], segmentHeadingMode: "tangent" };
    const half = optimizeHeadingForTags(input(mixed), tags);
    const boundary = 0.5;
    if (half) for (const target of half.addedTargets) expect(target.f).toBeGreaterThan(boundary - 0.1);
  });
}, 120000);
