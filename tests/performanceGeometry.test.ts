import { afterEach, describe, expect, it, vi } from 'vitest';
import * as geometry from '../src/core/agent/robotFootprint';
import { measureRobotFieldClearance, observeRobotFieldPortalSequence } from '../src/core/agent/fieldClearance';
import { REBUILT_2026_FIELD, officialToAppPoint } from '../src/core/field/rebuilt2026';
import { FIELD_H, FIELD_W } from '../src/core/math/fieldBounds';
import { createDemoProject } from '../src/core/project/defaults';
import type { ControlPoint, TrajectorySample } from '../src/core/types';

// Exhaustive SAT/edge-distance oracle, deliberately independent of pruning.
function exhaustiveClearance(first: ControlPoint[], second: ControlPoint[]): number {
  let overlap = Infinity;
  let separated = false;
  for (const polygon of [first, second]) for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i], q = polygon[(i + 1) % polygon.length];
    const length = Math.hypot(q.x - p.x, q.y - p.y);
    if (length <= 1e-9) continue;
    const ax = -(q.y - p.y) / length, ay = (q.x - p.x) / length;
    const a = first.map(p => p.x * ax + p.y * ay), b = second.map(p => p.x * ax + p.y * ay);
    const amount = Math.min(Math.max(...a), Math.max(...b)) - Math.max(Math.min(...a), Math.min(...b));
    if (amount < -1e-9) separated = true;
    else overlap = Math.min(overlap, Math.max(0, amount));
  }
  if (!separated) return -overlap;
  let distance = Infinity;
  for (const [points, edges] of [[first, second], [second, first]]) for (const p of points) for (let i = 0; i < edges.length; i++) {
    const a = edges[i], b = edges[(i + 1) % edges.length];
    const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
    const t = length <= 1e-9 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length));
    distance = Math.min(distance, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
  }
  return distance;
}

function exhaustiveSample(robot: ReturnType<typeof createDemoProject>['robot'], sample: TrajectorySample): number {
  const footprint = geometry.robotFootprintAt(robot, sample);
  const bounds = geometry.polygonBounds(footprint);
  let minimum = geometry.footprintBoundsClearance(footprint, FIELD_W, FIELD_H);
  for (const obstacle of REBUILT_2026_FIELD.solidObstacles) {
    if (!obstacle.bounds) continue;
    const a = officialToAppPoint({ x: obstacle.bounds.xMin, y: obstacle.bounds.yMin });
    const b = officialToAppPoint({ x: obstacle.bounds.xMax, y: obstacle.bounds.yMax });
    minimum = Math.min(minimum, exhaustiveClearance(footprint, geometry.boundsPolygon({
      min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) },
    })));
  }
  for (const barrier of REBUILT_2026_FIELD.crossingBarriers) {
    const x = officialToAppPoint({ x: barrier.x, y: 0 }).x;
    const section = geometry.verticalLineSection(footprint, x);
    const occupied = section ?? { minY: bounds.min.y, maxY: bounds.max.y };
    const lateral = Math.max(...barrier.portals.map(({ bounds }) =>
      Math.min(occupied.minY - bounds.yMin, bounds.yMax - occupied.maxY)));
    if (section) minimum = Math.min(minimum, lateral);
    else if (lateral < 0) minimum = Math.min(minimum, Math.max(bounds.min.x - x, x - bounds.max.x, 0));
  }
  return Number.isFinite(minimum) ? minimum : 0;
}

function samples(count: number): TrajectorySample[] {
  return Array.from({ length: count }, (_, i) => ({ i, x: -8.6 + ((i * 17) % 173) / 10,
    y: -4.1 + ((i * 13) % 83) / 10, headingRad: i * 0.17, t: i * 0.02, s: i * 0.1,
    f: i / count, velocityMps: 1, accelerationMps2: 0, angularVelocityRadps: 0, curvatureInvM: 0 }));
}

afterEach(() => vi.restoreAllMocks());
describe('field geometry performance and equivalence', () => {
  it('matches exhaustive signed clearance for rotated rectangles and convex custom footprints throughout the field', () => {
    const robot = createDemoProject().robot;
    for (const custom of [false, true]) {
      if (custom) robot.footprint = { kind: 'polygon', verticesM: [{ x: -0.4, y: -0.3 }, { x: 0.4, y: -0.2 }, { x: 0.4, y: 0.2 }, { x: -0.4, y: 0.3 }] };
      for (const sample of samples(500)) expect(measureRobotFieldClearance(robot, [sample]).minimum).toBeCloseTo(exhaustiveSample(robot, sample), 12);
    }
    expect(measureRobotFieldClearance(robot, [])).toEqual({ minimum: 0, closestSampleIndex: 0 });
  });

  it('does not run exact polygon distance for obstacles farther away than the field edge', () => {
    const robot = createDemoProject().robot;
    const far = samples(256).map(s => ({ ...s, x: 7.77, y: 3.0345, headingRad: 0 }));
    const spy = vi.spyOn(geometry, 'convexPolygonClearance');
    const result = measureRobotFieldClearance(robot, far);
    expect(result.minimum).toBeCloseTo(exhaustiveSample(robot, far[0]), 12);
    expect(result.closestSampleIndex).toBe(0);
    expect(spy.mock.calls.length).toBe(0);
  });

  it('transforms each sampled footprint once when checking multiple barriers', () => {
    const input = samples(256).map(s => ({ ...s, x: 7.77, y: 3.0345 }));
    const spy = vi.spyOn(geometry, 'transformFootprint');
    expect(observeRobotFieldPortalSequence(createDemoProject().robot, input)).toEqual({ valid: true, visits: [] });
    expect(spy.mock.calls.length).toBeLessThanOrEqual(input.length + REBUILT_2026_FIELD.crossingBarriers.length * 2);
  });

});
