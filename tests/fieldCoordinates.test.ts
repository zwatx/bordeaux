import { describe, expect, it } from "vitest";
import { FIELD_H, FIELD_W, FIELD_X_MAX, FIELD_Y_MAX, pointInsideField, rotateBlueOriginPoint } from "../src/core/math/fieldBounds";
import { FIELD_IMAGE, worldToFieldImage, fieldImageToWorld } from "../src/core/field/imageCalibration";
import { ACTIVE_FIELD_REFERENCE, REBUILT_2026_FIELD, officialToAppPoint } from "../src/core/field/rebuilt2026";
// @ts-expect-error The production worker is an intentional JavaScript module.
import { processPathPreviewJob } from "../src/renderer/assets/path-preview-worker";
import { buildWaypoints, createDemoProject } from "../src/core/project/defaults";
import { BLUE_ORIGIN_FIELD_REFERENCE } from "../src/core/project/fieldMigration";
import { decodeProjectValue, encodeProjectFile } from "../src/core/project/fileFormat";
import { buildBdxExport } from "../src/core/export/bdx";
import { createAcceptedTrajectory, createAcceptedRouteTrajectory, getAcceptedTrajectory, optimizationInputKey } from "../src/core/planners/acceptedTrajectory";
import { routeIntentKey } from "../src/core/planners/routeIdentity";
import { buildRoutineRuntime } from "../src/core/export/routineRuntime";
import { bdxBindingsFromCatalog } from "../src/electron/bdxBindings";
import { forceExportRobot } from "./fixtures/forceExportRobot";
import { getPlanner } from "../src/core/planners";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { geometryFromPath, routePlanningPath, routeResultToSource } from "../src/core/planners/routeGeometry";
import { optimizeFixedGeometryFinal } from "../src/core/planners/fixedGeometryFinal";
import { stationaryTurnDelta, wrapRadians } from "../src/core/math/angles";
import type { FieldFlipDirection } from "../src/core/project/flipField";
import type { ConstraintRange } from "../src/core/types";

function flipSelectedPath(project: ReturnType<typeof createDemoProject>, direction: FieldFlipDirection = "rotate", copy = false) {
  const result = processPathPreviewJob({ id: 1, mode: "flip", path: project.paths[0], robot: project.robot, field: project.field, direction, copy });
  if (result.error) throw new Error(result.error.message);
  return { ...project, paths: [result.value, ...project.paths.slice(1)] } as typeof project;
}

describe("fixed center-origin field", () => {
  it("pins the exact reviewed image and its native pixel dimensions", () => {
    const image = readFileSync(new URL('../src/renderer/assets/field.png', import.meta.url));
    expect(createHash('sha256').update(image).digest('hex')).toBe('4907a5b4a3045b27060f875f33b9793c4017a059961a1a9dbee7cc3421867ee7');
    expect([image.readUInt32BE(16), image.readUInt32BE(20)]).toEqual([FIELD_IMAGE.width, FIELD_IMAGE.height]);
  });
  it("maps every exact playing-surface corner and round-trips interior points", () => {
    expect([FIELD_W, FIELD_H]).toEqual([16.518, 8.043]);
    const corners = [[-FIELD_X_MAX, -FIELD_Y_MAX, FIELD_IMAGE.left, FIELD_IMAGE.bottom], [FIELD_X_MAX, -FIELD_Y_MAX, FIELD_IMAGE.right, FIELD_IMAGE.bottom],
      [-FIELD_X_MAX, FIELD_Y_MAX, FIELD_IMAGE.left, FIELD_IMAGE.top], [FIELD_X_MAX, FIELD_Y_MAX, FIELD_IMAGE.right, FIELD_IMAGE.top]];
    for (const [x, y, px, py] of corners) {
      expect(pointInsideField({ x, y })).toBe(true);
      expect(worldToFieldImage({ x, y }).x).toBeCloseTo(px, 10);
      expect(worldToFieldImage({ x, y }).y).toBeCloseTo(py, 10);
      expect(officialToAppPoint({ x, y })).toEqual({ x, y });
    }
    for (const x of [0, 1, 4.02844, FIELD_W / 2, FIELD_W]) for (const y of [0, 0.64, FIELD_H / 2, FIELD_H]) {
      const result = fieldImageToWorld(worldToFieldImage({ x, y }));
      expect(result.x).toBeCloseTo(x, 12); expect(result.y).toBeCloseTo(y, 12);
    }
    expect(worldToFieldImage({ x: 1, y: 0 }).x).toBeGreaterThan(worldToFieldImage({ x: 0, y: 0 }).x);
    expect(worldToFieldImage({ x: 0, y: 1 }).y).toBeLessThan(worldToFieldImage({ x: 0, y: 0 }).y);
  });

  it("puts the blue wall and scoring-table guardrail at the upper right", () => {
    const wall = REBUILT_2026_FIELD.landmarks.find(({ id }) => id === "blue-alliance-wall")!.line!;
    const rail = REBUILT_2026_FIELD.landmarks.find(({ id }) => id === "scoring-table-guardrail")!.line!;
    expect([wall.start.x, wall.end.x]).toEqual([8.259, 8.259]);
    expect([rail.start.y, rail.end.y]).toEqual([4.0215, 4.0215]);
    expect(wall.start).toEqual(rail.start);
    const upperRight = worldToFieldImage(wall.start);
    expect(upperRight.x).toBeCloseTo(FIELD_IMAGE.right, 12);
    expect(upperRight.y).toBeCloseTo(FIELD_IMAGE.top, 12);
  });

  it("migrates an asymmetric blue-origin route once with its absolute geometry, headings, and routine reference", () => {
    const project = createDemoProject(), path = project.paths[0];
    project.field = { ...BLUE_ORIGIN_FIELD_REFERENCE };
    path.waypoints = buildWaypoints([{ x: 2, y: 1, theta: 30 }, { x: 4, y: 2, theta: 210 }]);
    path.waypoints[0].segmentLookAt = { x: 3, y: 2 };
    path.waypoints[1].jiggle = { distanceM: .1, strokes: 3, startDeg: -20, stepDeg: -90, strokeTimeS: 1 };
    path.targets = [{ f: .5, deg: -180, rotationDirection: "cw" }];
    project.routines[0].nodes = [{ type: "path", id: "drive", ref: path.id }];
    const { project: migrated, migrated: converted } = decodeProjectValue(project);
    expect(converted).toBe(true);
    expect(migrated.paths[0].waypoints[0]).toMatchObject({
      ...rotateBlueOriginPoint({ x: 2, y: 1 }), theta: 210, segmentLookAt: rotateBlueOriginPoint({ x: 3, y: 2 }),
    });
    expect(migrated.paths[0].waypoints[0].nextC).toEqual(rotateBlueOriginPoint(path.waypoints[0].nextC));
    expect(migrated.paths[0].waypoints[1].theta).toBe(390);
    expect(migrated.paths[0].waypoints[1].jiggle).toEqual(path.waypoints[1].jiggle);
    expect(migrated.paths[0].targets[0]).toMatchObject({ deg: 0, rotationDirection: "cw" });
    expect(migrated.routines).toEqual(project.routines);
    expect(migrated.fieldMigration).toEqual({ source: BLUE_ORIGIN_FIELD_REFERENCE.coordinateSchemaId, sourceField: BLUE_ORIGIN_FIELD_REFERENCE, assigned: ACTIVE_FIELD_REFERENCE });
    const saved = encodeProjectFile(migrated);
    const reopened = decodeProjectValue(JSON.parse(saved.contents));
    expect(reopened.migrated).toBe(false);
    expect(encodeProjectFile(reopened.project).contents).toEqual(saved.contents);
    path.waypoints[0].theta = 360_000;
    expect(() => decodeProjectValue(project)).toThrow(/paths\[0\]\.waypoints\[0\]\.theta/);
  });

  it("reports historical coordinates outside the smaller AndyMark perimeter at their source path", () => {
    const project = createDemoProject();
    project.field = { ...BLUE_ORIGIN_FIELD_REFERENCE };
    project.paths[0].waypoints[0].x = 0;
    expect(() => decodeProjectValue(project)).toThrow(/paths\[0\]\.waypoints\[0\].*field bounds/);
    expect(project.paths[0].waypoints[0].x).toBe(0);
  });

  it("keeps the direction of an exact half-turn between large authored headings through migration", () => {
    // Both headings are within the supported range; their difference is an odd number of half-turns.
    const D2R = Math.PI / 180;
    const before = wrapRadians(134_668 * D2R - -134_432 * D2R);
    const after = wrapRadians((134_668 + 180) * D2R - (-134_432 + 180) * D2R);
    expect(before).toBe(Math.PI);
    expect(after).toBe(Math.PI);
  });

  it.each([1, 2] as const)("preserves historical accepted v%i as provenance and requires review before export", (version) => {
    const project = createDemoProject(), path = project.paths[0], routine = project.routines[0];
    project.robot = forceExportRobot();
    project.field = { ...BLUE_ORIGIN_FIELD_REFERENCE };
    path.waypoints = buildWaypoints([{ x: 6.5, y: 2, segType: "line" }, { x: 8, y: 2 }]);
    routine.nodes = [{ type: "path", id: "drive", ref: path.id }];
    const geometry = geometryFromPath(path);
    const planning = version === 2 ? routePlanningPath(path, geometry) : path;
    const timed = optimizeFixedGeometryFinal({ path: planning, robot: project.robot });
    const result = version === 2 ? routeResultToSource(timed, geometry, planning) : timed;
    const accepted = { version, result, samplesPerSegment: 56,
      inputKey: (version === 1 ? optimizationInputKey : routeIntentKey)(path, project.robot, project.field) };
    path.optimization = { corridorM: .15, accepted };

    const { project: migrated } = decodeProjectValue(project);
    const reopened = decodeProjectValue(encodeProjectFile(migrated).project).project;
    const selection = reopened.paths[0].optimization?.accepted;
    expect(selection).toEqual({ ...accepted, requiresFieldReview: true });
    expect(getAcceptedTrajectory(reopened.paths[0], reopened.robot, reopened.field)).toBeNull();
    const flipped = flipSelectedPath(reopened);
    expect(flipped.paths[0].optimization?.accepted).toEqual(selection);
    expect(() => buildBdxExport(reopened)).toThrow(/previous field frame.*Use normal/);
    const binary = bdxBindingsFromCatalog(null);
    const bindings = { binary, commands: {}, definitionJson: binary.definitionJson };
    expect(() => buildRoutineRuntime(reopened, routine.id, bindings)).toThrow(/previous field frame.*Use normal/);
    delete reopened.paths[0].optimization;
    expect(buildBdxExport(reopened).field).toEqual(ACTIVE_FIELD_REFERENCE);
    expect(buildRoutineRuntime(reopened, routine.id, bindings).document.paths).toHaveLength(1);
  });

  it("flips only the selected path, retaining its local settings, distance anchors and references", () => {
    const project = createDemoProject(), path = project.paths[0];
    path.waypoints[0].theta = 25; path.waypoints[0].segmentLookAt = { x: 3, y: 2 };
    path.waypoints[0].turnInPlace = { headingDeg: 290, direction: "clockwise" };
    path.waypoints[0].jiggle = { distanceM: .1, strokes: 3, startDeg: 20, stepDeg: 90, strokeTimeS: 1 };
    path.targets = [{ f: .3, deg: 270, anchor: "dist", d: .8 }];
    path.ranges = [{ anchor: "dist", f0: .1, f1: .4, d0: .3, d1: 1.3, maxVel: 1 }];
    path.markers = [{ f: .5, name: "Wait", cmd: "none", anchor: "dist", d: 1 }];
    const other = structuredClone(path); other.id = "other"; other.name = "Other";
    project.paths.push(other);
    const before = structuredClone(project), flipped = flipSelectedPath(project);
    expect(project).toEqual(before);
    const result = flipped.paths[0];
    expect(result.waypoints[0].x).toBeCloseTo(-path.waypoints[0].x, 12);
    expect(result.waypoints[0].y).toBeCloseTo(-path.waypoints[0].y, 12);
    expect(result.waypoints[0].theta).toBe(205);
    expect(result.waypoints[0].prevC.x).toBeCloseTo(-path.waypoints[0].prevC.x, 12);
    expect(result.waypoints[0].nextC.y).toBeCloseTo(-path.waypoints[0].nextC.y, 12);
    expect(result.waypoints[0].segmentLookAt).toEqual({ x: -3, y: -2 });
    expect(result.waypoints[0].turnInPlace).toEqual({ headingDeg: 470, direction: "clockwise" });
    expect(result.waypoints[0].jiggle).toEqual(path.waypoints[0].jiggle);
    expect(result.targets).toEqual([{ f: .3, deg: 450, anchor: "dist", d: .8 }]);
    expect(result.ranges).toEqual(path.ranges); expect(result.markers).toEqual(path.markers);
    expect(flipped.paths[1]).toBe(other);
    expect(flipped.pathLinks).toEqual(project.pathLinks); expect(flipped.routines).toEqual(project.routines);
    const restored = flipSelectedPath(flipped);
    expect(restored.paths[0].waypoints[0].x).toBeCloseTo(path.waypoints[0].x, 12);
    expect(restored.paths[0].waypoints[0].y).toBeCloseTo(path.waypoints[0].y, 12);
    expect(restored.paths[0].waypoints[0].theta).toBe(385);
  });

  it.each(["horizontal", "vertical"] as const)("mirrors the %s field axis, headings, and signed local turns", (direction) => {
    const project = createDemoProject(), path = project.paths[0];
    const first = path.waypoints[0];
    Object.assign(first, { x: 2, y: 3, theta: 35, rotationDirection: "cw",
      prevC: { x: 1, y: 2 }, nextC: { x: 3, y: 4 }, segmentLookAt: { x: 5, y: 6 },
      turnInPlace: { headingDeg: 110, direction: "counterclockwise" },
      jiggle: { distanceM: .1, strokes: 3, startDeg: 20, stepDeg: 90, strokeTimeS: 1 },
    });
    path.targets = [{ f: .3, deg: 270, rotationDirection: "ccw", anchor: "dist", d: 1.2 }];
    const next = flipSelectedPath(project, direction).paths[0];
    const horizontal = direction === "horizontal";
    const point = (x: number, y: number) => horizontal ? { x: -x, y } : { x, y: -y };
    const angle = (value: number) => horizontal ? 180 - value : -value;
    expect(next.waypoints[0]).toMatchObject({
      ...point(2, 3), theta: angle(35), prevC: point(1, 2), nextC: point(3, 4), segmentLookAt: point(5, 6),
      rotationDirection: "ccw", turnInPlace: { headingDeg: angle(110), direction: "clockwise" },
      jiggle: { ...first.jiggle, startDeg: -20, stepDeg: -90 },
    });
    expect(next.targets).toEqual([{ ...path.targets[0], deg: angle(270), rotationDirection: "cw" }]);
    expect(next.markers).toEqual(path.markers);
    expect(next.ranges).toEqual(path.ranges);
    expect(next.constraints).toEqual(path.constraints);
  });

  it.each(["manual", "tangent"] as const)("mirrors a shortest stationary half-turn with %s arrival heading", (headingMode) => {
    const project = createDemoProject(), path = project.paths[0];
    path.headingMode = headingMode;
    path.waypoints = buildWaypoints([{ x: 1, y: 1, theta: 0, segType: "line" }, { x: 3, y: 1, theta: 0, stop: true }]);
    path.waypoints[1].turnInPlace = { headingDeg: 180 };
    const mirrored = flipSelectedPath(project, "vertical").paths[0];
    expect(mirrored.waypoints[1].turnInPlace?.direction).toBe("clockwise");
    const original = getPlanner("profiledSpline").generate({ path, robot: project.robot });
    const result = getPlanner("profiledSpline").generate({ path: mirrored, robot: project.robot });
    expect(original.stationaryActions?.some(action => action.kind === "turn")).toBe(true);
    expect(result.totalTimeS).toBeCloseTo(original.totalTimeS, 7);
    expect(result.samples.some(sample => sample.angularVelocityRadps < -.1)).toBe(true);
    expect(result.samples.every(sample => sample.angularVelocityRadps < 1e-7)).toBe(true);
  });

  const uTurnZone: ConstraintRange[] = [{ anchor: "param", f0: 0.501, f1: 0.6, maxVel: 0.5 }];
  it.each([
    { direction: "horizontal", segType: "line" }, { direction: "vertical", segType: "line" },
    { direction: "horizontal", segType: "bezier" }, { direction: "vertical", segType: "bezier" },
    { direction: "horizontal", segType: "line", ranges: uTurnZone },
    { direction: "vertical", segType: "line", ranges: uTurnZone },
    { direction: "rotate", segType: "line", ranges: uTurnZone },
  ] satisfies Array<{ direction: FieldFlipDirection; segType: "line" | "bezier"; ranges?: ConstraintRange[] }>)(
    "keeps the automatic $segType U-turn after a $direction transform", ({ direction, segType, ranges }) => {
    const project = createDemoProject(), path = project.paths[0];
    path.headingMode = "tangent";
    path.waypoints = buildWaypoints([
      { x: -1.7705, y: 2, segType }, { x: -.2705, y: 2, stop: true, segType: "line" }, { x: -1.7705, y: 2 },
    ]);
    path.waypoints[0].nextC = { x: -1.2705, y: 2.4 };
    path.waypoints[1].prevC = { x: -.7705, y: 2 };
    path.ranges = ranges ?? [];
    const flipped = flipSelectedPath(project, direction);
    const mirrored = decodeProjectValue(JSON.parse(encodeProjectFile(flipped).contents)).project.paths[0];
    expect(mirrored.waypoints[1].turnInPlace).toBeUndefined();
    expect(mirrored.waypoints[1].implicitHalfTurnClockwise).toBe(direction === "rotate" ? undefined : true);
    expect(flipSelectedPath(flipped, direction).paths[0].waypoints[1].implicitHalfTurnClockwise).toBeUndefined();
    const planner = getPlanner("profiledSpline");
    const original = planner.generate({ path, robot: project.robot });
    const result = planner.generate({ path: mirrored, robot: project.robot });
    expect(original.stationaryActions?.map(action => action.kind)).toEqual(["turn"]);
    expect(result.stationaryActions?.map(action => action.kind)).toEqual(["turn"]);
    expect(result.diagnostics.filter(issue => issue.severity === "error")).toEqual([]);
    expect(result.totalTimeS).toBeCloseTo(original.totalTimeS, 7);
    const duringTurn = (plan: typeof result) => {
      const turn = plan.stationaryActions![0];
      return plan.samples.filter(sample => sample.t >= turn.startTimeS && sample.t <= turn.endTimeS + 1e-9);
    };
    const before = duringTurn(original), after = duringTurn(result);
    expect(after).toHaveLength(before.length);
    const angle = direction === "rotate" ? Math.PI + before[0].headingRad
      : direction === "horizontal" ? Math.PI - before[0].headingRad : -before[0].headingRad;
    expect(wrapRadians(after[0].headingRad - angle)).toBeCloseTo(0, 7);
    for (let index = 0; index < before.length; index++) {
      const omega = before[index].angularVelocityRadps;
      expect(after[index].angularVelocityRadps).toBeCloseTo(direction === "rotate" ? omega : -omega, 6);
    }
  });

  it.each([{ direction: "horizontal", heading: -360_000 }, { direction: "rotate", heading: 360_000 }] as const)(
    "refuses a $direction transform that would create an unsupported heading", ({ direction, heading }) => {
      const project = createDemoProject();
      project.paths[0].waypoints[0].theta = heading;
      const before = structuredClone(project);
      expect(() => flipSelectedPath(project, direction)).toThrow(/supported range/);
      expect(project).toEqual(before);
    },
  );

  it("cannot reactivate an outdated applied trajectory when rotating back to its geometry", () => {
    const project = createDemoProject(), source = project.paths[0];
    source.waypoints = buildWaypoints([{ x: -1, y: 1, theta: 0, segType: "line" }, { x: 1, y: 1, theta: 0 }]);
    const destination = flipSelectedPath(project).paths[0];
    const result = getPlanner("profiledSpline").generate({ path: destination, robot: project.robot });
    source.optimization = { corridorM: .15, accepted: createAcceptedTrajectory(destination, project.robot, result, project.field) };
    expect(getAcceptedTrajectory(source, project.robot, project.field)).toBeNull();
    expect(flipSelectedPath(project).paths[0]).toEqual({ ...destination, optimization: { corridorM: .15 } });
  });

  it("persists and exports the flipped coordinates and heading in the declared centered frame", () => {
    const project = createDemoProject();
    project.paths[0].waypoints = buildWaypoints([{ x: -1, y: 1, theta: 0, segType: "line" }, { x: 1, y: 1, theta: 0 }]);
    const flipped = flipSelectedPath(project);
    const reopened = decodeProjectValue(JSON.parse(encodeProjectFile(flipped).contents));
    expect(reopened.migrated).toBe(false); expect(reopened.project.paths).toEqual(flipped.paths);
    const exported = buildBdxExport(reopened.project);
    expect(exported.field).toEqual(ACTIVE_FIELD_REFERENCE);
    const first = exported.paths[0].samples[0], last = exported.paths[0].samples.at(-1)!;
    expect(first.x).toBeCloseTo(1, 10); expect(first.y).toBeCloseTo(-1, 10);
    expect(last.x).toBeCloseTo(-1, 10); expect(first.headingRad).toBeCloseTo(Math.PI, 10);
  });

  it("rotates a validated applied trajectory while retaining timing and its applied status", () => {
    const project = createDemoProject(), path = project.paths[0];
    path.waypoints = buildWaypoints([{ x: -1, y: 1, theta: 0, segType: 'line' }, { x: 1, y: 1, theta: 0 }]);
    const result = getPlanner('profiledSpline').generate({ path, robot: project.robot });
    path.optimization = { accepted: createAcceptedTrajectory(path, project.robot, result, project.field) };
    expect(getAcceptedTrajectory(path, project.robot, project.field)).not.toBeNull();
    const flipped = flipSelectedPath(project), accepted = getAcceptedTrajectory(flipped.paths[0], project.robot, project.field);
    expect(accepted).not.toBeNull(); expect(accepted?.totalTimeS).toBe(result.totalTimeS);
    expect(accepted?.samples.map((sample) => sample.t)).toEqual(result.samples.map((sample) => sample.t));
    expect(accepted?.samples[0].x).toBeCloseTo(1, 12);
    expect(accepted?.samples[0].headingRad).toBeCloseTo(Math.PI, 12);
    path.optimization.corridorM = .15;
    expect(flipSelectedPath(project, "rotate", true).paths[0].optimization).toEqual({ corridorM: .15 });
    expect(flipSelectedPath(project, "horizontal").paths[0].optimization).toEqual({ corridorM: .15 });
    expect(getAcceptedTrajectory(path, project.robot, project.field)).not.toBeNull();
  });

  it("keeps generated solver-knot placeholders aligned with reconstructed route semantics", () => {
    const project = createDemoProject(), path = project.paths[0];
    path.waypoints = buildWaypoints([{ x: -1.7705, y: 2, theta: 0 }, { x: 1.7295, y: 2, theta: 0 }]);
    path.headingMode = 'manual';
    const knots = buildWaypoints([{ x: -1.7705, y: 2 }, { x: -.2705, y: 2.5 }, { x: 1.7295, y: 2 }]);
    const geometry = { version: 1 as const, knots: knots.map((point) => ({ ...point, smooth: true })), requiredPointIndices: [0, 2] };
    const planning = routePlanningPath(path, geometry);
    const result = routeResultToSource(optimizeFixedGeometryFinal({ path: planning, robot: project.robot }), geometry, planning);
    path.optimization = { accepted: createAcceptedRouteTrajectory(path, project.robot, result, project.field) };
    expect(getAcceptedTrajectory(path, project.robot, project.field)).not.toBeNull();
    const flipped = flipSelectedPath(project);
    expect(flipped.paths[0].optimization?.accepted?.result.optimizedPath?.waypoints[1].theta).toBe(0);
    expect(getAcceptedTrajectory(flipped.paths[0], project.robot, project.field)).not.toBeNull();
    expect(buildBdxExport(flipped).paths[0].samples[0].x).toBeCloseTo(1.7705, 12);

    // Rebuilding solver semantics must not repair a rejected selection implicitly.
    path.optimization!.accepted!.result.optimizedPath!.waypoints[0].theta = 90;
    expect(getAcceptedTrajectory(path, project.robot, project.field)).toBeNull();
    expect(() => buildBdxExport(project)).toThrow(/applied optimization is invalid/);
    const rejected = structuredClone(project);
    expect(() => flipSelectedPath(project)).toThrow(/applied optimization is invalid or unverified/);
    expect(project).toEqual(rejected);
  });

  it.each([0, 20, 90, 200, 350, -20])("preserves the signed angular interpolation branch of half-turn headings from %s degrees", (offset) => {
    const project = createDemoProject(), path = project.paths[0];
    path.waypoints = buildWaypoints([{ x: -1, y: 1, theta: offset, segType: 'line' }, { x: 1, y: 1, theta: offset + 180 }]);
    path.headingMode = 'manual';
    const original = getPlanner('profiledSpline').generate({ path, robot: project.robot });
    path.optimization = { accepted: createAcceptedTrajectory(path, project.robot, original, project.field) };
    const flipped = flipSelectedPath(project), next = flipped.paths[0];
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
    path.waypoints = buildWaypoints([{ x: -1.7705, y: 2, segType }, { x: -.2705, y: 2, stop: true, segType }, { x: -1.7705, y: 2 }]);
    path.waypoints[0].nextC = { x: -1.2705, y: 2 };
    Object.assign(path.waypoints[1], { linked: false, prevC: { x: -.7705, y: 2 }, nextC: { x: -.7705, y: 2 } });
    path.waypoints[2].prevC = { x: -1.2705, y: 2 };
    const original = getPlanner('profiledSpline').generate({ path, robot: project.robot });
    if (version === 1) path.optimization = { corridorM: .15, accepted: createAcceptedTrajectory(path, project.robot, original, project.field) };
    else {
      const geometry = geometryFromPath(path), planning = routePlanningPath(path, geometry);
      const result = routeResultToSource(optimizeFixedGeometryFinal({ path: planning, robot: project.robot }), geometry, planning);
      path.optimization = { accepted: createAcceptedRouteTrajectory(path, project.robot, result, project.field) };
    }
    const flipped = flipSelectedPath(project), next = flipped.paths[0];
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
    path.waypoints = buildWaypoints([{ x: 1.5, y: 3, segType: 'line' },
      { x: .560307379214091, y: 2.6579798566743316, stop: true }]);
    path.waypoints[1].turnInPlace = { headingDeg: 200, direction };
    const original = getPlanner('profiledSpline').generate({ path, robot: project.robot });
    path.optimization = { corridorM: .15, accepted: createAcceptedTrajectory(path, project.robot, original, project.field) };
    const flipped = flipSelectedPath(project);
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
    legacy.field = { ...BLUE_ORIGIN_FIELD_REFERENCE, coordinateSchemaId: "bordeaux-field/1.0" };
    if (unpinned) delete legacy.field;
    const waypoint = legacy.paths[0].waypoints[0];
    legacy.paths[0].markers = [{ id: 'opaque', name: 'Opaque', f: .5,
      invocation: { commandId: 'team.command', arguments: { point: { x: 17.548, y: 8.052 }, theta: 180 } } }];
    Object.assign(waypoint, { x: 17, y: 8, theta: 180, prevC: { x: 17.548, y: 8.052 }, nextC: { x: 16, y: 7 } });
    const before = structuredClone(legacy);
    const decoded = decodeProjectValue(legacy);
    expect(legacy).toEqual(before); expect(decoded.migrated).toBe(true);
    const migrated = decoded.project.paths[0].waypoints[0];
    expect(migrated.x).toBeCloseTo((17 / 17.548 - .5) * 16.541, 10);
    expect(migrated.y).toBeCloseTo((8 / 8.052 - .5) * 8.069, 10);
    expect(migrated.theta).toBe(540);
    expect(decoded.project.fieldMigration?.via).toEqual(BLUE_ORIGIN_FIELD_REFERENCE);
    expect(decoded.project.field).toEqual(ACTIVE_FIELD_REFERENCE);
    expect(decoded.project.paths[0].markers).toEqual(before.paths[0].markers);
    expect(decoded.project.fieldMigration?.source).toBe(unpinned ? "legacy-unpinned" : "bordeaux-field/1.0");
    expect(decodeProjectValue(decoded.project)).toEqual({ project: decoded.project, migrated: false });
  });
});
