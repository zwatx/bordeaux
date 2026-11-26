import * as React from 'react';
import { COMMAND_LABELS, MENU_COMMANDS, commandKeys, editCommandKeys, keyFromEvent } from '../../core/keyBindings';
import { canEditKeys, currentUserKeyRules, formatKey, isMacPlatform, keyLabels, saveKeyRules, setKeyRecording, useKeyRules } from '../lib/keyBindings';
import { modifierName } from '../lib/shortcuts';
import { UI } from './ui';
const h = React.createElement;

// Commands by where they work, in dialog order.
const GROUPS = [
  ['Paths editor', ['tool.select', 'tool.waypoint', 'tool.rotation', 'tool.command', 'tool.zone', 'view.fit', 'view.grid', 'view.focusField', 'visit.next', 'visit.previous']],
  ['Paths and routines', ['playback.toggle', 'edit.undo', 'edit.redo']],
  ['Project and robot', ['project.new', 'project.list', 'project.openFile', 'project.save', 'project.saveCopy', 'export.bdx', 'robot.push']],
];
// Keys that can't be rebound: selection editing, library rename and mouse modifiers.
const FIXED_KEYS = [
  ['Delete an item', 'Shift-click'], ['Delete selection', 'Delete / Backspace'], ['Cancel / select tool', 'Esc'], ['Move selection', 'Arrow keys'],
  ['Larger move', 'Shift + arrows'], ['Fine waypoint move', 'Alt + arrows'], ['Rename library item', 'F2'],
];

// Set while the dialog is mounted, so global settings can open it ready to edit.
let openDialog = null;
/** Opens the shortcuts dialog; `edit` starts in editing where the host can store keys. */
export function openKeyboardShortcuts(edit = false) { openDialog?.(edit); }

/** A sentence for a key that was moved from other commands, naming what each still has. */
function takenText(taken, rules) {
  return taken.map(({ command, key }) => {
    const rest = commandKeys(rules, command).map(formatKey);
    return formatKey(key) + ' was ' + COMMAND_LABELS[command] + "'s key. " + COMMAND_LABELS[command] + (rest.length ? ' still has ' + rest.join(' and ') + '.' : ' has no key now.');
  }).join(' ');
}

function problemText(problem, command, key) {
  if (problem.kind === 'needs-mod') return COMMAND_LABELS[command] + ' works while you type, so its key needs ' + modifierName() + '.';
  return formatKey(key) + ' is reserved for Bordeaux. Pick another key.';
}

/**
 * The toolbar's ? button and the shortcuts dialog. It opens read-only; where the host can store keys, the pencil turns
 * the same rows into editable keys without moving them. Clicking a key records the next key pressed. Keys are saved
 * through the host at once, and a key taken from another command shows a notice with Undo.
 */
export function KeyboardHelp() {
  useKeyRules();
  const dialog = React.useRef(null), trigger = React.useRef(null), returnTo = React.useRef(null), focusNext = React.useRef(null), saving = React.useRef(false);
  const [editing, setEditing] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [recording, setRecording] = React.useState(null); // { command, index }; index -1 adds a key
  const [note, setNote] = React.useState(null); // { command, tone, text, undo? }
  const editable = canEditKeys(), userRules = currentUserKeyRules();

  const open = (edit) => {
    returnTo.current = document.activeElement;
    setEditing(edit && editable); setRecording(null); setNote(null); setQuery('');
    if (!dialog.current.open) dialog.current.showModal();
  };
  React.useEffect(() => { openDialog = open; return () => { if (openDialog === open) openDialog = null; }; });
  const close = () => {
    setRecording(null); dialog.current?.close();
    (returnTo.current?.isConnected ? returnTo.current : trigger.current)?.focus();
  };
  // While a key is being recorded, the desktop's File menu stops catching keys.
  React.useEffect(() => {
    if (!recording) return undefined;
    setKeyRecording(true);
    dialog.current?.querySelector('[data-recording]')?.focus();
    return () => setKeyRecording(false);
  }, [recording]);
  // Focus a key or the row's add button after the render that shows it. A save re-renders later, so it focuses again.
  const focusSoon = (command, index) => {
    focusNext.current = { command, index };
  };
  const focusWanted = () => {
    const want = focusNext.current, root = dialog.current;
    if (!want || !root) return;
    (root.querySelector('[data-command="' + want.command + '"][data-index="' + want.index + '"]')
      || root.querySelector('[data-add="' + want.command + '"]') || root.querySelector('.kh-edit'))?.focus();
  };
  // Kept while a save is in flight, whose render shows the new key; cleared otherwise so later renders leave focus alone.
  React.useEffect(() => { focusWanted(); if (!saving.current) focusNext.current = null; });
  const failed = (command) => () => setNote({ command, tone: 'bad', text: 'Bordeaux could not save the keys. Try again.' });
  const save = (rules, command) => {
    saving.current = true;
    return saveKeyRules(rules).catch(failed(command)).finally(() => {
      saving.current = false;
      setTimeout(() => { focusWanted(); focusNext.current = null; }, 0);
    });
  };

  const apply = (command, keys, key) => {
    const before = currentUserKeyRules(), edit = editCommandKeys(before, command, keys);
    if (edit.problem) { setNote({ command, tone: 'bad', text: problemText(edit.problem, command, key) }); return; }
    setNote(edit.taken.length ? { command, tone: 'warn', text: takenText(edit.taken, edit.rules), undo: before } : null);
    void save(edit.rules, command);
  };
  const record = (event) => {
    const { command, index } = recording;
    if (event.key === 'Tab') { setRecording(null); return; }
    event.preventDefault(); event.stopPropagation();
    if (event.repeat || event.nativeEvent.isComposing) return;
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    const keys = commandKeys(currentUserKeyRules(), command);
    if (event.key === 'Escape' && plain) { setRecording(null); focusSoon(command, index); return; }
    if ((event.key === 'Backspace' || event.key === 'Delete') && plain && index >= 0) {
      setRecording(null); focusSoon(command, -1);
      apply(command, keys.filter((_, at) => at !== index), keys[index]);
      return;
    }
    const mac = isMacPlatform();
    if (!mac && event.nativeEvent.getModifierState?.('AltGraph') && !keyFromEvent(event, mac)) {
      setRecording(null); focusSoon(command, index);
      setNote({ command, tone: 'bad', text: 'Keys typed with AltGr make characters, so they can\'t be shortcuts. Pick another key.' });
      return;
    }
    const key = keyFromEvent(event, mac);
    if (!key) return; // A lone modifier: keep waiting for the key.
    const next = [...keys];
    if (index >= 0) next[index] = key; else next.push(key);
    const unique = next.filter((value, at) => next.indexOf(value) === at);
    setRecording(null);
    focusSoon(command, MENU_COMMANDS.has(command) ? 0 : Math.max(0, unique.indexOf(key)));
    apply(command, unique, key);
  };

  const icon = (name, label, props) => h('button', { type: 'button', className: 'kh-icon', 'aria-label': label, title: label, ...props }, h(UI.Icon, { name, size: 14 }));
  const row = (id) => {
    const changed = userRules.some((rule) => rule.command === id);
    const keys = editing ? commandKeys(userRules, id).map(formatKey) : keyLabels(id);
    const live = recording?.command === id ? recording : null;
    const message = live ? { tone: '', text: 'Press the new key. Esc cancels.' + (live.index >= 0 ? ' Backspace removes this key.' : '') } : note?.command === id ? note : null;
    const chip = (label, index) => !editing ? h('kbd', { key: index }, label)
      : h('button', { key: index, type: 'button', className: 'kh-chip', 'data-command': id, 'data-index': index, 'data-recording': live?.index === index || undefined,
        'aria-label': COMMAND_LABELS[id] + ', key ' + label + '. Change', onClick: () => { setNote(null); setRecording(live?.index === index ? null : { command: id, index }); },
        onKeyDown: live?.index === index ? record : undefined, onBlur: live?.index === index ? () => setRecording(null) : undefined }, live?.index === index ? 'Press a key' : label);
    return h('div', { key: id, className: 'kh-row' },
      h('span', null, COMMAND_LABELS[id]),
      h('span', { className: 'kh-keys' },
        changed && h('span', { className: 'kh-dim' }, 'Changed'),
        keys.map(chip),
        live?.index === -1 && h('button', { type: 'button', className: 'kh-chip', 'data-recording': true, onKeyDown: record, onBlur: () => setRecording(null) }, 'Press a key'),
        !keys.length && !live && h('span', { className: 'kh-dim' }, 'No key'),
        // The icon slots stay in read-only view too, so the keys don't move when editing starts.
        // File menu items show one key, so they offer no second one.
        editable && (editing && !MENU_COMMANDS.has(id) ? icon('plus', 'Add a key for ' + COMMAND_LABELS[id], { 'data-add': id, onClick: () => { setNote(null); setRecording({ command: id, index: -1 }); } })
          : h('span', { className: 'kh-icon kh-space' })),
        editable && (editing && changed ? icon('rotateccw', 'Use the default keys for ' + COMMAND_LABELS[id], { onClick: () => { focusSoon(id, 0); apply(id, null, ''); } })
          : h('span', { className: 'kh-icon kh-space' }))),
      message && h('div', { className: 'kh-note ' + message.tone }, message.text,
        message.undo && h('button', { type: 'button', onClick: () => { const undo = message.undo; setNote(null); focusSoon(id, 0); void save(undo, id); } }, 'Undo')));
  };

  const q = query.trim().toLowerCase();
  const matches = (id) => !q || COMMAND_LABELS[id].toLowerCase().includes(q) || keyLabels(id).some((label) => label.toLowerCase().includes(q));
  const groups = GROUPS.map(([title, ids]) => [title, ids.filter(matches)]).filter(([, ids]) => ids.length);
  const fixed = FIXED_KEYS.filter(([label, keys]) => !q || label.toLowerCase().includes(q) || keys.toLowerCase().includes(q));
  return h(React.Fragment, null,
    h('button', { ref: trigger, type: 'button', className: 'qbtn keyboard-help-trigger tb-icon', 'aria-label': 'Keyboard shortcuts', title: 'Keyboard shortcuts', onClick: () => open(false) }, '?'),
    h('dialog', { ref: dialog, className: 'keyboard-help', 'aria-labelledby': 'keyboard-help-title', onCancel: (event) => { event.preventDefault(); close(); }, onClick: (event) => { if (event.target === event.currentTarget) { const b = event.currentTarget.getBoundingClientRect(); if (event.clientX < b.left || event.clientX > b.right || event.clientY < b.top || event.clientY > b.bottom) close(); } } },
      h('header', null, h('h2', { id: 'keyboard-help-title' }, 'Keyboard shortcuts'),
        h('span', { className: 'kh-actions' },
          editable && h('button', { type: 'button', className: 'kh-edit', 'aria-pressed': editing, 'aria-label': 'Edit shortcuts', title: editing ? 'Stop editing' : 'Edit shortcuts',
            onClick: () => { setRecording(null); setNote(null); setEditing(!editing); } }, h(UI.Icon, { name: 'edit', size: 15 })),
          h('button', { type: 'button', 'aria-label': 'Close keyboard shortcuts', onClick: close }, '×'))),
      h('div', { className: 'kh-tools' },
        h('input', { type: 'search', className: 'textinput', placeholder: 'Search shortcuts', 'aria-label': 'Search shortcuts', value: query, onChange: (event) => setQuery(event.target.value) }),
        editing && h('button', { type: 'button', className: 'qbtn quiet', disabled: !userRules.length, onClick: () => { setNote(null); void save([], '*'); } }, 'Use default keys')),
      note?.command === '*' && h('div', { className: 'kh-note bad' }, note.text),
      // One live region announces the current prompt or notice; the visible copies sit beside their keys.
      h('div', { className: 'sr-only', role: 'status' }, recording ? 'Press the new key for ' + COMMAND_LABELS[recording.command] + '. Esc cancels.' : note?.text || ''),
      groups.map(([title, ids]) => h(React.Fragment, { key: title }, h('h3', { className: 'kh-group' }, title), ids.map(row))),
      fixed.length > 0 && h('h3', { className: 'kh-group' }, "Keys you can't change"),
      fixed.map(([label, keys]) => h('div', { key: label, className: 'kh-row' }, h('span', null, label), h('span', { className: 'kh-keys' }, h('kbd', null, keys),
        editable && h('span', { className: 'kh-icon kh-space' }), editable && h('span', { className: 'kh-icon kh-space' })))),
      !groups.length && !fixed.length && h('p', null, 'No shortcut matches "' + query.trim() + '".'),
      editing
        ? h('div', { className: 'kh-foot' }, h('span', null, 'Click a key, then press the new one. Keys are saved on this computer.'),
          h('button', { type: 'button', className: 'qbtn primary', onClick: () => { setRecording(null); setNote(null); setEditing(false); focusNext.current = { command: '', index: 0 }; } }, 'Done'))
        : h('p', null, modifierName() + '-click selects multiple paths in the library. Shift-click deletes an item.')));
}
