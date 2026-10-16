  const FINAL_SAMPLES_PER_SEGMENT = 56;
  const DEFAULT_DEADLINES_MS = Object.freeze({ common: 5000, stress: 15000, hard: 30000 });
  const WORKER_RESPONSE_GRACE_MS = 1000;
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

    return {
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
          if (worker) worker.terminate();
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
          worker = workerFactory();
          worker.onmessage = (event) => {
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
          worker.onerror = (event) => fail(event.message || 'The final-planning worker failed');
          worker.onmessageerror = () => fail('The final-planning worker returned an unreadable response');
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
