import * as React from 'react';
import { isMacPlatform, shortcutLabel } from '../lib/shortcuts';
import { UI } from './ui';
import { shortFact } from '../lib/projectLifecycle';

const h = React.createElement;
const { useEffect, useRef, useState } = React;
const { Icon } = UI;

const timeOfDay = (date) => date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const folderName = (directory) => String(directory || '').replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || directory;
export const ROUTINES_LOCAL = 'Push sends paths only. Routines stay local.';

const WORKING = ['preparing', 'uploading', 'probing', 'trusting', 'saving'];

/**
 * The robot's state in one line: progress, the completed operation's own frozen result, or the destination. "Pushed"
 * and "Not sent" never claim whether paths changed since. `tone` drives the menu trigger's dot; idle has none.
 */
export function robotStatus(controller, resultAt) {
  const endpoint = controller.settings?.endpoint;
  if (WORKING.includes(controller.phase)) {
    return { tone: 'busy', text: controller.phase === 'uploading' ? 'Uploading…' : controller.phase === 'saving' ? 'Saving…' : 'Preparing…' };
  }
  if (controller.phase === 'transferred' && controller.result) {
    return { tone: 'good', text: 'Pushed ' + (controller.result.files?.length || 0) + ' · ' + timeOfDay(resultAt || new Date()), title: 'Verified in ' + controller.result.directory };
  }
  if (controller.phase === 'failed' && controller.error) return { tone: 'bad', text: 'Not sent · ' + shortFact(controller.error), title: controller.error };
  if (!endpoint) return { tone: 'unset', text: 'Robot not set up', title: 'Push opens robot setup' };
  return { tone: undefined, text: endpoint.host + ' · ' + folderName(endpoint.directory), title: endpoint.host + ':' + endpoint.directory };
}

/**
 * The split button's menu: the robot (destination and last result) as its heading, then Push all and the connection.
 * Follows the project menu: arrows, Home/End, Escape and Tab close it and return focus to the trigger. Unavailable
 * items stay focusable with aria-disabled so their visible reason can be read.
 */
function PushMenu({ controller, status, total, incomplete, onPushAll }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null), trigger = useRef(null), menu = useRef(null);
  const close = (restoreFocus) => { setOpen(false); if (restoreFocus) trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return undefined;
    menu.current?.querySelector('[role="menuitem"]')?.focus();
    const away = (event) => { if (!root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  const endpoint = controller.settings?.endpoint;
  const allUnavailable = controller.desktopAvailable === false ? 'Robot delivery is unavailable here'
    : !total ? 'No paths to push'
    : incomplete ? (incomplete === 1 ? '1 path needs' : incomplete + ' paths need') + ' at least two waypoints' : '';
  // A running push keeps Push all inert; its dialog already owns the operation.
  const allInert = Boolean(allUnavailable) || controller.busy;
  // Close first and return focus to the trigger, so the push dialog records the trigger as its focus origin.
  const run = (callback) => () => { close(true); callback(); };
  const item = (props, label, detail) => h('button', { type: 'button', role: 'menuitem', tabIndex: -1, ...props },
    h('span', { className: 'push-menu-label' }, label), detail && h('span', { className: 'push-menu-detail' }, detail));
  return h('div', { ref: root, className: 'push-menu-root', onBlur: (event) => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  } },
    h('button', { ref: trigger, type: 'button', className: 'push-menu-trigger', 'data-tone': status.tone, 'aria-haspopup': 'menu', 'aria-expanded': open,
      'aria-controls': open ? 'push-menu' : undefined, 'aria-label': 'Push options · ' + status.text, title: status.title ? status.text + ' · ' + status.title : status.text,
      onClick: () => setOpen(!open), onKeyDown: (event) => {
        if ([' ', 'Enter', 'ArrowDown', 'ArrowUp'].includes(event.key)) event.stopPropagation();
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); }
      } },
      h('span', { className: 'push-dot', 'aria-hidden': true }),
      h('span', { className: 'push-chevron', 'aria-hidden': true }, h(Icon, { name: 'chevron', size: 12 }))),
    open && h('div', { ref: menu, id: 'push-menu', className: 'push-menu', role: 'menu', 'aria-label': 'Push options',
      onKeyDown: (event) => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); close(true); }
        if (event.key === 'Tab') close(true);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const items = [...menu.current.querySelectorAll('[role="menuitem"]')], index = items.indexOf(document.activeElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }
      } },
      h('div', { className: 'push-menu-heading', role: 'presentation' },
        h('strong', null, endpoint ? endpoint.host : 'Robot not set up'),
        endpoint ? h('span', { className: 'push-menu-where', title: endpoint.directory }, endpoint.directory) : h('span', { className: 'push-menu-note' }, 'Push opens setup first'),
        status.tone && status.tone !== 'unset' && h('span', { className: 'push-menu-result', 'data-tone': status.tone, title: status.title }, status.text)),
      item({ className: 'push-all', 'aria-disabled': allInert || undefined, title: allUnavailable || undefined,
        'aria-label': 'Push all ' + total + (total === 1 ? ' path' : ' paths'), onClick: allInert ? undefined : run(onPushAll) },
      'Push all ' + total + (total === 1 ? ' path' : ' paths'), allUnavailable || 'Includes hidden paths'),
      h('hr', { role: 'separator' }),
      item({ className: 'push-menu-connection', onClick: run(() => controller.openConnection()) }, endpoint ? 'Robot connection…' : 'Set up robot…')));
}

/**
 * The robot end of the toolbar, as one split button. The primary half pushes the paths chosen in the library (or the
 * open routine where routine delivery exists) and its label is that exact scope; without a robot connection it opens
 * setup first. ⇧⌘P sends the chosen paths from anywhere on Paths, never from bare Enter; an open modal owns the
 * keyboard. The chevron half carries the robot's state as a dot and opens a menu with the destination, the last
 * result, Push all and the connection. Push all sends every path in the project, including ones search or a collapsed
 * folder hides, through the same reviewed request; it has no shortcut and is never reached from the primary half.
 */
export function PushControl({ place, paths, selection, activeRoutine, controller }) {
  const pathsPlace = place === 'paths';
  const routinePushAvailable = !controller.fileTransfer && typeof window !== 'undefined' && window.bordeauxAPI?.robotDeliveryCapabilities?.routinePush === true;
  const selected = pathsPlace ? selection.selected : [];
  const byId = (id) => paths.find((path) => path.id === id);
  // Push needs geometry: a path still being drawn (fewer than two waypoints) cannot be sent.
  const unfinished = pathsPlace && selected.some((id) => (byId(id)?.waypoints?.length || 0) < 2);
  const disabled = controller.busy || controller.desktopAvailable === false || unfinished || (pathsPlace ? !selected.length : !activeRoutine);
  const send = () => controller.requestPush(pathsPlace ? { kind: 'paths', pathIds: selected } : { kind: 'routine', routineId: activeRoutine.id });
  // Every authored path, never the library's displayed rows. A path still being drawn blocks the whole set rather
  // than being dropped from it.
  const total = paths.length;
  const incomplete = paths.filter((path) => (path.waypoints?.length || 0) < 2).length;
  const sendAll = () => controller.requestPush({ kind: 'paths', pathIds: paths.map((path) => path.id) });
  // A result keeps the time it arrived, not the time of the latest render.
  const receipt = useRef({ result: null, at: null });
  if (controller.result && receipt.current.result !== controller.result) receipt.current = { result: controller.result, at: new Date() };

  const shortcut = useRef(null);
  shortcut.current = pathsPlace && !disabled ? send : null;
  useEffect(() => {
    const onKey = (event) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey || event.key.toLowerCase() !== 'p') return;
      if (event.isComposing || event.defaultPrevented || document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
      event.preventDefault();
      shortcut.current?.();
    };
    // Capture: the library and form fields stop their own key events from bubbling.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  if (!pathsPlace && !routinePushAvailable) return h('div', { className: 'push-control' }, h('span', { className: 'push-local', title: ROUTINES_LOCAL }, 'Routines stay local'));
  const count = selected.length;
  const label = pathsPlace ? (count > 1 ? 'Push ' + count + ' paths' : 'Push path') : 'Push routine';
  const title = unfinished ? 'Place at least two waypoints to push'
    : pathsPlace ? (count > 1 ? count + ' paths' : byId(selected[0])?.name) : activeRoutine?.name;
  const withMenu = pathsPlace && controller.fileTransfer;
  const status = withMenu ? robotStatus(controller, receipt.current.at) : null;
  const push = h('button', { type: 'button', className: 'push-button', disabled, title: pathsPlace ? [title, shortcutLabel('P', { shift: true })].filter(Boolean).join(' · ') : title, onClick: send,
    // The shortcut glyphs are drawn from data-shortcut, which CSS generated content would add to the accessible name;
    // aria-label keeps the name exactly the scope, and aria-keyshortcuts announces the shortcut once.
    'aria-label': label, 'aria-keyshortcuts': pathsPlace ? (isMacPlatform() ? 'Meta+Shift+P' : 'Control+Shift+P') : undefined, 'data-shortcut': pathsPlace ? shortcutLabel('P', { shift: true }) : undefined },
    label);
  if (!withMenu) return h('div', { className: 'push-control' }, push);
  return h('div', { className: 'push-control' },
    // The persistent live region announces progress and each complete result; the dot only summarizes it.
    h('span', { className: 'sr-only', role: 'status' }, status.text),
    h('div', { className: 'push-split', role: 'group', 'aria-label': 'Push' }, push,
      h(PushMenu, { controller, status, total, incomplete, onPushAll: sendAll })));
}
