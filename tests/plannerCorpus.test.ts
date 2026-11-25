import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzePath } from "../src/core/agent/pathAnalysis";
import { ACTIVE_FIELD_REFERENCE, REBUILT_2026_CROSSINGS } from "../src/core/field/rebuilt2026";
import { decodeProjectFile, encodeProjectFile } from "../src/core/project/fileFormat";

type FrozenScenario = {
  pathId: string;
  intent: string;
  features: string[];
  validation: {
    requiredTraversal: "direct" | "trench-table" | "trench-away" | "bump-table" | "bump-away";
    requiredPortalIds: string[];
  };
};

const corpusDirectory = join(dirname(fileURLToPath(import.meta.url)), "../benchmarks/planner-corpus/v3");
const projectContents = readFileSync(join(corpusDirectory, "corpus.bordeaux.json"), "utf8");
const manifest = JSON.parse(readFileSync(join(corpusDirectory, "manifest.json"), "utf8"));
const decoded = decodeProjectFile(projectContents);

describe("frozen Bordeaux-authored planner corpus", () => {
  it.each([
    ["v1", "787f068012a9d03247b447fccc9d7f4a12a5c5b8b03dc35bd3b36461dbd93015",
      "a2ec48576a7c9d4fcc89103ed6b4a139ddb0169fa55b75846c02531c708b8545", "ba619c3d49fd8ad12d0fc0d78fabf772e74774186eeb4bf66d62e78e55236676"],
    ["v2", "13d691ba733f131d3982c8a17d739114e4ddf4d416a59c521da40be10267d2a8",
      "d7c3e92102a7179bd5947d3d4318bcd04d49ba39b46813ebdb34911a9308273f", "626ec8af867207729815446bf0257d1ed5993ddcd22b35ad6759ea4e4c20c89b"],
  ])("preserves the historical %s corpus and benchmark locks", (version, projectHash, fixed, corridor) => {
    const hash = (file: string) => createHash("sha256").update(readFileSync(join(corpusDirectory, "..", version, file))).digest("hex");
    expect(hash("corpus.bordeaux.json")).toBe(projectHash);
    for (const [name, digest] of [["fixed-geometry", fixed], ["corridor", corridor]]) {
      expect(hash(name + ".json")).toBe(digest);
      expect(readFileSync(join(corpusDirectory, "..", version, name + ".sha256"), "utf8").trim()).toBe("sha256:" + digest);
    }
  });

  it("is a canonical current project pinned to the certified field and swerve model", () => {
    expect(decoded.migrated).toBe(false);
    expect(decoded.project.field).toEqual(ACTIVE_FIELD_REFERENCE);
    expect(decoded.project.field).toEqual(manifest.field);
    expect(decoded.project.robot).toEqual(manifest.robot);
    expect(decoded.project.robot.drive).toBe("swerve");
    expect(encodeProjectFile(decoded.project).contents).toBe(projectContents);
  });

  it("locks every authored scenario and its provenance before planner measurements", () => {
    const digest = `sha256:${createHash("sha256").update(projectContents).digest("hex")}`;
    const projectPathIds = decoded.project.paths.map((path) => path.id).sort();
    const manifestPathIds = manifest.scenarios.map((scenario: FrozenScenario) => scenario.pathId).sort();

    expect(manifest.schemaVersion).toBe("bordeaux-planner-corpus/1.0");
    expect(manifest.origin).toEqual({
      kind: "bordeaux-authored",
      realTeamData: false,
      redistribution: "Bordeaux-owned synthetic benchmark fixtures",
    });
    expect(manifest.claims.representativeness).toBe("synthetic-tactical-scenarios");
    expect(manifest.project.sha256).toBe(digest);
    expect(decoded.project.paths.length).toBeGreaterThanOrEqual(4);
    expect(manifest.scenarios).toHaveLength(decoded.project.paths.length);
    expect(manifestPathIds).toEqual(projectPathIds);
    expect(new Set(manifest.scenarios.map((scenario: FrozenScenario) => scenario.intent)).size).toBe(decoded.project.paths.length);
  });

  it("contains useful tactical variety without team-sensitive strategy or solver output", () => {
    const scenarios = manifest.scenarios as FrozenScenario[];
    const features = new Set(scenarios.flatMap((scenario) => scenario.features));
    for (const feature of [
      "trench-crossing",
      "bump-crossing",
      "curved-geometry",
      "interior-stop",
      "nonzero-end-velocity",
      "mirrored-alliance",
    ]) expect(features.has(feature), feature).toBe(true);
    expect(decoded.project.strategy).toBeUndefined();
    expect(decoded.project.routines.every((routine) => routine.nodes.length === 0)).toBe(true);
    expect(decoded.project.paths.every((path) => path.markers.length === 0)).toBe(true);
    expect(projectContents).not.toMatch(/team(number)?|credential|token|solver(output|result)/i);

    for (const scenario of scenarios) {
      const path = decoded.project.paths.find((candidate) => candidate.id === scenario.pathId)!;
      if (scenario.features.includes("nonzero-end-velocity")) expect(path.goalVel, path.id).toBeGreaterThan(0);
      if (scenario.features.includes("interior-stop")) expect(path.waypoints.slice(1, -1).some((waypoint) => waypoint.stop), path.id).toBe(true);
      if (scenario.features.includes("manual-heading")) expect(path.headingMode, path.id).toBe("manual");
      if (scenario.features.includes("multi-segment")) expect(path.waypoints.length, path.id).toBeGreaterThan(3);
    }
  });

  it("produces finite, collision-free baseline trajectories for every frozen path", () => {
    for (const scenario of manifest.scenarios as FrozenScenario[]) {
      const path = decoded.project.paths.find((candidate) => candidate.id === scenario.pathId)!;
      const analysis = analyzePath(decoded.project, path.id, {
        sampleLimit: 2_000,
        requiredTraversal: scenario.validation.requiredTraversal,
        requiredPortalIds: scenario.validation.requiredPortalIds,
      });
      expect(analysis.totalTimeS, path.id).toBeGreaterThan(0);
      expect(analysis.totalDistanceM, path.id).toBeGreaterThan(0);
      expect(analysis.sampleCount, path.id).toBeGreaterThan(2);
      expect(analysis.findings.filter((finding) => finding.severity === "error"), path.id).toEqual([]);
      if (scenario.features.includes("neutral-zone")) {
        expect(analysis.rawSamples.every((sample) => (
          sample.x < REBUILT_2026_CROSSINGS.blue.trenchTable.x
          && sample.x > REBUILT_2026_CROSSINGS.red.trenchTable.x
        )), path.id).toBe(true);
      }
    }
  });
});
