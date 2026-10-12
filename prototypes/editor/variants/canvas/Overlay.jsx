// Everything anchored to field objects: the selection HUD, problem labels, zone tags and command names.
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { setWaypointStop } from "../../core/editing.js";
import { COMMANDS } from "../../core/project.js";
import { removeWaypoint } from "../../../../src/renderer/lib/pathEditing";
import { Icon, NumField, peakSpeed, shield } from "./ui.jsx";

const D2R = Math.PI / 180;
export const commandInfo = (m) => COMMANDS.find((c) => c.id === (m?.invocation?.commandId || m?.cmd || m?.name));
export const commandLabel = (m) => commandInfo(m)?.label || m?.name || "Command";

// ---------- placement: pick the side of the anchor that stays on screen and covers the least path ----------
const SIDES = ["right", "left", "below", "above"];
function placeCard(anchor, w, h, view, obstacles, prev, tags = []) {
  const gap = 22, top = 64, bottom = view.h - 76, left = 12, right = view.w - 12;
  const raw = {
    right: { x: anchor.x + gap, y: anchor.y - Math.min(36, h / 2) },
    left: { x: anchor.x - gap - w, y: anchor.y - Math.min(36, h / 2) },
    below: { x: anchor.x - 28, y: anchor.y + gap },
    above: { x: anchor.x - 28, y: anchor.y - gap - h },
  };
  let best = null;
  SIDES.forEach((side, order) => {
    const r = raw[side];
    const x = Math.min(right - w, Math.max(left, r.x)), y = Math.min(bottom - h, Math.max(top, r.y));
    let score = order * 0.5 + (Math.abs(x - r.x) + Math.abs(y - r.y)) * 0.25;
    if (anchor.x > x - 8 && anchor.x < x + w + 8 && anchor.y > y - 8 && anchor.y < y + h + 8) score += 1000;
    for (const p of obstacles) if (p.x > x - 6 && p.x < x + w + 6 && p.y > y - 6 && p.y < y + h + 6) score += p.weight || 1;
    for (const t of tags) if (t.x + t.w / 2 > x && t.x - t.w / 2 < x + w && t.y + t.h / 2 > y && t.y - t.h / 2 < y + h) score += 40;
    if (side === prev) score -= 3; // hysteresis: don't flip-flop while things move
    if (!best || score < best.score) best = { side, x, y, score };
  });
  return best;
}

/** Spot for a small tag beside a path point: either side of the path, clear of other things. */
function tagSpot(p, w, h, obstacles, taken = []) {
  const nx = Math.sin(p.heading || 0), ny = Math.cos(p.heading || 0);
  let best = null;
  [30, -30, 46, -46, 64, -64].forEach((d, order) => {
    const c = { x: p.x + nx * d, y: p.y + ny * d };
    let score = order * 0.3;
    for (const o of obstacles) if (Math.abs(o.x - c.x) < w / 2 + 8 && Math.abs(o.y - c.y) < h / 2 + 8) score += o.weight || 1;
    for (const t of taken) if (Math.abs(t.x - c.x) < (w + t.w) / 2 + 6 && Math.abs(t.y - c.y) < (h + t.h) / 2 + 4) score += 50;
    if (!best || score < best.score) best = { ...c, score };
  });
  return best;
}

function useSize(ref) {
  const [size, setSize] = useState({ w: 236, h: 120 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
  });
  return size;
}

// ---------- the HUD card ----------
function Hud({ anchor, api, obstacles, hidden, children, label, sideRef, cardKey, tags = [] }) {
  const ref = useRef(null);
  const size = useSize(ref);
  const place = placeCard(anchor, size.w, size.h, { w: api.size.w, h: api.size.h }, obstacles, sideRef.current, tags);
  sideRef.current = place.side;
  const origin = { right: "left center", left: "right center", below: "top left", above: "bottom left" }[place.side];
  return (
    <>
      <svg className="cv-leader" style={{ pointerEvents: "none" }} width={api.size.w} height={api.size.h} aria-hidden="true" data-hidden={hidden || undefined}>
        <line x1={anchor.x} y1={anchor.y} x2={Math.min(place.x + size.w, Math.max(place.x, anchor.x))} y2={Math.min(place.y + size.h, Math.max(place.y, anchor.y))} />
      </svg>
      <div key={cardKey} ref={ref} className="cv-hud" role="group" aria-label={label} data-hidden={hidden || undefined}
        style={{ left: place.x, top: place.y, transformOrigin: origin }} {...shield}>
        {children}
      </div>
    </>
  );
}

function Switch({ on, onChange, label }) {
  return (
    <button role="switch" aria-checked={on} className="cv-switch" onClick={() => onChange(!on)}>
      <span className="cv-switch-track" aria-hidden="true"><span className="cv-switch-knob" /></span>
      {label}
    </button>
  );
}

function Seg({ value, options, onChange, label }) {
  return (
    <div className="cv-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={value === o.value} data-on={value === o.value || undefined} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

/** Catalog picker with typeahead. Enter picks, arrows move, Escape cancels. */
export function CommandPicker({ current, onPick, onCancel }) {
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return COMMANDS;
    const rank = (c) => {
      const label = c.label.toLowerCase();
      if (label.startsWith(s)) return 0;
      if (label.split(/[\s:]+/).some((w) => w.startsWith(s))) return 1;
      if (c.id.toLowerCase().startsWith(s)) return 2;
      return label.includes(s) || c.id.toLowerCase().includes(s) ? 3 : 9;
    };
    return COMMANDS.map((c) => [rank(c), c]).filter(([r]) => r < 9).sort((a, b) => a[0] - b[0]).map(([, c]) => c);
  }, [q]);
  const [cursor, setCursor] = useState(() => Math.max(0, COMMANDS.findIndex((c) => c.id === current)));
  const i = Math.min(cursor, list.length - 1);
  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor(Math.min(list.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCursor(Math.max(0, i - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); if (list[i]) onPick(list[i]); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); }
  };
  return (
    <div className="cv-picker">
      <div className="cv-search small">
        <Icon.search />
        <input autoFocus value={q} placeholder="Command" aria-label="Find command" spellCheck={false}
          role="combobox" aria-expanded="true" aria-controls="cv-cmd-list" aria-activedescendant={list[i] ? "cv-cmd-" + list[i].id : undefined}
          onChange={(e) => { setQ(e.target.value); setCursor(0); }} onKeyDown={onKeyDown} />
      </div>
      <ul id="cv-cmd-list" role="listbox" className="cv-list compact" aria-label="Commands">
        {list.map((c, k) => (
          <li key={c.id} id={"cv-cmd-" + c.id} role="option" aria-selected={c.id === current} className="cv-row"
            data-cursor={k === i || undefined} data-active={c.id === current || undefined}
            onPointerEnter={() => setCursor(k)} onClick={() => onPick(c)}>
            <span className="cv-row-name">{c.label}</span>
          </li>
        ))}
        {!list.length && <li className="cv-empty">No match</li>}
      </ul>
    </div>
  );
}

// One obvious fix per kind of problem: cap the speed over the offending stretch.
const SLOW_FIX = new Set([
  "unreachable-acceleration", "unreachable-deceleration", "linear-acceleration", "linear-deceleration",
  "centripetal-acceleration", "angular-velocity", "angular-acceleration", "drivetrain-acceleration", "drivetrain-velocity",
]);
function describe(issue) {
  const whole = issue.f1 - issue.f0 > 0.95;
  const fix = SLOW_FIX.has(issue.code) ? (whole ? "Lower speed" : "Slow here") : null;
  return { text: issue.message, fix };
}

export function Overlay({
  api, path, derived, issues, selection, setSelection, edit, dragging, pendingCommand, setPendingCommand, placeCommand,
  hoverCommand, tool, recentCommandId, toast, fixIssue, pickerOpen, setPickerOpen,
}) {
  const sideRef = useRef(null);
  const pts = derived?.sample?.pts || [];
  const total = pts.length ? pts[pts.length - 1].s || 1 : 1;
  const view = api.size;

  // Obstacles the HUD tries not to cover: the path itself, waypoints, the heading knob.
  const obstacles = useMemo(() => {
    const out = [];
    const step = Math.max(1, Math.floor(pts.length / 120));
    for (let i = 0; i < pts.length; i += step) out.push(api.w2s(pts[i].x, pts[i].y));
    path.waypoints.forEach((w) => out.push({ ...api.w2s(w.x, w.y), weight: 6 }));
    (path.markers || []).forEach((m) => out.push({ ...api.pointAt(m.f), weight: 4 }));
    return out;
  }, [pts, path, api]);

  const elements = [];
  const taken = [];

  // ---- zone tags (and end handles when selected) ----
  (path.ranges || []).forEach((r, i) => {
    if (r.anchor !== "param" || !pts.length) return;
    const mid = api.pointAt((r.f0 + r.f1) / 2);
    const tw = 34 + (r.name || "Zone").length * 7 + 44;
    const pos = tagSpot(mid, tw, 24, obstacles, taken);
    taken.push({ ...pos, w: tw, h: 24 });
    const sel = selection?.kind === "zone" && selection.index === i;
    elements.push(
      <button key={"zt" + i} className="cv-zonetag" data-selected={sel || undefined} style={{ left: pos.x, top: pos.y }} {...shield}
        onClick={() => setSelection({ kind: "zone", index: i })} aria-label={`Zone ${r.name || ""}, speed cap ${r.maxVel ?? "none"} m/s`}>
        {r.name || "Zone"} <span className="num">{r.maxVel != null ? r.maxVel.toFixed(1) : "–"}</span><span className="cv-unit">m/s</span>
      </button>,
    );
    if (sel) ["f0", "f1"].forEach((end) => {
      const p = api.pointAt(r[end]);
      elements.push(<ZoneEnd key={"ze" + i + end} at={p} api={api} pts={pts} total={total}
        onDrag={(f, phase) => edit(phase === "end" ? null : (d) => {
          const z = d.ranges[i];
          if (end === "f0") z.f0 = Math.min(f, z.f1 - 0.01); else z.f1 = Math.max(f, z.f0 + 0.01);
          return d;
        }, phase)} />);
    });
  });

  // ---- command names: hovered, freshly passed during playback, or all while placing ----
  (path.markers || []).forEach((m) => {
    const isSel = selection?.kind === "command" && selection.id === m.id;
    const show = !isSel && (tool === "command" || hoverCommand === m.id || recentCommandId === m.id);
    if (!show) return;
    const p = api.pointAt(m.f);
    elements.push(<span key={"cl" + m.id} className="cv-cmdlabel" style={{ left: p.x, top: p.y - 16, pointerEvents: "none" }}>{commandLabel(m)}</span>);
  });

  // ---- problems, pinned to their stretch ----
  issues.slice(0, 3).forEach((issue, k) => {
    if (!pts.length) return;
    const f = (issue.f0 + issue.f1) / 2;
    const p = api.pointAt(f);
    const d = describe(issue);
    const iw = 40 + d.text.length * 6.6 + (d.fix ? d.fix.length * 7 + 20 : 0);
    const pos = tagSpot(p, iw, 30, obstacles, taken);
    taken.push({ ...pos, w: iw, h: 30 });
    elements.push(
      <svg key={"il" + k} className={"cv-leader issue " + issue.severity} style={{ pointerEvents: "none" }} width={view.w} height={view.h} aria-hidden="true">
        <line x1={p.x} y1={p.y} x2={pos.x} y2={pos.y} />
      </svg>,
      <div key={"is" + k} className={"cv-issue " + issue.severity} role="status" style={{ left: pos.x, top: pos.y }} {...shield}>
        <span className="cv-issue-mark" aria-hidden="true" />
        <span>{d.text}</span>
        {d.fix && <button className="cv-issue-fix" onClick={() => fixIssue(issue)}>{d.fix}</button>}
      </div>,
    );
  });

  // ---- pending command placement: ghost diamond + catalog ----
  if (pendingCommand) {
    const p = api.pointAt(pendingCommand.f);
    elements.push(<span key="pc" className="cv-ghostcmd" style={{ left: p.x, top: p.y, pointerEvents: "none" }} aria-hidden="true" />);
    elements.push(
      <Hud tags={taken} key="hud-pending" cardKey="pending" anchor={p} api={api} obstacles={obstacles} sideRef={sideRef} label="Place command">
        <CommandPicker onPick={placeCommand} onCancel={() => setPendingCommand(null)} />
      </Hud>,
    );
    return elements;
  }

  // ---- selection HUD ----
  if (selection?.kind === "waypoint") {
    const i = selection.index, w = path.waypoints[i];
    if (w) {
      const anchor = api.w2s(w.x, w.y);
      const last = path.waypoints.length - 1;
      const name = i === 0 ? "Start" : i === last ? "End" : "Point " + (i + 1);
      const setWp = (fn) => edit((d) => { fn(d.waypoints[i]); return d; });
      const knob = w.thetaOn ? { x: anchor.x + Math.cos(w.theta * D2R) * 40, y: anchor.y - Math.sin(w.theta * D2R) * 40, weight: 20 } : null;
      elements.push(
        <Hud tags={taken} key="hud-wp" cardKey={"wp" + i} anchor={anchor} api={api} obstacles={knob ? [...obstacles, knob] : obstacles} hidden={dragging} sideRef={sideRef} label={name}>
          <div className="cv-hud-head">
            <span className="cv-hud-title">{name}</span>
            {path.waypoints.length > 2 && <button className="cv-icon-btn" aria-label={"Delete " + name.toLowerCase()} onClick={() => {
              edit((d) => removeWaypoint(d, i));
              setSelection(null); toast(name + " deleted");
            }}><Icon.trash /></button>}
          </div>
          <div className="cv-hud-row">
            <Switch on={Boolean(w.stop)} label="Stop here" onChange={(on) => edit((draft) => setWaypointStop(draft, i, on))} />
          </div>
          {w.stop && <div className="cv-hud-row end">
            <NumField compact label="Wait" unit="s" value={w.wait || 0} step={0.1} min={0}
              apply={(v, phase) => edit(phase === "end" ? null : (d) => { d.waypoints[i].wait = v; return d; }, phase)} />
          </div>}
          <div className="cv-hud-row">
            <span className="cv-hud-label">Heading</span>
            <Seg label="Heading" value={w.thetaOn ? "pin" : "auto"} onChange={(v) => setWp((x) => { x.thetaOn = v === "pin"; })}
              options={[{ value: "auto", label: "Auto" }, { value: "pin", label: "Pinned" }]} />
          </div>
          {w.thetaOn && <div className="cv-hud-row end">
            <NumField compact label="Angle" unit="°" value={w.theta} step={1} decimals={0}
              apply={(v, phase) => edit(phase === "end" ? null : (d) => { d.waypoints[i].theta = v; d.waypoints[i].thetaOn = true; return d; }, phase)} />
          </div>}
        </Hud>,
      );
    }
  } else if (selection?.kind === "command") {
    const m = (path.markers || []).find((x) => x.id === selection.id);
    if (m) {
      const info = commandInfo(m);
      const anchor = api.pointAt(m.f);
      elements.push(
        <Hud tags={taken} key="hud-cmd" cardKey={"cmd" + m.id + (pickerOpen ? "p" : "")} anchor={anchor} api={api} obstacles={obstacles} hidden={dragging} sideRef={sideRef} label="Command">
          {pickerOpen ? (
            <CommandPicker current={info?.id} onCancel={() => setPickerOpen(false)} onPick={(c) => {
              edit((d) => {
                const x = d.markers.find((k) => k.id === m.id);
                const args = Object.fromEntries((c.parameters || []).map((p) => [p.name, p.default]));
                Object.assign(x, { name: c.id, cmd: c.id, invocation: { commandId: c.id, arguments: args } });
                return d;
              });
              setPickerOpen(false);
            }} />
          ) : <>
            <div className="cv-hud-head">
              <span className="cv-hud-title">Command</span>
              <button className="cv-icon-btn" aria-label="Delete command" onClick={() => {
                edit((d) => { d.markers = d.markers.filter((k) => k.id !== m.id); return d; });
                setSelection(null); toast("Command deleted");
              }}><Icon.trash /></button>
            </div>
            <button className="cv-cmd-current" aria-haspopup="listbox" onClick={() => setPickerOpen(true)}>
              <span className="cv-cmd-diamond" aria-hidden="true" />
              <span>{commandLabel(m)}</span>
              <Icon.chevron />
            </button>
            {(info?.parameters || []).map((p) => (
              <div className="cv-hud-row end" key={p.name}>
                <NumField compact label={p.label} value={m.invocation?.arguments?.[p.name] ?? p.default} step={p.default >= 100 ? 50 : 1} decimals={0}
                  apply={(v, phase) => edit(phase === "end" ? null : (d) => {
                    const x = d.markers.find((k) => k.id === m.id);
                    x.invocation = { ...x.invocation, arguments: { ...(x.invocation?.arguments || {}), [p.name]: v } };
                    return d;
                  }, phase)} />
              </div>
            ))}
          </>}
        </Hud>,
      );
    }
  } else if (selection?.kind === "zone") {
    const r = (path.ranges || [])[selection.index];
    if (r && pts.length) {
      const anchor = api.pointAt((r.f0 + r.f1) / 2);
      const peak = peakSpeed(derived, r.f0, r.f1);
      elements.push(
        <Hud tags={taken} key="hud-zone" cardKey={"zone" + selection.index} anchor={anchor} api={api} obstacles={obstacles} hidden={dragging} sideRef={sideRef} label={"Zone " + (r.name || "")}>
          <div className="cv-hud-head">
            <span className="cv-hud-title">{r.name || "Zone"}</span>
            <button className="cv-icon-btn" aria-label="Delete zone" onClick={() => {
              edit((d) => { d.ranges.splice(selection.index, 1); return d; });
              setSelection(null); toast("Zone deleted");
            }}><Icon.trash /></button>
          </div>
          <div className="cv-hud-row end">
            <NumField compact label="Speed cap" unit="m/s" value={r.maxVel ?? peak} step={0.1} min={0}
              apply={(v, phase) => edit(phase === "end" ? null : (d) => { d.ranges[selection.index].maxVel = v; return d; }, phase)} />
          </div>
        </Hud>,
      );
    }
  }
  return elements;
}

/** A draggable zone end. Snaps to the nearest point on the path. */
function ZoneEnd({ at, api, pts, total, onDrag }) {
  const drag = useRef(false);
  const nearest = (e) => {
    const host = e.currentTarget.parentElement.getBoundingClientRect();
    const x = e.clientX - host.left, y = e.clientY - host.top;
    let best = 0, bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const s = api.w2s(pts[i].x, pts[i].y);
      const d = (s.x - x) ** 2 + (s.y - y) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return Math.round((pts[best].s / total) * 1000) / 1000;
  };
  return (
    <span className="cv-zoneend" style={{ left: at.x, top: at.y }} aria-hidden="true"
      onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); drag.current = true; onDrag(nearest(e), "begin"); }}
      onPointerMove={(e) => { e.stopPropagation(); if (drag.current) onDrag(nearest(e), "update"); }}
      onPointerUp={(e) => { e.stopPropagation(); if (drag.current) { drag.current = false; onDrag(null, "end"); } }}
      onDoubleClick={(e) => e.stopPropagation()} />
  );
}
