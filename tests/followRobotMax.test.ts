import { describe, expect, it } from 'vitest';
import { planningRobotForPath } from '../src/core/commandLoads';
import { buildWaypoints, createDemoProject } from '../src/core/project/defaults';
import { limitsAboveRobot } from '../src/core/project/pathLimits';
import { duplicateRobot, selectRobot } from '../src/core/project/robots';
import { getPlanner } from '../src/core/planners';
import { pathPlanningKey } from '../src/core/planners/planningKey';
import { effectivePathConstraints, followRobotLimits, physicalPlannerInput, robotLimitCeilings, setFollowRobotMax } from '../src/core/robotLimits';
import { validateProject } from '../src/core/validation';
import { validateOptimizedTrajectory } from '../src/core/planners/trajectoryValidation';
// @ts-expect-error Intentional renderer JS API.
import { PM } from '../src/renderer/lib/pathMath';
import type { BordeauxProject, PathConstraints, PathDoc, RobotConfig } from '../src/core/types';

/*
 * A path limit that follows the robot's max. Ways this can fail:
 *  1. A followed limit plans at its stored number, or at another robot's ceiling.
 *  2. Switching robots and back loses or changes the limit.
 *  3. The preview and final planning resolve a followed limit differently.
 *  4. The ceiling ignores the path's command reserve.
 *  5. Turning following off loses the value the path was planning at.
 *  6. A followed limit is reported as above the robot.
 */

/** Synthetic electrical drive, not a real robot. */
function robot(gearRatio: number, extra: Partial<NonNullable<RobotConfig['driveModel']>> = {}): RobotConfig {
  return { ...createDemoProject().robot, driveModel: {
    motorId: 'rev-vortex', motorFreeRpm: 6784, motorMaxTorqueNm: 3.6, motorCount: 4,
    gearRatio, wheelDiameterM: 0.0762, massKg: 54, moiKgM2: 5, wheelbaseM: 0.52, trackwidthM: 0.61,
    wheelFrictionCoefficient: 1.2, cgHeightM: 0.25, motorStallCurrentA: 211, motorFreeCurrentA: 3.6,
    driveCurrentLimitA: 55, batteryVoltageV: 12.5, batteryResistanceOhm: 0.02, driveEfficiency: 0.9, controlReserve: 0.1, otherLoadA: 5, ...extra,
  } };
}
function pathWith(constraints: PathConstraints): PathDoc {
  const path = createDemoProject().paths[0];
  path.id = 'path-a';
  path.waypoints = buildWaypoints([{ x: 1, y: 2, theta: 0 }, { x: 7, y: 2, theta: 0 }]);
  path.waypoints.forEach(w => { w.stop = true; w.thetaOn = true; });
  path.headingMode = 'manual'; path.ranges = []; path.targets = []; path.markers = [];
  path.constraints = constraints;
  return path;
}
const followed: PathConstraints = { maxVel: 1, maxAccel: 2, maxDecel: 1.5, maxAngVel: 90, maxAngAccel: 180, maxAngDecel: 120, followRobotMax: ['maxVel', 'maxAccel', 'maxAngAccel'] };
/** Two robots: "Robot" geared 5.5 (fast) and its copy geared 8 (slow, selected). */
function twoRobots(path: PathDoc): BordeauxProject {
  const project = { ...createDemoProject(), robot: robot(5.5), paths: [path], editor: { activePathId: path.id } };
  const copy = duplicateRobot(project, 'robot');
  return { ...copy, robot: { ...copy.robot, driveModel: { ...copy.robot.driveModel!, gearRatio: 8 } } };
}
const effective = (project: BordeauxProject) => effectivePathConstraints(project.paths[0].constraints, planningRobotForPath(project.robot, project.paths[0]));

describe('limits that follow the robot', () => {
  it('plan at the selected robot\'s ceiling and survive switching robots back and forth', () => {
    const slow = twoRobots(pathWith(followed));
    const fast = selectRobot(slow, 'robot');
    const slowCeilings = robotLimitCeilings(planningRobotForPath(slow.robot, slow.paths[0]));
    const fastCeilings = robotLimitCeilings(planningRobotForPath(fast.robot, fast.paths[0]));
    expect(fastCeilings.maxVel!).toBeGreaterThan(slowCeilings.maxVel!);
    for (const [project, ceilings] of [[slow, slowCeilings], [fast, fastCeilings]] as const) {
      expect(effective(project)).toMatchObject({ maxVel: ceilings.maxVel, maxAccel: ceilings.maxAccel, maxDecel: ceilings.maxDecel,
        maxAngVel: 90, maxAngAccel: ceilings.maxAngAccel, maxAngDecel: ceilings.maxAngAccel });
    }
    const back = selectRobot(fast, slow.activeRobotId!);
    expect(back.paths[0].constraints).toEqual(followed);
    expect(effective(back)).toEqual(effective(slow));
    expect(pathPlanningKey(back.paths[0], back.robot)).toBe(pathPlanningKey(slow.paths[0], slow.robot));
    expect(pathPlanningKey(fast.paths[0], fast.robot)).not.toBe(pathPlanningKey(slow.paths[0], slow.robot));
    // Final planning and the preview read the same values.
    expect(physicalPlannerInput({ robot: fast.robot, path: fast.paths[0] }).path.constraints).toMatchObject({ maxVel: fastCeilings.maxVel, maxAccel: fastCeilings.maxAccel });
    const preview = PM.effectiveConstraints(fast.paths[0].constraints, fast.robot, fast.paths[0]);
    const final = effective(fast);
    for (const key of ['maxVel', 'maxAccel', 'maxDecel', 'maxCentripetalAccel', 'maxAngVel', 'maxAngAccel', 'maxAngDecel'] as const) expect(preview[key]).toBeCloseTo(final[key]!, 12);
    // A followed limit plans faster than its low stored number would.
    const fixed = { ...followed }; delete fixed.followRobotMax;
    const time = (constraints: PathConstraints) => getPlanner('profiledSpline').generate({ robot: fast.robot, path: pathWith(constraints) }).totalTimeS;
    expect(time(followed)).toBeLessThan(time(fixed) * 0.8);
  });

  it('take the ceiling with the path\'s command reserve', () => {
    const loaded = robot(5.5, { commandLoads: [{ commandId: 'shoot', currentA: 150 }] });
    const path = pathWith(followed);
    path.markers = [{ id: 'm', f: 0.5, name: 'Shoot', invocation: { commandId: 'shoot', arguments: {} } }];
    const withReserve = robotLimitCeilings(planningRobotForPath(loaded, path));
    expect(withReserve.maxVel!).toBeLessThan(robotLimitCeilings(loaded).maxVel!);
    expect(physicalPlannerInput({ robot: loaded, path }).path.constraints.maxVel).toBeCloseTo(withReserve.maxVel!, 12);
    expect(PM.effectiveConstraints(path.constraints, loaded, path).maxVel).toBeCloseTo(withReserve.maxVel!, 12);
  });

  it('follow the top speed of a robot without a drivetrain model', () => {
    const bare = { ...createDemoProject().robot, maxSpeed: 3.2 };
    const path = pathWith({ ...followed, maxVel: 1.4 });
    expect(physicalPlannerInput({ robot: bare, path }).path.constraints.maxVel).toBe(3.2);
    expect(effectivePathConstraints(path.constraints, bare)).toMatchObject({ maxVel: 3.2, maxAccel: 2 });
    expect(PM.derivePath(path, bare, 20).prof.totalTime).toBeLessThan(PM.derivePath({ ...path, constraints: { ...path.constraints, followRobotMax: [] } }, bare, 20).prof.totalTime);
  });

  it('turn on and off, keeping the planned value as the fixed number', () => {
    const ceilings = { maxVel: 4.5, maxAccel: 9, maxDecel: 8, maxAngVel: 600, maxAngAccel: 1200 };
    const plain: PathConstraints = { maxVel: 2, maxAccel: 3, maxDecel: 3, maxAngVel: 90, maxAngAccel: 180 };
    const on = setFollowRobotMax(setFollowRobotMax(plain, 'maxAngVel', true, ceilings), 'maxVel', true, ceilings);
    expect(on).toEqual({ ...plain, followRobotMax: ['maxVel', 'maxAngVel'] });
    expect(setFollowRobotMax(on, 'maxVel', true, ceilings)).toBe(on);
    expect(followRobotLimits(on, ceilings)).toMatchObject({ maxVel: 4.5, maxAngVel: 600 });
    const accel = setFollowRobotMax(plain, 'maxAccel', true, ceilings);
    expect(setFollowRobotMax(accel, 'maxAccel', false, ceilings)).toEqual({ ...plain, maxAccel: 9, maxDecel: 8 });
    const off = setFollowRobotMax(on, 'maxVel', false, ceilings);
    expect(off).toEqual({ ...plain, maxVel: 4.5, followRobotMax: ['maxAngVel'] });
    expect(setFollowRobotMax(off, 'maxAngVel', false, ceilings)).toEqual({ ...plain, maxVel: 4.5, maxAngVel: 600 });
    // Without a ceiling the stored number stays.
    expect(setFollowRobotMax(accel, 'maxAccel', false, { maxVel: 4.5 })).toEqual(plain);
  });

  it('are never reported above the robot; fixed limits above it are', () => {
    const project = twoRobots(pathWith({ maxVel: 30, maxAccel: 150, maxDecel: 1, maxAngVel: 90, maxAngAccel: 99999, followRobotMax: ['maxAngAccel'] }));
    const ceilings = robotLimitCeilings(planningRobotForPath(project.robot, project.paths[0]));
    expect(limitsAboveRobot(project)).toEqual([
      { pathId: 'path-a', key: 'maxVel', value: 30, ceiling: ceilings.maxVel },
      { pathId: 'path-a', key: 'maxAccel', value: 150, ceiling: Math.min(ceilings.maxAccel!, ceilings.maxDecel!) },
      { pathId: 'path-a', key: 'maxCentripetalAccel', value: 150, ceiling: ceilings.maxCentripetalAccel },
    ]);
    const other = project.robots!.find(r => r.id === 'robot')!.robot!;
    expect(limitsAboveRobot(project, other).map(item => item.key)).toEqual(['maxVel', 'maxAccel', 'maxCentripetalAccel']);
    expect(limitsAboveRobot({ ...project, paths: [pathWith(followed)] })).toEqual([]);
  });

  it('validate only known, distinct limit names', () => {
    const project = createDemoProject();
    const check = (followRobotMax: unknown) => {
      project.paths[0].constraints = { ...project.paths[0].constraints, followRobotMax: followRobotMax as PathConstraints['followRobotMax'] };
      return validateProject(project).issues.filter(i => i.path.endsWith('followRobotMax')).length;
    };
    expect(check(['maxVel', 'maxAccel', 'maxCentripetalAccel', 'maxAngVel', 'maxAngAccel'])).toBe(0);
    expect(check([])).toBe(0);
    expect(check(['maxDecel'])).toBe(1);
    expect(check(['maxVel', 'maxVel'])).toBe(1);
    expect(check('maxVel')).toBe(1);
  });
});

describe('validating a trajectory against limits that follow the robot', () => {
  it('checks an authored input at the robot\'s ceiling, as the planner timed it, even without a command reserve', () => {
    const fast = robot(5.5);
    const path = pathWith({ maxVel: 0.15, maxAccel: 2, maxDecel: 1.5, maxAngVel: 90, maxAngAccel: 180, followRobotMax: ['maxVel'] });
    const input = { robot: fast, path };
    const planned = getPlanner('profiledSpline').generate(input);
    expect(Math.max(...planned.samples.map(s => Math.abs(s.velocityMps)))).toBeGreaterThan(1);
    expect(validateOptimizedTrajectory(physicalPlannerInput(input), planned.samples, { angularKinematics: 'sample' }).violations).toEqual([]);
    expect(validateOptimizedTrajectory(input, planned.samples, { angularKinematics: 'sample' }).violations).toEqual([]);
    // The same stored number, fixed, is violated.
    const fixed = { ...input, path: { ...path, constraints: { ...path.constraints, followRobotMax: [] } } };
    expect(validateOptimizedTrajectory(fixed, planned.samples, { angularKinematics: 'sample' }).violations.some(v => v.kind === 'linear-velocity')).toBe(true);
  });
});
