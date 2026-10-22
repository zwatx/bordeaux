import { describe, expect, it } from "vitest";
// @ts-expect-error Routine authoring remains a legacy JavaScript module.
import { AUTO } from "../src/renderer/lib/routineModel";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// @ts-expect-error The routine inspector is a JavaScript component.
import { StepInspector } from "../src/renderer/components/RoutineInspector";
// @ts-expect-error The routine run sheet is a JavaScript component.
import { RoutinePanel, addMenuSteps } from "../src/renderer/components/RoutinePanel";

describe("authoritative routine conditions", () => {
  it("offers only linked generated conditions and starts decisions blank", () => {
    const conditions = AUTO.authoritativeConditions({
      authoritative: true,
      generatedSchemaVersion: "1.1",
      conditions: [{ id: "robot.conditions#ready", label: "Ready", description: "Robot is ready." }],
    });

    expect(conditions).toEqual([{ value: "robot.conditions#ready", label: "Ready", meta: "Robot is ready." }]);
    expect(AUTO.newNode("decision").cond).toBe("");
    expect(AUTO.conditionPickerItems(conditions, "")).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: "" }),
      expect.objectContaining({ value: "robot.conditions#ready" }),
    ]));
  });

  it("keeps an unavailable saved condition visible, invalid, and replaceable", () => {
    const items = AUTO.conditionPickerItems([], "legacy.ready");

    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: "", label: "Choose a registered condition" }),
      expect.objectContaining({ value: "legacy.ready", badge: "invalid" }),
    ]));
    expect(AUTO.authoritativeConditions({ authoritative: true, generatedSchemaVersion: "1.0", conditions: [{ id: "legacy.ready" }] })).toEqual([]);
  });

  it("keeps saved condition routes without offering new condition decisions or pickers", () => {
    const catalog = { authoritative: true, generatedSchemaVersion: "1.2", commands: [], conditions: [{ id: "robot.conditions#ready", label: "Ready" }] };
    expect(addMenuSteps({ nodes: [] }, { list: { kind: "root" } }, catalog).map((item: { kind: string }) => item.kind)).not.toContain("decision");
    const render = (cond: string) => {
      const node = { ...AUTO.newNode("decision"), id: "branch", cond };
      const routine = { id: "r", name: "R", nodes: [node] };
      const inspector = renderToStaticMarkup(createElement(StepInspector, { node, routine, paths: [], acq: { outcomes: {} }, run: { segs: [] }, robotProject: { catalog } }));
      const run = AUTO.buildRun(routine, [], {}, {}, "profiledSpline", catalog);
      const panel = renderToStaticMarkup(createElement(RoutinePanel, { routine, run, paths: [], time: 0, running: false, acq: { outcomes: {} }, catalog, issues: AUTO.analyze(routine, [], catalog) }));
      return { inspector, panel };
    };
    const blank = render("");
    expect(blank.inspector).not.toContain('id="routine-condition"');
    expect(blank.inspector).toContain("Saved condition branch");
    expect(blank.inspector).toContain("Use command outputs for new decisions");
    expect(blank.panel).toContain("Branch on condition");
    const chosen = render("robot.conditions#ready");
    expect(chosen.inspector).toContain("robot.conditions#ready");
    expect(chosen.panel).toContain("Branch on Ready");
    // A saved ID the catalog no longer lists is shown and flagged, not erased.
    const lost = render("robot.conditions#gone");
    expect(lost.inspector).toContain("robot.conditions#gone");
    expect(lost.panel).toContain("The saved condition is unavailable in the linked catalog.");
    // No free-form condition ID field exists.
    expect(chosen.inspector).not.toMatch(/<input[^>]*aria-label="[^"]*condition/i);
  });
});
