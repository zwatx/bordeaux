import { describe, expect, it, vi } from "vitest";
import { buildWaypoints, createDemoProject } from "../src/core/project/defaults";
import { getPlanner } from "../src/core/planners";
import { optimizedTrajectoryPlanner } from "../src/core/planners/optimizedTrajectory";
import { rememberByInput, rememberByKey } from "../src/core/planners/rememberByInput";
import type { PathDoc } from "../src/core/types";

function fixture() {
  const project = createDemoProject();
  const path = project.paths[0];
  path.waypoints = buildWaypoints([{ x: 6.5, y: 2 }, { x: 10, y: 2 }]);
  path.markers = [{ id: "event", name: "Score", f: 0.5, invocation: { commandId: "shoot", arguments: { speed: 3 } } }];
  return { path, robot: project.robot };
}

describe("remembered planner results", () => {
  it("reuses one solve for repeated plans and hands each caller its own copy", () => {
    const { path, robot } = fixture();
    const solve = vi.spyOn(optimizedTrajectoryPlanner, "generate");
    try {
      const first = getPlanner("optimizedTrajectory").generate({ path, robot });
      const calls = solve.mock.calls.length;
      expect(calls).toBeGreaterThan(0);
      first.samples[0].velocityMps = 99;
      first.markers[0].invocation!.commandId = "changed";
      const second = getPlanner("optimizedTrajectory").generate({ path: structuredClone(path), robot: structuredClone(robot) });
      expect(solve.mock.calls.length).toBe(calls);
      expect(second).not.toBe(first);
      expect(second.samples[0].velocityMps).not.toBe(99);
      expect(second.markers[0].invocation!.commandId).toBe("shoot");
    } finally {
      solve.mockRestore();
    }
  });

  it("keeps a remembered result when the caller later changes its input in place", () => {
    for (const id of ["optimizedTrajectory", "profiledSpline"] as const) {
      const { path, robot } = fixture();
      const original: PathDoc = structuredClone(path);
      expect(getPlanner(id).generate({ path, robot }).markers[0].invocation!.commandId).toBe("shoot");
      path.markers[0].invocation!.commandId = "intake";
      path.markers[0].invocation!.arguments.speed = 1;
      const replanned = getPlanner(id).generate({ path: original, robot });
      expect(replanned.markers[0].invocation).toEqual({ commandId: "shoot", arguments: { speed: 3 } });
    }
  });

  it("forgets the least recently used result past its capacity", () => {
    const compute = vi.fn((key: string) => ({ key }));
    const remember = rememberByKey<{ key: string }>(2);
    const a = remember("a", () => compute("a"));
    remember("b", () => compute("b"));
    expect(remember("a", () => compute("a"))).toBe(a);
    remember("c", () => compute("c"));
    expect(compute).toHaveBeenCalledTimes(3);
    expect(remember("a", () => compute("a"))).toBe(a);
    remember("b", () => compute("b"));
    expect(compute).toHaveBeenCalledTimes(4);
  });

  it("computes from a private copy of the input", () => {
    const { path, robot } = fixture();
    const original = structuredClone(path);
    const plan = rememberByInput(2, (input) => ({ markers: input.path.markers }));
    const first = plan({ path, robot });
    path.markers[0].invocation!.commandId = "intake";
    expect(first.markers[0].invocation!.commandId).toBe("shoot");
    expect(plan({ path: original, robot }).markers[0].invocation!.commandId).toBe("shoot");
  });
});
