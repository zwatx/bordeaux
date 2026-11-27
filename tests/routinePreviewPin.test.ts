// The routine preview's timing (scrubber, timeline, playback, totals) is what origin/main draws: the routine Power
// report retimes command steps from their estimates and End routine limits, but only in its own copy. Six cases,
// pinned to the values origin/main (c240e918) gives; path times are relative to the path's planned length.
import { describe, expect, it } from 'vitest';
import { buildWaypoints, createDemoProject } from '../src/core/project/defaults';
import { getPlanner } from '../src/core/planners';
// @ts-expect-error Intentional renderer JS API.
import { AUTO, routinePowerRun } from '../src/renderer/lib/routineModel';

const r = { ...createDemoProject().robot, id: 'r1' };
const use = (commandId: string, runTimeS?: number, extra = {}) => ({ commandId, arguments: {}, ...extra,
  ...(runTimeS !== undefined ? { power: { r1: { currentA: 10, runTimeS, inputKey: 'x' } } } : {}) });
const cmd = (id: string, invocation: object, extra = {}) => ({ id, type: 'function', cat: 'command', title: id, invocation, ...extra });
const wait = (id: string, durationS: number, extra = {}) => ({ id, type: 'builtin', builtinId: 'bordeaux.wait', arguments: { durationS }, ...extra });
const group = (id: string, mode: string, nodes: object[]) => ({ id, type: 'group', mode, nodes });
const ready = { endWhen: { source: 'condition', conditionId: 'ready' } };
const endsRoutine = { ends: { timeoutS: 1, onTimeout: 'endRoutine' } };
const CASES: Record<string, object[]> = {
  endRoutineTimeout: [cmd('spin', use('spinUp', 4), endsRoutine), wait('after', 5)],
  conditionEnd: [cmd('feed', use('feed', 3), { ends: { ...ready, timeoutS: 2, onTimeout: 'continue' } }), wait('hold', 2, { ends: ready }), wait('after', 1)],
  parallelEnd: [group('g', 'parallel', [cmd('feed', use('feed', 3)), cmd('spin', use('spinUp', 4), endsRoutine), wait('w', 2)]), wait('after', 2)],
  sequentialLoop: [wait('before', 0.5), group('s', 'sequential', [cmd('loop', use('roll', 0.4, { loop: { until: { kind: 'time', seconds: 1 } } })), wait('w', 1)]), cmd('free', use('free'))],
  repeatEnd: [{ id: 'rep', type: 'repeat', times: 2, nodes: [cmd('c', use('c', 1), { ends: { timeoutS: 0.5, onTimeout: 'continue' } }), wait('w', 0.25)] }, { id: 'end', type: 'end', scope: 'routine' }, wait('never', 3)],
  pathAndCommands: [wait('pre', 0.3), { id: 'drive', type: 'path', ref: 'path-a' }, cmd('shoot', use('shoot', 2), endsRoutine), wait('post', 1)],
};
const path = createDemoProject().paths[0];
path.id = 'path-a'; path.name = 'Drive out';
path.waypoints = buildWaypoints([{ x: 1, y: 2, theta: 0 }, { x: 6, y: 2, theta: 0 }]);
path.waypoints.forEach((w: { stop: boolean; thetaOn: boolean }) => { w.stop = true; w.thetaOn = true; });
path.headingMode = 'manual'; path.ranges = []; path.targets = []; path.markers = [];
path.constraints = { maxVel: 6, maxAccel: 15, maxDecel: 15, maxAngVel: 720, maxAngAccel: 2000 };

const MAIN: Record<string, unknown> = {
  endRoutineTimeout: {"steps": [["spin", "event", 0, 1, "upperBound"], ["after", "wait", 1, 6, "exact"]], "total": 6, "duration": {"minS": 5, "maxS": 6, "unknownCount": 0, "usesLimits": true}, "segs": [], "stop": "complete", "blocked": false},
  conditionEnd: {"steps": [["feed", "event", 0, 2, "upperBound"], ["hold", "wait", 2, 4, "upperBound"], ["after", "wait", 4, 5, "exact"]], "total": 5, "duration": {"minS": 1, "maxS": 5, "unknownCount": 0, "usesLimits": true}, "segs": [], "stop": "complete", "blocked": false},
  parallelEnd: {"steps": [["feed", "event", 0, 0, "unknown"], ["spin", "event", 0, 1, "upperBound"], ["w", "wait", 0, 2, "exact"], ["after", "wait", 2, 4, "exact"]], "total": 4, "duration": {"minS": 4, "maxS": null, "unknownCount": 1, "usesLimits": true}, "segs": [], "stop": "complete", "blocked": false},
  sequentialLoop: {"steps": [["before", "wait", 0, 0.5, "exact"], ["loop", "event", 0.5, 1.5, "unknown"], ["w", "wait", 1.5, 2.5, "exact"], ["free", "event", 2.5, 2.5, "unknown"]], "total": 2.5, "duration": {"minS": 1.5, "maxS": null, "unknownCount": 2, "usesLimits": false}, "segs": [], "stop": "complete", "blocked": false},
  repeatEnd: {"steps": [["rep", "repeat", 0, 0, "instant"], ["c", "event", 0, 0.5, "upperBound"], ["w", "wait", 0.5, 0.75, "exact"], ["rep", "repeat", 0.75, 0.75, "instant"], ["c", "event", 0.75, 1.25, "upperBound"], ["w", "wait", 1.25, 1.5, "exact"], ["end", "end", 1.5, 1.5, "instant"]], "total": 1.5, "duration": {"minS": 0.5, "maxS": 1.5, "unknownCount": 0, "usesLimits": true}, "segs": [], "stop": "endStep", "blocked": false},
  pathAndCommands: {"steps": [["pre", "wait", 0, 0.3, "exact"], ["drive", "path", 0.3, 0.3, "exact"], ["shoot", "event", 0.3, 1.3, "upperBound"], ["post", "wait", 1.3, 2.3, "exact"]], "total": 2.3, "duration": {"minS": 1.3, "maxS": 2.3, "unknownCount": 0, "usesLimits": true}, "segs": [["drive", 0.3, 0.3]], "stop": "complete", "blocked": false},
};

describe('routine preview timing', () => {
  it('matches origin/main for each case, before and after the Power report retimes it', () => {
    const trajectory = getPlanner('profiledSpline').generate({ robot: r, path });
    const T = trajectory.totalTimeS;
    for (const [name, nodes] of Object.entries(CASES)) {
      const run = AUTO.buildRun({ id: 'auto', name: 'Auto', nodes }, [path], r, {}, 'profiledSpline', undefined, { [path.id]: { finalTrajectory: trajectory } });
      const snapshot = () => {
        const rel = (t: number) => name === 'pathAndCommands' ? +(t - (t > 0.3 ? T : 0)).toFixed(12) : t;
        return { steps: run.steps.map((s: Record<string, number | string>) => [s.nodeId, s.kind, rel(s.t0 as number), rel(s.t1 as number), s.timing]),
          total: rel(run.total), duration: { ...run.duration, minS: rel(run.duration.minS), maxS: run.duration.maxS === null ? null : rel(run.duration.maxS) },
          segs: run.segs.map((s: Record<string, number>) => [s.nodeId, rel(s.t0), rel(s.t1)]), stop: run.stopReason ?? null, blocked: Boolean(run.blocked) };
      };
      expect(snapshot(), name).toEqual(MAIN[name]);
      routinePowerRun(run, r);
      expect(snapshot(), name + ' after routinePowerRun').toEqual(MAIN[name]);
    }
  });
});
