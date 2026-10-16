import { randomUUID } from "node:crypto";
import type {
  ProjectCheckpointUpdate, ProjectDepartureFallback, ProjectDepartureIntent, ProjectDepartureNativeEvent,
  ProjectDeparturePermit, ProjectDeparturePhase, ProjectDepartureReason, ProjectDepartureRequest,
  ProjectDepartureResponse, ProjectDepartureResume, ProjectDurabilityContext, ProjectDurabilityReceipt,
  ProjectUpdateDeparture, StoredProjectRecoveryReceipt,
} from "../shared/project/projectDurability";

export const PROJECT_DEPARTURE_TIMEOUT_MS = 10_000;
type Timer = ReturnType<typeof setTimeout>;
export interface ProjectDepartureDependencies {
  getContext(): ProjectDurabilityContext | null;
  isRendererAlive(windowEpoch: string): boolean;
  isTrustedSender(sender: unknown, context: ProjectDurabilityContext): boolean;
  getTransitionId(): string | null;
  onRequest(request: ProjectDepartureRequest): void;
  onCheckpoint(update: ProjectCheckpointUpdate): void;
  onCancelled(requestId: string): void;
  onFallback(fallback: ProjectDepartureFallback): void;
  onDismissFallback(fallbackId: string): void;
  onContinue(permit: ProjectDeparturePermit): void;
  onReopen(request: ProjectDepartureRequest): void;
  now?: () => number;
  id?: () => string;
  schedule?: (callback: () => void, delay: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  timeoutMs?: number;
}
interface Operation {
  id: string;
  live: boolean;
  terminal: boolean;
  digest: string;
  capturedAt: string;
  generations: Set<number>;
  update: ProjectCheckpointUpdate;
  fence(): void;
}
interface Active {
  request: ProjectDepartureRequest;
  phase: ProjectDeparturePhase;
  operation?: Operation;
  transitionId?: string;
  fallback?: ProjectDepartureFallback;
  permit?: ProjectDeparturePermit;
  nativeEvents: Set<ProjectDepartureNativeEvent>;
  rendererGone: boolean;
}
const copy = <T>(value: T): T => structuredClone(value);
const digestPattern = /^[0-9a-f]{64}$/;
function sameContext(a: ProjectDurabilityContext, b: ProjectDurabilityContext | null): boolean {
  return Boolean(b && a.windowEpoch === b.windowEpoch && a.documentSessionId === b.documentSessionId && a.targetGeneration === b.targetGeneration);
}
function validContext(value: ProjectDurabilityContext): boolean {
  return Boolean(value && typeof value.windowEpoch === "string" && value.windowEpoch && typeof value.documentSessionId === "string"
    && value.documentSessionId && Number.isSafeInteger(value.targetGeneration) && value.targetGeneration >= 0);
}

/** Main-owned admission and receipt accounting only: no DOM, filesystem writes or installer calls. */
export class ProjectDepartureCoordinator {
  private active: Active | null = null;
  private phase: ProjectDeparturePhase = "idle";
  private timer: Timer | null = null;
  private updateAttempt: { id: string; started: boolean; handoff: boolean; failed: boolean } | null = null;
  private readonly now: () => number;
  private readonly id: () => string;
  private deadlineGeneration = 0;
  private readonly schedule: NonNullable<ProjectDepartureDependencies["schedule"]>;
  private readonly clearTimer: NonNullable<ProjectDepartureDependencies["clearTimer"]>;
  private readonly timeoutMs: number;

  constructor(private readonly deps: ProjectDepartureDependencies) {
    this.now = deps.now ?? Date.now;
    this.id = deps.id ?? randomUUID;
    this.schedule = deps.schedule ?? setTimeout;
    this.clearTimer = deps.clearTimer ?? clearTimeout;
    this.timeoutMs = deps.timeoutMs ?? PROJECT_DEPARTURE_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("Departure timeout must be positive");
  }
  snapshot(): { phase: ProjectDeparturePhase; request?: ProjectDepartureRequest; checkpoint?: ProjectCheckpointUpdate; permit?: ProjectDeparturePermit } {
    return copy({ phase: this.active?.phase ?? this.phase, request: this.active?.request, checkpoint: this.active?.operation?.update, permit: this.active?.permit });
  }
  private clearDeadline(): void {
    this.deadlineGeneration += 1;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }
  private deadline(active: Active, callback: () => void): void {
    this.clearDeadline();
    const generation = this.deadlineGeneration;
    this.timer = this.schedule(() => {
      if (this.deadlineGeneration !== generation || this.active !== active) return;
      this.timer = null;
      callback();
    }, this.timeoutMs);
  }
  private fence(operation?: Operation): void {
    if (!operation?.live) return;
    operation.live = false; // Callers must also check isOperationCurrent before committing a target.
    operation.fence(); // Synchronous lease revocation, before any timeout/cancellation publication.
  }
  private dismissFallback(active: Active): void {
    const previous = active.fallback;
    active.fallback = undefined;
    if (previous) this.deps.onDismissFallback(previous.fallbackId);
  }
  private retire(next: "idle" | "retired" = "idle"): void {
    const previous = this.active;
    this.active = null;
    this.phase = next;
    this.clearDeadline();
    if (!previous) return;
    this.fence(previous.operation);
    this.dismissFallback(previous);
    this.deps.onCancelled(previous.request.requestId);
  }
  private start(intent: ProjectDepartureIntent, context: ProjectDurabilityContext): ProjectDepartureRequest {
    const request = { ...copy(intent), requestId: this.id(), context: copy(context) };
    const active: Active = { request, phase: "requesting", nativeEvents: new Set(), rendererGone: false };
    this.active = active;
    this.deadline(active, () => this.fallback(active, "no-response"));
    this.deps.onRequest(copy(request));
    return copy(request);
  }
  request(reason: ProjectDepartureReason, update?: ProjectUpdateDeparture): ProjectDepartureRequest | null {
    const context = this.deps.getContext();
    if (!context || !validContext(context)) return null;
    if ((reason === "update") !== Boolean(update)) return null;
    const previous = this.active;
    if (previous && previous.request.reason === reason && sameContext(previous.request.context, context)
      && previous.request.update?.attemptId === update?.attemptId && previous.request.update?.continuation === update?.continuation) return copy(previous.request);
    if (update) {
      if (update.continuation === "start-install") {
        if (this.updateAttempt?.id === update.attemptId && this.updateAttempt.started) return null;
        this.updateAttempt = { id: update.attemptId, started: false, handoff: false, failed: false };
      } else if (this.updateAttempt?.id !== update.attemptId || !this.updateAttempt.handoff || this.updateAttempt.failed) return null;
    }
    this.retire();
    return this.start({ intentId: this.id(), reason, ...(update ? { update } : {}) }, context);
  }
  private matched(requestId: string, context: ProjectDurabilityContext): Active | null {
    const active = this.active;
    return active && active.request.requestId === requestId && sameContext(active.request.context, context)
      && sameContext(context, this.deps.getContext()) ? active : null;
  }
  private liveSender(sender: unknown, context: ProjectDurabilityContext, active: Active): boolean {
    return !active.rendererGone && this.deps.isRendererAlive(context.windowEpoch) && this.deps.isTrustedSender(sender, context);
  }
  respond(sender: unknown, response: ProjectDepartureResponse): boolean {
    if (!response || !validContext(response.context)) return false;
    const active = this.matched(response.requestId, response.context);
    if (!active || !this.liveSender(sender, response.context, active) || active.phase === "approved") return false;
    if (["cancelled", "invalid-input", "composing"].includes(response.outcome)) { this.retire(); return true; }
    if (response.outcome === "draining") {
      if (active.phase !== "requesting") return false;
      active.phase = "draining"; // Does not reset or suspend the existing admission deadline.
      return true;
    }
    if (response.outcome === "busy") {
      if (!["requesting", "draining"].includes(active.phase) || active.operation || !response.transitionId
        || response.transitionId !== this.deps.getTransitionId()) return false;
      active.transitionId = response.transitionId;
      active.phase = "waiting-transition";
      this.deadline(active, () => this.fallback(active, "busy-timeout"));
      return true;
    }
    const operation = active.operation;
    if (!operation?.terminal) return false;
    if (response.outcome === "choosing") {
      if (active.phase === "waiting-transition" || operation.update.source === "saved") return false;
      this.dismissFallback(active);
      active.phase = "choosing";
      this.clearDeadline();
      return true;
    }
    if (response.outcome === "discard") {
      if (active.phase !== "choosing" || response.confirmed !== true || operation.update.recovery === "saved") return false;
      this.approve(active, "discard"); return true;
    }
    if (response.outcome !== "saved" && response.outcome !== "recovery") return false;
    if (response.outcome === "recovery" && active.phase !== "choosing" && active.phase !== "native-fallback") return false;
    const receipt = response.outcome === "saved" ? operation.update.sourceReceipt : operation.update.recoveryReceipt;
    if (!receipt || receipt.receiptId !== response.receiptId || receipt.operationId !== response.operationId
      || receipt.snapshotRevision !== response.snapshotRevision || receipt.operationId !== operation.id
      || receipt.requestId !== active.request.requestId || receipt.kind !== (response.outcome === "saved" ? "source" : "recovery")
      || receipt.context.windowEpoch !== response.context.windowEpoch || receipt.context.documentSessionId !== response.context.documentSessionId
      || !operation.generations.has(receipt.context.targetGeneration)) return false;
    this.approve(active, receipt.kind, receipt);
    return true;
  }
  resume(sender: unknown, token: ProjectDepartureResume): boolean {
    const active = this.active, context = this.deps.getContext();
    if (!active || !context || active.phase !== "waiting-transition" || !token
      || token.intentId !== active.request.intentId || token.blockedRequestId !== active.request.requestId
      || token.transitionId !== active.transitionId || token.windowEpoch !== active.request.context.windowEpoch
      || context.windowEpoch !== token.windowEpoch || this.deps.getTransitionId() !== null || !this.liveSender(sender, context, active)) return false;
    const intent = { intentId: active.request.intentId, reason: active.request.reason, update: active.request.update };
    this.retire(); this.start(intent, context); return true;
  }
  /** Main-only: call after trusted IPC admission and capturing immutable canonical source. */
  beginCheckpoint(requestId: string, context: ProjectDurabilityContext, capture: {
    snapshotRevision: number; digest: string; capturedAt: string; fence(): void;
  }): string | null {
    const active = this.matched(requestId, context);
    if (!active || active.rendererGone || !this.deps.isRendererAlive(context.windowEpoch)
      || !["requesting", "draining", "choosing"].includes(active.phase) || active.operation?.live
      || !Number.isSafeInteger(capture.snapshotRevision) || capture.snapshotRevision < 0 || !digestPattern.test(capture.digest)
      || !Number.isFinite(Date.parse(capture.capturedAt)) || new Date(capture.capturedAt).toISOString() !== capture.capturedAt) return null;
    const operationId = this.id();
    active.operation = { id: operationId, live: true, terminal: false, digest: capture.digest, capturedAt: capture.capturedAt,
      generations: new Set([context.targetGeneration]), fence: capture.fence,
      update: { requestId, operationId, context: copy(context), snapshotRevision: capture.snapshotRevision, recovery: "pending", source: "pending" } };
    active.phase = "draining";
    this.deadline(active, () => {
      const operation = active.operation;
      if (!operation?.live || operation.id !== operationId) return;
      this.fence(operation);
      this.finish(active, "timed-out", "Saving did not finish in time");
    });
    return operationId;
  }
  isOperationCurrent(operationId: string): boolean {
    const active = this.active;
    return Boolean(active?.operation?.id === operationId && active.operation.live && sameContext(active.request.context, this.deps.getContext()) && !active.rendererGone);
  }
  /** A source write may migrate its own target; opening another document must use contextChanged instead. */
  advanceTarget(operationId: string, next: ProjectDurabilityContext): boolean {
    const active = this.active, operation = active?.operation;
    if (!active || !operation?.live || operation.id !== operationId || !validContext(next) || !sameContext(next, this.deps.getContext())
      || next.windowEpoch !== active.request.context.windowEpoch || next.documentSessionId !== active.request.context.documentSessionId
      || next.targetGeneration <= active.request.context.targetGeneration) return false;
    active.request.context = copy(next);
    operation.update.context = copy(next);
    operation.generations.add(next.targetGeneration);
    return true;
  }
  private receipt(active: Active, kind: "source" | "recovery", digest: string, storedSnapshot?: StoredProjectRecoveryReceipt): ProjectDurabilityReceipt {
    const operation = active.operation!;
    return { receiptId: this.id(), requestId: active.request.requestId, operationId: operation.id, context: copy(active.request.context),
      snapshotRevision: operation.update.snapshotRevision, digest, kind, capturedAt: operation.capturedAt, completedAt: new Date(this.now()).toISOString(),
      ...(storedSnapshot ? { storedSnapshot: copy(storedSnapshot) } : {}) };
  }
  /** Main-only: never expose receipt registration as renderer IPC. A queued successor is not evidence. */
  recordRecovery(operationId: string, evidence: StoredProjectRecoveryReceipt & { stored: boolean; capturedAt: string }): ProjectDurabilityReceipt | null {
    if (!this.isOperationCurrent(operationId)) return null;
    const active = this.active!, operation = active.operation!;
    if (operation.update.recovery !== "pending" || evidence?.stored !== true || evidence.digest !== operation.digest
      || evidence.capturedAt !== operation.capturedAt || !evidence.recordId || !Number.isSafeInteger(evidence.revision) || evidence.revision < 0) return null;
    const receipt = this.receipt(active, "recovery", evidence.digest, { recordId: evidence.recordId, revision: evidence.revision, digest: evidence.digest });
    operation.update.recovery = "saved"; operation.update.recoveryReceipt = receipt;
    this.deps.onCheckpoint(copy(operation.update));
    return copy(receipt);
  }
  recordRecoveryFailure(operationId: string, fact: string): boolean {
    if (!this.isOperationCurrent(operationId) || this.active!.operation!.update.recovery !== "pending") return false;
    const update = this.active!.operation!.update;
    update.recovery = "failed"; update.recoveryFact = fact;
    this.deps.onCheckpoint(copy(update));
    return true;
  }
  /** Main-only: publish immediately after source write/target commit, before awaiting BDX. */
  recordSource(operationId: string, evidence: { digest: string } & Pick<ProjectCheckpointUpdate, "location" | "canonicalProject">): ProjectDurabilityReceipt | null {
    if (!this.isOperationCurrent(operationId) || !digestPattern.test(evidence?.digest)) return null;
    const active = this.active!, operation = active.operation!;
    const receipt = this.receipt(active, "source", evidence.digest);
    operation.update.sourceReceipt = receipt;
    if (evidence.location) operation.update.location = copy(evidence.location);
    if (evidence.canonicalProject) operation.update.canonicalProject = copy(evidence.canonicalProject);
    this.finish(active, "saved");
    return copy(receipt);
  }
  finishCheckpoint(operationId: string, source: "unavailable" | "failed", facts: { sourceFact?: string; recoveryFact?: string; sourceChange?: ProjectCheckpointUpdate["sourceChange"] } = {}): boolean {
    if (!this.isOperationCurrent(operationId)) return false;
    const active = this.active!;
    if (facts.recoveryFact !== undefined) active.operation!.update.recoveryFact = facts.recoveryFact;
    this.fence(active.operation);
    this.finish(active, source, facts.sourceFact, facts.sourceChange);
    return true;
  }
  private finish(active: Active, source: ProjectCheckpointUpdate["source"], sourceFact?: string, sourceChange?: ProjectCheckpointUpdate["sourceChange"]): void {
    const operation = active.operation!;
    operation.live = false; operation.terminal = true;
    operation.update.source = source; operation.update.sourceFact = sourceFact;
    if (source === "failed" && sourceChange) operation.update.sourceChange = copy(sourceChange);
    else delete operation.update.sourceChange;
    if (operation.update.recovery === "pending") operation.update.recovery = "failed";
    this.deadline(active, () => this.fallback(active, "no-response"));
    this.deps.onCheckpoint(copy(operation.update));
  }
  private approve(active: Active, basis: ProjectDeparturePermit["basis"], receipt?: ProjectDurabilityReceipt): void {
    this.clearDeadline(); this.fence(active.operation); this.dismissFallback(active);
    active.phase = "approved";
    active.permit = { permitId: this.id(), request: copy(active.request), basis, ...(receipt ? { receipt: copy(receipt) } : {}) };
    if (active.request.update?.continuation === "start-install") {
      if (!this.updateAttempt || this.updateAttempt.id !== active.request.update.attemptId || this.updateAttempt.started || this.updateAttempt.failed) { this.retire(); return; }
      this.updateAttempt.started = true;
    }
    this.deps.onContinue(copy(active.permit));
  }
  private fallback(active: Active, cause: ProjectDepartureFallback["cause"]): void {
    // Approval already dispatched its one native action. Late liveness events cannot
    // reopen that intent or replace its remaining same-window continuation chain.
    if (this.active !== active || active.phase === "approved") return;
    if (active.fallback) {
      if (cause !== "renderer-gone" || active.fallback.cause === cause) return;
      this.dismissFallback(active);
    }
    this.clearDeadline(); this.fence(active.operation);
    active.permit = undefined;
    active.phase = "native-fallback";
    active.fallback = { fallbackId: this.id(), request: copy(active.request), cause };
    this.deps.onFallback(copy(active.fallback));
  }
  decideFallback(fallbackId: string, decision: "wait" | "anyway" | "reopen" | "aborted"): boolean {
    const active = this.active;
    if (!active?.fallback || active.fallback.fallbackId !== fallbackId) return false;
    const current = this.deps.getContext();
    if (current && !sameContext(active.request.context, current)) { this.retire(); return false; }
    if (decision === "aborted") { this.retire(); return true; }
    if (decision === "anyway") { this.approve(active, "unacknowledged"); return true; }
    const request = copy(active.request), context = this.deps.getContext();
    if (decision === "reopen") { this.retire("retired"); this.deps.onReopen(request); return true; }
    if (decision !== "wait" || active.rendererGone || !context || !sameContext(context, request.context)) return false;
    this.retire(); this.start({ intentId: request.intentId, reason: request.reason, update: request.update }, context); return true;
  }
  notifyUnresponsive(windowEpoch: string): void {
    if (this.active?.request.context.windowEpoch === windowEpoch) this.fallback(this.active, "unresponsive");
  }
  rendererGone(windowEpoch: string): void {
    const active = this.active;
    if (active?.request.context.windowEpoch !== windowEpoch) return;
    active.rendererGone = true;
    this.fallback(active, "renderer-gone");
  }
  editingResumed(windowEpoch: string): void {
    if (this.active?.request.context.windowEpoch === windowEpoch) this.retire();
  }
  retireWindow(windowEpoch: string): void {
    const active = this.active;
    if (active?.request.context.windowEpoch !== windowEpoch) return;
    // An observed close already consumed under this permit is expected destruction;
    // preserve its quit/update chain through will-quit, even after context is cleared.
    if (active.nativeEvents.has("window-close") && this.applicablePermit() === active) return;
    this.retire("retired");
  }
  contextChanged(): void {
    const active = this.active, current = this.deps.getContext();
    if (!active || sameContext(active.request.context, current)) return;
    if (current === null && active.phase === "approved" && active.nativeEvents.has("window-close")) return;
    if (active.phase === "waiting-transition" && current?.windowEpoch === active.request.context.windowEpoch) return;
    this.retire();
  }
  private applicablePermit(): Active | null {
    const active = this.active, context = this.deps.getContext();
    if (!active?.permit || active.phase !== "approved") return null;
    if (context ? !sameContext(active.request.context, context) : !active.nativeEvents.has("window-close") && active.permit.basis !== "unacknowledged") return null;
    return active;
  }
  /** Call for native events caused by onContinue; each event belongs to this one window/intent chain. */
  consumeNativeEvent(permitId: string, event: ProjectDepartureNativeEvent, windowEpoch: string): boolean {
    const active = this.applicablePermit();
    if (!active || active.permit!.permitId !== permitId || active.request.context.windowEpoch !== windowEpoch || active.nativeEvents.has(event)) return false;
    const reason = active.request.reason;
    if (reason === "reload" || reason === "reload-ignoring-cache") {
      if (event !== "reload") return false;
    } else if (reason === "close") {
      if (event !== "window-close") return false;
    } else {
      if (event === "reload" || (event === "will-quit" && (!active.nativeEvents.has("before-quit") || !active.nativeEvents.has("window-close")))) return false;
      if (event === "window-close" && reason === "quit" && !active.nativeEvents.has("before-quit")) return false;
    }
    active.nativeEvents.add(event);
    return true;
  }
  /** A late handoff after edit ownership resumes gets a fresh drain, never another install call. */
  updateHandoff(attemptId: string): ProjectDepartureRequest | null {
    if (!this.updateAttempt || this.updateAttempt.id !== attemptId || !this.updateAttempt.started || this.updateAttempt.failed) return null;
    this.updateAttempt.handoff = true;
    const permit = this.applicablePermit();
    if (permit?.request.update?.attemptId === attemptId) return copy(permit.request);
    return this.request("update", { attemptId, continuation: "finish-handoff" });
  }
  isUpdateExitPermitted(attemptId: string): boolean {
    return Boolean(this.updateAttempt?.id === attemptId && this.updateAttempt.handoff && !this.updateAttempt.failed
      && this.applicablePermit()?.request.update?.attemptId === attemptId);
  }
  installationFailed(attemptId: string): void {
    if (this.updateAttempt?.id !== attemptId) return;
    this.updateAttempt.failed = true;
    if (this.active?.request.update?.attemptId === attemptId) this.retire();
  }
}
