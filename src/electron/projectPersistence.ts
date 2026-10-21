import { projectBdxFailure, type ProjectBdxExportScope, type ProjectBdxLimits } from "./projectBdxExport";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import type { ProjectCopyFolder, ProjectCopyMark } from "./projectCreation";
import type { BordeauxProject } from "../shared/types";
import type { ProjectLocation } from "../shared/project/desktopProjects";
import type { ProjectCheckpointUpdate, ProjectDurabilityContext, StoredProjectRecoveryReceipt } from "../shared/project/projectDurability";
import type { ProjectBackgroundCheckpoint, ProjectCheckpointRequest, ProjectCheckpointSaveResult, ProjectPersistenceUpdate, ProjectRecoveredFrom, ProjectSession, ProjectStorageReceipt, ProjectTransitionToken, ProjectReloadRequest, ProjectReloadFailureCode, ProjectKeptRecovery } from "../shared/project/projectPersistence";
import { describeProjectWriteError } from "../shared/project/writeErrors";
import type { ProjectDepartureCoordinator } from "./projectDeparture";
import { ProjectRecoveryStore, type RecoveryBranch, type RecoveryOriginIdentity, type RecoveryOrigin, type RecoveryWriteRequest, type RecoveryWriteReceipt } from "./projectRecoveryStore";
import { canonicalProjectDigest, ProjectSourcePersistence, ProjectSourceError, sameProjectContext, type ProjectSourceCapture, type ProjectSourceDestination, type ProjectSourceResult } from "./projectSourcePersistence";
import { absentProjectSource, ownProjectSource, ProjectSourceChangedError, type ProjectSourceOwner, type ProjectSourceEvidence } from "./projectFiles";
import { projectFolderIdentity, sameProjectFolder, type ProjectFolderIdentity } from "./projectFolderIdentity";

export const PROJECT_RECOVERY_PHASE_MS = 2_000;
export const PROJECT_RECOVERY_RESOLUTION_MS = 150;
export type SavedProjectCheckpoint = ProjectPersistenceUpdate & { source: "saved"; location: ProjectLocation; canonicalProject: BordeauxProject };
interface Dependencies {
  source: ProjectSourcePersistence;
  recovery: Pick<ProjectRecoveryStore, "writeSnapshot" | "readSnapshot"> & Partial<Pick<ProjectRecoveryStore, "createBranch" | "releaseBranch" | "markResolved">>;
  getContext(): ProjectDurabilityContext;
  getLocation(): ProjectLocation;
  onUpdate(update: ProjectPersistenceUpdate): void;
  now?: () => number;
  recoveryTimeoutMs?: number;
  sourceTimeoutMs?: number;
  exportLimits?: ProjectBdxLimits;
}
type DocumentSourceOwner = ProjectSourceOwner & { context: ProjectDurabilityContext };
interface Operation {
  capture: ProjectSourceCapture;
  id: string;
  valid: boolean;
  deadline: number;
  update: ProjectBackgroundCheckpoint;
  requestId?: string;
  resolve(update: ProjectPersistenceUpdate): void;
  timer?: ReturnType<typeof setTimeout>;
  confirmedRecovery?: StoredProjectRecoveryReceipt;
  documentOwner: object;
  sourceOwner?: ProjectSourceOwner;
  pendingOwner?: ProjectSourceOwner;
}
type ReloadRoot = ProjectFolderIdentity & { objectKey: string };
export type ProjectReloadKeepResult =
  | { status: "kept"; kept: ProjectKeptRecovery }
  | { status: "failed"; code: "stale" | "recovery-capacity" | "recovery-timed-out" | "recovery-failed";
      recoveryCode?: string; recoveryFact?: string; fact: string };
export interface ReloadHandle {
  assertCurrent(): void;
  keep(): Promise<ProjectReloadKeepResult>;
  release(): void;
  readonly root: ReloadRoot;
  readonly selectionPath: string;
  readonly legacyFile: string | null;
}
interface ReloadAdmission {
  readonly id: string;
  readonly context: ProjectDurabilityContext;
  readonly transition: ProjectTransitionToken;
  readonly documentOwner: object;
  readonly sourceOwner: DocumentSourceOwner;
  readonly root: ReloadRoot;
  readonly selectionPath: string;
  readonly legacyFile: string | null;
  readonly capture: ProjectSourceCapture;
  readonly recovery: RecoveryWriteRequest;
  readonly cancelled: Promise<null>;
  cancel(): void;
  valid: boolean;
  settled: boolean;
  started: boolean;
}
/** In-process lifecycle classification; IPC uses the shared typed failure result. */
export class ReloadStale extends Error {
  constructor() { super("The project changed while reloading"); this.name = "ReloadStale"; }
}
const copy = <T>(value: T): T => structuredClone(value);
const boundedName = (name: string) => name.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 256).trim() || "Untitled";
function sourceChangeFact(error: unknown): ProjectCheckpointUpdate["sourceChange"] {
  if (!(error instanceof ProjectSourceChangedError)) return undefined;
  const file = error.scope === "document" && error.file && /^(Paths\/[^/\\]+\.path|Routines\/[^/\\]+\.routine)$/.test(error.file) ? error.file : undefined;
  return { scope: error.scope, ...(file ? { file } : {}) };
}


/** Session-local storage evidence and source/recovery orchestration; native intent/permits belong to the attached coordinator. */
export class ProjectPersistence {
  private coordinator: ProjectDepartureCoordinator | null = null;
  private recordId: string = randomUUID();
  private branch: RecoveryBranch | undefined;
  private recoveryOriginIdentity: RecoveryOriginIdentity | undefined;
  private sourceOwner: DocumentSourceOwner | undefined;
  private pendingDestination: DocumentSourceOwner | undefined;
  private documentOwner: object = {};
  private revision = 0;
  private lastCapture: { key: string; revision: number; capturedAt: string } | null = null;
  private recoveredFrom: ProjectRecoveredFrom | undefined;
  private recoveredSourceDigest: string | undefined;
  private readonly preparedRecoveryDigests = new WeakMap<ProjectRecoveredFrom, string>();
  private latestSource: ProjectStorageReceipt | undefined;
  private latestRecovery: ProjectStorageReceipt | undefined;
  private sourceResolution: ProjectSession["sourceResolution"];
  private savedSource: { inputDigest: string; result: ProjectSourceResult } | undefined;
  private readonly sourceIdentities = new Map<string, ProjectSourceResult["folderIdentity"]>();
  private transition: ProjectTransitionToken | null = null;
  private readyEpoch: string | null = null;
  private reload: ReloadAdmission | null = null;
  private readonly operations = new Map<string, Operation>();
  private readonly updates = new Map<string, ProjectPersistenceUpdate>();
  constructor(private readonly deps: Dependencies) { this.branch = deps.recovery.createBranch?.(); }
  /** Main calls after a real guarded source activation. Provenance paths alone cannot admit reuse. */
  admitSource(context: ProjectDurabilityContext, evidence: ProjectSourceEvidence, legacyFile?: string | null): void {
    if (!sameProjectContext(context, this.deps.getContext()) || this.recoveredFrom || !evidence.identity.objectKey) return;
    this.sourceOwner = { ...ownProjectSource(evidence), context: copy(context) };
    this.setRecoveryOrigin(evidence.identity, legacyFile);
  }
  private setRecoveryOrigin(identity: ProjectFolderIdentity, legacyFile?: string | null): void {
    this.recoveryOriginIdentity = { folderPath: identity.folderPath, objectKey: identity.objectKey!,
      ...(legacyFile ? { legacyFile: path.join(identity.folderPath, path.basename(legacyFile)) } : {}) };
  }
  /** The picker may allow only this document's one retained partial copy through normal writer checks. */
  async pendingDestinationFor(folder: string, assertCurrent?: () => void): Promise<DocumentSourceOwner | null> {
    const pending = this.pendingDestination, documentOwner = this.documentOwner;
    if (!pending || !sameProjectContext(pending.context, this.deps.getContext())) return null;
    const identity = await projectFolderIdentity(folder, { assertCurrent });
    assertCurrent?.();
    return documentOwner === this.documentOwner && pending === this.pendingDestination
      && sameProjectContext(pending.context, this.deps.getContext())
      && sameProjectFolder(identity, pending.identity) && identity.objectKey === pending.identity.objectKey ? pending : null;
  }
  async isPendingDestination(folder: string, assertCurrent?: () => void): Promise<boolean> {
    return Boolean(await this.pendingDestinationFor(folder, assertCurrent));
  }
  ownsPendingDestination(owner?: ProjectSourceOwner): boolean {
    return Boolean(owner && owner === this.pendingDestination && sameProjectContext(this.pendingDestination!.context, this.deps.getContext()));
  }
  /** Only a newly created, re-observed empty child can become the live document's retry slot. */
  async claimCreatedDestination(capture: ProjectSourceCapture, made: ProjectCopyFolder, guard: () => void, mark: ProjectCopyMark): Promise<DocumentSourceOwner> {
    const documentOwner = this.documentOwner;
    guard(); this.deps.source.assertCurrent(capture);
    const child = await projectFolderIdentity(made.child.folderPath, { assertCurrent: guard }); guard();
    if (child.objectKey !== made.child.objectKey || child.pathKey !== made.child.pathKey) throw new Error("That project folder changed while saving");
    const parent = await fs.lstat(made.parent.folderPath); guard();
    if (!parent.isDirectory() || parent.isSymbolicLink() || `${parent.dev}:${parent.ino}` !== made.parent.objectKey) throw new Error("The chosen folder changed while saving");
    const entries = await fs.readdir(child.folderPath); guard();
    if (entries.length) throw new Error("That project folder already exists. Choose another name.");
    this.deps.source.assertCurrent(capture);
    if (documentOwner !== this.documentOwner || !sameProjectContext(capture.context, this.deps.getContext())) throw new ProjectSourceError("PROJECT_SOURCE_SUPERSEDED");
    // No await separates this busy check from replacing the single pending slot.
    if ([...this.operations.values()].some(operation => operation.valid)) throw new Error("A project checkpoint is already running");
    const owner: DocumentSourceOwner = { ...absentProjectSource(child), context: copy(capture.context) };
    this.pendingDestination = owner; mark.claimed = owner;
    return owner;
  }

  attachDepartureCoordinator(coordinator: ProjectDepartureCoordinator): void { this.coordinator = coordinator; }
  /** Called synchronously inside main's one source-target commit boundary. */
  sourceTargetCommitted(captureId: string, next: ProjectDurabilityContext): void {
    this.deps.source.revalidateExports();
    const operation = [...this.operations.values()].find(value => value.capture.operationId === captureId);
    if (operation?.requestId) {
      if (!sameProjectContext(operation.update.context, next)) this.coordinator?.advanceTarget(operation.id, next);
      operation.update.context = copy(next);
    } else this.coordinator?.contextChanged();
  }
  beginTransition(context: ProjectDurabilityContext): ProjectTransitionToken {
    if (!sameProjectContext(context, this.deps.getContext())) throw new Error("Project transition context is no longer current");
    if (this.transition) throw new Error("Another project transition is already pending");
    if (this.coordinator && !["idle", "retired"].includes(this.coordinator.snapshot().phase)) throw new Error("A project departure is already pending");
    this.transition = { id: randomUUID(), windowEpoch: context.windowEpoch }; return copy(this.transition);
  }
  isTransitionCurrent(token: ProjectTransitionToken): boolean {
    return Boolean(token && this.transition && this.transition.id === token.id && this.transition.windowEpoch === token.windowEpoch && token.windowEpoch === this.deps.getContext().windowEpoch);
  }
  endTransition(token: ProjectTransitionToken): boolean {
    if (!this.isTransitionCurrent(token)) return false;
    if (this.reload) this.settleReload(this.reload);
    this.transition = null; return true;
  }
  getTransitionId(): string | null { return this.transition?.id ?? null; }
  setLifecycleReady(context: ProjectDurabilityContext, ready: boolean): boolean {
    if (!sameProjectContext(context, this.deps.getContext()) || typeof ready !== "boolean") return false;
    this.readyEpoch = ready ? context.windowEpoch : null; return true;
  }
  isLifecycleReady(): boolean { return this.readyEpoch === this.deps.getContext().windowEpoch; }
  getSession(): ProjectSession {
    return copy({ context: this.deps.getContext(), location: this.deps.getLocation(), recoveryRecordId: this.recordId, lifecycleReady: this.isLifecycleReady(),
      ...(this.recoveredFrom ? { recoveredFrom: this.recoveredFrom } : {}), ...(this.latestSource ? { latestSource: this.latestSource } : {}), ...(this.latestRecovery ? { latestRecovery: this.latestRecovery } : {}),
      ...(this.sourceResolution ? { sourceResolution: this.sourceResolution } : {}) });
  }
  async prepareRestore(context: ProjectDurabilityContext, recordId: string) {
    if (!sameProjectContext(context, this.deps.getContext())) throw new Error("Project recovery context is no longer current");
    const snapshot = await this.deps.recovery.readSnapshot(recordId);
    if (!sameProjectContext(context, this.deps.getContext())) throw new Error("Project recovery context is no longer current");
    const recoveredFrom = { origin: snapshot.origin, capturedAt: snapshot.capturedAt, receipt: snapshot.receipt };
    // Bind migrated editor source to its historical receipt only inside main.
    this.preparedRecoveryDigests.set(recoveredFrom, canonicalProjectDigest(snapshot.project));
    return { project: snapshot.project, recoveredFrom };
  }
  contextChanged(replacement = false, recoveredFrom?: ProjectRecoveredFrom): void {
    if (this.reload) this.settleReload(this.reload);
    if (this.branch) this.deps.recovery.releaseBranch?.(this.branch);
    this.branch = undefined;
    if (this.transition?.windowEpoch !== this.deps.getContext().windowEpoch) this.transition = null;
    for (const operation of [...this.operations.values()]) {
      this.fence(operation);
      if (operation.requestId) this.handleDepartureCancelled(operation.requestId);
      else this.finishBackground(operation, "failed", "The project changed before saving finished");
    }
    this.deps.source.retire();
    this.coordinator?.contextChanged();
    if (replacement) {
      this.recoveryOriginIdentity = undefined; this.sourceOwner = undefined; this.pendingDestination = undefined; this.documentOwner = {};
      this.recordId = randomUUID(); this.revision = 0; this.lastCapture = null;
      this.latestSource = undefined; this.latestRecovery = undefined; this.recoveredFrom = recoveredFrom && copy(recoveredFrom);
      this.recoveredSourceDigest = recoveredFrom && (this.preparedRecoveryDigests.get(recoveredFrom) ?? recoveredFrom.receipt.digest);
      this.sourceResolution = undefined;
      this.savedSource = undefined;
      this.updates.clear(); this.sourceIdentities.clear();
    }
  }
  /** Recovery provenance is an exclusion, never authority to overwrite the original. */
  async assertNotRecoveredOrigin(folder: string, assertCurrent?: () => void): Promise<void> {
    const origin = this.recoveredFrom?.origin;
    if (!origin || origin.kind === "untitled") return;
    const destination = await projectFolderIdentity(folder, { allowMissing: true, assertCurrent }); assertCurrent?.();
    const original = await projectFolderIdentity(origin.folderPath, { allowMissing: true, assertCurrent }); assertCurrent?.();
    if (sameProjectFolder(destination, original)) throw new Error("Recovered edits must be saved into a different folder. Choose a location for a new copy.");
  }
  async assertDestination(folder: string, assertCurrent?: () => void): Promise<void> {
    const destination = await projectFolderIdentity(folder, { assertCurrent }); assertCurrent?.();
    await this.assertNotRecoveredOrigin(destination.folderPath, assertCurrent); assertCurrent?.();
    await this.deps.source.assertReadable(destination.folderPath, assertCurrent);
  }
  captureRequest(value: ProjectCheckpointRequest): ProjectSourceCapture {
    if (!value || !value.context || !sameProjectContext(value.context, this.deps.getContext()) || !Number.isSafeInteger(value.snapshotRevision) || value.snapshotRevision < 0
      || (value.requestId !== undefined && (typeof value.requestId !== "string" || !value.requestId || value.requestId.length > 128))) throw new Error("Project checkpoint context is no longer current");
    if (value.requestId && !this.coordinator) throw new Error("Project departure integration is not attached");
    return this.deps.source.capture(value.project, value.context, value.snapshotRevision);
  }
  private origin(): RecoveryOrigin {
    if (this.recoveredFrom) return copy(this.recoveredFrom.origin);
    const location = this.deps.getLocation();
    if (location.folderPath && location.legacyFile) return { kind: "legacy", folderPath: location.folderPath, legacyFile: location.legacyFile, projectPath: location.projectPath };
    if (location.folderPath) return { kind: "folder", folderPath: location.folderPath, projectPath: location.projectPath };
    return { kind: "untitled", id: this.deps.getContext().documentSessionId };
  }
  private recoveryCapture(capture: ProjectSourceCapture): RecoveryWriteRequest {
    const origin = this.origin(), key = capture.digest + JSON.stringify(origin);
    if (this.sourceResolution || this.lastCapture?.key !== key) this.lastCapture = { key, revision: ++this.revision, capturedAt: capture.capturedAt };
    this.sourceResolution = undefined;
    capture.capturedAt = this.lastCapture.capturedAt;
    return { recordId: this.recordId, revision: this.lastCapture.revision, capturedAt: this.lastCapture.capturedAt, displayName: boundedName(capture.project.name), reason: "checkpoint", origin, project: capture.project, ...(!this.recoveredFrom && this.recoveryOriginIdentity ? { originIdentity: this.recoveryOriginIdentity } : {}) };
  }
  private receipt(operationId: string, capture: ProjectSourceCapture, kind: "source" | "recovery", digest: string): ProjectStorageReceipt {
    return { operationId, context: copy(this.deps.getContext()), snapshotRevision: capture.snapshotRevision, digest, capturedAt: capture.capturedAt,
      completedAt: new Date((this.deps.now ?? Date.now)()).toISOString(), kind };
  }
  private publish(update: ProjectPersistenceUpdate): void {
    this.updates.set(update.operationId, copy(update));
    while (this.updates.size > 16) this.updates.delete(this.updates.keys().next().value!);
    this.deps.onUpdate(copy(update));
  }
  replay(context: ProjectDurabilityContext, operationId: string): ProjectPersistenceUpdate | null {
    if (!sameProjectContext(context, this.deps.getContext())) throw new Error("Project checkpoint context is no longer current");
    return copy(this.updates.get(operationId) ?? null);
  }
  private fence(operation: Operation): void {
    if (!operation.valid) return;
    operation.valid = false; this.deps.source.revoke(operation.capture);
  }
  cancel(context: ProjectDurabilityContext, operationId: string): boolean {
    if (!sameProjectContext(context, this.deps.getContext())) return false;
    const operation = this.operations.get(operationId);
    if (!operation) return false;
    this.fence(operation);
    if (!operation.requestId) this.finishBackground(operation, "failed", "Saving was cancelled");
    else this.coordinator?.editingResumed(context.windowEpoch);
    return true;
  }
  /** Wire the real coordinator's onCheckpoint callback here; terminal IPC resolves independently of physical I/O. */
  handleDepartureUpdate(update: ProjectCheckpointUpdate): void {
    const operation = this.operations.get(update.operationId);
    if (!operation || operation.requestId !== update.requestId) return;
    const result: ProjectPersistenceUpdate = { ...copy(update), mode: "departure", ...(operation.update.recoveryCode ? { recoveryCode: operation.update.recoveryCode } : {}) };
    this.publish(result);
    if (update.source !== "pending") { clearTimeout(operation.timer); operation.resolve(result); this.operations.delete(operation.id); }
  }
  handleDepartureCancelled(requestId: string): void {
    for (const operation of [...this.operations.values()]) {
      if (operation.requestId !== requestId) continue;
      this.fence(operation);
      const previous = this.updates.get(operation.id);
      const result: ProjectPersistenceUpdate = { ...(previous?.mode === "departure" ? previous : operation.update), requestId, mode: "departure",
        source: "failed", sourceFact: "Saving was cancelled", context: copy(operation.capture.context), recovery: previous?.recovery === "saved" ? "saved" : "failed" } as ProjectPersistenceUpdate;
      delete result.sourceChange;
      clearTimeout(operation.timer); this.publish(result); operation.resolve(result); this.operations.delete(operation.id);
    }
  }
  private finishBackground(operation: Operation, source: ProjectBackgroundCheckpoint["source"], fact?: string, sourceChange?: ProjectCheckpointUpdate["sourceChange"]): void {
    this.fence(operation);
    operation.update.source = source; operation.update.sourceFact = fact;
    if (source === "failed" && sourceChange) operation.update.sourceChange = copy(sourceChange);
    else delete operation.update.sourceChange;
    operation.update.context = copy(operation.capture.context);
    if (operation.update.recovery === "pending") { operation.update.recovery = "failed"; operation.update.recoveryFact = "Recovery copy did not finish"; }
    clearTimeout(operation.timer); this.publish(operation.update); operation.resolve(copy(operation.update)); this.operations.delete(operation.id);
  }
  checkpoint(request: ProjectCheckpointRequest, destination?: ProjectSourceDestination, prepared?: ProjectSourceCapture): Promise<ProjectPersistenceUpdate> {
    if (!request?.requestId && (this.reload || [...this.operations.values()].some(operation => operation.valid)
      || (this.coordinator && !["idle", "retired"].includes(this.coordinator.snapshot().phase)))) {
      if (prepared) this.deps.source.revoke(prepared);
      throw new Error("A project checkpoint is already running");
    }
    const capture = prepared ?? this.captureRequest(request);
    let recovery: RecoveryWriteRequest;
    try {
      this.deps.source.assertCurrent(capture);
      if (destination?.requiredOwner && (!this.ownsPendingDestination(destination.requiredOwner)
        || destination.requiredOwner !== this.pendingDestination)) throw new Error("That project folder changed while saving · Choose another name");
      recovery = this.recoveryCapture(capture);
    }
    catch (error) { this.deps.source.revoke(capture); throw error; }
    let operation!: Operation;
    const operationId = request.requestId ? this.coordinator?.beginCheckpoint(request.requestId, capture.context, {
      snapshotRevision: capture.snapshotRevision, digest: capture.digest, capturedAt: capture.capturedAt, fence: () => { if (operation) this.fence(operation); },
    }) : capture.operationId;
    if (!operationId) { this.deps.source.revoke(capture); throw new Error("Project departure request is no longer active"); }
    // A real admitted departure supersedes earlier background admission, including unresolved identity reads.
    // Already-started physical writes remain busy; a late preflight cannot write behind this newer receipt.
    if (request.requestId && this.reload) this.settleReload(this.reload);
    if (request.requestId) for (const earlier of [...this.operations.values()]) {
      if (!earlier.requestId && earlier.valid) this.finishBackground(earlier, "failed", "Saving was interrupted by the project checkpoint");
    }
    const location = this.deps.getLocation();
    const capturedDestination = destination ? { ...destination } : location.folderPath ? { folderPath: location.folderPath, projectPath: location.projectPath, legacyFile: location.legacyFile } : undefined;
    // Capture the document and owner object before recovery/preflight can yield. Never fetch a new active head later.
    const result = new Promise<ProjectPersistenceUpdate>(resolve => { operation = {
      capture, documentOwner: this.documentOwner,
      sourceOwner: this.sourceOwner && sameProjectContext(this.sourceOwner.context, capture.context) ? this.sourceOwner : undefined,
      pendingOwner: this.pendingDestination && sameProjectContext(this.pendingDestination.context, capture.context) ? this.pendingDestination : undefined,
      id: operationId, valid: true, requestId: request.requestId, resolve,
      deadline: performance.now() + (this.deps.recoveryTimeoutMs ?? PROJECT_RECOVERY_PHASE_MS) + (this.deps.sourceTimeoutMs ?? 8_000),
      update: { mode: "background", operationId, context: copy(capture.context), snapshotRevision: capture.snapshotRevision, source: "pending", recovery: "pending" } }; });
    operation.update.location = copy(this.deps.getLocation());
    this.operations.set(operation.id, operation);
    if (!request.requestId) {
      operation.timer = setTimeout(() => { this.fence(operation); this.finishBackground(operation, "timed-out", "Folder isn’t responding"); }, (this.deps.recoveryTimeoutMs ?? PROJECT_RECOVERY_PHASE_MS) + (this.deps.sourceTimeoutMs ?? 8_000));
      this.publish(operation.update);
    }
    void this.run(operation, recovery, capturedDestination);
    return result;
  }
  /** Only admitted physical source evidence may authorize reading this document again. */
  sourceRoot(context: ProjectDurabilityContext): ReloadRoot | null {
    const owner = this.sourceOwner;
    return !this.recoveredFrom && owner?.identity.objectKey && sameProjectContext(context, this.deps.getContext())
      && sameProjectContext(owner.context, context) ? copy(owner.identity as ReloadRoot) : null;
  }
  private reloadCurrent(admission: ReloadAdmission): boolean {
    return admission.valid && admission.documentOwner === this.documentOwner && admission.sourceOwner === this.sourceOwner
      && sameProjectContext(admission.context, this.deps.getContext()) && this.isTransitionCurrent(admission.transition);
  }
  private settleReload(admission: ReloadAdmission): void {
    if (admission.settled) return;
    admission.valid = false; admission.settled = true;
    this.deps.source.revoke(admission.capture); admission.cancel();
    if (this.reload === admission) this.reload = null;
  }
  /** Reserves synchronously before any recovery or source I/O can yield. */
  beginReload(request: ProjectReloadRequest): ReloadHandle | { refused: ProjectReloadFailureCode; fact: string } {
    if (request?.requestId !== undefined || !this.isTransitionCurrent(request?.transition)
      || !sameProjectContext(request?.context, this.deps.getContext())) return { refused: "stale", fact: "The project changed while reloading" };
    if (this.reload || [...this.operations.values()].some(operation => operation.valid)
      || (this.coordinator && !["idle", "retired"].includes(this.coordinator.snapshot().phase))) return { refused: "busy", fact: "A project checkpoint is already running" };
    const sourceOwner = this.sourceOwner, root = this.sourceRoot(request.context), origin = this.recoveryOriginIdentity;
    if (!sourceOwner || !root || !origin) return { refused: "not-reloadable", fact: "This project has no source to reload" };
    let capture: ProjectSourceCapture | undefined;
    try {
      capture = this.captureRequest(request); this.deps.source.assertCurrent(capture);
      const recovery = this.recoveryCapture(capture);
      let cancel!: () => void;
      const cancelled = new Promise<null>(resolve => { cancel = () => resolve(null); });
      const admission: ReloadAdmission = { id: capture.operationId, context: copy(capture.context), transition: copy(request.transition),
        documentOwner: this.documentOwner, sourceOwner, root, selectionPath: origin.legacyFile ?? origin.folderPath,
        legacyFile: origin.legacyFile ?? null, capture, recovery, valid: true, settled: false, started: false, cancelled, cancel };
      this.reload = admission;
      return {
        get root() { return copy(admission.root); }, selectionPath: admission.selectionPath, legacyFile: admission.legacyFile,
        assertCurrent: () => { if (!this.reloadCurrent(admission)) throw new ReloadStale(); },
        release: () => this.settleReload(admission),
        keep: async () => {
          if (admission.started) return { status: "failed", code: "stale", fact: "The project changed while reloading" };
          if (!this.reloadCurrent(admission)) { this.settleReload(admission); return { status: "failed", code: "stale", fact: "The project changed while reloading" }; }
          admission.started = true;
          try {
            const phase = await Promise.race([this.writeRecoveryPhase(admission.id, admission.capture, admission.recovery,
              () => this.reloadCurrent(admission)), admission.cancelled]);
            if (!phase || !this.reloadCurrent(admission)) {
              this.settleReload(admission); return { status: "failed", code: "stale", fact: "The project changed while reloading" };
            }
            return { status: "kept", kept: copy(phase.receipt) };
          } catch (error) {
            const stale = !this.reloadCurrent(admission);
            this.settleReload(admission);
            if (stale) return { status: "failed", code: "stale", fact: "The project changed while reloading" };
            const recoveryCode = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "storage-unavailable";
            return { status: "failed", code: recoveryCode === "capacity" ? "recovery-capacity" : recoveryCode === "timed-out" ? "recovery-timed-out" : "recovery-failed",
              fact: recoveryCode === "capacity" ? "Recovery storage full" : recoveryCode === "timed-out" ? "Recovery copy didn’t finish in time" : "Couldn’t keep a recovery copy",
              recoveryCode, recoveryFact: error instanceof Error ? error.message : "Recovery copy could not be saved" };
          } finally { this.deps.source.revoke(admission.capture); }
        },
      };
    } catch (error) { if (capture) this.deps.source.revoke(capture); throw error; }
  }
  /** Exact confirmed recovery storage, shared by checkpoints and recovery-only reload. */
  private async writeRecoveryPhase(operationId: string, capture: ProjectSourceCapture, recovery: RecoveryWriteRequest,
    live: () => boolean): Promise<{ stored: RecoveryWriteReceipt; receipt: ProjectKeptRecovery } | null> {
    let timer: ReturnType<typeof setTimeout> | undefined, phaseLive = true;
    this.branch ??= this.deps.recovery.createBranch?.();
    const branch = this.branch;
    try {
      const stored = await Promise.race([this.deps.recovery.writeSnapshot(recovery, branch, () => phaseLive && live()), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("Recovery copy did not finish in time"), { code: "timed-out" })), this.deps.recoveryTimeoutMs ?? PROJECT_RECOVERY_PHASE_MS);
      })]);
      if (!stored.stored || (branch ? stored.requested?.recordId !== recovery.recordId || stored.requested?.revision !== recovery.revision : stored.recordId !== recovery.recordId || stored.revision !== recovery.revision) || stored.digest !== capture.digest || stored.capturedAt !== recovery.capturedAt) throw new Error("This recovery revision was not confirmed");
      if (!live()) return null;
      this.recordId = stored.recordId;
      const receipt: ProjectKeptRecovery = { ...this.receipt(operationId, capture, "recovery", stored.digest), kind: "recovery",
        storedSnapshot: { recordId: stored.recordId, revision: stored.revision, digest: stored.digest } };
      this.latestRecovery = receipt;
      return { stored, receipt };
    } finally { phaseLive = false; clearTimeout(timer); }
  }
  /** Ordinary Save still awaits automatic export; listeners already received its exact source outcome. */
  async saveWithExport(request: ProjectCheckpointRequest, destination: ProjectSourceDestination, capture: ProjectSourceCapture,
    exportSaved: (saved: SavedProjectCheckpoint, scope: ProjectBdxExportScope) => Promise<ProjectCheckpointSaveResult>,
    captureBinding: () => { key: string; isCurrent(): boolean } = () => ({ key: "unlinked", isCurrent: () => true })): Promise<ProjectCheckpointSaveResult> {
    const saved = await this.checkpoint(request, destination, capture);
    if (saved.source !== "saved" || !saved.canonicalProject || !saved.location) throw new Error(saved.sourceFact || "Project source could not be saved");
    try {
      const identity = this.sourceIdentities.get(saved.operationId);
      if (!identity || !sameProjectContext(saved.context, this.deps.getContext())) return { ...projectBdxFailure(saved.location, new Error("The project changed before export started"), false, "changed"), canonicalProject: saved.canonicalProject };
      return { ...await this.deps.source.exportSaved({ folderIdentity: identity, digest: saved.sourceReceipt!.digest, context: saved.context, location: saved.location },
        saved.canonicalProject.paths.filter(candidate => candidate.exportable !== false && candidate.waypoints.length >= 2).length,
        captureBinding(), scope => exportSaved(saved as SavedProjectCheckpoint, scope), this.deps.exportLimits), canonicalProject: saved.canonicalProject };
    } catch (error) { return { ...projectBdxFailure(saved.location, error), canonicalProject: saved.canonicalProject }; }
  }
  private async run(operation: Operation, recovery: RecoveryWriteRequest, destination?: ProjectSourceDestination): Promise<void> {
    try {
      const phase = await this.writeRecoveryPhase(operation.id, operation.capture, recovery,
        () => operation.valid && sameProjectContext(operation.capture.context, this.deps.getContext()));
      if (!phase || !operation.valid || !sameProjectContext(operation.capture.context, this.deps.getContext())) return;
      operation.confirmedRecovery = phase.receipt.storedSnapshot;
      if (operation.requestId) this.coordinator?.recordRecovery(operation.id, phase.stored);
      else { operation.update.recovery = "saved"; operation.update.recoveryReceipt = phase.receipt; this.publish(operation.update); }
    } catch (error) {
      if (!operation.valid) return;
      const fact = error instanceof Error ? error.message : "Recovery copy could not be saved";
      operation.update.recoveryCode = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "storage-unavailable";
      if (operation.requestId) this.coordinator?.recordRecoveryFailure(operation.id, fact);
      else { operation.update.recovery = "failed"; operation.update.recoveryFact = fact; this.publish(operation.update); }
    }
    if (!operation.valid) return;
    const required = destination?.requiredOwner;
    const target = destination ? { ...destination, requiredOwner: undefined } : undefined;
    if (!target) {
      this.deps.source.revoke(operation.capture);
      if (operation.requestId) this.coordinator?.finishCheckpoint(operation.id, "unavailable", { sourceFact: "Not in a folder yet" });
      else this.finishBackground(operation, "unavailable", "Not in a folder yet");
      return;
    }
    try {
      const guard = () => { if (operation.documentOwner !== this.documentOwner || !operation.valid) throw new Error("The project changed before saving finished"); this.deps.source.assertCurrent(operation.capture); };
      const previous = this.savedSource;
      const identity = await projectFolderIdentity(target.folderPath, { assertCurrent: guard });
      const admitted = operation.sourceOwner;
      const matches = (candidate?: ProjectSourceOwner) => Boolean(candidate && sameProjectFolder(identity, candidate.identity) && identity.objectKey === candidate.identity.objectKey);
      let owner = required
        ? required === operation.pendingOwner && required === this.pendingDestination && matches(required) ? required : undefined
        : [admitted, operation.pendingOwner].find(matches);
      if (!owner) {
        if (required) throw new Error("That project folder changed while saving · Choose another name");
        // A current source never gains content authority by observing whatever is on disk at Save.
        if (admitted?.identity.folderPath === path.resolve(target.folderPath)) throw new Error("Project folder changed. Reopen it or save a copy in a different folder.");
        if (path.resolve(target.folderPath) === this.deps.getLocation().folderPath) throw new Error("Project source was not admitted. Reopen it or choose a new folder for a copy.");
        guard(); const fresh = { ...absentProjectSource(identity), context: copy(operation.capture.context) }; owner = fresh; this.pendingDestination = fresh;
      }
      const busy = await this.deps.source.isBusy(identity.folderPath), pendingSource = await this.deps.source.hasPendingSource(identity.folderPath);
      const previousIdentity = busy && !pendingSource && previous?.result.location.folderPath ? await projectFolderIdentity(previous.result.location.folderPath, { assertCurrent: guard }) : undefined;
      const canConfirm = busy && !pendingSource
        && previous && sameProjectContext(previous.result.context, operation.capture.context)
        && target.projectPath && path.basename(target.projectPath) === path.basename(previous.result.location.projectPath!) && previousIdentity && sameProjectFolder(identity, previousIdentity)
        && [previous.inputDigest, previous.result.digest].includes(operation.capture.digest);
      guard();
      if (!canConfirm) await this.assertDestination(identity.folderPath, guard);
      guard();
      const saved = canConfirm
        ? await this.deps.source.confirmSaved(operation.capture, previous.result, this.deps.sourceTimeoutMs)
        : await this.deps.source.persist(operation.capture, { ...target, legacyFile: owner === admitted ? target.legacyFile : undefined, folderIdentity: owner.identity, sourceOwner: owner }, this.deps.sourceTimeoutMs);
      if (!operation.valid || !sameProjectContext(saved.context, this.deps.getContext())) return;
      this.sourceIdentities.set(operation.id, saved.folderIdentity);
      while (this.sourceIdentities.size > 16) this.sourceIdentities.delete(this.sourceIdentities.keys().next().value!);
      this.savedSource = { inputDigest: operation.capture.digest, result: { ...copy(saved), sourceOwner: saved.sourceOwner } };
      const receipt = this.receipt(operation.id, operation.capture, "source", saved.digest); this.latestSource = receipt;
      const resolved = operation.confirmedRecovery ? [operation.confirmedRecovery] : [];
      if (this.recoveredFrom && this.recoveredSourceDigest === operation.capture.digest) resolved.push(this.recoveredFrom.receipt);
      this.sourceResolution = { inputDigest: operation.capture.digest, savedDigest: saved.digest, recoveries: copy(resolved) };
      this.recoveredFrom = undefined;
      this.recoveredSourceDigest = undefined;
      // Only this successful current operation may install its captured physical head at the target.
      this.sourceOwner = Object.assign(saved.sourceOwner, { context: copy(saved.context) });
      if (this.pendingDestination === saved.sourceOwner) this.pendingDestination = undefined;
      this.setRecoveryOrigin(saved.folderIdentity, saved.location.legacyFile);
      // Persist resolution before a close receipt can destroy the process, but never make
      // metadata failure a source-save failure. Reserve time within this checkpoint budget.
      const budget = Math.min(PROJECT_RECOVERY_RESOLUTION_MS, operation.deadline - performance.now() - 25);
      if (budget > 0 && this.deps.recovery.markResolved && resolved.length) {
        let current = true, resolutionTimer: ReturnType<typeof setTimeout> | undefined;
        const live = () => current && operation.valid && sameProjectContext(saved.context, this.deps.getContext());
        const sourceOrigin: RecoveryOrigin = { kind: "folder", folderPath: saved.folderIdentity.folderPath, projectPath: saved.location.projectPath };
        try {
          await Promise.race([Promise.all(resolved.map(item => this.deps.recovery.markResolved!(item, { digest: saved.digest, origin: sourceOrigin, identity: this.recoveryOriginIdentity }, live))),
            new Promise<void>(resolve => { resolutionTimer = setTimeout(() => { current = false; resolve(); }, budget); })]);
        } catch { /* The actual source receipt remains successful; unresolved snapshots stay visible. */ }
        finally { current = false; clearTimeout(resolutionTimer); }
      }
      if (!operation.valid || !sameProjectContext(saved.context, this.deps.getContext())) return;
      if (operation.requestId) {
        if (!sameProjectContext(operation.update.context, saved.context)) this.coordinator?.advanceTarget(operation.id, saved.context);
        this.coordinator?.recordSource(operation.id, { digest: saved.digest, location: saved.location, canonicalProject: saved.project });
      } else {
        operation.update.sourceReceipt = receipt; operation.update.location = saved.location; operation.update.canonicalProject = saved.project;
        this.finishBackground(operation, "saved");
      }
    } catch (error) {
      if (!operation.valid) return;
      const fact = describeProjectWriteError(error), sourceChange = sourceChangeFact(error);
      if (operation.requestId) this.coordinator?.finishCheckpoint(operation.id, "failed", { sourceFact: fact, sourceChange });
      else this.finishBackground(operation, "failed", fact, sourceChange);
    }
  }
}
