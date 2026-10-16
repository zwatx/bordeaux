import { describe, expect, it } from "vitest";
import { probeRobotFiles, uploadRobotFiles, validateRobotFileEndpoint } from "../src/electron/robotFileTransfer";
import type { RobotConnectRequest, RobotRemoteFile, RobotSftpSession } from "../src/electron/robotSftpTransport";

const endpoint = { host: "roborio-2468-frc.local", port: 22, directory: "/natinst/bin/Paths" };
const fingerprint = `SHA256:${"a".repeat(43)}`;
function fixture() {
  const stored = new Map<string, Buffer>([["unrelated.bdx", Buffer.from("preserve")]]);
  const requests: RobotConnectRequest[] = [];
  const directories: boolean[] = [];
  const removed: string[] = [];
  const key = (file: RobotRemoteFile) => {
    if (file.kind === "pathFile") return file.fileName;
    if (file.kind === "pathTemporary") return `${file.fileName}.${file.token}.tmp`;
    throw new Error("No receiver or runtime files exist on this robot");
  };
  let closed = 0;
  const session: RobotSftpSession = {
    hostKeyFingerprint: fingerprint,
    async ensureDirectory(_directory, create) { directories.push(create); return { created: false }; },
    async read(file) { const value = stored.get(key(file)); if (!value) throw new Error("Absent file"); return value; },
    async write(file, data) { if (stored.has(key(file))) throw new Error("Exists"); stored.set(key(file), Buffer.from(data)); },
    async exists(file) { return stored.has(key(file)); },
    async renameSameDirectory(from, to) { stored.set(key(to), stored.get(key(from))!); stored.delete(key(from)); },
    async remove(file) { removed.push(key(file)); stored.delete(key(file)); },
    async close() { closed += 1; },
  };
  const factory = async (request: RobotConnectRequest) => { requests.push(request); return session; };
  return { stored, session, factory, requests, directories, removed, closed: () => closed };
}
const connection = { endpoint, hostKeyFingerprint: fingerprint };
const files = [{ fileName: "opening.bdx", contents: Buffer.from([0, 1, 255, 128]) }];

describe("direct robot SFTP path delivery", () => {
  it("normalizes trailing slashes on the requested destination", () => {
    expect(validateRobotFileEndpoint({ ...endpoint, directory: "/natinst/bin/Paths///" })).toEqual(endpoint);
    expect(validateRobotFileEndpoint({ ...endpoint, directory: "/home/lvuser/" }).directory).toBe("/home/lvuser");
  });
  it("probes SSH and directories without a receiver or writes", async () => {
    const f = fixture();
    expect(await probeRobotFiles(endpoint, f.factory)).toEqual(connection);
    expect(f.requests[0].credentials).toEqual({ username: "admin", password: "" });
    expect(f.directories).toEqual([false]);
    expect(f.stored.size).toBe(1);
    expect(f.closed()).toBe(1);
  });

  it("pins host identity and publishes exact bytes while preserving other paths", async () => {
    const f = fixture();
    f.stored.set("opening.bdx", Buffer.from("old"));
    expect(await uploadRobotFiles(connection, files, undefined, f.factory)).toEqual({ directoryCreated: false });
    expect(f.requests[0].expectedHostKeyFingerprint).toBe(fingerprint);
    expect(f.requests[0].credentials).toEqual({ username: "admin", password: "" });
    expect(f.stored.get("opening.bdx")).toEqual(files[0].contents);
    expect(f.stored.get("unrelated.bdx")?.toString()).toBe("preserve");
    expect(f.stored.size).toBe(2);
    expect(f.closed()).toBe(1);
  });

  it("reports a confirmed folder creation even when later read-back fails", async () => {
    const f = fixture();
    f.session.ensureDirectory = async (_directory, create) => ({ created: create });
    f.session.read = async () => Buffer.from("corrupt");
    await expect(uploadRobotFiles(connection, files, undefined, f.factory))
      .rejects.toThrow(`0 of 1 files verified on the robot. Created robot folder ${endpoint.directory}.`);
    expect(f.stored.has("opening.bdx")).toBe(false);
  });

  it("does not connect or mutate when already cancelled", async () => {
    const f = fixture();
    const cancel = new AbortController(); cancel.abort();
    await expect(uploadRobotFiles(connection, files, cancel.signal, f.factory)).rejects.toThrow();
    expect(f.requests).toEqual([]); expect(f.directories).toEqual([]);
  });

  it("reports known folder creation without claiming files were uploaded when cancelled afterwards", async () => {
    const f = fixture();
    const cancel = new AbortController();
    f.session.ensureDirectory = async () => { cancel.abort(); return { created: true }; };
    const failure = await uploadRobotFiles(connection, files, cancel.signal, f.factory).catch(error => error);
    expect(failure.code).toBe("cancelled");
    expect(failure.message).toContain(`0 of 1 files verified on the robot. Created robot folder ${endpoint.directory}.`);
    expect(f.stored.size).toBe(1); expect(f.stored.has("opening.bdx")).toBe(false);
  });

  it("rejects changed host keys before creating directories or writing", async () => {
    const f = fixture();
    Object.defineProperty(f.session, "hostKeyFingerprint", { value: `SHA256:${"b".repeat(43)}` });
    await expect(uploadRobotFiles(connection, files, undefined, f.factory)).rejects.toThrow("host key changed");
    expect(f.directories).toEqual([]);
    expect(f.closed()).toBe(1);
  });

  it("rejects corrupted staging bytes without replacing the destination", async () => {
    const f = fixture();
    f.session.read = async () => Buffer.from("corrupt");
    await expect(uploadRobotFiles(connection, files, undefined, f.factory)).rejects.toThrow("0 of 1 files verified");
    expect(f.stored.has("opening.bdx")).toBe(false);
    expect(f.removed).toHaveLength(1);
    expect(f.closed()).toBe(1);
  });

  it("reports partial uploads honestly when a later publication cannot be verified", async () => {
    const f = fixture();
    const read = f.session.read;
    f.session.read = async (file, ...args) => file.kind === "pathFile" && file.fileName === "second.bdx"
      ? Buffer.from("corrupted after rename") : read(file, ...args);
    await expect(uploadRobotFiles(connection, [...files, { fileName: "second.bdx", contents: Buffer.from("second") }], undefined, f.factory))
      .rejects.toThrow("1 of 2 files verified on the robot (opening.bdx). second.bdx may have been replaced");
    expect(f.stored.has("opening.bdx")).toBe(true);
    expect(f.closed()).toBe(1);
  });

  it("cancels before publication and uses a fresh signal to clean temporary bytes", async () => {
    const f = fixture();
    const controller = new AbortController();
    const write = f.session.write;
    f.session.write = async (...args) => { await write(...args); controller.abort(); };
    const remove = f.session.remove;
    f.session.remove = async (file, signal) => { expect(signal.aborted).toBe(false); await remove(file, signal); };
    await expect(uploadRobotFiles(connection, files, controller.signal, f.factory)).rejects.toThrow("cancelled");
    expect(f.stored.has("opening.bdx")).toBe(false);
    expect(f.removed).toHaveLength(1);
    expect(f.closed()).toBe(1);
  });

  it.each(["/etc", "/home/lvuser/../etc", "/home/lvuser/link/../../etc", "/home/lvuser\\escape", "/home/lvuser/a\0b"])("rejects directory %s", (directory) => {
    expect(() => validateRobotFileEndpoint({ ...endpoint, directory })).toThrow();
  });

  it.each(["../evil.bdx", "a/b.bdx", "a\\b.bdx", "a\0b.bdx", ".hidden.bdx", "wrong.json"])("rejects filename %s before connecting", async (fileName) => {
    const f = fixture();
    await expect(uploadRobotFiles(connection, [{ fileName, contents: Buffer.from("test") }], undefined, f.factory)).rejects.toThrow();
    expect(f.requests).toEqual([]);
  });

  it("rejects duplicate files, empty files, excessive count and excessive total bytes", async () => {
    const f = fixture();
    for (const invalid of [[...files, ...files], [{ fileName: "empty.bdx", contents: Buffer.alloc(0) }],
      Array.from({ length: 65 }, (_, i) => ({ fileName: `${i}.bdx`, contents: Buffer.from("x") })),
      [{ fileName: "large.bdx", contents: Buffer.alloc(24 * 1024 * 1024 + 1) }]]) {
      await expect(uploadRobotFiles(connection, invalid, undefined, f.factory)).rejects.toThrow();
    }
    expect(f.requests).toEqual([]);
  });
});
