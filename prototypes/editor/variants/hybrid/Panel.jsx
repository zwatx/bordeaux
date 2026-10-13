// Docked property panel under the field: the selected object's numbers, always editable in place.
// Path (nothing selected), Point, Command, Zone, or Problem. Plain labels; no explanatory text.
import { useEffect, useId, useRef, useState } from "react";
import { setWaypointFacing } from "../../../../src/renderer/lib/pathEditing";
import { setWaypointStop } from "../../core/editing.js";
import { FIELD_H, FIELD_W } from "../../core/Field.jsx";
import { COMMANDS } from "../../core/project.js";
import { fAtT, fmt, tAtF } from "../strip/timeline.js";
import { Icon } from "./Icon.jsx";
import { NumberInput, isComposing, useCommitBeforeOutsidePress } from "./NumberInput.jsx";
import { commandDef, markerLabel } from "./labels.js";
import { plainProblem } from "./problems.js";

export function Panel({ path, sel, tl, issues, issuesStale, edit, select, onDelete, onAddZone, onFix, robot }) {
  let title = "Path", sub = null, body = null, del = null;
  const set = (fn) => (value, phase) => edit((p) => { if (value != null) fn(p, value); return p; }, phase);
  const n = path.waypoints.length;

  if (sel?.kind === "waypoint") {
    const i = sel.index, w = path.waypoints[i];
    const isEnd = i === 0 || i === n - 1;
    title = i === 0 ? "Start" : i === n - 1 ? "End" : `Point ${i + 1}`;
    sub = `${fmt(tAtF(tl, tl.wpFrac?.[i] ?? 0))} s`;
    del = n > 2 ? "Delete point" : null;
    body = <>
      {!isEnd && (
        <div className="hy-row">
          <Toggle label="Stop here" checked={Boolean(w.stop)} onChange={() => edit((p) => setWaypointStop(p, i, !p.waypoints[i]?.stop))} />
        </div>
      )}
      {w.stop && !isEnd && <NumberInput label="Wait" unit="s" value={w.wait || 0} step={0.1} digits={1} min={0} max={15} onChange={set((p, v) => { p.waypoints[i].wait = v; })} />}
      <NumberInput label="Heading" unit={w.thetaOn ? "°" : ""} value={w.thetaOn ? w.theta : null} placeholder="Free" step={1} digits={0} wrap={360}
        onChange={(v, phase) => edit((p) => (v == null ? p : setWaypointFacing(p, i, v)), phase)}
        trailing={w.thetaOn && !isEnd
          ? <button type="button" className="hy-mini" onClick={() => edit((p) => { p.waypoints[i].thetaOn = false; return p; })} aria-label="Free heading" title="Free · H"><Icon name="x" /></button>
          : null} />
      <NumberInput label="X" unit="m" value={w.x} step={0.01} digits={2} min={0} max={FIELD_W}
        onChange={set((p, v) => { const q = p.waypoints[i], d = v - q.x; q.x = v; if (q.prevC) q.prevC.x += d; if (q.nextC) q.nextC.x += d; })} />
      <NumberInput label="Y" unit="m" value={w.y} step={0.01} digits={2} min={0} max={FIELD_H}
        onChange={set((p, v) => { const q = p.waypoints[i], d = v - q.y; q.y = v; if (q.prevC) q.prevC.y += d; if (q.nextC) q.nextC.y += d; })} />
    </>;
  } else if (sel?.kind === "command") {
    const m = path.markers.find((x) => x.id === sel.id);
    const def = commandDef(m.invocation?.commandId || m.cmd);
    const t = tAtF(tl, m.f);
    title = "Command";
    del = "Delete command";
    body = <>
      <CommandSelect value={def?.id || ""} label={markerLabel(m)}
        onChange={(id) => {
          const nd = commandDef(id);
          edit((p) => { const q = p.markers.find((x) => x.id === sel.id); q.name = id; q.cmd = id; q.invocation = { commandId: id, arguments: Object.fromEntries((nd?.parameters || []).map((a) => [a.name, a.default])) }; return p; });
        }} />
      <NumberInput label="At" unit="s" value={Number(t.toFixed(2))} step={0.05} digits={2} min={0} max={tl.total}
        onChange={set((p, v) => { const q = p.markers.find((x) => x.id === sel.id); if (q) q.f = Math.round(fAtT(tl, v) * 1000) / 1000; })} />
      {(def?.parameters || []).map((prm) => (
        <NumberInput key={prm.name} label={prm.label} value={m.invocation?.arguments?.[prm.name] ?? prm.default} step={prm.default >= 100 ? 50 : 1} digits={0} min={0}
          onChange={set((p, v) => { const q = p.markers.find((x) => x.id === sel.id); q.invocation = { ...q.invocation, arguments: { ...q.invocation.arguments, [prm.name]: v } }; })} />
      ))}
    </>;
  } else if (sel?.kind === "zone") {
    const i = sel.index, r = path.ranges[i];
    title = r.name || "Zone";
    del = "Delete zone";
    body = <>
      <TextRow label="Name" value={r.name || ""} onCommit={(v) => edit((p) => { p.ranges[i].name = v; return p; })} />
      <NumberInput label="Speed" unit="m/s" value={r.maxVel ?? path.constraints.maxVel} step={0.05} digits={2} min={0.05} max={robot.maxSpeed}
        onChange={set((p, v) => { p.ranges[i].maxVel = v; })} />
      <NumberInput label="From" unit="s" value={Number(tAtF(tl, Math.min(r.f0, r.f1)).toFixed(2))} step={0.05} digits={2} min={0} max={tl.total}
        onChange={set((p, v) => { const q = p.ranges[i]; q.f0 = Math.min(Math.round(fAtT(tl, v) * 1000) / 1000, q.f1 - 0.01); })} />
      <NumberInput label="To" unit="s" value={Number(tAtF(tl, Math.max(r.f0, r.f1)).toFixed(2))} step={0.05} digits={2} min={0} max={tl.total}
        onChange={set((p, v) => { const q = p.ranges[i]; q.f1 = Math.max(Math.round(fAtT(tl, v) * 1000) / 1000, q.f0 + 0.01); })} />
    </>;
  } else if (sel?.kind === "issue" && issues[sel.index]) {
    const issue = issues[sel.index];
    const plain = plainProblem(issue, n);
    title = plain.text;
    const t0 = tAtF(tl, issue.f0), t1 = tAtF(tl, issue.f1);
    sub = issue.f1 - issue.f0 < 0.999 ? (t1 - t0 > 0.02 ? `${fmt(t0)}–${fmt(t1)} s` : `${fmt(t0)} s`) : null;
    body = <div className={"hy-problem " + issue.severity}>
      {issuesStale && <p className="hy-problem-line hy-updating">Updating…</p>}
      {plain.where && <p className="hy-problem-line">{plain.where}</p>}
      {plain.values && <p className="hy-problem-line num">{plain.values}</p>}
      {plain.by && <p className="hy-problem-line">Limit: {plain.by}</p>}
      {plain.fixable && <button type="button" className="hy-btn" onClick={() => onFix(issue)}>Slow here</button>}
      {plain.engine && <Details text={plain.engine} />}
    </div>;
  } else {
    const c = path.constraints;
    body = <>
      <TextRow label="Name" value={path.name} multiline onCommit={(v) => { const name = v.trim(); if (name && name !== path.name) edit((p) => { p.name = name; return p; }); }} />
      <NumberInput label="Braking" unit="m/s²" value={c.maxDecel ?? c.maxAccel} step={0.1} digits={1} min={0.1} max={60} onChange={set((p, v) => { p.constraints.maxDecel = v; })} />
      <NumberInput label="Turn speed" unit="°/s" value={c.maxAngVel} step={5} digits={0} min={1} max={2000} onChange={set((p, v) => { p.constraints.maxAngVel = v; })} />
      <NumberInput label="End speed" unit="m/s" value={path.goalVel ?? 0} step={0.05} digits={2} min={0} max={robot.maxSpeed} onChange={set((p, v) => { p.goalVel = v; })} />
      <div className="hy-row hy-row-actions"><button type="button" className="hy-btn" onClick={onAddZone}>Add zone</button></div>
    </>;
  }

  return (
    <aside className="hy-panel" aria-label="Properties">
      <div className="hy-panel-head">
        <span className="hy-panel-title">{title}</span>
        {sub && <span className="hy-panel-sub num">{sub}</span>}
        {sel && <button type="button" className="hy-mini hy-panel-close" onClick={() => select(null)} aria-label="Deselect" title="Esc"><Icon name="x" /></button>}
      </div>
      {/* Keyed by what the fields edit, so a draft or scrub never carries over to another object or path. */}
      <div className="hy-panel-body" key={path.id + "|" + (sel ? `${sel.kind}:${sel.index ?? sel.id}` : "path")}>{body}</div>
      {del && <div className="hy-panel-foot"><button type="button" className="hy-quiet hy-danger" onClick={onDelete}>{del}<kbd>⌫</kbd></button></div>}
    </aside>
  );
}

function Toggle({ label, checked, onChange }) {
  const id = useId();
  return <>
    <label className="hy-row-label" htmlFor={id}>{label}</label>
    <button id={id} type="button" role="switch" aria-checked={checked} className="hy-switch" onClick={onChange}><span className="hy-switch-knob" aria-hidden="true" /></button>
  </>;
}

function CommandSelect({ value, onChange }) {
  const id = useId();
  return (
    <div className="hy-row hy-row-full">
      <label className="hy-sr" htmlFor={id}>Command</label>
      <select id={id} className="hy-select" value={value} onChange={(e) => onChange(e.target.value)}>
        {COMMANDS.map((cd) => <option key={cd.id} value={cd.id}>{cd.label}</option>)}
      </select>
    </div>
  );
}

// Same draft ownership as NumberInput: Enter, Escape or a press elsewhere consumes the draft before blur.
function TextRow({ label, value, onCommit, multiline = false }) {
  const id = useId();
  const [draft, setDraftState] = useState(null);
  const draftRef = useRef(null);
  const row = useRef(null);
  const ref = useRef(null);
  const setDraft = (text) => { draftRef.current = text; setDraftState(text); };
  const takeDraft = () => { const text = draftRef.current; if (text != null) setDraft(null); return text; };
  const commit = () => { const text = takeDraft(); if (text != null && text !== value) onCommit(text); };
  useCommitBeforeOutsidePress(row, draft != null, commit);
  useEffect(() => {
    if (!multiline || !ref.current) return;
    ref.current.style.height = "auto";
    ref.current.style.height = ref.current.scrollHeight + "px";
  }, [multiline, draft, value]);
  const Tag = multiline ? "textarea" : "input";
  return (
    <div ref={row} className={"hy-row hy-text-row" + (multiline ? " multi" : "")}>
      <label className="hy-row-label" htmlFor={id}>{label}</label>
      <Tag ref={ref} id={id} className="hy-text" rows={multiline ? 1 : undefined} spellCheck={false} autoComplete="off" value={draft ?? value}
        onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => {
          if (isComposing(e)) return;
          const el = e.currentTarget;
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); el.blur(); }
          else if (e.key === "Escape") {
            e.preventDefault();
            if (takeDraft() != null) requestAnimationFrame(() => { if (document.activeElement === el) el.select(); });
            else el.blur();
          }
        }} />
    </div>
  );
}

function Details({ text }) {
  const [open, setOpen] = useState(false);
  return <div className="hy-details">
    <button type="button" className="hy-disclosure" aria-expanded={open} onClick={() => setOpen((o) => !o)}><Icon name="chev" className={open ? "open" : ""} />Details</button>
    {open && <p className="hy-problem-engine num">{text}</p>}
  </div>;
}
