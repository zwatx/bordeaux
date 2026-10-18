import { deletionInput } from './DeletionNotice';
import * as React from "react";
import { createPortal } from "react-dom";
import { PointerDrag } from "../hooks/usePointerDrag";
import { AUTO } from "../lib/routineModel";
import { UnitPrefs } from "../lib/unitPreferences";
import { commandArguments } from "./ContextInspector";
import { UI } from "./ui";

// Routine run sheet: one line per step in run order, each with its share of preview time on a shared axis. Repeats and
// branches are bounded groups; a branch's routes are lanes. A closing row states what authored control flow does next
// (shown when it is not obvious from the group ending); those facts come from AUTO.flowSummary, never from the chosen
// preview route. Explanations live in tooltips and the inspector. Selecting a row only changes the right inspector.
const { useState, useRef, useEffect, useLayoutEffect } = React;
const h = React.createElement;
const { Icon } = UI;
const A = AUTO;
const fmt = (t) => UnitPrefs.format(t || 0, 's', 2);
const plural = (count, singular) => count + ' ' + singular + (count === 1 ? '' : /s$/.test(singular) ? 'es' : 's');

// Glyphs the shared icon set lacks, drawn in its 24px line style.
const EXTRA_GLYPHS = {
  repeat: 'M17 2l3 3-3 3 M4 11V9a4 4 0 0 1 4-4h12 M7 22l-3-3 3-3 M20 13v2a4 4 0 0 1-4 4H4',
  exit: 'M10 7V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-2 M15 12H3 M6 9l-3 3 3 3',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  join: 'M7 3v4a5 5 0 0 0 5 5 M17 3v4a5 5 0 0 1-5 5v9 M8.5 17.5L12 21l3.5-3.5',
  loop: 'M19 21v-7a6 6 0 0 0-6-6H5 M9 4L5 8l4 4',
};
export function Glyph({ name, size = 15 }) {
  if (!EXTRA_GLYPHS[name]) return h(Icon, { name, size });
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true, focusable: false, fill: 'none', stroke: 'currentColor', strokeWidth: name === 'more' ? 2.8 : 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }, h('path', { d: EXTRA_GLYPHS[name] }));
}

const isBranch = (node) => node.type === 'decision' || Boolean(node.outputBranch);
const routeIdOf = (ref) => ref.kind === 'decision' ? ref.route : ref.routeId;
const refKey = (ref) => JSON.stringify(ref);

function conditionLabel(catalog, id) {
  return A.authoritativeConditions(catalog).find((condition) => condition.value === id)?.label || id;
}
function commandLabel(command, node) { return command?.label || node?.title || node?.invocation?.commandId || 'command'; }

/** Plain description of a stop rule or early end, for rows and the inspector. */
export function describeStop(stop, routine, catalog) {
  if (!stop) return '';
  if (stop.source === 'condition') return stop.conditionId ? conditionLabel(catalog, stop.conditionId) : 'a condition (choose one)';
  const producer = routine && A.locate(routine, stop.nodeId)?.node;
  const command = catalog?.commands?.find((item) => item.id === producer?.invocation?.commandId);
  const output = A.branchOutputs(command).find((item) => item.name === stop.output);
  const subject = commandLabel(command, producer) + (stop.output ? ' ' + (output?.label || stop.output) : ' result');
  return stop.value === undefined ? subject + ' (choose a value)' : subject + ' ' + A.routeSummary({ operator: stop.operator, value: stop.value });
}

/** A chosen-trace reference jump: planned reference poses only, never measured robot motion. */
export function continuityText(issue) {
  const parts = [];
  if (issue.distanceM > 0.001) parts.push(UnitPrefs.format(issue.distanceM, 'm', 2));
  if (issue.headingRad > 0.001) parts.push(Math.round(issue.headingRad * 180 / Math.PI) + '°');
  return 'Starts ' + (parts.join(' and ') || 'slightly') + ' from where the previous path ends';
}

/** Row title. Condition branches name their condition's catalog label. */
export function stepTitle(node, paths, catalog) {
  if (node.type === 'decision') return node.cond ? 'Branch on ' + conditionLabel(catalog, node.cond) : 'Branch on condition';
  if (node.type === 'repeat') return node.until ? 'Repeat up to ' + node.times + ' times' : 'Repeat ' + plural(node.times, 'time');
  return A.nodeTitle(node, paths, catalog);
}

/** How a command or wait ends, in one line. */
export function endsPhrase(node, routine, catalog) {
  const ends = node.ends || {};
  const early = ends.endWhen ? describeStop(ends.endWhen, routine, catalog) : '';
  const limit = ends.timeoutS !== undefined ? 'limit ' + fmt(ends.timeoutS) + (ends.onTimeout === 'endRoutine' ? ', then end routine' : ends.onTimeout === 'continue' ? '' : ', then choose') : '';
  if (node.type === 'builtin') return early ? 'Or earlier, when ' + early : 'Pause before the next step';
  return [early ? 'Until it finishes or ' + early : 'Until it finishes', limit].filter(Boolean).join(' · ');
}

function routeRule(node, list) {
  if (list.ref.kind === 'decision') return list.ref.route === 'then' ? 'is true' : 'is false';
  const route = node.outputBranch.routes.find((item) => item.id === list.ref.routeId);
  if (!route) return '';
  const rule = A.routeSummary(route), name = (route.label || '').toLowerCase();
  // The rule only shows when the name does not already say it (Left = Left, Otherwise).
  return rule.toLowerCase() === name || rule.toLowerCase() === '= ' + name ? '' : rule;
}

/**
 * What a list reaches when it completes normally: the next step after its owner, the end of the enclosing repeat's
 * pass, or the end of the routine. `many` picks the plural verb ("Both routes continue").
 */
function continuePhrase(after, paths, catalog, many) {
  const verb = (plural, singular) => (many ? plural : singular);
  if (after?.kind === 'step') return [verb('continue', 'continues') + ' to ', { name: stepTitle(after.node, paths, catalog) }];
  if (after?.kind === 'pass') return [verb('finish', 'finishes') + ' the pass'];
  return [verb('finish', 'finishes') + ' the routine'];
}
const plainText = (parts) => parts.map((part) => (typeof part === 'string' ? part : '“' + part.name + '”')).join('');
/** Terminal outcomes of a list that cannot complete normally, as a verb phrase. */
function terminalPhrase(flow) {
  return flow.endRoutine && flow.exitRepeat ? 'ends the routine or leaves the repeat' : flow.exitRepeat ? 'leaves the repeat' : 'ends the routine';
}
function nameList(names) {
  const parts = [];
  names.forEach((name, index) => {
    if (index) parts.push(index === names.length - 1 ? ' and ' : ', ');
    parts.push({ name });
  });
  return parts;
}

/** Closing row of a branch: only routes that complete normally reach the shared continuation. */
export function branchClosing(lists, after, paths, catalog, cache) {
  const flows = lists.map((list) => ({ list, flow: A.flowSummary(list.nodes, cache) }));
  const going = flows.filter((item) => item.flow.normal);
  if (!going.length) {
    const flow = { endRoutine: flows.some((item) => item.flow.endRoutine), exitRepeat: flows.some((item) => item.flow.exitRepeat) };
    return { glyph: flow.exitRepeat && !flow.endRoutine ? 'exit' : 'stop', terminal: true, parts: ['No route continues; every route ' + terminalPhrase(flow)] };
  }
  const all = going.length === lists.length;
  const who = all ? [lists.length === 2 ? 'Both routes ' : 'All ' + lists.length + ' routes '] : ['Only ', ...nameList(going.map((item) => item.list.label)), ' '];
  // When every route continues, the group's end already shows convergence; the sentence stays for assistive technology.
  return { glyph: 'join', quiet: all, parts: [...who, ...continuePhrase(after, paths, catalog, all || going.length > 1)] };
}

/** Closing row of a repeat: a pass loops back only when its body can complete normally. */
export function repeatClosing(node, routine, catalog, cache, previewPasses) {
  const body = A.flowSummary(node.nodes, cache);
  if (!body.normal) return { glyph: body.exitRepeat && !body.endRoutine ? 'exit' : 'stop', terminal: true, parts: ['Never loops back; the first pass always ' + terminalPhrase(body)] };
  if (node.times === 1) return { glyph: 'join', parts: ['Runs once, then continues'] };
  const passes = (node.until ? 'up to ' : '') + plural(node.times, 'pass');
  const conditionMissing = node.until?.source === 'condition' && !A.authoritativeConditions(catalog).some(item => item.value === node.until.conditionId);
  const stopName = conditionMissing ? 'the saved condition (unavailable)' : node.until && describeStop(node.until, routine, catalog);
  const previewing = node.until && previewPasses !== undefined ? ' · previewing ' + previewPasses : '';
  return { glyph: 'loop', parts: ['Back to the top', ...(node.until ? [' until ', { name: stopName }] : []), ' · ' + passes + previewing] };
}

function glyphFor(node) {
  if (node.type === 'path' || node.type === 'generatedTrajectory') return 'route';
  if (node.type === 'builtin') return 'pause';
  if (node.type === 'decision' || node.outputBranch) return 'branch';
  if (node.type === 'repeat') return 'repeat';
  if (node.type === 'end') return node.scope === 'repeat' ? 'exit' : 'stop';
  if (node.type === 'function' && node.cat === 'command') return 'bolt';
  return 'info';
}

/** The list a child list reference names, as currently authored. */
function listNodes(routine, ref) {
  if (ref.kind === 'root') return routine.nodes;
  const owner = A.locate(routine, ref.nodeId);
  return owner ? A.childLists(owner.node).find((list) => refKey(list.ref) === refKey(ref))?.nodes || null : null;
}
function insideRepeat(routine, where) {
  if (where.afterId) return Boolean(A.locate(routine, where.afterId)?.repeatIds.length);
  if (where.list.kind === 'root') return false;
  if (where.list.kind === 'repeat') return true;
  return Boolean(A.locate(routine, where.list.nodeId)?.repeatIds.length);
}
function insertOperation(routine, where, node) {
  if (where.afterId) {
    const at = A.locate(routine, where.afterId);
    return at && { kind: 'insert', listRef: at.listRef, index: at.index + 1, node };
  }
  const nodes = listNodes(routine, where.list);
  return nodes && { kind: 'insert', listRef: where.list, index: nodes.length, node };
}
/** ⌥↑/⌥↓: swap with a sibling; at either end, step out of the enclosing route or repeat. */
function nudgeOperation(routine, id, dir) {
  const at = A.locate(routine, id); if (!at) return null;
  const to = at.index + dir;
  if (to >= 0 && to < at.siblings.length) return { kind: 'move', nodeId: id, listRef: at.listRef, index: dir > 0 ? to + 1 : to };
  if (!at.parent) return null;
  const owner = A.locate(routine, at.parent.id);
  return owner && { kind: 'move', nodeId: id, listRef: owner.listRef, index: dir > 0 ? owner.index + 1 : owner.index };
}

/**
 * Step kinds Add offers in a list: the authorable kinds the model exposes, a command-result branch per branchable
 * output, and Exit repeat only inside a repeat. Wait stays visible but unavailable without the catalog built-in.
 * Legacy categories and generated trajectories are never offered.
 */
export function addMenuSteps(routine, where, catalog) {
  const kinds = new Set(A.AUTHORABLE_STEPS.map((step) => step.id));
  const offered = new Set(A.authorableSteps(catalog).map((step) => step.id));
  const items = [];
  // Without linked code, commands and conditions can still be placed; the row and inspector name what is missing.
  if (kinds.has('command')) items.push({ key: 'command', kind: 'command', label: 'Command', icon: 'bolt', tone: 'cmd', meta: catalog ? undefined : 'Needs linked robot code' });
  if (kinds.has('wait')) items.push(offered.has('wait')
    ? { key: 'wait', kind: 'wait', label: 'Wait', icon: 'pause', tone: 'wait' }
    : { key: 'wait', kind: 'wait', label: 'Wait', icon: 'pause', tone: 'wait', disabled: true, meta: catalog ? 'Needs bordeaux.wait in the catalog' : 'Needs linked robot code' });
  if (kinds.has('decision')) items.push({ key: 'decision', kind: 'decision', label: 'Branch on robot condition', icon: 'branch',
    meta: !catalog ? 'Needs linked robot code' : A.authoritativeConditions(catalog).length ? undefined : 'No registered conditions yet' });
  (catalog?.commands || []).forEach((command) => A.branchOutputs(command).forEach((output) => items.push({
    key: 'branch:' + command.id + ':' + output.name, kind: 'commandBranch', command, output, icon: 'branch',
    label: 'Branch on ' + command.label + ' · ' + (output.label || output.name),
  })));
  if (kinds.has('repeat')) items.push({ key: 'repeat', kind: 'repeat', label: 'Repeat', icon: 'repeat' });
  if (kinds.has('end')) items.push({ key: 'end', kind: 'end', label: 'End routine', icon: 'stop' });
  if (kinds.has('end') && insideRepeat(routine, where)) items.push({ key: 'exit', kind: 'exit', label: 'Exit repeat', icon: 'exit' });
  return items;
}

// ---- focus movement: every row, route row and Add row is a stop in document order ----
function navStops(from) { return [...(from.closest('.rt-scroll') || document).querySelectorAll('[data-nav]')].filter((el) => el.getClientRects().length); }
function moveFocus(from, delta) {
  const stops = navStops(from), index = stops.indexOf(from);
  const next = delta === 'first' ? stops[0] : delta === 'last' ? stops[stops.length - 1] : stops[Math.max(0, Math.min(stops.length - 1, index + delta))];
  next?.focus();
  return next;
}
function navKeys(event) {
  if (event.altKey || event.metaKey || event.ctrlKey) return false;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); moveFocus(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1); return true; }
  if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); moveFocus(event.currentTarget, event.key === 'Home' ? 'first' : 'last'); return true; }
  return false;
}

// ---- drag: drop between any rows of any list that accepts the step; feedback and commit share checkEdit ----
function useDnd(routine, edit, report) {
  const [drag, setDrag] = useState(null); // { id, target: { operation, rowId, before, ref } | null, reason }
  const state = useRef(null);
  const pointerDrag = PointerDrag.useController();
  // Another routine or source cancels an active drag without applying it.
  useEffect(() => () => pointerDrag.cancel?.({ flush: false }), [routine.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const targetAt = (id, x, y) => {
    const el = document.elementFromPoint(x, y);
    const row = el?.closest?.('.rt-step'), route = el?.closest?.('.rt-route'), add = el?.closest?.('.rt-addwrap');
    let operation = null, mark = null;
    if (row && row.dataset.id !== id) {
      const at = A.locate(routine, row.dataset.id); if (!at) return null;
      const r = row.getBoundingClientRect(), before = y < r.top + r.height / 2;
      operation = { kind: 'move', nodeId: id, listRef: at.listRef, index: at.index + (before ? 0 : 1) };
      mark = { rowId: row.dataset.id, before };
    } else if (route?.dataset.list) {
      operation = { kind: 'move', nodeId: id, listRef: JSON.parse(route.dataset.list), index: 0 };
      mark = { list: route.dataset.list, edge: 'start' };
    } else if (add?.dataset.list) {
      const ref = JSON.parse(add.dataset.list), nodes = listNodes(routine, ref);
      if (!nodes) return null;
      operation = { kind: 'move', nodeId: id, listRef: ref, index: nodes.length };
      mark = { list: add.dataset.list, edge: 'end' };
    }
    if (!operation) return null;
    const check = A.checkEdit(routine, operation);
    return { operation, mark, allowed: check.allowed, reason: check.reason };
  };
  const start = (id, e) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    state.current = { id, target: null };
    setDrag({ id, target: null });
    const move = (ev) => {
      const target = targetAt(id, ev.clientX, ev.clientY);
      state.current = { id, target }; setDrag({ id, target });
    };
    // Escape cancels the drag without moving anything.
    const escape = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); pointerDrag.cancel({ flush: false }); } };
    window.addEventListener('keydown', escape, true);
    const end = () => {
      window.removeEventListener('keydown', escape, true);
      const target = state.current?.target;
      state.current = null; setDrag(null);
      if (!target) return;
      if (!target.allowed) { if (target.reason) report(target.reason); return; }
      const result = edit(target.operation);
      if (!result.changed && result.reason) report(result.reason);
    };
    pointerDrag.start(e, { move, end, cancel: () => { window.removeEventListener('keydown', escape, true); state.current = null; setDrag(null); } });
  };
  return { drag, start };
}

// ---- popovers live in the body: the workspace's container query would otherwise contain fixed positioning ----
function usePlacement(anchor, ref, width, align) {
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    const place = () => {
      if (!anchor?.isConnected || !ref.current) return;
      const r = anchor.getBoundingClientRect(), list = ref.current.querySelector('.rt-add-list');
      const height = ref.current.offsetHeight + (list ? Math.max(0, list.scrollHeight - list.clientHeight) : 0);
      const below = window.innerHeight - r.bottom - 8, above = r.top - 8;
      const down = below >= height || below >= above;
      const left = Math.max(8, Math.min(align === 'end' ? r.right - width : r.left, window.innerWidth - width - 8));
      setPos({ left, top: down ? r.bottom + 4 : undefined, bottom: down ? undefined : window.innerHeight - r.top + 4, maxHeight: Math.max(160, down ? below : above) });
    };
    place();
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [anchor, ref, width, align]);
  return pos;
}
function useOutside(ref, anchor, close) {
  useEffect(() => {
    const away = (event) => { if (!ref.current?.contains(event.target) && !anchor?.contains(event.target)) close(false); };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [ref, anchor, close]);
}

/** Searchable Add: project paths first (the common case), then the step kinds valid in this list. */
function AddMenu({ anchor, paths, steps, onPick, onClose, label, dest }) {
  const ref = useRef(null), input = useRef(null);
  const [query, setQuery] = useState('');
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const hit = (text) => terms.every((term) => text.toLocaleLowerCase().includes(term));
  const pathItems = paths.filter((path) => hit(path.name)).map((path) => ({ key: 'path:' + path.id, kind: 'path', ref: path.id, label: path.name, icon: 'route' }));
  const stepItems = steps.filter((step) => hit(step.label + ' ' + (step.meta || '')));
  const items = [...pathItems, ...stepItems];
  const [active, setActive] = useState(0);
  useEffect(() => setActive(items.findIndex((item) => !item.disabled)), [query]); // eslint-disable-line react-hooks/exhaustive-deps
  const pos = usePlacement(anchor, ref, 360, 'start');
  const placed = Boolean(pos);
  // A hidden element cannot take focus; focus once placed.
  useEffect(() => { if (placed) input.current?.focus(); }, [placed]);
  useEffect(() => { ref.current?.querySelector('.rt-ch-row.active')?.scrollIntoView({ block: 'nearest' }); }, [active]);
  useOutside(ref, anchor, onClose);
  const step = (dir) => setActive((current) => {
    for (let i = 1; i <= items.length; i++) { const next = (current + dir * i + items.length * 2) % items.length; if (!items[next].disabled) return next; }
    return current;
  });
  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); step(event.key === 'ArrowDown' ? 1 : -1); }
    else if (event.key === 'Enter') { event.preventDefault(); const item = items[active]; if (item && !item.disabled) onPick(item); }
    else if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); onClose(true); }
  };
  const option = (item, index) => h('div', { key: item.key, id: 'rt-add-opt-' + index, role: 'option', 'aria-selected': index === active, 'aria-disabled': item.disabled || undefined,
    className: 'rt-ch-row' + (index === active ? ' active' : '') + (item.disabled ? ' disabled' : ''),
    onPointerMove: () => !item.disabled && setActive(index), onClick: () => !item.disabled && onPick(item) },
    h('span', { className: 'rt-ch-ic ' + (item.tone || '') }, h(Glyph, { name: item.icon, size: 15 })),
    h('span', { className: 'rt-ch-t' }, item.label),
    item.meta && h('span', { className: 'rt-ch-d' }, item.meta));
  return createPortal(h('div', { ref, className: 'rt-add-menu', role: 'dialog', 'aria-label': label, onKeyDown,
    style: pos ? { left: pos.left, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight } : { visibility: 'hidden' } },
    // Where the pick lands, stated before choosing it.
    dest && h('div', { className: 'rt-add-dest' }, dest),
    h('div', { className: 'rt-add-search' },
      h(Icon, { name: 'search', size: 14 }),
      h('input', { ref: input, value: query, onChange: (event) => setQuery(event.target.value), placeholder: 'Path name or step', 'aria-label': 'Find a path or step',
        role: 'combobox', 'aria-expanded': true, 'aria-controls': 'rt-add-list', 'aria-activedescendant': items[active] ? 'rt-add-opt-' + active : undefined, spellCheck: false, autoComplete: 'off' })),
    items.length
      ? h('div', { id: 'rt-add-list', className: 'rt-add-list', role: 'listbox', 'aria-label': 'Paths and steps' },
          pathItems.length > 0 && h('div', { className: 'rt-ch-sec', role: 'presentation' }, 'Paths'),
          pathItems.map((item, index) => option(item, index)),
          stepItems.length > 0 && h('div', { className: 'rt-ch-sec', role: 'presentation' }, 'Steps'),
          stepItems.map((item, index) => option(item, pathItems.length + index)))
      : h('div', { className: 'rt-add-none' }, 'No path or step matches “' + query + '”')), document.body);
}

/** Step actions, in the app's context-menu shape. Unavailable actions say why in one line. */
function RowMenu({ anchor, items, onClose }) {
  const ref = useRef(null);
  const pos = usePlacement(anchor, ref, 248, 'end');
  const placed = Boolean(pos);
  useEffect(() => { if (placed) ref.current?.querySelector('button:not(:disabled)')?.focus(); }, [placed]);
  useOutside(ref, anchor, onClose);
  const onKeyDown = (event) => {
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); onClose(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...ref.current.querySelectorAll('button:not(:disabled)')], index = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };
  return createPortal(h('div', { ref, className: 'ctxmenu rt-row-menu', role: 'menu', 'aria-label': 'Step actions', onKeyDown,
    style: pos ? { left: pos.left, top: pos.top, bottom: pos.bottom, width: 248 } : { visibility: 'hidden' } },
    items.map((item) => h('button', { key: item.key, type: 'button', role: 'menuitem', tabIndex: -1, disabled: item.disabled, title: item.reason,
      className: 'ctxmenu-i' + (item.danger ? ' danger' : ''), ...(item.key === 'delete' ? deletionInput(() => { onClose(false); item.run(); }) : { onClick: () => { onClose(false); item.run(); } }) },
      h('span', { className: 'rt-menu-label' }, item.label, item.reason && h('small', null, item.reason)), item.hint && h('span', { className: 'ctxmenu-k' }, item.hint)))), document.body);
}

function Grip({ onPointerDown }) {
  return h('button', { className: 'rt-grip', type: 'button', tabIndex: -1, title: 'Drag to move', 'aria-label': 'Drag step to move', onPointerDown, onClick: (e) => e.stopPropagation() }, h(Icon, { name: 'drag', size: 13 }));
}

export function RoutinePanel(props) {
  const { routine, run, paths, selId, onSelect, acq, time, running, catalog } = props;
  const issues = props.issues || [];
  const [note, setNote] = useState('');
  const noteTimer = useRef(0);
  const report = (text) => { setNote(text); clearTimeout(noteTimer.current); noteTimer.current = setTimeout(() => setNote(''), 6000); };
  useEffect(() => () => clearTimeout(noteTimer.current), []);
  const edit = (operation) => {
    const result = operation ? acq.edit(operation) : { changed: false };
    if (result.changed) setNote('');
    else if (result.reason) report(result.reason);
    return result;
  };
  const dnd = useDnd(routine, edit, report);
  const [localCollapsed, setLocalCollapsed] = useState(() => new Set());
  const collapsed = props.collapsedIds ? new Set(props.collapsedIds) : localCollapsed;
  const toggleCollapse = (id) => {
    const next = new Set(collapsed); next.has(id) ? next.delete(id) : next.add(id);
    if (props.onCollapsedIdsChange) props.onCollapsedIdsChange([...next]); else setLocalCollapsed(next);
  };
  const [add, setAdd] = useState(null); // { where, anchor, label }
  const [menu, setMenu] = useState(null); // { id, anchor }
  const [range, setRange] = useState([]); // contiguous sibling IDs, anchored at the selected step
  const [keyboard, setKeyboard] = useState(false);
  // One Tab stop for the whole sheet (rows, route rows, Add rows); arrows move within it. It follows focus.
  const [tabStop, setTabStop] = useState(null);
  const scrollRef = useRef(null);
  const stop = (key) => (key === tabStop ? 0 : -1);
  useLayoutEffect(() => {
    const root = scrollRef.current; if (!root || root.querySelector('[data-nav][tabindex="0"]')) return;
    const preferred = selId && [...root.querySelectorAll('.rt-step')].find((row) => row.dataset.id === selId)?.querySelector('[data-nav]');
    const first = preferred || root.querySelector('[data-nav]');
    if (first?.dataset.nav) setTabStop(first.dataset.nav);
  });
  // Menus and ranges belong to this routine only; a source change drops a range that no longer matches.
  useEffect(() => { setAdd(null); setMenu(null); setRange([]); setNote(''); }, [routine.id]);
  useEffect(() => { if (range.length && range.some((id) => !A.locate(routine, id))) setRange([]); }, [routine, range]);
  useEffect(() => { if (!selId && range.length) setRange([]); }, [selId]); // eslint-disable-line react-hooks/exhaustive-deps

  const outcomes = acq.outcomes || {};
  const activeIdx = run.steps.length && (running || time > 0) ? A.stepAt(run, time) : -1;
  const activeStep = activeIdx >= 0 ? run.steps[activeIdx] : null;
  const activeId = running && activeStep && activeStep.kind !== 'repeat' ? activeStep.nodeId : null;
  const passOf = (repeatId) => run.steps.find((step) => step.kind === 'repeat' && step.nodeId === repeatId)?.passes;
  const activePass = activeStep?.passStack?.at(-1);
  const topIndex = new Map(routine.nodes.map((node, index) => [node.id, index + 1]));
  const segByNode = new Map(); run.segs.forEach((seg) => { if (!segByNode.has(seg.nodeId)) segByNode.set(seg.nodeId, seg); });
  const previewed = new Set(run.steps.map((step) => step.nodeId));
  // Timed occurrences per step on the routine's time axis; a repeat's body shows one bar per previewed pass.
  const spans = new Map();
  run.steps.forEach((step) => { if (run.total > 0 && step.t1 > step.t0 && step.kind !== 'repeat') spans.set(step.nodeId, [...(spans.get(step.nodeId) || []), step]); });
  const pct = (t) => (100 * t / run.total) + '%';
  // Local readiness (AUTO.analyze) and the chosen trace's reference jumps (run.issues) stay distinct facts.
  const jumpByNode = new Map();
  (run.issues || []).forEach((issue) => { if (issue.code === 'reference-discontinuity' && !jumpByNode.has(issue.nodeId)) jumpByNode.set(issue.nodeId, issue); });
  const issueByNode = new Map();
  issues.forEach((issue) => { const prior = issueByNode.get(issue.nodeId); if (!prior || (prior.severity !== 'error' && issue.severity === 'error')) issueByNode.set(issue.nodeId, issue); });

  const focusStep = (id) => requestAnimationFrame(() => requestAnimationFrame(() => {
    [...document.querySelectorAll('.rt-panel .rt-step')].find((row) => row.dataset.id === id)?.querySelector('.rt-step-body')?.focus();
  }));
  const run_ = (operation) => { const result = edit(operation); if (result.changed && result.focusId) focusStep(result.focusId); return result; };

  // ---- Add ----
  const stepItems = (where) => addMenuSteps(routine, where, catalog);
  const openAdd = (where, anchor, label) => { setMenu(null); setAdd({ where, anchor, label }); };
  const closeAdd = (refocus) => { const anchor = add?.anchor; setAdd(null); if (refocus && anchor?.isConnected) anchor.focus(); };
  const destination = (where) => {
    if (where.afterId) { const at = A.locate(routine, where.afterId); return at ? 'After “' + stepTitle(at.node, paths, catalog) + '”' : ''; }
    const ref = where.list;
    if (ref.kind === 'root') return routine.nodes.length ? 'At the end of the routine' : 'First step of the routine';
    const owner = A.locate(routine, ref.nodeId)?.node; if (!owner) return '';
    if (ref.kind === 'repeat') return 'At the end of “' + stepTitle(owner, paths, catalog) + '”';
    return 'At the end of route “' + (A.childLists(owner).find((list) => refKey(list.ref) === refKey(ref))?.label || '') + '”';
  };
  const nodeFor = (item) => {
    if (item.kind === 'path') return A.newNode('path', null, item.ref);
    if (item.kind === 'command') return A.newNode('function', 'command');
    if (item.kind === 'wait') return A.newNode('builtin', 'wait');
    if (item.kind === 'decision') return A.newNode('decision');
    if (item.kind === 'repeat') return A.newNode('repeat');
    if (item.kind === 'end') return A.newNode('end', 'routine');
    if (item.kind === 'exit') return A.newNode('end', 'repeat');
    if (item.kind === 'commandBranch') return { ...A.newNode('function', 'command'), title: item.command.label,
      invocation: { commandId: item.command.id, arguments: commandArguments(item.command) }, outputBranch: A.newOutputBranch(item.output) };
    return null;
  };
  const pick = (item) => {
    const where = add.where;
    setAdd(null);
    const result = run_(insertOperation(routine, where, nodeFor(item)));
    if (!result.changed) add?.anchor?.focus();
  };

  // ---- row actions: each is a checked model operation; an unavailable one names its reason ----
  const rowItems = (id) => {
    const at = A.locate(routine, id); if (!at) return [];
    const body = [...document.querySelectorAll('.rt-panel .rt-step')].find((el) => el.dataset.id === id)?.querySelector('.rt-step-body');
    const option = (key, label, operation, hint) => {
      const check = operation ? A.checkEdit(routine, operation) : { allowed: false };
      return { key, label, hint, disabled: !check.allowed, reason: check.allowed ? '' : check.reason, run: () => { const result = run_(operation); if (key === 'wrapRange' && result.changed) setRange([]); } };
    };
    const up = nudgeOperation(routine, id, -1), down = nudgeOperation(routine, id, 1);
    const ranged = range.length > 1 && range.includes(id);
    return [
      // A keyboard-reachable range action beside the row itself, not only in the range bar above the sheet.
      ...(ranged ? [option('wrapRange', 'Repeat these ' + range.length + ' steps', { kind: 'wrapRepeat', nodeIds: range })] : []),
      { key: 'add', label: 'Add step after', hint: 'A', run: () => openAdd({ afterId: id }, body, 'Add a step after this one') },
      option('wrap', 'Repeat this step', { kind: 'wrapRepeat', nodeIds: [id] }),
      ...(at.node.type === 'repeat' ? [option('unwrap', 'Remove repeat, keep steps', { kind: 'unwrapRepeat', nodeId: id })] : []),
      ...(up ? [option('up', at.index > 0 ? 'Move up' : 'Move out, above', up, '⌥↑')] : []),
      ...(down ? [option('down', at.index < at.siblings.length - 1 ? 'Move down' : 'Move out, below', down, '⌥↓')] : []),
      // A cancelled delete returns focus to the row that opened the menu.
      { key: 'delete', label: 'Delete', hint: '⌫', danger: true, run: () => acq.del(id) },
    ];
  };

  // ---- range: Shift extends over eligible siblings of the selected step ----
  const extendTo = (id) => {
    const anchor = A.locate(routine, selId), target = A.locate(routine, id);
    if (!anchor || !target || anchor.siblings !== target.siblings) { setRange([]); onSelect(id); return; }
    const [low, high] = [Math.min(anchor.index, target.index), Math.max(anchor.index, target.index)];
    setRange(anchor.siblings.slice(low, high + 1).map((node) => node.id));
  };
  const wrapRange = () => { const result = run_({ kind: 'wrapRepeat', nodeIds: range }); if (result.changed) setRange([]); };

  const onBodyKeyDown = (node) => (event) => {
    // Generated-fallback steps are read-only: navigation and selection only.
    const readOnly = Boolean(A.locate(routine, node.id)?.readOnly);
    if (readOnly) {
      const editing = event.altKey || (event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) || ['Delete', 'Backspace', 'a', 'A'].includes(event.key);
      if (editing && !event.metaKey && !event.ctrlKey) { event.preventDefault(); return; }
    }
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      const operation = nudgeOperation(routine, node.id, event.key === 'ArrowUp' ? -1 : 1);
      if (operation) { const result = edit(operation); if (result.changed) focusStep(node.id); }
      return;
    }
    // The context-menu keys open this row's actions (including the range action) from the keyboard.
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      const more = event.currentTarget.closest('.rt-step')?.querySelector('.rt-more');
      if (more) { event.preventDefault(); event.stopPropagation(); if (!event.repeat && !event.nativeEvent?.isComposing && !event.isComposing && event.keyCode !== 229 && acq.preflight?.() !== false) { setAdd(null); setMenu({ id: node.id, anchor: more }); } }
      return;
    }
    if (event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && selId) {
      event.preventDefault();
      const next = moveFocus(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1);
      const id = next?.closest('.rt-step')?.dataset.id;
      if (id) extendTo(id);
      return;
    }
    if (navKeys(event)) return;
    const kids = A.childLists(node);
    if (event.key === 'ArrowLeft' && kids.length && !collapsed.has(node.id)) { event.preventDefault(); toggleCollapse(node.id); return; }
    if (event.key === 'ArrowRight' && kids.length && collapsed.has(node.id)) { event.preventDefault(); toggleCollapse(node.id); return; }
    // Space selects this row; it never reaches page-level playback.
    if (event.key === ' ') { event.stopPropagation(); return; }
    if ((event.key === 'Delete' || event.key === 'Backspace') && !event.metaKey && !event.ctrlKey) { event.preventDefault(); event.stopPropagation(); if (!event.repeat && !event.isComposing && !event.nativeEvent?.isComposing && event.keyCode !== 229) acq.del(node.id); return; }
    if (event.key === 'Escape' && (selId || range.length)) { event.preventDefault(); event.stopPropagation(); setRange([]); onSelect(null); return; }
    if ((event.key === 'a' || event.key === 'A') && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault(); openAdd({ afterId: node.id }, event.currentTarget, 'Add a step after this one');
    }
  };

  // ---- rows ----
  // Authored flow outcomes, cached per render by child list. They never depend on the chosen preview route.
  const flowCache = new WeakMap();
  function describe(node, seg, offPreview, exitTo) {
    const issue = issueByNode.get(node.id);
    const deployment = A.nodeDeploymentState(node, catalog);
    // Legacy generation may carry a saved reference path; preserve that existing preview without claiming live generation.
    if (deployment.legacy) return { meta: 'Legacy ' + deployment.label.toLowerCase() + ' step · '
      + (node.cat === 'generate' && node.preview ? 'preview plays its saved reference path' : 'ignored by the preview'), problem: 'warn' };
    if (issue?.severity === 'error') return { meta: issue.message, problem: 'bad', dur: durationOf(node, seg) };
    if (issue?.code === 'unreachable') return { meta: issue.message, problem: 'muted', dur: durationOf(node, seg) };
    // A saved runtime-generation definition: no desktop generation, no supported delivery.
    if (node.type === 'generatedTrajectory') return { meta: 'Unsupported saved definition · Bordeaux cannot generate or preview it', problem: 'warn' };
    const jump = jumpByNode.get(node.id);
    const warning = jump ? { meta: continuityText(jump), problem: 'warn' } : issue ? { meta: issue.message, problem: 'warn' } : null;
    if (node.type === 'path') {
      if (!paths.some((path) => path.id === node.ref)) return { meta: node.ref ? 'The referenced path is unavailable.' : 'Choose a path', problem: 'bad' };
      if (seg) return warning ? { ...warning, dur: fmt(seg.t1 - seg.t0) } : { meta: UnitPrefs.format(seg.deriv.sample.length, 'm', 2), dur: fmt(seg.t1 - seg.t0) };
      if (offPreview) return { meta: 'Skipped in this preview' };
      if (run.planningStatus === 'pending' || run.planningStatus === 'idle') return { meta: 'Preparing preview…' };
      if (run.planningStatus === 'error' || run.stopReason === 'invalid') return { meta: 'Preview unavailable' };
      if (!previewed.has(node.id)) return { meta: run.truncated ? 'Beyond the previewed steps' : 'Not reached in this preview' };
      return { meta: 'No trajectory available' };
    }
    if (warning) return { ...warning, dur: durationOf(node, seg) };
    if (node.type === 'builtin') return { meta: endsPhrase(node, routine, catalog), dur: durationOf(node) };
    if (node.type === 'decision') return { meta: 'Checked once when reached' };
    if (node.type === 'repeat') return { meta: node.until ? 'Until ' + describeStop(node.until, routine, catalog) + ' · checked after each pass' : 'Same steps every pass', dur: durationOf(node) };
    if (node.type === 'end') {
      if (node.scope === 'routine') return { meta: 'Ends the routine here; later steps never run' };
      return { meta: exitTo ? plainText(['Leaves the repeat and ', ...continuePhrase(exitTo, paths, catalog, false)]) : 'Leaves the repeat' };
    }
    if (node.type === 'function' && node.cat === 'command') {
      const command = catalog?.commands?.find((item) => item.id === node.invocation?.commandId);
      const output = node.outputBranch && A.branchOutputs(command).find((item) => item.name === node.outputBranch.output);
      return { meta: (node.outputBranch ? 'Then branch on ' + (output?.label || node.outputBranch.output) + ' · ' : '') + endsPhrase(node, routine, catalog), dur: durationOf(node) };
    }
    return { meta: 'Unsupported step · ignored by the preview', problem: 'warn' };
  }
  function durationOf(node, seg) {
    if (node.type === 'path') return seg ? fmt(seg.t1 - seg.t0) : '';
    if (node.type === 'builtin') return (node.ends?.endWhen ? '≤ ' : '') + fmt(node.arguments?.durationS);
    if (node.type === 'function' && node.cat === 'command') return node.ends?.timeoutS !== undefined ? '≤ ' + fmt(node.ends.timeoutS) : 'Untimed';
    if (node.type === 'repeat') return (node.until ? '≤ ' : '') + node.times + '×';
    return '';
  }

  function stepRow(node, ctx, numbered) {
    const { depth, offPreview, readOnly } = ctx;
    const sel = selId === node.id || range.includes(node.id);
    const active = activeId === node.id;
    const seg = segByNode.get(node.id);
    const kids = A.childLists(node);
    const isCollapsed = kids.length > 0 && collapsed.has(node.id);
    const info = describe(node, seg, offPreview, ctx.exitTo);
    const kind = node.type === 'path' ? 'path' : node.type === 'decision' ? 'decision' : node.type === 'builtin' ? 'wait' : node.type === 'function' && node.cat === 'command' ? 'cmd' : 'control';
    const mark = dnd.drag?.target?.mark;
    const markHere = mark?.rowId === node.id;
    const chosen = isBranch(node) ? A.selectedBranch(node, outcomes) : null;
    const nestedCount = isCollapsed ? kids.reduce((count, list) => count + A.branchCount(list.nodes), 0) : 0;
    const title = stepTitle(node, paths, catalog);
    const live = active && activePass ? 'Pass ' + activePass.pass + ' of ' + (passOf(activePass.repeatId) || '?') : active ? 'Now' : null;
    return h('div', { key: node.id, 'data-id': node.id, style: { '--depth': depth },
      className: 'rt-step ' + kind + (sel ? ' sel' : '') + (active ? ' active' : '') + (offPreview ? ' off' : '') + (info.problem === 'muted' ? ' unreachable' : '')
        + (dnd.drag?.id === node.id ? ' dragging' : '') + (markHere ? (mark.before ? ' drop-before' : ' drop-after') + (dnd.drag.target.allowed ? '' : ' drop-invalid') : '') },
      readOnly ? h('span', { className: 'rt-grip-space' }) : h(Grip, { onPointerDown: (e) => dnd.start(node.id, e) }),
      h('span', { className: 'rt-step-num', 'aria-hidden': true }, numbered ? topIndex.get(node.id) : ''),
      kids.length
        ? h('button', { className: 'rt-collapse' + (isCollapsed ? ' on' : ''), type: 'button', tabIndex: -1, 'aria-expanded': !isCollapsed,
            'aria-label': (isCollapsed ? 'Expand ' : 'Collapse ') + title, onClick: () => toggleCollapse(node.id) },
            h('span', { className: 'rt-collapse-kind' }, h(Glyph, { name: glyphFor(node) })), h('span', { className: 'rt-collapse-chev' }, h(Icon, { name: 'chevron', size: 14 })))
        : h('span', { className: 'rt-step-ic' }, h(Glyph, { name: glyphFor(node) })),
      h('button', { className: 'rt-step-body', type: 'button', 'data-nav': 'row:' + node.id, tabIndex: stop('row:' + node.id), 'aria-pressed': sel, 'aria-keyshortcuts': readOnly ? undefined : 'Shift+F10 A Delete Alt+ArrowUp Alt+ArrowDown', 'aria-expanded': kids.length ? !isCollapsed : undefined,
        onClick: (event) => { if (event.shiftKey && selId && !readOnly) { extendTo(node.id); return; } setRange([]); onSelect(sel && selId === node.id ? null : node.id); },
        onKeyDown: onBodyKeyDown(node), title: isCollapsed ? undefined : info.meta },
        h('span', { className: 'rt-step-title' }, title),
        // A warning is a mark beside the name; its sentence is the tooltip and stays in the accessible name.
        info.problem === 'warn' && h('span', { className: 'rt-step-flag', 'aria-hidden': true }),
        h('span', { className: 'rt-step-meta' + (info.problem ? ' ' + info.problem : '') },
          isCollapsed ? plural(nestedCount, 'step') + ' inside' + (chosen ? ' · previewing ' + (kids.find((list) => routeIdOf(list.ref) === chosen.id)?.label || chosen.label) : '') : info.meta)),
      h('span', { className: 'rt-step-time', 'aria-hidden': true }, (spans.get(node.id) || []).map((step) => h('i', { key: step.occurrenceId || step.t0,
        className: step.kind + (step.timing === 'upperBound' ? ' upper' : ''), style: { left: pct(step.t0), width: pct(step.t1 - step.t0) } }))),
      h('span', { className: 'rt-step-dur' + (info.dur === 'Untimed' ? ' unknown' : '') }, live ? h('span', { className: 'rt-step-live' }, live) : (info.dur || '')),
      h('span', { className: 'rt-step-tools' }, !readOnly && h('button', { className: 'rt-tool rt-more', type: 'button', tabIndex: -1, 'aria-haspopup': 'menu', 'aria-expanded': menu?.id === node.id, title: 'Step actions (⇧F10)',
        'aria-label': 'Actions for ' + title, ...deletionInput((e) => { if (acq.preflight?.() === false) return; setAdd(null); setMenu({ id: node.id, anchor: e.currentTarget }); }) }, h(Glyph, { name: 'more', size: 15 }))));
  }

  function addRow(ref, depth, ariaLabel, empty) {
    const where = { list: ref };
    const open = add && add.where.list && refKey(add.where.list) === refKey(ref);
    const mark = dnd.drag?.target?.mark;
    const markHere = mark?.list === refKey(ref) && mark.edge === 'end';
    return h('div', { key: 'add:' + refKey(ref), className: 'rt-addwrap' + (empty ? ' empty' : '') + (markHere ? ' drop-before' + (dnd.drag.target.allowed ? '' : ' drop-invalid') : ''), 'data-list': refKey(ref), style: { '--depth': depth } },
      h('button', { className: 'rt-add' + (open ? ' on' : ''), type: 'button', 'data-nav': 'add:' + refKey(ref), tabIndex: stop('add:' + refKey(ref)), 'aria-haspopup': 'dialog', 'aria-expanded': Boolean(open), 'aria-label': ariaLabel,
        onClick: (e) => (open ? closeAdd(false) : openAdd(where, e.currentTarget, ariaLabel)), onKeyDown: navKeys },
        h(Icon, { name: 'plus', size: 14 }), 'Add step'));
  }

  /** A group's closing row: a glyph for what happens next and the authored fact in words. */
  function closingRow(depth, closing) {
    return h('div', { key: 'close', className: 'rt-close' + (closing.terminal ? ' terminal' : '') + (closing.quiet ? ' quiet' : ''), style: { '--depth': depth } },
      h('span', { className: 'rt-close-ic', 'aria-hidden': true }, h(Glyph, { name: closing.glyph, size: 13 })),
      h('span', { className: 'rt-close-t' }, closing.parts.map((part, index) => (typeof part === 'string' ? part : h('span', { key: index, className: 'rt-close-name' }, part.name)))));
  }

  // ctx: { depth, offPreview, readOnly, after, exitTo }. `after` is what this list reaches when it completes;
  // `exitTo` is what the nearest enclosing repeat reaches when an Exit leaves it.
  function renderList(nodes, ref, ctx, addLabel) {
    const out = nodes.map((node, index) => renderNode(node, { ...ctx, after: index + 1 < nodes.length ? { kind: 'step', node: nodes[index + 1] } : ctx.after }, ref.kind === 'root'));
    if (!ctx.readOnly) out.push(addRow(ref, ctx.depth, addLabel, !nodes.length));
    return out;
  }

  function renderNode(node, ctx, numbered) {
    const { depth, offPreview, readOnly } = ctx;
    const kids = A.childLists(node);
    const open = kids.length > 0 && !collapsed.has(node.id);
    const row = stepRow(node, ctx, numbered);
    if (!open) return h('div', { key: node.id, className: 'rt-step-wrap' }, row);
    const body = [];
    if (node.type === 'repeat') {
      body.push(...renderList(kids[0].nodes, kids[0].ref, { depth: depth + 1, offPreview, readOnly, after: { kind: 'pass' }, exitTo: ctx.after }, 'Add step to this repeat'));
      body.push(closingRow(depth + 1, repeatClosing(node, routine, catalog, flowCache, offPreview ? undefined : passOf(node.id))));
    } else {
      const chosen = isBranch(node) ? A.selectedBranch(node, outcomes) : null;
      kids.forEach((list) => {
        const fixed = readOnly || list.readOnly;
        const routeId = routeIdOf(list.ref), live = list.ref.kind === 'fallback' ? false : chosen && chosen.id === routeId, count = A.branchCount(list.nodes);
        const flow = A.flowSummary(list.nodes, flowCache);
        const outcome = flow.normal ? (count ? '' : 'continues') : flow.endRoutine && flow.exitRepeat ? 'ends routine or leaves repeat' : flow.exitRepeat ? 'leaves repeat' : 'ends routine';
        const mark = dnd.drag?.target?.mark, markHere = mark?.list === refKey(list.ref) && mark.edge === 'start';
        body.push(h('div', { key: refKey(list.ref), className: 'rt-branch' + (live ? ' live' : '') + (offPreview ? ' off' : ''), role: 'group', 'aria-label': 'Route ' + list.label },
          h('div', { className: 'rt-route' + (markHere ? ' drop-after' + (dnd.drag.target.allowed ? '' : ' drop-invalid') : ''), 'data-list': fixed ? undefined : refKey(list.ref), style: { '--depth': depth + 1 } },
            list.ref.kind === 'fallback'
              ? h('span', { className: 'rt-brlbl static' }, h('span', { className: 'rt-brname' }, 'Saved fallback'), h('span', { className: 'rt-brkey' }, 'read-only'), h('span', { className: 'rt-brcount' }, plural(count, 'step')))
              : h('button', { className: 'rt-brlbl', type: 'button', 'data-nav': 'route:' + refKey(list.ref), tabIndex: stop('route:' + refKey(list.ref)), role: 'radio', 'aria-checked': Boolean(live), 'aria-label': 'Preview route ' + list.label,
                  title: 'Preview this route', onClick: () => acq.setOutcome(node.id, routeId), onKeyDown: navKeys },
                  h('span', { className: 'rt-brname' }, list.label),
                  h('span', { className: 'rt-brkey' }, routeRule(node, list)),
                  h('span', { className: 'rt-brcount' }, [live && 'Previewing', count ? plural(count, 'step') : 'Empty', outcome].filter(Boolean).join(' · ')))),
          renderList(list.nodes, list.ref, { depth: depth + 2, offPreview: offPreview || !live, readOnly: fixed, after: ctx.after, exitTo: ctx.exitTo }, 'Add step to the ' + list.label + ' route')));
      });
      body.push(closingRow(depth + 1, node.type === 'generatedTrajectory' ? { glyph: 'join', parts: ['End of the saved fallback'] } : branchClosing(kids, ctx.after, paths, catalog, flowCache)));
    }
    return h('div', { key: node.id, className: 'rt-step-wrap rt-group ' + (node.type === 'repeat' ? 'repeat' : 'branch') }, row, h('div', { className: 'rt-block', role: 'group', 'aria-label': 'Inside ' + stepTitle(node, paths, catalog) }, body));
  }

  return h('div', { className: 'rt-panel' + (dnd.drag ? ' dragging' : ''), 'data-input': keyboard ? 'keyboard' : 'pointer',
    // Arrow keys move focus by script, which withholds :focus-visible after a click; track the input instead.
    onKeyDownCapture: (e) => { if (!keyboard && !e.metaKey && !e.ctrlKey) setKeyboard(true); }, onPointerDownCapture: () => keyboard && setKeyboard(false) },
    range.length > 1 && h('div', { className: 'rt-range-bar', role: 'toolbar', 'aria-label': 'Selected steps' },
      h('span', null, plural(range.length, 'step') + ' selected'),
      h('button', { type: 'button', className: 'qbtn', onClick: wrapRange }, h(Glyph, { name: 'repeat', size: 14 }), 'Repeat these steps'),
      h('button', { type: 'button', className: 'qbtn quiet', onClick: () => { setRange([]); focusStep(selId); } }, 'Clear')),
    h('div', { className: 'rt-scroll', ref: scrollRef, onFocusCapture: (e) => { const key = e.target.dataset?.nav; if (key && key !== tabStop) setTabStop(key); } },
      routine.nodes.length === 0
        ? h('div', { className: 'rt-empty' },
            h('div', { className: 'rt-empty-t' }, 'No steps yet'),
            h('p', null, paths.length
              ? 'Steps run top to bottom. Start with the path the robot drives first, then add waits, commands, branches and repeats where the plan needs them.'
              : 'This project has no paths yet. Create one in Paths, then add it here.'),
            h('button', { className: 'qbtn primary rt-add rt-empty-add', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': Boolean(add),
              onClick: (e) => openAdd({ list: { kind: 'root' } }, e.currentTarget, 'Add the first step') }, h(Icon, { name: 'plus', size: 14 }), 'Add first step'),
            !catalog && h('p', { className: 'rt-empty-note' }, 'Commands and robot conditions come from linked robot code.'))
        : h('div', { className: 'rt-list' + (running && run.total > 0 ? ' playing' : ''), role: 'list', 'aria-label': 'Routine run order', style: { '--p': run.total > 0 ? Math.min(1, time / run.total) : 0 } },
            renderList(routine.nodes, { kind: 'root' }, { depth: 0, offPreview: false, readOnly: false, after: { kind: 'end' }, exitTo: null }, 'Add step at the end'))),
    h('div', { className: 'rt-flow-note', role: 'status', 'aria-live': 'polite' }, note),
    add && h(AddMenu, { anchor: add.anchor, paths, steps: stepItems(add.where), label: add.label, dest: destination(add.where), onPick: pick, onClose: closeAdd }),
    menu && h(RowMenu, { anchor: menu.anchor, items: rowItems(menu.id), onClose: (refocus) => { const anchor = menu.anchor; setMenu(null); if (refocus) anchor?.closest('.rt-step')?.querySelector('.rt-step-body')?.focus(); } }));
}
