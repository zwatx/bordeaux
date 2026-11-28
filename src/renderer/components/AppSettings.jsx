import * as React from 'react';
import { UI } from './ui';
import { openKeyboardShortcuts } from './KeyboardHelp';
import { canEditKeys, currentUserKeyRules, isMacPlatform, useKeyRules } from '../lib/keyBindings';
import { FieldScrollPrefs, useFieldScrollMode } from '../lib/fieldScroll';
import '../styles/settings.css';

const h = React.createElement;
// Update phases with notes to show; any other phase checks for updates instead.
const UPDATE_NOTES = ['available', 'downloading', 'downloaded', 'installing', 'error'];
const UPDATE_STATUS = { available: ' · Update available', downloading: ' · Downloading update', downloaded: ' · Ready to install' };

const Row = ({ label, status, children }) => h('div', { className: 'settings-row' },
  h('div', { className: 'settings-label' }, h('strong', null, label)),
  h('div', { className: 'settings-control' }, status && h('span', { className: 'settings-status' }, status), children));

/**
 * The toolbar's gear and the Global settings dialog: preferences kept on this computer for every project. The project's
 * robots, and where each one connects, stay on the Robot page. Shortcuts and updates open their own dialogs, so this
 * one closes first and those return focus to the gear.
 */
export function AppSettings({ unitSystem, setUnitSystem, updateState, onOpenUpdates, onCheckUpdates, onCloseUpdates }) {
  useKeyRules();
  const fieldScroll = useFieldScrollMode();
  const dialog = React.useRef(null), trigger = React.useRef(null);
  // An update panel opened from here treats the gear as its opener and ignores presses on it, so opening hides the panel.
  const open = () => { if (!dialog.current.open) dialog.current.showModal(); if (updateState?.visible) onCloseUpdates?.(); };
  const close = () => { dialog.current?.close(); trigger.current?.focus(); };
  const handOff = (action) => () => { close(); action(); };
  const changedKeys = new Set(currentUserKeyRules().map((rule) => rule.command)).size;
  const showsNotes = UPDATE_NOTES.includes(updateState?.phase);

  return h(React.Fragment, null,
    h('button', { ref: trigger, type: 'button', className: 'app-settings-trigger tb-icon', 'aria-label': 'Global settings', title: 'Global settings', 'aria-haspopup': 'dialog', onClick: open },
      h(UI.Icon, { name: 'gear', size: 16 })),
    h('dialog', { ref: dialog, className: 'app-settings', 'aria-labelledby': 'app-settings-title',
      onCancel: (event) => { event.preventDefault(); close(); },
      // A press on the backdrop closes it, like the shortcuts dialog.
      onClick: (event) => { if (event.target === event.currentTarget) { const b = event.currentTarget.getBoundingClientRect(); if (event.clientX < b.left || event.clientX > b.right || event.clientY < b.top || event.clientY > b.bottom) close(); } } },
      h('header', null,
        h('h2', { id: 'app-settings-title' }, 'Global settings'),
        h('button', { type: 'button', className: 'app-settings-close', 'aria-label': 'Close global settings', onClick: close }, '×')),
      h('div', { className: 'settings-card' },
        h(Row, { label: 'Display units' },
          h(UI.Seg, { ariaLabel: 'Display units', value: unitSystem, options: [{ v: 'metric', label: 'Metric' }, { v: 'imperial', label: 'Imperial' }], onChange: setUnitSystem })),
        // Pinch and Ctrl/⌘+scroll zoom either way; this chooses what plain scrolling (or a finger on a touchscreen Mac) does.
        h(Row, { label: 'Scrolling on the field', status: (isMacPlatform() ? 'Pinch or ⌘-scroll' : 'Pinch or Ctrl+scroll') + ' zooms' },
          h(UI.Seg, { ariaLabel: 'Scrolling on the field', value: fieldScroll, options: [{ v: 'pan', label: 'Pans' }, { v: 'zoom', label: 'Zooms' }], onChange: FieldScrollPrefs.set })),
        // Hidden where the host can't store keys.
        canEditKeys() && h(Row, { label: 'Keyboard shortcuts', status: changedKeys ? changedKeys + ' changed' : 'Defaults' },
          h('button', { className: 'qbtn', type: 'button', onClick: handOff(() => openKeyboardShortcuts(true)) }, 'Customize')),
        updateState && h(Row, { label: 'Software updates', status: 'Bordeaux ' + updateState.currentVersion + (UPDATE_STATUS[updateState.phase] || '') },
          // The update panel waits for other modals to close, so this one closes first and the panel anchors under the gear.
          h('button', { className: 'qbtn', type: 'button', onClick: handOff(showsNotes ? onOpenUpdates : onCheckUpdates) }, showsNotes ? 'View update' : 'Check for updates')))));
}
