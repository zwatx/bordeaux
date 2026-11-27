import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { PathHoverReadout } from '../src/renderer/components/PathTimeline';
import { UnitPrefs } from '../src/renderer/lib/unitPreferences';

const context = { eligible: true };
const tl = { total: 30000, points: [
  { t: 0, f: 0, v: 0, a: 1 }, { t: 10000, f: .25, v: 1, a: 2 },
  { t: 20000, f: .5, v: 2, a: 3 }, { t: 30000, f: 1, v: 3, a: 4 },
] };
const render = (snapshot, metric = 'velocity', owner = context, props = {}) => renderToStaticMarkup(React.createElement(PathHoverReadout, {
  store: { subscribe: () => () => {}, getSnapshot: () => snapshot }, context: owner, tl, metric, ...props,
}));
afterEach(() => UnitPrefs.set('metric'));
describe('field hover readout leaf', () => {
  it.each([['metric', '2.0 m/s'], ['imperial', '6.6 ft/s']])('retains all long pass times and primary speed in %s', (system, speed) => {
    UnitPrefs.set(system);
    const html = render({ context, source: 'field', f: [.25,.5,1], primary: 1 }, 'accel');
    expect(html).toContain('10000.00 · 20000.00 · 30000.00 s · ' + speed);
    expect(html).toContain('pt-readout path-hover-readout');
    expect(html).toContain('aria-hidden="true"');
  });
  it('keeps the selected timeline metric instead of field-source speed formatting', () => {
    expect(render({ context, source: 'timeline', t: 10000 }, 'accel')).toContain('10000.00 s · 2.0 m/s²');
  });
  it('counts tags at the same interpolated turn pose as the ghost', () => {
    const trajectorySamples = [-165, -160].map((deg, i) => ({
      t: i / 10, x: -7, y: -3, headingRad: deg * Math.PI / 180, velocityMps: 0,
    }));
    const cameras = [{ id: 'front', name: 'Front', positionM: { x: .32, y: 0, z: .6 },
      yawDeg: 0, pitchDeg: 10, horizontalFovDeg: 70, verticalFovDeg: 60, maxRangeM: 6 }];
    const sampled = { points: [{ t: 0, tags: 2 }, { t: .1, tags: 1 }] };
    expect(render({ context, source: 'timeline', t: .075 }, 'tags', context,
      { tl: sampled, derived: { trajectorySamples }, doc: {}, cameras })).toContain('s · 2 tags');
  });
  it('suppresses empty, old-result and ineligible snapshots on render', () => {
    expect(render(null)).toBe('');
    expect(render({ context: { ...context }, source: 'timeline', t: 1 })).toBe('');
    const ineligible = { eligible: false };
    expect(render({ context: ineligible, source: 'timeline', t: 1 }, 'velocity', ineligible)).toBe('');
  });
});
