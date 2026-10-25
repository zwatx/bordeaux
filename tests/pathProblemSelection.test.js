import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { createPathHoverStore } from '../src/renderer/lib/pathHoverStore';
import { buildTimeline, tAtF } from '../src/renderer/components/pathTimelineModel';

// Exercise the actual component's state/handler wiring without a DOM. Effects flush separately,
// so replacement-result assertions inspect the render before a cleanup effect could mask a flash.
const source = ts.createSourceFile('App.jsx', readFileSync(new URL('../src/renderer/app/App.jsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
const component = ['PathWorkspace','PathBand'].map(name => source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(source)).join('\n');
let keyExpression = 'undefined';
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'h' && node.arguments[0]?.getText(source) === 'PathWorkspace') {
    keyExpression = node.arguments[1].properties.find(property => property.name?.getText(source) === 'key')?.initializer.getText(source) || 'undefined';
  }
  ts.forEachChild(node, visit);
}
visit(source);
const bandKey = new Function('projectKey', 'doc', 'return ' + keyExpression);
function harness({ clock = { request: () => 1, cancel() {} }, Observer = class { observe() {} disconnect() {} } } = {}) {
  const cells = [], effects = [], listeners = new Set();
  let cursor = 0, mountedKey = Symbol('unmounted');
  const preview = { trajectorySamples: [
    { t: 0, f: 0, velocityMps: 0 }, { t: 1, f: 1, velocityMps: 2 },
  ], sample: { pts: [{s:0}, {s:1}] }, prof: { totalTime: 1 } };
  const props = { projectKey: 0, doc: { id: 'a', constraints: { maxVel: 3 } }, robot: { maxSpeed: 4 },
    derived: preview, sel: { kind: null, idx: -1 }, issues: [], flushDraft: vi.fn(() => true), playbackStore: { seek: vi.fn() },
    actions: { select: vi.fn(), addSlowZone: vi.fn() } };
  const useRef = value => cells[cursor++] ||= { current: value };
  const useState = initial => {
    const cell = cells[cursor++] ||= { value: initial };
    return [cell.value, value => { cell.value = typeof value === 'function' ? value(cell.value) : value; }];
  };
  const useMemo = (factory, dependencies) => {
    const cell = cells[cursor++] ||= {};
    if (!cell.dependencies || dependencies.some((value, index) => value !== cell.dependencies[index])) {
      cell.value = factory(); cell.dependencies = dependencies;
    }
    return cell.value;
  };
  const useEffect = (effect, dependencies) => {
    const cell = cells[cursor++] ||= {};
    if (!cell.dependencies || dependencies.some((value, index) => value !== cell.dependencies[index])) {
      cell.dependencies = dependencies;
      effects.push(() => { cell.cleanup?.(); cell.cleanup = effect(); });
    }
  };
  const renderComponent = new Function('React', 'createPathHoverStore', 'document', 'MutationObserver', 'useEditPreview', 'useMemo', 'buildTimeline', 'useRef', 'useState', 'useEffect', 'window', 'h', 'UI', 'PathPanel', 'PathTimeline', 'tAtF', component + '; return { PathWorkspace, PathBand };')(
    { useLayoutEffect: useEffect }, () => createPathHoverStore(clock),
    { querySelector: () => null, body: {} }, Observer,
    () => ({ draft: props.draft ? { ...props.doc, ...props.draft } : null, displayed: { path: props.displayedPath || props.doc, value: props.displayedValue || props.derived }, interactionReady: props.interactionReady !== false }), useMemo, buildTimeline, useRef, useState, useEffect,
    { addEventListener: (_type, fn) => listeners.add(fn), removeEventListener: (_type, fn) => listeners.delete(fn) },
    (type, properties, ...children) => ({ type, props: properties, children }), { Num: 'number' }, 'panel', 'timeline', tAtF);
  const render = updates => {
    Object.assign(props, updates); cursor = 0;
    // Model React's keyed remount using the actual App call site's key expression.
    const nextKey = bandKey(props.projectKey, props.doc);
    if (nextKey !== mountedKey) {
      cells.forEach(cell => cell.cleanup?.()); cells.length = effects.length = 0; mountedKey = nextKey;
    }
    const tree = renderComponent.PathWorkspace({ ...props, children: scene => renderComponent.PathBand({ ...props, ...scene }) }).children[0];
    return { panel: tree.children[0].props, timeline: tree.children[1].props };
  };
  const flush = () => { while (effects.length) effects.shift()(); };
  return { props, render, flush, escape: prevented => listeners.forEach(fn => fn({ key: 'Escape', defaultPrevented: prevented })) };
}
const problems = () => [
  { code: 'linear-acceleration', f0: .1, f1: .2 },
  { code: 'linear-acceleration', f0: .7, f1: .8 },
];
function selected() {
  const ui = harness(), issues = problems();
  ui.render({ issues }); ui.flush();
  ui.render().panel.problems.onSelect(0);
  expect(ui.render().panel.issue).toBe(issues[0]); ui.flush();
  return { ui, issues };
}

describe('displayed planning problem selection', () => {
  it('clears before effects when a new result shifts another same-code issue into its index', () => {
    const { ui, issues } = selected();
    const next = ui.render({ issues: [issues[1]] });
    expect(next.panel.issue).toBeNull(); expect(next.timeline.selectedIssue).toBeNull();
    expect(ui.props.playbackStore.seek).toHaveBeenCalledTimes(1);
    expect(ui.props.actions.addSlowZone).not.toHaveBeenCalled();
  });
  it('keeps the exact shown list selected while fresh timing is pending', () => {
    const { ui, issues } = selected();
    const next = ui.render({ issues: [], timingPending: true });
    expect(next.timeline.issues).toBe(issues); expect(next.panel.issue).toBe(issues[0]);
    expect(next.panel.issueStale).toBe(true);
    expect(ui.render({ issues: problems(), timingPending: false }).panel.issue).toBeNull();
  });
  it('inspects a held problem without seeking through previous timing', () => {
    const { ui, issues } = selected();
    ui.props.playbackStore.seek.mockClear();
    ui.render({ issues: [], timingPending: true }).panel.problems.onSelect(1);
    expect(ui.render().panel.issue).toBe(issues[1]);
    expect(ui.props.playbackStore.seek).not.toHaveBeenCalled();
  });
  it.each([{ draft: { id: 'a' } }, { interactionReady: false }, { stale: true }])('does not seek unmatched or live timing: %j', state => {
    const { ui } = selected(); ui.props.playbackStore.seek.mockClear();
    ui.render(state).panel.problems.onSelect(1);
    expect(ui.props.playbackStore.seek).not.toHaveBeenCalled();
  });
  it('leaves invalid focused drafts in control of problem activation', () => {
    const { ui, issues } = selected(); ui.props.playbackStore.seek.mockClear(); ui.props.actions.select.mockClear();
    ui.props.flushDraft.mockReturnValue(false);
    ui.render().panel.problems.onSelect(1);
    expect(ui.render().panel.issue).toBe(issues[0]);
    expect(ui.props.actions.select).not.toHaveBeenCalled(); expect(ui.props.playbackStore.seek).not.toHaveBeenCalled();
  });
  it('rejects a callback whose list a synchronous draft flush replaced', () => {
    const { ui } = selected(); ui.props.playbackStore.seek.mockClear();
    ui.props.flushDraft.mockImplementation(() => { ui.render({ issues: problems() }); return true; });
    ui.render().panel.problems.onSelect(1);
    expect(ui.render().panel.issue).toBeNull(); expect(ui.props.playbackStore.seek).not.toHaveBeenCalled();
  });
  it('clears on a new result even if it reuses every issue object', () => {
    const { ui, issues } = selected();
    expect(ui.render({ issues: [...issues] }).panel.issue).toBeNull();
  });
  it('does not resurrect a result after comparison hid its list', () => {
    const { ui, issues } = selected();
    expect(ui.render({ issues: [] }).panel.issue).toBeNull(); ui.flush();
    expect(ui.render({ issues }).panel.issue).toBeNull();
  });
  it('does not erase an explicit fresh-result choice when prior cleanup runs', () => {
    const { ui } = selected(), issues = problems();
    ui.render({ issues }).panel.problems.onSelect(1); ui.flush();
    expect(ui.render().panel.issue).toBe(issues[1]);
  });
  it('clears before effects on another path, even if supplied the same issue list', () => {
    const { ui } = selected();
    expect(ui.render({ doc: { ...ui.props.doc, id: 'b' } }).panel.issue).toBeNull();
    ui.flush();
    expect(ui.render({ doc: { ...ui.props.doc, id: 'a' } }).panel.issue).toBeNull();
  });
  it('acquiring an object clears immediately and does not resurrect when deselected', () => {
    const { ui } = selected();
    expect(ui.render({ sel: { kind: 'wp', idx: 1 } }).panel.issue).toBeNull();
    ui.flush();
    expect(ui.render({ sel: { kind: null, idx: -1 } }).panel.issue).toBeNull();
  });
  it('resets for another document with the same path id and shown list', () => {
    const { ui } = selected();
    expect(ui.render({ projectKey: 1 }).panel.issue).toBeNull();
    ui.flush(); expect(ui.render({ projectKey: 0 }).panel.issue).toBeNull();
  });
  it('selects a new result explicitly, and only its explicit fix adds a zone', () => {
    const { ui } = selected(), issues = problems().slice(1);
    ui.render({ issues }).panel.problems.onSelect(0);
    const next = ui.render(); expect(next.panel.issue).toBe(issues[0]);
    next.panel.onFixIssue(next.panel.issue);
    expect(ui.props.actions.addSlowZone).toHaveBeenCalledExactlyOnceWith(.7, .8, expect.any(Number));
    expect(ui.render().panel.issue).toBeNull();
  });
  it('respects owned Escape and clears on the unhandled Escape or clear button', () => {
    const { ui, issues } = selected();
    ui.escape(true); expect(ui.render().panel.issue).toBe(issues[0]);
    ui.escape(false); expect(ui.render().panel.issue).toBeNull();
    ui.render().panel.problems.onSelect(1);
    ui.render().panel.onClearIssue(); expect(ui.render().panel.issue).toBeNull();
  });
});


// Actual owner render/effect boundaries, not a substitute for mounted StrictMode subscription proof.
describe('workspace hover display identity', () => {
  it('retains the same context across unrelated selection renders', () => {
    const ui = harness(), first = ui.render().timeline; ui.flush();
    expect(first.hoverContext.eligible).toBe(true);
    first.hoverStore.setTimeline(first.hoverContext, .5);
    const next = ui.render({ sel: { kind: 'wp', idx: 0 } }).timeline;
    expect(next.hoverContext).toBe(first.hoverContext);
    expect(next.hoverStore).toBe(first.hoverStore);
    ui.flush(); expect(next.hoverStore.getSnapshot()).toMatchObject({ t: .5 });
  });
  it.each([{ draft: { id:'a' } }, { timingPending:true }, { stale:true }, { interactionReady:false },
    { displayedPath:{id:'a'} }, { displayedValue:{sample:{pts:[]},prof:{totalTime:0}} }])('rejects pending, held and mismatched display before effects: %j', change => {
    const ui = harness(), first=ui.render().timeline; ui.flush();
    first.hoverStore.setTimeline(first.hoverContext,.5);
    const next=ui.render(change).timeline;
    expect(next.hoverContext.eligible).toBeFalsy();
    expect(next.hoverContext).not.toBe(first.hoverStore.getSnapshot().context);
    ui.flush(); expect(next.hoverStore.getSnapshot()).toBeNull();
  });
  it('changes identity for fresh derived timing and permits current infeasible timing', () => {
    const ui=harness(), first=ui.render().timeline;ui.flush();
    first.hoverStore.setTimeline(first.hoverContext,.5);
    const next=ui.render({ derived:{...ui.props.derived},issues:problems() }).timeline;
    expect(next.hoverContext.eligible).toBe(true);expect(next.hoverContext).not.toBe(first.hoverContext);
    ui.flush();expect(next.hoverStore.getSnapshot()).toBeNull();
  });
});


// Controlled records exercise the actual owner's observer and real store. Root separately runs real DOM delivery.
describe('workspace hover modal subtree lifecycle', () => {
  function queuedHover() {
    let callback, next = 0;
    const pending = new Map(), retained = [];
    const clock = { request(fn) { retained.push(fn); pending.set(++next, fn); return next; }, cancel(id) { pending.delete(id); } };
    const ui = harness({ clock, Observer: class {
      constructor(fn) { callback = fn; }
      observe() {} disconnect() {}
    } });
    const { hoverStore: store, hoverContext: context } = ui.render().timeline; ui.flush();
    store.setTimeline(context, .5);
    const produce = vi.fn(() => ({ f: [.25], primary: 0 }));
    store.queueField(context, produce);
    return { store, pending, produce, deliver: records => callback(records), forceFrame: () => retained.forEach(fn => fn(0)) };
  }
  const selector = 'dialog:modal, [role="dialog"][aria-modal="true"]';
  const modal = (kind, subtree) => {
    const element = { matches: query => query === selector && (kind === 'dialog' || kind === 'aria-modal'), querySelector: () => null };
    return subtree ? { matches: () => false, querySelector: query => query === selector ? element : null } : element;
  };
  const childList = (addedNodes = [], removedNodes = []) => ({ type: 'childList', addedNodes, removedNodes });
  it.each([['dialog', false], ['dialog', true], ['aria-modal', false], ['aria-modal', true]])(
    'retires queued hover for same-task inserted/removed already-open %s, subtree=%s', (kind, subtree) => {
      const test = queuedHover(), node = modal(kind, subtree);
      test.deliver([childList([node]), childList([], [node])]);
      expect(test.pending.size).toBe(0); expect(test.store.getSnapshot()).toBeNull();
      test.forceFrame(); expect(test.produce).not.toHaveBeenCalled(); expect(test.store.getSnapshot()).toBeNull();
    });
  it.each(['dialog', 'aria-modal'])('retires a %s subtree removed while still open', kind => {
    const test = queuedHover(); test.deliver([childList([], [modal(kind, true)])]);
    expect(test.pending.size).toBe(0); test.forceFrame(); expect(test.produce).not.toHaveBeenCalled();
    expect(test.store.getSnapshot()).toBeNull();
  });
  it('preserves queued field work and timeline data through nonmodal/text churn', () => {
    const test = queuedHover(), node = modal('ordinary', false);
    test.deliver([childList([node, {}]), childList([], [node, {}]), { type: 'attributes', attributeName: 'role', oldValue: 'button' }]);
    expect(test.pending.size).toBe(1); expect(test.store.getSnapshot()).toMatchObject({ source: 'timeline', t: .5 });
    test.forceFrame(); expect(test.produce).toHaveBeenCalledOnce();
    expect(test.store.getSnapshot()).toMatchObject({ source: 'field', f: [.25] });
  });
  it.each([['open', ''], ['aria-modal', 'true']])('retains same-task attribute transition handling for %s', (attributeName, oldValue) => {
    const test = queuedHover(); test.deliver([{ type: 'attributes', attributeName, oldValue }]);
    expect(test.pending.size).toBe(0); test.forceFrame(); expect(test.produce).not.toHaveBeenCalled();
  });
});


describe('problem inspection preflight', () => {
  it('clears existing and queued hover on successful opening without selecting, seeking or fixing', () => {
    let callback;
    const cancel=vi.fn();
    const ui=harness({clock:{request(fn){callback=fn;return 1;},cancel}});
    const scene=ui.render({issues:problems()});ui.flush();
    const {hoverStore,hoverContext}=scene.timeline;
    hoverStore.setTimeline(hoverContext,.5);
    const producer=vi.fn(()=>({f:[.2],primary:0}));hoverStore.queueField(hoverContext,producer);
    expect(scene.panel.problems.onInspect()).toBe(true);expect(hoverStore.getSnapshot()).toBeNull();
    expect(cancel).toHaveBeenCalled();callback(0);expect(producer).not.toHaveBeenCalled();
    expect(ui.props.playbackStore.seek).not.toHaveBeenCalled();expect(ui.props.actions.select).not.toHaveBeenCalled();expect(ui.props.actions.addSlowZone).not.toHaveBeenCalled();
  });
  it('rejects invalid drafts and synchronous replacement before inspecting', () => {
    const ui=harness();const first=ui.render({issues:problems()});ui.flush();
    ui.props.flushDraft.mockReturnValue(false);expect(first.panel.problems.onInspect()).toBe(false);
    ui.props.flushDraft.mockImplementation(()=>{ui.render({issues:problems()});return true;});
    expect(first.panel.problems.onInspect()).toBe(false);expect(ui.props.actions.select).not.toHaveBeenCalled();
  });
  it('inspects and selects a note beyond the field cap using its original held-list index without seek', () => {
    const ui=harness(), list=Array.from({length:16},(_,i)=>({...problems()[0],f0:i/20,f1:(i+1)/20,severity:i===15?'note':'warning'}));
    ui.render({issues:list});ui.flush();const held=ui.render({issues:[],timingPending:true});
    expect(held.panel.problems.onInspect()).toBe(true);expect(held.panel.problems.onSelect(15)).toBe(true);
    expect(ui.render().panel.issue).toBe(list[15]);expect(ui.props.playbackStore.seek).not.toHaveBeenCalled();
  });
});
