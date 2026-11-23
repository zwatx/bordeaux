import type { PathDoc, PlannerResult, ValidationIssue } from "../types";

const EPSILON = 1e-9;
const RADIANS_TO_DEGREES = 180 / Math.PI;

export function addJerkDiagnostics(path: PathDoc, result: PlannerResult): PlannerResult {
  const linearLimit = path.constraints.maxJerk ?? 0;
  const angularLimit = (path.constraints.maxAngJerk ?? 0) / RADIANS_TO_DEGREES;
  if ((linearLimit <= 0 && angularLimit <= 0) || result.samples.length < 3) return result;

  let maxLinear = 0;
  let maxAngular = 0;
  let previousAngularAcceleration: number | undefined;
  let previousAngularIntervalS: number | undefined;
  for (let index = 1; index < result.samples.length; index += 1) {
    const sample = result.samples[index];
    const previous = result.samples[index - 1];
    const dt = sample.t - previous.t;
    if (dt <= EPSILON) {
      previousAngularAcceleration = undefined;
      previousAngularIntervalS = undefined;
      continue;
    }
    if (linearLimit > 0) {
      maxLinear = Math.max(maxLinear, Math.abs(sample.accelerationMps2 - previous.accelerationMps2) / dt);
    }
    if (angularLimit > 0) {
      const angularAcceleration = (sample.angularVelocityRadps - previous.angularVelocityRadps) / dt;
      if (previousAngularAcceleration !== undefined && previousAngularIntervalS !== undefined) {
        const accelerationSpacingS = (previousAngularIntervalS + dt) / 2;
        maxAngular = Math.max(
          maxAngular,
          Math.abs(angularAcceleration - previousAngularAcceleration) / accelerationSpacingS,
        );
      }
      previousAngularAcceleration = angularAcceleration;
      previousAngularIntervalS = dt;
    }
  }

  const diagnostics: ValidationIssue[] = [];
  if (linearLimit > 0 && maxLinear > linearLimit + EPSILON) {
    diagnostics.push({
      severity: "error",
      path: `paths.${path.name}.constraints.maxJerk`,
      message: `Linear jerk reaches ${maxLinear.toFixed(3)} m/s³, above the maxJerk limit of ${linearLimit.toFixed(3)} m/s³`,
    });
  }
  if (angularLimit > 0 && maxAngular > angularLimit + EPSILON) {
    diagnostics.push({
      severity: "error",
      path: `paths.${path.name}.constraints.maxAngJerk`,
      message: `Angular jerk reaches ${(maxAngular * RADIANS_TO_DEGREES).toFixed(3)} °/s³, above the maxAngJerk limit of ${(angularLimit * RADIANS_TO_DEGREES).toFixed(3)} °/s³`,
    });
  }
  if (diagnostics.length === 0) return result;
  return {
    ...result,
    diagnostics: [...result.diagnostics, ...diagnostics],
    optimization: result.optimization ? {
      ...result.optimization,
      constraintViolations: result.optimization.constraintViolations + diagnostics.length,
    } : result.optimization,
  };
}
