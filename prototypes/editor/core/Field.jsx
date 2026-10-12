// Shared field canvas for every prototype variant. Direct manipulation only; it never refuses input.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import fieldImage from "../../../src/renderer/assets/field.png";
import { FieldScene } from "../../../src/renderer/assets/field-scene";
import { PM } from "../../../src/renderer/lib/pathMath";
import { moveWaypointTo, setWaypointFacing } from "../../../src/renderer/lib/pathEditing";
import { moveWaypointHandle } from "./editing.js";
import { poseOnTiming } from "./planning";

// Field image calibration (same as the production FieldView).
const IMG_W = 3901, IMG_H = 1583, X0 = 397, X1 = 3502, Y0 = 97, Y1 = 1486;
export const FIELD_W = 17.548, FIELD_H = 8.052;
const SX = (X1 - X0) / FIELD_W, SY = (Y1 - Y0) / FIELD_H;
const D2R = Math.PI / 180;

const STOPS = [[0, 0.6, 0.13, 258], [0.5, 0.77, 0.11, 200], [1, 0.87, 0.15, 92]];
export function speedColor(v, vmax) {
  const t = Math.max(0, Math.min(1, vmax > 0 ? v / vmax : 0));
  const i = t < 0.5 ? 0 : 1;
  const [t0, l0, c0, h0] = STOPS[i], [t1, l1, c1, h1] = STOPS[i + 1];
  const u = (t - t0) / (t1 - t0);
  return `oklch(${(l0 + (l1 - l0) * u).toFixed(3)} ${(c0 + (c1 - c0) * u).toFixed(3)} ${(h0 + (h1 - h0) * u).toFixed(1)})`;
}

/** Nearest point on the sampled polyline (not just the nearest sample, which misses between samples when zoomed in). */
function nearestSample(pts, x, y) {
  let best = 0, bestD = Infinity, bestS = 0;
  if (pts.length === 1) return { index: 0, distance: Math.hypot(pts[0].x - x, pts[0].y - y), s: pts[0].s || 0 };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    const u = len2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2)) : 0;
    const d = (a.x + dx * u - x) ** 2 + (a.y + dy * u - y) ** 2;
    if (d < bestD) { bestD = d; best = u < 0.5 ? i : i + 1; bestS = (a.s || 0) + ((b.s || 0) - (a.s || 0)) * u; }
  }
  return { index: best, distance: Math.sqrt(bestD), s: bestS };
}

/** Splits the segment containing sample `index` exactly (Bézier) and inserts a waypoint there. */
export function insertWaypointAtSample(path, derived, index) {
  const pts = derived.sample.pts, wpIdx = derived.wpIdx || [];
  let seg = 0;
  while (seg < wpIdx.length - 2 && index >= wpIdx[seg + 1]) seg++;
  const a = path.waypoints[seg], b = path.waypoints[seg + 1];
  if (!a || !b) return { path, index: -1 };
  const span = Math.max(1, wpIdx[seg + 1] - wpIdx[seg]);
  const u = Math.max(0.05, Math.min(0.95, (index - wpIdx[seg]) / span));
  const p = pts[index];
  const fresh = { x: p.x, y: p.y, theta: ((p.heading || 0) / D2R), thetaOn: false, linked: true, stop: false, segType: a.segType || "bezier" };
  if ((a.segType || "bezier") === "bezier" && a.nextC && b.prevC) {
    const split = PM.splitBezier(a, a.nextC, b.prevC, b, u);
    a.nextC = split.left[1];
    fresh.prevC = split.left[2];
    fresh.x = split.point.x; fresh.y = split.point.y;
    fresh.nextC = split.right[1];
    b.prevC = split.right[2];
  } else {
    const handles = PM.autoHandles([a, fresh, b], 1);
    fresh.prevC = handles.prevC; fresh.nextC = handles.nextC;
  }
  path.waypoints.splice(seg + 1, 0, fresh);
  return { path, index: seg + 1 };
}

/**
 * Props:
 *  path, derived, issues, robot, selection, onSelect(sel|null), edit(fn, phase)
 *  playhead: { t, visible } (optional), tool: 'edit' | 'command'
 *  onPlaceCommand(f): called when tool==='command' and the path is clicked
 *  insets: { top, right, bottom, left } px kept clear of chrome when fitting
 *  ghosts: other paths' derived results to draw faintly [{ id, derived, onClick }]
 *  children(api): HTML overlay render prop; api = { w2s, pointAt(f), fit, camera }
 *  commandLabel(marker) -> string
 */
export function Field({
  path, derived, issues = [], robot, selection, onSelect, edit, playhead, tool = "edit",
  onPlaceCommand, insets = {}, ghosts = [], children, commandLabel = (m) => m.name, showHeadings = true,
}) {
  const host = useRef(null);
  const [size, setSize] = useState({ w: 1200, h: 700 });
  const [cam, setCam] = useState(null);
  const [hover, setHover] = useState(null);
  const drag = useRef(null);

  useLayoutEffect(() => {
    const el = host.current;
    // Measure before the first paint so the first fit uses the real size, not the placeholder.
    const r = el.getBoundingClientRect();
    if (r.width && r.height) setSize({ w: r.width, h: r.height });
    const ro = new ResizeObserver(([entry]) => setSize({ w: entry.contentRect.width, h: entry.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fitCam = useCallback(() => {
    const top = insets.top || 0, right = insets.right || 0, bottom = insets.bottom || 0, left = insets.left || 0;
    const w = Math.max(100, size.w - left - right - 32), h = Math.max(100, size.h - top - bottom - 32);
    const k = Math.min(w / FIELD_W, h / FIELD_H);
    return { x: FIELD_W / 2 - (left - right) / 2 / k, y: FIELD_H / 2 + (top - bottom) / 2 / k, k };
  }, [size, insets.top, insets.right, insets.bottom, insets.left]);
  // Refit on resize until the user pans or zooms; an explicit fit hands the camera back.
  const userCam = useRef(false);
  useEffect(() => { if (!userCam.current || !cam) setCam(fitCam()); }, [fitCam]); // eslint-disable-line
  const c = cam || fitCam();
  const camRef = useRef(c), sizeRef = useRef(size), autoPan = useRef(0);
  camRef.current = c; sizeRef.current = size;
  useEffect(() => () => cancelAnimationFrame(autoPan.current), []);

  const w2s = useCallback((x, y) => ({ x: (x - c.x) * c.k + size.w / 2, y: -(y - c.y) * c.k + size.h / 2 }), [c, size]);
  const s2w = useCallback((sx, sy) => ({ x: (sx - size.w / 2) / c.k + c.x, y: -(sy - size.h / 2) / c.k + c.y }), [c, size]);
  const local = (e) => { const r = host.current.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  const pts = derived?.sample?.pts || [];
  const total = pts.length ? pts[pts.length - 1].s || 1 : 1;
  const pointAt = useCallback((f) => {
    if (!pts.length) return { x: 0, y: 0, heading: 0 };
    const p = PM.pointAtFraction(f, pts);
    return { ...p, ...w2s(p.x, p.y), wx: p.x, wy: p.y };
  }, [pts, w2s]);

  // ---------- pointer ----------
  const onPointerDown = (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    const p = local(e);
    const role = e.target.closest?.("[data-role]")?.dataset;
    host.current.setPointerCapture(e.pointerId);
    if (e.button === 1 || !role || role.role === "bg") {
      if (tool === "command" && hover?.kind === "insert") {
        onPlaceCommand?.((hover.s ?? pts[hover.index].s) / total);
        return;
      }
      if (hover?.kind === "insert" && tool === "edit") {
        let created = -1;
        edit((draft) => { const r = insertWaypointAtSample(draft, derived, hover.index); created = r.index; return r.path; }, "begin");
        setTimeout(() => { onSelect({ kind: "waypoint", index: created }); }, 0);
        drag.current = { kind: "waypoint", index: -2, pending: true, start: p };
        // The created index is known after the edit; resolve lazily on move.
        drag.current.resolve = () => created;
        return;
      }
      drag.current = { kind: "pan", start: p, cam: c, moved: false };
      return;
    }
    const index = Number(role.index);
    if (role.role === "waypoint") {
      onSelect({ kind: "waypoint", index });
      edit((d) => d, "begin");
      drag.current = { kind: "waypoint", index, start: p };
    } else if (role.role === "handle") {
      edit((d) => d, "begin");
      drag.current = { kind: "handle", index, side: role.side };
    } else if (role.role === "heading") {
      onSelect({ kind: "waypoint", index });
      edit((d) => d, "begin");
      drag.current = { kind: "heading", index };
    } else if (role.role === "command") {
      onSelect({ kind: "command", id: role.id });
      edit((d) => d, "begin");
      drag.current = { kind: "command", id: role.id };
    } else if (role.role === "issue") {
      drag.current = null;
    }
  };

  const onPointerMove = (e) => {
    const p = local(e);
    const d = drag.current;
    if (!d) {
      if (!pts.length) return;
      const role = e.target.closest?.("[data-role]")?.dataset?.role;
      if (role && role !== "bg") { if (hover?.kind === "insert") setHover(null); return; }
      const w = s2w(p.x, p.y);
      const near = nearestSample(pts, w.x, w.y);
      if (near.distance * c.k < 12) setHover({ kind: "insert", index: near.index, s: near.s });
      else if (hover) setHover(null);
      return;
    }
    if (d.kind === "pan") {
      d.moved = d.moved || Math.hypot(p.x - d.start.x, p.y - d.start.y) > 3;
      if (d.moved) userCam.current = true;
      setCam({ ...d.cam, x: d.cam.x - (p.x - d.start.x) / d.cam.k, y: d.cam.y + (p.y - d.start.y) / d.cam.k });
      return;
    }
    d.last = p; d.shift = e.shiftKey;
    applyDrag(d, p);
    if (DRAGGED.has(d.kind) && !autoPan.current && edgeOvershoot(p).some(Boolean)) autoPan.current = requestAnimationFrame(panStep);
  };

  // A dragged object never leaves the visible field: the pointer is held inside it, and at the edge the
  // camera pans toward the pointer (only as far as the field extends past the view). The object stays under
  // the cursor and can always be grabbed again, so a far drag is recovered by dragging back, without undo.
  const DRAGGED = new Set(["waypoint", "handle", "command"]);
  const KEEP = 12, EDGE = 28;
  const edgeOvershoot = (p) => {
    const s = sizeRef.current;
    const o = (v, max) => (v < EDGE ? v - EDGE : v > max - EDGE ? v - (max - EDGE) : 0);
    return [o(p.x, s.w), o(p.y, s.h)];
  };
  const toWorld = (p) => {
    const s = sizeRef.current, k = camRef.current;
    const x = Math.max(KEEP, Math.min(s.w - KEEP, p.x)), y = Math.max(KEEP, Math.min(s.h - KEEP, p.y));
    return { x: (x - s.w / 2) / k.k + k.x, y: -(y - s.h / 2) / k.k + k.y };
  };
  const panStep = () => {
    const d = drag.current;
    autoPan.current = 0;
    if (!d?.last || !DRAGGED.has(d.kind)) return;
    const s = sizeRef.current, k = camRef.current, [ox, oy] = edgeOvershoot(d.last);
    const speed = (o) => (Math.sign(o) * Math.min(18, 2 + Math.abs(o) * 0.3)) / k.k;
    // Toward the pointer, never past the field plus a small margin, and never jumping back.
    const along = (center, delta, half, extent) => {
      if (!delta || 2 * half >= extent + 1) return center;
      const lo = half - 0.5, hi = extent + 0.5 - half;
      return delta > 0 ? Math.max(center, Math.min(center + delta, hi)) : Math.min(center, Math.max(center + delta, lo));
    };
    const x = along(k.x, speed(ox), s.w / 2 / k.k, FIELD_W), y = along(k.y, -speed(oy), s.h / 2 / k.k, FIELD_H);
    if (x === k.x && y === k.y) return;
    const next = { ...k, x, y };
    camRef.current = next; userCam.current = true; setCam(next);
    applyDrag(d, d.last);
    autoPan.current = requestAnimationFrame(panStep);
  };
  const applyDrag = (d, p) => {
    const w = toWorld(p);
    if (d.kind === "waypoint") {
      const index = d.index === -2 ? d.resolve() : d.index;
      if (index < 0) return;
      edit((draft) => moveWaypointTo(draft, index, w), "update");
    } else if (d.kind === "handle") {
      edit((draft) => moveWaypointHandle(draft, d.index, d.side, w), "update");
    } else if (d.kind === "heading") {
      edit((draft) => {
        const wp = draft.waypoints[d.index];
        let deg = Math.atan2(w.y - wp.y, w.x - wp.x) / D2R;
        if (d.shift) deg = Math.round(deg / 15) * 15;
        return setWaypointFacing(draft, d.index, Math.round(deg * 10) / 10);
      }, "update");
    } else if (d.kind === "command") {
      const f = nearestSample(pts, w.x, w.y).s / total;
      edit((draft) => { const m = draft.markers.find((x) => x.id === d.id); if (m) m.f = Math.round(f * 1000) / 1000; return draft; }, "update");
    }
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    cancelAnimationFrame(autoPan.current); autoPan.current = 0;
    if (!d) return;
    if (d.kind === "pan") { if (!d.moved) onSelect(null); return; }
    edit(null, "end");
  };

  const onWheel = (e) => {
    const p = local(e);
    const before = s2w(p.x, p.y);
    const k = Math.max(20, Math.min(600, c.k * Math.exp(-e.deltaY * 0.0015)));
    userCam.current = true;
    setCam({ k, x: before.x - (p.x - size.w / 2) / k, y: before.y + (p.y - size.h / 2) / k });
  };

  // ---------- geometry ----------
  const speeds = derived?.metrics?.v || [];
  const vmax = Math.max(0.1, robot.maxSpeed || 4);
  const pathSegments = useMemo(() => {
    if (pts.length < 2) return [];
    const out = [];
    const step = Math.max(1, Math.floor(pts.length / 160));
    for (let i = 0; i < pts.length - 1; i += step) {
      const j = Math.min(pts.length - 1, i + step);
      const a = w2s(pts[i].x, pts[i].y), b = w2s(pts[j].x, pts[j].y);
      out.push({ d: `M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}`, color: speedColor(speeds[i] || 0, vmax) });
    }
    return out;
  }, [pts, speeds, vmax, w2s]);
  const fullD = useMemo(() => FieldScene.pathData(pts, null, (q) => w2s(q.x, q.y), 1), [pts, w2s]);

  const img = w2s(-X0 / SX, Y1 / SY);
  const robotRect = (x, y, headingRad, extra = {}) => {
    const s = w2s(x, y), w = robot.w * c.k, l = robot.l * c.k;
    return <g transform={`translate(${s.x} ${s.y}) rotate(${-headingRad / D2R})`} {...extra}>
      <rect x={-l / 2} y={-w / 2} width={l} height={w} rx={Math.min(6, w * 0.12)} />
      <path d={`M${l / 2 - Math.min(10, l * 0.25)} ${-Math.min(6, w * 0.18)}L${l / 2 - 2} 0L${l / 2 - Math.min(10, l * 0.25)} ${Math.min(6, w * 0.18)}`} className="nose" />
    </g>;
  };

  const pose = playhead?.visible ? poseOnTiming(derived?.trajectorySamples, playhead.t) : null;

  const selectedWp = selection?.kind === "waypoint" ? path.waypoints[selection.index] : null;
  const wpFrac = derived?.wpFrac || [];
  const api = { w2s, pointAt, fit: () => { userCam.current = false; setCam(fitCam()); }, camera: c, size, wpFrac };

  return (
    <div ref={host} className="pf-field" data-tool={tool}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onPointerLeave={() => setHover(null)} onWheel={onWheel} onDoubleClick={(e) => { if (!e.target.closest?.("[data-role]") || e.target.closest("[data-role]").dataset.role === "bg") { userCam.current = false; setCam(fitCam()); } }}>
      <svg width={size.w} height={size.h} className="pf-svg">
        <image href={fieldImage} x={img.x} y={img.y} width={(IMG_W / SX) * c.k} height={(IMG_H / SY) * c.k} className="pf-field-image" data-role="bg" preserveAspectRatio="none" />

        {ghosts.map((g) => {
          const gp = g.derived?.sample?.pts || [];
          if (gp.length < 2) return null;
          const d = FieldScene.pathData(gp, null, (q) => w2s(q.x, q.y), 1);
          return <path key={g.id} d={d} className="pf-ghost" data-role="ghost" onPointerDown={(e) => { e.stopPropagation(); g.onClick?.(); }} />;
        })}

        {path.waypoints.map((w, i) => w.thetaOn && showHeadings
          ? <g key={"fp" + i} className={"pf-footprint" + (i === 0 ? " start" : i === path.waypoints.length - 1 ? " end" : "")}>{robotRect(w.x, w.y, w.theta * D2R)}</g> : null)}

        {(path.ranges || []).map((r, i) => {
          if (r.anchor !== "param") return null;
          const d = FieldScene.fractionPathData(pts, total, r.f0, r.f1, (q) => w2s(q.x, q.y), 1);
          return <path key={"zone" + i} d={d} className="pf-zone" />;
        })}

        <path d={fullD} className="pf-casing" />
        {pathSegments.map((s, i) => <path key={i} d={s.d} stroke={s.color} className="pf-path" />)}

        {issues.map((issue, i) => {
          const d = issue.whole ? fullD : FieldScene.fractionPathData(pts, total, issue.f0, issue.f1, (q) => w2s(q.x, q.y), 1);
          return <path key={"iss" + i} d={d} className={"pf-issue " + issue.severity + (issue.whole ? " whole" : "")} />;
        })}

        {hover?.kind === "insert" && pts[hover.index] && (() => {
          const s = w2s(pts[hover.index].x, pts[hover.index].y);
          return <g className={"pf-insert" + (tool === "command" ? " command" : "")} transform={`translate(${s.x} ${s.y})`} pointerEvents="none">
            <circle r="9" />
            {tool === "command" ? <path d="M-3 -5V5M-3 -5H4L2 -2.5L4 0H-3" /> : <path d="M-4 0H4M0 -4V4" />}
          </g>;
        })()}

        {(path.markers || []).map((m) => {
          const p = pointAt(m.f);
          const sel = selection?.kind === "command" && selection.id === m.id;
          return <g key={m.id} transform={`translate(${p.x} ${p.y})`} className={"pf-command" + (sel ? " selected" : "")} data-role="command" data-id={m.id}>
            <circle r="12" className="hit" />
            <rect x="-5" y="-5" width="10" height="10" rx="2" transform="rotate(45)" />
            <title>{commandLabel(m)}</title>
          </g>;
        })}

        {selectedWp && ["prev", "next"].map((side) => {
          const hnd = selectedWp[side === "prev" ? "prevC" : "nextC"];
          if (!hnd || (side === "prev" && selection.index === 0) || (side === "next" && selection.index === path.waypoints.length - 1)) return null;
          const a = w2s(selectedWp.x, selectedWp.y), b = w2s(hnd.x, hnd.y);
          return <g key={side} className="pf-handle">
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
            <circle cx={b.x} cy={b.y} r="5" data-role="handle" data-index={selection.index} data-side={side} data-wx={hnd.x.toFixed(3)} data-wy={hnd.y.toFixed(3)} />
          </g>;
        })}

        {path.waypoints.map((w, i) => {
          const s = w2s(w.x, w.y);
          const sel = selection?.kind === "waypoint" && selection.index === i;
          const cls = "pf-wp" + (i === 0 ? " start" : i === path.waypoints.length - 1 ? " end" : "") + (w.stop ? " stop" : "") + (sel ? " selected" : "");
          const knob = w.thetaOn && showHeadings ? { x: s.x + Math.cos(w.theta * D2R) * Math.max(34, robot.l * c.k * 0.75), y: s.y - Math.sin(w.theta * D2R) * Math.max(34, robot.l * c.k * 0.75) } : null;
          return <g key={"wp" + i}>
            {knob && (sel || hover?.wp === i) && <line x1={s.x} y1={s.y} x2={knob.x} y2={knob.y} className="pf-heading-stalk" />}
            {knob && <circle cx={knob.x} cy={knob.y} r="5.5" className={"pf-heading" + (sel ? " selected" : "")} data-role="heading" data-index={i}><title>Drag to turn</title></circle>}
            <g className={cls} transform={`translate(${s.x} ${s.y})`} data-role="waypoint" data-index={i} data-wx={w.x.toFixed(3)} data-wy={w.y.toFixed(3)}
              onPointerEnter={() => setHover({ wp: i })} onPointerLeave={() => setHover(null)}>
              <circle r="14" className="hit" />
              {w.stop ? <rect x="-6.5" y="-6.5" width="13" height="13" rx="2.5" /> : <circle r="6.5" />}
            </g>
          </g>;
        })}

        {pose && <g className="pf-robot">{robotRect(pose.x, pose.y, pose.heading)}</g>}
      </svg>
      <div className="pf-overlay">{children?.(api)}</div>
    </div>
  );
}
