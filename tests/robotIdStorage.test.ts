import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoProject } from "../src/core/project/defaults";
import { decodeProjectFile, encodeProjectFile, prepareProjectFile, storedProject } from "../src/core/project/fileFormat";
import { decodeWorkspace, projectDocuments, workspaceContents, type FolderState } from "../src/core/project/folderLayout";
import { duplicateRobot, UNLISTED_ROBOT_ID } from "../src/core/project/robots";
import { ProjectRecoveryStore } from "../src/electron/projectRecoveryStore";
import type { BordeauxProject } from "../src/core/types";

/*
 * The selected robot's `id` lives in memory only. Ways this can fail:
 *  1. A boundary (project file, folder workspace, path document, recovery record) writes it.
 *  2. Loading from that boundary does not restore it, so per-use estimates stop resolving.
 */

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))); });

/** Two robots, the copy selected, with an estimate for the copy on one path event. */
function listedProject(): BordeauxProject {
  const base = createDemoProject();
  base.paths[0].markers = [{ id: "m", name: "Shoot", f: 0.5, invocation: { commandId: "shoot", arguments: {} } }];
  const project = prepareProjectFile(duplicateRobot(base, UNLISTED_ROBOT_ID));
  const id = project.activeRobotId!;
  project.paths[0].markers![0].invocation!.power = { [id]: { currentA: 20, inputKey: "k".repeat(64) } };
  return prepareProjectFile(project);
}

function storedIds(value: unknown): unknown[] {
  const ids: unknown[] = [];
  const project = value as BordeauxProject;
  ids.push(project.robot?.id);
  for (const entry of project.robots ?? []) ids.push(entry.robot?.id);
  return ids.filter((id) => id !== undefined);
}

describe("the selected robot's in-memory id", () => {
  it("is set in memory and never stored by the project file", () => {
    const project = listedProject();
    expect(project.robot.id).toBe(project.activeRobotId);
    const encoded = encodeProjectFile(project);
    expect(encoded.project.robot.id).toBe(project.activeRobotId);
    expect(storedIds(JSON.parse(encoded.contents))).toEqual([]);
    expect(decodeProjectFile(encoded.contents).project).toEqual(encoded.project);
    expect(storedProject(storedProject(project))).toEqual(storedProject(project));
  });

  it("is not written to a folder workspace or a path document, and loading the workspace restores it", () => {
    const project = listedProject();
    const state: FolderState = { format: "bordeaux-folder/1", projectPath: null, project, files: {} };
    const contents = workspaceContents(state);
    const raw = JSON.parse(contents) as { project: unknown };
    expect(storedIds(raw.project)).toEqual([]);
    expect(decodeWorkspace(contents).state.project).toEqual(project);
    for (const document of projectDocuments(project)) {
      const parsed = JSON.parse(document.contents) as { robot?: { id?: string } };
      expect(parsed.robot?.id).toBeUndefined();
    }
    // The caller's state keeps its in-memory project.
    expect(state.project.robot.id).toBe(project.activeRobotId);
  });

  it("is not written to a recovery record, and reading the record restores it", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-robot-id-")); directories.push(directory);
    const root = path.join(directory, "recovery"), store = new ProjectRecoveryStore(root);
    const project = listedProject(), recordId = randomUUID();
    await store.writeSnapshot({ recordId, revision: 1, capturedAt: "2026-11-26T12:00:00.000Z", displayName: "Draft", reason: "autosave-failed", origin: { kind: "untitled", id: randomUUID() }, project });
    const onDisk = JSON.parse(await fs.readFile(path.join(root, `${recordId}.json`), "utf8")) as { project: unknown };
    expect(storedIds(onDisk.project)).toEqual([]);
    const restored = await store.readSnapshot(recordId);
    expect(restored.project).toEqual(encodeProjectFile(project).project);
    expect(restored.project.robot.id).toBe(project.activeRobotId);
  });
});
