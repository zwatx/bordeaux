import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { commandChoices, inspectorCommandChoices } from '../src/renderer/lib/commandPick';
import { enabledPickerIndex, filterPickerItems, pickerPage, PICKER_PAGE_SIZE } from '../src/renderer/lib/pickerSearch';
import * as commandSearch from '../src/renderer/lib/commandIndex';
import { addMenuSteps } from '../src/renderer/components/RoutinePanel';
import { commandCatalog187 } from './fixtures/commandCatalog187';

describe('indexed picker search', () => {
  const items = [{ value: 'a', label: 'Alpha', meta: 'Beta', searchText: 'Speed Torque İntake' }, { value: 'b', label: 'ALPHAbeta', meta: 'velocity m/s' }, { value: 'c', label: 'Other' }];
  it.each(['', '  ', 'alpha', 'ALPHA beta', 'speed torque', '  torque   SPEED ', 'm/s', 'İntake', 'absent'])('preserves each search surface and order for %j', query => {
    const substring = query.trim().toLowerCase(), terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const oldDropdown = substring ? items.filter(item => [item.label, item.meta, item.searchText].some(part => String(part || '').toLowerCase().includes(substring))) : items;
    const oldBrowser = items.filter(item => terms.every(term => [item.label, item.meta, item.searchText].join(' ').toLocaleLowerCase().includes(term)));
    expect(filterPickerItems(items, query, 'substring')).toEqual(oldDropdown);
    expect(filterPickerItems(items, query)).toEqual(oldBrowser);
  });
  it('does not reinterpret a cross-field phrase as a Dropdown substring', () => {
    expect(filterPickerItems(items, 'alpha beta', 'substring')).toEqual([]);
    expect(filterPickerItems(items, 'alpha beta')).toEqual([items[0], items[1]]);
    expect(filterPickerItems(items, '')).toBe(items);
  });
  it('indexes once per immutable option snapshot and observes replacement labels', () => {
    const label = vi.fn(() => 'Old label'), snapshot = [{ value: 'a', get label() { return label(); } }];
    expect(filterPickerItems(snapshot, 'old')).toHaveLength(1);
    expect(filterPickerItems(snapshot, 'label')).toHaveLength(1);
    expect(label).toHaveBeenCalledOnce();
    expect(filterPickerItems([{ value: 'a', label: 'New label' }], 'new')).toHaveLength(1);
    expect(filterPickerItems([{ value: 'a', label: 'New label' }], 'old')).toEqual([]);
  });
});

describe('catalog-derived command metadata', () => {
  const make = () => [{ id: 'cmd.a', label: 'Intake', member: 'Intake.vi', description: 'Acquire a piece', ownerType: 'Robot', semanticTags: ['acquire'], parameters: [{ name: 'Speed', label: 'Intake speed', description: 'Measured surface velocity', unit: 'm/s', valueType: 'DBL', role: 'argument' }] }];
  it('reuses rich metadata without losing parameter/tag search or action/missing overlays', () => {
    const commands = make(), first = inspectorCommandChoices(commands, 'cmd.a');
    expect(inspectorCommandChoices(commands, 'cmd.a')).toBe(first);
    expect(filterPickerItems(first, 'surface m/s')).toEqual([first[1]]);
    expect(first[1].searchText).toContain('acquire');
    expect(inspectorCommandChoices(commands, 'cmd.a', 'acquire')[1].badge).toBe('Matches action');
    expect(inspectorCommandChoices(commands, 'cmd.a')[1].badge).toBe('');
    expect(inspectorCommandChoices(commands, 'retired.command')).toMatchObject([{ value: '' }, { value: 'retired.command', label: 'command', badge: 'Missing' }, { value: 'cmd.a' }]);
    expect(inspectorCommandChoices(commands, 'retired.command')).toBe(inspectorCommandChoices(commands, 'retired.command'));
    expect(inspectorCommandChoices([{ ...commands[0], label: 'New intake' }], 'cmd.a')[1].label).toBe('New intake');
  });
  it('keeps path-band No command last, missing commands first, and current choices live', () => {
    const commands = make();
    expect(commandChoices(commands, 'cmd.a')).toBe(commandChoices(commands, 'cmd.a'));
    expect(commandChoices(commands).map(item => item.value)).toEqual(['cmd.a']);
    expect(commandChoices(commands, 'cmd.a').map(item => item.value)).toEqual(['cmd.a', '']);
    expect(commandChoices(commands, 'missing').map(item => item.value)).toEqual(['missing', 'cmd.a', '']);
    expect(commandChoices(commands, 'missing')).toBe(commandChoices(commands, 'missing'));
    expect(commandChoices([{ ...commands[0], label: 'Changed' }], 'cmd.a')[0].label).toBe('Changed');
  });
});

// Execute the actual AddMenu function with stateful hooks and its real search/page helpers.
// Native focus, pointer, button activation and scrolling are covered by the built UI harness.
function addMenuHarness(initial) {
  const file = ts.createSourceFile('RoutinePanel.jsx', readFileSync(new URL('../src/renderer/components/RoutinePanel.jsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
  let declaration;
  const visit = node => { if (ts.isFunctionDeclaration(node) && node.name?.text === 'AddMenu') declaration = node; else ts.forEachChild(node, visit); }; visit(file);
  const cells = []; let cursor, dirty, effects, tree, props = initial;
  const slot = make => { const index = cursor++; if (!(index in cells)) cells[index] = make(); return cells[index]; };
  const useState = initialValue => { const cell = slot(() => ({ value: typeof initialValue === 'function' ? initialValue() : initialValue })); return [cell.value, value => { const next = typeof value === 'function' ? value(cell.value) : value; if (!Object.is(next, cell.value)) { cell.value = next; dirty = true; } }]; };
  const useMemo = (read, deps) => { const cell = slot(() => ({})); if (!cell.deps || deps.some((value, index) => value !== cell.deps[index])) { cell.deps = deps; cell.value = read(); } return cell.value; };
  const useEffect = (run, deps) => { const cell = slot(() => ({})); if (!cell.deps || deps.some((value, index) => value !== cell.deps[index])) { cell.deps = deps; effects.push(run); } };
  const search = vi.fn(filterPickerItems);
  const scope = { useState, useMemo, useEffect, useRef: current => slot(() => ({ current })),
    h: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(child => child != null && child !== false && child !== true && child !== '') }),
    createPortal: element => element, document: { body: {} }, Glyph: 'Glyph', Icon: 'Icon', usePlacement: () => ({ left: 0, top: 0, maxHeight: 500 }), useOutside: () => {},
    enabledPickerIndex, filterPickerItems: search, pickerPage, PICKER_PAGE_SIZE, ...commandSearch, rankChoices: vi.fn(commandSearch.rankChoices),
    plural: (count, word) => count + ' ' + word + (count === 1 ? '' : 's'), modifierName: () => 'Ctrl', addDetail: () => null, React: { Fragment: 'Fragment' } };
  search.rankChoices = scope.rankChoices;
  const Component = new Function(...Object.keys(scope), 'return (' + declaration.getText().replace(/^export\s+/, '') + ')')(...Object.values(scope));
  const render = next => { props = next || props; for (let pass = 0; pass < 8; pass++) { cursor = 0; dirty = false; effects = []; tree = Component(props); effects.forEach(run => run()); if (!dirty) return; } throw Error('Unsettled AddMenu'); };
  const all = (predicate, node = tree) => typeof node !== 'object' ? [] : [predicate(node) ? node : null, ...node.children.flatMap(child => all(predicate, child))].filter(Boolean);
  const key = (key, target = { closest: () => false }, repeat = false, modifiers = {}) => { const event = { key, target, repeat, ...modifiers, defaultPrevented: false, preventDefault() { event.defaultPrevented = true; }, stopPropagation() {} }; tree.props.onKeyDown(event); render(); return event; };
  const input = () => all(node => node.type === 'input')[0];
  render();
  return { render, key, input, search: scope.rankChoices, options: () => all(node => node.props.role === 'option'), button: label => all(node => node.props['aria-label'] === label)[0],
    filter: id => all(node => node.props['data-filter'] === id)[0], headings: () => all(node => node.props.className === 'rt-ch-sec').map(node => node.props.key),
    text: node => { const read = element => typeof element === 'object' ? element.children.map(read).join('') : String(element); return read(node); }, all: predicate => all(predicate),
    query: value => { input().props.onChange({ target: { value } }); render(); } };
}
describe('Add menu full-catalog pagination', () => {
  const fixture = () => ({ anchor: {}, paths: [{ id: 'path', name: 'Approach' }], steps: Array.from({ length: 166 }, (_, index) => ({ key: String(index), label: `Command ${index}`, disabled: index === 79, icon: 'bolt' })).concat([{ key: 'repeat', label: 'Repeat' }, { key: 'end', label: 'End routine' }, { key: 'exit', label: 'Exit repeat' }]), onPick: vi.fn(), onClose: vi.fn(), label: 'Add a step' });
  it('bounds rows while arrows wrap/cross pages and Page/Home/End reach every tail action', () => {
    const props = fixture(), view = addMenuHarness(props);
    expect(view.options()).toHaveLength(80);
    expect(view.options()[0].props).toMatchObject({ 'aria-posinset': 1, 'aria-setsize': 170 });
    view.key('End'); expect(view.input().props['aria-activedescendant']).toBe('rt-add-opt-169');
    view.key('Enter'); expect(props.onPick).toHaveBeenLastCalledWith(props.steps.at(-1));
    view.key('ArrowDown'); expect(view.input().props['aria-activedescendant']).toBe('rt-add-opt-0');
    view.key('ArrowUp'); expect(view.input().props['aria-activedescendant']).toBe('rt-add-opt-169');
    view.key('Home'); view.key('PageDown');
    expect(view.input().props['aria-activedescendant']).toBe('rt-add-opt-81'); // global80 is disabled
    view.key('ArrowUp'); expect(view.input().props['aria-activedescendant']).toBe('rt-add-opt-79');
    view.key('ArrowDown'); expect(view.input().props['aria-activedescendant']).toBe('rt-add-opt-81');
    expect(view.options().some(option => option.props.id === view.input().props['aria-activedescendant'])).toBe(true);
    expect(view.options().length).toBeLessThanOrEqual(80);
    view.key('PageDown'); expect(view.options().at(-1).props['aria-posinset']).toBe(170);
    view.key('PageUp'); expect(view.options()[0].props['aria-posinset']).toBe(81);
  });
  it('searches beyond the mounted page, resets after query/catalog changes, and reuses filtering on navigation', () => {
    const props = fixture(), view = addMenuHarness(props), scans = view.search.mock.calls.length;
    view.key('End'); view.key('Home'); view.key('PageDown');
    expect(view.search).toHaveBeenCalledTimes(scans);
    view.query('exit repeat'); expect(view.options()).toHaveLength(1);
    expect(view.options()[0].props['aria-posinset']).toBe(1);
    expect(view.button('Next results')).toBeUndefined();
    view.query(''); view.key('End');
    view.render({ ...props, steps: [{ key: 'new', label: 'Refreshed command' }] });
    expect(view.options()).toHaveLength(2);
    expect(view.input().props['aria-activedescendant']).toBe('rt-add-opt-0');
    view.query('missing'); expect(view.options()).toEqual([]);
    expect(view.input().props['aria-activedescendant']).toBeUndefined();
  });
  it('keeps the highlighted item through a background catalog update for the same search', () => {
    const pick = (refresh) => {
      const props = fixture(), view = addMenuHarness(props);
      view.key('ArrowDown'); view.key('ArrowDown'); view.key('ArrowDown');
      // A refresh adds a command ahead of the highlight and relabels the rest; the search itself is unchanged.
      if (refresh) view.render({ ...props, steps: [{ key: 'inserted', label: 'Command added in LabVIEW' }, ...props.steps.map(step => ({ ...step, label: step.label + ' (refreshed)' }))] });
      view.key('Enter');
      return props.onPick.mock.calls.at(-1)[0];
    };
    const before = pick(false), after = pick(true);
    expect(after.key).toBe(before.key);
    expect(after.label).toBe(before.label + ' (refreshed)');
  });
  it('keeps pagination button Enter native, ignores held Enter and preserves Tab/Escape dismissal', () => {
    const props = fixture(), view = addMenuHarness(props);
    view.key('Enter', { closest: selector => selector === '.rt-add-pages button' }); expect(props.onPick).not.toHaveBeenCalled();
    view.key('Enter', undefined, true); expect(props.onPick).not.toHaveBeenCalled();
    view.button('Next results').props.onClick(); view.render();
    expect(view.options()[0].props['aria-posinset']).toBe(81);
    // Tab moves from the search to the filter (native); Tab past the filter, Shift+Tab before the search and Escape close.
    const inFilter = { closest: selector => selector === '.rt-add-filter' };
    view.key('Tab'); expect(props.onClose).not.toHaveBeenCalled();
    view.key('Tab', inFilter, false, { shiftKey: true }); expect(props.onClose).not.toHaveBeenCalled();
    view.key('Tab', inFilter); view.key('Tab', undefined, false, { shiftKey: true }); view.key('Escape');
    expect(props.onClose.mock.calls).toEqual([[true], [true], [true]]);
  });
});

describe('Add menu kind filter', () => {
  // A small catalog (12 commands) lists every command; subsystems only appear for larger catalogs.
  const commands = Array.from({ length: 12 }, (_, index) => ({ id: 'c' + index, label: 'Intake ' + index, member: 'Intake ' + index + '.vi', parameters: [], outputs: [] }));
  const fixture = () => ({ anchor: {}, onPick: vi.fn(), onClose: vi.fn(), label: 'Add a step',
    paths: Array.from({ length: 8 }, (_, index) => ({ id: 'p' + index, name: 'Approach ' + index })),
    steps: [...addMenuSteps({ nodes: [] }, { list: { kind: 'root' } }, { commands }).filter(item => item.group === 'commands'),
      { key: 'wait', kind: 'wait', group: 'steps', label: 'Wait' }, { key: 'repeat', kind: 'repeat', group: 'steps', label: 'Repeat' }] });
  const keys = view => view.options().map(option => option.props.key);
  const allCommands = Array.from({ length: 12 }, (_, index) => 'command:c' + index);
  it('opens on commands, then a short Paths section ending in a row that opens its full filter, then steps', () => {
    const props = fixture(), view = addMenuHarness(props);
    expect(view.filter('all').props).toMatchObject({ 'aria-pressed': true, tabIndex: 0, type: 'button' });
    expect(view.filter('commands').props).toMatchObject({ 'aria-pressed': false, tabIndex: -1 });
    expect(view.headings()).toEqual(['section:Commands', 'section:Paths', 'section:Steps']);
    expect(keys(view)).toEqual([...allCommands, 'path:p0', 'path:p1', 'path:p2', 'path:p3', 'path:p4', 'more:paths', 'wait', 'repeat']);
    // Arrow to "Show all 8 paths": Enter switches the filter instead of picking, and the list holds every path.
    for (let index = 0; index < 17; index++) view.key('ArrowDown');
    expect(view.input().props['aria-activedescendant']).toBe('rt-add-opt-17');
    view.key('Enter');
    expect(props.onPick).not.toHaveBeenCalled();
    expect(view.filter('paths').props['aria-pressed']).toBe(true);
    expect(keys(view)).toEqual(Array.from({ length: 8 }, (_, index) => 'path:p' + index));
    expect(view.headings()).toEqual([]);
    expect(view.input().props.placeholder).toBe('Search paths');
    view.key('Enter'); expect(props.onPick).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ key: 'path:p0' }));
  });
  it('ranks within each kind, puts the best-matching kind first and changes filter with Left/Right', () => {
    const props = fixture(), view = addMenuHarness(props);
    view.query('1');
    // "Approach 1" and "Intake 1" match a whole word; "Intake 10" and "Intake 11" only a word start.
    expect(keys(view)).toEqual(['path:p1', 'command:c1', 'command:c10', 'command:c11']);
    view.filter('paths').props.onClick(); view.render();
    expect(keys(view)).toEqual(['path:p1']);
    expect(view.input().props.value).toBe('1');
    const inFilter = { closest: selector => selector === '.rt-add-filter' };
    view.key('ArrowRight', inFilter); expect(view.filter('commands').props['aria-pressed']).toBe(true);
    expect(keys(view)).toEqual(['command:c1', 'command:c10', 'command:c11']);
    view.key('ArrowRight', inFilter); view.key('ArrowRight', inFilter); expect(view.filter('all').props['aria-pressed']).toBe(true);
    view.key('ArrowLeft', inFilter); expect(view.filter('steps').props['aria-pressed']).toBe(true);
    expect(view.options()).toEqual([]);
    view.query(''); expect(keys(view)).toEqual(['wait', 'repeat']);
    // Enter on a focused filter button stays native: it never picks the active option.
    view.key('Enter', inFilter); expect(props.onPick).not.toHaveBeenCalled();
    // An exact step name outranks partial matches in other kinds.
    view.filter('all').props.onClick(); view.render(); view.query('wait');
    expect(keys(view)[0]).toBe('wait');
  });
  it('keeps a search short in All, with a row that shows every matching command', () => {
    const props = fixture(), view = addMenuHarness(props);
    view.query('intake');
    expect(keys(view)).toEqual([...allCommands.slice(0, 8), 'more:commands']);
    expect(view.text(view.options().at(-1))).toContain('Show all 12 matching commands');
    for (let index = 0; index < 8; index++) view.key('ArrowDown');
    view.key('Enter');
    expect(view.filter('commands').props['aria-pressed']).toBe(true); expect(view.options()).toHaveLength(12);
  });
});

describe('Add menu subsystems with a 187-command catalog', () => {
  const routine = { nodes: [{ id: 'a', type: 'function', cat: 'command', invocation: { commandId: 'vi.intake-intake-until-note' } }, { id: 'b', type: 'function', cat: 'command', invocation: { commandId: 'vi.shooter-shooter-spin-up-speaker' } }] };
  const usage = commandSearch.commandUsage([{ id: 'other', nodes: [{ id: 'c', type: 'function', cat: 'command', invocation: { commandId: 'vi.shooter-shooter-shoot-when-ready' } }] }], [], routine);
  const fixture = () => ({ anchor: {}, onPick: vi.fn(), onClose: vi.fn(), label: 'Add a step', usage, paths: [{ id: 'p0', name: 'Start to note 1' }],
    steps: addMenuSteps(routine, { list: { kind: 'root' } }, commandCatalog187) });
  const labels = view => view.options().map(option => view.text(option.children.find(child => child.props?.className === 'rt-ch-t')));
  const active = view => view.options().find(option => option.props.id === view.input().props['aria-activedescendant']);
  it('shows the subsystem name quieter in mixed search results', () => {
    const view = addMenuHarness(fixture());
    view.query('spin up');
    const row = view.options().find(option => view.text(option).includes('Spin Up Speaker'));
    const title = row.children.find(child => child.props?.className === 'rt-ch-t');
    const prefix = [].concat(title.children).flat().find(child => child?.props?.className === 'rt-ch-pre');
    expect(prefix && view.text(prefix)).toBe('Shooter ');
  });
  it('opens on this routine’s commands and the subsystems, diagnostics last and dimmed', () => {
    const view = addMenuHarness(fixture());
    expect(view.headings()).toEqual(['section:In this routine', 'section:Subsystems', 'section:Paths', 'section:Steps']);
    const names = labels(view);
    expect(names.slice(0, 2)).toEqual(['Intake Until Note', 'Shooter Spin Up Speaker']);
    expect(names.slice(2, 15)).toEqual(['Arm', 'Climber', 'Drive', 'Elevator', 'Indexer', 'Intake', 'LEDs', 'Shooter', 'Superstructure', 'Utilities', 'Vision', 'SysId', 'Test']);
    const test = view.options().find(option => option.props.key === 'subsystem:test');
    expect(test.props.className).toContain('dim');
    expect(view.text(test)).toContain('12 commands · diagnostics');
    // The meta line carries named inputs with units and distinctive outputs, never the universal completion status.
    expect(view.text(view.options()[0])).toBe('Intake Until NoteTimeout s · reports has note');
  });
  it('ranks a search: the matching subsystem first, then label starts, with old copies and diagnostics last', () => {
    const view = addMenuHarness(fixture());
    view.query('shoot');
    // Shoot When Ready is used elsewhere in the project, so it edges ahead of equally good name matches.
    expect(labels(view).slice(0, 4)).toEqual(['Shooter', 'Shooter Shoot When Ready', 'Shooter Shoot', 'Shoot Preload']);
    view.filter('commands').props.onClick(); view.render();
    const names = labels(view);
    expect(names.indexOf('Shooter Shoot v2')).toBeGreaterThan(names.indexOf('Shooter Shoot From Stage'));
    view.query('ssus');
    expect(labels(view)).toEqual(['Shooter Spin Up Speaker']);
    view.query('motor');
    expect(labels(view).every(name => name.startsWith('Test '))).toBe(true);
  });
  it('enters a subsystem with → or Tab, drops the repeated name, lists used commands first and leaves with Backspace', () => {
    const view = addMenuHarness(fixture());
    view.query('shoo');
    expect(active(view).props.key).toBe('subsystem:shooter');
    const right = view.key('ArrowRight', { closest: () => false, value: 'shoo', selectionStart: 4 });
    expect(right.defaultPrevented).toBe(true);
    expect(view.input().props).toMatchObject({ value: '', placeholder: 'Search Shooter' });
    expect(view.filter('all')).toBeUndefined();
    expect(view.headings()).toEqual(['section:Used in this project', 'section:Other Shooter commands']);
    expect(labels(view).slice(0, 3)).toEqual(['Spin Up Speaker', 'Shoot When Ready', 'Spin Up']);
    expect(view.options()[0].props).toMatchObject({ title: 'Shooter Spin Up Speaker', 'aria-label': 'Shooter Spin Up Speaker' });
    view.query('sp');
    expect(labels(view).slice(0, 4)).toEqual(['Spin Up Speaker', 'Spin Up', 'Spin Up Amp', 'Spin Up Pass']);
    view.query(''); view.key('Backspace', { closest: () => false, value: '' });
    expect(view.filter('all')).toBeDefined();
    expect(active(view).props.key).toBe('subsystem:shooter');
    // Tab opens the highlighted subsystem too; Enter on it does the same.
    view.key('Tab'); expect(view.input().props.placeholder).toBe('Search Shooter');
    // Inside a subsystem there is no filter: Tab past the search closes.
    const props = fixture(), closing = addMenuHarness(props);
    closing.query('arm'); closing.key('Enter'); expect(props.onPick).not.toHaveBeenCalled();
    expect(closing.input().props.placeholder).toBe('Search Arm');
    closing.key('Tab'); expect(props.onClose).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('Ctrl+Enter picks with keep and clears the search for the next command', () => {
    const props = fixture(), view = addMenuHarness(props);
    view.query('leds has');
    view.key('Enter', undefined, false, { ctrlKey: true });
    expect(props.onPick).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ key: 'command:vi.leds-leds-has-note' }), { keep: true });
    expect(view.input().props.value).toBe('');
    view.render({ ...props, added: ['LEDs Has Note'] });
    expect(view.text(view.all(node => node.props.className === 'rt-add-added')[0])).toBe('Added LEDs Has Note. Keep adding, or press Esc when done.');
    view.query('vision w'); view.key('Enter');
    expect(props.onPick).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'command:vi.vision-vision-wait-for-target' }));
  });
});
