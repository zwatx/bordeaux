import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RobotCommandCatalog } from "../src/shared/types";
import { inspectLabviewCommands } from "../src/electron/labviewNiInspection";
import { inspectLabviewCommandsQueued, syncLabviewCommands } from "../src/electron/labviewProjectSync";

vi.mock("../src/electron/labviewNiInspection", () => ({
  inspectLabviewCommands: vi.fn(),
  withCachedLabviewCommands: vi.fn(),
  withSessionLabviewCommands: vi.fn(),
}));

const selection = "C:\\Robot\\Robot.lvproj";
const cacheDirectory = "C:\\Bordeaux\\cache";
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}
function catalog(status: "available" | "cached" = "cached"): RobotCommandCatalog {
  return {
    runtime: "labview", projectName: "Robot", sourceFileCount: 2, scannedAt: "2026-09-09T00:00:00.000Z",
    commands: [{
      id: "intake.start", label: "Start intake", ownerType: "Intake", member: "Intake/Commands/Start.vi",
      kind: "factory", confidence: "confirmed", runtimeReady: false, parameters: [],
      source: { file: "Intake/Commands/Start.vi", line: 0 },
      labviewConnector: {
        labviewVersion: "25.3.3f3", applicationContext: "My Computer", target: "Robot", file: "Intake/Commands/Start.vi",
        terminalNumbers: [], directions: [], requirements: [], captions: [], typeXml: [], extendedInfo: [], defaults: {},
      },
    }],
    conditions: [{ id: "intake.ready", label: "Intake ready", ownerType: "Intake", member: "Ready.vi", source: { file: "Intake/Ready.vi", line: 0 } }],
    warnings: ["Existing source warning"],
    labviewDiscovery: {
      projectFile: selection, targets: [{ name: "Robot", type: "RT myRIO" }], items: [], viCount: 2, truncated: false,
      commandContract: { kind: "legacy-status-pair", status: "requires-declaration", description: "Requires a declared command lifecycle" },
      inspection: { status, commandCount: 1, inspectedAt: "2026-09-09T00:00:00.000Z", unsupported: [{ file: "Helper.vi", target: "Robot", reason: "No command connector" }] },
    },
  };
}

beforeEach(() => vi.clearAllMocks());

describe("automatic LabVIEW command sync", () => {
  it("reuses revalidated session evidence before NI automation or disk cache", async () => {
    const live = catalog("available"), session = vi.fn(async () => live), inspect = vi.fn(), cached = vi.fn();
    expect(await syncLabviewCommands(selection, cacheDirectory, catalog(), { platform: "win32", session, inspect, cached, discover: vi.fn() })).toBe(live);
    expect(inspect).not.toHaveBeenCalled(); expect(cached).not.toHaveBeenCalled();
  });
  it("restores a valid saved cache before starting Windows inspection", async () => {
    const saved = catalog(), inspect = vi.fn(), cached = vi.fn(async () => saved);
    expect(await syncLabviewCommands(selection, cacheDirectory, catalog(), { platform: "win32", session: vi.fn(async () => null), inspect, cached, discover: vi.fn() })).toBe(saved);
    expect(inspect).not.toHaveBeenCalled();
  });
  it("inspects on Windows and returns fresh evidence without loading the cache", async () => {
    const source = catalog(); const live = catalog("available");
    const inspect = vi.fn(async () => live); const cached = vi.fn(async () => source);
    expect(await syncLabviewCommands(selection, cacheDirectory, source, { platform: "win32", inspect, cached, discover: vi.fn(async () => source) })).toBe(live);
    expect(inspect).toHaveBeenCalledExactlyOnceWith(selection, cacheDirectory);
    expect(cached).not.toHaveBeenCalled();
  });

  it("keeps cached commands and conditions after inspection fails and explains how to retry", async () => {
    const source = catalog(); const saved = catalog(); const unchanged = structuredClone(saved);
    const inspect = vi.fn(async () => { throw new Error("NI automation is unavailable"); });
    const cached = vi.fn(async () => saved);
    const result = await syncLabviewCommands(selection, cacheDirectory, source, { platform: "win32", inspect, cached, discover: vi.fn(async () => source) });
    expect(cached).toHaveBeenCalledExactlyOnceWith(selection, source, cacheDirectory);
    expect(result.commands).toEqual(saved.commands);
    expect(result.conditions).toEqual(saved.conditions);
    expect(result.warnings).toContain("Existing source warning");
    expect(result.labviewDiscovery?.inspection).toMatchObject({ status: "unavailable", commandCount: 1, unsupported: saved.labviewDiscovery?.inspection?.unsupported });
    expect(result.labviewDiscovery?.inspection?.reason).toContain("NI automation is unavailable");
    expect(result.labviewDiscovery?.inspection?.reason).toContain("Open this project in LabVIEW, then choose Refresh commands to retry");
    expect(result.warnings).toContain(result.labviewDiscovery?.inspection?.reason);
    expect(saved).toEqual(unchanged);
  });

  it.each(["darwin", "linux"] as const)("uses cached evidence on %s without launching the NI adapter", async (platform) => {
    const source = catalog(); const saved = catalog();
    const inspect = vi.fn(async () => catalog("available")); const cached = vi.fn(async () => saved);
    expect(await syncLabviewCommands(selection, cacheDirectory, source, { platform, inspect, cached, discover: vi.fn(async () => source) })).toBe(saved);
    expect(cached).toHaveBeenCalledExactlyOnceWith(selection, source, cacheDirectory);
    expect(inspect).not.toHaveBeenCalled();
  });

  it("uses current declarations when project sources change during failed inspection", async () => {
    const source = catalog(); source.authoritative = true;
    let disk = source;
    const current = catalog();
    current.commands = [{ ...current.commands[0], id: "intake.stop", label: "Stop intake" }];
    current.conditions = [{ ...current.conditions![0], id: "intake.stopped", label: "Intake stopped" }];
    current.authoritative = false;
    const inspect = vi.fn(async () => {
      disk = current;
      throw new Error("Project sources changed during NI inspection");
    });
    const discover = vi.fn(async () => disk);
    const cached = vi.fn(async (_selection: string, latest: RobotCommandCatalog) => latest);
    const result = await syncLabviewCommands(selection, cacheDirectory, source, { platform: "win32", inspect, discover, cached });
    expect(discover).toHaveBeenCalledExactlyOnceWith(selection);
    expect(cached).toHaveBeenCalledExactlyOnceWith(selection, current, cacheDirectory);
    expect(result.commands.map(command => command.id)).toEqual(["intake.stop"]);
    expect(result.conditions?.map(condition => condition.id)).toEqual(["intake.stopped"]);
    expect(result.authoritative).toBe(false);
    expect(result.labviewDiscovery?.inspection?.reason).toContain("Project sources changed");
  });

  it("replaces a failed sync status with live evidence when the next sync succeeds", async () => {
    const source = catalog(); const live = catalog("available");
    const inspect = vi.fn<() => Promise<RobotCommandCatalog>>().mockRejectedValueOnce(new Error("LabVIEW is closed")).mockResolvedValueOnce(live);
    const cached = vi.fn(async () => source); const dependencies = { platform: "win32" as const, inspect, cached, discover: vi.fn(async () => source) };
    const failed = await syncLabviewCommands(selection, cacheDirectory, source, dependencies);
    expect(failed.labviewDiscovery?.inspection?.status).toBe("unavailable");
    const result = await syncLabviewCommands(selection, cacheDirectory, failed, dependencies);
    expect(result).toBe(live);
    expect(result.labviewDiscovery?.inspection?.status).toBe("available");
    expect(result.warnings.some(warning => warning.includes("could not inspect"))).toBe(false);
    expect(cached).toHaveBeenCalledTimes(1);
  });
});

describe("shared LabVIEW inspection queue", () => {
  it("coalesces concurrent refreshes of the same project", async () => {
    const gate = deferred<RobotCommandCatalog>();
    vi.mocked(inspectLabviewCommands).mockReturnValueOnce(gate.promise);
    const first = inspectLabviewCommandsQueued(selection, cacheDirectory);
    const second = inspectLabviewCommandsQueued(selection, cacheDirectory);
    expect(second).toBe(first);
    gate.resolve(catalog("available")); await first;
    expect(inspectLabviewCommands).toHaveBeenCalledOnce();
  });
  it("serializes different projects and continues after a rejected inspection", async () => {
    const first = deferred<RobotCommandCatalog>();
    const started = deferred<void>();
    const inspect = vi.mocked(inspectLabviewCommands);
    const live = catalog("available");
    inspect.mockImplementationOnce(() => { started.resolve(); return first.promise; }).mockResolvedValueOnce(live);
    const failed = inspectLabviewCommandsQueued(selection, cacheDirectory);
    const rejection = expect(failed).rejects.toThrow("NI disconnected");
    const next = inspectLabviewCommandsQueued("C:\\Other\\Other.lvproj", cacheDirectory);
    await started.promise;
    expect(inspect).toHaveBeenCalledTimes(1);
    first.reject(new Error("NI disconnected"));
    await rejection;
    expect(await next).toBe(live);
    expect(inspect).toHaveBeenNthCalledWith(2, "C:\\Other\\Other.lvproj", cacheDirectory);
  });
});
