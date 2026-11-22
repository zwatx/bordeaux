import { describe, expect, it } from "vitest";
import { analyzePath, minimumPathClearance } from "../src/core/agent/pathAnalysis";
import { getPlanner } from "../src/core/planners";
import { createDemoProject, buildWaypoints } from "../src/core/project/defaults";
import { REBUILT_2026_CROSSINGS } from "../src/core/field/rebuilt2026";

describe("agent path analysis", () => {
  it("returns bounded raw samples, extrema, and source references from the shared planner", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    const analysis = analyzePath(project, path.id, { sampleLimit: 80 });
    expect(analysis.totalTimeS).toBeGreaterThan(0);
    expect(analysis.sampleCount).toBeGreaterThan(1);
    expect(analysis.rawSamples.length).toBeLessThanOrEqual(80);
    expect(analysis.extrema.map((item) => item.metric)).toContain("velocity");
    expect(analysis.extrema[0].sample.nearestWaypointIndex).toBeGreaterThanOrEqual(0);
  });

  it("checks the same minimum of authored and robot limits used by the planner", () => {
    const project = createDemoProject();
    project.plannerId = "profiledSpline";
    project.robot.driveModel = {
      motorId: "test",
      motorFreeRpm: 6000,
      motorMaxTorqueNm: 1,
      motorCount: 4,
      gearRatio: 10,
      wheelDiameterM: 0.1,
      massKg: 40,
      moiKgM2: 10,
      wheelbaseM: 0.6,
      trackwidthM: 0.8,
      wheelFrictionCoefficient: 0.5,
    };
    const path = project.paths[0];
    path.headingMode = "tangent";
    path.waypoints = buildWaypoints([{ x: 1, y: 2 }, { x: 7, y: 2 }]);
    path.constraints = { maxVel: 0.1, maxAccel: 0.1, maxDecel: 0.1, maxAngVel: 1, maxAngAccel: 1 };

    const analysis = analyzePath(project, path.id);

    expect(analysis.extrema.find((item) => item.metric === "velocity")!.value).toBeLessThanOrEqual(0.1001);
    expect(analysis.findings.filter((finding) => finding.kind === "constraint")).toEqual([]);
  });

  it("reports a measured robot-footprint collision without mutating the authored path", () => {
    const project = createDemoProject();
    const path = project.paths[0];
    path.waypoints = buildWaypoints([{ x: 3.5, y: 4 }, { x: 4.6, y: 4 }, { x: 6, y: 4 }]);
    const before = JSON.stringify(path);
    const plannerId = project.plannerId;
    const samples = getPlanner(plannerId).generate({ path: structuredClone(path), robot: structuredClone(project.robot) }).samples;
    const sampleClearances = samples.map((sample) => minimumPathClearance(project, [sample]));
    const closestSampleIndex = sampleClearances.reduce((bestIndex, clearance, index) => (
      clearance < sampleClearances[bestIndex] ? index : bestIndex
    ), 0);
    const analysis = analyzePath(project, path.id, { minimumClearanceM: 0.1 });
    const finding = analysis.findings.find((item) => item.id === "geometry:field-obstacle-clearance");
    expect(finding?.severity).toBe("error");
    expect(finding?.measured).toBe(minimumPathClearance(project, samples));
    expect(finding?.sample?.index).toBe(closestSampleIndex);
    expect(JSON.stringify(path)).toBe(before);
  });

  it("rejects a path endpoint touching an alliance barrier outside a typed portal", () => {
    const project = createDemoProject();
    const barrierX = REBUILT_2026_CROSSINGS.blue.trenchAway.x;
    const path = project.paths[0];
    path.waypoints = buildWaypoints([{ x: barrierX - 0.1, y: 1.8 }, { x: barrierX - 0.1, y: 2 }]);
    const analysis = analyzePath(project, path.id);
    expect(analysis.findings.some((finding) => finding.id.startsWith("geometry:illegal-barrier-touches") && finding.severity === "error")).toBe(true);
  });
});
