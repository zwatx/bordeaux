import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { attachWindowChrome } from "../src/electron/windowChrome";

/** Actual main window callbacks with Electron boundary fixtures; storage/approval evidence lives in projectNativeDeparture.test. */
async function fixture(platform = "darwin") {
  const calls: string[] = [];
  class Contents extends EventEmitter {
    session = { setPermissionRequestHandler: vi.fn() };
    setWindowOpenHandler = vi.fn();
    send = vi.fn();
    isDestroyed = () => false;
  }
  class Window extends EventEmitter {
    constructor(readonly options: Record<string, unknown>) { super(); }
    webContents = new Contents(); destroyed = false;
    isDestroyed() { return this.destroyed; }
    getSize = () => [1116, 736];
    getContentSize = () => [1100, 720];
    setMenuBarVisibility = vi.fn();
    setMinimumSize = vi.fn();
    show() {}
    async loadFile() { this.webContents.emit("did-frame-navigate", {}, "file:///fixture", -1, "", true); }
  }
  const sandbox: Record<string, any> = { mainWindow: null, projectWindowEpoch: "old", projectDocumentSession: "document", projectTargetGeneration: 1,
    attachWindowChrome,
    randomUUID, BrowserWindow: Window, path, __dirname: path.resolve("src/electron"), process: { platform, env: {} }, appUpdates: null,
    projectContext: () => ({ windowEpoch: sandbox.projectWindowEpoch, documentSessionId: sandbox.projectDocumentSession, targetGeneration: sandbox.projectTargetGeneration }),
    activateProjectTarget: () => { sandbox.projectTargetGeneration++; }, replaceProjectSession: () => { sandbox.projectDocumentSession = randomUUID(); calls.push("replace"); },
    nativeDeparture: { documentEntered: vi.fn(), windowClose: vi.fn(() => false), preventUnload: vi.fn(() => false), isExpectedWindowClose: vi.fn(() => false), windowClosed: vi.fn(), windowVanished: vi.fn(() => calls.push("vanished")), rendererGone: vi.fn(() => calls.push("gone")), coordinator: { notifyUnresponsive: vi.fn() } },
    projectPersistence: { getTransitionId: () => null, setLifecycleReady: () => calls.push("not-ready"), contextChanged: () => calls.push("fence") },
    captureProjectResumeDescriptor: () => { calls.push("capture"); return { source: "retained" }; }, retiredProjectResume: null,
    rejectProposalReceipts: vi.fn(), agentSessions: { resetAccess: vi.fn() }, agentBridge: null,
  };
  const text = await fs.readFile(path.resolve("src/electron/main.ts"), "utf8"), ast = ts.createSourceFile("main.ts", text, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "createWindow")!;
  vm.runInNewContext(ts.transpileModule(declaration.getText(ast), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
  sandbox.createWindow(); calls.length = 0;
  return { sandbox, calls, window: sandbox.mainWindow as Window };
}
it("blocked unload leaves the live epoch intact; committed main-frame navigation alone replaces it", async () => {
  const { sandbox: s, window } = await fixture(), epoch = s.projectWindowEpoch;
  window.webContents.emit("did-start-loading"); expect(s.projectWindowEpoch).toBe(epoch);
  const unmanaged = { preventDefault: vi.fn() }; window.webContents.emit("will-prevent-unload", unmanaged); expect(unmanaged.preventDefault).not.toHaveBeenCalled();
  window.webContents.emit("did-frame-navigate", {}, "file:///child", -1, "", false); expect(s.projectWindowEpoch).toBe(epoch);
  window.webContents.emit("did-frame-navigate", {}, "file:///fixture", -1, "", true); expect(s.projectWindowEpoch).not.toBe(epoch); expect(s.retiredProjectResume).toEqual({ source: "retained" });
});
it("Windows starts at 1440x900 with a 1100x720 content minimum and no extra title strip", async () => {
  const { window } = await fixture("win32");
  expect(window.options).toMatchObject({ width: 1440, height: 900, minWidth: 1100, minHeight: 720, useContentSize: true, titleBarStyle: "hidden" });
  expect(window.setMinimumSize).toHaveBeenCalledWith(1116, 736);
  expect(window.setMenuBarVisibility).toHaveBeenCalledWith(false);
});
it("real close and unload listeners honor only their adapter admission, and stale window events cannot retire a successor", async () => {
  const { sandbox: s, window } = await fixture(); const blocked = { preventDefault: vi.fn() }; window.emit("close", blocked); expect(blocked.preventDefault).toHaveBeenCalledOnce();
  s.nativeDeparture.windowClose.mockReturnValue(true); const admitted = { preventDefault: vi.fn() }; window.emit("close", admitted); expect(admitted.preventDefault).not.toHaveBeenCalled();
  s.nativeDeparture.preventUnload.mockReturnValue(true); const approvedUnload = { preventDefault: vi.fn() }; window.webContents.emit("will-prevent-unload", approvedUnload); expect(approvedUnload.preventDefault).toHaveBeenCalledOnce();
  s.createWindow(); const successor = s.mainWindow, epoch = s.projectWindowEpoch; window.emit("closed"); window.webContents.emit("render-process-gone");
  expect(s.mainWindow).toBe(successor); expect(s.projectWindowEpoch).toBe(epoch); expect(s.nativeDeparture.rendererGone).not.toHaveBeenCalled();
});
it("crash captures resume before fallback and storage fencing; unexpected closed preserves its fallback epoch", async () => {
  const { sandbox: s, calls, window } = await fixture(), epoch = s.projectWindowEpoch;
  window.webContents.emit("render-process-gone"); expect(calls).toEqual(["capture", "gone", "not-ready", "fence"]); expect(s.projectWindowEpoch).toBe(epoch);
  calls.length = 0; window.destroyed = true; window.emit("closed"); expect(calls).toEqual(["capture", "vanished", "fence"]); expect(s.mainWindow).toBeNull(); expect(s.projectWindowEpoch).toBe(epoch); expect(s.nativeDeparture.windowClosed).not.toHaveBeenCalled();
});
