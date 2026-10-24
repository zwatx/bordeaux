/** Fixed-layout, big-endian primitives for the direct LabVIEW VI BDX reader. */
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
export function utf8(value: string, limit: number, label: string, allowEmpty = false, allowNul = false): Buffer {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || (!allowNul && value.includes("\0"))) throw new Error(`${label} is invalid`);
  if (value.length > limit) throw new Error(`${label} exceeds ${limit} UTF-8 bytes`);
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > limit || bytes.toString("utf8") !== value) throw new Error(`${label} exceeds its UTF-8 limit or contains invalid Unicode`);
  return bytes;
}
export class BinaryWriter {
  private buffer: Buffer;
  length = 0;
  constructor(private readonly limit = MAX_BINARY_PAYLOAD_BYTES) { this.buffer = Buffer.alloc(Math.min(256, limit)); }
  private reserve(size: number): number {
    if (size > this.limit - this.length) throw new Error(`BDX section exceeds ${this.limit} bytes`);
    const offset = this.length, needed = offset + size;
    if (needed > this.buffer.length) {
      const next = Buffer.alloc(Math.min(this.limit, Math.max(needed, this.buffer.length * 2)));
      this.buffer.copy(next, 0, 0, this.length); this.buffer = next;
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
    const offset = this.reserve(bytes);
    if (bytes === 8) { if (signed) this.buffer.writeBigInt64BE(integer, offset); else this.buffer.writeBigUInt64BE(integer, offset); }
    else if (signed) this.buffer.writeIntBE(Number(integer), offset, bytes); else this.buffer.writeUIntBE(Number(integer), offset, bytes);
  }
  dbl(value: number, single = false): void {
    if (typeof value !== "number" || !Number.isFinite(value) || single && !Number.isFinite(Math.fround(value))) throw new Error("BDX numeric values must be finite in their NI representation");
    const offset = this.reserve(single ? 4 : 8);
    if (single) this.buffer.writeFloatBE(value, offset); else this.buffer.writeDoubleBE(value, offset);
  }
  text(value: string, label: string, limit = 256, allowEmpty = false): void {
    const result = utf8(value, limit, label, allowEmpty);
    this.integer(result.length, 4); this.bytes(result);
  }
  section(value: BinaryWriter): void { this.integer(value.length, 4); this.bytes(value.finish()); }
  finish(): Buffer { return Buffer.from(this.buffer.subarray(0, this.length)); }
}
export function encodeBinaryEnvelope(payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_BINARY_PAYLOAD_BYTES) throw new Error("BDX payload exceeds 16 MiB");
  const header = Buffer.alloc(32);
  header.write("BDXLV1\r\n", 0, "ascii"); header.writeUInt16BE(1, 8); header.writeUInt32BE(32, 12);
  header.writeUInt16BE(1, 10);
  header.writeUInt32BE(payload.length, 16); header.writeUInt32BE(crc32(payload), 20);
  return Buffer.concat([header, payload]);
}
