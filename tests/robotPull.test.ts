// Pull from robot: the field-by-field review and Apply as one undoable change.
import { afterEach, describe, expect, it } from "vitest";
import { createDemoProject } from "../src/core/project/defaults";
import { prepareProjectFile } from "../src/core/project/fileFormat";
import { parseRobotFile, robotDetailsProblem, robotFileContents, robotFileDetails } from "../src/core/project/robotFile";
import { validateRobotDetails } from "../src/core/validation";
import { duplicateRobot, removeRobot, renameRobot, replaceRobotDetails, robotDetailsOf, selectRobot, setRobotConnection } from "../src/core/project/robots";
import { DROP_UNDO, PROJECT_SCOPE, applyProjectEntry, captureRobotChange, createUndoHistory, robotChangeRefusal, type ProjectEntry } from "../src/renderer/lib/undoHistory";
import { validateProject } from "../src/core/validation";
import { robotFileChanges } from "../src/renderer/lib/robotFileReview";
import { UnitPrefs } from "../src/renderer/lib/unitPreferences";
import type { BordeauxProject, RobotConfig } from "../src/core/types";

/** A file's structure and then its details, as Pull checks them (the editor validates details through its host). */
function decodeRobotFile(text: string) {
  const file = parseRobotFile(text), problem = robotDetailsProblem(validateRobotDetails(file.robot));
  if (problem) throw new Error(problem);
  return file;
}


afterEach(() => { UnitPrefs.set("metric"); });

function twoRobots(): BordeauxProject {
  let project = prepareProjectFile(createDemoProject());
  project = setRobotConnection(project, { target: "roborio", host: "10.24.68.2", port: 22, directory: "/home/lvuser/bordeaux" });
  project = renameRobot(project, project.activeRobotId!, "Comp bot");
  project = duplicateRobot(project, project.activeRobotId!);
  return renameRobot(project, project.activeRobotId!, "Practice bot");
}
const pulled = (robot: RobotConfig, patch: Partial<RobotConfig>) => decodeRobotFile(robotFileContents("Comp bot", { ...robot, ...patch })).robot;

describe("robot file review", () => {
  it("lists nothing for the same details, ignoring the robot's id and shared estimates", () => {
    const project = twoRobots();
    expect(robotFileChanges(project.robot as never, robotFileDetails(project.robot) as never)).toEqual([]);
  });

  it("groups each difference by Robot page section in display units", () => {
    const robot = createDemoProject().robot;
    const incoming = { ...robot, w: 0.7, heightM: 0.55, drive: robot.drive === "swerve" ? "tank" : "swerve", driveModel: { ...robot.driveModel!, batteryResistanceOhm: 0.018, controlReserve: 0.15 },
      cameras: [{ id: "c", name: "Front", horizontalFovDeg: 70, verticalFovDeg: 50, positionM: { x: 0.3, y: 0, z: 0.4 }, yawDeg: 0, pitchDeg: 10 }],
      planning: { notes: "Score low first" } } as RobotConfig;
    const changes = robotFileChanges(robot as never, incoming as never);
    expect(changes.map((group) => group.section)).toEqual(["Dimensions", "Cameras", "Drivetrain", "Electrical", "Agent profile"]);
    const row = (section: string, label: string) => changes.find((group) => group.section === section)!.rows.find((item) => item.label === label);
    expect(row("Dimensions", "Width")).toEqual({ label: "Width", before: robot.w.toFixed(2) + " m", after: "0.70 m" });
    expect(row("Dimensions", "Height")).toMatchObject({ before: robot.heightM === undefined ? "Not set" : robot.heightM.toFixed(2) + " m", after: "0.55 m" });
    expect(robotFileChanges({ ...robot, heightM: undefined } as never, incoming as never)[0].rows.find((item) => item.label === "Height")).toMatchObject({ before: "Not set" });
    expect(row("Cameras", "Front")).toEqual({ label: "Front", before: "Not present", after: "Added" });
    expect(row("Electrical", "Battery resistance")?.after).toBe("18.0 mΩ");
    expect(row("Electrical", "Control reserve")?.after).toBe("15%");
    expect(row("Agent profile", "Planning notes")).toMatchObject({ before: "Not set", after: "Score low first" });
    UnitPrefs.set("imperial");
    expect(robotFileChanges(robot as never, incoming as never)[0].rows.find((item) => item.label === "Width")?.after).toBe("27.56 in");
  });

  it("shows more digits when the field's precision would hide a change, and reports unknown keys under Other", () => {
    const robot = createDemoProject().robot;
    const changes = robotFileChanges(robot as never, { ...robot, w: robot.w + 0.0004, future: { level: 2 } } as never);
    const width = changes[0].rows[0];
    expect(width.before).not.toBe(width.after);
    expect(changes.at(-1)).toEqual({ section: "Other", rows: [{ label: "future.level", before: "Not set", after: "2" }] });
  });

  it("pairs cameras by id, shows a rename exactly, and lists only changed fields", () => {
    const camera = { id: "a", name: "Front", horizontalFovDeg: 70, verticalFovDeg: 50, positionM: { x: 0.3, y: 0, z: 0.4 }, yawDeg: 0, pitchDeg: 10 };
    const robot = { ...createDemoProject().robot, cameras: [camera, { ...camera, id: "b", name: "Back", pitchDeg: 5 }] };
    const changes = robotFileChanges(robot as never, { ...robot, cameras: [{ ...camera, name: "FRONT", pitchDeg: 12 }, { ...camera, id: "b", name: "Back", pitchDeg: 5 }] } as never);
    expect(changes).toEqual([{ section: "Cameras", rows: [
      { label: "Front name", before: "Front", after: "FRONT" }, { label: "Front pitch", before: "10.0 °", after: "12.0 °" }] }]);
    // A case-only rename alone is still a change.
    expect(robotFileChanges(robot as never, { ...robot, cameras: [{ ...camera, name: "FRONT" }, robot.cameras[1]] } as never)).toHaveLength(1);
  });

  it("shows a reorder of the same cameras, since Apply keeps the file's order", () => {
    const camera = { id: "a", name: "Front", horizontalFovDeg: 70, verticalFovDeg: 50, positionM: { x: 0.3, y: 0, z: 0.4 }, yawDeg: 0, pitchDeg: 10 };
    const rear = { ...camera, id: "b", name: "Rear", yawDeg: 180 };
    const robot = { ...createDemoProject().robot, cameras: [camera, rear] };
    expect(robotFileChanges(robot as never, { ...robot, cameras: [rear, camera] } as never)).toEqual([{ section: "Cameras", rows: [
      { label: "Order", before: "Front, Rear", after: "Rear, Front" }] }]);
    // An added camera at the end is not a reorder.
    const added = robotFileChanges(robot as never, { ...robot, cameras: [camera, rear, { ...camera, id: "c", name: "Side" }] } as never);
    expect(added[0].rows.some((row) => row.label === "Order")).toBe(false);
  });

  it("lists an added or removed camera's mount, angles, views and range", () => {
    const camera = { id: "a", name: "Front", horizontalFovDeg: 70, verticalFovDeg: 50, positionM: { x: 0.3, y: 0, z: 0.4 }, yawDeg: 0, pitchDeg: 10, maxRangeM: 4 };
    const robot = { ...createDemoProject().robot, cameras: [camera] };
    // Same name, another id: a different camera, so one is removed and the other added.
    const changes = robotFileChanges(robot as never, { ...robot, cameras: [{ ...camera, id: "z", name: "Front", yawDeg: 180 }] } as never);
    const rows = changes[0].rows;
    expect(rows[0]).toEqual({ label: "Front", before: "Not present", after: "Added" });
    expect(rows.slice(1, 9)).toEqual([
      { label: "Front forward", before: "Not set", after: "0.300 m" }, { label: "Front left", before: "Not set", after: "0.000 m" },
      { label: "Front height", before: "Not set", after: "0.400 m" }, { label: "Front yaw", before: "Not set", after: "180.0 °" },
      { label: "Front pitch", before: "Not set", after: "10.0 °" }, { label: "Front horizontal view", before: "Not set", after: "70.0 °" },
      { label: "Front vertical view", before: "Not set", after: "50.0 °" }, { label: "Front range", before: "Not set", after: "4.00 m" }]);
    expect(rows[9]).toEqual({ label: "Front", before: "Present", after: "Removed" });
    expect(rows.slice(10).map((row) => [row.label, row.after])).toEqual(["forward", "left", "height", "yaw", "pitch", "horizontal view", "vertical view", "range"].map((field) => ["Front " + field, "Not set"]));
    expect(rows[13]).toEqual({ label: "Front yaw", before: "0.0 °", after: "Not set" });
  });

  it("shows long text whole, so values that differ late never look the same", () => {
    const robot = createDemoProject().robot, start = "Score the preload first, then ".repeat(4);
    const changes = robotFileChanges({ ...robot, planning: { notes: start + "park." } } as never, { ...robot, planning: { notes: start + "defend." } } as never);
    expect(changes[0].rows[0]).toEqual({ label: "Planning notes", before: start + "park.", after: start + "defend." });
  });
});

describe("every value Apply replaces is in the review", () => {
  const row = (changes: ReturnType<typeof robotFileChanges>, label: string) => changes.flatMap((group) => group.rows).find((item) => item.label === label);
  const base = () => { const robot = createDemoProject().robot; return { ...robot, driveModel: { ...robot.driveModel!,
    commandLoads: [{ commandId: "intake", currentA: 20 }, { commandId: "shoot", currentA: 80, runTimeS: 0.5 }],
    loadBursts: [{ startTimeS: 0, endTimeS: 1, currentA: 30 }], driveBreaker: { ratedCurrentA: 40, tripTimeAt2xS: 5, initialHeat: 0 } } } as RobotConfig; };

  it("lists each changed command load, timed load and breaker field in display units", () => {
    const robot = base(), model = robot.driveModel!;
    const incoming = { ...robot, driveModel: { ...model, commandLoads: [{ commandId: "intake", currentA: 160 }, { commandId: "shoot", currentA: 80, runTimeS: 0.75 }, { commandId: "climb", currentA: 60, runTimeS: 2 }],
      loadBursts: [{ startTimeS: 0, endTimeS: 1.5, currentA: 30 }, { startTimeS: 2, endTimeS: 3, currentA: 10 }], driveBreaker: { ratedCurrentA: 40, tripTimeAt2xS: 5, initialHeat: 0.5 },
      mainBreaker: { ratedCurrentA: 120, tripTimeAt2xS: 20, initialHeat: 0 } } } as RobotConfig;
    const changes = robotFileChanges(robot as never, incoming as never);
    expect(changes.flatMap((group) => group.rows).every((item) => !/different outline/.test(item.after))).toBe(true);
    expect(row(changes, "Command intake current")).toEqual({ label: "Command intake current", before: "20 A", after: "160 A" });
    expect(row(changes, "Command shoot run time")).toMatchObject({ before: "0.50 s", after: "0.75 s" });
    expect(row(changes, "Command climb")).toEqual({ label: "Command climb", before: "Not set", after: "60 A · 2.00 s" });
    expect(row(changes, "Timed load 1 end")).toMatchObject({ before: "1.00 s", after: "1.50 s" });
    expect(row(changes, "Timed load 2")).toEqual({ label: "Timed load 2", before: "Not set", after: "2.00–3.00 s · 10 A" });
    expect(row(changes, "Drive breaker initial heat")).toMatchObject({ before: "0%", after: "50%" });
    expect(row(changes, "Main breaker rating")).toMatchObject({ before: "Not set", after: "120 A" });
    expect(row(changes, "Drive breaker rating")).toBeUndefined();
  });

  it("lists each changed bumper vertex instead of a changed outline", () => {
    const robot = { ...createDemoProject().robot, footprintPreset: { kind: "custom" as const },
      footprint: { kind: "polygon" as const, verticesM: [{ x: 0.3, y: 0.3 }, { x: -0.3, y: 0.3 }, { x: -0.3, y: -0.3 }, { x: 0.3, y: -0.3 }] } };
    const incoming = { ...robot, footprint: { kind: "polygon" as const, verticesM: [{ x: 0.3, y: 0.25 }, ...robot.footprint.verticesM.slice(1)] } };
    const changes = robotFileChanges(robot as never, incoming as never);
    expect(changes).toEqual([{ section: "Dimensions", rows: [{ label: "Bumper vertex 1", before: "0.300 m, 0.300 m", after: "0.300 m, 0.250 m" }] }]);
  });

  it("shows a round bumper's changed Curve detail even when its outline is the same", () => {
    const verticesM = Array.from({ length: 12 }, (_, i) => ({ x: 0.3 * Math.cos(i * Math.PI / 6), y: 0.3 * Math.sin(i * Math.PI / 6) }));
    const robot = { ...createDemoProject().robot, footprintPreset: { kind: "round" as const, vertices: 12 }, footprint: { kind: "polygon" as const, verticesM } };
    expect(robotFileChanges(robot as never, { ...robot, footprintPreset: { kind: "round", vertices: 16 } } as never)).toEqual([{ section: "Dimensions", rows: [
      { label: "Curve detail", before: "12 vertices", after: "16 vertices" }] }]);
  });
});

describe("Apply as one undoable change", () => {
  type Journal = ProjectEntry & { kind: "robot" };
  /** Apply as App does it: replace the details and record the change. */
  function apply(project: BordeauxProject, robotId: string, details: RobotConfig) {
    const next = replaceRobotDetails(project, robotId, details);
    const entry: Journal = { scope: PROJECT_SCOPE, touches: [], kind: "robot", change: captureRobotChange(robotId, robotDetailsOf(project, robotId)!, robotDetailsOf(next, robotId)!) };
    return { next, entry };
  }
  const step = (project: BordeauxProject, entry: ProjectEntry) => applyProjectEntry(project, entry, null)!;
  /** Undo as App does it: refused, the entry says why (and a refusal that can never clear drops it). */
  const refusal = (project: BordeauxProject, entry: ProjectEntry) => {
    expect(applyProjectEntry(project, entry, null)).toBeNull();
    return entry.kind === "robot" ? robotChangeRefusal(project, entry.change) : null;
  };

  it("undoes and redoes Apply exactly on the selected robot, keeping its id and shared estimates", () => {
    const project = twoRobots(), id = project.activeRobotId!;
    const { next, entry } = apply(project, id, pulled(project.robot, { w: 0.71, heightM: 0.5, cameras: undefined }));
    expect(next.robot).toMatchObject({ id, w: 0.71, heightM: 0.5, estimatesFrom: project.robot.estimatesFrom });
    const undone = step(next, entry);
    expect(undone.project.robot).toEqual(project.robot);
    const redone = step(undone.project, undone.inverse);
    expect(redone.project.robot).toEqual(next.robot);
  });

  it("refuses Undo once the robot changed after Pull, leaving it as it is, and drops the entry so older undos still work", () => {
    const project = twoRobots(), id = project.activeRobotId!;
    const { next, entry } = apply(project, id, pulled(project.robot, { w: 0.71, l: 0.72 }));
    const edited = { ...next, robot: { ...next.robot, driveModel: { ...next.robot.driveModel!, massKg: 60 } } };
    expect(refusal(edited, entry)).toEqual({ refused: "“Practice bot” changed after Pull, so Undo left its details as they are.", keep: false });
    // In the journal: the refused entry goes, and the change recorded before it is next.
    const older: ProjectEntry = { scope: PROJECT_SCOPE, touches: [], kind: "library", arrangement: { pathIds: [], folderIds: [] } as never };
    const history = createUndoHistory<ProjectEntry>();
    history.record(older); history.record(entry);
    const refusals: string[] = [];
    const run = (item: ProjectEntry) => {
      const done = applyProjectEntry(edited, item, null);
      if (done) return done.inverse;
      const why = item.kind === "robot" ? robotChangeRefusal(edited, item.change) : null;
      if (why) refusals.push(why.refused);
      return why && !why.keep ? DROP_UNDO : null;
    };
    expect(history.undo([PROJECT_SCOPE], run)).toBe(true);
    expect(refusals).toHaveLength(1);
    expect(history.peekUndo([PROJECT_SCOPE])).toBe(older);
    expect(history.canRedo([PROJECT_SCOPE])).toBe(false);
  });

  it("never pairs a restored field with a newer one: an intake added after a speed pull refuses Undo", () => {
    let project = twoRobots();
    const id = project.activeRobotId!;
    project = { ...project, robot: { ...project.robot, maxSpeed: 2, planning: undefined } };
    const { next, entry } = apply(project, id, pulled(project.robot, { maxSpeed: 4 }));
    const intake = { name: "Intake", centerM: { x: 0.4, y: 0 }, directionDeg: 0, captureWidthM: 0.4, maxCollectSpeedMps: 3 };
    const edited = { ...next, robot: { ...next.robot, planning: { intake } } };
    expect(validateProject(edited).ok).toBe(true);
    expect(refusal(edited, entry)).toMatchObject({ keep: false });
    // Undone with nothing edited since, the whole earlier snapshot returns, which was valid.
    const undone = step(next, entry);
    expect(undone.project.robot).toEqual(project.robot);
    expect(validateProject(undone.project).ok).toBe(true);
  });

  it("refuses Redo once the robot changed after Undo", () => {
    const project = twoRobots(), id = project.activeRobotId!;
    const { next, entry } = apply(project, id, pulled(project.robot, { w: 0.71 }));
    const undone = step(next, entry);
    const edited = { ...undone.project, robot: { ...undone.project.robot, l: 0.9 } };
    expect(refusal(edited, undone.inverse)).toEqual({ refused: "“Practice bot” changed after Undo, so Redo left its details as they are.", keep: false });
    expect(step(undone.project, undone.inverse).project.robot).toEqual(next.robot);
  });

  it("refuses to undo a drive type a path now depends on, says why, and keeps the entry", () => {
    let project = twoRobots();
    const id = project.activeRobotId!;
    project = { ...project, robot: { ...project.robot, drive: "tank" } };
    const { next, entry } = apply(project, id, pulled(project.robot, { drive: "swerve" }));
    const path = next.paths[0], last = path.waypoints.length - 1;
    const jiggled = { ...next, paths: [{ ...path, goalVel: 0, waypoints: path.waypoints.map((waypoint, index) => index === last
      ? { ...waypoint, stop: true, jiggle: { distanceM: 0.1, strokes: 4, startDeg: 0, stepDeg: 90, strokeTimeS: 0.4 } } : waypoint) }, ...next.paths.slice(1)] };
    expect(validateProject(jiggled).ok).toBe(true);
    // The jiggle is the user's newer work and removing it makes Undo possible, so the entry stays.
    expect(refusal(jiggled, entry)).toEqual({ refused: expect.stringMatching(new RegExp(`${path.name}.*jiggle`)), keep: true });
    expect(robotChangeRefusal(next, entry.change)).toBeNull();
    expect(step(next, entry).project.robot.drive).toBe("tank");
  });

  it("restores a robot that is no longer selected where it is, and leaves other robots alone", () => {
    const project = twoRobots(), id = project.activeRobotId!, other = project.robots![0].id;
    const { next, entry } = apply(project, id, pulled(project.robot, { w: 0.66 }));
    const switched = selectRobot(next, other);
    const undone = step(switched, entry).project;
    expect(undone.activeRobotId).toBe(other);
    expect(undone.robot).toEqual(switched.robot);
    expect(robotDetailsOf(undone, id)).toEqual(robotDetailsOf(selectRobot(project, other), id));
  });

  it("passes over a robot deleted since: nothing to restore and the rest of the journal stays usable", () => {
    const project = twoRobots(), id = project.activeRobotId!;
    const { next, entry } = apply(project, id, pulled(project.robot, { w: 0.66 }));
    const removed = removeRobot(next, id);
    const history = createUndoHistory<ProjectEntry>();
    history.record(entry);
    let current = removed;
    expect(history.undo([PROJECT_SCOPE], (item) => { const done = step(current, item); current = done.project; return done.inverse; })).toBe(true);
    expect(current).toBe(removed);
    expect(history.canUndo([PROJECT_SCOPE])).toBe(false);
  });
});
