import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createDemoProject } from '../src/core/project/defaults';
import { ContextInspector } from '../src/renderer/components/ContextInspector';
import { onTurnOf } from '../src/core/math/angles';

// Facing fields show a stored heading within one turn; the stored value keeps its turns.
describe('facing field display', () => {
  const shown = (theta) => {
    const project = createDemoProject(), doc = project.paths[0];
    doc.headingMode = 'targets';
    doc.waypoints[0] = { ...doc.waypoints[0], theta, thetaOn: true, segmentHeadingMode: 'manual' };
    const actions = new Proxy({}, { get: (value, key) => key in value ? value[key] : vi.fn() });
    const html = renderToStaticMarkup(React.createElement(ContextInspector, {
      doc, sel: { kind: null, idx: -1 }, robot: project.robot, drive: project.robot.drive,
      derived: { sample: { pts: [], length: 0 }, prof: { totalTime: 0 }, checks: [] }, actions, onClose: vi.fn(),
    }));
    return html.match(/>Initial robot facing<.*?<input[^>]*value="([^"]*)"/)[1];
  };
  it.each([[1800, '0.0'], [450, '90.0'], [-270, '90.0'], [359, '-1.0'], [540, '180.0'], [-540, '-180.0'], [45, '45.0']])('shows %d° as %s°', (theta, text) => {
    expect(shown(theta)).toBe(text);
  });

  it('keeps an edit on the stored heading\'s turn so a scrub never reverses a half-turn', () => {
    // 328° shows as -32°; scrubbing +32° reaches 360°, still +180° from a 180° start rather than 0° (−180°).
    expect(onTurnOf(328, 0)).toBe(360);
    expect(onTurnOf(540, 179)).toBe(539);
    expect(onTurnOf(0, 1800)).toBe(1800);
    expect(onTurnOf(-90, -90)).toBe(-90);
    // Past the planner's heading bound, the entered value is stored as is.
    expect(onTurnOf(360_000, 1)).toBe(1);
  });
});
