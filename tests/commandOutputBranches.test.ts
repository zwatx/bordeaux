import { describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../src/core/project/defaults";
import { decodeProjectFile, decodeProjectValue, encodeProjectFile } from "../src/core/project/fileFormat";
import { validateProject } from "../src/core/validation";
import { validateProjectRobotInvocations } from "../src/core/robotCommands";
import * as robotCommands from "../src/core/robotCommands";
import { buildRobotTrajectory } from "../src/core/export/robotTrajectory";
import type { RobotCommandCatalog, RoutineCommandOutputBranch, RoutineFunctionNode } from "../src/core/types";
// @ts-expect-error Routine authoring remains a JavaScript module.
import { AUTO } from "../src/renderer/lib/routineModel";
// @ts-expect-error Renderer library remains JavaScript.
import { referencingRoutines } from "../src/renderer/components/EditorLibrary";
// @ts-expect-error Renderer deployment tracking remains JavaScript.
import { deploymentInputKey } from "../src/renderer/lib/deploymentStatus";

function fixture() {
  const project = createDemoProject();
  project.paths = project.paths.slice(0, 2);
  if (project.paths.length < 2) project.paths.push({ ...structuredClone(project.paths[0]), id: "alternate", name: "Alternate" });
  const node: RoutineFunctionNode = {
    id: "acquire", type: "function", cat: "command", invocation: { commandId: "acquire", arguments: {} },
    outputBranch: {
      output: "hasPiece", schema: { kind: "boolean", valueType: "Boolean" }, routes: [
        { id: "acquired", label: "True", operator: "eq", value: true, nodes: [{ id: "score", type: "path", ref: project.paths[0].id }] },
        { id: "missed", label: "False", operator: "eq", value: false, nodes: [{ id: "retry", type: "path", ref: project.paths[1].id }] },
      ],
    },
  };
  project.routines[0].nodes = [node];
  const catalog: RobotCommandCatalog = {
    projectName: "Robot", sourceFileCount: 1, scannedAt: new Date(0).toISOString(), warnings: [], conditions: [],
    commands: [{ id: "acquire", label: "Acquire", ownerType: "Robot", member: "acquire", kind: "factory", confidence: "confirmed", runtimeReady: true, parameters: [], source: { file: "Acquire.vi", line: 1 } }],
  };
  return { project, node, branch: node.outputBranch!, catalog };
}

describe("command output branch persistence and boundaries", () => {
  it("round-trips all routes and stable route identities without a linked catalog", () => {
    const { project, node } = fixture();
    expect(validateProject(project)).toMatchObject({ ok: true });
    const decoded = decodeProjectFile(encodeProjectFile(project).contents);
    expect(decoded.project.routines[0].nodes[0]).toEqual(node);
  });

  it("migrates numeric path references inside command routes", () => {
    const { project, branch } = fixture();
    branch.routes[1].nodes = [{ id: "old-path", type: "path", ref: 1 }] as never;
    const decoded = decodeProjectValue(project);
    expect(decoded.migrated).toBe(true);
    expect((decoded.project.routines[0].nodes[0] as RoutineFunctionNode).outputBranch?.routes[1].nodes[0]).toMatchObject({ ref: project.paths[1].id });
  });

  it.each([
    { output: "outcome", schema: { kind: "enum", valueType: "Outcome", enumValues: ["Captured", "Missed"] }, routes: [{ id: "captured", label: "Captured", operator: "eq", value: "Captured", nodes: [] }, { id: "other", label: "Otherwise", operator: "otherwise", nodes: [] }] },
    { output: "distance", schema: { kind: "number", valueType: "DBL" }, routes: [{ id: "near", label: "Nearby", operator: "lte", value: 2.5, nodes: [] }, { id: "other", label: "Otherwise", operator: "otherwise", nodes: [] }] },
    { output: "counter", schema: { kind: "integerString", valueType: "I64" }, routes: [{ id: "large", label: "Large", operator: "gt", value: "9007199254740993", nodes: [] }, { id: "other", label: "Otherwise", operator: "otherwise", nodes: [] }] },
  ] as RoutineCommandOutputBranch[])("preserves $output comparisons without losing scalar precision", (branch) => {
    const { project, node } = fixture();
    node.outputBranch = branch;
    expect(validateProject(project).issues).toEqual([]);
    expect((decodeProjectFile(encodeProjectFile(project).contents).project.routines[0].nodes[0] as RoutineFunctionNode).outputBranch).toEqual(branch);
  });

  it("validates unselected paths and duplicate step IDs across routes", () => {
    const { project, branch } = fixture();
    branch.routes[1].nodes = [{ id: "score", type: "path", ref: "deleted" }];
    const issues = validateProject(project).issues;
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "$.routines[0].nodes[0].outputBranch.routes[1].nodes[0].ref" }),
      expect.objectContaining({ message: "Routine node IDs must be unique" }),
    ]));
  });

  it("rejects malformed route predicates and non-finite numeric values", () => {
    const { project, branch } = fixture();
    branch.routes[1].value = true;
    expect(validateProject(project).ok).toBe(false);
    branch.schema = { kind: "number", valueType: "DBL" };
    branch.routes = [{ id: "bad", label: "Bad", operator: "gt", value: Infinity, nodes: [] }, { id: "other", label: "Otherwise", operator: "otherwise", nodes: [] }];
    expect(validateProject(project).issues).toEqual(expect.arrayContaining([expect.objectContaining({ message: "Comparison value must be a finite number" })]));
    branch.routes.reverse();
    expect(validateProject(project).issues).toEqual(expect.arrayContaining([expect.objectContaining({ message: "Otherwise must be the final route and have no comparison value" })]));
  });

  it("blocks robot export while leaving an inactive draft branch harmless", () => {
    const { project, catalog } = fixture();
    expect(validateProjectRobotInvocations(project, catalog)).toEqual(expect.arrayContaining([expect.objectContaining({ path: "$.routines[0].nodes[0].outputBranch", message: expect.stringContaining("local authoring and preview only") })]));
    expect(() => buildRobotTrajectory(project, catalog)).toThrow(/robot execution support is not available yet/);
    project.routines.push({ id: "plain", name: "Plain", nodes: [] });
    project.activeRoutineId = "plain";
    expect(validateProjectRobotInvocations(project, catalog)).toEqual([]);
  });

  it("also rejects output branches at serialization when invocation validation is bypassed", () => {
    const { project, catalog } = fixture();
    const validation = vi.spyOn(robotCommands, "validateProjectRobotInvocations").mockReturnValue([]);
    try {
      expect(() => buildRobotTrajectory(project, catalog)).toThrow(/Routine command acquire branches on an output/);
    } finally {
      validation.mockRestore();
    }
  });

  it("bounds output branch nesting and route counts before recursive processing", () => {
    const { project, node, branch } = fixture();
    let child = node;
    for (let index = 0; index < 66; index += 1) {
      const next = structuredClone(node);
      next.id = `nested-${index}`;
      next.outputBranch!.routes.forEach((route) => { route.nodes = []; });
      child.outputBranch!.routes[0].nodes = [next];
      child = next;
    }
    expect(validateProject(project).issues).toEqual(expect.arrayContaining([expect.objectContaining({ message: "Routine nesting cannot exceed 64 levels" })]));
    branch.routes = Array.from({ length: 257 }, (_, index) => ({ id: `route-${index}`, label: "Route", operator: "eq", value: true, nodes: [] }));
    expect(validateProject(project).issues).toEqual(expect.arrayContaining([expect.objectContaining({ message: "Output branches require between 2 and 256 routes" })]));
  });

  it("previews the selected route after the command and defaults to the first route", () => {
    const { project } = fixture();
    const routine = project.routines[0];
    const stepIds = (outcomes: Record<string, string>) => AUTO.buildRun(routine, project.paths, project.robot, outcomes, project.plannerId).steps.map((step: { node: { id: string } }) => step.node.id);
    expect(stepIds({})).toEqual(["acquire", "score"]);
    expect(stepIds({ acquire: "missed" })).toEqual(["acquire", "retry"]);
    expect(stepIds({ acquire: "stale-route" })).toEqual(["acquire", "score"]);
  });

  it("protects every branch path from deletion and invalidates comparisons when any path changes", () => {
    const { project } = fixture();
    const routine = project.routines[0];
    expect(referencingRoutines(project.routines, project.paths[1].id)).toEqual([routine]);
    const previous = deploymentInputKey(project, "routine", routine.id, "catalog");
    project.paths[1].constraints.maxVel *= 0.5;
    expect(deploymentInputKey(project, "routine", routine.id, "catalog")).not.toBe(previous);
  });
});
