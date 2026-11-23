import type { PlannerInput, PlannerResult, TrajectoryPlanner, TrajectoryPlannerId } from "../types";
import {
  optimizedTrajectoryPlanner,
  retimeTrajectoryWithVelocityLimits,
  scaleTrajectoryTiming,
} from "./optimizedTrajectory";
import { profiledSplinePlanner } from "./profiledSpline";
import { addJerkDiagnostics } from "./jerkDiagnostics";
import { addAngularLimitDiagnostics } from "./angularConstraints";
import { applyStationaryActions } from "./stationaryActions";
import { applyRotationPriority, headingTransitionIntervalMask } from "./rotationPriority";
import { physicalPlannerInput, electricalConfigurationError } from "../robotLimits";
import { validateOptimizedTrajectory } from "./trajectoryValidation";
import { DEFAULT_SAMPLES_PER_SEGMENT } from "./limits";

const EPSILON = 1e-9;

function withoutLegacyTimingPriority(path: PlannerInput["path"]): PlannerInput["path"] {
  const hasLegacyPriority = path.waypoints.some((waypoint) => waypoint.headingTransition !== undefined)
    || path.ranges.some((range) => range.rotationPriority !== undefined);
  if (!hasLegacyPriority) return path;
  return {
    ...path,
    waypoints: path.waypoints.map((waypoint) => {
      if (waypoint.headingTransition === undefined) return waypoint;
      const { headingTransition: _legacyTransition, ...rest } = waypoint;
      return rest;
    }),
    ranges: path.ranges.map((range) => {
      if (range.rotationPriority === undefined) return range;
      const { rotationPriority: _legacyPriority, ...rest } = range;
      return rest;
    }),
  };
}

function nearestFractionIndex(samples: PlannerResult["samples"], fraction: number): number {
  return samples.reduce((nearest, sample, index) => (
    Math.abs(sample.f - fraction) < Math.abs(samples[nearest].f - fraction) ? index : nearest
  ), 0);
}

function localVelocityLimitsForViolations(
  path: PlannerInput["path"],
  base: PlannerResult,
  checked: PlannerResult,
  validation: ReturnType<typeof validateOptimizedTrajectory>,
  rotationError?: boolean,
): number[] | null {
  const limits = base.samples.map((sample) => Math.abs(sample.velocityMps));
  let changed = false;
  for (const violation of validation.violations) {
    const sample = checked.samples[violation.sampleIndex];
    if (!sample || violation.measured <= violation.limit + EPSILON) continue;
    if (!["drivetrain-velocity", "drivetrain-acceleration", "electrical-power", "angular-velocity", "angular-acceleration"].includes(violation.kind)) continue;
    const center = nearestFractionIndex(base.samples, sample.f);
    const exponent = violation.kind === "angular-acceleration" ? 0.5 : 1;
    const safetyFactor = violation.kind === "angular-acceleration" ? 0.95 : 0.99;
    const ratio = Math.max(0.05, Math.min(0.99,
      (violation.limit / violation.measured) ** exponent * safetyFactor,
    ));
    const centerLimit = Math.abs(base.samples[center].velocityMps) * ratio;
    const radius = violation.kind === "drivetrain-acceleration" || violation.kind === "angular-acceleration" || violation.kind === "electrical-power"
      ? 8
      : 3;
    for (let offset = -radius; offset <= radius; offset += 1) {
      const index = center + offset;
      if (index <= 0 || index >= limits.length - 1) continue;
      const blend = Math.abs(offset) / (radius + 1);
      const localLimit = centerLimit
        + (Math.abs(base.samples[index].velocityMps) - centerLimit) * blend;
      if (localLimit < limits[index] - 1e-6) {
        limits[index] = Math.max(0, localLimit);
        changed = true;
      }
    }
  }
  if (rotationError) {
    const transitions = headingTransitionIntervalMask(path, base.samples, base.totalDistanceM);
    for (let index = 0; index < transitions.length; index += 1) {
      if (!transitions[index]) continue;
      for (const sampleIndex of [index, index + 1]) {
        if (sampleIndex <= 0 || sampleIndex >= limits.length - 1) continue;
        const recoveryLimit = Math.abs(base.samples[sampleIndex].velocityMps) * 0.9;
        if (recoveryLimit < limits[sampleIndex] - 1e-6) {
          limits[sampleIndex] = recoveryLimit;
          changed = true;
        }
      }
    }
  }
  return changed ? limits : null;
}

export function fixedPathSamples(result: PlannerResult) {
  let end = result.samples.length;
  while (end > 1
    && result.samples[end - 1].s - result.samples[end - 2].s <= EPSILON
    && result.samples[end - 1].t - result.samples[end - 2].t > EPSILON) {
    end -= 1;
  }
  return result.samples.slice(0, end);
}

export const planners: Record<TrajectoryPlannerId, TrajectoryPlanner> = {
  profiledSpline: profiledSplinePlanner,
  optimizedTrajectory: optimizedTrajectoryPlanner,
};

/**
 * Shared front end of fixed-path planning: drops legacy timing priority,
 * clamps limits to the robot's physical capability, and removes waits from
 * the moving solve (stationary actions re-insert them afterwards).
 */
export function canonicalPlanningInput(input: PlannerInput): {
  physicalInput: PlannerInput;
  planningInput: PlannerInput;
} {
  const canonicalPath = withoutLegacyTimingPriority(input.path);
  const physicalInput = physicalPlannerInput(canonicalPath === input.path ? input : { ...input, path: canonicalPath });
  const { path } = physicalInput;
  const hasStationaryPause = path.waypoints.some((waypoint) => waypoint.turnInPlace || (waypoint.wait ?? 0) > 0);
  const planningInput = hasStationaryPause
    ? {
        ...physicalInput,
        path: {
          ...path,
          waypoints: path.waypoints.map((waypoint) => (waypoint.wait ?? 0) > 0 ? { ...waypoint, wait: 0 } : waypoint),
        },
      }
    : physicalInput;
  return { physicalInput, planningInput };
}

export function getPlanner(id: TrajectoryPlannerId): TrajectoryPlanner {
  const planner = planners[id];
  return {
    id: planner.id,
    generate(input) {
      const electricalError = electricalConfigurationError(input.robot);
      if (electricalError) throw new Error(electricalError);
      const maxAngDecel = input.path.constraints.maxAngDecel;
      if (maxAngDecel !== undefined && !Number.isFinite(maxAngDecel)) throw new Error("maxAngDecel must be a finite number");
      if (maxAngDecel !== undefined && maxAngDecel <= 0) throw new Error("maxAngDecel must be greater than zero");
      const { physicalInput, planningInput } = canonicalPlanningInput(input);
      const { path, robot } = physicalInput;
      // Both planner families need the same physics-aware fixed-geometry timing.
      // The optimized family may subsequently improve the corridor, while the
      // profiled family stops here. The legacy spline timing is still used as
      // the reachability seed inside optimizedTrajectoryPlanner.
      const generated = planner.id === "profiledSpline"
        ? {
            ...optimizedTrajectoryPlanner.generate(planningInput),
            planner: "profiledSpline" as const,
          }
        : planner.generate(planningInput);
      let rotated = applyRotationPriority(path, generated, robot);
      let timingBase = generated;
      const validatesRotatedTrajectory = planner.id === "profiledSpline"
        || (rotated.optimization?.status === "optimal"
          || rotated.optimization?.status === "feasible"
          || rotated.optimization?.status === "equivalent");
      if (validatesRotatedTrajectory) {
        let validation = validateOptimizedTrajectory(planningInput, rotated.samples, {
          angularKinematics: "sample",
        });
        let rotationError = rotated.diagnostics.find((issue) => issue.severity === "error");
        for (let attempt = 0; attempt < 10 && (validation.violations.length > 0 || rotationError); attempt += 1) {
          const localLimits = localVelocityLimitsForViolations(
            path,
            timingBase,
            rotated,
            validation,
            Boolean(rotationError),
          );
          if (!localLimits) break;
          const retimed = retimeTrajectoryWithVelocityLimits(planningInput, timingBase, localLimits);
          if (!retimed) break;
          timingBase = retimed;
          rotated = applyRotationPriority(path, timingBase, robot);
          validation = validateOptimizedTrajectory(planningInput, rotated.samples, {
            angularKinematics: "sample",
          });
          rotationError = rotated.diagnostics.find((issue) => issue.severity === "error");
        }
        const permitsBoundedWholePathRecovery = (path.startVel ?? 0) > EPSILON
          || (path.goalVel ?? 0) > EPSILON
          || (path.constraints.maxAngJerk ?? 0) > 0;
        if (permitsBoundedWholePathRecovery && (validation.violations.length > 0 || rotationError)) {
          const minimumScale = (path.constraints.maxAngJerk ?? 0) > 0 ? 0.01 : 0.4;
          for (let timingScale = 0.9; timingScale >= minimumScale; timingScale *= 0.9) {
            const slowed = applyRotationPriority(path, scaleTrajectoryTiming(timingBase, timingScale), robot);
            const slowedValidation = validateOptimizedTrajectory(planningInput, slowed.samples, {
              angularKinematics: "sample",
            });
            const slowedRotationError = slowed.diagnostics.find((issue) => issue.severity === "error");
            if (slowedValidation.violations.length === 0 && !slowedRotationError) {
              rotated = slowed;
              validation = slowedValidation;
              rotationError = undefined;
              break;
            }
          }
        }
        const failureReason = rotationError?.message
          ?? (validation.violations.length > 0
            ? `Coupled trajectory validation found ${validation.violations.length} constraint violation${validation.violations.length === 1 ? "" : "s"}: ${validation.violations[0].message}`
            : undefined);
        if (planner.id === "profiledSpline") {
          if (failureReason) {
            rotated = {
              ...rotated,
              diagnostics: [...rotated.diagnostics, {
                severity: "error",
                path: `paths.${path.name}.planner`,
                message: failureReason,
              }],
            };
          }
          return addAngularLimitDiagnostics(path, addJerkDiagnostics(path, applyStationaryActions(path, rotated, robot)));
        }

        const optimization = rotated.optimization ?? generated.optimization!;
        if (validation.violations.length > 0 || rotationError) {
          const reason = failureReason!;
          const fallback = applyRotationPriority(path, profiledSplinePlanner.generate(planningInput), robot);
          rotated = {
            ...fallback,
            diagnostics: [...fallback.diagnostics, {
              severity: "warning",
              path: `paths.${path.name}.planner`,
              message: `Optimized trajectory fell back to profiled spline: ${reason}`,
            }],
            optimization: {
              ...optimization,
              plannerUsed: "profiledSpline",
              status: "internal-error",
              totalTimeS: fallback.totalTimeS,
              constraintViolations: validation.violations.length,
              fallback: true,
              fallbackReason: reason,
              validatedPoints: Math.max(optimization.validatedPoints ?? 0, validation.checkedPoints),
              activeConstraints: validation.activeConstraints,
            },
          };
        } else {
          rotated = {
            ...rotated,
            optimization: {
              ...optimization,
              status: optimization.status,
              constraintViolations: 0,
              validatedPoints: Math.max(optimization.validatedPoints ?? 0, validation.checkedPoints),
              activeConstraints: [...new Set([
                ...(optimization.activeConstraints ?? []),
                ...validation.activeConstraints,
              ])].sort(),
            },
          };
          if (!path.waypoints.some((waypoint) => waypoint.turnInPlace || waypoint.jiggle)) {
            const profiled = getPlanner("profiledSpline").generate({
              ...planningInput,
              samplesPerSegment: (planningInput.samplesPerSegment ?? DEFAULT_SAMPLES_PER_SEGMENT) * 2,
            });
            const profiledValidation = validateOptimizedTrajectory(
              input,
              fixedPathSamples(profiled),
              { angularKinematics: "sample" },
            );
            if (profiled.totalTimeS < rotated.totalTimeS - EPSILON
              && profiledValidation.violations.length === 0
              && !profiled.diagnostics.some((issue) => issue.severity === "error")) {
              rotated = {
                ...profiled,
                optimization: {
                  ...rotated.optimization!,
                  ...profiled.optimization,
                  // This candidate started at twice the caller's resolution.
                  refinementPasses: (profiled.optimization?.refinementPasses ?? 0) + 1,
                  plannerUsed: "profiledSpline",
                  status: "equivalent",
                  totalTimeS: profiled.totalTimeS,
                  maxVelocityMps: Math.max(...profiled.samples.map((sample) => Math.abs(sample.velocityMps))),
                  maxAccelerationMps2: Math.max(...profiled.samples.map((sample) => Math.abs(sample.accelerationMps2))),
                  constraintViolations: 0,
                  fallback: false,
                  fallbackReason: undefined,
                },
              };
            }
          }
        }
      }
      return addAngularLimitDiagnostics(path, addJerkDiagnostics(path, applyStationaryActions(path, rotated, robot)));
    },
  };
}
