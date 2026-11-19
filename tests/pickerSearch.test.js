import { describe, expect, it, vi } from 'vitest';
import { commandChoices, inspectorCommandChoices } from '../src/renderer/lib/commandPick';
import { filterPickerItems } from '../src/renderer/lib/pickerSearch';

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
