import * as React from 'react';
import { isMacPlatform, shortcutLabel } from '../lib/shortcuts';

const h = React.createElement;
const { useEffect, useRef } = React;

const timeOfDay = (date) => date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const folderName = (directory) => String(directory || '').replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || directory;
export const ROUTINES_LOCAL = 'Routines stay on this computer. Push uploads paths only.';

/**
 * Beside Push: the destination, or the completed operation's own frozen result. "Pushed" and "Not sent"
 * never claim whether paths changed since. The text opens the connection review.
 */
function PushStatus({ controller }) {
  const receipt = useRef({ result: null, at: null });
  if (controller.result && receipt.current.result !== controller.result) receipt.current = { result: controller.result, at: new Date() };
  if (!controller.fileTransfer) return null;
  const endpoint = controller.settings?.endpoint;
  const open = () => controller.openConnection();
  const working = ['preparing', 'uploading', 'probing', 'trusting', 'saving'].includes(controller.phase);
  const progress = controller.phase === 'uploading' ? 'Uploading…' : controller.phase === 'saving' ? 'Saving…' : 'Preparing…';
  const button = (title, text, tone, compact) => h('button', { type: 'button', className: 'push-destination', 'data-tone': tone,
    'data-compact-status': compact ? true : undefined, onClick: open, title, 'aria-label': text },
    tone && h('span', { className: 'push-dot', 'aria-hidden': true }),
    h('span', { className: 'push-status-full' }, text),
    compact && h('span', { className: 'push-status-compact', 'aria-hidden': true }, compact));
  // The persistent live region announces the complete result; compact chrome keeps its essential state visible.
  return h('div', { className: 'push-status', role: 'status' },
    working ? button(progress, progress, undefined, controller.phase === 'uploading' ? 'Sending' : controller.phase === 'saving' ? 'Saving' : 'Preparing')
      : controller.phase === 'transferred' && controller.result ? button('Verified in ' + controller.result.directory,
        'Pushed ' + (controller.result.files?.length || 0) + ' · ' + timeOfDay(receipt.current.at), 'good', 'Pushed')
      : controller.phase === 'failed' && controller.error ? button(controller.error,
        'Not sent · ' + controller.error, 'bad', 'Not sent')
      : button(endpoint ? endpoint.host + ':' + endpoint.directory : 'Set up the robot connection',
        endpoint ? endpoint.host + ' · ' + folderName(endpoint.directory) : 'Robot not set up', undefined, endpoint ? undefined : 'Set up'));

}

/**
 * The robot end of the toolbar: destination and outcome, then Push with its exact scope. Push sends the paths chosen
 * in the library (or the open routine where routine delivery exists). ⇧⌘P sends the chosen paths from anywhere on
 * Paths, never from bare Enter; an open modal owns the keyboard. Push all sends every path in the project, including
 * ones search or a collapsed folder hides, through the same reviewed request; it has no shortcut.
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
  const allName = 'Push all ' + total + (total === 1 ? ' path' : ' paths');
  return h('div', { className: 'push-control' },
    pathsPlace && h(PushStatus, { controller }),
    // While a push runs, Push all stays focusable but inert, so closing that push's dialog can return focus here.
    pathsPlace && controller.fileTransfer && h('button', { type: 'button', className: 'push-all', 'aria-label': allName,
      onClick: controller.busy ? undefined : sendAll, 'aria-disabled': controller.busy || undefined,
      disabled: controller.desktopAvailable === false || !total || incomplete > 0,
      title: !total ? 'No paths to push' : incomplete ? (incomplete === 1 ? '1 path needs' : incomplete + ' paths need') + ' at least two waypoints'
        : 'Every path in this project, including any hidden by search or a collapsed folder' }, 'Push all ' + total),
    h('button', { type: 'button', className: 'push-button', disabled, title: pathsPlace ? [title, shortcutLabel('P', { shift: true })].filter(Boolean).join(' · ') : title, onClick: send,
      // The shortcut glyphs are drawn from data-shortcut, which CSS generated content would add to the accessible name;
      // aria-label keeps the name exactly the scope, and aria-keyshortcuts announces the shortcut once.
      'aria-label': label, 'aria-keyshortcuts': pathsPlace ? (isMacPlatform() ? 'Meta+Shift+P' : 'Control+Shift+P') : undefined, 'data-shortcut': pathsPlace ? shortcutLabel('P', { shift: true }) : undefined },
      label));
}
