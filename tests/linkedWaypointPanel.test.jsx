import React from 'react';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PathPanel } from '../src/renderer/components/PathPanel';
import { PathLinks } from '../src/renderer/lib/pathLinks';
import { createDemoProject } from '../src/shared/project/defaults';

const h = React.createElement;
const appSource = ts.createSourceFile('App.jsx', readFileSync(new URL('../src/renderer/app/App.jsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
function appNode(test) {
  let found = null;
  const visit = (node) => { if (!found && test(node)) found = node; else if (!found) ts.forEachChild(node, visit); };
  visit(appSource);
  if (!found) throw new Error('App node not found');
  return found;
}
const declared = (name) => appNode((node) => ts.isVariableDeclaration(node) && node.name.getText() === name).initializer;

const base = createDemoProject().paths[0];
const path = (id, name, extra = {}) => ({ ...structuredClone(base), id, name, ...extra });
const project = (...paths) => ({ ...createDemoProject(), paths, pathLinks: [] });
const linkGroup = (p, index, id, positionName) => { p.waypoints[index] = { ...p.waypoints[index], positionLink: id, ...(positionName ? { positionName } : {}) }; return p; };

const panel = (proj, index = 1, over = {}) => renderToStaticMarkup(h(PathPanel, {
  doc: proj.paths[0], sel: { kind: 'wp', idx: index }, derived: {}, tl: { empty: true, wpFrac: [] }, robot: {}, drive: 'swerve', project: proj,
  actions: { setWaypointPositionLink: () => 'applied' }, robotProject: { status: 'unlinked', catalog: null }, playbackStore: { getSnapshot: () => ({ time: 0 }) }, documentKey: 1, ...over }));

describe('docked Linked row (static markup)', () => {
  it('shows plain muted text, not a dead chooser, when no other path has points', () => {
    const markup = panel(project(path('a', 'Amp')));
    expect(markup).toContain('>Linked<');
    expect(markup).toContain('No other paths');
    expect(markup).not.toContain('band-waypoint-link');
  });

  it('offers a compact Link to… chooser after X/Y when another path exists, endpoints included', () => {
    const proj = project(path('a', 'Amp'), path('b', 'Source'));
    for (const index of [0, 1, proj.paths[0].waypoints.length - 1]) {
      const markup = panel(proj, index);
      expect(markup).toMatch(/<button id="band-waypoint-link"[^>]*aria-label="Link to a point in another path"[^>]*aria-expanded="false"/);
      expect(markup).toContain('Link to…');
      expect(markup.indexOf('>Linked<')).toBeGreaterThan(markup.lastIndexOf('>Y<'));
    }
  });

  it('lists linked path names, this path for same-path members, clamped with the full list for assistive tech', () => {
    const a = linkGroup(path('a', 'Amp'), 1, 'g'), b = linkGroup(path('b', 'Source'), 1, 'g'), c = linkGroup(path('c', 'Trench'), 1, 'g'), d = linkGroup(path('d', 'Stage'), 0, 'g');
    const markup = panel(project(a, b, c, d));
    expect(markup).toContain('title="Source, Trench, Stage"');
    expect(markup).toContain('<span aria-hidden="true">Source, Trench, +1</span>');
    expect(markup).toContain('<span class="sr-only">Linked to Source, Trench, Stage</span>');
    expect(markup).toMatch(/<button type="button" class="pp-text-btn" data-link-unlink="true">Unlink<\/button>/);
    expect(markup).not.toContain('band-waypoint-link');
    const self = linkGroup(linkGroup(path('a', 'Amp'), 1, 's'), 2, 's');
    expect(panel(project(self, path('b', 'Source')))).toContain('<span aria-hidden="true">this path</span>');
  });

  it('renders no Linked row where the App does not supply linking', () => {
    expect(panel(project(path('a', 'Amp'), path('b', 'Source')), 1, { actions: {} })).not.toContain('>Linked<');
  });
});

describe('App setWaypointPositionLink (actual App source)', () => {
  const run = ({ linked, named, committed }) => {
    const before = { id: 'before' }, linkedProject = linked ? { id: 'linked' } : before, namedProject = { id: 'named' };
    const links = { linkPosition: vi.fn(() => linkedProject), unlinkPosition: vi.fn(() => ({ id: 'unlinked' })), nameNewSharedPoint: vi.fn(() => (named ? namedProject : linkedProject)) };
    const commitWaypointProject = vi.fn(() => (committed ? { entry: true } : undefined));
    const fn = new Function('materializeProject', 'finishEdit', 'PathLinks', 'doc', 'pathLinkId', 'commitWaypointProject', 'return ' + declared('setWaypointPositionLink').getText())(
      () => before, vi.fn(), links, { id: 'a' }, () => 'new-group', commitWaypointProject);
    return { fn, links, commitWaypointProject, before };
  };

  it('names an unnamed new group inside the same single commit and reports the actual result', () => {
    const { fn, links, commitWaypointProject, before } = run({ linked: true, named: true, committed: true });
    expect(fn(2, { pathId: 'b', index: 1 })).toBe('applied');
    expect(links.linkPosition).toHaveBeenCalledWith(before, 'a', 2, 'b', 1, 'new-group');
    expect(links.nameNewSharedPoint).toHaveBeenCalledWith({ id: 'linked' }, 'a', 2);
    expect(commitWaypointProject).toHaveBeenCalledTimes(1);
    expect(commitWaypointProject).toHaveBeenCalledWith(before, { id: 'named' });
  });

  it('never names an unchanged link or an unlink, and reports unchanged when nothing is recorded', () => {
    let r = run({ linked: false, named: true, committed: false });
    expect(r.fn(2, { pathId: 'b', index: 1 })).toBe('unchanged');
    expect(r.links.nameNewSharedPoint).not.toHaveBeenCalled();
    r = run({ linked: true, named: false, committed: true });
    expect(r.fn(2, null)).toBe('applied');
    expect(r.links.nameNewSharedPoint).not.toHaveBeenCalled();
    expect(r.commitWaypointProject).toHaveBeenCalledWith(r.before, { id: 'unlinked' });
  });

  it('gives the band the link action and the loaded document identity', () => {
    expect(declared('bandActions').getText()).toContain('setWaypointPositionLink');
    expect(appSource.getFullText()).toMatch(/documentKey: projectKey,\n\s+commandPickFor:/);
  });
});

describe('choices come from the actual helper', () => {
  it('chooser items are exactly PathLinks.linkChoices, including unnamed points', () => {
    const proj = project(path('a', 'Amp'), path('b', 'Source'));
    const choices = PathLinks.linkChoices(proj, 'a', 1);
    expect(choices.length).toBe(proj.paths[1].waypoints.length);
    expect(choices.every((choice) => choice.pathId === 'b' && Number.isInteger(choice.index))).toBe(true);
  });
});
