import { describe, expect, it, vi } from "vitest";
import { AUTO } from "../src/renderer/lib/routineModel";
import { PM } from "../src/renderer/lib/pathMath";
import { createDemoProject } from "../src/core/project/defaults";
import { normalizeProject } from "../src/core/project/normalize";
import { validateProject } from "../src/core/validation";

describe("renderer routine model", () => {
  it("derives each referenced path once per routine run", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    const nodes = Array.from({ length: 20 }, (_, index) => ({ id: `p_${index}`, type: "path", ref: path.id }));
    const derivePath = vi.spyOn(PM, "derivePath");

    try {
      const run = AUTO.buildRun({ id: "routine", name: "Repeated path", nodes }, project.paths, project.robot, {}, project.plannerId);

      expect(run.segs).toHaveLength(nodes.length);
      expect(derivePath).toHaveBeenCalledTimes(1);
    } finally {
      derivePath.mockRestore();
    }
  });

  it("creates collision-safe IDs after loading legacy routine nodes", () => {
    const project = createDemoProject();
    const pathId = project.paths[0].id;
    const legacyNodes = [
      { id: "p_1", type: "path", ref: pathId },
      { id: "d_2", type: "decision", cond: "robot.ready", thenLabel: "Yes", elseLabel: "No", then: [], else: [] },
      { id: "c_3", type: "function", cat: "command", title: "Legacy command", invocation: null },
      { id: "g_4", type: "function", cat: "generate", funcRef: "GeneratePath", trigger: "On entry" },
      { id: "s_5", type: "function", cat: "sequence", op: "skip", trigger: "When condition is true" },
      { id: "v_6", type: "function", cat: "velocity", title: "Legacy velocity", trigger: "When condition is true", scale: 0.5 },
      { id: "f_7", type: "function", cat: "terminate", title: "Legacy terminate", trigger: "When condition is true" },
    ];
    project.routines[0].nodes = legacyNodes;
    const loaded = normalizeProject(structuredClone(project));
    const routine = loaded.routines[0];
    const created = [
      AUTO.newNode("path", null, pathId),
      AUTO.newNode("decision", null, pathId),
      AUTO.newNode("function", "command", pathId),
      AUTO.newNode("function", "generate", pathId),
      AUTO.newNode("function", "sequence", pathId),
      AUTO.newNode("function", "velocity", pathId),
      AUTO.newNode("function", "terminate", pathId),
    ];
    const withCreated = { ...routine, nodes: [...routine.nodes, ...created] };
    const createdIds = created.map((node) => node.id);
    const legacyIds = new Set(legacyNodes.map((node) => node.id));

    expect(createdIds.every((id) => !legacyIds.has(id))).toBe(true);
    expect(new Set(createdIds).size).toBe(createdIds.length);
    expect(validateProject({ ...loaded, routines: [withCreated] })).toEqual({ ok: true, issues: [] });

    const command = created[2];
    const updated = AUTO.update(withCreated, command.id, { title: "Updated command" });
    expect(AUTO.findNode(updated, "c_3").title).toBe("Legacy command");
    expect(AUTO.findNode(updated, command.id).title).toBe("Updated command");

    const removed = AUTO.remove(updated, command.id);
    expect(AUTO.findNode(removed, "c_3")).not.toBeNull();
    expect(AUTO.findNode(removed, command.id)).toBeNull();
    expect(validateProject({ ...loaded, routines: [removed] })).toEqual({ ok: true, issues: [] });
  });

  it("reuses an injected path derivation for repeated routine references", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    const routine = {
      ...project.routines[0],
      nodes: [
        { id: "first", type: "path", ref: path.id },
        { id: "second", type: "path", ref: path.id },
      ],
    };
    let calls = 0;
    const derive = () => {
      calls += 1;
      return {
        sample: { pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }], length: 1 },
        prof: { totalTime: 2, t: [0, 2], v: [0.5, 0.5], head: [0, 0] },
      };
    };

    const run = AUTO.buildRun(routine, project.paths, project.robot, {}, project.plannerId, derive);
    expect(calls).toBe(1);
    expect(run).toMatchObject({ total: 4, segs: [{ nodeId: "first" }, { nodeId: "second" }] });
  });
});
