/**
 * Reads a BDX path file back into values: the inverse of buildRobotBinary (robotBinary.ts), for BDX 1.0 to 1.2.
 *
 * The bytes may come from a robot's disk, so nothing in them is trusted. decodeBdx either returns exactly what the
 * file says or throws an Error that names what is wrong. It checks the envelope, the layout and every code; it does
 * not re-check the motion rules the writer and the robot's reader enforce (increasing time, follow sections that
 * cover every sample, event times inside the path).
 */
import { utf8Bytes } from "../bytes";
import type { PathLoopUntil } from "../markerCommands";
import type { TrajectorySample } from "../types";
import { MAX_BINARY_PAYLOAD_BYTES, crc32 } from "./binaryCodec";
import type { ModuleForcesN } from "./moduleForces";
import type { RobotFollowSection, RobotTrajectoryEvent, RobotTrajectoryPath } from "./robotTrajectory";

/** 1.0 has 88-byte samples without forces; 1.1 adds four module forces per sample; 1.2 adds a loop and a group per event. */
export type BdxMinor = 0 | 1 | 2;

export interface DecodedBdxSample extends TrajectorySample {
  /** The direction the robot moves; `headingRad` is the direction it faces. */
  travelHeadingRad: number;
  /** Absent in a 1.0 file. */
  moduleForcesN?: ModuleForcesN;
}

/** Argument type tags 1 to 15, in tag order. */
const NI_TYPES = ["Boolean", "I8", "U8", "I16", "U16", "I32", "U32", "I64", "U64", "SGL", "DBL", "String", "EB", "EW", "EL"] as const;
type NiType = (typeof NI_TYPES)[number];
const NI_BYTES: Record<Exclude<NiType, "String">, number> = { Boolean: 1, I8: 1, U8: 1, I16: 2, U16: 2, I32: 4, U32: 4, I64: 8, U64: 8, SGL: 4, DBL: 8, EB: 1, EW: 2, EL: 4 };

/**
 * An argument as encodeBdxArgument takes it: 64-bit integers are exact decimal strings. An enum is the exception.
 * The file holds only the choice's index, and its label is in the LabVIEW command list.
 */
export type DecodedBdxValue =
  | { niType: "Boolean"; value: boolean }
  | { niType: "I8" | "U8" | "I16" | "U16" | "I32" | "U32" | "SGL" | "DBL"; value: number }
  | { niType: "I64" | "U64" | "String"; value: string }
  | { niType: "EB" | "EW" | "EL"; choiceIndex: number };
export type DecodedBdxArgument = { key: string } & DecodedBdxValue;

/** A written event. `vi` is the command VI's file name; a BDX names commands by VI, never by the project's command ID. */
export interface DecodedBdxEvent extends Omit<RobotTrajectoryEvent, "commandId" | "arguments" | "loop"> {
  vi: string;
  /** In file order. */
  arguments: DecodedBdxArgument[];
  loop?: PathLoopUntil;
}

export interface DecodedBdx extends Omit<RobotTrajectoryPath, "samples" | "events"> {
  minor: BdxMinor;
  field: { id: string; revision: string; coordinateSchemaId: string };
  robot: { widthM: number; lengthM: number; maxSpeedMps: number };
  /** Both empty when the path has no events. */
  commandProtocolId: string;
  catalogHash: string;
  samples: DecodedBdxSample[];
  events: DecodedBdxEvent[];
}

const MAGIC = utf8Bytes("BDXLV1\r\n");
const HEADER_BYTES = 32;
const malformed = (detail: string) => new Error(`BDX file is malformed: ${detail}`);
// ignoreBOM keeps a leading U+FEFF, as the writer's round-trip check requires.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function utf8Text(bytes: Uint8Array, label: string): string {
  try { return strictUtf8.decode(bytes); } catch { throw malformed(`${label} is not UTF-8`); }
}

/** A bounds-checked, big-endian cursor: BinaryWriter's counterpart. Every read names what it was reading. */
class BinaryReader {
  private readonly view: DataView;
  private offset = 0;
  // A Uint8Array may be a window into a larger buffer; the view starts where the window does.
  constructor(private readonly data: Uint8Array) { this.view = new DataView(data.buffer, data.byteOffset, data.byteLength); }
  private take(size: number, label: string): number {
    if (size > this.data.length - this.offset) throw malformed(`${label} runs past the end`);
    const start = this.offset;
    this.offset += size;
    return start;
  }
  u8(label: string): number { return this.view.getUint8(this.take(1, label)); }
  u16(label: string): number { return this.view.getUint16(this.take(2, label)); }
  u32(label: string): number { return this.view.getUint32(this.take(4, label)); }
  dbl(label: string): number {
    const value = this.view.getFloat64(this.take(8, label));
    if (!Number.isFinite(value)) throw malformed(`${label} is not finite`);
    return value;
  }
  bytes(size: number, label: string): Uint8Array {
    const start = this.take(size, label);
    return this.data.subarray(start, start + size);
  }
  text(label: string): string { return utf8Text(this.bytes(this.u32(label), label), label); }
  /** How many records follow, refused when that many of `recordBytes` each cannot fit, before anything is allocated. */
  count(recordBytes: number, label: string): number {
    const count = this.u32(label);
    if (count > (this.data.length - this.offset) / recordBytes) throw malformed(`${count} ${label} do not fit in the file`);
    return count;
  }
  /** A length-prefixed section as its own reader, so a read cannot leave it. */
  section(label: string): BinaryReader { return new BinaryReader(this.bytes(this.u32(label), label)); }
  /** Every section must be read to its last byte. */
  end(label: string): void {
    if (this.offset !== this.data.length) throw malformed(`${this.data.length - this.offset} unread bytes after ${label}`);
  }
}

/** The inverse of encodeBdxArgument, given the tag and bytes it produced. */
export function decodeBdxArgument(tag: number, bytes: Uint8Array): DecodedBdxValue {
  const niType: NiType | undefined = NI_TYPES[tag - 1];
  if (!niType) throw malformed(`argument type ${tag} is unknown`);
  if (niType === "String") return { niType, value: utf8Text(bytes, "a string argument") };
  if (bytes.length !== NI_BYTES[niType]) throw malformed(`a ${niType} argument has length ${bytes.length}, not ${NI_BYTES[niType]}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const finite = (value: number) => {
    if (!Number.isFinite(value)) throw malformed(`a ${niType} argument is not finite`);
    return value;
  };
  switch (niType) {
    case "Boolean": {
      const value = view.getUint8(0);
      if (value > 1) throw malformed(`a Boolean argument is ${value}, not 0 or 1`);
      return { niType, value: value === 1 };
    }
    case "I8": return { niType, value: view.getInt8(0) };
    case "U8": return { niType, value: view.getUint8(0) };
    case "I16": return { niType, value: view.getInt16(0) };
    case "U16": return { niType, value: view.getUint16(0) };
    case "I32": return { niType, value: view.getInt32(0) };
    case "U32": return { niType, value: view.getUint32(0) };
    case "I64": return { niType, value: view.getBigInt64(0).toString() };
    case "U64": return { niType, value: view.getBigUint64(0).toString() };
    case "SGL": return { niType, value: finite(view.getFloat32(0)) };
    case "DBL": return { niType, value: finite(view.getFloat64(0)) };
    case "EB": return { niType, choiceIndex: view.getUint8(0) };
    case "EW": return { niType, choiceIndex: view.getUint16(0) };
    case "EL": return { niType, choiceIndex: view.getUint32(0) };
  }
}

/** The 1.2 fields at the end of an event: loop kind, group mode, group order, loop limit, group ID. */
function eventExtension(event: BinaryReader): Pick<DecodedBdxEvent, "loop" | "group"> {
  const loopKind = event.u8("loop kind"), groupMode = event.u8("group mode"), order = event.u16("group order");
  const limit = event.dbl("loop limit"), id = event.text("group ID");
  if (loopKind > 3) throw malformed(`loop kind ${loopKind} is unknown`);
  if (groupMode > 2) throw malformed(`group mode ${groupMode} is unknown`);
  if (groupMode === 0 && (order !== 0 || id)) throw malformed("ungrouped event has group fields");
  if ((loopKind === 0 || loopKind === 3) && limit !== 0) throw malformed("unexpected loop limit");
  const loop: PathLoopUntil | undefined = loopKind === 1 ? { kind: "time", seconds: limit } : loopKind === 2 ? { kind: "distance", meters: limit }
    : loopKind === 3 ? { kind: "pathEnd" } : undefined;
  return { ...(loop ? { loop } : {}), ...(groupMode ? { group: { id, mode: groupMode === 1 ? "parallel" : "sequential", order } } : {}) };
}

/**
 * Decodes one .bdx file. Throws when the bytes are not a BDX, are from a newer Bordeaux, are cut short or damaged,
 * or do not follow the layout. `bytes` is only read.
 */
export function decodeBdx(bytes: Uint8Array): DecodedBdx {
  if (MAGIC.some((byte, index) => bytes[index] !== byte)) throw new Error("This is not a BDX path file");
  if (bytes.length < HEADER_BYTES) throw new Error(`BDX file is cut short: it holds ${bytes.length} of its ${HEADER_BYTES} header bytes`);
  const header = new DataView(bytes.buffer, bytes.byteOffset, HEADER_BYTES);
  const major = header.getUint16(8), minor = header.getUint16(10);
  // The version decides the layout, so it is checked before anything is read with it.
  if (major !== 1 || (minor !== 0 && minor !== 1 && minor !== 2)) throw new Error(`BDX version ${major}.${minor} is newer than this Bordeaux reads`);
  if (header.getUint32(12) !== HEADER_BYTES) throw malformed(`its header is ${header.getUint32(12)} bytes, not ${HEADER_BYTES}`);
  if (header.getUint32(24) !== 0 || header.getUint32(28) !== 0) throw malformed("its header flags are not zero");
  const declared = header.getUint32(16), present = bytes.length - HEADER_BYTES;
  if (present < declared) throw new Error(`BDX file is cut short: it holds ${present} of ${declared} bytes`);
  if (present > declared) throw new Error(`BDX file has ${present - declared} extra bytes after its data`);
  if (declared > MAX_BINARY_PAYLOAD_BYTES) throw malformed("its data exceeds 16 MiB");
  const payload = bytes.subarray(HEADER_BYTES);
  if (crc32(payload) !== header.getUint32(20)) throw new Error("BDX file is damaged: its checksum does not match its contents");

  // From here every value is read in file order.
  const reader = new BinaryReader(payload), metadata = reader.section("metadata");
  const id = metadata.text("path ID"), name = metadata.text("path name"), planner = metadata.text("planner ID");
  const field = { id: metadata.text("field ID"), revision: metadata.text("field revision"), coordinateSchemaId: metadata.text("coordinate schema") };
  const commandProtocolId = metadata.text("command protocol ID"), catalogHash = metadata.text("catalog hash");
  const driveType = metadata.u16("drive type");
  if (driveType !== 0) throw malformed(`drive type ${driveType} is not supported`);
  if (metadata.u16("metadata flags") !== 0) throw malformed("metadata flags are not zero");
  const totalTimeS = metadata.dbl("path duration"), totalDistanceM = metadata.dbl("path distance");
  const robot = { widthM: metadata.dbl("robot width"), lengthM: metadata.dbl("robot length"), maxSpeedMps: metadata.dbl("robot maximum speed") };
  metadata.end("the metadata");

  const forces = minor > 0, value = () => reader.dbl("a sample value");
  const samples = Array.from({ length: reader.count(forces ? 120 : 88, "samples") }, (_, i): DecodedBdxSample => {
    const sample = { i, t: value(), s: value(), f: value(), x: value(), y: value(), headingRad: value(), travelHeadingRad: value(),
      velocityMps: value(), accelerationMps2: value(), angularVelocityRadps: value(), curvatureInvM: value() };
    return forces ? { ...sample, moduleForcesN: [value(), value(), value(), value()] } : sample;
  });

  const followSections = Array.from({ length: reader.count(16, "follow sections") }, (): RobotFollowSection => {
    const segmentIndex = reader.u32("a follow section"), startSample = reader.u32("a follow section"), endSample = reader.u32("a follow section");
    const mode = reader.u16("a follow mode");
    if (reader.u16("follow section flags") !== 0) throw malformed("follow section flags are not zero");
    if (mode > 1) throw malformed(`follow mode ${mode} is unknown`);
    return { segmentIndex, mode: mode === 0 ? "time" : "position", startSample, endSample };
  });

  // An event is at least its own length field; an argument is at least a key length, a tag, a reserved field and a value length.
  const events = Array.from({ length: reader.count(4, "events") }, (): DecodedBdxEvent => {
    const event = reader.section("an event");
    const eventId = event.text("event ID"), eventName = event.text("event name"), vi = event.text("command VI name"), conditionId = event.text("condition ID");
    const timeS = event.dbl("event time"), fraction = event.dbl("event fraction"), repeatEveryS = event.dbl("event repeat interval"), endTimeS = event.dbl("event end time");
    const trigger = event.u8("event trigger"), cancel = event.u8("cancel flag");
    if (event.u16("event flags") !== 0) throw malformed("event flags are not zero");
    if (trigger > 1) throw malformed(`event trigger ${trigger} is unknown`);
    if (cancel > 1) throw malformed(`an event's cancel flag is ${cancel}, not 0 or 1`);
    const args = Array.from({ length: event.count(12, "arguments") }, (): DecodedBdxArgument => {
      const key = event.text("argument key"), tag = event.u16("argument type");
      if (event.u16("argument flags") !== 0) throw malformed("argument flags are not zero");
      return { key, ...decodeBdxArgument(tag, event.bytes(event.u32("an argument"), "an argument value")) };
    });
    const extension = minor === 2 ? eventExtension(event) : {};
    event.end("an event");
    // The file writes 0 for no repeat, -1 for no end time and an empty string for no condition.
    return { eventId, name: eventName, vi, timeS, fraction, trigger: trigger === 0 ? "time" : "position", cancelOnPathEnd: cancel === 1,
      ...(repeatEveryS !== 0 ? { repeatEveryS } : {}), ...(endTimeS !== -1 ? { endTimeS } : {}), ...(conditionId ? { conditionId } : {}),
      arguments: args, ...extension };
  });
  reader.end("the last event");

  return { minor, id, name, planner, totalTimeS, totalDistanceM, field, robot, commandProtocolId, catalogHash, samples, followSections, events };
}
