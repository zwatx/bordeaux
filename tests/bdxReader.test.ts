/**
 * decodeBdx reads path files back from a robot, so its input is whatever is on that disk.
 *
 * Ways it can fail, each covered below:
 *  1. Field order or width drifts from the writer, so values come back shifted but plausible.
 *  2. A 1.0 file (88-byte samples, no forces) or a 1.2 file (loop and group fields per event) is read with the 1.1 layout.
 *  3. Precision is lost: a DBL, a 64-bit integer above 2^53, or multi-byte text.
 *  4. The bytes are a view into a larger buffer (Node pools small Buffers), and offsets are taken from the wrong start.
 *  5. The file is not a BDX: empty, a .bdr, the commands list.
 *  6. The file is from a newer Bordeaux whose layout this reader does not know.
 *  7. The file is cut short, has bytes appended, or was damaged in place.
 *  8. A count or a length inside a valid envelope lies, so a read runs off the end or allocates gigabytes.
 *  9. A section's declared length disagrees with its contents, or bytes are left unread.
 * 10. A code has a value this reader has no meaning for: drive type, follow mode, trigger, argument type, loop, group.
 * 11. An argument's byte count does not fit its type, or text is not UTF-8, or a number is not finite.
 *
 * Not checked here or by the reader: the motion rules the writer and the robot enforce (increasing time, follow
 * sections that cover every sample, event times inside the path).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { encodeBinaryEnvelope } from "../src/core/export/binaryCodec";
import { buildRobotBinary, encodeBdxArgument, type BdxParameterType } from "../src/core/export/robotBinary";
import { decodeBdx, decodeBdxArgument, type DecodedBdx, type DecodedBdxArgument, type DecodedBdxValue } from "../src/core/export/bdxReader";
import { COMMANDS_FILE_NAME, encodeCommandsFile } from "../src/core/export/commandsFile";
import { binaryWriterFixture } from "./fixtures/binaryWriterFixture";

type Fixture = ReturnType<typeof binaryWriterFixture>;
const build = (fixture: Fixture) => buildRobotBinary(fixture.project, { kind: "path", id: fixture.path.id }, fixture.bindings);

/** One parallel group whose first command loops for a time, and one single command that loops for a distance: BDX 1.2. */
function groupedFixture(): Fixture {
  const fixture = binaryWriterFixture(true), [first, second] = fixture.path.markers;
  const command = structuredClone(first.invocation!);
  first.commandGroup = { mode: "parallel", commands: [{ ...structuredClone(command), loop: { until: { kind: "time", seconds: 1.5 } } }, command] };
  delete first.invocation;
  delete second.schedule!.repeatEveryS;
  second.invocation!.loop = { until: { kind: "distance", meters: 0.5 } };
  return fixture;
}

const plainFixture = binaryWriterFixture(true), plain = build(plainFixture), grouped = build(groupedFixture());
/** The values binaryWriterFixture authors for every event, in wire order. */
const AUTHORED_ARGUMENTS: DecodedBdxArgument[] = [
  { key: "enabled", niType: "Boolean", value: true }, { key: "power", niType: "DBL", value: 0.125 }, { key: "count", niType: "I32", value: -12 },
  { key: "sequence", niType: "I64", value: "9007199254740993" }, { key: "mode", niType: "EW", choiceIndex: 1 }, { key: "label", niType: "String", value: "Café 🤖" },
];
const MODE_CHOICES = ["Idle", "Active"];

/** Payload offsets of each section, found by walking the published layout independently of the reader. */
function layout(payload: Buffer, minor: number) {
  const samples = 4 + payload.readUInt32BE(0);
  const follow = samples + 4 + payload.readUInt32BE(samples) * (minor === 0 ? 88 : 120);
  const events = follow + 4 + payload.readUInt32BE(follow) * 16;
  const eventStarts: number[] = [];
  for (let offset = events + 4, index = 0; index < payload.readUInt32BE(events); index++) { eventStarts.push(offset); offset += 4 + payload.readUInt32BE(offset); }
  return { pathId: 4, samples, firstSample: samples + 4, follow, firstFollow: follow + 4, events, eventStarts, event: (index: number) => eventLayout(payload, eventStarts[index]) };
}
function eventLayout(payload: Buffer, start: number) {
  let offset = start + 4;
  for (let text = 0; text < 4; text++) offset += 4 + payload.readUInt32BE(offset);
  const firstArgument = offset + 40, tag = firstArgument + 4 + payload.readUInt32BE(firstArgument);
  return { length: start, trigger: offset + 32, cancel: offset + 33, argumentCount: offset + 36, tag, value: tag + 8, end: start + 4 + payload.readUInt32BE(start) };
}

/**
 * A copy of `built` with `edit` applied to its payload and the header's length and CRC made to match, so each
 * refusal below is reached through a valid envelope.
 */
function withPayload(built: Uint8Array, edit: (payload: Buffer, at: ReturnType<typeof layout>) => Buffer | void): Uint8Array {
  const source = Buffer.from(built), minor = source.readUInt16BE(10) as 1 | 2, payload = Buffer.from(source.subarray(32));
  return encodeBinaryEnvelope(edit(payload, layout(payload, minor)) ?? payload, minor);
}
/** A copy of `built` with only header bytes changed; the CRC covers the payload alone. */
function withHeader(built: Uint8Array, edit: (header: Buffer) => void): Uint8Array {
  const copy = Buffer.from(built);
  edit(copy);
  return copy;
}

const sampleColumns = (bdx: DecodedBdx) => bdx.samples.map((sample) => [sample.t, sample.s, sample.f, sample.x, sample.y, sample.headingRad, sample.travelHeadingRad,
  sample.velocityMps, sample.accelerationMps2, sample.angularVelocityRadps, sample.curvatureInvM, ...(sample.moduleForcesN ?? [])]);

describe("reading a BDX file", () => {
  it("returns every field the writer wrote", () => {
    const decoded = decodeBdx(plain.bytes), document = plain.document, source = document.paths[0];
    expect(decoded.minor).toBe(1);
    expect([decoded.id, decoded.name, decoded.planner, decoded.totalTimeS, decoded.totalDistanceM]).toEqual([source.id, source.name, source.planner, source.totalTimeS, source.totalDistanceM]);
    expect(decoded.field).toEqual({ id: document.field.id, revision: document.field.revision, coordinateSchemaId: document.field.coordinateSchemaId });
    expect(decoded.robot).toEqual({ widthM: document.robot.widthM, lengthM: document.robot.lengthM, maxSpeedMps: document.robot.maxSpeedMps });
    expect([decoded.commandProtocolId, decoded.catalogHash]).toEqual(["bordeaux-dynamic-wrappers/1", plainFixture.bindings.catalog.catalogHash]);
    expect(decoded.samples.length).toBeGreaterThan(100);
    expect(decoded.samples.map((sample) => sample.i)).toEqual(source.samples.map((_, index) => index));
    expect(sampleColumns(decoded)).toEqual(source.samples.map((sample, index) => [sample.t, sample.s, sample.f, sample.x, sample.y, sample.headingRad, plain.travelHeadings[index],
      sample.velocityMps, sample.accelerationMps2, sample.angularVelocityRadps, sample.curvatureInvM, ...plain.moduleForcesN[index]]));
    expect(decoded.followSections).toEqual(source.followSections.map(({ segmentIndex, mode, startSample, endSample }) => ({ segmentIndex, mode, startSample, endSample })));
    expect(source.events).toHaveLength(2);
    expect(decoded.events).toEqual(source.events.map((event) => ({ eventId: event.eventId, name: event.name, vi: "TestOnly.vi", timeS: event.timeS, fraction: event.fraction,
      trigger: "time", cancelOnPathEnd: false, repeatEveryS: event.repeatEveryS, arguments: AUTHORED_ARGUMENTS })));
    // The second event repeats; the first does not, and neither has an end time, a condition, a loop or a group.
    expect(decoded.events.map((event) => event.repeatEveryS)).toEqual([undefined, 0.2]);
    for (const event of decoded.events) expect(Object.keys(event).filter((key) => ["endTimeS", "conditionId", "loop", "group"].includes(key) && event[key as keyof typeof event] !== undefined)).toEqual([]);
  });

  it("reads loops and groups from a 1.2 file", () => {
    const decoded = decodeBdx(grouped.bytes);
    expect(decoded.minor).toBe(2);
    expect(decoded.events.map((event) => [event.eventId, event.loop, event.group])).toEqual([
      ["fixture-event-0#0", { kind: "time", seconds: 1.5 }, { id: "fixture-event-0", mode: "parallel", order: 0 }],
      ["fixture-event-0#1", undefined, { id: "fixture-event-0", mode: "parallel", order: 1 }],
      ["fixture-event-1", { kind: "distance", meters: 0.5 }, undefined],
    ]);
    expect(decoded.events.map((event) => event.arguments)).toEqual([AUTHORED_ARGUMENTS, AUTHORED_ARGUMENTS, AUTHORED_ARGUMENTS]);
    expect(decoded.events.map((event) => [event.loop, event.group])).toEqual(grouped.document.paths[0].events.map((event) => [event.loop, event.group]));
  });

  it("reads a loop that runs until the path ends", () => {
    const fixture = groupedFixture();
    fixture.path.markers[1].invocation!.loop = { until: { kind: "pathEnd" } };
    expect(decodeBdx(build(fixture).bytes).events[2].loop).toEqual({ kind: "pathEnd" });
  });

  // The .expected.json files are the frozen, independently decoded contents of each .bdx (tests/robotBinary.test.ts).
  it.each([
    ["forces-v1.1", 1, 15], ["blue-origin", 0, 11], [".", 0, 11],
  ] as const)("reads the frozen files in %s as their recorded evidence (1.%i, %i numbers per sample)", (folder, minor, width) => {
    const directory = path.resolve("labview/tests/fixtures/binary", folder);
    for (const name of ["straight-empty", "straight-events", "curve-events"]) {
      const decoded = decodeBdx(fs.readFileSync(path.join(directory, `${name}.bdx`)));
      const expected = JSON.parse(fs.readFileSync(path.join(directory, `${name}.expected.json`), "utf8"));
      expect(decoded.minor).toBe(minor);
      expect({ pathId: decoded.id, pathName: decoded.name, plannerId: decoded.planner, fieldId: decoded.field.id, fieldRevision: decoded.field.revision,
        coordinateSchemaId: decoded.field.coordinateSchemaId, commandCatalogId: decoded.commandProtocolId, commandCatalogHash: decoded.catalogHash, driveType: 0,
        totalTimeS: decoded.totalTimeS, totalDistanceM: decoded.totalDistanceM, robotWidthM: decoded.robot.widthM, robotLengthM: decoded.robot.lengthM,
        robotMaxSpeedMps: decoded.robot.maxSpeedMps }).toEqual(expected.metadata);
      expect(decoded.samples.every((sample) => (sample.moduleForcesN !== undefined) === (minor > 0))).toBe(true);
      const columns = sampleColumns(decoded);
      expect(columns.every((row) => row.length === width)).toBe(true);
      // JSON has no negative zero; everything else in a DBL survives it exactly.
      expect(JSON.parse(JSON.stringify(columns))).toEqual(expected.samples);
      expect(decoded.followSections.map((section) => [section.segmentIndex, section.startSample, section.endSample, section.mode === "time" ? 0 : 1, 0])).toEqual(expected.followSections);
      expect(decoded.events.map((event) => ({ ids: [event.eventId, event.name, event.vi, event.conditionId ?? ""],
        schedule: [event.timeS, event.fraction, event.repeatEveryS ?? 0, event.endTimeS ?? -1], trigger: event.trigger === "time" ? 0 : 1, cancel: event.cancelOnPathEnd ? 1 : 0,
        // Each decoded value must encode back to the frozen bytes.
        args: event.arguments.map((argument) => {
          const wire = "choiceIndex" in argument ? encodeBdxArgument({ niType: argument.niType, choices: MODE_CHOICES }, MODE_CHOICES[argument.choiceIndex])
            : encodeBdxArgument({ niType: argument.niType }, argument.value);
          return { key: argument.key, tag: wire.tag, hex: Buffer.from(wire.bytes).toString("hex") };
        }) }))).toEqual(expected.events);
    }
  });

  it("reads a view into a larger buffer, and leaves the buffer as it was", () => {
    const pooled = Buffer.concat([Buffer.alloc(7, 0xaa), plain.bytes, Buffer.alloc(5, 0xaa)]), before = Buffer.from(pooled);
    expect(decodeBdx(pooled.subarray(7, 7 + plain.bytes.length))).toEqual(decodeBdx(plain.bytes));
    expect(pooled).toEqual(before);
  });

  it.each<[BdxParameterType, unknown, DecodedBdxValue]>([
    [{ niType: "Boolean" }, true, { niType: "Boolean", value: true }], [{ niType: "Boolean" }, false, { niType: "Boolean", value: false }],
    [{ niType: "I8" }, -128, { niType: "I8", value: -128 }], [{ niType: "U8" }, 255, { niType: "U8", value: 255 }],
    [{ niType: "I16" }, -32768, { niType: "I16", value: -32768 }], [{ niType: "U16" }, 65535, { niType: "U16", value: 65535 }],
    [{ niType: "I32" }, -2147483648, { niType: "I32", value: -2147483648 }], [{ niType: "U32" }, 4294967295, { niType: "U32", value: 4294967295 }],
    [{ niType: "I64" }, "-9223372036854775808", { niType: "I64", value: "-9223372036854775808" }], [{ niType: "I64" }, "9007199254740993", { niType: "I64", value: "9007199254740993" }],
    [{ niType: "U64" }, "18446744073709551615", { niType: "U64", value: "18446744073709551615" }],
    [{ niType: "SGL" }, 0.1, { niType: "SGL", value: Math.fround(0.1) }], [{ niType: "DBL" }, 0.1, { niType: "DBL", value: 0.1 }], [{ niType: "DBL" }, -0, { niType: "DBL", value: -0 }],
    [{ niType: "String" }, "Café 🤖", { niType: "String", value: "Café 🤖" }], [{ niType: "String" }, "", { niType: "String", value: "" }], [{ niType: "String" }, "a\0b", { niType: "String", value: "a\0b" }],
    [{ niType: "EB", choices: ["a", "b", "c"] }, "c", { niType: "EB", choiceIndex: 2 }], [{ niType: "EW", choices: ["a", "b"] }, "a", { niType: "EW", choiceIndex: 0 }],
    [{ niType: "EL", choices: ["a", "b"] }, "b", { niType: "EL", choiceIndex: 1 }],
  ])("decodes a %o argument of %o", (type, value, expected) => {
    const wire = encodeBdxArgument(type, value);
    expect(decodeBdxArgument(wire.tag, wire.bytes)).toEqual(expected);
  });
});

describe("refusing a file that is not a readable BDX", () => {
  const u32 = (offset: number, value: number) => (payload: Buffer) => { payload.writeUInt32BE(value, offset); };
  it.each<[string, () => Uint8Array, RegExp]>([
    ["an empty file", () => new Uint8Array(0), /not a BDX path file/],
    ["a file shorter than the BDX mark", () => plain.bytes.subarray(0, 7), /not a BDX path file/],
    ["a BDX cut short inside its header", () => plain.bytes.subarray(0, 31), /cut short/],
    ["a routine file", () => Buffer.from(`{"schema":"bordeaux-routine-runtime/1","name":"Auto","nodes":[]}`.padEnd(64)), /not a BDX path file/],
    [COMMANDS_FILE_NAME, () => Buffer.from(encodeCommandsFile(plainFixture.bindings)), /not a BDX path file/],
    ["a newer major version", () => withHeader(plain.bytes, (header) => header.writeUInt16BE(2, 8)), /version 2\.1.*newer/],
    ["a newer minor version", () => withHeader(plain.bytes, (header) => header.writeUInt16BE(3, 10)), /version 1\.3.*newer/],
    ["a header of another size", () => withHeader(plain.bytes, (header) => header.writeUInt32BE(64, 12)), /malformed.*header/],
    ["header flags it does not know", () => withHeader(plain.bytes, (header) => header.writeUInt32BE(1, 24)), /malformed.*header/],
    ["a file cut short by one byte", () => plain.bytes.subarray(0, plain.bytes.length - 1), /cut short/],
    ["a file cut short inside the header's own count", () => plain.bytes.subarray(0, 40), /cut short/],
    ["a file with a byte appended", () => Buffer.concat([plain.bytes, Buffer.alloc(1)]), /extra bytes/],
    ["a flipped payload bit", () => withHeader(plain.bytes, (file) => { file[file.length - 20] ^= 1; }), /damaged/],
    ["a flipped checksum bit", () => withHeader(plain.bytes, (header) => { header[20] ^= 1; }), /damaged/],
    // A 1.1 file relabeled 1.0 has the wrong sample size for its header.
    ["a 1.1 file whose header says 1.0", () => withHeader(plain.bytes, (header) => header.writeUInt16BE(0, 10)), /malformed/],
    ["a sample count far past the end", () => withPayload(plain.bytes, (payload, at) => u32(at.samples, 0xffffffff)(payload)), /malformed.*samples/],
    ["one sample more than the file holds", () => withPayload(plain.bytes, (payload, at) => u32(at.samples, payload.readUInt32BE(at.samples) + 1)(payload)), /malformed/],
    ["a follow section count far past the end", () => withPayload(plain.bytes, (payload, at) => u32(at.follow, 0xffffffff)(payload)), /malformed.*follow sections/],
    ["an event count far past the end", () => withPayload(plain.bytes, (payload, at) => u32(at.events, 0xffffffff)(payload)), /malformed.*events/],
    ["an argument count far past the end", () => withPayload(plain.bytes, (payload, at) => u32(at.event(0).argumentCount, 0xffffffff)(payload)), /malformed.*arguments/],
    ["a metadata length one byte long", () => withPayload(plain.bytes, (payload) => u32(0, payload.readUInt32BE(0) + 1)(payload)), /malformed/],
    ["a metadata length one byte short", () => withPayload(plain.bytes, (payload) => u32(0, payload.readUInt32BE(0) - 1)(payload)), /malformed/],
    ["an event length one byte short", () => withPayload(plain.bytes, (payload, at) => u32(at.event(0).length, payload.readUInt32BE(at.event(0).length) - 1)(payload)), /malformed/],
    ["a text length past the end", () => withPayload(plain.bytes, (payload, at) => u32(at.pathId, 0xfffffff0)(payload)), /malformed/],
    ["text that is not UTF-8", () => withPayload(plain.bytes, (payload, at) => { payload[at.pathId + 4] = 0xff; }), /malformed.*UTF-8/],
    ["a number that is not finite", () => withPayload(plain.bytes, (payload, at) => { payload.writeDoubleBE(NaN, at.firstSample + 24); }), /malformed.*finite/],
    ["unread bytes after the last event", () => withPayload(plain.bytes, (payload) => Buffer.concat([payload, Buffer.alloc(4)])), /malformed/],
    ["a payload that ends after its samples", () => withPayload(plain.bytes, (payload, at) => payload.subarray(0, at.follow)), /malformed/],
    ["a drive type it does not know", () => withPayload(plain.bytes, (payload, at) => { payload.writeUInt16BE(1, at.samples - 44); }), /malformed.*drive type/],
    ["a follow mode it does not know", () => withPayload(plain.bytes, (payload, at) => { payload.writeUInt16BE(2, at.firstFollow + 12); }), /malformed.*follow mode/],
    ["a trigger it does not know", () => withPayload(plain.bytes, (payload, at) => { payload[at.event(0).trigger] = 2; }), /malformed.*trigger/],
    ["a cancel flag that is not 0 or 1", () => withPayload(plain.bytes, (payload, at) => { payload[at.event(0).cancel] = 2; }), /malformed/],
    ["an argument type it does not know", () => withPayload(plain.bytes, (payload, at) => { payload.writeUInt16BE(99, at.event(0).tag); }), /malformed.*argument type/],
    // The first argument is a one-byte Boolean; a DBL needs eight.
    ["an argument too short for its type", () => withPayload(plain.bytes, (payload, at) => { payload.writeUInt16BE(11, at.event(0).tag); }), /malformed.*DBL/],
    ["a Boolean that is not 0 or 1", () => withPayload(plain.bytes, (payload, at) => { payload[at.event(0).value] = 2; }), /malformed.*Boolean/],
    // The last event has an empty group ID, so its extension is the final 16 bytes: loop, group, order, limit, ID length.
    ["a loop kind it does not know", () => withPayload(grouped.bytes, (payload, at) => { payload[at.event(2).end - 16] = 4; }), /malformed.*loop/],
    ["a group mode it does not know", () => withPayload(grouped.bytes, (payload, at) => { payload[at.event(2).end - 15] = 3; }), /malformed.*group/],
  ])("refuses %s", (_name, bytes, message) => {
    expect(() => decodeBdx(bytes())).toThrow(message);
  });

  it("reads each edited fixture when the edit is undone, so the refusals above come from the edit", () => {
    expect(decodeBdx(withPayload(plain.bytes, () => undefined))).toEqual(decodeBdx(plain.bytes));
    expect(decodeBdx(withPayload(grouped.bytes, () => undefined))).toEqual(decodeBdx(grouped.bytes));
    expect(decodeBdx(withHeader(plain.bytes, () => undefined))).toEqual(decodeBdx(plain.bytes));
  });
});
