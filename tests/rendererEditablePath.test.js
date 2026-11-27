import { describe, expect, it } from "vitest";
import { replaceEditedPath } from "../src/renderer/app/App";
import { editablePath } from "../src/renderer/lib/editablePath";
import { duplicateWaypoint, moveWaypointTo, removeWaypoint, reorderWaypoint, reversePath } from "../src/renderer/lib/pathEditing";
import { settleOptimizerWaypoints } from "../src/core/planners/routeGeometry";
import { buildWaypoints, createDemoProject } from "../src/core/project/defaults";

/** A path whose second and third waypoints Optimize added. */
function optimizedPath() {
  const project = createDemoProject();
  const path = project.paths[0];
  path.waypoints = buildWaypoints([{ x: 1, y: 3 }, { x: 2, y: 3.4 }, { x: 3, y: 3.6 }, { x: 4, y: 3 }]);
  path.waypoints[1].optimizerAdded = true;
  path.waypoints[2].optimizerAdded = true;
  return { project, path };
}

/** One editor edit as App's writeEdit applies it. */
const edit = (path, change) => settleOptimizerWaypoints(path, change(editablePath(path)));
const flags = (path) => path.waypoints.map((waypoint) => Boolean(waypoint.optimizerAdded));

describe("editing a path with waypoints Optimize added", () => {
  it("deep-copies authored data, flags included", () => {
    const { path } = optimizedPath();
    const copy = editablePath(path);
    expect(copy).toEqual(path);
    expect(copy.waypoints).not.toBe(path.waypoints);
  });

  it("keeps the flags of waypoints an edit leaves alone", () => {
    const { path } = optimizedPath();
    expect(flags(edit(path, (draft) => moveWaypointTo(draft, 3, { x: 4.2, y: 3 })))).toEqual([false, true, true, false]);
    expect(flags(edit(path, (draft) => removeWaypoint(draft, 1)))).toEqual([false, true, false]);
  });

  it("gives a moved, duplicated or reordered added waypoint to the user", () => {
    const { path } = optimizedPath();
    expect(flags(edit(path, (draft) => moveWaypointTo(draft, 1, { x: 2, y: 3.2 })))).toEqual([false, false, true, false]);
    // The copy is a new waypoint the user placed; the original stays as Optimize left it.
    expect(flags(edit(path, (draft) => duplicateWaypoint(draft, 1)))).toEqual([false, true, false, true, false]);
    expect(flags(edit(path, (draft) => reorderWaypoint(draft, 2, 3)))).toEqual([false, true, false, false]);
  });

  it("gives every added waypoint to the user when the path is reversed", () => {
    const { path } = optimizedPath();
    expect(flags(edit(path, (draft) => reversePath(draft)))).toEqual([false, false, false, false]);
  });

  it("keeps the flags through link sync of the edited path's ends", () => {
    const { project, path } = optimizedPath();
    const next = { ...structuredClone(path), id: "linked_next" };
    const linked = { ...project, paths: [path, next], pathLinks: [{ id: "link", fromPathId: path.id, toPathId: next.id }] };
    const edited = edit(path, (draft) => moveWaypointTo(draft, path.waypoints.length - 1, { x: 6, y: 2 }));
    const replaced = replaceEditedPath(linked, edited);
    expect(flags(replaced.paths[0])).toEqual([false, true, true, false]);
    expect(replaced.paths[1].waypoints[0]).toMatchObject({ x: 6, y: 2 });
    expect(JSON.parse(JSON.stringify(replaced.paths[0]))).toEqual(replaced.paths[0]);
  });
});
