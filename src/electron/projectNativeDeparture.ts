import { randomUUID } from "node:crypto";
import { ProjectDepartureCoordinator, type ProjectDepartureDependencies } from "./projectDeparture";
import type { ProjectDeparturePermit, ProjectDepartureReason, ProjectDurabilityContext } from "../shared/project/projectDurability";

interface Dependencies extends Omit<ProjectDepartureDependencies, "onContinue" | "onCancelled"> {
  onCancelled(requestId: string): void;
  close(windowEpoch: string): void;
  reload(windowEpoch: string, ignoreCache: boolean): void;
  quit(): void;
  install(attemptId: string): void;
  forceExit(): void;
  exitGraceMs?: number;
}
const sameContext = (a: ProjectDurabilityContext, b: ProjectDurabilityContext | null) => Boolean(b && a.windowEpoch === b.windowEpoch
  && a.documentSessionId === b.documentSessionId && a.targetGeneration === b.targetGeneration);

/** Concrete native dispatch accounting around the receipt coordinator. Never registers storage evidence. */
export class ProjectNativeDeparture {
  readonly coordinator: ProjectDepartureCoordinator;
  private unload: { permitId: string; windowEpoch: string } | null = null;
  private closing: { permitId: string; windowEpoch: string } | null = null;
  private cleanup: { permitId: string | null } | null = null;
  private attempt: { id: string; started: boolean; handoff: boolean; failed: boolean; editingReleased: boolean; releasedContext?: ProjectDurabilityContext; editableWindowEpoch?: string } | null = null;
  private exitTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly deps: Dependencies) {
    this.coordinator = new ProjectDepartureCoordinator({ ...deps,
      onContinue: permit => this.continue(permit),
      onCancelled: requestId => { this.unload = null; this.closing = null; this.cleanup = null; this.clearExitTimer(); deps.onCancelled(requestId); },
    });
  }
  private clearExitTimer(): void {
    if (this.exitTimer !== null) (this.deps.clearTimer ?? clearTimeout)(this.exitTimer);
    this.exitTimer = null;
  }
  private currentPermit(): ProjectDeparturePermit | undefined {
    const state = this.coordinator.snapshot();
    return state.phase === "approved" ? state.permit : undefined;
  }
  /** Native gestures coalesce while the existing renderer decision owns input. */
  request(reason: Exclude<ProjectDepartureReason, "update">): boolean {
    const state = this.coordinator.snapshot();
    if (state.request && !["idle", "retired"].includes(state.phase)) return true;
    return this.coordinator.request(reason) !== null;
  }
  requestInstall(): boolean {
    if (this.attempt && !this.attempt.failed && this.attempt.started) return false;
    const state = this.coordinator.snapshot();
    if (state.request && !["idle", "retired"].includes(state.phase)) return state.request.reason === "update";
    const attempt = { id: (this.deps.id ?? randomUUID)(), started: false, handoff: false, failed: false, editingReleased: false };
    this.attempt = attempt;
    return this.coordinator.request("update", { attemptId: attempt.id, continuation: "start-install" }) !== null;
  }
  get installAttemptId(): string | undefined { return this.attempt?.id; }
  private continue(permit: ProjectDeparturePermit): void {
    const { request } = permit;
    if (request.reason === "update") {
      const attempt = this.attempt;
      if (!attempt || attempt.id !== request.update?.attemptId || attempt.failed) return;
      if (request.update.continuation === "start-install") {
        if (attempt.started) return;
        attempt.started = true;
        this.deps.install(attempt.id);
      } else {
        this.armExitTimer();
        this.deps.quit();
      }
    } else if (request.reason === "quit") this.deps.quit();
    else if (request.reason === "close") this.deps.close(request.context.windowEpoch);
    else if (this.coordinator.consumeNativeEvent(permit.permitId, "reload", request.context.windowEpoch)) {
      this.unload = { permitId: permit.permitId, windowEpoch: request.context.windowEpoch };
      this.deps.reload(request.context.windowEpoch, request.reason === "reload-ignoring-cache");
    }
  }
  /** Called from the real BrowserWindow.close event, before Chromium asks beforeunload. */
  windowClose(windowEpoch: string): boolean {
    const permit = this.currentPermit();
    if (permit && this.coordinator.consumeNativeEvent(permit.permitId, "window-close", windowEpoch)) {
      this.unload = { permitId: permit.permitId, windowEpoch }; this.closing = this.unload; return true;
    }
    if (this.deps.getContext()?.windowEpoch === windowEpoch) this.request("close");
    return false;
  }
  /** Exactly one already-authorized dispatch may override the renderer's synchronous unload fence. */
  preventUnload(windowEpoch: string): boolean {
    const pending = this.unload, permit = this.currentPermit();
    if (!pending || !permit || pending.permitId !== permit.permitId || pending.windowEpoch !== windowEpoch
      || !sameContext(permit.request.context, this.deps.getContext())) return false;
    this.unload = null; return true;
  }
  private noDocumentMayQuit(): boolean {
    if (this.deps.getContext()) return false;
    const state = this.coordinator.snapshot();
    return !state.request || ["idle", "retired"].includes(state.phase) || (state.phase === "approved" && state.request.reason === "close");
  }
  private cleanupIsCurrent(): boolean {
    if (!this.cleanup) return false;
    if (this.cleanup.permitId === null) return this.noDocumentMayQuit();
    const permit = this.currentPermit();
    return permit?.permitId === this.cleanup.permitId && (!this.deps.getContext() || sameContext(permit.request.context, this.deps.getContext()));
  }
  beforeQuit(): boolean {
    if (this.cleanupIsCurrent() || this.noDocumentMayQuit()) return true;
    const permit = this.currentPermit();
    if (permit && this.coordinator.consumeNativeEvent(permit.permitId, "before-quit", permit.request.context.windowEpoch)) return true;
    this.request("quit"); return false;
  }
  /** Captures authority for the existing bounded service cleanup and its one app.quit reentry. */
  willQuit(): boolean {
    if (this.cleanupIsCurrent()) return true;
    if (this.noDocumentMayQuit()) { this.cleanup = { permitId: null }; return true; }
    const permit = this.currentPermit();
    if (!permit || !this.coordinator.consumeNativeEvent(permit.permitId, "will-quit", permit.request.context.windowEpoch)) return false;
    this.cleanup = { permitId: permit.permitId }; return true;
  }
  cleanupMayFinish(): boolean { return this.cleanupIsCurrent(); }
  isExpectedWindowClose(windowEpoch: string): boolean {
    return this.closing?.windowEpoch === windowEpoch && this.closing.permitId === this.currentPermit()?.permitId;
  }
  windowClosed(windowEpoch: string): void {
    this.unload = null; this.closing = null;
    this.coordinator.retireWindow(windowEpoch);
  }
  /** An actual unapproved window destruction is distinct from a late renderer-liveness observation. */
  windowVanished(windowEpoch: string): void {
    if (this.coordinator.snapshot().phase === "approved") this.coordinator.retireWindow(windowEpoch);
    this.rendererGone(windowEpoch);
  }
  rendererGone(windowEpoch: string): void {
    const permit = this.currentPermit(), attempt = this.attempt;
    // Starting an installer does not mean its native close was dispatched. A crashed
    // editor must still offer Reopen while that installer has not handed off. The
    // coordinator preserves any already-consumed close chain in retireWindow.
    if (permit?.request.context.windowEpoch === windowEpoch && sameContext(permit.request.context, this.deps.getContext())
      && permit.request.update?.continuation === "start-install" && permit.request.update.attemptId === attempt?.id
      && attempt.started && !attempt.handoff && !attempt.failed) this.coordinator.retireWindow(windowEpoch);
    if (!this.coordinator.snapshot().request) this.request("close");
    this.coordinator.rendererGone(windowEpoch);
    this.unload = null;
  }
  contextChanged(): void { this.coordinator.contextChanged(); }
  /** Main calls only after a new native document epoch replaces and retires the old window's authority. */
  documentEntered(context: ProjectDurabilityContext): void {
    this.coordinator.contextChanged();
    if (this.attempt && !this.attempt.handoff && !this.attempt.failed && ["idle", "retired"].includes(this.coordinator.snapshot().phase)) this.attempt.editableWindowEpoch = context.windowEpoch;
  }
  /** The caller also verifies the actual update panel is currently stalled. Retries never revoke twice. */
  editingResumed(sender: unknown, context: ProjectDurabilityContext, attemptId: string): boolean {
    const attempt = this.attempt, state = this.coordinator.snapshot(), permit = this.currentPermit();
    if (!context || !attempt || attempt.id !== attemptId || !attempt.started || attempt.failed || attempt.handoff
      || !sameContext(context, this.deps.getContext()) || !this.deps.isTrustedSender(sender, context)) return false;
    const idle = ["idle", "retired"].includes(state.phase);
    if (attempt.editingReleased && attempt.releasedContext && sameContext(attempt.releasedContext, context) && idle) return true;
    const approvedStart = permit?.request.update?.attemptId === attemptId && permit.request.update.continuation === "start-install";
    const alreadyEditableWindow = idle && attempt.editableWindowEpoch === context.windowEpoch;
    if (!approvedStart && !alreadyEditableWindow) return false;
    attempt.editingReleased = true; attempt.releasedContext = { ...context }; attempt.editableWindowEpoch = context.windowEpoch;
    this.coordinator.editingResumed(context.windowEpoch);
    return true;
  }
  updateHandoff(): boolean {
    const attempt = this.attempt;
    if (!attempt || !attempt.started || attempt.failed) return false;
    attempt.handoff = true;
    this.coordinator.updateHandoff(attempt.id);
    this.armExitTimer();
    return true;
  }
  private armExitTimer(): void {
    const attempt = this.attempt;
    if (!attempt || this.exitTimer !== null || !this.coordinator.isUpdateExitPermitted(attempt.id)) return;
    const attemptId = attempt.id;
    this.exitTimer = (this.deps.schedule ?? setTimeout)(() => {
      this.exitTimer = null;
      if (this.attempt?.id === attemptId && this.coordinator.isUpdateExitPermitted(attemptId)) this.deps.forceExit();
    }, this.deps.exitGraceMs ?? 15_000);
  }
  installationFailed(): void {
    if (!this.attempt) return;
    this.attempt.failed = true; this.clearExitTimer(); this.unload = null; this.cleanup = null;
    this.coordinator.installationFailed(this.attempt.id);
  }
}
