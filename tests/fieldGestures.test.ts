import { describe, expect, it } from "vitest";
import { createFieldScrollPreference, fieldWheelAction, fieldZoomLimits, pinchView, pinchZoomFactor, wheelZoomFactor, zoomViewAbout } from "../src/renderer/lib/zoom";
import { pickTouchHandle } from "../src/renderer/lib/fieldTouch";

const limits = fieldZoomLimits(1000);
const view = { x: 100, y: 50, w: 800, h: 400 };

describe("field wheel gestures", () => {
  it("zooms a pinch at the fingers' own scale", () => {
    // Chromium sends a pinch to scale s as a Ctrl+wheel with deltaY = -100·ln(s).
    const action = fieldWheelAction({ deltaX: 0, deltaY: -100 * Math.log(1.2), deltaMode: 0, ctrlKey: true }, "pan", 800);
    expect(action).toEqual({ kind: "zoom", factor: expect.any(Number) });
    expect(1 / (action as { factor: number }).factor).toBeCloseTo(1.2, 9);
    expect(pinchZoomFactor(1000, 0, 800)).toBeCloseTo(Math.exp(0.25), 12);
  });

  it("pans on plain scrolling by preference and zooms on Ctrl or ⌘ either way", () => {
    expect(fieldWheelAction({ deltaX: 3, deltaY: -7, deltaMode: 0 }, "pan", 800)).toEqual({ kind: "pan", dx: 3, dy: -7 });
    expect(fieldWheelAction({ deltaX: 0, deltaY: 2, deltaMode: 1 }, "pan", 800)).toEqual({ kind: "pan", dx: 0, dy: 32 });
    expect(fieldWheelAction({ deltaX: 0, deltaY: 120, deltaMode: 0 }, "zoom", 800).kind).toBe("zoom");
    expect(fieldWheelAction({ deltaX: 0, deltaY: 4, deltaMode: 0, metaKey: true }, "pan", 800).kind).toBe("zoom");
  });

  it("zooms ⌘+scroll and Ctrl+wheel notches at the wheel rate, not the pinch rate", () => {
    const factor = (input: Parameters<typeof fieldWheelAction>[0]) => (fieldWheelAction(input, "pan", 800) as { factor: number }).factor;
    expect(factor({ deltaX: 0, deltaY: 30, deltaMode: 0, metaKey: true })).toBeCloseTo(wheelZoomFactor(30, 0, 800), 12);
    expect(factor({ deltaX: 0, deltaY: 100, deltaMode: 0, ctrlKey: true })).toBeCloseTo(wheelZoomFactor(100, 0, 800), 12);
    expect(factor({ deltaX: 0, deltaY: 3, deltaMode: 1, ctrlKey: true })).toBeCloseTo(wheelZoomFactor(3, 1, 800), 12);
    expect(factor({ deltaX: 0, deltaY: 18.23, deltaMode: 0, ctrlKey: true })).toBeCloseTo(Math.exp(0.1823), 12);
  });

  it("keeps the anchor fixed, the aspect, and the zoom limits", () => {
    const anchor = { x: 300, y: 150 };
    const zoomed = zoomViewAbout(view, anchor, 0.5, limits);
    expect(zoomed).toEqual({ x: 200, y: 100, w: 400, h: 200 });
    expect((anchor.x - zoomed.x) / zoomed.w).toBeCloseTo((anchor.x - view.x) / view.w, 12);
    expect(zoomViewAbout(view, anchor, 0.001, limits).w).toBe(limits.min);
    expect(zoomViewAbout(view, anchor, 100, limits).w).toBe(limits.max);
  });
});

describe("two-finger pinch", () => {
  const start = { view, center: { x: 500, y: 300 }, spread: 200, anchor: { x: 400, y: 250 }, pixelsPerUnit: 2 };

  it("starts where it began and follows the midpoint and spread", () => {
    expect(pinchView(start, start.center, start.spread, limits)).toEqual(view);
    const panned = pinchView(start, { x: 520, y: 290 }, 200, limits);
    expect(panned).toEqual({ x: 90, y: 55, w: 800, h: 400 });
    const zoomed = pinchView(start, { x: 560, y: 300 }, 400, limits);
    // The field point first under the fingers is under their new midpoint.
    // Screen x of the view's left edge stays where it was; the anchor's screen x is that edge plus its scaled offset.
    const edge = start.center.x - (start.anchor.x - view.x) * start.pixelsPerUnit;
    const pixelsPerUnit = start.pixelsPerUnit * view.w / zoomed.w;
    expect(edge + (start.anchor.x - zoomed.x) * pixelsPerUnit).toBeCloseTo(560, 9);
    expect(zoomed.w).toBe(400);
  });
});

describe("touch handle reach", () => {
  const box = (role: string, left: number, top: number, size = 13) => ({ item: role + left, role, left, top, width: size, height: size });

  it("takes the nearest small handle within reach and ignores large hit areas", () => {
    const candidates = [box("wp", 100, 100), box("ct", 130, 100, 10), box("rt", 0, 0, 200), box("seg", 90, 90, 40)];
    expect(pickTouchHandle(candidates, 120, 106)?.item).toBe("wp100");
    expect(pickTouchHandle(candidates, 128, 106)?.item).toBe("ct130");
    expect(pickTouchHandle(candidates, 160, 160)).toBeNull();
    expect(pickTouchHandle([box("rt", 0, 0, 200)], 10, 10)).toBeNull();
  });

  it("prefers the nearer centre when the finger covers two handles", () => {
    expect(pickTouchHandle([box("wp", 100, 100), box("wp", 106, 100)], 115, 106)?.item).toBe("wp106");
  });
});

describe("field scrolling preference", () => {
  const memory = (initial: string | null) => {
    let value = initial;
    return { getItem: () => value, setItem: (_: string, next: string) => { value = next; }, read: () => value };
  };

  it("defaults by platform, restores a stored choice and notifies on change", () => {
    expect(createFieldScrollPreference(memory(null), "pan").current()).toBe("pan");
    expect(createFieldScrollPreference(memory("zoom"), "pan").current()).toBe("zoom");
    expect(createFieldScrollPreference(memory("sideways"), "zoom").current()).toBe("zoom");
    const storage = memory(null), prefs = createFieldScrollPreference(storage, "pan");
    let calls = 0;
    prefs.subscribe(() => { calls += 1; });
    prefs.set("zoom"); prefs.set("zoom");
    expect([prefs.current(), storage.read(), calls]).toEqual(["zoom", "zoom", 1]);
  });
});
