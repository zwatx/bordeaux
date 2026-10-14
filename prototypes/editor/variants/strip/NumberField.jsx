// Number input with a scrubbable label: drag the label sideways, or type. One undo step per scrub.
import { useId, useRef, useState } from "react";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * onChange(value, phase): phase is 'commit' for typed/arrow edits, or 'begin' | 'update' | 'end' for a label scrub.
 */
export function NumberField({ label, value, unit, step = 0.1, min = -Infinity, max = Infinity, digits = 2, onChange, width = 5, className = "", ariaLabel }) {
  const id = useId();
  const [draft, setDraftState] = useState(null);
  const draftRef = useRef(null);
  const setDraft = (v) => { draftRef.current = v; setDraftState(v); };
  const scrub = useRef(null);
  const shown = draft ?? (Number.isFinite(value) ? value.toFixed(digits) : "");
  const round = (v) => Number(clamp(v, min, max).toFixed(digits));

  const commit = () => {
    const text = draftRef.current;
    if (text == null) return;
    const parsed = Number.parseFloat(text.replace(",", "."));
    setDraft(null);
    if (Number.isFinite(parsed) && round(parsed) !== value) onChange(round(parsed), "commit");
  };

  const onLabelDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    scrub.current = { x: e.clientX, start: value, active: false };
  };
  const onLabelMove = (e) => {
    const s = scrub.current;
    if (!s) return;
    const dx = e.clientX - s.x;
    if (!s.active && Math.abs(dx) < 3) return;
    const fine = e.altKey ? 0.1 : e.shiftKey ? 10 : 1;
    const next = round(s.start + Math.round(dx / 4) * step * fine);
    onChange(next, s.active ? "update" : "begin");
    s.active = true;
  };
  const onLabelUp = (e) => {
    const s = scrub.current;
    scrub.current = null;
    if (!s) return;
    if (s.active) onChange(value, "end");
    else document.getElementById(id)?.focus();
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  return (
    <span className={"strip-num " + className}>
      {label && <label htmlFor={id} className="strip-num-label" onPointerDown={onLabelDown} onPointerMove={onLabelMove} onPointerUp={onLabelUp} onPointerCancel={onLabelUp}>{label}</label>}
      <span className="strip-num-box">
        <input
          id={id}
          aria-label={ariaLabel || (unit ? `${label}, ${unit}` : label)}
          className="strip-num-input num"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          size={width}
          value={shown}
          onFocus={(e) => { setDraft(shown); requestAnimationFrame(() => e.target.select()); }}
          // First click selects the whole value, so typing replaces it.
          onMouseDown={(e) => { if (document.activeElement !== e.currentTarget) { e.preventDefault(); e.currentTarget.focus(); e.currentTarget.select(); } }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") { commit(); e.currentTarget.blur(); }
            else if (e.key === "Escape") { setDraft(null); e.currentTarget.blur(); e.stopPropagation(); }
            else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              const base = Number.parseFloat(draft ?? "") ;
              const from = Number.isFinite(base) ? base : value;
              const next = round(from + (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1));
              setDraft(next.toFixed(digits));
              onChange(next, "commit");
            }
          }}
        />
        {unit && <span className="strip-num-unit" aria-hidden="true">{unit}</span>}
      </span>
    </span>
  );
}
