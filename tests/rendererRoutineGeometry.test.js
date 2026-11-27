import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { stableRoutineOverlay } from "../src/renderer/app/App";
import { FieldView } from "../src/renderer/components/FieldView";
import { AUTO } from "../src/renderer/lib/routineModel";
import { createDemoProject } from "../src/core/project/defaults";

const FIT = { x: 307, y: 7, w: 3285, h: 1569 };
const derived = { sample: { pts: [], length: 0 }, prof: { totalTime: 0 }, metrics: { head: [] }, anchors: [], checks: [], wpFrac: [], wpIdx: [], effRanges: [], mode: "swerve", rev: false };

/** Route points whose coordinate reads are counted, as a proxy for SVG geometry construction. */
function countedPoints(count, y, reads) {
  return Array.from({ length: count }, (_, index) => {
    const point = { y };
    Object.defineProperty(point, "x", { enumerable: true, get: () => { reads.count += 1; return 1 + index * 0.05; } });
    return point;
  });
}

function routineRun(reads) {
  const segs = ["A", "B", "C"].map((id, index) => ({
    nodeId: id, kind: "path", label: "Path " + id, step: index + 1, t0: index, t1: index + 1, pts: countedPoints(200, 2 + index, reads),
  }));
  return { segs, steps: segs.map((seg, segIdx) => ({ t0: seg.t0, t1: seg.t1, segIdx })), total: 3 };
}

function renderField(routine, view = FIT) {
  const project = createDemoProject();
  return renderToString(React.createElement(FieldView, {
    doc: project.paths[0], derived, sel: { kind: null, idx: -1 }, tool: "select", view, setView: () => {}, alliance: "blue", showGrid: true,
    robot: project.robot, drive: project.robot.drive, accent: "#3f6fd0", metric: "velocity", playTime: 0, actions: {}, routine, routinePose: { x: 2, y: 2, heading: 0 },
  }));
}

const hitTargets = (html) => [...html.matchAll(/<path [^>]*data-role="rpath" data-idx="([^"]+)"/g)].map((match) => match[1]);
const numberSteps = (html) => [...html.matchAll(/<g class="routine-step-number[^"]*" data-role="rpath" data-idx="([^"]+)" data-step="([^"]+)"/g)].map((match) => match[1] + match[2]);
const routeData = (html) => new Set([...html.matchAll(/ d="(M [^"]+)"/g)].map((match) => match[1]).filter((d) => d.split(" L ").length > 100));

describe("routine playback geometry", () => {
  it("keeps the overlay while playback stays within one step", () => {
    const run = routineRun({ count: 0 });
    const first = AUTO.fieldOverlay(run, { time: 1.1, running: true });
    const within = stableRoutineOverlay(first, AUTO.fieldOverlay(run, { time: 1.9, running: true }));
    const crossed = stableRoutineOverlay(within, AUTO.fieldOverlay(run, { time: 2.1, running: true }));

    expect(within).toBe(first);
    expect(crossed).not.toBe(first);
    expect(crossed.map((segment) => segment.state)).toEqual(["done", "done", "active"]);
  });

  it("builds route geometry once across playback, step changes and zoom", () => {
    const reads = { count: 0 };
    const run = routineRun(reads);
    const early = renderField(AUTO.fieldOverlay(run, { time: 0.5, running: true }));
    const built = reads.count;
    expect(built).toBeGreaterThan(0);

    const later = renderField(AUTO.fieldOverlay(run, { time: 1.5, running: true }));
    const zoomed = renderField(AUTO.fieldOverlay(run, { time: 1.5, running: true }), { x: 900, y: 300, w: FIT.w / 2, h: FIT.h / 2 });
    const selected = renderField(AUTO.fieldOverlay(run, { running: false, selectedId: "C" }));
    expect(reads.count).toBe(built);

    // Emphasized segments draw last; every segment keeps its hit target.
    expect(hitTargets(early)).toEqual(["B", "C", "A"]);
    expect(hitTargets(later)).toEqual(["A", "C", "B"]);
    expect(hitTargets(selected)).toEqual(["A", "B", "C"]);
    // Playback numbers only the running step; a selected step and its neighbors keep their numbers (selected first).
    expect(numberSteps(early)).toEqual(["A1"]);
    expect(numberSteps(selected)).toEqual(["C3", "B2"]);
    expect(routeData(early).size).toBe(3);
    expect(routeData(later)).toEqual(routeData(early));
    expect(routeData(zoomed)).toEqual(routeData(early));
    expect(zoomed).not.toBe(later);

    const replanned = { ...run, segs: run.segs.map((segment, index) => index === 1 ? { ...segment, pts: countedPoints(200, 6, reads) } : segment) };
    renderField(AUTO.fieldOverlay(replanned, { time: 1.5, running: true }));
    expect(reads.count).toBeGreaterThan(built);
  });
});
