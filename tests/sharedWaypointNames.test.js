import { describe, expect, it } from 'vitest';
import { createDemoProject } from '../src/core/project/defaults';
import { normalizeProject } from '../src/core/project/normalize';
import { validateProject } from '../src/core/validation';
import { sharedPositionChoices } from '../src/renderer/components/SharedWaypointPosition';
import { PathLinks } from '../src/renderer/lib/pathLinks';
import { duplicateWaypoint, reversePath } from '../src/renderer/lib/pathEditing';

function fixture() {
  const project = createDemoProject();
  project.paths = ['a', 'b'].map((id) => ({ ...structuredClone(project.paths[0]), id, name: id }));
  project.pathLinks = [];
  return project;
}

describe('named linkable waypoint positions', () => {
  it('preserves a name and its shared position through save/load without naming every occurrence', () => {
    const project = fixture();
    project.paths[0].waypoints[0].positionName = 'Pickup station';
    const linked = PathLinks.linkPosition(project, 'b', 0, 'a', 0, 'pickup');
    const restored = PathLinks.reconcile(normalizeProject(JSON.parse(JSON.stringify(linked))));
    expect(restored.paths[0].waypoints[0]).toMatchObject({ positionName: 'Pickup station', positionLink: 'pickup' });
    expect(restored.paths[1].waypoints[0].positionName).toBeUndefined();
    expect(restored.paths[1].waypoints[0].positionLink).toBe('pickup');
    expect(sharedPositionChoices(restored, 'a', 0).members[0]).toMatchObject({ label: 'Pickup station', meta: 'b / Start' });
    expect(validateProject(restored).issues.filter((issue) => issue.path.endsWith('.positionName'))).toEqual([]);
  });

  it.each(['', '  ', null, 12, 'x'.repeat(81)])('rejects invalid linkable names %j', (name) => {
    const project = fixture();
    project.paths[0].waypoints[0].positionName = name;
    expect(validateProject(project).issues.some((issue) => issue.path.endsWith('.positionName'))).toBe(true);
  });

  it('accepts unnamed points and the 80-character boundary', () => {
    const project = fixture();
    expect(validateProject(project).issues.filter((issue) => issue.path.endsWith('.positionName'))).toEqual([]);
    project.paths[0].waypoints[0].positionName = 'x'.repeat(80);
    expect(validateProject(project).issues.filter((issue) => issue.path.endsWith('.positionName'))).toEqual([]);
  });

  it('offers only named points, with path context, excluding self and existing linked members', () => {
    const project = fixture();
    project.paths[0].waypoints[0].positionName = 'Current point';
    project.paths[1].waypoints[0].positionName = 'Pickup';
    expect(sharedPositionChoices(project, 'a', 0).candidates).toEqual([
      expect.objectContaining({ label: 'Pickup', meta: 'b / Start', pathId: 'b', index: 0 }),
    ]);
    const linked = PathLinks.linkPosition(project, 'a', 0, 'b', 0, 'pickup');
    expect(sharedPositionChoices(linked, 'a', 0).candidates).toEqual([]);
    expect(sharedPositionChoices(linked, 'a', 0).members).toHaveLength(1);
  });

  it('lists a named position once even when several named occurrences share it', () => {
    let project = fixture();
    project.paths[0].waypoints[0].positionName = 'Pickup';
    project.paths[1].waypoints[0].positionName = 'Pickup alias';
    project = PathLinks.linkPosition(project, 'a', 0, 'b', 0, 'pickup');
    expect(sharedPositionChoices(project, 'a', project.paths[0].waypoints.length - 1).candidates).toHaveLength(1);
  });

  it('hides an unmarked named point without disconnecting existing position links', () => {
    let project = fixture();
    project.paths[0].waypoints[0].positionName = 'Pickup';
    project = PathLinks.linkPosition(project, 'b', 0, 'a', 0, 'pickup');
    const before = structuredClone(project.paths[0]);
    delete project.paths[0].waypoints[0].positionName;
    project = PathLinks.sync(project, 'a', before);
    expect(sharedPositionChoices(project, 'a', project.paths[0].waypoints.length - 1).candidates).toEqual([]);
    expect(PathLinks.positionMembers(project, 'a', 0)).toEqual([{ pathId: 'b', index: 0 }]);
    const beforeMove = structuredClone(project.paths[0]);
    project.paths[0].waypoints[0].x += 0.1;
    project = PathLinks.sync(project, 'a', beforeMove);
    expect(project.paths[1].waypoints[0].x).toBe(project.paths[0].waypoints[0].x);
  });

  it('keeps a name on its point when reversing and does not copy it to a new offset duplicate', () => {
    const project = fixture(), path = project.paths[0];
    path.waypoints[0].positionName = 'Pickup station';
    path.waypoints[0].positionLink = 'pickup';
    reversePath(path);
    const index = path.waypoints.length - 1;
    expect(path.waypoints[index].positionName).toBe('Pickup station');
    duplicateWaypoint(path, index);
    expect(path.waypoints[index]).toMatchObject({ positionName: 'Pickup station', positionLink: 'pickup' });
    expect(path.waypoints[index + 1].positionName).toBeUndefined();
    expect(path.waypoints[index + 1].positionLink).toBeUndefined();
  });
});
