import * as React from 'react';
import { UI } from './ui';
import { NameInput } from './NameInput';
import { ROBOT_LIMIT } from '../../core/project/robots';

const h = React.createElement;
const { useRef, useState } = React;

/** The robot's address in a tab's tooltip. `currentHost` is set only for a project saved before robot lists. */
const address = (robot, currentHost) => robot.connection?.host ?? currentHost ?? 'No connection';
const tone = (robot, currentHost) => robot.connection || currentHost ? 'set' : 'unset';

/**
 * The project's robots as tabs along the bottom of the Robot page's content column. A tab selects that robot: planning,
 * export and Push use it. + adds a robot from the default details and opens its name. Double-click or F2 renames; the
 * selected tab's ⋯ and a right-click open Rename, Duplicate, the connection, Pull from robot and Delete, which asks
 * first. Pull needs a connection (`onPull` unset leaves it disabled). Arrow keys,
 * Home and End move between tabs and select as they go, like any tab list.
 */
export function RobotTabs({ robots, currentHost, onSelect, onAdd, onDuplicate, onRename, onRemove, onConnection, onPull }) {
  const [editing, setEditing] = useState(null);
  const [menu, setMenu] = useState(null);
  const [removing, setRemoving] = useState(null);
  const list = useRef(null);
  const full = robots.length >= ROBOT_LIMIT;
  const focusTab = (id) => requestAnimationFrame(() => (list.current?.querySelector(`[data-robot="${CSS.escape(id)}"]`) || list.current?.querySelector('[aria-selected="true"]'))?.focus());
  const taken = (id) => (name) => robots.some((robot) => robot.id !== id && robot.name.toLowerCase() === name.toLowerCase());
  const select = (id) => { if (!robots.find((robot) => robot.id === id)?.selected) onSelect(id); };
  const openMenu = (robot, x, y, origin) => { select(robot.id); setMenu({ id: robot.id, x, y, origin }); };
  const add = () => { const id = onAdd(); if (id) setEditing(id); };
  const onKey = (event, index) => {
    const n = robots.length;
    const next = { ArrowRight: (index + 1) % n, ArrowLeft: (index - 1 + n) % n, Home: 0, End: n - 1 }[event.key];
    if (next != null) { event.preventDefault(); select(robots[next].id); focusTab(robots[next].id); return; }
    if (event.key === 'F2') { event.preventDefault(); setEditing(robots[index].id); }
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault(); const r = event.currentTarget.getBoundingClientRect(); openMenu(robots[index], r.left, r.top - 4, event.currentTarget);
    }
  };
  const menuRobot = menu && robots.find((robot) => robot.id === menu.id);
  const removingRobot = removing && robots.find((robot) => robot.id === removing);

  const tab = (robot, index) => {
    if (editing === robot.id) return h('div', { key: robot.id, className: 'robot-tab editing', 'data-selected': robot.selected || undefined },
      h(NameInput, { robot, taken: taken(robot.id), onDone: (name) => { setEditing(null); if (name) onRename(robot.id, name); focusTab(robot.id); } }));
    return h('button', { key: robot.id, type: 'button', role: 'tab', className: 'robot-tab', 'data-robot': robot.id, 'aria-selected': robot.selected, tabIndex: robot.selected ? 0 : -1,
      title: robot.name + ' · ' + address(robot, currentHost), 'data-address': address(robot, currentHost),
      onClick: () => select(robot.id), onDoubleClick: () => setEditing(robot.id), onKeyDown: (event) => onKey(event, index),
      onContextMenu: (event) => { event.preventDefault(); openMenu(robot, event.clientX, event.clientY - 4, event.currentTarget); } },
      h('span', { className: 'robot-tab-dot', 'data-tone': tone(robot, currentHost), 'aria-hidden': true }),
      h('span', { className: 'robot-tab-name' }, robot.name),
      // A pointer shortcut to the same menu the keyboard opens with the context-menu key.
      robot.selected && h('span', { className: 'robot-tab-more', 'aria-hidden': true, title: 'Robot actions',
        onClick: (event) => { event.stopPropagation(); const r = event.currentTarget.getBoundingClientRect(); openMenu(robot, r.left, r.top - 4, event.currentTarget.closest('.robot-tab')); } },
        h(UI.Icon, { name: 'more', size: 14 })));
  };

  return h('footer', { className: 'robot-tabs', 'aria-label': 'Robots' },
    h('div', { ref: list, className: 'robot-tabs-list', role: 'tablist', 'aria-label': 'Robots' }, robots.map(tab)),
    h('button', { type: 'button', className: 'robot-tab-add', 'aria-label': 'New robot', title: full ? 'This project has the most robots it can hold' : 'New robot', disabled: full, onClick: add },
      h(UI.Icon, { name: 'plus', size: 14 }), robots.length < 2 && h('span', null, 'New robot')),
    menuRobot && h(UI.ContextMenu, { x: menu.x, y: menu.y, above: true, label: 'Actions for ' + menuRobot.name, returnFocus: menu.origin, onClose: () => setMenu(null),
      items: [
        { label: 'Rename', hint: 'F2', onClick: () => setEditing(menuRobot.id) },
        { label: 'Duplicate', disabled: full, onClick: () => { const id = onDuplicate(menuRobot.id); if (id) focusTab(id); } },
        { label: menuRobot.connection || currentHost ? 'Connection…' : 'Set up connection…', onClick: () => onConnection?.() },
        { label: 'Pull from robot…', disabled: !onPull, onClick: () => onPull?.() },
        { sep: true },
        { label: robots.length < 2 ? 'Delete (the last robot stays)' : 'Delete…', danger: true, disabled: robots.length < 2, onClick: () => setRemoving(menuRobot.id) },
      ] }),
    removingRobot && h(RemoveConfirm, { robot: removingRobot, onCancel: () => { setRemoving(null); focusTab(removingRobot.id); },
      onConfirm: () => { setRemoving(null); onRemove(removingRobot.id); focusTab(robots.find((robot) => robot.id !== removingRobot.id)?.id); } }));
}

/** Deleting a robot asks first, beside its tab: its details and address go with it. */
function RemoveConfirm({ robot, onCancel, onConfirm }) {
  const anchor = document.querySelector(`.robot-tab[data-robot="${CSS.escape(robot.id)}"]`)?.getBoundingClientRect();
  return h('div', { className: 'robot-tab-confirm', role: 'alertdialog', 'aria-label': 'Delete ' + robot.name, style: { left: Math.max(8, Math.min(anchor?.left ?? 8, window.innerWidth - 328)) + 'px' },
    onKeyDown: (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); } } },
    h('span', null, 'Delete ', h('strong', null, robot.name), '? Its details and connection are removed from this project.'),
    h('span', { className: 'robot-tab-confirm-actions' },
      h('button', { type: 'button', className: 'qbtn quiet', ref: (button) => { if (button && !button.dataset.ready) { button.dataset.ready = '1'; button.focus(); } }, onClick: onCancel }, 'Cancel'),
      h('button', { type: 'button', className: 'qbtn', onClick: onConfirm }, 'Delete')));
}
