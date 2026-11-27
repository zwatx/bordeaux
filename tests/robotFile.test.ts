// Robot details as `.robot` files: the format, the project folder documents, and the desktop folder writer.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoProject } from "../src/core/project/defaults";
import { MANAGED_SOURCE_FILE, projectDocuments } from "../src/core/project/folderLayout";
import { ROBOT_FILE_FORMAT, parseRobotFile, robotDetailsProblem, robotFileContents, robotPushFileName } from "../src/core/project/robotFile";
import { validateRobotDetails } from "../src/core/validation";
import { addRobot, duplicateRobot, removeRobot, renameRobot, replaceRobotDetails, robotDetailsOf, selectRobot, setRobotConnection } from "../src/core/project/robots";
import { prepareProjectFile } from "../src/core/project/fileFormat";
import { binaryFileName } from "../src/core/export/robotBinary";
import { autosaveProjectFolder, projectWorkspacePath } from "../src/electron/projectFiles";
import { loadProjectSelection } from "../src/electron/projectOpening";
import type { BordeauxProject, RobotConfig } from "../src/core/types";

/** A file's structure and then its details, as Pull checks them (the editor validates details through its host). */
function decodeRobotFile(text: string) {
  const file = parseRobotFile(text), problem = robotDetailsProblem(validateRobotDetails(file.robot));
  if (problem) throw new Error(problem);
  return file;
}


const endpoint = { target: "roborio" as const, host: "10.24.68.2", port: 22, directory: "/home/lvuser/bordeaux" };
/** A project with two robots: "Comp bot" (with an address, cameras and a share list) and "Practice bot", selected. */
function twoRobots(): BordeauxProject {
  let project = prepareProjectFile(createDemoProject());
  project = setRobotConnection(project, endpoint);
  project = renameRobot(project, project.activeRobotId!, "Comp bot");
  project = { ...project, robot: { ...project.robot, heightM: 0.6, cameras: [{ id: "cam", name: "Front", horizontalFovDeg: 70, verticalFovDeg: 50, positionM: { x: 0.3, y: 0, z: 0.4 }, yawDeg: 0, pitchDeg: 10 }] } };
  project = duplicateRobot(project, project.activeRobotId!);
  return renameRobot(project, project.activeRobotId!, "Practice bot");
}

describe(".robot file format", () => {
  it("round-trips a robot's details and never writes its id, shared estimates or address", () => {
    const project = twoRobots();
    expect(project.robot.id).toBe(project.activeRobotId);
    expect(project.robot.estimatesFrom?.length).toBe(1);
    const text = robotFileContents("Practice bot", project.robot);
    const raw = JSON.parse(text);
    expect(Object.keys(raw).slice(0, 2)).toEqual(["format", "name"]);
    expect(raw).toMatchObject({ format: ROBOT_FILE_FORMAT, name: "Practice bot", w: project.robot.w, cameras: [{ name: "Front" }] });
    for (const key of ["id", "estimatesFrom", "connection"]) expect(raw).not.toHaveProperty(key);
    expect(text).not.toContain(endpoint.host);
    expect(text).not.toContain(project.activeRobotId);
    const { id: _id, estimatesFrom: _from, ...details } = project.robot;
    expect(decodeRobotFile(text)).toEqual({ name: "Practice bot", robot: details });
    // Re-encoding the decoded details gives the same bytes, so a pulled file and its push compare equal.
    expect(robotFileContents("Practice bot", decodeRobotFile(text).robot)).toBe(text);
  });

  it("drops project-only fields a hand-edited file carries", () => {
    const raw = { ...JSON.parse(robotFileContents("Bot", createDemoProject().robot)), id: "robot_x", estimatesFrom: ["robot_y"], connection: endpoint };
    const decoded = decodeRobotFile(JSON.stringify(raw));
    expect(decoded.robot).not.toHaveProperty("id");
    expect(decoded.robot).not.toHaveProperty("estimatesFrom");
    expect(decoded.robot).not.toHaveProperty("connection");
  });

  it.each([
    ["not JSON", "{", /not valid JSON/],
    ["a path file", JSON.stringify({ version: "2.0", waypoints: [] }), /not a robot file/],
    ["a newer format", JSON.stringify({ format: "bordeaux-robot/2", name: "Bot" }), /newer Bordeaux \(bordeaux-robot\/2\)/],
    ["no name", JSON.stringify({ ...JSON.parse(robotFileContents("Bot", createDemoProject().robot)), name: " " }), /robot name/],
    ["a negative width", JSON.stringify({ ...JSON.parse(robotFileContents("Bot", createDemoProject().robot)), w: -1 }), /Robot width.*\(w\)/],
    ["a bad drive", JSON.stringify({ ...JSON.parse(robotFileContents("Bot", createDemoProject().robot)), drive: "hover" }), /Drive must be swerve or tank/],
  ])("refuses %s with the reason", (_label, text, reason) => {
    expect(() => decodeRobotFile(text)).toThrow(reason);
  });

  it("keeps only values of each detail's own type, projecting footprint presets by kind and lists item by item", () => {
    const junk = { secret: "SECRET" };
    const demo = createDemoProject().robot;
    const point = (x: number, y: number) => ({ x, y, extra: junk });
    const camera = { id: "cam", name: "Front", horizontalFovDeg: 70, verticalFovDeg: 50, positionM: { x: 0.3, y: 0, z: 0.4, extra: junk }, yawDeg: 0, pitchDeg: 10, extra: junk };
    const dirty = {
      ...demo, heightM: [junk], maxSpeed: junk,
      footprintPreset: { kind: "trapezoid", frontWidthM: 0.5, rearWidthM: 0.4, vertices: junk },
      footprint: { kind: "polygon", verticesM: [point(0.4, 0.3), point(-0.4, 0.3), point(-0.4, -0.3), junk, "SECRET"] },
      planning: { notes: junk, intake: { name: "Intake", centerM: point(0.4, 0), directionDeg: 0, captureWidthM: 0.5, maxCollectSpeedMps: [junk] }, shooter: junk },
      cameras: [camera, junk, "SECRET"],
      driveModel: { ...demo.driveModel!, motorId: junk, commandLoads: [{ commandId: "intake", currentA: 20, runTimeS: junk }], driveBreaker: [junk] },
    } as unknown as RobotConfig;
    const text = robotFileContents("Bot", dirty);
    expect(text).not.toContain("SECRET");
    const raw = JSON.parse(text);
    expect(raw.footprintPreset).toEqual({ kind: "trapezoid", frontWidthM: 0.5, rearWidthM: 0.4 });
    // An object item keeps only its listed fields (the validator refuses an empty vertex); a scalar item is dropped.
    expect(raw.footprint.verticesM).toEqual([{ x: 0.4, y: 0.3 }, { x: -0.4, y: 0.3 }, { x: -0.4, y: -0.3 }, {}]);
    expect(raw).not.toHaveProperty("heightM");
    expect(raw).not.toHaveProperty("maxSpeed");
    expect(raw.planning).toEqual({ intake: { name: "Intake", centerM: { x: 0.4, y: 0 }, directionDeg: 0, captureWidthM: 0.5 }, shooter: {} });
    expect(raw.cameras).toEqual([{ id: "cam", name: "Front", horizontalFovDeg: 70, verticalFovDeg: 50, positionM: { x: 0.3, y: 0, z: 0.4 }, yawDeg: 0, pitchDeg: 10 }, {}]);
    expect(raw.driveModel).not.toHaveProperty("motorId");
    expect(raw.driveModel).not.toHaveProperty("driveBreaker");
    expect(raw.driveModel.commandLoads).toEqual([{ commandId: "intake", currentA: 20 }]);
    // A round preset keeps its vertex count; one of an unknown kind keeps only the kind, for the validator to refuse.
    expect(JSON.parse(robotFileContents("Bot", { ...demo, footprintPreset: { kind: "round", vertices: 12, frontWidthM: 1 } } as never)).footprintPreset).toEqual({ kind: "round", vertices: 12 });
    expect(JSON.parse(robotFileContents("Bot", { ...demo, footprintPreset: { kind: "star", vertices: junk } } as never)).footprintPreset).toEqual({ kind: "star" });
    // Reading refuses a listed field of the wrong type instead of dropping it, so a broken file can't read as a removal.
    expect(() => parseRobotFile(JSON.stringify({ format: ROBOT_FILE_FORMAT, name: "Bot", ...dirty }))).toThrow(/has the wrong type/);
    // Unknown fields, nested or not, are dropped on reading and never reach the project.
    const extra = { ...JSON.parse(robotFileContents("Bot", demo)), host: "SECRET", planning: { notes: "n", secret: "SECRET" }, driveModel: { ...demo.driveModel!, token: { SECRET: 1 } } };
    expect(JSON.stringify(parseRobotFile(JSON.stringify(extra)).robot)).not.toContain("SECRET");
  });

  it("refuses a listed field of the wrong type on reading, naming it, rather than dropping it", () => {
    const base = JSON.parse(robotFileContents("Bot", createDemoProject().robot));
    expect(() => parseRobotFile(JSON.stringify({ ...base, driveModel: [] }))).toThrow("Its driveModel has the wrong type.");
    expect(() => parseRobotFile(JSON.stringify({ ...base, w: "wide" }))).not.toThrow();
    expect(() => parseRobotFile(JSON.stringify({ ...base, w: { m: 1 } }))).toThrow("Its w has the wrong type.");
    expect(() => parseRobotFile(JSON.stringify({ ...base, cameras: [{ id: "c", positionM: 3 }] }))).toThrow("Its cameras[0].positionM has the wrong type.");
  });

  it("names the pushed file like a pushed path of that name", () => {
    expect(robotPushFileName("Comp bot")).toBe("Comp-bot.robot");
    expect(robotPushFileName("///")).toBe("Bordeaux.robot");
    for (const name of ["Équipe 2468 · rapide", "CON", "x".repeat(120), ".hidden bot"]) expect(robotPushFileName(name)).toBe(binaryFileName(name).replace(/\.bdx$/, ".robot"));
  });
});

describe("robot details helpers", () => {
  it("replaces one robot's details, selected or listed, keeping its id, share list, name and address", () => {
    const project = twoRobots(), compId = project.robots![0].id, practiceId = project.activeRobotId!;
    const incoming: RobotConfig = { ...decodeRobotFile(robotFileContents("Other", project.robot)).robot, w: 0.71, cameras: undefined };
    const selected = replaceRobotDetails(project, practiceId, incoming);
    expect(selected.robot).toMatchObject({ id: practiceId, w: 0.71, estimatesFrom: project.robot.estimatesFrom });
    expect(selected.robot.cameras).toBeUndefined();
    expect(selected.robots).toEqual(project.robots);
    const listed = replaceRobotDetails(project, compId, incoming);
    expect(listed.robot).toBe(project.robot);
    expect(robotDetailsOf(listed, compId)).toMatchObject({ w: 0.71 });
    expect(robotDetailsOf(listed, compId)).not.toHaveProperty("id");
    expect(listed.robots![0]).toMatchObject({ name: "Comp bot", connection: endpoint });
    expect(replaceRobotDetails(project, "robot_gone", incoming)).toBe(project);
    expect(robotDetailsOf(project, "robot_gone")).toBeNull();
  });
});

describe("project folder robot documents", () => {
  it("writes Robots/<name>.robot per robot, keyed by robot id, and keeps a file across a rename only while it fits", () => {
    const project = twoRobots();
    const documents = projectDocuments(project);
    const robots = documents.filter((document) => document.key.startsWith("robot:"));
    expect(robots.map(({ key, file }) => [key, file])).toEqual([[`robot:${project.robots![0].id}`, "Robots/Comp bot.robot"], [`robot:${project.activeRobotId}`, "Robots/Practice bot.robot"]]);
    expect(robots.every((document) => MANAGED_SOURCE_FILE.test(document.file))).toBe(true);
    expect(JSON.parse(robots[0].contents)).toMatchObject({ format: ROBOT_FILE_FORMAT, name: "Comp bot" });
    const previous = Object.fromEntries(documents.map((document) => [document.key, document.file]));
    const renamed = renameRobot(project, project.robots![0].id, "Match bot");
    expect(projectDocuments(renamed, previous).find((document) => document.key === `robot:${project.robots![0].id}`)!.file).toBe("Robots/Match bot.robot");
    expect(projectDocuments(removeRobot(project, project.robots![0].id), previous).filter((document) => document.key.startsWith("robot:")).map((document) => document.file))
      .toEqual(["Robots/Practice bot.robot"]);
  });

  it("gives a project without a robot list one Robot.robot", () => {
    const documents = projectDocuments(createDemoProject());
    expect(documents.filter((document) => document.key.startsWith("robot:")).map(({ key, file }) => [key, file])).toEqual([["robot:robot", "Robots/Robot.robot"]]);
    expect(MANAGED_SOURCE_FILE.test("Robots/Robot.robot")).toBe(true);
    expect(MANAGED_SOURCE_FILE.test("Robots/nested/Robot.robot")).toBe(false);
    expect(MANAGED_SOURCE_FILE.test("Paths/Robot.robot")).toBe(false);
  });
});

describe("desktop folder writer", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
  async function folder() {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-robot-file-"))); roots.push(root);
    const target = path.join(root, "Autos"); await fs.mkdir(target);
    return target;
  }
  const state = async (target: string) => JSON.parse(await fs.readFile(projectWorkspacePath(target), "utf8"));

  it("writes, renames and removes robot files with ownership hashes", async () => {
    const target = await folder();
    let project = twoRobots();
    await autosaveProjectFolder(target, project, null);
    expect((await fs.readdir(path.join(target, "Robots"))).sort()).toEqual(["Comp bot.robot", "Practice bot.robot"]);
    let saved = await state(target);
    const compId = project.robots![0].id;
    expect(saved.documentFiles[`robot:${compId}`]).toBe("Robots/Comp bot.robot");
    expect(saved.files["Robots/Comp bot.robot"]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(await fs.readFile(path.join(target, "Robots/Practice bot.robot"), "utf8"))).not.toHaveProperty("estimatesFrom");

    project = renameRobot(project, compId, "Match bot");
    await autosaveProjectFolder(target, project, projectWorkspacePath(target));
    expect((await fs.readdir(path.join(target, "Robots"))).sort()).toEqual(["Match bot.robot", "Practice bot.robot"]);
    saved = await state(target);
    expect(saved.documentFiles[`robot:${compId}`]).toBe("Robots/Match bot.robot");
    expect(saved.files).not.toHaveProperty(["Robots/Comp bot.robot"]);

    project = removeRobot(project, compId);
    await autosaveProjectFolder(target, project, projectWorkspacePath(target));
    expect(await fs.readdir(path.join(target, "Robots"))).toEqual(["Practice bot.robot"]);
  });

  it("refuses to overwrite a robot file changed outside Bordeaux and keeps a changed one when its robot is deleted", async () => {
    const target = await folder();
    const project = twoRobots(), file = path.join(target, "Robots/Practice bot.robot");
    await autosaveProjectFolder(target, project, null);
    const edited = (await fs.readFile(file, "utf8")).replace('"name": "Practice bot"', '"name": "Practice bot", "note": "by hand"');
    await fs.writeFile(file, edited);
    const before = await fs.readFile(projectWorkspacePath(target), "utf8");
    await expect(autosaveProjectFolder(target, { ...project, robot: { ...project.robot, w: 0.7 } }, projectWorkspacePath(target)))
      .rejects.toMatchObject({ code: "PROJECT_SOURCE_CHANGED", scope: "document", file: "Robots/Practice bot.robot" });
    expect(await fs.readFile(file, "utf8")).toBe(edited);
    expect(await fs.readFile(projectWorkspacePath(target), "utf8")).toBe(before);

    // A robot whose file changed outside Bordeaux is deleted: the save goes ahead and the file stays.
    const other = await folder();
    await autosaveProjectFolder(other, project, null);
    const comp = path.join(other, "Robots/Comp bot.robot");
    await fs.appendFile(comp, "\n");
    await expect(autosaveProjectFolder(other, removeRobot(project, project.robots![0].id), projectWorkspacePath(other))).rejects.toThrow(/changed outside Bordeaux/);
    expect(await fs.readFile(comp, "utf8")).toMatch(/\n\n$/);
  });

  it("opens a robot file as its project with that robot selected", async () => {
    const target = await folder();
    const project = twoRobots();
    await autosaveProjectFolder(target, project, null);
    const opened = await loadProjectSelection(path.join(target, "Robots/Comp bot.robot"));
    expect(opened.folderPath).toBe(target);
    expect(opened.project.activeRobotId).toBe(project.robots![0].id);
    expect(opened.project.robot.cameras?.[0].name).toBe("Front");
    expect((await loadProjectSelection(path.join(target, "Robots/Practice bot.robot"))).project.activeRobotId).toBe(project.activeRobotId);
    // The selection is a convenience; the saved project is unchanged.
    expect(selectRobot(opened.project, project.activeRobotId!).robots!.map((robot) => robot.name)).toEqual(["Comp bot", "Practice bot"]);
  });

  it("adds a robot's file on the next save", async () => {
    const target = await folder();
    const project = twoRobots();
    await autosaveProjectFolder(target, project, null);
    await autosaveProjectFolder(target, addRobot(project, "Third"), projectWorkspacePath(target));
    expect((await fs.readdir(path.join(target, "Robots"))).sort()).toEqual(["Comp bot.robot", "Practice bot.robot", "Third.robot"]);
  });
});
