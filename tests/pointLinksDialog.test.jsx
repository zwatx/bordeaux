import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PointLinksDialog } from '../src/renderer/components/PointLinksDialog';
import { PathPanel } from '../src/renderer/components/PathPanel';
import { createDemoProject } from '../src/core/project/defaults';

const h = React.createElement;
const base = createDemoProject().paths[0];
const path = (id, name, dy = 0) => {
  const next = { ...structuredClone(base), id, name };
  next.waypoints = next.waypoints.map(point => ({ ...point, y: point.y + dy }));
  return next;
};
const project = (...paths) => ({ ...createDemoProject(), paths, pathLinks: [] });
const dialog = (proj, index = 1) => renderToStaticMarkup(h(PointLinksDialog, { project: proj, request: { pathId: proj.paths[0].id, index }, onApply: () => 'applied', onClose: () => undefined }));
const text = (markup) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('PointLinksDialog', () => {
  it('fixes the source to the waypoint it opened from and lists other paths by point with distance', () => {
    const proj = project(path('a', 'Amp'), path('b', 'A long destination path name', 0.5));
    const markup = dialog(proj);
    expect(markup).toContain('>Link End<');
    expect(markup).not.toContain('<select');
    expect(markup).toContain('role="listbox"');
    expect(markup).toContain('>A long destination path name<');
    for (let at = 0; at < proj.paths[1].waypoints.length; at++) expect(markup).toContain('data-link-target="b:' + at + '"');
    expect(markup).not.toContain('data-link-target="a:');
    // Each destination says how far the source would move; the matching point is 0.50 m straight up.
    expect(text(markup)).toContain('0.50 m away');
    expect(markup).toMatch(/rotate\(0(\.0)?deg\)/);
    expect(markup).toMatch(/<button[^>]*class="qbtn primary"[^>]*disabled=""[^>]*>Link point</);
    expect(markup).not.toContain('pl-members');
  });

  it('shows the current group with Unlink and names the whole group in the action', () => {
    const a = path('a', 'Amp'), b = path('b', 'Source'), c = path('c', 'Third');
    a.waypoints[1] = { ...a.waypoints[1], positionLink: 'g', positionName: 'Pickup' };
    b.waypoints[0] = { ...b.waypoints[0], positionLink: 'g' };
    const markup = dialog(project(a, b, c));
    expect(text(markup)).toContain('Linked with 1 point · Pickup');
    expect(text(markup)).toContain('Start · Source');
    expect(markup).toContain('data-link-unlink="true"');
    expect(markup).toContain('>Link 2 points<');
    expect(markup).toContain('data-link-target="c:1"');
  });

  it('explains an empty project instead of showing an empty list', () => {
    expect(text(dialog(project(path('a', 'Amp'))))).toContain('No other paths have points yet');
  });
});

describe('Linked entry in the path panel', () => {
  const panel = (proj) => renderToStaticMarkup(h(PathPanel, {
    doc: proj.paths[0], sel: { kind: 'wp', idx: 1 }, derived: {}, tl: { empty: true, wpFrac: [] }, robot: {}, drive: 'swerve', project: proj,
    actions: { setWaypointPositionLink: () => 'applied', openPointLinks: () => undefined }, robotProject: { status: 'unlinked', catalog: null }, playbackStore: { getSnapshot: () => ({ time: 0 }) }, documentKey: 1 }));
  it('offers Link to a point… and then states how many points share the position', () => {
    const a = path('a', 'Amp'), b = path('b', 'Source');
    expect(panel(project(a, b))).toMatch(/id="band-waypoint-link"[^>]*>Link to a point…</);
    a.waypoints[1] = { ...a.waypoints[1], positionLink: 'g' }; b.waypoints[1] = { ...b.waypoints[1], positionLink: 'g' };
    expect(panel(project(a, b))).toMatch(/id="band-waypoint-link"[^>]*aria-label="Linked with 1 point. Manage links"[^>]*>With 1 point…</);
  });
});
