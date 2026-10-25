const EPSILON = 1e-9;
const CONTROLLABLE_TOLERANCE = 1e-9;

export type ReachabilityStatus = "optimal" | "invalid-input" | "infeasible";

/**
 * |(uX, uY) s'' + (xX, xY) s'^2| <= limit + limitU s'' + limitX s'^2.
 * The optional affine terms let a limit follow the state, such as friction on
 * a wheel load that shifts with acceleration; the set stays convex in s''.
 */
export interface AffineAccelerationConstraint {
  uX: number;
  uY: number;
  xX: number;
  xY: number;
  limit: number;
  limitU?: number;
  limitX?: number;
  /** See AffineScalarAccelerationConstraint.allocation. */
  allocation?: number;
  label?: string;
}

export interface AffineScalarAccelerationConstraint {
  u: number;
  x: number;
  minimum: number;
  maximum: number;
  label?: string;
  velocityCoefficient?: number;
  freeSpeed?: number;
  motorAcceleration?: number;
  /**
   * Apply the torque-speed line to motoring only (u*s'' + x*s'^2 >= 0). Braking
   * is not back-EMF limited, so it is bounded by `minimum` alone.
   */
  motoringOnly?: boolean;
  /**
   * Constraints sharing an allocation id describe one way to split the chassis
   * wrench across the wheels. Each allocation alone is sufficient, so the
   * feasible accelerations are the hull of the allocations' feasible sets
   * (sound because the true contact-force set is convex). Constraints without
   * an id apply to every allocation.
   */
  allocation?: number;
}

export interface ReachabilityInput {
  positions: readonly number[];
  velocityLimits: readonly number[];
  accelerationLimits: readonly number[];
  decelerationLimits: readonly number[];
  freeSpeeds: readonly number[];
  motorAccelerationLimits?: readonly number[];
  accelerationConstraints?: readonly (readonly AffineAccelerationConstraint[])[];
  scalarAccelerationConstraints?: readonly (readonly AffineScalarAccelerationConstraint[])[];
  startVelocity: number;
  goalVelocity: number;
}

export interface ReachabilityResult {
  status: ReachabilityStatus;
  velocities: number[];
  iterations: number;
  reason?: string;
  /** Soft solves only: where the returned profile exceeds a limit. */
  violations?: ReachabilityViolation[];
}

export type ReachabilityViolationKind =
  | "acceleration"
  | "deceleration"
  | "speed"
  | "speed-step"
  | "start-velocity"
  | "goal-velocity"
  | "stopped-interval";

/**
 * A contiguous run of intervals [startInterval, endInterval] whose soft profile
 * exceeds one limit family. Acceleration runs include adjacent intervals
 * moving in the same direction on the same binding constraint; measured/limit
 * describe the worst violating interval, rather than an endpoint average.
 * Units: m/s² for acceleration kinds, m/s for speed and boundary kinds.
 */
export interface ReachabilityViolation {
  kind: ReachabilityViolationKind;
  startInterval: number;
  endInterval: number;
  worstInterval: number;
  measured: number;
  limit: number;
  constraint?: string;
}

export interface ReachabilityOptions {
  /**
   * Never fail on infeasible limits: clamp to the least-infeasible speed at
   * each failing interval, continue, and report the violations. Results for
   * feasible inputs are identical to the strict solve.
   */
  soft?: boolean;
}

function invalid(reason: string): ReachabilityResult {
  return { status: "invalid-input", velocities: [], iterations: 0, reason };
}

function isFiniteNonnegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

type AccelerationInterval = { minimum: number; maximum: number };

const allocationIdCache = new WeakMap<readonly object[], readonly number[]>();

function allocationIds(constraints: readonly { allocation?: number }[]): readonly number[] {
  let ids = allocationIdCache.get(constraints);
  if (!ids) {
    const found = new Set<number>();
    for (const constraint of constraints) if (constraint.allocation !== undefined) found.add(constraint.allocation);
    ids = [...found].sort((left, right) => left - right);
    allocationIdCache.set(constraints, ids);
  }
  return ids;
}

/** Distinct allocation ids in either list; empty when every constraint is shared. */
function allocationGroups(
  constraints: readonly AffineAccelerationConstraint[],
  scalarConstraints: readonly AffineScalarAccelerationConstraint[],
): readonly number[] {
  const vector = allocationIds(constraints);
  const scalar = allocationIds(scalarConstraints);
  if (scalar.length === 0) return vector;
  if (vector.length === 0) return scalar;
  const cached = allocationUnionCache.get(constraints);
  if (cached && cached.scalarConstraints === scalarConstraints) return cached.groups;
  const groups = [...new Set([...vector, ...scalar])].sort((left, right) => left - right);
  allocationUnionCache.set(constraints, { scalarConstraints, groups });
  return groups;
}

const allocationUnionCache = new WeakMap<readonly object[], { scalarConstraints: readonly object[]; groups: readonly number[] }>();

const allocationViewCache = new WeakMap<readonly object[], Map<number, readonly object[]>>();

/** The constraints one allocation must satisfy: the shared ones plus its own, in input order. */
function constraintsFor<T extends { allocation?: number }>(constraints: readonly T[], allocation: number | undefined): readonly T[] {
  if (allocation === undefined) return constraints;
  let views = allocationViewCache.get(constraints);
  if (!views) {
    views = new Map();
    allocationViewCache.set(constraints, views);
  }
  let view = views.get(allocation) as readonly T[] | undefined;
  if (!view) {
    view = constraints.filter((constraint) => constraint.allocation === undefined || constraint.allocation === allocation);
    views.set(allocation, view);
  }
  return view;
}

/** Allocation id that matches only the shared constraints. */
const SHARED_ONLY = -1;

/**
 * Hull of the allocations' bounds. No allocation can exceed the shared
 * constraints' bounds, so the search stops once the hull reaches them.
 */
function hullOf(
  allocations: readonly number[],
  bounds: (allocation: number) => AccelerationInterval | null,
): AccelerationInterval | null {
  const outer = bounds(SHARED_ONLY);
  if (!outer) return null;
  const tolerance = (value: number) => 1e-12 * Math.max(1, Math.abs(value));
  let hull: AccelerationInterval | null = null;
  for (const allocation of allocations) {
    const candidate = bounds(allocation);
    if (!candidate) continue;
    hull = hull
      ? { minimum: Math.min(hull.minimum, candidate.minimum), maximum: Math.max(hull.maximum, candidate.maximum) }
      : candidate;
    if (hull.minimum <= outer.minimum + tolerance(outer.minimum)
      && hull.maximum >= outer.maximum - tolerance(outer.maximum)) break;
  }
  return hull;
}

export function accelerationBoundsForSpeedSquared(
  constraints: readonly AffineAccelerationConstraint[],
  speedSquared: number,
  scalarConstraints: readonly AffineScalarAccelerationConstraint[] = [],
  envelopeSpeedSquared = speedSquared,
): { minimum: number; maximum: number } | null {
  const groups = allocationGroups(constraints, scalarConstraints);
  if (groups.length === 0) return accelerationBounds(constraints, speedSquared, scalarConstraints, envelopeSpeedSquared, 0, true);
  return hullOf(groups, (allocation) => (
    accelerationBounds(constraints, speedSquared, scalarConstraints, envelopeSpeedSquared, 0, true, allocation)
  ));
}

/**
 * Accelerations a with |U a + X s| <= P + Q a, where U = u + x * ds is the
 * midpoint-substituted coefficient. The set is convex in a; squaring adds a
 * mirror branch with P + Q a < 0, which the half-line P + Q a >= 0 removes.
 */
function affineLimitBounds(
  uX: number,
  uY: number,
  xX: number,
  xY: number,
  speedSquared: number,
  limitBase: number,
  limitSlope: number,
): AccelerationInterval | null {
  let minimum = Number.NEGATIVE_INFINITY;
  let maximum = Number.POSITIVE_INFINITY;
  if (Math.abs(limitSlope) <= EPSILON) {
    if (limitBase < -EPSILON) return null;
  } else if (limitSlope > 0) minimum = -limitBase / limitSlope;
  else maximum = -limitBase / limitSlope;
  const forceSquared = uX ** 2 + uY ** 2;
  const a = forceSquared - limitSlope ** 2;
  const b = 2 * (speedSquared * (uX * xX + uY * xY) - limitBase * limitSlope);
  const c = speedSquared ** 2 * (xX ** 2 + xY ** 2) - limitBase ** 2;
  const scale = Math.max(1, forceSquared, limitSlope ** 2);
  if (Math.abs(a) <= EPSILON * scale) {
    if (Math.abs(b) <= EPSILON * scale) {
      if (c > EPSILON * scale) return null;
    } else if (b > 0) maximum = Math.min(maximum, -c / b);
    else minimum = Math.max(minimum, -c / b);
  } else {
    const discriminant = b ** 2 - 4 * a * c;
    if (a > 0) {
      if (discriminant < -EPSILON * scale ** 2) return null;
      const root = Math.sqrt(Math.max(0, discriminant));
      minimum = Math.max(minimum, (-b - root) / (2 * a));
      maximum = Math.min(maximum, (-b + root) / (2 * a));
    } else if (discriminant > 0) {
      // The limit grows faster than the force: a ray in the slope's direction.
      const root = Math.sqrt(discriminant);
      const first = (-b - root) / (2 * a);
      const second = (-b + root) / (2 * a);
      if (limitSlope > 0) minimum = Math.max(minimum, first, second);
      else maximum = Math.min(maximum, first, second);
    }
  }
  return minimum > maximum + EPSILON ? null : { minimum, maximum };
}

function accelerationBounds(
  constraints: readonly AffineAccelerationConstraint[],
  speedSquared: number,
  scalarConstraints: readonly AffineScalarAccelerationConstraint[],
  envelopeSpeedSquared: number,
  distance: number,
  applyMotorEnvelope: boolean,
  allocation?: number,
): { minimum: number; maximum: number } | null {
  let minimum = Number.NEGATIVE_INFINITY;
  let maximum = Number.POSITIVE_INFINITY;
  for (const constraint of constraintsFor(constraints, allocation)) {
    // x_mid = x_start + u * ds. Substitute in registers instead of
    // cloning every constraint for each reachability search probe.
    const uX = constraint.uX + constraint.xX * distance;
    const uY = constraint.uY + constraint.xY * distance;
    if (constraint.limitU !== undefined || constraint.limitX !== undefined) {
      const limitX = constraint.limitX ?? 0;
      const bounds = affineLimitBounds(
        uX, uY, constraint.xX, constraint.xY, speedSquared,
        constraint.limit + limitX * speedSquared,
        (constraint.limitU ?? 0) + limitX * distance,
      );
      if (!bounds) return null;
      minimum = Math.max(minimum, bounds.minimum);
      maximum = Math.min(maximum, bounds.maximum);
      if (minimum > maximum + EPSILON) return null;
      continue;
    }
    const a = uX ** 2 + uY ** 2;
    const b = 2 * speedSquared * (uX * constraint.xX + uY * constraint.xY);
    const c = speedSquared ** 2 * (constraint.xX ** 2 + constraint.xY ** 2) - constraint.limit ** 2;
    if (a <= EPSILON) {
      if (c > EPSILON) return null;
      continue;
    }
    const discriminant = b ** 2 - 4 * a * c;
    if (discriminant < -EPSILON) return null;
    const root = Math.sqrt(Math.max(0, discriminant));
    minimum = Math.max(minimum, (-b - root) / (2 * a));
    maximum = Math.min(maximum, (-b + root) / (2 * a));
    if (minimum > maximum + EPSILON) return null;
  }
  for (const constraint of constraintsFor(scalarConstraints, allocation)) {
    const offset = constraint.x * speedSquared;
    const moduleSpeed = (constraint.velocityCoefficient ?? 0) * Math.sqrt(Math.max(0, envelopeSpeedSquared));
    const motorLimit = applyMotorEnvelope && constraint.freeSpeed && constraint.motorAcceleration
      ? constraint.motorAcceleration * Math.max(0, 1 - moduleSpeed / constraint.freeSpeed)
      : Number.POSITIVE_INFINITY;
    const constraintMinimum = constraint.motoringOnly ? constraint.minimum : Math.max(constraint.minimum, -motorLimit);
    const constraintMaximum = Math.min(constraint.maximum, motorLimit);
    const u = constraint.u + constraint.x * distance;
    if (Math.abs(u) <= EPSILON) {
      if (offset < constraintMinimum - EPSILON || offset > constraintMaximum + EPSILON) return null;
      continue;
    }
    const first = (constraintMinimum - offset) / u;
    const second = (constraintMaximum - offset) / u;
    minimum = Math.max(minimum, Math.min(first, second));
    maximum = Math.min(maximum, Math.max(first, second));
    if (minimum > maximum + EPSILON) return null;
  }
  return { minimum, maximum };
}

function accelerationBoundsForInterval(
  constraints: readonly AffineAccelerationConstraint[],
  startSpeedSquared: number,
  distance: number,
  scalarConstraints: readonly AffineScalarAccelerationConstraint[] = [],
  envelopeSpeedSquared?: number,
  allocation?: number,
): { minimum: number; maximum: number } | null {
  if (distance <= EPSILON) {
    return accelerationBounds(constraints, startSpeedSquared, scalarConstraints, startSpeedSquared, 0, true, allocation);
  }
  return accelerationBounds(
    constraints, startSpeedSquared, scalarConstraints,
    envelopeSpeedSquared ?? startSpeedSquared, distance, envelopeSpeedSquared !== undefined, allocation,
  );
}

const dynamicConstraintCache = new WeakMap<readonly AffineScalarAccelerationConstraint[], readonly AffineScalarAccelerationConstraint[]>();

function tightenForModuleMotorEnvelope(
  constraints: readonly AffineScalarAccelerationConstraint[],
  startSpeedSquared: number,
  distance: number,
  bounds: ControllableInterval,
  allocation?: number,
): ControllableInterval | null {
  const view = constraintsFor(constraints, allocation);
  let dynamic = dynamicConstraintCache.get(view);
  if (!dynamic) {
    dynamic = view.filter((constraint) => (
      (constraint.velocityCoefficient ?? 0) > 0
      && (constraint.freeSpeed ?? 0) > 0
      && (constraint.motorAcceleration ?? 0) > 0
    ));
    dynamicConstraintCache.set(view, dynamic);
  }
  if (dynamic.length === 0) return bounds;

  const gap = (acceleration: number) => {
    const midpointSpeedSquared = Math.max(0, startSpeedSquared + acceleration * distance);
    const endSpeedSquared = Math.max(0, startSpeedSquared + 2 * acceleration * distance);
    const envelopeSpeed = Math.sqrt(Math.max(startSpeedSquared, endSpeedSquared));
    return dynamic.reduce((maximum, constraint) => {
      const moduleSpeed = constraint.velocityCoefficient! * envelopeSpeed;
      const limit = constraint.motorAcceleration!
        * Math.max(0, 1 - moduleSpeed / constraint.freeSpeed!);
      const force = constraint.u * acceleration + constraint.x * midpointSpeedSquared;
      const measured = constraint.motoringOnly ? force : Math.abs(force);
      return Math.max(maximum, measured - limit);
    }, Number.NEGATIVE_INFINITY);
  };
  const tolerance = 1e-9 * Math.max(1, ...dynamic.map((constraint) => constraint.motorAcceleration!));
  const roots = (a: number, b: number, c: number): number[] => {
    if (Math.abs(a) <= EPSILON) return Math.abs(b) <= EPSILON ? [] : [-c / b];
    const discriminant = b ** 2 - 4 * a * c;
    if (discriminant < 0) return [];
    const root = Math.sqrt(Math.max(0, discriminant));
    return [(-b - root) / (2 * a), (-b + root) / (2 * a)];
  };
  const critical = [bounds.minimum, bounds.maximum, Math.max(bounds.minimum, Math.min(bounds.maximum, 0))];
  for (const constraint of dynamic) {
    const coefficient = constraint.u + constraint.x * distance;
    const offset = constraint.x * startSpeedSquared;
    const stallAtStart = constraint.motorAcceleration!
      * Math.max(0, 1 - constraint.velocityCoefficient! * Math.sqrt(startSpeedSquared) / constraint.freeSpeed!);
    if (Math.abs(coefficient) > EPSILON) {
      critical.push((-stallAtStart - offset) / coefficient, (stallAtStart - offset) / coefficient);
    }
    const quadratic = coefficient / (2 * distance);
    const constant = offset - quadratic * startSpeedSquared;
    const linear = constraint.motorAcceleration! * constraint.velocityCoefficient! / constraint.freeSpeed!;
    const freeSpeedAcceleration = (
      (constraint.freeSpeed! / constraint.velocityCoefficient!) ** 2 - startSpeedSquared
    ) / (2 * distance);
    critical.push(freeSpeedAcceleration);
    for (const velocity of [
      ...roots(quadratic, linear, constant - constraint.motorAcceleration!),
      ...roots(-quadratic, linear, -constant - constraint.motorAcceleration!),
    ]) {
      if (velocity >= 0) critical.push((velocity ** 2 - startSpeedSquared) / (2 * distance));
    }
  }
  const values = critical
    .filter((value) => Number.isFinite(value) && value >= bounds.minimum - EPSILON && value <= bounds.maximum + EPSILON)
    .map((value) => Math.max(bounds.minimum, Math.min(bounds.maximum, value)))
    .sort((left, right) => left - right)
    .filter((value, index, all) => index === 0 || Math.abs(value - all[index - 1]) > 1e-10);
  const segments: ControllableInterval[] = [];
  const addSegment = (minimum: number, maximum: number) => {
    const previous = segments.at(-1);
    if (previous && minimum <= previous.maximum + 1e-8) previous.maximum = Math.max(previous.maximum, maximum);
    else segments.push({ minimum, maximum });
  };
  values.forEach((value, index) => {
    if (gap(value) <= tolerance) addSegment(value, value);
    const next = values[index + 1];
    if (next !== undefined && gap((value + next) * 0.5) <= tolerance) addSegment(value, next);
  });
  if (segments.length === 0) return null;
  const selected = segments.find((segment) => segment.minimum <= 0 && segment.maximum >= 0)
    ?? segments.reduce((best, segment) => (
      segment.maximum - segment.minimum > best.maximum - best.minimum ? segment : best
    ));
  const center = (selected.minimum + selected.maximum) * 0.5;
  let minimum = selected.minimum;
  if (gap(minimum) > tolerance) {
    let infeasible = minimum;
    let feasible = center;
    for (let iteration = 0; iteration < 32; iteration += 1) {
      const candidate = (infeasible + feasible) * 0.5;
      if (gap(candidate) <= tolerance) feasible = candidate;
      else infeasible = candidate;
    }
    minimum = feasible;
  }
  let maximum = selected.maximum;
  if (gap(maximum) > tolerance) {
    let feasible = center;
    let infeasible = maximum;
    for (let iteration = 0; iteration < 32; iteration += 1) {
      const candidate = (feasible + infeasible) * 0.5;
      if (gap(candidate) <= tolerance) feasible = candidate;
      else infeasible = candidate;
    }
    maximum = feasible;
  }
  return { minimum, maximum };
}

interface ControllableInterval {
  minimum: number;
  maximum: number;
}

interface AffineBound {
  slope: number;
  intercept: number;
}

function linearControllablePredecessor(
  input: ReachabilityInput,
  index: number,
  pointLimit: number,
  next: ControllableInterval,
  distance: number,
): ControllableInterval | null {
  let minimum = 0;
  let maximum = pointLimit;
  const lower: AffineBound[] = [
    { slope: 0, intercept: -input.decelerationLimits[index] },
    { slope: -1 / (2 * distance), intercept: next.minimum / (2 * distance) },
  ];
  const upper: AffineBound[] = [
    { slope: 0, intercept: input.accelerationLimits[index] },
    { slope: -1 / (2 * distance), intercept: next.maximum / (2 * distance) },
  ];
  for (const constraint of input.scalarAccelerationConstraints?.[index] ?? []) {
    const coefficient = constraint.u + constraint.x * distance;
    if (Math.abs(coefficient) <= EPSILON) {
      if (Math.abs(constraint.x) <= EPSILON) {
        if (constraint.minimum > EPSILON || constraint.maximum < -EPSILON) return null;
      } else {
        const first = constraint.minimum / constraint.x;
        const second = constraint.maximum / constraint.x;
        minimum = Math.max(minimum, Math.min(first, second));
        maximum = Math.min(maximum, Math.max(first, second));
      }
      continue;
    }
    const slope = -constraint.x / coefficient;
    const first = constraint.minimum / coefficient;
    const second = constraint.maximum / coefficient;
    lower.push({ slope, intercept: Math.min(first, second) });
    upper.push({ slope, intercept: Math.max(first, second) });
  }
  for (const low of lower) {
    for (const high of upper) {
      const coefficient = low.slope - high.slope;
      const limit = high.intercept - low.intercept;
      if (Math.abs(coefficient) <= EPSILON) {
        if (limit < -EPSILON) return null;
      } else if (coefficient > 0) maximum = Math.min(maximum, limit / coefficient);
      else minimum = Math.max(minimum, limit / coefficient);
    }
  }
  minimum = Math.max(0, minimum);
  maximum = Math.min(pointLimit, maximum);
  return minimum <= maximum + EPSILON ? { minimum, maximum } : null;
}

function controlBoundsForInterval(
  input: ReachabilityInput,
  index: number,
  speedSquared: number,
  distance: number,
): ControllableInterval | null {
  const groups = allocationGroups(
    input.accelerationConstraints?.[index] ?? [],
    input.scalarAccelerationConstraints?.[index] ?? [],
  );
  const tighten = (bounds: ControllableInterval, allocation?: number) => tightenForModuleMotorEnvelope(
    input.scalarAccelerationConstraints?.[index] ?? [],
    speedSquared,
    distance,
    bounds,
    allocation,
  );
  if (groups.length === 0) {
    const bounds = untightenedControlBounds(input, index, speedSquared, distance);
    return bounds && tighten(bounds);
  }
  // Every allocation's bounds lie inside the shared constraints' bounds, and the
  // motor-envelope tightening only shrinks an interval, so an allocation whose
  // untightened bounds are already inside the hull cannot widen it.
  const outer = untightenedControlBounds(input, index, speedSquared, distance, SHARED_ONLY);
  if (!outer) return null;
  const tolerance = (value: number) => 1e-12 * Math.max(1, Math.abs(value));
  const candidates: { allocation: number; bounds: ControllableInterval }[] = [];
  for (const allocation of groups) {
    const bounds = untightenedControlBounds(input, index, speedSquared, distance, allocation);
    if (bounds) candidates.push({ allocation, bounds });
  }
  // Tighten the widest-reaching allocations first so the rest are usually pruned.
  candidates.sort((left, right) => (
    (right.bounds.maximum - right.bounds.minimum) - (left.bounds.maximum - left.bounds.minimum)
  ));
  let hull: ControllableInterval | null = null;
  for (const { allocation, bounds: untightened } of candidates) {
    if (hull && untightened.minimum >= hull.minimum && untightened.maximum <= hull.maximum) continue;
    const bounds = tighten(untightened, allocation);
    if (!bounds) continue;
    hull = hull
      ? { minimum: Math.min(hull.minimum, bounds.minimum), maximum: Math.max(hull.maximum, bounds.maximum) }
      : bounds;
    if (hull.minimum <= outer.minimum + tolerance(outer.minimum)
      && hull.maximum >= outer.maximum - tolerance(outer.maximum)) break;
  }
  return hull;
}

/** Drivetrain, linear and chassis motor bounds, before the per-module motor envelope. */
function untightenedControlBounds(
  input: ReachabilityInput,
  index: number,
  speedSquared: number,
  distance: number,
  allocation?: number,
): ControllableInterval | null {
  const drivetrain = accelerationBoundsForInterval(
    input.accelerationConstraints?.[index] ?? [],
    speedSquared,
    distance,
    input.scalarAccelerationConstraints?.[index] ?? [],
    undefined,
    allocation,
  );
  if (!drivetrain) return null;
  const minimum = Math.max(-input.decelerationLimits[index], drivetrain.minimum);
  let maximum = Math.min(input.accelerationLimits[index], drivetrain.maximum);
  if (maximum > 0 && input.freeSpeeds[index] < 1e8) {
    const freeSpeed = input.freeSpeeds[index];
    const motorAcceleration = input.motorAccelerationLimits?.[index] ?? input.accelerationLimits[index];
    const coefficient = 2 * distance * motorAcceleration / freeSpeed;
    const endVelocity = Math.max(0, (
      Math.sqrt(coefficient ** 2 + 4 * (speedSquared + 2 * distance * motorAcceleration)) - coefficient
    ) * 0.5);
    const motorLimitedAcceleration = distance > EPSILON
      ? (endVelocity ** 2 - speedSquared) / (2 * distance)
      : motorAcceleration * Math.max(0, 1 - Math.sqrt(Math.max(0, speedSquared)) / freeSpeed);
    maximum = Math.min(maximum, Math.max(0, motorLimitedAcceleration));
  }
  if (minimum > maximum + EPSILON) return null;
  return { minimum, maximum };
}

function controllablePredecessor(
  input: ReachabilityInput,
  index: number,
  pointLimit: number,
  next: ControllableInterval,
): ControllableInterval | null {
  const distance = input.positions[index + 1] - input.positions[index];
  if (distance <= EPSILON) {
    const minimum = Math.max(0, next.minimum);
    const maximum = Math.min(pointLimit, next.maximum);
    return minimum <= maximum + EPSILON ? { minimum, maximum } : null;
  }

  const accelerationConstraints = input.accelerationConstraints?.[index] ?? [];
  const hasModuleMotorEnvelope = (input.scalarAccelerationConstraints?.[index] ?? []).some((constraint) => (
    constraint.velocityCoefficient !== undefined
  ));
  const freeSpeed = input.freeSpeeds[index];
  const motorAcceleration = input.motorAccelerationLimits?.[index] ?? input.accelerationLimits[index];
  const motorLimitAtPointCap = freeSpeed >= 1e8
    ? Number.POSITIVE_INFINITY
    : motorAcceleration * Math.max(0, Math.min(1, 1 - Math.sqrt(Math.max(pointLimit, next.maximum)) / freeSpeed));
  if (accelerationConstraints.length === 0
    && !hasModuleMotorEnvelope
    && allocationIds(input.scalarAccelerationConstraints?.[index] ?? []).length === 0
    && motorLimitAtPointCap >= input.accelerationLimits[index] - EPSILON) {
    return linearControllablePredecessor(input, index, pointLimit, next, distance);
  }

  const transitionScale = 2 * distance;
  const controllableTolerance = CONTROLLABLE_TOLERANCE * Math.max(
    1,
    input.accelerationLimits[index],
    input.decelerationLimits[index],
    motorAcceleration,
    pointLimit / transitionScale,
    next.maximum / transitionScale,
  );
  const gap = (speedSquared: number): number => {
    const control = controlBoundsForInterval(input, index, speedSquared, distance);
    if (!control) return Number.POSITIVE_INFINITY;
    const minimum = Math.max(control.minimum, (next.minimum - speedSquared) / transitionScale);
    const maximum = Math.min(control.maximum, (next.maximum - speedSquared) / transitionScale);
    return minimum - maximum;
  };

  let left = 0;
  let right = pointLimit;
  for (let iteration = 0; iteration < 56; iteration += 1) {
    const first = (left * 2 + right) / 3;
    const second = (left + right * 2) / 3;
    if (gap(first) <= gap(second)) right = second;
    else left = first;
  }
  const candidates = [0, pointLimit, left, right, (left + right) * 0.5];
  const center = candidates.reduce((best, candidate) => gap(candidate) < gap(best) ? candidate : best, candidates[0]);
  const centerGap = gap(center);
  if (centerGap > controllableTolerance) return null;
  const boundaryTolerance = centerGap <= 0 ? 0 : controllableTolerance;

  let minimum = 0;
  if (gap(minimum) > boundaryTolerance) {
    let infeasible = minimum;
    let feasible = center;
    for (let iteration = 0; iteration < 56; iteration += 1) {
      const candidate = (infeasible + feasible) * 0.5;
      if (gap(candidate) <= boundaryTolerance) feasible = candidate;
      else infeasible = candidate;
    }
    minimum = feasible;
  }

  let maximum = pointLimit;
  if (gap(maximum) > boundaryTolerance) {
    let feasible = center;
    let infeasible = maximum;
    for (let iteration = 0; iteration < 56; iteration += 1) {
      const candidate = (feasible + infeasible) * 0.5;
      if (gap(candidate) <= boundaryTolerance) feasible = candidate;
      else infeasible = candidate;
    }
    maximum = feasible;
  }
  return { minimum: Math.max(0, minimum), maximum: Math.min(pointLimit, maximum) };
}

/**
 * Soft-solve replacement for an empty controllable predecessor: the single
 * speed² that minimizes the acceleration gap to the successor set.
 */
function leastInfeasiblePredecessor(
  input: ReachabilityInput,
  index: number,
  pointLimit: number,
  next: ControllableInterval,
): ControllableInterval {
  const hold = Math.min(pointLimit, Math.max(0, next.minimum));
  const distance = input.positions[index + 1] - input.positions[index];
  if (distance <= EPSILON) return { minimum: hold, maximum: hold };
  const transitionScale = 2 * distance;
  const gap = (speedSquared: number): number => {
    const control = controlBoundsForInterval(input, index, speedSquared, distance);
    if (!control) return Number.POSITIVE_INFINITY;
    const minimum = Math.max(control.minimum, (next.minimum - speedSquared) / transitionScale);
    const maximum = Math.min(control.maximum, (next.maximum - speedSquared) / transitionScale);
    return minimum - maximum;
  };
  let left = 0;
  let right = pointLimit;
  for (let iteration = 0; iteration < 56; iteration += 1) {
    const first = (left * 2 + right) / 3;
    const second = (left + right * 2) / 3;
    if (gap(first) <= gap(second)) right = second;
    else left = first;
  }
  const candidates = [0, pointLimit, left, right, (left + right) * 0.5];
  const center = candidates.reduce((best, candidate) => gap(candidate) < gap(best) ? candidate : best, candidates[0]);
  const value = Number.isFinite(gap(center)) ? center : hold;
  return { minimum: value, maximum: value };
}

/** Largest speed² at or below `speedSquared` with nonempty acceleration bounds. */
function controllableSpeedSquaredCeiling(
  input: ReachabilityInput,
  index: number,
  speedSquared: number,
  distance: number,
): number {
  if (controlBoundsForInterval(input, index, 0, distance) === null) return 0;
  let feasible = 0;
  let infeasible = speedSquared;
  for (let iteration = 0; iteration < 48; iteration += 1) {
    const candidate = (feasible + infeasible) * 0.5;
    if (controlBoundsForInterval(input, index, candidate, distance)) feasible = candidate;
    else infeasible = candidate;
  }
  return feasible;
}

/** The acceleration constraint whose own bound is tightest in one direction. */
function bindingConstraintLabel(
  input: ReachabilityInput,
  index: number,
  speedSquared: number,
  distance: number,
  direction: "acceleration" | "deceleration" | "speed",
): string {
  const candidates: { label: string; bound: number }[] = direction === "deceleration"
    ? [{ label: "linear-deceleration", bound: -input.decelerationLimits[index] }]
    : [{ label: "linear-acceleration", bound: input.accelerationLimits[index] }];
  const freeSpeed = input.freeSpeeds[index];
  if (direction !== "deceleration" && freeSpeed < 1e8 && distance > EPSILON) {
    const motorAcceleration = input.motorAccelerationLimits?.[index] ?? input.accelerationLimits[index];
    const coefficient = 2 * distance * motorAcceleration / freeSpeed;
    const endVelocity = Math.max(0, (
      Math.sqrt(coefficient ** 2 + 4 * (speedSquared + 2 * distance * motorAcceleration)) - coefficient
    ) * 0.5);
    candidates.push({ label: "motor-acceleration", bound: Math.max(0, (endVelocity ** 2 - speedSquared) / (2 * distance)) });
  }
  const constraintBounds = [
    ...(input.accelerationConstraints?.[index] ?? []).map((constraint) => ({
      label: constraint.label ?? "drivetrain",
      bounds: accelerationBoundsForInterval([constraint], speedSquared, distance, [], undefined, constraint.allocation),
    })),
    ...(input.scalarAccelerationConstraints?.[index] ?? []).map((constraint) => ({
      label: constraint.label ?? "drivetrain",
      bounds: accelerationBoundsForInterval([], speedSquared, distance, [constraint], undefined, constraint.allocation),
    })),
  ];
  const empty = constraintBounds.find((entry) => entry.bounds === null);
  if (empty) return empty.label;
  for (const entry of constraintBounds) {
    candidates.push({
      label: entry.label,
      bound: direction === "deceleration" ? entry.bounds!.minimum : entry.bounds!.maximum,
    });
  }
  // Prefer the authored linear limit unless another is materially tighter.
  const margin = (bound: number) => Math.max(EPSILON, Math.abs(bound) * 0.05);
  return candidates.reduce((best, candidate) => (
    direction === "deceleration"
      ? candidate.bound > best.bound + margin(best.bound) ? candidate : best
      : candidate.bound < best.bound - margin(best.bound) ? candidate : best
  ), candidates[0]).label;
}

interface SoftIntervalRecord {
  kind: ReachabilityViolationKind;
  interval: number;
  measured: number;
  limit: number;
  constraint?: string;
}

/**
 * Groups soft-solve records into maneuvers. An acceleration violation is
 * extended over neighboring intervals that ride the same limit, and the
 * reported value remains the actual overload at the worst interval.
 */
function summarizeSoftViolations(
  input: ReachabilityInput,
  speedSquared: readonly number[],
  bounds: readonly (ControllableInterval | null)[],
  records: readonly SoftIntervalRecord[],
): ReachabilityViolation[] {
  const accelerationAt = (index: number) => {
    const distance = input.positions[index + 1] - input.positions[index];
    return distance > EPSILON ? (speedSquared[index + 1] - speedSquared[index]) / (2 * distance) : 0;
  };
  const saturated = (index: number, kind: "acceleration" | "deceleration", constraint: string | undefined) => {
    const bound = bounds[index];
    if (!bound || input.positions[index + 1] - input.positions[index] <= EPSILON) return false;
    const limit = kind === "acceleration" ? bound.maximum : bound.minimum;
    const tolerance = Math.max(1e-6, Math.abs(limit) * 5e-3);
    const acceleration = accelerationAt(index);
    const sameDirection = kind === "acceleration"
      ? acceleration > 0 && limit > 0 && acceleration >= limit - tolerance
      : acceleration < 0 && limit < 0 && acceleration <= limit + tolerance;
    return sameDirection && bindingConstraintLabel(
      input, index, speedSquared[index], input.positions[index + 1] - input.positions[index], kind,
    ) === constraint;
  };
  const sorted = [...records].sort((left, right) => left.interval - right.interval);
  const violations: ReachabilityViolation[] = [];
  for (const record of sorted) {
    let startInterval = record.interval;
    let endInterval = record.interval;
    if (record.kind === "acceleration" || record.kind === "deceleration") {
      while (startInterval > 0 && saturated(startInterval - 1, record.kind, record.constraint)) startInterval -= 1;
      while (endInterval < bounds.length - 1 && saturated(endInterval + 1, record.kind, record.constraint)) endInterval += 1;
    }
    const previous = violations.at(-1);
    if (previous && previous.kind === record.kind && previous.constraint === record.constraint && startInterval <= previous.endInterval + 1) {
      previous.endInterval = Math.max(previous.endInterval, endInterval);
      if (record.measured - record.limit > previous.measured - previous.limit) {
        previous.worstInterval = record.interval;
        previous.measured = record.measured;
        previous.limit = record.limit;
        previous.constraint = record.constraint;
      }
      continue;
    }
    const { interval, ...values } = record;
    violations.push({ ...values, startInterval, endInterval, worstInterval: interval });
  }
  return violations;
}

/**
 * Computes the fastest controllable scalar speed profile over a fixed path.
 * The backward pass finds the maximum speed that can still reach the authored
 * goal; the forward pass takes the greatest acceleration-safe speed inside
 * that controllable envelope.
 *
 * With `soft`, infeasible limits do not fail the solve: each failing interval
 * is clamped to its least-infeasible speed and reported in `violations`.
 * Malformed input (counts, non-finite values) is still `invalid-input`.
 */
export function solveReachabilityProfile(
  input: ReachabilityInput,
  options: ReachabilityOptions = {},
): ReachabilityResult {
  const soft = options.soft === true;
  const softRecords: SoftIntervalRecord[] = [];
  const count = input.positions.length;
  if (count < 2) return invalid("Reachability optimization requires at least two path samples.");
  if (input.velocityLimits.length !== count) return invalid("Velocity limit count must match path sample count.");
  if (input.accelerationLimits.length !== count - 1
    || input.decelerationLimits.length !== count - 1
    || input.freeSpeeds.length !== count - 1) {
    return invalid("Interval limit counts must be one less than the path sample count.");
  }
  if (input.accelerationConstraints && input.accelerationConstraints.length !== count - 1) {
    return invalid("Acceleration constraint count must be one less than the path sample count.");
  }
  if (input.scalarAccelerationConstraints && input.scalarAccelerationConstraints.length !== count - 1) {
    return invalid("Scalar acceleration constraint count must be one less than the path sample count.");
  }
  if (input.motorAccelerationLimits && input.motorAccelerationLimits.length !== count - 1) {
    return invalid("Motor acceleration limit count must be one less than the path sample count.");
  }
  if (!isFiniteNonnegative(input.startVelocity) || !isFiniteNonnegative(input.goalVelocity)) {
    return invalid("Boundary velocities must be finite and nonnegative.");
  }

  for (let index = 0; index < count; index += 1) {
    if (!Number.isFinite(input.positions[index])) return invalid(`Path position ${index} must be finite.`);
    if (index > 0 && input.positions[index] < input.positions[index - 1] - EPSILON) {
      return invalid("Path positions must be monotonic.");
    }
    if (!isFiniteNonnegative(input.velocityLimits[index])) return invalid(`Velocity limit ${index} must be finite and nonnegative.`);
  }
  for (let index = 0; index < count - 1; index += 1) {
    if (!(input.accelerationLimits[index] > 0) || !Number.isFinite(input.accelerationLimits[index])) {
      return invalid(`Acceleration limit ${index} must be finite and positive.`);
    }
    if (!(input.decelerationLimits[index] > 0) || !Number.isFinite(input.decelerationLimits[index])) {
      return invalid(`Deceleration limit ${index} must be finite and positive.`);
    }
    if (!(input.freeSpeeds[index] > 0) || !Number.isFinite(input.freeSpeeds[index])) {
      return invalid(`Free speed ${index} must be finite and positive.`);
    }
    if (input.motorAccelerationLimits
      && (!(input.motorAccelerationLimits[index] > 0) || !Number.isFinite(input.motorAccelerationLimits[index]))) {
      return invalid(`Motor acceleration limit ${index} must be finite and positive.`);
    }
    for (const constraint of input.accelerationConstraints?.[index] ?? []) {
      if (![constraint.uX, constraint.uY, constraint.xX, constraint.xY, constraint.limitU ?? 0, constraint.limitX ?? 0].every(Number.isFinite)
        || !(constraint.limit > 0) || !Number.isFinite(constraint.limit)) {
        return invalid(`Affine acceleration constraint ${index} must contain finite coefficients and a positive limit.`);
      }
    }
    for (const constraint of input.scalarAccelerationConstraints?.[index] ?? []) {
      if (![constraint.u, constraint.x, constraint.minimum, constraint.maximum].every(Number.isFinite)
        || constraint.minimum > constraint.maximum) {
        return invalid(`Scalar acceleration constraint ${index} must contain finite coefficients and ordered bounds.`);
      }
      const hasMotorEnvelope = constraint.velocityCoefficient !== undefined
        || constraint.freeSpeed !== undefined
        || constraint.motorAcceleration !== undefined;
      if (hasMotorEnvelope
        && (!(constraint.velocityCoefficient! >= 0) || !Number.isFinite(constraint.velocityCoefficient)
          || !(constraint.freeSpeed! > 0) || !Number.isFinite(constraint.freeSpeed)
          || !(constraint.motorAcceleration! > 0) || !Number.isFinite(constraint.motorAcceleration))) {
        return invalid(`Scalar acceleration constraint ${index} must contain a complete positive motor envelope.`);
      }
    }
  }

  const velocitySquaredLimits = input.velocityLimits.map((velocity) => velocity ** 2);
  let startSquared = input.startVelocity ** 2;
  let goalSquared = input.goalVelocity ** 2;
  // Soft mode must never turn finite authored values into an infinite profile.
  // Preserve the strict solver's existing numeric contract.
  if (soft && (![startSquared, goalSquared, ...velocitySquaredLimits].every(Number.isFinite)
    || input.positions.some((position, index) => index > 0 && !Number.isFinite(position - input.positions[index - 1])))) {
    return invalid("Soft reachability arithmetic exceeds the finite numeric range.");
  }
  const boundaryTolerance = 1e-8;
  if (startSquared > velocitySquaredLimits[0] + boundaryTolerance) {
    if (!soft) return invalid("Start velocity exceeds the local velocity limit.");
    softRecords.push({ kind: "start-velocity", interval: 0, measured: input.startVelocity, limit: input.velocityLimits[0] });
    startSquared = velocitySquaredLimits[0];
  }
  if (goalSquared > velocitySquaredLimits[count - 1] + boundaryTolerance) {
    if (!soft) return invalid("Goal velocity exceeds the local velocity limit.");
    softRecords.push({ kind: "goal-velocity", interval: count - 2, measured: input.goalVelocity, limit: input.velocityLimits[count - 1] });
    goalSquared = velocitySquaredLimits[count - 1];
  }

  const controllable = new Array<ControllableInterval>(count);
  controllable[count - 1] = { minimum: goalSquared, maximum: goalSquared };
  for (let index = count - 2; index >= 0; index -= 1) {
    const predecessor = controllablePredecessor(
      input,
      index,
      velocitySquaredLimits[index],
      controllable[index + 1],
    );
    if (!predecessor) {
      if (!soft) {
        return { status: "infeasible", velocities: [], iterations: count - 1, reason: `Drivetrain acceleration bounds are empty at interval ${index}.` };
      }
      // The forward pass measures and records the resulting violation.
      controllable[index] = leastInfeasiblePredecessor(input, index, velocitySquaredLimits[index], controllable[index + 1]);
      continue;
    }
    controllable[index] = predecessor;
  }
  // Soft solves keep the authored start and record the forward-pass violation.
  if (!soft && startSquared < controllable[0].minimum - boundaryTolerance) {
    return { status: "infeasible", velocities: [], iterations: count - 1, reason: "Goal velocity is unreachable from the authored start velocity and stops." };
  }
  if (!soft && startSquared > controllable[0].maximum + boundaryTolerance) {
    return { status: "infeasible", velocities: [], iterations: count - 1, reason: "Start velocity cannot decelerate to the authored goal and stops." };
  }

  const speedSquared = new Array<number>(count).fill(0);
  const softBounds: (ControllableInterval | null)[] = soft ? new Array(count - 1).fill(null) : [];
  const clampToControllable = (value: number, index: number) => Math.max(
    controllable[index].minimum,
    Math.min(controllable[index].maximum, value),
  );
  speedSquared[0] = startSquared;
  for (let index = 0; index < count - 1; index += 1) {
    const distance = Math.max(0, input.positions[index + 1] - input.positions[index]);
    if (distance <= EPSILON) {
      if (speedSquared[index] < controllable[index + 1].minimum - boundaryTolerance
        || speedSquared[index] > controllable[index + 1].maximum + boundaryTolerance) {
        if (!soft) {
          return { status: "infeasible", velocities: [], iterations: count - 1 + index, reason: `Zero-distance interval ${index} requires incompatible velocities.` };
        }
        speedSquared[index + 1] = clampToControllable(speedSquared[index], index + 1);
        softRecords.push({
          kind: "speed-step",
          interval: index,
          measured: Math.abs(Math.sqrt(speedSquared[index + 1]) - Math.sqrt(speedSquared[index])),
          limit: 0,
        });
        continue;
      }
      speedSquared[index + 1] = speedSquared[index];
      continue;
    }
    const control = controlBoundsForInterval(input, index, speedSquared[index], distance);
    if (!control) {
      if (!soft) {
        return { status: "infeasible", velocities: [], iterations: count - 1 + index, reason: `Drivetrain acceleration bounds are empty at interval ${index}.` };
      }
      softRecords.push({
        kind: "speed",
        interval: index,
        measured: Math.sqrt(speedSquared[index]),
        limit: Math.sqrt(controllableSpeedSquaredCeiling(input, index, speedSquared[index], distance)),
        constraint: bindingConstraintLabel(input, index, speedSquared[index], distance, "speed"),
      });
      speedSquared[index + 1] = clampToControllable(speedSquared[index], index + 1);
      continue;
    }
    if (soft) softBounds[index] = control;
    const reachableMinimum = speedSquared[index] + 2 * control.minimum * distance;
    const reachableMaximum = speedSquared[index] + 2 * control.maximum * distance;
    const nextMinimum = Math.max(controllable[index + 1].minimum, reachableMinimum, 0);
    const nextMaximum = Math.min(controllable[index + 1].maximum, reachableMaximum, velocitySquaredLimits[index + 1]);
    if (nextMinimum > nextMaximum + 1e-7) {
      if (!soft) {
        return { status: "infeasible", velocities: [], iterations: count - 1 + index, reason: `Velocity caps require impossible acceleration at interval ${index}: ${nextMinimum} exceeds ${nextMaximum}.` };
      }
      // Enter the controllable set at its nearest edge; the overshoot is the violation.
      const targetMaximum = Math.min(controllable[index + 1].maximum, velocitySquaredLimits[index + 1]);
      const targetMinimum = Math.min(targetMaximum, Math.max(controllable[index + 1].minimum, 0));
      const accelerating = reachableMaximum < targetMinimum;
      speedSquared[index + 1] = accelerating ? targetMinimum : targetMaximum;
      const required = (speedSquared[index + 1] - speedSquared[index]) / (2 * distance);
      softRecords.push({
        kind: accelerating ? "acceleration" : "deceleration",
        interval: index,
        measured: Math.abs(required),
        limit: Math.abs(accelerating ? control.maximum : control.minimum),
        constraint: bindingConstraintLabel(
          input,
          index,
          speedSquared[index],
          distance,
          accelerating ? "acceleration" : "deceleration",
        ),
      });
      continue;
    }
    speedSquared[index + 1] = nextMaximum;
  }
  if (!soft && Math.abs(speedSquared[count - 1] - goalSquared) > boundaryTolerance) {
    return { status: "infeasible", velocities: [], iterations: (count - 1) * 2, reason: "Goal velocity is unreachable from the authored start velocity and stops." };
  }
  speedSquared[count - 1] = goalSquared;

  for (let index = 0; index < count - 1; index += 1) {
    const distance = input.positions[index + 1] - input.positions[index];
    if (distance > EPSILON && speedSquared[index] + speedSquared[index + 1] <= EPSILON) {
      if (soft) {
        softRecords.push({ kind: "stopped-interval", interval: index, measured: 0, limit: 0 });
        continue;
      }
      return {
        status: "invalid-input",
        velocities: [],
        iterations: (count - 1) * 2,
        reason: `Path interval ${index} must include a moving sample between stopped boundaries.`,
      };
    }
  }

  const velocities = speedSquared.map((value) => Math.sqrt(Math.max(0, value)));
  if (soft) {
    if (!speedSquared.every(Number.isFinite) || !velocities.every(Number.isFinite)) {
      return invalid("Soft reachability arithmetic exceeds the finite numeric range.");
    }
    const violations = summarizeSoftViolations(input, speedSquared, softBounds, softRecords);
    if (!violations.every((violation) => Number.isFinite(violation.measured) && Number.isFinite(violation.limit))) {
      return invalid("Soft reachability diagnostics exceed the finite numeric range.");
    }
    return {
      status: violations.length > 0 ? "infeasible" : "optimal",
      velocities,
      iterations: (count - 1) * 2,
      ...(violations.length > 0 ? { reason: "Soft reachability exceeded one or more limits." } : {}),
      violations,
    };
  }
  return {
    status: "optimal",
    velocities,
    iterations: (count - 1) * 2,
  };
}
