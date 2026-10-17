import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDemoProject } from "../src/shared/project/defaults";
import { decodeProjectFile, encodeProjectFile } from "../src/shared/project/fileFormat";
import { validateProject } from "../src/shared/validation";
import { buildBdxExport } from "../src/shared/export/bdx";
import { ProjectRecoveryStore } from "../src/electron/projectRecoveryStore";
import { autosaveProjectFolder, openProjectFolder } from "../src/electron/projectFiles";

describe("unfinished authored paths", () => {
  it.each([0, 1])("saves and recovers a %i-point path without making it exportable", async (count) => {
    const project = createDemoProject();
    project.paths[0].waypoints = project.paths[0].waypoints.slice(0, count);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-incomplete-source-"));
    try {
      const encoded = encodeProjectFile(project);
      expect(decodeProjectFile(encoded.contents).project.paths[0].waypoints).toEqual(project.paths[0].waypoints);
      const folder = path.join(directory, "Draft");
      await fs.mkdir(folder);
      const saved = await autosaveProjectFolder(folder, project, null);
      expect((await openProjectFolder(folder)).project?.paths[0].waypoints).toEqual(project.paths[0].waypoints);
      const store = new ProjectRecoveryStore(path.join(directory, "recovery"));
      const recordId = randomUUID();
      const receipt = await store.writeSnapshot({ recordId, revision: 1, capturedAt: "2026-10-12T12:00:00.000Z",
        displayName: "Unfinished draft", reason: "checkpoint", origin: { kind: "untitled", id: randomUUID() }, project });
      expect(receipt.stored).toBe(true);
      expect((await store.readSnapshot(recordId)).project.paths[0].waypoints).toEqual(project.paths[0].waypoints);
      expect(validateProject(saved).ok).toBe(false);
      expect(() => buildBdxExport(saved)).toThrow("at least two waypoints");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["velocity", "robot", "constraints"])("still rejects malformed %s in an unfinished source", (kind) => {
    const project = createDemoProject();
    project.paths[0].waypoints = [];
    if (kind === "velocity") project.paths[0].startVel = Number.NaN;
    if (kind === "robot") project.robot.maxSpeed = -1;
    if (kind === "constraints") project.paths[0].constraints.maxVel = -1;
    expect(() => encodeProjectFile(project)).toThrow("Invalid Bordeaux project");
  });
});
