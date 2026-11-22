import { beforeEach, describe, expect, it, vi } from "vitest";
import { analyzePath } from "../src/core/agent/pathAnalysis";
import { generateRepairCandidates } from "../src/core/agent/pathRepair";
import type { PathAnalysis, PathAnalysisFinding } from "../src/core/agent/types";
import { buildWaypoints, createDemoProject } from "../src/core/project/defaults";

vi.mock("../src/core/agent/pathAnalysis", () => ({ analyzePath: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

describe("agent repair grading", () => {
  it.each([
    { name: "unchanged height", id: "geometry:trench-height:blue:0", before: 0.7, after: 0.7, limit: 0.565, valid: false },
    { name: "worse height", id: "geometry:trench-height:blue:0", before: 0.7, after: 0.8, limit: 0.565, valid: false },
    { name: "improved height", id: "geometry:trench-height:blue:0", before: 0.7, after: 0.65, limit: 0.565, valid: true },
    { name: "clearance reaching zero", id: "geometry:field-obstacle-clearance", before: -0.1, after: 0, limit: 0.1, valid: true },
    { name: "clearance worsening from zero", id: "geometry:field-obstacle-clearance", before: 0, after: -0.1, limit: 0.1, valid: false },
    { name: "insufficient clearance improvement", id: "geometry:field-obstacle-clearance", before: -0.1, after: -0.09, limit: 0.1, valid: false },
  ])("correctly grades $name", ({ id, before, after, limit, valid }) => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.waypoints = buildWaypoints([{ x: 1, y: 2 }, { x: 2, y: 2 }, { x: 3, y: 2 }]);
    const finding: PathAnalysisFinding = {
      id, kind: "geometry", severity: "error", measured: before, limit,
      message: "Geometry violation", sourcePath: "field",
      sample: { index: 1, timeS: 1, distanceM: 1, fraction: 0.5, x: 2, y: 2, physicalHeadingRad: 0, segmentIndex: 0, nearestWaypointIndex: 1 },
    };
    const analysis: PathAnalysis = {
      pathId: path.id, pathName: path.name, authoredPath: path, planner: project.plannerId,
      totalTimeS: 2, totalDistanceM: 2, sampleCount: 3, samplesTruncated: false,
      rawSamples: [], extrema: [], findings: [finding], plannerDiagnostics: [],
    };
    vi.mocked(analyzePath).mockReturnValue({ ...analysis, findings: [{ ...finding, measured: after }] }).mockReturnValueOnce(analysis);

    const candidates = generateRepairCandidates(project, path.id, [id]);

    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) => candidate.valid === valid)).toBe(true);
  });
});
