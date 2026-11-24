import { afterEach, describe, expect, it, vi } from "vitest";
import { buildWaypoints, createDemoProject } from "../src/core/project/defaults";

/** A route-evaluation sub-worker that answers only when the test says so. */
class FakeSubWorker {
  static created: FakeSubWorker[] = [];
  static failAfter = Number.POSITIVE_INFINITY;
  readonly messages: Array<{ id: number; mode: string }> = [];
  terminated = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  constructor(readonly url: string) {
    if (FakeSubWorker.created.length >= FakeSubWorker.failAfter) throw new Error("nested workers are unavailable");
    FakeSubWorker.created.push(this);
  }
  postMessage(message: { id: number; mode: string }) { this.messages.push(message); }
  answer(outcome: unknown) { this.onmessage?.({ data: { id: this.messages.at(-1)!.id, outcome } }); }
  crash() { this.onerror?.({ message: "out of memory" }); }
  terminate() { this.terminated = true; }
}

const optimizerSelf = { location: { href: "worker.js" }, navigator: { hardwareConcurrency: 8 }, onmessage: null as null | ((event: { data: unknown }) => void), postMessage: vi.fn() };

async function workerModule() {
  FakeSubWorker.created = [];
  FakeSubWorker.failAfter = Number.POSITIVE_INFINITY;
  optimizerSelf.onmessage = null;
  optimizerSelf.postMessage = vi.fn();
  vi.stubGlobal("self", optimizerSelf);
  vi.stubGlobal("Worker", FakeSubWorker);
  vi.resetModules();
  // @ts-expect-error The production worker is an intentional JavaScript module.
  return await import("../src/renderer/assets/path-preview-worker") as {
    createCandidatePool(size: number): {
      alive: boolean;
      evaluate(source: unknown, geometry: unknown, limits: unknown): Promise<unknown>;
      qualifySeed(source: unknown): Promise<unknown>;
    };
  };
}
const workerFailed = { status: "rejected", reason: "Route evaluation worker failed." };

afterEach(() => vi.unstubAllGlobals());

describe("route candidate pool", () => {
  it("never hands a task to a sub-worker that failed while idle", async () => {
    const pool = (await workerModule()).createCandidatePool(2);
    const [first, second] = FakeSubWorker.created;
    second.crash();
    expect(second.terminated).toBe(true);
    const outcome = pool.evaluate({}, {}, {});
    expect(second.messages).toHaveLength(0);
    expect(first.messages).toMatchObject([{ mode: "routeCandidate" }]);
    first.answer({ status: "valid" });
    await expect(outcome).resolves.toEqual({ status: "valid" });
  });

  it("rejects the task of a sub-worker that fails while busy and continues on the rest", async () => {
    const pool = (await workerModule()).createCandidatePool(2);
    const [first, second] = FakeSubWorker.created;
    const a = pool.evaluate({}, {}, {});
    const b = pool.evaluate({}, {}, {});
    const c = pool.qualifySeed({});
    second.crash();
    await expect(a).resolves.toEqual(workerFailed);
    // The queued task waits for the surviving sub-worker.
    expect(second.messages).toHaveLength(1);
    first.answer({ status: "valid", from: "b" });
    await expect(b).resolves.toEqual({ status: "valid", from: "b" });
    expect(first.messages.at(-1)).toMatchObject({ mode: "routeSeed" });
    first.answer({ status: "valid", from: "c" });
    await expect(c).resolves.toEqual({ status: "valid", from: "c" });
  });

  it("rejects queued and new tasks once every sub-worker has failed", async () => {
    const pool = (await workerModule()).createCandidatePool(2);
    const [first, second] = FakeSubWorker.created;
    const running = [pool.evaluate({}, {}, {}), pool.evaluate({}, {}, {})];
    const queued = [pool.evaluate({}, {}, {}), pool.qualifySeed({})];
    first.crash();
    second.onmessageerror?.({});
    second.crash();
    await expect(Promise.all([...running, ...queued])).resolves.toEqual([workerFailed, workerFailed, workerFailed,
      { ...workerFailed, concrete: false }]);
    await expect(pool.evaluate({}, {}, {})).resolves.toEqual(workerFailed);
    expect(pool.alive).toBe(false);
    expect([first.messages.length, second.messages.length]).toEqual([1, 1]);
  });

  it("terminates the sub-workers it started when a later one cannot start", async () => {
    const module = await workerModule();
    FakeSubWorker.failAfter = 2;
    expect(() => module.createCandidatePool(4)).toThrow(/unavailable/);
    expect(FakeSubWorker.created.map((worker) => worker.terminated)).toEqual([true, true]);
  });

  it("searches in sequence once the whole pool has failed", async () => {
    await workerModule();
    const project = createDemoProject();
    project.paths[0].waypoints = buildWaypoints([{ x: 6.5, y: 2 }, { x: 10, y: 2 }]);
    const job = { path: project.paths[0], robot: project.robot, field: project.field, perSegment: 56 };
    optimizerSelf.onmessage!({ data: { type: "warm", ...job } });
    expect(FakeSubWorker.created).toHaveLength(4);
    expect(FakeSubWorker.created.every((worker) => worker.messages[0]?.mode === "routeWarm")).toBe(true);
    FakeSubWorker.created.forEach((worker) => worker.crash());
    optimizerSelf.onmessage!({ data: { id: 41, quality: "final", optimize: true, parallel: true, ...job, deadline: "common", deadlineMs: 1 } });
    expect(optimizerSelf.postMessage).toHaveBeenCalledOnce();
    expect(optimizerSelf.postMessage.mock.calls[0][0]).toMatchObject({ id: 41, value: { routeSearch: { termination: "time-budget" } } });
    expect(FakeSubWorker.created).toHaveLength(4);
    expect(FakeSubWorker.created.every((worker) => worker.messages.length === 1)).toBe(true);
  });
});
