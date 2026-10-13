// The active path along time: speed curve with the path limit and zones, problems, points and stops, and the
// command lane. Dragging edits; selecting shows the object's numbers in the docked panel (no floating editors).
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { speedColor } from "../../core/Field.jsx";
import { fAtT, fmt, niceStep, tAtF, vAtT } from "../strip/timeline.js";
import { CommandMenu } from "./CommandMenu.jsx";
import { Icon } from "./Icon.jsx";
import { NumberInput } from "./NumberInput.jsx";
import { markerLabel } from "./labels.js";
import { isWholeIssue, plainProblem } from "./problems.js";

const GUTTER = 76, RIGHT = 16, HEAD = 44, RULER = 22, WPROW = 26, LANE = 54, PAD = 6, ROW_H = 22;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Pointer drag bound to one element: start(e) returns state or null; move/end get (event, state, first). */
function drag({ start, move, end, threshold = 0 }) {
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

export function Timeline({
  path, tl, issues, issuesStale, clockStale, robot, selection, select, edit, playback, hover, setHover,
  laneMenu, openLane, closeMenu, addCommand, history,
}) {
  const root = useRef(null);
  const laneRef = useRef(null);
  const [size, setSize] = useState({ w: 900, h: 300 });
  useLayoutEffect(() => {
    const el = root.current;
    const r = el.getBoundingClientRect();
    if (r.width) setSize({ w: r.width, h: r.height });
    const ro = new ResizeObserver(([entry]) => setSize({ w: entry.contentRect.width, h: entry.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // While a limit drag runs, hold the time axis so the curve visibly stretches or shrinks.
  const [frozenT, setFrozenT] = useState(null);
  const T = Math.max(0.01, frozenT ? Math.max(frozenT, tl.total) : tl.total);
  const { w: W, h: H } = size;
  const plotW = Math.max(50, W - GUTTER - RIGHT);
  const graphTop = HEAD + RULER + 4;
  const laneTop = H - LANE - PAD + 4;
  const wpTop = laneTop - WPROW;
  const graphBottom = wpTop - 2;
  const graphH = Math.max(30, graphBottom - graphTop);
  const vTop = Math.max(1, Math.ceil(robot.maxSpeed));
  const x = (t) => GUTTER + (t / T) * plotW;
  const tAtX = (px) => clamp(((px - GUTTER) / plotW) * T, 0, T);
  const y = (v) => graphBottom - (clamp(v, 0, vTop) / vTop) * graphH;
  const vAtY = (py) => ((graphBottom - py) / graphH) * vTop;
  const localX = (e) => e.clientX - root.current.getBoundingClientRect().left;
  const localY = (e) => e.clientY - root.current.getBoundingClientRect().top;

  const c = path.constraints;
  const zones = (path.ranges || []).map((r, index) => ({ ...r, index })).filter((r) => r.anchor === "param");
  const markers = path.markers || [];
  const selWp = selection?.kind === "waypoint" ? selection.index : null;

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
  const tDigits = Math.max(0, Math.min(3, -Math.floor(Math.log10(tStep) + 1e-9)));
  const vTicks = Array.from({ length: vTop + 1 }, (_, i) => i).filter((v) => graphH > 90 || v % 2 === 0 || v === vTop);

  // Command chips in two rows, in time order, each starting at its time. A chip that would run into the next one
  // in its row (or past the end) is shortened, down to its diamond; the full name stays in its title and field tag.
  const chips = useMemo(() => {
    const sorted = markers.map((m) => ({ m, t: tAtF(tl, m.f) })).sort((a, b) => a.t - b.t);
    const last = [null, null];
    const out = sorted.map(({ m, t }) => {
      const label = markerLabel(m);
      const cx = x(t), left = cx - 9;
      const chip = { m, t, cx, left, w: Math.min(150, Math.ceil(textWidth(label)) + 27), label };
      const end = (c) => (c ? c.left + c.w : -Infinity);
      chip.row = end(last[0]) <= left - 3 ? 0 : end(last[1]) <= left - 3 ? 1 : end(last[0]) <= end(last[1]) ? 0 : 1;
      const prev = last[chip.row];
      if (prev && end(prev) > left - 3) prev.w = Math.max(22, left - 3 - prev.left);
      last[chip.row] = chip;
      return chip;
    });
    out.forEach((c) => { c.w = Math.max(22, Math.min(c.w, W - 4 - c.left)); });
    return out;
  }, [markers, tl, T, W]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- interactions ----------
  const seekAt = (e) => playback.seek(tAtX(localX(e)));
  const scrub = drag({ start: (e) => { seekAt(e); return {}; }, move: (e) => seekAt(e) });
  const setLimit = (v, phase) => edit((p) => { p.constraints.maxVel = v; return p; }, phase);
  const limitDrag = drag({
    start: () => { setFrozenT(tl.total); edit((p) => p, "begin"); return {}; },
    move: (e) => setLimit(Math.round(clamp(vAtY(localY(e)), 0.05, robot.maxSpeed) * 20) / 20, "update"),
    end: () => { edit(null, "end"); setFrozenT(null); },
  });
  const zoneCapDrag = (index) => drag({
    start: () => { select({ kind: "zone", index }); setFrozenT(tl.total); edit((p) => p, "begin"); return {}; },
    move: (e) => edit((p) => { p.ranges[index].maxVel = Math.round(clamp(vAtY(localY(e)), 0.05, robot.maxSpeed) * 20) / 20; return p; }, "update"),
    end: () => { edit(null, "end"); setFrozenT(null); },
  });
  const zoneEdgeDrag = (index, side) => drag({
    start: () => { select({ kind: "zone", index }); setFrozenT(tl.total); edit((p) => p, "begin"); return { tl0: tl }; },
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
  const chipDrag = (m) => drag({
    threshold: 3,
    start: () => ({}),
    move: (e, s, first) => {
      if (first) edit((p) => p, "begin");
      const t = tAtX(localX(e));
      edit((p) => { const mk = p.markers.find((q) => q.id === m.id); if (mk) mk.f = Math.round(fAtT(tl, t) * 1000) / 1000; return p; }, "update");
      setHover({ t, src: "timeline", command: m.id });
    },
    end: (e, s) => {
      if (s.moved) edit(null, "end");
      select({ kind: "command", id: m.id });
      // A pointer press shouldn't leave focus on the chip, or Space would press it instead of playing.
      if (e.pointerType) e.currentTarget?.blur?.();
    },
  });
  const nudge = (e, value, stepSize, apply) => {
    const dir = e.key === "ArrowUp" || e.key === "ArrowRight" ? 1 : e.key === "ArrowDown" || e.key === "ArrowLeft" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    apply(Math.round((value + dir * stepSize * (e.shiftKey ? 10 : 1)) * 1000) / 1000);
  };

  const onBodyMove = (e) => {
    const px = localX(e), py = localY(e);
    if (px < GUTTER - 4 || px > W - RIGHT + 4 || py < HEAD) { if (hover?.src === "timeline") setHover(null); return; }
    // Chips and point buttons own their hover (set on enter); don't overwrite it from this bubbled move.
    if (e.target.closest?.(".hy-chip, .hy-wp")) return;
    setHover({ t: tAtX(px), src: "timeline" });
  };

  const hoverT = hover ? clamp(hover.t, 0, T) : null;
  const playX = x(clamp(playback.t, 0, T));
  const selZone = selection?.kind === "zone" ? selection.index : null;
  const selIssue = selection?.kind === "issue" ? selection.index : null;
  const wpT = (k) => tAtF(tl, (tl.wpFrac || [])[k] ?? 0);

  return (
    <section ref={root} className="hy-tl" aria-label="Timeline" data-stale={clockStale ? "" : undefined}
      onPointerMove={onBodyMove} onPointerLeave={() => { if (hover?.src === "timeline") setHover(null); }}>
      {/* ---------- header: playback and the path's speed limits ---------- */}
      <div className="hy-tl-head" style={{ height: HEAD }}>
        <div className="hy-tl-play">
          <button type="button" className="hy-play" aria-label={playback.playing ? "Pause" : "Play"} title="Space" onClick={playback.toggle}>
            <Icon name={playback.playing ? "pause" : "play"} />
          </button>
          <span className="hy-clock num">
            <span className="hy-clock-now">{fmt(Math.min(playback.t, tl.total))}</span>
            <span className="hy-clock-sep">/</span>
            <span className="hy-clock-total">{tl.empty ? "–" : fmt(tl.total)} s</span>
          </span>
          <span className="hy-tl-history">{history}</span>
        </div>
        <div className="hy-tl-limits">
          <NumberInput layout="inline" label="Speed" unit="m/s" value={c.maxVel} step={0.05} digits={2} min={0.05} max={robot.maxSpeed}
            onChange={(v, phase) => edit((p) => { if (v != null) p.constraints.maxVel = v; return p; }, phase)} />
          <NumberInput layout="inline" label="Acceleration" unit="m/s²" value={c.maxAccel} step={0.1} digits={1} min={0.1} max={60}
            onChange={(v, phase) => edit((p) => { if (v != null) p.constraints.maxAccel = v; return p; }, phase)} />
        </div>
      </div>

      {/* ---------- drawing ---------- */}
      <svg className="hy-tl-svg" width={W} height={H} aria-hidden="true">
        {vTicks.map((v) => (
          <g key={"v" + v}>
            <line x1={GUTTER} x2={W - RIGHT} y1={y(v)} y2={y(v)} className={v === 0 ? "hy-axis" : "hy-grid"} />
            <text x={GUTTER - 8} y={y(v) + 3.5} className="hy-tick" textAnchor="end">{v}</text>
          </g>
        ))}
        {tTicks.map((t) => (
          <g key={"t" + t}>
            <line x1={x(t)} x2={x(t)} y1={HEAD + RULER - 5} y2={HEAD + RULER} className="hy-axis" />
            <line x1={x(t)} x2={x(t)} y1={graphTop} y2={graphBottom} className="hy-grid faint" />
            <text x={x(t)} y={HEAD + 12} className="hy-tick" textAnchor={t === 0 ? "start" : x(t) > W - RIGHT - 14 ? "end" : "middle"}>{t === 0 ? "0" : t.toFixed(tDigits)}</text>
          </g>
        ))}
        <line x1={GUTTER} x2={W - RIGHT} y1={HEAD + RULER} y2={HEAD + RULER} className="hy-axis" />

        {zones.map((z) => {
          const x0 = x(tAtF(tl, z.f0)), x1 = x(tAtF(tl, z.f1));
          return (
            <g key={"z" + z.index} className={"hy-zone" + (selZone === z.index ? " selected" : "")}>
              <rect x={x0} y={graphTop} width={Math.max(1, x1 - x0)} height={graphH} className="hy-zone-fill" />
              {z.maxVel != null && <line x1={x0} x2={x1} y1={y(z.maxVel)} y2={y(z.maxVel)} className="hy-zone-cap" />}
            </g>
          );
        })}
        <path d={curve.area} className="hy-area" />
        <g className="hy-curve-g">{curve.segs.map((s, i) => <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={s.c} className="hy-curve" />)}</g>
        <line x1={GUTTER} x2={W - RIGHT} y1={y(c.maxVel)} y2={y(c.maxVel)} className="hy-limit" />
        {issues.map((iss, i) => {
          const whole = isWholeIssue(iss);
          const x0 = whole ? GUTTER : x(tAtF(tl, iss.f0)), x1 = whole ? W - RIGHT : x(tAtF(tl, iss.f1));
          return (
            <g key={"i" + i} className={"hy-issue " + iss.severity + (issuesStale ? " stale" : "") + (selIssue === i ? " selected" : "")}>
              <rect x={x0} y={graphTop} width={Math.max(3, x1 - x0)} height={graphH} className="hy-issue-fill" />
              <rect x={x0} y={graphTop} width={Math.max(3, x1 - x0)} height={2} className="hy-issue-bar" />
            </g>
          );
        })}
        {selWp != null && path.waypoints[selWp] && <line x1={x(wpT(selWp))} x2={x(wpT(selWp))} y1={graphTop} y2={wpTop + WPROW / 2} className="hy-selline" />}
        {hoverT != null && <line x1={x(hoverT)} x2={x(hoverT)} y1={HEAD + RULER} y2={laneTop + LANE - 8} className="hy-hoverline" />}
        <line x1={playX} x2={playX} y1={HEAD + RULER} y2={laneTop + LANE - 8} className="hy-playline" />
      </svg>

      <div className="hy-gutter" style={{ top: graphTop, height: 30 }}>Speed<span>m/s</span></div>
      <div className="hy-gutter" style={{ top: HEAD, height: RULER }}>Time<span>s</span></div>

      {/* ruler and graph background: click or drag to scrub */}
      <div className="hy-ruler" style={{ left: GUTTER, width: plotW, top: HEAD, height: RULER }}
        role="slider" tabIndex={0} aria-label="Playhead" aria-valuemin={0} aria-valuemax={Number(tl.total.toFixed(2))} aria-valuenow={Number(playback.t.toFixed(2))}
        aria-valuetext={`${fmt(playback.t)} of ${fmt(tl.total)} seconds`}
        onKeyDown={(e) => {
          if (e.key === "Home") { e.preventDefault(); playback.seek(0); }
          else if (e.key === "End") { e.preventDefault(); playback.seek(tl.total); }
          else nudge(e, playback.t, 0.1, playback.seek);
        }}
        {...scrub} />
      <div className="hy-playhead" style={{ left: playX, top: HEAD + RULER - 9 }} aria-hidden="true" />
      <div className="hy-graph-hit" style={{ left: GUTTER, width: plotW, top: graphTop, height: graphH }} {...scrub} />
      {/* The limit line is grabbable along its length, under zone controls (more specific) and above the scrub area. */}
      <div className="hy-limit-hit" style={{ left: GUTTER, width: plotW, top: y(c.maxVel) - 5 }} {...limitDrag} aria-hidden="true" />

      {zones.map((z) => {
        const x0 = x(tAtF(tl, z.f0)), x1 = x(tAtF(tl, z.f1));
        const on = selZone === z.index;
        const name = z.name || "Zone";
        return (
          <div key={"zh" + z.index}>
            <button type="button" className={"hy-zone-tag" + (on ? " selected" : "")} style={{ left: x0 + 1, top: graphTop + 3, maxWidth: Math.max(28, x1 - x0 - 2) }}
              aria-pressed={on} onPointerDown={(e) => e.stopPropagation()} onClick={() => select(on ? null : { kind: "zone", index: z.index })}>{name}</button>
            {z.maxVel != null && (
              <div className={"hy-zone-cap-hit" + (on ? " selected" : "")} style={{ left: x0, width: Math.max(8, x1 - x0), top: y(z.maxVel) - 6 }}
                role="slider" tabIndex={0} aria-label={`${name} speed`} aria-valuemin={0} aria-valuemax={robot.maxSpeed} aria-valuenow={z.maxVel} aria-valuetext={`${fmt(z.maxVel)} m/s`}
                onKeyDown={(e) => nudge(e, z.maxVel, 0.05, (v) => edit((p) => { p.ranges[z.index].maxVel = clamp(v, 0.05, robot.maxSpeed); return p; }))}
                {...zoneCapDrag(z.index)}>
                <span className="hy-zone-cap-val num">{fmt(z.maxVel)}</span>
              </div>
            )}
            {["f0", "f1"].map((side) => (
              <div key={side} className="hy-zone-edge" style={{ left: (side === "f0" ? x0 : x1) - 5, top: graphTop, height: graphH }}
                role="slider" tabIndex={0} aria-label={`${name} ${side === "f0" ? "start" : "end"}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(z[side] * 100)}
                onKeyDown={(e) => nudge(e, z[side], 0.005, (f) => edit((p) => { const r = p.ranges[z.index]; r[side] = side === "f0" ? clamp(f, 0, r.f1 - 0.01) : clamp(f, r.f0 + 0.01, 1); return p; }))}
                {...zoneEdgeDrag(z.index, side)} />
            ))}
          </div>
        );
      })}

      {/* path speed limit: drag the line or its value */}
      <div className="hy-limit-handle num" style={{ top: y(c.maxVel), left: W - RIGHT - 52 }}
        role="slider" tabIndex={0} aria-label="Speed limit" aria-valuemin={0} aria-valuemax={robot.maxSpeed} aria-valuenow={c.maxVel} aria-valuetext={`${fmt(c.maxVel)} m/s`}
        onKeyDown={(e) => nudge(e, c.maxVel, 0.05, (v) => setLimit(clamp(v, 0.05, robot.maxSpeed)))} {...limitDrag}>
        {fmt(c.maxVel)}
      </div>

      {/* problems: a short consequence; selecting one shows the numbers and the fix in the panel */}
      {issues.slice(0, 3).map((iss, i) => {
        const whole = isWholeIssue(iss);
        const x0 = whole ? GUTTER : x(tAtF(tl, iss.f0));
        const flip = x0 > W - 200;
        const plain = plainProblem(iss, path.waypoints.length);
        return (
          <button key={"il" + i} type="button" className={"hy-issue-label " + iss.severity + (issuesStale ? " stale" : "") + (selIssue === i ? " selected" : "")}
            style={flip ? { right: W - x0 + 4, top: graphTop + 8 + i * 24 } : { left: x0 + 4, top: graphTop + 8 + i * 24, maxWidth: W - RIGHT - x0 - 60 }}
            onPointerDown={(e) => e.stopPropagation()} onClick={() => select({ kind: "issue", index: i })}>
            <span className="hy-issue-icon" aria-hidden="true">!</span>{plain.text}
          </button>
        );
      })}

      {hoverT != null && (
        <div className="hy-readout num" style={{ left: x(hoverT), top: HEAD + 1 }} data-flip={x(hoverT) > W - 140 ? "" : undefined} aria-hidden="true">
          {fmt(hoverT)} s · {fmt(vAtT(tl, hoverT), 1)} m/s
        </div>
      )}

      {/* points and stops */}
      <div className="hy-gutter" style={{ top: wpTop, height: WPROW }}>Points</div>
      {path.waypoints.map((w, k) => {
        const t = wpT(k);
        const sel = selWp === k;
        const hold = w.stop && w.wait > 0 ? w.wait : 0;
        const end = k === 0 ? " start" : k === path.waypoints.length - 1 ? " end" : "";
        return (
          <div key={"wp" + k}>
            {hold > 0 && (
              <div className="hy-hold" style={{ left: x(t), width: Math.max(2, x(t + hold) - x(t)), top: wpTop + WPROW / 2 - 4 }} aria-hidden="true">
                {x(t + hold) - x(t) > 40 && <span className="num">{fmt(hold, 1)} s</span>}
              </div>
            )}
            <button type="button" className={"hy-wp" + (w.stop ? " stop" : "") + (sel ? " selected" : "") + (hover?.wp === k ? " hovered" : "") + end}
              style={{ left: x(t), top: wpTop + WPROW / 2 }} aria-label={`Point ${k + 1}${w.stop ? ", stop" : ""} at ${fmt(t)} s`} aria-pressed={sel}
              onPointerDown={(e) => e.stopPropagation()} onPointerEnter={() => setHover({ t, src: "timeline", wp: k })} onPointerLeave={() => setHover(null)}
              onClick={(e) => { select(sel ? null : { kind: "waypoint", index: k }); if (e.detail > 0) e.currentTarget.blur(); }}>
              <span className="num">{k + 1}</span>
            </button>
          </div>
        );
      })}

      {/* command lane: click an empty spot (or Enter) to add at that time */}
      <div className="hy-gutter" style={{ top: laneTop, height: LANE - 8 }}>Commands</div>
      <div ref={laneRef} className="hy-lane" style={{ left: GUTTER, width: plotW, top: laneTop, height: LANE - 8 }}
        role="button" tabIndex={0} aria-label="Add command at the playhead"
        onPointerMove={(e) => { if (e.target === e.currentTarget) setHover({ t: tAtX(localX(e)), src: "timeline", lane: true }); }}
        onPointerDown={(e) => { if (e.target === e.currentTarget) e.stopPropagation(); }}
        onClick={(e) => { if (e.target === e.currentTarget) openLane(tAtX(localX(e))); }}
        onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); e.stopPropagation(); openLane(clamp(playback.t, 0, T)); } }}>
        {hover?.lane && !laneMenu && <span className="hy-lane-ghost" style={{ left: x(hover.t) - GUTTER }} aria-hidden="true">+</span>}
      </div>
      {chips.map(({ m, t, left, w, row, label }) => {
        const sel = selection?.kind === "command" && selection.id === m.id;
        return (
          <button key={m.id} type="button" className={"hy-chip" + (sel ? " selected" : "") + (hover?.command === m.id ? " hovered" : "")}
            style={{ left, width: w, top: laneTop + 1 + row * (ROW_H + 2), height: ROW_H }} aria-label={`${label} at ${fmt(t)} s`} aria-pressed={sel} title={label}
            onPointerEnter={() => setHover({ t, src: "timeline", command: m.id })} onPointerLeave={() => setHover(null)}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                e.preventDefault(); e.stopPropagation();
                const nt = clamp(t + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 0.5 : 0.05), 0, T);
                edit((p) => { const mk = p.markers.find((q) => q.id === m.id); if (mk) mk.f = Math.round(fAtT(tl, nt) * 1000) / 1000; return p; });
              } else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); select({ kind: "command", id: m.id }); }
            }}
            {...chipDrag(m)}>
            <span className="hy-diamond" aria-hidden="true" />
            <span className="hy-chip-name">{label}</span>
          </button>
        );
      })}
      {laneMenu && (
        <CommandMenu x={clamp(x(laneMenu.t) - 110, 8, W - 236)} y={laneTop - 6} side="above" title={`At ${fmt(laneMenu.t)} s`}
          onClose={closeMenu} onPick={(id) => addCommand(fAtT(tl, laneMenu.t), id)} />
      )}
    </section>
  );
}
