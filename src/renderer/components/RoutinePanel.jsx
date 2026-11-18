import { deletionInput, shiftDeletionInput } from './DeletionNotice';
import * as React from "react";
import { createPortal } from "react-dom";
import { PointerDrag } from "../hooks/usePointerDrag";
import { AUTO } from "../lib/routineModel";
import { UnitPrefs } from "../lib/unitPreferences";
import { modifierName } from "../lib/shortcuts";
import { commandArguments } from "./ContextInspector";
import { UI } from "./ui";
import { enabledPickerIndex, filterPickerItems, pickerPage, PICKER_PAGE_SIZE } from '../lib/pickerSearch';
import { routinePathChoices, routinePathUses } from '../lib/routinePathChoices';
import { commandEntry, commandIndex, commandSections, commandUsage, markMatches, rankChoices, usageText } from '../lib/commandIndex';

// Routine run sheet: one line per step in run order, each with its share of preview time on a shared axis. Repeats and
// branches are bounded groups; a branch's routes are lanes, whose header opens that route's editor in the inspector and
// whose radio chooses the preview route. A closing row states what authored control flow does next (shown when it is not
// obvious from the group ending); those facts come from AUTO.flowSummary, never from the chosen preview route.
// Explanations live in tooltips and the inspector. Selecting a row only changes the right inspector.
const { useState, useRef, useEffect, useLayoutEffect, useMemo } = React;
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
  // Two lanes that start together, and one lane of steps in order.
  parallel: 'M4 6h3 M4 12h3 M4 18h3 M7 3v18 M11 6h9 M11 18h9 M17 3l3 3-3 3 M17 15l3 3-3 3',
  sequential: 'M5 5h8 M5 12h8 M5 19h8 M18 4v15 M15 16l3 3 3-3',
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
  return { glyph: 'join', parts: [count > 1 ? 'Waits for all ' + count + ' to finish, then ' : 'Waits for it to finish, then ', ...next] };
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

/**
 * Inline Add: opens inside the flow where the step will land, as one column under one search. With an empty search it
 * offers the quick picks first (paths, this routine's commands, the routine's own steps) and the command catalog last,
 * as subsystems once the catalog is large. Icons tell the kinds apart; a heading appears only where it states a fact
 * the rows do not ("In this routine", "Used in this project"). A "Show all" row or a subsystem row narrows the list
 * (Enter, → or Tab) and shows that scope as a chip in the search; Backspace or ← on an empty search, or the chip,
 * leaves it. Typing ranks each kind and puts the best-matching kind first. Enter adds; Ctrl/⌘+Enter adds and keeps Add
 * open just after the step it added. `steps` holds the commands (`group: 'commands'`, each with its index `entry`) and
 * the routine's own steps; `pathMeta` gives each path its context line; `pathsNote` says why no path is offered.
 * `dest` names the place for assistive technology, since the flow already shows it. Escape, Tab and Shift+Tab close
 * Add and return focus to where it opened. A `persistent` Add (an empty routine's first step) is always shown: it does
 * not take focus when it appears, Escape only clears it, and Tab moves on.
 */
export function AddMenu({ paths, steps, onPick, onClose, label, dest, pathMeta, pathsNote, usage, added, persistent, inputClass }) {
  const SECTION_LIMIT = 5, COMMAND_LIMIT = 8;
  const SCOPES = { paths: 'Paths', commands: 'Commands', steps: 'Steps' };
  const ref = useRef(null), input = useRef(null), returnKey = useRef(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all'); // 'all', or the one kind a "Show all" row opened
  const [scope, setScope] = useState(null); // the open subsystem's key
  const [announcement, setAnnouncement] = useState('');
  const pathChoices = useMemo(() => paths.map(path => ({ key: 'path:' + path.id, kind: 'path', group: 'paths', ref: path.id, label: path.name, icon: 'route', meta: pathMeta?.get(path.id) || undefined })), [paths, pathMeta]);
  const commandChoices = useMemo(() => steps.filter(item => item.group === 'commands' && item.entry), [steps]);
  const stepChoices = useMemo(() => steps.filter(item => item.group !== 'commands'), [steps]);
  // The index is cached per command array, so keep the same array while the commands themselves are unchanged
  // (every routine edit rebuilds the step list, not the catalog).
  const commandList = useRef([]);
  const index = useMemo(() => {
    const next = commandChoices.map(item => item.command), previous = commandList.current;
    if (previous.length !== next.length || previous.some((command, i) => command !== next[i])) commandList.current = next;
    return commandIndex(commandList.current);
  }, [commandChoices]);
  const itemById = useMemo(() => new Map(commandChoices.map(item => [item.command.id, item])), [commandChoices]);
  const subsystem = scope ? index.bySubsystem.get(scope) || null : null;
  // A catalog refresh that removes the open subsystem returns to every command.
  useEffect(() => { if (scope && !subsystem) setScope(null); }, [scope, subsystem]);
  // Options in display order, and where each block after the first starts: a quiet rule, or a heading with a fact.
  const view = useMemo(() => {
    const blocks = [], searching = Boolean(query.trim());
    const more = (kind, count) => ({ key: 'more:' + kind, kind: 'more', filter: kind, icon: 'more', label: 'Show all ' + count.toLocaleString() + (searching ? ' matching ' : ' ') + kind });
    if (commandChoices.length && (subsystem || filter === 'all' || filter === 'commands')) {
      for (const section of commandSections(index, { query, scope: subsystem ? scope : null, usage })) {
        let rows = section.rows.map((row) => row.type === 'subsystem'
          ? { key: 'subsystem:' + row.subsystem.key, kind: 'subsystem', subsystem: row.subsystem, label: row.subsystem.name, icon: 'folder', dim: row.subsystem.diagnostic,
              meta: plural(row.subsystem.entries.length, 'command') + (row.subsystem.diagnostic ? ' · diagnostics' : '') }
          : { ...itemById.get(row.entry.id), item: itemById.get(row.entry.id), showPrefix: row.showPrefix, dim: row.entry.diagnostic });
        // All keeps a search's commands short so paths and steps stay in view; the best matches come first.
        const count = section.rows.filter((row) => row.type === 'command').length;
        if (filter === 'all' && !subsystem && searching && count > COMMAND_LIMIT + 1) rows = [...rows.slice(0, rows.length - count + COMMAND_LIMIT), more('commands', count)];
        // Commands already in this routine are quick picks; the rest of the catalog is browsed last.
        const recent = section.title === 'In this routine';
        blocks.push({ kind: 'commands', order: recent ? 1 : 3, title: recent || section.title === 'Used in this project' ? section.title : '', best: section.best, rows });
      }
    }
    const kind = (choices, name, order, limit) => {
      const ranked = rankChoices(choices, query);
      if (!ranked.length) return;
      let rows = ranked.map((match) => match.item);
      if (limit && filter === 'all' && rows.length > limit) rows = [...rows.slice(0, limit), more(name, rows.length)];
      blocks.push({ kind: name, order, title: '', best: ranked[0].score, rows });
    };
    if (!subsystem && (filter === 'all' || filter === 'paths')) kind(pathChoices, 'paths', 0, SECTION_LIMIT);
    if (!subsystem && (filter === 'all' || filter === 'steps')) kind(stepChoices, 'steps', 2, 0);
    // A search puts the kind with the best match first, so an exact name such as "Wait" is the first result.
    blocks.sort((a, b) => (searching ? b.best - a.best : 0) || a.order - b.order);
    const items = [], headings = new Map();
    for (const block of blocks) {
      if (block.title || items.length) headings.set(items.length, { key: block.kind + ':' + (block.title || items.length), title: block.title });
      items.push(...block.rows);
    }
    return { items, headings };
  }, [filter, query, scope, subsystem, usage, index, itemById, commandChoices, pathChoices, stepChoices]);
  const items = view.items;
  const [active, setActive] = useState(0);
  const [page, setPage] = useState(0);
  const shown = pickerPage(items, page);
  const activeVisible = active >= shown.start && active < shown.end && !items[active]?.disabled;
  const current = activeVisible ? items[active] : null;
  // A new query, filter or subsystem starts at the first result (leaving a scope returns to the row that opened it).
  // Replacement items for the same search (a background catalog update) keep the highlighted item by key, so Enter
  // never inserts something else; a vanished item falls back.
  const prevItems = useRef(items), prevSearch = useRef(query + '\0' + filter + '\0' + scope);
  useEffect(() => {
    const search = query + '\0' + filter + '\0' + scope, kept = returnKey.current ?? (prevSearch.current === search ? prevItems.current[active]?.key : undefined);
    returnKey.current = null; prevItems.current = items; prevSearch.current = search;
    const keep = kept === undefined ? -1 : items.findIndex((item) => item.key === kept && !item.disabled);
    const next = keep >= 0 ? keep : enabledPickerIndex(items, 0);
    setActive(next); setPage(next > 0 ? Math.floor(next / PICKER_PAGE_SIZE) : 0);
  }, [items]);
  // Add opened from a row or an Add line takes focus where it appears; the first step's Add waits to be used.
  useEffect(() => {
    if (persistent) return;
    input.current?.focus({ preventScroll: true });
    ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { ref.current?.querySelector('.rt-ch-row.active')?.scrollIntoView({ block: 'nearest' }); }, [active, shown.page, items]);
  useOutside(ref, null, persistent ? null : onClose);
  const activate = (index) => { setActive(index); if (index >= 0) setPage(Math.floor(index / PICKER_PAGE_SIZE)); };
  const step = (direction) => {
    const from = activeVisible ? active : direction > 0 ? shown.start - 1 : shown.end;
    activate(enabledPickerIndex(items, from + direction, direction));
  };
  const goPage = (nextPage) => {
    const next = pickerPage(items, nextPage);
    setPage(next.page); setActive(enabledPickerIndex(items, next.start, 1, false, next.end));
    input.current?.focus();
  };
  const enter = (group) => {
    setScope(group.key); setQuery('');
    setAnnouncement(group.name + ', ' + plural(group.entries.length, 'command') + '. Backspace returns to all commands.');
    input.current?.focus();
  };
  const widen = (kind) => {
    setFilter(kind);
    setAnnouncement('All ' + SCOPES[kind].toLowerCase() + '. Backspace returns to everything.');
    input.current?.focus();
  };
  // Leaving goes up one level: a subsystem returns to its list, a "Show all" list to everything, each at its own row.
  const leave = () => {
    if (scope) { returnKey.current = 'subsystem:' + scope; setScope(null); setAnnouncement(filter === 'all' ? 'All commands' : 'All ' + SCOPES[filter].toLowerCase()); }
    else if (filter !== 'all') { returnKey.current = 'more:' + filter; setFilter('all'); setAnnouncement('Paths, commands and steps'); }
    input.current?.focus();
  };
  // "Show all" and a subsystem open their scope; anything else is the pick. Keep-open picks clear the search for the
  // next step and stay in the scope.
  const choose = (item, keep) => {
    if (item.kind === 'more') { widen(item.filter); return; }
    if (item.kind === 'subsystem') { enter(item.subsystem); return; }
    if (!keep) { onPick(item.item || item); return; }
    onPick(item.item || item, { keep: true }); setQuery(''); input.current?.focus();
  };
  const onKeyDown = (event) => {
    const plain = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
    if (event.key === 'Escape') {
      // The first step's Add stays: Escape clears its search, then its scope.
      if (persistent) { if (query || scope || filter !== 'all') { event.preventDefault(); event.stopPropagation(); if (query) setQuery(''); else leave(); } return; }
      event.preventDefault(); event.stopPropagation(); onClose(true); return;
    }
    // → (at the end of the search) or Tab opens the highlighted subsystem or "Show all"; Backspace or ← on an empty
    // search leaves it.
    const value = event.target?.value, caretAtEnd = !value || event.target.selectionStart === value.length;
    if ((current?.kind === 'subsystem' || current?.kind === 'more') && plain && (event.key === 'Tab' || (event.key === 'ArrowRight' && caretAtEnd))) {
      event.preventDefault(); event.stopPropagation(); choose(current); return;
    }
    if ((event.key === 'Backspace' || (event.key === 'ArrowLeft' && plain)) && !query && (scope || filter !== 'all')) { event.preventDefault(); leave(); return; }
    if (event.key === 'Tab') { if (!persistent) { event.preventDefault(); event.stopPropagation(); onClose(true); } return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); step(event.key === 'ArrowDown' ? 1 : -1); }
    else if (event.key === 'PageDown' || event.key === 'PageUp') { event.preventDefault(); goPage(shown.page + (event.key === 'PageDown' ? 1 : -1)); }
    else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); activate(enabledPickerIndex(items, event.key === 'Home' ? 0 : items.length - 1, event.key === 'Home' ? 1 : -1)); }
    // Pagination buttons retain native Enter/Space activation; the combobox must not also choose an option.
    else if (event.key === 'Enter' && !event.target?.closest?.('.rt-add-pages button')) { event.preventDefault(); if (current && !event.repeat) choose(current, event.ctrlKey || event.metaKey); }
  };
  const marked = (text) => markMatches(text, query).map((part, index) => (part.mark ? h('mark', { key: index }, part.text) : part.text));
  const option = (item, position) => {
    const entry = item.kind === 'command' ? item.entry : null, hidden = entry && entry.prefix && !item.showPrefix;
    const opens = item.kind === 'subsystem' || item.kind === 'more';
    return h('div', { key: item.key, id: 'rt-add-opt-' + position, role: 'option', 'aria-selected': position === active, 'aria-disabled': item.disabled || undefined, 'aria-posinset': position + 1, 'aria-setsize': items.length,
      // A row without its subsystem name still has its full name for the tooltip and assistive technology.
      title: hidden ? entry.label : undefined, 'aria-label': hidden ? entry.label + (entry.meta ? ', ' + entry.meta : '') : undefined,
      'aria-keyshortcuts': opens ? 'ArrowRight Tab' : undefined,
      className: 'rt-ch-row' + (item.kind === 'more' ? ' more' : '') + (opens ? ' sub' : '') + (item.dim ? ' dim' : '') + (position === active ? ' active' : '') + (item.disabled ? ' disabled' : ''),
      // Pointer presses keep focus in the search, so typing continues after a pick that keeps Add open.
      onMouseDown: (event) => event.preventDefault(),
      onPointerMove: () => !item.disabled && setActive(position), onClick: (event) => !item.disabled && choose(item, event.ctrlKey || event.metaKey) },
      h('span', { className: 'rt-ch-ic ' + (item.tone || '') }, h(Glyph, { name: item.icon, size: 15 })),
      // The subsystem name is quieter only where subsystems are offered; a small catalog reads as plain names.
      h('span', { className: 'rt-ch-t' }, entry && entry.prefix && item.showPrefix && index.browsable ? [h('span', { key: 'prefix', className: 'rt-ch-pre' }, marked(entry.prefix), ' '), ...marked(entry.rest)]
        : entry ? marked(hidden ? entry.rest : entry.label) : marked(item.label)),
      item.meta && h('span', { className: 'rt-ch-d' }, item.meta),
      opens && h('span', { className: 'rt-ch-go', 'aria-hidden': true }, h(Icon, { name: 'chevron', size: 14 })));
  };
  const rows = [];
  shown.items.forEach((item, offset) => {
    const index = shown.start + offset, heading = view.headings.get(index);
    if (heading) rows.push(h('div', { key: 'section:' + heading.key, className: heading.title ? 'rt-ch-sec' : 'rt-ch-sep', role: 'presentation' }, heading.title || null));
    rows.push(option(item, index));
  });
  const kinds = { all: 'path, command or step', paths: 'path', commands: 'command', steps: 'step' };
  const keepKey = modifierName();
  const scopeName = subsystem ? subsystem.name : filter !== 'all' ? SCOPES[filter] : '';
  const home = !query.trim() && !scopeName;
  const placeholder = scopeName ? 'Search ' + (subsystem ? subsystem.name : scopeName.toLowerCase()) : pathChoices.length || pathsNote ? 'Add a path, command or step' : 'Add a command or step';
  const empty = query.trim() ? 'No ' + (subsystem ? subsystem.name + ' command' : kinds[filter]) + ' matches “' + query + '”' : 'Nothing to add here';
  const opens = current?.kind === 'subsystem' || current?.kind === 'more';
  return h('div', { ref, className: 'rt-add-menu' + (persistent ? ' first' : ''), role: 'group', 'aria-label': label, onKeyDown },
    h('div', { className: 'rt-add-search' },
      h(Icon, { name: 'plus', size: 14 }),
      // The open scope; pressing it (or Backspace on an empty search) goes back up one level.
      scopeName && h('button', { type: 'button', className: 'rt-add-crumb', tabIndex: -1, title: 'Back (Backspace)', 'aria-label': 'Leave ' + scopeName,
        onMouseDown: (event) => event.preventDefault(), onClick: leave }, scopeName, h(Icon, { name: 'chevron', size: 12 })),
      h('input', { ref: input, className: inputClass, value: query, onChange: (event) => setQuery(event.target.value), 'aria-label': subsystem ? 'Find a ' + subsystem.name + ' command' : 'Find a command, path or step',
        placeholder, role: 'combobox', 'aria-expanded': true, 'aria-controls': 'rt-add-list', 'aria-activedescendant': activeVisible ? 'rt-add-opt-' + active : undefined,
        'aria-describedby': ['rt-add-dest', shown.last > 0 && 'rt-add-pages'].filter(Boolean).join(' '), 'aria-keyshortcuts': 'ArrowUp ArrowDown ArrowRight ArrowLeft PageUp PageDown Home End Control+Enter', spellCheck: false, autoComplete: 'off' }),
      // One key hint for the highlighted row: how to open it, or how to keep adding.
      items.length > 0 && h('span', { className: 'rt-add-hint', 'aria-hidden': true }, opens ? [h('kbd', { key: 'k' }, '→'), 'open'] : [h('kbd', { key: 'k' }, keepKey + ' ↵'), 'add more'])),
    // Where the pick lands, for assistive technology; the flow shows it in place.
    h('span', { id: 'rt-add-dest', className: 'sr-only' }, dest),
    // The live region is always present, so screen readers announce the first keep-open add too.
    h('div', { className: 'rt-add-added', role: 'status' }, added?.length > 0 && 'Added ' + added.at(-1) + (added.length > 1 ? ' and ' + plural(added.length - 1, 'more step') : '') + '. Keep adding, or press Esc when done.'),
    home && !pathChoices.length && pathsNote && h('p', { className: 'rt-add-note' }, pathsNote),
    items.length
      ? h('div', { id: 'rt-add-list', className: 'rt-add-list', role: 'listbox', 'aria-label': subsystem ? subsystem.name + ' commands' : filter === 'all' ? 'Paths, commands and steps' : 'All ' + SCOPES[filter].toLowerCase() }, rows)
      : h('div', { className: 'rt-add-none' }, empty),
    shown.last > 0 && h('div', { className: 'qrow rt-add-pages', id: 'rt-add-pages', role: 'group', 'aria-label': 'Result pages. Use Page Up or Page Down to change pages.' },
      h('button', { type: 'button', className: 'qbtn quiet', tabIndex: -1, disabled: shown.page === 0, 'aria-label': 'Previous results', title: 'Previous results (Page Up)', onClick: () => goPage(shown.page - 1) }, 'Previous'),
      h('span', { role: 'status', 'aria-live': 'polite', 'aria-atomic': true }, (shown.start + 1).toLocaleString() + '–' + shown.end.toLocaleString() + ' of ' + items.length.toLocaleString()),
      h('button', { type: 'button', className: 'qbtn quiet', tabIndex: -1, disabled: shown.page === shown.last, 'aria-label': 'Next results', title: 'Next results (Page Down)', onClick: () => goPage(shown.page + 1) }, 'Next')),
    h('span', { className: 'sr-only', role: 'status', 'aria-live': 'polite' }, announcement));
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
  // Recomputed only when authored inputs or durations change, never per playback frame. Unchanged text keeps the
  // same Map, so a background duration that changes nothing visible keeps an open Add menu's cursor.
  const pathMetaRef = useRef(null);
  const pathMeta = useMemo(() => {
    const entries = routinePathChoices(paths, { folders: props.pathFolders, times: props.pathTimes, uses: routinePathUses(routine) }).map((choice) => [choice.path.id, choice.meta]);
    const key = JSON.stringify(entries);
    if (pathMetaRef.current?.key !== key) pathMetaRef.current = { key, map: new Map(entries) };
    return pathMetaRef.current.map;
  }, [paths, props.pathFolders, props.pathTimes, routine.nodes]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const [add, setAdd] = useState(null); // { where, anchor, navKey, label, added }
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
  // A group's row spans from its first start to its last finish, once per previewed occurrence.
  const groupSpan = new Map();
  (run.groupSpans || []).forEach((span) => {
    if (!groupSpan.has(span.nodeId)) groupSpan.set(span.nodeId, span);
    if (run.total > 0 && span.t1 > span.t0) spans.set(span.nodeId, [...(spans.get(span.nodeId) || []), { ...span, kind: 'group' }]);
  });
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

  // ---- Add: opens in the flow at the place the step lands; an empty routine always shows its first step's Add ----
  const firstStep = useMemo(() => ({ where: { list: { kind: 'root' } }, persistent: true, label: 'Add the first step', added: [] }), []);
  const adding = add || (routine.nodes.length ? null : firstStep);
  const stepItems = useMemo(() => adding ? addMenuSteps(routine, adding.where, catalog) : [], [routine, adding, catalog]);
  // Usage ranks commands already in this routine or project higher; it is counted only while Add is open.
  // Counted when Add opens and held while it stays open, so commands added with Ctrl+Enter don't reshuffle the list.
  const usage = useMemo(() => adding ? commandUsage(props.routines, paths, routine) : null, [Boolean(adding)]); // eslint-disable-line react-hooks/exhaustive-deps
  const addInGroup = Boolean(adding && insideGroup(routine, adding.where));
  const openAdd = (where, anchor, label, navKey) => { setMenu(null); setAdd({ where, anchor, navKey, label, added: [] }); };
  // An Add line is replaced by Add while it is open, so focus returns to the line once it renders again.
  const refocusKey = useRef(null);
  useLayoutEffect(() => {
    const key = refocusKey.current; if (!key) return;
    refocusKey.current = null;
    [...(scrollRef.current?.querySelectorAll('[data-nav]') || [])].find((element) => element.dataset.nav === key)?.focus();
  });
  const closeAdd = (refocus) => {
    const anchor = add?.anchor, navKey = add?.navKey;
    setAdd(null);
    if (!refocus) return;
    if (anchor?.isConnected) anchor.focus(); else if (navKey) refocusKey.current = navKey;
  };
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
  // Keep-open adds (Ctrl/⌘+Enter) stay in Add: the next pick lands after the one just added, and focus stays put.
  const pick = (item, options) => {
    const where = adding.where, node = nodeFor(item);
    if (options?.keep) {
      const result = edit(insertOperation(routine, where, node));
      // The first step's Add becomes the ordinary Add at the end of the routine, still in place.
      if (result.changed) setAdd({ anchor: adding.anchor, navKey: adding.navKey || (where.list ? 'add:' + refKey(where.list) : undefined), label: adding.label,
        where: where.afterId ? { afterId: node.id } : where, added: [...adding.added, item.label] });
      return;
    }
    setAdd(null);
    const result = edit(insertOperation(routine, where, node));
    if (!result.changed) { if (adding.anchor?.isConnected) adding.anchor.focus(); else if (adding.navKey) refocusKey.current = adding.navKey; return; }
    const inputs = item.kind === 'command' && (item.command?.parameters || []).some((parameter) => parameter.role === 'argument');
    if (inputs) focusFirstInput(result.focusId || node.id); else if (result.focusId) focusStep(result.focusId);
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
    if (node.type === 'group') return { meta: node.mode === 'sequential' ? 'Runs ' + plural(node.nodes.length, 'step') + ' in order' : 'Starts ' + plural(node.nodes.length, 'step') + ' together and finishes when every one finishes', dur: durationOf(node) };
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
    if (node.type === 'function' && node.cat === 'command') {
      const until = node.invocation?.loop?.until;
      if (until?.kind === 'time' && Number.isFinite(until.seconds)) return fmt(until.seconds);
      if (until?.kind === 'output') return 'Until result';
      return node.ends?.timeoutS !== undefined ? '≤ ' + fmt(node.ends.timeoutS) : 'Untimed';
    }
    if (node.type === 'group') {
      const timing = A.groupTiming(node), span = groupSpan.get(node.id);
      if (timing === 'unknown') return 'Untimed';
      return span ? (timing === 'upperBound' ? '≤ ' : '') + fmt(span.t1 - span.t0) : '';
    }
    if (node.type === 'repeat') return node.times === undefined ? 'Until result' : (node.until ? '≤ ' : '') + node.times + '×';
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
    const kind = node.type === 'path' ? 'path' : node.type === 'decision' ? 'decision' : node.type === 'builtin' ? 'wait' : node.type === 'function' && node.cat === 'command' ? 'cmd' : node.type === 'group' ? 'grp' : 'control';
    const loop = node.type === 'function' && node.invocation?.loop;
    const mark = dnd.drag?.target?.mark;
    const markHere = mark?.rowId === node.id;
    const chosen = isBranch(node) ? A.selectedBranch(node, outcomes) : null;
    const nestedCount = isCollapsed ? kids.reduce((count, list) => count + A.branchCount(list.nodes), 0) : 0;
    const title = stepTitle(node, paths, catalog);
    const live = active && activePass ? 'Pass ' + activePass.pass + ' of ' + (passOf(activePass.repeatId) || '?') : active ? 'Now' : null;
    return h('div', { key: node.id, 'data-id': node.id, style: { '--depth': depth },
      ...(!readOnly ? shiftDeletionInput(() => { setRange([]); acq.del(node.id); }) : {}),
      className: 'rt-step ' + kind + (sel ? ' sel' : '') + (active ? ' active' : '') + (offPreview ? ' off' : '') + (info.problem === 'muted' ? ' unreachable' : '')
        + (dnd.drag?.id === node.id ? ' dragging' : '') + (markHere ? (mark.before ? ' drop-before' : ' drop-after') + (dnd.drag.target.allowed ? '' : ' drop-invalid') : '') },
      readOnly ? h('span', { className: 'rt-grip-space' }) : h(Grip, { onPointerDown: (e) => dnd.start(node.id, e) }),
      h('span', { className: 'rt-step-num', 'aria-hidden': true }, numbered ? topIndex.get(node.id) : ''),
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

  /** Add, open in place. Paths stay outside groups; a project without paths says where they come from. */
  function inserter() {
    return h(AddMenu, { paths: addInGroup ? [] : paths, pathMeta, pathsNote: !addInGroup && !paths.length ? 'No paths yet. Create one in Paths.' : undefined, steps: stepItems, usage,
      added: adding.added, label: adding.label, dest: destination(adding.where), persistent: adding.persistent, inputClass: adding.persistent ? 'rt-empty-add' : undefined, onPick: pick, onClose: closeAdd });
  }
  /** The Add line at the end of a list; while open, Add itself takes its place. */
  function addRow(ref, depth, ariaLabel, empty) {
    const where = { list: ref }, key = 'add:' + refKey(ref);
    const open = adding && adding.where.list && refKey(adding.where.list) === refKey(ref);
    const mark = dnd.drag?.target?.mark;
    const markHere = mark?.list === refKey(ref) && mark.edge === 'end';
    return h('div', { key, className: 'rt-addwrap' + (empty ? ' empty' : '') + (open ? ' open' : '') + (markHere ? ' drop-before' + (dnd.drag.target.allowed ? '' : ' drop-invalid') : ''), 'data-list': refKey(ref), style: { '--depth': depth } },
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
    const at = () => h('div', { key: 'insert', className: 'rt-addwrap open at' }, inserter());
    const out = [];
    nodes.forEach((node, index) => {
      if (adding?.where.beforeId === node.id) out.push(at());
      out.push(renderNode(node, { ...ctx, after: index + 1 < nodes.length ? { kind: 'step', node: nodes[index + 1] } : ctx.after }, ref.kind === 'root'));
      if (adding?.where.afterId === node.id) out.push(at());
    });
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
        const mark = dnd.drag?.target?.mark, markHere = mark?.list === refKey(list.ref) && mark.edge === 'start';
        body.push(h('div', { key: refKey(list.ref), className: 'rt-branch' + (live ? ' live' : '') + (offPreview ? ' off' : ''), role: 'group', 'aria-label': 'Route ' + list.label },
          h('div', { className: 'rt-route' + (markHere ? ' drop-after' + (dnd.drag.target.allowed ? '' : ' drop-invalid') : ''), 'data-list': fixed ? undefined : refKey(list.ref), style: { '--depth': depth + 1 } },
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
    return h('div', { key: node.id, className: 'rt-step-wrap rt-group ' + shape }, row, h('div', { className: 'rt-block', role: 'group', 'aria-label': 'Inside ' + stepTitle(node, paths, catalog) }, body));
  }

  return h('div', { className: 'rt-panel' + (dnd.drag ? ' dragging' : ''), 'data-input': keyboard ? 'keyboard' : 'pointer',
    // Arrow keys move focus by script, which withholds :focus-visible after a click; track the input instead.
    onKeyDownCapture: (e) => { if (!keyboard && !e.metaKey && !e.ctrlKey) setKeyboard(true); }, onPointerDownCapture: () => keyboard && setKeyboard(false) },
    range.length > 1 && h('div', { className: 'rt-range-bar', role: 'toolbar', 'aria-label': 'Selected steps' },
      h('span', null, plural(range.length, 'step') + ' selected'),
      h('button', { type: 'button', className: 'qbtn', onClick: () => wrapRange() }, h(Glyph, { name: 'repeat', size: 14 }), 'Repeat these steps'),
      h('button', { type: 'button', className: 'qbtn', onClick: () => wrapRange({ kind: 'wrapGroup', nodeIds: range, mode: rangeGroupMode }) }, h(Glyph, { name: rangeGroupMode === 'parallel' ? 'parallel' : 'sequential', size: 14 }), rangeGroupMode === 'parallel' ? 'Group in parallel' : 'Group in sequence'),
      h('button', { type: 'button', className: 'qbtn quiet', onClick: () => { setRange([]); focusStep(selId); } }, 'Clear')),
    h('div', { className: 'rt-scroll', ref: scrollRef, onFocusCapture: (e) => { const key = e.target.dataset?.nav; if (key && key !== tabStop) setTabStop(key); } },
      // An empty routine is the same list holding only its first step's Add, so a keep-open pick keeps Add in place.
      h('div', { className: 'rt-list' + (routine.nodes.length ? '' : ' rt-empty') + (running && run.total > 0 ? ' playing' : ''), role: 'list', 'aria-label': 'Routine run order', style: { '--p': run.total > 0 ? Math.min(1, time / run.total) : 0 } },
        renderList(routine.nodes, { kind: 'root' }, { depth: 0, offPreview: false, readOnly: false, after: { kind: 'end' }, exitTo: null }, 'Add step at the end'))),
    h('div', { className: 'rt-flow-note', role: 'status', 'aria-live': 'polite' }, note),
    menu && h(RowMenu, { anchor: menu.anchor, items: rowItems(menu.id), onClose: (refocus) => { const anchor = menu.anchor; setMenu(null); if (refocus) anchor?.closest('.rt-step')?.querySelector('.rt-step-body')?.focus(); } }));
}
