import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { CorridorCorpus } from "../src/electron/benchmark/corridor";
import { observeRobotFieldPortalSequence } from "../src/shared/agent/fieldClearance";
import { REBUILT_2026_FIELD, officialToAppPoint } from "../src/shared/field/rebuilt2026";
import { robotFootprintRadius } from "../src/shared/agent/robotFootprint";
import { optimizeCorridorFinal, validateCorridorCandidate, type CorridorSearchStatistics } from "../src/shared/planners/corridorFinal";
import { optimizeFixedGeometryFinal } from "../src/shared/planners/fixedGeometryFinal";
import { decodeProjectFile } from "../src/shared/project/fileFormat";
import type { PlannerResult, TrajectorySample } from "../src/shared/types";

const directory = join(dirname(fileURLToPath(import.meta.url)), "../benchmarks/planner-corpus/v2");
const corpus = CorridorCorpus.loadV2(directory);
const project = decodeProjectFile(readFileSync(join(directory, "corpus.bordeaux.json"), "utf8")).project;

function events(ids: readonly string[], totalTimeS: number) {
  return ids.map((id, index) => ({ id, timeS: totalTimeS * (index + 1) / (ids.length + 1) }));
}

// Correctness searches use a fixed work ceiling; CPU contention must not
// decide which candidates are checked. Deadline behavior has separate tests.
function withWorkBudget(check: () => void): void {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  try { check(); } finally { clock.mockRestore(); }
}

describe("corridor final optimization", () => {
  it("returns only neutral-valid candidates without mutating the authored corpus paths", () => withWorkBudget(() => {
    let changedGeometry = 0;
    for (const fixture of corpus.cases) {
      const path = project.paths.find((candidate) => candidate.id === fixture.pathId)!;
      const authored = structuredClone(path);
      const input = { path, robot: project.robot, samplesPerSegment: 56 };
      const baseline = optimizeFixedGeometryFinal(input);
      const result = optimizeCorridorFinal(input, {
        corridorM: fixture.centerlineToFootprintBoundaryM - robotFootprintRadius(project.robot),
        budgetTier: "stress",
        budgetMs: 15_000,
        maximumEvaluations: 48,
      });
      const validation = corpus.validate(fixture.id, {
        ...result,
        events: events(fixture.eventOrder, result.totalTimeS),
      });

      expect(validation.valid, `${fixture.id}: ${validation.issues.map((issue) => issue.message).join("; ")}`).toBe(true);
      expect(result.totalTimeS).toBeLessThanOrEqual(baseline.totalTimeS + 0.0001);
      expect(path).toEqual(authored);
      expect(observeRobotFieldPortalSequence(project.robot, result.samples).visits.map((visit) => visit.id))
        .toEqual(observeRobotFieldPortalSequence(project.robot, baseline.samples).visits.map((visit) => visit.id));
      expect(result.optimization).toMatchObject({
        optimizationClass: "corridor",
        budgetTier: "stress",
        budgetMs: 15_000,
        constraintViolations: 0,
      });
      if (result.optimizedPath) changedGeometry += 1;
    }
    expect(changedGeometry).toBeGreaterThan(0);
  }), 120_000);

  it("distinguishes alternate typed portals even when endpoints stay on the same sides", () => {
    const barrier = REBUILT_2026_FIELD.crossingBarriers.find((item) => item.allianceOwner === "blue")!;
    const barrierX = officialToAppPoint({ x: barrier.x, y: 0 }).x;
    const samplesThrough = (portalId: string): TrajectorySample[] => {
      const portal = barrier.portals.find((item) => item.id === portalId)!;
      const y = officialToAppPoint(portal.point).y;
      return [barrierX + 0.8, barrierX - 0.8].map((x, index) => ({
        i: index, t: index, s: index * 1.6, f: index, x, y,
        headingRad: 0, velocityMps: 1.6, accelerationMps2: 0, angularVelocityRadps: 0, curvatureInvM: 0,
      }));
    };

    expect(observeRobotFieldPortalSequence(project.robot, samplesThrough("blue-trench-table"))).toMatchObject({
      valid: true,
      visits: [{ id: "blue-trench-table" }],
    });
    expect(observeRobotFieldPortalSequence(project.robot, samplesThrough("blue-bump-table"))).toMatchObject({
      valid: true,
      visits: [{ id: "blue-bump-table" }],
    });
  });

  it("returns the validated baseline before an exhausted time budget starts more work", () => {
    const path = project.paths.find((candidate) => candidate.id === corpus.cases[0].pathId)!;
    const progress: PlannerResult[] = [];
    const result = optimizeCorridorFinal({ path, robot: project.robot, samplesPerSegment: 56 }, {
      budgetMs: 1,
      onProgress: (incumbent) => progress.push(incumbent),
    });

    expect(result.optimization).toMatchObject({
      status: "equivalent",
      termination: "time-budget",
      evaluations: 0,
      validatedCandidates: 0,
      fallback: false,
      constraintViolations: 0,
    });
    expect(progress).toHaveLength(1);
    expect(result.samples).toEqual(progress[0].samples);
  });

  it("performs useful default search and retains an improved incumbent on cancellation", () => {
    const fixture = corpus.cases[1];
    const path = project.paths.find((candidate) => candidate.id === fixture.pathId)!;
    const input = { path, robot: project.robot, samplesPerSegment: 56 };
    const regular = optimizeCorridorFinal(input);
    expect(regular.optimization?.evaluations).toBeGreaterThan(1);
    expect(regular.optimization?.status).toBe("feasible");
    expect(regular.optimization?.gainS).toBeGreaterThan(0.02);
    expect(validateCorridorCandidate(input, regular)).toBe(true);
    const tampered = structuredClone(regular);
    tampered.optimizedPath!.waypoints[0].nextC!.y += 3;
    expect(validateCorridorCandidate(input, tampered)).toBe(false);
    let cancel = false;
    let improved: PlannerResult | undefined;
    const cancelled = optimizeCorridorFinal(input, {
      isCancelled: () => cancel,
      onProgress: (incumbent) => {
        if (incumbent.optimizedPath) { improved = incumbent; cancel = true; }
      },
    });
    expect(improved).toBeDefined();
    expect(cancelled.optimization).toMatchObject({ status: "feasible", termination: "cancelled", fallback: false });
    expect(cancelled.samples).toEqual(improved!.samples);
    expect(cancelled.optimizedPath).toEqual(improved!.optimizedPath);
  }, 15_000);

  it("returns the improved checkpoint when the cooperative time budget expires", () => {
    const path = project.paths.find((candidate) => candidate.id === corpus.cases[1].pathId)!;
    let elapsedMs = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
    let improved: PlannerResult | undefined;
    try {
      const result = optimizeCorridorFinal({ path, robot: project.robot, samplesPerSegment: 56 }, {
        budgetMs: 5_000,
        onProgress: (incumbent) => {
          if (incumbent.optimizedPath) { improved = incumbent; elapsedMs = 4_950; }
        },
      });
      expect(improved).toBeDefined();
      expect(result.optimization).toMatchObject({ status: "feasible", termination: "time-budget", fallback: false });
      expect(result.samples).toEqual(improved!.samples);
      expect(result.optimizedPath).toEqual(improved!.optimizedPath);
    } finally {
      clock.mockRestore();
    }
  });

  it("publishes only the initial and materially improved incumbents over a full search", () => withWorkBudget(() => {
    const path = project.paths.find((candidate) => candidate.id === corpus.cases[1].pathId)!;
    const input = { path, robot: project.robot, samplesPerSegment: 56 };
    const progress: PlannerResult[] = [];
    const statistics: CorridorSearchStatistics[] = [];
    const result = optimizeCorridorFinal(input, {
      onProgress: (incumbent) => progress.push(incumbent),
      onStatistics: (counters) => statistics.push(counters),
    });
    const counters = result.optimization!;

    expect(counters).toMatchObject({ status: "feasible", termination: "work-budget", evaluations: 24 });
    expect(counters.validatedCandidates! + counters.rejectedCandidates!).toBe(24);
    // Each evaluation reports once: a new incumbent or counters alone.
    expect(progress.length - 1 + statistics.length).toBe(24);
    statistics.forEach((entry, index) => {
      expect(Object.keys(entry).sort()).toEqual(
        ["evaluations", "rejectedCandidates", "rejectionReasons", "solveTimeMs", "validatedCandidates"],
      );
      expect(entry.validatedCandidates + entry.rejectedCandidates).toBe(entry.evaluations);
      if (index > 0) expect(entry.evaluations).toBeGreaterThan(statistics[index - 1].evaluations);
    });
    // The last improvement precedes the last evaluation, so only statistics carry the final counts.
    expect(progress.at(-1)!.optimization!.evaluations).toBeLessThan(24);
    expect(statistics.at(-1)).toMatchObject({
      evaluations: counters.evaluations,
      validatedCandidates: counters.validatedCandidates,
      rejectedCandidates: counters.rejectedCandidates,
      rejectionReasons: counters.rejectionReasons,
    });
    expect(progress[0].optimizedPath).toBeUndefined();
    expect(progress.length).toBeGreaterThan(1);
    // Every publication is a different, strictly faster validated trajectory.
    expect(progress.length).toBeLessThanOrEqual(1 + counters.validatedCandidates!);
    progress.slice(1).forEach((incumbent, index) => {
      expect(incumbent.optimizedPath).toBeDefined();
      expect(incumbent.samples).not.toBe(progress[index].samples);
      expect(incumbent.totalTimeS).toBeLessThan(progress[index].totalTimeS);
      expect(validateCorridorCandidate(input, incumbent)).toBe(true);
    });
    expect(result.samples).toEqual(progress.at(-1)!.samples);
    expect(result.optimizedPath).toEqual(progress.at(-1)!.optimizedPath);
    // Checkpoint counters never run ahead of the completed search.
    expect(progress.at(-1)!.optimization!.evaluations).toBeLessThanOrEqual(counters.evaluations!);
  }), 30_000);

  it("reports counters checked after the last improvement when the search is cancelled", () => withWorkBudget(() => {
    const path = project.paths.find((candidate) => candidate.id === corpus.cases[1].pathId)!;
    let improved: PlannerResult | undefined;
    let latest: CorridorSearchStatistics | undefined;
    let cancel = false;
    const cancelled = optimizeCorridorFinal({ path, robot: project.robot, samplesPerSegment: 56 }, {
      isCancelled: () => cancel,
      onProgress: (incumbent) => { if (incumbent.optimizedPath) improved = incumbent; },
      onStatistics: (counters) => {
        latest = counters;
        cancel = Boolean(improved) && counters.evaluations >= improved!.optimization!.evaluations! + 2;
      },
    });

    expect(cancelled.optimization).toMatchObject({ termination: "cancelled", evaluations: latest!.evaluations });
    expect(cancelled.optimization!.evaluations).toBeGreaterThan(improved!.optimization!.evaluations!);
    expect(cancelled.optimization).toMatchObject({
      validatedCandidates: latest!.validatedCandidates,
      rejectedCandidates: latest!.rejectedCandidates,
      rejectionReasons: latest!.rejectionReasons,
    });
    expect(cancelled.samples).toEqual(improved!.samples);
  }), 15_000);

  it("propagates a progress consumer failure instead of counting it as a rejected candidate", () => withWorkBudget(() => {
    const path = project.paths.find((candidate) => candidate.id === corpus.cases[1].pathId)!;
    let published = 0;
    expect(() => optimizeCorridorFinal({ path, robot: project.robot, samplesPerSegment: 56 }, {
      onProgress: (incumbent) => {
        published += 1;
        if (incumbent.optimizedPath) throw new Error("preview projection failed");
      },
    })).toThrow("preview projection failed");
    expect(published).toBe(2);
  }), 15_000);

  it("never worsens the validated result as deterministic work increases", () => withWorkBudget(() => {
    const fixture = corpus.cases[1];
    const path = project.paths.find((candidate) => candidate.id === fixture.pathId)!;
    let previousTime = Number.POSITIVE_INFINITY;
    for (const maximumEvaluations of [4, 12, 24, 48]) {
      const result = optimizeCorridorFinal({ path, robot: project.robot, samplesPerSegment: 56 }, {
        maximumEvaluations,
        budgetMs: 30_000,
      });
      expect(result.totalTimeS).toBeLessThanOrEqual(previousTime);
      expect(result.optimization?.status).not.toBe("optimal");
      expect(result.optimization!.validatedCandidates! + result.optimization!.rejectedCandidates!)
        .toBe(result.optimization?.evaluations);
      expect(result.optimization?.evaluations).toBeGreaterThan(0);
      expect(result.optimization?.evaluations).toBeLessThanOrEqual(maximumEvaluations);
      expect(["completed", "work-budget"]).toContain(result.optimization?.termination);
      if (result.optimization?.termination === "work-budget") expect(result.optimization.evaluations).toBe(maximumEvaluations);
      previousTime = result.totalTimeS;
    }
  }), 30_000);

  it("reports bounded candidate rejection evidence separately from result quality", () => {
    const fixture = corpus.cases[1];
    const path = project.paths.find((candidate) => candidate.id === fixture.pathId)!;
    const result = optimizeCorridorFinal({ path, robot: project.robot, samplesPerSegment: 56 }, {
      maximumEvaluations: 4,
      gates: [{ bounds: { xMin: -100, xMax: -99, yMin: -100, yMax: -99 } }],
    });
    expect(result.optimization).toMatchObject({
      status: "equivalent", termination: "work-budget", fallback: false,
      validatedCandidates: 0, rejectedCandidates: 4,
    });
    expect(result.optimization?.rejectionReasons).toContainEqual({ reason: "Missed a required gate", count: 4 });
  });

  it("is deterministic at a fixed evaluation ceiling", () => withWorkBudget(() => {
    const fixture = corpus.cases[1];
    const path = project.paths.find((candidate) => candidate.id === fixture.pathId)!;
    const input = { path, robot: project.robot, samplesPerSegment: 56 };
    const options = {
      corridorM: fixture.centerlineToFootprintBoundaryM - robotFootprintRadius(project.robot),
      gates: fixture.gates,
      budgetTier: "stress" as const,
      budgetMs: 15_000,
      maximumEvaluations: 24,
    };

    const first = optimizeCorridorFinal(input, options);
    const second = optimizeCorridorFinal(input, options);

    expect(second.optimizedPath).toEqual(first.optimizedPath);
    expect(second.samples).toEqual(first.samples);
    expect(second.optimization?.evaluations).toBe(first.optimization?.evaluations);
    expect(first.optimization).toMatchObject({ termination: "work-budget", evaluations: options.maximumEvaluations });
    expect(second.optimization).toMatchObject({ termination: "work-budget", evaluations: options.maximumEvaluations });
  }), 30_000);
});
