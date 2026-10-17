import { buildBdxExport, buildBdxExportWithPlannerResults } from "./bdx";
import { DEFAULT_SAMPLES_PER_SEGMENT } from "../planners/limits";
import { robotInvocationErrors, validateProjectRobotInvocations } from "../robotCommands";
import { activeRoutine } from "../project/routines";
import { orderedWaypointSampleIndices } from "../planners/waypointSamples";
import type { BordeauxProject, CommandInvocation, FollowMode, Marker, RobotCommandCatalog, PathDoc, RoutineFallbackNode, RoutineNode, TrajectorySample } from "../types";

const MAX_SAMPLE_COUNT = 100_000;
const MAX_EVENT_COUNT = 2_000;
const MAX_PATH_COUNT = 64;
const MAX_ROUTINE_NODE_COUNT = 2_000;
const MAX_JSON_NESTING_DEPTH = 40;
const MAX_EXPORT_BYTES = 16 * 1024 * 1024;

export interface RobotTrajectoryEvent {
  eventId: string;
  name: string;
  timeS: number;
  fraction: number;
  commandId: string;
  arguments: CommandInvocation["arguments"];
  cancelOnPathEnd: boolean;
  trigger: "time" | "position";
  repeatEveryS?: number;
  endTimeS?: number;
  conditionId?: string;
}

export interface RobotTrajectoryPath {
  id: string;
  name: string;
  planner: string;
  totalTimeS: number;
  totalDistanceM: number;
  samples: TrajectorySample[];
  followSections: RobotFollowSection[];
  events: RobotTrajectoryEvent[];
}

export interface RobotFollowSection {
  segmentIndex: number;
  mode: FollowMode;
  startSample: number;
  endSample: number;
}

export interface RobotTrajectoryDocument {
  generator: "bordeaux";
  catalog: {
    schemaVersion: "1.0" | "1.1" | "1.2" | "1.3";
    catalogId: string;
    supportVersion: string;
    catalogHash: string;
  };
  units: {
    distance: "meters";
    time: "seconds";
    angle: "radians";
    velocity: "meters_per_second";
    acceleration: "meters_per_second_squared";
  };
  field: ReturnType<typeof buildBdxExport>["field"];
  robot: ReturnType<typeof buildBdxExport>["robot"];
  routine: RobotTrajectoryRoutine | null;
  paths: RobotTrajectoryPath[];
}

interface RobotTrajectoryRoutine {
  name: string;
  nodes: RoutineNode[];
}

export interface BuiltRobotTrajectory {
  document: RobotTrajectoryDocument;
  pathCount: number;
  eventCount: number;
  sampleCount: number;
}

function followSections(
  path: PathDoc,
  samples: readonly TrajectorySample[],
  waypointSampleIndices?: readonly number[],
): RobotFollowSection[] {
  const boundaries = waypointSampleIndices?.length === path.waypoints.length
    ? waypointSampleIndices
    : orderedWaypointSampleIndices(path.waypoints, samples);
  const sections: RobotFollowSection[] = [];
  path.waypoints.slice(0, -1).forEach((waypoint, segmentIndex) => {
    const start = boundaries[segmentIndex];
    const end = boundaries[segmentIndex + 1];
    let departure = start;
    while (departure + 1 < end && Math.abs(samples[departure + 1].s - samples[start].s) < 1e-7) departure += 1;
    if (departure > start) sections.push({ segmentIndex, mode: "time", startSample: start, endSample: departure });
    sections.push({
      segmentIndex,
      mode: waypoint.segmentFollowMode ?? path.followMode ?? "time",
      startSample: departure,
      endSample: end,
    });
  });
  const arrival = boundaries.at(-1)!;
  if (arrival < samples.length - 1) sections.push({
    segmentIndex: Math.max(0, path.waypoints.length - 2),
    mode: "time",
    startSample: arrival,
    endSample: samples.length - 1,
  });
  return sections;
}

function serializedByteLengthAtMost(value: unknown, limit: number): number {
  let bytes = 0;
  const add = (count: number): boolean => {
    bytes += count;
    return bytes <= limit;
  };
  const visit = (item: unknown, arrayItem = false): boolean => {
    if (item === undefined || typeof item === "function" || typeof item === "symbol") {
      return arrayItem ? add(4) : true;
    }
    if (item === null || typeof item === "boolean") return add(item === null ? 4 : item ? 4 : 5);
    if (typeof item === "number") return add(Buffer.byteLength(Number.isFinite(item) ? String(item) : "null", "utf8"));
    if (typeof item === "string") return add(Buffer.byteLength(JSON.stringify(item), "utf8"));
    if (typeof item === "bigint") throw new TypeError("Cannot serialize BigInt in a Robot trajectory");
    if (Array.isArray(item)) {
      if (!add(1)) return false;
      for (let index = 0; index < item.length; index += 1) {
        if (index > 0 && !add(1)) return false;
        if (!visit(item[index], true)) return false;
      }
      return add(1);
    }
    if (!add(1)) return false;
    let first = true;
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      if (child === undefined || typeof child === "function" || typeof child === "symbol") continue;
      if (!first && !add(1)) return false;
      first = false;
      if (!add(Buffer.byteLength(JSON.stringify(key), "utf8") + 1) || !visit(child)) return false;
    }
    return add(1);
  };
  visit(value);
  return bytes;
}

function assertExportSize(value: unknown): void {
  if (serializedByteLengthAtMost(value, MAX_EXPORT_BYTES) > MAX_EXPORT_BYTES) {
    throw new Error(`Robot trajectory export exceeds ${MAX_EXPORT_BYTES} bytes`);
  }
}

function assertJsonNestingDepth(value: unknown): void {
  const visit = (item: unknown, depth: number): void => {
    if (item === null || typeof item !== "object") return;
    const nextDepth = depth + 1;
    if (nextDepth > MAX_JSON_NESTING_DEPTH) {
      throw new Error(`Robot trajectory export exceeds JSON nesting depth of ${MAX_JSON_NESTING_DEPTH}`);
    }
    const children = Array.isArray(item) ? item : Object.values(item as Record<string, unknown>);
    children.forEach((child) => visit(child, nextDepth));
  };
  visit(value, 0);
}

function deployableRoutine(project: BordeauxProject, pathIds: Set<string>): RobotTrajectoryRoutine | null {
  const routine = activeRoutine(project);
  if (!routine) return null;
  let nodeCount = 0;
  function nodes(source: RoutineFallbackNode[]): RoutineFallbackNode[];
  function nodes(source: RoutineNode[]): RoutineNode[];
  function nodes(source: RoutineNode[]): RoutineNode[] {
    return source.map((node) => {
      nodeCount += 1;
      if (nodeCount > MAX_ROUTINE_NODE_COUNT) throw new Error(`Robot trajectory export exceeds ${MAX_ROUTINE_NODE_COUNT} routine nodes`);
      if (node.type === "repeat" || node.type === "end" || ("ends" in node && node.ends !== undefined)) {
        throw new Error(`Routine step ${node.id} uses local repeat/end/ending conditions; robot execution support is not available yet`);
      }
      if ("outputBranch" in node && node.outputBranch !== undefined) {
        throw new Error(`Routine command ${node.id} branches on an output; robot execution support is not available yet`);
      }
      if (node.type === "path") {
        if (!pathIds.has(node.ref)) throw new Error(`Routine path ${node.ref} is not exportable`);
        return { id: node.id, type: "path", ref: node.ref };
      }
      if (node.type === "decision") {
        if (!/^[A-Za-z0-9_.:#()$,-]{1,256}$/.test(node.cond)) throw new Error(`Routine decision ${node.id} needs a stable condition ID`);
        return { id: node.id, type: "decision", cond: node.cond, thenLabel: node.thenLabel, elseLabel: node.elseLabel, then: nodes(node.then), else: nodes(node.else) };
      }
      if (node.type === "builtin") {
        if (node.builtinId !== "bordeaux.wait" || !Number.isFinite(node.arguments.durationS) || node.arguments.durationS < 0.02 || node.arguments.durationS > 15
          || Object.keys(node.arguments).length !== 1) {
          throw new Error(`Routine built-in ${node.id} is invalid for Robot export`);
        }
        return { id: node.id, type: "builtin", builtinId: "bordeaux.wait", arguments: { durationS: node.arguments.durationS } };
      }
      if (node.type === "generatedTrajectory") {
        return {
          id: node.id,
          type: "generatedTrajectory",
          generatorId: node.generatorId,
          arguments: node.arguments,
          fallback: node.fallback.type === "safeStop"
            ? { type: "safeStop" }
            : { type: "branch", nodes: nodes(node.fallback.nodes) },
        };
      }
      if (node.cat !== "command" || !node.invocation) {
        throw new Error(`Routine function ${node.id} is simulation-only; use a bound Command step for Robot export`);
      }
      return { id: node.id, type: "function", cat: "command", title: node.title, invocation: node.invocation };
    });
  }
  return { name: routine.name, nodes: nodes(routine.nodes) };
}

function assertRoutineNodeCount(routine: RobotTrajectoryRoutine | null): void {
  if (!routine) return;
  let count = 0;
  const pending = [...routine.nodes];
  while (pending.length > 0) {
    const node = pending.pop()!;
    count += 1;
    if (count > MAX_ROUTINE_NODE_COUNT) {
      throw new Error(`Robot trajectory export exceeds ${MAX_ROUTINE_NODE_COUNT} routine nodes`);
    }
    if (node.type === "repeat") pending.push(...node.nodes);
    if (node.type === "decision") pending.push(...node.then, ...node.else);
    if (node.type === "generatedTrajectory" && node.fallback.type === "branch") pending.push(...node.fallback.nodes);
  }
}

// Only actual inspected defaults are filled in; missing required values remain validation errors.
function withArgumentDefaults(project: BordeauxProject, catalog: RobotCommandCatalog): BordeauxProject {
  const commands = new Map(catalog.commands.map((command) => [command.id, command]));
  const markerWithDefaults = (marker: Marker): Marker => {
    const command = marker.invocation && commands.get(marker.invocation.commandId);
    if (!marker.invocation || !command) return marker;
    const defaults = Object.fromEntries(command.parameters
      .filter((parameter) => parameter.role === "argument" && parameter.defaultValue !== undefined)
      .map((parameter) => [parameter.name, parameter.defaultValue!]));
    return { ...marker, invocation: { ...marker.invocation, arguments: { ...defaults, ...marker.invocation.arguments } } };
  };
  return { ...project, paths: project.paths.map((path) => ({ ...path, markers: path.markers.map(markerWithDefaults) })) };
}

function projectForStaticPlanning(project: BordeauxProject): BordeauxProject {
  const staticNodes = (nodes: RoutineNode[]): RoutineNode[] => nodes.flatMap((node) => {
    if (node.type === "generatedTrajectory") return node.fallback.type === "branch" ? staticNodes(node.fallback.nodes) : [];
    if (node.type === "repeat") return staticNodes(node.nodes);
    if (node.type === "end") return [];
    if (node.type === "decision") return [{ ...node, then: staticNodes(node.then), else: staticNodes(node.else) }];
    return [node];
  });
  return { ...project, routines: project.routines.map((routine) => ({ ...routine, nodes: staticNodes(routine.nodes) })) };
}

/** Compile the shared model; executable binding trust belongs to the calling export boundary. */
export function buildRobotTrajectory(
  project: BordeauxProject,
  catalog: RobotCommandCatalog,
  options: { requireGeneratedBindings?: boolean; materializeArgumentDefaults?: boolean } = {},
): BuiltRobotTrajectory {
  // Defaults change only validated and emitted invocations. Planning keeps the authored
  // markers, which are part of an applied optimization's input identity.
  const compiled = options.materializeArgumentDefaults ? withArgumentDefaults(project, catalog) : project;
  const invocationIssues = validateProjectRobotInvocations(compiled, catalog, options.requireGeneratedBindings ? robotInvocationErrors : undefined);
  if (invocationIssues.length > 0) throw new Error(invocationIssues.map((item) => `${item.path}: ${item.message}`).join("\n"));
  const sourcePaths = compiled.paths.filter((path) => path.exportable !== false);
  if (sourcePaths.length === 0) throw new Error("Robot trajectory export requires at least one exportable path");
  if (sourcePaths.length > MAX_PATH_COUNT) {
    throw new Error(`Robot trajectory export exceeds ${MAX_PATH_COUNT} paths`);
  }
  let baseSampleCount = 0;
  for (const path of sourcePaths) {
    baseSampleCount += Math.max(0, path.waypoints.length - 1) * DEFAULT_SAMPLES_PER_SEGMENT + 1;
    if (baseSampleCount > MAX_SAMPLE_COUNT) throw new Error(`Robot trajectory export exceeds ${MAX_SAMPLE_COUNT} samples`);
  }
  let eventCount = 0;
  for (const path of sourcePaths) {
    eventCount += path.markers.reduce((count, marker) => count + (marker.invocation ? 1 : 0), 0);
    if (eventCount > MAX_EVENT_COUNT) throw new Error(`Robot trajectory export exceeds ${MAX_EVENT_COUNT} events`);
  }
  const routine = deployableRoutine(project, new Set(sourcePaths.map((path) => path.id)));
  if (routine && routine.nodes.some(function containsBuiltIn(node): boolean {
    return node.type === "builtin" || (node.type === "decision" && [...node.then, ...node.else].some(containsBuiltIn));
  }) && catalog.generatedSchemaVersion !== "1.2" && catalog.generatedSchemaVersion !== "1.3") {
    throw new Error("Routine built-ins require generated catalog schema 1.2 or newer before export");
  }
  assertRoutineNodeCount(routine);
  const preflightDocument = {
    catalog: {
      schemaVersion: catalog.generatedSchemaVersion ?? "1.3",
      catalogId: catalog.catalogId ?? "",
      supportVersion: catalog.supportVersion ?? "",
      catalogHash: catalog.catalogHash ?? "",
    },
    robot: project.robot,
    routine,
    paths: sourcePaths.map((path) => ({
      id: path.id,
      name: path.name,
      events: path.markers.flatMap((marker) => marker.invocation ? [{
        eventId: marker.id,
        name: marker.name,
        invocation: marker.invocation,
        schedule: marker.schedule,
      }] : []),
    })),
  };
  assertJsonNestingDepth(preflightDocument);
  assertExportSize(preflightDocument);

  // Static planning has no geometry for runtime-dynamic nodes. Their separately
  // validated fallback is sufficient for the generic project validator here;
  // the exported routine below retains the generated node itself.
  const { document: native, plannerResults } = buildBdxExportWithPlannerResults(projectForStaticPlanning(project));
  let sampleCount = 0;
  const paths: RobotTrajectoryPath[] = [];
  native.paths.forEach((path, pathIndex) => {
    sampleCount += path.samples.length;
    if (sampleCount > MAX_SAMPLE_COUNT) throw new Error(`Robot trajectory export exceeds ${MAX_SAMPLE_COUNT} samples`);
    // Planner markers keep authored order; applied optimizations are validated marker-by-marker.
    const sourceMarkers = sourcePaths[pathIndex].markers;
    const events = path.markers.flatMap((marker, markerIndex) => {
      const { invocation, schedule } = sourceMarkers[markerIndex];
      if (!invocation) return [];
      if (schedule?.endTimeS !== undefined && schedule.endTimeS < marker.timeS) {
        throw new Error(`Event ${marker.name} ends before it starts`);
      }
      return [{
        eventId: marker.id,
        name: marker.name,
        timeS: marker.timeS,
        fraction: marker.fraction,
        commandId: invocation.commandId,
        arguments: invocation.arguments,
        cancelOnPathEnd: invocation.cancelOnPathEnd === true,
        trigger: schedule?.trigger ?? "time",
        ...(schedule?.repeatEveryS === undefined ? {} : { repeatEveryS: schedule.repeatEveryS }),
        ...(schedule?.endTimeS === undefined ? {} : { endTimeS: schedule.endTimeS }),
        ...(schedule?.conditionId ? { conditionId: schedule.conditionId } : {}),
      }];
    }).sort((left, right) => left.timeS - right.timeS || (options.requireGeneratedBindings ? left.eventId.localeCompare(right.eventId) : 0));
    paths.push({
      id: path.id,
      name: path.name,
      planner: path.planner,
      totalTimeS: path.totalTimeS,
      totalDistanceM: path.totalDistanceM,
      samples: path.samples,
      followSections: followSections(sourcePaths[pathIndex], path.samples, plannerResults[pathIndex].waypointSampleIndices),
      events,
    });
  });
  const document: RobotTrajectoryDocument = {
    generator: "bordeaux",
    catalog: {
      schemaVersion: catalog.generatedSchemaVersion ?? "1.3",
      catalogId: catalog.catalogId ?? "",
      supportVersion: catalog.supportVersion ?? "",
      catalogHash: catalog.catalogHash ?? "",
    },
    field: native.field,
    units: native.units,
    robot: native.robot,
    routine,
    paths,
  };
  assertJsonNestingDepth(document);
  assertExportSize(document);
  return {
    document,
    pathCount: paths.length,
    eventCount,
    sampleCount,
  };
}
