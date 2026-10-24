import { compileLabviewCatalog } from "../../src/electron/labviewProject";
import { bdxBindingsFromCatalog } from "../../src/electron/bdxBindings";
import { blankPath, buildWaypoints, createDemoProject } from "../../src/shared/project/defaults";
import { forceExportRobot } from "./forceExportRobot";

/** Synthetic type evidence for byte tests, never a claim of inspected or runnable team VIs. */
export function binaryWriterFixture(curved = false, withEvents = true) {
  const project = createDemoProject(), path = blankPath(curved ? "Curve and typed events" : "Straight path");
  project.robot = forceExportRobot();
  path.id = curved ? "fixture-curve" : "fixture-straight";
  if (curved) {
    path.waypoints = buildWaypoints([{ x: 2.2, y: 4, theta: 90, segType: "bezier" }, { x: 3.5, y: 5, theta: 0, segType: "bezier" }, { x: 5, y: 4, theta: -90 }]);
    path.followMode = "time"; path.waypoints[0].segmentFollowMode = "time";
  }
  const declaration = { schemaVersion: "bordeaux-labview-catalog/1", catalogId: "test-only.binary-fixtures", commands: [{
    id: "fixture.command", label: "Typed command fixture", vi: "TestOnly.vi", parameters: [
      { name: "enabled", schema: { kind: "boolean" } }, { name: "power", schema: { kind: "number" } },
      { name: "count", schema: { kind: "integer" } }, { name: "sequence", schema: { kind: "integerString" } },
      { name: "mode", schema: { kind: "enum", enumValues: ["Idle", "Active"] } }, { name: "label", schema: { kind: "string" } },
    ] }], conditions: [{ id: "fixture.ready", label: "Ready fixture", vi: "TestOnlyCondition.vi" }], trajectoryGenerators: [] };
  const compiled = compileLabviewCatalog(declaration);
  const types = ["Boolean", "DBL", "I32", "I64", "EW", "String"], names = ["enabled", "power", "count", "sequence", "mode", "label"];
  const bindings = bdxBindingsFromCatalog({ ...compiled.catalog, projectName: "Codec fixture", scannedAt: "2026-09-07T00:00:00.000Z", sourceFileCount: 0, runtime: "labview", warnings: [],
    commands: compiled.catalog.commands.map((command) => ({ ...command, runtimeReady: false,
      labviewConnector: { labviewVersion: "TEST ONLY", applicationContext: "My Computer", target: "Synthetic test", file: "TestOnly.vi",
        terminalNumbers: names.map((_, i) => i), directions: names.map(() => 0), requirements: names.map(() => 1), captions: names,
        typeXml: names.map((name, i) => `<${types[i]}><Name>${name}</Name>${types[i] === "EW" ? "<Choice>Idle</Choice><Choice>Active</Choice>" : ""}</${types[i]}>`), extendedInfo: [], defaults: {} } })) });
  if (withEvents) path.markers = [0.2, 0.6].map((f, index) => ({ id: `fixture-event-${index}`, name: index ? "Repeated event" : "Timed event", f, group: "sequential",
    invocation: { commandId: "fixture.command", arguments: { enabled: true, power: 0.125, count: -12, sequence: "9007199254740993", mode: "Active", label: "Café 🤖" }, cancelOnPathEnd: false },
    schedule: index ? { trigger: "time", repeatEveryS: 0.2 } : { trigger: "time" } }));
  project.paths = [path]; project.routines = [{ id: "unrelated-routine", name: "Unrelated draft", nodes: [] }]; project.activeRoutineId = "unrelated-routine"; project.editor = { activePathId: path.id };
  return { project, path, bindings };
}
