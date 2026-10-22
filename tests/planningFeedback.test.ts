import { describe, expect, it } from "vitest";
import { finalPlanningError, formatDeadline, planningErrorMessage, planningNotice } from "../src/renderer/lib/planningFeedback";
import { loadRendererExport } from "./helpers/loadRendererExport";

type Planner = { create(options: { workerFactory: () => unknown; deadlines?: { common: number } }): {
  request(input: unknown, options: { deadline: "common"; interactiveResult?: unknown }): { promise: Promise<{ status: string; fallbackReason?: string; deadlineMs?: number }> };
} };
const FinalPlanning = loadRendererExport<Planner>(new URL("../src/renderer/assets/final-planning.js", import.meta.url), "FinalPlanning", {
  context: { setTimeout, clearTimeout },
  replacements: [["return new Worker(new URL('./path-preview-worker.js', import.meta.url), { type: 'module' });", "return config.workerFactory();"]],
});

describe("planning feedback presentation", () => {
  it("shows serialized worker error messages", () => {
    expect(planningErrorMessage({ name: "Error", message: "Velocity limit could not be satisfied" })).toBe("Velocity limit could not be satisfied");
  });

  it("removes fallback boilerplate that contradicts the blocked editor", () => {
    const error = new Error("Final planning failed: Heading tracking could not satisfy the configured angular limits. Continuing with the last interactive result.");
    expect(planningErrorMessage(error)).toBe("Heading tracking could not satisfy the configured angular limits");
  });

  it("explains an interactive or final failure with a limits recovery", () => {
    for (const kind of ["interactive", "failure"] as const) {
      const notice = planningNotice(new Error("Velocity limit could not be satisfied"), kind);
      expect(notice).toEqual({ kind, label: "Trajectory unavailable", recovery: "limits",
        detail: "Velocity limit could not be satisfied. Edit the limits or undo the last change to try again." });
    }
  });

  it("presents nothing without an error", () => {
    expect(planningNotice(null, "timeout")).toBeNull();
    expect(planningNotice(new Error("x"), null)).toBeNull();
  });

  it("formats deadlines in seconds", () => {
    expect(formatDeadline(5000)).toBe("5 s");
    expect(formatDeadline(1500)).toBe("1.5 s");
    expect(formatDeadline(undefined)).toBe("its time limit");
  });
});

describe("final planning results", () => {
  it("describes a timeout as blocked with a retry, never as continuing", async () => {
    // A worker that never answers exercises the real deadline path deterministically.
    const silentWorker = () => ({ postMessage() {}, terminate() {}, onmessage: null, onerror: null, onmessageerror: null });
    const planner = FinalPlanning.create({ workerFactory: silentWorker, deadlines: { common: 1 } });
    const result = await planner.request({ path: {} }, { deadline: "common", interactiveResult: { stale: true } }).promise;
    expect(result.status).toBe("timeout");
    expect(result.fallbackReason).toMatch(/continuing with the last interactive result/i);

    const { kind, error } = finalPlanningError(result);
    expect(kind).toBe("timeout");
    expect(error.message).toBe("Planning did not finish within 0.001 s.");
    const notice = planningNotice(error, kind)!;
    expect(notice.label).toBe("Planning timed out");
    expect(notice.recovery).toBe("retry");
    expect(notice.detail).not.toMatch(/continuing/i);
    expect(notice.detail).toMatch(/Playback and field edits need a trajectory/);
  });

  it("strips the fallback clause from a final failure", () => {
    const { kind, error } = finalPlanningError({ status: "failure", fallbackReason: "Final planning failed: Corridor blocked. Continuing with the last interactive result." });
    expect(kind).toBe("failure");
    expect(error.message).toBe("Corridor blocked");
  });
});
