import { physicalPlannerInput } from "../robotLimits";
import type { PathDoc, PlannerResult, RobotConfig } from "../types";

function firstSampleAtOrAfter(samples: PlannerResult["samples"], key: "f" | "t", value: number): number {
  let low = 0, high = samples.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (samples[middle][key] < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function markersMatch(path: PathDoc, result: PlannerResult): boolean {
  if (result.markers.length !== path.markers.length) return false;
  if (path.markers.length === 0) return true;
  // Structural validation allows tiny fraction decreases in older artifacts.
  // Keep their original first-match semantics instead of assuming exact order.
  const orderedFractions = result.samples.every((sample, index) => index === 0 || sample.f >= result.samples[index - 1].f);
  return path.markers.every((marker, index) => {
    const saved = result.markers[index];
    const fraction = marker.anchor === "dist" && result.totalDistanceM > 1e-9
      ? Math.max(0, Math.min(1, (marker.d ?? marker.f * result.totalDistanceM) / result.totalDistanceM)) : marker.f;
    if (saved.id !== marker.id || saved.name !== marker.name || saved.command !== (marker.cmd ?? null)
      || saved.group !== (marker.group ?? null) || JSON.stringify(saved.invocation) !== JSON.stringify(marker.invocation)
      || Math.abs(saved.fraction - fraction) > 1e-5) return false;
    // Events at an arrival precede waits/turns, except terminal events, which follow them.
    const after = fraction >= 1 ? result.samples.at(-1)!
      : orderedFractions ? result.samples[firstSampleAtOrAfter(result.samples, "f", fraction)]
        : result.samples.find((sample) => sample.f >= fraction)!;
    const before = result.samples[Math.max(0, after.i - 1)];
    const progress = after.f === before.f ? 0 : (fraction - before.f) / (after.f - before.f);
    const expectedTime = fraction >= 1 ? after.t : before.t + (after.t - before.t) * progress;
    return Math.abs(saved.timeS - expectedTime) < 0.002;
  });
}

export function stationaryActionsMatch(path: PathDoc, robot: RobotConfig, result: PlannerResult): boolean {
  const actions = result.stationaryActions ?? [];
  const waitedWaypoints = new Set<number>();
  const limits = physicalPlannerInput({ path, robot }).path.constraints;
  for (const action of actions) {
    const waypoint = path.waypoints[action.waypointIndex];
    if (!waypoint || action.kind === "jiggle") return false;
    if (action.kind === "wait" && Math.abs(action.endTimeS - action.startTimeS - (waypoint.wait ?? 0)) > 0.021) return false;
    // Shape validation already requires strictly increasing timestamps.
    const first = firstSampleAtOrAfter(result.samples, "t", action.startTimeS - 1e-6);
    let end = first;
    while (end < result.samples.length && result.samples[end].t <= action.endTimeS + 1e-6) {
      const sample = result.samples[end];
      if (Math.hypot(sample.x - waypoint.x, sample.y - waypoint.y) > 0.001
        || Math.abs(sample.velocityMps) > 0.001 || Math.abs(sample.f - action.fraction) > 1e-5) return false;
      end += 1;
    }
    if (end - first < 2) return false;
    for (let index = first + 1; index < end; index += 1) {
      const before = result.samples[index - 1], sample = result.samples[index];
      const velocity = Math.atan2(Math.sin(sample.headingRad - before.headingRad), Math.cos(sample.headingRad - before.headingRad)) / (sample.t - before.t);
      if ((action.kind === "wait" && Math.abs(velocity) > 0.001)
        || Math.abs(velocity) > limits.maxAngVel * Math.PI / 180 + 0.002) return false;
    }
    if (action.kind === "turn" && waypoint.turnInPlace) {
      const target = waypoint.turnInPlace.headingDeg * Math.PI / 180 + (path.driveBackward ? Math.PI : 0);
      const delta = result.samples[end - 1].headingRad - target;
      if (Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta))) > 0.001) return false;
    }
    if (action.kind === "wait") waitedWaypoints.add(action.waypointIndex);
  }
  return path.waypoints.every((waypoint, index) => !(waypoint.wait ?? 0)
    || waitedWaypoints.has(index));
}
