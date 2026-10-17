import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { RobotFileConnection, RobotFileEndpoint, RobotFilePreview, RobotFileResult, RobotFileSettings } from "../shared/robotFileDelivery";
import { DEFAULT_ROBOT_PATH_DIRECTORY } from "../shared/robotFileDelivery";
import { writeJsonAtomically } from "./projectFiles";
import { probeRobotFiles, uploadRobotFiles, validateRobotFileEndpoint } from "./robotFileTransfer";

export interface PreparedRobotFile { pathId: string; name: string; fileName: string; contents: Buffer }
function connection(value: unknown): RobotFileConnection {
  const raw = value as Partial<RobotFileConnection> | null;
  if (!raw || typeof raw.hostKeyFingerprint !== "string" || !/^SHA256:[A-Za-z0-9+/]{20,128}$/.test(raw.hostKeyFingerprint)) throw new Error("Saved robot SSH identity is invalid");
  return { endpoint: validateRobotFileEndpoint(raw.endpoint), hostKeyFingerprint: raw.hostKeyFingerprint };
}
function settings(value: unknown): RobotFileSettings {
  const raw = value as Partial<RobotFileSettings> | null;
  if (raw?.hostKeyFingerprint !== undefined) return connection(value);
  return { endpoint: validateRobotFileEndpoint(raw?.endpoint) };
}
export async function readRobotFileConnection(file: string): Promise<RobotFileSettings | null> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("Saved robot SSH identity is invalid");
    const saved = settings(JSON.parse(await fs.readFile(file, "utf8")));
    // Correct the former default without discarding the remembered SSH identity.
    // The new destination remains visible in every immutable upload review.
    if (saved.endpoint.directory === "/natinst/bin/Paths") saved.endpoint.directory = DEFAULT_ROBOT_PATH_DIRECTORY;
    return saved;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export async function writeRobotFileConnection(file: string, value: RobotFileSettings): Promise<void> {
  const normalized = settings(value);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeJsonAtomically(file, normalized);
}

/** Reviewed bytes and SSH destination are immutable until this single-use transfer completes. */
export class RobotFileDelivery {
  private trusted: RobotFileConnection | null;
  private saved: RobotFileSettings | null;
  private observed: RobotFileConnection | null = null;
  private generation = 0;
  private trusting = false;
  private pending: { preview: RobotFilePreview; files: PreparedRobotFile[]; validate: () => Promise<void> } | null = null;
  private active: { id: string; controller: AbortController; done: Promise<RobotFileResult> } | null = null;
  constructor(initial: RobotFileSettings | null, private readonly persist: (value: RobotFileSettings) => Promise<void>,
    private readonly transport = { probe: probeRobotFiles, upload: uploadRobotFiles }) {
    this.saved = initial ? settings(initial) : null;
    this.trusted = this.saved?.hostKeyFingerprint ? connection(this.saved) : null;
  }
  current(): RobotFileConnection | null { return structuredClone(this.trusted); }
  settings(): RobotFileSettings | null { return structuredClone(this.saved); }
  async saveSettings(endpoint: RobotFileEndpoint): Promise<RobotFileSettings> {
    if (this.active || this.trusting) throw new Error("Finish the current robot operation before editing settings");
    const normalized = validateRobotFileEndpoint(endpoint);
    const fingerprint = this.trusted?.endpoint.host === normalized.host && this.trusted.endpoint.port === normalized.port
      ? this.trusted.hostKeyFingerprint : undefined;
    const value: RobotFileSettings = { endpoint: normalized, ...(fingerprint ? { hostKeyFingerprint: fingerprint } : {}) };
    this.generation++;
    this.observed = null; this.pending = null;
    this.trusting = true;
    try {
      await this.persist(value);
      this.saved = value;
      this.trusted = fingerprint ? connection(value) : null;
      return structuredClone(value);
    } finally { this.trusting = false; }
  }
  async probe(endpoint: RobotFileEndpoint): Promise<RobotFileConnection> {
    if (this.active || this.trusting) throw new Error("Finish the current robot operation before connecting another robot");
    const generation = ++this.generation;
    this.observed = null; this.pending = null;
    const result = connection(await this.transport.probe(endpoint));
    if (generation !== this.generation) throw new Error("A newer connection replaced this probe");
    this.observed = result;
    return structuredClone(result);
  }
  async trust(fingerprint: string): Promise<RobotFileConnection> {
    if (this.active || this.trusting || !this.observed || fingerprint !== this.observed.hostKeyFingerprint) throw new Error("Connect and review the SSH identity before trusting this robot");
    this.trusting = true;
    const value = structuredClone(this.observed);
    try { await this.persist(value); this.saved = value; this.trusted = value; this.observed = null; this.pending = null; return structuredClone(value); }
    finally { this.trusting = false; }
  }
  prepare(files: PreparedRobotFile[], validate: () => Promise<void>): RobotFilePreview {
    if (!this.trusted || this.active || this.trusting) throw new Error("Connect a robot before preparing this transfer");
    if (!files.length || files.length > 64) throw new Error("Select between 1 and 64 paths to push");
    if (new Set(files.map(file => file.fileName.toLowerCase())).size !== files.length) throw new Error("Selected paths have matching BDX filenames. Rename them before pushing together");
    if (files.some(file => !file.contents.length) || files.reduce((sum, file) => sum + file.contents.length, 0) > 24 * 1024 * 1024) throw new Error("Selected BDX files exceed the 24 MB transfer limit");
    const frozen = files.map(file => ({ ...file, contents: Buffer.from(file.contents) }));
    const preview: RobotFilePreview = { operationId: randomUUID(), connection: structuredClone(this.trusted), files: frozen.map(({ contents, ...file }) => ({ ...file, size: contents.length, sha256: createHash("sha256").update(contents).digest("hex") })) };
    this.pending = { preview, files: frozen, validate };
    return structuredClone(preview);
  }
  async confirm(id: string): Promise<RobotFileResult> {
    const pending = this.pending;
    if (this.active || !pending || pending.preview.operationId !== id) throw new Error("Review the selected files again before pushing");
    this.pending = null;
    const controller = new AbortController();
    const done = Promise.resolve().then(async (): Promise<RobotFileResult> => {
      await pending.validate();
      controller.signal.throwIfAborted();
      const uploaded = await this.transport.upload(pending.preview.connection, pending.files, controller.signal);
      return { state: "transferred", files: structuredClone(pending.preview.files), directory: pending.preview.connection.endpoint.directory, directoryCreated: uploaded.directoryCreated };
    });
    this.active = { id, controller, done };
    try { return await done; } finally { this.active = null; }
  }
  cancel(id: string): { canceled: boolean } {
    if (this.pending?.preview.operationId === id) { this.pending = null; return { canceled: true }; }
    if (this.active?.id === id) { this.active.controller.abort(); return { canceled: true }; }
    return { canceled: false };
  }
  async stop(): Promise<void> { this.generation++; this.pending = null; this.observed = null; this.active?.controller.abort(); await this.active?.done.catch(() => undefined); }
}
