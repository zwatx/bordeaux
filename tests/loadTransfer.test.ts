import { describe, expect, it } from "vitest";
import {
  contactLoadModel,
  contactLoads,
  directionalAccelerationLimit,
  driveContacts,
  DRIVE_CG_HEIGHT_DEFAULT_M,
  GRAVITY_MPS2,
  resolveCgHeightM,
} from "../src/shared/loadTransfer";
import { robotHardLimits } from "../src/shared/robotLimits";
import { createDemoProject } from "../src/shared/project/defaults";
import { validateProject } from "../src/shared/validation";
import type { RobotConfig } from "../src/shared/types";

const MASS_KG = 54;
const WHEELBASE_M = 0.57;
const TRACKWIDTH_M = 0.5;
const CG_M = 0.25;

function swerve(cgHeightM?: number): RobotConfig {
  return {
    drive: "swerve", w: 0.7, l: 0.7, maxSpeed: 5,
    driveModel: {
      motorId: "ctre-kraken-x60", motorFreeRpm: 6000, motorMaxTorqueNm: 7.09, motorCount: 4, gearRatio: 6.75,
      wheelDiameterM: 0.1016, massKg: MASS_KG, moiKgM2: 4.5, wheelbaseM: WHEELBASE_M, trackwidthM: TRACKWIDTH_M,
      wheelFrictionCoefficient: 1.2, ...(cgHeightM === undefined ? {} : { cgHeightM }),
    },
  };
}

const contacts = driveContacts(swerve());
const [FL, FR, RL, RR] = [0, 1, 2, 3];
const weight = MASS_KG * GRAVITY_MPS2;
const loadsAt = (ax: number, ay: number, cg = CG_M) => contactLoads(contacts, MASS_KG, cg, ax, ay);

describe("quasi-static load transfer", () => {
  it("splits the weight equally at rest and for any acceleration with zero CG height", () => {
    for (const load of loadsAt(0, 0).normalN) expect(load).toBeCloseTo(weight / 4, 9);
    for (const load of loadsAt(9, -4, 0).normalN) expect(load).toBeCloseTo(weight / 4, 9);
  });

  it("moves m a h / L from the front axle to the rear under forward acceleration", () => {
    const a = 6;
    const { normalN, lifted, tipping } = loadsAt(a, 0);
    const shift = MASS_KG * a * CG_M / WHEELBASE_M;
    expect(normalN[FL] + normalN[FR]).toBeCloseTo(weight / 2 - shift, 9);
    expect(normalN[RL] + normalN[RR]).toBeCloseTo(weight / 2 + shift, 9);
    expect(normalN[FL]).toBeCloseTo(normalN[FR], 9);
    expect(lifted).toEqual([false, false, false, false]);
    expect(tipping).toBe(false);
    // Braking (negative a) loads the front instead.
    const braking = loadsAt(-a, 0).normalN;
    expect(braking[FL] + braking[FR]).toBeCloseTo(weight / 2 + shift, 9);
  });

  it("moves m a h / T to the outside wheels under lateral acceleration and keeps equilibrium", () => {
    const a = 5; // +y is left: the robot accelerates left, so the right wheels are outside.
    const { normalN } = loadsAt(0, a);
    const shift = MASS_KG * a * CG_M / TRACKWIDTH_M;
    expect(normalN[FL] + normalN[RL]).toBeCloseTo(weight / 2 - shift, 9);
    expect(normalN[FR] + normalN[RR]).toBeCloseTo(weight / 2 + shift, 9);
    // Combined: every wheel carries the sum of independent axle and side transfers.
    const combined = loadsAt(4, a).normalN;
    expect(combined[FL]).toBeCloseTo(weight / 4 - MASS_KG * 4 * CG_M / (2 * WHEELBASE_M) - shift / 2, 9);
    const sum = combined.reduce((total, load) => total + load, 0);
    const pitch = combined.reduce((total, load, index) => total + contacts[index].x * load, 0);
    const roll = combined.reduce((total, load, index) => total + contacts[index].y * load, 0);
    expect(sum).toBeCloseTo(weight, 9);
    expect(pitch).toBeCloseTo(-CG_M * MASS_KG * 4, 9);
    expect(roll).toBeCloseTo(-CG_M * MASS_KG * a, 9);
  });

  it("clamps a lifted wheel at zero and re-solves the remaining wheels", () => {
    // Diagonal launch: the front-left load would be negative, but the CG force
    // stays inside the triangle of the other three wheels.
    const ax = 7, ay = 6;
    const affine = contactLoadModel(contacts, MASS_KG, CG_M);
    expect(affine.static[FL] + affine.perAccelX[FL] * ax + affine.perAccelY[FL] * ay).toBeLessThan(0);
    const { normalN, lifted, tipping } = loadsAt(ax, ay);
    expect(lifted).toEqual([true, false, false, false]);
    expect(normalN[FL]).toBe(0);
    expect(normalN.every((load) => load >= 0)).toBe(true);
    expect(tipping).toBe(false);
    expect(normalN.reduce((total, load) => total + load, 0)).toBeCloseTo(weight, 9);
    expect(normalN.reduce((total, load, index) => total + contacts[index].x * load, 0)).toBeCloseTo(-CG_M * MASS_KG * ax, 9);
    expect(normalN.reduce((total, load, index) => total + contacts[index].y * load, 0)).toBeCloseTo(-CG_M * MASS_KG * ay, 9);
  });

  it("reports tipping when the front axle lifts entirely", () => {
    const liftAcceleration = GRAVITY_MPS2 * WHEELBASE_M / (2 * CG_M);
    expect(loadsAt(liftAcceleration * 0.99, 0).lifted).toEqual([false, false, false, false]);
    const tipped = loadsAt(liftAcceleration * 1.2, 0);
    expect(tipped.lifted.slice(0, 2)).toEqual([true, true]);
    expect(tipped.normalN[FL] + tipped.normalN[FR]).toBe(0);
    expect(tipped.normalN.every(Number.isFinite)).toBe(true);
    expect(tipped.tipping).toBe(true);
  });

  it("transfers only side to side on a tank drive", () => {
    const tank = driveContacts({ ...swerve(), drive: "tank" });
    const forward = contactLoads(tank, MASS_KG, CG_M, 8, 0);
    expect(forward.normalN).toEqual([weight / 2, weight / 2].map((value) => expect.closeTo(value, 9)));
    expect(forward.tipping).toBe(false);
    const turning = contactLoads(tank, MASS_KG, CG_M, 0, 3).normalN;
    expect(turning[0]).toBeCloseTo(weight / 2 - MASS_KG * 3 * CG_M / TRACKWIDTH_M, 9);
  });
});

describe("directional acceleration limit", () => {
  const model = contactLoadModel(contacts, MASS_KG, CG_M);
  const mu = 1.2;

  it("is mu g with equal loads and no drive cap, and the drive cap when it binds", () => {
    const flat = contactLoadModel(contacts, MASS_KG, 0);
    expect(directionalAccelerationLimit(flat.static, flat.perAccelX, mu, Infinity, MASS_KG)).toBeCloseTo(mu * GRAVITY_MPS2, 9);
    const capN = 100;
    expect(directionalAccelerationLimit(flat.static, flat.perAccelX, mu, capN, MASS_KG)).toBeCloseTo(4 * capN / MASS_KG, 9);
  });

  it("stops at front wheel lift when friction alone would allow more", () => {
    const lift = GRAVITY_MPS2 * WHEELBASE_M / (2 * CG_M);
    const high = contactLoadModel(contacts, MASS_KG, 0.4);
    expect(directionalAccelerationLimit(high.static, high.perAccelX, mu, Infinity, MASS_KG))
      .toBeCloseTo(GRAVITY_MPS2 * WHEELBASE_M / (2 * 0.4), 9);
    expect(directionalAccelerationLimit(model.static, model.perAccelX, mu, Infinity, MASS_KG))
      .toBeCloseTo(Math.min(mu * GRAVITY_MPS2, lift), 9);
  });

  it("matches the closed form with the front wheels on friction and the rear wheels on the drive cap", () => {
    const capN = 160;
    // 2 mu (m g / 4 - m a h / (2 L)) + 2 cap = m a
    const expected = (2 * mu * weight / 4 + 2 * capN) / (MASS_KG * (1 + mu * CG_M / WHEELBASE_M));
    const actual = directionalAccelerationLimit(model.static, model.perAccelX, mu, capN, MASS_KG);
    expect(actual).toBeCloseTo(expected, 9);
    const front = mu * (weight / 4 - MASS_KG * actual * CG_M / (2 * WHEELBASE_M));
    expect(front).toBeLessThan(capN);
    expect(mu * (weight / 4 + MASS_KG * actual * CG_M / (2 * WHEELBASE_M))).toBeGreaterThan(capN);
  });
});

describe("drive-model CG height", () => {
  it("defaults when unset and keeps an authored value, including zero", () => {
    expect(resolveCgHeightM(swerve().driveModel)).toEqual({ value: DRIVE_CG_HEIGHT_DEFAULT_M, defaulted: true });
    expect(resolveCgHeightM(swerve(0.31).driveModel)).toEqual({ value: 0.31, defaulted: false });
    expect(resolveCgHeightM(swerve(0).driveModel)).toEqual({ value: 0, defaulted: false });
    expect(DRIVE_CG_HEIGHT_DEFAULT_M).toBe(0.25);
  });

  it("lowers launch, braking and cornering limits only through the CG height", () => {
    const flat = robotHardLimits(swerve(0))!;
    const defaulted = robotHardLimits(swerve())!;
    expect(flat.cgHeightM).toBe(0);
    expect(defaulted.cgHeightM).toBe(DRIVE_CG_HEIGHT_DEFAULT_M);
    expect(flat.maxAccelMps2).toBe(Math.min(flat.motorCapAccelMps2, flat.motorAccelMps2, flat.tractionAccelMps2));
    expect(flat.maxCornerAccelMps2).toBe(flat.tractionAccelMps2);
    expect(defaulted.maxAccelMps2).toBeLessThan(flat.maxAccelMps2 * 0.8);
    const brakeCapPerWheel = flat.brakingCapAccelMps2 * MASS_KG / 4;
    const expectedBraking = (1.2 * weight / 2 + 2 * brakeCapPerWheel)
      / (MASS_KG * (1 + 1.2 * DRIVE_CG_HEIGHT_DEFAULT_M / WHEELBASE_M));
    expect(defaulted.maxDecelMps2).toBeCloseTo(expectedBraking, 9);
    expect(defaulted.maxDecelMps2).toBeLessThan(flat.maxDecelMps2);
    // Along the better (0.57 m wheelbase) axis the inner wheels lift at g L / (2 h) before friction runs out.
    expect(defaulted.maxCornerAccelMps2).toBeCloseTo(GRAVITY_MPS2 * WHEELBASE_M / (2 * DRIVE_CG_HEIGHT_DEFAULT_M), 9);
    // Pure rotation does not accelerate the CG.
    expect(defaulted.maxAngularAccelDegps2).toBe(flat.maxAngularAccelDegps2);
    expect(defaulted.tractionAccelMps2).toBe(flat.tractionAccelMps2);
  });

  it("validates the CG height", () => {
    const project = createDemoProject();
    project.robot.driveModel = { ...swerve().driveModel!, cgHeightM: 0.25 };
    expect(validateProject(project).ok).toBe(true);
    for (const bad of [-0.1, 2.5, Number.NaN]) {
      project.robot.driveModel.cgHeightM = bad;
      const result = validateProject(project);
      expect(result.ok).toBe(false);
      expect(result.issues.some((issue) => issue.path.endsWith("cgHeightM"))).toBe(true);
    }
  });
});
