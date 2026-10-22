import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { attachWindowChrome, chromeWindow, registerWindowChrome } from "../src/electron/windowChrome";

function fixture(platform = "win32") {
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, getZoomFactor: () => 1.5, isDestroyed: () => false, send: vi.fn() });
  let maximized = false, fullscreen = false, destroyed = false;
  const window = Object.assign(new EventEmitter(), {
    webContents: contents, isDestroyed: () => destroyed, isMaximized: () => maximized, isFullScreen: () => fullscreen, isFocused: () => true,
    minimize: vi.fn(), maximize: vi.fn(() => { maximized = true; }), unmaximize: vi.fn(() => { maximized = false; }),
    setFullScreen: vi.fn((value: boolean) => { fullscreen = value; }), close: vi.fn(), destroy: vi.fn(),
    getContentSize: () => [1100, 720], getSize: () => [1116, 736], setMenuBarVisibility: vi.fn(), setMinimumSize: vi.fn(),
  });
  const handlers = new Map<string, (...args: any[]) => any>(), popup = vi.fn();
  const applicationPopup = vi.fn();
  const menu = { popup: applicationPopup, getMenuItemById: vi.fn(id => id === "chrome-file" ? { submenu: { popup } } : undefined) };
  let current: any = window;
  registerWindowChrome({ platform, handle: (channel, listener) => { handlers.set(channel, listener); }, getWindow: () => current, getMenu: () => menu as any });
  const event = { sender: contents, senderFrame: contents.mainFrame } as any;
  return { window, contents, menu, popup, applicationPopup, event, call: (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args), retire: () => { current = null; }, kill: () => { destroyed = true; } };
}

describe("Windows chrome capability", () => {
  it("rejects foreign windows, child frames, retired windows, destroyed windows and other platforms", () => {
    const f = fixture();
    expect(() => chromeWindow({ ...f.event, sender: {} }, f.window as any, "win32")).toThrow("Unauthorized");
    expect(() => chromeWindow({ ...f.event, senderFrame: {} }, f.window as any, "win32")).toThrow("Unauthorized");
    expect(() => fixture("darwin").call("window:action", "close")).toThrow("Unauthorized");
    f.retire(); expect(() => f.call("window:state")).toThrow("Unauthorized");
    f.kill(); expect(() => chromeWindow(f.event, f.window as any, "win32")).toThrow("Unauthorized");
  });

  it("only accepts explicit controls and closes through graceful close without destroy", () => {
    const f = fixture();
    expect(f.call("window:state")).toEqual({ maximized: false, fullscreen: false, focused: true });
    f.call("window:action", "minimize"); expect(f.window.minimize).toHaveBeenCalledOnce();
    f.call("window:action", "toggle-maximize"); expect(f.call("window:state").maximized).toBe(true);
    f.call("window:action", "toggle-maximize"); expect(f.window.unmaximize).toHaveBeenCalledOnce();
    f.window.setFullScreen(true); f.call("window:action", "toggle-maximize"); expect(f.call("window:state").fullscreen).toBe(false);
    f.call("window:action", "close"); expect(f.window.close).toHaveBeenCalledOnce(); expect(f.window.destroy).not.toHaveBeenCalled();
    for (const action of ["destroy", "quit", "save", "openExternal", {}, undefined]) expect(() => f.call("window:action", action)).toThrow("Unknown");
  });

  it("only opens allowlisted main-owned menus with finite, zoom-adjusted clamped coordinates", async () => {
    const f = fixture();
    for (const id of ["openExternal", "chrome-file", "constructor", {}]) expect(() => f.call("window:menu", id, { x: 0, y: 44 })).toThrow("Unknown");
    for (const anchor of [null, {}, { x: Infinity, y: 44 }, { x: 0, y: NaN }, { x: "0", y: 44 }]) expect(() => f.call("window:menu", "file", anchor)).toThrow("anchor");
    const pending = f.call("window:menu", "file", { x: 30, y: 44 });
    expect(f.popup.mock.calls[0][0]).toMatchObject({ window: f.window, x: 45, y: 66 });
    expect(f.call("window:menu", "file", { x: 0, y: 0 })).toBe(false);
    f.popup.mock.calls[0][0].callback(); expect(await pending).toBe(true);
    const second = f.call("window:menu", "file", { x: -100, y: 1e20 });
    expect(f.popup.mock.calls[1][0]).toMatchObject({ x: 0, y: 719 });
    f.window.emit("closed"); expect(await second).toBe(true); expect(f.window.listenerCount("closed")).toBe(0);
  });

  it("opens the actual main-owned application menu and shares the submenu popup guard", async () => {
    const f = fixture();
    const pending = f.call("window:menu", "application", { x: 500, y: 44 });
    expect(f.applicationPopup).toHaveBeenCalledOnce();
    expect(f.applicationPopup.mock.calls[0][0]).toMatchObject({ window: f.window, x: 750, y: 66 });
    expect(f.menu.getMenuItemById).not.toHaveBeenCalled();
    expect(f.call("window:menu", "file", { x: 0, y: 44 })).toBe(false);
    f.applicationPopup.mock.calls[0][0].callback(); expect(await pending).toBe(true);
    const submenu = f.call("window:menu", "file", { x: 0, y: 44 });
    expect(f.call("window:menu", "application", { x: 0, y: 44 })).toBe(false);
    f.popup.mock.calls[0][0].callback(); await submenu;
  });

  it("recovers from popup failure and unavailable menus", async () => {
    const f = fixture();
    expect(() => f.call("window:menu", "help", { x: 0, y: 44 })).toThrow("unavailable");
    f.popup.mockImplementationOnce(() => { throw Error("native failure"); });
    await expect(f.call("window:menu", "file", { x: 0, y: 44 })).rejects.toThrow("native failure");
    expect(f.window.listenerCount("closed")).toBe(0);
    const pending = f.call("window:menu", "file", { x: 0, y: 44 }); f.popup.mock.calls[1][0].callback(); await pending;
  });

  it("publishes native state changes and detaches subscriptions; preserves 1100x720 editor content", () => {
    const f = fixture(), detach = attachWindowChrome(f.window as any, "win32");
    expect(f.window.setMinimumSize).toHaveBeenCalledWith(1116, 736);
    expect(f.window.setMenuBarVisibility).toHaveBeenCalledWith(false);
    f.window.maximize(); f.window.emit("maximize");
    expect(f.contents.send).toHaveBeenLastCalledWith("window:stateChanged", { maximized: true, fullscreen: false, focused: true });
    f.contents.emit("did-finish-load"); expect(f.contents.send).toHaveBeenCalledTimes(2);
    detach(); f.window.emit("unmaximize"); f.contents.emit("did-finish-load"); expect(f.contents.send).toHaveBeenCalledTimes(2);
    const mac = fixture(); attachWindowChrome(mac.window as any, "darwin"); expect(mac.window.setMenuBarVisibility).not.toHaveBeenCalled(); expect(mac.window.setMinimumSize).not.toHaveBeenCalled();
  });

  it("does not access the destroyed window's webContents during closed dispatch", () => {
    const f = fixture(); attachWindowChrome(f.window as any, "win32");
    const closed = vi.fn(); f.window.on("closed", closed);
    f.kill();
    Object.defineProperty(f.window, "webContents", { get: () => { throw Error("Object has been destroyed"); } });
    expect(() => f.window.emit("closed")).not.toThrow();
    expect(closed).toHaveBeenCalledOnce();
    expect(f.contents.listenerCount("did-finish-load")).toBe(0);
  });
});
