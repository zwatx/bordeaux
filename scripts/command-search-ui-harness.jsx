import React, { useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/renderer/styles/routine-workspace.css';
import '../src/renderer/styles/app.css';
import { AddMenu, addMenuSteps } from '../src/renderer/components/RoutinePanel';
import { UI } from '../src/renderer/components/ui';
import { commandChoices } from '../src/renderer/lib/commandPick';
import { commandChoiceItems, commandChoiceRows, commandIndex, commandUsage, openSubsystem } from '../src/renderer/lib/commandIndex';
import { commandCatalog187 } from '../tests/fixtures/commandCatalog187';

// A realistic 187-command catalog for the palette, and a degenerate 10,000-command catalog for paging and refresh.
const realistic = commandCatalog187.commands;
const byLabel = label => realistic.find(command => command.label === label).id;
const many = Array.from({ length: 10000 }, (_, index) => ({ id: `command.${index}`, label: index === 9999 ? 'Needle9999 · a very long intake command name with measured feedback and an exact completion result' : `Command ${index}`,
  member: `Subsystem/Commands/Command-${index}.vi`, description: 'Mechanism surface velocity and torque', semanticTags: ['mechanism'],
  parameters: [{ name: 'Speed', description: 'Measured surface velocity', label: 'Target speed', role: 'argument', unit: 'm/s', valueType: 'DBL' }],
  outputs: [{ name: 'Ready', schema: { kind: 'boolean', valueType: 'Boolean' } }, { name: 'Status', schema: { kind: 'enum', valueType: 'Enum', enumValues: ['Successful', 'Aborted', 'Incomplete'] } }] }));
const paths = Array.from({ length: 20 }, (_, index) => ({ id: `path.${index}`, name: `Approach path ${index}` }));
const command = (id, label) => ({ id, type: 'function', cat: 'command', title: label, invocation: { commandId: byLabel(label), arguments: {} } });
const routine = { id: 'fixture-routine', nodes: [command('a', 'Intake Until Note'), command('b', 'Shooter Spin Up Speaker')] };
const usage = commandUsage([routine, { id: 'other', nodes: [command('c', 'Shooter Shoot When Ready')] }], [], routine);
const where = { list: { kind: 'repeat', nodeId: 'fixture-repeat' } };
const refreshedLabel = 'Refreshed command label · a very long mechanism command with measured feedback and exact completion results';
let state, refreshCatalog, resetInspector;
function Harness() {
  const [catalog, setCatalog] = useState({ commands: many });
  const [open, setOpen] = useState(null), [picked, setPicked] = useState([]), [selected, setSelected] = useState('command.9999');
  const [inspectorCommand, setInspectorCommand] = useState(byLabel('Shooter Feed'));
  const anchor = useRef(null), big = useRef(null);
  const steps = useMemo(() => addMenuSteps(routine, where, open === 'many' ? catalog : commandCatalog187), [catalog, open]);
  const simple = commandChoices(catalog.commands, selected);
  const index = commandIndex(realistic);
  state = { open, picked, selected, inspectorCommand };
  resetInspector = () => setInspectorCommand(byLabel('Shooter Feed'));
  refreshCatalog = () => setCatalog(current => ({ commands: current.commands.map(item => item.id === 'command.9999' ? { ...item, label: refreshedLabel } : item) }));
  const close = restore => { const from = open === 'many' ? big : anchor; setOpen(null); if (restore) requestAnimationFrame(() => from.current?.focus()); };
  return <main style={{ padding: 24, maxWidth: 900 }}>
    <h1>Command search · isolated fixtures</h1>
    <p>187 realistic commands for the palette, 10,000 for paging. No NI, robot or transport is used. The menus and pickers are production components.</p>
    <div className="qrow"><button ref={anchor} className="qbtn" onClick={() => { setPicked([]); setOpen('real'); }}>Add a step</button>
      <button ref={big} className="qbtn" onClick={() => { setPicked([]); setOpen('many'); }}>Add from 10,000</button></div>
    <section style={{ maxWidth: 420 }}><UI.Dropdown id="fixture-path-command" label="Path command" value={selected} items={simple} searchThreshold={0} activateFirstMatch onChange={setSelected} />
      <UI.ChoiceBrowser id="fixture-inspector-command" label="Inspector command" value={inspectorCommand} items={commandChoiceItems(realistic)} onChange={setInspectorCommand}
        search={(query, scope) => commandChoiceRows(index, query, scope, usage)} openScope={openSubsystem(index, inspectorCommand)} scopeName={key => index.bySubsystem.get(key)?.name || key} /></section>
    <output id="fixture-picked">{picked.map(item => item.label).join(', ') || 'Nothing selected'}</output>
    {open && <div className="fixture-flow" style={{ margin: '12px 0', paddingLeft: 44 }}><AddMenu paths={paths} steps={steps} usage={open === 'real' ? usage : null} added={picked.length ? picked.map(item => item.label) : []}
      label="Add a fixture step" dest="Inside the fixture repeat" onClose={close}
      onPick={(item, options) => { setPicked(current => [...current, item]); if (!options?.keep) close(true); }} /></div>}
  </main>;
}
createRoot(document.getElementById('root')).render(<Harness />);
const pause = () => new Promise(resolve => setTimeout(resolve, 30));
const wait = async (check, name) => { for (let i = 0; i < 150; i++) { if (check()) return; await pause(); } throw Error('Timed out: ' + name); };
const assert = (value, text) => { if (!value) throw Error(text); };
async function native(request) { return new Promise(resolve => { window.__searchRequest = request; window.__finishSearchRequest = () => { window.__searchRequest = null; resolve(); }; }); }
async function pointer(selector, text) { const element = [...document.querySelectorAll(selector)].find(node => text === undefined || node.textContent === text); assert(element, 'Missing pointer target ' + selector + ' ' + text); element.scrollIntoView({ block: 'nearest' }); const rect = element.getBoundingClientRect(); await native({ pointer: { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) } }); }
const key = (key, modifiers) => native({ key, modifiers });
const type = text => native({ text });
const options = () => [...document.querySelectorAll('.rt-add-menu [role="option"]')];
const names = () => options().map(option => option.querySelector('.rt-ch-t').textContent);
const range = () => document.querySelector('.rt-add-pages [role="status"]')?.textContent;
const input = () => document.querySelector('.rt-add-search input');
const active = () => document.getElementById(input()?.getAttribute('aria-activedescendant'));
const activeName = () => active()?.querySelector('.rt-ch-t').textContent;
const sections = () => [...document.querySelectorAll('.rt-add-list .rt-ch-sec')].map(element => element.textContent);
const crumb = () => document.querySelector('.rt-add-crumb')?.textContent;
const after = (name, count) => { const at = names().indexOf(name); return at < 0 ? '' : names().slice(at, at + count).join(); };
const clear = async () => { while (input()?.value) await key('Backspace'); };
const capture = name => native({ capture: name });
const results = [];
try {
  await wait(() => document.querySelector('button'), 'fixture mount');
  for (const width of [1440, 1100]) {
    await native({ resize: [width, width === 1440 ? 900 : 720] });
    // Home, one column: a short list of paths, this routine's commands, the steps, then the subsystems (diagnostics last
    // and dimmed). Only "In this routine" is a heading; the kinds are separated by rules.
    await pointer('button', 'Add a step'); await wait(() => input() && document.activeElement === input(), 'Add search focus');
    assert(sections().join() === 'In this routine', 'Home headings: ' + sections().join());
    assert(names().slice(0, 6).join() === 'Approach path 0,Approach path 1,Approach path 2,Approach path 3,Approach path 4,Show all 20 paths', 'Paths first, kept short: ' + names().slice(0, 6).join());
    assert(after('Intake Until Note', 2) === 'Intake Until Note,Shooter Spin Up Speaker', 'In this routine lists its commands');
    assert(after('Wait', 6) === 'Wait,Repeat,Parallel group,Sequential group,End routine,Exit repeat', 'Steps follow: ' + after('Wait', 6));
    assert(after('Arm', 13) === 'Arm,Climber,Drive,Elevator,Indexer,Intake,LEDs,Shooter,Superstructure,Utilities,Vision,SysId,Test', 'Subsystems are alphabetical, diagnostics last');
    assert(names().indexOf('Arm') > names().indexOf('Exit repeat'), 'The catalog is browsed last');
    assert(options().find(option => option.textContent.startsWith('Test')).classList.contains('dim'), 'Diagnostics are dimmed');
    assert(!range(), 'Home needs no paging');
    assert(!document.querySelector('.rt-add-filter, .rt-add-detail, .rt-add-dest, .rt-add-keys'), 'No filter, detail column, destination line or key footer');
    const menu = document.querySelector('.rt-add-menu').getBoundingClientRect();
    assert(menu.width <= 561 && document.querySelector('.rt-add-menu').closest('.fixture-flow'), 'Add is one inline column: ' + menu.width);
    await capture('home-' + width);
    // A search ranks: the matching subsystem leads, then name starts; the detail column describes the subsystem.
    await type('shoot');
    assert(names().slice(0, 4).join() === 'Shooter,Shooter Shoot When Ready,Shooter Shoot,Shoot Preload', 'Ranked shoot: ' + names().slice(0, 4).join());
    assert(options().length < 20 && names().includes('Show all 34 matching commands'), 'A search stays short');
    await capture('query-' + width);
    // → opens the subsystem: a chip in the search, rows without the repeated name, used commands first.
    await key('ArrowRight');
    await wait(() => crumb() === 'Shooter', 'ArrowRight opens Shooter');
    assert(input().value === '' && input().placeholder === 'Search Shooter', 'Scoped search names the subsystem');
    assert(sections().join() === 'Used in this project', 'Scoped headings: ' + sections().join());
    assert(names().slice(0, 3).join() === 'Spin Up Speaker,Shoot When Ready,Spin Up', 'Scoped rows drop the prefix: ' + names().slice(0, 3).join());
    assert(options()[0].getAttribute('aria-label') === 'Shooter Spin Up Speaker', 'Scoped rows keep the full name for assistive technology');
    await capture('scope-' + width);
    await type('hood');
    assert(names().join() === 'Hood Home,Hood Auto,Hood Zero,Hood To Angle', 'Scoped search: ' + names().join());
    await capture('scope-query-' + width);
    // Backspace on an empty search leaves the subsystem and returns to its row.
    await clear(); await key('Backspace');
    await wait(() => !crumb() && activeName() === 'Shooter', 'Backspace leaves the subsystem, back on its row');
    // Initials find a command; Ctrl+Enter adds it and keeps Add open for the next pick.
    await type('ssus');
    assert(names().join() === 'Shooter Spin Up Speaker', 'Initials: ' + names().join());
    await capture('initials-' + width);
    await key('Enter', ['control']);
    await wait(() => state.picked.length === 1 && input()?.value === '', 'Ctrl+Enter keeps Add open');
    assert(state.open === 'real' && document.activeElement === input(), 'Keep-open add leaves focus in the search');
    assert(document.querySelector('.rt-add-added').textContent === 'Added Shooter Spin Up Speaker. Keep adding, or press Esc when done.', 'Added status');
    await type('leds has'); await key('Enter', ['control']);
    await wait(() => state.picked.length === 2, 'second keep-open add');
    await type('vision w');
    await capture('keep-open-' + width);
    await key('Enter');
    await wait(() => !state.open && document.activeElement?.textContent === 'Add a step', 'Enter adds, closes and returns focus');
    assert(state.picked.map(item => item.label).join() === 'Shooter Spin Up Speaker,LEDs Has Note,Vision Wait For Target', 'Picks in order: ' + state.picked.map(item => item.label).join());
    // Tab on a subsystem or "Show all" opens it; Tab anywhere else closes Add and returns focus.
    await pointer('button', 'Add a step'); await type('arm'); await key('Tab');
    await wait(() => crumb() === 'Arm', 'Tab opens a subsystem');
    await key('Tab'); await wait(() => !state.open && document.activeElement?.textContent === 'Add a step', 'Tab inside a subsystem closes');
    await pointer('button', 'Add a step'); for (let index = 0; index < 5; index++) await key('Down');
    assert(activeName() === 'Show all 20 paths', 'Arrows reach Show all: ' + activeName());
    await key('Right'); await wait(() => crumb() === 'Paths' && options().length === 20, '→ opens every path');
    await key('Left'); await wait(() => !crumb() && activeName() === 'Show all 20 paths', '← returns to Show all');
    await key('Up'); await key('Tab');
    await wait(() => !state.open && document.activeElement?.textContent === 'Add a step', 'Tab dismiss/refocus');
    await pointer('button', 'Add a step'); await key('Escape');
    await wait(() => !state.open && document.activeElement?.textContent === 'Add a step', 'Escape dismiss/refocus');

    // Degenerate searches still page: 10,000 commands that all match.
    await pointer('button', 'Add from 10,000'); await wait(() => input() && document.activeElement === input(), '10,000 search focus');
    await type('command');
    await pointer('.rt-add-menu [role="option"]', 'Show all 10,000 matching commands');
    assert(crumb() === 'Commands' && document.activeElement === input(), 'Show all opens every command and keeps the search focused');
    assert(options().length === 80 && range() === '1–80 of 10,000', 'First page is bounded and counts every match');
    assert(options()[0].getAttribute('aria-setsize') === '10000' && options()[0].getAttribute('aria-posinset') === '1', 'Full logical ARIA positions');
    await capture('paged-' + width);
    await pointer('.rt-add-pages button', 'Next'); assert(range() === '81–160 of 10,000', 'Pointer Next changes page');
    await key('PageDown'); assert(range() === '161–240 of 10,000', 'PageDown changes page');
    await key('PageUp'); assert(range() === '81–160 of 10,000', 'PageUp changes page');
    await key('ArrowUp'); assert(active()?.getAttribute('aria-posinset') === '80' && range() === '1–80 of 10,000', 'ArrowUp crosses page boundary');
    await key('ArrowDown'); assert(active()?.getAttribute('aria-posinset') === '81', 'ArrowDown crosses page boundary');
    const last = () => /^(Needle9999|Refreshed command label)/.test(activeName() || '');
    await key('End'); assert(active().getAttribute('aria-posinset') === '10000', 'End reaches the last command');
    await key('ArrowDown'); assert(active()?.getAttribute('aria-posinset') === '1', 'ArrowDown wraps to first result');
    await key('Home'); assert(active()?.getAttribute('aria-posinset') === '1', 'Home reaches first result');
    // Programmatic focus is fixture setup only; activation is an actual native key event.
    document.querySelector('.rt-add-pages button[aria-label="Next results"]').focus();
    await key('Enter'); assert(range() === '81–160 of 10,000' && !state.picked.length, 'Pagination Enter changes page without choosing the active option');
    document.querySelector('.rt-add-pages button[aria-label="Next results"]').focus();
    await key('Space'); assert(range() === '161–240 of 10,000' && !state.picked.length, 'Pagination Space retains native button activation');
    // A background catalog update for the same search keeps the highlighted command and its page, so Enter never
    // inserts something else; the highlighted row shows the new definition.
    input().focus();
    const kept = active()?.getAttribute('aria-posinset');
    refreshCatalog(); await wait(() => options().some(option => option.textContent.startsWith('Command 161')), 'refresh settles'); await pause(); await pause();
    assert(active()?.getAttribute('aria-posinset') === kept && range() === '161–240 of 10,000', 'Catalog replacement keeps the highlight and page');
    await clear(); await type('Refreshed command label'); await wait(() => options().length === 1, 'Search finds a late refreshed command');
    assert(!document.querySelector('.rt-add-pages') && last(), 'Search spans the full refreshed catalog');
    await key('Enter'); assert(state.picked[0]?.kind === 'command' && state.picked[0].command.id === 'command.9999', 'Enter chooses the exact late command');
    await wait(() => document.activeElement?.textContent === 'Add from 10,000', 'selection returns focus');
    assert(document.querySelector('#fixture-path-command-value').textContent === refreshedLabel, 'Selected label updates without a stale catalog cache');
    await pointer('#fixture-path-command'); await wait(() => document.querySelector('#fixture-path-command-search') === document.activeElement, 'Dropdown search focus');
    assert(document.querySelectorAll('#fixture-path-command-listbox [role="option"]').length === 80, 'Ordinary picker remains bounded');
    await key('Enter'); assert(document.querySelector('.dropdown-panel'), 'Bare Enter cannot choose a command before searching');
    await type('Refreshed command label'); await key('ArrowDown');
    assert(document.activeElement?.id === 'fixture-path-command-search', 'Arrow keeps command search caret');
    await key('Enter'); await wait(() => !document.querySelector('.dropdown-panel'), 'Dropdown choice closes');

    await wait(() => state.inspectorCommand === byLabel('Shooter Feed'), 'inspector fixture reset');
    // Inspector Change: the same ranking and subsystems, opened on the current command's subsystem.
    await pointer('.choice-change'); await wait(() => document.querySelector('#fixture-inspector-command') === document.activeElement, 'Rich search focus');
    assert(document.querySelector('.choice-crumb')?.textContent === 'Shooter', 'Change opens on the current subsystem');
    const choiceNames = () => [...document.querySelectorAll('.choice-results [role="option"] strong')].map(element => element.textContent);
    // Commands used in the project lead, without the repeated subsystem name.
    assert(choiceNames()[0] === 'Spin Up Speaker' && choiceNames().length === 27, 'Scoped Change lists the subsystem: ' + choiceNames().slice(0, 3).join());
    await capture('inspector-' + width);
    await key('Backspace'); await wait(() => !document.querySelector('.choice-crumb'), 'Backspace leaves the subsystem in Change');
    await type('arm to'); assert(choiceNames()[0] === 'Arm To Angle', 'Change ranks like Add: ' + choiceNames().slice(0, 3).join());
    await key('ArrowDown'); await key('Enter');
    await wait(() => state.inspectorCommand === byLabel('Arm To Angle'), 'Change chooses a ranked command');
    resetInspector();
    results.push({ width, height: width === 1440 ? 900 : 720, ok: true, commands: realistic.length, paged: 10000 });
  }
  window.__searchResults = { passed: true, scenarios: results, fixtureOnly: true, noRobotCalls: true };
} catch (error) { window.__searchResults = { passed: false, scenarios: results, error: error.stack }; }
