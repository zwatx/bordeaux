import * as React from 'react';
import { COMMAND_IDS, COMMAND_LABELS } from '../../core/keyBindings';
import { keyLabels } from '../lib/keyBindings';
import { modifierName } from '../lib/shortcuts';
const h = React.createElement;
// Keys that can't be rebound: selection editing, library rename and mouse modifiers.
const FIXED_KEYS = [
  ['Delete an item', 'Shift-click'], ['Delete selection', 'Delete / Backspace'], ['Cancel / select tool', 'Esc'], ['Move selection', 'Arrow keys'],
  ['Larger move', 'Shift + arrows'], ['Fine waypoint move', 'Alt + arrows'], ['Rename library item', 'F2'],
];
export function KeyboardHelp() {
  const dialog = React.useRef(null), trigger = React.useRef(null);
  const close = () => { dialog.current?.close(); trigger.current?.focus(); };
  const shortcuts = [
    ...COMMAND_IDS.map((id) => [COMMAND_LABELS[id], keyLabels(id).join(' or ')]).filter(([, keys]) => keys),
    ...FIXED_KEYS,
  ];
  return h(React.Fragment, null,
    h('button', { ref: trigger, type: 'button', className: 'qbtn keyboard-help-trigger', 'aria-label': 'Keyboard shortcuts', title: 'Keyboard shortcuts', onClick: () => dialog.current.showModal() }, '?'),
    h('dialog', { ref: dialog, className: 'keyboard-help', 'aria-labelledby': 'keyboard-help-title', onCancel: (event) => { event.preventDefault(); close(); }, onClick: (event) => { if (event.target === event.currentTarget) { const b = event.currentTarget.getBoundingClientRect(); if (event.clientX < b.left || event.clientX > b.right || event.clientY < b.top || event.clientY > b.bottom) close(); } } },
      h('header', null, h('h2', { id: 'keyboard-help-title' }, 'Keyboard shortcuts'), h('button', { type: 'button', 'aria-label': 'Close keyboard shortcuts', onClick: close }, '×')),
      h('table', null, h('tbody', null, shortcuts.map(([label, keys]) => h('tr', { key: label }, h('td', null, label), h('td', null, h('kbd', null, keys)))))),
      h('p', null, modifierName() + '-click selects multiple paths in the library. Shift-click deletes an item.')));
}
