import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { LibraryRail, referencingRoutines, selectedPathIds } from '../src/renderer/components/EditorLibrary';
import { PushControl } from '../src/renderer/components/PushControl';
import { effectiveSelection, prunedSelection, readPushSelection } from '../src/renderer/hooks/usePushSelection';

describe('library path references', () => {
  it('blocks deletion for either decision route and generated fallback branches', () => {
    const routines = [
      { id: 'first', nodes: [{ type: 'decision', then: [{ type: 'path', ref: 'A' }], else: [{ type: 'path', ref: 'B' }] }] },
      { id: 'fallback', nodes: [{ type: 'generatedTrajectory', fallback: { type: 'branch', nodes: [{ type: 'decision', then: [], else: [{ type: 'path', ref: 'A' }] }] } }] },
      { id: 'stop', nodes: [{ type: 'generatedTrajectory', fallback: { type: 'safeStop' } }] },
    ];
    expect(referencingRoutines(routines, 'A').map((routine) => routine.id)).toEqual(['first', 'fallback']);
    expect(referencingRoutines(routines, 'B').map((routine) => routine.id)).toEqual(['first']);
    expect(referencingRoutines(routines, 'unreferenced')).toEqual([]);
  });
});

describe('batch selection', () => {
  it('preserves identity across reorder, rename, and filtering while dropping deleted paths', () => {
    const paths = [{ id: 'B', name: 'Renamed B' }, { id: 'A', name: 'Hidden by search' }, { id: 'C', name: 'C' }];
    expect(selectedPathIds(paths, ['A', 'B', 'deleted', 'B'])).toEqual(['B', 'A']);
    expect(selectedPathIds(paths.filter((path) => path.id !== 'A'), ['A', 'B'])).toEqual(['B']);
  });
});

afterEach(() => vi.unstubAllGlobals());
describe('routine delivery capability', () => {
  it.each([false, true])('exposes routine upload only when supported: %s', (routinePush) => {
    vi.stubGlobal('window', { bordeauxAPI: { robotDeliveryCapabilities: { routinePush } } });
    const html = renderToStaticMarkup(React.createElement(PushControl, {
      place: 'routines', paths: [], selection: { selected: [] }, activeRoutine: { id: 'r', name: 'Routine', nodes: [] }, controller: { busy: false },
    }));
    if (!routinePush) expect(html).toBe('');
    expect(html.includes('Push routine')).toBe(routinePush);
    if (routinePush) expect(html).toMatch(/<button type="button" class="push-button"[^>]*>Push routine<\/button>/);
  });

  it('keeps Push out of the library itself', () => {
    vi.stubGlobal('window', { bordeauxAPI: { robotDeliveryCapabilities: { routinePush: true } } });
    const html = renderToStaticMarkup(React.createElement(LibraryRail, {
      preferenceKey: 'capability', mode: 'routines', project: { paths: [] }, routines: [{ id: 'r', name: 'Routine', nodes: [] }],
      activeRoutineId: 'r', controller: { busy: false, itemStatus: () => ({}) }, actions: {}, times: {},
    }));
    expect(html).not.toMatch(/Push routine|push-button|role="tablist"/);
  });
});

describe('push control scope', () => {
  const paths = [{ id: 'A', name: 'Left start → score', waypoints: [{}, {}] }, { id: 'B', name: 'Depot run', waypoints: [{}, {}] }, { id: 'C', name: 'Unfinished', waypoints: [{}] }];
  const render = (selected, controller = {}) => renderToStaticMarkup(React.createElement(PushControl, {
    place: 'paths', paths, selection: { selected }, controller: { busy: false, fileTransfer: true, settings: { endpoint: { host: '10.24.68.2', directory: '/home/lvuser/Paths' } }, ...controller },
  }));

  it('names its exact scope and folds the destination into the split button', () => {
    expect(render(['A'])).toMatch(/aria-keyshortcuts="(Meta|Control)\+Shift\+P" data-shortcut="[^"]+">Push path<\/button>/);
    expect(render(['A'])).toMatch(/title="Left start → score · (?:Ctrl\+Shift\+P|⇧⌘P)"/);
    expect(render(['A', 'B'])).toContain('>Push 2 paths</button>');
    // The accessible name is exactly the scope; the shortcut is announced once, through aria-keyshortcuts.
    expect(render(['A'])).toMatch(/class="push-button"[^>]* aria-label="Push path" aria-keyshortcuts="(Meta|Control)\+Shift\+P"/);
    expect(render(['A', 'B'])).toContain('aria-label="Push 2 paths"');
    expect(render(['A'])).toContain('>10.24.68.2 · Paths<');
    // One split control: Push, then a menu button whose name carries the robot state; no separate status or Push all buttons.
    expect(render(['A'])).toMatch(/<div class="push-split" role="group" aria-label="Push"><button type="button" class="push-button"[^]*<button type="button" class="push-menu-trigger" aria-haspopup="menu" aria-expanded="false" aria-label="Push options · 10.24.68.2 · Paths"/);
    expect(render(['A'])).not.toMatch(/push-destination|class="push-all"/);
  });

  it('refuses unfinished paths and a busy controller, and shows each frozen outcome', () => {
    expect(render(['A', 'C'])).toMatch(/<button type="button" class="push-button" disabled="" title="Place at least two waypoints to push · (?:Ctrl\+Shift\+P|⇧⌘P)"/);
    expect(render(['A'], { busy: true })).toMatch(/class="push-button" disabled=""/);
    expect(render(['A'], { phase: 'uploading' })).toContain('>Uploading…<');
    expect(render(['A'], { phase: 'failed', error: 'Readback did not match' })).toMatch(/data-tone="bad"[^]*Not sent · Readback did not match/);
    expect(render(['A'], { phase: 'transferred', result: { files: [{}, {}], directory: '/home/lvuser/Paths' } })).toMatch(/data-tone="good"[^]*Pushed 2 · /);
  });
});

describe('push selection', () => {
  const paths = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
  it('applies a stored choice only to the path it was made for, in project order without deleted paths', () => {
    expect(effectiveSelection({ checked: ['C', 'gone', 'A'], selectionActiveId: 'A' }, paths, 'A')).toEqual(['A', 'C']);
    expect(effectiveSelection({ checked: ['C', 'A'], selectionActiveId: 'A' }, paths, 'B')).toEqual(['B']);
    expect(effectiveSelection({ checked: ['gone'], selectionActiveId: 'A' }, paths, 'A')).toEqual(['A']);
    expect(effectiveSelection({ checked: [], selectionActiveId: null }, paths, null)).toEqual([]);
  });

  it('prunes deleted paths from the open path\'s stored choice, so Undo of a deletion does not re-add it', () => {
    const stored = { checked: ['A', 'B', 'C'], selectionActiveId: 'A' };
    const afterDelete = prunedSelection(stored, paths.filter((path) => path.id !== 'B'), 'A');
    expect(afterDelete).toEqual({ checked: ['A', 'C'], selectionActiveId: 'A' });
    // Undo restores B to the project; the pruned choice stays without it and needs no further pruning.
    expect(effectiveSelection(afterDelete, paths, 'A')).toEqual(['A', 'C']);
    expect(prunedSelection(afterDelete, paths, 'A')).toBe(null);
    // Another path's choice is left alone (it is ignored and replaced when that path opens).
    expect(prunedSelection({ checked: ['gone'], selectionActiveId: 'B' }, paths, 'A')).toBe(null);
  });

  it('reads its own key, falling back to the older library preference', () => {
    const store = new Map([['bordeaux.library.legacy-project.paths', JSON.stringify({ query: 'x', checked: ['A', 'B', 3], selectionActiveId: 'A' })],
      ['bordeaux.pushSelection.current-project', JSON.stringify({ checked: ['C'], selectionActiveId: 'C' })]]);
    vi.stubGlobal('localStorage', { getItem: (key) => store.get(key) ?? null, setItem: () => {} });
    expect(readPushSelection('legacy-project')).toEqual({ checked: ['A', 'B'], selectionActiveId: 'A' });
    expect(readPushSelection('current-project')).toEqual({ checked: ['C'], selectionActiveId: 'C' });
    expect(readPushSelection('new-project')).toEqual({ checked: [], selectionActiveId: null });
  });
});
