import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ContextInspector } from '../src/renderer/components/ContextInspector';
import { createDemoProject } from '../src/core/project/defaults';
import { PM } from '../src/renderer/lib/pathMath';

const h = React.createElement;
const catalog = { commands: [
  { id: 'shooter', label: 'Shooter', member: 'Shooter.vi', labviewConnector: {}, parameters: [{ name: 'rpm', label: 'RPM', role: 'argument', schema: { kind: 'number', valueType: 'DBL' }, defaultValue: 3000 }] },
  { id: 'intake', label: 'Intake', member: 'Intake.vi', labviewConnector: {}, parameters: [] },
] };

function render(marker) {
  const project = createDemoProject(), doc = project.paths[0];
  doc.markers = [{ id: 'event-1', f: 0.4, name: 'Score', ...marker }];
  const derived = PM.derivePath(doc, project.robot, project.perSegmentConstraints, project.plannerId);
  return renderToStaticMarkup(h(ContextInspector, { project, doc, derived, sel: { kind: 'em', idx: 0 }, actions: {}, robot: project.robot,
    robotProject: { catalog, status: 'ready' } }));
}

describe('event command loops and groups inspector', () => {
  it('offers Loop until and Add command for a single command', () => {
    const html = render({ invocation: { commandId: 'shooter', arguments: { rpm: 3000 } } });
    expect(html).toContain('Loop until');
    expect(html).toContain('>Off<'); expect(html).toContain('>Time<'); expect(html).toContain('>Distance<'); expect(html).toContain('>Path end<');
    expect(html).not.toContain('Stop after');
    expect(html).toContain('Add command');
    expect(html).not.toContain('Run commands');
  });

  it('edits a distance limit in path units with its restart rule', () => {
    const html = render({ invocation: { commandId: 'shooter', arguments: { rpm: 3000 }, loop: { until: { kind: 'distance', meters: 1.5 } } } });
    expect(html).toContain('Stop after');
    expect(html).toContain('until the limit, counted from its first start, then lets the last run finish');
  });

  it('lists grouped commands with order, loops and reorder controls', () => {
    const html = render({ commandGroup: { mode: 'sequential', commands: [
      { commandId: 'shooter', arguments: { rpm: 3000 }, loop: { until: { kind: 'time', seconds: 5 } } },
      { commandId: 'intake', arguments: {}, loop: { until: { kind: 'pathEnd' } } },
      { commandId: 'gone', arguments: {} },
    ] } });
    expect(html).toContain('Run commands'); expect(html).toContain('Sequential');
    expect(html).toContain('Each starts when the one before it finishes.');
    expect(html).toContain('Loops for 5.00 s'); expect(html).toContain('Loops until path end'); expect(html).toContain('Not in robot code');
    expect(html).toMatch(/disabled="" title="Move up" aria-label="Move Shooter up"/);
    expect(html).toContain('aria-label="Remove Intake"');
    expect(html).toContain('Add command');
    // Rows stay collapsed until opened, so a long group stays compact.
    expect(html).not.toContain('event-group-0-command');
  });

  it('flags a schedule repeat that conflicts with a loop', () => {
    const html = render({ invocation: { commandId: 'shooter', arguments: { rpm: 3000 }, loop: { until: { kind: 'pathEnd' } } }, schedule: { trigger: 'time', repeatEveryS: 0.5 } });
    expect(html).toContain('A looping command can’t also repeat on a schedule.');
    expect(html).toContain('Turn off repeat');
  });
});
