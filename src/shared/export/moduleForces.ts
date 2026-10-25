import type { RobotConfig, TrajectorySample } from "../types";
import { robotHardLimits } from "../robotLimits";
import { evaluateDrivetrainForces } from "../planners/drivetrainProjection";

/** BDX wire order differs from the planner's LF/RF/LB/RB contact order. */
export type ModuleForcesN = [lf: number, lb: number, rf: number, rb: number];

/**
 * Feedforward for the final timestamped export, without retiming it. Linear and
 * angular acceleration are right-hand derivatives of stored velocities. The
 * terminal sample has no outgoing motion and carries zero force.
 */
export function buildModuleForces(
  robot: RobotConfig,
  samples: readonly TrajectorySample[],
  travelHeadings: readonly number[],
  signedCurvaturesInvM: readonly number[],
): ModuleForcesN[] {
  if (robot.drive !== "swerve" || !robotHardLimits(robot)) {
    throw new Error("BDX force export requires a complete, valid swerve drivetrain model (mass, moment of inertia, module geometry and drive limits). Configure the robot and re-export.");
  }
  if (samples.length < 2 || samples.length !== travelHeadings.length || samples.length !== signedCurvaturesInvM.length) throw new Error("BDX force samples/travel headings/curvatures are invalid");
  // Skip equal-time knots in linear time, using the same outgoing derivative for
  // equivalent duplicate samples. Never divide by a zero timestamp difference.
  const nextDistinct = new Array<number>(samples.length);
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    nextDistinct[index] = index + 1 < samples.length && samples[index + 1].t === samples[index].t
      ? nextDistinct[index + 1] : index + 1;
  }
  return samples.map((sample, index): ModuleForcesN => {
    const next = samples[nextDistinct[index]];
    if (!next) return [0, 0, 0, 0];
    const dt = next.t - sample.t;
    if (!(dt > 0 && Number.isFinite(dt))) throw new Error("BDX force sample time must increase");
    const tangentRad = travelHeadings[index];
    const tangentX = Math.cos(tangentRad), tangentY = Math.sin(tangentRad);
    const forces = evaluateDrivetrainForces({
      tangentX, tangentY, normalX: -tangentY, normalY: tangentX,
      // Legacy sample curvature is a magnitude. Use the canonical signed value
      // used by validation so clockwise curves exert force to the right.
      curvatureInvM: signedCurvaturesInvM[index], headingRad: sample.headingRad,
    }, robot, sample.velocityMps, (next.velocityMps - sample.velocityMps) / dt,
    sample.angularVelocityRadps, (next.angularVelocityRadps - sample.angularVelocityRadps) / dt);
    const byLabel = new Map(forces.map((force) => [force.label, force.rollingForceN]));
    const values: ModuleForcesN = [
      byLabel.get("swerve-front-left-module")!, byLabel.get("swerve-rear-left-module")!,
      byLabel.get("swerve-front-right-module")!, byLabel.get("swerve-rear-right-module")!,
    ];
    if (!values.every(Number.isFinite)) throw new Error("BDX module forces must be finite");
    return values;
  });
}
