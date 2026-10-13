// Command catalog anchored at a place on the path or the command lane: type to filter, ↑↓ and Enter, or click.
// Closes on Escape or an outside press and returns focus to whatever opened it.
import { useEffect, useMemo, useRef, useState } from "react";
import { COMMANDS } from "../../core/project.js";

export function CommandMenu({ x, y, side = "below", title, onPick, onClose }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const box = useRef(null);
  const input = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const back = document.activeElement;
    input.current?.focus({ preventScroll: true });
    // The pointer gesture that opened the menu may move focus after mount; take it back once.
    const refocus = setTimeout(() => input.current?.focus({ preventScroll: true }), 0);
    const away = (e) => { if (!box.current?.contains(e.target)) close.current("outside"); };
    window.addEventListener("pointerdown", away, true);
    return () => {
      clearTimeout(refocus);
      window.removeEventListener("pointerdown", away, true);
      if (back && back.isConnected && back !== document.body) back.focus?.({ preventScroll: true });
    };
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return COMMANDS;
    const rank = (c) => { const l = c.label.toLowerCase(); return l.startsWith(q) ? 0 : l.split(/\s+/).some((w) => w.startsWith(q)) ? 1 : 2; };
    return COMMANDS.filter((c) => c.label.toLowerCase().includes(q)).sort((a, b) => rank(a) - rank(b));
  }, [query]);
  useEffect(() => setActive(0), [query]);

  return (
    <div ref={box} className="hy-menu" data-side={side} style={{ left: x, top: y }} role="dialog" aria-label="Add command"
      onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      {title && <div className="hy-menu-title num">{title}</div>}
      <input ref={input} className="hy-menu-input" value={query} placeholder="Command" aria-label="Find command" spellCheck={false}
        role="combobox" aria-expanded="true" aria-controls="hy-menu-list" aria-activedescendant={shown[active] ? "hy-mi-" + active : undefined}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(shown.length - 1, a + 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
          else if (e.key === "Enter") { e.preventDefault(); if (shown[active]) onPick(shown[active].id); }
          else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose("escape"); }
        }} />
      <div className="hy-menu-list" id="hy-menu-list" role="listbox" aria-label="Commands">
        {shown.map((c, i) => (
          <div key={c.id} id={"hy-mi-" + i} role="option" aria-selected={i === active} className="hy-menu-item"
            onPointerMove={() => { if (active !== i) setActive(i); }} onClick={() => onPick(c.id)}>
            <span className="hy-diamond" aria-hidden="true" />{c.label}
          </div>
        ))}
        {!shown.length && <div className="hy-menu-empty">No match</div>}
      </div>
    </div>
  );
}
