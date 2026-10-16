import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { checkpointMatch, createCheckpointChannel, creationFailure, departureCopy, lifecycleApi, originLocation, recoveryAfterListing, recoveryOutcome, recoveryToken,
  rememberOfferedRecoveries, readOfferedRecoveries, sourceFact, unofferedRecoveries } from '../src/renderer/lib/projectLifecycle';
import { blankProject } from '../src/renderer/lib/editorProject';
import { createDemoProject } from '../src/shared/project/defaults';
import { ProjectDeparture, ProjectsDialog } from '../src/renderer/components/ProjectsDialog';
import { ProjectChip } from '../src/renderer/components/ProjectChip';

const context = { windowEpoch: 'w', documentSessionId: 'd', targetGeneration: 1 };
const memory = () => { const values = new Map(); return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; };

describe('checkpoint matching', () => {
  it('delivers only the update for the request that started it', () => {
    let emit;
    const channel = createCheckpointChannel({ onProjectCheckpoint: (listener) => { emit = listener; return () => undefined; } });
    const seen = [];
    channel.watch(checkpointMatch({ mode: 'background', snapshotRevision: 4, context }), (update) => seen.push(update.operationId));
    emit({ mode: 'background', snapshotRevision: 3, context, operationId: 'older' });
    emit({ mode: 'departure', snapshotRevision: 4, context, requestId: 'r', operationId: 'other-mode' });
    emit({ mode: 'background', snapshotRevision: 4, context: { ...context, documentSessionId: 'next' }, operationId: 'other-document' });
    emit({ mode: 'background', snapshotRevision: 4, context: { ...context, targetGeneration: 2 }, operationId: 'same-session-save-as' });
    emit({ mode: 'background', snapshotRevision: 4, context, operationId: 'mine' });
    expect(seen).toEqual(['same-session-save-as', 'mine']);
  });

  it('matches departure updates by request as well', () => {
    const match = checkpointMatch({ mode: 'departure', snapshotRevision: 1, context, requestId: 'r1' });
    expect(match({ mode: 'departure', snapshotRevision: 1, context, requestId: 'r2' })).toBe(false);
    expect(match({ mode: 'departure', snapshotRevision: 1, context, requestId: 'r1' })).toBe(true);
  });

  it('needs the whole bridge before taking the modern path', () => {
    expect(lifecycleApi({ checkpointProject() {}, getProjectSession() {} })).toBeNull();
    expect(lifecycleApi({ checkpointProject() {}, getProjectSession() {}, onProjectCheckpoint() {} })).not.toBeNull();
  });
});

describe('outcomes and copy', () => {
  it('shows a recovery time only for a stored receipt', () => {
    expect(recoveryOutcome({ recovery: 'saved', recoveryReceipt: { capturedAt: '2026-10-12T14:31:07Z' } })).toMatchObject({ status: 'saved', at: '2026-10-12T14:31:07Z' });
    expect(recoveryOutcome({ recovery: 'saved' })).toBeNull();
    expect(recoveryOutcome({ recovery: 'failed', recoveryFact: 'Recovery storage is full' })).toEqual({ status: 'failed', fact: 'Recovery storage is full' });
    expect(recoveryOutcome({ recovery: 'pending' })).toBeNull();
  });

  it('names a source outcome plainly', () => {
    expect(sourceFact({ source: 'unavailable' }, false)).toBe('Not in a folder yet');
    expect(sourceFact({ source: 'unavailable' }, true)).toBe('Recovered copy · not in a folder');
    expect(sourceFact({ source: 'timed-out', sourceFact: 'anything' })).toBe('Folder isn’t responding');
    expect(sourceFact({ source: 'failed', sourceFact: "EACCES: permission denied, open '/x'" })).toBe('Folder is read-only');
  });

  it('uses the departure verb throughout', () => {
    expect(departureCopy('update')).toMatchObject({ leave: 'Install and restore later', discard: 'Install without saving…', confirm: 'Discard and install', queued: 'Installs when done' });
    expect(departureCopy('reload-ignoring-cache').hint).toBe('Can’t reload yet · Finish or cancel this field');
  });

  it('puts creation failures where they can be fixed', () => {
    expect(creationFailure(new Error("Error invoking remote method 'project:createNamed': Error: EACCES: permission denied, mkdir '/Users/t/Documents/Bordeaux'"))).toEqual({ field: 'location', fact: 'No access to this location' });
    expect(creationFailure(new Error('ENOENT: no such file or directory, mkdir')).field).toBe('location');
    expect(creationFailure(new Error('That project folder already exists. Choose another name.'))).toEqual({ field: 'name', fact: 'That project folder already exists' });
  });

  it('keeps legacy origins distinct from their folder', () => {
    expect(originLocation({ kind: 'legacy', folderPath: '/a', legacyFile: '/a/Other.bordeaux', projectPath: null })).toEqual({ folderPath: '/a', projectPath: null, legacyFile: '/a/Other.bordeaux' });
    expect(originLocation({ kind: 'untitled', id: 'x' })).toEqual({ folderPath: null, projectPath: null });
  });
});

describe('offer once per exact record', () => {
  const record = (id, revision, digest, updatedAt) => ({ id, recordId: id, available: true, receipt: { recordId: id, revision, digest }, updatedAt });
  it('acknowledges only displayed records, so a newer revision or an unseen record in the same instant is offered again', () => {
    const storage = memory();
    const shown = record('a', 1, 'd1', '2026-10-12T14:31:07.000Z'), unseen = record('b', 1, 'd2', '2026-10-12T14:31:07.000Z');
    rememberOfferedRecoveries([shown], [shown], storage);
    const offered = readOfferedRecoveries(storage);
    expect(unofferedRecoveries([shown, unseen], offered).map((entry) => entry.id)).toEqual(['b']);
    expect(unofferedRecoveries([record('a', 2, 'd3', '2026-10-12T14:31:07.000Z')], offered)).toHaveLength(1);
  });

  it('prunes tokens for records that no longer exist, and a failed write only repeats the offer', () => {
    const storage = memory();
    const a = record('a', 1, 'd1'), b = record('b', 1, 'd2');
    rememberOfferedRecoveries([a, b], [a, b], storage);
    rememberOfferedRecoveries([], [b], storage);
    expect([...readOfferedRecoveries(storage)]).toEqual([recoveryToken(b)]);
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(() => rememberOfferedRecoveries([a], [a], broken)).not.toThrow();
    expect(readOfferedRecoveries(broken).size).toBe(0);
  });

  it('gives unreadable records a token without inventing a receipt', () => {
    expect(recoveryToken({ id: 'entry-7', recordId: null, available: false, code: 'invalid-record', updatedAt: undefined })).toBe('e:entry-7:invalid-record:');
  });
});

describe('blank first-use document', () => {
  it('is one empty path with the usual defaults, and the demo fixture is unchanged', () => {
    const blank = blankProject(), demo = createDemoProject();
    expect(blank.paths).toHaveLength(1);
    expect(blank.paths[0].waypoints).toEqual([]);
    expect(blank.robot).toEqual(demo.robot);
    expect(blank.routines).toHaveLength(1);
    expect(blank.editor.activePathId).toBe(blank.paths[0].id);
    expect(demo.paths[0].waypoints).toHaveLength(2);
  });
});

describe('departure sheet', () => {
  const sheet = (props) => renderToStaticMarkup(React.createElement(ProjectDeparture, { reason: 'quit', subject: 'Week 3 autos', step: 1, pending: null, saveCopyFact: '',
    onKeepEditing() {}, onSaveCopy() {}, onLeave() {}, onDiscardStep() {}, onDiscard() {}, ...props }));
  const failed = { source: 'failed', sourceFact: 'Folder is read-only', untitled: false, recovery: 'saved', recoveryAt: '2026-10-12T14:31:07Z', recoveryFact: null, lastSourceSavedAt: '2026-10-12T14:02:44Z' };

  it('keeps the recovery as a plain secondary, with Save copy… the one primary and no "Saved"', () => {
    const markup = sheet({ outcome: failed });
    expect(markup).toContain('“Week 3 autos” isn’t saved');
    expect(markup).toContain('Folder is read-only');
    expect(markup).toContain('Recovery copy · <time dateTime="2026-10-12T14:31:07Z">');
    expect(markup).toContain('data-departure="leave">Quit and restore later');
    expect(markup).toMatch(/class="qbtn primary" data-departure="primary">Save copy…/);
    expect(markup.match(/primary/g)).toHaveLength(2);
    expect(markup).not.toMatch(/>Saved</);
  });

  it('offers Save… for Untitled', () => {
    expect(sheet({ outcome: { ...failed, source: 'unavailable', sourceFact: 'Not in a folder yet', untitled: true } })).toContain('>Save…<');
  });

  it('makes leaving without a recovery a two-step discard in the quiet-danger tier', () => {
    const blocked = { ...failed, recovery: 'failed', recoveryAt: null, recoveryFact: 'Disk is full' };
    const first = sheet({ outcome: blocked, reason: 'update' });
    expect(first).toContain('“Week 3 autos” can’t be saved');
    expect(first).toContain('No recovery copy · Disk is full');
    expect(first).toContain('class="delbtn" data-departure="discard-step">Install without saving…');
    expect(first).not.toContain('restore later');
    const second = sheet({ outcome: blocked, reason: 'update', step: 2 });
    expect(second).toContain('Edits since <time');
    expect(second).toContain('data-departure="back">Back');
    expect(second).toContain('class="delbtn" data-departure="discard">Discard and install');
  });

  it('says exactly what a discard loses', () => {
    const blocked = { ...failed, recovery: 'failed', recoveryAt: null, recoveryFact: 'Disk is full' };
    expect(sheet({ outcome: { ...blocked, detached: true, lastSourceSavedAt: null }, step: 2 })).toContain('All edits in this project will be lost');
    expect(sheet({ outcome: { ...blocked, detached: false, lastSourceSavedAt: null }, step: 2 })).toContain('Unsaved edits will be lost');
    const since = sheet({ outcome: { ...blocked, detached: false }, step: 2 });
    expect(since).toContain('Edits since <time dateTime="2026-10-12T14:02:44Z">');
    expect(since).not.toContain('All edits');
  });

  it('names the leaving step by its verb', () => {
    expect(departureCopy('quit').leaving).toBe('Quitting…');
    expect(departureCopy('reload-ignoring-cache').leaving).toBe('Reloading…');
    expect(departureCopy('update').leaving).toBe('Installing…');
  });

  it('disables every choice while Save copy runs', () => {
    const markup = sheet({ outcome: failed, pending: 'save-copy' });
    expect(markup).toContain('>Saving…<');
    expect(markup.match(/disabled=""/g)).toHaveLength(3);
  });
});

describe('first-use New and the recovered chip', () => {
  it('first use has Skip, no robot copy, and a Documents suggestion', () => {
    const markup = renderToStaticMarkup(React.createElement(ProjectsDialog, { request: { mode: 'new', firstUse: true }, current: { name: 'Untitled', folderPath: null, projectPath: null },
      actions: { listRecent: () => new Promise(() => undefined), creationDefaults: () => new Promise(() => undefined) }, pending: null, onClose() {} }));
    expect(markup).toContain('data-action="skip">Skip<');
    expect(markup).not.toContain('Copy robot and limits');
    expect(markup).toContain('Project name');
  });

  it('a restored draft reads Recovered and offers Save copy…', () => {
    const markup = renderToStaticMarkup(React.createElement(ProjectChip, { name: 'Week 2 autos', folderPath: null, status: 'recovered', robotCode: { status: 'unlinked' }, actions: {},
      recoveredFrom: { origin: { kind: 'folder', folderPath: '/Users/team/frc-2026/Week 2 autos' }, capturedAt: '2026-10-12T14:31:00Z' } }));
    expect(markup).toContain('data-status="recovered"');
    expect(markup).toContain('>Recovered<');
    expect(markup).toContain('Week 2 autos is recovered and not in a folder yet');
  });
});

describe('full recovery storage', () => {
  it('reads full storage from main’s code only, never from prose', () => {
    expect(recoveryOutcome({ recovery: 'failed', recoveryCode: 'capacity', recoveryFact: 'Recovery storage is full' })).toEqual({ status: 'failed', fact: 'Recovery storage full', code: 'capacity' });
    expect(recoveryOutcome({ recovery: 'failed', recoveryFact: 'Recovery storage is full' })).toEqual({ status: 'failed', fact: 'Recovery storage is full' });
    expect(recoveryOutcome({ recovery: 'saved', recoveryCode: 'capacity', recoveryReceipt: { capturedAt: '2026-10-12T14:31:07Z' } })).toMatchObject({ status: 'saved' });
  });

  it('a current listing with room retires the full fact but never invents a recovery copy', () => {
    const full = { status: 'failed', fact: 'Recovery storage full', code: 'capacity' };
    expect(recoveryAfterListing(full, { full: false })).toEqual({ status: 'failed', fact: '', code: 'capacity-freed' });
    expect(recoveryAfterListing(full, { full: true })).toBe(full);
    expect(recoveryAfterListing(full, null)).toBe(full);
    const other = { status: 'failed', fact: 'Disk is full' };
    expect(recoveryAfterListing(other, { full: false })).toBe(other);
    const saved = { status: 'saved', at: '2026-10-12T14:31:07Z' };
    expect(recoveryAfterListing(saved, { full: false })).toBe(saved);
  });

  it('the departure sheet shows full storage with Manage… only from the structured code', () => {
    const sheet = (outcome, onManage) => renderToStaticMarkup(React.createElement(ProjectDeparture, { reason: 'update', subject: 'Untitled', step: 1, pending: null, saveCopyFact: '',
      outcome: { source: 'unavailable', sourceFact: 'Not in a folder yet', untitled: true, recovery: 'failed', recoveryAt: null, ...outcome },
      onKeepEditing() {}, onSaveCopy() {}, onLeave() {}, onDiscardStep() {}, onDiscard() {}, onManage }));
    const full = sheet({ recoveryFact: 'Recovery storage is full', recoveryCode: 'capacity' }, () => undefined);
    expect(full).toContain('No recovery copy · Recovery storage full');
    expect(full).toContain('data-departure="manage">Manage…<');
    expect(full).toContain('Install without saving…');
    expect(sheet({ recoveryFact: 'Recovery storage is full', recoveryCode: 'capacity' })).not.toContain('Manage…');
    expect(sheet({ recoveryFact: 'Recovery storage is full' }, () => undefined)).not.toContain('Manage…');
  });

  it('the chip face stays Saved when recovery storage is full', () => {
    const markup = renderToStaticMarkup(React.createElement(ProjectChip, { name: 'Week 3 autos', folderPath: '/team/Week 3 autos', status: 'saved', robotCode: { status: 'unlinked' },
      recovery: { status: 'failed', fact: 'Recovery storage full', code: 'capacity' }, actions: { manageRecoveries() {} } }));
    expect(markup).toContain('>Saved<');
    expect(markup).not.toContain('Recovery storage full');
  });
});
