import { describe, expect, it } from "vitest";
import { solveReachabilityProfile, type ReachabilityInput } from "../src/shared/planners/reachability";

function input(overrides: Partial<ReachabilityInput> = {}): ReachabilityInput {
  return {
    positions: [0, 1, 2],
    velocityLimits: [10, 10, 10],
    accelerationLimits: [1, 1],
    decelerationLimits: [1, 1],
    freeSpeeds: [1e9, 1e9],
    startVelocity: 0,
    goalVelocity: 0,
    ...overrides,
  };
}

describe("fixed-path reachability", () => {
  it("builds the fastest profile inside the backward controllable envelope", () => {
    const result = solveReachabilityProfile(input());

    expect(result.status).toBe("optimal");
    expect(result.velocities).toHaveLength(3);
    expect(result.velocities[0]).toBe(0);
    expect(result.velocities[1]).toBeCloseTo(Math.sqrt(2), 12);
    expect(result.velocities[2]).toBe(0);
    expect(result.iterations).toBe(4);
  });

  it("treats authored interior stops as exact phase boundaries", () => {
    const result = solveReachabilityProfile(input({
      positions: [0, 1, 2, 3, 4],
      velocityLimits: [10, 10, 0, 10, 10],
      accelerationLimits: [1, 1, 1, 1],
      decelerationLimits: [1, 1, 1, 1],
      freeSpeeds: [1e9, 1e9, 1e9, 1e9],
    }));

    expect(result.status).toBe("optimal");
    expect(result.velocities).toEqual([0, Math.sqrt(2), 0, Math.sqrt(2), 0]);
  });

  it("applies the motor torque-speed envelope during forward reachability", () => {
    const result = solveReachabilityProfile(input({
      positions: [0, 1, 2],
      accelerationLimits: [2, 2],
      decelerationLimits: [10, 10],
      freeSpeeds: [2, 2],
      startVelocity: 1,
    }));

    expect(result.status).toBe("optimal");
    expect(result.velocities[1]).toBeCloseTo(Math.sqrt(6) - 1, 12);
    const acceleration = (result.velocities[1] ** 2 - 1) / 2;
    expect(acceleration).toBeLessThanOrEqual(2 * (1 - result.velocities[1] / 2) + 1e-12);
  });

  it("keeps traction and motor torque-speed limits independent", () => {
    const result = solveReachabilityProfile(input({
      positions: [0, 1, 2],
      accelerationLimits: [2, 2],
      motorAccelerationLimits: [10, 10],
      decelerationLimits: [10, 10],
      freeSpeeds: [2, 2],
      startVelocity: 1,
    }));

    expect(result.status).toBe("optimal");
    expect(result.velocities[1]).toBeCloseTo((-10 + Math.sqrt(184)) / 2, 12);
    const acceleration = (result.velocities[1] ** 2 - 1) / 2;
    expect(acceleration).toBeLessThanOrEqual(10 * (1 - result.velocities[1] / 2) + 1e-12);
  });

  it("self-checks the module longitudinal motor envelope at interval endpoints", () => {
    const motorConstraint = {
      u: 1,
      x: 0,
      minimum: -2,
      maximum: 2,
      velocityCoefficient: 1,
      freeSpeed: 2,
      motorAcceleration: 2,
    };
    const result = solveReachabilityProfile(input({
      accelerationLimits: [10, 10],
      decelerationLimits: [10, 10],
      scalarAccelerationConstraints: [[motorConstraint], [motorConstraint]],
    }));

    expect(result.status).toBe("optimal");
    result.velocities.slice(1).forEach((velocity, index) => {
      const before = result.velocities[index];
      const acceleration = (velocity ** 2 - before ** 2) / 2;
      const limit = 2 * Math.max(0, 1 - Math.max(before, velocity) / 2);
      expect(Math.abs(acceleration)).toBeLessThanOrEqual(limit + 1e-9);
    });
  });

  it("propagates the full controllable interval for affine constraints", () => {
    const result = solveReachabilityProfile(input({
      positions: [0, 1, 2],
      accelerationLimits: [5, 5],
      decelerationLimits: [1, 1],
      freeSpeeds: [100, 100],
      accelerationConstraints: [[{ uX: 0, uY: 0, xX: 1, xY: 0, limit: 1.1 }], []],
    }));

    expect(result.status).toBe("optimal");
    expect(result.velocities[0]).toBe(0);
    expect(result.velocities[1]).toBeCloseTo(Math.sqrt(2), 11);
    expect(result.velocities[2]).toBe(0);
  });

  it("accepts a narrow boundary-feasible nonlinear predecessor", () => {
    const result = solveReachabilityProfile(input({
      positions: [0, 1],
      velocityLimits: [2, 2],
      accelerationLimits: [5],
      decelerationLimits: [5],
      freeSpeeds: [1e9],
      accelerationConstraints: [[{ uX: 1, uY: 0, xX: 0, xY: 0, limit: 100 }]],
      scalarAccelerationConstraints: [[{ u: 1, x: 0, minimum: 0.5, maximum: 0.5 }]],
      startVelocity: 1,
      goalVelocity: Math.sqrt(2),
    }));

    expect(result.status).toBe("optimal");
    expect(result.velocities).toEqual([1, Math.sqrt(2)]);
  });

  it("classifies a boundary that cannot brake to the goal as infeasible", () => {
    const result = solveReachabilityProfile(input({
      positions: [0, 1],
      velocityLimits: [10, 10],
      accelerationLimits: [1],
      decelerationLimits: [1],
      freeSpeeds: [10],
      startVelocity: 2,
    }));

    expect(result).toMatchObject({
      status: "infeasible",
      reason: "Start velocity cannot decelerate to the authored goal and stops.",
    });
  });

  it("classifies a boundary above its local cap as invalid input", () => {
    const result = solveReachabilityProfile(input({
      velocityLimits: [1, 10, 10],
      startVelocity: 2,
    }));

    expect(result).toMatchObject({
      status: "invalid-input",
      iterations: 0,
      reason: "Start velocity exceeds the local velocity limit.",
    });
  });

  it("classifies an unreachable goal velocity as infeasible", () => {
    const result = solveReachabilityProfile(input({
      positions: [0, 1],
      velocityLimits: [10, 10],
      accelerationLimits: [1],
      decelerationLimits: [10],
      freeSpeeds: [1e9],
      goalVelocity: 2,
    }));

    expect(result).toMatchObject({
      status: "infeasible",
      reason: "Goal velocity is unreachable from the authored start velocity and stops.",
    });
  });

  it("rejects malformed path grids without entering the numeric passes", () => {
    const result = solveReachabilityProfile(input({ positions: [0, 2, 1] }));

    expect(result).toMatchObject({
      status: "invalid-input",
      iterations: 0,
      reason: "Path positions must be monotonic.",
    });
  });

  it("rejects an under-resolved moving interval between stopped boundaries", () => {
    const result = solveReachabilityProfile(input({
      positions: [0, 1],
      velocityLimits: [10, 10],
      accelerationLimits: [1],
      decelerationLimits: [1],
      freeSpeeds: [10],
    }));

    expect(result).toMatchObject({
      status: "invalid-input",
      reason: "Path interval 0 must include a moving sample between stopped boundaries.",
    });
  });

  it("is deterministic for identical normalized input", () => {
    const request = input({
      positions: [0, 0.25, 1.5, 3],
      velocityLimits: [0, 1.2, 2.5, 0],
      accelerationLimits: [3, 2, 1],
      decelerationLimits: [1, 2, 3],
      freeSpeeds: [4, 4, 4],
    });

    expect(solveReachabilityProfile(request)).toEqual(solveReachabilityProfile(request));
  });
});

describe("soft fixed-path reachability", () => {
  it("matches the strict solve exactly when the limits are feasible", () => {
    for (const request of [
      input(),
      input({
        positions: [0, 1, 2, 3, 4],
        velocityLimits: [10, 10, 0, 10, 10],
        accelerationLimits: [1, 1, 1, 1],
        decelerationLimits: [1, 1, 1, 1],
        freeSpeeds: [1e9, 1e9, 1e9, 1e9],
      }),
      input({ accelerationLimits: [2, 2], decelerationLimits: [10, 10], freeSpeeds: [2, 2], startVelocity: 1 }),
    ]) {
      const strict = solveReachabilityProfile(request);
      const soft = solveReachabilityProfile(request, { soft: true });
      expect(soft.status).toBe("optimal");
      expect(soft.velocities).toEqual(strict.velocities);
      expect(soft.violations).toEqual([]);
    }
  });

  it("brakes as hard as allowed and reports the overload instead of failing", () => {
    const request = input({
      positions: [0, 1],
      velocityLimits: [10, 10],
      accelerationLimits: [1],
      decelerationLimits: [1],
      freeSpeeds: [10],
      startVelocity: 2,
    });

    expect(solveReachabilityProfile(request).velocities).toEqual([]);
    const result = solveReachabilityProfile(request, { soft: true });
    expect(result.status).toBe("infeasible");
    expect(result.velocities).toEqual([2, 0]);
    expect(result.violations).toEqual([{
      kind: "deceleration",
      startInterval: 0,
      endInterval: 0,
      worstInterval: 0,
      measured: 2,
      limit: 1,
      constraint: "linear-deceleration",
    }]);
  });

  it("clamps an authored boundary above its local cap", () => {
    const result = solveReachabilityProfile(input({ velocityLimits: [1, 10, 10], startVelocity: 2 }), { soft: true });

    expect(result.velocities[0]).toBe(1);
    expect(result.violations?.[0]).toMatchObject({ kind: "start-velocity", startInterval: 0, measured: 2, limit: 1 });
  });

  it("reports an unreachable goal as an acceleration overload ending at the goal", () => {
    const result = solveReachabilityProfile(input({
      positions: [0, 1],
      velocityLimits: [10, 10],
      accelerationLimits: [1],
      decelerationLimits: [10],
      freeSpeeds: [1e9],
      goalVelocity: 2,
    }), { soft: true });

    expect(result.velocities).toEqual([0, 2]);
    expect(result.violations).toMatchObject([{ kind: "acceleration", endInterval: 0, measured: 2, limit: 1 }]);
  });

  it("keeps acceleration overloads out of braking and cruising intervals", () => {
    const root3 = Math.sqrt(3);
    const result = solveReachabilityProfile({
      positions: [0, 1, 2, 3],
      velocityLimits: [2, root3, root3, 2],
      accelerationLimits: [0.4, 0.4, 0.4],
      decelerationLimits: [1, 1, 1],
      freeSpeeds: [10, root3, 10],
      startVelocity: 2,
      goalVelocity: 2,
    }, { soft: true });
    expect(result.velocities).toEqual([2, root3, root3, 2]);
    expect(result.violations).toHaveLength(1);
    expect(result.violations![0]).toMatchObject({ kind: "acceleration", startInterval: 2, endInterval: 2, worstInterval: 2 });
    expect(result.violations![0].measured).toBeCloseTo(0.5, 12);
    expect(result.violations![0].measured).toBeGreaterThan(result.violations![0].limit);
  });

  it("extends a saturated maneuver while retaining its worst local overload", () => {
    const result = solveReachabilityProfile(input({
      positions: [0, 1, 2, 3], velocityLimits: [10, 10, 10, 10],
      accelerationLimits: [1, 1, 1], decelerationLimits: [1, 1, 1], freeSpeeds: [1e9, 1e9, 1e9],
      goalVelocity: 3,
    }), { soft: true });
    expect(result.velocities).toEqual([0, Math.sqrt(5), Math.sqrt(7), 3]);
    expect(result.violations).toMatchObject([{
      kind: "acceleration", startInterval: 0, endInterval: 2, worstInterval: 0,
      measured: 2.5, limit: 1, constraint: "linear-acceleration",
    }]);
  });

  it("separates adjacent overloads with different binding constraints", () => {
    const result = solveReachabilityProfile(input({
      velocityLimits: [2, 1, 2],
      scalarAccelerationConstraints: [
        [{ u: 1, x: 0, minimum: -10, maximum: 0.3, label: "first-force" }],
        [{ u: 1, x: 0, minimum: -10, maximum: 0.2, label: "second-force" }],
      ],
      goalVelocity: 2,
    }), { soft: true });
    expect(result.violations).toMatchObject([
      { kind: "acceleration", startInterval: 0, endInterval: 0, measured: 0.5, limit: 0.3, constraint: "first-force" },
      { kind: "acceleration", startInterval: 1, endInterval: 1, measured: 1.5, limit: 0.2, constraint: "second-force" },
    ]);
  });

  it("rejects squared-speed overflow only in soft mode", () => {
    const request = input({ velocityLimits: [1e200, 1e200, 1e200], accelerationLimits: [1e308, 1e308], decelerationLimits: [1e308, 1e308] });
    const result = solveReachabilityProfile(request, { soft: true });
    expect(result.status).toBe("invalid-input");
    expect(result.velocities).toEqual([]);
    expect(solveReachabilityProfile(request).status).toBe("optimal");
  });

});
