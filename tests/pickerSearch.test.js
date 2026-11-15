import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { commandChoices, inspectorCommandChoices } from '../src/renderer/lib/commandPick';
import { enabledPickerIndex, filterPickerItems, pickerPage, PICKER_PAGE_SIZE } from '../src/renderer/lib/pickerSearch';

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
    h: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(child => child && typeof child === 'object') }),
    createPortal: element => element, document: { body: {} }, Glyph: 'Glyph', Icon: 'Icon', usePlacement: () => ({ left: 0, top: 0, maxHeight: 500 }), useOutside: () => {},
    enabledPickerIndex, filterPickerItems: search, pickerPage, PICKER_PAGE_SIZE };
  const Component = new Function(...Object.keys(scope), 'return (' + declaration.getText().replace(/^export\s+/, '') + ')')(...Object.values(scope));
  const render = next => { props = next || props; for (let pass = 0; pass < 8; pass++) { cursor = 0; dirty = false; effects = []; tree = Component(props); effects.forEach(run => run()); if (!dirty) return; } throw Error('Unsettled AddMenu'); };
  const all = (predicate, node = tree) => [predicate(node) ? node : null, ...node.children.flatMap(child => all(predicate, child))].filter(Boolean);
  const key = (key, target = { closest: () => false }, repeat = false, modifiers = {}) => { tree.props.onKeyDown({ key, target, repeat, ...modifiers, preventDefault() {}, stopPropagation() {} }); render(); };
  const input = () => all(node => node.type === 'input')[0];
  render();
  return { render, key, input, search, options: () => all(node => node.props.role === 'option'), button: label => all(node => node.props['aria-label'] === label)[0],
    filter: id => all(node => node.props['data-filter'] === id)[0], headings: () => all(node => node.props.className === 'rt-ch-sec').map(node => node.props.key),
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
  const fixture = () => ({ anchor: {}, onPick: vi.fn(), onClose: vi.fn(), label: 'Add a step',
    paths: Array.from({ length: 8 }, (_, index) => ({ id: 'p' + index, name: 'Approach ' + index })),
    steps: [...Array.from({ length: 12 }, (_, index) => ({ key: 'command:c' + index, kind: 'command', group: 'commands', label: 'Intake ' + index, command: { id: 'c' + index } })),
      { key: 'wait', kind: 'wait', group: 'steps', label: 'Wait' }, { key: 'repeat', kind: 'repeat', group: 'steps', label: 'Repeat' }] });
  const keys = view => view.options().map(option => option.props.key);
  it('shows short Paths and Commands sections in All, each ending in a row that opens its full filter', () => {
    const props = fixture(), view = addMenuHarness(props);
    expect(view.filter('all').props).toMatchObject({ 'aria-pressed': true, tabIndex: 0, type: 'button' });
    expect(view.filter('commands').props).toMatchObject({ 'aria-pressed': false, tabIndex: -1 });
    expect(view.headings()).toEqual(['section:Paths', 'section:Commands', 'section:Steps']);
    expect(keys(view)).toEqual(['path:p0', 'path:p1', 'path:p2', 'path:p3', 'path:p4', 'more:paths',
      'command:c0', 'command:c1', 'command:c2', 'command:c3', 'command:c4', 'more:commands', 'wait', 'repeat']);
    // Arrow to "Show all 12 commands": Enter switches the filter instead of picking, and the list holds every command.
    for (let index = 0; index < 11; index++) view.key('ArrowDown');
    expect(view.input().props['aria-activedescendant']).toBe('rt-add-opt-11');
    view.key('Enter');
    expect(props.onPick).not.toHaveBeenCalled();
    expect(view.filter('commands').props['aria-pressed']).toBe(true);
    expect(keys(view)).toEqual(Array.from({ length: 12 }, (_, index) => 'command:c' + index));
    expect(view.headings()).toEqual([]);
    expect(view.input().props.placeholder).toBe('Search commands');
    view.key('Enter'); expect(props.onPick).toHaveBeenCalledExactlyOnceWith(props.steps[0]);
  });
  it('searches within the active filter, keeps the query across filters and changes filter with Left/Right', () => {
    const props = fixture(), view = addMenuHarness(props);
    view.query('1');
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
  });
  it('labels the Show all row with the matching count while searching', () => {
    const props = fixture(), view = addMenuHarness(props);
    view.query('intake');
    expect(keys(view)).toEqual(['command:c0', 'command:c1', 'command:c2', 'command:c3', 'command:c4', 'more:commands']);
    for (let index = 0; index < 5; index++) view.key('ArrowDown');
    view.key('Enter');
    expect(view.filter('commands').props['aria-pressed']).toBe(true); expect(view.options()).toHaveLength(12);
  });
});
