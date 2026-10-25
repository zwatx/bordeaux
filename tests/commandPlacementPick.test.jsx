import React from 'react';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearCommandPick, commandChoices, commandPickRequest, escapeCommandTrigger, retireCommandPick } from '../src/renderer/lib/commandPick';
import { PathPanel } from '../src/renderer/components/PathPanel';
import { UI } from '../src/renderer/components/ui';
import { createDemoProject } from '../src/shared/project/defaults';

const h = React.createElement;
const appSource = ts.createSourceFile('App.jsx', readFileSync(new URL('../src/renderer/app/App.jsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
/** The actual App source of a node matching `test`, found by walking the parsed file. */
function appNode(test) {
  let found = null;
  const visit = (node) => { if (!found && test(node)) found = node; else if (!found) ts.forEachChild(node, visit); };
  visit(appSource);
  if (!found) throw new Error('App node not found');
  return found;
}
const declared = (name) => appNode((node) => ts.isVariableDeclaration(node) && node.name.getText() === name).initializer;
const callbackOf = (name) => declared(name).arguments[0].getText();

const catalog = { commands: [{ id: 'intake', label: 'Start intake', member: 'Intake.vi' }, { id: 'shoot', label: 'Shoot', member: 'Shooter.vi', description: 'Fire note' }] };
const pick = { token: 2, documentKey: 3, pathId: 'p1', markerId: 'm2' };
const markers = [{ id: 'm1' }, { id: 'm2' }];
const view = (over = {}) => ({ projectKey: 3, docId: 'p1', markers, sel: { kind: null, idx: -1 }, selPending: true, ...over });

describe('command placement request', () => {
  it('is issued only for a loaded, nonempty catalog at placement', () => {
    const at = { documentKey: 3, pathId: 'p1', markerId: 'm2' };
    expect(commandPickRequest(2, { ...at, catalog, status: 'ready' })).toEqual(pick);
    expect(commandPickRequest(2, { ...at, catalog: null, status: 'unlinked' })).toBeNull();
    expect(commandPickRequest(2, { ...at, catalog, status: 'loading' })).toBeNull();
    expect(commandPickRequest(2, { ...at, catalog: { commands: [] }, status: 'ready' })).toBeNull();
  });

  it('survives only the placement render whose selection is still pending', () => {
    expect(retireCommandPick(null, view())).toBe(false);
    expect(retireCommandPick(pick, view())).toBe(false);
    // The selection commit shows the marker: its chooser has mounted, so the request is spent whether it opened or not.
    expect(retireCommandPick(pick, view({ sel: { kind: 'em', idx: 1 }, selPending: false }))).toBe(true);
    // An issue, another selection or a refused selection leaves nothing pending: retired, never carried forward.
    expect(retireCommandPick(pick, view({ selPending: false }))).toBe(true);
    expect(retireCommandPick(pick, view({ sel: { kind: 'em', idx: 0 }, selPending: false }))).toBe(true);
  });

  it('retires a request for another document, path or a marker that is gone', () => {
    expect(retireCommandPick(pick, view({ projectKey: 4 }))).toBe(true);
    expect(retireCommandPick(pick, view({ docId: 'p2' }))).toBe(true);
    expect(retireCommandPick(pick, view({ markers: [{ id: 'm1' }] }))).toBe(true);
    // Undo then a placement at the same index is a different marker.
    expect(retireCommandPick(pick, view({ markers: [{ id: 'm1' }, { id: 'm3' }] }))).toBe(true);
  });

  it('clears only its own token, so an older retirement cannot clear a newer placement', () => {
    const newer = { ...pick, token: 3, markerId: 'm3' };
    expect(clearCommandPick(2)(pick)).toBeNull();
    expect(clearCommandPick(2)(newer)).toBe(newer);
    expect(clearCommandPick(2)(null)).toBeNull();
  });
});

describe('App command placement wiring (actual App source)', () => {
  const placement = (state, rerunUpdater = true) => {
    let made = 9;
    const written = [], setCommandPick = vi.fn(), markerId = vi.fn(() => 'm' + ++made);
    const commit = (fn) => { written.push(fn({ markers: [{ id: 'm1' }] })); if (rerunUpdater) written.push(fn({ markers: [{ id: 'm1' }] })); };
    const addMarkerAt = new Function('commit', 'markerId', 'PM', 'derived', 'robotProjectState', 'projectKey', 'doc', 'commandPickSeq', 'setCommandPick', 'commandPickRequest',
      'return ' + callbackOf('addMarkerAt'))(commit, markerId, {}, { sample: { pts: [] } }, state, 7, { id: 'p1' }, { current: 4 }, setCommandPick, commandPickRequest);
    addMarkerAt(null, 0.25);
    return { written, setCommandPick, markerId };
  };

  it('generates the marker id once outside the commit and requests that exact marker', () => {
    const { written, setCommandPick, markerId } = placement({ catalog, status: 'ready' });
    expect(markerId).toHaveBeenCalledTimes(1);
    expect(written.map((d) => d.markers[1].id)).toEqual(['m10', 'm10']);
    expect(written[0]._selM).toBe(1);
    expect(written[0].markers[1]).toMatchObject({ f: 0.25, cmd: 'none', name: 'event2' });
    expect(setCommandPick).toHaveBeenCalledWith({ token: 5, documentKey: 7, pathId: 'p1', markerId: 'm10' });
  });

  it('clears any older request when the catalog is absent, empty or loading', () => {
    for (const state of [{ catalog: null, status: 'unlinked' }, { catalog, status: 'loading' }, { catalog: { commands: [] }, status: 'ready' }]) {
      expect(placement(state, false).setCommandPick).toHaveBeenCalledWith(null);
    }
  });

  it('retires in the selection commit by token compare-and-clear', () => {
    const effect = appNode((node) => ts.isCallExpression(node) && node.expression.getText() === 'useEffect' && node.arguments[0].getText().includes('retireCommandPick'));
    const run = (sel, selPending, current) => {
      const setCommandPick = vi.fn();
      const doc = { id: 'p1', markers, ...(selPending ? { _selM: 1 } : {}) };
      new Function('commandPick', 'retireCommandPick', 'clearCommandPick', 'projectKey', 'doc', 'sel', 'setCommandPick', 'return ' + effect.arguments[0].getText())(
        pick, retireCommandPick, clearCommandPick, 3, doc, sel, setCommandPick)();
      return setCommandPick.mock.calls.map(([update]) => update(current));
    };
    expect(run({ kind: 'wp', idx: 0 }, true, pick)).toEqual([]);
    expect(run({ kind: 'em', idx: 1 }, false, pick)).toEqual([null]);
    const newer = { ...pick, token: 9 };
    expect(run({ kind: 'em', idx: 1 }, false, newer)).toEqual([newer]);
    const deps = effect.arguments[1].getText();
    for (const name of ['commandPick', 'sel', 'doc.id', 'doc.markers', 'doc._selM', 'projectKey']) expect(deps).toContain(name);
  });

  it('shares one selection Escape between the window handler and the command trigger', () => {
    const run = (page, derivationCurrent) => {
      const calls = [];
      const spy = (name) => (...args) => calls.push([name, ...args]);
      const result = new Function('page', 'derivationCurrent', 'setTool', 'setHeadMenu', 'setWaypointPreviewRequest', 'select', 'return ' + declared('escapeSelection').getText())(
        page, derivationCurrent, spy('tool'), spy('menu'), spy('preview'), spy('select'))();
      return { result, calls };
    };
    expect(run('auto', true)).toEqual({ result: false, calls: [] });
    expect(run('plan', false)).toEqual({ result: false, calls: [] });
    expect(run('plan', true)).toEqual({ result: true, calls: [['tool', 'select'], ['menu', null], ['preview', null], ['select', null, -1]] });
    const text = appSource.getFullText();
    expect(text).toMatch(/\bif \(e\.key === 'Escape'\) escapeSelection\(\);/);
    expect(declared('bandActions').getText()).toContain('escapeSelection');
  });
});

describe('command choices', () => {
  it('offers no "No command" item until a command is set, and then lists it last', () => {
    expect(commandChoices(catalog.commands, '').map((item) => item.value)).toEqual(['intake', 'shoot']);
    expect(commandChoices(catalog.commands, 'shoot').map((item) => item.value)).toEqual(['intake', 'shoot', '']);
    expect(commandChoices(catalog.commands, 'shoot')[2].label).toBe('No command');
    expect(commandChoices(catalog.commands, 'shoot')[1]).toMatchObject({ label: 'Shoot', meta: 'Shooter.vi', searchText: 'Fire note shoot' });
  });

  it('keeps a missing current command first', () => {
    const items = commandChoices(catalog.commands, 'gone');
    expect(items[0]).toMatchObject({ value: 'gone', badge: 'Missing', meta: 'Not in robot code' });
    expect(items.map((item) => item.value)).toEqual(['gone', 'intake', 'shoot', '']);
  });
});

describe('closed command trigger Escape', () => {
  const element = (available = true) => ({ isConnected: available, disabled: false, closest: () => null, focus() { globalThis.document.activeElement = this; } });
  const event = (over = {}) => {
    const trigger = {};
    return { key: 'Escape', defaultPrevented: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, target: trigger,
      currentTarget: { querySelector: (selector) => (selector === '.cmd-picker-trigger' ? trigger : null) }, preventDefault: vi.fn(), ...over };
  };
  afterEach(() => { delete globalThis.document; });

  it('ignores other keys, modifiers, handled events and other targets', () => {
    globalThis.document = { activeElement: null };
    const escape = vi.fn(() => true);
    for (const over of [{ key: 'Enter' }, { shiftKey: true }, { metaKey: true }, { altKey: true }, { ctrlKey: true }, { defaultPrevented: true }, { target: {} }]) {
      const e = event(over);
      expect(escapeCommandTrigger(e, escape, () => [element()])).toBe(false);
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
    expect(escape).not.toHaveBeenCalled();
    expect(globalThis.document.activeElement).toBeNull();
  });

  it('moves no focus and keeps the event when the selection clear is refused', () => {
    globalThis.document = { activeElement: null };
    const e = event();
    expect(escapeCommandTrigger(e, () => false, () => [element()])).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(globalThis.document.activeElement).toBeNull();
  });

  it('clears once, claims the event and focuses the chip, else the heading', () => {
    globalThis.document = { activeElement: null };
    const chip = element(), heading = element(), escape = vi.fn(() => true), e = event();
    expect(escapeCommandTrigger(e, escape, () => [chip, heading])).toBe(true);
    expect(escape).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(globalThis.document.activeElement).toBe(chip);
    expect(escapeCommandTrigger(event(), escape, () => [element(false), heading])).toBe(true);
    expect(globalThis.document.activeElement).toBe(heading);
  });
});

describe('PathPanel command chooser (static markup)', () => {
  const panel = (over = {}) => {
    const doc = { ...createDemoProject().paths[0] };
    doc.markers = [{ id: 'm1', f: 0.2, name: 'event1', cmd: 'none' }, { id: 'm2', f: 0.6, name: 'event2', cmd: 'shoot', invocation: { commandId: 'shoot', arguments: {} } }];
    const props = { doc, sel: { kind: 'em', idx: 0 }, derived: {}, tl: { empty: true }, robot: {}, drive: 'swerve', project: { paths: [doc] }, actions: {},
      robotProject: { status: 'ready', catalog }, playbackStore: { getSnapshot: () => ({ time: 0 }) }, commandPickFor: null, ...over };
    return renderToStaticMarkup(h(PathPanel, props));
  };
  const trigger = (markup) => markup.match(/<button id="band-command"[^>]*>/)?.[0] || '';

  it('opens only for the requested marker at mount, with search for any catalog size', () => {
    expect(trigger(panel({ commandPickFor: 'm1' }))).toContain('aria-expanded="true"');
    expect(trigger(panel())).toContain('aria-expanded="false"');
    expect(trigger(panel({ commandPickFor: 'm2' }))).toContain('aria-expanded="false"');
    expect(trigger(panel({ commandPickFor: 'm2', sel: { kind: 'em', idx: 1 } }))).toContain('aria-expanded="true"');
  });

  it('stays closed while the catalog loads and shows the link row without one', () => {
    const loading = trigger(panel({ commandPickFor: 'm1', robotProject: { status: 'loading', catalog } }));
    expect(loading).toContain('aria-expanded="false"');
    expect(loading).toContain('disabled');
    const unlinked = panel({ commandPickFor: 'm1', robotProject: { status: 'unlinked', catalog: null, link() {} } });
    expect(unlinked).not.toContain('band-command');
    expect(unlinked).toContain('Link robot code…');
  });

  it('shows "No command" as the unset placeholder and the label once set', () => {
    expect(panel()).toMatch(/id="band-command-value" title="No command">No command</);
    expect(panel({ sel: { kind: 'em', idx: 1 } })).toMatch(/id="band-command-value" title="Shoot">Shoot</);
  });
});

describe('Dropdown mount-only opt-in', () => {
  const markup = (props) => renderToStaticMarkup(h(UI.Dropdown, { id: 'd', ariaLabel: 'D', value: '', items: [{ value: 'a', label: 'A' }], onChange() {}, ...props }));
  it('opens at mount only when opted in and enabled; other callers stay closed', () => {
    expect(markup({ defaultOpen: true })).toContain('aria-expanded="true"');
    expect(markup({ defaultOpen: true, disabled: true })).toContain('aria-expanded="false"');
    expect(markup({})).toContain('aria-expanded="false"');
  });
});
