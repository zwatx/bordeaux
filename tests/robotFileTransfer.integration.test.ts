import { afterEach, describe, expect, it } from "vitest";
import { Server, utils, type Connection } from "ssh2";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { RobotFileDelivery } from "../src/electron/robotFileDelivery";
import { probeRobotFiles, uploadRobotFiles } from "../src/electron/robotFileTransfer";

const { STATUS_CODE: S, OPEN_MODE: O } = utils.sftp;
const directory = "/home/lvuser/natinst/bin/Paths";
const systemcoreDirectory = "/home/systemcore/bordeaux/paths";
// ssh2's Ed25519 generator strips genuine leading zero public-key bytes, intermittently
// producing an unparsable fixture. Node's PEM encoder avoids that generator entirely.
const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

// A real SSH/SFTP v3 server, deliberately without OpenSSH rename extensions.
// Its filesystem models the selected runtime directory, including a linked parent.
// A roboRIO accepts `admin` with no password; a Systemcore accepts `systemcore` with its password.
// `links` names files in the folder that are symbolic links.
async function robot({ kind = "roborio" as "roborio" | "systemcore", password = "systemcore", missingHome = false, linked = false, denyWrite = false, missingFolder = false, denyMkdir = false, links = [] as string[] } = {}) {
  const folder = kind === "systemcore" ? systemcoreDirectory : directory;
  const files = new Map<string, Buffer>(missingFolder ? [] : [[`${folder}/existing.bdx`, Buffer.from("old")], [`${folder}/unrelated.bdx`, Buffer.from("untouched")]]);
  const directories = new Set(kind === "systemcore"
    ? ["/home", "/home/systemcore", "/home/systemcore/bordeaux", folder]
    : ["/home", "/home/lvuser", "/home/lvuser/natinst", "/home/lvuser/natinst/bin", folder]);
  // A fresh Systemcore has no Bordeaux folder at all.
  if (missingFolder) { directories.delete(folder); if (kind === "systemcore") directories.delete("/home/systemcore/bordeaux"); }
  if (missingHome) directories.delete("/home/systemcore");
  const created: string[] = [];
  const writes: string[] = [];
  const writeModes: Array<number | undefined> = [];
  const authentication: string[] = [];
  const clients = new Set<Connection>();
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));
    client.on("authentication", (ctx) => {
      authentication.push(ctx.method);
      const roborio = kind === "roborio" && ctx.username === "admin" && (ctx.method === "none" || (ctx.method === "password" && ctx.password === ""));
      const systemcore = kind === "systemcore" && ctx.username === "systemcore" && ctx.method === "password" && ctx.password === password;
      if (roborio || systemcore) ctx.accept();
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
          const link = (linked && target === "/home/lvuser/natinst") || links.some((name) => target === `${folder}/${name}`);
          const type = link && !follow ? 0o120000 : directories.has(target) ? 0o040000 : 0o100000;
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
  return { files, writes, writeModes, created, authentication, endpoint: { target: kind, host: "127.0.0.1", port: (server.address() as AddressInfo).port, directory: folder } };
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

describe("Systemcore path delivery against a real SSH/SFTP connection", () => {
  it("reviews the host identity before authenticating with a custom password", async () => {
    const r = await robot({ kind: "systemcore", password: "test-custom" });
    const delivery = new RobotFileDelivery(null, async () => {});
    const identity = await delivery.probe(r.endpoint, { kind: "custom", password: "test-custom" });
    expect(r.authentication).toEqual([]);
    expect(delivery.current()).toBeNull();
    await delivery.trust(identity.hostKeyFingerprint);
    expect(r.authentication).toContain("password");
    expect(delivery.current()).toEqual(identity);
    expect(r.writes).toEqual([]);
  }, 15_000);

  it("rejects a changed host key before the server receives password authentication", async () => {
    const r = await robot({ kind: "systemcore", password: "test-custom" });
    await expect(probeRobotFiles(r.endpoint, undefined, 5000, "test-custom", `SHA256:${"a".repeat(43)}`))
      .rejects.toThrow(/identity|host key/i);
    expect(r.authentication).toEqual([]);
  }, 15_000);

  it("creates the Bordeaux folder on first upload and delivers a path and a routine readable by the robot", async () => {
    const r = await robot({ kind: "systemcore", missingFolder: true });
    const connection = await probeRobotFiles(r.endpoint);
    expect(r.created).toEqual([]); expect(r.writes).toEqual([]);
    const path = Buffer.from([0, 255, 128, 10]), routine = Buffer.from('{"schema":"bordeaux-routine-runtime/1"}');
    expect(await uploadRobotFiles(connection, [{ fileName: "Opening.bdx", contents: path }, { fileName: "Opening.bdr", contents: routine }])).toEqual({ directoryCreated: true });
    expect(r.created).toEqual(["/home/systemcore/bordeaux", systemcoreDirectory]);
    expect(r.files).toEqual(new Map([[`${systemcoreDirectory}/Opening.bdx`, path], [`${systemcoreDirectory}/Opening.bdr`, routine]]));
    expect(r.writeModes).toEqual([0o644, 0o644]);
  }, 15_000);

  it("replaces an existing path and leaves unrelated files", async () => {
    const r = await robot({ kind: "systemcore" });
    const contents = Buffer.from("new");
    expect(await uploadRobotFiles(await probeRobotFiles(r.endpoint), [{ fileName: "existing.bdx", contents }])).toEqual({ directoryCreated: false });
    expect(r.files.get(`${systemcoreDirectory}/existing.bdx`)).toEqual(contents);
    expect(r.files.get(`${systemcoreDirectory}/unrelated.bdx`)?.toString()).toBe("untouched");
  }, 15_000);

  it("reports a changed Systemcore password without writing", async () => {
    const r = await robot({ kind: "systemcore", password: "changed" });
    const failure = await probeRobotFiles(r.endpoint).catch((error) => error);
    expect(failure.code).toBe("auth_rejected");
    expect(failure.message).toBe("Systemcore login refused; check the robot type and password. The robot rejected SSH login for systemcore with the default Systemcore password.");
    expect(r.writes).toEqual([]); expect(r.created).toEqual([]);
  }, 15_000);

  it("delivers with a custom password on a Systemcore whose password was changed", async () => {
    const r = await robot({ kind: "systemcore", password: "team-2468", missingFolder: true });
    const connection = await probeRobotFiles(r.endpoint, undefined, undefined, "team-2468");
    const contents = Buffer.from([1, 2, 3]);
    expect(await uploadRobotFiles(connection, [{ fileName: "Custom.bdx", contents }], undefined, undefined, "team-2468")).toEqual({ directoryCreated: true });
    expect(r.files.get(`${systemcoreDirectory}/Custom.bdx`)).toEqual(contents);
  }, 15_000);

  it("tells a roboRIO login that reached a Systemcore to check the robot type", async () => {
    const r = await robot({ kind: "systemcore" });
    const failure = await probeRobotFiles({ ...r.endpoint, target: "roborio", directory }).catch((error) => error);
    expect(failure.code).toBe("auth_rejected");
    expect(failure.message).toBe("roboRIO login refused; check the robot type. The robot rejected SSH login for admin.");
    expect(r.writes).toEqual([]);
  }, 15_000);

  it("never creates the systemcore home when it is missing", async () => {
    const r = await robot({ kind: "systemcore", missingFolder: true, missingHome: true });
    await expect(probeRobotFiles(r.endpoint)).rejects.toThrow("Required robot directory /home/systemcore is unavailable");
    expect(r.created).toEqual([]); expect(r.writes).toEqual([]);
  }, 15_000);
});

/**
 * Reading asks a robot what it holds, so it must never change the robot and never trust more than Push does.
 *
 * Ways it can fail, each covered below:
 *  1. It writes, renames, removes or creates something on the robot.
 *  2. It returns other bytes than the robot holds: binary values, or a file longer than one SFTP read.
 *  3. A file or a whole folder the robot lacks is reported as an error instead of as absent.
 *  4. It follows a link placed at a file name, and returns a file from outside the push folder.
 *  5. It logs in to a robot whose host key is not the trusted one, or with no trusted robot at all.
 *  6. It reads a name that is not a reviewed kind of file, or reaches outside the push folder.
 *  7. It logs in with the default password on a robot whose trusted login uses a custom one.
 *  8. It discards a push review the person is still looking at.
 *  9. A robot folder full of large files exhausts memory.
 */
describe("reading pushed files back over a real SSH/SFTP connection", () => {
  async function trusted(r: Awaited<ReturnType<typeof robot>>, password?: { kind: "custom"; password: string }) {
    const delivery = new RobotFileDelivery(null, async () => {});
    const identity = await delivery.probe(r.endpoint, password);
    await delivery.trust(identity.hostKeyFingerprint);
    return { delivery, identity };
  }
  const contents = (reading: Awaited<ReturnType<RobotFileDelivery["read"]>>) => reading.files.map((file) => [file.fileName, file.contents && Buffer.from(file.contents)]);

  it("returns each named file's bytes, reports a missing one as absent, and changes nothing", async () => {
    const r = await robot({ linked: true });
    // Longer than one SFTP read, with every byte value.
    const long = randomBytes(200_000);
    r.files.set(`${directory}/long.bdx`, long);
    const before = new Map(r.files);
    const { delivery, identity } = await trusted(r);
    const started = Date.now();
    const reading = await delivery.read(["existing.bdx", "long.bdx", "absent.bdx"]);
    expect(contents(reading)).toEqual([["existing.bdx", Buffer.from("old")], ["long.bdx", long], ["absent.bdx", null]]);
    expect(reading.connection).toEqual(identity);
    expect(Date.parse(reading.readAt)).toBeGreaterThanOrEqual(started);
    expect(r.files).toEqual(before); expect(r.writes).toEqual([]); expect(r.created).toEqual([]);
  }, 15_000);

  it("reports every file absent when the robot has no push folder yet, without creating it", async () => {
    const r = await robot({ kind: "systemcore", missingFolder: true });
    const { delivery } = await trusted(r);
    expect(contents(await delivery.read(["Opening.bdx", "Opening.bdr"]))).toEqual([["Opening.bdx", null], ["Opening.bdr", null]]);
    expect(r.created).toEqual([]); expect(r.writes).toEqual([]); expect(r.files.size).toBe(0);
  }, 15_000);

  it("refuses a link at a file name and returns no file", async () => {
    const r = await robot({ links: ["existing.bdx"] });
    const { delivery } = await trusted(r);
    await expect(delivery.read(["unrelated.bdx", "existing.bdx"])).rejects.toThrow(/existing\.bdx.*not a regular file/);
  }, 15_000);

  it("refuses a robot whose host key is not the trusted one, before sending a password", async () => {
    const r = await robot({ kind: "systemcore" });
    const delivery = new RobotFileDelivery({ endpoint: r.endpoint, hostKeyFingerprint: `SHA256:${"a".repeat(43)}` }, async () => {});
    await expect(delivery.read(["existing.bdx"])).rejects.toThrow(/host key changed/);
    expect(r.authentication).toEqual([]);
  }, 15_000);

  it("refuses without a trusted robot", async () => {
    const r = await robot();
    const unpaired = new RobotFileDelivery(null, async () => {}), untrusted = new RobotFileDelivery({ endpoint: r.endpoint }, async () => {});
    await expect(unpaired.read(["existing.bdx"])).rejects.toThrow(/Connect a robot/);
    await expect(untrusted.read(["existing.bdx"])).rejects.toThrow(/Connect a robot/);
    expect(r.authentication).toEqual([]);
  }, 15_000);

  it.each<[string, unknown]>([
    ["a name outside the folder", ["../existing.bdx"]], ["a folder in the name", ["Paths/existing.bdx"]], ["another kind of file", ["startup.rtexe"]],
    ["no names", []], ["a name twice", ["existing.bdx", "existing.bdx"]], ["more than 64 names", Array.from({ length: 65 }, (_, index) => `path-${index}.bdx`)],
    ["one name instead of a list", "existing.bdx"], ["a name that is not text", [7]],
  ])("refuses %s before connecting", async (_case, names) => {
    const r = await robot();
    const { delivery } = await trusted(r);
    const logins = r.authentication.length;
    await expect(delivery.read(names)).rejects.toThrow();
    expect(r.authentication).toHaveLength(logins);
  }, 15_000);

  it("logs in with the trusted custom password", async () => {
    const r = await robot({ kind: "systemcore", password: "team-2468" });
    const { delivery } = await trusted(r, { kind: "custom", password: "team-2468" });
    expect(contents(await delivery.read(["existing.bdx"]))).toEqual([["existing.bdx", Buffer.from("old")]]);
  }, 15_000);

  it("leaves a push review ready to confirm", async () => {
    const r = await robot();
    const { delivery } = await trusted(r);
    const review = delivery.prepare([{ pathId: "path-1", name: "New", fileName: "new.bdx", contents: Buffer.from("reviewed") }], async () => {});
    await delivery.read(["existing.bdx", "new.bdx"]);
    await expect(delivery.confirm(review.operationId)).resolves.toMatchObject({ state: "transferred" });
    expect(r.files.get(`${directory}/new.bdx`)).toEqual(Buffer.from("reviewed"));
  }, 15_000);

  it("refuses a file over 24 MiB, and files that pass 24 MiB together", async () => {
    const r = await robot();
    r.files.set(`${directory}/huge.bdx`, Buffer.alloc(24 * 1024 * 1024 + 1));
    r.files.set(`${directory}/half-a.bdx`, Buffer.alloc(13 * 1024 * 1024, 1));
    r.files.set(`${directory}/half-b.bdx`, Buffer.alloc(13 * 1024 * 1024, 2));
    const { delivery } = await trusted(r);
    await expect(delivery.read(["huge.bdx"])).rejects.toThrow(/huge\.bdx/);
    await expect(delivery.read(["half-a.bdx", "half-b.bdx"])).rejects.toThrow(/more than 24 MiB/);
  }, 30_000);
});
