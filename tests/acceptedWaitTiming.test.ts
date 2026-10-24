import { describe, expect, it } from "vitest";
import { buildBdxExport } from "../src/shared/export/bdx";
import { buildRobotBinary } from "../src/shared/export/robotBinary";
import { bdxBindingsFromCatalog } from "../src/electron/bdxBindings";
import { createAcceptedRouteTrajectory, getAcceptedTrajectory, selectPathTrajectory } from "../src/shared/planners/acceptedTrajectory";
import { getPlanner } from "../src/shared/planners";
import { buildWaypoints, createDemoProject } from "../src/shared/project/defaults";
import { decodeProjectFile, encodeProjectFile } from "../src/shared/project/fileFormat";
import type { PlannerResult } from "../src/shared/types";
import { forceExportRobot } from "./fixtures/forceExportRobot";
// @ts-expect-error The production planning worker is an intentional JavaScript module.
import { processPathPreviewJob } from "../src/renderer/assets/path-preview-worker";

describe("exact waypoint wait timing", () => {
  it("keeps a worker optimization with a fractional wait usable after application and reopening", () => {
    const project = createDemoProject(), path = project.paths[0];
    project.robot = forceExportRobot();
    path.constraints.maxVel = 0.2;
    path.waypoints = buildWaypoints([
      { x: 7, y: 1, theta: 0, nextC: { x: 7, y: 2 } },
      { x: 9, y: 1, theta: 0, prevC: { x: 9, y: 2 }, stop: true, wait: 0.11 },
    ]);
    const response = processPathPreviewJob({ id: 1, quality: "final", optimize: true, path,
      robot: project.robot, field: project.field, perSegment: 56, deadline: "common", deadlineMs: 5000 });
    expect(response.error).toBeUndefined();
    const result: PlannerResult = response.value.finalTrajectory;
    expect(result.optimization?.fallback).toBe(false);
    expect(result.optimization?.gainS).toBeGreaterThan(0.02);
    // Match the renderer's Apply action, which persists the worker's exact output.
    path.optimization = { accepted: createAcceptedRouteTrajectory(path, project.robot, result, project.field, 56) };
    expect(getAcceptedTrajectory(path, project.robot)).toEqual(result);
    expect(createAcceptedRouteTrajectory(path, project.robot, result).result).toEqual(result);
    const reopened = decodeProjectFile(encodeProjectFile(project).contents).project;
    expect(selectPathTrajectory(reopened.paths[0], reopened.robot).samples).toEqual(result.samples);
    expect(buildBdxExport(reopened).paths[0].samples).toEqual(result.samples);
    expect(buildRobotBinary(reopened, { kind: "path", id: path.id }, bdxBindingsFromCatalog(null)).document.paths[0].totalTimeS).toBe(result.totalTimeS);
    const wait = result.stationaryActions!.find(action => action.kind === "wait")!;
    expect(wait.endTimeS - wait.startTimeS).toBeCloseTo(0.11, 10);
    expect(result.samples.at(-1)!.t).toBe(wait.endTimeS);
  });

  it("preserves exact start, interior and terminal waits, marker arrivals, and monotonic motion", () => {
    const project = createDemoProject(), path = project.paths[0];
    path.constraints.maxVel = 0.2;
    path.waypoints = buildWaypoints([
      { x: 7, y: 1, theta: 0, segType: "line", stop: true, wait: 0.003 },
      { x: 8, y: 1, theta: 0, segType: "line", stop: true, wait: 0.11 },
      { x: 9, y: 1, theta: 0, stop: true, wait: 0.127 },
    ]);
    path.markers = [0, 0.5, 0.75, 1].map((f, i) => ({ id: `wait-event-${i}`, name: `Event ${i}`, f }));
    const baseline = getPlanner("profiledSpline").generate({ path: { ...path,
      waypoints: path.waypoints.map(waypoint => ({ ...waypoint, wait: 0 })) }, robot: project.robot });
    const result = getPlanner("profiledSpline").generate({ path, robot: project.robot });
    expect(result.diagnostics.filter(issue => issue.severity === "error")).toEqual([]);
    expect(result.totalTimeS - baseline.totalTimeS).toBeCloseTo(0.24, 10);
    expect(result.stationaryActions).toHaveLength(3);
    for (const action of result.stationaryActions!) {
      const waypoint = path.waypoints[action.waypointIndex];
      expect(action.endTimeS - action.startTimeS).toBeCloseTo(waypoint.wait!, 10);
      const samples = result.samples.filter(sample => sample.t >= action.startTimeS && sample.t <= action.endTimeS);
      expect(samples.length).toBeGreaterThanOrEqual(2);
      expect(samples.at(-1)!.t).toBe(action.endTimeS);
      expect(samples.every(sample => sample.velocityMps === 0 && Math.hypot(sample.x - waypoint.x, sample.y - waypoint.y) < 1e-6)).toBe(true);
    }
    expect(result.samples.every((sample, i) => i === 0 || sample.t > result.samples[i - 1].t)).toBe(true);
    expect(result.samples.every(sample => sample.velocityMps >= 0 && sample.velocityMps <= 0.2 + 1e-6)).toBe(true);
    const offsets = [0, 0.003, 0.113, 0.24];
    result.markers.forEach((marker, index) => expect(marker.timeS - baseline.markers[index].timeS).toBeCloseTo(offsets[index], 9));
  });
});
