import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StepInspector } from '../src/renderer/components/RoutineInspector';
import { AUTO } from '../src/renderer/lib/routineModel';

const command = (invocation) => ({ id: 'cmd', type: 'function', cat: 'command', title: 'Command', ...(invocation ? { invocation } : {}) });
const render = (node, robotProject) => renderToStaticMarkup(React.createElement(StepInspector, {
  node, routine: { id: 'r', name: 'R', nodes: [node] }, paths: [], acq: { outcomes: {} }, run: { segs: [] },
  issues: AUTO.analyze({ id: 'r', name: 'R', nodes: [node] }, [], robotProject.catalog), robotProject }));
const link = () => {};

// Review B1: with the LabVIEW panel gone, a command step without a catalog still offers its one route to commands.
describe('routine command step without linked robot code', () => {
  it.each(['unlinked', 'missing', 'error'])('explains and offers Link robot code when %s', (status) => {
    const html = render(command(), { status, catalog: null, link });
    expect(html).toContain('Commands come from linked robot code.');
    expect(html).toMatch(/<button type="button" class="qbtn wide">Link robot code…<\/button>/);
    expect(html).not.toContain('routine-command');
  });

  it('keeps a saved command visible and never claims a linked catalog is missing it', () => {
    const html = render(command({ commandId: 'intake.run', arguments: { speed: 2 } }), { status: 'missing', catalog: null, link });
    expect(html).toContain('Saved command “intake.run” is kept. Link robot code to change it.');
    expect(html).not.toContain('linked catalog');
  });

  it('disables the link while robot code is loading', () => {
    const html = render(command(), { status: 'loading', catalog: null, link });
    expect(html).toMatch(/<button type="button" class="qbtn wide" disabled="">Loading…<\/button>/);
  });

  it('still reports a saved command the linked catalog lost', () => {
    const catalog = { commands: [{ id: 'other', label: 'Other', member: 'other', parameters: [] }] };
    const html = render(command({ commandId: 'intake.run', arguments: {} }), { status: 'ready', catalog, link });
    expect(html).toContain('This saved command is missing from the linked catalog.');
    expect(html).not.toContain('Link robot code…');
  });
});
