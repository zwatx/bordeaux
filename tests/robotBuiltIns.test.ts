import { describe, expect, it } from "vitest";
import { generatedCatalogHash, parseGeneratedRobotCatalog } from "../src/electron/robotGeneratedCatalog";
import { createDemoProject } from "../src/shared/project/defaults";
import { validateProject } from "../src/shared/validation";
import { buildRobotTrajectory } from "../src/shared/export/robotTrajectory";
import type { RobotBuiltInDescriptor, RobotCommandCatalog, RoutineBuiltInNode } from "../src/shared/types";
// @ts-expect-error Routine authoring remains a legacy JavaScript module.
import { AUTO } from "../src/renderer/lib/routineModel";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// @ts-expect-error The routine run sheet is a JavaScript component.
import { addMenuSteps } from "../src/renderer/components/RoutinePanel";
// @ts-expect-error The routine inspector is a JavaScript component.
import { StepInspector } from "../src/renderer/components/RoutineInspector";

const wait: RobotBuiltInDescriptor = {
  id: "bordeaux.wait",
  kind: "wait",
  label: "Wait",
  description: "Pause the routine before its next step.",
  parameters: [{
    name: "durationS",
    label: "Duration",
    description: "Time to wait before continuing the routine.",
    unit: "s",
    defaultValue: 1,
    min: 0.02,
    max: 15,
    role: "argument",
    valueType: "DBL",
    schema: { kind: "number", valueType: "DBL" },
  }],
};

function generatedCatalog(): RobotCommandCatalog {
  return {
    projectName: "Competition robot",
    sourceFileCount: 1,
    scannedAt: new Date(0).toISOString(),
    authoritative: true,
    generatedSchemaVersion: "1.2",
    catalogId: "competition-robot",
    supportVersion: "0.3.0",
    catalogHash: `sha256:${"a".repeat(64)}`,
    commands: [{ id: "robot.Auto#score", label: "Score", ownerType: "robot.Auto", member: "score", kind: "factory", confidence: "confirmed", runtimeReady: true, parameters: [], source: { file: "Auto.vi", line: 1 } }],
    conditions: [{ id: "robot.Conditions#ready", label: "Ready", ownerType: "robot.Conditions", member: "ready", source: { file: "Conditions.vi", line: 1 } }],
    builtIns: [wait],
    warnings: [],
  };
}

describe("Bordeaux-owned routine built-ins", () => {
  it("accepts only the exact hashed Wait descriptor in a 1.2 catalog", () => {
    const commands: unknown[] = [];
    const conditions: unknown[] = [];
    const catalog = {
      schemaVersion: "1.2",
      catalogId: "competition-robot",
      supportVersion: "0.3.0",
      catalogHash: generatedCatalogHash(commands, conditions, [wait]),
      commands,
      conditions,
      builtIns: [wait],
    };

    expect(parseGeneratedRobotCatalog(catalog)).toMatchObject({
      schemaVersion: "1.2",
      builtIns: [wait],
    });

    expect(() => parseGeneratedRobotCatalog({ ...catalog, builtIns: undefined })).toThrow(/exact Bordeaux-owned built-in/i);
    expect(() => parseGeneratedRobotCatalog({ ...catalog, builtIns: [{ ...wait, label: "Delay" }] })).toThrow(/built-in/i);
  });

  it("returns an isolated built-in descriptor for each parsed catalog", () => {
    const commands: unknown[] = [];
    const conditions: unknown[] = [];
    const catalog = {
      schemaVersion: "1.2",
      catalogId: "competition-robot",
      supportVersion: "0.3.0",
      catalogHash: generatedCatalogHash(commands, conditions, [wait]),
      commands,
      conditions,
      builtIns: [wait],
    };
    const first = parseGeneratedRobotCatalog(catalog);
    (first.builtIns[0] as unknown as { label: string }).label = "Mutated";

    expect(parseGeneratedRobotCatalog(catalog).builtIns[0].label).toBe("Wait");
  });

  it("requires a bounded, exact Wait argument in project routines", () => {
    const project = createDemoProject();
    project.routines[0].nodes = [{ id: "wait", type: "builtin", builtinId: "bordeaux.wait", arguments: { durationS: 0.25 } }];
    expect(validateProject(project).ok).toBe(true);

    (project.routines[0].nodes[0] as RoutineBuiltInNode).arguments = { durationS: 0.01 };
    expect(validateProject(project).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "$.routines[0].nodes[0].arguments.durationS" }),
    ]));

    (project.routines[0].nodes[0] as unknown as { arguments: Record<string, unknown> }).arguments = { durationS: 16, unexpected: true };
    expect(validateProject(project).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "$.routines[0].nodes[0].arguments" }),
      expect.objectContaining({ path: "$.routines[0].nodes[0].arguments.durationS" }),
    ]));
  });

  it("serializes native Wait without a generated catalog capability", () => {
    const project = createDemoProject();
    project.routines[0].nodes = [{ id: "wait", type: "builtin", builtinId: "bordeaux.wait", arguments: { durationS: 0.25 } }];
    expect(buildRobotTrajectory(project, generatedCatalog()).document.routine?.nodes).toEqual([
      { id: "wait", type: "builtin", builtinId: "bordeaux.wait", arguments: { durationS: 0.25 } },
    ]);

    const legacy = generatedCatalog();
    legacy.generatedSchemaVersion = "1.1";
    legacy.supportVersion = "0.2.0";
    expect(buildRobotTrajectory(project, legacy).document.routine?.nodes[0]).toMatchObject({ type: 'builtin', builtinId: 'bordeaux.wait' });

    const missing = generatedCatalog();
    missing.builtIns = [];
    expect(buildRobotTrajectory(project, missing).document.routine?.nodes[0]).toMatchObject({ type: 'builtin', builtinId: 'bordeaux.wait' });
    expect(buildRobotTrajectory(project, null).document.routine?.nodes[0]).toMatchObject({ type: 'builtin', builtinId: 'bordeaux.wait' });
  });

  it("serializes a path, generated condition, Wait, and command in one routine", () => {
    const project = createDemoProject();
    const pathId = project.paths[0].id;
    project.routines[0].nodes = [{
      id: "ready", type: "decision", cond: "robot.Conditions#ready", thenLabel: "yes", elseLabel: "no",
      then: [
        { id: "wait", type: "builtin", builtinId: "bordeaux.wait", arguments: { durationS: 0.25 } },
        { id: "score", type: "function", cat: "command", invocation: { commandId: "robot.Auto#score", arguments: {} } },
        { id: "path", type: "path", ref: pathId },
      ],
      else: [],
    }];

    const root = buildRobotTrajectory(project, generatedCatalog()).document.routine!.nodes[0] as { then: unknown[] };
    expect(root.then).toEqual([
      { id: "wait", type: "builtin", builtinId: "bordeaux.wait", arguments: { durationS: 0.25 } },
      expect.objectContaining({ id: "score", type: "function", cat: "command" }),
      { id: "path", type: "path", ref: pathId },
    ]);
  });

  it("authors Wait as a typed first-class routine step and gives it authored playback time", () => {
    const node = AUTO.newNode("builtin", "wait");
    expect(node).toEqual(expect.objectContaining({ type: "builtin", builtinId: "bordeaux.wait", arguments: { durationS: 1 } }));
    const run = AUTO.buildRun({ nodes: [{ ...node, arguments: { durationS: 0.25 } }] }, [], {}, {}, "profiledSpline");
    expect(run.steps[0]).toMatchObject({ dur: 0.25, t0: 0, t1: 0.25 });
  });

  it("always offers native Wait in Add and gives it a bounded inspector control", () => {
    const routine = { id: "r", name: "R", nodes: [] };
    const wait = (catalog: RobotCommandCatalog | null) => addMenuSteps(routine, { list: { kind: "root" } }, catalog).find((item: { kind: string }) => item.kind === "wait");
    expect(wait(generatedCatalog())).toMatchObject({ label: "Wait" });
    expect(wait(generatedCatalog()).disabled).toBeFalsy();
    expect(wait({ ...generatedCatalog(), builtIns: [] }).disabled).toBeFalsy();
    expect(wait(null).disabled).toBeFalsy();
    const html = renderToStaticMarkup(createElement(StepInspector, {
      node: { id: "wait-a", type: "builtin", builtinId: "bordeaux.wait", arguments: { durationS: 1 } }, routine, paths: [], acq: {}, run: { segs: [] },
    }));
    expect(html).toContain("Wait duration in seconds");
    expect(html).toContain('min="0.02"');
    expect(html).toContain('max="15"');
  });

  it("keeps generated conditions authoritative with the 1.2 built-in catalog", () => {
    expect(AUTO.authoritativeConditions({
      authoritative: true,
      generatedSchemaVersion: "1.2",
      conditions: [{ id: "robot.conditions#ready", label: "Ready" }],
    })).toEqual([expect.objectContaining({ value: "robot.conditions#ready" })]);
  });
});
