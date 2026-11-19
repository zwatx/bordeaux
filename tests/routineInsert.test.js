import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import * as commandSearch from '../src/renderer/lib/commandIndex';
import * as sources from '../src/renderer/lib/routineSources';
import { addMenuSteps } from '../src/renderer/components/RoutinePanel';
import { commandCatalog187 } from './fixtures/commandCatalog187';

const { commandIndex, commandUsage } = commandSearch;
const { commandSourceRows, pathSourceRows, pathSketch, commandGroupKey, GROUP_LIMIT, SEARCH_LIMIT, OTHER } = sources;

describe('path library rows', () => {
  const folders = [{ id: 'autos', name: 'Autos' }, { id: 'empty', name: 'Empty' }, { id: 'score', name: 'Scoring' }];
  const wp = (count) => Array.from({ length: count }, (_, index) => ({ x: 1 + index, y: 1 + index }));
  const paths = [
    { id: 'a', name: 'Left start to note', folderId: 'autos', waypoints: wp(3) },
    { id: 'loose', name: 'Loose return', waypoints: wp(2) },
    { id: 'b', name: 'Amp cycle', folderId: 'score', waypoints: wp(4) },
    { id: 'c', name: 'Center line sweep', folderId: 'autos', waypoints: wp(1) },
    { id: 'gone-folder', name: 'Orphan', folderId: 'deleted', waypoints: wp(2) },
  ];
  const times = { a: { status: 'ready', seconds: 3.456 }, b: { status: 'pending' }, loose: { status: 'ready', seconds: 1.2 } };
  it('follows the project library: folders in their order, empty folders skipped, then paths without a folder', () => {
    const rows = pathSourceRows(paths, { folders, times, uses: new Map([['a', 2]]) });
    expect(rows.map((row) => row.key)).toEqual(['folder:autos', 'path:a', 'path:c', 'folder:score', 'path:b', 'label:loose', 'path:loose', 'path:gone-folder']);
    expect(rows[0]).toMatchObject({ type: 'group', label: 'Autos', count: 2, open: true });
    // Times read as the library shows them; a path without two waypoints says it is not timed, a pending one says nothing.
    expect(rows.filter((row) => row.type === 'item').map((row) => [row.ref, row.time, row.uses, row.depth || 0])).toEqual([
      ['a', '3.46 s', 2, 1], ['c', 'Not timed yet', 0, 1], ['b', '', 0, 1], ['loose', '1.20 s', 0, 0], ['gone-folder', '', 0, 0]]);
    // Paths are references: an item carries only the path id it would insert.
    expect(rows[1]).toMatchObject({ kind: 'path', ref: 'a', label: 'Left start to note' });
  });
  it('closes folders, marks the current path, and ranks a search across names and folder names', () => {
    const rows = pathSourceRows(paths, { folders, times, closed: new Set(['autos']), current: 'b' });
    expect(rows.map((row) => row.key).slice(0, 3)).toEqual(['folder:autos', 'folder:score', 'path:b']);
    expect(rows[0].open).toBe(false);
    expect(rows.find((row) => row.key === 'path:b').current).toBe(true);
    const found = pathSourceRows(paths, { folders, times, query: 'amp' });
    expect(found.map((row) => [row.ref, row.folder])).toEqual([['b', 'Scoring']]);
    // A folder name finds its paths; a search is one list whose rows name their folder.
    expect(pathSourceRows(paths, { folders, times, query: 'autos' }).map((row) => row.ref)).toEqual(['a', 'c']);
    // Without folders there is no "Not in a folder" label.
    expect(pathSourceRows([paths[1]], {}).map((row) => row.key)).toEqual(['path:loose']);
  });
  it('sketches a path inside a field-shaped box, and nothing for a path without a segment', () => {
    const points = pathSketch({ waypoints: [{ x: 0, y: 0 }, { x: 16.541, y: 8.069 }, { x: 40, y: -3 }] }).split(' ').map((point) => point.split(',').map(Number));
    expect(points).toEqual([[0, 18], [36, 0], [36, 18]]);
    expect(pathSketch({ waypoints: [{ x: 1, y: 1 }] })).toBe('');
  });
});

describe('command library rows with a 187-command catalog', () => {
  const index = commandIndex(commandCatalog187.commands);
  const routine = { nodes: [{ id: 'a', type: 'function', cat: 'command', invocation: { commandId: 'vi.intake-intake-until-note' } }, { id: 'b', type: 'function', cat: 'command', invocation: { commandId: 'vi.shooter-shooter-spin-up-speaker' } }] };
  const usage = commandUsage([{ id: 'other', nodes: [{ id: 'c', type: 'function', cat: 'command', invocation: { commandId: 'vi.shooter-shooter-shoot-when-ready' } }] }], [], routine);
  const names = (rows) => rows.filter((row) => row.type !== 'label').map((row) => row.type === 'item' ? row.name : row.label);
  it('browses this routine’s commands, then every subsystem closed with its count, diagnostics last and dimmed', () => {
    const rows = commandSourceRows(index, { usage });
    expect(rows[0]).toMatchObject({ type: 'label', label: 'In this routine' });
    expect(names(rows)).toEqual(['Intake Until Note', 'Shooter Spin Up Speaker',
      'Arm', 'Climber', 'Drive', 'Elevator', 'Indexer', 'Intake', 'LEDs', 'Shooter', 'Superstructure', 'Utilities', 'Vision', 'SysId', 'Test']);
    const test = rows.find((row) => row.key === 'subsystem:test');
    expect(test).toMatchObject({ open: false, count: 12, dim: true, note: 'diagnostics' });
    // The meta line carries named inputs with units and distinctive outputs, never the universal completion status.
    expect(rows[1].meta).toBe('Timeout s · reports has note');
  });
  it('opens a subsystem in place: used commands first, short names, and the full name kept', () => {
    const rows = commandSourceRows(index, { usage, open: new Set(['shooter']) });
    const at = rows.findIndex((row) => row.key === 'subsystem:shooter');
    const inside = rows.slice(at + 1, at + 4);
    expect(inside.map((row) => [row.name, row.label, row.depth])).toEqual([
      ['Spin Up Speaker', 'Shooter Spin Up Speaker', 1], ['Shoot When Ready', 'Shooter Shoot When Ready', 1], ['Spin Up', 'Shooter Spin Up', 1]]);
    expect(rows[at]).toMatchObject({ open: true, count: 27 });
    expect(rows[at + 28].key).toBe('subsystem:superstructure');
  });
  it('ranks a search as one list that keeps subsystem names, with old copies and diagnostics last', () => {
    const shoot = commandSourceRows(index, { usage, query: 'shoot' }).map((row) => row.label);
    // Shoot When Ready is used elsewhere in the project, so it edges ahead of equally good name matches.
    expect(shoot.slice(0, 3)).toEqual(['Shooter Shoot When Ready', 'Shooter Shoot', 'Shoot Preload']);
    expect(shoot.indexOf('Shooter Shoot v2')).toBeGreaterThan(shoot.indexOf('Shooter Shoot From Stage'));
    expect(commandSourceRows(index, { query: 'ssus' }).map((row) => row.label)).toEqual(['Shooter Spin Up Speaker']);
    expect(commandSourceRows(index, { query: 'motor' }).every((row) => row.label.startsWith('Test '))).toBe(true);
    expect(commandSourceRows(index, { query: 'nothing like this' })).toEqual([]);
  });
  it('lists a small catalog directly and opens on the subsystem of a current command', () => {
    const small = commandIndex(commandCatalog187.commands.slice(0, 10));
    expect(commandSourceRows(small, {}).every((row) => row.type === 'item')).toBe(true);
    expect(commandGroupKey(index, 'vi.shooter-shooter-spin-up-speaker')).toBe('shooter');
    expect(commandGroupKey(index, 'missing')).toBeNull();
  });
});

describe('command library with 10,000 commands', () => {
  const commands = Array.from({ length: 10000 }, (_, n) => ({ id: 'c' + n, label: 'Group' + (n % 4) + ' Action ' + n, member: 'Group' + (n % 4) + '/Action ' + n + '.vi', parameters: [], outputs: [] }));
  commands.push({ id: 'solo', label: 'Lonely', member: 'Solo/Lonely.vi', parameters: [], outputs: [] });
  const index = commandIndex(commands);
  it('bounds an open subsystem and a search, each with a row that shows the next batch', () => {
    const open = commandSourceRows(index, { open: new Set(['group0']) });
    const group = open.filter((row) => row.depth === 1);
    expect(group.filter((row) => row.type === 'item')).toHaveLength(GROUP_LIMIT);
    expect(group.at(-1)).toMatchObject({ type: 'more', scope: 'group0', label: 'Show 50 more', remaining: 2500 - GROUP_LIMIT });
    expect(commandSourceRows(index, { open: new Set(['group0']), limits: new Map([['group0', 2500]]) }).some((row) => row.type === 'more')).toBe(false);
    const found = commandSourceRows(index, { query: 'action 1' });
    expect(found.filter((row) => row.type === 'item')).toHaveLength(SEARCH_LIMIT);
    expect(found.at(-1)).toMatchObject({ type: 'more', scope: '' });
    // A one-command subsystem is listed under Other commands.
    expect(commandSourceRows(index, {}).at(-1)).toMatchObject({ type: 'group', id: OTHER, label: 'Other commands', count: 1 });
    expect(commandSourceRows(index, { open: new Set([OTHER]) }).at(-1)).toMatchObject({ type: 'item', name: 'Lonely' });
  });
});

// Execute the actual strip and library with minimal hooks (no DOM library is installed). Native focus, row arrows,
// pointer and rendering are covered by the built-app harnesses.
function mount(name, initial) {
  const source = readFileSync(new URL('../src/renderer/components/RoutineInsert.jsx', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export (function|const|let) /gm, '$1 ') + '\nwindow.' + name + ' = ' + name + ';';
  const state = { cells: [], cursor: 0, dirty: false, effects: [] };
  const slot = (make) => { const index = state.cursor++; if (!(index in state.cells)) state.cells[index] = make(); return state.cells[index]; };
  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter((child) => child != null && child !== false && child !== true && child !== '') }),
    useState: (initialValue) => {
      const cell = slot(() => ({ value: typeof initialValue === 'function' ? initialValue() : initialValue }));
      return [cell.value, (next) => { const value = typeof next === 'function' ? next(cell.value) : next; if (!Object.is(value, cell.value)) { cell.value = value; state.dirty = true; } }];
    },
    useRef: (current) => slot(() => ({ current })),
    useMemo: (read, deps) => { const cell = slot(() => ({})); if (!cell.deps || deps.some((value, index) => value !== cell.deps[index])) { cell.deps = deps; cell.value = read(); } return cell.value; },
    useEffect: (run, deps) => { const cell = slot(() => ({})); if (deps && cell.deps && deps.every((value, index) => value === cell.deps[index])) return; cell.deps = deps; state.effects.push(run); },
  };
  React.useLayoutEffect = React.useEffect;
  const window = {}, focused = vi.fn();
  vm.runInNewContext(source, { React, UI: { Icon: 'Icon' }, Glyph: 'Glyph', modifierName: () => 'Ctrl', ...commandSearch, ...sources, window, Math, requestAnimationFrame: (run) => run(), Set, Map });
  let props = initial, tree;
  const render = (next) => {
    if (next) props = next;
    for (let pass = 0; pass < 8; pass++) { state.cursor = 0; state.dirty = false; state.effects = []; tree = window[name](props); state.effects.forEach((run) => run()); if (!state.dirty) return; }
    throw Error(name + ' did not settle');
  };
  render();
  const all = (predicate, node = tree) => (!node || typeof node !== 'object' ? [] : [...(predicate(node) ? [node] : []), ...node.children.flatMap((child) => all(predicate, child))]);
  const text = (node) => (typeof node === 'object' ? node.children.map(text).join('') : String(node));
  const event = (key, patch = {}) => { const result = { key, repeat: false, defaultPrevented: false, preventDefault() { result.defaultPrevented = true; }, stopPropagation() {}, ...patch }; return result; };
  return { render, all, text, focused, get tree() { return tree; }, event,
    key: (key, patch) => { const result = event(key, patch); tree.props.onKeyDown(result); render(); return result; } };
}

describe('insertion strip', () => {
  const steps = (where = { list: { kind: 'root' } }, routine = { nodes: [] }) => addMenuSteps(routine, where, null).filter((item) => item.group === 'steps' && item.kind !== 'command');
  const strip = (patch = {}) => {
    const props = { steps: steps(), allowPath: true, source: 'path', onSource: vi.fn(), onPick: vi.fn(), onClose: vi.fn(), focusLibrary: vi.fn(), label: 'Add a step after this one', dest: 'After “Wait”', added: [], ...patch };
    return { props, view: mount('InsertStrip', props) };
  };
  const actions = (view) => view.all((node) => node.props['data-action']).map((node) => [node.props['data-action'], node.props['aria-keyshortcuts']]);
  it('offers Path and Command, then the routine’s own steps, each with its letter', () => {
    const { view } = strip();
    expect(actions(view)).toEqual([['path', 'P'], ['command', 'C'], ['wait', 'W'], ['repeat', 'R'], ['group:parallel', 'G'], ['group:sequential', 'S'], ['end', 'E']]);
    expect(view.tree.props).toMatchObject({ role: 'toolbar', 'aria-label': 'Add a step after this one' });
    const path = view.all((node) => node.props['data-action'] === 'path')[0];
    expect(path.props).toMatchObject({ 'aria-pressed': true, tabIndex: 0, 'aria-controls': 'rt-source' });
    // Inside a group there is no Path, Repeat or End; inside a repeat Exit repeat appears.
    const grouped = strip({ allowPath: false, steps: steps({ list: { kind: 'group', nodeId: 'g' } }, { nodes: [{ id: 'g', type: 'group', mode: 'parallel', nodes: [] }] }), source: 'command' });
    expect(actions(grouped.view).map(([key]) => key)).toEqual(['command', 'wait', 'group:parallel', 'group:sequential']);
    const repeat = strip({ steps: steps({ list: { kind: 'repeat', nodeId: 'r' } }, { nodes: [{ id: 'r', type: 'repeat', times: 2, nodes: [] }] }) });
    expect(actions(repeat.view).at(-1)).toEqual(['exit', 'X']);
  });
  it('acts on letters: sources open their library, steps are added at once, Ctrl+Enter keeps the slot', () => {
    const { props, view } = strip();
    expect(view.key('c').defaultPrevented).toBe(true);
    expect(props.onSource).toHaveBeenLastCalledWith('command', { focus: true });
    view.key('w');
    expect(props.onPick).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'wait' }), undefined);
    view.key('g');
    expect(props.onPick).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'group', mode: 'parallel' }), undefined);
    // The open source moves into its library instead of reopening it.
    view.key('p');
    expect(props.focusLibrary).toHaveBeenCalledOnce();
    // Letters with modifiers and held keys do nothing here.
    view.key('w', { ctrlKey: true }); view.key('w', { repeat: true });
    expect(props.onPick).toHaveBeenCalledTimes(2);
    const keep = strip(), button = keep.view.all((node) => node.props['data-action'] === 'repeat')[0];
    button.props.onClick({ ctrlKey: true });
    expect(keep.props.onPick).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'repeat' }), { keep: true });
  });
  it('moves into the open library with Tab, and Escape or Shift+Tab return to where Add opened', () => {
    const { props, view } = strip();
    expect(view.key('Tab').defaultPrevented).toBe(true);
    expect(props.focusLibrary).toHaveBeenCalledOnce();
    view.key('Tab', { shiftKey: true }); view.key('Escape');
    expect(props.onClose.mock.calls).toEqual([[true], [true]]);
    // The first step's slot stays: Escape closes only its library, and Tab moves on natively.
    const first = strip({ persistent: true });
    first.view.key('Escape');
    expect(first.props.onSource).toHaveBeenCalledExactlyOnceWith(null);
    first.view.render({ ...first.props, source: null });
    expect(first.view.key('Tab').defaultPrevented).toBe(false);
    expect(first.props.onClose).not.toHaveBeenCalled();
    expect(first.view.all((node) => node.props.className === 'rt-slot-x')).toEqual([]);
  });
  it('announces keep-open adds', () => {
    const { view } = strip({ added: ['Wait', 'Repeat'] });
    expect(view.text(view.all((node) => node.props.role === 'status')[0])).toBe('Added Repeat and 1 more. Keep adding, or press Esc when done.');
  });
});

describe('source library', () => {
  const routine = { nodes: [{ id: 'a', type: 'function', cat: 'command', invocation: { commandId: 'vi.shooter-shooter-spin-up-speaker' } }] };
  const library = (patch = {}) => {
    const props = { kind: 'command', title: 'Add command', dest: 'After “Wait”', catalog: commandCatalog187, usage: commandUsage([], [], routine), onPick: vi.fn(), onClose: vi.fn(), onBack: vi.fn(), ...patch };
    return { props, view: mount('SourceLibrary', props) };
  };
  const search = (view) => view.all((node) => node.type === 'input')[0];
  const type = (view, value) => { search(view).props.onChange({ target: { value } }); view.render(); };
  const rows = (view) => view.all((node) => node.props['data-row']);
  it('names what it adds and where, and opens on the routine’s commands and closed subsystems', () => {
    const { view } = library();
    expect(view.tree.props).toMatchObject({ id: 'rt-source', 'aria-label': 'Add command' });
    expect(view.text(view.all((node) => node.type === 'h2')[0])).toBe('Add command');
    expect(view.text(view.all((node) => node.props.className === 'rt-src-dest')[0])).toBe('After “Wait”');
    expect(search(view).props.placeholder).toBe('Find among 187 commands');
    expect(rows(view)[0].props['data-row']).toBe('here:vi.shooter-shooter-spin-up-speaker');
    expect(rows(view)[0].props.tabIndex).toBe(0);
    const arm = rows(view).find((row) => row.props['data-row'] === 'subsystem:arm');
    expect(arm.props['aria-expanded']).toBe(false);
    arm.props.onClick(); view.render();
    expect(rows(view).find((row) => row.props['data-row'] === 'subsystem:arm').props['aria-expanded']).toBe(true);
    expect(rows(view).some((row) => row.props['data-row'] === 'command:vi.arm-arm-stow')).toBe(true);
  });
  it('searches as an accelerator: Enter adds the top match, Ctrl+Enter keeps adding, Escape clears then closes', () => {
    const { props, view } = library();
    type(view, 'leds has');
    const top = rows(view)[0];
    expect(top.props.className).toContain('top');
    search(view).props.onKeyDown(view.event('Enter', { ctrlKey: true })); view.render();
    expect(props.onPick).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'command', key: 'command:vi.leds-leds-has-note' }), { keep: true });
    expect(search(view).props.value).toBe('');
    type(view, 'vision w');
    search(view).props.onKeyDown(view.event('Enter')); view.render();
    expect(props.onPick).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'command:vi.vision-vision-wait-for-target' }), undefined);
    type(view, 'zzz');
    expect(view.text(view.all((node) => node.props.className === 'rt-src-empty')[0])).toBe('No command matches “zzz”.');
    view.key('Escape'); expect(search(view).props.value).toBe('');
    expect(props.onClose).not.toHaveBeenCalled();
    view.key('Escape'); expect(props.onClose).toHaveBeenCalledExactlyOnceWith(true);
    // Shift+Tab from the search returns to the strip.
    search(view).props.onKeyDown(view.event('Tab', { shiftKey: true }));
    expect(props.onBack).toHaveBeenCalledOnce();
  });
  it('picks rows with Enter or a click, toggles groups with arrows, and types into the search from a row', () => {
    const { props, view } = library();
    const row = (key) => rows(view).find((node) => node.props['data-row'] === key);
    row('subsystem:drive').props.onKeyDown(view.event('ArrowRight', { currentTarget: {} })); view.render();
    expect(row('subsystem:drive').props['aria-expanded']).toBe(true);
    row('subsystem:drive').props.onKeyDown(view.event('ArrowLeft', { currentTarget: {} })); view.render();
    expect(row('subsystem:drive').props['aria-expanded']).toBe(false);
    row('here:vi.shooter-shooter-spin-up-speaker').props.onKeyDown(view.event('Enter', { currentTarget: {} }));
    expect(props.onPick).toHaveBeenLastCalledWith(expect.objectContaining({ command: expect.objectContaining({ id: 'vi.shooter-shooter-spin-up-speaker' }) }), undefined);
    row('here:vi.shooter-shooter-spin-up-speaker').props.onClick({ metaKey: true });
    expect(props.onPick).toHaveBeenLastCalledWith(expect.anything(), { keep: true });
    const typed = view.event('s', { currentTarget: {} });
    row('subsystem:drive').props.onKeyDown(typed); view.render();
    expect([typed.defaultPrevented, search(view).props.value]).toEqual([true, 's']);
    // Tab from a row leaves for the strip.
    rows(view)[0].props.onKeyDown(view.event('Tab', { currentTarget: {} }));
    expect(props.onBack).toHaveBeenCalledOnce();
  });
  it('without commands, offers a command to bind later instead of a search', () => {
    const onCommandless = vi.fn(), { view } = library({ catalog: null, onCommandless });
    expect(search(view)).toBeUndefined();
    expect(view.text(view.tree)).toContain('Commands come from linked robot code.');
    view.all((node) => node.type === 'button' && view.text(node) === 'Add a command to bind later')[0].props.onClick();
    expect(onCommandless).toHaveBeenCalledOnce();
    expect(view.text(library({ catalog: { commands: [] } }).view.tree)).toContain('The linked robot code has no commands.');
  });
  it('lists paths by folder with time and use, marks the current path when changing, and never keeps adding then', () => {
    const paths = [{ id: 'a', name: 'Approach', folderId: 'f', waypoints: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }, { id: 'b', name: 'Back', waypoints: [] }];
    const { props, view } = library({ kind: 'path', mode: 'replace', title: 'Change path', current: 'a', paths, pathFolders: [{ id: 'f', name: 'Autos' }],
      pathTimes: { a: { status: 'ready', seconds: 2 } }, uses: new Map([['a', 1]]) });
    expect(rows(view).map((row) => row.props['data-row'])).toEqual(['folder:f', 'path:a', 'path:b']);
    const current = rows(view)[1];
    expect(current.props).toMatchObject({ 'aria-current': true, tabIndex: 0, 'aria-label': 'Approach, 2.00 s · In this routine, current path' });
    expect(view.all((node) => node.props.className === 'rt-src-keys')).toEqual([]);
    rows(view)[2].props.onClick({ ctrlKey: true });
    expect(props.onPick).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'path', ref: 'b' }), undefined);
    expect(search(view).props.placeholder).toBe('Filter 2 paths');
    const empty = library({ kind: 'path', title: 'Add path', paths: [] }).view;
    expect(empty.text(empty.all((node) => node.props.className === 'rt-src-empty')[0])).toBe('No paths yet. Create one in Paths.');
  });
});
