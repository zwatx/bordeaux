import { describe, expect, it } from "vitest";
import { buildBdxExport } from "../src/core/export/bdx";
import { createDemoProject } from "../src/core/project/defaults";
import type { BordeauxProject, RobotCommandCatalog, RobotCommandDescriptor } from "../src/core/types";
import { validateProject } from "../src/core/validation";
import { validateProjectRobotInvocations } from "../src/core/robotCommands";

describe("Robot command marker invocations", () => {
  it("preserves JSON-compatible custom arguments in native planner output", () => {
    const project = createDemoProject();
    project.paths[0].markers = [{
      f: 0.5,
      name: "score",
      invocation: {
        commandId: "frc.robot.Superstructure#score",
        arguments: {
          target: { level: "L4", pose: { x: 2.1, y: 4.8 }, tags: ["auto", "reef"] },
          releaseDelayS: 0.15,
          retry: false,
          fallback: null,
        },
      },
    }];

    expect(validateProject(project).ok).toBe(true);
    expect(buildBdxExport(project).paths[0].markers[0].invocation).toEqual(project.paths[0].markers[0].invocation);
  });

  it("rejects invalid invocation IDs and nonfinite nested arguments", () => {
    const project = createDemoProject() as BordeauxProject;
    project.paths[0].markers = [{
      f: 0.5,
      name: "bad",
      invocation: { commandId: "", arguments: { nested: { value: Number.NaN } } },
    }];

    const result = validateProject(project);
    expect(result.ok).toBe(false);
    expect(result.issues.map((item) => item.path)).toEqual(expect.arrayContaining([
      "$.paths[0].markers[0].invocation.commandId",
      "$.paths[0].markers[0].invocation.arguments.nested.value",
    ]));
  });

  it("keeps a pending action intent editable but blocks Robot export", () => {
    const project = createDemoProject();
    project.paths[0].markers = [{
      f: 1,
      name: "shoot into the HUB",
      cmd: "none",
      actionIntent: { semanticTag: "shoot-fuel", description: "shoot into the HUB" },
    }];

    expect(validateProject(project).ok).toBe(true);
    expect(validateProjectRobotInvocations(project, null)).toEqual([
      expect.objectContaining({ path: expect.stringContaining("actionIntent"), severity: "error" }),
    ]);
  });

  it("requires a bound command to advertise the pending action capability", () => {
    const project = createDemoProject();
    project.paths[0].markers = [{
      f: 1,
      name: "shoot into the HUB",
      actionIntent: { semanticTag: "shoot-fuel", description: "shoot into the HUB" },
      invocation: { commandId: "robot.drive", arguments: {} },
    }];
    const command: RobotCommandDescriptor = {
      id: "robot.drive",
      label: "Drive",
      ownerType: "frc.robot.Drive",
      member: "create",
      kind: "factory" as const,
      confidence: "confirmed" as const,
      runtimeReady: true,
      parameters: [],
      source: { file: "Drive.vi", line: 1 },
    };
    const catalog: RobotCommandCatalog = {
      projectName: "Robot",
      sourceFileCount: 1,
      scannedAt: new Date(0).toISOString(),
      warnings: [],
      commands: [command],
    };

    expect(validateProjectRobotInvocations(project, catalog)).toEqual([
      expect.objectContaining({ path: expect.stringContaining("actionIntent"), severity: "error" }),
    ]);

    command.semanticTags = ["shoot-fuel"];
    expect(validateProjectRobotInvocations(project, catalog)).toEqual([]);
  });

});
