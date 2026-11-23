import { expect, it } from "vitest";
import { buildWaypoints, createDemoProject } from "../src/core/project/defaults";
import { profiledSplinePlanner } from "../src/core/planners/profiledSpline";
import { validateProject } from "../src/core/validation";

const benchmark = process.env.BENCHMARK_CONSTRAINT_RANGES === "1" ? it : it.skip;

benchmark("profiles a valid 1,600-waypoint/1,600-range document", () => {
  const project = createDemoProject();
  const count = 1_600;
  const path = project.paths[0];
  path.headingMode = "tangent";
  path.waypoints = buildWaypoints(Array.from({ length: count }, (_, index) => ({
    x: 0.7 + index / (count - 1) * 16,
    y: 4,
    theta: 0,
    segType: "line" as const,
  })));
  path.ranges = Array.from({ length: count }, (_, index) => ({
    anchor: "param" as const,
    f0: index / count,
    f1: (index + 1) / count,
    maxVel: 1 + index % 4,
    maxAccel: 1 + index % 5,
    maxDecel: 1 + index % 6,
    maxAngVel: 90 + index % 30,
    maxAngAccel: 180 + index % 60,
    rotationPriority: index % 3 === 0 ? "translation" as const : "heading" as const,
  }));
  expect(validateProject(project).ok).toBe(true);

  const durations: number[] = [];
  let sampleCount = 0;
  for (let run = 0; run < 6; run += 1) {
    const started = performance.now();
    sampleCount = profiledSplinePlanner.generate({ path, robot: project.robot }).samples.length;
    if (run > 0) durations.push(performance.now() - started);
  }
  const median = durations.sort((a, b) => a - b)[Math.floor(durations.length / 2)];

  expect(sampleCount).toBe((count - 1) * 56 + 1);
  console.log(`dense constraint range benchmark median: ${median.toFixed(1)} ms`);
});
