// Hybrid: Workbench's path column and directly editable numbers, with Strip's speed/time/command band.
// Left: every path and push. Right: the field, and under it one band = property panel + timeline.
// The field is wider than the window's aspect, so the band uses height the field could not (see layout.js).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { removeWaypoint, setWaypointFacing } from "../../../../src/renderer/lib/pathEditing";
import { setWaypointStop } from "../../core/editing.js";
import { Field } from "../../core/Field.jsx";
import { useOtherPlans } from "../../core/otherPlans.js";
import { editorGeometry } from "../../core/planning.js";
import { commandDef, markerLabel } from "./labels.js";
import { usePlan, usePlayback, usePush, useProjectState } from "../../core/state.js";
import { placeLabels } from "../workbench/geometry.js";
import { buildTimeline, fAtT, peakBetween, tAtF } from "../strip/timeline.js";
import { CommandMenu } from "./CommandMenu.jsx";
import { Icon } from "./Icon.jsx";
import { BAND_MIN, bandMax, clampBand, shellSizes } from "./layout.js";
import { Panel } from "./Panel.jsx";
import { History, PathList, PushControl } from "./PathList.jsx";
import { isWholeIssue, plainProblem } from "./problems.js";
import { Timeline } from "./Timeline.jsx";
import "./hybrid.css";

let markerSeq = 1;
const isTyping = (el) => Boolean(el?.closest?.("input,textarea,select,[contenteditable=true]"));

function useWindowSize() {
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return size;
}

export function Hybrid() {
  const store = useProjectState();
  const { project, activePath: path, activeId, edit, undo, redo, setActiveId } = store;
  const robot = project.robot;
  const plan = usePlan(path, robot, project.field);
  // usePlan keeps drawing this path's last timing while an edit is re-timed (display only).
  const tl = useMemo(() => buildTimeline(plan.derived), [plan.derived]);
  const pending = plan.status === "pending";
  const playback = usePlayback(tl.empty ? 0 : tl.total);
  const push = usePush(project);
  const otherPlans = useOtherPlans(project.paths, activeId, robot, project.field);

  // ---------- timing state: honest, but never blank while re-timing ----------
  const [clockStale, setClockStale] = useState(false);
  useEffect(() => {
    if (!pending) { setClockStale(false); return undefined; }
    const id = setTimeout(() => setClockStale(true), 450);
    return () => clearTimeout(id);
  }, [pending, plan.derived]);
  // While an edit is re-timed, keep the last problems on screen, marked stale. Push and status never use them.
  const held = useRef({ id: null, issues: [] });
  if (!pending) held.current = { id: path.id, issues: plan.issues };
  const issues = pending && held.current.id === path.id ? held.current.issues : plan.issues;
  const issuesStale = pending && issues.length > 0;
  const confirmedHard = pending ? null : plan.issues.find((i) => i.severity === "error");

  // ---------- selection ----------
  const [selection, setSelection] = useState(null);
  const sel = useMemo(() => {
    if (!selection) return null;
    if (selection.kind === "waypoint" && !path.waypoints[selection.index]) return null;
    if (selection.kind === "command" && !(path.markers || []).some((m) => m.id === selection.id)) return null;
    if (selection.kind === "zone" && !(path.ranges || [])[selection.index]) return null;
    if (selection.kind === "issue" && !issues[selection.index]) return null;
    return selection;
  }, [selection, path, issues]);
  const [menu, setMenu] = useState(null); // command catalog: { at: 'field', f } | { at: 'lane', t }
  const [tool, setTool] = useState("edit");
  const [hover, setHover] = useState(null); // { t, src: 'field' | 'timeline', wp?, command?, lane? }
  const [toast, setToast] = useState(null);
  const select = useCallback((s) => {
    setSelection(s);
    setMenu(null);
    if (s?.kind === "issue" && issues[s.index]) playback.seek(tAtF(tl, issues[s.index].f0));
  }, [issues, tl, playback]);

  // ---------- shell ----------
  const apiRef = useRef(null);
  const win = useWindowSize();
  const [pathsHidden, setPathsHidden] = useState(false);
  const [bandOverride, setBandOverride] = useState(null);
  const sizes = shellSizes(win.w, win.h, pathsHidden);
  const band = bandOverride != null ? clampBand(bandOverride, win.h) : sizes.balanced;
  const togglePaths = useCallback(() => { setPathsHidden((h) => !h); setBandOverride(null); }, []);
  // Showing or hiding paths is a deliberate layout change: fit the field to its new box once it has measured.
  const firstLayout = useRef(true);
  useEffect(() => {
    if (firstLayout.current) { firstLayout.current = false; return undefined; }
    let id = requestAnimationFrame(() => { id = requestAnimationFrame(() => apiRef.current?.fit()); });
    return () => cancelAnimationFrame(id);
  }, [pathsHidden]);

  // ---------- paths ----------
  const [query, setQuery] = useState("");
  const [hoverRow, setHoverRow] = useState(null);
  const searchRef = useRef(null);
  const activeShownError = issues.some((i) => i.severity === "error");
  const rows = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return project.paths
      .filter((p) => words.every((w) => p.name.toLowerCase().includes(w)))
      .map((p) => {
        const active = p.id === activeId;
        return {
          id: p.id, name: p.name, path: p,
          time: active ? (tl.empty ? null : tl.total) : otherPlans[p.id]?.totalTime ?? null,
          error: active ? activeShownError : Boolean(otherPlans[p.id]?.error),
          changed: push.changedIds.includes(p.id),
        };
      });
  }, [project.paths, query, activeId, tl, otherPlans, activeShownError, push.changedIds]);

  const switchPath = useCallback((id) => {
    if (!id || id === activeId) return;
    setActiveId(id);
    setSelection(null);
    setMenu(null);
    setHover(null);
    playback.seek(0);
  }, [activeId, setActiveId, playback]);
  const stepPath = useCallback((dir) => {
    const list = rows.length ? rows : project.paths;
    const i = list.findIndex((r) => r.id === activeId);
    const next = list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + dir))];
    if (next) switchPath(next.id);
  }, [rows, project.paths, activeId, switchPath]);

  const geometryCache = useRef(new WeakMap());
  const ghosts = useMemo(() => {
    const p = hoverRow && hoverRow !== activeId ? project.paths.find((q) => q.id === hoverRow) : null;
    if (!p) return [];
    let d = geometryCache.current.get(p);
    if (!d) { d = editorGeometry(p); geometryCache.current.set(p, d); }
    return [{ id: p.id, derived: d, onClick: () => switchPath(p.id) }];
  }, [hoverRow, activeId, project.paths, switchPath]);

  // ---------- push (SIMULATED) ----------
  const [marks, setMarks] = useState(() => new Set());
  const toggleMark = useCallback((id) => setMarks((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }), []);
  const pushIds = marks.size ? project.paths.filter((p) => marks.has(p.id)).map((p) => p.id) : push.changedIds;
  const knownErrors = useMemo(() => {
    const out = {};
    project.paths.forEach((p) => { if (p.id !== activeId && otherPlans[p.id]?.error) out[p.id] = true; });
    if (confirmedHard) out[activeId] = true;
    return out;
  }, [project.paths, activeId, otherPlans, confirmedHard]);
  // The footer reports the completed operation's own receipt: which of the clicked revisions were sent or refused.
  // Whether a path is changed now is a separate question; a later edit stays changed after its predecessor was sent.
  const [refused, setRefused] = useState([]);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const doPush = useCallback(async () => {
    if (inFlight.current || push.phase === "sending" || !pushIds.length) return;
    const ids = pushIds;
    // Paths already known to break a limit are held back here; push still re-checks the frozen click-time input.
    const blockedIds = ids.filter((id) => knownErrors[id]);
    // Names and reasons as they were when Push was pressed; the receipt is about those revisions.
    const names = {}, reasons = {};
    ids.forEach((id) => { names[id] = project.paths.find((p) => p.id === id)?.name || "Path"; });
    blockedIds.forEach((id) => { reasons[id] = id === activeId && confirmedHard ? plainProblem(confirmedHard, path.waypoints.length).text : "Has a problem"; });
    inFlight.current = true;
    setRefused([]);
    setMarks(new Set());
    let receipt = null;
    try { receipt = await push.push(ids, { blockedIds }); } finally { inFlight.current = false; }
    if (!receipt || !mounted.current) return;
    setRefused(receipt.refusedIds.map((id) => ({ id, name: names[id] || "Path", reason: reasons[id] || receipt.error || "Has a problem" })));
  }, [push, pushIds, knownErrors, project.paths, activeId, confirmedHard, path.waypoints.length]);

  // ---------- edits ----------
  const showToast = useCallback((text, withUndo) => setToast({ text, withUndo, n: Date.now() }), []);
  useEffect(() => {
    if (!toast) return undefined;
    const id = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(id);
  }, [toast]);

  const deleteSelection = useCallback(() => {
    if (!sel) return;
    if (sel.kind === "waypoint") {
      if (path.waypoints.length <= 2) { showToast("A path needs two points"); return; }
      edit((p) => removeWaypoint(p, sel.index));
      showToast("Point deleted", true);
    } else if (sel.kind === "command") {
      edit((p) => ({ ...p, markers: p.markers.filter((m) => m.id !== sel.id) }));
      showToast("Command deleted", true);
    } else if (sel.kind === "zone") {
      edit((p) => { p.ranges.splice(sel.index, 1); return p; });
      showToast("Zone deleted", true);
    } else return;
    setSelection(null);
  }, [sel, path, edit, showToast]);

  const toggleStop = useCallback(() => {
    if (sel?.kind !== "waypoint" || sel.index === 0 || sel.index === path.waypoints.length - 1) return;
    edit((p) => setWaypointStop(p, sel.index, !p.waypoints[sel.index]?.stop));
  }, [sel, path, edit]);
  const toggleHeading = useCallback(() => {
    if (sel?.kind !== "waypoint" || sel.index === 0 || sel.index === path.waypoints.length - 1) return;
    edit((p) => {
      const w = p.waypoints[sel.index];
      if (w.thetaOn) { w.thetaOn = false; return p; }
      return setWaypointFacing(p, sel.index, Math.round(w.theta || 0));
    });
  }, [sel, path, edit]);

  const addCommand = useCallback((f, commandId) => {
    const def = commandDef(commandId);
    const id = `cmd-hy-${Date.now().toString(36)}-${markerSeq++}`;
    const args = Object.fromEntries((def?.parameters || []).map((p) => [p.name, p.default]));
    edit((p) => {
      p.markers = [...(p.markers || []), { id, f: Math.round(f * 1000) / 1000, name: commandId, cmd: commandId, anchor: "param", invocation: { commandId, arguments: args } }];
      return p;
    });
    setSelection({ kind: "command", id });
    setMenu(null);
    setTool("edit");
  }, [edit]);

  const addZone = useCallback((f0, f1, maxVel, name) => {
    let index = 0;
    edit((p) => { p.ranges = [...(p.ranges || []), { anchor: "param", f0, f1, maxVel, name }]; index = p.ranges.length - 1; return p; });
    setTimeout(() => setSelection({ kind: "zone", index }), 0);
  }, [edit]);
  const addZoneAtPlayhead = useCallback(() => {
    const mid = playback.t > 0 ? fAtT(tl, playback.t) : 0.5;
    const cap = Math.max(0.3, Math.round(path.constraints.maxVel * 0.6 * 20) / 20);
    addZone(Math.max(0, Math.round((mid - 0.08) * 1000) / 1000), Math.min(1, Math.round((mid + 0.08) * 1000) / 1000), cap, "Zone");
  }, [playback.t, tl, path.constraints.maxVel, addZone]);
  // "Slow here": the user's explicit choice; adds an ordinary, editable zone over the problem.
  const fixIssue = useCallback((issue) => {
    const pad = issue.f1 - issue.f0 < 0.04 ? 0.03 : 0;
    const f0 = Math.max(0, issue.f0 - pad), f1 = Math.min(1, issue.f1 + pad);
    const peak = peakBetween(tl, f0, f1) || path.constraints.maxVel;
    addZone(Math.round(f0 * 1000) / 1000, Math.round(f1 * 1000) / 1000, Math.max(0.3, Math.round(peak * 0.7 * 20) / 20), "Slow");
  }, [tl, path.constraints.maxVel, addZone]);

  // ---------- keyboard ----------
  const keys = useRef(null);
  keys.current = (e) => {
    if (e.isComposing || e.keyCode === 229) return; // an IME owns these keys
    const target = e.target;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (mod && e.shiftKey && k === "p") { e.preventDefault(); doPush(); return; }
    // App undo wins in number fields too: their text-level undo is rarely what is meant.
    if (mod && k === "z" && target?.classList?.contains("hy-num-input")) { e.preventDefault(); target.blur(); e.shiftKey ? redo() : undo(); return; }
    if (isTyping(target)) return;
    if (mod && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && k === "y") { e.preventDefault(); redo(); return; }
    if (mod || (e.altKey && !e.key.startsWith("Arrow"))) return;
    const ownKeys = target?.closest?.("[role=slider],[role=separator]");
    if (e.key === "Escape") {
      if (menu) setMenu(null);
      else if (tool !== "edit") setTool("edit");
      else setSelection(null);
      return;
    }
    if (e.key === " ") {
      if (target?.closest?.("button,[role=slider],[role=separator],[role=button]")) return;
      e.preventDefault(); playback.toggle(); return;
    }
    if (e.key === "Delete" || e.key === "Backspace") { if (sel) { e.preventDefault(); deleteSelection(); } return; }
    if (e.key.startsWith("Arrow")) {
      if (ownKeys) return;
      if (sel?.kind === "waypoint") {
        e.preventDefault();
        const step = e.shiftKey ? 0.25 : e.altKey ? 0.01 : 0.05;
        const dx = e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0;
        const dy = e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0;
        edit((p) => {
          const w = p.waypoints[sel.index];
          if (!w) return p;
          w.x += dx; w.y += dy;
          if (w.prevC) { w.prevC.x += dx; w.prevC.y += dy; }
          if (w.nextC) { w.nextC.x += dx; w.nextC.y += dy; }
          return p;
        });
      }
      return;
    }
    if (e.shiftKey) return;
    switch (k) {
      case "j": stepPath(1); break;
      case "k": stepPath(-1); break;
      case "s": toggleStop(); break;
      case "h": toggleHeading(); break;
      case "c": setTool((t) => (t === "command" ? "edit" : "command")); setMenu(null); break;
      case "f": apiRef.current?.fit(); break;
      case "x": toggleMark(activeId); break;
      case "\\": togglePaths(); break;
      case "/": e.preventDefault(); if (pathsHidden) setPathsHidden(false); setTimeout(() => { searchRef.current?.focus(); searchRef.current?.select(); }, 0); break;
      default: return;
    }
  };
  useEffect(() => {
    const onKey = (e) => keys.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---------- field ↔ timeline linkage ----------
  const fieldWrap = useRef(null);
  const nearPath = (e) => {
    const api = apiRef.current, pts = plan.derived?.sample?.pts;
    if (!api || !pts?.length) return null;
    const r = fieldWrap.current.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    let best = -1, bestD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const s = api.w2s(pts[i].x, pts[i].y);
      const d = (s.x - px) ** 2 + (s.y - py) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    return { px, py, f: pts[best].s / (pts[pts.length - 1].s || 1), d: Math.sqrt(bestD) };
  };
  const onFieldMove = (e) => {
    const api = apiRef.current;
    if (!api || e.buttons) return;
    const r = fieldWrap.current.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const close = (q, radius) => (q.x - px) ** 2 + (q.y - py) ** 2 < radius * radius;
    const marker = (path.markers || []).find((m) => close(api.pointAt(m.f), 12));
    if (marker) { setHover({ t: tAtF(tl, marker.f), src: "field", command: marker.id }); return; }
    const wp = path.waypoints.findIndex((w) => close(api.w2s(w.x, w.y), 14));
    if (wp >= 0) { setHover({ t: tAtF(tl, tl.wpFrac?.[wp] ?? 0), src: "field", wp }); return; }
    const near = nearPath(e);
    if (near && near.d < 18) setHover({ t: tAtF(tl, near.f), src: "field" });
    else if (hover?.src === "field") setHover(null);
  };
  const onContextMenu = (e) => {
    const near = nearPath(e);
    if (!near) return;
    e.preventDefault();
    if (near.d < 16) { setSelection(null); setMenu({ at: "field", f: near.f }); }
  };

  const fieldSelect = useCallback((s) => { setSelection(s); setMenu(null); }, []);
  const hoveredCommand = hover?.command ? (path.markers || []).find((m) => m.id === hover.command) : null;
  const selectedCommand = sel?.kind === "command" ? path.markers.find((m) => m.id === sel.id) : null;
  const hasRefusal = refused.length > 0;

  return (
    <div className="hy" data-tool={tool} data-paths-hidden={pathsHidden ? "" : undefined}
      style={{ "--hy-left": sizes.left + "px", "--hy-band": band + "px", "--hy-panel": sizes.panel + "px" }}
      // A pointer click shouldn't leave focus on a button, or Space would press it instead of playing.
      onClick={(e) => { if (e.detail > 0) e.target.closest?.("button:not(.hy-keep-focus)")?.blur(); }}>
      {!pathsHidden && (
        <PathList rows={rows} activeId={activeId} query={query} setQuery={setQuery} searchRef={searchRef} onPick={switchPath} onStep={stepPath}
          onHover={setHoverRow} marks={marks} toggleMark={toggleMark}
          onHide={togglePaths} push={push}>
          <PushControl push={push} ids={pushIds} marked={marks.size > 0} refused={refused} onPush={doPush} onClearMarks={() => setMarks(new Set())} onOpen={switchPath} />
        </PathList>
      )}

      <main className="hy-field" ref={fieldWrap} data-stale={issuesStale ? "" : undefined} onPointerMove={onFieldMove}
        onPointerLeave={() => { if (hover?.src === "field") setHover(null); }} onContextMenu={onContextMenu}>
        <Field path={path} derived={plan.derived} issues={issues} robot={robot} selection={sel} onSelect={fieldSelect} edit={edit}
          playhead={{ t: playback.t, visible: playback.playing || playback.t > 0 }} tool={tool} ghosts={ghosts} commandLabel={markerLabel}
          onPlaceCommand={(f) => { setSelection(null); setMenu({ at: "field", f }); }}>
          {(api) => {
            apiRef.current = api;
            return <FieldOverlay api={api} path={path} tl={tl} issues={issues} issuesStale={issuesStale} sel={sel} select={select}
              hover={hover} labelled={[hoveredCommand, selectedCommand]} menu={menu?.at === "field" ? menu : null}
              onPick={(id) => addCommand(menu.f, id)} onCloseMenu={() => setMenu(null)} />;
          }}
        </Field>
        {pathsHidden && (
          <div className="hy-float">
            <button type="button" className="hy-icon-btn" onClick={togglePaths} aria-label="Show paths" aria-keyshortcuts="\" title="Show paths · \"><Icon name="sidebar" /></button>
            <span className="hy-float-name">{path.name}</span>
            <PushControl compact push={push} ids={pushIds} marked={marks.size > 0} onPush={doPush} />
            {hasRefusal && <button type="button" className="hy-float-held" onClick={() => { setPathsHidden(false); switchPath(refused[0].id); }}>Not sent · {refused[0].reason}</button>}
          </div>
        )}
        {tool === "command" && <div className="hy-tool-hint" role="status">Click the path to add a command<kbd>Esc</kbd></div>}
        {toast && (
          <div className="hy-toast" role="status" key={toast.n}>
            <span>{toast.text}</span>
            {toast.withUndo && <button type="button" className="hy-link" onClick={() => { undo(); setToast(null); }}>Undo</button>}
          </div>
        )}
      </main>

      <section className="hy-band" aria-label="Path details">
        <Divider band={band} h={win.h} onChange={setBandOverride} />
        <Panel path={path} sel={sel} tl={tl} issues={issues} issuesStale={issuesStale} edit={edit} select={select} robot={robot}
          onDelete={deleteSelection} onAddZone={addZoneAtPlayhead} onFix={fixIssue} />
        <Timeline path={path} tl={tl} issues={issues} issuesStale={issuesStale} clockStale={clockStale} robot={robot} selection={sel} select={select}
          edit={edit} playback={playback} hover={hover} setHover={setHover}
          laneMenu={menu?.at === "lane" ? menu : null} openLane={(t) => { setSelection(null); setMenu({ at: "lane", t }); }}
          closeMenu={() => setMenu(null)} addCommand={addCommand}
          history={<History undo={undo} redo={redo} canUndo={store.canUndo} canRedo={store.canRedo} />} />
      </section>
    </div>
  );
}

/** Band height: drag, or arrows / Home / End with focus. Enter or double-click returns to the balanced height. */
function Divider({ band, h, onChange }) {
  const start = useRef(null);
  return (
    <div className="hy-divider" role="separator" aria-orientation="horizontal" aria-label="Timeline height" tabIndex={0}
      aria-valuemin={BAND_MIN} aria-valuemax={bandMax(h)} aria-valuenow={band} title="Drag to resize · double-click to reset"
      onPointerDown={(e) => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); start.current = { y: e.clientY, band }; }}
      onPointerMove={(e) => { if (start.current) onChange(clampBand(start.current.band - (e.clientY - start.current.y), h)); }}
      onPointerUp={() => { start.current = null; }} onPointerCancel={() => { start.current = null; }}
      onDoubleClick={() => onChange(null)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        if (e.key === "ArrowUp") { e.preventDefault(); onChange(clampBand(band + step, h)); }
        else if (e.key === "ArrowDown") { e.preventDefault(); onChange(clampBand(band - step, h)); }
        else if (e.key === "Home") { e.preventDefault(); onChange(BAND_MIN); }
        else if (e.key === "End") { e.preventDefault(); onChange(bandMax(h)); }
        else if (e.key === "Enter") { e.preventDefault(); onChange(null); }
      }} />
  );
}

/** On-field labels: problems (select to see numbers and fix), zone chips, stops, and the hovered or selected command. */
function FieldOverlay({ api, path, tl, issues, issuesStale, sel, select, hover, labelled, menu, onPick, onCloseMenu }) {
  const above = (w) => [[-w / 2, -34], [-w / 2, 14], [12, -24], [-w - 12, -24]];
  const below = (w) => [[-w / 2, 14], [-w / 2, -34], [12, 6], [-w - 12, 6]];
  const side = (w) => [[11, -24], [11, 7], [-w - 11, -24], [-w - 11, 7], [-w / 2, -34], [-w / 2, 14]];
  const specs = [];
  issues.slice(0, 3).forEach((issue, i) => {
    const plain = plainProblem(issue, path.waypoints.length);
    const at = Number.isInteger(issue.waypoint) && issue.f1 - issue.f0 < 1e-6 ? path.waypoints[issue.waypoint] : null;
    const p = at ? api.w2s(at.x, at.y) : api.pointAt(isWholeIssue(issue) ? 0.5 : (issue.f0 + issue.f1) / 2);
    specs.push({ key: "iss" + i, kind: "issue", x: p.x, y: p.y, text: plain.text, w: Math.round(plain.text.length * 6.7 + 30), candidates: above, issue, index: i });
  });
  (path.ranges || []).forEach((r, i) => {
    if (r.anchor !== "param") return;
    const p = api.pointAt((r.f0 + r.f1) / 2);
    const text = (r.name || "Zone") + (r.maxVel != null ? ` ${r.maxVel.toFixed(2)} m/s` : "");
    specs.push({ key: "zone" + i, kind: "zone", x: p.x, y: p.y, text, w: Math.round(text.length * 6.6 + 16), candidates: below, index: i });
  });
  path.waypoints.forEach((w, i) => {
    if (!w.stop || i === 0 || i === path.waypoints.length - 1) return;
    const p = api.w2s(w.x, w.y);
    specs.push({ key: "stop" + i, kind: "stop", x: p.x, y: p.y, text: w.wait > 0 ? `Stop · ${w.wait.toFixed(1)} s` : "Stop", candidates: below, optional: true });
  });
  labelled.filter(Boolean).filter((m, i, a) => a.indexOf(m) === i).forEach((m) => {
    const p = api.pointAt(m.f);
    specs.push({ key: m.id, kind: "cmd", x: p.x, y: p.y, text: markerLabel(m), candidates: side, on: sel?.kind === "command" && sel.id === m.id });
  });
  const obstacles = path.waypoints.map((w) => { const p = api.w2s(w.x, w.y); return { x: p.x - 10, y: p.y - 10, w: 20, h: 20 }; });
  // The selected point's handles and heading knob are the next thing grabbed; labels never cover them.
  if (sel?.kind === "waypoint") {
    const w = path.waypoints[sel.index], n = path.waypoints.length;
    [sel.index > 0 && w?.prevC, sel.index < n - 1 && w?.nextC].filter(Boolean).forEach((hnd) => {
      const p = api.w2s(hnd.x, hnd.y); obstacles.push({ x: p.x - 11, y: p.y - 11, w: 22, h: 22 });
    });
    if (w?.thetaOn) {
      const s = api.w2s(w.x, w.y), r = Math.max(34, 0.84 * api.camera.k * 0.75), a = (w.theta * Math.PI) / 180;
      obstacles.push({ x: s.x + Math.cos(a) * r - 10, y: s.y - Math.sin(a) * r - 10, w: 20, h: 20 });
    }
  }
  const ring = hover?.src === "timeline" && !hover.command && hover.wp == null ? api.pointAt(fAtT(tl, hover.t)) : null;
  const tags = placeLabels(specs, obstacles, api.size).map((l) => {
    const style = { transform: `translate(${Math.round(l.box.x)}px, ${Math.round(l.box.y)}px)` };
    if (l.kind === "issue") {
      const on = sel?.kind === "issue" && sel.index === l.index;
      return <button key={l.key} type="button" className={"hy-field-issue " + l.issue.severity + (issuesStale ? " stale" : "")} data-on={on ? "" : undefined} style={style}
        onPointerDown={(e) => e.stopPropagation()} onClick={() => select({ kind: "issue", index: l.index })}><span className="hy-issue-icon" aria-hidden="true">!</span>{l.text}</button>;
    }
    if (l.kind === "zone") {
      const on = sel?.kind === "zone" && sel.index === l.index;
      return <button key={l.key} type="button" className="hy-zone-chip" data-on={on ? "" : undefined} style={style}
        onPointerDown={(e) => e.stopPropagation()} onClick={() => select({ kind: "zone", index: l.index })}>{l.text}</button>;
    }
    return <div key={l.key} className={"hy-tag " + (l.kind === "cmd" ? "hy-cmd-tag" : "hy-stop-tag")} data-on={l.on ? "" : undefined} style={style} aria-hidden="true">{l.text}</div>;
  });
  let menuEl = null;
  if (menu) {
    const p = api.pointAt(menu.f);
    const flipX = p.x + 240 > api.size.w, up = p.y + 320 > api.size.h;
    menuEl = <>
      <div key="anchor" className="hy-pick-anchor" style={{ transform: `translate(${p.x}px, ${p.y}px) rotate(45deg)` }} aria-hidden="true" />
      <CommandMenu key="menu" x={flipX ? p.x - 232 : p.x + 12} y={up ? Math.max(8, p.y - 12) : p.y + 12} side={up ? "above" : "below"} onPick={onPick} onClose={onCloseMenu} />
    </>;
  }
  return <>
    {ring && <span className="hy-ring" style={{ left: ring.x, top: ring.y }} aria-hidden="true" />}
    {tags}
    {menuEl}
  </>;
}
