import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PM, deriveHeadingGeometry } from '../src/core/math/pm';
import { headingAt, buildAnchors } from '../src/core/math/headingAnchors';
import { buildWaypoints, defaultPathConstraints, createDemoProject } from '../src/core/project/defaults';
import { getPlanner } from '../src/core/planners';
import { buildBdxExport } from '../src/core/export/bdx';
import { buildRobotBinary } from '../src/core/export/robotBinary';
import { bdxBindingsFromCatalog } from '../src/electron/bdxBindings';
import { forceExportRobot } from './fixtures/forceExportRobot';
import { validateProjectSource } from '../src/core/validation';
import { decodeProjectFile, encodeProjectFile } from '../src/core/project/fileFormat';
import { reversePath } from '../src/renderer/lib/pathEditing';
// @ts-expect-error Renderer JavaScript API shares the actual heading interpolation.
import { editingGeometry, liveEditingPreview, projectEditingTiming } from '../src/renderer/assets/editing-planning';
// @ts-expect-error Renderer JavaScript API.
import { PM as rendererPM } from '../src/renderer/lib/pathMath';
import type { RotationDirection } from '../src/core/types';

const radians = (degrees: number) => degrees * Math.PI / 180;
function fullTurnProject(direction: RotationDirection) {
  const project = createDemoProject(), path = project.paths[0];
  path.headingMode = 'targets';
  path.waypoints = buildWaypoints([{ x: 2, y: 4, theta: 0, segType: 'line' }, { x: 5, y: 4, theta: 0 }]);
  path.waypoints[1].rotationDirection = direction;
  path.targets = [{ f: 0.5, deg: 180, rotationDirection: direction }];
  return project;
}

describe('moving rotation direction', () => {
  it.each(['cw', 'ccw'] as const)('continues %s through an intermediate half-turn in planning, editing and export', (direction) => {
    const project = fullTurnProject(direction), path = project.paths[0], sign = direction === 'cw' ? -1 : 1;
    const result = getPlanner('profiledSpline').generate({ path, robot: project.robot, samplesPerSegment: 56 });
    expect(result.diagnostics.filter(issue => issue.severity === 'error')).toEqual([]);
    expect(result.samples.at(-1)!.headingRad - result.samples[0].headingRad).toBeCloseTo(sign * 2 * Math.PI, 5);
    expect(result.samples.every((sample, index) => !index || sign * (sample.headingRad - result.samples[index - 1].headingRad) >= -1e-8)).toBe(true);
    const pending = editingGeometry(path, 14, project.robot);
    expect(headingAt(1, pending.anchors) - headingAt(0, pending.anchors)).toBeCloseTo(sign * 2 * Math.PI, 8);
    const exported = buildBdxExport(project).paths[0];
    expect(exported.samples.at(-1)!.headingRad - exported.samples[0].headingRad).toBeCloseTo(sign * 2 * Math.PI, 5);
  });

  it.each(['cw', 'ccw'] as const)('keeps the full %s turn in actual BDX binary samples', (direction) => {
    const project = fullTurnProject(direction), path = project.paths[0];
    project.robot = forceExportRobot();
    const built = buildRobotBinary(project, { kind: 'path', id: path.id }, bdxBindingsFromCatalog(null));
    const bytes = Buffer.from(built.bytes), sampleCountOffset = 36 + bytes.readUInt32BE(32);
    const count = bytes.readUInt32BE(sampleCountOffset), samplesOffset = sampleCountOffset + 4;
    expect(bytes.readUInt16BE(10)).toBe(1);
    const heading = (index: number) => bytes.readDoubleBE(samplesOffset + index * 15 * 8 + 5 * 8);
    expect(heading(count - 1) - heading(0)).toBeCloseTo((direction === 'cw' ? -1 : 1) * 2 * Math.PI, 5);
  });

  it('preserves the existing shortest-turn default', () => {
    const anchors = buildAnchors([{ f: 0, rad: 0 }, { f: 0.5, rad: Math.PI }, { f: 1, rad: 0 }]);
    expect(headingAt(0.5, anchors)).toBeCloseTo(Math.PI, 8);
    expect(headingAt(1, anchors)).toBeCloseTo(0, 8);
  });

  it.each(['cw', 'ccw'] as const)('uses %s for a complete turn between matching headings', (direction) => {
    const anchors = buildAnchors([{ f: 0, rad: radians(450) }, { f: 1, rad: radians(90), rotationDirection: direction }]);
    expect(headingAt(1, anchors) - headingAt(0, anchors)).toBeCloseTo((direction === 'cw' ? -1 : 1) * 2 * Math.PI, 8);
  });

  it('does not reverse explicitly directed turns with uneven target spacing', () => {
    const anchors = buildAnchors([{ f: 0, rad: 0 }, { f: 0.05, rad: radians(170), rotationDirection: 'ccw' },
      { f: 0.9, rad: radians(190), rotationDirection: 'ccw' }, { f: 1, rad: 0, rotationDirection: 'ccw' }]);
    let previous = headingAt(0, anchors);
    for (let i = 1; i <= 1000; i++) {
      const next = headingAt(i / 1000, anchors);
      expect(next).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = next;
    }
  });

  it('holds the final heading after a directed target when coverage is extended', () => {
    const anchors = buildAnchors([{ f: 0, rad: 0 }, { f: 0.5, rad: 0, rotationDirection: 'ccw' }]);
    expect(headingAt(0.75, anchors)).toBeCloseTo(2 * Math.PI, 8);
  });

  it('retains direction on save/reopen and rejects invalid direction values', () => {
    const project = fullTurnProject('ccw');
    const restored = decodeProjectFile(encodeProjectFile(project).contents).project;
    expect(restored.paths[0].targets[0].rotationDirection).toBe('ccw');
    expect(restored.paths[0].waypoints[1].rotationDirection).toBe('ccw');
    const invalid = JSON.parse(JSON.stringify(project));
    invalid.paths[0].targets[0].rotationDirection = 'sideways';
    invalid.paths[0].waypoints[1].rotationDirection = 'sideways';
    expect(validateProjectSource(invalid).issues.filter(issue => issue.path.endsWith('rotationDirection'))).toHaveLength(2);
  });

  it('transfers incoming direction to the preceding anchor when swapping start/end', () => {
    const project = fullTurnProject('ccw'), path = project.paths[0];
    reversePath(path);
    rendererPM.reversePathAnchors(path, 3);
    expect(path.targets[0].rotationDirection).toBe('cw');
    expect(path.waypoints[1].rotationDirection).toBe('cw');
    const result = getPlanner('profiledSpline').generate({ path, robot: project.robot, samplesPerSegment: 56 });
    expect(result.samples.at(-1)!.headingRad - result.samples[0].headingRad).toBeCloseTo(-2 * Math.PI, 5);
  });

  it.each(['manual', 'targets'] as const)('keeps a complete directed turn when entering %s from tangent', (mode) => {
    const project = fullTurnProject('ccw'), path = project.paths[0];
    path.waypoints = buildWaypoints([{ x: 2, y: 4, theta: 0, segType: 'line' },
      { x: 3.5, y: 4, theta: 0, segType: 'line' }, { x: 5, y: 4, theta: 0 }]);
    path.waypoints[0].segmentHeadingMode = 'tangent';
    path.waypoints[1].segmentHeadingMode = mode;
    path.waypoints[2].rotationDirection = 'ccw';
    path.targets = [];
    const result = getPlanner('profiledSpline').generate({ path, robot: project.robot, samplesPerSegment: 56 });
    expect(result.diagnostics.filter(issue => issue.severity === 'error')).toEqual([]);
    expect(result.samples.at(-1)!.headingRad - result.samples[0].headingRad).toBeCloseTo(2 * Math.PI, 5);
    reversePath(path);
    rendererPM.reversePathAnchors(path, 3);
    const reversed = getPlanner('profiledSpline').generate({ path, robot: project.robot, samplesPerSegment: 56 });
    expect(reversed.samples[reversed.waypointSampleIndices![1]].headingRad - reversed.samples[0].headingRad).toBeCloseTo(-2 * Math.PI, 5);
  });

  it.each([0.01, 0.001])('preserves a full turn between targets only %s of the path apart', (gap) => {
    const project = fullTurnProject('ccw'), path = project.paths[0];
    delete path.waypoints[1].rotationDirection;
    path.targets = [{ f: 0.5, deg: 0 }, { f: 0.5 + gap, deg: 0, rotationDirection: 'ccw' }];
    const derived = PM.derivePath(path, project.robot, 56);
    expect(derived.metrics.head.at(-1)! - derived.metrics.head[0]).toBeCloseTo(2 * Math.PI, 8);
    const pending = editingGeometry(path, 14, project.robot);
    expect(headingAt(1, pending.anchors) - headingAt(0, pending.anchors)).toBeCloseTo(2 * Math.PI, 8);
    const result = getPlanner('profiledSpline').generate({ path, robot: project.robot, samplesPerSegment: 56 });
    expect(result.samples.at(-1)!.headingRad - result.samples[0].headingRad).toBeCloseTo(2 * Math.PI, 5);
    expect(result.samples.every((s, i) => !i || Math.abs(s.headingRad - result.samples[i - 1].headingRad) < Math.PI)).toBe(true);
  });

  it('keeps zero-distance directed drafts editable and rejects them for planning', () => {
    const project = fullTurnProject('ccw'), path = project.paths[0];
    path.targets = [{ f: 0.5, deg: 0 }, { f: 0.5, deg: 0, rotationDirection: 'ccw' }];
    expect(() => editingGeometry(path, 14, project.robot)).not.toThrow();
    expect(() => getPlanner('profiledSpline').generate({ path, robot: project.robot })).toThrow(/distance between heading anchors/);
  });

  it('preserves directed pending headings beyond the base geometry sample budget', () => {
    const project = fullTurnProject('ccw'), path = project.paths[0];
    delete path.waypoints[1].rotationDirection;
    path.targets = Array.from({ length: 260 }, (_, i) => ({ f: (i + 1) / 261, deg: 0, rotationDirection: 'ccw' }));
    const pending = editingGeometry(path, 14, project.robot);
    expect(pending.sample.pts.length).toBeGreaterThan(2000);
    expect(headingAt(1, pending.anchors)).toBeCloseTo(260 * 2 * Math.PI, 7);
  });

  it.each(['manual', 'targets', 'lookAt'] as const)('reverses a mixed-law turn from its actual %s heading when theta is disabled', (incomingMode) => {
    const project = fullTurnProject('ccw'), path = project.paths[0];
    path.waypoints = buildWaypoints([{ x: 2, y: 4, theta: 90, segType: 'line', segmentHeadingMode: incomingMode, segmentLookAt: { x: 3.5, y: 7 } },
      { x: 3.5, y: 4, theta: 0, segType: 'line', segmentHeadingMode: incomingMode === 'targets' ? 'manual' : 'targets', thetaOn: false },
      { x: 5, y: 4, theta: 90, rotationDirection: 'ccw' }]);
    path.targets = [];
    const forward = PM.derivePath(path, project.robot, 56);
    const arrival = forward.metrics.head[forward.wpIdx[1]];
    reversePath(path);
    const reversed = PM.derivePath(path, project.robot, 56);
    expect(radians(path.waypoints[1].theta)).toBeCloseTo(arrival, 8);
    expect(reversed.metrics.head[reversed.wpIdx[1]] - reversed.metrics.head[0])
      .toBeCloseTo(arrival - forward.metrics.head.at(-1)!, 8);
    const result = getPlanner('profiledSpline').generate({ path, robot: project.robot, samplesPerSegment: 56 });
    expect(result.diagnostics.filter(issue => issue.severity === 'error')).toEqual([]);
    if (incomingMode !== 'lookAt') expect(result.samples.at(-1)!.headingRad - result.samples[0].headingRad).toBeCloseTo(-2 * Math.PI, 5);
  });

  it('retains all off-grid anchors before a directed pending turn', () => {
    const project = fullTurnProject('ccw'), path = project.paths[0];
    delete path.waypoints[1].rotationDirection;
    path.targets = [{ f: 0.501, deg: 0 }, { f: 0.511, deg: 180 }, { f: 0.521, deg: 180, rotationDirection: 'ccw' }];
    const pending = editingGeometry(path, 14, project.robot);
    const final = getPlanner('profiledSpline').generate({ path, robot: project.robot, samplesPerSegment: 56 });
    expect(headingAt(1, pending.anchors) - headingAt(0, pending.anchors))
      .toBeCloseTo(final.samples.at(-1)!.headingRad - final.samples[0].headingRad, 8);
    expect(headingAt(0.511, pending.anchors)).toBeCloseTo(Math.PI, 8);
  });

  it.each([14, 56, 224])('preserves actual reversed angular travel at %s samples per segment', (density) => {
    const project = fullTurnProject('ccw'), path = project.paths[0];
    path.waypoints = buildWaypoints([{ x: 2, y: 4, theta: 90, segType: 'line', segmentHeadingMode: 'manual' },
      { x: 3.5, y: 4, theta: 0, segType: 'line', segmentHeadingMode: 'targets', thetaOn: false },
      { x: 5, y: 4, theta: 90, rotationDirection: 'ccw' }]);
    path.targets = [];
    const forward = deriveHeadingGeometry(path, project.robot, density);
    reversePath(path);
    const reversed = deriveHeadingGeometry(path, project.robot, density);
    expect(reversed.head[reversed.wpIdx[1]] - reversed.head[0])
      .toBeCloseTo(forward.head[forward.wpIdx[1]] - forward.head.at(-1)!, 8);
    expect(radians(path.waypoints[1].theta)).toBeCloseTo(3 * Math.PI / 2, 8);
  });

  it('tolerates a missing optional target list in ordinary shortest planning', () => {
    const project = fullTurnProject('shortest'), path = project.paths[0];
    delete (path as Partial<typeof path>).targets;
    expect(() => PM.derivePath(path, project.robot, 56)).not.toThrow();
  });

  it.each([{}, [{ f: 0.5, deg: 0, anchor: 'dist', d: NaN, rotationDirection: 'ccw' }]])
    ('keeps malformed target drafts finite and editable: %j', (targets) => {
      const project = fullTurnProject('shortest'), path = project.paths[0];
      const pending = editingGeometry({ ...path, targets }, 14, project.robot);
      expect(pending.sample.pts.every((p: { x: number; y: number; s: number }) => [p.x, p.y, p.s].every(Number.isFinite))).toBe(true);
      expect(pending.metrics.head.every(Number.isFinite)).toBe(true);
      expect(pending.wpIdx).toHaveLength(path.waypoints.length);
    });

  it('returns drawable pending geometry with a diagnostic when directed sampling exceeds its budget', () => {
    const project = fullTurnProject('shortest'), path = project.paths[0];
    path.targets = Array.from({ length: 31_251 }, (_, i) => ({ f: (i + 1) / 31_252, deg: 0, rotationDirection: 'ccw' }));
    const pending = editingGeometry(path, 14, project.robot);
    expect(pending.sample.pts.length).toBeLessThanOrEqual(250_000);
    expect(pending.wpIdx).toHaveLength(path.waypoints.length);
    expect(pending.checks.some((check: { text: string }) => /sample limit/.test(check.text))).toBe(true);
  });

  it.each(['manual', 'tangent'] as const)('ignores coincident directed targets under an inactive targets law (%s)', (mode) => {
    const project = fullTurnProject('shortest'), path = project.paths[0];
    path.headingMode = mode;
    path.targets = [{ f: 0.5, deg: 0 }, { f: 0.5, deg: 0, rotationDirection: 'ccw' }];
    const result = getPlanner('profiledSpline').generate({ path, robot: project.robot, samplesPerSegment: 56 });
    expect(result.diagnostics.filter(issue => issue.severity === 'error')).toEqual([]);
    expect(result.samples.at(-1)!.headingRad - result.samples[0].headingRad).toBeCloseTo(0, 8);
  });

  it('rejects a directed span too close for fraction interpolation to resolve', () => {
    const project = fullTurnProject('shortest'), path = project.paths[0];
    path.waypoints[1].x = 15;
    path.targets = [{ f: 0.501, deg: 0 }, { f: 0.501 + 9e-10, deg: 0, rotationDirection: 'ccw' }];
    expect(() => getPlanner('profiledSpline').generate({ path, robot: project.robot, samplesPerSegment: 56 })).toThrow(/distance between heading anchors/);
    const geometry = editingGeometry(path, 14, project.robot);
    expect(geometry.checks[0].level).toBe('error');
    expect(projectEditingTiming(geometry, null).checks).toEqual(geometry.checks);
    expect(liveEditingPreview(path, project.robot, null, null).checks).toEqual(geometry.checks);
  });
});

describe('constant-rate rotation timing', () => {
  it('removes the middle valley when replaying the attached test2 geometry and heading samples', () => {
    const samples: number[][] = JSON.parse(readFileSync(new URL('./fixtures/test2RotationSamples.json', import.meta.url), 'utf8'));
    const points = samples.map(([s, , curv]) => ({ s, curv }));
    const heading = samples.map(([, heading]) => heading);
    const constraints = { ...defaultPathConstraints(createDemoProject().robot), maxVel: 3.048, maxAccel: 6.367,
      maxDecel: 6.367, maxAngVel: 605, maxAngAccel: 720, maxAngDecel: 720 };
    const result = PM.profile(points, constraints, 0, 0, { heading });
    const middle = result.v.filter((_, index) => points[index].s / points.at(-1)!.s > 0.45 && points[index].s / points.at(-1)!.s < 0.6);
    expect(Math.min(...middle)).toBeGreaterThan(Math.max(...result.v) * 0.9);
    expect(result.totalTime).toBeLessThan(2.942681);
  });

  it('does not manufacture a middle speed valley, while respecting angular acceleration', () => {
    // Distance and full-turn scale of the attached test2 BDX; no hidden stops or zones.
    const count = 57, length = 2.444593269552134;
    const points = Array.from({ length: count }, (_, i) => ({ s: length * i / (count - 1), curv: 0 }));
    const heading = points.map(point => radians(450) - 2 * Math.PI * point.s / length);
    const constraints = { ...defaultPathConstraints(createDemoProject().robot), maxVel: 3.048, maxAccel: 6.367,
      maxDecel: 6.367, maxAngVel: 605, maxAngAccel: 720, maxAngDecel: 720 };
    const profile = PM.profile(points, constraints, 0, 0, { heading });
    expect(Math.min(...profile.v.slice(20, 38))).toBeGreaterThan(Math.max(...profile.v) * 0.9);
    const omega = points.slice(1).map((_, i) => (heading[i + 1] - heading[i]) / (profile.t[i + 1] - profile.t[i]));
    for (let i = 1; i < omega.length; i++) {
      const dt = (profile.t[i + 1] - profile.t[i - 1]) / 2;
      expect(Math.abs(omega[i] - omega[i - 1]) / dt).toBeLessThanOrEqual(radians(720));
    }
    expect(profile.totalTime).toBeLessThan(2);
  });
});
