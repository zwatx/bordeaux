import * as React from 'react';
import { UI } from './ui';
import { commandInputKey, commandUseEstimate, COMMAND_CURRENT_MAX_A, COMMAND_RUN_TIME_MAX_S, COMMAND_RUN_TIME_MIN_S } from '../../core/commandLoads';
import { commandEstimateCapProblem, legacyCommandLoadsMigratable, listCommandUses, migrateLegacyCommandLoads, storeCommandEstimate } from '../../core/project/commandPower';
import { committedDraftValue } from '../lib/numericDraft';

const h = React.createElement;
const { useRef, useState, useId } = React;
const { Icon, Num } = UI;

const seconds = (value) => value == null ? 'Until stopped' : +value.toFixed(2) + ' s';
const amps = (value) => +value.toFixed(1) + ' A';
const READ_ONLY_USE = 'In a generated trajectory’s saved fallback, which can’t be edited here';

/** Uses that still plan with a legacy command load because they have no estimate of their own. */
const legacyUncovered = (uses, legacy) => uses.filter((use) => use.estimate?.source === 'legacy' && legacy.some((load) => load.commandId === use.commandId)).length;

/** Where a use lives, for a suggestion or a summary row: the path or routine name. */
function placeOf(project, location) {
  if (location.kind === 'routineStep') return project.routines?.find((routine) => routine.id === location.routineId)?.name || 'Routine';
  return project.paths.find((path) => path.id === location.pathId)?.name || 'Path';
}

/**
 * An optional run time: empty means the command runs until a loop limit, a path-end cancel or the end of the path.
 * Typing commits on Enter or blur; Escape keeps the saved value. Out-of-range input shows why and changes nothing.
 */
export function RunTimeField({ label = 'Runs for', value, onChange }) {
  const id = useId();
  const [edit, setEdit] = useState(null);
  const [error, setError] = useState('');
  const cancel = useRef(false);
  const commit = (raw) => {
    if (!raw.trim()) { setError(''); if (value != null) onChange(undefined); return true; }
    const next = committedDraftValue(raw, value, value, (parsed) => parsed, { min: COMMAND_RUN_TIME_MIN_S, max: COMMAND_RUN_TIME_MAX_S });
    if (next == null) { setError(`Enter ${COMMAND_RUN_TIME_MIN_S}–${COMMAND_RUN_TIME_MAX_S} s, or leave it empty.`); return false; }
    setError('');
    if (!Object.is(next, value)) onChange(next);
    return true;
  };
  return h('div', { className: 'numrow' },
    h('label', { className: 'numlbl', htmlFor: id }, label),
    h('div', { className: 'numbox' },
      h('input', { id, className: 'numinput', inputMode: 'decimal', placeholder: 'Until stopped', 'aria-invalid': Boolean(error), 'aria-describedby': error ? id + '-error' : undefined,
        value: edit ?? (value == null ? '' : value.toFixed(2)), 'data-project-draft': true,
        onFocus: (event) => { cancel.current = false; if (edit == null) setEdit(value == null ? '' : String(value)); requestAnimationFrame(() => { if (document.activeElement === event.target) event.target.select(); }); },
        onChange: (event) => { cancel.current = false; setEdit(event.target.value); if (error) setError(''); },
        onBlur: (event) => { const done = cancel.current || edit == null || commit(event.target.value); cancel.current = false; if (done) setEdit(null); },
        onKeyDown: (event) => {
          if (event.key === 'Enter') { event.preventDefault(); if (cancel.current || edit == null || commit(event.currentTarget.value)) { cancel.current = true; setEdit(null); event.currentTarget.blur(); } }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel.current = true; setError(''); setEdit(null); }
        } }),
      h('span', { className: 'numunit' }, 's')),
    error && h('span', { id: id + '-error', className: 'cmd-param-error numerror', role: 'alert' }, error));
}

/**
 * The power estimate of one command use (a path event's command, a grouped command or a routine step) on the selected
 * robot. Nothing is shared silently: another use's value is offered as a Copy, and an estimate entered for other
 * settings asks to be reviewed. Planning-only; it never reaches the robot.
 * `power` is { project, robotId, robotName, robots }; `onInvocation` stores the edited invocation.
 */
export function CommandPowerEditor({ invocation, onInvocation, power, place = 'event' }) {
  const [refused, setRefused] = useState('');
  // Adding over an older load that no estimate may hold (above 500 A) opens its fields as a draft to correct first.
  const [drafting, setDrafting] = useState(false);
  if (!power || !invocation?.commandId) return null;
  const { project, robotId, robotName, robots = [] } = power;
  const own = invocation.power?.[robotId];
  const resolved = commandUseEstimate(invocation, { id: robotId, estimatesFrom: project.robot.estimatesFrom, driveModel: project.robot.driveModel });
  // A duplicate shares its original's estimates until it sets its own; editing a shared value makes it this robot's.
  const sharedFrom = resolved?.source === 'inherited' ? robots.find((robot) => robot.id === resolved.fromRobotId)?.name || 'the robot it was copied from' : null;
  // A use full of other robots' estimates takes no new one; this robot's own can still change.
  const capped = commandEstimateCapProblem(invocation, robotId);
  const write = (patch) => {
    if (capped) { setRefused(capped); return null; }
    const base = own || { currentA: resolved?.currentA ?? 0, ...(resolved?.runTimeS != null ? { runTimeS: resolved.runTimeS } : {}) };
    const next = { ...base, ...patch, inputKey: commandInputKey(invocation) };
    if (next.runTimeS === undefined) delete next.runTimeS;
    // The whole estimate must be valid, including a value carried over from an older command load (which may exceed it).
    if (!(next.currentA >= 0 && next.currentA <= COMMAND_CURRENT_MAX_A)) { setRefused(`Enter a current from 0 to ${COMMAND_CURRENT_MAX_A} A.`); return false; }
    if (next.runTimeS !== undefined && !(next.runTimeS >= COMMAND_RUN_TIME_MIN_S && next.runTimeS <= COMMAND_RUN_TIME_MAX_S)) { setRefused(`Run time must be ${COMMAND_RUN_TIME_MIN_S}–${COMMAND_RUN_TIME_MAX_S} s.`); return false; }
    setRefused('');
    power.ensureRobotId?.();
    onInvocation(storeCommandEstimate(invocation, robotId, next));
  };
  const remove = () => {
    const { [robotId]: _gone, ...rest } = invocation.power || {};
    const { power: _all, ...bare } = invocation;
    onInvocation(Object.keys(rest).length ? { ...invocation, power: rest } : bare);
  };
  const head = h('div', { className: 'cmd-power-head' }, h('strong', null, 'Power estimate'), h('span', { title: 'Estimates are kept for each robot' }, robotName));

  if (!own && !drafting && !sharedFrom) {
    // Offer the closest existing value: the same settings elsewhere, then the same command, then another robot here.
    const key = commandInputKey(invocation);
    const others = listCommandUses(project, robotId).filter((use) => use.stored && use.commandId === invocation.commandId);
    const same = others.find((use) => commandInputKey(use) === key && use.stored.inputKey === key);
    const similar = !same && others[0];
    const source = same || similar;
    const otherRobot = !source && Object.entries(invocation.power || {}).find(([id]) => id !== robotId);
    const otherName = otherRobot && robots.find((robot) => robot.id === otherRobot[0])?.name;
    return h('section', { className: 'cmd-power', 'aria-label': 'Power estimate' },
      head,
      resolved?.source === 'legacy' && h('p', { className: 'cmd-power-note' }, `Uses ${robotName}’s load for this command: ${amps(resolved.currentA)}, ${seconds(resolved.runTimeS).toLowerCase()}.`),
      source && h('div', { className: 'cmd-power-offer' },
        h('span', null, same ? 'Same settings in ' : 'This command in ', h('strong', null, placeOf(project, source.location)), ': ' + amps(source.stored.currentA) + (source.stored.runTimeS != null ? ', ' + seconds(source.stored.runTimeS) : '')),
        h('button', { type: 'button', className: 'qbtn', disabled: Boolean(capped), onClick: () => write({ currentA: source.stored.currentA, runTimeS: source.stored.runTimeS }) }, 'Copy')),
      otherRobot && otherName && h('div', { className: 'cmd-power-offer' },
        h('span', null, h('strong', null, otherName), ' draws ' + amps(otherRobot[1].currentA) + ' here.'),
        h('button', { type: 'button', className: 'qbtn', disabled: Boolean(capped), onClick: () => write({ currentA: otherRobot[1].currentA, runTimeS: otherRobot[1].runTimeS }) }, 'Copy')),
      // Adding stores the estimate at once (0 A, or the robot's older load for this command), so 0 A can be recorded.
      (capped || refused) && h('p', { className: 'cmd-param-error', role: capped ? undefined : 'alert' }, capped || refused),
      h('button', { type: 'button', className: 'qbtn cmd-power-add', disabled: Boolean(capped), onClick: () => { if (write({}) === false) setDrafting(true); requestAnimationFrame(() => document.querySelector('.cmd-power .numrow input')?.focus()); } }, h(Icon, { name: 'plus', size: 13 }), 'Add power estimate'));
  }
  const stale = own ? own.inputKey !== commandInputKey(invocation) : Boolean(resolved?.stale);
  return h('section', { className: 'cmd-power', 'aria-label': 'Power estimate' },
    head,
    stale && h('div', { className: 'cmd-power-review', role: 'status' },
      h('span', null, 'Entered for other settings. Check it still fits these.'),
      h('button', { type: 'button', className: 'qbtn', onClick: () => write({}) }, 'Keep ' + amps((own || resolved).currentA))),
    sharedFrom && h('p', { className: 'cmd-power-note cmd-power-shared' }, 'Shared from ', h('strong', null, sharedFrom), capped ? '.' : ' until you change it here.'),
    (capped || refused) && h('p', { className: 'cmd-param-error', role: capped ? undefined : 'alert' }, capped || refused),
    h(Num, { label: 'Current', value: own ? own.currentA : resolved?.currentA ?? 0, unit: 'A', min: 0, max: COMMAND_CURRENT_MAX_A, step: 1, precision: 1, onChange: (currentA) => write({ currentA }) }),
    h(RunTimeField, { value: own ? own.runTimeS : resolved?.runTimeS, onChange: (runTimeS) => write({ runTimeS }) }),
    h('div', { className: 'cmd-power-foot' },
      h('span', { className: 'cmd-power-note' }, place === 'step' ? 'This step only. Planning only; never sent to the robot.' : 'This event only. Planning only; never sent to the robot.'),
      own && h('button', { type: 'button', className: 'qbtn quiet', onClick: remove }, 'Remove')));
}

/**
 * The Robot page's view of command power: how many uses have an estimate on this robot, each use with its value
 * (choosing one opens it), and an older project's per-command loads with a way to move them onto the uses.
 * `power` adds { commands, openUse, changeProject } to the editor's context.
 */
export function CommandPowerSummary({ power }) {
  if (!power) return null;
  const { project, robotId, robotName, robots = [], commands = [], openUse, changeProject } = power;
  const robotLabel = (id) => robots.find((robot) => robot.id === id)?.name || 'the robot it was copied from';
  const uses = listCommandUses(project, robotId);
  const label = (id) => commands.find((command) => command.id === id)?.label || id;
  const estimated = uses.filter((use) => use.estimate).length;
  // A step in a generated trajectory's saved fallback can't be edited, so Next missing skips it.
  const missing = uses.find((use) => !use.estimate && !use.location.readOnly);
  const legacy = project.robot.driveModel?.commandLoads || [];
  const groups = [];
  for (const use of uses) {
    const key = use.location.kind + ':' + (use.location.kind === 'routineStep' ? use.location.routineId : use.location.pathId);
    let group = groups.find((item) => item.key === key);
    if (!group) groups.push(group = { key, name: placeOf(project, use.location), kind: use.location.kind === 'routineStep' ? 'Routine' : 'Path', uses: [] });
    group.uses.push(use);
  }
  const args = (use) => Object.values(use.arguments || {}).filter((value) => value !== null && typeof value !== 'object').map(String).join(' · ');
  return h(React.Fragment, null,
    h('div', { className: 'settings-card' },
      h('div', { className: 'settings-row' },
        h('span', null, uses.length ? h(React.Fragment, null, h('strong', { className: 'cmd-power-count' }, estimated + ' of ' + uses.length), ' command uses have an estimate for ' + robotName) : 'No commands are used yet'),
        missing && openUse && h('button', { type: 'button', className: 'qbtn', onClick: () => openUse(missing.location) }, 'Next missing'))),
    groups.map((group) => h('div', { key: group.key, className: 'settings-card cmd-power-group' },
      h('div', { className: 'cmd-power-group-head' }, h('strong', null, group.name), h('span', null, group.kind)),
      // A step in a generated trajectory's saved fallback has no inspector that can edit it, so its row doesn't open one.
      h('div', { role: 'list' }, group.uses.map((use, index) => h('button', { key: index, type: 'button', role: 'listitem', className: 'cmd-power-row', disabled: !openUse || use.location.readOnly,
        onClick: () => openUse?.(use.location), title: use.location.readOnly ? READ_ONLY_USE : undefined,
        'aria-label': `${label(use.commandId)} in ${group.name}: ${use.estimate ? amps(use.estimate.currentA) : 'no estimate'}${use.location.readOnly ? '. ' + READ_ONLY_USE : ''}` },
        h('span', { className: 'cmd-power-row-name' }, label(use.commandId), args(use) && h('span', { className: 'cmd-power-dim' }, ' ' + args(use))),
        h('span', { className: 'cmd-power-row-num' }, use.estimate ? amps(use.estimate.currentA) : h('span', { className: 'cmd-power-dim' }, 'No estimate')),
        h('span', { className: 'cmd-power-row-num' }, use.estimate ? seconds(use.estimate.runTimeS) : ''),
        h('span', { className: 'cmd-power-row-flag' + (use.estimate?.stale ? ' warn' : ''), title: use.estimate?.source === 'inherited' ? 'Shared from ' + robotLabel(use.estimate.fromRobotId) : undefined },
          use.estimate?.stale ? 'Review' : use.estimate?.source === 'legacy' ? 'Command load' : use.estimate?.source === 'inherited' ? 'Shared' : use.location.readOnly ? 'Read-only' : '')))))),
    legacy.length > 0 && h('div', { className: 'settings-card' },
      h('div', { className: 'settings-row' },
        // They stay as a fallback: removing them could leave a use that an Undo brings back with no load at all.
        h('span', null, 'Command loads from an older project fill every use of their command that has no estimate of its own.'),
        changeProject && h('span', { className: 'settings-control' },
          // Copying keeps the loads, so an Undo elsewhere can never leave a use with neither.
          legacyUncovered(uses, legacy) > 0 && h('button', { type: 'button', className: 'qbtn', disabled: !legacyCommandLoadsMigratable(project, robotId),
            title: legacyCommandLoadsMigratable(project, robotId) ? 'Gives each use of these commands its own estimate with the same values' : 'A load is outside 0–500 A or 0.01–3600 s',
            onClick: () => changeProject((current) => migrateLegacyCommandLoads(current, robotId)) }, 'Copy to each use'))),
      legacy.map((load) => h('div', { key: load.commandId, className: 'settings-row settings-sub' },
        h('span', null, label(load.commandId)),
        h('span', { className: 'settings-status' }, amps(load.currentA) + ' · ' + seconds(load.runTimeS))))));
}
