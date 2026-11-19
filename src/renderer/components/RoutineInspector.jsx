import { deletionInput } from './DeletionNotice';
import * as React from "react";
import { CommandBranches } from "./CommandBranches";
import "../styles/command-branches.css";
import { AUTO } from "../lib/routineModel";
import { UnitPrefs } from "../lib/unitPreferences";
import { CommandParameterEditor, commandArguments, parameterValueError, safeControlId } from "./ContextInspector";
import { UI } from "./ui";
import { robotValueSchemasEqual } from "../../shared/robotValueSchema";
import { continuityText, describeStop, stepTitle } from "./RoutinePanel";
import { Glyph } from "./routineGlyphs";
import { routinePathChoices, routinePathUses } from "../lib/routinePathChoices";
import { commandChoiceItems, commandChoiceRows, commandIndex, commandUsage, openSubsystem } from "../lib/commandIndex";
import { labelWidth, layoutCommandLane, niceStep } from "./pathTimelineModel";
import { ChipGlyph, LOOP_GLYPH } from "./PathTimeline";
import { PointerDrag } from "../hooks/usePointerDrag";

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

function Problems({ issues, jumps }) {
  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity !== 'error');
  if (!errors.length && !warnings.length && !jumps.length) return null;
  return h('div', { className: 'rt-insp-problems', role: 'status' },
    errors.map((issue, index) => h('p', { key: 'e' + index, className: 'rt-insp-problem' }, issue.message)),
    warnings.map((issue, index) => h('p', { key: 'w' + index, className: 'rt-insp-warning' }, issue.message)),
    jumps.slice(0, 1).map((issue, index) => h('p', { key: 'j' + index, className: 'rt-insp-warning' }, continuityText(issue) + ' in this preview. Reference poses only.')));
}

export function StepInspector(props) {
  const { node, paths, acq, run, robotProject } = props;
  const routine = props.routine || { nodes: node ? [node] : [] };
  const catalog = robotProject && robotProject.catalog;
  const [unwrapReason, setUnwrapReason] = React.useState('');
  React.useEffect(() => setUnwrapReason(''), [node?.id]);
  // Change command ranks and groups commands exactly like Add, including use in this routine and project.
  const usage = React.useMemo(() => commandUsage(props.routines, paths, routine), [props.routines, paths, routine]);
  if (!node) return null;
  // Command and output problems are explained once, beside their recovery control (picker or branch editor).
  const OWNED = node.type === 'function' ? ['command-unavailable', 'output-unavailable', 'output-schema-changed', 'loop-output-unavailable', 'loop-schema-changed', 'loop-path-only'] : node.type === 'repeat' ? ['stop-schema-changed'] : [];
  const issues = (props.issues || []).filter((issue) => issue.nodeId === node.id && !OWNED.includes(issue.code));
  const set = (patch) => acq.set(node.id, patch);
  const seg = (run?.segs || []).find((s) => s.nodeId === node.id);
  const remove = (label) => h('button', { className: 'delbtn', type: 'button', ...deletionInput(() => acq.del(node.id)) }, h(Icon, { name: 'trash', size: 15 }), label);
  const deployment = A.nodeDeploymentState(node, catalog);
  // The local-only boundary and preview assumptions are stated once, in the workspace header, not per step.
  let title = 'Step', body = null, tag = null;
  // Steps inside a generated trajectory's fallback are retained as authored and cannot be edited or removed here.
  if (A.locate(routine, node.id)?.readOnly) {
    return h('div', { className: 'ctxinsp inspector-refresh routine-insp', 'data-step-id': node.id },
      h('div', { className: 'ctxinsp-hd' },
        h('span', { className: 'ctxinsp-t', title: stepTitle(node, paths, catalog) }, stepTitle(node, paths, catalog)),
        h('span', { className: 'ctxinsp-tag' }, 'Read-only'),
        h('button', { className: 'ctxinsp-x', type: 'button', title: 'Close', 'aria-label': 'Close step inspector', onClick: () => acq.select(null) }, h(Icon, { name: 'x', size: 14 }))),
      h('div', { className: 'ctxinsp-body', key: node.id }, Hint('Saved fallback. Read-only here.')));
  }

  if (node.type === 'path') {
    title = 'Path';
    // The chosen path reads as a card. Change opens the path library in the left rail, where paths are added too, and
    // marks this step in the flow; choosing a path there replaces the reference. A deleted path names the problem.
    const choice = routinePathChoices(paths, { folders: props.pathFolders, times: props.pathTimes, uses: routinePathUses(routine) }).find((item) => item.path.id === node.ref);
    body = h(React.Fragment, null,
      h('section', { className: 'choice-browser routine-path-choice', 'aria-label': 'Path to follow' },
        h('div', { className: 'choice-browser-heading' }, h('span', { className: 'fieldlabel' }, 'Path to follow'),
          choice && props.onChangePath && h('button', { type: 'button', className: 'choice-change routine-change-path', title: 'Choose another path from the path library',
            onClick: (event) => props.onChangePath(event.currentTarget) }, 'Change path')),
        choice
          ? h('div', { className: 'choice-current' }, h(Icon, { name: 'route', size: 15 }), h('div', null, h('strong', null, choice.path.name), choice.meta && h('small', null, choice.meta)))
          : h('div', { className: 'rt-repair', role: 'group', 'aria-label': 'Unavailable path' },
              h('p', { className: 'rt-insp-problem' }, node.ref ? 'The referenced path is unavailable.' : 'No path chosen yet.'),
              !paths.length ? Hint('No paths yet. Create one in Paths.')
                : props.onChangePath && h('button', { type: 'button', className: 'qbtn wide routine-change-path', onClick: (event) => props.onChangePath(event.currentTarget) }, 'Choose a path'))),
      seg && h('div', { className: 'rt-stat' },
        h('div', { className: 'rt-stat-i' }, h('span', { className: 'rt-stat-v' }, fmt(seg.t1 - seg.t0)), h('span', { className: 'rt-stat-k' }, 'Duration')),
        h('div', { className: 'rt-stat-i' }, h('span', { className: 'rt-stat-v' }, UnitPrefs.format(seg.deriv.sample.length, 'm', 2)), h('span', { className: 'rt-stat-k' }, 'Distance')),
        h('div', { className: 'rt-stat-i' }, h('span', { className: 'rt-stat-v' }, '#' + seg.idxLabel), h('span', { className: 'rt-stat-k' }, 'Run order'))),
      paths.some((path) => path.id === node.ref) && h('button', { className: 'rt-openbtn', type: 'button', onClick: () => acq.openInEditor(node.ref) }, h(Icon, { name: 'route', size: 14 }), 'Open in path editor'),
      remove('Remove from routine'));

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
      h('button', { className: 'rt-openbtn', type: 'button', onClick: () => {
        const result = acq.edit({ kind: 'unwrapRepeat', nodeId: node.id });
        setUnwrapReason(result.changed ? '' : result.reason || '');
      } }, h(Glyph, { name: 'repeat', size: 14 }), 'Remove repeat, keep steps'),
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
      h('div', { className: 'rt-stat' },
        h('div', { className: 'rt-stat-i' }, h('span', { className: 'rt-stat-v' }, String(node.nodes.length)), h('span', { className: 'rt-stat-k' }, node.nodes.length === 1 ? 'Step' : 'Steps')),
        span && h('div', { className: 'rt-stat-i' }, h('span', { className: 'rt-stat-v' }, A.groupTiming(node) === 'unknown' ? 'Untimed' : (A.groupTiming(node) === 'upperBound' ? '≤ ' : '') + fmt(span.t1 - span.t0)), h('span', { className: 'rt-stat-k' }, 'In this preview'))),
      Hint('A group holds commands without branches, waits and other groups.'),
      h('button', { className: 'rt-openbtn', type: 'button', onClick: () => acq.edit({ kind: 'unwrapGroup', nodeId: node.id }) }, h(Glyph, { name: parallel ? 'parallel' : 'sequential', size: 14 }), 'Remove group, keep steps'),
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
    body = h(React.Fragment, null,
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
  return h('div', { className: 'ctxinsp inspector-refresh routine-insp', 'data-step-id': node.id },
    h('div', { className: 'ctxinsp-hd' },
      h('span', { className: 'ctxinsp-t', title }, title),
      tag && h('span', { className: 'ctxinsp-tag' }, tag),
      h('button', { className: 'ctxinsp-x', type: 'button', title: 'Close', 'aria-label': 'Close step inspector', onClick: () => acq.select(null) }, h(Icon, { name: 'x', size: 14 }))),
    // Keyed by step so an unfinished draft never moves to another step.
    h('div', { className: 'ctxinsp-body', key: node.id },
      h(Problems, { issues, jumps: (run?.issues || []).filter((issue) => issue.code === 'reference-discontinuity' && issue.nodeId === node.id) }),
      body));
}

/** Preview transport. Time is the chosen trace's display time: limits draw as upper bounds, untimed commands as markers.
 * The scrubber is a slider over a time scale: drag the handle or press anywhere on the lane to seek (seeking pauses),
 * hover to read a time and the step there, and use the arrows (Shift for 1 s), Page Up/Down for step starts, Home/End. */
// The routine scrubber's rows: the seconds scale, block rows from LANE_TOP, then chip rows for instant commands.
const LANE_TOP = 22, LANE_ROW = 20, CHIP_ROW = 21, MAX_BLOCK_ROWS = 4, NL = String.fromCharCode(10);
function routineLane(run, width) {
  const x = (t) => 10 + (width - 20) * (run.total ? t / run.total : 0);
  const rowEnds = [];
  const placed = run.steps.filter((step) => step.t1 > step.t0 && step.kind !== 'repeat').sort((a, b) => a.t0 - b.t0).map((step) => {
    let row = rowEnds.findIndex((end) => end <= step.t0 + 1e-9);
    if (row < 0) row = rowEnds.length;
    rowEnds[row] = step.t1;
    return { step, row };
  });
  const rows = Math.max(1, rowEnds.length);
  // Every simultaneous step keeps its own row. Past four rows they share the four-row height instead of overlapping;
  // rows too thin for a label keep the name in the block's tooltip.
  const rowH = rows > MAX_BLOCK_ROWS ? Math.max(6, Math.floor((MAX_BLOCK_ROWS * LANE_ROW) / rows)) : LANE_ROW;
  const blocks = placed.map(({ step, row }) => ({ step, row, wide: rowH >= LANE_ROW - 2 && x(step.t1) - x(step.t0) >= 34 }));
  const groups = (run.groupSpans || []).filter((group) => group.t1 > group.t0).map((group) => ({ ...group,
    rows: 1 + Math.max(0, ...blocks.filter(({ step }) => step.t0 >= group.t0 - 1e-9 && step.t1 <= group.t1 + 1e-9).map(({ row }) => row)) }));
  const instant = run.steps.filter((step) => step.t1 <= step.t0 && (step.kind === 'event' || step.kind === 'dynamic')).map((step, index) => {
    const label = step.label || A.nodeTitle(step.node), loop = step.node?.invocation?.loop ? 15 : 0;
    return { step, t: step.t0, key: step.occurrenceId || step.node.id + ':' + index, label, w: Math.min(168, Math.ceil(labelWidth(label)) + 28 + loop), minW: 46 + loop };
  });
  const { chips, rows: chipRows } = run.total > 0 ? layoutCommandLane(instant, { x, left: 2, right: width - 2, rows: 2, stackWidth: (count) => Math.ceil(labelWidth('+' + count)) + 34 })
    : { chips: [], rows: 0 };
  const chipTop = LANE_TOP + rows * rowH + 2;
  return { blocks, rows, rowH, groups, chips, chipTop, height: chipTop + chipRows * CHIP_ROW + 4 };
}

export function RoutineTransport(props) {
  const { run, time, playing, controls, running } = props;
  const occurrences = run.steps.filter((step) => step.kind !== 'repeat');
  const stepIndex = (t) => run.steps.length ? A.stepAt(run, t) : -1;
  const activeIdx = running || time > 0 ? stepIndex(time) : -1;
  const active = activeIdx >= 0 ? run.steps[activeIdx] : null;
  const pct = run.total > 0 ? Math.max(0, Math.min(1, time / run.total)) : 0;
  const duration = run.duration || { maxS: run.total, unknownCount: 0, usesLimits: false };
  const timedPlayable = run.timedPlayable !== undefined ? run.timedPlayable : run.total > 0;
  const pass = active?.passStack?.at(-1);
  const passes = pass && run.steps.find((step) => step.kind === 'repeat' && step.nodeId === pass.repeatId)?.passes;
  const jumps = (run.issues || []).filter((issue) => issue.code === 'reference-discontinuity').length;
  const totalLabel = duration.maxS !== null && duration.usesLimits ? '≤ ' + fmt(run.total) : fmt(run.total);
  const summary = [
    duration.usesLimits && 'Using time limits',
    // Untimed steps add no preview time; that is not a claim that they take none.
    duration.unknownCount > 0 && plural(duration.unknownCount, 'untimed step') + ' not counted',
    jumps > 0 && plural(jumps, 'pose jump'),
    run.truncated && 'Preview stops at 2,000 steps',
    !timedPlayable && occurrences.length > 0 && !run.blocked && 'Untimed preview',
  ].filter(Boolean).join(' · ');
  // A repeat's pass marker is not itself a step; the step there is the first one after it.
  const playingAt = (t) => {
    const index = stepIndex(t);
    if (index < 0) return null;
    const found = run.steps.slice(index).findIndex((step) => step.kind !== 'repeat');
    return found < 0 ? null : { step: run.steps[index + found], ordinal: run.steps.slice(0, index + found + 1).filter((step) => step.kind !== 'repeat').length };
  };
  const stepName = (step) => step.label || A.nodeTitle(step.node);
  const color = (step) => step.kind === 'path' || step.kind === 'gen' ? 'var(--accent)' : step.kind === 'wait' ? 'var(--warn)' : step.kind === 'event' ? 'var(--cmd)' : 'var(--txt-3)';
  const at = (t) => `calc(10px + (100% - 20px) * ${run.total ? t / run.total : 0})`;
  const width = (d) => `calc((100% - 20px) * ${run.total ? d / run.total : 0})`;
  const marks = run.steps.filter((step) => step.t1 <= step.t0 && (step.kind === 'decision' || step.kind === 'end'));
  const markClass = (step) => step.kind === 'decision' ? 'rt-timeline-event' : 'rt-timeline-end';
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
  const markLabel = (step) => step.label || A.nodeTitle(step.node);
  // Steps with a duration are labelled blocks on the seconds scale; steps that overlap (a parallel group's children)
  // stack in rows over the same span. Instant and untimed commands are chips like the Paths command lane: a diamond
  // on their time, the name facing into the lane, crowds shortened or gathered into "+N".
  const lane = React.useMemo(() => routineLane(run, editorWidth || 600), [run, editorWidth]);
  const activeAt = (step) => (running || time > 0) && step.t0 <= time && time < step.t1;
  // Seconds scale, spaced like the Paths timeline's time axis.
  const tickStep = timedPlayable && editorWidth > 40 ? niceStep(run.total, Math.max(2, (editorWidth - 20) / 84)) : 0;
  const tickDigits = tickStep ? Math.max(0, Math.min(2, -Math.floor(Math.log10(tickStep) + 1e-9))) : 0;
  const ticks = tickStep ? Array.from({ length: Math.min(60, Math.floor(run.total / tickStep + 1e-6) + 1) }, (_, i) => Number((i * tickStep).toFixed(4))) : [];
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

  return h('div', { className: 'rt-transport timeline' + (running ? ' running' : '') + (timedPlayable ? '' : ' untimed') },
    h('div', { className: 'rt-timeline-toolbar' },
      h('div', { className: 'rt-tp-ctl' },
        h('button', { className: 'rt-tp-btn', type: 'button', title: 'Restart preview', 'aria-label': 'Restart routine', onClick: controls.reset }, h(Icon, { name: 'rewind', size: 14 })),
        h('button', { className: 'rt-tp-btn play', type: 'button', disabled: !timedPlayable, title: timedPlayable ? 'Play / pause preview  (Space)' : 'Nothing in this preview has a duration', 'aria-label': playing ? 'Pause routine playback' : 'Play routine', onClick: controls.toggle }, h(Icon, { name: playing ? 'pause' : 'play', size: 15, fill: !playing }))),
      h('span', { className: 'rt-timeline-time' }, time.toFixed(2), h('small', null, ' / ' + totalLabel)),
      h('span', { className: 'rt-timeline-summary', title: summary || undefined }, summary),
      pass && passes && h('span', { className: 'rt-timeline-pass-now' }, 'Pass ' + pass.pass + ' of ' + passes),
      // The step playing now by name, then its place in the run order. Before playback, the run's size.
      h('div', { className: 'rt-timeline-step', title: now ? stepName(now.step) : undefined },
        now ? h(React.Fragment, null, h('span', { className: 'rt-timeline-now' }, stepName(now.step)), h('small', null, now.ordinal + ' of ' + occurrences.length))
          : occurrences.length > 0 && h('small', null, plural(occurrences.length, 'step')))),
    h('div', { className: 'rt-timeline-editor' + (dragging ? ' dragging' : ''), ref: editorRef, style: { '--routine-progress': pct, height: lane.height } },
      ticks.map((t, i) => h('span', { key: 'tick' + i, className: 'rt-timeline-tick' + (t / run.total > 0.97 ? ' end' : ''), style: { left: at(t) }, 'aria-hidden': true }, t === 0 ? '0' : t.toFixed(tickDigits))),
      h('span', { className: 'rt-timeline-track', style: { height: lane.rows * lane.rowH - 2 } }),
      lane.groups.map((group) => h('span', { key: 'g' + group.occurrenceId, className: 'rt-timeline-group', title: A.groupLabel(group.mode),
        style: { left: at(group.t0), width: width(group.t1 - group.t0), height: group.rows * lane.rowH + 2 } })),
      lane.blocks.map(({ step, row, wide }) => {
        const pass = step.passStack?.length ? step.passStack.at(-1).pass : 0;
        const loop = step.node?.invocation?.loop;
        const name = stepName(step);
        return h('span', { key: step.occurrenceId || step.node.id, className: 'rt-timeline-span' + (step.timing === 'upperBound' ? ' upper' : '') + (now?.step === step || activeAt(step) ? ' on' : ''),
          title: (step.timing === 'upperBound' ? 'Up to ' : '') + name + (pass ? ', pass ' + pass : '') + (loop ? ', loops ' + A.loopSummary(loop) : ''),
          style: { left: at(step.t0), width: width(step.t1 - step.t0), top: LANE_TOP + row * lane.rowH, ...(lane.rowH < LANE_ROW ? { height: lane.rowH - 2 } : {}), '--step-color': color(step) } },
          wide && h('span', { className: 'rt-timeline-name' }, name),
          wide && pass > 0 && h('small', null, pass),
          wide && loop && h(ChipGlyph, { className: 'rt-timeline-glyph', d: LOOP_GLYPH }));
      }),
      timedPlayable && marks.map((step) => h('span', { key: 'm' + (step.occurrenceId || step.node.id), className: markClass(step), title: markLabel(step), style: { left: at(step.t0) } })),
      timedPlayable && lane.chips.map((chip) => {
        const top = lane.chipTop + chip.row * CHIP_ROW, side = chip.dir === 'left' ? ' left' : '';
        if (chip.stack) return h('span', { key: 's' + chip.members[0].key, className: 'rt-timeline-chip stack' + side, title: chip.members.map((member) => member.label).join(NL),
          style: { left: chip.left, width: chip.w, top } }, h('span', { className: 'pt-stack-glyph' }), h('span', { className: 'rt-timeline-name' }, '+' + chip.members.length));
        const loop = chip.step.node?.invocation?.loop;
        return h('span', { key: chip.key, className: 'rt-timeline-chip' + side + (now?.step === chip.step ? ' on' : ''),
          title: chip.label + (loop ? ', loops ' + A.loopSummary(loop) : chip.step.timing === 'unknown' ? ' (untimed)' : ''), style: { left: chip.left, width: chip.w, top } },
          h('span', { className: 'pt-diamond' }), h('span', { className: 'rt-timeline-name' }, chip.label), loop && h(ChipGlyph, { className: 'rt-timeline-glyph', d: LOOP_GLYPH }));
      }),
      !timedPlayable && h('span', { className: 'rt-timeline-empty' }, run.blocked ? 'Preview unavailable' : 'Nothing to scrub: no step in this preview has a duration'),
      timedPlayable && hover != null && !dragging && h('span', { className: 'rt-timeline-hover', style: { left: at(hover) }, 'aria-hidden': true }),
      timedPlayable && h('span', { className: 'rt-timeline-playhead', 'aria-hidden': true }),
      timedPlayable && readoutTime != null && h('span', { className: 'rt-timeline-readout', style: { '--at': run.total ? readoutTime / run.total : 0 }, 'aria-hidden': true },
        h('b', null, fmt(readoutTime)), readout && h('span', null, stepName(readout.step))),
      h('div', { ref: scrubRef, className: 'rt-tp-scrub', role: 'slider', tabIndex: timedPlayable ? 0 : -1, 'aria-label': 'Routine playback position',
        'aria-disabled': timedPlayable ? undefined : true, 'aria-valuemin': 0, 'aria-valuemax': Number(run.total.toFixed(2)), 'aria-valuenow': Number(time.toFixed(2)),
        'aria-valuetext': fmt(time) + ' of ' + totalLabel + (now ? ', ' + stepName(now.step) : ''),
        onPointerDown, onKeyDown,
        onPointerMove: (event) => { if (timedPlayable && !dragging && event.pointerType !== 'touch') setHover(timeAt(event)); },
        onPointerLeave: () => setHover(null) })));
}
