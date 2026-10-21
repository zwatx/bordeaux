import { afterEach, describe, expect, it } from "vitest";
import { Server, utils, type Connection } from "ssh2";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync } from "node:crypto";
import { probeRobotFiles, uploadRobotFiles } from "../src/electron/robotFileTransfer";

const { STATUS_CODE: S, OPEN_MODE: O } = utils.sftp;
const directory = "/home/lvuser/natinst/bin/Paths";
// ssh2's Ed25519 generator strips genuine leading zero public-key bytes, intermittently
// producing an unparsable fixture. Node's PEM encoder avoids that generator entirely.
const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

// A real SSH/SFTP v3 server, deliberately without OpenSSH rename extensions.
// Its filesystem models the selected runtime directory, including a linked parent.
async function robot({ linked = false, denyWrite = false, missingFolder = false, denyMkdir = false } = {}) {
  const files = new Map<string, Buffer>(missingFolder ? [] : [[`${directory}/existing.bdx`, Buffer.from("old")], [`${directory}/unrelated.bdx`, Buffer.from("untouched")]]);
  const directories = new Set(["/home", "/home/lvuser", "/home/lvuser/natinst", "/home/lvuser/natinst/bin", directory]);
  if (missingFolder) directories.delete(directory);
  const created: string[] = [];
  const writes: string[] = [];
  const writeModes: Array<number | undefined> = [];
  const clients = new Set<Connection>();
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));
    client.on("authentication", (ctx) => {
      if (ctx.username === "admin" && (ctx.method === "none" || (ctx.method === "password" && ctx.password === ""))) ctx.accept();
      else ctx.reject();
    });
    client.on("ready", () => client.on("session", (accept) => {
      accept().on("sftp", (acceptSftp) => {
        const sftp = acceptSftp();
        const handles = new Map<string, string>();
        let nextHandle = 0;
        const stat = (id: number, target: string, follow: boolean) => {
          const data = files.get(target);
          if (!data && !directories.has(target)) { sftp.status(id, S.NO_SUCH_FILE); return; }
          const type = linked && target === "/home/lvuser/natinst" && !follow ? 0o120000 : directories.has(target) ? 0o040000 : 0o100000;
          sftp.attrs(id, { mode: type | 0o755, size: data?.length ?? 0, uid: 1000, gid: 1000, atime: 0, mtime: 0 });
        };
        sftp.on("LSTAT", (id, target) => stat(id, target, false));
        sftp.on("STAT", (id, target) => stat(id, target, true));
        sftp.on("FSTAT", (id, handle) => stat(id, handles.get(handle.toString())!, true));
        sftp.on("MKDIR", (id, target) => {
          if (denyMkdir) { sftp.status(id, S.PERMISSION_DENIED); return; }
          if (directories.has(target)) { sftp.status(id, S.FAILURE); return; }
          directories.add(target); created.push(target); sftp.status(id, S.OK);
        });
        sftp.on("OPEN", (id, target, flags, attrs) => {
          if (flags & O.WRITE) {
            if (denyWrite) { sftp.status(id, S.PERMISSION_DENIED); return; }
            if ((flags & O.EXCL) && files.has(target)) { sftp.status(id, S.FAILURE); return; }
            if (flags & O.TRUNC || !files.has(target)) files.set(target, Buffer.alloc(0));
            writes.push(target);
            writeModes.push(attrs.mode);
          } else if (!files.has(target)) { sftp.status(id, S.NO_SUCH_FILE); return; }
          const handle = String(++nextHandle); handles.set(handle, target); sftp.handle(id, Buffer.from(handle));
        });
        sftp.on("WRITE", (id, handle, offset, data) => {
          const target = handles.get(handle.toString())!;
          const previous = files.get(target)!;
          const next = Buffer.alloc(Math.max(previous.length, offset + data.length));
          previous.copy(next); data.copy(next, offset); files.set(target, next); sftp.status(id, S.OK);
        });
        sftp.on("READ", (id, handle, offset, length) => {
          const data = files.get(handles.get(handle.toString())!)!;
          if (offset >= data.length) sftp.status(id, S.EOF);
          else sftp.data(id, data.subarray(offset, offset + length));
        });
        sftp.on("CLOSE", (id, handle) => { handles.delete(handle.toString()); sftp.status(id, S.OK); });
        sftp.on("RENAME", (id, from, to) => {
          if (files.has(to)) { sftp.status(id, S.FAILURE); return; }
          const data = files.get(from);
          if (!data) { sftp.status(id, S.NO_SUCH_FILE); return; }
          files.set(to, data); files.delete(from); sftp.status(id, S.OK);
        });
        sftp.on("REMOVE", (id, target) => { files.delete(target); sftp.status(id, S.OK); });
      });
    }));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  cleanups.push(async () => {
    for (const client of clients) client.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { files, writes, writeModes, created, endpoint: { host: "127.0.0.1", port: (server.address() as AddressInfo).port, directory } };
}

describe("path delivery against a real SSH/SFTP connection", () => {
  it.each([false, true])("copies new and existing files without rename extensions (linked directory: %s)", async (linked) => {
    const r = await robot({ linked });
    const connection = await probeRobotFiles(r.endpoint);
    expect(r.writes).toEqual([]);
    const contents = Buffer.from([0, 255, 128, 10, 0, 7]);
    expect(await uploadRobotFiles(connection, [{ fileName: "new.bdx", contents }, { fileName: "existing.bdx", contents }])).toEqual({ directoryCreated: false });
    expect(r.files).toEqual(new Map([[`${directory}/existing.bdx`, contents], [`${directory}/unrelated.bdx`, Buffer.from("untouched")], [`${directory}/new.bdx`, contents]]));
    expect(r.writeModes).toEqual([0o644, 0o644, 0o644]);
  }, 15_000);

  it("creates a missing Paths folder only on confirmed upload and reports it once", async () => {
    const r = await robot({ missingFolder: true });
    const connection = await probeRobotFiles(r.endpoint);
    expect(r.created).toEqual([]); expect(r.writes).toEqual([]);
    const files = [{ fileName: "new.bdx", contents: Buffer.from("bdx") }];
    expect(await uploadRobotFiles(connection, files)).toEqual({ directoryCreated: true });
    expect(r.created).toEqual([directory]);
    expect(r.files.get(`${directory}/new.bdx`)).toEqual(files[0].contents);
    expect(await uploadRobotFiles(connection, files)).toEqual({ directoryCreated: false });
    expect(r.created).toEqual([directory]);
  }, 15_000);

  it("rejects permission-denied folder creation without uploading or reporting creation", async () => {
    const r = await robot({ missingFolder: true, denyMkdir: true });
    const connection = await probeRobotFiles(r.endpoint);
    const failure = await uploadRobotFiles(connection, [{ fileName: "new.bdx", contents: Buffer.from("bdx") }]).catch(error => error);
    expect(failure.message).toMatch(/permission denied/i);
    expect(failure.message).not.toContain("Created robot folder");
    expect(r.created).toEqual([]); expect(r.writes).toEqual([]);
  }, 15_000);

  it("retains a confirmed folder creation when the subsequent upload is denied", async () => {
    const r = await robot({ missingFolder: true, denyWrite: true });
    const connection = await probeRobotFiles(r.endpoint);
    const failure = await uploadRobotFiles(connection, [{ fileName: "new.bdx", contents: Buffer.from("bdx") }]).catch(error => error);
    expect(failure.message).toMatch(/permission denied/i);
    expect(failure.message).toContain(`0 of 1 files verified on the robot. Created robot folder ${directory}.`);
    expect(r.created).toEqual([directory]); expect(r.writes).toEqual([]); expect(r.files.size).toBe(0);
  }, 15_000);

  it("retains the permission failure and preserves existing files", async () => {
    const r = await robot({ denyWrite: true });
    const connection = await probeRobotFiles(r.endpoint);
    await expect(uploadRobotFiles(connection, [{ fileName: "existing.bdx", contents: Buffer.from("new") }]))
      .rejects.toThrow(/permission denied\. The robot's SSH account needs access/i);
    expect(r.files.get(`${directory}/existing.bdx`)?.toString()).toBe("old");
    expect(r.writes).toEqual([]);
  }, 15_000);
});
