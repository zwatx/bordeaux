import { loadProjectSelection } from "../src/electron/projectOpening";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectSourcePersistence } from "../src/electron/projectSourcePersistence";
import { createDemoProject } from "../src/shared/project/defaults";
import { absentProjectSource, ownProjectSource, autosaveProjectFolder, openProjectFolder, projectWorkspacePath, readProject } from "../src/electron/projectFiles";
import { projectFolderIdentity } from "../src/electron/projectFolderIdentity";
import type { ProjectDurabilityContext } from "../src/shared/project/projectDurability";

const directories: string[] = [];
async function folder() { const value = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-source-lease-"))); directories.push(value); return value; }
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await Promise.all(directories.splice(0).map(value => fs.rm(value, { recursive: true, force: true }))); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const context = (): ProjectDurabilityContext => ({ windowEpoch: "window", documentSessionId: "document", targetGeneration: 1 });

describe("captured source persistence authority", () => {
  it("blocks an ancestor alias during a timed-out real source rename and admits a newer save only after settlement", async () => {
    vi.useFakeTimers(); const root = await folder(), parent = path.join(root, "real"), aliasParent = path.join(root, "alias");
    await fs.mkdir(parent); await fs.symlink(parent, aliasParent, process.platform === "win32" ? "junction" : "dir");
    const real = path.join(parent, "Autos"), alias = path.join(aliasParent, "Autos"); await fs.mkdir(real); const owner = absentProjectSource(await projectFolderIdentity(real));
    const entered = deferred(), release = deferred(), rename = fs.rename.bind(fs); let first = true, current = context();
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === projectWorkspacePath(real) && first) { first = false; entered.resolve(); await release.promise; }
      return rename(from, to);
    });
    const commits: string[] = [], source = new ProjectSourcePersistence({ getContext: () => current, commit: (_capture, project, target) => {
      commits.push(project.paths[0].name); current = { ...current, targetGeneration: current.targetGeneration + 1 };
      return { context: current, location: { folderPath: path.dirname(target), projectPath: target } };
    } });
    const a = createDemoProject(); a.paths[0].name = "Old A";
    const pending = source.persist(source.capture(a, current, 1), { folderPath: real, projectPath: projectWorkspacePath(real), createProject: true, sourceOwner: owner }, 20);
    const failed = expect(pending).rejects.toMatchObject({ code: "PROJECT_SOURCE_TIMED_OUT" }); await entered.promise;
    await vi.advanceTimersByTimeAsync(21); await failed;
    expect(await source.isBusy(alias)).toBe(true); await expect(source.assertReadable(alias)).rejects.toMatchObject({ code: "PROJECT_SOURCE_BUSY" });
    await expect(source.holdExport(alias)).rejects.toMatchObject({ code: "PROJECT_SOURCE_BUSY" });
    const b = createDemoProject(); b.paths[0].name = "New B";
    await expect(source.persist(source.capture(b, current, 2), { folderPath: alias, projectPath: projectWorkspacePath(alias), createProject: true, sourceOwner: owner })).rejects.toMatchObject({ code: "PROJECT_SOURCE_BUSY" });
    release.resolve(); await source.whenSettled(alias); expect(commits).toEqual([]);
    const saved = await source.persist(source.capture(b, current, 3), { folderPath: alias, projectPath: projectWorkspacePath(alias), createProject: true, sourceOwner: owner });
    expect(saved.location.folderPath).toBe(real); expect(commits).toEqual(["New B"]);
    expect((await openProjectFolder(alias)).project?.paths[0].name).toBe("New B");
    const endExport = await source.holdExport(real); expect(await source.isBusy(alias)).toBe(true);
    await expect(source.assertReadable(alias)).rejects.toMatchObject({ code: "PROJECT_SOURCE_BUSY" });
    const proof = await source.confirmSaved(source.capture(saved.project, current, 4), { ...saved, location: { folderPath: alias, projectPath: projectWorkspacePath(alias) } });
    expect(proof.location.folderPath).toBe(real); endExport();
  });

  it("fences delayed physical identity resolution before it can enter source I/O", async () => {
    vi.useFakeTimers(); const directory = await folder(), entered = deferred(), release = deferred(), finished = deferred(), resolve = fs.realpath.bind(fs);
    const owner = absentProjectSource(await projectFolderIdentity(directory));
    vi.spyOn(fs, "realpath").mockImplementation(async (...args: any[]) => {
      const result = await (resolve as any)(...args); entered.resolve(); await release.promise; finished.resolve(); return result;
    });
    let writes = 0, commits = 0; const current = context(), source = new ProjectSourcePersistence({ getContext: () => current,
      write: async () => { writes++; throw new Error("Expired resolution entered I/O"); }, commit: () => { commits++; throw new Error("Expired resolution committed"); } });
    const capture = source.capture(createDemoProject(), current, 1), pending = source.persist(capture, { folderPath: directory, projectPath: null, sourceOwner: owner }, 20);
    const failed = expect(pending).rejects.toMatchObject({ code: "PROJECT_SOURCE_TIMED_OUT" }); await entered.promise;
    await vi.advanceTimersByTimeAsync(21); await failed; expect(capture.valid).toBe(false);
    release.resolve(); await finished.promise; await Promise.resolve(); expect(writes).toBe(0); expect(commits).toBe(0); expect(source.pendingWrites()).toEqual([]);
  });
  it("fences a timed-out old autosave before returning, retains one physical owner and permits Save As elsewhere", async () => {
    vi.useFakeTimers(); const oldFolder = await folder(), copyFolder = await folder(), gate = deferred(), started = deferred(); let current = context();
    const owner = absentProjectSource(await projectFolderIdentity(oldFolder)), copyOwner = absentProjectSource(await projectFolderIdentity(copyFolder));
    const commits: string[] = [], source = new ProjectSourcePersistence({
      getContext: () => current,
      write: async (target, project, projectPath, options) => { if (target === oldFolder) { started.resolve(); await gate.promise; } return autosaveProjectFolder(target, project, projectPath, options); },
      commit: (_lease, _project, target) => { commits.push(target); current = { ...current, targetGeneration: current.targetGeneration + 1 }; return { context: current, location: { folderPath: path.dirname(target), projectPath: target } }; },
    });
    const old = source.capture(createDemoProject(), current, 1);
    const pending = source.persist(old, { folderPath: oldFolder, projectPath: null, sourceOwner: owner }, 20);
    const rejected = expect(pending).rejects.toMatchObject({ code: "PROJECT_SOURCE_TIMED_OUT" });
    await started.promise;
    await vi.advanceTimersByTimeAsync(21); await rejected; expect(old.valid).toBe(false);
    expect(await source.isBusy(oldFolder)).toBe(true);
    await expect(source.persist(source.capture(createDemoProject(), current, 2), { folderPath: oldFolder, projectPath: null, sourceOwner: owner })).rejects.toMatchObject({ code: "PROJECT_SOURCE_BUSY" });
    const copied = await source.persist(source.capture(createDemoProject(), current, 3), { folderPath: copyFolder, projectPath: null, sourceOwner: copyOwner });
    expect(copied.location.projectPath).toBe(projectWorkspacePath(copyFolder));
    gate.resolve(); await source.whenSettled(oldFolder);
    expect(commits).toEqual([projectWorkspacePath(copyFolder)]); expect(current.targetGeneration).toBe(2);
    expect((await openProjectFolder(oldFolder)).project).toBeNull();
  });

  it("allows started physical I/O to finish only at its captured folder after a new session retires authority", async () => {
    const a = await folder(), b = await folder(), started = deferred(), finish = deferred(); let current = context();
    const owner = absentProjectSource(await projectFolderIdentity(a));
    const commits: string[] = [], source = new ProjectSourcePersistence({ getContext: () => current,
      write: async (target, project, projectPath, options) => { options?.assertCurrent?.(); started.resolve(); await finish.promise; return autosaveProjectFolder(target, project, projectPath, { sourceOwner: options.sourceOwner }); },
      commit: (_lease, _project, target) => { commits.push(target); return { context: current, location: { folderPath: a, projectPath: target } }; },
    });
    const capture = source.capture(createDemoProject(), current, 1), pending = source.persist(capture, { folderPath: a, projectPath: null, sourceOwner: owner });
    const rejected = expect(pending).rejects.toMatchObject({ code: "PROJECT_SOURCE_SUPERSEDED" });
    await started.promise; current = { ...current, documentSessionId: "replacement", targetGeneration: 2 }; source.retire();
    await rejected; finish.resolve(); await source.whenSettled(a);
    expect(commits).toEqual([]); expect((await openProjectFolder(a)).project).not.toBeNull(); expect((await openProjectFolder(b)).project).toBeNull();
  });

  it("captures immutable source before await and returns the canonical saved name/context", async () => {
    const directory = await folder(); let current = context();
    const owner = absentProjectSource(await projectFolderIdentity(directory));
    const source = new ProjectSourcePersistence({ getContext: () => current, commit: (_lease, _project, target) => {
      current = { ...current, targetGeneration: 2 }; return { context: current, location: { folderPath: directory, projectPath: target } };
    } });
    const project = createDemoProject(), capture = source.capture(project, current, 4), pending = source.persist(capture, { folderPath: directory, projectPath: null, sourceOwner: owner });
    project.paths[0].name = "Late caller edit";
    const saved = await pending;
    expect(saved.project.name).toBe(path.basename(directory)); expect(saved.project.paths[0].name).toBe("NewPath");
    expect(saved.context.documentSessionId).toBe("document"); expect(saved.context.targetGeneration).toBe(2);
    expect((await openProjectFolder(directory)).project?.paths[0].name).toBe("NewPath");
  });

  it("checks a revoked lease at actual folder queue entry before source, legacy or mirror effects", async () => {
    vi.useFakeTimers(); const directory = await folder(), legacy = path.join(directory, "Autos.bordeaux"), project = createDemoProject();
    await fs.writeFile(legacy, JSON.stringify(project)); await readProject(legacy);
    const owner = ownProjectSource((await loadProjectSelection(legacy)).sourceEvidence);
    const entered = deferred(), release = deferred(), rename = fs.rename.bind(fs); let first = true;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === projectWorkspacePath(directory) && first) { first = false; entered.resolve(); await release.promise; }
      return rename(from, to);
    });
    const prior = autosaveProjectFolder(directory, project, legacy, { legacyFile: legacy }); await entered.promise;
    const admitted = deferred();
    const commits: string[] = [], current = context(), source = new ProjectSourcePersistence({ getContext: () => current,
      write: (folder, project, target, options) => { const writing = autosaveProjectFolder(folder, project, target, options); admitted.resolve(); return writing; },
      commit: (_capture, _project, target) => { commits.push(target); return { context: current, location: { folderPath: directory, projectPath: target } }; } });
    const queued = structuredClone(project); queued.paths[0].name = "Queued write"; queued.paths[0].waypoints[0].x += 1;
    const pending = source.persist(source.capture(queued, current, 2), { folderPath: directory, projectPath: legacy, legacyFile: legacy, sourceOwner: owner }, 20);
    const failed = expect(pending).rejects.toMatchObject({ code: "PROJECT_SOURCE_TIMED_OUT" });
    await admitted.promise;
    await vi.advanceTimersByTimeAsync(21); await failed; expect(await source.isBusy(directory)).toBe(true);
    release.resolve(); await prior; await source.whenSettled(directory);
    expect(commits).toEqual([]);
    const opened = await openProjectFolder(directory); expect(opened.project?.paths[0].name).toBe("NewPath"); expect(opened.project?.paths[0].waypoints[0].x).toBe(project.paths[0].waypoints[0].x);
    expect(await fs.readdir(path.join(directory, "Paths"))).not.toContain("Queued write.path");
    expect(spy.mock.calls.filter(([, target]) => String(target) === projectWorkspacePath(directory))).toHaveLength(2);
  });

  it("never confirms an old saved source while an expired physical source write can still change it", async () => {
    vi.useFakeTimers(); const directory = await folder(), gate = deferred(), started = deferred(); let delay = false;
    const owner = absentProjectSource(await projectFolderIdentity(directory));
    const current = context(), source = new ProjectSourcePersistence({ getContext: () => current,
      write: async (target, project, projectPath, options) => {
        options.assertCurrent(); if (delay) { started.resolve(); await gate.promise; }
        return autosaveProjectFolder(target, project, projectPath, { sourceOwner: options.sourceOwner });
      }, commit: (_capture, _project, target) => ({ context: current, location: { folderPath: directory, projectPath: target } }) });
    const original = createDemoProject(), saved = await source.persist(source.capture(original, current, 1), { folderPath: directory, projectPath: null, sourceOwner: owner });
    delay = true; const changed = structuredClone(original); changed.paths[0].name = "Still physically writing";
    const pending = source.persist(source.capture(changed, current, 2), { folderPath: directory, projectPath: saved.location.projectPath, sourceOwner: owner }, 20);
    const expired = expect(pending).rejects.toMatchObject({ code: "PROJECT_SOURCE_TIMED_OUT" }); await started.promise;
    await vi.advanceTimersByTimeAsync(21); await expired;
    const proof = source.capture(original, current, 3);
    await expect(source.confirmSaved(proof, saved)).rejects.toMatchObject({ code: "PROJECT_SOURCE_BUSY" }); source.revoke(proof);
    gate.resolve(); await source.whenSettled(directory);
    expect((await openProjectFolder(directory)).project?.paths[0].name).toBe("Still physically writing");
  });

  it("bounds canonical source confirmation and fences its late physical read", async () => {
    vi.useFakeTimers(); const directory = await folder(), started = deferred(), release = deferred(), physicalRead = deferred(), current = context();
    const owner = absentProjectSource(await projectFolderIdentity(directory));
    let commits = 0;
    const source = new ProjectSourcePersistence({ getContext: () => current, commit: (_capture, _project, target) => {
      commits++; return { context: current, location: { folderPath: directory, projectPath: target } };
    } });
    const project = createDemoProject(), saved = await source.persist(source.capture(project, current, 1), { folderPath: directory, projectPath: null, sourceOwner: owner });
    const read = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation(async (...args: any[]) => {
      const bytes = await (read as any)(...args); started.resolve(); await release.promise; physicalRead.resolve(); return bytes;
    });
    const capture = source.capture(project, current, 2), pending = source.confirmSaved(capture, saved, 20);
    const failed = expect(pending).rejects.toMatchObject({ code: "PROJECT_SOURCE_TIMED_OUT" }); await started.promise;
    await vi.advanceTimersByTimeAsync(21); await failed; expect(capture.valid).toBe(false);
    release.resolve(); await physicalRead.promise; await Promise.resolve(); expect(commits).toBe(1);
  });
});

it("retains the admitted source directory across saves and refuses a same-path replacement", async () => {
  const root = await folder(), active = path.join(root, "Active"), other = path.join(root, "Other"), copy = path.join(root, "Copy");
  await fs.mkdir(active); await fs.mkdir(other); await fs.mkdir(copy);
  const original = createDemoProject(), unrelated = createDemoProject(); original.paths[0].name = "A"; unrelated.paths[0].name = "B";
  await autosaveProjectFolder(active, original, null); await autosaveProjectFolder(other, unrelated, null);
  const owner = ownProjectSource((await loadProjectSelection(active)).sourceEvidence), copyOwner = absentProjectSource(await projectFolderIdentity(copy));
  const current = context(), source = new ProjectSourcePersistence({ getContext: () => current, commit: (_capture, _project, target) => ({ context: current, location: { folderPath: path.dirname(target), projectPath: target } }) });
  const first = await source.persist(source.capture(original, current, 1), { folderPath: active, projectPath: projectWorkspacePath(active), sourceOwner: owner });
  await fs.rename(active, path.join(root, "Archived")); await fs.rename(other, active);
  const next = { ...original, name: "Edited A" };
  await expect(source.persist(source.capture(next, current, 2), { folderPath: active, projectPath: projectWorkspacePath(active), folderIdentity: first.folderIdentity, sourceOwner: owner })).rejects.toThrow("folder changed");
  expect((await openProjectFolder(active)).project?.paths[0].name).toBe("B");
  await source.persist(source.capture(next, current, 3), { folderPath: copy, projectPath: null, sourceOwner: copyOwner });
  expect((await openProjectFolder(copy)).project?.paths[0].name).toBe("A");
});
