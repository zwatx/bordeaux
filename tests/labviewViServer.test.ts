import { createServer } from "node:net";
import { once } from "node:events";
import { expect, it } from "vitest";
import { LabviewViServer } from "../src/electron/labviewViServer";

function words(...values: number[]): Buffer {
  const result = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => result.writeUInt32BE(value, 4 * index));
  return result;
}

it("accepts the VI Server handshake version and decodes a fragmented helper reply", async () => {
  const requests: number[] = [];
  const title = Buffer.from("My Computer");
  // A flattened string (type 0x30), with no attributes.
  const variant = Buffer.concat([words(0x26008000, 1), Buffer.from("00080030ffffffff00010000", "hex"), words(title.length), title, words(0)]);
  const methodReply = Buffer.concat([words(0, 0, 4 + variant.length, 0), variant]);
  const server = createServer(socket => {
    let buffered: Buffer = Buffer.alloc(0);
    socket.on("data", data => {
      buffered = Buffer.concat([buffered, data]);
      while (buffered.length >= 16) {
        const length = buffered.readUInt32BE(12);
        if (buffered.length < 16 + length) break;
        const opcode = buffered.readUInt32BE(4), id = buffered.readUInt32BE(8);
        if (opcode === 8) { socket.end(); return; }
        requests.push(opcode);
        const body = opcode === 0 ? Buffer.alloc(0) : opcode === 3 ? words(123) : methodReply;
        const reply = Buffer.concat([words(0, opcode + 10, opcode === 0 ? 0x26008000 : id, body.length), body]);
        socket.write(reply.subarray(0, 7));
        socket.write(reply.subarray(7, 18));
        socket.write(reply.subarray(18));
        buffered = buffered.subarray(16 + length);
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener.");
  try {
    const connection = await LabviewViServer.connect(address.port);
    try {
      const ref = await connection.openVi("/robot code/helper.vi");
      expect(ref).toBe(123);
      await expect(connection.get(ref, "Application:Context Name")).resolves.toBe("My Computer");
      expect(requests).toEqual([0, 3, 6]);
    } finally { connection.close(); }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
