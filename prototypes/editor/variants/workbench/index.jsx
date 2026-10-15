// Workbench: a keyboard-fast pro tool for iterating on many paths.
// Left: every path + the push control. Middle: the field + transport. Right: the selected object's numbers.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { setWaypointStop } from "../../core/editing.js";
import { Field, FIELD_H, FIELD_W } from "../../core/Field.jsx";
import { usePlan, usePlayback, usePush, useProjectState } from "../../core/state.js";
import { COMMANDS } from "../../core/project.js";
import { editorGeometry } from "../../core/planning.js";
import { removeWaypoint, setWaypointFacing } from "../../../../src/renderer/lib/pathEditing";
import { NumberRow, ReadRow, Switch } from "./NumberRow.jsx";
import { Palette } from "./Palette.jsx";
import { CommandPicker } from "./CommandPicker.jsx";
import { Icon } from "./Icon.jsx";
import { fitView, fmtTime, isWhole, issueLabel, overlappingPoint, pathBounds, placeLabels, timeAtF, visibleBounds } from "./geometry.js";
import { ProjectChip } from "../../core/ProjectChip.jsx";
import "./workbench.css";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const KEY = {
  mod: IS_MAC ? "⌘" : "Ctrl ",
  push: IS_MAC ? "⇧⌘P" : "Ctrl Shift P",
  undo: IS_MAC ? "⌘Z" : "Ctrl Z",
  redo: IS_MAC ? "⇧⌘Z" : "Ctrl Shift Z",
  palette: IS_MAC ? "⌘K" : "Ctrl K",
};

const commandDef = (id) => COMMANDS.find((c) => c.id === id);
const commandLabel = (m) => commandDef(m.invocation?.commandId || m.cmd)?.label || m.name;
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
let markerSeq = 1;

function isTyping(el) {
  return Boolean(el?.closest?.("input,textarea,select,[contenteditable=true]"));
}

export function Workbench() {
  const store = useProjectState();
  const { project, activePath: path, activeId, edit, undo, redo, setActiveId } = store;
  const robot = project.robot;
  const plan = usePlan(path, robot, project.field);
  const playback = usePlayback(plan.totalTime);
  const push = usePush(project);

  const [selection, setSelection] = useState(null);
  const [tool, setTool] = useState("edit");
  const [query, setQuery] = useState("");
  const [pushSel, setPushSel] = useState(() => new Set());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [picker, setPicker] = useState(null);
  const [toast, setToast] = useState(null);
  const [refused, setRefused] = useState(null);
  const [hoverRow, setHoverRow] = useState(null);
  const [view, setView] = useState(null);
  const [fieldSize, setFieldSize] = useState(null);

  const apiRef = useRef(null);
  const fieldWrap = useRef(null);
  const listRef = useRef(null);
  const searchRef = useRef(null);

  // ---------- selection, always valid for the current path ----------
  const sel = useMemo(() => {
    if (!selection) return null;
    if (selection.kind === "waypoint" && !path.waypoints[selection.index]) return null;
    if (selection.kind === "command" && !(path.markers || []).some((m) => m.id === selection.id)) return null;
    if (selection.kind === "zone" && !(path.ranges || [])[selection.index]) return null;
    return selection;
  }, [selection, path]);

  // ---------- every path's duration and error state ----------
  const deriveCache = useRef(new WeakMap());
  const [finals, setFinals] = useState({});
  const activeError = plan.issues.some((i) => i.severity === "error");
  useEffect(() => {
    if (plan.status === "pending") return;
    setFinals((f) => {
      const prev = f[activeId];
      if (prev && prev.path === path && prev.time === plan.totalTime && prev.error === activeError) return f;
      return { ...f, [activeId]: { path, time: plan.totalTime, error: activeError } };
    });
  }, [plan.status, plan.totalTime, activeError, path, activeId]);

  // Background timing for every other path, one at a time, so list durations match what playback shows.
  const pathsRef = useRef(project.paths);
  pathsRef.current = project.paths;
  const finalsRef = useRef(finals);
  finalsRef.current = finals;
  useEffect(() => {
    const worker = new Worker(new URL("./plan-worker.js", import.meta.url), { type: "module" });
    let live = true, seq = 0, inflight = null;
    const next = () => {
      if (!live || inflight) return;
      const p = pathsRef.current.find((q) => q.id !== activeId && finalsRef.current[q.id]?.path !== q);
      if (!p) return;
      inflight = { id: ++seq, path: p };
      worker.postMessage({ id: inflight.id, input: { path: p, robot, field: project.field } });
    };
    worker.onmessage = ({ data }) => {
      const job = inflight;
      inflight = null;
      if (!live || !job || data.id !== job.id) return;
      setFinals((f) => ({ ...f, [job.path.id]: { path: job.path, time: data.time ?? f[job.path.id]?.time, error: data.error, reason: data.reason } }));
      setTimeout(next, 0);
    };
    const start = setTimeout(next, 400);
    return () => { live = false; clearTimeout(start); worker.terminate(); };
  }, [activeId, robot, project.field]);

  const rows = useMemo(() => project.paths.map((p) => {
    let d = deriveCache.current.get(p);
    if (d === undefined) {
      d = editorGeometry(p);
      deriveCache.current.set(p, d);
    }
    const fin = finals[p.id]?.path === p ? finals[p.id] : null;
    const active = p.id === activeId;
    return {
      id: p.id,
      name: p.name,
      path: p,
      derived: active ? plan.derived : d,
      time: active ? plan.totalTime || finals[p.id]?.time || null : fin?.time ?? finals[p.id]?.time ?? null,
      error: active ? activeError : Boolean(fin?.error),
      reason: active ? plan.issues.find((i) => i.severity === "error")?.message : fin?.reason,
    };
  }), [project.paths, finals, activeId, plan.totalTime, plan.derived, plan.issues, activeError]);
  const rowById = useMemo(() => Object.fromEntries(rows.map((r) => [r.id, r])), [rows]);

  const filtered = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return rows;
    return rows.filter((r) => words.every((w) => r.name.toLowerCase().includes(w)));
  }, [rows, query]);

  // ---------- camera: fit the active path (core Field only fits the whole field; see geometry.js) ----------
  useLayoutEffect(() => {
    const el = fieldWrap.current;
    const ro = new ResizeObserver(([entry]) => setFieldSize({ w: entry.contentRect.width, h: entry.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const insets = useMemo(() => {
    if (!view || !fieldSize) return {};
    const { k, cx, cy } = view;
    const lr = fieldSize.w - 32 - FIELD_W * k, tb = fieldSize.h - 32 - FIELD_H * k;
    const dl = 2 * k * (FIELD_W / 2 - cx), dt = 2 * k * (cy - FIELD_H / 2);
    return { left: (lr + dl) / 2, right: (lr - dl) / 2, top: (tb + dt) / 2, bottom: (tb - dt) / 2 };
  }, [view, fieldSize]);
  const fitPath = useCallback((p = path) => {
    if (!fieldSize) return;
    const d = p === path ? plan.derived : rowById[p.id]?.derived;
    setView({ ...fitView(pathBounds(p, d), fieldSize), n: Math.random() });
  }, [fieldSize, path, plan.derived, rowById]);
  const fitField = useCallback(() => {
    if (!fieldSize) return;
    setView({ ...fitView({ x0: 0, y0: 0, x1: FIELD_W, y1: FIELD_H }, fieldSize, 16), n: Math.random() });
  }, [fieldSize]);
  useEffect(() => { apiRef.current?.fit(); }, [insets]);
  const sizedOnce = useRef(false);
  useEffect(() => { if (fieldSize && !sizedOnce.current) { sizedOnce.current = true; fitPath(); } }, [fieldSize, fitPath]);
  // On a path switch, keep the camera unless the new path leaves the view.
  const lastActive = useRef(activeId);
  useEffect(() => {
    if (lastActive.current === activeId) return;
    lastActive.current = activeId;
    const api = apiRef.current;
    if (!api || !fieldSize) return;
    const vis = visibleBounds(api.camera, fieldSize);
    const b = pathBounds(path, plan.derived);
    if (b.x0 < vis.x0 || b.x1 > vis.x1 || b.y0 < vis.y0 || b.y1 > vis.y1) fitPath();
  }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Never lose a point: drags stay in view (core Field), so this catches typed and keyboard moves that end outside.
  const [followTick, setFollowTick] = useState(0);
  const editFollow = useCallback((fn, phase = "commit") => {
    edit(fn, phase);
    if (phase === "end" || phase === "commit") setFollowTick((n) => n + 1);
  }, [edit]);
  // Field pointer drags keep their target in view themselves; refitting on release would only jump the camera.
  const editField = useCallback((fn, phase = "commit") => {
    edit(fn, phase);
    if (phase === "commit") setFollowTick((n) => n + 1);
  }, [edit]);
  useEffect(() => {
    const api = apiRef.current;
    if (!followTick || !api || !fieldSize) return;
    const vis = visibleBounds(api.camera, fieldSize), m = 0;
    const lost = path.waypoints.some((w) => w.x < vis.x0 + m || w.x > vis.x1 - m || w.y < vis.y0 + m || w.y > vis.y1 - m);
    if (lost) setView({ ...fitView(pathBounds(path, editorGeometry(path)), fieldSize), n: Math.random() });
  }, [followTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- actions ----------
  const switchPath = useCallback((id) => {
    if (!id || id === activeId) return;
    setActiveId(id);
    setSelection(null);
    setPicker(null);
    playback.seek(0);
  }, [activeId, setActiveId, playback]);
  const stepPath = useCallback((dir) => {
    const list = filtered.length ? filtered : rows;
    const i = list.findIndex((r) => r.id === activeId);
    const next = list[Math.max(0, Math.min(list.length - 1, (i < 0 ? 0 : i + dir)))];
    if (next) switchPath(next.id);
  }, [filtered, rows, activeId, switchPath]);

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
    }
    setSelection(null);
  }, [sel, path, edit, showToast]);

  const toggleStop = useCallback(() => {
    if (sel?.kind !== "waypoint") return;
    edit((p) => setWaypointStop(p, sel.index, !p.waypoints[sel.index]?.stop));
  }, [sel, edit]);
  const toggleHeading = useCallback(() => {
    if (sel?.kind !== "waypoint") return;
    edit((p) => {
      const w = p.waypoints[sel.index];
      if (w.thetaOn) { w.thetaOn = false; return p; }
      return setWaypointFacing(p, sel.index, Math.round(w.theta || 0));
    });
  }, [sel, edit]);

  const fractionNow = useCallback(() => {
    if (sel?.kind === "waypoint") return plan.derived?.wpFrac?.[sel.index] ?? 0.5;
    if (playback.t > 0 && plan.derived?.prof?.t?.length) {
      const pts = plan.derived.sample.pts, t = plan.derived.prof.t, total = pts[pts.length - 1].s || 1;
      let i = 0;
      while (i < t.length - 1 && t[i] < playback.t) i++;
      return pts[i].s / total;
    }
    return 0.5;
  }, [sel, playback.t, plan.derived]);

  const addCommand = useCallback((f, commandId) => {
    const def = commandDef(commandId);
    const id = "cmd-wb-" + markerSeq++;
    const args = Object.fromEntries((def?.parameters || []).map((p) => [p.name, p.default]));
    edit((p) => {
      p.markers = [...(p.markers || []), { id, f: Math.round(f * 1000) / 1000, name: commandId, cmd: commandId, anchor: "param", invocation: { commandId, arguments: args } }];
      return p;
    });
    setSelection({ kind: "command", id });
    setTool("edit");
    setPicker(null);
  }, [edit]);

  const openPickerAt = useCallback((f) => setPicker({ f }), []);

  const pushIds = pushSel.size ? [...pushSel] : push.changedIds;
  const doPush = useCallback(() => {
    if (push.phase === "sending" || !pushIds.length) return;
    const blocked = pushIds.filter((id) => rowById[id]?.error);
    setRefused(blocked.length ? blocked.map((id) => ({ name: rowById[id].name, reason: rowById[id].reason })) : null);
    push.push(pushIds, { blockedIds: blocked });
    setPushSel(new Set());
  }, [push, pushIds, rowById]);

  const togglePushSel = useCallback((id) => {
    setPushSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }, []);

  // ---------- problems ----------
  const issues = plan.issues;
  const topIssue = useMemo(() => [...issues].sort((a, b) => (a.severity === "error" ? -1 : 0) - (b.severity === "error" ? -1 : 0))[0] || null, [issues]);
  const fixFor = useCallback((issue) => {
    if (!issue) return null;
    const d = plan.derived;
    if (isWhole(issue)) {
      // Two points on top of each other is the common cause; merging them is the obvious fix.
      const i = overlappingPoint(path);
      if (i < 0 || path.waypoints.length <= 2) return null;
      return { label: "Merge points", run: () => { edit((p) => removeWaypoint(p, i === p.waypoints.length - 1 ? i - 1 : i)); setSelection(null); } };
    }
    const pts = d?.sample?.pts, v = d?.metrics?.v;
    if (!pts?.length || !v?.length) return null;
    const total = pts[pts.length - 1].s || 1, mid = (issue.f0 + issue.f1) / 2;
    let i = 0;
    while (i < pts.length - 1 && pts[i].s / total < mid) i++;
    const cap = Math.max(0.3, Math.round((v[i] || 1) * 0.7 * 10) / 10);
    return {
      label: "Slow here",
      run: () => edit((p) => {
        p.ranges = [...(p.ranges || []), { anchor: "param", f0: Math.max(0, mid - 0.08), f1: Math.min(1, mid + 0.08), maxVel: cap, name: "Slow" }];
        return p;
      }),
    };
  }, [plan.derived, path, edit]);

  // ---------- keyboard ----------
  const keyHandler = useRef(null);
  keyHandler.current = (e) => {
    const target = e.target;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (mod && k === "k") { e.preventDefault(); setPaletteOpen((o) => !o); return; }
    if (mod && e.shiftKey && k === "p") { e.preventDefault(); doPush(); return; }
    if (paletteOpen || picker) return;
    if (target?.closest?.("[data-wb-own-keys]")) return;
    // App undo wins in number fields too: their text-level undo is rarely what's meant.
    if (mod && k === "z" && target?.classList?.contains("wb-num-input")) { e.preventDefault(); target.blur(); e.shiftKey ? redo() : undo(); return; }
    if (isTyping(target)) return;
    if (mod && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && k === "y") { e.preventDefault(); redo(); return; }
    if (mod || e.altKey && !e.key.startsWith("Arrow")) return;
    const inField = target === document.body || fieldWrap.current?.contains(target);

    if (e.key === "Escape") {
      if (tool !== "edit") setTool("edit");
      else setSelection(null);
      if (listRef.current?.contains(target)) target.blur();
      return;
    }
    if (e.key === " " && !target?.closest?.("button,[role=slider]")) { e.preventDefault(); playback.toggle(); return; }
    if (e.key === "Tab" && inField) {
      e.preventDefault();
      const n = path.waypoints.length;
      const cur = sel?.kind === "waypoint" ? sel.index : (e.shiftKey ? 0 : -1);
      setSelection({ kind: "waypoint", index: (cur + (e.shiftKey ? -1 : 1) + n) % n });
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") { if (sel) { e.preventDefault(); deleteSelection(); } return; }
    if (e.key.startsWith("Arrow")) {
      if (sel?.kind === "waypoint" && !listRef.current?.contains(target)) {
        e.preventDefault();
        const step = e.shiftKey ? 0.25 : e.altKey ? 0.01 : 0.05;
        const dx = e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0;
        const dy = e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0;
        editFollow((p) => {
          const w = p.waypoints[sel.index];
          w.x += dx; w.y += dy;
          if (w.prevC) { w.prevC.x += dx; w.prevC.y += dy; }
          if (w.nextC) { w.nextC.x += dx; w.nextC.y += dy; }
          return p;
        });
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); stepPath(e.key === "ArrowDown" ? 1 : -1); }
      return;
    }
    if (e.shiftKey && k !== "f") return;
    switch (k) {
      case "j": stepPath(1); break;
      case "k": stepPath(-1); break;
      case "s": toggleStop(); break;
      case "h": toggleHeading(); break;
      case "c": setTool((t) => (t === "command" ? "edit" : "command")); break;
      case "f": e.shiftKey ? fitField() : fitPath(); break;
      case "x": togglePushSel(activeId); break;
      case "/": e.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); break;
      default: return;
    }
  };
  useEffect(() => {
    const onKey = (e) => keyHandler.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Keep keyboard focus on the active row when moving through the list.
  useEffect(() => {
    if (listRef.current?.contains(document.activeElement)) {
      listRef.current.querySelector(`[data-path-id="${activeId}"] .wb-row-main`)?.focus();
    }
    listRef.current?.querySelector(`[data-path-id="${activeId}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  // ---------- right-click on the path: add a command there ----------
  const onContextMenu = (e) => {
    const api = apiRef.current, pts = plan.derived?.sample?.pts;
    if (!api || !pts?.length) return;
    e.preventDefault();
    const r = fieldWrap.current.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    let best = -1, bestD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const s = api.w2s(pts[i].x, pts[i].y);
      const d = (s.x - mx) ** 2 + (s.y - my) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (Math.sqrt(bestD) < 16) openPickerAt(pts[best].s / (pts[pts.length - 1].s || 1));
  };

  const onFieldSelect = useCallback((s) => { setSelection(s); setPicker(null); }, []);
  const ghosts = useMemo(() => {
    const r = hoverRow && hoverRow !== activeId ? rowById[hoverRow] : null;
    return r?.derived ? [{ id: r.id, derived: r.derived, onClick: () => switchPath(r.id) }] : [];
  }, [hoverRow, activeId, rowById, switchPath]);

  // ---------- palette ----------
  const paletteItems = useMemo(() => {
    const items = [];
    const act = (id, label, hint, run, extra = {}) => items.push({ id, label, hint, run, group: "Actions", ...extra });
    if (topIssue) { const fix = fixFor(topIssue); if (fix) act("fix", `Fix: ${fix.label}`, "", fix.run); }
    act("play", playback.playing ? "Pause" : "Play", "Space", playback.toggle);
    act("cmd", "Add command…", "C", null, { next: "commands" });
    act("push", pushIds.length ? `Push ${pushIds.length} ${pushSel.size ? "selected" : "changed"}` : "Push (up to date)", KEY.push, doPush);
    if (sel?.kind === "waypoint") {
      const w = path.waypoints[sel.index];
      act("stop", w.stop ? "Remove stop" : "Stop here", "S", toggleStop);
      act("heading", w.thetaOn ? "Free heading" : "Set heading", "H", toggleHeading);
      act("del", "Delete point", "⌫", deleteSelection);
    } else if (sel?.kind === "command") act("del", "Delete command", "⌫", deleteSelection);
    else if (sel?.kind === "zone") act("del", "Delete zone", "⌫", deleteSelection);
    act("undo", "Undo", KEY.undo, undo);
    act("redo", "Redo", KEY.redo, redo);
    act("next-point", "Next point", "Tab", () => setSelection((s) => ({ kind: "waypoint", index: s?.kind === "waypoint" ? (s.index + 1) % path.waypoints.length : 0 })));
    act("next-path", "Next path", "J", () => stepPath(1));
    act("prev-path", "Previous path", "K", () => stepPath(-1));
    act("mark", pushSel.has(activeId) ? "Unselect for push" : "Select for push", "X", () => togglePushSel(activeId));
    act("fit", "Fit path", "F", () => fitPath());
    act("field", "Whole field", "⇧F", fitField);
    act("search", "Search paths", "/", () => setTimeout(() => searchRef.current?.focus(), 0));
    if (sel) act("esc", "Deselect", "Esc", () => setSelection(null));
    rows.forEach((r) => items.push({ id: "go-" + r.id, label: r.name, meta: fmtTime(r.time) + " s", group: "Go to path", run: () => switchPath(r.id), current: r.id === activeId }));
    return items;
  }, [topIssue, fixFor, playback.playing, playback.toggle, pushIds.length, pushSel, doPush, sel, path, toggleStop, toggleHeading, deleteSelection, undo, redo, stepPath, activeId, togglePushSel, fitPath, fitField, rows, switchPath]);
  const commandItems = useMemo(() => COMMANDS.map((c) => ({ id: "c-" + c.id, label: c.label, group: "Add command", run: () => addCommand(fractionNow(), c.id) })), [addCommand, fractionNow]);

  // ---------- render ----------
  const shownTotal = plan.totalTime || finals[activeId]?.time || 0;
  const selectedMarker = sel?.kind === "command" ? path.markers.find((m) => m.id === sel.id) : null;

  return (
    <div className="wb" data-tool={tool}>
      <aside className="wb-left" aria-label="Paths">
        <div className="wb-head">
          <ProjectChip className="wb-projectchip" />
          <button className="wb-ghost wb-k" onClick={() => setPaletteOpen(true)} aria-label="Command palette"><kbd>{KEY.palette}</kbd></button>
        </div>
        <div className="wb-search">
          <Icon name="search" />
          <input ref={searchRef} type="search" value={query} placeholder="Search" aria-label="Search paths" spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); stepPath(e.key === "ArrowDown" ? 1 : -1); }
              else if (e.key === "Enter") { if (filtered[0] && !filtered.some((r) => r.id === activeId)) switchPath(filtered[0].id); e.currentTarget.blur(); }
              else if (e.key === "Escape") { setQuery(""); e.currentTarget.blur(); }
            }} />
          {!query && <kbd className="wb-search-k">/</kbd>}
        </div>
        <div className="wb-list" ref={listRef} role="list" onPointerLeave={() => setHoverRow(null)}>
          {filtered.map((r) => {
            const changed = push.changedIds.includes(r.id);
            const marked = pushSel.has(r.id);
            const sending = push.phase === "sending" && (push.sending || []).includes(r.id);
            return (
              <div key={r.id} role="listitem" data-path-id={r.id} className="wb-row" data-active={r.id === activeId ? "" : undefined}
                data-marked={marked ? "" : undefined} data-error={r.error ? "" : undefined} onPointerEnter={() => setHoverRow(r.id)}>
                <button className="wb-row-mark" aria-label={(marked ? "Unselect " : "Select ") + r.name + " for push"} aria-pressed={marked}
                  onClick={() => togglePushSel(r.id)} tabIndex={-1}>
                  <span className="wb-mark-box" aria-hidden="true">{marked && <Icon name="check" />}</span>
                  <span className={"wb-dot" + (r.error ? " bad" : changed ? " changed" : "") + (sending ? " sending" : "")} aria-hidden="true" />
                </button>
                <button className="wb-row-main" aria-current={r.id === activeId ? "true" : undefined}
                  onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) togglePushSel(r.id); else switchPath(r.id); }}>
                  <span className="wb-row-name">{r.name}</span>
                  <span className="wb-row-meta num">{fmtTime(r.time)}<span className="wb-unit"> s</span></span>
                  <span className="wb-sr">{r.error ? ", has a problem" : changed ? ", changed since push" : ""}</span>
                </button>
              </div>
            );
          })}
          {!filtered.length && <div className="wb-empty">No match</div>}
        </div>
        <PushControl push={push} ids={pushIds} selectedCount={pushSel.size} refused={refused} onPush={doPush} onClearSel={() => setPushSel(new Set())} />
      </aside>

      <main className="wb-center">
        <div className="wb-field" ref={fieldWrap} onContextMenu={onContextMenu} tabIndex={-1}>
          <Field path={path} derived={plan.derived} issues={issues} robot={robot} selection={sel} onSelect={onFieldSelect} edit={editField}
            playhead={{ t: playback.t, visible: playback.playing || playback.t > 0 }} tool={tool} insets={insets}
            onPlaceCommand={openPickerAt} ghosts={ghosts} commandLabel={commandLabel}>
            {(api) => {
              apiRef.current = api;
              return (
                <FieldOverlays api={api} path={path} issues={issues} sel={sel} selectedMarker={selectedMarker} setSelection={setSelection}
                  picker={picker} onPick={(id) => addCommand(picker.f, id)} onClosePicker={() => setPicker(null)} />
              );
            }}
          </Field>
          {tool === "command" && <div className="wb-tool-hint" role="status">Click the path<kbd>Esc</kbd></div>}
          {toast && (
            <div className="wb-toast" role="status" key={toast.n}>
              <span>{toast.text}</span>
              {toast.withUndo && <button className="wb-link" onClick={() => { undo(); setToast(null); }}>Undo</button>}
            </div>
          )}
        </div>
        <Transport playback={playback} total={shownTotal} derived={plan.derived} path={path} issues={issues}
          tool={tool} setTool={setTool} undo={undo} redo={redo} canUndo={store.canUndo} canRedo={store.canRedo}
          selectedId={selectedMarker?.id} onSelectCommand={(id) => setSelection({ kind: "command", id })} />
      </main>

      <aside className="wb-rail" aria-label="Properties">
        <Rail path={path} sel={sel} edit={editFollow} plan={{ ...plan, totalTime: shownTotal }} topIssue={topIssue} fix={fixFor(topIssue)}
          setSelection={setSelection} deleteSelection={deleteSelection} toggleStop={toggleStop} />
      </aside>

      {paletteOpen && <Palette items={paletteItems} commandItems={commandItems} onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}

// ======================================================================
function PushControl({ push, ids, selectedCount, refused, onPush, onClearSel }) {
  const sending = push.phase === "sending";
  const n = ids.length;
  const label = sending ? `Pushing ${push.sending?.length || n}…` : n ? `Push ${n} ${selectedCount ? "selected" : "changed"}` : "Up to date";
  const duration = 420 + 160 * Math.max(1, push.sending?.length || n);
  let status = null;
  if (!sending && push.lastAt && push.phase !== "refused") {
    status = <span className="wb-push-status"><Icon name="check" className={push.phase === "done" ? "good" : ""} />Pushed {push.lastCount} · {clock(push.lastAt)}</span>;
  }
  const held = refused?.length && (sending || push.phase === "done" || push.phase === "refused")
    ? <span className="wb-push-status bad" title={refused.map((r) => `${r.name}: ${r.reason || "problem"}`).join("\n")}>
        Not sent · {refused.length === 1 ? `${refused[0].reason || "Problem"} · ${refused[0].name}` : `${refused.length} paths with problems`}
      </span>
    : null;
  return (
    <div className="wb-push">
      <div className="wb-push-dest" title="Destination">
        <span className="num">{push.destination.host}</span><span className="wb-sep">·</span><span>{push.destination.folder}</span>
        {selectedCount > 0 && !sending && <button className="wb-link wb-push-clear" onClick={onClearSel}>Clear</button>}
      </div>
      <button className="wb-push-btn" data-state={sending ? "sending" : n ? "ready" : "idle"} aria-busy={sending || undefined}
        onClick={onPush} style={{ "--wb-push-ms": duration + "ms" }}>
        {sending && <span className="wb-push-fill" aria-hidden="true" />}
        <span className="wb-push-label">{label}</span>
        {!sending && n > 0 && <kbd>{KEY.push}</kbd>}
      </button>
      <div className="wb-push-foot" aria-live="polite">{status}{held}</div>
    </div>
  );
}

// ======================================================================
function FieldOverlays({ api, path, issues, sel, selectedMarker, setSelection, picker, onPick, onClosePicker }) {
  // Collect labels in priority order, then place them so they never sit on each other or on a point.
  const above = (w) => [[-w / 2, -34], [-w / 2, 14], [12, -24], [-w - 12, -24]];
  const below = (w) => [[-w / 2, 14], [-w / 2, -34], [12, 6], [-w - 12, 6]];
  const side = (w) => [[11, -24], [11, 7], [-w - 11, -24], [-w - 11, 7], [-w / 2, -34], [-w / 2, 14]];
  const specs = [];
  issues.slice(0, 3).forEach((issue, i) => {
    const whole = isWhole(issue);
    const ov = whole ? overlappingPoint(path) : -1;
    const at = issue.waypoint != null && path.waypoints[issue.waypoint] ? path.waypoints[issue.waypoint] : ov >= 0 ? path.waypoints[ov] : null;
    const p = at ? api.w2s(at.x, at.y) : api.pointAt(whole ? 0.5 : (issue.f0 + issue.f1) / 2);
    const text = issueLabel(issue, path);
    specs.push({ key: "iss" + i, kind: "issue", x: p.x, y: p.y, text, w: Math.round(text.length * 6.6 + 14), candidates: above, issue });
  });
  (path.ranges || []).forEach((r, i) => {
    if (r.anchor !== "param") return;
    const p = api.pointAt((r.f0 + r.f1) / 2);
    const text = (r.name || "Zone") + (r.maxVel != null ? ` ${r.maxVel.toFixed(1)} m/s` : "");
    specs.push({ key: "zone" + i, kind: "zone", x: p.x, y: p.y, text, w: Math.round(text.length * 6.6 + 16), candidates: below, index: i, optional: sel?.kind === "waypoint" });
  });
  path.waypoints.forEach((w, i) => {
    if (!w.stop) return;
    const p = api.w2s(w.x, w.y);
    specs.push({ key: "stop" + i, kind: "stop", x: p.x, y: p.y, text: w.wait > 0 ? `Stop ${w.wait.toFixed(1)} s` : "Stop", candidates: below, optional: true });
  });
  const markers = [...(path.markers || [])].sort((a, b) => (a.id === selectedMarker?.id ? -1 : b.id === selectedMarker?.id ? 1 : 0));
  markers.forEach((m) => {
    const p = api.pointAt(m.f);
    specs.push({ key: m.id, kind: "cmd", x: p.x, y: p.y, text: commandLabel(m), candidates: side, on: selectedMarker?.id === m.id, optional: selectedMarker?.id !== m.id });
  });
  const obstacles = path.waypoints.map((w) => { const p = api.w2s(w.x, w.y); return { x: p.x - 9, y: p.y - 9, w: 18, h: 18 }; });
  // The selected point's handles are the next thing grabbed; labels and chips never cover them.
  if (sel?.kind === "waypoint") {
    const w = path.waypoints[sel.index], n = path.waypoints.length;
    [sel.index > 0 && w?.prevC, sel.index < n - 1 && w?.nextC].filter(Boolean).forEach((h) => {
      const p = api.w2s(h.x, h.y); obstacles.push({ x: p.x - 10, y: p.y - 10, w: 20, h: 20 });
    });
  }
  const tags = placeLabels(specs, obstacles, api.size).map((l) => {
    const style = { transform: `translate(${Math.round(l.box.x)}px, ${Math.round(l.box.y)}px)` };
    if (l.kind === "zone") {
      const on = sel?.kind === "zone" && sel.index === l.index;
      return <button key={l.key} className="wb-zone-chip" data-on={on ? "" : undefined} style={style}
        onPointerDown={(e) => e.stopPropagation()} onClick={() => setSelection({ kind: "zone", index: l.index })}>{l.text}</button>;
    }
    if (l.kind === "issue") return <div key={l.key} className={"wb-tag wb-issue-tag " + l.issue.severity} style={style}>{l.text}</div>;
    if (l.kind === "stop") return <div key={l.key} className="wb-tag wb-stop-tag" style={style}>{l.text}</div>;
    return <div key={l.key} className="wb-tag wb-cmd-tag" data-on={l.on ? "" : undefined} style={style}>{l.text}</div>;
  });
  let pickerEl = null;
  if (picker) {
    const p = api.pointAt(picker.f);
    const flipX = p.x + 236 > api.size.w, flipY = p.y + 300 > api.size.h;
    pickerEl = <>
      <div key="anchor" className="wb-pick-anchor" style={{ transform: `translate(${p.x}px, ${p.y}px) rotate(45deg)` }} aria-hidden="true" />
      <CommandPicker key="picker" x={flipX ? p.x - 228 : p.x + 12} y={flipY ? Math.max(8, p.y - 292) : p.y + 12}
      anchor={{ x: p.x, y: p.y }} onPick={onPick} onClose={onClosePicker} />
    </>;
  }
  return <>{tags}{pickerEl}</>;
}

// ======================================================================
function Transport({ playback, total, derived, path, issues, tool, setTool, undo, redo, canUndo, canRedo, selectedId, onSelectCommand }) {
  const track = useRef(null);
  const scrubbing = useRef(false);
  const seekAt = (clientX) => {
    const r = track.current.getBoundingClientRect();
    playback.seek(((clientX - r.left) / r.width) * total);
  };
  const pct = (t) => (total > 0 ? Math.max(0, Math.min(100, (t / total) * 100)) : 0);
  return (
    <div className="wb-transport">
      <div className="wb-tr-left">
        <button className="wb-icon-btn" onClick={playback.toggle} aria-label={playback.playing ? "Pause" : "Play"} title="Space">
          <Icon name={playback.playing ? "pause" : "play"} />
        </button>
        <div className="wb-scrub" ref={track} role="slider" tabIndex={0} aria-label="Playback time" data-wb-own-keys=""
          aria-valuemin={0} aria-valuemax={Number(total.toFixed(2))} aria-valuenow={Number(playback.t.toFixed(2))} aria-valuetext={`${playback.t.toFixed(2)} of ${total.toFixed(2)} seconds`}
          onPointerDown={(e) => { scrubbing.current = true; e.currentTarget.setPointerCapture(e.pointerId); seekAt(e.clientX); }}
          onPointerMove={(e) => { if (scrubbing.current) seekAt(e.clientX); }}
          onPointerUp={() => { scrubbing.current = false; }}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); playback.seek(playback.t + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 1 : 0.1)); }
            else if (e.key === "Home") playback.seek(0);
            else if (e.key === "End") playback.seek(total);
            else if (e.key === " ") { e.preventDefault(); playback.toggle(); }
          }}>
          <div className="wb-scrub-rail">
            {issues.filter((i) => !isWhole(i)).map((i, n) => (
              <span key={n} className={"wb-scrub-issue " + i.severity} style={{ left: pct(timeAtF(derived, i.f0)) + "%", width: Math.max(0.8, pct(timeAtF(derived, i.f1)) - pct(timeAtF(derived, i.f0))) + "%" }} />
            ))}
            <span className="wb-scrub-fill" style={{ transform: `scaleX(${pct(playback.t) / 100})` }} />
          </div>
          {(path.markers || []).map((m) => (
            <button key={m.id} className="wb-scrub-cmd" data-on={selectedId === m.id ? "" : undefined} tabIndex={-1}
              style={{ left: pct(timeAtF(derived, m.f)) + "%" }} aria-label={commandLabel(m)} title={commandLabel(m)}
              onPointerDown={(e) => { e.stopPropagation(); onSelectCommand(m.id); }} />
          ))}
          <span className="wb-scrub-head" style={{ left: pct(playback.t) + "%" }} />
        </div>
      </div>
      <div className="wb-tr-right">
        <span className="wb-time num" aria-label="Playback time"><span className="wb-time-now">{playback.t.toFixed(2)}</span><span className="wb-time-sep">/</span>{total.toFixed(2)} s</span>
        <span className="wb-divider" aria-hidden="true" />
        <button className="wb-icon-btn" data-on={tool === "command" ? "" : undefined} aria-pressed={tool === "command"} onClick={() => setTool(tool === "command" ? "edit" : "command")} aria-label="Add command" title="Add command · C">
          <Icon name="flag" />
        </button>
        <button className="wb-icon-btn" onClick={undo} aria-label="Undo" title={"Undo · " + KEY.undo} data-dim={canUndo ? undefined : ""}><Icon name="undo" /></button>
        <button className="wb-icon-btn" onClick={redo} aria-label="Redo" title={"Redo · " + KEY.redo} data-dim={canRedo ? undefined : ""}><Icon name="redo" /></button>
      </div>
    </div>
  );
}

// ======================================================================
function Rail({ path, sel, edit, plan, topIssue, fix, setSelection, deleteSelection, toggleStop }) {
  const set = (fn) => (value, phase) => edit((p) => { fn(p, value); return p; }, phase);
  let title = "Path", body = null, del = null;
  const c = path.constraints;

  if (sel?.kind === "waypoint") {
    const i = sel.index, w = path.waypoints[i], n = path.waypoints.length;
    title = i === 0 ? "Start" : i === n - 1 ? "End" : `Point ${i + 1}`;
    del = n > 2 ? "Delete point" : null;
    body = <>
      <div className="wb-group">
        <NumberRow label="X" unit="m" value={w.x} step={0.01} digits={2} min={0} max={FIELD_W}
          onChange={set((p, v) => { const q = p.waypoints[i], d = v - q.x; q.x = v; if (q.prevC) q.prevC.x += d; if (q.nextC) q.nextC.x += d; })} />
        <NumberRow label="Y" unit="m" value={w.y} step={0.01} digits={2} min={0} max={FIELD_H}
          onChange={set((p, v) => { const q = p.waypoints[i], d = v - q.y; q.y = v; if (q.prevC) q.prevC.y += d; if (q.nextC) q.nextC.y += d; })} />
        <NumberRow label="Heading" unit={w.thetaOn ? "°" : ""} value={w.thetaOn ? w.theta : null} placeholder="Free" step={1} digits={0} wrap={360}
          onChange={(v, phase) => edit((p) => setWaypointFacing(p, i, v), phase)}
          trailing={w.thetaOn && i > 0 && i < n - 1 ? <button className="wb-mini" onClick={() => edit((p) => { p.waypoints[i].thetaOn = false; return p; })} aria-label="Free heading" title="Free · H"><Icon name="x" /></button> : null} />
      </div>
      <div className="wb-group">
        <div className="wb-row-line">
          <label className="wb-label" htmlFor="wb-stop">Stop here</label>
          <Switch id="wb-stop" checked={Boolean(w.stop)} onChange={toggleStop} />
        </div>
        {w.stop && <NumberRow label="Wait" unit="s" value={w.wait || 0} step={0.1} digits={1} min={0} max={15}
          onChange={set((p, v) => { p.waypoints[i].wait = v; })} />}
      </div>
    </>;
  } else if (sel?.kind === "command") {
    const m = path.markers.find((x) => x.id === sel.id);
    const def = commandDef(m.invocation?.commandId || m.cmd);
    title = "Command";
    del = "Delete command";
    body = <>
      <div className="wb-group">
        <div className="wb-row-line wb-row-full">
          <label className="wb-sr" htmlFor="wb-cmd">Command</label>
          <select id="wb-cmd" className="wb-select" value={def?.id || ""} onChange={(e) => {
            const id = e.target.value, nd = commandDef(id);
            edit((p) => { const q = p.markers.find((x) => x.id === sel.id); q.name = id; q.cmd = id; q.invocation = { commandId: id, arguments: Object.fromEntries((nd?.parameters || []).map((a) => [a.name, a.default])) }; return p; });
          }}>
            {COMMANDS.map((cd) => <option key={cd.id} value={cd.id}>{cd.label}</option>)}
          </select>
        </div>
        <NumberRow label="Position" unit="%" value={m.f * 100} step={0.5} digits={1} min={0} max={100}
          onChange={set((p, v) => { p.markers.find((x) => x.id === sel.id).f = Math.round(v * 10) / 1000; })} />
        <ReadRow label="Time" value={timeAtF(plan.derived, m.f).toFixed(2)} unit="s" />
      </div>
      {def?.parameters?.length > 0 && <div className="wb-group">
        {def.parameters.map((prm) => (
          <NumberRow key={prm.name} label={prm.label} value={m.invocation?.arguments?.[prm.name] ?? prm.default} step={prm.default >= 100 ? 50 : 1} digits={0} min={0}
            onChange={set((p, v) => { const q = p.markers.find((x) => x.id === sel.id); q.invocation = { ...q.invocation, arguments: { ...q.invocation.arguments, [prm.name]: v } }; })} />
        ))}
      </div>}
    </>;
  } else if (sel?.kind === "zone") {
    const i = sel.index, r = path.ranges[i];
    title = r.name || "Zone";
    del = "Delete zone";
    body = <div className="wb-group">
      <NumberRow label="Speed" unit="m/s" value={r.maxVel ?? c.maxVel} step={0.1} digits={2} min={0.05} max={20}
        onChange={set((p, v) => { p.ranges[i].maxVel = v; })} />
      <NumberRow label="Start" unit="%" value={Math.min(r.f0, r.f1) * 100} step={0.5} digits={1} min={0} max={100}
        onChange={set((p, v) => { p.ranges[i].f0 = v / 100; })} />
      <NumberRow label="End" unit="%" value={Math.max(r.f0, r.f1) * 100} step={0.5} digits={1} min={0} max={100}
        onChange={set((p, v) => { p.ranges[i].f1 = v / 100; })} />
    </div>;
  } else {
    body = <>
      <div className="wb-group">
        <NumberRow label="Speed" unit="m/s" value={c.maxVel} step={0.05} digits={2} min={0.05} max={20} onChange={set((p, v) => { p.constraints.maxVel = v; })} />
        <NumberRow label="Acceleration" unit="m/s²" value={c.maxAccel} step={0.05} digits={2} min={0.05} max={50} onChange={set((p, v) => { p.constraints.maxAccel = v; })} />
        <ReadRow label="Total time" value={plan.totalTime.toFixed(2)} unit="s" className="wb-total" />
      </div>
      <More>
        <NumberRow label="Deceleration" unit="m/s²" value={c.maxDecel ?? c.maxAccel} step={0.05} digits={2} min={0.05} max={50} onChange={set((p, v) => { p.constraints.maxDecel = v; })} />
        <NumberRow label="Turn speed" unit="°/s" value={c.maxAngVel} step={5} digits={0} min={1} max={2000} onChange={set((p, v) => { p.constraints.maxAngVel = v; })} />
      </More>
      {(path.ranges || []).length > 0 && <div className="wb-group">
        <div className="wb-group-title">Zones</div>
        {path.ranges.map((r, i) => (
          <button key={i} className="wb-list-row" onClick={() => setSelection({ kind: "zone", index: i })}>
            <span>{r.name || "Zone"}</span><span className="num">{r.maxVel != null ? r.maxVel.toFixed(2) : "—"}<span className="wb-unit"> m/s</span></span>
          </button>
        ))}
      </div>}
      {(path.markers || []).length > 0 && <div className="wb-group">
        <div className="wb-group-title">Commands</div>
        {[...path.markers].sort((a, b) => a.f - b.f).map((m) => (
          <button key={m.id} className="wb-list-row" onClick={() => setSelection({ kind: "command", id: m.id })}>
            <span className="wb-ellipsis">{commandLabel(m)}</span><span className="num">{timeAtF(plan.derived, m.f).toFixed(2)}<span className="wb-unit"> s</span></span>
          </button>
        ))}
      </div>}
    </>;
  }

  return (
    <>
      <div className="wb-head wb-rail-head">
        <span className="wb-rail-title">{title}</span>
        {sel && <button className="wb-mini" onClick={() => setSelection(null)} aria-label="Deselect" title="Esc"><Icon name="x" /></button>}
      </div>
      {topIssue && (
        <div className={"wb-problem " + topIssue.severity} role="alert">
          <span className="wb-problem-dot" aria-hidden="true" />
          <span className="wb-problem-text">{issueLabel(topIssue, path)}</span>
          {fix && <button className="wb-problem-fix" onClick={fix.run}>{fix.label}</button>}
        </div>
      )}
      <div className="wb-rail-body">{body}</div>
      {del && <div className="wb-rail-foot"><button className="wb-ghost wb-danger" onClick={deleteSelection}>{del}<kbd>⌫</kbd></button></div>}
    </>
  );
}

function More({ children }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="wb-group wb-more">
      <button className="wb-more-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="chev" className={open ? "open" : ""} />More
      </button>
      {open && children}
    </div>
  );
}
