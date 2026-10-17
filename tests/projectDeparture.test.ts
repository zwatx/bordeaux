import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectDepartureCoordinator } from "../src/electron/projectDeparture";
import type { ProjectCheckpointUpdate, ProjectDepartureRequest, ProjectDepartureResponse, ProjectDurabilityContext, ProjectDurabilityReceipt } from "../src/shared/project/projectDurability";

const digest = "a".repeat(64), capturedAt = "2026-10-12T12:00:00.000Z";
function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(new Date(capturedAt));
  let context: ProjectDurabilityContext | null = { windowEpoch: "window-1", documentSessionId: "document-1", targetGeneration: 1 };
  let alive = true, transition: string | null = null, sequence = 0;
  const events: string[] = [];
  const callbacks = {
    onRequest: vi.fn(), onCheckpoint: vi.fn((_update: ProjectCheckpointUpdate) => { events.push("checkpoint"); }), onCancelled: vi.fn(),
    onFallback: vi.fn(), onDismissFallback: vi.fn(), onContinue: vi.fn(), onReopen: vi.fn(),
  };
  const coordinator = new ProjectDepartureCoordinator({ ...callbacks,
    getContext: () => context, isRendererAlive: () => alive, isTrustedSender: sender => sender === "main-frame",
    getTransitionId: () => transition, id: () => `id-${++sequence}`,
  });
  const fence = vi.fn(() => { events.push("fence"); });
  const request = (reason: "close" | "quit" | "reload" | "reload-ignoring-cache" = "quit") => coordinator.request(reason)!;
  const respond = (r: ProjectDepartureRequest, payload: Omit<ProjectDepartureResponse, "requestId" | "context"> | Record<string, unknown>, sender = "main-frame") =>
    coordinator.respond(sender, { requestId: r.requestId, context: r.context, ...payload } as ProjectDepartureResponse);
  const begin = (r: ProjectDepartureRequest, snapshotRevision = 7) => coordinator.beginCheckpoint(r.requestId, r.context, { snapshotRevision, digest, capturedAt, fence })!;
  const recovery = (operationId: string) => coordinator.recordRecovery(operationId, { recordId: "record-1", revision: 4, digest, capturedAt, stored: true })!;
  const source = (operationId: string) => coordinator.recordSource(operationId, { digest })!;
  const approve = (r: ProjectDepartureRequest, receipt: ProjectDurabilityReceipt, outcome: "saved" | "recovery" = "saved") => respond(r, {
    outcome, receiptId: receipt.receiptId, operationId: receipt.operationId, snapshotRevision: receipt.snapshotRevision,
  });
  return { coordinator, callbacks, events, fence, request, respond, begin, recovery, source, approve,
    context: () => context!, setContext: (next: ProjectDurabilityContext | null) => { context = next; },
    setAlive: (next: boolean) => { alive = next; }, setTransition: (next: string | null) => { transition = next; } };
}
afterEach(() => vi.useRealTimers());

describe("project departure admission and receipts", () => {
  it("coalesces repeated intent without another request, then consumes the same-window quit chain once", () => {
    const f = fixture(), r = f.request();
    expect(f.request().requestId).toBe(r.requestId); expect(f.callbacks.onRequest).toHaveBeenCalledTimes(1);
    const receipt = f.source(f.begin(r)); expect(f.callbacks.onContinue).not.toHaveBeenCalled();
    expect(f.approve(r, receipt)).toBe(true);
    const permit = f.coordinator.snapshot().permit!;
    expect(f.callbacks.onContinue).toHaveBeenCalledTimes(1);
    expect(f.coordinator.consumeNativeEvent(permit.permitId, "window-close", r.context.windowEpoch)).toBe(false);
    expect(f.coordinator.consumeNativeEvent(permit.permitId, "before-quit", "other-window")).toBe(false);
    expect(f.coordinator.consumeNativeEvent(permit.permitId, "before-quit", r.context.windowEpoch)).toBe(true);
    expect(f.coordinator.consumeNativeEvent(permit.permitId, "before-quit", r.context.windowEpoch)).toBe(false);
    expect(f.coordinator.consumeNativeEvent(permit.permitId, "window-close", r.context.windowEpoch)).toBe(true);
    f.setContext(null);
    expect(f.coordinator.consumeNativeEvent(permit.permitId, "will-quit", r.context.windowEpoch)).toBe(true);
    expect(f.coordinator.consumeNativeEvent(permit.permitId, "will-quit", r.context.windowEpoch)).toBe(false);
  });

  it.each(["cancelled", "invalid-input", "composing"] as const)("%s revokes pending write authority before cancellation and ignores late completion", outcome => {
    const f = fixture(), r = f.request(), operation = f.begin(r);
    expect(f.respond(r, { outcome })).toBe(true);
    expect(f.fence).toHaveBeenCalledTimes(1); expect(f.coordinator.isOperationCurrent(operation)).toBe(false);
    expect(f.source(operation)).toBeNull(); expect(f.coordinator.snapshot().phase).toBe("idle");
    vi.advanceTimersByTime(30_000); expect(f.callbacks.onFallback).not.toHaveBeenCalled(); expect(f.callbacks.onContinue).not.toHaveBeenCalled();
  });

  it("rejects forged, wrong-kind, wrong-operation, wrong-snapshot, stale context and non-main-frame responses", () => {
    const f = fixture(), r = f.request(), operation = f.begin(r), recovery = f.recovery(operation), receipt = f.source(operation);
    const valid = { outcome: "saved", receiptId: receipt.receiptId, operationId: operation, snapshotRevision: 7 };
    expect(f.respond(r, valid, "iframe")).toBe(false);
    for (const patch of [{ receiptId: "fake" }, { receiptId: recovery.receiptId }, { operationId: "old-operation" }, { snapshotRevision: 6 }]) {
      expect(f.respond(r, { ...valid, ...patch })).toBe(false);
    }
    expect(f.approve({ ...r, requestId: "old-request" }, receipt)).toBe(false);
    expect(f.approve({ ...r, context: { ...r.context, windowEpoch: "old-window" } }, receipt)).toBe(false);
    expect(f.approve({ ...r, context: { ...r.context, targetGeneration: 2 } }, receipt)).toBe(false);
    f.setAlive(false); expect(f.approve(r, receipt)).toBe(false); f.setAlive(true);
    expect(f.approve(r, receipt)).toBe(true); expect(f.approve(r, receipt)).toBe(false);
  });

  it("publishes recovery early but never treats a queued successor as proof, and keeps human choice untimed", () => {
    const f = fixture(), r = f.request(), operation = f.begin(r);
    expect(f.coordinator.recordRecovery(operation, { recordId: "r", revision: 8, digest, capturedAt, stored: false })).toBeNull();
    expect(f.respond(r, { outcome: "choosing" })).toBe(false);
    const receipt = f.recovery(operation);
    expect(f.callbacks.onCheckpoint.mock.calls.at(-1)?.[0]).toMatchObject({ recovery: "saved", source: "pending", recoveryReceipt: receipt });
    expect(f.approve(r, receipt, "recovery")).toBe(false);
    f.coordinator.finishCheckpoint(operation, "failed", { sourceFact: "Folder is read-only" });
    expect(f.respond(r, { outcome: "choosing" })).toBe(true);
    vi.advanceTimersByTime(90_000); expect(f.callbacks.onFallback).not.toHaveBeenCalled();
    expect(f.respond(r, { outcome: "discard", confirmed: true })).toBe(false);
    expect(f.approve(r, receipt, "recovery")).toBe(true);
  });

  it("bounds admission and drain progress; fences before publishing timeout and allows a live failure choice", () => {
    const f = fixture(), r = f.request(); vi.advanceTimersByTime(9_000);
    expect(f.respond(r, { outcome: "draining" })).toBe(true);
    vi.advanceTimersByTime(1_000); expect(f.callbacks.onFallback).toHaveBeenCalledTimes(1);
    const fallbackId = f.callbacks.onFallback.mock.calls[0][0].fallbackId;
    expect(f.coordinator.decideFallback(fallbackId, "wait")).toBe(true);
    const fresh = f.coordinator.snapshot().request!, operation = f.begin(fresh), receipt = f.recovery(operation);
    f.events.length = 0; vi.advanceTimersByTime(10_000);
    expect(f.events).toEqual(["fence", "checkpoint"]);
    expect(f.coordinator.snapshot().checkpoint?.source).toBe("timed-out");
    expect(f.source(operation)).toBeNull(); expect(f.callbacks.onFallback).toHaveBeenCalledTimes(1);
    expect(f.respond(fresh, { outcome: "choosing" })).toBe(true);
    vi.advanceTimersByTime(90_000); expect(f.callbacks.onFallback).toHaveBeenCalledTimes(1);
    expect(f.approve(fresh, receipt, "recovery")).toBe(true);
  });

  it("gives a silent renderer a second response bound after a logical timeout", () => {
    const f = fixture(), r = f.request(); f.begin(r);
    vi.advanceTimersByTime(10_000); expect(f.callbacks.onFallback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000); expect(f.callbacks.onFallback).toHaveBeenCalledTimes(1);
    expect(f.callbacks.onContinue).not.toHaveBeenCalled();
  });

  it("allows a failed/timed-out recovery phase to stop authorizing recovery without blocking healthy source", () => {
    const f = fixture(), r = f.request(), operation = f.begin(r);
    expect(f.coordinator.recordRecoveryFailure(operation, "Recovery storage is unavailable")).toBe(true);
    expect(f.recovery(operation)).toBeNull();
    const receipt = f.source(operation); expect(f.approve(r, receipt)).toBe(true);
  });

  it.each(["failed", "unavailable"] as const)("preserves the recovery failure fact when source is %s", source => {
    const f = fixture(), r = f.request(), operation = f.begin(r);
    f.coordinator.recordRecoveryFailure(operation, "Disk is full");
    expect(f.coordinator.finishCheckpoint(operation, source, { sourceFact: "Folder is read-only" })).toBe(true);
    expect(f.callbacks.onCheckpoint.mock.calls.at(-1)?.[0]).toMatchObject({
      recovery: "failed", recoveryFact: "Disk is full", source, sourceFact: "Folder is read-only",
    });
  });

  it("allows an explicitly supplied terminal recovery fact to replace the earlier fact", () => {
    const f = fixture(), r = f.request(), operation = f.begin(r);
    f.coordinator.recordRecoveryFailure(operation, "Disk is full");
    f.coordinator.finishCheckpoint(operation, "failed", { recoveryFact: "Recovery folder was removed" });
    expect(f.coordinator.snapshot().checkpoint?.recoveryFact).toBe("Recovery folder was removed");
  });

  it("requires choosing and explicit confirmation to authorize a live discard", () => {
    const f = fixture(), r = f.request(), operation = f.begin(r);
    f.coordinator.finishCheckpoint(operation, "unavailable", { recoveryFact: "Disk is full" });
    expect(f.respond(r, { outcome: "discard", confirmed: true })).toBe(false);
    f.respond(r, { outcome: "choosing" });
    expect(f.respond(r, { outcome: "discard", confirmed: false })).toBe(false);
    expect(f.respond(r, { outcome: "discard", confirmed: true })).toBe(true);
    expect(f.coordinator.snapshot().permit?.basis).toBe("discard");
  });

  it("a new Save-copy checkpoint makes the prior receipt unusable", () => {
    const f = fixture(), r = f.request(), first = f.begin(r), oldReceipt = f.recovery(first);
    f.coordinator.finishCheckpoint(first, "failed"); f.respond(r, { outcome: "choosing" });
    const second = f.begin(r, 8); f.coordinator.finishCheckpoint(second, "failed"); f.respond(r, { outcome: "choosing" });
    expect(f.approve(r, oldReceipt, "recovery")).toBe(false);
    expect(f.respond(r, { outcome: "cancelled" })).toBe(true);
  });

  it("a physically stalled old write cannot activate after timeout and a successful Save copy", async () => {
    const f = fixture(), r = f.request(), first = f.begin(r);
    let completeWrite!: () => void;
    const disk = new Promise<void>(resolve => { completeWrite = resolve; });
    const activate = vi.fn();
    const oldWrite = disk.then(() => {
      if (f.coordinator.isOperationCurrent(first)) activate();
      return f.source(first);
    });
    vi.advanceTimersByTime(10_000);
    expect(f.fence).toHaveBeenCalledTimes(1);
    f.respond(r, { outcome: "choosing" });
    const second = f.begin(r, 8), receipt = f.source(second);
    expect(f.approve(r, receipt)).toBe(true);
    completeWrite();
    expect(await oldWrite).toBeNull();
    expect(activate).not.toHaveBeenCalled();
    expect(f.coordinator.snapshot().permit?.receipt?.operationId).toBe(second);
    expect(f.callbacks.onContinue).toHaveBeenCalledTimes(1);
  });

  it("allows only an explicitly advanced same-document target generation", () => {
    const f = fixture(), r = f.request(), operation = f.begin(r);
    f.recovery(operation);
    const next = { ...r.context, targetGeneration: 2 }; f.setContext(next);
    expect(f.coordinator.advanceTarget(operation, { ...next, documentSessionId: "other" })).toBe(false);
    expect(f.coordinator.advanceTarget(operation, next)).toBe(true);
    const receipt = f.source(operation), updated = f.coordinator.snapshot().request!;
    expect(f.approve(r, receipt)).toBe(false); expect(f.approve(updated, receipt)).toBe(true);
    f.setContext({ ...next, documentSessionId: "replacement", targetGeneration: 3 }); f.coordinator.contextChanged();
    expect(f.coordinator.snapshot().phase).toBe("idle");
    expect(f.coordinator.consumeNativeEvent("old", "before-quit", next.windowEpoch)).toBe(false);
  });
});

describe("busy, native fallback and update departure", () => {
  it.each(["notifyUnresponsive", "rendererGone"] as const)("%s after exact approval never restarts a quit continuation", notify => {
    const f = fixture(), r = f.request(); f.approve(r, f.source(f.begin(r)));
    const permit = f.coordinator.snapshot().permit!;
    f.coordinator[notify](r.context.windowEpoch);
    const fallback = f.callbacks.onFallback.mock.calls.at(-1)?.[0];
    if (fallback) f.coordinator.decideFallback(fallback.fallbackId, "anyway");
    expect(f.callbacks.onContinue).toHaveBeenCalledTimes(1);
    expect(f.callbacks.onFallback).not.toHaveBeenCalled();
    expect(f.coordinator.snapshot().permit?.permitId).toBe(permit.permitId);
    expect(f.coordinator.consumeNativeEvent(permit.permitId, "before-quit", r.context.windowEpoch)).toBe(true);
    expect(f.coordinator.consumeNativeEvent(permit.permitId, "window-close", r.context.windowEpoch)).toBe(true);
    f.setContext(null);
    f.coordinator[notify](r.context.windowEpoch);
    f.coordinator.retireWindow(r.context.windowEpoch);
    f.coordinator.contextChanged();
    expect(f.coordinator.consumeNativeEvent(permit.permitId, "will-quit", r.context.windowEpoch)).toBe(true);
    expect(f.callbacks.onContinue).toHaveBeenCalledTimes(1);
    expect(f.callbacks.onFallback).not.toHaveBeenCalled();
  });

  it("late liveness observations preserve the single approved install across handoff and expected close", () => {
    const f = fixture(), r = f.coordinator.request("update", { attemptId: "u", continuation: "start-install" })!;
    f.approve(r, f.source(f.begin(r)));
    const permit = f.coordinator.snapshot().permit!;
    f.coordinator.notifyUnresponsive(r.context.windowEpoch);
    f.coordinator.rendererGone(r.context.windowEpoch);
    expect(f.coordinator.isUpdateExitPermitted("u")).toBe(false);
    expect(f.coordinator.updateHandoff("u")?.requestId).toBe(r.requestId);
    expect(f.coordinator.isUpdateExitPermitted("u")).toBe(true);
    expect(f.coordinator.consumeNativeEvent(permit.permitId, "window-close", r.context.windowEpoch)).toBe(true);
    f.setContext(null); f.coordinator.retireWindow(r.context.windowEpoch); f.coordinator.contextChanged();
    f.coordinator.rendererGone(r.context.windowEpoch);
    expect(f.coordinator.consumeNativeEvent(permit.permitId, "before-quit", r.context.windowEpoch)).toBe(true);
    expect(f.coordinator.consumeNativeEvent(permit.permitId, "will-quit", r.context.windowEpoch)).toBe(true);
    expect(f.coordinator.isUpdateExitPermitted("u")).toBe(true);
    expect(f.callbacks.onContinue).toHaveBeenCalledTimes(1);
    expect(f.callbacks.onFallback).not.toHaveBeenCalled();
    f.coordinator.installationFailed("u");
    expect(f.coordinator.isUpdateExitPermitted("u")).toBe(false);
  });

  it("a replacement context still revokes an approved consumed close chain", () => {
    const f = fixture(), r = f.request(); f.approve(r, f.source(f.begin(r)));
    const permit = f.coordinator.snapshot().permit!;
    f.coordinator.consumeNativeEvent(permit.permitId, "before-quit", r.context.windowEpoch);
    f.coordinator.consumeNativeEvent(permit.permitId, "window-close", r.context.windowEpoch);
    f.setContext({ ...r.context, windowEpoch: "replacement" }); f.coordinator.contextChanged();
    expect(f.coordinator.consumeNativeEvent(permit.permitId, "will-quit", r.context.windowEpoch)).toBe(false);
    expect(f.coordinator.snapshot().phase).toBe("idle");
  });

  it("resumes a real completed switch with a fresh request for its new document", () => {
    const f = fixture(), r = f.request(); f.setTransition("switch-1");
    expect(f.respond(r, { outcome: "busy", transitionId: "fake" })).toBe(false);
    expect(f.respond(r, { outcome: "busy", transitionId: "switch-1" })).toBe(true);
    const token = { intentId: r.intentId, blockedRequestId: r.requestId, transitionId: "switch-1", windowEpoch: r.context.windowEpoch };
    expect(f.coordinator.resume("main-frame", token)).toBe(false);
    f.setContext({ ...r.context, documentSessionId: "document-2", targetGeneration: 2 }); f.coordinator.contextChanged(); f.setTransition(null);
    expect(f.coordinator.resume("iframe", token)).toBe(false);
    expect(f.coordinator.resume("main-frame", { ...token, blockedRequestId: "stale" })).toBe(false);
    expect(f.coordinator.resume("main-frame", token)).toBe(true);
    const fresh = f.coordinator.snapshot().request!;
    expect(fresh.requestId).not.toBe(r.requestId); expect(fresh.intentId).toBe(r.intentId); expect(fresh.context.documentSessionId).toBe("document-2");
    expect(f.coordinator.resume("main-frame", token)).toBe(false);
  });

  it("bounds a hung switch without treating it as saved", () => {
    const f = fixture(), r = f.request(); f.setTransition("switch"); f.respond(r, { outcome: "busy", transitionId: "switch" });
    vi.advanceTimersByTime(10_000);
    expect(f.callbacks.onFallback.mock.calls[0][0].cause).toBe("busy-timeout"); expect(f.callbacks.onContinue).not.toHaveBeenCalled();
  });

  it("late matched source response wins once over an open native box; its abort is not discard", () => {
    const f = fixture(), r = f.request(), receipt = f.source(f.begin(r)); vi.advanceTimersByTime(10_000);
    const fallback = f.callbacks.onFallback.mock.calls[0][0];
    expect(f.approve(r, receipt)).toBe(true); expect(f.callbacks.onDismissFallback).toHaveBeenCalledWith(fallback.fallbackId);
    expect(f.coordinator.decideFallback(fallback.fallbackId, "aborted")).toBe(false);
    expect(f.coordinator.decideFallback(fallback.fallbackId, "anyway")).toBe(false);
    expect(f.callbacks.onContinue).toHaveBeenCalledTimes(1); expect(f.coordinator.snapshot().permit?.basis).toBe("source");
  });

  it("vanished renderer cannot approve; explicit fallback is unacknowledged and Reopen retires the old epoch", () => {
    const f = fixture(), r = f.request(), receipt = f.source(f.begin(r)); f.coordinator.rendererGone(r.context.windowEpoch);
    expect(f.approve(r, receipt)).toBe(false);
    const fallback = f.callbacks.onFallback.mock.calls[0][0];
    expect(f.coordinator.decideFallback(fallback.fallbackId, "reopen")).toBe(true);
    expect(f.callbacks.onReopen).toHaveBeenCalledWith(r); expect(f.coordinator.snapshot().phase).toBe("retired");
    expect(f.coordinator.decideFallback(fallback.fallbackId, "anyway")).toBe(false);
    f.setContext({ ...r.context, windowEpoch: "window-2" });
    const fresh = f.request(); f.coordinator.notifyUnresponsive(fresh.context.windowEpoch);
    const second = f.callbacks.onFallback.mock.calls.at(-1)![0];
    expect(f.coordinator.decideFallback(second.fallbackId, "anyway")).toBe(true);
    expect(f.coordinator.snapshot().permit?.basis).toBe("unacknowledged");
  });

  it("rejects stale native fallback answers even before the new-window notification is delivered", () => {
    const f = fixture(), r = f.request(); f.coordinator.notifyUnresponsive(r.context.windowEpoch);
    const fallback = f.callbacks.onFallback.mock.calls[0][0]; f.setContext({ ...r.context, windowEpoch: "new-window" });
    expect(f.coordinator.decideFallback(fallback.fallbackId, "anyway")).toBe(false); expect(f.callbacks.onContinue).not.toHaveBeenCalled();
  });

  it("replaces an unresponsive fallback after a crash and rejects the old native dialog answer", () => {
    const f = fixture(), r = f.request(); f.coordinator.notifyUnresponsive(r.context.windowEpoch);
    const first = f.callbacks.onFallback.mock.calls[0][0];
    f.coordinator.rendererGone(r.context.windowEpoch);
    const second = f.callbacks.onFallback.mock.calls[1][0];
    expect(second.cause).toBe("renderer-gone");
    expect(second.fallbackId).not.toBe(first.fallbackId);
    expect(f.callbacks.onDismissFallback).toHaveBeenCalledWith(first.fallbackId);
    expect(f.coordinator.decideFallback(first.fallbackId, "anyway")).toBe(false);
    expect(f.coordinator.decideFallback(second.fallbackId, "wait")).toBe(false);
    expect(f.coordinator.decideFallback(second.fallbackId, "reopen")).toBe(true);
  });

  it("new intent, resumed editing and retired window revoke existing permits and pending operations", () => {
    const f = fixture(), r = f.request("close"), receipt = f.source(f.begin(r)); f.approve(r, receipt);
    const permit = f.coordinator.snapshot().permit!;
    const fresh = f.request("reload-ignoring-cache");
    expect(f.coordinator.consumeNativeEvent(permit.permitId, "window-close", r.context.windowEpoch)).toBe(false);
    const secondReceipt = f.source(f.begin(fresh)); f.approve(fresh, secondReceipt);
    const secondPermit = f.coordinator.snapshot().permit!;
    expect(f.coordinator.consumeNativeEvent(secondPermit.permitId, "before-quit", r.context.windowEpoch)).toBe(false);
    expect(f.coordinator.consumeNativeEvent(secondPermit.permitId, "reload", r.context.windowEpoch)).toBe(true);
    f.coordinator.editingResumed(r.context.windowEpoch); expect(f.coordinator.snapshot().phase).toBe("idle");
    const third = f.request(), operation = f.begin(third); f.coordinator.retireWindow(third.context.windowEpoch);
    expect(f.coordinator.isOperationCurrent(operation)).toBe(false); expect(f.source(operation)).toBeNull();
  });

  it("installs once, revokes approval on stall/editing, and drains a late handoff without installing again", () => {
    const f = fixture();
    const first = f.coordinator.request("update", { attemptId: "update-1", continuation: "start-install" })!;
    f.approve(first, f.source(f.begin(first)));
    expect(f.coordinator.isUpdateExitPermitted("update-1")).toBe(false);
    expect(f.callbacks.onContinue).toHaveBeenCalledTimes(1);
    expect(f.coordinator.request("update", { attemptId: "update-1", continuation: "start-install" })!.requestId).toBe(first.requestId);
    f.coordinator.editingResumed(first.context.windowEpoch);
    expect(f.coordinator.request("update", { attemptId: "update-1", continuation: "start-install" })).toBeNull();
    const late = f.coordinator.updateHandoff("update-1")!;
    expect(late.requestId).not.toBe(first.requestId); expect(late.update?.continuation).toBe("finish-handoff");
    expect(f.coordinator.isUpdateExitPermitted("update-1")).toBe(false);
    f.approve(late, f.source(f.begin(late, 8)));
    expect(f.coordinator.isUpdateExitPermitted("update-1")).toBe(true);
    expect(f.callbacks.onContinue.mock.calls.map(([permit]) => permit.request.update?.continuation)).toEqual(["start-install", "finish-handoff"]);
    const permit = f.coordinator.snapshot().permit!;
    expect(f.coordinator.consumeNativeEvent(permit.permitId, "window-close", late.context.windowEpoch)).toBe(true);
    expect(f.coordinator.consumeNativeEvent(permit.permitId, "before-quit", late.context.windowEpoch)).toBe(true);
    expect(f.coordinator.consumeNativeEvent(permit.permitId, "will-quit", late.context.windowEpoch)).toBe(true);
    f.coordinator.installationFailed("update-1");
    expect(f.coordinator.isUpdateExitPermitted("update-1")).toBe(false); expect(f.coordinator.updateHandoff("update-1")).toBeNull();
  });

  it("an unchanged approved update handoff keeps its receipt, while failed attempts cannot issue a late handoff", () => {
    const f = fixture(), r = f.coordinator.request("update", { attemptId: "u", continuation: "start-install" })!;
    f.approve(r, f.source(f.begin(r)));
    expect(f.coordinator.updateHandoff("u")?.requestId).toBe(r.requestId);
    expect(f.coordinator.isUpdateExitPermitted("u")).toBe(true); expect(f.callbacks.onContinue).toHaveBeenCalledTimes(1);
    f.coordinator.installationFailed("u"); expect(f.coordinator.updateHandoff("u")).toBeNull();
    expect(f.coordinator.request("update", { attemptId: "retry", continuation: "start-install" })).not.toBeNull();
  });

  it("does not expose mutable internal receipt/context state through callbacks or snapshots", () => {
    const f = fixture(), r = f.request(), operation = f.begin(r), receipt = f.source(operation);
    receipt.digest = "b".repeat(64); r.context.documentSessionId = "mutated";
    const snapshot = f.coordinator.snapshot(); snapshot.request!.context.windowEpoch = "mutated";
    expect(f.coordinator.snapshot().request!.context).toEqual(f.context());
    expect(f.coordinator.snapshot().checkpoint!.sourceReceipt!.digest).toBe(digest);
  });
});

 it("copies terminal typed facts, never puts them on unavailable, timeout or a later generic failure", () => {
  const f = fixture(), r = f.request(), typed = { scope: "document" as const, file: "Paths/A.path" };
  const first = f.begin(r);
  expect(f.coordinator.finishCheckpoint(first, "failed", { sourceFact: "changed", sourceChange: typed })).toBe(true);
  typed.file = "Paths/Mutated.path";
  expect(f.coordinator.snapshot().checkpoint?.sourceChange).toEqual({ scope: "document", file: "Paths/A.path" });
  f.respond(r, { outcome: "choosing" });
  const unavailable = f.begin(r, 8);
  f.coordinator.finishCheckpoint(unavailable, "unavailable", { sourceChange: typed });
  expect(f.coordinator.snapshot().checkpoint?.sourceChange).toBeUndefined();
  f.respond(r, { outcome: "choosing" });
  const generic = f.begin(r, 9); f.coordinator.finishCheckpoint(generic, "failed", { sourceFact: "read-only" });
  expect(f.coordinator.snapshot().checkpoint?.sourceChange).toBeUndefined();
  f.respond(r, { outcome: "choosing" }); f.begin(r, 10); vi.advanceTimersByTime(10_000);
  expect(f.coordinator.snapshot().checkpoint?.source).toBe("timed-out");
  expect(f.coordinator.snapshot().checkpoint?.sourceChange).toBeUndefined();
  f.coordinator.editingResumed(f.context().windowEpoch);
});
