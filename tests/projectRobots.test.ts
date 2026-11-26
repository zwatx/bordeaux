import { describe, expect, it } from "vitest";
import { createDemoProject, newRobot } from "../src/core/project/defaults";
import { decodeProjectValue, encodeProjectFile } from "../src/core/project/fileFormat";
import { ROBOT_LIMIT, addRobot, duplicateRobot, projectRobots, pushConnectionProblem, removeRobot, renameRobot, selectRobot, setRobotConnection } from "../src/core/project/robots";
import { validateProject } from "../src/core/validation";
import type { BordeauxProject } from "../src/core/types";
import { applyProjectEntry, captureProjectChange, restoreProjectChange } from "../src/renderer/lib/undoHistory";

/*
 * Ways a project's robot list can fail, written before the code:
 *  1. A project saved before robots had names lists no robot, or throws.
 *  2. A new robot copies the selected robot instead of starting from the defaults, or shares objects with it.
 *  3. A new robot repeats a name or an id.
 *  4. Switching drops edits made to the robot being left, or leaves a stale copy on the selected entry.
 *  5. Switching to an unknown id, or to the selected robot, changes the project.
 *  6. Switching reorders the list.
 *  7. Switching away and back changes the robot's details.
 *  8. Removing leaves no robot, leaves the removed robot's details selected, or acts on an unknown id.
 *  9. Renaming accepts an empty, too long or repeated name, or keeps surrounding spaces.
 * 10. Validation accepts a malformed list.
 * 11. Saving and reopening drops or alters the list.
 * 12. An operation mutates the project it was given.
 * 13. A project with a robot list saves under a version an older Bordeaux opens, and its next save drops the other robots.
 * 14. A project without a list gets a version older builds refuse.
 * 15. Undoing an agent's planning change after a switch rewrites the other robot's planning.
 * 16. An address set on the selected robot lands on another robot, changes its details, or is lost on a switch.
 * 17. A new robot starts at the address of the robot it was made from, so the two look linked.
 * 18. Validation accepts a malformed address, or refuses two robots sharing one.
 * 19. Duplicating a robot that is not selected copies the selected robot instead, or drops its address.
 * 20. Duplicating the only robot of a project without a list does nothing.
 * 21. A numbered name passes the length limit, or a robot past the count limit is added, so the project cannot save.
 * 22. Push prepares the selected robot's files for a connection that belongs to another robot, or to none.
 * 23. A password or host key placed inside a robot's address is written back to the project file.
 * 24. Undo after a switch leaves the planning change on the robot it was made on, or loses its redo.
 */
const comp = { target: "systemcore", host: "10.24.68.2", port: 22, directory: "/home/systemcore/bordeaux/paths" } as const;
const practice = { ...comp, host: "10.24.68.3" };

const names = (project: BordeauxProject) => projectRobots(project).map((robot) => robot.name + (robot.selected ? "*" : ""));
const idOf = (project: BordeauxProject, name: string) => projectRobots(project).find((robot) => robot.name === name)!.id;
/** The demo project with a drivetrain model, so two robots can differ in gearing. Synthetic values, not a real robot. */
function base(): BordeauxProject {
  const project = createDemoProject();
  return { ...project, robot: { ...project.robot, driveModel: { motorId: "custom", motorFreeRpm: 6000, motorMaxTorqueNm: 4, motorCount: 4,
    gearRatio: 6.75, wheelDiameterM: 0.1016, massKg: 50, moiKgM2: 5, wheelbaseM: 0.6, trackwidthM: 0.6, wheelFrictionCoefficient: 1.2 } } };
}
/** Two robots with different gearing: "Robot" (6.75) and "Practice bot" (5.5), Practice bot selected. */
function twoRobots(): BordeauxProject {
  const copied = duplicateRobot(base(), projectRobots(base())[0].id);
  const added = renameRobot(copied, copied.activeRobotId!, "Practice bot");
  return { ...added, robot: { ...added.robot, driveModel: { ...added.robot.driveModel!, gearRatio: 5.5 } } };
}

describe("project robots", () => {
  it("lists one selected robot for a project saved before robots had names", () => {
    const project = createDemoProject();
    expect(project.robots).toBeUndefined();
    expect(names(project)).toEqual(["Robot*"]);
    expect(validateProject(project).ok).toBe(true);
  });

  it("adds a selected robot with the starting details and drivetrain, keeping the other robot's own", () => {
    const before = base(), snapshot = structuredClone(before);
    const project = addRobot(before, "Practice bot");
    expect(before).toEqual(snapshot);
    expect(names(project)).toEqual(["Robot", "Practice bot*"]);
    expect(project.robot).toEqual(newRobot());
    expect(project.robot.driveModel?.gearRatio).toBe(6.75);
    const kept = project.robots!.find((robot) => robot.name === "Robot")!.robot!;
    expect(kept).toEqual(before.robot);
    expect(addRobot(before, "Second").robot).not.toBe(addRobot(before, "Third").robot);
    expect(validateProject(project).ok).toBe(true);
  });

  it("gives every new robot its own id and name", () => {
    let project = createDemoProject();
    for (const name of ["Robot", "robot", "  ", "Practice bot", "Practice bot"]) project = addRobot(project, name);
    const robots = projectRobots(project);
    expect(robots.map((robot) => robot.name)).toEqual(["Robot", "Robot 2", "robot 3", "Robot 4", "Practice bot", "Practice bot 2"]);
    expect(new Set(robots.map((robot) => robot.id)).size).toBe(6);
    expect(validateProject(project).ok).toBe(true);
  });

  it("switches robots, keeping each robot's own details and the list order", () => {
    const project = twoRobots(), snapshot = structuredClone(project);
    const switched = selectRobot(project, idOf(project, "Robot"));
    expect(project).toEqual(snapshot);
    expect(names(switched)).toEqual(["Robot*", "Practice bot"]);
    expect(switched.robot.driveModel!.gearRatio).toBe(6.75);
    expect(switched.robots!.find((robot) => robot.name === "Practice bot")!.robot!.driveModel!.gearRatio).toBe(5.5);
    expect(switched.robots!.find((robot) => robot.name === "Robot")!.robot).toBeUndefined();
    expect(validateProject(switched).ok).toBe(true);
  });

  it("leaves the project alone for an unknown or already selected robot", () => {
    const project = twoRobots();
    expect(selectRobot(project, "missing")).toBe(project);
    expect(selectRobot(project, idOf(project, "Practice bot"))).toBe(project);
    const single = createDemoProject();
    expect(selectRobot(single, projectRobots(single)[0].id)).toBe(single);
  });

  it("restores the same details after switching away and back", () => {
    const project = twoRobots();
    const away = selectRobot(project, idOf(project, "Robot"));
    const back = selectRobot(away, idOf(away, "Practice bot"));
    expect(back).toEqual(project);
    expect(away.robot).not.toEqual(project.robot);
  });

  it("removes a robot but never the last one, and selects another when the selected robot goes", () => {
    const project = twoRobots(), snapshot = structuredClone(project);
    const withoutOther = removeRobot(project, idOf(project, "Robot"));
    expect(project).toEqual(snapshot);
    expect(names(withoutOther)).toEqual(["Practice bot*"]);
    expect(withoutOther.robot.driveModel!.gearRatio).toBe(5.5);
    const withoutSelected = removeRobot(project, idOf(project, "Practice bot"));
    expect(names(withoutSelected)).toEqual(["Robot*"]);
    expect(withoutSelected.robot.driveModel!.gearRatio).toBe(6.75);
    for (const next of [withoutOther, withoutSelected]) {
      expect(validateProject(next).ok).toBe(true);
      expect(removeRobot(next, projectRobots(next)[0].id)).toBe(next);
    }
    expect(removeRobot(project, "missing")).toBe(project);
    const single = createDemoProject();
    expect(removeRobot(single, projectRobots(single)[0].id)).toBe(single);
  });

  it("renames with a trimmed, unique name of at most 80 characters", () => {
    const project = twoRobots(), id = idOf(project, "Practice bot");
    expect(names(renameRobot(project, id, "  Comp bot  "))).toEqual(["Robot", "Comp bot*"]);
    for (const refused of ["", "   ", "robot", "x".repeat(81)]) expect(renameRobot(project, id, refused)).toBe(project);
    expect(renameRobot(project, id, "practice BOT")).not.toBe(project);
    expect(renameRobot(project, "missing", "Comp bot")).toBe(project);
    const single = renameRobot(createDemoProject(), projectRobots(createDemoProject())[0].id, "Comp bot");
    expect(names(single)).toEqual(["Comp bot*"]);
    expect(validateProject(single).ok).toBe(true);
  });

  it("keeps the list through save and reopen", () => {
    const project = twoRobots();
    const reopened = decodeProjectValue(JSON.parse(encodeProjectFile(project).contents)).project;
    expect(reopened.robots).toEqual(project.robots);
    expect(reopened.activeRobotId).toBe(project.activeRobotId);
    expect(reopened.robot).toEqual(project.robot);
  });

  it("saves a robot list as schema 1.3, which builds before it refuse, and leaves single-robot projects as they were", () => {
    expect(JSON.parse(encodeProjectFile(twoRobots()).contents).schemaVersion).toBe("1.3");
    const single = base();
    expect(JSON.parse(encodeProjectFile(single).contents).schemaVersion).toBe(single.schemaVersion);
    expect(() => decodeProjectValue({ ...JSON.parse(encodeProjectFile(twoRobots()).contents), schemaVersion: "1.4" })).toThrow("Unsupported Bordeaux project schema version");
  });

  it("undoes an agent's planning change only on the robot it was made on", () => {
    const before = twoRobots();
    const after = { ...before, robot: { ...before.robot, planning: { notes: "agent notes" } } };
    const { change } = captureProjectChange(before, after, null);
    expect(restoreProjectChange(after, change).robot.planning).toBeUndefined();
    // After a switch, undo restores the planning of the robot the change was made on, wherever its details now are,
    // and leaves the selected robot's own planning alone. The entry it returns redoes the same robot.
    const switched = selectRobot(after, idOf(after, "Robot"));
    const other = { ...switched, robot: { ...switched.robot, planning: { notes: "other robot" } } };
    const undone = applyProjectEntry(other, { kind: "project", ...captureProjectChange(before, after, null) } as never, null)!;
    expect(undone.project.robot.planning).toEqual({ notes: "other robot" });
    expect(undone.project.robots!.find((robot) => robot.name === "Practice bot")!.robot!.planning).toBeUndefined();
    const redone = applyProjectEntry(undone.project, undone.inverse, null)!;
    expect(redone.project.robots!.find((robot) => robot.name === "Practice bot")!.robot!.planning).toEqual({ notes: "agent notes" });
    expect(redone.project.robot.planning).toEqual({ notes: "other robot" });
  });

  it("keeps each robot's address with that robot through switching, and lets robots share one", () => {
    const single = base(), snapshot = structuredClone(single);
    const addressed = setRobotConnection(single, comp);
    expect(single).toEqual(snapshot);
    expect(projectRobots(addressed).map((robot) => [robot.name, robot.connection, robot.selected])).toEqual([["Robot", comp, true]]);
    expect(addressed.robot).toEqual(single.robot);
    expect(validateProject(addressed).ok).toBe(true);
    const copied = addRobot(addressed, "Practice bot");
    expect(projectRobots(copied).map((robot) => robot.connection)).toEqual([comp, undefined]);
    expect(validateProject(copied).ok).toBe(true);
    const moved = setRobotConnection(copied, practice);
    expect(projectRobots(moved).map((robot) => [robot.name, robot.connection])).toEqual([["Robot", comp], ["Practice bot", practice]]);
    const back = selectRobot(moved, idOf(moved, "Robot"));
    expect(projectRobots(back).map((robot) => [robot.name, robot.connection, robot.selected])).toEqual([["Robot", comp, true], ["Practice bot", practice, false]]);
    expect(setRobotConnection(back, { ...comp })).toBe(back);
    const shared = setRobotConnection(selectRobot(back, idOf(back, "Practice bot")), comp);
    expect(projectRobots(shared).map((robot) => robot.connection)).toEqual([comp, comp]);
    const edited = setRobotConnection(shared, { ...comp, directory: "/home/systemcore/practice" });
    expect(projectRobots(edited).map((robot) => robot.connection?.directory)).toEqual([comp.directory, "/home/systemcore/practice"]);
  });

  it("duplicates any robot, details and address included, and selects the copy", () => {
    const project = setRobotConnection(twoRobots(), practice), snapshot = structuredClone(project);
    const robot = idOf(project, "Robot");
    const copied = duplicateRobot(project, robot);
    expect(project).toEqual(snapshot);
    expect(projectRobots(copied).map((item) => [item.name, item.selected])).toEqual([["Robot", false], ["Practice bot", false], ["Robot 2", true]]);
    expect(copied.robot.driveModel!.gearRatio).toBe(6.75);
    expect(projectRobots(copied).map((item) => item.connection)).toEqual([undefined, practice, undefined]);
    const again = duplicateRobot(copied, idOf(copied, "Practice bot"));
    expect(projectRobots(again).at(-1)).toMatchObject({ name: "Practice bot 2", selected: true, connection: practice });
    expect(again.robot.driveModel!.gearRatio).toBe(5.5);
    expect(validateProject(again).ok).toBe(true);
    expect(duplicateRobot(project, "missing")).toBe(project);
  });

  it("duplicates the only robot of a project without a list", () => {
    const single = base();
    const copied = duplicateRobot(single, projectRobots(single)[0].id);
    expect(names(copied)).toEqual(["Robot", "Robot 2*"]);
    expect(copied.robot).toEqual(single.robot);
    expect(validateProject(copied).ok).toBe(true);
  });

  it("keeps numbered names within the length limit and stops at the robot limit", () => {
    const long = "x".repeat(80);
    const named = renameRobot(base(), projectRobots(base())[0].id, long);
    const copied = duplicateRobot(named, named.activeRobotId!);
    expect(projectRobots(copied).map((robot) => robot.name.length)).toEqual([80, 80]);
    expect(projectRobots(copied)[1].name.endsWith(" 2")).toBe(true);
    expect(validateProject(copied).ok).toBe(true);
    let full = base();
    while (projectRobots(full).length < ROBOT_LIMIT) full = addRobot(full, "Robot");
    expect(validateProject(full).ok).toBe(true);
    expect(addRobot(full, "One more")).toBe(full);
    expect(duplicateRobot(full, full.activeRobotId!)).toBe(full);
  });

  it("lets Push use only the selected robot's own connection", () => {
    const unlisted = base();
    expect(pushConnectionProblem(unlisted, comp)).toBeNull();
    expect(pushConnectionProblem(unlisted, null)).toBeNull();
    const listed = setRobotConnection(twoRobots(), practice);
    expect(pushConnectionProblem(listed, practice)).toBeNull();
    expect(pushConnectionProblem(listed, { ...practice })).toBeNull();
    expect(pushConnectionProblem(listed, comp)).toMatch(/Practice bot/);
    expect(pushConnectionProblem(listed, { ...practice, directory: "/home/systemcore/other" })).toMatch(/Practice bot/);
    expect(pushConnectionProblem(listed, null)).toMatch(/Practice bot/);
    const noAddress = selectRobot(listed, idOf(listed, "Robot"));
    expect(pushConnectionProblem(noAddress, practice)).toMatch(/Set up/);
    expect(pushConnectionProblem(noAddress, null)).toMatch(/Set up/);
  });

  it("writes only the four address fields of a robot's connection", () => {
    const project = setRobotConnection(twoRobots(), practice);
    const tainted = { ...project, robots: project.robots!.map((robot) => robot.connection ? { ...robot, connection: { ...robot.connection, password: "secret", hostKeyFingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz" } } : robot) };
    const saved = JSON.parse(encodeProjectFile(tainted).contents);
    expect(saved.robots.find((robot: { name: string }) => robot.name === "Practice bot").connection).toEqual(practice);
    expect(JSON.stringify(saved)).not.toMatch(/secret|hostKeyFingerprint/);
  });

  it.each<[string, (project: BordeauxProject) => unknown, string]>([
    ["a list that is not an array", (p) => ({ ...p, robots: {} }), "$.robots"],
    ["an empty list", (p) => ({ ...p, robots: [] }), "$.robots"],
    ["a selection without a list", (p) => ({ ...p, robots: undefined }), "$.activeRobotId"],
    ["a list without a selection", (p) => ({ ...p, activeRobotId: undefined }), "$.activeRobotId"],
    ["a selection that names no robot", (p) => ({ ...p, activeRobotId: "missing" }), "$.activeRobotId"],
    ["a repeated id", (p) => ({ ...p, robots: p.robots!.map((robot) => ({ ...robot, id: p.activeRobotId! })) }), "$.robots[1].id"],
    ["a repeated name", (p) => ({ ...p, robots: p.robots!.map((robot) => ({ ...robot, name: "ROBOT" })) }), "$.robots[1].name"],
    ["an empty name", (p) => ({ ...p, robots: p.robots!.map((robot, i) => i ? { ...robot, name: " " } : robot) }), "$.robots[1].name"],
    ["details stored on the selected robot", (p) => ({ ...p, robots: p.robots!.map((robot) => ({ ...robot, robot: p.robot })) }), "$.robots[1].robot"],
    ["a robot with no details", (p) => ({ ...p, robots: p.robots!.map(({ robot: _robot, ...rest }) => rest) }), "$.robots[0].robot"],
    ["a robot with invalid details", (p) => ({ ...p, robots: p.robots!.map((robot) => robot.robot ? { ...robot, robot: { ...robot.robot, w: 0 } } : robot) }), "$.robots[0].robot.w"],
    ["an unknown robot type", (p) => ({ ...p, robots: p.robots!.map((robot) => ({ ...robot, connection: { ...comp, target: "talon" } })) }), "$.robots[0].connection"],
    ["a host with spaces", (p) => ({ ...p, robots: p.robots!.map((robot) => ({ ...robot, connection: { ...comp, host: "comp bot" } })) }), "$.robots[0].connection"],
    ["a port of 0", (p) => ({ ...p, robots: p.robots!.map((robot) => ({ ...robot, connection: { ...comp, port: 0 } })) }), "$.robots[0].connection"],
    ["a relative push folder", (p) => ({ ...p, robots: p.robots!.map((robot) => ({ ...robot, connection: { ...comp, directory: "paths" } })) }), "$.robots[0].connection"],
  ])("rejects %s", (_label, damage, path) => {
    const result = validateProject(damage(twoRobots()) as BordeauxProject);
    expect(result.ok).toBe(false);
    expect(result.issues.map((item) => item.path)).toContain(path);
  });
});
