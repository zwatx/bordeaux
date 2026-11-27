import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { commandInputKey, routineCommandStepRunS } from '../src/core/commandLoads';
import { buildWaypoints, createDemoProject } from '../src/core/project/defaults';
import { getPlanner } from '../src/core/planners';
import { analyzeRoutinePower } from '../src/core/planners/trajectoryPower';
// @ts-expect-error Intentional renderer JS API.
import { AUTO, routinePowerRun } from '../src/renderer/lib/routineModel';
// @ts-expect-error Intentional renderer JS API.
import { PowerAnalysis, powerJob, startPowerAnalysis, untimedRoutineMessage } from '../src/renderer/components/PowerAnalysis';
// @ts-expect-error Intentional renderer JS API.
import { processPathPreviewJob } from '../src/renderer/assets/path-preview-worker';
import type { CommandInvocation, PathDoc, RobotConfig, RoutineNode } from '../src/core/types';

/*
 * The routine Power report counts a command step's estimated Runs for as the step's duration. Ways this can fail:
 *  1. The step's estimate shows in the report but later paths still start where the preview drew them, so its
 *     window overlaps them (or ends early) and the timeline is wrong.
 *  2. The preview itself (scrubber, playback, totals) starts using the estimate.
 *  3. A step still without a known length is silently estimated as instant, or refused without saying which step.
 *  4. Parallel and sequential groups time their children differently from the preview.
 *  5. A routine step and a path event of the same command add their currents where they overlap.
 *  6. The worker never receives the steps.
 */

/** Synthetic electrical drive, not a real robot. */
function robot(): RobotConfig {
  return { ...createDemoProject().robot, id: 'r1', driveModel: {
    motorId: 'rev-vortex', motorFreeRpm: 6784, motorMaxTorqueNm: 3.6, motorCount: 4,
    gearRatio: 5.5, wheelDiameterM: 0.0762, massKg: 54, moiKgM2: 5, wheelbaseM: 0.52, trackwidthM: 0.61,
    wheelFrictionCoefficient: 1.2, cgHeightM: 0.25, motorStallCurrentA: 211, motorFreeCurrentA: 3.6,
    driveCurrentLimitA: 55, batteryVoltageV: 12.5, batteryResistanceOhm: 0.02, driveEfficiency: 0.9, controlReserve: 0.1,
    otherLoadA: 5,
  } };
}
/** A use of `commandId` with robot r1's estimate. */
function use(commandId: string, currentA?: number, runTimeS?: number, extra: Partial<CommandInvocation> = {}): CommandInvocation {
  const bare = { commandId, arguments: {} };
  return { ...bare, ...extra, ...(currentA !== undefined ? { power: { r1: { currentA, ...(runTimeS !== undefined ? { runTimeS } : {}), inputKey: commandInputKey(bare) } } } : {}) };
}
const cmd = (id: string, invocation: CommandInvocation, extra: Record<string, unknown> = {}): RoutineNode =>
  ({ id, type: 'function', cat: 'command', title: id, invocation, ...extra } as RoutineNode);
const wait = (id: string, durationS: number): RoutineNode => ({ id, type: 'builtin', builtinId: 'bordeaux.wait', arguments: { durationS } });
const group = (id: string, mode: 'parallel' | 'sequential', nodes: RoutineNode[]): RoutineNode => ({ id, type: 'group', mode, nodes });
const timeLoop = { loop: { until: { kind: 'time' as const, seconds: 1 } } };

function pathWith(invocations: CommandInvocation[] = []): PathDoc {
  const path = createDemoProject().paths[0];
  path.id = 'path-a'; path.name = 'Drive out';
  path.waypoints = buildWaypoints([{ x: 1, y: 2, theta: 0 }, { x: 6, y: 2, theta: 0 }]);
  path.waypoints.forEach(w => { w.stop = true; w.thetaOn = true; });
  path.headingMode = 'manual'; path.ranges = []; path.targets = [];
  path.constraints = { maxVel: 6, maxAccel: 15, maxDecel: 15, maxAngVel: 720, maxAngAccel: 2000 };
  path.markers = invocations.map((invocation, i) => ({ id: `m${i}`, name: `m${i}`, f: 0, invocation }));
  return path;
}
function preview(nodes: RoutineNode[], path = pathWith()) {
  const r = robot(), trajectory = getPlanner('profiledSpline').generate({ robot: r, path });
  const run = AUTO.buildRun({ id: 'auto', name: 'Auto', nodes }, [path], r, {}, 'profiledSpline', undefined, { [path.id]: { finalTrajectory: trajectory } });
  return { r, run, trajectory, routine: { id: 'auto', name: 'Auto', nodes } };
}
type Step = { nodeId: string; t0: number; t1: number; timing: string };
const spans = (run: { steps: Step[] }) => Object.fromEntries(run.steps.map(step => [step.nodeId, [step.t0, step.t1]]));

describe('routine Power report timing', () => {
  it('counts a step\'s Runs for as its duration and moves later paths, leaving the preview as it was', () => {
    const { r, run, trajectory } = preview([cmd('spin', use('spinUp', 60, 1.5)), { id: 'drive', type: 'path', ref: 'path-a' } as RoutineNode]);
    const T = trajectory.totalTimeS;
    const timed = routinePowerRun(run, r);
    expect(timed.untimed).toEqual([]);
    expect(timed.run.segs[0]).toMatchObject({ t0: 1.5, t1: 1.5 + T });
    expect(timed.run.total).toBeCloseTo(1.5 + T, 9);
    expect(timed.run.duration).toMatchObject({ unknownCount: 0, usesLimits: false, minS: 1.5 + T });
    // The preview still draws the step as instant with an unknown length.
    expect(run.segs[0]).toMatchObject({ t0: 0 });
    expect(run.total).toBeCloseTo(T, 9);
    expect(run.duration.unknownCount).toBe(1);
    expect(run.steps.find((step: Step) => step.nodeId === 'spin')).toMatchObject({ t0: 0, t1: 0, timing: 'unknown' });

    // The worker receives the retimed steps and the report shows the step's load before the path starts.
    const job = powerJob({ robot: r, run: timed.run });
    expect(job).toMatchObject({ mode: 'power', totalTimeS: timed.run.total, commandSteps: [{ t0: 0, t1: 1.5 }], segments: [{ t0: 1.5 }] });
    expect(job.commandSteps[0].invocation.commandId).toBe('spinUp');
    const report = processPathPreviewJob(job).value;
    expect(report.peakMechanismCurrentA).toBe(65);
    expect(report.durationS).toBeCloseTo(1.5 + T, 9);
    expect(report.commandUses).toEqual({ uses: 1, estimated: 1, stale: 0 });
    expect(report).toEqual(analyzeRoutinePower(r, job.segments, job.totalTimeS, job.commandSteps));
  });

  it('times loops and step time limits the way the step\'s load window does', () => {
    const r = robot();
    expect(routineCommandStepRunS(r, { invocation: use('a', 10, 0.4, timeLoop) })).toBeCloseTo(1.2, 9);
    expect(routineCommandStepRunS(r, { invocation: use('a', 10, 3), timeoutS: 1 })).toBe(1);
    expect(routineCommandStepRunS(r, { invocation: use('a', 10) })).toBeUndefined();
    expect(routineCommandStepRunS(r, { invocation: use('a', 10, 2, { loop: { until: { kind: 'distance', meters: 1 } } } as Partial<CommandInvocation>) })).toBeUndefined();
    // A time limit without a Runs for only bounds the step, so the report still refuses; with one, the step is exact.
    const limited = preview([cmd('feed', use('feed', 20), { ends: { timeoutS: 2 } })]);
    expect(routinePowerRun(limited.run, limited.r).untimed).toEqual([expect.objectContaining({ nodeId: 'feed', runTimeHelps: true })]);
    const exact = preview([cmd('feed', use('feed', 20, 3), { ends: { timeoutS: 2 } }), wait('after', 1)]);
    const timed = routinePowerRun(exact.run, exact.r);
    expect(spans(timed.run)).toMatchObject({ feed: [0, 2], after: [2, 3] });
    expect(timed.untimed).toEqual([]);
  });

  it('times parallel and sequential groups on the preview\'s clock', () => {
    const nodes = (mode: 'parallel' | 'sequential') => [wait('before', 0.5), group('g', mode, [cmd('spin', use('spinUp', 60, 2)), wait('w', 1)]), wait('after', 0.5)];
    const parallel = preview(nodes('parallel')), sequential = preview(nodes('sequential'));
    const p = routinePowerRun(parallel.run, parallel.r).run, s = routinePowerRun(sequential.run, sequential.r).run;
    expect(spans(p)).toMatchObject({ before: [0.5 - 0.5, 0.5], spin: [0.5, 2.5], w: [0.5, 1.5], after: [2.5, 3] });
    expect(p.groupSpans).toEqual([expect.objectContaining({ nodeId: 'g', t0: 0.5, t1: 2.5 })]);
    expect(p.steps.map((step: Step) => step.t1)).toEqual([...p.steps.map((step: Step) => step.t1)].sort((a, b) => a - b));
    expect(spans(s)).toMatchObject({ spin: [0.5, 2.5], w: [2.5, 3.5], after: [3.5, 4] });
    expect(s.total).toBeCloseTo(4, 9);
    // The preview's group still ends with its wait.
    expect(parallel.run.groupSpans[0]).toMatchObject({ t0: 0.5, t1: 1.5 });
  });

  it('draws the larger of a routine step and a path event of one command where they overlap, never their sum', () => {
    // The path's shoot event outlasts the path; the routine's shoot step starts while it still runs.
    const { r, run, trajectory } = preview([{ id: 'drive', type: 'path', ref: 'path-a' } as RoutineNode, cmd('shoot', use('shoot', 70, 2))],
      pathWith([use('shoot', 40, 30)]));
    const timed = routinePowerRun(run, r);
    const report = processPathPreviewJob(powerJob({ robot: r, run: timed.run })).value;
    expect(timed.run.steps.find((step: Step) => step.nodeId === 'shoot')).toMatchObject({ t0: trajectory.totalTimeS });
    expect(report.peakMechanismCurrentA).toBe(75);
  });

  it('names the command steps that need a Runs for, and keeps the general refusal for anything else', () => {
    const nodes = [
      wait('w', 1), cmd('Spin shooter', use('spinUp', 60)),
      group('g', 'parallel', [cmd('Feed', use('feed')), wait('w2', 1)]),
    ];
    const missing = preview(nodes), timed = routinePowerRun(missing.run, missing.r);
    expect(timed.untimed.map((step: { nodeId: string; runTimeHelps: boolean }) => [step.nodeId, step.runTimeHelps])).toEqual([['Spin shooter', true], ['Feed', true]]);
    expect(untimedRoutineMessage(timed.untimed, missing.routine)).toBe(
      'A whole-routine estimate needs every step\'s duration. Add a Runs for to Spin shooter (step 2) and Feed (in step 3), or analyze the routine’s paths individually.');
    // A step that ends on a condition (an output loop) is named with that reason; a Runs for can't time it.
    const outputLoop = { loop: { until: { kind: 'output', output: 'done', schema: { kind: 'boolean' }, operator: 'eq', value: true } } } as unknown as Partial<CommandInvocation>;
    const other = preview([cmd('Aim', use('aim', 10, 1, outputLoop))]);
    const otherTimed = routinePowerRun(other.run, other.r);
    expect(otherTimed.untimed).toEqual([expect.objectContaining({ nodeId: 'Aim', runTimeHelps: false, condition: true })]);
    expect(untimedRoutineMessage(otherTimed.untimed, other.routine)).toBe(
      'A whole-routine estimate needs every step\'s duration. Aim (step 1) can’t be timed: its end depends on a condition. Analyze the routine’s paths individually instead.');
    const both = preview([cmd('Spin shooter', use('spinUp')), cmd('Aim', use('aim', 10, 1, outputLoop))]);
    expect(untimedRoutineMessage(routinePowerRun(both.run, both.r).untimed, both.routine)).toBe(
      'A whole-routine estimate needs every step\'s duration. Add a Runs for to Spin shooter (step 1). Aim (step 2) can’t be timed: its end depends on a condition. Analyze the routine’s paths individually instead.');
    // Anything else untimed keeps the general message.
    const general = [{ nodeId: 'x', node: { id: 'x', type: 'function', cat: 'command', title: 'x' }, runTimeHelps: false }];
    expect(untimedRoutineMessage(general, { nodes: general.map(step => step.node) })).toBe('This routine contains unknown or conditional durations. A whole-routine heat estimate needs exact timing; analyze its individual paths instead.');
    expect(untimedRoutineMessage([...general, { ...general[0], nodeId: 'y', node: { ...general[0].node, id: 'y', title: 'y' }, runTimeHelps: true }], { nodes: [general[0].node, { ...general[0].node, id: 'y', title: 'y' }] })).toBe(
      'A whole-routine estimate needs every step\'s duration. Add a Runs for to y (step 2). Other steps also have unknown or conditional durations, so analyze the routine’s paths individually.');
    // A step that repeats is named once; long lists are shortened.
    const repeated = preview([{ id: 'rep', type: 'repeat', times: 3, nodes: [cmd('Spin shooter', use('spinUp'))] } as RoutineNode]);
    expect(routinePowerRun(repeated.run, repeated.r).untimed).toHaveLength(1);
    const many = ['A', 'B', 'C', 'D'].map(id => ({ nodeId: id, node: { id, type: 'function', cat: 'command', title: id }, runTimeHelps: true }));
    expect(untimedRoutineMessage(many, { nodes: many.map(step => step.node) })).toContain('Add a Runs for to A (step 1), B (step 2) and 2 more steps, or');
  });

  it('ends the timeline where a time limit set to End routine stops the routine', () => {
    const endsRoutine = { ends: { timeoutS: 1, onTimeout: 'endRoutine' } };
    const cut = preview([cmd('spin', use('spinUp', 60, 4), endsRoutine), wait('after', 5)]);
    const timed = routinePowerRun(cut.run, cut.r);
    expect(timed.untimed).toEqual([]);
    expect(spans(timed.run)).toEqual({ spin: [0, 1] });
    expect(timed.run.total).toBe(1);
    expect(timed.run.duration).toMatchObject({ minS: 1, maxS: 1, unknownCount: 0 });
    // The preview still runs to the wait's end (its limit bounds the step there).
    expect(cut.run.steps.map((step: Step) => step.nodeId)).toEqual(['spin', 'after']);
    // A run that finishes inside its limit, or a limit that continues, leaves the rest of the routine to run.
    const inside = preview([cmd('spin', use('spinUp', 60, 0.5), endsRoutine), wait('after', 5)]);
    expect(routinePowerRun(inside.run, inside.r).run.total).toBeCloseTo(5.5, 9);
    const continues = preview([cmd('spin', use('spinUp', 60, 4), { ends: { timeoutS: 1, onTimeout: 'continue' } }), wait('after', 5)]);
    expect(routinePowerRun(continues.run, continues.r).run.total).toBeCloseTo(6, 9);
  });

  it('treats a time loop that finishes at its End routine limit as finishing, and times a longer loop by its limit', () => {
    // Three 0.1 s runs sum to 0.30000000000000004 s: finishing at the 0.3 s limit is not a timeout, so the wait still runs.
    const loop = (seconds: number, runTimeS?: number) => use('spinUp', 60, runTimeS, { loop: { until: { kind: 'time', seconds } } });
    const atLimit = preview([cmd('spin', loop(0.3, 0.1), { ends: { timeoutS: 0.3, onTimeout: 'endRoutine' } }), wait('after', 5)]);
    const finished = routinePowerRun(atLimit.run, atLimit.r);
    expect(finished.run.steps.map((step: Step) => step.nodeId)).toEqual(['spin', 'after']);
    expect(finished.run.total).toBeCloseTo(5.3, 9);
    // A 5 s time loop can't end before a 1 s limit, so the step ends exactly there without a Runs for, and the routine with it.
    const longLoop = preview([cmd('spin', loop(5), { ends: { timeoutS: 1, onTimeout: 'endRoutine' } }), wait('after', 5)]);
    const cut = routinePowerRun(longLoop.run, longLoop.r);
    expect(cut.untimed).toEqual([]);
    expect(spans(cut.run)).toEqual({ spin: [0, 1] });
    expect(cut.run.total).toBe(1);
    // A limit equal to the loop's could go either way (0.5 s runs finish at 1 s, 0.6 s runs are cut off), so without a
    // Runs for the step is named instead of guessed.
    const equal = preview([cmd('spin', loop(1), { ends: { timeoutS: 1, onTimeout: 'endRoutine' } }), wait('after', 5)]);
    expect(routinePowerRun(equal.run, equal.r).untimed).toEqual([expect.objectContaining({ nodeId: 'spin', runTimeHelps: true })]);
    expect(routinePowerRun(preview([cmd('spin', loop(1, 0.5), { ends: { timeoutS: 1, onTimeout: 'endRoutine' } }), wait('after', 5)]).run, equal.r).run.total).toBeCloseTo(6, 9);
    expect(routinePowerRun(preview([cmd('spin', loop(1, 0.6), { ends: { timeoutS: 1, onTimeout: 'endRoutine' } }), wait('after', 5)]).run, equal.r).run.total).toBeCloseTo(1, 9);
    // With Continue the step ends at 1 s either way and the routine goes on, so it is exact without a Runs for.
    const continues = preview([cmd('spin', loop(1), { ends: { timeoutS: 1, onTimeout: 'continue' } }), wait('after', 5)]);
    const goesOn = routinePowerRun(continues.run, continues.r);
    expect(goesOn.untimed).toEqual([]);
    expect(goesOn.run.total).toBeCloseTo(6, 9);
    expect(spans(goesOn.run).spin).toEqual([0, 1]);
  });

  it('stops the steps running beside a step whose limit ends the routine', () => {
    const nodes = [group('g', 'parallel', [cmd('feed', use('feed', 20, 3)), cmd('spin', use('spinUp', 60, 4), { ends: { timeoutS: 1, onTimeout: 'endRoutine' } }), wait('w', 2)]), wait('after', 2)];
    const { r, run } = preview(nodes);
    const timed = routinePowerRun(run, r);
    expect(spans(timed.run)).toEqual({ feed: [0, 1], spin: [0, 1], w: [0, 1] });
    expect(timed.run.total).toBe(1);
    expect(timed.run.groupSpans).toEqual([expect.objectContaining({ nodeId: 'g', t0: 0, t1: 1 })]);
    // The worker's windows stop there too: the feed draws only until the routine ends.
    const job = powerJob({ robot: r, run: timed.run });
    expect(job.totalTimeS).toBe(1);
    const report = processPathPreviewJob(job).value;
    expect(report.durationS).toBeCloseTo(1, 9);
    expect(report.peakMechanismCurrentA).toBe(85);
  });

  it('counts a step that ends on a condition as unknown, even with a Runs for, and says why', () => {
    const ready = { endWhen: { source: 'condition', conditionId: 'ready' } };
    const { r, run, routine } = preview([cmd('Feed', use('feed', 20, 3), { ends: ready }), wait('after', 1)]);
    const timed = routinePowerRun(run, r);
    expect(timed.untimed).toEqual([expect.objectContaining({ nodeId: 'Feed', runTimeHelps: false, condition: true })]);
    expect(timed.run.steps.find((step: Step) => step.nodeId === 'Feed')).toMatchObject({ timing: 'unknown' });
    expect(untimedRoutineMessage(timed.untimed, routine)).toBe(
      'A whole-routine estimate needs every step\'s duration. Feed (step 1) can’t be timed: its end depends on a condition. Analyze the routine’s paths individually instead.');
    // A wait that ends on a condition is named the same way.
    const waits = preview([{ ...wait('Hold', 2), ends: ready } as RoutineNode]);
    expect(routinePowerRun(waits.run, waits.r).untimed).toEqual([expect.objectContaining({ nodeId: 'Hold', condition: true })]);
  });

  it('refuses an untimed routine with a job that can still be cancelled', async () => {
    const { r, run, routine } = preview([cmd('Spin shooter', use('spinUp', 60))]);
    const job = startPowerAnalysis({ robot: r, timed: routinePowerRun(run, r), routine });
    // Closing the report cancels whatever job it started, refused or not.
    expect(() => job.cancel()).not.toThrow();
    await expect(job).rejects.toThrow('Add a Runs for to Spin shooter (step 1)');
  });

  it('opens the routine report for a step estimate, or to say which step needs a Runs for', () => {
    const disabled = (run: unknown, r: RobotConfig) => /<button[^>]*disabled/.test(renderToStaticMarkup(React.createElement(PowerAnalysis, { robot: r, run })));
    // A routine of only command steps has no preview length, but its estimate has one.
    const timedOnly = preview([cmd('spin', use('spinUp', 60, 1.5))]);
    expect(timedOnly.run.total).toBe(0);
    expect(disabled(timedOnly.run, timedOnly.r)).toBe(false);
    const untimedOnly = preview([cmd('spin', use('spinUp', 60))]);
    expect(disabled(untimedOnly.run, untimedOnly.r)).toBe(false);
    // Nothing to time or explain: unavailable, as before.
    const instant = preview([{ id: 'd', type: 'decision', cond: 'x', then: [], else: [] } as unknown as RoutineNode]);
    expect(disabled(instant.run, instant.r)).toBe(true);
    expect(disabled({ ...timedOnly.run, blocked: true }, timedOnly.r)).toBe(true);
  });
});
