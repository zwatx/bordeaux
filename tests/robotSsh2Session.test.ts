import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { connectRobotSftp } from "../src/electron/robotSsh2Session";
import { probeRobotFiles, uploadRobotFiles } from "../src/electron/robotFileTransfer";
import type { RobotRemoteFile } from "../src/electron/robotSftpTransport";

const mock = vi.hoisted(() => ({ sftp: {} as Record<string, unknown>, connect: vi.fn() }));
vi.mock("ssh2", async () => {
  const { EventEmitter } = await import("node:events");
  return { Client: class extends EventEmitter {
    connect(options: { hostVerifier: (key: Buffer) => boolean }) {
      mock.connect(options);
      if (!options.hostVerifier(Buffer.from("host key"))) this.emit("error", new Error("Rejected host"));
      else queueMicrotask(() => this.emit("ready"));
    }
    sftp(callback: (error: null, sftp: unknown) => void) { callback(null, mock.sftp); }
    end() {}
    destroy() {}
  } };
});

function setup(entries: Record<string, "dir" | "link" | "file">) {
  const stored = new Map<string, Buffer>();
  const mkdir = vi.fn((target: string, _options: unknown, callback: (error?: Error) => void) => { entries[target] = "dir"; callback(); });
  mock.sftp = {
    lstat: vi.fn((target: string, callback: (error: unknown, stat?: unknown) => void) => {
      const kind = entries[target];
      if (!kind) callback({ code: 2 });
      else callback(null, { size: stored.get(target)?.length ?? 0, isDirectory: () => kind === "dir", isSymbolicLink: () => kind === "link", isFile: () => kind === "file" });
    }),
    stat: vi.fn((target: string, callback: (error: unknown, stat?: unknown) => void) => {
      const kind = entries[target];
      if (!kind) callback({ code: 2 });
      else callback(null, { isDirectory: () => kind === "dir" || kind === "link", isSymbolicLink: () => false, isFile: () => kind === "file" });
    }),
    rename: vi.fn((from: string, to: string, callback: () => void) => {
      entries[to] = "file"; stored.set(to, stored.get(from)!); delete entries[from]; stored.delete(from); callback();
    }),
    unlink: vi.fn((target: string, callback: () => void) => { delete entries[target]; stored.delete(target); callback(); }),
    mkdir,
    writeFile: vi.fn((target: string, bytes: Buffer, _options: unknown, callback: () => void) => {
      entries[target] = "file"; stored.set(target, Buffer.from(bytes)); callback();
    }),
    createReadStream: vi.fn((target: string) => Readable.from([stored.get(target)!])),
    ext_openssh_rename: vi.fn((from: string, to: string, callback: () => void) => {
      entries[to] = "file"; stored.set(to, stored.get(from)!); delete entries[from]; stored.delete(from); callback();
    }),
    end: vi.fn(),
  };
  return { mkdir, stored };
}
const signal = new AbortController().signal;
const connect = () => connectRobotSftp({ endpoint: { host: "robot.local", port: 22 }, credentials: { password: "" }, signal, timeoutMs: 2000 });

describe("direct file SSH session confinement", () => {
  it.each(["admin", undefined] as const)("connects to the specified endpoint with account %s", async (username) => {
    setup({});
    const session = await connectRobotSftp({ endpoint: { host: "10.24.68.2", port: 2222 }, credentials: { username, password: "" }, signal, timeoutMs: 2000 });
    try {
      expect(mock.connect).toHaveBeenLastCalledWith(expect.objectContaining({ host: "10.24.68.2", port: 2222, username: username ?? "lvuser", password: "" }));
    } finally { await session.close(); }
  });

  it("keeps legacy mailbox control files private", async () => {
    setup({});
    const session = await connect();
    try {
      await session.write({ kind: "incomingTemporary", nonce: "review", token: "a".repeat(32) }, Buffer.from("revision"), signal);
      expect(mock.sftp.writeFile).toHaveBeenCalledWith(expect.any(String), Buffer.from("revision"), { flag: "wx", mode: 0o600 }, expect.any(Function));
    } finally { await session.close(); }
  });

  it.each(["/natinst", "/natinst/bin", "/home", "/home/lvuser"])("rejects missing required parent %s during read-only probe and upload", async (missing) => {
    const entries = { "/natinst": "dir", "/natinst/bin": "dir", "/home": "dir", "/home/lvuser": "dir" } as const;
    const f = setup(Object.fromEntries(Object.entries(entries).filter(([name]) => name !== missing)));
    const endpoint = { host: "robot.local", port: 22, directory: missing.startsWith("/natinst") ? "/natinst/bin/Paths" : "/home/lvuser/natinst/bin/Paths" };
    await expect(probeRobotFiles(endpoint)).rejects.toThrow(`Required robot directory ${missing} is unavailable`);
    const session = await connect();
    const connection = { endpoint, hostKeyFingerprint: session.hostKeyFingerprint };
    await session.close();
    await expect(uploadRobotFiles(connection, [{ fileName: "one.bdx", contents: Buffer.from("bdx") }]))
      .rejects.toThrow(`Required robot directory ${missing} is unavailable`);
    expect(f.mkdir).not.toHaveBeenCalled();
    expect(mock.sftp.writeFile).not.toHaveBeenCalled();
  });

  it("uploads to the LabVIEW runtime directory, creating missing children under lvuser and preserving other files", async () => {
    const directory = "/home/lvuser/natinst/bin/Paths";
    const f = setup({ "/home": "dir", "/home/lvuser": "dir", "/home/lvuser/unrelated.bdx": "file" });
    f.stored.set("/home/lvuser/unrelated.bdx", Buffer.from("preserve"));
    const connection = await probeRobotFiles({ host: "robot.local", port: 22, directory });
    expect(f.mkdir).not.toHaveBeenCalled();
    const contents = Buffer.from([0, 1, 255, 128]);
    expect(await uploadRobotFiles(connection, [{ fileName: "one.bdx", contents }])).toEqual({ directoryCreated: true });
    expect(f.mkdir.mock.calls.map(([target]) => target)).toEqual([
      "/home/lvuser/natinst", "/home/lvuser/natinst/bin", directory,
    ]);
    expect(f.stored).toEqual(new Map([
      ["/home/lvuser/unrelated.bdx", Buffer.from("preserve")], [`${directory}/one.bdx`, contents],
    ]));
    expect(mock.sftp.createReadStream).toHaveBeenCalledTimes(2);
  });

  it("keeps probe read-only when the Paths directory is absent, then creates it only on upload", async () => {
    const f = setup({ "/natinst": "dir", "/natinst/bin": "dir" });
    const session = await connect();
    try {
      expect(await session.ensureDirectory!("/natinst/bin/Paths", false, signal)).toEqual({ created: false });
      expect(f.mkdir).not.toHaveBeenCalled();
      expect(await session.ensureDirectory!("/natinst/bin/Paths", true, signal)).toEqual({ created: true });
      expect(f.mkdir).toHaveBeenCalledWith("/natinst/bin/Paths", { mode: 0o755 }, expect.any(Function));
      expect(await session.ensureDirectory!("/natinst/bin/Paths", true, signal)).toEqual({ created: false });
      expect(f.mkdir).toHaveBeenCalledOnce();
    } finally { await session.close(); }
  });

  it("accepts a directory created concurrently without claiming it made the folder", async () => {
    const entries = { "/natinst": "dir", "/natinst/bin": "dir" } as Record<string, "dir" | "file">;
    setup(entries);
    mock.sftp.mkdir = vi.fn((target, _options, callback) => {
      entries[target] = "dir";
      callback(Object.assign(new Error("Already exists"), { code: 4 }));
    });
    const session = await connect();
    try { expect(await session.ensureDirectory!("/natinst/bin/Paths", true, signal)).toEqual({ created: false }); }
    finally { await session.close(); }
  });

  it.each(["absent", "file", "denied"])("rejects failed mkdir (%s) before file writes without claiming creation", async (kind) => {
    const entries = { "/natinst": "dir", "/natinst/bin": "dir" } as Record<string, "dir" | "file">;
    setup(entries);
    mock.sftp.mkdir = vi.fn((target, _options, callback) => {
      if (kind === "file") entries[target] = "file";
      callback(Object.assign(new Error(kind === "denied" ? "Permission denied" : "Cannot create"), { code: kind === "denied" ? 3 : 4 }));
    });
    const connection = await probeRobotFiles({ host: "robot.local", port: 22, directory: "/natinst/bin/Paths" });
    const failure = await uploadRobotFiles(connection, [{ fileName: "one.bdx", contents: Buffer.from("bdx") }]).catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).not.toContain("Created robot folder");
    expect(mock.sftp.writeFile).not.toHaveBeenCalled();
  });

  it("does not treat a cancelled mkdir as confirmed creation or continue uploading", async () => {
    setup({ "/natinst": "dir", "/natinst/bin": "dir" });
    const cancel = new AbortController();
    mock.sftp.mkdir = vi.fn((_target, _options, callback) => { cancel.abort(); callback(); });
    const connection = await probeRobotFiles({ host: "robot.local", port: 22, directory: "/natinst/bin/Paths" });
    const failure = await uploadRobotFiles(connection, [{ fileName: "one.bdx", contents: Buffer.from("bdx") }], cancel.signal).catch(error => error);
    expect(failure.code).toBe("cancelled");
    expect(failure.message).not.toContain("Created robot folder");
    expect(mock.sftp.writeFile).not.toHaveBeenCalled();
  });

  it("rejects an unacknowledged mkdir on timeout without continuing to file writes", async () => {
    setup({ "/natinst": "dir", "/natinst/bin": "dir" });
    mock.sftp.mkdir = vi.fn();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const session = await connect();
    try {
      const failure = expect(session.ensureDirectory!("/natinst/bin/Paths", true, signal)).rejects.toMatchObject({ code: "timed_out" });
      await vi.advanceTimersByTimeAsync(2000);
      await failure;
      expect(mock.sftp.mkdir).toHaveBeenCalledOnce();
      expect(mock.sftp.writeFile).not.toHaveBeenCalled();
    } finally { await session.close(); vi.useRealTimers(); }
  });

  it.each(["file"] as const)("rejects a %s in destination ancestry", async (kind) => {
    setup({ "/natinst": "dir", "/natinst/bin": kind });
    const session = await connect();
    try { await expect(session.ensureDirectory!("/natinst/bin/Paths", true, signal)).rejects.toThrow("non-directory"); }
    finally { await session.close(); }
  });

  it.each(["file"] as const)("rejects a %s below lvuser before creating any descendant", async (kind) => {
    const f = setup({ "/home": "dir", "/home/lvuser": "dir", "/home/lvuser/natinst": kind });
    const session = await connect();
    try {
      for (const create of [false, true]) {
        await expect(session.ensureDirectory!("/home/lvuser/natinst/bin/Paths", create, signal))
          .rejects.toThrow("non-directory");
      }
      expect(f.mkdir).not.toHaveBeenCalled();
      expect(mock.sftp.writeFile).not.toHaveBeenCalled();
    } finally { await session.close(); }
  });

  it("uses exclusive writes and the atomic rename extension within the reviewed directory", async () => {
    setup({});
    const session = await connect();
    const temporary: RobotRemoteFile = { kind: "pathTemporary", directory: "/natinst/bin/Paths", fileName: "one.bdx", token: "a".repeat(32) };
    const destination: RobotRemoteFile = { kind: "pathFile", directory: temporary.directory, fileName: temporary.fileName };
    try {
      await session.write(temporary, Buffer.from("bdx"), signal);
      expect(mock.sftp.writeFile).toHaveBeenCalledWith(`/natinst/bin/Paths/.bordeaux-one.bdx-${"a".repeat(32)}.tmp`, Buffer.from("bdx"), { flag: "wx", mode: 0o644 }, expect.any(Function));
      await session.renameSameDirectory(temporary, destination, signal);
      expect(mock.sftp.ext_openssh_rename).toHaveBeenCalledOnce();
      expect(() => session.renameSameDirectory(temporary, { ...destination, directory: "/home/lvuser" }, signal)).toThrow();
      expect(() => session.write(destination, Buffer.from("bdx"), signal)).toThrow();
    } finally { await session.close(); }
  });

  it("rejects a symlink at the selected filename instead of overwriting it", async () => {
    setup({ "/natinst/bin/Paths/one.bdx": "link" });
    const session = await connect();
    try { await expect(session.exists({ kind: "pathFile", directory: "/natinst/bin/Paths", fileName: "one.bdx" }, signal)).rejects.toThrow("not a regular file"); }
    finally { await session.close(); }
  });
});


describe("direct file compatibility", () => {
  const directory = "/home/lvuser/natinst/bin/Paths";
  const entries = () => ({ "/home": "dir", "/home/lvuser": "dir", "/home/lvuser/natinst": "link", "/home/lvuser/natinst/bin": "dir", [directory]: "dir" } as const);
  it("follows a linked LabVIEW directory without creating anything during probe", async () => {
    const f = setup(entries());
    await expect(probeRobotFiles({ host: "robot.local", port: 22, directory })).resolves.toMatchObject({ endpoint: { directory } });
    expect(mock.sftp.stat).toHaveBeenCalledWith("/home/lvuser/natinst", expect.any(Function));
    expect(f.mkdir).not.toHaveBeenCalled();
  });
  it.each([false, true])("publishes without the OpenSSH extension (destination exists: %s)", async (exists) => {
    const f = setup({ ...entries(), ...(exists ? { [`${directory}/one.bdx`]: "file" as const } : {}), [`${directory}/other.bdx`]: "file" });
    f.stored.set(`${directory}/other.bdx`, Buffer.from("keep"));
    if (exists) f.stored.set(`${directory}/one.bdx`, Buffer.from("old"));
    mock.sftp.ext_openssh_rename = vi.fn(() => { throw new Error("Server does not support this extended request"); });
    const connection = await probeRobotFiles({ host: "robot.local", port: 22, directory });
    await uploadRobotFiles(connection, [{ fileName: "one.bdx", contents: Buffer.from("new") }]);
    expect(f.stored).toEqual(new Map([[`${directory}/other.bdx`, Buffer.from("keep")], [`${directory}/one.bdx`, Buffer.from("new")]]));
    expect(mock.sftp.rename).toHaveBeenCalledTimes(exists ? 0 : 1);
    const writes = vi.mocked(mock.sftp.writeFile as ReturnType<typeof vi.fn>).mock.calls;
    expect(writes.filter(([name]) => name === `${directory}/one.bdx`)).toHaveLength(exists ? 1 : 0);
    expect(vi.mocked(mock.sftp.unlink as ReturnType<typeof vi.fn>).mock.calls.every(([name]) => name.includes(".bordeaux-"))).toBe(true);
  });
  it.each([3, 4, 7, "ECONNRESET", "AUTH_FAILED"])("does not fall back on SFTP error %s", async (code) => {
    setup(entries());
    mock.sftp.ext_openssh_rename = vi.fn((_from, _to, callback) => callback(Object.assign(new Error(code === 3 ? "Server does not support this extended request" : "Denied operation"), { code })));
    const connection = await probeRobotFiles({ host: "robot.local", port: 22, directory });
    await expect(uploadRobotFiles(connection, [{ fileName: "one.bdx", contents: Buffer.from("new") }])).rejects.toThrow();
    expect(mock.sftp.rename).not.toHaveBeenCalled();
    expect(vi.mocked(mock.sftp.writeFile as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
  it("reports uncertainty when a compatibility overwrite fails, without deleting the destination", async () => {
    setup({ ...entries(), [`${directory}/one.bdx`]: "file" });
    mock.sftp.ext_openssh_rename = vi.fn((_from, _to, callback) => callback(Object.assign(new Error("Unsupported"), { code: 8 })));
    const originalWrite = mock.sftp.writeFile as Function;
    mock.sftp.writeFile = vi.fn((name, contents, options, callback) => {
      if (name === `${directory}/one.bdx`) callback(Object.assign(new Error("Disk full"), { code: 4 }));
      else originalWrite(name, contents, options, callback);
    });
    const connection = await probeRobotFiles({ host: "robot.local", port: 22, directory });
    await expect(uploadRobotFiles(connection, [{ fileName: "one.bdx", contents: Buffer.from("new") }])).rejects.toThrow(/Disk full.*may have been replaced/);
    expect(vi.mocked(mock.sftp.unlink as ReturnType<typeof vi.fn>).mock.calls.every(([name]) => name.includes(".bordeaux-"))).toBe(true);
  });
});


describe("rename fallback boundaries", () => {
  const directory = "/home/lvuser/natinst/bin/Paths";
  const temporary: RobotRemoteFile = { kind: "pathTemporary", directory, fileName: "one.bdx", token: "a".repeat(32) };
  const destination: RobotRemoteFile = { kind: "pathFile", directory, fileName: "one.bdx" };
  it("keeps legacy inbox publishing atomic when the extension is unavailable", async () => {
    setup({});
    mock.sftp.ext_openssh_rename = vi.fn(() => { throw new Error("Server does not support this extended request"); });
    const session = await connect();
    try {
      await expect(session.renameSameDirectory({ kind: "incomingTemporary", nonce: "n", token: "a".repeat(32) }, { kind: "incomingRevision", nonce: "n" }, signal)).rejects.toThrow("does not support");
      expect(mock.sftp.rename).not.toHaveBeenCalled();
      expect(mock.sftp.writeFile).not.toHaveBeenCalled();
    } finally { await session.close(); }
  });
  it("rejects final symlinks before compatibility copy", async () => {
    setup({ [`${directory}/one.bdx`]: "link" });
    mock.sftp.ext_openssh_rename = vi.fn(() => { throw new Error("Server does not support this extended request"); });
    const session = await connect();
    try {
      await expect(session.renameSameDirectory(temporary, destination, signal)).rejects.toThrow("not a regular file");
      expect(mock.sftp.rename).not.toHaveBeenCalled();
      expect(mock.sftp.writeFile).not.toHaveBeenCalled();
    } finally { await session.close(); }
  });
  it("retains actual server diagnostics instead of suggesting an unrelated network", async () => {
    setup({});
    mock.sftp.ext_openssh_rename = vi.fn((_from, _to, callback) => callback(Object.assign(new Error("Disk full"), { code: 4 })));
    const session = await connect();
    try {
      await expect(session.renameSameDirectory(temporary, destination, signal)).rejects.toThrow("Disk full; code 4");
      expect(mock.sftp.rename).not.toHaveBeenCalled();
    } finally { await session.close(); }
  });
  it("gives cancellation priority over an unsupported-extension reply", async () => {
    setup({});
    const cancel = new AbortController();
    mock.sftp.ext_openssh_rename = vi.fn((_from, _to, callback) => { cancel.abort(); callback(Object.assign(new Error("Unsupported"), { code: 8 })); });
    const session = await connect();
    try {
      await expect(session.renameSameDirectory(temporary, destination, cancel.signal)).rejects.toMatchObject({ code: "cancelled" });
      expect(mock.sftp.rename).not.toHaveBeenCalled();
      expect(mock.sftp.writeFile).not.toHaveBeenCalled();
    } finally { await session.close(); }
  });
});
