import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createDemoProject } from '../src/core/project/defaults';
import { ContextInspector } from '../src/renderer/components/ContextInspector';

// Arc and Clothoid are no longer offered for new segments; a saved one still shows its own type.
describe('segment type choices', () => {
  const render = (segType) => {
    const project = createDemoProject(), doc = project.paths[0];
    doc.waypoints[0] = { ...doc.waypoints[0], segType }; // the segment into waypoint 1
    const actions = new Proxy({}, { get: (value, key) => key in value ? value[key] : vi.fn() });
    const html = renderToStaticMarkup(React.createElement(ContextInspector, {
      doc, sel: { kind: 'wp', idx: 1 }, robot: project.robot, drive: project.robot.drive,
      derived: { sample: { pts: [], length: 0 }, prof: { totalTime: 0 }, checks: [] }, actions, onClose: vi.fn(),
    }));
    const group = html.match(/aria-label="Incoming segment type"[^>]*>(.*?)<\/div>/)[1];
    return [...group.matchAll(/>([^<>]+)<\/button>/g)].map((match) => match[1]);
  };

  it('offers Straight and Bézier for a new segment', () => {
    expect(render('bezier')).toEqual(['Straight', 'Bézier']);
    expect(render('line')).toEqual(['Straight', 'Bézier']);
  });
  it.each([['arc', 'Arc'], ['clothoid', 'Clothoid']])('keeps a saved %s segment visible as its own type', (segType, label) => {
    expect(render(segType)).toContain(label);
    expect(render(segType)).toHaveLength(3);
  });
});
