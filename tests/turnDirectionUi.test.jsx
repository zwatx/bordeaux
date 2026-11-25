import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';
import { ContextInspector } from '../src/renderer/components/ContextInspector';
import { Panels } from '../src/renderer/components/Panels';
import { LibraryRail } from '../src/renderer/components/EditorLibrary';
import { UI } from '../src/renderer/components/ui';
import { createDemoProject } from '../src/core/project/defaults';
import { PM } from '../src/renderer/lib/pathMath';

const h = React.createElement;
const AUTHORED = { shortest: undefined, cw: 'cw', ccw: 'ccw' };

// Expand TurnDirection and its Seg (both hook-free) so their buttons can be pressed without a DOM.
function directionButtons(props) {
  const fragment = UI.TurnDirection(props);
  const seg = React.Children.toArray(fragment.props.children).find((child) => child.type === UI.Seg);
  return React.Children.toArray(UI.Seg(seg.props).props.children);
}
const pressed = (buttons) => buttons.filter((button) => button.props['aria-pressed']).map((button) => button.key.replace(/^\.\$/, ''));

function inspect(edit, sel) {
  const project = createDemoProject(), doc = project.paths[0];
  edit(doc);
  const derived = PM.derivePath(doc, project.robot, project.perSegmentConstraints, project.plannerId);
  return renderToStaticMarkup(h(ContextInspector, { project, doc, derived, sel, actions: {}, robot: project.robot }));
}
const directionGroups = (html) => [...html.matchAll(/role="group" aria-label="(Turn[^"]*)"/g)].map((match) => match[1]);

describe('turn direction control', () => {
  it('reads a missing direction as Shortest and offers full words', () => {
    const buttons = directionButtons({ value: undefined, values: AUTHORED, onChange() {} });
    expect(pressed(buttons)).toEqual(['shortest']);
    const html = renderToStaticMarkup(h(UI.TurnDirection, { value: 'ccw', values: AUTHORED, onChange() {} }));
    expect(html).toContain('>Shortest<'); expect(html).toContain('>Clockwise<'); expect(html).toContain('>Counterclockwise<');
    expect(html).toMatch(/class="seg-i on" title="Counterclockwise, seen[^>]*aria-pressed="true"/);
  });

  it('stores explicit directions and clears the key for Shortest', () => {
    const onChange = vi.fn();
    const [shortest, cw, ccw] = directionButtons({ value: 'cw', values: AUTHORED, onChange });
    ccw.props.onClick(); shortest.props.onClick(); cw.props.onClick();
    expect(onChange.mock.calls).toEqual([['ccw'], [undefined]]);
  });

  it('maps onto the turn-in-place direction names', () => {
    const onChange = vi.fn(), values = { shortest: 'shortest', cw: 'clockwise', ccw: 'counterclockwise' };
    const buttons = directionButtons({ value: 'counterclockwise', values, onChange });
    expect(pressed(buttons)).toEqual(['ccw']);
    buttons[1].props.onClick();
    expect(onChange).toHaveBeenCalledWith('clockwise');
  });
});

describe('turn direction placement in the inspector', () => {
  it('appears on every rotation target with its authored direction', () => {
    const html = inspect((doc) => { doc.targets = [{ f: .5, deg: 180, rotationDirection: 'ccw' }]; }, { kind: 'rt', idx: 0 });
    expect(directionGroups(html)).toEqual(['Turn direction into target heading']);
    expect(html).toMatch(/aria-pressed="true"[^>]*><svg[^>]*><path d="M3 12a9[^"]*"><\/path><\/svg><span>Counterclockwise/);
  });

  it('appears where a waypoint authors the incoming heading, not at the start', () => {
    const pinned = (doc) => {
      doc.headingMode = 'targets';
      doc.waypoints.splice(1, 0, { ...structuredClone(doc.waypoints[0]), x: doc.waypoints[0].x + 1, thetaOn: true, theta: 90, rotationDirection: 'cw' });
    };
    expect(directionGroups(inspect(pinned, { kind: 'wp', idx: 1 }))).toEqual(['Turn direction into heading']);
    expect(directionGroups(inspect((doc) => { pinned(doc); doc.waypoints[1].thetaOn = false; }, { kind: 'wp', idx: 1 }))).toEqual([]);
    expect(directionGroups(inspect(pinned, { kind: 'wp', idx: 0 }))).toEqual([]);
    const end = inspect((doc) => { doc.headingMode = 'manual'; }, { kind: 'wp', idx: 1 });
    expect(directionGroups(end)).toEqual(['Turn direction into heading']);
    expect(directionGroups(inspect((doc) => { doc.headingMode = 'tangent'; }, { kind: 'wp', idx: 1 }))).toEqual([]);
  });

  it('labels turn in place with full words', () => {
    const html = inspect((doc) => { doc.waypoints[1].turnInPlace = { headingDeg: 90, direction: 'clockwise' }; }, { kind: 'wp', idx: 1 });
    expect(directionGroups(html)).toContain('Turn in place direction');
    expect(html).not.toContain('>CCW<'); expect(html).not.toContain('>CW<');
  });
});

describe('Path list hide control', () => {
  const rail = (hidden) => renderToStaticMarkup(h(LibraryRail, { preferenceKey: 'focus-test', mode: 'paths', hidden, onRestore() {}, onHide() {},
    project: { paths: [{ id: 'a', name: 'Path A', waypoints: [{}, {}] }], pathFolders: [] }, activePathId: 'a', selection: { selected: [], set() {}, clear() {} },
    controller: { busy: false, itemStatus: () => ({}) }, actions: {}, times: {} }));

  it('lives on the library header, not the field view controls', () => {
    expect(renderToStaticMarkup(h(Panels.ViewControls, { zoomPct: 100, zoomBy() {}, onFit() {}, showGrid: false, setShowGrid() {} }))).not.toMatch(/field-focus|path list/);
    const open = rail(false);
    expect(open.match(/aria-label="Hide path list"/g)).toHaveLength(1);
    expect(open).toMatch(/class="library-find"[^]*aria-label="Hide path list"/);
    expect(open).not.toContain('Show path list');
  });

  it('leaves one way back while the list is hidden', () => {
    const closed = rail(true);
    expect(closed.match(/aria-label="Show path list"/g)).toHaveLength(1);
    expect(closed).toMatch(/<nav hidden=""[^>]*class="rail rail-l library-rail/);
  });
});
