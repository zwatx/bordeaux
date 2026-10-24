import { describe, expect, it } from "vitest";
import { buildModuleForces as buildForces } from "../src/shared/export/moduleForces";
import { buildRobotBinary } from "../src/shared/export/robotBinary";
import { buildWaypoints } from "../src/shared/project/defaults";
import type { RobotConfig, TrajectorySample } from "../src/shared/types";
import { binaryWriterFixture } from "./fixtures/binaryWriterFixture";
import { forceExportRobot } from "./fixtures/forceExportRobot";

const buildModuleForces = (robot: RobotConfig, samples: TrajectorySample[], headings: number[]) =>
  buildForces(robot, samples, headings, samples.map(sample => sample.curvatureInvM));

const row = (i: number, t: number, velocityMps: number, angularVelocityRadps = 0): TrajectorySample => ({
  i, t, velocityMps, angularVelocityRadps, s: t, f: t / 2, x: 2 + t, y: 4,
  headingRad: 0, accelerationMps2: 999, curvatureInvM: 0,
});

describe("BDX rolling-direction module forces", () => {
  it("uses velocity timestamps for straight acceleration and signed braking, preserving robot orientation independence", () => {
    const robot = forceExportRobot();
    const samples = [row(0, 0, 1), row(1, 0.5, 2), row(2, 1, 1)];
    const expected = robot.driveModel!.massKg! * 2 / 4;
    for (const travel of [0, Math.PI, Math.PI / 2]) {
      const forces = buildModuleForces(robot, samples, samples.map(() => travel));
      forces[0].forEach(force => expect(force).toBeCloseTo(expected, 9));
      forces[1].forEach(force => expect(force).toBeCloseTo(-expected, 9));
      expect(forces[2]).toEqual([0, 0, 0, 0]);
    }
  });

  it("projects the allocated chassis wrench in LF/LB/RF/RB order during combined curved translation and yaw", () => {
    const robot = forceExportRobot(), model = robot.driveModel!;
    const first = { ...row(0, 0, 1, 0.3), headingRad: 0.6, curvatureInvM: 0.2 };
    const second = { ...row(1, 0.1, 1.04, 0.32), headingRad: 0.63, curvatureInvM: 0.2 };
    const forces = buildModuleForces(robot, [first, second], [0, 0])[0];
    const x = model.wheelbaseM! / 2, y = model.trackwidthM! / 2;
    const radiusSum = 4 * (x * x + y * y);
    const expected = [[x, y], [-x, y], [x, -y], [-x, -y]].map(([localX, localY]) => {
      const rx = Math.cos(first.headingRad) * localX - Math.sin(first.headingRad) * localY;
      const ry = Math.sin(first.headingRad) * localX + Math.cos(first.headingRad) * localY;
      const fx = model.massKg! * 0.4 / 4 - model.moiKgM2! * 0.2 * ry / radiusSum;
      const fy = model.massKg! * 0.2 / 4 + model.moiKgM2! * 0.2 * rx / radiusSum;
      const vx = 1 - 0.3 * ry, vy = 0.3 * rx;
      return (fx * vx + fy * vy) / Math.hypot(vx, vy);
    });
    forces.forEach((force, index) => expect(force).toBeCloseTo(expected[index], 9));
    expect(new Set(forces).size).toBe(4);
  });

  it("scales pure spin with yaw inertia and wheel radius, and preserves braking sign for either spin direction", () => {
    const robot = forceExportRobot(), model = robot.driveModel!;
    const radius = Math.hypot(model.wheelbaseM! / 2, model.trackwidthM! / 2);
    for (const direction of [-1, 1]) {
      const samples = [row(0, 0, 0, direction * 0.1), row(1, 0.5, 0, direction * 0.2), row(2, 1, 0, direction * 0.1)];
      const forces = buildModuleForces(robot, samples, [0, 0, 0]);
      const expected = model.moiKgM2! * 0.2 / (4 * radius);
      forces[0].forEach(force => expect(force).toBeCloseTo(expected, 9));
      forces[1].forEach(force => expect(force).toBeCloseTo(-expected, 9));
    }
  });

  it("does not send lateral cornering force to the drive motor", () => {
    const robot = forceExportRobot();
    const samples = [row(0, 0, 1), row(1, 1, 1)].map(sample => ({ ...sample, curvatureInvM: 0.3 }));
    buildModuleForces(robot, samples, [0, 0]).flat().forEach(force => expect(force).toBeCloseTo(0, 10));
  });

  it("mirrors clockwise and counterclockwise curves by exchanging left/right forces", () => {
    const fixture = binaryWriterFixture(true, false);
    const original = buildRobotBinary(fixture.project, { kind: "path", id: fixture.path.id }, fixture.bindings);
    for (const waypoint of fixture.path.waypoints) {
      waypoint.y = 8 - waypoint.y;
      waypoint.theta = -waypoint.theta;
      for (const handle of [waypoint.prevC, waypoint.nextC]) if (handle) handle.y = 8 - handle.y;
    }
    const mirrored = buildRobotBinary(fixture.project, { kind: "path", id: fixture.path.id }, fixture.bindings);
    expect(mirrored.moduleForcesN).toHaveLength(original.moduleForcesN.length);
    mirrored.moduleForcesN.forEach((forces, index) => {
      const [lf, lb, rf, rb] = original.moduleForcesN[index];
      forces.forEach((force, module) => expect(force).toBeCloseTo([rf, rb, lf, lb][module], 6));
    });
  });

  it("handles duplicate knots, waits, launch and terminal rest without undefined wheel directions", () => {
    const robot = forceExportRobot();
    const samples = [row(0, 0, 0), row(1, 0, 0), row(2, 0.2, 0), row(3, 0.4, 1), row(4, 0.6, 0)];
    const forces = buildModuleForces(robot, samples, samples.map(() => 0));
    expect(forces.slice(0, 3)).toEqual(Array.from({ length: 3 }, () => [0, 0, 0, 0]));
    expect(forces[3].every(force => force < 0)).toBe(true);
    expect(forces.at(-1)).toEqual([0, 0, 0, 0]);
    expect(forces.flat().every(Number.isFinite)).toBe(true);
  });

  it("fails export for missing physical inputs rather than writing made-up zero forces", () => {
    const fixture = binaryWriterFixture(false, false);
    for (const key of ["massKg", "moiKgM2", "wheelbaseM", "trackwidthM"] as const) {
      const project = structuredClone(fixture.project);
      delete project.robot.driveModel![key];
      expect(() => buildRobotBinary(project, { kind: "path", id: fixture.path.id }, fixture.bindings)).toThrow(/drivetrain|mass|inertia|wheelbase|trackwidth/i);
    }
    delete fixture.project.robot.driveModel;
    expect(() => buildRobotBinary(fixture.project, { kind: "path", id: fixture.path.id }, fixture.bindings)).toThrow(/complete.*swerve drivetrain model/);
  });

  it("exports forces for actual turn and wait samples without changing their timing", () => {
    const fixture = binaryWriterFixture(false, false);
    fixture.path.waypoints = buildWaypoints([{ x: 2, y: 4, theta: 0 }, { x: 4, y: 4, theta: 0 }]);
    const end = fixture.path.waypoints.at(-1)!;
    end.stop = true;
    end.turnInPlace = { headingDeg: 90, direction: "shortest" };
    end.wait = 0.2;
    const built = buildRobotBinary(fixture.project, { kind: "path", id: fixture.path.id }, fixture.bindings);
    const samples = built.document.paths[0].samples;
    expect(built.moduleForcesN).toHaveLength(samples.length);
    expect(samples.some((sample, index) => sample.velocityMps === 0 && Math.abs(sample.angularVelocityRadps) > 0.01
      && built.moduleForcesN[index].some(force => Math.abs(force) > 0.01))).toBe(true);
    samples.forEach((sample, index) => {
      if (sample.velocityMps === 0 && sample.angularVelocityRadps === 0) expect(built.moduleForcesN[index]).toEqual([0, 0, 0, 0]);
    });
  });

  it("uses the canonical reverse rolling direction during an actual jiggle", () => {
    const fixture = binaryWriterFixture(false, false);
    const end = fixture.path.waypoints.at(-1)!;
    end.stop = true;
    end.jiggle = { distanceM: 0.15, strokes: 2, startDeg: 0, stepDeg: 90, strokeTimeS: 1 };
    const built = buildRobotBinary(fixture.project, { kind: "path", id: fixture.path.id }, fixture.bindings);
    const samples = built.document.paths[0].samples;
    const reverse = samples.flatMap((sample, index) => Math.cos(built.travelHeadings[index]) < -0.99 && sample.velocityMps > 0.01 ? [index] : []);
    expect(reverse.length).toBeGreaterThan(2);
    for (const index of reverse) {
      const next = samples[index + 1];
      const acceleration = (next.velocityMps - samples[index].velocityMps) / (next.t - samples[index].t);
      built.moduleForcesN[index].forEach(force => expect(force).toBeCloseTo(fixture.project.robot.driveModel!.massKg! * acceleration / 4, 7));
    }
  });
});
