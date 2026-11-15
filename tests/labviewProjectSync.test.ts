import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RobotCommandCatalog } from "../src/shared/types";
import { inspectLabviewCommands } from "../src/electron/labviewNiInspection";
import { inspectLabviewCommandsQueued, syncLabviewCommands } from "../src/electron/labviewProjectSync";

vi.mock("../src/electron/labviewNiInspection", () => ({
  inspectLabviewCommands: vi.fn(),
  refreshLabviewCommands: vi.fn(),
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
  it("starts from session definitions and returns them when nothing changed", async () => {
    const live = catalog("available"), session = vi.fn(async () => live), refresh = vi.fn(async () => null), cached = vi.fn();
    expect(await syncLabviewCommands(selection, cacheDirectory, catalog(), { platform: "win32", session, refresh, cached })).toBe(live);
    expect(refresh).toHaveBeenCalledExactlyOnceWith(selection, cacheDirectory); expect(cached).not.toHaveBeenCalled();
  });
  it("falls back to saved definitions before reading changes", async () => {
    const saved = catalog(), refresh = vi.fn(async () => null), cached = vi.fn(async () => saved);
    expect(await syncLabviewCommands(selection, cacheDirectory, catalog(), { platform: "win32", session: vi.fn(async () => null), refresh, cached })).toBe(saved);
  });
  it("returns re-read definitions when VIs changed", async () => {
    const live = catalog("available"), refresh = vi.fn(async () => live), cached = vi.fn(async () => catalog());
    expect(await syncLabviewCommands(selection, cacheDirectory, catalog(), { platform: "win32", session: vi.fn(async () => null), refresh, cached })).toBe(live);
  });

  it("keeps known commands usable and quiet when LabVIEW can't be read", async () => {
    const source = catalog(); const saved = catalog(); const unchanged = structuredClone(saved);
    const refresh = vi.fn(async () => { throw new Error("NI automation is unavailable"); });
    const cached = vi.fn(async () => saved);
    const result = await syncLabviewCommands(selection, cacheDirectory, source, { platform: "win32", refresh, cached });
    expect(cached).toHaveBeenCalledExactlyOnceWith(selection, source, cacheDirectory);
    expect(result.commands).toEqual(saved.commands);
    expect(result.conditions).toEqual(saved.conditions);
    expect(result.labviewDiscovery?.inspection).toEqual(saved.labviewDiscovery?.inspection);
    expect(result.warnings.at(-1)).toContain("NI automation is unavailable");
    expect(saved).toEqual(unchanged);
  });

  it("explains how to read commands when there are no definitions yet", async () => {
    const source = catalog(); delete source.labviewDiscovery!.inspection; source.commands = [];
    const refresh = vi.fn(async () => { throw new Error("LabVIEW is closed"); });
    const result = await syncLabviewCommands(selection, cacheDirectory, source, { platform: "win32", refresh, cached: vi.fn(async () => source) });
    expect(result.labviewDiscovery?.inspection).toMatchObject({ status: "unavailable", commandCount: 0 });
    expect(result.labviewDiscovery?.inspection?.reason).toContain("Open this project in LabVIEW, then refresh commands");
    expect(result.warnings).toContain(result.labviewDiscovery?.inspection?.reason);
  });

  it.each(["darwin", "linux"] as const)("uses saved definitions on %s without launching the NI adapter", async (platform) => {
    const source = catalog(); const saved = catalog();
    const refresh = vi.fn(async () => catalog("available")); const cached = vi.fn(async () => saved);
    expect(await syncLabviewCommands(selection, cacheDirectory, source, { platform, refresh, cached })).toBe(saved);
    expect(cached).toHaveBeenCalledExactlyOnceWith(selection, source, cacheDirectory);
    expect(refresh).not.toHaveBeenCalled();
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
