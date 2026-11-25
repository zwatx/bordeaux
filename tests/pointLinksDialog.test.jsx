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
    // Two other paths: the dialog starts with the paths, which open to their points.
    expect(markup).toContain('data-link-path="b"');
    expect(markup).toContain('data-link-path="c"');
  });

  it('lists a path whose points are all shared with another path, with its own point names', () => {
    // b and c share both endpoints, so every c point belongs to a position whose representative is in b.
    const a = path('a', 'Amp'), b = path('b', 'Bravo', 0.5), c = path('c', 'Charlie', 0.5);
    c.waypoints = [c.waypoints[0], c.waypoints[c.waypoints.length - 1]];
    const last = b.waypoints.length - 1;
    b.waypoints[0] = { ...b.waypoints[0], positionLink: 'start' }; c.waypoints[0] = { ...c.waypoints[0], positionLink: 'start' };
    b.waypoints[last] = { ...b.waypoints[last], positionLink: 'end' }; c.waypoints[1] = { ...c.waypoints[1], positionLink: 'end' };
    const markup = dialog(project(a, b, c));
    const rows = markup.match(/<button[^>]*data-link-path="[^"]+"[^>]*>.*?<\/button>/g);
    expect(rows.map(row => row.match(/data-link-path="([^"]+)"/)[1])).toEqual(['b', 'c']);
    expect(text(rows[1])).toContain('2 points');
  });

  it('lists paths first when there are several, with their point counts and nearest distance', () => {
    const proj = project(path('a', 'Amp'), path('b', 'Bravo', 0.5), path('c', 'Charlie', 2));
    const markup = dialog(proj);
    expect(markup).not.toContain('data-link-target=');
    expect(markup).not.toContain('role="listbox"');
    const rows = markup.match(/<button[^>]*data-link-path="[^"]+"[^>]*>.*?<\/button>/g);
    expect(rows).toHaveLength(2);
    expect(text(rows[0])).toContain('Bravo');
    expect(text(rows[0])).toContain(proj.paths[1].waypoints.length + ' points');
    expect(text(rows[0])).toContain('nearest 0.50 m');
    expect(text(rows[1])).toContain('nearest 2.00 m');
    expect(rows[0]).toContain('tabindex="0"');
    expect(rows[1]).toContain('tabindex="-1"');
    expect(text(markup)).toContain('Choose a path, then the point to link to.');
    expect(markup).toContain('placeholder="Search paths and points"');
    expect(markup).not.toContain('pl-crumb');
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
