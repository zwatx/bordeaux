// Robot details that leave the project (`.robot` files, standalone `.path` documents) and robot copies: what they
// carry and what planning sees afterwards. Review round 4, items 2, 5, 6 and 10.
import { describe, expect, it } from "vitest";
import { buildWaypoints, createDemoProject } from "../src/core/project/defaults";
import { decodeProjectFile, prepareProjectFile } from "../src/core/project/fileFormat";
import { projectDocuments } from "../src/core/project/folderLayout";
import { commandInputKey, pathCommandReserveA } from "../src/core/commandLoads";
import { setCommandUseEstimate, type CommandUseLocation } from "../src/core/project/commandPower";
import { parseRobotFile, robotFileContents, robotFileDetails, robotPushFileConflict } from "../src/core/project/robotFile";
import { addRobot, duplicateRobot, removeRobot, renameRobot, robotDetailsOf, selectRobot, setRobotConnection, ROBOT_LIMIT } from "../src/core/project/robots";
import { validateProject } from "../src/core/validation";
import type { BordeauxProject, PathDoc, RobotConfig } from "../src/core/types";

const endpoint = { target: "roborio" as const, host: "10.24.68.2", port: 22, directory: "/home/lvuser/bordeaux" };
const at: CommandUseLocation = { kind: "pathEvent", pathId: "path-a", markerIndex: 0, markerId: "m0" };

/** One path with one use of `intake`, in a project whose robots are listed (the first keeps the id "robot"). */
function project(): BordeauxProject {
  const demo = createDemoProject();
  const path: PathDoc = { ...demo.paths[0], id: "path-a", name: "Intake run", waypoints: buildWaypoints([{ x: 1, y: 2, theta: 0 }, { x: 6, y: 2, theta: 0 }]),
    markers: [{ id: "m0", f: 0.5, name: "Intake", invocation: { commandId: "intake", arguments: {} } }] };
  let next = prepareProjectFile({ ...demo, paths: [path], editor: { activePathId: path.id } });
  next = setRobotConnection(next, endpoint);
  return renameRobot(next, next.activeRobotId!, "Comp bot");
}
/** The standalone `.path` document the folder writes for `pathId`, opened on its own as a project. */
function standalone(source: BordeauxProject, pathId = "path-a"): BordeauxProject {
  const name = source.paths.find((path) => path.id === pathId)!.name;
  const document = projectDocuments(source).find((item) => item.file === `Paths/${name}.path`)!;
  return decodeProjectFile(document.contents).project;
}
const reserve = (target: BordeauxProject) => pathCommandReserveA(target.robot, target.paths[0].markers);

describe("a standalone .path keeps the saving robot's power estimates", () => {
  it("keeps a named robot's own estimate", () => {
    let source = project();
    source = duplicateRobot(source, source.activeRobotId!); // a robot with a generated id, selected
    source = setCommandUseEstimate(source, at, source.activeRobotId!, { currentA: 65 });
    expect(reserve(source)).toBe(65);
    expect(reserve(standalone(source))).toBe(65);
  });

  it("keeps an estimate the robot inherits through its copies", () => {
    let source = project();
    const original = source.activeRobotId!;
    source = setCommandUseEstimate(source, at, original, { currentA: 45, runTimeS: 2 });
    source = duplicateRobot(source, original);
    source = duplicateRobot(source, source.activeRobotId!);
    expect(reserve(source)).toBe(45);
    const opened = standalone(source);
    expect(reserve(opened)).toBe(45);
    expect(opened.paths[0].markers[0].invocation!.power).toEqual({ robot: { currentA: 45, runTimeS: 2, inputKey: commandInputKey({ commandId: "intake", arguments: {} }) } });
  });

  it("gives the importer the selected robot's value when the original robot (id \"robot\") has another one", () => {
    let source = project();
    const original = source.activeRobotId!;
    expect(original).toBe("robot");
    source = setCommandUseEstimate(source, at, original, { currentA: 20 });
    source = duplicateRobot(source, original);
    source = setCommandUseEstimate(source, at, source.activeRobotId!, { currentA: 65 });
    expect(reserve(source)).toBe(65);
    expect(reserve(standalone(source))).toBe(65);
    // From the original it is the original's.
    expect(reserve(standalone(selectRobot(source, original)))).toBe(20);
  });

  it("writes no other robot's estimates and no share list into the document", () => {
    let source = project();
    source = setCommandUseEstimate(source, at, "robot", { currentA: 20 });
    source = duplicateRobot(source, "robot");
    const text = projectDocuments(source).find((item) => item.file === "Paths/Intake run.path")!.contents;
    expect(JSON.parse(text).robot).not.toHaveProperty("estimatesFrom");
    expect(Object.keys(JSON.parse(text).markers[0].invocation.power)).toEqual(["robot"]);
    // A use with no estimate on the selected robot carries none.
    const bare = removeRobot(setCommandUseEstimate(addRobot(project(), "Other"), at, "robot", { currentA: 20 }), "robot");
    const opened = standalone(bare);
    expect(opened.paths[0].markers[0].invocation).not.toHaveProperty("power");
    expect(reserve(opened)).toBe(0);
  });
});

describe(".robot files carry only the robot's transferable details", () => {
  const leaky = (robot: RobotConfig) => ({
    ...robot, id: "robot_secret", estimatesFrom: ["robot"], connection: endpoint, hostKeyFingerprint: "SHA256:abc", password: "hunter2", future: 1,
    driveModel: { ...robot.driveModel!, password: "nested", commandLoads: [{ commandId: "intake", currentA: 20, extra: true }],
      driveBreaker: { ratedCurrentA: 40, tripTimeAt2xS: 5, initialHeat: 0, note: "x" } },
    cameras: [{ id: "c", name: "Front", horizontalFovDeg: 70, verticalFovDeg: 50, positionM: { x: 0.3, y: 0, z: 0.4, w: 9 }, yawDeg: 0, pitchDeg: 10, serial: "S1" }],
    planning: { notes: "n", token: "t", intake: { name: "I", centerM: { x: 0, y: 0 }, directionDeg: 0, captureWidthM: 0.5, maxCollectSpeedMps: 1, secret: 1 } },
  }) as unknown as RobotConfig;
  const forbidden = /robot_secret|estimatesFrom|connection|10\.24\.68\.2|hostKey|SHA256|password|hunter2|nested|future|"extra"|"note"|serial|token|secret/;

  it("writes an allowlisted projection, nested fields included", () => {
    const robot = leaky(project().robot);
    const text = robotFileContents("Comp bot", robot);
    expect(text).not.toMatch(forbidden);
    const parsed = JSON.parse(text);
    expect(parsed.driveModel.commandLoads).toEqual([{ commandId: "intake", currentA: 20 }]);
    expect(parsed.driveModel.driveBreaker).toEqual({ ratedCurrentA: 40, tripTimeAt2xS: 5, initialHeat: 0 });
    expect(parsed.cameras[0]).toEqual({ id: "c", name: "Front", horizontalFovDeg: 70, verticalFovDeg: 50, positionM: { x: 0.3, y: 0, z: 0.4 }, yawDeg: 0, pitchDeg: 10 });
    expect(Object.keys(robotFileDetails(robot))).not.toContain("connection");
  });

  it("writes the projection in the project folder", () => {
    const source = project();
    const leakyProject = { ...source, robot: leaky(source.robot) };
    const text = projectDocuments(leakyProject).find((item) => item.file === "Robots/Comp bot.robot")!.contents;
    expect(text).not.toMatch(forbidden);
  });

  it("reads only the projection from a hand-edited file", () => {
    const robot = leaky(project().robot);
    const text = JSON.stringify({ format: "bordeaux-robot/1", name: "Comp bot", ...robot });
    const parsed = parseRobotFile(text).robot;
    expect(JSON.stringify(parsed)).not.toMatch(forbidden);
    expect(parsed.driveModel!.commandLoads).toEqual([{ commandId: "intake", currentA: 20 }]);
  });

  it("round-trips every field a valid robot has", () => {
    const robot = { ...project().robot, heightM: 0.6, footprintPreset: { kind: "trapezoid" as const, frontWidthM: 0.5, rearWidthM: 0.6 },
      footprint: { kind: "polygon" as const, verticesM: [{ x: 0.3, y: 0.25 }, { x: -0.3, y: 0.3 }, { x: -0.3, y: -0.3 }, { x: 0.3, y: -0.25 }] },
      planning: { notes: "n", intake: { name: "I", centerM: { x: 0.1, y: 0 }, directionDeg: 0, captureWidthM: 0.5, maxCollectSpeedMps: 1 },
        shooter: { directionDeg: 180, requiresTargetFacing: true, preferredRangeM: 2 } },
      cameras: [{ id: "c", name: "Front", horizontalFovDeg: 70, verticalFovDeg: 50, positionM: { x: 0.3, y: 0, z: 0.4 }, yawDeg: 0, pitchDeg: 10, maxRangeM: 4 }],
      driveModel: { ...project().robot.driveModel!, loadBursts: [{ startTimeS: 0, endTimeS: 1, currentA: 20 }], commandLoads: [{ commandId: "a", currentA: 3, runTimeS: 1 }],
        driveBreaker: { ratedCurrentA: 40, tripTimeAt2xS: 5, initialHeat: 0.2 }, mainBreaker: { ratedCurrentA: 120, tripTimeAt2xS: 20, initialHeat: 0 } } };
    const { id: _id, estimatesFrom: _from, ...details } = robot;
    expect(parseRobotFile(robotFileContents("Comp bot", robot)).robot).toEqual(details);
  });
});

describe("robot names that share a pushed file name", () => {
  it("are named together for Push and Pull", () => {
    let source = project();
    source = addRobot(source, "Comp-bot");
    expect(source.robots!.map((robot) => robot.name)).toEqual(["Comp bot", "Comp-bot"]);
    const message = robotPushFileConflict(source, source.activeRobotId!);
    expect(message).toMatch(/Comp-bot.*Comp bot|Comp bot.*Comp-bot/);
    expect(message).toContain("Comp-bot.robot");
    expect(robotPushFileConflict(source, "robot")).toMatch(/Comp-bot.*Comp bot|Comp bot.*Comp-bot/);
    expect(robotPushFileConflict(renameRobot(source, source.activeRobotId!, "Practice"), source.activeRobotId!)).toBeNull();
  });

  it("get distinct project folder files", () => {
    let source = project();
    source = addRobot(source, "Comp/bot");
    source = renameRobot(source, "robot", "Comp-bot");
    const files = projectDocuments(source).filter((item) => item.file.startsWith("Robots/")).map((item) => item.file);
    expect(new Set(files.map((file) => file.toLowerCase())).size).toBe(2);
  });
});

describe("a copy of a copy keeps the estimates it plans with", () => {
  it("keeps an inherited estimate past the share-list limit while only the newest copy stays", () => {
    let source = project();
    source = setCommandUseEstimate(source, at, "robot", { currentA: 45 });
    for (let generation = 1; generation <= ROBOT_LIMIT + 4; generation++) {
      const previous = source.activeRobotId!;
      source = duplicateRobot(source, previous);
      source = removeRobot(source, previous);
      expect(source.robots!.length).toBe(1);
      expect(reserve(source)).toBe(45);
      expect(validateProject(source).ok).toBe(true);
    }
  });

  it("keeps the nearest estimate first after collapsing the list", () => {
    let source = project();
    source = setCommandUseEstimate(source, at, "robot", { currentA: 45 });
    const marker2 = { id: "m1", f: 0.7, name: "Shoot", invocation: { commandId: "shoot", arguments: {} } };
    source = { ...source, paths: [{ ...source.paths[0], markers: [...source.paths[0].markers, marker2] }] };
    for (let generation = 1; generation <= ROBOT_LIMIT + 2; generation++) {
      const previous = source.activeRobotId!;
      source = duplicateRobot(source, previous);
      source = removeRobot(source, previous);
      if (generation === 5) source = setCommandUseEstimate(source, at, source.activeRobotId!, { currentA: 30 });
      if (generation === 6) source = setCommandUseEstimate(source, { ...at, markerIndex: 1, markerId: "m1" }, source.activeRobotId!, { currentA: 10 });
    }
    expect(reserve(source)).toBe(40);
    expect(source.robot.estimatesFrom!.length).toBeLessThanOrEqual(ROBOT_LIMIT);
    expect(robotDetailsOf(source, source.activeRobotId!)).toBe(source.robot);
  });
});
