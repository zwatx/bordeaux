// Pull from robot as the dialog drives it: what Apply may replace, and when it must refuse. Review round 4, items 1,
// 3a, 6 and 9.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const hooks = vi.hoisted(() => ({ values: [], cursor: 0, effects: [] }));
vi.mock('react', async (original) => ({
  ...await original(),
  useState(initial) {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? initial() : initial;
    return [hooks.values[index], (value) => { hooks.values[index] = typeof value === 'function' ? value(hooks.values[index]) : value; }];
  },
  useRef(initial) {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = { current: initial };
    return hooks.values[index];
  },
  useEffect(effect, dependencies) {
    const index = hooks.cursor++;
    const previous = hooks.values[index];
    if (!previous || !dependencies || dependencies.some((value, item) => value !== previous[item])) hooks.effects.push(effect);
    hooks.values[index] = dependencies ?? [];
  },
}));
import { useRobotPull } from '../src/renderer/components/RobotPullDialog';
import { createDemoProject } from '../src/core/project/defaults';
import { prepareProjectFile } from '../src/core/project/fileFormat';
import { robotFileContents } from '../src/core/project/robotFile';
import { addRobot, renameRobot, replaceRobotDetails, selectRobot, setRobotConnection } from '../src/core/project/robots';
import { validateProject } from '../src/core/validation';
import { rememberRobotFile, robotFileStatus } from '../src/renderer/lib/robotFileMemory';

const endpoint = { target: 'roborio', host: '10.24.68.2', port: 22, directory: '/home/lvuser/bordeaux' };
const reading = { endpoint, hostKeyFingerprint: 'SHA256:pull' };
let project, props, epoch, robotOnDisk;
function render() {
  hooks.cursor = 0;
  const pull = useRobotPull(props);
  for (const effect of hooks.effects.splice(0)) effect();
  return pull;
}
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); return render(); };
const named = (name, base = prepareProjectFile(createDemoProject())) => renameRobot(setRobotConnection(base, endpoint), 'robot', name);

beforeEach(() => {
  hooks.values = []; hooks.effects = []; epoch = 1;
  project = named('Comp bot');
  robotOnDisk = robotFileContents('Comp bot', { ...project.robot, w: project.robot.w + 0.1 });
  props = { getProject: () => project, projectRevision: () => project, projectKey: 1, projectEpoch: () => epoch, onApply: vi.fn(() => true),
    connection: { connection: reading, pairing: { endpoint }, servedByRobot: false, openConnection: vi.fn() } };
  const bridge = {
    readRobotFiles: vi.fn(async ([fileName]) => ({ connection: reading, readAt: '2026-11-27T10:00:00Z',
      files: [{ fileName, contents: robotOnDisk === null ? null : [...new TextEncoder().encode(robotOnDisk)] }] })),
    validateProject: vi.fn(async (value) => validateProject(value)),
  };
  vi.stubGlobal('window', { bordeauxAPI: bridge });
  vi.stubGlobal('document', { activeElement: null });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('Pull applies only to the project and robot it reviewed', () => {
  it('closes the review when another project is opened, and Apply then changes nothing', async () => {
    render().start();
    expect((await settle()).phase).toBe('review');
    // File → Open Recent: another project whose robot has the same id.
    project = named('Comp bot', prepareProjectFile({ ...createDemoProject(), name: 'Other' }));
    epoch = 2; props = { ...props, projectKey: 2 };
    render(); // the effect that sees the new project key re-renders, as React does
    const after = render();
    expect(after.phase).toBe('failed');
    expect(after.error).toMatch(/another project/i);
    await after.apply();
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it('refuses Apply when the project was replaced before the dialog saw it', async () => {
    render().start();
    await settle();
    epoch = 2;
    await render().apply();
    expect(props.onApply).not.toHaveBeenCalled();
    expect(render()).toMatchObject({ phase: 'failed', error: expect.stringMatching(/nothing was applied/i) });
  });

  it('refuses Apply when the robot changed after the review', async () => {
    render().start();
    await settle();
    project = { ...project, robot: { ...project.robot, maxSpeed: project.robot.maxSpeed - 0.5 } };
    await render().apply();
    await settle();
    expect(props.onApply).not.toHaveBeenCalled();
    expect(render()).toMatchObject({ phase: 'failed', error: expect.stringMatching(/changed while this review was open/i) });
  });

  it('applies an unchanged review', async () => {
    render().start();
    await settle();
    await render().apply();
    await settle();
    expect(props.onApply).toHaveBeenCalledOnce();
    expect(props.onApply.mock.calls[0][1].w).toBeCloseTo(project.robot.w + 0.1);
  });
});

describe('Pull never makes a saveable project unsaveable', () => {
  const jiggled = (value) => {
    const path = value.paths[0], last = path.waypoints.length - 1;
    const jiggle = { distanceM: 0.1, strokes: 4, startDeg: 0, stepDeg: 90, strokeTimeS: 0.4 };
    return { ...value, paths: [{ ...path, goalVel: 0, waypoints: path.waypoints.map((waypoint, index) => index === last ? { ...waypoint, stop: true, jiggle } : waypoint) }, ...value.paths.slice(1)] };
  };
  /** Holds the host's next validateProject calls until `release`, as a slow host would. */
  const holdValidation = () => {
    const held = [];
    window.bordeauxAPI.validateProject.mockImplementation((value) => new Promise((resolve) => held.push(() => resolve(validateProject(value)))));
    return { release: () => held.splice(0).forEach((resume) => resume()), get count() { return held.length; } };
  };

  it('checks Apply against the project as it is when a path changed while the review was checked', async () => {
    project = { ...project, robot: { ...project.robot, drive: 'swerve' } };
    robotOnDisk = robotFileContents('Comp bot', { ...project.robot, drive: 'tank' });
    const hold = holdValidation();
    render().start();
    await settle();
    expect(hold.count).toBe(2);
    project = jiggled(project); // an endpoint jiggle, which a tank drive can't run, added while the check runs
    expect(validateProject(project).ok).toBe(true);
    hold.release();
    const review = await settle();
    expect(review).toMatchObject({ phase: 'review', problems: [] }); // checked against the project before the jiggle
    window.bordeauxAPI.validateProject.mockImplementation(async (value) => validateProject(value));
    await review.apply();
    const after = await settle();
    expect(props.onApply).not.toHaveBeenCalled();
    expect(validateProject(replaceRobotDetails(project, 'robot', { ...project.robot, drive: 'tank' })).ok).toBe(false);
    expect(after).toMatchObject({ phase: 'review', problems: [expect.stringMatching(/jiggle requires a swerve/i)] });
  });

  it('applies a review whose project is unchanged without checking it again', async () => {
    render().start();
    await settle();
    const checks = window.bordeauxAPI.validateProject.mock.calls.length;
    await render().apply();
    expect(window.bordeauxAPI.validateProject).toHaveBeenCalledTimes(checks);
    expect(props.onApply).toHaveBeenCalledOnce();
  });

  it('checks again before applying when the project changed after the review was checked', async () => {
    project = { ...project, robot: { ...project.robot, drive: 'swerve' } };
    robotOnDisk = robotFileContents('Comp bot', { ...project.robot, drive: 'tank' });
    render().start();
    await settle();
    project = jiggled(project);
    await render().apply();
    const after = await settle();
    expect(props.onApply).not.toHaveBeenCalled();
    expect(after).toMatchObject({ phase: 'review', problems: [expect.stringMatching(/jiggle requires a swerve/i)] });
  });

  it('refuses Apply when the project kept changing while it was checked again', async () => {
    project = { ...project, robot: { ...project.robot, drive: 'swerve' } };
    robotOnDisk = robotFileContents('Comp bot', { ...project.robot, drive: 'tank' });
    render().start();
    await settle();
    project = { ...project, name: 'Renamed' };
    const hold = holdValidation();
    const applying = render().apply();
    await settle();
    project = jiggled(project); // added while Apply's second check runs, so that check never saw it
    hold.release();
    await applying;
    expect(props.onApply).not.toHaveBeenCalled();
    expect(await settle()).toMatchObject({ phase: 'failed', error: expect.stringMatching(/changed while it was checked/i), canRetry: true });
  });

  it('applies once a change made after the review checks out', async () => {
    render().start();
    await settle();
    project = { ...project, name: 'Renamed' };
    await render().apply();
    await settle();
    expect(props.onApply).toHaveBeenCalledOnce();
  });

  it('lists an error the details would cause elsewhere in the project and blocks Apply', async () => {
    const path = project.paths[0], last = path.waypoints.length - 1;
    const jiggle = { distanceM: 0.1, strokes: 4, startDeg: 0, stepDeg: 90, strokeTimeS: 0.4 };
    project = { ...project, robot: { ...project.robot, drive: 'swerve' },
      paths: [{ ...path, goalVel: 0, waypoints: path.waypoints.map((waypoint, index) => index === last ? { ...waypoint, stop: true, jiggle } : waypoint) }, ...project.paths.slice(1)] };
    expect(validateProject(project).ok).toBe(true);
    robotOnDisk = robotFileContents('Comp bot', { ...project.robot, drive: 'tank' });
    render().start();
    const review = await settle();
    expect(review.phase).toBe('review');
    expect(review.problems).toEqual([expect.stringContaining(path.name)]);
    expect(review.problems[0]).toMatch(/jiggle requires a swerve/i);
    await review.apply();
    expect(props.onApply).not.toHaveBeenCalled();
    expect(validateProject(replaceRobotDetails(project, 'robot', { ...project.robot, drive: 'tank' })).ok).toBe(false);
  });
});

describe('Pull and the robot file name', () => {
  it('refuses to read a file another robot of the project would also push', async () => {
    project = selectRobot(addRobot(project, 'Comp-bot'), 'robot');
    render().start();
    const view = await settle();
    expect(view.phase).toBe('conflict');
    expect(view.error).toContain('“Comp bot” and “Comp-bot” would both use Comp-bot.robot');
    expect(window.bordeauxAPI.readRobotFiles).not.toHaveBeenCalled();
  });

  it('forgets what a verified Push left when the robot no longer has the file', async () => {
    const file = { fileName: 'Comp-bot.robot', sha256: 'pushed' };
    rememberRobotFile(reading, file.fileName, 'pushed');
    expect(robotFileStatus(reading, file)).toBe('same');
    robotOnDisk = null;
    render().start();
    expect((await settle()).phase).toBe('missing');
    expect(robotFileStatus(reading, file)).toBe('unknown');
  });
});
