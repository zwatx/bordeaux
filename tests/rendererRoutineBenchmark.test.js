import { expect, it } from "vitest";
import { AUTO } from "../src/renderer/lib/routineModel";
import { buildWaypoints, createDemoProject } from "../src/core/project/defaults";
import { validateProject } from "../src/core/validation";

const benchmark = process.env.BENCHMARK_ROUTINE_PREVIEW === "1" ? it : it.skip;

function fixture(referenceCount) {
  const project = createDemoProject();
  const path = project.paths[0];
  const waypointCount = 100;
  path.headingMode = "tangent";
  path.waypoints = buildWaypoints(Array.from({ length: waypointCount }, (_, index) => {
    const progress = index / (waypointCount - 1);
    return {
      x: 0.7 + progress * 16,
      y: 4 + Math.sin(progress * Math.PI * 4) * 2.2,
      theta: 0,
    };
  }));
  const routine = project.routines[0];
  routine.nodes = Array.from({ length: referenceCount }, (_, index) => ({
    id: `path_${index}`,
    type: "path",
    ref: path.id,
  }));
  expect(validateProject(project).ok).toBe(true);
  return { project, routine };
}

benchmark("builds repeated path references without repeated derivation", () => {
  const runs = Number.parseInt(process.env.BENCHMARK_ROUTINE_RUNS || "3", 10);
  for (const referenceCount of [1, 10, 100]) {
    const { project, routine } = fixture(referenceCount);
    const samples = [];
    let segmentCount = 0;
    for (let run = 0; run < runs + 1; run += 1) {
      const started = performance.now();
      segmentCount = AUTO.buildRun(routine, project.paths, project.robot, {}, project.plannerId).segs.length;
      if (run > 0) samples.push(performance.now() - started);
    }
    const ordered = samples.slice().sort((left, right) => left - right);
    const medianMs = ordered[Math.floor(ordered.length / 2)];
    expect(segmentCount).toBe(referenceCount);
    console.log(JSON.stringify({ benchmark: "routine-repeated-path", referenceCount, samplesMs: samples, medianMs }));
  }
});
