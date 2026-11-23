import path from 'node:path';
import type { BordeauxProject } from '../core/types';
import type { BinaryBindings } from '../core/export/robotBinary';
import type { BuiltRoutineRuntime } from '../core/export/routineRuntime';
import { runWorkerTask } from './workerTask';

export interface RoutineRuntimeJob { project: BordeauxProject; routineId: string; bindings: BinaryBindings }
export function buildRoutineOffThread(job: RoutineRuntimeJob): Promise<BuiltRoutineRuntime> {
  return runWorkerTask(path.join(__dirname, 'routineRuntimeWorker.js'), job, 'Routine export', undefined, { waitForTermination: true });
}
