import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StepInspector } from '../src/renderer/components/RoutineInspector';
import { RoutinePanel } from '../src/renderer/components/RoutinePanel';
import { AUTO } from '../src/renderer/lib/routineModel';
import { createDemoProject } from '../src/shared/project/defaults';
import { getPlanner } from '../src/shared/planners';

function renderMetadata(project, routine, planning, outcomes = {}) {
  const run = AUTO.buildRun(routine, project.paths, project.robot, outcomes, project.plannerId, undefined, planning);
  const markup = renderToStaticMarkup(React.createElement(RoutinePanel, {
    routine, paths: project.paths, run, time: 0, running: false, acq: { outcomes },
  }));
  const field = (id, name) => markup.match(new RegExp('data-id="' + id + '"[\\s\\S]*?class="' + name + '[^"]*">([^<]*)'))?.[1];
  const metadata = (id) => field(id, 'rt-step-meta');
  metadata.duration = (id) => field(id, 'rt-step-dur');
  return metadata;
}

describe('routine path preview status', () => {
  it('shows preparation, then timing when a path is added or its reference changes', () => {
    const project = createDemoProject();
    project.paths.push({ ...structuredClone(project.paths[0]), id: 'replacement', name: 'Replacement path' });
    for (const path of project.paths) {
      const routine = { name: 'Routine', nodes: [{ id: 'drive', type: 'path', ref: path.id }] };
      expect(renderMetadata(project, routine, { status: 'pending', values: {} })('drive')).toBe('Preparing preview…');
      const trajectory = getPlanner('profiledSpline').generate({ path, robot: project.robot, samplesPerSegment: 14 });
      const ready = { status: 'ready', values: { [path.id]: { finalTrajectory: trajectory, sample: { length: trajectory.totalDistanceM } } } };
      // Distance reads under the name; the exact planned duration sits in the duration column.
      const ready_ = renderMetadata(project, routine, ready);
      expect(ready_('drive')).toMatch(/^\d+\.\d{2} m$/);
      expect(ready_.duration('drive')).toMatch(/^\d+\.\d{2} s$/);
    }
  });

  it.each(['pending', 'error'])('keeps unchosen and nested unchosen branches skipped while planning is %s', (status) => {
    const project = createDemoProject();
    const pathNode = (id) => ({ id, type: 'path', ref: project.paths[0].id });
    const routine = { name: 'Routine', nodes: [{ id: 'decision', type: 'decision', then: [pathNode('true-path')], else: [
      { id: 'nested', type: 'decision', then: [pathNode('nested-true')], else: [pathNode('nested-false')] },
    ] }] };
    const metadata = renderMetadata(project, routine, { status, values: {}, error: status === 'error' ? 'Planning failed' : '' });
    expect(metadata('true-path')).toBe(status === 'pending' ? 'Preparing preview…' : 'Preview unavailable');
    expect(metadata('nested-true')).toBe('Skipped in this preview');
    expect(metadata('nested-false')).toBe('Skipped in this preview');
    const alternate = renderMetadata(project, routine, { status, values: {} }, { decision: 'else', nested: 'else' });
    expect(alternate('true-path')).toBe('Skipped in this preview');
    expect(alternate('nested-true')).toBe('Skipped in this preview');
    expect(alternate('nested-false')).toBe(status === 'pending' ? 'Preparing preview…' : 'Preview unavailable');
  });

  // A ready plan set that lacks a selected path invalidates the whole preview: no row may claim it is still preparing
  // or invent a duration. A reference to a deleted path is a source problem named on its own row.
  it('distinguishes an unavailable selected trajectory from an unbound path', () => {
    const project = createDemoProject();
    const drive = renderMetadata(project, { name: 'Routine', nodes: [{ id: 'drive', type: 'path', ref: project.paths[0].id }] }, { status: 'ready', values: {} });
    expect(drive('drive')).toBe('Preview unavailable');
    expect(drive.duration('drive')).toBe('');
    const unbound = renderMetadata(project, { name: 'Routine', nodes: [
      { id: 'drive', type: 'path', ref: project.paths[0].id },
      { id: 'missing', type: 'path', ref: 'deleted-path' },
      { id: 'blank', type: 'path', ref: '' },
    ] }, { status: 'ready', values: {} });
    expect(unbound('drive')).toBe('Preview unavailable');
    expect(unbound('missing')).toBe('The referenced path is unavailable.');
    expect(unbound('blank')).toBe('Choose a path');
  });
});

describe('Wait inspector', () => {
  it('uses bounded project draft validation for the selected Wait step', () => {
    const html = renderToStaticMarkup(React.createElement(StepInspector, {
      node: { id: 'wait-a', type: 'builtin', builtinId: 'bordeaux.wait', arguments: { durationS: 1 } },
      paths: [], acq: {}, run: { segs: [] },
    }));
    expect(html).toContain('Wait duration in seconds');
    expect(html).toContain('min="0.02"');
    expect(html).toContain('max="15"');
    expect(html).toContain('data-project-draft="true"');
  });
});
