import { useEffect, useRef, useState } from "react";
import type { WindowAction, WindowMenu, WindowState } from "../../shared/windowChrome";
import "../styles/windows-title-bar.css";

const menus: { id: WindowMenu; label: string; key: string }[] = [
  { id: "file", label: "File", key: "f" }, { id: "robot", label: "Robot", key: "r" },
  { id: "agents", label: "Agents", key: "a" }, { id: "view", label: "View", key: "v" },
  { id: "help", label: "Help", key: "h" },
];

export function WindowsTitleBar() {
  const api = window.bordeauxAPI;
  return api?.platform === "win32" && typeof api.getWindowState === "function" ? <TitleBar api={api} /> : null;
}

function TitleBar({ api }: { api: NonNullable<Window["bordeauxAPI"]> }) {
  const [state, setState] = useState<WindowState>({ maximized: false, fullscreen: false, focused: true });
  const [active, setActive] = useState<WindowMenu | null>(null);
  const [error, setError] = useState("");
  const root = useRef<HTMLElement>(null), buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const previousFocus = useRef<HTMLElement | null>(null), opening = useRef(false);

  useEffect(() => {
    let live = true, received = false;
    const unsubscribe = api.onWindowState(value => { received = true; if (live) setState(value); });
    void api.getWindowState().then(value => { if (live && !received) setState(value); }).catch(() => { if (live) setError("Window controls unavailable"); });
    return () => { live = false; unsubscribe(); };
  }, [api]);

  function rememberFocus() {
    if (!root.current?.contains(document.activeElement)) previousFocus.current = document.activeElement as HTMLElement;
  }
  async function open(index: number) {
    if (opening.current) return;
    const button = buttons.current[index];
    if (!button) return;
    rememberFocus(); button.focus();
    const rect = button.getBoundingClientRect();
    opening.current = true; setActive(menus[index].id); setError("");
    try { await api.openWindowMenu(menus[index].id, { x: rect.left, y: rect.bottom }); }
    catch { setError("Menu unavailable. Try again."); }
    finally {
      opening.current = false; setActive(null);
      // A command may have opened a dialog or moved focus into the editor.
      if (document.activeElement === document.body) button.focus();
    }
  }
  function action(value: WindowAction) {
    setError("");
    void api.windowAction(value).catch(() => setError("Window action unavailable. Try again."));
  }
  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      // Modal dialogs retain their own keyboard ownership.
      if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
      const index = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
        ? menus.findIndex(menu => menu.key === event.key.toLowerCase()) : -1;
      if (index >= 0) { event.preventDefault(); event.stopImmediatePropagation(); void open(index); return; }
      if (event.key === "F10" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (root.current?.contains(document.activeElement)) previousFocus.current?.focus();
        else { rememberFocus(); buttons.current[0]?.focus(); }
      }
    }
    window.addEventListener("keydown", keyboard, true);
    return () => window.removeEventListener("keydown", keyboard, true);
  });

  return <header ref={root} className="windows-title-bar" data-native-chrome="" data-focused={state.focused} aria-label="Bordeaux window"
    onKeyDown={event => event.stopPropagation()}>
    <span className="windows-title-brand" aria-hidden="true"><span className="windows-title-mark">B</span>Bordeaux</span>
    <nav className="windows-title-menus" role="menubar" aria-label="Application menu" onKeyDown={event => {
      const index = buttons.current.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") {
        event.preventDefault(); event.stopPropagation();
        const next = event.key === "Home" ? 0 : event.key === "End" ? menus.length - 1 : (index + (event.key === "ArrowRight" ? 1 : menus.length - 1)) % menus.length;
        buttons.current[next]?.focus();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault(); event.stopPropagation(); void open(Math.max(0, index));
      } else if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); previousFocus.current?.focus();
      }
    }}>
      {menus.map((menu, index) => <button key={menu.id} ref={node => { buttons.current[index] = node; }} type="button"
        role="menuitem" aria-haspopup="menu" aria-expanded={active === menu.id} aria-keyshortcuts={`Alt+${menu.key.toUpperCase()}`}
        tabIndex={index === 0 ? 0 : -1} onPointerDown={rememberFocus} onFocus={() => {
          buttons.current.forEach((button, i) => { if (button) button.tabIndex = i === index ? 0 : -1; });
        }} onClick={() => void open(index)}>{menu.label}</button>)}
    </nav>
    <span className="windows-title-drag" aria-hidden="true" />
    {error && <span className="windows-title-error" role="status">{error}</span>}
    <div className="windows-title-controls" role="group" aria-label="Window controls">
      <button type="button" aria-label="Minimize window" title="Minimize" onClick={() => action("minimize")}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6.5h10" /></svg></button>
      <button type="button" aria-label={state.maximized || state.fullscreen ? "Restore window" : "Maximize window"}
        title={state.maximized || state.fullscreen ? "Restore" : "Maximize"} onClick={() => action("toggle-maximize")}>
        <svg viewBox="0 0 12 12" aria-hidden="true">{state.maximized || state.fullscreen ? <path d="M3.5 3.5v-2h7v7h-2m-7-5h7v7h-7z" /> : <path d="M1.5 1.5h9v9h-9z" />}</svg>
      </button>
      <button type="button" className="windows-title-close" aria-label="Close window" title="Close" onClick={() => action("close")}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m1.5 1.5 9 9m0-9-9 9" /></svg></button>
    </div>
  </header>;
}
