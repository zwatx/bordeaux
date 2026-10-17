import { loadProjectSelection } from "../src/electron/projectOpening";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectNativeDeparture } from "../src/electron/projectNativeDeparture";
import { ProjectPersistence } from "../src/electron/projectPersistence";
import { ProjectSourcePersistence } from "../src/electron/projectSourcePersistence";
import { ProjectRecoveryStore } from "../src/electron/projectRecoveryStore";
import { createDemoProject } from "../src/shared/project/defaults";
import { openProjectFolder } from "../src/electron/projectFiles";
import { UpdateQuitCoordinator } from "../src/electron/appUpdates";
import type { ProjectDepartureRequest, ProjectDurabilityContext } from "../src/shared/project/projectDurability";
const roots: string[] = [];
const adapters: ProjectNativeDeparture[] = [];
afterEach(async () => {
  for (const adapter of adapters.splice(0)) { adapter.installationFailed(); const epoch = adapter.coordinator.snapshot().request?.context.windowEpoch; if (epoch) adapter.coordinator.editingResumed(epoch); }
  vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-native-adapter-"))); roots.push(root);
  const folder = path.join(root, "Autos"); await fs.mkdir(folder);
  let context: ProjectDurabilityContext | null = { windowEpoch: randomUUID(), documentSessionId: randomUUID(), targetGeneration: 1 };
  let location = { folderPath: folder, projectPath: null as string | null }, transition: string | null = null, alive = true;
  const sender = {}, requests: ProjectDepartureRequest[] = [], actions: string[] = [], fallbacks: string[] = [], dismissed: string[] = [];
  let persistence!: ProjectPersistence, adapter!: ProjectNativeDeparture;
  let closeAction = (_epoch: string) => { actions.push("close"); };
  let showFallback = (fallback: any) => { fallbacks.push(fallback.fallbackId); }, dismissFallback = (id: string) => { dismissed.push(id); };
  const source = new ProjectSourcePersistence({ getContext: () => context!, commit: (_capture, _project, target) => { location = { folderPath: folder, projectPath: target }; return { context: context!, location }; } });
  adapter = new ProjectNativeDeparture({ getContext: () => context, isRendererAlive: epoch => alive && context?.windowEpoch === epoch,
    isTrustedSender: (value, claimed) => value === sender && JSON.stringify(claimed) === JSON.stringify(context), getTransitionId: () => transition,
    onRequest: request => requests.push(request), onCheckpoint: update => persistence.handleDepartureUpdate(update),
    onCancelled: requestId => persistence.handleDepartureCancelled(requestId), onFallback: fallback => showFallback(fallback), onDismissFallback: id => dismissFallback(id),
    onReopen: () => actions.push("reopen"), close: epoch => closeAction(epoch), reload: (_epoch, ignoreCache) => actions.push(ignoreCache ? "force-reload" : "reload"),
    quit: () => actions.push("quit"), install: id => actions.push(`install:${id}`), forceExit: () => actions.push("exit"), timeoutMs: 10_000, exitGraceMs: 150,
  });
  adapters.push(adapter);
  persistence = new ProjectPersistence({ source, recovery: new ProjectRecoveryStore(path.join(root, "recovery")), getContext: () => context!, getLocation: () => location, onUpdate: () => undefined });
  persistence.admitSource(context!, (await loadProjectSelection(folder)).sourceEvidence);
  persistence.attachDepartureCoordinator(adapter.coordinator);
  const project = createDemoProject(); project.paths[0].name = "Exact authored source";
  const approve = async () => {
    const request = requests.at(-1)!;
    const checkpoint = await persistence.checkpoint({ requestId: request.requestId, context: request.context, snapshotRevision: 7, project });
    expect(checkpoint.source).toBe("saved");
    const receipt = checkpoint.sourceReceipt!;
    const response = { requestId: request.requestId, context: checkpoint.context, outcome: "saved" as const, receiptId: "receiptId" in receipt ? receipt.receiptId : "", operationId: receipt.operationId, snapshotRevision: receipt.snapshotRevision };
    return { response, accept: () => adapter.coordinator.respond(sender, response) };
  };
  return { adapter, persistence, source, sender, requests, actions, fallbacks, dismissed, project, folder, approve,
    get context() { return context!; }, bindFallback(show: typeof showFallback, dismiss: typeof dismissFallback) { showFallback = show; dismissFallback = dismiss; }, async replace() { context = { ...context!, documentSessionId: randomUUID() }; persistence.contextChanged(true); persistence.admitSource(context, (await loadProjectSelection(folder)).sourceEvidence); },
    disappear() { alive = false; adapter.rendererGone(context!.windowEpoch); }, closed() { const epoch = context!.windowEpoch; context = null; adapter.windowClosed(epoch); },
    async reopen() { context = { windowEpoch: randomUUID(), documentSessionId: randomUUID(), targetGeneration: 2 }; alive = true; adapter.documentEntered(context); persistence.contextChanged(true); persistence.admitSource(context, (await loadProjectSelection(folder)).sourceEvidence); },
    vanish() { const epoch = context!.windowEpoch; adapter.windowVanished(epoch); context = null; },
    transition(value: string | null) { transition = value; }, setNativeClose() { closeAction = (epoch: string) => { actions.push("close"); expect(adapter.windowClose(epoch)).toBe(true); expect(adapter.preventUnload(epoch)).toBe(true); }; },
  };
}

describe("native departure dispatch using real source and recovery receipts", () => {
  it("coalesces close, then overrides exactly one unload even before response IPC can resolve", async () => {
    const f = await fixture(); f.setNativeClose(); expect(f.adapter.windowClose(f.context.windowEpoch)).toBe(false);
    expect(f.adapter.windowClose(f.context.windowEpoch)).toBe(false); expect(f.requests).toHaveLength(1);
    const proof = await f.approve(); expect(f.actions).toEqual([]); expect(proof.accept()).toBe(true); expect(f.actions).toEqual(["close"]);
    expect(f.adapter.preventUnload(f.context.windowEpoch)).toBe(false); expect(f.adapter.windowClose(f.context.windowEpoch)).toBe(false);
    expect((await openProjectFolder(f.folder)).project?.paths[0].name).toBe("Exact authored source");
    f.closed(); expect(f.adapter.coordinator.snapshot().phase).toBe("approved");
  });
  it.each(["reload", "reload-ignoring-cache"] as const)("requires a receipt for %s and never overrides an unmanaged unload", async reason => {
    const f = await fixture(); expect(f.adapter.preventUnload(f.context.windowEpoch)).toBe(false);
    f.adapter.request(reason); const proof = await f.approve(); expect(proof.accept()).toBe(true);
    expect(f.actions).toEqual([reason === "reload" ? "reload" : "force-reload"]);
    expect(f.adapter.preventUnload("stale-epoch")).toBe(false); expect(f.adapter.preventUnload(f.context.windowEpoch)).toBe(true); expect(f.adapter.preventUnload(f.context.windowEpoch)).toBe(false);
    await f.replace(); expect(f.adapter.coordinator.snapshot().permit).toBeUndefined();
  });
  it("preserves an approved quit through before-quit, window-close, null context, will-quit and cleanup reentry", async () => {
    const f = await fixture(); expect(f.adapter.beforeQuit()).toBe(false); expect(f.adapter.beforeQuit()).toBe(false); expect(f.requests).toHaveLength(1);
    expect((await f.approve()).accept()).toBe(true); expect(f.actions).toEqual(["quit"]);
    expect(f.adapter.beforeQuit()).toBe(true); expect(f.adapter.windowClose(f.context.windowEpoch)).toBe(true); f.closed();
    expect(f.adapter.willQuit()).toBe(true); expect(f.adapter.cleanupMayFinish()).toBe(true);
    expect(f.adapter.beforeQuit()).toBe(true); expect(f.adapter.willQuit()).toBe(true); expect(f.actions).toEqual(["quit"]);
    await f.reopen(); expect(f.adapter.cleanupMayFinish()).toBe(false);
  });
  it("does not let invalid input, cancellation, wrong sender or a replacement context destroy the window", async () => {
    const f = await fixture(); f.adapter.request("close"); const proof = await f.approve();
    expect(f.adapter.coordinator.respond({}, proof.response)).toBe(false); await f.replace(); expect(proof.accept()).toBe(false);
    f.adapter.request("close"); const request = f.requests.at(-1)!;
    expect(f.adapter.coordinator.respond(f.sender, { ...request, outcome: "invalid-input" })).toBe(true); expect(f.actions).toEqual([]); expect(f.adapter.preventUnload(f.context.windowEpoch)).toBe(false);
  });
  it("busy transition resumes with the current document's fresh request, never the blocked receipt", async () => {
    const f = await fixture(); f.transition("switch"); f.adapter.request("close"); const blocked = f.requests.at(-1)!;
    expect(f.adapter.coordinator.respond(f.sender, { ...blocked, outcome: "busy", transitionId: "switch" })).toBe(true);
    await f.replace(); f.transition(null);
    expect(f.adapter.coordinator.resume(f.sender, { intentId: blocked.intentId, blockedRequestId: blocked.requestId, transitionId: "switch", windowEpoch: blocked.context.windowEpoch })).toBe(true);
    expect(f.requests.at(-1)?.context.documentSessionId).toBe(f.context.documentSessionId); expect(f.requests.at(-1)?.requestId).not.toBe(blocked.requestId);
    expect((await f.approve()).accept()).toBe(true); expect(f.actions).toEqual(["close"]);
  });
  it("vanished renderer refuses a late saved response and exactly one fallback winner can continue", async () => {
    const f = await fixture(); f.adapter.request("close"); const proof = await f.approve(); f.disappear();
    expect(proof.accept()).toBe(false); const fallback = f.fallbacks.at(-1)!;
    expect(f.adapter.coordinator.decideFallback(fallback, "reopen")).toBe(true); expect(f.adapter.coordinator.decideFallback(fallback, "anyway")).toBe(false);
    expect(f.actions).toEqual(["reopen"]); expect(f.dismissed).toEqual([fallback]);
  });
  it("Wait replaces the request and a matching late live reply dismisses the native fallback once", async () => {
    const f = await fixture(); f.adapter.request("close"); f.adapter.coordinator.notifyUnresponsive(f.context.windowEpoch);
    const first = f.fallbacks.at(-1)!; expect(f.adapter.coordinator.decideFallback(first, "wait")).toBe(true); expect(f.requests).toHaveLength(2);
    const proof = await f.approve(); f.adapter.coordinator.notifyUnresponsive(f.context.windowEpoch); const second = f.fallbacks.at(-1)!;
    expect(proof.accept()).toBe(true); expect(f.adapter.coordinator.decideFallback(second, "anyway")).toBe(false); expect(f.actions).toEqual(["close"]);
    expect(f.dismissed).toEqual([first, second]);
  });
});

describe("native update attempt authority", () => {
  it("offers Reopen after a surviving renderer crashes before stalled install consumed a native close", async () => {
    const f = await fixture(); vi.useFakeTimers(); f.adapter.requestInstall(); const proof = await f.approve();
    expect(proof.accept()).toBe(true); const attempt = f.adapter.installAttemptId!, oldContext = f.context;
    f.disappear(); f.adapter.rendererGone(oldContext.windowEpoch);
    expect(f.adapter.coordinator.snapshot().phase).toBe("native-fallback"); expect(f.fallbacks).toHaveLength(1);
    expect(proof.accept()).toBe(false); expect(f.adapter.requestInstall()).toBe(false);
    expect(f.adapter.coordinator.decideFallback(f.fallbacks[0], "reopen")).toBe(true); await f.reopen();
    expect(f.adapter.editingResumed(f.sender, oldContext, attempt)).toBe(false);
    expect(f.adapter.editingResumed(f.sender, f.context, attempt)).toBe(true);
    f.project.paths[0].name = "Authored after crash Reopen"; expect(f.adapter.updateHandoff()).toBe(true);
    expect(f.requests.at(-1)?.update).toEqual({ attemptId: attempt, continuation: "finish-handoff" });
    await vi.advanceTimersByTimeAsync(151); expect(f.actions).toEqual([`install:${attempt}`, "reopen"]);
    expect((await f.approve()).accept()).toBe(true);
    expect((await openProjectFolder(f.folder)).project?.paths[0].name).toBe("Authored after crash Reopen");
    expect(f.actions).toEqual([`install:${attempt}`, "reopen", "quit"]);
  });
  it("preserves a consumed install close through late crash observations and the remaining quit chain", async () => {
    const f = await fixture(); f.adapter.requestInstall(); expect((await f.approve()).accept()).toBe(true);
    const attempt = f.adapter.installAttemptId!, epoch = f.context.windowEpoch;
    f.adapter.rendererGone("old-window"); expect(f.adapter.coordinator.snapshot().phase).toBe("approved");
    expect(f.adapter.beforeQuit()).toBe(true); expect(f.adapter.windowClose(epoch)).toBe(true);
    f.disappear(); expect(f.adapter.coordinator.snapshot().phase).toBe("approved"); expect(f.fallbacks).toHaveLength(0);
    f.closed(); f.adapter.rendererGone(epoch); expect(f.adapter.updateHandoff()).toBe(true);
    expect(f.adapter.willQuit()).toBe(true); expect(f.adapter.cleanupMayFinish()).toBe(true);
    expect(f.actions).toEqual([`install:${attempt}`]); expect(f.fallbacks).toHaveLength(0);
  });
  it("installs once after exact source, allows idempotent lost-response editing release, and freshly drains late handoff", async () => {
    const f = await fixture(); vi.useFakeTimers(); expect(f.adapter.requestInstall()).toBe(true); expect(f.adapter.requestInstall()).toBe(true); expect(f.actions).toEqual([]);
    expect((await f.approve()).accept()).toBe(true); const attempt = f.adapter.installAttemptId!; expect(f.actions).toEqual([`install:${attempt}`]); expect(f.adapter.requestInstall()).toBe(false);
    expect(f.adapter.editingResumed({}, f.context, attempt)).toBe(false); expect(f.adapter.editingResumed(f.sender, f.context, "old")).toBe(false);
    expect(f.adapter.editingResumed(f.sender, f.context, attempt)).toBe(true); expect(f.adapter.editingResumed(f.sender, f.context, attempt)).toBe(true);
    const releasedContext = f.context; await f.replace();
    expect(f.adapter.editingResumed(f.sender, releasedContext, attempt)).toBe(false);
    expect(f.adapter.editingResumed(f.sender, f.context, attempt)).toBe(true); // A later panel in this already released native window remains closable.
    f.project.paths[0].name = "Edited after stalled installer"; expect(f.adapter.updateHandoff()).toBe(true);
    expect(f.requests.at(-1)?.update).toEqual({ attemptId: attempt, continuation: "finish-handoff" });
    expect(f.adapter.editingResumed(f.sender, f.context, attempt)).toBe(false);
    await vi.advanceTimersByTimeAsync(151); expect(f.actions).not.toContain("exit");
    // A liveness observation can offer Wait; the force-exit timer has no authority during this fresh drain.
    f.adapter.coordinator.notifyUnresponsive(f.context.windowEpoch);
    expect(f.adapter.coordinator.decideFallback(f.fallbacks.at(-1)!, "wait")).toBe(true);
    expect((await f.approve()).accept()).toBe(true); expect(f.actions).toEqual([`install:${attempt}`, "quit"]);
    expect((await openProjectFolder(f.folder)).project?.paths[0].name).toBe("Edited after stalled installer");
    await vi.advanceTimersByTimeAsync(151); expect(f.actions).toEqual([`install:${attempt}`, "quit", "exit"]);
  });
  it("handoff wins against editing release; install failure revokes unload, cleanup and forced exit", async () => {
    const f = await fixture(); vi.useFakeTimers(); f.adapter.requestInstall(); expect((await f.approve()).accept()).toBe(true); const attempt = f.adapter.installAttemptId!;
    f.adapter.updateHandoff(); expect(f.adapter.editingResumed(f.sender, f.context, attempt)).toBe(false);
    expect(f.adapter.beforeQuit()).toBe(true); expect(f.adapter.windowClose(f.context.windowEpoch)).toBe(true);
    f.adapter.installationFailed(); expect(f.adapter.preventUnload(f.context.windowEpoch)).toBe(false); expect(f.adapter.cleanupMayFinish()).toBe(false);
    await vi.advanceTimersByTimeAsync(151); expect(f.actions).not.toContain("exit");
    expect(f.adapter.requestInstall()).toBe(true); const newer = f.adapter.installAttemptId!; expect(newer).not.toBe(attempt);
    expect((await f.approve()).accept()).toBe(true); expect(f.adapter.editingResumed(f.sender, f.context, attempt)).toBe(false); expect(f.adapter.editingResumed(f.sender, f.context, newer)).toBe(true);
  });
  it("unexpected window destruction retires an unconsumed approval instead of stranding a dead approved intent", async () => {
    const f = await fixture(); f.adapter.requestInstall(); expect((await f.approve()).accept()).toBe(true); const old = f.adapter.coordinator.snapshot().request!;
    f.vanish(); const state = f.adapter.coordinator.snapshot(); expect(state.phase).toBe("native-fallback"); expect(state.request?.requestId).not.toBe(old.requestId);
    expect(f.adapter.beforeQuit()).toBe(false); expect(f.adapter.coordinator.decideFallback(f.fallbacks.at(-1)!, "anyway")).toBe(true);
    expect(f.adapter.beforeQuit()).toBe(true); expect(f.actions.filter(action => action.startsWith("install:"))).toHaveLength(1);
  });
  it("a real replacement window can acknowledge a stalled panel after its old install permit was retired", async () => {
    const f = await fixture(); f.adapter.requestInstall(); expect((await f.approve()).accept()).toBe(true); const attempt = f.adapter.installAttemptId!, old = f.context;
    await f.reopen(); await f.replace(); // Startup adoption changes the document in this main-owned new window epoch.
    expect(f.adapter.editingResumed(f.sender, old, attempt)).toBe(false); expect(f.adapter.editingResumed(f.sender, f.context, attempt)).toBe(true);
    f.adapter.request("quit"); expect(f.adapter.editingResumed(f.sender, f.context, attempt)).toBe(false);
  });
  it("the legacy updater admission query never starts or consumes a quit", () => {
    const q = new UpdateQuitCoordinator(); q.installing(); expect(q.inspectBeforeQuit()).toBe("proceed"); expect(q.quitInProgress).toBe(false);
    q.installFailed(); expect(q.handoff()).toBe(false); expect(q.inspectBeforeQuit()).toBe("ignore"); expect(q.inspectBeforeQuit()).toBe("ignore"); expect(q.quitInProgress).toBe(false);
    expect(q.beforeQuit()).toBe("ignore"); expect(q.inspectBeforeQuit()).toBe("proceed"); expect(q.beforeQuit()).toBe("proceed"); expect(q.quitInProgress).toBe(true);
  });
});


/** These tests execute the actual main app callbacks; only native Event and service-stop boundaries are fixtures. */
describe("actual main quit callback integration", () => {
  async function installMainCallbacks(adapter: ProjectNativeDeparture, stop: () => Promise<void>) {
    const emitter = new EventEmitter(); let quitCalls = 0;
    const event = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
    const app = Object.assign(emitter, { quit: () => { quitCalls++; const before = event(); app.emit("before-quit", before); if (!before.prevented) app.emit("will-quit", event()); } });
    const sandbox = { app, updateQuit: new UpdateQuitCoordinator(), nativeDeparture: adapter, updateCheckTimer: null,
      backgroundServicesReadyForExit: false, finalQuitInProgress: false, QUIT_CLEANUP_LIMIT_MS: 8_000,
      stopBackgroundServices: stop, resumeAfterFailedUpdateQuit: vi.fn(), setTimeout, clearTimeout, setImmediate, console };
    const text = await fs.readFile(path.resolve("src/electron/main.ts"), "utf8"), ast = ts.createSourceFile("main.ts", text, ts.ScriptTarget.Latest, true);
    const callbacks = ast.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
      && node.expression.expression.getText(ast) === "app.on" && ["before-quit", "will-quit"].includes((node.expression.arguments[0] as ts.StringLiteral).text));
    expect(callbacks).toHaveLength(2);
    vm.runInNewContext(ts.transpileModule(callbacks.map(node => node.getText(ast)).join("\n"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
    return { app, event, sandbox, get quitCalls() { return quitCalls; } };
  }
  it("does not start update quit or services before real source approval; preserves the actual 8s cleanup and reentry", async () => {
    vi.useFakeTimers(); const f = await fixture(); const stop = vi.fn(() => new Promise<void>(() => undefined)); const main = await installMainCallbacks(f.adapter, stop);
    const pending = main.event(); main.app.emit("before-quit", pending); expect(pending.prevented).toBe(true); expect(main.sandbox.updateQuit.quitInProgress).toBe(false); expect(stop).not.toHaveBeenCalled();
    expect((await f.approve()).accept()).toBe(true);
    const approved = main.event(); main.app.emit("before-quit", approved); expect(approved.prevented).toBe(false); expect(main.sandbox.updateQuit.quitInProgress).toBe(true);
    expect(f.adapter.windowClose(f.context.windowEpoch)).toBe(true); f.closed();
    const cleanup = main.event(); main.app.emit("will-quit", cleanup); expect(cleanup.prevented).toBe(true); expect(stop).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(7_999); expect(main.quitCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(2); expect(main.quitCalls).toBe(1); expect(stop).toHaveBeenCalledTimes(1); expect(main.sandbox.backgroundServicesReadyForExit).toBe(true);
  });
  it("preserves failed-installer queued-quit suppression and cannot reuse revoked cleanup authority", async () => {
    vi.useFakeTimers(); const f = await fixture(); let release!: () => void; const stop = vi.fn(() => new Promise<void>(done => { release = done; }));
    const main = await installMainCallbacks(f.adapter, stop);
    main.sandbox.updateQuit.installing(); main.sandbox.updateQuit.installFailed(); expect(main.sandbox.updateQuit.handoff()).toBe(false);
    const queued = main.event(); main.app.emit("before-quit", queued); expect(queued.prevented).toBe(true); expect(f.requests).toHaveLength(0); expect(stop).not.toHaveBeenCalled();
    const user = main.event(); main.app.emit("before-quit", user); expect(f.requests).toHaveLength(1); expect((await f.approve()).accept()).toBe(true);
    main.app.emit("before-quit", main.event()); expect(f.adapter.windowClose(f.context.windowEpoch)).toBe(true); f.closed(); main.app.emit("will-quit", main.event());
    await f.reopen(); release(); await vi.advanceTimersByTimeAsync(1); expect(main.quitCalls).toBe(0); expect(main.sandbox.backgroundServicesReadyForExit).toBe(false);
  });
});


describe("actual main native fallback callback integration", () => {
  async function bindDialog(f: Awaited<ReturnType<typeof fixture>>, missingParent = false) {
    let answer!: (value: { response: number; checkboxChecked: boolean }) => void;
    let options: { signal: AbortSignal; detail: string };
    const hosts: Array<{ destroyed: boolean }> = [];
    class Host { destroyed = false; constructor() { hosts.push(this); } isDestroyed() { return this.destroyed; } destroy() { this.destroyed = true; } }
    const sandbox: Record<string, any> = { mainWindow: missingParent ? null : new Host(), BrowserWindow: Host, AbortController,
      fallbackDialogs: new Map(), fallbackDialogOwners: new Set(), projectPersistence: f.persistence, retiredProjectResume: { session: f.persistence.getSession() },
      nativeDeparture: f.adapter, console,
      dialog: { showMessageBox: (_parent: unknown, value: typeof options) => { options = value; return new Promise(resolve => { answer = resolve; }); } },
    };
    const text = await fs.readFile(path.resolve("src/electron/main.ts"), "utf8"), ast = ts.createSourceFile("main.ts", text, ts.ScriptTarget.Latest, true);
    const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node) && ["showProjectFallback", "dismissProjectFallback"].includes(node.name?.text ?? ""));
    vm.runInNewContext(ts.transpileModule(declarations.map(node => node.getText(ast)).join("\n"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
    f.bindFallback(sandbox.showProjectFallback, sandbox.dismissProjectFallback);
    return { sandbox, hosts, get options() { return options!; }, answer(response: number) { answer({ response, checkboxChecked: false }); } };
  }
  it("late dialog completion cannot duplicate a live exact-receipt continuation and aborts its actual owned signal", async () => {
    const f = await fixture(); f.adapter.request("close"); const proof = await f.approve(); const dialog = await bindDialog(f);
    f.adapter.coordinator.notifyUnresponsive(f.context.windowEpoch); expect(dialog.options.detail).toContain("Last recovery copy:");
    expect(proof.accept()).toBe(true); expect(dialog.options.signal.aborted).toBe(true); dialog.answer(1);
    await Promise.resolve(); await Promise.resolve(); expect(f.actions).toEqual(["close"]); expect(dialog.sandbox.fallbackDialogs.size).toBe(0);
    expect(dialog.hosts[0].destroyed).toBe(false); // The authored window belongs to main, not dialog cleanup.
  });
  it("a missing authored parent gets one temporary owner, which Reopen dismisses without adopting it as mainWindow", async () => {
    const f = await fixture(); f.adapter.request("close"); const dialog = await bindDialog(f, true); f.disappear();
    expect(dialog.hosts).toHaveLength(1); expect(dialog.sandbox.mainWindow).toBeNull(); expect(dialog.sandbox.fallbackDialogOwners.size).toBe(1);
    dialog.answer(0); await Promise.resolve(); await Promise.resolve(); expect(f.actions).toEqual(["reopen"]); expect(dialog.hosts[0].destroyed).toBe(true); expect(dialog.sandbox.fallbackDialogOwners.size).toBe(0);
  });
});
