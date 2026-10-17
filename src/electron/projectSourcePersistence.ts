import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { BordeauxProject } from "../shared/types";
import { ProjectBdxChangedError, ProjectBdxExport, projectBdxFailure, PROJECT_BDX_MAX_OUTSTANDING, type ProjectBdxLimits, type ProjectBdxExportScope } from "./projectBdxExport";
import type { ProjectCheckpointSaveResult } from "../shared/project/projectPersistence";
import type { ProjectLocation } from "../shared/project/desktopProjects";
import type { ProjectDurabilityContext } from "../shared/project/projectDurability";
import { encodeProjectFile } from "../shared/project/fileFormat";
import { autosaveProjectFolder, MAX_WORKSPACE_FILE_BYTES, projectWorkspacePath, readProject, assertProjectSource, type ProjectSourceOwner } from "./projectFiles";
import { projectFolderIdentity, projectFileIdentity, sameProjectFolder, type ProjectFolderIdentity } from "./projectFolderIdentity";

export const PROJECT_SOURCE_TIMEOUT_MS = 8_000;
export type ProjectSourceCode = "PROJECT_SOURCE_TIMED_OUT" | "PROJECT_SOURCE_SUPERSEDED" | "PROJECT_SOURCE_BUSY";
export class ProjectSourceError extends Error {
  constructor(public readonly code: ProjectSourceCode) {
    super(code === "PROJECT_SOURCE_BUSY" ? "Folder is busy" : code === "PROJECT_SOURCE_TIMED_OUT" ? "Folder isn’t responding" : "The project changed before saving finished");
  }
}
export interface ProjectSourceCapture {
  operationId: string;
  context: ProjectDurabilityContext;
  snapshotRevision: number;
  capturedAt: string;
  project: BordeauxProject;
  digest: string;
  valid: boolean;
}
export interface ProjectSourceDestination {
  folderPath: string;
  projectPath: string | null;
  legacyFile?: string | null;
  createProject?: boolean;
  /** Previously admitted source identity; omitted only for a newly chosen destination. */
  folderIdentity?: ProjectFolderIdentity;
  sourceOwner?: ProjectSourceOwner;
  /** Main-only named copy authority; never deserialized from renderer input. */
  requiredOwner?: ProjectSourceOwner;
}
export interface ProjectSourceResult {
  project: BordeauxProject;
  context: ProjectDurabilityContext;
  location: ProjectLocation;
  digest: string;
  folderIdentity: ProjectFolderIdentity;
  sourceOwner: ProjectSourceOwner;
}
interface Dependencies {
  getContext(): ProjectDurabilityContext;
  /** One synchronous authority boundary; recents persistence may start here, but must not mutate active state later. */
  commit(capture: ProjectSourceCapture, project: BordeauxProject, target: string): { context: ProjectDurabilityContext; location: ProjectLocation };
  write?: (folder: string, project: BordeauxProject, projectPath: string | null, options: { legacyFile?: string | null; createProject?: boolean; assertCurrent(): void; folderIdentity: ProjectFolderIdentity; sourceOwner: ProjectSourceOwner }) => Promise<BordeauxProject>;
  now?: () => number;
}
export const sameProjectContext = (a: ProjectDurabilityContext | null | undefined, b: ProjectDurabilityContext) => Boolean(a
  && typeof a.windowEpoch === "string" && a.windowEpoch.length > 0 && a.windowEpoch.length <= 128
  && typeof a.documentSessionId === "string" && a.documentSessionId.length > 0 && a.documentSessionId.length <= 128
  && Number.isSafeInteger(a.targetGeneration) && a.targetGeneration >= 0 && a.windowEpoch === b.windowEpoch
  && a.documentSessionId === b.documentSessionId && a.targetGeneration === b.targetGeneration);
export function canonicalProjectDigest(project: BordeauxProject): string { return createHash("sha256").update(encodeProjectFile(project).contents).digest("hex"); }

const outstandingExports = new Set<string>();
interface ExportOwner { identity: ProjectFolderIdentity; operation?: ProjectBdxExport; digest?: string; context?: ProjectDurabilityContext; binding?: string; settled?: Promise<void> }

/** Captured disk destinations, bounded physical ownership, and revocable completion authority. No departure permits. */
export class ProjectSourcePersistence {
  private readonly captures = new Map<ProjectSourceCapture, (error: Error) => void>();
  private readonly physical = new Map<string, { identity: ProjectFolderIdentity; operationId: string; settled: Promise<void> }>();
  private readonly exports = new Map<string, ExportOwner>();
  constructor(private readonly deps: Dependencies) {}
  capture(project: unknown, context: ProjectDurabilityContext, snapshotRevision: number, capturedAt = new Date((this.deps.now ?? Date.now)()).toISOString()): ProjectSourceCapture {
    if (!sameProjectContext(context, this.deps.getContext())) throw new ProjectSourceError("PROJECT_SOURCE_SUPERSEDED");
    if (!Number.isSafeInteger(snapshotRevision) || snapshotRevision < 0) throw new Error("Snapshot revision is invalid");
    const encoded = encodeProjectFile(project);
    JSON.stringify(encoded.project, (_key, value: unknown) => {
      if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Project source contains a nonfinite value");
      return value;
    });
    if (Buffer.byteLength(encoded.contents, "utf8") > MAX_WORKSPACE_FILE_BYTES) throw new Error("Project source exceeds the 32 MiB workspace limit");
    const capture = { operationId: randomUUID(), context: { ...context }, snapshotRevision, capturedAt, project: encoded.project,
      digest: createHash("sha256").update(encoded.contents).digest("hex"), valid: true };
    this.captures.set(capture, () => undefined);
    return capture;
  }
  assertCurrent(capture: ProjectSourceCapture): void {
    if (!capture.valid || !sameProjectContext(capture.context, this.deps.getContext())) throw new ProjectSourceError("PROJECT_SOURCE_SUPERSEDED");
  }
  revoke(capture: ProjectSourceCapture, error: Error = new ProjectSourceError("PROJECT_SOURCE_SUPERSEDED")): void {
    capture.valid = false;
    this.captures.get(capture)?.(error);
    this.captures.delete(capture);
  }
  retire(): void { for (const capture of this.captures.keys()) this.revoke(capture); for (const owner of this.exports.values()) owner.operation?.fail(new Error("The project changed during BDX export"), "changed"); }
  revalidateExports(): void { for (const owner of this.exports.values()) { try { owner.operation?.assertCurrent(); } catch { /* The lease has already fenced and settled its logical result. */ } } }
  private pendingSource(identity: ProjectFolderIdentity) { return [...this.physical.values()].find(value => sameProjectFolder(value.identity, identity)); }
  private busy(identity: ProjectFolderIdentity): boolean { return Boolean(this.pendingSource(identity)) || [...this.exports.values()].some(value => sameProjectFolder(value.identity, identity)); }
  async isBusy(folder: string): Promise<boolean> { return this.busy(await projectFolderIdentity(folder)); }
  async hasPendingSource(folder: string): Promise<boolean> { return Boolean(this.pendingSource(await projectFolderIdentity(folder))); }
  /** Include asynchronous folder resolution/preflight in the same revocable source deadline. */
  async admit<T>(capture: ProjectSourceCapture, action: () => Promise<T>, timeoutMs = PROJECT_SOURCE_TIMEOUT_MS): Promise<T> {
    this.assertCurrent(capture);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Source timeout is invalid");
    let rejectLogical!: (error: Error) => void;
    const cancelled = new Promise<never>((_resolve, reject) => { rejectLogical = reject; });
    this.captures.set(capture, rejectLogical);
    const timer = setTimeout(() => this.revoke(capture, new ProjectSourceError("PROJECT_SOURCE_TIMED_OUT")), timeoutMs);
    try { const result = await Promise.race([Promise.resolve().then(action), cancelled]); this.assertCurrent(capture); return result; }
    finally { clearTimeout(timer); if (capture.valid) this.captures.set(capture, () => undefined); }
  }
  /** Confirm an already saved source while its separate export owns the folder. No write, provenance grant or target commit. */
  async confirmSaved(capture: ProjectSourceCapture, previous: ProjectSourceResult, timeoutMs = PROJECT_SOURCE_TIMEOUT_MS): Promise<ProjectSourceResult> {
    this.assertCurrent(capture);
    try { return await this.admit(capture, async () => {
      const folder = previous.location.folderPath;
      if (!folder || !previous.location.projectPath || !sameProjectContext(previous.context, capture.context)) throw new ProjectSourceError("PROJECT_SOURCE_BUSY");
      const identity = await projectFolderIdentity(folder, { assertCurrent: () => this.assertCurrent(capture) });
      if (identity.objectKey !== previous.folderIdentity.objectKey) throw new Error("Project folder changed. Reopen it or save a copy in a different folder.");
      if (this.pendingSource(identity)) throw new ProjectSourceError("PROJECT_SOURCE_BUSY");
      await assertProjectSource(previous.sourceOwner, () => this.assertCurrent(capture));
      const decoded = await readProject(path.join(identity.folderPath, path.basename(previous.location.projectPath)), { recordOpened: false, assertCurrent: () => this.assertCurrent(capture) });
      this.assertCurrent(capture);
      if (this.pendingSource(identity) || canonicalProjectDigest(decoded.project) !== previous.digest) throw new Error("The saved source changed; wait for export to finish before saving again");
      return { project: decoded.project, digest: previous.digest, folderIdentity: identity, context: { ...capture.context }, location: { folderPath: identity.folderPath, projectPath: projectWorkspacePath(identity.folderPath) }, sourceOwner: previous.sourceOwner };
    }, timeoutMs); } finally { this.revoke(capture); }
  }
  pendingWrites(): Array<{ operationId: string; folderPath: string; phase: "source" | "export" }> {
    return [...[...this.physical.values()].map(value => ({ operationId: value.operationId, folderPath: value.identity.folderPath, phase: "source" as const })),
      ...[...this.exports.entries()].map(([operationId, owner]) => ({ operationId, folderPath: owner.identity.folderPath, phase: "export" as const }))];
  }
  async holdExport(folder: string, assertCurrent?: () => void): Promise<() => void> {
    const identity = await projectFolderIdentity(folder, { assertCurrent }), token = randomUUID();
    assertCurrent?.();
    if (this.busy(identity)) throw new ProjectSourceError("PROJECT_SOURCE_BUSY");
    this.exports.set(token, { identity });
    return () => { this.exports.delete(token); };
  }
  /** Source evidence is already committed. This separate lease owns export admission and physical completion. */
  exportSaved(saved: { folderIdentity: ProjectFolderIdentity; digest: string; context: ProjectDurabilityContext; location: ProjectLocation },
    pathCount: number, binding: { key: string; isCurrent(): boolean }, action: (scope: ProjectBdxExportScope) => Promise<ProjectCheckpointSaveResult>, limits?: ProjectBdxLimits): Promise<ProjectCheckpointSaveResult> {
    const owner = [...this.exports.values()].find(value => sameProjectFolder(value.identity, saved.folderIdentity));
    if (owner?.operation) {
      try { owner.operation.assertCurrent(); } catch { /* Residual work cannot be joined. */ }
      if (owner.operation.isRunning() && owner.identity.objectKey === saved.folderIdentity.objectKey && owner.digest === saved.digest && sameProjectContext(owner.context, saved.context) && owner.binding === binding.key && binding.isCurrent()) return owner.operation.result;
    }
    if (owner || this.pendingSource(saved.folderIdentity)) return Promise.resolve(projectBdxFailure(saved.location, new Error("Folder is busy"), false, "busy", owner?.operation?.operationId));
    if (outstandingExports.size >= PROJECT_BDX_MAX_OUTSTANDING) return Promise.resolve(projectBdxFailure(saved.location, new Error("Four BDX exports are still outstanding; wait for one to finish"), false, "limit"));
    let operation: ProjectBdxExport;
    try { operation = new ProjectBdxExport(saved.folderIdentity, saved.digest, saved.location, pathCount,
      () => sameProjectContext(saved.context, this.deps.getContext()) && binding.isCurrent(), limits); }
    catch (error) { return Promise.resolve(projectBdxFailure(saved.location, error, false, "changed")); }
    const token = operation.operationId;
    outstandingExports.add(token); // Reserve synchronously, before any identity admission await.
    const entry: ExportOwner = { identity: saved.folderIdentity, operation, digest: saved.digest, context: { ...saved.context }, binding: binding.key };
    this.exports.set(token, entry);
    const physical = Promise.resolve().then(async () => {
      const identity = await projectFolderIdentity(saved.folderIdentity.folderPath, { assertCurrent: () => operation.assertCurrent() });
      operation.assertCurrent();
      if (!sameProjectFolder(identity, saved.folderIdentity) || identity.objectKey !== saved.folderIdentity.objectKey) throw new ProjectBdxChangedError("Project folder changed before BDX export started");
      if (this.pendingSource(identity)) throw new Error("Folder is busy");
      operation.complete(await action(operation));
    }).catch(error => operation.fail(error)).finally(() => {
      if (this.exports.get(token) === entry) this.exports.delete(token);
      outstandingExports.delete(token);
    });
    entry.settled = physical;
    return operation.result;
  }
  async whenExportsSettled(): Promise<void> { await Promise.all([...this.exports.values()].map(value => value.settled)); }
  async assertReadable(folder: string, assertCurrent?: () => void): Promise<void> { if (this.busy(await projectFolderIdentity(folder, { assertCurrent }))) throw new ProjectSourceError("PROJECT_SOURCE_BUSY"); }
  async whenSettled(folder: string): Promise<void> { await this.pendingSource(await projectFolderIdentity(folder))?.settled; }
  async persist(capture: ProjectSourceCapture, destination: ProjectSourceDestination, timeoutMs = PROJECT_SOURCE_TIMEOUT_MS): Promise<ProjectSourceResult> {
    this.assertCurrent(capture);
    if (!destination.sourceOwner) { this.revoke(capture); throw new Error("Project source was not admitted. Reopen it or choose a new folder for a copy."); }
    const sourceOwner = destination.sourceOwner;
    try { return await this.admit(capture, async () => {
      const guard = () => this.assertCurrent(capture);
      const identity = await projectFolderIdentity(destination.folderPath, { assertCurrent: guard });
      if (destination.folderIdentity && (!sameProjectFolder(identity, destination.folderIdentity) || identity.objectKey !== destination.folderIdentity.objectKey)) {
        throw new Error("Project folder changed. Reopen it or save a copy in a different folder.");
      }
      const folder = identity.folderPath;
      const captured = { ...destination, folderPath: folder,
        projectPath: destination.projectPath ? await projectFileIdentity(destination.projectPath, guard) : null,
        legacyFile: destination.legacyFile ? await projectFileIdentity(destination.legacyFile, guard) : destination.legacyFile };
      guard();
      if (this.busy(identity)) throw new ProjectSourceError("PROJECT_SOURCE_BUSY");
      const physical = Promise.resolve().then(async () => {
        this.assertCurrent(capture); // Admission can be revoked before its first microtask.
        const project = await (this.deps.write ?? autosaveProjectFolder)(folder, capture.project, captured.projectPath, {
          legacyFile: captured.legacyFile, createProject: captured.createProject, assertCurrent: guard, folderIdentity: identity, sourceOwner,
        });
        this.assertCurrent(capture);
        const committed = this.deps.commit(capture, project, projectWorkspacePath(folder));
        if (committed.context.windowEpoch !== capture.context.windowEpoch || committed.context.documentSessionId !== capture.context.documentSessionId
          || committed.context.targetGeneration < capture.context.targetGeneration) throw new ProjectSourceError("PROJECT_SOURCE_SUPERSEDED");
        capture.context = { ...committed.context };
        this.assertCurrent(capture);
        return { project, context: { ...committed.context }, location: { ...committed.location }, digest: canonicalProjectDigest(project), folderIdentity: identity, sourceOwner };
      });
      const settled = physical.then(() => undefined, () => undefined).finally(() => { this.physical.delete(capture.operationId); });
      this.physical.set(capture.operationId, { operationId: capture.operationId, identity, settled });
      return physical;
    }, timeoutMs); } finally { this.revoke(capture); }
  }
}
