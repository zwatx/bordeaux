import { describe, expect, it } from "vitest";
import { replaceEditedPath } from "../src/renderer/app/App";
import { editablePath } from "../src/renderer/lib/editablePath";
import { duplicateWaypoint, moveWaypointTo, removeWaypoint, reorderWaypoint, reversePath, setWaypointFacing } from "../src/renderer/lib/pathEditing";
import { PM } from "../src/renderer/lib/pathMath";
import { optimizationInputKey } from "../src/core/planners/acceptedTrajectoryIdentity";
import { createDemoProject } from "../src/core/project/defaults";

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function appliedPath() {
  const project = createDemoProject();
  const path = project.paths[0];
  const samples = Array.from({ length: 449 }, (_, i) => ({ i, t: i * 0.01, s: i * 0.02, f: i / 448, x: 1 + i * 0.02, y: 4, headingRad: 0, velocityMps: 2, accelerationMps2: 0, angularVelocityRadps: 0, curvatureInvM: 0 }));
  const accepted = deepFreeze({
    version: 1,
    inputKey: optimizationInputKey(path, project.robot, project.field),
    samplesPerSegment: 56,
    result: { planner: "profiledSpline", totalTimeS: 4.48, totalDistanceM: 8.96, samples, markers: [], diagnostics: [], optimization: { status: "optimal", fallback: false, constraintViolations: 0 } },
  });
  return { project, path: { ...path, optimization: { corridorM: 0.2, accepted } }, accepted };
}

describe("editable path copies", () => {
  it("shares the accepted artifact and deep-copies authored data", () => {
    const { path, accepted } = appliedPath();
    const copy = editablePath(path);

    expect(copy.optimization.accepted).toBe(accepted);
    expect(copy.optimization).not.toBe(path.optimization);
    expect(copy.optimization.corridorM).toBe(0.2);
    expect(copy.waypoints).not.toBe(path.waypoints);
    expect(copy.waypoints[0]).not.toBe(path.waypoints[0]);
    expect(copy).toEqual(path);
    expect(editablePath(createDemoProject().paths[0]).optimization).toBeUndefined();
  });

  it("runs every authored edit against a frozen artifact without touching it or the source", () => {
    const { path, accepted } = appliedPath();
    const source = JSON.stringify(path);
    const history = [editablePath(path)];
    let draft = editablePath(path);
    // Each drag frame copies the previous draft, as App's mutate does.
    for (let frame = 0; frame < 5; frame += 1) draft = moveWaypointTo(editablePath(draft), 1, { x: 3 + frame * 0.1, y: 3.5 });
    draft = setWaypointFacing(editablePath(draft), 0, 45);
    draft = duplicateWaypoint(editablePath(draft), 1);
    draft = reorderWaypoint(editablePath(draft), 1, 2);
    draft = removeWaypoint(editablePath(draft), 2);
    draft = editablePath(draft);
    draft.targets.push({ f: 0.5, deg: 90 });
    draft.constraints.maxVel = 2;
    Object.assign(draft, { goalVel: 0.5, _selAfter: 1 });
    const reversed = editablePath(draft);
    reversePath(reversed);
    const anchored = PM.reversePathAnchors(reversed, 8);

    for (const edited of [draft, anchored]) expect(edited.optimization.accepted).toBe(accepted);
    expect(Object.isFrozen(accepted.result.samples[448])).toBe(true);
    expect(JSON.stringify(path)).toBe(source);
    expect(draft.waypoints[1].x).not.toBe(path.waypoints[1].x);
    // Undo restores the earlier authored inputs with the same artifact.
    expect(history[0]).toEqual(path);
    expect(history[0].optimization.accepted).toBe(accepted);
  });

  it("keeps the artifact intact through project replacement, link sync, use-normal and save/reload", () => {
    const { project, path, accepted } = appliedPath();
    const next = { ...structuredClone(project.paths[1] || project.paths[0]), id: "linked_next" };
    const linked = { ...project, paths: [path, next], pathLinks: [{ id: "link", fromPathId: path.id, toPathId: next.id }] };
    const edited = moveWaypointTo(editablePath(path), path.waypoints.length - 1, { x: 6, y: 2 });

    const replaced = replaceEditedPath(linked, edited);
    expect(replaced.paths[0].optimization.accepted).toBe(accepted);
    expect(replaced.paths[1].waypoints[0]).toMatchObject({ x: 6, y: 2 });

    const normal = { ...edited, optimization: { corridorM: edited.optimization.corridorM } };
    expect(normal.optimization.accepted).toBeUndefined();
    expect(edited.optimization.accepted).toBe(accepted);

    const reloaded = JSON.parse(JSON.stringify(replaced.paths[0]));
    expect(reloaded.optimization.accepted).toEqual(accepted);
    expect(reloaded.waypoints).toEqual(edited.waypoints);
  });
});
