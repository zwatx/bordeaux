import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { deletionInput, shiftDeletionInput } from '../src/renderer/components/DeletionNotice';
import { commandArguments } from '../src/renderer/components/ContextInspector';
import { AUTO } from '../src/renderer/lib/routineModel';
import { UnitPrefs } from '../src/renderer/lib/unitPreferences';
import { routinePathUses } from '../src/renderer/lib/routinePathChoices';
import { InsertStrip, SourceLibrary, initialSource } from '../src/renderer/components/RoutineInsert';
import * as commandSearch from '../src/renderer/lib/commandIndex';

// The actual RoutinePanel source runs with minimal hooks (no DOM library is installed). Its row keys, row menu, slot and
// library picks and lane controls are driven directly; the built-app harness covers native focus, pointer and rendering.
function mountPanel(props) {
  const source = readFileSync(new URL('../src/renderer/components/RoutinePanel.jsx', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export function /gm, 'function ')
    + '\nwindow.RoutinePanel = RoutinePanel;';
  const state = { cells: [], cursor: 0, dirty: false, effects: [] };
  const slot = (make) => { const index = state.cursor++; if (!(index in state.cells)) state.cells[index] = make(); return state.cells[index]; };
  const React = {
    Fragment: 'Fragment',
    createElement: (type, elementProps, ...children) => ({ type, props: elementProps || {}, children: children.flat(Infinity).filter((child) => child != null && child !== false && child !== true) }),
    useState: (initial) => {
      const cell = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }));
      return [cell.value, (next) => { const value = typeof next === 'function' ? next(cell.value) : next; if (!Object.is(value, cell.value)) { cell.value = value; state.dirty = true; } }];
    },
    useRef: (current) => slot(() => ({ current })),
    useMemo: (read, deps) => { const cell = slot(() => ({})); if (!cell.deps || deps.some((value, index) => value !== cell.deps[index])) { cell.deps = deps; cell.value = read(); } return cell.value; },
    useEffect: (run, deps) => {
      const cell = slot(() => ({}));
      if (deps && cell.deps && deps.every((value, index) => value === cell.deps[index])) return;
      cell.deps = deps; state.effects.push(() => { if (typeof cell.cleanup === 'function') cell.cleanup(); cell.cleanup = run(); });
    },
  };
  React.useLayoutEffect = React.useEffect;
  const frames = [], inspectors = [];
  const document = { querySelectorAll: (selector) => (selector === '.routine-insp' ? inspectors : []), querySelector: () => null };
  const window = { addEventListener() {}, removeEventListener() {} };
  vm.runInNewContext(source, { React, createPortal: (element) => element, deletionInput, shiftDeletionInput, PointerDrag: { useController: () => ({ start() {}, cancel() {} }) },
    AUTO, UnitPrefs, commandArguments, UI: { Icon: 'Icon' }, Glyph: 'Glyph', ...commandSearch, InsertStrip, SourceLibrary, initialSource, routinePathUses,
    document, window, requestAnimationFrame: (callback) => frames.push(callback), setTimeout, clearTimeout, CSS: { escape: String } });
  let tree;
  const render = (next) => {
    if (next) props = next;
    for (let pass = 0; pass < 8; pass++) {
      state.cursor = 0; state.dirty = false; state.effects = [];
      tree = window.RoutinePanel(props); state.effects.forEach((run) => run());
      if (!state.dirty) return;
    }
    throw Error('RoutinePanel did not settle');
  };
  const all = (predicate, element = tree) => (!element || typeof element !== 'object' ? []
    : [...(predicate(element) ? [element] : []), ...element.children.flatMap((child) => all(predicate, child))]);
  const find = (predicate) => all(predicate)[0] || null;
  const flushFrames = () => { while (frames.length) frames.shift()(); };
  const event = (patch = {}) => ({ key: '', preventDefault: vi.fn(), stopPropagation: vi.fn(), currentTarget: { closest: () => ({ querySelector: () => ({ more: true }) }) }, ...patch });
  render();
  return {
    render, find, all, flushFrames, event, inspectors, get props() { return props; },
    row: (id) => find((element) => element.props['data-nav'] === 'row:' + id),
    strip: () => find((element) => element.type === InsertStrip),
    library: () => find((element) => element.type === SourceLibrary),
    rowMenu: () => find((element) => Array.isArray(element.props.items) && element.props.anchor),
    radio: (label) => find((element) => element.type === 'input' && element.props['aria-label'] === 'Preview ' + label + ' route'),
  };
}

const scan = { id: 'scan', label: 'Scan', member: 'Scan.vi', parameters: [{ name: 'speed', label: 'Speed', role: 'argument', schema: { kind: 'number', valueType: 'DBL' }, defaultValue: 1.5 }],
  outputs: [{ name: 'ready', label: 'Ready', schema: { kind: 'boolean', valueType: 'Boolean' } }] };
const aim = { id: 'aim', label: 'Aim', member: 'Aim.vi', parameters: [], outputs: [] };
const catalog = { commands: [scan, aim] };
const wait = (id) => ({ id, type: 'builtin', builtinId: 'bordeaux.wait', arguments: { durationS: 1 } });
const routine = () => ({ id: 'r', name: 'R', nodes: [
  { id: 'p1', type: 'path', ref: 'a' },
  { id: 'c1', type: 'function', cat: 'command', title: 'Scan', invocation: { commandId: 'scan', arguments: { speed: 1.5 } }, outputBranch: { output: 'ready', schema: { kind: 'boolean', valueType: 'Boolean' }, routes: [
    { id: 'r-yes', label: 'Yes', operator: 'eq', value: true, nodes: [wait('yes-wait')] },
    { id: 'r-no', label: 'No', operator: 'eq', value: false, nodes: [] }] } },
  { id: 'c2', type: 'function', cat: 'command', title: 'Scan', invocation: { commandId: 'scan', arguments: { speed: 1.5 } } },
  { id: 'c3', type: 'function', cat: 'command', title: 'Aim', invocation: { commandId: 'aim', arguments: {} } },
  wait('w1')] });
function panel(extra = {}) {
  const source = extra.routine || routine();
  const acq = { outcomes: {}, edit: vi.fn((operation) => AUTO.editRoutine(source, operation)), del: vi.fn(), set: vi.fn(), setOutcome: vi.fn(), ...extra.acq };
  const run = AUTO.buildRun(source, [], {}, acq.outcomes, 'profiledSpline', catalog, { status: 'pending', values: {} });
  const onSelect = vi.fn();
  const sourceApi = { current: null };
  const ui = mountPanel({ routine: source, run, paths: [{ id: 'a', name: 'Approach' }, { id: 'b', name: 'Back' }], selId: null, onSelect, acq, time: 0, running: false, catalog, sourceApi, ...extra.props });
  ui.sourceApi = sourceApi;
  return { ui, acq, onSelect, source };
}

const commandItem = (command) => ({ kind: 'command', command, label: command.label, key: 'command:' + command.id });
const step = (ui, kind) => ui.strip().props.steps.find((item) => item.kind === kind);

describe('routine Add: a slot in the flow and a source library', () => {
  it('Shift+A opens a slot before the step whose strip lists the routine’s own steps, and its library adds a bound command', () => {
    const { ui, acq, source } = panel();
    ui.row('w1').props.onKeyDown(ui.event({ key: 'A', shiftKey: true }));
    ui.render();
    const strip = ui.strip().props;
    expect([strip.label, strip.dest, strip.allowPath, strip.persistent]).toEqual(['Add a step before this one', 'Before “Wait”', true, undefined]);
    // Steps are actions on the strip; commands and paths come from the library, and branching is never an Add item.
    expect(strip.steps.map((item) => item.label)).toEqual(['Wait', 'Repeat', 'Parallel group', 'Sequential group', 'End routine']);
    expect(strip.steps.map((item) => item.kind)).not.toContain('command');
    // The slot opens on the library used last; Command switches it.
    expect(ui.library().props).toMatchObject({ kind: 'path', mode: 'insert', title: 'Add path', dest: 'Before “Wait”' });
    strip.onSource('command', { focus: true }); ui.render();
    expect(ui.library().props).toMatchObject({ kind: 'command', title: 'Add command', autoFocus: true, catalog });
    expect(ui.strip().props.source).toBe('command');
    ui.library().props.onPick(commandItem(scan));
    expect(acq.edit).toHaveBeenCalledOnce();
    const [operation] = acq.edit.mock.calls[0];
    expect(operation).toMatchObject({ kind: 'insert', listRef: { kind: 'root' }, index: 4 });
    expect(operation.node).toMatchObject({ type: 'function', cat: 'command', title: 'Scan', invocation: { commandId: 'scan', arguments: commandArguments(scan) } });
    expect(operation.node.outputBranch).toBeUndefined();
    const result = acq.edit.mock.results[0].value;
    expect(result.routine.nodes.map((node) => node.id)).toEqual(['p1', 'c1', 'c2', 'c3', operation.node.id, 'w1']);
    expect(AUTO.analyze(result.routine, [{ id: 'a' }], catalog).filter((issue) => issue.nodeId === operation.node.id)).toEqual([]);
    ui.render(); expect(ui.strip()).toBeNull(); expect(ui.library()).toBeNull();
    expect(source.nodes).toHaveLength(5);
  });

  it('A adds after the step, inside a route as well as at the top level; a path is inserted as a reference', () => {
    const { ui, acq } = panel();
    ui.row('yes-wait').props.onKeyDown(ui.event({ key: 'a' }));
    ui.render();
    expect(ui.strip().props.dest).toBe('After “Wait”');
    ui.strip().props.onPick(step(ui, 'wait'));
    expect(acq.edit.mock.calls[0][0]).toMatchObject({ kind: 'insert', listRef: { kind: 'output', nodeId: 'c1', routeId: 'r-yes' }, index: 1 });
    expect(acq.edit.mock.results[0].value.changed).toBe(true);
    ui.render(); ui.row('p1').props.onKeyDown(ui.event({ key: 'a' })); ui.render();
    ui.library().props.onPick({ kind: 'path', ref: 'b', label: 'Back' });
    expect(acq.edit.mock.calls[1][0]).toMatchObject({ kind: 'insert', listRef: { kind: 'root' }, index: 1, node: { type: 'path', ref: 'b' } });
  });

  it('keeps a command to bind later when no robot code is linked', () => {
    const { ui, acq } = panel({ props: { catalog: null } });
    ui.row('w1').props.onKeyDown(ui.event({ key: 'a' })); ui.render();
    ui.strip().props.onSource('command'); ui.render();
    expect(ui.library().props.catalog).toBeNull();
    ui.library().props.onCommandless();
    expect(acq.edit.mock.calls[0][0].node).toMatchObject({ type: 'function', cat: 'command', title: 'Robot command', invocation: null });
  });

  it('moves focus to the first input of an added command with inputs, and to the new row otherwise', () => {
    const { ui, acq } = panel();
    ui.row('w1').props.onKeyDown(ui.event({ key: 'a' })); ui.render();
    const input = { focus: vi.fn(), scrollIntoView: vi.fn() };
    const added = () => acq.edit.mock.calls.at(-1)[0].node.id;
    ui.library().props.onPick(commandItem(scan));
    ui.inspectors.push({ dataset: { stepId: added() }, querySelector: (selector) => (selector.startsWith('.cmd-parameters') ? input : null) });
    ui.flushFrames();
    expect(input.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    // Aim has no inputs: the inspector is left alone.
    ui.render(); ui.row('w1').props.onKeyDown(ui.event({ key: 'a' })); ui.render();
    ui.library().props.onPick(commandItem(aim));
    ui.inspectors.push({ dataset: { stepId: added() }, querySelector: () => input });
    ui.flushFrames();
    expect(input.focus).toHaveBeenCalledOnce();
  });

  it('keeps the slot open with Ctrl, placing each next pick after the last one and naming what was added', () => {
    // Each edit applies to the routine as last edited, as the app's history does.
    let current = routine();
    const { ui, acq } = panel({ routine: current, acq: { edit: vi.fn((operation) => { const result = AUTO.editRoutine(current, operation); if (result.changed) current = result.routine; return result; }) } });
    ui.row('c3').props.onKeyDown(ui.event({ key: 'a' })); ui.render();
    ui.strip().props.onSource('command'); ui.render();
    const slot = ui.strip().props.key;
    ui.library().props.onPick(commandItem(scan), { keep: true });
    const first = acq.edit.mock.calls[0][0];
    expect(first).toMatchObject({ kind: 'insert', listRef: { kind: 'root' }, index: 4 });
    // The parent re-renders with the edited routine; the slot and its library stay after the new step.
    ui.render({ ...ui.props, routine: acq.edit.mock.results[0].value.routine });
    expect(ui.strip().props).toMatchObject({ dest: 'After “Scan”', added: ['Scan'], source: 'command' });
    // The same slot moves after the new step, so its strip is not remounted and focus stays in the library.
    expect(ui.strip().props.key).toBe(slot);
    expect(ui.library().props.kind).toBe('command');
    ui.strip().props.onPick(step(ui, 'wait'), { keep: true });
    expect(acq.edit.mock.calls[1][0]).toMatchObject({ kind: 'insert', index: 5 });
    ui.render({ ...ui.props, routine: acq.edit.mock.results[1].value.routine });
    expect(ui.strip().props.added).toEqual(['Scan', 'Wait']);
    expect(acq.edit.mock.results[1].value.routine.nodes.map((node) => node.id)).toEqual(['p1', 'c1', 'c2', 'c3', first.node.id, acq.edit.mock.calls[1][0].node.id, 'w1']);
  });

  it('opens the slot in the flow where the step lands: between rows for before and after, in place of a list’s Add line', () => {
    const { ui } = panel();
    const list = () => ui.find((element) => element.props.className === 'rt-list');
    const places = () => list().children.map((child) => child.props.key);
    ui.row('w1').props.onKeyDown(ui.event({ key: 'A', shiftKey: true })); ui.render();
    expect(places()).toEqual(['p1', 'c1', 'c2', 'c3', 'insert', 'w1', 'add:{"kind":"root"}']);
    ui.row('p1').props.onKeyDown(ui.event({ key: 'a' })); ui.render();
    expect(places()).toEqual(['p1', 'insert', 'c1', 'c2', 'c3', 'w1', 'add:{"kind":"root"}']);
    // Only one slot is open; it replaces nothing else and leaves the end line in place.
    expect(ui.all((element) => element.type === InsertStrip)).toHaveLength(1);
    const end = ui.find((element) => element.props['data-nav'] === 'add:{"kind":"root"}');
    end.props.onClick({ currentTarget: end }); ui.render();
    expect(places().includes('insert')).toBe(false);
    const wrap = list().children.at(-1);
    expect(wrap.props.className).toBe('rt-addwrap open');
    expect(wrap.children[0].type).toBe(InsertStrip);
    expect(ui.find((element) => element.props['data-nav'] === 'add:{"kind":"root"}')).toBeNull();
    // Escape returns focus to the Add line once it renders again; the library closes with the slot.
    ui.strip().props.onClose(true); ui.render();
    expect(ui.strip()).toBeNull(); expect(ui.library()).toBeNull();
    expect(ui.find((element) => element.props['data-nav'] === 'add:{"kind":"root"}')).not.toBeNull();
  });

  it('shows an empty routine’s first step slot without opening a library, and a keep-open pick leaves the slot after the new step', () => {
    let current = { id: 'r', name: 'R', nodes: [] };
    const { ui, acq } = panel({ routine: current, acq: { edit: vi.fn((operation) => { const result = AUTO.editRoutine(current, operation); if (result.changed) current = result.routine; return result; }) } });
    expect(ui.strip().props).toMatchObject({ persistent: true, source: null, label: 'Add the first step', dest: 'First step of the routine' });
    expect(ui.library()).toBeNull();
    // Its library opens on demand and closes back to the slot.
    ui.strip().props.onSource('path', { focus: true }); ui.render();
    expect(ui.library().props).toMatchObject({ kind: 'path', dest: 'First step of the routine' });
    ui.library().props.onClose(true); ui.render();
    expect(ui.library()).toBeNull(); expect(ui.strip().props.persistent).toBe(true);
    ui.strip().props.onPick(step(ui, 'wait'), { keep: true });
    expect(acq.edit.mock.calls[0][0]).toMatchObject({ kind: 'insert', listRef: { kind: 'root' }, index: 0 });
    ui.render({ ...ui.props, routine: current });
    expect(ui.strip().props).toMatchObject({ persistent: undefined, dest: 'At the end of the routine', added: ['Wait'] });
    const list = ui.find((element) => element.props.className === 'rt-list');
    expect(list.children.map((child) => child.props.key)).toEqual([current.nodes[0].id, 'add:{"kind":"root"}']);
    // A plain pick from the first step's slot closes it and the routine's own Add line follows the new step.
    const fresh = panel({ routine: { id: 'r2', name: 'R', nodes: [] } });
    fresh.ui.strip().props.onPick(step(fresh.ui, 'repeat'));
    expect(fresh.acq.edit.mock.calls[0][0]).toMatchObject({ kind: 'insert', listRef: { kind: 'root' }, index: 0, node: { type: 'repeat' } });
  });

  it('names the steps a new one runs alongside inside a parallel group, where only commands are offered', () => {
    const source = { id: 'r', name: 'R', nodes: [{ id: 'g', type: 'group', mode: 'parallel', nodes: [
      { id: 'g1', type: 'function', cat: 'command', title: 'Scan', invocation: { commandId: 'scan', arguments: { speed: 1.5 } } },
      { id: 'g2', type: 'function', cat: 'command', title: 'Aim', invocation: { commandId: 'aim', arguments: {} } }] }] };
    const { ui } = panel({ routine: source });
    ui.row('g2').props.onKeyDown(ui.event({ key: 'a' })); ui.render();
    expect(ui.strip().props).toMatchObject({ dest: 'After “Aim” · runs alongside Scan and Aim', allowPath: false, source: 'command' });
    expect(ui.strip().props.steps.map((item) => item.kind)).toEqual(['wait', 'group', 'group']);
    expect(ui.library().props.usage.order).toEqual(['scan', 'aim']);
  });

  it('offers Add before, Add after and Branch on output in the row menu, each through the checked insert or the inspector', () => {
    const { ui, onSelect } = panel();
    const open = (id) => { ui.row(id).props.onKeyDown(ui.event({ key: 'F10', shiftKey: true })); ui.render(); return ui.rowMenu().props.items; };
    const labels = (id) => open(id).map((item) => item.label);
    expect(labels('c2')).toEqual(expect.arrayContaining(['Add step after', 'Add step before', 'Branch on output…']));
    expect(labels('c1')).toContain('Change branch output…');
    expect(labels('c3')).not.toContain('Branch on output…');
    expect(labels('p1')).not.toContain('Branch on output…');
    expect(open('c2').find((item) => item.key === 'addBefore').hint).toBe('⇧A');
    // Branch on output selects the command and focuses its inspector's output choice once that inspector renders.
    const target = { focus: vi.fn(), scrollIntoView: vi.fn() };
    ui.inspectors.push({ dataset: { stepId: 'c2' }, querySelector: (selector) => (selector === '#command-branch-output' ? target : null), querySelectorAll: () => [] });
    open('c2').find((item) => item.key === 'branch').run();
    expect(onSelect).toHaveBeenLastCalledWith('c2');
    ui.flushFrames();
    expect(target.focus).toHaveBeenCalledOnce(); expect(target.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    // Add step before lands at the step's own index in its list.
    open('c3').find((item) => item.key === 'addBefore').run(); ui.render();
    expect(ui.strip().props.dest).toBe('Before “Aim”');
  });

  it('changes a path step’s reference from the same path library, marking the step and returning focus to Change', () => {
    const { ui, acq } = panel();
    const origin = { isConnected: true, focus: vi.fn() };
    ui.sourceApi.current.changePath('p1', origin); ui.render();
    expect(ui.library().props).toMatchObject({ kind: 'path', mode: 'replace', title: 'Change path', current: 'a', dest: 'Replacing “Approach”', autoFocus: true });
    expect(ui.find((element) => element.props['data-id'] === 'p1').props.className).toContain('replacing');
    expect(ui.strip()).toBeNull();
    // The same path changes nothing; another one replaces only the reference, as one checked step edit.
    ui.library().props.onPick({ kind: 'path', ref: 'a' }); ui.render(); ui.flushFrames();
    expect(acq.set).not.toHaveBeenCalled(); expect(origin.focus).toHaveBeenCalledOnce(); expect(ui.library()).toBeNull();
    ui.sourceApi.current.changePath('p1', origin); ui.render();
    ui.library().props.onPick({ kind: 'path', ref: 'b' });
    expect(acq.set).toHaveBeenCalledExactlyOnceWith('p1', { ref: 'b' });
    // Opening a slot replaces a pending change; Escape from the change returns to its origin.
    ui.render(); ui.sourceApi.current.changePath('p1', origin); ui.render();
    ui.row('w1').props.onKeyDown(ui.event({ key: 'a' })); ui.render();
    expect(ui.library().props.mode).toBe('insert');
    expect(ui.find((element) => element.props['data-id'] === 'p1').props.className).not.toContain('replacing');
  });
});

describe('routine branch lanes', () => {
  it('opens the route editor from a lane header and leaves the preview to the lane radio', () => {
    const { ui, acq, onSelect } = panel();
    expect([ui.radio('Yes').props.checked, ui.radio('No').props.checked]).toEqual([true, false]);
    expect(ui.radio('Yes').props).toMatchObject({ type: 'radio', name: 'rt-preview-c1', tabIndex: -1 });
    // The lane header row holding the No radio, and its header button.
    const lane = ui.all((element) => String(element.props.className).startsWith('rt-route')).find((element) => ui.all((child) => child === ui.radio('No'), element).length);
    const button = ui.all((element) => element.props.className === 'rt-brlbl', lane)[0];
    expect(button.props).not.toHaveProperty('role'); expect(button.props.title).toBe('Edit this route');
    const routeEditors = [{ dataset: { routeEditor: 'r-yes' }, focus: vi.fn(), scrollIntoView: vi.fn() }, { dataset: { routeEditor: 'r-no' }, focus: vi.fn(), scrollIntoView: vi.fn() }];
    const listeners = {};
    ui.inspectors.push({ dataset: { stepId: 'c1' }, querySelector: () => null, querySelectorAll: (selector) => (selector === '[data-route-editor]' ? routeEditors : []),
      contains: () => true, addEventListener: (type, listener) => { listeners[type] = listener; }, removeEventListener: (type) => { delete listeners[type]; } });
    const origin = { isConnected: true, focus: vi.fn() };
    button.props.onClick({ currentTarget: origin });
    expect(onSelect).toHaveBeenLastCalledWith('c1'); expect(acq.setOutcome).not.toHaveBeenCalled();
    ui.flushFrames();
    expect(routeEditors[1].focus).toHaveBeenCalledOnce(); expect(routeEditors[0].focus).not.toHaveBeenCalled();
    // Escape inside a field keeps its own meaning; Escape from the route block returns once to the lane that opened it.
    listeners.keydown({ key: 'Escape', defaultPrevented: false, target: { closest: () => ({}) }, preventDefault: vi.fn(), stopPropagation: vi.fn() });
    ui.flushFrames(); expect(origin.focus).not.toHaveBeenCalled();
    listeners.keydown({ key: 'Escape', defaultPrevented: false, target: { closest: () => null }, preventDefault: vi.fn(), stopPropagation: vi.fn() });
    ui.flushFrames(); expect(origin.focus).toHaveBeenCalledOnce(); expect(listeners.keydown).toBeUndefined();
    // ArrowRight from the header reaches its radio; the radio alone changes the preview route.
    const radioNode = { focus: vi.fn() };
    button.props.onKeyDown(ui.event({ key: 'ArrowRight', currentTarget: { parentElement: { querySelector: (selector) => (selector === '.rt-brprev' ? radioNode : null) } } }));
    expect(radioNode.focus).toHaveBeenCalledOnce();
    ui.radio('No').props.onChange();
    expect(acq.setOutcome).toHaveBeenCalledExactlyOnceWith('c1', 'r-no');
  });

  it('shows the chosen preview route as the checked radio in every lane group', () => {
    const { ui } = panel({ acq: { outcomes: { c1: 'r-no' } } });
    expect([ui.radio('Yes').props.checked, ui.radio('No').props.checked]).toEqual([false, true]);
  });
});
