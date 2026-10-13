// Small building blocks for the Canvas variant: icons, a scrubbable number field, dismiss handling.
import { useEffect, useId, useRef, useState } from "react";

// ---------- icons (one set, 1.5 stroke, 16px box) ----------
const Svg = ({ children, size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
export const Icon = {
  chevron: () => <Svg><path d="M4.5 6.5 8 10l3.5-3.5" /></Svg>,
  play: () => <Svg><path d="M5.5 3.8v8.4a.4.4 0 0 0 .6.34l6.6-4.2a.4.4 0 0 0 0-.68L6.1 3.46a.4.4 0 0 0-.6.34Z" fill="currentColor" stroke="none" /></Svg>,
  pause: () => <Svg><path d="M5.5 3.5v9M10.5 3.5v9" strokeWidth="2" /></Svg>,
  undo: () => <Svg><path d="M6 4 3 7l3 3" /><path d="M3.5 7H10a3 3 0 0 1 0 6H7.5" /></Svg>,
  redo: () => <Svg><path d="m10 4 3 3-3 3" /><path d="M12.5 7H6a3 3 0 0 0 0 6h2.5" /></Svg>,
  flag: () => <Svg><path d="M4.5 13.5v-10M4.5 3.5h7l-1.6 2.5 1.6 2.5h-7" /></Svg>,
  trash: () => <Svg><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.1a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.1" /></Svg>,
  search: () => <Svg><circle cx="7" cy="7" r="4" /><path d="m10 10 3 3" /></Svg>,
  check: () => <Svg><path d="m3.5 8.5 3 3 6-7" /></Svg>,
};

// ---------- formatting ----------
export const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "–");
export const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

// ---------- planning helpers (pure; never throw) ----------
/** Time (s) at which the robot first reaches path fraction f, from the shared timing. */
export function timeAtFraction(derived, f) {
  const samples = derived?.trajectorySamples;
  if (!samples?.length) return 0;
  let lo = 0, hi = samples.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (samples[mid].f < f) lo = mid + 1; else hi = mid; }
  return samples[lo].t || 0;
}

/** Peak planned speed between two fractions. */
export function peakSpeed(derived, f0, f1) {
  const pts = derived?.sample?.pts, v = derived?.metrics?.v;
  if (!pts?.length || !v?.length) return 0;
  const total = pts[pts.length - 1].s || 1;
  let peak = 0;
  for (let i = 0; i < pts.length; i++) { const f = pts[i].s / total; if (f >= f0 && f <= f1) peak = Math.max(peak, v[i] || 0); }
  return peak;
}

/** Closes a popover on outside pointerdown. */
export function useOutside(ref, open, onClose, ignore) {
  useEffect(() => {
    if (!open) return undefined;
    const down = (e) => {
      if (ref.current?.contains(e.target)) return;
      if (ignore?.current?.contains(e.target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, [ref, open, onClose, ignore]);
}

/** Escape closes an open popover, wherever focus is (inputs handle their own Escape first). */
export function useEscape(open, onClose) {
  useEffect(() => {
    if (!open) return undefined;
    const key = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, onClose]);
}

/** Stops field gestures from starting underneath floating UI. */
export const shield = {
  onPointerDown: (e) => e.stopPropagation(),
  onPointerMove: (e) => e.stopPropagation(),
  onDoubleClick: (e) => e.stopPropagation(),
  onWheel: (e) => e.stopPropagation(),
};

/**
 * Number you can type or scrub. `apply(value, phase)` is called with 'begin' | 'update' | 'end'
 * so a whole typing session or scrub becomes one undo step, and it re-times live.
 */
export function NumField({ label, value, unit, step = 0.1, decimals = 1, min = -Infinity, max = Infinity, apply, autoFocus, compact }) {
  const id = useId();
  const [draft, setDraft] = useState(null);
  const session = useRef(false);
  const scrub = useRef(null);
  const clamp = (v) => Math.min(max, Math.max(min, v));
  const round = (v) => Math.round(v / step) * step;

  const send = (v) => {
    apply(clamp(v), session.current ? "update" : "begin");
    session.current = true;
  };
  const finish = () => { if (session.current) { session.current = false; apply(null, "end"); } };

  const onChange = (e) => {
    const text = e.target.value;
    setDraft(text);
    const v = Number(text.replace(",", "."));
    if (text.trim() !== "" && Number.isFinite(v)) send(v);
  };
  const onKeyDown = (e) => {
    if (e.key === "Enter") { finish(); setDraft(null); e.currentTarget.select(); }
    else if (e.key === "Escape") { finish(); setDraft(null); e.currentTarget.blur(); e.stopPropagation(); }
    else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const delta = (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
      send(round((value || 0) + delta)); finish(); setDraft(null);
    }
  };

  const onScrubDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    scrub.current = { x: e.clientX, start: value || 0, moved: false };
  };
  const onScrubMove = (e) => {
    const s = scrub.current;
    if (!s) return;
    e.stopPropagation();
    const dx = e.clientX - s.x;
    if (!s.moved && Math.abs(dx) < 3) return;
    s.moved = true;
    send(round(s.start + Math.round(dx / 4) * step * (e.shiftKey ? 10 : 1)));
  };
  const onScrubUp = (e) => {
    const s = scrub.current;
    scrub.current = null;
    if (!s) return;
    if (s.moved) finish();
    else document.getElementById(id)?.focus();
    e.stopPropagation();
  };

  const shown = draft ?? (Number.isFinite(value) ? value.toFixed(decimals) : "");
  return (
    <div className={"cv-num" + (compact ? " compact" : "")}>
      <label htmlFor={id} className="cv-num-label" onPointerDown={onScrubDown} onPointerMove={onScrubMove} onPointerUp={onScrubUp} onPointerCancel={onScrubUp}>{label}</label>
      <span className="cv-num-box">
        <input id={id} className="cv-num-input num" inputMode="decimal" autoComplete="off" spellCheck={false} value={shown}
          autoFocus={autoFocus} onChange={onChange} onKeyDown={onKeyDown}
          onFocus={(e) => e.currentTarget.select()} onBlur={() => { finish(); setDraft(null); }}
          // First click selects the whole value, so typing replaces it.
          onMouseDown={(e) => { if (document.activeElement !== e.currentTarget) { e.preventDefault(); e.currentTarget.focus(); e.currentTarget.select(); } }} />
        {unit && <span className="cv-num-unit">{unit}</span>}
      </span>
    </div>
  );
}
