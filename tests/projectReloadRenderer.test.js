import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RECOVERY_FULL, changedSourceFact, createPersistenceQueue, reloadFromDisk, reloadRecovery, saveFixes, sourceChangeOf, sourceFact } from '../src/renderer/lib/projectLifecycle';
import { ProjectChip } from '../src/renderer/components/ProjectChip';
import { ProjectsDialog } from '../src/renderer/components/ProjectsDialog';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('changed source on disk: structured cause', () => {
  it('reads main’s structured field only, for this failed terminal', () => {
    expect(sourceChangeOf({ source: 'failed', sourceChange: { scope: 'workspace' } })).toEqual({ scope: 'workspace' });
    expect(sourceChangeOf({ source: 'failed', sourceChange: { scope: 'document', file: 'Paths/Auto 1.path' } })).toEqual({ scope: 'document', file: 'Paths/Auto 1.path' });
    // A message that merely reads like a change is never parsed into one.
    expect(sourceChangeOf({ source: 'failed', sourceFact: 'The project changed on disk' })).toBeUndefined();
    // Only failed terminals carry a cause; a timeout or save never inherits one.
    expect(sourceChangeOf({ source: 'timed-out', sourceChange: { scope: 'workspace' } })).toBeUndefined();
    expect(sourceChangeOf({ source: 'saved', sourceChange: { scope: 'workspace' } })).toBeUndefined();
    expect(sourceChangeOf({ source: 'failed', sourceChange: { scope: 'other' } })).toBeUndefined();
  });

  it('keeps the scope but drops a file that isn’t a managed document', () => {
    for (const file of ['../Paths/a.path', '/abs/Paths/a.path', 'Paths/a.routine', 'Routines/x.path', 'Paths/sub/a.path', 'Paths\\a.path', 42])
      expect(sourceChangeOf({ source: 'failed', sourceChange: { scope: 'document', file } })).toEqual({ scope: 'document' });
    expect(sourceChangeOf({ source: 'failed', sourceChange: { scope: 'document', file: 'Routines/Two piece.routine' } }).file).toBe('Routines/Two piece.routine');
  });

  it('says what changed in one short fact, also for departures', () => {
    expect(changedSourceFact({ scope: 'workspace' })).toBe('Changed on disk');
    expect(changedSourceFact({ scope: 'document', file: 'Paths/Auto 1.path' })).toBe('Paths/Auto 1.path changed on disk');
    expect(changedSourceFact({ scope: 'document' })).toBe('A file changed on disk');
    expect(changedSourceFact(undefined)).toBeNull();
    const full = 'Project folder changed on disk since it was opened. Reload it or save a copy.';
    expect(sourceFact({ source: 'failed', sourceFact: full, sourceChange: { scope: 'workspace' } })).toBe('Changed on disk');
    // Generic failures are unchanged.
    expect(sourceFact({ source: 'failed', sourceFact: "EACCES: permission denied, open '/x'" })).toBe('Folder is read-only');
  });
});

describe('chip fixes per cause', () => {
  const base = { saveError: 'Project folder changed on disk since it was opened.', attempt: 1, canReload: true, canShow: true };

  it('a changed workspace offers Reload from disk, never Retry', () => {
    expect(saveFixes({ ...base, sourceChange: { scope: 'workspace' } })).toEqual({ fact: 'Not saved · Changed on disk', fixes: ['reload-source', 'save-copy', 'copy-details'] });
    // Without the desktop Reload bridge it still never pretends Retry will help.
    expect(saveFixes({ ...base, canReload: false, sourceChange: { scope: 'workspace' } }).fixes).toEqual(['save-copy', 'copy-details']);
    expect(saveFixes({ ...base, attempt: 2, sourceChange: { scope: 'workspace' } }).fact).toBe('Still not saved · Changed on disk');
  });

  it('a changed document can be shown and retried', () => {
    const change = { scope: 'document', file: 'Paths/Auto 1.path' };
    expect(saveFixes({ ...base, sourceChange: change })).toEqual({ fact: 'Not saved · Paths/Auto 1.path changed on disk', fixes: ['show-source', 'retry', 'save-copy', 'copy-details'] });
    expect(saveFixes({ ...base, sourceChange: { scope: 'document' } }).fixes).toEqual(['retry', 'save-copy', 'copy-details']);
    expect(saveFixes({ ...base, canShow: false, sourceChange: change }).fixes).toEqual(['retry', 'save-copy', 'copy-details']);
  });

  it('a failed Reload or Show file replaces the fact line for its own scope only; generic stays as before', () => {
    expect(saveFixes({ ...base, sourceChange: { scope: 'workspace' }, reloadError: 'Recovery storage full' }).fact).toBe('Couldn’t reload · Recovery storage full');
    expect(saveFixes({ ...base, sourceChange: { scope: 'document', file: 'Paths/A.path' }, showFailure: 'File isn’t there anymore' }).fact).toBe('Couldn’t show file · File isn’t there anymore');
    expect(saveFixes({ ...base, sourceChange: { scope: 'document', file: 'Paths/A.path' }, reloadError: 'x' }).fact).toBe('Not saved · Paths/A.path changed on disk');
    expect(saveFixes({ ...base, saveError: 'Folder is read-only. EACCES', sourceChange: undefined })).toEqual({ fact: 'Not saved · Folder is read-only', fixes: ['retry', 'save-copy', 'copy-details'] });
  });

  const chip = (props) => renderToStaticMarkup(React.createElement(ProjectChip, { name: 'Week 3 autos', folderPath: '/team/Week 3 autos', status: 'failed', robotCode: { status: 'unlinked' }, actions: {}, ...props }));
  it('announces the short cause, and menu-action outcomes in their own persistent region', () => {
    expect(chip({ saveError: 'Project folder changed on disk since it was opened.', sourceChange: { scope: 'workspace' } }))
      .toContain('<span class="sr-only" role="status">Week 3 autos isn’t saved: Changed on disk</span>');
    const noticed = chip({ saveError: 'x', sourceChange: { scope: 'workspace' }, notice: { key: 3, text: 'Couldn’t reload · Recovery storage full' } });
    expect(noticed).toContain('<span class="sr-only" role="status"><span>Couldn’t reload · Recovery storage full</span></span>');
    // The region exists (empty) before anything is announced into it.
    expect(chip({ status: 'saved' })).toContain('<span class="sr-only" role="status"></span><span class="sr-only" role="status"></span>');
    expect(chip({ saveError: 'x', sourceChange: { scope: 'workspace' } })).toContain('>Not saved<');
  });
});

describe('Reload result: recovery facts', () => {
  const kept = { kind: 'recovery', capturedAt: '2026-10-15T12:04:31Z', storedSnapshot: { recordId: 'r1', revision: 4, digest: 'd'.repeat(64) } };
  it('keeps the confirmed copy, and tells full storage from a timeout', () => {
    expect(reloadRecovery({ status: 'not-reloaded', code: 'source-missing', kept })).toEqual({ status: 'saved', at: kept.capturedAt, receipt: kept });
    expect(reloadRecovery({ status: 'not-reloaded', code: 'recovery-capacity', recoveryCode: 'capacity', recoveryFact: 'Recovery storage is full' }))
      .toEqual({ status: 'failed', fact: RECOVERY_FULL, code: 'capacity' });
    const timedOut = reloadRecovery({ status: 'not-reloaded', code: 'recovery-timed-out', recoveryCode: 'timed-out', recoveryFact: 'Recovery copy didn’t finish in time' });
    expect(timedOut).toEqual({ status: 'failed', fact: 'Recovery copy didn’t finish in time' });
    expect(timedOut.code).toBeUndefined();
    // Admission or stale refusals ran no recovery phase: the recovery line stays as it was.
    expect(reloadRecovery({ status: 'not-reloaded', code: 'busy' })).toBeNull();
    expect(reloadRecovery(undefined)).toBeNull();
  });
});

describe('persistence queue', () => {
  it('runs steps in order, and only the newest hold releases itself', async () => {
    const queue = createPersistenceQueue(), order = [], first = deferred();
    const a = queue.enqueue(async () => { order.push('a'); await first.promise; order.push('a done'); });
    const b = queue.enqueue(() => { order.push('b'); throw new Error('b failed'); });
    const c = queue.enqueue(() => order.push('c'));
    await settle();
    expect(order).toEqual(['a']);
    first.resolve(); await a; await expect(b).rejects.toThrow('b failed'); await c;
    expect(order).toEqual(['a', 'a done', 'b', 'c']);
    const older = queue.hold(), newer = queue.hold();
    older(); expect(queue.held()).toBe(true);
    newer(); expect(queue.held()).toBe(false);
  });
});

describe('Reload from disk, renderer half', () => {
  const token = { id: 't1', windowEpoch: 'w1' }, context = { windowEpoch: 'w1', documentSessionId: 's1', targetGeneration: 1 };
  const setup = (overrides = {}) => {
    const log = [], queue = createPersistenceQueue();
    let epoch = 7, revision = 40;
    const ready = deferred();
    const transition = { token: null, ready: ready.promise };
    const reload = deferred();
    const d = {
      busy: () => false, prepare: () => { log.push('prepare'); return true; }, queue,
      invalidateAutosave: () => log.push('invalidate'), epoch: () => epoch, context: () => context,
      begin: () => { log.push('begin'); return transition; }, end: (t) => log.push(t === transition ? 'end' : 'end-other'),
      api: { getProjectSession: async () => { log.push('session'); return { context }; }, reloadProjectSource: (request) => { log.push('reload'); d.request = request; return reload.promise; } },
      materialize: () => { log.push('materialize'); return d.model; }, nextRevision: () => ++revision,
      apply: (result, epoch0) => { log.push('apply'); d.applied = { result, epoch0, heldDuringApply: queue.held() }; return { applied: result.status }; },
      model: { name: 'Week 3 autos' }, ...overrides,
    };
    const start = (token_ = token) => { const running = reloadFromDisk(d); return { running, grant: () => { transition.token = token_; ready.resolve(token_?.id || null); } }; };
    return { d, log, queue, start, reload, setEpoch: (next) => { epoch = next; } };
  };

  it('refuses a second request and an invalid draft before holding anything', async () => {
    const busy = setup({ busy: () => true });
    expect(await reloadFromDisk(busy.d)).toEqual({ busy: true });
    expect(busy.log).toEqual([]); expect(busy.queue.held()).toBe(false);
    const invalid = setup({ prepare: () => false });
    expect(await reloadFromDisk(invalid.d)).toEqual({ blocked: 'invalid' });
    expect(invalid.log).toEqual([]); expect(invalid.queue.held()).toBe(false);
  });

  it('commits the draft, holds autosave and invalidates scheduled saves before its first await', () => {
    const { start, log, queue } = setup();
    start();
    // Synchronous: nothing has awaited yet.
    expect(log).toEqual(['prepare', 'invalidate', 'begin']);
    expect(queue.held()).toBe(true);
  });

  it('waits for a save that already started, then binds one model, token, context and revision to one request', async () => {
    const { d, start, log, queue, reload } = setup();
    const running = deferred();
    void queue.enqueue(async () => { log.push('autosave started'); await running.promise; log.push('autosave done'); });
    await settle();
    const { running: reloading, grant } = start();
    grant(); await settle();
    expect(log).toEqual(['autosave started', 'prepare', 'invalidate', 'begin']);
    running.resolve(); await settle();
    expect(log.slice(4)).toEqual(['autosave done', 'session', 'materialize', 'reload']);
    expect(d.request).toEqual({ context, snapshotRevision: 41, project: d.model, transition: token });
    expect(d.request.project).toBe(d.model);
    expect(queue.held()).toBe(true);
    reload.resolve({ status: 'reloaded', opened: { project: {} }, session: {}, kept: {} });
    expect(await reloading).toEqual({ applied: 'reloaded' });
    expect(d.applied.heldDuringApply).toBe(true);
    expect(log.filter((entry) => entry === 'materialize')).toHaveLength(1);
    expect(log.at(-1)).toBe('end');
    expect(queue.held()).toBe(false);
  });

  it('a document replaced before its step sends nothing to main', async () => {
    const { d, start, log, setEpoch, queue } = setup();
    const { running, grant } = start();
    setEpoch(8); grant();
    expect(await running).toEqual({ applied: 'not-reloaded' });
    expect(log).not.toContain('reload'); expect(log).not.toContain('materialize');
    expect(d.applied).toMatchObject({ result: { code: 'stale' }, epoch0: 7 });
    expect(queue.held()).toBe(false);
  });

  it('a document replaced while the session is read sends nothing either', async () => {
    const box = {};
    const { d, start, log } = setup({ api: { getProjectSession: async () => { box.setEpoch(9); return { context }; }, reloadProjectSource: () => { log.push('reload'); } } });
    box.setEpoch = (value) => { d.epoch = () => value; };
    const { running, grant } = start(); grant();
    await running;
    expect(log).not.toContain('reload');
    expect(d.applied.result.code).toBe('stale');
  });

  it.each(['windowEpoch', 'documentSessionId'])('a different main %s never receives the old editor model', async (field) => {
    const { d, start, log } = setup();
    d.api.getProjectSession = async () => ({ context: { ...context, [field]: 'different' } });
    const { running, grant } = start(); grant(); await running;
    expect(log).not.toContain('reload'); expect(log).not.toContain('materialize');
    expect(d.applied.result.code).toBe('stale');
  });

  it('accepts a target generation advanced by a drained save in the same main document', async () => {
    const { d, start, reload } = setup();
    d.api.getProjectSession = async () => ({ context: { ...context, targetGeneration: 2 } });
    const { running, grant } = start(); grant(); await settle();
    expect(d.request.context.targetGeneration).toBe(2);
    reload.resolve({ status: 'not-reloaded', code: 'read-failed' }); await running;
  });

  it('without a main transition token it never calls Reload', async () => {
    const { d, start, log } = setup();
    const { running, grant } = start(null); grant();
    await running;
    expect(log).not.toContain('reload');
    expect(d.applied.result).toMatchObject({ status: 'not-reloaded', code: 'stale' });
  });

  it('a rejection is a generic not-reloaded fact, and the hold ends after failures too', async () => {
    const { d, start, reload, queue, log } = setup();
    const { running, grant } = start(); grant(); await settle();
    reload.reject(new Error("Error invoking remote method 'project:reloadSource': Error: Something broke. More detail."));
    await running;
    expect(d.applied.result).toEqual({ status: 'not-reloaded', code: 'rejected', fact: 'Something broke' });
    expect(queue.held()).toBe(false);
    expect(log.filter((entry) => entry === 'end')).toHaveLength(1);
  });

  it('a late not-reloaded result is handed over with the admission epoch, so a replaced document can ignore it', async () => {
    const { d, start, reload, setEpoch } = setup();
    const { running, grant } = start(); grant(); await settle();
    setEpoch(12);
    reload.resolve({ status: 'not-reloaded', code: 'source-missing', fact: 'The project source is no longer available' });
    await running;
    expect(d.applied.epoch0).toBe(7);
  });
});

describe('Projects sheet: blocked switch per cause', () => {
  const sheet = (notice, actions = {}) => renderToStaticMarkup(React.createElement(ProjectsDialog, {
    request: { mode: 'list', notice }, current: { name: 'Week 3 autos', folderPath: '/team/Week 3 autos', projectPath: null }, pending: null, onClose() {},
    actions: { listRecent: () => new Promise(() => undefined), creationDefaults: () => new Promise(() => undefined), saveCopy() {}, ...actions } }));
  const blocked = { blocked: 'failed', subject: 'Week 3 autos', message: 'Project folder changed on disk since it was opened', detail: 'Project folder changed on disk since it was opened. Reload it.', run() {} };

  it('a changed workspace offers only Save copy…', () => {
    const markup = sheet({ ...blocked, sourceChange: { scope: 'workspace' } }, { revealSource() {} });
    expect(markup).toContain('isn’t saved');
    expect(markup).toContain('>Changed on disk<');
    expect(markup).toContain('data-fix="save-copy">Save copy…');
    expect(markup).not.toContain('data-fix="retry"');
    expect(markup).not.toContain('data-fix="show-source"');
  });

  it('a changed document offers Show file, Retry and Save copy…, all secondary', () => {
    const markup = sheet({ ...blocked, sourceChange: { scope: 'document', file: 'Paths/Auto 1.path' } }, { revealSource() {} });
    expect(markup).toContain('>Paths/Auto 1.path changed on disk<');
    expect(markup).toMatch(/data-fix="show-source">Show file<.*data-fix="retry">Retry<.*data-fix="save-copy">Save copy…</s);
    expect(markup).not.toMatch(/class="qbtn primary"[^>]*data-fix/);
    // Without the reveal bridge there is no Show file.
    expect(sheet({ ...blocked, sourceChange: { scope: 'document', file: 'Paths/Auto 1.path' } })).not.toContain('Show file');
  });

  it('generic failures keep Retry and their own fact', () => {
    const markup = sheet({ ...blocked, message: 'Folder is read-only' });
    expect(markup).toContain('>Folder is read-only<');
    expect(markup).toContain('data-fix="retry">Retry');
  });
});

describe('Recovered edits after a Reload', () => {
  const entry = (id, updatedAt) => ({ id, recordId: id, name: 'Week 3 autos', available: true, origin: { kind: 'folder', folderPath: '/team/Week 3 autos' }, updatedAt,
    receipt: { recordId: id, revision: 2, digest: 'a'.repeat(64) } });
  const listing = { entries: [entry('older', '2026-10-15T11:00:00Z'), entry('kept', '2026-10-15T12:04:31Z')], limited: false };
  const sheet = (recoveryRecordId) => renderToStaticMarkup(React.createElement(ProjectsDialog, {
    request: { mode: 'list', recoveries: listing, focusRecordId: 'kept' }, current: { name: 'Week 3 autos', folderPath: '/team/Week 3 autos', projectPath: null, recoveryRecordId }, pending: null, onClose() {},
    actions: { listRecent: () => new Promise(() => undefined), creationDefaults: () => new Promise(() => undefined), listRecoveries: () => new Promise(() => undefined) } }));

  it('lists the kept copy once the new session’s record is adopted; the old record id would hide it', () => {
    const recoveryRows = (markup) => markup.match(/data-recovery="true"/g)?.length || 0;
    expect(recoveryRows(sheet('new-session-record'))).toBe(2);
    expect(recoveryRows(sheet('kept'))).toBe(1);
  });
});
