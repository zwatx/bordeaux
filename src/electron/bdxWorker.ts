import { parentPort } from "node:worker_threads";
import { buildRobotBinary, type BuiltRobotBinary } from "../core/export/robotBinary";
import type { BdxBatchJob, BdxJob } from "./bdxProtocol";
import type { WorkerResult } from "./workerTask";
const port = parentPort;
if (!port) throw new Error("BDX worker requires a parent port");
port.once("message", (job: BdxJob | BdxBatchJob) => {
  try {
    if ("selections" in job) {
      if (!Array.isArray(job.selections) || job.selections.length < 1 || job.selections.length > 64
        || job.selections.some(selection => !selection || selection.kind !== "path" || typeof selection.id !== "string")
        || new Set(job.selections.map(selection => selection.id)).size !== job.selections.length) {
        throw new Error("Select between 1 and 64 distinct paths to prepare");
      }
      // A failure rejects the entire preparation; no partial batch can be reviewed.
      const result = job.selections.map(selection => buildRobotBinary(job.project, selection, job.bindings));
      port.postMessage({ ok: true, result } satisfies WorkerResult<BuiltRobotBinary[]>);
    } else {
      port.postMessage({ ok: true, result: buildRobotBinary(job.project, job.selection, job.bindings) } satisfies WorkerResult<BuiltRobotBinary>);
    }
  } catch (error) { port.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies WorkerResult<BuiltRobotBinary | BuiltRobotBinary[]>); }
});
