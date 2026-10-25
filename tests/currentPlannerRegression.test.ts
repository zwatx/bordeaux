import { describe, expect, it, vi } from "vitest";
// @ts-expect-error The production worker is an intentional JavaScript module.
import { processPathPreviewJob } from "../src/renderer/assets/path-preview-worker";
import { PM } from "../src/shared/math/pm";
import { buildWaypoints, createDemoProject, defaultPathConstraints } from "../src/shared/project/defaults";
import { fixedPathSamples, getPlanner } from "../src/shared/planners";
import { optimizeCorridorFinal } from "../src/shared/planners/corridorFinal";
import { optimizeFixedGeometryFinal } from "../src/shared/planners/fixedGeometryFinal";
import { routeCandidateFailure } from "../src/shared/planners/routeValidation";
import { validateOptimizedTrajectory } from "../src/shared/planners/trajectoryValidation";
import { effectivePathConstraints, robotHardLimits } from "../src/shared/robotLimits";
import type { PlannerResult } from "../src/shared/types";

type DemoProject = ReturnType<typeof createDemoProject>;

function finalPreview(path: DemoProject["paths"][number], project: DemoProject, optimize = false, solver?: typeof optimizeCorridorFinal) {
  return processPathPreviewJob({
    id: 1,
    quality: "final",
    plannerId: "optimizedTrajectory",
    optimize,
    path,
    robot: project.robot,
    perSegment: 56,
    deadline: "common",
    deadlineMs: 5_000,
  }, undefined, solver);
}

function liveTranslationPriorityProject() {
  const project = createDemoProject();
  project.plannerId = "optimizedTrajectory";
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
  path.name = "New path";
  path.headingMode = "targets";
  path.constraints = defaultPathConstraints(project.robot);
  path.waypoints = [{
    linked: true, thetaOn: true, theta: 0, stop: false,
    x: 5.025734627553844, y: 7.596827504102406,
    prevC: { x: 4.241734627553845, y: 7.596827504102406 },
    nextC: { x: 5.809734627553842, y: 7.596827504102406 },
    segmentHeadingMode: "tangent",
  }, {
    linked: true, thetaOn: true, theta: 0, stop: false,
    x: 9.382303843976448, y: 5.421513053877565,
    prevC: { x: 9.35875766275833, y: 7.68112184271061 },
    nextC: { x: 9.406914766065318, y: 3.0597264296200053 },
    segType: "bezier", segmentHeadingMode: "tangent", corner: false,
  }, {
    linked: true, thetaOn: true, theta: 0, stop: false,
    x: 6.339719443186393, y: 5.492281877488863,
    prevC: { x: 7.353914243449744, y: 5.468692269618431 },
    nextC: { x: 5.43406956568423, y: 5.513346790731007 },
    segType: "bezier", segmentHeadingMode: "targets", corner: false,
    headingTransition: { placement: "after", rotationPriority: "translation", distanceM: 0.75 },
  }, {
    linked: true, thetaOn: true, theta: -42, stop: false,
    x: 3.457271608135819, y: 5.550933095977322,
    prevC: { x: 4.362657902712776, y: 5.5812825404826985 },
    nextC: { x: 2.5518853135588597, y: 5.520583651471945 },
  }];
  return project;
}

function currentTangentToTargetsProject(placement: "after" | "split" | "before" = "after") {
  const project = liveTranslationPriorityProject();
  const path = project.paths[0];
  path.waypoints = [{
    linked: true, thetaOn: true, theta: 0, stop: false,
    x: 5.007440283439009, y: 7.546001973557936,
    prevC: { x: 4.223440283439009, y: 7.546001973557936 },
    nextC: { x: 5.791440283439008, y: 7.546001973557936 },
    segmentHeadingMode: "tangent",
  }, {
    linked: true, thetaOn: true, theta: -90, stop: false,
    x: 9.320023185417924, y: 5.397863768476647,
    prevC: { x: 9.305974333573825, y: 7.708087725960924 },
    nextC: { x: 9.332881933436493, y: 3.2833430898184397 },
    segType: "bezier", segmentHeadingMode: "tangent", corner: false,
  }, {
    linked: true, thetaOn: true, theta: -177.9383205562294, stop: false,
    x: 6.51945630346719, y: 5.297047190326336,
    prevC: { x: 7.480650304920239, y: 5.295177255057877 },
    nextC: { x: 5.5138913740124424, y: 5.2990034461118185 },
    segType: "bezier", segmentHeadingMode: "targets", corner: false,
    headingTransition: { placement, rotationPriority: "translation", distanceM: 0.75 },
  }, {
    linked: true, thetaOn: true, theta: -39, stop: false,
    x: 3.4416315927404133, y: 5.3024475350761,
    prevC: { x: 4.447198013720099, y: 5.301537983465229 },
    nextC: { x: 2.4360651717607267, y: 5.303357086686971 },
  }];
  return project;
}

// Correctness searches use a fixed work ceiling; CPU contention must not
// decide which candidates are checked. Deadline behavior has separate tests.
function withWorkBudget(check: () => void): void {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  try { check(); } finally { clock.mockRestore(); }
}

describe("current planner regressions", () => {
  it("bounds heading interpolation when target spacing is extremely uneven", () => {
    [0.45, 0.9].forEach((middleFraction) => {
      const anchors = [
        { f: 0, rad: 0 },
        { f: middleFraction, rad: 1 * PM.D2R },
        { f: 1, rad: 170 * PM.D2R },
      ];
      const headings = Array.from({ length: 1001 }, (_, index) => PM.headingAt(index / 1000, anchors));

      expect(Math.min(...headings)).toBeGreaterThanOrEqual(-1e-9);
      expect(Math.max(...headings)).toBeLessThanOrEqual(170 * PM.D2R + 1e-9);
    });
  });

  it("enforces angular acceleration through a signed heading reversal without zero-speed samples", () => {
    const points = Array.from({ length: 21 }, (_, index) => ({
      x: index / 2,
      y: 0,
      s: index / 2,
      heading: 0,
      curv: 0,
    }));
    const anchors = [
      { f: 0, rad: 0 },
      { f: 0.5, rad: 179 * PM.D2R },
      { f: 1, rad: 0 },
    ];
    const headings = points.map((point) => PM.headingAt(point.s / 10, anchors));
    [[720, 10], [10, 720]].forEach(([maxAngAccel, maxAngDecel]) => {
      const profile = PM.profile(points, {
        maxVel: 4,
        maxAccel: 6,
        maxDecel: 6,
        maxAngVel: 540,
        maxAngAccel,
        maxAngDecel,
      }, 2, 2, { heading: headings });
      const angularAccelerations = points.slice(2).map((_point, offset) => {
        const index = offset + 2;
        const beforeDt = profile.t[index - 1] - profile.t[index - 2];
        const afterDt = profile.t[index] - profile.t[index - 1];
        const beforeOmega = PM.angWrap(headings[index - 1] - headings[index - 2]) / beforeDt;
        const afterOmega = PM.angWrap(headings[index] - headings[index - 1]) / afterDt;
        return { beforeOmega, afterOmega, value: Math.abs(afterOmega - beforeOmega) / ((beforeDt + afterDt) / 2) };
      });
      const reversal = angularAccelerations.find(({ beforeOmega, afterOmega }) => beforeOmega * afterOmega < 0);

      expect(reversal).toBeDefined();
      expect(reversal!.value).toBeLessThanOrEqual(10 * PM.D2R + 1e-9);
      expect(Math.min(...profile.v)).toBeGreaterThan(0.1);
    });
  });

  it("inserts an exact interactive sample for an off-grid heading transition target", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "targets";
    path.waypoints = [
      { x: 0, y: 4, prevC: { x: 0, y: 4 }, nextC: { x: 2, y: 4 }, linked: true, thetaOn: true, theta: 0, stop: false, segType: "line", segmentHeadingMode: "tangent" },
      { x: 5, y: 4, prevC: { x: 3, y: 4 }, nextC: { x: 7, y: 4 }, linked: true, thetaOn: false, theta: 0, stop: false, segType: "line", segmentHeadingMode: "targets" },
      { x: 10, y: 4, prevC: { x: 8, y: 4 }, nextC: { x: 10, y: 4 }, linked: true, thetaOn: true, theta: 90, stop: false, segType: "line" },
    ];
    path.targets = [{ f: 0.501, deg: 90 }];
    const derived = PM.derivePath(path, project.robot, 56, undefined);
    const targetIndex = derived.sample.pts.findIndex((point: { s: number }) => (
      Math.abs(point.s / derived.sample.length - 0.501) <= 1e-10
    ));

    expect(targetIndex).toBeGreaterThan(-1);
    expect(Math.abs(PM.angWrap(derived.metrics.head[targetIndex] - 90 * PM.D2R))).toBeLessThan(0.05 * PM.D2R);
    expect(derived.sample.pts[targetIndex]).toMatchObject({ seg: 1 });
    expect(derived.sample.pts[targetIndex].t).toBeGreaterThan(0);
    expect(derived.sample.pts[targetIndex].t).toBeLessThan(1 / 56);

    const interactive = processPathPreviewJob({
      id: 0,
      quality: "interactive",
      plannerId: "profiledSpline",
      path,
      robot: project.robot,
      perSegment: 56,
    });
    const interactiveTarget = interactive.value.sample.pts.find((point: { s: number }) => (
      Math.abs(point.s / interactive.value.sample.length - 0.501) <= 1e-10
    ));
    expect(interactiveTarget).toMatchObject({ seg: 1 });
    expect(interactiveTarget.t).toBeGreaterThan(0);
    expect(interactiveTarget.t).toBeLessThan(1 / 56);
  });

  it("does not create repeated deep speed valleys at waypoint headings and rotation targets", () => {
    const project = currentTangentToTargetsProject();
    const path = project.paths[0];
    path.waypoints = [{
      linked: true, thetaOn: true, theta: 0, stop: false,
      x: 5.014, y: 7.608,
      prevC: { x: 4.222, y: 7.608 }, nextC: { x: 5.806, y: 7.608 },
      segType: "bezier", segmentHeadingMode: "tangent",
    }, {
      linked: true, thetaOn: true, theta: -91, stop: false,
      x: 9.287, y: 5.483,
      prevC: { x: 9.328, y: 7.854 }, nextC: { x: 9.252, y: 3.453 },
      segType: "bezier", segmentHeadingMode: "targets", corner: false,
      headingTransition: { placement: "after", rotationPriority: "heading", distanceM: 0.75 },
    }, {
      linked: true, thetaOn: true, theta: -180, stop: false,
      x: 6.815, y: 5.069,
      prevC: { x: 7.537, y: 5.069 }, nextC: { x: 5.812, y: 5.069 },
      segType: "bezier", segmentHeadingMode: "targets", corner: false,
    }, {
      linked: true, thetaOn: true, theta: -35, stop: false,
      x: 3.621, y: 5.075,
      prevC: { x: 4.642, y: 5.075 }, nextC: { x: 2.600, y: 5.075 },
    }];
    path.targets = [{ f: 20 / 39.37, deg: -114 }, { f: 23.9 / 39.37, deg: 179 }];

    const preview = processPathPreviewJob({
      id: 1,
      quality: "final",
      plannerId: "profiledSpline",
      path,
      robot: project.robot,
      perSegment: 56,
      deadline: "common",
      deadlineMs: 5_000,
    });
    expect(preview.error).toBeUndefined();
    const result = preview.value.finalTrajectory as PlannerResult;

    const translationPath = structuredClone(path);
    translationPath.targets = [];
    translationPath.waypoints.forEach((waypoint) => {
      waypoint.theta = 0;
      waypoint.segmentHeadingMode = "targets";
      delete waypoint.headingTransition;
    });
    const translationPreview = processPathPreviewJob({
      id: 2,
      quality: "final",
      plannerId: "profiledSpline",
      path: translationPath,
      robot: project.robot,
      perSegment: 56,
      deadline: "common",
      deadlineMs: 5_000,
    });
    expect(translationPreview.error).toBeUndefined();
    const translation = translationPreview.value.finalTrajectory as PlannerResult;
    const interactive = processPathPreviewJob({
      id: 3,
      quality: "interactive",
      plannerId: "profiledSpline",
      path,
      robot: project.robot,
      perSegment: 56,
    });
    const translationInteractive = processPathPreviewJob({
      id: 4,
      quality: "interactive",
      plannerId: "profiledSpline",
      path: translationPath,
      robot: project.robot,
      perSegment: 56,
    });
    expect(interactive.error).toBeUndefined();
    expect(translationInteractive.error).toBeUndefined();
    const geometry = PM.derivePath(path, project.robot, 56, undefined);
    const interactiveInteriorMinimum = Math.min(...interactive.value.sample.pts
      .map((sample: { s: number }, index: number) => {
        const fraction = sample.s / interactive.value.sample.length;
        return fraction >= 0.35 && fraction <= 0.85 ? interactive.value.prof.v[index] : Infinity;
      }));
    const translationInteractiveMinimum = Math.min(...translationInteractive.value.sample.pts
      .map((sample: { s: number }, index: number) => {
        const fraction = sample.s / translationInteractive.value.sample.length;
        return fraction >= 0.35 && fraction <= 0.85 ? translationInteractive.value.prof.v[index] : Infinity;
      }));

    const velocityAt = (samples: PlannerResult["samples"], fraction: number) => {
      const afterIndex = samples.findIndex((sample) => sample.f >= fraction);
      if (afterIndex <= 0) return Math.abs(samples[Math.max(0, afterIndex)]?.velocityMps ?? 0);
      const before = samples[afterIndex - 1];
      const after = samples[afterIndex];
      const ratio = (fraction - before.f) / Math.max(1e-9, after.f - before.f);
      return Math.sqrt(Math.max(0, before.velocityMps ** 2
        + (after.velocityMps ** 2 - before.velocityMps ** 2) * ratio));
    };
    const normalizedVelocity = (fraction: number) => (
      velocityAt(result.samples, fraction) / Math.max(1e-6, velocityAt(translation.samples, fraction))
    );
    const knots = [...geometry.wpFrac.slice(1, -1), ...path.targets.map((target) => target.f)];
    const knotNotches = knots.map((fraction) => {
      const center = normalizedVelocity(fraction);
      const shoulders = (normalizedVelocity(Math.max(0, fraction - 0.04))
        + normalizedVelocity(Math.min(1, fraction + 0.04))) / 2;
      return { fraction, ratio: center / Math.max(1e-6, shoulders) };
    });
    const interiorMinimum = Math.min(...result.samples
      .filter((sample) => sample.f >= 0.35 && sample.f <= 0.85)
      .map((sample) => sample.velocityMps));
    const translationMinimum = Math.min(...translation.samples
      .filter((sample) => sample.f >= 0.35 && sample.f <= 0.85)
      .map((sample) => sample.velocityMps));

    expect(result.diagnostics.some((issue) => issue.severity === "error")).toBe(false);
    expect(interiorMinimum).toBeGreaterThanOrEqual(translationMinimum * 0.95);
    expect(interactiveInteriorMinimum).toBeGreaterThanOrEqual(translationInteractiveMinimum * 0.95);
    expect(interactive.value.metrics.head).toHaveLength(geometry.metrics.head.length);
    interactive.value.metrics.head.forEach((heading: number, index: number) => {
      expect(Math.abs(PM.angWrap(heading - geometry.metrics.head[index]))).toBeLessThan(1e-10);
    });
    expect(knotNotches, JSON.stringify(knotNotches)).toSatisfy((notches: Array<{ ratio: number }>) => (
      notches.every((notch) => notch.ratio >= 0.85)
    ));
    path.targets.forEach((target) => {
      const sample = result.samples.find((candidate) => Math.abs(candidate.f - target.f) <= 1e-9);
      expect(sample).toBeDefined();
      expect(Math.abs(PM.angWrap(sample!.headingRad - target.deg * Math.PI / 180))).toBeLessThan(0.05 * Math.PI / 180);
    });
  });

  it("does not over-brake a smooth heading law merely because it has rotation targets", () => {
    const project = currentTangentToTargetsProject();
    const path = project.paths[0];
    path.waypoints.splice(0, 2);
    path.waypoints[0].segmentHeadingMode = "targets";
    delete path.waypoints[0].headingTransition;
    path.targets = [{ f: 0.3, deg: -136.2568 }, { f: 0.6, deg: -94.5753 }];

    const result = getPlanner("profiledSpline").generate({
      path,
      robot: project.robot,
      samplesPerSegment: 56,
    });
    const baseline = getPlanner("profiledSpline").generate({
      path: { ...path, targets: [] },
      robot: project.robot,
      samplesPerSegment: 56,
    });
    const middle = result.samples.filter((sample) => sample.f >= 0.2 && sample.f <= 0.8);
    const baselineMiddle = baseline.samples.filter((sample) => sample.f >= 0.2 && sample.f <= 0.8);
    const middleMinimum = Math.min(...middle.map((sample) => sample.velocityMps));
    const baselineMinimum = Math.min(...baselineMiddle.map((sample) => sample.velocityMps));

    expect(result.diagnostics.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(middleMinimum, `target ${middleMinimum.toFixed(3)} m/s; baseline ${baselineMinimum.toFixed(3)} m/s`).toBeGreaterThan(baselineMinimum * 0.9);
    path.targets.forEach((target) => {
      const sample = result.samples.find((candidate) => Math.abs(candidate.f - target.f) <= 1e-9);
      expect(sample).toBeDefined();
      expect(Math.abs(PM.angWrap(sample!.headingRad - target.deg * Math.PI / 180))).toBeLessThan(0.05 * Math.PI / 180);
    });
  });

  it("reports a tight angular-acceleration limit on close heading targets", () => {
    const project = currentTangentToTargetsProject();
    const path = project.paths[0];
    path.headingMode = "targets";
    path.waypoints = [
      { x: 1, y: 4, prevC: { x: 1, y: 4 }, nextC: { x: 2.5, y: 4 }, linked: true, thetaOn: true, theta: 0, stop: false, segType: "bezier" },
      { x: 5, y: 4, prevC: { x: 3.5, y: 4 }, nextC: { x: 6.5, y: 4 }, linked: true, thetaOn: true, theta: 0, stop: false, segType: "bezier" },
      { x: 10, y: 4, prevC: { x: 8.5, y: 4 }, nextC: { x: 10, y: 4 }, linked: true, thetaOn: true, theta: -179, stop: false, segType: "bezier" },
    ];
    path.targets = [{ f: 0.58, deg: -112 }, { f: 0.75, deg: -179 }];
    path.constraints.maxAngAccel = 10;
    path.constraints.maxAngDecel = 10;

    const derived = PM.derivePath(path, project.robot, 56, undefined);
    expect(derived.prof.rotLimited.some((value: number) => value >= 2)).toBe(true);
    expect(derived.warnings).toContainEqual(expect.objectContaining({
      kind: "angaccel",
      text: expect.stringContaining("add more distance"),
    }));
  });

  it("searches corridor improvements with the same robot-derived limits as the fixed planner", () => withWorkBudget(() => {
    const project = currentTangentToTargetsProject();
    project.paths[0].waypoints.slice(1, -1).forEach((waypoint) => { waypoint.corner = true; });
    const input = {
      path: project.paths[0],
      robot: project.robot,
      samplesPerSegment: 56,
    };
    const baseline = optimizeFixedGeometryFinal(input);
    const result = optimizeCorridorFinal(input, {
      corridorM: 0.15,
      budgetTier: "common",
      maximumEvaluations: 24,
    });

    expect(result.optimization?.evaluations).toBeGreaterThan(1);
    expect(result.optimization?.evaluations).toBeLessThanOrEqual(24);
    expect(result.totalTimeS).toBeLessThan(baseline.totalTimeS - 0.02);
    expect(result.optimizedPath).toBeDefined();
  }), 60_000);

  it("plans one coupled translation-and-heading trajectory regardless of legacy priority metadata", () => {
    const results = ([undefined, "heading", "translation"] as const).map((legacyPriority) => {
      const project = currentTangentToTargetsProject();
      const transition = project.paths[0].waypoints[2].headingTransition!;
      if (legacyPriority) transition.rotationPriority = legacyPriority;
      else delete transition.rotationPriority;
      return getPlanner("optimizedTrajectory").generate({
        path: project.paths[0],
        robot: project.robot,
        samplesPerSegment: 56,
      });
    });
    const canonical = results[0];
    const movingEnd = canonical.samples.findIndex((sample) => sample.f >= 1 - 1e-9);
    const headingTravelWhileMoving = canonical.samples.slice(1, movingEnd + 1).reduce((travel, sample, index) => (
      travel + Math.abs(PM.angWrap(sample.headingRad - canonical.samples[index].headingRad))
    ), 0);

    expect(canonical.diagnostics.some((issue) => issue.severity === "error")).toBe(false);
    expect(canonical.totalTimeS - canonical.samples[movingEnd].t).toBeLessThan(0.02);
    expect(headingTravelWhileMoving).toBeGreaterThan(150 * Math.PI / 180);
    for (const result of results.slice(1)) {
      expect(result.samples).toHaveLength(canonical.samples.length);
      result.samples.forEach((sample, index) => {
        expect(sample.t).toBeCloseTo(canonical.samples[index].t, 6);
        expect(sample.velocityMps).toBeCloseTo(canonical.samples[index].velocityMps, 6);
        expect(sample.headingRad).toBeCloseTo(canonical.samples[index].headingRad, 6);
      });
    }
  });

  it("preserves legacy ambiguous-corridor fallback and finds a qualified HUB detour", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.waypoints = buildWaypoints([
      { x: 2.2, y: 4.0, theta: 0 },
      { x: 6.36, y: 4.99, theta: 0 },
    ]);

    const result = finalPreview(path, project, true, optimizeCorridorFinal);

    expect(result.error).toBeUndefined();
    expect(result.finalFallbackReason).toBeUndefined();
    expect(result.value.finalOptimization).toMatchObject({
      status: "equivalent",
      fallback: false,
      constraintViolations: 0,
    });
    const route = finalPreview(path, project, true);
    expect(route.error).toBeUndefined();
    expect(route.finalFallbackReason).toBeUndefined();
    expect(route.value.finalTrajectory, JSON.stringify(route.value.routeSearch)).toBeDefined();
    expect(route.value.finalOptimization.optimizationClass).toBe("route");
    expect(routeCandidateFailure({ path, robot: project.robot }, route.value.finalTrajectory, project.field)).toBeUndefined();
  });

  it("does not globally slow the live translation-priority path", () => {
    const project = liveTranslationPriorityProject();
    const result = finalPreview(project.paths[0], project);

    expect(result.error).toBeUndefined();
    expect(result.finalFallbackReason).toBeUndefined();
    expect(result.value.finalTrajectory.totalTimeS).toBeLessThan(7);
    expect(result.value.finalOptimization).toMatchObject({
      fallback: false,
      constraintViolations: 0,
    });
  });

  it("profiles the live path at the fastest validated timing instead of globally slowing it", () => {
    const project = liveTranslationPriorityProject();
    const path = project.paths[0];
    const result = getPlanner("profiledSpline").generate({
      path,
      robot: project.robot,
      samplesPerSegment: 56,
    });
    expect(result.diagnostics.filter((issue) => issue.severity === "error")).toEqual([]);
    const firstInterior = path.waypoints[1];
    const firstInteriorSample = result.samples.reduce((nearest, sample) => (
      Math.hypot(sample.x - firstInterior.x, sample.y - firstInterior.y)
        < Math.hypot(nearest.x - firstInterior.x, nearest.y - firstInterior.y)
        ? sample
        : nearest
    ));

    expect(firstInteriorSample.velocityMps).toBeGreaterThan(0.5);
    expect(result.totalTimeS).toBeLessThan(5.5);
  });

  it("does not manufacture a stop at smooth waypoints around a tangent-to-targets transition", () => {
    const project = currentTangentToTargetsProject();
    const path = project.paths[0];
    const input = { path, robot: project.robot, samplesPerSegment: 56 };
    const result = getPlanner("optimizedTrajectory").generate(input);
    const hardLimits = robotHardLimits(project.robot)!;
    const physicalInput = {
      ...input,
      path: { ...path, constraints: effectivePathConstraints(path.constraints, project.robot) },
      robot: { ...project.robot, maxSpeed: hardLimits.maxSpeedMps },
    };
    const validation = validateOptimizedTrajectory(physicalInput, fixedPathSamples(result), {
      angularKinematics: "sample",
    });
    const interiorVelocities = path.waypoints.slice(1, -1).map((waypoint) => result.samples.reduce((nearest, sample) => (
      Math.hypot(sample.x - waypoint.x, sample.y - waypoint.y)
        < Math.hypot(nearest.x - waypoint.x, nearest.y - waypoint.y) ? sample : nearest
    )).velocityMps);

    expect(result.totalTimeS).toBeLessThan(7);
    interiorVelocities.forEach((velocity) => expect(velocity).toBeGreaterThan(0.5));
    const movingInterior = result.samples.slice(1).filter((sample) => (
      sample.s > 0.1 && sample.s < result.totalDistanceM - 0.15
    ));
    expect(Math.max(...movingInterior.map((sample) => sample.t - result.samples[sample.i - 1].t))).toBeLessThan(0.1);
    expect(validation.violations).toEqual([]);
  });

  it.each(["after", "split", "before"] as const)(
    "keeps legacy tangent-to-targets placement %s as a valid final trajectory",
    (placement) => {
      const project = currentTangentToTargetsProject(placement);
      const result = finalPreview(project.paths[0], project);

      expect(result.error, placement).toBeUndefined();
      expect(result.finalFallbackReason, placement).toBeUndefined();
      expect(result.value.finalOptimization, placement).toMatchObject({
        fallback: false,
        constraintViolations: 0,
      });
    },
  );

  it("does not slow translation for Before or At when timing priority is Translation", () => {
    for (const placement of ["before", "split"] as const) {
      for (const goalVel of [0, 1]) {
        const project = currentTangentToTargetsProject(placement);
        project.paths[0].goalVel = goalVel;
        const result = getPlanner("optimizedTrajectory").generate({
          path: project.paths[0],
          robot: project.robot,
          samplesPerSegment: 56,
        });
        const label = `${placement} with ${goalVel} m/s goal velocity`;
        const arrival = result.samples.find((sample) => sample.s >= result.totalDistanceM - 1e-6)!;
        const moving = result.samples.filter((sample) => (
          sample.s > result.totalDistanceM * 0.15
          && sample.s < result.totalDistanceM - 0.15
        ));
        expect(arrival.t, label).toBeLessThan(5);
        expect(result.totalTimeS, label).toBeLessThan(5);
        expect(Math.min(...moving.map((sample) => sample.velocityMps)), label).toBeGreaterThan(0.25);
        expect(result.diagnostics.some((issue) => issue.severity === "error"), label).toBe(false);
        expect(arrival.velocityMps, label).toBeCloseTo(goalVel, 5);
      }
    }
  });

  it("uses the waypoint as the single blend location for every legacy placement", () => {
    for (const goalVel of [0, 1]) {
      const placements = (["before", "split", "after"] as const).map((placement) => {
        const project = currentTangentToTargetsProject(placement);
        project.paths[0].goalVel = goalVel;
        const result = getPlanner("optimizedTrajectory").generate({
          path: project.paths[0],
          robot: project.robot,
          samplesPerSegment: 56,
        });
        const arrival = result.samples.find((sample) => sample.s >= result.totalDistanceM - 1e-6)!;
        const label = `${placement} with ${goalVel} m/s goal velocity`;
        expect(arrival.t, label).toBeLessThan(5);
        expect(arrival.velocityMps, label).toBeCloseTo(goalVel, 5);
        return arrival;
      });
      const arrivalTimes = placements.map((arrival) => arrival.t);
      expect(Math.max(...arrivalTimes) - Math.min(...arrivalTimes)).toBeLessThan(0.02);
    }
  }, 15_000); // Six complete planner solves include shared-bus and load-transfer validation.

  it("does not create a velocity notch at a smooth non-stop waypoint", () => {
    const project = currentTangentToTargetsProject("split");
    const path = project.paths[0];
    const result = getPlanner("optimizedTrajectory").generate({
      path,
      robot: project.robot,
      samplesPerSegment: 56,
    });
    const waypoint = path.waypoints[1];
    const nearestIndex = result.samples.reduce((bestIndex, sample, index) => (
      Math.hypot(sample.x - waypoint.x, sample.y - waypoint.y)
        < Math.hypot(result.samples[bestIndex].x - waypoint.x, result.samples[bestIndex].y - waypoint.y)
        ? index
        : bestIndex
    ), 0);
    const waypointSample = result.samples[nearestIndex];
    const comparisonSamples = result.samples.filter((sample) => (
      Math.abs(sample.s - waypointSample.s) >= 0.25
      && Math.abs(sample.s - waypointSample.s) <= 0.4
    ));
    const slowerSideSpeed = Math.min(
      Math.max(...comparisonSamples.filter((sample) => sample.s < waypointSample.s).map((sample) => sample.velocityMps)),
      Math.max(...comparisonSamples.filter((sample) => sample.s > waypointSample.s).map((sample) => sample.velocityMps)),
    );

    expect(waypoint.stop).toBe(false);
    expect(waypointSample.velocityMps).toBeGreaterThanOrEqual(slowerSideSpeed * 0.8);
  });

  it("keeps curvature continuous through an ordinary linked moving waypoint", () => {
    const project = currentTangentToTargetsProject();
    const path = project.paths[0];
    const result = optimizeCorridorFinal({
      path,
      robot: project.robot,
      samplesPerSegment: 56,
    }, {
      corridorM: 0.15,
      budgetTier: "common",
    });
    for (const waypoint of path.waypoints.slice(1, -1)) {
      const waypointIndex = result.samples.reduce((bestIndex, sample, index) => (
        Math.hypot(sample.x - waypoint.x, sample.y - waypoint.y)
          < Math.hypot(result.samples[bestIndex].x - waypoint.x, result.samples[bestIndex].y - waypoint.y)
          ? index
          : bestIndex
      ), 0);
      const before = result.samples[waypointIndex - 1];
      const at = result.samples[waypointIndex];
      const after = result.samples[waypointIndex + 1];
      const curvatureJump = Math.abs(at.curvatureInvM - after.curvatureInvM);
      const pointNotchMps = Math.max(0, 0.5 * (before.velocityMps + after.velocityMps) - at.velocityMps);

      expect(waypoint.stop).toBe(false);
      expect(curvatureJump).toBeLessThan(0.25);
      expect(pointNotchMps).toBeLessThan(0.05);
    }
  });

  it("finishes the endpoint heading while moving with only a bounded settle", () => {
    const project = currentTangentToTargetsProject("after");
    const path = project.paths[0];
    const preview = finalPreview(path, project);

    expect(preview.error).toBeUndefined();
    expect(preview.finalFallbackReason).toBeUndefined();
    const trajectory = preview.value.finalTrajectory;
    const arrivalIndex = trajectory.samples.findIndex((sample: { f: number }) => sample.f >= 1 - 1e-9);
    const arrival = trajectory.samples[arrivalIndex];
    const goalHeading = path.waypoints.at(-1)!.theta! * Math.PI / 180;
    const finalSample = trajectory.samples.at(-1)!;
    const rotatingTail = trajectory.samples.find((sample: { angularVelocityRadps: number; t: number }) => (
      sample.t > arrival.t + 1e-6
      && Math.abs(sample.angularVelocityRadps) > 1 * Math.PI / 180
    ));
    const headingError = Math.atan2(
      Math.sin(finalSample.headingRad - goalHeading),
      Math.cos(finalSample.headingRad - goalHeading),
    );

    expect(rotatingTail).toBeUndefined();
    expect(Math.abs(headingError)).toBeLessThan(0.5 * Math.PI / 180);
    // Moving samples store the average angular velocity of the interval ending
    // at that sample; a stopped endpoint must still publish a zero terminal
    // angular state for playback and robot feedforward.
    expect(Math.abs(finalSample.velocityMps)).toBeLessThan(1e-6);
    expect(Math.abs(finalSample.angularVelocityRadps)).toBeLessThan(1 * Math.PI / 180);
    expect(trajectory.totalTimeS).toBeGreaterThanOrEqual(arrival.t);
    expect(trajectory.totalTimeS).toBe(trajectory.samples.at(-1)!.t);
    expect(trajectory.totalTimeS - arrival.t).toBeLessThan(0.03);
    expect(arrival.t).toBeLessThan(3.85);
  });

  it("keeps the incoming Tangent segment tangent and rotates through the outgoing segment", () => {
    const project = currentTangentToTargetsProject("after");
    const path = project.paths[0];
    const trajectory = finalPreview(path, project).value.finalTrajectory;
    const samples = trajectory.samples as PlannerResult["samples"];
    const nearestToWaypoint = (waypoint: { x: number; y: number }) => samples.reduce((nearest, sample) => (
      Math.hypot(sample.x - waypoint.x, sample.y - waypoint.y)
        < Math.hypot(nearest.x - waypoint.x, nearest.y - waypoint.y)
        ? sample
        : nearest
    ));
    const firstBoundary = nearestToWaypoint(path.waypoints[1]);
    const transitionBoundary = nearestToWaypoint(path.waypoints[2]);
    const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
    const transitionWaypoint = path.waypoints[2];
    const exactIncomingTangent = Math.atan2(
      transitionWaypoint.y - transitionWaypoint.prevC.y,
      transitionWaypoint.x - transitionWaypoint.prevC.x,
    );
    const tangentErrors = samples.slice(1, -1).flatMap((sample, index) => {
      const before = samples[index];
      const after = samples[index + 2];
      if (sample.f <= firstBoundary.f + 0.01 || sample.f >= transitionBoundary.f - 0.01) return [];
      if (after.s - before.s < 1e-6) return [];
      const tangent = Math.atan2(after.y - before.y, after.x - before.x);
      return [Math.abs(wrap(sample.headingRad - tangent))];
    });
    const outgoingMoving = samples.filter((sample) => (
      sample.f >= transitionBoundary.f - 1e-6
      && sample.f < 1 - 1e-6
      && sample.velocityMps > 0.05
    ));
    const movingHeadingTravel = outgoingMoving.slice(1).reduce((travel, sample, index) => (
      travel + Math.abs(wrap(sample.headingRad - outgoingMoving[index].headingRad))
    ), 0);
    const arrival = samples.find((sample) => sample.f >= 1 - 1e-9)!;
    const goalHeading = path.waypoints.at(-1)!.theta! * Math.PI / 180;
    const movingArrivalLag = Math.abs(wrap(goalHeading - arrival.headingRad));

    expect(Math.max(...tangentErrors) * 180 / Math.PI).toBeLessThan(3);
    expect(Math.abs(wrap(transitionBoundary.headingRad - exactIncomingTangent)) * 180 / Math.PI).toBeLessThan(0.25);
    expect(movingHeadingTravel * 180 / Math.PI).toBeGreaterThan(60);
    expect(movingArrivalLag * 180 / Math.PI).toBeLessThan(0.5);
    expect(arrival.t).toBeLessThan(3.85);
    expect(trajectory.totalTimeS - arrival.t).toBeLessThan(0.03);
  });

  it("ignores legacy range priority metadata", () => {
    const project = currentTangentToTargetsProject();
    const path = project.paths[0];
    path.ranges = [{
      anchor: "param", f0: 0.05, f1: 0.15,
      maxVel: path.constraints.maxVel,
      maxAccel: path.constraints.maxAccel,
      maxDecel: path.constraints.maxDecel,
      maxAngVel: path.constraints.maxAngVel,
      maxAngAccel: path.constraints.maxAngAccel,
    }];
    const baseline = getPlanner("optimizedTrajectory").generate({
      path: structuredClone(path), robot: project.robot, samplesPerSegment: 56,
    });
    path.ranges[0].rotationPriority = "heading";

    const result = getPlanner("optimizedTrajectory").generate({ path, robot: project.robot, samplesPerSegment: 56 });
    expect(result.diagnostics.some((issue) => issue.severity === "error")).toBe(false);
    expect(result.samples).toHaveLength(baseline.samples.length);
    result.samples.forEach((sample, index) => {
      expect(sample.t).toBeCloseTo(baseline.samples[index].t, 6);
      expect(sample.headingRad).toBeCloseTo(baseline.samples[index].headingRad, 6);
      expect(sample.velocityMps).toBeCloseTo(baseline.samples[index].velocityMps, 6);
    });
  });

  it("uses a small coupled retime instead of a stopped terminal turn", () => {
    const project = liveTranslationPriorityProject();
    const path = project.paths[0];
    path.headingMode = "targets";
    path.constraints.maxVel = 4;
    path.constraints.maxAccel = 5;
    path.constraints.maxDecel = 5;
    path.waypoints = buildWaypoints([
      { x: 1, y: 2, theta: 0, thetaOn: true, segType: "line", segmentHeadingMode: "tangent" },
      {
        x: 4, y: 2, theta: 0, thetaOn: true, segType: "line", segmentHeadingMode: "targets",
        headingTransition: { placement: "after", rotationPriority: "translation", distanceM: 0.75 },
      },
      { x: 7, y: 2, theta: 90, thetaOn: true, segType: "line" },
    ]);

    const result = getPlanner("optimizedTrajectory").generate({ path, robot: project.robot, samplesPerSegment: 56 });
    const arrival = result.samples.find((sample) => sample.f >= 1 - 1e-9)!;
    const noRotationPath = structuredClone(path);
    noRotationPath.waypoints.at(-1)!.theta = 0;
    const noRotationResult = getPlanner("optimizedTrajectory").generate({
      path: noRotationPath,
      robot: project.robot,
      samplesPerSegment: 56,
    });
    const noRotationArrival = noRotationResult.samples.find((sample) => sample.f >= 1 - 1e-9)!;
    const finalSample = result.samples.at(-1)!;
    const headingError = Math.atan2(Math.sin(finalSample.headingRad - Math.PI / 2), Math.cos(finalSample.headingRad - Math.PI / 2));

    expect(Math.abs(arrival.t - noRotationArrival.t)).toBeLessThan(0.25);
    expect(Math.abs(headingError)).toBeLessThan(0.5 * Math.PI / 180);
    expect(result.totalTimeS - arrival.t).toBeLessThan(0.03);

    const limitedPath = structuredClone(path);
    limitedPath.constraints.maxAngVel = 180;
    limitedPath.constraints.maxAngAccel = 360;
    limitedPath.constraints.maxAngDecel = 360;
    const limited = getPlanner("optimizedTrajectory").generate({ path: limitedPath, robot: project.robot, samplesPerSegment: 56 });
    expect(limited.totalTimeS).toBeGreaterThan(result.totalTimeS);
    expect(validateOptimizedTrajectory({ path: limitedPath, robot: project.robot }, limited.samples, {
      angularKinematics: "sample",
    }).violations).toEqual([]);
  });

  it("rotates and translates concurrently through the current tangent-to-targets transition", () => {
      const project = currentTangentToTargetsProject();
      const path = project.paths[0];
      const input = { path, robot: project.robot, samplesPerSegment: 56 };
      const result = getPlanner("optimizedTrajectory").generate(input);
      const hardLimits = robotHardLimits(project.robot)!;
      const physicalInput = {
        ...input,
        path: { ...path, constraints: effectivePathConstraints(path.constraints, project.robot) },
        robot: { ...project.robot, maxSpeed: hardLimits.maxSpeedMps },
      };
      const validation = validateOptimizedTrajectory(physicalInput, fixedPathSamples(result), {
        angularKinematics: "sample",
      });
      const waypoint = path.waypoints[2];
      const waypointIndex = result.samples.reduce((best, sample, index) => (
        Math.hypot(sample.x - waypoint.x, sample.y - waypoint.y)
          < Math.hypot(result.samples[best].x - waypoint.x, result.samples[best].y - waypoint.y)
          ? index
          : best
      ), 0);
      const waypointDistance = result.samples[waypointIndex].s;
      const waypointNeighborhood = result.samples.filter((sample) => (
        Math.abs(sample.s - waypointDistance) <= 0.2
      ));
      const arrivalIndex = result.samples.findIndex((sample) => sample.f >= 1 - 1e-9);
      const headingTravelWhileMoving = result.samples.slice(1, arrivalIndex + 1).reduce((travel, sample, index) => {
        const previous = result.samples[index];
        if (Math.min(Math.abs(previous.velocityMps), Math.abs(sample.velocityMps)) <= 1) return travel;
        return travel + Math.abs(PM.angWrap(sample.headingRad - previous.headingRad));
      }, 0);
      const goalHeading = path.waypoints.at(-1)!.theta! * Math.PI / 180;
      const finalHeadingError = PM.angWrap(result.samples.at(-1)!.headingRad - goalHeading);

      expect(result.diagnostics.some((issue) => issue.severity === "error")).toBe(false);
      expect(result.optimization).toMatchObject({ fallback: false, constraintViolations: 0 });
      expect(validation.violations).toEqual([]);
      expect(Math.min(...waypointNeighborhood.map((sample) => sample.velocityMps))).toBeGreaterThan(1.2);
      expect(headingTravelWhileMoving).toBeGreaterThan(150 * Math.PI / 180);
      expect(result.samples[arrivalIndex].t).toBeLessThan(4);
      expect(Math.abs(finalHeadingError)).toBeLessThan(0.5 * Math.PI / 180);
      expect(result.totalTimeS - result.samples[arrivalIndex].t).toBeLessThan(0.03);
  });

  it("ignores inactive rotation targets outside Targets heading mode", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "manual";
    path.constraints.maxAngVel = 360;
    path.constraints.maxAngAccel = 720;
    path.constraints.maxAngDecel = 720;
    path.waypoints = buildWaypoints([
      { x: 1, y: 2, theta: 0, thetaOn: true, segType: "line", segmentHeadingMode: "tangent" },
      {
        x: 4, y: 2, theta: 0, thetaOn: true, segType: "line", segmentHeadingMode: "manual",
        headingTransition: { placement: "after", rotationPriority: "heading", distanceM: 0.75 },
      },
      { x: 7, y: 2, theta: 0, thetaOn: true, segType: "line" },
    ]);
    const withoutTarget = getPlanner("optimizedTrajectory").generate({
      path: structuredClone(path),
      robot: project.robot,
      samplesPerSegment: 56,
    });
    path.targets = [{ f: 0.7337, deg: 120 }];
    const withInactiveTarget = getPlanner("optimizedTrajectory").generate({
      path,
      robot: project.robot,
      samplesPerSegment: 56,
    });

    expect(withInactiveTarget.samples).toHaveLength(withoutTarget.samples.length);
    withInactiveTarget.samples.forEach((sample, index) => {
      expect(sample.headingRad).toBeCloseTo(withoutTarget.samples[index].headingRad, 8);
      expect(sample.t).toBeCloseTo(withoutTarget.samples[index].t, 8);
    });
  });

  it("does not pull an incoming-segment target into an automatic Targets transition", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "targets";
    path.constraints.maxAngVel = 360;
    path.constraints.maxAngAccel = 720;
    path.constraints.maxAngDecel = 720;
    path.waypoints = buildWaypoints([
      { x: 1, y: 2, theta: 0, thetaOn: true, segType: "line", segmentHeadingMode: "tangent" },
      {
        x: 4, y: 2, theta: 0, thetaOn: true, segType: "line", segmentHeadingMode: "targets",
        headingTransition: { placement: "after", rotationPriority: "translation", distanceM: 0.75 },
      },
      { x: 7, y: 2, theta: 0, thetaOn: true, segType: "line" },
    ]);
    const withoutTarget = getPlanner("optimizedTrajectory").generate({
      path: structuredClone(path), robot: project.robot, samplesPerSegment: 56,
    });
    path.targets = [{ f: 0.25, deg: 120 }];
    const withInactiveTarget = getPlanner("optimizedTrajectory").generate({
      path, robot: project.robot, samplesPerSegment: 56,
    });

    expect(withInactiveTarget.samples).toHaveLength(withoutTarget.samples.length);
    withInactiveTarget.samples.forEach((sample, index) => {
      expect(sample.headingRad).toBeCloseTo(withoutTarget.samples[index].headingRad, 8);
      expect(sample.t).toBeCloseTo(withoutTarget.samples[index].t, 8);
    });
  });

  it("keeps close heading targets as distinct exact trajectory knots", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.headingMode = "targets";
    path.waypoints = buildWaypoints([
      { x: 1, y: 2, theta: 0, thetaOn: true, segType: "line", segmentHeadingMode: "tangent" },
      {
        x: 4, y: 2, theta: 0, thetaOn: true, segType: "line", segmentHeadingMode: "targets",
      },
      {
        x: 7, y: 2, theta: 0, thetaOn: true, stop: true,
        turnInPlace: { headingDeg: 0, direction: "shortest" },
      },
    ]);
    path.targets = [{ f: 0.55, deg: 90 }, { f: 0.551, deg: -90 }];

    const result = getPlanner("profiledSpline").generate({
      path, robot: project.robot, samplesPerSegment: 56,
    });

    expect(result.diagnostics.some((issue) => issue.severity === "error")).toBe(false);
    for (const target of path.targets) {
      const sample = result.samples.find((candidate) => Math.abs(candidate.f - target.f) <= 1e-9);
      expect(sample).toBeDefined();
      expect(Math.abs(PM.angWrap(sample!.headingRad - target.deg * Math.PI / 180))).toBeLessThan(0.05 * Math.PI / 180);
    }
  });

  it.each(["profiledSpline", "optimizedTrajectory"] as const)(
    "hits an active heading target while translating with %s",
    (plannerId) => {
      const project = createDemoProject();
      const path = project.paths[0];
      path.headingMode = "targets";
      path.waypoints = buildWaypoints([
        { x: 1, y: 2, theta: 0, thetaOn: true, segType: "line", segmentHeadingMode: "tangent" },
        { x: 4, y: 2, theta: 0, thetaOn: true, segType: "line", segmentHeadingMode: "targets" },
        { x: 7, y: 2, theta: 90, thetaOn: true },
      ]);
      path.targets = [{ f: 0.75, deg: 90 }];

      const result = getPlanner(plannerId).generate({ path, robot: project.robot, samplesPerSegment: 56 });
      const target = result.samples.reduce((nearest, sample) => (
        Math.abs(sample.f - 0.75) < Math.abs(nearest.f - 0.75) ? sample : nearest
      ));

      expect(result.diagnostics.some((issue) => issue.severity === "error")).toBe(false);
      expect(Math.abs(PM.angWrap(target.headingRad - Math.PI / 2))).toBeLessThan(0.1 * Math.PI / 180);
      expect(target.velocityMps).toBeGreaterThan(0.5);
    },
  );

  it.each(["profiledSpline", "optimizedTrajectory"] as const)(
    "hits an off-grid heading target at its exact authored fraction with %s",
    (plannerId) => {
      const project = createDemoProject();
      const path = project.paths[0];
      path.headingMode = "targets";
      path.waypoints = buildWaypoints([
        { x: 1, y: 2, theta: 0, thetaOn: true, segType: "line", segmentHeadingMode: "tangent" },
        { x: 4, y: 2, theta: 0, thetaOn: true, segType: "line", segmentHeadingMode: "targets" },
        { x: 8, y: 2, theta: 90, thetaOn: true },
      ]);
      const targetFraction = 0.5664265306122449;
      path.targets = [{ f: targetFraction, deg: 90 }];

      const result = getPlanner(plannerId).generate({ path, robot: project.robot, samplesPerSegment: 56 });
      const target = result.samples.find((sample) => Math.abs(sample.f - targetFraction) < 1e-9);

      expect(result.diagnostics.some((issue) => issue.severity === "error")).toBe(false);
      expect(target).toBeDefined();
      expect(Math.abs(PM.angWrap(target!.headingRad - Math.PI / 2))).toBeLessThan(0.1 * Math.PI / 180);
      expect(target!.velocityMps).toBeGreaterThan(0.5);
    },
  );

  it.each(["profiledSpline", "optimizedTrajectory"] as const)(
    "tracks a continuous LookAt law while translating with %s",
    (plannerId) => {
      const project = createDemoProject();
      const path = project.paths[0];
      path.headingMode = "manual";
      path.constraints.maxAngVel = 720;
      path.constraints.maxAngAccel = 1_440;
      path.constraints.maxAngDecel = 1_440;
      path.waypoints = buildWaypoints([
        { x: 0, y: 2, theta: 0, thetaOn: true, segType: "line", segmentHeadingMode: "tangent" },
        {
          x: 2, y: 2, theta: 0, thetaOn: true, segType: "line",
          segmentHeadingMode: "lookAt", segmentLookAt: { x: 4, y: 5 },
        },
        { x: 10, y: 2, theta: 180, thetaOn: true },
      ]);

      const result = getPlanner(plannerId).generate({ path, robot: project.robot, samplesPerSegment: 56 });
      const sample = result.samples.reduce((nearest, candidate) => (
        Math.abs(candidate.x - 6) < Math.abs(nearest.x - 6) ? candidate : nearest
      ));
      const expected = Math.atan2(5 - sample.y, 4 - sample.x);

      expect(result.diagnostics.some((issue) => issue.severity === "error")).toBe(false);
      expect(Math.abs(PM.angWrap(sample.headingRad - expected))).toBeLessThan(0.25 * Math.PI / 180);
      expect(sample.velocityMps).toBeGreaterThan(0.5);
    },
  );

  it.each(["profiledSpline", "optimizedTrajectory"] as const)(
    "tracks the geometric tangent throughout an outgoing curved segment with %s",
    (plannerId) => {
      const project = createDemoProject();
      const path = project.paths[0];
      path.headingMode = "manual";
      path.waypoints = buildWaypoints([
        { x: 0, y: 2, theta: 0, thetaOn: true, segType: "line", segmentHeadingMode: "manual" },
        {
          x: 4, y: 2, theta: 0, thetaOn: true, segType: "bezier",
          nextC: { x: 5, y: 2 }, prevC: { x: 3, y: 2 }, segmentHeadingMode: "tangent",
        },
        { x: 8, y: 4, theta: 0, thetaOn: true, prevC: { x: 7, y: 4 } },
      ]);

      const result = getPlanner(plannerId).generate({ path, robot: project.robot, samplesPerSegment: 56 });
      const index = result.samples.reduce((nearest, sample, candidateIndex) => (
        Math.abs(sample.x - 6) < Math.abs(result.samples[nearest].x - 6) ? candidateIndex : nearest
      ), 1);
      const before = result.samples[index - 1];
      const sample = result.samples[index];
      const after = result.samples[index + 1];
      const tangent = Math.atan2(after.y - before.y, after.x - before.x);

      expect(result.diagnostics.some((issue) => issue.severity === "error")).toBe(false);
      expect(Math.abs(PM.angWrap(sample.headingRad - tangent))).toBeLessThan(1 * Math.PI / 180);
      expect(sample.velocityMps).toBeGreaterThan(0.5);
    },
  );

  it.each(["profiledSpline", "optimizedTrajectory"] as const)(
    "keeps a later Targets law out of an earlier equivalent transition in %s",
    (plannerId) => {
      const project = createDemoProject();
      const path = project.paths[0];
      path.headingMode = "manual";
      path.constraints.maxAngVel = 360;
      path.constraints.maxAngAccel = 720;
      path.constraints.maxAngDecel = 720;
      path.waypoints = buildWaypoints([
        { x: 1, y: 2, theta: 0, thetaOn: true, segType: "line", segmentHeadingMode: "tangent" },
        {
          x: 3, y: 2, theta: 0, thetaOn: true, segType: "line", segmentHeadingMode: "manual",
          headingTransition: { placement: "after", rotationPriority: "translation", distanceM: 0.75 },
        },
        {
          x: 5, y: 2, theta: 0, thetaOn: true, segType: "line", segmentHeadingMode: "targets",
          headingTransition: { placement: "after", rotationPriority: "translation", distanceM: 0.75 },
        },
        { x: 7, y: 2, theta: 180, thetaOn: true },
      ]);

      const result = getPlanner(plannerId).generate({
        path, robot: project.robot, samplesPerSegment: 56,
      });
      const firstWaypoint = result.samples.reduce((nearest, sample) => (
        Math.abs(sample.x - 3) < Math.abs(nearest.x - 3) ? sample : nearest
      ));

      expect(Math.abs(firstWaypoint.headingRad)).toBeLessThan(1 * Math.PI / 180);
      expect(result.diagnostics.some((issue) => issue.severity === "error")).toBe(false);
    },
  );

  it.each(["profiledSpline", "optimizedTrajectory"] as const)(
    "preserves an exact heading anchor before the next law in %s",
    (plannerId) => {
      const project = createDemoProject();
      const path = project.paths[0];
      path.headingMode = "manual";
      path.constraints.maxAngVel = 360;
      path.constraints.maxAngAccel = 720;
      path.constraints.maxAngDecel = 720;
      path.waypoints = buildWaypoints([
        { x: 1, y: 2, theta: 0, thetaOn: true, segType: "line", segmentHeadingMode: "tangent" },
        {
          x: 3, y: 2, theta: 0, thetaOn: true, segType: "line", segmentHeadingMode: "manual",
        },
        {
          x: 5, y: 2, theta: 90, thetaOn: true, segType: "line", segmentHeadingMode: "tangent",
        },
        { x: 7, y: 2, theta: 0, thetaOn: true },
      ]);

      const result = getPlanner(plannerId).generate({
        path, robot: project.robot, samplesPerSegment: 14,
      });
      const anchor = result.samples.reduce((nearest, sample) => (
        Math.abs(sample.x - 5) < Math.abs(nearest.x - 5) ? sample : nearest
      ));

      expect(Math.abs(PM.angWrap(anchor.headingRad - Math.PI / 2))).toBeLessThan(0.05 * Math.PI / 180);
      expect(result.diagnostics.some((issue) => issue.severity === "error")).toBe(false);
    },
  );

});
