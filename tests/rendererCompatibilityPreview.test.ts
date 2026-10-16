import fs from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error The production preview engine is an intentional JavaScript module.
import { PM as RendererPM } from "../src/renderer/lib/pathMath";
import { PM as SharedPM } from "../src/shared/math/pm";
import { buildWaypoints, createDemoProject } from "../src/shared/project/defaults";
import { loadRendererExport } from "./helpers/loadRendererExport";

interface Point { x: number; y: number; heading: number; curv: number }
const rendererMath: {
  derivePath(path: unknown, robot: unknown, perSegment: number, plannerId: string): {
    sample: { pts: Array<Point & { s: number }>; length: number };
    prof: { totalTime: number; head: number[] };
  };
} = RendererPM;

function rendererPathLinks() {
  return loadRendererExport<{
    reconcile(project: any): any;
    sync(project: any, changedId: string, before: any): any;
  }>(new URL("../src/renderer/lib/pathLinks.js", import.meta.url), "PathLinks");
}

describe("renderer application", () => {
  it("derives finite previews with each maintained planner", () => {
    const project = createDemoProject();
    for (const planner of ["profiledSpline", "optimizedTrajectory"]) {
      const preview = rendererMath.derivePath(project.paths[0], project.robot, 56, planner);
      expect(preview.sample.pts.length).toBeGreaterThan(2);
      expect(preview.sample.pts.every((point) => Number.isFinite(point.x + point.y + point.s))).toBe(true);
      expect(preview.sample.length).toBeGreaterThan(0);
      expect(preview.prof.totalTime).toBeGreaterThan(0);
    }
  });

  it("keeps terminal heading previews finite with acceleration-only regions", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.waypoints = buildWaypoints([{ x: 1, y: 1, theta: 0 }, { x: 2, y: 1, theta: 180 }]);
    path.targets = [{ f: 0, deg: 0 }, { f: 1, deg: 180 }];
    path.ranges = [{ f0: 0, f1: 1, anchor: "param", maxAccel: 0.5 }];
    const preview = rendererMath.derivePath(path, project.robot, 56, "profiledSpline");
    expect(Number.isFinite(preview.prof.totalTime)).toBe(true);
    expect(preview.prof.head.every(Number.isFinite)).toBe(true);
    expect(preview.prof.head.at(-1)).toBeCloseTo(Math.PI, 2);
  });

  it("uses the same curvature-continuous linked geometry in interactive and final planning", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.waypoints = buildWaypoints([
      { x: 1, y: 1, theta: 0, nextC: { x: 2, y: 1 } },
      {
        x: 3, y: 2, theta: 0,
        prevC: { x: 3, y: 1.2 },
        nextC: { x: 3, y: 3.1 },
      },
      { x: 6, y: 3, theta: 0, prevC: { x: 4, y: 3 } },
    ]);
    const shared = SharedPM.sample(path.waypoints, 224).pts;
    const renderer = rendererMath.derivePath(path, project.robot, 224, "optimizedTrajectory").sample.pts;
    const boundary = 224;

    expect(renderer).toHaveLength(shared.length);
    shared.forEach((point, index) => {
      expect(renderer[index].x).toBeCloseTo(point.x, 10);
      expect(renderer[index].y).toBeCloseTo(point.y, 10);
      expect(renderer[index].heading).toBeCloseTo(point.heading, 10);
      expect(renderer[index].curv).toBeCloseTo(point.curv, 10);
    });
    expect(Math.abs(shared[boundary].curv - shared[boundary + 1].curv)).toBeLessThan(0.05);
  });

  it("keeps an incoming Tangent segment tangent until its outgoing heading law begins", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    const tangent = 45 * Math.PI / 180;
    const handleLength = 0.05;
    path.waypoints = buildWaypoints([
      {
        x: 1, y: 1, theta: 0, segType: "bezier", segmentHeadingMode: "tangent",
        nextC: { x: 2, y: 1 },
      },
      {
        x: 3, y: 2, theta: 0, segType: "line", segmentHeadingMode: "targets",
        prevC: {
          x: 3 - Math.cos(tangent) * handleLength,
          y: 2 - Math.sin(tangent) * handleLength,
        },
        headingTransition: { placement: "after", rotationPriority: "translation", distanceM: 0.75 },
      },
      { x: 6, y: 2, theta: -90, segType: "line" },
    ]);
    const preview = rendererMath.derivePath(path, project.robot, 56, "optimizedTrajectory");
    const boundary = preview.sample.pts.reduce((nearest, point, index) => (
      Math.hypot(point.x - 3, point.y - 2) < Math.hypot(
        preview.sample.pts[nearest].x - 3,
        preview.sample.pts[nearest].y - 2,
      ) ? index : nearest
    ), 0);
    const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

    for (let index = 0; index <= boundary; index += 1) {
      expect(Math.abs(wrap(preview.prof.head[index] - preview.sample.pts[index].heading))).toBeLessThan(Math.PI / 180);
    }
    expect(Math.abs(wrap(preview.prof.head[boundary] - tangent))).toBeLessThan(0.25 * Math.PI / 180);
    expect(Math.max(...preview.prof.head.slice(boundary + 1).map((heading) => Math.abs(wrap(heading - tangent)))))
      .toBeGreaterThan(10 * Math.PI / 180);
  });

  it("loads React through the typed renderer module entry without compatibility globals", () => {
    const html = fs.readFileSync(new URL("../src/renderer/index.html", import.meta.url), "utf8");
    const main = fs.readFileSync(new URL("../src/renderer/main.tsx", import.meta.url), "utf8");
    expect(html).toContain('<script type="module" src="/main.tsx"></script>');
    expect(html).not.toContain("react.production.min.js");
    expect(main).toContain('from "react"');
    expect(main).toContain('from "react-dom/client"');
    expect(main).toContain('from "./app/App"');
    expect(main).not.toContain("window.React");
    expect(fs.existsSync(new URL("../src/renderer/legacy", import.meta.url))).toBe(false);
  });

  it("presents deliberate optimization and BDX export", () => {
    const panels = fs.readFileSync(new URL("../src/renderer/components/Panels.jsx", import.meta.url), "utf8");
    const app = fs.readFileSync(new URL("../src/renderer/app/App.jsx", import.meta.url), "utf8");
    expect(panels).toContain("optimizationApplied ? 'Optimized' : 'Optimize'");
    expect(panels).not.toContain("function PlannerFamily");
    expect(app).toContain("exportBdx");
    expect(app).not.toContain("exportRobot");
    expect(panels).not.toMatch(/LabVIEW|labview/);
    expect(panels).toContain("props.project");
    // Save keeps writing BDX files; a BDX failure after a saved workspace is its own status, not a lost project.
    const projectChip = fs.readFileSync(new URL("../src/renderer/components/ProjectChip.jsx", import.meta.url), "utf8");
    expect(projectChip).toContain("'Project saved · BDX files failed'");
    expect(app).toContain("retryExport");
    expect(app).toContain("normalizeProjectData(raw)");
  });

  it("uses the waypoint as the only heading transition anchor", () => {
    const inspector = fs.readFileSync(new URL("../src/renderer/components/ContextInspector.jsx", import.meta.url), "utf8");
    const app = fs.readFileSync(new URL("../src/renderer/app/App.jsx", import.meta.url), "utf8");
    expect(inspector).not.toContain("'Heading transition'");
    expect(inspector).not.toContain("'Automatically blends through this waypoint.'");
    expect(inspector).not.toContain("'Heading blend placement'");
    expect(inspector).not.toContain("label: 'Blend distance'");
    expect(inspector).not.toContain("label: 'Before'");
    expect(inspector).not.toContain("label: 'At'");
    expect(inspector).not.toContain("label: 'After'");
    expect(inspector).not.toContain("label: 'Keep tangent'");
    expect(inspector).not.toContain("label: 'Meet heading'");
    expect(inspector).not.toContain("Timing priority");
    expect(inspector).not.toContain("timing priority");
    expect(app).not.toContain("setHeadingTransition");
  });

  it("draws heading guides from the accepted trajectory", () => {
    const fieldView = fs.readFileSync(new URL("../src/renderer/components/FieldView.jsx", import.meta.url), "utf8");
    expect(fieldView).toContain("const plannedHeadingAt = (fraction) =>");
    expect(fieldView).toContain("M.head[before] + PM.angWrap(M.head[after] - M.head[before]) * progress");
    expect(fieldView).toContain("segmentMode(segment) === 'tangent' ? pf.heading : plannedHeadingAt(f)");
  });

  it("uses canonical shared project state without local compatibility mirrors", () => {
    const app = fs.readFileSync(new URL("../src/renderer/app/App.jsx", import.meta.url), "utf8");
    expect(app).toContain('normalizeProject as normalizeProjectData');
    expect(app).not.toMatch(/project\.routine(?!s)/);
    expect(app).not.toMatch(/\.\.\.project,\s*routine[,}]/);
    expect(app).toContain("const plannerId = 'profiledSpline'");
    expect(app).toContain("doc.optimization?.accepted");
    expect(app).not.toContain("setPlannerId");
  });

  it("persists and restores the selected path and Robot project bookmark", () => {
    const app = fs.readFileSync(new URL("../src/renderer/app/App.jsx", import.meta.url), "utf8");
    expect(app).toContain("withRobotLink(projectRef.current, result.editorLink)");
    expect(app).toContain("restoreRobotCode(session.context, robotGeneration)");
    expect(app).toContain("activePathId }" );
    expect(app).toContain("const requestedPathId = next.editor && next.editor.activePathId");
    expect(app).toContain("openRecentRobotProject(next.editor.robotProjectBookmarkId, robotGeneration)");
    expect(app).toContain("robotRestoreGeneration.current !== generation");
    expect(app).toContain("window.bordeauxAPI.autosaveProject");
  });

  it("keeps linked path endpoint positions synchronized while heading remains local", () => {
    const links = rendererPathLinks();
    const project = createDemoProject();
    const source = structuredClone(project.paths[0]);
    const target = structuredClone(source);
    source.id = "path_source";
    target.id = "path_target";
    target.waypoints[0].x = 8;
    target.waypoints[0].theta = 73;
    target.waypoints[0].thetaOn = !source.waypoints.at(-1)!.thetaOn;
    target.waypoints[0].prevC.x += 3;
    target.waypoints[0].nextC.x += 3;
    const linked = { ...project, paths: [source, target], pathLinks: [{ id: "link_1", fromPathId: source.id, toPathId: target.id }] };

    const reconciled = links.reconcile(linked);
    expect(reconciled.paths[1].waypoints[0]).toMatchObject({
      x: source.waypoints.at(-1)!.x,
      y: source.waypoints.at(-1)!.y,
      theta: target.waypoints[0].theta,
      thetaOn: target.waypoints[0].thetaOn,
    });
    expect(reconciled.paths[1].waypoints[0].stop).toBe(target.waypoints[0].stop);

    const beforeSource = structuredClone(reconciled.paths[0]);
    const movedSource = structuredClone(beforeSource);
    movedSource.waypoints.at(-1)!.x += 1;
    const forward = links.sync({ ...reconciled, paths: [movedSource, reconciled.paths[1]] }, movedSource.id, beforeSource);
    expect(forward.paths[1].waypoints[0].x).toBe(movedSource.waypoints.at(-1)!.x);

    const beforeTarget = structuredClone(forward.paths[1]);
    const movedTarget = structuredClone(beforeTarget);
    movedTarget.waypoints[0].y += 1;
    const reverse = links.sync({ ...forward, paths: [forward.paths[0], movedTarget] }, movedTarget.id, beforeTarget);
    expect(reverse.paths[0].waypoints.at(-1)!.y).toBe(movedTarget.waypoints[0].y);
  });

  it("contains planner failures", () => {
    const app = fs.readFileSync(new URL("../src/renderer/app/App.jsx", import.meta.url), "utf8");
    // A failed timing job never blocks editing: it is one error alert with a retry.
    expect(app).toContain("editingFailure && { id: 'planning', error: true");
    expect(app).toContain("action: { label: 'Try again', onClick: editing.retry }");
    const status = fs.readFileSync(new URL("../src/renderer/components/FieldStatus.jsx", import.meta.url), "utf8");
    expect(status).toContain("role: primary.error ? 'alert' : 'status'");
    expect(app).toContain("class AppErrorBoundary");
  });

  it("places deliberate optimization in its own panel", () => {
    const app = fs.readFileSync(new URL("../src/renderer/app/App.jsx", import.meta.url), "utf8");
    expect(app).toContain("optimizationOpen ? h(OptimizationPanel");
    expect(app).not.toContain("Optimizing the final trajectory…");
  });

  it("graphs authoritative stationary heading catch-up instead of forcing angular velocity to zero", () => {
    const model = fs.readFileSync(new URL("../src/renderer/components/pathTimelineModel.js", import.meta.url), "utf8");
    expect(model).not.toContain("if (metric !== 'velocity') return 0");
    expect(model).toContain("derived.finalTrajectory");
    expect(model).toContain("sample.angularVelocityRadps");
  });

  it("wires field gestures through the shared coalesced drag controller", () => {
    const field = fs.readFileSync(new URL("../src/renderer/components/FieldView.jsx", import.meta.url), "utf8");
    expect(field).toContain("PointerDrag.useController");
    expect(field).toContain("coalesce: true");
  });

  it("offers clustered tool aliases and preserves the established shortcuts", () => {
    const app = fs.readFileSync(new URL("../src/renderer/app/App.jsx", import.meta.url), "utf8");
    const panels = fs.readFileSync(new URL("../src/renderer/components/Panels.jsx", import.meta.url), "utf8");
    expect(app).toContain("TOOL_SHORTCUTS[k]");
    const shortcuts = fs.readFileSync(new URL("../src/renderer/components/KeyboardHelp.jsx", import.meta.url), "utf8");
    for (const [key, tool] of Object.entries({ v: 'select', w: 'waypoint', r: 'rotation', m: 'marker', c: 'range' })) expect(shortcuts).toContain(key + ": '" + tool + "'");
    expect(panels).toContain("alternateKey: 'V'");
    expect(panels).toContain("alternateKey: 'C'");
  });

  it("keeps the path fixed when flipping the field background", () => {
    const field = fs.readFileSync(new URL("../src/renderer/components/FieldView.jsx", import.meta.url), "utf8");
    const app = fs.readFileSync(new URL("../src/renderer/app/App.jsx", import.meta.url), "utf8");
    expect(field).toContain("transform: flip ? `rotate(180 ${FIELD_CX} ${FIELD_CY})` : undefined");
    expect(field).toContain("const W2P = useCallback((p) => ({ x: wx(p.x), y: wy(p.y) }), []);");
    expect(field).not.toContain("FIELD_W - p.x");
    expect(field).not.toContain("FIELD_H - p.y");
    expect(field.match(/\bflip\b/g)).toHaveLength(2);
    const agentSync = fs.readFileSync(new URL("../src/renderer/lib/agentSessionSync.js", import.meta.url), "utf8");
    expect(app).not.toContain("const flip = alliance === 'red' ? -1 : 1");
    expect(agentSync).toContain("allianceView: 'blue'");
    expect(app + agentSync).not.toContain("allianceView: alliance");
  });

  it("keeps dormant Chap assets out of the application shell", () => {
    const html = fs.readFileSync(new URL("../src/renderer/index.html", import.meta.url), "utf8");
    const panels = fs.readFileSync(new URL("../src/renderer/components/Panels.jsx", import.meta.url), "utf8");
    expect(html).not.toContain("wrlp-chap-bird-original.svg");
    expect(html).not.toContain("boot-splash");
    expect(panels).not.toContain("brand-mark");
    // The brand is the window's title; the toolbar's first slot is the open project.
    expect(html).toContain("<title>Bordeaux</title>");
    expect(panels).not.toContain("brand-name");
  });
});
