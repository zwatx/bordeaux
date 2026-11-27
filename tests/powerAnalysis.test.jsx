import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PowerAnalysis, PowerReportBody, powerFindings } from '../src/renderer/components/PowerAnalysis';

const h = React.createElement;
const robot = { driveModel: { minimumBusVoltageV: 8 } };
const clean = {
  minimumBusVoltageV: 9.664, peakSupplyCurrentA: 117.08, peakStatorCurrentA: 54.61,
  mainBreakerPeakHeat: 0.021, driveBreakerPeakHeat: 0.018, mainBreakerEndHeat: 0.02, driveBreakerEndHeat: [0.01],
  brownoutRisk: false, voltageOverload: false, currentOverload: false, collapsed: false, durationS: 3,
};
const text = markup => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('Power report', () => {
  it('reads a clean estimate as numbers against their limits', () => {
    const markup = renderToStaticMarkup(h(PowerReportBody, { report: clean, robot, titleId: 'power-title' }));
    const shown = text(markup);
    expect(shown).toContain('Path power estimate');
    expect(shown).toContain('No electrical overload found in this estimate.');
    expect(shown).toContain('Lowest bus voltage 9.66 V floor 8.00 V');
    expect(shown).toContain('Peak battery current 117.1 A');
    expect(shown).toContain('Peak drive motor current 54.6 A per motor');
    expect(shown).toContain('Main breaker heat 2% of trip');
    expect(shown).toContain('Drive breaker heat 2% of trip');
    // Estimates keep their model limits in view.
    expect(shown).toContain('does not certify a no-trip run');
    expect(shown).toContain('Regenerative braking is not credited');
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain('data-tone');
  });

  it('points a command without an estimate to its use\'s Add power estimate', () => {
    const path = text(renderToStaticMarkup(h(PowerReportBody, { report: { ...clean, commandsWithoutLoad: ['intake'] }, robot })));
    expect(path).toContain('1 command use here has no power estimate, so it adds no estimated current. Add one with Add power estimate in the path event inspector.');
    expect(path).not.toContain('Robot page');
    const routine = text(renderToStaticMarkup(h(PowerReportBody, { report: { ...clean, commandsWithoutLoad: ['intake', 'shoot'] }, robot, routine: true })));
    expect(routine).toContain('2 command uses here have no power estimate, so they add no estimated current. Add one with Add power estimate in the path event or routine step inspector.');
    // Counted by use: two uses of one command with different arguments are two missing estimates.
    const uses = text(renderToStaticMarkup(h(PowerReportBody, { report: { ...clean, commandsWithoutLoad: ['intake'], commandUses: { uses: 3, estimated: 1, stale: 0 } }, robot })));
    expect(uses).toContain('2 command uses here have no power estimate');
  });

  it('lists problems first and marks the quantity behind each one', () => {
    const report = { ...clean, minimumBusVoltageV: 6.9, brownoutRisk: true, currentOverload: true, mainBreakerPeakHeat: 1.12, driveBreakerPeakHeat: null };
    expect(powerFindings(report).map(f => f.tone)).toEqual(['bad', 'bad', 'warn']);
    const markup = renderToStaticMarkup(h(PowerReportBody, { report, robot, routine: true }));
    const shown = text(markup);
    expect(shown).toContain('Routine power estimate');
    expect(shown).toContain('Heat carries between paths.');
    expect(shown).not.toContain('No electrical overload');
    expect(shown.indexOf('falls below your minimum bus voltage')).toBeLessThan(shown.indexOf('Lowest bus voltage'));
    expect(shown).toContain('Main breaker heat 112% of trip');
    expect(shown).toContain('Drive breaker heat Not set');
    expect(markup.match(/<div data-tone="bad">/g)).toHaveLength(2);
    expect(markup.match(/<div data-tone="warn">/g)).toHaveLength(1);
  });

  it('reports collapse and voltage overload findings', () => {
    expect(powerFindings({ ...clean, collapsed: true, voltageOverload: true }).map(f => f.text)).toEqual([
      'The requested load has no steady battery-voltage solution.',
      'Some motors need more voltage than the shared bus leaves available for planning.',
    ]);
  });

  it('separates calculating, updating and failure states', () => {
    expect(text(renderToStaticMarkup(h(PowerReportBody, { report: null, robot })))).toContain('Calculating power…');
    const updating = renderToStaticMarkup(h(PowerReportBody, { report: clean, robot, updating: true }));
    expect(text(updating)).toContain('Updating…');
    expect(updating).toContain('data-updating="true"');
    const failed = renderToStaticMarkup(h(PowerReportBody, { report: null, robot, error: 'Configure a complete electrical drive model to estimate power.' }));
    expect(failed).toContain('role="alert"');
    expect(failed).not.toContain('Calculating');
    expect(failed).not.toContain('power-results');
  });

  it('renders a nonmodal popover controlled by the Power button', () => {
    const markup = renderToStaticMarkup(h(PowerAnalysis, { robot, path: { id: 'p' }, trajectory: { samples: [{}, {}] } }));
    expect(markup).not.toContain('<dialog');
    expect(markup).toMatch(/<button[^>]*aria-expanded="false"[^>]*>Power<\/button>/);
    const target = markup.match(/popovertarget="([^"]+)"/)[1];
    expect(markup).toContain(`id="${target}"`);
    expect(markup).toContain('popover="auto"');
    expect(markup).not.toContain('disabled');
    // Unplanned paths keep the trigger unavailable.
    expect(renderToStaticMarkup(h(PowerAnalysis, { robot, path: { id: 'p' }, trajectory: { samples: [] } }))).toContain('disabled');
  });
});
