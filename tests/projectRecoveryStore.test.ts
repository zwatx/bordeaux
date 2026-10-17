import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_RECOVERY_RECORD_BYTES, MAX_RECOVERY_RECORDS, MAX_RECOVERY_TOTAL_BYTES, ProjectRecoveryStore, type RecoveryWriteRequest } from "../src/electron/projectRecoveryStore";
import { blankPath, buildWaypoints, createDemoProject } from "../src/shared/project/defaults";
import { encodeProjectFile } from "../src/shared/project/fileFormat";
import { optimizeFixedGeometryFinal } from "../src/shared/planners/fixedGeometryFinal";
import { createAcceptedTrajectory } from "../src/shared/planners/acceptedTrajectory";
import { planPath } from "../src/shared/planners/planPath";

const directories: string[] = [];
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-recovery-store-")); directories.push(directory);
  const root = path.join(directory, "recovery"); return { directory, root, store: new ProjectRecoveryStore(root) };
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true }))); });
function request(patch: Partial<RecoveryWriteRequest> = {}): RecoveryWriteRequest {
  return { recordId: randomUUID(), revision: 1, capturedAt: "2026-10-12T12:00:00.000Z", displayName: "Recovered draft", reason: "autosave-failed", origin: { kind: "untitled", id: randomUUID() }, project: createDemoProject(), ...patch };
}
const file = (root: string, recordId: string) => path.join(root, recordId + ".json");
const hash = (contents: string) => createHash("sha256").update(contents).digest("hex");
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }

describe("local project recovery snapshots", () => {
  it("readonly probes do not create storage or activate any target", async () => {
    const { root, store } = await fixture();
    expect(await store.listSnapshots()).toEqual({ entries: [], limited: false, capacity: { recordCount: 0, recordLimit: 32, bytes: 0, byteLimit: 256 * 1024 * 1024, full: false } });
    await expect(store.readSnapshot(randomUUID())).rejects.toMatchObject({ code: "missing" });
    expect(await store.removeSnapshot({ recordId: randomUUID(), revision: 1, digest: "0".repeat(64) })).toBe(false);
    await expect(fs.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("round-trips canonical source, commands, links, nested routines and exact accepted output", async () => {
    const { root, store } = await fixture(), input = request(), project = input.project, first = project.paths[0];
    first.waypoints = buildWaypoints([{ x: 1, y: 1, segType: "line" }, { x: 2, y: 1 }]);
    first.markers = [{ id: "event", name: "Command", f: 0.4, invocation: { commandId: "team.command", arguments: { enabled: true, power: 0.125, label: "Café 🤖" } } }];
    const result = optimizeFixedGeometryFinal({ path: first, robot: project.robot, samplesPerSegment: 56 });
    first.optimization = { corridorM: 0.15, accepted: createAcceptedTrajectory(first, project.robot, result, project.field, 56) };
    (first as any)._selAfter = { kind: "wp", idx: 1 };
    const second = blankPath("Second"); project.paths.push(second);
    project.pathLinks = [{ id: "link", fromPathId: first.id, toPathId: second.id }];
    first.waypoints.at(-1)!.positionLink = "shared"; second.waypoints[0].positionLink = "shared";
    project.routines[0].nodes = [{ id: "decision", type: "decision", cond: "Has piece", thenLabel: "Yes", elseLabel: "No", then: [{ id: "first", type: "path", ref: first.id }], else: [{ id: "wait", type: "builtin", builtinId: "bordeaux.wait", arguments: { durationS: 0.5 } }] }];
    const expected = encodeProjectFile(project);
    const receipt = await store.writeSnapshot(input), restored = await store.readSnapshot(input.recordId);
    expect(receipt).toMatchObject({ stored: true, written: true, revision: 1, capturedAt: input.capturedAt, digest: hash(expected.contents) });
    expect(restored.project).toEqual(expected.project);
    expect(restored.project.paths[0].optimization?.accepted?.result).toEqual(result);
    expect((restored.project.paths[0] as any)._selAfter).toBeUndefined();
    expect(restored.receipt.digest).toBe(hash(encodeProjectFile(restored.project).contents));
    expect(await fs.readdir(root)).toEqual([input.recordId + ".json"]);
    expect((await fs.stat(root)).mode & 0o077).toBe(0);
    expect((await fs.stat(file(root, input.recordId))).mode & 0o177).toBe(0);
  });

  it("preserves authored physics-infeasible source without planning it into an export", async () => {
    const { store } = await fixture(), input = request(), p = input.project.paths[0];
    p.waypoints = buildWaypoints([{ x: 2, y: 2, segType: "line" }, { x: 7, y: 2 }]); p.startVel = 4;
    p.ranges = [{ anchor: "param", f0: 0.02, f1: 0.3, maxVel: 0.5 }];
    expect(planPath({ path: p, robot: input.project.robot }).status).toBe("infeasible");
    await store.writeSnapshot(input);
    expect((await store.readSnapshot(input.recordId)).project.paths[0]).toEqual(encodeProjectFile(input.project).project.paths[0]);
  });

  it("retains separate legacy siblings, branch records and Untitled identities", async () => {
    const { directory, root, store } = await fixture(), folderPath = path.join(directory, "source");
    const a = request({ origin: { kind: "legacy", folderPath, legacyFile: path.join(folderPath, "A.bordeaux") } });
    const b = request({ origin: { kind: "legacy", folderPath, legacyFile: path.join(folderPath, "B.bordeaux") } });
    const branch = request({ origin: a.origin }), untitledA = request(), untitledB = request();
    for (const input of [a, b, branch, untitledA, untitledB]) await store.writeSnapshot(input);
    const listed = await store.listSnapshots();
    expect(listed.entries).toHaveLength(5); expect(await fs.readdir(root)).toHaveLength(5);
    const originId = (recordId: string) => listed.entries.find(entry => entry.recordId === recordId)!.metadata!.originId;
    expect(originId(a.recordId)).not.toBe(originId(b.recordId)); expect(originId(branch.recordId)).toBe(originId(a.recordId));
    expect(originId(untitledA.recordId)).not.toBe(originId(untitledB.recordId));
    expect(await store.readSnapshot(a.recordId)).toMatchObject({ origin: a.origin });
  });

  it("uses normalized source identity and leaves Save As/document identity to its caller", async () => {
    const { directory, store } = await fixture(), folderPath = path.join(directory, "source");
    const input = request({ origin: { kind: "folder", folderPath: path.join(folderPath, "..", "source"), projectPath: path.join(folderPath, ".bordeaux-workspace.json") } });
    const original = await store.writeSnapshot(input), opened = await store.readSnapshot(input.recordId);
    expect(opened.origin).toMatchObject({ folderPath });
    input.revision++; input.origin = { kind: "folder", folderPath: path.join(directory, "copy") };
    await store.writeSnapshot(input); expect(await store.removeSnapshot(original)).toBe(false);
    expect((await store.readSnapshot(input.recordId)).origin).toEqual(input.origin);
  });

  it("clones a materialized capture before any await and returns independent restored objects", async () => {
    const { store } = await fixture(), input = request(), expected = encodeProjectFile(input.project).project;
    const pending = store.writeSnapshot(input);
    input.project.paths[0].name = "Late edit"; input.origin = { kind: "untitled", id: randomUUID() }; input.displayName = "Late metadata";
    await pending; const restored = await store.readSnapshot(input.recordId);
    expect(restored.project).toEqual(expected); expect(restored.displayName).toBe("Recovered draft");
    restored.project.paths[0].name = "Caller mutation";
    expect((await store.readSnapshot(input.recordId)).project).toEqual(expected);
  });

  it("serializes concurrent/out-of-order revisions across store instances and guards removal", async () => {
    const { root, store } = await fixture(), other = new ProjectRecoveryStore(root), input = request();
    const newer = structuredClone(input); newer.revision = 5; newer.project.paths[0].name = "Latest";
    const [newReceipt, staleReceipt] = await Promise.all([store.writeSnapshot(newer), other.writeSnapshot(input)]);
    expect(newReceipt.stored).toBe(true); expect(staleReceipt).toMatchObject({ stored: false, revision: 1 });
    expect(await other.removeSnapshot(staleReceipt)).toBe(false);
    expect(await store.removeSnapshot({ ...newReceipt, digest: "0".repeat(64) })).toBe(false);
    expect((await store.readSnapshot(input.recordId)).project.paths[0].name).toBe("Latest");
    expect(await other.removeSnapshot(newReceipt)).toBe(true); expect(await store.removeSnapshot(newReceipt)).toBe(false);
  });

  it("holds only one latest successor while a write is running", async () => {
    const { root, store } = await fixture(), input = request({ revision: 0 }), ready = deferred(), release = deferred();
    const rename = fs.rename.bind(fs); let first = true;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === file(root, input.recordId) && first) { first = false; ready.resolve(); await release.promise; }
      return rename(from, to);
    });
    const running = store.writeSnapshot(input); await ready.promise;
    const pending = Array.from({ length: 8 }, (_, i) => { const next = structuredClone(input); next.revision = i + 1; next.project.paths[0].name = `Revision ${i + 1}`; return store.writeSnapshot(next); });
    const superseded = await Promise.all(pending.slice(0, -1)); expect(superseded.every(receipt => !receipt.stored)).toBe(true);
    release.resolve(); await running; expect((await pending.at(-1)!).stored).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2); expect((await store.readSnapshot(input.recordId)).project.paths[0].name).toBe("Revision 8");
  });

  it("accepts exact retry but refuses changed data with the same revision", async () => {
    const { store } = await fixture(), input = request(); await store.writeSnapshot(input);
    expect(await store.writeSnapshot(input)).toMatchObject({ stored: true, written: false });
    input.project.paths[0].name = "Conflicting token";
    await expect(store.writeSnapshot(input)).rejects.toMatchObject({ code: "revision-conflict" });
    expect((await store.readSnapshot(input.recordId)).project.paths[0].name).toBe("NewPath");
  });

  it("preserves prior usable source and cleans its temporary file on failed replacement", async () => {
    const { root, store } = await fixture(), input = request(); const receipt = await store.writeSnapshot(input);
    input.revision++; input.project.paths[0].name = "Not persisted";
    vi.spyOn(fs, "rename").mockRejectedValue(new Error("private exception contents"));
    await expect(store.writeSnapshot(input)).rejects.toMatchObject({ code: "storage-unavailable", message: "Recovery storage is unavailable" });
    expect((await store.readSnapshot(input.recordId)).receipt).toEqual({ recordId: receipt.recordId, revision: receipt.revision, digest: receipt.digest });
    expect((await store.readSnapshot(input.recordId)).project.paths[0].name).toBe("NewPath");
    expect(await fs.readdir(root)).toEqual([input.recordId + ".json"]);
  });

  it.each(["../escape", "not-an-id", "a/../../b"])("refuses opaque ID traversal %s before filesystem mutation", async recordId => {
    const { root, store } = await fixture();
    await expect(store.writeSnapshot(request({ recordId }))).rejects.toMatchObject({ code: "invalid-input" });
    await expect(store.readSnapshot(recordId)).rejects.toMatchObject({ code: "invalid-input" });
    await expect(fs.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["revision", "timestamp", "origin", "name"])("refuses invalid %s metadata", async kind => {
    const { root, store } = await fixture(), input: any = request();
    if (kind === "revision") input.revision = Number.NaN;
    if (kind === "timestamp") input.capturedAt = "bad date";
    if (kind === "origin") input.origin = { kind: "legacy", folderPath: "/a", legacyFile: "/b/Source.bordeaux" };
    if (kind === "name") input.displayName = "x".repeat(257);
    await expect(store.writeSnapshot(input)).rejects.toMatchObject({ code: "invalid-input" });
    await expect(fs.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["nonfinite", "unknown-nonfinite", "circular", "oversize", "invalid-project"])("refuses %s source before writing", async kind => {
    const { root, store } = await fixture(), input: any = request();
    if (kind === "nonfinite") input.project.robot.maxSpeed = Infinity;
    if (kind === "unknown-nonfinite") input.project.extra = Number.NaN;
    if (kind === "circular") input.project.extra = input.project;
    if (kind === "oversize") input.project.extra = "x".repeat(MAX_RECOVERY_RECORD_BYTES);
    if (kind === "invalid-project") input.project.paths = "garbage";
    await expect(store.writeSnapshot(input)).rejects.toMatchObject({ code: kind === "oversize" ? "too-large" : "invalid-project" });
    await expect(fs.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows a whole-project source larger than the standalone 16 MiB limit", async () => {
    const { store } = await fixture(), input = request();
    (input.project as any).notes = "x".repeat(17 * 1024 * 1024);
    expect((await store.writeSnapshot(input)).stored).toBe(true);
    expect((await store.readSnapshot(input.recordId)).project).toHaveProperty("notes", (input.project as any).notes);
  });

  it("isolates corrupt, unsupported and unknown entries without deleting or exposing payloads", async () => {
    const { root, store } = await fixture(), healthy = request(), unsupported = request();
    await store.writeSnapshot(healthy); await store.writeSnapshot(unsupported);
    const version = JSON.parse(await fs.readFile(file(root, unsupported.recordId), "utf8")); version.format = "bordeaux-recovery/2";
    await fs.writeFile(file(root, unsupported.recordId), JSON.stringify(version));
    const corruptId = randomUUID(); await fs.writeFile(file(root, corruptId), "private malformed payload"); await fs.writeFile(path.join(root, "private-file-name.txt"), "private contents");
    const listed = await store.listSnapshots(); expect(listed.entries).toHaveLength(4);
    expect(listed.entries.find(entry => entry.recordId === healthy.recordId)?.status).toBe("available");
    expect(listed.entries.find(entry => entry.recordId === unsupported.recordId)).toMatchObject({ status: "unavailable", code: "unsupported-version", metadata: { displayName: unsupported.displayName } });
    expect(listed.entries.find(entry => entry.recordId === corruptId)).toMatchObject({ status: "unavailable", code: "invalid-record" });
    expect(JSON.stringify(listed)).not.toContain("private malformed"); expect(JSON.stringify(listed)).not.toContain("private-file-name");
    await expect(store.writeSnapshot({ ...unsupported, revision: 2 })).rejects.toMatchObject({ code: "unsupported-version" });
    expect(await fs.readdir(root)).toHaveLength(4);
  });

  it("refuses record symlinks and oversized files before reading their payload", async () => {
    const { directory, root, store } = await fixture(); await fs.mkdir(root);
    const outside = path.join(directory, "private.txt"), linked = randomUUID(), large = randomUUID();
    await fs.writeFile(outside, "private contents"); await fs.symlink(outside, file(root, linked));
    await fs.writeFile(file(root, large), ""); await fs.truncate(file(root, large), MAX_RECOVERY_RECORD_BYTES + 1);
    const read = vi.spyOn(fs, "open");
    const listed = await store.listSnapshots();
    expect(listed.entries.find(entry => entry.recordId === linked)?.code).toBe("unsafe-entry");
    expect(listed.entries.find(entry => entry.recordId === large)?.code).toBe("too-large"); expect(read).not.toHaveBeenCalled();
    await expect(store.writeSnapshot(request({ recordId: linked }))).rejects.toMatchObject({ code: "unsafe-entry" });
    expect(await fs.readlink(file(root, linked))).toBe(outside);
  });

  it("does not read a symlink substituted after the initial file check", async () => {
    const { directory, root, store } = await fixture(), input = request(); await store.writeSnapshot(input);
    const target = file(root, input.recordId), outside = path.join(directory, "private.txt");
    await fs.writeFile(outside, "private payload");
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (filename, flags, mode) => {
      if (String(filename) === target) { await fs.unlink(target); await fs.symlink(outside, target); }
      return open(filename, flags, mode);
    });
    await expect(store.readSnapshot(input.recordId)).rejects.toMatchObject({ code: "unsafe-entry" });
    expect(await fs.readFile(outside, "utf8")).toBe("private payload");
  });

  it("bounds reads when a checked file grows during the read", async () => {
    const { root, store } = await fixture(), input = request(); await store.writeSnapshot(input);
    const target = file(root, input.recordId), open = fs.open.bind(fs); let bytes = 0;
    vi.spyOn(fs, "open").mockImplementation(async (filename, flags, mode) => {
      const handle = await open(filename, flags, mode);
      if (String(filename) === target) {
        const stat = handle.stat.bind(handle), read = handle.read.bind(handle);
        vi.spyOn(handle, "stat").mockImplementation(async () => { const checked = await stat(); await fs.truncate(target, MAX_RECOVERY_RECORD_BYTES + 100); return checked; });
        vi.spyOn(handle, "read").mockImplementation(async (...args: any[]) => { const result = await (read as any)(...args); bytes += result.bytesRead; return result; });
      }
      return handle;
    });
    await expect(store.readSnapshot(input.recordId)).rejects.toMatchObject({ code: "too-large" });
    expect(bytes).toBe(MAX_RECOVERY_RECORD_BYTES + 1);
    expect((await fs.stat(target)).size).toBe(MAX_RECOVERY_RECORD_BYTES + 100);
  });

  it("refuses a symlinked root without touching its target", async () => {
    const { directory, root } = await fixture(), outside = path.join(directory, "outside");
    await fs.mkdir(outside); await fs.symlink(outside, root); const store = new ProjectRecoveryStore(root);
    await expect(store.writeSnapshot(request())).rejects.toMatchObject({ code: "unsafe-entry" });
    await expect(store.listSnapshots()).rejects.toMatchObject({ code: "unsafe-entry" }); expect(await fs.readdir(outside)).toEqual([]);
  });

  it("reports enumeration failure distinctly and isolates individual unreadable entries", async () => {
    const { root, store } = await fixture(), healthy = request(), unavailable = request();
    await store.writeSnapshot(healthy); await store.writeSnapshot(unavailable);
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (filename, flags, mode) => {
      if (String(filename) === file(root, unavailable.recordId)) throw Object.assign(new Error("private path detail"), { code: "EACCES" });
      return open(filename, flags, mode);
    });
    const listed = await store.listSnapshots();
    expect(listed.entries.find(entry => entry.recordId === healthy.recordId)?.status).toBe("available");
    expect(listed.entries.find(entry => entry.recordId === unavailable.recordId)).toMatchObject({ status: "unavailable", code: "storage-unavailable", detail: "Recovery storage is unavailable" });
    expect(JSON.stringify(listed)).not.toContain("private path detail");
    vi.spyOn(fs, "opendir").mockRejectedValue(Object.assign(new Error("private directory detail"), { code: "EACCES" }));
    await expect(store.listSnapshots()).rejects.toMatchObject({ code: "storage-unavailable", message: "Recovery storage is unavailable" });
    expect(await fs.readdir(root)).toHaveLength(2);
  });

  it("enforces record count with no eviction and reports bounded enumeration", async () => {
    const { root, store } = await fixture(); await fs.mkdir(root);
    const names = Array.from({ length: MAX_RECOVERY_RECORDS + 1 }, () => randomUUID() + ".json");
    await Promise.all(names.map(name => fs.writeFile(path.join(root, name), "{}")));
    await expect(store.writeSnapshot(request())).rejects.toMatchObject({ code: "capacity" });
    const listed = await store.listSnapshots(); expect(listed.entries).toHaveLength(MAX_RECOVERY_RECORDS); expect(listed.limited).toBe(true);
    expect((await fs.readdir(root)).sort()).toEqual(names.sort());
  });

  it("accounts byte quota across different records without cleanup", async () => {
    const { root, store } = await fixture(); await fs.mkdir(root);
    const count = Math.ceil(MAX_RECOVERY_TOTAL_BYTES / MAX_RECOVERY_RECORD_BYTES);
    for (let i = 0; i < count; i++) { const target = file(root, randomUUID()); await fs.writeFile(target, ""); await fs.truncate(target, MAX_RECOVERY_RECORD_BYTES); }
    await expect(store.writeSnapshot(request())).rejects.toMatchObject({ code: "capacity" }); expect(await fs.readdir(root)).toHaveLength(count);
  });

  it("never writes origins, workspace, BDX or recents during write/read/list/remove", async () => {
    const { directory, store } = await fixture(), folderPath = path.join(directory, "original"); await fs.mkdir(folderPath);
    const files = [".bordeaux-workspace.json", "Path.bdx", "recent-projects.json", "A.bordeaux"];
    for (const name of files) await fs.writeFile(path.join(folderPath, name), "preserve " + name);
    const before = await Promise.all(files.map(name => fs.readFile(path.join(folderPath, name), "utf8")));
    const input = request({ origin: { kind: "legacy", folderPath, legacyFile: path.join(folderPath, "A.bordeaux") } });
    const receipt = await store.writeSnapshot(input); await store.readSnapshot(input.recordId); await store.listSnapshots(); await store.removeSnapshot(receipt);
    expect(await Promise.all(files.map(name => fs.readFile(path.join(folderPath, name), "utf8")))).toEqual(before);
    expect((await fs.readdir(folderPath)).sort()).toEqual(files.sort());
  });
});
