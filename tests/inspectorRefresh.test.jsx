import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { ContextInspector, parameterValueError } from '../src/renderer/components/ContextInspector';
import { UI } from '../src/renderer/components/ui';
import { buildWaypoints, createDemoProject } from '../src/core/project/defaults';
import { PM } from '../src/renderer/lib/pathMath';

const h = React.createElement;
describe('LabVIEW inspector', () => {
  it.each([
    ['U8', 'integer', 255, 256], ['I8', 'integer', -128, -129],
    ['U16', 'integer', 65535, -1], ['U32', 'integer', 4294967295, 4294967296],
    ['I64', 'integerString', '-9223372036854775808', '-9223372036854775809'],
    ['U64', 'integerString', '18446744073709551615', '18446744073709551616'],
    ['SGL', 'number', 1e30, 1e40],
  ])('preserves the %s numeric boundary', (valueType, kind, valid, invalid) => {
    const parameter = { name: 'Value', schema: { valueType, kind } };
    expect(parameterValueError(valid, parameter)).toBe('');
    expect(parameterValueError(invalid, parameter)).not.toBe('');
  });
  it('shows the selected command without a floating dropdown', () => {
    const markup = renderToStaticMarkup(h(UI.ChoiceBrowser, { id: 'command', label: 'Command', value: 'intake', items: [{ value: 'intake', label: 'Start intake', meta: 'Speed, timeout' }], onChange() {} }));
    expect(markup).toContain('Start intake');
    expect(markup).toContain('Speed, timeout');
    expect(markup).toContain('Change');
    expect(markup).not.toContain('cmd-picker-trigger');
  });
  it('offers path percentage and distance positions for zones', () => {
    const project = createDemoProject(); const doc = project.paths[0];
    doc.ranges = [{ f0: .2, f1: .6, maxVel: 1, anchor: 'param' }];
    const derived = PM.derivePath(doc, project.robot, project.perSegmentConstraints, project.plannerId);
    const html = renderToStaticMarkup(h(ContextInspector, { project, doc, derived, sel: { kind: 'cr', idx: 0 }, actions: {}, robot: project.robot }));
    expect(html).toContain('Path %'); expect(html).toContain('Distance');
    expect(html).not.toContain('>Local<'); expect(html).not.toContain('Legacy distance');
  });
  it('resolves the linked waypoint name for segment headings', () => {
    const project = createDemoProject(); const doc = project.paths[0];
    doc.waypoints[0].positionLink = 'shared';
    project.paths.push({ ...structuredClone(doc), id: 'other', waypoints: [{ ...doc.waypoints[0], positionName: 'Intake staging', positionLink: 'shared' }, doc.waypoints[1]] });
    const derived = PM.derivePath(doc, project.robot, project.perSegmentConstraints, project.plannerId);
    const html = renderToStaticMarkup(h(ContextInspector, { project, doc, derived, sel: { kind: 'seg', idx: 0 }, actions: {}, robot: project.robot }));
    expect(html).toContain('Intake staging →'); expect(html).not.toContain('>Default<');
  });
});

describe('planning recovery inspector', () => {
  it('makes stale anchor controls inert while leaving the inspector close button available', () => {
    const project = createDemoProject(), doc = project.paths[0];
    doc.targets = [{ f: .5, deg: 90 }];
    const derived = PM.derivePath(doc, project.robot, project.perSegmentConstraints, project.plannerId);
    const html = renderToStaticMarkup(h(ContextInspector, { project, doc, derived, pending: true,
      sel: { kind: 'rt', idx: 0 }, actions: {}, robot: project.robot }));
    expect(html).toContain('class="ctxinsp-body" inert=""');
    expect(html).toContain('Anchor position');
    const header = html.slice(0, html.indexOf('class="ctxinsp-body"'));
    expect(header).toContain('aria-label="Hide inspector"');
    expect(header).not.toContain('inert=');
  });

  it('offers authored range repair without reading failed trajectory geometry', () => {
    const project = createDemoProject(), doc = project.paths[0];
    doc.ranges = [{ f0: .2, f1: .6, maxVel: 0, anchor: 'param' }];
    const derived = new Proxy({}, { get() { throw new Error('Failed geometry must not be used for repair'); } });
    const html = renderToStaticMarkup(h(ContextInspector, { project, doc, derived, repairMode: true,
      sel: { kind: 'cr', idx: 0 }, actions: {}, robot: project.robot }));
    expect(html).toContain('Velocity');
    expect(html).toContain('Delete zone');
    expect(html).not.toContain('inert=');
    expect(html).not.toContain('Anchor position');
    expect(html).not.toContain('>Distance<');
  });
});

describe('waypoint tangent inspector', () => {
  const setup = (types) => {
    const project = createDemoProject(), doc = project.paths[0];
    doc.waypoints = buildWaypoints([{ x: 2, y: 2 }, { x: 4, y: 3 }, { x: 6, y: 2 }].map((w, i) => ({ ...w, segType: types[i] })));
    return { project, doc };
  };
  const render = ({ project, doc }, idx) => renderToStaticMarkup(h(ContextInspector, { project, doc, derived: PM.derivePath(doc, project.robot, project.perSegmentConstraints, project.plannerId),
    sel: { kind: 'wp', idx }, actions: {}, robot: project.robot }));
  // The markup from one side's label up to the next control group.
  const side = (html, name) => {
    const start = html.indexOf('>' + name + ' segment<');
    if (start < 0) return '';
    const next = html.indexOf('role="group"', start);
    return html.slice(start, next < 0 ? undefined : html.indexOf('role="group"', next + 1));
  };

  it('shows the segment type, direction and length on each side of a curved interior waypoint', () => {
    const html = render(setup(['bezier', 'bezier']), 1);
    for (const name of ['Incoming', 'Outgoing']) {
      expect(html).toContain('aria-label="' + name + ' segment type"');
      expect(side(html, name)).toContain('>Direction<');
      expect(side(html, name)).toContain('>Length<');
    }
    expect(html).toContain('Directions stay aligned through this waypoint.');
    expect(html).not.toContain('Incoming tangent');
  });

  it('hides tangent values that a straight segment or an arc end ignores', () => {
    const fixture = setup(['line', 'arc']), html = render(fixture, 1);
    expect(side(html, 'Incoming')).not.toContain('>Direction<');
    expect(side(html, 'Outgoing')).toContain('>Direction<');
    expect(side(html, 'Outgoing')).not.toContain('>Length<');
    expect(html).not.toContain('Directions stay aligned');
    const end = render(fixture, 2);
    expect(end).toContain('aria-label="Incoming segment type"');
    expect(end).not.toContain('aria-label="Outgoing segment type"');
    expect(side(end, 'Incoming')).not.toContain('>Direction<');
  });
});
