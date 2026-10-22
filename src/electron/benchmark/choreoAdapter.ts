import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PM } from "../../shared/math/pm";
import { decodeProjectFile } from "../../shared/project/fileFormat";
import type { BordeauxProject, PathDoc } from "../../shared/types";
import { CorridorCorpus } from "./corridor";
import { FixedGeometryCorpus, normalizeTrajectoryCandidate, type NormalizedTrajectory } from "./fixedGeometry";

export const CHOREO_VERSION = "2026.0.3";
export const CHOREO_SLEIPNIR_VERSION = "0.5.1";
export const CHOREO_BINARY_SHA256 = "sha256:25a7392dceddb3b4110499e65c0955a331244548c7b0311fdcd981713bd39120";
export const CHOREO_RELEASE_ARCHIVE_SHA256 = "sha256:e70d421d067ed3faeaeae4ad537ab7e82eabce98354e694820b612190ab1de4b";
export const CHOREO_ADAPTER_VERSION = "1.0.0" as const;
const NORMALIZATION_STEP_S = 0.02;
const COMPACTION_INTERVAL_S = 0.005;
const COMPACTION_POSITION_TOLERANCE_M = 0.00005;
const COMPACTION_HEADING_TOLERANCE_RAD = 0.00003;
const COMPACTION_VELOCITY_TOLERANCE_MPS = 0.006;
const COMPACTION_OMEGA_TOLERANCE_RADPS = 0.002;

type BenchmarkClass = "fixed-geometry" | "corridor";
type Expr = { exp: string; val: number };
type ChoreoWaypoint = {
  x: Expr;
  y: Expr;
  heading: Expr;
  intervals: number;
  split: boolean;
  fixTranslation: boolean;
  fixHeading: boolean;
  overrideIntervals: boolean;
};
type ChoreoConstraint = {
  from: number | "first" | "last";
  to?: number | "first" | "last";
  data: { type: string; props: Record<string, Expr | boolean> };
  enabled: true;
};
type ChoreoEvent = {
  name: string;
  from: { target: number | "first" | "last"; targetTimestamp: null; offset: Expr };
  event: null;
};

export type ChoreoTrajectoryInput = {
  name: string;
  version: 3;
  snapshot: null;
  params: { waypoints: ChoreoWaypoint[]; constraints: ChoreoConstraint[]; targetDt: Expr };
  trajectory: { config: null; sampleType: null; waypoints: []; samples: []; splits: [] };
  events: ChoreoEvent[];
};

export type ChoreoInvocation = {
  executable: string;
  arguments: string[];
  workingDirectory: string;
};

export type ChoreoPreparation =
  | {
    supported: true;
    benchmarkClass: BenchmarkClass;
    fixtureId: string;
    deterministicSeed: number;
    trajectoryName: string;
    provenance: {
      tool: "Choreo";
      choreoVersion: typeof CHOREO_VERSION;
      sleipnirVersion: typeof CHOREO_SLEIPNIR_VERSION;
      binarySha256: typeof CHOREO_BINARY_SHA256;
      releaseArchiveSha256: typeof CHOREO_RELEASE_ARCHIVE_SHA256;
      runtime: "ELF x86-64, GNU/Linux 3.2+ standalone";
    };
    mapping: {
      geometry: string;
      heading: string;
      constraints: string;
      robotDynamics: string;
      unsupportedRepresentations: string[];
    };
    project: Record<string, unknown>;
    trajectory: ChoreoTrajectoryInput;
    projectContents: string;
    trajectoryContents: string;
    inputSha256: string;
  }
  | { supported: false; benchmarkClass: BenchmarkClass; fixtureId: string; code: string; reason: string };

export type ChoreoProcessCapture = {
  invocation: ChoreoInvocation;
  exitCode: number;
  stdout: string;
  stderr: string;
  rawOutput: string | null;
};

export type ChoreoAdapterResult = {
  schemaVersion: "bordeaux-choreo-capture/1.0";
  adapterVersion: typeof CHOREO_ADAPTER_VERSION;
  provenance: Extract<ChoreoPreparation, { supported: true }>["provenance"];
  benchmarkClass: BenchmarkClass;
  fixtureId: string;
  inputSha256: string;
  invocation: ChoreoInvocation;
  process: { exitCode: number; stdout: string; stderr: string };
  rawOutput: string | null;
  normalized: NormalizedTrajectory | null;
  events: Array<{ id: string; timeS: number }>;
  outcome: "generated" | "failed";
  failure?: string;
};

type ChoreoRawSample = {
  t: number; x: number; y: number; heading: number;
  vx: number; vy: number; omega: number; ax: number; ay: number; alpha: number;
};

type ChoreoRawOutput = {
  name: string;
  version: number;
  trajectory?: {
    sampleType?: string;
    samples?: ChoreoRawSample[];
  };
  events?: Array<{ name: string; from?: { targetTimestamp?: number | null } }>;
};

function expression(value: number, unit = ""): Expr {
  return { exp: `${value}${unit ? ` ${unit}` : ""}`, val: value };
}

function digest(parts: readonly string[]): string {
  const hash = createHash("sha256");
  parts.forEach((part) => hash.update(part));
  return `sha256:${hash.digest("hex")}`;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function wrappedAngle(value: number): number {
  return Math.atan2(Math.sin(value), Math.cos(value));
}

function fixtureProject(directory: string): BordeauxProject {
  return decodeProjectFile(readFileSync(join(directory, "corpus.bordeaux.json"), "utf8")).project;
}

function unsupportedPathConcept(path: PathDoc): string | null {
  if (Math.abs(path.startVel) > 1e-9 || Math.abs(path.goalVel) > 1e-9) {
    return "Choreo v2026.0.3 can pin a stop but cannot reproduce Bordeaux nonzero endpoint velocity.";
  }
  if (path.waypoints.some((waypoint, index) => index > 0 && index < path.waypoints.length - 1
    && (waypoint.stop || (waypoint.wait ?? 0) > 0))) {
    return "The pinned adapter does not translate Bordeaux interior stops or waits into Choreo.";
  }
  if (Math.abs(path.constraints.maxAccel - path.constraints.maxDecel) > 1e-9
    || Math.abs(path.constraints.maxAngAccel - (path.constraints.maxAngDecel ?? path.constraints.maxAngAccel)) > 1e-9) {
    return "Choreo does not expose separate acceleration and deceleration constraints.";
  }
  if ((path.constraints.maxJerk ?? 0) > 0 || (path.constraints.maxAngJerk ?? 0) > 0) {
    return "Choreo does not expose the authored Bordeaux jerk constraints.";
  }
  if (path.ranges.length > 0) {
    return "The pinned Choreo adapter does not translate Bordeaux range constraints.";
  }
  return null;
}

function projectInput(project: BordeauxProject, path: PathDoc): Record<string, unknown> {
  const halfLength = project.robot.l / 2;
  const halfWidth = project.robot.w / 2;
  const moduleInsetM = 0.1;
  const moduleX = Math.max(0.05, halfLength - moduleInsetM);
  const moduleY = Math.max(0.05, halfWidth - moduleInsetM);
  const gearing = 6.75;
  const wheelRadiusM = 0.0508;
  return {
    name: "Bordeaux benchmark",
    version: 2,
    type: "Swerve",
    variables: { expressions: {}, poses: {} },
    config: {
      frontLeft: { x: expression(moduleX, "m"), y: expression(moduleY, "m") },
      backLeft: { x: expression(-moduleX, "m"), y: expression(moduleY, "m") },
      mass: expression(56, "kg"),
      inertia: expression(6, "kg m ^ 2"),
      gearing: expression(gearing),
      radius: expression(wheelRadiusM, "m"),
      vmax: expression(project.robot.maxSpeed * gearing / wheelRadiusM, "rad / s"),
      cof: expression((path.constraints.maxCentripetalAccel ?? path.constraints.maxAccel) / 9.80665),
      tmax: expression(2.6, "N * m"),
      bumper: {
        front: expression(halfLength, "m"), side: expression(halfWidth, "m"), back: expression(halfLength, "m"),
      },
      differentialTrackWidth: expression(moduleY * 2, "m"),
    },
    generationFeatures: [],
    codegen: { root: null, genVars: false, genTrajData: false, useChoreoLib: true },
  };
}

function referenceWaypoints(
  path: PathDoc,
  project: BordeauxProject,
  samplesPerSegment: number,
  fixed: boolean,
): ChoreoWaypoint[] {
  const derived = PM.derivePath(path, project.robot, samplesPerSegment, { skipStationaryActions: true });
  const points = derived.sample.pts as Array<{ x: number; y: number }>;
  const headings = derived.metrics.head as number[];
  return points.map((point, index) => {
    const next = points[Math.min(points.length - 1, index + 1)];
    const intervals = Math.max(1, Math.ceil(Math.hypot(next.x - point.x, next.y - point.y) / 0.12));
    const endpoint = index === 0 || index === points.length - 1;
    return {
      x: expression(point.x, "m"),
      y: expression(point.y, "m"),
      heading: expression(headings[index] ?? 0, "rad"),
      intervals,
      split: false,
      fixTranslation: fixed || endpoint,
      fixHeading: fixed || endpoint,
      overrideIntervals: true,
    };
  });
}

function constraint(
  from: number | "first" | "last",
  to: number | "first" | "last" | undefined,
  type: string,
  props: Record<string, Expr | boolean> = {},
): ChoreoConstraint {
  return { from, ...(to === undefined ? {} : { to }), data: { type, props }, enabled: true };
}

function commonConstraints(path: PathDoc): ChoreoConstraint[] {
  return [
    constraint("first", undefined, "StopPoint"),
    constraint("last", undefined, "StopPoint"),
    constraint("first", "last", "MaxVelocity", { max: expression(Math.min(path.constraints.maxVel, 5), "m / s") }),
    constraint("first", "last", "MaxAcceleration", { max: expression(path.constraints.maxAccel, "m / s ^ 2") }),
    constraint("first", "last", "MaxAngularVelocity", { max: expression(path.constraints.maxAngVel * Math.PI / 180, "rad / s") }),
  ];
}

function buildTrajectory(
  benchmarkClass: BenchmarkClass,
  trajectoryName: string,
  project: BordeauxProject,
  path: PathDoc,
  corridorCase: ReturnType<typeof CorridorCorpus.loadV2>["cases"][number] | null,
): ChoreoTrajectoryInput {
  const fixed = benchmarkClass === "fixed-geometry";
  const waypoints = referenceWaypoints(path, project, 4, fixed);
  const constraints = commonConstraints(path);
  if (!fixed) {
    for (let index = 0; index < waypoints.length - 1; index += 1) {
      constraints.push(constraint(index, index + 1, "KeepInLane", {
        tolerance: expression(corridorCase!.centerlineToFootprintBoundaryM, "m"),
      }));
    }
    corridorCase!.gates.forEach((gate) => {
      const centerX = (gate.bounds.xMin + gate.bounds.xMax) / 2;
      const centerY = (gate.bounds.yMin + gate.bounds.yMax) / 2;
      let nearest = 1;
      let nearestDistance = Number.POSITIVE_INFINITY;
      waypoints.slice(1, -1).forEach((waypoint, offset) => {
        const distance = Math.hypot(waypoint.x.val - centerX, waypoint.y.val - centerY);
        if (distance < nearestDistance) {
          nearest = offset + 1;
          nearestDistance = distance;
        }
      });
      constraints.push(constraint(nearest, undefined, "KeepInRectangle", {
        x: expression(gate.bounds.xMin, "m"), y: expression(gate.bounds.yMin, "m"),
        w: expression(gate.bounds.xMax - gate.bounds.xMin, "m"),
        h: expression(gate.bounds.yMax - gate.bounds.yMin, "m"),
      }));
    });
  }
  const eventIds = corridorCase?.eventOrder ?? [];
  const events = eventIds.map((name, index): ChoreoEvent => ({
    name,
    from: {
      target: Math.max(1, Math.min(waypoints.length - 2, Math.round((index + 1) * (waypoints.length - 1) / (eventIds.length + 1)))),
      targetTimestamp: null,
      offset: expression(0, "s"),
    },
    event: null,
  }));
  return {
    name: trajectoryName,
    version: 3,
    snapshot: null,
    params: { waypoints, constraints, targetDt: expression(0.04, "s") },
    trajectory: { config: null, sampleType: null, waypoints: [], samples: [], splits: [] },
    events,
  };
}

export function prepareChoreoFixture(
  directory: string,
  benchmarkClass: BenchmarkClass,
  fixtureId: string,
): ChoreoPreparation {
  const project = fixtureProject(directory);
  const fixedCase = benchmarkClass === "fixed-geometry"
    ? FixedGeometryCorpus.loadV2(directory).cases.find((value) => value.id === fixtureId)
    : null;
  const corridorCase = benchmarkClass === "corridor"
    ? CorridorCorpus.loadV2(directory).cases.find((value) => value.id === fixtureId) ?? null
    : null;
  const fixture = fixedCase ?? corridorCase;
  if (!fixture) return { supported: false, benchmarkClass, fixtureId, code: "fixture:identity", reason: "Fixture is not in the pinned benchmark corpus." };
  const path = project.paths.find((candidate) => candidate.id === fixture.pathId)!;
  const unsupported = unsupportedPathConcept(path);
  if (unsupported) return { supported: false, benchmarkClass, fixtureId, code: "choreo:unsupported-concept", reason: unsupported };
  const trajectoryName = `bordeaux-${fixtureId}`;
  const projectDocument = projectInput(project, path);
  const trajectory = buildTrajectory(benchmarkClass, trajectoryName, project, path, corridorCase);
  const projectContents = `${JSON.stringify(projectDocument, null, 2)}\n`;
  const trajectoryContents = `${JSON.stringify(trajectory, null, 2)}\n`;
  return {
    supported: true,
    benchmarkClass,
    fixtureId,
    deterministicSeed: fixture.deterministicSeed,
    trajectoryName,
    provenance: {
      tool: "Choreo",
      choreoVersion: CHOREO_VERSION,
      sleipnirVersion: CHOREO_SLEIPNIR_VERSION,
      binarySha256: CHOREO_BINARY_SHA256,
      releaseArchiveSha256: CHOREO_RELEASE_ARCHIVE_SHA256,
      runtime: "ELF x86-64, GNU/Linux 3.2+ standalone",
    },
    mapping: {
      geometry: benchmarkClass === "fixed-geometry"
        ? "Bordeaux authored geometry and heading are sampled at 4 points per segment and fixed in Choreo; Bordeaux timing is never supplied."
        : "Bordeaux corridor centerline is sampled at 4 points per segment only to define KeepInLane boundaries; internal poses and headings remain free for Choreo to optimize.",
      heading: benchmarkClass === "fixed-geometry"
        ? "Every sampled authored heading is fixed."
        : "Only endpoint headings are fixed; internal heading is solver-selected.",
      constraints: "Zero endpoint velocity, global linear velocity/acceleration, angular velocity, corridor lanes, and corridor gates use native Choreo constraints; neutral validation enforces the complete benchmark contract.",
      robotDynamics: "Bordeaux dimensions and max speed are preserved; 56 kg mass, 6 kg m² MOI, wheel geometry, NEO torque, and gearing are frozen adapter assumptions.",
      unsupportedRepresentations: [
        "Choreo v2026.0.3 has no explicit authored angular-acceleration constraint; the neutral validator rejects violations.",
        "Sleipnir 0.5.1 is recorded as Choreo solver provenance, not a separate competitor.",
        "Bordeaux commands and routines are outside this trajectory-only adapter.",
      ],
    },
    project: projectDocument,
    trajectory,
    projectContents,
    trajectoryContents,
    inputSha256: digest([projectContents, trajectoryContents]),
  };
}

export function choreoInvocation(binaryPath: string, projectPath: string, trajectoryName: string): ChoreoInvocation {
  const resolvedProject = resolve(projectPath);
  return {
    executable: resolve(binaryPath),
    arguments: ["--chor", resolvedProject, "--trajectory", trajectoryName, "--generate"],
    workingDirectory: dirname(resolvedProject),
  };
}

function curvature(samples: ReadonlyArray<{ x: number; y: number }>, index: number): number {
  if (index <= 0 || index >= samples.length - 1) return 0;
  const first = samples[index - 1];
  const middle = samples[index];
  const last = samples[index + 1];
  const a = Math.hypot(middle.x - first.x, middle.y - first.y);
  const b = Math.hypot(last.x - middle.x, last.y - middle.y);
  const c = Math.hypot(last.x - first.x, last.y - first.y);
  const cross = Math.abs((middle.x - first.x) * (last.y - first.y) - (middle.y - first.y) * (last.x - first.x));
  return a * b * c <= 1e-12 ? 0 : 2 * cross / (a * b * c);
}

function hermite(first: number, firstRate: number, second: number, secondRate: number, duration: number, fraction: number) {
  const f2 = fraction * fraction;
  const f3 = f2 * fraction;
  return (2 * f3 - 3 * f2 + 1) * first
    + (f3 - 2 * f2 + fraction) * duration * firstRate
    + (-2 * f3 + 3 * f2) * second
    + (f3 - f2) * duration * secondRate;
}

function hermiteRate(first: number, firstRate: number, second: number, secondRate: number, duration: number, fraction: number) {
  const f2 = fraction * fraction;
  return ((6 * f2 - 6 * fraction) * first
    + (3 * f2 - 4 * fraction + 1) * duration * firstRate
    + (-6 * f2 + 6 * fraction) * second
    + (3 * f2 - 2 * fraction) * duration * secondRate) / duration;
}

function resampleChoreo(
  samples: readonly ChoreoRawSample[],
) {
  if (samples.length < 2 || samples.some((sample, index) => index > 0 && sample.t <= samples[index - 1].t)) {
    throw new Error("Choreo raw sample times must increase strictly.");
  }
  const totalTimeS = samples.at(-1)!.t;
  const fullSteps = Math.floor(totalTimeS / NORMALIZATION_STEP_S);
  if (!finite(totalTimeS) || totalTimeS <= 0 || fullSteps + 2 > 100_000) {
    throw new Error("Choreo raw duration cannot be normalized within the sample ceiling.");
  }
  const compact = [samples[0]];
  samples.slice(1).forEach((sample, index) => {
    const final = index === samples.length - 2;
    if (sample.t - compact.at(-1)!.t >= COMPACTION_INTERVAL_S) compact.push(sample);
    else if (final) compact[compact.length - 1] = sample;
  });
  if (compact.length < 2) throw new Error("Choreo raw samples do not span a stable normalization interval.");
  const retained = new Set(compact);
  let compactInterval = 0;
  samples.forEach((sample) => {
    if (retained.has(sample)) return;
    while (compactInterval < compact.length - 2 && compact[compactInterval + 1].t < sample.t) compactInterval += 1;
    const first = compact[compactInterval];
    const second = compact[compactInterval + 1];
    const duration = second.t - first.t;
    const fraction = (sample.t - first.t) / duration;
    const secondHeading = first.heading + wrappedAngle(second.heading - first.heading);
    const expectedX = hermite(first.x, first.vx, second.x, second.vx, duration, fraction);
    const expectedY = hermite(first.y, first.vy, second.y, second.vy, duration, fraction);
    const expectedVx = hermiteRate(first.x, first.vx, second.x, second.vx, duration, fraction);
    const expectedVy = hermiteRate(first.y, first.vy, second.y, second.vy, duration, fraction);
    const expectedHeading = hermite(first.heading, first.omega, secondHeading, second.omega, duration, fraction);
    const expectedOmega = hermiteRate(first.heading, first.omega, secondHeading, second.omega, duration, fraction);
    if (Math.hypot(sample.x - expectedX, sample.y - expectedY) > COMPACTION_POSITION_TOLERANCE_M
      || Math.abs(wrappedAngle(sample.heading - expectedHeading)) > COMPACTION_HEADING_TOLERANCE_RAD
      || Math.hypot(sample.vx - expectedVx, sample.vy - expectedVy) > COMPACTION_VELOCITY_TOLERANCE_MPS
      || Math.abs(sample.omega - expectedOmega) > COMPACTION_OMEGA_TOLERANCE_RADPS) {
      throw new Error("Choreo short-interval motion cannot be safely compacted without changing the candidate.");
    }
  });
  const times = Array.from({ length: fullSteps + 1 }, (_unused, index) => index * NORMALIZATION_STEP_S);
  if (totalTimeS - times.at(-1)! > 1e-9) times.push(totalTimeS);
  else times[times.length - 1] = totalTimeS;
  let interval = 0;
  return times.map((time) => {
    while (interval < compact.length - 2 && compact[interval + 1].t < time) interval += 1;
    const first = compact[interval];
    const second = compact[interval + 1];
    const duration = second.t - first.t;
    const fraction = Math.max(0, Math.min(1, (time - first.t) / duration));
    const secondHeading = first.heading + wrappedAngle(second.heading - first.heading);
    const x = hermite(first.x, first.vx, second.x, second.vx, duration, fraction);
    const y = hermite(first.y, first.vy, second.y, second.vy, duration, fraction);
    const velocityX = hermiteRate(first.x, first.vx, second.x, second.vx, duration, fraction);
    const velocityY = hermiteRate(first.y, first.vy, second.y, second.vy, duration, fraction);
    const heading = hermite(first.heading, first.omega, secondHeading, second.omega, duration, fraction);
    const omega = hermiteRate(first.heading, first.omega, secondHeading, second.omega, duration, fraction);
    const accelerationX = first.ax + (second.ax - first.ax) * fraction;
    const accelerationY = first.ay + (second.ay - first.ay) * fraction;
    return { t: time, x, y, heading, vx: velocityX, vy: velocityY, omega, ax: accelerationX, ay: accelerationY };
  });
}

function parseRawOutput(
  preparation: Extract<ChoreoPreparation, { supported: true }>,
  contents: string,
): { normalized: NormalizedTrajectory; events: Array<{ id: string; timeS: number }> } {
  const raw = JSON.parse(contents) as ChoreoRawOutput;
  const samples = raw.trajectory?.samples;
  if (raw.name !== preparation.trajectoryName || raw.version !== 3
    || raw.trajectory?.sampleType !== "Swerve" || !Array.isArray(samples) || !Array.isArray(raw.events)) {
    throw new Error("Choreo raw output does not match the pinned adapter contract.");
  }
  samples.forEach((sample) => {
    if (![sample.t, sample.x, sample.y, sample.heading, sample.vx, sample.vy, sample.omega, sample.ax, sample.ay, sample.alpha].every(finite)) {
      throw new Error("Choreo raw output contains a non-finite swerve sample.");
    }
  });
  const resampled = resampleChoreo(samples);
  const candidate = resampled.map((sample, index) => {
    const speed = Math.hypot(sample.vx, sample.vy);
    const tangentialAcceleration = speed > 1e-9 ? (sample.ax * sample.vx + sample.ay * sample.vy) / speed : 0;
    return {
      t: sample.t,
      x: sample.x,
      y: sample.y,
      headingRad: sample.heading,
      velocityMps: speed,
      accelerationMps2: tangentialAcceleration,
      angularVelocityRadps: sample.omega,
      curvatureInvM: curvature(resampled, index),
    };
  });
  const normalized = normalizeTrajectoryCandidate({ samples: candidate });
  if (!normalized.ok) throw new Error(`Choreo raw output cannot be normalized: ${normalized.issues[0]?.message ?? "unknown error"}`);
  const events = raw.events.map((event) => {
    if (typeof event?.name !== "string" || !event.name.trim() || !finite(event.from?.targetTimestamp)) {
      throw new Error("Choreo raw event is missing its generated timestamp.");
    }
    return { id: event.name, timeS: event.from.targetTimestamp };
  });
  return { normalized: normalized.trajectory, events };
}

export function captureChoreoRun(
  preparation: Extract<ChoreoPreparation, { supported: true }>,
  capture: ChoreoProcessCapture,
): ChoreoAdapterResult {
  const base = {
    schemaVersion: "bordeaux-choreo-capture/1.0" as const,
    adapterVersion: CHOREO_ADAPTER_VERSION,
    provenance: preparation.provenance,
    benchmarkClass: preparation.benchmarkClass,
    fixtureId: preparation.fixtureId,
    inputSha256: preparation.inputSha256,
    invocation: capture.invocation,
    process: { exitCode: capture.exitCode, stdout: capture.stdout, stderr: capture.stderr },
    rawOutput: capture.rawOutput,
  };
  if (capture.exitCode !== 0 || capture.rawOutput === null) {
    return { ...base, normalized: null, events: [], outcome: "failed", failure: "Choreo did not produce a raw trajectory file." };
  }
  try {
    const result = parseRawOutput(preparation, capture.rawOutput);
    return { ...base, ...result, outcome: "generated" };
  } catch (error) {
    return {
      ...base,
      normalized: null,
      events: [],
      outcome: "failed",
      failure: error instanceof Error ? error.message : "Choreo raw output is invalid.",
    };
  }
}
