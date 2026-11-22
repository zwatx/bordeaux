import { REBUILT_2026_FIELD, REBUILT_2026_FIELD_WIDTH_M, officialToAppPoint } from "../field/rebuilt2026";
import { FIELD_H, FIELD_W } from "../math/fieldBounds";
import type { RobotConfig, TrajectorySample } from "../types";
import {
  boundsPolygon,
  convexPolygonClearance,
  footprintBoundsClearance,
  interpolateHeading,
  polygonBounds,
  robotFootprintVertices,
  transformFootprint,
  verticalLineSection,
} from "./robotFootprint";

const EPSILON = 1e-6;
const BARRIER_EPSILON = 1e-4;
const OBSTACLE_POLYGONS = REBUILT_2026_FIELD.solidObstacles.flatMap((item) => {
  if (!item.bounds) return [];
  const first = officialToAppPoint({ x: item.bounds.xMin, y: item.bounds.yMin });
  const second = officialToAppPoint({ x: item.bounds.xMax, y: item.bounds.yMax });
  return [boundsPolygon({
    min: { x: Math.min(first.x, second.x), y: Math.min(first.y, second.y) },
    max: { x: Math.max(first.x, second.x), y: Math.max(first.y, second.y) },
  })];
});
const OBSTACLE_BOUNDS = OBSTACLE_POLYGONS.map(polygonBounds);
const BARRIER_X = new Map(REBUILT_2026_FIELD.crossingBarriers.map((barrier) => (
  [barrier, officialToAppPoint({ x: barrier.x, y: 0 }).x] as const
)));
const PORTAL_BOUNDS = new Map(REBUILT_2026_FIELD.crossingBarriers.flatMap((barrier) => (
  barrier.portals.map((portal) => {
    const point = officialToAppPoint(portal.point);
    const halfWidth = portal.widthM * FIELD_H / REBUILT_2026_FIELD_WIDTH_M / 2;
    return [portal, { minY: point.y - halfWidth, maxY: point.y + halfWidth }] as const;
  })
)));

export interface RobotFieldClearanceMeasurement {
  minimum: number;
  closestSampleIndex: number;
}

export interface RobotFieldPortalVisit {
  id: string;
  sampleIndex: number;
}

export interface RobotFieldPortalSequence {
  valid: boolean;
  visits: RobotFieldPortalVisit[];
}

function crossingPose(previous: TrajectorySample, sample: TrajectorySample, x: number) {
  const ratio = Math.max(0, Math.min(1, (x - previous.x) / (sample.x - previous.x)));
  return {
    x,
    y: previous.y + (sample.y - previous.y) * ratio,
    headingRad: interpolateHeading(previous.headingRad, sample.headingRad, ratio),
  };
}

function portalsForSection(
  barrier: typeof REBUILT_2026_FIELD.crossingBarriers[number],
  section: { minY: number; maxY: number },
) {
  return barrier.portals.filter((portal) => {
    const bounds = PORTAL_BOUNDS.get(portal)!;
    return section.minY >= bounds.minY - EPSILON && section.maxY <= bounds.maxY + EPSILON;
  });
}

/** Returns the exact ordered typed-portal sequence occupied by the robot footprint. */
export function observeRobotFieldPortalSequence(
  robot: RobotConfig,
  samples: readonly TrajectorySample[],
): RobotFieldPortalSequence {
  if (samples.length === 0) return { valid: true, visits: [] };
  const localFootprint = robotFootprintVertices(robot);
  const visits: RobotFieldPortalVisit[] = [];
  let valid = true;
  const portalAt = (
    barrier: typeof REBUILT_2026_FIELD.crossingBarriers[number],
    pose: { x: number; y: number; headingRad: number },
    barrierX: number,
  ) => {
    const section = verticalLineSection(transformFootprint(localFootprint, pose), barrierX);
    if (!section) return undefined;
    const portals = portalsForSection(barrier, section);
    if (portals.length !== 1) valid = false;
    return portals.length === 1 ? portals[0] : undefined;
  };
  const add = (id: string | undefined, sampleIndex: number) => {
    const previous = visits.at(-1);
    if (!id || (previous?.id === id && sampleIndex - previous.sampleIndex <= 1)) return;
    visits.push({ id, sampleIndex });
  };

  for (const sample of samples) {
    const footprint = transformFootprint(localFootprint, sample);
    for (const barrier of REBUILT_2026_FIELD.crossingBarriers) {
      const barrierX = BARRIER_X.get(barrier)!;
      const section = verticalLineSection(footprint, barrierX);
      if (section && portalsForSection(barrier, section).length !== 1) valid = false;
    }
  }

  for (const barrier of REBUILT_2026_FIELD.crossingBarriers) {
    const barrierX = BARRIER_X.get(barrier)!;
    add(portalAt(barrier, samples[0], barrierX)?.id, 0);
  }
  const crossings: Array<{ id: string; sampleIndex: number; ratio: number }> = [];
  for (const barrier of REBUILT_2026_FIELD.crossingBarriers) {
    const barrierX = BARRIER_X.get(barrier)!;
    let previousIndex = -1;
    let previousSide = 0;
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      const side = Math.abs(sample.x - barrierX) <= BARRIER_EPSILON ? 0 : Math.sign(sample.x - barrierX);
      if (side === 0) continue;
      if (previousIndex >= 0 && previousSide !== side) {
        const previous = samples[previousIndex];
        const pose = crossingPose(previous, sample, barrierX);
        const portal = portalAt(barrier, pose, barrierX);
        if (portal) crossings.push({
          id: portal.id,
          sampleIndex: index,
          ratio: Math.abs((barrierX - previous.x) / (sample.x - previous.x)),
        });
      }
      previousIndex = index;
      previousSide = side;
    }
  }
  crossings
    .sort((left, right) => left.sampleIndex - right.sampleIndex || left.ratio - right.ratio)
    .forEach((crossing) => add(crossing.id, crossing.sampleIndex));
  for (const barrier of REBUILT_2026_FIELD.crossingBarriers) {
    const barrierX = BARRIER_X.get(barrier)!;
    const lastIndex = samples.length - 1;
    add(portalAt(barrier, samples[lastIndex], barrierX)?.id, lastIndex);
  }

  return { valid, visits };
}

/** Measures the swept robot footprint against field bounds, obstacles, and typed barrier portals. */
export function measureRobotFieldClearance(robot: RobotConfig, samples: readonly TrajectorySample[]): RobotFieldClearanceMeasurement {
  const localFootprint = robotFootprintVertices(robot);
  let minimum = Number.POSITIVE_INFINITY;
  let closestSampleClearance = Number.POSITIVE_INFINITY;
  let closestSampleIndex = 0;

  samples.forEach((sample, sampleIndex) => {
    const footprint = transformFootprint(localFootprint, sample);
    const footprintBounds = polygonBounds(footprint);
    let sampleMinimum = footprintBoundsClearance(footprint, FIELD_W, FIELD_H);
    for (let index = 0; index < OBSTACLE_POLYGONS.length; index += 1) {
      const bounds = OBSTACLE_BOUNDS[index];
      const gap = Math.max(bounds.min.x - footprintBounds.max.x, footprintBounds.min.x - bounds.max.x,
        bounds.min.y - footprintBounds.max.y, footprintBounds.min.y - bounds.max.y);
      // An axis-aligned gap is a lower bound on polygon distance. Only prune
      // strictly separated boxes; overlapping polygons still need signed SAT.
      if (gap > Math.max(0, sampleMinimum)) continue;
      sampleMinimum = Math.min(sampleMinimum, convexPolygonClearance(footprint, OBSTACLE_POLYGONS[index]));
    }
    REBUILT_2026_FIELD.crossingBarriers.forEach((barrier) => {
      const barrierX = BARRIER_X.get(barrier)!;
      const section = verticalLineSection(footprint, barrierX);
      const occupied = section ?? { minY: footprintBounds.min.y, maxY: footprintBounds.max.y };
      const lateral = barrier.portals.reduce((best, portal) => {
        const bounds = PORTAL_BOUNDS.get(portal)!;
        return Math.max(best, Math.min(occupied.minY - bounds.minY, bounds.maxY - occupied.maxY));
      }, Number.NEGATIVE_INFINITY);
      if (section) sampleMinimum = Math.min(sampleMinimum, lateral);
      else if (lateral < 0) {
        const longitudinal = barrierX < footprintBounds.min.x
          ? footprintBounds.min.x - barrierX
          : barrierX > footprintBounds.max.x ? barrierX - footprintBounds.max.x : 0;
        sampleMinimum = Math.min(sampleMinimum, longitudinal);
      }
    });
    minimum = Math.min(minimum, sampleMinimum);
    const normalized = Number.isFinite(sampleMinimum) ? sampleMinimum : 0;
    if (normalized < closestSampleClearance) {
      closestSampleClearance = normalized;
      closestSampleIndex = sampleIndex;
    }
  });

  REBUILT_2026_FIELD.crossingBarriers.forEach((barrier) => {
    const barrierX = BARRIER_X.get(barrier)!;
    let previousIndex = -1;
    let previousSide = 0;
    samples.forEach((sample, index) => {
      const delta = sample.x - barrierX;
      const side = Math.abs(delta) <= EPSILON ? 0 : Math.sign(delta);
      if (side === 0) return;
      if (previousIndex >= 0 && previousSide !== side) {
        const pose = crossingPose(samples[previousIndex], sample, barrierX);
        const section = verticalLineSection(transformFootprint(localFootprint, pose), barrierX);
        const portalClearance = barrier.portals.reduce((best, portal) => {
          if (!section) return best;
          const bounds = PORTAL_BOUNDS.get(portal)!;
          return Math.max(best, Math.min(section.minY - bounds.minY, bounds.maxY - section.maxY));
        }, Number.NEGATIVE_INFINITY);
        minimum = Math.min(minimum, portalClearance);
      }
      previousIndex = index;
      previousSide = side;
    });
  });
  return { minimum: Number.isFinite(minimum) ? minimum : 0, closestSampleIndex };
}

export function minimumRobotFieldClearance(robot: RobotConfig, samples: readonly TrajectorySample[]): number {
  return measureRobotFieldClearance(robot, samples).minimum;
}
