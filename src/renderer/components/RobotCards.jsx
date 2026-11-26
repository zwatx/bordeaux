import * as React from 'react';
import { UI } from './ui';
import { ROBOT_NAME_MAX } from '../../core/project/robots';

const h = React.createElement;

/** The robot's address. `currentHost` is set only for a project saved before robot lists, whose one robot uses this
 * computer's current connection. */
const address = (robot, currentHost) => robot.connection?.host ?? currentHost ?? 'No address';

/** A card's name while it is being edited. Enter or leaving the field commits; Escape keeps the old name. */
function NameInput({ robot, taken, onDone }) {
  const [value, setValue] = React.useState(robot.name);
  const [error, setError] = React.useState('');
  const errorId = React.useId();
  const commit = (raw) => {
    const name = raw.trim();
    if (!name || name === robot.name) return onDone(null);
    if (taken(name)) { setError('Another robot has this name.'); return false; }
    return onDone(name);
  };
  return h('div', { className: 'robot-card-name' },
    h('input', { className: 'rp-text', value, maxLength: ROBOT_NAME_MAX, 'aria-label': 'Robot name', 'aria-invalid': Boolean(error), 'aria-describedby': error ? errorId : undefined,
      ref: (input) => { if (input && !input.dataset.ready) { input.dataset.ready = '1'; input.focus(); input.select(); } },
      onChange: (event) => { setValue(event.target.value); setError(''); },
      onBlur: (event) => { if (commit(event.target.value) === false) onDone(null); },
      onKeyDown: (event) => {
        if (event.key === 'Enter') { event.preventDefault(); commit(event.currentTarget.value); }
        else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onDone(null); }
      } }),
    error && h('span', { id: errorId, className: 'cmd-param-error', role: 'alert' }, error));
}

/**
 * The project's robots as cards on the Robot page. Choosing a card selects that robot, and the sections below edit it.
 * New robot copies the selected robot and opens its name for editing. Hovering or tabbing onto a card shows its quick
 * actions: rename, duplicate (a copy, selected), and delete, which asks first; the last robot cannot be deleted.
 */
export function RobotCards({ robots, currentHost, onSelect, onAdd, onDuplicate, onRename, onRemove }) {
  const [editing, setEditing] = React.useState(null);
  const [removing, setRemoving] = React.useState(null);
  const focusCard = (id) => requestAnimationFrame(() => document.querySelector(`.robot-card[data-robot="${CSS.escape(id)}"] .robot-card-pick`)?.focus());
  const taken = (id) => (name) => robots.some((robot) => robot.id !== id && robot.name.toLowerCase() === name.toLowerCase());
  const action = (icon, label, onClick, disabled = false) => h('button', { type: 'button', className: 'robot-card-action', 'aria-label': label, title: label, disabled, onClick },
    h(UI.Icon, { name: icon, size: 14 }));

  const card = (robot) => {
    const asking = removing === robot.id;
    return h('div', { key: robot.id, role: 'listitem', 'data-robot': robot.id, className: 'robot-card' + (robot.selected ? ' on' : '') },
      // The confirmation lies over a hidden copy of the card's own content, so the card keeps its size.
      asking && h('div', { className: 'robot-card-pick', 'aria-hidden': true, style: { visibility: 'hidden' } },
        h('strong', null, robot.name), h('small', null, address(robot, currentHost))),
      asking
        ? h('div', { className: 'robot-card-confirm', role: 'group', 'aria-label': 'Delete ' + robot.name },
            h('span', null, 'Delete ', h('strong', null, robot.name), '?'),
            h('span', null,
              h('button', { type: 'button', className: 'qbtn quiet', ref: (button) => button?.focus(), onClick: () => { setRemoving(null); focusCard(robot.id); } }, 'Cancel'),
              h('button', { type: 'button', className: 'qbtn', onClick: () => { setRemoving(null); onRemove(robot.id); focusCard(robots.find((other) => other.id !== robot.id)?.id); } }, 'Delete')))
        : editing === robot.id
        ? h(NameInput, { robot, taken: taken(robot.id), onDone: (name) => { setEditing(null); if (name) onRename(robot.id, name); focusCard(robot.id); } })
        : h('button', { type: 'button', className: 'robot-card-pick', 'aria-pressed': robot.selected, onClick: () => onSelect(robot.id) },
            h('strong', null, robot.name), h('small', null, address(robot, currentHost))),
      !asking && editing !== robot.id && h('div', { className: 'robot-card-actions' },
        action('edit', 'Rename ' + robot.name, () => setEditing(robot.id)),
        action('copy', 'Duplicate ' + robot.name, () => { const id = onDuplicate(robot.id); if (id) focusCard(id); }),
        action('trash', robots.length < 2 ? 'The last robot cannot be deleted' : 'Delete ' + robot.name, () => setRemoving(robot.id), robots.length < 2)));
  };

  return h('div', { className: 'robot-cards', role: 'list', 'aria-label': 'Robots' },
    robots.map(card),
    h('button', { type: 'button', className: 'robot-card robot-card-new', onClick: () => { const id = onAdd(); if (id) setEditing(id); } }, '+ New robot'));
}
