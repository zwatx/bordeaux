import { loadProjectSelection } from "../src/electron/projectOpening";
import fs from "node:fs/promises";
import os from "node:os";
import vm from "node:vm";
import ts from "typescript";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectDepartureCoordinator } from "../src/electron/projectDeparture";
import { ProjectRecoveryStore } from "../src/electron/projectRecoveryStore";
import { ProjectRecoveryCatalog } from "../src/electron/projectRecoveryCatalog";
import { ProjectPersistence } from "../src/electron/projectPersistence";
import { sameProjectContext, ProjectSourcePersistence } from "../src/electron/projectSourcePersistence";
import { projectFolderIdentity } from "../src/electron/projectFolderIdentity";
import { createDemoProject } from "../src/shared/project/defaults";
import type { ProjectLocation } from "../src/shared/project/desktopProjects";
const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture(options: { write?: ConstructorParameters<typeof ProjectSourcePersistence>[0]["write"] } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-resolution-"))); roots.push(root);
  const recovery = new ProjectRecoveryStore(path.join(root, "recovery"));
  let context = { windowEpoch: randomUUID(), documentSessionId: randomUUID(), targetGeneration: 1 };
  let location: ProjectLocation = { folderPath: null, projectPath: null };
  const source = new ProjectSourcePersistence({ getContext: () => context, write: options.write, commit: (_capture, _project, target) => {
    context = { ...context, targetGeneration: context.targetGeneration + 1 }; location = { folderPath: path.dirname(target), projectPath: target }; return { context, location };
  } });
  const persistence = new ProjectPersistence({ source, recovery, getContext: () => context, getLocation: () => location, onUpdate() {} });
  const catalog = new ProjectRecoveryCatalog(path.join(root, "recovery"), recovery, () => {});
  async function open(index: number) {
    const folderPath = path.join(root, `project-${index}`); await fs.mkdir(folderPath, { recursive: true });
    context = { ...context, documentSessionId: randomUUID(), targetGeneration: context.targetGeneration + 1 };
    location = { folderPath, projectPath: null }; persistence.contextChanged(true);
    persistence.admitSource(context, (await loadProjectSelection(folderPath)).sourceEvidence);
  }
  return { root, recovery, source, persistence, catalog, open, get context() { return context; }, get location() { return location; }, request: (project = createDemoProject()) => ({ context: { ...context }, snapshotRevision: 0, project }) };
}
describe("persistent recovery source resolution", () => {
  it.each([false, true])("resolves a migrated historical receipt only when the saved source is its exact editor copy (edited: %s)", async (edited) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = await fixture(); await f.open(0);
    const receipt = await f.recovery.writeSnapshot({ recordId: randomUUID(), revision: 1, capturedAt: new Date().toISOString(),
      displayName: 'Legacy recovered', reason: 'checkpoint', origin: { kind: 'untitled', id: randomUUID() }, project: createDemoProject() });
    const file = path.join(f.root, 'recovery', receipt.recordId + '.json');
    const historical = JSON.parse(await fs.readFile(file, 'utf8'));
    historical.project.field.coordinateSchemaId = 'bordeaux-field/1.0';
    historical.digest = createHash('sha256').update(JSON.stringify(historical.project, null, 2) + '\n').digest('hex');
    await fs.writeFile(file, JSON.stringify(historical));
    const prepared = await f.persistence.prepareRestore(f.context, receipt.recordId);
    expect(prepared.recoveredFrom.receipt.digest).toBe(historical.digest);
    expect(prepared.project.field?.coordinateSchemaId).toBe('wpilib-blue-origin/2026-welded/1');
    f.persistence.contextChanged(true, prepared.recoveredFrom);
    const destination = path.join(f.root, 'recovered-copy'); await fs.mkdir(destination);
    const project = structuredClone(prepared.project);
    if (edited) project.paths[0].name = 'Later edit';
    expect(await f.persistence.checkpoint(f.request(project), { folderPath: destination, projectPath: null })).toMatchObject({ source: 'saved' });
    const retained = await f.recovery.readSnapshot(receipt.recordId);
    expect(Boolean(retained.resolved)).toBe(!edited);
    expect(retained.receipt.digest).toBe(historical.digest);
    expect((await f.catalog.list()).entries).toHaveLength(edited ? 1 : 0);
  });

  it("retains a saved recovery on disk without offering it again in a fresh catalog", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); // Await actual metadata completion without racing its best-effort deadline.
    const f = await fixture(); await f.open(0);
    expect((await f.persistence.checkpoint(f.request())).source).toBe("saved");
    expect((await f.recovery.listSnapshots()).entries).toHaveLength(1);
    expect((await new ProjectRecoveryCatalog(path.join(f.root, "recovery"), new ProjectRecoveryStore(path.join(f.root, "recovery")), () => {}).list()).entries).toEqual([]);
  });
  it("forty clean sessions across three folders reuse at most three retained branches", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = await fixture();
    for (let index = 0; index < 40; index++) {
      await f.open(index % 3); const project = createDemoProject(); project.paths[0].name = `authored cycle ${index}`;
      expect(await f.persistence.checkpoint(f.request(project))).toMatchObject({ source: "saved", recovery: "saved" });
    }
    expect((await f.recovery.listSnapshots()).entries.length).toBeLessThanOrEqual(3);
    expect((await f.catalog.list()).entries).toEqual([]);
  }, 30_000); // Forty real filesystem transactions; the production deadline behavior is tested separately.
});
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function storedFixture() {
  const f = await fixture(); await f.open(0);
  const input = { recordId: randomUUID(), revision: 1, capturedAt: new Date().toISOString(), displayName: "retained", reason: "checkpoint",
    origin: { kind: "folder" as const, folderPath: f.location.folderPath! }, originIdentity: await projectFolderIdentity(f.location.folderPath!) as { folderPath: string; objectKey: string }, project: createDemoProject() };
  const mapping = (digest: string) => ({ digest, origin: input.origin, identity: input.originIdentity });
  return { ...f, input, mapping };
}
describe("exact resolution, physical reuse and branch leases", () => {
  it("retains v1 unresolved provenance and refuses stale resolution/deletion after a newer revision", async () => {
    const f = await storedFixture(), first = await f.recovery.writeSnapshot(f.input);
    expect((await f.recovery.readSnapshot(first.recordId)).resolved).toBeUndefined();
    expect(await f.recovery.markResolved(first, f.mapping("a".repeat(64)))).toBe(true);
    expect((await f.recovery.readSnapshot(first.recordId)).resolved?.sourceDigest).toBe("a".repeat(64));
    const second = await f.recovery.writeSnapshot({ ...f.input, revision: 2, project: { ...f.input.project, name: "New authored revision" } });
    expect(await f.recovery.markResolved(first, f.mapping(first.digest))).toBe(false);
    expect(await f.recovery.removeSnapshot(first)).toBe(false);
    expect((await f.recovery.readSnapshot(second.recordId)).resolved).toBeUndefined();
  });
  it("reuses only a retired resolved branch with higher stored revision, never an active or unresolved branch", async () => {
    const f = await storedFixture(), firstBranch = f.recovery.createBranch();
    const first = await f.recovery.writeSnapshot(f.input, firstBranch); await f.recovery.markResolved(first, f.mapping(first.digest));
    const otherBranch = f.recovery.createBranch(), second = await f.recovery.writeSnapshot({ ...f.input, recordId: randomUUID() }, otherBranch);
    expect(second.recordId).not.toBe(first.recordId); expect(await f.recovery.removeSnapshot(first)).toBe(false);
    f.recovery.releaseBranch(firstBranch); f.recovery.releaseBranch(otherBranch);
    const contenders = [f.recovery.createBranch(), f.recovery.createBranch()];
    const [a, b] = await Promise.all(contenders.map(branch => f.recovery.writeSnapshot({ ...f.input, recordId: randomUUID(), revision: 1 }, branch)));
    expect(a.recordId).toBe(first.recordId); expect(a.revision).toBe(first.revision + 1); expect(b.recordId).not.toBe(a.recordId); expect(b.recordId).not.toBe(second.recordId);
    expect((await f.recovery.readSnapshot(a.recordId)).resolved).toBeUndefined();
    await expect(f.recovery.writeSnapshot({ ...f.input, revision: 99 }, firstBranch)).rejects.toMatchObject({ code: "revision-conflict" });
    contenders.forEach(branch => f.recovery.releaseBranch(branch));
  });
  it("does not reuse a same-spelling recreated directory, but reuses an ancestor alias to the same physical folder", async () => {
    const f = await storedFixture(), first = await f.recovery.writeSnapshot(f.input); await f.recovery.markResolved(first, f.mapping(first.digest));
    const moved = f.location.folderPath! + "-old"; await fs.rename(f.location.folderPath!, moved); await fs.mkdir(f.location.folderPath!);
    const replacement = await projectFolderIdentity(f.location.folderPath!); expect(replacement.objectKey).not.toBe(f.input.originIdentity.objectKey);
    const branch = f.recovery.createBranch();
    const second = await f.recovery.writeSnapshot({ ...f.input, recordId: randomUUID(), originIdentity: replacement as typeof f.input.originIdentity }, branch);
    expect(second.recordId).not.toBe(first.recordId); f.recovery.releaseBranch(branch);
    const alias = path.join(f.root, "alias"); await fs.symlink(f.root, alias);
    const sameOld = await projectFolderIdentity(path.join(alias, path.basename(moved)));
    // Renaming the origin is not itself reuse authority: only the admitted canonical location is compared.
    await fs.rename(f.location.folderPath!, f.location.folderPath! + "-replacement"); await fs.rename(moved, f.location.folderPath!);
    const canonicalAlias = await projectFolderIdentity(path.join(alias, "project-0")); expect(canonicalAlias.objectKey).toBe(sameOld.objectKey);
    const reused = await f.recovery.writeSnapshot({ ...f.input, recordId: randomUUID(), originIdentity: canonicalAlias as typeof f.input.originIdentity }, f.recovery.createBranch());
    expect(reused.recordId).toBe(first.recordId);
  });
  it("never reuses a resolved slot from provenance alone or from a distinct legacy sibling", async () => {
    const f = await storedFixture(), first = await f.recovery.writeSnapshot(f.input); await f.recovery.markResolved(first, f.mapping(first.digest));
    const noAdmission = await f.recovery.writeSnapshot({ ...f.input, recordId: randomUUID(), originIdentity: undefined }, f.recovery.createBranch());
    expect(noAdmission.recordId).not.toBe(first.recordId);
    const legacyIdentity = { ...f.input.originIdentity, legacyFile: path.join(f.input.origin.folderPath, "Other.bordeaux") };
    const legacy = await f.recovery.writeSnapshot({ ...f.input, recordId: randomUUID(), originIdentity: legacyIdentity,
      origin: { ...f.input.origin, kind: "legacy", legacyFile: legacyIdentity.legacyFile } }, f.recovery.createBranch());
    expect(legacy.recordId).not.toBe(first.recordId);
    expect((await f.recovery.readSnapshot(legacy.recordId)).origin).toMatchObject({ kind: "legacy", legacyFile: legacyIdentity.legacyFile });
  });
  it("keeps a retired physical recovery write ahead of a new claim and never overwrites that successor", async () => {
    const f = await storedFixture(), branch = f.recovery.createBranch(), entered = deferred(), release = deferred();
    const rename = fs.rename.bind(fs); let held = false;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => { if (!held && String(to).endsWith(f.input.recordId + ".json")) { held = true; entered.resolve(); await release.promise; } return rename(from, to); });
    const oldWrite = f.recovery.writeSnapshot(f.input, branch); await entered.promise; f.recovery.releaseBranch(branch);
    let completed = false; const nextBranch = f.recovery.createBranch();
    const next = f.recovery.writeSnapshot({ ...f.input, recordId: randomUUID(), project: { ...f.input.project, name: "Successor" } }, nextBranch).then(value => { completed = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 10)); expect(completed).toBe(false);
    release.resolve(); const old = await oldWrite, current = await next; expect(current.recordId).not.toBe(old.recordId);
    expect((await f.recovery.readSnapshot(current.recordId)).project.name).toBe("Successor");
    await expect(f.recovery.writeSnapshot({ ...f.input, revision: 100 }, branch)).rejects.toMatchObject({ code: "revision-conflict" });
    f.recovery.releaseBranch(nextBranch);
  });
  it("rolls back a physically late resolution before another branch can claim its slot", async () => {
    const f = await storedFixture(), first = await f.recovery.writeSnapshot(f.input), entered = deferred(), release = deferred();
    const rename = fs.rename.bind(fs); let held = false, live = true;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => { if (!held) { held = true; entered.resolve(); await release.promise; } return rename(from, to); });
    const marking = f.recovery.markResolved(first, f.mapping(first.digest), () => live); await entered.promise; live = false;
    let completed = false; const next = f.recovery.writeSnapshot({ ...f.input, recordId: randomUUID() }, f.recovery.createBranch()).then(value => { completed = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 10)); expect(completed).toBe(false);
    release.resolve(); expect(await marking).toBe(false); const newer = await next;
    expect(newer.recordId).not.toBe(first.recordId); expect((await f.recovery.readSnapshot(first.recordId)).resolved).toBeUndefined();
  });
  it("quarantines a failed rollback without hiding or reusing the cancelled exact marker", async () => {
    const f = await storedFixture(), first = await f.recovery.writeSnapshot(f.input), entered = deferred(), release = deferred();
    const rename = fs.rename.bind(fs); let calls = 0, live = true;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) !== path.join(f.root, "recovery", first.recordId + ".json")) return rename(from, to);
      calls++; if (calls === 1) { entered.resolve(); await release.promise; }
      if (calls === 2) throw Object.assign(new Error("rollback denied"), { code: "EACCES" });
      return rename(from, to);
    });
    const marking = f.recovery.markResolved(first, f.mapping(first.digest), () => live); const rejected = expect(marking).rejects.toMatchObject({ code: "storage-unavailable" });
    await entered.promise; live = false; release.resolve(); await rejected;
    // Kernel rename happened, but the running catalog cannot publish this cancelled mark.
    const disk = JSON.parse(await fs.readFile(path.join(f.root, "recovery", first.recordId + ".json"), "utf8"));
    expect(disk.resolved.digest).toBe(first.digest);
    expect((await f.catalog.list()).entries).toHaveLength(1);
    const next = await f.recovery.writeSnapshot({ ...f.input, recordId: randomUUID() }, f.recovery.createBranch());
    expect(next.recordId).not.toBe(first.recordId);
    expect(await f.recovery.markResolved(first, f.mapping(first.digest))).toBe(true);
    expect((await f.recovery.readSnapshot(first.recordId)).resolved?.digest).toBe(first.digest);
  });

});

describe("source success remains independent of metadata", () => {
  it("publishes an exact snapshotRevision zero departure receipt even if resolution hangs or fails", async () => {
    const f = await fixture(); await f.open(0); const gate = deferred(), entered = deferred(); let live!: () => boolean;
    vi.spyOn(f.recovery, "markResolved").mockImplementation(async (_receipt, _source, guard) => { live = guard!; entered.resolve(); await gate.promise; return live(); });
    const requests: any[] = [], continuations: any[] = [], sender = {};
    const coordinator = new ProjectDepartureCoordinator({ getContext: () => f.context, isRendererAlive: () => true, isTrustedSender: value => value === sender, getTransitionId: () => null,
      onRequest: request => requests.push(request), onCheckpoint: update => f.persistence.handleDepartureUpdate(update), onCancelled: id => f.persistence.handleDepartureCancelled(id), onFallback() {}, onDismissFallback() {}, onReopen() {}, onContinue: permit => continuations.push(permit) });
    f.persistence.attachDepartureCoordinator(coordinator); coordinator.request("close");
    const promise = f.persistence.checkpoint({ ...f.request(), requestId: requests[0].requestId }); await entered.promise;
    const saved = await promise; expect(saved.source).toBe("saved"); expect(saved.snapshotRevision).toBe(0); expect(live()).toBe(false);
    const receipt = saved.sourceReceipt!; expect("receiptId" in receipt).toBe(true);
    expect(coordinator.respond(sender, { requestId: requests[0].requestId, context: saved.context, snapshotRevision: 0, outcome: "saved", operationId: saved.operationId, receiptId: (receipt as any).receiptId })).toBe(true);
    expect(continuations).toHaveLength(1); gate.resolve(); coordinator.editingResumed(f.context.windowEpoch);
    expect((await f.catalog.list()).entries).toHaveLength(1);
    vi.spyOn(f.recovery, "markResolved").mockRejectedValue(new Error("metadata permission denied"));
    expect((await f.persistence.checkpoint(f.request())).source).toBe("saved");
  });
  it("leaves a failed source unresolved and a clean canonical-name save resolved", async () => {
    const failed = await fixture({ write: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } }); await failed.open(0);
    expect((await failed.persistence.checkpoint(failed.request())).source).toBe("failed"); expect((await failed.catalog.list()).entries).toHaveLength(1);
    const clean = await fixture(); await clean.open(0); const result = await clean.persistence.checkpoint(clean.request());
    expect(result.sourceReceipt?.digest).not.toBe(result.recoveryReceipt?.digest); // Folder name normalization is real source canonicalization.
    const stored = await clean.recovery.readSnapshot(clean.persistence.getSession().recoveryRecordId);
    expect(stored.resolved?.digest).toBe(result.recoveryReceipt?.digest); expect(stored.resolved?.sourceDigest).toBe(result.sourceReceipt?.digest);
  });
  it("retirement during held metadata never publishes old source authority into the replacement session", async () => {
    const f = await fixture(); await f.open(0); const gate = deferred(), entered = deferred(); let live!: () => boolean;
    vi.spyOn(f.recovery, "markResolved").mockImplementation(async (_receipt, _source, guard) => { live = guard!; entered.resolve(); await gate.promise; return live(); });
    const pending = f.persistence.checkpoint(f.request()); await entered.promise; await f.open(1); expect(live()).toBe(false);
    expect((await pending).source).toBe("failed"); gate.resolve(); await Promise.resolve(); expect(f.persistence.getSession().latestSource).toBeUndefined();
  });
  it("does not spend another metadata phase when the source consumes the existing checkpoint budget", async () => {
    const f = await fixture(); await f.open(0);
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const persist = f.source.persist.bind(f.source);
    vi.spyOn(f.source, "persist").mockImplementation(async (...args) => { const saved = await persist(...args); clock.mockReturnValue(9_990); return saved; });
    const mark = vi.spyOn(f.recovery, "markResolved");
    const saved = await f.persistence.checkpoint(f.request());
    expect(saved.source).toBe("saved"); expect(mark).not.toHaveBeenCalled(); expect((await f.catalog.list()).entries).toHaveLength(1);
  });
  it("preserves source success and truthful BDX failure when resolution metadata fails", async () => {
    const f = await fixture(); await f.open(0);
    vi.spyOn(f.recovery, "markResolved").mockRejectedValue(new Error("metadata failed"));
    const request = f.request(); const result = await f.persistence.saveWithExport(request, f.location as { folderPath: string; projectPath: null }, f.persistence.captureRequest(request), async () => { throw new Error("BDX fixture failure"); });
    expect(result).toMatchObject({ saved: true, exportError: expect.stringContaining("BDX fixture failure") });
    expect(f.persistence.getSession().latestSource?.kind).toBe("source"); expect((await f.catalog.list()).entries).toHaveLength(1);
  });
  it("a detached restore cannot reuse its provenance branch and saving a copy resolves only exact mapped snapshots", async () => {
    const f = await fixture(); await f.open(0); const first = await f.persistence.checkpoint(f.request());
    const receipt = first.recoveryReceipt!.storedSnapshot!; const prepared = await f.persistence.prepareRestore(f.context, receipt.recordId);
    f.persistence.contextChanged(true, prepared.recoveredFrom);
    f.persistence.admitSource(f.context, (await loadProjectSelection(f.location.folderPath!)).sourceEvidence);
    const detached = await f.persistence.checkpoint(f.request(prepared.project));
    expect(detached.source).toBe("failed"); expect(detached.recoveryReceipt?.storedSnapshot?.recordId).not.toBe(receipt.recordId);
    const destination = path.join(f.root, "restored-copy"); await fs.mkdir(destination);
    const saved = await f.persistence.checkpoint(f.request(prepared.project), { folderPath: destination, projectPath: null });
    expect(saved).toMatchObject({ source: "saved", snapshotRevision: 0 });
    expect(saved.recoveryReceipt?.storedSnapshot?.recordId).toBe(detached.recoveryReceipt?.storedSnapshot?.recordId);
    expect((await f.catalog.list()).entries).toEqual([]);
    expect((await f.recovery.readSnapshot(receipt.recordId)).origin).toEqual(prepared.recoveredFrom.origin);
  });

});

describe("displayed exact discard and quota recovery", () => {
  it("fills 32 unresolved slots, explicitly discards one displayed exact copy, and admits the next checkpoint", async () => {
    const f = await storedFixture();
    for (let i = 0; i < 32; i++) await f.recovery.writeSnapshot({ ...f.input, recordId: randomUUID() });
    const full = await f.catalog.list(); expect(full.capacity).toMatchObject({ recordCount: 32, full: true });
    const blocked = await f.persistence.checkpoint(f.request()); expect(blocked).toMatchObject({ source: "saved", recovery: "failed", recoveryCode: "capacity" });
    const confirmation = await f.catalog.prepareDiscard(full.entries[0].id, "context");
    await expect(f.catalog.discard(confirmation.token, "other-context")).rejects.toThrow("current");
    expect(await f.catalog.discard(confirmation.token, "context")).toEqual({ removed: true });
    await expect(f.catalog.discard(confirmation.token, "context")).rejects.toThrow("current");
    expect(await f.persistence.checkpoint(f.request())).toMatchObject({ source: "saved", recovery: "saved" });
  });
  it("refuses unlisted, refreshed, newer-revision and newly claimed discard confirmations", async () => {
    const f = await storedFixture(), first = await f.recovery.writeSnapshot(f.input);
    await expect(f.catalog.prepareDiscard(first.recordId, "owner")).rejects.toThrow("displayed");
    await f.catalog.list(); const stale = await f.catalog.prepareDiscard(first.recordId, "owner"); await f.catalog.list();
    await expect(f.catalog.discard(stale.token, "owner")).rejects.toThrow("current");
    const changed = await f.catalog.prepareDiscard(first.recordId, "owner"); await f.recovery.writeSnapshot({ ...f.input, revision: 2 });
    expect(await f.catalog.discard(changed.token, "owner")).toEqual({ removed: false });
    const now = await f.recovery.readSnapshot(first.recordId); await f.recovery.markResolved(now.receipt, f.mapping(now.receipt.digest));
    await f.catalog.list({ includeResolved: true }); const claimed = await f.catalog.prepareDiscard(first.recordId, "owner");
    const branch = f.recovery.createBranch(); await f.recovery.writeSnapshot({ ...f.input, recordId: randomUUID() }, branch);
    expect(await f.catalog.discard(claimed.token, "owner")).toEqual({ removed: false }); f.recovery.releaseBranch(branch);
  });
  it("only the latest prepared confirmation can delete, and context retirement fences an admitted delete", async () => {
    const f = await storedFixture(), first = await f.recovery.writeSnapshot(f.input); await f.catalog.list();
    const [a, latest] = await Promise.allSettled([f.catalog.prepareDiscard(first.recordId, "owner"), f.catalog.prepareDiscard(first.recordId, "owner")]);
    expect(a.status).toBe("rejected"); expect(latest.status).toBe("fulfilled");
    if (latest.status !== "fulfilled") throw latest.reason;
    const b = latest.value;
    await expect(f.catalog.discard(b.token, "owner", () => false)).rejects.toThrow("current");
    expect((await f.recovery.readSnapshot(first.recordId)).receipt).toEqual({ recordId: first.recordId, revision: first.revision, digest: first.digest });
    expect(await f.catalog.discard(b.token, "owner")).toEqual({ removed: true });
  });
  it("offers exact-identity discard of a damaged record only, never of unsafe, changed or replaced entries", async () => {
    const f = await storedFixture(), dir = path.join(f.root, "recovery"), bad = randomUUID(), linked = randomUUID(), folder = randomUUID();
    const target = path.join(dir, bad + ".json"), outside = path.join(f.root, "outside.json");
    await fs.mkdir(dir); await fs.writeFile(target, "invalid"); await fs.writeFile(outside, "outside");
    await fs.symlink(outside, path.join(dir, linked + ".json")); await fs.mkdir(path.join(dir, folder + ".json"));
    const listed = (await f.catalog.list()).entries, entry = listed.find(item => item.recordId === bad)!;
    expect(entry).toMatchObject({ available: false, discardable: true, name: "Damaged recovery copy", code: "invalid-record" });
    expect(JSON.stringify(listed)).not.toContain("fingerprint");
    for (const unsafe of [linked, folder]) {
      const item = listed.find(candidate => candidate.recordId === unsafe)!;
      expect(item).toMatchObject({ available: false, discardable: false, name: "Recovery copy", code: "unsafe-entry" });
      await expect(f.catalog.prepareDiscard(item.id, "owner")).rejects.toThrow("cannot be discarded");
    }
    await expect(f.catalog.prepareDiscard("../../other.json", "owner")).rejects.toThrow("displayed");
    // Changed after listing: refused at reservation, then after reservation: refused at discard. Nothing is deleted.
    await fs.writeFile(target, "invalid, but different");
    await expect(f.catalog.prepareDiscard(entry.id, "owner")).rejects.toThrow("changed");
    const reserved = await f.catalog.prepareDiscard((await f.catalog.list()).entries.find(item => item.recordId === bad)!.id, "owner");
    await fs.writeFile(target, "changed again after the reservation");
    expect(await f.catalog.discard(reserved.token, "owner")).toEqual({ removed: false });
    expect(await fs.readFile(target, "utf8")).toBe("changed again after the reservation");
    // Replaced by a valid record after listing: the listed damaged identity no longer matches.
    const relisted = (await f.catalog.list()).entries.find(item => item.recordId === bad)!;
    const repaired = await f.catalog.prepareDiscard(relisted.id, "owner");
    await fs.rm(target); await f.recovery.writeSnapshot({ ...f.input, recordId: bad });
    expect(await f.catalog.discard(repaired.token, "owner")).toEqual({ removed: false });
    expect((await f.recovery.readSnapshot(bad)).displayName).toBe("retained");
    await fs.writeFile(target, "damaged once more");
    const confirmed = await f.catalog.prepareDiscard((await f.catalog.list()).entries.find(item => item.recordId === bad)!.id, "owner");
    expect(await f.catalog.discard(confirmed.token, "owner")).toEqual({ removed: true });
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readlink(path.join(dir, linked + ".json"))).toBe(outside); expect(await fs.readFile(outside, "utf8")).toBe("outside");
    expect((await fs.lstat(path.join(dir, folder + ".json"))).isDirectory()).toBe(true);
  });
  it("never offers or performs discard of a damaged record a branch still claims", async () => {
    const f = await storedFixture(), branch = f.recovery.createBranch(), written = await f.recovery.writeSnapshot(f.input, branch);
    const target = path.join(f.root, "recovery", written.recordId + ".json"); await fs.writeFile(target, "damaged while claimed");
    const raw = (await f.recovery.listSnapshots()).entries.find(item => item.recordId === written.recordId)!;
    expect(raw).toMatchObject({ status: "unavailable", active: true }); expect(raw.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const entry = (await f.catalog.list()).entries.find(item => item.recordId === written.recordId)!;
    expect(entry).toMatchObject({ available: false, discardable: false });
    await expect(f.catalog.prepareDiscard(entry.id, "owner")).rejects.toThrow("cannot be discarded");
    const exact = { recordId: written.recordId, fingerprint: raw.fingerprint! };
    expect(await f.recovery.verifyDamagedSnapshot(exact)).toBe(false); expect(await f.recovery.removeDamagedSnapshot(exact)).toBe(false);
    expect(await fs.readFile(target, "utf8")).toBe("damaged while claimed");
    f.recovery.releaseBranch(branch);
    expect(await f.recovery.removeDamagedSnapshot(exact, () => false)).toBe(false);
    expect(await f.recovery.removeDamagedSnapshot(exact)).toBe(true);
    await expect(f.recovery.removeDamagedSnapshot({ recordId: "../escape", fingerprint: exact.fingerprint })).rejects.toMatchObject({ code: "invalid-input" });
  });
});


describe("actual main recovery management IPC listeners", () => {
  it("admits only current contexts and displayed exact copies through the two-step bridge", async () => {
    const f = await storedFixture(), first = await f.recovery.writeSnapshot(f.input);
    const contents = await fs.readFile(path.resolve("src/electron/main.ts"), "utf8"), ast = ts.createSourceFile("main.ts", contents, ts.ScriptTarget.Latest, true);
    // Execute actual listener bodies; trusted-frame Electron delivery remains a separate native check.
    const listeners: Record<string, (...args: unknown[]) => unknown> = {};
    const sandbox = { projectRecoveryCatalog: f.catalog, projectContext: () => f.persistence.getSession().context, sameProjectContext, listeners };
    for (const channel of ["project:listRecoveries", "project:prepareRecoveryDiscard", "project:discardRecovery"]) {
      const statement = ast.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
        && node.expression.expression.getText(ast) === "handle" && node.expression.arguments[0]?.getText(ast) === JSON.stringify(channel));
      if (!statement || !ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) throw new Error("Actual handler missing: " + channel);
      const listener = statement.expression.arguments[1].getText(ast);
      vm.runInNewContext(ts.transpileModule(`listeners[${JSON.stringify(channel)}] = ${listener};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
    }
    expect(() => listeners["project:listRecoveries"](null, [])).toThrow("invalid");
    await listeners["project:listRecoveries"](null);
    const original = f.persistence.getSession().context;
    await expect(listeners["project:prepareRecoveryDiscard"](null, { ...original, windowEpoch: "old" }, first.recordId)).rejects.toThrow("current");
    const prepared = await listeners["project:prepareRecoveryDiscard"](null, original, first.recordId) as { token: string };
    await f.open(1);
    expect(() => listeners["project:discardRecovery"](null, original, prepared.token)).toThrow("current");
    await expect(listeners["project:discardRecovery"](null, f.persistence.getSession().context, prepared.token)).rejects.toThrow("current");
    expect((await f.recovery.readSnapshot(first.recordId)).receipt.digest).toBe(first.digest);
    const current = f.persistence.getSession().context;
    const next = await listeners["project:prepareRecoveryDiscard"](null, current, first.recordId) as { token: string };
    expect(await listeners["project:discardRecovery"](null, current, next.token)).toEqual({ removed: true });
  });
});
