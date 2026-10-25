import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlaybackStore } from "../src/renderer/lib/playbackStore";

function playback() {
  let next = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, "now").mockReturnValue(0);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  return {
    store: createPlaybackStore(), frames,
    tick(now: number) { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(now)); },
  };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("editor playback store", () => {
  it('keeps elapsed time and one animation frame when an edited plan arrives; never resumes a manual pause', () => {
    const { store, frames, tick } = playback();
    store.setTotal(5); store.toggle(); tick(1000);
    store.setTotal(7); tick(1500);
    expect(store.getSnapshot()).toEqual({ time: 1.5, total: 7, playing: true });
    expect(frames.size).toBe(1);
    store.pause(); store.setTotal(6);
    expect(store.getSnapshot()).toEqual({ time: 1.5, total: 6, playing: false });
    expect(frames.size).toBe(0);
  });
  it("advances one frame at a time, stops at the duration, and restarts from the beginning", () => {
    const { store, frames, tick } = playback();
    store.setTotal(2); store.toggle();
    expect(frames.size).toBe(1);
    tick(750);
    expect(store.getSnapshot()).toEqual({ time: 0.75, total: 2, playing: true });
    tick(2500);
    expect(store.getSnapshot()).toEqual({ time: 2, total: 2, playing: false });
    expect(frames.size).toBe(0);
    store.toggle();
    expect(store.getSnapshot().time).toBe(0);
    expect(frames.size).toBe(1);
  });

  it("pauses, bounds seeks, and cancels owned frames when destroyed", () => {
    const { store, frames, tick } = playback();
    const listener = vi.fn();
    store.subscribe(listener); store.setTotal(4); store.restart(); tick(1000);
    store.pause();
    expect(store.getSnapshot().time).toBe(1);
    expect(frames.size).toBe(0);
    store.seek(100);
    expect(store.getSnapshot()).toEqual({ time: 4, total: 4, playing: false });
    store.seek(-1);
    expect(store.getSnapshot().time).toBe(0);
    store.restart(); store.destroy(); listener.mockClear(); tick(2000);
    expect(frames.size).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it("leaves zero-duration paths stopped and retains stable snapshots between updates", () => {
    const { store, frames } = playback();
    const initial = store.getSnapshot();
    expect(store.getSnapshot()).toBe(initial);
    store.toggle();
    expect(store.getSnapshot().playing).toBe(false);
    expect(frames.size).toBe(0);
    store.setTotal(3); store.seek(2); store.setTotal(1);
    expect(store.getSnapshot()).toEqual({ time: 1, total: 1, playing: false });
  });
});
