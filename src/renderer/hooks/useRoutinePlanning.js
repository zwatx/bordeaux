import * as React from "react";
import { FinalPlanning } from "../assets/final-planning";
import { isOptimizationOutdated } from "../../shared/planners/acceptedTrajectoryIdentity";
import { finalPlanningOutcome } from "../lib/finalPlanningResult";
import { AUTO } from "../lib/routineModel";

const { useEffect, useMemo, useRef, useState } = React;

/** Plans every path a routine references. Routine-only edits keep the ready plans. */
export function useRoutinePlanning(enabled, routine, projectPaths, robot, field, plannerId) {
  const planner = useMemo(() => FinalPlanning.create(), []);
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
  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    let currentRequest = null;
    setPlanningState({ paths, robot, field, plannerId, status: 'pending', values: {}, error: '' });
    void (async () => {
      for (const path of paths) {
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
  }, [enabled, planner, paths, robot, field, plannerId]);
  if (enabled && missingPathIds.length) return { status: 'error', values: {}, error: `${missingPathIds.length} ${missingPathIds.length === 1 ? 'path is' : 'paths are'} missing from this routine.`, missingPathIds };
  return enabled
    && planningState.paths === paths
    && planningState.robot === robot
    && planningState.field === field
    && planningState.plannerId === plannerId
    ? planningState
    : { status: enabled ? 'pending' : 'idle', values: {}, error: '' };
}
