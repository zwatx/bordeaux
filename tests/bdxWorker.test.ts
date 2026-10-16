import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildRobotBinary } from "../src/shared/export/robotBinary";
import { blankPath, createDemoProject } from "../src/shared/project/defaults";
import { bdxBindingsFromCatalog } from "../src/electron/bdxBindings";
import { buildBdxBatchOffThread, buildBdxOffThread } from "../src/electron/bdxWorkerClient";
import type { BdxBatchJob, BdxJob } from "../src/electron/bdxProtocol";

const port = vi.hoisted(() => ({ once: vi.fn(), postMessage: vi.fn() }));
const runWorkerTask = vi.hoisted(() => vi.fn());
vi.mock("node:worker_threads", () => ({ parentPort: port }));
vi.mock("../src/electron/workerTask", () => ({ runWorkerTask }));
import "../src/electron/bdxWorker";

const receive = port.once.mock.calls[0][1] as (job: BdxJob | BdxBatchJob) => void;
const bindings = bdxBindingsFromCatalog(null);
function fixture(): BdxBatchJob {
  const project = createDemoProject();
  project.paths = ["first", "second", "unselected"].map(id => ({ ...blankPath(id), id }));
  project.paths[2].exportable = false;
  return { project, selections: [{ kind: "path", id: "second" }, { kind: "path", id: "first" }], bindings };
}
beforeEach(() => { port.postMessage.mockClear(); runWorkerTask.mockClear(); });

describe("BDX selected-path batch preparation", () => {
  it("builds only selected paths in request order with unchanged bytes and metadata", () => {
    const job = fixture();
    const before = structuredClone(job);
    receive(job);
    expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({ ok: true,
      result: job.selections.map(selection => buildRobotBinary(job.project, selection, bindings)) });
    expect(job).toEqual(before);
  });

  it("keeps single-path worker requests compatible", () => {
    const batch = fixture();
    const job = { project: batch.project, selection: batch.selections[0], bindings };
    receive(job);
    expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({ ok: true,
      result: buildRobotBinary(job.project, job.selection, bindings) });
  });

  it("rejects the whole batch when a later selected path fails", () => {
    const job = fixture();
    job.project.paths[0].exportable = false;
    receive(job);
    expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "first is not exportable" });
  });

  it("rejects missing selected paths instead of substituting an unselected path", () => {
    const job = fixture();
    job.selections[1].id = "missing";
    receive(job);
    expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "Selected path is missing or has an ambiguous ID" });
  });

  it.each([{ selections: [] }, { selections: [{ kind: "path", id: "first" }, { kind: "path", id: "first" }] },
    { selections: Array.from({ length: 65 }, (_, index) => ({ kind: "path", id: String(index) })) }])("rejects an invalid selection count or duplicates", ({ selections }) => {
    receive({ ...fixture(), selections } as BdxBatchJob);
    expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "Select between 1 and 64 distinct paths to prepare" });
  });

  it("submits the shared project and all selections to one worker task", async () => {
    const job = fixture();
    runWorkerTask.mockResolvedValueOnce([]);
    await expect(buildBdxBatchOffThread(job)).resolves.toEqual([]);
    expect(runWorkerTask).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/bdxWorker\.js$/), job, "BDX path preparation");
  });

  it("preserves the existing single-path client request", async () => {
    const batch = fixture();
    const job = { project: batch.project, selection: batch.selections[0], bindings };
    runWorkerTask.mockResolvedValueOnce({ fileName: "second.bdx" });
    await expect(buildBdxOffThread(job)).resolves.toEqual({ fileName: "second.bdx" });
    expect(runWorkerTask).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/bdxWorker\.js$/), job, "BDX export");
  });
  it("passes explicit-Save abort authority and requires actual worker termination", async () => {
    const job = fixture(), signal = new AbortController().signal; runWorkerTask.mockResolvedValueOnce([]);
    await buildBdxBatchOffThread(job, signal);
    expect(runWorkerTask).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/bdxWorker\.js$/), job, "BDX path preparation", signal, { waitForTermination: true });
  });

});
