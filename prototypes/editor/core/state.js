// Prototype state: project + undo, live planning (never blocks), playback, simulated push.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { editorGeometry, withTiming } from "./planning";
import { removeWaypoint } from "../../../src/renderer/lib/pathEditing";
import { createProject } from "./project";
import { buildWaypoints } from "../../../src/shared/project/defaults";

const clone = (value) => JSON.parse(JSON.stringify(value));

/** Project with undo. `edit(fn, phase)`: phase 'begin' | 'update' | 'end' groups a drag; 'cancel' restores it without history. */
export function useProjectState() {
  const [state, setState] = useState(() => {
    const project = createProject();
    if (new URLSearchParams(location.search).get("scenario") === "recovery") {
      const path = project.paths[0];
      path.waypoints = buildWaypoints([{ x: 2, y: 2, segType: "line" }, { x: 7, y: 2 }]);
      path.markers = []; path.ranges = []; path.headingMode = "tangent";
      path.startVel = 0; path.goalVel = 4;
    }
    return { project, activeId: project.paths[0].id };
  });
  const past = useRef([]);
  const future = useRef([]);
  const dragBase = useRef(null);
  const [, bump] = useState(0);

  const activePath = state.project.paths.find((p) => p.id === state.activeId) || state.project.paths[0];

  const apply = useCallback((fn) => {
    setState((s) => ({ ...s, project: { ...s.project, paths: s.project.paths.map((p) => (p.id === s.activeId ? fn(clone(p)) : p)) } }));
  }, []);

  const edit = useCallback((fn, phase = "commit") => {
    setState((s) => {
      if (phase === "cancel") {
        const project = dragBase.current;
        dragBase.current = null;
        return project ? { ...s, project } : s;
      }
      if (phase === "begin" || phase === "commit") {
        if (phase === "begin") dragBase.current = s.project;
        else { past.current.push(s.project); future.current = []; }
      }
      if (phase === "end") {
        if (dragBase.current) { past.current.push(dragBase.current); future.current = []; dragBase.current = null; }
        return s;
      }
      return { ...s, project: { ...s.project, paths: s.project.paths.map((p) => (p.id === s.activeId ? fn(clone(p)) : p)) } };
    });
    bump((n) => n + 1);
  }, []);

  const editProject = useCallback((fn) => {
    setState((s) => { past.current.push(s.project); future.current = []; return { ...s, ...fn(s) }; });
    bump((n) => n + 1);
  }, []);

  const undo = useCallback(() => {
    setState((s) => {
      const prev = past.current.pop();
      if (!prev) return s;
      future.current.push(s.project);
      return { ...s, project: prev };
    });
    bump((n) => n + 1);
  }, []);
  const redo = useCallback(() => {
    setState((s) => {
      const next = future.current.pop();
      if (!next) return s;
      past.current.push(s.project);
      return { ...s, project: next };
    });
    bump((n) => n + 1);
  }, []);

  const setActiveId = useCallback((activeId) => setState((s) => ({ ...s, activeId })), []);

  return {
    project: state.project,
    activePath,
    activeId: activePath.id,
    setActiveId,
    edit,
    editProject,
    apply,
    undo,
    redo,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
  };
}

/** Persistent planner worker: coalesce edits, ignore stale results, keep input usable. */
export function usePlan(path, robot, field) {
  const geometry = useMemo(() => editorGeometry(path), [path]);
  const worker = useRef(null), queue = useRef(null), busy = useRef(false);
  const sequence = useRef(0), current = useRef(null), timer = useRef(null);
  const [finished, setFinished] = useState(null);
  const enqueue = useRef(null);

  useEffect(() => {
    let disposed = false;
    const sendNext = () => {
      if (disposed || busy.current || !queue.current) return;
      const job = queue.current;
      queue.current = null;
      busy.current = true;
      if (!worker.current && !startWorker()) return;
      try {
        worker.current.postMessage(job);
      } catch {
        worker.current.terminate();
        worker.current = null;
        busy.current = false;
        if (job.id === current.current?.id) setFinished({ ...current.current, failure: "Timing unavailable" });
        sendNext();
        return;
      }
      timer.current = setTimeout(() => {
        worker.current.terminate();
        worker.current = null;
        busy.current = false;
        if (job.id === current.current?.id) setFinished({ ...current.current, failure: "Timing took too long" });
        sendNext();
      }, 5000);
    };
    const startWorker = () => {
      try {
        worker.current = new Worker(new URL("./planning-worker.js", import.meta.url), { type: "module" });
      } catch {
        busy.current = false;
        setFinished({ ...current.current, failure: "Timing unavailable" });
        return false;
      }
      const instance = worker.current;
      worker.current.onmessage = ({ data }) => {
        if (disposed || worker.current !== instance) return;
        clearTimeout(timer.current);
        busy.current = false;
        if (data.id === current.current?.id) setFinished({ ...current.current, result: data.result });
        sendNext();
      };
      worker.current.onerror = () => {
        if (disposed || worker.current !== instance) return;
        clearTimeout(timer.current);
        worker.current.terminate();
        worker.current = null;
        busy.current = false;
        if (!queue.current) setFinished({ ...current.current, failure: "Timing unavailable" });
        sendNext();
      };
      return true;
    };
    startWorker();
    // enqueue is kept outside the Worker so recreation after a timeout retains it.
    enqueue.current = sendNext;
    return () => { disposed = true; clearTimeout(timer.current); worker.current?.terminate(); queue.current = null; busy.current = false; };
  }, []);
  useEffect(() => {
    const id = ++sequence.current;
    current.current = { id, path, robot, field };
    queue.current = { id, input: { path, robot, field } };
    enqueue.current?.();
  }, [path, robot, field]);

  const ready = finished?.path === path && finished?.robot === robot && finished?.field === field;
  const result = ready ? finished.result : null;
  // Display only: while an edit is being timed, keep drawing this path's last timing (speed colors, playback)
  // instead of a flat path. Status, issues and push never use it; `stale` says it is the previous result.
  const lastTimed = useRef(null);
  if (result?.bestEffort?.samples?.length) lastTimed.current = { id: path.id, result };
  const shown = result ?? (lastTimed.current?.id === path.id ? lastTimed.current.result : null);
  const derived = useMemo(() => withTiming(geometry, shown), [geometry, shown]);
  return {
    derived, stale: !ready && Boolean(shown), totalTime: result?.bestEffort?.totalTimeS ?? (finished?.path?.id === path.id ? finished.result?.bestEffort?.totalTimeS : 0) ?? 0,
    status: !ready ? "pending" : result?.status === "ok" ? "ok" : "issue",
    issues: result?.issues ?? (ready && finished.failure ? [{ f0: 0, f1: 1, whole: true, severity: "error", message: finished.failure }] : []),
  };
}

/** Playback clock. */
export function usePlayback(totalTime) {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const raf = useRef(0);
  useEffect(() => {
    if (!playing) return undefined;
    let last = performance.now();
    const tick = (now) => {
      const dt = (now - last) / 1000;
      last = now;
      setT((prev) => {
        const next = prev + dt;
        if (next >= totalTime) { setPlaying(false); return totalTime; }
        return next;
      });
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, totalTime]);
  useEffect(() => { if (t > totalTime) setT(totalTime); }, [t, totalTime]);
  const toggle = useCallback(() => {
    setPlaying((p) => {
      if (!p) setT((prev) => (prev >= totalTime - 1e-3 ? 0 : prev));
      return !p;
    });
  }, [totalTime]);
  return { t, playing, toggle, seek: (value) => { setPlaying(false); setT(Math.max(0, Math.min(totalTime, value))); }, setPlaying };
}

// ---- Simulated push (SIMULATED: no robot connection in the prototype) ----
const pushStore = (() => {
  let state = { destination: { host: "10.12.34.2", folder: "Paths" }, pushed: {}, phase: "idle", lastAt: null, lastCount: 0, failed: null };
  const listeners = new Set();
  return {
    get: () => state,
    set: (patch) => { state = { ...state, ...patch }; listeners.forEach((l) => l()); },
    subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
  };
})();

const fingerprint = (path, robot, field) => JSON.stringify([path, robot, field]);
let pushGeneration = 0;

// Simulated push still validates the frozen click-time paths with the strict-status contract.
function pushStatuses(inputs) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./planning-worker.js", import.meta.url), { type: "module" });
    let settled = false;
    const finish = (statuses, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); worker.terminate();
      if (error) reject(error); else resolve(statuses);
    };
    const timer = setTimeout(() => finish(null, new Error("Timing took too long")), 5000);
    worker.onmessage = ({ data }) => finish(data.statuses);
    worker.onerror = () => finish(null, new Error("Timing unavailable"));
    worker.onmessageerror = () => finish(null, new Error("Timing unavailable"));
    try {
      worker.postMessage({ id: 1, inputs });
    } catch (error) {
      finish(null, error);
    }
  });
}

/**
 * Push model the variants render. `changedIds` = paths that differ from the last verified
 * push from this computer. `push(ids)` sends exactly those ids; a path with a hard issue is refused.
 * Resolves to { sentIds, refusedIds, error? } for the frozen requested paths;
 * resolves to null for abandoned owners or a second dispatch while sending.
 * A later edit can remain changed even though its clicked revision was sent.
 */
export function usePush(project) {
  const state = useSyncExternalStore(pushStore.subscribe, pushStore.get);
  const owner = useRef(null);
  useEffect(() => {
    const generation = ++pushGeneration;
    owner.current = generation;
    // Pretend most paths were pushed earlier; the first two have local changes.
    const pushed = {};
    project.paths.forEach((p, i) => { if (i > 1) pushed[p.id] = fingerprint(p, project.robot, project.field); });
    pushStore.set({ pushed, phase: "idle", sending: [], failed: null, lastAt: Date.now() - 1000 * 60 * 14, lastCount: 3 });
    return () => {
      owner.current = null;
      if (pushGeneration === generation) pushGeneration++;
    };
  }, []);
  const changedIds = project.paths.filter((p) => state.pushed[p.id] !== fingerprint(p, project.robot, project.field)).map((p) => p.id);
  const push = useCallback(async (ids, { blockedIds = [] } = {}) => {
    const generation = owner.current;
    const isCurrent = () => generation !== null && owner.current === generation && pushGeneration === generation;
    if (!isCurrent()) return null;
    if (pushStore.get().phase === "sending") return null;
    const snapshot = clone(project);
    const requested = snapshot.paths.filter((p) => ids.includes(p.id));
    const selected = requested.filter((p) => !blockedIds.includes(p.id));
    const receipt = (sentIds, error) => ({
      sentIds,
      refusedIds: requested.filter((p) => !sentIds.includes(p.id)).map((p) => p.id),
      ...(error ? { error } : {}),
    });
    if (!selected.length) {
      pushStore.set({ phase: "refused", failed: "Fix the red path first" });
      return receipt([], "Fix the red path first");
    }
    pushStore.set({ phase: "sending", failed: null, sending: selected.map((p) => p.id) });
    let statuses;
    try {
      statuses = await pushStatuses(selected.map((path) => ({ path, robot: snapshot.robot, field: snapshot.field })));
    } catch (error) {
      if (!isCurrent()) return null;
      pushStore.set({ phase: "refused", failed: error.message, sending: [] });
      return receipt([], error.message);
    }
    if (!isCurrent()) return null;
    const sendable = selected.filter((_p, i) => Array.isArray(statuses) && statuses[i] === "ok");
    if (!sendable.length) {
      pushStore.set({ phase: "refused", failed: "Fix the red path first", sending: [] });
      return receipt([], "Fix the red path first");
    }
    pushStore.set({ sending: sendable.map((p) => p.id) });
    await new Promise((r) => setTimeout(r, 420 + 160 * sendable.length));
    if (!isCurrent()) return null;
    const pushed = { ...pushStore.get().pushed };
    sendable.forEach((path) => { pushed[path.id] = fingerprint(path, snapshot.robot, snapshot.field); });
    pushStore.set({ phase: "done", pushed, lastAt: Date.now(), lastCount: sendable.length, sending: [],
      failed: sendable.length < selected.length ? "Some paths need repair" : null });
    return receipt(sendable.map((p) => p.id), sendable.length < requested.length ? "Some paths need repair" : undefined);
  }, [project]);
  return { ...state, changedIds, push };
}

/** Field-editing keyboard: Delete, Escape, arrows, undo/redo, Space. Ignores typing targets. */
export function useEditorKeys({ selection, setSelection, edit, undo, redo, togglePlay, onPush }) {
  useEffect(() => {
    const onKey = (e) => {
      const el = e.target;
      if (el && el.closest && el.closest("input,textarea,select,[contenteditable=true]")) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (mod && k === "y") { e.preventDefault(); redo(); return; }
      if (mod && e.shiftKey && k === "p") { e.preventDefault(); onPush?.(); return; }
      if (e.key === " " && !el.closest?.("button")) { e.preventDefault(); togglePlay?.(); return; }
      if (e.key === "Escape") { setSelection(null); return; }
      if (!selection) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if (selection.kind === "waypoint") edit((p) => (p.waypoints.length > 2 && p.waypoints[selection.index] ? removeWaypoint(p, selection.index) : p));
        if (selection.kind === "command") edit((p) => ({ ...p, markers: p.markers.filter((m) => m.id !== selection.id) }));
        setSelection(null);
        return;
      }
      if (selection.kind === "waypoint" && e.key.startsWith("Arrow")) {
        e.preventDefault();
        const step = e.shiftKey ? 0.25 : e.altKey ? 0.01 : 0.05;
        const dx = e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0;
        const dy = e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0;
        edit((p) => {
          const w = p.waypoints[selection.index];
          if (!w) return p;
          w.x += dx; w.y += dy;
          if (w.prevC) { w.prevC.x += dx; w.prevC.y += dy; }
          if (w.nextC) { w.nextC.x += dx; w.nextC.y += dy; }
          return p;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, setSelection, edit, undo, redo, togglePlay, onPush]);
}
