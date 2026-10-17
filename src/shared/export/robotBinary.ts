import { createHash } from "node:crypto";
import type { BordeauxProject, RobotCommandCatalog, RobotCommandDescriptor, TrajectorySample } from "../types";
import { buildRobotTrajectory, type RobotTrajectoryDocument } from "./robotTrajectory";
import { buildCanonicalPathState } from "../planners/pathState";
import { BinaryWriter, encodeBinaryEnvelope, utf8, type BinaryKind } from "./binaryCodec";
import { densifyRobotSamples } from "./robotSamples";
import { portableFileStem } from "../portableFileName";
import { robotSchemaValueError } from "../robotCommands";

export interface BinarySelection { kind: BinaryKind; id: string }
export interface BdxParameterType { niType: string; choices?: string[] }
/** Host-resolved saved NI types, without any execution/readiness assertion. */
export interface BinaryBindings { catalog: RobotCommandCatalog; parameterTypes: Record<string, Record<string, BdxParameterType>>; definitionJson: string }
export interface BuiltRobotBinary {
  bytes: Uint8Array; sha256: string; document: RobotTrajectoryDocument; travelHeadings: number[];
  name: string; fileName: string; pathCount: number; eventCount: number; sampleCount: number;
}
const bounded = (value: number, min: number, max: number, label: string) => {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${label} is outside [${min}, ${max}]`);
};
const count = (value: number, min: number, max: number, label: string) => { bounded(value, min, max, label); if (!Number.isInteger(value)) throw new Error(`${label} must be integral`); };
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
const sampleFields: Array<keyof TrajectorySample> = ["t", "s", "f", "x", "y", "headingRad", "velocityMps", "accelerationMps2", "angularVelocityRadps", "curvatureInvM"];
const DYNAMIC_WRAPPER_PROTOCOL = "bordeaux-dynamic-wrappers/1";

// Inspection paths are portable Windows or POSIX paths; never derive identity from labels.
const commandBasename = (command: RobotCommandDescriptor) => command.labviewConnector?.file.split(/[\\/]/).at(-1) ?? "";

function resolveCommand(catalog: RobotCommandCatalog, commandId: string, eventName: string) {
  const matches = catalog.commands.filter((command) => command.id === commandId);
  const context = `Event ${eventName}: command ${commandId}`;
  if (matches.length !== 1) throw new Error(`${context} is ${matches.length ? "ambiguous" : "missing"} in the linked LabVIEW project. Inspect commands before exporting BDX.`);
  const command = matches[0], name = commandBasename(command);
  if (!/^.+\.vi$/i.test(name)) throw new Error(`${context} has no inspected original VI filename. Inspect the linked LabVIEW project before exporting BDX.`);
  // The runtime receives only a basename, so distinct folders/targets cannot disambiguate it.
  const collisions = catalog.commands.filter((candidate) => commandBasename(candidate).toLowerCase() === name.toLowerCase());
  if (collisions.length !== 1) throw new Error(`${context} has ambiguous runtime VI basename ${name}: ${collisions.map((candidate) => `${candidate.id} (${candidate.labviewConnector!.target}/${candidate.labviewConnector!.file})`).join(", ")}`);
  return { command, name };
}

export function encodeBdxArgument(type: BdxParameterType, value: unknown): { tag: number; bytes: Buffer } {
  const writer = new BinaryWriter(65536);
  const integerTypes: Record<string, [number, 1 | 2 | 4 | 8, boolean]> = {
    I8: [2, 1, true], U8: [3, 1, false], I16: [4, 2, true], U16: [5, 2, false], I32: [6, 4, true], U32: [7, 4, false], I64: [8, 8, true], U64: [9, 8, false],
  };
  let tag: number;
  if (type.niType === "Boolean") { if (typeof value !== "boolean") throw new Error("NI Boolean requires a Boolean value"); tag = 1; writer.integer(value ? 1 : 0, 1); }
  else if (integerTypes[type.niType]) {
    const [typeTag, width, signed] = integerTypes[type.niType]; tag = typeTag;
    if (width === 8 && typeof value !== "string") throw new Error(`NI ${type.niType} requires an exact decimal string`);
    if (typeof value === "string"
      ? robotSchemaValueError(value, { kind: "integerString", valueType: type.niType }) !== null
      : typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`NI ${type.niType} requires an exact integer`);
    writer.integer(BigInt(value as string | number), width, signed);
  } else if (type.niType === "SGL" || type.niType === "DBL") {
    tag = type.niType === "SGL" ? 10 : 11; if (typeof value !== "number") throw new Error(`NI ${type.niType} requires a number`); writer.dbl(value, tag === 10);
  } else if (type.niType === "String") { tag = 12; writer.bytes(utf8(value as string, 65536, "NI string argument", true, true)); }
  else if (["EB", "EW", "EL"].includes(type.niType)) {
    const choices = type.choices;
    if (!choices?.length || new Set(choices).size !== choices.length || typeof value !== "string" || !choices.includes(value)) throw new Error("NI enum value does not match its inspected choices");
    tag = type.niType === "EB" ? 13 : type.niType === "EW" ? 14 : 15;
    writer.integer(choices.indexOf(value), tag === 13 ? 1 : tag === 14 ? 2 : 4);
  } else throw new Error(`NI ${type.niType} arguments are not supported by BDX v1; a command-specific adapter is required`);
  return { tag, bytes: writer.finish() };
}
/** ASCII-only, as robot uploads require, and at most 80 characters before `.bdx`. */
export function binaryFileName(name: string): string {
  const base = name.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[._-]+|[._-]+$/g, "").slice(0, 80) || "Bordeaux";
  return `${portableFileStem(base, 80)}.bdx`;
}

/** Compile exactly one path into the direct-VI BDX layout. Saving never connects to a robot. */
export function buildRobotBinary(project: BordeauxProject, selection: BinarySelection, bindings: BinaryBindings): BuiltRobotBinary {
  utf8(selection.id, 256, "Selected path ID");
  if (selection.kind !== "path") throw new Error("Only standalone BDX paths are supported");
  const matches = project.paths.filter((path) => path.id === selection.id);
  if (matches.length !== 1) throw new Error("Selected path is missing or has an ambiguous ID");
  const { folderId: _folderId, ...selected } = matches[0];
  if (selected.exportable === false) throw new Error(`${selected.name} is not exportable`);
  if (project.robot.drive !== "swerve") throw new Error("BDX v1 currently supports swerve paths only");
  const commands = new Map<string, ReturnType<typeof resolveCommand>>();
  for (const marker of selected.markers) {
    if (marker.group && marker.group !== "sequential") throw new Error(`Event ${marker.name}: ${marker.group} groups are not supported by standalone BDX`);
    if (marker.schedule?.trigger && marker.schedule.trigger !== "time") throw new Error(`Event ${marker.name}: only time-triggered markers are supported by ${DYNAMIC_WRAPPER_PROTOCOL}`);
    if (marker.schedule?.conditionId) throw new Error(`Event ${marker.name}: conditional markers are not supported by ${DYNAMIC_WRAPPER_PROTOCOL}`);
    if (marker.invocation?.cancelOnPathEnd) throw new Error(`Event ${marker.name}: CancelOnPathEnd must be false; automatic command cancellation is not supported by ${DYNAMIC_WRAPPER_PROTOCOL}`);
    if (marker.invocation && !commands.has(marker.invocation.commandId)) commands.set(marker.invocation.commandId, resolveCommand(bindings.catalog, marker.invocation.commandId, marker.name));
    if (marker.invocation && !bindings.parameterTypes[marker.invocation.commandId]) throw new Error(`Command ${marker.invocation.commandId} has no saved NI parameter type evidence. Inspect the linked LabVIEW project before exporting BDX.`);
  }
  // Empty wire condition IDs mean unconditional; generic authoring validation uses absence.
  selected.markers = selected.markers.map((marker) => {
    if (marker.schedule?.conditionId !== "") return marker;
    const { conditionId: _conditionId, ...schedule } = marker.schedule;
    return { ...marker, schedule };
  });
  const planningRoutine = { id: "binary-path-only", name: "Path only", nodes: [] };
  const scoped = { ...project, paths: [selected], routines: [planningRoutine], activeRoutineId: planningRoutine.id, pathFolders: undefined, editor: undefined, strategy: undefined, pathLinks: [] };
  const built = buildRobotTrajectory(scoped, bindings.catalog, { materializeArgumentDefaults: true }), document = built.document;
  document.routine = null;
  const path = document.paths[0];
  if (path.followSections.some((section) => section.mode !== "time")) throw new Error(`Path ${path.name}: position-follow sections are not supported by ${DYNAMIC_WRAPPER_PROTOCOL}`);
  const sampled = densifyRobotSamples(path.samples, buildCanonicalPathState(selected, path.samples).points.map((point) => point.tangentRad));
  path.samples = sampled.samples;
  path.followSections = path.followSections.map((section) => ({ ...section,
    startSample: sampled.sourceIndices[section.startSample], endSample: sampled.sourceIndices[section.endSample],
  }));
  const travelHeadings = sampled.travelHeadings;
  count(path.samples.length, 2, 100000, "Sample count"); count(path.events.length, 0, 2000, "Event count"); count(path.followSections.length, 1, 4096, "Follow section count");
  bounded(path.totalTimeS, 0, Number.MAX_VALUE, "Path duration"); bounded(path.totalDistanceM, 0, Number.MAX_VALUE, "Path distance");
  for (const value of [document.robot.widthM, document.robot.lengthM, document.robot.maxSpeedMps]) if (!(value > 0 && Number.isFinite(value))) throw new Error("BDX robot dimensions and maximum speed must be positive and finite");
  const metadata = new BinaryWriter(65536);
  metadata.text(path.id, "Path ID"); metadata.text(path.name, "Path name", 1024); metadata.text(path.planner, "Planner ID");
  metadata.text(document.field.id, "Field ID"); metadata.text(document.field.revision, "Field revision"); metadata.text(document.field.coordinateSchemaId, "Coordinate schema");
  metadata.text(path.events.length ? DYNAMIC_WRAPPER_PROTOCOL : "", "Command protocol ID", 256, !path.events.length);
  metadata.text(path.events.length ? bindings.catalog.catalogHash ?? "" : "", "NI catalog hash", 256, !path.events.length);
  metadata.integer(0, 2); metadata.integer(0, 2);
  for (const value of [path.totalTimeS, path.totalDistanceM, document.robot.widthM, document.robot.lengthM, document.robot.maxSpeedMps]) metadata.dbl(value);
  const payload = new BinaryWriter(); payload.section(metadata); payload.integer(path.samples.length, 4);
  path.samples.forEach((sample, index) => {
    if (sample.i !== index || sampleFields.some((key) => !Number.isFinite(sample[key]))) throw new Error("BDX sample values/indexes are invalid");
    bounded(sample.f, 0, 1, "Sample fraction"); bounded(sample.velocityMps, 0, document.robot.maxSpeedMps + 1e-9, "Sample speed");
    const before = path.samples[index - 1];
    if (index === 0 && (sample.t !== 0 || sample.s !== 0) || before && (sample.t < before.t || sample.s < before.s || sample.f < before.f)) throw new Error("BDX sample time, distance and fraction must be nondecreasing and start at zero time/distance");
    if (before && sample.t === before.t && sampleFields.some((key) => key !== "t" && !close(sample[key], before[key]))) throw new Error("Equal-time BDX samples must have equivalent pose, distance, fraction and dynamics");
    if (path.totalTimeS === 0 && (sample.velocityMps !== 0 || sample.angularVelocityRadps !== 0 || !close(sample.s, 0) || !close(sample.x, path.samples[0].x) || !close(sample.y, path.samples[0].y) || !close(sample.headingRad, path.samples[0].headingRad))) throw new Error("A zero-duration BDX must be stationary");
    for (const value of [sample.t, sample.s, sample.f, sample.x, sample.y, sample.headingRad, travelHeadings[index], sample.velocityMps, sample.accelerationMps2, sample.angularVelocityRadps, sample.curvatureInvM]) payload.dbl(value);
  });
  const last = path.samples.at(-1)!;
  if (!close(last.t, path.totalTimeS) || !close(last.s, path.totalDistanceM)) throw new Error("BDX totals do not match the last sample");
  payload.integer(path.followSections.length, 4);
  let end = 0;
  for (const section of path.followSections) {
    if (section.startSample !== end || section.endSample < end || section.endSample >= path.samples.length || !["time", "position"].includes(section.mode)) throw new Error("BDX follow sections must cover contiguous sample ranges");
    payload.integer(section.segmentIndex, 4); payload.integer(section.startSample, 4); payload.integer(section.endSample, 4); payload.integer(section.mode === "time" ? 0 : 1, 2); payload.integer(0, 2); end = section.endSample;
  }
  if (end !== path.samples.length - 1) throw new Error("BDX follow sections must cover every sample");
  payload.integer(path.events.length, 4); const eventIds = new Set<string>();
  for (const event of path.events) {
    if (eventIds.has(event.eventId)) throw new Error(`Duplicate BDX event ID ${event.eventId}`); eventIds.add(event.eventId);
    bounded(event.timeS, 0, path.totalTimeS, "Event time"); bounded(event.fraction, 0, 1, "Event fraction");
    if (event.repeatEveryS !== undefined && !(event.repeatEveryS > 0 && Number.isFinite(event.repeatEveryS))) throw new Error("Event repeat interval must be positive");
    if (event.endTimeS !== undefined) bounded(event.endTimeS, event.timeS, path.totalTimeS, "Event end time");
    const output = new BinaryWriter();
    const resolved = commands.get(event.commandId);
    if (!resolved) throw new Error(`Event ${event.name}: command ${event.commandId} has no resolved inspected VI`);
    output.text(event.eventId, "Event ID"); output.text(event.name, "Event name", 1024); output.text(resolved.name, "Runtime command VI basename"); output.text(event.conditionId ?? "", "Condition ID", 256, true);
    for (const value of [event.timeS, event.fraction, event.repeatEveryS ?? 0, event.endTimeS ?? -1]) output.dbl(value);
    output.integer(event.trigger === "time" ? 0 : 1, 1); output.integer(event.cancelOnPathEnd ? 1 : 0, 1); output.integer(0, 2);
    const args = Object.entries(event.arguments); count(args.length, 0, 64, "Event argument count"); output.integer(args.length, 4);
    for (const [key, value] of args) {
      const type = bindings.parameterTypes[event.commandId]?.[key];
      if (!type) throw new Error(`Command ${event.commandId}.${key} has no saved NI type evidence`);
      const argument = encodeBdxArgument(type, value);
      output.text(key, "Argument key"); output.integer(argument.tag, 2); output.integer(0, 2); output.integer(argument.bytes.length, 4); output.bytes(argument.bytes);
    }
    payload.section(output);
  }
  const bytes = encodeBinaryEnvelope(payload.finish());
  return { bytes, document, travelHeadings, sha256: createHash("sha256").update(bytes).digest("hex"), name: selected.name,
    fileName: binaryFileName(selected.name), pathCount: 1, eventCount: path.events.length, sampleCount: path.samples.length };
}
