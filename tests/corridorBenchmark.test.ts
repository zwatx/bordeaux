import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CorridorCorpus } from "../src/electron/benchmark/corridor";
import { getPlanner } from "../src/shared/planners";
import { decodeProjectFile } from "../src/shared/project/fileFormat";

const directory = join(dirname(fileURLToPath(import.meta.url)), "../benchmarks/planner-corpus/v2");
const corridorContents = readFileSync(join(directory, "corridor.json"), "utf8");
const corridorDigest = readFileSync(join(directory, "corridor.sha256"), "utf8").trim();
const project = decodeProjectFile(readFileSync(join(directory, "corpus.bordeaux.json"), "utf8")).project;
const manifest = JSON.parse(corridorContents);
const corpus = CorridorCorpus.loadV2(directory);

function benchmarkCase(pathId: string) {
  return corpus.cases.find((candidate) => candidate.pathId === pathId)!;
}

function candidate(pathId: string) {
  const path = project.paths.find((value) => value.id === pathId)!;
  const generated = getPlanner("profiledSpline").generate({ path, robot: project.robot });
  const eventOrder = benchmarkCase(pathId).eventOrder;
  return {
    ...generated,
    events: eventOrder.map((id, index) => ({ id, timeS: generated.totalTimeS * (index + 1) / (eventOrder.length + 1) })),
  };
}

describe("corridor benchmark corpus", () => {
  it("pins its manifest, source corpus, seeds, topology, stops, events, and swerve model", () => {
    expect(manifest.schemaVersion).toBe("bordeaux-corridor/1.0");
    expect(corridorDigest).toBe(`sha256:${createHash("sha256").update(corridorContents).digest("hex")}`);
    expect(manifest.leaderboard.drive).toBe("swerve");
    expect(corpus.cases).toHaveLength(3);
    expect(new Set(corpus.cases.map((value) => value.deterministicSeed)).size).toBe(corpus.cases.length);
    expect(corpus.cases.every((value) => value.gates.length > 0 && value.eventOrder.length > 0)).toBe(true);
    expect(corpus.cases.find((value) => value.pathId === "corpus-neutral-stop")?.stops).toEqual([{ waypointIndex: 1, waitS: 0.15 }]);
  });

  it("accepts baseline paths through dense swept-footprint and motion validation", () => {
    for (const value of corpus.cases) {
      const result = corpus.validate(value.id, candidate(value.pathId));
      expect(result.issues, value.id).toEqual([]);
      expect(result.valid, value.id).toBe(true);
      expect(result.rankingEligible, value.id).toBe(true);
    }
  });

  it("rejects endpoint, gate, stop, and event-order violations", () => {
    const slalom = benchmarkCase("corpus-neutral-slalom");
    const endpoint = candidate(slalom.pathId);
    endpoint.samples[0].x += 0.2;
    expect(corpus.validate(slalom.id, endpoint).issues.map((issue) => issue.code)).toContain("topology:start-pose");

    const gate = candidate(slalom.pathId);
    const centerGate = slalom.gates[1].bounds;
    gate.samples.forEach((sample) => {
      if (sample.x >= centerGate.xMin - 0.8 && sample.x <= centerGate.xMax + 0.8) sample.y -= 1.4;
    });
    expect(corpus.validate(slalom.id, gate).issues.map((issue) => issue.code)).toContain("topology:gate-order");

    const stop = benchmarkCase("corpus-neutral-stop");
    const moving = candidate(stop.pathId);
    const stopWaypoint = project.paths.find((path) => path.id === stop.pathId)!.waypoints[1];
    moving.samples = moving.samples.filter((sample) => Math.hypot(sample.x - stopWaypoint.x, sample.y - stopWaypoint.y) > 0.04);
    expect(corpus.validate(stop.id, moving).issues.map((issue) => issue.code)).toContain("topology:stop");

    const events = candidate(slalom.pathId);
    events.events.reverse();
    expect(corpus.validate(slalom.id, events).issues.map((issue) => issue.code)).toContain("topology:event-order");
  });

  it("catches an escape between sparse source samples", () => {
    const slalom = benchmarkCase("corpus-neutral-stop");
    const sparse = candidate(slalom.pathId);
    sparse.samples = [sparse.samples[0], sparse.samples.at(-1)!];

    const result = corpus.validate(slalom.id, sparse);
    expect(result.rankingEligible).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("candidate:source-density");
    expect(result.issues.map((issue) => issue.code)).toContain("corridor:swept-footprint");
  });

  it("rejects a centerline-inside pose whose rotated footprint leaves the corridor", () => {
    const slalom = benchmarkCase("corpus-blue-table-trench");
    const footprintEscape = candidate(slalom.pathId);
    const index = Math.floor(footprintEscape.samples.length / 2);
    const before = footprintEscape.samples[index - 1];
    const after = footprintEscape.samples[index + 1];
    const tangent = Math.atan2(after.y - before.y, after.x - before.x);
    footprintEscape.samples[index].x += Math.cos(tangent + Math.PI / 2) * 0.8;
    footprintEscape.samples[index].y += Math.sin(tangent + Math.PI / 2) * 0.8;
    footprintEscape.samples[index].headingRad = tangent + Math.PI / 4;

    expect(corpus.validate(slalom.id, footprintEscape).issues.map((issue) => issue.code))
      .toContain("corridor:swept-footprint");
  });

  it("derives centripetal acceleration from geometry instead of planner metadata", () => {
    const slalom = benchmarkCase("corpus-neutral-slalom");
    const sharpTurn = candidate(slalom.pathId);
    const index = Math.floor(sharpTurn.samples.length / 2);
    sharpTurn.samples[index].x += 0.14;
    sharpTurn.samples[index].curvatureInvM = 0;

    expect(corpus.validate(slalom.id, sharpTurn).issues.map((issue) => issue.code))
      .toContain("constraint:centripetal-acceleration");
  });

  it("rejects alternating turns that cancel across a wider curvature window", () => {
    const path = project.paths.find((value) => value.id === "corpus-neutral-slalom")!;
    const generated = getPlanner("profiledSpline").generate({ path, robot: project.robot });
    const zigzag = structuredClone(generated);
    const startHeading = generated.samples[0].headingRad;
    const goalHeading = generated.samples.at(-1)!.headingRad;

    for (let index = 1; index < zigzag.samples.length - 1; index += 1) {
      const before = generated.samples[index - 1];
      const after = generated.samples[index + 1];
      const normal = Math.atan2(after.y - before.y, after.x - before.x) + Math.PI / 2;
      const offset = index % 2 ? 0.04 : -0.04;
      zigzag.samples[index].x += Math.cos(normal) * offset;
      zigzag.samples[index].y += Math.sin(normal) * offset;
    }

    let totalTimeS = 0;
    zigzag.samples.forEach((sample, index) => {
      if (index > 0) {
        const previous = zigzag.samples[index - 1];
        totalTimeS += Math.hypot(sample.x - previous.x, sample.y - previous.y);
      }
      sample.t = totalTimeS;
    });
    const angularVelocity = (goalHeading - startHeading) / totalTimeS;
    zigzag.samples.forEach((sample) => {
      sample.velocityMps = 1;
      sample.accelerationMps2 = 0;
      sample.headingRad = startHeading + (goalHeading - startHeading) * sample.t / totalTimeS;
      sample.angularVelocityRadps = angularVelocity;
      sample.curvatureInvM = 0;
    });

    const fixture = benchmarkCase(path.id);
    const result = corpus.validate(fixture.id, {
      ...zigzag,
      events: fixture.eventOrder.map((id, index) => ({
        id,
        timeS: totalTimeS * (index + 1) / (fixture.eventOrder.length + 1),
      })),
    });

    const codes = result.issues.map((issue) => issue.code);
    expect(codes).not.toContain("candidate:source-density");
    expect(codes).not.toContain("corridor:swept-footprint");
    expect(codes).toContain("constraint:centripetal-acceleration");
    expect(result.rankingEligible).toBe(false);
  });

  it("does not expose a corridor editor or accept an unregistered fixture", () => {
    expect(corpus.validate("invented-corridor", candidate("corpus-neutral-slalom")).rankingEligible).toBe(false);
    expect(() => new (CorridorCorpus as any)(Symbol("forged"), "forged", [])).toThrow("pinned manifest");
  });
});
