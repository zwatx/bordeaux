import * as React from 'react';
import { AUTO } from '../lib/routineModel';
import { CommandParameterEditor } from './ContextInspector';
import { deletionInput } from './DeletionNotice';
import { UI } from './ui';
import { robotValueSchemasEqual } from '../../shared/robotValueSchema';

const h = React.createElement;
const { Dropdown } = UI;
const operators = [
  ['eq', 'Equals'], ['neq', 'Does not equal'], ['lt', 'Less than'],
  ['lte', 'At most'], ['gt', 'Greater than'], ['gte', 'At least'],
].map(([value, label]) => ({ value, label }));
const steps = (count, noun = 'step') => count + ' ' + noun + (count === 1 ? '' : 's');
const MODAL = 'dialog[open],[role="dialog"][aria-modal="true"]';

/** Edits go to the routine owner as intents with stable IDs; a replacement says what it removes before it is chosen. */
export function CommandBranches({ node, command, acq }) {
  const sectionRef = React.useRef(null);
  const branch = node.outputBranch;
  const outputs = AUTO.branchOutputs(command);
  const current = outputs.find((output) => output.name === branch?.output);
  const changed = branch && current && !robotValueSchemasEqual(current.schema, branch.schema);
  const total = AUTO.routeSteps(branch?.routes || []);
  const removes = total ? ' · removes ' + steps(total) : '';
  const edit = (intent) => acq.branch(node.id, intent);
  // Choosing the saved output again rebuilds it only when its value type changed; otherwise it keeps it. The owner's
  // whole result goes to the picker, so its deferred focus follows only while that result owns the routine.
  const choose = (value) => edit(value === (branch?.output || '') && !changed ? { kind: 'keep' }
    : value === branch?.output ? { kind: 'rebuild' } : { kind: 'output', output: value });
  // A pressed button may remove itself. Its focus successor is found only in this section instance, while the action's owner holds.
  const replaceThen = (intent, successor) => {
    const result = edit(intent), section = sectionRef.current, from = document.activeElement;
    if (result.status !== 'applied') return;
    requestAnimationFrame(() => {
      const active = document.activeElement, target = section?.isConnected && sectionRef.current === section && result.current() && successor(section);
      if (target && !target.disabled && (!active || active === from || active === document.body) && !document.querySelector(MODAL)) target.focus();
    });
  };
  const numeric = branch && !['boolean', 'enum'].includes(branch.schema.kind);
  const patchRoute = (routeId, patch) => edit({ kind: 'patchRoute', routeId, patch });
  return h('section', { ref: sectionRef, className: 'command-branches', 'aria-label': 'Command output branches' },
    h('div', { className: 'fieldlabel' }, 'After command completes'),
    h(Dropdown, { id: 'command-branch-output', label: 'Branch on output', value: branch?.output || '',
      items: [{ value: '', label: 'Continue to next step', meta: branch && total ? 'Removes ' + steps(total, 'branch step') : undefined },
        ...(branch && !current ? [{ value: branch.output, label: branch.output, meta: 'Output unavailable — sync commands or choose another output', badge: 'Missing' }] : []),
        ...outputs.map((output) => {
          const kind = output.schema.kind === 'enum' ? 'Named outcomes' : output.schema.kind;
          return { value: output.name, label: output.label || output.name,
            meta: output.name !== branch?.output ? kind + removes : changed && total ? 'Type changed' + removes : kind };
        })],
      onChoose: choose }),
    !branch && !outputs.length && h('p', { className: 'seg-hint' }, 'Sync a command with outputs to add branches.'),
    branch && h(React.Fragment, null,
      (!current || changed) && h('div', { className: 'cmd-project-error', role: 'status' },
        changed ? 'This output’s type changed. Rebuild its routes before using it.' : 'Output missing. Saved routes are kept.',
        changed && h('button', { type: 'button', className: 'rt-openbtn',
          ...deletionInput(() => replaceThen({ kind: 'rebuild' }, (section) => section.querySelector('#command-branch-output'))) }, 'Rebuild routes' + removes)),
      h('p', { className: 'seg-hint' }, (numeric ? 'First match wins, top to bottom. ' : '') + 'Routes rejoin at the next step. Preview only.'),
      // Each route is one group: its condition and actions on the header row, then its name, comparison and value.
      branch.routes.map((route, index) => {
        const count = AUTO.branchCount(route.nodes), contents = count ? ' and its ' + steps(count) : '';
        // After removal, focus the next comparison's Remove, else the previous one's, else Add comparison.
        const successor = (section) => {
          const buttons = [...section.querySelectorAll('[data-route-remove]')];
          return [branch.routes[index + 1], branch.routes[index - 1]].map((neighbor) => buttons.find((button) => neighbor && button.dataset.routeRemove === neighbor.id))
            .find((button) => button && !button.disabled) || section.querySelector('.command-branch-add');
        };
        return h('div', { key: route.id, className: 'command-branch-route', role: 'group', 'aria-label': 'Route ' + (index + 1) },
          h('div', { className: 'command-branch-head' }, h('strong', null, 'Route ' + (index + 1)), h('span', null, AUTO.routeSummary(route) + (count ? ' · ' + steps(count) : '')),
            numeric && route.operator !== 'otherwise' && h(React.Fragment, null,
              h('button', { type: 'button', className: 'rt-tool', title: 'Check earlier', 'aria-label': 'Check route ' + (index + 1) + ' earlier', disabled: index === 0,
                onClick: () => edit({ kind: 'routeEarlier', routeId: route.id }) }, '↑'),
              h('button', { type: 'button', className: 'rt-tool danger', title: 'Remove comparison' + contents, 'aria-label': 'Remove route ' + (index + 1) + contents,
                'data-route-remove': route.id, disabled: branch.routes.length <= 2,
                ...deletionInput(() => replaceThen({ kind: 'removeRoute', routeId: route.id }, successor)) }, h(UI.Icon, { name: 'trash', size: 13 })))),
          h('label', { className: 'fieldlabel', htmlFor: 'route-label-' + route.id }, 'Name'),
          h(UI.DraftText, { id: 'route-label-' + route.id, className: 'textinput', 'aria-label': 'Branch name ' + (index + 1), value: route.label,
            owner: node.id + ':' + route.id,
            // A route needs a name to save; a blank entry restores the saved one, as decision route names do.
            onCommit: (label) => patchRoute(route.id, { label }) }),
          numeric && route.operator !== 'otherwise' && h('div', { className: 'grid2' },
            h(Dropdown, { id: 'route-operator-' + route.id, label: 'Comparison', value: route.operator, items: operators, onChange: (operator) => patchRoute(route.id, { operator }) }),
            h(CommandParameterEditor, { id: 'route-value-' + route.id, label: 'Value', schema: branch.schema,
              value: route.value, parameter: current && !changed ? current : {}, onChange: (value) => patchRoute(route.id, { value }) })));
      }),
      numeric && h('button', { type: 'button', className: 'rt-openbtn command-branch-add', disabled: branch.routes.length >= 256,
        onClick: () => edit({ kind: 'addComparison' }) }, 'Add comparison'),
      h(Dropdown, { id: 'command-preview-route', label: 'Preview route', value: AUTO.selectedBranch(node, acq.outcomes)?.id,
        items: branch.routes.map((route) => ({ value: route.id, label: route.label || AUTO.routeSummary(route), meta: AUTO.routeSummary(route) })),
        onChange: (id) => acq.setOutcome(node.id, id) })));
}
