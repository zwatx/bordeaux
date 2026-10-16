import React from "react";
import { renderToString } from "react-dom/server";
import { PM } from "../src/renderer/lib/pathMath";
import { createDemoProject } from "../src/shared/project/defaults";
import { describe, expect, it } from "vitest";
import { FieldView, rangeLabelIndexes, toolRailLabelObstacle } from "../src/renderer/components/FieldView";

describe("renderer range labels", () => {
  it("caps dense label layout while preserving the selected range", () => {
    const indexes = rangeLabelIndexes(160, 159);

    expect(indexes.size).toBe(80);
    expect(indexes.has(159)).toBe(true);
  });
});


describe("HTML toolrail obstacle in root SVG coordinates", () => {
  it("accounts for centered vertical letterboxing rather than treating CSS y as image y", () => {
    const obstacle = toolRailLabelObstacle({ x: 20, y: 430, w: 80, h: 140 }, { width: 1000, height: 1000 }, { x: 300, y: -100, w: 2000, h: 1000 });
    expect(obstacle).toEqual({ x: 328, y: 248, w: 184, h: 304 });
  });
  it("accounts for horizontal letterboxing when height limits the meet scale", () => {
    const obstacle = toolRailLabelObstacle({ x: 250, y: 50, w: 80, h: 140 }, { width: 1000, height: 300 }, { x: 300, y: -100, w: 2000, h: 1000 });
    expect(obstacle.x).toBeCloseTo(446.6666666667); expect(obstacle.y).toBeCloseTo(46.6666666667);
    expect(obstacle.w).toBeCloseTo(306.6666666667); expect(obstacle.h).toBeCloseTo(506.6666666667);
  });
  it.each([
    [{ width: 850, height: 600 }, { x: 307, y: 7, w: 3285, h: 1569 }],
    [{ width: 520, height: 420 }, { x: 940, y: 220, w: 1642.5, h: 784.5 }],
    [{ width: 950, height: 420 }, { x: -200, y: 100, w: 3901, h: 1583 }],
  ])("maps the padded screen rectangle exactly through fit, pan/zoom, and Focus viewport changes", (viewport, view) => {
    const rail = { x: 14, y: 83, w: 88, h: 254 }, box = toolRailLabelObstacle(rail, viewport, view);
    // Independent forward projection of the obstacle's four edges must reserve exactly6CSSpx.
    const pxPerUnit = Math.min(viewport.width / view.w, viewport.height / view.h);
    const x = viewport.width / 2 + (box.x - view.x - view.w / 2) * pxPerUnit;
    const y = viewport.height / 2 + (box.y - view.y - view.h / 2) * pxPerUnit;
    expect(x).toBeCloseTo(rail.x - 6, 10); expect(y).toBeCloseTo(rail.y - 6, 10);
    expect(x + box.w * pxPerUnit).toBeCloseTo(rail.x + rail.w + 6, 10);
    expect(y + box.h * pxPerUnit).toBeCloseTo(rail.y + rail.h + 6, 10);
  });
  it("reserves nothing when the HTML rail is absent or the SVG has no layout", () => {
    const view = { x: 307, y: 7, w: 3285, h: 1569 };
    expect(toolRailLabelObstacle(null, { width: 1000, height: 600 }, view)).toBeNull();
    expect(toolRailLabelObstacle({ x: 14, y: 83, w: 88, h: 254 }, { width: 0, height: 0 }, view)).toBeNull();
  });
});

it("keeps labels and field geometry in root SVG coordinates when Flip rotates only the background image", () => {
  const project = createDemoProject(), doc = project.paths[0];
  doc.ranges = [{ anchor: "param", f0: .15, f1: .85, maxAngVel: .01, maxAngAccel: .004 }];
  const derived = PM.derivePath(doc, project.robot, 14, "profiledSpline");
  const render = alliance => renderToString(React.createElement(FieldView, { doc, derived, sel: { kind: "cr", idx: 0 }, tool: "select",
    view: { x: 307, y: 7, w: 3285, h: 1569 }, setView() {}, alliance, showGrid: false, robot: project.robot,
    drive: project.robot.drive, accent: "#fff", metric: "velocity", playTime: 0, actions: {} }));
  const blue = render("blue"), red = render("red");
  expect(blue).toContain('preserveAspectRatio="xMidYMid meet"');
  expect(red).toMatch(/<foreignObject[^>]* transform="rotate\(180 /);
  expect(red.replace(/(<foreignObject\b[^>]*?) transform="[^"]+"/, "$1")).toBe(blue);
});
