import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RobotFileDelivery, readRobotFileConnection, writeRobotFileConnection, type PreparedRobotFile } from "../src/electron/robotFileDelivery";
import { DEFAULT_ROBOT_PATH_DIRECTORY, type RobotFileConnection } from "../src/shared/robotFileDelivery";
const connection: RobotFileConnection = { endpoint: { host: "roborio-2468-frc.local", port: 22, directory: DEFAULT_ROBOT_PATH_DIRECTORY }, hostKeyFingerprint: "SHA256:abcdefghijklmnopqrstuvxyz123456789" };
const file = (): PreparedRobotFile => ({ pathId: "path-1", name: "Opening", fileName: "Opening.bdx", contents: Buffer.from("BDX fixture") });
function setup(initial: RobotFileConnection | null = connection) {
  const persist = vi.fn(async () => undefined);
  const transport = { probe: vi.fn(async () => structuredClone(connection)), upload: vi.fn(async (_connection: RobotFileConnection, _files: Array<{ fileName: string; contents: Buffer }>, _signal?: AbortSignal) => ({ directoryCreated: false })) };
  return { delivery: new RobotFileDelivery(initial, persist, transport), persist, transport };
}
describe("reviewed robot file delivery", () => {
  it("checks the pinned robot without invalidating a reviewed upload or changing trust", async () => {
    const { delivery, transport, persist } = setup();
    const preview = delivery.prepare([file()], async () => undefined);
    expect(await delivery.checkConnection()).toEqual(connection);
    expect(transport.probe).toHaveBeenCalledWith(connection.endpoint, 5_000);
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
      const endpoint = { host: "10.24.68.2", port: 22, directory: DEFAULT_ROBOT_PATH_DIRECTORY };
      const { transport } = setup(null);
      const delivery = new RobotFileDelivery(null, value => writeRobotFileConnection(filePath, value), transport);
      await delivery.saveSettings(endpoint);
      const restored = new RobotFileDelivery(await readRobotFileConnection(filePath), async () => undefined, transport);
      expect(restored.settings()).toEqual({ endpoint }); expect(restored.current()).toBeNull();
      expect(() => restored.prepare([file()], async () => undefined)).toThrow(/Connect/);
      expect(transport.probe).not.toHaveBeenCalled(); expect(transport.upload).not.toHaveBeenCalled();
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });

  it.each([{ host: "" }, { host: "user@robot" }, { port: 0 }, { port: 65536 }, { directory: "/etc" }])("rejects invalid offline settings %j before persisting or connecting", async (change) => {
    const { delivery, transport, persist } = setup();
    await expect(delivery.saveSettings({ ...connection.endpoint, ...change })).rejects.toThrow();
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
});
