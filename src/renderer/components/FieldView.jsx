import * as React from "react";
import { FieldScene } from "../assets/field-scene";
import { displayedPoseAtTime, hoverWorldPoint, hoverVisits } from "../lib/pathHover";
import fieldImage from "../assets/field.png";
import { FIELD_W, FIELD_H } from "../../shared/math/fieldBounds";
import { FIELD_IMAGE, FIELD_IMAGE_SCALE, worldToFieldImage, fieldImageToWorld } from "../../shared/field/imageCalibration";
import { PointerDrag } from "../hooks/usePointerDrag";
import { PM } from "../lib/pathMath";
import { wheelZoomFactor } from "../lib/zoom";
import { UI } from "./ui";
import { isWholeIssue, plainProblem } from './planProblems';
import { placeProblemBadges, placeFieldLabel, fieldTextWidth, problemBadgeIndexes, problemCaption } from './fieldProblems';

  const { useRef, useState, useEffect, useMemo, useCallback, useId } = React;
  const h = React.createElement;

  // ---- field calibration (image px) ----
  const { width: IMG_W, height: IMG_H, left: X0, right: X1, top: Y0, bottom: Y1 } = FIELD_IMAGE;
  const { x: SX, y: SY } = FIELD_IMAGE_SCALE;

  // muted semantic colors (reserved for meaning, low saturation)
  const C_START = '#4bbf86', C_END = '#d2655f', C_NODE = '#8b94a2', C_NEUTRAL = '#9aa3b0';
  function rangeLabelIndexes(rangeCount, selectedIndex, maximum = 80) {
    const limit = Math.max(0, Math.floor(maximum));
    const indexes = new Set();
    if (!limit) return indexes;
    const step = Math.max(1, Math.ceil(rangeCount / limit));
    for (let index = 0; index < rangeCount && indexes.size < limit; index += step) indexes.add(index);
    if (Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < rangeCount && !indexes.has(selectedIndex)) {
      if (indexes.size >= limit) indexes.delete(Array.from(indexes).at(-1));
      indexes.add(selectedIndex);
    }
    return indexes;
  }

  // Labels render in the root SVG, while the HTML rail stays in CSS pixels.
  // xMidYMid meet can letterbox on either axis; width-only scaling is insufficient.
  function toolRailLabelObstacle(rail, viewport, view) {
    if (!rail || !(viewport.width > 0) || !(viewport.height > 0) || !(view.w > 0) || !(view.h > 0)) return null;
    const scale = Math.min(viewport.width / view.w, viewport.height / view.h);
    const offsetX = (viewport.width - view.w * scale) / 2, offsetY = (viewport.height - view.h * scale) / 2;
    const margin = 6;
    return { x: view.x + (rail.x - margin - offsetX) / scale, y: view.y + (rail.y - margin - offsetY) / scale,
      w: (rail.w + margin * 2) / scale, h: (rail.h + margin * 2) / scale };
  }

  // A gesture owns only the draft/revisions it produced. Store emissions are
  // synchronous, so ignore our own writes and retire before another move.
  function createFieldGestureOwner(store, pathId, retire) {
    let revision = store?.getRevision(), canceled = store?.getCancelRevision();
    let snapshot = store?.getSnapshot(), started = false, writing = false, disposed = false;
    const current = () => !disposed && (!store || writing || (store.getRevision() === revision
      && store.getCancelRevision() === canceled && store.getSnapshot() === snapshot
      && (!started || snapshot?.id === pathId)));
    const stop = () => { if (disposed) return; disposed = true; unsubscribe?.(); retire(); };
    const unsubscribe = store?.subscribe(() => { if (!current()) stop(); });
    return {
      current,
      write(callback, begin = false) {
        if (!current() || (begin && store?.getSnapshot())) { stop(); return false; }
        if (begin) started = true;
        const before = revision, beforeCancel = canceled;
        writing = true;
        try { callback(); }
        finally { writing = false; revision = store?.getRevision(); canceled = store?.getCancelRevision(); snapshot = store?.getSnapshot(); }
        // Each field action begins or updates once. Nested resolution/restart
        // must not let this owner adopt another gesture's same-path draft.
        if (!current() || (store && (revision > before + 1 || canceled !== beforeCancel))) { stop(); return false; }
        return true;
      },
      dispose() { disposed = true; unsubscribe?.(); },
    };
  }

  function fieldRangeEndpoint(range, side, fraction, length) {
    const inverted = range.f0 > range.f1, which = inverted ? 1 - side : side;
    const other = side ? Math.min(range.f0, range.f1) : Math.max(range.f0, range.f1);
    let f = side ? Math.max(other, Math.min(1, fraction)) : Math.min(other, Math.max(0, fraction));
    // App rounds distance positions to centimetres. Keep the authored result
    // on its side even when an older opposing distance has finer precision.
    if (range.anchor === 'dist' && length > 0) {
      const rounded = +(f * length).toFixed(2), boundary = other * length;
      if (!side && rounded > boundary + 1e-9) f = Math.floor(boundary * 100 + 1e-9) / 100 / length;
      if (side && rounded < boundary - 1e-9) f = Math.ceil(boundary * 100 - 1e-9) / 100 / length;
    }
    return { which, f };
  }

  function fieldGestureValue(path, gesture) {
    const role = gesture.role, index = gesture.idx;
    const record = role === 'ct' ? path?.waypoints[index >> 1]
      : role === 'wp' || role === 'head' || role === 'look' ? path?.waypoints[index]
      : role === 'rt' || role === 'rth' ? path?.targets[index]
      : role === 'em' ? path?.markers[index] : path?.ranges?.[index];
    return JSON.stringify(record);
  }

  const localFootprint = (robot) => robot.footprint && robot.footprint.kind === 'polygon' && Array.isArray(robot.footprint.verticesM)
    ? robot.footprint.verticesM
    : [{ x: -robot.l / 2, y: -robot.w / 2 }, { x: robot.l / 2, y: -robot.w / 2 }, { x: robot.l / 2, y: robot.w / 2 }, { x: -robot.l / 2, y: robot.w / 2 }];
  const footprintPoints = (robot, scale) => localFootprint(robot).map((point) => `${point.x * SX * scale},${-point.y * SY * scale}`).join(' ');
  const forwardExtent = (robot) => Math.max(...localFootprint(robot).map((point) => point.x)) * SX;

  // Routine segment points are immutable planner output in field-image units,
  // independent of zoom and playback, so their SVG geometry is built once.
  const routeGeometry = new WeakMap();
  function routineRouteGeometry(pts) {
    let geometry = routeGeometry.get(pts);
    if (geometry) return geometry;
    const toImage = (p) => ({ x: X0 + p.x * SX, y: Y1 - p.y * SY });
    let d = '';
    pts.forEach((p, k) => { const q = toImage(p); d += (k ? ' L ' : 'M ') + q.x.toFixed(1) + ' ' + q.y.toFixed(1); });
    geometry = { d, start: toImage(pts[0]), end: toImage(pts[pts.length - 1]), mid: toImage(pts[Math.floor(pts.length / 2)]) };
    routeGeometry.set(pts, geometry);
    return geometry;
  }

  function HoverGhost({ store, context, derived, doc, robot, W2P, P }) {
    const hover = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    if (!context.eligible || hover?.context !== context || hover.source !== 'timeline') return null;
    const pose = displayedPoseAtTime(hover.t, derived, doc);
    if (!pose) return null;
    const point = W2P(pose);
    return h('g', { className: 'field-hover-ghost', transform: `translate(${point.x} ${point.y}) rotate(${-pose.heading * 180 / Math.PI})`,
      'aria-hidden': true, style: { pointerEvents: 'none' } },
      h('polygon', { points: footprintPoints(robot, 1), fill: 'none', stroke: 'rgba(255,255,255,.65)', strokeWidth: P(2), strokeDasharray: `${P(5)} ${P(4)}`, strokeLinejoin: 'round' }),
      h('line', { x1: 0, y1: 0, x2: forwardExtent(robot) + P(3), y2: 0, stroke: 'rgba(255,255,255,.65)', strokeWidth: P(2) }));
  }

  function FieldView(props) {
    const { doc, derived, editStore, insertionPreview, proposalPreviews, sel, tool, view, setView, alliance, showGrid, robot, drive, accent, metric, playTime, actions, routine, routinePose, problems, hoverStore, hoverContext } = props;
    const interactionReady = props.interactionReady !== false;
    const showHandles = props.showHandles !== false;
    const svgRef = useRef(null);
    const captionId = useId();
    const [canvasLayout, setCanvasLayout] = useState({ width: 1200, height: 0, clientWidth: 1200, rail: null });
    const cw = canvasLayout.clientWidth;
    const [preview, setPreview] = useState(null);
    const [snap, setSnap] = useState(null);
    const [visitFocus, setVisitFocus] = useState(null);
    const visitFocusRef = useRef(null);
    const actionsRef = useRef(actions);
    actionsRef.current = actions;
    const drag = useRef(null);
    const pointerDrag = PointerDrag.useController();
    const contextRef = useRef(null);
    const selectionKey = sel.kind + ':' + sel.idx;
    contextRef.current = { pathId: doc.id, selectionKey, tool, routine: Boolean(routine) };
    const lastInspectPress = useRef({ key: null, at: 0 });
    const isTank = drive === 'tank';

    const clampWorld = (p) => ({ x: Math.max(0, Math.min(FIELD_W, p.x)), y: Math.max(0, Math.min(FIELD_H, p.y)) });
    const wx = (x) => X0 + x * SX;
    const wy = (y) => Y1 - y * SY;
    const W2P = worldToFieldImage;

    const clientToWorld = useCallback((cx, cy, bounded = true) => {
      const svg = svgRef.current; if (!svg) return { x: 0, y: 0 };
      const ctm = svg.getScreenCTM(); if (!ctm) return { x: 0, y: 0 };
      const pt = svg.createSVGPoint(); pt.x = cx; pt.y = cy;
      const u = pt.matrixTransform(ctm.inverse());
      const world = fieldImageToWorld(u);
      return bounded ? clampWorld(world) : world;
    }, []);

    useEffect(() => {
      const svg = svgRef.current; if (!svg) return;
      const field = svg.closest('.fieldcol'), rail = field?.querySelector('.toolrail');
      const measure = () => {
        const box = svg.getBoundingClientRect(), railBox = rail?.getBoundingClientRect();
        const next = { width: box.width, height: box.height, clientWidth: svg.clientWidth || 1200,
          rail: railBox && railBox.width > 0 && railBox.height > 0
            ? { x: railBox.left - box.left, y: railBox.top - box.top, w: railBox.width, h: railBox.height } : null };
        setCanvasLayout(previous => previous.width === next.width && previous.height === next.height && previous.clientWidth === next.clientWidth
          && previous.rail?.x === next.rail?.x && previous.rail?.y === next.rail?.y
          && previous.rail?.w === next.rail?.w && previous.rail?.h === next.rail?.h ? previous : next);
      };
      const ro = new ResizeObserver(measure);
      ro.observe(svg); if (field) ro.observe(field); if (rail) ro.observe(rail);
      measure();
      return () => ro.disconnect();
    }, [Boolean(routine)]);
    const toolRailObstacle = useMemo(() => toolRailLabelObstacle(canvasLayout.rail, canvasLayout, view),
      [canvasLayout, view.x, view.y, view.w, view.h]);

    const upp = view.w / Math.max(1, cw);
    const P = (px) => px * upp;
    const pts = derived.sample.pts;
    const visitTolerance = P(18) / Math.min(SX, SY);

    const updateVisitFocus = useCallback((next) => {
      visitFocusRef.current = next;
      setVisitFocus(next);
    }, []);

    useEffect(() => updateVisitFocus(null), [doc.id, updateVisitFocus]);
    useEffect(() => {
      const d = drag.current;
      if (!d) return;
      if (d.pathId !== doc.id || d.selectionKey !== selectionKey || d.tool !== tool || d.routine !== Boolean(routine)) pointerDrag.cancel({ flush: false });
      else d.selectionEstablished = true;
    }, [doc.id, selectionKey, tool, Boolean(routine), pointerDrag]);
    useEffect(() => {
      // Push can own an unmoved press without a draft to finish. Retire on
      // opening, even if its dialog closes before the next pointer movement.
      const observer = new MutationObserver(() => {
        if (drag.current && document.querySelector('dialog:modal, [role="dialog"][aria-modal="true"]')) pointerDrag.cancel({ flush: false });
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'aria-modal', 'role'] });
      return () => observer.disconnect();
    }, [pointerDrag]);

    const visitsAt = useCallback((world) => {
      const candidates = PM.nearestVisits(world.x, world.y, pts, { tolerance: visitTolerance });
      if (!derived.wpFrac || derived.wpFrac.length < 2) return candidates;
      return candidates.map((candidate) => {
        let seg = derived.wpFrac.length - 2;
        for (let i = 0; i < derived.wpFrac.length - 1; i++) {
          if (candidate.f <= derived.wpFrac[i + 1] + 1e-9) { seg = i; break; }
        }
        return { ...candidate, seg };
      });
    }, [pts, visitTolerance, derived.wpFrac]);

    const hoverProducer = useRef(null);
    React.useLayoutEffect(() => {
      hoverProducer.current = (x, y) => {
        if (routine || !interactionReady || drag.current) return null;
        const world = hoverWorldPoint(svgRef.current, x, y, clientToWorld);
        return world && hoverVisits(visitsAt(world), world, visitTolerance, visitFocusRef.current);
      };
      // Old screen coordinates cannot be interpreted through a newly committed pan/zoom/scale.
      hoverStore?.clear('field', hoverContext);
      return () => { hoverProducer.current = null; hoverStore?.clear('field', hoverContext); };
    }, [hoverStore, hoverContext, visitsAt, visitTolerance, clientToWorld, routine, interactionReady, view.x, view.y, view.w, view.h, cw, alliance]);
    const onHoverMove = event => {
      if (!hoverStore) return;
      if (event.buttons) { hoverStore.clear(undefined, hoverContext); return; }
      const { clientX, clientY } = event;
      hoverStore.queueField(hoverContext, () => hoverProducer.current?.(clientX, clientY) || null);
    };

    const resolveVisit = useCallback((world, options) => {
      const opts = options || {}, candidates = visitsAt(world);
      if (!candidates.length) return null;
      const previous = visitFocusRef.current;
      const sameConflict = previous && previous.candidates.length === candidates.length
        && Math.hypot(previous.anchor.x - world.x, previous.anchor.y - world.y) <= visitTolerance * 0.8
        && previous.candidates.every((candidate, index) => Math.abs(candidate.f - candidates[index].f) <= 0.01);
      let affinityIndex = 0;
      if (Number.isFinite(opts.nearFraction)) {
        for (let i = 1; i < candidates.length; i++) {
          if (Math.abs(candidates[i].f - opts.nearFraction) < Math.abs(candidates[affinityIndex].f - opts.nearFraction)) affinityIndex = i;
        }
      } else {
        for (let i = 1; i < candidates.length; i++) {
          if (candidates[i].distance < candidates[affinityIndex].distance) affinityIndex = i;
        }
      }
      const index = opts.cycle && sameConflict
        ? (previous.index + 1) % candidates.length
        : (sameConflict && opts.preserve !== false && !Number.isFinite(opts.nearFraction) ? previous.index : affinityIndex);
      const next = { candidates, index, anchor: { x: world.x, y: world.y } };
      updateVisitFocus(next);
      return candidates[index];
    }, [visitsAt, visitTolerance, updateVisitFocus]);

    const projectVisit = useCallback((world, nearFraction) => resolveVisit(world, { nearFraction, preserve: false }), [resolveVisit]);

    const resolveWaypointVisit = useCallback((world, cycle, preferredIndex) => {
      if (!derived.wpFrac) return null;
      const candidates = doc.waypoints.map((waypoint, index) => ({
        x: waypoint.x,
        y: waypoint.y,
        f: Number.isFinite(derived.wpFrac[index]) ? derived.wpFrac[index] : 0,
        seg: Math.min(index, Math.max(0, doc.waypoints.length - 2)),
        wp: index,
        distance: Math.hypot(waypoint.x - world.x, waypoint.y - world.y),
      })).filter((candidate) => candidate.distance <= visitTolerance)
        .sort((a, b) => a.wp - b.wp);
      if (candidates.length < 2) return candidates[0] || null;
      const previous = visitFocusRef.current;
      const sameConflict = previous && previous.candidates.length === candidates.length
        && previous.candidates.every((candidate, index) => candidate.wp === candidates[index].wp);
      let index = Number.isInteger(preferredIndex) ? candidates.findIndex((candidate) => candidate.wp === preferredIndex) : -1;
      if (index < 0) {
        index = 0;
        for (let i = 1; i < candidates.length; i++) if (candidates[i].distance < candidates[index].distance) index = i;
      }
      if (cycle && sameConflict) index = (previous.index + 1) % candidates.length;
      const next = { candidates, index, anchor: { x: world.x, y: world.y } };
      updateVisitFocus(next);
      return candidates[index];
    }, [derived.wpFrac, doc.waypoints, visitTolerance, updateVisitFocus]);

    useEffect(() => {
      if (!pts.length) { updateVisitFocus(null); return; }
      let fraction = null;
      if (sel.kind === 'seg' && derived.wpFrac && derived.wpFrac.length > sel.idx + 1) fraction = (derived.wpFrac[sel.idx] + derived.wpFrac[sel.idx + 1]) / 2;
      else if (sel.kind === 'wp' && derived.wpFrac && Number.isFinite(derived.wpFrac[sel.idx])) fraction = derived.wpFrac[sel.idx];
      else if (sel.kind === 'rt' && doc.targets[sel.idx]) fraction = PM.featureFraction(doc.targets[sel.idx], derived.sample);
      else if (sel.kind === 'em' && doc.markers[sel.idx]) fraction = PM.featureFraction(doc.markers[sel.idx], derived.sample);
      else if (sel.kind === 'cr' && doc.ranges && doc.ranges[sel.idx]) {
        const range = (derived.effRanges && derived.effRanges[sel.idx]) || doc.ranges[sel.idx];
        fraction = (range.f0 + range.f1) / 2;
      }
      if (!Number.isFinite(fraction)) return;
      const current = visitFocusRef.current && visitFocusRef.current.candidates[visitFocusRef.current.index];
      if (sel.kind === 'wp' && doc.waypoints[sel.idx]) {
        const waypoint = doc.waypoints[sel.idx];
        const coincidentCount = doc.waypoints.reduce((count, candidate) => count + Number(Math.hypot(candidate.x - waypoint.x, candidate.y - waypoint.y) <= visitTolerance), 0);
        if (coincidentCount > 1) {
          if (current && current.wp === sel.idx) return;
          resolveWaypointVisit(waypoint, false, sel.idx);
          return;
        }
      }
      if (sel.kind === 'seg' && current && current.seg === sel.idx) return;
      if (current && !Number.isInteger(current.wp) && Math.abs(current.f - fraction) <= 0.015) return;
      const point = PM.pointAtFraction(fraction, pts);
      resolveVisit(point, { nearFraction: fraction, preserve: false });
    }, [sel, doc, derived, pts, visitTolerance, resolveVisit, resolveWaypointVisit, updateVisitFocus]);

    useEffect(() => {
      const onVisitKey = (event) => {
        if (event.defaultPrevented || document.querySelector('dialog:modal, [role="dialog"][aria-modal="true"]')) return;
        const target = event.target;
        if (target && (target.closest?.('input, textarea, select, button, summary, [data-role="issue"], a[href], [role="menu"], [role="listbox"], .editor-library') || target.isContentEditable)) return;
        if (event.key === 'Escape' && visitFocusRef.current) { updateVisitFocus(null); return; }
        const direction = event.key === ']' || event.code === 'BracketRight' ? 1
          : (event.key === '[' || event.code === 'BracketLeft' ? -1 : 0);
        if (!direction) return;
        const current = visitFocusRef.current;
        if (!current || current.candidates.length < 2) return;
        event.preventDefault();
        const index = (current.index + direction + current.candidates.length) % current.candidates.length;
        const next = { ...current, index };
        updateVisitFocus(next);
        const candidate = next.candidates[index];
        if (actionsRef.current.select) actionsRef.current.select(Number.isInteger(candidate.wp) ? 'wp' : 'seg', Number.isInteger(candidate.wp) ? candidate.wp : candidate.seg);
      };
      window.addEventListener('keydown', onVisitKey, true);
      return () => window.removeEventListener('keydown', onVisitKey, true);
    }, [updateVisitFocus]);

    const startRangeDrag = (e, world, initialVisit) => {
      const visit = initialVisit || resolveVisit(world);
      const f0 = visit ? visit.f : PM.nearestFraction(world.x, world.y, pts);
      startPointer(e, { role: 'newrange', f0, f1: f0, lastF: f0, moved: false });
      setPreview({ f0, f1: f0 });
    };

    const inspectIdentity = (eventTarget) => {
      const target = eventTarget.closest ? eventTarget.closest('[data-role]') : eventTarget;
      const role = target && target.getAttribute && target.getAttribute('data-role');
      const index = parseInt(target && target.getAttribute && target.getAttribute('data-idx'), 10);
      let kind = null;
      if (role === 'wp' || role === 'head' || role === 'ct') kind = 'wp';
      else if (role === 'rt' || role === 'rth') kind = 'rt';
      else if (role === 'em') kind = 'em';
      else if (role === 'cr' || role === 'rs' || role === 're') kind = 'cr';
      else if (role === 'seg' || role === 'look') kind = 'seg';
      if (!kind || !Number.isInteger(index)) return null;
      let selectedIndex = role === 'ct' ? index >> 1 : index;
      if (kind === 'seg' && visitFocusRef.current) {
        const focused = visitFocusRef.current.candidates[visitFocusRef.current.index];
        if (focused && Number.isInteger(focused.seg)) selectedIndex = focused.seg;
      }
      return { kind, selectedIndex, pressKey: kind + ':' + selectedIndex };
    };

    const inspectTarget = (eventTarget) => {
      const item = inspectIdentity(eventTarget);
      if (!item) return false;
      actions.select(item.kind, item.selectedIndex);
      if (actions.openInspector) actions.openInspector();
      return true;
    };

    const onDown = (e) => {
      if (e.button !== 0 && e.button !== 1) return;
      if (!interactionReady) return;
      if (document.querySelector('dialog:modal, [role="dialog"][aria-modal="true"]')) return;
      e.preventDefault();
      pointerDrag.cancel();
      const t = e.target.closest?.('[data-role]') || e.target;
      const role = t.getAttribute && t.getAttribute('data-role');
      if (role === 'issue') {
        // A badge owns every primary press, including its children, Shift and placement tools.
        if (e.button === 0) {
          if (problems?.onSelect(Number(t.getAttribute('data-idx')))) t.focus({ preventScroll: true });
        } else startPointer(e, { role: 'bg', start: { cx: e.clientX, cy: e.clientY }, vb0: { ...view }, moved: false, mid: true });
        return;
      }
      if (routine) {
        if (role === 'rpath') {
          const id = t.getAttribute('data-idx');
          if (e.button === 0 && e.shiftKey && actions.deleteNode) actions.deleteNode(id);
          else if (actions.selectNode) actions.selectNode(id);
          drag.current = null; return;
        }
        startPointer(e, { role: 'bg', start: { cx: e.clientX, cy: e.clientY }, vb0: { ...view }, moved: false, mid: e.button === 1 });
        return;
      }
      const world = clientToWorld(e.clientX, e.clientY);
      if (e.button === 0 && e.shiftKey) {
        const idx = parseInt(t.getAttribute && t.getAttribute('data-idx'), 10);
        let removed = false;
        if (['wp', 'head', 'ct'].includes(role) && actions.delWp) { actions.delWp(role === 'ct' ? idx >> 1 : idx); removed = true; }
        else if ((role === 'seg' || role === 'look') && actions.delWp) { actions.delWp(idx + 1); removed = true; }
        else if ((role === 'rt' || role === 'rth') && actions.delTarget) { actions.delTarget(idx); removed = true; }
        else if (role === 'em' && actions.delMarker) { actions.delMarker(idx); removed = true; }
        else if ((role === 'cr' || role === 'rs' || role === 're') && actions.delRange) { actions.delRange(idx); removed = true; }
        if (removed) { drag.current = null; return; }
      }
      const inspectItem = e.button === 0 ? inspectIdentity(t) : null;
      const pendingInspect = lastInspectPress.current;
      const candidateInspectDouble = inspectItem && pendingInspect.key === inspectItem.pressKey
        && performance.now() - pendingInspect.at <= 550;
      if (!inspectItem) lastInspectPress.current = { key: null, at: 0 };
      if (e.button === 0 && tool === 'waypoint' && !e.altKey && (role === 'bg' || role === 'seg' || role === 'ins')) {
        startPointer(e, { role: 'bg', insertWaypoint: false, start: { cx: e.clientX, cy: e.clientY }, vb0: { ...view }, world, moved: false, mid: false });
        return;
      }
      if (role === 'head') {
        const idx = parseInt(t.getAttribute('data-idx'), 10);
        actions.select('wp', idx);
        startPointer(e, { role: 'head', idx, selectionKey: 'wp:' + idx, inspectItem: { kind: 'wp', selectedIndex: idx, pressKey: 'wp:' + idx }, moved: false, historyStarted: false });
        return;
      }
      if (role === 'seg') {
        const idx = parseInt(t.getAttribute('data-idx'), 10);
        const visit = resolveVisit(world, { cycle: tool === 'select' && !e.altKey && !candidateInspectDouble });
        if (tool === 'range' && pts.length > 1) { startRangeDrag(e, world, visit); return; }
        if (e.altKey || tool === 'rotation' || tool === 'marker') startPointer(e, { role: 'bg', onPath: true, segment: visit ? visit.seg : idx, visit, insertWaypoint: e.altKey, start: { cx: e.clientX, cy: e.clientY }, vb0: { ...view }, world, moved: false, mid: false });
        else {
          const selectedIndex = visit ? visit.seg : idx;
          actions.select('seg', selectedIndex);
          startPointer(e, { role: 'inspect', selectionKey: 'seg:' + selectedIndex, inspectItem: { kind: 'seg', selectedIndex, pressKey: 'seg:' + selectedIndex }, start: { cx: e.clientX, cy: e.clientY }, moved: false });
        }
        return;
      }
      if (role && role !== 'bg' && role !== 'ins') {
        let idx = parseInt(t.getAttribute('data-idx'), 10);
        let cycleWaypoint = false;
        if (role === 'wp' && tool === 'select') {
          const preferred = sel.kind === 'wp' ? sel.idx : idx;
          cycleWaypoint = sel.kind === 'wp' && sel.idx === idx;
          const visit = resolveWaypointVisit(world, false, preferred);
          if (visit && Number.isInteger(visit.wp)) idx = visit.wp;
        }
        let lastF = null;
        if (role === 'rt' && doc.targets[idx]) lastF = PM.featureFraction(doc.targets[idx], derived.sample);
        else if (role === 'em' && doc.markers[idx]) lastF = PM.featureFraction(doc.markers[idx], derived.sample);
        else if ((role === 'rs' || role === 're') && doc.ranges && doc.ranges[idx]) {
          const range = (derived.effRanges && derived.effRanges[idx]) || doc.ranges[idx];
          lastF = role === 'rs' ? Math.min(range.f0, range.f1) : Math.max(range.f0, range.f1);
        }
        let dragInspectItem = inspectItem;
        if (inspectItem && role === 'wp') dragInspectItem = { kind: 'wp', selectedIndex: idx, pressKey: 'wp:' + idx };
        const next = { role, idx, lastF, world, cycleWaypoint, inspectItem: dragInspectItem, moved: false, historyStarted: false };
        if ((role === 'rs' || role === 're') && doc.ranges?.[idx]) next.range = { ...((derived.effRanges && derived.effRanges[idx]) || doc.ranges[idx]) };
        if (role === 'ct') actions.select('wp', idx >> 1);
        else if (role === 'rs' || role === 're') actions.select('cr', idx);
        else if (role === 'rth') actions.select('rt', idx);
        else if (role === 'look') actions.select('seg', idx);
        else if (role === 'cr') actions.select('cr', idx);
        else if (role === 'wp' || role === 'rt' || role === 'em') actions.select(role, idx);
        const kind = role === 'ct' ? 'wp' : role === 'rs' || role === 're' || role === 'cr' ? 'cr' : role === 'rth' ? 'rt' : role === 'look' ? 'seg' : role;
        next.selectionKey = kind + ':' + (role === 'ct' ? idx >> 1 : idx);
        startPointer(e, next);
        return;
      }
      if (tool === 'range' && pts.length > 1) {
        startRangeDrag(e, world);
        return;
      }
      const visit = role === 'ins' ? resolveVisit(world, { cycle: tool === 'select' }) : null;
      startPointer(e, { role: 'bg', onPath: role === 'ins', segment: visit && visit.seg, visit, insertWaypoint: e.altKey, start: { cx: e.clientX, cy: e.clientY }, vb0: { ...view }, world, moved: false, mid: e.button === 1 });
    };

    const startPointer = (event, next) => {
      pointerDrag.start(event, { move: applyMove, coalesce: true, end: onUp, cancel: onInterrupted });
      const context = contextRef.current;
      drag.current = { ...context, pressSelection: context.selectionKey, ...next };
      drag.current.owner = createFieldGestureOwner(editStore, doc.id, () => pointerDrag.cancel({ flush: false }));
    };
    const ownsContext = (d) => {
      const context = contextRef.current;
      return d.pathId === context.pathId && d.tool === context.tool && d.routine === context.routine
        && (d.selectionKey === context.selectionKey || (!d.selectionEstablished && d.pressSelection === context.selectionKey));
    };
    const ensureEdit = (d) => {
      if (d.historyStarted) return d.owner.current();
      if (!actionsRef.current.beginEdit) return false;
      d.historyStarted = true;
      const started = d.owner.write(() => actionsRef.current.beginEdit(), true);
      if (started) d.baseline = fieldGestureValue(editStore?.getSnapshot() || doc, d);
      return started;
    };
    const resolveEdit = (d) => {
      if (!d.historyStarted) return;
      const unchanged = editStore && fieldGestureValue(editStore.getSnapshot(), d) === d.baseline;
      if (unchanged && actionsRef.current.cancelEdit) actionsRef.current.cancelEdit();
      else actionsRef.current.finishEdit?.();
    };

    const applyMove = (e) => {
      const d = drag.current; if (!d) return;
      if (!ownsContext(d) || !d.owner.current() || document.querySelector('dialog:modal, [role="dialog"][aria-modal="true"]')) { pointerDrag.cancel({ flush: false }); return; }
      const world = clientToWorld(e.clientX, e.clientY, d.role !== 'ct');
      if (d.role === 'inspect') {
        const dx = e.clientX - d.start.cx, dy = e.clientY - d.start.cy;
        if (Math.hypot(dx, dy) > 4) d.moved = true;
        return;
      }
      if (d.role === 'bg') {
        const dx = e.clientX - d.start.cx, dy = e.clientY - d.start.cy;
        if (!d.moved && Math.hypot(dx, dy) > 4) d.moved = true;
        if (d.moved) setView({ x: d.vb0.x - dx * upp, y: d.vb0.y - dy * upp, w: d.vb0.w, h: d.vb0.h });
        return;
      }
      if (d.role === 'newrange') { const visit = projectVisit(world, d.lastF); d.f1 = visit ? visit.f : PM.nearestFraction(world.x, world.y, pts); d.lastF = d.f1; d.moved = true; setPreview({ f0: d.f0, f1: d.f1 }); return; }
      if (d.role === 'head') {
        const w = doc.waypoints[d.idx];
        if (w) {
          if (!ensureEdit(d)) return;
          let deg = Math.atan2(world.y - w.y, world.x - w.x) * 180 / Math.PI;
          let label = null;
          if (e.shiftKey) deg = Math.round(deg / 15) * 15;
          else {
            const cands = [];
            const wi = derived.wpIdx ? derived.wpIdx[d.idx] : 0; const tp = pts[wi];
            if (tp) cands.push({ deg: tp.heading * 180 / Math.PI, label: 'Tangent' });
            const nx = doc.waypoints[d.idx + 1]; if (nx) cands.push({ deg: Math.atan2(nx.y - w.y, nx.x - w.x) * 180 / Math.PI, label: 'Face next' });
            const pv = doc.waypoints[d.idx - 1]; if (pv) cands.push({ deg: Math.atan2(pv.y - w.y, pv.x - w.x) * 180 / Math.PI, label: 'Face prev' });
            let best = null, bestD = 8;
            cands.forEach((cd) => { const dd = Math.abs(PM.angWrap((deg - cd.deg) * Math.PI / 180) * 180 / Math.PI); if (dd < bestD) { bestD = dd; best = cd; } });
            if (best) { deg = best.deg; label = best.label; } else deg = Math.round(deg);
          }
          setSnap(label ? { idx: d.idx, label } : null);
          d.owner.write(() => actionsRef.current.setWaypointHeading(d.idx, deg - (d.idx === 0 && derived.rev ? 180 : 0)));
        }
        d.moved = true; return;
      }
      d.moved = true;
      if (!ensureEdit(d)) return;
      const p = d.role === 'ct' ? world : clampWorld(world);
      d.owner.write(() => {
        const actions = actionsRef.current;
        if (d.role === 'wp') actions.moveWaypoint(d.idx, p);
        else if (d.role === 'ct') actions.moveHandle(d.idx >> 1, d.idx & 1, p);
        else if (d.role === 'rt') { const visit = projectVisit(world, d.lastF); if (visit) d.lastF = visit.f; actions.moveTargetTo(d.idx, world, visit && visit.f); }
        else if (d.role === 'rth') actions.rotateTargetTo(d.idx, world, e.shiftKey);
        else if (d.role === 'look') actions.moveSegmentLookAt(d.idx, p);
        else if (d.role === 'em') { const visit = projectVisit(world, d.lastF); if (visit) d.lastF = visit.f; actions.moveMarkerTo(d.idx, world, visit && visit.f); }
        else if (d.role === 'rs' || d.role === 're') {
          const visit = projectVisit(world, d.lastF), raw = visit ? visit.f : PM.nearestFraction(world.x, world.y, pts);
          const endpoint = fieldRangeEndpoint(d.range, d.role === 're' ? 1 : 0, raw, derived.sample.length);
          d.lastF = endpoint.f; actions.moveRangeHandle(d.idx, endpoint.which, endpoint.f);
        }
      });
    };

    const onUp = (e) => {
      const d = drag.current;
      if (d && (!ownsContext(d) || !d.owner.current() || document.querySelector('dialog:modal, [role="dialog"][aria-modal="true"]'))) { onInterrupted(); return; }
      drag.current = null; d?.owner.dispose();
      setSnap(null);
      if (!d) return;
      resolveEdit(d);
      if (d.role === 'newrange') {
        setPreview(null);
        const f0 = d.f0, f1 = d.f1;
        if (Math.abs(f1 - f0) >= 0.015) actions.addRange(f0, f1);
        return;
      }
      // Pointer capture and preventDefault make Chromium's native dblclick
      // unreliable on the SVG. Count only released, unmoved presses so a fast
      // second drag never gets mistaken for an inspector gesture.
      if (d.inspectItem) {
        const previous = lastInspectPress.current;
        if (d.moved) {
          if (previous.key === d.inspectItem.pressKey) lastInspectPress.current = { key: null, at: 0 };
        } else {
          const now = performance.now();
          if (previous.key === d.inspectItem.pressKey && now - previous.at <= 550) {
            actions.select(d.inspectItem.kind, d.inspectItem.selectedIndex);
            if (actions.openInspector) actions.openInspector();
            lastInspectPress.current = { key: null, at: 0 };
            return;
          }
          lastInspectPress.current = { key: d.inspectItem.pressKey, at: now };
        }
      }
      if (d.role === 'wp' && !d.moved && d.cycleWaypoint) {
        const visit = resolveWaypointVisit(d.world, true);
        if (visit && Number.isInteger(visit.wp)) actions.select('wp', visit.wp);
        return;
      }
      if (d.role === 'bg' && !d.moved && !d.mid) {
        if (d.insertWaypoint) actions.addWaypoint(d.world, d.segment, !!d.onPath, d.visit);
        else if (tool === 'waypoint') actions.appendWaypoint(d.world);
        else if (tool === 'rotation') actions.addTargetAt(d.world, d.visit && d.visit.f);
        else if (tool === 'marker') actions.addMarkerAt(d.world, d.visit && d.visit.f);
        else if (tool === 'select') {
          if (d.onPath) {
            const visit = d.visit || resolveVisit(d.world, { cycle: true });
            const f = visit ? visit.f : PM.nearestFraction(d.world.x, d.world.y, pts);
            let segment = visit ? visit.seg : (Number.isInteger(d.segment) ? d.segment : 0);
            if (!Number.isInteger(d.segment) && derived.wpFrac) {
              for (let i = 0; i < derived.wpFrac.length - 1; i++) if (f >= derived.wpFrac[i] - 1e-6) segment = i;
            }
            actions.select('seg', Math.max(0, Math.min(doc.waypoints.length - 2, segment)));
          } else { updateVisitFocus(null); actions.select(null, -1); }
        }
      }
    };

    // Preserve the last visible edit if the browser interrupts pointer capture.
    const onInterrupted = () => {
      const d = drag.current;
      const owned = d?.owner.current() && d.pathId === contextRef.current.pathId;
      drag.current = null; setSnap(null);
      d?.owner.dispose();
      if (d && d.role === 'newrange') setPreview(null);
      if (owned) resolveEdit(d);
    };
    const onWheel = (e) => {
      e.preventDefault();
      const svg = svgRef.current; const ctm = svg.getScreenCTM();
      const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
      const u = pt.matrixTransform(ctm.inverse());
      const factor = wheelZoomFactor(e.deltaY, e.deltaMode, svg.clientHeight || window.innerHeight);
      let nw = view.w * factor;
      nw = Math.max(IMG_W * 0.12, Math.min(IMG_W * 1.6, nw)); const nh = nw * (IMG_H / IMG_W);
      const k = nw / view.w;
      setView({ x: u.x - (u.x - view.x) * k, y: u.y - (u.y - view.y) * k, w: nw, h: nh });
    };

    const onDbl = (e) => {
      if (routine) return;
      if (!inspectTarget(e.target)) return;
      e.preventDefault(); e.stopPropagation();
    };
    const openHeadingMenu = (target, x, y) => {
      if (routine || !target || !actions.headingMenu) return;
      const idx = Number(target.getAttribute('data-idx'));
      if (!Number.isInteger(idx)) return;
      target.focus();
      actions.headingMenu(idx, x, y, target);
    };
    const onCtx = (event) => {
      event.preventDefault();
      const target = event.target.closest?.('[data-heading-control]');
      if (target) openHeadingMenu(target, event.clientX, event.clientY);
    };
    const onFieldKeyDown = (event) => {
      const direct = event.target.closest?.('[data-heading-control]');
      const menuKey = event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
      if (!menuKey && !(direct && (event.key === 'Enter' || event.key === ' '))) return;
      const target = direct || (sel.kind === 'wp' && svgRef.current?.querySelector('[data-heading-control][data-idx="' + sel.idx + '"]'));
      if (!target || routine) return;
      event.preventDefault(); event.stopPropagation();
      const bounds = target.getBoundingClientRect();
      openHeadingMenu(target, bounds.left + bounds.width / 2, bounds.bottom);
    };

    const fieldIssues = useMemo(() => problems && !problems.live ? problems.issues : (derived.checks || []).map(check => ({
      ...check, severity: check.level, f0: check.f, f1: check.f,
    })), [problems?.issues, problems?.live, derived.checks]);
    const selectedProblem = !problems?.live && fieldIssues[problems?.selected] && fieldIssues[problems.selected].severity !== 'note' ? problems.selected : null;
    const problemOverflow = selectedProblem != null && !problemBadgeIndexes(fieldIssues, null).includes(selectedProblem) ? selectedProblem : null;
    const problemBounds = { x: view.x, y: view.y, w: view.w, h: view.h };
    const problemFootprints = useMemo(() => [doc.waypoints[0], doc.waypoints.at(-1)].filter(Boolean).map(wp => {
        const c = W2P(wp), radius = Math.max(0, ...localFootprint(robot).map(point => Math.hypot(point.x * SX, point.y * SY))) + P(12);
        return { x: c.x - radius, y: c.y - radius, w: radius * 2, h: radius * 2 };
      }), [doc.waypoints, robot.l, robot.w, robot.footprint, view.w, cw]);
    const baseProblemBadges = useMemo(() => {
      if (routine || pts.length < 2 || doc.waypoints.length < 2) return [];
      return placeProblemBadges(fieldIssues, problemBadgeIndexes(fieldIssues, null), f => W2P(PM.pointAtFraction(f, pts)), problemBounds, upp, problemFootprints);
    }, [fieldIssues, pts, doc.waypoints, problemFootprints, routine, view.x, view.y, view.w, view.h, cw]);
    const interactiveProblems = Boolean(problems && !problems.live && interactionReady);
    const problemKey = (event, index) => {
      if (!['Enter', ' ', 'Escape', 'Delete', 'Backspace'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (event.isComposing || event.nativeEvent?.isComposing || event.repeat || !interactiveProblems
        || document.querySelector('dialog:modal, [role="dialog"][aria-modal="true"]')) return;
      if (event.key === 'Escape') problems.onClear();
      else if (event.key === 'Enter' || event.key === ' ') problems.onSelect(index);
    };
    const problemUnderlays = useMemo(() => fieldIssues.map((issue, index) => {
      if (routine || issue.severity === 'note' || isWholeIssue(issue) || pts.length < 2) return null;
      const selected = !problems?.live && problems?.selected === index, point = issue.f1 - issue.f0 < 1e-6;
      const col = issue.severity === 'warning' ? '#d9a441' : '#d2655f';
      const alpha = (selected ? .42 : .24) * (problems?.stale ? .5 : 1);
      const position = point ? W2P(PM.pointAtFraction(issue.f0, pts)) : null;
      return h(point ? 'circle' : 'path', { key: index, className: 'field-problem-span',
        ...(point ? { cx: position.x, cy: position.y, r: P(selected ? 7.5 : 5.5), fill: col, fillOpacity: alpha } : {
          d: FieldScene.fractionPathData(pts, derived.sample.length || 1, issue.f0, issue.f1, W2P, 1), fill: 'none', stroke: col,
          strokeWidth: P(selected ? 15 : 11), strokeOpacity: alpha, strokeLinecap: 'round' }),
        style: { pointerEvents: 'none' }, 'data-issue-index': index });
    }), [fieldIssues, problems?.selected, problems?.stale, problems?.live, pts, derived.sample.length, routine, view.w, cw]);
    const staticScene = useMemo(() => {
      const els = [], labels = [];
      const M = derived.metrics;
      const headingMode = derived.headingMode;
      const segmentMode = (segment) => isTank ? 'tangent' : ((doc.waypoints[segment] && doc.waypoints[segment].segmentHeadingMode) || headingMode);
      const waypointMode = (index) => segmentMode(Math.min(index, Math.max(0, doc.waypoints.length - 2)));
      const waypointTangent = (index) => waypointMode(index) === 'tangent';
      const waypointTracksPoint = (index) => waypointMode(index) === 'lookAt';
      const waypointHeadingIgnored = (index) => {
        if (index <= 0 || index >= doc.waypoints.length - 1) return false;
        const incomingMode = segmentMode(index - 1), outgoingMode = segmentMode(index);
        const continuityOwned = (incomingMode === 'tangent' || incomingMode === 'lookAt')
          && (outgoingMode === 'manual' || outgoingMode === 'targets');
        return continuityOwned;
      };
      const targetActive = (target) => {
        const f = PM.featureFraction(target, derived.sample); let segment = 0;
        if (derived.wpFrac) for (let i = 0; i < derived.wpFrac.length - 1; i++) if (f >= derived.wpFrac[i] - 1e-6) segment = i;
        return segmentMode(segment) === 'targets';
      };
      const plannedHeadingAt = (fraction) => {
        if (!Array.isArray(M.head) || M.head.length !== pts.length || pts.length === 0) {
          return PM.headingAt(fraction, derived.anchors);
        }
        const distance = Math.max(0, Math.min(1, fraction)) * (derived.sample.length || 0);
        let after = 1;
        while (after < pts.length && pts[after].s < distance) after++;
        if (after >= pts.length) return M.head[M.head.length - 1];
        const before = Math.max(0, after - 1);
        const span = pts[after].s - pts[before].s;
        const progress = span > 1e-9 ? (distance - pts[before].s) / span : 1;
        return M.head[before] + PM.angWrap(M.head[after] - M.head[before]) * progress;
      };
      const tanDeg = (i) => { const idx = derived.wpIdx ? derived.wpIdx[i] : 0; const p = pts[idx]; return p ? p.heading * 180 / Math.PI : 0; };
      const waypointHeadingDeg = (index) => {
        const waypoint = doc.waypoints[index];
        if (!waypoint) return 0;
        if (waypointTangent(index)) return tanDeg(index);
        if (waypointTracksPoint(index)) {
          const segment = Math.min(index, Math.max(0, doc.waypoints.length - 2));
          const target = doc.waypoints[segment] && doc.waypoints[segment].segmentLookAt;
          if (target) {
            const dx = target.x - waypoint.x, dy = target.y - waypoint.y;
            if (Math.hypot(dx, dy) > 1e-6) return Math.atan2(dy, dx) * 180 / Math.PI;
          }
        }
        return waypoint.theta || 0;
      };
      const colAt = (i) => {
        if (metric === 'accel') return PM.metricColor('accel', 0.5 + 0.5 * (M.accel[i] / (M.aMax || 1)));
        if (metric === 'angvel') return PM.metricColor('angvel', 0.5 + 0.5 * (M.omega[i] / (M.wMax || 1)));
        if (metric === 'curvature') return PM.metricColor('curvature', M.curv[i] / (M.kMax || 1));
        return PM.metricColor('velocity', M.v[i] / (M.vMax || 1));
      };

      if (showGrid) {
        const g = [];
        for (let m = 0; m <= Math.floor(FIELD_W); m++) { const x = X0 + m * SX; g.push(h('line', { key: 'gx' + m, x1: x, y1: Y0, x2: x, y2: Y1, stroke: '#ffffff', strokeOpacity: 0.045, strokeWidth: P(1) })); }
        for (let m = 0; m <= Math.floor(FIELD_H); m++) { const y = Y1 - m * SY; g.push(h('line', { key: 'gy' + m, x1: X0, y1: y, x2: X1, y2: y, stroke: '#ffffff', strokeOpacity: 0.045, strokeWidth: P(1) })); }
        els.push(h('g', { key: 'grid' }, g));
      }

      // thin CAD centerline: subtle casing + metric-colored body + invisible insert hit-line
      if (pts.length > 1) {
        const totalS = derived.sample.length || 1;
        const ranges = derived.effRanges || doc.ranges || [];
        const rangeSpans = ranges.map((range) => FieldScene.fractionRange(pts, totalS, range.f0, range.f1));
        // constraint range bands (under the centerline)
        ranges.forEach((rg, ri) => {
          const isSel = sel.kind === 'cr' && sel.idx === ri;
          const dd = FieldScene.pathData(pts, rangeSpans[ri], W2P, 1);
          if (dd) els.push(h('path', { key: 'rb' + ri, d: dd, fill: 'none', stroke: isSel ? accent : '#caa23a', strokeOpacity: isSel ? 0.5 : 0.32, strokeWidth: P(12), strokeLinecap: 'round', strokeLinejoin: 'round', style: { pointerEvents: 'none' } }));
        });
        const dCase = FieldScene.pathData(pts, null, W2P);
        els.push(h('path', { key: 'case', d: dCase, fill: 'none', stroke: '#05060a', strokeOpacity: 0.75, strokeWidth: P(5), strokeLinecap: 'round', strokeLinejoin: 'round' }));
        const segEls = [];
        const stride = Math.max(1, Math.floor(pts.length / 200));
        for (let i = 0; i + stride < pts.length; i += stride) {
          const a = W2P(pts[i]), b = W2P(pts[i + stride]);
          segEls.push(h('line', { key: 's' + i, x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: colAt(i), strokeWidth: P(2.6), strokeLinecap: 'butt' }));
        }
        els.push(h('g', { key: 'pathbody' }, segEls));
        if (sel.kind === 'seg' && derived.wpFrac && derived.wpFrac.length > sel.idx + 1) {
          const sd = FieldScene.pathData(pts, FieldScene.segmentRange(derived, sel.idx), W2P, 1);
          if (sd) els.push(h('path', { key: 'segsel', d: sd, fill: 'none', stroke: accent, strokeWidth: P(5.5), strokeOpacity: 0.92, strokeLinecap: 'round', strokeLinejoin: 'round', style: { pointerEvents: 'none' } }));
        }
        // per-segment hit paths — click selects the segment; alt-click / waypoint-tool inserts (memo §3)
        if (derived.wpFrac) {
          for (let si = 0; si < doc.waypoints.length - 1; si++) {
            const sd = FieldScene.pathData(pts, FieldScene.segmentRange(derived, si), W2P, 1);
            if (sd) els.push(h('path', { key: 'seghit' + si, d: sd, fill: 'none', stroke: 'transparent', strokeWidth: P(18), strokeLinecap: 'round', 'data-role': 'seg', 'data-idx': si, style: { cursor: 'pointer' } }));
          }
        }
        // Range labels share the canvas with handles, waypoints, targets, and warnings.
        // Treat those as occupied rectangles, then pick the clearest nearby label slot.
        const labelObstacles = toolRailObstacle ? [toolRailObstacle] : [];
        const reserveLabelSpace = (x, y, w, h) => labelObstacles.push({ x: x - w / 2, y: y - h / 2, w, h });
        const reserveSegmentSpace = (a, b, pad) => labelObstacles.push({
          x: Math.min(a.x, b.x) - pad, y: Math.min(a.y, b.y) - pad,
          w: Math.abs(a.x - b.x) + pad * 2, h: Math.abs(a.y - b.y) + pad * 2,
        });
        const reserveRotatedSpace = (x, y, w, h, deg) => {
          const rad = deg * Math.PI / 180;
          reserveLabelSpace(x, y, Math.abs(Math.cos(rad)) * w + Math.abs(Math.sin(rad)) * h, Math.abs(Math.sin(rad)) * w + Math.abs(Math.cos(rad)) * h);
        };
        doc.waypoints.forEach((wp, i) => {
          const c = W2P(wp); reserveLabelSpace(c.x, c.y, P(30), P(30));
          const isStart = i === 0, isEnd = i === doc.waypoints.length - 1;
          const wpTangent = waypointTangent(i);
          if (!isTank && !waypointHeadingIgnored(i) && (wpTangent || isStart || isEnd || wp.thetaOn || (sel.kind === 'wp' && sel.idx === i))) {
            const heading = waypointHeadingDeg(i) + (isStart && derived.rev ? 180 : 0);
            const deg = heading * Math.PI / 180;
            const end = { x: c.x + Math.cos(-deg) * P(35), y: c.y + Math.sin(-deg) * P(35) };
            reserveSegmentSpace(c, end, P(8));
          }
          if (showHandles && sel.kind === 'wp' && sel.idx === i) {
            [['prevC', isStart], ['nextC', isEnd]].forEach(([key, hidden]) => {
              if (hidden) return;
              const handle = W2P(wp[key]);
              reserveSegmentSpace(c, handle, P(7));
              reserveLabelSpace(handle.x, handle.y, P(18), P(18));
            });
          }
        });
        if (doc.waypoints.length) {
          const first = doc.waypoints[0], last = doc.waypoints[doc.waypoints.length - 1];
          const startHeading = waypointHeadingDeg(0);
          const endHeading = waypointHeadingDeg(doc.waypoints.length - 1);
          const start = W2P(first), end = W2P(last);
          reserveRotatedSpace(start.x, start.y, robot.l * SX + P(12), robot.w * SY + P(12), startHeading);
          reserveRotatedSpace(end.x, end.y, robot.l * SX + P(12), robot.w * SY + P(12), endHeading);
        }
        doc.markers.forEach((marker) => { const c = W2P(PM.pointAtFraction(PM.featureFraction(marker, derived.sample), pts)); reserveLabelSpace(c.x, c.y - P(12), P(30), P(42)); });
        if (!isTank) doc.targets.filter(targetActive).forEach((target) => {
          const c = W2P(PM.pointAtFraction(PM.featureFraction(target, derived.sample), pts));
          const deg = target.deg;
          const rad = -deg * Math.PI / 180;
          const arrowOffset = P(8.5);
          reserveRotatedSpace(c.x + Math.cos(rad) * arrowOffset, c.y + Math.sin(rad) * arrowOffset,
            robot.l * SX + P(29), robot.w * SY + P(20), deg);
        });
        baseProblemBadges.forEach(badge => labelObstacles.push(badge.box));
        const labeledRangeIndexes = rangeLabelIndexes(ranges.length, sel.kind === 'cr' ? sel.idx : -1);
        ranges.forEach((range, index) => {
          if (!labeledRangeIndexes.has(index)) return;
          ['f0', 'f1'].forEach((key) => {
            const c = W2P(PM.pointAtFraction(range[key], pts));
            reserveLabelSpace(c.x, c.y, P(24), P(24));
          });
        });
        if (derived.wpFrac) {
          const chipTypes = { line: true, arc: true, clothoid: true };
          for (let i = 0; i < doc.waypoints.length - 1; i++) {
            if (!chipTypes[doc.waypoints[i].segType]) continue;
            const fraction = ((derived.wpFrac[i] || 0) + (derived.wpFrac[i + 1] || 0)) / 2;
            const c = W2P(PM.pointAtFraction(fraction, pts));
            reserveLabelSpace(c.x, c.y + P(17), P(40), P(25));
          }
        }
        const labelOverlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
          * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        const placeRangeLabel = (fraction, anchor, width, height) => {
          const before = W2P(PM.pointAtFraction(Math.max(0, fraction - 0.012), pts));
          const after = W2P(PM.pointAtFraction(Math.min(1, fraction + 0.012), pts));
          const length = Math.hypot(after.x - before.x, after.y - before.y) || 1;
          const tx = (after.x - before.x) / length, ty = (after.y - before.y) / length;
          let nx = -ty, ny = tx;
          if (ny > 0) { nx *= -1; ny *= -1; }
          const pad = P(8);
          const minX = X0 + width / 2 + pad, maxX = X1 - width / 2 - pad;
          const minY = Y0 + height / 2 + pad, maxY = Y1 - height / 2 - pad;
          let best = null;
          let foundClear = false, index = 0;
          for (let ring = 0; ring < 8 && !foundClear; ring++) {
            const normalGap = P(31 + ring * 24);
            const tangentGap = width * 0.58;
            const shifts = ring === 0 ? [0, 1, -1] : [0, 1, -1, 2, -2];
            for (const side of [1, -1]) {
              for (const shift of shifts) {
                const dx = nx * normalGap * side + tx * tangentGap * shift;
                const dy = ny * normalGap * side + ty * tangentGap * shift;
                const rawX = anchor.x + dx, rawY = anchor.y + dy;
                const x = Math.max(minX, Math.min(maxX, rawX));
                const y = Math.max(minY, Math.min(maxY, rawY));
                const box = { x: x - width / 2 - pad, y: y - height / 2 - pad, w: width + pad * 2, h: height + pad * 2 };
                const overlap = labelObstacles.reduce((sum, obstacle) => sum + labelOverlap(box, obstacle), 0);
                const clamped = Math.hypot(x - rawX, y - rawY);
                const score = overlap * 1000 + clamped * 100 + Math.hypot(dx, dy) + index++ * 0.01;
                if (!best || score < best.score) best = { x, y, box, score };
                if (overlap === 0 && clamped < P(1)) { best = { x, y, box, score }; foundClear = true; break; }
              }
              if (foundClear) break;
            }
          }
          labelObstacles.push(best.box);
          return best;
        };

        // range handles + collision-aware velocity tags
        const rangeOrder = ranges.map((rg, ri) => ({ rg, ri }));
        rangeOrder.sort((a, b) => Number(sel.kind === 'cr' && sel.idx === a.ri) - Number(sel.kind === 'cr' && sel.idx === b.ri));
        rangeOrder.forEach(({ rg, ri }) => {
          const isSel = sel.kind === 'cr' && sel.idx === ri;
          const col = isSel ? accent : '#caa23a';
          const rangeHit = FieldScene.pathData(pts, rangeSpans[ri], W2P, 1);
          if (rangeHit) els.push(h('path', { key: 'rhit' + ri, d: rangeHit, fill: 'none', stroke: 'transparent', strokeWidth: P(11), strokeLinecap: 'round', 'data-role': 'cr', 'data-idx': ri, style: { cursor: 'pointer' } }));
          (rg.f0 <= rg.f1 ? [['f0', 'rs'], ['f1', 're']] : [['f1', 'rs'], ['f0', 're']]).forEach(([fk, role]) => {
            const pf = PM.pointAtFraction(rg[fk], pts); const c = W2P(pf);
            els.push(h('g', { key: role + ri, transform: `translate(${c.x} ${c.y})`, style: { cursor: 'ew-resize' } },
              h('circle', { r: P(7), fill: '#14161a', stroke: col, strokeWidth: P(2), 'data-role': role, 'data-idx': ri }),
              h('circle', { r: P(2.5), fill: col, 'data-role': role, 'data-idx': ri })));
          });
          const fraction = (rg.f0 + rg.f1) / 2;
          const mid = PM.pointAtFraction(fraction, pts); const mc = W2P(mid);
          const summary = UI.constraintRangeSummary(rg, doc.constraints, robot);
          if (summary && labeledRangeIndexes.has(ri)) {
            const text = summary.text;
            const tw = P(Math.max(78, text.length * 7.4 + 20)), th = P(24);
            const label = placeRangeLabel(fraction, mc, tw, th);
            labels.push(label.box);
            const leaderDx = label.x - mc.x, leaderDy = label.y - mc.y;
            const leaderLength = Math.hypot(leaderDx, leaderDy) || 1;
            const leaderEndX = label.x - leaderDx / leaderLength * (th / 2 + P(2));
            const leaderEndY = label.y - leaderDy / leaderLength * (th / 2 + P(2));
            els.push(h('g', { key: 'rl' + ri, style: { cursor: 'pointer' }, role: 'button', tabIndex: 0, 'aria-label': 'Open zone, ' + summary.ariaLabel, onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); actions.select('cr', ri); } } },
              h('line', { x1: mc.x, y1: mc.y, x2: leaderEndX, y2: leaderEndY, stroke: col, strokeOpacity: 0.72, strokeWidth: P(1.2), strokeLinecap: 'round', 'data-role': 'cr', 'data-idx': ri }),
              h('rect', { x: label.x - tw / 2, y: label.y - th / 2, width: tw, height: th, rx: P(6), fill: 'oklch(0.17 0.003 286 / 0.96)', stroke: isSel ? accent : 'oklch(0.73 0.13 86 / 0.72)', strokeWidth: P(1), 'data-role': 'cr', 'data-idx': ri }),
              h('text', { x: label.x, y: label.y + P(4.2), fill: isSel ? accent : 'oklch(0.84 0.12 88)', fontSize: P(12), fontFamily: 'JetBrains Mono, monospace', fontWeight: 600, letterSpacing: P(0.1), textAnchor: 'middle', 'data-role': 'cr', 'data-idx': ri }, text)));
          }
        });
      }

      // precise heading helper (waypoints) — draggable when idx is supplied (memo §7)
      const headArrow = (cx, cy, deg, col, len, idx) => {
        const rot = deg;
        const interactive = idx != null;
        return h('g', { transform: `translate(${cx} ${cy}) rotate(${-rot})`, style: interactive ? { cursor: 'grab' } : { pointerEvents: 'none' },
          ...(interactive ? { 'data-heading-control': true, 'data-role': 'head', 'data-idx': idx, tabIndex: 0, role: 'button', 'aria-haspopup': 'menu', 'aria-label': idx === 0 ? 'Initial robot heading actions' : 'Waypoint ' + idx + ' heading actions',
            'data-tip': idx === 0 ? 'Drag to change initial robot facing' : 'Drag to change robot facing' } : {}) },
          h('line', { x1: 0, y1: 0, x2: len, y2: 0, stroke: col, strokeWidth: P(1.8), strokeLinecap: 'round' }),
          h('path', { d: `M ${len} ${-P(3.8)} L ${len + P(7)} 0 L ${len} ${P(3.8)} Z`, fill: col }),
          interactive && h('line', { x1: P(5), y1: 0, x2: len + P(8), y2: 0, stroke: 'transparent', strokeWidth: P(15), strokeLinecap: 'round', 'data-role': 'head', 'data-idx': idx }),
          interactive && h('circle', { cx: len + P(2), cy: 0, r: P(8.5), fill: 'transparent', 'data-role': 'head', 'data-idx': idx }));
      };

      // facing comb: neutral, thin heading ticks along the trajectory
      if (pts.length > 1 && !isTank) {
        const totalLen = derived.sample.length || 1;
        const step = 0.78;
        const comb = [];
        for (let dl = step * 0.55; dl < totalLen - 0.04; dl += step) {
          const f = dl / totalLen;
          const pf = PM.pointAtFraction(f, pts);
          let segment = 0;
          if (derived.wpFrac) for (let i = 0; i < derived.wpFrac.length - 1; i++) if (f >= derived.wpFrac[i] - 1e-6) segment = i;
          const rad = segmentMode(segment) === 'tangent' ? pf.heading : plannedHeadingAt(f);
          const c = W2P(pf);
          const rot = rad * 180 / Math.PI;
          comb.push(h('g', { key: 'cb' + dl.toFixed(2), transform: `translate(${c.x} ${c.y}) rotate(${-rot})` },
            h('line', { x1: 0, y1: 0, x2: P(12), y2: 0, stroke: '#aeb6c2', strokeWidth: P(1.1), strokeLinecap: 'round' }),
            h('path', { d: `M ${P(12)} ${-P(2.6)} L ${P(16.5)} 0 L ${P(12)} ${P(2.6)} Z`, fill: '#aeb6c2' })));
        }
        els.push(h('g', { key: 'comb', opacity: 0.32, style: { pointerEvents: 'none' } }, comb));
      }

      // ghost robot footprint (dashed outline) at a pose
      const ghost = (cx, cy, deg, col, key, op) => {
        const rot = deg;
        return h('g', { key, transform: `translate(${cx} ${cy}) rotate(${-rot})`, opacity: op, style: { pointerEvents: 'none' } },
          h('polygon', { points: footprintPoints(robot, 1), fill: 'none', stroke: col, strokeWidth: P(1.6), strokeLinejoin: 'round', strokeDasharray: `${P(7)} ${P(5)}` }));
      };
      const wps = doc.waypoints;
      const startHead = waypointHeadingDeg(0);
      const endHead = waypointHeadingDeg(wps.length - 1);
      if (wps[0]) { const c = W2P(wps[0]); els.push(ghost(c.x, c.y, startHead, C_START, 'gs', 0.28)); }
      if (wps[wps.length - 1]) { const c = W2P(wps[wps.length - 1]); els.push(ghost(c.x, c.y, endHead, C_END, 'ge', 0.28)); }

      // Endpoint jiggle is one compact action. Preview its strokes without adding waypoint nodes.
      const endpoint = wps[wps.length - 1];
      if (endpoint && endpoint.jiggle) {
        const baseRad = (endpoint.turnInPlace ? endpoint.turnInPlace.headingDeg : endHead) * Math.PI / 180;
        const physicalBase = baseRad + (derived.rev ? Math.PI : 0);
        const positions = PM.jigglePositions(endpoint, physicalBase, endpoint.jiggle, { w: FIELD_W, h: FIELD_H });
        if (positions) {
          const anchor = W2P(endpoint);
          const strokes = [];
          for (let i = 0; i < positions.length; i += 2) {
            const tip = W2P(positions[i]);
            strokes.push(h('line', { key: 'jiggle-stroke-' + i, x1: anchor.x, y1: anchor.y, x2: tip.x, y2: tip.y, stroke: accent, strokeWidth: P(1.6), strokeOpacity: 0.62, strokeDasharray: `${P(5)} ${P(4)}`, strokeLinecap: 'round' }));
            strokes.push(h('circle', { key: 'jiggle-tip-' + i, cx: tip.x, cy: tip.y, r: P(2.8), fill: '#111318', stroke: accent, strokeWidth: P(1.3) }));
          }
          els.push(h('g', { key: 'endpoint-jiggle', style: { pointerEvents: 'none' } }, strokes));
        }
      }

      const markerOrder = doc.markers.map((mk, i) => ({ mk, i }));
      markerOrder.sort((a, b) => Number(sel.kind === 'em' && sel.idx === a.i) - Number(sel.kind === 'em' && sel.idx === b.i));
      markerOrder.forEach(({ mk, i }) => {
        const pf = PM.pointAtFraction(PM.featureFraction(mk, derived.sample), pts); const c = W2P(pf);
        const isSel = sel.kind === 'em' && sel.idx === i;
        const col = isSel ? accent : C_NEUTRAL;
        els.push(h('g', { key: 'em' + i, transform: `translate(${c.x} ${c.y})`, style: { cursor: 'pointer' } },
          h('line', { x1: 0, y1: 0, x2: 0, y2: -P(22), stroke: col, strokeWidth: P(1.4) }),
          h('path', { d: `M 0 ${-P(22)} L ${P(11)} ${-P(17.5)} L 0 ${-P(13)} Z`, fill: col, 'data-role': 'em', 'data-idx': i }),
          h('rect', { x: -P(4), y: -P(4), width: P(8), height: P(8), transform: 'rotate(45)', fill: '#14161a', stroke: col, strokeWidth: P(1.6), 'data-role': 'em', 'data-idx': i })));
      });

      // rotation targets — ghost robot oriented at the target heading + heading vector
      const targetOrder = doc.targets.map((rtg, i) => ({ rtg, i }));
      targetOrder.sort((a, b) => Number(sel.kind === 'rt' && sel.idx === a.i) - Number(sel.kind === 'rt' && sel.idx === b.i));
      if (!isTank) targetOrder.forEach(({ rtg, i }) => {
        if (!targetActive(rtg)) return;
        const pf = PM.pointAtFraction(PM.featureFraction(rtg, derived.sample), pts); const c = W2P(pf);
        const isSel = sel.kind === 'rt' && sel.idx === i;
        const deg = rtg.deg;
        const col = isSel ? accent : C_NEUTRAL;
        const front = forwardExtent(robot);
        els.push(h('g', { key: 'rt' + i, style: { cursor: 'pointer' } },
          h('g', { transform: `translate(${c.x} ${c.y}) rotate(${-deg})`, opacity: isSel ? 0.95 : 0.6 },
            h('polygon', { points: footprintPoints(robot, 1), fill: isSel ? 'rgba(63,111,208,0.10)' : 'rgba(0,0,0,0.18)', stroke: col, strokeWidth: P(1.6), strokeLinejoin: 'round', 'data-role': 'rt', 'data-idx': i }),
            h('line', { x1: 0, y1: 0, x2: front + P(9), y2: 0, stroke: col, strokeWidth: P(2) }),
            h('path', { d: `M ${front + P(6)} ${-P(5)} L ${front + P(17)} 0 L ${front + P(6)} ${P(5)} Z`, fill: col }),
            h('line', { x1: P(5), y1: 0, x2: front + P(18), y2: 0, stroke: 'transparent', strokeWidth: P(15), strokeLinecap: 'round', 'data-role': 'rth', 'data-idx': i, style: { cursor: 'grab' } })),
          h('circle', { cx: c.x, cy: c.y, r: P(3), fill: col, 'data-role': 'rt', 'data-idx': i })));
      });

      // Selected look-at segment — one draggable field target with sparse guide rays.
      if (!isTank && sel.kind === 'seg') {
        const segment = sel.idx, source = doc.waypoints[segment];
        if (source && source.segmentHeadingMode === 'lookAt' && source.segmentLookAt && derived.wpFrac) {
          const tc = W2P(source.segmentLookAt), lo = derived.wpFrac[segment] || 0, hi = derived.wpFrac[segment + 1] || lo;
          [0.18, 0.5, 0.82].forEach((part, guide) => {
            const point = PM.pointAtFraction(lo + (hi - lo) * part, pts), pc = W2P(point);
            els.push(h('line', { key: 'look-guide-' + guide, x1: pc.x, y1: pc.y, x2: tc.x, y2: tc.y, stroke: accent, strokeWidth: P(1), strokeOpacity: 0.18, strokeDasharray: `${P(4)} ${P(5)}`, style: { pointerEvents: 'none' } }));
          });
          els.push(h('g', { key: 'look-target', transform: `translate(${tc.x} ${tc.y})`, style: { cursor: 'grab' } },
            h('circle', { r: P(15), fill: 'transparent', 'data-role': 'look', 'data-idx': segment }),
            h('circle', { r: P(7), fill: 'rgba(14,16,20,0.88)', stroke: accent, strokeWidth: P(1.7), 'data-role': 'look', 'data-idx': segment }),
            h('circle', { r: P(2.2), fill: accent, 'data-role': 'look', 'data-idx': segment }),
            h('line', { x1: -P(11), y1: 0, x2: P(11), y2: 0, stroke: accent, strokeWidth: P(1.2), 'data-role': 'look', 'data-idx': segment }),
            h('line', { x1: 0, y1: -P(11), x2: 0, y2: P(11), stroke: accent, strokeWidth: P(1.2), 'data-role': 'look', 'data-idx': segment })));
        }
      }

      const waypointOrder = doc.waypoints.map((w, i) => ({ w, i }));
      waypointOrder.sort((a, b) => Number(sel.kind === 'wp' && sel.idx === a.i) - Number(sel.kind === 'wp' && sel.idx === b.i));
      waypointOrder.forEach(({ w, i }) => {
        const c = W2P(w);
        const isSel = sel.kind === 'wp' && sel.idx === i;
        const isStart = i === 0, isEnd = i === doc.waypoints.length - 1;
        const baseCol = isStart ? C_START : isEnd ? C_END : C_NODE;
        const col = isSel ? accent : baseCol;
        const group = [];
        const wpTangent = waypointTangent(i);
        const wpTracksPoint = waypointTracksPoint(i);
        if (!isTank && !waypointHeadingIgnored(i) && (wpTangent || isStart || isEnd || w.thetaOn || isSel)) {
          group.push(h('g', { key: 'th' }, headArrow(c.x, c.y, waypointHeadingDeg(i) + (isStart && derived.rev ? 180 : 0), col, P(26), isStart || (!wpTangent && !wpTracksPoint) ? i : null)));
        }
        if (isSel && showHandles) {
          [['prevC', 0], ['nextC', 1]].forEach(([key, b]) => {
            if ((isStart && key === 'prevC') || (isEnd && key === 'nextC')) return;
            const cc = W2P(w[key]);
            group.push(h('line', { key: 'hl' + b, x1: c.x, y1: c.y, x2: cc.x, y2: cc.y, stroke: accent, strokeWidth: P(1.2), strokeOpacity: 0.65 }));
            group.push(h('circle', { key: 'hc' + b, cx: cc.x, cy: cc.y, r: P(5), fill: '#0c0d10', stroke: accent, strokeWidth: P(1.8), 'data-role': 'ct', 'data-idx': i * 2 + b, style: { cursor: 'grab' } }));
          });
          group.push(h('rect', { key: 'selring', x: c.x - P(11), y: c.y - P(11), width: P(22), height: P(22), rx: P(2), fill: 'none', stroke: accent, strokeWidth: P(1.4), strokeOpacity: 0.55 }));
        } else if (isSel) {
          group.push(h('rect', { key: 'selring', x: c.x - P(11), y: c.y - P(11), width: P(22), height: P(22), rx: P(2), fill: 'none', stroke: accent, strokeWidth: P(1.4), strokeOpacity: 0.55 }));
        }
        const s = P(6.5);
        if (w.stop) group.push(h('rect', { key: 'stopo', x: c.x - s - P(3), y: c.y - s - P(3), width: (s + P(3)) * 2, height: (s + P(3)) * 2, rx: P(1.5), fill: 'none', stroke: '#d2655f', strokeWidth: P(1.4) }));
        if (w.turnInPlace) group.push(h('g', { key: 'turn', transform: `translate(${c.x + P(13)} ${c.y - P(13)})`, style: { pointerEvents: 'none' } },
          h('path', { d: `M ${-P(4)} ${P(2)} A ${P(6)} ${P(6)} 0 1 1 ${P(4)} ${P(2)}`, fill: 'none', stroke: '#aeb6c2', strokeWidth: P(1.5), strokeLinecap: 'round' }),
          h('path', { d: `M ${P(3)} ${-P(1)} L ${P(6)} ${P(2)} L ${P(2)} ${P(3)} Z`, fill: '#aeb6c2' })));
        group.push(h('rect', { key: 'node', x: c.x - s, y: c.y - s, width: s * 2, height: s * 2, rx: P(1.5), fill: '#14161a', stroke: col, strokeWidth: P(2), 'data-role': 'wp', 'data-idx': i, style: { cursor: 'grab' } }));
        els.push(h('g', { key: 'w' + i }, group));
      });

      // segment-type chips at each non-Bézier segment midpoint (legible hybrid paths)
      if (pts.length > 1 && derived.wpFrac) {
        const ABBR = { line: 'LIN', arc: 'ARC', clothoid: 'CLO' };
        for (let i = 0; i < doc.waypoints.length - 1; i++) {
          const st = doc.waypoints[i].segType;
          if (!ABBR[st]) continue;
          const fmid = ((derived.wpFrac[i] || 0) + (derived.wpFrac[i + 1] || 0)) / 2;
          const pf = PM.pointAtFraction(fmid, pts); const c = W2P(pf);
          const tw = P(30), th = P(15);
          els.push(h('g', { key: 'sc' + i, transform: `translate(${c.x} ${c.y + P(17)})`, style: { pointerEvents: 'none' } },
            h('rect', { x: -tw / 2, y: -th / 2, width: tw, height: th, rx: P(2.5), fill: 'rgba(14,16,20,0.9)', stroke: '#3a4250', strokeWidth: P(1) }),
            h('text', { x: 0, y: P(3.6), fill: '#aeb6c2', fontSize: P(9.5), fontFamily: 'JetBrains Mono, monospace', fontWeight: 600, letterSpacing: P(0.5), textAnchor: 'middle' }, ABBR[st])));
        }
      }

      return { els, labels };
    }, [doc, derived, sel.kind, sel.idx, showGrid, accent, metric, robot, drive, tool, view.w, cw, baseProblemBadges, toolRailObstacle]);
    const staticLayers = staticScene.els;
    // An overflow selection is placed against existing labels; it never rebuilds path geometry.
    const problemBadges = useMemo(() => problemOverflow == null ? baseProblemBadges : [
      ...baseProblemBadges.slice(0, 11),
      ...placeProblemBadges(fieldIssues, [problemOverflow], f => W2P(PM.pointAtFraction(f, pts)), problemBounds, upp,
        [...problemFootprints, ...baseProblemBadges.map(b => b.box), ...staticScene.labels]),
    ], [baseProblemBadges, staticScene, problemOverflow, fieldIssues, pts, problemFootprints, view.x, view.y, view.w, view.h, cw]);
    const selectedBadge = problemBadges.find(badge => badge.index === selectedProblem);
    const selectedCaption = useMemo(() => selectedBadge ? problemCaption(selectedBadge.issue, doc.waypoints.length, selectedBadge, problemBounds, upp,
      [...problemBadges.map(badge => badge.box), ...staticScene.labels]) : null,
      [selectedBadge, doc.waypoints.length, problemBadges, staticScene, view.x, view.y, view.w, view.h, cw]);
    const problemBadgeEls = problemBadges.map(badge => {
      const { issue, index, x, y } = badge, selected = !problems?.live && problems?.selected === index;
      const plain = plainProblem(issue, doc.waypoints.length), col = issue.severity === 'warning' ? '#d9a441' : '#d2655f';
      const caption = selected ? selectedCaption : null;
      return h('g', { key: index, className: 'field-issue-badge' + (selected ? ' selected' : ''), 'data-level': issue.severity,
        'data-role': interactiveProblems ? 'issue' : undefined, 'data-idx': index, role: interactiveProblems ? 'button' : undefined,
        tabIndex: interactiveProblems ? 0 : undefined, 'aria-pressed': interactiveProblems ? selected : undefined,
        'aria-label': 'Problem: ' + plain.text + (plain.where ? ', ' + plain.where : ''),
        onKeyDown: event => problemKey(event, index),
        onClick: event => { event.stopPropagation(); if (event.detail === 0 && interactiveProblems) problems.onSelect(index); },
        opacity: problems?.stale ? .5 : 1, style: { cursor: interactiveProblems ? 'pointer' : undefined, pointerEvents: interactiveProblems ? undefined : 'none' } },
        h('g', { transform: `translate(${x} ${y})` },
          h('circle', { className: 'field-issue-hit', r: P(12), fill: 'transparent', stroke: selected ? 'rgb(255 255 255/.85)' : 'transparent', strokeWidth: P(1.5) }),
          h('path', { d: `M 0 ${-P(8)} L ${P(8)} ${P(6)} L ${-P(8)} ${P(6)} Z`, fill: 'rgba(14,16,20,.92)', stroke: col, strokeWidth: P(1.4), strokeLinejoin: 'round' }),
          h('rect', { x: -P(.8), y: -P(3.5), width: P(1.6), height: P(5.5), rx: P(.8), fill: col }),
          h('circle', { cy: P(4), r: P(1), fill: col })),
        caption && h('g', { className: 'field-problem-caption' },
          h('rect', { x: caption.x, y: caption.y, width: caption.width, height: P(20), rx: P(10), fill: issue.severity === 'warning' ? '#29251b' : '#2b1c1c', stroke: 'rgb(255 255 255/.85)', strokeWidth: P(1.5) }),
          h('clipPath', { id: captionId }, h('rect', { x: caption.x + P(6), y: caption.y, width: Math.max(0, caption.width - P(12)), height: P(20) })),
          h('text', { x: caption.x + P(8), y: caption.y + P(13.8), fill: '#e9edf5', fontSize: P(11.5), fontFamily: 'Space Grotesk, sans-serif', clipPath: `url(#${captionId})` }, plain.text)));
    });

    const visitFocusEl = useMemo(() => {
      if (!visitFocus || visitFocus.candidates.length < 2 || pts.length < 2) return null;
      const candidate = visitFocus.candidates[visitFocus.index];
      if (!candidate) return null;
      const total = derived.sample.length || 1;
      const halfSpan = Math.min(0.06, Math.max(0.012, 0.34 / total));
      let path = '';
      for (let index = 0; index <= 20; index++) {
        const f = Math.max(0, Math.min(1, candidate.f - halfSpan + halfSpan * 2 * index / 20));
        const point = W2P(PM.pointAtFraction(f, pts));
        path += (index ? ' L ' : 'M ') + point.x.toFixed(1) + ' ' + point.y.toFixed(1);
      }
      const center = W2P(candidate), text = 'Pass ' + (visitFocus.index + 1) + ' of ' + visitFocus.candidates.length;
      const label = placeFieldLabel(center, P(fieldTextWidth(text, '10.5px "JetBrains Mono", monospace') + 6), P(16), problemBounds, upp,
        [...problemBadges.map(badge => badge.box), ...(selectedCaption ? [selectedCaption] : [])], false);
      const labelX = label.x + P(3), labelY = label.y + P(12);
      return h('g', { className: 'visit-focus', style: { pointerEvents: 'none' } },
        h('path', { d: path, fill: 'none', stroke: '#05060a', strokeWidth: P(8), strokeOpacity: 0.72, strokeLinecap: 'round' }),
        h('path', { d: path, fill: 'none', stroke: accent, strokeWidth: P(4.2), strokeOpacity: 0.96, strokeLinecap: 'round' }),
        h('line', { x1: center.x, y1: center.y - P(8), x2: center.x, y2: center.y + P(8), stroke: accent, strokeWidth: P(1.5) }),
        h('text', { x: labelX, y: labelY, fill: '#e9edf5', stroke: '#0b0c0f', strokeWidth: P(5), paintOrder: 'stroke', fontSize: P(10.5), fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 },
          'Pass ' + (visitFocus.index + 1) + ' of ' + visitFocus.candidates.length));
    }, [visitFocus, pts, derived.sample.length, accent, view.x, view.y, view.w, view.h, cw, W2P, problemBadges, selectedCaption]);

    // ---------- ROBOT (dynamic) ----------
    const robotEl = useMemo(() => {
      const pose = displayedPoseAtTime(playTime, derived, doc);
      if (!pose) return null;
      const c = W2P(pose);
      const degHead = pose.heading * 180 / Math.PI;
      const front = forwardExtent(robot);
      const bump = accent;
      return h('g', { transform: `translate(${c.x} ${c.y}) rotate(${-degHead})`, style: { pointerEvents: 'none' } },
        h('polygon', { points: footprintPoints(robot, 1), fill: 'rgba(14,16,20,0.82)', stroke: bump, strokeWidth: P(3), strokeLinejoin: 'round' }),
        h('polygon', { points: footprintPoints(robot, 0.86), fill: 'none', stroke: 'rgba(255,255,255,0.10)', strokeWidth: P(1), strokeLinejoin: 'round' }),
        h('line', { x1: 0, y1: 0, x2: front + P(3), y2: 0, stroke: '#e8ecf2', strokeWidth: P(2.5) }),
        h('path', { d: `M ${front + P(1)} ${-P(6)} L ${front + P(13)} 0 L ${front + P(1)} ${P(6)} Z`, fill: '#e8ecf2' }));
    }, [playTime, pts, derived, drive, robot, view.w, cw, doc.waypoints]);

    // ---------- ROUTINE OVERLAY (Autonomous Routine / Auto mode) ----------
    const routineLayers = useMemo(() => {
      if (!routine) return null;
      const els = [];
      const STYLE = {
        done:      { col: '#5b636e', w: 2.6, op: 0.5, dash: null },
        pending:   { col: '#474e59', w: 2.2, op: 0.5, dash: `${P(8)} ${P(7)}` },
        dim:       { col: '#3b424b', w: 2, op: 0.32, dash: null },
        active:    { col: accent, w: 3.4, op: 1, dash: null, glow: true },
        focus:     { col: accent, w: 3.7, op: 1, dash: null, glow: true },
        generated: { col: '#f6a93a', w: 3.1, op: 0.97, dash: `${P(10)} ${P(7)}`, gen: true },
        genfocus:  { col: '#ffb347', w: 3.7, op: 1, dash: `${P(10)} ${P(7)}`, gen: true, glow: true },
      };
      // order: dim/done/pending first, active + generated + focus on top
      const rank = (s) => ({ focus: 5, genfocus: 5, active: 4, generated: 3, done: 1, pending: 1, dim: 0 }[s] || 0);
      const order = routine.map((_, i) => i).sort((a, b) => rank(routine[a].state) - rank(routine[b].state));
      order.forEach((ri) => {
        const rp = routine[ri]; if (!rp.pts || rp.pts.length < 2) return;
        const S = STYLE[rp.state] || STYLE.pending;
        const { d, start: a, end: b, mid } = routineRouteGeometry(rp.pts);
        // glow / casing under emphasized paths
        if (S.glow) els.push(h('path', { key: 'rg' + ri, d, fill: 'none', stroke: S.col, strokeOpacity: 0.22, strokeWidth: P(S.w + 9), strokeLinecap: 'round', strokeLinejoin: 'round', style: { pointerEvents: 'none' } }));
        if (rp.state === 'active' || rp.state === 'focus') els.push(h('path', { key: 'rc' + ri, d, fill: 'none', stroke: '#05060a', strokeOpacity: 0.7, strokeWidth: P(S.w + 2.5), strokeLinecap: 'round', strokeLinejoin: 'round', style: { pointerEvents: 'none' } }));
        els.push(h('path', { key: 'rp' + ri, className: S.gen ? 'acq-genpath' : undefined, d, fill: 'none', stroke: S.col, strokeOpacity: S.op, strokeWidth: P(S.w), strokeLinecap: 'round', strokeLinejoin: 'round', strokeDasharray: S.dash || undefined, style: { pointerEvents: 'none' } }));
        els.push(h('path', { key: 'rh' + ri, d, fill: 'none', stroke: 'transparent', strokeWidth: P(16), strokeLinecap: 'round', 'data-role': 'rpath', 'data-idx': rp.nodeId, style: { cursor: 'pointer' } }));
        // endpoint nodes
        const endCol = S.gen ? S.col : null;
        [[a, '#4bbf86'], [b, '#d2655f']].forEach(([c, dc], di) => {
          els.push(h('rect', { key: 'rn' + ri + di, x: c.x - P(4.5), y: c.y - P(4.5), width: P(9), height: P(9), rx: S.gen ? P(4.5) : P(1.5), fill: '#14161a', stroke: rp.state === 'pending' || rp.state === 'dim' ? '#5b636e' : (endCol || dc), strokeWidth: P(1.8), style: { pointerEvents: 'none' } }));
        });
        // runtime bolt marker for generated paths (start)
        if (S.gen && rp.state !== 'dim') {
          els.push(h('g', { key: 'rb' + ri, transform: `translate(${a.x} ${a.y - P(20)})`, style: { pointerEvents: 'none' } },
            h('circle', { r: P(8.5), fill: 'rgba(20,16,10,0.92)', stroke: S.col, strokeWidth: P(1.4) }),
            h('path', { d: `M ${P(1.5)} ${-P(4.5)} L ${-P(3)} ${P(0.8)} L ${P(0.2)} ${P(0.8)} L ${-P(1.5)} ${P(4.5)} L ${P(3)} ${-P(0.8)} L ${P(0.2)} ${-P(0.8)} Z`, fill: S.col })));
        }
        // mid label
        const dim = rp.state === 'dim' || rp.state === 'pending';
        const lblCol = (rp.state === 'active' || rp.state === 'focus') ? accent : S.gen ? S.col : '#8b94a2';
        const txt = (S.gen ? '\u26a1 ' : (rp.idxLabel ? rp.idxLabel + '  ' : '')) + (rp.label || '');
        const tw = P(8.0 * txt.length + 18), th = P(17);
        els.push(h('g', { key: 'rl' + ri, transform: `translate(${mid.x} ${mid.y - P(15)})`, style: { pointerEvents: 'none' }, opacity: dim ? 0.55 : 1 },
          h('rect', { x: -tw / 2, y: -th / 2, width: tw, height: th, rx: P(3), fill: 'rgba(11,12,14,0.92)', stroke: (rp.state === 'active' || rp.state === 'focus') ? accent : S.gen ? S.col : '#2a2e34', strokeWidth: P(1) }),
          h('text', { x: 0, y: P(3.8), fill: lblCol, fontSize: P(11), fontFamily: 'JetBrains Mono, monospace', fontWeight: 600, textAnchor: 'middle' }, txt)));
      });
      return els;
    }, [routine, accent, view.w, cw]);

    const routineRobot = useMemo(() => {
      if (!routine || !routinePose) return null;
      const c = W2P(routinePose);
      const degHead = (routinePose.heading || 0) * 180 / Math.PI;
      const front = forwardExtent(robot);
      const bump = accent;
      return h('g', { transform: `translate(${c.x} ${c.y}) rotate(${-degHead})`, style: { pointerEvents: 'none' } },
        h('polygon', { points: footprintPoints(robot, 1), fill: 'rgba(14,16,20,0.85)', stroke: bump, strokeWidth: P(3), strokeLinejoin: 'round' }),
        h('line', { x1: 0, y1: 0, x2: front + P(3), y2: 0, stroke: '#e8ecf2', strokeWidth: P(2.5) }),
        h('path', { d: `M ${front + P(1)} ${-P(6)} L ${front + P(13)} 0 L ${front + P(1)} ${P(6)} Z`, fill: '#e8ecf2' }));
    }, [routine, routinePose, robot, view.w, cw]);

    const previewEl = (preview && pts.length > 1) ? (function () {
      const totalS = derived.sample.length || 1;
      const dd = FieldScene.fractionPathData(pts, totalS, preview.f0, preview.f1, W2P, 1);
      return dd ? h('path', { d: dd, fill: 'none', stroke: accent, strokeOpacity: 0.45, strokeWidth: P(12), strokeLinecap: 'round', style: { pointerEvents: 'none' } }) : null;
    })() : null;

    const insertionGhost = insertionPreview && insertionPreview.derived && insertionPreview.derived.sample.pts.length > 1 ? (function () {
      const previewPoints = insertionPreview.derived.sample.pts;
      let path = '';
      previewPoints.forEach((point, index) => {
        const q = W2P(point);
        path += (index ? ' L ' : 'M ') + q.x.toFixed(1) + ' ' + q.y.toFixed(1);
      });
      const waypoint = insertionPreview.doc.waypoints[insertionPreview.index];
      const marker = waypoint ? W2P(waypoint) : null;
      return h('g', { className: 'insertion-ghost', style: { pointerEvents: 'none' } },
        h('path', { d: path, fill: 'none', stroke: '#05060a', strokeOpacity: 0.78, strokeWidth: P(6), strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: path, fill: 'none', stroke: accent, strokeOpacity: 0.92, strokeWidth: P(2.5), strokeDasharray: `${P(8)} ${P(6)}`, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        marker && h('circle', { cx: marker.x, cy: marker.y, r: P(7), fill: '#101216', stroke: accent, strokeWidth: P(2) }));
    })() : null;

    const proposalGhosts = (proposalPreviews || []).map((candidate, candidateIndex) => {
      const previewPoints = candidate.derived && candidate.derived.sample && candidate.derived.sample.pts;
      if (!previewPoints || previewPoints.length < 2) return null;
      let path = '';
      previewPoints.forEach((point, index) => { const q = W2P(point); path += (index ? ' L ' : 'M ') + q.x.toFixed(1) + ' ' + q.y.toFixed(1); });
      const color = candidate.valid ? (candidate.selected ? accent : '#a7b1c2') : '#d2655f';
      return h('g', { key: candidate.id || candidateIndex, className: 'agent-proposal-ghost', style: { pointerEvents: 'none' } },
        candidate.selected && h('path', { d: path, fill: 'none', stroke: '#05060a', strokeOpacity: 0.76, strokeWidth: P(7), strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: path, fill: 'none', stroke: color, strokeOpacity: candidate.selected ? 0.96 : 0.48, strokeWidth: P(candidate.selected ? 3 : 2), strokeDasharray: `${P(candidate.selected ? 9 : 5)} ${P(6)}`, strokeLinecap: 'round', strokeLinejoin: 'round' }));
    });

    const snapEl = (snap && doc.waypoints[snap.idx]) ? (function () { const c = W2P(doc.waypoints[snap.idx]); return h('g', { transform: `translate(${c.x} ${c.y - P(34)})`, style: { pointerEvents: 'none' } }, h('rect', { x: -P(37), y: -P(11), width: P(74), height: P(20), rx: P(4), fill: 'rgba(11,12,14,0.95)', stroke: accent, strokeWidth: P(1) }), h('text', { x: 0, y: P(4), fill: accent, fontSize: P(11), fontFamily: 'JetBrains Mono, monospace', fontWeight: 600, textAnchor: 'middle' }, snap.label)); })() : null;

    const vb = `${view.x} ${view.y} ${view.w} ${view.h}`;

    const cursor = drag.current && drag.current.moved && drag.current.role === 'bg' ? 'grabbing' : undefined;

    return h('svg', {
      ref: svgRef, className: 'fieldsvg', tabIndex: routine ? undefined : 0, 'aria-label': 'Path field', onKeyDown: onFieldKeyDown, viewBox: vb, preserveAspectRatio: 'xMidYMid meet',
      onPointerDown: onDown, onPointerMove: onHoverMove,
      onPointerLeave: () => hoverStore?.clear('field', hoverContext),
      onPointerCancel: () => hoverStore?.clear('field', hoverContext),
      onLostPointerCapture: () => hoverStore?.clear('field', hoverContext),
      onWheel: onWheel, onDoubleClick: onDbl,
      style: { cursor, userSelect: 'none', WebkitUserSelect: 'none', touchAction: 'none' },
      onContextMenu: onCtx, onDragStart: (e) => e.preventDefault(), draggable: false,
    },
      h('rect', { x: -2000, y: -2000, width: IMG_W + 4000, height: IMG_H + 4000, fill: '#0a0b0d', 'data-role': 'bg' }),
      h('rect', { x: X0 - 6, y: Y0 - 6, width: (X1 - X0) + 12, height: (Y1 - Y0) + 12, rx: 4, fill: '#131418', stroke: '#2a2d33', strokeWidth: P(1.5), 'data-role': 'bg' }),
      h('foreignObject', { x: 0, y: 0, width: IMG_W, height: IMG_H, transform: `rotate(${FIELD_IMAGE.rotationDeg} ${(X0+X1)/2} ${(Y0+Y1)/2})`, 'data-role': 'bg', style: { pointerEvents: 'none' } },
        h('img', { src: fieldImage, width: IMG_W, height: IMG_H, draggable: false, style: { width: IMG_W + 'px', height: IMG_H + 'px', display: 'block', opacity: 0.9, filter: 'brightness(0.38) saturate(0.32) contrast(1.06)', WebkitUserDrag: 'none', userSelect: 'none', pointerEvents: 'none' } })),
      h('rect', { className: 'field-frame', x: X0, y: Y0, width: X1 - X0, height: Y1 - Y0, fill: 'none', stroke: '#ffffff', strokeOpacity: 0.12, strokeWidth: P(1), style: { pointerEvents: 'none' } }),
      !routine && props.optimizationCorridor?.points?.length > 1 && h('polyline', {
        className: 'optimization-corridor',
        points: props.optimizationCorridor.points.map((point) => `${point.x},${point.y}`).join(' '),
        fill: 'none', stroke: accent, strokeOpacity: 0.14,
        strokeWidth: props.optimizationCorridor.widthM * 2, strokeLinecap: 'round', strokeLinejoin: 'round',
        transform: `translate(${X0} ${Y1}) scale(${SX} ${-SY})`,
        style: { pointerEvents: 'none' },
      }),
      routine ? null : problemUnderlays,
      routine ? routineLayers : staticLayers,
      routine ? null : visitFocusEl,
      routine ? null : previewEl,
      routine ? null : insertionGhost,
      routine ? null : proposalGhosts,
      routine ? routineRobot : robotEl,
      !routine && hoverStore && h(HoverGhost, { store: hoverStore, context: hoverContext, derived, doc, robot, W2P, P }),
      routine ? null : snapEl,
      routine ? null : problemBadgeEls,
    );
  }

export const FIELD_DIMS = { FIELD_W, FIELD_H, IMG_W, IMG_H };
export { FieldView, rangeLabelIndexes, toolRailLabelObstacle, createFieldGestureOwner, fieldRangeEndpoint };
