import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildRobotTrajectory } from "../src/shared/export/robotTrajectory";
import { validateProjectRobotInvocations } from "../src/shared/robotCommands";
import { createDemoProject } from "../src/shared/project/defaults";
import type { RobotCommandCatalog } from "../src/shared/types";
// @ts-expect-error Routine authoring remains a legacy JavaScript module.
import { AUTO } from "../src/renderer/lib/routineModel";
// @ts-expect-error The routine inspector is a JavaScript component.
import { StepInspector } from "../src/renderer/components/RoutineInspector";
// @ts-expect-error The routine run sheet is a JavaScript component.
import { addMenuSteps } from "../src/renderer/components/RoutinePanel";

function catalog(): RobotCommandCatalog {
  return {
    projectName: "Safety robot", sourceFileCount: 1, scannedAt: new Date(0).toISOString(),
    authoritative: true, generatedSchemaVersion: "1.2", catalogId: "safety-robot", supportVersion: "0.3.0", catalogHash: `sha256:${"a".repeat(64)}`,
    commands: [{ id: "robot.Commands#score", label: "Score", ownerType: "robot.Commands", member: "score", kind: "factory", confidence: "confirmed", runtimeReady: true, parameters: [], source: { file: "Commands.vi", line: 1 } }],
    conditions: [{ id: "robot.Conditions#ready", label: "Ready", ownerType: "robot.Conditions", member: "ready", source: { file: "Conditions.vi", line: 1 } }],
    builtIns: [{ id: "bordeaux.wait", kind: "wait", label: "Wait", description: "Pause the routine before its next step.", parameters: [{ name: "durationS", label: "Duration", description: "Time to wait before continuing the routine.", unit: "s", defaultValue: 1, min: 0.02, max: 15, role: "argument", valueType: "DBL", schema: { kind: "number", valueType: "DBL" } }] }],
    warnings: [],
  };
}

describe("routine export safety", () => {
  it.each(["generate", "sequence", "velocity", "terminate"])("keeps saved %s steps removable without exposing unsupported editors", (cat) => {
    const markup = renderToStaticMarkup(createElement(StepInspector, {
      node: { id: "legacy", type: "function", cat },
      acq: {},
    }));

    expect(markup).toContain("Legacy — cannot deploy");
    expect(markup).toContain("Remove unsupported step");
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("<textarea");
  });

  it("still renders a supported command and reports a missing catalog entry", () => {
    const markup = renderToStaticMarkup(createElement(StepInspector, {
      node: { id: "command", type: "function", cat: "command", invocation: { commandId: "missing", arguments: {} } },
      acq: {}, run: { segs: [] }, robotProject: { catalog: catalog() },
    }));

    expect(markup).toContain("Delete command");
    expect(markup).toContain("This saved command is missing from the linked catalog.");
    expect(markup).not.toContain("Remove unsupported step");
  });

  it("authors local branches/repeats/ends while preserving the available Wait gate", () => {
    expect(AUTO.authorableSteps(catalog()).map((step: { id: string }) => step.id)).toEqual(["path", "command", "decision", "repeat", "end", "wait"]);
    expect(AUTO.authorableSteps({ ...catalog(), generatedSchemaVersion: "1.1", builtIns: [] }).map((step: { id: string }) => step.id)).toEqual(["path", "command", "decision", "repeat", "end"]);
    expect(AUTO.newNode("function", "command")).toMatchObject({ type: "function", cat: "command" });
    expect(AUTO.nodeDeploymentState({ id: "legacy", type: "function", cat: "generate" })).toMatchObject({ deployable: false, legacy: true });
    expect(() => AUTO.nodeTitle({ id: "unknown", type: "future" }, [])).not.toThrow();
  });

  it("reports every active legacy and malformed node across both decision branches", () => {
    const project = createDemoProject();
    project.routines[0].nodes = [{
      id: "gate", type: "decision", cond: "robot.Conditions#ready", thenLabel: "yes", elseLabel: "no",
      then: [{ id: "legacy", type: "function", cat: "generate" }],
      else: [
        { id: "unknown", type: "future" },
        { id: "bad-path", type: "path", ref: "missing-path" },
        { id: "bad-wait", type: "builtin", builtinId: "bordeaux.wait", arguments: { durationS: 0.01 } },
        { id: "bad-command", type: "function", cat: "command", invocation: { commandId: "robot.Commands#score" } },
      ],
    }] as never;

    const issues = validateProjectRobotInvocations(project, catalog());
    expect(issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
      "$.routines[0].nodes[0].then[0]",
      "$.routines[0].nodes[0].else[0]",
      "$.routines[0].nodes[0].else[1].ref",
      "$.routines[0].nodes[0].else[2].arguments",
      "$.routines[0].nodes[0].else[3].invocation.arguments",
    ]));
    expect(() => buildRobotTrajectory(project, catalog())).toThrow(/nodes\[0\]\.then\[0\][\s\S]*nodes\[0\]\.else\[2\]\.arguments/);
  });

  it("does not let an inactive legacy routine block the routine selected for export", () => {
    const project = createDemoProject();
    project.routines[0].nodes = [{ id: "legacy", type: "function", cat: "sequence" }] as never;
    project.routines.push({ id: "active", name: "Safe", nodes: [{ id: "path", type: "path", ref: project.paths[0].id }] });
    project.activeRoutineId = "active";

    expect(validateProjectRobotInvocations(project, catalog())).toEqual([]);
    expect(buildRobotTrajectory(project, catalog()).document.routine?.name).toBe("Safe");
  });

  it("never offers legacy categories in Add and marks saved ones as migration work", () => {
    const routine = { id: "r", name: "R", nodes: [{ id: "loop", type: "repeat", times: 2, nodes: [] }] };
    const kinds = (where: object) => addMenuSteps(routine, where, catalog()).map((item: { kind: string }) => item.kind);
    for (const where of [{ list: { kind: "root" } }, { list: { kind: "repeat", nodeId: "loop" } }]) {
      for (const legacy of ["generate", "sequence", "velocity", "terminate", "generatedTrajectory"]) expect(kinds(where)).not.toContain(legacy);
    }
    // Exit repeat only where a repeat encloses the list.
    expect(kinds({ list: { kind: "root" } })).not.toContain("exit");
    expect(kinds({ list: { kind: "repeat", nodeId: "loop" } })).toContain("exit");
    const markup = renderToStaticMarkup(createElement(StepInspector, { node: { id: "legacy", type: "function", cat: "velocity" }, acq: {} }));
    expect(markup).toContain("Legacy — cannot deploy");
  });
});
