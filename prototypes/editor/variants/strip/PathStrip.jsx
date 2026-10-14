// The path strip: the active path unrolled along time. Speed curve, limits, zones, stops and commands,
// all editable here. Shares hover and the playhead with the field.
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { speedColor } from "../../core/Field";
import { COMMANDS } from "../../core/project";
import { NumberField } from "./NumberField";
import { Catalog, Icon, Popover, markerLabel, useDismiss } from "./parts";
import { fAtT, fmt, niceStep, tAtF, vAtT } from "./timeline";

const GUTTER = 80, RIGHT = 20, HEAD = 40, RULER = 22, WPROW = 24, LANE = 54, PAD = 8;
const ROW_H = 22;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Pointer drag helper bound to one element: start(e) returns a state object or null. */
function dragHandlers({ start, move, end, threshold = 0 }) {
  return {
    onPointerDown: (e) => {
      if (e.button !== 0) return;
      const state = start(e);
      if (!state) return;
      e.stopPropagation();
      e.preventDefault();
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      const s = { ...state, x0: e.clientX, y0: e.clientY, moved: threshold === 0 };
      const onMove = (ev) => {
        if (!s.moved && Math.hypot(ev.clientX - s.x0, ev.clientY - s.y0) < threshold) return;
        const first = !s.moved;
        s.moved = true;
        move?.(ev, s, first);
      };
      const onUp = (ev) => {
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        el.removeEventListener("pointercancel", onUp);
        end?.(ev, s);
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
      el.addEventListener("pointercancel", onUp);
    },
  };
}

let measureCtx = null;
function textWidth(text) {
  measureCtx = measureCtx || document.createElement("canvas").getContext("2d");
  measureCtx.font = '11.5px "Space Grotesk", system-ui, sans-serif';
  return measureCtx.measureText(text).width;
}

export function PathStrip({
  path, tl, issues, stale, robot, selection, setSelection, edit, playback, hover, setHover,
  onAddCommand, onSetCommand, onDeleteCommand, onDeleteZone, onFixIssue,
}) {
  const root = useRef(null);
  const [size, setSize] = useState({ w: 1200, h: 270 });
  useLayoutEffect(() => {
    const ro = new ResizeObserver(([entry]) => setSize({ w: entry.contentRect.width, h: entry.contentRect.height }));
    ro.observe(root.current);
    return () => ro.disconnect();
  }, []);

  // While a timing drag runs, hold the time axis so the curve visibly stretches or shrinks.
  const [frozenT, setFrozenT] = useState(null);
  const T = frozenT ? Math.max(frozenT, tl.total) : tl.total;
  const { w: W, h: H } = size;
  const plotW = Math.max(50, W - GUTTER - RIGHT);
  const graphTop = HEAD + RULER + 4;
  const graphH = Math.max(40, H - graphTop - WPROW - LANE - PAD);
  const graphBottom = graphTop + graphH;
  const wpTop = graphBottom;
  const laneTop = wpTop + WPROW;
  const vTop = Math.max(1, Math.ceil(robot.maxSpeed));
  const x = (t) => GUTTER + (t / T) * plotW;
  const tAtX = (px) => clamp(((px - GUTTER) / plotW) * T, 0, T);
  const y = (v) => graphBottom - (clamp(v, 0, vTop) / vTop) * graphH;
  const vAtY = (py) => ((graphBottom - py) / graphH) * vTop;
  const localX = (e) => e.clientX - root.current.getBoundingClientRect().left;
  const localY = (e) => e.clientY - root.current.getBoundingClientRect().top;

  const [placing, setPlacing] = useState(null); // { t } while the catalog is open from the lane
  const placingRef = useRef(null);
  const laneRef = useRef(null);
  const closePlacing = (why) => { setPlacing(null); if (why === "escape") laneRef.current?.focus(); };
  useDismiss(placingRef, closePlacing, Boolean(placing));
  const [laneGhost, setLaneGhost] = useState(null);

  const maxVel = path.constraints.maxVel;
  const accel = path.constraints.maxAccel;
  const zones = (path.ranges || []).map((r, index) => ({ ...r, index })).filter((r) => r.anchor === "param");
  const markers = path.markers || [];

  // ---------- geometry ----------
  const curve = useMemo(() => {
    const p = tl.points;
    const segs = [];
    let area = `M${x(p[0].t).toFixed(1)} ${graphBottom}`;
    for (let i = 0; i < p.length; i++) {
      area += `L${x(p[i].t).toFixed(1)} ${y(p[i].v).toFixed(1)}`;
      if (i > 0) segs.push({ x1: x(p[i - 1].t), y1: y(p[i - 1].v), x2: x(p[i].t), y2: y(p[i].v), c: speedColor((p[i - 1].v + p[i].v) / 2, robot.maxSpeed) });
    }
    area += `L${x(p[p.length - 1].t).toFixed(1)} ${graphBottom}Z`;
    return { segs, area };
  }, [tl, T, W, H, robot.maxSpeed]); // eslint-disable-line react-hooks/exhaustive-deps

  const tStep = niceStep(T, Math.max(2, plotW / 90));
  const tTicks = [];
  for (let t = 0; t <= T + 1e-6; t += tStep) tTicks.push(Number(t.toFixed(4)));
  const vTicks = Array.from({ length: vTop + 1 }, (_, i) => i).filter((v) => graphH > 70 || v % 2 === 0 || v === vTop);

  // Command chips packed into two rows.
  const chips = useMemo(() => {
    const sorted = markers.map((m) => ({ m, t: tAtF(tl, m.f) })).sort((a, b) => a.t - b.t);
    const ends = [-Infinity, -Infinity];
    return sorted.map(({ m, t }) => {
      const label = markerLabel(m);
      const w = Math.min(160, Math.ceil(textWidth(label)) + 29);
      const cx = x(t);
      const flip = cx - 10 + w > W - 6;
      const left = flip ? cx - w + 10 : cx - 10;
      let row = ends[0] <= left - 4 ? 0 : ends[1] <= left - 4 ? 1 : ends[0] <= ends[1] ? 0 : 1;
      ends[row] = left + w;
      return { m, t, cx, left, w, row, flip, label };
    });
  }, [markers, tl, T, W]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- interactions ----------
  const seekAt = (e) => playback.seek(tAtX(localX(e)));
  const scrub = dragHandlers({
    start: (e) => { seekAt(e); return {}; },
    move: (e) => seekAt(e),
  });

  const limitDrag = dragHandlers({
    start: () => { setFrozenT(tl.total); edit((p) => p, "begin"); return {}; },
    move: (e) => {
      const v = Math.round(clamp(vAtY(localY(e)), 0, robot.maxSpeed) * 20) / 20;
      edit((p) => { p.constraints.maxVel = v; return p; }, "update");
    },
    end: () => { edit(null, "end"); setFrozenT(null); },
  });

  const zoneCapDrag = (index) => dragHandlers({
    start: () => { setSelection({ kind: "zone", index }); setFrozenT(tl.total); edit((p) => p, "begin"); return {}; },
    move: (e) => {
      const v = Math.round(clamp(vAtY(localY(e)), 0, robot.maxSpeed) * 20) / 20;
      edit((p) => { p.ranges[index].maxVel = v; return p; }, "update");
    },
    end: () => { edit(null, "end"); setFrozenT(null); },
  });

  const zoneEdgeDrag = (index, side) => dragHandlers({
    start: () => { setSelection({ kind: "zone", index }); setFrozenT(tl.total); edit((p) => p, "begin"); return { tl0: tl }; },
    move: (e, s) => {
      const f = fAtT(s.tl0, tAtX(localX(e)));
      edit((p) => {
        const r = p.ranges[index];
        if (side === "f0") r.f0 = Math.round(clamp(f, 0, r.f1 - 0.01) * 1000) / 1000;
        else r.f1 = Math.round(clamp(f, r.f0 + 0.01, 1) * 1000) / 1000;
        return p;
      }, "update");
    },
    end: () => { edit(null, "end"); setFrozenT(null); },
  });

  const chipDrag = (m) => dragHandlers({
    threshold: 3,
    start: () => ({ f0: m.f, offset: 0 }),
    move: (e, s, first) => {
      if (first) edit((p) => p, "begin");
      const f = Math.round(fAtT(tl, tAtX(localX(e))) * 1000) / 1000;
      edit((p) => { const mk = p.markers.find((q) => q.id === m.id); if (mk) mk.f = f; return p; }, "update");
      setHover({ t: tAtX(localX(e)), src: "strip" });
    },
    end: (e, s) => {
      if (s.moved) edit(null, "end");
      setSelection({ kind: "command", id: m.id });
      // Pointer users keep Space for play; keyboard focus is unaffected.
      e.target.closest?.("button")?.blur();
    },
  });

  const keyNudge = (e, value, step, apply) => {
    const dir = e.key === "ArrowUp" || e.key === "ArrowRight" ? 1 : e.key === "ArrowDown" || e.key === "ArrowLeft" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    apply(Math.round((value + dir * step * (e.shiftKey ? 10 : 1)) * 1000) / 1000);
  };

  const onBodyMove = (e) => {
    const px = localX(e), py = localY(e);
    if (px < GUTTER - 4 || px > W - RIGHT + 4 || py < HEAD) { if (hover?.src === "strip") setHover(null); return; }
    setHover({ t: tAtX(px), src: "strip" });
  };

  const selectedCommand = selection?.kind === "command" ? chips.find((c) => c.m.id === selection.id) : null;
  const selectedZone = selection?.kind === "zone" ? zones.find((z) => z.index === selection.index) : null;
  const hoverT = hover ? clamp(hover.t, 0, T) : null;
  const playX = x(clamp(playback.t, 0, T));

  return (
    <section
      ref={root}
      className="strip-strip"
      aria-label="Path timeline"
      onPointerMove={onBodyMove}
      onPointerLeave={() => { if (hover?.src === "strip") setHover(null); setLaneGhost(null); }}
    >
      {/* ---------- header ---------- */}
      <div className="strip-head" style={{ height: HEAD }}>
        <div className="strip-head-left" style={{ width: GUTTER + 160 }}>
          <button type="button" className="strip-play" aria-label={playback.playing ? "Pause" : "Play"} title="Space" onClick={playback.toggle}>
            {playback.playing ? <Icon.pause /> : <Icon.play />}
          </button>
          <span className="strip-clock num" aria-live="off">
            <span className="strip-clock-now">{fmt(Math.min(playback.t, tl.total))}</span>
            <span className="strip-clock-sep">/</span>
            <span className="strip-clock-total" data-stale={stale ? "" : undefined}>{tl.empty ? "–" : fmt(tl.total)} s</span>
          </span>
        </div>
        <div className="strip-head-right">
          <NumberField label="Speed" unit="m/s" value={maxVel} step={0.05} min={0} max={robot.maxSpeed} digits={2}
            onChange={(v, phase) => edit((p) => { p.constraints.maxVel = v; return p; }, phase)} />
          <NumberField label="Acceleration" unit="m/s²" value={accel} step={0.1} min={0} max={60} digits={1}
            onChange={(v, phase) => edit((p) => { p.constraints.maxAccel = v; p.constraints.maxDecel = v; return p; }, phase)} />
        </div>
      </div>

      {/* ---------- drawing ---------- */}
      <svg className="strip-svg" width={W} height={H} aria-hidden="true" data-stale={stale ? "" : undefined}>
        {vTicks.map((v) => (
          <g key={"v" + v}>
            <line x1={GUTTER} x2={W - RIGHT} y1={y(v)} y2={y(v)} className={v === 0 ? "strip-axis" : "strip-grid"} />
            <text x={GUTTER - 8} y={y(v) + 3.5} className="strip-tick" textAnchor="end">{v}</text>
          </g>
        ))}
        <text x={12} y={graphTop + 9} className="strip-label">Speed</text>
        <text x={12} y={graphTop + 23} className="strip-unit">m/s</text>

        {tTicks.map((t) => (
          <g key={"t" + t}>
            <line x1={x(t)} x2={x(t)} y1={HEAD + RULER - 5} y2={HEAD + RULER} className="strip-axis" />
            <line x1={x(t)} x2={x(t)} y1={graphTop} y2={graphBottom} className="strip-grid faint" />
            <text x={x(t) + (t === 0 ? -2 : 0)} y={HEAD + 12} className="strip-tick" textAnchor={t === 0 ? "start" : x(t) > W - RIGHT - 12 ? "end" : "middle"}>{t === 0 ? "0" : t.toFixed(Math.max(0, Math.min(3, -Math.floor(Math.log10(tStep) + 1e-9))))}</text>
          </g>
        ))}
        <text x={12} y={HEAD + 13} className="strip-label">Time</text>
        <text x={42} y={HEAD + 13} className="strip-unit">s</text>
        <line x1={GUTTER} x2={W - RIGHT} y1={HEAD + RULER} y2={HEAD + RULER} className="strip-axis" />

        {zones.map((z) => {
          const x0 = x(tAtF(tl, z.f0)), x1 = x(tAtF(tl, z.f1));
          const sel = selectedZone?.index === z.index;
          return (
            <g key={"z" + z.index} className={"strip-zone" + (sel ? " selected" : "")}>
              <rect x={x0} y={graphTop} width={Math.max(1, x1 - x0)} height={graphH} className="strip-zone-fill" />
              {z.maxVel != null && <line x1={x0} x2={x1} y1={y(z.maxVel)} y2={y(z.maxVel)} className="strip-zone-cap" />}
            </g>
          );
        })}

        <path d={curve.area} className="strip-area" />
        {curve.segs.map((s, i) => <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={s.c} className="strip-curve" />)}

        <line x1={GUTTER} x2={W - RIGHT} y1={y(maxVel)} y2={y(maxVel)} className="strip-limit" />

        {issues.map((iss, i) => {
          const x0 = iss.whole ? GUTTER : x(tAtF(tl, iss.f0)), x1 = iss.whole ? W - RIGHT : x(tAtF(tl, iss.f1));
          return (
            <g key={"i" + i} className={"strip-issue " + iss.severity}>
              <rect x={x0} y={graphTop} width={Math.max(2, x1 - x0)} height={graphH} className="strip-issue-fill" />
              <rect x={x0} y={graphTop} width={Math.max(2, x1 - x0)} height={2} className="strip-issue-bar" />
            </g>
          );
        })}

        {hoverT != null && <line x1={x(hoverT)} x2={x(hoverT)} y1={HEAD + RULER} y2={laneTop + LANE - 4} className="strip-hoverline" />}
        <line x1={playX} x2={playX} y1={HEAD + RULER} y2={laneTop + LANE - 4} className="strip-playline" />
      </svg>

      {/* ---------- ruler: click or drag to scrub ---------- */}
      <div
        className="strip-ruler"
        style={{ left: GUTTER, width: plotW, top: HEAD, height: RULER }}
        role="slider"
        tabIndex={0}
        aria-label="Playhead"
        aria-valuemin={0}
        aria-valuemax={Number(tl.total.toFixed(2))}
        aria-valuenow={Number(playback.t.toFixed(2))}
        aria-valuetext={`${fmt(playback.t)} of ${fmt(tl.total)} seconds`}
        onKeyDown={(e) => keyNudge(e, playback.t, 0.1, playback.seek)}
        {...scrub}
      />
      <div className="strip-playhead" style={{ left: playX, top: HEAD + RULER - 9 }} aria-hidden="true" />

      {/* graph background: scrub too */}
      <div className="strip-graph-hit" style={{ left: GUTTER, width: plotW, top: graphTop, height: graphH }} {...scrub} />

      {/* zone handles */}
      {zones.map((z) => {
        const x0 = x(tAtF(tl, z.f0)), x1 = x(tAtF(tl, z.f1));
        const sel = selectedZone?.index === z.index;
        return (
          <div key={"zh" + z.index}>
            <button type="button" className={"strip-zone-tag" + (sel ? " selected" : "")} style={{ left: x0 + 1, top: graphTop + 3, maxWidth: Math.max(28, x1 - x0 - 2) }}
              aria-label={`Zone ${z.name || ""}`} onClick={(e) => { setSelection(sel ? null : { kind: "zone", index: z.index }); if (e.detail > 0) e.currentTarget.blur(); }} onPointerDown={(e) => e.stopPropagation()}>
              {z.name || "Zone"}
            </button>
            {z.maxVel != null && (
              <div className={"strip-zone-cap-hit" + (sel ? " selected" : "")} style={{ left: x0, width: Math.max(8, x1 - x0), top: y(z.maxVel) - 6 }}
                role="slider" tabIndex={0} aria-label={`${z.name || "Zone"} speed`} aria-valuemin={0} aria-valuemax={robot.maxSpeed} aria-valuenow={z.maxVel} aria-valuetext={`${fmt(z.maxVel)} m/s`}
                onKeyDown={(e) => keyNudge(e, z.maxVel, 0.05, (v) => edit((p) => { p.ranges[z.index].maxVel = clamp(v, 0, robot.maxSpeed); return p; }))}
                {...zoneCapDrag(z.index)}>
                <span className="strip-zone-cap-val num">{fmt(z.maxVel)}</span>
              </div>
            )}
            {["f0", "f1"].map((side) => (
              <div key={side} className="strip-zone-edge" style={{ left: (side === "f0" ? x0 : x1) - 5, top: graphTop, height: graphH }}
                role="slider" tabIndex={0} aria-label={`${z.name || "Zone"} ${side === "f0" ? "start" : "end"}`} aria-valuemin={0} aria-valuemax={1} aria-valuenow={z[side]}
                onKeyDown={(e) => keyNudge(e, z[side], 0.005, (f) => edit((p) => { const r = p.ranges[z.index]; r[side] = side === "f0" ? clamp(f, 0, r.f1 - 0.01) : clamp(f, r.f0 + 0.01, 1); return p; }))}
                {...zoneEdgeDrag(z.index, side)} />
            ))}
          </div>
        );
      })}

      {/* speed limit handle */}
      <div className="strip-limit-hit" style={{ left: GUTTER, width: plotW, top: y(maxVel) - 5 }} {...limitDrag} aria-hidden="true" />
      <div className="strip-limit-handle num" style={{ top: y(maxVel), left: W - RIGHT - 56 }}
        role="slider" tabIndex={0} aria-label="Speed limit" aria-valuemin={0} aria-valuemax={robot.maxSpeed} aria-valuenow={maxVel} aria-valuetext={`${fmt(maxVel)} m/s`}
        onKeyDown={(e) => keyNudge(e, maxVel, 0.05, (v) => edit((p) => { p.constraints.maxVel = clamp(v, 0, robot.maxSpeed); return p; }))}
        {...limitDrag}>
        {fmt(maxVel)}
      </div>

      {/* problems */}
      {issues.map((iss, i) => {
        const x0 = iss.whole ? GUTTER : x(tAtF(tl, iss.f0));
        return (
          <div key={"il" + i} className={"strip-issue-label " + iss.severity} style={{ left: x0 + 4, top: graphTop + 6 + i * 22, maxWidth: W - RIGHT - x0 - 8 }} onPointerDown={(e) => e.stopPropagation()}>
            <span className="strip-issue-icon" aria-hidden="true">!</span>
            <span className="strip-issue-text">{iss.message}</span>
            {!iss.whole && <button type="button" className="strip-fix" onClick={() => onFixIssue(iss)}>Lower speed here</button>}
          </div>
        );
      })}

      {/* hover readout */}
      {hoverT != null && (
        <div className="strip-readout num" style={{ left: x(hoverT), top: HEAD + 1 }} data-flip={x(hoverT) > W - 140 ? "" : undefined} aria-hidden="true">
          {fmt(hoverT)} s · {fmt(vAtT(tl, hoverT), 1)} m/s
        </div>
      )}

      {/* waypoints and stops */}
      <div className="strip-gutter-label" style={{ top: wpTop, height: WPROW }}>Points</div>
      {path.waypoints.map((w, k) => {
        const t = tAtF(tl, (tl.wpFrac || [])[k] ?? 0);
        const sel = selection?.kind === "waypoint" && selection.index === k;
        const hold = w.stop && w.wait > 0 ? w.wait : 0;
        return (
          <div key={"wp" + k}>
            {hold > 0 && (
              <div className="strip-hold" style={{ left: x(t), width: Math.max(2, x(t + hold) - x(t)), top: wpTop + 8 }} aria-hidden="true">
                {x(t + hold) - x(t) > 34 && <span className="num">{fmt(hold, 1)} s</span>}
              </div>
            )}
            <button type="button" className={"strip-wp" + (w.stop ? " stop" : "") + (sel ? " selected" : "") + (hover?.wp === k ? " hovered" : "") + (k === 0 ? " start" : k === path.waypoints.length - 1 ? " end" : "")}
              style={{ left: x(t), top: wpTop + WPROW / 2 }}
              aria-label={`Point ${k + 1}${w.stop ? ", stop" : ""} at ${fmt(t)} s`}
              aria-pressed={sel}
              onPointerDown={(e) => e.stopPropagation()}
              onPointerEnter={() => setHover({ t, src: "strip", wp: k })}
              onClick={(e) => { setSelection(sel ? null : { kind: "waypoint", index: k }); if (e.detail > 0) e.currentTarget.blur(); }}>
              <span className="num">{k + 1}</span>
            </button>
          </div>
        );
      })}

      {/* command lane */}
      <div className="strip-gutter-label" style={{ top: laneTop, height: LANE - 6 }}>Commands</div>
      <div
        ref={laneRef}
        className="strip-lane"
        style={{ left: GUTTER, width: plotW, top: laneTop, height: LANE - 6 }}
        role="group"
        tabIndex={0}
        aria-label="Commands. Enter adds one at the playhead"
        onPointerMove={(e) => { if (e.target === e.currentTarget) setLaneGhost(tAtX(localX(e))); else setLaneGhost(null); }}
        onPointerLeave={() => setLaneGhost(null)}
        onPointerDown={(e) => { if (e.target === e.currentTarget) e.stopPropagation(); }}
        onClick={(e) => { if (e.target === e.currentTarget) { setSelection(null); setPlacing({ t: tAtX(localX(e)) }); } }}
        onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) { e.preventDefault(); setSelection(null); setPlacing({ t: clamp(playback.t, 0, T) }); } }}
      >
        {laneGhost != null && !placing && <span className="strip-lane-ghost" style={{ left: x(laneGhost) - GUTTER }} aria-hidden="true">+</span>}
      </div>
      {chips.map(({ m, t, cx, left, w, row, flip, label }) => {
        const sel = selection?.kind === "command" && selection.id === m.id;
        return (
          <button
            key={m.id}
            type="button"
            className={"strip-chip" + (sel ? " selected" : "") + (flip ? " flip" : "") + (hover?.command === m.id ? " hovered" : "")}
            style={{ left, width: w, top: laneTop + 2 + row * (ROW_H + 2), height: ROW_H }}
            aria-label={`${label} at ${fmt(t)} s`}
            aria-pressed={sel}
            title={label}
            onPointerEnter={() => setHover({ t, src: "strip", command: m.id })}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                e.preventDefault();
                const nt = clamp(t + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 0.5 : 0.05), 0, T);
                edit((p) => { const mk = p.markers.find((q) => q.id === m.id); if (mk) mk.f = Math.round(fAtT(tl, nt) * 1000) / 1000; return p; });
              }
              if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelection({ kind: "command", id: m.id }); }
            }}
            {...chipDrag(m)}
          >
            <span className="strip-diamond" aria-hidden="true" />
            <span className="strip-chip-name">{label}</span>
          </button>
        );
      })}

      {/* ---------- popovers ---------- */}
      {placing && (
        <Popover innerRef={placingRef} x={x(placing.t)} y={laneTop - 4} side="above" bounds={{ left: 8, right: W - 8 }} label="Add command">
          <div className="strip-pop-title num">At {fmt(placing.t)} s</div>
          <Catalog onPick={(commandId) => { const id = onAddCommand(fAtT(tl, placing.t), commandId); setPlacing(null); laneRef.current?.focus(); if (id) setSelection({ kind: "command", id }); }} />
        </Popover>
      )}
      {selectedCommand && !placing && (
        <CommandPopover key={selectedCommand.m.id} chip={selectedCommand} x={selectedCommand.cx} y={laneTop + selectedCommand.row * (ROW_H + 2) - 4} W={W}
          tl={tl} T={T} edit={edit} onSetCommand={onSetCommand} onDelete={() => onDeleteCommand(selectedCommand.m.id)} onClose={() => setSelection(null)} />
      )}
      {selectedZone && (
        <Popover x={(x(tAtF(tl, selectedZone.f0)) + x(tAtF(tl, selectedZone.f1))) / 2} y={graphTop - 2} side="above" bounds={{ left: 8, right: W - 8 }} label="Zone">
          <div className="strip-pop-row">
            <label className="strip-text-field">
              <span className="strip-num-label static">Name</span>
              <input className="strip-text-input" value={selectedZone.name || ""} onChange={(e) => { const v = e.target.value; edit((p) => { p.ranges[selectedZone.index].name = v; return p; }); }} />
            </label>
            <NumberField label="Speed" unit="m/s" value={selectedZone.maxVel ?? maxVel} step={0.05} min={0} max={robot.maxSpeed}
              onChange={(v, phase) => edit((p) => { p.ranges[selectedZone.index].maxVel = v; return p; }, phase)} />
            <button type="button" className="strip-icon-btn danger" aria-label="Delete zone" onClick={() => onDeleteZone(selectedZone.index)}><Icon.trash /></button>
          </div>
        </Popover>
      )}
    </section>
  );
}

function CommandPopover({ chip, x, y, W, tl, T, edit, onSetCommand, onDelete }) {
  const [picking, setPicking] = useState(false);
  const selectRef = useRef(null);
  const { m, t } = chip;
  const command = m.invocation?.commandId || m.name;
  const params = COMMANDS.find((c) => c.id === command)?.parameters || [];
  return (
    <Popover x={x} y={y} side="above" bounds={{ left: 8, right: W - 8 }} label="Command" className={picking ? "wide" : ""}>
      {picking ? (
        <div onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setPicking(false); requestAnimationFrame(() => selectRef.current?.focus()); } }}>
          <Catalog current={command} onPick={(idValue) => { onSetCommand(m.id, idValue); setPicking(false); requestAnimationFrame(() => selectRef.current?.focus()); }} />
        </div>
      ) : (
        <div className="strip-pop-row">
          <button ref={selectRef} type="button" className="strip-select" onClick={() => setPicking(true)} aria-haspopup="listbox">
            <span className="strip-diamond" aria-hidden="true" />
            <span className="strip-select-name">{chip.label}</span>
            <Icon.chevron />
          </button>
          <NumberField label="At" unit="s" value={Number(t.toFixed(2))} step={0.05} min={0} max={T} digits={2}
            onChange={(v, phase) => edit((p) => { const mk = p.markers.find((q) => q.id === m.id); if (mk) mk.f = Math.round(fAtT(tl, v) * 1000) / 1000; return p; }, phase)} />
          {params.map((param) => (
            <NumberField key={param.name} label={param.label} value={Number(m.invocation?.arguments?.[param.name] ?? param.default)} step={param.name === "rpm" ? 50 : 1} min={0} digits={0} width={4}
              onChange={(v, phase) => edit((p) => { const mk = p.markers.find((q) => q.id === m.id); if (mk) { mk.invocation = { ...mk.invocation, arguments: { ...(mk.invocation?.arguments || {}), [param.name]: v } }; } return p; }, phase)} />
          ))}
          <button type="button" className="strip-icon-btn danger" aria-label="Delete command" onClick={onDelete}><Icon.trash /></button>
        </div>
      )}
    </Popover>
  );
}
