import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { revealRecentProject, type RecentRevealDependencies } from "../src/electron/projectRecentActions";
import { recentProjectId } from "../src/electron/recentProjectFiles";
import type { ProjectLocation } from "../src/shared/project/desktopProjects";

let root: string;
beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-recent-reveal-"))); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

const context = { windowEpoch: "w", documentSessionId: "d", targetGeneration: 1 };
function deps(lists: string[][], location: ProjectLocation | null = null, extra: Partial<RecentRevealDependencies> = {}) {
  const revealed: string[] = [];
  let read = 0;
  const value: RecentRevealDependencies = {
    // Each read returns the next listing (the last one repeats), so a list changing mid-reveal is observable.
    recents: async () => lists[Math.min(read++, lists.length - 1)],
    current: (candidate) => candidate === context ? location : null,
    assertWindowCurrent: () => undefined,
    reveal: (filename) => { revealed.push(filename); },
    ...extra,
  };
  return { value, revealed };
}
const folder = async (name: string) => { const place = path.join(root, name); await fs.mkdir(place); return place; };

describe("Show in Finder/Explorer for Projects rows", () => {
  it("reveals a recent folder, a workspace file's folder, or a legacy file, by stable id only", async () => {
    const plain = await folder("Week 2"), managed = await folder("Week 3");
    const workspace = path.join(managed, ".bordeaux-workspace.json"), legacy = path.join(root, "Old.bordeaux");
    await fs.writeFile(workspace, "{}"); await fs.writeFile(legacy, "{}");
    const list = [plain, workspace, legacy], { value, revealed } = deps([list]);
    for (const entry of list) expect(await revealRecentProject({ id: recentProjectId(entry) }, value)).toEqual({ revealed: true });
    expect(revealed).toEqual([plain, managed, legacy]);
  });

  it("never treats a renderer-supplied path as a target", async () => {
    const plain = await folder("Week 2"), { value, revealed } = deps([[plain]]);
    expect(await revealRecentProject(plain, value)).toMatchObject({ revealed: false, code: "invalid" });
    expect(await revealRecentProject({ id: plain }, value)).toMatchObject({ revealed: false, code: "stale", fact: "No longer in the list" });
    expect(await revealRecentProject({ path: plain }, value)).toMatchObject({ revealed: false, code: "invalid" });
    expect(await revealRecentProject(null, value)).toMatchObject({ revealed: false, code: "invalid" });
    expect(revealed).toEqual([]);
  });

  it("says a moved project is missing and refuses links and non-project files", async () => {
    const real = await folder("Real"), link = path.join(root, "Linked");
    await fs.symlink(real, link);
    const notes = path.join(root, "notes.txt"), gone = path.join(root, "Gone");
    await fs.writeFile(notes, "x");
    const { value, revealed } = deps([[link, notes, gone]]);
    expect(await revealRecentProject({ id: recentProjectId(link) }, value)).toMatchObject({ revealed: false, code: "invalid" });
    expect(await revealRecentProject({ id: recentProjectId(notes) }, value)).toMatchObject({ revealed: false, code: "invalid" });
    expect(await revealRecentProject({ id: recentProjectId(gone) }, value)).toMatchObject({ revealed: false, code: "missing", fact: "Project isn’t there anymore" });
    expect(revealed).toEqual([]);
  });

  it("reveals nothing when the row leaves the list or the window moves on meanwhile", async () => {
    const plain = await folder("Week 2"), id = recentProjectId(plain);
    const removed = deps([[plain], []]);
    expect(await revealRecentProject({ id }, removed.value)).toMatchObject({ revealed: false, code: "stale" });
    expect(removed.revealed).toEqual([]);
    let checks = 0;
    const retired = deps([[plain]], null, { assertWindowCurrent: () => { if (++checks > 2) throw new Error("window changed"); } });
    expect(await revealRecentProject({ id }, retired.value)).toMatchObject({ revealed: false, code: "stale" });
    expect(retired.revealed).toEqual([]);
  });

  it("reveals this window's own saved project only for its exact current context", async () => {
    const project = await folder("Current"), legacy = path.join(project, "Autos.bordeaux.json");
    await fs.writeFile(legacy, "{}");
    const saved = deps([[]], { folderPath: project, projectPath: path.join(project, ".bordeaux-workspace.json") });
    expect(await revealRecentProject({ current: context }, saved.value)).toEqual({ revealed: true });
    expect(saved.revealed).toEqual([project]);
    const opened = deps([[]], { folderPath: project, projectPath: null, legacyFile: legacy });
    expect(await revealRecentProject({ current: context }, opened.value)).toEqual({ revealed: true });
    expect(opened.revealed).toEqual([legacy]);
    // A stale context, or an untitled/detached document without a folder, reveals nothing.
    expect(await revealRecentProject({ current: { ...context } }, saved.value)).toMatchObject({ revealed: false, code: "stale", fact: "The project changed" });
    // A same-document Save copy retargets (next target generation) while the reveal runs: the old row reveals nothing,
    // never the copy's new folder.
    const copy = await folder("Current copy");
    let reads = 0;
    const retargeted = deps([[]], null, { current: (candidate) => candidate === context && ++reads === 1 ? { folderPath: project, projectPath: null } : null });
    expect(await revealRecentProject({ current: context }, retargeted.value)).toMatchObject({ revealed: false, code: "stale" });
    expect(retargeted.revealed).toEqual([]);
    let checks = 0;
    const moved = deps([[]], null, { current: (candidate) => candidate === context ? { folderPath: ++checks > 1 ? copy : project, projectPath: null } : null });
    expect(await revealRecentProject({ current: context }, moved.value)).toMatchObject({ revealed: false, code: "stale" });
    expect(moved.revealed).toEqual([]);
    const untitled = deps([[]], { folderPath: null, projectPath: null });
    expect(await revealRecentProject({ current: context }, untitled.value)).toMatchObject({ revealed: false, code: "stale" });
    expect(untitled.revealed).toEqual([]);
  });
});
