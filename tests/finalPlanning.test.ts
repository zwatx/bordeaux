import { directPreviewWork, directWorkIsSafe } from "../src/renderer/assets/direct-preview-work";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRendererExport } from "./helpers/loadRendererExport";

interface WorkerJob {
  id: number;
  quality: "interactive" | "final";
  perSegment: number;
  deadline: "common" | "stress" | "hard";
  deadlineMs: number;
}

class FakeWorker {
  readonly jobs: WorkerJob[] = [];
  terminated = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message?: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;

  postMessage(job: WorkerJob) { this.jobs.push(job); }
  resolve(data: unknown) { this.onmessage?.({ data }); }
  fail(message = "final worker failed") { this.onerror?.({ message }); }
  terminate() { this.terminated = true; }
}

function finalPlanningModule() {
  return loadRendererExport<{
    create(options: { workerFactory: () => FakeWorker; deadlines?: { common: number; stress: number; hard: number } }): {
      request(input: { path: unknown; robot: unknown; plannerId: string; optimize?: boolean }, options: { interactiveResult?: unknown; deadline?: "common" | "stress" | "hard"; failureNote?: string; onProgress?: (value: unknown) => void }): {
        promise: Promise<Record<string, unknown>>;
        cancel(): void;
      };
    };
  }>(new URL("../src/renderer/assets/final-planning.js", import.meta.url), "FinalPlanning", {
    context: { performance, setTimeout, clearTimeout },
    replacements: [[
      "return new Worker(new URL('./path-preview-worker.js', import.meta.url), { type: 'module' });",
      "return config.workerFactory();",
    ]],
  });
}

function previewModule() {
  return loadRendererExport<{
    create(options: { workerFactory: () => FakeWorker }): {
      request(input: { path: unknown; robot: unknown; plannerId: string; quality: "interactive" }): number;
      getSnapshot(): { status: string; value: unknown };
    };
  }>(new URL("../src/renderer/assets/path-preview.js", import.meta.url), "PathPreview", {
    context: { performance, queueMicrotask, setTimeout, clearTimeout, directPreviewWork, directWorkIsSafe },
    replacements: [[
      "return new Worker(new URL('./path-preview-worker.js', import.meta.url), { type: 'module' });",
      "return config.workerFactory();",
    ]],
  });
}

describe("final planning execution", () => {
  afterEach(() => vi.useRealTimers());

  it("completes through a final-planning request distinct from preview", async () => {
    const worker = new FakeWorker();
    const finalPlanning = finalPlanningModule().create({ workerFactory: () => worker });

    const request = finalPlanning.request(
      { path: { id: "path" }, robot: {}, plannerId: "profiledSpline" },
      { interactiveResult: { source: "interactive" } },
    );
    const job = worker.jobs[0];
    worker.resolve({ id: job.id, value: { source: "final" }, durationMs: 12 });

    await expect(request.promise).resolves.toEqual({
      status: "success",
      value: { source: "final" },
      durationMs: 12,
    });
    expect(job).toMatchObject({ quality: "final", perSegment: 56, deadline: "common", deadlineMs: 5_000 });
    expect(worker.terminated).toBe(true);
  });

  it("cancels final planning and returns the trustworthy interactive result", async () => {
    const worker = new FakeWorker();
    const finalPlanning = finalPlanningModule().create({ workerFactory: () => worker });
    const interactiveResult = { source: "interactive", revision: 4 };

    const request = finalPlanning.request(
      { path: { id: "path" }, robot: {}, plannerId: "profiledSpline" },
      { interactiveResult },
    );
    request.cancel();

    await expect(request.promise).resolves.toEqual({
      status: "canceled",
      fallback: interactiveResult,
      fallbackProvisional: true,
      fallbackReason: "Final planning was canceled; continuing with the last interactive result.",
    });
    expect(worker.terminated).toBe(true);
  });

  it.each(['failure', 'timeout', 'canceled'] as const)('reports a blocked routine preview on %s without claiming interactive playback', async outcome => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const planner = finalPlanningModule().create({ workerFactory: () => worker });
    const request = planner.request({ path: {}, robot: {}, plannerId: 'profiledSpline' }, {
      failureNote: 'Routine preview is unavailable.',
    });
    if (outcome === 'failure') worker.fail('worker unavailable');
    else if (outcome === 'timeout') await vi.advanceTimersByTimeAsync(6_000);
    else request.cancel();
    const result = await request.promise;
    expect(result.status).toBe(outcome);
    expect(result.fallback).toBeUndefined();
    expect(result.fallbackReason).toMatch(/routine preview is unavailable\./i);
    expect(result.fallbackReason).not.toMatch(/continuing|interactive result/i);
    expect(worker.terminated).toBe(true);
  });

  it.each([
    ["common", 5_000],
    ["stress", 15_000],
    ["hard", 30_000],
  ] as const)("times out at the configured %s deadline", async (deadline, deadlineMs) => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const finalPlanning = finalPlanningModule().create({ workerFactory: () => worker });
    const interactiveResult = { source: "interactive", revision: 5 };

    const request = finalPlanning.request(
      { path: { id: "path" }, robot: {}, plannerId: "profiledSpline" },
      { interactiveResult, deadline },
    );
    expect(worker.jobs[0]).toMatchObject({ deadline, deadlineMs });
    await vi.advanceTimersByTimeAsync(deadlineMs + 1_000);

    await expect(request.promise).resolves.toEqual({
      status: "timeout",
      deadline,
      deadlineMs,
      fallback: interactiveResult,
      fallbackProvisional: true,
      fallbackReason: `Final planning exceeded the ${deadline} deadline (${deadlineMs} ms); continuing with the last interactive result.`,
    });
    expect(worker.terminated).toBe(true);
  });

  it("accepts a validated baseline returned at the optimizer deadline", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const finalPlanning = finalPlanningModule().create({ workerFactory: () => worker });
    const request = finalPlanning.request(
      { path: { id: "path" }, robot: {}, plannerId: "optimizedTrajectory" },
      { interactiveResult: { source: "interactive" } },
    );

    await vi.advanceTimersByTimeAsync(5_000);
    expect(worker.terminated).toBe(false);
    worker.resolve({ id: worker.jobs[0].id, value: { source: "validated-baseline" }, durationMs: 5_000 });

    await expect(request.promise).resolves.toEqual({
      status: "success",
      value: { source: "validated-baseline" },
      durationMs: 5_000,
    });
  });

  it("reports final-planning failure with an explained interactive fallback", async () => {
    const worker = new FakeWorker();
    const finalPlanning = finalPlanningModule().create({ workerFactory: () => worker });
    const interactiveResult = { source: "interactive", revision: 6 };

    const request = finalPlanning.request(
      { path: { id: "path" }, robot: {}, plannerId: "profiledSpline" },
      { interactiveResult },
    );
    worker.fail("optimizer unavailable");

    await expect(request.promise).resolves.toEqual({
      status: "failure",
      error: { message: "optimizer unavailable" },
      fallback: interactiveResult,
      fallbackProvisional: true,
      fallbackReason: "Final planning failed: optimizer unavailable. Continuing with the last interactive result.",
    });
    expect(worker.terminated).toBe(true);
  });

  it("keeps the interactive result when the optimizer rejects its final candidate", async () => {
    const worker = new FakeWorker();
    const finalPlanning = finalPlanningModule().create({ workerFactory: () => worker });
    const interactiveResult = { source: "interactive", revision: 8 };
    const request = finalPlanning.request(
      { path: { id: "path" }, robot: {}, plannerId: "optimizedTrajectory" },
      { interactiveResult },
    );

    worker.resolve({ id: worker.jobs[0].id, finalFallbackReason: "candidate failed dense validation" });

    await expect(request.promise).resolves.toEqual({
      status: "failure",
      error: { message: "candidate failed dense validation" },
      fallback: interactiveResult,
      fallbackProvisional: true,
      fallbackReason: "Final planning failed: candidate failed dense validation. Continuing with the last interactive result.",
    });
  });

  it("returns a failure result when final-planning execution cannot start", async () => {
    const finalPlanning = finalPlanningModule().create({
      workerFactory: () => { throw new Error("worker unavailable"); },
    });
    const interactiveResult = { source: "interactive", revision: 7 };

    const request = finalPlanning.request(
      { path: { id: "path" }, robot: {}, plannerId: "profiledSpline" },
      { interactiveResult },
    );

    await expect(request.promise).resolves.toEqual({
      status: "failure",
      error: { message: "worker unavailable" },
      fallback: interactiveResult,
      fallbackProvisional: true,
      fallbackReason: "Final planning failed: worker unavailable. Continuing with the last interactive result.",
    });
  });

  it("allows interactive preview to complete while final planning is still running", async () => {
    const finalWorker = new FakeWorker();
    const previewWorker = new FakeWorker();
    const finalPlanning = finalPlanningModule().create({ workerFactory: () => finalWorker });
    const preview = previewModule().create({ workerFactory: () => previewWorker });

    const finalRequest = finalPlanning.request(
      { path: { id: "path", x: 1 }, robot: {}, plannerId: "profiledSpline" },
      { interactiveResult: { source: "interactive", x: 0 } },
    );
    const previewRevision = preview.request({
      path: { id: "path", x: 2 },
      robot: {},
      plannerId: "profiledSpline",
      quality: "interactive",
    });
    previewWorker.resolve({ id: previewRevision, value: { source: "interactive", x: 2 }, durationMs: 1 });

    expect(preview.getSnapshot()).toMatchObject({
      status: "ready",
      value: { source: "interactive", x: 2 },
    });
    expect(finalWorker.terminated).toBe(false);
    finalRequest.cancel();
    await finalRequest.promise;
  });

  it.each(['timeout', 'failure', 'canceled'] as const)("retains a validated incumbent separately after %s", async (outcome) => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const finalPlanning = finalPlanningModule().create({ workerFactory: () => worker });
    const onProgress = vi.fn();
    const request = finalPlanning.request(
      { path: {}, robot: {}, plannerId: 'profiledSpline', optimize: true },
      { onProgress },
    );
    const incumbent = { finalTrajectory: { totalTimeS: 3.7 } };
    worker.resolve({ id: worker.jobs[0].id, type: 'progress', value: incumbent });
    expect(onProgress).toHaveBeenCalledWith(incumbent);
    expect(worker.terminated).toBe(false);

    if (outcome === 'timeout') await vi.advanceTimersByTimeAsync(6_000);
    else if (outcome === 'failure') worker.fail('worker interrupted');
    else request.cancel();

    const result = await request.promise;
    expect(result.status).toBe(outcome);
    expect(result.incumbent).toEqual(incumbent);
    expect(result.value).toBeUndefined();
    expect(result.fallbackReason).toMatch(/selected trajectory was not changed/);
    worker.resolve({ id: worker.jobs[0].id, type: 'progress', value: { source: 'late' } });
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  function searchIncumbent(evaluations: number) {
    const optimization = {
      status: "feasible", totalTimeS: 3.2, gainS: 0.5, evaluations,
      validatedCandidates: 9, rejectedCandidates: evaluations - 9,
      rejectionReasons: [{ reason: "Outside the authored corridor", count: evaluations - 9 }],
    };
    return {
      prof: { t: [0, 1.6, 3.2] },
      finalTrajectory: { totalTimeS: 3.2, samples: [{ t: 0 }, { t: 3.2 }], optimization },
      finalOptimization: optimization,
    };
  }

  it.each([
    ["timeout", "time-budget"],
    ["canceled", "cancelled"],
    ["failure", undefined],
  ] as const)("refreshes the retained incumbent's counters from statistics after %s", async (outcome, termination) => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const finalPlanning = finalPlanningModule().create({ workerFactory: () => worker });
    const onProgress = vi.fn();
    const request = finalPlanning.request(
      { path: {}, robot: {}, plannerId: "profiledSpline", optimize: true },
      { onProgress },
    );
    const id = worker.jobs[0].id;
    const incumbent = searchIncumbent(21);
    const authored = structuredClone(incumbent);
    worker.resolve({ id, type: "progress", value: incumbent });
    const reasons = [{ reason: "Outside the authored corridor", count: 14 }, { reason: "Missed a required gate", count: 1 }];
    worker.resolve({ id, type: "statistics", statistics: { evaluations: 23, validatedCandidates: 9, rejectedCandidates: 14 } });
    worker.resolve({
      id, type: "statistics",
      // Keys outside the counters cannot alter the validated route or its result.
      statistics: { solveTimeMs: 812, evaluations: 24, validatedCandidates: 9, rejectedCandidates: 15, rejectionReasons: reasons, status: "optimal", totalTimeS: 0.1, samples: [] },
    });
    worker.resolve({ id: id - 1, type: "statistics", statistics: { evaluations: 99 } });
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(worker.terminated).toBe(false);

    if (outcome === "timeout") await vi.advanceTimersByTimeAsync(6_000);
    else if (outcome === "failure") worker.fail("worker interrupted");
    else request.cancel();

    const result = await request.promise;
    const retained = result.incumbent as ReturnType<typeof searchIncumbent>;
    expect(result.status).toBe(outcome);
    expect(retained.finalOptimization).toEqual({
      ...authored.finalOptimization,
      solveTimeMs: 812, evaluations: 24, rejectedCandidates: 15, rejectionReasons: reasons,
      ...(termination ? { termination } : {}),
    });
    expect(retained.finalTrajectory.optimization).toBe(retained.finalOptimization);
    expect(retained.finalTrajectory.totalTimeS).toBe(3.2);
    // Trajectory data is shared, and the published incumbent is not mutated.
    expect(retained.finalTrajectory.samples).toBe(incumbent.finalTrajectory.samples);
    expect(retained.prof).toBe(incumbent.prof);
    expect(incumbent).toEqual(authored);
  });

  it("keeps a newer incumbent's own counters and the final result's exact counters on success", async () => {
    const worker = new FakeWorker();
    const finalPlanning = finalPlanningModule().create({ workerFactory: () => worker });
    const request = finalPlanning.request(
      { path: {}, robot: {}, plannerId: "profiledSpline", optimize: true },
      {},
    );
    const id = worker.jobs[0].id;
    worker.resolve({ id, type: "progress", value: searchIncumbent(10) });
    worker.resolve({ id, type: "statistics", statistics: { evaluations: 12, rejectedCandidates: 3 } });
    const improved = searchIncumbent(13);
    worker.resolve({ id, type: "progress", value: improved });
    const final = { ...searchIncumbent(24), finalOptimization: { ...searchIncumbent(24).finalOptimization, termination: "work-budget" } };
    worker.resolve({ id, value: final, durationMs: 40 });

    const result = await request.promise;
    expect(result).toMatchObject({ status: "success", durationMs: 40 });
    expect(result.value).toBe(final);
    expect(result.incumbent).toBe(improved);
  });

  it.each([
    [{ id: 1, type: "statistics" }, "invalid statistics"],
    [{ id: 1, type: "statistics", statistics: 24 }, "invalid statistics"],
    [{ id: 1, type: "progress", statistics: { evaluations: 24 } }, "invalid progress"],
  ])("fails the run for a malformed search message %#", async (message, error) => {
    const worker = new FakeWorker();
    const finalPlanning = finalPlanningModule().create({ workerFactory: () => worker });
    const request = finalPlanning.request(
      { path: {}, robot: {}, plannerId: "profiledSpline", optimize: true },
      { interactiveResult: { source: "interactive" } },
    );
    worker.resolve({ ...message, id: worker.jobs[0].id });

    await expect(request.promise).resolves.toMatchObject({
      status: "failure",
      error: { message: `The final-planning worker returned ${error}` },
    });
    expect(worker.terminated).toBe(true);
  });

  it("ignores stale progress and final messages without settling the current run", async () => {
    const worker = new FakeWorker();
    const finalPlanning = finalPlanningModule().create({ workerFactory: () => worker });
    const onProgress = vi.fn();
    const request = finalPlanning.request(
      { path: {}, robot: {}, plannerId: 'profiledSpline', optimize: true },
      { onProgress },
    );
    const id = worker.jobs[0].id;
    worker.resolve({ id: id - 1, type: 'progress', value: { source: 'stale-progress' } });
    worker.resolve({ id: id - 1, value: { source: 'stale-final' } });
    expect(onProgress).not.toHaveBeenCalled();
    expect(worker.terminated).toBe(false);
    worker.resolve({ id, value: { source: 'current' } });
    await expect(request.promise).resolves.toMatchObject({ status: 'success', value: { source: 'current' } });
  });
});
