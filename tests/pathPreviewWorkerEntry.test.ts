import { afterEach, describe, expect, it, vi } from "vitest";
import { buildWaypoints, createDemoProject } from "../src/shared/project/defaults";

afterEach(() => vi.unstubAllGlobals());

describe("production planning worker entry", () => {
  it("dispatches explicit route searches through its installed message handler", async () => {
    const worker = { onmessage: null as null | ((event: { data: unknown }) => void), postMessage: vi.fn() };
    vi.stubGlobal("self", worker);
    vi.resetModules();
    // @ts-expect-error The production worker is an intentional JavaScript module.
    await import("../src/renderer/assets/path-preview-worker");
    const project = createDemoProject();
    project.paths[0].waypoints = buildWaypoints([{ x: 6.5, y: 2 }, { x: 10, y: 2 }]);
    expect(worker.onmessage).toBeTypeOf("function");
    worker.onmessage!({ data: { id: 37, quality: "final", optimize: true, path: project.paths[0], robot: project.robot,
      field: project.field, perSegment: 56, deadline: "common", deadlineMs: 1 } });
    expect(worker.postMessage).toHaveBeenCalledOnce();
    expect(worker.postMessage.mock.calls[0][0]).toMatchObject({ id: 37, quality: "final",
      value: { routeSearch: { status: "no-candidate", termination: "time-budget", seedStatus: "unknown" } } });
  });
});
