import type { BrowserWindow, IpcMainInvokeEvent, Menu } from "electron";
import type { EventEmitter } from "node:events";
import { WINDOWS_TITLE_BAR_HEIGHT, type WindowState } from "../shared/windowChrome";

const menuIds = new Set(["file", "robot", "agents", "view", "help"]);
type Handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void;

export function windowState(window: BrowserWindow): WindowState {
  return { maximized: window.isMaximized(), fullscreen: window.isFullScreen(), focused: window.isFocused() };
}

/** Also rejects child frames and retired windows; never accepts a renderer-supplied window ID. */
export function chromeWindow(event: IpcMainInvokeEvent, window: BrowserWindow | null, platform: string): BrowserWindow {
  if (platform !== "win32" || !window || window.isDestroyed()
    || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error("Unauthorized window request");
  }
  return window;
}

export function registerWindowChrome(options: { handle: Handle; getWindow: () => BrowserWindow | null; getMenu: () => Menu | null; platform: string }) {
  const { handle, getWindow, getMenu, platform } = options;
  let popupOpen = false;
  handle("window:state", event => windowState(chromeWindow(event, getWindow(), platform)));
  handle("window:action", (event, action) => {
    const window = chromeWindow(event, getWindow(), platform);
    switch (action) {
      case "minimize": window.minimize(); break;
      case "toggle-maximize":
        if (window.isFullScreen()) window.setFullScreen(false);
        else if (window.isMaximized()) window.unmaximize();
        else window.maximize();
        break;
      // close() enters the existing project departure coordinator, including draft preflight.
      case "close": window.close(); break;
      default: throw new Error("Unknown window action");
    }
  });
  handle("window:menu", (event, id, rawAnchor) => {
    const window = chromeWindow(event, getWindow(), platform);
    if (typeof id !== "string" || !menuIds.has(id)) throw new Error("Unknown window menu");
    const anchor = rawAnchor as { x?: unknown; y?: unknown } | null;
    if (!anchor || typeof anchor.x !== "number" || typeof anchor.y !== "number"
      || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) throw new Error("Invalid menu anchor");
    const menu = getMenu()?.getMenuItemById(`chrome-${id}`)?.submenu;
    if (!menu) throw new Error("Window menu unavailable");
    if (popupOpen) return false;
    const [width, height] = window.getContentSize(), zoom = window.webContents.getZoomFactor();
    const x = Math.max(0, Math.min(width - 1, Math.round(anchor.x * zoom)));
    const y = Math.max(0, Math.min(height - 1, Math.round(anchor.y * zoom)));
    popupOpen = true;
    return new Promise<boolean>((resolve, reject) => {
      const closed = () => { popupOpen = false; window.removeListener("closed", closed); resolve(true); };
      window.once("closed", closed);
      try { menu.popup({ window, x, y, callback: closed }); }
      catch (error) { popupOpen = false; window.removeListener("closed", closed); reject(error); }
    });
  });
}

/** Native maximize, restore, focus and fullscreen changes must also reach the custom controls. */
export function attachWindowChrome(window: BrowserWindow, platform: string): () => void {
  if (platform !== "win32") return () => undefined;
  window.setMenuBarVisibility(false);
  // BrowserWindow minimums are outer dimensions. Preserve the old 1100x720 editor below our strip.
  const [outerWidth, outerHeight] = window.getSize(), [width, height] = window.getContentSize();
  window.setMinimumSize(1100 + outerWidth - width, 720 + WINDOWS_TITLE_BAR_HEIGHT + outerHeight - height);
  const contents = window.webContents;
  const publish = () => {
    if (!window.isDestroyed() && !contents.isDestroyed()) contents.send("window:stateChanged", windowState(window));
  };
  const events = ["maximize", "unmaximize", "enter-full-screen", "leave-full-screen", "focus", "blur"] as const;
  const emitter: EventEmitter = window;
  for (const event of events) emitter.on(event, publish);
  contents.on("did-finish-load", publish);
  const detach = () => {
    for (const event of events) emitter.removeListener(event, publish);
    contents.removeListener("did-finish-load", publish);
    window.removeListener("closed", detach);
  };
  window.once("closed", detach);
  return detach;
}
