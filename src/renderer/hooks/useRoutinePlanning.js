import * as React from "react";
import { FinalPlanning } from "../assets/final-planning";
import { isOptimizationOutdated } from "../../shared/planners/acceptedTrajectoryIdentity";
import { finalPlanningOutcome } from "../lib/finalPlanningResult";
import { AUTO } from "../lib/routineModel";

const { useEffect, useMemo, useRef, useState } = React;

/** A ready plan reused only for the exact path, robot, field and planner it was validated against. */
function reusablePlan(plans, path, robot, field, plannerId) {
  const entry = plans.get(path);
  return entry && entry.robot === robot && entry.field === field && entry.plannerId === plannerId ? entry.value : undefined;
}

/**
 * Plans every path a routine references. Routine-only edits keep the ready plans,
 * and ready plans survive leaving Routines or editing another referenced path.
 * Edits replace path objects, so object identity covers every planning input of a path.
 */
export function useRoutinePlanning(enabled, routine, projectPaths, robot, field, plannerId) {
  const planner = useMemo(() => FinalPlanning.create(), []);
  const readyPlans = useRef(new WeakMap());
  const referencedPaths = useRef([]);
  const paths = useMemo(() => {
    const next = AUTO.planningPaths(routine, projectPaths);
    const previous = referencedPaths.current;
    if (next.length !== previous.length || next.some((path, index) => path !== previous[index])) referencedPaths.current = next;
    return referencedPaths.current;
  }, [routine, projectPaths]);
  const missingPathIds = useMemo(() => {
    const missing = new Set();
    AUTO.walk(routine?.nodes, node => {
      if (node.type === 'path' && !projectPaths.some(path => path.id === node.ref)) missing.add(node.ref || '(unselected)');
    });
    return [...missing];
  }, [routine, projectPaths]);
  const [planningState, setPlanningState] = useState(() => ({
    paths, robot, field, plannerId, status: 'idle', values: {}, error: '',
  }));
  // Read during render so a routine whose paths are all ready never flashes pending.
  const reused = useMemo(() => {
    if (!enabled) return null;
    const values = {};
    for (const path of paths) {
      const value = reusablePlan(readyPlans.current, path, robot, field, plannerId);
      if (!value) return null;
      values[path.id] = value;
    }
    return { paths, robot, field, plannerId, status: 'ready', values, error: '' };
  }, [enabled, paths, robot, field, plannerId]);
  useEffect(() => {
    if (!enabled || reused) return undefined;
    let active = true;
    let currentRequest = null;
    const values = {};
    const unplanned = paths.filter((path) => {
      const value = reusablePlan(readyPlans.current, path, robot, field, plannerId);
      if (value) values[path.id] = value;
      return !value;
    });
    setPlanningState({ paths, robot, field, plannerId, status: 'pending', values, error: '' });
    void (async () => {
      for (const path of unplanned) {
        if (!active) return;
        currentRequest = planner.request(
          { key: path.id, path, robot, field, plannerId },
          { deadline: 'common', failureNote: 'Routine preview is unavailable.' },
        );
        const result = await currentRequest.promise;
        if (!active) return;
        const outdated = Boolean(path.optimization?.accepted) && isOptimizationOutdated(path, robot, field);
        const outcome = finalPlanningOutcome(result, path, outdated);
        // Routines block on any unusable path; there is no provisional preview.
        if (outcome.status !== 'ready') {
          setPlanningState((current) => ({ ...current, status: 'error', error: `${path.name}: ${outcome.message}` }));
          return;
        }
        readyPlans.current.set(path, { robot, field, plannerId, value: outcome.value });
        setPlanningState((current) => ({
          ...current,
          values: { ...current.values, [path.id]: outcome.value },
        }));
      }
      if (active) setPlanningState((current) => ({ ...current, status: 'ready' }));
    })();
    return () => {
      active = false;
      if (currentRequest) currentRequest.cancel();
    };
  }, [enabled, planner, reused, paths, robot, field, plannerId]);
  if (enabled && missingPathIds.length) return { status: 'error', values: {}, error: `${missingPathIds.length} ${missingPathIds.length === 1 ? 'path is' : 'paths are'} missing from this routine.`, missingPathIds };
  if (reused) return reused;
  return enabled
    && planningState.paths === paths
    && planningState.robot === robot
    && planningState.field === field
    && planningState.plannerId === plannerId
    ? planningState
    : { status: enabled ? 'pending' : 'idle', values: {}, error: '' };
}
