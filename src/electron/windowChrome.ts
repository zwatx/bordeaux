import type { BrowserWindow, IpcMainInvokeEvent, Menu, MenuItem } from "electron";
import type { EventEmitter } from "node:events";
import type { WindowState, WindowMenuEntry } from "../shared/windowChrome";

const menuIds = new Set(["application", "file", "robot", "agents", "view", "help"]);
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

export function registerWindowChrome(options: { handle: Handle; getWindow: () => BrowserWindow | null; getMenu: () => Menu | null; platform: string; quit?: () => void }) {
  const { handle, getWindow, getMenu, platform } = options;
  let popupOpen = false;
  let menuGeneration = 0, menuSource: Menu | null = null;
  const commands = new Map<string, { item: MenuItem; ancestors: MenuItem[] }>();
  handle('window:menuItems', event => {
    chromeWindow(event, getWindow(), platform);
    menuSource = getMenu(); commands.clear(); menuGeneration++;
    if (!menuSource) throw new Error('Window menu unavailable');
    const entries = (menu: Menu, ancestors: MenuItem[] = []): WindowMenuEntry[] => menu.items.filter(item => item.visible).map(item => {
      const token = menuGeneration + ':' + commands.size;
      commands.set(token, { item, ancestors });
      return { token, id: item.id, label: item.label.replace(/&/g, ''), enabled: item.enabled, separator: item.type === 'separator',
        ...(item.type === 'checkbox' || item.type === 'radio' ? { checked: item.checked } : {}),
        accelerator: item.accelerator?.replace('CmdOrCtrl', 'Ctrl'),
        ...(item.submenu ? { children: entries(item.submenu, [...ancestors, item]) } : {}) };
    });
    return entries(menuSource);
  });
  handle('window:menuActivate', (event, token) => {
    const window = chromeWindow(event, getWindow(), platform);
    const entry = typeof token === 'string' ? commands.get(token) : undefined;
    if (!entry || getMenu() !== menuSource || [entry.item, ...entry.ancestors].some(item => !item.enabled || !item.visible)
      || entry.item.submenu || entry.item.type === 'separator') throw new Error('Menu changed. Open it again.');
    commands.clear();
    const item = entry.item, contents = window.webContents;
    // Roles bypass MenuItem.click in Electron; retain their main-owned operations here.
    switch (item.role?.toLowerCase()) {
      case 'quit': options.quit?.(); break;
      case 'toggledevtools': contents.toggleDevTools(); break;
      case 'resetzoom': contents.setZoomLevel(0); break;
      case 'zoomin': contents.setZoomLevel(Math.min(9, contents.getZoomLevel() + 0.5)); break;
      case 'zoomout': contents.setZoomLevel(Math.max(-9, contents.getZoomLevel() - 0.5)); break;
      case 'togglefullscreen': window.setFullScreen(!window.isFullScreen()); break;
      default: item.click(item, window, { triggeredByAccelerator: false });
    }
  });
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
    const application = getMenu();
    const menu = id === "application" ? application : application?.getMenuItemById(`chrome-${id}`)?.submenu;
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
  // BrowserWindow minimums are outer dimensions; the toolbar is inside the 1100x720 content.
  const [outerWidth, outerHeight] = window.getSize(), [width, height] = window.getContentSize();
  window.setMinimumSize(1100 + outerWidth - width, 720 + outerHeight - height);
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
