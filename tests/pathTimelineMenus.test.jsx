import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { timelineMenu } from '../src/renderer/components/PathTimeline';
import { UI } from '../src/renderer/components/ui';

const doc = {
  waypoints: [{ x: 0, y: 0, stop: true }, { x: 1, y: 0, stop: false }, { x: 2, y: 0, stop: true }, { x: 3, y: 0 }],
  targets: [{ f: 0.5, deg: 90 }],
  markers: [{ id: 'm0', f: 0.2, name: 'Intake down', cmd: 'none' }, { id: 'm1', f: 0.6, name: 'event2', cmd: 'shoot' }],
  ranges: [{ f0: 0.1, f1: 0.3, name: 'Slow' }, { f0: 0.5, f1: 0.7 }],
};
const catalog = { commands: [{ id: 'shoot', label: 'Shooter' }] };
const actionsMock = () => ({ openInspector: vi.fn(), setStop: vi.fn(), duplicateWp: vi.fn(), delWp: vi.fn(), insertWp: vi.fn(), delTarget: vi.fn(), delMarker: vi.fn(), delRange: vi.fn() });
const menuOf = (target, options = {}) => {
  const actions = options.actions || actionsMock();
  return { actions, ...timelineMenu(target, { doc, actions, catalog, inspectorOpen: false, ...options }) };
};
const labels = (items) => items.map((item) => item.sep ? '—' : item.label);
const run = (items, label) => items.find((item) => item.label === label).onClick();

describe('timeline item menus', () => {
  it('offers a middle waypoint its inspector, stop, duplicate and delete', () => {
    const { items, label, actions } = menuOf({ kind: 'wp', index: 1 });
    expect(label).toMatch(/ actions$/);
    expect(labels(items)).toEqual(['Open in inspector', 'Stop here', 'Duplicate waypoint', '—', 'Delete waypoint']);
    expect(items.find((item) => item.label === 'Stop here').checked).toBe(false);
    expect(items.at(-1).danger).toBe(true);
    run(items, 'Stop here'); run(items, 'Duplicate waypoint'); run(items, 'Delete waypoint'); run(items, 'Open in inspector');
    expect(actions.setStop).toHaveBeenCalledWith(1, true);
    expect(actions.duplicateWp).toHaveBeenCalledWith(1);
    expect(actions.delWp).toHaveBeenCalledWith(1);
    expect(actions.openInspector).toHaveBeenCalledOnce();
  });

  it('names the end stops as the inspector does and does not duplicate the start or end', () => {
    const start = menuOf({ kind: 'wp', index: 0 });
    expect(labels(start.items)).toEqual(['Open in inspector', 'Stop at entry', '—', 'Delete waypoint']);
    expect(start.items[1].checked).toBe(true);
    run(start.items, 'Stop at entry');
    expect(start.actions.setStop).toHaveBeenCalledWith(0, false);
    expect(labels(menuOf({ kind: 'wp', index: 3 }).items)).toEqual(['Open in inspector', 'Stop at exit', '—', 'Delete waypoint']);
  });

  it('leaves out Open in inspector, and the separator before it, while the inspector is open', () => {
    expect(labels(menuOf({ kind: 'em', index: 0 }, { inspectorOpen: true }).items)).toEqual(['Delete command']);
    expect(labels(menuOf({ kind: 'wp', index: 2 }, { inspectorOpen: true }).items)).toEqual(['Stop here', 'Duplicate waypoint', '—', 'Delete waypoint']);
  });

  it('deletes commands, zones and rotation targets by their index, named in the menu label', () => {
    const command = menuOf({ kind: 'em', index: 1 });
    expect(command.label).toBe('Shooter actions');
    expect(labels(command.items)).toEqual(['Open in inspector', '—', 'Delete command']);
    run(command.items, 'Delete command');
    expect(command.actions.delMarker).toHaveBeenCalledWith(1);

    const zone = menuOf({ kind: 'cr', index: 0 });
    expect(zone.label).toBe('Slow actions');
    run(zone.items, 'Delete zone');
    expect(zone.actions.delRange).toHaveBeenCalledWith(0);
    expect(menuOf({ kind: 'cr', index: 1 }).label).toBe('Zone actions');

    const target = menuOf({ kind: 'rt', index: 0 });
    expect(labels(target.items)).toEqual(['Open in inspector', '—', 'Delete rotation target']);
    run(target.items, 'Delete rotation target');
    expect(target.actions.delTarget).toHaveBeenCalledWith(0);
  });

  it('inserts a waypoint into a segment without offering to delete either end', () => {
    const segment = menuOf({ kind: 'seg', index: 2 });
    expect(labels(segment.items)).toEqual(['Open in inspector', 'Insert waypoint']);
    run(segment.items, 'Insert waypoint');
    expect(segment.actions.insertWp).toHaveBeenCalledWith(2);
  });

  it('adds at the pressed place from the bare lane and points row', () => {
    const add = vi.fn();
    const lane = menuOf({ kind: 'lane', label: 'Add command here' }, { add });
    expect(labels(lane.items)).toEqual(['Add command here']);
    lane.items[0].onClick();
    expect(add).toHaveBeenCalledOnce();
    expect(labels(menuOf({ kind: 'points', label: 'Add waypoint at the playhead' }, { add }).items)).toEqual(['Add waypoint at the playhead']);
  });

  it('shows nothing for an item that is gone', () => {
    for (const target of [{ kind: 'wp', index: 9 }, { kind: 'seg', index: 3 }, { kind: 'em', index: 5 }, { kind: 'cr', index: 2 }, { kind: 'rt', index: 1 }, { kind: 'issue', index: 0 }])
      expect(menuOf(target).items).toEqual([]);
  });

  it('renders a checked item as a checkbox and names the menu', () => {
    const html = renderToStaticMarkup(React.createElement(UI.ContextMenu, { x: 10, y: 10, label: 'Waypoint 1 actions', onClose: () => {},
      items: [{ label: 'Stop here', icon: 'stop', checked: true, onClick: () => {} }, { label: 'Duplicate waypoint', icon: 'copy', onClick: () => {} }] }));
    expect(html).toContain('aria-label="Waypoint 1 actions"');
    expect(html).toMatch(/role="menuitemcheckbox" aria-checked="true"[^>]*>.*Stop here/);
    expect(html).toMatch(/role="menuitem" tabindex="-1"[^>]*>.*Duplicate waypoint/);
    // Without a label the field's heading menu keeps its name.
    expect(renderToStaticMarkup(React.createElement(UI.ContextMenu, { x: 0, y: 0, onClose: () => {}, items: [] }))).toContain('aria-label="Heading actions"');
  });
});
