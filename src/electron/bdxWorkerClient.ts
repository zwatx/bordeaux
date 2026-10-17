import path from "node:path";
import type { BuiltRobotBinary } from "../shared/export/robotBinary";
import type { BdxBatchJob, BdxJob } from "./bdxProtocol";
import { runWorkerTask } from "./workerTask";
export function buildBdxOffThread(job: BdxJob, signal?: AbortSignal): Promise<BuiltRobotBinary> {
  return signal ? runWorkerTask(path.join(__dirname, "bdxWorker.js"), job, "BDX export", signal, { waitForTermination: true }) : runWorkerTask(path.join(__dirname, "bdxWorker.js"), job, "BDX export");
}

/** Clone the reviewed project once and build selected paths sequentially in one worker. */
export function buildBdxBatchOffThread(job: BdxBatchJob, signal?: AbortSignal): Promise<BuiltRobotBinary[]> {
  return signal ? runWorkerTask(path.join(__dirname, "bdxWorker.js"), job, "BDX path preparation", signal, { waitForTermination: true }) : runWorkerTask(path.join(__dirname, "bdxWorker.js"), job, "BDX path preparation");
}
