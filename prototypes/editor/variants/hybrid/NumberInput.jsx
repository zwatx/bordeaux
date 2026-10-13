// Labelled number: type to replace (the first click selects the value), arrows to step, or drag the label
// sideways to scrub. onChange(value, phase): 'commit' for typed/arrow edits, 'begin' | 'update' | 'end' for a
// scrub, so a scrub is one undo step, and 'cancel' (value null) to put the scrub's starting project back.
//
// One owner at a time. The typed draft is held in a ref as well as state, so Enter, Escape, an arrow, a scrub or a
// press elsewhere consumes it synchronously and the blur that follows finds nothing left to commit. A scrub starts
// from a valid draft (typed and scrubbed is still one undo step) and drops an invalid one. While the label holds
// the pointer it owns the keyboard: Enter waits for release, Escape restores the starting value, other keys wait.
import { useEffect, useId, useRef, useState } from "react";

const roundTo = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;
const MODIFIER_KEYS = new Set(["Shift", "Alt", "Meta", "Control", "CapsLock", "Fn"]);
/** An IME is composing: Enter confirms the composition, not the field. */
export const isComposing = (e) => Boolean(e.nativeEvent?.isComposing || e.isComposing || e.keyCode === 229);

/**
 * While a draft is pending, a press outside `rootRef` commits it before that press is handled, as its blur
 * would, but while the draft still edits the object it was typed for (a press can change the selection or path).
 */
export function useCommitBeforeOutsidePress(rootRef, pending, commit) {
  const latest = useRef(commit);
  latest.current = commit;
  useEffect(() => {
    if (!pending) return undefined;
    const onDown = (e) => { if (!rootRef.current?.contains(e.target)) latest.current(); };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [pending, rootRef]);
}

export function NumberInput({
  label, unit, value, onChange, step = 0.1, digits = 2, min = -Infinity, max = Infinity, wrap,
  placeholder, trailing, layout = "row", ariaLabel,
}) {
  const id = useId();
  const root = useRef(null);
  const input = useRef(null);
  const [draft, setDraftState] = useState(null);
  const draftRef = useRef(null);
  const gesture = useRef(null);
  const suppressClick = useRef(false);
  const latest = useRef(onChange);
  latest.current = onChange;

  const normalize = (v) => {
    if (wrap) { v = ((v % wrap) + wrap) % wrap; if (v > wrap / 2) v -= wrap; }
    return roundTo(Math.max(min, Math.min(max, v)), digits);
  };
  const parse = (text) => {
    if (text == null || String(text).trim() === "") return null;
    const v = Number(String(text).replace(",", ".").trim());
    return Number.isFinite(v) ? normalize(v) : null;
  };
  const shown = value == null || !Number.isFinite(value) ? "" : value.toFixed(digits);
  const setDraft = (text) => { draftRef.current = text; setDraftState(text); };
  const takeDraft = () => { const text = draftRef.current; if (text != null) setDraft(null); return text; };
  const commitDraft = () => {
    const next = parse(takeDraft());
    if (next != null && next !== value) onChange(next, "commit");
  };
  const reselect = (el) => requestAnimationFrame(() => { if (document.activeElement === el) el.select(); });
  const factor = (e) => (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
  useCommitBeforeOutsidePress(root, draft != null, commitDraft);

  // Ends the label press. 'end' keeps an active scrub (or drops it if it came back to where it began);
  // 'cancel' restores the starting project. Neither leaves listeners, capture or the scrub cursor behind.
  const finish = (phase) => {
    const g = gesture.current;
    if (!g) return null;
    gesture.current = null;
    window.removeEventListener("keydown", g.onKey, true);
    window.removeEventListener("blur", g.onWindowBlur);
    delete document.documentElement.dataset.hyScrub;
    try { if (g.el.hasPointerCapture(g.pointerId)) g.el.releasePointerCapture(g.pointerId); } catch { /* element gone */ }
    if (g.active) latest.current(null, phase === "end" && g.last !== g.origin ? "end" : "cancel");
    if (g.active || g.escaped) suppressClick.current = true;
    return g;
  };
  useEffect(() => () => { finish("cancel"); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onLabelDown = (e) => {
    suppressClick.current = false;
    if (e.button !== 0 || gesture.current) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const g = { el, pointerId: e.pointerId, x: e.clientX, active: false, enter: false, escaped: false };
    g.onKey = (k) => {
      if (MODIFIER_KEYS.has(k.key)) return; // Shift/Alt still change the scrub step; nothing else reaches the editor.
      k.preventDefault();
      k.stopImmediatePropagation();
      if (k.key === "Escape") { g.escaped = true; finish("cancel"); }
      else if (k.key === "Enter") g.enter = true;
    };
    g.onWindowBlur = () => finish("cancel");
    gesture.current = g;
    window.addEventListener("keydown", g.onKey, true);
    window.addEventListener("blur", g.onWindowBlur);
  };
  const onLabelMove = (e) => {
    const g = gesture.current;
    if (!g || e.pointerId !== g.pointerId) return;
    const dx = e.clientX - g.x;
    if (!g.active) {
      if (Math.abs(dx) < 3) return;
      // The scrub takes over the typed draft: a valid one is its starting value, an invalid one is dropped.
      const typed = parse(takeDraft());
      g.active = true;
      g.origin = value;
      g.base = typed ?? value ?? 0;
      g.last = normalize(g.base + Math.round(dx / 3) * step * factor(e));
      document.documentElement.dataset.hyScrub = "";
      onChange(g.last, "begin");
      return;
    }
    const next = normalize(g.base + Math.round(dx / 3) * step * factor(e));
    if (next !== g.last) { g.last = next; onChange(next, "update"); }
  };
  const onLabelUp = (e) => {
    const g = gesture.current;
    if (!g || e.pointerId !== g.pointerId) return;
    finish("end");
    if (g.active) return;
    // A plain press: Enter held during it now applies; the field gets focus with its value selected.
    if (g.enter) commitDraft();
    input.current?.focus();
    input.current?.select();
  };
  const onLabelLost = (e) => { if (gesture.current?.pointerId === e.pointerId) finish("cancel"); };

  return (
    <div ref={root} className={"hy-num hy-num-" + layout} data-empty={shown === "" ? "" : undefined}>
      {label && (
        <label className="hy-num-label" htmlFor={id} onPointerDown={onLabelDown} onPointerMove={onLabelMove} onPointerUp={onLabelUp}
          onPointerCancel={() => finish("cancel")} onLostPointerCapture={onLabelLost}
          onClick={(e) => { if (suppressClick.current) { e.preventDefault(); suppressClick.current = false; } }}>{label}</label>
      )}
      <span className="hy-num-box">
        <input ref={input} id={id} className="hy-num-input num" type="text" inputMode="decimal" spellCheck={false} autoComplete="off"
          aria-label={ariaLabel || (unit ? `${label}, ${unit}` : label)}
          value={draft ?? shown} placeholder={placeholder}
          onFocus={(e) => e.currentTarget.select()}
          // First click selects the whole value, so typing replaces it. A click in a focused field places the caret.
          onMouseDown={(e) => { if (document.activeElement !== e.currentTarget) { e.preventDefault(); e.currentTarget.focus(); e.currentTarget.select(); } }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (isComposing(e)) return;
            const el = e.currentTarget;
            if (e.key === "Enter") { e.preventDefault(); commitDraft(); reselect(el); }
            else if (e.key === "Escape") {
              // First Escape puts the stored value back and keeps focus; with nothing typed it leaves the field.
              e.preventDefault();
              if (takeDraft() != null) reselect(el); else el.blur();
            } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && draftRef.current != null) {
              // Undo first takes back the typing, which was never an edit; the next ⌘Z is the app's.
              e.preventDefault(); e.stopPropagation(); takeDraft(); reselect(el);
            } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              const next = normalize((parse(takeDraft()) ?? value ?? 0) + (e.key === "ArrowUp" ? 1 : -1) * step * factor(e));
              if (next !== value) onChange(next, "commit");
              reselect(el);
            }
          }} />
        {(unit || layout === "row") && <span className="hy-num-unit" aria-hidden="true">{unit}</span>}
      </span>
      {trailing !== undefined && <span className="hy-num-trailing">{trailing}</span>}
    </div>
  );
}
