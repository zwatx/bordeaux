import type { TrajectorySample, Waypoint } from "../types";

function coordinateKey(point: Pick<Waypoint, "x" | "y">): string {
  // Planner samples serialize geometry to four decimal places. Indexing the
  // authored coordinate at that same precision preserves the exact boundary.
  return `${Number(point.x.toFixed(4))},${Number(point.y.toFixed(4))}`;
}

interface CoordinateRun {
  start: number;
  end: number;
}

function nearestIndex(
  waypoint: Waypoint,
  samples: readonly TrajectorySample[],
  start: number,
  end: number,
  stopEarly: boolean,
): number {
  let nearest = start;
  let distance = Infinity;
  for (let candidate = start; candidate <= end; candidate += 1) {
    const candidateDistance = Math.hypot(samples[candidate].x - waypoint.x, samples[candidate].y - waypoint.y);
    if (candidateDistance < distance) { nearest = candidate; distance = candidateDistance; }
    if (stopEarly && distance < 1e-5 && candidateDistance > distance + 1e-4) break;
  }
  return nearest;
}

/**
 * Locates the ordered boundary sample retained for every authored waypoint.
 * Bordeaux planners preserve each waypoint at four-decimal sample precision.
 * Coordinate runs collapse stationary holds while retaining distinct departures
 * and returns, avoiding a trajectory rescan for every waypoint.
 */
export function orderedWaypointSampleIndices(
  waypoints: readonly Waypoint[],
  samples: readonly TrajectorySample[],
  options: {
    fallback?: "bounded" | "full" | "stationary";
  } = {},
): number[] {
  if (samples.length === 0) return [];
  const runsByCoordinate = new Map<string, CoordinateRun[]>();
  let previousKey: string | undefined;
  samples.forEach((sample, index) => {
    const key = coordinateKey(sample);
    const runs = runsByCoordinate.get(key);
    if (key === previousKey) runs!.at(-1)!.end = index;
    else if (runs) runs.push({ start: index, end: index });
    else runsByCoordinate.set(key, [{ start: index, end: index }]);
    previousKey = key;
  });

  const nextRunPositions = new Map<string, number>();
  const indices: number[] = [];
  let cursor = 0;
  for (let waypointIndex = 0; waypointIndex < waypoints.length;) {
    const key = coordinateKey(waypoints[waypointIndex]);
    let groupEnd = waypointIndex;
    while (groupEnd + 1 < waypoints.length && coordinateKey(waypoints[groupEnd + 1]) === key) groupEnd += 1;
    const groupSize = groupEnd - waypointIndex + 1;
    const finalSearchIndex = options.fallback === "full"
      || options.fallback === "stationary"
      || groupEnd === waypoints.length - 1
      ? samples.length - 1
      : Math.max(cursor, samples.length - (waypoints.length - groupEnd));
    const runs = runsByCoordinate.get(key) ?? [];
    let runPosition = nextRunPositions.get(key) ?? 0;
    while (runs[runPosition]?.end < cursor) runPosition += 1;
    const run = runs[runPosition];
    const start = run ? Math.max(cursor, run.start) : undefined;
    if (start !== undefined && start <= finalSearchIndex) {
      const end = Math.min(run.end, finalSearchIndex);
      for (let offset = 0; offset < groupSize; offset += 1) {
        const index = groupSize > 1
          ? Math.round(start + (end - start) * offset / (groupSize - 1))
          : start;
        indices.push(index);
      }
      nextRunPositions.set(key, runPosition + 1);
      cursor = indices.at(-1)!;
      waypointIndex = groupEnd + 1;
      continue;
    }

    for (; waypointIndex <= groupEnd; waypointIndex += 1) {
      const remaining = groupEnd - waypointIndex;
      const index = nearestIndex(
        waypoints[waypointIndex],
        samples,
        cursor,
        Math.max(cursor, finalSearchIndex - remaining),
        options.fallback === "stationary",
      );
      indices.push(index);
      cursor = index;
    }
  }
  return indices;
}
