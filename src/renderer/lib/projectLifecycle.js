// Renderer side of project durability: matching main's checkpoint progress to the request that started it,
// departure wording, receipt times, recovery offer tokens and creation failure placement. No state lives here;
// App's persistence queue and its one project transition owner stay authoritative.
import { projectWriteFactFromMessage } from '../../shared/project/writeErrors';

/** First sentence of a desktop error, without the IPC prefix. A raw `ECODE:` message becomes its plain fact. */
export function firstFact(error) {
  const message = String(error?.message || error || '').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  return projectWriteFactFromMessage(message) || message.split(/(?<=\.)\s/)[0].replace(/\.$/, '');
}

/** firstFact, shortened for one-line places; the full text stays available as a title. */
export function shortFact(error) {
  const first = firstFact(error);
  return first.length > 60 ? first.slice(0, 57).trimEnd() + '…' : first;
}

// Target generations may advance during a drained Save; the document and native window must stay the same.
export const sameDocument = (a, b) => Boolean(a && b && a.windowEpoch === b.windowEpoch && a.documentSessionId === b.documentSessionId);
export async function showProjectSource(api, file, context, current) {
  const session = await api.getProjectSession();
  return current() && sameDocument(context, session.context) ? api.revealProjectSource(session.context, file)
    : { revealed: false, code: 'stale', fact: 'The project changed' };
}

export const sameContext = (a, b) => Boolean(a && b && a.windowEpoch === b.windowEpoch
  && a.documentSessionId === b.documentSessionId && a.targetGeneration === b.targetGeneration);

/** The checkpoint/recovery/departure bridge this renderer can use, or null in the browser and older fixtures. */
export function lifecycleApi(api) {
  return api && typeof api.checkpointProject === 'function' && typeof api.getProjectSession === 'function'
    && typeof api.onProjectCheckpoint === 'function' ? api : null;
}

/**
 * One subscription to main's checkpoint progress. A caller watches before it invokes, for its own captured
 * snapshotRevision and context (and operation/request when known), never "the latest event".
 */
export function createCheckpointChannel(api) {
  const watchers = new Set();
  const unsubscribe = api.onProjectCheckpoint((update) => { for (const watcher of [...watchers]) if (watcher.match(update)) watcher.onUpdate(update); });
  return {
    watch(match, onUpdate) { const watcher = { match, onUpdate }; watchers.add(watcher); return () => watchers.delete(watcher); },
    dispose() { watchers.clear(); unsubscribe?.(); },
  };
}

/** Matches one checkpoint by the request that started it. */
export const checkpointMatch = ({ mode, snapshotRevision, context, requestId }) => (update) => Boolean(update)
  && update.mode === mode && update.snapshotRevision === snapshotRevision
  && (requestId ? update.requestId === requestId : true)
  // A legitimate Save As or migration advances the generation in the same document session.
  && update.context?.windowEpoch === context.windowEpoch && update.context?.documentSessionId === context.documentSessionId;

/** Main's structured recovery storage failure; its fix is Manage…, never a retry. */
export const RECOVERY_FULL = 'Recovery storage full';
/** Plain recovery state from a checkpoint update; a time only for a stored receipt. Full storage is read from its code. */
export function recoveryOutcome(update) {
  if (update?.recovery === 'saved' && update.recoveryReceipt?.capturedAt) return { status: 'saved', at: update.recoveryReceipt.capturedAt, receipt: update.recoveryReceipt };
  if (update?.recovery === 'failed' && update.recoveryCode === 'capacity') return { status: 'failed', fact: RECOVERY_FULL, code: 'capacity' };
  if (update?.recovery === 'failed') return { status: 'failed', fact: firstFact(update.recoveryFact || 'Recovery copy could not be saved') };
  return null;
}
/**
 * A current listing that has room again retires a full-storage fact; the earlier copy still failed, so the state stays
 * "no recovery copy" (with no fact and no Manage…) until a later checkpoint writes one. Nothing else changes.
 */
export const recoveryAfterListing = (recovery, capacity) => recovery?.code === 'capacity' && capacity && capacity.full === false
  ? { status: 'failed', fact: '', code: 'capacity-freed' } : recovery;

// Main names only these managed documents; anything else keeps the scope and drops the file.
const MANAGED_DOCUMENT = /^(Paths\/[^/\\]+\.path|Routines\/[^/\\]+\.routine)$/;
/** Main's structured cause of THIS failed terminal (never parsed from text), or undefined. Display and fixes only. */
export function sourceChangeOf(update) {
  const change = update?.source === 'failed' ? update.sourceChange : null;
  if (change?.scope === 'workspace') return { scope: 'workspace' };
  if (change?.scope !== 'document') return undefined;
  return typeof change.file === 'string' && MANAGED_DOCUMENT.test(change.file) ? { scope: 'document', file: change.file } : { scope: 'document' };
}
export const changedSourceFact = (change) => change?.scope === 'workspace' ? 'Changed on disk'
  : change?.scope === 'document' ? (change.file ? change.file + ' changed on disk' : 'A file changed on disk') : null;

export function sourceFact(update, restored) {
  if (update.source === 'unavailable') return restored ? 'Recovered copy · not in a folder' : 'Not in a folder yet';
  if (update.source === 'timed-out') return 'Folder isn’t responding';
  return changedSourceFact(sourceChangeOf(update)) || firstFact(update.sourceFact || 'Couldn’t write the project');
}

/**
 * The chip's fix set for a failed source save. A changed workspace can't be retried until the person reloads or saves
 * elsewhere; a changed document can (once that file moves), and can be shown. Untyped failures keep Retry.
 */
export function saveFixes({ saveError, attempt, sourceChange, reloadError, showFailure, canReload, canShow }) {
  const changed = changedSourceFact(sourceChange), again = attempt > 1;
  const fact = reloadError && sourceChange?.scope === 'workspace' ? 'Couldn’t reload · ' + reloadError
    : showFailure && sourceChange?.scope === 'document' ? 'Couldn’t show file · ' + showFailure
    : (again ? 'Still not saved · ' : 'Not saved · ') + (changed || shortFact(saveError));
  const fixes = sourceChange?.scope === 'workspace' ? [canReload && 'reload-source', 'save-copy', 'copy-details']
    : sourceChange?.scope === 'document' ? [sourceChange.file && canShow && 'show-source', 'retry', 'save-copy', 'copy-details']
    : ['retry', 'save-copy', 'copy-details'];
  return { fact, fixes: fixes.filter(Boolean) };
}

/** Recovery state after a Reload that didn't happen: its confirmed copy, its own recovery failure, or unchanged (null). */
export function reloadRecovery(result) {
  if (result?.kept?.capturedAt) return { status: 'saved', at: result.kept.capturedAt, receipt: result.kept };
  if (result?.recoveryCode) return recoveryOutcome({ recovery: 'failed', recoveryCode: result.recoveryCode, recoveryFact: result.recoveryFact });
  return null;
}

/** App's persistence queue: steps run one at a time, in order. A held replacement admits no new autosave schedules. */
export function createPersistenceQueue() {
  let tail = Promise.resolve(), holder = null;
  return {
    enqueue(operation) {
      const pending = tail.catch(() => undefined).then(operation);
      tail = pending.then(() => undefined, () => undefined);
      return pending;
    },
    hold() { const mine = {}; holder = mine; return () => { if (holder === mine) holder = null; }; },
    held: () => holder !== null,
  };
}

const RELOAD_STALE = 'The project changed while reloading';
/**
 * Reload from disk, the renderer half. Before any await: the draft commits, the gesture finishes, new autosave
 * schedules are held and scheduled or queued ones invalidated, then the transition begins. A save that already started
 * runs to its own outcome first (it is not cancelled). In one queued step, one materialized model travels with this
 * transition's token and the session context; main keeps it as a recovery copy before reading the source. Nothing here
 * writes the source, and a failed Reload restarts no save. `apply` gets main's typed result and the admission epoch.
 */
export function reloadFromDisk(d) {
  if (d.busy()) return Promise.resolve({ busy: true });
  if (!d.prepare()) return Promise.resolve({ blocked: 'invalid' });
  const release = d.queue.hold();
  d.invalidateAutosave();
  const epoch0 = d.epoch(), context0 = d.context(), transition = d.begin();
  const run = async () => {
    await transition.ready;
    return d.queue.enqueue(async () => {
      if (epoch0 !== d.epoch() || !transition.token) return d.apply({ status: 'not-reloaded', code: 'stale', fact: RELOAD_STALE }, epoch0);
      let result;
      try {
        const session = await d.api.getProjectSession();
        if (epoch0 !== d.epoch() || !sameDocument(context0, session.context)) return d.apply({ status: 'not-reloaded', code: 'stale', fact: RELOAD_STALE }, epoch0);
        result = await d.api.reloadProjectSource({ context: session.context, snapshotRevision: d.nextRevision(), project: d.materialize(), transition: transition.token });
      } catch (error) { result = { status: 'not-reloaded', code: 'rejected', fact: firstFact(error) }; }
      return d.apply(result, epoch0);
    });
  };
  return run().finally(() => { release(); d.end(transition); });
}

const VERBS = { close: 'Close', quit: 'Quit', reload: 'Reload', 'reload-ignoring-cache': 'Reload', update: 'Install' };
const WHEN_DONE = { close: 'Closes', quit: 'Quits', reload: 'Reloads', 'reload-ignoring-cache': 'Reloads', update: 'Installs' };
const LEAVING = { close: 'Closing…', quit: 'Quitting…', reload: 'Reloading…', 'reload-ignoring-cache': 'Reloading…', update: 'Installing…' };
export function departureCopy(reason) {
  const verb = VERBS[reason] || 'Close', lower = verb.toLowerCase();
  return { verb, leave: verb + ' and restore later', discard: verb + ' without saving…', confirm: 'Discard and ' + lower,
    hint: 'Can’t ' + lower + ' yet · Finish or cancel this field', queued: (WHEN_DONE[reason] || 'Closes') + ' when done', leaving: LEAVING[reason] || 'Closing…' };
}

/** Receipt times in the user's locale: seconds for departures, minutes (with a date when not today) for recoveries. */
export function receiptTime(iso, { seconds = false, now = new Date() } = {}) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return '';
  const today = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat(undefined, { ...(today || seconds ? {} : { month: 'short', day: 'numeric' }), hour: 'numeric', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) }).format(date);
}

// Offer once per exact record: a token for each record actually shown, never a global "offered through" time.
const OFFERED_KEY = 'bordeaux.recoveryOffered';
export const recoveryToken = (entry) => entry.available && entry.receipt
  ? 'r:' + entry.receipt.recordId + ':' + entry.receipt.revision + ':' + entry.receipt.digest
  : 'e:' + entry.id + ':' + (entry.code || '') + ':' + (entry.updatedAt || '');
export function readOfferedRecoveries(storage = globalThis.localStorage) {
  try { const value = JSON.parse(storage?.getItem(OFFERED_KEY) || '[]'); return new Set(Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []); } catch { return new Set(); }
}
/** Records not yet shown in an offered sheet. */
export const unofferedRecoveries = (entries, offered) => entries.filter((entry) => !offered.has(recoveryToken(entry)));
/** Remembers the records actually displayed, bounded to records that still exist. A failed write only repeats an offer. */
export function rememberOfferedRecoveries(displayed, known, storage = globalThis.localStorage) {
  const live = new Set(known.map(recoveryToken)), next = [...readOfferedRecoveries(storage)].filter((token) => live.has(token));
  for (const entry of displayed) if (!next.includes(recoveryToken(entry))) next.push(recoveryToken(entry));
  try { storage?.setItem(OFFERED_KEY, JSON.stringify(next)); } catch { /* the next start offers them again */ }
  return new Set(next);
}

/** A recovery origin as a project location, so rows reuse the recents hint rules (legacy files stay distinct). */
export function originLocation(origin) {
  if (!origin || origin.kind === 'untitled') return { folderPath: null, projectPath: null };
  return { folderPath: origin.folderPath, projectPath: origin.projectPath ?? null, ...(origin.kind === 'legacy' ? { legacyFile: origin.legacyFile } : {}) };
}

const RECOVERY_WORD = { 'invalid-record': 'Can’t read', 'invalid-project': 'Can’t read', 'invalid-input': 'Can’t read', 'unsupported-version': 'Newer version',
  'unsafe-entry': 'Not a regular file', 'too-large': 'Too large', missing: 'Missing', 'storage-unavailable': 'Can’t read' };
export const recoveryStatusWord = (entry) => RECOVERY_WORD[entry.code] || 'Can’t read';

/**
 * Where a creation failure belongs: a permission or missing/unsafe parent is about the location (and reads as
 * access, since "read-only" is wrong when Documents access is denied); a name collision or bad name is about the name.
 */
export function creationFailure(error) {
  const message = String(error?.message || error || '');
  if (/\bE(ACCES|PERM)\b/.test(message) || /permission denied|operation not permitted/i.test(message)) return { field: 'location', fact: 'No access to this location' };
  if (/\bE(NOENT|NOTDIR|ROFS)\b/.test(message) || /parent|not a folder|regular folder|location/i.test(message)) return { field: 'location', fact: firstFact(error) };
  return { field: 'name', fact: firstFact(error) };
}
