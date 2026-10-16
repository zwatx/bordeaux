import React from 'react';
import { createRoot } from 'react-dom/client';
import { UI } from '../src/renderer/components/ui';
import { CommandParameterEditor } from '../src/renderer/components/ContextInspector';
import { StepInspector } from '../src/renderer/components/RoutineInspector';
import { AUTO } from '../src/renderer/lib/routineModel';
import { flushSync } from 'react-dom';
import { commitFocusedDraft, flushFocusedProjectDraft } from '../src/renderer/lib/draftPersistence';
import '../src/renderer/styles/app.css';
import '../src/renderer/styles/robot-push.css';
import '../src/renderer/styles/inspector-refresh.css';
import '../src/renderer/styles/routine-workspace.css';
const h = React.createElement;
function Harness() {
  const [value, setValue] = React.useState('0');
  const [short, setShort] = React.useState('Alpha');
  const [num, setNum] = React.useState(0.8128);
  const [parameter, setParameter] = React.useState(2);
  const [which, setWhich] = React.useState('a');
  const [disabled, setDisabled] = React.useState(false);
  const [speed, setSpeed] = React.useState(1);
  const [scrubCommits, setScrubCommits] = React.useState(0);
  const [scrubMounted, setScrubMounted] = React.useState(true);
  const [names, setNames] = React.useState({ a: 'Intake', b: 'Shooter' });
  const [owner, setOwner] = React.useState('a');
  const [nameCommits, setNameCommits] = React.useState(0);
  // Opt-in first-match choosers: `pickOpen` is read only when `pickKey` remounts them.
  const [pickKey, setPickKey] = React.useState(0);
  const [pickOpen, setPickOpen] = React.useState(false);
  const [picked, setPicked] = React.useState('');
  const [picks, setPicks] = React.useState(0);
  const pick = (v) => { setPicked(v); setPicks((count) => count + 1); };
  const pickItems = ['Start intake', 'Stop intake', 'Shoot note', 'Climb'].map((v) => ({ value: v, label: v }));
  // Field gestures prevent the default focus change, as FieldView does.
  const keepFocus = (event) => event.preventDefault();
  const nodes = ['a', 'b'].map((id) => ({ id, type: 'function', cat: 'command', title: id, invocation: { commandId: 'test', arguments: { amount: 2 } } }));
  const command = { id: 'test', label: 'Shared command', member: 'Test.vi', parameters: [{ name: 'amount', label: 'Amount', role: 'argument', schema: { kind: 'number', valueType: 'DBL' } }], labviewConnector: {} };
  return h('main', { className: 'app', style: { padding: 30, display: 'grid', gridTemplateColumns: 'minmax(300px, 480px) minmax(300px, 480px)', gap: 24, height: '100vh', overflow: 'auto', alignContent: 'start' } },
    h('section', null,
      h('h2', null, 'Shared controls'),
      h(UI.Dropdown, { id: 'search-choice', label: 'Searchable choices', value, onChange: setValue, disabled, allowCustom: true,
        items: Array.from({ length: 120 }, (_, i) => ({ value: String(i), label: `Option ${String(i).padStart(3, '0')}`, meta: i === 101 ? 'Long readable item name and description that wraps within the picker' : 'Choice description' })) }),
      h('button', { id: 'after-search', onClick: () => setDisabled((v) => !v) }, 'Toggle availability'),
      h(UI.Dropdown, { id: 'short-choice', label: 'Short choices', value: short, onChange: setShort, items: ['Alpha', 'Beta', 'Gamma'].map((v) => ({ value: v, label: v })) }),
      h(UI.Dropdown, { id: 'unknown-choice', label: 'Saved unavailable choice', value: 'retired-value', onChange: () => {}, items: [{ value: 'new', label: 'New value' }] }),
      h(UI.Num, { label: 'Precise width', value: num, onChange: setNum, unit: 'm' }),
      h('output', { id: 'canonical-width' }, String(num)),
      scrubMounted && h(UI.Num, { label: 'Scrub speed', value: speed, unit: 'm/s', onChange: (value) => { setSpeed(value); setScrubCommits((count) => count + 1); } }),
      h('output', { id: 'scrub-speed' }, String(speed)), h('output', { id: 'scrub-commits' }, String(scrubCommits)),
      // Save flushes drafts without moving focus first, as the keyboard shortcut does.
      h('button', { id: 'save-drafts', onPointerDown: keepFocus, onMouseDown: keepFocus, onClick: () => flushFocusedProjectDraft(document, flushSync) }, 'Save'),
      h('button', { id: 'toggle-scrub', onClick: () => setScrubMounted((mounted) => !mounted) }, 'Toggle scrub field'),
      h('label', { className: 'fieldlabel', htmlFor: 'draft-name' }, 'Draft name'),
      h(UI.DraftText, { id: 'draft-name', className: 'textinput', value: names[owner], owner,
        onCommit: (name) => { setNames((current) => ({ ...current, [owner]: name })); setNameCommits((count) => count + 1); } }),
      h('button', { id: 'owner-b', onClick: () => setOwner('b') }, 'Owner B'),
      h('button', { id: 'owner-a-field', onPointerDown: keepFocus, onMouseDown: keepFocus, onClick: () => { commitFocusedDraft(); setOwner('a'); } }, 'Field select A'),
      h('button', { id: 'owner-b-raw', onPointerDown: keepFocus, onMouseDown: keepFocus, onClick: () => setOwner('b') }, 'Raw select B'),
      h('output', { id: 'draft-names' }, JSON.stringify(names)), h('output', { id: 'name-commits' }, String(nameCommits)),
      h(CommandParameterEditor, { id: 'parameter', label: 'Numeric argument', schema: { kind: 'number', valueType: 'DBL' }, value: parameter, onChange: setParameter }),
      h('output', { id: 'parameter-value' }, String(parameter)),
      h('div', { className: 'seg' }, h('span', { className: 'seg-indicator' }), h('button', { className: 'seg-i' }, 'First'), h('button', { className: 'seg-i' }, 'Second')),
      h('div', { className: 'robot-push-status' }, h('span', { className: 'robot-push-spinner' }), 'Connecting…')),
    h('section', null,
      h('button', { id: 'select-a', onClick: () => setWhich('a') }, 'Command A'),
      h('button', { id: 'select-b', onClick: () => setWhich('b') }, 'Command B'),
      h(StepInspector, { node: nodes.find((node) => node.id === which), paths: [], run: { segs: [] },
        acq: { outcomes: {}, set: () => {}, select: () => {}, del: () => {} }, robotProject: { catalog: { projectName: 'Fixture', commands: [command] } } }),
      h(UI.Dropdown, { key: 'first:' + pickKey, id: 'first-match-choice', label: 'First match choices', value: picked, placeholder: 'No command', items: pickItems,
        searchThreshold: 0, activateFirstMatch: true, defaultOpen: pickOpen, onChange: pick }),
      h(UI.Dropdown, { key: 'short:' + pickKey, id: 'first-match-short', label: 'First match short', value: picked, placeholder: 'No command', items: pickItems.slice(0, 3),
        activateFirstMatch: true, onChange: pick }),
      h('button', { id: 'first-match-request', onClick: () => setPickOpen(true) }, 'Request open'),
      h('button', { id: 'first-match-remount', onClick: () => setPickKey((k) => k + 1) }, 'Remount choosers'),
      h('output', { id: 'first-match-picks' }, String(picks)), h('output', { id: 'first-match-value' }, picked)));
}
createRoot(document.getElementById('root')).render(h(Harness));
