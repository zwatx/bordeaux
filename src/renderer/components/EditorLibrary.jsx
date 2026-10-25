import * as React from 'react';
import { deletionInput, shiftDeletionInput } from './DeletionNotice';
import { UI } from './ui';
import { AUTO } from '../lib/routineModel';
import { selectedPathIds } from '../hooks/usePushSelection';

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

export function LibraryRail({ preferenceKey, mode, hidden, children, ...props }) {
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
  return h('nav', { ref: rail, hidden, className: 'rail rail-l library-rail' + (children ? '' : ' library-only'), 'aria-label': mode === 'paths' ? 'Paths and outline' : 'Routines',
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
      h('div', { ref: structureBody, className: 'library-structure-body', onScrollCapture: (event) => { if (event.target.matches('.outline-scroll,.rt-scroll')) update({ structureScroll: event.target.scrollTop }); } }, children(prefs.sections, (sections) => update({ sections: typeof sections === 'function' ? sections(latest.current.sections) : sections })))));
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

function PathProperties({ item, project, actions, close }) {
  const ref = useRef(null);
  useEffect(() => { ref.current.showModal(); }, []);
  return h('dialog', { ref, className: 'library-properties', 'aria-labelledby': 'path-properties-title', onClose: close, onKeyDown: (event) => event.stopPropagation() },
    h('header', null, h('strong', { id: 'path-properties-title' }, item.name), h('button', { type: 'button', 'aria-label': 'Close path properties', onClick: close }, h(Icon, { name: 'x', size: 16 }))),
    h('label', null, 'Folder', h('select', { 'aria-label': 'Move ' + item.name + ' to folder', value: item.folderId || '', onChange: (event) => actions.movePath(item.id, event.target.value) },
      h('option', { value: '' }, 'No folder'), (project.pathFolders || []).map((folder) => h('option', { key: folder.id, value: folder.id }, folder.name)))),
    h('footer', null, h('button', { type: 'button', onClick: close }, 'Done')));
}

function EditorLibrary({ mode, prefs, update, project, routines, activePathId, activeRoutineId, onPath, onRoutine, actions, times, controller, selection, deletionNotice }) {
  const pathsMode = mode === 'paths';
  const routinePushAvailable = !controller.fileTransfer && typeof window !== 'undefined' && window.bordeauxAPI?.robotDeliveryCapabilities?.routinePush === true;
  const pushUnavailable = !pathsMode && !routinePushAvailable;
  const items = pathsMode ? project.paths : routines;
  const activeId = pathsMode ? activePathId : activeRoutineId;
  const active = items.find((item) => item.id === activeId);
  const folders = project.pathFolders || [];
  const menuId = React.useId();
  const [menu, setMenu] = useState(null), [editing, setEditing] = useState(null), [propertiesId, setPropertiesId] = useState(null);
  const [draft, setDraft] = useState(''), [error, setError] = useState(''), [blocked, setBlocked] = useState(null);
  const search = useRef(null), edit = useRef(null), scroll = useRef(null), root = useRef(null);
  const selected = pathsMode ? selection.selected : active ? [active.id] : [];
  const folderName = (id) => folders.find((folder) => folder.id === id)?.name || '';
  const query = prefs.query.trim().toLowerCase();
  const visible = items.filter((item) => (item.name + (pathsMode ? ' ' + folderName(item.folderId) : '')).toLowerCase().includes(query));
  const displayed = pathsMode && !query ? [...folders.flatMap((folder) => prefs.collapsed[folder.id] ? [] : visible.filter((item) => item.folderId === folder.id)), ...visible.filter((item) => !item.folderId)] : visible;
  const focusRow = (id) => requestAnimationFrame(() => {
    const target = [...(root.current?.querySelectorAll('[data-library-item]') || [])].find((item) => item.dataset.libraryItem === id);
    (target || search.current)?.focus();
  });
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
  const choose = (item, event = {}) => {
    setMenu(null); setBlocked(null);
    if (event.shiftKey && event.type === 'click') { remove(pathsMode ? 'path' : 'routine', item); return; }
    if (!pathsMode) { onRoutine(item.id); return; }
    if (event.metaKey || event.ctrlKey) {
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
  const remove = (kind, item) => {
    if (actions.preflight?.() === false) return;
    setMenu(null);
    if (kind === 'path') {
      const refs = referencingRoutines(routines, item.id);
      if (refs.length) { setBlocked({ id: item.id, name: item.name, routines: refs }); return; }
    }
    const removed = kind === 'path' ? actions.deletePath(item.id) : kind === 'routine' ? actions.deleteRoutine(item.id) : actions.deleteFolder(item.id);
    if (removed) focusRow(activeId === item.id ? '' : activeId);
  };
  const editForm = () => h('form', { className: 'library-rename', onSubmit: (event) => {
    event.preventDefault(); const clean = draft.trim(); if (!clean) { setError('Enter a name.'); return; }
    const ok = editing.kind === 'path' ? actions.renamePath(editing.id, clean) : editing.kind === 'routine' ? actions.renameRoutine(editing.id, clean) : actions.renameFolder(editing.id, clean);
    if (ok) finish(editing.id); else setError('This name could not be saved.');
  } }, h('input', { ref: edit, 'aria-label': 'Name', 'aria-invalid': !!error, value: draft, onChange: (event) => { setDraft(event.target.value); setError(''); } }),
    h('button', { type: 'submit', 'aria-label': 'Save name' }, h(Icon, { name: 'check', size: 14 })),
    h('button', { type: 'button', 'aria-label': 'Cancel rename', onClick: () => finish(editing.id) }, h(Icon, { name: 'x', size: 14 })),
    error && h('span', { className: 'library-error', role: 'alert' }, error));
  const row = (item) => {
    const kind = pathsMode ? 'path' : 'routine', status = controller.itemStatus(kind, item.id);
    const duration = times[item.id];
    // A path still being drawn is unfinished, not a problem.
    const unfinished = pathsMode && (item.waypoints?.length || 0) < 2;
    const durationText = unfinished ? '—' : duration?.status === 'ready' ? duration.seconds.toFixed(2) + ' s' : duration?.status === 'error' ? '—' : '…';
    const durationTitle = unfinished ? 'Not timed yet · place at least two waypoints' : duration?.status === 'ready' ? 'Trajectory time' : duration?.status === 'error' ? 'Trajectory time unavailable: ' + duration.message : 'Computing trajectory time';
    return h('div', { key: item.id, className: 'library-item' }, editing?.id === item.id ? editForm() :
      h('div', { className: 'library-row' + (selected.includes(item.id) ? ' selected' : ''), ...shiftDeletionInput(() => remove(kind, item)), onPointerDown: event => { if (event.button === 2) { event.preventDefault(); actions.preflight?.(); } }, onContextMenu: (event) => openMenu(event, kind, item) },
        h('button', { className: 'library-pick', type: 'button', 'data-library-item': item.id, 'aria-current': item.id === activeId ? 'true' : undefined, 'aria-pressed': selected.includes(item.id), title: item.name + '\n' + status.detail,
          onClick: (event) => choose(item, event), onDoubleClick: () => rename(kind, item),
          onKeyDown: (event) => {
            if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); if (!event.repeat && !event.isComposing && !event.nativeEvent?.isComposing && event.keyCode !== 229) remove(kind, item); return; }
            if (event.key === 'F2') { event.preventDefault(); rename(kind, item); return; }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault(); const rows = [...root.current.querySelectorAll('[data-library-item]')]; const index = rows.indexOf(event.currentTarget);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
            rows[next]?.focus(); const nextItem = items.find((value) => value.id === rows[next]?.dataset.libraryItem); if (nextItem) choose(nextItem, event);
          } }, h('span', { className: 'library-mark', 'aria-hidden': true }, multiple && selected.includes(item.id) && h(Icon, { name: 'check', size: 12 })), h('span', { className: 'library-name' }, item.name),
          h('span', { className: 'library-meta', title: pathsMode ? durationTitle : status.label + ': ' + status.detail }, pathsMode ? durationText : AUTO.countSteps(item) + (AUTO.countSteps(item) === 1 ? ' step' : ' steps'))),
        h('button', { className: 'library-more', type: 'button', 'aria-label': 'Actions for ' + item.name, 'aria-haspopup': 'menu', 'aria-expanded': menu?.id === item.id, popovertarget: menuId, ...deletionInput((event) => openMenu(event, kind, item)) }, '…')));
  };
  const group = (folder) => {
    const id = folder.id, members = items.filter((item) => item.folderId === id), collapsed = prefs.collapsed[id];
    return h('section', { key: id, className: 'library-group' },
      editing?.kind === 'folder' && editing.id === id ? editForm() : h('div', { className: 'library-folder', ...shiftDeletionInput(() => remove('folder', folder)), onPointerDown: event => { if (event.button === 2) { event.preventDefault(); actions.preflight?.(); } }, onContextMenu: (event) => openMenu(event, 'folder', folder) },
        h('button', { type: 'button', 'aria-expanded': !collapsed, onClick: () => update({ collapsed: { ...prefs.collapsed, [id]: !collapsed } }) }, h(Icon, { name: 'chevron', size: 12 }), h('span', null, folder.name)),
        h('button', { className: 'library-more', type: 'button', 'aria-label': 'Actions for folder ' + folder.name, 'aria-haspopup': 'menu', popovertarget: menuId, ...deletionInput((event) => openMenu(event, 'folder', folder)) }, '…')),
      !collapsed && (members.length ? members.map(row) : h('div', { className: 'library-empty' }, 'Empty folder')));
  };
  const menuItem = menu?.kind === 'folder' ? folders.find((item) => item.id === menu.id) : items.find((item) => item.id === menu?.id);
  const properties = project.paths.find((item) => item.id === propertiesId);
  // Hidden means not on screen now: filtered out by search or inside a collapsed folder.
  const multiple = pathsMode && selected.length > 1, hidden = multiple ? selected.filter((id) => !displayed.some((item) => item.id === id)).length : 0;
  const menuButton = (label, onClick, props = {}) => h('button', { type: 'button', role: 'menuitem', ...(props.className === 'danger' ? deletionInput(onClick) : { onClick }), ...props }, label);
  return h('div', { ref: root, className: 'editor-library', onKeyDown: (event) => {
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
      blocked && h('div', { className: 'library-blocked', role: 'alert' }, h('strong', null, 'Cannot delete ' + blocked.name), h('p', null, 'Remove its steps from these routines first:'), blocked.routines.map((routine) => h('button', { key: routine.id, type: 'button', onClick: () => onRoutine(routine.id) }, 'Open ' + routine.name))),
      !visible.length ? h('div', { className: 'library-empty' }, query ? 'No matching names.' : pathsMode ? 'Create a path to get started.' : 'Create a routine to get started.') : pathsMode && !query ? [...folders.map(group), ...visible.filter((item) => !item.folderId).map(row)] : visible.map(row)),
    // Only while Push would send more than the open path: the count, how many are out of view, and Clear.
    multiple && h('div', { className: 'library-selection', role: 'status' },
      h('span', null, selected.length + ' selected' + (hidden ? ' · ' + hidden + ' hidden' : '')),
      h('button', { type: 'button', className: 'library-clear', onClick: () => { selection.clear(); focusRow(activeId); } }, 'Clear')),
    deletionNotice,
    menu && menuItem && h(LibraryMenu, { key: menu.id, id: menuId, menu, close: closeMenu },
      menu.kind !== 'folder' && !pushUnavailable && menuButton(pathsMode ? 'Push path…' : 'Push routine…', () => {
        // The review returns focus to its origin: the menu's trigger, or the row when the menu came from a right-click.
        closeMenu(true);
        if (!document.activeElement || document.activeElement === document.body || document.activeElement.closest('.library-menu')) {
          [...(root.current?.querySelectorAll('[data-library-item]') || [])].find((row) => row.dataset.libraryItem === menuItem.id)?.focus();
        }
        controller.requestPush(pathsMode ? { kind: 'paths', pathIds: [menuItem.id] } : { kind: 'routine', routineId: menuItem.id });
      }, { disabled: controller.busy || controller.desktopAvailable === false || (pathsMode && (menuItem.waypoints?.length || 0) < 2) }),
      menu.kind === 'path' && menuButton('Export BDX…', () => { const pathId = menuItem.id; setMenu(null); actions.exportPath(pathId); }, { disabled: controller.desktopAvailable === false }),
      menu.kind !== 'folder' && h('hr'),
      menuButton('Rename', () => rename(menu.kind, menuItem)),
      menu.kind !== 'folder' && menuButton('Duplicate', () => create(menu.kind, () => pathsMode ? actions.duplicatePath(menuItem.id) : actions.duplicateRoutine(menuItem.id))),
      menu.kind === 'path' && menuButton('Append path', () => create('path', () => actions.appendPath(menuItem.id)), {
        disabled: !menuItem.waypoints.length, title: !menuItem.waypoints.length ? 'Place a waypoint before appending a path' : undefined }),
      menu.kind === 'path' && menuButton('Link points…', () => { closeMenu(true); actions.openPointLinks(menuItem.id); }),
      menu.kind === 'path' && menuButton('Move to folder…', () => { setPropertiesId(menuItem.id); setMenu(null); }),
      menu.kind === 'folder' && menuButton('New path', () => create('path', () => actions.addPath(menuItem.id))),
      h('hr'), menuButton(menu.kind === 'folder' ? 'Delete folder' : 'Delete', () => remove(menu.kind, menuItem), { className: 'danger' })),
    properties && h(PathProperties, { item: properties, project, actions, close: () => { setPropertiesId(null); focusRow(propertiesId); } }));
}
