// Small shared pieces: icons, the command catalog, and an anchored popover shell.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { COMMANDS } from "../../core/project";

const svg = (d, extra = {}) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...extra}>{d}</svg>
);
export const Icon = {
  undo: () => svg(<><path d="M5.5 3.5 2.5 6.5l3 3" /><path d="M2.5 6.5h7a4 4 0 0 1 0 8H7" /></>),
  redo: () => svg(<><path d="m10.5 3.5 3 3-3 3" /><path d="M13.5 6.5h-7a4 4 0 0 0 0 8H9" /></>),
  play: () => svg(<path d="M5 3.2v9.6a.5.5 0 0 0 .76.43l7.6-4.8a.5.5 0 0 0 0-.86l-7.6-4.8A.5.5 0 0 0 5 3.2Z" fill="currentColor" stroke="none" />),
  pause: () => svg(<><rect x="4" y="3" width="2.6" height="10" rx="0.8" fill="currentColor" stroke="none" /><rect x="9.4" y="3" width="2.6" height="10" rx="0.8" fill="currentColor" stroke="none" /></>),
  trash: () => svg(<><path d="M3 4.5h10" /><path d="M6.5 4.5V3h3v1.5" /><path d="M4.5 4.5 5 13h6l.5-8.5" /></>),
  chevron: () => svg(<path d="m4.5 6.5 3.5 3.5 3.5-3.5" />),
  check: () => svg(<path d="m3.5 8.5 3 3 6-7" />),
  close: () => svg(<path d="m4.5 4.5 7 7m0-7-7 7" />),
};

export const commandLabel = (idValue) => COMMANDS.find((c) => c.id === idValue)?.label || idValue || "Command";
export const markerLabel = (m) => commandLabel(m?.invocation?.commandId || m?.name);

/** Closes on outside pointerdown and Escape. Returns focus to `returnFocus` when it closes via keyboard. */
export function useDismiss(ref, onClose, enabled = true) {
  useEffect(() => {
    if (!enabled) return undefined;
    const down = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose("outside"); };
    const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); onClose("escape"); } };
    document.addEventListener("pointerdown", down, true);
    ref.current?.addEventListener("keydown", key);
    const node = ref.current;
    return () => { document.removeEventListener("pointerdown", down, true); node?.removeEventListener("keydown", key); };
  }, [ref, onClose, enabled]);
}

/**
 * Popover positioned at an anchor point (in the coordinate space of its offset parent).
 * side: 'above' | 'below'. Keeps itself inside `bounds` horizontally.
 */
export function Popover({ x, y, side = "below", bounds, className = "", children, label, onPointerDown, innerRef }) {
  const ref = useRef(null);
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const lo = (bounds?.left ?? 8), hi = (bounds?.right ?? window.innerWidth - 8);
    let left = x - w / 2;
    if (left < lo) left = lo;
    if (left + w > hi) left = hi - w;
    setShift(left - (x - w / 2));
  });
  return (
    <div
      ref={(node) => { ref.current = node; if (innerRef) innerRef.current = node; }}
      role="dialog"
      aria-label={label}
      className={"strip-pop " + className}
      data-side={side}
      style={{ left: x, top: y, "--shift": shift + "px", "--origin": `calc(50% - ${shift}px)` }}
      onPointerDown={(e) => { e.stopPropagation(); onPointerDown?.(e); }}
      onWheel={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

/** Command catalog list with type-to-filter. `onPick(commandId)`; `current` marks the selected one. */
export function Catalog({ onPick, current, autoFocus = true }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef(null);
  const q = query.trim().toLowerCase();
  // Prefix matches first ("shoot" → Shoot before Spin up shooter), then word and substring matches.
  const rank = (label) => { const l = label.toLowerCase(); return l.startsWith(q) ? 0 : l.split(/\s+/).some((w) => w.startsWith(q)) ? 1 : 2; };
  const items = COMMANDS.filter((c) => c.label.toLowerCase().includes(q)).sort((a, b) => rank(a.label) - rank(b.label));
  useEffect(() => { if (autoFocus) input.current?.focus(); }, [autoFocus]);
  useEffect(() => { setActive(0); }, [query]);
  return (
    <div className="strip-catalog">
      <input
        ref={input}
        className="strip-catalog-filter"
        placeholder="Command"
        aria-label="Find command"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); }
          if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
          if (e.key === "Enter" && items[active]) { e.preventDefault(); onPick(items[active].id); }
        }}
      />
      <ul className="strip-catalog-list" role="listbox" aria-label="Commands">
        {items.map((c, i) => (
          <li key={c.id} role="option" aria-selected={i === active}>
            <button
              type="button"
              className="strip-catalog-item"
              data-active={i === active ? "" : undefined}
              data-current={c.id === current ? "" : undefined}
              onPointerEnter={() => setActive(i)}
              onClick={() => onPick(c.id)}
            >
              <span className="strip-diamond" aria-hidden="true" />
              <span className="strip-catalog-name">{c.label}</span>
              {c.id === current && <span className="strip-catalog-check"><Icon.check /></span>}
            </button>
          </li>
        ))}
        {!items.length && <li className="strip-catalog-empty">No match</li>}
      </ul>
    </div>
  );
}
