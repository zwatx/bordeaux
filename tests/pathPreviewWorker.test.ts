import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error The production worker is an intentional JavaScript module.
import { applyFinalTrajectoryToPreview, previewForTrajectory, processPathPreviewJob } from "../src/renderer/assets/path-preview-worker";
// @ts-expect-error The renderer path math is an intentional JavaScript module.
import { PM } from "../src/renderer/lib/pathMath";
import { fixedPathSamples, getPlanner } from "../src/shared/planners";
import { optimizeFixedGeometryFinal } from "../src/shared/planners/fixedGeometryFinal";
import { optimizeCorridorFinal } from "../src/shared/planners/corridorFinal";
import { createAcceptedTrajectory } from "../src/shared/planners/acceptedTrajectory";
import { scaleTrajectoryTiming } from "../src/shared/planners/optimizedTrajectory";
import { buildWaypoints, createDemoProject, defaultPathConstraints } from "../src/shared/project/defaults";

function derived(): any {
  return {
    sample: { length: 2, pts: [{ x: 0, y: 0, s: 0 }, { x: 1, y: 0, s: 1 }, { x: 2, y: 0, s: 2 }] },
    prof: { t: [0, 1, 2], v: [0, 1, 0], totalTime: 2, holds: [], turns: [], jiggles: [] },
    metrics: { head: [0, 0, 0], v: [0, 1, 0], accel: [0, 0, 0], omega: [0, 0, 0], curv: [0, 0, 0] },
    anchors: [{ f: 0, rad: 0 }, { f: 1, rad: 0 }],
    mode: "targets",
    rev: false,
  };
}

function finalTrajectory(status = "optimal"): any {
  return {
    planner: status === "equivalent" ? "profiledSpline" : "optimizedTrajectory",
    totalTimeS: 1.8,
    totalDistanceM: 2,
    samples: [
      { i: 0, t: 0, s: 0, f: 0, x: 0, y: 0, headingRad: 0, velocityMps: 0, accelerationMps2: 0, angularVelocityRadps: 0, curvatureInvM: 0 },
      { i: 1, t: 0.9, s: 1, f: 0.5, x: 1, y: 0, headingRad: 0, velocityMps: 1.2, accelerationMps2: 0.1, angularVelocityRadps: 0, curvatureInvM: 0 },
      { i: 2, t: 1.8, s: 2, f: 1, x: 2, y: 0, headingRad: 0, velocityMps: 0, accelerationMps2: 0, angularVelocityRadps: 0, curvatureInvM: 0 },
    ],
    markers: [],
    diagnostics: [],
    optimization: { status, totalTimeS: 1.8, solveTimeMs: 12, fallback: false, constraintViolations: 0 },
  };
}

describe("path preview worker final optimization", () => {
  it.each(['unknown', 'valid', 'invalid'])('preserves explicit %s seed qualification in checkpoints and completion', (seedStatus) => {
    const messages: any[] = [];
    const candidate = finalTrajectory(); candidate.optimization.seedStatus = seedStatus;
    const result = processPathPreviewJob({ id: 1, quality: 'final', optimize: true, path: {}, robot: {}, perSegment: 56 }, derived,
      (_input: unknown, options: any) => {
        options.onProgress(candidate);
        return { candidate, status: 'feasible', seedStatus };
      }, undefined, (message: unknown) => messages.push(message));
    expect(result.error).toBeUndefined();
    expect(result.value.routeSearch.seedStatus).toBe(seedStatus);
    expect(messages).toHaveLength(1);
    expect(messages[0].value.routeSearch.seedStatus).toBe(seedStatus);
    expect(messages[0].value.finalTrajectory.optimization.seedStatus).toBe(seedStatus);
  });
  it.each(['unsupported', 'no-candidate', 'cancelled'])('preserves a route-search %s outcome without inventing a preview', (status) => {
    const project = createDemoProject();
    const derive = () => { throw new Error('No candidate exists to project'); };
    const result = processPathPreviewJob({ id: 1, quality: 'final', optimize: true, path: project.paths[0], robot: project.robot }, derive,
      () => ({ status, reason: 'Bounded search outcome', termination: status === 'unsupported' ? 'unsupported' : 'work-budget', statistics: { evaluations: 4 } }));
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({ routeSearch: { status, reason: 'Bounded search outcome', termination: status === 'unsupported' ? 'unsupported' : 'work-budget', statistics: { evaluations: 4 }, seedStatus: 'unknown' } });
    expect(result.value.finalTrajectory).toBeUndefined();
  });

  it('projects solver geometry while editor waypoint indices retain their required-point meaning', () => {
    const project = createDemoProject();
    const geometry = { ...derived(), wpIdx: [0, 1, 2], wpFrac: [0, .5, 1] };
    const trajectory = { ...finalTrajectory(), routeGeometry: { version: 1, requiredPointIndices: [0, 2] } };
    const result = previewForTrajectory(project.paths[0], project.robot, trajectory, () => geometry);
    expect(result.wpIdx).toEqual([0, 2]);
    expect(result.wpFrac).toEqual([0, 1]);
    expect(result.prof.totalTime).toBe(trajectory.totalTimeS);
    expect(result.finalTrajectory).toBe(trajectory);
    expect(geometry.wpIdx).toEqual([0, 1, 2]);
  });
  it("keeps interactive edits independent from full physics planning", () => {
    const project = createDemoProject();
    const interactive = derived();
    let profileCalls = 0;

    const result = processPathPreviewJob(
      {
        id: 1,
        quality: "interactive",
        plannerId: "profiledSpline",
        path: project.paths[0],
        robot: project.robot,
        perSegment: 14,
      },
      () => interactive,
      () => { throw new Error("final optimization must not run during an interactive edit"); },
      () => {
        profileCalls += 1;
        return finalTrajectory();
      },
    );

    expect(result.error).toBeUndefined();
    expect(profileCalls).toBe(0);
    expect(result.value).toBe(interactive);
    expect(result.value.finalTrajectory).toBeUndefined();
  });

  it("accepts a rounded final trajectory for a tight but valid swerve curve", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "targets";
    path.waypoints = buildWaypoints([
      { x: 7.6, y: 3.5, theta: 0, nextC: { x: 8.38, y: 3.5 } },
      { x: 9.11, y: 6.85, theta: 0, prevC: { x: 8.33, y: 6.85 } },
    ]);

    const result = processPathPreviewJob({
      id: 1,
      quality: "final",
      plannerId: "optimizedTrajectory", optimize: true,
      path,
      robot: project.robot,
      perSegment: 56,
      deadline: "common",
      deadlineMs: 5_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.finalFallbackReason).toBeUndefined();
    expect(result.value.finalOptimization).toMatchObject({
      status: expect.stringMatching(/^(optimal|feasible|equivalent)$/),
      constraintViolations: 0,
      fallback: false,
    });

  });

  it("preserves legacy corridor projection of an automatic heading-law change without a spurious dense failure", () => {
    const project = createDemoProject();
    project.robot = {
      drive: "swerve",
      w: 0.84,
      l: 0.84,
      heightM: 0.5,
      maxSpeed: 5.346559406159112,
      driveModel: {
        motorId: "custom",
        motorFreeRpm: 6784,
        motorMaxTorqueNm: 3.6,
        motorCount: 4,
        gearRatio: 6.75,
        wheelDiameterM: 0.1016,
        massKg: 54,
        moiKgM2: 6.3504,
        wheelbaseM: 0.66,
        trackwidthM: 0.66,
        wheelFrictionCoefficient: 1.2,
      },
    };
    const path = project.paths[0];
    path.constraints = defaultPathConstraints(project.robot);
    path.headingMode = "targets";
    path.waypoints = buildWaypoints([
      {
        x: 5.02335590749547, y: 7.6112168063664285, theta: 0, thetaOn: true,
        prevC: { x: 4.2393559074954705, y: 7.6112168063664285 },
        nextC: { x: 5.807355907495469, y: 7.6112168063664285 },
        segmentHeadingMode: "tangent",
      },
      {
        x: 9.477630636385365, y: 5.423280381534321, theta: -92, thetaOn: true,
        prevC: { x: 9.515762463480733, y: 7.554726164696154 },
        nextC: { x: 9.438089244602958, y: 3.2130444921242236 },
        segType: "bezier",
        segmentHeadingMode: "tangent",
      },
      {
        x: 6.240701081452546, y: 5.360253479135731, theta: -92, thetaOn: true,
        prevC: { x: 7.412843675460446, y: 5.3456955819511 },
        nextC: { x: 5.3890506730188905, y: 5.370830894500216 },
        segType: "bezier",
        segmentHeadingMode: "targets",
        headingTransition: { placement: "after", rotationPriority: "heading", distanceM: 0.75 },
      },
      {
        x: 3.686728408847876, y: 5.437753715894135, theta: -92, thetaOn: true,
        prevC: { x: 4.538052633049433, y: 5.411920303641334 },
        nextC: { x: 2.8354041846463196, y: 5.463587128146936 },
      },
    ]);

    const fixed = optimizeFixedGeometryFinal({ path, robot: project.robot, samplesPerSegment: 56 });
    expect(fixed.optimization).toMatchObject({
      status: expect.stringMatching(/^(optimal|equivalent)$/),
      constraintViolations: 0,
      fallback: false,
    });

    const result = processPathPreviewJob({
      id: 2,
      quality: "final",
      plannerId: "optimizedTrajectory", optimize: true,
      path,
      robot: project.robot,
      perSegment: 56,
      deadline: "common",
      deadlineMs: 5_000,
    }, undefined, optimizeCorridorFinal);

    expect(result.error).toBeUndefined();
    expect(result.finalFallbackReason).toBeUndefined();
    expect(result.value.finalOptimization).toMatchObject({
      status: expect.stringMatching(/^(optimal|feasible|equivalent)$/),
      constraintViolations: 0,
      fallback: false,
    });

    const translationPriorityPath = structuredClone(path);
    translationPriorityPath.waypoints[2].headingTransition = {
      ...translationPriorityPath.waypoints[2].headingTransition,
      rotationPriority: "translation",
    };
    const translationPriority = processPathPreviewJob({
      id: 3,
      quality: "final",
      plannerId: "optimizedTrajectory", optimize: true,
      path: translationPriorityPath,
      robot: project.robot,
      perSegment: 56,
      deadline: "common",
      deadlineMs: 5_000,
    }, undefined, optimizeCorridorFinal);
    expect(translationPriority.error).toBeUndefined();
    expect(translationPriority.finalFallbackReason).toBeUndefined();
    expect(translationPriority.value.finalOptimization).toMatchObject({
      status: expect.stringMatching(/^(optimal|feasible|equivalent)$/),
      constraintViolations: 0,
      fallback: false,
    });

  }, 60_000);

  it("uses the shared planner as the final heading and timing authority", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "targets";
    path.waypoints = buildWaypoints([
      { x: 5, y: 7.5, theta: 0, thetaOn: true, segmentHeadingMode: "tangent" },
      { x: 9.4, y: 5.4, theta: 0, thetaOn: true, segmentHeadingMode: "tangent" },
      {
        x: 6.5,
        y: 5.35,
        theta: 0,
        thetaOn: true,
        segmentHeadingMode: "targets",
        headingTransition: { placement: "split", rotationPriority: "translation", distanceM: 0.75 },
      },
      { x: 3.6, y: 5.34, theta: -42, thetaOn: true },
    ]);

    const shared = getPlanner("profiledSpline").generate({ path, robot: project.robot, samplesPerSegment: 56 });
    const moving = fixedPathSamples(shared);
    for (const quality of ["final"] as const) {
      const preview = processPathPreviewJob({
        id: 4,
        quality,
        plannerId: "profiledSpline",
        path,
        robot: project.robot,
        perSegment: 56,
      });

      expect(preview.error).toBeUndefined();
      expect(preview.value.prof.t).toHaveLength(preview.value.sample.pts.length);
      expect(preview.value.metrics.head).toHaveLength(preview.value.sample.pts.length);
      preview.value.sample.pts.forEach((point: any, index: number) => {
        const nearest = moving.reduce((best, sample) => (
          Math.hypot(sample.x - point.x, sample.y - point.y)
            < Math.hypot(best.x - point.x, best.y - point.y) ? sample : best
        ));
        expect(Math.hypot(nearest.x - point.x, nearest.y - point.y)).toBeLessThan(0.001);
        expect(Math.abs(preview.value.prof.t[index] - nearest.t)).toBeLessThan(0.001);
        expect(Math.atan2(
          Math.sin(preview.value.metrics.head[index] - nearest.headingRad),
          Math.cos(preview.value.metrics.head[index] - nearest.headingRad),
        )).toBeCloseTo(0, 2);
      });
    }
  });

  it("preserves authored endpoint velocities when relaxing translation timing", () => {
    const trajectory = finalTrajectory();
    trajectory.samples[0].velocityMps = 1;
    trajectory.samples.at(-1).velocityMps = 1;

    const slowed = scaleTrajectoryTiming(trajectory, 0.5);

    expect(slowed.samples[0].velocityMps).toBe(1);
    expect(slowed.samples.at(-1)!.velocityMps).toBe(1);
    expect(slowed.samples[1].velocityMps).toBe(0.6);
    expect(slowed.totalTimeS).toBeGreaterThan(trajectory.totalTimeS);
  });

  it("preserves legacy terminal heading settling without a spurious final fallback", () => {
    const project = createDemoProject();
    project.robot = {
      drive: "swerve",
      w: 0.84,
      l: 0.84,
      heightM: 0.5,
      maxSpeed: 5.346559406159112,
      driveModel: {
        motorId: "custom",
        motorFreeRpm: 6784,
        motorMaxTorqueNm: 3.6,
        motorCount: 4,
        gearRatio: 6.75,
        wheelDiameterM: 0.1016,
        massKg: 54,
        moiKgM2: 6.3504,
        wheelbaseM: 0.66,
        trackwidthM: 0.66,
        wheelFrictionCoefficient: 1.2,
      },
    };
    const path = project.paths[0];
    path.headingMode = "targets";
    path.waypoints = buildWaypoints([
      {
        x: 5.023847794792925, y: 7.497700944080724, theta: 0, thetaOn: true,
        prevC: { x: 4.239847794792925, y: 7.497700944080724 },
        nextC: { x: 5.807847794792924, y: 7.497700944080724 },
        segmentHeadingMode: "tangent",
      },
      {
        x: 9.262529631988476, y: 5.4832778826522, theta: -91.02444054465735, thetaOn: true,
        prevC: { x: 9.25408073069426, y: 7.430237035505824 },
        nextC: { x: 9.27311245266581, y: 3.044579777035806 },
        segmentHeadingMode: "tangent",
      },
      {
        x: 6.406579551787691, y: 5.3352614492988994, theta: -91.02444054465735, thetaOn: true,
        prevC: { x: 7.647059296057265, y: 5.312709711523859 },
        nextC: { x: 5.527940124711653, y: 5.351234983771966 },
        segmentHeadingMode: "targets",
        headingTransition: { placement: "split", rotationPriority: "translation", distanceM: 0.75 },
      },
      {
        x: 3.3886885142254175, y: 5.378597597192225, theta: -37, thetaOn: true,
        prevC: { x: 4.267112072131432, y: 5.3534093155555365 },
        nextC: { x: 2.510264956319402, y: 5.403785878828913 },
      },
    ]);

    const result = processPathPreviewJob({
      id: 2,
      quality: "final",
      plannerId: "optimizedTrajectory", optimize: true,
      path,
      robot: project.robot,
      perSegment: 56,
      deadline: "common",
      deadlineMs: 1,
    }, undefined, optimizeCorridorFinal);

    expect(result.error).toBeUndefined();
    expect(result.finalFallbackReason).toBeUndefined();

    const nonzeroPath = structuredClone(path);
    nonzeroPath.waypoints.at(-1)!.theta = 90;
    const nonzero = processPathPreviewJob({
      id: 3,
      quality: "final",
      plannerId: "optimizedTrajectory", optimize: true,
      path: nonzeroPath,
      robot: project.robot,
      perSegment: 56,
      deadline: "common",
      deadlineMs: 1,
    }, undefined, optimizeCorridorFinal);
    expect(nonzero.error).toBeUndefined();
    expect(nonzero.finalFallbackReason).toBeUndefined();

    const withWaitPath = structuredClone(nonzeroPath);
    withWaitPath.waypoints.at(-1)!.stop = true;
    withWaitPath.waypoints.at(-1)!.wait = 0.12;
    const withWait = processPathPreviewJob({
      id: 4,
      quality: "final",
      plannerId: "optimizedTrajectory", optimize: true,
      path: withWaitPath,
      robot: project.robot,
      perSegment: 56,
      deadline: "common",
      deadlineMs: 1,
    }, undefined, optimizeCorridorFinal);
    expect(withWait.error).toBeUndefined();
    const catchupBeforeWait = withWait.value.prof.turns.find((turn: any) => turn.catchup);
    const terminalWait = withWait.value.prof.holds.find((hold: any) => hold.idx === withWait.value.sample.pts.length - 1);
    if (catchupBeforeWait) expect(catchupBeforeWait.t1).toBeCloseTo(terminalWait.t0, 8);
    const waitTime = (terminalWait.t0 + terminalWait.t1) / 2;
    const waitPose = PM.poseAtTime(
      waitTime,
      withWait.value.sample.pts,
      withWait.value.prof,
      withWait.value.anchors,
      withWait.value.mode,
      withWait.value.rev,
    );
    const finalWaitSample = withWait.value.finalTrajectory.samples.reduce((nearest: any, sample: any) => (
      Math.abs(sample.t - waitTime) < Math.abs(nearest.t - waitTime) ? sample : nearest
    ));
    expect(waitPose.heading).toBeCloseTo(finalWaitSample.headingRad, 6);
  }, 60_000);

  it("runs the corridor final optimizer only for an optimized final request", () => {
    const optimize = () => finalTrajectory();

    const result = processPathPreviewJob({
      id: 1, quality: "final", plannerId: "optimizedTrajectory", optimize: true, path: {}, robot: {}, perSegment: 56,
    }, derived, optimize);

    expect(result).toMatchObject({
      id: 1,
      quality: "final",
      value: {
        finalTrajectory: { totalTimeS: 1.8 },
        finalOptimization: { status: "optimal", totalTimeS: 1.8 },
        prof: { totalTime: 1.8, t: [0, 0.9, 1.8], v: [0, 1.2, 0] },
        metrics: { v: [0, 1.2, 0] },
      },
    });
  });

  it("does not optimize final planning because a legacy planner toggle is enabled", () => {
    let optimizationCalls = 0;
    const result = processPathPreviewJob({
      id: 8, quality: "final", plannerId: "optimizedTrajectory", path: {}, robot: {}, perSegment: 56,
    }, derived, () => {
      optimizationCalls += 1;
      return finalTrajectory();
    }, () => finalTrajectory("equivalent"));

    expect(optimizationCalls).toBe(0);
    expect(result.value.finalTrajectory.planner).toBe("profiledSpline");
  });

  it("streams validated candidates with the run identity and no seed-deviation option", () => {
    const messages: any[] = [];
    const path = { id: "authored", optimization: { corridorM: 0.4, accepted: { obsolete: true } } };
    const result = processPathPreviewJob({
      id: 9, quality: "final", plannerId: "profiledSpline", optimize: true,
      path, robot: {}, perSegment: 56, deadline: "stress", deadlineMs: 15_000,
      field: { id: "field" },
    }, derived, (input: any, options: any) => {
      expect(input.path).toEqual({ id: "authored" });
      expect(input.field).toEqual({ id: "field" });
      expect(options).toMatchObject({ budgetTier: "stress", budgetMs: 15_000 });
      expect(options).not.toHaveProperty('corridorM');
      options.onProgress(finalTrajectory("equivalent"));
      options.onProgress(finalTrajectory());
      return finalTrajectory();
    }, undefined, (message: any) => messages.push(message));

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      id: 9, type: "progress", quality: "final",
      value: { finalOptimization: { status: "equivalent" }, prof: { totalTime: 1.8 } },
    });
    expect(messages[1].value.finalOptimization.status).toBe("optimal");
    expect(result.value.finalTrajectory.totalTimeS).toBe(1.8);
    expect(path.optimization.accepted).toEqual({ obsolete: true });
  });

  it("reuses the applied trajectory unchanged across repeated final requests", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.waypoints = buildWaypoints([
      { x: 1, y: 1, theta: 0, segType: "line" },
      { x: 2, y: 1, theta: 0 },
    ]);
    const trajectory = optimizeFixedGeometryFinal({ path, robot: project.robot, samplesPerSegment: 56 });
    path.optimization = { corridorM: 0.15, accepted: createAcceptedTrajectory(path, project.robot, trajectory) };
    const selected = path.optimization.accepted!.result;
    for (let id = 1; id <= 2; id += 1) {
      const result = processPathPreviewJob({
        id, quality: "final", plannerId: "profiledSpline", path, robot: project.robot, perSegment: 56,
      }, PM.derivePath, () => { throw new Error("Selected results must not re-optimize"); }, () => {
        throw new Error("Selected results must not fall back to the normal profile");
      });
      expect(result.error).toBeUndefined();
      expect(result.value.finalTrajectory).toBe(selected);
      expect(result.value.prof.totalTime).toBe(selected.totalTimeS);
    }
  });

  it("renders accepted corridor geometry without mutating the authored path", () => {
    const authored = { id: "authored", x: 1 };
    const optimizedPath = { id: "candidate", x: 1.2 };
    const derive = (path: any) => {
      const value = derived();
      if (path.id === "candidate") value.sample.pts[1].x = 1.2;
      return value;
    };
    const accepted = finalTrajectory();
    accepted.optimizedPath = optimizedPath;
    accepted.samples[1].x = 1.2;

    const result = processPathPreviewJob({
      id: 3, quality: "final", plannerId: "optimizedTrajectory", optimize: true, path: authored, robot: {}, perSegment: 56,
      deadline: "common", deadlineMs: 5_000,
    }, derive, () => accepted);

    expect(authored).toEqual({ id: "authored", x: 1 });
    expect(result.value.sample.pts[1].x).toBe(1.2);
    expect(result.value.finalTrajectory.optimizedPath).toEqual(optimizedPath);
  });

  it("projects an equivalent result through the same renderer-facing trajectory", () => {
    const projected = applyFinalTrajectoryToPreview(derived(), finalTrajectory("equivalent"));

    expect(projected.prof).toMatchObject({ totalTime: 1.8, t: [0, 0.9, 1.8] });
    expect(projected.finalOptimization.status).toBe("equivalent");
  });

  it("recomputes graph extrema from the authoritative trajectory", () => {
    const interactive = derived();
    Object.assign(interactive.metrics, { vMax: 9, aMax: 8, wMax: 7, kMax: 6 });
    const accepted = finalTrajectory();
    accepted.samples[1] = {
      ...accepted.samples[1],
      accelerationMps2: -2.5,
      angularVelocityRadps: 1.4,
      curvatureInvM: -0.8,
    };

    const projected = applyFinalTrajectoryToPreview(interactive, accepted);

    expect(projected.metrics).toMatchObject({
      vMax: 1.2,
      aMax: 2.5,
      wMax: 1.4,
      kMax: 0.8,
    });
  });

  it("plays the authoritative optimized heading trace", () => {
    const accepted = finalTrajectory();
    accepted.samples[1].headingRad = 0.6;
    accepted.samples[1].angularVelocityRadps = 2 / 3;
    accepted.samples[2].headingRad = 1;
    const projected = applyFinalTrajectoryToPreview(derived(), accepted);

    const pose = PM.poseAtTime(
      projected.prof.t[1],
      projected.sample.pts,
      projected.prof,
      projected.anchors,
      projected.mode,
      projected.rev,
    );

    expect(pose.heading).toBeCloseTo(accepted.samples[1].headingRad, 8);
  });

  it("creates or removes terminal catch-up from authoritative final samples", () => {
    const finalOnly = finalTrajectory();
    finalOnly.totalTimeS = 2.2;
    finalOnly.samples = [
      finalOnly.samples[0],
      finalOnly.samples[1],
      { ...finalOnly.samples[2], t: 1.8, headingRad: 0 },
      { ...finalOnly.samples[2], i: 3, t: 2, headingRad: 0.1, angularVelocityRadps: 0.5 },
      { ...finalOnly.samples[2], i: 4, t: 2.2, headingRad: 0, angularVelocityRadps: 0 },
    ];

    const added = applyFinalTrajectoryToPreview(derived(), finalOnly);
    expect(added.prof.turns).toEqual([expect.objectContaining({
      catchup: true,
      t0: 1.8,
      t1: 2.2,
      headingSamples: [
        { t: 1.8, heading: 0 },
        { t: 2, heading: 0.1 },
        { t: 2.2, heading: 0 },
      ],
    })]);
    expect(PM.poseAtTime(2, added.sample.pts, added.prof, added.anchors, added.mode, added.rev).heading)
      .toBeCloseTo(0.1, 8);

    const rendererOnly = derived();
    rendererOnly.prof.turns = [{ idx: 2, t0: 2, t1: 2.2, start: 0, delta: 0.1, catchup: true }];
    const removed = applyFinalTrajectoryToPreview(rendererOnly, finalTrajectory());
    expect(removed.prof.turns).toEqual([]);
  });

  it("still rejects missing authored turn metadata", () => {
    const interactive = derived();
    interactive.prof.turns = [{ idx: 2, t0: 2, t1: 2.3, start: 0, delta: Math.PI / 2 }];

    expect(() => applyFinalTrajectoryToPreview(interactive, finalTrajectory()))
      .toThrow("Final optimization omitted turn timing metadata.");
  });

  it("renders and plays implicit stop rotations from the real neutral-stop corpus path", () => {
    const project = JSON.parse(readFileSync(new URL('../benchmarks/planner-corpus/v2/corpus.bordeaux.json', import.meta.url), 'utf8'));
    const path = project.paths.find((item: any) => item.id === 'corpus-neutral-stop');
    expect(path.waypoints.every((waypoint: any) => !waypoint.turnInPlace)).toBe(true);
    for (const optimize of [false, true]) {
      const result = processPathPreviewJob({
        id: 42, quality: 'final', plannerId: 'profiledSpline', optimize,
        path, robot: project.robot, perSegment: 56, deadline: 'common', deadlineMs: 5_000,
      });
      expect(result.error).toBeUndefined();
      const preview = result.value;
      const turn = preview.prof.turns.find((action: any) => action.idx === preview.wpIdx[1]);
      const wait = preview.prof.holds.find((action: any) => action.idx === preview.wpIdx[1]);
      expect(turn.headingSamples.length).toBeGreaterThan(2);
      expect(turn.t1).toBeCloseTo(wait.t0, 8);
      const midpoint = turn.headingSamples[Math.floor(turn.headingSamples.length / 2)];
      const pose = PM.poseAtTime(midpoint.t, preview.sample.pts, preview.prof, preview.anchors, preview.mode, preview.rev);
      expect(pose.heading).toBeCloseTo(midpoint.heading, 8);
      expect(pose.x).toBeCloseTo(path.waypoints[1].x, 6);
      expect(pose.y).toBeCloseTo(path.waypoints[1].y, 6);
      expect(wait.heading).toBeCloseTo(turn.headingSamples.at(-1).heading, 8);
    }
  }, 60_000);

  it("keeps terminal stationary actions inside the accepted final duration", () => {
    const interactive = derived();
    interactive.prof.t = [0, 1, 2];
    interactive.prof.totalTime = 3;
    interactive.prof.turns = [{ idx: 2, t0: 2, t1: 2.4, start: 0, delta: Math.PI / 2 }];
    interactive.prof.holds = [{ idx: 2, t0: 2.4, t1: 3 }];
    const accepted = finalTrajectory();
    accepted.totalTimeS = 2.6;
    accepted.optimization.totalTimeS = 2.6;
    accepted.stationaryActions = [
      { kind: "turn", waypointIndex: 2, fraction: 1, startTimeS: 1.8, endTimeS: 2.1 },
      { kind: "wait", waypointIndex: 2, fraction: 1, startTimeS: 2.1, endTimeS: 2.6 },
    ];
    accepted.samples = [
      accepted.samples[0],
      { ...accepted.samples[1], t: 0.8 },
      { ...accepted.samples[2], t: 1.8, headingRad: 0 },
      { ...accepted.samples[2], i: 3, t: 2.1, headingRad: Math.PI / 2 },
      { ...accepted.samples[2], i: 4, t: 2.6, headingRad: Math.PI / 2 },
    ];

    const projected = applyFinalTrajectoryToPreview(interactive, accepted);

    expect(projected.prof.t).toEqual([0, 0.8, 1.8]);
    expect(projected.prof.turns).toEqual([{ idx: 2, t0: 1.8, t1: 2.1, start: 0, delta: Math.PI / 2 }]);
    expect(projected.prof.holds).toEqual([{ idx: 2, t0: 2.1, t1: 2.6, heading: Math.PI / 2 }]);
    expect(projected.prof.totalTime).toBe(2.6);
  });

  it("resumes motion continuously after an interior stationary action", () => {
    const interactive = derived();
    interactive.prof.turns = [{ idx: 1, t0: 1, t1: 2, start: 0, delta: Math.PI / 2 }];
    const accepted = finalTrajectory();
    accepted.totalTimeS = 3;
    accepted.optimization.totalTimeS = 3;
    accepted.stationaryActions = [
      { kind: "turn", waypointIndex: 1, fraction: 0.5, startTimeS: 1, endTimeS: 2 },
    ];
    accepted.samples = [
      accepted.samples[0],
      { ...accepted.samples[1], t: 1, headingRad: 0 },
      { ...accepted.samples[1], i: 2, t: 2, headingRad: Math.PI / 2 },
      { ...accepted.samples[2], i: 3, t: 3, headingRad: Math.PI / 2 },
    ];
    const projected = applyFinalTrajectoryToPreview(interactive, accepted);

    const afterTurn = PM.poseAtTime(
      2 + 1e-6,
      projected.sample.pts,
      projected.prof,
      projected.anchors,
      projected.mode,
      projected.rev,
    );

    expect(afterTurn.x).toBeCloseTo(1, 5);
    expect(afterTurn.heading).toBeCloseTo(Math.PI / 2, 5);
  });

  it("ignores non-monotonic interior jiggle samples when projecting later geometry", () => {
    const interactive = derived();
    interactive.sample.length = 4;
    interactive.sample.pts = [
      { x: 0, y: 0, s: 0 },
      { x: 1, y: 0, s: 1 },
      { x: 2, y: 0, s: 2 },
      { x: 4, y: 0, s: 4 },
    ];
    interactive.prof = {
      t: [0, 1, 2, 4], v: [0, 1, 1, 0], totalTime: 4.5, holds: [], turns: [],
      jiggles: [{ idx: 1, t0: 1, t1: 1.5, strokeDuration: 0.5, config: { strokes: 1 } }],
    };
    interactive.metrics = {
      head: [0, 0, 0, 0], v: [0, 1, 1, 0], accel: [0, 0, 0, 0], omega: [0, 0, 0, 0], curv: [0, 0, 0, 0],
    };
    const accepted = finalTrajectory();
    accepted.totalTimeS = 3.5;
    accepted.optimization.totalTimeS = 3.5;
    accepted.stationaryActions = [
      { kind: "jiggle", waypointIndex: 1, fraction: 0.25005, startTimeS: 0.7, endTimeS: 1.1, strokeDurationS: 0.4 },
    ];
    accepted.samples = [
      { ...accepted.samples[0], s: 0, f: 0, x: 0, t: 0 },
      { ...accepted.samples[1], s: 1, f: 0.25, x: 1, t: 0.7 },
      { ...accepted.samples[1], i: 2, s: 1.2, f: 1, x: 1.2, t: 0.95 },
      { ...accepted.samples[1], i: 3, s: 1.4, f: 1, x: 1, t: 1.1 },
      { ...accepted.samples[1], i: 4, s: 1.8, f: 0.45, x: 1.8, t: 1.8 },
      { ...accepted.samples[1], i: 5, s: 2.2, f: 0.55, x: 2.2, t: 2.2 },
      { ...accepted.samples[1], i: 6, s: 4, f: 1, x: 4, t: 3.5, velocityMps: 0 },
    ];

    const projected = applyFinalTrajectoryToPreview(interactive, accepted);

    expect(projected.prof.t).toEqual([0, 0.7, 2, 3.5]);
    expect(projected.prof.jiggles[0]).toMatchObject({ t0: 0.7, t1: 1.1, strokeDuration: 0.4 });
    expect(projected.prof.totalTime).toBe(3.5);
  });

  it("returns the optimizer fallback reason without replacing the interactive value", () => {
    const result = processPathPreviewJob({
      id: 2, quality: "final", plannerId: "optimizedTrajectory", optimize: true, path: {}, robot: {}, perSegment: 56,
    }, () => ({ interactive: true }), () => ({
      optimization: { fallback: true, fallbackReason: "candidate failed dense validation" },
    }));

    expect(result).toMatchObject({
      id: 2,
      finalFallbackReason: "candidate failed dense validation",
    });
    expect(result).not.toHaveProperty("value");
  });

  it("rejects a Profiled final trajectory that export would block", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "manual";
    path.startVel = 1;
    path.goalVel = 1;
    path.waypoints = buildWaypoints([
      { x: 1, y: 2, theta: 0, thetaOn: true, segType: "line" },
      { x: 1.5, y: 2, theta: 180, thetaOn: true },
    ]);
    path.ranges = [{
      anchor: "param", f0: 0, f1: 1,
      maxVel: path.constraints.maxVel,
      maxAccel: path.constraints.maxAccel,
      maxDecel: path.constraints.maxDecel,
      maxAngVel: path.constraints.maxAngVel,
      maxAngAccel: path.constraints.maxAngAccel,
      rotationPriority: "translation",
    }];

    const result = processPathPreviewJob({
      id: 90, quality: "final", plannerId: "profiledSpline", path, robot: project.robot, perSegment: 56,
    });
    expect(result.value).toBeUndefined();
    expect(result.error?.message).toMatch(/infeasible|constraint|endpoint|heading/i);
  });
});
