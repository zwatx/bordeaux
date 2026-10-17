import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runWorkerTask } from "../src/electron/workerTask";

let directory: string;
let filename: string;

beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-worker-task-"));
  filename = path.join(directory, "worker.cjs");
  await fs.writeFile(filename, `
    const { parentPort } = require("node:worker_threads");
    parentPort.on("message", (job) => {
      if (job.kind === "wait") return;
      if (job.kind === "throw") throw new Error("Worker failed");
      if (job.kind === "exit") process.exit(job.code);
      if (job.kind === "message") parentPort.postMessage(job.message);
    });
  `);
});

afterEach(() => vi.restoreAllMocks());
afterAll(async () => fs.rm(directory, { recursive: true, force: true }));

describe("one-request worker lifecycle", () => {
  it("returns the structured result and terminates a worker that keeps listening", async () => {
    const terminate = vi.spyOn(Worker.prototype, "terminate");
    const expected = { length: 12, values: [1, 2, 3] };

    await expect(runWorkerTask(filename, { kind: "message", message: { ok: true, result: expected } }, "Test"))
      .resolves.toEqual(expected);

    expect(terminate).toHaveBeenCalledTimes(1);
    await terminate.mock.results[0].value;
  });

  it("propagates a worker-reported failure and terminates its listener", async () => {
    const terminate = vi.spyOn(Worker.prototype, "terminate");

    await expect(runWorkerTask(filename, { kind: "message", message: { ok: false, error: "Invalid path" } }, "Test"))
      .rejects.toThrow("Invalid path");

    expect(terminate).toHaveBeenCalledTimes(1);
    await terminate.mock.results[0].value;
  });

  it.each([null, { ok: true }, { result: 7 }, { ok: false, error: 2 }])("rejects an invalid response envelope: %j", async (message) => {
    await expect(runWorkerTask(filename, { kind: "message", message }, "Test"))
      .rejects.toThrow("Test worker returned an invalid result");
  });

  it.each([0, 3])("rejects an exit before a result (code %s)", async (code) => {
    await expect(runWorkerTask(filename, { kind: "exit", code }, "Test"))
      .rejects.toThrow(`Test worker exited without a result (code ${code})`);
  });

  it("propagates an uncaught worker error", async () => {
    await expect(runWorkerTask(filename, { kind: "throw" }, "Test")).rejects.toThrow("Worker failed");
  });

  it("settles once when a worker fails after posting its result", async () => {
    const originalTerminate = Worker.prototype.terminate;
    const terminate = vi.spyOn(Worker.prototype, "terminate").mockImplementation(function (this: Worker) {
      this.emit("error", new Error("Late worker failure"));
      return originalTerminate.call(this);
    });

    await expect(runWorkerTask(filename, { kind: "message", message: { ok: true, result: 4 } }, "Test")).resolves.toBe(4);

    expect(terminate).toHaveBeenCalledTimes(1);
    await terminate.mock.results[0].value;
  });

  it("does not start work when already canceled", async () => {
    const terminate = vi.spyOn(Worker.prototype, "terminate");

    await expect(runWorkerTask(filename, { kind: "wait" }, "Test", AbortSignal.abort()))
      .rejects.toThrow("Test was canceled.");

    expect(terminate).not.toHaveBeenCalled();
  });

  it("terminates an in-flight worker and removes the abort listener", async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const terminate = vi.spyOn(Worker.prototype, "terminate");
    const pending = runWorkerTask(filename, { kind: "wait" }, "Test", controller.signal);

    controller.abort();

    await expect(pending).rejects.toThrow("Test was canceled.");
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(terminate).toHaveBeenCalledTimes(1);
    await terminate.mock.results[0].value;
  });

  it("terminates the worker when posting a request fails structured cloning", async () => {
    const terminate = vi.spyOn(Worker.prototype, "terminate");

    await expect(runWorkerTask(filename, { callback: () => {} }, "Test")).rejects.toMatchObject({ name: "DataCloneError" });

    expect(terminate).toHaveBeenCalledTimes(1);
    await terminate.mock.results[0].value;
  });
  it("retains explicit-Save work until its requested termination actually settles", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = Worker.prototype.terminate;
    let terminated!: Promise<number>;
    const terminate = vi.spyOn(Worker.prototype, "terminate").mockImplementation(function (this: Worker) {
      terminated = original.call(this);
      return terminated.then(async code => { await gate; return code; });
    });
    const controller = new AbortController(); let settled = false;
    const pending = runWorkerTask(filename, { kind: "wait" }, "Test", controller.signal, { waitForTermination: true });
    const observed = pending.catch(error => { settled = true; throw error; });
    const rejected = expect(observed).rejects.toThrow("canceled");
    controller.abort(); await terminated; expect(settled).toBe(false); expect(terminate).toHaveBeenCalledTimes(1);
    release(); await rejected;
  });

});
