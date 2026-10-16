import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ProjectRecoveryListing, ProjectRecoveryListOptions, ProjectRecoveryDiscardConfirmation, ProjectRecoverySummary } from "../shared/project/projectPersistence";
import { MAX_RECOVERY_RECORDS, ProjectRecoveryStore } from "./projectRecoveryStore";

/** Displayed-entry admission for listing, reveal and explicit exact-revision discard. A renderer ID never becomes an arbitrary file path. */
export class ProjectRecoveryCatalog {
  private readonly files = new Map<string, string>();
  private readonly displayed = new Map<string, ProjectRecoverySummary>();
  private pendingDiscard: { token: string; owner: string; entry: ProjectRecoverySummary } | null = null;
  private readonly root: string;
  private generation = 0;
  private discardGeneration = 0;
  constructor(root: string, private readonly store: ProjectRecoveryStore, private readonly revealFile: (filename: string) => void) {
    if (!path.isAbsolute(root)) throw new Error("Recovery catalog needs its trusted storage directory");
    this.root = path.resolve(root);
  }
  async list(options: ProjectRecoveryListOptions = {}): Promise<ProjectRecoveryListing> {
    const generation = ++this.generation, files = new Map<string, string>();
    this.files.clear(); this.displayed.clear(); this.pendingDiscard = null; this.discardGeneration++;
    const listing = await this.store.listSnapshots();
    const visible = listing.entries.filter(entry => options.includeResolved === true || !entry.resolved);
    const expected = new Map(visible.map(entry => [entry.entryId, entry]));
    if (expected.size) {
      try {
        let count = 0;
        for await (const file of await fs.opendir(this.root)) {
          if (++count > MAX_RECOVERY_RECORDS) break;
          const entry = expected.get(createHash("sha256").update(file.name).digest("hex"));
          if (entry) files.set(entry.status === "available" && entry.recordId ? entry.recordId : entry.entryId, file.name);
        }
      } catch { throw new Error("Recovery storage is unavailable"); }
    }
    if (generation === this.generation) for (const [id, filename] of files) this.files.set(id, filename);
    const result: ProjectRecoveryListing = { limited: listing.limited, capacity: listing.capacity, entries: visible.map(entry => ({
      id: entry.status === "available" && entry.recordId ? entry.recordId : entry.entryId, recordId: entry.recordId,
      name: entry.metadata?.displayName ?? "Recovery copy", available: entry.status === "available", discardable: entry.status === "available" && !entry.active,
      ...(entry.resolved ? { resolved: { at: entry.resolved.resolvedAt, sourceDigest: entry.resolved.sourceDigest } } : {}),
      ...(entry.metadata ? { origin: entry.metadata.origin, updatedAt: entry.metadata.capturedAt } : {}),
      ...(entry.receipt ? { receipt: entry.receipt } : {}), ...(entry.code ? { code: entry.code, fact: entry.detail } : {}),
    })) };
    if (generation === this.generation) for (const entry of result.entries) this.displayed.set(entry.id, entry);
    return result;
  }
  async prepareDiscard(id: unknown, owner: string): Promise<ProjectRecoveryDiscardConfirmation> {
    const discardGeneration = ++this.discardGeneration;
    this.pendingDiscard = null;
    const entry = typeof id === "string" ? this.displayed.get(id) : undefined;
    if (!entry?.discardable || !entry.receipt || !entry.recordId) throw new Error("This recovery copy cannot be discarded from the displayed list");
    const generation = this.generation, snapshot = await this.store.readSnapshot(entry.recordId);
    if (generation !== this.generation || discardGeneration !== this.discardGeneration || snapshot.receipt.revision !== entry.receipt.revision || snapshot.receipt.digest !== entry.receipt.digest) throw new Error("Recovery copy changed. Refresh the list before discarding it.");
    const token = randomUUID(); this.pendingDiscard = { token, owner, entry: structuredClone(entry) };
    return { token, id: entry.id, name: entry.name, updatedAt: entry.updatedAt };
  }
  async discard(token: unknown, owner: string, isCurrent: () => boolean = () => true): Promise<{ removed: boolean }> {
    const pending = this.pendingDiscard;
    if (!pending || token !== pending.token || owner !== pending.owner || !isCurrent()) throw new Error("Recovery discard confirmation is no longer current");
    this.pendingDiscard = null;
    const removed = await this.store.removeSnapshot(pending.entry.receipt!, isCurrent);
    if (removed) { this.files.delete(pending.entry.id); this.displayed.delete(pending.entry.id); }
    return { removed };
  }
  async reveal(id: unknown): Promise<void> {
    const filename = typeof id === "string" ? this.files.get(id) : undefined;
    if (!filename) throw new Error("Recovery is no longer in the displayed list");
    try {
      const stat = await fs.lstat(this.root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    } catch { throw new Error("Recovery storage is unavailable"); }
    this.revealFile(path.join(this.root, filename));
  }
}
