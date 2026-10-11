// Background timing for the paths you are not editing (switcher times, push refusals).
// Reuses the core planning worker; the active path comes from usePlan instead.
import { useEffect, useRef, useState } from "react";

export function useOtherPlans(paths, activeId, robot, field) {
  const [plans, setPlans] = useState({});
  const cache = useRef(new WeakMap());
  const worker = useRef(null), queue = useRef([]), busy = useRef(null);
  const sequence = useRef(0), timer = useRef(null), pump = useRef(() => {});
  const current = useRef(null);
  current.current = { paths, activeId, robot, field };

  useEffect(() => {
    let disposed = false;
    const eligible = (job) => {
      const now = current.current;
      return job.robot === now.robot && job.field === now.field
        && job.path.id !== now.activeId && now.paths.includes(job.path);
    };
    const publish = (job, totalTime, error, completed = false) => {
      if (!eligible(job)) return;
      const entry = { path: job.path, robot: job.robot, field: job.field, totalTime, error };
      // Cache completed revisions for undo; transport failures remain retryable.
      if (completed) cache.current.set(job.path, entry);
      setPlans((all) => ({ ...all, [job.path.id]: entry }));
    };
    const retire = () => {
      clearTimeout(timer.current);
      timer.current = null;
      worker.current?.terminate();
      worker.current = null;
      const job = busy.current;
      busy.current = null;
      return job;
    };
    const fail = (instance, message) => {
      if (disposed || worker.current !== instance) return;
      const job = retire();
      if (job) publish(job, null, message);
      next();
    };
    const startWorker = () => {
      const instance = new Worker(new URL("./planning-worker.js", import.meta.url), { type: "module" });
      worker.current = instance;
      instance.onmessage = ({ data }) => {
        const job = busy.current;
        // A late, duplicate, or mismatched reply cannot release another job.
        if (disposed || worker.current !== instance || !job || data.id !== job.id) return;
        clearTimeout(timer.current);
        timer.current = null;
        busy.current = null;
        const result = data.result;
        const error = result?.issues?.find((issue) => issue.severity === "error");
        if (result) publish(job, result.bestEffort?.totalTimeS ?? null, error?.message ?? null, true);
        else publish(job, null, "Timing unavailable");
        next();
      };
      instance.onerror = () => fail(instance, "Timing unavailable");
      instance.onmessageerror = () => fail(instance, "Timing unavailable");
    };
    const next = () => {
      if (disposed || busy.current) return;
      while (queue.current.length) {
        const job = queue.current.shift();
        if (!eligible(job)) continue;
        busy.current = job;
        try {
          if (!worker.current) startWorker();
          worker.current.postMessage({ id: job.id, input: { path: job.path, robot: job.robot, field: job.field } });
        } catch {
          retire();
          publish(job, null, "Timing unavailable");
          // One failed revision must not block the remaining paths.
          continue;
        }
        const instance = worker.current;
        timer.current = setTimeout(() => fail(instance, "Timing took too long"), 5000);
        return;
      }
    };
    pump.current = next;
    return () => {
      disposed = true;
      retire();
      queue.current = [];
      pump.current = () => {};
    };
  }, [robot, field]);

  useEffect(() => {
    // Rebuild from current inputs: edits coalesce, deleted/active paths disappear,
    // and context changes replan every unchanged nonactive path.
    queue.current = paths.flatMap((path) => {
      if (path.id === activeId) return [];
      const cached = cache.current.get(path);
      if (cached?.robot === robot && cached?.field === field) return [];
      const running = busy.current;
      if (running?.path === path && running.robot === robot && running.field === field) return [];
      return [{ id: ++sequence.current, path, robot, field }];
    });
    pump.current();
  }, [paths, activeId, robot, field]);

  // Filter during render too: no old-context time/error leaks before effects run.
  const out = {};
  paths.forEach((path) => {
    if (path.id === activeId) return;
    const cached = cache.current.get(path);
    const entry = cached?.robot === robot && cached?.field === field ? cached : plans[path.id];
    if (entry?.path === path && entry.robot === robot && entry.field === field) out[path.id] = entry;
  });
  return out;
}
