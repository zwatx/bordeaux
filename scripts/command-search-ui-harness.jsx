import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/renderer/styles/routine-workspace.css';
import '../src/renderer/styles/app.css';
import { SourceLibrary } from '../src/renderer/components/RoutineInsert';
import { UI } from '../src/renderer/components/ui';
import { commandChoices } from '../src/renderer/lib/commandPick';
import { commandChoiceItems, commandChoiceRows, commandIndex, commandUsage, openSubsystem } from '../src/renderer/lib/commandIndex';
import { commandCatalog187 } from '../tests/fixtures/commandCatalog187';

// A realistic 187-command catalog for the command library, and a degenerate 10,000-command catalog for batches and refresh.
const realistic = commandCatalog187.commands;
const byLabel = label => realistic.find(command => command.label === label).id;
const many = Array.from({ length: 10000 }, (_, index) => ({ id: `command.${index}`, label: index === 9999 ? 'Needle9999 · a very long intake command name with measured feedback and an exact completion result' : `Command ${index}`,
  member: `Subsystem/Commands/Command-${index}.vi`, description: 'Mechanism surface velocity and torque', semanticTags: ['mechanism'],
  parameters: [{ name: 'Speed', description: 'Measured surface velocity', label: 'Target speed', role: 'argument', unit: 'm/s', valueType: 'DBL' }],
  outputs: [{ name: 'Ready', schema: { kind: 'boolean', valueType: 'Boolean' } }, { name: 'Status', schema: { kind: 'enum', valueType: 'Enum', enumValues: ['Successful', 'Aborted', 'Incomplete'] } }] }));
const command = (id, label) => ({ id, type: 'function', cat: 'command', title: label, invocation: { commandId: byLabel(label), arguments: {} } });
const routine = { id: 'fixture-routine', nodes: [command('a', 'Intake Until Note'), command('b', 'Shooter Spin Up Speaker')] };
const usage = commandUsage([routine, { id: 'other', nodes: [command('c', 'Shooter Shoot When Ready')] }], [], routine);
const refreshedLabel = 'Refreshed command label · a very long mechanism command with measured feedback and exact completion results';
let state, refreshCatalog, resetInspector;
function Harness() {
  const [catalog, setCatalog] = useState({ commands: many });
  const [open, setOpen] = useState(null), [picked, setPicked] = useState([]), [selected, setSelected] = useState('command.9999');
  const [inspectorCommand, setInspectorCommand] = useState(byLabel('Shooter Feed'));
  const anchor = useRef(null), big = useRef(null);
  const simple = commandChoices(catalog.commands, selected);
  const index = commandIndex(realistic);
  state = { open, picked, selected, inspectorCommand };
  resetInspector = () => setInspectorCommand(byLabel('Shooter Feed'));
  refreshCatalog = () => setCatalog(current => ({ commands: current.commands.map(item => item.id === 'command.9999' ? { ...item, label: refreshedLabel } : item) }));
  const close = restore => { const from = open === 'many' ? big : anchor; setOpen(null); if (restore) requestAnimationFrame(() => from.current?.focus()); };
  return <main style={{ padding: '24px 24px 24px 300px', maxWidth: 1000 }}>
    <h1>Command search · isolated fixtures</h1>
    <p>187 realistic commands for the command library, 10,000 for batches. No NI, robot or transport is used. The library and pickers are production components.</p>
    <div className="qrow"><button ref={anchor} className="qbtn" onClick={() => { setPicked([]); setOpen('real'); }}>Add a step</button>
      <button ref={big} className="qbtn" onClick={() => { setPicked([]); setOpen('many'); }}>Add from 10,000</button></div>
    <section style={{ maxWidth: 420 }}><UI.Dropdown id="fixture-path-command" label="Path command" value={selected} items={simple} searchThreshold={0} activateFirstMatch onChange={setSelected} />
      <UI.ChoiceBrowser id="fixture-inspector-command" label="Inspector command" value={inspectorCommand} items={commandChoiceItems(realistic)} onChange={setInspectorCommand}
        search={(query, scope) => commandChoiceRows(index, query, scope, usage)} openScope={openSubsystem(index, inspectorCommand)} scopeName={key => index.bySubsystem.get(key)?.name || key} /></section>
    <output id="fixture-picked">{picked.map(item => item.label).join(', ') || 'Nothing selected'}</output>
    {/* The library in a rail of the app's left-rail size, as Add shows it beside the flow. */}
    {open && <div className="rt-source-host fixture-rail" style={{ position: 'fixed', left: 0, top: 0, bottom: 0 }}><SourceLibrary key={open} kind="command" mode="insert" title="Add command" dest="Inside the fixture repeat"
      catalog={open === 'many' ? catalog : commandCatalog187} usage={open === 'real' ? usage : null} autoFocus onClose={close} onBack={() => close(true)}
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
const rows = () => [...document.querySelectorAll('#rt-source [data-row]')];
const name = row => row.querySelector('.rt-src-name, .rt-src-group-name')?.textContent ?? row.firstChild?.textContent;
const names = () => rows().map(name);
const input = () => document.querySelector('#rt-source input');
const focused = () => document.activeElement?.dataset?.row;
const labels = () => [...document.querySelectorAll('#rt-source .rt-src-label')].map(element => element.textContent);
const after = (text, count) => { const at = names().indexOf(text); return at < 0 ? '' : names().slice(at, at + count).join(); };
const clear = async () => { while (input()?.value) await key('Backspace'); };
const capture = name => native({ capture: name });
const results = [];
try {
  await wait(() => document.querySelector('button'), 'fixture mount');
  for (const width of [1440, 1100]) {
    await native({ resize: [width, width === 1440 ? 900 : 720] });
    // Home: this routine's commands, then every subsystem closed with its count, alphabetical with diagnostics last and
    // dimmed. The search is focused but secondary; the library lives in a rail beside the flow, not in it.
    await pointer('button', 'Add a step'); await wait(() => input() && document.activeElement === input(), 'library search focus');
    assert(labels().join() === 'In this routine', 'Home labels: ' + labels().join());
    assert(names().slice(0, 2).join() === 'Intake Until Note,Shooter Spin Up Speaker', 'In this routine lists its commands: ' + names().slice(0, 2).join());
    assert(after('Arm', 13) === 'Arm,Climber,Drive,Elevator,Indexer,Intake,LEDs,Shooter,Superstructure,Utilities,Vision,SysId,Test', 'Subsystems are alphabetical, diagnostics last: ' + after('Arm', 13));
    assert(rows().filter(row => row.dataset.group).every(row => row.getAttribute('aria-expanded') === 'false'), 'Subsystems start closed');
    assert(rows().find(row => name(row) === 'Test').classList.contains('dim'), 'Diagnostics are dimmed');
    const rail = document.querySelector('#rt-source').getBoundingClientRect();
    assert(rail.width >= 263 && rail.width <= 264 && rail.height >= 600, 'The library fills the 264px rail (inside its border): ' + rail.width + 'x' + rail.height);
    await capture('home-' + width);
    // A search ranks as one list that keeps subsystem names; the top match is marked for Enter.
    await type('shoot');
    assert(names().slice(0, 3).join() === 'Shooter Shoot When Ready,Shooter Shoot,Shoot Preload', 'Ranked shoot: ' + names().slice(0, 3).join());
    assert(rows()[0].classList.contains('top') && rows().length <= 61, 'Top match marked, results bounded');
    await capture('query-' + width);
    // Browsing by subsystem: Escape clears the search, ↓ enters the list, a click opens Shooter in place.
    await key('Escape'); assert(input().value === '' && document.activeElement === input(), 'Escape clears the search first');
    await pointer('#rt-source [data-row="subsystem:shooter"]');
    await wait(() => document.querySelector('[data-row="subsystem:shooter"]').getAttribute('aria-expanded') === 'true', 'Shooter opens');
    assert(after('Shooter', 4) === 'Shooter,Spin Up Speaker,Shoot When Ready,Spin Up', 'Open subsystem lists used commands first without the repeated name: ' + after('Shooter', 4));
    assert(document.querySelector('[data-row="command:' + byLabel('Shooter Spin Up Speaker') + '"]').getAttribute('aria-label').startsWith('Shooter Spin Up Speaker'), 'Rows keep the full name for assistive technology');
    await capture('scope-' + width);
    // Arrows: ← closes the subsystem, → opens it, → again enters its first command, ← returns to the subsystem.
    await key('ArrowLeft'); await wait(() => document.querySelector('[data-row="subsystem:shooter"]').getAttribute('aria-expanded') === 'false', '← closes');
    await key('ArrowRight'); await wait(() => document.querySelector('[data-row="subsystem:shooter"]').getAttribute('aria-expanded') === 'true', '→ opens');
    await key('ArrowRight'); assert(focused() === 'command:' + byLabel('Shooter Spin Up Speaker'), '→ enters the first command: ' + focused());
    await key('ArrowDown'); assert(focused() === 'command:' + byLabel('Shooter Shoot When Ready'), '↓ moves: ' + focused());
    await key('ArrowLeft'); assert(focused() === 'subsystem:shooter', '← returns to the subsystem');
    // Typing from a row goes to the search: initials find a command; Ctrl+Enter adds it and keeps the library open.
    await key('s'); await type('sus');
    await wait(() => document.activeElement === input() && input().value === 'ssus', 'typing returns to the search');
    assert(names().join() === 'Shooter Spin Up Speaker', 'Initials: ' + names().join());
    await capture('initials-' + width);
    await key('Enter', ['control']);
    await wait(() => state.picked.length === 1 && input()?.value === '', 'Ctrl+Enter keeps the library open');
    assert(state.open === 'real' && document.activeElement === input(), 'Keep-open add leaves focus in the search');
    await type('leds has'); await key('Enter', ['control']);
    await wait(() => state.picked.length === 2, 'second keep-open add');
    await type('vision w');
    await capture('keep-open-' + width);
    await key('Enter');
    await wait(() => !state.open && document.activeElement?.textContent === 'Add a step', 'Enter adds, closes and returns focus');
    assert(state.picked.map(item => item.label).join() === 'Shooter Spin Up Speaker,LEDs Has Note,Vision Wait For Target', 'Picks in order: ' + state.picked.map(item => item.label).join());
    // A click on a command adds it; Tab leaves the library; Escape on an empty search closes it.
    await pointer('button', 'Add a step'); await pointer('#rt-source [data-row="subsystem:arm"]');
    await pointer('#rt-source [data-row="command:' + byLabel('Arm To Angle') + '"]');
    await wait(() => !state.open && state.picked.at(-1)?.label === 'Arm To Angle', 'one click adds');
    await pointer('button', 'Add a step'); await key('Down'); await key('Tab');
    await wait(() => !state.open && document.activeElement?.textContent === 'Add a step', 'Tab leaves the library');
    await pointer('button', 'Add a step'); await key('Escape');
    await wait(() => !state.open && document.activeElement?.textContent === 'Add a step', 'Escape dismiss/refocus');

    // A degenerate catalog without subsystems lists its commands a batch at a time.
    await pointer('button', 'Add from 10,000'); await wait(() => input() && document.activeElement === input(), '10,000 search focus');
    assert(rows().length === 61 && names().at(-1) === 'Show 240 more', 'First batch is bounded: ' + rows().length + ' ' + names().at(-1));
    assert(rows().at(-1).textContent.includes('9,940 not shown'), 'The batch row counts what is not shown');
    await capture('batched-' + width);
    await pointer('#rt-source .rt-src-more');
    await wait(() => rows().length === 301, 'Show more adds the next batch');
    assert(focused() === 'command:command.60', 'Focus moves to the first newly shown command: ' + focused());
    await key('c'); await type('ommand 16');
    await wait(() => document.activeElement === input() && input().value === 'command 16', 'typing from a row searches');
    assert(rows().length === 61, 'A search is bounded too');
    // A background catalog update for the same search keeps the focused command, so Enter never adds something else.
    await key('Down'); await key('Down');
    const kept = focused();
    refreshCatalog(); await pause(); await pause(); await pause();
    assert(focused() === kept, 'Catalog replacement keeps the focused command: ' + focused() + ' vs ' + kept);
    input().focus(); await clear(); await type('Refreshed command label'); await wait(() => rows().length === 1, 'Search finds a late refreshed command');
    assert(name(rows()[0]).startsWith('Refreshed command label'), 'Search spans the full refreshed catalog');
    await key('Enter'); assert(state.picked.at(-1)?.kind === 'command' && state.picked.at(-1).command.id === 'command.9999', 'Enter chooses the exact late command');
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
