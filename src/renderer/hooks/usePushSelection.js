import * as React from 'react';

const { useEffect, useRef, useState } = React;
const memory = new Map();
const EMPTY = Object.freeze({ checked: [], selectionActiveId: null });
const storageKey = (preferenceKey) => 'bordeaux.pushSelection.' + preferenceKey;
// The selection used to live in the paths library preferences; read it once so an existing choice survives.
const legacyKey = (preferenceKey) => 'bordeaux.library.' + preferenceKey + '.paths';

const clean = (value) => ({
  checked: Array.isArray(value?.checked) ? value.checked.filter((id) => typeof id === 'string') : [],
  selectionActiveId: typeof value?.selectionActiveId === 'string' ? value.selectionActiveId : null,
});

/** The stored choice for a project (session memory first, then this key, then the older library preference). */
export function readPushSelection(preferenceKey) {
  if (memory.has(preferenceKey)) return memory.get(preferenceKey);
  try {
    const own = localStorage.getItem(storageKey(preferenceKey));
    return clean(JSON.parse(own ?? localStorage.getItem(legacyKey(preferenceKey)) ?? '{}'));
  } catch (_) { return EMPTY; }
}

/** The chosen paths in project order; unknown or deleted IDs drop out. */
export function selectedPathIds(paths, checkedIds) {
  const checked = new Set(checkedIds);
  return paths.filter((path) => checked.has(path.id)).map((path) => path.id);
}

/** What Push sends for the open path: the stored choice if it was made for that path, otherwise the open path alone. */
export function effectiveSelection(stored, paths, activePathId) {
  const checked = stored.selectionActiveId === activePathId ? selectedPathIds(paths, stored.checked) : [];
  return checked.length ? checked : activePathId ? [activePathId] : [];
}

/** The stored choice without deleted or unknown paths, or null when nothing needs pruning (or it is another path's). */
export function prunedSelection(stored, paths, activePathId) {
  if (stored.selectionActiveId !== activePathId) return null;
  const kept = selectedPathIds(paths, stored.checked);
  return kept.length === stored.checked.length ? null : { checked: kept, selectionActiveId: activePathId };
}

/**
 * Which paths Push sends. Owned by App so the library (which edits it) and the toolbar Push control (which sends it)
 * share one value. A multiple choice belongs to the path that was open when it was made: opening another path, or a
 * choice made for a different open path, falls back to the open path alone. Persisted per project like the library.
 */
export function usePushSelection({ preferenceKey, paths, activePathId }) {
  const [state, setState] = useState(() => ({ key: preferenceKey, ...readPushSelection(preferenceKey) }));
  const current = state.key === preferenceKey ? state : { key: preferenceKey, ...readPushSelection(preferenceKey) };
  if (current !== state) setState(current);
  // A write waits 200 ms before reaching localStorage, like the library preferences. It is flushed, never dropped, on
  // unmount and when a write for another project arrives, and it always lands under the project it was made for.
  const timer = useRef(null), pending = useRef(null);
  const persist = () => {
    clearTimeout(timer.current); timer.current = null;
    const entry = pending.current; pending.current = null;
    if (entry) { try { localStorage.setItem(storageKey(entry.key), JSON.stringify(entry.value)); } catch (_) { /* Session-only is acceptable. */ } }
  };
  const write = (next) => {
    const value = clean(next);
    memory.set(preferenceKey, value);
    setState({ key: preferenceKey, ...value });
    if (pending.current && pending.current.key !== preferenceKey) persist();
    pending.current = { key: preferenceKey, value };
    clearTimeout(timer.current);
    timer.current = setTimeout(persist, 200);
  };
  // persist only reads refs, so the first render's copy is current at unmount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => persist, []);

  // Opening another path (in the same project) resets the choice to that path.
  const opened = useRef({ key: preferenceKey, id: activePathId });
  useEffect(() => {
    const previous = opened.current;
    opened.current = { key: preferenceKey, id: activePathId };
    if (previous.key === preferenceKey && previous.id !== activePathId && activePathId) write({ checked: [activePathId], selectionActiveId: activePathId });
  // write is recreated each render; the open path and project are the triggers.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferenceKey, activePathId]);

  // Deleted paths leave the stored choice, as the library always pruned them, so undoing a deletion does not quietly
  // put the restored path back into Push. Only a choice made for the open path is pruned; a choice for another path
  // is already ignored and is replaced when that path opens.
  useEffect(() => {
    const pruned = prunedSelection(current, paths, activePathId);
    if (pruned) write(pruned);
  // write and current belong to this render; the paths, project and open path are the triggers.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paths, preferenceKey, activePathId]);

  const selected = effectiveSelection(current, paths, activePathId);
  return {
    selected,
    multiple: selected.length > 1,
    /** Choose exactly these paths for the open path (an empty list means the open path alone). */
    set: (ids) => write({ checked: ids, selectionActiveId: activePathId }),
    /** A plain choice of one path, which is about to become the open path. */
    open: (id) => write({ checked: [id], selectionActiveId: id }),
    clear: () => write({ checked: activePathId ? [activePathId] : [], selectionActiveId: activePathId }),
  };
}
