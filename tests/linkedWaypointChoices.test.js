import { describe, expect, it } from 'vitest';
import { PathLinks } from '../src/renderer/lib/pathLinks';
import { captureProjectChange, createUndoHistory, pathScope, restoreProjectChange } from '../src/renderer/lib/undoHistory';

const point = (x, y = 0, extra = {}) => ({ x, y, ...extra });
const path = (id, waypoints, extra = {}) => ({ id, name: id.toUpperCase(), waypoints, markers: [], ...extra });
const project = (paths, extra = {}) => ({ paths, pathLinks: [], robot: {}, ...extra });
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}

describe('docked shared-position choices', () => {
  it('offers all other-path waypoints, named or unnamed, with explicit targets and positional labels', () => {
    const before = freeze(project([
      path('a', [point(0), point(1, 0, { positionName: 'Same path only' }), point(2)]),
      path('b', [point(3), point(4, 0, { positionName: 'Pickup' }), point(5)]),
      path('c', [point(6)]),
    ]));
    expect(PathLinks.linkChoices(before, 'a', 0)).toEqual([
      { value: 'b:0', pathId: 'b', index: 0, label: 'B · Start', meta: '', searchText: 'B' },
      { value: 'b:1', pathId: 'b', index: 1, label: 'Pickup', meta: 'B · Waypoint 1', searchText: 'B' },
      { value: 'b:2', pathId: 'b', index: 2, label: 'B · End', meta: '', searchText: 'B' },
      { value: 'c:0', pathId: 'c', index: 0, label: 'C · Start', meta: '', searchText: 'C' },
    ]);
  });

  it('collapses mixed shared/endpoint components and excludes the whole selected component', () => {
    const before = freeze(project([
      path('a', [point(0, 0, { positionLink: 'self' }), point(1), point(2, 0, { positionLink: 'candidate', positionName: 'First authored name' })]),
      path('b', [point(0, 0, { positionLink: 'self' }), point(2, 0, { positionLink: 'candidate', positionName: 'Other authored name' }), point(3)]),
      path('c', [point(3, 0, { positionLink: 'endpoint-group' }), point(4), point(2, 0, { positionLink: 'candidate' })]),
      path('d', [point(5), point(3, 0, { positionLink: 'endpoint-group', positionName: 'Station' })]),
    ], { pathLinks: [{ fromPathId: 'b', toPathId: 'c' }] }));
    const choices = PathLinks.linkChoices(before, 'a', 0);
    expect(choices).toEqual([
      { value: 'b:1', pathId: 'b', index: 1, label: 'First authored name', meta: '3 paths', searchText: 'A B C' },
      { value: 'b:2', pathId: 'b', index: 2, label: 'Station', meta: '3 paths', searchText: 'B C D' },
      { value: 'c:1', pathId: 'c', index: 1, label: 'C · Waypoint 1', meta: '', searchText: 'C' },
      { value: 'd:0', pathId: 'd', index: 0, label: 'D · Start', meta: '', searchText: 'D' },
    ]);
    expect(before.paths[2].waypoints[0].positionLink).toBe('endpoint-group');
    expect(before.paths[1].waypoints[1].positionName).toBe('Other authored name');
  });

  it('orders by the first other-path representative even when a component begins on the current path', () => {
    const before = project([
      path('a', [point(0), point(1, 0, { positionLink: 'late' })]),
      path('b', [point(2)]),
      path('c', [point(3), point(1, 0, { positionLink: 'late' })]),
    ]);
    expect(PathLinks.linkChoices(before, 'a', 0).map(({ value }) => value)).toEqual(['b:0', 'c:0', 'c:1']);
    expect(PathLinks.linkChoices(before, 'a', 0).at(-1)).toMatchObject({ label: 'C · End', meta: '2 paths', searchText: 'A C' });
  });

  it('counts distinct paths rather than occurrences and resolves a later name for a single-path component', () => {
    const before = project([
      path('a', [point(0)]),
      path('b', [point(1, 0, { positionLink: 'repeat' }), point(1, 0, { positionLink: 'repeat', positionName: 'Loading' }), point(2)]),
    ]);
    expect(PathLinks.linkChoices(before, 'a', 0)).toEqual([
      { value: 'b:0', pathId: 'b', index: 0, label: 'Loading', meta: 'B · Start', searchText: 'B' },
      { value: 'b:2', pathId: 'b', index: 2, label: 'B · End', meta: '', searchText: 'B' },
    ]);
  });

  it('handles endpoint cycles, empty paths and dangling endpoint links without duplicate choices', () => {
    const before = project([path('a', [point(0)]), path('b', [point(1)]), path('c', [point(1)]), path('empty', [])], {
      pathLinks: [{ fromPathId: 'b', toPathId: 'c' }, { fromPathId: 'c', toPathId: 'b' },
        { fromPathId: 'missing', toPathId: 'b' }, { fromPathId: 'empty', toPathId: 'c' }],
    });
    expect(PathLinks.linkChoices(before, 'a', 0)).toEqual([
      { value: 'b:0', pathId: 'b', index: 0, label: 'B · Start', meta: '2 paths', searchText: 'B C' },
    ]);
  });

  it('returns no choices for no other points, a fully connected project, or a missing selection', () => {
    expect(PathLinks.linkChoices(project([]), 'a', 0)).toEqual([]);
    expect(PathLinks.linkChoices(project([path('a', [point(0), point(1)])]), 'a', 0)).toEqual([]);
    const connected = project([path('a', [point(0, 0, { positionLink: 'all' })]), path('b', [point(0, 0, { positionLink: 'all' })])]);
    expect(PathLinks.linkChoices(connected, 'a', 0)).toEqual([]);
    expect(PathLinks.linkChoices(connected, 'missing', 0)).toEqual([]);
    expect(PathLinks.linkChoices(connected, 'a', 4)).toEqual([]);
  });
});

const merged = (names = []) => {
  const before = project([
    path('a', [point(1, 2, { positionLink: 'source', ...(names[0] && { positionName: names[0] }) }), point(4)]),
    path('b', [point(10, 20, { positionLink: 'target', ...(names[1] && { positionName: names[1] }) })]),
    path('c', [point(10, 20, { ...(names[2] && { positionName: names[2] }) })]),
  ], { pathLinks: [{ fromPathId: 'b', toPathId: 'c' }] });
  return PathLinks.linkPosition(before, 'a', 0, 'b', 0, 'unused');
};

describe('naming a newly merged shared position', () => {
  it.each([0, 1, 2])('keeps the exact document when merged member %i already has an authored name', (member) => {
    const names = []; names[member] = 'Authored station';
    const linked = freeze(merged(names));
    expect(PathLinks.nameNewSharedPoint(linked, 'a', 0)).toBe(linked);
    expect(linked.paths[member].waypoints[0].positionName).toBe('Authored station');
  });

  it('preserves differing authored names without choosing or rewriting one', () => {
    const linked = freeze(merged(['Source alias', 'Target alias', 'Endpoint alias']));
    expect(PathLinks.nameNewSharedPoint(linked, 'a', 0)).toBe(linked);
    expect(linked.paths.map((item) => item.waypoints[0].positionName)).toEqual(['Source alias', 'Target alias', 'Endpoint alias']);
  });

  it('copies only the current point/path and names the merged group once', () => {
    const linked = freeze(merged()), snapshot = structuredClone(linked);
    const named = PathLinks.nameNewSharedPoint(linked, 'a', 0);
    expect(named).not.toBe(linked); expect(named.paths).not.toBe(linked.paths);
    expect(named.paths[0]).not.toBe(linked.paths[0]); expect(named.paths[0].waypoints).not.toBe(linked.paths[0].waypoints);
    expect(named.paths[0].waypoints[0]).toEqual({ ...linked.paths[0].waypoints[0], positionName: 'Shared point 1' });
    expect(named.paths[0].waypoints[1]).toBe(linked.paths[0].waypoints[1]);
    expect(named.paths[1]).toBe(linked.paths[1]); expect(named.paths[2]).toBe(linked.paths[2]);
    expect(named.pathLinks).toBe(linked.pathLinks); expect(named.robot).toBe(linked.robot);
    expect(named.paths.map((item) => item.waypoints[0].positionLink)).toEqual(['target', 'target', 'target']);
    expect(named.paths.slice(1).every((item) => !item.waypoints[0].positionName)).toBe(true);
    expect(PathLinks.waypointName(named, named.paths[2], 0)).toBe('Shared point 1');
    expect(PathLinks.nameNewSharedPoint(named, 'b', 0)).toBe(named);
    expect(linked).toEqual(snapshot);
  });

  it.each([
    [[' shared POINT 1 ', 'Shared point 3'], 'Shared point 2'],
    [['Shared point 2', 'SHARED POINT 3'], 'Shared point 1'],
    [['Shared point 1', 'Shared point 2', 'Shared point 4'], 'Shared point 3'],
  ])('uses the smallest unused positive suffix across all project names: %j', (used, expected) => {
    const linked = merged();
    linked.paths.push(path('reserved', used.map((positionName) => point(0, 0, { positionName }))));
    expect(PathLinks.nameNewSharedPoint(freeze(linked), 'a', 0).paths[0].waypoints[0].positionName).toBe(expected);
  });

  it('reuses a released name rather than keeping a counter', () => {
    const first = PathLinks.nameNewSharedPoint(merged(), 'a', 0);
    const released = structuredClone(first); delete released.paths[0].waypoints[0].positionName;
    expect(PathLinks.nameNewSharedPoint(freeze(released), 'a', 0).paths[0].waypoints[0].positionName).toBe('Shared point 1');
  });

  it('returns the input unchanged without a merged group or valid owner', () => {
    const before = freeze(project([path('a', [point(0)])]));
    expect(PathLinks.nameNewSharedPoint(before, 'a', 0)).toBe(before);
    expect(PathLinks.nameNewSharedPoint(before, 'missing', 0)).toBe(before);
    expect(PathLinks.nameNewSharedPoint(before, 'a', 4)).toBe(before);
  });
});

const geometry = (waypoint) => ({ stop: waypoint.stop, theta: waypoint.theta, thetaOn: waypoint.thetaOn, linked: waypoint.linked,
  prev: [waypoint.prevC.x - waypoint.x, waypoint.prevC.y - waypoint.y], next: [waypoint.nextC.x - waypoint.x, waypoint.nextC.y - waypoint.y] });
const localPoint = (x, y, seed, extra = {}) => point(x, y, { stop: seed % 2 === 0, theta: seed * 30, thetaOn: seed % 2 !== 0, linked: false,
  prevC: { x: x - seed - 1, y: y - 2 }, nextC: { x: x + 1, y: y + seed + 1 }, ...extra });
function historyFixture() {
  return project([
    path('a', [localPoint(0, 0, 1), localPoint(1, 2, 2, { positionLink: 'source' })]),
    path('b', [localPoint(8, 12, 3), localPoint(10, 20, 4, { positionLink: 'target' })]),
    path('c', [localPoint(10, 20, 5), localPoint(15, 20, 6)]),
  ], { pathLinks: [{ id: 'bc', fromPathId: 'b', toPathId: 'c' }] });
}
function journal(initial) {
  const history = createUndoHistory(); let current = initial;
  const apply = (entry) => {
    const next = restoreProjectChange(current, entry.change);
    const inverse = { ...entry, ...captureProjectChange(current, next, 'a') }; current = next; return inverse;
  };
  return { history, get project() { return current; },
    change(next, id) { history.record({ scope: pathScope(id), kind: 'waypoints', ...captureProjectChange(current, next, id) }); current = next; },
    undo: (id) => history.undo([pathScope(id)], apply), redo: (id) => history.redo([pathScope(id)], apply) };
}

describe('link and name as one captured project change', () => {
  it('uses the target position/group and restores link, name, stop, heading and local tangents in one Undo/Redo', () => {
    const before = freeze(historyFixture()), snapshot = structuredClone(before), session = journal(before);
    const linked = PathLinks.linkPosition(before, 'a', 1, 'b', 1, 'unused');
    const next = PathLinks.nameNewSharedPoint(linked, 'a', 1);
    session.change(next, 'a');
    expect(session.history.size).toEqual({ past: 1, future: 0 });
    expect(new Set(session.history.peekUndo([pathScope('a')]).touches)).toEqual(new Set(['path:a', 'path:b', 'path:c']));
    for (const [pi, wi] of [[0, 1], [1, 1], [2, 0]]) expect(next.paths[pi].waypoints[wi]).toMatchObject({ x: 10, y: 20, positionLink: 'target' });
    expect(next.paths[0].waypoints[1].positionName).toBe('Shared point 1');
    expect(next.paths[1].waypoints[1].positionName).toBeUndefined(); expect(next.paths[2].waypoints[0].positionName).toBeUndefined();
    expect(next.paths.map((item) => item.waypoints.map(geometry))).toEqual(before.paths.map((item) => item.waypoints.map(geometry)));
    expect(before).toEqual(snapshot);
    expect(session.undo('a')).toBe(true); expect(session.project).toEqual(before);
    expect(session.history.size).toEqual({ past: 0, future: 1 }); expect(session.undo('a')).toBe(false);
    expect(session.redo('a')).toBe(true); expect(session.project).toEqual(next);
    expect(session.project.paths.map((item) => item.waypoints.map(geometry))).toEqual(before.paths.map((item) => item.waypoints.map(geometry)));
    expect(session.history.size).toEqual({ past: 1, future: 0 }); expect(session.redo('a')).toBe(false);
  });

  it('does not let the one group entry jump over a newer edit to its endpoint-connected neighbor', () => {
    const before = freeze(historyFixture()), session = journal(before);
    const next = PathLinks.nameNewSharedPoint(PathLinks.linkPosition(before, 'a', 1, 'b', 1, 'unused'), 'a', 1);
    session.change(next, 'a');
    const paths = next.paths.slice(), neighbor = paths[2];
    paths[2] = { ...neighbor, waypoints: neighbor.waypoints.map((waypoint, index) => index === 0 ? { ...waypoint, theta: 179 } : waypoint) };
    const newer = { ...next, paths }; session.change(newer, 'c');
    expect(session.history.canUndo([pathScope('a')])).toBe(false); expect(session.undo('a')).toBe(false); expect(session.project).toBe(newer);
    expect(session.undo('c')).toBe(true); expect(session.project).toEqual(next);
    expect(session.undo('a')).toBe(true); expect(session.project).toEqual(before);
    expect(session.redo('a')).toBe(true); expect(session.redo('c')).toBe(true); expect(session.project).toEqual(newer);
  });
});
