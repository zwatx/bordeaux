import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RobotFileDelivery, readRobotFileConnection, writeRobotFileConnection, type PreparedRobotFile } from "../src/electron/robotFileDelivery";
import { DEFAULT_ROBOT_PATH_DIRECTORY, type RobotFileConnection, type RobotFileSettings } from "../src/shared/robotFileDelivery";
import { sessionRobotPasswordStore } from "../src/electron/robotPasswordStore";
const connection: RobotFileConnection = { endpoint: { target: "roborio", host: "roborio-2468-frc.local", port: 22, directory: DEFAULT_ROBOT_PATH_DIRECTORY }, hostKeyFingerprint: "SHA256:abcdefghijklmnopqrstuvxyz123456789" };
const file = (): PreparedRobotFile => ({ pathId: "path-1", name: "Opening", fileName: "Opening.bdx", contents: Buffer.from("BDX fixture") });
function setup(initial: RobotFileConnection | null = connection) {
  const persist = vi.fn(async () => undefined);
  const transport = { probe: vi.fn(async () => structuredClone(connection)), upload: vi.fn(async (_connection: RobotFileConnection, _files: Array<{ fileName: string; contents: Buffer }>, _signal?: AbortSignal) => ({ directoryCreated: false })) };
  return { delivery: new RobotFileDelivery(initial, persist, transport), persist, transport };
}
describe("reviewed robot file delivery", () => {
  it('keeps a selected routine immutable and rejects changed NI evidence before transport', async () => {
    const { delivery, transport } = setup();
    const original = { ...file(), pathId: 'routine-1', fileName: 'Opening.bdr', contents: Buffer.from('reviewed routine') };
    const review = delivery.prepare([original], async () => undefined);
    original.contents.fill(0);
    await delivery.confirm(review.operationId);
    expect(transport.upload.mock.calls[0][1]).toEqual([{ ...original, contents: Buffer.from('reviewed routine') }]);
    const changed = delivery.prepare([original], async () => { throw new Error('NI command evidence changed'); });
    await expect(delivery.confirm(changed.operationId)).rejects.toThrow('NI command evidence changed');
    expect(transport.upload).toHaveBeenCalledOnce();
  });
  it("checks the pinned robot without invalidating a reviewed upload or changing trust", async () => {
    const { delivery, transport, persist } = setup();
    const preview = delivery.prepare([file()], async () => undefined);
    expect(await delivery.checkConnection()).toEqual(connection);
    expect(transport.probe).toHaveBeenCalledWith(connection.endpoint, 5_000, null);
    transport.probe.mockRejectedValueOnce(new Error("unplugged"));
    expect(await delivery.checkConnection()).toBeNull();
    transport.probe.mockResolvedValueOnce({ ...connection, hostKeyFingerprint: "SHA256:anotherabcdefghijklmnopqr" });
    expect(await delivery.checkConnection()).toBeNull();
    expect(delivery.current()).toEqual(connection);
    expect(persist).not.toHaveBeenCalled();
    await expect(delivery.confirm(preview.operationId)).resolves.toMatchObject({ state: "transferred" });
  });
  it("discards a liveness reply from a previous destination or stopped session", async () => {
    const { delivery, transport } = setup();
    let finish!: (value: RobotFileConnection) => void;
    transport.probe.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const checking = delivery.checkConnection();
    await delivery.saveSettings({ ...connection.endpoint, host: "other.local" });
    finish(connection);
    expect(await checking).toBeNull();
    expect(await delivery.checkConnection()).toBeNull();
    expect(transport.probe).toHaveBeenCalledTimes(1);
  });
  it("saves directory edits locally, preserves host trust and invalidates old file reviews", async () => {
    const { delivery, transport, persist } = setup();
    const preview = delivery.prepare([file()], async () => undefined);
    const endpoint = { ...connection.endpoint, directory: "/home/lvuser/practice" };
    expect(await delivery.saveSettings(endpoint)).toEqual({ ...connection, endpoint });
    expect(delivery.current()).toEqual({ ...connection, endpoint });
    expect(persist).toHaveBeenCalledExactlyOnceWith({ ...connection, endpoint });
    await expect(delivery.confirm(preview.operationId)).rejects.toThrow(/Review/);
    expect(transport.probe).not.toHaveBeenCalled(); expect(transport.upload).not.toHaveBeenCalled();
  });
  it.each([{ host: "other.local" }, { port: 2222 }])("forgets SSH trust after editing identity %j without connecting", async (change) => {
    const { delivery, transport } = setup();
    const endpoint = { ...connection.endpoint, ...change };
    expect(await delivery.saveSettings(endpoint)).toEqual({ endpoint });
    expect(delivery.settings()).toEqual({ endpoint }); expect(delivery.current()).toBeNull();
    expect(() => delivery.prepare([file()], async () => undefined)).toThrow(/Connect/);
    expect(transport.probe).not.toHaveBeenCalled(); expect(transport.upload).not.toHaveBeenCalled();
  });
  it("retains saved settings after persistence failure and rejects stale probes", async () => {
    const { delivery, persist, transport } = setup();
    let finish!: (value: RobotFileConnection) => void;
    transport.probe.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const probing = delivery.probe(connection.endpoint);
    const rejectedProbe = expect(probing).rejects.toThrow(/newer connection/);
    persist.mockRejectedValueOnce(new Error("disk full"));
    await expect(delivery.saveSettings({ ...connection.endpoint, host: "other.local" })).rejects.toThrow("disk full");
    expect(delivery.settings()).toEqual(connection); expect(delivery.current()).toEqual(connection);
    finish(connection); await rejectedProbe;
    await expect(delivery.trust(connection.hostKeyFingerprint)).rejects.toThrow(/review/);
  });
  it("probes without writing and trusts only the observed SSH identity", async () => {
    const { delivery, transport, persist } = setup(null);
    await expect(delivery.trust(connection.hostKeyFingerprint)).rejects.toThrow(/Connect and review/);
    const observed = await delivery.probe(connection.endpoint);
    observed.endpoint.host = "changed.local";
    await expect(delivery.trust("SHA256:wrong")).rejects.toThrow(/review/);
    expect(await delivery.trust(connection.hostKeyFingerprint)).toEqual(connection);
    expect(persist).toHaveBeenCalledExactlyOnceWith(connection);
    expect(transport.upload).not.toHaveBeenCalled();
  });
  it.each([false, true])("uploads immutable reviewed bytes and forwards actual creation (%s) only once", async (directoryCreated) => {
    const { delivery, transport } = setup();
    transport.upload.mockResolvedValueOnce({ directoryCreated });
    const original = file(), validate = vi.fn(async () => undefined);
    const preview = delivery.prepare([original], validate);
    original.contents.fill(0); preview.connection.endpoint.host = "changed.local"; preview.files[0].fileName = "wrong.bdx";
    const result = await delivery.confirm(preview.operationId);
    expect(transport.upload.mock.calls[0][0]).toEqual(connection);
    expect(transport.upload.mock.calls[0][1][0]).toMatchObject({ fileName: "Opening.bdx", contents: Buffer.from("BDX fixture") });
    expect(result).toMatchObject({ state: "transferred", directory: DEFAULT_ROBOT_PATH_DIRECTORY, directoryCreated });
    expect(validate).toHaveBeenCalledOnce();
    await expect(delivery.confirm(preview.operationId)).rejects.toThrow(/Review/);
  });
  it("cancels review without opening a connection and rejects stale context before upload", async () => {
    const { delivery, transport } = setup();
    const first = delivery.prepare([file()], async () => undefined);
    expect(delivery.cancel(first.operationId)).toEqual({ canceled: true });
    await expect(delivery.confirm(first.operationId)).rejects.toThrow(/Review/);
    const second = delivery.prepare([file()], async () => { throw new Error("Catalog changed"); });
    await expect(delivery.confirm(second.operationId)).rejects.toThrow("Catalog changed");
    expect(transport.upload).not.toHaveBeenCalled();
  });
  it("rejects colliding file names before any transfer", () => {
    const { delivery, transport } = setup();
    expect(() => delivery.prepare([file(), { ...file(), pathId: "path-2", fileName: "opening.bdx" }], async () => undefined)).toThrow(/matching BDX filenames/);
    expect(transport.upload).not.toHaveBeenCalled();
  });
  it("locks confirmation, allows upload cancellation, and waits for shutdown", async () => {
    let finish!: () => void;
    let signal!: AbortSignal;
    const transport = { probe: vi.fn(async () => connection), upload: vi.fn(async (_c: RobotFileConnection, _f: Array<{ fileName: string; contents: Buffer }>, s?: AbortSignal) => { signal = s!; await new Promise<void>(resolve => { finish = resolve; }); s!.throwIfAborted(); return { directoryCreated: false }; }) };
    const delivery = new RobotFileDelivery(connection, async () => undefined, transport);
    const preview = delivery.prepare([file()], async () => undefined);
    const confirmed = delivery.confirm(preview.operationId);
    const failure = expect(confirmed).rejects.toThrow();
    await vi.waitFor(() => expect(transport.upload).toHaveBeenCalledOnce());
    await expect(delivery.confirm(preview.operationId)).rejects.toThrow(/Review/);
    await expect(delivery.probe(connection.endpoint)).rejects.toThrow(/Finish/);
    const stopped = delivery.stop();
    expect(signal.aborted).toBe(true);
    finish(); await stopped; await failure;
  });
});

describe("remembered robot destination", () => {
  it("saves a robot IP while offline, reloads it, and still requires SSH identity review", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-offline-ip-"));
    try {
      const filePath = path.join(directory, "connection.json");
      const endpoint = { target: "roborio" as const, host: "10.24.68.2", port: 22, directory: DEFAULT_ROBOT_PATH_DIRECTORY };
      const { transport } = setup(null);
      const delivery = new RobotFileDelivery(null, value => writeRobotFileConnection(filePath, value), transport);
      await delivery.saveSettings(endpoint);
      const restored = new RobotFileDelivery(await readRobotFileConnection(filePath), async () => undefined, transport);
      expect(restored.settings()).toEqual({ endpoint }); expect(restored.current()).toBeNull();
      expect(() => restored.prepare([file()], async () => undefined)).toThrow(/Connect/);
      expect(transport.probe).not.toHaveBeenCalled(); expect(transport.upload).not.toHaveBeenCalled();
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });

  it.each([{ host: "" }, { host: "user@robot" }, { port: 0 }, { port: 65536 }, { directory: "/etc" }, { target: "nxt" }, { directory: "/home/systemcore/bordeaux/paths" }])("rejects invalid offline settings %j before persisting or connecting", async (change) => {
    const { delivery, transport, persist } = setup();
    // Settings arrive over IPC as untrusted values; main validates every field.
    await expect(delivery.saveSettings({ ...connection.endpoint, ...change } as RobotFileConnection["endpoint"])).rejects.toThrow();
    expect(delivery.settings()).toEqual(connection); expect(delivery.current()).toEqual(connection);
    expect(persist).not.toHaveBeenCalled(); expect(transport.probe).not.toHaveBeenCalled(); expect(transport.upload).not.toHaveBeenCalled();
  });

  it("restores unverified settings without manufacturing SSH trust", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-file-settings-"));
    try {
      const filePath = path.join(directory, "connection.json"), value = { endpoint: connection.endpoint };
      await writeRobotFileConnection(filePath, value);
      const saved = await readRobotFileConnection(filePath);
      expect(saved).toEqual(value);
      const delivery = new RobotFileDelivery(saved, async () => undefined);
      expect(delivery.settings()).toEqual(value); expect(delivery.current()).toBeNull();
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
  it.each([
    ["/natinst/bin/Paths", "/home/lvuser/natinst/bin/Paths"],
    ["/home/lvuser/practice", "/home/lvuser/practice"],
  ])("restores %s without forgetting SSH identity", async (stored, expected) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-file-connection-"));
    try {
      const file = path.join(directory, "connection.json");
      await writeRobotFileConnection(file, { ...connection, endpoint: { ...connection.endpoint, directory: stored } });
      expect(await readRobotFileConnection(file)).toEqual({ ...connection, endpoint: { ...connection.endpoint, directory: expected } });
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });

  it.each([
    ["/natinst/bin/Paths", "/home/lvuser/natinst/bin/Paths"],
    ["/home/lvuser/practice", "/home/lvuser/practice"],
  ])("loads %s saved before robot types existed as a roboRIO without forgetting SSH identity", async (stored, expected) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-legacy-connection-"));
    try {
      const file = path.join(directory, "connection.json");
      const { target: _target, ...legacy } = connection.endpoint;
      await fs.writeFile(file, JSON.stringify({ endpoint: { ...legacy, directory: stored }, hostKeyFingerprint: connection.hostKeyFingerprint }));
      expect(await readRobotFileConnection(file)).toEqual({ ...connection, endpoint: { ...connection.endpoint, directory: expected } });
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });

  it("checks the folder against a newly chosen robot type before saving", async () => {
    const { delivery, persist } = setup();
    await expect(delivery.saveSettings({ ...connection.endpoint, target: "systemcore" })).rejects.toThrow(/inside \/home\/systemcore/);
    expect(persist).not.toHaveBeenCalled(); expect(delivery.current()).toEqual(connection);
  });

  it("asks to connect again when only the robot type changes, because that login was never tried", async () => {
    const { delivery, persist } = setup();
    const endpoint = { ...connection.endpoint, target: "systemcore" as const, directory: "/home/systemcore/bordeaux/paths" };
    expect(await delivery.saveSettings(endpoint)).toEqual({ endpoint });
    expect(delivery.current()).toBeNull();
    expect(() => delivery.prepare([file()], async () => undefined)).toThrow(/Connect/);
    expect(persist).toHaveBeenCalledOnce();
  });
});

describe("custom Systemcore SSH password", () => {
  const systemcore: RobotFileConnection = { endpoint: { target: "systemcore", host: "robot.local", port: 22, directory: "/home/systemcore/bordeaux/paths" }, hostKeyFingerprint: connection.hostKeyFingerprint };
  function systemcoreSetup(initial: RobotFileConnection | null = systemcore) {
    const passwords = sessionRobotPasswordStore();
    const persist = vi.fn(async (_value: RobotFileSettings) => undefined);
    const transport = {
      probe: vi.fn(async (endpoint: RobotFileConnection["endpoint"], _timeoutMs?: number, _password?: string | null) => ({ endpoint, hostKeyFingerprint: systemcore.hostKeyFingerprint })),
      upload: vi.fn(async (_connection: RobotFileConnection, _files: Array<{ fileName: string; contents: Buffer }>, _signal?: AbortSignal, _password?: string | null) => ({ directoryCreated: false })),
    };
    return { delivery: new RobotFileDelivery(initial, persist, transport, passwords), passwords, persist, transport };
  }
  const push = async (delivery: RobotFileDelivery) => delivery.confirm(delivery.prepare([file()], async () => undefined).operationId);

  it("connects with a typed password, remembers it only after trust, then uses it for checks and uploads", async () => {
    const { delivery, passwords, transport } = systemcoreSetup(null);
    await delivery.probe(systemcore.endpoint, { kind: "custom", password: "team-2468" });
    expect(transport.probe).toHaveBeenLastCalledWith(systemcore.endpoint, undefined, "team-2468");
    expect(passwords.current()).toBeNull();
    await delivery.trust(systemcore.hostKeyFingerprint);
    expect(passwords.current()).toBe("team-2468");
    await delivery.checkConnection();
    expect(transport.probe).toHaveBeenLastCalledWith(systemcore.endpoint, 5_000, "team-2468");
    await push(delivery);
    expect(transport.upload.mock.calls[0][3]).toBe("team-2468");
  });

  it("keeps the saved password when a probe with a new one is abandoned or refused", async () => {
    const { delivery, passwords, transport } = systemcoreSetup();
    await passwords.replace("saved");
    await delivery.probe(systemcore.endpoint, { kind: "custom", password: "abandoned" });
    transport.probe.mockRejectedValueOnce(new Error("Systemcore login refused"));
    await expect(delivery.probe(systemcore.endpoint, { kind: "custom", password: "wrong" })).rejects.toThrow("refused");
    await expect(delivery.trust(systemcore.hostKeyFingerprint)).rejects.toThrow(/Connect/);
    expect(passwords.current()).toBe("saved");
    await delivery.probe(systemcore.endpoint);
    expect(transport.probe).toHaveBeenLastCalledWith(systemcore.endpoint, undefined, "saved");
  });

  it("saves a typed password offline without writing it to the settings file, and returns to the default on request", async () => {
    const { delivery, passwords, persist } = systemcoreSetup();
    await delivery.saveSettings(systemcore.endpoint, { kind: "custom", password: "team-2468" });
    expect(passwords.current()).toBe("team-2468");
    expect(JSON.stringify(persist.mock.calls)).not.toContain("team-2468");
    await delivery.saveSettings(systemcore.endpoint, { kind: "default" });
    expect(passwords.current()).toBeNull();
  });

  it("asks to connect again after saving a changed password, but keeps trust when it is unchanged", async () => {
    const { delivery } = systemcoreSetup();
    expect(await delivery.saveSettings(systemcore.endpoint, { kind: "keep" })).toEqual(systemcore);
    expect(delivery.current()).toEqual(systemcore);
    expect(await delivery.saveSettings(systemcore.endpoint, { kind: "custom", password: "team-2468" })).toEqual({ endpoint: systemcore.endpoint });
    expect(delivery.current()).toBeNull();
  });

  it("keeps the password in effect when the field is left blank", async () => {
    const { delivery, passwords, transport } = systemcoreSetup();
    await passwords.replace("saved");
    await delivery.saveSettings(systemcore.endpoint, { kind: "keep" });
    expect(passwords.current()).toBe("saved");
    await delivery.probe(systemcore.endpoint, { kind: "keep" });
    expect(transport.probe).toHaveBeenLastCalledWith(systemcore.endpoint, undefined, "saved");
  });

  it("clears a custom password when the robot type changes to one without passwords", async () => {
    const { delivery, passwords } = systemcoreSetup();
    await passwords.replace("saved");
    await delivery.saveSettings({ ...connection.endpoint, host: systemcore.endpoint.host });
    expect(passwords.current()).toBeNull();
  });

  it("reports whether a custom password is in effect and whether it survives a restart, never the password", async () => {
    const { delivery, passwords } = systemcoreSetup();
    expect(delivery.passwordStatus()).toEqual({ custom: false, persistent: false });
    await passwords.replace("team-2468");
    expect(delivery.passwordStatus()).toEqual({ custom: true, persistent: false });
    expect(JSON.stringify([delivery.settings(), delivery.current(), delivery.passwordStatus()])).not.toContain("team-2468");
  });

  it.each([
    { kind: "custom", password: "" },
    { kind: "custom", password: 2468 },
    { kind: "custom", password: "x".repeat(257) },
    { kind: "custom" },
    { kind: "reset" },
    "team-2468",
  ])("rejects password change %j before connecting or saving", async (change) => {
    const { delivery, passwords, persist, transport } = systemcoreSetup();
    await passwords.replace("saved");
    await expect(delivery.probe(systemcore.endpoint, change as never)).rejects.toThrow(/password/i);
    await expect(delivery.saveSettings(systemcore.endpoint, change as never)).rejects.toThrow(/password/i);
    expect(transport.probe).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
    expect(passwords.current()).toBe("saved");
  });

  it("refuses a custom password for a robot type that logs in without one", async () => {
    const { delivery, transport, persist } = systemcoreSetup();
    await expect(delivery.probe(connection.endpoint, { kind: "custom", password: "team-2468" })).rejects.toThrow(/roboRIO.*password/);
    await expect(delivery.saveSettings(connection.endpoint, { kind: "custom", password: "team-2468" })).rejects.toThrow(/roboRIO.*password/);
    expect(transport.probe).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
  });
});
