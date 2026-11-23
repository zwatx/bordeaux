import { describe, expect, it } from 'vitest';
import { PathLinks } from '../src/renderer/lib/pathLinks';
import { createDemoProject } from '../src/core/project/defaults';
import { normalizeProject } from '../src/core/project/normalize';
import { validateProject } from '../src/core/validation';

function fixture() {
  const project = createDemoProject();
  const template = project.paths[0];
  project.paths = ['a', 'b', 'c'].map((id, pi) => ({ ...structuredClone(template), id, name: id, waypoints: [0, 1, 2].map((wi) => {
    const x = 2 + pi * 3 + wi, y = 2 + pi;
    return { x, y, theta: pi * 45 + wi * 10, thetaOn: pi !== 1, linked: false, stop: true,
      prevC: { x: x - 0.2, y: y - 0.3 }, nextC: { x: x + 0.4, y: y + 0.1 } };
  }) }));
  project.pathLinks = [];
  return project;
}
const localGeometry = (point) => ({ theta: point.theta, thetaOn: point.thetaOn,
  prev: [point.prevC.x - point.x, point.prevC.y - point.y], next: [point.nextC.x - point.x, point.nextC.y - point.y] });
function expectLocal(actual, before) {
  expect(actual.theta).toBe(before.theta); expect(actual.thetaOn).toBe(before.thetaOn);
  const geometry = localGeometry(actual);
  geometry.prev.forEach((value, i) => expect(value).toBeCloseTo(before.prev[i], 10));
  geometry.next.forEach((value, i) => expect(value).toBeCloseTo(before.next[i], 10));
}
function move(project, pathIndex, waypointIndex, x, y) {
  const before = project.paths[pathIndex], paths = project.paths.slice();
  paths[pathIndex] = structuredClone(before);
  paths[pathIndex].waypoints[waypointIndex] = PathLinks.copyPose(before.waypoints[waypointIndex], { x, y });
  return PathLinks.sync({ ...project, paths }, before.id, before);
}

describe('shared waypoint positions', () => {
  it('links arbitrary occurrences and propagates edits while preserving each local heading and tangent', () => {
    const original = fixture();
    const sourceGeometry = localGeometry(original.paths[0].waypoints[1]);
    const targetGeometry = localGeometry(original.paths[1].waypoints[0]);
    let linked = PathLinks.linkPosition(original, 'a', 1, 'b', 0, 'position');
    expect(linked.paths[0].waypoints[1]).toMatchObject({ x: 5, y: 3, positionLink: 'position' });
    expectLocal(linked.paths[0].waypoints[1], sourceGeometry);
    expectLocal(linked.paths[1].waypoints[0], targetGeometry);
    expect(original.paths[0].waypoints[1]).not.toHaveProperty('positionLink');
    linked = PathLinks.linkPosition(linked, 'a', 2, 'a', 1, 'unused');
    const endGeometry = localGeometry(linked.paths[0].waypoints[2]);
    linked = move(linked, 0, 1, 6, 4);
    expect(linked.paths[0].waypoints[2]).toMatchObject({ x: 6, y: 4 });
    expect(linked.paths[1].waypoints[0]).toMatchObject({ x: 6, y: 4 });
    linked = move(linked, 0, 2, 7, 4);
    for (const [pi, wi, geometry] of [[0, 1, sourceGeometry], [0, 2, endGeometry], [1, 0, targetGeometry]]) {
      expect(linked.paths[pi].waypoints[wi]).toMatchObject({ x: 7, y: 4 });
      expectLocal(linked.paths[pi].waypoints[wi], geometry);
    }
    expect(PathLinks.positionMembers(linked, 'a', 1)).toEqual(expect.arrayContaining([{ pathId: 'a', index: 2 }, { pathId: 'b', index: 0 }]));
  });

  it('keeps heading and tangent-only edits local, including legacy-linked endpoints', () => {
    const original = fixture(); original.pathLinks = [{ id: 'old', fromPathId: 'a', toPathId: 'b' }];
    const project = PathLinks.linkPosition(original, 'a', 2, 'c', 1, 'position');
    const before = project.paths[0], paths = project.paths.slice(); paths[0] = structuredClone(before);
    paths[0].waypoints[2].theta = 157; paths[0].waypoints[2].thetaOn = false; paths[0].waypoints[2].prevC.y += 0.2;
    const edited = PathLinks.sync({ ...project, paths }, 'a', before);
    expect(edited.paths[1]).toEqual(project.paths[1]);
    expect(edited.paths[2]).toEqual(project.paths[2]);
    expect(edited.paths[0].waypoints[2]).toMatchObject({ theta: 157, thetaOn: false });
  });

  it('merges existing groups at the target position, including connected legacy endpoints', () => {
    let project = fixture();
    project = PathLinks.linkPosition(project, 'a', 0, 'b', 1, 'first');
    project = PathLinks.linkPosition(project, 'b', 2, 'c', 1, 'second');
    project.pathLinks = [{ id: 'old', fromPathId: 'a', toPathId: 'b' }];
    const linked = PathLinks.linkPosition(project, 'a', 2, 'c', 1, 'unused');
    expect(linked.paths[1].waypoints[0].positionLink).toBe('second');
    expect(linked.paths[0].waypoints[2]).toMatchObject({ x: 9, y: 4 });
    const merged = PathLinks.linkPosition(linked, 'a', 0, 'c', 1, 'unused');
    expect(merged.paths[1].waypoints[1].positionLink).toBe('second');
    expect(PathLinks.positionMembers(merged, 'a', 0)).toHaveLength(5);
  });

  it('reaches a fixed point through mixed position and endpoint cycles', () => {
    let project = fixture();
    project.pathLinks = [{ id: 'ab', fromPathId: 'a', toPathId: 'b' }, { id: 'bc', fromPathId: 'b', toPathId: 'c' }];
    project = PathLinks.linkPosition(project, 'b', 0, 'b', 2, 'middle');
    project = PathLinks.linkPosition(project, 'c', 0, 'a', 2, 'unused');
    const beforeHeadings = project.paths.map((path) => path.waypoints.map(localGeometry));
    const moved = move(project, 2, 0, 6, 5);
    for (const [pi, wi] of [[0, 2], [1, 0], [1, 2], [2, 0]]) {
      expect(moved.paths[pi].waypoints[wi]).toMatchObject({ x: 6, y: 5 });
      expectLocal(moved.paths[pi].waypoints[wi], beforeHeadings[pi][wi]);
    }
    expect(PathLinks.reconcile(moved)).toEqual(moved);
  });

  it('ignores numeric index shifts when inserting, deleting, reversing, or reordering waypoints', () => {
    let project = PathLinks.linkPosition(fixture(), 'a', 1, 'b', 1, 'position');
    project = PathLinks.linkPosition(project, 'a', 2, 'b', 1, 'unused');
    for (const edit of [
      (points) => points.unshift({ ...structuredClone(points[0]), x: 1 }),
      (points) => points.splice(0, 1),
      (points) => points.reverse(),
      (points) => points.splice(1, 0, points.pop()),
      (points) => points.splice(1, 1),
    ]) {
      const before = project.paths[0], paths = project.paths.slice(); paths[0] = structuredClone(before); edit(paths[0].waypoints);
      const synced = PathLinks.sync({ ...project, paths }, 'a', before);
      expect(synced.paths[1].waypoints[1]).toMatchObject({ x: 6, y: 3 });
    }
  });

  it('unlinks an occurrence completely without changing its position or other members', () => {
    let project = fixture();
    project.pathLinks = [{ id: 'old', fromPathId: 'a', toPathId: 'b' }];
    project = PathLinks.linkPosition(project, 'a', 2, 'c', 1, 'position');
    const before = structuredClone(project.paths[0].waypoints[2]);
    const unlinked = PathLinks.unlinkPosition(project, 'a', 2);
    expect(unlinked.pathLinks).toEqual([]);
    const { positionLink, ...local } = before;
    expect(unlinked.paths[0].waypoints[2]).toEqual(local);
    expect(unlinked.paths[0].waypoints[2]).toMatchObject({ x: before.x, y: before.y, theta: before.theta });
    expect(unlinked.paths[0].waypoints[2]).not.toHaveProperty('positionLink');
    const moved = move(unlinked, 0, 2, 3, 5);
    expect(moved.paths[1].waypoints[0]).toMatchObject({ x: before.x, y: before.y });
    expect(PathLinks.positionMembers(moved, 'a', 2)).toEqual([]);
  });

  it('preserves shared positions through save/load and reconciles inconsistent members without changing local geometry', () => {
    const project = PathLinks.linkPosition(fixture(), 'a', 1, 'b', 0, 'position');
    const restored = PathLinks.reconcile(normalizeProject(JSON.parse(JSON.stringify(project))));
    expect(restored).toMatchObject({ paths: project.paths });
    const malformed = structuredClone(restored), target = malformed.paths[1].waypoints[0];
    target.x += 1; target.prevC.x += 1; target.nextC.x += 1;
    const geometry = localGeometry(target);
    const reconciled = PathLinks.reconcile(malformed);
    expect(reconciled.paths[1].waypoints[0].x).toBe(project.paths[0].waypoints[1].x);
    expectLocal(reconciled.paths[1].waypoints[0], geometry);
  });

  it.each(['', '   ', 12, null])('rejects invalid shared position ID %j', (positionLink) => {
    const project = fixture(); project.paths[0].waypoints[0].positionLink = positionLink;
    expect(validateProject(project).issues.some((issue) => issue.path.endsWith('.positionLink'))).toBe(true);
  });
});
