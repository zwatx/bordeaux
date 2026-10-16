import { loadProjectSelection } from "../src/electron/projectOpening";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectPersistence } from "../src/electron/projectPersistence";
import { ProjectSourcePersistence, canonicalProjectDigest } from "../src/electron/projectSourcePersistence";
import { ProjectRecoveryStore } from "../src/electron/projectRecoveryStore";
import { autosaveProjectFolder, openProjectFolder, projectWorkspacePath, writeProjectFolderBdx } from "../src/electron/projectFiles";
import { projectFolderIdentity } from "../src/electron/projectFolderIdentity";
import { ProjectBdxExport, projectBdxBudget } from "../src/electron/projectBdxExport";
import { createDemoProject } from "../src/shared/project/defaults";
import type { ProjectBdxExportScope } from "../src/electron/projectBdxExport";
import type { ProjectLocation } from "../src/shared/project/desktopProjects";
const roots: string[] = [];
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { force: true, recursive: true }))); });
async function fixture(short = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-bdx-life-"))); roots.push(root);
  const folder = path.join(root, "Autos"); await fs.mkdir(folder);
  let context = { windowEpoch: randomUUID(), documentSessionId: randomUUID(), targetGeneration: 1 };
  let location: ProjectLocation = { folderPath: folder, projectPath: null };
  let commits = 0, binding = "owner-A";
  const source = new ProjectSourcePersistence({ getContext: () => context, commit: (_capture, _project, target) => {
    commits++; if (location.projectPath !== target) context = { ...context, targetGeneration: context.targetGeneration + 1 };
    location = { folderPath: folder, projectPath: target }; return { context, location };
  } });
  const recovery = new ProjectRecoveryStore(path.join(root, "recovery"));
  const persistence = new ProjectPersistence({ source, recovery, getContext: () => context, getLocation: () => location, onUpdate: () => undefined,
    exportLimits: short ? { overallMs: 1_000, phaseMs: 100, batchMs: 200 } : undefined });
  persistence.admitSource(context, (await loadProjectSelection(folder)).sourceEvidence);
  const project = createDemoProject();
  const checkpoint = (value = project) => persistence.checkpoint({ project: value, context, snapshotRevision: 1 });
  const save = (action: (scope: ProjectBdxExportScope) => Promise<void>, value = project) => {
    const request = { project: value, context, snapshotRevision: 1 };
    return persistence.saveWithExport(request, { folderPath: folder, projectPath: location.projectPath }, persistence.captureRequest(request), async (saved, scope) => {
      await action(scope); return { saved: true as const, location: saved.location, bdxCount: 1 };
    }, () => { const owner = binding; return { key: owner, isCurrent: () => binding === owner }; });
  };
  return { root, folder, source, persistence, recovery, project, save, checkpoint, get location() { return location; }, get context() { return context; }, get commits() { return commits; },
    changeBinding() { binding = "owner-B"; source.revalidateExports(); }, replace() { context = { ...context, documentSessionId: randomUUID() }; persistence.contextChanged(true); } };
}

describe("bounded full Save BDX lifecycle", () => {
  it("joins an exact repeated Save only after its own actual source/recovery confirmation", async () => {
    const f = await fixture(), entered = gate(), release = gate(); let calls = 0;
    const first = f.save(async scope => { calls++; scope.enterPhase("build"); entered.resolve(); await release.promise; scope.assertCurrent(); });
    await entered.promise;
    const proof = await f.checkpoint(); expect(proof.source).toBe("saved"); expect(proof.recovery).toBe("saved");
    const previous = f.persistence.getSession().latestSource!.operationId;
    const joined = gate(), exportSaved = f.source.exportSaved.bind(f.source);
    vi.spyOn(f.source, "exportSaved").mockImplementation((...args) => {
      const result = exportSaved(...args); joined.resolve(); return result;
    });
    const second = f.save(async () => { calls++; });
    await joined.promise; // Source receipt publication precedes resolution metadata and actual export admission.
    expect(f.persistence.getSession().latestSource!.operationId).not.toBe(previous);
    release.resolve(); expect(await first).toEqual(await second); expect(calls).toBe(1); expect(f.commits).toBe(1);
    await f.source.whenExportsSettled(); expect(await f.source.isBusy(f.folder)).toBe(false);
  });
  it.each(["bindings", "build", "revalidate", "write"] as const)("bounds hung %s while retaining the physical owner and preventing late effects", async phase => {
    const f = await fixture(true); vi.useFakeTimers(); const entered = gate(), release = gate(); let effects = 0; let signal!: AbortSignal;
    const pending = f.save(async scope => { scope.enterPhase(phase); signal = scope.signal; entered.resolve(); await release.promise; scope.assertCurrent(); effects++; });
    await entered.promise; await vi.advanceTimersByTimeAsync(201);
    expect(await pending).toMatchObject({ saved: true, exportDetails: { code: "timed-out", partial: false } }); expect(signal.aborted).toBe(true);
    expect(await f.source.isBusy(f.folder)).toBe(true); expect((await f.checkpoint()).source).toBe("saved");
    expect(await f.save(async () => { effects++; })).toMatchObject({ saved: true, exportDetails: { code: "busy", blockingExportId: expect.any(String) } });
    const newer = structuredClone(f.project); newer.paths[0].name = "New edits";
    expect(await f.checkpoint(newer)).toMatchObject({ source: "failed", recovery: "saved" });
    expect((await f.recovery.readSnapshot(f.persistence.getSession().recoveryRecordId)).project.paths[0].name).toBe("New edits");
    release.resolve(); await f.source.whenExportsSettled(); expect(effects).toBe(0); expect(await f.source.isBusy(f.folder)).toBe(false);
  });
  it.each(["context", "binding"])("fences %s replacement before result, without releasing unresolved work", async kind => {
    const f = await fixture(), entered = gate(), release = gate(); let effects = 0;
    const pending = f.save(async scope => { entered.resolve(); await release.promise; scope.assertCurrent(); effects++; }); await entered.promise;
    if (kind === "context") f.replace(); else f.changeBinding();
    expect(await pending).toMatchObject({ saved: true, location: { folderPath: f.folder }, exportDetails: { code: "changed" } });
    expect(await f.source.isBusy(f.folder)).toBe(true); release.resolve(); await f.source.whenExportsSettled(); expect(effects).toBe(0);
  });
  it("reserves the process-wide cap before asynchronous admission, including residual operations", async () => {
    const fixtures = await Promise.all(Array.from({ length: 5 }, () => fixture())), releases = fixtures.map(() => gate());
    for (const f of fixtures) expect((await f.checkpoint()).source).toBe("saved");
    const entered = fixtures.map(() => gate());
    const jobs = fixtures.slice(0, 4).map((f, index) => f.save(async scope => { scope.enterPhase("build"); entered[index].resolve(); await releases[index].promise; }));
    await Promise.all(entered.slice(0, 4).map(value => value.promise));
    expect(await fixtures[4].save(async () => { throw new Error("must not start"); })).toMatchObject({ saved: true, exportDetails: { code: "limit" } });
    releases.slice(0, 4).forEach(value => value.resolve()); await Promise.all(jobs); await Promise.all(fixtures.map(f => f.source.whenExportsSettled()));
  });
  it("counts all four unresolved admissions before their first await and retains those reservations after timeout", async () => {
    const fixtures = await Promise.all(Array.from({ length: 5 }, () => fixture()));
    for (const f of fixtures) await f.checkpoint();
    const identities = await Promise.all(fixtures.map(f => projectFolderIdentity(f.folder))), entered = gate(), release = gate();
    let admissions = 0, calls = 0; const original = fs.realpath.bind(fs);
    vi.spyOn(fs, "realpath").mockImplementation(async (...args: any[]) => {
      const value = await (original as any)(...args);
      if (fixtures.slice(0, 4).some(f => f.folder === String(args[0]))) { if (++admissions === 4) entered.resolve(); await release.promise; }
      return value;
    });
    vi.useFakeTimers();
    const start = (index: number) => { const f = fixtures[index]; return f.source.exportSaved({ folderIdentity: identities[index], context: f.context, location: f.location, digest: f.persistence.getSession().latestSource!.digest }, 1,
      { key: "owner", isCurrent: () => true }, async () => { calls++; return { saved: true, location: f.location }; }, { phaseMs: 50 }); };
    const jobs = [0, 1, 2, 3].map(start); expect(await start(4)).toMatchObject({ exportDetails: { code: "limit" } });
    await entered.promise; await vi.advanceTimersByTimeAsync(51); expect((await Promise.all(jobs)).every(value => "exportDetails" in value && value.exportDetails?.code === "timed-out")).toBe(true);
    expect(await start(4)).toMatchObject({ exportDetails: { code: "limit" } });
    release.resolve(); await Promise.all(fixtures.map(f => f.source.whenExportsSettled())); expect(calls).toBe(0);
    expect(await start(4)).toMatchObject({ saved: true }); await fixtures[4].source.whenExportsSettled(); expect(calls).toBe(1);
  });
  it("holds ancestor aliases through logical timeout until physical settlement", async () => {
    const f = await fixture(true); await fs.symlink(f.root, path.join(f.root, "alias")); const alias = path.join(f.root, "alias", "Autos");
    const entered = gate(), release = gate(); vi.useFakeTimers();
    const pending = f.save(async scope => { entered.resolve(); await release.promise; scope.assertCurrent(); }); await entered.promise;
    await vi.advanceTimersByTimeAsync(101); expect(await pending).toMatchObject({ saved: true, exportDetails: { code: "timed-out" } });
    expect(await f.source.isBusy(alias)).toBe(true); release.resolve(); await f.source.whenExportsSettled(); expect(await f.source.isBusy(alias)).toBe(false);
  });
  it("guards monotonic deadlines even when the timer callback has not run", async () => {
    const f = await fixture(), identity = await projectFolderIdentity(f.folder); let now = 0;
    const lease = new ProjectBdxExport(identity, "d", f.location, 0, () => true, { now: () => now, overallMs: 100, phaseMs: 50 }); now = 51;
    expect(() => lease.assertCurrent()).toThrow("in time"); expect(lease.signal.aborted).toBe(true);
    expect(await lease.result).toMatchObject({ saved: true, exportDetails: { code: "timed-out" } });
    expect([projectBdxBudget(0), projectBdxBudget(65), projectBdxBudget(1000)]).toEqual([60000, 160000, 300000]);
  });
  it("fences hung identity admission before completion authority and keeps its cap slot", async () => {
    const f = await fixture(); await f.checkpoint(); const entered = gate(), release = gate(); let pause = false;
    const original = fs.realpath.bind(fs);
    vi.spyOn(fs, "realpath").mockImplementation(async (...args: any[]) => {
      const result = await (original as any)(...args); if (pause && String(args[0]) === f.folder) { pause = false; entered.resolve(); await release.promise; } return result;
    });
    const saved = f.persistence.getSession(); const identity = await projectFolderIdentity(f.folder); vi.useFakeTimers(); pause = true; let calls = 0;
    const pending = f.source.exportSaved({ folderIdentity: identity, context: f.context, location: f.location, digest: saved.latestSource!.digest }, 1, { key: "owner", isCurrent: () => true }, async () => { calls++; return { saved: true, location: f.location }; }, { phaseMs: 50 });
    await entered.promise; await vi.advanceTimersByTimeAsync(51); expect(await pending).toMatchObject({ saved: true, exportDetails: { code: "timed-out" } });
    expect(f.source.pendingWrites()).toHaveLength(1); release.resolve(); await f.source.whenExportsSettled(); expect(calls).toBe(0);
  });
});

describe("BDX writer publication guards", () => {
  it("rejects a new source winning the admission gap before any journal or BDX effect", async () => {
    const f = await fixture(); await f.checkpoint(); const identity = await projectFolderIdentity(f.folder), old = f.persistence.getSession().latestSource!.digest;
    const project = (await openProjectFolder(f.folder)).project!; project.paths[0].name = "New winner"; await autosaveProjectFolder(f.folder, project, f.location.projectPath);
    let effects = 0;
    await expect(writeProjectFolderBdx(f.folder, [{ fileName: "Fixture.bdx", bytes: new Uint8Array([1]) }], { folderIdentity: identity, expectedSourceDigest: old, onWriteStarted: () => effects++ })).rejects.toThrow("source changed");
    expect(effects).toBe(0); expect(await fs.readdir(path.join(f.folder, "Paths"))).not.toContain("Fixture.bdx");
    expect((await openProjectFolder(f.folder)).project?.paths[0].name).toBe("New winner");
  });
  it("compares the queued workspace digest after an older source write settles", async () => {
    const f = await fixture(); await f.checkpoint(); const old = f.persistence.getSession().latestSource!.digest, identity = await projectFolderIdentity(f.folder);
    const entered = gate(), release = gate(), original = fs.rename.bind(fs); let first = true;
    vi.spyOn(fs, "rename").mockImplementation(async (...args: any[]) => { if (first && String(args[1]) === projectWorkspacePath(f.folder)) { first = false; entered.resolve(); await release.promise; } return (original as any)(...args); });
    const newer = (await openProjectFolder(f.folder)).project!; newer.paths[0].name = "Queued winner";
    const source = autosaveProjectFolder(f.folder, newer, f.location.projectPath); await entered.promise; let effects = 0;
    const writer = writeProjectFolderBdx(f.folder, [{ fileName: "Fixture.bdx", bytes: new Uint8Array([1]) }], { folderIdentity: identity, expectedSourceDigest: old, onWriteStarted: () => effects++ });
    const rejected = expect(writer).rejects.toThrow("source changed"); release.resolve(); await source; await rejected;
    expect(effects).toBe(0); expect((await openProjectFolder(f.folder)).project?.paths[0].name).toBe("Queued winner");
  });
  it.each(["journal", "output"])("prevents %s publication after a paused temp write and cleans only its own temp", async kind => {
    const f = await fixture(); await f.checkpoint(); const entered = gate(), release = gate(), original = fs.writeFile.bind(fs); let valid = true, effects = 0;
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args: any[]) => {
      const value = await (original as any)(...args); if (String(args[0]).endsWith(".tmp") && (kind === "journal" ? path.dirname(String(args[0])) === f.folder : path.dirname(String(args[0])) === path.join(f.folder, "Paths"))) { entered.resolve(); await release.promise; } return value;
    });
    const before = await fs.readFile(projectWorkspacePath(f.folder), "utf8");
    const pending = writeProjectFolderBdx(f.folder, [{ fileName: "Fixture.bdx", bytes: new Uint8Array([1]) }], { assertCurrent: () => { if (!valid) throw new Error("fenced"); }, onWriteStarted: () => effects++ });
    const rejected = expect(pending).rejects.toThrow("fenced"); await entered.promise; valid = false; release.resolve(); await rejected;
    expect(effects).toBe(kind === "journal" ? 0 : 1);
    if (kind === "journal") expect(await fs.readFile(projectWorkspacePath(f.folder), "utf8")).toBe(before);
    expect((await fs.readdir(f.folder)).filter(file => file.endsWith(".tmp"))).toEqual([]);
    expect((await fs.readdir(path.join(f.folder, "Paths"))).filter(file => file.endsWith(".tmp") || file === "Fixture.bdx")).toEqual([]);
  });
  it("reports submitted writes as partial, prevents the next effect, and permits retry/zero-path cleanup", async () => {
    const f = await fixture(true), entered = gate(), release = gate(), original = fs.rename.bind(fs); let paused = false;
    vi.useFakeTimers();
    const pending = f.save(async scope => {
      scope.enterPhase("write");
      await writeProjectFolderBdx(scope.folderPath, [{ fileName: "Fixture.bdx", bytes: new Uint8Array([1, 2]) }], { folderIdentity: scope.folderIdentity, expectedSourceDigest: scope.expectedSourceDigest, assertCurrent: () => scope.assertCurrent(), onWriteStarted: () => scope.markWriteStarted() });
    });
    // Install before source reaches export; gate only the BDX journal publication, not source writes.
    vi.spyOn(fs, "rename").mockImplementation(async (...args: any[]) => {
      if (!paused && String(args[1]) === projectWorkspacePath(f.folder) && f.source.pendingWrites().some(value => value.phase === "export")) { paused = true; entered.resolve(); await release.promise; }
      return (original as any)(...args);
    });
    await entered.promise; await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toMatchObject({ saved: true, exportDetails: { code: "timed-out", partial: true } }); expect(await f.source.isBusy(f.folder)).toBe(true);
    release.resolve(); await f.source.whenExportsSettled(); vi.useRealTimers(); vi.restoreAllMocks();
    expect(await fs.readdir(path.join(f.folder, "Paths"))).not.toContain("Fixture.bdx");
    await writeProjectFolderBdx(f.folder, [{ fileName: "Fixture.bdx", bytes: new Uint8Array([1, 2]) }]);
    await writeProjectFolderBdx(f.folder, []); expect(await fs.readdir(path.join(f.folder, "Paths"))).not.toContain("Fixture.bdx");
    expect(canonicalProjectDigest((await openProjectFolder(f.folder)).project!)).toBe(f.persistence.getSession().latestSource!.digest);
  });
});
