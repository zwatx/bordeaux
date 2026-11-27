import { describe, expect, it } from "vitest";
// @ts-expect-error The comparison hook remains a JavaScript module.
import { useOptimizerComparison } from "../src/renderer/hooks/useOptimizerComparison";

const path = { id: "path" }, robot = {}, field = {};
const context = { path, robot, field, plannerId: "profiledSpline", previewDensity: 56, projectionVersion: 1 };
const preview = (patch = {}) => ({ path, robot, field, plannerId: "profiledSpline", previewDensity: 56, projectionVersion: 1,
  value: { prof: { totalTime: 3 } }, trajectory: { totalTimeS: 3 }, ...patch });
const editing = (patch = {}) => ({ ready: true, status: "ok", pending: false, issues: [], retry: () => {}, strictPreview: preview(), ...patch });

describe("the current path row of the Optimize panel", () => {
  it("is the editing plan of the current path, with its time as the baseline", () => {
    const current = editing();
    const { normal, baselineTime } = useOptimizerComparison({ context, editing: current });
    expect(normal).toMatchObject({ status: "ready", value: current.strictPreview.value, error: null });
    expect(baselineTime).toBe(3);
  });

  it("waits while the path replans, and never shows a plan of other inputs", () => {
    expect(useOptimizerComparison({ context, editing: editing({ pending: true, ready: false, status: "pending", strictPreview: null }) }).normal.status).toBe("pending");
    const stale = useOptimizerComparison({ context, editing: editing({ strictPreview: preview({ path: { id: "path" } }) }) });
    expect(stale.normal.status).toBe("error");
    expect(stale.baselineTime).toBeNull();
  });

  it("reports why the current path cannot be timed and retries through editing", () => {
    const retry = () => {};
    const failed = useOptimizerComparison({ context, editing: editing({ ready: false, status: "infeasible", strictPreview: null, retry,
      issues: [{ severity: "error", message: "Entry speed exceeds the limit" }] }) });
    expect(failed.normal).toMatchObject({ status: "error", error: { message: "Entry speed exceeds the limit" }, errorKind: "failure", retry });
  });
});
