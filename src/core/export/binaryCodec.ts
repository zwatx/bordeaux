/** Fixed-layout, big-endian primitives for the direct LabVIEW VI BDX reader. */
import { utf8Bytes, utf8Text } from "../bytes";
export const MAX_BINARY_PAYLOAD_BYTES = 16 * 1024 * 1024;
export type BinaryKind = "path";
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function utf8(value: string, limit: number, label: string, allowEmpty = false, allowNul = false): Uint8Array {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || (!allowNul && value.includes("\0"))) throw new Error(`${label} is invalid`);
  if (value.length > limit) throw new Error(`${label} exceeds ${limit} UTF-8 bytes`);
  const bytes = utf8Bytes(value);
  if (bytes.length > limit || utf8Text(bytes) !== value) throw new Error(`${label} exceeds its UTF-8 limit or contains invalid Unicode`);
  return bytes;
}
export class BinaryWriter {
  private buffer: Uint8Array;
  private view: DataView;
  length = 0;
  constructor(private readonly limit = MAX_BINARY_PAYLOAD_BYTES) {
    this.buffer = new Uint8Array(Math.min(256, limit)); this.view = new DataView(this.buffer.buffer);
  }
  private reserve(size: number): number {
    if (size > this.limit - this.length) throw new Error(`BDX section exceeds ${this.limit} bytes`);
    const offset = this.length, needed = offset + size;
    if (needed > this.buffer.length) {
      const next = new Uint8Array(Math.min(this.limit, Math.max(needed, this.buffer.length * 2)));
      next.set(this.buffer.subarray(0, this.length)); this.buffer = next; this.view = new DataView(next.buffer);
    }
    this.length = needed; return offset;
  }
  bytes(value: Uint8Array): void {
    const offset = this.reserve(value.length); this.buffer.set(value, offset);
  }
  integer(value: number | bigint, bytes: 1 | 2 | 4 | 8, signed = false): void {
    if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("BDX integer must be exact");
    const integer = BigInt(value), bits = BigInt(bytes * 8);
    const min = signed ? -(1n << (bits - 1n)) : 0n, max = (1n << (bits - (signed ? 1n : 0n))) - 1n;
    if (integer < min || integer > max) throw new Error(`BDX ${signed ? "I" : "U"}${bytes * 8} argument is out of range`);
    const offset = this.reserve(bytes), view = this.view;
    if (bytes === 8) { if (signed) view.setBigInt64(offset, integer); else view.setBigUint64(offset, integer); return; }
    const number = Number(integer);
    if (bytes === 1) { if (signed) view.setInt8(offset, number); else view.setUint8(offset, number); }
    else if (bytes === 2) { if (signed) view.setInt16(offset, number); else view.setUint16(offset, number); }
    else if (signed) view.setInt32(offset, number); else view.setUint32(offset, number);
  }
  dbl(value: number, single = false): void {
    if (typeof value !== "number" || !Number.isFinite(value) || single && !Number.isFinite(Math.fround(value))) throw new Error("BDX numeric values must be finite in their NI representation");
    const offset = this.reserve(single ? 4 : 8);
    if (single) this.view.setFloat32(offset, value); else this.view.setFloat64(offset, value);
  }
  text(value: string, label: string, limit = 256, allowEmpty = false): void {
    const result = utf8(value, limit, label, allowEmpty);
    this.integer(result.length, 4); this.bytes(result);
  }
  section(value: BinaryWriter): void { this.integer(value.length, 4); this.bytes(value.finish()); }
  finish(): Uint8Array { return this.buffer.slice(0, this.length); }
}
/** Minor 1 is the default layout; minor 2 adds the event loop/group extension and is written only when used. */
export function encodeBinaryEnvelope(payload: Uint8Array, minor: 1 | 2 = 1): Uint8Array {
  if (payload.length > MAX_BINARY_PAYLOAD_BYTES) throw new Error("BDX payload exceeds 16 MiB");
  const envelope = new Uint8Array(32 + payload.length), header = new DataView(envelope.buffer);
  envelope.set(utf8Bytes("BDXLV1\r\n")); header.setUint16(8, 1); header.setUint32(12, 32);
  header.setUint16(10, minor);
  header.setUint32(16, payload.length); header.setUint32(20, crc32(payload));
  envelope.set(payload, 32);
  return envelope;
}
