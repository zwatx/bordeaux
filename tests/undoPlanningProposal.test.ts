import { describe, expect, it } from "vitest";
import { robotPlanningProfileSchema } from "../src/core/agent/schemas";
import { PROJECT_SCOPE, applyProjectEntry, captureProjectChange, createUndoHistory, type ProjectEntry } from "../src/renderer/lib/undoHistory";
import type { RobotPlanningProfile } from "../src/core/types";

type Project = { name: string; paths: { id: string; name: string }[]; pathLinks: never[]; pathFolders: never[]; robot: { maxSpeed: number; planning?: RobotPlanningProfile } };

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};

/** The App flow: Apply records one project entry; Settings edits replace robot.planning without journaling; Undo/Redo apply entries. */
function session(planning: RobotPlanningProfile | undefined) {
  let project: Project = deepFreeze({ name: "Fixture", paths: [{ id: "p1", name: "Path 1" }], pathLinks: [], pathFolders: [], robot: { maxSpeed: 4, ...(planning ? { planning } : {}) } });
  const history = createUndoHistory<ProjectEntry>();
  const step = (direction: "undo" | "redo") => history[direction]([PROJECT_SCOPE], (entry) => {
    const applied = applyProjectEntry(project, entry, "p1");
    if (!applied) return null;
    project = deepFreeze(applied.project);
    return applied.inverse;
  });
  return {
    get planning() { return project.robot.planning; },
    get project() { return project; },
    /** agentSession merges the validated request over the current profile; App applies a copy. */
    applyProposal(request: unknown) {
      const proposed = { ...(project.robot.planning ?? {}), ...structuredClone(robotPlanningProfileSchema.parse(request)) };
      const next = deepFreeze({ ...project, robot: { ...project.robot, planning: structuredClone(proposed) } });
      history.record({ scope: PROJECT_SCOPE, kind: "project", ...captureProjectChange(project, next, "p1") });
      project = next;
    },
    /** RobotPage setPlanning: a shallow patch of robot.planning. */
    settings(patch: Partial<RobotPlanningProfile>) {
      project = deepFreeze({ ...project, robot: { ...project.robot, planning: { ...(project.robot.planning ?? {}), ...patch } } });
    },
    undo: () => step("undo"),
    redo: () => step("redo"),
  };
}

const facing = { directionDeg: 0, requiresTargetFacing: true };
const intake = { name: "Front intake", centerM: { x: 0.4, y: 0 }, directionDeg: 0, captureWidthM: 0.6, maxCollectSpeedMps: 2 };
const roundTrip = (project: Project) => JSON.parse(JSON.stringify(project));

describe("undoing an applied robot profile proposal", () => {
  it("reverts the proposed shooter change and keeps newer Settings notes", () => {
    const app = session({ notes: "existing notes", shooter: facing });
    app.applyProposal({ shooter: { directionDeg: 90, requiresTargetFacing: true } });
    app.settings({ notes: "new operator notes" });
    expect(app.undo()).toBe(true);
    expect(app.planning).toEqual({ notes: "new operator notes", shooter: facing });
    expect(roundTrip(app.project).robot.planning).toEqual({ notes: "new operator notes", shooter: facing });
    expect(app.redo()).toBe(true);
    expect(app.planning).toEqual({ notes: "new operator notes", shooter: { directionDeg: 90, requiresTargetFacing: true } });
    expect(app.undo()).toBe(true);
    expect(app.planning).toEqual({ notes: "new operator notes", shooter: facing });
  });

  it("keeps a newer Settings value in the same field and reverts the proposal's other fields", () => {
    const app = session({ notes: "existing notes", shooter: facing });
    app.applyProposal({ shooter: { directionDeg: 90, requiresTargetFacing: false }, notes: "agent notes" });
    app.settings({ shooter: { directionDeg: 45, requiresTargetFacing: false } });
    app.undo();
    expect(app.planning).toEqual({ notes: "existing notes", shooter: { directionDeg: 45, requiresTargetFacing: true } });
    // Redo reapplies only what that Undo reverted, so the newer direction stays.
    app.redo();
    expect(app.planning).toEqual({ notes: "agent notes", shooter: { directionDeg: 45, requiresTargetFacing: false } });
  });

  it("keeps newer intake details while reverting a proposal that only changed notes", () => {
    const app = session({ notes: "existing notes", intake });
    app.applyProposal({ notes: "agent notes" });
    app.settings({ intake: { ...intake, name: "Ground intake", maxCollectSpeedMps: 1.5 } });
    app.undo();
    expect(app.planning).toEqual({ notes: "existing notes", intake: { ...intake, name: "Ground intake", maxCollectSpeedMps: 1.5 } });
  });

  it("removes a component the proposal added unless it was edited since", () => {
    const untouched = session({ notes: "existing notes" });
    untouched.applyProposal({ intake, shooter: facing });
    untouched.settings({ notes: "new operator notes" });
    untouched.undo();
    expect(untouched.planning).toEqual({ notes: "new operator notes" });
    untouched.redo();
    expect(untouched.planning).toEqual({ notes: "new operator notes", intake, shooter: facing });

    const edited = session({ notes: "existing notes" });
    edited.applyProposal({ intake, shooter: facing });
    edited.settings({ intake: { ...intake, centerM: { x: 0.5, y: 0.1 } } });
    edited.undo();
    // The edited intake stays whole; the unedited shooter is removed.
    expect(edited.planning).toEqual({ notes: "existing notes", intake: { ...intake, centerM: { x: 0.5, y: 0.1 } } });
  });

  it("restores a component removed after the proposal only when Settings did not re-add it", () => {
    const app = session({ shooter: { ...facing, preferredRangeM: 3 } });
    app.applyProposal({ shooter: facing });
    expect(app.planning).toEqual({ shooter: facing });
    app.settings({ notes: "range removed on purpose" });
    app.undo();
    expect(app.planning).toEqual({ shooter: { ...facing, preferredRangeM: 3 }, notes: "range removed on purpose" });

    const removed = session({ shooter: facing, notes: "existing notes" });
    removed.settings({ shooter: undefined });
    removed.applyProposal({ notes: "agent notes" });
    removed.settings({ shooter: { directionDeg: 180, requiresTargetFacing: false } });
    removed.undo();
    expect(removed.planning).toEqual({ notes: "existing notes", shooter: { directionDeg: 180, requiresTargetFacing: false } });
  });

  it("restores an absent profile when nothing was edited since, and keeps later Settings data otherwise", () => {
    const fresh = session(undefined);
    fresh.applyProposal({ shooter: facing });
    fresh.undo();
    expect(fresh.planning).toBeUndefined();
    fresh.redo();
    expect(fresh.planning).toEqual({ shooter: facing });

    const later = session(undefined);
    later.applyProposal({ shooter: facing });
    later.settings({ notes: "new operator notes" });
    later.undo();
    expect(later.planning).toEqual({ notes: "new operator notes" });
  });

  it("leaves the robot object unchanged when every proposed field was edited since", () => {
    const app = session({ notes: "existing notes" });
    app.applyProposal({ notes: "agent notes" });
    app.settings({ notes: "operator notes" });
    const robot = app.project.robot;
    expect(app.undo()).toBe(true);
    expect(app.project.robot).toBe(robot);
    // Nothing reverted, so Redo has nothing to reapply over the newer note.
    app.redo();
    expect(app.planning).toEqual({ notes: "operator notes" });
  });

  it("does not modify the captured or current projects", () => {
    const before = deepFreeze({ name: "Fixture", paths: [], pathLinks: [], pathFolders: [], robot: { planning: { notes: "a", shooter: facing } } });
    const after = deepFreeze({ ...before, robot: { planning: { notes: "a", shooter: { directionDeg: 90, requiresTargetFacing: true } } } });
    const { change, touches } = captureProjectChange(before, after, null);
    expect(touches).toEqual(["robot.planning"]);
    const current = deepFreeze({ ...after, robot: { planning: { ...after.robot.planning, notes: "b" } } });
    const snapshot = structuredClone({ before, after, current, change });
    const applied = applyProjectEntry(current, { scope: PROJECT_SCOPE, touches, kind: "project", change }, null)!;
    expect(applied.project.robot.planning).toEqual({ notes: "b", shooter: facing });
    expect({ before, after, current, change }).toEqual(snapshot);
  });
});
