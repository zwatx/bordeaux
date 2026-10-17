// @ts-expect-error The renderer math module is intentionally JavaScript.
import { PM } from "../src/renderer/lib/pathMath";
import { describe, expect, it } from "vitest";
import { createUnitPreferences, formatAngularLimit } from "../src/renderer/lib/unitPreferences";
import { wheelZoomFactor } from "../src/renderer/lib/zoom";
import { loadRendererExport } from "./helpers/loadRendererExport";
import { PathEdit } from "../src/renderer/assets/path-edit";

interface PointerEventLike { pointerId: number; clientX?: number; clientY?: number }
type PointerListener = (event: PointerEventLike) => void;

function unitPreferences(stored?: string) {
  const values = new Map<string, string>();
  if (stored !== undefined) values.set("bordeaux.unitSystem", stored);
  const document = { documentElement: { dataset: {} as Record<string, string> } };
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  return { prefs: createUnitPreferences(localStorage, document.documentElement), document, values };
}

function pointerDragHarness() {
  const listeners = new Map<string, PointerListener>();
  const captureListeners: string[] = [];
  let frame: FrameRequestCallback | null = null;
  const window = {
    addEventListener: (type: string, listener: PointerListener) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  } as Record<string, unknown>;
  const target = {
    setPointerCapture: () => undefined,
    hasPointerCapture: () => false,
    addEventListener: (type: string) => captureListeners.push(type),
    removeEventListener: () => undefined,
  };
  const document = { body: { style: { cursor: "" } } };
  const pointerDrag = loadRendererExport<{
    begin(
      event: PointerEventLike & { currentTarget: typeof target },
      handlers: { move: PointerListener; end?: PointerListener; cancel?: PointerListener; coalesce?: boolean },
    ): (options?: { flush?: boolean }) => void;
  }>(new URL("../src/renderer/hooks/usePointerDrag.js", import.meta.url), "PointerDrag", {
    context: {
      document,
      React: {},
      requestAnimationFrame: (callback: FrameRequestCallback) => { frame = callback; return 1; },
      cancelAnimationFrame: () => { frame = null; },
    },
    window,
  });
  return {
    pointerDrag,
    target,
    captureListeners,
    dispatch: (type: string, event: PointerEventLike) => listeners.get(type)?.(event),
    flushFrame: () => { const pending = frame; frame = null; pending?.(0); },
  };
}

describe("renderer utilities", () => {
  it.each([
    [720, "720"], [540, "540"], [123.4, "123"], [99.96, "100"], [45, "45"], [12.34, "12.3"],
    [5, "5"], [0.6, "0.6"], [0.01, "0.01"], [0.0149, "0.01"], [0.005, "0.01"],
    [0.004, "0.004"], [0.0012345, "0.0012"], [1e-7, "1e-7"], [Number.MIN_VALUE, "5e-324"], [0, "0"],
  ] as const)("displays angular limit %s without hiding positive values", (value, text) => {
    expect(formatAngularLimit(value)).toBe(text);
    if (value > 0) expect(Number(formatAngularLimit(value))).toBeGreaterThan(0);
  });

  it.each(["metric", "imperial"])("uses the same truthful angular caption and accessible limit in %s", (system) => {
    const { prefs } = unitPreferences(system);
    const ui = loadRendererExport<{ constraintRangeSummary: (range: unknown, constraints: unknown, robot: unknown) => unknown }>(
      new URL("../src/renderer/components/ui.jsx", import.meta.url), "UI", {
        context: { React: { createElement: () => null }, createPortal: () => null, PointerDrag: {},
          PM: { effectiveConstraints: (constraints: unknown) => constraints }, UnitPrefs: prefs, formatAngularLimit },
      });
    const limits = { maxVel: 4, maxAccel: 3, maxAngVel: 540, maxAngAccel: 720 };
    expect(ui.constraintRangeSummary({ maxAngVel: 0.01, maxAngAccel: 0.01 }, limits, { maxSpeed: 4 })).toEqual({
      key: "maxAngAccel", text: "α ≤ 0.01°/s²", ariaLabel: "maximum angular acceleration 0.01 degrees per second squared",
    });
    expect(ui.constraintRangeSummary({ maxAngVel: 0.004 }, limits, { maxSpeed: 4 })).toEqual({
      key: "maxAngVel", text: "ω ≤ 0.004°/s", ariaLabel: "maximum angular velocity 0.004 degrees per second",
    });
    expect(ui.constraintRangeSummary({ maxAngVel: 270 }, limits, { maxSpeed: 4 })).toEqual({
      key: "maxAngVel", text: "ω ≤ 270°/s", ariaLabel: "maximum angular velocity 270 degrees per second",
    });
  });

  it("normalizes large finite headings without iterative subtraction", () => {
    const pathMath = PM;
    expect(pathMath.angWrap(1e12)).toBeGreaterThanOrEqual(-Math.PI);
    expect(pathMath.angWrap(1e12)).toBeLessThanOrEqual(Math.PI);
  });

  it("converts display units without changing canonical SI values", () => {
    const { prefs, document, values } = unitPreferences();
    expect(prefs.current()).toBe("metric");
    expect(prefs.fromCanonical(1, "m")).toBe(1);

    prefs.set("imperial");
    expect(document.documentElement.dataset.units).toBe("imperial");
    expect(values.get("bordeaux.unitSystem")).toBe("imperial");
    expect(prefs.fromCanonical(1, "m")).toBeCloseTo(3.280839895, 9);
    expect(prefs.toCanonical(prefs.fromCanonical(2.4, "m/s"), "m/s")).toBeCloseTo(2.4, 12);
    expect(prefs.fromCanonical(1, "m", "in")).toBeCloseTo(39.37007874, 8);
    expect(prefs.label("kg·m²")).toBe("lb·ft²");
  });

  it("falls back to metric for an invalid stored unit preference", () => {
    expect(unitPreferences("yards").prefs.current()).toBe("metric");
  });

  it("normalizes and bounds wheel zoom across input devices", () => {
    const down = wheelZoomFactor(120, 0, 800);
    const up = wheelZoomFactor(-120, 0, 800);
    expect(down).toBeLessThanOrEqual(1.08);
    expect(down * up).toBeCloseTo(1, 12);
    expect(wheelZoomFactor(10, 0, 800)).toBeCloseTo(Math.pow(wheelZoomFactor(1, 0, 800), 10), 12);
    expect(wheelZoomFactor(10_000, 0, 800)).toBeCloseTo(down, 12);
    expect(wheelZoomFactor(3, 1, 800)).toBeGreaterThan(wheelZoomFactor(3, 0, 800));
  });

  it("flushes the final coalesced move before a fast drag commits", () => {
    const harness = pointerDragHarness();
    const edit = PathEdit.create<{ id: string; x: number }>();
    const committed: Array<{ x: number }> = [];
    const snapshots: Array<{ x: number } | null> = [];
    const canceled: number[] = [];
    edit.subscribe(() => snapshots.push(edit.getSnapshot()));
    harness.pointerDrag.begin({ currentTarget: harness.target, pointerId: 7 }, {
      coalesce: true,
      move: (event) => {
        if (event.clientX === undefined) return;
        if (!edit.getSnapshot()) edit.begin({ id: "draft", x: 0 });
        edit.update({ id: "draft", x: event.clientX });
      },
      end: () => { const value = edit.finish(); if (value) committed.push(value); },
      cancel: (event) => canceled.push(event.pointerId),
    });

    harness.dispatch("pointermove", { pointerId: 7, clientX: 20 });
    harness.dispatch("pointermove", { pointerId: 7, clientX: 80 });
    harness.dispatch("pointerup", { pointerId: 7, clientX: 80 });
    harness.flushFrame();

    expect(committed).toEqual([{ id: "draft", x: 80 }]);
    expect(snapshots).toEqual([{ id: "draft", x: 80 }, null]);
    expect(canceled).toEqual([]);
    expect(harness.captureListeners).not.toContain("lostpointercapture");
  });

  it("commits the pointer-up position and can discard a queued move", () => {
    const released = pointerDragHarness();
    const moves: number[] = [];
    released.pointerDrag.begin({ currentTarget: released.target, pointerId: 3, clientX: 0, clientY: 0 }, {
      coalesce: true,
      move: (event) => { if (event.clientX !== undefined) moves.push(event.clientX); },
    });
    released.dispatch("pointermove", { pointerId: 3, clientX: 40, clientY: 0 });
    released.dispatch("pointerup", { pointerId: 3, clientX: 75, clientY: 0 });
    expect(moves).toEqual([40, 75]);

    const canceled = pointerDragHarness();
    const canceledMoves: number[] = [];
    const stop = canceled.pointerDrag.begin({ currentTarget: canceled.target, pointerId: 4, clientX: 0, clientY: 0 }, {
      coalesce: true,
      move: (event) => { if (event.clientX !== undefined) canceledMoves.push(event.clientX); },
    });
    canceled.dispatch("pointermove", { pointerId: 4, clientX: 90, clientY: 0 });
    stop({ flush: false });
    canceled.flushFrame();
    expect(canceledMoves).toEqual([]);
  });

  it("materializes an active path edit for persistence", () => {
    const edit = PathEdit.create<{ id: string; x: number }>();
    const project = { name: "demo", paths: [{ id: "a", x: 1 }, { id: "b", x: 2 }] };
    edit.begin(project.paths[0]);
    edit.update({ id: "a", x: 9 });

    const persisted = edit.materialize(project);
    expect(persisted).not.toBe(project);
    expect(persisted.paths).toEqual([{ id: "a", x: 9 }, { id: "b", x: 2 }]);
    expect(project.paths[0].x).toBe(1);
  });
});
