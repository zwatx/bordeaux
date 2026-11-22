import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createDemoProject, buildWaypoints } from "../src/core/project/defaults";
import { setWaypointFacing } from "../src/renderer/lib/pathEditing";
import { getPlanner } from "../src/core/planners";
import { buildRobotTrajectory } from "../src/core/export/robotTrajectory";
import type { RobotCommandCatalog } from "../src/core/types";
// @ts-expect-error The inspector is a JavaScript component.
import { ContextInspector } from "../src/renderer/components/ContextInspector";

const catalog: RobotCommandCatalog = { projectName: "Boundary robot", sourceFileCount: 0, scannedAt: "", warnings: [], commands: [], authoritative: true, generatedSchemaVersion: "1.3", catalogId: "boundary-robot", supportVersion: "0.4.0", catalogHash: `sha256:${"a".repeat(64)}` };
function movingProject() {
  const project = createDemoProject();
  project.paths[0].waypoints = buildWaypoints([{ x: 2, y: 4, theta: 90, segType: "line" }, { x: 5, y: 4, theta: 90 }]);
  project.paths[0].startVel = 1.2;
  project.paths[0].goalVel = 0.8;
  return project;
}
function markup(project: ReturnType<typeof movingProject>, sel: { kind: string | null; idx: number } = { kind: null, idx: -1 }) {
  return renderToStaticMarkup(createElement(ContextInspector, { doc: project.paths[0], sel, derived: {}, actions: {}, drive: project.robot.drive, robot: project.robot }));
}

describe("path entry and exit conditions", () => {
  it.each(["manual", "targets"] as const)("exports swerve facing independent of travel tangent in %s mode with moving endpoints", (mode) => {
    const project = movingProject(); const path = project.paths[0]; path.headingMode = mode;
    const result = getPlanner("profiledSpline").generate({ path, robot: project.robot });
    expect(result.diagnostics.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(result.samples[0].headingRad).toBeCloseTo(Math.PI / 2, 4);
    expect(result.samples[0].velocityMps).toBeCloseTo(1.2, 4);
    expect(result.samples.at(-1)!.velocityMps).toBeCloseTo(0.8, 4);
    expect(result.samples[1].x).toBeGreaterThan(result.samples[0].x);
    expect(result.samples.every((sample) => Math.abs(sample.y - 4) < 1e-8)).toBe(true);
    const exported = buildRobotTrajectory(project, catalog).document.paths[0];
    expect(exported.samples[0].headingRad).toBeCloseTo(Math.PI / 2, 4);
    expect(exported.samples[0].velocityMps).toBeCloseTo(1.2, 4);
    expect(exported.samples.at(-1)!.velocityMps).toBeCloseTo(0.8, 4);
  });
  it("changes only robot facing when endpoint theta changes", () => {
    const project = movingProject(); const path = project.paths[0];
    const before = getPlanner("profiledSpline").generate({ path, robot: project.robot });
    path.waypoints[0].theta = 45;
    const after = getPlanner("profiledSpline").generate({ path, robot: project.robot });
    expect(after.samples[0].headingRad).toBeCloseTo(Math.PI / 4, 4);
    expect(after.samples.map(({ x, y }) => ({ x, y }))).toEqual(before.samples.map(({ x, y }) => ({ x, y })));
    expect(after.samples[0].velocityMps).toBeCloseTo(1.2, 4);
    expect(after.samples.at(-1)!.velocityMps).toBeCloseTo(0.8, 4);
  });
  it("keeps tank facing on its travel tangent while honoring moving endpoint speeds", () => {
    const project = movingProject(); project.robot.drive = "tank";
    const exported = buildRobotTrajectory(project, catalog).document.paths[0];
    expect(exported.samples[0].headingRad).toBeCloseTo(0, 4);
    expect(exported.samples[0].velocityMps).toBeCloseTo(1.2, 4);
    expect(exported.samples.at(-1)!.velocityMps).toBeCloseTo(0.8, 4);
  });
  it("honors explicit endpoint stops and exposes the reason speeds are zero", () => {
    const project = movingProject(); project.paths[0].waypoints[0].stop = true; project.paths[0].waypoints[1].stop = true;
    const exported = buildRobotTrajectory(project, catalog).document.paths[0];
    expect(exported.samples[0].velocityMps).toBe(0);
    expect(exported.samples.at(-1)!.velocityMps).toBe(0);
    const summary = markup(project);
    expect(summary).toContain('fieldset disabled=""');
    expect(summary).toContain("Stopped at entry");
    expect(summary).toContain("Stopped at exit");
    expect(markup(project, { kind: "wp", idx: 0 })).toContain('aria-label="Stop at entry"');
    expect(markup(project, { kind: "wp", idx: 1 })).toContain('aria-label="Stop at exit"');
  });
  it("makes facing and scalar boundary speeds discoverable in path summary", () => {
    const summary = markup(movingProject());
    expect(summary).toContain("Initial robot facing");
    expect(summary).toContain("Entry speed");
    expect(summary).toContain("Exit speed");
    expect(summary).not.toContain("Place waypoint");
  });
  it.each(["tangent", "lookAt"] as const)("edits initial facing directly while preserving geometry in %s mode", (mode) => {
    const project = movingProject(); const path = project.paths[0]; path.headingMode = "tangent";
    path.waypoints[0].segmentHeadingMode = mode;
    path.waypoints[0].segmentLookAt = { x: 6, y: 6 };
    const geometry = path.waypoints.map(({ x, y, prevC, nextC }) => ({ x, y, prevC: { ...prevC }, nextC: { ...nextC } }));
    expect(markup(project)).toContain("Initial robot facing");
    expect(markup(project, { kind: "wp", idx: 0 })).toContain("Initial robot facing");
    expect(markup(project)).not.toContain("Set custom initial facing");
    setWaypointFacing(path, 0, 42);
    expect(path.headingMode).toBe("tangent");
    expect(path.waypoints[0].segmentHeadingMode).toBe("manual");
    expect(path.waypoints[1].segmentHeadingMode).toBeUndefined();
    expect(path.waypoints.map(({ x, y, prevC, nextC }) => ({ x, y, prevC, nextC }))).toEqual(geometry);
    expect(buildRobotTrajectory(project, catalog).document.paths[0].samples[0].headingRad).toBeCloseTo(42 * Math.PI / 180, 4);
  });
});
