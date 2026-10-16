import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureProjectsHomeForRequest, projectsHomePath } from "../src/electron/projectsHome";

const directories: string[] = [];
async function documents() {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-projects-home-")); directories.push(folder); return folder;
}
afterEach(async () => { await Promise.all(directories.splice(0).map(folder => fs.rm(folder, { recursive: true, force: true }))); });

describe("default projects home", () => {
  it("suggests Documents/Bordeaux without creating it", async () => {
    const root = await documents(), home = projectsHomePath(root);
    expect(home).toBe(path.join(root, "Bordeaux"));
    await expect(fs.stat(home)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates exactly the home folder for a request that targets it, and tolerates an existing one", async () => {
    const root = await documents(), home = projectsHomePath(root);
    await ensureProjectsHomeForRequest({ name: "Week 3", parentDirectory: home + path.sep }, home);
    expect((await fs.stat(home)).isDirectory()).toBe(true);
    expect(await fs.readdir(home)).toEqual([]);
    await fs.writeFile(path.join(home, "keep.txt"), "kept");
    await ensureProjectsHomeForRequest({ name: "Week 4", parentDirectory: home }, home);
    expect(await fs.readFile(path.join(home, "keep.txt"), "utf8")).toBe("kept");
  });

  it("never creates other parents or recursive paths from a request", async () => {
    const root = await documents(), home = projectsHomePath(root);
    for (const parentDirectory of [path.join(root, "Elsewhere"), path.join(home, "Nested"), "Bordeaux", path.join(root, "Bordeaux\0x")]) {
      await ensureProjectsHomeForRequest({ name: "Week 3", parentDirectory }, home);
    }
    await ensureProjectsHomeForRequest(null, home);
    await ensureProjectsHomeForRequest({ name: "Week 3" }, home);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("does not create missing ancestors of the home", async () => {
    const root = await documents(), home = projectsHomePath(path.join(root, "Missing documents"));
    await expect(ensureProjectsHomeForRequest({ name: "Week 3", parentDirectory: home }, home)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(root)).toEqual([]);
  });
});
