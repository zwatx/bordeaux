import { describe, it, expect } from 'vitest';
import { createDemoProject } from '../src/core/project/defaults';
import { PathLinks } from '../src/renderer/lib/pathLinks';
import { replaceEditedPath } from '../src/renderer/app/App';
import { metricColor, metricGradient } from '../src/core/math/metricDisplay';

describe('Mac editor linked waypoint identity', () => {
  it('names every occurrence after its named source and propagates edits in either direction', () => {
    let project = createDemoProject();
    const base = project.paths[0];
    project.paths = ['original', 'second', 'third'].map((id) => ({ ...structuredClone(base), id, name: id }));
    project.paths[0].waypoints[1].positionName = 'test';
    project = PathLinks.linkPosition(project, 'second', 0, 'original', 1, 'shared-test');
    project = PathLinks.linkPosition(project, 'third', 1, 'second', 0, 'unused');
    for (const [pi, wi] of [[0, 1], [1, 0], [2, 1]]) expect(PathLinks.waypointName(project, project.paths[pi], wi)).toBe('test');
    for (const [pi, wi, x, y] of [[1, 0, 5, 4], [0, 1, 6, 3], [2, 1, 4, 2]]) {
      const edited = structuredClone(project.paths[pi]);
      edited.waypoints[wi] = PathLinks.copyPose(edited.waypoints[wi], { x, y });
      project = replaceEditedPath(project, edited);
      for (const [memberPath, memberIndex] of [[0, 1], [1, 0], [2, 1]]) expect(project.paths[memberPath].waypoints[memberIndex]).toMatchObject({ x, y });
    }
    const renamed = structuredClone(project.paths[0]); renamed.waypoints[1].positionName = 'New name';
    project = replaceEditedPath(project, renamed);
    expect(PathLinks.waypointName(project, project.paths[1], 0)).toBe('New name');
  });
  it('falls back to endpoint names and uses a point’s explicit name first', () => {
    const project = createDemoProject(), path = project.paths[0];
    expect(PathLinks.waypointName(project, path, 0)).toBe('Start');
    expect(PathLinks.waypointName(project, path, path.waypoints.length - 1)).toBe('End');
    path.waypoints[0].positionName = 'Intake';
    expect(PathLinks.waypointName(project, path, 0)).toBe('Intake');
  });
});
describe('metric heatmap display', () => {
  it('shares a continuous, increasingly bright palette between all field metrics and their legends', () => {
    const metrics = ['velocity', 'accel', 'angvel', 'curvature'];
    const reference = Array.from({ length: 101 }, (_, i) => metricColor('velocity', i / 100));
    const lightness = reference.map(color => Number(color.match(/oklch\(([\d.]+)/)[1]));
    for (let i = 1; i < lightness.length; i++) {
      expect(lightness[i]).toBeGreaterThan(lightness[i - 1]);
      expect(lightness[i] - lightness[i - 1]).toBeLessThan(0.004);
    }
    expect(new Set(reference.map(color => color.match(/ ([\d.]+)\)$/)[1])).size).toBe(1);
    for (const metric of metrics) {
      expect(Array.from({ length: 101 }, (_, i) => metricColor(metric, i / 100))).toEqual(reference);
      expect(metricGradient(metric)).toBe(metricGradient('velocity'));
      for (const t of [0, 0.5, 1]) expect(metricGradient(metric)).toContain(`${metricColor(metric, t)} ${t * 100}%`);
      expect(metricColor(metric, -1)).toBe(reference[0]);
      expect(metricColor(metric, 2)).toBe(reference[100]);
    }
  });
});
