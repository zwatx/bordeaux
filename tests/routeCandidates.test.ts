import { describe, expect, it } from "vitest";
import { generateRouteCandidates as generateBlueRouteCandidates } from "../src/shared/agent/routeCandidates";
import { createDemoProject } from "../src/shared/project/defaults";

// Preserve these older scenario sketches' named alliance structures and guardrail lanes.
// Only fixture field locations are converted; robot-local mechanism geometry stays physical.
const sketchPoint = (point: any): any => point && typeof point.x === 'number' && typeof point.y === 'number'
  ? { ...point, x: (1-point.x/17.548)*16.541, y: point.y/8.052*8.069,
    ...(point.headingDeg === undefined ? {} : { headingDeg: 180-point.headingDeg }) } : point;
const generateRouteCandidates: typeof generateBlueRouteCandidates = (project, request) => generateBlueRouteCandidates(project, { ...request,
  ...(request.start ? { start: sketchPoint(request.start) } : {}),
  ...(request.goals ? { goals: request.goals.map(sketchPoint) } : {}),
  ...(request.steps ? { steps: request.steps.map((step) => step.kind === 'travel' ? { ...step, to: sketchPoint(step.to) }
    : { ...step, at: sketchPoint(step.at), turn: step.turn === 'clockwise' ? 'counterclockwise' : 'clockwise' }) } : {}),
});

describe("agent route candidates", () => {
  it("generates a bounded set and ranks only planner-scored paths", () => {
    const project = createDemoProject();
    const candidates = generateRouteCandidates(project, {
      intent: "Cross the field efficiently",
      alliance: "blue",
      start: { x: 1.5, y: 0.64 },
      goals: [{ x: 7, y: 0.64 }],
      traversal: "compare",
      maximumCandidates: 3,
      minimumClearanceM: 0.05,
    });
    expect(candidates).toHaveLength(3);
    expect(candidates.every((candidate) => candidate.analysis.sampleCount > 0)).toBe(true);
    expect(candidates.some((candidate) => candidate.valid)).toBe(true);
    expect(candidates[0].metrics.totalTimeS).toBeGreaterThan(0);
    expect(candidates[0].path.targets).toEqual([]);
    expect(candidates.filter((candidate) => candidate.traversal.startsWith("trench-")).every((candidate) => candidate.analysis.findings.every((finding) => !finding.id.startsWith("geometry:trench-height-unverified")))).toBe(true);
    expect(candidates.find((candidate) => candidate.traversal === "direct")?.valid).toBe(true);
  });

  it("rejects raw coordinates outside the field instead of clamping them", () => {
    const project = createDemoProject();
    expect(() => generateRouteCandidates(project, {
      intent: "Do not rewrite my coordinate",
      alliance: "blue",
      start: { x: -1, y: 1 },
      goals: [{ x: 3, y: 1 }],
    })).toThrow(/never silently clamped/);
  });

  it("certifies a requested trench only when the footprint and height fit", () => {
    const project = createDemoProject();
    const candidates = generateRouteCandidates(project, {
      intent: "Go under the trench",
      alliance: "blue",
      start: { x: 1.5, y: 0.64 },
      goals: [{ x: 7, y: 0.64 }],
      traversal: "trench",
      robotHeightM: 0.5,
      maximumCandidates: 2,
    });
    expect(candidates.some((candidate) => candidate.valid)).toBe(true);
    project.robot.heightM = 0.7;
    expect(() => generateRouteCandidates(project, {
      intent: "Too tall",
      alliance: "blue",
      start: { x: 1.5, y: 0.64 },
      goals: [{ x: 7, y: 0.64 }],
      traversal: "trench",
      robotHeightM: 0.7,
    })).not.toThrow();
    expect(generateRouteCandidates(project, {
      intent: "Too tall",
      alliance: "blue",
      start: { x: 1.5, y: 0.64 },
      goals: [{ x: 7, y: 0.64 }],
      traversal: "trench",
      robotHeightM: 0.5,
    }).every((candidate) => !candidate.valid)).toBe(true);
  });

  it("fits a long narrow rectangle through a portal using its oriented footprint", () => {
    const project = createDemoProject();
    project.robot.l = 1.2;
    project.robot.w = 0.6;
    project.robot.heightM = 0.5;
    const candidates = generateRouteCandidates(project, {
      intent: "Drive the long robot straight under the trench",
      alliance: "blue",
      start: { x: 1.5, y: 0.64, headingDeg: 0 },
      goals: [{ x: 7, y: 0.64, headingDeg: 0 }],
      traversal: "trench",
      maximumCandidates: 2,
    });
    expect(candidates.some((candidate) => candidate.valid), candidates.map((candidate) => candidate.rejectionReason).join("; ")).toBe(true);
  });

  it("requires an actual typed crossing and adds a speed range for every BUMP route", () => {
    const project = createDemoProject();
    const missing = generateRouteCandidates(project, { intent: "Use trench without crossing", alliance: "blue", start: { x: 1, y: 1 }, goals: [{ x: 3, y: 1 }], traversal: "trench", robotHeightM: 0.5 });
    expect(missing.every((candidate) => !candidate.valid && candidate.rejectionReason?.includes("does not cross"))).toBe(true);
    const direct = generateRouteCandidates(project, { intent: "Cross the bump directly", alliance: "blue", start: { x: 1.5, y: 2.59 }, goals: [{ x: 7, y: 2.59 }], traversal: "compare", maximumCandidates: 5 });
    const bumpRoutes = direct.filter((candidate) => candidate.valid && (candidate.traversal.startsWith("bump-") || candidate.traversal === "direct"));
    expect(bumpRoutes.length).toBeGreaterThan(0);
    expect(bumpRoutes.every((candidate) => candidate.path.ranges.some((range) => range.name?.startsWith("BUMP traversal") && (range.maxVel ?? Infinity) <= 2))).toBe(true);
    expect(bumpRoutes.every((candidate) => candidate.path.ranges.filter((range) => range.name?.startsWith("BUMP traversal")).length === 1)).toBe(true);
    expect(bumpRoutes.every((candidate) => candidate.path.ranges.filter((range) => range.name?.startsWith("BUMP traversal")).every((range) => range.anchor === "wp"))).toBe(true);
  });

  it("uses tangent-derived mechanism heading and configured speed only on FUEL collection spans", () => {
    const project = createDemoProject();
    project.robot.planning = {
      intake: { name: "Front intake", centerM: { x: project.robot.l / 2, y: 0 }, directionDeg: 0, captureWidthM: 0.7, maxCollectSpeedMps: 2.3 },
    };
    const candidate = generateRouteCandidates(project, {
      intent: "Collect the center FUEL in a straight lane",
      alliance: "red",
      start: { x: 6, y: 2.5 },
      goals: [{ x: 11, y: 2.5 }],
      collectFuel: { maxHeadingErrorDeg: 5 },
      maximumCandidates: 1,
    })[0];
    expect(candidate.valid, candidate.rejectionReason).toBe(true);
    expect(candidate.path.driveBackward).toBe(false);
    expect(candidate.path.waypoints[0].segmentHeadingMode).toBe("tangent");
    expect(candidate.path.ranges).toEqual([expect.objectContaining({ name: "FUEL collection", anchor: "wp", w0: 0, w1: 0, maxVel: 2.3 })]);
    expect(candidate.path.ranges[0].t0).toBeGreaterThan(0);
    expect(candidate.path.ranges[0].t1).toBeLessThan(1);
    const moving = candidate.analysis.rawSamples.slice(1, -1);
    moving.forEach((sample, index) => {
      const before = candidate.analysis.rawSamples[index];
      const after = candidate.analysis.rawSamples[index + 2];
      const tangent = Math.atan2(after.y - before.y, after.x - before.x);
      expect(Math.abs(Math.atan2(Math.sin(sample.headingRad - tangent), Math.cos(sample.headingRad - tangent)))).toBeLessThan(1e-3);
    });
  });

  it("counts unique intake coverage instead of rewarding a retraced lane twice", () => {
    const project = createDemoProject();
    project.robot.planning = {
      intake: { name: "Centered intake", centerM: { x: 0, y: 0 }, directionDeg: 0, captureWidthM: 0.7, maxCollectSpeedMps: 2 },
    };
    const outbound = generateRouteCandidates(project, {
      intent: "Collect one straight lane",
      alliance: "red",
      start: { x: 6, y: 2.5 },
      goals: [{ x: 10, y: 2.5 }],
      collectFuel: {},
      maximumCandidates: 1,
    })[0];
    const retraced = generateRouteCandidates(project, {
      intent: "Collect and retrace the same lane",
      alliance: "red",
      start: { x: 6, y: 2.5 },
      goals: [{ x: 10, y: 2.5 }, { x: 6, y: 2.5 }],
      collectFuel: { allowCrosswiseHeading: true },
      maximumCandidates: 1,
    })[0];
    expect(retraced.metrics.estimatedCollectionAreaM2).toBeLessThan((outbound.metrics.estimatedCollectionAreaM2 ?? 0) * 1.5);
  });

  it("keeps a curved collection swoosh, BUMP return, and shooting approach within heading limits", () => {
    const project = createDemoProject();
    project.robot.planning = {
      intake: { name: "Front intake", centerM: { x: 0.42, y: 0 }, directionDeg: 0, captureWidthM: 0.7, maxCollectSpeedMps: 2 },
      shooter: { directionDeg: 0, requiresTargetFacing: true, preferredRangeM: 2 },
    };
    const candidate = generateRouteCandidates(project, {
      intent: "Collect through a shallow swoosh, return over the BUMP, then face the HUB",
      alliance: "red",
      start: { term: "red left trench" },
      steps: [
        { kind: "swoosh", at: { term: "far side of the initial neutral FUEL band" }, traversal: "trench-table", turn: "counterclockwise", radiusM: 0.55, collectFuel: {} },
        { kind: "travel", to: { x: 3.35, y: 2.3 }, traversal: "bump-table", collectFuel: {} },
        { kind: "travel", to: { x: 3, y: 3 } },
      ],
      finishFacing: { mechanism: "shooter", target: { term: "red HUB" } },
      minimumClearanceM: 0,
      maximumCandidates: 1,
    })[0];
    expect(candidate.valid, [candidate.rejectionReason, ...candidate.analysis.findings.map((finding) => `${finding.message} @ ${finding.sample?.segmentIndex}:${finding.sample?.fraction}`)].join("; ")).toBe(true);
    const bumpRanges = candidate.path.ranges.filter((range) => range.name?.includes("BUMP traversal"));
    expect(bumpRanges).toHaveLength(1);
    expect(candidate.path.targets.length).toBeLessThan(150);
    const collectionRanges = candidate.path.ranges.filter((range) => range.name?.includes("FUEL collection"));
    expect(candidate.metrics.totalTimeS, JSON.stringify(candidate.path.ranges)).toBeLessThan(20);
    expect(Math.min(...collectionRanges.map((range) => range.maxVel ?? 0))).toBeGreaterThan(0.5);
    expect(collectionRanges).toHaveLength(1);
    expect(collectionRanges[0]).toMatchObject({ anchor: "wp", maxVel: 2 });
    expect(bumpRanges[0]).toMatchObject({ anchor: "wp", maxVel: 2 });
    const headingRanges = candidate.path.ranges.filter((range) => range.name?.startsWith("Heading transition")).sort((left, right) => left.f0 - right.f0);
    expect(headingRanges).toEqual([]);
    expect(candidate.path.waypoints.at(-1)?.turnInPlace).toBeUndefined();
    expect(candidate.path.waypoints.slice(6, -1).every((waypoint) => waypoint.segmentHeadingMode === "targets")).toBe(true);
  }, 30_000);

  it("refuses to guess intake geometry for a collection route", () => {
    expect(() => generateRouteCandidates(createDemoProject(), {
      intent: "Collect FUEL",
      alliance: "red",
      start: { x: 6, y: 2.5 },
      goals: [{ x: 11, y: 2.5 }],
      collectFuel: {},
      maximumCandidates: 1,
    })).toThrow(/Configure the robot's intake/);
  });

  it("aligns an arbitrary intake direction and honors an explicit crosswise exception", () => {
    const project = createDemoProject();
    project.robot.planning = { intake: { name: "Left intake", centerM: { x: 0, y: 0.42 }, directionDeg: 90, captureWidthM: 0.7, maxCollectSpeedMps: 2 } };
    const request = { intent: "Collect with a side intake", alliance: "red" as const, start: { x: 6, y: 2.5 }, goals: [{ x: 11, y: 2.5 }], maximumCandidates: 1 };
    const aligned = generateRouteCandidates(project, { ...request, collectFuel: {} })[0];
    expect(aligned.valid, aligned.rejectionReason).toBe(true);
    expect(Math.abs(aligned.analysis.rawSamples[Math.floor(aligned.analysis.rawSamples.length / 2)].headingRad - Math.PI / 2)).toBeLessThan(0.02);
    expect(generateRouteCandidates(project, { ...request, collectFuel: { allowCrosswiseHeading: true } })[0].analysis.sampleCount).toBeGreaterThan(0);
  });

  it("derives and verifies the final chassis heading from shooter geometry", () => {
    const project = createDemoProject();
    project.robot.planning = { shooter: { directionDeg: 0, requiresTargetFacing: true, preferredRangeM: 2 } };
    const candidate = generateRouteCandidates(project, {
      intent: "Finish facing the red HUB",
      alliance: "red",
      start: { x: 2, y: 2 },
      goals: [{ x: 3, y: 2.5 }],
      finishFacing: { mechanism: "shooter", target: { term: "red HUB" }, maxHeadingErrorDeg: 2 },
      maximumCandidates: 1,
    })[0];
    expect(candidate.valid, candidate.rejectionReason).toBe(true);
    expect(candidate.path.waypoints.at(-1)?.turnInPlace).toBeUndefined();
    const final = candidate.analysis.rawSamples.at(-1)!;
    const hub = { x: (11.31876 + 12.51256) / 2, y: (3.4376 + 4.6314) / 2 };
    const hubAppX = hub.x;
    const hubAppY = hub.y;
    const targetHeading = Math.atan2(hubAppY - final.y, hubAppX - final.x);
    expect(Math.abs(Math.atan2(Math.sin(final.headingRad - targetHeading), Math.cos(final.headingRad - targetHeading)))).toBeLessThan(0.01);
  });

  it("uses solid HUB landmarks as aiming references but never as drive coordinates", () => {
    const project = createDemoProject();
    project.robot.planning = { shooter: { directionDeg: 0, requiresTargetFacing: true } };
    expect(() => generateRouteCandidates(project, {
      intent: "Drive into the red HUB",
      alliance: "red",
      start: { x: 2, y: 2 },
      goals: [{ term: "red HUB" }],
      maximumCandidates: 1,
    })).toThrow(/not a collision-free robot drive coordinate/);
    const candidate = generateRouteCandidates(project, {
      intent: "Stop outside and aim at the red HUB neutral face",
      alliance: "red",
      start: { x: 2, y: 2 },
      goals: [{ x: 3, y: 2.5 }],
      finishFacing: { mechanism: "shooter", target: { term: "red HUB neutral face" } },
      maximumCandidates: 1,
    })[0];
    expect(candidate.valid, candidate.rejectionReason).toBe(true);
  });

  it("supports starting under a named TRENCH and departing toward the far neutral zone", () => {
    const candidates = generateRouteCandidates(createDemoProject(), {
      intent: "Start under the trench, go to the far side of the neutral zone",
      alliance: "blue",
      start: { term: "under the scoring-table-side trench" },
      goals: [{ term: "far side of the neutral zone" }],
      traversal: "trench",
      robotHeightM: 0.5,
      maximumCandidates: 2,
    });
    expect(candidates.some((candidate) => candidate.valid)).toBe(true);
  });

  it("keeps missing TRENCH height as an uncertified warning rather than an invalid route", () => {
    const project = createDemoProject();
    delete project.robot.heightM;
    const candidate = generateRouteCandidates(project, {
      intent: "Start under the red left TRENCH and collect initial FUEL",
      alliance: "red",
      start: { term: "red left trench" },
      steps: [
        { kind: "swoosh", at: { term: "far side of the initial neutral FUEL band" }, traversal: "trench-table", turn: "counterclockwise", radiusM: 0.55 },
        { kind: "travel", to: { x: 3.35, y: 2.3 }, traversal: "bump-table" },
      ],
      minimumClearanceM: 0,
    })[0];
    expect(candidate.valid, candidate.rejectionReason).toBe(true);
    expect(candidate.analysis.findings.some((finding) => finding.id.startsWith("geometry:trench-height-unverified") && finding.severity === "warning")).toBe(true);
    expect(Math.min(...candidate.path.waypoints.map((waypoint) => waypoint.x))).toBeCloseTo(7.3561, 3);
  });

  it("preserves the annotated mixed route as an exact ordered topology", () => {
    const candidates = generateRouteCandidates(createDemoProject(), {
      intent: "Red left TRENCH to far neutral, clockwise swoosh, return over red left BUMP",
      alliance: "red",
      start: { term: "red left trench" },
      steps: [
        { kind: "swoosh", at: { term: "far side of the neutral zone" }, traversal: "trench-table", turn: "counterclockwise", radiusM: 0.8, insetM: 1 },
        { kind: "travel", to: { x: 2.2, y: 2.59, headingDeg: 0 }, traversal: "bump-table" },
      ],
      robotHeightM: 0.5,
      minimumClearanceM: 0,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].traversal).toBe("ordered");
    expect(candidates[0].requiredPortalIds).toEqual(["red-trench-table", "red-bump-table"]);
    expect(candidates[0].valid, candidates[0].rejectionReason).toBe(true);
    const waypoints = candidates[0].path.waypoints;
    expect(waypoints[0].x).toBeGreaterThan(waypoints[1].x);
    expect(Math.min(...waypoints.map((waypoint) => waypoint.x))).toBeLessThan(6);
    const farthestIndex = waypoints.reduce((best, waypoint, index) => waypoint.x < waypoints[best].x ? index : best, 0);
    expect(waypoints[farthestIndex].y).toBeGreaterThan(waypoints[0].y);
    expect(farthestIndex).toBeLessThan(waypoints.length - 1);
    expect(waypoints[farthestIndex + 1].x).toBeGreaterThan(waypoints[farthestIndex].x);
    expect(waypoints.at(-1)!.x).toBeGreaterThan(waypoints[0].x);
    expect(candidates[0].analysis.findings.some((finding) => finding.id === "geometry:ordered-traversal-mismatch")).toBe(false);
  });

  it("does not collapse two chronologically separate visits to the same portal", () => {
    const candidates = generateRouteCandidates(createDemoProject(), {
      intent: "Leave and return through the red left TRENCH",
      alliance: "red",
      start: { term: "red left trench" },
      steps: [
        { kind: "swoosh", at: { x: 9, y: 7.2 }, traversal: "trench-table", turn: "clockwise", radiusM: 0.6 },
        { kind: "travel", to: { x: 2.5, y: 7.2 }, traversal: "trench-table" },
      ],
      robotHeightM: 0.5,
      minimumClearanceM: 0,
    });
    expect(candidates[0].requiredPortalIds).toEqual(["red-trench-table", "red-trench-table"]);
    expect(candidates[0].valid, candidates[0].rejectionReason).toBe(true);
  });

  it("rejects a global traversal policy beside ordered per-leg traversal", () => {
    expect(() => generateRouteCandidates(createDemoProject(), {
      intent: "Do not reinterpret conflicting route contracts",
      alliance: "red",
      steps: [{ kind: "travel", to: { x: 8, y: 4 }, traversal: "bump-table" }],
      traversal: "trench",
    })).toThrow(/cannot be combined with a global traversal/);
  });

  it("requires an exact per-leg portal whenever an ordered step reaches a barrier", () => {
    expect(() => generateRouteCandidates(createDemoProject(), {
      intent: "Do not choose a crossing accidentally",
      alliance: "red",
      start: { x: 2.5, y: 7.2 },
      steps: [{ kind: "travel", to: { x: 8, y: 7.2 } }],
    })).toThrow(/must name its exact TRENCH\/BUMP/);
  });
});
