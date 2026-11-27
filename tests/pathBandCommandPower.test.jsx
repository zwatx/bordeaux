import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createDemoProject } from '../src/core/project/defaults';

const dropdowns = [];
vi.mock('../src/renderer/components/ui', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, UI: { ...actual.UI, Dropdown: (props) => { dropdowns.push(props); return null; } } };
});
const { PathPanel } = await import('../src/renderer/components/PathPanel');

const catalog = { commands: [{ id: 'intake', label: 'Start intake', member: 'Intake.vi' }, { id: 'shoot', label: 'Shoot', member: 'Shooter.vi' }] };
const power = { 'robot-a': { currentA: 40, runTimeS: 1.5, inputKey: 'shoot-key' }, 'robot-b': { currentA: 12, inputKey: 'shoot-key' } };

function changeBandCommand(invocation, commandId) {
  dropdowns.length = 0;
  const doc = { ...createDemoProject().paths[0], markers: [{ id: 'm1', f: 0.5, name: 'event1', cmd: invocation.commandId, invocation }] };
  const setMarker = vi.fn();
  renderToStaticMarkup(React.createElement(PathPanel, {
    doc, sel: { kind: 'em', idx: 0 }, derived: {}, tl: { empty: true }, robot: {}, drive: 'swerve', project: { paths: [doc] },
    actions: { setMarker }, robotProject: { status: 'ready', catalog }, playbackStore: { getSnapshot: () => ({ time: 0 }) }, commandPickFor: null,
  }));
  dropdowns.find((props) => props.id === 'band-command').onChange(commandId);
  return setMarker.mock.calls[0];
}

describe('path band command change', () => {
  it('keeps every robot\'s power estimate on the use so it can be reviewed', () => {
    const [index, patch] = changeBandCommand({ commandId: 'shoot', arguments: {}, power, loop: { until: { kind: 'time', seconds: 2 } } }, 'intake');
    expect(index).toBe(0);
    expect(patch.invocation).toEqual({ commandId: 'intake', arguments: {}, loop: { until: { kind: 'time', seconds: 2 } }, power });
  });

  it('adds no power field to a use without estimates', () => {
    const [, patch] = changeBandCommand({ commandId: 'shoot', arguments: {} }, 'intake');
    expect(patch.invocation).toEqual({ commandId: 'intake', arguments: {} });
  });
});
