  const FINAL_SAMPLES_PER_SEGMENT = 56;
  const DEFAULT_DEADLINES_MS = Object.freeze({ common: 5000, stress: 15000, hard: 30000 });
  const WORKER_RESPONSE_GRACE_MS = 1000;
  // An idle optimizer worker and its candidate pool are released after this long.
  const OPTIMIZER_IDLE_MS = 120000;
  // Statistics may only refresh counters; route, timing, and status stay the incumbent's.
  const STATISTICS_KEYS = ['solveTimeMs', 'evaluations', 'validatedCandidates', 'rejectedCandidates', 'rejectionReasons'];

  /** Refreshes retained search metadata while sharing the incumbent's trajectory arrays. */
  function withSearchStatistics(value, statistics, termination) {
    const optimization = value?.finalTrajectory?.optimization;
    if (!optimization || (!statistics && !termination)) return value;
    const current = { ...optimization };
    STATISTICS_KEYS.forEach((key) => {
      if (statistics && Object.prototype.hasOwnProperty.call(statistics, key)) current[key] = statistics[key];
    });
    if (!optimization.termination && termination) current.termination = termination;
    return {
      ...value,
      finalTrajectory: { ...value.finalTrajectory, optimization: current },
      finalOptimization: current,
    };
  }

  /** Runs deliberate final-planning work independently from interactive preview. */
  function create(options) {
    const config = options || {};
    const workerFactory = config.workerFactory || (() => {
      return new Worker(new URL('./path-preview-worker.js', import.meta.url), { type: 'module' });
    });
    const deadlines = Object.fromEntries(Object.entries(DEFAULT_DEADLINES_MS).map(([name, fallback]) => [
      name,
      Number.isFinite(config.deadlines?.[name]) ? Math.max(1, config.deadlines[name]) : fallback,
    ]));
    let sequence = 0;
    // Route optimization runs in one long-lived worker that keeps a pool of
    // sub-workers compiled between searches. Every other request, and any
    // injected worker factory, keeps the one-worker-per-request lifecycle.
    const keepsOptimizer = !config.workerFactory;
    let optimizer = null;
    let optimizerRequests = 0;
    let optimizerIdleTimer = 0;
    const releaseOptimizer = () => {
      if (optimizerIdleTimer) clearTimeout(optimizerIdleTimer);
      optimizerIdleTimer = 0;
      if (optimizer) optimizer.terminate();
      optimizer = null;
    };
    const holdOptimizer = () => {
      if (optimizerIdleTimer) clearTimeout(optimizerIdleTimer);
      optimizerIdleTimer = 0;
      if (!optimizer) optimizer = workerFactory();
      return optimizer;
    };
    const idleOptimizer = () => {
      if (optimizerRequests > 0 || !optimizer) return;
      if (optimizerIdleTimer) clearTimeout(optimizerIdleTimer);
      optimizerIdleTimer = setTimeout(releaseOptimizer, OPTIMIZER_IDLE_MS);
    };

    return {
      /**
       * Starts the optimizer worker and compiles its pool on a path the user is
       * about to optimize, so the first search does not pay for either.
       */
      warmOptimizer(input) {
        if (!keepsOptimizer) return;
        try {
          holdOptimizer().postMessage({ type: 'warm', ...input, perSegment: FINAL_SAMPLES_PER_SEGMENT });
          idleOptimizer();
        } catch {
          releaseOptimizer();
        }
      },
      request(input, requestOptions) {
        const requestConfig = requestOptions || {};
        const id = ++sequence;
        const deadline = Object.prototype.hasOwnProperty.call(deadlines, requestConfig.deadline)
          ? requestConfig.deadline
          : 'common';
        const deadlineMs = deadlines[deadline];
        let settled = false;
        let timer = 0;
        let worker = null;
        const persistent = keepsOptimizer && input.optimize === true;
        let detach = () => {};
        let incumbent;
        let statistics = null;
        let resolveResult;
        const promise = new Promise((resolve) => { resolveResult = resolve; });
        const unchanged = typeof requestConfig.failureNote === 'string' ? requestConfig.failureNote : input.optimize === true
          ? 'The selected trajectory was not changed.'
          : 'Continuing with the last interactive result.';
        const finish = (result, termination) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (persistent) {
            detach();
            optimizerRequests -= 1;
            // A failed, timed-out or canceled search is stopped by terminating its
            // worker, pool included: a search running in sequence cannot read a
            // cancel message, and a stalled one would hold the next search.
            if (result.status !== 'success') releaseOptimizer();
            idleOptimizer();
          } else if (worker) worker.terminate();
          resolveResult({
            ...result,
            ...(incumbent ? { incumbent: withSearchStatistics(incumbent, statistics, termination) } : {}),
            ...(result.fallback ? { fallbackProvisional: true } : {}),
          });
        };
        const fail = (message) => finish({
          status: 'failure',
          error: { message },
          fallback: requestConfig.interactiveResult,
          fallbackReason: `Final planning failed: ${message}. ${unchanged}`,
        });
        try {
          if (persistent) optimizerRequests += 1;
          worker = persistent ? holdOptimizer() : workerFactory();
          const onMessage = (event) => {
            const result = event.data;
            if (settled) return;
            if (!result || typeof result.id !== 'number') {
              fail('The final-planning worker returned an invalid response');
              return;
            }
            // A late result from another request must never replace this run.
            if (result.id !== id) return;
            if (result.type === 'progress') {
              if (!result.value) {
                fail('The final-planning worker returned invalid progress');
                return;
              }
              incumbent = result.value;
              statistics = null;
              requestConfig.onProgress?.(result.value);
              return;
            }
            // Counters for the retained incumbent; applied only when this run settles.
            if (result.type === 'statistics') {
              if (!result.statistics || typeof result.statistics !== 'object') {
                fail('The final-planning worker returned invalid statistics');
                return;
              }
              statistics = result.statistics;
              return;
            }
            if (result.error) {
              fail(result.error.message || 'The final-planning worker failed');
              return;
            }
            if (result.finalFallbackReason) {
              fail(result.finalFallbackReason);
              return;
            }
            if (!Object.prototype.hasOwnProperty.call(result, 'value')) {
              fail('The final-planning worker returned an invalid response');
              return;
            }
            finish({ status: 'success', value: result.value, durationMs: result.durationMs || 0 });
          };
          const onError = (event) => fail(event.message || 'The final-planning worker failed');
          const onMessageError = () => fail('The final-planning worker returned an unreadable response');
          if (persistent) {
            // The optimizer worker outlives this request, so listen without replacing its handlers.
            worker.addEventListener('message', onMessage);
            worker.addEventListener('error', onError);
            worker.addEventListener('messageerror', onMessageError);
            const held = worker;
            detach = () => {
              held.removeEventListener('message', onMessage);
              held.removeEventListener('error', onError);
              held.removeEventListener('messageerror', onMessageError);
            };
          } else {
            worker.onmessage = onMessage;
            worker.onerror = onError;
            worker.onmessageerror = onMessageError;
          }
          timer = setTimeout(() => finish({
            status: 'timeout',
            deadline,
            deadlineMs,
            fallback: requestConfig.interactiveResult,
            fallbackReason: `Final planning exceeded the ${deadline} deadline (${deadlineMs} ms); ${unchanged.charAt(0).toLowerCase() + unchanged.slice(1)}`,
          }, 'time-budget'), deadlineMs + WORKER_RESPONSE_GRACE_MS);
          worker.postMessage({
            id,
            ...input,
            quality: 'final',
            perSegment: FINAL_SAMPLES_PER_SEGMENT,
            deadline,
            deadlineMs,
            ...(persistent ? { parallel: true } : {}),
          });
        } catch (error) {
          fail(error && typeof error.message === 'string' ? error.message : String(error));
        }
        return {
          promise,
          cancel() {
            finish({
              status: 'canceled',
              fallback: requestConfig.interactiveResult,
              fallbackReason: `Final planning was canceled; ${unchanged.charAt(0).toLowerCase() + unchanged.slice(1)}`,
            }, 'cancelled');
          },
        };
      },
    };
  }

export const FinalPlanning = Object.freeze({ create });
