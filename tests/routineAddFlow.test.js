import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { deletionInput, shiftDeletionInput } from '../src/renderer/components/DeletionNotice';
import { commandArguments } from '../src/renderer/components/ContextInspector';
import { AUTO } from '../src/renderer/lib/routineModel';
import { UnitPrefs } from '../src/renderer/lib/unitPreferences';
import { enabledPickerIndex, filterPickerItems, pickerPage, PICKER_PAGE_SIZE } from '../src/renderer/lib/pickerSearch';
import { routinePathChoices, routinePathUses } from '../src/renderer/lib/routinePathChoices';
import * as commandSearch from '../src/renderer/lib/commandIndex';

// The actual RoutinePanel source runs with minimal hooks (no DOM library is installed). Its row keys, row menu, Add
// picks and lane controls are driven directly; the built-app harness covers native focus, pointer and rendering.
function mountPanel(props) {
  const source = readFileSync(new URL('../src/renderer/components/RoutinePanel.jsx', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export function /gm, 'function ')
    + '\nwindow.RoutinePanel = RoutinePanel; window.AddMenu = AddMenu;';
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
  const window = {};
  vm.runInNewContext(source, { React, createPortal: (element) => element, deletionInput, shiftDeletionInput, PointerDrag: { useController: () => ({ start() {}, cancel() {} }) },
    AUTO, UnitPrefs, commandArguments, UI: { Icon: 'Icon' }, ...commandSearch, modifierName: () => 'Ctrl', enabledPickerIndex, filterPickerItems, pickerPage, PICKER_PAGE_SIZE, routinePathChoices, routinePathUses,
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
    addMenu: () => find((element) => element.type === window.AddMenu),
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
  const acq = { outcomes: {}, edit: vi.fn((operation) => AUTO.editRoutine(source, operation)), del: vi.fn(), setOutcome: vi.fn(), ...extra.acq };
  const run = AUTO.buildRun(source, [], {}, acq.outcomes, 'profiledSpline', catalog, { status: 'pending', values: {} });
  const onSelect = vi.fn();
  const ui = mountPanel({ routine: source, run, paths: [{ id: 'a', name: 'Approach' }], selId: null, onSelect, acq, time: 0, running: false, catalog, ...extra.props });
  return { ui, acq, onSelect, source };
}

describe('routine Add and insertion from the flow', () => {
  it('Shift+A opens Add before the step, and one pick of a catalog command inserts it bound with its default arguments', () => {
    const { ui, acq, source } = panel();
    ui.row('w1').props.onKeyDown(ui.event({ key: 'A', shiftKey: true }));
    ui.render();
    const menu = ui.addMenu().props;
    expect([menu.label, menu.dest]).toEqual(['Add a step before this one', 'Before “Wait”']);
    // Every catalog command is its own choice; branching is not an Add item.
    // The meta line names inputs and the outputs that tell commands apart; a command with neither has none.
    expect(menu.steps.filter((item) => item.group === 'commands').map((item) => [item.label, item.meta])).toEqual([['Scan', 'Speed · reports ready'], ['Aim', '']]);
    expect(menu.steps.map((item) => item.kind)).not.toContain('commandBranch');
    expect(menu.steps.filter((item) => item.group === 'steps').map((item) => item.label)).toEqual(['Wait', 'Repeat', 'Parallel group', 'Sequential group', 'End routine']);
    menu.onPick(menu.steps.find((item) => item.command === scan));
    expect(acq.edit).toHaveBeenCalledOnce();
    const [operation] = acq.edit.mock.calls[0];
    expect(operation).toMatchObject({ kind: 'insert', listRef: { kind: 'root' }, index: 4 });
    expect(operation.node).toMatchObject({ type: 'function', cat: 'command', title: 'Scan', invocation: { commandId: 'scan', arguments: commandArguments(scan) } });
    expect(operation.node.outputBranch).toBeUndefined();
    const result = acq.edit.mock.results[0].value;
    expect(result.routine.nodes.map((node) => node.id)).toEqual(['p1', 'c1', 'c2', 'c3', operation.node.id, 'w1']);
    expect(AUTO.analyze(result.routine, [{ id: 'a' }], catalog).filter((issue) => issue.nodeId === operation.node.id)).toEqual([]);
    ui.render(); expect(ui.addMenu()).toBeNull();
    expect(source.nodes).toHaveLength(5);
  });

  it('A still adds after the step, inside a route as well as at the top level', () => {
    const { ui, acq } = panel();
    ui.row('yes-wait').props.onKeyDown(ui.event({ key: 'a' }));
    ui.render();
    expect(ui.addMenu().props.dest).toBe('After “Wait”');
    ui.addMenu().props.onPick(ui.addMenu().props.steps.find((item) => item.kind === 'wait'));
    expect(acq.edit.mock.calls[0][0]).toMatchObject({ kind: 'insert', listRef: { kind: 'output', nodeId: 'c1', routeId: 'r-yes' }, index: 1 });
    expect(acq.edit.mock.results[0].value.changed).toBe(true);
  });

  it('keeps the unbound Command placeholder when no robot code is linked', () => {
    const { ui, acq } = panel({ props: { catalog: null } });
    ui.row('w1').props.onKeyDown(ui.event({ key: 'a' })); ui.render();
    // It leads the steps, so Add without commands still opens on paths.
    const commands = ui.addMenu().props.steps.filter((item) => item.kind === 'command');
    expect(commands.map((item) => [item.label, item.meta, item.group])).toEqual([['Command', 'Link robot code to list commands', 'steps']]);
    ui.addMenu().props.onPick(commands[0]);
    expect(acq.edit.mock.calls[0][0].node).toMatchObject({ type: 'function', cat: 'command', title: 'Robot command', invocation: null });
  });

  it('moves focus to the first input of an added command with inputs, and to the new row otherwise', () => {
    const { ui, acq } = panel();
    ui.row('w1').props.onKeyDown(ui.event({ key: 'a' })); ui.render();
    const input = { focus: vi.fn(), scrollIntoView: vi.fn() };
    const added = () => acq.edit.mock.calls.at(-1)[0].node.id;
    ui.addMenu().props.onPick(ui.addMenu().props.steps.find((item) => item.command === scan));
    ui.inspectors.push({ dataset: { stepId: added() }, querySelector: (selector) => (selector.startsWith('.cmd-parameters') ? input : null) });
    ui.flushFrames();
    expect(input.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    // Aim has no inputs: the inspector is left alone.
    ui.render(); ui.row('w1').props.onKeyDown(ui.event({ key: 'a' })); ui.render();
    ui.addMenu().props.onPick(ui.addMenu().props.steps.find((item) => item.command === aim));
    ui.inspectors.push({ dataset: { stepId: added() }, querySelector: () => input });
    ui.flushFrames();
    expect(input.focus).toHaveBeenCalledOnce();
  });

  it('Ctrl+Enter adds and keeps Add open, placing each next pick after the last one and naming what was added', () => {
    // Each edit applies to the routine as last edited, as the app's history does.
    let current = routine();
    const { ui, acq } = panel({ routine: current, acq: { edit: vi.fn((operation) => { const result = AUTO.editRoutine(current, operation); if (result.changed) current = result.routine; return result; }) } });
    ui.row('c3').props.onKeyDown(ui.event({ key: 'a' })); ui.render();
    const steps = () => ui.addMenu().props.steps;
    ui.addMenu().props.onPick(steps().find((item) => item.command === scan), { keep: true });
    const first = acq.edit.mock.calls[0][0];
    expect(first).toMatchObject({ kind: 'insert', listRef: { kind: 'root' }, index: 4 });
    // The parent re-renders with the edited routine; Add stays open after the new step.
    ui.render({ ...ui.props, routine: acq.edit.mock.results[0].value.routine });
    expect(ui.addMenu().props).toMatchObject({ dest: 'After “Scan”', added: ['Scan'] });
    ui.addMenu().props.onPick(steps().find((item) => item.kind === 'wait'), { keep: true });
    expect(acq.edit.mock.calls[1][0]).toMatchObject({ kind: 'insert', index: 5 });
    ui.render({ ...ui.props, routine: acq.edit.mock.results[1].value.routine });
    expect(ui.addMenu().props.added).toEqual(['Scan', 'Wait']);
    expect(acq.edit.mock.results[1].value.routine.nodes.map((node) => node.id)).toEqual(['p1', 'c1', 'c2', 'c3', first.node.id, acq.edit.mock.calls[1][0].node.id, 'w1']);
  });

  it('opens Add in the flow where the step lands: between rows for before and after, in place of a list’s Add line', () => {
    const { ui } = panel();
    const list = () => ui.find((element) => element.props.className === 'rt-list');
    const places = () => list().children.map((child) => child.props.key);
    ui.row('w1').props.onKeyDown(ui.event({ key: 'A', shiftKey: true })); ui.render();
    expect(places()).toEqual(['p1', 'c1', 'c2', 'c3', 'insert', 'w1', 'add:{"kind":"root"}']);
    ui.row('p1').props.onKeyDown(ui.event({ key: 'a' })); ui.render();
    expect(places()).toEqual(['p1', 'insert', 'c1', 'c2', 'c3', 'w1', 'add:{"kind":"root"}']);
    // Only one Add is open; it replaces nothing else and leaves the end line in place.
    expect(ui.all((element) => element.type === ui.addMenu().type)).toHaveLength(1);
    const end = ui.find((element) => element.props['data-nav'] === 'add:{"kind":"root"}');
    end.props.onClick({ currentTarget: end }); ui.render();
    expect(places().includes('insert')).toBe(false);
    const wrap = list().children.at(-1);
    expect(wrap.props.className).toBe('rt-addwrap open');
    expect(wrap.children[0].type).toBe(ui.addMenu().type);
    expect(ui.find((element) => element.props['data-nav'] === 'add:{"kind":"root"}')).toBeNull();
    // Escape returns focus to the Add line once it renders again.
    ui.addMenu().props.onClose(true); ui.render();
    expect(ui.addMenu()).toBeNull();
    expect(ui.find((element) => element.props['data-nav'] === 'add:{"kind":"root"}')).not.toBeNull();
  });

  it('shows an empty routine’s first step Add without opening it, and a keep-open pick leaves it in place after the new step', () => {
    let current = { id: 'r', name: 'R', nodes: [] };
    const { ui, acq } = panel({ routine: current, acq: { edit: vi.fn((operation) => { const result = AUTO.editRoutine(current, operation); if (result.changed) current = result.routine; return result; }) } });
    expect(ui.addMenu().props).toMatchObject({ persistent: true, inputClass: 'rt-empty-add', label: 'Add the first step', dest: 'First step of the routine' });
    ui.addMenu().props.onPick(ui.addMenu().props.steps.find((item) => item.kind === 'wait'), { keep: true });
    expect(acq.edit.mock.calls[0][0]).toMatchObject({ kind: 'insert', listRef: { kind: 'root' }, index: 0 });
    ui.render({ ...ui.props, routine: current });
    expect(ui.addMenu().props).toMatchObject({ persistent: undefined, dest: 'At the end of the routine', added: ['Wait'] });
    const list = ui.find((element) => element.props.className === 'rt-list');
    expect(list.children.map((child) => child.props.key)).toEqual([current.nodes[0].id, 'add:{"kind":"root"}']);
    // A plain pick from the first step's Add closes it and the routine's own Add line follows the new step.
    const fresh = panel({ routine: { id: 'r2', name: 'R', nodes: [] } });
    fresh.ui.addMenu().props.onPick(fresh.ui.addMenu().props.steps.find((item) => item.kind === 'repeat'));
    expect(fresh.acq.edit.mock.calls[0][0]).toMatchObject({ kind: 'insert', listRef: { kind: 'root' }, index: 0, node: { type: 'repeat' } });
  });

  it('names the steps a new one runs alongside inside a parallel group', () => {
    const source = { id: 'r', name: 'R', nodes: [{ id: 'g', type: 'group', mode: 'parallel', nodes: [
      { id: 'g1', type: 'function', cat: 'command', title: 'Scan', invocation: { commandId: 'scan', arguments: { speed: 1.5 } } },
      { id: 'g2', type: 'function', cat: 'command', title: 'Aim', invocation: { commandId: 'aim', arguments: {} } }] }] };
    const { ui } = panel({ routine: source });
    ui.row('g2').props.onKeyDown(ui.event({ key: 'a' })); ui.render();
    expect(ui.addMenu().props.dest).toBe('After “Aim” · runs alongside Scan and Aim');
    expect(ui.addMenu().props.usage.order).toEqual(['scan', 'aim']);
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
    expect(ui.addMenu().props.dest).toBe('Before “Aim”');
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
