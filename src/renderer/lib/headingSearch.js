/** The heading search depends on camera configuration as well as the path's physical plan. */
export function headingSearchKey(documentKey, pathId, planningKey, cameras) {
  return JSON.stringify([documentKey, pathId, planningKey, cameras ?? []]);
}

/**
 * Runs the Optimize panel's Heading search for one path in the planning worker, where the planner lives, and resolves
 * with its result or null when there is nothing to gain. The promise has `cancel()`, which stops the worker; a
 * canceled search never settles.
 */
export function findHeadingsForTags({ path, robot, field }) {
  let worker, timer;
  const promise = new Promise((resolve, reject) => {
    worker = new Worker(new URL('../assets/path-preview-worker.js', import.meta.url), { type: 'module' });
    const finish = (settle, value) => { clearTimeout(timer); worker.terminate(); settle(value); };
    worker.onmessage = (event) => event.data.error ? finish(reject, new Error(event.data.error.message)) : finish(resolve, event.data.value ?? null);
    worker.onerror = () => finish(reject, new Error('The heading search could not finish. Try again.'));
    timer = setTimeout(() => finish(reject, new Error('The heading search ran out of time.')), 20000);
    worker.postMessage({ id: 1, mode: 'headingForTags', path, robot, field });
  });
  promise.cancel = () => { clearTimeout(timer); worker?.terminate(); };
  return promise;
}
