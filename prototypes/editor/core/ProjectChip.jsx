// SIMULATED project chrome from work/rethink/project-ux.md: one `name · status` chip and the ⌘O Projects sheet.
// It shows how much room project UX costs in each shell. No files, folders or persistence: switching only
// changes the name (paths stay the same) and the failed state comes from ?project=failed.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import "./project-ui.css";

const store = (() => {
  let state = {
    current: "week3",
    failed: new URLSearchParams(location.search).get("project") === "failed",
    projects: [
      { id: "week3", name: "Week 3 autos", folder: "frc-2026/bordeaux", opened: "Now" },
      { id: "week2", name: "Week 2 autos", folder: "frc-2026/bordeaux-week2", opened: "6 d ago" },
      { id: "practice", name: "Practice field tests", folder: "Documents/Bordeaux", opened: "2 wk ago" },
      { id: "champs", name: "District champs", folder: "Old laptop/Desktop", opened: "", status: "Missing" },
      { id: "s2025", name: "2025 season", folder: "Archive/2025", opened: "8 mo ago" },
    ],
  };
  const listeners = new Set();
  return {
    get: () => state,
    set: (fn) => { state = fn(state); listeners.forEach((l) => l()); },
    subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
  };
})();
let seq = 1;

export function ProjectChip({ className = "" }) {
  const state = useSyncExternalStore(store.subscribe, store.get);
  const [open, setOpen] = useState(false);
  const chip = useRef(null);
  const current = state.projects.find((p) => p.id === state.current);
  const close = useCallback(() => { setOpen(false); requestAnimationFrame(() => chip.current?.focus()); }, []);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "o") { e.preventDefault(); setOpen(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <>
      <button ref={chip} type="button" className={"pj-chip " + className} data-failed={state.failed || undefined}
        aria-haspopup="dialog" aria-expanded={open} aria-keyshortcuts="Meta+O" title="Projects · ⌘O" onClick={() => setOpen((o) => !o)}>
        <span className="pj-chip-name">{current.name}</span>
        <span className="pj-chip-status">{state.failed ? "Not saved" : "Saved"}</span>
      </button>
      {open && createPortal(<ProjectsSheet state={state} onClose={close} />, document.body)}
    </>
  );
}

function ProjectsSheet({ state, onClose }) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [naming, setNaming] = useState(null);
  const input = useRef(null);
  const sheet = useRef(null);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = [...state.projects].sort((a, b) => (a.id === state.current ? -1 : b.id === state.current ? 1 : 0));
    return q ? rows.filter((p) => p.name.toLowerCase().includes(q)) : rows;
  }, [state, query]);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, [naming !== null]);
  useEffect(() => { setCursor(0); }, [query]);
  useModalOwnership(sheet, input);

  const switchTo = (p) => {
    if (!p || p.status) return;
    store.set((s) => ({ ...s, current: p.id, projects: s.projects.map((x) => (x.id === p.id ? { ...x, opened: "Now" } : x.id === s.current ? { ...x, opened: "Just now" } : x)) }));
    onClose();
  };
  // Locate… and Retry remove their own button, so focus returns to the search field instead of falling to <body>.
  const locate = (p) => { store.set((s) => ({ ...s, projects: s.projects.map((x) => (x.id === p.id ? { ...x, status: undefined, folder: "Documents/Bordeaux", opened: "1 mo ago" } : x)) })); input.current?.focus(); };
  const retry = () => { store.set((s) => ({ ...s, failed: false })); input.current?.focus(); };
  const create = () => {
    const name = (naming || "").trim();
    if (!name) return;
    const id = "new" + seq++;
    store.set((s) => ({ ...s, current: id, projects: [{ id, name, folder: "Documents/Bordeaux", opened: "Now" }, ...s.projects.map((x) => (x.id === s.current ? { ...x, opened: "Just now" } : x))] }));
    onClose();
  };

  // The sheet owns the keyboard while open: no keydown reaches the editor's window shortcuts, Tab cycles inside,
  // and list keys apply only in the search field so buttons keep native Enter/Space.
  const onKeyDown = (e) => {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); if (naming !== null) setNaming(null); else onClose(); return; }
    if (e.key === "Tab") { cycleFocus(e); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o") { e.preventDefault(); input.current?.focus(); return; }
    if (e.target !== input.current || e.nativeEvent.isComposing) return;
    if (naming !== null) { if (e.key === "Enter") { e.preventDefault(); create(); } return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(0, Math.min(list.length - 1, c + (e.key === "ArrowDown" ? 1 : -1)))); }
    else if (e.key === "Enter") { e.preventDefault(); const p = list[cursor]; if (p?.status) locate(p); else switchTo(p); }
  };
  const cycleFocus = (e) => {
    const items = [...sheet.current.querySelectorAll("input, button:not(:disabled)")];
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i === -1 || i === items.length - 1 ? 0 : i + 1);
    e.preventDefault();
    items[next].focus();
  };

  return (
    <div className="pj-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={sheet} tabIndex={-1} className="pj-sheet" role="dialog" aria-modal="true" aria-label={naming !== null ? "New project" : "Projects"} onKeyDown={onKeyDown}>
        {state.failed && naming === null && (
          <div className="pj-failed" role="alert">
            <span>Not saved · Folder is read-only</span>
            <button type="button" className="pj-link" onClick={retry}>Retry</button>
          </div>
        )}
        {naming === null ? (
          <>
            <input ref={input} className="pj-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find project"
              aria-label="Find project" role="combobox" aria-expanded="true" aria-controls="pj-list" aria-activedescendant={list[cursor] ? "pj-" + list[cursor].id : undefined} spellCheck={false} />
            <ul id="pj-list" className="pj-list" role="listbox" aria-label="Projects">
              {list.map((p, i) => (
                <li key={p.id} id={"pj-" + p.id} role="option" aria-selected={i === cursor} aria-disabled={Boolean(p.status) || undefined}
                  className="pj-row" data-cursor={i === cursor || undefined} data-current={p.id === state.current || undefined} data-status={p.status || undefined}
                  onPointerEnter={() => setCursor(i)} onClick={() => switchTo(p)}>
                  <span className="pj-check" aria-hidden="true">{p.id === state.current ? "✓" : ""}</span>
                  <span className="pj-row-text">
                    <span className="pj-row-name">{p.name}</span>
                    <span className="pj-row-folder">{p.folder}</span>
                  </span>
                  {p.status
                    ? <span className="pj-row-status">{p.status}<button type="button" className="pj-link" onClick={(e) => { e.stopPropagation(); locate(p); }}>Locate…</button></span>
                    : <span className="pj-row-when">{p.opened}</span>}
                </li>
              ))}
              {!list.length && <li className="pj-empty">No match</li>}
            </ul>
            <div className="pj-foot">
              <button type="button" className="pj-btn" onClick={() => setNaming("New project")}>New project</button>
              <span className="pj-sim">Simulated · paths stay the same</span>
            </div>
          </>
        ) : (
          <div className="pj-new">
            <label className="pj-new-label" htmlFor="pj-new-name">Name</label>
            <input id="pj-new-name" ref={input} className="pj-input" value={naming} onChange={(e) => setNaming(e.target.value)} spellCheck={false} />
            <div className="pj-foot">
              <span className="pj-sim">Documents/Bordeaux</span>
              <span className="pj-foot-actions">
                <button type="button" className="pj-btn quiet" onClick={() => setNaming(null)}>Cancel</button>
                <button type="button" className="pj-btn primary" onClick={create} disabled={!naming.trim()}>Create</button>
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// While the sheet is open the editor behind it is inert (no focus, no pointer), and a keydown that somehow targets
// anything outside the sheet (e.g. <body> after a focused node is removed) is swallowed and focus returns to the field.
// Layout effect so the editor is interactive again before close() returns focus to the chip.
function useModalOwnership(sheet, input) {
  useLayoutEffect(() => {
    const scrim = sheet.current.parentElement;
    const others = [...document.body.children].filter((el) => el !== scrim && !el.inert);
    others.forEach((el) => { el.inert = true; });
    const guard = (e) => {
      if (sheet.current?.contains(e.target)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      input.current?.focus();
    };
    window.addEventListener("keydown", guard, true);
    return () => {
      window.removeEventListener("keydown", guard, true);
      others.forEach((el) => { el.inert = false; });
    };
  }, [sheet, input]);
}
