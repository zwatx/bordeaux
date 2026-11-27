import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { RobotFileConnection, RobotFileEndpoint, RobotFilePreview, RobotFileReading, RobotFileResult, RobotFileSettings, RobotPasswordChange, RobotPasswordStatus, RobotPathComparison, RobotPathCopyResult, RobotPathFiles, RobotPathInventory } from "../core/robotFileDelivery";
import { DEFAULT_ROBOT_PATH_DIRECTORY } from "../core/robotFileDelivery";
import { binaryFileName } from "../core/export/robotBinary";
import { pairRobotPathFiles, type LocalRobotPath } from "./robotPathInventory";
import { compareRobotPath, inspectDeployedPath } from "./robotPathDifference";
import { COMMANDS_FILE_NAME } from "../core/export/commandsFile";
import { LEGACY_ROBOT_TARGET, ROBOT_TARGETS, allowsCustomPassword } from "../core/robotTargets";
import { writeJsonAtomically } from "./projectFiles";
import { sessionRobotPasswordStore, type RobotPasswordStore } from "./robotPasswordStore";
import { discoverRobotSshIdentity } from "./robotSsh2Session";
import { listRobotPathFiles, probeRobotFiles, readRobotFiles, readRobotPathFile, uploadRobotFiles, validateRobotFileEndpoint } from "./robotFileTransfer";

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
/** Saves the active robot, or removes it when `value` is null (a project robot without an address is selected). */
export async function writeRobotFileConnection(file: string, value: RobotFileSettings | null): Promise<void> {
  if (value === null) { await fs.rm(file, { force: true }); return; }
  const normalized = settings(value);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeJsonAtomically(file, normalized);
}

/**
 * Host keys reviewed on this computer, keyed by robot type, host and port, like SSH's known_hosts. Projects name robot
 * addresses but never carry keys; a key reviewed once here is trusted again when a project robot names that address.
 */
export interface KnownRobotHosts { get(key: string): string | undefined; set(key: string, fingerprint: string): Promise<void> }
const MAX_KNOWN_HOSTS = 64;
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{20,128}$/;
export const knownHostKey = (endpoint: RobotFileEndpoint): string => `${endpoint.target}|${endpoint.host.toLowerCase()}|${endpoint.port}`;
function knownHosts(initial: Iterable<[string, string]>, write: (hosts: Record<string, string>) => Promise<void>): KnownRobotHosts {
  let hosts = new Map(initial);
  return {
    get: (key) => hosts.get(key),
    async set(key, fingerprint) {
      if (!FINGERPRINT.test(fingerprint) || hosts.get(key) === fingerprint) return;
      const next = new Map(hosts);
      next.delete(key); next.set(key, fingerprint);
      // The oldest review goes first once the list is full.
      while (next.size > MAX_KNOWN_HOSTS) next.delete(next.keys().next().value!);
      await write(Object.fromEntries(next));
      hosts = next;
    },
  };
}
/** Known hosts for tests and hosts without a profile folder: forgotten on restart. */
export const memoryKnownHosts = (): KnownRobotHosts => knownHosts([], async () => undefined);
/** Known hosts kept in `file`. An unreadable file starts an empty list, so Push asks for reviews again. */
export async function openKnownHosts(file: string): Promise<KnownRobotHosts> {
  let initial: Array<[string, string]> = [];
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error("Saved robot host keys are invalid");
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as { version?: unknown; hosts?: unknown };
    if (raw?.version !== 1 || !raw.hosts || typeof raw.hosts !== "object") throw new Error("Saved robot host keys are invalid");
    initial = Object.entries(raw.hosts as Record<string, unknown>)
      .filter((entry): entry is [string, string] => /^[a-z]+\|[^|]{1,253}\|\d{1,5}$/.test(entry[0]) && typeof entry[1] === "string" && FINGERPRINT.test(entry[1]))
      .slice(-MAX_KNOWN_HOSTS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("Starting with no remembered robot host keys:", error);
  }
  return knownHosts(initial, async (hosts) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeJsonAtomically(file, { version: 1, hosts });
  });
}

interface RobotFileTransport {
  probe(endpoint: RobotFileEndpoint, timeoutMs?: number, password?: string | null, expectedHostKeyFingerprint?: string): Promise<RobotFileConnection>;
  list?(connection: RobotFileConnection, signal: AbortSignal, password: string | null): Promise<RobotPathFiles>;
  discover?(endpoint: RobotFileEndpoint): Promise<RobotFileConnection>;
  upload(connection: RobotFileConnection, files: Array<{ fileName: string; contents: Buffer }>, signal?: AbortSignal, password?: string | null): Promise<{ directoryCreated: boolean }>;
  read?(connection: RobotFileConnection, fileNames: string[], signal?: AbortSignal, password?: string | null): Promise<Pick<RobotFileReading, "files" | "robotConfigs">>;
}

/**
 * Reviewed bytes and SSH destination are immutable until this single-use transfer completes.
 * A custom SSH password takes effect only when Save or Trust commits it; probes never do.
 */
export class RobotFileDelivery {
  private trusted: RobotFileConnection | null;
  private saved: RobotFileSettings | null;
  /** The saved connection while the selected project robot has no usable address. */
  private suspended: RobotFileSettings | null = null;
  private observed: RobotFileConnection | null = null;
  private observedPassword: string | null = null;
  private observedNeedsLogin = false;
  private generation = 0;
  private trusting = false;
  private pending: { preview: RobotFilePreview; files: PreparedRobotFile[]; validate: () => Promise<void> } | null = null;
  private active: { id: string; controller: AbortController; done: Promise<RobotFileResult> } | null = null;
  private reading: { id: string; controller: AbortController; done: Promise<unknown> } | null = null;
  private compared: { id: string; fileName: string; robotOnly: boolean; bytes: Buffer; sha256: string; assertProject: () => void } | null = null;
  private savingCopy = false;
  constructor(initial: RobotFileSettings | null, private readonly persist: (value: RobotFileSettings | null) => Promise<void>,
    private readonly transport: RobotFileTransport = {
      discover: async (endpoint) => ({ endpoint, hostKeyFingerprint: await discoverRobotSshIdentity(endpoint) }),
      probe: (endpoint: RobotFileEndpoint, timeoutMs?: number, password?: string | null, expectedHostKeyFingerprint?: string) => probeRobotFiles(endpoint, undefined, timeoutMs, password ?? null, expectedHostKeyFingerprint),
      upload: (connection: RobotFileConnection, files: Array<{ fileName: string; contents: Buffer }>, signal?: AbortSignal, password?: string | null) =>
        uploadRobotFiles(connection, files, signal, undefined, password ?? null),
      read: (connection: RobotFileConnection, fileNames: string[], signal?: AbortSignal, password?: string | null) =>
        readRobotFiles(connection, fileNames, signal, undefined, password ?? null),
    },
    private readonly passwords: RobotPasswordStore = sessionRobotPasswordStore(),
    private readonly known: KnownRobotHosts = memoryKnownHosts()) {
    this.saved = initial ? settings(initial) : null;
    this.trusted = this.saved?.hostKeyFingerprint ? connection(this.saved) : null;
  }
  current(): RobotFileConnection | null { return structuredClone(this.trusted); }
  settings(): RobotFileSettings | null { return structuredClone(this.saved); }
  private get busy(): boolean { return Boolean(this.active || this.reading || this.trusting || this.savingCopy); }
  passwordStatus(): RobotPasswordStatus { return { custom: this.saved !== null && this.passwords.current() !== null, persistent: this.passwords.persistent }; }
  /** The password a login to `endpoint` uses after `change`; null means the robot type's default. */
  private passwordFor(endpoint: RobotFileEndpoint, change: RobotPasswordChange): string | null {
    if (change.kind === "custom") {
      if (!allowsCustomPassword(endpoint.target)) throw new Error(`${ROBOT_TARGETS[endpoint.target].label} logs in without a password`);
      return change.password;
    }
    if (change.kind !== "keep" || !allowsCustomPassword(endpoint.target)) return null;
    const saved = this.saved ?? this.suspended;
    const password = this.passwords.current();
    if (saved && password !== null && knownHostKey(saved.endpoint) === knownHostKey(endpoint)) return password;
    if (this.saved && password !== null) {
      throw new Error("Enter the SSH password or choose the default before connecting a different robot");
    }
    return null;
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
    const read = this.transport.read?.bind(this.transport);
    if (!read) throw new Error("Reading robot files is unavailable");
    const names: unknown[] | null = Array.isArray(rawFileNames) ? rawFileNames : null;
    if (!names?.every((name): name is string => typeof name === "string")) throw new Error("Name the robot files to read");
    return this.readPathOperation(randomUUID(), async (connection, signal, password) => {
      const { files, robotConfigs } = await read(connection, names, signal, password);
      signal.throwIfAborted();
      return { connection: structuredClone(connection), readAt: new Date().toISOString(), files, ...(robotConfigs ? { robotConfigs } : {}) };
    });
  }
  async saveSettings(endpoint: RobotFileEndpoint, rawPassword?: unknown): Promise<RobotFileSettings> {
    if (this.busy) throw new Error("Finish the current robot operation before editing settings");
    const change = robotPasswordChange(rawPassword);
    const normalized = validateRobotFileEndpoint(endpoint);
    const password = this.passwordFor(normalized, change);
    // Trust covers a login that was tried: the same host, port, robot type (account) and password.
    const fingerprint = this.trusted?.endpoint.host === normalized.host && this.trusted.endpoint.port === normalized.port
      && this.trusted.endpoint.target === normalized.target && password === this.passwords.current() ? this.trusted.hostKeyFingerprint : undefined;
    const value: RobotFileSettings = { endpoint: normalized, ...(fingerprint ? { hostKeyFingerprint: fingerprint } : {}) };
    this.generation++;
    this.observed = null; this.observedPassword = null; this.pending = null; this.compared = null;
    this.trusting = true;
    try {
      await this.commitSettings(value, password);
      return structuredClone(value);
    } finally { this.trusting = false; }
  }
  /**
   * Makes `rawEndpoint` the active robot, as when a project's selected robot changes. It never contacts the robot. A
   * host key reviewed on this computer for the same robot type, host and port is trusted again; any other address waits
   * for a review before Push. A custom password stays only while the robot type, host and port stay the same.
   * Null suspends the connection for a selected robot without a usable address. Undefined restores this computer's
   * connection when returning to a project without a robot list.
   */
  async use(rawEndpoint: unknown): Promise<RobotFileSettings | null> {
    if (this.busy) throw new Error("Finish the current robot operation before switching robots");
    if (rawEndpoint === undefined && !this.suspended) return this.settings();
    let endpoint: RobotFileEndpoint | null;
    try {
      endpoint = rawEndpoint === null ? null : validateRobotFileEndpoint(rawEndpoint ?? this.suspended?.endpoint);
    } catch (error) {
      this.suspend();
      throw error;
    }
    if (!endpoint) { this.suspend(); return null; }
    if (this.saved && JSON.stringify(this.saved.endpoint) === JSON.stringify(endpoint)) return this.settings();
    if (this.suspended && JSON.stringify(this.suspended.endpoint) === JSON.stringify(endpoint)) {
      this.saved = this.suspended;
      this.suspended = null;
      this.trusted = this.saved.hostKeyFingerprint ? connection(this.saved) : null;
      this.invalidateReview();
      return this.settings();
    }
    const prior = this.saved ?? this.suspended;
    const key = knownHostKey(endpoint), sameHost = prior && knownHostKey(prior.endpoint) === key;
    const fingerprint = (sameHost && prior.hostKeyFingerprint) || this.known.get(key);
    const password = sameHost && allowsCustomPassword(endpoint.target) ? this.passwords.current() : null;
    const value: RobotFileSettings = { endpoint, ...(fingerprint ? { hostKeyFingerprint: fingerprint } : {}) };
    this.invalidateReview();
    this.trusting = true;
    try {
      await this.commitSettings(value, password);
      return structuredClone(value);
    } finally { this.trusting = false; }
  }
  private invalidateReview(): void {
    this.generation++;
    this.observed = null; this.observedPassword = null; this.pending = null; this.compared = null;
  }
  private suspend(): void {
    this.invalidateReview();
    if (this.saved) this.suspended = this.saved;
    this.saved = null;
    this.trusted = null;
  }
  async probe(endpoint: RobotFileEndpoint, rawPassword?: unknown): Promise<RobotFileConnection> {
    if (this.busy) throw new Error("Finish the current robot operation before connecting another robot");
    const change = robotPasswordChange(rawPassword);
    const normalized = validateRobotFileEndpoint(endpoint);
    const password = this.passwordFor(normalized, change);
    const generation = ++this.generation;
    this.observed = null; this.observedPassword = null; this.pending = null; this.compared = null;
    const needsLogin = password !== null;
    if (needsLogin && !this.transport.discover) throw new Error("SSH identity discovery is unavailable");
    const result = connection(needsLogin ? await this.transport.discover!(normalized) : await this.transport.probe(normalized, undefined, password));
    if (generation !== this.generation) throw new Error("A newer connection replaced this probe");
    this.observed = result; this.observedPassword = password; this.observedNeedsLogin = needsLogin;
    return structuredClone(result);
  }
  async trust(fingerprint: string): Promise<RobotFileConnection> {
    if (this.busy || !this.observed || fingerprint !== this.observed.hostKeyFingerprint) throw new Error("Connect and review the SSH identity before trusting this robot");
    this.trusting = true;
    const value = structuredClone(this.observed);
    try {
      if (this.observedNeedsLogin) {
        const authenticated = connection(await this.transport.probe(value.endpoint, undefined, this.observedPassword, value.hostKeyFingerprint));
        if (authenticated.hostKeyFingerprint !== value.hostKeyFingerprint) throw new Error("The robot SSH host key changed; connect and review its identity again");
        this.observedNeedsLogin = false;
      }
      await this.commitSettings(value, this.observedPassword);
      this.observed = null; this.observedPassword = null; this.pending = null; this.compared = null;
      return structuredClone(value);
    }
    finally { this.trusting = false; }
  }
  private async commitSettings(value: RobotFileSettings, password: string | null): Promise<void> {
    // The identity being replaced was reviewed here, so a project robot at that address can be trusted again later.
    const prior = this.saved ?? this.suspended;
    if (prior?.hostKeyFingerprint) await this.known.set(knownHostKey(prior.endpoint), prior.hostKeyFingerprint);
    // Revoke the old identity before replacing credentials. Clear its password before moving
    // the saved endpoint, so a crash or rejected write cannot associate an old secret with a new robot.
    const previous = prior ? { endpoint: prior.endpoint } : null;
    if (previous) {
      await this.persist(previous);
      this.saved = previous; this.trusted = null; this.suspended = null;
    }
    await this.commitPassword(null);
    const unverified = { endpoint: value.endpoint };
    if (!previous || JSON.stringify(previous.endpoint) !== JSON.stringify(value.endpoint)) {
      await this.persist(unverified);
      this.saved = unverified;
    }
    this.trusted = null;
    if (password !== null) await this.commitPassword(password);
    if (value.hostKeyFingerprint) {
      await this.persist(value);
      await this.known.set(knownHostKey(value.endpoint), value.hostKeyFingerprint);
    }
    this.saved = value;
    this.trusted = value.hostKeyFingerprint ? connection(value) : null;
  }

  cancelProbe(): void {
    if (this.trusting) return;
    this.generation++;
    this.observed = null; this.observedPassword = null;
  }
  prepare(files: PreparedRobotFile[], validate: () => Promise<void>): RobotFilePreview {
    if (!this.trusted || this.busy) throw new Error("Connect a robot before preparing this transfer");
    // A SystemCore push adds the LabVIEW command list, and any push may add the robot's .robot file; neither counts
    // toward the 64 paths.
    const robotFiles = files.filter(file => /\.robot$/i.test(file.fileName)).length;
    const paths = files.filter(file => file.fileName !== COMMANDS_FILE_NAME).length - robotFiles;
    if (!paths || paths > 64) throw new Error("Select between 1 and 64 paths to push");
    if (robotFiles > 1) throw new Error("Push sends one robot's details at a time");
    if (new Set(files.map(file => file.fileName.toLowerCase())).size !== files.length) throw new Error("Selected paths have matching BDX filenames. Rename them before pushing together");
    if (files.some(file => !file.contents.length) || files.reduce((sum, file) => sum + file.contents.length, 0) > 24 * 1024 * 1024) throw new Error("Selected BDX files exceed the 24 MB transfer limit");
    const frozen = files.map(file => ({ ...file, contents: Buffer.from(file.contents) }));
    const preview: RobotFilePreview = { operationId: randomUUID(), connection: structuredClone(this.trusted), files: frozen.map(({ contents, ...file }) => ({ ...file, size: contents.length, sha256: createHash("sha256").update(contents).digest("hex") })) };
    this.pending = { preview, files: frozen, validate };
    return structuredClone(preview);
  }
  async confirm(id: string): Promise<RobotFileResult> {
    const pending = this.pending;
    if (this.busy || !pending || pending.preview.operationId !== id) throw new Error("Review the selected files again before pushing");
    this.pending = null;
    this.compared = null;
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
  private async readPathOperation<T>(id: string, run: (connection: RobotFileConnection, signal: AbortSignal, password: string | null) => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("Finish the current robot operation before reading paths");
    const connection = this.trusted;
    if (!connection) throw new Error("Connect a robot before reading paths");
    const controller = new AbortController();
    const password = this.passwordFor(connection.endpoint, { kind: "keep" });
    const done = Promise.resolve().then(() => run(connection, controller.signal, password));
    const operation = this.reading = { id, controller, done };
    try { return await done; } finally { if (this.reading === operation) this.reading = null; }
  }

  async listPaths(id: string, paths: LocalRobotPath[], assertProject: () => void): Promise<RobotPathInventory> {
    return this.readPathOperation(id, async (connection, signal, password) => {
      this.compared = null;
      assertProject();
      const remote = await (this.transport.list?.(connection, signal, password)
        ?? listRobotPathFiles(connection, signal, undefined, password));
      signal.throwIfAborted();
      assertProject();
      return { endpoint: structuredClone(connection.endpoint), listedAt: Date.now(), rows: pairRobotPathFiles(paths, remote),
        missing: remote.missing, truncated: remote.truncated };
    });
  }

  async reviewPath(id: string, fileName: string, match: (deployedId?: string) => { id: string; name: string } | undefined,
    build: (pathId: string, signal: AbortSignal) => Promise<Buffer>, assertProject: () => void): Promise<RobotPathComparison> {
    return this.readPathOperation(id, async (connection, signal, password) => {
      this.compared = null;
      assertProject();
      const robot = this.transport.read
        ? (await this.transport.read(connection, [fileName], signal, password)).files[0]?.contents ?? null
        : await readRobotPathFile(connection, fileName, signal, undefined, password);
      const readAt = Date.now();
      signal.throwIfAborted();
      assertProject();
      const deployed = robot === null ? null : inspectDeployedPath(robot);
      const selected = match(deployed?.path?.id);
      const local = selected ? await build(selected.id, signal).catch((error: unknown) => ({ error })) : undefined;
      signal.throwIfAborted();
      assertProject();
      const result = compareRobotPath(selected?.id, local, robot, deployed);
      if (robot !== null && result.robot) {
        this.compared = { id, fileName, robotOnly: !selected, bytes: Buffer.from(robot), sha256: result.robot.sha256, assertProject };
      }
      const expectedFileName = selected && binaryFileName(selected.name);
      return { ...result, id, name: selected?.name ?? result.robotName ?? fileName, fileName,
        expectedFileName: expectedFileName !== fileName ? expectedFileName : undefined,
        endpoint: structuredClone(connection.endpoint), readAt };
    });
  }

  async saveCopy(id: string, save: (copy: { fileName: string; robotOnly: boolean; bytes: Buffer; sha256: string }, assertCurrent: () => void) => Promise<RobotPathCopyResult>): Promise<RobotPathCopyResult> {
    const copy = this.compared;
    if (this.busy || !copy || copy.id !== id) throw new Error("Read the robot path again before saving a copy");
    const assertCurrent = () => {
      if (this.compared !== copy) throw new Error("Read the robot path again before saving a copy");
      copy.assertProject();
    };
    assertCurrent();
    this.savingCopy = true;
    try { return await save(copy, assertCurrent); } finally { this.savingCopy = false; }
  }

  cancelCompare(id: string): void {
    if (this.reading?.id === id) {
      this.reading.controller.abort();
      this.reading = null;
    }
    if (this.compared?.id === id) this.compared = null;
  }

  async stop(): Promise<void> {
    this.generation++; this.pending = null; this.observed = null; this.observedPassword = null; this.compared = null;
    this.active?.controller.abort(); this.reading?.controller.abort();
    await Promise.allSettled([this.active?.done, this.reading?.done]);
  }
}
