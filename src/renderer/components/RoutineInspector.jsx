import { deletionInput } from './DeletionNotice';
import * as React from "react";
import { CommandBranches } from "./CommandBranches";
import "../styles/command-branches.css";
import { AUTO } from "../lib/routineModel";
import { UnitPrefs } from "../lib/unitPreferences";
import { CommandParameterEditor, DeleteAction, InspectorShell, commandArguments, parameterValueError, safeControlId } from "./ContextInspector";
import { UI } from "./ui";
import { robotValueSchemasEqual } from "../../core/robotValueSchema";
import { ROUTINE_GROUP_CHILD_RULE } from "../../core/routineChildren";
import { describeStop, stepTitle } from "./RoutinePanel";
import { Glyph } from "./routineGlyphs";
import { routinePathChoices, routinePathUses } from "../lib/routinePathChoices";
import { PathLinks } from "../lib/pathLinks";
import { commandChoiceItems, commandChoiceRows, commandIndex, commandUsage, openSubsystem } from "../lib/commandIndex";
import { labelWidth } from "./pathTimelineModel";
import { PointerDrag } from "../hooks/usePointerDrag";
import { keyLabel, useKeyRules } from "../lib/keyBindings";

// Routine step inspector (right rail) and the bottom preview transport.
// One inspector system, shared with the Plan page (.ctxinsp shell + form primitives).
const h = React.createElement;
const { Icon, Dropdown, ChoiceBrowser, DraftText, Seg, Toggle } = UI;
const A = AUTO;
const fmt = (t) => UnitPrefs.format(t || 0, 's', 2);
const plural = (count, singular) => count + ' ' + singular + (count === 1 ? '' : /s$/.test(singular) ? 'es' : 's');
// Labels already say "in seconds", so no unit line repeats it under the field.
const SECONDS = { min: 0.02, max: 15 };
const OPERATORS = [['eq', 'Equals'], ['neq', 'Does not equal'], ['lt', 'Less than'], ['lte', 'At most'], ['gt', 'Greater than'], ['gte', 'At least']].map(([value, label]) => ({ value, label }));

function FieldLabel(t, right) { return h('div', { className: 'fieldlabel' }, h('span', null, t), right || null); }
const Hint = (text) => h('p', { className: 'seg-hint' }, text);
const Section = (title, ...children) => h('section', { className: 'rt-insp-sec', 'aria-label': title }, h('h3', { className: 'cgroup-h' }, title), ...children);

function outputValueDefault(schema) {
  if (schema.kind === 'boolean') return true;
  if (schema.kind === 'enum') return schema.enumValues[0];
  return schema.kind.endsWith('String') ? '0' : 0;
}

/** Ends section of a command or wait. A result-consuming command must finish, so it only offers a limit that ends the routine. */
function EndsSection({ node, routine, catalog, set }) {
  const ends = node.ends || {};
  const command = node.type === 'function';
  const consumer = command && A.isResultConsumer(routine, node.id);
  const write = (patch) => {
    const next = { ...ends, ...patch };
    Object.keys(next).forEach((key) => next[key] === undefined && delete next[key]);
    set({ ends: Object.keys(next).length ? next : undefined });
  };
  const early = Boolean(ends.endWhen);
  const limited = ends.timeoutS !== undefined;
  const conflict = consumer && (early || (limited && ends.onTimeout !== 'endRoutine'));
  return Section('Ends',
    Hint(command ? 'When the command reports finished.' : 'When the duration passes.'),
    consumer && h('p', { className: 'rt-insp-note' }, 'A result needs the command to finish.'),
    conflict && h('div', { className: 'rt-insp-problem', role: 'status' }, 'This ending would skip the result its branch or repeat reads.',
      h('button', { type: 'button', className: 'choice-change', onClick: () => write({ endWhen: undefined, ...(limited ? { onTimeout: 'endRoutine' } : {}) }) }, limited ? 'Use the limit to end the routine' : 'Remove the early end')),
    early && h('div', { className: 'rt-repair', role: 'group', 'aria-label': 'Saved condition ending' },
      Hint('Saved condition: ' + (ends.endWhen.conditionId || '(unselected)') + '. Use a command output branch for new decisions.'),
      h('button', { type: 'button', className: 'qbtn wide', onClick: () => write({ endWhen: undefined }) }, 'Remove saved condition ending')),
    command && h('div', { className: 'rt-insp-toggle' }, h(Toggle, { on: limited, label: 'Time limit', onChange: (on) => write(on ? A.newCommandEnds(routine, node.id) : { timeoutS: undefined, onTimeout: undefined }) })),
    command && limited && h(React.Fragment, null,
      h(CommandParameterEditor, { key: node.id + ':limit', id: 'routine-limit-' + safeControlId(node.id), label: 'Limit in seconds', schema: { kind: 'number' }, parameter: SECONDS, value: ends.timeoutS,
        onChange: (timeoutS) => write({ timeoutS }) }),
      FieldLabel('When the limit is reached'),
      h(Seg, { ariaLabel: 'When the limit is reached', value: ends.onTimeout || '', onChange: (onTimeout) => write({ onTimeout }),
        options: [{ v: 'continue', label: 'Continue', disabled: consumer, title: consumer ? 'A result needs the command to finish.' : undefined }, { v: 'endRoutine', label: 'End routine' }] })));
}

/** Check a completed command's typed result at the end of each pass. */
function RepeatStop({ node, catalog, set }) {
  const stop = node.until;
  const producers = node.nodes.filter((child) => child.type === 'function' && child.cat === 'command');
  const producer = stop?.source === 'output' ? producers.find((child) => child.id === stop.nodeId) : null;
  const command = catalog?.commands?.find((item) => item.id === producer?.invocation?.commandId);
  const outputs = A.branchOutputs(command);
  const output = stop?.source === 'output' ? outputs.find((item) => item.name === stop.output) : null;
  const numeric = stop?.schema && !['boolean', 'enum'].includes(stop.schema.kind);
  const mode = stop ? stop.source : 'never';
  return Section('Stop early',
    node.times !== undefined && h(Seg, { ariaLabel: 'Stop early', value: mode, options: [{ v: 'never', label: 'Never' }, { v: 'output', label: 'Command output' }],
      onChange: (next) => next === mode ? null : set({ until: next === 'never' ? undefined
        : { source: 'output', nodeId: producers.at(-1)?.id || '', output: '', operator: 'eq' } }) }),
    stop?.source === 'condition' && Hint('Saved condition: ' + (stop.conditionId || '(unselected)') + '. Choose a command output to replace it.'),
    stop?.source === 'output' && (producers.length === 0
      ? Hint('Add a command directly inside this repeat first.')
      : h(React.Fragment, null,
          h(Dropdown, { id: 'routine-repeat-producer', label: 'Command in this repeat', value: stop.nodeId || '',
            items: [...(stop.nodeId && !producer ? [{ value: stop.nodeId, label: 'Unavailable step', meta: 'Choose a command directly inside this repeat', badge: 'Missing' }] : []),
              ...producers.map((child) => ({ value: child.id, label: stepTitle(child, [], catalog) }))],
            onChange: (nodeId) => nodeId !== stop.nodeId && set({ until: { source: 'output', nodeId, output: '', operator: 'eq' } }) }),
          h(Dropdown, { id: 'routine-repeat-output', label: 'Result', value: stop.output || '',
            items: [{ value: '', label: outputs.length ? 'Choose a result' : 'This command has no branchable outputs' },
              ...(stop.output && !output ? [{ value: stop.output, label: stop.output, meta: 'Output unavailable · sync commands or choose another', badge: 'Missing' }] : []),
              ...outputs.map((item) => ({ value: item.name, label: item.label || item.name, meta: item.schema.kind === 'enum' ? 'Named outcomes' : item.schema.kind }))],
            onChange: (name) => {
              const next = outputs.find((item) => item.name === name);
              if (!next || name === stop.output) return;
              set({ until: { source: 'output', nodeId: stop.nodeId, output: name, schema: next.schema, operator: 'eq', value: outputValueDefault(next.schema) } });
            } }),
          // Structural agreement: key order alone is not a type change, so an equivalent snapshot keeps its value.
          // One explanation, beside its repair. The repair is explicit and says what it resets; it is one Undo step.
          stop.schema && output && !robotValueSchemasEqual(output.schema, stop.schema) && h('div', { className: 'rt-repair', role: 'group', 'aria-label': 'Result type changed' },
            h('p', { className: 'rt-insp-problem' }, stop.schema.valueType !== output.schema.valueType
              ? 'Saved as ' + stop.schema.valueType + '; the command now reports ' + output.schema.valueType + '.'
              : 'This result’s values changed since it was saved.'),
            h('button', { type: 'button', className: 'qbtn wide', onClick: () => set({ until: { ...stop, schema: output.schema, operator: 'eq', value: outputValueDefault(output.schema) } }) },
              'Use ' + (output.schema.valueType || 'the new type') + ' and reset the value')),
          stop.schema && h('div', { className: 'rt-stop-compare' },
            numeric && h(Dropdown, { id: 'routine-repeat-operator', label: 'Comparison', value: stop.operator, items: OPERATORS, onChange: (operator) => set({ until: { ...stop, operator } }) }),
            h(CommandParameterEditor, { key: node.id + ':' + stop.output, id: 'routine-repeat-value-' + safeControlId(node.id), label: numeric ? 'Value' : 'Stop when it is', schema: stop.schema,
              parameter: output || {}, value: stop.value, onChange: (value) => set({ until: { ...stop, value } }) })))),
    stop && Hint('Checked after each pass, using that pass’s completed command result.'));
}

const LOOP_SECONDS = { min: 0.02, max: 3600 };

/**
 * "Loop": start the command again each time it finishes, until a time from its first start (after which it isn't
 * started again; the run in progress finishes) or until its own completed output matches. A command that branches on its output cannot loop.
 */
function LoopSection({ node, command, set }) {
  const invocation = node.invocation || {};
  const until = invocation.loop?.until;
  const write = (loop) => {
    const { loop: _previous, ...rest } = invocation;
    set({ invocation: loop ? { ...rest, loop } : rest });
  };
  const outputs = A.branchOutputs(command);
  const branched = Boolean(node.outputBranch);
  const mode = !until ? 'off' : until.kind === 'time' ? 'time' : until.kind === 'output' ? 'output' : 'path';
  const output = until?.kind === 'output' ? outputs.find((item) => item.name === until.output) : null;
  const numeric = until?.kind === 'output' && until.schema && !['boolean', 'enum'].includes(until.schema.kind);
  const condition = (item) => ({ until: { kind: 'output', output: item.name, schema: item.schema, operator: 'eq', value: outputValueDefault(item.schema) } });
  const choose = (next) => {
    if (next === mode) return;
    if (next === 'off') write(undefined);
    else if (next === 'time') write({ until: { kind: 'time', seconds: 5 } });
    else if (outputs.length) write(condition(outputs[0]));
  };
  const noOutputs = 'This command has no outputs to check';
  return Section('Loop',
    FieldLabel('Loop until'),
    h(Seg, { ariaLabel: 'Loop until', value: mode, onChange: choose, options: [
      { v: 'off', label: 'Off' },
      { v: 'time', label: 'Time', disabled: branched && mode !== 'time', title: branched ? 'Remove the output branch to loop this command.' : 'Stop after a time from the first start' },
      { v: 'output', label: 'Condition', disabled: (branched || !outputs.length) && mode !== 'output', title: branched ? 'Remove the output branch to loop this command.' : outputs.length ? 'Stop when a completed run reports a value' : noOutputs },
    ] }),
    branched && mode === 'off' && Hint('A command that branches on its output runs once. Remove its branch to loop it.'),
    mode === 'off' && !branched && Hint('Runs once.'),
    mode === 'path' && h('div', { className: 'rt-repair', role: 'group', 'aria-label': 'Path-only loop' },
      h('p', { className: 'rt-insp-problem' }, 'Distance and path end loops apply only to path commands.'),
      h('button', { type: 'button', className: 'qbtn wide', onClick: () => write({ until: { kind: 'time', seconds: 5 } }) }, 'Loop for a time instead')),
    mode === 'time' && h(React.Fragment, null,
      h(CommandParameterEditor, { key: node.id + ':loop-time', id: 'routine-loop-time-' + safeControlId(node.id), label: 'Loop for seconds', schema: { kind: 'number' }, parameter: LOOP_SECONDS,
        value: until.seconds, onChange: (seconds) => write({ until: { kind: 'time', seconds } }) }),
      Hint('Starts again each time it finishes. After the limit it isn’t started again; the last run finishes.')),
    mode === 'output' && h(React.Fragment, null,
      h(Dropdown, { id: 'routine-loop-output', label: 'Result', value: until.output || '',
        items: [...(until.output && !output ? [{ value: until.output, label: until.output, meta: 'Output unavailable · sync commands or choose another', badge: 'Missing' }] : []),
          ...outputs.map((item) => ({ value: item.name, label: item.label || item.name, meta: item.schema.kind === 'enum' ? 'Named outcomes' : item.schema.kind }))],
        onChange: (name) => { const next = outputs.find((item) => item.name === name); if (next && name !== until.output) write(condition(next)); } }),
      until.schema && output && !robotValueSchemasEqual(output.schema, until.schema) && h('div', { className: 'rt-repair', role: 'group', 'aria-label': 'Result type changed' },
        h('p', { className: 'rt-insp-problem' }, until.schema.valueType !== output.schema.valueType
          ? 'Saved as ' + until.schema.valueType + '; the command now reports ' + output.schema.valueType + '.'
          : 'This result’s values changed since it was saved.'),
        h('button', { type: 'button', className: 'qbtn wide', onClick: () => write(condition(output)) }, 'Use ' + (output.schema.valueType || 'the new type') + ' and reset the value')),
      until.schema && h('div', { className: 'rt-stop-compare' },
        numeric && h(Dropdown, { id: 'routine-loop-operator', label: 'Comparison', value: until.operator, items: OPERATORS, onChange: (operator) => write({ until: { ...until, operator } }) }),
        h(CommandParameterEditor, { key: node.id + ':loop:' + until.output, id: 'routine-loop-value-' + safeControlId(node.id), label: numeric ? 'Value' : 'Stop when it is', schema: until.schema,
          parameter: output || {}, value: until.value, onChange: (value) => write({ until: { ...until, value } }) })),
      Hint('Checked after each completed run. Starts again until it matches.')));
}

/**
 * A command's preview time and where it comes from (A.commandTiming). An untimed command that a run time would time
 * points to the Robot page, where command loads keep run times; `onOpenRobot` goes there.
 */
function PreviewTime({ node, driveModel, onOpenRobot }) {
  const { durS, timing, runTimeS } = A.commandTiming(node, driveModel);
  const until = node.invocation?.loop?.until;
  const value = timing === 'estimate' || timing === 'upperBound' ? A.timingPrefix(timing) + fmt(durS)
    : until?.kind === 'output' ? 'Until result' : 'Untimed';
  const hint = timing === 'estimate' ? 'Estimated from its ' + fmt(runTimeS) + ' run time on the Robot page. Preview only; the robot does not use it.'
    : timing === 'upperBound' ? (runTimeS !== undefined ? 'Its run time on the Robot page reaches the time limit, so the preview uses the limit.' : 'Up to its time limit. A run time on the Robot page would estimate it.')
    : until?.kind === 'output' ? 'Runs until its result matches, so the preview cannot time it.'
    : until?.kind === 'time' ? 'The last run may finish after the loop time, so it is not counted. A run time on the Robot page would estimate it.'
    : 'Not counted in the preview time. Set a run time for this command on the Robot page to estimate it.';
  const suggest = runTimeS === undefined && until?.kind !== 'output' && onOpenRobot;
  return Section('Preview time',
    h(Facts, { className: 'rt-preview-time', rows: [[timing === 'estimate' ? 'Estimate' : 'In this preview', value]] }),
    Hint(hint),
    suggest && h('button', { type: 'button', className: 'choice-change rt-open-robot', onClick: onOpenRobot }, 'Open Robot page'));
}

function Problems({ issues, jumps, jump }) {
  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity !== 'error');
  if (!errors.length && !warnings.length && !jumps.length) return null;
  return h('div', { className: 'rt-insp-problems', role: 'status' },
    errors.map((issue, index) => h('p', { key: 'e' + index, className: 'rt-insp-problem' }, issue.message)),
    warnings.map((issue, index) => h('p', { key: 'w' + index, className: 'rt-insp-warning' }, issue.message)),
    jumps.length > 0 && h(PoseJumps, { jumps, ...jump }));
}

const JUMP_WORD = { small: 'Small jump', medium: 'Pose jump', large: 'Large jump' };
const degrees = (rad) => Math.round(rad * 180 / Math.PI);
/** Facts as key/value lines: [key, value, 'text'?] rows, falsy rows skipped. Values read as numbers unless marked text. */
function Facts({ rows, className = '' }) {
  return h('dl', { className: 'rt-kv' + (className ? ' ' + className : '') },
    rows.filter(Boolean).map(([key, value, kind]) => h('div', { key }, h('dt', null, key), h('dd', { className: kind === 'text' ? 'text' : undefined }, value))));
}
/**
 * The pose jumps into this path step (one per previous path the preview reaches it from), each one warning line sized
 * like the field's connector and the flow's mark (AUTO.jumpSize), naming the previous path by its step number. Each
 * offers to link this path's start to that previous path's end, the way Paths links points: the start, and any points
 * already linked to it, move there as one Undo step and stay linked. Headings belong to each waypoint, so the start
 * keeps its own facing. Why opens the longer explanation and what else the move reaches (linked points, other uses).
 */
function PoseJumps({ jumps, paths, pathLinks, routine, routines, onLink }) {
  const [why, setWhy] = React.useState(null);
  const to = paths.find((path) => path.id === jumps[0].toPathId);
  const numbers = A.stepNumbers(routine);
  // What else moves with this start: points already linked to it, and this path wherever else it is followed.
  const movable = to && onLink && jumps.some((issue) => issue.distanceM >= 5e-4 && issue.fromPathId !== to.id && paths.some((path) => path.id === issue.fromPathId));
  const members = to ? PathLinks.positionMembers({ paths, pathLinks }, to.id, 0).length : 0;
  const usesHere = to ? routinePathUses(routine).get(to.id) || 0 : 0;
  const elsewhere = to ? (routines || []).filter((other) => other.id !== routine.id && routinePathUses(other).has(to.id)).length : 0;
  const reach = !movable ? [] : [
    members && plural(members, 'point') + ' linked to this start ' + (members === 1 ? 'moves' : 'move') + ' with it.',
    elsewhere && to.name + ' is also used in ' + plural(elsewhere, 'other routine') + '; ' + (elsewhere === 1 ? 'it starts' : 'they start') + ' there too.',
    usesHere > 1 && 'This routine follows ' + to.name + ' ' + usesHere + ' times; each starts there.',
  ].filter(Boolean);
  return jumps.map((issue, index) => {
    const key = issue.fromNodeId + ':' + issue.nodeId, open = why === key;
    const from = paths.find((path) => path.id === issue.fromPathId), fromName = from?.name || 'the previous path', turn = degrees(issue.headingRad);
    const moves = issue.distanceM >= 5e-4, distance = UnitPrefs.format(issue.distanceM, 'm', 2);
    const number = numbers.get(issue.fromNodeId), end = number ? 'step ' + number + '\u2019s end' : 'the previous end';
    // Linking a path's start to its own end would fold it onto itself; that edit belongs in Paths.
    const self = moves && from && to && from.id === to.id;
    const link = moves && from && to && from.id !== to.id && onLink;
    const linkLabel = members ? 'Link start and ' + plural(members, 'linked point') + ' to ' + end : 'Link start to ' + end;
    return h('div', { key, className: 'rt-jump', 'data-size': issue.size },
      h('p', { className: 'rt-jump-text', title: fromName },
        h('span', { className: 'rt-step-flag', 'data-jump': issue.size, 'aria-hidden': true }),
        h('span', null, moves ? 'Starts ' + distance + (turn ? ' and ' + turn + '°' : '') + ' from ' + end : 'Faces ' + turn + '° away at ' + end)),
      self && h('p', { className: 'rt-jump-review' }, 'The previous path is this same path; move its start or end in Paths.'),
      h('div', { className: 'rt-jump-actions' },
        link && h('button', { type: 'button', className: 'qbtn rt-jump-link' + (jumps.length === 1 ? ' primary' : ''), onClick: () => onLink(issue) }, linkLabel),
        h('button', { type: 'button', className: 'rt-jump-why', 'aria-expanded': open, 'aria-controls': 'rt-jump-why-' + index, onClick: () => setWhy(open ? null : key) }, 'Why')),
      // Kept in the document while closed, so the explanation stays one Why away and its text is never rebuilt.
      h('div', { id: 'rt-jump-why-' + index, className: 'rt-jump-detail', hidden: !open },
        h('p', null, h('strong', null, moves ? JUMP_WORD[issue.size] : 'Facing jump'), '. ',
          moves ? 'Starts ' + distance + (turn ? ' and ' + turn + '°' : '') + ' from where ' : 'Starts where ', h('span', { className: 'rt-jump-path' }, fromName),
          moves ? ' ends in this preview.' : ' ends, facing ' + turn + '° differently.'),
        link && h('p', null, 'Linking moves this path\u2019s start ' + distance + ' to the end of ' + fromName + '. The two points stay linked; '
          + (turn ? 'the start keeps its own facing, ' + turn + '° different.' : 'facing stays local.')),
        index === jumps.length - 1 && reach.map((line, at) => h('p', { key: 'reach' + at, className: 'reach' }, line))));
  });
}

export function StepInspector(props) {
  const { node, paths, acq, run, robotProject } = props;
  const routine = props.routine || { nodes: node ? [node] : [] };
  const catalog = robotProject && robotProject.catalog;
  const [unwrapReason, setUnwrapReason] = React.useState('');
  React.useEffect(() => setUnwrapReason(''), [node?.id]);
  // After a pose jump's link, a note takes the pressed button's place and focus, so keyboard users keep their place.
  const [linked, setLinked] = React.useState(null);
  const linkedNote = React.useRef(null);
  React.useEffect(() => { if (linked && linkedNote.current) linkedNote.current.focus({ preventScroll: true }); }, [linked]);
  React.useEffect(() => setLinked(null), [node?.id]);
  const linkStart = (issue) => {
    if (acq.linkStart(issue) !== 'applied') return;
    const from = paths.find((path) => path.id === issue.fromPathId);
    setLinked({ nodeId: issue.nodeId, text: 'Start linked to the end of ' + (from?.name || 'the previous path') + '.' });
  };
  // Change command ranks and groups commands exactly like Add, including use in this routine and project.
  const usage = React.useMemo(() => commandUsage(props.routines, paths, routine), [props.routines, paths, routine]);
  if (!node) return null;
  // Command and output problems are explained once, beside their recovery control (picker or branch editor).
  const OWNED = node.type === 'function' ? ['command-unavailable', 'output-unavailable', 'output-schema-changed', 'loop-output-unavailable', 'loop-schema-changed', 'loop-path-only'] : node.type === 'repeat' ? ['stop-schema-changed'] : [];
  const issues = (props.issues || []).filter((issue) => issue.nodeId === node.id && !OWNED.includes(issue.code));
  const set = (patch) => acq.set(node.id, patch);
  const seg = (run?.segs || []).find((s) => s.nodeId === node.id);
  // Each branch names its removal with remove(label); the shell shows it in the footer. Every step says "Delete step",
  // like its row menu and the Delete key; the accessible name says which kind (a path step's path stays in Paths).
  let removal = null;
  const remove = (label) => { removal = h(DeleteAction, { label, visible: 'Delete step', ...deletionInput(() => acq.del(node.id)) }); return null; };
  const deployment = A.nodeDeploymentState(node, catalog);
  // The local-only boundary and preview assumptions are stated once, in the workspace header, not per step.
  let title = 'Step', body = null, tag = null;
  // Steps inside a generated trajectory's fallback are retained as authored and cannot be edited or removed here.
  if (A.locate(routine, node.id)?.readOnly) {
    return h(InspectorShell, { className: 'routine-insp', attrs: { 'data-step-id': node.id }, title: stepTitle(node, paths, catalog), kind: 'Read-only',
      closeLabel: 'Close step inspector', closeTitle: 'Close', onClose: () => acq.select(null), bodyKey: node.id }, Hint('Saved fallback. Read-only here.'));
  }

  if (node.type === 'path') {
    // The header names the chosen path; its facts are key/value lines (its preview time and length, where it lives,
    // and reuse). Change path opens the path library in the left rail, where paths are added too, and marks this step
    // in the flow; choosing a path there replaces the reference. A deleted path names the problem instead.
    const uses = routinePathUses(routine);
    const choice = routinePathChoices(paths, { folders: props.pathFolders, times: props.pathTimes, uses }).find((item) => item.path.id === node.ref);
    title = choice ? choice.path.name : 'Path'; tag = choice ? 'Path' : null;
    body = h(React.Fragment, null,
      choice
        ? h(React.Fragment, null,
            h(Facts, { className: 'routine-path-facts', rows: [seg && ['Duration', fmt(seg.t1 - seg.t0)], seg && ['Distance', UnitPrefs.format(seg.deriv.sample.length, 'm', 2)],
              choice.folder && ['Folder', choice.folder, 'text'], uses.get(node.ref) > 1 && ['In this routine', uses.get(node.ref) + '×']] }),
            h('div', { className: 'rt-insp-actions' },
              props.onChangePath && h('button', { type: 'button', className: 'qbtn routine-change-path', title: 'Choose another path from the path library',
                onClick: (event) => props.onChangePath(event.currentTarget) }, 'Change path'),
              h('button', { type: 'button', className: 'qbtn routine-open-path', onClick: () => acq.openInEditor(node.ref) }, 'Open in Paths')))
        : h('div', { className: 'rt-repair', role: 'group', 'aria-label': 'Unavailable path' },
            h('p', { className: 'rt-insp-problem' }, node.ref ? 'The referenced path is unavailable.' : 'No path chosen yet.'),
            !paths.length ? Hint('No paths yet. Create one in Paths.')
              : props.onChangePath && h('button', { type: 'button', className: 'qbtn wide routine-change-path', onClick: (event) => props.onChangePath(event.currentTarget) }, 'Choose a path')),
      remove('Delete path step. The path stays in Paths.'));

  } else if (node.type === 'builtin' && node.builtinId === 'bordeaux.wait') {
    title = 'Wait';
    body = h(React.Fragment, null,
      h(CommandParameterEditor, { key: node.id, id: 'routine-wait-' + safeControlId(node.id), label: 'Wait duration in seconds',
        schema: { kind: 'number' }, parameter: SECONDS, value: node.arguments && node.arguments.durationS,
        onChange: (durationS) => set({ arguments: { durationS } }) }),
      h(EndsSection, { node, routine, catalog, set }),
      remove('Delete wait'));

  } else if (node.type === 'decision') {
    title = 'Saved condition branch'; tag = 'Legacy';
    body = h(React.Fragment, null,
      Hint('Saved condition: ' + (node.cond || '(unselected)') + '. Routes kept. Use command outputs for new decisions.'),
      h('div', { className: 'rt-route-names' },
        h('div', { 'data-route-editor': 'then', tabIndex: -1 }, FieldLabel('When true'), h(DraftText, { className: 'textinput', 'aria-label': 'Name of the true route', value: node.thenLabel, owner: node.id + ':then', spellCheck: false, onCommit: (thenLabel) => thenLabel.trim() && thenLabel.trim() !== node.thenLabel && set({ thenLabel: thenLabel.trim() }) })),
        h('div', { 'data-route-editor': 'else', tabIndex: -1 }, FieldLabel('When false'), h(DraftText, { className: 'textinput', 'aria-label': 'Name of the false route', value: node.elseLabel, owner: node.id + ':else', spellCheck: false, onCommit: (elseLabel) => elseLabel.trim() && elseLabel.trim() !== node.elseLabel && set({ elseLabel: elseLabel.trim() }) }))),
      // The preview route is chosen on the route lanes in the flow, beside the steps it plays.
      remove('Delete branch'));

  } else if (node.type === 'repeat') {
    title = 'Repeat';
    const dynamic = node.times === undefined, previewLimit = node.times ?? 50;
    const passes = Math.min(previewLimit, acq.passes?.[node.id] ?? 1);
    body = h(React.Fragment, null,
      FieldLabel('Repeat mode'),
      h(Seg, { ariaLabel: 'Repeat mode', value: dynamic ? 'dynamic' : 'fixed', options: [{ v: 'fixed', label: 'Fixed count' }, { v: 'dynamic', label: 'Until output', title: 'Repeat until a completed command output matches' }],
        onChange: (mode) => set(mode === 'dynamic' ? { times: undefined, until: node.until?.source === 'output' ? node.until
          : { source: 'output', nodeId: node.nodes.findLast(child => child.type === 'function' && child.cat === 'command')?.id || '', output: '', operator: 'eq' } } : { times: 2 }) }),
      !dynamic && h(CommandParameterEditor, { key: node.id + ':times', id: 'routine-repeat-times-' + safeControlId(node.id), label: node.until ? 'Most passes' : 'Passes',
        schema: { kind: 'integer' }, parameter: { min: 1, max: 50 }, value: node.times, onChange: (times) => set({ times }) }),
      h(RepeatStop, { node, catalog, set }),
      node.until && Section('Preview',
        previewLimit <= 8 && FieldLabel('Passes to preview'),
        previewLimit <= 8
          ? h(Seg, { ariaLabel: 'Passes to preview', value: passes, options: Array.from({ length: previewLimit }, (_, index) => ({ v: index + 1, label: String(index + 1) })), onChange: (value) => acq.setPasses(node.id, value) })
          : h(CommandParameterEditor, { key: node.id + ':passes', id: 'routine-repeat-passes-' + safeControlId(node.id), label: 'Passes to preview', schema: { kind: 'integer' },
              parameter: { min: 1, max: previewLimit }, value: passes, onChange: (value) => acq.setPasses(node.id, value) }),
        Hint(dynamic || passes < node.times ? 'Assumes the stop check is true after pass ' + passes + '. This preview count does not limit runtime repetition.' : 'Runs every pass.')),
      h('div', { className: 'rt-insp-actions' }, h('button', { className: 'qbtn', type: 'button', onClick: () => {
        const result = acq.edit({ kind: 'unwrapRepeat', nodeId: node.id });
        setUnwrapReason(result.changed ? '' : result.reason || '');
      } }, h(Glyph, { name: 'repeat', size: 14 }), 'Remove repeat, keep steps')),
      unwrapReason && h('p', { className: 'rt-insp-problem', role: 'status' }, unwrapReason),
      remove('Delete repeat'));

  } else if (node.type === 'group') {
    title = A.groupLabel(node.mode);
    const parallel = node.mode !== 'sequential';
    const span = (run?.groupSpans || []).find((item) => item.nodeId === node.id);
    body = h(React.Fragment, null,
      FieldLabel('Name'),
      h(DraftText, { className: 'textinput', 'aria-label': 'Group name', value: node.title || '', placeholder: A.groupLabel(node.mode), owner: node.id + ':title', spellCheck: false,
        onCommit: (raw) => { const next = raw.trim(); if (next !== (node.title || '')) set({ title: next || undefined }); } }),
      FieldLabel('Runs'),
      h(Seg, { ariaLabel: 'Runs', value: parallel ? 'parallel' : 'sequential', options: [{ v: 'parallel', label: 'In parallel' }, { v: 'sequential', label: 'In sequence' }],
        onChange: (mode) => acq.edit({ kind: 'setGroupMode', nodeId: node.id, mode }) }),
      Hint(parallel ? 'Every step starts together. The group finishes when all of them finish.' : 'Each step starts when the one before it finishes.'),
      // The flow already lists its steps; the preview time is the one fact it adds.
      span && h(Facts, { rows: [[span.timing === 'estimate' ? 'Estimate' : 'In this preview', span.timing === 'unknown' ? 'Untimed' : A.timingPrefix(span.timing) + fmt(span.t1 - span.t0)]] }),
      span?.timing === 'estimate' && Hint('Estimated from command run times on the Robot page. Preview only.'),
      Hint(ROUTINE_GROUP_CHILD_RULE),
      h('div', { className: 'rt-insp-actions' }, h('button', { className: 'qbtn', type: 'button', onClick: () => acq.edit({ kind: 'unwrapGroup', nodeId: node.id }) }, h(Glyph, { name: parallel ? 'parallel' : 'sequential', size: 14 }), 'Remove group, keep steps')),
      remove('Delete group'));

  } else if (node.type === 'end') {
    if (node.scope === 'repeat') {
      title = 'Exit repeat';
      const repeat = A.locate(routine, A.locate(routine, node.id)?.repeatIds.at(-1))?.node;
      body = h(React.Fragment, null, repeat && Hint('Leaves “' + stepTitle(repeat, paths, catalog) + '”. Later steps in this pass never run.'), remove('Delete exit'));
    } else {
      title = 'End routine';
      body = h(React.Fragment, null, Hint('Ends the routine here. Later steps never run.'), remove('Delete end'));
    }

  } else if (node.type === 'generatedTrajectory') {
    // A saved definition only: it cannot be added, generated on the desktop, or delivered to a robot runner today.
    title = deployment.label || 'Generated trajectory'; tag = 'Not supported';
    body = h(React.Fragment, null,
      Hint('Saved runtime path. Preview and robot execution are unavailable.'),
      Hint('Saved fallback: ' + (node.fallback && node.fallback.type === 'branch' ? 'static steps, kept as saved and not checked (read-only)' : 'safe stop')),
      remove('Remove generated trajectory'));

  } else if (node.type === 'function' && node.cat === 'command') {
    title = 'Command';
    const commands = catalog ? catalog.commands || [] : [];
    const invocationId = node.invocation && node.invocation.commandId || '';
    const selected = commands.find((command) => command.id === invocationId);
    const parameters = selected ? (selected.parameters || []).filter((parameter) => parameter.role === 'argument') : [];
    const saved = node.invocation && node.invocation.arguments || {};
    const branchSteps = A.routeSteps(node.outputBranch?.routes || []);
    // Groups and loops never branch; the branch section says why instead of offering outputs.
    const branchBlocked = A.locate(routine, node.id)?.groupIds?.length ? 'Commands in a group run without branches. Move it out of the group to branch on its output.'
      : node.invocation?.loop ? 'A looping command can’t branch on its output, since each run could pick a different route. Turn off Loop to add routes.' : '';
    // A command reporting the same output with the same value type keeps the routes; the note names that output.
    const branchOutput = node.outputBranch && (A.branchOutputs(selected).find((output) => output.name === node.outputBranch.output)?.label || node.outputBranch.output);
    const argumentsValue = selected ? Object.fromEntries(parameters.map((parameter) => {
      const value = Object.prototype.hasOwnProperty.call(saved, parameter.name) ? saved[parameter.name] : undefined;
      return [parameter.name, parameterValueError(value, parameter) ? commandArguments(selected)[parameter.name] : value];
    })) : saved;
    // The step's name in the flow. Empty means the binding's default; a name the team gives stays through Change command.
    const ownName = A.commandOwnName(node), defaultName = A.commandDefaultTitle(selected);
    body = h(React.Fragment, null,
      FieldLabel('Name'),
      h(DraftText, { id: 'routine-step-name-' + safeControlId(node.id), className: 'textinput routine-step-name', 'aria-label': 'Step name', value: ownName,
        placeholder: invocationId ? defaultName : 'Name it for what it should do', maxLength: 256, owner: node.id + ':title', spellCheck: false,
        onCommit: (raw) => { const next = raw.trim(); if (next !== ownName) set({ title: next || defaultName, titleIsCustom: next ? true : undefined }); } }),
      !invocationId && Hint('Keeps this step apart from other placeholders. Bound later, it keeps the name and shows the command it runs.'),
      catalog
        ? h(ChoiceBrowser, { id: 'routine-command', resetKey: node.id, label: 'Command', value: invocationId,
            items: commandChoiceItems(commands), placeholder: 'Search commands', emptyText: 'No commands found in this project', icon: 'bolt',
            // The same subsystems, ranking and meta line as Add; Change opens on the current command's subsystem.
            search: (query, scope) => {
              const rows = commandChoiceRows(commandIndex(commands), query, scope, usage);
              return invocationId && !scope && !query.trim() ? [...rows, { value: '', label: 'Choose a command', meta: 'No command selected', section: 'No command' }] : rows;
            },
            openScope: openSubsystem(commandIndex(commands), invocationId), scopeName: (key) => commandIndex(commands).bySubsystem.get(key)?.name || key,
            note: branchSteps ? 'A command without a matching “' + branchOutput + '” output removes ' + plural(branchSteps, 'branch step') + '.' : undefined,
            onChoose: (value) => acq.branch(node.id, value === invocationId ? { kind: 'keep' } : { kind: 'command', commandId: value }) })
        // Without linked robot code there is no catalog to choose from; the saved command stays as authored.
        : h(React.Fragment, null,
            Hint(invocationId ? 'Saved command “' + invocationId + '” is kept. Link robot code to change it.' : 'Commands come from linked robot code.'),
            h('button', { type: 'button', className: 'qbtn wide', disabled: !robotProject?.link || robotProject.status === 'loading', onClick: () => robotProject.link() },
              robotProject?.status === 'loading' ? 'Loading…' : 'Link robot code…')),
      catalog && invocationId && !selected && h('div', { className: 'cmd-project-error', role: 'status' }, 'This saved command is missing from the linked catalog.'),
      selected && !selected.labviewConnector && h('div', { className: 'cmd-project-error', role: 'status' }, 'Refresh commands to load this command’s inputs before exporting.'),
      selected && h('form', { className: 'cmd-parameters', onSubmit: (event) => event.preventDefault() },
        parameters.length === 0 ? h('div', { className: 'cmd-empty-params' }, 'No parameters')
          : parameters.map((parameter) => h(CommandParameterEditor, {
              key: node.id + ':' + selected.id + ':' + parameter.name,
              id: 'routine-command-param-' + safeControlId(parameter.name),
              label: parameter.label || parameter.name,
              schema: parameter.schema,
              parameter,
              value: argumentsValue[parameter.name],
              onChange: (value) => set({ invocation: { ...node.invocation, commandId: selected.id, arguments: { ...argumentsValue, [parameter.name]: value } } }),
            }))),
      selected && h(LoopSection, { node, command: selected, set }),
      h(EndsSection, { node, routine, catalog, set }),
      h(PreviewTime, { node, driveModel: props.robot?.driveModel, onOpenRobot: props.onOpenRobot }),
      (selected || node.outputBranch) && h(CommandBranches, { node, command: selected, acq, ...(branchBlocked ? { blocked: branchBlocked } : {}) }),
      remove('Delete command'));

  } else {
    // Retained legacy or unknown data: shown and removable, never reinterpreted as new control flow.
    title = deployment.legacy ? (deployment.label || 'Legacy step') : 'Unsupported step'; tag = 'Legacy — cannot deploy';
    body = h(React.Fragment, null,
      Hint('Saved by an earlier Bordeaux format. ' + (node.cat === 'generate' && node.preview
        ? 'Plays the saved preview path. Runtime generation is unavailable.'
        : 'The preview ignores it and it has no robot contract.') + ' Its data is kept as saved until you remove it.'),
      remove('Remove unsupported step'));
  }

  // `data-step-id` lets the flow send focus here (a lane header opens its route; Branch on output opens the output choice).
  return h(InspectorShell, { className: 'routine-insp', attrs: { 'data-step-id': node.id }, title, kind: tag,
    closeLabel: 'Close step inspector', closeTitle: 'Close', onClose: () => acq.select(null), remove: removal,
    // Keyed by step so an unfinished draft never moves to another step.
    bodyKey: node.id },
    linked?.nodeId === node.id && h('p', { ref: linkedNote, className: 'rt-insp-note rt-jump-done', role: 'status', tabIndex: -1 }, linked.text),
    h(Problems, { issues, jumps: (run?.issues || []).filter((issue) => issue.code === 'reference-discontinuity' && issue.nodeId === node.id),
      jump: { paths, pathLinks: props.pathLinks, routine, routines: props.routines, onLink: acq.linkStart && linkStart } }),
    body);
}

/**
 * The right rail while an add-step slot is open beside a selected step: it shows where the new step lands instead of
 * the step selected before the slot opened. Close cancels the slot; the inspector returns when the slot closes.
 */
export function SlotInspector({ dest, onClose }) {
  return h(InspectorShell, { className: 'routine-insp routine-slot-insp', title: 'Add step', closeLabel: 'Cancel adding a step', closeTitle: 'Cancel (Esc)', onClose, bodyKey: 'slot' },
    h('p', { className: 'routine-slot-dest' }, dest),
    Hint('Choose a path or command in the left rail, or a step from the strip in the flow.'));
}

// The transport's track inside its 40px row: step segments in rows (a parallel group's steps stack), then marks for
// instant commands, branch checks and ends just above them. Rows shrink to share SEG_ROOM when many steps overlap.
const TRACK_H = 40, SEG_H = 6, SEG_ROOM = 20, MARK_GAP = 9, MARK_JOIN = 6, NL = String.fromCharCode(10);
/**
 * Lays out the chosen trace on a track `width` px wide (10px insets, as the playhead's handle needs): each step with a
 * duration on its first free row, each group's outline over the rows its steps use, and the instant steps gathered
 * into one mark per MARK_JOIN px so marks never overlap.
 */
function routineTrack(run, width) {
  const x = (t) => 10 + (width - 20) * (run.total ? t / run.total : 0);
  const rowEnds = [];
  const placed = run.steps.filter((step) => step.t1 > step.t0 && step.kind !== 'repeat').sort((a, b) => a.t0 - b.t0).map((step) => {
    let row = rowEnds.findIndex((end) => end <= step.t0 + 1e-9);
    if (row < 0) row = rowEnds.length;
    rowEnds[row] = step.t1;
    return { step, row };
  });
  const rows = Math.max(1, rowEnds.length), gap = rows > 3 ? 1 : 2;
  const rowH = Math.max(2, Math.min(SEG_H, Math.floor((SEG_ROOM - (rows - 1) * gap) / rows)));
  const height = rows * rowH + (rows - 1) * gap, top = Math.round((TRACK_H - height) / 2 + 3);
  const groups = (run.groupSpans || []).filter((group) => group.t1 > group.t0).map((group) => ({ ...group,
    rows: 1 + Math.max(0, ...placed.filter(({ step }) => step.t0 >= group.t0 - 1e-9 && step.t1 <= group.t1 + 1e-9).map(({ row }) => row)) }));
  const marks = [];
  run.steps.filter((step) => step.t1 <= step.t0 && ['event', 'dynamic', 'decision', 'end'].includes(step.kind)).sort((a, b) => a.t0 - b.t0).forEach((step) => {
    const at = x(step.t0), last = marks.at(-1);
    const kind = step.kind === 'decision' ? 'check' : step.kind === 'end' ? 'end' : 'cmd';
    if (last && at - last.x < MARK_JOIN) { last.steps.push(step); if (kind === 'cmd') last.kind = 'cmd'; }
    else marks.push({ x: at, t: step.t0, kind, steps: [step] });
  });
  return { blocks: placed, rows, rowH, gap, top, height, groups, marks, x };
}

/**
 * Preview transport: one slim row with Restart and Play, the time, a thin track of the chosen trace's steps, the step
 * playing now (before playback, the run's size), and the routine's view tools (`tools`: Power and About preview).
 * Steps with a duration are segments, without text; overlapping steps (a parallel group) stack in rows inside their
 * group's outline; instant and untimed commands are small marks above them. Limits draw hatched as upper bounds and run
 * time estimates dashed. Names are in the hover readout and each segment's title. The routine's facts (estimates,
 * untimed steps, pose jumps) are the flow's summary line, so the transport does not repeat them.
 * The track is a slider: drag the handle or press anywhere to seek (seeking pauses), hover to read a time and what runs
 * there, and use the arrows (Shift for 1 s), Page Up/Down for step starts, Home/End.
 */
export function RoutineTransport(props) {
  useKeyRules();
  const { run, routine, time, playing, controls, running, selectedId } = props;
  const playKey = keyLabel('playback.toggle');
  const occurrences = run.steps.filter((step) => step.kind !== 'repeat');
  // The flow numbers every authored step, including nested ones. Repeat passes share that step's number.
  const rowOf = React.useMemo(() => routine ? A.stepNumbers(routine) : null, [routine]);
  const stepCount = rowOf?.size ?? occurrences.length;
  const stepIndex = (t) => run.steps.length ? A.stepAt(run, t) : -1;
  const activeIdx = running || time > 0 ? stepIndex(time) : -1;
  const active = activeIdx >= 0 ? run.steps[activeIdx] : null;
  const pct = run.total > 0 ? Math.max(0, Math.min(1, time / run.total)) : 0;
  const timedPlayable = run.timedPlayable !== undefined ? run.timedPlayable : run.total > 0;
  const pass = active?.passStack?.at(-1);
  const passes = pass && run.steps.find((step) => step.kind === 'repeat' && step.nodeId === pass.repeatId)?.passes;
  const totalLabel = A.previewTotalLabel(run);
  // A repeat's pass marker is not itself a step; the step there is the first one after it.
  const playingAt = (t) => {
    const index = stepIndex(t);
    if (index < 0) return null;
    const found = run.steps.slice(index).findIndex((step) => step.kind !== 'repeat');
    if (found < 0) return null;
    const step = run.steps[index + found];
    return { step, ordinal: rowOf ? rowOf.get(step.nodeId) : run.steps.slice(0, index + found + 1).filter((item) => item.kind !== 'repeat').length };
  };
  const stepName = (step) => step.label || A.nodeTitle(step.node);
  const kindOf = (step) => step.kind === 'path' || step.kind === 'gen' ? 'path' : step.kind === 'wait' ? 'wait' : step.kind === 'event' ? 'cmd' : 'other';
  const at = (t) => `calc(10px + (100% - 20px) * ${run.total ? t / run.total : 0})`;
  const width = (d) => `calc((100% - 20px) * ${run.total ? d / run.total : 0})`;
  const editorRef = React.useRef(null), scrubRef = React.useRef(null);
  const [editorWidth, setEditorWidth] = React.useState(0);
  const [hover, setHover] = React.useState(null);
  const [dragging, setDragging] = React.useState(false);
  const drag = PointerDrag.useController();
  React.useLayoutEffect(() => {
    const element = editorRef.current; if (!element) return undefined;
    setEditorWidth(element.clientWidth);
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(() => setEditorWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const track = React.useMemo(() => routineTrack(run, editorWidth || 600), [run, editorWidth]);
  // The step slot holds only the place ("17 of 17") or, before playback, the run's size ("5 steps"), whichever is
  // longer, so the track keeps one width through playback and fills the row. The step playing now is named on the
  // field and lit in the flow; here it is in the slot's title and the slider's value text.
  const slot = React.useMemo(() => {
    const place = Math.ceil(Math.max(String(stepCount).length * 2 + 4, plural(stepCount, 'step').length) * 6.7 + 2);
    return { '--slot': place + 'px' };
  }, [stepCount]);
  const activeAt = (step) => (running || time > 0) && step.t0 <= time && time < step.t1;
  // Page Up/Down targets: every step start, and the end.
  const starts = [...new Set([...run.steps.map((step) => step.t0), run.total])].filter(Number.isFinite).sort((a, b) => a - b);
  const timeAt = (event) => {
    const rect = editorRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, (event.clientX - rect.left - 10) / Math.max(1, rect.width - 20))) * run.total;
  };
  const seek = (t) => controls.seek(Math.max(0, Math.min(run.total, t)));
  const onPointerDown = (event) => {
    if (!timedPlayable || event.button !== 0) return;
    event.preventDefault(); scrubRef.current?.focus({ preventScroll: true });
    setDragging(true); setHover(null); seek(timeAt(event));
    drag.start(event, { cursor: 'grabbing', move: (next) => seek(timeAt(next)), end: () => setDragging(false), cancel: () => setDragging(false) });
  };
  const onKeyDown = (event) => {
    if (!timedPlayable || event.altKey || event.ctrlKey || event.metaKey) return;
    const small = event.shiftKey ? 1 : 0.1;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? run.total
      : event.key === 'ArrowRight' || event.key === 'ArrowUp' ? time + small
      : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? time - small
      : event.key === 'PageDown' ? starts.find((t) => t > time + 1e-6) ?? run.total
      : event.key === 'PageUp' ? [...starts].reverse().find((t) => t < time - 1e-6) ?? 0 : null;
    if (next == null) return;
    event.preventDefault(); event.stopPropagation(); seek(next);
  };
  const now = active ? playingAt(time) : null;
  const readoutTime = dragging ? time : hover;
  const readout = readoutTime != null ? playingAt(readoutTime) : null;
  // A mark under the pointer names its commands in the readout; otherwise the step running at that time.
  const readoutMark = readoutTime != null ? track.marks.find((mark) => Math.abs(mark.x - track.x(readoutTime)) <= MARK_JOIN / 2 + 1) : null;
  const markNames = (mark) => mark.steps.map(stepName).join(', ');

  return h('div', { className: 'rt-transport timeline' + (running ? ' running' : '') + (timedPlayable ? '' : ' untimed') },
    h('div', { className: 'rt-tp-ctl' },
      h('button', { className: 'rt-tp-btn', type: 'button', title: 'Restart preview', 'aria-label': 'Restart routine', onClick: controls.reset }, h(Icon, { name: 'rewind', size: 14 })),
      h('button', { className: 'rt-tp-btn play', type: 'button', disabled: !timedPlayable, title: timedPlayable ? 'Play / pause preview' + (playKey ? '  (' + playKey + ')' : '') : 'Nothing in this preview has a duration', 'aria-label': playing ? 'Pause routine playback' : 'Play routine', onClick: controls.toggle }, h(Icon, { name: playing ? 'pause' : 'play', size: 15, fill: !playing }))),
    h('span', { className: 'rt-timeline-time' }, time.toFixed(2), h('small', null, ' / ' + totalLabel)),
    h('div', { className: 'rt-timeline-editor' + (dragging ? ' dragging' : ''), ref: editorRef, style: { '--routine-progress': pct, '--seg-top': track.top + 'px', '--seg-h': track.height + 'px' } },
      timedPlayable && h('span', { className: 'rt-timeline-track', 'aria-hidden': true }),
      track.groups.map((group) => h('span', { key: 'g' + group.occurrenceId, className: 'rt-timeline-group' + (group.timing === 'estimate' ? ' estimate' : ''),
        title: A.groupLabel(group.mode) + (group.timing === 'estimate' ? ', estimated' : group.timing === 'upperBound' ? ', up to its limits' : group.timing === 'unknown' ? ', has untimed steps' : ''),
        style: { left: at(group.t0), width: width(group.t1 - group.t0), top: track.top, height: group.rows * (track.rowH + track.gap) - track.gap } })),
      track.blocks.map(({ step, row }) => {
        const stepPass = step.passStack?.length ? step.passStack.at(-1).pass : 0;
        const loop = step.node?.invocation?.loop;
        return h('span', { key: step.occurrenceId || step.node.id, className: 'rt-timeline-span ' + kindOf(step) + (step.timing === 'upperBound' ? ' upper' : step.timing === 'estimate' ? ' estimate' : '')
            + (now?.step === step || activeAt(step) ? ' on' : '') + (selectedId && step.nodeId === selectedId ? ' sel' : ''),
          title: (step.timing === 'upperBound' ? 'Up to ' : '') + stepName(step) + (stepPass ? ', pass ' + stepPass : '') + (loop ? ', loops ' + A.loopSummary(loop) : '')
            + (step.timing === 'estimate' ? ', about ' + fmt(step.t1 - step.t0) + ' from its run time' : ''),
          style: { left: at(step.t0), width: width(step.t1 - step.t0), top: track.top + row * (track.rowH + track.gap), height: track.rowH } });
      }),
      timedPlayable && track.marks.map((mark) => h('span', { key: 'm' + mark.t + ':' + mark.steps.length, className: 'rt-timeline-mark ' + mark.kind + (mark.steps.length > 1 ? ' many' : '') + (mark.steps.includes(now?.step) ? ' on' : ''),
        title: mark.steps.map((step) => stepName(step) + (step.node?.invocation?.loop ? ', loops ' + A.loopSummary(step.node.invocation.loop) : step.timing === 'unknown' ? ' (untimed)' : '')).join(NL),
        style: { left: mark.x, top: track.top - MARK_GAP } })),
      !timedPlayable && h('span', { className: 'rt-timeline-empty', title: run.blocked ? undefined : 'Nothing to scrub: no step in this preview has a duration' }, run.blocked ? 'Preview unavailable' : 'No step in this preview has a duration'),
      timedPlayable && hover != null && !dragging && h('span', { className: 'rt-timeline-hover', style: { left: at(hover) }, 'aria-hidden': true }),
      timedPlayable && h('span', { className: 'rt-timeline-playhead', 'aria-hidden': true }),
      timedPlayable && readoutTime != null && h('span', { className: 'rt-timeline-readout', style: { '--at': run.total ? readoutTime / run.total : 0 }, 'aria-hidden': true },
        h('b', null, fmt(readoutTime)), readoutMark ? h('span', { className: 'cmd' }, markNames(readoutMark)) : readout && h('span', null, stepName(readout.step))),
      h('div', { ref: scrubRef, className: 'rt-tp-scrub', role: 'slider', tabIndex: timedPlayable ? 0 : -1, 'aria-label': 'Routine playback position',
        'aria-disabled': timedPlayable ? undefined : true, 'aria-valuemin': 0, 'aria-valuemax': Number(run.total.toFixed(2)), 'aria-valuenow': Number(time.toFixed(2)),
        'aria-valuetext': fmt(time) + ' of ' + totalLabel + (now ? ', ' + stepName(now.step) : ''),
        onPointerDown, onKeyDown,
        onPointerMove: (event) => { if (timedPlayable && !dragging && event.pointerType !== 'touch') setHover(timeAt(event)); },
        onPointerLeave: () => setHover(null) })),
    // A fixed slot, so the track keeps its width through playback: the place in the run order, or before playback the
    // run's size. The title names the step playing now and its pass.
    h('div', { className: 'rt-tp-now', style: slot },
      h('div', { className: 'rt-timeline-step', title: now ? stepName(now.step) + (pass && passes ? ', pass ' + pass.pass + ' of ' + passes : '') : undefined },
        now ? h('small', null, now.ordinal + ' of ' + stepCount) : stepCount > 0 && h('small', null, plural(stepCount, 'step')))),
    props.tools && h('div', { className: 'rt-tp-tools' }, props.tools));
}
