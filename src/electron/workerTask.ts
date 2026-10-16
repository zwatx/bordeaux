import { Worker } from "node:worker_threads";

export type WorkerResult<T> = { ok: true; result: T } | { ok: false; error: string };

/** Runs one request against an internal worker using the shared result envelope. */
export function runWorkerTask<T>(
  filename: string,
  request: unknown,
  taskName: string,
  signal?: AbortSignal,
  options: { waitForTermination?: boolean } = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    const canceled = () => new Error(`${taskName} was canceled.`);
    if (signal?.aborted) { reject(canceled()); return; }

    const worker = new Worker(filename);
    let settled = false;
    let exited = false;
    let resolveExit!: () => void;
    const exit = new Promise<void>(resolve => { resolveExit = resolve; });
    worker.once("exit", () => { exited = true; resolveExit(); });
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", cancel);
      worker.removeAllListeners("message");
      const termination = worker.terminate();
      if (options.waitForTermination) void termination.then(action, async () => { if (!exited) await exit; action(); });
      else { void termination.catch(() => undefined); action(); }
    };
    const cancel = () => finish(() => reject(canceled()));
    signal?.addEventListener("abort", cancel, { once: true });
    worker.once("message", (message: WorkerResult<T>) => {
      if (message && message.ok === true && "result" in message) {
        finish(() => resolve(message.result));
      } else {
        const error = message && message.ok === false && typeof message.error === "string"
          ? message.error : `${taskName} worker returned an invalid result`;
        finish(() => reject(new Error(error)));
      }
    });
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", (code) => finish(() => reject(new Error(`${taskName} worker exited without a result (code ${code})`))));
    try {
      worker.postMessage(request);
    } catch (error) {
      // A structured-clone failure must release the worker just like an async error.
      finish(() => reject(error));
    }
  });
}
