import { describe, expect, it, vi } from 'vitest';
import * as moduleForces from '../src/core/export/moduleForces';
import { commandLoadCurrent, commandLoadWindows, commandsWithoutLoad, pathCommandReserveA, planningRobotForPath } from '../src/core/commandLoads';
import { mechanismCurrent } from '../src/core/electricalPower';
import { createDemoProject, buildWaypoints } from '../src/core/project/defaults';
import { analyzeRoutinePower, analyzeTrajectoryPower } from '../src/core/planners/trajectoryPower';
import { getPlanner } from '../src/core/planners';
import { planPath } from '../src/core/planners/planPath';
import { physicalPlannerInput } from '../src/core/robotLimits';
import { validateProject } from '../src/core/validation';
import { validateOptimizedTrajectory } from '../src/core/planners/trajectoryValidation';
import { pathPlanningKey } from '../src/core/planners/planningKey';
import { buildRobotBinary } from '../src/core/export/robotBinary';
import { binaryWriterFixture } from './fixtures/binaryWriterFixture';
import type { CommandInvocation, Marker, PathDoc, RobotConfig, TrajectorySample } from '../src/core/types';

function robot(commandLoads?: NonNullable<RobotConfig['driveModel']>['commandLoads']): RobotConfig {
  return { ...createDemoProject().robot, driveModel: {
    motorId: 'rev-vortex', motorFreeRpm: 6784, motorMaxTorqueNm: 3.6, motorCount: 4,
    gearRatio: 5.5, wheelDiameterM: 0.0762, massKg: 54, moiKgM2: 5, wheelbaseM: 0.52, trackwidthM: 0.61,
    wheelFrictionCoefficient: 1.2, cgHeightM: 0.25, motorStallCurrentA: 211, motorFreeCurrentA: 3.6,
    driveCurrentLimitA: 55, batteryVoltageV: 12.5, batteryResistanceOhm: 0.02, driveEfficiency: 0.9, controlReserve: 0.1,
    otherLoadA: 5, ...(commandLoads ? { commandLoads } : {}),
  } };
}
const run = (commandId: string, extra: Partial<CommandInvocation> = {}): CommandInvocation => ({ commandId, arguments: {}, ...extra });
const marker = (name: string, extra: Partial<Marker>): Marker => ({ id: name, f: 0, name, ...extra });
/** A 10 s straight path at 1 m/s, so time and distance read the same. */
const samples: TrajectorySample[] = Array.from({ length: 11 }, (_, i) => ({
  i, t: i, s: i, f: i / 10, x: i, y: 0, headingRad: 0, velocityMps: 1, accelerationMps2: 0, angularVelocityRadps: 0, curvatureInvM: 0,
}));
/** Windows as [command, start, end, current], in the coalesced order: by command, then start. */
const windowsFor = (r: RobotConfig, markers: Marker[], times: number[], offsetS = 0, path = samples) =>
  commandLoadWindows(r, { markers }, { samples: path, markers: markers.map((m, i) => ({ id: m.id, timeS: times[i] })) }, offsetS)
    .map(({ commandId, startTimeS, endTimeS, currentA }) => [commandId, +startTimeS.toFixed(9), +endTimeS.toFixed(9), currentA]);

describe('command load windows', () => {
  const loads = robot([{ commandId: 'shoot', currentA: 60, runTimeS: 1.5 }, { commandId: 'intake', currentA: 25 }, { commandId: 'feed', currentA: 10, runTimeS: 0.5 }]);

  it('times a run from its event, and runs an open-ended command to the end of the path', () => {
    expect(windowsFor(loads, [marker('a', { invocation: run('shoot') }), marker('b', { invocation: run('intake') })], [2, 3]))
      .toEqual([['intake', 3, 10, 25], ['shoot', 2, 3.5, 60]]);
  });

  it('stops at a loop limit or a path-end cancel, letting a loop\'s last timed run finish', () => {
    expect(windowsFor(loads, [
      marker('time', { invocation: run('intake', { loop: { until: { kind: 'time', seconds: 2 } } }) }),
      marker('dist', { invocation: run('shoot', { loop: { until: { kind: 'distance', meters: 3 } } }) }),
      marker('cancel', { invocation: run('feed', { cancelOnPathEnd: true }) }),
    ], [1, 4, 9.8])).toEqual([['feed', 9.8, 10, 10], ['intake', 1, 3, 25], ['shoot', 4, 7, 60]]);
    // 1.5 s runs start at 4 and 5.5; the second ends exactly at the 3 m limit at 7, so none starts after it.
    // With a 2.5 m limit (6.5 s) the run started at 5.5 still finishes at 7.
    expect(windowsFor(loads, [marker('d', { invocation: run('shoot', { loop: { until: { kind: 'distance', meters: 2.5 } } }) })], [4])).toEqual([['shoot', 4, 7, 60]]);
    expect(windowsFor(loads, [marker('t', { invocation: run('feed', { loop: { until: { kind: 'time', seconds: 1.2 } } }) })], [2])).toEqual([['feed', 2, 3.5, 10]]);
    expect(windowsFor(loads, [marker('p', { invocation: run('shoot', { loop: { until: { kind: 'pathEnd' } } }) })], [9])).toEqual([['shoot', 9, 10.5, 60]]);
    expect(windowsFor(loads, [marker('p', { invocation: run('shoot', { cancelOnPathEnd: true, loop: { until: { kind: 'pathEnd' } } }) })], [9])).toEqual([['shoot', 9, 10, 60]]);
    // A distance the path never reaches leaves the loop running to the end.
    expect(windowsFor(loads, [marker('far', { invocation: run('shoot', { loop: { until: { kind: 'distance', meters: 30 } } }) })], [4]))
      .toEqual([['shoot', 4, 10, 60]]);
  });

  it('keeps a timed run going past the path end unless it is cancelled there', () => {
    expect(windowsFor(loads, [marker('late', { invocation: run('shoot') })], [9.5], 20)).toEqual([['shoot', 29.5, 31, 60]]);
  });

  it('chains a sequential group, and covers every possible start after an unknown finish', () => {
    const group = (mode: 'sequential' | 'parallel', commands: CommandInvocation[]) => marker('g', { commandGroup: { mode, commands } });
    expect(windowsFor(loads, [group('sequential', [run('feed'), run('shoot'), run('intake'), run('feed')])], [1]))
      .toEqual([['feed', 1, 1.5, 10], ['feed', 3, 10.5, 10], ['intake', 3, 10, 25], ['shoot', 1.5, 3, 60]]);
    expect(windowsFor(loads, [group('parallel', [run('feed'), run('shoot')])], [1])).toEqual([['feed', 1, 1.5, 10], ['shoot', 1, 2.5, 60]]);
    // An open-ended command cancelled at path end may finish any time before it; the next command may start then.
    const short = samples.slice(0, 3);
    expect(windowsFor(loads, [group('sequential', [run('intake', { cancelOnPathEnd: true }), run('feed')])], [0], 0, short))
      .toEqual([['feed', 0, 2.5, 10], ['intake', 0, 2, 25]]);
  });

  it('restarts a repeating event until it expires and ignores commands without a load', () => {
    expect(windowsFor(loads, [marker('r', { invocation: run('feed'), schedule: { repeatEveryS: 2, endTimeS: 6.5 } }), marker('x', { invocation: run('unknown') })], [1, 2]))
      .toEqual([['feed', 1, 1.5, 10], ['feed', 3, 3.5, 10], ['feed', 5, 5.5, 10]]);
    expect(windowsFor(loads, [marker('expired', { invocation: run('feed'), schedule: { endTimeS: 0.5 } })], [1])).toEqual([]);
    expect(commandsWithoutLoad(loads.driveModel, [marker('x', { invocation: run('unknown') }), marker('y', { invocation: run('shoot') })])).toEqual(['unknown']);
  });

  it('bounds a later command over every start the sequence allows', () => {
    // If intake finishes at once, the looping feed's last run ends at 2.5 s and the winch then runs to 2.75 s.
    const r = robot([{ commandId: 'intake', currentA: 0 }, { commandId: 'spin', currentA: 5, runTimeS: 1 }, { commandId: 'winch', currentA: 80, runTimeS: 0.25 }]);
    const group = marker('g', { commandGroup: { mode: 'sequential', commands: [run('intake'), run('spin', { loop: { until: { kind: 'pathEnd' } } }), run('winch')] } });
    const path = [...samples.slice(0, 3), { ...samples[2], i: 3, t: 2.5, s: 2.5 }];
    const windows = commandLoadWindows(r, { markers: [group] }, { samples: path, markers: [{ timeS: 0 }] });
    expect(commandLoadCurrent(windows, 2.6)).toBe(85);
    // A path-end loop cannot finish before the path ends, so the winch cannot start sooner.
    expect(commandLoadCurrent(windows, 2.4)).toBe(5);
  });

  it('bounds a distance loop that only earlier starts can complete', () => {
    // If intake finishes at 0.5 s, the 2.5 m loop's last 1 s run ends at 3.5 s and the winch runs to 3.75 s.
    const r = robot([{ commandId: 'intake', currentA: 0 }, { commandId: 'spin', currentA: 5, runTimeS: 1 }, { commandId: 'winch', currentA: 80, runTimeS: 0.25 }]);
    const group = marker('g', { commandGroup: { mode: 'sequential', commands: [run('intake'), run('spin', { loop: { until: { kind: 'distance', meters: 2.5 } } }), run('winch')] } });
    const windows = commandLoadWindows(r, { markers: [group] }, { samples: samples.slice(0, 4), markers: [{ timeS: 0 }] });
    // A later start never reaches 2.5 m on this 3 m path, so the loop itself may also still be running.
    expect(commandLoadCurrent(windows, 3.6)).toBe(85);
  });

  it('starts the next command no sooner than a timed loop can finish', () => {
    // A 5 s loop of 1 s runs ends no sooner than 5 s after it starts, however soon intake finishes.
    const r = robot([{ commandId: 'intake', currentA: 0 }, { commandId: 'spin', currentA: 5, runTimeS: 1 }, { commandId: 'winch', currentA: 80, runTimeS: 0.25 }]);
    const group = marker('g', { commandGroup: { mode: 'sequential', commands: [run('intake'), run('spin', { loop: { until: { kind: 'time', seconds: 5 } } }), run('winch')] } });
    const windows = commandLoadWindows(r, { markers: [group] }, { samples, markers: [{ timeS: 0 }] });
    expect(commandLoadCurrent(windows, 2)).toBe(5);
    expect(commandLoadCurrent(windows, 5.1)).toBe(85);
    // With a 5.1 s limit, the last 1 s run starts at 5 s and finishes at 6 s at the earliest.
    const late = marker('g', { commandGroup: { mode: 'sequential', commands: [run('intake'), run('spin', { loop: { until: { kind: 'time', seconds: 5.1 } } }), run('winch')] } });
    const lateWindows = commandLoadWindows(r, { markers: [late] }, { samples, markers: [{ timeS: 0 }] });
    expect(commandLoadCurrent(lateWindows, 5.5)).toBe(5);
    expect(commandLoadCurrent(lateWindows, 6.1)).toBe(85);
    // A limit within rounding of a whole number of runs keeps the same run count for every possible start.
    const tight = robot([{ commandId: 'intake', currentA: 0 }, { commandId: 'spin', currentA: 5, runTimeS: 0.01999999998 }, { commandId: 'tap', currentA: 80, runTimeS: 0.01 }]);
    const tightGroup = marker('g', { commandGroup: { mode: 'sequential', commands: [run('intake'), run('spin', { loop: { until: { kind: 'time', seconds: 0.02 } } }), run('tap')] } });
    const tightWindows = commandLoadWindows(tight, { markers: [tightGroup] }, { samples, markers: [{ timeS: 0.98 }] });
    // If intake finishes at 0.981 s, spin's single run ends by about 1.001 s and tap runs until about 1.011 s.
    expect(commandLoadCurrent(tightWindows, 1.005)).toBe(85);
  });

  it('runs a repeat due exactly at its expiry', () => {
    const r = robot([{ commandId: 'feed', currentA: 10, runTimeS: 0.25 }]);
    expect(windowsFor(r, [marker('r', { invocation: run('feed'), schedule: { repeatEveryS: 1, endTimeS: 2 } })], [0]))
      .toEqual([['feed', 0, 0.25, 10], ['feed', 1, 1.25, 10], ['feed', 2, 2.25, 10]]);
  });

  it('carries a heavily repeated run to its last start and stays bounded across many events', () => {
    const short = samples.slice(0, 3), fast = marker('fast', { invocation: run('shoot'), schedule: { repeatEveryS: 0.001 } });
    // The last start is due exactly at the 2 s path end, so its 1.5 s run lasts to 3.5 s.
    expect(windowsFor(loads, [fast], [0], 0, short)).toEqual([['shoot', 0, 3.5, 60]]);
    const markers = Array.from({ length: 160 }, (_, i) => ({ ...fast, id: `fast-${i}`, name: `fast-${i}` }));
    const timing = markers.map(m => ({ id: m.id!, name: m.name, command: null, group: null, fraction: 0, timeS: 0 }));
    expect(commandLoadWindows(loads, { markers }, { samples: short, markers: timing })).toHaveLength(1);
    const path = { ...createDemoProject().paths[0], markers };
    expect(() => analyzeRoutinePower(loads, [{ t0: 0, t1: 2, doc: path, trajectory: { samples: short, markers: timing } }], 2)).not.toThrow();
  });

  it('draws a command once while it runs, even when two events start it', () => {
    const windows = commandLoadWindows(loads, { markers: [marker('a', { invocation: run('intake') }), marker('b', { invocation: run('intake') }), marker('c', { invocation: run('shoot') })] },
      { samples, markers: [{ timeS: 1 }, { timeS: 2 }, { timeS: 2 }] });
    expect([0.5, 1.5, 2.5, 3.6].map(t => commandLoadCurrent(windows, t))).toEqual([0, 25, 85, 25]);
    expect(mechanismCurrent(loads, 2.5, windows)).toBe(90);
  });
});

describe('per-path planning reserve', () => {
  const heavy = robot([{ commandId: 'shoot', currentA: 150, runTimeS: 0.5 }, { commandId: 'intake', currentA: 30 }]);
  const pathWith = (invocations: CommandInvocation[]): PathDoc => {
    const path = createDemoProject().paths[0];
    path.waypoints = buildWaypoints([{ x: 1, y: 2, theta: 0 }, { x: 6, y: 2, theta: 0 }]);
    path.waypoints.forEach(w => { w.stop = true; w.thetaOn = true; });
    path.headingMode = 'manual'; path.ranges = []; path.targets = [];
    path.constraints = { maxVel: 6, maxAccel: 15, maxDecel: 15, maxAngVel: 720, maxAngAccel: 2000 };
    path.markers = invocations.map((invocation, i) => marker(`m${i}`, { f: 0.2 * (i + 1), invocation }));
    return path;
  };

  it('reserves each command a path starts once, and folds it into Other mechanisms only once', () => {
    const path = pathWith([run('shoot'), run('intake'), run('shoot'), run('unknown')]);
    expect(pathCommandReserveA(heavy.driveModel, path.markers)).toBe(180);
    const planned = planningRobotForPath(heavy, path);
    expect(planned.driveModel!.otherLoadA).toBe(185);
    expect(planned.driveModel!.commandLoads).toBeUndefined();
    expect(planningRobotForPath(planned, path)).toBe(planned);
    const plain = robot();
    expect(planningRobotForPath(plain, path)).toBe(plain);
  });

  it('slows only the paths that start a heavy command', () => {
    const baseline = getPlanner('profiledSpline').generate({ robot: robot(), path: pathWith([]) });
    const unaffected = getPlanner('profiledSpline').generate({ robot: heavy, path: pathWith([]) });
    const shooting = getPlanner('profiledSpline').generate({ robot: heavy, path: pathWith([run('shoot')]) });
    expect(unaffected.totalTimeS).toBeCloseTo(baseline.totalTimeS, 9);
    expect(shooting.totalTimeS).toBeGreaterThan(baseline.totalTimeS * 1.01);
    expect(physicalPlannerInput({ robot: heavy, path: pathWith([run('shoot')]) }).robot.maxSpeed)
      .toBeLessThan(physicalPlannerInput({ robot: heavy, path: pathWith([]) }).robot.maxSpeed);
    expect(planPath({ robot: heavy, path: pathWith([run('shoot')]) }).status).toBe('ok');
  });

  it('validates an authored path against the per-path speed and reserve, as planning does', () => {
    const path = pathWith([run('shoot')]);
    const trajectory = getPlanner('profiledSpline').generate({ robot: heavy, path });
    const physical = physicalPlannerInput({ robot: heavy, path });
    const fast = trajectory.samples.map(sample => ({ ...sample, velocityMps: sample.velocityMps > 0.5 ? physical.robot.maxSpeed * 1.02 : sample.velocityMps }));
    const authored = validateOptimizedTrajectory({ robot: heavy, path }, fast).violations.map(v => v.kind);
    expect(authored).toEqual(validateOptimizedTrajectory(physical, fast).violations.map(v => v.kind));
    expect(authored.length).toBeGreaterThan(0);
    // A load table that reserves nothing for the path leaves validation exactly as it was.
    const plainPath = pathWith([]), slow = { ...robot(), maxSpeed: 1 };
    const fastTrace = getPlanner('profiledSpline').generate({ robot: robot(), path: plainPath }).samples;
    const baseline = validateOptimizedTrajectory({ robot: slow, path: plainPath }, fastTrace).violations.map(v => v.kind);
    expect(baseline.length).toBeGreaterThan(0);
    for (const commandLoads of [[], [{ commandId: 'elsewhere', currentA: 40 }]]) {
      const withTable = { ...slow, driveModel: { ...slow.driveModel!, commandLoads } };
      expect(validateOptimizedTrajectory({ robot: withTable, path: plainPath }, fastTrace).violations.map(v => v.kind)).toEqual(baseline);
    }
  });

  it('keeps search results and durations when a load edit leaves this path\'s reserve unchanged', () => {
    const path = pathWith([run('shoot')]);
    const before = pathPlanningKey(path, heavy);
    const edited = robot([{ commandId: 'shoot', currentA: 150, runTimeS: 2 }, { commandId: 'intake', currentA: 30 }, { commandId: 'other', currentA: 9 }]);
    expect(pathPlanningKey(path, edited)).toEqual(before);
    expect(pathPlanningKey(path, robot([{ commandId: 'shoot', currentA: 120 }]))).not.toBe(before);
    // A project without command loads keeps the key it always had.
    expect(pathPlanningKey(path, robot([]))).toBe(pathPlanningKey(path, robot()));
    const plain = robot();
    expect(pathPlanningKey(path, plain)).toBe(pathPlanningKey(path, { ...plain }));
  });

  it('exports the module forces the planner allocated under the path\'s reserve', () => {
    // Electrical motor data and load transfer make force allocation depend on mechanism current.
    const fixture = () => {
      const value = binaryWriterFixture();
      value.project.robot.driveModel = { ...value.project.robot.driveModel!, motorStallCurrentA: 211, motorFreeCurrentA: 3.6, cgHeightM: 0.25 };
      return value;
    };
    const unloaded = fixture(), loaded = fixture(), folded = fixture();
    loaded.project.robot.driveModel!.commandLoads = [{ commandId: 'fixture.command', currentA: 100 }];
    folded.project.robot.driveModel!.otherLoadA = 100;
    const build = (value: typeof loaded) => buildRobotBinary(value.project, { kind: 'path', id: value.path.id }, value.bindings);
    const a = build(loaded), b = build(folded), base = build(unloaded);
    expect(a.document.paths[0].samples).toEqual(b.document.paths[0].samples);
    expect(a.moduleForcesN).toEqual(b.moduleForcesN);
    expect(a.moduleForcesN).not.toEqual(base.moduleForcesN);
    // Force allocation receives the path's planning robot, not the raw project robot.
    const spy = vi.spyOn(moduleForces, 'buildModuleForces');
    build(loaded);
    expect(spy.mock.calls[0][0].driveModel).toMatchObject({ otherLoadA: 100 });
    expect(spy.mock.calls[0][0].driveModel!.commandLoads).toBeUndefined();
    spy.mockRestore();
  });

  it('fails a path whose commands alone exhaust the battery, without failing the others', () => {
    const r = robot([{ commandId: 'winch', currentA: 400 }]);
    expect(() => getPlanner('profiledSpline').generate({ robot: r, path: pathWith([run('winch')]) })).toThrow(/command loads this path starts/);
    expect(planPath({ robot: r, path: pathWith([]) }).status).toBe('ok');
  });

  it('counts a command that starts as the path or routine ends', () => {
    const r = robot([{ commandId: 'shoot', currentA: 60, runTimeS: 1 }]);
    const path = pathWith([]); path.markers = [marker('end', { f: 1, invocation: run('shoot') })];
    const trajectory = getPlanner('profiledSpline').generate({ robot: r, path });
    const report = analyzeTrajectoryPower(r, path, trajectory)!;
    expect(report.peakMechanismCurrentA).toBe(65);
    expect(report.durationS).toBeCloseTo(trajectory.totalTimeS + 1, 6);
    const routine = analyzeRoutinePower(r, [{ t0: 0, t1: trajectory.totalTimeS, doc: path, trajectory }], trajectory.totalTimeS)!;
    expect(routine.peakMechanismCurrentA).toBe(65);
  });

  it('allocates wheel forces under the path reserve, as planning and export do', () => {
    // A command running for the whole path must read the same as that current folded into Other mechanisms.
    const turning = createDemoProject().paths[0];
    turning.markers = [marker('start', { f: 0, invocation: run('shoot') })];
    const loaded = robot([{ commandId: 'shoot', currentA: 80 }]), folded = robot(); folded.driveModel!.otherLoadA = 85;
    const trajectory = getPlanner('profiledSpline').generate({ robot: loaded, path: turning });
    const a = analyzeTrajectoryPower(loaded, turning, trajectory)!, b = analyzeTrajectoryPower(folded, { ...turning, markers: [] }, trajectory)!;
    expect(a.peakStatorCurrentA).toBeCloseTo(b.peakStatorCurrentA, 9);
    expect(a.minimumBusVoltageV).toBeCloseTo(b.minimumBusVoltageV, 9);
  });

  it('reports command current in path and routine estimates, and carries a running command into the next wait', () => {
    const r = robot([{ commandId: 'shoot', currentA: 60, runTimeS: 3 }]);
    const path = pathWith([run('shoot'), run('unknown')]);
    const trajectory = getPlanner('profiledSpline').generate({ robot: r, path });
    const report = analyzeTrajectoryPower(r, path, trajectory)!;
    expect(report.peakMechanismCurrentA).toBe(65);
    expect(report.commandsWithoutLoad).toEqual(['unknown']);
    const t = trajectory.totalTimeS, late = { ...path, markers: [marker('late', { f: 1, invocation: run('shoot') })] };
    const lateTrajectory = getPlanner('profiledSpline').generate({ robot: r, path: late });
    // The second path starts after a 2 s wait; only a command still running from the first path draws during it.
    const segments = [{ t0: 0, t1: t, doc: late, trajectory: lateTrajectory }, { t0: t + 2, t1: 2 * t + 2, doc: pathWith([]), trajectory: getPlanner('profiledSpline').generate({ robot: r, path: pathWith([]) }) }];
    const routine = analyzeRoutinePower(r, segments, 2 * t + 2)!;
    const quiet = analyzeRoutinePower(robot(), segments, 2 * t + 2)!;
    expect(routine.peakMechanismCurrentA).toBe(65);
    expect(quiet.peakMechanismCurrentA).toBe(5);
    expect(routine.mainBreakerPeakHeat).toBe(null);
  });
});

describe('command load validation', () => {
  it('rejects malformed, duplicate and out-of-range loads', () => {
    const project = createDemoProject(); project.robot = robot([
      { commandId: 'a', currentA: 10 }, { commandId: 'a', currentA: 5 }, { commandId: '', currentA: 1 },
      { commandId: 'b', currentA: -1, runTimeS: 0 }, { commandId: 'c', currentA: 3, runTimeS: 1 },
    ]);
    const paths = validateProject(project).issues.map(i => i.path).filter(p => p.includes('commandLoads'));
    expect(paths).toEqual(expect.arrayContaining([
      expect.stringMatching(/commandLoads\[1\]\.commandId$/), expect.stringMatching(/commandLoads\[2\]$/),
      expect.stringMatching(/commandLoads\[3\]\.currentA$/), expect.stringMatching(/commandLoads\[3\]\.runTimeS$/),
    ]));
    expect(paths.some(p => /commandLoads\[(0|4)\]/.test(p))).toBe(false);
  });
});
