import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blankPath, createDemoProject } from "../src/shared/project/defaults";
import { MAX_WORKSPACE_FILE_BYTES, autosaveProjectFolder, openProjectFolder, writeProjectFolderBdx } from "../src/electron/projectFiles";
import { binaryFileName } from "../src/shared/export/robotBinary";

const directories: string[] = [];
async function folder() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-bdx-folder-"));
  directories.push(directory);
  await autosaveProjectFolder(directory, createDemoProject(), null);
  return directory;
}
const output = (fileName = "Test.bdx", content = "first") => ({ fileName, bytes: Buffer.from(content) });
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("folder BDX generation", () => {
  it("writes exact binary bytes only on explicit generation and preserves ownership across autosaves", async () => {
    const directory = await folder();
    expect((await fs.readdir(path.join(directory, "Paths"))).filter((name) => name.endsWith(".bdx"))).toEqual([]);
    const bytes = Buffer.from([0, 255, 128, 10]);
    await writeProjectFolderBdx(directory, [{ fileName: "Test.bdx", bytes }]);
    expect(await fs.readFile(path.join(directory, "Paths/Test.bdx"))).toEqual(bytes);
    await autosaveProjectFolder(directory, createDemoProject(), null);
    await writeProjectFolderBdx(directory, [output("Test.bdx", "new")]);
    expect(await fs.readFile(path.join(directory, "Paths/Test.bdx"), "utf8")).toBe("new");
  });

  it("preserves unrelated and externally changed outputs, including identical unrelated bytes", async () => {
    const directory = await folder();
    const destination = path.join(directory, "Paths/Test.bdx");
    await fs.writeFile(destination, "first");
    await expect(writeProjectFolderBdx(directory, [output()])).rejects.toThrow("unrelated or changed outside");
    await fs.rm(destination);
    await writeProjectFolderBdx(directory, [output()]);
    await fs.writeFile(destination, "external");
    await expect(writeProjectFolderBdx(directory, [output("Test.bdx", "new")])).rejects.toThrow("changed outside");
    expect(await fs.readFile(destination, "utf8")).toBe("external");
  });

  it("preflights every output before writing and retains saved source after a conflict", async () => {
    const directory = await folder();
    await fs.writeFile(path.join(directory, "Paths/Other.bdx"), "unrelated");
    const project = createDemoProject(); project.paths[0].name = "Latest edit";
    await autosaveProjectFolder(directory, project, null);
    await expect(writeProjectFolderBdx(directory, [output(), output("Other.bdx")])).rejects.toThrow("unrelated");
    await expect(fs.stat(path.join(directory, "Paths/Test.bdx"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await openProjectFolder(directory)).project?.paths[0].name).toBe("Latest edit");
  });

  it("rejects path traversal, duplicate names, and linked output files or directories", async () => {
    const directory = await folder(); const outside = await folder();
    await expect(writeProjectFolderBdx(directory, [output("../Escape.bdx")])).rejects.toThrow("plain .bdx filename");
    await expect(writeProjectFolderBdx(directory, [output(), output("test.BDX")])).rejects.toThrow("Duplicate");
    await fs.writeFile(path.join(outside, "Test.bdx"), "outside");
    await fs.symlink(path.join(outside, "Test.bdx"), path.join(directory, "Paths/Test.bdx"));
    await expect(writeProjectFolderBdx(directory, [output()])).rejects.toThrow("regular file");
    await fs.rm(path.join(directory, "Paths"), { recursive: true });
    await fs.symlink(outside, path.join(directory, "Paths"));
    await expect(writeProjectFolderBdx(directory, [output()])).rejects.toThrow("regular directory");
    expect(await fs.readFile(path.join(outside, "Test.bdx"), "utf8")).toBe("outside");
  });

  it("recovers interrupted output writes even after autosaving another source edit", async () => {
    const directory = await folder();
    await writeProjectFolderBdx(directory, [output(), output("Other.bdx")]);
    const rename = fs.rename.bind(fs); let fail = true;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to).endsWith("Other.bdx") && fail) { fail = false; throw new Error("disk interrupted"); }
      return rename(from, to);
    });
    await expect(writeProjectFolderBdx(directory, [output("Test.bdx", "second"), output("Other.bdx", "second")])).rejects.toThrow("disk interrupted");
    await autosaveProjectFolder(directory, createDemoProject(), null);
    await writeProjectFolderBdx(directory, [output("Test.bdx", "third"), output("Other.bdx", "third")]);
    expect(await fs.readFile(path.join(directory, "Paths/Test.bdx"), "utf8")).toBe("third");
    expect(await fs.readFile(path.join(directory, "Paths/Other.bdx"), "utf8")).toBe("third");
    const manifest = JSON.parse(await fs.readFile(path.join(directory, ".bordeaux-workspace.json"), "utf8"));
    expect(manifest.pendingGeneratedFiles).toBeUndefined();
  });

  it("removes an old binary only after its replacement succeeds and preserves unrelated files", async () => {
    const directory = await folder();
    await writeProjectFolderBdx(directory, [output("Before.bdx")]);
    await fs.writeFile(path.join(directory, "Paths/Unrelated.bdx"), "keep");
    const link = fs.link.bind(fs); let fail = true;
    vi.spyOn(fs, "link").mockImplementation(async (from, to) => {
      if (String(to).endsWith("After.bdx") && fail) { fail = false; throw new Error("disk interrupted"); }
      return link(from, to);
    });
    await expect(writeProjectFolderBdx(directory, [output("After.bdx", "new")])).rejects.toThrow("disk interrupted");
    expect(await fs.readFile(path.join(directory, "Paths/Before.bdx"), "utf8")).toBe("first");
    await writeProjectFolderBdx(directory, [output("After.bdx", "new")]);
    await expect(fs.stat(path.join(directory, "Paths/Before.bdx"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(directory, "Paths/After.bdx"), "utf8")).toBe("new");
    expect(await fs.readFile(path.join(directory, "Paths/Unrelated.bdx"), "utf8")).toBe("keep");
  });

  it("replaces case-only renamed outputs without removing the new binary", async () => {
    const directory = await folder();
    await writeProjectFolderBdx(directory, [output("CaseTest.bdx")]);
    await writeProjectFolderBdx(directory, [output("casetest.bdx", "new")]);
    expect((await fs.readdir(path.join(directory, "Paths"))).filter((file) => file.endsWith(".bdx"))).toEqual(["casetest.bdx"]);
    expect(await fs.readFile(path.join(directory, "Paths/casetest.bdx"), "utf8")).toBe("new");
  });

  it("serializes outputs with source autosaves and removes obsolete managed outputs", async () => {
    const directory = await folder(); const project = createDemoProject(); project.paths[0].name = "Next edit";
    await Promise.all([
      writeProjectFolderBdx(directory, [output()]),
      autosaveProjectFolder(directory, project, null),
      writeProjectFolderBdx(directory, [output("Test.bdx", "latest")]),
    ]);
    expect((await openProjectFolder(directory)).project?.paths[0].name).toBe("Next edit");
    await writeProjectFolderBdx(directory, []);
    await expect(fs.stat(path.join(directory, "Paths/Test.bdx"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("generates nothing when its ownership records would overfill a near-limit workspace", async () => {
    const directory = await folder(), workspace = path.join(directory, ".bordeaux-workspace.json");
    const project = createDemoProject();
    project.paths = [blankPath("One"), blankPath("Two"), blankPath("Three")];
    project.editor = { ...project.editor, activePathId: project.paths[0].id };
    const withPayload = (lengths: readonly number[]) => {
      const next = structuredClone(project);
      lengths.forEach((length, index) => { next.paths[index].markers = [{ id: `payload-${index}`, f: 0.5, name: "Payload", invocation: { commandId: "Payload", arguments: { blob: "x".repeat(length) } } }]; });
      return next;
    };
    await autosaveProjectFolder(directory, withPayload([0, 0, 0]), null);
    // Leave 8 KiB: enough for a few ownership records, not for hundreds.
    const total = MAX_WORKSPACE_FILE_BYTES - 8 * 1024 - (await fs.stat(workspace)).size, share = Math.floor(total / 3);
    await autosaveProjectFolder(directory, withPayload([total - 2 * share, share, share]), null);
    expect((await fs.stat(workspace)).size).toBe(MAX_WORKSPACE_FILE_BYTES - 8 * 1024);
    const saved = await fs.readFile(workspace);

    const many = Array.from({ length: 200 }, (_, index) => output(`Output ${index}.bdx`));
    await expect(writeProjectFolderBdx(directory, many)).rejects.toThrow(/^The project workspace would be 32\.\d MiB, over the 32 MiB limit/);
    expect((await fs.readFile(workspace)).equals(saved)).toBe(true);
    expect((await fs.readdir(path.join(directory, "Paths"))).filter((file) => file.endsWith(".bdx"))).toEqual([]);
    // A missing Paths folder is created only after the workspace records fit.
    await fs.rm(path.join(directory, "Paths"), { recursive: true });
    await expect(writeProjectFolderBdx(directory, many)).rejects.toThrow(/^The project workspace would be 32\.\d MiB/);
    await expect(fs.lstat(path.join(directory, "Paths"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.readFile(workspace)).equals(saved)).toBe(true);

    await writeProjectFolderBdx(directory, [output()]);
    expect(await fs.readFile(path.join(directory, "Paths/Test.bdx"), "utf8")).toBe("first");
    expect((await openProjectFolder(directory)).project?.paths.map((item) => item.name)).toEqual(["One", "Two", "Three"]);
  }, 60_000);

  it("saves device-named paths under portable names next to their source mirrors", async () => {
    const directory = await folder(), project = createDemoProject();
    project.paths = [blankPath("CON"), blankPath("nul.txt"), blankPath("Console")];
    project.editor = { ...project.editor, activePathId: project.paths[0].id };
    await autosaveProjectFolder(directory, project, null);
    const names = project.paths.map((item) => binaryFileName(item.name));
    expect(names).toEqual(["_CON.bdx", "_nul.txt.bdx", "Console.bdx"]);
    await writeProjectFolderBdx(directory, names.map((name) => output(name, name)));
    expect((await fs.readdir(path.join(directory, "Paths"))).sort())
      .toEqual(["Console.bdx", "Console.path", "_CON.bdx", "_CON.path", "_nul.txt.bdx", "_nul.txt.path"]);
    expect(await fs.readFile(path.join(directory, "Paths/_CON.bdx"), "utf8")).toBe("_CON.bdx");
    expect((await openProjectFolder(directory)).project?.paths.map((item) => item.name)).toEqual(["CON", "nul.txt", "Console"]);

    // Device names are refused even from a caller that bypasses binaryFileName.
    for (const name of ["CON.bdx", "con.bdx", "COM1.bdx", "nul.txt.bdx", "LPT1 .bdx"]) {
      await expect(writeProjectFolderBdx(directory, [output(name)])).rejects.toThrow("plain .bdx filename");
    }
    await expect(writeProjectFolderBdx(directory, [output(`${"b".repeat(252)}.bdx`)])).rejects.toThrow("plain .bdx filename");
    expect((await fs.readdir(path.join(directory, "Paths"))).filter((file) => file.endsWith(".bdx")).sort()).toEqual(["Console.bdx", "_CON.bdx", "_nul.txt.bdx"]);
  });

  it("rejects device-name collisions and unrelated prefixed files instead of overwriting them", async () => {
    const directory = await folder(), project = createDemoProject();
    project.paths = [blankPath("CON"), blankPath("_CON"), blankPath("con")];
    project.editor = { ...project.editor, activePathId: project.paths[0].id };
    await autosaveProjectFolder(directory, project, null);
    const sources = (await fs.readdir(path.join(directory, "Paths"))).sort();
    expect(sources).toEqual(["_CON (2).path", "_CON.path", "_con (3).path"]);

    const names = project.paths.map((item) => binaryFileName(item.name));
    expect(names).toEqual(["_CON.bdx", "_CON.bdx", "_con.bdx"]);
    await expect(writeProjectFolderBdx(directory, names.slice(0, 2).map((name) => output(name)))).rejects.toThrow("Duplicate BDX output filename: _CON.bdx");
    await expect(writeProjectFolderBdx(directory, [output(names[0]), output(names[2])])).rejects.toThrow("Duplicate BDX output filename: _con.bdx");
    expect((await fs.readdir(path.join(directory, "Paths"))).sort()).toEqual(sources);

    const unrelated = path.join(directory, "Paths/_CON.bdx");
    await fs.writeFile(unrelated, "made by hand");
    await expect(writeProjectFolderBdx(directory, [output(names[0])])).rejects.toThrow("unrelated or changed outside");
    expect(await fs.readFile(unrelated, "utf8")).toBe("made by hand");
  });
});

it("journals selected exports without removing sibling outputs or their pending ownership", async () => {
  const directory = await folder();
  await writeProjectFolderBdx(directory, [output("Selected.bdx", "old"), output("Sibling.bdx", "sibling")]);
  const workspace = path.join(directory, ".bordeaux-workspace.json"), state = JSON.parse(await fs.readFile(workspace, "utf8"));
  state.pendingGeneratedFiles = { "Paths/Pending.bdx": "a".repeat(64) }; await fs.writeFile(workspace, JSON.stringify(state));
  await writeProjectFolderBdx(directory, [output("Selected.bdx", "explicit")], { mode: "selected" });
  expect(await fs.readFile(path.join(directory, "Paths/Sibling.bdx"), "utf8")).toBe("sibling");
  const updated = JSON.parse(await fs.readFile(workspace, "utf8"));
  expect(updated.generatedFiles["Paths/Sibling.bdx"]).toBe(state.generatedFiles["Paths/Sibling.bdx"]);
  expect(updated.pendingGeneratedFiles).toEqual(state.pendingGeneratedFiles);
  await writeProjectFolderBdx(directory, [output("Selected.bdx", "next save"), output("Sibling.bdx", "sibling")]);
  expect(await fs.readFile(path.join(directory, "Paths/Selected.bdx"), "utf8")).toBe("next save");
});
