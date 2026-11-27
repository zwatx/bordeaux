import * as React from 'react';
import { ROBOT_NAME_MAX } from '../../core/project/robots';

const h = React.createElement;

/** A name while it is being edited: a robot tab's, or a camera's with its own `label`, `maxLength` and
 * `takenMessage`. Enter or leaving the field commits; Escape keeps the old name. */
export function NameInput({ robot, taken, onDone, label = 'Robot name', maxLength = ROBOT_NAME_MAX, takenMessage = 'Another robot has this name.' }) {
  const [value, setValue] = React.useState(robot.name);
  const [error, setError] = React.useState('');
  const errorId = React.useId();
  const commit = (raw) => {
    const name = raw.trim();
    if (!name || name === robot.name) return onDone(null);
    if (taken(name)) { setError(takenMessage); return false; }
    return onDone(name);
  };
  return h('div', { className: 'robot-card-name' },
    h('input', { className: 'rp-text', value, maxLength, 'aria-label': label, 'aria-invalid': Boolean(error), 'aria-describedby': error ? errorId : undefined,
      ref: (input) => { if (input && !input.dataset.ready) { input.dataset.ready = '1'; input.focus(); input.select(); } },
      onChange: (event) => { setValue(event.target.value); setError(''); },
      onBlur: (event) => { if (commit(event.target.value) === false) onDone(null); },
      onKeyDown: (event) => {
        if (event.key === 'Enter') { event.preventDefault(); commit(event.currentTarget.value); }
        else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onDone(null); }
      } }),
    error && h('span', { id: errorId, className: 'cmd-param-error', role: 'alert' }, error));
}
