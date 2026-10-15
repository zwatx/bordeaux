// Strip: two linked editing surfaces. The field (space) on top, the path strip (time) docked below.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { removeWaypoint, setWaypointFacing } from "../../../../src/renderer/lib/pathEditing";
import { setWaypointStop } from "../../core/editing.js";
import { Field } from "../../core/Field";
import { COMMANDS } from "../../core/project";
import { useEditorKeys, usePlan, usePlayback, useProjectState, usePush } from "../../core/state";
import { useOtherPlans } from "../../core/otherPlans";
import { NumberField } from "./NumberField";
import { PathStrip } from "./PathStrip";
import { Catalog, Icon, Popover, markerLabel, useDismiss } from "./parts";
import { TabRow } from "./TabRow";
import { buildTimeline, fAtT, peakBetween, tAtF } from "./timeline";
import "./strip.css";

const TOP_INSET = 60;

let seq = 1;
const newCommandId = () => `cmd-strip-${Date.now().toString(36)}-${seq++}`;

export function Strip() {
  const store = useProjectState();
  const { project, activePath: path, edit } = store;
  const robot = project.robot;
  const plan = usePlan(path, robot, project.field);
  // Timing arrives from the planner worker. Until it does, keep drawing the last timing for this path.
  const fresh = useMemo(() => buildTimeline(plan.derived), [plan.derived]);
  const lastTl = useRef(null);
  if (!fresh.empty) lastTl.current = { tl: fresh, pathId: path.id, derived: plan.derived };
  const held = fresh.empty && lastTl.current?.pathId === path.id ? lastTl.current.tl : null;
  const tl = useMemo(() => (held ? { ...held, wpFrac: fresh.wpFrac } : fresh), [held, fresh]);
  // The field keeps its speed colors and playback robot from the last timing too, instead of flashing.
  const fieldDerived = useMemo(() => {
    const last = held ? lastTl.current?.derived : null;
    return last ? { ...plan.derived, metrics: last.metrics, prof: last.prof, trajectorySamples: last.trajectorySamples } : plan.derived;
  }, [plan.derived, held]);
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (plan.status !== "pending") { setStale(false); return undefined; }
    const timer = setTimeout(() => setStale(true), 450);
    return () => clearTimeout(timer);
  }, [plan.status, plan.derived]);
  const issues = useMemo(() => plan.issues.map((i) => ({ ...i, whole: i.whole || (i.f0 <= 0.001 && i.f1 >= 0.999) })), [plan.issues]);
  const playback = usePlayback(tl.total);
  const push = usePush(project);

  const [selection, setSelectionRaw] = useState(null);
  const [hover, setHover] = useState(null); // { t, src: 'strip' | 'field', command? }
  const [placing, setPlacing] = useState(null); // field placement: { f }
  const [alt, setAlt] = useState(false);
  const [errors, setErrors] = useState({});
  const apiRef = useRef(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const setSelection = useCallback((s) => { setSelectionRaw(s); setPlacing(null); }, []);

  // Remember which paths have a hard problem so push can hold them back.
  useEffect(() => {
    if (plan.status === "pending") return;
    const hard = issues.find((i) => i.severity === "error");
    setErrors((prev) => {
      const next = { ...prev };
      if (hard) next[path.id] = hard.message; else delete next[path.id];
      return prev[path.id] === next[path.id] ? prev : next;
    });
  }, [plan.status, issues, path.id]);

  // Other paths are timed by the same planner in the background; nothing shown is from a second model.
  const otherPlans = useOtherPlans(project.paths, path.id, robot, project.field);
  const times = useMemo(() => Object.fromEntries(project.paths.map((p) => [p.id, p.id === path.id ? tl.total : otherPlans[p.id]?.totalTime ?? NaN])), [project.paths, path.id, tl.total, otherPlans]);
  const allErrors = useMemo(() => {
    const out = {};
    project.paths.forEach((p) => { if (p.id !== path.id && otherPlans[p.id]?.error) out[p.id] = otherPlans[p.id].error; });
    if (errors[path.id]) out[path.id] = errors[path.id];
    return out;
  }, [project.paths, path.id, otherPlans, errors]);

  const pick = useCallback((id) => {
    store.setActiveId(id);
    setSelection(null);
    setHover(null);
    playback.seek(0);
  }, [store.setActiveId, setSelection, playback.seek]); // eslint-disable-line react-hooks/exhaustive-deps

  const doPush = useCallback(() => {
    if (push.phase === "sending") return;
    const blockedIds = Object.keys(allErrors);
    if (!push.changedIds.some((id) => !blockedIds.includes(id))) return;
    push.push(push.changedIds, { blockedIds });
  }, [push, allErrors]);

  // Zone delete (core keys only cover waypoints and commands). Registered first so it sees the selection.
  useEffect(() => {
    const onKey = (e) => {
      if (e.target?.closest?.("input,textarea,select,[contenteditable=true]")) return;
      const sel = selectionRef.current;
      if ((e.key === "Delete" || e.key === "Backspace") && sel?.kind === "zone") {
        e.preventDefault();
        edit((p) => { p.ranges.splice(sel.index, 1); return p; });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [edit]);
  useEditorKeys({ selection, setSelection, edit, undo: store.undo, redo: store.redo, togglePlay: playback.toggle, onPush: doPush });

  // Fit the field to its real size, and refit on resize (the core fits once, before it has measured).
  const fieldRef = useRef(null);
  useEffect(() => {
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { raf = requestAnimationFrame(() => apiRef.current?.fit()); });
    });
    ro.observe(fieldRef.current);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, []);

  // Hold ⌥ to place commands on the field.
  useEffect(() => {
    const down = (e) => { if (e.key === "Alt") setAlt(true); };
    const up = (e) => { if (e.key === "Alt") setAlt(false); };
    const blur = () => setAlt(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", blur); };
  }, []);

  // ---------- edits ----------
  const addCommand = (f, commandId) => {
    const def = COMMANDS.find((c) => c.id === commandId);
    const args = Object.fromEntries((def?.parameters || []).map((p) => [p.name, p.default]));
    const id = newCommandId();
    edit((p) => { p.markers = [...(p.markers || []), { id, f: Math.round(f * 1000) / 1000, name: commandId, cmd: commandId, anchor: "param", invocation: { commandId, arguments: args } }]; return p; });
    return id;
  };
  const setCommand = (id, commandId) => {
    const def = COMMANDS.find((c) => c.id === commandId);
    const args = Object.fromEntries((def?.parameters || []).map((p) => [p.name, p.default]));
    edit((p) => { const m = p.markers.find((q) => q.id === id); if (m) { m.name = commandId; m.cmd = commandId; m.invocation = { commandId, arguments: args }; } return p; });
  };
  const deleteCommand = (id) => { edit((p) => { p.markers = p.markers.filter((m) => m.id !== id); return p; }); setSelection(null); };
  const deleteZone = (index) => { edit((p) => { p.ranges.splice(index, 1); return p; }); setSelection(null); };
  const fixIssue = (issue) => {
    const peak = peakBetween(tl, issue.f0, issue.f1) || path.constraints.maxVel;
    const cap = Math.max(0.3, Math.round(peak * 0.7 * 20) / 20);
    let index = 0;
    edit((p) => { p.ranges = [...(p.ranges || []), { anchor: "param", f0: issue.f0, f1: issue.f1, maxVel: cap, name: "Slow" }]; index = p.ranges.length - 1; return p; });
    setTimeout(() => setSelection({ kind: "zone", index }), 0);
  };

  // Field hover -> strip time.
  const onFieldMove = (e) => {
    const api = apiRef.current;
    const pts = plan.derived?.sample?.pts;
    if (!api || !pts?.length) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const near = (q, radius) => (q.x - px) ** 2 + (q.y - py) ** 2 < radius * radius;
    // Commands and points first, so the strip can light up the matching chip or tick.
    const marker = (path.markers || []).find((m) => near(api.pointAt(m.f), 12));
    if (marker) { setHover({ t: tAtF(tl, marker.f), src: "field", command: marker.id }); return; }
    const wpIndex = path.waypoints.findIndex((w) => near(api.w2s(w.x, w.y), 14));
    if (wpIndex >= 0) { setHover({ t: tAtF(tl, tl.wpFrac[wpIndex] ?? 0), src: "field", wp: wpIndex }); return; }
    let best = -1, bestD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const s = api.w2s(pts[i].x, pts[i].y);
      const d = (s.x - px) ** 2 + (s.y - py) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0 && bestD < 18 * 18) {
      const S = pts[pts.length - 1].s || 1;
      setHover({ t: tAtF(tl, pts[best].s / S), src: "field" });
    } else if (hover?.src === "field") setHover(null);
  };

  const selectedWp = selection?.kind === "waypoint" ? path.waypoints[selection.index] : null;
  const hoverCommand = hover?.command ? path.markers.find((m) => m.id === hover.command) : null;
  const selectedCommand = selection?.kind === "command" ? path.markers.find((m) => m.id === selection.id) : null;
  const tool = alt ? "command" : "edit";

  return (
    <div
      className="strip-app"
      data-tool={tool}
      // A mouse click shouldn't leave focus on a button, or Space would press it instead of playing.
      onClick={(e) => { if (e.detail > 0) e.target.closest?.("button")?.blur(); }}
    >
      <TabRow
        project={project}
        activeId={path.id}
        onPick={pick}
        changedIds={push.changedIds}
        errors={allErrors}
        times={times}
        canUndo={store.canUndo}
        canRedo={store.canRedo}
        undo={store.undo}
        redo={store.redo}
        push={push}
        onPush={doPush}
      />

      <main ref={fieldRef} className="strip-field" onPointerMove={onFieldMove} onPointerLeave={() => { if (hover?.src === "field") setHover(null); }}>
        <Field
          path={path}
          derived={fieldDerived}
          issues={issues}
          robot={robot}
          selection={selection}
          onSelect={setSelection}
          edit={edit}
          playhead={{ t: playback.t, visible: playback.playing || playback.t > 0 }}
          tool={tool}
          onPlaceCommand={(f) => { setSelectionRaw(null); setPlacing({ f }); }}
          insets={{ top: TOP_INSET, bottom: 4 }}
          commandLabel={markerLabel}
        >
          {(api) => {
            apiRef.current = api;
            const ring = hover?.src === "strip" && !hover.command ? api.pointAt(fAtT(tl, hover.t)) : null;
            const labelled = [hoverCommand, selectedCommand].filter(Boolean).filter((m, i, a) => a.indexOf(m) === i);
            return (
              <>
                {ring && <span className="strip-ring" style={{ left: ring.x, top: ring.y }} aria-hidden="true" />}
                {labelled.map((m) => {
                  const p = api.pointAt(m.f);
                  return <span key={m.id} className="strip-field-tag" style={{ left: p.x + 12, top: p.y - 26 }} aria-hidden="true">{markerLabel(m)}</span>;
                })}
                {issues.map((iss, i) => {
                  const p = api.pointAt(iss.whole ? 0.5 : (iss.f0 + iss.f1) / 2);
                  return (
                    <span key={"iss" + i} className={"strip-field-issue " + iss.severity} style={{ left: p.x, top: p.y + 16 }} aria-hidden="true">
                      <span className="strip-issue-icon">!</span>{iss.message}
                    </span>
                  );
                })}
                {createPortal(
                  <>
                    {selectedWp && <WaypointPopover key={selection.index} api={api} path={path} index={selection.index} edit={edit} onDelete={() => { edit((p) => (p.waypoints.length > 2 ? removeWaypoint(p, selection.index) : p)); setSelection(null); }} />}
                    {placing && <FieldCatalog api={api} f={placing.f} onClose={() => setPlacing(null)} onPick={(commandId) => { const id = addCommand(placing.f, commandId); setPlacing(null); setSelectionRaw({ kind: "command", id }); }} />}
                  </>,
                  document.body,
                )}
              </>
            );
          }}
        </Field>
      </main>

      <PathStrip
        path={path}
        tl={tl}
        issues={issues}
        stale={stale}
        robot={robot}
        selection={selection}
        setSelection={setSelection}
        edit={edit}
        playback={playback}
        hover={hover}
        setHover={setHover}
        onAddCommand={addCommand}
        onSetCommand={setCommand}
        onDeleteCommand={deleteCommand}
        onDeleteZone={deleteZone}
        onFixIssue={fixIssue}
      />
    </div>
  );
}

function fieldAnchor(api, x, y, height, keepClear = []) {
  // Sit beyond anything the user may grab next (handles, heading knob), on whichever side has room.
  const near = keepClear.filter((q) => Math.abs(q.x - x) < 220);
  const yBelow = Math.max(y, ...near.map((q) => q.y)) + 22, yAbove = Math.min(y, ...near.map((q) => q.y)) - 22;
  const below = yBelow + height < api.size.h - 8 || yAbove - height < 8;
  return { x, y: below ? yBelow : yAbove, side: below ? "below" : "above" };
}

function grabbable(api, path, index) {
  const w = path.waypoints[index], out = [];
  if (index > 0 && w.prevC) out.push(api.w2s(w.prevC.x, w.prevC.y));
  if (index < path.waypoints.length - 1 && w.nextC) out.push(api.w2s(w.nextC.x, w.nextC.y));
  return out;
}

function WaypointPopover({ api, path, index, edit, onDelete }) {
  const w = path.waypoints[index];
  const s = api.w2s(w.x, w.y);
  const a = fieldAnchor(api, s.x, s.y, 56, grabbable(api, path, index));
  const isEnd = index === 0 || index === path.waypoints.length - 1;
  const heading = ((Math.round(w.theta ?? 0) % 360) + 360) % 360;
  const pinned = isEnd || w.thetaOn;
  return (
    <div className="strip-layer">
      <Popover x={a.x} y={a.y} side={a.side} bounds={{ left: 8, right: api.size.w - 8 }} label={`Point ${index + 1}`}>
        <div className="strip-pop-row">
          <span className="strip-pop-id num" aria-hidden="true">{index + 1}</span>
          <button type="button" className="strip-toggle" aria-pressed={Boolean(w.stop)} onClick={() => edit((p) => setWaypointStop(p, index, !p.waypoints[index]?.stop))}>
            <span className="strip-toggle-box" aria-hidden="true" />Stop here
          </button>
          {w.stop && (
            <NumberField label="Wait" unit="s" value={w.wait || 0} step={0.1} min={0} max={15} digits={1} width={3}
              onChange={(v, phase) => edit((p) => { p.waypoints[index].wait = v; return p; }, phase)} />
          )}
          {isEnd ? null : (
            <button type="button" className="strip-toggle" aria-pressed={Boolean(w.thetaOn)} onClick={() => edit((p) => { const q = p.waypoints[index]; if (q.thetaOn) q.thetaOn = false; else setWaypointFacing(p, index, Math.round(q.theta ?? 0)); return p; })}>
              <span className="strip-toggle-box" aria-hidden="true" />Heading
            </button>
          )}
          {pinned && (
            <NumberField label={isEnd ? "Heading" : ""} ariaLabel="Heading, degrees" unit="°" value={heading} step={1} min={-360} max={720} digits={0} width={3}
              onChange={(v, phase) => edit((p) => setWaypointFacing(p, index, ((v % 360) + 360) % 360), phase)} />
          )}
          <button type="button" className="strip-icon-btn danger" aria-label="Delete point" title="Delete" onClick={onDelete} aria-disabled={path.waypoints.length <= 2 || undefined}><Icon.trash /></button>
        </div>
      </Popover>
    </div>
  );
}

function FieldCatalog({ api, f, onPick, onClose }) {
  const ref = useRef(null);
  const p = api.pointAt(f);
  useDismiss(ref, onClose, true);
  const roomBelow = api.size.h - p.y;
  const side = roomBelow > 330 ? "below" : "above";
  return (
    <div className="strip-layer">
      <Popover innerRef={ref} x={p.x} y={side === "below" ? p.y + 16 : p.y - 16} side={side} bounds={{ left: 8, right: api.size.w - 8 }} label="Add command">
        <Catalog onPick={onPick} />
      </Popover>
    </div>
  );
}
