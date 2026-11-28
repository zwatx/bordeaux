import { createConnection, type Socket } from "node:net";

// NI VI Server message framing and method IDs are documented by lvpm (Apache-2.0):
// https://github.com/ThatsTheEnd/lvpm/blob/main/docs/vi-server-protocol.md
// Only the local helper VI's controls and synchronous Run are needed here.
const MAX_MESSAGE = 16 * 1024 * 1024;
const STRING = 0x30, PATH = 0x32, VARIANT = 0x53, BOOLEAN = 0x21, ARRAY = 0x40, CLUSTER = 0x50;
const SINGLE_TYPE = Buffer.from([0, 1, 0, 0]);
const concat = (parts: readonly Buffer[]) => Buffer.concat(parts);
function words(...values: number[]): Buffer {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bytes.writeUInt32BE(value, index * 4));
  return bytes;
}
function lvString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return concat([words(bytes.length), bytes]);
}
function pascal(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > 255) throw new Error("LabVIEW path component or control name is too long.");
  return concat([Buffer.from([bytes.length]), bytes]);
}
function lvPath(file: string): Buffer {
  if (!file.startsWith("/")) throw new Error("LabVIEW VI Server requires an absolute path.");
  const components = file.slice(1).split("/").map(pascal);
  const kind = Buffer.alloc(4);
  kind.writeUInt16BE(components.length, 2);
  const body = concat([kind, ...components]);
  return concat([Buffer.from("PTH0"), words(body.length), body]);
}
function descriptor(code: number, name: string): Buffer {
  const label = pascal(name);
  const prefix = Buffer.from([0, 0, 0x40, code]);
  const result = concat([prefix, ...(code === STRING ? [words(0xffffffff)] : []), label, Buffer.alloc(label.length % 2)]);
  result.writeUInt16BE(result.length);
  return result;
}
function typeTable(type: Buffer): Buffer {
  return concat([words(1), type, SINGLE_TYPE]);
}
function argument(code: number, name: string, value: Buffer): Buffer {
  const types = typeTable(descriptor(code, name));
  const padding = value.length % 2;
  return concat([words(0x10, 4 + types.length + value.length + padding, types.length), types, value, Buffer.alloc(padding)]);
}

class Reader {
  private offset = 0;
  constructor(private readonly data: Buffer) {}
  get remaining(): number { return this.data.length - this.offset; }
  take(count: number): Buffer {
    if (count < 0 || count > this.remaining) throw new Error("Truncated LabVIEW VI Server data.");
    const start = this.offset;
    this.offset += count;
    return this.data.subarray(start, this.offset);
  }
  u16(): number { return this.take(2).readUInt16BE(); }
  u32(): number { return this.take(4).readUInt32BE(); }
  string(): string { return this.take(this.u32()).toString("utf8"); }
  path(): string {
    const format = this.take(4).toString("ascii");
    if (!/^PTH[012]$/.test(format)) throw new Error("Invalid path from LabVIEW.");
    const length = this.u32();
    if (!length) return "";
    const path = new Reader(this.take(length));
    const kind = path.u16(), count = path.u16();
    const components = Array.from({ length: count }, () => path.take(path.take(1)[0]).toString("utf8"));
    return (kind === 0 && components.length ? "/" : "") + components.join("/");
  }
}
export type LabviewValue = string | number | boolean | null | LabviewValue[];
interface ControlType { code: number; bytes: Buffer }
interface ControlValue { types: ControlType[]; root: number; value: LabviewValue }
function readVariant(reader: Reader, depth = 0): ControlValue {
  reader.u32(); // LabVIEW flattening version
  const count = reader.u32();
  if (count < 1 || count > 256) throw new Error("Invalid LabVIEW control type table.");
  const types = Array.from({ length: count }, () => {
    const length = reader.u16();
    if (length < 4) throw new Error("Invalid LabVIEW control descriptor.");
    const bytes = concat([Buffer.from([length >>> 8, length & 0xff]), reader.take(length - 2)]);
    return { code: bytes[3], bytes };
  });
  if (reader.u16() !== 1) throw new Error("Invalid LabVIEW control type.");
  const root = reader.u16();
  const value = readValue(reader, types, types[root], depth);
  if (reader.u32() !== 0) throw new Error("Unexpected attributes on the LabVIEW helper control.");
  return { types, root, value };
}
/** NI uses IEEE 754 binary128 for the numeric values in enum/typedef metadata. */
function readExtended(bytes: Buffer): number {
  const high = bytes.readBigUInt64BE(), low = bytes.readBigUInt64BE(8);
  const sign = high >> 63n ? -1 : 1;
  const exponent = Number((high >> 48n) & 0x7fffn);
  const fraction = ((high & 0xffffffffffffn) << 64n) | low;
  if (exponent === 0x7fff) return fraction ? NaN : sign * Infinity;
  if (exponent === 0) return sign * 0; // Binary128 subnormals are smaller than the smallest JS number.
  return sign * (1 + Number(fraction) / 2 ** 112) * 2 ** (exponent - 16383);
}
function readValue(reader: Reader, types: ControlType[], type: ControlType | undefined, depth: number): LabviewValue {
  if (!type || depth > 16) throw new Error("Invalid LabVIEW helper control type.");
  const { code, bytes } = type;
  switch (code) {
    case 0: return null;
    case BOOLEAN: return reader.take(1)[0] !== 0;
    case 0x01: return reader.take(1).readInt8();
    case 0x02: return reader.take(2).readInt16BE();
    case 0x03: return reader.take(4).readInt32BE();
    case 0x04: return reader.take(8).readBigInt64BE().toString();
    case 0x05: case 0x15: return reader.take(1)[0];
    case 0x06: case 0x16: return reader.u16();
    case 0x07: case 0x17: return reader.u32();
    case 0x08: return reader.take(8).readBigUInt64BE().toString();
    case 0x09: return reader.take(4).readFloatBE();
    case 0x0a: return reader.take(8).readDoubleBE();
    case 0x0b: return readExtended(reader.take(16));
    case STRING: return reader.string();
    case PATH: return reader.path();
    case VARIANT: return readVariant(reader, depth + 1).value;
    case CLUSTER: {
      const fields = bytes.readUInt16BE(4);
      if (fields > 512 || fields * 2 + 6 > bytes.length) throw new Error("Invalid LabVIEW helper cluster.");
      return Array.from({ length: fields }, (_, field) => readValue(reader, types, types[bytes.readUInt16BE(6 + field * 2)], depth + 1));
    }
    case ARRAY: {
      if (bytes.readUInt16BE(4) !== 1) throw new Error("Expected a one-dimensional LabVIEW helper array.");
      const length = reader.u32(), element = bytes.readUInt16BE(10);
      if (length > 10000) throw new Error("LabVIEW helper array exceeds its size limit.");
      return Array.from({ length }, () => readValue(reader, types, types[element], depth + 1));
    }
    case 0xf1: {
      // A typedef descriptor wraps the underlying data type after its flags and qualified name.
      const desc = new Reader(bytes);
      desc.take(8);
      const names = desc.u32();
      if (names > 64) throw new Error("Invalid LabVIEW typedef descriptor.");
      for (let index = 0; index < names; index++) desc.take(desc.take(1)[0]);
      const inner = desc.take(desc.remaining);
      if (inner.length < 4) throw new Error("Invalid LabVIEW typedef type.");
      return readValue(reader, types, { code: inner[3], bytes: inner }, depth + 1);
    }
    default: throw new Error(`Unsupported LabVIEW helper control type 0x${code.toString(16)}.`);
  }
}
function writeValue(types: ControlType[], index: number, value: LabviewValue): Buffer {
  const { code, bytes } = types[index];
  if (code === STRING && typeof value === "string") return lvString(value);
  if (code === PATH && typeof value === "string") return lvPath(value);
  if (code === BOOLEAN && typeof value === "boolean") return Buffer.from([Number(value)]);
  if ((code === 0x03 || code === 0x07) && typeof value === "number") {
    const data = Buffer.alloc(4);
    if (code === 0x03) data.writeInt32BE(value);
    else data.writeUInt32BE(value);
    return data;
  }
  if (code === 0x0a && typeof value === "number") {
    const data = Buffer.alloc(8);
    data.writeDoubleBE(value);
    return data;
  }
  if (code === ARRAY && bytes.readUInt16BE(4) === 1 && Array.isArray(value)) {
    const element = bytes.readUInt16BE(10);
    return concat([words(value.length), ...value.map(item => writeValue(types, element, item))]);
  }
  throw new Error("Input does not match the LabVIEW helper control's type.");
}

export class LabviewViServerError extends Error {
  constructor(operation: string, readonly code: number) { super(`${operation}: LabVIEW VI Server error ${code}.`); }
}
export class LabviewViServer {
  private readonly incoming: AsyncIterator<Buffer>;
  private buffered = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
  private id = 0x00100000;
  private readonly controlTypes = new Map<string, ControlValue>();

  private constructor(private readonly socket: Socket) {
    this.incoming = socket[Symbol.asyncIterator]();
    socket.setNoDelay(true);
    socket.setTimeout(5000, () => socket.destroy(new Error("LabVIEW VI Server did not respond. Check for an open dialog in LabVIEW.")));
  }

  static async connect(port: number): Promise<LabviewViServer> {
    const server = new LabviewViServer(createConnection({ host: "127.0.0.1", port }));
    try {
      const hello = Buffer.from("260080000000001c1c0000002900000008000000284e6f626f6479297f00000100000000", "hex");
      await server.request(0, 10, hello, "Connect to LabVIEW", 6);
      server.socket.setTimeout(180_000);
      return server;
    } catch (error) { server.close(); throw error; }
  }

  close(): void {
    if (this.socket.destroyed) return;
    // VI Server releases all references for this client on its disconnect message.
    this.socket.end(words(0, 8, 0, 0));
    this.socket.destroySoon();
  }

  private async read(count: number): Promise<Buffer> {
    if (this.buffered.length >= count) {
      const data = this.buffered.subarray(0, count);
      this.buffered = this.buffered.subarray(count);
      return data;
    }
    const data = Buffer.allocUnsafe(count);
    let filled = 0;
    while (filled < count) {
      if (!this.buffered.length) {
        const next = await this.incoming.next();
        if (next.done) throw new Error("LabVIEW closed the VI Server connection.");
        this.buffered = next.value;
      }
      const take = Math.min(this.buffered.length, count - filled);
      this.buffered.copy(data, filled, 0, take);
      this.buffered = this.buffered.subarray(take);
      filled += take;
    }
    return data;
  }

  private send(opcode: number, id: number, body: Buffer = Buffer.alloc(0)): void {
    this.socket.write(concat([words(0, opcode, id, body.length), body]));
  }

  private async request(opcode: number, expected: number, body: Buffer, operation: string, id = this.id): Promise<Buffer> {
    this.id = (this.id + 0x00100000) >>> 0 || 0x00100000;
    this.send(opcode, id, body);
    const header = await this.read(16);
    const length = header.readUInt32BE(12);
    if (length > MAX_MESSAGE || (opcode !== 0 && header.readUInt32BE(8) !== id)) throw new Error("Invalid LabVIEW VI Server reply.");
    const response = await this.read(length);
    const error = header.readInt32BE(0);
    if (error) throw new LabviewViServerError(operation, error);
    if (header.readUInt32BE(4) !== expected) throw new Error("Unexpected LabVIEW VI Server reply.");
    return response;
  }

  async openVi(file: string): Promise<number> {
    const name = lvPath(file);
    const response = await this.request(3, 13, concat([words(0, 0x80200000, name.length), name, words(0, 0)]), "Open Bordeaux’s LabVIEW helper");
    const ref = response.readUInt32BE();
    if (!ref) throw new Error("LabVIEW could not open Bordeaux’s helper VI.");
    return ref;
  }

  private async invoke(ref: number, method: number, args: Buffer[], operation: string, returns = Buffer.alloc(0)): Promise<Buffer> {
    const body = concat([words(ref, 2, method, args.length + 1, returns.length ? 0x21 : 1, returns.length), returns, ...args]);
    return this.request(6, 16, body, operation);
  }

  async run(ref: number): Promise<void> {
    await this.invoke(ref, 1003, [
      argument(BOOLEAN, "Wait until done", Buffer.from([1])),
      argument(BOOLEAN, "Auto Dispose Ref", Buffer.from([0])),
    ], "Run Bordeaux’s LabVIEW helper");
  }

  private async getControl(ref: number, name: string): Promise<ControlValue> {
    const types = typeTable(descriptor(VARIANT, "Get Control Value Variant"));
    const reply = new Reader(await this.invoke(ref, 1052, [argument(STRING, "Control Name", lvString(name))],
      `Read LabVIEW helper control "${name}"`, concat([words(types.length), types])));
    reply.take(8);
    const section = new Reader(reply.take(reply.u32()));
    section.take(section.u32());
    return readVariant(section);
  }

  async get(ref: number, name: string): Promise<LabviewValue> { return (await this.getControl(ref, name)).value; }

  async set(ref: number, name: string, value: LabviewValue): Promise<void> {
    const key = `${ref}\0${name}`;
    let control = this.controlTypes.get(key);
    if (!control) {
      control = await this.getControl(ref, name);
      this.controlTypes.set(key, control);
    }
    const { types, root } = control;
    const index = Buffer.from([0, 1, root >>> 8, root & 0xff]);
    const variant = concat([words(0x20008000, types.length), ...types.map(type => type.bytes), index, writeValue(types, root, value), words(0)]);
    await this.invoke(ref, 1051, [argument(STRING, "Control Name", lvString(name)), argument(VARIANT, "Value", variant)], `Set LabVIEW helper control "${name}"`);
  }
}
