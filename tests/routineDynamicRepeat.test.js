import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AUTO } from '../src/renderer/lib/routineModel';
import { StepInspector } from '../src/renderer/components/RoutineInspector';
import { createDemoProject } from '../src/shared/project/defaults';
import { decodeProjectFile, encodeProjectFile } from '../src/shared/project/fileFormat';
import { validateProjectSource } from '../src/shared/validation';

const schema = { kind: 'boolean', valueType: 'Boolean' };
const cmd = { id: 'C', type: 'function', cat: 'command', invocation: { commandId: 'check', arguments: {} } };
const loop = { id: 'loop', type: 'repeat', nodes: [cmd], until: { source: 'output', nodeId: 'C', output: 'finished', schema, operator: 'eq', value: true } };
const catalog = { commands: [{ id: 'check', label: 'Check completion', parameters: [], outputs: [{ name: 'finished', schema }] }] };

describe('dynamic repeat authoring and source', () => {
  it('round-trips a dynamic repeat without adding an artificial count', () => {
    const project = createDemoProject(); project.routines[0].nodes = [structuredClone(loop)];
    const encoded = encodeProjectFile(project), reopened = decodeProjectFile(encoded.contents).project;
    expect(reopened.routines[0].nodes).toEqual([loop]);
    expect(reopened.routines[0].nodes[0]).not.toHaveProperty('times');
    expect(validateProjectSource(reopened).ok).toBe(true);
  });
  it('rejects an indefinite repeat without an output stop while allowing unfinished output authoring', () => {
    const project = createDemoProject(); project.routines[0].nodes = [{ ...loop, until: undefined }];
    expect(validateProjectSource(project).issues.some(issue => issue.message.includes('Dynamic repeats require'))).toBe(true);
    project.routines[0].nodes[0].until = { source: 'output', nodeId: '', output: '', operator: 'eq' };
    expect(validateProjectSource(project).ok).toBe(true);
    expect(AUTO.analyze(project.routines[0], project.paths, catalog).some(issue => issue.code === 'stop-incomplete')).toBe(true);
  });
  it('previews a bounded number of passes without writing that count into the routine', () => {
    const routine = { id: 'r', name: 'R', nodes: [structuredClone(loop)] }, original = structuredClone(routine);
    const preview = AUTO.buildRun(routine, [], {}, {}, 'profiledSpline', catalog, undefined, { repeatPasses: { loop: 3 } });
    expect(preview.blocked).toBeFalsy();
    expect(preview.steps.filter(step => step.nodeId === 'C')).toHaveLength(3);
    expect(preview.assumptions).toContain('Repeat loop: assume its stop check is true after pass 3.');
    expect(routine).toEqual(original);
    expect(AUTO.buildRun(routine, [], {}, {}, 'profiledSpline', catalog, undefined, { repeatPasses: { loop: 1e6 } }).steps.filter(step => step.nodeId === 'C')).toHaveLength(50);
  });
  it('offers dynamic output selection without a condition picker or required repeat count', () => {
    const html = renderToStaticMarkup(React.createElement(StepInspector, { node: loop, routine: { nodes: [loop] }, paths: [], acq: { outcomes: {}, passes: {} }, run: { segs: [] }, robotProject: { catalog } }));
    expect(html).toContain('Until command output');
    expect(html).toContain('routine-repeat-output');
    expect(html).not.toContain('routine-repeat-times-');
    expect(html).not.toContain('routine-repeat-condition');
    expect(html).toContain('does not limit runtime repetition');
  });
});
