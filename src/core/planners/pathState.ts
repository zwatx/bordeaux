import type { PathDoc, TrajectorySample } from "../types";

const EPSILON = 1e-9;

export interface CanonicalPathPoint {
  sourceIndex: number;
  s: number;
  f: number;
  x: number;
  y: number;
  tangentRad: number;
  tangentX: number;
  tangentY: number;
  normalX: number;
  normalY: number;
  curvatureInvM: number;
  headingRad: number;
  headingDerivativeRadPerM: number;
  headingSecondDerivativeRadPerM2: number;
  segmentIndex: number;
  segmentFraction: number;
  waypointIndex?: number;
  stop: boolean;
}

export interface CanonicalPathState {
  points: CanonicalPathPoint[];
  waypointSampleIndices: number[];
  totalDistanceM: number;
}

function segmentHeadingLaw(path: PathDoc, segmentIndex: number): string {
  const waypoint = path.waypoints[segmentIndex];
  const mode = waypoint?.segmentHeadingMode ?? path.headingMode ?? "targets";
  if (mode !== "lookAt") return mode;
  const target = waypoint?.segmentLookAt;
  return target ? `${mode}:${target.x}:${target.y}` : mode;
}

/** A stopped waypoint may connect two distinct heading laws by rotating in place. */
export function isStationaryHeadingTransition(
  path: PathDoc,
  point: CanonicalPathPoint | undefined,
  outgoingHeadingRad?: number,
): boolean {
  if (!point?.stop || point.waypointIndex === undefined) return false;
  const waypointIndex = point.waypointIndex;
  if (path.waypoints[waypointIndex]?.turnInPlace) return true;
  if (waypointIndex <= 0 || waypointIndex >= path.waypoints.length - 1) return false;
  if (outgoingHeadingRad !== undefined) {
    const delta = Math.atan2(
      Math.sin(outgoingHeadingRad - point.headingRad),
      Math.cos(outgoingHeadingRad - point.headingRad),
    );
    if (Math.abs(delta) > 1e-4) return true;
  }
  return segmentHeadingLaw(path, waypointIndex - 1) !== segmentHeadingLaw(path, waypointIndex);
}

function unwrap(values: readonly number[]): number[] {
  if (values.length === 0) return [];
  const result = [values[0]];
  for (let index = 1; index < values.length; index += 1) {
    let delta = values[index] - result[index - 1];
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    result.push(result[index - 1] + delta);
  }
  return result;
}

// Neighbors depend only on distance, so every derivative can share them.
// Reuse a neighbor across identical distances to keep long waits/turns linear.
function derivativeNeighbors(positions: readonly number[]): { before: number[]; after: number[] } {
  const before = new Array<number>(positions.length);
  const after = new Array<number>(positions.length);
  for (let index = 0; index < positions.length; index += 1) {
    let candidate = index === 0 ? 0 : index - 1;
    if (index > 0 && positions[index] === positions[index - 1]) candidate = before[index - 1];
    while (candidate > 0 && positions[index] - positions[candidate] <= EPSILON) candidate -= 1;
    before[index] = candidate;
  }
  for (let index = positions.length - 1; index >= 0; index -= 1) {
    let candidate = Math.min(index + 1, positions.length - 1);
    if (index + 1 < positions.length && positions[index] === positions[index + 1]) candidate = after[index + 1];
    while (candidate < positions.length - 1 && positions[candidate] - positions[index] <= EPSILON) candidate += 1;
    after[index] = candidate;
  }
  return { before, after };
}

function derivative(
  values: readonly number[],
  positions: readonly number[],
  neighbors: ReturnType<typeof derivativeNeighbors>,
  breaks: ReadonlySet<number> = new Set(),
): number[] {
  return values.map((_value, index) => {
    let before = neighbors.before[index];
    let after = neighbors.after[index];
    if (positions[index] - positions[before] <= EPSILON) before = index;
    if (positions[after] - positions[index] <= EPSILON) after = index;
    if (breaks.has(index)) {
      if (after > index) before = index;
      else after = index;
    } else {
      if (breaks.has(before)) before = index;
      if (breaks.has(after)) after = index;
    }
    if (before < index && after > index) {
      const left = positions[index] - positions[before];
      const right = positions[after] - positions[index];
      // A target can split a sampling interval at any distance. Weight the
      // secants at this sample, rather than differentiating at the midpoint
      // of its neighbors (which invents angular acceleration on uneven grids).
      return ((values[index] - values[before]) / left * right
        + (values[after] - values[index]) / right * left) / (left + right);
    }
    const distance = positions[after] - positions[before];
    return distance > EPSILON ? (values[after] - values[before]) / distance : 0;
  });
}

// Waypoint lookup returns the earliest sample at or after the previous
// waypoint's sample that is nearest by Math.hypot. A 1e-4 m lattice locates
// that sample without rescanning the suffix: |ix(a) - ix(b)| <= 2 whenever
// hypot(a - b) <= LATTICE_RADIUS_M, so a candidate within that radius proves
// that every equally near or nearer suffix sample was among its 5x5 cells.
// Beyond LATTICE_LIMIT_M, division error could exceed that cell margin.
const LATTICE_STEP_M = 1e-4;
const LATTICE_RADIUS_M = 1e-4;
const LATTICE_LIMIT_M = 1e6;

function latticeCell(value: number): number {
  return Math.round(value / LATTICE_STEP_M);
}

function latticeKey(x: number, y: number): string {
  return `${x},${y}`;
}

function suffixNearestIndex(
  waypoint: { x: number; y: number },
  samples: readonly TrajectorySample[],
  cursor: number,
): number {
  let best = cursor;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = cursor; index < samples.length; index += 1) {
    const distance = Math.hypot(samples[index].x - waypoint.x, samples[index].y - waypoint.y);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

function firstAtOrAfter(indices: readonly number[], cursor: number): number {
  let low = 0;
  let high = indices.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (indices[middle] < cursor) low = middle + 1;
    else high = middle;
  }
  return low;
}

function waypointSampleIndices(path: PathDoc, samples: readonly TrajectorySample[]): number[] {
  const cells = new Map<string, number[]>();
  for (let index = 0; index < samples.length; index += 1) {
    const key = latticeKey(latticeCell(samples[index].x), latticeCell(samples[index].y));
    const cell = cells.get(key);
    if (cell) cell.push(index);
    else cells.set(key, [index]);
  }
  let cursor = 0;
  return path.waypoints.map((waypoint) => {
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    if (Math.abs(waypoint.x) <= LATTICE_LIMIT_M && Math.abs(waypoint.y) <= LATTICE_LIMIT_M) {
      const cellX = latticeCell(waypoint.x);
      const cellY = latticeCell(waypoint.y);
      for (let offsetX = -2; offsetX <= 2; offsetX += 1) {
        for (let offsetY = -2; offsetY <= 2; offsetY += 1) {
          const cell = cells.get(latticeKey(cellX + offsetX, cellY + offsetY));
          if (!cell) continue;
          for (let position = firstAtOrAfter(cell, cursor); position < cell.length; position += 1) {
            const index = cell[position];
            const distance = Math.hypot(samples[index].x - waypoint.x, samples[index].y - waypoint.y);
            if (distance < bestDistance || (distance === bestDistance && index < best)) {
              best = index;
              bestDistance = distance;
            }
          }
        }
      }
    }
    // Waypoints away from every remaining sample keep the exhaustive scan.
    cursor = bestDistance <= LATTICE_RADIUS_M ? best : suffixNearestIndex(waypoint, samples, cursor);
    return cursor;
  });
}

export function buildCanonicalPathState(
  path: PathDoc,
  samples: readonly TrajectorySample[],
  headingBreaks: ReadonlySet<number> = new Set(),
): CanonicalPathState {
  if (samples.length < 2) throw new Error("Canonical path state requires at least two trajectory samples.");
  const positions = samples.map((sample) => sample.s);
  for (let index = 0; index < positions.length; index += 1) {
    if (!Number.isFinite(positions[index])) throw new Error(`Trajectory distance ${index} must be finite.`);
    if (index > 0 && positions[index] < positions[index - 1] - EPSILON) {
      throw new Error("Trajectory distances must be monotonic.");
    }
  }

  const waypointIndices = waypointSampleIndices(path, samples);
  const stoppedSamples = new Set<number>();
  waypointIndices.forEach((sampleIndex, waypointIndex) => {
    if (path.waypoints[waypointIndex]?.stop) stoppedSamples.add(sampleIndex);
  });
  const neighbors = derivativeNeighbors(positions);
  const tangentXRaw = derivative(samples.map((sample) => sample.x), positions, neighbors, stoppedSamples);
  const tangentYRaw = derivative(samples.map((sample) => sample.y), positions, neighbors, stoppedSamples);
  const tangentAngles = unwrap(tangentXRaw.map((x, index) => Math.atan2(tangentYRaw[index], x)));
  const curvatures = derivative(tangentAngles, positions, neighbors, stoppedSamples);
  const headings = unwrap(samples.map((sample) => sample.headingRad));
  const headingDerivativeBreaks = new Set([...stoppedSamples, ...headingBreaks]);
  const headingDerivatives = derivative(headings, positions, neighbors, headingDerivativeBreaks);
  const headingSecondDerivatives = derivative(headingDerivatives, positions, neighbors, headingDerivativeBreaks);
  const waypointBySample = new Map<number, number>();
  waypointIndices.forEach((sampleIndex, waypointIndex) => {
    if (!waypointBySample.has(sampleIndex)) waypointBySample.set(sampleIndex, waypointIndex);
  });

  let segment = 0;
  const points = samples.map((sample, index): CanonicalPathPoint => {
    while (segment < waypointIndices.length - 2 && index > waypointIndices[segment + 1]) segment += 1;
    const length = Math.hypot(tangentXRaw[index], tangentYRaw[index]);
    const tangentX = length > EPSILON ? tangentXRaw[index] / length : Math.cos(tangentAngles[index]);
    const tangentY = length > EPSILON ? tangentYRaw[index] / length : Math.sin(tangentAngles[index]);
    const segmentStart = waypointIndices[segment] ?? 0;
    const segmentEnd = waypointIndices[segment + 1] ?? Math.max(segmentStart, samples.length - 1);
    const waypointIndex = waypointBySample.get(index);
    const sampledCurvature = Math.abs(sample.curvatureInvM);
    const derivedCurvature = curvatures[index];
    const curvatureSign = Math.sign(derivedCurvature) || 1;
    return {
      sourceIndex: index,
      s: sample.s,
      f: sample.f,
      x: sample.x,
      y: sample.y,
      tangentRad: tangentAngles[index],
      tangentX,
      tangentY,
      normalX: -tangentY,
      normalY: tangentX,
      // PM evaluates Bezier/arc/clothoid curvature on the authored geometry.
      // Keep its magnitude so finite-difference smoothing cannot hide a local
      // peak, while retaining the signed direction needed by drivetrain math.
      curvatureInvM: curvatureSign * Math.max(Math.abs(derivedCurvature), sampledCurvature),
      headingRad: headings[index],
      headingDerivativeRadPerM: headingDerivatives[index],
      headingSecondDerivativeRadPerM2: headingSecondDerivatives[index],
      segmentIndex: segment,
      segmentFraction: segmentEnd > segmentStart ? (index - segmentStart) / (segmentEnd - segmentStart) : 0,
      ...(waypointIndex !== undefined ? { waypointIndex } : {}),
      stop: stoppedSamples.has(index),
    };
  });

  return {
    points,
    waypointSampleIndices: waypointIndices,
    totalDistanceM: samples[samples.length - 1].s,
  };
}

export function interpolatePathPoint(
  before: CanonicalPathPoint,
  after: CanonicalPathPoint,
  fraction = 0.5,
): CanonicalPathPoint {
  const t = Math.max(0, Math.min(1, fraction));
  const mix = (first: number, second: number) => first + (second - first) * t;
  const phasePoint = after.stop ? before : before.stop ? after : undefined;
  const tangentRad = phasePoint?.tangentRad ?? mix(before.tangentRad, after.tangentRad);
  return {
    sourceIndex: before.sourceIndex,
    s: mix(before.s, after.s),
    f: mix(before.f, after.f),
    x: mix(before.x, after.x),
    y: mix(before.y, after.y),
    tangentRad,
    tangentX: Math.cos(tangentRad),
    tangentY: Math.sin(tangentRad),
    normalX: -Math.sin(tangentRad),
    normalY: Math.cos(tangentRad),
    curvatureInvM: phasePoint?.curvatureInvM ?? mix(before.curvatureInvM, after.curvatureInvM),
    headingRad: phasePoint?.headingRad ?? mix(before.headingRad, after.headingRad),
    headingDerivativeRadPerM: phasePoint?.headingDerivativeRadPerM
      ?? mix(before.headingDerivativeRadPerM, after.headingDerivativeRadPerM),
    headingSecondDerivativeRadPerM2: phasePoint?.headingSecondDerivativeRadPerM2
      ?? mix(before.headingSecondDerivativeRadPerM2, after.headingSecondDerivativeRadPerM2),
    segmentIndex: before.segmentIndex,
    segmentFraction: mix(before.segmentFraction, after.segmentFraction),
    stop: false,
  };
}
