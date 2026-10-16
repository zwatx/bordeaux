import { FinalPlanning } from './final-planning';
import { optimizationInputKey } from '../../shared/planners/acceptedTrajectoryIdentity';

/** Owns explicit search jobs. Results are candidates; only the editor can apply one. */
function create({ getProject, planner = FinalPlanning.create() }) {
  const listeners = new Set();
  let snapshot = { paths: {}, batch: null, running: false };
  let active = null;
  // Owns a whole single search or batch, including its completion bookkeeping.
  let operation = null;
  let batchRevision = 0;
  let disposed = false;
  const emit = (patch) => {
    if (disposed) return;
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  };
  const put = (id, value) => emit({ paths: { ...snapshot.paths, [id]: value } });
  const matches = (id, key) => {
    const project = getProject();
    const path = project.paths.find((item) => item.id === id);
    return path && optimizationInputKey(path, project.robot, project.field) === key;
  };

  async function run(id, deadline, owner) {
    const project = getProject();
    const path = project.paths.find((item) => item.id === id);
    if (!path || disposed || operation !== owner) return;
    const key = optimizationInputKey(path, project.robot, project.field);
    const job = { id, key, request: null };
    active = job;
    put(id, { key, status: 'searching', startedAt: Date.now(), value: null, error: '' });
    if (operation !== owner || active !== job || disposed) return;
    // Final planning keeps the latest incumbent for timeout/cancel results;
    // nothing renders intermediate progress, so it never enters this store.
    job.request = planner.request(
      { path, robot: project.robot, field: project.field, optimize: true, plannerId: 'profiledSpline' },
      { deadline },
    );
    const result = await job.request.promise;
    if (active !== job || operation !== owner || disposed) return;
    active = null;
    if (!matches(id, key)) {
      put(id, { ...snapshot.paths[id], status: 'stale', value: null });
      return;
    }
    put(id, {
      ...snapshot.paths[id],
      status: result.status,
      value: result.status === 'success' ? result.value : result.incumbent || null,
      error: result.status === 'success' ? '' : result.error?.message || result.fallbackReason || '',
    });
  }

  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot() { return snapshot; },
    async start(id, deadline = 'common') {
      if (snapshot.running || disposed) return;
      const owner = {};
      operation = owner;
      emit({ running: true, batch: null });
      try { await run(id, deadline, owner); }
      finally {
        if (operation === owner) {
          operation = null;
          emit({ running: false });
        }
      }
    },
    async startAll() {
      if (snapshot.running || disposed) return;
      const owner = {};
      operation = owner;
      const revision = ++batchRevision;
      const ids = getProject().paths.map((path) => path.id);
      emit({ running: true, batch: { completed: 0, total: ids.length } });
      try {
        for (const id of ids) {
          if (operation !== owner || revision !== batchRevision || disposed) break;
          await run(id, 'common', owner);
          if (operation !== owner || disposed) break;
          emit({ batch: { ...snapshot.batch, completed: snapshot.batch.completed + 1 } });
        }
      } finally {
        if (operation === owner) {
          operation = null;
          emit({ running: false });
        }
      }
    },
    // Document replacement retires candidates and every async writer before cancellation settles.
    reset() {
      operation = null;
      const previous = active;
      active = null;
      batchRevision += 1;
      emit({ paths: {}, batch: null, running: false });
      previous?.request?.cancel();
    },
    cancel() {
      batchRevision += 1;
      active?.request?.cancel();
    },
    sync() {
      if (active && !matches(active.id, active.key)) {
        batchRevision += 1;
        active.request?.cancel();
      }
    },
    dispose() {
      disposed = true;
      operation = null;
      batchRevision += 1;
      active?.request?.cancel();
      active = null;
      listeners.clear();
    },
  };
}

export const PathOptimization = { create };
