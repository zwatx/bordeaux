import { describe, expect, it } from "vitest";
import {
  boundsPolygon,
  convexPolygonClearance,
  footprintVerticalSpan,
  robotFootprintAt,
  robotFootprintVertices,
  verticalLineSection,
} from "../src/core/agent/robotFootprint";
import { createDemoProject } from "../src/core/project/defaults";
import { validateProject } from "../src/core/validation";

describe("robot footprint geometry", () => {
  it("uses length forward and width laterally for the default rectangle", () => {
    const project = createDemoProject();
    project.robot.l = 1.2;
    project.robot.w = 0.6;
    expect(robotFootprintVertices(project.robot)).toEqual([
      { x: -0.6, y: -0.3 },
      { x: 0.6, y: -0.3 },
      { x: 0.6, y: 0.3 },
      { x: -0.6, y: 0.3 },
    ]);
    expect(footprintVerticalSpan(project.robot, 0)).toEqual({ minY: -0.3, maxY: 0.3 });
    expect(footprintVerticalSpan(project.robot, Math.PI / 2).maxY).toBeCloseTo(0.6);
  });

  it("computes signed oriented footprint clearance against a solid bound", () => {
    const project = createDemoProject();
    project.robot.l = 1;
    project.robot.w = 0.5;
    const obstacle = boundsPolygon({ min: { x: 1, y: -0.2 }, max: { x: 2, y: 0.2 } });
    expect(convexPolygonClearance(robotFootprintAt(project.robot, { x: 0, y: 0, headingRad: 0 }), obstacle)).toBeCloseTo(0.5);
    expect(convexPolygonClearance(robotFootprintAt(project.robot, { x: 0.75, y: 0, headingRad: 0 }), obstacle)).toBeLessThan(0);
  });

  it("accepts a configured convex trapezoid and uses its exact barrier slice", () => {
    const project = createDemoProject();
    project.robot.l = 1;
    project.robot.w = 0.8;
    project.robot.footprint = {
      kind: "polygon",
      verticesM: [
        { x: -0.5, y: -0.4 },
        { x: 0.5, y: -0.25 },
        { x: 0.5, y: 0.25 },
        { x: -0.5, y: 0.4 },
      ],
    };
    expect(validateProject(project).ok).toBe(true);
    const section = verticalLineSection(robotFootprintAt(project.robot, { x: 2, y: 3, headingRad: 0 }), 2.5);
    expect(section?.minY).toBeCloseTo(2.75);
    expect(section?.maxY).toBeCloseTo(3.25);
  });

  it("rejects non-convex or out-of-envelope custom footprints", () => {
    const project = createDemoProject();
    project.robot.footprint = {
      kind: "polygon",
      verticesM: [
        { x: -0.5, y: -0.4 },
        { x: 0.5, y: -0.4 },
        { x: 0, y: 0 },
        { x: 0.5, y: 0.4 },
        { x: -0.5, y: 0.4 },
      ],
    };
    expect(validateProject(project).issues.some((issue) => issue.path === "$.robot.footprint.verticesM")).toBe(true);
  });

  it("validates editable footprint preset parameters", () => {
    const project = createDemoProject();
    project.robot.footprintPreset = { kind: "round", vertices: 7 };
    expect(validateProject(project).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "$.robot.footprintPreset.vertices" }),
    ]));

    project.robot.footprintPreset = { kind: "trapezoid", frontWidthM: project.robot.w + 0.1, rearWidthM: project.robot.w };
    expect(validateProject(project).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "$.robot.footprintPreset" }),
    ]));

    project.robot.footprintPreset = { kind: "custom" };
    expect(validateProject(project).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "$.robot.footprint" }),
    ]));
  });

  it("validates optional agent planning geometry without inventing defaults", () => {
    const project = createDemoProject();
    expect(project.robot.planning).toBeUndefined();
    project.robot.planning = {
      intake: { name: "Front intake", centerM: { x: 0.42, y: 0 }, directionDeg: 0, captureWidthM: 0.7, maxCollectSpeedMps: 2 },
      shooter: { directionDeg: 0, requiresTargetFacing: true, preferredRangeM: 2.5 },
    };
    expect(validateProject(project).ok).toBe(true);
    project.robot.planning.intake!.maxCollectSpeedMps = project.robot.maxSpeed + 1;
    expect(validateProject(project).issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: "$.robot.planning.intake.maxCollectSpeedMps" })]));
    project.robot.planning.intake!.maxCollectSpeedMps = 2;
    project.robot.planning.intake!.directionDeg = 181;
    expect(validateProject(project).issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: "$.robot.planning.intake.directionDeg" })]));
  });

  it("validates an optional motor-derived drive model", () => {
    const project = createDemoProject();
    project.robot.driveModel = {
      motorId: "rev-neo-v1",
      motorFreeRpm: 5676,
      gearRatio: 6.75,
      wheelDiameterM: 0.1016,
    };
    project.robot.maxSpeed = project.robot.driveModel.motorFreeRpm / 60
      * Math.PI * project.robot.driveModel.wheelDiameterM / project.robot.driveModel.gearRatio;
    expect(validateProject(project).ok).toBe(true);

    project.robot.driveModel.gearRatio = 0;
    expect(validateProject(project).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "$.robot.driveModel.gearRatio" }),
    ]));
  });

});
