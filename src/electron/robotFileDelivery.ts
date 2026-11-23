import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { RobotFileConnection, RobotFileEndpoint, RobotFilePreview, RobotFileReading, RobotFileResult, RobotFileSettings, RobotPasswordChange, RobotPasswordStatus } from "../core/robotFileDelivery";
import { DEFAULT_ROBOT_PATH_DIRECTORY } from "../core/robotFileDelivery";
import { COMMANDS_FILE_NAME } from "../core/export/commandsFile";
import { LEGACY_ROBOT_TARGET, ROBOT_TARGETS, allowsCustomPassword } from "../core/robotTargets";
import { writeJsonAtomically } from "./projectFiles";
import { sessionRobotPasswordStore, type RobotPasswordStore } from "./robotPasswordStore";
import { discoverRobotSshIdentity } from "./robotSsh2Session";
import { probeRobotFiles, readRobotFiles, uploadRobotFiles, validateRobotFileEndpoint } from "./robotFileTransfer";

/** Validates a password change arriving over IPC; omitted means keep the password in effect. */
export function robotPasswordChange(raw: unknown): RobotPasswordChange {
  if (raw === undefined) return { kind: "keep" };
  const value = raw as Partial<{ kind: unknown; password: unknown }> | null;
  if (value && typeof value === "object" && (value.kind === "keep" || value.kind === "default")) return { kind: value.kind };
  if (value && typeof value === "object" && value.kind === "custom") {
    if (typeof value.password !== "string" || !value.password.length || value.password.length > 256) throw new Error("A custom SSH password must contain 1–256 characters");
    return { kind: "custom", password: value.password };
  }
  throw new Error("Robot SSH password change is invalid");
}

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
    const raw: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    // Files written before robot types existed have no target; they always described a roboRIO.
    const endpoint = raw && typeof raw === "object" && "endpoint" in raw ? raw.endpoint : null;
    if (endpoint && typeof endpoint === "object" && !("target" in endpoint)) Object.assign(endpoint, { target: LEGACY_ROBOT_TARGET });
    const saved = settings(raw);
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

interface RobotFileTransport {
  probe(endpoint: RobotFileEndpoint, timeoutMs?: number, password?: string | null, expectedHostKeyFingerprint?: string): Promise<RobotFileConnection>;
  discover?(endpoint: RobotFileEndpoint): Promise<RobotFileConnection>;
  upload(connection: RobotFileConnection, files: Array<{ fileName: string; contents: Buffer }>, signal?: AbortSignal, password?: string | null): Promise<{ directoryCreated: boolean }>;
  read?(connection: RobotFileConnection, fileNames: string[], signal?: AbortSignal, password?: string | null): Promise<RobotFileReading["files"]>;
}

/**
 * Reviewed bytes and SSH destination are immutable until this single-use transfer completes.
 * A custom SSH password takes effect only when Save or Trust commits it; probes never do.
 */
export class RobotFileDelivery {
  private trusted: RobotFileConnection | null;
  private saved: RobotFileSettings | null;
  private observed: RobotFileConnection | null = null;
  private observedPassword: string | null = null;
  private observedNeedsLogin = false;
  private generation = 0;
  private trusting = false;
  private pending: { preview: RobotFilePreview; files: PreparedRobotFile[]; validate: () => Promise<void> } | null = null;
  private active: { id: string; controller: AbortController; done: Promise<RobotFileResult> } | null = null;
  constructor(initial: RobotFileSettings | null, private readonly persist: (value: RobotFileSettings) => Promise<void>,
    private readonly transport: RobotFileTransport = {
      discover: async (endpoint) => ({ endpoint, hostKeyFingerprint: await discoverRobotSshIdentity(endpoint) }),
      probe: (endpoint: RobotFileEndpoint, timeoutMs?: number, password?: string | null, expectedHostKeyFingerprint?: string) => probeRobotFiles(endpoint, undefined, timeoutMs, password ?? null, expectedHostKeyFingerprint),
      upload: (connection: RobotFileConnection, files: Array<{ fileName: string; contents: Buffer }>, signal?: AbortSignal, password?: string | null) =>
        uploadRobotFiles(connection, files, signal, undefined, password ?? null),
      read: (connection: RobotFileConnection, fileNames: string[], signal?: AbortSignal, password?: string | null) =>
        readRobotFiles(connection, fileNames, signal, undefined, password ?? null),
    },
    private readonly passwords: RobotPasswordStore = sessionRobotPasswordStore()) {
    this.saved = initial ? settings(initial) : null;
    this.trusted = this.saved?.hostKeyFingerprint ? connection(this.saved) : null;
  }
  current(): RobotFileConnection | null { return structuredClone(this.trusted); }
  settings(): RobotFileSettings | null { return structuredClone(this.saved); }
  passwordStatus(): RobotPasswordStatus { return { custom: this.passwords.current() !== null, persistent: this.passwords.persistent }; }
  /** The password a login to `endpoint` uses after `change`; null means the robot type's default. */
  private passwordFor(endpoint: RobotFileEndpoint, change: RobotPasswordChange): string | null {
    if (change.kind === "custom") {
      if (!allowsCustomPassword(endpoint.target)) throw new Error(`${ROBOT_TARGETS[endpoint.target].label} logs in without a password`);
      return change.password;
    }
    if (change.kind === "keep" && allowsCustomPassword(endpoint.target) && this.passwords.current() !== null
      && (this.saved?.endpoint.host !== endpoint.host || this.saved.endpoint.port !== endpoint.port || this.saved.endpoint.target !== endpoint.target)) {
      throw new Error("Enter the SSH password or choose the default before connecting a different robot");
    }
    return change.kind === "keep" && allowsCustomPassword(endpoint.target) ? this.passwords.current() : null;
  }
  private async commitPassword(password: string | null): Promise<void> {
    await this.passwords.replace(password);
  }
  /** Read-only liveness check: never changes SSH trust, a file review, or an upload. */
  async checkConnection(): Promise<RobotFileConnection | null> {
    const trusted = this.trusted, generation = this.generation;
    if (!trusted || this.trusting) return null;
    try {
      const observed = connection(await this.transport.probe(trusted.endpoint, 5_000, this.passwordFor(trusted.endpoint, { kind: "keep" }), trusted.hostKeyFingerprint));
      if (generation !== this.generation || trusted !== this.trusted || observed.hostKeyFingerprint !== trusted.hostKeyFingerprint
        || observed.endpoint.host !== trusted.endpoint.host || observed.endpoint.port !== trusted.endpoint.port) return null;
      return structuredClone(trusted);
    } catch { return null; }
  }
  /**
   * Reads the named files from the trusted robot's push folder, for comparing with local paths. Read-only: it changes
   * nothing on the robot, in SSH trust, or in a file review that is waiting to be confirmed. The result names the
   * connection it read, so a caller can discard one that arrives after the robot settings changed.
   */
  async read(rawFileNames: unknown): Promise<RobotFileReading> {
    const trusted = this.trusted;
    if (!trusted || this.trusting) throw new Error("Connect a robot before reading its files");
    if (!this.transport.read) throw new Error("Reading robot files is unavailable");
    const names: unknown[] | null = Array.isArray(rawFileNames) ? rawFileNames : null;
    if (!names?.every((name): name is string => typeof name === "string")) throw new Error("Name the robot files to read");
    const files = await this.transport.read(trusted, names, undefined, this.passwordFor(trusted.endpoint, { kind: "keep" }));
    return { connection: structuredClone(trusted), readAt: new Date().toISOString(), files };
  }
  async saveSettings(endpoint: RobotFileEndpoint, rawPassword?: unknown): Promise<RobotFileSettings> {
    if (this.active || this.trusting) throw new Error("Finish the current robot operation before editing settings");
    const change = robotPasswordChange(rawPassword);
    const normalized = validateRobotFileEndpoint(endpoint);
    const password = this.passwordFor(normalized, change);
    // Trust covers a login that was tried: the same host, port, robot type (account) and password.
    const fingerprint = this.trusted?.endpoint.host === normalized.host && this.trusted.endpoint.port === normalized.port
      && this.trusted.endpoint.target === normalized.target && password === this.passwords.current() ? this.trusted.hostKeyFingerprint : undefined;
    const value: RobotFileSettings = { endpoint: normalized, ...(fingerprint ? { hostKeyFingerprint: fingerprint } : {}) };
    this.generation++;
    this.observed = null; this.observedPassword = null; this.pending = null;
    this.trusting = true;
    try {
      await this.commitSettings(value, password);
      return structuredClone(value);
    } finally { this.trusting = false; }
  }
  async probe(endpoint: RobotFileEndpoint, rawPassword?: unknown): Promise<RobotFileConnection> {
    if (this.active || this.trusting) throw new Error("Finish the current robot operation before connecting another robot");
    const change = robotPasswordChange(rawPassword);
    const normalized = validateRobotFileEndpoint(endpoint);
    const password = this.passwordFor(normalized, change);
    const generation = ++this.generation;
    this.observed = null; this.observedPassword = null; this.pending = null;
    const needsLogin = password !== null;
    if (needsLogin && !this.transport.discover) throw new Error("SSH identity discovery is unavailable");
    const result = connection(needsLogin ? await this.transport.discover!(normalized) : await this.transport.probe(normalized, undefined, password));
    if (generation !== this.generation) throw new Error("A newer connection replaced this probe");
    this.observed = result; this.observedPassword = password; this.observedNeedsLogin = needsLogin;
    return structuredClone(result);
  }
  async trust(fingerprint: string): Promise<RobotFileConnection> {
    if (this.active || this.trusting || !this.observed || fingerprint !== this.observed.hostKeyFingerprint) throw new Error("Connect and review the SSH identity before trusting this robot");
    this.trusting = true;
    const value = structuredClone(this.observed);
    try {
      if (this.observedNeedsLogin) {
        const authenticated = connection(await this.transport.probe(value.endpoint, undefined, this.observedPassword, value.hostKeyFingerprint));
        if (authenticated.hostKeyFingerprint !== value.hostKeyFingerprint) throw new Error("The robot SSH host key changed; connect and review its identity again");
        this.observedNeedsLogin = false;
      }
      await this.commitSettings(value, this.observedPassword);
      this.observed = null; this.observedPassword = null; this.pending = null;
      return structuredClone(value);
    }
    finally { this.trusting = false; }
  }
  private async commitSettings(value: RobotFileSettings, password: string | null): Promise<void> {
    // Revoke the old identity before replacing credentials. Clear its password before moving
    // the saved endpoint, so a crash or rejected write cannot associate an old secret with a new robot.
    const previous = this.saved ? { endpoint: this.saved.endpoint } : null;
    if (previous) {
      await this.persist(previous);
      this.saved = previous; this.trusted = null;
    }
    await this.commitPassword(null);
    const unverified = { endpoint: value.endpoint };
    if (!previous || JSON.stringify(previous.endpoint) !== JSON.stringify(value.endpoint)) {
      await this.persist(unverified);
      this.saved = unverified;
    }
    this.trusted = null;
    if (password !== null) await this.commitPassword(password);
    if (value.hostKeyFingerprint) await this.persist(value);
    this.saved = value;
    this.trusted = value.hostKeyFingerprint ? connection(value) : null;
  }

  cancelProbe(): void {
    if (this.trusting) return;
    this.generation++;
    this.observed = null; this.observedPassword = null;
  }
  prepare(files: PreparedRobotFile[], validate: () => Promise<void>): RobotFilePreview {
    if (!this.trusted || this.active || this.trusting) throw new Error("Connect a robot before preparing this transfer");
    // A SystemCore push adds the LabVIEW command list; it does not count toward the 64 paths.
    const paths = files.filter(file => file.fileName !== COMMANDS_FILE_NAME).length;
    if (!paths || paths > 64) throw new Error("Select between 1 and 64 paths to push");
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
      const target = pending.preview.connection.endpoint;
      const uploaded = await this.transport.upload(pending.preview.connection, pending.files, controller.signal, this.passwordFor(target, { kind: "keep" }));
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
  async stop(): Promise<void> { this.generation++; this.pending = null; this.observed = null; this.observedPassword = null; this.active?.controller.abort(); await this.active?.done.catch(() => undefined); }
}
