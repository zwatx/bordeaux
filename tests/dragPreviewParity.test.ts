import { describe, expect, it } from 'vitest';
// @ts-expect-error Intentional renderer JS API.
import { processPathPreviewJob } from '../src/renderer/assets/path-preview-worker';
// @ts-expect-error Intentional renderer JS API.
import { PathPreview } from '../src/renderer/assets/path-preview';
// @ts-expect-error Intentional renderer JS API.
import { liveEditingPreview } from '../src/renderer/assets/editing-planning';
// @ts-expect-error Intentional renderer JS API.
import { buildTimeline } from '../src/renderer/components/pathTimelineModel';
import { buildWaypoints, createDemoProject } from '../src/shared/project/defaults';

// A drag preview must show the profile the release solve will settle on, not a cheaper model.

function representativeProject() {
  const project: any = createDemoProject();
  const path = project.paths[0];
  path.waypoints = buildWaypoints([
    { x: 1.5, y: 1.5, theta: 0 },
    { x: 4, y: 3.5, theta: 45, thetaOn: true },
    { x: 7, y: 2, stop: true, wait: 0.5 },
    { x: 10, y: 5, theta: 90, thetaOn: true },
    { x: 13, y: 3, theta: 180 },
  ] as any);
  path.headingMode = 'targets';
  path.ranges = [{ anchor: 'param', f0: 0.55, f1: 0.7, name: 'Slow', maxVel: 1.5 }];
  path.targets = [{ anchor: 'param', f: 0.3, deg: 120 }];
  return project;
}

function moved(path: any, index: number, dx: number, dy: number) {
  const shift = (point: any) => ({ x: point.x + dx, y: point.y + dy });
  return { ...path, waypoints: path.waypoints.map((waypoint: any, i: number) => i !== index ? waypoint
    : { ...waypoint, ...shift(waypoint), prevC: shift(waypoint.prevC), nextC: shift(waypoint.nextC) }) };
}

/** The exact message the field's drag previewer posts to the planning worker. */
function dragMessage(path: any, robot: any, field: any) {
  const posted: any[] = [];
  const previewer = PathPreview.createEditing({ workerFactory: () => ({ postMessage: (message: any) => posted.push(message), terminate() {} }) });
  previewer.request({ key: path.id, path, robot, field, plannerId: 'profiledSpline', quality: 'interactive' });
  previewer.destroy();
  expect(posted).toHaveLength(1);
  return posted[0];
}

/** What useEditingPlanning shows after release (its worker payload at final quality). */
function releaseValue(path: any, robot: any, field: any) {
  const result = processPathPreviewJob({ id: 1, mode: 'editing', path, robot, field,
    perSegment: PathPreview.samplesForQuality('final'), quality: 'final' });
  expect(result.error).toBeUndefined();
  return result.value.derived;
}

function velocityAt(derived: any, fraction: number) {
  const points = derived.sample.pts, length = derived.sample.length || 1, v = derived.metrics.v;
  const after = points.findIndex((point: any) => point.s / length >= fraction);
  if (after <= 0) return v[after < 0 ? points.length - 1 : 0];
  const f0 = points[after - 1].s / length, f1 = points[after].s / length;
  const u = f1 > f0 ? (fraction - f0) / (f1 - f0) : 0;
  return v[after - 1] + (v[after] - v[after - 1]) * u;
}

function maxVelocityDifference(first: any, second: any) {
  let difference = 0;
  for (let k = 0; k <= 200; k++) difference = Math.max(difference, Math.abs(velocityAt(first, k / 200) - velocityAt(second, k / 200)));
  return difference;
}

describe('drag preview parity with the release profile', () => {
  it('posts the release editing solve: whole path, field, and final density', () => {
    const project = representativeProject();
    const path = { ...project.paths[0], optimization: { accepted: { id: 'kept' } } };
    const message = dragMessage(path, project.robot, project.field);
    expect(message).toMatchObject({ mode: 'editing', robot: project.robot, field: project.field,
      perSegment: PathPreview.samplesForQuality('final'), quality: 'interactive' });
    // Release plans with the selected optimization; the drag must not strip it.
    expect(message.path).toBe(path);
  });

  it('a solved drag frame equals the release profile for the same draft', () => {
    const project = representativeProject();
    const draft = moved(project.paths[0], 1, 0.3, -0.2);
    const drag = processPathPreviewJob(dragMessage(draft, project.robot, project.field));
    const release = releaseValue(draft, project.robot, project.field);
    const shown = liveEditingPreview(draft, project.robot, draft, drag.value.derived);

    expect(shown.prof.totalTime).toBeGreaterThan(0);
    expect(shown.prof.totalTime).toBeCloseTo(release.prof.totalTime, 9);
    expect(shown.sample.pts.length).toBe(release.sample.pts.length);
    expect(maxVelocityDifference(shown, release)).toBeLessThan(1e-9);
    shown.prof.t.forEach((time: number, index: number) => expect(time).toBeCloseTo(release.prof.t[index], 9));
    // The speed graph reads the same trace, so it is identical too.
    expect(buildTimeline(shown).points).toEqual(buildTimeline(release).points);
    expect(buildTimeline(shown).total).toBeCloseTo(buildTimeline(release).total, 9);
  });

  it('differs from the former renderer-only interactive profile this replaces', () => {
    const project = representativeProject();
    const path = project.paths[0];
    const legacy = processPathPreviewJob({ id: 1, path, robot: project.robot, perSegment: PathPreview.samplesForQuality('interactive'), quality: 'interactive' }).value;
    const release = releaseValue(path, project.robot, project.field);
    // Documents the reported gap: the old drag profile was off by more than 0.3 s and 1 m/s here.
    expect(Math.abs(legacy.prof.totalTime - release.prof.totalTime)).toBeGreaterThan(0.3);
    expect(maxVelocityDifference(legacy, release)).toBeGreaterThan(1);
  });

  it('keeps the live draft geometry under the pointer while its solve is pending', () => {
    const project = representativeProject();
    const solvedPath = project.paths[0];
    const solved = processPathPreviewJob(dragMessage(solvedPath, project.robot, project.field)).value.derived;
    const draft = moved(solvedPath, 1, 0.05, 0);
    const shown = liveEditingPreview(draft, project.robot, solvedPath, solved);
    const waypoint = draft.waypoints[1], drawn = shown.sample.pts[shown.wpIdx[1]];
    expect(Math.hypot(drawn.x - waypoint.x, drawn.y - waypoint.y)).toBeLessThan(1e-9);
    // Timing comes from the newest solve of the same planner, with the stop kept on its waypoint.
    expect(shown.prof.totalTime).toBeCloseTo(solved.prof.totalTime, 9);
    expect(velocityAt(shown, shown.wpFrac[2])).toBeLessThan(0.01);
    const release = releaseValue(draft, project.robot, project.field);
    expect(Math.abs(shown.prof.totalTime - release.prof.totalTime)).toBeLessThan(0.1);
  });
});
