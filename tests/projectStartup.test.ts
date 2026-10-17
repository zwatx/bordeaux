import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectStartup } from "../src/electron/projectStartup";
import { ProjectPersistence } from "../src/electron/projectPersistence";
import { ProjectSourcePersistence } from "../src/electron/projectSourcePersistence";
import { ProjectRecoveryStore } from "../src/electron/projectRecoveryStore";
import { ProjectRecoveryCatalog } from "../src/electron/projectRecoveryCatalog";
import { ownProjectSource, autosaveProjectFolder, projectWorkspacePath } from "../src/electron/projectFiles";
import { loadProjectSelection } from "../src/electron/projectOpening";
import { createDemoProject } from "../src/shared/project/defaults";
import { readRecentProjectFiles, recentProjectId, writeRecentProjectFiles } from "../src/electron/recentProjectFiles";
import type { ProjectDurabilityContext } from "../src/shared/project/projectDurability";
import type { ProjectLocation } from "../src/shared/project/desktopProjects";
import type { ProjectRecoveryListing, ProjectResumeDescriptor } from "../src/shared/project/projectPersistence";

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await Promise.all(directories.splice(0).map(value => fs.rm(value, { recursive: true, force: true }))); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(options: { timeoutMs?: number } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-startup-"))); directories.push(root);
  const sourceFolder = path.join(root, "source"); await fs.mkdir(sourceFolder);
  const legacy = path.join(sourceFolder, "Autos.bordeaux.json"), original = createDemoProject(); await fs.writeFile(legacy, JSON.stringify(original));
  const recentsFile = path.join(root, "recents.json"); await writeRecentProjectFiles(recentsFile, [legacy]);
  let context: ProjectDurabilityContext = { windowEpoch: randomUUID(), documentSessionId: randomUUID(), targetGeneration: 1 };
  let location: ProjectLocation = { folderPath: null, projectPath: null }, project = createDemoProject(), resume: ProjectResumeDescriptor | null = null;
  const remembered: string[] = [], recovery = new ProjectRecoveryStore(path.join(root, "recovery")), catalog = new ProjectRecoveryCatalog(path.join(root, "recovery"), recovery, () => undefined);
  const source = new ProjectSourcePersistence({ getContext: () => context, commit: () => { throw new Error("Startup cannot write source"); } });
  const persistence = new ProjectPersistence({ source, recovery, getContext: () => context, getLocation: () => location, onUpdate: () => undefined });
  const readSettled = deferred();
  const deps = { getSession: () => persistence.getSession(), isTransitionCurrent: persistence.isTransitionCurrent.bind(persistence), readRecents: () => readRecentProjectFiles(recentsFile),
    getResume: () => resume, listRecoveries: () => catalog.list(), assertReadable: async (selected: string) => source.assertReadable(path.dirname(selected)), timeoutMs: options.timeoutMs,
    activate: async (selected: string, assertCurrent: () => void, committed: () => void) => {
      let selection;
      try { selection = await loadProjectSelection(selected, { assertCurrent, requireSource: true }); assertCurrent(); } finally { readSettled.resolve(); }
      committed(); context = { ...context, documentSessionId: randomUUID(), targetGeneration: context.targetGeneration + 1 };
      location = { folderPath: selection.folderPath, projectPath: selection.projectPath, ...(selection.legacyFile ? { legacyFile: selection.legacyFile } : {}) }; project = selection.project;
      persistence.contextChanged(true); remembered.push(selection.recentPath);
      return { project, location, session: persistence.getSession() };
    },
  };
  const startup = new ProjectStartup(deps);
  const owner = () => { const transition = persistence.beginTransition(context); return { context: { ...context }, transition }; };
  return { root, sourceFolder, legacy, original, recentsFile, source, recovery, catalog, persistence, startup, deps, owner, remembered, readSettled,
    retainSource: () => { location = { folderPath: sourceFolder, projectPath: null, legacyFile: legacy }; project = structuredClone(original); },
    detach: (request: Parameters<ProjectStartup["detach"]>[0]) => startup.detach(request, () => {
      const previous = resume ?? { session: persistence.getSession(), pendingWrites: source.pendingWrites() }; resume = null;
      context = { ...context, documentSessionId: randomUUID(), targetGeneration: context.targetGeneration + 1 }; location = { folderPath: null, projectPath: null };
      project = createDemoProject(); project.paths[0].waypoints = []; persistence.contextChanged(true);
      return { session: persistence.getSession(), previous };
    }),
    setResume: (value: ProjectResumeDescriptor | null) => { resume = value; },
    reload: () => { context = { ...context, windowEpoch: randomUUID() }; persistence.contextChanged(); },
    get context() { return context; }, get project() { return project; }, get location() { return location; } };
}
describe("owned startup probe and adoption", () => {
  it("owns transition tokens and lifecycle readiness across document replacement and window retirement", async () => {
    const f = await fixture(), owner = f.owner();
    expect(f.persistence.getSession().lifecycleReady).toBe(false);
    expect(f.persistence.setLifecycleReady(owner.context, true)).toBe(true);
    expect(f.persistence.getTransitionId()).toBe(owner.transition.id);
    expect(() => f.persistence.beginTransition(f.context)).toThrow("already pending");
    expect(f.persistence.endTransition({ ...owner.transition, id: randomUUID() })).toBe(false);
    const preview = await f.startup.probe(owner); await f.startup.adopt(preview.startupId, owner.transition);
    expect(f.persistence.isTransitionCurrent(owner.transition)).toBe(true);
    expect(f.persistence.setLifecycleReady(owner.context, false)).toBe(false);
    f.reload(); expect(f.persistence.getTransitionId()).toBeNull(); expect(f.persistence.isLifecycleReady()).toBe(false);
    expect(f.persistence.endTransition(owner.transition)).toBe(false);
  });

  it.each(["EACCES", "ENOENT"])("reports a %s source preflight failure without calling it an invalid project", async code => {
    const f = await fixture(); vi.spyOn(f.deps, "assertReadable").mockRejectedValue(Object.assign(new Error("private fixture error"), { code }));
    const result = await f.startup.probe(f.owner());
    expect(result).toMatchObject({ status: "unavailable", reason: code === "EACCES" ? "unreadable" : "missing",
      recent: { id: recentProjectId(f.legacy), code: code === "EACCES" ? "not-readable" : "not-found" } });
    expect(JSON.stringify(result)).not.toContain("private fixture error");
  });

  it("probes readonly, adopts fresh source under the same transition, and never creates a Documents project", async () => {
    const f = await fixture(), owner = f.owner(), preview = await f.startup.probe(owner);
    expect(preview).toMatchObject({ status: "opened", needsAdoption: true, opened: { location: { legacyFile: f.legacy, projectPath: null } } });
    expect(f.location.folderPath).toBeNull(); expect(f.remembered).toEqual([]);
    const updated = structuredClone(f.original); updated.paths[0].name = "Changed after preview"; await fs.writeFile(f.legacy, JSON.stringify(updated));
    const adopted = await f.startup.adopt(preview.startupId, owner.transition);
    expect(adopted.project.paths[0].name).toBe("Changed after preview"); expect(adopted.session.context).toEqual(f.context);
    expect(f.persistence.isTransitionCurrent(owner.transition)).toBe(true); expect(f.persistence.endTransition(owner.transition)).toBe(true);
    expect(f.remembered).toEqual([f.legacy]); expect(await fs.readdir(f.root)).toEqual(expect.arrayContaining(["source", "recents.json"]));
    await expect(fs.lstat(path.join(f.root, "Documents"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("distinguishes none, failed recent and corrupt recents while preserving a stable failed-row ID", async () => {
    const f = await fixture(); await writeRecentProjectFiles(f.recentsFile, []);
    let owner = f.owner(); expect(await f.startup.probe(owner)).toMatchObject({ status: "none", resuming: false }); f.startup.cancel(owner.transition); f.persistence.endTransition(owner.transition);
    const missing = path.join(f.sourceFolder, "Missing.bordeaux"); await writeRecentProjectFiles(f.recentsFile, [missing]);
    owner = f.owner(); expect(await f.startup.probe(owner)).toMatchObject({ status: "unavailable", reason: "missing", recent: { id: recentProjectId(missing), status: "missing" } }); f.startup.cancel(owner.transition); f.persistence.endTransition(owner.transition);
    await fs.writeFile(f.recentsFile, "private corrupt payload"); owner = f.owner();
    const invalid = await f.startup.probe(owner); expect(invalid).toMatchObject({ status: "unavailable", reason: "recents-unavailable" }); expect(JSON.stringify(invalid)).not.toContain("private corrupt");
  });

  it("keeps whole-root recovery errors and limited enumeration honest, and refuses source reads during physical ownership", async () => {
    const f = await fixture();
    vi.spyOn(f.deps, "listRecoveries").mockRejectedValue(new Error("private filesystem detail"));
    let owner = f.owner(), outcome = await f.startup.probe(owner);
    expect(outcome.recoveries).toMatchObject({ error: { code: "storage-unavailable" }, entries: [], limited: false }); expect(JSON.stringify(outcome)).not.toContain("private filesystem detail");
    f.startup.cancel(owner.transition); f.persistence.endTransition(owner.transition);
    vi.spyOn(f.deps, "listRecoveries").mockResolvedValue({ entries: [], limited: true } satisfies ProjectRecoveryListing);
    const release = await f.source.holdExport(f.sourceFolder); owner = f.owner(); outcome = await f.startup.probe(owner);
    expect(outcome).toMatchObject({ status: "unavailable", reason: "source-busy", recoveries: { limited: true } }); expect(f.remembered).toEqual([]); release();
  });

  it("resumes the captured source rather than stale recents and keeps missing-source recoveries visible", async () => {
    const f = await fixture(), stored = await f.recovery.writeSnapshot({ recordId: randomUUID(), revision: 1, capturedAt: "2026-10-12T12:00:00.000Z", displayName: "Crash copy", reason: "checkpoint", origin: { kind: "untitled", id: randomUUID() }, project: f.original });
    const session = f.persistence.getSession(); session.location = { folderPath: f.sourceFolder, projectPath: null, legacyFile: f.legacy };
    f.setResume({ session, pendingWrites: [] }); await writeRecentProjectFiles(f.recentsFile, [path.join(f.root, "Wrong.bordeaux")]);
    let owner = f.owner(); expect(await f.startup.probe(owner)).toMatchObject({ status: "opened", resuming: true, opened: { location: { legacyFile: f.legacy } }, recoveries: { entries: [{ recordId: stored.recordId }] } });
    f.startup.cancel(owner.transition); f.persistence.endTransition(owner.transition); await fs.unlink(f.legacy);
    owner = f.owner(); expect(await f.startup.probe(owner)).toMatchObject({ status: "unavailable", reason: "missing", resuming: true, recoveries: { entries: [{ available: true }] } });
  });

  it("previews a valid captured resume without consulting a corrupt unrelated recent index", async () => {
    const f = await fixture(), session = f.persistence.getSession();
    session.location = { folderPath: f.sourceFolder, projectPath: null, legacyFile: f.legacy };
    f.setResume({ session, pendingWrites: [] }); await fs.writeFile(f.recentsFile, "corrupt recent index");
    const read = vi.spyOn(f.deps, "readRecents"), owner = f.owner();
    expect(await f.startup.probe(owner)).toMatchObject({ status: "opened", resuming: true, opened: { location: { legacyFile: f.legacy } } });
    expect(read).not.toHaveBeenCalled(); f.startup.cancel(owner.transition); f.persistence.endTransition(owner.transition);
  });

  it("refuses to adopt a preview folder whose source disappeared instead of activating a generated demo", async () => {
    const f = await fixture(); await writeRecentProjectFiles(f.recentsFile, [f.sourceFolder]);
    const owner = f.owner(), preview = await f.startup.probe(owner), session = f.persistence.getSession(), before = structuredClone(f.project);
    expect(preview.status).toBe("opened"); await fs.rm(f.sourceFolder, { recursive: true }); await fs.mkdir(f.sourceFolder);
    await expect(f.startup.adopt(preview.startupId, owner.transition)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.persistence.getSession()).toEqual(session); expect(f.project).toEqual(before); expect(f.remembered).toEqual([]);
    expect(await fs.readdir(f.sourceFolder)).toEqual([]);
  });

  it.each(["missing", "throw", "adoption-failed"])("detaches a retained target after %s before an authored blank checkpoint", async reason => {
    if (reason === "throw") vi.useFakeTimers();
    const f = await fixture({ timeoutMs: reason === "throw" ? 20 : undefined }); f.retainSource();
    const bytes = await fs.readFile(f.legacy), owner = f.owner(), before = f.persistence.getSession();
    if (reason === "missing") await writeRecentProjectFiles(f.recentsFile, [path.join(f.root, "Missing.bordeaux")]);
    if (reason === "throw") {
      const entered = deferred(); vi.spyOn(f.deps, "readRecents").mockImplementation(() => { entered.resolve(); return new Promise(() => undefined); });
      const probing = f.startup.probe(owner), failed = expect(probing).rejects.toThrow("in time"); await entered.promise;
      await vi.advanceTimersByTimeAsync(21); await failed;
    } else {
      const preview = await f.startup.probe(owner);
      if (reason === "adoption-failed") {
        expect(preview.status).toBe("opened"); vi.spyOn(f.deps, "activate").mockRejectedValue(Object.assign(new Error("Fixture denied source read"), { code: "EACCES" }));
        await expect(f.startup.adopt(preview.startupId, owner.transition)).rejects.toMatchObject({ code: "EACCES" });
      } else expect(preview).toMatchObject({ status: "unavailable", reason: "missing" });
    }
    const detached = f.detach(owner);
    expect(detached.previous?.session.location.legacyFile).toBe(f.legacy);
    expect(detached.session.location).toEqual({ folderPath: null, projectPath: null });
    expect(detached.session.context.documentSessionId).not.toBe(before.context.documentSessionId);
    expect(f.persistence.isTransitionCurrent(owner.transition)).toBe(true);
    const checkpoint = await f.persistence.checkpoint({ context: f.context, snapshotRevision: 1, project: f.project });
    expect(checkpoint).toMatchObject({ source: "unavailable", recovery: "saved" });
    expect(await fs.readFile(f.legacy)).toEqual(bytes); await expect(fs.lstat(projectWorkspacePath(f.sourceFolder))).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.remembered).toEqual([]); f.persistence.endTransition(owner.transition);
  });

  it("rejects stale detach owners and committed adoption before changing a retained source", async () => {
    const f = await fixture(); f.retainSource(); const owner = f.owner(), before = f.persistence.getSession();
    for (const request of [
      { ...owner, transition: { ...owner.transition, id: randomUUID() } },
      { ...owner, context: { ...owner.context, windowEpoch: randomUUID() } },
      { ...owner, context: { ...owner.context, documentSessionId: randomUUID() } },
      { ...owner, context: { ...owner.context, targetGeneration: owner.context.targetGeneration + 1 } },
    ]) expect(() => f.detach(request)).toThrow("no longer current");
    expect(f.persistence.getSession()).toEqual(before);
    const preview = await f.startup.probe(owner), committed = deferred(), release = deferred(), activate = f.deps.activate;
    vi.spyOn(f.deps, "activate").mockImplementation(async (...args) => { const opened = await activate(...args); committed.resolve(); await release.promise; return opened; });
    const adopting = f.startup.adopt(preview.startupId, owner.transition); await committed.promise;
    const active = f.persistence.getSession();
    expect(() => f.detach({ context: f.context, transition: owner.transition })).toThrow("already committed");
    expect(f.persistence.getSession()).toEqual(active); release.resolve(); await adopting;
  });

  it("returns prior recovery evidence without keeping it as the next crashed window's implicit source", async () => {
    const f = await fixture();
    await f.persistence.checkpoint({ context: f.context, snapshotRevision: 1, project: f.original }); f.retainSource();
    const previous = { session: f.persistence.getSession(), pendingWrites: [] }; f.setResume(previous);
    const owner = f.owner(); await f.startup.probe(owner); const detached = f.detach(owner);
    expect(detached.previous).toEqual(previous); expect(f.deps.getResume()).toBeNull();
    expect((await f.recovery.listSnapshots()).entries).toHaveLength(1); expect(detached.session.latestRecovery).toBeUndefined();
    const currentResume = { session: f.persistence.getSession(), pendingWrites: f.source.pendingWrites() };
    f.setResume(currentResume); f.reload();
    expect(await f.startup.probe(f.owner())).toMatchObject({ status: "none", resuming: true });
    expect((await f.recovery.listSnapshots()).entries).toHaveLength(1);
  });

  it("retains physical source ownership when startup blank detachment retires its logical lease", async () => {
    const f = await fixture(); f.retainSource(); const owner = f.owner(), selected = await loadProjectSelection(f.legacy);
    const entered = deferred(), release = deferred(), rename = fs.rename.bind(fs); let first = true;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === projectWorkspacePath(f.sourceFolder) && first) { first = false; entered.resolve(); await release.promise; }
      return rename(from, to);
    });
    const writing = f.source.persist(f.source.capture(selected.project, f.context, 1), { folderPath: f.sourceFolder, projectPath: selected.projectPath, legacyFile: selected.legacyFile, sourceOwner: ownProjectSource(selected.sourceEvidence) });
    const retired = expect(writing).rejects.toMatchObject({ code: "PROJECT_SOURCE_SUPERSEDED" }); await entered.promise;
    const detached = f.detach(owner); await retired;
    expect(detached.previous?.pendingWrites).toMatchObject([{ folderPath: f.sourceFolder, phase: "source" }]);
    expect(await f.source.isBusy(f.sourceFolder)).toBe(true); const active = f.persistence.getSession();
    release.resolve(); await f.source.whenSettled(f.sourceFolder);
    expect(f.persistence.getSession()).toEqual(active); expect(f.location.folderPath).toBeNull(); expect(f.remembered).toEqual([]);
  });

  it.each(["cancel", "timeout", "epoch"].flatMap(reason => ["bytes", "identity"].map(phase => [reason, phase])))("fences a late actual legacy re-read on %s during %s before provenance, activation or recents", async (reason, phase) => {
    vi.useFakeTimers(); const f = await fixture({ timeoutMs: 20 }), owner = f.owner(), preview = await f.startup.probe(owner), readStarted = deferred(), release = deferred();
    if (phase === "bytes") {
      const read = fs.readFile.bind(fs);
      vi.spyOn(fs, "readFile").mockImplementation(async (...args: any[]) => {
        const bytes = await (read as any)(...args);
        if (String(args[0]) === f.legacy) { readStarted.resolve(); await release.promise; }
        return bytes;
      });
    } else {
      const resolve = fs.realpath.bind(fs);
      vi.spyOn(fs, "realpath").mockImplementation(async (...args: any[]) => {
        const actual = await (resolve as any)(...args);
        if (String(args[0]) === f.sourceFolder) { readStarted.resolve(); await release.promise; }
        return actual;
      });
    }
    const adopted = f.startup.adopt(preview.startupId, owner.transition), rejected = expect(adopted).rejects.toThrow(/startup|time/);
    await readStarted.promise;
    if (reason === "cancel") { expect(f.startup.cancel(owner.transition)).toEqual({ cancelled: true }); f.persistence.endTransition(owner.transition); await rejected; }
    if (reason === "timeout") { await vi.advanceTimersByTimeAsync(21); await rejected; f.persistence.endTransition(owner.transition); }
    if (reason === "epoch") f.reload();
    f.project.paths[0].name = "Kept editing Untitled";
    release.resolve(); await f.readSettled.promise; await rejected;
    vi.restoreAllMocks();
    expect(f.project.paths[0].name).toBe("Kept editing Untitled"); expect(f.location).toEqual({ folderPath: null, projectPath: null }); expect(f.remembered).toEqual([]);
    const contents = await fs.readFile(f.legacy, "utf8"); await autosaveProjectFolder(f.sourceFolder, createDemoProject(), null);
    const workspace = projectWorkspacePath(f.sourceFolder), state = JSON.parse(await fs.readFile(workspace, "utf8"));
    state.importedFrom = { file: f.legacy, hash: createHash("sha256").update(contents).digest("hex") }; await fs.writeFile(workspace, JSON.stringify(state));
    await expect(autosaveProjectFolder(f.sourceFolder, f.original, null, { legacyFile: f.legacy })).rejects.toThrow("may hold newer work");
  });
});
