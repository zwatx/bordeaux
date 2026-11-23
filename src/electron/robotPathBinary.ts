import { TextDecoder } from "node:util";
import { crc32, MAX_BINARY_PAYLOAD_BYTES } from "../core/export/binaryCodec";

const HEADER_BYTES = 32;
const MAGIC = Buffer.from("BDXLV1\r\n");
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const argumentWidths = [0, 1, 1, 1, 2, 2, 4, 4, 8, 8, 4, 8, 0, 1, 2, 4];

function requireBdx(condition: unknown): asserts condition {
  if (!condition) throw new Error("Invalid BDX path data");
}

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Buffer) {}

  read(size: number): Buffer {
    requireBdx(size <= this.bytes.length - this.offset);
    const start = this.offset;
    this.offset += size;
    return this.bytes.subarray(start, this.offset);
  }

  uint(size: 1 | 2 | 4): number {
    return this.read(size).readUIntBE(0, size);
  }

  finite(): number {
    const value = this.read(8).readDoubleBE();
    requireBdx(Number.isFinite(value));
    return value;
  }

  text(limit = 256, empty = false): string {
    const length = this.uint(4);
    requireBdx(length <= limit);
    const value = decoder.decode(this.read(length));
    requireBdx((empty && !value || value.trim()) && !value.includes("\0"));
    return value;
  }

  section(limit = MAX_BINARY_PAYLOAD_BYTES): Reader {
    const length = this.uint(4);
    requireBdx(length <= limit);
    return new Reader(this.read(length));
  }

  end(): void {
    requireBdx(this.offset === this.bytes.length);
  }

  remaining(): Buffer {
    return this.bytes.subarray(this.offset);
  }
}

export function inspectRobotPath(bytes: Buffer) {
  if (bytes.length < HEADER_BYTES || !bytes.subarray(0, 8).equals(MAGIC)) {
    throw new Error("Unsupported BDX format");
  }
  const minor = bytes.readUInt16BE(10);
  if (bytes.readUInt16BE(8) !== 1 || minor > 2) throw new Error("Unsupported BDX version");
  const payload = bytes.subarray(HEADER_BYTES);
  requireBdx(bytes.readUInt32BE(12) === HEADER_BYTES && bytes.readUInt32BE(24) === 0 && bytes.readUInt32BE(28) === 0
    && payload.length <= MAX_BINARY_PAYLOAD_BYTES && bytes.readUInt32BE(16) === payload.length);
  if (bytes.readUInt32BE(20) !== crc32(payload)) throw new Error("BDX checksum failed");
  const reader = new Reader(payload);
  const header = reader.section(65_536);
  const id = header.text(), name = header.text(1024), planner = header.text();
  const field = header.text(), revision = header.text(), coordinates = header.text();
  const catalog = header.text(256, true), catalogHash = header.text(256, true);
  requireBdx(header.uint(2) === 0 && header.uint(2) === 0);
  const duration = header.finite(), distance = header.finite();
  const width = header.finite(), length = header.finite(), maxSpeed = header.finite();
  requireBdx(duration >= 0 && distance >= 0 && width > 0 && length > 0 && maxSpeed > 0);
  header.end();

  const stride = minor === 0 ? 88 : 120;
  const sampleCount = reader.uint(4);
  requireBdx(sampleCount >= 2 && sampleCount <= 100_000);
  const samples = reader.read(sampleCount * stride);
  let peakSpeed = 0, lastTime = 0, lastDistance = 0, lastFraction = 0;
  const close = (actual: number, expected: number) => Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected));
  for (let offset = 0; offset < samples.length; offset += stride) {
    const time = samples.readDoubleBE(offset), travelled = samples.readDoubleBE(offset + 8);
    const fraction = samples.readDoubleBE(offset + 16), speed = samples.readDoubleBE(offset + 56);
    for (let fieldOffset = 0; fieldOffset < stride; fieldOffset += 8) {
      const value = samples.readDoubleBE(offset + fieldOffset);
      requireBdx(Number.isFinite(value));
      if (offset > 0 && time === lastTime && fieldOffset > 0 && fieldOffset < 88 && fieldOffset !== 48) {
        requireBdx(close(value, samples.readDoubleBE(offset + fieldOffset - stride)));
      }
    }
    requireBdx(time >= lastTime && travelled >= lastDistance && fraction >= lastFraction && fraction <= 1 && speed >= 0);
    requireBdx(offset > 0 || (time === 0 && travelled === 0));
    if (duration === 0) {
      requireBdx(speed === 0 && samples.readDoubleBE(offset + 72) === 0 && close(travelled, 0)
        && close(samples.readDoubleBE(offset + 24), samples.readDoubleBE(24))
        && close(samples.readDoubleBE(offset + 32), samples.readDoubleBE(32))
        && close(samples.readDoubleBE(offset + 40), samples.readDoubleBE(40)));
    }
    peakSpeed = Math.max(peakSpeed, speed);
    lastTime = time; lastDistance = travelled; lastFraction = fraction;
  }
  requireBdx(close(lastTime, duration) && close(lastDistance, distance));

  const followCount = reader.uint(4);
  requireBdx(followCount >= 1 && followCount <= 4096);
  const following = reader.read(followCount * 16);
  let boundary = 0;
  for (let offset = 0; offset < following.length; offset += 16) {
    const start = following.readUInt32BE(offset + 4), end = following.readUInt32BE(offset + 8);
    requireBdx(start === boundary && end >= start && end < sampleCount
      && following.readUInt16BE(offset + 12) <= 1 && following.readUInt16BE(offset + 14) === 0);
    boundary = end;
  }
  requireBdx(boundary === sampleCount - 1);

  const eventCount = reader.uint(4);
  requireBdx(eventCount <= 2000);
  const events = new Map<string, { name: string; command: string; time: number; schedule: Array<number | string>; extension: Array<number | string>; args: Map<string, Buffer> }>();
  for (let i = 0; i < eventCount; i++) {
    const event = reader.section();
    const eventId = event.text();
    requireBdx(!events.has(eventId));
    const name = event.text(1024), command = event.text(), condition = event.text(256, true);
    const time = event.finite(), fraction = event.finite(), repeat = event.finite(), end = event.finite();
    requireBdx(time >= 0 && time <= duration && fraction >= 0 && fraction <= 1
      && repeat >= 0 && (end === -1 || end >= time && end <= duration));
    const trigger = event.uint(1), cancel = event.uint(1);
    requireBdx(trigger <= 1 && cancel <= 1 && event.uint(2) === 0);
    const argumentCount = event.uint(4), args = new Map<string, Buffer>();
    requireBdx(argumentCount <= 64);
    for (let j = 0; j < argumentCount; j++) {
      const key = event.text(), argument = event.remaining(), tag = event.uint(2);
      requireBdx(!args.has(key) && tag > 0 && tag < argumentWidths.length && event.uint(2) === 0);
      const size = event.uint(4);
      requireBdx(tag === 12 ? size <= 65_536 : size === argumentWidths[tag]);
      const value = event.read(size);
      if (tag === 1) requireBdx(value[0] <= 1);
      if (tag === 10) requireBdx(Number.isFinite(value.readFloatBE()));
      if (tag === 11) requireBdx(Number.isFinite(value.readDoubleBE()));
      if (tag === 12) decoder.decode(value);
      args.set(key, argument.subarray(0, 8 + size));
    }
    let extension: Array<number | string> = [0, 0, 0, 0, ""];
    if (minor === 2) {
      const loop = event.uint(1), group = event.uint(1), order = event.uint(2);
      const limit = event.finite(), groupId = event.text(256, true);
      requireBdx(loop <= 3 && group <= 2 && (loop === 1 || loop === 2 ? limit > 0 : limit === 0)
        && (group ? Boolean(groupId) : order === 0 && groupId === ""));
      extension = [loop, group, order, limit, groupId];
    }
    event.end();
    events.set(eventId, { name, command, time, schedule: [fraction, repeat, end, trigger, cancel, condition], extension, args });
  }
  reader.end();
  return { id, name, planner, field, revision, coordinates, catalog, catalogHash, duration, distance,
    width, length, maxSpeed, peakSpeed, sampleCount, eventCount, minor, stride, samples, following, events };
}
