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
  it('shares a continuous, high-contrast red palette between all field metrics and their legends', () => {
    const metrics = ['velocity', 'accel', 'angvel', 'curvature'];
    const reference = Array.from({ length: 101 }, (_, i) => metricColor('velocity', i / 100));
    const channels = reference.map(color => color.match(/oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/).slice(1).map(Number));
    for (let i = 1; i < channels.length; i++) {
      // Lightness rises and the hue warms from crimson toward coral, with no jumps.
      expect(channels[i][0]).toBeGreaterThan(channels[i - 1][0]);
      expect(channels[i][0] - channels[i - 1][0]).toBeLessThan(0.01);
      expect(channels[i][2]).toBeGreaterThan(channels[i - 1][2]);
    }
    // Slow and fast stretches read clearly apart on a thin line.
    expect(channels[100][0] - channels[0][0]).toBeGreaterThanOrEqual(0.22);
    // The slow end (every path's start and stop, and capped slow paths) stays above 3:1 on the dark path casing.
    expect(channels[0][0]).toBeGreaterThanOrEqual(0.5);
    // Every value stays a saturated red to coral, never fading toward white, alliance blue, or zone amber.
    for (const [lightness, chroma, hue] of channels) {
      expect(lightness).toBeLessThanOrEqual(0.8);
      expect(chroma).toBeGreaterThanOrEqual(0.13);
      expect(hue).toBeGreaterThanOrEqual(5);
      expect(hue).toBeLessThanOrEqual(40);
    }
    for (const metric of metrics) {
      expect(Array.from({ length: 101 }, (_, i) => metricColor(metric, i / 100))).toEqual(reference);
      expect(metricGradient(metric)).toBe(metricGradient('velocity'));
      for (const t of [0, 0.5, 1]) expect(metricGradient(metric)).toContain(`${metricColor(metric, t)} ${t * 100}%`);
      expect(metricColor(metric, -1)).toBe(reference[0]);
      expect(metricColor(metric, 2)).toBe(reference[100]);
    }
  });
});
