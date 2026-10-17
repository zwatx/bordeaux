import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoProject } from "../src/shared/project/defaults";
import { decodeProjectFile, encodeProjectFile } from "../src/shared/project/fileFormat";
import { normalizeLabviewProjectPath } from "../src/shared/project/labviewLink";
import { labviewLinkMatches, rebaseProjectLabviewLink, relativeLabviewLink, resolveProjectLabviewLink, suggestProjectLabviewLink } from "../src/electron/projectLabviewLink";
import { reconcileSavedRobotLink } from "../src/renderer/lib/projectRobotLink";

const roots: string[] = [];
const current = () => {};
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-portable-link-"))); roots.push(root);
  const folder = path.join(root, "repo", "paths"); await fs.mkdir(folder, { recursive: true });
  return { root, folder };
}
async function lvproj(file: string) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, "<Project/>"); return file; }

describe("portable LabVIEW source contract", () => {
  it.each(["/Robot.lvproj", "\\\\server\\Robot.lvproj", "//server/Robot.lvproj", "C:\\Robot.lvproj", "C:Robot.lvproj", "https://x/Robot.lvproj", "x\0.lvproj", "../", "Robot.vi", "robot:stream.lvproj"])("rejects %j without enabling a legacy fallback", value => {
    expect(() => normalizeLabviewProjectPath(value)).toThrow();
    const source = createDemoProject(); source.editor = { labviewProjectPath: value, robotProjectBookmarkId: "a".repeat(20) };
    expect(() => encodeProjectFile(source)).toThrow();
  });
  it("round-trips slash-normalized siblings, explicit null, and absent legacy links", () => {
    const project = createDemoProject(); project.editor = { labviewProjectPath: ".\\..\\Robot\\.\\Robot.lvproj", robotProjectBookmarkId: "a".repeat(20) };
    expect(decodeProjectFile(encodeProjectFile(project).contents).project.editor?.labviewProjectPath).toBe("../Robot/Robot.lvproj");
    project.editor.labviewProjectPath = null;
    expect(decodeProjectFile(encodeProjectFile(project).contents).project.editor?.labviewProjectPath).toBeNull();
    delete project.editor.labviewProjectPath;
    expect(decodeProjectFile(encodeProjectFile(project).contents).project.editor).toEqual(project.editor);
  });
  it("resolves each clone against its current folder, despite an available unrelated old bookmark", async () => {
    const { root, folder } = await fixture(), second = path.join(root, "clone", "paths");
    await fs.mkdir(second, { recursive: true });
    const firstFile = await lvproj(path.join(folder, "..", "Robot.lvproj")), secondFile = await lvproj(path.join(second, "..", "Robot.lvproj"));
    const editor = { labviewProjectPath: "../Robot.lvproj", robotProjectBookmarkId: "a".repeat(20) }, bookmarks = [{ id: editor.robotProjectBookmarkId, projectPath: firstFile }];
    const before = structuredClone(editor);
    expect(await resolveProjectLabviewLink(folder, editor, bookmarks, current)).toBe(firstFile);
    expect(await resolveProjectLabviewLink(second, editor, bookmarks, current)).toBe(secondFile);
    expect(editor).toEqual(before);
    await fs.unlink(secondFile);
    await expect(resolveProjectLabviewLink(second, editor, bookmarks, current)).rejects.toMatchObject({ code: "ENOENT" });
    expect(labviewLinkMatches(editor, second, firstFile, editor.robotProjectBookmarkId)).toBe(false);
  });
  it("keeps absent-field legacy compatibility; null and detached relative links never fall back", async () => {
    const { folder } = await fixture(), file = await lvproj(path.join(folder, "Robot.lvproj"));
    const bookmark = "a".repeat(20), bookmarks = [{ id: bookmark, projectPath: file }];
    expect(await resolveProjectLabviewLink(null, { robotProjectBookmarkId: bookmark }, bookmarks, current)).toBe(file);
    expect(await resolveProjectLabviewLink(folder, { labviewProjectPath: null, robotProjectBookmarkId: bookmark }, bookmarks, current)).toBeNull();
    expect(await resolveProjectLabviewLink(null, { labviewProjectPath: "Robot.lvproj", robotProjectBookmarkId: bookmark }, bookmarks, current)).toBeNull();
    expect(labviewLinkMatches({ labviewProjectPath: null, robotProjectBookmarkId: bookmark }, folder, file, bookmark)).toBe(false);
  });
  it("rejects a symlink or junction in the selected file's ancestry before canonicalization", async () => {
    const { root, folder } = await fixture(); await lvproj(path.join(root, "outside", "Robot.lvproj"));
    await fs.symlink(path.join(root, "outside"), path.join(folder, "linked"), process.platform === "win32" ? "junction" : "dir");
    await expect(resolveProjectLabviewLink(folder, { labviewProjectPath: "linked/Robot.lvproj" }, [], current)).rejects.toThrow("links and junctions");
  });
});

describe("bounded proposals and copies", () => {
  it("proposes only one direct candidate across the folder and two parents, never descendants", async () => {
    const { root, folder } = await fixture(); await lvproj(path.join(folder, "nested", "Ignored.lvproj"));
    expect(await suggestProjectLabviewLink(folder, current)).toBeNull();
    const candidate = await lvproj(path.join(root, "Only.lvproj"));
    expect(await suggestProjectLabviewLink(folder, current)).toBe(candidate);
    await lvproj(path.join(folder, "Other.lvproj"));
    expect(await suggestProjectLabviewLink(folder, current)).toBeNull();
  });
  it("does not claim uniqueness after a read failure, link entry, or entry budget exhaustion", async () => {
    const { root, folder } = await fixture(); await lvproj(path.join(folder, "Robot.lvproj"));
    const opendir = fs.opendir.bind(fs);
    vi.spyOn(fs, "opendir").mockImplementation((async (dir: string) => { if (dir === path.dirname(folder)) throw Object.assign(new Error("No access"), { code: "EACCES" }); return opendir(dir); }) as typeof fs.opendir);
    await expect(suggestProjectLabviewLink(folder, current)).rejects.toThrow("No access");
    vi.restoreAllMocks();
    await fs.symlink(await lvproj(path.join(root, "Other.lvproj")), path.join(folder, "Alias.lvproj"), "file");
    expect(await suggestProjectLabviewLink(folder, current)).toBeNull();
    await fs.unlink(path.join(folder, "Alias.lvproj"));
    // A public filesystem boundary reports a saturated directory without creating thousands of files.
    const close = vi.fn(async () => {});
    vi.spyOn(fs, "opendir").mockResolvedValue({ close, async *[Symbol.asyncIterator]() { for (let i = 0; i < 4097; i++) yield { name: String(i), isFile: () => true }; } } as unknown as Awaited<ReturnType<typeof fs.opendir>>);
    expect(await suggestProjectLabviewLink(folder, current)).toBeNull(); expect(close).toHaveBeenCalled();
  });
  it("stops filesystem work when its document context retires", async () => {
    const { folder } = await fixture(); const stat = vi.spyOn(fs, "lstat");
    await expect(resolveProjectLabviewLink(folder, { labviewProjectPath: "Robot.lvproj" }, [], () => { throw new Error("stale"); })).rejects.toThrow("stale");
    expect(stat).not.toHaveBeenCalled();
  });
  it("rebases the intended file on Save copy, even when it is missing, without mutating the recovery", async () => {
    const { root, folder } = await fixture(), to = path.join(root, "copy");
    const project = createDemoProject(); project.editor = { labviewProjectPath: "Robot.lvproj" };
    const before = structuredClone(project), copy = rebaseProjectLabviewLink(project, folder, to);
    expect(copy.editor?.labviewProjectPath).toBe("../repo/paths/Robot.lvproj");
    expect(labviewLinkMatches(copy.editor, to, path.join(folder, "Robot.lvproj"), null)).toBe(true);
    expect(labviewLinkMatches(copy.editor, to, path.join(to, "Robot.lvproj"), null)).toBe(false);
    expect(project).toEqual(before);
    expect(rebaseProjectLabviewLink(copy, to, to)).toBe(copy);
    expect(rebaseProjectLabviewLink(project, null, to).editor?.labviewProjectPath).toBeNull();
  });
  it("makes an explicitly linked Untitled portable at first save and declines cross-drive rebases", () => {
    const bookmark = "a".repeat(20), project = createDemoProject(); project.editor = { robotProjectBookmarkId: bookmark };
    const folder = path.resolve("project"), file = path.join(folder, "Robot.lvproj");
    expect(rebaseProjectLabviewLink(project, null, folder, { file, bookmark }).editor).toEqual({ labviewProjectPath: "Robot.lvproj" });
    if (process.platform === "win32") expect(relativeLabviewLink("C:\\paths", "D:\\Robot.lvproj")).toBeNull();
  });
  it("keeps the machine bookmark out of a rebased portable link, but leaves an unresolvable one as authored", () => {
    const bookmark = "a".repeat(20), project = createDemoProject(), from = path.resolve("repo", "paths"), to = path.resolve("copy");
    project.editor = { labviewProjectPath: "Robot.lvproj", robotProjectBookmarkId: bookmark };
    expect(rebaseProjectLabviewLink(project, from, to).editor).toEqual({ labviewProjectPath: "../repo/paths/Robot.lvproj" });
    expect(rebaseProjectLabviewLink(project, null, to).editor).toEqual({ labviewProjectPath: null, robotProjectBookmarkId: bookmark });
  });
  it("adopts a copy's canonical link without reverting later edits or a newer explicit selection", () => {
    const captured = createDemoProject(); captured.editor = { labviewProjectPath: "Robot.lvproj" };
    const canonical = { ...captured, editor: { labviewProjectPath: "../original/Robot.lvproj" } };
    const edited = { ...captured, name: "Later name" };
    expect(reconcileSavedRobotLink(edited, captured, canonical)).toMatchObject({ name: "Later name", editor: canonical.editor });
    const relinked = { ...edited, editor: { labviewProjectPath: "New.lvproj" } };
    expect(reconcileSavedRobotLink(relinked, captured, canonical)).toBe(relinked);
    const adopted = reconcileSavedRobotLink(captured, captured, canonical);
    expect(decodeProjectFile(encodeProjectFile(adopted).contents).project.editor).toEqual(canonical.editor);
  });
});
