import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { generatedCatalogHash, parseGeneratedRobotCatalog } from "../src/electron/robotGeneratedCatalog";
import { validateProjectRobotInvocations } from "../src/shared/robotCommands";
import { buildRobotTrajectory } from "../src/shared/export/robotTrajectory";
import { createDemoProject } from "../src/shared/project/defaults";
import type { RobotBuiltInDescriptor, RobotCommandCatalog, RobotTrajectoryGeneratorDescriptor, RoutineGeneratedTrajectoryNode } from "../src/shared/types";
// @ts-expect-error Routine authoring remains a legacy JavaScript module.
import { AUTO } from "../src/renderer/lib/routineModel";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// @ts-expect-error The routine run sheet is a JavaScript component.
import { RoutinePanel, addMenuSteps } from "../src/renderer/components/RoutinePanel";
// @ts-expect-error The routine inspector is a JavaScript component.
import { StepInspector } from "../src/renderer/components/RoutineInspector";

type GeneratedFallbackNode = Extract<RoutineGeneratedTrajectoryNode["fallback"], { type: "branch" }>["nodes"][number];
const generatedFallbackIsNonRecursive: RoutineGeneratedTrajectoryNode extends GeneratedFallbackNode ? never : true = true;
void generatedFallbackIsNonRecursive;

const wait: RobotBuiltInDescriptor = {
  id: "bordeaux.wait", kind: "wait", label: "Wait", description: "Pause the routine before its next step.",
  parameters: [{ name: "durationS", label: "Duration", description: "Time to wait before continuing the routine.", unit: "s", defaultValue: 1, min: 0.02, max: 15, role: "argument", valueType: "DBL", schema: { kind: "number", valueType: "DBL" } }],
};

function generator(): RobotTrajectoryGeneratorDescriptor {
  return {
    id: "robot.DynamicPaths#toPose", label: "Drive to pose", description: "Builds a bounded route at runtime.", aliases: ["dynamic-route"], semanticTags: ["runtime-path"],
    ownerType: "robot.DynamicPaths", member: "toPose",
    inputs: [
      { name: "avoidObstacles", label: "Avoid obstacles", valueType: "Boolean", role: "argument", schema: { kind: "boolean", valueType: "Boolean" } },
      { name: "maxSpeed", label: "Maximum speed", unit: "m/s", min: 0.1, max: 4.5, valueType: "DBL", role: "argument", schema: { kind: "number", valueType: "DBL" } },
    ],
    preview: { kind: "runtimeDynamic" }, fallbackPolicy: "validatedBranch",
    limits: { timeoutMs: 50, maxSamples: 1024, maxDurationS: 8, maxDistanceM: 20, maxVelocityMps: 5, maxAccelerationMps2: 10, maxCentripetalAccelerationMps2: 8, maxAngularVelocityRadps: 12, maxAngularAccelerationRadps2: 40, minClearanceM: 0.2 },
    source: { file: "robot/DynamicPaths.vi", line: 1 },
  };
}

function rawCatalog() {
  const trajectoryGenerators = [generator()];
  const value = { schemaVersion: "1.3", catalogId: "competition-robot", supportVersion: "0.4.0", catalogHash: "", commands: [], conditions: [], builtIns: [wait], trajectoryGenerators };
  value.catalogHash = generatedCatalogHash(value.commands, value.conditions, value.builtIns, trajectoryGenerators);
  return value;
}

function catalog(): RobotCommandCatalog {
  const parsed = parseGeneratedRobotCatalog(rawCatalog());
  return { projectName: "Competition robot", sourceFileCount: 1, scannedAt: new Date(0).toISOString(), authoritative: true, warnings: [], generatedSchemaVersion: parsed.schemaVersion, catalogId: parsed.catalogId, supportVersion: parsed.supportVersion, catalogHash: parsed.catalogHash, commands: parsed.commands, conditions: parsed.conditions, builtIns: parsed.builtIns, trajectoryGenerators: parsed.trajectoryGenerators };
}

describe("generated trajectory capabilities", () => {
  it("parses a strict 1.3 descriptor whose semantic hash covers generators without changing legacy hashes", () => {
    expect(generatedCatalogHash([])).toBe("sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");
    expect(generatedCatalogHash([], [])).toBe("sha256:45e19f016ce40429d044f7df00e8346d758614439087138ceb3436f8acc2e473");
    expect(generatedCatalogHash([], [], [{ id: "bordeaux.wait" }])).toBe("sha256:db2bceabd50d28c829f24f78dc81c9d616c2f312ac3a6a5ec2633418f365eaa7");
    expect(parseGeneratedRobotCatalog(rawCatalog())).toMatchObject({ schemaVersion: "1.3", supportVersion: "0.4.0", trajectoryGenerators: [{ id: "robot.DynamicPaths#toPose", preview: { kind: "runtimeDynamic" } }] });

    const changed = rawCatalog();
    changed.trajectoryGenerators[0].limits.maxDistanceM = 21;
    expect(() => parseGeneratedRobotCatalog(changed)).toThrow(/hash does not match/i);
  });

  it.each([
    ["missing numeric bounds", (value: any) => { delete value.trajectoryGenerators[0].inputs[1].max; }, /minimum and maximum/i],
    ["excessive timeout", (value: any) => { value.trajectoryGenerators[0].limits.timeoutMs = 101; }, /timeoutMs/i],
    ["free-form reference", (value: any) => { value.trajectoryGenerators[0].funcRef = "makeAnything"; }, /unexpected.*funcRef/i],
    ["fabricated preview", (value: any) => { value.trajectoryGenerators[0].preview.points = [{ x: 1, y: 2 }]; }, /preview/i],
    ["unsafe source path", (value: any) => { value.trajectoryGenerators[0].source.file = "../Secrets.vi"; }, /source path/i],
    ["invalid fallback policy", (value: any) => { value.trajectoryGenerators[0].fallbackPolicy = "continue"; }, /fallback/i],
  ])("rejects %s even when the supplied hash covers it", (_name, mutate, message) => {
    const value: any = rawCatalog(); mutate(value);
    value.catalogHash = generatedCatalogHash(value.commands, value.conditions, value.builtIns, value.trajectoryGenerators);
    expect(() => parseGeneratedRobotCatalog(value)).toThrow(message);
  });

  it.each([
    ["timeoutMs", 0], ["timeoutMs", 101], ["maxSamples", 1], ["maxSamples", 4097],
    ["maxDurationS", 0.019], ["maxDurationS", 15.01], ["maxDistanceM", -0.01], ["maxDistanceM", 54.01],
    ["maxVelocityMps", -0.01], ["maxVelocityMps", 10.01], ["maxAccelerationMps2", -0.01], ["maxAccelerationMps2", 30.01],
    ["maxCentripetalAccelerationMps2", -0.01], ["maxCentripetalAccelerationMps2", 30.01], ["maxAngularVelocityRadps", -0.01], ["maxAngularVelocityRadps", 25.01],
    ["maxAngularAccelerationRadps2", -0.01], ["maxAngularAccelerationRadps2", 100.01], ["minClearanceM", -0.01], ["minClearanceM", 2.01],
  ])("rejects %s outside its runtime bound", (name, invalid) => {
    const value: any = rawCatalog(); value.trajectoryGenerators[0].limits[name] = invalid;
    value.catalogHash = generatedCatalogHash(value.commands, value.conditions, value.builtIns, value.trajectoryGenerators);
    expect(() => parseGeneratedRobotCatalog(value)).toThrow(new RegExp(name));
  });

  it("rejects excessive, unsorted, duplicate, nonscalar, and unbounded inputs", () => {
    const invalidCases: Array<(value: any) => void> = [
      (value) => { value.trajectoryGenerators[0].inputs = Array.from({ length: 17 }, (_, index) => ({ name: `p${String(index).padStart(2, "0")}`, valueType: "Boolean", role: "argument", schema: { kind: "boolean", valueType: "Boolean" } })); },
      (value) => { value.trajectoryGenerators[0].inputs.reverse(); },
      (value) => { value.trajectoryGenerators[0].inputs[1].name = value.trajectoryGenerators[0].inputs[0].name; },
      (value) => { value.trajectoryGenerators[0].inputs[0].schema = { kind: "string", valueType: "String" }; value.trajectoryGenerators[0].inputs[0].valueType = "String"; },
      (value) => { value.trajectoryGenerators[0].inputs[0] = { name: "avoidObstacles", valueType: "Mode", role: "argument", schema: { kind: "enum", valueType: "Mode", enumValues: ["Z", "A"] } }; },
    ];
    for (const mutate of invalidCases) {
      const value: any = rawCatalog(); mutate(value);
      value.catalogHash = generatedCatalogHash(value.commands, value.conditions, value.builtIns, value.trajectoryGenerators);
      expect(() => parseGeneratedRobotCatalog(value)).toThrow(/16 inputs|sorted|unique|scalar|enum values/i);
    }
  });

  it("accepts an exactly bounded BigDecimal input without converting its values to binary floats", () => {
    const value: any = rawCatalog();
    value.trajectoryGenerators[0].inputs.push({ name: "tolerance", valueType: "robot.math.BigDecimal", role: "argument", min: "0.00000000000000000001", max: "0.00000000000000000002", schema: { kind: "decimalString", valueType: "robot.math.BigDecimal" } });
    value.catalogHash = generatedCatalogHash(value.commands, value.conditions, value.builtIns, value.trajectoryGenerators);

    expect(parseGeneratedRobotCatalog(value).trajectoryGenerators[0].inputs[2]).toMatchObject({ name: "tolerance", min: "0.00000000000000000001", max: "0.00000000000000000002" });
  });

  it("rejects unsorted generator IDs and IDs colliding with commands or conditions", () => {
    const unsorted: any = rawCatalog();
    unsorted.trajectoryGenerators.unshift({ ...structuredClone(unsorted.trajectoryGenerators[0]), id: "z.generator" });
    unsorted.catalogHash = generatedCatalogHash(unsorted.commands, unsorted.conditions, unsorted.builtIns, unsorted.trajectoryGenerators);
    expect(() => parseGeneratedRobotCatalog(unsorted)).toThrow(/sorted by unique ID/i);

    const collision: any = rawCatalog();
    collision.conditions = [{ id: generator().id, label: "Collision", ownerType: "robot.Conditions", member: "collision", source: { file: "robot/Conditions.vi", line: 1 } }];
    collision.catalogHash = generatedCatalogHash(collision.commands, collision.conditions, collision.builtIns, collision.trajectoryGenerators);
    expect(() => parseGeneratedRobotCatalog(collision)).toThrow(/collides/i);
  });

  it("exports a typed generated node with its validated static fallback branch", () => {
    const project = createDemoProject();
    const pathId = project.paths[0].id;
    const node: RoutineGeneratedTrajectoryNode = { id: "dynamic", type: "generatedTrajectory", generatorId: generator().id, arguments: { avoidObstacles: true, maxSpeed: 3 }, fallback: { type: "branch", nodes: [{ id: "fallback-path", type: "path", ref: pathId }] } };
    project.routines[0].nodes = [node];

    expect(validateProjectRobotInvocations(project, catalog())).toEqual([]);
    expect(buildRobotTrajectory(project, catalog()).document.routine?.nodes).toEqual([node]);
  });

  it("rejects policy mismatches, nested generators, invalid inputs, duplicate IDs, and fallback leaves without a path", () => {
    const project = createDemoProject();
    const dynamic: any = { id: "dynamic", type: "generatedTrajectory", generatorId: generator().id, arguments: { avoidObstacles: "yes", maxSpeed: 3 }, fallback: { type: "branch", nodes: [{ id: "dynamic", type: "function", cat: "command", invocation: { commandId: "missing", arguments: {} } }] } };
    project.routines[0].nodes = [dynamic];
    expect(validateProjectRobotInvocations(project, catalog()).map((issue) => issue.message).join("\n")).toMatch(/true or false|unique|exported static path/i);

    dynamic.arguments.avoidObstacles = true;
    dynamic.fallback.nodes = [{ id: "nested", type: "generatedTrajectory", generatorId: generator().id, arguments: {}, fallback: { type: "safeStop" } }];
    expect(validateProjectRobotInvocations(project, catalog()).map((issue) => issue.message).join("\n")).toMatch(/nested generated/i);

    dynamic.fallback = { type: "safeStop" };
    expect(validateProjectRobotInvocations(project, catalog()).map((issue) => issue.message).join("\n")).toMatch(/validatedBranch/i);
  });

  it("bounds fallback branches to 128 nodes and eight decision levels", () => {
    const project = createDemoProject();
    const pathId = project.paths[0].id;
    const dynamic: any = { id: "dynamic", type: "generatedTrajectory", generatorId: generator().id, arguments: { avoidObstacles: true, maxSpeed: 3 }, fallback: { type: "branch", nodes: [] } };
    project.routines[0].nodes = [dynamic];
    dynamic.fallback.nodes = [...Array.from({ length: 128 }, (_, index) => ({ id: `wait-${index}`, type: "builtin", builtinId: "bordeaux.wait", arguments: { durationS: 0.02 } })), { id: "path", type: "path", ref: pathId }];
    expect(validateProjectRobotInvocations(project, catalog()).map((issue) => issue.message)).toContain("Generated trajectory fallback cannot exceed 128 nodes");

    let branch: any[] = [{ id: "path", type: "path", ref: pathId }];
    for (let depth = 0; depth < 9; depth += 1) branch = [{ id: `decision-${depth}`, type: "decision", cond: "missing", thenLabel: "yes", elseLabel: "no", then: branch, else: [{ id: `else-path-${depth}`, type: "path", ref: pathId }] }];
    dynamic.fallback.nodes = branch;
    expect(validateProjectRobotInvocations(project, catalog()).map((issue) => issue.message)).toContain("Generated trajectory fallback cannot exceed 8 decision levels");
  });

  it("labels a known node as runtime-dynamic without fabricating preview geometry or chooser availability", () => {
    const node: RoutineGeneratedTrajectoryNode = { id: "dynamic", type: "generatedTrajectory", generatorId: generator().id, arguments: { avoidObstacles: true, maxSpeed: 3 }, fallback: { type: "safeStop" } };
    expect(AUTO.AUTHORABLE_STEPS.map((step: { id: string }) => step.id)).not.toContain("generatedTrajectory");
    expect(AUTO.authorableSteps(catalog()).map((step: { id: string }) => step.id)).not.toContain("generatedTrajectory");
    expect(AUTO.nodeTitle(node, [], catalog())).toBe("Drive to pose, Runtime dynamic");
    expect(AUTO.nodeDeploymentState(node, catalog())).toMatchObject({ deployable: true, dynamic: true });
    const run = AUTO.buildRun({ nodes: [node] }, [], {}, {}, "profiledSpline", catalog());
    expect(run).toMatchObject({ total: 0, segs: [], steps: [{ kind: "dynamic", dur: 0, dynamic: true }] });

    // The app previews with the linked catalog, the authoritative plans and only local pass choices.
    const app = fs.readFileSync(new URL("../src/renderer/app/App.jsx", import.meta.url), "utf8");
    expect(app).toContain("AUTO.buildRun(routine, project.paths, robot, routineOutcomes, plannerId, robotProjectState.catalog, routinePlans, { repeatPasses: routinePasses })");
    // Add never offers a generated trajectory, even with a generator in the catalog.
    expect(addMenuSteps({ nodes: [] }, { list: { kind: "root" } }, catalog()).map((item: { kind: string }) => item.kind)).not.toContain("generatedTrajectory");
    // The run sheet names the generator and states that there is no desktop preview; the inspector edits nothing.
    const routine = { id: "r", name: "R", nodes: [node] };
    const panel = renderToStaticMarkup(createElement(RoutinePanel, { routine, run, paths: [], time: 0, running: false, acq: { outcomes: {} }, catalog: catalog() }));
    expect(panel).toContain("Drive to pose, Runtime dynamic");
    expect(panel).toContain("Unsupported saved definition · Bordeaux cannot generate or preview it");
    const inspector = renderToStaticMarkup(createElement(StepInspector, { node, routine, paths: [], acq: {}, run, robotProject: { catalog: catalog() } }));
    expect(inspector).toContain("Preview and robot execution are unavailable.");
    expect(inspector).not.toContain("<input");
  });
});
