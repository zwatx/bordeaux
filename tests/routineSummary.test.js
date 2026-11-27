import { describe, expect, it } from 'vitest';
import { routineSummary } from '../src/renderer/lib/routineSummary';

describe('routine library summaries', () => {
  it('shows a warning for an unsupported runtime generator', () => {
    const routine = { nodes: [{ id: 'run', type: 'generatedTrajectory', generatorId: 'vision' }] };
    const summary = routineSummary(routine, [], {}, {}, null);
    expect(summary).toMatchObject({ status: 'ready', severity: 'warn' });
    expect(summary.title).toContain('Unsupported saved definition');
  });

  it('does not wait for the library to time a saved trajectory embedded in a legacy step', () => {
    const routine = { nodes: [{ id: 'run', type: 'function', cat: 'generate',
      preview: { id: 'reference', name: 'Saved path', waypoints: [{}, {}] } }] };
    expect(routineSummary(routine, [], {}, {}, null)).toMatchObject({ status: 'unavailable', severity: 'warn' });
  });
});
