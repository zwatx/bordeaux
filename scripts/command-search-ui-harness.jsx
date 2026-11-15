import React, { useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/renderer/styles/routine-workspace.css';
import '../src/renderer/styles/app.css';
import { AddMenu, addMenuSteps } from '../src/renderer/components/RoutinePanel';
import { UI } from '../src/renderer/components/ui';
import { commandChoices, inspectorCommandChoices } from '../src/renderer/lib/commandPick';

const commands = Array.from({ length: 10000 }, (_, index) => ({ id: `command.${index}`, label: index === 9999 ? 'Needle9999 · a very long intake command name with measured feedback and an exact completion result' : `Command ${index}`,
  member: `Subsystem/Commands/Command-${index}.vi`, description: 'Mechanism surface velocity and torque', semanticTags: ['mechanism'],
  parameters: [{ name: 'Speed', description: 'Measured surface velocity', label: 'Target speed', role: 'argument', unit: 'm/s', valueType: 'DBL' }],
  outputs: [{ name: 'Ready', schema: { kind: 'boolean', valueType: 'Boolean' } }, { name: 'Status', schema: { kind: 'enum', valueType: 'Enum', enumValues: ['Successful', 'Aborted', 'Incomplete'] } }] }));
const paths = Array.from({ length: 20 }, (_, index) => ({ id: `path.${index}`, name: `Approach path ${index}` }));
const routine = { nodes: [] }, where = { list: { kind: 'repeat', nodeId: 'fixture-repeat' } };
const refreshedLabel = 'Refreshed command label · a very long mechanism command with measured feedback and exact completion results';
let state, refreshCatalog;
function Harness() {
  const [catalog, setCatalog] = useState({ commands });
  const [open, setOpen] = useState(false), [picked, setPicked] = useState(null), [selected, setSelected] = useState('command.9999');
  const [frames, setFrames] = useState(0), anchor = useRef(null);
  const steps = useMemo(() => addMenuSteps(routine, where, catalog), [catalog]);
  const simple = commandChoices(catalog.commands, selected), rich = inspectorCommandChoices(catalog.commands, selected);
  state = { open, picked, selected, frames };
  refreshCatalog = () => setCatalog(current => ({ commands: current.commands.map(command => command.id === 'command.9999' ? { ...command, label: refreshedLabel } : command) }));
  const close = restore => { setOpen(false); if (restore) requestAnimationFrame(() => anchor.current?.focus()); };
  return <main style={{ padding: 24, maxWidth: 900 }}>
    <h1>Command search · isolated 10,000-command fixture</h1>
    <p>No NI, robot or transport is used. The menus and pickers are production components.</p>
    <div className="qrow"><button ref={anchor} className="qbtn" onClick={() => { setPicked(null); setOpen(true); }}>Add a step</button><button className="qbtn" onClick={() => setFrames(value => value + 1)}>Advance preview frame</button></div>
    <section style={{ maxWidth: 420 }}><UI.Dropdown id="fixture-path-command" label="Path command" value={selected} items={simple} searchThreshold={0} activateFirstMatch onChange={setSelected} />
      <UI.ChoiceBrowser id="fixture-inspector-command" label="Inspector command" value={selected} items={rich} onChange={setSelected} /></section>
    <output id="fixture-picked">{picked?.label || 'Nothing selected'}</output>
    {open && <AddMenu anchor={anchor.current} paths={paths} steps={steps} label="Add a fixture step" dest="Inside the fixture repeat" onClose={close} onPick={item => { setPicked(item); close(true); }} />}
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
const range = () => document.querySelector('.rt-add-pages [role="status"]')?.textContent;
const input = () => document.querySelector('.rt-add-search input');
const active = () => document.getElementById(input()?.getAttribute('aria-activedescendant'));
const filter = () => document.querySelector('.rt-add-filter [aria-pressed="true"]')?.textContent;
const sections = () => [...document.querySelectorAll('.rt-add-list .rt-ch-sec')].map(element => element.textContent);
const capture = name => native({ capture: name });
const results = [];
try {
  await wait(() => document.querySelector('button'), 'fixture mount');
  for (const width of [1440, 1100]) {
    await native({ resize: [width, width === 1440 ? 900 : 720] });
    await pointer('button', 'Add a step'); await wait(() => input() && document.activeElement === input(), 'Add search focus');
    // All: short Paths and Commands sections, each ending in a row that opens its full filter, then every step.
    assert(options().length === 16 && !range(), 'All shows short sections without paging');
    assert(options()[0].getAttribute('aria-setsize') === '16', 'All counts its own rows');
    assert(sections().join() === 'Paths,Commands,Steps', 'All names its sections');
    await key('End'); assert(active()?.textContent === 'Exit repeat', 'End reaches the last step in All');
    await capture('add-all-' + width);
    await pointer('.rt-add-menu [role="option"]', 'Show all 10,000 commands');
    assert(filter() === 'Commands' && document.activeElement === input(), 'Show all switches the filter and keeps the search focused');
    assert(options().length === 80 && range() === '1–80 of 10,000', 'First page is bounded and counts the full catalog');
    assert(options()[0].getAttribute('aria-setsize') === '10000' && options()[0].getAttribute('aria-posinset') === '1', 'Full logical ARIA positions');
    await capture('add-first-' + width);
    await pointer('.rt-add-pages button', 'Next'); assert(range() === '81–160 of 10,000', 'Pointer Next changes page');
    await key('PageDown'); assert(range() === '161–240 of 10,000', 'PageDown changes page');
    await key('PageUp'); assert(range() === '81–160 of 10,000', 'PageUp changes page');
    await key('ArrowUp'); assert(active()?.getAttribute('aria-posinset') === '80' && range() === '1–80 of 10,000', 'ArrowUp crosses page boundary');
    await key('ArrowDown'); assert(active()?.getAttribute('aria-posinset') === '81', 'ArrowDown crosses page boundary');
    // The last command is Needle9999 until the first pass refreshes its label.
    const last = () => /^(Needle9999|Refreshed command label)/.test(active()?.textContent || '');
    await key('End'); assert(last() && active().getAttribute('aria-posinset') === '10000', 'End reaches the last command');
    await capture('add-tail-' + width);
    await key('ArrowDown'); assert(active()?.getAttribute('aria-posinset') === '1', 'ArrowDown wraps to first result');
    await key('ArrowUp'); assert(last(), 'ArrowUp wraps to final result');
    await key('Home'); assert(active()?.getAttribute('aria-posinset') === '1', 'Home reaches first result');
    // Programmatic focus is fixture setup only; activation is an actual native key event.
    document.querySelector('.rt-add-pages button[aria-label="Next results"]').focus();
    await key('Enter'); assert(range() === '81–160 of 10,000' && !state.picked, 'Pagination Enter changes page without choosing the active option');
    document.querySelector('.rt-add-pages button[aria-label="Next results"]').focus();
    await key('Space'); assert(range() === '161–240 of 10,000' && !state.picked, 'Pagination Space retains native button activation');
    // A background catalog update for the same search keeps the highlighted command and its page, so Enter never
    // inserts something else; the highlighted row shows the new definition.
    await key('End'); refreshCatalog(); await wait(() => active()?.textContent.startsWith(refreshedLabel), 'new catalog keeps the highlighted command');
    assert(range() === '9,921–10,000 of 10,000' && active().getAttribute('aria-posinset') === '10000', 'Catalog replacement keeps active DOM/ARIA valid');
    await type('Refreshed command label'); await wait(() => options().length === 1, 'Search finds a late refreshed command');
    assert(!document.querySelector('.rt-add-pages') && options().every(option => option.textContent.includes('Refreshed command label')), 'Search spans the full refreshed catalog');
    await capture('add-long-search-' + width);
    await key('Enter'); assert(state.picked?.kind === 'command' && state.picked.command.id === 'command.9999', 'Enter chooses the exact late command');
    await wait(() => document.activeElement?.textContent === 'Add a step', 'selection returns focus');
    // Tab moves from the search to the filter; Tab past the filter dismisses and refocuses.
    await pointer('button', 'Add a step'); await key('End'); await key('Tab');
    assert(state.open && document.activeElement?.dataset.filter === 'all', 'Tab reaches the kind filter');
    await key('Tab');
    await wait(() => !state.open && document.activeElement?.textContent === 'Add a step', 'Tab dismiss/refocus');
    await pointer('button', 'Add a step'); await key('Escape');
    await wait(() => !state.open && document.activeElement?.textContent === 'Add a step', 'Escape dismiss/refocus');
    assert(document.querySelector('#fixture-path-command-value').textContent === refreshedLabel, 'Selected label updates without a stale catalog cache');
    await pointer('#fixture-path-command'); await wait(() => document.querySelector('#fixture-path-command-search') === document.activeElement, 'Dropdown search focus');
    assert(document.querySelectorAll('#fixture-path-command-listbox [role="option"]').length === 80, 'Ordinary picker remains bounded');
    await key('Enter'); assert(document.querySelector('.dropdown-panel'), 'Bare Enter cannot choose a command before searching');
    await type('Refreshed command label'); await key('ArrowDown');
    assert(document.activeElement?.id === 'fixture-path-command-search', 'Arrow keeps command search caret');
    await key('Enter'); await wait(() => !document.querySelector('.dropdown-panel'), 'Dropdown choice closes');
    await pointer('.choice-change'); await wait(() => document.querySelector('#fixture-inspector-command') === document.activeElement, 'Rich search focus');
    await type('surface torque'); assert(document.querySelectorAll('.choice-results [role="option"]').length === 80, 'Rich parameter search preserves AND terms and bounded rows');
    await key('Escape'); await key('Escape');
    await capture('refreshed-current-' + width);
    results.push({ width, height: width === 1440 ? 900 : 720, ok: true, options: 10000 });
  }
  window.__searchResults = { passed: true, scenarios: results, fixtureOnly: true, noRobotCalls: true };
} catch (error) { window.__searchResults = { passed: false, scenarios: results, error: error.stack }; }
