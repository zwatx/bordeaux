// Canvas: no permanent panels. The field is full-bleed and every control floats over it,
// appearing only where and when it is needed.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Field } from "../../core/Field.jsx";
import { usePlan, usePlayback, usePush, useProjectState } from "../../core/state.js";
import { removeWaypoint } from "../../../../src/renderer/lib/pathEditing";
import { Overlay, commandLabel } from "./Overlay.jsx";
import { PathPill } from "./PathPill.jsx";
import { PushPill } from "./PushPill.jsx";
import { Icon, fmt, peakSpeed, shield, timeAtFraction } from "./ui.jsx";
import { useOtherPlans } from "../../core/otherPlans.js";
import { editorGeometry } from "../../core/planning.js";
import "./canvas.css";

const INSETS = { top: 56, bottom: 60, left: 0, right: 0 };
let markerSeq = 1;

export function Canvas() {
  const store = useProjectState();
  const { project, activePath: path, edit, undo, redo } = store;
  const robot = project.robot;
  const plan = usePlan(path, robot, project.field);
  const playback = usePlayback(plan.totalTime);
  const push = usePush(project);

  const [selection, setSelectionRaw] = useState(null);
  const [pendingCommand, setPendingCommand] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [commandTool, setCommandTool] = useState(false);
  const [altHeld, setAltHeld] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [hoverCommand, setHoverCommand] = useState(null);
  const [previewId, setPreviewId] = useState(null);
  const [refused, setRefused] = useState([]);
  const [toastState, setToastState] = useState(null);
  const api = useRef(null);
  const pill = useRef(null);
  const press = useRef(null);

  const setSelection = useCallback((s) => { setSelectionRaw(s); setPickerOpen(false); if (s) setPendingCommand(null); }, []);
  const tool = commandTool || altHeld ? "command" : "edit";

  // Keep the selection valid through undo/redo and path switches.
  useEffect(() => {
    if (!selection) return;
    const gone = (selection.kind === "waypoint" && !path.waypoints[selection.index])
      || (selection.kind === "command" && !(path.markers || []).some((m) => m.id === selection.id))
      || (selection.kind === "zone" && !(path.ranges || [])[selection.index]);
    if (gone) setSelection(null);
  }, [path, selection, setSelection]);

  const toast = useCallback((text) => setToastState({ text, key: Date.now() }), []);
  useEffect(() => {
    if (!toastState) return undefined;
    const t = setTimeout(() => setToastState(null), 3200);
    return () => clearTimeout(t);
  }, [toastState]);

  // ---- push: every changed path goes; a path with a hard problem is refused with its reason ----
  const activeError = plan.issues.find((i) => i.severity === "error");
  const otherPlans = useOtherPlans(project.paths, path.id, robot, project.field);
  const blocked = useMemo(() => {
    const out = [];
    push.changedIds.forEach((id) => {
      if (id === path.id) { if (activeError) out.push({ id, reason: activeError.message }); return; }
      if (otherPlans[id]?.error) out.push({ id, reason: otherPlans[id].error });
    });
    return out;
  }, [push.changedIds, path.id, activeError, otherPlans]);
  const doPush = useCallback(() => {
    if (push.phase === "sending" || !push.changedIds.length) return;
    setRefused(blocked);
    push.push(push.changedIds, { blockedIds: blocked.map((b) => b.id) });
  }, [push, blocked]);
  const refusedShown = refused.filter((r) => blocked.some((b) => b.id === r.id));

  // ---- commands ----
  const placeCommand = useCallback((c) => {
    if (!pendingCommand) return;
    const id = "cmd-cv-" + markerSeq++;
    const args = Object.fromEntries((c.parameters || []).map((p) => [p.name, p.default]));
    edit((d) => {
      d.markers = [...(d.markers || []), { id, f: Math.round(pendingCommand.f * 1000) / 1000, name: c.id, cmd: c.id, anchor: "param", invocation: { commandId: c.id, arguments: args } }];
      return d;
    });
    setPendingCommand(null);
    setSelectionRaw({ kind: "command", id });
  }, [pendingCommand, edit]);

  const fixIssue = useCallback((issue) => {
    if (issue.f1 - issue.f0 > 0.95) {
      edit((d) => { d.constraints = { ...d.constraints, maxVel: Math.max(0.5, Math.round(d.constraints.maxVel * 0.8 * 10) / 10) }; return d; });
      toast("Speed lowered");
      return;
    }
    const cap = Math.max(0.5, Math.round(peakSpeed(plan.derived, issue.f0, issue.f1) * 0.7 * 10) / 10);
    const index = (path.ranges || []).length;
    edit((d) => { d.ranges = [...(d.ranges || []), { anchor: "param", f0: issue.f0, f1: issue.f1, maxVel: cap, name: "Slow" }]; return d; });
    setSelectionRaw({ kind: "zone", index });
  }, [edit, plan.derived, toast, path.ranges]);

  const switchPath = useCallback((id) => {
    if (id === path.id) return;
    store.setActiveId(id);
    setSelection(null); setPendingCommand(null); playback.seek(0);
  }, [path.id, store, setSelection, playback]);

  // ---- keyboard ----
  const deleteSelection = useCallback(() => {
    if (!selection) return;
    if (selection.kind === "waypoint") {
      if (path.waypoints.length <= 2) return;
      edit((d) => removeWaypoint(d, selection.index));
      toast((selection.index === 0 ? "Start" : selection.index === path.waypoints.length - 1 ? "End" : "Point " + (selection.index + 1)) + " deleted");
    } else if (selection.kind === "command") {
      edit((d) => { d.markers = d.markers.filter((m) => m.id !== selection.id); return d; });
      toast("Command deleted");
    } else if (selection.kind === "zone") {
      edit((d) => { d.ranges.splice(selection.index, 1); return d; });
      toast("Zone deleted");
    }
    setSelection(null);
  }, [selection, path, edit, toast, setSelection]);

  useEffect(() => {
    const onKey = (e) => {
      const el = e.target;
      const typing = el?.closest?.("input,textarea,select,[contenteditable=true]");
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (e.key === "Alt" && !typing) { setAltHeld(true); return; }
      if (mod && e.shiftKey && k === "p") { e.preventDefault(); doPush(); return; }
      if (mod && k === "p") { e.preventDefault(); pill.current?.openPaths(); return; }
      if (typing) return;
      if (mod && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (mod && k === "y") { e.preventDefault(); redo(); return; }
      if (mod) return;
      // Space plays, unless a keyboard user is on a button (a mouse-clicked button keeps no claim on Space).
      if (e.key === " " && !(el.closest?.("button") && el.matches(":focus-visible"))) { e.preventDefault(); playback.toggle(); return; }
      if (e.key === "Escape") {
        if (document.querySelector(".cv-pop")) return; // the open popover closes first
        if (pendingCommand) setPendingCommand(null);
        else if (commandTool) setCommandTool(false);
        else setSelection(null);
        return;
      }
      if (k === "c" && !e.altKey) { setCommandTool((t) => !t); setPendingCommand(null); return; }
      if (k === "f") { api.current?.fit(); return; }
      if (k === "l") { pill.current?.toggleLimits(); return; }
      if (!selection) return;
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelection(); return; }
      if (selection.kind === "waypoint" && e.key.startsWith("Arrow")) {
        e.preventDefault();
        const step = e.shiftKey ? 0.25 : e.altKey ? 0.01 : 0.05;
        const dx = e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0;
        const dy = e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0;
        edit((p) => {
          const w = p.waypoints[selection.index];
          w.x += dx; w.y += dy;
          if (w.prevC) { w.prevC.x += dx; w.prevC.y += dy; }
          if (w.nextC) { w.nextC.x += dx; w.nextC.y += dy; }
          return p;
        });
      }
    };
    const onUp = (e) => { if (e.key === "Alt") setAltHeld(false); };
    const onBlur = () => setAltHeld(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("keyup", onUp); window.removeEventListener("blur", onBlur); };
  }, [doPush, undo, redo, playback, pendingCommand, commandTool, selection, edit, deleteSelection, setSelection]);

  // ---- playback: name the command the robot just passed ----
  const robotVisible = playback.playing || playback.t > 0;
  const recentCommandId = useMemo(() => {
    if (!robotVisible) return null;
    let best = null, bestT = -Infinity;
    (path.markers || []).forEach((m) => {
      const tm = timeAtFraction(plan.derived, m.f);
      if (tm <= playback.t && playback.t - tm < 1.2 && tm > bestT) { best = m.id; bestT = tm; }
    });
    return best;
  }, [robotVisible, path.markers, plan.derived, playback.t]);

  const ghosts = useMemo(() => {
    if (!previewId) return [];
    const p = project.paths.find((x) => x.id === previewId);
    return p ? [{ id: p.id, derived: editorGeometry(p), onClick: () => switchPath(p.id) }] : [];
  }, [previewId, project.paths, switchPath]);

  // ---- gesture tracking: the HUD steps aside while you drag ----
  const onPointerDownCapture = (e) => {
    if (e.target.closest?.(".cv-hud,.cv-issue,.cv-zonetag")) return;
    press.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerMoveCapture = (e) => {
    const p = press.current;
    if (p && !dragging && e.buttons && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 3) setDragging(true);
  };
  const onPointerUpCapture = () => { press.current = null; if (dragging) setDragging(false); };
  const onPointerOver = (e) => {
    const id = e.target.closest?.('[data-role="command"]')?.dataset?.id ?? null;
    if (id !== hoverCommand) setHoverCommand(id);
  };

  return (
    <div className="cv-root" data-tool={tool}
      onPointerDownCapture={onPointerDownCapture} onPointerMoveCapture={onPointerMoveCapture}
      onPointerUpCapture={onPointerUpCapture} onPointerCancelCapture={onPointerUpCapture} onPointerOver={onPointerOver}>
      <Field path={path} derived={plan.derived} issues={plan.issues} robot={robot}
        selection={pendingCommand ? null : selection} onSelect={(s) => { setSelection(s); if (!s) { setCommandTool(false); setPendingCommand(null); } }} edit={edit}
        playhead={{ t: playback.t, visible: robotVisible }} tool={tool}
        onPlaceCommand={(f) => { setSelectionRaw(null); setPendingCommand({ f }); setCommandTool(false); }}
        insets={INSETS} ghosts={ghosts} commandLabel={commandLabel}>
        {(fieldApi) => {
          api.current = fieldApi;
          return <Overlay api={fieldApi} path={path} derived={plan.derived} issues={plan.issues}
            selection={selection} setSelection={setSelection} edit={edit} dragging={dragging}
            pendingCommand={pendingCommand} setPendingCommand={setPendingCommand} placeCommand={placeCommand}
            hoverCommand={hoverCommand} tool={tool} recentCommandId={recentCommandId} toast={toast} fixIssue={fixIssue}
            pickerOpen={pickerOpen} setPickerOpen={setPickerOpen} />;
        }}
      </Field>

      <PathPill ref={pill} project={project} activePath={path} totalTime={plan.totalTime} otherPlans={otherPlans} changedIds={push.changedIds}
        onPick={switchPath} onPreview={setPreviewId} edit={edit} hasError={Boolean(activeError)} />

      <PushPill push={push} paths={project.paths} onPush={doPush} refused={refusedShown} />

      <div className="cv-bottomleft" {...shield}>
        <div className="cv-pill cv-tools">
          <button className="cv-tool" aria-pressed={tool === "command"} onClick={() => { setCommandTool((t) => !t); setPendingCommand(null); }} aria-keyshortcuts="C">
            <Icon.flag /> Command
          </button>
          <span className="cv-pill-rule" aria-hidden="true" />
          <button className="cv-icon-btn" aria-label="Undo" aria-keyshortcuts="Meta+Z" disabled={!store.canUndo} onClick={undo}><Icon.undo /></button>
          <button className="cv-icon-btn" aria-label="Redo" aria-keyshortcuts="Meta+Shift+Z" disabled={!store.canRedo} onClick={redo}><Icon.redo /></button>
        </div>
        {toastState && (
          <div key={toastState.key} className="cv-toast" role="status">
            {toastState.text}
            <button onClick={() => { undo(); setToastState(null); }}>Undo</button>
          </div>
        )}
      </div>

      <Transport playback={playback} totalTime={plan.totalTime} derived={plan.derived} markers={path.markers || []} />
    </div>
  );
}

function Transport({ playback, totalTime, derived, markers }) {
  const ticks = useMemo(() => (totalTime > 0 ? markers.map((m) => ({ id: m.id, at: Math.min(1, timeAtFraction(derived, m.f) / totalTime) })) : []), [markers, derived, totalTime]);
  return (
    <div className="cv-pill cv-transport" {...shield}>
      <button className="cv-play" aria-label={playback.playing ? "Pause" : "Play"} aria-keyshortcuts="Space" onClick={playback.toggle}>
        {playback.playing ? <Icon.pause /> : <Icon.play />}
      </button>
      <div className="cv-scrub">
        <span className="cv-scrub-fill" style={{ transform: `scaleX(${totalTime > 0 ? playback.t / totalTime : 0})` }} aria-hidden="true" />
        {ticks.map((t) => <span key={t.id} className="cv-scrub-tick" style={{ left: `${t.at * 100}%` }} aria-hidden="true" />)}
        <input type="range" min={0} max={Math.max(0.01, totalTime)} step={0.01} value={Math.min(playback.t, totalTime)} aria-label="Playback time"
          onChange={(e) => playback.seek(Number(e.target.value))}
          onKeyDown={(e) => { if (e.key === " ") { e.preventDefault(); playback.toggle(); } }} />
      </div>
      <span className="cv-time num"><span className="cv-time-now">{fmt(Math.min(playback.t, totalTime))}</span> / {fmt(totalTime)} s</span>
    </div>
  );
}
