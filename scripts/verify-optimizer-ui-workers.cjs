// Fixture-only main-world observation, serialized into a registered frame preload before load.
function installOptimizerWorkerEvidence(observerSha256) {
  if (window.__optimizerWorkers) throw new Error('Duplicate optimizer worker observation');
  const NativeWorker = window.Worker, jobs = [], problems = [], values = new Map(), artifacts = new WeakMap();
  let workerSequence = 0, artifactSequence = 0;
  // While set, the final reply of an optimize job is recorded but kept from the app.
  // A search now ends within a second, so a fixture that must act on a running
  // search holds its reply instead of racing it.
  let heldReplies = null;
  const artifactId = value => {
    if (!value || typeof value !== 'object') return null;
    if (!artifacts.has(value)) artifacts.set(value, ++artifactSequence);
    return artifacts.get(value);
  };
  class ObservedWorker extends NativeWorker {
    constructor(...args) {
      super(...args);
      this.evidenceId = ++workerSequence;
      this.evidenceUrl = String(args[0]);
      this.evidencePending = new Map();
      this.addEventListener('message', event => {
        const result = event.data, job = this.evidencePending.get(result?.id);
        if (!job || result.type === 'progress' || result.type === 'statistics') return;
        this.evidencePending.delete(result.id);
        job.finishedAt = performance.now(); job.status = result.error || result.finalFallbackReason ? 'error' : 'ready';
        const value = result.value, trajectory = value?.trajectory || value?.finalTrajectory || value?.derived?.finalTrajectory;
        job.result = { accepted: Boolean(value?.acceptedTrajectory), planningStatus: value?.status,
          comparison: value?.comparison, seconds: trajectory?.totalTimeS, samples: trajectory?.samples?.length,
          error: result.error?.message || result.finalFallbackReason || null };
        values.set(job.sequence, value);
        if (heldReplies && job.optimize) {
          event.stopImmediatePropagation();
          // The job is no longer pending, so this listener lets the replayed event through.
          heldReplies.push(() => this.dispatchEvent(new MessageEvent('message', { data: result })));
        }
      });
      for (const type of ['error', 'messageerror']) this.addEventListener(type, () => {
        for (const job of this.evidencePending.values()) { job.status = type; job.finishedAt = performance.now(); }
        this.evidencePending.clear();
      });
    }
    postMessage(...args) {
      const message = args[0]; let job;
      if (message?.path && typeof message.id === 'number') {
        if (jobs.length >= 5000) problems.push('Worker observation exceeded 5000 requests');
        const accepted = message.path.optimization?.accepted;
        job = { sequence: jobs.length + 1, worker: this.evidenceId, requestId: message.id, pathId: message.path.id,
          workerUrl: this.evidenceUrl, plannerId: message.plannerId ?? null, key: message.key ?? null,
          mode: message.mode || 'legacy', optimize: message.optimize === true, quality: message.quality,
          density: message.perSegment, acceptedIdentity: artifactId(accepted), acceptedDensity: accepted?.samplesPerSegment ?? null,
          startedAt: performance.now(), status: 'pending' };
        jobs.push(job); this.evidencePending.set(message.id, job);
      }
      try { return super.postMessage(...args); }
      catch (error) { if (job) { job.status = 'post-error'; this.evidencePending.delete(message.id); } throw error; }
    }
    terminate() {
      for (const job of this.evidencePending.values()) { job.status = 'terminated'; job.finishedAt = performance.now(); }
      this.evidencePending.clear(); return super.terminate();
    }
  }
  window.Worker = ObservedWorker;
  window.__optimizerWorkers = {
    observerSha256, installedAt: performance.now(), installedReadyState: document.readyState,
    installedScriptCount: document.scripts.length, jobs, problems,
    isInstalled() { return window.Worker === ObservedWorker; },
    holdOptimizeReplies() { heldReplies = heldReplies || []; },
    releaseOptimizeReplies() { const held = heldReplies || []; heldReplies = null; held.forEach(deliver => deliver()); },
    valueFor(sequence) { return values.get(sequence); },
    latestEditing(pathId) {
      const job = [...jobs].reverse().find(row => row.pathId === pathId && row.mode === 'editing');
      return job ? { job, value: values.get(job.sequence) } : null;
    },
  };
}
module.exports = { installOptimizerWorkerEvidence };
