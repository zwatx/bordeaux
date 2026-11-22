import { describe, expect, it } from "vitest";
import { buildRobotTrajectory } from "../src/core/export/robotTrajectory";
import { getPlanner } from "../src/core/planners";
import { blankPath, buildWaypoints, createDemoProject } from "../src/core/project/defaults";
import type { AutonomousRoutine, RobotCommandCatalog, RoutineNode } from "../src/core/types";

function generatedCatalog(): RobotCommandCatalog {
  return {
    projectName: "CompetitionRobot",
    sourceFileCount: 1,
    scannedAt: "2026-08-05T00:00:00.000Z",
    source: "generated",
    runtimeCommandCount: 1,
    generatedSchemaVersion: "1.1",
    catalogId: "competition-robot",
    supportVersion: "0.2.0",
    catalogHash: `sha256:${"a".repeat(64)}`,
    authoritative: true,
    warnings: [],
    conditions: [{
      id: "frc.robot.Conditions#hasNote",
      label: "Has note",
      ownerType: "frc.robot.Conditions",
      member: "hasNote",
      source: { file: "Commands/Conditions.vi", line: 14 },
    }, {
      id: "frc.robot.Conditions#ready",
      label: "Ready",
      ownerType: "frc.robot.Conditions",
      member: "ready",
      source: { file: "Commands/Conditions.vi", line: 9 },
    }],
    commands: [{
      id: "frc.robot.AutoCommands#score",
      label: "Score",
      ownerType: "frc.robot.AutoCommands",
      member: "score",
      kind: "factory",
      confidence: "confirmed",
      runtimeReady: true,
      source: { file: "Commands/AutoCommands.vi", line: 12 },
      parameters: [
        { name: "sequence", valueType: "I64", role: "argument", schema: { kind: "integerString", valueType: "I64" } },
        {
          name: "target",
          valueType: "frc.robot.Target",
          role: "argument",
          schema: { kind: "object", valueType: "frc.robot.Target", fields: [{ name: "level", schema: { kind: "string", valueType: "String" } }] },
        },
      ],
    }],
  };
}

describe("Robot trajectory export", () => {
  it("emits stable timed events with exact custom arguments and catalog identity", () => {
    const project = createDemoProject();
    project.name = "Two Piece Auto";
    project.paths[0].markers = [{
      id: "event_score",
      f: 0.5,
      name: "Score",
      invocation: {
        commandId: "frc.robot.AutoCommands#score",
        arguments: { sequence: "9007199254740993", target: { level: "L4" } },
        cancelOnPathEnd: true,
      },
      schedule: { trigger: "position", repeatEveryS: 0.1, endTimeS: 2, conditionId: "frc.robot.Conditions#ready" },
    }];

    const built = buildRobotTrajectory(project, generatedCatalog());

    expect(built.document.field).toEqual(project.field);
    expect(built.document.catalog.catalogHash).toMatch(/^sha256:/);
    expect(built.document.catalog.catalogId).toBe("competition-robot");
    expect(built.document.paths[0].events).toEqual([expect.objectContaining({
      eventId: "event_score",
      commandId: "frc.robot.AutoCommands#score",
      arguments: { sequence: "9007199254740993", target: { level: "L4" } },
      cancelOnPathEnd: true,
      trigger: "position",
      repeatEveryS: 0.1,
      endTimeS: 2,
      conditionId: "frc.robot.Conditions#ready",
    })]);
    expect(built.eventCount).toBe(1);
  });

  it("exports mixed time and position following by authored segment", () => {
    const project = createDemoProject();
    project.paths[0].followMode = "position";
    project.paths[0].waypoints = buildWaypoints([
      { x: 1, y: 2, theta: 0, segmentFollowMode: "time" },
      { x: 4, y: 2, theta: 0 },
      { x: 7, y: 2, theta: 0 },
    ]);

    const sections = buildRobotTrajectory(project, generatedCatalog()).document.paths[0].followSections;

    expect(sections.map((section) => section.mode)).toEqual(["time", "position"]);
    expect(sections[0].startSample).toBe(0);
    expect(sections[0].endSample).toBe(sections[1].startSample);
    expect(sections[1].endSample).toBeGreaterThan(sections[1].startSample);
  });

  it("keeps a follow section through a final duplicate segment", () => {
    const project = createDemoProject();
    project.paths[0].waypoints = buildWaypoints([
      { x: 1, y: 1, segType: "clothoid" },
      { x: 5, y: 5, segType: "clothoid" },
      { x: 10, y: 2, segType: "clothoid" },
      { x: 12, y: 6, segType: "bezier" },
      { x: 12, y: 6, segType: "line" },
    ]);

    const sections = buildRobotTrajectory(project, generatedCatalog()).document.paths[0].followSections;

    expect(sections).toHaveLength(4);
    expect(sections[3].startSample).toBe(sections[2].endSample);
    expect(sections[3].endSample).toBeGreaterThan(sections[3].startSample);
  });

  it("exports a terminal position-follow wait as a trailing time section", () => {
    const project = createDemoProject();
    project.paths[0].followMode = "position";
    project.paths[0].waypoints = buildWaypoints([
      { x: 1, y: 2, segType: "line" },
      { x: 5, y: 2, segType: "line", stop: true, wait: 1 },
    ]);

    const path = buildRobotTrajectory(project, generatedCatalog()).document.paths[0];

    expect(path.followSections.map((section) => section.mode)).toEqual(["position", "time"]);
    expect(path.followSections[0].endSample).toBe(path.followSections[1].startSample);
    expect(path.followSections[1].endSample).toBe(path.samples.length - 1);
    const holdDuration = path.samples.at(-1)!.t - path.samples[path.followSections[1].startSample].t;
    expect(holdDuration).toBeGreaterThanOrEqual(1);
    expect(holdDuration).toBeLessThan(1.05);
  });

  it("exports consecutive duplicate actions from their authored boundaries", () => {
    const project = createDemoProject();
    project.paths[0].followMode = "position";
    project.paths[0].waypoints = buildWaypoints([
      { x: 0, y: 2, segType: "line" },
      { x: 2, y: 2, segType: "line" },
      { x: 2, y: 2, segType: "line", stop: true, wait: 1 },
      { x: 2, y: 2, segType: "line", stop: true, wait: 2 },
      { x: 1, y: 2, segType: "line" },
      { x: 3, y: 2, segType: "line" },
    ]);

    const path = buildRobotTrajectory(project, generatedCatalog()).document.paths[0];
    const arrivals = getPlanner(project.plannerId).generate({ path: project.paths[0], robot: project.robot })
      .waypointSampleIndices!;

    for (const [waypointIndex, wait] of [[2, 1], [3, 2]] as const) {
      const section = path.followSections.find((candidate) => (
        candidate.mode === "time" && candidate.startSample === arrivals[waypointIndex]
      ));
      expect(section).toBeDefined();
      expect(path.samples[section!.endSample].t - path.samples[section!.startSample].t)
        .toBeGreaterThanOrEqual(wait - 1e-4);
    }
  });

  it("exports decisions and bound commands between paths", () => {
    const project = createDemoProject();
    const pathId = project.paths[0].id;
    const selectedRoutine: AutonomousRoutine = { id: "routine_selected", name: "Choose note", nodes: [{
      id: "note-present", type: "decision", cond: "frc.robot.Conditions#hasNote",
      thenLabel: "present", elseLabel: "missing",
      then: [{ id: "score", type: "function", cat: "command", invocation: {
        commandId: "frc.robot.AutoCommands#score",
        arguments: { sequence: "2", target: { level: "L4" } },
      } }, { id: "run-a", type: "path", ref: pathId }],
      else: [{ id: "run-b", type: "path", ref: pathId }],
    }] };
    project.routines.push(selectedRoutine);
    project.activeRoutineId = selectedRoutine.id;

    const routine = buildRobotTrajectory(project, generatedCatalog()).document.routine!;

    expect(routine.name).toBe(selectedRoutine.name);
    expect(routine.nodes[0]).toEqual(expect.objectContaining({ type: "decision", cond: "frc.robot.Conditions#hasNote" }));
    expect((routine.nodes[0] as { then: unknown[] }).then[0]).toEqual(expect.objectContaining({ cat: "command" }));
  });

  it("blocks blank, stale, and unregistered condition capabilities before export", () => {
    const project = createDemoProject();
    project.paths[0].markers = [{
      id: "conditional-score",
      f: 0.5,
      name: "Score when ready",
      invocation: { commandId: "frc.robot.AutoCommands#score", arguments: { sequence: "1", target: { level: "L4" } } },
      schedule: { conditionId: "frc.robot.Conditions#missing" },
    }];
    expect(() => buildRobotTrajectory(project, generatedCatalog())).toThrow(/paths\[0\].markers\[0\].schedule\.conditionId.*not in the linked generated catalog/i);

    const decision: Extract<RoutineNode, { type: "decision" }> = { id: "condition", type: "decision", cond: "", thenLabel: "yes", elseLabel: "no", then: [], else: [] };
    project.routines[0].nodes = [decision];
    project.paths[0].markers = [];
    expect(() => buildRobotTrajectory(project, generatedCatalog())).toThrow(/routines\[0\].nodes\[0\].cond.*registered condition ID/i);

    decision.cond = "frc.robot.Conditions#ready";
    decision.then.push({ id: "nested", type: "decision", cond: "frc.robot.Conditions#missing", thenLabel: "yes", elseLabel: "no", then: [], else: [] });
    expect(() => buildRobotTrajectory(project, generatedCatalog())).toThrow(/routines\[0\].nodes\[0\].then\[0\].cond.*not in the linked generated catalog/i);

    decision.then = [];
    const legacy = generatedCatalog();
    legacy.generatedSchemaVersion = "1.0";
    legacy.conditions = [];
    expect(() => buildRobotTrajectory(project, legacy)).toThrow(/condition catalog is stale.*schema 1\.1/i);
  });

  it("treats a cleared optional marker condition as absent", () => {
    const project = createDemoProject();
    project.paths[0].markers = [{
      id: "unconditional-score",
      f: 0.5,
      name: "Score",
      invocation: { commandId: "frc.robot.AutoCommands#score", arguments: { sequence: "1", target: { level: "L4" } } },
      schedule: { conditionId: undefined },
    }];

    expect(buildRobotTrajectory(project, generatedCatalog()).document.paths[0].events[0]).not.toHaveProperty("conditionId");
  });

  it("blocks source-only, unresolved legacy, and schema-invalid commands", () => {
    const project = createDemoProject();
    project.paths[0].markers = [{ id: "legacy", f: 0.2, name: "Legacy", cmd: "shoot" }];
    expect(() => buildRobotTrajectory(project, generatedCatalog())).toThrow(/Legacy command shoot/);

    project.paths[0].markers = [{
      id: "bad",
      f: 0.2,
      name: "Bad",
      invocation: { commandId: "frc.robot.AutoCommands#score", arguments: { sequence: "9223372036854775808", target: { level: "L4" } } },
    }];
    expect(() => buildRobotTrajectory(project, generatedCatalog())).toThrow(/signed 64-bit/);

    const sourceOnly = generatedCatalog();
    sourceOnly.commands[0].runtimeReady = false;
    expect(() => buildRobotTrajectory(project, sourceOnly, { requireGeneratedBindings: true })).toThrow(/no generated robot binding/);
  });

  it("blocks collections larger than the robot runtime accepts", () => {
    const project = createDemoProject();
    const catalog = generatedCatalog();
    catalog.commands[0].parameters = [
      { name: "items", valueType: "Array<String>", role: "argument", schema: { kind: "array", valueType: "Array<String>", element: { kind: "string", valueType: "String" } } },
      { name: "lookup", valueType: "Map<String, String>", role: "argument", schema: { kind: "map", valueType: "Map<String, String>", value: { kind: "string", valueType: "String" } } },
    ];
    project.paths[0].markers = [{
      id: "oversized",
      f: 0.2,
      name: "Oversized",
      invocation: {
        commandId: catalog.commands[0].id,
        arguments: { items: Array.from({ length: 1_025 }, () => "x"), lookup: {} },
      },
    }];
    expect(() => buildRobotTrajectory(project, catalog)).toThrow(/more than 1024 items/);

    project.paths[0].markers[0].invocation!.arguments = {
      items: [],
      lookup: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`key${index}`, "x"])),
    };
    expect(() => buildRobotTrajectory(project, catalog)).toThrow(/more than 256 entries/);
  });

  it("allows local trajectory calculation without a generated catalog for eventless paths", () => {
    const catalog = generatedCatalog();
    catalog.authoritative = false;
    expect(() => buildRobotTrajectory(createDemoProject(), catalog)).not.toThrow();
  });

  it("rejects a document with no exportable paths before the robot reader does", () => {
    const project = createDemoProject();
    project.paths.forEach((path) => { path.exportable = false; });

    expect(() => buildRobotTrajectory(project, generatedCatalog()))
      .toThrow("Robot trajectory export requires at least one exportable path");
  });

  it("rejects oversized event and metadata payloads during preflight", () => {
    const eventProject = createDemoProject();
    eventProject.paths[0].markers = Array.from({ length: 2_001 }, (_, index) => ({
      id: `event-${index}`,
      f: 0.5,
      name: `Event ${index}`,
      invocation: {
        commandId: "frc.robot.AutoCommands#score",
        arguments: { sequence: "1", target: { level: "L4" } },
      },
    }));
    expect(() => buildRobotTrajectory(eventProject, generatedCatalog())).toThrow(/exceeds 2000 events/);

    const metadataProject = createDemoProject();
    const metadataCatalog = generatedCatalog();
    metadataCatalog.commands[0].parameters = [{
      name: "message",
      valueType: "String",
      role: "argument",
      schema: { kind: "string", valueType: "String" },
    }];
    metadataProject.paths[0].markers = [{
      id: "large-message",
      f: 0.5,
      name: "Large message",
      invocation: {
        commandId: metadataCatalog.commands[0].id,
        arguments: { message: "x".repeat(16 * 1024 * 1024) },
      },
    }];
    expect(() => buildRobotTrajectory(metadataProject, metadataCatalog)).toThrow(/exceeds 16777216 bytes/);
  });

  it("rejects aggregate base samples before generating any trajectory", () => {
    const project = createDemoProject();
    project.paths[0].waypoints = buildWaypoints(Array.from({ length: 1_787 }, (_, index) => ({
      x: 1 + index * 0.001,
      y: 2,
      theta: 0,
    })));

    expect(() => buildRobotTrajectory(project, generatedCatalog())).toThrow("exceeds 100000 samples");
  });

  it("rejects more paths and routine nodes than the robot runtime accepts", () => {
    const pathProject = createDemoProject();
    pathProject.paths = Array.from({ length: 65 }, (_, index) => ({
      ...blankPath(`Path ${index}`),
      id: `path_${index}`,
    }));
    pathProject.editor = { activePathId: pathProject.paths[0].id };
    expect(() => buildRobotTrajectory(pathProject, generatedCatalog())).toThrow("exceeds 64 paths");

    const routineProject = createDemoProject();
    routineProject.routines[0].nodes = Array.from({ length: 2_001 }, (_, index) => ({
      id: `path_node_${index}`,
      type: "path" as const,
      ref: routineProject.paths[0].id,
    }));
    expect(() => buildRobotTrajectory(routineProject, generatedCatalog())).toThrow("exceeds 2000 routine nodes");
  });

  it("rejects routine JSON deeper than the Robot reader accepts", () => {
    const project = createDemoProject();
    let nodes: RoutineNode[] = [{ id: "path-node", type: "path", ref: project.paths[0].id }];
    for (let depth = 0; depth < 20; depth += 1) {
      nodes = [{
        id: `decision-${depth}`,
        type: "decision",
        cond: "frc.robot.Conditions#ready",
        thenLabel: "yes",
        elseLabel: "no",
        then: nodes,
        else: [],
      }];
    }
    project.routines[0].nodes = nodes;

    expect(() => buildRobotTrajectory(project, generatedCatalog())).toThrow("exceeds JSON nesting depth of 40");
  });
});
