import * as React from 'react';
import { shiftDeletionInput } from './DeletionNotice';
import { PointerDrag } from '../hooks/usePointerDrag';
import { PathLinks } from '../lib/pathLinks';
import { PM } from '../lib/pathMath';
import { UnitPrefs } from '../lib/unitPreferences';
import { fAtT, featureFraction, featurePositionPatch, groupCommandChips, niceStep, tAtF, vAtT, waypointInsertionAt, zoneFractions } from './pathTimelineModel';
import { isWholeIssue } from './planProblems';
import { UI } from './ui';

// The active path along time: speed with the path limit and zones, problems, waypoints and stops, and the
// command lane. Dragging edits through the shared edit store, so one gesture is one undo step and the
// field shows the same draft; selecting shows the object's numbers in the docked panel.

const h = React.createElement;
const { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } = React;
const GUTTER = 78, RIGHT = 14, HEAD_ROW = 42, RULER = 20, WPROW = 28, LANE = 52, CHIP_H = 21;
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const fmt = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : '–';
const speed = (value) => UnitPrefs.fromCanonical(value, 'm/s');
// The graph follows the field's color metric. Speed carries the draggable limits; the others are read-only.
const SERIES = {
  accel: { key: 'a', unit: 'm/s²', label: 'Accel', signed: true },
  angvel: { key: 'w', unit: '°/s', label: 'Turn', signed: true },
  curvature: { key: 'k', unit: '1/m', label: 'Curve', signed: false },
};

let measureContext = null;
function textWidth(text) {
  if (!measureContext && typeof document !== 'undefined') measureContext = document.createElement('canvas').getContext('2d');
  if (!measureContext) return text.length * 6.5;
  measureContext.font = '11.5px "Space Grotesk", system-ui, sans-serif';
  return measureContext.measureText(text).width;
}

/** The name a person gave the command; a default "eventN" name gives way to the linked command's label. */
export function commandLabel(marker, catalog) {
  const name = String(marker?.name || '').trim();
  if (name && !/^event\d+$/.test(name)) return name;
  const id = marker?.invocation?.commandId || (marker?.cmd && marker.cmd !== 'none' ? marker.cmd : '');
  const command = id && catalog?.commands?.find((candidate) => candidate.id === id);
  return command?.label || 'Command';
}

function usePlayback(store) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

// Playback-driven parts render alone, so the rest of the band does not re-render every frame.
function Clock({ store, total, stale }) {
  const playback = usePlayback(store);
  return h(React.Fragment, null,
    h('button', { type: 'button', className: 'pt-play', 'aria-label': playback.playing ? 'Pause trajectory playback' : 'Play trajectory', title: 'Play / Pause  (Space)', onClick: store.toggle },
      h(UI.Icon, { name: playback.playing ? 'pause' : 'play', size: 14, fill: !playback.playing })),
    h('span', { className: 'pt-clock', 'data-stale': stale ? '' : undefined },
      h('span', { className: 'pt-clock-now' }, fmt(Math.min(playback.time, total))),
      h('span', { className: 'pt-clock-sep' }, '/'),
      h('span', { className: 'pt-clock-total' }, fmt(total)), h('span', { className: 'pt-clock-unit' }, ' s')));
}

function Playhead({ store, x, top, bottom }) {
  const playback = usePlayback(store);
  const left = x(playback.time);
  return h(React.Fragment, null,
    h('span', { className: 'pt-playline', style: { left, top, height: Math.max(0, bottom - top) }, 'aria-hidden': true }),
    h('span', { className: 'pt-playhead', style: { left, top: top - 9 }, 'aria-hidden': true }));
}

function Ruler({ store, total, left, width, top, onScrub }) {
  const playback = usePlayback(store);
  return h('div', { className: 'pt-ruler', style: { left, width, top, height: RULER }, role: 'slider', tabIndex: 0,
    'aria-label': 'Trajectory playback position', 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': playback.time,
    'aria-valuetext': fmt(playback.time) + ' seconds of ' + fmt(total) + ' seconds',
    onKeyDown: (event) => {
      const step = event.shiftKey ? 1 : 0.1;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? total
        : event.key === 'ArrowRight' || event.key === 'ArrowUp' ? playback.time + step
          : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? playback.time - step : null;
      if (next == null) return;
      event.preventDefault(); event.stopPropagation();
      store.seek(clamp(next, 0, total));
    },
    onPointerDown: onScrub });
}

export function PathHoverReadout({ store, context, tl, metric }) {
  const hover = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  if (!context.eligible || hover?.context !== context) return null;
  const times = hover.source === 'timeline' ? [hover.t] : hover.f.map(f => tAtF(tl, f));
  const time = times[hover.source === 'field' ? hover.primary : 0];
  const sampled = hover.source === 'timeline' && SERIES[metric];
  const unit = sampled ? sampled.unit : 'm/s';
  const text = times.map(t => fmt(t)).join(' · ') + ' s · '
    + fmt(UnitPrefs.fromCanonical(vAtT(tl, time, sampled ? sampled.key : 'v'), unit), sampled && sampled.key === 'k' ? 2 : 1) + ' ' + UnitPrefs.label(unit);
  return h('div', { className: 'pt-readout path-hover-readout', 'aria-hidden': true }, text);
}

function HoverMarks({ store, context, tl, x, HEAD, graphBottom, laneTop, laneGhost = true }) {
  const hover = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  if (!context.eligible || hover?.context !== context) return null;
  const times = hover.source === 'timeline' ? [hover.t] : hover.f.map(f => tAtF(tl, f));
  const primary = hover.source === 'field' ? hover.primary : 0;
  return h('div', { className: 'pt-hover-overlay', 'aria-hidden': true },
    h('svg', { className: 'pt-svg', width: '100%', height: '100%' }, times.map((t, i) =>
      h('line', { key: i, x1: x(t), x2: x(t), y1: HEAD + RULER, y2: graphBottom, className: 'pt-hoverline', opacity: i === primary ? 1 : .55 }))),
    hover.source === 'timeline' && laneGhost && h('span', { className: 'pt-lane-ghost', style: { left: x(hover.t), top: laneTop + (LANE - 6) / 2 } }, '+'));
}

/** Why a waypoint cannot be added at a time, in the panel's words. */
export function insertionReason(check, doc) {
  if (!check || check.ok) return '';
  if (check.code === 'start') return 'The path starts here';
  if (check.code === 'end') return 'The path ends here';
  if (check.code === 'near') return 'Too close to ' + PathLinks.waypointName(null, doc, check.index);
  if (check.code === 'segtype') return 'Splitting a' + (check.segType === 'arc' ? 'n arc' : ' clothoid') + ' can reshape it. Alt-click the path on the field to preview';
  if (check.code === 'handles') return 'This segment has no handles to split';
  return 'Waiting for the path to plan';
}

// The commands of one stack, chosen one at a time. Arrow keys, Home and End move, Enter or a click chooses
// and returns focus to the stack, Escape or Tab closes, and a press elsewhere dismisses it.
export function CommandStackMenu({ stack, at, selectedIndex, style, onChoose, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const menu = ref.current;
    (menu.querySelector('[aria-checked="true"]') || menu.querySelector('button'))?.focus();
    const away = (event) => { if (!menu.contains(event.target) && !event.target.closest?.('[data-stack="' + stack.key + '"]')) onClose(false); };
    const key = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(true); return; }
      if (!menu.contains(event.target)) return;
      if (event.key === 'Tab') { onClose(false); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const items = [...menu.querySelectorAll('button')], index = items.indexOf(document.activeElement);
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    };
    window.addEventListener('pointerdown', away, true); window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', key, true); };
  }, [stack.key, onClose]);
  return h('div', { ref, role: 'menu', 'aria-label': stack.members.length + ' commands' + at(stack.t), className: 'ctxmenu pt-stack-menu', style,
    onPointerDown: (event) => event.stopPropagation() },
    stack.members.map((chip) => h('button', { key: chip.marker.id || chip.index, type: 'button', role: 'menuitemradio', tabIndex: -1,
      'aria-checked': selectedIndex === chip.index, 'data-selection': 'em:' + chip.index, className: 'ctxmenu-i pt-stack-item',
      onClick: () => onChoose(chip.index) },
      h('span', { className: 'pt-diamond', 'aria-hidden': true }),
      h('span', { className: 'pt-stack-name' }, chip.label),
      at(chip.t) && h('span', { className: 'ctxmenu-k pt-stack-time' }, fmt(chip.t) + ' s'))));
}

export function PathTimeline({ doc, derived, tl, robot, sel, select, edit, actions, playbackStore, catalog, metric = 'velocity', issues = [], issuesStale = false, selectedIssue = null, stale = false, header, hoverStore, hoverContext }) {
  const root = useRef(null);
  const [size, setSize] = useState({ w: 900, h: 260 });
  useLayoutEffect(() => {
    const element = root.current;
    const measure = () => { const r = element.getBoundingClientRect(); if (r.width) setSize({ w: r.width, h: r.height }); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const pointerDrag = PointerDrag.useController();
  // While a limit or zone drag runs, the time axis holds so the curve visibly stretches or shrinks.
  const [frozenT, setFrozenT] = useState(null);

  const T = Math.max(0.01, frozenT ? Math.max(frozenT, tl.total) : tl.total);
  // Without timing, items sit by path fraction and nothing is labelled in seconds.
  const timed = !tl.empty;
  const at = (t) => timed ? ', ' + fmt(t) + ' s' : '';
  const { w: W, h: H } = size;
  // A narrow timeline (the full inspector open at the minimum window) stacks its header in two rows.
  const compact = W < 600, narrow = W < 340;
  const HEAD = narrow ? 112 : compact ? 78 : HEAD_ROW;
  const plotW = Math.max(50, W - GUTTER - RIGHT);
  const graphTop = HEAD + RULER + 4;
  const laneTop = H - LANE - 2;
  const wpTop = laneTop - WPROW;
  const graphBottom = wpTop - 2;
  const graphH = Math.max(24, graphBottom - graphTop);
  const c = doc.constraints || {};
  const series = SERIES[metric] || null;
  const shown = (value) => series ? UnitPrefs.fromCanonical(value, series.unit) : speed(value);
  const valueOf = (point) => series ? point[series.key] || 0 : point.v;
  const peak = tl.points.reduce((value, point) => Math.max(value, Math.abs(shown(valueOf(point)))), 0);
  const span = series ? Math.max(peak, series.key === 'k' ? 0.1 : 0.5) : Math.max(speed(robot.maxSpeed || 1), peak, speed(c.maxVel || 0));
  // A signed axis spends half its height on each side of zero.
  const vStep = niceStep(span, Math.max(1, Math.min(10, graphH / (series?.signed ? 52 : 26))));
  const vTop = Math.max(vStep, Math.ceil(span / vStep - 1e-9) * vStep);
  const vLow = series?.signed ? -vTop : 0;
  const x = (t) => GUTTER + (clamp(t, 0, T) / T) * plotW;
  const tAtX = (px) => clamp(((px - GUTTER) / plotW) * T, 0, T);
  const yDisplay = (value) => graphBottom - ((clamp(value, vLow, vTop) - vLow) / (vTop - vLow)) * graphH;
  const y = (v) => yDisplay(speed(v));
  const vAtY = (py) => UnitPrefs.toCanonical(((graphBottom - py) / graphH) * vTop, 'm/s');
  const local = (event) => { const r = root.current.getBoundingClientRect(); return { x: event.clientX - r.left, y: event.clientY - r.top }; };

  // Drawn start to end; `ends` maps each drawn edge back to the authored end it moves.
  const zones = zoneFractions(doc, derived).map((range, index) => ({ ...(doc.ranges || [])[index], f0: Math.min(range.f0, range.f1), f1: Math.max(range.f0, range.f1),
    ends: range.f0 <= range.f1 ? [0, 1] : [1, 0], index }));
  const markers = doc.markers || [];
  const waypoints = doc.waypoints || [];
  const wpT = (k) => tAtF(tl, tl.wpFrac[k] ?? (k / Math.max(1, waypoints.length - 1)));

  const curve = useMemo(() => {
    const p = tl.points;
    const stride = Math.max(1, Math.floor(p.length / Math.max(60, plotW / 3)));
    const kept = p.filter((_, i) => i % stride === 0 || i === p.length - 1);
    const base = yDisplay(0);
    const py = (point) => yDisplay(shown(valueOf(point)));
    let area = 'M' + x(kept[0].t).toFixed(1) + ' ' + base;
    const segments = [];
    kept.forEach((point, i) => {
      area += 'L' + x(point.t).toFixed(1) + ' ' + py(point).toFixed(1);
      if (i) {
        const before = kept[i - 1];
        segments.push({ x1: x(before.t), y1: py(before), x2: x(point.t), y2: py(point),
          color: series ? 'var(--accent)' : PM.metricColor('velocity', ((before.v + point.v) / 2) / Math.max(0.1, robot.maxSpeed)) });
      }
    });
    area += 'L' + x(kept[kept.length - 1].t).toFixed(1) + ' ' + base + 'Z';
    return { area, segments };
  }, [tl, T, W, H, robot.maxSpeed, vTop, vLow, metric]); // eslint-disable-line react-hooks/exhaustive-deps

  const tStep = niceStep(T, Math.max(2, plotW / 84));
  const tDigits = Math.max(0, Math.min(3, -Math.floor(Math.log10(tStep) + 1e-9)));
  // Index-based ticks: no floating accumulation, and a bounded count whatever the measured size.
  const tTicks = Array.from({ length: Math.min(60, Math.floor(T / tStep + 1e-6) + 1) }, (_, i) => Number((i * tStep).toFixed(4)));
  const vTicks = Array.from({ length: Math.min(30, Math.round((vTop - vLow) / vStep) + 1) }, (_, i) => Number((vLow + i * vStep).toFixed(4)));

  // Chips in two rows, in time order. A chip that would run into the next one in its row is shortened,
  // down to its diamond; the full name stays in its accessible label, tooltip and the panel. Three or more
  // commands that crowd one place at this zoom become one stack chip with a count, opened to choose one.
  const chips = useMemo(() => {
    const placed = markers.map((marker, index) => {
      const timed = derived?.markers?.find?.((item) => item.id === marker.id);
      const t = timed && Number.isFinite(timed.timeS) && !frozenT ? timed.timeS : tAtF(tl, featureFraction(marker, derived));
      return { marker, index, t, label: commandLabel(marker, catalog) };
    }).sort((a, b) => a.t - b.t);
    const items = groupCommandChips(placed, x).map((members) => members.length === 1 ? members[0]
      : { stack: true, members, t: members[0].t, key: members.map((chip) => chip.marker.id || chip.index).join('|'),
        label: members.length + ' commands', minW: 38 + 7 * String(members.length).length });
    const last = [null, null];
    const end = (chip) => chip ? chip.left + chip.w : -Infinity;
    items.forEach((chip) => {
      chip.left = x(chip.t) - 9;
      chip.w = chip.stack ? Math.min(160, Math.ceil(textWidth(chip.label)) + chip.minW - 4) : Math.min(160, Math.ceil(textWidth(chip.label)) + 28);
      chip.row = end(last[0]) <= chip.left - 3 ? 0 : end(last[1]) <= chip.left - 3 ? 1 : end(last[0]) <= end(last[1]) ? 0 : 1;
      const previous = last[chip.row];
      if (previous && end(previous) > chip.left - 3) previous.w = Math.max(previous.minW || 22, chip.left - 3 - previous.left);
      last[chip.row] = chip;
    });
    items.forEach((chip) => { chip.w = Math.max(chip.minW || 22, Math.min(chip.w, W - 4 - chip.left)); });
    return items;
  }, [markers, derived, tl, T, W, catalog, frozenT]); // eslint-disable-line react-hooks/exhaustive-deps
  const [openStack, setOpenStack] = useState(null);
  const stackRefs = useRef(new Map());
  const shownStack = openStack && chips.find((chip) => chip.stack && chip.key === openStack);
  // A stack whose members changed is gone; forget it so a later stack with the same members does not reopen.
  useEffect(() => { if (openStack && !shownStack) setOpenStack(null); }, [openStack, shownStack]);
  const closeStack = React.useCallback((refocus) => {
    const key = openStack;
    setOpenStack(null);
    if (refocus) stackRefs.current.get(key)?.focus();
  }, [openStack]);

  // ---------- adding a waypoint where the robot is at a time ----------
  const [pointsHover, setPointsHover] = useState(null);
  const [pointsStatus, setPointsStatus] = useState(null);
  useEffect(() => {
    if (!pointsStatus) return undefined;
    const timer = setTimeout(() => setPointsStatus(null), 4000);
    return () => clearTimeout(timer);
  }, [pointsStatus]);
  // Held or older timing would place the point by stale times and distances: wait for the current plan.
  const insertionAt = (t) => stale || tl.empty ? { ok: false, code: 'unplanned' } : waypointInsertionAt(tl, derived, doc, t);
  const insertWaypointAt = (t) => {
    const check = insertionAt(t);
    if (!check.ok) { setPointsStatus({ t, text: 'Can’t add a point here. ' + insertionReason(check, doc) + '.' }); return; }
    setPointsStatus(null);
    actions.addWaypoint({ x: check.visit.x, y: check.visit.y }, check.segment, true, check.visit);
  };

  // ---------- gestures: one undo step each, Escape restores the start ----------
  // Pressing commits a focused draft first, as the blur the press prevents would; an invalid draft keeps
  // focus and nothing starts. While the pointer is held the gesture owns the keyboard: Escape cancels and
  // other keys wait for release, so no shortcut, Tab or Enter commits a competing value mid-drag.
  // `pick` reads the edited value; a gesture that ends where it began records nothing. A press that does
  // not move focuses its control, as a click on a field would, so its arrow keys work next.
  const gesture = (event, { move, end, cursor, before, pick }) => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const control = event.currentTarget.tabIndex >= 0 ? event.currentTarget : null;
    if (!edit.flushDraft()) return;
    if (before) before();
    const x0 = event.clientX, y0 = event.clientY, axis = T;
    let started = false, baseline = null;
    const onKey = (key) => {
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(key.key)) return;
      key.preventDefault(); key.stopPropagation();
      if (key.key === 'Escape') pointerDrag.cancel({ flush: false });
    };
    window.addEventListener('keydown', onKey, true);
    const done = () => { window.removeEventListener('keydown', onKey, true); setFrozenT(null); };
    // Another owner (Push finishing the draft) may resolve the edit first; the gesture then stops.
    const owned = () => started && Boolean(edit.draft());
    const same = () => JSON.stringify(pick(edit.draft())) === baseline;
    pointerDrag.start(event, { cursor,
      move: (next) => {
        // Push can open a review before an unmoved press has begun an edit.
        // Retire that capture rather than start editing behind the dialog.
        if (document.querySelector('dialog:modal, [role="dialog"][aria-modal="true"]')) {
          pointerDrag.cancel({ flush: false }); return;
        }
        if (!started) {
          if (Math.hypot(next.clientX - x0, next.clientY - y0) < 3) return;
          started = true; setFrozenT(axis); edit.begin();
          baseline = JSON.stringify(pick(edit.draft()));
        }
        if (!owned()) { pointerDrag.cancel({ flush: false }); return; }
        move(next);
      },
      end: (next) => {
        done();
        if (owned()) { if (same()) edit.cancel(); else edit.finish(); }
        if (!started && control) control.focus();
        if (end) end(next, started);
      },
      cancel: () => { done(); if (owned()) edit.cancel(); } });
  };
  const scrub = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const seekAt = (next) => playbackStore.seek(tAtX(local(next).x));
    seekAt(event);
    pointerDrag.start(event, { move: seekAt });
  };
  const vFromPointer = (next) => clamp(vAtY(local(next).y), 0.1, robot.maxSpeed);
  const round = (v) => Math.round(v * 100) / 100;
  const pathLimit = (path) => path.constraints.maxVel ?? robot.maxSpeed;
  const limitDrag = (event) => gesture(event, { cursor: 'ns-resize', pick: pathLimit,
    move: (next) => edit.mutate((path) => { path.constraints.maxVel = round(vFromPointer(next)); return path; }) });
  const zoneCapDrag = (index) => (event) => gesture(event, { cursor: 'ns-resize', before: () => select('cr', index), pick: (path) => path.ranges[index]?.maxVel,
    move: (next) => edit.mutate((path) => { if (path.ranges[index]) path.ranges[index].maxVel = round(vFromPointer(next)); return path; }) });
  // An edge stays on its side of the other one, as in the panel's From and To.
  const edgeFraction = (zone, side, f) => side ? clamp(f, zone.f0, 1) : clamp(f, 0, zone.f1);
  const zoneEdgeDrag = (zone, side) => (event) => {
    const frozen = tl;
    gesture(event, { cursor: 'ew-resize', before: () => select('cr', zone.index), pick: (path) => path.ranges[zone.index],
      move: (next) => actions.moveRangeHandle(zone.index, zone.ends[side], edgeFraction(zone, side, fAtT(frozen, tAtX(local(next).x)))) });
  };
  const chipDrag = (chip) => (event) => {
    const frozen = tl;
    gesture(event, { cursor: 'grabbing', pick: (path) => path.markers[chip.index],
      move: (next) => {
        const f = fAtT(frozen, tAtX(local(next).x));
        edit.mutate((path) => { const item = path.markers[chip.index]; if (item) Object.assign(item, featurePositionPatch(item, f, derived)); return path; });
      },
      end: (next, moved) => { if (!moved) select('em', chip.index); } });
  };
  // Keyboard sliders commit one change per key press, and none when the bound or the rounding leaves
  // the value where it was.
  const stepKeys = (event, value, step, apply) => {
    const direction = event.key === 'ArrowUp' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowDown' || event.key === 'ArrowLeft' ? -1 : 0;
    if (!direction) return;
    event.preventDefault(); event.stopPropagation();
    apply(value + direction * step * (event.shiftKey ? 10 : 1));
  };
  const changed = (a, b, tolerance = 1e-9) => !(Math.abs(a - b) <= tolerance);
  const speedStep = UnitPrefs.toCanonical(0.05, 'm/s');

  const onBodyMove = (event) => {
    if (!hoverStore) return;
    if (event.buttons) { hoverStore.clear(undefined, hoverContext); return; }
    const point = local(event);
    // Bare lane owns its move before graph routing; chip/control moves must not resurrect its plus.
    const lane = event.target.classList?.contains('pt-lane') || event.target.classList?.contains('pt-points');
    const graph = !event.target.closest('button,[role="slider"]') && point.x >= GUTTER - 4 && point.x <= W - RIGHT + 4
      && point.y >= graphTop && point.y <= graphBottom;
    if (lane || graph) hoverStore.setTimeline(hoverContext, tAtX(point.x));
    else hoverStore.clear('timeline', hoverContext);
  };

  const selWp = sel.kind === 'wp' ? sel.idx : null;
  const selSeg = sel.kind === 'seg' ? sel.idx : null;
  const selZone = sel.kind === 'cr' ? sel.idx : null;
  const speedUnit = UnitPrefs.label('m/s');
  const limitLabel = fmt(speed(Math.min(c.maxVel ?? robot.maxSpeed, robot.maxSpeed)));

  return h('section', { ref: root, className: 'pt', 'aria-label': 'Timeline', 'data-stale': stale ? '' : undefined, 'data-compact': compact ? '' : undefined, 'data-narrow': narrow ? '' : undefined,
    ...shiftDeletionInput((event) => {
      const [kind, raw] = event.target.closest('[data-selection]').dataset.selection.split(':');
      const index = Number(raw);
      if (!Number.isInteger(index)) return;
      pointerDrag.cancel();
      if (kind === 'wp') actions.delWp(index);
      else if (kind === 'seg') actions.delWp(index + 1);
      else if (kind === 'rt') actions.delTarget(index);
      else if (kind === 'em') { setOpenStack(null); actions.delMarker(index); }
      else if (kind === 'cr') actions.delRange(index);
    }, (event) => Boolean(event.target.closest?.('[data-selection]'))),
    onPointerMove: onBodyMove, onPointerLeave: () => hoverStore?.clear('timeline', hoverContext),
    onPointerCancel: () => hoverStore?.clear('timeline', hoverContext), onLostPointerCapture: () => hoverStore?.clear('timeline', hoverContext) },
    h('div', { className: 'pt-head', style: { height: HEAD } },
      h('div', { className: 'pt-transport' }, h(Clock, { store: playbackStore, total: tl.empty ? 0 : tl.total, stale })),
      header),

    h('svg', { className: 'pt-svg', width: W, height: H, 'aria-hidden': true },
      vTicks.map((v, i) => h('g', { key: 'v' + i },
        h('line', { x1: GUTTER, x2: W - RIGHT, y1: yDisplay(v), y2: yDisplay(v), className: v === 0 ? 'pt-axis' : 'pt-grid' }),
        h('text', { x: GUTTER - 8, y: yDisplay(v) + 3.5, className: 'pt-tick', textAnchor: 'end' }, Number(v.toFixed(2))))),
      tTicks.map((t) => h('g', { key: 't' + t },
        h('line', { x1: x(t), x2: x(t), y1: HEAD + RULER - 5, y2: HEAD + RULER, className: 'pt-axis' }),
        h('line', { x1: x(t), x2: x(t), y1: graphTop, y2: graphBottom, className: 'pt-grid faint' }),
        timed && h('text', { x: x(t), y: HEAD + 12, className: 'pt-tick', textAnchor: t === 0 ? 'start' : x(t) > W - RIGHT - 14 ? 'end' : 'middle' }, t === 0 ? '0' : t.toFixed(tDigits)))),
      h('line', { x1: GUTTER, x2: W - RIGHT, y1: HEAD + RULER, y2: HEAD + RULER, className: 'pt-axis' }),
      zones.map((zone) => {
        const x0 = x(tAtF(tl, zone.f0)), x1 = x(tAtF(tl, zone.f1));
        return h('g', { key: 'z' + zone.index, className: 'pt-zone' + (selZone === zone.index ? ' selected' : ''), 'data-selection': 'cr:' + zone.index },
          h('rect', { x: x0, y: graphTop, width: Math.max(1, x1 - x0), height: graphH, className: 'pt-zone-fill' }),
          !series && zone.maxVel != null && h('line', { x1: x0, x2: x1, y1: y(zone.maxVel), y2: y(zone.maxVel), className: 'pt-zone-cap' }));
      }),
      !tl.empty && h('path', { d: curve.area, className: 'pt-area' }),
      !tl.empty && h('g', { className: 'pt-curve' }, curve.segments.map((s, i) => h('line', { key: i, x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, stroke: s.color }))),
      !series && h('line', { x1: GUTTER, x2: W - RIGHT, y1: y(c.maxVel ?? robot.maxSpeed), y2: y(c.maxVel ?? robot.maxSpeed), className: 'pt-limit' }),
      issues.map((issue, i) => {
        const whole = isWholeIssue(issue);
        const x0 = whole ? GUTTER : x(tAtF(tl, issue.f0)), x1 = whole ? W - RIGHT : x(tAtF(tl, issue.f1));
        return h('g', { key: 'i' + i, className: 'pt-issue ' + (issue.severity || 'error') + (issuesStale ? ' stale' : '') + (selectedIssue === i ? ' selected' : '') },
          h('rect', { x: x0, y: graphTop, width: Math.max(3, x1 - x0), height: graphH, className: 'pt-issue-fill' }),
          h('rect', { x: x0, y: graphTop, width: Math.max(3, x1 - x0), height: 2, className: 'pt-issue-bar' }));
      }),
      selWp != null && waypoints[selWp] && h('line', { x1: x(wpT(selWp)), x2: x(wpT(selWp)), y1: graphTop, y2: wpTop + WPROW / 2, className: 'pt-selline' })),

    h('div', { className: 'pt-gutter', style: { top: HEAD, height: RULER } }, 'Time', h('span', null, 's')),
    h('div', { className: 'pt-gutter', style: { top: graphTop, height: 30 } }, series ? series.label : 'Speed', h('span', null, series ? UnitPrefs.label(series.unit) : speedUnit)),
    h(Ruler, { store: playbackStore, total: tl.empty ? 0 : tl.total, left: GUTTER, width: plotW, top: HEAD, onScrub: scrub }),
    h('div', { className: 'pt-graph-hit', style: { left: GUTTER, width: plotW, top: graphTop, height: graphH }, onPointerDown: scrub, 'aria-hidden': true }),
    !series && h('div', { className: 'pt-limit-hit', style: { left: GUTTER, width: plotW, top: y(c.maxVel ?? robot.maxSpeed) - 5 }, onPointerDown: limitDrag, 'aria-hidden': true }),

    zones.map((zone) => {
      const x0 = x(tAtF(tl, zone.f0)), x1 = x(tAtF(tl, zone.f1));
      const on = selZone === zone.index, name = zone.name || 'Zone';
      return h(React.Fragment, { key: 'zh' + zone.index },
        h('button', { type: 'button', className: 'pt-zone-tag' + (on ? ' selected' : ''), style: { left: x0 + 1, top: graphTop + 3, maxWidth: Math.max(28, x1 - x0 - 2) },
          'aria-pressed': on, 'data-selection': 'cr:' + zone.index, onPointerDown: (event) => event.stopPropagation(), onClick: () => select('cr', zone.index) }, name),
        !series && zone.maxVel != null && h('div', { className: 'pt-zone-cap-hit' + (on ? ' selected' : ''), 'data-selection': 'cr:' + zone.index, style: { left: x0, width: Math.max(8, x1 - x0), top: y(zone.maxVel) - 6 },
          role: 'slider', tabIndex: 0, 'aria-label': name + ' speed', 'aria-valuemin': 0, 'aria-valuemax': Number(speed(robot.maxSpeed).toFixed(2)),
          'aria-valuenow': Number(speed(zone.maxVel).toFixed(2)), 'aria-valuetext': fmt(speed(zone.maxVel)) + ' ' + speedUnit,
          onKeyDown: (event) => stepKeys(event, zone.maxVel, speedStep, (v) => {
            const next = round(clamp(v, 0.1, robot.maxSpeed));
            if (changed(next, zone.maxVel)) actions.setRange(zone.index, { maxVel: next });
          }),
          onPointerDown: zoneCapDrag(zone.index) }, h('span', { className: 'pt-zone-cap-val' }, fmt(speed(zone.maxVel)))),
        ['f0', 'f1'].map((which, side) => h('div', { key: which, className: 'pt-zone-edge', 'data-selection': 'cr:' + zone.index, style: { left: (side ? x1 : x0) - 5, top: graphTop, height: graphH },
          role: 'slider', tabIndex: 0, 'aria-label': name + (side ? ' end' : ' start'), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(zone[which] * 100),
          onKeyDown: (event) => stepKeys(event, zone[which], 0.005, (f) => {
            const next = edgeFraction(zone, side, f);
            if (changed(next, zone[which], 1e-6)) actions.setRangeEnd(zone.index, zone.ends[side], next);
          }),
          onPointerDown: zoneEdgeDrag(zone, side) })));
    }),

    !series && h('div', { className: 'pt-limit-handle', style: { top: y(c.maxVel ?? robot.maxSpeed), left: W - RIGHT - 50 }, role: 'slider', tabIndex: 0,
      'aria-label': 'Path speed limit', 'aria-valuemin': 0.1, 'aria-valuemax': Number(speed(robot.maxSpeed).toFixed(2)), 'aria-valuenow': Number(limitLabel),
      'aria-valuetext': limitLabel + ' ' + speedUnit,
      onKeyDown: (event) => stepKeys(event, pathLimit(doc), speedStep, (v) => {
        const next = round(clamp(v, 0.1, robot.maxSpeed));
        if (changed(next, pathLimit(doc))) actions.setConstraint({ maxVel: next });
      }),
      onPointerDown: limitDrag }, limitLabel),

    h('div', { className: 'pt-gutter', style: { top: wpTop, height: WPROW } }, 'Points'),
    // Like the command lane: the row's open space adds a waypoint where the robot is at that time, Enter adds
    // one at the playhead. The point splits its segment exactly, so the path keeps its shape.
    h('div', { className: 'pt-points', style: { left: GUTTER, width: plotW, top: wpTop, height: WPROW }, role: 'button', tabIndex: 0,
      'aria-label': 'Add waypoint at the playhead', 'data-blocked': pointsHover && !pointsHover.check.ok ? '' : undefined,
      onPointerMove: (event) => {
        if (event.target !== event.currentTarget || event.buttons) { if (pointsHover) setPointsHover(null); return; }
        const t = tAtX(local(event).x);
        setPointsHover({ t, check: insertionAt(t) });
      },
      onPointerLeave: () => setPointsHover(null),
      onPointerDown: (event) => { if (event.target === event.currentTarget) event.stopPropagation(); },
      onClick: (event) => { if (event.target === event.currentTarget) insertWaypointAt(tAtX(local(event).x)); },
      onBlur: () => setPointsStatus(null),
      onKeyDown: (event) => {
        if ((event.key !== 'Enter' && event.key !== ' ') || event.target !== event.currentTarget) return;
        event.preventDefault(); event.stopPropagation();
        if (!event.repeat) insertWaypointAt(clamp(playbackStore.getSnapshot().time, 0, T));
      } }),
    pointsHover && h('span', { className: 'pt-points-ghost', 'data-blocked': pointsHover.check.ok ? undefined : insertionReason(pointsHover.check, doc),
      style: { left: x(pointsHover.t), top: wpTop + WPROW / 2 }, 'aria-hidden': true }, '+'),
    pointsHover && !pointsHover.check.ok && h('span', { className: 'pt-readout pt-points-why', 'aria-hidden': true, 'data-flip': x(pointsHover.t) > W / 2 ? '' : undefined,
      style: { left: x(pointsHover.t) + (x(pointsHover.t) > W / 2 ? -10 : 10), top: wpTop - 20 } }, insertionReason(pointsHover.check, doc)),
    h('span', { className: 'pt-points-status', role: 'status', 'aria-live': 'polite', 'data-flip': pointsStatus && x(pointsStatus.t) > W / 2 ? '' : undefined,
      style: pointsStatus ? { left: x(pointsStatus.t) + (x(pointsStatus.t) > W / 2 ? -10 : 10), top: wpTop - 20 } : undefined }, pointsStatus ? pointsStatus.text : ''),
    waypoints.slice(0, -1).map((_, k) => {
      const a = x(wpT(k)) + 11, b = x(wpT(k + 1)) - 11;
      if (b - a < 6) return null;
      const on = selSeg === k;
      return h('button', { key: 'seg' + k, type: 'button', className: 'pt-seg' + (on ? ' selected' : ''), style: { left: a, width: b - a, top: wpTop + WPROW / 2 - 4 },
        'aria-label': PathLinks.waypointName(null, doc, k) + ' to ' + PathLinks.waypointName(null, doc, k + 1), 'aria-pressed': on, 'data-selection': 'seg:' + k,
        onPointerDown: (event) => event.stopPropagation(), onClick: () => select('seg', k) });
    }),
    waypoints.map((w, k) => {
      const t = wpT(k), hold = w.stop && w.wait > 0 ? w.wait : 0;
      return hold > 0 && h('div', { key: 'hold' + k, className: 'pt-hold', style: { left: x(t), width: Math.max(2, x(t + hold) - x(t)), top: wpTop + WPROW / 2 - 4 }, 'aria-hidden': true },
        x(t + hold) - x(t) > 40 && h('span', null, fmt(hold, 1) + ' s'));
    }),
    (doc.targets || []).map((target, i) => {
      const on = sel.kind === 'rt' && sel.idx === i;
      return h('button', { key: 'rt' + i, type: 'button', className: 'pt-target' + (on ? ' selected' : ''), style: { left: x(tAtF(tl, featureFraction(target, derived))), top: wpTop + WPROW / 2 },
        'aria-label': 'Rotation target ' + (i + 1) + ', ' + Number(target.deg || 0).toFixed(0) + '°', 'aria-pressed': on, 'data-selection': 'rt:' + i,
        onPointerDown: (event) => event.stopPropagation(), onClick: () => select('rt', i) });
    }),
    waypoints.map((w, k) => {
      const on = selWp === k, n = waypoints.length;
      const name = PathLinks.waypointName(null, doc, k);
      return h('button', { key: 'wp' + k, type: 'button', className: 'pt-wp' + (w.stop ? ' stop' : '') + (on ? ' selected' : '') + (k === 0 ? ' start' : k === n - 1 ? ' end' : ''),
        style: { left: x(wpT(k)), top: wpTop + WPROW / 2 }, 'aria-label': name + (w.stop ? ', stop' : '') + at(wpT(k)), 'aria-pressed': on, title: name, 'data-selection': 'wp:' + k,
        onPointerDown: (event) => event.stopPropagation(), onClick: () => select('wp', k) }, h('span', null, k === 0 || k === n - 1 ? '' : k));
    }),

    h('div', { className: 'pt-gutter', style: { top: laneTop, height: LANE - 6 } }, 'Commands'),
    h('div', { className: 'pt-lane', style: { left: GUTTER, width: plotW, top: laneTop, height: LANE - 6 }, role: 'button', tabIndex: 0, 'aria-label': 'Add command at the playhead',
      onPointerDown: (event) => { if (event.target === event.currentTarget) event.stopPropagation(); },
      onClick: (event) => { if (event.target === event.currentTarget) actions.addMarkerAt(null, fAtT(tl, tAtX(local(event).x))); },
      onKeyDown: (event) => {
        if ((event.key !== 'Enter' && event.key !== ' ') || event.target !== event.currentTarget) return;
        event.preventDefault(); event.stopPropagation();
        // A held key places one command; its repeats reach the lane until the new command's search takes focus.
        if (!event.repeat) actions.addMarkerAt(null, fAtT(tl, clamp(playbackStore.getSnapshot().time, 0, T)));
      } }),
    chips.map((chip) => {
      if (chip.stack) {
        const chosen = sel.kind === 'em' ? chip.members.find((member) => member.index === sel.idx) : null;
        const open = shownStack === chip;
        return h('button', { key: chip.key, ref: (node) => { if (node) stackRefs.current.set(chip.key, node); else stackRefs.current.delete(chip.key); },
          type: 'button', className: 'pt-chip stack' + (chosen ? ' selected' : ''), 'data-stack': chip.key,
          style: { left: chip.left, width: chip.w, top: laneTop + 1 + chip.row * (CHIP_H + 2), height: CHIP_H },
          'aria-label': chip.label + at(chip.t) + (chosen ? ', ' + chosen.label + ' selected' : ''), 'aria-haspopup': 'menu', 'aria-expanded': open,
          title: chip.members.map((member) => member.label).join('\n'),
          onPointerDown: (event) => { if (event.button === 0) event.stopPropagation(); },
          onClick: () => setOpenStack(open ? null : chip.key),
          onKeyDown: (event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault(); event.stopPropagation(); setOpenStack(chip.key);
          } },
          h('span', { className: 'pt-stack-glyph', 'aria-hidden': true }),
          h('span', { className: 'pt-stack-count', 'aria-hidden': true }, chip.members.length),
          h('span', { className: 'pt-chip-name', 'aria-hidden': true }, chosen ? chosen.label : 'commands'));
      }
      const on = sel.kind === 'em' && sel.idx === chip.index;
      return h('button', { key: chip.marker.id || chip.index, type: 'button', className: 'pt-chip' + (on ? ' selected' : ''),
        style: { left: chip.left, width: chip.w, top: laneTop + 1 + chip.row * (CHIP_H + 2), height: CHIP_H },
        'aria-label': chip.label + at(chip.t), 'aria-pressed': on, title: chip.label, 'data-selection': 'em:' + chip.index,
        onPointerDown: chipDrag(chip),
        onKeyDown: (event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault(); event.stopPropagation();
            const next = clamp(chip.t + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 0.5 : 0.05), 0, T);
            const f = fAtT(tl, next);
            // At either end, or inside a stop's wait, time moves but the command's place does not.
            if (changed(f, featureFraction(chip.marker, derived), 1e-6)) actions.setMarker(chip.index, featurePositionPatch(chip.marker, f, derived));
          } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); select('em', chip.index); }
        } },
        h('span', { className: 'pt-diamond', 'aria-hidden': true }), h('span', { className: 'pt-chip-name' }, chip.label));
    }),
    shownStack && h(CommandStackMenu, { stack: shownStack, at, selectedIndex: sel.kind === 'em' ? sel.idx : null, onClose: closeStack,
      style: { left: clamp(shownStack.left, 4, Math.max(4, W - 244)), bottom: H - (laneTop + 1 + shownStack.row * (CHIP_H + 2)) + 4,
        maxHeight: Math.max(60, Math.min(260, laneTop + 1 + shownStack.row * (CHIP_H + 2) - 12)) },
      onChoose: (index) => { closeStack(true); select('em', index); } }),
    hoverStore && h(HoverMarks, { store: hoverStore, context: hoverContext, tl, x, HEAD, graphBottom, laneTop, laneGhost: !pointsHover }),
    h(Playhead, { store: playbackStore, x, top: HEAD + RULER, bottom: laneTop + LANE - 8 }));
}
