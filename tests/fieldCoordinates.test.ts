import { describe, expect, it } from "vitest";
import { FIELD_H, FIELD_W } from "../src/shared/math/fieldBounds";
import { FIELD_IMAGE, worldToFieldImage, fieldImageToWorld } from "../src/shared/field/imageCalibration";
import { ACTIVE_FIELD_REFERENCE, officialToAppPoint } from "../src/shared/field/rebuilt2026";
// @ts-expect-error The production worker is an intentional JavaScript module.
import { processPathPreviewJob } from "../src/renderer/assets/path-preview-worker";
import { buildWaypoints, createDemoProject } from "../src/shared/project/defaults";
import { decodeProjectValue, encodeProjectFile } from "../src/shared/project/fileFormat";
import { buildBdxExport } from "../src/shared/export/bdx";
import { createAcceptedTrajectory, createAcceptedRouteTrajectory, getAcceptedTrajectory } from "../src/shared/planners/acceptedTrajectory";
import { getPlanner } from "../src/shared/planners";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { geometryFromPath, routePlanningPath, routeResultToSource } from "../src/shared/planners/routeGeometry";
import { optimizeFixedGeometryFinal } from "../src/shared/planners/fixedGeometryFinal";
import { stationaryTurnDelta } from "../src/shared/math/angles";

function flipProjectPaths(project: ReturnType<typeof createDemoProject>) {
  const result = processPathPreviewJob({ id: 1, mode: 'flip', project });
  if (result.error) throw new Error(result.error.message);
  return result.value as typeof project;
}

describe("fixed blue-origin field", () => {
  it("pins the exact reviewed image and its native pixel dimensions", () => {
    const image = readFileSync(new URL('../src/renderer/assets/field.png', import.meta.url));
    expect(createHash('sha256').update(image).digest('hex')).toBe('4907a5b4a3045b27060f875f33b9793c4017a059961a1a9dbee7cc3421867ee7');
    expect([image.readUInt32BE(16), image.readUInt32BE(20)]).toEqual([FIELD_IMAGE.width, FIELD_IMAGE.height]);
  });
  it("maps every exact playing-surface corner and round-trips interior points", () => {
    expect([FIELD_W, FIELD_H]).toEqual([16.541, 8.069]);
    const corners = [[0, 0, FIELD_IMAGE.left, FIELD_IMAGE.bottom], [FIELD_W, 0, FIELD_IMAGE.right, FIELD_IMAGE.bottom],
      [0, FIELD_H, FIELD_IMAGE.left, FIELD_IMAGE.top], [FIELD_W, FIELD_H, FIELD_IMAGE.right, FIELD_IMAGE.top]];
    for (const [x, y, px, py] of corners) {
      expect(worldToFieldImage({ x, y })).toEqual({ x: px, y: py });
      expect(officialToAppPoint({ x, y })).toEqual({ x, y });
    }
    for (const x of [0, 1, 4.02844, FIELD_W / 2, FIELD_W]) for (const y of [0, 0.64, FIELD_H / 2, FIELD_H]) {
      const result = fieldImageToWorld(worldToFieldImage({ x, y }));
      expect(result.x).toBeCloseTo(x, 12); expect(result.y).toBeCloseTo(y, 12);
    }
    expect(worldToFieldImage({ x: 1, y: 0 }).x).toBeGreaterThan(worldToFieldImage({ x: 0, y: 0 }).x);
    expect(worldToFieldImage({ x: 0, y: 1 }).y).toBeLessThan(worldToFieldImage({ x: 0, y: 0 }).y);
  });

  it("flips all path-owned field geometry once, retaining local settings, distance anchors and references", () => {
    const project = createDemoProject(), path = project.paths[0];
    path.waypoints[0].theta = 25; path.waypoints[0].segmentLookAt = { x: 3, y: 2 };
    path.waypoints[0].turnInPlace = { headingDeg: 290, direction: "clockwise" };
    path.waypoints[0].jiggle = { distanceM: .1, strokes: 3, startDeg: 20, stepDeg: 90, strokeTimeS: 1 };
    path.targets = [{ f: .3, deg: 270, anchor: "dist", d: .8 }];
    path.ranges = [{ anchor: "dist", f0: .1, f1: .4, d0: .3, d1: 1.3, maxVel: 1 }];
    path.markers = [{ f: .5, name: "Wait", cmd: "none", anchor: "dist", d: 1 }];
    const other = structuredClone(path); other.id = "other"; other.name = "Other";
    project.paths.push(other); project.pathLinks = [{ id: "link", fromPathId: path.id, toPathId: other.id }];
    const before = structuredClone(project), flipped = flipProjectPaths(project);
    expect(project).toEqual(before);
    for (const result of flipped.paths) {
      expect(result.waypoints[0].x).toBeCloseTo(FIELD_W - path.waypoints[0].x, 12);
      expect(result.waypoints[0].y).toBeCloseTo(FIELD_H - path.waypoints[0].y, 12);
      expect(result.waypoints[0].theta).toBe(205);
      expect(result.waypoints[0].prevC.x).toBeCloseTo(FIELD_W - path.waypoints[0].prevC.x, 12);
      expect(result.waypoints[0].nextC.y).toBeCloseTo(FIELD_H - path.waypoints[0].nextC.y, 12);
      expect(result.waypoints[0].segmentLookAt).toEqual({ x: FIELD_W - 3, y: FIELD_H - 2 });
      expect(result.waypoints[0].turnInPlace).toEqual({ headingDeg: 470, direction: "clockwise" });
      expect(result.waypoints[0].jiggle).toEqual(path.waypoints[0].jiggle);
      expect(result.targets).toEqual([{ f: .3, deg: 450, anchor: "dist", d: .8 }]);
      expect(result.ranges).toEqual(path.ranges); expect(result.markers).toEqual(path.markers);
    }
    expect(flipped.pathLinks).toEqual(project.pathLinks); expect(flipped.routines).toEqual(project.routines);
    const restored = flipProjectPaths(flipped);
    expect(restored.paths[0].waypoints[0].x).toBeCloseTo(path.waypoints[0].x, 12);
    expect(restored.paths[0].waypoints[0].y).toBeCloseTo(path.waypoints[0].y, 12);
    expect(restored.paths[0].waypoints[0].theta).toBe(385);
  });

  it("persists and exports the flipped coordinates and heading in the declared blue frame", () => {
    const project = createDemoProject();
    project.paths[0].waypoints = buildWaypoints([{ x: 1, y: 1, theta: 0, segType: "line" }, { x: 3, y: 1, theta: 0 }]);
    const flipped = flipProjectPaths(project);
    const reopened = decodeProjectValue(JSON.parse(encodeProjectFile(flipped).contents));
    expect(reopened.migrated).toBe(false); expect(reopened.project.paths).toEqual(flipped.paths);
    const exported = buildBdxExport(reopened.project);
    expect(exported.field).toEqual(ACTIVE_FIELD_REFERENCE);
    const first = exported.paths[0].samples[0], last = exported.paths[0].samples.at(-1)!;
    expect(first.x).toBeCloseTo(FIELD_W - 1, 10); expect(first.y).toBeCloseTo(FIELD_H - 1, 10);
    expect(last.x).toBeCloseTo(FIELD_W - 3, 10); expect(first.headingRad).toBeCloseTo(Math.PI, 10);
  });

  it("rotates a validated applied trajectory while retaining timing and its applied status", () => {
    const project = createDemoProject(), path = project.paths[0];
    path.waypoints = buildWaypoints([{ x: 1, y: 1, theta: 0, segType: 'line' }, { x: 3, y: 1, theta: 0 }]);
    const result = getPlanner('profiledSpline').generate({ path, robot: project.robot });
    path.optimization = { accepted: createAcceptedTrajectory(path, project.robot, result, project.field) };
    expect(getAcceptedTrajectory(path, project.robot, project.field)).not.toBeNull();
    const flipped = flipProjectPaths(project), accepted = getAcceptedTrajectory(flipped.paths[0], project.robot, project.field);
    expect(accepted).not.toBeNull(); expect(accepted?.totalTimeS).toBe(result.totalTimeS);
    expect(accepted?.samples.map((sample) => sample.t)).toEqual(result.samples.map((sample) => sample.t));
    expect(accepted?.samples[0].x).toBeCloseTo(FIELD_W - 1, 12);
    expect(accepted?.samples[0].headingRad).toBeCloseTo(Math.PI, 12);
  });

  it("keeps generated solver-knot placeholders aligned with reconstructed route semantics", () => {
    const project = createDemoProject(), path = project.paths[0];
    path.waypoints = buildWaypoints([{ x: 6.5, y: 2, theta: 0 }, { x: 10, y: 2, theta: 0 }]);
    path.headingMode = 'manual';
    const knots = buildWaypoints([{ x: 6.5, y: 2 }, { x: 8, y: 2.5 }, { x: 10, y: 2 }]);
    const geometry = { version: 1 as const, knots: knots.map((point) => ({ ...point, smooth: true })), requiredPointIndices: [0, 2] };
    const planning = routePlanningPath(path, geometry);
    const result = routeResultToSource(optimizeFixedGeometryFinal({ path: planning, robot: project.robot }), geometry, planning);
    path.optimization = { accepted: createAcceptedRouteTrajectory(path, project.robot, result, project.field) };
    expect(getAcceptedTrajectory(path, project.robot, project.field)).not.toBeNull();
    const flipped = flipProjectPaths(project);
    expect(flipped.paths[0].optimization?.accepted?.result.optimizedPath?.waypoints[1].theta).toBe(0);
    expect(getAcceptedTrajectory(flipped.paths[0], project.robot, project.field)).not.toBeNull();
    expect(buildBdxExport(flipped).paths[0].samples[0].x).toBeCloseTo(FIELD_W - 6.5, 12);

    // Rebuilding solver semantics must not repair a rejected selection implicitly.
    path.optimization!.accepted!.result.optimizedPath!.waypoints[0].theta = 90;
    expect(getAcceptedTrajectory(path, project.robot, project.field)).toBeNull();
    expect(() => buildBdxExport(project)).toThrow(/applied optimization is invalid/);
    const rejected = structuredClone(project);
    expect(() => flipProjectPaths(project)).toThrow(/applied optimization is invalid or unverified/);
    expect(project).toEqual(rejected);
  });

  it.each([0, 20, 90, 200, 350, -20])("preserves the signed angular interpolation branch of half-turn headings from %s degrees", (offset) => {
    const project = createDemoProject(), path = project.paths[0];
    path.waypoints = buildWaypoints([{ x: 1, y: 1, theta: offset, segType: 'line' }, { x: 3, y: 1, theta: offset + 180 }]);
    path.headingMode = 'manual';
    const original = getPlanner('profiledSpline').generate({ path, robot: project.robot });
    path.optimization = { accepted: createAcceptedTrajectory(path, project.robot, original, project.field) };
    const flipped = flipProjectPaths(project), next = flipped.paths[0];
    expect(next.waypoints.map((waypoint) => waypoint.theta)).toEqual([offset + 180, offset + 360]);
    const normal = getPlanner('profiledSpline').generate({ path: next, robot: project.robot });
    const accepted = getAcceptedTrajectory(next, project.robot, project.field);
    expect(accepted).not.toBeNull();
    for (let i = 0; i < normal.samples.length; i++) {
      expect(normal.samples[i].headingRad).toBeCloseTo(original.samples[i].headingRad + Math.PI, 10);
      expect(normal.samples[i].angularVelocityRadps).toBeCloseTo(original.samples[i].angularVelocityRadps, 10);
    }
  });

  it.each([{ version: 1, segType: 'line' }, { version: 1, segType: 'bezier' }, { version: 2, segType: 'bezier' }] as const)("preserves an automatic tangent U-turn and applied v$version $segType through Flip", ({ version, segType }) => {
    const project = createDemoProject(), path = project.paths[0];
    path.headingMode = 'tangent';
    path.waypoints = buildWaypoints([{ x: 6.5, y: 2, segType }, { x: 8, y: 2, stop: true, segType }, { x: 6.5, y: 2 }]);
    path.waypoints[0].nextC = { x: 7, y: 2 };
    Object.assign(path.waypoints[1], { linked: false, prevC: { x: 7.5, y: 2 }, nextC: { x: 7.5, y: 2 } });
    path.waypoints[2].prevC = { x: 7, y: 2 };
    const original = getPlanner('profiledSpline').generate({ path, robot: project.robot });
    if (version === 1) path.optimization = { corridorM: .15, accepted: createAcceptedTrajectory(path, project.robot, original, project.field) };
    else {
      const geometry = geometryFromPath(path), planning = routePlanningPath(path, geometry);
      const result = routeResultToSource(optimizeFixedGeometryFinal({ path: planning, robot: project.robot }), geometry, planning);
      path.optimization = { accepted: createAcceptedRouteTrajectory(path, project.robot, result, project.field) };
    }
    const flipped = flipProjectPaths(project), next = flipped.paths[0];
    const normal = getPlanner('profiledSpline').generate({ path: next, robot: project.robot });
    expect(getAcceptedTrajectory(next, project.robot, project.field)).not.toBeNull();
    for (let i = 0; i < normal.samples.length; i++) {
      const delta = normal.samples[i].headingRad - original.samples[i].headingRad - Math.PI;
      expect(Math.atan2(Math.sin(delta), Math.cos(delta))).toBeCloseTo(0, 8);
      expect(normal.samples[i].angularVelocityRadps).toBeCloseTo(original.samples[i].angularVelocityRadps, 8);
    }
    expect(buildBdxExport(flipped).paths[0].samples.length).toBeGreaterThan(2);
  });

  it.each(['clockwise', 'counterclockwise'] as const)("does not manufacture a full %s turn when the tangent already matches the terminal heading", (direction) => {
    for (const start of [0, 1, -1, Math.PI]) for (const noise of [-Number.EPSILON, Number.EPSILON, -1e-10, 1e-10]) {
      expect(stationaryTurnDelta(start, start + noise, direction)).toBe(0);
    }
    const project = createDemoProject(), path = project.paths[0];
    path.headingMode = 'tangent';
    path.waypoints = buildWaypoints([{ x: 6.5, y: 3, segType: 'line' },
      { x: 5.560307379214091, y: 2.6579798566743316, stop: true }]);
    path.waypoints[1].turnInPlace = { headingDeg: 200, direction };
    const original = getPlanner('profiledSpline').generate({ path, robot: project.robot });
    path.optimization = { corridorM: .15, accepted: createAcceptedTrajectory(path, project.robot, original, project.field) };
    const flipped = flipProjectPaths(project);
    expect(getAcceptedTrajectory(flipped.paths[0], project.robot, project.field)).not.toBeNull();
    delete flipped.paths[0].optimization; // The user's Use normal action must keep the same zero-turn behavior.
    const normal = getPlanner('profiledSpline').generate({ path: flipped.paths[0], robot: project.robot });
    expect(normal.totalTimeS).toBeCloseTo(original.totalTimeS, 9);
    expect(normal.samples).toHaveLength(original.samples.length);
    expect(Math.max(...normal.samples.map(sample => Math.abs(sample.angularVelocityRadps)))).toBeLessThan(1e-8);
    expect(buildBdxExport(flipped).paths[0].samples.at(-1)!.t).toBeCloseTo(original.totalTimeS, 9);
  });

  it.each([false, true])("converts legacy %s pinned sources once without touching opaque command data", (unpinned) => {
    const legacy: any = createDemoProject();
    legacy.field.coordinateSchemaId = "bordeaux-field/1.0";
    if (unpinned) delete legacy.field;
    const waypoint = legacy.paths[0].waypoints[0];
    legacy.paths[0].markers = [{ id: 'opaque', name: 'Opaque', f: .5,
      invocation: { commandId: 'team.command', arguments: { point: { x: 17.548, y: 8.052 }, theta: 180 } } }];
    Object.assign(waypoint, { x: 17.548, y: 8.052, theta: 180, prevC: { x: 17.548, y: 8.052 }, nextC: { x: 16, y: 7 } });
    const before = structuredClone(legacy);
    const decoded = decodeProjectValue(legacy);
    expect(legacy).toEqual(before); expect(decoded.migrated).toBe(true);
    expect(decoded.project.paths[0].waypoints[0]).toMatchObject({ x: 0, y: 0, theta: 360 });
    expect(decoded.project.field).toEqual(ACTIVE_FIELD_REFERENCE);
    expect(decoded.project.paths[0].markers).toEqual(before.paths[0].markers);
    expect(decoded.project.fieldMigration?.source).toBe(unpinned ? "legacy-unpinned" : "bordeaux-field/1.0");
    expect(decodeProjectValue(decoded.project)).toEqual({ project: decoded.project, migrated: false });
  });
});
