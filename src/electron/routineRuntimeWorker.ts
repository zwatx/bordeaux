import { parentPort } from 'node:worker_threads';
import { buildRoutineRuntime } from '../core/export/routineRuntime';
import type { RoutineRuntimeJob } from './routineRuntimeWorkerClient';
import { routineBindingsFromBinary } from './routineBindings';
import { routineCommandIds } from './routineSelection';

parentPort?.once('message', (job: RoutineRuntimeJob) => {
  try {
    const bindings = routineBindingsFromBinary(job.bindings, routineCommandIds(job.project, job.routineId));
    parentPort!.postMessage({ ok: true, result: buildRoutineRuntime(job.project, job.routineId, bindings) });
  } catch (error) { parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});
