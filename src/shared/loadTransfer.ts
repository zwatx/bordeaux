import type { RobotConfig } from "./types";

export const GRAVITY_MPS2 = 9.80665;

/**
 * Provisional center-of-gravity height when a project does not set one.
 * This is a planning assumption, not a measurement of the user's robot.
 */
export const DRIVE_CG_HEIGHT_DEFAULT_M = 0.25;

const EPSILON = 1e-9;

type DriveModel = NonNullable<RobotConfig["driveModel"]>;

/** Effective CG height: the authored value, else the default. Zero disables load transfer. */
export function resolveCgHeightM(model: DriveModel | undefined): { value: number; defaulted: boolean } {
  const authored = model?.cgHeightM;
  if (typeof authored === "number" && Number.isFinite(authored) && authored >= 0) return { value: authored, defaulted: false };
  return { value: DRIVE_CG_HEIGHT_DEFAULT_M, defaulted: true };
}

export interface DriveContact {
  /** Robot frame, +x forward and +y left, from the chassis center (the CG). */
  x: number;
  y: number;
  label: string;
}

/** Wheel contacts in the planner's LF, RF, LB, RB order (tank: left, right). */
export function driveContacts(robot: RobotConfig): DriveContact[] {
  const wheelbase = robot.driveModel?.wheelbaseM;
  const trackwidth = robot.driveModel?.trackwidthM;
  if (!(trackwidth && trackwidth > 0)) return [];
  const halfTrack = trackwidth * 0.5;
  if (robot.drive === "tank") {
    return [
      { x: 0, y: halfTrack, label: "tank-left-wheel" },
      { x: 0, y: -halfTrack, label: "tank-right-wheel" },
    ];
  }
  if (!(wheelbase && wheelbase > 0)) return [];
  const halfWheelbase = wheelbase * 0.5;
  return [
    { x: halfWheelbase, y: halfTrack, label: "swerve-front-left-module" },
    { x: halfWheelbase, y: -halfTrack, label: "swerve-front-right-module" },
    { x: -halfWheelbase, y: halfTrack, label: "swerve-rear-left-module" },
    { x: -halfWheelbase, y: -halfTrack, label: "swerve-rear-right-module" },
  ];
}

/**
 * Normal load on each contact as an affine function of the robot-frame CG
 * acceleration: N_i = static_i + perAccelX_i * a_x + perAccelY_i * a_y (newtons).
 */
export interface ContactLoadModel {
  static: number[];
  perAccelX: number[];
  perAccelY: number[];
}

/**
 * Quasi-static rigid-chassis load transfer. The three equilibrium equations
 *   sum N_i = m g,   sum x_i N_i = -h m a_x,   sum y_i N_i = -h m a_y
 * do not determine four wheel loads. The split assumes equal vertical stiffness
 * at every contact on a rigid chassis, so loads are affine in the contact
 * position: N_i = c0 + c1 x_i + c2 y_i (the minimum-norm solution, with no
 * diagonal "warp" load). For a centered rectangle this is the usual
 * independent split: each wheel gains or loses m a_x h / (2 L) longitudinally
 * and m a_y h / (2 T) laterally. A direction the contacts cannot span (tank's
 * single row of side contacts) carries no transfer; its moment is taken by
 * the drivetrain structure. `active` limits the solve to wheels on the ground.
 */
export function contactLoadModel(
  contacts: readonly Pick<DriveContact, "x" | "y">[],
  massKg: number,
  cgHeightM: number,
  active: readonly boolean[] = contacts.map(() => true),
): ContactLoadModel {
  const count = contacts.length;
  const zeros = () => new Array<number>(count).fill(0);
  const result: ContactLoadModel = { static: zeros(), perAccelX: zeros(), perAccelY: zeros() };
  const indices = contacts.map((_contact, index) => index).filter((index) => active[index]);
  if (indices.length === 0 || !(massKg > 0)) return result;
  // Normal equations of N = A^T c with A rows [1], [x], [y]: M c = b.
  const basis = (index: number) => [1, contacts[index].x, contacts[index].y];
  const matrix = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const index of indices) {
    const row = basis(index);
    for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) matrix[i][j] += row[i] * row[j];
  }
  const solveFor = (rhs: number[]) => solveLinear3(matrix, rhs);
  const staticCoefficients = solveFor([massKg * GRAVITY_MPS2, 0, 0]);
  const xCoefficients = solveFor([0, -cgHeightM * massKg, 0]);
  const yCoefficients = solveFor([0, 0, -cgHeightM * massKg]);
  for (const index of indices) {
    const row = basis(index);
    const dot = (coefficients: number[]) => row[0] * coefficients[0] + row[1] * coefficients[1] + row[2] * coefficients[2];
    result.static[index] = dot(staticCoefficients);
    result.perAccelX[index] = dot(xCoefficients);
    result.perAccelY[index] = dot(yCoefficients);
  }
  return result;
}

const robotLoadModelCache = new Map<string, { contacts: DriveContact[]; loads: ContactLoadModel }>();

/**
 * Contacts and all-wheels-down load model for a robot. Planning asks for the
 * same model at every path point, so results are memoized by their inputs.
 */
export function robotLoadModel(robot: RobotConfig, massKg: number, cgHeightM: number): { contacts: DriveContact[]; loads: ContactLoadModel } {
  const key = `${robot.drive}|${robot.driveModel?.wheelbaseM}|${robot.driveModel?.trackwidthM}|${massKg}|${cgHeightM}`;
  let cached = robotLoadModelCache.get(key);
  if (!cached) {
    const contacts = driveContacts(robot);
    cached = { contacts, loads: contactLoadModel(contacts, massKg, cgHeightM) };
    if (robotLoadModelCache.size >= 64) robotLoadModelCache.clear();
    robotLoadModelCache.set(key, cached);
  }
  return cached;
}

// Gaussian elimination with a scale-aware pivot test. A direction with no
// support (zero pivot) gets a zero coefficient instead of a division by zero.
export function solveLinear3(matrix: readonly number[][], rhs: readonly number[]): number[] {
  const a = matrix.map((row, index) => [...row, rhs[index]]);
  const scale = Math.max(EPSILON, ...matrix.map((row, index) => Math.abs(row[index])));
  const pivotRows: number[] = [];
  const pivotColumns: number[] = [];
  let row = 0;
  for (let column = 0; column < 3 && row < 3; column += 1) {
    let best = row;
    for (let candidate = row + 1; candidate < 3; candidate += 1) {
      if (Math.abs(a[candidate][column]) > Math.abs(a[best][column])) best = candidate;
    }
    if (Math.abs(a[best][column]) <= scale * 1e-12) continue;
    [a[row], a[best]] = [a[best], a[row]];
    for (let other = 0; other < 3; other += 1) {
      if (other === row) continue;
      const factor = a[other][column] / a[row][column];
      if (factor === 0) continue;
      for (let k = column; k < 4; k += 1) a[other][k] -= factor * a[row][k];
    }
    pivotRows.push(row);
    pivotColumns.push(column);
    row += 1;
  }
  const solution = [0, 0, 0];
  pivotRows.forEach((pivotRow, index) => {
    const column = pivotColumns[index];
    solution[column] = a[pivotRow][3] / a[pivotRow][column];
  });
  return solution;
}

export interface ContactLoads {
  /** Normal force per contact, newtons, never negative. */
  normalN: number[];
  /** Contacts whose affine load went negative: the wheel lifts and carries nothing. */
  lifted: boolean[];
  /**
   * The remaining contacts cannot hold the moment either: the CG acceleration
   * puts the center of pressure outside their support. The robot is tipping.
   */
  tipping: boolean;
}

/**
 * Wheel loads for a robot-frame CG acceleration, with wheel lift. A wheel whose
 * load would be negative leaves the ground; the rest are re-solved without it,
 * so the remaining loads still balance weight and the transfer moment.
 */
export function contactLoads(
  contacts: readonly Pick<DriveContact, "x" | "y">[],
  massKg: number,
  cgHeightM: number,
  accelerationXMps2: number,
  accelerationYMps2: number,
): ContactLoads {
  const active = contacts.map(() => true);
  const evaluate = (model: ContactLoadModel) => contacts.map((_contact, index) => (
    active[index] ? model.static[index] + model.perAccelX[index] * accelerationXMps2 + model.perAccelY[index] * accelerationYMps2 : 0
  ));
  let loads = evaluate(contactLoadModel(contacts, massKg, cgHeightM, active));
  const tolerance = massKg * GRAVITY_MPS2 * 1e-12;
  for (let pass = 0; pass < contacts.length; pass += 1) {
    let lightest = -1;
    loads.forEach((load, index) => {
      if (active[index] && load < -tolerance && (lightest < 0 || load < loads[lightest])) lightest = index;
    });
    if (lightest < 0) break;
    active[lightest] = false;
    loads = evaluate(contactLoadModel(contacts, massKg, cgHeightM, active));
  }
  const normalN = loads.map((load, index) => active[index] ? Math.max(0, load) : 0);
  const lifted = active.map((value) => !value);
  const supported = normalN.reduce((sum, load) => sum + load, 0);
  const momentX = contacts.reduce((sum, contact, index) => sum + contact.x * normalN[index], 0);
  const momentY = contacts.reduce((sum, contact, index) => sum + contact.y * normalN[index], 0);
  const weight = massKg * GRAVITY_MPS2;
  const momentTolerance = Math.max(1e-9, weight * 1e-6);
  // A row with no support in one direction (tank) never balances that moment by design.
  const spansX = contacts.some((contact) => Math.abs(contact.x) > EPSILON);
  const spansY = contacts.some((contact) => Math.abs(contact.y) > EPSILON);
  const tipping = Math.abs(supported - weight) > momentTolerance
    || (spansX && Math.abs(momentX + cgHeightM * massKg * accelerationXMps2) > momentTolerance)
    || (spansY && Math.abs(momentY + cgHeightM * massKg * accelerationYMps2) > momentTolerance);
  return { normalN, lifted, tipping };
}

/**
 * Largest CG acceleration magnitude a >= 0 along one robot-frame direction such
 * that the wheels can supply it: sum_i min(mu N_i(a), cap) >= m a, with every
 * N_i(a) = static_i + slope_i a >= 0 (no wheel lift). `capN` is the per-wheel
 * drive force limit (Infinity for friction alone). The supply is concave and
 * piecewise linear in a, so the root is found exactly between its breakpoints.
 */
export function directionalAccelerationLimit(
  staticN: readonly number[],
  slopeNPerMps2: readonly number[],
  frictionCoefficient: number,
  capN: number,
  massKg: number,
): number {
  if (!(massKg > 0) || !(frictionCoefficient > 0)) return 0;
  let liftLimit = Number.POSITIVE_INFINITY;
  staticN.forEach((load, index) => {
    if (slopeNPerMps2[index] < -EPSILON) liftLimit = Math.min(liftLimit, Math.max(0, load / -slopeNPerMps2[index]));
  });
  const surplus = (acceleration: number) => staticN.reduce((sum, load, index) => (
    sum + Math.min(frictionCoefficient * Math.max(0, load + slopeNPerMps2[index] * acceleration), capN)
  ), 0) - massKg * acceleration;
  const breakpoints = [0];
  staticN.forEach((load, index) => {
    const slope = slopeNPerMps2[index];
    if (Math.abs(slope) <= EPSILON || !Number.isFinite(capN)) return;
    const point = (capN / frictionCoefficient - load) / slope;
    if (point > 0 && point < liftLimit) breakpoints.push(point);
  });
  // Without lift or a cap, supply only grows to mu m g; it is reached by a = mu g * (1 + ...).
  const upper = Number.isFinite(liftLimit)
    ? liftLimit
    : Math.max(...breakpoints) + frictionCoefficient * GRAVITY_MPS2 * 2 + (Number.isFinite(capN) ? capN * staticN.length / massKg : 0);
  breakpoints.push(upper);
  breakpoints.sort((left, right) => left - right);
  if (surplus(0) <= 0) return 0;
  for (let index = 1; index < breakpoints.length; index += 1) {
    const low = breakpoints[index - 1];
    const high = breakpoints[index];
    const atHigh = surplus(high);
    if (atHigh >= 0) continue;
    const atLow = surplus(low);
    return low + (high - low) * atLow / (atLow - atHigh);
  }
  return upper;
}
