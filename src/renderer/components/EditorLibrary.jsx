import * as React from 'react';
import { deletionInput } from './DeletionNotice';
import { UI } from './ui';
import { AUTO } from '../lib/routineModel';
import { selectedPathIds } from '../hooks/usePushSelection';
import { moveFolder, movePaths } from '../lib/libraryOrder';

const h = React.createElement;
const { useState, useRef, useEffect } = React;
const { Icon } = UI;
const memory = new Map();
const defaults = () => ({ query: '', collapsed: {}, scroll: 0, structureScroll: 0, ratio: 48, libraryOpen: true, sections: { wp: true, sg: false, rt: false, em: false, cr: false } });

function readPreferences(key) {
  if (memory.has(key)) return memory.get(key);
  try { return { ...defaults(), ...JSON.parse(localStorage.getItem(key) || '{}') }; }
  catch (_) { return defaults(); }
}

export function referencingRoutines(routines, pathId) {
  return routines.filter((routine) => {
    let found = false;
    AUTO.walk(routine.nodes, (node) => { if (node.type === 'path' && node.ref === pathId) found = true; });
    return found;
  });
}

// The push selection itself is App-owned (usePushSelection); this keeps the existing import working.
export { selectedPathIds };

// The library keeps its tabs, tools, search, at least two rows, and Push visible.
// A save error or a long selected name raises the minimum to fit them, up to the
// divider maximum. That capped height is the CSS minimum, so every divider value
// changes the layout; anything still taller scrolls within the library.
// LIST_MIN_HEIGHT matches the .library-scroll minimum in library.css.
const LIBRARY_MIN_HEIGHT = 280, LIST_MIN_HEIGHT = 80;
const MIN_RATIO = 25, MAX_RATIO = 75;

// While Focus hides the library, a slim strip stays where it was so the way back is where the list went.
// Restoring moves keyboard focus to the current path, since the strip itself disappears.
function LibraryRestore({ mode, onRestore, rail }) {
  const label = mode === 'paths' ? 'Show path list' : 'Show routine list';
  return h('div', { className: 'library-restore' },
    h('button', { type: 'button', className: 'library-restore-btn', 'aria-label': label, title: label + '  (\\)',
      onClick: () => {
        onRestore();
        requestAnimationFrame(() => (rail.current?.querySelector('.library-pick[aria-current="true"]') || rail.current?.querySelector('button:not(:disabled)'))?.focus());
      } },
      h(Icon, { name: 'panelopen', size: 18 }), h('span', { 'aria-hidden': true }, mode === 'paths' ? 'Paths' : 'Routines')));
}

export function LibraryRail({ preferenceKey, mode, hidden, onRestore, children, ...props }) {
  const storageKey = 'bordeaux.library.' + preferenceKey + '.' + mode;
  const [prefs, setPrefs] = useState(() => readPreferences(storageKey));
  const [railHeight, setRailHeight] = useState(0);
  const [minHeight, setMinHeight] = useState(LIBRARY_MIN_HEIGHT);
  const latest = useRef(prefs), rail = useRef(null), top = useRef(null), structureBody = useRef(null), timer = useRef(null);
  const resizable = Boolean(children);
  React.useLayoutEffect(() => {
    if (!resizable) return undefined;
    const element = rail.current;
    const measure = () => setRailHeight(element.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [resizable]);
  // Content outside the list changes with library props, so measure after each render.
  React.useLayoutEffect(() => {
    if (!resizable) return;
    const library = top.current.firstElementChild, list = library.querySelector('.library-scroll');
    setMinHeight(Math.max(LIBRARY_MIN_HEIGHT, Math.ceil(library.scrollHeight - list.offsetHeight) + LIST_MIN_HEIGHT));
  });
  const effectiveMinHeight = railHeight > 0 ? Math.min(minHeight, railHeight * MAX_RATIO / 100) : minHeight;
  const minRatio = railHeight > 0 ? Math.max(MIN_RATIO, effectiveMinHeight / railHeight * 100) : MIN_RATIO;
  const ratio = Math.max(minRatio, Math.min(MAX_RATIO, prefs.ratio));
  const clampRatio = (value) => Math.max(minRatio, Math.min(MAX_RATIO, value));
  const update = (patch) => {
    const next = { ...latest.current, ...patch };
    latest.current = next; memory.set(storageKey, next); setPrefs(next);
  };
  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { try { localStorage.setItem(storageKey, JSON.stringify(latest.current)); } catch (_) { /* Preferences can remain session-only. */ } }, 200);
    return () => clearTimeout(timer.current);
  }, [prefs, storageKey]);
  useEffect(() => () => { try { localStorage.setItem(storageKey, JSON.stringify(latest.current)); } catch (_) { /* Preferences can remain session-only. */ } }, [storageKey]);
  useEffect(() => {
    const scroller = structureBody.current?.querySelector('.outline-scroll,.rt-scroll');
    if (scroller) scroller.scrollTop = prefs.structureScroll;
  }, []);
  const resize = (event) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const bounds = rail.current.getBoundingClientRect();
    update({ ratio: clampRatio((event.clientY - bounds.top) / bounds.height * 100) });
  };
  return h(React.Fragment, null, hidden && onRestore && h(LibraryRestore, { mode, onRestore, rail }), h('nav', { ref: rail, hidden, className:'rail rail-l library-rail' + (children ? '' : ' library-only'), 'aria-label': mode === 'paths' ? 'Paths and outline' : 'Routines',
    style: { '--library-ratio': ratio + '%', '--library-min-height': effectiveMinHeight + 'px' },
    onKeyDown: (event) => { if (event.defaultPrevented) event.stopPropagation(); } },
    h('section', { ref: top, className: 'library-top' },
      h(EditorLibrary, { ...props, mode, prefs, update })),
    children && h('div', { className: 'library-divider', role: 'separator', tabIndex: 0, 'aria-label': 'Resize library and structure', 'aria-orientation': 'horizontal', 'aria-valuemin': Math.round(minRatio), 'aria-valuemax': MAX_RATIO, 'aria-valuenow': Math.round(ratio),
      onPointerDown: (event) => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); }, onPointerMove: resize,
      onPointerUp: (event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); },
      onKeyDown: (event) => { const next = { ArrowUp: ratio - 5, ArrowDown: ratio + 5, Home: minRatio, End: MAX_RATIO }[event.key]; if (next !== undefined) { event.preventDefault(); update({ ratio: clampRatio(next) }); } } }),
    children && h('section', { className: 'library-structure' },
      h('div', { className: 'library-section-title' }, mode === 'paths' ? 'Path outline' : 'Routine steps'),
      h('div', { ref: structureBody, className: 'library-structure-body', onScrollCapture: (event) => { if (event.target.matches('.outline-scroll,.rt-scroll')) update({ structureScroll: event.target.scrollTop }); } }, children(prefs.sections, (sections) => update({ sections: typeof sections === 'function' ? sections(latest.current.sections) : sections }))))));
}

function LibraryMenu({ menu, close, children, id }) {
  const ref = useRef(null);
  useEffect(() => {
    const element = ref.current;
    const onToggle = (event) => { if (event.newState === 'closed') close(false); };
    element.addEventListener('toggle', onToggle);
    element.showPopover({ source: menu.trigger });
    const bounds = element.getBoundingClientRect();
    element.style.top = Math.max(8, Math.min(menu.top, window.innerHeight - bounds.height - 8)) + 'px';
    element.style.left = Math.max(8, Math.min(menu.left, window.innerWidth - bounds.width - 8)) + 'px';
    element.querySelector('button:not(:disabled)')?.focus();
    return () => element.removeEventListener('toggle', onToggle);
  }, []);
  return h('div', { ref, id, popover: 'auto', className: 'library-menu', role: 'menu', 'aria-label': menu.name + ' actions',
    style: { left: Math.min(menu.left, window.innerWidth - 216), top: Math.max(8, Math.min(menu.top, window.innerHeight - 250)) },
    onKeyDown: (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); close(true); }
      if (event.key === 'Tab') close(false);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const buttons = [...ref.current.querySelectorAll('button:not(:disabled)')]; const index = buttons.indexOf(document.activeElement);
        buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
      }
    } }, children);
}

// A press on a path row or folder header becomes a drag once it moves a few pixels, so clicks still click.
// Release drops on the last valid target; Escape, blur or a cancelled pointer drop nothing. Near the list's top or
// bottom edge the list scrolls. `locate` turns a point into a target; `drop` applies it.
const DRAG_THRESHOLD = 5, DRAG_EDGE = 32;
function useLibraryDrag({ scroll, locate, drop }) {
  const [drag, setDrag] = useState(null);
  const active = useRef(null);
  useEffect(() => () => active.current?.(), []);
  const begin = (event, source) => {
    if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.target.closest?.('.library-more')) return;
    active.current?.();
    const element = event.currentTarget, pointerId = event.pointerId, origin = { x: event.clientX, y: event.clientY };
    let dragging = false, point = origin, target = null, frame = 0;
    const show = () => { target = locate(source, point.x, point.y); setDrag({ ...source, x: point.x, y: point.y, target }); };
    const tick = () => {
      frame = 0;
      if (!dragging) return;
      show();
      const list = scroll.current; if (!list) return;
      const box = list.getBoundingClientRect();
      const depth = point.y < box.top + DRAG_EDGE ? point.y - box.top - DRAG_EDGE : point.y > box.bottom - DRAG_EDGE ? point.y - box.bottom + DRAG_EDGE : 0;
      if (!depth || point.x < box.left || point.x > box.right) return;
      const before = list.scrollTop;
      list.scrollTop += Math.sign(depth) * Math.min(18, 3 + Math.abs(depth) / 2);
      if (list.scrollTop !== before) frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', stop, true); window.removeEventListener('blur', stop); window.removeEventListener('keydown', key, true);
      cancelAnimationFrame(frame); frame = 0;
      try { if (element.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId); } catch (_) { /* Already released. */ }
      document.body.classList.remove('library-dragging');
      active.current = null;
      if (dragging) setDrag(null);
    };
    const move = (next) => {
      if (next.pointerId !== pointerId) return;
      point = { x: next.clientX, y: next.clientY };
      if (!dragging) {
        if (Math.hypot(point.x - origin.x, point.y - origin.y) < DRAG_THRESHOLD) return;
        dragging = true;
        try { element.setPointerCapture(pointerId); } catch (_) { /* Window listeners still follow the pointer. */ }
        document.body.classList.add('library-dragging');
        window.addEventListener('keydown', key, true);
      }
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const up = (next) => {
      if (next.pointerId !== pointerId) return;
      const dropped = dragging;
      if (dropped) { point = { x: next.clientX, y: next.clientY }; show(); }
      const final = target;
      stop();
      if (!dropped) return;
      // The release would otherwise click the row or folder the drag started on.
      const swallow = (click) => { click.preventDefault(); click.stopPropagation(); };
      window.addEventListener('click', swallow, true);
      setTimeout(() => window.removeEventListener('click', swallow, true), 0);
      if (final?.valid) drop(source, final);
    };
    const key = (next) => { if (next.key === 'Escape') { next.preventDefault(); next.stopPropagation(); stop(); } };
    window.addEventListener('pointermove', move, true); window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', stop, true); window.addEventListener('blur', stop);
    active.current = stop;
  };
  return { drag, begin };
}

function EditorLibrary({ mode, prefs, update, project, routines, activePathId, activeRoutineId, onPath, onRoutine, actions, times, controller, selection, deletionNotice }) {
  const pathsMode = mode === 'paths';
  const routinePushAvailable = typeof window !== 'undefined' && window.bordeauxAPI?.robotDeliveryCapabilities?.routinePush === true;
  const pushUnavailable = !pathsMode && !routinePushAvailable;
  const items = pathsMode ? project.paths : routines;
  const activeId = pathsMode ? activePathId : activeRoutineId;
  const active = items.find((item) => item.id === activeId);
  const folders = project.pathFolders || [];
  const menuId = React.useId();
  const [menu, setMenu] = useState(null), [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState(''), [error, setError] = useState(''), [blocked, setBlocked] = useState(null);
  const search = useRef(null), edit = useRef(null), scroll = useRef(null), root = useRef(null), anchor = useRef(null);
  const selected = pathsMode ? selection.selected : active ? [active.id] : [];
  const folderName = (id) => folders.find((folder) => folder.id === id)?.name || '';
  const query = prefs.query.trim().toLowerCase();
  const visible = items.filter((item) => (item.name + (pathsMode ? ' ' + folderName(item.folderId) : '')).toLowerCase().includes(query));
  const displayed = pathsMode && !query ? [...folders.flatMap((folder) => prefs.collapsed[folder.id] ? [] : visible.filter((item) => item.folderId === folder.id)), ...visible.filter((item) => !item.folderId)] : visible;
  // Hidden means not on screen now: filtered out by search or inside a collapsed folder.
  const multiple = pathsMode && selected.length > 1, hidden = multiple ? selected.filter((id) => !displayed.some((item) => item.id === id)).length : 0;
  // Several selected paths act together, in the order the library lists them.
  const listed = pathsMode ? [...folders.flatMap((folder) => items.filter((item) => item.folderId === folder.id)), ...items.filter((item) => !item.folderId)] : items;
  const targetsFor = (item) => multiple && selected.includes(item.id) ? listed.filter((path) => selected.includes(path.id)).map((path) => path.id) : [item.id];
  const canDrag = pathsMode && !query && !editing;
  const focusRow = (id) => requestAnimationFrame(() => {
    const target = [...(root.current?.querySelectorAll('[data-library-item]') || [])].find((item) => item.dataset.libraryItem === id);
    (target || search.current)?.focus();
  });
  const expand = (folderId) => { if (folderId && prefs.collapsed[folderId]) update({ collapsed: { ...prefs.collapsed, [folderId]: false } }); };
  // Paths drop before or after a row, into a folder (its header, empty slot or any gap inside it), or anywhere else in
  // the list for no folder. Folders drop before or after another folder. A target that changes nothing is not valid.
  const locate = (source, x, y) => {
    const element = document.elementFromPoint(x, y);
    if (!element || !scroll.current?.contains(element)) return null;
    const groupOf = (node) => node.closest('[data-folder-group]')?.dataset.folderGroup || null;
    if (source.kind === 'folder') {
      const id = groupOf(element), others = folders.filter((folder) => folder.id !== source.id);
      if (id === source.id) return { valid: false };
      let target;
      if (id) {
        const box = element.closest('[data-folder-group]').getBoundingClientRect(), before = y < box.top + Math.min(box.height / 2, 40);
        target = { beforeId: before ? id : others[others.findIndex((folder) => folder.id === id) + 1]?.id ?? null, mark: { folderId: id, before } };
      } else if (others.length) target = { beforeId: null, mark: { folderId: others[others.length - 1].id, before: false } };
      else return { valid: false };
      return { ...target, valid: moveFolder(project, source.id, target.beforeId) !== project };
    }
    let target;
    const row = element.closest('[data-drop-path]'), into = element.closest('[data-drop-folder]');
    if (row) {
      const id = row.dataset.dropPath, folderId = row.dataset.dropFolder || null;
      if (source.ids.includes(id)) return { valid: false };
      const box = row.getBoundingClientRect(), before = y < box.top + box.height / 2;
      const siblings = items.filter((item) => (item.folderId || null) === folderId && !source.ids.includes(item.id));
      target = { folderId, beforeId: before ? id : siblings[siblings.findIndex((item) => item.id === id) + 1]?.id ?? null, mark: { rowId: id, before } };
    } else if (into || groupOf(element)) {
      const folderId = into?.dataset.dropFolder || groupOf(element);
      target = { folderId, beforeId: null, mark: { folderId } };
    } else target = { folderId: null, beforeId: null, mark: { unfiled: true } };
    return { ...target, valid: movePaths(project, source.ids, target.folderId, target.beforeId) !== project };
  };
  const dnd = useLibraryDrag({ scroll, locate, drop: (source, target) => {
    if (source.kind === 'folder') actions.arrangeFolder(source.id, target.beforeId);
    else if (actions.arrangePaths(source.ids, target.folderId, target.beforeId)) expand(target.folderId);
  } });
  const drag = dnd.drag, mark = drag?.target?.valid ? drag.target.mark : null;
  // Hovering a collapsed folder while dragging paths opens it.
  const hoverFolder = drag?.kind === 'path' && drag.target?.mark?.folderId && !drag.target.mark.rowId ? drag.target.mark.folderId : null;
  useEffect(() => {
    if (!hoverFolder || !prefs.collapsed[hoverFolder]) return undefined;
    const timer = setTimeout(() => expand(hoverFolder), 700);
    return () => clearTimeout(timer);
  }, [hoverFolder]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = prefs.scroll; }, []);
  useEffect(() => { if (editing) { edit.current?.focus(); edit.current?.select(); } }, [editing]);
  useEffect(() => { if (blocked) root.current?.querySelector('.library-blocked button')?.focus(); }, [blocked]);
  const closeMenu = (restore) => { if (restore) menu?.trigger?.focus(); setMenu(null); };
  const openMenu = (event, kind, item) => {
    event.preventDefault(); event.stopPropagation();
    if (actions.preflight?.() === false) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    setMenu({ id: item.id, name: item.name, kind, trigger: event.currentTarget, left: event.type === 'contextmenu' ? event.clientX : bounds.left, top: event.type === 'contextmenu' ? event.clientY : bounds.bottom + 3 });
  };
  // Click opens a path; Ctrl/Cmd-click toggles it in the selection; Shift-click (or Shift+Arrow) selects the listed
  // range from the last plain or Ctrl/Cmd choice, and Ctrl/Cmd+Shift adds that range. Routines open on any click.
  const choose = (item, event = {}) => {
    setMenu(null); setBlocked(null);
    if (!pathsMode) { onRoutine(item.id); return; }
    const toggle = event.metaKey || event.ctrlKey;
    if (event.shiftKey) {
      const order = displayed.map((path) => path.id), to = order.indexOf(item.id);
      const from = order.indexOf(order.includes(anchor.current) ? anchor.current : activeId);
      const range = from < 0 || to < 0 ? [item.id] : order.slice(Math.min(from, to), Math.max(from, to) + 1);
      selection.set(toggle ? [...new Set([...selected, ...range])] : range);
      return;
    }
    anchor.current = item.id;
    if (toggle) {
      const next = selected.includes(item.id) ? selected.filter((id) => id !== item.id) : [...selected, item.id];
      selection.set(next.length ? next : [item.id]);
      return;
    }
    selection.open(item.id); onPath(item.id);
  };
  const finish = (id) => { setEditing(null); setError(''); focusRow(id); };
  const rename = (kind, item) => { setMenu(null); setEditing({ kind, id: item.id }); setDraft(item.name); setError(''); };
  const create = (kind, operation) => {
    setMenu(null); const created = operation();
    if (created) { update({ query: '', libraryOpen: true, collapsed: { ...prefs.collapsed, [created.folderId || active?.folderId || '_unfiled']: false } }); if (pathsMode) selection.set([]); rename(kind, created); }
  };
  // Deleting a selected path deletes the whole selection as one change; any path a routine uses blocks all of it.
  const remove = (kind, item) => {
    if (actions.preflight?.() === false) return;
    setMenu(null);
    if (kind === 'path') {
      const ids = targetsFor(item), refs = [...new Set(ids.flatMap((id) => referencingRoutines(routines, id)))];
      if (refs.length) { setBlocked({ id: item.id, name: ids.length > 1 ? ids.length + ' paths' : item.name, several: ids.length > 1, routines: refs }); return; }
      const removed = ids.length > 1 ? actions.deletePaths(ids) : actions.deletePath(item.id);
      if (removed) focusRow(ids.includes(activeId) ? '' : activeId);
      return;
    }
    const removed = kind === 'routine' ? actions.deleteRoutine(item.id) : actions.deleteFolder(item.id);
    if (removed) focusRow(activeId === item.id ? '' : activeId);
  };
  // Alt+Arrow moves a path within its folder, or a folder among folders.
  const nudge = (event, kind, item) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') || !canDrag) return false;
    event.preventDefault(); event.stopPropagation();
    const up = event.key === 'ArrowUp';
    if (kind === 'folder') {
      const at = folders.findIndex((folder) => folder.id === item.id);
      if (up ? at > 0 : at < folders.length - 1) actions.arrangeFolder(item.id, up ? folders[at - 1].id : folders[at + 2]?.id ?? null);
      requestAnimationFrame(() => root.current?.querySelector('[data-folder-group="' + CSS.escape(item.id) + '"] .library-folder > button')?.focus());
      return true;
    }
    const folderId = item.folderId || null, siblings = items.filter((path) => (path.folderId || null) === folderId), at = siblings.findIndex((path) => path.id === item.id);
    if (up ? at > 0 : at < siblings.length - 1) actions.arrangePaths([item.id], folderId, up ? siblings[at - 1].id : siblings[at + 2]?.id ?? null);
    focusRow(item.id);
    return true;
  };
  const editForm = () => h('form', { className: 'library-rename', onSubmit: (event) => {
    event.preventDefault(); const clean = draft.trim(); if (!clean) { setError('Enter a name.'); return; }
    const ok = editing.kind === 'path' ? actions.renamePath(editing.id, clean) : editing.kind === 'routine' ? actions.renameRoutine(editing.id, clean) : actions.renameFolder(editing.id, clean);
    if (ok) finish(editing.id); else setError('This name could not be saved.');
  } }, h('input', { ref: edit, 'aria-label': 'Name', 'aria-invalid': !!error, value: draft, onChange: (event) => { setDraft(event.target.value); setError(''); } }),
    h('button', { type: 'submit', 'aria-label': 'Save name' }, h(Icon, { name: 'check', size: 14 })),
    h('button', { type: 'button', 'aria-label': 'Cancel rename', onClick: () => finish(editing.id) }, h(Icon, { name: 'x', size: 14 })),
    error && h('span', { className: 'library-error', role: 'alert' }, error));
  const more = (label, kind, item) => h('button', { className: 'library-more', type: 'button', 'aria-label': label, 'aria-haspopup': 'menu', 'aria-expanded': menu?.id === item.id, popovertarget: menuId, ...deletionInput((event) => openMenu(event, kind, item)) },
    h(Icon, { name: 'more', size: 16, sw: 2.6 }));
  const secondaryPress = (event) => { if (event.button === 2) { event.preventDefault(); actions.preflight?.(); return true; } return false; };
  const row = (item) => {
    const kind = pathsMode ? 'path' : 'routine', status = controller.itemStatus(kind, item.id);
    const duration = times[item.id];
    // A path still being drawn is unfinished, not a problem.
    const unfinished = pathsMode && (item.waypoints?.length || 0) < 2;
    const durationText = unfinished ? '—' : duration?.status === 'ready' ? duration.seconds.toFixed(2) + ' s' : duration?.status === 'error' ? '—' : '…';
    const durationTitle = unfinished ? 'Not timed yet · place at least two waypoints' : duration?.status === 'ready' ? 'Trajectory time' : duration?.status === 'error' ? 'Trajectory time unavailable: ' + duration.message : 'Computing trajectory time';
    const dragged = drag?.kind === 'path' && drag.ids.includes(item.id), markHere = drag?.kind === 'path' && mark?.rowId === item.id;
    return h('div', { key: item.id, className: 'library-item' + (dragged ? ' dragging' : '') + (markHere ? (mark.before ? ' drop-before' : ' drop-after') : ''),
      'data-drop-path': pathsMode ? item.id : undefined, 'data-drop-folder': pathsMode && item.folderId || undefined }, editing?.id === item.id ? editForm() :
      h('div', { className: 'library-row' + (selected.includes(item.id) ? ' selected' : ''),
        onPointerDown: (event) => { if (!secondaryPress(event) && canDrag) { const ids = targetsFor(item); dnd.begin(event, { kind: 'path', id: item.id, ids, label: ids.length > 1 ? ids.length + ' paths' : item.name }); } },
        onContextMenu: (event) => openMenu(event, kind, item) },
        h('button', { className: 'library-pick', type: 'button', 'data-library-item': item.id, 'aria-current': item.id === activeId ? 'true' : undefined, 'aria-pressed': selected.includes(item.id), title: item.name + '\n' + status.detail,
          'aria-keyshortcuts': pathsMode ? 'Shift+ArrowUp Shift+ArrowDown Alt+ArrowUp Alt+ArrowDown F2 Delete' : 'F2 Delete',
          onClick: (event) => choose(item, event), onDoubleClick: () => rename(kind, item),
          onKeyDown: (event) => {
            if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); if (!event.repeat && !event.isComposing && !event.nativeEvent?.isComposing && event.keyCode !== 229) remove(kind, item); return; }
            if (event.key === 'F2') { event.preventDefault(); rename(kind, item); return; }
            if (pathsMode && nudge(event, 'path', item)) return;
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault(); const rows = [...root.current.querySelectorAll('[data-library-item]')]; const index = rows.indexOf(event.currentTarget);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
            rows[next]?.focus(); const nextItem = items.find((value) => value.id === rows[next]?.dataset.libraryItem); if (nextItem) choose(nextItem, event);
          } }, h('span', { className: 'library-mark', 'aria-hidden': true }, multiple && selected.includes(item.id) && h(Icon, { name: 'check', size: 12 })), h('span', { className: 'library-name' }, item.name),
          h('span', { className: 'library-meta', title: pathsMode ? durationTitle : status.label + ': ' + status.detail }, pathsMode ? durationText : AUTO.countSteps(item) + (AUTO.countSteps(item) === 1 ? ' step' : ' steps'))),
        more('Actions for ' + item.name, kind, item)));
  };
  const group = (folder) => {
    const id = folder.id, members = items.filter((item) => item.folderId === id), collapsed = prefs.collapsed[id];
    const folderMark = drag?.kind === 'folder' && mark?.folderId === id, into = drag?.kind === 'path' && mark?.folderId === id && !mark.rowId;
    return h('section', { key: id, className: 'library-group' + (drag?.kind === 'folder' && drag.id === id ? ' dragging' : '') + (folderMark ? (mark.before ? ' drop-before' : ' drop-after') : ''), 'data-folder-group': id },
      editing?.kind === 'folder' && editing.id === id ? editForm() : h('div', { className: 'library-folder' + (into ? ' drop-into' : ''), 'data-drop-folder': id,
        onPointerDown: (event) => { if (!secondaryPress(event) && canDrag) dnd.begin(event, { kind: 'folder', id, ids: [id], label: folder.name }); },
        onContextMenu: (event) => openMenu(event, 'folder', folder) },
        h('button', { type: 'button', 'aria-expanded': !collapsed, 'aria-keyshortcuts': 'Alt+ArrowUp Alt+ArrowDown', onClick: () => update({ collapsed: { ...prefs.collapsed, [id]: !collapsed } }), onKeyDown: (event) => nudge(event, 'folder', folder) },
          h(Icon, { name: 'chevron', size: 12 }), h('span', null, folder.name)),
        more('Actions for folder ' + folder.name, 'folder', folder)),
      !collapsed && (members.length ? members.map(row) : h('div', { className: 'library-empty', 'data-drop-folder': id }, 'Empty folder')));
  };
  const menuItem = menu?.kind === 'folder' ? folders.find((item) => item.id === menu.id) : items.find((item) => item.id === menu?.id);
  const menuButton = (label, onClick, props = {}) => h('button', { type: 'button', role: 'menuitem', ...(props.className === 'danger' ? deletionInput(onClick) : { onClick }), ...props }, label);
  // Push, Move to and Delete act on the whole selection when the menu's path is part of it; the rest act on that path.
  const menuTargets = menu?.kind === 'path' && menuItem ? targetsFor(menuItem) : [];
  const several = menuTargets.length > 1;
  const targetFolders = new Set(menuTargets.map((id) => items.find((item) => item.id === id)?.folderId || ''));
  const currentFolder = targetFolders.size === 1 ? [...targetFolders][0] : null;
  const moveTo = (folderId) => {
    const ids = menuTargets, origin = menuItem.id;
    closeMenu(false);
    if (actions.arrangePaths(ids, folderId || null, null)) expand(folderId);
    focusRow(origin);
  };
  const moveLabel = several ? 'Move ' + menuTargets.length + ' paths to' : 'Move to';
  return h('div', { ref: root, className: 'editor-library' + (drag ? ' dragging' : ''), onKeyDown: (event) => {
    if (event.target.closest('dialog')) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' && pathsMode && !event.target.matches('input')) { event.preventDefault(); selection.set(displayed.map((item) => item.id)); }
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (editing) finish(editing.id); else if (menu) closeMenu(true); else if (blocked) { setBlocked(null); focusRow(blocked.id); } else if (multiple) selection.clear(); else { update({ query: '' }); search.current?.focus(); }
  } },
    // Paths, Routines and Settings are places in the toolbar; the library is just the collection and its search.
    h('div', { className: 'library-find' },
      h('input', { ref: search, className: 'library-search', type: 'search', 'aria-label': pathsMode ? 'Search paths and folders' : 'Search routines', placeholder: pathsMode ? 'Search paths' : 'Search routines', value: prefs.query, onChange: (event) => { update({ query: event.target.value, scroll: 0 }); setMenu(null); } }),
      pathsMode && h('button', { type: 'button', className: 'library-icon-button', title: 'New folder', 'aria-label': 'New folder', onClick: () => create('folder', actions.addFolder) }, h(Icon, { name: 'folder', size: 14 })),
      h('button', { type: 'button', className: 'library-icon-button', title: pathsMode ? 'New path' : 'New routine', 'aria-label': pathsMode ? 'New path' : 'New routine',
        onClick: () => create(pathsMode ? 'path' : 'routine', () => pathsMode ? actions.addPath(active?.folderId) : actions.addRoutine()) }, h(Icon, { name: 'plus', size: 15 }))),
    h('div', { ref: scroll, className: 'library-scroll', onScroll: (event) => update({ scroll: event.currentTarget.scrollTop }) },
      blocked && h('div', { className: 'library-blocked', role: 'alert' }, h('strong', null, 'Cannot delete ' + blocked.name), h('p', null, (blocked.several ? 'Remove their steps' : 'Remove its steps') + ' from these routines first:'), blocked.routines.map((routine) => h('button', { key: routine.id, type: 'button', onClick: () => onRoutine(routine.id) }, 'Open ' + routine.name))),
      !visible.length ? h('div', { className: 'library-empty' }, query ? 'No matching names.' : pathsMode ? 'Create a path to get started.' : 'Create a routine to get started.') : pathsMode && !query ? [...folders.map(group), ...visible.filter((item) => !item.folderId).map(row)] : visible.map(row),
      // While paths from a folder are dragged, the end of the list takes them out of their folders.
      drag?.kind === 'path' && folders.length > 0 && h('div', { className: 'library-drop-unfiled' + (mark?.unfiled ? ' over' : ''), 'aria-hidden': true }, 'No folder')),
    // Only while Push would send more than the open path: the count, how many are out of view, and Clear.
    multiple && h('div', { className: 'library-selection', role: 'status' },
      h('span', null, selected.length + ' selected' + (hidden ? ' · ' + hidden + ' hidden' : '')),
      h('button', { type: 'button', className: 'library-clear', onClick: () => { selection.clear(); focusRow(activeId); } }, 'Clear')),
    deletionNotice,
    drag && h('div', { className: 'library-drag-ghost' + (drag.target?.valid ? '' : ' idle'), 'aria-hidden': true, style: { left: drag.x + 14, top: drag.y + 10 } }, drag.label),
    menu && menuItem && h(LibraryMenu, { key: menu.id, id: menuId, menu, close: closeMenu },
      menu.kind !== 'folder' && !pushUnavailable && menuButton(pathsMode ? (several ? 'Push ' + menuTargets.length + ' paths…' : 'Push path…') : 'Push routine…', () => {
        // The review returns focus to its origin: the menu's trigger, or the row when the menu came from a right-click.
        closeMenu(true);
        if (!document.activeElement || document.activeElement === document.body || document.activeElement.closest('.library-menu')) {
          [...(root.current?.querySelectorAll('[data-library-item]') || [])].find((row) => row.dataset.libraryItem === menuItem.id)?.focus();
        }
        controller.requestPush(pathsMode ? { kind: 'paths', pathIds: menuTargets } : { kind: 'routine', routineId: menuItem.id });
      }, { disabled: controller.busy || controller.desktopAvailable === false || (pathsMode && menuTargets.some((id) => (items.find((item) => item.id === id)?.waypoints?.length || 0) < 2)) }),
      menu.kind === 'path' && menuButton('Export BDX…', () => { const pathId = menuItem.id; setMenu(null); actions.exportPath(pathId); }, { disabled: controller.desktopAvailable === false }),
      menu.kind !== 'folder' && h('hr'),
      menuButton('Rename', () => rename(menu.kind, menuItem)),
      menu.kind !== 'folder' && menuButton('Duplicate', () => create(menu.kind, () => pathsMode ? actions.duplicatePath(menuItem.id) : actions.duplicateRoutine(menuItem.id))),
      // A new path that starts where this one ends, with the two ends linked.
      menu.kind === 'path' && menuButton('New path from its end', () => create('path', () => actions.appendPath(menuItem.id)), {
        disabled: !menuItem.waypoints.length, title: !menuItem.waypoints.length ? 'Place a waypoint first' : 'Starts where this path ends; the two ends stay linked' }),
      menu.kind === 'folder' && menuButton('New path here', () => create('path', () => actions.addPath(menuItem.id))),
      menu.kind === 'path' && folders.length > 0 && h(React.Fragment, null, h('hr'),
        h('div', { role: 'group', 'aria-label': moveLabel, className: 'library-menu-group' },
          h('div', { className: 'library-menu-label', 'aria-hidden': true }, moveLabel),
          [...folders, { id: '', name: 'No folder' }].map((folder) => {
            const current = currentFolder === folder.id;
            return h('button', { key: folder.id || '_none', type: 'button', role: 'menuitemradio', 'aria-checked': current, disabled: current, className: 'library-menu-choice', onClick: () => moveTo(folder.id) },
              h('span', { className: 'library-menu-check', 'aria-hidden': true }, current && h(Icon, { name: 'check', size: 12 })), h('span', { className: 'library-menu-text' }, folder.name));
          }))),
      h('hr'), menuButton(menu.kind === 'folder' ? 'Delete folder' : several ? 'Delete ' + menuTargets.length + ' paths' : 'Delete', () => remove(menu.kind, menuItem), { className: 'danger' })));
}
