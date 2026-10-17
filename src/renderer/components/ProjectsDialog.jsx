import * as React from 'react';
import { createPortal } from 'react-dom';
import { UI } from './ui';
import { shortcutLabel } from '../lib/shortcuts';
import { firstFact, homeRelative, parentLocation, shortFact } from './ProjectChip';
import { RECOVERY_FULL, changedSourceFact, creationFailure, departureCopy, originLocation, receiptTime, recoveryStatusWord, recoveryToken } from '../lib/projectLifecycle';

const h = React.createElement;
const { Icon } = UI;
const { useEffect, useLayoutEffect, useRef, useState } = React;

const STATUS_WORD = { 'not-found': 'Missing', 'not-readable': 'No access', 'size-limit': 'Too large', 'unsafe-entry': 'Not a regular file', 'invalid-project': 'Not a project' };
// Only an unreadable entry can start working by itself; every other unavailable entry is fixed by locating the project.
const locates = (row) => row.status === 'missing' || (row.status === 'invalid' && row.code !== 'not-readable');
const BAD_NAME = /[<>:"/\\|?*\u0000-\u001f]|[. ]$/;
const trimmed = (place) => place ? place.replace(/[\\/]+$/, '') : null;
// A nullable save target cannot identify a legacy document or an empty folder.
// Compare the explicit source first, otherwise the managed workspace/save file.
const documentFile = (location) => trimmed(location?.legacyFile || location?.projectPath);
export const sameProject = (location, current) => Boolean(location && current?.folderPath && trimmed(location.folderPath) === trimmed(current.folderPath)
  && documentFile(location) && documentFile(location) === documentFile(current));
// Where the project lives, not its name again: the parent folder, or the file itself for a standalone legacy project.
export const locationHint = (location) => !location?.folderPath ? 'Not saved'
  : location.legacyFile ? homeRelative(location.legacyFile)
  : location.projectPath && !/[\\/]\.bordeaux-workspace\.json$/.test(location.projectPath) ? homeRelative(location.projectPath) : parentLocation(location.folderPath);
const nameError = (name) => !name.trim() ? 'Name the project' : BAD_NAME.test(name.trim()) ? 'Avoid / \\ : * ? " < > |' : '';
// A long project name keeps its start and end in one line.
const middle = (text) => text.length > 28 ? text.slice(0, 13) + '…' + text.slice(-14) : text;
const rowKey = (row) => row.current ? 'current' : row.id;
const fileManager = () => typeof window !== 'undefined' && window.bordeauxAPI?.platform === 'win32' ? 'Show in Explorer' : 'Show in Finder';
// A row's actions, in the app's context-menu shape: under its … (or at the pointer), inside the sheet so it stays in the
// modal's layer. Escape and Tab return focus to the …; a press elsewhere, a scroll, or leaving the window closes it.
function RowMenu({ menu, label, items, onClose }) {
  const ref = useRef(null), [place, setPlace] = useState(null);
  useLayoutEffect(() => {
    const box = ref.current.getBoundingClientRect(), anchor = menu.anchor.getBoundingClientRect();
    const x = menu.point ? menu.point.x : anchor.right - box.width, y = menu.point ? menu.point.y : anchor.bottom + 4;
    const top = y + box.height > window.innerHeight - 8 && !menu.point ? anchor.top - 4 - box.height : y;
    setPlace({ left: Math.max(8, Math.min(x, window.innerWidth - box.width - 8)), top: Math.max(8, Math.min(top, window.innerHeight - box.height - 8)) });
  }, [menu]);
  useEffect(() => { if (place) ref.current.querySelector('button')?.focus({ preventScroll: true }); }, [!place]);
  useEffect(() => {
    const away = (event) => { if (!ref.current?.contains(event.target) && !menu.anchor.contains(event.target)) onClose(false); };
    const moved = (event) => { if (!ref.current?.contains(event.target)) onClose(false); };
    document.addEventListener('pointerdown', away, true); document.addEventListener('scroll', moved, true); window.addEventListener('resize', moved); window.addEventListener('blur', moved);
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('scroll', moved, true); window.removeEventListener('resize', moved); window.removeEventListener('blur', moved); };
  }, [menu]);
  return h('div', { ref, id: 'pj-row-menu', className: 'ctxmenu pj-row-menu', role: 'menu', 'aria-label': label, style: place || { visibility: 'hidden' },
    onContextMenu: (event) => event.preventDefault(),
    onKeyDown: (event) => {
      event.stopPropagation();
      if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); onClose(true); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...ref.current.querySelectorAll('button')], index = buttons.indexOf(document.activeElement);
      buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
    } },
    items.map((item) => h('button', { key: item.key, type: 'button', role: 'menuitem', tabIndex: -1, className: 'ctxmenu-i', 'data-row-action': item.key, onClick: () => { onClose(true); item.run(); } }, item.label)));
}
const progressWord = (pending, queued) => (pending.phase === 'saving' ? 'Saving…' : 'Opening…') + (queued ? ' · ' + departureCopy(queued).queued : '');

// What a recovery copy is, from main's listing only:
// - open: unsaved edits (restore or discard);
// - current: this window's own copy, only when it is exactly the session's current record (Manage lists it);
// - busy: any other copy main won't let go of now (a retired branch still writing), so nothing claims it is this window's;
// - saved: its edits were saved (Manage only); unavailable: unreadable, shown in the file manager.
// A row without `discardable` (an older main) restores but is never inferred to be in use or discardable.
// Queued catalog work whose owner let go (closed sheet, newer listing, ended reservation) never reaches main.
const RETIRED = Symbol('retired');
const KIND_ORDER = { open: 0, current: 1, busy: 2, saved: 3, unavailable: 4 };
const KIND_WORD = { current: 'Open now', busy: 'In use', saved: 'Saved' };
export function recoveryKind(entry, currentRecordId = null) {
  if (!entry.available) return 'unavailable';
  if (currentRecordId && entry.recordId === currentRecordId) return 'current';
  if (entry.discardable === false) return 'busy';
  return entry.resolved ? 'saved' : 'open';
}
// Recovered edits come first. Healthy copies restore; unreadable ones can only be shown in the file manager.
// Several copies of one origin sit together newest first; minutes gain seconds only when two share a minute. Manage groups
// copies by kind (unsaved first), newest first within each.
export function recoveryRows(listing, { manage = false, currentRecordId = null } = {}) {
  if (!listing || !Array.isArray(listing.entries)) return [];
  const newest = (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  const entries = listing.entries.map((entry) => ({ entry, kind: recoveryKind(entry, manage ? currentRecordId : null) }))
    .sort((a, b) => (manage ? KIND_ORDER[a.kind] - KIND_ORDER[b.kind] : 0) || newest(a.entry, b.entry));
  const minutes = entries.map(({ entry }) => receiptTime(entry.updatedAt));
  return entries.map(({ entry, kind }, index) => {
    const origin = originLocation(entry.origin);
    return { id: 'recovery:' + entry.id, entry, kind, recovery: true, name: entry.name, status: entry.available ? 'available' : 'invalid',
      discardable: kind !== 'current' && entry.available && entry.discardable === true,
      // An unreadable record may carry no origin; it then shows no location rather than a wrong one.
      hint: !entry.origin ? '' : entry.origin.kind === 'untitled' ? 'Not in a folder' : locationHint(origin) + (entry.originStatus === 'missing' ? ' · missing' : ''),
      time: receiptTime(entry.updatedAt, { seconds: minutes.filter((value) => value === minutes[index]).length > 1 }), updatedAt: entry.updatedAt };
  });
}
/** Main's capacity as a count: records, or megabytes when the byte limit is what binds. */
export function recoveryUsage(capacity) {
  if (!capacity) return '';
  const mb = (bytes) => Math.round(bytes / (1024 * 1024));
  const byBytes = capacity.bytes >= capacity.byteLimit && capacity.recordCount < capacity.recordLimit;
  return (byBytes ? mb(capacity.bytes) + ' of ' + mb(capacity.byteLimit) + ' MB' : capacity.recordCount + ' of ' + capacity.recordLimit) + (capacity.full ? ' · full' : '');
}

// The Projects sheet (⌘O), New project (⌘N) and Save copy (New's form for a copy of the current project). Rows are
// real buttons with roving focus, so status rows keep their one fix (Locate… or Retry) as the row's own action instead
// of a control nested in a disabled option. Every switch goes through App's guard; a blocked switch shows the current
// project's fix here instead.
export function ProjectsDialog({ request, current, actions, pending, queuedDeparture, onClose }) {
  const dialog = useRef(null), search = useRef(null), nameInput = useRef(null), locationButton = useRef(null), retryButton = useRef(null);
  const composing = useRef(false), alive = useRef(true), startupFocused = useRef(false), acknowledged = useRef(new Set());
  const firstUse = Boolean(request.firstUse);
  const [mode, setMode] = useState(request.mode === 'copy' ? 'new' : request.mode);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [recents, setRecents] = useState({ status: 'pending', entries: [] });
  // A listing that failed (whole storage unreadable) is an honest error, never an empty list.
  const listingState = (listing) => listing?.error ? { status: 'error', entries: [], error: listing.error.fact || 'Recovered edits are unavailable' }
    : { status: 'ready', entries: Array.isArray(listing?.entries) ? listing.entries : [], limited: Boolean(listing?.limited), capacity: listing?.capacity || null };
  const [recoveries, setRecoveries] = useState(() => request.recoveries ? listingState(request.recoveries) : { status: actions.listRecoveries ? 'pending' : 'none', entries: [] });
  const [block, setBlock] = useState(request.notice || null);
  const [rowError, setRowError] = useState(null);
  // One row menu at a time: { key, anchor, point }. It closes with its row, a mode change, or any switch in flight.
  const [menu, setMenu] = useState(null), menuRef = useRef(null);
  const [draft, setDraft] = useState({ name: 'New project', parent: null, parentStatus: 'pending', sameRobot: !firstUse, error: '', errorField: 'name' });
  // Save copy keeps its own values (New's draft stays as it was). Each entry into it is one object: its owner (this exact
  // document, read fresh), the blocked switch it continues, and the fields edited by hand. A mode or request change, or
  // closing, retires it; defaults, picker replies, results and focus act only for their own entry (and submission).
  const copyStart = (carried) => ({ name: current.name + (current.untitled ? '' : ' copy'), parent: null, parentStatus: 'pending', error: '', errorField: 'name', carried });
  const [copy, setCopy] = useState(() => request.mode === 'copy' ? copyStart() : null);
  const entry = useRef(null), submitting = useRef(null);
  const entryOwns = (e) => alive.current && entry.current === e && (!e?.owner || actions.ownsCopy(e.owner));
  const enteredNew = useRef(mode === 'new'), enteredManage = useRef(request.mode === 'recoveries');
  // Manage: this window's own copy, read from main's session when the copies are listed (its id can change when a saved
  // slot is reused), never from an earlier render.
  const [currentRecord, setCurrentRecord] = useState(null);
  // Discard is two explicit steps on one row: main reserves the exact displayed copy, then a separate press discards it.
  // One confirmation at a time; listing again would retire its token, so refreshes wait until it ends. Every catalog
  // call runs in order, so a refresh never races a reservation.
  const [confirm, setConfirm] = useState(null);
  const [said, setSaid] = useState('');
  // Show file's failure belongs to the exact block it was pressed in; a newer block never inherits it.
  const [revealFact, setRevealFact] = useState(null);
  const revealing = useRef(null), revealOwner = useRef(null);
  if (!revealOwner.current || revealOwner.current.block !== block || revealOwner.current.request !== request || revealOwner.current.pending !== pending || revealOwner.current.mode !== mode) revealOwner.current = { block, request, pending, mode };
  const confirmRef = useRef(null), refreshLater = useRef(false), catalog = useRef(Promise.resolve()), listSequence = useRef(0), modeRef = useRef(mode), retryList = useRef(null);
  modeRef.current = mode;
  // Listing or preparing retires main's current displayed set or token, so each queued call checks, as it starts, that this
  // sheet is open and its owner still holds it; otherwise it resolves RETIRED without calling main.
  // Each interaction (a reservation starting, changing or ending; a mode or request change; the sheet closing) takes a new
  // number. An older continuation acts only while the number it captured is still current, so its ownership, once
  // retired, never comes back even if the sheet later looks the same again.
  const interaction = useRef(0);
  const searchInput = useRef(0);
  const inOrder = (call, owns) => { const next = catalog.current.catch(() => undefined).then(() => alive.current && owns() ? call() : RETIRED); catalog.current = next; return next; };
  const setConfirmation = (next) => { interaction.current += 1; confirmRef.current = next; setConfirm(next); };
  // A key, pointer press, or text change takes search back from a pending Retry's parked focus.
  const searchInteraction = () => { searchInput.current += 1; };

  const list = () => actions.listRecent().then(
    (entries) => alive.current && setRecents({ status: 'ready', entries: Array.isArray(entries) ? entries : [] }),
    (error) => alive.current && setRecents({ status: 'error', entries: [], error: shortFact(error) }));
  // A failed listing unmounts the rows: if focus left with them, the list's Retry takes it (only for this same listing).
  const dropped = () => !document.activeElement || document.activeElement === document.body;
  // `holder` is where Retry parked focus before its error line unmounted; a failure then returns focus to Retry from there.
  const focusRetry = (owns, holder) => requestAnimationFrame(() => { if (owns() && (dropped() || (holder && document.activeElement === holder))) retryList.current?.focus(); });
  // Resolves to the listing this sheet now shows, null when deferred or retired, or { error } when it failed.
  const listRecoveries = (holder) => {
    if (!actions.listRecoveries) return Promise.resolve(null);
    if (confirmRef.current) { refreshLater.current = true; return Promise.resolve(null); }
    const sequence = ++listSequence.current, manage = modeRef.current === 'recoveries', owns = () => alive.current && sequence === listSequence.current;
    // The row that had focus when this listing began: if a ready listing removes it (Finder, another window), focus goes
    // to the nearest remaining row, or Back/search when none remain, but only if nothing newer happened meanwhile.
    const mine = interaction.current, searchAtStart = searchInput.current, focusedRow = Number(document.activeElement?.closest?.('[data-row]')?.dataset.row);
    const ownsFocus = () => owns() && interaction.current === mine && searchInput.current === searchAtStart;
    return inOrder(async () => {
      const [listing, session] = await Promise.all([actions.listRecoveries(manage ? { includeResolved: true } : undefined),
        manage && actions.currentRecoveryId ? actions.currentRecoveryId().catch(() => null) : null]);
      if (!owns()) return null;
      setRecoveries(listingState(listing));
      if (manage) setCurrentRecord(session);
      if (listing?.error) focusRetry(ownsFocus, holder);
      else {
        actions.recoveryCapacity?.(listing?.capacity || null);
        if (Number.isInteger(focusedRow)) focusAt(focusedRow, () => ownsFocus() && dropped());
      }
      return listing;
    }, owns).then((listing) => listing === RETIRED ? null : listing, (error) => {
      if (!owns()) return null;
      setRecoveries({ status: 'error', entries: [], error: shortFact(error) }); focusRetry(ownsFocus, holder);
      return { error: { fact: shortFact(error) } };
    });
  };
  // Ends a confirmation without discarding; a refresh asked for meanwhile runs now (unless another row takes over).
  const endConfirm = ({ refresh = true } = {}) => {
    setConfirmation(null);
    if (refresh && refreshLater.current) { refreshLater.current = false; void listRecoveries(); }
  };
  useEffect(() => {
    alive.current = true;
    dialog.current.showModal();
    void list();
    if (!request.recoveries || request.mode === 'recoveries') void listRecoveries();
    else actions.recoveryCapacity?.(request.recoveries.capacity || null);
    actions.creationDefaults().then((defaults) => setDraft((d) => d.parent ? d : { ...d, parent: defaults.parentDirectory, parentStatus: 'ready' }),
      () => setDraft((d) => ({ ...d, parentStatus: 'error' })));
    return () => { alive.current = false; interaction.current += 1; };
  }, []);
  useEffect(() => {
    interaction.current += 1;
    if (request.mode === 'copy') enterCopy(); else { entry.current = null; setCopy(null); setMode(request.mode); }
    if (request.notice) setBlock(request.notice);
  }, [request]);
  useEffect(() => {
    if (mode === 'new') { nameInput.current?.focus(); nameInput.current?.select(); } else if (mode === 'list') search.current?.focus();
  }, [mode, !copy]);
  // After Show file, the person may remove copies in Finder or Explorer; coming back lists them again.
  useEffect(() => {
    const again = () => { if (modeRef.current !== 'new') void listRecoveries(); };
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, []);
  // Manage lists every retained copy; leaving it lists the default (unsaved) view again. Any confirmation ends first.
  const switchMode = (next) => {
    entry.current = null; setCopy(null);
    const crossing = (modeRef.current === 'recoveries') !== (next === 'recoveries');
    // (setConfirmation also retires every earlier continuation.)
    setConfirmation(null); refreshLater.current = false; setRowError(null); setSaid('');
    if (next === 'recoveries') setQuery('');
    modeRef.current = next; setMode(next);
    if (crossing) { setRecoveries({ status: 'pending', entries: [] }); void listRecoveries(); }
  };
  const showManage = () => { if (!pending && modeRef.current !== 'recoveries') switchMode('recoveries'); };
  const leaveManage = () => {
    if (pending) return;
    if (enteredManage.current) onClose(); else switchMode('list');
  };

  // Recovered edits, then the current project, then openable recents, then the ones that need a fix. Manage shows copies only.
  const manage = mode === 'recoveries';
  const recovered = manage ? recoveryRows(recoveries.status === 'ready' ? recoveries : null, { manage: true, currentRecordId: currentRecord })
    : recoveryRows(recoveries.status === 'ready' ? { ...recoveries, entries: recoveries.entries.filter((entry) => !current.recoveryRecordId || entry.recordId !== current.recoveryRecordId) } : null);
  const rows = manage ? recovered : (() => {
    const entries = recents.entries.map((entry) => ({ ...entry, current: sameProject(entry.location, current), hint: locationHint(entry.location) }));
    const top = entries.find((entry) => entry.current) || { id: 'current', current: true, status: 'available', name: current.name, hint: locationHint(current) };
    const rest = entries.filter((entry) => !entry.current);
    const all = [...recovered, top, ...rest.filter((entry) => entry.status === 'available'), ...rest.filter((entry) => entry.status !== 'available')];
    const q = query.trim().toLowerCase();
    return q ? all.filter((row) => (row.name + ' ' + row.hint).toLowerCase().includes(q)) : all;
  })();
  const recoveryCount = rows.filter((row) => row.recovery).length;
  const at = Math.min(active, Math.max(0, rows.length - 1));
  useEffect(() => { setActive(0); }, [query]);
  // Rows keep their element when lists arrive (keys are stable), so a focused row stays focused;
  // the roving index then follows that row to its new position.
  useLayoutEffect(() => {
    const focused = document.activeElement?.closest?.('[data-row]');
    if (focused && dialog.current?.contains(focused) && Number(focused.dataset.row) !== active) setActive(Number(focused.dataset.row));
  }, [recents, recoveries]);

  const focusRow = (index) => {
    const next = Math.max(0, Math.min(rows.length - 1, index));
    setActive(next);
    requestAnimationFrame(() => dialog.current?.querySelector('[data-row="' + next + '"] .pj-open')?.focus());
  };
  // Manage: the first copy takes focus once the copies are in (Back when there are none).
  const manageFocused = useRef(false);
  useEffect(() => {
    if (mode !== 'recoveries') { manageFocused.current = false; return; }
    if (manageFocused.current || recoveries.status === 'pending') return;
    manageFocused.current = true;
    if (rows.length) focusRow(0); else requestAnimationFrame(() => dialog.current?.querySelector('[data-action="manage-back"]')?.focus());
  }, [mode, recoveries.status]);
  // Startup: the row that explains the start takes focus once its list is in (no banner; the row is the message).
  useEffect(() => {
    const focus = request.startup?.focus;
    if (startupFocused.current || !focus || mode !== 'list') return;
    if (focus === 'recovery' && recoveries.status === 'ready' && recovered.length) { startupFocused.current = true; focusRow(rows.findIndex((row) => row.recovery)); }
    else if (focus === 'recent' && recents.status !== 'pending') {
      startupFocused.current = true;
      const index = rows.findIndex((row) => row.id === request.startup.recentId);
      if (index >= 0) focusRow(index); else search.current?.focus();
    }
  }, [recents, recoveries, mode]);
  // Recovered edits… after a Reload: the kept copy's own row takes focus once, wherever it sorts; without it, the default.
  const recordFocused = useRef(false);
  useEffect(() => {
    if (recordFocused.current || !request.focusRecordId || mode !== 'list' || recoveries.status === 'pending') return;
    recordFocused.current = true;
    const index = rows.findIndex((row) => row.recovery && row.entry?.recordId === request.focusRecordId);
    if (index >= 0) focusRow(index);
  }, [recoveries, mode]);
  // Offer once: acknowledge exactly the recovered rows rendered in the list (not filtered-out, current or unlisted
  // records), as they appear; the complete listing only bounds what stays remembered.
  const renderedRecoveries = mode === 'list' ? rows.filter((row) => row.recovery).map((row) => row.entry) : [];
  const renderedKey = renderedRecoveries.map(recoveryToken).join('|');
  useEffect(() => {
    const fresh = renderedRecoveries.filter((entry) => !acknowledged.current.has(recoveryToken(entry)));
    if (!fresh.length || recoveries.status !== 'ready') return;
    for (const entry of fresh) acknowledged.current.add(recoveryToken(entry));
    actions.recoveriesShown?.(fresh, recoveries.entries);
  }, [renderedKey, recoveries]);

  // App owns the attempt (`pending`) and refuses a second one. A blocked switch shows its fix; Retry repeats it.
  // A Save copy submission `s` completes only while it is still its entry's latest press; a fact goes to its own field.
  const attempt = async (run, rowId, options, s) => {
    if (pending) return;
    setRowError(null);
    const mine = () => alive.current && (!s || (entry.current === s.e && submitting.current === s));
    const slotFact = (error) => {
      const failure = creationFailure(error);
      (s ? setCopy : setDraft)((d) => ({ ...d, error: failure.fact, errorField: failure.field }));
      requestAnimationFrame(() => { if (!mine()) return; if (failure.field === 'location') locationButton.current?.focus(); else { nameInput.current?.focus(); nameInput.current?.select(); } });
    };
    try {
      const result = await run({ ...options, owner: rowId || 'sheet' });
      if (!mine() || result?.busy) return;
      if (result?.copyFailed) return slotFact(result.copyFailed);
      if (result?.copied) { setBlock(null); onClose(); return; }
      // A carried copy is saved; the rest is the switch's own result, shown in the list.
      if (s?.copied) switchMode('list');
      if (result?.blocked) {
        // The same block coming straight back after its own Retry says so, and keeps focus on Retry (as it takes it from
        // a carried copy's form).
        setBlock((previous) => ({ ...result, run, rowId, repeat: options?.retry && previous?.blocked === result.blocked ? (previous.repeat || 1) + 1 : 1 }));
        if (options?.retry || s?.copied) requestAnimationFrame(() => retryButton.current?.focus());
      } else if (result?.opened) { setBlock(null); onClose(rowId?.startsWith?.('recovery:') ? 'restored' : undefined); }
      else if (options?.retry) setBlock(null);
    } catch (error) {
      if (!mine()) return;
      // A saved carried copy is already this document's target, and a block's own Retry runs from the list: either way
      // the switch's failure is the list's block (from a row, or New's Create, too), the same block again after its Retry,
      // and its Retry repeats only the switch.
      if (s?.copied || options?.retry) {
        if (s) switchMode('list');
        setBlock((previous) => ({ blocked: 'error', message: firstFact(error), run, rowId,
          ...(options?.retry && { repeat: previous?.blocked === 'error' ? (previous.repeat || 1) + 1 : 1 }) }));
        requestAnimationFrame(() => retryButton.current?.focus());
        return;
      }
      if (rowId === 'new' || s) return slotFact(error);
      if (rowId) setRowError({ id: rowId, message: shortFact(error) });
      else setBlock({ blocked: 'error', message: firstFact(error), run, rowId });
    }
  };
  const press = (row) => {
    if (row.recovery) {
      // This window's own copy has nothing to restore; a row being confirmed only answers Back or Discard.
      if (row.kind === 'current' || confirmRef.current?.id === row.id) return;
      if (row.entry.available) void attempt((options) => actions.restoreRecovery(row.entry.id, options), row.id);
      else void Promise.resolve(actions.revealRecovery?.(row.entry.id)).catch((error) => setRowError({ id: row.id, message: shortFact(error) }));
      return;
    }
    if (row.current) { dismiss(); return; }
    if (locates(row)) {
      // Locate opens the moved or replaced project's folder; the stale row then leaves the local list.
      void attempt(async (options) => {
        const result = await actions.openFolder(options);
        if (result?.opened) await actions.removeRecent(row.id).catch(() => undefined);
        return result;
      }, row.id);
      return;
    }
    void attempt((options) => actions.openRecent(row.id, options), row.id);
  };
  // Focus the row now at `index` once a fresh list has rendered (the row count may have changed), else search; never once
  // its continuation has lost the sheet.
  const focusAt = (index, owns) => requestAnimationFrame(() => {
    if (!owns()) return;
    const opens = [...(dialog.current?.querySelectorAll('[data-row] .pj-open') || [])];
    const target = opens[Math.max(0, Math.min(index, opens.length - 1))];
    if (target) { setActive(Number(target.closest('[data-row]').dataset.row)); target.focus(); }
    else (search.current || dialog.current?.querySelector('[data-action="manage-back"]'))?.focus();
  });
  // Step one (× or Delete/Backspace): main reserves exactly this displayed copy. Nothing is deleted.
  const startDiscard = async (row) => {
    if (pending || !row.discardable || !actions.prepareDiscard || confirmRef.current?.phase === 'discarding') return;
    if (confirmRef.current?.id === row.id) return;
    const reserving = { id: row.id, name: row.name, time: row.time, phase: 'reserving' };
    // Another row's confirmation simply ends; its refresh waits for this one, so this reservation stays valid.
    setRowError(null); setSaid(''); setConfirmation(reserving);
    try {
      const reserved = await inOrder(() => actions.prepareDiscard(row.entry.id), () => confirmRef.current === reserving);
      if (reserved === RETIRED || !alive.current || confirmRef.current !== reserving) return;
      setConfirmation({ ...reserving, phase: 'confirm', token: reserved.token, context: reserved.context });
    } catch (error) { if (confirmRef.current === reserving) void settle(reserving, null, error, rows.findIndex((item) => item.id === row.id)); }
  };
  // A reservation or discard has ended: list again (main's token is spent either way), then say what happened truthfully.
  // If a newer confirmation, mode or sheet took over meanwhile, this older outcome neither speaks nor moves focus.
  const settle = async (confirmed, result, failure, index) => {
    if (!alive.current) return;
    setConfirmation(null); refreshLater.current = false;
    const mine = interaction.current, searchAtStart = searchInput.current, owns = () => alive.current && interaction.current === mine;
    const listing = await listRecoveries();
    if (!owns()) return;
    // The same words in every branch; where no row can carry the outcome (a failed list, or the copy no longer listed),
    // the status line says it, and a failed list's Retry keeps focus.
    const named = '“' + confirmed.name + '”', done = result?.removed === true ? 'Discarded copy of ' + named : '', failed = failure ? 'Couldn’t discard · ' + firstFact(failure) : '';
    if (listing?.error) { setSaid(done || named + ' · ' + (failed || 'Copy changed · not discarded')); return; }
    const listed = !listing || listing.entries?.some((entry) => 'recovery:' + entry.id === confirmed.id);
    if (done) setSaid(done);
    else if (!listed) setSaid(named + ' is no longer listed · ' + (failed || 'nothing discarded'));
    else setRowError({ id: confirmed.id, message: failed || 'Copy changed · not discarded' });
    focusAt(index, () => owns() && searchInput.current === searchAtStart);
  };
  // Back: the row returns as it was, focused. Nothing was deleted.
  const cancelDiscard = () => {
    const confirmed = confirmRef.current;
    if (!confirmed || confirmed.phase === 'discarding') return;
    const index = rows.findIndex((item) => item.id === confirmed.id);
    endConfirm();
    if (index >= 0) focusRow(index);
  };
  // Step two, only from its own button: main deletes the copy it reserved, if it is still exactly that copy.
  const discard = async () => {
    const confirmed = confirmRef.current;
    if (!confirmed || confirmed.phase !== 'confirm' || pending) return;
    const discarding = { ...confirmed, phase: 'discarding' }, index = rows.findIndex((item) => item.id === confirmed.id);
    setConfirmation(discarding);
    let result = null, failure = null;
    try { result = await inOrder(() => actions.discard(confirmed.token, confirmed.context), () => confirmRef.current === discarding); } catch (error) { failure = error; }
    if (result !== RETIRED && confirmRef.current === discarding) void settle(confirmed, result, failure, index);
  };
  // A confirmation ends when focus or a press goes anywhere outside its row.
  const leaveConfirm = (event) => {
    const confirmed = confirmRef.current;
    if (!confirmed || confirmed.phase === 'discarding' || event.target.closest?.('[data-confirm]')) return;
    endConfirm({ refresh: !event.target.closest?.('.pj-remove') });
  };
  useLayoutEffect(() => {
    if (confirm?.phase === 'confirm') dialog.current?.querySelector('[data-confirm] [data-recovery="back"]')?.focus();
  }, [confirm?.phase, confirm?.id]);

  // Removing a recent only changes the list; a recovered copy is discarded only through its two steps.
  const remove = async (row, index) => {
    if (pending || row.recovery) return;
    try { await actions.removeRecent(row.id); } catch (error) { setRowError({ id: row.id, message: shortFact(error) }); return; }
    await list();
    if (rows.length > 2) focusRow(Math.min(index, rows.length - 2)); else search.current?.focus();
  };
  // Show in Finder/Explorer is read-only and keeps focus on the row's …; its failure is the row's own fact, and only for the
  // sheet, request, block and switch it was chosen in.
  const revealRow = async (row) => {
    if (pending) return;
    const shown = revealOwner.current, turn = ++interaction.current;
    setRowError(null);
    let result;
    try { result = await (row.id === 'current' ? actions.revealCurrent() : actions.revealRecent(row.id)); } catch (error) { result = { fact: shortFact(error) }; }
    if (alive.current && revealOwner.current === shown && interaction.current === turn && !result?.revealed) setRowError({ id: row.id, message: result?.fact || 'Couldn’t show project' });
  };
  // Show only where main can find a real folder or file: a listed recent, or this window's own saved project. Save copy…
  // is the current row's, through the same guarded entry as the chip; Remove from list only changes the list.
  const rowItems = (row, index) => row.recovery ? [] : [
    row.status === 'available' && (row.id === 'current' ? current.folderPath && actions.revealCurrent : actions.revealRecent) && { key: 'reveal', label: fileManager(), run: () => void revealRow(row) },
    row.current && actions.copyOwner && { key: 'save-copy', label: current.untitled ? 'Save…' : 'Save copy…', run: () => enterCopy() },
    !row.current && { key: 'remove', label: 'Remove from list', run: () => void remove(row, index) },
  ].filter(Boolean);
  const closeMenu = (refocus) => {
    const open = menuRef.current;
    menuRef.current = null; setMenu(null);
    if (refocus && open?.anchor.isConnected) open.anchor.focus();
  };
  // The … toggles its menu; right-click opens it at the pointer, ContextMenu or Shift+F10 under the …
  const openMenu = (row, index, anchor, point) => {
    if (pending || !anchor || !rowItems(row, index).length) return;
    if (menuRef.current?.key === rowKey(row)) { if (!point) closeMenu(true); return; }
    setActive(index);
    menuRef.current = { key: rowKey(row), anchor, point }; setMenu(menuRef.current);
  };
  const menuRow = menu && mode === 'list' && !pending ? rows.find((row) => rowKey(row) === menu.key) : null;
  const menuItems = menuRow ? rowItems(menuRow, rows.indexOf(menuRow)) : [];
  useEffect(() => {
    if (!menu || menuItems.length) return;
    const focused = dialog.current?.querySelector('#pj-row-menu')?.contains(document.activeElement) || dropped();
    menuRef.current = null; setMenu(null);
    if (focused) (menu.anchor.isConnected && !pending ? menu.anchor : search.current)?.focus();
  }, [menu, menuItems.length]);
  // Retry or Don't save runs inside the repeated attempt. The block stays in place while it runs, so a fast repeat failure
  // is visibly the same block again rather than a flash.
  const fixBlock = (options) => { if (!pending) void attempt(block.run, block.rowId, { ...options, retry: !options?.discard }); };
  // Save copy… or Save… from a block: the copy form, carrying the blocked switch. Its defaults arrive later and change only
  // fields not edited by hand; they never move focus.
  const enterCopy = (carried) => {
    if (pending) return;
    // Without the copy form (an older main, the browser) they stay the picker, inside the blocked switch, which then
    // decides itself whether anything still needs saving before it opens.
    if (!actions.copyOwner) {
      if (!carried) return;
      const save = carried.blocked === 'untitled' ? actions.save : actions.saveCopy;
      setBlock(null); (modeRef.current === 'new' ? nameInput : search).current?.focus();
      void attempt(carried.run, carried.rowId, { before: async () => { await save?.(); }, retry: false });
      return;
    }
    switchMode('new');
    const e = { carried, touched: {} };
    entry.current = e; setBlock(null); setCopy(copyStart(carried));
    actions.copyOwner().then((owner) => {
      if (!alive.current || entry.current !== e) return;
      e.owner = owner;
      return actions.copyDefaults({ context: owner.context, nameHint: current.name }).then((defaults) => {
        if (!entryOwns(e)) return;
        setCopy((c) => ({ ...c, ...(!e.touched.name && { name: defaults.name }), ...(!e.touched.parent && { parent: defaults.parentDirectory, parentStatus: 'ready' }) }));
        // A suggested name replaces the selected one; it stays selected, so typing still replaces it.
        if (!e.touched.name && document.activeElement === nameInput.current) requestAnimationFrame(() => entryOwns(e) && !e.touched.name && nameInput.current?.select());
      }, () => { if (entryOwns(e) && !e.touched.parent) setCopy((c) => ({ ...c, parentStatus: 'error' })); });
    }, () => { if (alive.current && entry.current === e) setCopy((c) => ({ ...c, error: 'The project changed', errorField: 'name', parentStatus: 'error' })); });
  };
  const form = copy || draft, setForm = copy ? setCopy : setDraft;
  // A submitted copy keeps its fields as sent until it settles: while pending, and from the press itself (before App's
  // pending state renders). Only this entry's own submission holds it, so a newer entry is never held by an older one.
  const copyHeld = () => Boolean(copy) && (Boolean(pending) || (submitting.current?.done === false && submitting.current.e === entry.current));
  const create = () => {
    if (pending || copyHeld()) return;
    const name = form.name.trim(), invalid = nameError(form.name);
    if (invalid || !form.parent) { setForm((d) => ({ ...d, error: invalid, errorField: 'name' })); nameInput.current?.focus(); return; }
    if (!copy) { void attempt((options) => actions.create({ name, parentDirectory: form.parent, sameRobot: form.sameRobot }, options), 'new'); return; }
    // One submission: its values are taken once, and late defaults no longer change them. App checks `live` before
    // each effect, so a retired press never reaches main or changes anything; a blocked switch never opens after it.
    // It stays the latest press after it ends, so its queued focus still lands unless a newer press or entry took over.
    const e = entry.current, values = { name, parentDirectory: form.parent }, s = { e, done: false }, live = () => alive.current && entry.current === e && submitting.current === s;
    if (!e?.owner || !entryOwns(e)) { setCopy((d) => ({ ...d, error: 'The project changed', errorField: 'name' })); return; }
    e.touched = { name: true, parent: true };
    submitting.current = s;
    void attempt(e.carried ? e.carried.run : () => actions.copy(values, e.owner, live), e.carried?.rowId, e.carried && { before: async (transition) => {
      const result = await actions.copyInside(values, e.owner, transition, live);
      if (result?.copied && live()) s.copied = true;
      else return result?.copied || !result ? { copyFailed: 'The project changed' } : result;
    } }, s).finally(() => { s.done = true; });
  };
  // A picker belongs to the entry and interaction it began in: after any mode change (even back to New) it does nothing.
  // None opens for a held copy.
  const chooseParent = async () => {
    if (copyHeld()) return;
    const e = entry.current, turn = interaction.current, owns = () => entryOwns(e) && interaction.current === turn;
    try {
      const chosen = await actions.chooseParent(form.parent);
      if (!owns()) return;
      if (chosen?.parentDirectory) { if (e) e.touched.parent = true; setForm((d) => ({ ...d, parent: chosen.parentDirectory, parentStatus: 'ready', error: '', errorField: 'name' })); }
    } catch (error) { if (!owns()) return; setForm((d) => ({ ...d, error: shortFact(error), errorField: 'location' })); }
    nameInput.current?.focus();
  };
  // First use: Skip leaves the blank Untitled ready to draw; it never opens or creates anything. A carried copy returns
  // to the list with its block exactly as it was.
  const back = () => {
    if (pending || copyHeld()) return;
    if (copy?.carried) { switchMode('list'); setBlock(copy.carried); } else if (enteredNew.current) onClose(firstUse ? 'skip' : undefined); else switchMode('list');
  };
  const dismiss = () => { if (!pending) onClose(firstUse && mode === 'new' ? 'skip' : undefined); };

  // The sheet owns the keyboard: nothing reaches the editor, Tab cycles inside, and list keys apply only where they belong.
  // Composition comes first: Escape, Enter and Tab then belong to the input method, and the native cancel is held off.
  const onKeyDown = (event) => {
    event.stopPropagation();
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) { if (event.key === 'Escape' || event.key === 'Tab') event.preventDefault(); return; }
    const target = event.target, mod = event.metaKey || event.ctrlKey;
    // A confirmation answers Escape itself (back to its row; the sheet stays). While a discard runs, Escape waits.
    if (event.key === 'Escape') {
      event.preventDefault();
      if (confirmRef.current) { cancelDiscard(); return; }
      if (mode === 'new') back(); else if (mode === 'recoveries') leaveManage(); else dismiss();
      return;
    }
    if (event.key === 'Tab') {
      const items = [...dialog.current.querySelectorAll('input:not(:disabled), button:not(:disabled)')].filter((item) => item.tabIndex >= 0);
      const index = items.indexOf(document.activeElement);
      event.preventDefault();
      items[event.shiftKey ? (index <= 0 ? items.length - 1 : index - 1) : (index + 1) % items.length]?.focus();
      return;
    }
    if (mod && !event.shiftKey && event.key.toLowerCase() === 'o') { event.preventDefault(); if (pending) return; enteredNew.current = false; enteredManage.current = false; if (mode !== 'list') switchMode('list'); search.current?.focus(); return; }
    if (mod && !event.shiftKey && event.key.toLowerCase() === 'n') { event.preventDefault(); if (!pending) switchMode('new'); return; }
    if (target === nameInput.current && event.key === 'Enter') { event.preventDefault(); create(); return; }
    if (target === search.current) {
      if (event.key === 'ArrowDown') { event.preventDefault(); focusRow(0); }
      else if (event.key === 'Enter' && rows[0]) { event.preventDefault(); press(rows[0]); }
      return;
    }
    // Inside a confirmation only its own two buttons act (Enter and Space press them natively); list keys wait.
    if (target.closest?.('[data-confirm]')) {
      if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Delete', 'Backspace'].includes(event.key)) event.preventDefault();
      return;
    }
    const row = target.closest?.('[data-row]');
    if (!row) return;
    const index = Number(row.dataset.row), item = rows[index];
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); if (item && !item.recovery) openMenu(item, index, row.querySelector('.pj-more')); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (event.key === 'ArrowUp' && index === 0) (manage ? row.querySelector('.pj-open') : search.current)?.focus(); else focusRow(index + (event.key === 'ArrowDown' ? 1 : -1)); }
    else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); focusRow(event.key === 'Home' ? 0 : rows.length - 1); }
    else if (event.key === 'Delete' || event.key === 'Backspace') {
      // A recent leaves the list; a recovered copy only begins its two-step discard; anything else does nothing.
      if (!item?.current && !item?.recovery) { event.preventDefault(); void remove(item, index); }
      else if (item?.recovery) { event.preventDefault(); if (item.discardable) void startDiscard(item); }
    }
    else if (event.key.length === 1 && !mod && !event.altKey && event.key !== ' ' && !manage) search.current?.focus();
  };

  // A block names the project it is about, never the one being opened or created. Its buttons stay secondary, so the
  // sheet's own commit remains the only primary in view. The subject may shorten; the fact on its own line never does.
  const fixButton = (fix, label, onClick, quiet) => h('button', { ref: fix === 'retry' ? retryButton : undefined, type: 'button', className: 'qbtn' + (quiet ? ' quiet' : ''), 'data-fix': fix,
    'aria-disabled': pending ? true : undefined, onClick }, label);
  const blockText = (name, verdict, fact, detail) => h('span', { className: 'pj-block-text' },
    h('span', { className: 'pj-block-subject' }, name && h('span', { className: 'pj-block-name' }, name), h('span', null, (name ? ' ' : '') + verdict)),
    // Keyed by repeat, so a Retry that fails again re-lights the fact.
    fact && h('span', { key: 'fact-' + (block?.repeat || 1), className: 'pj-block-fact', 'data-repeat': block?.repeat > 1 || undefined, title: detail && detail !== fact ? detail : undefined }, fact));
  // Show file runs outside the attempt and keeps focus on itself; a second press while it runs does nothing.
  const showSource = async (file) => {
    if (pending || revealing.current === revealOwner.current || !actions.revealSource) return;
    const shown = revealOwner.current, current = () => alive.current && revealOwner.current === shown;
    revealing.current = shown; setRevealFact(null);
    let result;
    try { result = await actions.revealSource(file, current); } catch (error) { result = { revealed: false, fact: shortFact(error) }; }
    finally { if (revealing.current === shown) revealing.current = null; }
    if (!current() || result?.revealed) return;
    setRevealFact({ owner: shown, fact: result?.fact || 'Couldn’t show file' });
    setSaid('Couldn’t show ' + file + ' · ' + (result?.fact || 'Couldn’t show file'));
  };
  const change = block?.blocked === 'failed' ? block.sourceChange : null;
  const shownReveal = revealFact?.owner === revealOwner.current ? revealFact.fact : '';
  const blockView = block && h('div', { className: 'pj-block', role: 'alert' },
    block.blocked === 'untitled' ? h(React.Fragment, null, blockText(block.subject || 'Untitled', 'has unsaved work'),
      fixButton('discard', 'Don’t save', () => fixBlock({ discard: true }), true),
      fixButton('save', 'Save…', () => enterCopy(block)))
    // No save target of this window's own (a failed startup detach): Open or New in the footer takes one.
    : block.blocked === 'no-target' ? blockText('', 'Can’t save in this window yet', block.message)
    : block.blocked === 'invalid' ? h(React.Fragment, null, blockText('', 'A field needs a fix'),
      fixButton('show', 'Show field', () => onClose()))
    : block.blocked === 'error' ? h(React.Fragment, null, blockText('', block.repeat > 1 ? 'Still couldn’t open' : 'Couldn’t open', block.message),
      block.run && fixButton('retry', 'Retry', () => fixBlock()))
    : h(React.Fragment, null, blockText(block.subject || '', block.subject ? (block.repeat > 1 ? 'still isn’t saved' : 'isn’t saved') : (block.repeat > 1 ? 'Still not saved' : 'Not saved'),
        shownReveal ? 'Couldn’t show file · ' + shownReveal : changedSourceFact(change) || block.message, block.detail),
      // A changed workspace can't be retried from here: Save copy… (then the switch), or Escape and Reload from disk.
      change?.scope === 'document' && change.file && actions.revealSource && fixButton('show-source', 'Show file', () => void showSource(change.file)),
      change?.scope !== 'workspace' && fixButton('retry', 'Retry', () => fixBlock()),
      fixButton('save-copy', 'Save copy…', () => enterCopy(block))));

  const rowView = (row, index) => {
    const word = row.recovery ? (row.entry.available ? '' : recoveryStatusWord(row.entry)) : row.status === 'missing' ? 'Missing' : row.status === 'invalid' ? (STATUS_WORD[row.code] || 'Can’t open') : '';
    const fix = row.recovery ? (row.kind === 'current' ? '' : row.entry.available ? 'Restore' : 'Show file') : !word ? '' : locates(row) ? 'Locate…' : 'Retry';
    const error = rowError?.id === row.id ? rowError.message : '';
    const confirming = confirm?.id === row.id ? confirm : null, asking = confirming && confirming.phase !== 'reserving';
    const kindWord = row.recovery && row.entry.available ? KIND_WORD[row.kind] : '';
    const discardLabel = 'Discard recovery copy of “' + row.name + '”' + (row.time ? ' from ' + row.time : ''), discardText = row.time ? 'Discard copy from ' + row.time : 'Discard copy';
    return h('li', { key: row.current ? 'current' : row.id, 'data-row': index, className: 'pj-row', 'data-active': index === at || undefined, 'data-current': row.current || undefined,
      'data-recovery': row.recovery || undefined, 'data-kind': row.recovery ? row.kind : undefined, 'data-confirm': confirming ? true : undefined, 'aria-busy': confirming?.phase === 'reserving' || undefined,
      'data-status': word ? (row.recovery ? 'unreadable' : row.status) : undefined, onPointerEnter: () => setActive(index),
      onContextMenu: row.recovery ? undefined : (event) => { event.preventDefault(); openMenu(row, index, event.currentTarget.querySelector('.pj-more'), { x: event.clientX, y: event.clientY }); } },
      h('button', { type: 'button', className: 'pj-open', tabIndex: index === at && !asking ? 0 : -1, 'aria-current': row.current ? 'true' : undefined,
        'aria-disabled': asking || row.kind === 'current' ? true : undefined, 'aria-describedby': row.recovery && !manage ? 'pj-recovered-label' : undefined,
        title: row.recovery ? row.entry.fact || undefined : row.detail || row.location?.folderPath || undefined, onFocus: () => setActive(index), onClick: () => press(row) },
        h('span', { className: 'pj-check', 'aria-hidden': true }, row.current ? h(Icon, { name: 'check', size: 14 }) : null),
        h('span', { className: 'pj-text' }, h('span', { className: 'pj-name' }, row.name), h('span', { className: 'pj-hint' }, '‎' + row.hint + '‎')),
        asking ? null
          : pending?.owner === row.id ? h('span', { className: 'pj-when', role: 'status' }, progressWord(pending, queuedDeparture))
          : row.recovery ? h('span', { className: 'pj-status pj-recovery-status' }, word || h(React.Fragment, null,
              kindWord && h('span', { className: 'pj-recovery-word' }, kindWord), row.time && h('time', { dateTime: row.updatedAt }, row.time)),
            // This window's own copy keeps the Restore column (an invisible, unannounced placeholder) so its time lines up.
            fix ? h('span', { className: 'pj-fix' }, fix) : row.kind === 'current' && h('span', { className: 'pj-fix pj-fix-slot', 'aria-hidden': true }, 'Restore'))
          : word ? h('span', { className: 'pj-status' }, word, h('span', { className: 'pj-fix' }, fix))
          : row.current ? h('span', { className: 'pj-when' }, 'Current') : null),
      // Step two names exactly what goes. Back takes focus, so Enter never discards by default, and Back sits where the × was,
      // so a second press on the × (a double-click) lands on Back, never on Discard.
      asking ? h('span', { className: 'pj-confirm' },
        // While main deletes, Discard keeps focus (aria-disabled); discard() itself refuses a second press, Escape or a press
        // outside, so nothing can repeat or cancel the deletion in flight.
        h('button', { type: 'button', className: 'delbtn', 'data-recovery': 'discard', 'aria-disabled': confirming.phase === 'discarding' || pending ? true : undefined, onClick: () => void discard(),
          'aria-label': discardLabel },
          // The label's own width is reserved, so the button keeps its box (and the pointer stays on it) while deleting.
          h('span', { className: 'project-menu-swap', 'data-reserve': discardText }, confirming.phase === 'discarding' ? 'Discarding…' : discardText)),
        h('button', { type: 'button', className: 'qbtn quiet', 'data-recovery': 'back', disabled: confirming.phase === 'discarding', onClick: cancelDiscard }, 'Back'))
        : row.discardable && pending?.owner !== row.id ? h('button', { type: 'button', className: 'pj-remove', tabIndex: index === at ? 0 : -1, 'data-recovery': 'discard-step',
          'aria-label': discardLabel + '…', title: 'Discard…',
          'aria-disabled': pending || confirming ? true : undefined, onFocus: () => setActive(index), onClick: () => void startDiscard(row) }, h(Icon, { name: 'x', size: 13 }))
        // Recents take their actions from the … in the same column (Delete still removes directly); copies without a discard
        // step and rows with no action keep the column, so times and fixes line up.
        : !row.recovery && pending?.owner !== row.id && rowItems(row, index).length ? h('button', { type: 'button', className: 'pj-more', tabIndex: index === at ? 0 : -1,
          'aria-label': 'Actions for ' + row.name, title: 'Actions', 'aria-haspopup': 'menu', 'aria-expanded': menu?.key === rowKey(row), 'aria-controls': menu?.key === rowKey(row) ? 'pj-row-menu' : undefined,
          onFocus: () => setActive(index), onClick: (event) => openMenu(row, index, event.currentTarget) }, '…')
        : h('span', { className: 'pj-slot', 'aria-hidden': true }),
      error && h('span', { className: 'pj-row-error', role: 'alert', title: error }, error));
  };
  // Retry's line unmounts as the list reloads: focus first moves to search (or Manage's Back), never to the page.
  const retryRecoveries = h('button', { ref: retryList, type: 'button', className: 'pj-link', onClick: () => {
    const holder = document.activeElement === retryList.current ? search.current || dialog.current?.querySelector('[data-action="manage-back"]') : null;
    holder?.focus(); setRecoveries({ status: 'pending', entries: [] }); void listRecoveries(holder);
  } }, 'Retry');
  // Each recovered row is described by this label, so it is heard with the row rather than read as a list item.
  const recoveryGroup = recoveries.status !== 'error' && recoveryCount ? h('li', { key: 'recovery-label', id: 'pj-recovered-label', className: 'pj-group', 'aria-hidden': true }, 'Recovered edits') : null;
  // Main's current listing says storage is full: one fact and its fix, above the copies. Nothing when there is room.
  const capacityLine = recoveries.status === 'ready' && recoveries.capacity?.full === true && h('li', { key: 'recovery-capacity', className: 'pj-empty pj-capacity' },
    h('span', { role: 'status' }, 'Recovery storage full'),
    h('button', { type: 'button', className: 'pj-link', 'data-action': 'manage-recoveries', 'aria-disabled': pending ? true : undefined, onClick: showManage }, 'Manage…'));
  // Projects and Manage share one list: Projects searches and shows recents below the copies; Manage has a title with main's
  // count instead, every copy that holds a slot, no search or bulk action, and Back to where it was opened from.
  const usage = manage && recoveries.status === 'ready' ? recoveryUsage(recoveries.capacity) : '';
  const empty = (key, text, extra) => h('li', { key, className: 'pj-empty', ...extra }, text);
  const listView = h(React.Fragment, null,
    manage ? h('div', { className: 'pj-manage-head' }, h('h2', { id: 'pj-manage-title', className: 'pj-manage-title' }, 'Recovery copies'),
      // A status region, so a discard that frees a slot is heard with the new count.
      usage && h('span', { className: 'pj-manage-count', role: 'status', 'data-full': recoveries.capacity?.full ? true : undefined }, usage))
      : h('div', { className: 'pj-search' }, h(Icon, { name: 'search', size: 15 }),
        h('input', { ref: search, type: 'search', value: query, placeholder: 'Find project', 'aria-label': 'Find project', 'aria-controls': 'pj-list', spellCheck: false, autoComplete: 'off',
          onKeyDown: searchInteraction, onPointerDown: searchInteraction,
          onChange: (event) => { searchInteraction(); setQuery(event.target.value); } })),
    !manage && request.startup?.announce && h('span', { className: 'sr-only', role: 'status' }, request.startup.announce),
    h('ul', { id: 'pj-list', className: 'pj-list', ...(manage ? { 'data-manage': true, 'aria-labelledby': 'pj-manage-title', 'aria-busy': recoveries.status === 'pending' } : { 'aria-label': 'Projects', 'aria-busy': recents.status === 'pending' }) },
      !manage && capacityLine,
      recoveries.status === 'error' && h('li', { key: 'recovery-error', className: 'pj-empty', role: 'alert' }, manage ? 'Recovery copies unavailable' : 'Recovered edits unavailable', retryRecoveries),
      !manage && recoveryGroup,
      rows.slice(0, recoveryCount).map(rowView),
      manage && recoveries.status === 'pending' && empty('recovery-pending', 'Loading…', { role: 'status' }),
      manage && recoveries.status === 'ready' && !rows.length && empty('recovery-none', 'No recovery copies'),
      (manage || recoveryCount > 0) && recoveries.limited && empty('recovery-limited', 'More recovered edits are stored than listed'),
      !manage && (recoveryCount > 0 || capacityLine) && h('li', { key: 'recovery-rule', className: 'pj-rule', 'aria-hidden': true }),
      !manage && rows.slice(recoveryCount).map((row, index) => rowView(row, index + recoveryCount)),
      !manage && recents.status === 'pending' && empty('recents-pending', 'Loading recents…', { role: 'status' }),
      !manage && recents.status === 'error' && h('li', { key: 'recents-error', className: 'pj-empty', role: 'alert' }, 'Recents unavailable', h('button', { type: 'button', className: 'pj-link', onClick: () => { setRecents({ status: 'pending', entries: [] }); void list(); } }, 'Retry')),
      !manage && recents.status === 'ready' && rows.length === 0 && empty('no-match', 'No match'),
      !manage && recents.status === 'ready' && !query && recents.entries.length === 0 && empty('no-recents', 'No recent projects')),
    h('div', { className: 'pj-foot' },
      // The list's commit is its row, so nothing here is primary.
      manage ? h('span') : h('button', { type: 'button', className: 'qbtn', 'data-action': 'new', onClick: () => { if (pending) return; enteredNew.current = false; switchMode('new'); } }, 'New project', h('kbd', null, shortcutLabel('N'))),
      h('span', { className: 'pj-foot-actions' }, manage ? h('button', { type: 'button', className: 'qbtn quiet', 'data-action': 'manage-back', onClick: leaveManage }, 'Back') : h(React.Fragment, null,
        h('button', { type: 'button', className: 'qbtn quiet', 'data-action': 'open-folder', onClick: () => void attempt(actions.openFolder, null) }, 'Open folder…'),
        h('button', { type: 'button', className: 'qbtn quiet', 'data-action': 'open-file', onClick: () => void attempt(actions.openFile, null) }, 'Open file…')))));

  const nameErrorShown = form.error && form.errorField !== 'location', locationErrorShown = form.error && form.errorField === 'location';
  // The attempt this form shows progress for: New's, the copy's own, or the blocked switch a copy continues.
  const own = copy ? (copy.carried ? copy.carried.rowId || 'sheet' : 'copy') : 'new', busy = pending?.owner === own, frozen = Boolean(copy && pending);
  const note = (name) => 'Keeps “' + name + '” as last saved' + (copy?.carried ? '' : ' and opens the copy');
  const newView = h('div', { className: 'pj-new' },
    h('label', { className: 'pj-label', htmlFor: 'pj-new-name' }, 'Project name'),
    h('input', { id: 'pj-new-name', ref: nameInput, className: 'pj-name-input', value: form.name, readOnly: frozen, spellCheck: false, autoComplete: 'off', maxLength: 120,
      'aria-invalid': nameErrorShown ? true : undefined, 'aria-describedby': nameErrorShown ? 'pj-new-error' : undefined,
      onChange: (event) => { if (copyHeld()) return; if (entry.current) entry.current.touched.name = true; setForm((d) => ({ ...d, name: event.target.value, error: d.errorField === 'location' ? d.error : '' })); } }),
    nameErrorShown && h('span', { id: 'pj-new-error', className: 'pj-new-error', role: 'alert' }, form.error),
    h('div', { className: 'pj-new-row' },
      h('span', { id: 'pj-location-label', className: 'pj-label' }, 'Location'),
      h('button', { ref: locationButton, type: 'button', className: 'pj-location', disabled: frozen, title: form.parent || undefined, 'aria-labelledby': 'pj-location-label pj-location-value pj-location-change',
        'aria-describedby': locationErrorShown ? 'pj-location-error' : undefined, 'aria-invalid': locationErrorShown ? true : undefined, onClick: chooseParent },
        h(Icon, { name: 'folder', size: 13 }),
        h('span', { id: 'pj-location-value' }, form.parent ? '‎' + homeRelative(form.parent) + '‎' : form.parentStatus === 'error' ? 'None chosen' : '…'),
        h('span', { id: 'pj-location-change', className: 'pj-location-change' }, 'Change…'))),
    locationErrorShown && h('span', { id: 'pj-location-error', className: 'pj-new-error pj-location-error', role: 'alert' }, form.error),
    // A copy has no robot to choose (the whole project is copied); a folder project says what stays behind. First use
    // has no real robot yet to copy.
    copy ? h(React.Fragment, null, current.folderPath && h('div', { className: 'pj-new-row' },
      h('span', { className: 'pj-hint', title: note(current.name), 'aria-hidden': true }, note(middle(current.name))), h('span', { className: 'sr-only' }, note(current.name))),
      h('div', { className: 'pj-new-spacer' }))
    : firstUse ? h('div', { className: 'pj-new-spacer' }) : h('label', { className: 'pj-new-row pj-check-row' },
      h('input', { type: 'checkbox', checked: draft.sameRobot, onChange: (event) => setDraft((d) => ({ ...d, sameRobot: event.target.checked })) }),
      h('span', null, 'Copy robot and limits from ' + current.name)),
    h('div', { className: 'pj-foot' },
      h('span'),
      h('span', { className: 'pj-foot-actions' },
        h('button', { type: 'button', className: 'qbtn quiet', 'data-action': firstUse ? 'skip' : 'cancel', onClick: back }, firstUse ? 'Skip' : 'Cancel'),
        h('button', { type: 'button', className: 'qbtn primary', disabled: busy || !form.name.trim() || !form.parent, onClick: create },
          busy ? pending.label || (pending.phase === 'saving' ? 'Saving…' : copy ? 'Opening…' : 'Creating…') : copy ? (current.untitled ? 'Save' : 'Save copy') : 'Create'))));

  // Folder, file and native-menu opens have no row, so their progress shows where a block would. A block being
  // retried stays until the attempt moves on to opening.
  const pendingView = pending && pending.owner !== own && !rows.some((row) => row.id === pending.owner) && h('div', { className: 'pj-progress', role: 'status' }, progressWord(pending, queuedDeparture));
  const showBlock = blockView && !(pending && pending.phase === 'opening');
  return h('dialog', { ref: dialog, className: 'pj-sheet', 'aria-label': mode === 'new' ? (copy ? (current.untitled ? 'Save project' : 'Save copy') : 'New project') : manage ? 'Recovery copies' : 'Projects', 'aria-busy': Boolean(pending), onKeyDown,
    onCompositionStart: () => { composing.current = true; }, onCompositionEnd: () => { composing.current = false; },
    // Focus or a press outside a confirming row ends that confirmation (nothing is discarded).
    onFocusCapture: leaveConfirm, onPointerDownCapture: leaveConfirm,
    // Escape handled by onKeyDown never reaches here; this covers a close request with focus outside the sheet's controls.
    onCancel: (event) => { event.preventDefault(); if (composing.current) return; if (confirmRef.current) cancelDiscard(); else if (mode === 'new') back(); else if (manage) leaveManage(); else dismiss(); },
    onClick: (event) => { if (event.target === event.currentTarget) { const b = event.currentTarget.getBoundingClientRect(); if (event.clientX < b.left || event.clientX > b.right || event.clientY < b.top || event.clientY > b.bottom) { if (mode === 'new' && firstUse) back(); else dismiss(); } } } },
    showBlock ? blockView : pendingView, mode === 'new' ? newView : listView,
    menuItems.length > 0 && h(RowMenu, { menu, label: 'Actions for ' + menuRow.name, items: menuItems, onClose: closeMenu }),
    h('span', { className: 'sr-only', role: 'status' }, said));
}

// A native-menu switch (or the drain of a departure) has no sheet of its own; this keeps the editor inert meanwhile.
export function ProjectPending({ phase, queuedDeparture, label }) {
  const dialog = useRef(null);
  useLayoutEffect(() => {
    const previous = document.activeElement;
    dialog.current.showModal();
    // The switch may remount what had focus; then the chip, which names the project now open, takes it.
    return () => requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      if (previous?.isConnected && previous !== document.body && !previous.closest('dialog, [inert]')) previous.focus();
      else document.querySelector('.project-chip')?.focus();
    });
  }, []);
  return h('dialog', { ref: dialog, className: 'pj-sheet pj-pending', 'aria-label': 'Switching project', 'aria-busy': true,
    onCancel: (event) => event.preventDefault(), onKeyDown: (event) => { event.stopPropagation(); if (event.key === 'Escape') event.preventDefault(); } },
    h('span', { role: 'status' }, label || progressWord({ phase }, queuedDeparture)));
}

/**
 * Close, quit, reload or install when the exact current source isn't saved. One primary (Save copy…, or Save… for
 * Untitled); leaving with the recovery copy is a plain secondary; Keep editing is quiet and is Escape. Without a recovery
 * copy, leaving is a deliberate two-step discard. Times are main's receipt times. "Saved" never appears here.
 */
export function ProjectDeparture({ reason, subject, outcome, step, pending, saveCopyFact, onKeepEditing, onSaveCopy, onLeave, onDiscardStep, onDiscard, onManage }) {
  const dialog = useRef(null), announced = useRef(false);
  const copy = departureCopy(reason), busy = Boolean(pending), recovered = outcome.recovery === 'saved';
  useLayoutEffect(() => { dialog.current.showModal(); }, []);
  useEffect(() => { announced.current = true; }, []);
  // The sheet owns its focus: the primary on open and after a step back, Back on the confirm step, and the primary again
  // when Save copy returns (busy disables every button).
  useLayoutEffect(() => {
    (busy ? dialog.current : dialog.current.querySelector(step === 2 ? '[data-departure="back"]' : '[data-departure="primary"]'))?.focus();
  }, [step, busy]);
  const primary = outcome.untitled ? 'Save…' : 'Save copy…';
  const button = (key, className, label, onClick, extra = {}) => h('button', { type: 'button', className, 'data-departure': key, disabled: busy, onClick, ...extra }, label);
  const title = '“' + subject + '” ' + (recovered ? 'isn’t saved' : 'can’t be saved');
  const facts = step === 2
    // Say exactly what goes: everything only when there is no project on disk to fall back to.
    ? h('span', { className: 'pj-departure-fact' }, outcome.detached ? 'All edits in this project will be lost'
      : outcome.lastSourceSavedAt ? h(React.Fragment, null, 'Edits since ', h('time', { dateTime: outcome.lastSourceSavedAt }, receiptTime(outcome.lastSourceSavedAt, { seconds: true })), ' will be lost')
      : 'Unsaved edits will be lost')
    : h(React.Fragment, null,
      h('span', { className: 'pj-departure-fact' }, saveCopyFact || outcome.sourceFact),
      h('span', { className: 'pj-departure-recovery' }, recovered
        ? h(React.Fragment, null, 'Recovery copy · ', h('time', { dateTime: outcome.recoveryAt }, receiptTime(outcome.recoveryAt, { seconds: true })))
        // Full storage is main's structured fact; its fix keeps editing first, then opens the copies (no retry here).
        : outcome.recoveryCode === 'capacity' ? h(React.Fragment, null, 'No recovery copy · ' + RECOVERY_FULL,
          onManage && h('button', { type: 'button', className: 'pj-link', 'data-departure': 'manage', disabled: busy, onClick: onManage }, 'Manage…'))
        : 'No recovery copy · ' + (outcome.recoveryFact || 'Couldn’t write the project')));
  return h('dialog', { ref: dialog, className: 'pj-sheet pj-departure', 'aria-labelledby': 'pj-departure-title', 'aria-describedby': 'pj-departure-facts', 'aria-busy': busy || undefined,
    onCancel: (event) => { event.preventDefault(); if (busy) return; if (step === 2) onDiscardStep(1); else onKeepEditing(); },
    // Focus never drifts out: Tab and Shift+Tab cycle the sheet's own buttons (and stay put while it is busy).
    tabIndex: -1, onKeyDown: (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); if (!busy) { if (step === 2) onDiscardStep(1); else onKeepEditing(); } }
      if (event.key === 'Tab') {
        event.preventDefault();
        const items = [...dialog.current.querySelectorAll('button:not(:disabled)')], index = items.indexOf(document.activeElement);
        items[event.shiftKey ? (index <= 0 ? items.length - 1 : index - 1) : (index + 1) % items.length]?.focus();
      }
    } },
    h('div', { className: 'pj-departure-body' },
      h('h2', { id: 'pj-departure-title', className: 'pj-departure-title', title: '“' + subject + '”' }, title),
      // First show is an alert; later step and Save copy changes are polite.
      h('div', { id: 'pj-departure-facts', className: 'pj-departure-facts', role: announced.current ? 'status' : 'alert' }, facts)),
    h('div', { className: 'pj-foot pj-departure-foot' },
      step === 2 ? h('span')
        : recovered ? button('leave', 'qbtn', copy.leave, onLeave)
        : button('discard-step', 'delbtn', copy.discard, () => onDiscardStep(2)),
      h('span', { className: 'pj-foot-actions' },
        step === 2 ? h(React.Fragment, null,
          button('back', 'qbtn quiet', 'Back', () => onDiscardStep(1)),
          button('discard', 'delbtn', copy.confirm, onDiscard))
          : h(React.Fragment, null,
            button('keep', 'qbtn quiet', 'Keep editing', onKeepEditing),
            button('primary', 'qbtn primary', pending === 'save-copy' ? 'Saving…' : primary, onSaveCopy)))));
}

/**
 * Invalid or composing input never gets a modal: a modal would blur the field and commit IME text. This one line sits
 * by the field, takes no focus or pointer, and goes when the field commits, is cancelled, loses focus, or on a click.
 */
export function DepartureHint({ anchor, reason, onDismiss }) {
  const [place, setPlace] = useState(null);
  useLayoutEffect(() => {
    if (!anchor?.isConnected) { onDismiss(); return undefined; }
    // Clear of the field's own message (what to fix): below the field, its described elements and its row.
    const parts = [anchor, anchor.closest('.numrow'), ...(anchor.getAttribute('aria-describedby') || '').split(' ').map((id) => id && document.getElementById(id))].filter(Boolean);
    const rects = parts.map((part) => part.getBoundingClientRect()).filter((rect) => rect.height > 0);
    const top = Math.min(...rects.map((rect) => rect.top)), bottom = Math.max(...rects.map((rect) => rect.bottom)), field = anchor.getBoundingClientRect();
    const below = window.innerHeight - bottom >= 56;
    const left = Math.max(8, Math.min(field.left, window.innerWidth - 288));
    setPlace(below ? { left, top: bottom + 6 } : { left, bottom: window.innerHeight - top + 6 });
    const dismiss = () => onDismiss();
    const key = (event) => { if (event.key === 'Enter' || event.key === 'Escape') dismiss(); };
    anchor.addEventListener('blur', dismiss); anchor.addEventListener('keydown', key);
    document.addEventListener('pointerdown', dismiss, true);
    return () => { anchor.removeEventListener('blur', dismiss); anchor.removeEventListener('keydown', key); document.removeEventListener('pointerdown', dismiss, true); };
  }, [anchor]);
  if (!place) return null;
  return createPortal(h('div', { className: 'pj-input-hint', role: 'status', style: place }, departureCopy(reason).hint), document.body);
}
