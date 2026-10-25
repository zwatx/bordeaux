import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';
import { loadRendererExport } from './helpers/loadRendererExport';
import { AUTO } from '../src/renderer/lib/routineModel';
import { deletionInput } from '../src/renderer/components/DeletionNotice';
import { robotValueSchemasEqual } from '../src/shared/robotValueSchema';
import { UI as RenderedUI } from '../src/renderer/components/ui';
import { CommandBranches as RenderedBranches } from '../src/renderer/components/CommandBranches';

// Actual renderer sources run with minimal hooks and a focus-tracking DOM: no DOM library is installed,
// and these checks need the primitives' real focus and refusal behavior, not markup alone.
const MODAL = 'dialog:modal,[role="dialog"][aria-modal="true"]';
class FakeNode {
  constructor(doc, key) { Object.assign(this, { doc, key, parent: null, props: {}, isConnected: false }); }
  get disabled() { return Boolean(this.props.disabled); }
  get dataset() { return Object.fromEntries(Object.entries(this.props).filter(([name]) => name.startsWith('data-')).map(([name, value]) => [name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase()), value])); }
  focus() { if (!this.isConnected || this.disabled) return; this.doc.activeElement = this; this.doc.emit('focusin', { target: this }); }
  contains(other) { for (let node = other; node; node = node.parent) if (node === this) return true; return false; }
  matches(selector) {
    return selector.split(',').some((part) => {
      part = part.trim();
      if (part.startsWith('#')) return this.props.id === part.slice(1);
      if (part.startsWith('.')) return String(this.props.className || '').split(' ').includes(part.slice(1));
      const attribute = part.match(/^\[([\w-]+)\]$/);
      return Boolean(attribute && this.props[attribute[1]] != null);
    });
  }
  closest(selector) { for (let node = this; node && node !== this.doc.body; node = node.parent) if (node.matches(selector)) return node; return null; }
  // As in a DOM, a detached subtree stays queryable; focusing a detached node does nothing.
  querySelectorAll(selector) { return [...this.doc.nodes].filter((node) => node !== this && this.contains(node) && node.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getBoundingClientRect() { return { left: 0, top: 100, bottom: 120, width: 240, height: 20 }; }
  scrollIntoView() {}
  select() {}
}
function environment() {
  const listeners = new Map(), frames = new Map();
  let frame = 0, instance = null;
  const doc = { modal: false, nodes: new Set(),
    addEventListener: (type, listener) => listeners.set(type, [...(listeners.get(type) || []), listener]),
    removeEventListener: (type, listener) => listeners.set(type, (listeners.get(type) || []).filter((item) => item !== listener)),
    emit: (type, event) => (listeners.get(type) || []).slice().forEach((listener) => listener(event)),
    querySelector: (selector) => selector === MODAL && doc.modal ? {} : null };
  doc.body = new FakeNode(doc, 'body'); doc.body.isConnected = true; doc.activeElement = doc.body;
  const slot = (make) => { const index = instance.cursor++; return instance.cells[index] ??= make(); };
  const effect = (run, deps) => {
    const cell = slot(() => ({ ready: false }));
    if (cell.ready && deps && deps.every((value, index) => value === cell.deps[index])) return;
    cell.ready = true; cell.deps = deps;
    instance.effects.push(() => { if (typeof cell.cleanup === 'function') cell.cleanup(); cell.cleanup = run(); });
  };
  const fakeReact = { Fragment: 'Fragment', useId: () => 'fake-id', useEffect: effect, useLayoutEffect: effect,
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter((child) => child != null && child !== false && child !== true) }),
    useRef: (current) => slot(() => ({ current })),
    useState: (initial) => {
      const cell = slot(() => ({ value: typeof initial === 'function' ? initial() : initial })), owner = instance;
      return [cell.value, (next) => { const value = typeof next === 'function' ? next(cell.value) : next; if (!Object.is(value, cell.value)) { cell.value = value; owner.dirty = true; } }];
    } };
  const mount = (Component) => {
    const self = { cells: [], nodes: new Map(), refs: [], props: null, tree: null };
    const sync = () => {
      const seen = new Set(), refs = [];
      const walk = (element, parent, path) => {
        if (!element || typeof element !== 'object') return;
        if (element.type === 'portal') { element.children.forEach((child, index) => walk(child, doc.body, path + '/portal' + index)); return; }
        const key = element.props.id ? '#' + element.props.id : path;
        const node = self.nodes.get(key) || new FakeNode(doc, key);
        self.nodes.set(key, node); doc.nodes.add(node); seen.add(node);
        Object.assign(node, { props: element.props, type: element.type, parent, isConnected: true }); element.node = node;
        if (element.props.ref) refs.push([element.props.ref, node]);
        element.children.forEach((child, index) => walk(child, node, key + '/' + index));
      };
      walk(self.tree, doc.body, 'root');
      for (const node of self.nodes.values()) if (!seen.has(node)) { node.isConnected = false; if (doc.activeElement === node) doc.activeElement = doc.body; }
      const assign = (ref, node) => typeof ref === 'function' ? ref(node) : (ref.current = node);
      self.refs.filter(([ref]) => !refs.some(([next]) => next === ref)).forEach(([ref]) => assign(ref, null));
      refs.forEach(([ref, node]) => assign(ref, node)); self.refs = refs;
    };
    self.render = (props = self.props) => {
      self.props = props;
      for (let pass = 0; pass < 8; pass += 1) {
        instance = self; self.cursor = 0; self.effects = []; self.dirty = false;
        self.tree = Component(props); instance = null;
        sync(); self.effects.forEach((run) => run());
        if (!self.dirty) return self;
      }
      throw new Error('render did not settle');
    };
    self.unmount = () => { self.tree = null; sync(); };
    self.find = (predicate, element = self.tree) => {
      if (!element || typeof element !== 'object') return null;
      if (element.type !== 'portal' && predicate(element)) return element;
      for (const child of element.children) { const found = self.find(predicate, child); if (found) return found; }
      return null;
    };
    return self;
  };
  const context = { React: fakeReact, document: doc, requestAnimationFrame: (callback) => { frames.set(++frame, callback); return frame; },
    cancelAnimationFrame: (id) => frames.delete(id), createPortal: (element) => ({ type: 'portal', props: {}, children: [element] }),
    confirm: () => { throw new Error('confirm must not be called'); } };
  const flushFrames = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback()); };
  const outside = (key) => { const node = new FakeNode(doc, key); node.parent = doc.body; node.isConnected = true; doc.nodes.add(node); return node; };
  return { doc, context, mount, flushFrames, outside };
}
const press = (patch = {}) => ({ button: 0, detail: 1, key: '', preventDefault: vi.fn(), stopPropagation: vi.fn(), ...patch });

function primitives(env) {
  return loadRendererExport(new URL('../src/renderer/components/ui.jsx', import.meta.url), 'UI', {
    context: { ...env.context, PointerDrag: { useController: () => ({}) }, committedDraftValue: () => null, PM: {}, UnitPrefs: {} },
    window: { innerWidth: 1440, innerHeight: 900, addEventListener() {}, removeEventListener() {} },
  });
}
function dropdown(props) {
  const env = environment(), UI = primitives(env), view = env.mount(UI.Dropdown);
  view.render({ id: 'pick', label: 'Branch on output', value: 'a', items: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], ...props });
  const trigger = () => view.find((element) => element.props.id === 'pick').node;
  const open = () => { view.find((element) => element.props.id === 'pick').props.onClick(); view.render(); env.flushFrames(); view.render(); };
  const panel = () => view.find((element) => String(element.props.className).includes('cmd-picker-panel'));
  const option = (value) => view.find((element) => element.props.role === 'option' && element.props['data-value'] === value);
  return { ...env, UI, view, trigger, open, panel, option };
}
function choiceBrowser(props) {
  const env = environment(), UI = primitives(env), view = env.mount(UI.ChoiceBrowser);
  view.render({ id: 'routine-command', label: 'Command', value: 'scan', resetKey: 'cmd',
    items: [{ value: '', label: 'Choose a command' }, { value: 'scan', label: 'Scan' }, { value: 'aim', label: 'Aim' }], ...props });
  const change = () => view.find((element) => element.props.className === 'choice-change');
  const search = () => view.find((element) => element.props.id === 'routine-command' && element.type === 'input');
  const option = (label) => view.find((element) => element.props.role === 'option' && element.children[0]?.children?.[0]?.children?.[0] === label);
  const expand = () => { change().props.onClick(); view.render(); };
  const type = (text) => { search().props.onChange({ target: { value: text } }); view.render(); };
  return { ...env, UI, view, change, search, option, expand, type };
}

describe('Dropdown opt-in chooser admission', () => {
  it('keeps an outside invalid field focused after a pointer or keyboard refusal and never refocuses the trigger', () => {
    for (const viaKeyboard of [false, true]) {
      let invalid;
      const ui = dropdown({ onChoose: vi.fn(() => { invalid.focus(); return 'refused'; }) });
      invalid = ui.outside('invalid');
      ui.open(); expect(ui.panel()).not.toBeNull();
      if (viaKeyboard) {
        ui.panel().props.onKeyDown(press({ key: 'ArrowDown', target: ui.option('a').node })); ui.view.render();
        ui.panel().props.onKeyDown(press({ key: 'Enter', target: ui.option('b').node }));
      } else ui.option('b').props.onClick();
      ui.view.render(); ui.flushFrames(); ui.view.render();
      expect(ui.view.props.onChoose).toHaveBeenCalledExactlyOnceWith('b');
      expect(ui.doc.activeElement).toBe(invalid);
      expect(ui.panel()).toBeNull();
    }
  });
  it('stays open on a refusal that moves no focus, and returns focus to its trigger after applied or unchanged choices', () => {
    let ui = dropdown({ onChoose: () => 'refused' });
    ui.open(); ui.option('b').props.onClick(); ui.view.render(); ui.flushFrames();
    expect(ui.panel()).not.toBeNull(); expect(ui.doc.activeElement).not.toBe(ui.trigger());
    for (const status of ['applied', 'unchanged']) {
      ui = dropdown({ onChoose: () => status });
      ui.open(); ui.option('b').props.onClick(); ui.view.render(); ui.flushFrames();
      expect(ui.panel()).toBeNull(); expect(ui.doc.activeElement).toBe(ui.trigger());
    }
  });
  it('does not take focus that moved elsewhere or behind a modal before its frame', () => {
    let ui = dropdown({ onChoose: () => 'applied' });
    const other = ui.outside('other');
    ui.open(); ui.option('b').props.onClick(); ui.view.render(); other.focus(); ui.flushFrames();
    expect(ui.doc.activeElement).toBe(other);
    ui = dropdown({ onChoose: () => 'applied' });
    ui.open(); ui.option('b').props.onClick(); ui.view.render(); ui.doc.modal = true; ui.flushFrames();
    expect(ui.doc.activeElement).not.toBe(ui.trigger());
  });
  it('keeps the legacy onChange path whatever its callback returns', () => {
    for (const returned of [false, undefined, 'refused']) {
      const ui = dropdown({ onChange: vi.fn(() => returned) });
      ui.open(); ui.option('b').props.onClick(); ui.view.render(); ui.flushFrames();
      expect(ui.view.props.onChange).toHaveBeenCalledExactlyOnceWith('b');
      expect(ui.panel()).toBeNull(); expect(ui.doc.activeElement).toBe(ui.trigger());
    }
  });
});

describe('ChoiceBrowser opt-in chooser admission', () => {
  it('keeps the list expanded with its query and the invalid field focused after a pointer or keyboard refusal', () => {
    for (const viaKeyboard of [false, true]) {
      let invalid;
      const ui = choiceBrowser({ onChoose: vi.fn(() => { invalid.focus(); return 'refused'; }) });
      invalid = ui.outside('invalid');
      ui.expand(); ui.type('ai');
      if (viaKeyboard) {
        ui.search().props.onKeyDown(press({ key: 'ArrowDown' })); ui.view.render();
        ui.search().props.onKeyDown(press({ key: 'Enter' }));
      } else ui.option('Aim').props.onClick();
      ui.view.render(); ui.flushFrames(); ui.view.render();
      expect(ui.view.props.onChoose).toHaveBeenCalledExactlyOnceWith('aim');
      expect(ui.doc.activeElement).toBe(invalid);
      expect(ui.search().props.value).toBe('ai');
    }
  });
  it('collapses to Change after a choice, and to search after clearing, unless focus moved first', () => {
    let ui = choiceBrowser({ onChoose: () => 'applied' });
    ui.expand(); expect(ui.view.find((element) => element.props.id === 'routine-command-note')).toBeNull(); expect(ui.search().props['aria-describedby']).toBeUndefined();
    ui.option('Aim').props.onClick(); ui.view.render({ ...ui.view.props, value: 'aim' }); ui.flushFrames();
    expect(ui.search()).toBeNull(); expect(ui.doc.activeElement).toBe(ui.change().node);
    ui = choiceBrowser({ onChoose: () => 'applied' });
    ui.expand(); ui.option('Choose a command').props.onClick(); ui.view.render({ ...ui.view.props, value: '' }); ui.flushFrames();
    expect(ui.doc.activeElement).toBe(ui.search().node);
    ui = choiceBrowser({ onChoose: () => 'unchanged' });
    ui.expand(); ui.option('Scan').props.onClick(); ui.view.render(); ui.flushFrames();
    expect(ui.doc.activeElement).toBe(ui.change().node);
    ui = choiceBrowser({ onChoose: () => 'applied' });
    const other = ui.outside('other');
    ui.expand(); ui.option('Aim').props.onClick(); ui.view.render(); other.focus(); ui.flushFrames();
    expect(ui.doc.activeElement).toBe(other);
  });
  it('keeps the legacy onChange path and shows a note only while expanded, described by the search', () => {
    const ui = choiceBrowser({ onChange: vi.fn(() => false), note: 'Another command removes 5 branch steps.' });
    expect(ui.view.find((element) => element.props.id === 'routine-command-note')).toBeNull();
    ui.expand();
    expect(ui.view.find((element) => element.props.id === 'routine-command-note').children).toEqual(['Another command removes 5 branch steps.']);
    expect(ui.search().props['aria-describedby']).toBe('routine-command-note');
    ui.option('Aim').props.onClick(); ui.view.render(); ui.flushFrames();
    expect(ui.view.props.onChange).toHaveBeenCalledExactlyOnceWith('aim'); expect(ui.doc.activeElement).toBe(ui.change().node);
    const markup = renderToStaticMarkup(React.createElement(RenderedUI.ChoiceBrowser, { id: 'routine-command', label: 'Command', value: '', note: 'Another command removes 1 branch step.', items: [{ value: '', label: 'Choose a command' }], onChoose: () => 'applied' }));
    expect(markup).toContain('<p id="routine-command-note" class="seg-hint">Another command removes 1 branch step.</p>');
    expect(markup).toContain('aria-describedby="routine-command-note"');
  });
});

// App's opted-in results carry `current()`; a later Undo, replacement, routine switch or sync makes it false while
// the chooser instance, its IDs and its DOM can all survive (the inspector body is keyed only by node.id).
describe('opted-in chooser deferred focus ownership', () => {
  const owner = (status) => { const result = { status, owns: true, current: () => result.owns }; return result; };
  const pickB = (ui, viaKeyboard) => {
    if (!viaKeyboard) { ui.option('b').props.onClick(); return; }
    ui.panel().props.onKeyDown(press({ key: 'ArrowDown', target: ui.option('a').node })); ui.view.render();
    ui.panel().props.onKeyDown(press({ key: 'Enter', target: ui.option('b').node }));
  };
  const pickAim = (ui, viaKeyboard) => {
    ui.type('ai');
    if (!viaKeyboard) { ui.option('Aim').props.onClick(); return; }
    ui.search().props.onKeyDown(press({ key: 'ArrowDown' })); ui.view.render(); ui.search().props.onKeyDown(press({ key: 'Enter' }));
  };
  it('Dropdown leaves its surviving connected trigger alone once the result no longer owns it, after pointer or keyboard', () => {
    for (const viaKeyboard of [false, true]) for (const status of ['applied', 'unchanged']) for (const replaced of [true, false]) {
      const result = owner(status), ui = dropdown({ onChoose: () => result });
      ui.open(); const trigger = ui.trigger(); pickB(ui, viaKeyboard);
      ui.view.render({ ...ui.view.props, value: 'b' });
      result.owns = !replaced; ui.view.render({ ...ui.view.props, value: replaced ? 'a' : 'b' });
      expect(ui.trigger()).toBe(trigger); expect(trigger.isConnected).toBe(true); expect(ui.panel()).toBeNull();
      ui.flushFrames();
      expect(ui.doc.activeElement).toBe(replaced ? ui.doc.body : trigger);
    }
  });
  it('ChoiceBrowser leaves its surviving connected Change alone once the result no longer owns it, after pointer or keyboard', () => {
    for (const viaKeyboard of [false, true]) for (const replaced of [true, false]) {
      const result = owner('applied'), ui = choiceBrowser({ onChoose: () => result });
      ui.expand(); pickAim(ui, viaKeyboard); ui.view.render({ ...ui.view.props, value: 'aim' });
      const change = ui.change().node;
      result.owns = !replaced; ui.view.render({ ...ui.view.props, value: replaced ? 'scan' : 'aim' });
      expect(ui.change().node).toBe(change); expect(change.isConnected).toBe(true); expect(ui.search()).toBeNull();
      ui.flushFrames();
      expect(ui.doc.activeElement).toBe(replaced ? ui.doc.body : change);
    }
    const result = owner('unchanged'), ui = choiceBrowser({ onChoose: () => result });
    ui.expand(); ui.option('Scan').props.onClick(); ui.view.render(); result.owns = false; ui.view.render(); ui.flushFrames();
    expect(ui.change().node.isConnected).toBe(true); expect(ui.doc.activeElement).toBe(ui.doc.body);
  });
  it('yields to a search reopened in the same chooser before its frame', () => {
    for (const viaKeyboard of [false, true]) {
      const ui = choiceBrowser({ onChoose: () => owner('applied') });
      ui.expand(); pickAim(ui, viaKeyboard); ui.view.render({ ...ui.view.props, value: 'aim' });
      ui.expand(); ui.type('sc');
      expect(ui.doc.activeElement).toBe(ui.search().node);
      ui.flushFrames();
      expect(ui.doc.activeElement).toBe(ui.search().node); expect(ui.search().props.value).toBe('sc');
    }
  });
  it('never focuses a chooser remounted with the same IDs before the old frame', () => {
    let ui = dropdown({ onChoose: () => owner('applied') });
    ui.open(); ui.option('b').props.onClick(); ui.view.unmount();
    let fresh = ui.mount(ui.UI.Dropdown).render(ui.view.props); ui.flushFrames();
    expect(fresh.find((element) => element.props.id === 'pick').node.isConnected).toBe(true); expect(ui.doc.activeElement).toBe(ui.doc.body);
    ui = choiceBrowser({ onChoose: () => owner('applied') });
    ui.expand(); ui.option('Aim').props.onClick(); ui.view.unmount();
    fresh = ui.mount(ui.UI.ChoiceBrowser).render({ ...ui.view.props, value: 'aim' }); ui.flushFrames();
    expect(fresh.find((element) => element.props.className === 'choice-change').node.isConnected).toBe(true); expect(ui.doc.activeElement).toBe(ui.doc.body);
  });
  it('keeps the invalid field focused and the chooser open with its query after a refused owner result and its frame', () => {
    for (const viaKeyboard of [false, true]) {
      let invalid;
      const refuse = vi.fn(() => { invalid.focus(); return { status: 'refused', removed: 0 }; });
      let ui = dropdown({ onChoose: refuse }); invalid = ui.outside('invalid');
      ui.open(); pickB(ui, viaKeyboard); ui.view.render(); ui.flushFrames(); ui.view.render();
      expect(ui.doc.activeElement).toBe(invalid); expect(refuse).toHaveBeenCalledOnce();
      ui = choiceBrowser({ onChoose: refuse }); invalid = ui.outside('invalid');
      ui.expand(); pickAim(ui, viaKeyboard); ui.view.render(); ui.flushFrames(); ui.view.render();
      expect(ui.doc.activeElement).toBe(invalid); expect(ui.search().props.value).toBe('ai');
      refuse.mockClear();
    }
  });
});

const I32 = { kind: 'integer', valueType: 'I32' };
const scan = (schema = I32) => ({ id: 'scan', label: 'Scan', outputs: [{ name: 'score', label: 'Score', schema }, { name: 'ready', label: 'Ready', schema: { kind: 'boolean', valueType: 'Boolean' } }] });
const commandNode = (routes) => ({ id: 'cmd', type: 'function', cat: 'command', invocation: { commandId: 'scan', arguments: {} }, outputBranch: { output: 'score', schema: { ...I32 }, routes: routes || [
  { id: 'a1', label: 'High', operator: 'gte', value: 50, nodes: [{ id: 'loop', type: 'repeat', times: 2, nodes: [{ id: 'dec', type: 'decision', cond: 'c', then: [{ id: 'exit', type: 'end', scope: 'repeat' }], else: [{ id: 'w', type: 'builtin', builtinId: 'bordeaux.wait' }] }] }] },
  { id: 'a2', label: 'Mid', operator: 'gte', value: 10, nodes: [{ id: 'mid', type: 'builtin', builtinId: 'bordeaux.wait' }] },
  { id: 'a3', label: 'Otherwise', operator: 'otherwise', nodes: [] }] } });
function branches(node = commandNode(), command = scan(), result = { status: 'applied', removed: 0, current: () => true }) {
  const env = environment();
  const Component = loadRendererExport(new URL('../src/renderer/components/CommandBranches.jsx', import.meta.url), 'CommandBranches', {
    context: { ...env.context, AUTO, deletionInput, robotValueSchemasEqual, CommandParameterEditor: 'CommandParameterEditor', UI: { Dropdown: 'Dropdown', DraftText: 'DraftText', Icon: 'Icon' } },
    replacements: [['export function CommandBranches', 'window.CommandBranches = function CommandBranches']],
  });
  const acq = { outcomes: {}, setOutcome: vi.fn(), branch: vi.fn(() => result) }, view = env.mount(Component).render({ node, command, acq });
  const picker = () => view.find((element) => element.props.id === 'command-branch-output').props;
  const trash = (routeId) => view.find((element) => element.props['data-route-remove'] === routeId);
  return { ...env, acq, result, view, picker, trash, meta: () => picker().items.map((item) => item.meta), remount: (props) => env.mount(Component).render(props) };
}

describe('command branch consequences', () => {
  it('keeps changed output bounds out of the retained saved-schema value editor', () => {
    const node = commandNode();
    node.outputBranch.schema = { kind: 'integerString', valueType: 'I64' };
    for (const route of node.outputBranch.routes) if (route.operator !== 'otherwise') route.value = '2';
    const command = scan({ kind: 'number', valueType: 'DBL' });
    Object.assign(command.outputs[0], { min: .5, max: 1.5 });
    const ui = branches(node, command);
    const editor = ui.view.find(element => element.props.id === 'route-value-a1').props;
    expect(editor.schema).toEqual(node.outputBranch.schema);
    expect(editor.parameter).toEqual({});
    expect(() => renderToStaticMarkup(React.createElement(RenderedBranches, { node, command, acq: { outcomes: {}, branch: () => ({}) } }))).not.toThrow();
    const matching = scan(node.outputBranch.schema);
    Object.assign(matching.outputs[0], { min: '3', max: '10' });
    expect(branches(node, matching).view.find(element => element.props.id === 'route-value-a1').props.parameter).toBe(matching.outputs[0]);
  });
  it('maps the output picker: rebuild only for a changed saved schema, keep for the same or missing output, and returns the owner result whole', () => {
    let ui = branches();
    for (const value of ['score', 'ready', '']) expect(ui.picker().onChoose(value)).toBe(ui.result);
    expect(ui.picker().onChange).toBeUndefined();
    expect(ui.acq.branch.mock.calls).toEqual([['cmd', { kind: 'keep' }], ['cmd', { kind: 'output', output: 'ready' }], ['cmd', { kind: 'output', output: '' }]]);
    ui = branches(commandNode(), scan({ kind: 'integerString', valueType: 'I64' }));
    ui.picker().onChoose('score'); expect(ui.acq.branch).toHaveBeenCalledExactlyOnceWith('cmd', { kind: 'rebuild' });
    ui = branches(commandNode(), { id: 'scan', label: 'Scan', outputs: [] });
    ui.picker().onChoose('score'); expect(ui.acq.branch).toHaveBeenCalledExactlyOnceWith('cmd', { kind: 'keep' });
    ui = branches({ ...commandNode(), outputBranch: undefined });
    ui.picker().onChoose(''); expect(ui.acq.branch).toHaveBeenCalledExactlyOnceWith('cmd', { kind: 'keep' });
  });
  it('states what each choice removes before it is made, and nothing when routes are empty', () => {
    let ui = branches();
    expect(ui.meta()).toEqual(['Removes 5 branch steps', 'integer', 'boolean · removes 5 steps']);
    const head = (index) => ui.view.find((element) => element.props['aria-label'] === 'Route ' + index).children[0].children[1].children[0];
    expect([head(1), head(2), head(3)]).toEqual(['≥ 50 · 4 steps', '≥ 10 · 1 step', 'Otherwise']);
    expect(ui.trash('a1').props).toMatchObject({ 'aria-label': 'Remove route 1 and its 4 steps', title: 'Remove comparison and its 4 steps' });
    expect(ui.trash('a2').props).toMatchObject({ 'aria-label': 'Remove route 2 and its 1 step', title: 'Remove comparison and its 1 step' });
    ui = branches(commandNode(), scan({ kind: 'integerString', valueType: 'I64' }));
    expect(ui.meta()).toEqual(['Removes 5 branch steps', 'Type changed · removes 5 steps', 'boolean · removes 5 steps']);
    expect(ui.view.find((element) => element.type === 'button' && String(element.children[0]).startsWith('Rebuild')).children).toEqual(['Rebuild routes · removes 5 steps']);
    const empty = commandNode(commandNode().outputBranch.routes.map((route) => ({ ...route, nodes: [] })));
    ui = branches(empty, scan({ kind: 'integerString', valueType: 'I64' }));
    expect(ui.meta()).toEqual([undefined, 'integerString', 'boolean']);
    expect(ui.trash('a1').props).toMatchObject({ 'aria-label': 'Remove route 1', title: 'Remove comparison' });
    expect(ui.view.find((element) => element.type === 'button' && String(element.children[0]).startsWith('Rebuild')).children).toEqual(['Rebuild routes']);
  });
  it('routes field edits through intents without writing captured route steps', () => {
    const ui = branches(), route = (routeId) => ui.view.find((element) => element.props.id === 'route-label-' + routeId).props;
    route('a1').onCommit(' Renamed ');
    ui.view.find((element) => element.props.id === 'route-operator-a2').props.onChange('lt');
    ui.view.find((element) => element.props.id === 'route-value-a2').props.onChange(12);
    ui.view.find((element) => element.props['aria-label'] === 'Check route 2 earlier').props.onClick();
    ui.view.find((element) => element.props.className === 'rt-openbtn command-branch-add').props.onClick();
    expect(ui.acq.branch.mock.calls.map(([, intent]) => intent)).toEqual([
      { kind: 'patchRoute', routeId: 'a1', patch: { label: ' Renamed ' } }, { kind: 'patchRoute', routeId: 'a2', patch: { operator: 'lt' } },
      { kind: 'patchRoute', routeId: 'a2', patch: { value: 12 } }, { kind: 'routeEarlier', routeId: 'a2' }, { kind: 'addComparison' }]);
    expect(JSON.stringify(ui.acq.branch.mock.calls)).not.toContain('nodes');
  });
  it('acts once per pointer or keyboard press and ignores the physical follow-on click', () => {
    const ui = branches(), trash = () => ui.trash('a1').props;
    trash().onPointerDown(press()); trash().onClick(press());
    trash().onKeyDown(press({ key: 'Enter' })); trash().onKeyDown(press({ key: 'Enter', repeat: true })); trash().onKeyDown(press({ key: 'Delete' }));
    trash().onClick(press({ detail: 0 }));
    expect(ui.acq.branch.mock.calls).toEqual(Array(3).fill(['cmd', { kind: 'removeRoute', routeId: 'a1' }]));
  });
  it('focuses the next remaining comparison in this section instance only while the action owns the routine', () => {
    const removed = commandNode(commandNode().outputBranch.routes.slice(1));
    removed.outputBranch.routes.splice(1, 0, { id: 'a4', label: 'Low', operator: 'gte', value: 1, nodes: [] });
    let ui = branches();
    ui.trash('a1').props.onPointerDown(press()); ui.view.render({ ...ui.view.props, node: removed }); ui.flushFrames();
    expect(ui.doc.activeElement).toBe(ui.trash('a2').node);
    ui = branches();
    ui.trash('a1').props.onPointerDown(press()); ui.view.render({ ...ui.view.props, node: commandNode(commandNode().outputBranch.routes.slice(1)) }); ui.flushFrames();
    expect(ui.doc.activeElement).toBe(ui.view.find((element) => element.props.className === 'rt-openbtn command-branch-add').node);
    // A stale result, a replaced section with the same serialized IDs, or focus taken elsewhere stays inert.
    ui = branches(commandNode(), scan(), { status: 'applied', removed: 4, current: () => false });
    ui.trash('a1').props.onPointerDown(press()); ui.view.render({ ...ui.view.props, node: removed }); ui.flushFrames();
    expect(ui.doc.activeElement).toBe(ui.doc.body);
    ui = branches();
    ui.trash('a1').props.onPointerDown(press()); ui.view.unmount();
    const remounted = ui.remount({ node: removed, command: scan(), acq: ui.acq }); ui.flushFrames();
    expect(ui.doc.activeElement).toBe(ui.doc.body); expect(remounted.find((element) => element.props['data-route-remove'] === 'a2')).not.toBeNull();
    ui = branches();
    const other = ui.outside('other');
    other.focus(); ui.trash('a1').props.onPointerDown(press()); ui.doc.activeElement = ui.outside('newer'); ui.view.render({ ...ui.view.props, node: removed }); ui.flushFrames();
    expect(ui.doc.activeElement.key).toBe('newer');
  });
  it('moves focus after Rebuild to the output picker, and not after a refusal', () => {
    let ui = branches(commandNode(), scan({ kind: 'integerString', valueType: 'I64' }));
    const rebuild = () => ui.view.find((element) => element.type === 'button' && String(element.children[0]).startsWith('Rebuild')).props;
    rebuild().onKeyDown(press({ key: ' ' })); ui.flushFrames();
    expect(ui.acq.branch).toHaveBeenCalledExactlyOnceWith('cmd', { kind: 'rebuild' });
    expect(ui.doc.activeElement.key).toBe('#command-branch-output');
    ui = branches(commandNode(), scan({ kind: 'integerString', valueType: 'I64' }), { status: 'refused', removed: 0 });
    rebuild().onPointerDown(press()); ui.flushFrames();
    expect(ui.doc.activeElement).toBe(ui.doc.body);
  });
  it('renders flat consequence copy through real React', () => {
    const markup = renderToStaticMarkup(React.createElement(RenderedBranches, { node: commandNode(), command: scan(), acq: { outcomes: {}, branch: () => ({}) } }));
    expect(markup).toContain('≥ 50 · 4 steps'); expect(markup).toContain('aria-label="Remove route 1 and its 4 steps"');
    expect(markup).toContain('data-route-remove="a2"'); expect(markup).not.toContain('confirm');
  });
});

describe('routine command chooser', () => {
  function inspector(node) {
    const env = environment(), marker = (name) => name;
    const StepInspector = loadRendererExport(new URL('../src/renderer/components/RoutineInspector.jsx', import.meta.url), 'StepInspector', {
      context: { ...env.context, AUTO, deletionInput, robotValueSchemasEqual, UnitPrefs: { format: String }, CommandBranches: 'CommandBranches', CommandParameterEditor: 'CommandParameterEditor',
        commandArguments: () => ({}), parameterValueError: () => '', safeControlId: String, LabviewProjectPanel: 'LabviewProjectPanel', Glyph: 'Glyph', continuityText: String, describeStop: String, stepTitle: String,
        UI: { Icon: marker('Icon'), Dropdown: 'Dropdown', ChoiceBrowser: 'ChoiceBrowser', DraftText: 'DraftText', Seg: 'Seg', Toggle: 'Toggle' } },
      replacements: [['export function StepInspector', 'window.StepInspector = function StepInspector'], ['export function RoutineTransport', 'function RoutineTransport']],
    });
    const acq = { branch: vi.fn(() => ({ status: 'refused', removed: 0 })), set: vi.fn(), select: vi.fn() };
    const view = env.mount(StepInspector).render({ node, routine: { nodes: [node] }, paths: [], acq, robotProject: { catalog: { commands: [scan(), { id: 'aim', label: 'Aim', outputs: [] }] } } });
    return { acq, chooser: view.find((element) => element.type === 'ChoiceBrowser').props, branches: view.find((element) => element.type === 'CommandBranches').props };
  }
  it('sends a command choice to the owner and states its consequence only when steps would be removed', () => {
    let ui = inspector(commandNode());
    expect(ui.chooser.note).toBe('Another command removes 5 branch steps.'); expect(ui.chooser.onChange).toBeUndefined();
    const returned = ['scan', 'aim', ''].map((value) => ui.chooser.onChoose(value));
    expect(returned).toEqual(ui.acq.branch.mock.results.map((result) => result.value)); expect(returned[0]).toBe(ui.acq.branch.mock.results[0].value);
    expect(ui.acq.branch.mock.calls).toEqual([['cmd', { kind: 'keep' }], ['cmd', { kind: 'command', commandId: 'aim' }], ['cmd', { kind: 'command', commandId: '' }]]);
    expect(Object.keys(ui.branches)).toEqual(['node', 'command', 'acq']);
    ui = inspector(commandNode(commandNode().outputBranch.routes.map((route) => ({ ...route, nodes: [] }))));
    expect(ui.chooser.note).toBeUndefined();
  });
});
