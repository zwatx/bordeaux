import { describe, expect, it } from 'vitest';
import { captureArrangement, moveFolder, movePaths, restoreArrangement } from '../src/renderer/lib/libraryOrder';
import { applyProjectEntry, createUndoHistory, PROJECT_SCOPE, type ProjectEntry } from '../src/renderer/lib/undoHistory';

type Path = { id: string; name: string; folderId?: string; waypoints: { positionLink?: string }[] };
const path = (id: string, folderId?: string): Path => ({ id, name: id.toUpperCase(), waypoints: [], ...(folderId ? { folderId } : {}) });
const project = () => ({
  paths: [path('a', 'f1'), path('b', 'f1'), path('c', 'f2'), path('d'), path('e')],
  pathFolders: [{ id: 'f1', name: 'One' }, { id: 'f2', name: 'Two' }],
  pathLinks: [], robot: {},
});
const layout = (value: { paths: Path[]; pathFolders?: { id: string }[] | null }) => ({
  paths: value.paths.map((item) => item.id + ':' + (item.folderId || '-')), folders: (value.pathFolders || []).map((folder) => folder.id),
});

describe('library arrangement', () => {
  it('moves paths into a folder after its last member, keeping their given order and clearing no other fields', () => {
    const before = project(), after = movePaths(before, ['e', 'd'], 'f1');
    expect(layout(after).paths).toEqual(['a:f1', 'b:f1', 'e:f1', 'd:f1', 'c:f2']);
    expect(after.paths.find((item) => item.id === 'e')).toMatchObject({ name: 'E', waypoints: [] });
    expect(before.paths[3]).not.toHaveProperty('folderId');
  });

  it('inserts before a row in the target folder, moves to no folder, and appends to an empty folder', () => {
    expect(layout(movePaths(project(), ['c'], 'f1', 'a')).paths).toEqual(['c:f1', 'a:f1', 'b:f1', 'd:-', 'e:-']);
    expect(layout(movePaths(project(), ['a'], null)).paths).toEqual(['b:f1', 'c:f2', 'd:-', 'e:-', 'a:-']);
    expect(layout(movePaths(project(), ['e'], null, 'd')).paths).toEqual(['a:f1', 'b:f1', 'c:f2', 'e:-', 'd:-']);
    const empty = { ...project(), pathFolders: [...project().pathFolders, { id: 'f3', name: 'Three' }] };
    expect(layout(movePaths(empty, ['b'], 'f3')).paths).toEqual(['a:f1', 'c:f2', 'd:-', 'e:-', 'b:f3']);
  });

  it('returns the same project for no-op, unknown, or inconsistent targets', () => {
    const before = project();
    expect(movePaths(before, ['b'], 'f1')).toBe(before);
    expect(movePaths(before, ['a'], 'f1', 'b')).toBe(before);
    expect(movePaths(before, ['a'], 'missing')).toBe(before);
    expect(movePaths(before, ['a', 'b'], 'f2', 'a')).toBe(before);
    expect(movePaths(before, ['d'], 'f1', 'c')).toBe(before);
    expect(movePaths(before, ['zz'], null)).toBe(before);
    expect(moveFolder(before, 'f2', null)).toBe(before);
    expect(moveFolder(before, 'f1', 'f2')).toBe(before);
    expect(moveFolder(before, 'f1', 'f1')).toBe(before);
  });

  it('reorders folders before another folder or to the end', () => {
    expect(layout(moveFolder(project(), 'f2', 'f1')).folders).toEqual(['f2', 'f1']);
    expect(layout(moveFolder(project(), 'f1', null)).folders).toEqual(['f2', 'f1']);
  });

  it('restores a recorded arrangement while keeping newer paths and folders in place', () => {
    const before = project(), after = movePaths(before, ['a', 'd'], 'f2');
    const arrangement = captureArrangement(before, after);
    expect(arrangement.folders).toEqual({ a: 'f1', d: null });
    const later = { ...after, paths: [...after.paths, path('new', 'f2')], pathFolders: [...after.pathFolders, { id: 'f9', name: 'Later' }] };
    const restored = restoreArrangement(later, arrangement);
    expect(layout(restored)).toEqual({ paths: ['a:f1', 'b:f1', 'c:f2', 'd:-', 'e:-', 'new:f2'], folders: ['f1', 'f2', 'f9'] });
    expect(restoreArrangement(before, captureArrangement(before, before))).toBe(before);
  });

  it('keeps the current folder when the recorded one was deleted, and skips deleted paths', () => {
    const before = project(), after = movePaths(before, ['c'], 'f1');
    const arrangement = captureArrangement(before, after);
    const changed = { ...after, paths: after.paths.filter((item) => item.id !== 'a'), pathFolders: after.pathFolders.filter((folder) => folder.id !== 'f2') };
    expect(layout(restoreArrangement(changed, arrangement)).paths).toEqual(['b:f1', 'c:f1', 'd:-', 'e:-']);
  });

  it('undoes and redoes as one journal entry', () => {
    const history = createUndoHistory<ProjectEntry>();
    const before = project(), moved = moveFolder(movePaths(before, ['d', 'e'], 'f2', 'c'), 'f2', 'f1');
    history.record({ scope: PROJECT_SCOPE, touches: [], kind: 'library', arrangement: captureArrangement(before, moved) });
    let current: ReturnType<typeof project> = moved;
    const apply = (entry: ProjectEntry) => { const applied = applyProjectEntry(current, entry, null); if (!applied) return null; current = applied.project; return applied.inverse; };
    expect(history.undo([PROJECT_SCOPE], apply)).toBe(true);
    expect(layout(current)).toEqual(layout(before));
    expect(history.redo([PROJECT_SCOPE], apply)).toBe(true);
    expect(layout(current)).toEqual(layout(moved));
  });
});
