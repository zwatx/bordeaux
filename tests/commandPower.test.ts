import { describe, expect, it } from 'vitest';
import {
  commandInputKey, commandLoadCurrent, commandLoadWindows, commandUseEstimate, pathCommandReserveA, planningRobotForPath,
} from '../src/core/commandLoads';
import { buildWaypoints, createDemoProject } from '../src/core/project/defaults';
import { decodeProjectValue, encodeProjectFile } from '../src/core/project/fileFormat';
import {
  copyCommandUseEstimate, legacyCommandLoadsMigratable, listCommandUses, migrateLegacyCommandLoads, removeCommandUseEstimate,
  setCommandUseEstimate, unusedLegacyCommandLoads, type CommandUseLocation,
} from '../src/core/project/commandPower';
import { addRobot, duplicateRobot, duplicateRobotProblem, projectRobots, removeRobot, selectRobot, selectedRobotId } from '../src/core/project/robots';
import { analyzeRoutinePower, analyzeTrajectoryPower } from '../src/core/planners/trajectoryPower';
import { getPlanner } from '../src/core/planners';
import { pathPlanningKey } from '../src/core/planners/planningKey';
import { validateOptimizedTrajectory } from '../src/core/planners/trajectoryValidation';
import { physicalPlannerInput } from '../src/core/robotLimits';
import { buildBdxExport } from '../src/core/export/bdx';
import { buildRobotBinary } from '../src/core/export/robotBinary';
import { buildRoutineRuntime } from '../src/core/export/routineRuntime';
import { validateProject } from '../src/core/validation';
// @ts-expect-error Intentional renderer JS API.
import { routinePowerCommandSteps } from '../src/renderer/lib/routineModel';
import { binaryWriterFixture } from './fixtures/binaryWriterFixture';
import { routineRuntimeFixture } from './fixtures/routineRuntimeFixture';
import type { BordeauxProject, CommandInvocation, CommandLoad, Marker, PathDoc, RobotConfig, TrajectorySample } from '../src/core/types';

/*
 * Per-use command power estimates. Ways this can fail, written before the tests:
 *  1. A project with only legacy per-command loads plans differently once the selected robot carries its id.
 *  2. A command used twice reserves the sum of its uses, or the first one, instead of the largest.
 *  3. Two overlapping runs of one command add their currents.
 *  4. A routine's own command steps add no current to the routine estimate.
 *  5. Changing a use's arguments drops its estimate from planning, or leaves it unflagged.
 *  6. Duplicating or removing a robot rewrites paths or routines (which path and routine Undo then lose), or a copy
 *     stops sharing its original's estimates: after the original changes one, after the original is removed, or
 *     through a copy of a copy.
 *  7. Migrating legacy loads changes planning, or loses a load still in use, including after an Undo that restores a
 *     path from before the migration.
 *  8. An estimate reaches a file sent to the robot.
 *  9. Out-of-range estimates validate.
 * 10. Sharing estimates changes a planning key, or folding a robot twice plans differently.
 */

/** Synthetic electrical drive, not a real robot. */
function robot(commandLoads?: CommandLoad[], id?: string): RobotConfig {
  return { ...createDemoProject().robot, ...(id ? { id } : {}), driveModel: {
    motorId: 'rev-vortex', motorFreeRpm: 6784, motorMaxTorqueNm: 3.6, motorCount: 4,
    gearRatio: 5.5, wheelDiameterM: 0.0762, massKg: 54, moiKgM2: 5, wheelbaseM: 0.52, trackwidthM: 0.61,
    wheelFrictionCoefficient: 1.2, cgHeightM: 0.25, motorStallCurrentA: 211, motorFreeCurrentA: 3.6,
    driveCurrentLimitA: 55, batteryVoltageV: 12.5, batteryResistanceOhm: 0.02, driveEfficiency: 0.9, controlReserve: 0.1,
    otherLoadA: 5, ...(commandLoads ? { commandLoads } : {}),
  } };
}
const estimate = (currentA: number, invocation: Omit<CommandInvocation, 'power'>, runTimeS?: number) =>
  ({ currentA, ...(runTimeS !== undefined ? { runTimeS } : {}), inputKey: commandInputKey(invocation) });
/** A use of `commandId` with an estimate per robot id. */
function use(commandId: string, power: Record<string, [number, number?]> = {}, args: CommandInvocation['arguments'] = {}): CommandInvocation {
  const bare = { commandId, arguments: args };
  const entries = Object.entries(power);
  return entries.length ? { ...bare, power: Object.fromEntries(entries.map(([id, [currentA, runTimeS]]) => [id, estimate(currentA, bare, runTimeS)])) } : bare;
}
const marker = (name: string, extra: Partial<Marker>): Marker => ({ id: name, f: 0, name, ...extra });
function pathWith(invocations: CommandInvocation[]): PathDoc {
  const path = createDemoProject().paths[0];
  path.id = 'path-a';
  path.waypoints = buildWaypoints([{ x: 1, y: 2, theta: 0 }, { x: 6, y: 2, theta: 0 }]);
  path.waypoints.forEach(w => { w.stop = true; w.thetaOn = true; });
  path.headingMode = 'manual'; path.ranges = []; path.targets = [];
  path.constraints = { maxVel: 6, maxAccel: 15, maxDecel: 15, maxAngVel: 720, maxAngAccel: 2000 };
  path.markers = invocations.map((invocation, i) => marker(`m${i}`, { f: 0.2 * (i + 1), invocation }));
  return path;
}
const samples: TrajectorySample[] = Array.from({ length: 11 }, (_, i) => ({
  i, t: i, s: i, f: i / 10, x: i, y: 0, headingRad: 0, velocityMps: 1, accelerationMps2: 0, angularVelocityRadps: 0, curvatureInvM: 0,
}));
const legacy: CommandLoad[] = [{ commandId: 'shoot', currentA: 150, runTimeS: 0.5 }, { commandId: 'intake', currentA: 30 }];
function projectWith(path: PathDoc, details: RobotConfig): BordeauxProject {
  const project = createDemoProject();
  return { ...project, robot: details, paths: [path], editor: { activePathId: path.id } };
}
const at = (markerIndex: number, memberIndex?: number): CommandUseLocation =>
  ({ kind: 'pathEvent', pathId: 'path-a', markerIndex, markerId: `m${markerIndex}`, ...(memberIndex !== undefined ? { memberIndex } : {}) });

describe('legacy command loads', () => {
  it('plan an existing project exactly as before once its robot carries its id', () => {
    const path = pathWith([use('shoot'), use('intake'), use('shoot'), use('unknown')]);
    const before = robot(legacy), after = { ...before, id: 'robot' };
    expect(planningRobotForPath(after, path)).toEqual(planningRobotForPath(before, path));
    expect(pathPlanningKey(path, after)).toBe(pathPlanningKey(path, before));
    const a = getPlanner('profiledSpline').generate({ robot: before, path }), b = getPlanner('profiledSpline').generate({ robot: after, path });
    expect(b.samples).toEqual(a.samples);
    const reportA = analyzeTrajectoryPower(before, path, a)!, reportB = analyzeTrajectoryPower(after, path, b)!;
    expect(reportB).toEqual(reportA);
    expect(reportB.commandUses).toEqual({ uses: 4, estimated: 3, stale: 0 });
    // Loading such a project changes nothing: no id is added until a robot list or an estimate needs one, and saving
    // writes the same file.
    const source = projectWith(path, before);
    const loaded = decodeProjectValue(source).project;
    expect(loaded.robot).toEqual(before);
    expect(encodeProjectFile(loaded).contents).toBe(encodeProjectFile(source).contents);
    expect(encodeProjectFile(loaded).contents).not.toMatch(/"power"|"inputKey"/);
    // Once an estimate exists, loading gives the robot its id, and saving still never writes it.
    const estimated = decodeProjectValue(setCommandUseEstimate(source, at(0), 'robot', { currentA: 150, runTimeS: 0.5 })).project;
    expect(estimated.robot.id).toBe('robot');
    expect(JSON.parse(encodeProjectFile(estimated).contents).robot).not.toHaveProperty('id');
    expect(pathPlanningKey(estimated.paths[0], estimated.robot)).toBe(pathPlanningKey(path, before));
  });
});

describe('per-use estimates in planning', () => {
  it('reserve the largest estimate among a command\'s uses, falling back to the legacy load per use', () => {
    const r = robot(undefined, 'r1');
    const path = pathWith([use('shoot', { r1: [40] }), use('shoot', { r1: [70], r2: [300] }), use('intake', { r1: [20] }), use('intake')]);
    expect(pathCommandReserveA(r, path.markers)).toBe(90);
    const planned = planningRobotForPath(r, path);
    expect(planned.driveModel!.otherLoadA).toBe(95);
    expect(planned.id).toBeUndefined();
    expect(planningRobotForPath(planned, path)).toBe(planned);
    // A use without its own estimate falls back to its command's legacy load on this robot: the bare intake use reads
    // 30 A, which beats the other intake use's 20; both shoot uses have their own, so the 150 A legacy shoot load is unused.
    expect(pathCommandReserveA(robot(legacy, 'r1'), path.markers)).toBe(70 + 30);
    // Another robot reads only its own estimates.
    expect(pathCommandReserveA(robot(undefined, 'r2'), path.markers)).toBe(300);
    // Validation checks against the same reserve planning used.
    const trajectory = getPlanner('profiledSpline').generate({ robot: r, path });
    expect(validateOptimizedTrajectory({ robot: r, path }, trajectory.samples).violations).toEqual(
      validateOptimizedTrajectory(physicalPlannerInput({ robot: r, path }), trajectory.samples).violations);
  });

  it('change the planning key when an estimate or the selected robot changes, not for another robot\'s estimate', () => {
    const r1 = robot(undefined, 'r1'), path = pathWith([use('shoot', { r1: [40] })]);
    const key = pathPlanningKey(path, r1);
    expect(pathPlanningKey(pathWith([use('shoot', { r1: [60] })]), r1)).not.toBe(key);
    expect(pathPlanningKey(path, { ...r1, id: 'r2' })).not.toBe(key);
    // A key covers what plans: the reserve, not another robot's estimate or a run time.
    expect(pathPlanningKey(pathWith([use('shoot', { r1: [40], r2: [90] })]), r1)).toBe(key);
    expect(pathPlanningKey(pathWith([use('shoot', { r1: [40, 3] })]), r1)).toBe(key);
  });

  it('draw the larger of two overlapping runs of one command, never their sum', () => {
    const r = robot(undefined, 'r1');
    const markers = [marker('a', { invocation: use('shoot', { r1: [40, 5] }) }), marker('b', { invocation: use('shoot', { r1: [70, 2] }) })];
    const windows = commandLoadWindows(r, { markers }, { samples, markers: [{ id: 'a', timeS: 0 }, { id: 'b', timeS: 2 }] });
    expect([1, 3, 4.5, 6].map(t => commandLoadCurrent(windows, t))).toEqual([40, 70, 40, 0]);
  });

  it('time each use by its own run time', () => {
    const r = robot(undefined, 'r1');
    const markers = [marker('a', { invocation: use('feed', { r1: [10, 1] }) }), marker('b', { invocation: use('feed', { r1: [10, 3] }) })];
    const windows = commandLoadWindows(r, { markers }, { samples, markers: [{ id: 'a', timeS: 0 }, { id: 'b', timeS: 5 }] });
    expect(windows.map(w => [w.startTimeS, w.endTimeS])).toEqual([[0, 1], [5, 8]]);
  });
});

describe('routine command steps', () => {
  it('add their estimates to the routine power estimate', () => {
    const r = robot(undefined, 'r1');
    const step = { t0: 0, t1: 0, invocation: use('spinUp', { r1: [60, 2] }) };
    const report = analyzeRoutinePower(r, [], 3, [step])!;
    expect(report.peakMechanismCurrentA).toBe(65);
    expect(report.durationS).toBeCloseTo(3, 9);
    expect(report.commandUses).toEqual({ uses: 1, estimated: 1, stale: 0 });
    const missing = analyzeRoutinePower(r, [], 3, [{ t0: 0, t1: 1, invocation: use('spinUp') }])!;
    expect(missing.peakMechanismCurrentA).toBe(5);
    expect(missing.commandsWithoutLoad).toEqual(['spinUp']);
    // A step time limit stops it; a time loop lets its last run finish.
    const limited = analyzeRoutinePower(r, [], 3, [{ ...step, timeoutS: 0.5 }])!;
    expect(limited.peakMechanismCurrentA).toBe(65);
    const loop = { t0: 0, t1: 1, invocation: { ...use('spinUp', { r1: [60, 0.4] }), loop: { until: { kind: 'time' as const, seconds: 1 } } } };
    const path = pathWith([]), trajectory = getPlanner('profiledSpline').generate({ robot: r, path });
    const withPath = analyzeRoutinePower(r, [{ t0: 1.3, t1: 1.3 + trajectory.totalTimeS, doc: path, trajectory }], 1.3 + trajectory.totalTimeS, [loop])!;
    // Three 0.4 s runs cover 1.2 s, so the path starting at 1.3 s draws only Other mechanisms.
    expect(withPath.peakMechanismCurrentA).toBe(65);
    expect(analyzeRoutinePower(r, [{ t0: 1.1, t1: 1.1 + trajectory.totalTimeS, doc: path, trajectory }], 1.1 + trajectory.totalTimeS, [loop])!.peakMechanismCurrentA).toBe(65);
  });

  it('come from a preview run\'s command step occurrences', () => {
    const invocation = use('spinUp', { r1: [60, 2] });
    const run = { steps: [
      { kind: 'path', t0: 0, t1: 2, node: { id: 'p', type: 'path', ref: 'x' } },
      { kind: 'event', t0: 2, t1: 2, node: { id: 'c', type: 'function', cat: 'command', invocation, ends: { timeoutS: 1.5 } } },
      { kind: 'event', t0: 4, t1: 4, node: { id: 'c', type: 'function', cat: 'command', invocation } },
      { kind: 'wait', t0: 4, t1: 5, node: { id: 'w', type: 'builtin' } },
    ] };
    expect(routinePowerCommandSteps(run)).toEqual([{ t0: 2, t1: 2, invocation, timeoutS: 1.5 }, { t0: 4, t1: 4, invocation }]);
    expect(routinePowerCommandSteps(null)).toEqual([]);
  });
});

describe('project command uses', () => {
  const base = () => projectWith(pathWith([use('shoot'), use('intake')]), robot(undefined));

  it('lists every use with its location, and sets, copies and removes an estimate', () => {
    let project = base();
    project.paths[0].markers.push(marker('m2', { f: 0.9, commandGroup: { mode: 'parallel', commands: [use('feed'), use('shoot', {}, { rpm: 3000 })] } }));
    project.routines[0].nodes = [{ id: 'step', type: 'function', cat: 'command', invocation: use('spinUp') },
      { id: 'rep', type: 'repeat', times: 2, nodes: [{ id: 'inner', type: 'function', cat: 'command', invocation: use('feed') }] }];
    expect(listCommandUses(project).map(u => [u.location, u.commandId])).toEqual([
      [at(0), 'shoot'], [at(1), 'intake'], [at(2, 0), 'feed'], [at(2, 1), 'shoot'],
      [{ kind: 'routineStep', routineId: project.routines[0].id, nodeId: 'step' }, 'spinUp'],
      [{ kind: 'routineStep', routineId: project.routines[0].id, nodeId: 'inner' }, 'feed'],
    ]);
    const id = selectedRobotId(project);
    const set = setCommandUseEstimate(project, at(2, 1), id, { currentA: 45, runTimeS: 1.5 });
    expect(set.robot.id).toBe(id);
    expect(listCommandUses(set)[3].estimate).toEqual({ currentA: 45, runTimeS: 1.5, stale: false, source: 'use' });
    expect(listCommandUses(set).filter(u => u.estimate)).toHaveLength(1);
    // Out of range, or on an unknown robot, changes nothing.
    expect(setCommandUseEstimate(set, at(0), id, { currentA: 501 })).toBe(set);
    expect(setCommandUseEstimate(set, at(0), id, { currentA: 5, runTimeS: 0.001 })).toBe(set);
    expect(setCommandUseEstimate(set, at(0), 'robot_unknown', { currentA: 5 })).toBe(set);
    const step = { kind: 'routineStep' as const, routineId: project.routines[0].id, nodeId: 'inner' };
    const copied = copyCommandUseEstimate(set, at(2, 1), [at(0), step], id);
    expect(listCommandUses(copied).filter(u => u.estimate).map(u => u.commandId)).toEqual(['shoot', 'shoot', 'feed']);
    expect(copied.routines[0].nodes[1]).toMatchObject({ nodes: [{ invocation: { power: { [id]: { currentA: 45, runTimeS: 1.5, inputKey: commandInputKey(use('feed')) } } } }] });
    const removed = removeCommandUseEstimate(copied, at(2, 1), id);
    expect(removed.paths[0].markers[2].commandGroup!.commands[1]).not.toHaveProperty('power');
    expect(validateProject(copied).ok).toBe(true);
    expect(project.paths[0].markers[0]).not.toHaveProperty('power');
  });

  it('flag an estimate stale when its use\'s arguments change, and keep planning with it', () => {
    const project = setCommandUseEstimate(base(), at(0), 'robot', { currentA: 80 });
    const marker0 = project.paths[0].markers[0];
    const edited = { ...project, paths: [{ ...project.paths[0], markers: [{ ...marker0, invocation: { ...marker0.invocation!, arguments: { rpm: 4000 } } }, project.paths[0].markers[1]] }] };
    expect(listCommandUses(edited)[0].estimate).toMatchObject({ currentA: 80, stale: true, source: 'use' });
    expect(pathCommandReserveA(edited.robot, edited.paths[0].markers)).toBe(80);
    // Confirming it again records the current arguments.
    expect(listCommandUses(setCommandUseEstimate(edited, at(0), 'robot', { currentA: 80 }))[0].estimate!.stale).toBe(false);
    // Key order in arguments is not a change.
    expect(commandInputKey({ commandId: 'x', arguments: { a: 1, b: { c: 2, d: 3 } } })).toBe(commandInputKey({ commandId: 'x', arguments: { b: { d: 3, c: 2 }, a: 1 } }));
    expect(commandInputKey({ commandId: 'x', arguments: { a: 1 } })).not.toBe(commandInputKey({ commandId: 'y', arguments: { a: 1 } }));
  });

  it('copy legacy loads onto the uses in one change that plans the same, keeping the table', () => {
    const path = pathWith([use('shoot'), use('intake', { robot: [12] }), use('shoot')]);
    const project = decodeProjectValue(projectWith(path, robot([...legacy, { commandId: 'climb', currentA: 90 }]))).project;
    expect(unusedLegacyCommandLoads(project).map(l => l.commandId)).toEqual(['climb']);
    expect(legacyCommandLoadsMigratable(project)).toBe(true);
    const migrated = migrateLegacyCommandLoads(project);
    expect(migrated.robot.driveModel!.commandLoads).toEqual(project.robot.driveModel!.commandLoads);
    expect(listCommandUses(migrated).map(u => u.estimate)).toEqual([
      { currentA: 150, runTimeS: 0.5, stale: false, source: 'use' },
      { currentA: 12, stale: false, source: 'use' },
      { currentA: 150, runTimeS: 0.5, stale: false, source: 'use' },
    ]);
    // The use with its own estimate keeps it, so the reserve is the same as with the legacy table.
    expect(pathPlanningKey(migrated.paths[0], migrated.robot)).toBe(pathPlanningKey(project.paths[0], project.robot));
    const trajectory = getPlanner('profiledSpline').generate({ robot: project.robot, path: project.paths[0] });
    expect(analyzeTrajectoryPower(migrated.robot, migrated.paths[0], trajectory)).toEqual(analyzeTrajectoryPower(project.robot, project.paths[0], trajectory));
    expect(validateProject(migrated).ok).toBe(true);
    expect(migrateLegacyCommandLoads(migrated)).toBe(migrated);
    // Undo restores the path from before the copy; the table it falls back to is still there, so it plans the same.
    const undone = { ...migrated, paths: project.paths };
    expect(pathPlanningKey(undone.paths[0], undone.robot)).toBe(pathPlanningKey(project.paths[0], project.robot));
    // A load outside an estimate's range stays where it is.
    const heavy = { ...project, robot: robot([{ commandId: 'shoot', currentA: 600 }], 'robot') };
    expect(legacyCommandLoadsMigratable(heavy)).toBe(false);
    expect(migrateLegacyCommandLoads(heavy)).toBe(heavy);
    // A robot that is not selected migrates in its list entry.
    const two = selectRobot(duplicateRobot(project, 'robot'), 'robot');
    const other = two.robots!.find(r => r.id !== 'robot')!.id;
    const moved = migrateLegacyCommandLoads(two, other);
    expect(moved.robots!.find(r => r.id === other)!.robot!.driveModel!.commandLoads).toEqual(legacy.concat({ commandId: 'climb', currentA: 90 }));
    expect(commandUseEstimate(moved.paths[0].markers[0].invocation!, { id: other })).toMatchObject({ currentA: 150, source: 'use' });
    // The copy shares the original's estimate on intake, which wins over the legacy load, so it is not copied over.
    expect(moved.paths[0].markers[1].invocation!.power).toEqual(project.paths[0].markers[1].invocation!.power);
    expect(listCommandUses(moved, other)[1].estimate).toMatchObject({ currentA: 12, source: 'inherited', fromRobotId: 'robot' });
  });

});

describe('the robot boundary', () => {
  it('never sends an estimate to the robot', () => {
    const { project, path, bindings } = binaryWriterFixture();
    // As loading leaves it: the selected robot carries its id. Electrical motor data and load transfer make force
    // allocation depend on mechanism current, so the reserve shows in the exported module forces.
    project.robot = { ...project.robot, id: 'robot', driveModel: { ...project.robot.driveModel!, motorStallCurrentA: 211, motorFreeCurrentA: 3.6, cgHeightM: 0.25 } };
    path.markers[0].invocation = { ...path.markers[0].invocation!, power: { robot: { currentA: 77, inputKey: 'estimate-key-marker' } } };
    project.routines[0].nodes = [{ id: 'drive', type: 'path', ref: path.id }];
    const text = (value: unknown) => JSON.stringify(value);
    expect(text(buildBdxExport(project))).not.toMatch(/estimate-key-marker|inputKey/);
    const binary = buildRobotBinary(project, { kind: 'path', id: path.id }, bindings);
    expect(Buffer.from(binary.bytes).toString('latin1')).not.toMatch(/estimate-key-marker|inputKey/);
    // The estimate still plans: the export allocates forces under the path's reserve.
    const unloaded = structuredClone(project); delete unloaded.paths[0].markers[0].invocation!.power;
    expect(binary.moduleForcesN).not.toEqual(buildRobotBinary(unloaded, { kind: 'path', id: path.id }, bindings).moduleForcesN);

    const f = routineRuntimeFixture();
    f.project.routines[0].nodes = [{ id: 'path', type: 'path', ref: f.project.paths[0].id },
      { id: 'command', type: 'function', cat: 'command', invocation: { ...f.invocation(), power: { robot: { currentA: 20, inputKey: 'estimate-key-step' } } } }];
    const routine = buildRoutineRuntime(f.project, 'routine', f.bindings);
    expect(Buffer.from(routine.bytes).toString('utf8')).not.toMatch(/estimate-key-step|inputKey/);
    f.project.activeRoutineId = 'routine';
    expect(text(buildBdxExport(f.project).routine)).not.toMatch(/estimate-key-step|inputKey|power/);
  });
});

describe('estimate validation', () => {
  it('bounds current, run time, input key and robot count', () => {
    const project = projectWith(pathWith([use('shoot')]), robot(undefined, 'robot'));
    const invocation = project.paths[0].markers[0].invocation!;
    const check = (power: unknown) => {
      invocation.power = power as CommandInvocation['power'];
      return validateProject(project).issues.filter(i => i.path.includes('.power')).map(i => i.path.replace(/^.*\.power/, ''));
    };
    expect(check({ robot: { currentA: 0, inputKey: 'k' }, r2: { currentA: 500, runTimeS: 3600, inputKey: 'k' }, r3: { currentA: 1, runTimeS: 0.01, inputKey: 'k' } })).toEqual([]);
    expect(check({ a: { currentA: -1, inputKey: 'k' }, b: { currentA: 501, inputKey: 'k' }, c: { currentA: 1, runTimeS: 0.001, inputKey: 'k' },
      d: { currentA: 1, runTimeS: 3601, inputKey: 'k' }, e: { currentA: 1 }, f: { currentA: 1, inputKey: 'x'.repeat(129) }, g: 5 }))
      .toEqual(['.a.currentA', '.b.currentA', '.c.runTimeS', '.d.runTimeS', '.e.inputKey', '.f.inputKey', '.g']);
    // A removed robot's estimates stay for the robots that share them, so a use may hold more ids than robots.
    expect(check(Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`r${i}`, { currentA: 1, inputKey: 'k' }])))).toEqual([]);
    expect(check(Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`r${i}`, { currentA: 1, inputKey: 'k' }])))).toEqual(['']);
    expect(check([])).toEqual(['']);
    // A routine step's estimate is checked the same way.
    invocation.power = undefined;
    project.routines[0].nodes = [{ id: 'step', type: 'function', cat: 'command', invocation: { commandId: 'x', arguments: {}, power: { robot: { currentA: 900, inputKey: 'k' } } } }];
    expect(validateProject(project).issues.map(i => i.path)).toContain('$.routines[0].nodes[0].invocation.power.robot.currentA');
  });

  it('keeps estimates and the selected robot id through save and reopen', () => {
    const project = setCommandUseEstimate(projectWith(pathWith([use('shoot')]), robot(undefined)), at(0), 'robot', { currentA: 33, runTimeS: 1 });
    const reopened = decodeProjectValue(JSON.parse(encodeProjectFile(project).contents)).project;
    expect(reopened.paths[0].markers[0].invocation!.power).toEqual(project.paths[0].markers[0].invocation!.power);
    expect(reopened.robot.id).toBe('robot');
    expect(projectRobots(reopened)[0].id).toBe('robot');
  });
});

describe('a duplicated robot shares its original\'s estimates until it changes them', () => {
  /** "Robot" with an estimate on the first event (shoot) and a group member (feed); intake has none. */
  function original(): BordeauxProject {
    const path = pathWith([use('shoot'), use('intake')]);
    path.markers.push(marker('m2', { f: 0.9, commandGroup: { mode: 'parallel', commands: [use('feed'), use('spin')] } }));
    path.markers[2].commandGroup!.commands[1] = { ...path.markers[2].commandGroup!.commands[1], loop: { until: { kind: 'time', seconds: 1 } } };
    const loaded = decodeProjectValue(projectWith(path, robot())).project;
    return setCommandUseEstimate(setCommandUseEstimate(loaded, at(0), 'robot', { currentA: 80, runTimeS: 2 }), at(2, 0), 'robot', { currentA: 20 });
  }
  const reserve = (p: BordeauxProject) => pathCommandReserveA(p.robot, p.paths[0].markers);
  const trajectory = () => getPlanner('profiledSpline').generate({ robot: original().robot, path: original().paths[0] });

  it('plans the copy like the original without changing any path or routine', () => {
    const start = original();
    const copy = duplicateRobot(start, 'robot'), copyId = copy.activeRobotId!;
    expect(copy.paths).toBe(start.paths);
    expect(copy.routines).toBe(start.routines);
    expect(copy.robot).toMatchObject({ id: copyId, estimatesFrom: ['robot'] });
    expect(reserve(copy)).toBe(reserve(start));
    expect(reserve(copy)).toBe(100);
    expect(pathPlanningKey(copy.paths[0], copy.robot)).toBe(pathPlanningKey(start.paths[0], start.robot));
    const plan = trajectory();
    expect(analyzeTrajectoryPower(copy.robot, copy.paths[0], plan)).toEqual(analyzeTrajectoryPower(start.robot, start.paths[0], plan));
    expect(listCommandUses(copy).map(u => [u.commandId, u.stored, u.estimate])).toEqual([
      ['shoot', undefined, { currentA: 80, runTimeS: 2, stale: false, source: 'inherited', fromRobotId: 'robot' }],
      ['intake', undefined, undefined],
      ['feed', undefined, { currentA: 20, stale: false, source: 'inherited', fromRobotId: 'robot' }],
      ['spin', undefined, undefined],
    ]);
    expect(validateProject(copy).ok).toBe(true);
  });

  it('lets the copy override one use, and shows the original\'s later edits on the uses it did not override', () => {
    const copy = duplicateRobot(original(), 'robot'), copyId = copy.activeRobotId!;
    const overridden = setCommandUseEstimate(copy, at(0), copyId, { currentA: 50 });
    expect(listCommandUses(overridden, copyId)[0].estimate).toEqual({ currentA: 50, stale: false, source: 'use' });
    expect(listCommandUses(overridden, 'robot')[0].estimate).toMatchObject({ currentA: 80, source: 'use' });
    expect(reserve(overridden)).toBe(70);
    // The original changes both uses; the copy sees the change only where it has no estimate of its own.
    const edited = setCommandUseEstimate(setCommandUseEstimate(overridden, at(0), 'robot', { currentA: 90 }), at(2, 0), 'robot', { currentA: 35 });
    expect(listCommandUses(edited, copyId).map(u => u.estimate?.currentA)).toEqual([50, undefined, 35, undefined]);
    expect(listCommandUses(edited, 'robot').map(u => u.estimate?.currentA)).toEqual([90, undefined, 35, undefined]);
    // The original selected, from the list entry it inherits nothing.
    const back = selectRobot(edited, 'robot');
    expect(reserve(back)).toBe(125);
    expect(reserve(selectRobot(back, copyId))).toBe(85);
    // Removing the copy's own estimate shares the original's again.
    expect(listCommandUses(removeCommandUseEstimate(edited, at(0), copyId), copyId)[0].estimate).toMatchObject({ currentA: 90, source: 'inherited' });
  });

  it('keeps the copy\'s shared estimates after the original is removed, and never changes paths or routines', () => {
    const copy = duplicateRobot(original(), 'robot'), copyId = copy.activeRobotId!;
    for (const removed of [removeRobot(copy, 'robot'), removeRobot(selectRobot(copy, 'robot'), 'robot')]) {
      expect(removed.paths).toBe(copy.paths);
      expect(removed.routines).toBe(copy.routines);
      expect(projectRobots(removed).map(r => r.id)).toEqual([copyId]);
      expect(removed.robot.estimatesFrom).toEqual(['robot']);
      expect(reserve(removed)).toBe(100);
      expect(listCommandUses(removed)[0].estimate).toMatchObject({ currentA: 80, source: 'inherited', fromRobotId: 'robot' });
      expect(validateProject(removed).ok).toBe(true);
    }
    // Removing the copy leaves the original's estimates and the uses as they were.
    const withoutCopy = removeRobot(copy, copyId);
    expect(withoutCopy.paths).toBe(copy.paths);
  });

  it('shares through a copy of a copy, nearest robot first', () => {
    const first = duplicateRobot(original(), 'robot'), a = first.activeRobotId!;
    const withA = setCommandUseEstimate(first, at(2, 0), a, { currentA: 25 });
    const second = duplicateRobot(withA, a), b = second.activeRobotId!;
    expect(second.paths).toBe(withA.paths);
    expect(second.robot.estimatesFrom).toEqual([a, 'robot']);
    expect(listCommandUses(second, b).map(u => [u.estimate?.currentA, u.estimate?.fromRobotId])).toEqual([[80, 'robot'], [undefined, undefined], [25, a], [undefined, undefined]]);
    expect(reserve(second)).toBe(105);
    // Duplicating the original again starts from the original only; the list has no repeats and stays bounded.
    expect(duplicateRobot(second, 'robot').robot.estimatesFrom).toEqual(['robot']);
    const looped = { ...second, robot: { ...second.robot, estimatesFrom: [a, 'robot', a] } };
    expect(duplicateRobot(looped, b).robot.estimatesFrom).toEqual([b, a, 'robot']);
    // Planning folds the shared estimates in once; folding again changes nothing.
    const folded = planningRobotForPath(second.robot, second.paths[0]);
    expect(folded).not.toHaveProperty('estimatesFrom');
    expect(folded).not.toHaveProperty('id');
    expect(planningRobotForPath(folded, second.paths[0])).toEqual(folded);
    expect(folded.driveModel!.otherLoadA).toBe(5 + 105);
  });

  it('keeps the original first when a long share list is cut, and refuses a copy whose deciding robots don\'t fit', () => {
    // An original sharing from 30 robots still in the project and three since deleted, two of which decide a use.
    const build = (deciding: string[]) => {
      const path = pathWith(deciding.map((id, i) => use('c' + i, { [id]: [10 + i] })));
      path.markers.forEach((item, i) => { item.f = (i + 1) / 40; });
      let project = decodeProjectValue(projectWith(path, robot(undefined, 'robot'))).project;
      for (let i = 0; i < 30; i++) project = addRobot(project, 'R' + i);
      project = selectRobot(project, 'robot');
      const live = projectRobots(project).map((entry) => entry.id).filter((id) => id !== 'robot');
      return { ...project, robot: { ...project.robot, estimatesFrom: [...live, ...deciding, 'gone-x'] } };
    };
    const project = build(['gone-a', 'gone-b']);
    expect(duplicateRobotProblem(project, 'robot')).toBeNull();
    const copy = duplicateRobot(project, 'robot');
    expect(copy.robot.estimatesFrom).toEqual(['robot', 'gone-a', 'gone-b']);
    // The copy still plans with every estimate it had, and later ones entered on the original reach it.
    expect(listCommandUses(copy, copy.activeRobotId!).map((u) => u.estimate?.currentA)).toEqual([10, 11]);
    const later = setCommandUseEstimate(copy, at(0), 'robot', { currentA: 99 });
    expect(listCommandUses(later, copy.activeRobotId!)[0].estimate).toMatchObject({ currentA: 99, fromRobotId: 'robot' });
    // With the original, more deciding robots than a list holds: no copy, and the reason.
    const crowded = build(Array.from({ length: 32 }, (_, i) => 'gone-' + i));
    expect(duplicateRobotProblem(crowded, 'robot')).toMatch(/shares power estimates from more than 32 robots/);
    expect(duplicateRobot(crowded, 'robot')).toBe(crowded);
  });

  it('flags a shared estimate stale once the use\'s arguments change, and keeps planning with it', () => {
    const copy = duplicateRobot(original(), 'robot');
    const marker0 = copy.paths[0].markers[0];
    const edited = { ...copy, paths: [{ ...copy.paths[0], markers: [{ ...marker0, invocation: { ...marker0.invocation!, arguments: { rpm: 4000 } } }, ...copy.paths[0].markers.slice(1)] }] };
    expect(listCommandUses(edited)[0].estimate).toMatchObject({ currentA: 80, stale: true, source: 'inherited', fromRobotId: 'robot' });
    expect(reserve(edited)).toBe(100);
    const plan = trajectory();
    expect(analyzeTrajectoryPower(edited.robot, edited.paths[0], plan)!.commandUses).toEqual({ uses: 4, estimated: 2, stale: 1 });
  });

  it('shares estimates on routine command steps and in a routine estimate', () => {
    const start = original();
    start.routines[0].nodes = [{ id: 'step', type: 'function', cat: 'command', invocation: use('spinUp', { robot: [30, 1] }) }];
    const copy = duplicateRobot(start, 'robot');
    const steps = [{ t0: 0, t1: 0, invocation: (copy.routines[0].nodes[0] as { invocation: CommandInvocation }).invocation }];
    const plan = trajectory();
    const segments = [{ t0: 2, t1: 2 + plan.samples.at(-1)!.t, doc: copy.paths[0], trajectory: plan }];
    const total = segments[0].t1;
    expect(analyzeRoutinePower(copy.robot, segments, total, steps)).toEqual(analyzeRoutinePower(start.robot, segments, total, steps));
    expect(analyzeRoutinePower(copy.robot, segments, total, steps)!.commandUses).toEqual({ uses: 5, estimated: 3, stale: 0 });
    expect(listCommandUses(copy).at(-1)!.estimate).toMatchObject({ currentA: 30, source: 'inherited' });
  });

  it('saves which robots a robot shares estimates from, bounded like robot ids, and plans the same after reopening', () => {
    const copy = duplicateRobot(duplicateRobot(original(), 'robot'), 'robot');
    const second = copy.activeRobotId!;
    const unselected = selectRobot(copy, 'robot');
    const reopened = decodeProjectValue(JSON.parse(encodeProjectFile(unselected).contents)).project;
    expect(reopened.robots!.map(r => r.robot?.estimatesFrom)).toEqual([undefined, ['robot'], ['robot']]);
    const back = selectRobot(reopened, second);
    expect(back.robot.estimatesFrom).toEqual(['robot']);
    expect(reserve(back)).toBe(100);
    expect(pathPlanningKey(back.paths[0], back.robot)).toBe(pathPlanningKey(copy.paths[0], copy.robot));
    // A robot list entry is validated the same way as the selected robot.
    const check = (estimatesFrom: unknown, listed = false) => {
      const target = structuredClone(unselected);
      if (listed) (target.robots!.find(r => r.id === second)!.robot as unknown as Record<string, unknown>).estimatesFrom = estimatesFrom;
      else (target.robot as unknown as Record<string, unknown>).estimatesFrom = estimatesFrom;
      return validateProject(target).issues.map(i => i.path).filter(p => p.endsWith('estimatesFrom'));
    };
    expect(check(Array.from({ length: 32 }, (_, i) => `r${i}`))).toEqual([]);
    expect(check(['x'.repeat(256)], true)).toEqual([]);
    const index = unselected.robots!.findIndex(r => r.id === second);
    for (const bad of [Array.from({ length: 33 }, (_, i) => `r${i}`), ['a', 'a'], [''], ['x'.repeat(257)], [5], 'robot', {}]) {
      expect(check(bad)).toEqual(['$.robot.estimatesFrom']);
      expect(check(bad, true)).toEqual([`$.robots[${index}].robot.estimatesFrom`]);
    }
  });

  it('keeps the planning key and plan of a robot that shares nothing', () => {
    const start = original();
    const inherits = { ...start.robot, estimatesFrom: ['robot_gone'] };
    expect(pathPlanningKey(start.paths[0], inherits)).toBe(pathPlanningKey(start.paths[0], start.robot));
    expect(planningRobotForPath(inherits, start.paths[0])).toEqual(planningRobotForPath(start.robot, start.paths[0]));
  });
});
