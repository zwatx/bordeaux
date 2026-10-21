import { describe, expect, it } from "vitest";
import { alignWaypointHandles, duplicateWaypoint, moveWaypointTo, removeWaypoint, reorderWaypoint, reversePath } from "../src/renderer/lib/pathEditing";
import { blankRoutine, freshProject, routineState, uniqueItemName, withRoutineState } from "../src/renderer/lib/editorProject";
import { blankPath, buildWaypoints, createDemoProject } from "../src/shared/project/defaults";
import { normalizeProject } from "../src/shared/project/normalize";
import type { JiggleAction } from "../src/shared/types";

function path() {
  const path = blankPath();
  path.waypoints = buildWaypoints([
    { x: 2, y: 2, segType: "bezier", segmentHeadingMode: "tangent" },
    { x: 4, y: 3, segType: "line", segmentHeadingMode: "manual", segmentFollowMode: "position", segmentLookAt: { x: 7, y: 4 } },
    { x: 6, y: 2, segType: "bezier", segmentHeadingMode: "lookAt" },
    { x: 8, y: 3 },
  ]);
  path.ranges = [{ ...path.constraints, anchor: "wp", f0: 0, f1: 1, w0: 0, w1: 1 }];
  return path;
}
const jiggle: JiggleAction = { distanceM: 0.1, strokes: 2, startDeg: 0, stepDeg: 90, strokeTimeS: 0.2 };

describe("editor waypoint operations", () => {
  it("uses the actual clamped displacement when moving a waypoint and its controls", () => {
    const draft = path(), waypoint = draft.waypoints[1];
    const before = structuredClone(waypoint);
    moveWaypointTo(draft, 1, { x: -2, y: 3.5 });
    expect(waypoint).toMatchObject({ x: 0, y: 3.5 });
    expect(waypoint.prevC).toEqual({ x: before.prevC.x - 4, y: before.prevC.y + 0.5 });
    expect(waypoint.nextC).toEqual({ x: before.nextC.x - 4, y: before.nextC.y + 0.5 });
  });

  it("reverses outgoing segment policy, controls, turn direction, range anchors, and endpoint speeds together", () => {
    const draft = path();
    const before = structuredClone(draft);
    draft.startVel = 0.3; draft.goalVel = 0.8;
    draft.waypoints[1].turnInPlace = { headingDeg: 90, direction: "clockwise" };

    expect(reversePath(draft)).toBe(draft);

    expect(draft.waypoints.map((waypoint) => waypoint.x)).toEqual([8, 6, 4, 2]);
    expect(draft.waypoints.map((waypoint) => waypoint.segmentHeadingMode)).toEqual(["lookAt", "manual", "tangent", undefined]);
    expect(draft.waypoints[1].segmentFollowMode).toBe("position");
    expect(draft.waypoints[1].segmentLookAt).toEqual({ x: 7, y: 4 });
    expect(draft.waypoints[2].nextC).toEqual(before.waypoints[1].prevC);
    expect(draft.waypoints[2].turnInPlace?.direction).toBe("counterclockwise");
    expect(draft.ranges[0]).toMatchObject({ w0: 2, w1: 3 });
    expect([draft.startVel, draft.goalVel]).toEqual([0.8, 0.3]);
  });

  it("keeps the terminal action at the endpoint through reorder, duplicate, and delete", () => {
    const draft = path();
    draft.waypoints[3].jiggle = structuredClone(jiggle);
    reorderWaypoint(draft, 3, 1);
    expect(draft.waypoints.map((waypoint) => waypoint.jiggle)).toEqual([undefined, undefined, undefined, jiggle]);
    expect(draft.waypoints[3].segmentHeadingMode).toBeUndefined();
    duplicateWaypoint(draft, 3);
    expect(draft.waypoints[3].jiggle).toBeUndefined();
    expect(draft.waypoints[4].jiggle).toEqual(jiggle);
    removeWaypoint(draft, 4);
    expect(draft.waypoints[3].jiggle).toEqual(jiggle);
    expect(draft.waypoints[0].thetaOn).toBe(true);
    expect(draft.waypoints[3].thetaOn).toBe(true);
  });

  it("remaps waypoint ranges when deleting or inserting, including the last two anchors", () => {
    const draft = path();
    draft.ranges[0].w0 = 1; draft.ranges[0].w1 = 3;
    duplicateWaypoint(draft, 0);
    expect(draft.ranges[0]).toMatchObject({ w0: 2, w1: 4 });
    removeWaypoint(draft, 2);
    expect(draft.ranges[0]).toMatchObject({ w0: 2, w1: 3 });
    removeWaypoint(draft, 0); removeWaypoint(draft, 0);
    removeWaypoint(draft, 0);
    expect(draft.waypoints).toHaveLength(1);
    removeWaypoint(draft, 0);
    expect(draft.waypoints).toEqual([]);
    expect(() => removeWaypoint(draft, 0)).not.toThrow();
  });

  it("shares handle alignment with load normalization without changing already-aligned saved values", () => {
    const project = createDemoProject();
    project.paths[0] = path();
    const waypoint = project.paths[0].waypoints[1];
    waypoint.prevC = { x: 3, y: 3 }; waypoint.nextC = { x: 4, y: 5 };
    alignWaypointHandles(waypoint);
    expect(Math.hypot(waypoint.x - waypoint.prevC.x, waypoint.y - waypoint.prevC.y)).toBeCloseTo(1, 12);
    expect(Math.hypot(waypoint.nextC.x - waypoint.x, waypoint.nextC.y - waypoint.y)).toBeCloseTo(2, 12);
    expect(waypoint).toMatchObject({ linked: true, corner: false });
    const normalized = normalizeProject(project);
    expect(normalized).toMatchObject({ paths: [{ waypoints: [expect.anything(), waypoint, expect.anything(), expect.anything()] }] });
    expect(normalizeProject(normalized)).toEqual(normalized);
  });
});

describe("editor project defaults and routine identity", () => {
  it("uses the shared initial robot/path defaults and selects the generated identities", () => {
    const actual = freshProject(), expected = createDemoProject();
    expect(actual.robot).toEqual(expected.robot);
    expect({ ...actual.paths[0], id: "same" }).toEqual({ ...expected.paths[0], id: "same" });
    expect(actual.editor).toMatchObject({ activePathId: actual.paths[0].id, unitSystem: "metric" });
    expect(actual.activeRoutineId).toBe(actual.routines[0].id);
  });

  it("normalizes routine selection without changing valid routine identity", () => {
    const project = freshProject(), other = blankRoutine("Other");
    const state = routineState({ routines: [project.routines[0], other], activeRoutineId: "missing" });
    expect(state.activeRoutineId).toBe(project.activeRoutineId);
    expect(withRoutineState(project, { ...state, activeRoutineId: other.id }).activeRoutineId).toBe(other.id);
    expect(routineState({ routines: [], activeRoutineId: "missing" }).routines).toHaveLength(1);
  });

  it("uses one case-insensitive suffix policy for paths, routines, and folders", () => {
    expect(uniqueItemName([{ name: "New path" }, { name: "NEW PATH 2" }], "New path")).toBe("New path 3");
    expect(uniqueItemName([{ name: "New folder 2" }], "New folder")).toBe("New folder");
  });
});
