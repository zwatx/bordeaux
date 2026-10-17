import { isOptimizationOutdated, optimizationInputKey } from "../../shared/planners/acceptedTrajectoryIdentity";
import { durationResult, finalPlanningOutcome } from "./finalPlanningResult";

// Agent-only strategy notes never change a trajectory. Everything else in the
// robot is compared, so a missed exclusion only costs a key recomputation.
function planningContext(robot, field, plannerId) {
  const { planning: _planning, ...physical } = robot;
  return JSON.stringify([physical, field, plannerId]);
}

/** One background worker at a time; the active editor supplies its own selected result. */
export function createLibraryDurations(planner) {
  let entries = new Map();
  let snapshot = {};
  let activeId = null;
  let running = null;
  const listeners = new Set();
  const publish = () => {
    snapshot = Object.fromEntries([...entries].map(([id, entry]) => [id, entry.result]));
    listeners.forEach((listener) => listener());
  };
  const stop = () => {
    const previous = running;
    running = null;
    previous?.request.cancel();
  };
  const advance = () => {
    if (running) return;
    const entry = [...entries.values()].find((item) => item.id !== activeId && item.result.status === 'pending');
    if (!entry) return;
    const request = planner.request({ key: entry.id, path: entry.path, robot: entry.robot, field: entry.field, plannerId: entry.plannerId }, { deadline: 'common' });
    const job = { entry, request };
    running = job;
    request.promise.then((result) => {
      if (running !== job || entries.get(entry.id) !== entry) return;
      running = null;
      entry.result = durationResult(finalPlanningOutcome(result, entry.path, entry.outdated));
      publish();
      advance();
    });
  };
  // Unchanged path objects in an unchanged context keep their entry without
  // recomputing keys. A new path object keeps its result only for the same
  // inputs and the same immutable accepted artifact.
  const entryFor = (path, context, input) => {
    const previous = entries.get(path.id);
    if (previous?.path === path && previous.context === context) return previous;
    const inputKey = path === input.currentPath ? input.currentKey : optimizationInputKey(path, input.robot, input.field);
    const accepted = path.optimization?.accepted || null;
    const next = { id: path.id, path, robot: input.robot, field: input.field, plannerId: input.plannerId, context, inputKey, accepted };
    if (previous && previous.inputKey === inputKey && previous.accepted === accepted && previous.plannerId === input.plannerId) {
      return Object.assign(previous, next);
    }
    return { ...next, outdated: isOptimizationOutdated(path, input.robot, input.field), result: { status: 'pending' } };
  };
  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => snapshot,
    /** `currentKey` is the caller's optimizationInputKey for `currentPath` in this context. */
    update(input, { id, ...selected }) {
      const context = planningContext(input.robot, input.field, input.plannerId);
      entries = new Map(input.paths.map((path) => [path.id, entryFor(path, context, input)]));
      activeId = id;
      if (running && (entries.get(running.entry.id) !== running.entry || running.entry.id === activeId)) stop();
      const active = entries.get(activeId);
      if (active && selected.status !== 'pending') active.result = selected;
      publish();
      advance();
    },
    cancel() { stop(); },
  };
}
