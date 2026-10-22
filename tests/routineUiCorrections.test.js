import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StepInspector } from '../src/renderer/components/RoutineInspector';
import { RoutinePanel } from '../src/renderer/components/RoutinePanel';
import { AUTO } from '../src/renderer/lib/routineModel';

const catalog = {
  authoritative: true, generatedSchemaVersion: '1.3', conditions: [{ id: 'piece', label: 'Has game piece' }],
  commands: [{ id: 'inspect', label: 'Inspect game piece', member: 'inspect', parameters: [],
    outputs: [{ name: 'seen', label: 'Piece seen', schema: { kind: 'boolean', valueType: 'Boolean' } }] }],
};
const inspect = (ends) => ({ id: 'cmd', type: 'function', cat: 'command', title: 'Inspect game piece', invocation: { commandId: 'inspect', arguments: {} },
  ...(ends ? { ends } : {}),
  outputBranch: { output: 'seen', schema: { kind: 'boolean', valueType: 'Boolean' }, routes: [
    { id: 't', label: 'True', operator: 'eq', value: true, nodes: [] }, { id: 'f', label: 'False', operator: 'eq', value: false, nodes: [] }] } });
const renderInspector = (node, routine) => renderToStaticMarkup(React.createElement(StepInspector, {
  node, routine, paths: [], acq: { outcomes: {} }, run: { segs: [] }, issues: AUTO.analyze(routine, [], catalog), robotProject: { catalog } }));

// Review F6: a command whose result is read must finish, so an early end is not offered; a saved conflict stays repairable.
describe('result consumer endings', () => {
  it('offers no early end on a result consumer and says why', () => {
    const node = inspect();
    const html = renderInspector(node, { id: 'r', name: 'R', nodes: [node] });
    expect(html).not.toContain('End early on a condition');
    expect(html).toContain('A result needs the command to finish.');
  });

  it('keeps a saved early end on a consumer visible, switchable off and repairable', () => {
    const node = inspect({ endWhen: { source: 'condition', conditionId: 'piece' } });
    const html = renderInspector(node, { id: 'r', name: 'R', nodes: [node] });
    expect(html).toContain('This ending would skip the result its branch or repeat reads.');
    expect(html).toContain('Remove the early end');
    expect(html).toContain('Remove saved condition ending');
  });

  it('offers a time limit without creating new condition endings', () => {
    const node = { ...inspect(), outputBranch: undefined };
    const html = renderInspector(node, { id: 'r', name: 'R', nodes: [node] });
    expect(html).not.toContain('disabled="" aria-pressed="false" title="A result needs');
    expect(html).not.toContain('End early on a condition');
    expect(html).toContain('Time limit');
  });
});

// Review F9: steps inside a generated trajectory's fallback inherit read-only from that ancestry.
describe('generated fallback descendants', () => {
  const fallbackWait = { id: 'fw', type: 'builtin', builtinId: 'bordeaux.wait', arguments: { durationS: 1 } };
  const generated = { id: 'gen', type: 'generatedTrajectory', generatorId: 'drive', arguments: {}, fallback: { type: 'branch', nodes: [fallbackWait] } };
  const routine = { id: 'r', name: 'R', nodes: [generated] };

  it('model locate reports the inherited read-only state the UI relies on', () => {
    expect(AUTO.locate(routine, 'fw').readOnly).toBe(true);
    expect(AUTO.locate(routine, 'gen').readOnly).toBe(false);
  });

  it('opens a fallback step read-only: no editors, no delete', () => {
    const html = renderInspector(fallbackWait, routine);
    expect(html).toContain('Read-only');
    expect(html).toContain('kept as saved and cannot be changed here');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('Delete wait');
  });

  it('draws fallback rows without grip, actions or Add', () => {
    const run = AUTO.buildRun(routine, [], {}, {}, 'profiledSpline', catalog);
    const html = renderToStaticMarkup(React.createElement(RoutinePanel, { routine, run, paths: [], time: 0, running: false, acq: { outcomes: {} }, catalog }));
    const fallbackRow = html.slice(html.indexOf('data-id="fw"'));
    expect(fallbackRow.slice(0, fallbackRow.indexOf('</div></div>'))).not.toMatch(/rt-grip"|rt-more/);
    expect(html).not.toContain('Add to Fallback');
  });
});
