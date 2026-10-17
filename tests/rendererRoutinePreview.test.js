import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTO } from "../src/renderer/lib/routineModel";
import { createDemoProject } from "../src/shared/project/defaults";

const hooks = vi.hoisted(() => ({ values: [], cursor: 0, effects: [] }));
const planning = vi.hoisted(() => ({ request: null }));
vi.mock("react", async (original) => ({
  ...await original(),
  useState(initial) {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.values[index], (value) => { hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value; }];
  },
  useRef(initial) {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = { current: initial };
    return hooks.values[index];
  },
  useMemo(factory, dependencies) {
    const index = hooks.cursor++;
    const previous = hooks.values[index];
    if (!previous || dependencies.some((value, item) => value !== previous.dependencies[item])) hooks.values[index] = { value: factory(), dependencies };
    return hooks.values[index].value;
  },
  useEffect(effect, dependencies) {
    const index = hooks.cursor++;
    const previous = hooks.values[index];
    if (previous && dependencies.every((value, item) => value === previous.dependencies[item])) return;
    hooks.values[index] = { dependencies, cleanup: previous?.cleanup };
    hooks.effects.push(() => {
      previous?.cleanup?.();
      hooks.values[index].cleanup = effect();
    });
  },
}));
vi.mock("../src/renderer/assets/final-planning", () => ({
  FinalPlanning: { create: () => ({ request: (...args) => planning.request(...args) }) },
}));
import { useRoutinePlanning } from "../src/renderer/hooks/useRoutinePlanning";

function render(...args) {
  hooks.cursor = 0;
  const plans = useRoutinePlanning(...args);
  hooks.effects.splice(0).forEach((run) => run());
  return plans;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  hooks.values = [];
  hooks.effects = [];
  planning.request = vi.fn(({ path }) => ({
    promise: Promise.resolve({ status: "success", value: { pathId: path.id, prof: { totalTime: 2 }, finalTrajectory: { samples: [] } } }),
    cancel: vi.fn(),
  }));
});

function routineFor(path) {
  return { id: "routine", name: "Routine", nodes: [{ id: "drive", type: "path", ref: path.id }] };
}

describe("routine planning", () => {
  it("plans every referenced path across branches once", () => {
    const [a, b, c, unused] = ["A", "B", "C", "D"].map((id) => ({ id }));
    const routine = { nodes: [
      { id: "decision", type: "decision", then: [{ id: "a", type: "path", ref: "A" }], else: [{ id: "b", type: "path", ref: "B" }, { id: "a-again", type: "path", ref: "A" }] },
      { id: "command", type: "function", cat: "command", outputBranch: { routes: [{ id: "route", nodes: [{ id: "c", type: "path", ref: "C" }] }] } },
      { id: "deleted", type: "path", ref: "missing" },
    ] };

    const paths = AUTO.planningPaths(routine, [unused, c, b, a]);
    expect(paths).toHaveLength(3);
    expect(paths[0]).toBe(a);
    expect(paths[1]).toBe(b);
    expect(paths[2]).toBe(c);
  });

  it("plans repeat and unselected routes once and reports missing references before claiming ready", async () => {
    const project = createDemoProject(), first = project.paths[0], other = { ...first, id: "other", name: "Other" };
    const routine = { id: "routine", nodes: [{ id: "loop", type: "repeat", times: 50, nodes: [{ id: "branch", type: "decision", then: [{ id: "first", type: "path", ref: first.id }], else: [{ id: "other", type: "path", ref: other.id }, { id: "first-again", type: "path", ref: first.id }] }] }] };
    const paths = [first, other];
    render(true, routine, paths, project.robot, project.field, project.plannerId); await settle();
    expect(render(true, routine, paths, project.robot, project.field, project.plannerId).status).toBe("ready");
    expect(planning.request).toHaveBeenCalledTimes(2);
    expect(render(true, routine, [first], project.robot, project.field, project.plannerId)).toMatchObject({ status: "error", error: "1 path is missing from this routine.", missingPathIds: ["other"] });
  });

  it("keeps ready plans when a Wait edit leaves referenced paths unchanged", async () => {
    const project = createDemoProject();
    const path = project.paths[0];
    const routine = { id: "routine", name: "Routine", nodes: [
      { id: "drive", type: "path", ref: path.id },
      { id: "wait", type: "builtin", builtinId: "bordeaux.wait", arguments: { durationS: 1 } },
    ] };

    render(true, routine, project.paths, project.robot, project.field, "profiledSpline");
    await settle();
    expect(render(true, routine, project.paths, project.robot, project.field, "profiledSpline")).toMatchObject({ status: "ready", values: { [path.id]: { pathId: path.id } } });
    expect(planning.request).toHaveBeenCalledOnce();

    const edited = AUTO.update(routine, "wait", { arguments: { durationS: 2.5 } });
    expect(render(true, edited, project.paths, project.robot, project.field, "profiledSpline")).toMatchObject({ status: "ready" });
    await settle();
    expect(planning.request).toHaveBeenCalledOnce();

    const renamed = [{ ...path, name: "Renamed" }, ...project.paths.slice(1)];
    expect(render(true, edited, renamed, project.robot, project.field, "profiledSpline")).toMatchObject({ status: "pending" });
    await settle();
    expect(render(true, edited, renamed, project.robot, project.field, "profiledSpline")).toMatchObject({ status: "ready" });
    expect(planning.request).toHaveBeenCalledTimes(2);
    expect(planning.request).toHaveBeenLastCalledWith(expect.objectContaining({ path: renamed[0], field: project.field }), { deadline: "common", failureNote: "Routine preview is unavailable." });
  });

  it("replans for a new field and treats the prior field's plans as stale", async () => {
    const project = createDemoProject();
    const routine = routineFor(project.paths[0]);
    render(true, routine, project.paths, project.robot, project.field, "profiledSpline");
    await settle();

    const field = { ...project.field, revision: project.field.revision + "-next" };
    expect(render(true, routine, project.paths, project.robot, field, "profiledSpline")).toMatchObject({ status: "pending", values: {} });
    await settle();
    expect(render(true, routine, project.paths, project.robot, field, "profiledSpline")).toMatchObject({ status: "ready" });
    expect(planning.request).toHaveBeenLastCalledWith(expect.objectContaining({ field }), { deadline: "common", failureNote: "Routine preview is unavailable." });
  });

  it.each([
    ["an unvalidated current optimization", true, { status: "success", value: { prof: { totalTime: 2 }, finalTrajectory: {} } }, "The selected optimization could not be validated. Review this path."],
    ["a timeout", false, { status: "timeout", fallbackReason: "Final planning exceeded the common deadline (5000 ms)." }, "Final planning exceeded the common deadline (5000 ms)."],
    ["a worker failure", false, { status: "failure", error: { message: "worker crashed" } }, "worker crashed"],
    ["malformed output", false, { status: "success", value: { prof: { totalTime: 2 } } }, "Could not prepare this trajectory."],
  ])("blocks the routine on %s", async (_label, applied, result, message) => {
    const project = createDemoProject();
    const base = project.paths[0];
    const { optimizationInputKey } = await import("../src/shared/planners/acceptedTrajectoryIdentity");
    const path = applied
      ? { ...base, optimization: { corridorM: 0.15, accepted: { version: 1, inputKey: optimizationInputKey(base, project.robot, project.field), samplesPerSegment: 56, result: {} } } }
      : base;
    const paths = [path, ...project.paths.slice(1)];
    planning.request = vi.fn(() => ({ promise: Promise.resolve(result), cancel: vi.fn() }));

    render(true, routineFor(path), paths, project.robot, project.field, "profiledSpline");
    await settle();

    expect(render(true, routineFor(path), paths, project.robot, project.field, "profiledSpline")).toMatchObject({ status: "error", error: `${path.name}: ${message}` });
  });

  it("uses normal planning for an applied optimization made for older inputs", async () => {
    const project = createDemoProject();
    const path = { ...project.paths[0], optimization: { corridorM: 0.15, accepted: { version: 1, inputKey: "older inputs", samplesPerSegment: 56, result: {} } } };
    const paths = [path, ...project.paths.slice(1)];
    render(true, routineFor(path), paths, project.robot, project.field, "profiledSpline");
    await settle();

    expect(render(true, routineFor(path), paths, project.robot, project.field, "profiledSpline")).toMatchObject({ status: "ready", values: { [path.id]: { pathId: path.id } } });
  });

  it.each(["authored-first", "generated-first"])("keeps same-ID generated previews separate from authored paths (%s)", (order) => {
    const project = createDemoProject();
    const authored = project.paths[0];
    const generated = structuredClone(authored);
    generated.name = "Generated preview";
    generated.waypoints.forEach((waypoint) => { waypoint.y += 2; waypoint.prevC.y += 2; waypoint.nextC.y += 2; });
    const pathNode = { id: "authored", type: "path", ref: authored.id };
    const generateNode = { id: "generated", type: "function", cat: "generate", funcRef: "GeneratePath", preview: generated };
    const routine = { id: "routine", name: "Collision", nodes: order === "authored-first" ? [pathNode, generateNode] : [generateNode, pathNode] };

    const run = AUTO.buildRun(routine, project.paths, project.robot, {}, project.plannerId);

    expect(run.segs.find((segment) => segment.nodeId === pathNode.id)?.doc).toBe(authored);
    expect(run.segs.find((segment) => segment.nodeId === generateNode.id)?.doc).toBe(generated);
  });
});
