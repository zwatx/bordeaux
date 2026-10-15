// Catalog popover anchored to a spot on the path: type to filter, Enter or click to place.
import { useEffect, useMemo, useRef, useState } from "react";
import { COMMANDS } from "../../core/project.js";

export function CommandPicker({ x, y, anchor, onPick, onClose }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const box = useRef(null);
  const input = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const back = document.activeElement;
    input.current?.focus({ preventScroll: true });
    // The pointer gesture that opened the picker may move focus after mount; take it back once.
    const refocus = setTimeout(() => input.current?.focus({ preventScroll: true }), 0);
    const away = (e) => { if (!box.current?.contains(e.target)) close.current(); };
    window.addEventListener("pointerdown", away, true);
    return () => {
      clearTimeout(refocus);
      window.removeEventListener("pointerdown", away, true);
      if (back && back.isConnected && back !== document.body) back.focus?.({ preventScroll: true });
    };
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? COMMANDS.filter((c) => c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)) : COMMANDS;
  }, [query]);
  useEffect(() => setActive(0), [query]);

  const origin = `${anchor.x - x}px ${anchor.y - y}px`;
  return (
    <div ref={box} className="wb-picker" style={{ left: x, top: y, transformOrigin: origin }} role="dialog" aria-label="Add command"
      onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
      <input ref={input} className="wb-picker-input" value={query} placeholder="Add command" aria-label="Filter commands" spellCheck={false}
        role="combobox" aria-expanded="true" aria-controls="wb-picker-list" aria-activedescendant={shown[active] ? "wb-pk-" + active : undefined}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(shown.length - 1, a + 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
          else if (e.key === "Enter") { e.preventDefault(); if (shown[active]) onPick(shown[active].id); }
          else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
        }} />
      <div className="wb-picker-list" id="wb-picker-list" role="listbox">
        {shown.map((c, i) => (
          <div key={c.id} id={"wb-pk-" + i} role="option" aria-selected={i === active} className="wb-picker-item"
            onPointerMove={() => { if (active !== i) setActive(i); }} onClick={() => onPick(c.id)}>{c.label}</div>
        ))}
        {!shown.length && <div className="wb-picker-empty">No match</div>}
      </div>
    </div>
  );
}
