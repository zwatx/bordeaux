import * as React from 'react';
import { UI } from './ui';
import { Glyph } from './routineGlyphs';
import { modifierName } from '../lib/shortcuts';
import { commandIndex, markMatches } from '../lib/commandIndex';
import { commandGroupKey, commandSourceRows, GROUP_LIMIT, pathSourceRows, pathStartHint, SEARCH_LIMIT } from '../lib/routineSources';

// Adding a step is two decisions in two places. In the flow, an insertion slot sits exactly where the step will land
// and carries a small strip of actions: Path and Command open a source library, the routine's own steps (Wait,
// Repeat, groups, End) are added directly. The library replaces the routine list in the left rail while the slot is
// open, so the routine stays in view: paths in the project's folders with their times and shapes, commands as a
// subsystem tree. Search narrows either list; it is never the only way in.

const h = React.createElement;
const { useState, useRef, useEffect, useLayoutEffect, useMemo } = React;
const { Icon } = UI;

/** Strip keys, their letters and short labels. The full name stays in the accessible name. */
const STEP_KEYS = {
  wait: { letter: 'W', short: 'Wait' },
  repeat: { letter: 'R', short: 'Repeat' },
  'group:parallel': { letter: 'G', short: 'Parallel', name: 'Parallel group' },
  'group:sequential': { letter: 'S', short: 'Sequence', name: 'Sequential group' },
  end: { letter: 'E', short: 'End routine' },
  exit: { letter: 'X', short: 'Exit repeat' },
};
const SOURCES = { path: { letter: 'P', label: 'Path', icon: 'route' }, command: { letter: 'C', label: 'Command', icon: 'bolt' } };
let lastSource = 'path';
/** The source an insertion opens on: the one used last, when it is allowed there. */
export function initialSource(allowPath) { return allowPath ? lastSource : 'command'; }

/**
 * The insertion slot's action strip, one toolbar: ←/→ move, letters act (P, C, W, R, G, S, E, X), Enter or a click
 * acts on the focused action, and Ctrl/⌘ keeps the slot open for another step. Tab moves into the open library.
 * Escape (and Tab with no library open) closes a slot that was opened, returning focus to where it opened. The first
 * step's slot is always shown: it never takes focus by itself and Escape only closes its library.
 * `pathBlocked` ({ reason, open?: { label, run } }) keeps Path in the strip where paths cannot go: it stays reachable,
 * and acting on it shows the reason under the strip, with a way to the right place when there is one (focus moves there).
 */
export function InsertStrip({ steps, allowPath, pathBlocked, source, onSource, onPick, onClose, label, dest, persistent, added, focusLibrary }) {
  const ref = useRef(null);
  const actions = [...(allowPath || pathBlocked ? ['path'] : []), 'command', ...steps.map((item) => item.key)];
  const [current, setCurrent] = useState(() => (source && actions.includes(source) ? source : actions[0]));
  const [explained, setExplained] = useState(false);
  const itemFor = (key) => steps.find((item) => item.key === key);
  const focus = (key) => { setCurrent(key); ref.current?.querySelector('[data-action="' + key + '"]')?.focus(); };
  useEffect(() => { if (!persistent) focus(current); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const act = (key, keep) => {
    if (key === 'path' && pathBlocked) {
      setExplained(true);
      if (pathBlocked.open) requestAnimationFrame(() => ref.current?.querySelector('.rt-slot-why button')?.focus());
      return;
    }
    if (SOURCES[key]) { lastSource = key; if (source === key) focusLibrary(); else onSource(key, { focus: true }); return; }
    const item = itemFor(key);
    if (item) onPick(item, keep ? { keep: true } : undefined);
  };
  const onKeyDown = (event) => {
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      if (!persistent) onClose(true); else if (source) onSource(null);
      return;
    }
    if (event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey) {
      if (source && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); focusLibrary(); return; }
      if (!persistent) { event.preventDefault(); event.stopPropagation(); onClose(true); }
      return;
    }
    const index = actions.indexOf(current);
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) && plain) {
      event.preventDefault();
      focus(actions[event.key === 'Home' ? 0 : event.key === 'End' ? actions.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + actions.length) % actions.length]);
      return;
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !SOURCES[current] && !event.repeat) { event.preventDefault(); act(current, true); return; }
    if (event.key.length === 1 && plain && !event.shiftKey && !event.repeat) {
      const letter = event.key.toUpperCase();
      const key = actions.find((candidate) => (SOURCES[candidate] || STEP_KEYS[candidate])?.letter === letter);
      if (key) { event.preventDefault(); event.stopPropagation(); setCurrent(key); act(key, false); }
    }
  };
  const destId = useMemo(() => 'rt-slot-dest-' + Math.random().toString(36).slice(2, 8), []);
  const whyId = destId + '-why';
  const button = (key) => {
    const kind = SOURCES[key], step = STEP_KEYS[key], item = itemFor(key);
    const name = kind ? kind.label : step?.name || item.label;
    const blocked = key === 'path' && pathBlocked;
    return h('button', { key, type: 'button', 'data-action': key, tabIndex: current === key ? 0 : -1,
      className: kind ? 'rt-slot-src' + (source === key ? ' on' : '') + (blocked ? ' blocked' : '') : 'rt-slot-step ' + (item.tone || ''),
      'aria-pressed': kind && !blocked ? source === key : undefined, 'aria-controls': kind && source === key ? 'rt-source' : undefined,
      'aria-disabled': blocked ? true : undefined, 'aria-describedby': blocked ? whyId : undefined,
      'aria-label': blocked ? 'Path, unavailable here' : kind ? (source === key ? name + ' library' : 'Choose a ' + name.toLowerCase()) : 'Add ' + name.charAt(0).toLowerCase() + name.slice(1),
      'aria-keyshortcuts': (kind || step).letter, title: blocked ? pathBlocked.reason : (kind ? 'Choose a ' + name.toLowerCase() : 'Add ' + name.toLowerCase()) + ' (' + (kind || step).letter + ')',
      onFocus: () => setCurrent(key), onClick: (event) => act(key, !kind && (event.ctrlKey || event.metaKey)) },
      // From the keyboard, each glyph gives way to its key letter in the same box, so nothing moves.
      h('span', { className: 'rt-slot-ic' }, h(Glyph, { name: kind ? kind.icon : item.icon, size: 14 })),
      h('kbd', { 'aria-hidden': true }, (kind || step).letter),
      h('span', { className: 'rt-slot-label' }, kind ? kind.label : step?.short || item.label));
  };
  return h('div', { ref, className: 'rt-slot' + (persistent ? ' first' : ''), role: 'toolbar', 'aria-label': label, 'aria-describedby': destId, onKeyDown },
    h('span', { className: 'rt-slot-caret', 'aria-hidden': true }),
    h('div', { className: 'rt-slot-actions' },
      h('div', { className: 'rt-slot-sources' }, actions.filter((key) => SOURCES[key]).map(button)),
      h('div', { className: 'rt-slot-steps' }, actions.filter((key) => !SOURCES[key]).map(button)),
      // The reason is always Path's description; it shows under the strip once Path is pressed.
      pathBlocked && h('div', { id: whyId, className: 'rt-slot-why' + (explained ? '' : ' sr-only'), 'aria-live': 'polite' },
        h('p', null, pathBlocked.reason),
        explained && pathBlocked.open && h('button', { type: 'button', className: 'qbtn', tabIndex: -1, onClick: pathBlocked.open.run }, h(Glyph, { name: 'route', size: 14 }), pathBlocked.open.label))),
    !persistent && h('button', { type: 'button', className: 'rt-slot-x', tabIndex: -1, title: 'Cancel (Esc)', 'aria-label': 'Cancel adding a step',
      onMouseDown: (event) => event.preventDefault(), onClick: () => onClose(true) }, h(Icon, { name: 'x', size: 13 })),
    h('span', { id: destId, className: 'sr-only' }, dest),
    // Always present, so the first keep-open add is announced too.
    h('div', { className: 'sr-only', role: 'status' }, added?.length > 0 && 'Added ' + added.at(-1) + (added.length > 1 ? ' and ' + (added.length - 1) + ' more' : '') + '. Keep adding, or press Esc when done.'));
}

const closedFolders = new Set();

/**
 * The left-rail source library for one kind. `mode` 'insert' adds at the slot (Ctrl/⌘ keeps adding); 'replace'
 * chooses another path for an existing step. Rows are buttons with one Tab stop: ↓ from the search enters the list,
 * ↑/↓ move, →/← open and close a group, typing returns to the search, Enter (or a click) picks, and with a search
 * Enter picks the top match. Escape clears the search, then closes. Tab leaves for the strip (or, replacing, closes).
 * For paths, `startPose` is the robot's pose where the chosen path would start: each row says whether it starts there,
 * and paths that do are listed first too. `onPreview(pathId | null)` follows the hovered or focused path row.
 */
export function SourceLibrary({ kind, mode = 'insert', title, dest, paths = [], pathFolders, pathTimes, uses, catalog, usage, current, note, emptyNote,
  onPick, onClose, onBack, autoFocus, added, onCommandless, startPose, robot, onPreview }) {
  const ref = useRef(null), search = useRef(null);
  const [query, setQuery] = useState('');
  const [closed, setClosed] = useState(() => new Set(closedFolders));
  const commands = catalog?.commands || [];
  const index = useMemo(() => (kind === 'command' ? commandIndex(commands) : null), [kind, commands]);
  const [open, setOpen] = useState(() => {
    const key = index && current ? commandGroupKey(index, current) : null;
    return new Set(key ? [key] : []);
  });
  const [limits, setLimits] = useState(() => new Map());
  const [focusKey, setFocusKey] = useState(null);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => { setLimits((map) => (map.has('') ? new Map([...map].filter(([key]) => key)) : map)); }, [query]);
  const hints = useMemo(() => new Map(kind === 'path' && startPose ? paths.map((path) => [path.id, pathStartHint(path, startPose, robot)]) : []), [kind, paths, startPose, robot]);
  const continues = useMemo(() => new Set([...hints].filter(([, hint]) => hint?.here).map(([id]) => id)), [hints]);
  // The field previews the path under the pointer, else the focused one, and nothing once the library closes.
  const hovered = useRef(null), focusedPath = useRef(null);
  const preview = () => onPreview?.(hovered.current ?? focusedPath.current ?? null);
  useEffect(() => () => onPreview?.(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => (kind === 'path'
    ? pathSourceRows(paths, { folders: pathFolders, times: pathTimes, uses, query, closed, current, continues })
    : index ? commandSourceRows(index, { query, usage, open, limits }) : []), [kind, paths, pathFolders, pathTimes, uses, query, closed, current, continues, index, usage, open, limits]);
  const focusable = rows.filter((row) => row.type !== 'label');
  const firstItem = rows.find((row) => row.type === 'item');
  // The one Tab stop: the row last focused while it is still listed, else the current choice, else the first row.
  const stop = focusable.some((row) => row.key === focusKey) ? focusKey
    : (rows.find((row) => row.type === 'item' && (row.current || row.command?.id === current)) || focusable[0])?.key;
  useLayoutEffect(() => { if (autoFocus) search.current?.focus({ preventScroll: true }); }, [autoFocus, kind]);
  // A library opened for a step that is being changed shows the current choice.
  useEffect(() => { if (mode === 'replace') ref.current?.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: 'center' }); }, [mode]);
  const rowEls = () => [...(ref.current?.querySelectorAll('[data-row]') || [])];
  const focusRow = (key) => { setFocusKey(key); requestAnimationFrame(() => rowEls().find((el) => el.dataset.row === key)?.focus()); };
  const toggle = (row, next = !row.open) => {
    if (kind === 'path') {
      const set = new Set(closed); if (next) set.delete(row.id); else set.add(row.id);
      if (next) closedFolders.delete(row.id); else closedFolders.add(row.id);
      setClosed(set);
    } else {
      const set = new Set(open); if (next) set.add(row.id); else set.delete(row.id);
      setOpen(set);
    }
    setAnnouncement(row.label + (next ? ' open, ' + row.count + ' ' + (kind === 'path' ? 'paths' : 'commands') : ' closed'));
  };
  const showMore = (row) => {
    setLimits((map) => new Map(map).set(row.scope, (map.get(row.scope) || (row.scope ? GROUP_LIMIT : SEARCH_LIMIT)) + (row.scope ? GROUP_LIMIT : SEARCH_LIMIT * 4)));
    // Focus moves to the first newly shown row, which takes the "more" row's place.
    const position = focusable.findIndex((candidate) => candidate.key === row.key);
    requestAnimationFrame(() => { const el = rowEls()[position]; if (el) { setFocusKey(el.dataset.row); el.focus(); } });
  };
  const pick = (row, keep) => {
    if (row.type === 'group') { toggle(row); return; }
    if (row.type === 'more') { showMore(row); return; }
    lastSource = kind;
    onPick(row, keep && mode === 'insert' ? { keep: true } : undefined);
    if (keep && mode === 'insert') { setQuery(''); search.current?.focus(); }
  };
  const typeInto = (text) => { setQuery((value) => (text === null ? value.slice(0, -1) : value + text)); search.current?.focus(); };
  const leave = (event) => { event.preventDefault(); event.stopPropagation(); if (mode === 'insert' && onBack) onBack(); else onClose(true); };
  const onRowKey = (row) => (event) => {
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey;
    const list = rowEls(), at = list.indexOf(event.currentTarget);
    const go = (el) => { if (el) { event.preventDefault(); setFocusKey(el.dataset.row); el.focus(); } };
    if (event.key === 'ArrowDown' && plain) { event.preventDefault(); go(list[at + 1]); return; }
    if (event.key === 'ArrowUp' && plain) { event.preventDefault(); if (at <= 0) search.current?.focus(); else go(list[at - 1]); return; }
    if ((event.key === 'Home' || event.key === 'End') && plain) { go(event.key === 'Home' ? list[0] : list.at(-1)); return; }
    if (event.key === 'ArrowRight' && plain && row.type === 'group') { event.preventDefault(); if (!row.open) toggle(row, true); else go(list[at + 1]); return; }
    if (event.key === 'ArrowLeft' && plain) {
      if (row.type === 'group' && row.open) { event.preventDefault(); toggle(row, false); return; }
      if (row.depth) { const header = list.slice(0, at).reverse().find((el) => el.dataset.group); go(header); }
      return;
    }
    if (event.key === 'Enter') { event.preventDefault(); if (!event.repeat) pick(row, event.ctrlKey || event.metaKey); return; }
    if (event.key === 'Tab' && !event.shiftKey && plain) { leave(event); return; }
    if (event.key === 'Backspace' && plain) { event.preventDefault(); typeInto(null); return; }
    if (event.key.length === 1 && event.key !== ' ' && plain) { event.preventDefault(); typeInto(event.key); }
  };
  const onSearchKey = (event) => {
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey;
    if (event.key === 'ArrowDown' && plain) { event.preventDefault(); const target = (query.trim() && firstItem) || focusable.find((row) => row.key === stop) || focusable[0]; if (target) focusRow(target.key); return; }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.repeat) return;
      if (query.trim() && firstItem) pick(firstItem, event.ctrlKey || event.metaKey);
      else if (focusable[0]) focusRow(stop || focusable[0].key);
      return;
    }
    if (event.key === 'Tab' && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) leave(event);
  };
  const onKeyDown = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation();
    if (query) { setQuery(''); search.current?.focus(); return; }
    onClose(true);
  };
  const marked = (text) => markMatches(text, query).map((part, position) => (part.mark ? h('mark', { key: position }, part.text) : part.text));
  const searching = Boolean(query.trim());
  const row = (item) => {
    if (item.type === 'label') return h('div', { key: item.key, className: 'rt-src-label', role: 'presentation' }, item.label);
    const common = { key: item.key, type: 'button', 'data-row': item.key, tabIndex: item.key === stop ? 0 : -1, onKeyDown: onRowKey(item), onFocus: () => setFocusKey(item.key) };
    if (item.type === 'group') {
      return h('button', { ...common, 'data-group': true, className: 'rt-src-group' + (item.dim ? ' dim' : ''), 'aria-expanded': item.open, onClick: () => toggle(item) },
        h(Icon, { name: 'chevron', size: 12 }),
        h('span', { className: 'rt-src-group-name' }, item.label),
        h('span', { className: 'rt-src-count' }, item.note ? item.note + ' · ' + item.count : item.count));
    }
    if (item.type === 'more') return h('button', { ...common, className: 'rt-src-more', style: { '--depth': item.depth || 0 }, onClick: () => showMore(item) }, item.label, h('small', null, item.remaining.toLocaleString() + ' not shown'));
    const top = searching && item === firstItem;
    const chosen = item.current || (kind === 'command' && current && item.command?.id === current);
    if (item.kind === 'path') {
      // Like the Paths library: the name, its time on the right, and only the context that list lacks underneath.
      const used = item.uses === 1 ? 'In this routine' : item.uses > 1 ? 'Used ' + item.uses + '× in this routine' : '';
      const hint = hints.get(item.ref);
      const note = [item.folder, used].filter(Boolean).join(' · ');
      const meta = [hint?.text, item.folder, item.time, used].filter(Boolean).join(' · ');
      return h('button', { ...common, className: 'rt-src-item path' + (top ? ' top' : '') + (chosen ? ' chosen' : ''), style: { '--depth': item.depth || 0 }, 'aria-current': chosen || undefined,
        'aria-label': item.label + (meta ? ', ' + meta : '') + (chosen ? ', current path' : ''), onClick: (event) => pick(item, event.ctrlKey || event.metaKey),
        onMouseEnter: () => { hovered.current = item.ref; preview(); }, onMouseLeave: () => { hovered.current = null; preview(); },
        onFocus: () => { setFocusKey(item.key); focusedPath.current = item.ref; preview(); },
        onBlur: (event) => { if (!event.relatedTarget?.closest?.('.rt-src-item.path')) { focusedPath.current = null; preview(); } } },
        h('span', { className: 'rt-src-text' }, h('span', { className: 'rt-src-name' }, marked(item.label)),
          (hint || note) && h('small', null, hint && h('span', { className: 'rt-src-start' + (hint.here ? ' here' : '') }, hint.text), hint && note && ' · ', note)),
        h('span', { className: 'rt-src-time' }, item.time),
        chosen ? h('span', { className: 'rt-src-mark', 'aria-hidden': true }, h(Icon, { name: 'check', size: 13 })) : top ? h('kbd', { className: 'rt-src-enter', 'aria-hidden': true }, '↵') : h('span', { 'aria-hidden': true }));
    }
    const entry = item.entry, showPrefix = item.name === entry.label && entry.prefix;
    const meta = [searching && !entry.prefix && entry.subsystem !== 'Other' ? entry.subsystem : '', entry.meta].filter(Boolean).join(' · ');
    return h('button', { ...common, className: 'rt-src-item cmd' + (top ? ' top' : '') + (item.dim ? ' dim' : '') + (chosen ? ' chosen' : ''), style: { '--depth': item.depth || 0 }, 'aria-current': chosen || undefined,
      title: item.name !== entry.label ? entry.label : undefined, 'aria-label': entry.label + (meta ? ', ' + meta : '') + (chosen ? ', current command' : ''),
      onClick: (event) => pick(item, event.ctrlKey || event.metaKey) },
      h('span', { className: 'rt-src-text' },
        h('span', { className: 'rt-src-name' }, showPrefix ? [h('span', { key: 'prefix', className: 'rt-src-pre' }, marked(entry.prefix), ' '), ...marked(entry.rest)] : marked(item.name)),
        meta && h('small', null, meta)),
      chosen ? h('span', { className: 'rt-src-mark', 'aria-hidden': true }, h(Icon, { name: 'check', size: 13 })) : top && h('kbd', { className: 'rt-src-enter', 'aria-hidden': true }, '↵'));
  };
  const total = kind === 'path' ? paths.length : commands.length;
  const noun = kind === 'path' ? 'path' : 'command';
  const commandless = kind === 'command' && !commands.length;
  const empty = searching ? 'No ' + noun + ' matches “' + query.trim() + '”.' : kind === 'path' ? emptyNote || 'No paths yet. Create one in Paths.' : '';
  const keep = modifierName();
  return h('section', { ref, id: 'rt-source', className: 'rt-source ' + kind + (mode === 'replace' ? ' replace' : ''), 'aria-label': title, onKeyDown },
    h('header', { className: 'rt-src-head' },
      h('div', { className: 'rt-src-title' },
        h('span', { className: 'rt-src-kind ' + kind, 'aria-hidden': true }, h(Glyph, { name: kind === 'path' ? 'route' : 'bolt', size: 15 })),
        h('h2', null, title),
        h('button', { type: 'button', className: 'rt-src-x', tabIndex: -1, title: 'Close (Esc)', 'aria-label': 'Close ' + title.toLowerCase(), onMouseDown: (event) => event.preventDefault(), onClick: () => onClose(true) }, h(Icon, { name: 'x', size: 14 }))),
      dest && h('p', { className: 'rt-src-dest' }, dest)),
    !commandless && h('div', { className: 'rt-src-find' },
      h(Icon, { name: 'search', size: 14 }),
      h('input', { ref: search, type: 'search', value: query, spellCheck: false, autoComplete: 'off',
        placeholder: kind === 'path' ? 'Filter ' + total + ' ' + (total === 1 ? 'path' : 'paths') : total === 1 ? 'Find the command' : 'Find among ' + total.toLocaleString() + ' commands',
        'aria-label': kind === 'path' ? 'Filter paths' : 'Find a command', 'aria-describedby': note ? 'rt-source-note' : undefined,
        'aria-keyshortcuts': 'ArrowDown Enter Control+Enter Escape', onChange: (event) => setQuery(event.target.value), onKeyDown: onSearchKey })),
    note && h('p', { id: 'rt-source-note', className: 'rt-src-note' }, note),
    commandless
      ? h('div', { className: 'rt-src-none' },
          h('p', null, catalog ? 'The linked robot code has no commands.' : 'Commands come from linked robot code.'),
          h('button', { type: 'button', ref: search, className: 'qbtn wide', onClick: () => onCommandless?.(),
            onKeyDown: (event) => { if (event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey) leave(event); } }, 'Add a command to bind later'))
      : h('div', { className: 'rt-src-list', role: 'group', 'aria-label': kind === 'path' ? 'Paths' : 'Commands' },
          rows.length ? rows.map(row) : h('p', { className: 'rt-src-empty', role: 'status' }, empty)),
    mode === 'insert' && !commandless && h('footer', { className: 'rt-src-keys', 'aria-hidden': true },
      h('span', null, h('kbd', null, '↵'), ' adds'), h('span', null, h('kbd', null, keep + ' ↵'), ' keeps adding')),
    h('div', { className: 'sr-only', role: 'status' }, added?.length ? 'Added ' + added.at(-1) + '.' : ''),
    h('div', { className: 'sr-only', role: 'status', 'aria-live': 'polite' }, announcement));
}
