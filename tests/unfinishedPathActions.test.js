import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { buildWaypoints, blankPath, clampWorldPoint, createDemoProject } from '../src/shared/project/defaults';
import { moveWaypointTo, reversePath as reversePathDraft, setWaypointFacing } from '../src/renderer/lib/pathEditing';
import { PathLinks } from '../src/renderer/lib/pathLinks';
import { ContextInspector } from '../src/renderer/components/ContextInspector';

// Exercise the actual App owners, including their mutation admission, without a native desktop.
const source = ts.createSourceFile('App.jsx', readFileSync(new URL('../src/renderer/app/App.jsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
const names = ['appendPath', 'applyPointLink', 'setWp', 'faceWaypoint', 'reversePath', 'enableTargetsAtFraction'];
const declarations = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(source))) declarations.set(node.name.getText(source), node.getText(source));
  ts.forEachChild(node, visit);
}
visit(source);
function harness(count = 0) {
  const project = createDemoProject();
  const empty = { ...structuredClone(project.paths[0]), id: 'unfinished', waypoints: project.paths[0].waypoints.slice(0, count) };
  project.paths = [empty, { ...project.paths[0], id: 'complete' }];
  const ctx = {
    project, robot: project.robot, activeIdx: 0, docRef: { current: empty }, reverseDistance: 0,
    materializeProject: () => ctx.project, finishEdit: vi.fn(), uniquePathName: value => value, blankPath,
    clampWorld: clampWorldPoint, buildWps: buildWaypoints, pathLinkId: () => 'link', resetForPath: vi.fn(),
    FIELD_W: 16.54, FIELD_H: 8.07, editablePath: structuredClone, PathLinks,
    setProject: vi.fn(value => { ctx.project = typeof value === 'function' ? value(ctx.project) : value; }),
    commitProjectChange: vi.fn((_before, next) => { ctx.project = next; return true; }), useCallback: fn => fn,
    pathScope: id => 'path:' + id, PROJECT_SCOPE: 'project',
    commit: vi.fn(fn => { ctx.docRef.current = fn(structuredClone(ctx.docRef.current)); }),
    moveWaypointTo, setWaypointFacing, reversePathDraft,
    PM: { reversePathAnchors: vi.fn(value => value), waypointFracs: () => [] },
    derived: { sample: { pts: [] }, wpFrac: [] },
  };
  const owners = new Function('ctx', 'with(ctx) {' + names.map(name => 'const ' + declarations.get(name) + ';').join('\n') + 'return {' + names.join(',') + '};}')(ctx);
  return { ctx, ...owners };
}

describe('unfinished path action admission', () => {
  it('does not create a path or disturb an edit when Append has no source endpoint', () => {
    const h = harness();
    expect(h.appendPath('unfinished')).toBeNull();
    expect(h.ctx.setProject).not.toHaveBeenCalled();
    expect(h.ctx.finishEdit).not.toHaveBeenCalled();
  });
  it('preserves paths and links when either link endpoint is absent', () => {
    const h = harness(), before = structuredClone(h.ctx.project);
    expect(h.applyPointLink('unfinished', 0, { pathId: 'complete', index: 0 })).toBe('unchanged');
    expect(h.applyPointLink('complete', 0, { pathId: 'unfinished', index: 0 })).toBe('unchanged');
    expect(h.ctx.project).toEqual(before);
    expect(h.ctx.commitProjectChange).not.toHaveBeenCalled();
  });
  it('ignores stale initial-facing actions without creating history', () => {
    const h = harness();
    expect(() => h.setWp(0, { theta: 90, thetaOn: true })).not.toThrow();
    expect(() => h.faceWaypoint(0, 'next')).not.toThrow();
    expect(h.ctx.commit).not.toHaveBeenCalled();
  });
  it.each([0, 1])('does not reverse a %i-waypoint draft or add a history entry', count => {
    const h = harness(count), before = structuredClone(h.ctx.docRef.current);
    expect(() => h.reversePath()).not.toThrow();
    expect(h.ctx.commit).not.toHaveBeenCalled();
    expect(reversePathDraft(h.ctx.docRef.current)).toEqual(before);
  });
  it('does not assign a segment heading law before a segment exists', () => {
    const h = harness();
    expect(() => h.enableTargetsAtFraction(h.ctx.docRef.current, 0.5)).not.toThrow();
    expect(h.ctx.docRef.current.waypoints).toEqual([]);
  });
  it('still allows append, linking, and facing from one actual waypoint', () => {
    const h = harness(1);
    expect(h.appendPath('unfinished')).toMatchObject({ id: expect.any(String) });
    expect(h.ctx.project.paths).toHaveLength(3);
    expect(h.ctx.project.paths[2].waypoints[0]).toMatchObject({ x: h.ctx.project.paths[0].waypoints[0].x, y: h.ctx.project.paths[0].waypoints[0].y });
    h.applyPointLink('complete', 0, { pathId: 'unfinished', index: 0 });
    expect(h.ctx.commitProjectChange).toHaveBeenCalledOnce();
    h.setWp(0, { theta: 90 });
    expect(h.ctx.docRef.current.waypoints[0].theta).toBe(90);
  });
});

describe('unfinished path More inspector', () => {
  it.each([0, 1, 2])('exposes only supported endpoint actions for %i waypoints', count => {
    const project = createDemoProject(), doc = project.paths[0];
    doc.waypoints = doc.waypoints.slice(0, count);
    const actions = new Proxy({ canReversePath: true }, { get: (value, key) => key in value ? value[key] : vi.fn() });
    const html = renderToStaticMarkup(React.createElement(ContextInspector, {
      doc, sel: { kind: null, idx: -1 }, robot: project.robot, drive: project.robot.drive,
      derived: { sample: { pts: [], length: 0 }, prof: { totalTime: 0 }, checks: [] }, actions, onClose: vi.fn(),
    }));
    expect(/<button[^>]*disabled=""[^>]*aria-label="Swap start\/end"/.test(html)).toBe(count < 2);
    expect(html.includes('>Initial robot facing</')).toBe(count > 0);
    if (!count) expect(html).toContain('Place a waypoint to set initial facing');
  });
});
