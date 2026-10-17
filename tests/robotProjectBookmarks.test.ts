import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readRobotProjectBookmarks,
  rememberRobotProject,
  summarizeRobotProjectBookmarks,
  writeRobotProjectBookmarks,
} from "../src/electron/robotProjectBookmarks";

const temporaryDirectories: string[] = [];

async function temporaryFile(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-robot-bookmarks-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "robot-projects.json");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("Robot project bookmarks", () => {
  it("persists bounded records while summaries expose a display location and omit the project file authority", async () => {
    const filePath = await temporaryFile();
    const robotOne = path.resolve("/tmp/robot-one");
    const robotTwo = path.resolve("/tmp/robot-two");
    let bookmarks = rememberRobotProject([], robotOne, "Robot One", new Date("2026-08-04T12:00:00Z"));
    bookmarks = rememberRobotProject(bookmarks, robotTwo, "Robot Two", new Date("2026-08-04T13:00:00Z"));
    bookmarks = rememberRobotProject(bookmarks, robotOne, "Robot One Renamed", new Date("2026-08-04T14:00:00Z"));

    await writeRobotProjectBookmarks(filePath, bookmarks);
    const restored = await readRobotProjectBookmarks(filePath);
    const summaries = summarizeRobotProjectBookmarks(restored);

    expect(restored).toHaveLength(2);
    expect(restored[0]).toMatchObject({ projectName: "Robot One Renamed", projectPath: robotOne });
    expect(summaries[0]).toEqual({
      id: restored[0].id,
      projectName: "Robot One Renamed",
      folderName: "robot-one",
      locationHint: path.dirname(robotOne),
      lastLinkedAt: "2026-08-04T14:00:00.000Z",
    });
    expect(summaries[0]).not.toHaveProperty("projectPath");
  });

  it("distinguishes same-named clones even when linked at the same time", () => {
    const first = path.resolve("/tmp/clone-a/robot/Robot.lvproj"), second = path.resolve("/tmp/clone-b/robot/Robot.lvproj");
    const when = new Date("2026-10-16T12:00:00Z");
    const summaries = summarizeRobotProjectBookmarks(rememberRobotProject(rememberRobotProject([], first, "Robot", when), second, "Robot", when));
    expect(summaries.map(item => item.locationHint)).toEqual([path.dirname(second), path.dirname(first)]);
    expect(summaries.every(item => !("projectPath" in item))).toBe(true);
  });

  it("drops unspecified runtime bookmarks and preserves LabVIEW projects", async () => {
    const filePath = await temporaryFile();
    const projectPath = path.resolve("/tmp/mixed-robot");
    await fs.writeFile(filePath, JSON.stringify({
      version: 1,
      projects: [{
        projectName: "Legacy Robot",
        folderName: "mixed-robot",
        lastLinkedAt: "2026-08-04T12:00:00.000Z",
        projectPath,
      }],
    }));

    const legacy = await readRobotProjectBookmarks(filePath);
    expect(legacy).toEqual([]);

    const bookmarks = rememberRobotProject(legacy, projectPath, "LabVIEW Robot", new Date("2026-08-04T13:00:00Z"), "labview");
    await writeRobotProjectBookmarks(filePath, bookmarks);
    expect((await readRobotProjectBookmarks(filePath))[0]).toMatchObject({ projectName: "LabVIEW Robot", runtime: "labview" });
  });

  it("rejects oversized storage and drops malformed bookmark entries", async () => {
    const filePath = await temporaryFile();
    await fs.writeFile(filePath, JSON.stringify({
      version: 1,
      projects: [
        { projectName: "Bad", folderName: "bad", lastLinkedAt: "not-a-date", projectPath: "relative/path" },
      ],
    }));
    expect(await readRobotProjectBookmarks(filePath)).toEqual([]);

    await fs.writeFile(filePath, " ".repeat(64 * 1024 + 1));
    await expect(readRobotProjectBookmarks(filePath)).rejects.toThrow(/size limit/);
  });
});
