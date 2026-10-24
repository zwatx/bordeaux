export interface DriveMotorPreset {
  id: string;
  label: string;
  freeRpm: number;
  stallTorqueNm: number;
  stallCurrentA: number;
  freeCurrentA: number;
  /** Stator current limit the usual motor controller applies out of the box. */
  defaultCurrentLimitA: number;
}

// Manufacturer 12 V figures, checked 2026-10-24: REV NEO V1.1, NEO Vortex and NEO 550
// product documentation, WCP Kraken X60 and Kraken X44 motor performance tables
// (trapezoidal unless noted), and the CTRE/AndyMark Falcon 500 listing. CIM is from
// the 2021 LabVIEW motor-sim table.
// Default current limits: SPARK MAX/Flex Smart Current Limit defaults to 80 A (REV
// brushless FAQ); Phoenix 6 TalonFX StatorCurrentLimit defaults to 120 A, enabled
// (CurrentLimitsConfigs). A CIM has no smart limit, so its stall current is the cap.
export const DRIVE_MOTOR_PRESETS: readonly DriveMotorPreset[] = [
  { id: "rev-neo", label: "REV NEO V1.1", freeRpm: 5676, stallTorqueNm: 2.6, stallCurrentA: 105, freeCurrentA: 1.8, defaultCurrentLimitA: 80 },
  { id: "rev-vortex", label: "REV NEO Vortex", freeRpm: 6784, stallTorqueNm: 3.6, stallCurrentA: 211, freeCurrentA: 3.6, defaultCurrentLimitA: 80 },
  { id: "rev-neo-550", label: "REV NEO 550", freeRpm: 11000, stallTorqueNm: 0.97, stallCurrentA: 100, freeCurrentA: 1.4, defaultCurrentLimitA: 80 },
  { id: "ctre-kraken-x60", label: "CTRE Kraken X60", freeRpm: 6000, stallTorqueNm: 7.09, stallCurrentA: 366, freeCurrentA: 2, defaultCurrentLimitA: 120 },
  { id: "ctre-kraken-x60-foc", label: "CTRE Kraken X60 (FOC)", freeRpm: 5800, stallTorqueNm: 9.37, stallCurrentA: 483, freeCurrentA: 2, defaultCurrentLimitA: 120 },
  { id: "ctre-kraken-x44", label: "CTRE Kraken X44", freeRpm: 7758, stallTorqueNm: 4.11, stallCurrentA: 279, freeCurrentA: 3, defaultCurrentLimitA: 120 },
  { id: "ctre-falcon-500", label: "CTRE Falcon 500", freeRpm: 6380, stallTorqueNm: 4.69, stallCurrentA: 257, freeCurrentA: 1.5, defaultCurrentLimitA: 120 },
  { id: "cim", label: "CIM", freeRpm: 5330, stallTorqueNm: 2.41, stallCurrentA: 131, freeCurrentA: 2.7, defaultCurrentLimitA: 131 },
];

export function driveMotorPreset(id: string | undefined): DriveMotorPreset | undefined {
  return DRIVE_MOTOR_PRESETS.find((preset) => preset.id === id);
}
