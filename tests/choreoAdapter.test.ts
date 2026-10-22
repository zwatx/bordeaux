import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  captureChoreoRun,
  CHOREO_BINARY_SHA256,
  CHOREO_SLEIPNIR_VERSION,
  CHOREO_VERSION,
  choreoInvocation,
  prepareChoreoFixture,
} from "../src/electron/benchmark/choreoAdapter";

const directory = join(dirname(fileURLToPath(import.meta.url)), "../benchmarks/planner-corpus/v2");

describe("Choreo benchmark adapter", () => {
  it.each([
    ["fixed-geometry" as const, "fixed-blue-away-bump"],
    ["corridor" as const, "corridor-neutral-slalom"],
  ])("prepares a pinned %s request without Bordeaux timing", (benchmarkClass, fixtureId) => {
    const prepared = prepareChoreoFixture(directory, benchmarkClass, fixtureId);
    expect(prepared.supported).toBe(true);
    if (!prepared.supported) return;

    expect(prepared.provenance).toMatchObject({
      tool: "Choreo",
      choreoVersion: CHOREO_VERSION,
      sleipnirVersion: CHOREO_SLEIPNIR_VERSION,
      binarySha256: CHOREO_BINARY_SHA256,
      runtime: "ELF x86-64, GNU/Linux 3.2+ standalone",
    });
    expect(prepared.projectContents).not.toContain('"trajectory"');
    expect(prepared.trajectory.trajectory.samples).toEqual([]);
    expect(prepared.inputSha256).toBe(`sha256:${createHash("sha256")
      .update(prepared.projectContents)
      .update(prepared.trajectoryContents)
      .digest("hex")}`);
    expect(prepared.mapping.robotDynamics).toContain("frozen adapter assumptions");
    if (benchmarkClass === "fixed-geometry") {
      expect(prepared.mapping.geometry).toContain("fixed");
      expect(prepared.trajectory.params.waypoints.every((waypoint) => waypoint.fixTranslation && waypoint.fixHeading)).toBe(true);
    } else {
      expect(prepared.mapping.geometry).toContain("corridor");
      expect(prepared.trajectory.params.waypoints.slice(1, -1).some((waypoint) => !waypoint.fixTranslation)).toBe(true);
      expect(prepared.trajectory.params.constraints.some((constraint) => constraint.data.type === "KeepInLane")).toBe(true);
      expect(prepared.trajectory.events.map((event) => event.name)).toEqual(["slalom-entry", "slalom-exit"]);
    }
  });

  it("records and executes one exact resolved CLI invocation", () => {
    expect(choreoInvocation("/tools/choreo-cli", "/tmp/run/project.chor", "fixture")).toEqual({
      executable: "/tools/choreo-cli",
      arguments: ["--chor", "/tmp/run/project.chor", "--trajectory", "fixture", "--generate"],
      workingDirectory: "/tmp/run",
    });
  });

  it("reports unsupported representations instead of dropping them", () => {
    expect(prepareChoreoFixture(directory, "fixed-geometry", "fixed-neutral-stop")).toMatchObject({
      supported: false,
      code: "choreo:unsupported-concept",
    });
  });

  it("retains raw process and trajectory bytes before normalizing", () => {
    const prepared = prepareChoreoFixture(directory, "fixed-geometry", "fixed-blue-away-bump");
    expect(prepared.supported).toBe(true);
    if (!prepared.supported) return;
    const rawOutput = `${JSON.stringify({
      name: prepared.trajectoryName,
      version: 3,
      trajectory: {
        sampleType: "Swerve",
        waypoints: [0, 1, 2],
        samples: [
          { t: 0, x: 15.35, y: 6.2, heading: 0, vx: 0, vy: 0, omega: 0, ax: 1, ay: 0, alpha: 0 },
          { t: 1, x: 13.2743, y: 5.4629, heading: 0.2, vx: -1.3, vy: 0.85, omega: 0.2, ax: 0, ay: 0, alpha: 0 },
          { t: 2.01, x: 11.25, y: 6.25, heading: 0.4, vx: 0, vy: 0, omega: 0, ax: -1, ay: 0, alpha: 0 },
        ],
      },
      events: [],
    }, null, 2)}\n`;
    const invocation = choreoInvocation("/tools/choreo-cli", "/tmp/run/project.chor", prepared.trajectoryName);
    const result = captureChoreoRun(prepared, { invocation, exitCode: 0, stdout: "generated\n", stderr: "", rawOutput });
    expect(result).toMatchObject({ outcome: "generated", invocation, rawOutput, process: { stdout: "generated\n" } });
    expect(result.normalized!.samples.length).toBeGreaterThan(3);
    expect(result.normalized!.samples[1].t).toBe(0.02);
    expect(result.normalized!.samples.at(-2)!.t).toBe(2);
    expect(result.normalized!.samples.at(-1)!.t).toBe(2.01);
  });

  it("rejects adversarial short-interval motion instead of compacting it away", () => {
    const prepared = prepareChoreoFixture(directory, "fixed-geometry", "fixed-blue-away-bump");
    expect(prepared.supported).toBe(true);
    if (!prepared.supported) return;
    const sample = (t: number, x: number, vx: number) => ({
      t, x, y: 6.2, heading: 0, vx, vy: 0, omega: 0, ax: 0, ay: 0, alpha: 0,
    });
    const rawOutput = `${JSON.stringify({
      name: prepared.trajectoryName,
      version: 3,
      trajectory: {
        sampleType: "Swerve",
        samples: [sample(0, 15.35, 0), sample(0.002, 14.35, -500), sample(0.004, 15.35, 500), sample(1, 11.25, 0)],
      },
      events: [],
    })}\n`;
    const invocation = choreoInvocation("/tools/choreo-cli", "/tmp/run/project.chor", prepared.trajectoryName);
    const result = captureChoreoRun(prepared, { invocation, exitCode: 0, stdout: "", stderr: "", rawOutput });
    expect(result).toMatchObject({
      outcome: "failed",
      normalized: null,
      failure: "Choreo short-interval motion cannot be safely compacted without changing the candidate.",
    });
    expect(result.rawOutput).toBe(rawOutput);
  });
});
