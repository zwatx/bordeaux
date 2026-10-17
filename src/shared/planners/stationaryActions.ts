import { buildCanonicalPathState, isStationaryHeadingTransition } from "./pathState";
import { wrapRadians } from "../math/angles";
import type { ConstraintRange, PathDoc, PlannerResult, PlannerStationaryAction, RobotConfig, TrajectorySample } from "../types";
import { MAX_TRAJECTORY_SAMPLES } from "./limits";
import { jigglePositions } from "./jiggle";
import { orderedWaypointSampleIndices } from "./waypointSamples";

const EPSILON = 1e-9;
const DEG = Math.PI / 180;

export function directedDelta(start: number, end: number, direction = "shortest"): number {
  let delta = wrapRadians(end - start);
  if (Math.abs(delta) < EPSILON) return 0;
  if (direction === "clockwise" && delta > 0) delta -= Math.PI * 2;
  if (direction === "counterclockwise" && delta < 0) delta += Math.PI * 2;
  return delta;
}

export function activeAngularLimits(path: PathDoc, fraction: number, waypointIndex: number, totalDistance: number): { velocity: number; acceleration: number; jerk: number } {
  let velocity = path.constraints.maxAngVel * DEG;
  let acceleration = Math.min(path.constraints.maxAngAccel, path.constraints.maxAngDecel ?? path.constraints.maxAngAccel) * DEG;
  const jerk = (path.constraints.maxAngJerk ?? 0) * DEG;
  const requiredIndex = path.routeRequiredPointIndices?.indexOf(waypointIndex) ?? waypointIndex;
  (path.ranges ?? []).forEach((range: ConstraintRange) => {
    let active: boolean;
    if (range.anchor === "wp") {
      const start = (range.w0 ?? 0) + (range.t0 ?? 0);
      const end = (range.w1 ?? (path.routeRequiredPointIndices?.length ?? path.waypoints.length) - 1) + (range.t1 ?? 0);
      const lo = Math.min(start, end);
      const hi = Math.max(start, end);
      active = requiredIndex >= lo - EPSILON && requiredIndex <= hi + EPSILON;
    } else {
      const first = range.anchor === "dist" ? (range.d0 ?? range.f0 * totalDistance) / Math.max(totalDistance, EPSILON) : range.f0;
      const last = range.anchor === "dist" ? (range.d1 ?? range.f1 * totalDistance) / Math.max(totalDistance, EPSILON) : range.f1;
      const lo = Math.min(first, last), hi = Math.max(first, last);
      active = fraction >= lo - EPSILON && fraction <= hi + EPSILON;
    }
    if (active) {
      velocity = Math.min(velocity, (range.maxAngVel ?? Infinity) * DEG);
      acceleration = Math.min(acceleration, (range.maxAngAccel ?? Infinity) * DEG);
    }
  });
  return { velocity: Math.max(velocity, EPSILON), acceleration: Math.max(acceleration, EPSILON), jerk };
}

function activeLinearLimits(path: PathDoc, fraction: number, waypointIndex: number, totalDistance: number): { velocity: number; acceleration: number; deceleration: number } {
  let velocity = path.constraints.maxVel;
  let acceleration = path.constraints.maxAccel;
  let deceleration = path.constraints.maxDecel ?? path.constraints.maxAccel;
  const requiredIndex = path.routeRequiredPointIndices?.indexOf(waypointIndex) ?? waypointIndex;
  (path.ranges ?? []).forEach((range: ConstraintRange) => {
    let active: boolean;
    if (range.anchor === "wp") {
      const start = (range.w0 ?? 0) + (range.t0 ?? 0);
      const end = (range.w1 ?? (path.routeRequiredPointIndices?.length ?? path.waypoints.length) - 1) + (range.t1 ?? 0);
      active = requiredIndex >= Math.min(start, end) - EPSILON && requiredIndex <= Math.max(start, end) + EPSILON;
    } else {
      const first = range.anchor === "dist" ? (range.d0 ?? range.f0 * totalDistance) / Math.max(totalDistance, EPSILON) : range.f0;
      const last = range.anchor === "dist" ? (range.d1 ?? range.f1 * totalDistance) / Math.max(totalDistance, EPSILON) : range.f1;
      active = fraction >= Math.min(first, last) - EPSILON && fraction <= Math.max(first, last) + EPSILON;
    }
    if (active) {
      velocity = Math.min(velocity, range.maxVel ?? Infinity);
      acceleration = Math.min(acceleration, range.maxAccel ?? Infinity);
      deceleration = Math.min(deceleration, range.maxDecel ?? Infinity);
    }
  });
  return {
    velocity: Math.max(velocity, EPSILON),
    acceleration: Math.max(acceleration, EPSILON),
    deceleration: Math.max(deceleration, EPSILON),
  };
}

function feasibleJiggleStrokeDuration(requested: number, distance: number, limits: ReturnType<typeof activeLinearLimits>, freeSpeed: number): number {
  const minimum = Math.max(
    requested,
    4 * distance / Math.min(limits.velocity, freeSpeed),
    Math.sqrt(16 * distance / limits.deceleration),
  );
  const feasible = (duration: number) => {
    const peakVelocity = 4 * distance / duration;
    const availableAcceleration = limits.acceleration * Math.max(0, 1 - peakVelocity / freeSpeed);
    return 16 * distance / (duration * duration) <= availableAcceleration + 1e-9;
  };
  if (feasible(minimum)) return minimum;
  let low = minimum, high = minimum;
  while (!feasible(high)) high *= 2;
  for (let iteration = 0; iteration < 40; iteration += 1) {
    const middle = (low + high) / 2;
    if (feasible(middle)) high = middle;
    else low = middle;
  }
  return high;
}

function samplePeriod(samples: readonly TrajectorySample[]): number {
  let best = Infinity;
  for (let index = 1; index < samples.length; index += 1) {
    const dt = samples[index].t - samples[index - 1].t;
    if (dt > EPSILON) best = Math.min(best, dt);
  }
  return Number.isFinite(best) ? Math.max(0.01, Math.min(0.05, best)) : 0.02;
}

export function nextMovingSampleIndices(samples: readonly TrajectorySample[]): number[] {
  const indices = new Array<number>(samples.length).fill(-1);
  let runStart = 0;
  while (runStart < samples.length) {
    const arrival = samples[runStart];
    let runEnd = runStart;
    while (runEnd + 1 < samples.length) {
      const candidate = samples[runEnd + 1];
      if (Math.hypot(candidate.x - arrival.x, candidate.y - arrival.y) > 1e-5
        || Math.abs(candidate.s - arrival.s) > 1e-6) break;
      runEnd += 1;
    }
    const next = runEnd + 1 < samples.length ? runEnd + 1 : -1;
    for (let index = runStart; index <= runEnd; index += 1) indices[index] = next;
    runStart = runEnd + 1;
  }
  return indices;
}

function rotationDuration(delta: number, limits: ReturnType<typeof activeAngularLimits>): number {
  const distance = Math.abs(delta);
  if (distance < EPSILON) return 0;
  return Math.max(
    distance * 1.875 / limits.velocity,
    Math.sqrt(distance * 5.77351 / limits.acceleration),
    limits.jerk > EPSILON ? Math.cbrt(distance * 60 / limits.jerk) : 0,
  );
}

function jigglePhase(progress: number): { position: number; velocity: number; acceleration: number; travel: number } {
  const u = Math.max(0, Math.min(1, progress));
  if (u < 0.25) return { position: 8 * u * u, velocity: 16 * u, acceleration: 16, travel: 8 * u * u };
  if (u < 0.5) {
    const remaining = 0.5 - u;
    const position = 1 - 8 * remaining * remaining;
    return { position, velocity: 16 * remaining, acceleration: -16, travel: position };
  }
  if (u < 0.75) {
    const elapsed = u - 0.5;
    const position = 1 - 8 * elapsed * elapsed;
    return { position, velocity: -16 * elapsed, acceleration: -16, travel: 2 - position };
  }
  const remaining = 1 - u;
  const position = 8 * remaining * remaining;
  return { position, velocity: -16 * remaining, acceleration: 16, travel: 2 - position };
}

/** Adds optional waypoint actions after a planner has finished its authored geometry. */
export function applyStationaryActions(path: PathDoc, result: PlannerResult, robot?: RobotConfig): PlannerResult {
  if (result.samples.length === 0) return result;
  const baseIndices = result.waypointSampleIndices ?? orderedWaypointSampleIndices(path.waypoints, result.samples, { fallback: "stationary" });
  const nextMovingIndices = nextMovingSampleIndices(result.samples);
  const state = buildCanonicalPathState(path, result.samples);
  const actions = path.waypoints
    .map((waypoint, index) => {
      const boundary = baseIndices[index];
      const movingIndex = nextMovingIndices[boundary] < 0 ? null : nextMovingIndices[boundary];
      const implicitTurnHeading = !waypoint.turnInPlace
        && isStationaryHeadingTransition(
          path,
          state.points[boundary],
          movingIndex === null ? undefined : result.samples[movingIndex].headingRad,
        )
        && movingIndex !== null
        ? result.samples[movingIndex].headingRad
        : undefined;
      return { waypoint, index, implicitTurnHeading };
    })
    .filter(({ waypoint, implicitTurnHeading }) => (
      waypoint.turnInPlace
      || implicitTurnHeading !== undefined
      || waypoint.jiggle
      || (waypoint.stop && (waypoint.wait ?? 0) > 0)
    ));
  if (actions.length === 0) return result;

  const actionIndices = [...baseIndices];
  const terminalIndex = path.waypoints.length - 1;
  if (actions.some(({ index }) => index === terminalIndex)) {
    const arrival = result.samples[actionIndices[terminalIndex]];
    while (actionIndices[terminalIndex] + 1 < result.samples.length) {
      const candidate = result.samples[actionIndices[terminalIndex] + 1];
      if (Math.hypot(candidate.x - arrival.x, candidate.y - arrival.y) > 1e-5
        || Math.abs(candidate.s - arrival.s) > 1e-6) break;
      actionIndices[terminalIndex] += 1;
    }
  }
  const nextMoving = actions.some(({ waypoint }) => waypoint.turnInPlace)
    ? nextMovingSampleIndices(result.samples)
    : null;
  const incompatible = actions.find(({ waypoint, index }) => {
    if (!waypoint.turnInPlace) return false;
    if (index >= path.waypoints.length - 1) return false;
    const boundary = baseIndices[index];
    const movingIndex = nextMoving![boundary];
    const outgoing = movingIndex < 0 ? null : result.samples[movingIndex].headingRad;
    const target = waypoint.turnInPlace!.headingDeg * DEG + (path.driveBackward ? Math.PI : 0);
    return outgoing == null || Math.abs(wrapRadians(outgoing - target)) > 2 * DEG;
  });
  if (incompatible) {
    return {
      ...result,
      diagnostics: [...result.diagnostics, {
        severity: "error",
        path: `paths.${path.name}.waypoints[${incompatible.index}].turnInPlace`,
        message: "Interior turn heading must match the outgoing segment heading",
      }],
    };
  }
  const period = samplePeriod(result.samples);
  let projectedSampleCount = result.samples.length;
  const plannedTicks = new Map<number, { turn: number; jiggle: number; wait: number }>();
  for (const { waypoint, index: waypointIndex, implicitTurnHeading } of actions) {
    const boundary = actionIndices[waypointIndex];
    const arrival = result.samples[boundary];
    const previous = result.samples[Math.max(0, boundary - 1)];
    const startHeading = waypoint.turnInPlace && waypointIndex > 0 ? previous.headingRad : arrival.headingRad;
    const targetHeading = waypoint.turnInPlace
      ? waypoint.turnInPlace.headingDeg * DEG + (path.driveBackward ? Math.PI : 0)
      : implicitTurnHeading ?? arrival.headingRad;
    const delta = waypoint.turnInPlace || implicitTurnHeading !== undefined
      ? directedDelta(startHeading, targetHeading, waypoint.turnInPlace?.direction)
      : 0;
    const turnDuration = (waypoint.turnInPlace || implicitTurnHeading !== undefined) && Math.abs(delta) >= EPSILON
      ? rotationDuration(delta, activeAngularLimits(path, arrival.f, waypointIndex, result.totalDistanceM))
      : 0;
    const turnTicks = turnDuration > EPSILON ? Math.max(1, Math.ceil(turnDuration / period - EPSILON)) : 0;
    const jiggleSupported = !waypoint.jiggle || robot?.drive !== "tank";
    const positions = waypoint.jiggle && jiggleSupported
      ? jigglePositions(waypoint, targetHeading, waypoint.jiggle)
      : null;
    let jiggleDuration = 0;
    if (waypoint.jiggle && positions) {
      const linearLimits = activeLinearLimits(path, arrival.f, waypointIndex, result.totalDistanceM);
      jiggleDuration = feasibleJiggleStrokeDuration(
        waypoint.jiggle.strokeTimeS,
        waypoint.jiggle.distanceM,
        linearLimits,
        Math.max(robot?.maxSpeed ?? linearLimits.velocity, EPSILON),
      );
    }
    const jiggleTicks = waypoint.jiggle && positions
      ? Math.max(1, Math.ceil(jiggleDuration / period - EPSILON))
      : 0;
    const waitTicks = Math.max(0, Math.ceil(Math.max(0, waypoint.wait ?? 0) / period - EPSILON));
    plannedTicks.set(waypointIndex, { turn: turnTicks, jiggle: jiggleTicks, wait: waitTicks });
    projectedSampleCount += turnTicks + jiggleTicks * (waypoint.jiggle?.strokes ?? 0) + waitTicks;
    if (projectedSampleCount > MAX_TRAJECTORY_SAMPLES) {
      throw new Error(`Stationary actions require ${projectedSampleCount} samples, exceeding the trajectory limit of ${MAX_TRAJECTORY_SAMPLES}`);
    }
  }

  const samples = new Array<TrajectorySample>(projectedSampleCount);
  const insertedByWaypoint = new Array<number>(path.waypoints.length).fill(0);
  const markers = result.markers.map((marker) => ({ ...marker }));
  const diagnostics = [...result.diagnostics];
  const stationaryActions: PlannerStationaryAction[] = [];
  let sampleCount = 0;
  let actionCursor = 0;
  let timeOffset = 0;
  let addedDistance = 0;
  let headingOverride: { x: number; y: number; s: number; heading: number } | undefined;

  for (let baseIndex = 0; baseIndex < result.samples.length; baseIndex += 1) {
    const source = result.samples[baseIndex];
    if (headingOverride && (Math.hypot(source.x - headingOverride.x, source.y - headingOverride.y) > 1e-5
      || Math.abs(source.s - headingOverride.s) > 1e-6)) {
      headingOverride = undefined;
    }
    samples[sampleCount] = {
      ...source,
      t: source.t + timeOffset,
      ...(headingOverride ? { headingRad: headingOverride.heading } : {}),
    };
    sampleCount += 1;

    while (actionCursor < actions.length && actionIndices[actions[actionCursor].index] === baseIndex) {
      const { waypoint, index: waypointIndex, implicitTurnHeading } = actions[actionCursor];
      actionCursor += 1;
      const turn = waypoint.turnInPlace;
      const arrival = samples[sampleCount - 1];
      const previous = samples[Math.max(0, sampleCount - 2)];
      const startHeading = waypoint.turnInPlace && waypointIndex > 0 ? previous.headingRad : arrival.headingRad;
      const hasTurn = Boolean(turn) || implicitTurnHeading !== undefined;
      const targetHeading = turn ? turn.headingDeg * DEG + (path.driveBackward ? Math.PI : 0) : implicitTurnHeading ?? arrival.headingRad;
      const delta = hasTurn ? directedDelta(startHeading, targetHeading, turn?.direction) : 0;
      const ticks = plannedTicks.get(waypointIndex)!;
      const turnTicks = ticks.turn;
      const turnDuration = turnTicks * period;
      const jiggle = waypoint.jiggle;
      const jiggleHeading = hasTurn ? targetHeading : arrival.headingRad;
      const jiggleSupported = !jiggle || robot?.drive !== "tank";
      const positions = jiggle && jiggleSupported ? jigglePositions(waypoint, jiggleHeading, jiggle) : null;
      if (jiggle && !jiggleSupported) {
        diagnostics.push({
          severity: "error",
          path: `paths.${path.name}.waypoints[${waypointIndex}].jiggle`,
          message: "Arbitrary-direction jiggle requires a swerve drivetrain",
        });
      }
      if (jiggle && jiggleSupported && !positions) {
        diagnostics.push({
          severity: "error",
          path: `paths.${path.name}.waypoints[${waypointIndex}].jiggle`,
          message: "Jiggle directions must be unique and every stroke must stay on the field",
        });
      }
      const jiggleTicks = jiggle && positions ? ticks.jiggle : 0;
      const jiggleStrokeDuration = jiggleTicks * period;
      const jiggleDuration = jiggle && positions ? jiggleStrokeDuration * jiggle.strokes : 0;
      const waitTicks = ticks.wait;
      const waitDuration = Math.max(0, waypoint.wait ?? 0);
      const duration = turnDuration + jiggleDuration + waitDuration;
      if (duration <= EPSILON) continue;
      const arrivalTime = arrival.t;
      if (turnDuration > EPSILON) stationaryActions.push({
        kind: "turn",
        waypointIndex,
        fraction: arrival.f,
        startTimeS: arrivalTime,
        endTimeS: arrivalTime + turnDuration,
      });
      if (jiggleDuration > EPSILON) stationaryActions.push({
        kind: "jiggle",
        waypointIndex,
        fraction: arrival.f,
        startTimeS: arrivalTime + turnDuration,
        endTimeS: arrivalTime + turnDuration + jiggleDuration,
        strokeDurationS: jiggleStrokeDuration,
      });
      if (waitDuration > EPSILON) stationaryActions.push({
        kind: "wait",
        waypointIndex,
        fraction: arrival.f,
        startTimeS: arrivalTime + turnDuration + jiggleDuration,
        endTimeS: arrivalTime + duration,
      });

      if (hasTurn) {
        arrival.headingRad = startHeading;
        headingOverride = { x: arrival.x, y: arrival.y, s: arrival.s, heading: targetHeading };
      }
      arrival.velocityMps = 0;
      arrival.accelerationMps2 = 0;
      const beforeActionSamples = sampleCount;
      for (let tick = 1; tick <= turnTicks; tick += 1) {
        const u = tick / turnTicks;
        const progress = 10 * u ** 3 - 15 * u ** 4 + 6 * u ** 5;
        samples[sampleCount] = {
          ...arrival,
          i: 0,
          t: arrivalTime + tick * period,
          headingRad: startHeading + delta * progress,
          velocityMps: 0,
          accelerationMps2: 0,
          angularVelocityRadps: delta * (30 * u ** 2 - 60 * u ** 3 + 30 * u ** 4) / turnDuration,
        };
        sampleCount += 1;
      }
      const waitHeading = hasTurn ? targetHeading : arrival.headingRad;
      let finalJiggleHeading: number | undefined;
      if (jiggle && positions) {
        for (let stroke = 0; stroke < jiggle.strokes; stroke += 1) {
          const angle = jiggleHeading + (jiggle.startDeg + jiggle.stepDeg * stroke) * DEG;
          for (let tick = 1; tick <= jiggleTicks; tick += 1) {
            const u = tick / jiggleTicks;
            const phase = jigglePhase(u);
            const radialDistance = jiggle.distanceM * phase.position;
            samples[sampleCount] = {
              ...arrival,
              i: 0,
              t: arrivalTime + turnDuration + stroke * jiggleStrokeDuration + tick * period,
              s: arrival.s + addedDistance + stroke * jiggle.distanceM * 2 + jiggle.distanceM * phase.travel,
              f: arrival.f,
              x: arrival.x + Math.cos(angle) * radialDistance,
              y: arrival.y + Math.sin(angle) * radialDistance,
              headingRad: jiggleHeading,
              velocityMps: Math.abs(phase.velocity) * jiggle.distanceM / jiggleStrokeDuration,
              accelerationMps2: tick === jiggleTicks ? 0 : phase.acceleration * jiggle.distanceM / (jiggleStrokeDuration * jiggleStrokeDuration),
              angularVelocityRadps: 0,
              curvatureInvM: 0,
            };
            finalJiggleHeading = jiggleHeading;
            sampleCount += 1;
          }
        }
        addedDistance += jiggle.distanceM * 2 * jiggle.strokes;
      }
      for (let tick = 1; tick <= waitTicks; tick += 1) {
        samples[sampleCount] = {
          ...arrival,
          i: 0,
          // Keep the authored duration; the final hold interval may be shorter.
          t: tick === waitTicks ? arrivalTime + duration : arrivalTime + turnDuration + jiggleDuration + tick * period,
          s: arrival.s + addedDistance,
          f: arrival.f,
          headingRad: finalJiggleHeading ?? waitHeading,
          velocityMps: 0,
          accelerationMps2: 0,
          angularVelocityRadps: 0,
        };
        sampleCount += 1;
      }
      insertedByWaypoint[waypointIndex] += sampleCount - beforeActionSamples;
      timeOffset += duration;
    }
  }

  samples.length = sampleCount;
  const waypointSampleIndices = new Array<number>(baseIndices.length);
  let insertedBefore = 0;
  for (let index = 0; index < waypointSampleIndices.length; index += 1) {
    waypointSampleIndices[index] = baseIndices[index] + insertedBefore;
    insertedBefore += insertedByWaypoint[index];
  }
  const markerOffsets: Array<{ time: number; duration: number }> = [];
  let cumulativeDuration = 0;
  actions.forEach(({ waypoint, index }) => {
    const ticks = plannedTicks.get(index)!;
    const duration = (ticks.turn + ticks.jiggle * (waypoint.jiggle?.strokes ?? 0)) * period
      + Math.max(0, waypoint.wait ?? 0);
    if (duration <= EPSILON) return;
    cumulativeDuration += duration;
    markerOffsets.push({
      time: result.samples[actionIndices[index]].t,
      duration: cumulativeDuration,
    });
  });
  markers.forEach((marker) => {
    let low = 0;
    let high = markerOffsets.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (markerOffsets[middle].time < marker.timeS - EPSILON) low = middle + 1;
      else high = middle;
    }
    if (low > 0) marker.timeS += markerOffsets[low - 1].duration;
  });

  if (samples.length > MAX_TRAJECTORY_SAMPLES) throw new Error(`Stationary actions require ${samples.length} samples, exceeding the trajectory limit of ${MAX_TRAJECTORY_SAMPLES}`);
  samples.forEach((sample, index) => {
    sample.i = index;
    if (index === 0) sample.angularVelocityRadps = 0;
    else {
      const before = samples[index - 1];
      sample.headingRad = before.headingRad + wrapRadians(sample.headingRad - before.headingRad);
      // Preserve point angular velocities from the validated moving profile and
      // analytic stationary samples; interval averages are not endpoint rates.
    }
  });
  const totalTimeS = samples.at(-1)?.t ?? result.totalTimeS;
  markers.forEach((marker) => {
    if (marker.fraction >= 1 - EPSILON) marker.timeS = totalTimeS;
  });
  return {
    ...result,
    totalTimeS,
    totalDistanceM: result.totalDistanceM + addedDistance,
    samples,
    waypointSampleIndices,
    markers,
    diagnostics,
    stationaryActions,
    optimization: result.optimization ? { ...result.optimization, totalTimeS } : result.optimization,
  };
}
