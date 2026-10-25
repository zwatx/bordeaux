import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { WindowAction, WindowMenu, WindowState } from "../../shared/windowChrome";
import "../styles/windows-title-bar.css";
import { WindowsApplicationMenu } from './WindowsApplicationMenu';

const shortcuts: Record<string, WindowMenu> = { f: "file", r: "robot", a: "agents", v: "view", h: "help" };

export function WindowsTitleBar() {
  const api = window.bordeauxAPI;
  return api?.platform === "win32" && typeof api.getWindowState === "function" ? <TitleBar api={api} /> : null;
}

function TitleBar({ api }: { api: NonNullable<Window["bordeauxAPI"]> }) {
  const [state, setState] = useState<WindowState>({ maximized: false, fullscreen: false, focused: true });
  const [active, setActive] = useState<WindowMenu | null>(null);
  const [error, setError] = useState("");
  const [host, setHost] = useState<HTMLElement>(document.body);
  const root = useRef<HTMLDivElement>(null), menuButton = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    // A modal's top layer makes outside controls inert. Keep the same chrome owner, but
    // render its controls inside the newest modal until it closes, including departure.
    let modals: HTMLDialogElement[] = [];
    const update = () => {
      modals = modals.filter(dialog => dialog.isConnected && dialog.matches(":modal"));
      for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog:modal")) {
        if (!modals.includes(dialog)) modals.push(dialog);
      }
      setHost(modals.at(-1) || document.body);
    };
    const observer = new MutationObserver(update);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });
    update();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let live = true, received = false;
    const unsubscribe = api.onWindowState(value => { received = true; if (live) setState(value); });
    void api.getWindowState().then(value => { if (live && !received) setState(value); }).catch(() => { if (live) setError("Window controls unavailable"); });
    return () => { live = false; unsubscribe(); };
  }, [api]);

  function rememberFocus() {
    if (!root.current?.contains(document.activeElement)) previousFocus.current = document.activeElement as HTMLElement;
  }
  async function open(id: WindowMenu = "application") {
    const button = menuButton.current;
    if (!button) return;
    rememberFocus(); button.focus();
    setActive(active === id ? null : id); setError('');
  }
  function action(value: WindowAction) {
    setError("");
    void api.windowAction(value).catch(() => setError("Window action unavailable. Try again."));
  }
  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      const id = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
        ? shortcuts[event.key.toLowerCase()] : undefined;
      if (id) { event.preventDefault(); event.stopImmediatePropagation(); void open(id); return; }
      if (event.key === "F10" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (active) { setActive(null); menuButton.current?.focus(); return; }
        if (root.current?.contains(document.activeElement)) previousFocus.current?.focus();
        else { rememberFocus(); menuButton.current?.focus(); }
      }
    }
    window.addEventListener("keydown", keyboard, true);
    return () => window.removeEventListener("keydown", keyboard, true);
  });

  return createPortal(<><div ref={root} className="windows-title-bar" data-native-chrome="" data-focused={state.focused} role="group" aria-label="Window"
    onKeyDown={event => event.stopPropagation()}>
    <button ref={menuButton} className="windows-title-menu" type="button" aria-label="Application menu" title="Application menu (F10)"
      aria-haspopup="menu" aria-expanded={active !== null} aria-keyshortcuts="F10 Alt+F Alt+R Alt+A Alt+V Alt+H"
      onPointerDown={rememberFocus} onClick={() => void open()} onKeyDown={event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault(); event.stopPropagation(); void open();
      } else if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); previousFocus.current?.focus();
      }
    }}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M3 8h10M3 11.5h10" /></svg>
    </button>
    {error && <span className="windows-title-error" role="status">{error}</span>}
    <div className="windows-title-controls" role="group" aria-label="Window controls">
      <button type="button" aria-label="Minimize window" title="Minimize" onClick={() => action("minimize")}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6.5h10" /></svg></button>
      <button type="button" aria-label={state.maximized || state.fullscreen ? "Restore window" : "Maximize window"}
        title={state.maximized || state.fullscreen ? "Restore" : "Maximize"} onClick={() => action("toggle-maximize")}>
        <svg viewBox="0 0 12 12" aria-hidden="true">{state.maximized || state.fullscreen ? <path d="M3.5 3.5v-2h7v7h-2m-7-5h7v7h-7z" /> : <path d="M1.5 1.5h9v9h-9z" />}</svg>
      </button>
      <button type="button" className="windows-title-close" aria-label="Close window" title="Close" onClick={() => action("close")}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m1.5 1.5 9 9m0-9-9 9" /></svg></button>
    </div>
  </div>{active && menuButton.current && <WindowsApplicationMenu key={active} api={api} initial={active} anchor={menuButton.current}
    onClose={restore => { setActive(null); if (restore) menuButton.current?.focus(); }} />}</>, host);
}
