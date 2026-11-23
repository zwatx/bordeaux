import { describe, expect, it } from "vitest";
import { getPlanner } from "../src/core/planners";
import { PM } from "../src/core/math/pm";
import { buildWaypoints, createDemoProject } from "../src/core/project/defaults";
import type { TrajectoryPlannerId } from "../src/core/types";
import { validateProject } from "../src/core/validation";
import { decodeProjectFile } from "../src/core/project/fileFormat";
import { applyRotationPriority, translationPriorityIntervalMask } from "../src/core/planners/rotationPriority";
import {
  headingTransitionGoals,
  headingTransitionWindows,
  smoothHeadingTransitions,
} from "../src/core/planners/headingTransitions";
import type { PlannerResult } from "../src/core/types";

const PLANNERS: TrajectoryPlannerId[] = ["profiledSpline", "optimizedTrajectory"];

function interiorTurnProject() {
  const project = createDemoProject();
  const path = project.paths[0];
  path.headingMode = "tangent";
  path.waypoints = buildWaypoints([
    { x: 2, y: 2, theta: 0, thetaOn: true, segType: "line" },
    {
      x: 4,
      y: 2,
      theta: 90,
      thetaOn: true,
      stop: true,
      wait: 0.12,
      segType: "line",
      segmentHeadingMode: "manual",
      turnInPlace: { headingDeg: 90, direction: "counterclockwise" },
    },
    { x: 6, y: 2, theta: 90, thetaOn: true },
  ]);
  return project;
}

describe("motion features", () => {
  it("raises corner speed independently from longitudinal acceleration", () => {
    const project = createDemoProject();
    const points = [{ s: 0, curv: 0 }, { s: 1, curv: 1 }, { s: 2, curv: 0 }];
    const legacy = PM.profile(points, { ...project.paths[0].constraints, maxAccel: 1, maxDecel: 1 }, 3, 3);
    const faster = PM.profile(points, { ...project.paths[0].constraints, maxAccel: 1, maxDecel: 1, maxCentripetalAccel: 4 }, 3, 3);

    expect(legacy.v[1]).toBeCloseTo(1, 6);
    expect(faster.v[1]).toBeCloseTo(2, 6);
  });

  it("smooths a mixed-mode swerve tangent joint without changing an all-tangent law", () => {
    const points = Array.from({ length: 13 }, (_, index) => ({ s: index * 0.1 }));
    const raw = points.map((_, index) => index <= 5 ? 0 : (index - 5) * 0.1);
    const waypoints = buildWaypoints([
      { x: 0, y: 0, theta: 0, segmentHeadingMode: "tangent" },
      { x: 0.5, y: 0, theta: 0, segmentHeadingMode: "tangent" },
      {
        x: 1,
        y: 0,
        theta: 0,
        segmentHeadingMode: "targets",
        headingTransition: { placement: "after", rotationPriority: "heading", distanceM: 0.1 },
      },
      { x: 1.2, y: 0, theta: 0 },
    ]);
    const mixed = smoothHeadingTransitions(
      raw,
      ["tangent", "tangent", "targets"],
      [false, false, false],
      [0, 5, 10, 12],
      points,
      waypoints,
    );
    const leftSlope = (mixed[5] - mixed[4]) / 0.1;
    const rightSlope = (mixed[6] - mixed[5]) / 0.1;

    expect(Math.abs(rightSlope - leftSlope)).toBeLessThan(0.5);
    expect(mixed[3]).toBeCloseTo(raw[3], 10);
    expect(mixed[8]).toBeCloseTo(raw[8], 10);
    expect(smoothHeadingTransitions(
      raw,
      ["tangent", "tangent", "tangent"],
      [false, false, false],
      [0, 5, 10, 12],
      points,
      waypoints,
    )).toEqual(raw);
  });

  it("applies narrow constraint ranges to every overlapping profile interval", () => {
    const project = createDemoProject();
    const points = Array.from({ length: 57 }, (_, index) => ({ s: index, curv: 0 })) as any;
    const range = {
      anchor: "param" as const, f0: 0.505, f1: 0.51,
      maxVel: 0.25, maxAccel: 0.1, maxDecel: 0.1, maxAngVel: 10, maxAngAccel: 5,
    };
    const firstAfterRange = points.findIndex((point: { s: number }) => point.s / 56 > range.f1);
    const before = firstAfterRange - 1;
    expect(points[before].s / 56).toBeLessThan(range.f0);

    const constraints = {
      ...project.paths[0].constraints,
      maxVel: 4, maxAccel: 10, maxDecel: 10, maxAngVel: 360, maxAngAccel: 720,
    };
    const velocity = PM.profile(points, constraints, 4, 4, { ranges: [range] });
    expect(Math.max(velocity.v[before], velocity.v[firstAfterRange])).toBeLessThanOrEqual(range.maxVel);

    const linearRange = { ...range, maxVel: 100, maxAngVel: 360 };
    const linearConstraints = { ...constraints, maxVel: 100 };
    const accelerating = PM.profile(points, linearConstraints, 0, 100, { ranges: [linearRange] });
    const acceleration = (accelerating.v[firstAfterRange] ** 2 - accelerating.v[before] ** 2) / 2;
    expect(acceleration).toBeLessThanOrEqual(range.maxAccel + 1e-9);
    const decelerating = PM.profile(points, linearConstraints, 100, 0, { ranges: [linearRange] });
    const deceleration = (decelerating.v[before] ** 2 - decelerating.v[firstAfterRange] ** 2) / 2;
    expect(deceleration).toBeLessThanOrEqual(range.maxDecel + 1e-9);

    const heading = points.map((_: unknown, index: number) => index < firstAfterRange ? 0 : Math.PI / 2);
    const angular = PM.profile(points, constraints, 4, 4, { ranges: [{ ...range, maxVel: 4 }], heading });
    const angularVelocity = (Math.PI / 2) / (angular.t[firstAfterRange] - angular.t[before]);
    expect(angularVelocity).toBeLessThanOrEqual(range.maxAngVel * Math.PI / 180 + 1e-9);

    const accelerationHeading = points.map((_: unknown, index: number) => index < firstAfterRange ? 0 : 0.2);
    const angularAcceleration = PM.profile(points, linearConstraints, 100, 100, {
      ranges: [{ ...linearRange, maxAngAccel: 1 }],
      heading: accelerationHeading,
    });
    const accelerationDt = angularAcceleration.t[firstAfterRange] - angularAcceleration.t[before];
    expect(0.2 / accelerationDt ** 2).toBeLessThanOrEqual(Math.PI / 180 + 1e-9);
  });

  it("acquires the first real target monotonically when Targets becomes active", () => {
    const points = Array.from({ length: 25 }, (_, index) => ({ s: index * 0.25 }));
    const waypoints = buildWaypoints([
      { x: 6, y: 5, theta: 0, segmentHeadingMode: "tangent" },
      {
        x: 3, y: 5, theta: 0, segmentHeadingMode: "targets",
        headingTransition: { placement: "after", rotationPriority: "heading", distanceM: 0.75 },
      },
      { x: 0, y: 5, theta: 0 },
    ]);
    const raw = points.map((point) => {
      if (point.s <= 3) return Math.PI;
      if (point.s <= 4.5) return (-45 * (point.s / 4.5)) * Math.PI / 180;
      return (-45 + 45 * ((point.s - 4.5) / 1.5)) * Math.PI / 180;
    });
    const goals = headingTransitionGoals(
      ["tangent", "targets"],
      [false, false],
      [0, 12, 24],
      points,
      {
        manual: [{ f: 0, heading: 0 }, { f: 1, heading: 0 }],
        targets: [{ f: 0, heading: 0 }, { f: 0.75, heading: -Math.PI / 4 }, { f: 1, heading: 0 }],
      },
    );
    for (const placement of ["before", "split", "after"] as const) {
      waypoints[1].headingTransition!.placement = placement;
      const headings = smoothHeadingTransitions(raw, ["tangent", "targets"], [false, false], [0, 12, 24], points, waypoints, goals);
      const throughTarget = headings.slice(9, 19);
      for (let index = 1; index < throughTarget.length; index += 1) {
        expect(throughTarget[index]).toBeGreaterThanOrEqual(throughTarget[index - 1] - 1e-10);
      }
      expect(throughTarget.at(-1)).toBeCloseTo(7 * Math.PI / 4, 8);
    }
  });

  it("preserves the incoming waypoint heading when changing from Manual to Tangent", () => {
    const points = Array.from({ length: 5 }, (_, s) => ({ s }));
    const waypoints = buildWaypoints([
      { x: 0, y: 0, theta: 0 },
      { x: 2, y: 0, theta: 60, thetaOn: true },
      { x: 4, y: 0, theta: 0 },
    ]);
    const headings = smoothHeadingTransitions(
      [0, 0.2, 0.4, 0.5, 0.6], ["manual", "tangent"], [false, false], [0, 2, 4], points, waypoints,
    );

    expect(headings[2]).toBeCloseTo(Math.PI / 3, 12);
    expect(headings.slice(3)).toEqual([0.5, 0.6]);
  });

  it("does not snap the next sample back to an off-grid target angle", () => {
    const points = Array.from({ length: 5 }, (_, s) => ({ s, heading: 0 }));
    const waypoints = buildWaypoints([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 4, y: 0 }]);
    const headings = smoothHeadingTransitions(
      [0, 0, 0.5, 1, 1.25], ["tangent", "targets"], [false, false], [0, 1, 4], points, waypoints,
      [{ segmentIndex: 1, distanceM: 2.5, heading: 0.9, spanEndIndex: 4 }],
    );

    expect(headings[3]).toBe(1);
    expect(headings[4]).toBe(1.25);
  });

  it("honors a target on the mode boundary and protects it from a later blend", () => {
    const points = Array.from({ length: 37 }, (_, index) => ({ s: index * 0.25 }));
    const waypoints = buildWaypoints([
      { x: 9, y: 5, theta: 0, segmentHeadingMode: "tangent" },
      {
        x: 6, y: 5, theta: 0, segmentHeadingMode: "targets",
        headingTransition: { placement: "after", rotationPriority: "heading", distanceM: 0.75 },
      },
      {
        x: 3, y: 5, theta: -45, thetaOn: true, segmentHeadingMode: "tangent",
        headingTransition: { placement: "before", rotationPriority: "heading", distanceM: 0.75 },
      },
      { x: 0, y: 5, theta: 0 },
    ]);
    const raw = points.map((point) => {
      if (point.s <= 3 || point.s >= 6) return Math.PI;
      return (-45 * ((point.s - 3) / 3)) * Math.PI / 180;
    });
    const goals = headingTransitionGoals(
      ["tangent", "targets", "tangent"],
      [false, false, false],
      [0, 12, 24, 36],
      points,
      {
        manual: [{ f: 0, heading: 0 }, { f: 1, heading: 0 }],
        targets: [{ f: 0, heading: 0 }, { f: 2 / 3, heading: -Math.PI / 4 }, { f: 1, heading: 0 }],
      },
    );

    expect(goals[0].distanceM).toBeCloseTo(6, 8);
    const headings = smoothHeadingTransitions(raw, ["tangent", "targets", "tangent"], [false, false, false], [0, 12, 24, 36], points, waypoints, goals);
    expect(headings[24]).toBeCloseTo(7 * Math.PI / 4, 8);

    const boundaryGoals = headingTransitionGoals(
      ["tangent", "targets"],
      [false, false],
      [0, 12, 24],
      points.slice(0, 25),
      {
        manual: [{ f: 0, heading: 0 }, { f: 1, heading: 0 }],
        targets: [{ f: 0.5, heading: -Math.PI / 4 }, { f: 1, heading: 0 }],
      },
    );
    expect(boundaryGoals[0].distanceM).toBeCloseTo(3, 8);
    const boundaryPoints = points.slice(0, 25);
    const boundaryRaw = boundaryPoints.map((point) => (
      point.s <= 3 ? Math.PI : (-45 + 45 * ((point.s - 3) / 3)) * Math.PI / 180
    ));
    const boundaryWaypoints = buildWaypoints([
      { x: 6, y: 5, theta: 0, segmentHeadingMode: "tangent" },
      {
        x: 3, y: 5, theta: -45, thetaOn: true, segmentHeadingMode: "targets",
        headingTransition: { placement: "after", rotationPriority: "heading", distanceM: 0.75 },
      },
      { x: 0, y: 5, theta: 0 },
    ]);
    for (const placement of ["before", "split", "after"] as const) {
      boundaryWaypoints[1].headingTransition!.placement = placement;
      const boundaryHeadings = smoothHeadingTransitions(
        boundaryRaw,
        ["tangent", "targets"],
        [false, false],
        [0, 12, 24],
        boundaryPoints,
        boundaryWaypoints,
        boundaryGoals,
      );
      expect(boundaryHeadings.slice(12, 16).some((heading) => Math.abs(heading - 7 * Math.PI / 4) < 1e-8)).toBe(true);
    }
  });

  it.each(PLANNERS)("does not reverse before a target after a tangent-to-Targets switch with %s", (plannerId) => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.constraints.maxAngVel = 720;
    path.constraints.maxAngAccel = 1440;
    path.constraints.maxAngDecel = 1440;
    path.waypoints = buildWaypoints([
      { x: 9, y: 5, theta: 0, thetaOn: true, segType: "line", segmentHeadingMode: "tangent" },
      {
        x: 6, y: 5, theta: 0, thetaOn: false, segType: "line", segmentHeadingMode: "targets",
        headingTransition: { placement: "after", rotationPriority: "heading", distanceM: 0.05 },
      },
      { x: 3, y: 5, theta: 0, thetaOn: true, segType: "line" },
    ]);
    path.targets = [{ f: 0.75, deg: -45 }];

    const result = getPlanner(plannerId).generate({ path, robot: project.robot });
    const throughTarget = result.samples.filter((sample) => sample.f >= 0.49 && sample.f <= 0.75 + 1e-6);
    const unwrapped = [throughTarget[0].headingRad];
    for (let index = 1; index < throughTarget.length; index += 1) {
      let heading = throughTarget[index].headingRad;
      while (heading - unwrapped[index - 1] > Math.PI) heading -= 2 * Math.PI;
      while (heading - unwrapped[index - 1] < -Math.PI) heading += 2 * Math.PI;
      unwrapped.push(heading);
    }
    for (let index = 1; index < unwrapped.length; index += 1) {
      expect(unwrapped[index]).toBeGreaterThanOrEqual(unwrapped[index - 1] - 0.02 * Math.PI / 180);
    }
    expect(Math.max(...unwrapped)).toBeLessThanOrEqual(7 * Math.PI / 4 + 0.25 * Math.PI / 180);
  });

  it("normalizes legacy blend placements to one automatic transition through its waypoint", () => {
    const raw = [0, 0, 0, Math.PI / 2, Math.PI / 2, Math.PI / 2, Math.PI / 2];
    const points = raw.map((_, index) => ({ s: index }));
    const base = buildWaypoints([
      { x: 0, y: 0, theta: 0, segmentHeadingMode: "manual" },
      { x: 3, y: 0, theta: 90, segmentHeadingMode: "tangent" },
      { x: 6, y: 0, theta: 90 },
    ]);
    const headingsFor = (placement: "before" | "split" | "after") => {
      base[1].headingTransition = { placement, rotationPriority: "heading", distanceM: 2 };
      return smoothHeadingTransitions(raw, ["manual", "tangent"], [false, false], [0, 3, 6], points, base);
    };

    const canonical = headingsFor("after");
    expect(headingsFor("before")).toEqual(canonical);
    expect(headingsFor("split")).toEqual(canonical);
    expect(canonical[3]).toBeCloseTo(0, 8);

    base[1].headingTransition = { placement: "split", rotationPriority: "translation", distanceM: 2 };
    const [window] = headingTransitionWindows(base, ["manual", "tangent"], [false, false], [0, 0.5, 1], 6);
    expect(window).toMatchObject({ waypointIndex: 1, rotationPriority: "translation" });
    expect(window.start).toBeCloseTo(0.5, 10);
    expect(window.end).toBeCloseTo(1, 10);

    base[1].headingTransition = { placement: "after", rotationPriority: "heading", distanceM: 2 };
    const [headingWindow] = headingTransitionWindows(base, ["manual", "tangent"], [false, false], [0, 0.5, 1], 6);
    expect(headingWindow.start).toBeCloseTo(0.5, 10);
  });

  it("does not let hidden waypoint heading state change blend placement semantics", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "targets";
    path.constraints.maxAngVel = 720;
    path.constraints.maxAngAccel = 1_440;
    path.constraints.maxAngDecel = 1_440;
    path.waypoints = buildWaypoints([
      { x: 1, y: 2, theta: 0, thetaOn: true, segType: "line", segmentHeadingMode: "tangent" },
      { x: 4, y: 2, theta: 170, thetaOn: true, segType: "line", segmentHeadingMode: "targets" },
      { x: 7, y: 2, theta: 90, thetaOn: true },
    ]);

    for (const placement of ["before", "split", "after"] as const) {
      path.waypoints[1].headingTransition = { placement, rotationPriority: "heading", distanceM: 1 };
      const pinned = getPlanner("profiledSpline").generate({ path: structuredClone(path), robot: project.robot });
      const unpinnedPath = structuredClone(path);
      unpinnedPath.waypoints[1].thetaOn = false;
      const unpinned = getPlanner("profiledSpline").generate({ path: unpinnedPath, robot: project.robot });

      expect(pinned.samples).toHaveLength(unpinned.samples.length);
      pinned.samples.forEach((sample, index) => {
        expect(Math.abs(PM.angWrap(sample.headingRad - unpinned.samples[index].headingRad))).toBeLessThan(1e-8);
      });
    }
  });

  it.each(PLANNERS)("lets a heading transition preserve translational timing with %s", (plannerId) => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.constraints.maxVel = 4;
    path.constraints.maxAccel = 5;
    path.constraints.maxDecel = 5;
    path.constraints.maxAngVel = 90;
    path.constraints.maxAngAccel = 180;
    path.constraints.maxAngDecel = 180;
    path.headingMode = "manual";
    path.waypoints = buildWaypoints([
      { x: 1, y: 2, theta: -90, thetaOn: true, segType: "line", segmentHeadingMode: "manual" },
      { x: 4, y: 2, theta: -90, thetaOn: true, segType: "line", segmentHeadingMode: "tangent" },
      { x: 9, y: 2, theta: 0, thetaOn: true },
    ]);
    path.waypoints[1].headingTransition = { placement: "after", rotationPriority: "heading", distanceM: 0.05 };
    const headingResult = getPlanner(plannerId).generate({ path: structuredClone(path), robot: project.robot });
    path.waypoints[1].headingTransition.rotationPriority = "translation";
    const translationResult = getPlanner(plannerId).generate({ path, robot: project.robot });
    const headingArrival = headingResult.samples.find((sample) => sample.f >= 1 - 1e-9)!;
    const translationArrival = translationResult.samples.find((sample) => sample.f >= 1 - 1e-9)!;
    expect(translationArrival.t).toBeLessThanOrEqual(headingArrival.t + 0.02);
    expect(translationResult.diagnostics.some((issue) => issue.severity === "error")).toBe(false);
    if (plannerId === "optimizedTrajectory") expect(translationResult.optimization?.fallback).toBe(false);
    const settled = translationResult.samples.filter((sample) => sample.x >= 4);
    expect(Math.max(...settled.map((sample) => sample.headingRad))).toBeLessThanOrEqual(10 * Math.PI / 180);
    expect(Math.abs(translationResult.samples.at(-1)!.headingRad)).toBeLessThan(0.1 * Math.PI / 180);
  });

  it.each(PLANNERS)("keeps every transition placement moving through the outgoing segment in %s", (plannerId) => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.constraints.maxVel = 4;
    path.constraints.maxAccel = 5;
    path.constraints.maxDecel = 5;
    path.constraints.maxAngVel = 90;
    path.constraints.maxAngAccel = 180;
    path.constraints.maxAngDecel = 180;
    path.waypoints = buildWaypoints([
      { x: 5.1, y: 7.6, theta: 0, thetaOn: true, segmentHeadingMode: "tangent" },
      { x: 9.3, y: 5.4, theta: -91, thetaOn: true, segmentHeadingMode: "targets" },
      { x: 6, y: 5.5, theta: 0, thetaOn: true },
    ]);

    (["before", "split", "after"] as const).forEach((placement) => {
      path.waypoints[1].headingTransition = { placement, rotationPriority: "translation", distanceM: 0.75 };
      const result = getPlanner(plannerId).generate({ path: structuredClone(path), robot: project.robot });
      const boundary = result.samples.reduce((nearest, sample, index) => (
        Math.hypot(sample.x - 9.3, sample.y - 5.4) < Math.hypot(result.samples[nearest].x - 9.3, result.samples[nearest].y - 5.4)
          ? index : nearest
      ), 0);
      const arrival = result.samples.findIndex((sample) => sample.s >= result.totalDistanceM - 1e-6);
      const moving = result.samples.slice(boundary, arrival).filter((sample) => (
        sample.s <= result.totalDistanceM - 0.05
      ));
      expect(Math.min(...moving.map((sample) => sample.velocityMps))).toBeGreaterThan(0.05);
    });
  });

  it.each(PLANNERS)("preserves the exact incoming Bézier tangent at a heading-law waypoint in %s", (plannerId) => {
    const project = createDemoProject();
    const path = project.paths[0];
    const tangent = 45 * Math.PI / 180;
    path.headingMode = "targets";
    path.waypoints = buildWaypoints([
      {
        x: 0, y: 0, theta: 0, thetaOn: true, segType: "bezier", segmentHeadingMode: "tangent",
        prevC: { x: -3, y: 2 }, nextC: { x: 3, y: -2 },
      },
      {
        x: 2, y: 2, theta: 0, thetaOn: true, segType: "bezier", segmentHeadingMode: "targets",
        prevC: { x: 1.95, y: 1.95 }, nextC: { x: 3, y: 3 },
        headingTransition: { placement: "after", rotationPriority: "translation", distanceM: 0.75 },
      },
      {
        x: 5, y: 2, theta: 90, thetaOn: true, segType: "bezier",
        prevC: { x: 4, y: 2 }, nextC: { x: 6, y: 2 },
      },
    ]);

    for (const priority of ["translation", "heading"] as const) {
      path.waypoints[1].headingTransition!.rotationPriority = priority;
      const result = getPlanner(plannerId).generate({ path: structuredClone(path), robot: project.robot, samplesPerSegment: 56 });
      const boundary = result.samples.reduce((nearest, sample) => (
        Math.hypot(sample.x - 2, sample.y - 2) < Math.hypot(nearest.x - 2, nearest.y - 2)
          ? sample
          : nearest
      ));

      expect(Math.abs(PM.angWrap(boundary.headingRad - tangent)) * 180 / Math.PI, priority).toBeLessThan(0.25);
      expect(result.diagnostics.some((issue) => issue.severity === "error"), priority).toBe(false);
    }
  });

  it.each(PLANNERS)("normalizes legacy Targets placement to one automatic waypoint blend with %s", (plannerId) => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.constraints.maxAngVel = 360;
    path.constraints.maxAngAccel = 720;
    path.constraints.maxAngDecel = 720;
    path.headingMode = "targets";
    path.waypoints = buildWaypoints([
      { x: 1, y: 2, theta: 0, thetaOn: true, segType: "line", segmentHeadingMode: "tangent" },
      { x: 4, y: 2, theta: -45, thetaOn: true, segType: "line", segmentHeadingMode: "targets" },
      { x: 7, y: 2, theta: 90, thetaOn: true },
    ]);

    let referenceHeadings: number[] | undefined;
    for (const placement of ["before", "split", "after"] as const) {
      path.waypoints[1].headingTransition = { placement, rotationPriority: "heading", distanceM: 0.75 };
      const result = getPlanner(plannerId).generate({ path: structuredClone(path), robot: project.robot });
      const boundary = result.samples.reduce((nearest, sample, index) => Math.abs(sample.x - 4) < Math.abs(result.samples[nearest].x - 4) ? index : nearest, 0);
      const incoming = result.samples.filter((sample) => sample.s <= result.samples[boundary].s + 1e-6);
      expect(Math.max(...incoming.map((sample) => Math.abs(sample.headingRad)))).toBeLessThan(1 * Math.PI / 180);
      const next = result.samples.find((sample) => sample.s > result.samples[boundary].s + 1e-4);
      expect(next).toBeDefined();
      expect(next!.headingRad).toBeGreaterThan(result.samples[boundary].headingRad);
      expect(result.diagnostics.some((issue) => issue.severity === "error")).toBe(false);
      const headings = result.samples.map((sample) => sample.headingRad);
      if (!referenceHeadings) referenceHeadings = headings;
      else {
        expect(headings).toHaveLength(referenceHeadings.length);
        headings.forEach((heading, index) => expect(heading).toBeCloseTo(referenceHeadings![index], 8));
      }
    }
  });

  it("drops legacy heading-transition controls during project normalization", () => {
    const project = createDemoProject();
    project.paths[0].waypoints = buildWaypoints([
      { x: 2, y: 2, theta: 0, segmentHeadingMode: "manual" },
      { x: 4, y: 2, theta: 0, segmentHeadingMode: "tangent" },
      { x: 6, y: 2, theta: 0 },
    ]);
    const transition = project.paths[0].waypoints[1];
    transition.headingTransition = { placement: "split", rotationPriority: "translation", distanceM: 1.1 };

    expect(validateProject(project).ok).toBe(true);
    expect(decodeProjectFile(JSON.stringify(project)).project.paths[0].waypoints[1].headingTransition).toBeUndefined();
  });

  it("catches up to a settled heading without overshooting and oscillating", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.constraints.maxAngVel = 180;
    path.constraints.maxAngAccel = 360;
    path.constraints.maxAngDecel = 360;
    path.ranges = [{
      anchor: "param", f0: 0, f1: 1,
      maxVel: path.constraints.maxVel,
      maxAccel: path.constraints.maxAccel,
      maxDecel: path.constraints.maxDecel,
      maxAngVel: path.constraints.maxAngVel,
      maxAngAccel: path.constraints.maxAngAccel,
      rotationPriority: "translation",
    }];
    const dt = 0.02;
    const sampleCount = 151;
    const samples = Array.from({ length: sampleCount }, (_, index) => {
      const t = index * dt;
      const progress = Math.min(1, t / 0.2);
      const headingRad = (-90 + progress * 90) * Math.PI / 180;
      return {
        i: index,
        t,
        s: t,
        f: index / (sampleCount - 1),
        x: t,
        y: 0,
        headingRad,
        velocityMps: 1,
        accelerationMps2: 0,
        angularVelocityRadps: t > 0 && t <= 0.2 ? 450 * Math.PI / 180 : 0,
        curvatureInvM: 0,
      };
    });
    const raw: PlannerResult = {
      planner: "profiledSpline",
      samples,
      markers: [],
      diagnostics: [],
      totalDistanceM: samples.at(-1)!.x,
      totalTimeS: samples.at(-1)!.t,
    };

    const tracked = applyRotationPriority(path, raw, project.robot);
    const settled = tracked.samples.filter((sample) => sample.t >= 0.2);
    const maxHeading = Math.max(...settled.map((sample) => sample.headingRad));
    const angularAcceleration = tracked.samples.slice(1).map((sample, index) =>
      (sample.angularVelocityRadps - tracked.samples[index].angularVelocityRadps) / dt);

    expect(maxHeading).toBeLessThanOrEqual(0.5 * Math.PI / 180);
    expect(Math.abs(tracked.samples.at(-1)!.headingRad)).toBeLessThan(0.1 * Math.PI / 180);
    expect(Math.max(...angularAcceleration.map(Math.abs)))
      .toBeLessThanOrEqual(path.constraints.maxAngAccel * Math.PI / 180 * 1.01);
  });

  it("uses the acceleration limit after reversing angular direction", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.constraints.maxAngVel = 240;
    path.constraints.maxAngAccel = 120;
    path.constraints.maxAngDecel = 720;
    path.ranges = [{
      anchor: "param", f0: 0, f1: 1,
      maxVel: path.constraints.maxVel, maxAccel: path.constraints.maxAccel, maxDecel: path.constraints.maxDecel,
      maxAngVel: path.constraints.maxAngVel, maxAngAccel: path.constraints.maxAngAccel,
      rotationPriority: "translation",
    }];
    const dt = 0.02;
    const samples = Array.from({ length: 201 }, (_, index) => {
      const t = index * dt;
      const headingDeg = t < 0.2 ? 450 * t : t < 0.6 ? 90 : t < 0.8 ? 90 - 900 * (t - 0.6) : -90;
      return {
        i: index, t, s: t, f: index / 200, x: t, y: 0,
        headingRad: headingDeg * Math.PI / 180,
        velocityMps: index === 200 ? 0 : 1,
        accelerationMps2: 0, angularVelocityRadps: 0, curvatureInvM: 0,
      };
    });
    const tracked = applyRotationPriority(path, {
      planner: "profiledSpline", samples, markers: [], diagnostics: [], totalDistanceM: 4, totalTimeS: 4,
    }, project.robot);

    tracked.samples.slice(1).forEach((sample, index) => {
      const previous = tracked.samples[index];
      const acceleration = Math.abs(sample.angularVelocityRadps - previous.angularVelocityRadps) / (sample.t - previous.t);
      const reversing = Math.sign(sample.angularVelocityRadps) !== 0
        && Math.sign(previous.angularVelocityRadps) !== 0
        && Math.sign(sample.angularVelocityRadps) !== Math.sign(previous.angularVelocityRadps);
      const limitDeg = reversing
        ? Math.min(path.constraints.maxAngAccel, path.constraints.maxAngDecel!)
        : Math.abs(sample.angularVelocityRadps) > Math.abs(previous.angularVelocityRadps)
          ? path.constraints.maxAngAccel
          : path.constraints.maxAngDecel!;
      expect(acceleration).toBeLessThanOrEqual(limitDeg * Math.PI / 180 * 1.01);
    });
    expect(tracked.diagnostics.some((issue) => issue.message.includes("angular limits"))).toBe(false);
  });

  it("keeps a range's angular limits through its ending interval", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.constraints.maxAngVel = 240;
    path.constraints.maxAngAccel = 720;
    path.constraints.maxAngDecel = 720;
    path.ranges = [{
      anchor: "param", f0: 0, f1: 0.5,
      maxVel: path.constraints.maxVel, maxAccel: path.constraints.maxAccel, maxDecel: path.constraints.maxDecel,
      maxAngVel: 30, maxAngAccel: 60, rotationPriority: "translation",
    }];
    const dt = 0.02;
    const samples = Array.from({ length: 101 }, (_, index) => ({
      i: index, t: index * dt, s: index * dt, f: index / 100, x: index * dt, y: 0,
      headingRad: index / 100 * Math.PI, velocityMps: index === 100 ? 0 : 1,
      accelerationMps2: 0, angularVelocityRadps: 0, curvatureInvM: 0,
    }));
    const tracked = applyRotationPriority(path, {
      planner: "profiledSpline", samples, markers: [], diagnostics: [], totalDistanceM: 2, totalTimeS: 2,
    }, project.robot);
    const firstOutside = tracked.samples.findIndex((sample) => sample.f > 0.5);
    const before = tracked.samples[firstOutside - 1], outside = tracked.samples[firstOutside];

    expect(Math.abs(outside.angularVelocityRadps)).toBeLessThanOrEqual(30 * Math.PI / 180 * 1.001);
    expect(Math.abs(outside.angularVelocityRadps - before.angularVelocityRadps) / dt)
      .toBeLessThanOrEqual(60 * Math.PI / 180 * 1.001);
    expect(tracked.diagnostics.some((issue) => /angular limits|reacquire/.test(issue.message))).toBe(true);
  });

  it.each(PLANNERS)("ignores legacy range priority in the coupled planner for %s", (plannerId) => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "manual";
    path.constraints.maxVel = 4;
    path.constraints.maxAccel = 5;
    path.constraints.maxDecel = 5;
    path.constraints.maxAngVel = 60;
    path.constraints.maxAngAccel = 120;
    path.constraints.maxAngDecel = 120;
    path.waypoints = buildWaypoints([
      { x: 1, y: 2, theta: 0, thetaOn: true, segType: "line" },
      { x: 8, y: 2, theta: 180, thetaOn: true },
    ]);
    path.ranges = [{
      anchor: "param", f0: 0.05, f1: 1,
      maxVel: 4, maxAccel: 5, maxDecel: 5, maxAngVel: 60, maxAngAccel: 120,
    }];

    const headingPriority = getPlanner(plannerId).generate({ path: structuredClone(path), robot: project.robot });
    path.ranges[0].rotationPriority = "translation";
    const translationPriority = getPlanner(plannerId).generate({ path, robot: project.robot });
    expect(translationPriority.samples).toEqual(headingPriority.samples);
    expect(translationPriority.totalTimeS).toBe(headingPriority.totalTimeS);
    expect(translationPriority.diagnostics.some((issue) => issue.severity === "error" && issue.message.includes("velocity or acceleration limits"))).toBe(false);
    expect(Math.max(...translationPriority.samples.map((sample) => Math.abs(sample.angularVelocityRadps))))
      .toBeLessThanOrEqual(path.constraints.maxAngVel * Math.PI / 180 * 1.02);
    const angularAcceleration = translationPriority.samples.slice(1).map((sample, index) => {
      const previous = translationPriority.samples[index];
      return (sample.angularVelocityRadps - previous.angularVelocityRadps) / Math.max(1e-9, sample.t - previous.t);
    });
    expect(Math.max(...angularAcceleration.map(Math.abs)))
      .toBeLessThanOrEqual(path.constraints.maxAngAccel * Math.PI / 180 * 1.04);
    expect(Math.abs(PM.angWrap(translationPriority.samples.at(-1)!.headingRad - Math.PI)))
      .toBeLessThan(0.1 * Math.PI / 180);
    translationPriority.samples.slice(1).forEach((sample, index) => {
      const previous = translationPriority.samples[index];
      const dt = sample.t - previous.t;
      const actualAverage = PM.angWrap(sample.headingRad - previous.headingRad) / dt;
      const declaredAverage = (previous.angularVelocityRadps + sample.angularVelocityRadps) * 0.5;
      expect(Math.abs(actualAverage - declaredAverage)).toBeLessThan(0.08);
    });
  });

  it("drops legacy range priority during project normalization", () => {
    const project = createDemoProject();
    project.paths[0].ranges = [{
      anchor: "param", f0: 0.2, f1: 0.8,
      maxVel: 4.2, maxAccel: 6.5, maxDecel: 6.5, maxAngVel: 180, maxAngAccel: 360,
      rotationPriority: "translation",
    }];
    expect(validateProject(project).ok).toBe(true);
    expect(decodeProjectFile(JSON.stringify(project)).project.paths[0].ranges[0].rotationPriority).toBeUndefined();

    (project.paths[0].ranges[0] as unknown as { rotationPriority: string }).rotationPriority = "fastest";
    expect(decodeProjectFile(JSON.stringify(project)).project.paths[0].ranges[0].rotationPriority).toBeUndefined();
  });

  it.each(PLANNERS)("keeps omitted timing priority identical to explicit heading priority in %s", (plannerId) => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.ranges = [{
      anchor: "param", f0: 0.2, f1: 0.8,
      maxVel: path.constraints.maxVel,
      maxAccel: path.constraints.maxAccel,
      maxDecel: path.constraints.maxDecel,
      maxAngVel: path.constraints.maxAngVel / 2,
      maxAngAccel: path.constraints.maxAngAccel,
    }];
    const omitted = getPlanner(plannerId).generate({ path: structuredClone(path), robot: project.robot });
    path.ranges[0].rotationPriority = "heading";
    const explicit = getPlanner(plannerId).generate({ path, robot: project.robot });

    expect(explicit.totalTimeS).toBe(omitted.totalTimeS);
    expect(explicit.samples).toEqual(omitted.samples);
  });

  it.each(PLANNERS)("lets an overlapping heading-priority range override translation priority in %s", (plannerId) => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "manual";
    path.constraints.maxVel = 4;
    path.constraints.maxAccel = 5;
    path.constraints.maxDecel = 5;
    path.constraints.maxAngVel = 60;
    path.constraints.maxAngAccel = 120;
    path.constraints.maxAngDecel = 120;
    path.waypoints = buildWaypoints([
      { x: 1, y: 2, theta: 0, thetaOn: true, segType: "line" },
      { x: 8, y: 2, theta: 180, thetaOn: true },
    ]);
    const range = {
      anchor: "param" as const, f0: 0.05, f1: 0.95,
      maxVel: 4, maxAccel: 5, maxDecel: 5, maxAngVel: 60, maxAngAccel: 120,
      rotationPriority: "translation" as const,
    };
    path.ranges = [range];
    path.ranges.push({ ...range, f0: 0.35, f1: 0.65, rotationPriority: "heading" });
    const mixed = getPlanner(plannerId).generate({ path, robot: project.robot });
    const midpoint = mixed.samples.reduce((nearest, sample) => (
      Math.abs(sample.f - 0.5) < Math.abs(nearest.f - 0.5) ? sample : nearest
    ));

    expect(mixed.totalTimeS).toBeGreaterThan(0);
    expect(midpoint.headingRad).toBeCloseTo(Math.PI / 2, 2);
    expect(mixed.diagnostics.some((issue) => issue.severity === "error")).toBe(false);
    expect(Math.max(...mixed.samples.map((sample) => Math.abs(sample.angularVelocityRadps))))
      .toBeLessThanOrEqual(path.constraints.maxAngVel * Math.PI / 180 * 1.02);
  });

  it.each(PLANNERS)("ends translation priority at its authored range in %s", (plannerId) => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "targets";
    path.waypoints = buildWaypoints([
      { x: 1, y: 2, theta: 0, thetaOn: true, segType: "line", segmentHeadingMode: "targets" },
      { x: 5, y: 2, theta: 90, thetaOn: true, segType: "line", segmentHeadingMode: "targets" },
      { x: 9, y: 2, theta: 90, thetaOn: true },
    ]);
    path.ranges = [{
      anchor: "param", f0: 0.05, f1: 0.2,
      maxVel: path.constraints.maxVel,
      maxAccel: path.constraints.maxAccel,
      maxDecel: path.constraints.maxDecel,
      maxAngVel: path.constraints.maxAngVel,
      maxAngAccel: path.constraints.maxAngAccel,
      rotationPriority: "translation",
    }];

    const result = getPlanner(plannerId).generate({ path, robot: project.robot });
    const later = result.samples.reduce((nearest, sample) => (
      Math.abs(sample.f - 0.75) < Math.abs(nearest.f - 0.75) ? sample : nearest
    ));
    expect(later.headingRad).toBeCloseTo(Math.PI / 2, 3);
    expect(result.diagnostics.some((issue) => issue.severity === "error")).toBe(false);
  });

  it("does not extend translation priority across range boundary contact", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.waypoints = buildWaypoints([
      { x: 0, y: 0, theta: 0, segType: "line" },
      { x: 1, y: 0, theta: 0 },
    ]);
    path.ranges = [{
      anchor: "param", f0: 0.1, f1: 0.3,
      maxVel: path.constraints.maxVel,
      maxAccel: path.constraints.maxAccel,
      maxDecel: path.constraints.maxDecel,
      maxAngVel: path.constraints.maxAngVel,
      maxAngAccel: path.constraints.maxAngAccel,
      rotationPriority: "translation",
    }];
    const samples = [0, 0.1, 0.2, 0.3, 0.4, 0.5].map((f, index) => ({
      i: index, t: index, s: f, f, x: f, y: 0,
      headingRad: 0, velocityMps: 1, accelerationMps2: 0,
      angularVelocityRadps: 0, curvatureInvM: 0,
    }));

    expect(translationPriorityIntervalMask(path, samples, 1))
      .toEqual([false, true, true, false, false]);
  });

  it("honors range angular acceleration in the profiled trajectory", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "manual";
    path.constraints.maxAngVel = 360;
    path.constraints.maxAngAccel = 720;
    path.constraints.maxAngDecel = 720;
    path.waypoints = buildWaypoints([
      { x: 1, y: 2, theta: 0, thetaOn: true, segType: "line" },
      { x: 8, y: 2, theta: 180, thetaOn: true },
    ]);
    path.ranges = [{
      anchor: "param", f0: 0, f1: 1,
      maxVel: 4, maxAccel: 5, maxDecel: 5, maxAngVel: 360, maxAngAccel: 10,
      rotationPriority: "heading",
    }];

    const result = getPlanner("profiledSpline").generate({ path, robot: project.robot });
    const peakAngularAcceleration = Math.max(...result.samples.slice(1).map((sample, index) => {
      const previous = result.samples[index];
      return Math.abs(sample.angularVelocityRadps - previous.angularVelocityRadps)
        / Math.max(1e-9, sample.t - previous.t);
    }));

    expect(peakAngularAcceleration).toBeLessThanOrEqual(10 * Math.PI / 180 * 1.05);
  });

  it("keeps a disjoint translation-priority stretch local when a later heading range tightens", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "manual";
    path.constraints.maxVel = 4;
    path.constraints.maxAccel = 5;
    path.constraints.maxDecel = 5;
    path.constraints.maxAngVel = 180;
    path.constraints.maxAngAccel = 360;
    path.constraints.maxAngDecel = 360;
    path.waypoints = buildWaypoints([
      { x: 0.5, y: 2, theta: 0, thetaOn: true, segType: "line" },
      { x: 15.5, y: 2, theta: 180, thetaOn: true },
    ]);
    const common = { maxVel: 4, maxAccel: 5, maxDecel: 5, maxAngAccel: 360 };
    path.ranges = [{
      anchor: "param", f0: 0.1, f1: 0.3,
      ...common, maxAngVel: 180, rotationPriority: "translation",
    }];
    const translationOnly = getPlanner("profiledSpline").generate({ path: structuredClone(path), robot: project.robot });
    path.ranges.push({
      anchor: "param", f0: 0.72, f1: 0.9,
      ...common, maxAngVel: 20, rotationPriority: "heading",
    });
    const mixed = getPlanner("profiledSpline").generate({ path, robot: project.robot });
    const nearest = (samples: typeof mixed.samples, fraction: number) => samples.reduce((best, sample) => (
      Math.abs(sample.f - fraction) < Math.abs(best.f - fraction) ? sample : best
    ));
    const before = nearest(translationOnly.samples, 0.2);
    const after = nearest(mixed.samples, 0.2);
    expect(after.t).toBeCloseTo(before.t, 1);
    expect(after.velocityMps).toBeCloseTo(before.velocityMps, 1);
    expect(mixed.totalTimeS).toBeGreaterThan(translationOnly.totalTimeS);
  });

  it("restores heading priority after an early translation range ends", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "manual";
    path.constraints = {
      ...path.constraints,
      maxVel: 4, maxAccel: 5, maxDecel: 5, maxAngVel: 30, maxAngAccel: 60,
    };
    path.waypoints = buildWaypoints([
      { x: 0.5, y: 2, theta: 0, thetaOn: true, segType: "line" },
      { x: 5.5, y: 2, theta: 0, thetaOn: true, segType: "line" },
      { x: 15.5, y: 2, theta: 180, thetaOn: true },
    ]);
    path.ranges = [{
      anchor: "param", f0: 0.05, f1: 0.15,
      maxVel: 4, maxAccel: 5, maxDecel: 5, maxAngVel: 30, maxAngAccel: 60,
      rotationPriority: "heading",
    }];
    const headingPriority = getPlanner("profiledSpline").generate({ path: structuredClone(path), robot: project.robot });
    path.ranges[0].rotationPriority = "translation";
    const localizedTranslation = getPlanner("profiledSpline").generate({ path, robot: project.robot });

    expect(Math.max(...headingPriority.samples.filter((sample) => sample.f > 0.4).map((sample) => sample.velocityMps)))
      .toBeLessThan(4);
    const laterMotion = localizedTranslation.samples.filter((sample) => sample.f > 0.4 && sample.velocityMps > 1e-3);
    laterMotion.forEach((sample) => {
      const baseline = headingPriority.samples.reduce((nearest, candidate) => (
        Math.abs(candidate.f - sample.f) < Math.abs(nearest.f - sample.f) ? candidate : nearest
      ));
      expect(sample.velocityMps).toBe(baseline.velocityMps);
    });
    expect(localizedTranslation.totalTimeS - headingPriority.totalTimeS).toBeLessThan(0.05);
  });

  it("keeps angular tracking bounded until heading and velocity settle", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    const dt = 0.02;
    const sampleCount = 301;
    const rangeEnd = 0.4 / 6;
    path.headingMode = "manual";
    path.constraints.maxAngVel = 360;
    path.constraints.maxAngAccel = 30;
    path.constraints.maxAngDecel = 30;
    path.waypoints = buildWaypoints([
      { x: 0, y: 0, theta: 0, thetaOn: true, segType: "line" },
      { x: 6, y: 0, theta: 180, thetaOn: true },
    ]);
    path.ranges = [{
      anchor: "param", f0: 0, f1: rangeEnd,
      maxVel: 4, maxAccel: 5, maxDecel: 5, maxAngVel: 360, maxAngAccel: 30,
      rotationPriority: "translation",
    }];
    const desired = Array.from({ length: sampleCount }, (_, index) => (
      0.3 * Math.sin(Math.min(index * dt, 3.5) * 3)
    ));
    const samples = desired.map((headingRad, index) => ({
      i: index,
      t: index * dt,
      s: index * dt,
      f: index / (sampleCount - 1),
      x: index * dt,
      y: 0,
      headingRad,
      velocityMps: 1,
      accelerationMps2: 0,
      angularVelocityRadps: index === 0 ? 0 : PM.angWrap(headingRad - desired[index - 1]) / dt,
      curvatureInvM: 0,
    }));
    const raw: PlannerResult = {
      planner: "profiledSpline",
      samples,
      markers: [],
      diagnostics: [],
      totalDistanceM: 6,
      totalTimeS: 6,
    };

    const tracked = applyRotationPriority(path, raw, project.robot);
    // Coupled tracking may slow through the reversal instead of reproducing
    // the retired translation-priority controller's exact catch-up sample.
    expect(tracked.samples.at(-1)!.headingRad).toBeCloseTo(desired.at(-1)!, 3);
    expect(tracked.samples.at(-1)!.angularVelocityRadps).toBeCloseTo(0, 3);
    const angularAcceleration = tracked.samples.slice(1).map((sample, index) => (
      Math.abs(sample.angularVelocityRadps - tracked.samples[index].angularVelocityRadps) / dt
    ));
    expect(Math.max(...angularAcceleration))
      .toBeLessThanOrEqual(path.constraints.maxAngAccel * Math.PI / 180 * 1.001);
    expect(tracked.diagnostics.some((issue) => issue.message.includes("angular limits"))).toBe(false);
  });

  it("keeps an earlier heading transition bounded when Translation is selected later", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "manual";
    path.constraints.maxVel = 4;
    path.constraints.maxAccel = 5;
    path.constraints.maxDecel = 5;
    path.constraints.maxAngVel = 180;
    path.constraints.maxAngAccel = 30;
    path.constraints.maxAngDecel = 30;
    path.waypoints = buildWaypoints([
      { x: 0.5, y: 2, theta: 0, thetaOn: true, segType: "line" },
      { x: 5.5, y: 2, theta: 90, thetaOn: true, segType: "line" },
      { x: 15.5, y: 2, theta: 90, thetaOn: true },
    ]);
    path.ranges = [{
      anchor: "param", f0: 0.72, f1: 0.9,
      maxVel: 4, maxAccel: 5, maxDecel: 5, maxAngVel: 180, maxAngAccel: 30,
      rotationPriority: "translation",
    }];
    const result = getPlanner("profiledSpline").generate({ path, robot: project.robot });
    const prefix = result.samples.filter((sample) => sample.f <= 0.5);
    const prefixAcceleration = prefix.slice(1).map((sample, index) => (
      Math.abs(sample.angularVelocityRadps - prefix[index].angularVelocityRadps)
      / Math.max(1e-9, sample.t - prefix[index].t)
    ));
    expect(result.diagnostics.some((issue) => issue.severity === "error" && issue.message.includes("angular"))).toBe(false);
    expect(Math.max(...prefix.map((sample) => Math.abs(sample.angularVelocityRadps))))
      .toBeLessThanOrEqual(path.constraints.maxAngVel * Math.PI / 180 * 1.02);
    expect(Math.max(...prefixAcceleration))
      .toBeLessThanOrEqual(path.constraints.maxAngAccel * Math.PI / 180 * 1.04);
  });

  it("does not silently exceed angular jerk in the coupled trajectory", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "manual";
    path.constraints.maxAngJerk = 1;
    path.waypoints = buildWaypoints([
      { x: 1, y: 2, theta: 0, thetaOn: true, segType: "line" },
      { x: 5, y: 2, theta: 90, thetaOn: true, segType: "line" },
      { x: 9, y: 2, theta: 90, thetaOn: true },
    ]);
    path.ranges = [{
      anchor: "param", f0: 0.7, f1: 0.9,
      maxVel: path.constraints.maxVel,
      maxAccel: path.constraints.maxAccel,
      maxDecel: path.constraints.maxDecel,
      maxAngVel: path.constraints.maxAngVel,
      maxAngAccel: path.constraints.maxAngAccel,
      rotationPriority: "translation",
    }];
    const result = getPlanner("profiledSpline").generate({ path, robot: project.robot });

    expect(result.diagnostics.some((issue) => issue.severity === "error")).toBe(false);
    const accelerations = result.samples.slice(1).map((sample, index) => (
      (sample.angularVelocityRadps - result.samples[index].angularVelocityRadps)
      / Math.max(1e-9, sample.t - result.samples[index].t)
    ));
    const jerks = accelerations.slice(1).map((acceleration, index) => (
      Math.abs(acceleration - accelerations[index])
      / Math.max(1e-9, result.samples[index + 2].t - result.samples[index + 1].t)
    ));
    expect(Math.max(...jerks)).toBeLessThanOrEqual(path.constraints.maxAngJerk * Math.PI / 180 * 1.04);
  });

  it.each(PLANNERS)("tracks a field point with %s", (plannerId) => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.waypoints[0].segmentHeadingMode = "lookAt";
    path.waypoints[0].segmentLookAt = { x: 3.6, y: 6 };
    const result = getPlanner(plannerId).generate({ path, robot: project.robot });
    const first = result.samples[0], last = result.samples.at(-1)!;

    expect(first.headingRad).toBeCloseTo(Math.atan2(2, 1.4), 3);
    expect(last.headingRad).toBeCloseTo(Math.atan2(2, -1.4), 3);
    expect(result.samples.every((sample) => Number.isFinite(sample.headingRad))).toBe(true);
  });

  it.each(PLANNERS)("keeps a track-point to tangent transition continuous with %s", (plannerId) => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "manual";
    path.waypoints = buildWaypoints([
      { x: 2, y: 2, theta: 45, thetaOn: true, segType: "line", segmentHeadingMode: "lookAt", segmentLookAt: { x: 4, y: 4 } },
      { x: 4, y: 2, theta: 0, thetaOn: true, segType: "line", segmentHeadingMode: "tangent" },
      { x: 7, y: 2, theta: 0, thetaOn: true },
    ]);

    const result = getPlanner(plannerId).generate({ path, robot: project.robot });
    let boundary = 1;
    for (let index = 1; index < result.samples.length; index += 1) {
      if (Math.abs(result.samples[index].x - 4) < Math.abs(result.samples[boundary].x - 4)) boundary = index;
    }
    const jump = Math.abs(PM.angWrap(result.samples[boundary].headingRad - result.samples[boundary - 1].headingRad));

    expect(jump).toBeLessThan(0.12);
    expect(result.samples.at(-1)!.headingRad).toBeCloseTo(0, 2);
    expect(Math.max(...result.samples.map((sample) => Math.abs(sample.angularVelocityRadps)))).toBeLessThanOrEqual(path.constraints.maxAngVel * Math.PI / 180 * 1.03);
  });

  it.each(PLANNERS)("keeps track-point heading continuous through a stopped sharp corner with %s", (plannerId) => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "manual";
    path.waypoints = buildWaypoints([
      { x: 2, y: 2, theta: 0, thetaOn: true, segType: "line", segmentHeadingMode: "lookAt", segmentLookAt: { x: 6, y: 2.2 } },
      { x: 4, y: 2, theta: 90, thetaOn: true, stop: true, segType: "line", segmentHeadingMode: "tangent" },
      { x: 4, y: 5, theta: 90, thetaOn: true },
    ]);

    const result = getPlanner(plannerId).generate({ path, robot: project.robot });
    const adjacentJumps = result.samples.slice(1).map((sample, index) =>
      Math.abs(PM.angWrap(sample.headingRad - result.samples[index].headingRad)));

    expect(Math.max(...adjacentJumps)).toBeLessThan(0.22);
    expect(result.samples.at(-1)!.headingRad).toBeCloseTo(Math.PI / 2, 2);
  });

  it.each(PLANNERS)("rotates in place at a stopped sharp %s tangent corner", (plannerId) => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "tangent";
    path.waypoints = buildWaypoints([
      { x: 2, y: 2, theta: 0, thetaOn: true, segType: "line", segmentHeadingMode: "tangent" },
      { x: 5, y: 2, theta: 90, thetaOn: true, stop: true, segType: "line", segmentHeadingMode: "tangent" },
      { x: 5, y: 5, theta: 90, thetaOn: true },
    ]);

    const result = getPlanner(plannerId).generate({ path, robot: project.robot });
    const adjacentJumps = result.samples.slice(1).map((sample, index) => (
      Math.abs(PM.angWrap(sample.headingRad - result.samples[index].headingRad))
    ));

    expect(Math.max(...adjacentJumps)).toBeLessThan(0.22);
    expect(result.totalTimeS).toBeLessThan(4);
    expect(result.stationaryActions).toContainEqual(expect.objectContaining({ kind: "turn", waypointIndex: 1 }));
  });

  it.each(PLANNERS)("keeps adjacent tracked points continuous with %s", (plannerId) => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.waypoints = buildWaypoints([
      { x: 2, y: 2, theta: 45, segType: "line", segmentHeadingMode: "lookAt", segmentLookAt: { x: 4, y: 4 } },
      { x: 4, y: 2, theta: 0, segType: "line", segmentHeadingMode: "lookAt", segmentLookAt: { x: 8, y: 0 } },
      { x: 7, y: 2, theta: 0 },
    ]);
    const result = getPlanner(plannerId).generate({ path, robot: project.robot });
    let boundary = 1;
    for (let index = 1; index < result.samples.length; index += 1) {
      if (Math.abs(result.samples[index].x - 4) < Math.abs(result.samples[boundary].x - 4)) boundary = index;
    }

    expect(Math.abs(PM.angWrap(result.samples[boundary].headingRad - result.samples[boundary - 1].headingRad))).toBeLessThan(0.12);
  });

  it.each(PLANNERS)("rejects a track point on the driven segment with %s", (plannerId) => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.waypoints[0].segmentHeadingMode = "lookAt";
    path.waypoints[0].segmentLookAt = { x: 3.6, y: 4 };
    const result = getPlanner(plannerId).generate({ path, robot: project.robot });
    expect(result.diagnostics.some((issue) => issue.severity === "error" && issue.message.includes("lies on the driven segment"))).toBe(true);
  });

  it("applies drive backward after resolving a tracked point", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.waypoints[0].segmentHeadingMode = "lookAt";
    path.waypoints[0].segmentLookAt = { x: 3.6, y: 6 };
    const forward = getPlanner("profiledSpline").generate({ path, robot: project.robot });
    path.driveBackward = true;
    const reverse = getPlanner("profiledSpline").generate({ path, robot: project.robot });
    expect(Math.abs(PM.angWrap(reverse.samples[0].headingRad - forward.samples[0].headingRad))).toBeCloseTo(Math.PI, 5);
  });

  it("rejects malformed local constraint segment anchors", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    const range = {
      anchor: "wp" as const,
      f0: 0.2,
      f1: 0.8,
      w0: 0.5,
      t0: 0.2,
      w1: path.waypoints.length - 1,
      t1: 0.8,
      maxVel: 2,
      maxAccel: 2,
      maxDecel: 2,
      maxAngVel: 180,
      maxAngAccel: 360,
    };
    path.ranges = [range];

    const issues = validateProject(project).issues;
    expect(issues.some((issue) => issue.path.endsWith(".w0") && issue.message.includes("integer"))).toBe(true);
    expect(issues.some((issue) => issue.path.endsWith(".w1") && issue.message.includes("outside"))).toBe(true);
  });

  it.each(PLANNERS)("adds a constrained stationary turn after %s planning", (plannerId) => {
    const project = createDemoProject();
    const path = project.paths[0];
    const end = path.waypoints.at(-1)!;
    end.stop = true;
    end.wait = 0.12;
    end.turnInPlace = { headingDeg: 90, direction: "counterclockwise" };
    path.markers = [{ id: "shoot", f: 1, name: "Shoot" }];
    const result = getPlanner(plannerId).generate({ path, robot: project.robot });
    const terminal = result.samples.filter((sample) => Math.hypot(sample.x - end.x, sample.y - end.y) < 1e-5);

    expect(terminal.length).toBeGreaterThan(2);
    expect(terminal.every((sample) => Math.abs(sample.velocityMps) < 1e-8 && Math.abs(sample.accelerationMps2) < 1e-8)).toBe(true);
    expect(terminal.at(-1)!.headingRad).toBeCloseTo(Math.PI / 2, 6);
    const firstAtTarget = terminal.findIndex((sample) => Math.abs(PM.angWrap(sample.headingRad - Math.PI / 2)) < 1e-6);
    expect(firstAtTarget).toBeGreaterThanOrEqual(0);
    expect(terminal.at(-1)!.t - terminal[firstAtTarget].t).toBeGreaterThanOrEqual(end.wait - 1e-6);
    expect(result.samples.every((sample, index) => index === 0 || sample.t > result.samples[index - 1].t)).toBe(true);
    expect(Math.max(...terminal.map((sample) => Math.abs(sample.angularVelocityRadps)))).toBeLessThanOrEqual(path.constraints.maxAngVel * Math.PI / 180 * 1.02);
    const angularAcceleration = terminal.slice(1).map((sample, index) => (sample.angularVelocityRadps - terminal[index].angularVelocityRadps) / (sample.t - terminal[index].t));
    expect(Math.max(...angularAcceleration.map(Math.abs))).toBeLessThanOrEqual(path.constraints.maxAngAccel * Math.PI / 180 * 1.03);
    expect(result.markers[0].timeS).toBeCloseTo(result.totalTimeS, 6);
    expect(result.stationaryActions).toEqual([
      expect.objectContaining({ kind: "turn", waypointIndex: path.waypoints.length - 1, fraction: 1 }),
      expect.objectContaining({ kind: "wait", waypointIndex: path.waypoints.length - 1, fraction: 1 }),
    ]);
    expect(result.stationaryActions![0].startTimeS).toBeCloseTo(terminal[0].t, 8);
    expect(result.stationaryActions![1].endTimeS).toBeCloseTo(result.totalTimeS, 8);
  });

  it.each(PLANNERS)("keeps an interior %s turn continuous with its outgoing segment", (plannerId) => {
    const project = interiorTurnProject();
    const path = project.paths[0];
    const withoutTurn = structuredClone(path);
    delete withoutTurn.waypoints[1].turnInPlace;
    withoutTurn.waypoints[1].segmentHeadingMode = "tangent";
    withoutTurn.waypoints[1].theta = 0;
    withoutTurn.waypoints[2].theta = 0;
    const baseline = getPlanner(plannerId).generate({ path: withoutTurn, robot: project.robot });
    const result = getPlanner(plannerId).generate({ path, robot: project.robot });
    expect(result.diagnostics.some((issue) => issue.severity === "error")).toBe(false);
    expect(result.totalTimeS - baseline.totalTimeS).toBeGreaterThan(0.7);
    expect(result.totalTimeS - baseline.totalTimeS).toBeLessThan(1.05);
    expect(result.samples.every((sample, index) => index === 0 || sample.t > result.samples[index - 1].t)).toBe(true);

    const boundarySamples = result.samples.filter((sample) => Math.hypot(sample.x - 4, sample.y - 2) < 1e-5);
    expect(boundarySamples.length).toBeGreaterThan(2);
    expect(boundarySamples.every((sample) => Math.abs(sample.velocityMps) < 1e-8)).toBe(true);
    expect(boundarySamples.at(-1)!.headingRad).toBeCloseTo(Math.PI / 2, 6);
    const firstAtTarget = boundarySamples.findIndex((sample) => Math.abs(PM.angWrap(sample.headingRad - Math.PI / 2)) < 1e-6);
    expect(firstAtTarget).toBeGreaterThanOrEqual(0);
    expect(boundarySamples.at(-1)!.t - boundarySamples[firstAtTarget].t).toBeGreaterThanOrEqual(path.waypoints[1].wait! - 1e-6);

    let lastBoundary = -1;
    for (let index = result.samples.length - 1; index >= 0; index -= 1) {
      if (Math.hypot(result.samples[index].x - 4, result.samples[index].y - 2) < 1e-5) { lastBoundary = index; break; }
    }
    const outgoing = result.samples[lastBoundary + 1];
    expect(outgoing).toBeDefined();
    expect(PM.angWrap(outgoing.headingRad - Math.PI / 2)).toBeCloseTo(0, 2);
    expect(Math.abs(outgoing.angularVelocityRadps)).toBeLessThanOrEqual(path.constraints.maxAngVel * Math.PI / 180 * 1.02);
  });

  it.each(PLANNERS)("rejects an interior %s turn that disagrees with the outgoing heading", (plannerId) => {
    const project = interiorTurnProject();
    const path = project.paths[0];
    path.waypoints[1].turnInPlace = { headingDeg: 45 };
    const result = getPlanner(plannerId).generate({ path, robot: project.robot });

    expect(result.diagnostics.some((issue) => issue.severity === "error" && issue.message.includes("outgoing segment heading"))).toBe(true);
  });

  it("places a wait after an interior stationary turn", () => {
    const project = interiorTurnProject();
    const path = project.paths[0];
    const result = getPlanner("profiledSpline").generate({ path, robot: project.robot });
    const boundary = result.samples.filter((sample) => Math.hypot(sample.x - 4, sample.y - 2) < 1e-5);
    const targetSamples = boundary.filter((sample) => Math.abs(PM.angWrap(sample.headingRad - Math.PI / 2)) < 1e-6);

    expect(targetSamples.at(-1)!.t - targetSamples[0].t).toBeGreaterThanOrEqual(path.waypoints[1].wait! - 1e-6);
    expect(targetSamples.every((sample) => Math.abs(sample.velocityMps) < 1e-8)).toBe(true);
  });

  it.each(PLANNERS)("preserves an interior wait with %s even without a turn", (plannerId) => {
    const project = interiorTurnProject();
    const path = project.paths[0];
    delete path.waypoints[1].turnInPlace;
    path.waypoints[1].segmentHeadingMode = "tangent";
    path.waypoints[1].theta = 0;
    path.waypoints[2].theta = 0;
    const result = getPlanner(plannerId).generate({ path, robot: project.robot });
    const boundary = result.samples.filter((sample) => Math.hypot(sample.x - 4, sample.y - 2) < 1e-5);

    expect(boundary.length).toBeGreaterThan(2);
    expect(boundary.at(-1)!.t - boundary[0].t).toBeGreaterThanOrEqual(path.waypoints[1].wait! - 1e-6);
    expect(boundary.every((sample) => Math.abs(sample.velocityMps) < 1e-8)).toBe(true);
    expect(boundary.every((sample) => Math.abs(sample.f - 0.5) < 1e-5)).toBe(true);
    expect(boundary.every((sample) => Math.abs(sample.f - boundary[0].f) < 1e-8)).toBe(true);
    expect(result.samples.every((sample, index) => index === 0 || sample.f >= result.samples[index - 1].f - 1e-9)).toBe(true);
    result.samples.slice(1).forEach((sample, index) => {
      const previous = result.samples[index];
      const dt = sample.t - previous.t;
      const acceleration = Math.abs(sample.velocityMps - previous.velocityMps) / dt;
      expect(acceleration).toBeLessThanOrEqual(Math.max(path.constraints.maxAccel, path.constraints.maxDecel) * 1.05);
    });
  });

  it("validates track points and stopped turns without changing path-wide heading modes", () => {
    const project = createDemoProject();
    const segment = project.paths[0].waypoints[0];
    segment.segmentHeadingMode = "lookAt";
    expect(validateProject(project).issues.some((issue) => issue.path.endsWith("segmentLookAt"))).toBe(true);
    segment.segmentLookAt = { x: 3, y: 6 };
    project.paths[0].waypoints[1].turnInPlace = { headingDeg: 90 };
    expect(validateProject(project).issues.some((issue) => issue.message.includes("requires a stopped waypoint"))).toBe(true);
    project.paths[0].waypoints[1].stop = true;
    expect(validateProject(project).ok).toBe(true);
    const decoded = decodeProjectFile(JSON.stringify(project)).project.paths[0];
    expect(decoded.waypoints[0].segmentLookAt).toEqual({ x: 3, y: 6 });
    expect(decoded.waypoints[1].turnInPlace).toEqual({ headingDeg: 90 });
  });

  it("builds a deterministic multi-direction jiggle and rejects repeated directions", () => {
    const anchor = { x: 5, y: 4 };
    const positions = PM.jigglePositions(anchor, 0, { distanceM: 0.2, strokes: 4, startDeg: 90, stepDeg: -90 });

    expect(positions).toHaveLength(8);
    positions!.forEach((point, index) => {
      if (index % 2) expect(point).toEqual(anchor);
      else expect(Math.hypot(point.x - anchor.x, point.y - anchor.y)).toBeCloseTo(0.2, 10);
    });
    expect(PM.jigglePositions(anchor, 0, { distanceM: 0.2, strokes: 4, startDeg: 0, stepDeg: 180 })).toBeNull();
    expect(PM.jigglePositions({ x: 0.05, y: 0.05 }, 0, { distanceM: 0.2, strokes: 2, startDeg: 180, stepDeg: 90 })).toBeNull();
  });

  it.each(PLANNERS)("expands a fast endpoint jiggle into samples without adding %s waypoints", (plannerId) => {
    const project = createDemoProject();
    const path = project.paths[0];
    const baselinePath = structuredClone(path);
    const waypointCount = path.waypoints.length;
    const end = path.waypoints.at(-1)!;
    end.jiggle = { distanceM: 0.18, strokes: 4, startDeg: 90, stepDeg: -90, strokeTimeS: 0.4 };

    const baseline = getPlanner(plannerId).generate({ path: baselinePath, robot: project.robot });
    const result = getPlanner(plannerId).generate({ path, robot: project.robot });
    const actionSamples = result.samples.filter((sample) => sample.t > baseline.totalTimeS + 1e-8);

    expect(path.waypoints).toHaveLength(waypointCount);
    expect(result.totalTimeS - baseline.totalTimeS).toBeGreaterThan(1.6);
    expect(result.totalTimeS - baseline.totalTimeS).toBeLessThan(3.2);
    expect(result.totalDistanceM - baseline.totalDistanceM).toBeCloseTo(1.44, 6);
    expect(actionSamples.some((sample) => Math.hypot(sample.x - end.x, sample.y - end.y) > 0.1)).toBe(true);
    expect(result.samples.at(-1)!.x).toBeCloseTo(end.x, 8);
    expect(result.samples.at(-1)!.y).toBeCloseTo(end.y, 8);
    expect(result.samples.at(-1)!.velocityMps).toBeCloseTo(0, 8);
    expect(result.samples.at(-1)!.accelerationMps2).toBeCloseTo(0, 8);
    expect(result.samples.every((sample, index) => index === 0 || sample.t > result.samples[index - 1].t)).toBe(true);
    actionSamples.forEach((sample) => {
      if (sample.accelerationMps2 > 0) {
        const available = path.constraints.maxAccel * Math.max(0, 1 - sample.velocityMps / project.robot.maxSpeed);
        expect(sample.accelerationMps2).toBeLessThanOrEqual(available + 0.05);
      } else {
        expect(Math.abs(sample.accelerationMps2)).toBeLessThanOrEqual(path.constraints.maxDecel + 0.05);
      }
    });
  });

  it("rejects arbitrary-direction jiggle on a tank drivetrain", () => {
    const project = createDemoProject();
    project.robot.drive = "tank";
    const path = project.paths[0];
    const end = path.waypoints.at(-1)!;
    end.jiggle = { distanceM: 0.18, strokes: 4, startDeg: 90, stepDeg: -90, strokeTimeS: 0.4 };
    const baselinePath = structuredClone(path);
    delete baselinePath.waypoints.at(-1)!.jiggle;

    expect(validateProject(project).issues.some((issue) => issue.path.endsWith(".jiggle") && issue.message.includes("swerve"))).toBe(true);
    const baseline = getPlanner("profiledSpline").generate({ path: baselinePath, robot: project.robot });
    const result = getPlanner("profiledSpline").generate({ path, robot: project.robot });
    expect(result.diagnostics.filter((issue) => issue.path.endsWith(".jiggle"))).toHaveLength(1);
    expect(result.diagnostics.some((issue) => issue.message.includes("swerve"))).toBe(true);
    expect(result.totalDistanceM).toBeCloseTo(baseline.totalDistanceM, 8);
  });

  it("round-trips endpoint jiggle metadata and rejects repeated directions", () => {
    const project = createDemoProject();
    const end = project.paths[0].waypoints.at(-1)!;
    end.jiggle = { distanceM: 0.18, strokes: 4, startDeg: 90, stepDeg: -90, strokeTimeS: 0.4 };

    expect(validateProject(project).ok).toBe(true);
    expect(decodeProjectFile(JSON.stringify(project)).project.paths[0].waypoints.at(-1)!.jiggle).toEqual(end.jiggle);

    end.jiggle.stepDeg = 180;
    expect(validateProject(project).issues.some((issue) => issue.path.endsWith(".jiggle.stepDeg") && issue.message.includes("must not repeat"))).toBe(true);
  });

});
