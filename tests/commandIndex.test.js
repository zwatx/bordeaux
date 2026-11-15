import { describe, expect, it } from 'vitest';
import { commandCatalog187 } from './fixtures/commandCatalog187';
import { commandChoiceItems, commandChoiceRows, commandEntry, commandIndex, commandMetaLine, commandSections, commandUsage, markMatches, matchSubsystems,
  openSubsystem, rankChoices, rankCommandChoices, searchCommands, subsystemOf, usageText } from '../src/renderer/lib/commandIndex';

const catalog = commandCatalog187.commands;
const byLabel = (label) => catalog.find((command) => command.label === label);
const names = (found) => found.map(({ entry }) => entry.label);

describe('subsystems from the VI path', () => {
  it.each([
    ['Subsystems/Shooter/Commands/Shooter Spin Up.vi', 'Shooter Spin Up', 'Shooter'],
    ['Commands/Superstructure/Score Speaker.vi', 'Score Speaker', 'Superstructure'],
    ['Diagnostics/SysId/SysId Arm Dynamic.vi', 'SysId Arm Dynamic', 'SysId'],
    ['src\\Intake\\Intake Until Note.vi', 'Intake Until Note', 'Intake'],
    ['Robot/Arm Commands/Stow.vi', 'Stow', 'Arm'],
    ['Climber Subsystem/Extend.vi', 'Extend', 'Climber'],
    ['Commands/Drive Stop.vi', 'Drive Stop', 'Drive'],
    ['Stop.vi', 'Stop', 'Other'],
    ['', 'Vision LEDs On', 'Vision'],
  ])('%s → %s', (member, label, expected) => {
    expect(subsystemOf({ member, label })).toBe(expected);
  });

  it('groups the fixture into its 13 folders, alphabetical with diagnostics last', () => {
    const index = commandIndex(catalog);
    expect(index.entries).toHaveLength(187);
    expect(index.subsystems.map((subsystem) => [subsystem.name, subsystem.entries.length, subsystem.diagnostic])).toEqual([
      ['Arm', 18, false], ['Climber', 10, false], ['Drive', 20, false], ['Elevator', 12, false], ['Indexer', 9, false], ['Intake', 25, false],
      ['LEDs', 8, false], ['Shooter', 27, false], ['Superstructure', 18, false], ['Utilities', 8, false], ['Vision', 10, false], ['SysId', 10, true], ['Test', 12, true]]);
    expect(index.bySubsystem.get('shooter').folder).toBe('Subsystems/Shooter/Commands');
    expect(index.browsable).toBe(true);
    expect(commandIndex(catalog)).toBe(index);
    expect(commandIndex(catalog.slice(0, 12)).browsable).toBe(false);
  });

  it('drops the repeated subsystem name only where the label starts with it', () => {
    expect(commandEntry(byLabel('Shooter Spin Up Speaker'))).toMatchObject({ prefix: 'Shooter', rest: 'Spin Up Speaker' });
    expect(commandEntry(byLabel('Score Speaker'))).toMatchObject({ prefix: '', rest: 'Score Speaker', subsystem: 'Superstructure' });
    expect(commandEntry({ id: 'x', label: 'Intake', member: 'Intake/Intake.vi' })).toMatchObject({ prefix: '', rest: 'Intake' });
    expect(commandEntry({ id: 'y', label: 'Intakes Run', member: 'Intake/Intakes Run.vi' })).toMatchObject({ prefix: '', rest: 'Intakes Run' });
  });

  it('marks diagnostics by folder name and old copies by label', () => {
    expect(commandEntry(byLabel('Test Arm Motor')).diagnostic).toBe(true);
    expect(commandEntry({ id: 'd', label: 'Spin', member: 'Shooter/Tuning/Spin.vi' })).toMatchObject({ subsystem: 'Tuning', diagnostic: true });
    expect(commandEntry(byLabel('Shooter Spin Up')).diagnostic).toBe(false);
    for (const label of ['Intake In (old)', 'Intake In v2', 'Copy of Intake Until Note', 'Score Speaker (old)']) expect(commandEntry(byLabel(label)).legacy).toBe(true);
    for (const label of ['Arm Hold', 'Intake Hold Note', 'Shooter Spin Up']) expect(commandEntry(byLabel(label)).legacy).toBe(false);
  });
});

describe('meta line', () => {
  it('shows named inputs with units and the outputs that differ, never the universal completion status', () => {
    expect(commandEntry(byLabel('Intake Until Note')).meta).toBe('Timeout s · reports has note');
    expect(commandEntry(byLabel('Drive Turn To Angle')).meta).toBe('Angle deg, Timeout s · reports heading error');
    expect(commandEntry(byLabel('Shooter Spin Up')).meta).toBe('Target speed rpm · reports at speed');
    expect(commandEntry(byLabel('Drive Align To AprilTag')).meta).toBe('Tag ID, Timeout s · reports aligned');
    expect(commandEntry(byLabel('Drive Stop')).meta).toBe('');
    expect(commandMetaLine([], [{ name: 'ID', label: 'ID' }])).toBe('reports ID');
  });
});

describe('ranked search', () => {
  const index = commandIndex(catalog);
  it('puts label starts before word starts, initials, substrings and details', () => {
    expect(names(searchCommands(index, 'shoot')).slice(0, 3)).toEqual(['Shooter Shoot', 'Shoot Preload', 'Shooter Shoot When Ready']);
    expect(names(searchCommands(index, 'ssus'))).toEqual(['Shooter Spin Up Speaker']);
    expect(names(searchCommands(index, 'iun'))).toEqual(['Intake Until Note', 'Intake Until Note Or Timeout']);
    expect(names(searchCommands(index, 'pod'))).toEqual(['Arm Podium', 'Shooter Shoot From Podium']);
    // "aligned" is only an output name: it still finds the commands, after any name match.
    expect(names(searchCommands(index, 'aligned')).sort()).toEqual(['Drive Align To Amp', 'Drive Align To AprilTag', 'Drive Align To Speaker']);
    // Every term must match: AND across the name and its details.
    expect(names(searchCommands(index, 'intake note')).slice(0, 2)).toEqual(['Intake Until Note', 'Intake Hold Note']);
    expect(searchCommands(index, 'intake zzz')).toEqual([]);
  });
  it('ranks diagnostics after every other match', () => {
    for (const query of ['shooter', 'arm', 'drive', 'char']) {
      const found = searchCommands(index, query), first = found.findIndex(({ entry }) => entry.diagnostic);
      if (first >= 0) expect(found.slice(first).every(({ entry }) => entry.diagnostic)).toBe(true);
    }
  });
  it('takes the subsystem of a generated command from its owning class', () => {
    expect(subsystemOf({ member: 'shoot', label: 'Shoot', ownerType: 'frc.robot.subsystems.ShooterSubsystem' })).toBe('Shooter');
    expect(subsystemOf({ member: 'hasNote', label: 'Wait For Note', ownerType: 'frc.robot.Intake' })).toBe('Intake');
    expect(subsystemOf({ member: 'Commands/Drive Stop.vi', label: 'Drive Stop', ownerType: 'LabVIEW' })).toBe('Drive');
  });
  it('demotes old copies and diagnostics below equally good matches', () => {
    const intake = names(searchCommands(index, 'intake until note'));
    expect(intake.indexOf('Copy of Intake Until Note')).toBeGreaterThan(intake.indexOf('Intake Until Note Or Timeout'));
    const arm = names(searchCommands(index, 'arm'));
    expect(arm.indexOf('Test Arm Motor')).toBeGreaterThan(arm.indexOf('Arm To Angle (old)'));
    expect(arm.indexOf('Arm To Angle (old)')).toBeGreaterThan(arm.indexOf('Arm To Angle'));
  });
  it('boosts commands used in this routine, then in the project', () => {
    const plain = names(searchCommands(index, 'intake'));
    const usage = commandUsage([{ id: 'r', nodes: [{ id: 'a', type: 'function', cat: 'command', invocation: { commandId: byLabel('Intake Clear Jam').id } }] }],
      [{ id: 'p', markers: [{ commandGroup: { mode: 'parallel', commands: [{ commandId: byLabel('Intake Eject Fast').id }, { commandId: byLabel('Intake Clear Jam').id }] } }] }],
      { id: 'r', nodes: [{ id: 'a', type: 'function', cat: 'command', invocation: { commandId: byLabel('Intake Clear Jam').id } }] });
    expect(usage.counts.get(byLabel('Intake Clear Jam').id)).toEqual({ routine: 1, project: 2 });
    expect(usage.counts.get(byLabel('Intake Eject Fast').id)).toEqual({ routine: 0, project: 1 });
    const boosted = names(searchCommands(index, 'intake', { usage }));
    expect(boosted[0]).toBe('Intake Clear Jam');
    expect(boosted.indexOf('Intake Eject Fast')).toBeLessThan(plain.indexOf('Intake Eject Fast'));
    expect(usageText(usage, byLabel('Intake Clear Jam').id)).toBe('Used in this routine');
    expect(usageText(usage, byLabel('Intake Eject Fast').id)).toBe('Used once in this project');
    expect(usageText(usage, byLabel('Intake In').id)).toBe('Not used yet');
  });
  it('searches the short name inside a subsystem', () => {
    expect(names(searchCommands(index, 'sp', { scope: 'shooter' })).slice(0, 2)).toEqual(['Shooter Spin Up', 'Shooter Spin Up Speaker']);
    expect(searchCommands(index, 'stow', { scope: 'shooter' })).toEqual([]);
    expect(matchSubsystems(index, 'sh').map(({ subsystem }) => subsystem.name)).toEqual(['Shooter']);
    expect(matchSubsystems(index, 's').map(({ subsystem }) => subsystem.name)).toEqual(['Shooter', 'Superstructure', 'SysId']);
  });
  it('ranks 10,000 commands quickly', () => {
    const many = Array.from({ length: 10000 }, (_, n) => ({ ...catalog[n % catalog.length], id: 'c' + n, label: catalog[n % catalog.length].label + ' ' + n }));
    const started = performance.now(), big = commandIndex(many);
    for (const query of ['s', 'sh', 'shoot', 'shooter spin', 'ssus', 'has note']) searchCommands(big, query);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(searchCommands(big, 'ssus').length).toBeGreaterThan(0);
  });
});

describe('sections shared by both pickers', () => {
  const index = commandIndex(catalog);
  const routine = { id: 'r', nodes: [{ id: 'a', type: 'group', mode: 'parallel', nodes: [
    { id: 'b', type: 'function', cat: 'command', invocation: { commandId: byLabel('Arm Intake').id } },
    { id: 'c', type: 'function', cat: 'command', invocation: { commandId: byLabel('Intake Until Note').id } }] }] };
  const usage = commandUsage([routine, { id: 'o', nodes: [{ id: 'd', type: 'function', cat: 'command', invocation: { commandId: byLabel('Shooter Feed').id } }] }], [], routine);
  it('opens on this routine and the subsystems, and on every command for a small catalog', () => {
    const home = commandSections(index, { usage });
    expect(home.map((section) => section.title)).toEqual(['In this routine', 'Subsystems']);
    expect(home[0].rows.map((row) => row.entry.label)).toEqual(['Arm Intake', 'Intake Until Note']);
    expect(home[1].note).toBe('187 commands');
    const small = commandSections(commandIndex(catalog.slice(0, 5)), { usage });
    expect(small.map((section) => [section.title, section.rows.length])).toEqual([['Commands', 5]]);
  });
  it('does not repeat a routine command under Other commands', () => {
    const commands = [...catalog, { id: 'solo', label: 'Lonely', member: 'Misc/Lonely.vi' }];
    const usage = commandUsage([], [], { id: 'r', nodes: [{ id: 'a', type: 'function', cat: 'command', invocation: { commandId: 'solo' } }] });
    const values = commandSections(commandIndex(commands), { usage }).flatMap((section) => section.rows.map((row) => row.type === 'command' ? row.entry.id : 'subsystem:' + row.subsystem.key));
    expect(values.filter((value) => value === 'solo')).toHaveLength(1);
    expect(new Set(values).size).toBe(values.length);
  });
  it('lists one-command folders under Other commands', () => {
    const odd = commandSections(commandIndex([...catalog, { id: 'solo', label: 'Lonely', member: 'Misc/Lonely.vi' }]), {});
    expect(odd.at(-1)).toMatchObject({ title: 'Other commands' });
    expect(odd.at(-1).rows.map((row) => row.entry.label)).toEqual(['Lonely']);
  });
  it('lists used commands first inside a subsystem, without the prefix', () => {
    const shooter = commandSections(index, { scope: 'shooter', usage });
    expect(shooter.map((section) => [section.title, section.rows.length])).toEqual([['Used in this project', 1], ['Other Shooter commands', 26]]);
    expect(shooter[0].rows[0]).toMatchObject({ showPrefix: false, entry: { label: 'Shooter Feed' } });
  });
  it('gives the inspector the same rows, with full names kept as titles', () => {
    const rows = commandChoiceRows(index, '', 'shooter', usage);
    expect(rows[0]).toMatchObject({ section: 'Used in this project', value: byLabel('Shooter Feed').id, label: 'Feed', title: 'Shooter Feed' });
    expect(rows[1]).toMatchObject({ section: 'Other Shooter commands', label: 'Spin Up', meta: 'Target speed rpm · reports at speed' });
    const searched = commandChoiceRows(index, 'arm', null, usage);
    expect(searched[0]).toMatchObject({ section: 'Commands', value: 'subsystem:arm', enter: 'arm', label: 'Arm', meta: '18 commands' });
    expect(searched[1]).toMatchObject({ label: 'Arm Intake', title: undefined });
    expect(commandChoiceItems(catalog).find((item) => item.label === 'Shooter Spin Up')).toMatchObject({ meta: 'Shooter · Target speed rpm · reports at speed' });
    expect(openSubsystem(index, byLabel('Arm Intake').id)).toBe('arm');
    expect(openSubsystem(commandIndex(catalog.slice(0, 5)), catalog[0].id)).toBeNull();
  });
});

describe('ordinary choices and match marks', () => {
  it('ranks paths and steps with the same tiers', () => {
    const items = [{ label: 'Note 2 to wing' }, { label: 'Start to note 1' }, { label: 'Wingback', meta: 'Autos' }, { label: 'Other', meta: 'Note folder' }];
    expect(rankChoices(items, 'note').map(({ item }) => item.label)).toEqual(['Note 2 to wing', 'Start to note 1', 'Other']);
    expect(rankChoices(items, 'win').map(({ item }) => item.label)).toEqual(['Wingback', 'Note 2 to wing']);
    expect(rankChoices(items, '').map(({ item }) => item)).toEqual(items);
  });
  it('marks word starts that match a term', () => {
    const parts = markMatches('Shooter Spin Up', 'sh sp');
    expect(parts.filter((part) => part.mark).map((part) => part.text)).toEqual(['Sh', 'Sp']);
    expect(parts.map((part) => part.text).join('')).toBe('Shooter Spin Up');
    expect(markMatches('Arm', '')).toEqual([{ text: 'Arm', mark: false }]);
  });
});

describe('path event picker ranking', () => {
  it('ranks its command choices and keeps No command and missing commands findable', async () => {
    const { inspectorCommandChoices } = await import('../src/renderer/lib/commandPick');
    const items = inspectorCommandChoices(catalog, 'retired.command');
    expect(rankCommandChoices(items, catalog, '')).toBe(items);
    expect(rankCommandChoices(items, catalog, 'shoot').slice(0, 2).map((item) => item.label)).toEqual(['Shooter Shoot', 'Shoot Preload']);
    expect(rankCommandChoices(items, catalog, 'no command').map((item) => item.value)).toContain('');
    expect(rankCommandChoices(items, catalog, 'unavailable').map((item) => item.value)).toEqual(['retired.command']);
  });
});
