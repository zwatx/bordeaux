import { deletionInput, shiftDeletionInput } from './DeletionNotice';
import * as React from "react";
import { createPortal } from "react-dom";
import { PointerDrag } from "../hooks/usePointerDrag";
import { AUTO } from "../lib/routineModel";
import { UnitPrefs } from "../lib/unitPreferences";
import { commandArguments } from "./ContextInspector";
import { UI } from "./ui";
import { Glyph } from "./routineGlyphs";
import { routinePathUses } from '../lib/routinePathChoices';
import { commandEntry, commandUsage } from '../lib/commandIndex';
import { InsertStrip, SourceLibrary, initialSource } from './RoutineInsert';

// Routine run sheet: a summary line (RoutineSummary), then one flat line per step in run order with its number, glyph,
// name, quiet meta and preview time. Repeats, groups and branches indent their steps under thin guides; a branch's
// routes are header lines, whose name opens that route's editor in the inspector and whose radio chooses the preview
// route. A closing line states what authored control flow does next (shown when it is not obvious from the group
// ending); those facts come from AUTO.flowSummary, never from the chosen preview route.
// Explanations live in tooltips and the inspector. Selecting a row only changes the right inspector.
const { useState, useRef, useEffect, useLayoutEffect, useMemo } = React;
const h = React.createElement;
const { Icon } = UI;
const A = AUTO;
const fmt = (t) => UnitPrefs.format(t || 0, 's', 2);
const plural = (count, singular) => count + ' ' + singular + (count === 1 ? '' : /s$/.test(singular) ? 'es' : 's');

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
  if (node.type === 'repeat') return node.times === undefined ? 'Repeat until command result' : node.until ? 'Repeat up to ' + node.times + ' times' : 'Repeat ' + plural(node.times, 'time');
  return A.nodeTitle(node, paths, catalog);
}

/** How a command or wait ends, in one line. */
export function endsPhrase(node, routine, catalog) {
  const ends = node.ends || {};
  if (node.type === 'function' && node.invocation?.loop) {
    const command = catalog?.commands?.find((item) => item.id === node.invocation.commandId);
    return 'Starts again each time it finishes, ' + A.loopSummary(node.invocation.loop, command);
  }
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
  const passes = node.times === undefined ? 'no fixed pass limit' : (node.until ? 'up to ' : '') + plural(node.times, 'pass');
  const conditionMissing = node.until?.source === 'condition' && !A.authoritativeConditions(catalog).some(item => item.value === node.until.conditionId);
  const stopName = conditionMissing ? 'the saved condition (unavailable)' : node.until && describeStop(node.until, routine, catalog);
  const previewing = node.until && previewPasses !== undefined ? ' · previewing ' + previewPasses : '';
  return { glyph: 'loop', parts: ['Back to the top', ...(node.until ? [' until ', { name: stopName }] : []), ' · ' + passes + previewing] };
}

/** Closing row of a group: a parallel group waits for every step; a sequence reads as its own steps, so it stays quiet. */
export function groupClosing(node, after, paths, catalog) {
  const next = continuePhrase(after, paths, catalog, false);
  if (node.mode === 'sequential') return { glyph: 'join', quiet: true, parts: ['After its last step, ', ...next] };
  const count = node.nodes.length;
  return { glyph: 'join', parts: [count > 1 ? 'Waits for all ' + count + ' to finish, then ' : count ? 'Waits for it to finish, then ' : 'No steps yet, so it ', ...next] };
}

function stepKind(node) {
  return node.type === 'path' ? 'path' : node.type === 'decision' ? 'decision' : node.type === 'builtin' ? 'wait' : node.type === 'function' && node.cat === 'command' ? 'cmd' : node.type === 'group' ? 'grp' : 'control';
}
function glyphFor(node) {
  if (node.type === 'path' || node.type === 'generatedTrajectory') return 'route';
  if (node.type === 'builtin') return 'pause';
  if (node.type === 'decision' || node.outputBranch) return 'branch';
  if (node.type === 'repeat') return 'repeat';
  if (node.type === 'group') return node.mode === 'sequential' ? 'sequential' : 'parallel';
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
/** True when an Add lands directly inside a group, where only commands, waits and groups may go. */
function insideGroup(routine, where) {
  const anchorId = where.afterId || where.beforeId;
  if (anchorId) return A.locate(routine, anchorId)?.parent?.type === 'group';
  return where.list?.kind === 'group';
}
/**
 * For an Add inside a group, the path step a team most likely means when it wants commands to run while driving:
 * the step just before the outermost group, else the one just after it. Null when neither is an available path.
 */
function pathBesideGroup(routine, where, paths) {
  const anchorId = where.afterId || where.beforeId || where.list?.nodeId;
  const at = anchorId && A.locate(routine, anchorId);
  if (!at) return null;
  const groupId = at.groupIds[0] || (where.list?.kind === 'group' ? anchorId : null);
  const group = groupId && A.locate(routine, groupId);
  if (!group) return null;
  return [group.siblings[group.index - 1], group.siblings[group.index + 1]]
    .find((node) => node?.type === 'path' && paths.some((path) => path.id === node.ref)) || null;
}
function insideRepeat(routine, where) {
  const anchorId = where.afterId || where.beforeId;
  if (anchorId) return Boolean(A.locate(routine, anchorId)?.repeatIds.length);
  if (where.list.kind === 'root') return false;
  if (where.list.kind === 'repeat') return true;
  return Boolean(A.locate(routine, where.list.nodeId)?.repeatIds.length);
}
/** Where an Add lands, as the model's checked insert: after or before a step, or at the end of a list. */
function insertOperation(routine, where, node) {
  if (where.afterId || where.beforeId) {
    const at = A.locate(routine, where.afterId || where.beforeId);
    return at && { kind: 'insert', listRef: at.listRef, index: at.index + (where.afterId ? 1 : 0), node };
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

/** One Add item per catalog command, built once per immutable catalog snapshot (catalogs can hold thousands). */
const commandItemCache = new WeakMap();
function catalogCommandItems(commands) {
  let items = commandItemCache.get(commands);
  if (!items) {
    items = commands.map((command) => {
      const entry = commandEntry(command);
      return { key: 'command:' + command.id, kind: 'command', group: 'commands', command, entry, label: command.label, icon: 'bolt', tone: 'cmd', meta: entry.meta };
    });
    commandItemCache.set(commands, items);
  }
  return items;
}

/**
 * What Add offers in a list besides paths: every linked catalog command (bound in one pick), then the routine's own
 * steps: Wait, Repeat, End routine, and Exit repeat only inside a repeat. Without commands to list, one unbound Command
 * keeps the step authorable offline. Branching is set on a command afterwards, never as a separate Add item.
 * Legacy categories and generated trajectories are never offered.
 */
export function addMenuSteps(routine, where, catalog) {
  const kinds = new Set(A.AUTHORABLE_STEPS.map((step) => step.id));
  const items = [], grouped = insideGroup(routine, where);
  const commands = catalog?.commands || [];
  if (kinds.has('command')) {
    // Without catalog commands, an unbound Command leads the steps: Add still opens on paths and commands first.
    if (commands.length) items.push(...catalogCommandItems(commands));
    else items.push({ key: 'command', kind: 'command', group: 'steps', label: 'Command', icon: 'bolt', tone: 'cmd', meta: catalog ? 'No commands in linked robot code' : 'Link robot code to list commands' });
  }
  // Wait is a native routine instruction; it never depends on linked robot code.
  if (kinds.has('wait')) items.push({ key: 'wait', kind: 'wait', group: 'steps', label: 'Wait', icon: 'pause', tone: 'wait' });
  // A group holds commands, waits and groups only; paths and control flow stay outside it.
  if (kinds.has('repeat') && !grouped) items.push({ key: 'repeat', kind: 'repeat', group: 'steps', label: 'Repeat', icon: 'repeat' });
  if (kinds.has('group')) {
    items.push({ key: 'group:parallel', kind: 'group', mode: 'parallel', group: 'steps', label: 'Parallel group', icon: 'parallel' });
    items.push({ key: 'group:sequential', kind: 'group', mode: 'sequential', group: 'steps', label: 'Sequential group', icon: 'sequential' });
  }
  if (grouped) return items;
  if (kinds.has('end')) items.push({ key: 'end', kind: 'end', group: 'steps', label: 'End routine', icon: 'stop' });
  if (kinds.has('end') && insideRepeat(routine, where)) items.push({ key: 'exit', kind: 'exit', group: 'steps', label: 'Exit repeat', icon: 'exit' });
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

// ---- drag: like the library's card list. The grip lifts the step into a card the size of its row, held where it was
// grabbed. The step's slot closes once it has somewhere else to go and stays closed, so the flow cannot flicker
// between layouts; a matching gap opens where it will land. Near the flow's top or bottom edge the flow scrolls.
// Release drops on the last target (one checked edit, one Undo step); Escape, blur or a cancelled pointer drop
// nothing. The card then settles into its new place, or back home. Feedback and commit share checkEdit. ----
const DRAG_EDGE = 32, SETTLE_MS = 200;
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
/** What a step occupies in the flow: an open group's whole box, otherwise its row. */
function stepElement(root, id) {
  const row = [...(root?.querySelectorAll('.rt-step') || [])].find((element) => element.dataset.id === id);
  return row?.parentElement?.classList.contains('rt-group') ? row.parentElement : row;
}
function useDnd(routine, edit, report, scrollRef) {
  const [drag, setDrag] = useState(null); // { id, box, x, y, target: { operation, mark, allowed, reason } | null, away }
  const settle = useRef(null);
  const pointerDrag = PointerDrag.useController();
  // Another routine or source cancels an active drag without applying it.
  useEffect(() => () => pointerDrag.cancel?.({ flush: false }), [routine.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // After the drop renders, the moved step starts where the card was and eases into its place.
  useLayoutEffect(() => {
    const card = settle.current;
    if (!card || drag) return;
    settle.current = null;
    const element = stepElement(scrollRef.current, card.id);
    if (!element || reducedMotion()) return;
    const box = element.getBoundingClientRect(), dx = card.x - box.left, dy = card.y - box.top;
    if (Math.hypot(dx, dy) < 1) return;
    element.classList.add('settling');
    element.animate([{ transform: 'translate(' + dx + 'px,' + dy + 'px)' }, { transform: 'none' }], { duration: SETTLE_MS, easing: 'cubic-bezier(.2,.8,.2,1)' })
      .finished.catch(() => {}).finally(() => element.classList.remove('settling'));
  });
  // A point inside the flow but on no target (an open gap, a closing row) keeps the previous target, so a gap that
  // moves rows away from the pointer does not close again under it. Outside the flow there is no target.
  const targetAt = (id, x, y, previous) => {
    const el = document.elementFromPoint(x, y);
    if (!el || !scrollRef.current?.querySelector('.rt-list')?.contains(el)) return null;
    // Over its own (hidden) contents a group cannot land; the model names why on release.
    if (stepElement(scrollRef.current, id)?.contains(el)) {
      const node = A.locate(routine, id)?.node, inside = node && A.childLists(node)[0];
      return inside ? { operation: null, mark: null, allowed: false, reason: A.checkEdit(routine, { kind: 'move', nodeId: id, listRef: inside.ref, index: 0 }).reason } : null;
    }
    const row = el.closest('.rt-step'), route = el.closest('.rt-route'), add = el.closest('.rt-addwrap');
    let operation = null, mark = null;
    if (row && row.dataset.id !== id) {
      const at = A.locate(routine, row.dataset.id); if (!at) return null;
      // An open group's header takes a step before the group; its own rows take the rest.
      const r = row.getBoundingClientRect(), before = row.parentElement?.classList.contains('rt-group') || y < r.top + r.height / 2;
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
    if (!operation) return previous;
    const check = A.checkEdit(routine, operation);
    return { operation, mark, allowed: check.allowed, reason: check.reason };
  };
  const start = (id, e) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const row = e.currentTarget.closest('.rt-step'), bounds = row.getBoundingClientRect();
    const icon = row.querySelector('.rt-step-ic, .rt-collapse');
    const box = { width: bounds.width, height: bounds.height, inset: icon ? icon.getBoundingClientRect().left - bounds.left : 36, dx: e.clientX - bounds.left, dy: e.clientY - bounds.top };
    let point = { x: e.clientX, y: e.clientY }, target = null, away = false, frame = 0;
    const show = () => setDrag({ id, box, x: point.x, y: point.y, target, away });
    const locate = () => { target = targetAt(id, point.x, point.y, target); away = away || Boolean(target?.allowed); show(); };
    const home = () => { settle.current = { id, x: point.x - box.dx, y: point.y - box.dy }; };
    const tick = () => {
      frame = 0;
      const list = scrollRef.current; if (!list) return;
      const r = list.getBoundingClientRect();
      const depth = point.y < r.top + DRAG_EDGE ? point.y - r.top - DRAG_EDGE : point.y > r.bottom - DRAG_EDGE ? point.y - r.bottom + DRAG_EDGE : 0;
      if (!depth || point.x < r.left || point.x > r.right) return;
      const before = list.scrollTop;
      list.scrollTop += Math.sign(depth) * Math.min(18, 3 + Math.abs(depth) / 2);
      if (list.scrollTop !== before) { locate(); frame = requestAnimationFrame(tick); }
    };
    const move = (ev) => { point = { x: ev.clientX, y: ev.clientY }; locate(); if (!frame) frame = requestAnimationFrame(tick); };
    // Escape cancels the drag without moving anything.
    const escape = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); pointerDrag.cancel({ flush: false }); } };
    const finish = () => { window.removeEventListener('keydown', escape, true); cancelAnimationFrame(frame); frame = 0; home(); setDrag(null); };
    window.addEventListener('keydown', escape, true);
    const end = () => {
      finish();
      if (!target) return;
      if (!target.allowed) { if (target.reason) report(target.reason); return; }
      const result = edit(target.operation);
      if (!result.changed && result.reason) report(result.reason);
    };
    pointerDrag.start(e, { move, end, cancel: finish });
    show();
  };
  return { drag, start };
}

// ---- the step menu lives in the body: the workspace's container query would otherwise contain fixed positioning ----
function usePlacement(anchor, ref, width, align) {
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    const place = () => {
      if (!anchor?.isConnected || !ref.current) return;
      const r = anchor.getBoundingClientRect(), height = ref.current.offsetHeight;
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
/** A press outside `ref` (and its anchor) closes without moving focus; without `close` nothing is watched. */
function useOutside(ref, anchor, close) {
  useEffect(() => {
    if (!close) return undefined;
    const away = (event) => { if (!ref.current?.contains(event.target) && !anchor?.contains(event.target)) close(false); };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [ref, anchor, close]);
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

const JUMP_SIZES = ['large', 'medium', 'small'];
/**
 * The routine's preview facts in one line above the flow: its total time as the routine library row and the transport
 * show it (AUTO.previewTotalLabel; "Untimed" like the library row when no step has a duration), its pose jumps with the
 * largest one's mark, then what that total does not count (AUTO.durationFacts). Short forms show; the sentences stay
 * for assistive technology and in the tooltip.
 */
export function RoutineSummary({ run }) {
  if (run.blocked) return null;
  const jumps = (run.issues || []).filter((issue) => issue.code === 'reference-discontinuity');
  const timedPlayable = run.timedPlayable !== undefined ? run.timedPlayable : run.total > 0;
  const total = timedPlayable ? A.previewTotalLabel(run) : 'Untimed';
  const facts = [...A.durationFacts(run), run.truncated && ['Preview stops at 2,000 steps', 'Stops at 2,000 steps']].filter(Boolean);
  const duration = run.duration || {};
  const full = facts.map(([sentence]) => sentence).join(' · ');
  const title = [timedPlayable ? 'Preview time ' + total : 'Untimed preview', jumps.length > 0 && plural(jumps.length, 'pose jump'), ...facts.map(([sentence]) => sentence),
    duration.estimateCount > 0 && 'Estimates use command run times from the Robot page. Preview only; the robot does not use them.',
    duration.unknownCount > 0 && 'A command run time on the Robot page estimates an untimed command.'].filter(Boolean).join(String.fromCharCode(10));
  return h('div', { className: 'rt-summary', title },
    h('span', { className: 'rt-summary-total' }, total),
    jumps.length > 0 && h('span', { className: 'rt-summary-jumps' },
      h('span', { className: 'rt-step-flag', 'data-jump': JUMP_SIZES.find((size) => jumps.some((issue) => issue.size === size)), 'aria-hidden': true }), plural(jumps.length, 'pose jump')),
    full && h('span', { className: 'rt-summary-full' }, full),
    facts.map(([, short]) => h('span', { key: short, className: 'rt-summary-short', 'aria-hidden': true }, short)));
}

function Grip({ onPointerDown }) {
  return h('button', { className: 'rt-grip', type: 'button', tabIndex: -1, title: 'Drag to move', 'aria-label': 'Drag step to move', onPointerDown, onClick: (e) => e.stopPropagation() }, h(Icon, { name: 'drag', size: 13 }));
}

export function RoutinePanel(props) {
  const { routine, run, paths, selId, onSelect, acq, time, running, catalog } = props;
  // Command run times on the Robot page give untimed commands a preview estimate.
  const driveModel = props.robot?.driveModel;
  const issues = props.issues || [];
  // How often this routine follows each path, for the path library; recounted only when the authored steps change.
  const pathUses = useMemo(() => routinePathUses(routine), [routine.nodes]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const [localCollapsed, setLocalCollapsed] = useState(() => new Set());
  const collapsed = props.collapsedIds ? new Set(props.collapsedIds) : localCollapsed;
  const toggleCollapse = (id) => {
    const next = new Set(collapsed); next.has(id) ? next.delete(id) : next.add(id);
    if (props.onCollapsedIdsChange) props.onCollapsedIdsChange([...next]); else setLocalCollapsed(next);
  };
  const [add, setAdd] = useState(null); // { where, anchor, navKey, label, added, source, focusSource }
  const [change, setChange] = useState(null); // { nodeId, origin }: the path step whose path is being changed
  const [menu, setMenu] = useState(null); // { id, anchor }
  const [range, setRange] = useState([]); // contiguous sibling IDs, anchored at the selected step
  const [keyboard, setKeyboard] = useState(false);
  // One Tab stop for the whole sheet (rows, route rows, Add rows); arrows move within it. It follows focus.
  const [tabStop, setTabStop] = useState(null);
  const scrollRef = useRef(null);
  const dnd = useDnd(routine, edit, report, scrollRef);
  const stop = (key) => (key === tabStop ? 0 : -1);
  useLayoutEffect(() => {
    const root = scrollRef.current; if (!root || root.querySelector('[data-nav][tabindex="0"]')) return;
    const preferred = selId && [...root.querySelectorAll('.rt-step')].find((row) => row.dataset.id === selId)?.querySelector('[data-nav]');
    const first = preferred || root.querySelector('[data-nav]');
    if (first?.dataset.nav) setTabStop(first.dataset.nav);
  });
  // Menus and ranges belong to this routine only; a source change drops a range that no longer matches.
  useEffect(() => { setAdd(null); setChange(null); setMenu(null); setRange([]); setNote(''); }, [routine.id]);
  useEffect(() => { if (range.length && range.some((id) => !A.locate(routine, id))) setRange([]); }, [routine, range]);
  useEffect(() => { if (!selId && range.length) setRange([]); }, [selId]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Scrolls only the flow so step `id`'s row is in view; a row inside a collapsed group stays put. */
  const revealStep = (id) => {
    const box = scrollRef.current, row = id && box && [...box.querySelectorAll('.rt-step')].find((element) => element.dataset.id === id);
    if (!row) return;
    const inner = row.getBoundingClientRect(), outer = box.getBoundingClientRect();
    if (inner.top < outer.top) box.scrollTop -= outer.top - inner.top + 8;
    else if (inner.bottom > outer.bottom) box.scrollTop += inner.bottom - outer.bottom + 8;
  };
  // A step selected elsewhere (its path on the field) comes into view.
  useEffect(() => revealStep(selId), [selId]); // eslint-disable-line react-hooks/exhaustive-deps

  const outcomes = acq.outcomes || {};
  const activeIdx = run.steps.length && (running || time > 0) ? A.stepAt(run, time) : -1;
  const activeStep = activeIdx >= 0 ? run.steps[activeIdx] : null;
  const activeId = running && activeStep && activeStep.kind !== 'repeat' ? activeStep.nodeId : null;
  // Playback keeps the running step in view, moving the flow only when another step starts.
  useEffect(() => revealStep(activeId), [activeId]); // eslint-disable-line react-hooks/exhaustive-deps
  const passOf = (repeatId) => run.steps.find((step) => step.kind === 'repeat' && step.nodeId === repeatId)?.passes;
  const activePass = activeStep?.passStack?.at(-1);
  // Every row carries its step number, nested steps included; the field's path badges show the same numbers.
  const stepNumbers = useMemo(() => A.stepNumbers(routine), [routine]);
  const segByNode = new Map(); run.segs.forEach((seg) => { if (!segByNode.has(seg.nodeId)) segByNode.set(seg.nodeId, seg); });
  const previewed = new Set(run.steps.map((step) => step.nodeId));
  // A group's time spans from its first start to its last finish (its first previewed occurrence).
  const groupSpan = new Map();
  (run.groupSpans || []).forEach((span) => { if (!groupSpan.has(span.nodeId)) groupSpan.set(span.nodeId, span); });
  // Local readiness (AUTO.analyze) and the chosen trace's reference jumps (run.issues) stay distinct facts.
  const jumpByNode = new Map();
  // A step reached from several previous paths (repeat passes, routes) shows its largest jump.
  (run.issues || []).forEach((issue) => { if (issue.code === 'reference-discontinuity' && !(jumpByNode.get(issue.nodeId)?.distanceM >= issue.distanceM)) jumpByNode.set(issue.nodeId, issue); });
  const issueByNode = new Map();
  issues.forEach((issue) => { const prior = issueByNode.get(issue.nodeId); if (!prior || (prior.severity !== 'error' && issue.severity === 'error')) issueByNode.set(issue.nodeId, issue); });

  const focusStep = (id) => requestAnimationFrame(() => requestAnimationFrame(() => {
    [...document.querySelectorAll('.rt-panel .rt-step')].find((row) => row.dataset.id === id)?.querySelector('.rt-step-body')?.focus();
  }));
  const run_ = (operation) => { const result = edit(operation); if (result.changed && result.focusId) focusStep(result.focusId); return result; };
  /** After selecting a step, move focus to a control in its inspector once that inspector has rendered. */
  const focusInspector = (id, selector, match, origin) => requestAnimationFrame(() => requestAnimationFrame(() => {
    const inspector = [...document.querySelectorAll('.routine-insp')].find((element) => element.dataset.stepId === id);
    const target = inspector && (match ? [...inspector.querySelectorAll(selector)].find(match) : inspector.querySelector(selector));
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest' });
    if (!origin) return;
    // Escape from what was opened, or the inspector's Close, returns once to the lane that opened it. Fields, pickers
    // and open menus keep their own Escape (cancel a draft, close a list) first.
    const stop = () => { inspector.removeEventListener('keydown', keydown); inspector.removeEventListener('click', click, true); inspector.removeEventListener('focusout', leave); };
    const back = () => { stop(); requestAnimationFrame(() => requestAnimationFrame(() => { if (origin.isConnected) origin.focus(); })); };
    const keydown = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (event.target.closest?.('input:not([type="radio"]):not([type="checkbox"]), textarea, select, [role="combobox"], [aria-expanded="true"]')) return;
      event.preventDefault(); event.stopPropagation(); back();
    };
    const click = (event) => { if (event.target.closest?.('.ctxinsp-x')) back(); };
    const leave = (event) => { if (!inspector.contains(event.relatedTarget)) stop(); };
    inspector.addEventListener('keydown', keydown); inspector.addEventListener('click', click, true); inspector.addEventListener('focusout', leave);
  }));

  // ---- Add: a slot in the flow where the step lands, with its action strip; Path and Command open the source library
  // in the left rail. An empty routine always shows its first step's slot. Change path opens the same library. ----
  const firstStep = useMemo(() => ({ where: { list: { kind: 'root' } }, persistent: true, label: 'Add the first step', added: [], source: null }), []);
  const adding = add || (routine.nodes.length ? null : firstStep);
  const stepItems = useMemo(() => adding ? addMenuSteps(routine, adding.where, catalog) : [], [routine, adding, catalog]);
  // Usage ranks commands already in this routine or project higher; it is counted only while Add is open.
  // Counted when Add opens and held while it stays open, so commands added with Ctrl+Enter don't reshuffle the list.
  const usage = useMemo(() => adding ? commandUsage(props.routines, paths, routine) : null, [Boolean(adding)]); // eslint-disable-line react-hooks/exhaustive-deps
  const addInGroup = Boolean(adding && insideGroup(routine, adding.where));
  // Paths never go inside a group; elsewhere a slot opens on the library used last.
  const openAdd = (where, anchor, label, navKey) => {
    setMenu(null); setChange(null);
    // Each opened slot is a new strip that takes focus; keep-open adds move the same slot and leave focus where it is.
    slotCount.current += 1;
    setAdd({ where, anchor, navKey, label, added: [], slot: slotCount.current, source: initialSource(!insideGroup(routine, where) && paths.length > 0) });
  };
  const slotCount = useRef(0);
  // An Add line is replaced by its slot while it is open, so focus returns to the line once it renders again.
  const refocusKey = useRef(null);
  useLayoutEffect(() => {
    const key = refocusKey.current; if (!key) return;
    refocusKey.current = null;
    const targets = [...(scrollRef.current?.querySelectorAll('[data-nav]') || [])];
    // The remembered line can be gone (Undo removed its step); the routine's own Add step, or the first row, takes focus.
    const rootAdd = 'add:' + refKey({ kind: 'root' });
    (targets.find((element) => element.dataset.nav === key) || targets.find((element) => element.dataset.nav === rootAdd) || targets[0])?.focus();
  });
  const closeAdd = (refocus) => {
    const anchor = add?.anchor, navKey = add?.navKey;
    setAdd(null);
    if (!refocus) return;
    if (anchor?.isConnected) anchor.focus(); else if (navKey) refocusKey.current = navKey;
  };
  const focusSlot = (key) => requestAnimationFrame(() => document.querySelector('.rt-slot [data-action="' + key + '"]')?.focus());
  const focusLibrary = () => document.querySelector('#rt-source input, #rt-source .rt-src-none button')?.focus();
  /** Open, switch or (with null) close the slot's library. The first step's slot stays when its library closes. */
  const setSource = (source, options) => {
    if (!adding) return;
    if (!source && adding.persistent) { const kind = adding.source; setAdd(null); if (options?.refocus && kind) focusSlot(kind); return; }
    setAdd({ ...adding, source, focusSource: options?.focus ? (adding.focusSource || 0) + 1 : 0 });
  };
  // Choosing a path for an unavailable step replaces its "Choose a path" button with the path card, so focus then
  // falls back to that card's Change path, or to the step's row.
  const closeChange = (refocus) => {
    const origin = change?.origin, nodeId = change?.nodeId;
    setChange(null);
    if (refocus) requestAnimationFrame(() => {
      if (origin?.isConnected) { origin.focus(); return; }
      const inspector = [...document.querySelectorAll('.routine-insp')].find((element) => element.dataset.stepId === nodeId);
      const button = inspector?.querySelector('.routine-change-path');
      if (button) button.focus(); else if (nodeId) focusStep(nodeId);
    });
  };
  // Change path from the inspector opens the path library for that step; nothing else changes until a path is chosen.
  if (props.sourceApi) props.sourceApi.current = { changePath: (nodeId, origin) => { setMenu(null); setAdd(null); setChange({ nodeId, origin }); },
    closeAdd: () => closeAdd(true) };
  // A press outside the slot and its library closes them without moving focus; the first step's slot only drops its
  // library. Presses on the inspector's Change path belong to the library it opens.
  const open = Boolean((add && !add.persistent) || adding?.source || change);
  useEffect(() => {
    if (!open) return undefined;
    const away = (event) => {
      if (event.target.closest?.('.rt-slot, #rt-source, .routine-change-path')) return;
      setChange(null); setAdd(null);
    };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [open, add, adding, change]);
  useEffect(() => { if (change && !A.locate(routine, change.nodeId)) setChange(null); }, [routine, change]);
  // Undo (or any other edit) can remove the step a slot sits beside, or the step whose list holds it. The slot and its
  // library then close instead of offering picks that cannot land; focus returns to the routine's own Add step.
  useEffect(() => {
    const where = add?.where; if (!where) return;
    const id = where.afterId || where.beforeId || (where.list && where.list.kind !== 'root' ? where.list.nodeId : null);
    if (!id || A.locate(routine, id)) return;
    if (add.anchor?.isConnected) { closeAdd(true); return; }
    refocusKey.current = add.navKey || 'add:' + refKey({ kind: 'root' });
    setAdd(null);
  }, [routine, add]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Inside a parallel group, which steps the new one runs alongside. */
  const alongside = (where) => {
    const at = where.afterId || where.beforeId ? A.locate(routine, where.afterId || where.beforeId) : null;
    const group = at ? at.parent : where.list.kind === 'group' ? A.locate(routine, where.list.nodeId)?.node : null;
    if (group?.type !== 'group' || group.mode === 'sequential' || !group.nodes.length) return '';
    const names = group.nodes.map((node) => stepTitle(node, paths, catalog));
    return ' · runs alongside ' + plainText(nameList(names.length > 3 ? [...names.slice(0, 2), plural(names.length - 2, 'other step')] : names)).replace(/[“”]/g, '');
  };
  const destination = (where) => {
    if (where.afterId || where.beforeId) {
      const at = A.locate(routine, where.afterId || where.beforeId);
      return at ? (where.afterId ? 'After “' : 'Before “') + stepTitle(at.node, paths, catalog) + '”' + alongside(where) : '';
    }
    const ref = where.list;
    if (ref.kind === 'root') return routine.nodes.length ? 'At the end of the routine' : 'First step of the routine';
    const owner = A.locate(routine, ref.nodeId)?.node; if (!owner) return '';
    if (ref.kind === 'repeat' || ref.kind === 'group') return 'At the end of “' + stepTitle(owner, paths, catalog) + '”' + alongside(where);
    return 'At the end of route “' + (A.childLists(owner).find((list) => refKey(list.ref) === refKey(ref))?.label || '') + '”';
  };
  // An opened slot (not the empty routine's own first slot) is reported by where it lands, so the inspector beside the
  // flow can show the slot instead of the step selected before it opened.
  const slotDest = add && !add.persistent ? destination(add.where) : null;
  const onSlotChange = props.onSlotChange;
  useEffect(() => { onSlotChange?.(slotDest); }, [slotDest, onSlotChange]);
  useEffect(() => () => onSlotChange?.(null), [onSlotChange]);
  const nodeFor = (item) => {
    if (item.kind === 'path') return A.newNode('path', null, item.ref);
    // A catalog command lands bound, with its default arguments; without a catalog it stays a placeholder to bind later.
    if (item.kind === 'command') return item.command ? { ...A.newNode('function', 'command'), title: item.command.label,
      invocation: { commandId: item.command.id, arguments: commandArguments(item.command) } } : A.newNode('function', 'command');
    if (item.kind === 'wait') return A.newNode('builtin', 'wait');
    if (item.kind === 'decision') return A.newNode('decision');
    if (item.kind === 'repeat') return A.newNode('repeat');
    if (item.kind === 'group') return A.newNode('group', item.mode);
    if (item.kind === 'end') return A.newNode('end', 'routine');
    if (item.kind === 'exit') return A.newNode('end', 'repeat');
    return null;
  };
  /** After adding a command with inputs, its first input in the inspector takes focus; otherwise the new row does. */
  const focusFirstInput = (id) => requestAnimationFrame(() => requestAnimationFrame(() => {
    const inspector = [...document.querySelectorAll('.routine-insp')].find((element) => element.dataset.stepId === id);
    const target = inspector?.querySelector('.cmd-parameters :is(input, select, textarea, button):not(:disabled):not([type="hidden"])');
    if (!target) { focusStep(id); return; }
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest' });
  }));
  // Keep-open adds (Ctrl/⌘+Enter or click) keep the slot: the next pick lands after the one just added, and focus stays put.
  const pick = (item, options) => {
    const where = adding.where, node = nodeFor(item);
    if (options?.keep) {
      const result = edit(insertOperation(routine, where, node));
      // The first step's slot becomes the ordinary slot at the end of the routine, still in place.
      if (result.changed) setAdd({ anchor: adding.anchor, navKey: adding.navKey || (where.list ? 'add:' + refKey(where.list) : undefined), label: adding.label, source: adding.source, slot: adding.slot || 'first',
        where: where.afterId ? { afterId: node.id } : where, added: [...adding.added, item.label] });
      return;
    }
    setAdd(null);
    const result = edit(insertOperation(routine, where, node));
    if (!result.changed) { if (adding.anchor?.isConnected) adding.anchor.focus(); else if (adding.navKey) refocusKey.current = adding.navKey; return; }
    const inputs = item.kind === 'command' && (item.command?.parameters || []).some((parameter) => parameter.role === 'argument');
    // A placeholder opens on its name, so a team can tell two apart before the code exists; left empty it keeps the default.
    if (item.kind === 'command' && !item.command) focusInspector(result.focusId || node.id, '.routine-step-name');
    else if (inputs) focusFirstInput(result.focusId || node.id); else if (result.focusId) focusStep(result.focusId);
  };
  /** A path chosen for an existing step replaces its reference; the step keeps its place and identity. */
  const replacePath = (item) => {
    const nodeId = change.nodeId, node = A.locate(routine, nodeId)?.node;
    closeChange(true);
    if (node && node.ref !== item.ref) acq.set(nodeId, { ref: item.ref });
  };
  const changing = change ? A.locate(routine, change.nodeId)?.node : null;
  // The robot's previewed pose where a chosen path would start: at the open slot, or before the step whose path is
  // changing. A trial trace with a zero-second wait there reads the preview's pose at that point. Null when no path
  // runs before it (the first step) or the point is off the previewed route.
  const pickAt = changing ? { beforeId: change.nodeId } : adding?.source === 'path' ? adding.where : null;
  const pickKey = pickAt && JSON.stringify(pickAt);
  const startPose = useMemo(() => {
    if (!pickAt || !props.traceRoutine) return null;
    const marker = { ...A.newNode('builtin', 'wait'), arguments: { durationS: 0 } };
    const operation = insertOperation(routine, pickAt, marker);
    const trial = operation && A.editRoutine(routine, operation);
    return trial?.changed ? props.traceRoutine(trial.routine).steps.find((step) => step.nodeId === marker.id)?.pose || null : null;
  }, [routine, pickKey, props.traceRoutine]); // eslint-disable-line react-hooks/exhaustive-deps
  const previewPath = (pathId) => props.onPathPreview?.(pathId ? { path: paths.find((path) => path.id === pathId), pose: startPose } : null);
  const pathPick = { startPose, robot: props.robot, onPreview: previewPath };
  const library = changing
    ? h(SourceLibrary, { key: 'replace:' + change.nodeId, kind: 'path', mode: 'replace', title: 'Change path', autoFocus: true, current: changing.ref,
        dest: paths.some((path) => path.id === changing.ref) ? 'Replacing “' + stepTitle(changing, paths, catalog) + '”' : 'The saved path is unavailable',
        paths, pathFolders: props.pathFolders, pathTimes: props.pathTimes, uses: pathUses, onPick: replacePath, onClose: closeChange, ...pathPick })
    : adding?.source
      ? h(SourceLibrary, { key: 'insert:' + adding.source, kind: adding.source, mode: 'insert', title: adding.source === 'path' ? 'Add path' : 'Add command', dest: destination(adding.where),
          autoFocus: Boolean(adding.focusSource), paths, pathFolders: props.pathFolders, pathTimes: props.pathTimes, uses: pathUses, catalog, usage, ...(adding.source === 'path' ? pathPick : {}),
          onPick: pick, onCommandless: () => pick({ kind: 'command', label: 'Command' }),
          onBack: () => focusSlot(adding.source),
          onClose: (refocus) => (adding.persistent ? setSource(null, { refocus }) : closeAdd(refocus)) })
      : null;

  /** Duplicate: a copy with fresh IDs right after the step, as one Undo step; the copy is then selected. */
  const duplicate = (at) => {
    const operation = { kind: 'insert', listRef: at.listRef, index: at.index + 1, node: A.duplicateNode(at.node) };
    const check = A.checkEdit(routine, operation);
    return { key: 'duplicate', label: 'Duplicate', disabled: !check.allowed, reason: check.allowed ? '' : check.reason,
      run: () => { const result = edit(operation); if (result.changed) { setRange([]); onSelect(operation.node.id); focusStep(operation.node.id); } } };
  };
  // ---- row actions: each is a checked model operation; an unavailable one names its reason ----
  const rowItems = (id) => {
    const at = A.locate(routine, id); if (!at) return [];
    const body = [...document.querySelectorAll('.rt-panel .rt-step')].find((el) => el.dataset.id === id)?.querySelector('.rt-step-body');
    const option = (key, label, operation, hint) => {
      const check = operation ? A.checkEdit(routine, operation) : { allowed: false };
      return { key, label, hint, disabled: !check.allowed, reason: check.allowed ? '' : check.reason, run: () => { const result = run_(operation); if ((operation?.kind === 'wrapRepeat' || operation?.kind === 'wrapGroup') && result.changed) setRange([]); } };
    };
    const up = nudgeOperation(routine, id, -1), down = nudgeOperation(routine, id, 1);
    const ranged = range.length > 1 && range.includes(id);
    const command = at.node.type === 'function' && at.node.cat === 'command' ? catalog?.commands?.find((item) => item.id === at.node.invocation?.commandId) : null;
    // Looping commands and commands in a group never branch; their inspector says why.
    const branchable = Boolean(at.node.outputBranch || (A.branchOutputs(command).length && !at.node.invocation?.loop && !at.groupIds?.length));
    // Grouping inside a parallel group defaults to a sequence, elsewhere to running together.
    const groupMode = at.parent?.type === 'group' && at.parent.mode === 'parallel' ? 'sequential' : 'parallel';
    const groupWords = groupMode === 'parallel' ? 'in parallel' : 'in sequence';
    const groupable = !A.groupChildError(at.node);
    return [
      // A keyboard-reachable range action beside the row itself, not only in the range bar above the sheet.
      ...(ranged ? [option('wrapRange', 'Repeat these ' + range.length + ' steps', { kind: 'wrapRepeat', nodeIds: range }),
        option('groupRange', 'Group these ' + range.length + ' ' + groupWords, { kind: 'wrapGroup', nodeIds: range, mode: groupMode })] : []),
      { key: 'add', label: 'Add step after', hint: 'A', run: () => openAdd({ afterId: id }, body, 'Add a step after this one') },
      { key: 'addBefore', label: 'Add step before', hint: '⇧A', run: () => openAdd({ beforeId: id }, body, 'Add a step before this one') },
      duplicate(at),
      // Branching belongs to the command: this opens its inspector at the output choice.
      ...(branchable ? [{ key: 'branch', label: at.node.outputBranch ? 'Change branch output…' : 'Branch on output…', run: () => { setRange([]); onSelect(id); focusInspector(id, '#command-branch-output'); } }] : []),
      option('wrap', 'Repeat this step', { kind: 'wrapRepeat', nodeIds: [id] }),
      ...(at.node.type === 'repeat' ? [option('unwrap', 'Remove repeat, keep steps', { kind: 'unwrapRepeat', nodeId: id })] : []),
      ...(groupable && !ranged ? [option('group', 'Wrap in ' + (groupMode === 'parallel' ? 'parallel' : 'sequential') + ' group', { kind: 'wrapGroup', nodeIds: [id], mode: groupMode })] : []),
      ...(at.node.type === 'group' ? [
        option('mode', at.node.mode === 'parallel' ? 'Run in sequence instead' : 'Run in parallel instead', { kind: 'setGroupMode', nodeId: id, mode: at.node.mode === 'parallel' ? 'sequential' : 'parallel' }),
        option('ungroup', 'Remove group, keep steps', { kind: 'unwrapGroup', nodeId: id })] : []),
      ...(up ? [option('up', at.index > 0 ? 'Move up' : 'Move out, above', up, '⌥↑')] : []),
      ...(down ? [option('down', at.index < at.siblings.length - 1 ? 'Move down' : 'Move out, below', down, '⌥↓')] : []),
      // A cancelled delete returns focus to the row that opened the menu.
      { key: 'delete', label: 'Delete step', hint: '⌫', danger: true, run: () => acq.del(id) },
    ];
  };

  // ---- range: Shift+Arrow extends over eligible siblings of the selected step ----
  const extendTo = (id) => {
    const anchor = A.locate(routine, selId), target = A.locate(routine, id);
    if (!anchor || !target || anchor.siblings !== target.siblings) { setRange([]); onSelect(id); return; }
    const [low, high] = [Math.min(anchor.index, target.index), Math.max(anchor.index, target.index)];
    setRange(anchor.siblings.slice(low, high + 1).map((node) => node.id));
  };
  const rangeParent = range.length > 1 ? A.locate(routine, range[0])?.parent : null;
  const rangeGroupMode = rangeParent?.type === 'group' && rangeParent.mode === 'parallel' ? 'sequential' : 'parallel';
  const wrapRange = (operation = { kind: 'wrapRepeat', nodeIds: range }) => { const result = run_(operation); if (result.changed) setRange([]); };

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
    // A adds after this step; Shift+A adds before it.
    if ((event.key === 'a' || event.key === 'A') && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      if (event.shiftKey) openAdd({ beforeId: node.id }, event.currentTarget, 'Add a step before this one');
      else openAdd({ afterId: node.id }, event.currentTarget, 'Add a step after this one');
    }
  };

  // ---- lanes: the header opens the route's editor; its radio, reached with ArrowRight, chooses the preview route ----
  const editRoute = (id, routeId, origin) => { setRange([]); onSelect(id); focusInspector(id, '[data-route-editor]', (element) => element.dataset.routeEditor === routeId, origin); };
  const laneKeys = (event) => {
    if (navKeys(event)) return;
    if (event.key === 'ArrowRight' && !event.altKey && !event.metaKey && !event.ctrlKey) { event.preventDefault(); event.currentTarget.parentElement?.querySelector('.rt-brprev')?.focus(); }
  };
  // Arrows move the choice within the branch (native radios); Escape returns to the chosen lane's header.
  const previewKeys = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation();
    const chosen = document.querySelector('input.rt-brprev[name="' + CSS.escape(event.currentTarget.name) + '"]:checked') || event.currentTarget;
    chosen.parentElement?.querySelector('.rt-brlbl')?.focus();
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
    const warning = jump ? { meta: continuityText(jump), problem: 'warn', jump: jump.size } : issue ? { meta: issue.message, problem: 'warn' } : null;
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
    if (node.type === 'group') return { meta: !node.nodes.length ? 'No steps yet' : node.mode === 'sequential' ? 'Runs ' + plural(node.nodes.length, 'step') + ' in order' : 'Starts ' + plural(node.nodes.length, 'step') + ' together and finishes when every one finishes', dur: durationOf(node) };
    if (node.type === 'end') {
      if (node.scope === 'routine') return { meta: 'Ends the routine here; later steps never run' };
      return { meta: exitTo ? plainText(['Leaves the repeat and ', ...continuePhrase(exitTo, paths, catalog, false)]) : 'Leaves the repeat' };
    }
    if (node.type === 'function' && node.cat === 'command') {
      const command = catalog?.commands?.find((item) => item.id === node.invocation?.commandId);
      const output = node.outputBranch && A.branchOutputs(command).find((item) => item.name === node.outputBranch.output);
      const timing = A.commandTiming(node, driveModel).timing;
      // The row's tooltip says where an estimate comes from, or where an untimed command could get one.
      const time = timing === 'estimate' ? 'Preview estimate from its Robot page run time'
        : timing === 'unknown' && node.invocation?.loop?.until?.kind !== 'output' ? 'Untimed: set a run time on the Robot page to estimate it' : '';
      return { meta: [(node.outputBranch ? 'Then branch on ' + (output?.label || node.outputBranch.output) + ' · ' : '') + endsPhrase(node, routine, catalog), time].filter(Boolean).join(' · '), dur: durationOf(node) };
    }
    return { meta: 'Unsupported step · ignored by the preview', problem: 'warn' };
  }
  /** A branching command's output ("Branches on Has piece") or a repeat's early stop, else ''. */
  function flowMeta(node) {
    if (node.type === 'repeat') return node.until ? 'Until ' + describeStop(node.until, routine, catalog) : '';
    if (!node.outputBranch) return '';
    const command = catalog?.commands?.find((item) => item.id === node.invocation?.commandId);
    return 'Branches on ' + (A.branchOutputs(command).find((item) => item.name === node.outputBranch.output)?.label || node.outputBranch.output);
  }
  /** The bound command's label when the team gave the step its own name, else ''. */
  function boundName(node) {
    if (node.type !== 'function' || node.cat !== 'command' || !A.commandOwnName(node)) return '';
    return catalog?.commands?.find((item) => item.id === node.invocation?.commandId)?.label || '';
  }
  function durationOf(node, seg) {
    if (node.type === 'path') return seg ? fmt(seg.t1 - seg.t0) : '';
    if (node.type === 'builtin') return (node.ends?.endWhen ? '≤ ' : '') + fmt(node.arguments?.durationS);
    if (node.type === 'function' && node.cat === 'command') {
      const until = node.invocation?.loop?.until, { durS, timing } = A.commandTiming(node, driveModel);
      if (timing === 'estimate' || timing === 'upperBound') return A.timingPrefix(timing) + fmt(durS);
      if (until?.kind === 'time' && Number.isFinite(until.seconds)) return fmt(until.seconds);
      if (until?.kind === 'output') return 'Until result';
      return 'Untimed';
    }
    if (node.type === 'group') {
      const timing = A.groupTiming(node, driveModel), span = groupSpan.get(node.id);
      if (timing === 'unknown') return 'Untimed';
      return span ? A.timingPrefix(timing) + fmt(span.t1 - span.t0) : '';
    }
    if (node.type === 'repeat') return node.times === undefined ? 'Until result' : (node.until ? '≤ ' : '') + node.times + '×';
    return '';
  }

  // Drag feedback: the dragged step's slot (a well that closes once it has somewhere else to go) and the gap where it
  // will land. Only a target the model accepts opens a gap; an open group carries both on its whole box.
  const dropMark = () => (dnd.drag?.target?.allowed ? dnd.drag.target.mark : null);
  const dragClass = (id) => {
    if (!dnd.drag) return '';
    const mark = dropMark();
    return (dnd.drag.id === id ? ' dragging' + (dnd.drag.away ? ' away' : '') : '') + (mark?.rowId === id ? (mark.before ? ' drop-before' : ' drop-after') : '');
  };
  /** The lifted card: the step's glyph, name and time, at its row's size where it was grabbed. */
  function dragCard(drag) {
    const node = A.locate(routine, drag.id)?.node; if (!node) return null;
    const time = durationOf(node, segByNode.get(node.id));
    return createPortal(h('div', { className: 'library-drag-ghost rt-drag-card ' + stepKind(node) + (drag.target?.allowed ? '' : ' idle'), 'aria-hidden': true, 'data-meta': time || undefined,
      style: { left: drag.x - drag.box.dx, top: drag.y - drag.box.dy, width: drag.box.width, height: drag.box.height, paddingLeft: drag.box.inset } },
      h('span', { className: 'rt-step-ic' }, h(Glyph, { name: glyphFor(node) })), h('span', { className: 'library-drag-label' }, stepTitle(node, paths, catalog))), document.body);
  }

  function stepRow(node, ctx) {
    const { depth, offPreview, readOnly } = ctx;
    const sel = selId === node.id || range.includes(node.id);
    const active = activeId === node.id;
    const seg = segByNode.get(node.id);
    const kids = A.childLists(node);
    const isCollapsed = kids.length > 0 && collapsed.has(node.id);
    const info = describe(node, seg, offPreview, ctx.exitTo);
    const kind = stepKind(node);
    const loop = node.type === 'function' && node.invocation?.loop;
    const chosen = isBranch(node) ? A.selectedBranch(node, outcomes) : null;
    const nestedCount = isCollapsed ? kids.reduce((count, list) => count + A.branchCount(list.nodes), 0) : 0;
    const title = stepTitle(node, paths, catalog);
    const live = active && activePass ? 'Pass ' + activePass.pass + ' of ' + (passOf(activePass.repeatId) || '?') : active ? 'Now' : null;
    return h('div', { key: node.id, 'data-id': node.id, style: { '--depth': depth },
      // Shift-click on an editable row deletes the step (a group with its steps) through the row's own Delete, as on
      // the field, outline and timeline. Its controls (collapse, grip, actions) keep their own meaning, and a
      // keyboard-activated click (detail 0) only selects.
      ...(readOnly ? {} : shiftDeletionInput(() => { setMenu(null); setRange([]); acq.del(node.id); },
        (event) => !event.metaKey && !event.ctrlKey && !event.altKey && !(event.type === 'click' && event.detail === 0)
          && !event.target.closest?.('.rt-collapse, .rt-grip, .rt-step-tools'))),
      className: 'rt-step ' + kind + (sel ? ' sel' : '') + (active ? ' active' : '') + (offPreview ? ' off' : '') + (info.problem === 'muted' ? ' unreachable' : '') + (change?.nodeId === node.id ? ' replacing' : '')
        + (kids.length && !isCollapsed ? '' : dragClass(node.id)) },
      readOnly ? h('span', { className: 'rt-grip-space' }) : h(Grip, { onPointerDown: (e) => dnd.start(node.id, e) }),
      h('span', { className: 'rt-step-num', 'aria-hidden': true }, stepNumbers.get(node.id)),
      kids.length
        ? h('button', { className: 'rt-collapse' + (isCollapsed ? ' on' : ''), type: 'button', tabIndex: -1, 'aria-expanded': !isCollapsed,
            'aria-label': (isCollapsed ? 'Expand ' : 'Collapse ') + title, onClick: () => toggleCollapse(node.id) },
            h('span', { className: 'rt-collapse-kind' }, h(Glyph, { name: glyphFor(node) })), h('span', { className: 'rt-collapse-chev' }, h(Icon, { name: 'chevron', size: 14 })))
        : h('span', { className: 'rt-step-ic' }, h(Glyph, { name: glyphFor(node) })),
      h('button', { className: 'rt-step-body', type: 'button', 'data-nav': 'row:' + node.id, tabIndex: stop('row:' + node.id), 'aria-pressed': sel, 'aria-keyshortcuts': readOnly ? undefined : 'Shift+F10 A Shift+A Delete Alt+ArrowUp Alt+ArrowDown', 'aria-expanded': kids.length ? !isCollapsed : undefined,
        onClick: () => { setRange([]); onSelect(sel && selId === node.id ? null : node.id); },
        onKeyDown: onBodyKeyDown(node), title: isCollapsed ? undefined : info.meta },
        // A looping command carries the loop mark after its name, wrapping with its last word; the sentence is in the tooltip.
        h('span', { className: 'rt-step-title' }, title, loop && h('span', { className: 'rt-step-loop', 'aria-hidden': true }, h(Glyph, { name: 'loop', size: 12 }))),
        // A named group still says how it runs; an unnamed one already does in its name.
        node.type === 'group' && node.title?.trim() && h('span', { className: 'rt-step-kind' }, node.mode === 'sequential' ? 'In sequence' : 'In parallel'),
        // Likewise a command the team named still says which command it runs, so the name never hides the binding.
        boundName(node) && h('span', { className: 'rt-step-kind runs' }, boundName(node)),
        // What a branching command reads, and when a repeat stops early, as quiet text after the name.
        flowMeta(node) && h('span', { className: 'rt-step-kind' }, flowMeta(node)),
        // A warning is a mark beside the name; its sentence is the tooltip and stays in the accessible name.
        // A pose jump's mark is sized like the jump (AUTO.jumpSize), as on the field and in the inspector.
        info.problem === 'warn' && h('span', { className: 'rt-step-flag', 'data-jump': info.jump, 'aria-hidden': true }),
        h('span', { className: 'rt-step-meta' + (info.problem ? ' ' + info.problem : '') },
          isCollapsed ? plural(nestedCount, 'step') + ' inside' + (chosen ? ' · previewing ' + (kids.find((list) => routeIdOf(list.ref) === chosen.id)?.label || chosen.label) : '') : info.meta)),
      h('span', { className: 'rt-step-dur' + (info.dur === 'Untimed' ? ' unknown' : info.dur?.startsWith('≈') ? ' estimate' : '') }, live ? h('span', { className: 'rt-step-live' }, live) : (info.dur || '')),
      h('span', { className: 'rt-step-tools' }, !readOnly && h('button', { className: 'rt-tool rt-more', type: 'button', tabIndex: -1, 'aria-haspopup': 'menu', 'aria-expanded': menu?.id === node.id, title: 'Step actions (⇧F10)',
        'aria-label': 'Actions for ' + title, ...deletionInput((e) => { if (acq.preflight?.() === false) return; setAdd(null); setMenu({ id: node.id, anchor: e.currentTarget }); }) }, h(Glyph, { name: 'more', size: 15 }))));
  }

  /**
   * The slot's action strip. Paths stay outside groups, so inside one Path says why and, when the group sits beside a
   * path step, opens that path's Commands lane in Paths, where commands that run while driving belong.
   */
  function inserter() {
    const beside = addInGroup ? pathBesideGroup(routine, adding.where, paths) : null;
    const pathBlocked = addInGroup ? { reason: A.groupChildError({ type: 'path' }),
      open: beside && { label: 'Open “' + stepTitle(beside, paths, catalog) + '” in Paths', run: () => acq.openInEditor(beside.ref, { focus: 'commands' }) } } : null;
    return h(InsertStrip, { key: adding.slot || 'first', steps: stepItems.filter((item) => item.group === 'steps' && item.kind !== 'command'), allowPath: !addInGroup, pathBlocked,
      source: adding.source, onSource: setSource, focusLibrary, onPick: pick, onClose: closeAdd,
      added: adding.added, label: adding.label, dest: destination(adding.where), persistent: adding.persistent });
  }
  /** The Add line at the end of a list; while open, Add itself takes its place. */
  function addRow(ref, depth, ariaLabel, empty) {
    const where = { list: ref }, key = 'add:' + refKey(ref);
    const open = adding && adding.where.list && refKey(adding.where.list) === refKey(ref);
    const markHere = dropMark()?.list === refKey(ref) && dropMark().edge === 'end';
    return h('div', { key, className: 'rt-addwrap' + (empty ? ' empty' : '') + (open ? ' open' : '') + (markHere ? ' drop-before' : ''), 'data-list': refKey(ref), style: { '--depth': depth } },
      open ? inserter() : h('button', { className: 'rt-add', type: 'button', 'data-nav': key, tabIndex: stop(key), 'aria-expanded': false, 'aria-label': ariaLabel,
        onClick: (e) => openAdd(where, e.currentTarget, ariaLabel, key), onKeyDown: navKeys },
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
    // Add before or after a step opens between the rows, where the step will land.
    const at = () => h('div', { key: 'insert', className: 'rt-addwrap open at', style: { '--depth': ctx.depth } }, inserter());
    const out = [];
    nodes.forEach((node, index) => {
      if (adding?.where.beforeId === node.id) out.push(at());
      out.push(renderNode(node, { ...ctx, after: index + 1 < nodes.length ? { kind: 'step', node: nodes[index + 1] } : ctx.after }));
      if (adding?.where.afterId === node.id) out.push(at());
    });
    if (!ctx.readOnly) out.push(addRow(ref, ctx.depth, addLabel, !nodes.length));
    return out;
  }

  function renderNode(node, ctx) {
    const { depth, offPreview, readOnly } = ctx;
    const kids = A.childLists(node);
    const open = kids.length > 0 && !collapsed.has(node.id);
    const row = stepRow(node, ctx);
    if (!open) return h('div', { key: node.id, className: 'rt-step-wrap' }, row);
    const body = [];
    if (node.type === 'repeat') {
      body.push(...renderList(kids[0].nodes, kids[0].ref, { depth: depth + 1, offPreview, readOnly, after: { kind: 'pass' }, exitTo: ctx.after }, 'Add step to this repeat'));
      body.push(closingRow(depth + 1, repeatClosing(node, routine, catalog, flowCache, offPreview ? undefined : passOf(node.id))));
    } else if (node.type === 'group') {
      body.push(...renderList(kids[0].nodes, kids[0].ref, { depth: depth + 1, offPreview, readOnly, after: ctx.after, exitTo: ctx.exitTo }, 'Add step to this group'));
      body.push(closingRow(depth + 1, groupClosing(node, ctx.after, paths, catalog)));
    } else {
      const chosen = isBranch(node) ? A.selectedBranch(node, outcomes) : null;
      kids.forEach((list) => {
        const fixed = readOnly || list.readOnly;
        const routeId = routeIdOf(list.ref), live = list.ref.kind === 'fallback' ? false : chosen && chosen.id === routeId, count = A.branchCount(list.nodes);
        const flow = A.flowSummary(list.nodes, flowCache);
        const outcome = flow.normal ? (count ? '' : 'continues') : flow.endRoutine && flow.exitRepeat ? 'ends routine or leaves repeat' : flow.exitRepeat ? 'leaves repeat' : 'ends routine';
        const markHere = dropMark()?.list === refKey(list.ref) && dropMark().edge === 'start';
        body.push(h('div', { key: refKey(list.ref), className: 'rt-branch' + (live ? ' live' : '') + (offPreview ? ' off' : ''), role: 'group', 'aria-label': 'Route ' + list.label },
          h('div', { className: 'rt-route' + (markHere ? ' drop-after' : ''), 'data-list': fixed ? undefined : refKey(list.ref), style: { '--depth': depth + 1 } },
            list.ref.kind === 'fallback'
              ? h('span', { className: 'rt-brlbl static' }, h('span', { className: 'rt-brname' }, 'Saved fallback'), h('span', { className: 'rt-brkey' }, 'read-only'), h('span', { className: 'rt-brcount' }, plural(count, 'step')))
              // Two controls per lane: the preview choice (one radio group per branch, shared with the inspector's route
              // blocks), and the header itself, which opens this route's editor in the inspector.
              : h(React.Fragment, null,
                  h('input', { type: 'radio', className: 'rt-brprev rt-radio', name: 'rt-preview-' + node.id, tabIndex: -1, checked: Boolean(live), 'aria-label': 'Preview ' + list.label + ' route',
                    title: 'Preview this route', onChange: () => acq.setOutcome(node.id, routeId), onKeyDown: previewKeys }),
                  h('button', { className: 'rt-brlbl', type: 'button', 'data-nav': 'route:' + refKey(list.ref), tabIndex: stop('route:' + refKey(list.ref)), 'aria-keyshortcuts': 'ArrowRight',
                    title: 'Edit this route', onClick: (event) => editRoute(node.id, routeId, event.currentTarget), onKeyDown: laneKeys },
                    h('span', { className: 'rt-brname' }, list.label),
                    h('span', { className: 'rt-brkey' }, routeRule(node, list)),
                    h('span', { className: 'rt-brcount' }, [count ? plural(count, 'step') : 'Empty', outcome].filter(Boolean).join(' · '))))),
          renderList(list.nodes, list.ref, { depth: depth + 2, offPreview: offPreview || !live, readOnly: fixed, after: ctx.after, exitTo: ctx.exitTo }, 'Add step to the ' + list.label + ' route')));
      });
      body.push(closingRow(depth + 1, node.type === 'generatedTrajectory' ? { glyph: 'join', parts: ['End of the saved fallback'] } : branchClosing(kids, ctx.after, paths, catalog, flowCache)));
    }
    const shape = node.type === 'repeat' ? 'repeat' : node.type === 'group' ? 'cgroup ' + (node.mode === 'sequential' ? 'seq' : 'par') : 'branch';
    return h('div', { key: node.id, className: 'rt-step-wrap rt-group ' + shape + dragClass(node.id) }, row, h('div', { className: 'rt-block', role: 'group', 'aria-label': 'Inside ' + stepTitle(node, paths, catalog) }, body));
  }

  return h('div', { className: 'rt-panel' + (dnd.drag ? ' dragging' : ''), 'data-input': keyboard ? 'keyboard' : 'pointer', style: dnd.drag ? { '--drag-gap': dnd.drag.box.height + 'px' } : undefined,
    // Arrow keys move focus by script, which withholds :focus-visible after a click; track the input instead.
    onKeyDownCapture: (e) => { if (!keyboard && !e.metaKey && !e.ctrlKey) setKeyboard(true); }, onPointerDownCapture: () => keyboard && setKeyboard(false) },
    routine.nodes.length > 0 && h(RoutineSummary, { run }),
    range.length > 1 && h('div', { className: 'rt-range-bar', role: 'toolbar', 'aria-label': 'Selected steps' },
      h('span', null, plural(range.length, 'step') + ' selected'),
      h('button', { type: 'button', className: 'qbtn', onClick: () => wrapRange() }, h(Glyph, { name: 'repeat', size: 14 }), 'Repeat these steps'),
      h('button', { type: 'button', className: 'qbtn', onClick: () => wrapRange({ kind: 'wrapGroup', nodeIds: range, mode: rangeGroupMode }) }, h(Glyph, { name: rangeGroupMode === 'parallel' ? 'parallel' : 'sequential', size: 14 }), rangeGroupMode === 'parallel' ? 'Group in parallel' : 'Group in sequence'),
      h('button', { type: 'button', className: 'qbtn quiet', onClick: () => { setRange([]); focusStep(selId); } }, 'Clear')),
    h('div', { className: 'rt-scroll', ref: scrollRef, onFocusCapture: (e) => { const key = e.target.dataset?.nav; if (key && key !== tabStop) setTabStop(key); } },
      // An empty routine is the same list holding only its first step's Add, so a keep-open pick keeps Add in place.
      h('div', { className: 'rt-list' + (routine.nodes.length ? '' : ' rt-empty') + (running && run.total > 0 ? ' playing' : ''), role: 'list', 'aria-label': 'Routine run order' },
        renderList(routine.nodes, { kind: 'root' }, { depth: 0, offPreview: false, readOnly: false, after: { kind: 'end' }, exitTo: null }, 'Add step at the end'))),
    h('div', { className: 'rt-flow-note', role: 'status', 'aria-live': 'polite' }, note),
    dnd.drag && dragCard(dnd.drag),
    menu && h(RowMenu, { anchor: menu.anchor, items: rowItems(menu.id), onClose: (refocus) => { const anchor = menu.anchor; setMenu(null); if (refocus) anchor?.closest('.rt-step')?.querySelector('.rt-step-body')?.focus(); } }),
    // The library takes the routine list's place in the left rail; without that rail it follows the flow.
    library && (props.sourceHost ? createPortal(library, props.sourceHost) : h('div', { className: 'rt-source-inline' }, library)));
}
