import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenedProject, ProjectLocation } from "../src/shared/project/desktopProjects";
import { completeProjectActivation } from "../src/electron/projectActivation";
import { createNamedProjectSelection } from "../src/electron/projectCreation";
import { loadProjectSelection, type ProjectSelection } from "../src/electron/projectOpening";
import { recentProjectId, recentProjectPathById } from "../src/electron/recentProjectFiles";
import { autosaveProjectFolder, readProject } from "../src/electron/projectFiles";

const directories: string[] = [];
async function parent() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-activation-")); directories.push(directory); return directory;
}
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function activationHarness() {
  let generation = 0;
  let location: ProjectLocation = { folderPath: null, projectPath: null };
  let rendered: OpenedProject | null = null;
  const activate = (selection: ProjectSelection, remembered: Promise<unknown>) => {
    generation++;
    location = { folderPath: selection.folderPath, projectPath: selection.projectPath };
    return completeProjectActivation(selection.project, {
      generation, location, remembered, currentGeneration: () => generation,
    }).then(opened => { rendered = opened; return opened; });
  };
  return { activate, get location() { return location; }, get rendered() { return rendered; }, reset: () => { generation++; location = { folderPath: null, projectPath: null }; } };
}

describe("activation completion ownership", () => {
  it.each(["created", "recent"])("rejects a delayed %s result after another project opens, without mixing project and save target", async source => {
    const directory = await parent();
    const createdA = await createNamedProjectSelection({ name: "A", parentDirectory: directory });
    const b = await createNamedProjectSelection({ name: "B", parentDirectory: directory });
    const a = source === "recent"
      ? await loadProjectSelection(recentProjectPathById([b.folderPath, createdA.folderPath], recentProjectId(createdA.folderPath)))
      : createdA;
    const state = activationHarness(), rememberedA = deferred();
    const pendingA = state.activate(a, rememberedA.promise);
    const rejectedA = expect(pendingA).rejects.toMatchObject({ code: "PROJECT_OPERATION_SUPERSEDED", message: expect.stringContaining("superseded") });
    const openedB = await state.activate(b, Promise.resolve());
    rememberedA.resolve(); await rejectedA;
    expect(state.rendered).toBe(openedB);
    expect(state.location).toEqual({ folderPath: b.folderPath, projectPath: b.projectPath });
    expect(openedB.project.name).toBe("B");
    // A refused completion cannot send A's model to B's now-current autosave target.
    openedB.project.paths[0].name = "Editing B";
    await autosaveProjectFolder(state.location.folderPath!, state.rendered!.project, state.location.projectPath);
    expect((await readProject(b.projectPath!)).project.paths[0].name).toBe("Editing B");
    expect((await readProject(a.projectPath!)).project.paths[0].name).toBe("NewPath");
  });

  it("also refuses an activation superseded by the compatibility New/reset operation", async () => {
    const selection = await createNamedProjectSelection({ name: "A", parentDirectory: await parent() });
    const state = activationHarness(), remembered = deferred();
    const pending = state.activate(selection, remembered.promise);
    const refused = expect(pending).rejects.toMatchObject({ code: "PROJECT_OPERATION_SUPERSEDED" });
    state.reset(); remembered.resolve(); await refused;
    expect(state.location).toEqual({ folderPath: null, projectPath: null }); expect(state.rendered).toBeNull();
  });

  it("returns the captured location when ownership remains, rather than reading a later mutable location", async () => {
    const selection = await createNamedProjectSelection({ name: "A", parentDirectory: await parent() });
    const remembered = deferred(), location = { folderPath: selection.folderPath, projectPath: selection.projectPath };
    const pending = completeProjectActivation(selection.project, { generation: 1, location, remembered: remembered.promise, currentGeneration: () => 1 });
    location.folderPath = "later global location"; location.projectPath = "later global target";
    remembered.resolve();
    expect(await pending).toEqual({ project: selection.project, location: { folderPath: selection.folderPath, projectPath: selection.projectPath } });
  });

  it("preserves successful activation when a recents error is handled by the existing caller", async () => {
    const selection = await createNamedProjectSelection({ name: "A", parentDirectory: await parent() });
    const warn = vi.fn(), state = activationHarness();
    const remembered = Promise.reject(new Error("Recents storage unavailable")).catch(warn);
    const opened = await state.activate(selection, remembered);
    expect(warn).toHaveBeenCalledOnce(); expect(opened.project).toBe(selection.project);
    expect(opened.location).toEqual(state.location);
  });
});

it("returns the session captured before the recents await, independently of later mutable metadata", async () => {
  const selection = await createNamedProjectSelection({ name: "Captured", parentDirectory: await parent() });
  const remembered = deferred(), context = { windowEpoch: "window", documentSessionId: "document", targetGeneration: 1 };
  const location = { folderPath: selection.folderPath, projectPath: selection.projectPath };
  const session = { context: { ...context }, location: { ...location }, recoveryRecordId: "captured-record", lifecycleReady: false };
  const pending = completeProjectActivation(selection.project, { generation: 1, location, session, remembered: remembered.promise, currentGeneration: () => 1 });
  session.context.documentSessionId = "foreign"; session.recoveryRecordId = "foreign-record";
  remembered.resolve();
  expect((await pending).session).toEqual({ context, location, recoveryRecordId: "captured-record", lifecycleReady: false });
});
