import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProjectsDialog } from '../src/renderer/components/ProjectsDialog';

// The first paint, before recents arrive: only the current row and any recovered copies. Opening the menu, its items for
// recents, pointer/keyboard input and focus return are exercised in scripts/verify-project-folder-ui.
const never = () => new Promise(() => undefined);
const sheet = (current, actions = {}, recoveries) => renderToStaticMarkup(React.createElement(ProjectsDialog, {
  request: { mode: 'list', ...(recoveries && { recoveries }) }, current: { recoveryRecordId: null, ...current }, pending: null, onClose() {},
  actions: { listRecent: never, creationDefaults: never, ...(recoveries && { listRecoveries: never }), ...actions } }));
const saved = { name: 'Week 3 autos', folderPath: '/team/Week 3 autos', projectPath: '/team/Week 3 autos/.bordeaux-workspace.json' };

describe('Projects row actions', () => {
  it('gives a saved current row its … in the reserved column, as one roving stop', () => {
    const markup = sheet(saved, { revealCurrent: never, copyOwner: never });
    expect(markup).toContain('class="pj-more" tabindex="0" aria-label="Actions for Week 3 autos" title="Actions" aria-haspopup="menu" aria-expanded="false"');
    expect(markup).not.toContain('pj-remove');
    expect(markup).not.toContain('role="menu"');
  });

  it('keeps the column without a … when the current row has nothing to offer', () => {
    // Untitled has no folder to show, and without the copy form there is no Save… either.
    const markup = sheet({ name: 'Untitled', folderPath: null, projectPath: null, untitled: true }, { revealCurrent: never });
    expect(markup).not.toContain('pj-more');
    expect(markup).toContain('class="pj-slot" aria-hidden="true"');
  });

  it('leaves recovered copies with their two-step ×', () => {
    const entry = { id: 'r1', recordId: 'r1', name: 'Copy', available: true, discardable: true, resolved: false, updatedAt: '2026-10-16T10:00:00.000Z', origin: { kind: 'untitled', id: 'u' }, receipt: { recordId: 'r1', revision: 1, digest: 'a'.repeat(64) } };
    const markup = sheet(saved, { revealCurrent: never, prepareDiscard: never }, { entries: [entry], limited: false, capacity: null });
    expect(markup.match(/data-recovery="discard-step"/g)).toHaveLength(1);
    expect(markup.match(/class="pj-more"/g)).toHaveLength(1);
  });
});
