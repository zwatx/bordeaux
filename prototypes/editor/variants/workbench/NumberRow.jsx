// Plain labelled number row: type a value, or drag the label to scrub it. One undo step per scrub.
import { useId, useRef, useState } from "react";

const round = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;

export function NumberRow({ label, unit, value, placeholder, step = 0.1, digits = 2, min = -Infinity, max = Infinity, wrap, onChange, trailing }) {
  const id = useId();
  const input = useRef(null);
  const [draft, setDraft] = useState(null);
  const scrub = useRef(null);
  const justScrubbed = useRef(false);

  const normalize = (v) => {
    if (wrap) { v = ((v % wrap) + wrap) % wrap; if (v > wrap / 2) v -= wrap; }
    return round(Math.max(min, Math.min(max, v)), digits);
  };
  const shown = value == null || !Number.isFinite(value) ? "" : value.toFixed(digits);
  const commit = (text) => {
    setDraft(null);
    const v = Number(String(text).replace(",", ".").trim());
    if (String(text).trim() === "" || !Number.isFinite(v)) return;
    const next = normalize(v);
    if (next !== value) onChange(next, "commit");
  };
  const factor = (e) => (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);

  const onLabelDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    scrub.current = { x: e.clientX, start: value ?? 0, active: false };
  };
  const onLabelMove = (e) => {
    const s = scrub.current;
    if (!s) return;
    const dx = e.clientX - s.x;
    if (!s.active && Math.abs(dx) < 3) return;
    const next = normalize(s.start + Math.round(dx / 3) * step * factor(e));
    if (!s.active) { s.active = true; document.documentElement.dataset.wbScrub = ""; onChange(next, "begin"); }
    else onChange(next, "update");
  };
  const onLabelUp = () => {
    const s = scrub.current;
    scrub.current = null;
    delete document.documentElement.dataset.wbScrub;
    if (!s) return;
    if (s.active) { onChange(null, "end"); justScrubbed.current = true; }
    else { input.current?.focus(); input.current?.select(); }
  };

  return (
    <div className="wb-row-line wb-num" data-empty={shown === "" ? "" : undefined}>
      <label className="wb-label wb-scrubbable" htmlFor={id} onPointerDown={onLabelDown} onPointerMove={onLabelMove} onPointerUp={onLabelUp} onPointerCancel={onLabelUp}
        onClick={(e) => { if (justScrubbed.current) { e.preventDefault(); justScrubbed.current = false; } }}>{label}</label>
      <span className="wb-num-field">
        <input ref={input} id={id} className="wb-num-input num" type="text" inputMode="decimal" spellCheck={false} autoComplete="off"
          value={draft ?? shown} placeholder={placeholder}
          onFocus={(e) => e.currentTarget.select()}
          // First click selects the whole value, so typing replaces it.
          onMouseDown={(e) => { if (document.activeElement !== e.currentTarget) { e.preventDefault(); e.currentTarget.focus(); e.currentTarget.select(); } }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { if (draft != null) commit(draft); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); if (draft != null) commit(draft); const el = e.currentTarget; requestAnimationFrame(() => el.select()); }
            else if (e.key === "Escape") { e.preventDefault(); setDraft(null); e.currentTarget.blur(); }
            else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              const base = draft != null && Number.isFinite(Number(draft)) ? Number(draft) : value ?? 0;
              setDraft(null);
              onChange(normalize(base + (e.key === "ArrowUp" ? 1 : -1) * step * factor(e)), "commit");
            }
          }} />
        <span className="wb-unit-cell" aria-hidden="true">{unit}</span>
      </span>
      <span className="wb-trailing">{trailing}</span>
    </div>
  );
}

export function Switch({ id, checked, onChange }) {
  return (
    <button id={id} type="button" role="switch" aria-checked={checked} className="wb-switch" onClick={onChange}>
      <span className="wb-switch-knob" aria-hidden="true" />
    </button>
  );
}

/** Read-only number aligned with editable rows. */
export function ReadRow({ label, value, unit, className = "" }) {
  return (
    <div className={"wb-row-line wb-num wb-readonly " + className}>
      <span className="wb-label">{label}</span>
      <span className="wb-num-field"><span className="wb-num-input wb-num-ro num">{value}</span><span className="wb-unit-cell">{unit}</span></span>
    </div>
  );
}
