import fs from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { BordeauxProject } from "../shared/types";
import { encodeProjectFile, prepareProjectFile } from "../shared/project/fileFormat";
import { MAX_WORKSPACE_FILE_BYTES } from "./projectFiles";

export const MAX_RECOVERY_RECORD_BYTES = MAX_WORKSPACE_FILE_BYTES;
export const MAX_RECOVERY_RECORDS = 32;
export const MAX_RECOVERY_TOTAL_BYTES = 256 * 1024 * 1024;
/** Directory entries examined per scan. Debris never takes a record slot, but a hostile directory still bounds the work. */
export const MAX_RECOVERY_SCAN_ENTRIES = MAX_RECOVERY_RECORDS * 8;
/** An owned temporary untouched this long is a crashed write's leftover, not one still being written (writes take seconds). */
export const STALE_RECOVERY_TEMPORARY_MS = 10 * 60_000;
const FORMAT = "bordeaux-recovery/1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOWER_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
// Exactly the names this store creates: `<recordId>.json` records and `.<recordId>.<uuid>.tmp` write temporaries.
const RECORD_NAME = new RegExp(`^${LOWER_UUID}\\.json$`);
const TEMPORARY_NAME = new RegExp(`^\\.${LOWER_UUID}\\.${LOWER_UUID}\\.tmp$`);
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_TEXT = 256;
const MAX_PATH = 4_096;

export type RecoveryOrigin =
  | { kind: "folder"; folderPath: string; projectPath?: string | null }
  | { kind: "legacy"; folderPath: string; legacyFile: string; projectPath?: string | null }
  | { kind: "untitled"; id: string };

export interface RecoveryMetadata {
  recordId: string;
  revision: number;
  capturedAt: string;
  displayName: string;
  reason: string;
  origin: RecoveryOrigin;
  originId: string;
}
export interface RecoveryReceipt { recordId: string; revision: number; digest: string }
export interface RecoveryOriginIdentity { folderPath: string; objectKey: string; legacyFile?: string }
export interface RecoveryResolution { sourceIdentity?: RecoveryOriginIdentity; revision: number; digest: string; sourceDigest: string; resolvedAt: string; sourceOrigin: RecoveryOrigin }
/** Main-only process lease; never accepted from renderer IPC. */
export interface RecoveryBranch { readonly id: string }
export interface RecoveryWriteReceipt extends RecoveryReceipt {
  requested?: { recordId: string; revision: number };
  /** Main-authored capture time; confirmed on disk only when stored is true. */
  capturedAt: string;
  stored: boolean;
  written: boolean;
  supersededByRevision?: number;
}
export interface RecoverySnapshot extends RecoveryMetadata {
  project: BordeauxProject;
  receipt: RecoveryReceipt;
  resolved?: RecoveryResolution;
}
export interface RecoverySummary {
  entryId: string;
  recordId: string | null;
  status: "available" | "unavailable";
  active?: boolean;
  metadata?: RecoveryMetadata;
  receipt?: RecoveryReceipt;
  resolved?: RecoveryResolution;
  code?: RecoveryErrorCode;
  detail?: string;
  /** Main-only identity of a damaged regular record file, captured at listing; discard requires it to still match. */
  fingerprint?: string;
}
export interface RecoveryDamagedTarget { recordId: string; fingerprint: string }
export interface RecoveryListing { entries: RecoverySummary[]; limited: boolean; capacity: { recordCount: number; recordLimit: number; bytes: number; byteLimit: number; full: boolean } }
export interface RecoveryWriteRequest {
  recordId: string;
  revision: number;
  capturedAt: string;
  displayName: string;
  reason: string;
  origin: RecoveryOrigin;
  project: BordeauxProject;
  /** Main-admitted physical identity, never supplied by project or renderer metadata. */
  originIdentity?: RecoveryOriginIdentity;
}
export type RecoveryErrorCode = "invalid-input" | "invalid-project" | "invalid-record" | "unsupported-version"
  | "unsafe-entry" | "too-large" | "missing" | "storage-unavailable" | "capacity" | "revision-conflict";
// Read failures that mean the record's own bytes are unusable (or from a newer version), never a transient or unsafe entry.
const DAMAGED = new Set<RecoveryErrorCode>(["invalid-input", "invalid-project", "invalid-record", "unsupported-version", "too-large"]);
const DETAILS: Record<RecoveryErrorCode, string> = {
  "invalid-input": "Recovery metadata is invalid", "invalid-project": "Recovery project is not valid",
  "invalid-record": "Recovery record could not be read", "unsupported-version": "Recovery version is not supported",
  "unsafe-entry": "Recovery entry is not a regular file", "too-large": "Recovery exceeds the file size limit",
  "missing": "Recovery is no longer available", "storage-unavailable": "Recovery storage is unavailable",
  "capacity": "Recovery storage is full", "revision-conflict": "Recovery revision already holds different content",
};
export class RecoveryStoreError extends Error {
  constructor(public readonly code: RecoveryErrorCode, public readonly metadata?: RecoveryMetadata) { super(DETAILS[code]); this.name = "RecoveryStoreError"; }
}

interface Envelope { format: typeof FORMAT; metadata: RecoveryMetadata; project: BordeauxProject; digest: string; resolved?: RecoveryResolution }
interface Capture { originIdentity?: RecoveryOriginIdentity; envelope: Envelope; contents: string; receipt: RecoveryReceipt }
interface QueuedWrite { capture: Capture; branch?: RecoveryBranch; isCurrent(): boolean; resolve: (receipt: RecoveryWriteReceipt) => void; reject: (error: unknown) => void }
interface BranchState { root: string; active: boolean; recordId?: string; offset: number; pending: number }
const branches = new WeakMap<RecoveryBranch, BranchState>();
const claimedRecords = new Map<string, RecoveryBranch>();
// A failed rollback must not make a cancelled mark visible/reusable in this process.
// On restart its persisted marker still covers only the exact source that actually saved.
const uncertainResolutions = new Map<string, RecoveryReceipt>();
// Temporary names (unique per write) this process is writing now; a sweep never removes them, whatever their age or root alias.
const writingTemporaries = new Set<string>();
function branchState(branch: RecoveryBranch, root: string): BranchState {
  const state = branches.get(branch);
  if (!state || state.root !== pathKey(root) || !state.active) throw new RecoveryStoreError("revision-conflict");
  return state;
}
function releaseClaim(branch: RecoveryBranch): void {
  const state = branches.get(branch);
  if (state && !state.active && state.pending === 0 && state.recordId) {
    const key = pathKey(path.join(state.root, state.recordId + ".json"));
    if (claimedRecords.get(key) === branch) claimedRecords.delete(key);
  }
}
const queues = new Map<string, Promise<unknown>>();
const queuedWrites = new Map<string, QueuedWrite>();
function serial<T>(root: string, action: () => Promise<T>): Promise<T> {
  const key = pathKey(root), pending = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(action);
  queues.set(key, pending);
  void pending.finally(() => { if (queues.get(key) === pending) queues.delete(key); }).catch(() => undefined);
  return pending;
}
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function id(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new RecoveryStoreError("invalid-input");
  return value.toLowerCase();
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT || /[\x00-\x1f\x7f]/.test(value)) throw new RecoveryStoreError("invalid-input");
  return value;
}
function absolute(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_PATH || value.includes("\0") || !path.isAbsolute(value)) throw new RecoveryStoreError("invalid-input");
  return path.resolve(value);
}
function pathKey(value: string): string { return process.platform === "win32" ? value.toLowerCase() : value; }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function origin(value: unknown): RecoveryOrigin {
  if (!record(value)) throw new RecoveryStoreError("invalid-input");
  if (value.kind === "untitled") return { kind: "untitled", id: id(value.id) };
  if (value.kind !== "folder" && value.kind !== "legacy") throw new RecoveryStoreError("invalid-input");
  const folderPath = absolute(value.folderPath);
  const projectPath = value.projectPath === undefined ? undefined : value.projectPath === null ? null : absolute(value.projectPath);
  if (projectPath && pathKey(path.dirname(projectPath)) !== pathKey(folderPath)) throw new RecoveryStoreError("invalid-input");
  const target = { folderPath, ...(projectPath === undefined ? {} : { projectPath }) };
  if (value.kind === "folder") return { kind: "folder", ...target };
  const legacyFile = absolute(value.legacyFile);
  if (pathKey(path.dirname(legacyFile)) !== pathKey(folderPath)) throw new RecoveryStoreError("invalid-input");
  return { kind: "legacy", ...target, legacyFile };
}
function metadata(value: unknown): RecoveryMetadata {
  if (!record(value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) throw new RecoveryStoreError("invalid-input");
  const capturedAt = text(value.capturedAt), date = new Date(capturedAt);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== capturedAt) throw new RecoveryStoreError("invalid-input");
  const source = origin(value.origin);
  const identity = source.kind === "untitled" ? source.id : pathKey(source.kind === "legacy" ? source.legacyFile : source.folderPath);
  return { recordId: id(value.recordId), revision: Number(value.revision), capturedAt, displayName: text(value.displayName), reason: text(value.reason), origin: source, originId: hash(source.kind + ":" + identity) };
}
function originIdentity(value: unknown): RecoveryOriginIdentity {
  if (!record(value) || typeof value.objectKey !== "string" || !/^\d+:\d+$/.test(value.objectKey)) throw new RecoveryStoreError("invalid-input");
  const folderPath = absolute(value.folderPath);
  const legacyFile = value.legacyFile === undefined ? undefined : absolute(value.legacyFile);
  if (legacyFile && pathKey(path.dirname(legacyFile)) !== pathKey(folderPath)) throw new RecoveryStoreError("invalid-input");
  return { folderPath, objectKey: value.objectKey, ...(legacyFile ? { legacyFile } : {}) };
}
function sameOriginIdentity(a: RecoveryOriginIdentity | undefined, b: RecoveryOriginIdentity | undefined): boolean {
  return Boolean(a && b && a.objectKey === b.objectKey && pathKey(a.folderPath) === pathKey(b.folderPath)
    && (a.legacyFile ? pathKey(a.legacyFile) : undefined) === (b.legacyFile ? pathKey(b.legacyFile) : undefined));
}
function resolution(value: unknown, receipt: RecoveryReceipt): RecoveryResolution {
  if (!record(value) || value.revision !== receipt.revision || value.digest !== receipt.digest || typeof value.sourceDigest !== "string" || !DIGEST.test(value.sourceDigest)) throw new RecoveryStoreError("invalid-record");
  const resolvedAt = text(value.resolvedAt);
  if (!Number.isFinite(Date.parse(resolvedAt)) || new Date(resolvedAt).toISOString() !== resolvedAt) throw new RecoveryStoreError("invalid-record");
  return { revision: receipt.revision, digest: receipt.digest, sourceDigest: value.sourceDigest, resolvedAt, sourceOrigin: origin(value.sourceOrigin), ...(value.sourceIdentity === undefined ? {} : { sourceIdentity: originIdentity(value.sourceIdentity) }) };
}
function serialize(envelope: Envelope): string {
  const contents = JSON.stringify(envelope, (_key, value: unknown) => {
    if (typeof value === "number" && !Number.isFinite(value)) throw new RecoveryStoreError("invalid-project");
    return value;
  }, 2) + "\n";
  if (Buffer.byteLength(contents, "utf8") > MAX_RECOVERY_RECORD_BYTES) throw new RecoveryStoreError("too-large");
  return contents;
}
function capture(value: unknown): Capture {
  if (!record(value)) throw new RecoveryStoreError("invalid-input");
  const meta = metadata(value);
  try {
    const encoded = encodeProjectFile(value.project);
    const digest = hash(encoded.contents), envelope: Envelope = { format: FORMAT, metadata: meta, project: encoded.project, digest };
    return { envelope, contents: serialize(envelope), receipt: { recordId: meta.recordId, revision: meta.revision, digest }, ...(value.originIdentity === undefined ? {} : { originIdentity: originIdentity(value.originIdentity) }) };
  } catch (error) { if (error instanceof RecoveryStoreError) throw error; throw new RecoveryStoreError("invalid-project"); }
}
function fsFailure(error: unknown): RecoveryStoreError {
  if (error instanceof RecoveryStoreError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  return new RecoveryStoreError(code === "ENOENT" ? "missing" : code === "ELOOP" ? "unsafe-entry" : "storage-unavailable");
}
async function readContents(filename: string): Promise<string> {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new RecoveryStoreError("unsafe-entry");
  if (stat.size > MAX_RECOVERY_RECORD_BYTES) throw new RecoveryStoreError("too-large");
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    // No payload is read if a different entry replaced the checked file.
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new RecoveryStoreError("unsafe-entry");
    if (opened.size > MAX_RECOVERY_RECORD_BYTES) throw new RecoveryStoreError("too-large");
    const buffer = Buffer.allocUnsafe(64 * 1024), chunks: Buffer[] = []; let size = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, MAX_RECOVERY_RECORD_BYTES - size + 1), null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > MAX_RECOVERY_RECORD_BYTES) throw new RecoveryStoreError("too-large");
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks, size).toString("utf8");
  } finally { await handle.close(); }
}

function damagedTarget(value: unknown): RecoveryDamagedTarget {
  if (!record(value) || typeof value.fingerprint !== "string" || !DIGEST.test(value.fingerprint)) throw new RecoveryStoreError("invalid-input");
  return { recordId: id(value.recordId), fingerprint: value.fingerprint };
}

/** Local source snapshots only. Origins are metadata, never read/write/activation destinations. */
export class ProjectRecoveryStore {
  private readonly root: string;
  constructor(directory: string) { this.root = absolute(directory); }
  createBranch(): RecoveryBranch {
    const branch = Object.freeze({ id: randomUUID() });
    branches.set(branch, { root: pathKey(this.root), active: true, offset: 0, pending: 0 }); return branch;
  }
  /** Logical retirement is synchronous; physical work retains its claim until the root queue settles. */
  releaseBranch(branch: RecoveryBranch): void {
    const state = branches.get(branch);
    if (state?.root !== pathKey(this.root)) return;
    state.active = false; releaseClaim(branch);
  }
  private file(recordId: string): string { return path.join(this.root, id(recordId) + ".json"); }
  private async rootExists(create = false): Promise<boolean> {
    try {
      if (create) await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
      const stat = await fs.lstat(this.root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RecoveryStoreError("unsafe-entry");
      if (create && (stat.mode & 0o077)) await fs.chmod(this.root, 0o700);
      return true;
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw fsFailure(error);
    }
  }
  /**
   * Record names hold the record-count slots. Bytes count records plus owned temporaries still present (real disk use by a
   * write in flight); unrelated entries count toward neither and are never touched. Stale owned temporaries are swept here.
   * Limited when the scan bound or one record past the record limit is reached: the store then cannot vouch for its usage.
   */
  private async entries(withSizes = false): Promise<{ names: string[]; bytes: number; limited: boolean }> {
    const names: string[] = []; let bytes = 0, limited = false, scanned = 0;
    try {
      for await (const entry of await fs.opendir(this.root)) {
        if (++scanned > MAX_RECOVERY_SCAN_ENTRIES) { limited = true; break; }
        if (TEMPORARY_NAME.test(entry.name)) { const kept = await this.sweepTemporary(entry.name); if (withSizes) bytes += kept; continue; }
        if (!RECORD_NAME.test(entry.name)) continue;
        if (names.length === MAX_RECOVERY_RECORDS) { limited = true; break; }
        names.push(entry.name);
        if (withSizes) {
          try { bytes += (await fs.lstat(path.join(this.root, entry.name))).size; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw fsFailure(error); }
        }
      }
    } catch (error) { throw fsFailure(error); }
    return { names: names.sort(), bytes, limited };
  }
  /** Removes an abandoned owned temporary (a regular file, not being written, untouched for the stale age); returns the bytes it still holds. */
  private async sweepTemporary(name: string): Promise<number> {
    const filename = path.join(this.root, name);
    let stat: Stats;
    try { stat = await fs.lstat(filename); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw fsFailure(error); }
    // A symlink or directory with an owned-looking name is not ours: neither counted nor removed.
    if (!stat.isFile() || stat.isSymbolicLink()) return 0;
    if (writingTemporaries.has(name) || !(Date.now() - stat.mtimeMs >= STALE_RECOVERY_TEMPORARY_MS)) return stat.size;
    try { await fs.unlink(filename); return 0; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? 0 : stat.size; }
  }
  /** Exact identity of a regular record file without reading it; null for anything else. */
  private async fingerprint(recordId: string): Promise<string | null> {
    try {
      const stat = await fs.lstat(this.file(recordId), { bigint: true });
      return stat.isFile() && !stat.isSymbolicLink() ? hash([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":")) : null;
    } catch { return null; }
  }
  private async temporaryWrite(temporary: string, contents: string): Promise<void> {
    writingTemporaries.add(path.basename(temporary));
    await fs.writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }
  private async readRecord(recordId: string): Promise<Capture> {
    let meta: RecoveryMetadata | undefined;
    try {
      const contents = await readContents(this.file(recordId));
      const parsed: unknown = JSON.parse(contents);
      if (!record(parsed)) throw new RecoveryStoreError("invalid-record");
      meta = metadata(parsed.metadata);
      if (meta.recordId !== recordId || !record(parsed.metadata) || meta.originId !== parsed.metadata.originId) throw new RecoveryStoreError("invalid-record", meta);
      if (parsed.format !== FORMAT) throw new RecoveryStoreError("unsupported-version", meta);
      const encoded = encodeProjectFile(parsed.project);
      // Old receipts authenticate the original canonical source, before field migration.
      // Retain those bytes in the envelope when updating resolutions; readSnapshot converts
      // the validated source for the editor without rewriting its historical receipt.
      const legacy = record(parsed.project) && record(parsed.project.field) && parsed.project.field.coordinateSchemaId === "bordeaux-field/1.0";
      const source = legacy ? `${JSON.stringify(parsed.project, null, 2)}\n` : encoded.contents;
      if (typeof parsed.digest !== "string" || !DIGEST.test(parsed.digest) || parsed.digest !== hash(source)) throw new RecoveryStoreError("invalid-record", meta);
      const envelope: Envelope = { format: FORMAT, metadata: meta, project: legacy ? parsed.project as unknown as BordeauxProject : encoded.project, digest: parsed.digest,
        ...(parsed.resolved === undefined ? {} : { resolved: resolution(parsed.resolved, { recordId, revision: meta.revision, digest: parsed.digest }) }) };
      const uncertain = uncertainResolutions.get(pathKey(this.file(recordId)));
      if (uncertain?.revision === meta.revision && uncertain.digest === parsed.digest) delete envelope.resolved;
      else if (uncertain) uncertainResolutions.delete(pathKey(this.file(recordId)));
      // Also reject nonfinite/circular/non-JSON extras before returning source.
      serialize(envelope);
      return { envelope, contents, receipt: { recordId, revision: meta.revision, digest: parsed.digest } };
    } catch (error) {
      if (error instanceof RecoveryStoreError) throw new RecoveryStoreError(error.code, error.metadata ?? meta);
      if (error instanceof SyntaxError) throw new RecoveryStoreError("invalid-record", meta);
      if ((error as NodeJS.ErrnoException).code) throw fsFailure(error);
      throw new RecoveryStoreError("invalid-project", meta);
    }
  }
  private async persist(snapshot: Capture, assertCurrent: () => void = () => {}): Promise<RecoveryWriteReceipt> {
    assertCurrent();
    await this.rootExists(true);
    const { recordId, revision } = snapshot.receipt;
    let previous: Capture | null = null;
    try { previous = await this.readRecord(recordId); }
    catch (error) { if (!(error instanceof RecoveryStoreError) || error.code !== "missing") throw error; }
    assertCurrent();
    const capturedAt = snapshot.envelope.metadata.capturedAt;
    if (previous && previous.receipt.revision > revision) return { ...snapshot.receipt, capturedAt, stored: false, written: false, supersededByRevision: previous.receipt.revision };
    if (previous?.receipt.revision === revision) {
      const { resolved: _resolved, ...previousSource } = previous.envelope;
      if (serialize(previousSource) !== snapshot.contents) throw new RecoveryStoreError("revision-conflict");
      return { ...snapshot.receipt, capturedAt, stored: true, written: false };
    }
    const usage = await this.entries(true);
    const oldBytes = previous ? Buffer.byteLength(previous.contents, "utf8") : 0;
    if (usage.limited || (!previous && usage.names.length >= MAX_RECOVERY_RECORDS)
      || usage.bytes - oldBytes + Buffer.byteLength(snapshot.contents, "utf8") > MAX_RECOVERY_TOTAL_BYTES) throw new RecoveryStoreError("capacity");
    const temporary = path.join(this.root, `.${recordId}.${randomUUID()}.tmp`);
    try {
      assertCurrent();
      await this.temporaryWrite(temporary, snapshot.contents);
      assertCurrent();
      await fs.rename(temporary, this.file(recordId));
      return { ...snapshot.receipt, capturedAt, stored: true, written: true };
    } catch (error) { throw fsFailure(error); }
    finally { await fs.rm(temporary, { force: true }).catch(() => undefined); writingTemporaries.delete(path.basename(temporary)); }
  }
  private async persistBranch(snapshot: Capture, branch: RecoveryBranch | undefined, isCurrent: () => boolean): Promise<RecoveryWriteReceipt> {
    const current = () => { if (!isCurrent()) throw new RecoveryStoreError("revision-conflict"); };
    current();
    if (!branch) {
      if (claimedRecords.has(pathKey(this.file(snapshot.receipt.recordId)))) throw new RecoveryStoreError("revision-conflict");
      return this.persist(snapshot, current);
    }
    const state = branchState(branch, this.root), guard = () => { current(); branchState(branch, this.root); };
    if (!state.recordId) {
      let reusable: Capture | undefined;
      if (await this.rootExists()) {
        for (const name of (await this.entries()).names) {
          if (claimedRecords.has(pathKey(path.join(this.root, name)))) continue;
          try {
            const candidate = await this.readRecord(name.slice(0, -5));
            if (candidate.envelope.resolved && sameOriginIdentity(candidate.envelope.resolved.sourceIdentity, snapshot.originIdentity)
              && (!reusable || candidate.envelope.resolved.resolvedAt > reusable.envelope.resolved!.resolvedAt)) reusable = candidate;
          } catch { /* An unreadable/unresolved record is never a reuse victim. */ }
        }
      }
      guard(); state.recordId = reusable?.receipt.recordId ?? snapshot.receipt.recordId; state.offset = reusable?.receipt.revision ?? 0;
      claimedRecords.set(pathKey(this.file(state.recordId)), branch);
    }
    const revision = state.offset + snapshot.receipt.revision;
    if (!Number.isSafeInteger(revision)) throw new RecoveryStoreError("revision-conflict");
    const envelope = { ...snapshot.envelope, metadata: { ...snapshot.envelope.metadata, recordId: state.recordId, revision } };
    const effective = { envelope, contents: serialize(envelope), receipt: { ...snapshot.receipt, recordId: state.recordId, revision } };
    try { return { ...await this.persist(effective, guard), requested: { recordId: snapshot.receipt.recordId, revision: snapshot.receipt.revision } }; }
    catch (error) {
      // A failed creation does not reserve a nonexistent quota slot indefinitely.
      try { await this.readRecord(state.recordId); } catch (readError) {
        if (readError instanceof RecoveryStoreError && readError.code === "missing") { claimedRecords.delete(pathKey(this.file(state.recordId))); state.recordId = undefined; state.offset = 0; }
      }
      throw error;
    }
  }
  /** Captures before awaiting; one running write and one latest queued successor per ID/branch. */
  async writeSnapshot(value: RecoveryWriteRequest, branch?: RecoveryBranch, isCurrent: () => boolean = () => true): Promise<RecoveryWriteReceipt> {
    const snapshot = capture(value);
    if (branch) branchState(branch, this.root);
    const key = branch ? pathKey(this.root) + ":branch:" + branch.id : pathKey(this.file(snapshot.receipt.recordId)), existing = queuedWrites.get(key);
    if (existing) {
      const prior = existing.capture.receipt;
      if (prior.revision > snapshot.receipt.revision) return { ...snapshot.receipt, capturedAt: snapshot.envelope.metadata.capturedAt, stored: false, written: false, supersededByRevision: prior.revision };
      if (prior.revision === snapshot.receipt.revision && existing.capture.contents !== snapshot.contents) throw new RecoveryStoreError("revision-conflict");
      existing.resolve({ ...prior, capturedAt: existing.capture.envelope.metadata.capturedAt, stored: false, written: false, supersededByRevision: snapshot.receipt.revision });
      existing.capture = snapshot; existing.isCurrent = isCurrent;
      return new Promise((resolve, reject) => { existing.resolve = resolve; existing.reject = reject; });
    }
    return new Promise((resolve, reject) => {
      const queued: QueuedWrite = { capture: snapshot, branch, isCurrent, resolve, reject };
      if (branch) branchState(branch, this.root).pending++;
      queuedWrites.set(key, queued);
      void serial(this.root, async () => {
        queuedWrites.delete(key);
        try { queued.resolve(await this.persistBranch(queued.capture, queued.branch, queued.isCurrent)); } catch (error) { queued.reject(fsFailure(error)); }
        finally { if (branch) { const state = branches.get(branch)!; state.pending--; releaseClaim(branch); } }
      });
    });
  }
  async readSnapshot(rawId: string): Promise<RecoverySnapshot> {
    const recordId = id(rawId);
    return serial(this.root, async () => {
      if (!await this.rootExists()) throw new RecoveryStoreError("missing");
      const stored = await this.readRecord(recordId);
      return { ...stored.envelope.metadata, project: prepareProjectFile(stored.envelope.project), receipt: stored.receipt, ...(stored.envelope.resolved ? { resolved: stored.envelope.resolved } : {}) };
    });
  }
  async listSnapshots(): Promise<RecoveryListing> {
    return serial(this.root, async () => {
      if (!await this.rootExists()) return { entries: [], limited: false, capacity: { recordCount: 0, recordLimit: MAX_RECOVERY_RECORDS, bytes: 0, byteLimit: MAX_RECOVERY_TOTAL_BYTES, full: false } };
      const found = await this.entries(true), entries: RecoverySummary[] = [];
      for (const name of found.names) {
        const recordId = name.slice(0, -5), base = { entryId: hash(name), recordId, active: claimedRecords.has(pathKey(path.join(this.root, name))) };
        const before = await this.fingerprint(recordId);
        try {
          const stored = await this.readRecord(recordId);
          entries.push({ ...base, status: "available", metadata: stored.envelope.metadata, receipt: stored.receipt, ...(stored.envelope.resolved ? { resolved: stored.envelope.resolved } : {}) });
        } catch (error) {
          const failure = fsFailure(error);
          // Only the exact file judged damaged is identified; one replaced meanwhile gets no fingerprint (no discard).
          const fingerprint = DAMAGED.has(failure.code) && before && before === await this.fingerprint(recordId) ? before : undefined;
          entries.push({ ...base, status: "unavailable", metadata: failure.metadata, code: failure.code, detail: failure.message, ...(fingerprint ? { fingerprint } : {}) });
        }
      }
      return { entries, limited: found.limited, capacity: { recordCount: found.names.length, recordLimit: MAX_RECOVERY_RECORDS, bytes: found.bytes, byteLimit: MAX_RECOVERY_TOTAL_BYTES, full: found.limited || found.names.length >= MAX_RECOVERY_RECORDS || found.bytes >= MAX_RECOVERY_TOTAL_BYTES } };
    });
  }
  /** Main's admitted source mapping only; this metadata never grants departure/source authority. */
  async markResolved(receipt: RecoveryReceipt, source: { digest: string; origin: RecoveryOrigin; identity?: RecoveryOriginIdentity }, isCurrent: () => boolean = () => true): Promise<boolean> {
    const recordId = id(receipt?.recordId), expected = structuredClone(receipt);
    const resolved = resolution({ revision: expected.revision, digest: expected.digest, sourceDigest: source.digest, sourceOrigin: source.origin, sourceIdentity: source.identity, resolvedAt: new Date().toISOString() }, expected);
    const branch = claimedRecords.get(pathKey(this.file(recordId))), state = branch && branches.get(branch);
    if (state) state.pending++;
    return serial(this.root, async () => {
      if (!isCurrent() || !await this.rootExists()) return false;
      let current: Capture;
      try { current = await this.readRecord(recordId); } catch (error) { if (error instanceof RecoveryStoreError && error.code === "missing") return false; throw error; }
      if (!isCurrent() || current.receipt.revision !== expected.revision || current.receipt.digest !== expected.digest) return false;
      if (current.envelope.resolved) return true;
      const contents = serialize({ ...current.envelope, resolved });
      const usage = await this.entries(true);
      if (usage.limited || usage.bytes - Buffer.byteLength(current.contents, "utf8") + Buffer.byteLength(contents, "utf8") > MAX_RECOVERY_TOTAL_BYTES) throw new RecoveryStoreError("capacity");
      if (!isCurrent()) return false;
      const temporary = path.join(this.root, `.${recordId}.${randomUUID()}.tmp`);
      try {
        await this.temporaryWrite(temporary, contents);
        if (!isCurrent()) return false;
        await fs.rename(temporary, this.file(recordId));
        if (!isCurrent()) {
          // Rename is not cancellable. Keep the root queue/physical claim through rollback.
          // Even if rollback fails, this process must keep the exact record visible and non-reusable.
          uncertainResolutions.set(pathKey(this.file(recordId)), expected);
          await this.temporaryWrite(temporary, serialize(current.envelope));
          await fs.rename(temporary, this.file(recordId));
          uncertainResolutions.delete(pathKey(this.file(recordId))); return false;
        }
        uncertainResolutions.delete(pathKey(this.file(recordId)));
        return true;
      } catch (error) { throw fsFailure(error); }
      finally { await fs.rm(temporary, { force: true }).catch(() => undefined); writingTemporaries.delete(path.basename(temporary)); }
    }).finally(() => { if (branch && state) { state.pending--; releaseClaim(branch); } });
  }
  /** Explicit user discard only; an old receipt cannot delete a newer or changed source. */
  async removeSnapshot(receipt: RecoveryReceipt, isCurrent: () => boolean = () => true): Promise<boolean> {
    receipt = structuredClone(receipt);
    const recordId = id(receipt?.recordId);
    if (!Number.isSafeInteger(receipt.revision) || receipt.revision < 0 || !DIGEST.test(receipt.digest)) throw new RecoveryStoreError("invalid-input");
    return serial(this.root, async () => {
      if (!isCurrent() || !await this.rootExists() || claimedRecords.has(pathKey(this.file(recordId)))) return false;
      let current: Capture;
      try { current = await this.readRecord(recordId); }
      catch (error) { if (error instanceof RecoveryStoreError && error.code === "missing") return false; throw error; }
      if (!isCurrent() || current.receipt.revision !== receipt.revision || current.receipt.digest !== receipt.digest) return false;
      try { await fs.unlink(this.file(recordId)); uncertainResolutions.delete(pathKey(this.file(recordId))); return true; } catch (error) { throw fsFailure(error); }
    });
  }
  /** Unclaimed, the same regular file as listed, and still failing to read as damaged. Runs inside the root queue. */
  private async stillDamaged(recordId: string, fingerprint: string): Promise<boolean> {
    if (!await this.rootExists() || claimedRecords.has(pathKey(this.file(recordId))) || await this.fingerprint(recordId) !== fingerprint) return false;
    try { await this.readRecord(recordId); return false; }
    catch (error) { return error instanceof RecoveryStoreError && DAMAGED.has(error.code) && await this.fingerprint(recordId) === fingerprint; }
  }
  async verifyDamagedSnapshot(target: RecoveryDamagedTarget): Promise<boolean> {
    const { recordId, fingerprint } = damagedTarget(target);
    return serial(this.root, () => this.stillDamaged(recordId, fingerprint));
  }
  /** Explicit user discard of a damaged record only; a changed, repaired, claimed or non-regular entry is never removed. */
  async removeDamagedSnapshot(target: RecoveryDamagedTarget, isCurrent: () => boolean = () => true): Promise<boolean> {
    const { recordId, fingerprint } = damagedTarget(target);
    return serial(this.root, async () => {
      if (!isCurrent() || !await this.stillDamaged(recordId, fingerprint) || !isCurrent()) return false;
      try { await fs.unlink(this.file(recordId)); uncertainResolutions.delete(pathKey(this.file(recordId))); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw fsFailure(error); }
    });
  }
}
