import type { PlannerInput, PlannerResult, TrajectorySample } from "../types";
import { canonicalPlanningInput } from "./index";
import { DEFAULT_SAMPLES_PER_SEGMENT, MAX_TRAJECTORY_SAMPLES } from "./limits";
import { buildReachabilityInput, insertOptimizationBoundaries } from "./optimizationConstraints";
import { remapTiming, remapWaypointIndices } from "./optimizedTrajectory";
import { profiledSplineOptimizationSeed } from "./profiledSpline";
import { solveReachabilityProfile } from "./reachability";
import { applyRotationPriority } from "./rotationPriority";
import { applyStationaryActions } from "./stationaryActions";
import { validateOptimizedTrajectory } from "./trajectoryValidation";

export type CorridorEstimate =
  | { kind: "ranked"; version: 1; density: number; estimatedTimeS: number }
  | { kind: "unranked"; version: 1; density: number; reason: string };

const EPSILON = 1e-9;
const positive = (value: number) => Number.isFinite(value) && value > 0;
const nonnegative = (value: number) => Number.isFinite(value) && value >= 0;

// The seed/constraint helpers deliberately tolerate legacy numeric defaults. A private score
// must not silently replace malformed authored limits or geometry with those defaults.
function validInput(input: PlannerInput): boolean {
  const { path, robot } = input;
  if (!path || !robot || !Array.isArray(path.waypoints) || path.waypoints.length < 2
    || !Array.isArray(path.ranges) || !Array.isArray(path.targets) || !path.constraints
    || !positive(robot.maxSpeed) || !positive(robot.w) || !positive(robot.l)
    || !nonnegative(path.startVel) || !nonnegative(path.goalVel)) return false;
  const required = [path.constraints.maxVel, path.constraints.maxAccel, path.constraints.maxDecel, path.constraints.maxAngVel, path.constraints.maxAngAccel];
  if (!required.every(positive) || !Object.entries(path.constraints).every(([key, value]) => value === undefined
    || (key === "maxJerk" || key === "maxAngJerk" ? nonnegative(value) : positive(value)))) return false;
  if (robot.driveModel && !Object.values(robot.driveModel).every(value => typeof value !== "number" || positive(value))) return false;
  if (!path.waypoints.every(waypoint => waypoint && [waypoint.x, waypoint.y, waypoint.theta].every(Number.isFinite)
    && [waypoint.prevC, waypoint.nextC, waypoint.segmentLookAt].every(point => !point || [point.x, point.y].every(Number.isFinite))
    && (waypoint.wait === undefined || (nonnegative(waypoint.wait) && (waypoint.wait === 0 || waypoint.stop)))
    && (!waypoint.turnInPlace || (waypoint.stop && Number.isFinite(waypoint.turnInPlace.headingDeg))))) return false;
  return path.targets.every(target => target && [target.f, target.deg].every(Number.isFinite) && (target.d === undefined || Number.isFinite(target.d)))
    && path.ranges.every(range => range && [range.f0, range.f1].every(Number.isFinite)
      && [range.d0, range.d1, range.w0, range.w1, range.t0, range.t1].every(value => value === undefined || Number.isFinite(value))
      && [range.maxVel, range.maxAccel, range.maxDecel, range.maxAngVel, range.maxAngAccel].every(value => value === undefined || positive(value)));
}

function saneSamples(samples: readonly TrajectorySample[], timed: boolean): boolean {
  return samples.length >= 2 && samples.length <= MAX_TRAJECTORY_SAMPLES && samples.every((sample, index) => {
    const before = samples[index - 1];
    return sample && [sample.i, sample.t, sample.s, sample.f, sample.x, sample.y, sample.headingRad,
      sample.velocityMps, sample.accelerationMps2, sample.angularVelocityRadps, sample.curvatureInvM].every(Number.isFinite)
      && sample.i === index && sample.t >= 0 && sample.s >= 0 && sample.f >= -EPSILON && sample.f <= 1 + EPSILON
      && (!before || (sample.s >= before.s - EPSILON && sample.f >= before.f - EPSILON && (!timed || sample.t > before.t)));
  }) && Math.abs(samples[0].f) <= EPSILON && Math.abs(samples.at(-1)!.f - 1) <= EPSILON;
}

/** Private single-pass heuristic score; never a trajectory or a feasibility certificate. */
export function estimateCorridorCandidate(input: PlannerInput): CorridorEstimate {
  const density = typeof input?.samplesPerSegment === "number" ? input.samplesPerSegment : DEFAULT_SAMPLES_PER_SEGMENT;
  const unavailable = (reason: string): CorridorEstimate => ({ kind: "unranked", version: 1, density, reason });
  try {
    if (!validInput(input)) return unavailable("Authored geometry or physical limits are invalid.");
    if (input.path.waypoints.some(waypoint => waypoint.jiggle)) return unavailable("Jiggle actions are not supported by provisional corridor timing.");
    const { physicalInput, planningInput } = canonicalPlanningInput(input);
    // The raw seed owns the density/sample-budget boundary and supplies unrounded geometry.
    const seed = profiledSplineOptimizationSeed(planningInput);
    if (!saneSamples(seed.samples, false)) return unavailable("The timing seed has insufficient or malformed samples.");
    const seedError = seed.diagnostics.find(issue => issue.severity === "error");
    if (seedError) return unavailable(seedError.message);
    const geometry = insertOptimizationBoundaries(planningInput, seed.samples);
    const waypointSampleIndices = remapWaypointIndices(seed, geometry);
    if (!waypointSampleIndices || waypointSampleIndices.length !== physicalInput.path.waypoints.length
      || waypointSampleIndices.some(index => !Number.isInteger(index) || index < 0 || index >= geometry.length)) return unavailable("Authored waypoint boundaries are unavailable.");
    const reachability = solveReachabilityProfile(buildReachabilityInput(planningInput, geometry));
    if (reachability.status !== "optimal" || reachability.velocities.length !== geometry.length
      || !reachability.velocities.every(nonnegative)) return unavailable(reachability.reason || "Single-pass reachability did not produce a timing estimate.");
    const samples = remapTiming(geometry, reachability.velocities, true);
    // The local structural shape supports the existing action helpers. It carries no optimization
    // claims and no seed marker timestamps: only the eventual full finalizer may publish those.
    const moving: PlannerResult = { planner: seed.planner, totalDistanceM: seed.totalDistanceM,
      totalTimeS: samples.at(-1)!.t, samples, waypointSampleIndices, markers: [], diagnostics: seed.diagnostics };
    const rotated = applyRotationPriority(physicalInput.path, moving, physicalInput.robot);
    const expanded = applyStationaryActions(physicalInput.path, rotated, physicalInput.robot);
    const error = expanded.diagnostics.find(issue => issue.severity === "error");
    if (error) return unavailable(error.message);
    if (!positive(expanded.totalTimeS) || !nonnegative(expanded.totalDistanceM) || !saneSamples(expanded.samples, true)
      || Math.abs(expanded.samples[0].t) > EPSILON || Math.abs(expanded.samples.at(-1)!.t - expanded.totalTimeS) > EPSILON
      || Math.abs(expanded.samples.at(-1)!.s - expanded.totalDistanceM) > EPSILON) return unavailable("Single-pass timing has malformed or nonfinite samples.");
    const validation = validateOptimizedTrajectory(physicalInput, expanded.samples, { angularKinematics: "sample" });
    if (validation.violations.length) return unavailable(validation.violations[0].message);
    return { kind: "ranked", version: 1, density, estimatedTimeS: expanded.totalTimeS };
  } catch (error) {
    return unavailable((error instanceof Error ? error.message : String(error)) || "Provisional timing could not be estimated.");
  }
}
