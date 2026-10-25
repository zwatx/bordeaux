import type { RobotConfig } from "../../src/shared/types";

/** Synthetic drivetrain evidence, never a claim about the team's robot. */
export function forceExportRobot(): RobotConfig {
  return {
    drive: "swerve", w: 0.84, l: 0.84, heightM: 0.5, maxSpeed: 5,
    driveModel: {
      motorId: "test-force-export", motorFreeRpm: 6000, motorMaxTorqueNm: 4, motorCount: 4,
      gearRatio: 6.75, wheelDiameterM: 0.1016, massKg: 50, moiKgM2: 5,
      wheelbaseM: 0.6, trackwidthM: 0.6, wheelFrictionCoefficient: 1.2,
    },
  };
}
