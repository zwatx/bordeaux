import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CancellationToken } from "builder-util-runtime";
import type { AppUpdateState } from "../src/core/appUpdates";
import { appUpdateChannel, AppUpdateController, supportsAppUpdates, UpdateQuitCoordinator, usesGitHubAppUpdates, updateReleaseNotes, type UpdateRuntime } from "../src/electron/appUpdates";

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  autoRunAppAfterInstall = false;
  allowPrerelease = false;
  allowDowngrade = true;
  channel: string | null = null;
  checkForUpdates = vi.fn(async (): Promise<unknown> => ({}));
  downloadUpdate = vi.fn(async (_token?: CancellationToken): Promise<unknown> => []);
  quitAndInstall = vi.fn();
}
function fixture(overrides: Partial<UpdateRuntime> = {}) {
  const updater = new FakeUpdater();
  const states: AppUpdateState[] = [];
  let dirty = false;
  const runtime: UpdateRuntime = {
    packaged: true, supported: true, currentVersion: "0.2.0-beta.1",
    isProjectDirty: () => dirty, warn: vi.fn(),
    describeError: () => "Try again or open Releases.", ...overrides,
  };
  const controller = new AppUpdateController(updater, runtime, state => states.push(state));
  controller.start();
  const offer = () => updater.emit("update-available", { version: "0.3.0", releaseNotes: "<p>Better paths</p>" });
  const ready = async () => {
    offer();
    updater.downloadUpdate.mockImplementationOnce(async () => { updater.emit("update-downloaded", { version: "0.3.0" }); return []; });
    await controller.download();
  };
  return { updater, runtime, controller, states, offer, ready, setDirty(value: boolean) { dirty = value; } };
}

describe("application update state", () => {
  afterEach(() => vi.useRealTimers());
  it("selects supported package formats and stable/beta feeds", () => {
    expect(supportsAppUpdates("darwin")).toBe(true);
    expect(supportsAppUpdates("aix")).toBe(false);
    expect(usesGitHubAppUpdates("win32", true)).toBe(false);
    expect(usesGitHubAppUpdates("win32", false, true)).toBe(false);
    expect(usesGitHubAppUpdates("win32", false)).toBe(true);
    expect(usesGitHubAppUpdates("linux", false, false, false)).toBe(false);
    expect(usesGitHubAppUpdates("linux", false, false, true)).toBe(true);
    expect(appUpdateChannel("1.0.0")).toBe("latest");
    expect(appUpdateChannel("1.0.0-rc.1")).toBe("beta");
    expect(fixture().updater).toMatchObject({ autoDownload: false, autoInstallOnAppQuit: false, autoRunAppAfterInstall: true, allowPrerelease: true, allowDowngrade: false, channel: "beta" });
    expect(fixture({ currentVersion: "1.0.0" }).updater.channel).toBe("latest");
  });
  it("never checks unsupported or development installs", async () => {
    const f = fixture({ packaged: false });
    await f.controller.check(true);
    expect(f.updater.checkForUpdates).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ phase: "unsupported", visible: true });
    const absent = new AppUpdateController(null, f.runtime);
    await absent.check(true);
    expect(absent.snapshot().phase).toBe("unsupported");
  });
  it("coalesces checks and lets a manual check reveal an ongoing background check", async () => {
    const f = fixture(); const pending = deferred();
    f.updater.checkForUpdates.mockReturnValue(pending.promise);
    const background = f.controller.check(); const manual = f.controller.check(true);
    await Promise.resolve();
    expect(f.updater.checkForUpdates).toHaveBeenCalledOnce();
    expect(f.controller.snapshot()).toMatchObject({ phase: "checking", visible: true });
    f.updater.emit("update-not-available", { version: "0.2.0-beta.1" });
    pending.resolve({}); await Promise.all([background, manual]);
    expect(f.controller.snapshot().phase).toBe("upToDate");
  });
  it("reports null check results as unsupported", async () => {
    const f = fixture(); f.updater.checkForUpdates.mockResolvedValue(null);
    await f.controller.check(true); expect(f.controller.snapshot().phase).toBe("unsupported");
  });
  it("offers updates without opening the panel and never auto downloads", () => {
    const f = fixture(); f.offer();
    expect(f.controller.snapshot()).toMatchObject({ phase: "available", visible: false, releaseNotes: "Better paths" });
    f.controller.setVisible(true); f.offer();
    expect(f.controller.snapshot().visible).toBe(true);
    expect(f.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(updateReleaseNotes({version:"1",releaseNotes:[{version:"1",note:"A &amp; B"}]})).toBe("A & B");
  });
  it("deduplicates emitted and rejected errors of a manual check", async () => {
    const f = fixture(); const error = new Error("private diagnostic");
    f.updater.checkForUpdates.mockImplementation(async () => { f.updater.emit("error", error); throw error; });
    await f.controller.check(true);
    expect(f.states.filter(s => s.phase === "error")).toHaveLength(1);
    expect(f.controller.snapshot()).toMatchObject({ visible: true, error: "Try again or open Releases.", errorDetails: "private diagnostic", errorStage: "check" });
  });
  it("keeps background checks out of sight and logs their failures once", async () => {
    const f = fixture(); const error = new Error("offline");
    f.updater.checkForUpdates.mockImplementation(async () => { f.updater.emit("error", error); throw error; });
    await f.controller.check();
    expect(f.states).toEqual([]);
    expect(f.runtime.warn).toHaveBeenCalledOnce();
    expect(f.controller.snapshot()).toMatchObject({ phase: "idle", error: null });
  });
  it("keeps a shown offer when a later background check fails", async () => {
    const f = fixture(); f.offer();
    f.updater.checkForUpdates.mockRejectedValue(new Error("event Wi-Fi"));
    await f.controller.check();
    expect(f.states.map(s => s.phase)).toEqual(["available"]);
    expect(f.controller.snapshot()).toMatchObject({ phase: "available", version: "0.3.0", releaseNotes: "Better paths" });
  });
  it.each(["failure", "same offer", "new offer", "withdrawn offer"] as const)(
    "handles a download click during a silent check ending with %s", async (outcome) => {
      const f = fixture();
      f.offer();
      const pending = deferred();
      f.updater.checkForUpdates.mockReturnValue(pending.promise);
      const check = f.controller.checkInBackground();
      await Promise.resolve();

      const click = f.controller.download();
      expect(f.updater.downloadUpdate).not.toHaveBeenCalled();
      if (outcome === "failure") {
        pending.reject(new Error("offline"));
      } else {
        if (outcome === "same offer") f.offer();
        if (outcome === "new offer") f.updater.emit("update-available", { version: "0.4.0" });
        if (outcome === "withdrawn offer") f.updater.emit("update-not-available", { version: "0.2.0-beta.1" });
        pending.resolve({});
      }
      await Promise.all([check, click]);
      expect(f.updater.downloadUpdate).toHaveBeenCalledTimes(outcome === "failure" || outcome === "same offer" ? 1 : 0);
    },
  );
  it("lets background checks surface new offers and withdraw old ones", async () => {
    const f = fixture();
    f.updater.checkForUpdates.mockImplementationOnce(async () => { f.offer(); return {}; });
    await f.controller.check();
    expect(f.controller.snapshot()).toMatchObject({ phase: "available", version: "0.3.0" });
    f.updater.checkForUpdates.mockImplementationOnce(async () => { f.updater.emit("update-not-available", { version: "0.2.0-beta.1" }); return {}; });
    await f.controller.check();
    expect(f.controller.snapshot()).toMatchObject({ phase: "upToDate", version: null });
    expect(f.states.some(s => s.phase === "checking")).toBe(false);
  });
  it("shows the failure of a background check that a manual check joined", async () => {
    const f = fixture(); const pending = deferred(); const error = new Error("rate limited");
    f.updater.checkForUpdates.mockReturnValue(pending.promise);
    const background = f.controller.check();
    await Promise.resolve();
    f.updater.emit("error", error); // logged silently: nobody is watching yet
    const manual = f.controller.check(true);
    expect(f.controller.snapshot()).toMatchObject({ phase: "checking", visible: true });
    pending.reject(error); await Promise.all([background, manual]);
    expect(f.controller.snapshot()).toMatchObject({ phase: "error", errorStage: "check", errorDetails: "rate limited" });
  });
  it("spaces background checks an hour after success and a minute after failure, but never blocks a manual check", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const f = fixture();
    await f.controller.checkInBackground();
    vi.setSystemTime(59 * 60_000); await f.controller.checkInBackground();
    expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    await f.controller.check(true);
    expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(2);
    vi.setSystemTime(59 * 60_000 + 60 * 60_000); await f.controller.checkInBackground();
    expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(3);
    f.updater.checkForUpdates.mockRejectedValue(new Error("offline"));
    vi.setSystemTime(10 * 60 * 60_000); await f.controller.checkInBackground();
    vi.setSystemTime(10 * 60 * 60_000 + 59_000); await f.controller.checkInBackground();
    expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(4);
    vi.setSystemTime(10 * 60 * 60_000 + 60_000); await f.controller.checkInBackground();
    expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(5);
  });
  it("backs off repeated failures on focus and lets a manual check start immediately", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const f = fixture();
    f.updater.checkForUpdates.mockRejectedValue(new Error("offline"));
    await f.controller.checkInBackground();
    let elapsed = 0, calls = 1;
    for (const minutes of [1, 5, 15, 60, 60]) {
      elapsed += minutes * 60_000;
      vi.setSystemTime(elapsed - 1);
      await f.controller.checkInBackground();
      expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(calls);
      vi.setSystemTime(elapsed);
      await f.controller.checkInBackground();
      expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(++calls);
    }
    f.updater.checkForUpdates.mockResolvedValue({});
    await f.controller.check(true);
    expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(calls + 1);
  });
  it("publishes bounded progress and closing leaves transfer running", async () => {
    const f = fixture(); f.offer(); const pending = deferred();
    f.updater.downloadUpdate.mockReturnValue(pending.promise);
    const work = f.controller.download(); await Promise.resolve();
    f.updater.emit("download-progress", { percent: 140, transferred: 500, total: 1000, bytesPerSecond: 30 });
    f.controller.setVisible(false);
    expect(f.controller.snapshot()).toMatchObject({ phase: "downloading", visible: false, progress: { percent: 100, transferred: 500 } });
    expect(f.updater.downloadUpdate.mock.calls[0][0]?.cancelled).toBe(false);
    f.updater.emit("update-downloaded", { version: "0.3.0" }); pending.resolve([]); await work;
    expect(f.controller.snapshot()).toMatchObject({ phase: "downloaded", visible: false });
    expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
    await f.controller.check(true);
    expect(f.controller.snapshot()).toMatchObject({ phase: "downloaded", visible: true });
    expect(f.updater.checkForUpdates).not.toHaveBeenCalled();
  });
  it("cancels without errors or late readiness and permits retry after settlement", async () => {
    const f = fixture(); f.offer(); const pending = deferred();
    f.updater.downloadUpdate.mockReturnValueOnce(pending.promise);
    const download = f.controller.download(); await Promise.resolve();
    const cancel = f.controller.cancelDownload();
    expect(f.updater.downloadUpdate.mock.calls[0][0]?.cancelled).toBe(true);
    f.updater.emit("update-downloaded", { version: "0.3.0" });
    f.updater.emit("error", new Error("cancelled"));
    const retry = f.controller.download();
    expect(f.updater.downloadUpdate).toHaveBeenCalledOnce();
    pending.reject(new Error("cancelled")); await Promise.all([download, cancel, retry]);
    expect(f.controller.snapshot()).toMatchObject({ phase: "available", error: null });
    await f.ready(); expect(f.controller.snapshot().phase).toBe("downloaded");
  });
  it("deduplicates download errors, ignores spurious completion and retries", async () => {
    const f = fixture(); f.offer();
    f.updater.downloadUpdate.mockImplementationOnce(async () => { const e = new Error("signature rejected"); f.updater.emit("error", e); f.updater.emit("update-downloaded", {version:"0.3.0"}); throw e; });
    await f.controller.download();
    expect(f.states.filter(s => s.phase === "error")).toHaveLength(1);
    expect(f.controller.snapshot().errorStage).toBe("download");
    await f.ready(); expect(f.controller.snapshot().phase).toBe("downloaded");
  });
  it("installs with unsaved edits and blocks duplicate install requests", async () => {
    const f = fixture(); await f.ready(); f.setDirty(true);
    await f.controller.install(); await f.controller.install();
    expect(f.controller.snapshot()).toMatchObject({ phase: "installing", projectDirty: true });
    expect(f.updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true);
  });
  it("retains downloaded update after installer failure for an unsaved install retry", async () => {
    const f = fixture(); await f.ready(); f.setDirty(true);
    f.updater.quitAndInstall.mockImplementationOnce(() => { throw new Error("installer busy"); });
    await f.controller.install(); expect(f.controller.snapshot().errorStage).toBe("install");
    await f.controller.install();
    expect(f.controller.snapshot().phase).toBe("installing");
    expect(f.updater.quitAndInstall).toHaveBeenCalledTimes(2);
  });
  it("reports asynchronous installer failure", async () => {
    const f = fixture(); await f.ready(); await f.controller.install();
    f.updater.emit("error", new Error("installer failed"));
    expect(f.controller.snapshot()).toMatchObject({ phase: "error", errorStage: "install" });
  });
  it("does not duplicate listeners and returns independent state snapshots", async () => {
    const f = fixture(); f.controller.start();
    expect(f.updater.listenerCount("update-available")).toBe(1);
    f.offer(); const pending = deferred(); f.updater.downloadUpdate.mockReturnValue(pending.promise);
    const download = f.controller.download(); await Promise.resolve();
    const snapshot = f.controller.snapshot(); snapshot.progress!.percent = 75;
    expect(f.controller.snapshot().progress!.percent).toBe(0);
    pending.resolve([]); await download;
  });

  it("keeps the install guard visible until an installation error unlocks it", async () => {
    const f = fixture(); await f.ready(); f.controller.setVisible(false); await f.controller.install();
    f.controller.setVisible(false);
    expect(f.controller.snapshot()).toMatchObject({ phase: "installing", visible: true });
    f.updater.emit("error", new Error("native verification failed"));
    f.controller.setVisible(false);
    expect(f.controller.snapshot()).toMatchObject({ phase: "error", visible: false });
  });
  it("lets a retry start a new installer after an asynchronous installer failure", async () => {
    const f = fixture(); await f.ready();
    f.updater.quitAndInstall.mockImplementation(() => { (f.updater as unknown as { quitAndInstallCalled: boolean }).quitAndInstallCalled = true; });
    (f.updater as unknown as { quitAndInstallCalled: boolean }).quitAndInstallCalled = false;
    await f.controller.install();
    f.updater.emit("error", Object.assign(new Error("spawn EPERM"), { code: "EPERM" }));
    expect(f.controller.snapshot()).toMatchObject({ phase: "error", errorStage: "install" });
    expect((f.updater as unknown as { quitAndInstallCalled: boolean }).quitAndInstallCalled).toBe(false);
    await f.controller.install();
    expect(f.updater.quitAndInstall).toHaveBeenCalledTimes(2);
    expect(f.controller.snapshot().phase).toBe("installing");
  });
  it("unlocks manual recovery when native restart stalls without issuing another install", async () => {
    vi.useFakeTimers();
    const f = fixture(); await f.ready(); await f.controller.install();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.controller.snapshot()).toMatchObject({ phase: "installing", installStalled: true });
    f.controller.setVisible(false);
    expect(f.controller.snapshot().visible).toBe(false);
    await f.controller.check(true); await f.controller.install();
    expect(f.controller.snapshot()).toMatchObject({ phase: "installing", installStalled: true, visible: true });
    expect(f.updater.quitAndInstall).toHaveBeenCalledOnce();
    expect(f.updater.checkForUpdates).not.toHaveBeenCalled();
  });
  it("cancels the restart watchdog when native installation reports failure", async () => {
    vi.useFakeTimers();
    const f = fixture(); await f.ready(); await f.controller.install();
    f.updater.emit("error", new Error("native verification failed"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.controller.snapshot()).toMatchObject({ phase: "error", errorStage: "install", installStalled: false });
  });
  it("shows current release notes when already up to date without presenting older notes", async () => {
    const f = fixture();
    f.updater.checkForUpdates.mockImplementation(async () => {
      f.updater.emit("update-not-available", { version: "0.2.0-beta.1", releaseNotes: "<p>Current improvements</p>" });
      return {};
    });
    await f.controller.check(true);
    expect(f.controller.snapshot()).toMatchObject({ phase: "upToDate", releaseNotes: "Current improvements", version: null });
    f.updater.checkForUpdates.mockImplementation(async () => {
      f.updater.emit("update-not-available", { version: "0.1.0", releaseNotes: "Older notes" });
      return {};
    });
    await f.controller.check(true);
    expect(f.controller.snapshot().releaseNotes).toBe("");
  });

});

describe("update quit coordination", () => {
  it("lets a successful handoff quit", () => {
    const q = new UpdateQuitCoordinator(); q.installing();
    expect(q.handoff()).toBe(true);
    expect(q.beforeQuit()).toBe("proceed");
    expect(q.abandoned).toBe(false);
  });
  it("ignores the queued quit of an installation that failed before its handoff", () => {
    const q = new UpdateQuitCoordinator(); q.installing(); q.installFailed();
    expect(q.handoff()).toBe(false);
    expect(q.beforeQuit()).toBe("ignore");
    expect(q.beforeQuit()).toBe("proceed"); // a later user quit is unaffected
  });
  it("abandons a quit that was already under way when the installation failed", () => {
    const q = new UpdateQuitCoordinator(); q.installing();
    expect(q.handoff()).toBe(true); expect(q.beforeQuit()).toBe("proceed");
    q.installFailed();
    expect(q.abandoned).toBe(true);
    expect(q.beforeQuit()).toBe("resume");
    q.resumed();
    expect(q.abandoned).toBe(false);
    expect(q.beforeQuit()).toBe("proceed");
  });
  it("lets a retry supersede an earlier failure that never reached its handoff", () => {
    const q = new UpdateQuitCoordinator(); q.installing(); q.installFailed();
    q.installing();
    expect(q.handoff()).toBe(true);
    expect(q.beforeQuit()).toBe("proceed");
  });
  it("leaves ordinary quits alone after a macOS failure that never started quitting", () => {
    const q = new UpdateQuitCoordinator(); q.installing();
    expect(q.handoff()).toBe(true); q.installFailed(); // handoff happened, quit had not started
    expect(q.quitInProgress).toBe(false);
    expect(q.beforeQuit()).toBe("proceed");
  });
});
