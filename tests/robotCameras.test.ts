import { describe, expect, it } from "vitest";
import { pathPlanningKey } from "../src/core/planners/planningKey";
import { blankPath, createDemoProject } from "../src/core/project/defaults";
import { decodeProjectValue, encodeProjectFile } from "../src/core/project/fileFormat";
import { duplicateRobot, projectRobots, selectRobot } from "../src/core/project/robots";
import { CAMERA_LIMIT, CAMERA_NAME_MAX, addCamera, removeCamera, updateCamera } from "../src/core/robotCameras";
import type { BordeauxProject, RobotCamera, RobotConfig } from "../src/core/types";
import { validateProject } from "../src/core/validation";

/*
 * Ways a robot's cameras can fail, written before the code:
 *  1. A robot without cameras stops validating, or gains an empty list in the file.
 *  2. A new camera repeats an id or a name, or sits outside the robot's own frame.
 *  3. A camera past the count limit is added, so the project cannot save.
 *  4. Removing an unknown id changes the robot, or removing the last camera leaves an empty list.
 *  5. An edit lands on another camera, changes the id, or reaches an unknown id.
 *  6. An operation mutates the robot it was given.
 *  7. Validation accepts a field of view of 0, 180 or more, or a non-number.
 *  8. Validation accepts a mount below the floor, far outside the robot, or an angle outside its range.
 *  9. Validation accepts repeated ids or names, an empty or too long name, a non-list, or too many cameras.
 * 10. Validation checks only the selected robot's cameras, so a bad camera hides on another robot.
 * 11. Editing a camera changes the planning key, which discards optimize results that cameras cannot affect.
 * 12. Saving and reopening drops or alters cameras, on the selected robot or another one.
 * 13. A duplicated robot shares camera objects with the original, or switching robots mixes their cameras.
 */
const robot = (): RobotConfig => createDemoProject().robot;
const withCameras = (count: number): RobotConfig => Array.from({ length: count }).reduce<RobotConfig>((current) => addCamera(current), robot());
const projectWith = (cameras: unknown): BordeauxProject => ({ ...createDemoProject(), robot: { ...robot(), cameras: cameras as RobotCamera[] } });
const camera = (): RobotCamera => withCameras(1).cameras![0];
const problems = (cameras: unknown) => validateProject(projectWith(cameras)).issues.map((item) => item.path);

describe("robot cameras", () => {
  it("leaves a robot without cameras valid and without a camera list", () => {
    const project = createDemoProject();
    expect(project.robot.cameras).toBeUndefined();
    expect(validateProject(project).ok).toBe(true);
    expect(JSON.parse(encodeProjectFile(project).contents).robot).not.toHaveProperty("cameras");
  });

  it("adds cameras with their own ids and names, mounted inside the robot's frame", () => {
    const start = robot();
    const three = withCameras(3);
    expect(start.cameras).toBeUndefined();
    expect(three.cameras!.map((item) => item.name)).toEqual(["Camera 1", "Camera 2", "Camera 3"]);
    expect(new Set(three.cameras!.map((item) => item.id)).size).toBe(3);
    expect(Math.abs(three.cameras![0].positionM.x)).toBeLessThanOrEqual(start.l / 2);
    expect(validateProject({ ...createDemoProject(), robot: three }).ok).toBe(true);
    // A name freed by a removal is not handed to a second camera while "Camera 3" still exists.
    const refilled = addCamera(removeCamera(three, three.cameras![1].id));
    expect(new Set(refilled.cameras!.map((item) => item.name)).size).toBe(3);
  });

  it("stops at the camera limit", () => {
    const full = withCameras(CAMERA_LIMIT);
    expect(full.cameras).toHaveLength(CAMERA_LIMIT);
    expect(addCamera(full)).toBe(full);
    expect(validateProject({ ...createDemoProject(), robot: full }).ok).toBe(true);
  });

  it("removes one camera, ignores an unknown id, and drops the list with the last camera", () => {
    const two = withCameras(2);
    expect(removeCamera(two, "missing")).toBe(two);
    const one = removeCamera(two, two.cameras![0].id);
    expect(one.cameras).toEqual([two.cameras![1]]);
    expect(removeCamera(one, one.cameras![0].id)).not.toHaveProperty("cameras");
    expect(two.cameras).toHaveLength(2);
  });

  it("edits only the named camera and never its id", () => {
    const two = withCameras(2);
    const [first, second] = two.cameras!;
    const edited = updateCamera(two, second.id, { horizontalFovDeg: 82, name: "  Rear  ", id: "other" } as Partial<RobotCamera>);
    expect(edited.cameras![0]).toEqual(first);
    expect(edited.cameras![1]).toEqual({ ...second, horizontalFovDeg: 82, name: "Rear" });
    expect(updateCamera(two, "missing", { verticalFovDeg: 10 })).toBe(two);
    expect(two.cameras![1]).toEqual(second);
  });

  it("refuses a name another camera has, an empty name and a name past the limit", () => {
    const two = withCameras(2);
    const second = two.cameras![1];
    expect(updateCamera(two, second.id, { name: "camera 1" })).toBe(two);
    expect(updateCamera(two, second.id, { name: "   " })).toBe(two);
    expect(updateCamera(two, second.id, { name: "x".repeat(CAMERA_NAME_MAX + 1) }).cameras![1].name).toHaveLength(CAMERA_NAME_MAX);
  });

  it.each([0, -10, 180, 200, Number.NaN, "70"])("rejects a field of view of %s", (value) => {
    expect(problems([{ ...camera(), horizontalFovDeg: value }])).toContain("$.robot.cameras[0].horizontalFovDeg");
    expect(problems([{ ...camera(), verticalFovDeg: value }])).toContain("$.robot.cameras[0].verticalFovDeg");
  });

  it("rejects a mount below the floor, far from the robot, or an angle outside its range", () => {
    const item = camera();
    expect(problems([{ ...item, positionM: { ...item.positionM, z: -0.01 } }])).toContain("$.robot.cameras[0].positionM.z");
    expect(problems([{ ...item, positionM: { ...item.positionM, x: 2.5 } }])).toContain("$.robot.cameras[0].positionM.x");
    expect(problems([{ ...item, positionM: { x: 0, y: Number.NaN, z: 0.3 } }])).toContain("$.robot.cameras[0].positionM.y");
    expect(problems([{ ...item, positionM: undefined }])).toContain("$.robot.cameras[0].positionM");
    expect(problems([{ ...item, yawDeg: 181 }])).toContain("$.robot.cameras[0].yawDeg");
    expect(problems([{ ...item, pitchDeg: -91 }])).toContain("$.robot.cameras[0].pitchDeg");
    expect(problems([{ ...item, yawDeg: -180, pitchDeg: 90 }])).toEqual([]);
  });

  it("rejects a malformed camera list", () => {
    const [first, second] = withCameras(2).cameras!;
    expect(problems({})).toContain("$.robot.cameras");
    expect(problems([])).toContain("$.robot.cameras");
    expect(problems(Array.from({ length: CAMERA_LIMIT + 1 }, (_, index) => ({ ...first, id: `c${index}`, name: `c${index}` })))).toContain("$.robot.cameras");
    expect(problems([null])).toContain("$.robot.cameras[0]");
    expect(problems([first, { ...second, id: first.id }])).toContain("$.robot.cameras[1].id");
    expect(problems([first, { ...second, name: first.name.toUpperCase() }])).toContain("$.robot.cameras[1].name");
    expect(problems([{ ...first, name: " " }])).toContain("$.robot.cameras[0].name");
    expect(problems([{ ...first, name: "x".repeat(CAMERA_NAME_MAX + 1) }])).toContain("$.robot.cameras[0].name");
  });

  it("checks the cameras of a robot that is not selected", () => {
    const start = { ...createDemoProject(), robot: withCameras(1) };
    const two = duplicateRobot(start, projectRobots(start)[0].id);
    const other = two.robots!.findIndex((entry) => entry.id !== two.activeRobotId);
    const broken = structuredClone(two);
    broken.robots![other].robot!.cameras![0].verticalFovDeg = 0;
    expect(validateProject(two).ok).toBe(true);
    expect(validateProject(broken).issues.map((item) => item.path)).toEqual([`$.robots[${other}].robot.cameras[0].verticalFovDeg`]);
  });

  it("keeps the planning key when cameras change", () => {
    const path = blankPath("Key");
    const one = withCameras(1);
    const key = pathPlanningKey(path, robot());
    expect(pathPlanningKey(path, one)).toBe(key);
    expect(pathPlanningKey(path, updateCamera(one, one.cameras![0].id, { yawDeg: 90 }))).toBe(key);
    expect(pathPlanningKey(path, { ...one, w: one.w + 0.1 })).not.toBe(key);
  });

  it("keeps each robot's cameras through duplicate, switch, save and reopen", () => {
    const start = { ...createDemoProject(), robot: withCameras(2) };
    const firstId = projectRobots(start)[0].id;
    const copied = duplicateRobot(start, firstId);
    const original = copied.robots!.find((entry) => entry.id !== copied.activeRobotId)!;
    expect(copied.robot.cameras).toEqual(original.robot!.cameras);
    expect(copied.robot.cameras![0]).not.toBe(original.robot!.cameras![0]);

    // The copy loses a camera; the original keeps both.
    const edited = { ...copied, robot: removeCamera(copied.robot, copied.robot.cameras![0].id) };
    const reopened = decodeProjectValue(JSON.parse(encodeProjectFile(edited).contents)).project;
    expect(reopened.robot.cameras).toEqual(edited.robot.cameras);
    expect(reopened.robot.cameras).toHaveLength(1);
    const back = selectRobot(reopened, original.id);
    expect(back.robot.cameras).toEqual(start.robot.cameras);
    expect(selectRobot(back, edited.activeRobotId!).robot.cameras).toEqual(edited.robot.cameras);
  });
});
