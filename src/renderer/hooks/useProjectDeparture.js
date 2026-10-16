import * as React from 'react';
import { flushSync } from 'react-dom';
import { PROJECT_DRAFT_SELECTOR } from '../lib/draftPersistence';
import { checkpointMatch, firstFact, sourceFact } from '../lib/projectLifecycle';

const { useCallback, useEffect, useRef, useState } = React;
const reply = (api, request, outcome, extra = {}) => Promise.resolve(api.respondProjectDeparture({ requestId: request.requestId, context: request.context, outcome, ...extra }))
  .then((result) => result?.accepted !== false, () => false);
// A busy reply names main's id for the owning transition; it waits for main to issue it.
const busyReply = (api, request, transition) => transition.ready.then((id) => reply(api, request, 'busy', { transitionId: id || transition.localId }));
const receiptReply = (receipt) => ({ receiptId: receipt.receiptId, operationId: receipt.operationId, snapshotRevision: receipt.snapshotRevision });

/**
 * The renderer half of a close, quit, reload or install. Main owns intent, deadlines and permits; this hook answers one
 * request at a time through App's persistence queue and its one project transition owner:
 * - a busy switch is reported by its transition id and resumed after it settles;
 * - composing or invalid input is refused before anything blurs, with a hint at the field;
 * - otherwise the window turns inert, the exact current model is checkpointed, and an exact current source receipt
 *   departs silently, while anything else waits for the person's choice on the departure sheet.
 * `deps` is a ref to App's current callbacks, so the handlers stay stable across renders.
 */
export function useProjectDeparture(deps) {
  const [view, setView] = useState(null);
  const [hint, setHint] = useState(null);
  const [queued, setQueued] = useState(null);
  const active = useRef(null), waiting = useRef(null), composing = useRef(false);

  // Composition anywhere in the document (path, routine and command drafts alike) blocks departure.
  useEffect(() => {
    const start = () => { composing.current = true; }, end = () => { composing.current = false; };
    document.addEventListener('compositionstart', start, true); document.addEventListener('compositionend', end, true);
    return () => { document.removeEventListener('compositionstart', start, true); document.removeEventListener('compositionend', end, true); };
  }, []);

  const update = (patch) => setView((current) => current && { ...current, ...patch });
  // Main advances a request's target generation (same document session) when this request's own Save As or legacy
  // migration commits; the final reply then names that context. A different document session never qualifies.
  const advance = (entry, terminal) => {
    const next = terminal.context;
    if (next && next.windowEpoch === entry.request.context.windowEpoch && next.documentSessionId === entry.request.context.documentSessionId) entry.request = { ...entry.request, context: next };
  };
  const focusPrimary = () => requestAnimationFrame(() => document.querySelector('.pj-departure [data-departure="primary"], .pj-departure [data-departure="back"]')?.focus());

  const release = useCallback((entry, { resumed = true } = {}) => {
    if (!entry || active.current !== entry) return;
    active.current = null;
    setView(null);
    deps.current.releaseTransition(entry.transition);
    if (resumed) deps.current.scheduleAutosave();
    requestAnimationFrame(() => {
      const target = entry.focus;
      if (target?.isConnected && target !== document.body && !target.closest('dialog, [inert]')) target.focus();
      else document.querySelector('.project-chip')?.focus();
    });
  }, [deps]);

  const approve = useCallback(async (entry, outcome, extra) => {
    entry.phase = 'approving'; update({ phase: 'approving' });
    if (!(await reply(deps.current.api, entry.request, outcome, extra))) { release(entry); return; }
    if (active.current !== entry) return;
    // Inert until main's continuation destroys the window or cancels the request. Approval grants no unload here.
    entry.phase = 'approved'; update({ phase: 'approved' });
  }, [deps, release]);

  // One logical checkpoint for this request, matched by its own revision; resolves at main's terminal update.
  const checkpoint = (request, entry, start) => new Promise((resolve) => {
    const d = deps.current, snapshotRevision = d.nextRevision();
    const stop = d.channel.watch(checkpointMatch({ mode: 'departure', snapshotRevision, context: request.context, requestId: request.requestId }), (next) => {
      if (next.source !== 'pending') { stop(); resolve({ update: next }); }
    });
    start(snapshotRevision).then((result) => { stop(); resolve(result && 'source' in result ? { update: result } : { result }); },
      (error) => { stop(); resolve({ error }); });
  });

  // The decision surface for a terminal outcome of the request's current operation: the first drain's, or a failed Save
  // copy's (which started a new operation in main, with its own recovery receipt or none). Choosing is reported only
  // after that terminal update; human decision time is then unbounded.
  const choose = useCallback(async (entry, terminal, saveCopyFact = '') => {
    const d = deps.current;
    advance(entry, terminal);
    entry.recovery = terminal.recovery === 'saved' && terminal.recoveryReceipt ? terminal.recoveryReceipt : null;
    const session = await Promise.resolve(d.api.getProjectSession()).catch(() => null);
    if (active.current !== entry) return;
    const restored = d.restored(), untitled = terminal.source === 'unavailable' && d.isUntitled();
    const outcome = {
      source: terminal.source === 'unavailable' ? 'unavailable' : 'failed', sourceFact: sourceFact(terminal, restored), untitled, detached: untitled || restored,
      recovery: entry.recovery ? 'saved' : 'failed', recoveryAt: entry.recovery?.capturedAt || null,
      recoveryFact: entry.recovery ? null : firstFact(terminal.recoveryFact || 'Recovery copy could not be saved'),
      recoveryCode: entry.recovery ? null : terminal.recoveryCode || null,
      lastSourceSavedAt: session?.latestSource?.completedAt || null,
    };
    entry.phase = 'choosing';
    setView({ request: entry.request, phase: 'choosing', outcome, step: 1, saveCopyFact });
    if (!(await reply(d.api, entry.request, 'choosing'))) release(entry);
  }, [deps, release]);

  const drain = useCallback(async (entry) => {
    for (let round = 0; round < 3; round += 1) {
      const d = deps.current, request = entry.request;
      const outcome = await d.enqueue(() => {
        if (active.current !== entry || !d.checkpointTargetReady(request.context)) return null;
        entry.capture = d.capture();
        return checkpoint(request, entry, (snapshotRevision) => d.api.checkpointProject({ context: request.context, snapshotRevision, project: entry.capture.materialized, requestId: request.requestId }));
      });
      if (active.current !== entry) return;
      if (!outcome) { void reply(d.api, request, 'cancelled'); release(entry); return; }
      if (entry.request !== request) { round -= 1; continue; }
      const terminal = outcome.update || { source: 'failed', sourceFact: String(outcome.error?.message || outcome.error || 'Couldn’t write the project'), recovery: 'failed', recoveryFact: 'Recovery copy could not be saved' };
      if (terminal.source === 'saved' && terminal.sourceReceipt) {
        // Approve only the exact model that was frozen: same project, edit revision and input generation.
        if (!d.stayedCurrent(entry.capture)) continue;
        advance(entry, terminal);
        d.applySavedSource(terminal, entry.capture);
        await approve(entry, 'saved', receiptReply(terminal.sourceReceipt));
        return;
      }
      d.sourceFailed(terminal, entry.capture);
      await choose(entry, terminal);
      return;
    }
    if (active.current !== entry) return;
    const changing = { source: 'failed', sourceFact: 'The project kept changing while saving', recovery: 'failed', recoveryFact: 'The project kept changing while saving' };
    deps.current.sourceFailed(changing, entry.capture);
    await choose(entry, changing);
  }, [approve, choose, deps, release]);

  const onRequest = useCallback((request) => {
    const d = deps.current, entry = active.current;
    if (entry) {
      // Main coalesces repeats; a renewed nonce for the same intent continues the open departure.
      if (entry.request.requestId === request.requestId) { focusPrimary(); return; }
      if (entry.request.intentId === request.intentId) {
        entry.request = request; update({ request });
        void reply(d.api, request, entry.phase === 'choosing' ? 'choosing' : 'draining');
        focusPrimary(); return;
      }
      void busyReply(d.api, request, entry.transition);
      return;
    }
    const owner = d.transitionRef.current;
    if (owner) {
      // An uncancellable switch keeps the window; the departure resumes once it settles.
      waiting.current = { request, transition: owner };
      setQueued(request.reason);
      void busyReply(d.api, request, owner);
      return;
    }
    // Preflight before anything blurs: a modal would commit IME text or a half-typed value.
    const focused = document.activeElement, copy = request.reason;
    if (composing.current) { setHint({ anchor: focused, reason: copy }); void reply(d.api, request, 'composing'); return; }
    const invalid = focused?.matches?.(PROJECT_DRAFT_SELECTOR + '[aria-invalid="true"]') ? focused : document.querySelector(PROJECT_DRAFT_SELECTOR + '[aria-invalid="true"]');
    if (invalid || !d.flushProjectDraft()) {
      const field = invalid || document.activeElement;
      if (field && field !== document.activeElement) field.focus();
      field?.scrollIntoView?.({ block: 'nearest' });
      setHint({ anchor: field, reason: copy });
      void reply(d.api, request, 'invalid-input');
      return;
    }
    setHint(null);
    const transition = d.takeTransition('departure');
    const next = { request, transition, focus: focused, phase: 'draining' };
    active.current = next;
    setView({ request, phase: 'draining' });
    void reply(d.api, request, 'draining');
    flushSync(() => d.finishEdit());
    d.invalidateScheduledAutosave();
    // Nothing is checkpointed against a save target this window has not taken (a failed startup detach).
    void Promise.resolve(d.checkpointTargetReady(request.context)).then((ready) => {
      if (active.current !== next) return;
      if (ready) { void drain(next); return; }
      void reply(d.api, request, 'cancelled');
      release(next);
    });
  }, [deps, drain, release]);

  const onCancelled = useCallback((requestId) => {
    if (waiting.current?.request.requestId === requestId) { waiting.current = null; setQueued(null); }
    if (active.current?.request.requestId === requestId) release(active.current);
  }, [release]);

  // App calls this after a switch it owned has settled and main was told it ended; main validates the token and
  // sends a fresh request for the now-current document.
  const transitionEnded = useCallback((transition, id) => {
    const blocked = waiting.current;
    if (!blocked || blocked.transition !== transition) return;
    waiting.current = null; setQueued(null);
    const { request } = blocked;
    void Promise.resolve(deps.current.api.resumeProjectDeparture({ intentId: request.intentId, blockedRequestId: request.requestId, transitionId: id || transition.localId, windowEpoch: transition.token?.windowEpoch || request.context.windowEpoch })).catch(() => undefined);
  }, [deps]);

  const keepEditing = useCallback(() => {
    const entry = active.current;
    if (!entry || entry.phase !== 'choosing') return;
    void reply(deps.current.api, entry.request, 'cancelled');
    release(entry);
  }, [deps, release]);

  // Manage… on a full-storage sheet: exactly Keep editing (cancelled, released, focus returned). The copies open only if
  // main accepted that cancellation, and only for the same document with no newer departure two frames later; a refused or
  // failed reply, a replaced document or a new request opens nothing. It carries nothing of this request, so no old nonce
  // acts later.
  const manageRecoveries = useCallback((open) => {
    const entry = active.current;
    if (!entry || entry.phase !== 'choosing') return;
    const epochNow = () => typeof deps.current.documentEpoch === 'function' ? deps.current.documentEpoch() : deps.current.capture?.()?.epoch;
    const epoch = epochNow();
    const answered = reply(deps.current.api, entry.request, 'cancelled');
    release(entry);
    void answered.then((accepted) => {
      if (accepted !== true || epoch === undefined) return;
      requestAnimationFrame(() => requestAnimationFrame(() => { if (!active.current && epochNow() === epoch) open(); }));
    });
  }, [deps, release]);

  const leave = useCallback(() => {
    const entry = active.current;
    if (!entry || entry.phase !== 'choosing' || !entry.recovery) return;
    // The receipt is for the frozen model of the current operation; anything newer must be drained again.
    if (!deps.current.stayedCurrent(entry.capture)) { entry.phase = 'draining'; update({ phase: 'draining' }); void drain(entry); return; }
    void approve(entry, 'recovery', receiptReply(entry.recovery));
  }, [approve, deps, drain]);

  const discardStep = useCallback((step) => { if (active.current?.phase === 'choosing') update({ step }); }, []);
  const discard = useCallback(() => {
    const entry = active.current;
    if (!entry || entry.phase !== 'choosing' || entry.recovery) return;
    void approve(entry, 'discard', { confirmed: true });
  }, [approve]);

  // Save copy… / Save… inside this departure: its source phase decides, before (and regardless of) BDX.
  // - A cancelled picker (or a refusal before main admitted a checkpoint) keeps the current operation, sheet and receipt.
  // - A terminal failure belongs to the new operation: its recovery receipt (or none) replaces the old one, and
  //   choosing is reported again.
  const saveCopy = useCallback(() => {
    const entry = active.current;
    if (!entry || entry.phase !== 'choosing') return;
    const d = deps.current, request = entry.request;
    entry.phase = 'save-copy'; update({ phase: 'save-copy', saveCopyFact: '' });
    let saving;
    void d.enqueue(async () => {
      if (active.current !== entry || !d.checkpointTargetReady(request.context)) return null;
      const capture = d.capture();
      const outcome = await checkpoint(request, entry, (snapshotRevision) => {
        saving = d.api.saveProjectWithCheckpoint({ context: request.context, snapshotRevision, project: capture.materialized, saveAs: !d.isUntitled(), requestId: request.requestId });
        return saving;
      });
      return { capture, outcome };
    }).then(async (result) => {
      if (active.current !== entry) return;
      if (!result) { void reply(d.api, request, 'cancelled'); release(entry); return; }
      const { capture, outcome } = result;
      const terminal = outcome.update;
      if (terminal?.source === 'saved' && terminal.sourceReceipt) {
        if (!d.stayedCurrent(capture)) { entry.phase = 'draining'; update({ phase: 'draining' }); void drain(entry); return; }
        advance(entry, terminal);
        d.applySavedSource(terminal, capture);
        d.attachExport(saving);
        await approve(entry, 'saved', receiptReply(terminal.sourceReceipt));
        return;
      }
      if (terminal) { entry.capture = capture; await choose(entry, terminal, 'Couldn’t save copy · ' + sourceFact(terminal, false)); return; }
      entry.phase = 'choosing';
      update({ phase: 'choosing', saveCopyFact: outcome.result?.canceled ? '' : 'Couldn’t save copy · ' + firstFact(outcome.error || 'Couldn’t write the project') });
    });
  }, [approve, choose, deps, drain, release]);

  /**
   * Synchronous fence: every beforeunload this renderer sees is prevented, approved departures included. It writes
   * nothing and grants nothing; main alone overrides it (will-prevent-unload) for its exact consumed close, quit or reload
   * dispatch, so no reply timing, approval or resumed editing here can let a direct reload through. Armed once main
   * accepts the lifecycle handshake.
   */
  const armUnloadFence = useCallback(() => {
    const fence = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', fence);
    return () => window.removeEventListener('beforeunload', fence);
  }, []);

  return { view, hint, queued, onRequest, armUnloadFence, onCancelled, transitionEnded, keepEditing, manageRecoveries, leave, discard, discardStep, saveCopy,
    dismissHint: useCallback(() => setHint(null), []) };
}
