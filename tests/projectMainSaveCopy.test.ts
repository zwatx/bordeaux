import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import type { ProjectPersistenceUpdate } from "../src/shared/project/projectPersistence";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as creation from "../src/electron/projectCreation";
import type { ProjectLocation } from "../src/shared/project/desktopProjects";
import { loadProjectSelection } from "../src/electron/projectOpening";
import { ProjectPersistence } from "../src/electron/projectPersistence";
import { ProjectSourcePersistence, ProjectSourceError, sameProjectContext, canonicalProjectDigest } from "../src/electron/projectSourcePersistence";
import { ProjectRecoveryStore } from "../src/electron/projectRecoveryStore";
import { ensureProjectsHomeForRequest } from "../src/electron/projectsHome";
import { projectWorkspacePath, openProjectFolder, writeProjectFolderBdx, autosaveProjectFolder, writeProject } from "../src/electron/projectFiles";
import { createDemoProject } from "../src/shared/project/defaults";
import { validateProjectSource } from "../src/shared/validation";
import { projectWriteFact, projectWriteFactFromMessage } from "../src/shared/project/writeErrors";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-main-copy-"))); roots.push(root);
  let context = { windowEpoch: randomUUID(), documentSessionId: randomUUID(), targetGeneration: 1 };
  let location: ProjectLocation = { folderPath: null, projectPath: null };
  const updates: ProjectPersistenceUpdate[] = [];
  const events: string[] = [], recovery = new ProjectRecoveryStore(path.join(root, "recovery"));
  let persistence!: ProjectPersistence;
  const source = new ProjectSourcePersistence({ getContext: () => context, commit: (capture, _project, target) => {
    context = { ...context, targetGeneration: context.targetGeneration + 1 }; location = { folderPath: path.dirname(target), projectPath: target };
    persistence.sourceTargetCommitted(capture.operationId, context); events.push("commit"); return { context, location };
  } });
  persistence = new ProjectPersistence({ source, recovery, getContext: () => context, getLocation: () => location, onUpdate: update => { updates.push(structuredClone(update)); if (update.recovery === "saved" && update.source === "pending") events.push("recovery"); } });
  const sandbox: Record<string, any> = { ...creation, path, console, Object, Error, ProjectSourceError, sameProjectContext, canonicalProjectDigest,
    projectPersistence: persistence, projectSources: source, projectContext: () => context, validateProjectSource, ensureProjectsHomeForRequest, projectsHome: () => path.join(root, "home"), projectWorkspacePath,
    projectWriteFact, projectWriteFactFromMessage,
    exportSaved: async (saved: any, scope: any) => { events.push("export"); await writeProjectFolderBdx(scope.folderPath, [], { folderIdentity: scope.folderIdentity, expectedSourceDigest: scope.expectedSourceDigest, assertCurrent: () => scope.assertCurrent() }); return { saved: true, location: saved.location, bdxCount: 0 }; },
    captureBinding: () => ({ key: "local", isCurrent: () => true }),
  };
  const text = await fs.readFile(process.env.NAMED_COPY_RED_MAIN_PATH ?? "src/electron/main.ts", "utf8"), ast = ts.createSourceFile("main.ts", text, ts.ScriptTarget.Latest, true);
  for (const name of ["projectCopyDefaults", "copyFailure", "saveProjectCopy"]) {
    const statement = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!statement) throw new Error(`Missing actual main function ${name}`);
    vm.runInNewContext(ts.transpileModule(statement.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, sandbox);
  }
  let token = persistence.beginTransition(context);
  const request = (extra = {}) => ({ context: { ...context }, snapshotRevision: 1, project: createDemoProject(), copyTo: { name: "Exact copy", parentDirectory: root }, transition: token, ...extra });
  // Model main's synchronous activation boundary only after the real selection has loaded.
  const openSource = async (filename: string) => {
    const selection = await loadProjectSelection(filename, { requireSource: true });
    persistence.endTransition(token);
    context = { ...context, documentSessionId: randomUUID(), targetGeneration: context.targetGeneration + 1 };
    location = { folderPath: selection.folderPath, projectPath: selection.projectPath,
      ...(selection.legacyFile ? { legacyFile: selection.legacyFile } : {}) };
    persistence.contextChanged(true);
    persistence.admitSource(context, selection.sourceEvidence, selection.legacyFile);
    token = persistence.beginTransition(context);
    return selection.project;
  };
  const restoreKept = async (project: ReturnType<typeof createDemoProject>) => {
    const handle = persistence.beginReload({ ...request({ project }), transition: token });
    if ("refused" in handle) throw new Error(`Could not keep admitted source: ${handle.refused}`);
    let kept: Awaited<ReturnType<typeof handle.keep>>;
    try { kept = await handle.keep(); } finally { handle.release(); }
    if (kept.status !== "kept") throw new Error(`Could not keep source recovery: ${kept.code}`);
    const restored = await persistence.prepareRestore(context, kept.kept.storedSnapshot.recordId);
    persistence.endTransition(token);
    context = { ...context, documentSessionId: randomUUID(), targetGeneration: context.targetGeneration + 1 };
    location = { folderPath: null, projectPath: null };
    persistence.contextChanged(true, restored.recoveredFrom);
    token = persistence.beginTransition(context);
    return restored;
  };
  return { root, source, persistence, recovery, events, updates, sandbox, request, openSource, restoreKept, get context() { return context; } };
}
describe("actual main named Save copy", () => {
  it("keeps exact authored recovery then commits source then exports into one new folder", async () => {
    const f = await fixture(), request = f.request(); request.project.paths[0].name = "Exact authored path";
    request.project.editor = { ...request.project.editor, robotProjectBookmarkId: "0123456789abcdef0123" };
    const result = await f.sandbox.saveProjectCopy(request);
    expect(result).toMatchObject({ saved: true, location: { folderPath: path.join(f.root, "Exact copy") } });
    expect(f.events).toEqual(expect.arrayContaining(["recovery", "commit", "export"]));
    expect(f.events.indexOf("recovery")).toBeLessThan(f.events.indexOf("commit")); expect(f.events.indexOf("commit")).toBeLessThan(f.events.indexOf("export"));
    const confirmed = f.updates.find(update => update.recovery === "saved" && update.source === "pending");
    expect(confirmed?.recoveryReceipt?.digest).toBe(canonicalProjectDigest(request.project));
    expect(f.persistence.getSession().latestRecovery?.storedSnapshot).toEqual(confirmed?.recoveryReceipt?.storedSnapshot);
    const kept = await f.recovery.readSnapshot(f.persistence.getSession().recoveryRecordId);
    expect(kept.project).toEqual(request.project);
    expect(kept.receipt).toEqual(confirmed!.recoveryReceipt!.storedSnapshot);
    expect(kept.receipt.digest).toBe(canonicalProjectDigest(request.project));
    const saved = (await openProjectFolder(path.join(f.root, "Exact copy"))).project!;
    expect(saved.paths[0].name).toBe("Exact authored path"); expect(saved.editor?.robotProjectBookmarkId).toBe("0123456789abcdef0123");
    expect(f.context.documentSessionId).toBe(request.context.documentSessionId); expect(f.context.targetGeneration).toBe(2);
    expect(await fs.readdir(f.root)).toEqual(expect.arrayContaining(["Exact copy", "recovery"]));
  });
  it.each([{ saveAs: true }, { requestId: "nonce" }, { copyTo: { name: "x", parentDirectory: "/tmp", template: {} } }, { copyTo: Object.assign(Object.create({ inherited: true }), { name: "x", parentDirectory: "/tmp" }) }, { transition: null }])("refuses malformed combinations before any filesystem work: %j", async extra => {
    const f = await fixture(), mkdir = vi.spyOn(fs, "mkdir"), lstat = vi.spyOn(fs, "lstat");
    await expect(f.sandbox.saveProjectCopy(f.request(extra))).rejects.toThrow();
    expect(mkdir).not.toHaveBeenCalled(); expect(lstat).not.toHaveBeenCalled();
  });
  it("leaves a foreign empty folder untouched and does not adopt it", async () => {
    const f = await fixture(); await fs.mkdir(path.join(f.root, "Exact copy"));
    await expect(f.sandbox.saveProjectCopy(f.request())).rejects.toThrow("already exists");
    expect(await fs.readdir(path.join(f.root, "Exact copy"))).toEqual([]); expect(f.persistence.getSession().latestSource).toBeUndefined();
  });
});

it("main defaults use the authoritative folder basename and keep the suggested home read-only", async () => {
  const f = await fixture();
  const untitled = await f.sandbox.projectCopyDefaults({ context: f.context, nameHint: "Authored hint" });
  expect(untitled).toEqual({ name: "Authored hint", parentDirectory: path.join(f.root, "home") });
  await expect(fs.lstat(untitled.parentDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  await f.sandbox.saveProjectCopy(f.request());
  expect(await f.sandbox.projectCopyDefaults({ context: f.context, nameHint: "Ignored renderer hint" })).toEqual({ name: "Exact copy copy", parentDirectory: f.root });
  const lstat = vi.spyOn(fs, "lstat");
  await expect(f.sandbox.projectCopyDefaults({ context: { ...f.context, documentSessionId: "foreign" }, nameHint: "Ignored" })).rejects.toThrow("no longer current");
  expect(lstat).not.toHaveBeenCalled();
});
it("unclaimed residual facts keep the cause and choose-another-name in the first sentence", async () => {
  const f = await fixture(), warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = Object.assign(new Error("EACCES: denied. Raw path detail"), { code: "EACCES" });
  expect(f.sandbox.copyFailure(error, { creating: true, created: false }).message).toBe("Folder is read-only · Choose another name");
  expect(warn).toHaveBeenCalled();
  expect(f.sandbox.copyFailure(error, { creating: false, created: false })).toBe(error);
});
it("guards transition retirement after home setup before child creation", async () => {
  const f = await fixture(), request = f.request();
  f.sandbox.ensureProjectsHomeForRequest = async () => { f.persistence.endTransition(request.transition); };
  await expect(f.sandbox.saveProjectCopy(request)).rejects.toThrow();
  await expect(fs.lstat(path.join(f.root, "Exact copy"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.persistence.getSession().latestSource).toBeUndefined();
});
it("keeps source success sticky when automatic BDX fails", async () => {
  const f = await fixture();
  f.sandbox.exportSaved = async () => { throw new Error("Injected BDX boundary failure"); };
  expect(await f.sandbox.saveProjectCopy(f.request())).toMatchObject({ saved: true, exportError: expect.stringContaining("Injected BDX") });
  expect(f.persistence.getSession().latestSource).toBeDefined();
  expect((await openProjectFolder(path.join(f.root, "Exact copy"))).project).toBeTruthy();
  expect(f.context.targetGeneration).toBe(2);
});
it("keeps a confirmed early claim retryable after a later admission fault", async () => {
  const f = await fixture(), request = f.request(), real = f.persistence.assertDestination.bind(f.persistence);
  const fault = vi.spyOn(f.persistence, "assertDestination").mockRejectedValueOnce(new Error("Injected post-claim admission failure"));
  await expect(f.sandbox.saveProjectCopy(request)).rejects.toThrow("Injected post-claim");
  const folder = path.join(f.root, "Exact copy"), owner = await f.persistence.pendingDestinationFor(folder);
  expect(owner).not.toBeNull(); expect(await fs.readdir(folder)).toEqual([]);
  fault.mockImplementation(real);
  const claim = vi.spyOn(f.persistence, "claimCreatedDestination");
  expect(await f.sandbox.saveProjectCopy(request)).toMatchObject({ saved: true });
  expect(claim).not.toHaveBeenCalled(); expect(await f.persistence.pendingDestinationFor(folder)).toBeNull();
});

async function fileTree(folder: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const visit = async (directory: string, prefix = "") => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name, filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename, relative + "/");
      else files[relative] = (await fs.readFile(filename)).toString("base64");
    }
  };
  await visit(folder); return files;
}

it("copies an admitted existing folder into a sibling while preserving every original byte and excluding unmanaged files", async () => {
  const f = await fixture(), original = path.join(f.root, "Original");
  await fs.mkdir(original);
  const initial = createDemoProject(); initial.paths[0].name = "Last saved path"; initial.routines[0].name = "Last saved routine";
  await autosaveProjectFolder(original, initial, projectWorkspacePath(original));
  await fs.writeFile(path.join(original, "README.md"), "Unmanaged original README\n");
  await fs.mkdir(path.join(original, ".git")); await fs.writeFile(path.join(original, ".git", "HEAD"), "ref: refs/heads/example\n");
  const authored = await f.openSource(original);
  expect(f.persistence.sourceRoot(f.context)?.folderPath).toBe(original);
  const before = await fileTree(original), entryContext = { ...f.context };
  expect(Object.keys(before)).toEqual(expect.arrayContaining([".bordeaux-workspace.json", "README.md", ".git/HEAD"]));
  expect(Object.keys(before).some(file => /^Paths\/.+\.path$/.test(file))).toBe(true);
  expect(Object.keys(before).some(file => /^Routines\/.+\.routine$/.test(file))).toBe(true);
  authored.paths[0].name = "Current authored path"; authored.routines[0].name = "Current authored routine";
  const destination = path.join(f.root, "Sibling copy");
  expect(await f.sandbox.saveProjectCopy(f.request({ project: authored, copyTo: { name: "Sibling copy", parentDirectory: f.root } }))).toMatchObject({ saved: true, location: { folderPath: destination } });
  expect(await fileTree(original)).toEqual(before);
  const copied = await fileTree(destination), saved = (await openProjectFolder(destination)).project!;
  expect(Object.keys(copied).length).toBeGreaterThan(2);
  expect(Object.keys(copied).every(file => file === ".bordeaux-workspace.json" || /^Paths\/.+\.path$/.test(file) || /^Routines\/.+\.routine$/.test(file))).toBe(true);
  expect(canonicalProjectDigest(saved)).toBe(canonicalProjectDigest({ ...authored, name: "Sibling copy" }));
  expect(saved.paths[0].name).toBe("Current authored path"); expect(saved.routines[0].name).toBe("Current authored routine");
  expect(Object.keys(copied).some(file => /^Paths\/.+\.path$/.test(file) && copied[file] !== before[file])).toBe(true);
  expect(f.context.documentSessionId).toBe(entryContext.documentSessionId); expect(f.context.targetGeneration).toBe(entryContext.targetGeneration + 1);
  const recovery = await f.recovery.readSnapshot(f.persistence.getSession().recoveryRecordId);
  expect(recovery.project).toEqual(authored); expect(recovery.origin).toMatchObject({ kind: "folder", folderPath: original });
});

it.each(["legacy", "recovered-folder", "recovered-legacy"] as const)("main defaults use actual %s provenance and remain read-only", async kind => {
  const f = await fixture(), original = path.join(f.root, "Original"); await fs.mkdir(original);
  const initial = createDemoProject(); initial.name = "Stored display name";
  const legacy = kind !== "recovered-folder", filename = path.join(original, "Legacy.bordeaux.json");
  if (legacy) await writeProject(filename, initial);
  else await autosaveProjectFolder(original, initial, projectWorkspacePath(original));
  const authored = await f.openSource(legacy ? filename : original);
  if (kind !== "legacy") {
    authored.paths[0].name = "Kept authored edit";
    const restored = await f.restoreKept(authored);
    expect(restored.project).toEqual(authored);
    expect(f.persistence.getSession().location).toEqual({ folderPath: null, projectPath: null });
    expect(f.persistence.getSession().recoveredFrom?.origin).toMatchObject({ kind: legacy ? "legacy" : "folder", folderPath: original });
  } else {
    expect(f.persistence.getSession().location.legacyFile).toBe(filename);
    expect(f.persistence.sourceRoot(f.context)?.folderPath).toBe(original);
  }
  const before = await fileTree(f.root), mkdir = vi.spyOn(fs, "mkdir");
  expect(await f.sandbox.projectCopyDefaults({ context: f.context, nameHint: "Current authored display" })).toEqual({
    name: "Current authored display copy", parentDirectory: legacy ? original : f.root,
  });
  expect(mkdir).not.toHaveBeenCalled(); expect(await fileTree(f.root)).toEqual(before);
  await expect(fs.lstat(path.join(f.root, "home"))).rejects.toMatchObject({ code: "ENOENT" });
  if (kind !== "legacy") {
    // The restored session's actual recovery provenance excludes its origin before mkdir or source writing.
    await expect(f.sandbox.saveProjectCopy(f.request({ project: authored, copyTo: { name: "Original", parentDirectory: f.root } }))).rejects.toThrow("Recovered edits must be saved into a different folder");
    expect(mkdir).not.toHaveBeenCalled(); expect(await fileTree(f.root)).toEqual(before);
    expect(f.persistence.getSession().latestSource).toBeUndefined();
    expect(f.persistence.getSession().recoveredFrom).toBeDefined();
  }
});
