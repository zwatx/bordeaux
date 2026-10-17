import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { plainProblem } from '../src/renderer/components/planProblems';

// Actual component handlers/effects with controlled focus/popover nodes. Native delivery/layout is a separate gate.
const source = ts.createSourceFile('ProblemsMenu.jsx', readFileSync(new URL('../src/renderer/components/ProblemsMenu.jsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
const component = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'ProblemsMenu').getText(source).replace(/^export /, '');
const issues = () => Array.from({ length: 16 }, (_, i) => ({ code: 'linear-acceleration', severity: i === 15 ? 'note' : 'warning', segment: 0, f0: i/20, f1: (i+1)/20 }));
const event = (patch = {}) => ({ button: 0, detail: 1, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...patch });
function harness() {
  const cells = [], effects = [], nodeMap = new Map();
  let cursor = 0, dirty = false, props, tree;
  const document = { body: {}, activeElement: null, querySelectorAll: () => [before, trigger(), after, ...rows()] };
  function node(key) {
    if (!nodeMap.has(key)) nodeMap.set(key, { key, isConnected: true, tabIndex: key.startsWith('row') ? -1 : 0, style: {},
      focus() { document.activeElement = this; }, scrollIntoView: vi.fn(), closest: () => null, getClientRects() { return this.isConnected ? [{}] : []; },
      contains(target) { return target === this || this.key === 'menu' && target?.key.startsWith('row'); },
      getBoundingClientRect: () => key === 'trigger' ? { top: 500, bottom: 526, left: 20 } : { width: 320, height: 320 },
      querySelectorAll: () => rows(), addEventListener: vi.fn(), removeEventListener: vi.fn(), showPopover: vi.fn(), hidePopover: vi.fn(),
    });
    return nodeMap.get(key);
  }
  const before = node('before'), after = node('after'), heading = node('heading');
  const trigger = () => nodeMap.get('trigger'), menu = () => nodeMap.get('menu');
  const rows = () => [...nodeMap.values()].filter(n => n.key.startsWith('row') && n.isConnected);
  const h = (type, properties, ...children) => ({ type, props: properties || {}, children: children.flat(Infinity).filter(Boolean) });
  const React = { Fragment: 'fragment',
    useRef(value) { return cells[cursor++] ||= { current: value }; },
    useId() { return (cells[cursor++] ||= { value: 'problem-test' }).value; },
    useState(initial) { const cell = cells[cursor++] ||= { value: initial }; return [cell.value, value => { cell.value = value; dirty = true; }]; },
    useLayoutEffect(effect, dependencies) {
      const cell = cells[cursor++] ||= {};
      if (!dependencies || !cell.dependencies || dependencies.some((v,i) => v !== cell.dependencies[i])) {
        cell.dependencies = dependencies; effects.push(() => { cell.cleanup?.(); cell.cleanup = effect(); });
      }
    },
  };
  const renderMenu = new Function('React','h','plainProblem','UI','TAB_TARGETS','document','window',component+';return ProblemsMenu;')(
    React,h,plainProblem,{Icon:'icon'},'button,input,select,textarea,a[href],[tabindex],summary',document,
    {innerHeight:720,innerWidth:1100,addEventListener() {},removeEventListener() {}});
  props = { problems: { issues: issues(), selected: null, stale: false, onInspect: vi.fn(() => true), onSelect: vi.fn(() => true) }, waypointCount: 3, heading: {current:heading} };
  function render() {
    let count = 0;
    do {
      if (++count > 10) throw Error('render loop');
      dirty = false; cursor = 0;
      tree = renderMenu(props);
      const seen = new Set();
      function walk(el) {
        if (!el || typeof el !== 'object') return;
        const key = el.props.className === 'problems-trigger' ? 'trigger' : el.props.className === 'problems-menu' ? 'menu'
          : el.props.role === 'menuitemradio' ? 'row'+el.props.key : null;
        if(key) { const n=node(key);seen.add(key);n.isConnected=true;n.props=el.props;n.children=el.children;if(el.props.ref)el.props.ref.current=n; }
        el.children.forEach(walk);
      }
      walk(tree);
      for(const [key,n] of nodeMap) if(['trigger','menu'].includes(key)||key.startsWith('row')) {
        if(!seen.has(key)) { n.isConnected=false;if(document.activeElement===n)document.activeElement=document.body;if(n.props?.ref)n.props.ref.current=null; }
      }
      while(effects.length) effects.shift()();
    } while(dirty);
    return tree;
  }
  const update = patch => { props={...props,problems:{...props.problems,...patch}};return render(); };
  render();
  return { props: () => props.problems, document, before, after, heading, trigger, menu, rows, render, update,
    open() { trigger().props.onKeyDown(event({key:'Enter'}));render(); },
    unmount() { cells.forEach(cell=>cell.cleanup?.()); },
  };
}

describe('Problems menu inspection contract', () => {
  it('lists every original issue including notes and opens on an offscreen selection', () => {
    const ui=harness();ui.update({selected:15});ui.open();
    expect(ui.rows()).toHaveLength(16);expect(ui.document.activeElement).toBe(ui.rows()[15]);
    expect(ui.rows()[15].props['data-severity']).toBe('note');expect(ui.rows()[15].props['aria-checked']).toBe(true);
    expect(ui.rows()[15].props['aria-label']).toContain('16.');expect(ui.rows()[15].props['aria-label']).toContain('75.0–80.0%');
    expect(ui.rows()[15].scrollIntoView).toHaveBeenCalled();
    expect(ui.props().onSelect).not.toHaveBeenCalled();
  });
  it('associates the native popover with its trigger after successful pointer preflight', () => {
    const ui=harness();ui.before.focus();
    ui.update({onInspect:vi.fn(()=>{expect(ui.document.activeElement).toBe(ui.before);return true;})});
    const down=event();ui.trigger().props.onPointerDown(down);ui.render();
    expect(down.preventDefault).toHaveBeenCalledOnce();
    expect(ui.trigger().props.popovertarget).toBe(ui.menu().props.id);
    expect(ui.trigger().props['aria-controls']).toBe(ui.menu().props.id);
    expect(ui.menu().showPopover).toHaveBeenCalledExactlyOnceWith({source:ui.trigger()});
    expect(ui.document.activeElement).toBe(ui.rows()[0]);
    const click=event({detail:1});ui.trigger().props.onClick(click);ui.render();
    expect(click.preventDefault).toHaveBeenCalledOnce();
    expect(ui.menu().isConnected).toBe(true);expect(ui.props().onInspect).toHaveBeenCalledOnce();
  });
  it('preflights pointer opening before focus moves and suppresses the blocked follow-on click', () => {
    const ui=harness(), invalid=ui.before;invalid.focus();
    ui.update({onInspect:vi.fn(()=>{expect(ui.document.activeElement).toBe(invalid);return false;})});
    const press=event();ui.trigger().props.onPointerDown(press);ui.render();
    expect(press.preventDefault).toHaveBeenCalled();expect(ui.document.activeElement).toBe(invalid);expect(ui.menu()).toBeUndefined();
    ui.trigger().props.onClick(event());ui.render();expect(ui.props().onInspect).toHaveBeenCalledTimes(1);
  });
  it('accepts the first assistive click after a selected row unmounts without a physical click', () => {
    const ui=harness();ui.open();
    const row=ui.rows()[13];row.props.onPointerDown(event());ui.render();
    expect(row.isConnected).toBe(false);expect(ui.menu().isConnected).toBe(false);
    ui.trigger().props.onClick(event({detail:0}));ui.render();
    expect(ui.menu().isConnected).toBe(true);expect(ui.props().onInspect).toHaveBeenCalledTimes(2);
    expect(ui.props().onSelect).toHaveBeenCalledExactlyOnceWith(13);
  });
  it('retries preflight on the first assistive click after a canceled trigger press', () => {
    const ui=harness();ui.update({onInspect:vi.fn().mockReturnValueOnce(false).mockReturnValue(true)});
    ui.trigger().props.onPointerDown(event());ui.render();expect(ui.menu()).toBeUndefined();
    // No click follows the canceled press; a later assistive activation is independent.
    ui.trigger().props.onClick(event({detail:0}));ui.render();
    expect(ui.props().onInspect).toHaveBeenCalledTimes(2);expect(ui.menu().isConnected).toBe(true);
  });
  it('rejects opening when a synchronous preflight replaces its captured list', () => {
    const ui=harness();ui.update({onInspect:()=>{ui.update({issues:issues()});return true;}});ui.open();
    expect(ui.menu()).toBeUndefined();
  });
  it('keeps a held array open and preserves position, but permanently retires A → B → A callbacks', () => {
    const ui=harness(), a=ui.props().issues;ui.open();const old=ui.rows()[10].props.onPointerDown;
    ui.rows()[10].focus();ui.menu().scrollTop=180;ui.update({stale:true});
    expect(ui.document.activeElement).toBe(ui.rows()[10]);expect(ui.menu().scrollTop).toBe(180);
    ui.update({issues:issues()});expect(ui.document.activeElement).toBe(ui.trigger());
    ui.update({issues:a});old(event());expect(ui.props().onSelect).not.toHaveBeenCalled();
    ui.open();old(event());expect(ui.props().onSelect).not.toHaveBeenCalled();
  });
  it('closes/focuses only on successful selection and passes the original index exactly once', () => {
    const ui=harness();ui.open();
    const row=ui.rows()[13];row.props.onPointerDown(event());row.props.onClick(event());ui.render();
    expect(ui.props().onSelect).toHaveBeenCalledExactlyOnceWith(13);expect(ui.document.activeElement).toBe(ui.trigger());
    ui.open();ui.update({onSelect:vi.fn(()=>{ui.before.focus();return false;})});
    ui.rows()[4].props.onPointerDown(event());ui.render();expect(ui.menu().isConnected).toBe(true);expect(ui.document.activeElement).toBe(ui.before);
  });
  it('uses a visible heading fallback for empty replacement without stealing outside invalid focus', () => {
    const ui=harness();ui.open();ui.update({issues:[]});expect(ui.document.activeElement).toBe(ui.heading);
    ui.update({issues:issues()});ui.open();ui.before.focus();ui.update({issues:[]});expect(ui.document.activeElement).toBe(ui.before);
  });
  it('navigates without selecting, contains Escape, and continues Tab relative to the trigger', () => {
    const ui=harness();ui.open();ui.menu().props.onKeyDown(event({key:'End'}));expect(ui.document.activeElement).toBe(ui.rows()[15]);
    ui.menu().props.onKeyDown(event({key:'Home'}));expect(ui.document.activeElement).toBe(ui.rows()[0]);expect(ui.props().onSelect).not.toHaveBeenCalled();
    const escape=event({key:'Escape'});ui.menu().props.onKeyDown(escape);ui.render();expect(escape.preventDefault).toHaveBeenCalled();expect(escape.stopPropagation).toHaveBeenCalled();expect(ui.document.activeElement).toBe(ui.trigger());
    ui.open();ui.menu().props.onKeyDown(event({key:'Tab'}));ui.render();expect(ui.document.activeElement).toBe(ui.after);
    ui.open();ui.menu().props.onKeyDown(event({key:'Tab',shiftKey:true}));ui.render();expect(ui.document.activeElement).toBe(ui.before);
  });
  it('owns closed trigger deletion, repeat and composition without opening', () => {
    const ui=harness();ui.trigger().focus();
    for(const patch of [{key:'Delete'},{key:'Backspace'},{key:' ',repeat:true},{key:'Enter',isComposing:true}]) {
      const e=event(patch);ui.trigger().props.onKeyDown(e);expect(e.preventDefault).toHaveBeenCalled();expect(e.stopPropagation).toHaveBeenCalled();
    }
    ui.render();expect(ui.props().onInspect).not.toHaveBeenCalled();expect(ui.menu()).toBeUndefined();
  });
  it.each([
    { nativeEvent: { isComposing: true } },
    { keyCode: 229, nativeEvent: { isComposing: false } },
  ])('contains composition from React keyboard wrappers: %j', wrapper => {
    const ui=harness();ui.trigger().focus();
    for (const key of ['Enter', ' ', 'ArrowDown', 'Process']) {
      const e=event({key,...wrapper});expect(e).not.toHaveProperty('isComposing');
      ui.trigger().props.onKeyDown(e);ui.render();
      expect(e.preventDefault).toHaveBeenCalledOnce();expect(e.stopPropagation).toHaveBeenCalledOnce();
      expect(ui.menu()).toBeUndefined();expect(ui.document.activeElement).toBe(ui.trigger());
    }
    expect(ui.props().onInspect).not.toHaveBeenCalled();
    ui.open();const focused=ui.document.activeElement;
    for (const key of ['Enter', ' ', 'ArrowDown', 'End', 'Escape', 'Tab', 'Process']) {
      const e=event({key,...wrapper});expect(e).not.toHaveProperty('isComposing');
      ui.menu().props.onKeyDown(e);ui.render();
      expect(e.preventDefault).toHaveBeenCalledOnce();expect(e.stopPropagation).toHaveBeenCalledOnce();
      expect(ui.menu().isConnected).toBe(true);expect(ui.document.activeElement).toBe(focused);
    }
    expect(ui.props().onSelect).not.toHaveBeenCalled();
  });
  it('native click-away dismissal preserves the intended outside focus', () => {
    const ui=harness();ui.open();
    const dismiss=ui.menu().addEventListener.mock.calls.find(([type])=>type==='toggle')[1];
    ui.after.focus();dismiss({newState:'closed'});ui.render();
    expect(ui.document.activeElement).toBe(ui.after);expect(ui.menu().isConnected).toBe(false);
  });
  it('retired unmount callbacks cannot activate or restore focus into the old workspace', () => {
    const ui=harness();ui.open();const old=ui.rows()[2].props.onPointerDown;ui.before.focus();ui.unmount();old(event());
    expect(ui.props().onSelect).not.toHaveBeenCalled();expect(ui.document.activeElement).toBe(ui.before);
  });
});
