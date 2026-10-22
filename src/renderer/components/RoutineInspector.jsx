import { deletionInput } from './DeletionNotice';
import * as React from "react";
import { CommandBranches } from "./CommandBranches";
import "../styles/command-branches.css";
import { AUTO } from "../lib/routineModel";
import { UnitPrefs } from "../lib/unitPreferences";
import { CommandParameterEditor, commandArguments, parameterValueError, safeControlId } from "./ContextInspector";
import { UI } from "./ui";
import { robotValueSchemasEqual } from "../../shared/robotValueSchema";
import { Glyph, continuityText, describeStop, stepTitle } from "./RoutinePanel";

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
  if (!node) return null;
  // Command and output problems are explained once, beside their recovery control (picker or branch editor).
  const OWNED = node.type === 'function' ? ['command-unavailable', 'output-unavailable', 'output-schema-changed'] : node.type === 'repeat' ? ['stop-schema-changed'] : [];
  const issues = (props.issues || []).filter((issue) => issue.nodeId === node.id && !OWNED.includes(issue.code));
  const set = (patch) => acq.set(node.id, patch);
  const seg = (run?.segs || []).find((s) => s.nodeId === node.id);
  const remove = (label) => h('button', { className: 'delbtn', type: 'button', ...deletionInput(() => acq.del(node.id)) }, h(Icon, { name: 'trash', size: 15 }), label);
  const deployment = A.nodeDeploymentState(node, catalog);
  // The local-only boundary and preview assumptions are stated once, in the workspace header, not per step.
  let glyph = 'info', title = 'Step', tone = null, body = null, tag = null;
  // Steps inside a generated trajectory's fallback are retained as authored and cannot be edited or removed here.
  if (A.locate(routine, node.id)?.readOnly) {
    return h('div', { className: 'ctxinsp inspector-refresh routine-insp' },
      h('div', { className: 'ctxinsp-hd' },
        h('span', { className: 'ctxinsp-ic' }, h(Glyph, { name: 'info', size: 15 })),
        h('span', { className: 'ctxinsp-t', title: stepTitle(node, paths, catalog) }, stepTitle(node, paths, catalog)),
        h('span', { className: 'ctxinsp-tag' }, 'Read-only'),
        h('button', { className: 'ctxinsp-x', type: 'button', title: 'Close', 'aria-label': 'Close step inspector', onClick: () => acq.select(null) }, h(Icon, { name: 'x', size: 14 }))),
      h('div', { className: 'ctxinsp-body', key: node.id }, Hint('Part of a saved runtime-generation fallback. It is kept as saved and cannot be changed here.')));
  }

  if (node.type === 'path') {
    glyph = 'route'; title = 'Path';
    body = h(React.Fragment, null,
      h(Dropdown, { id: 'routine-bound-path', label: 'Path', value: node.ref, icon: 'route',
        items: [...(paths.some((path) => path.id === node.ref) ? [] : [{ value: node.ref, label: 'Unavailable path', meta: 'Choose another path', badge: 'Missing' }]), ...paths.map((path) => ({ value: path.id, label: path.name }))],
        onChange: (value) => set({ ref: value }) }),
      seg && h('div', { className: 'rt-stat' },
        h('div', { className: 'rt-stat-i' }, h('span', { className: 'rt-stat-v' }, fmt(seg.t1 - seg.t0)), h('span', { className: 'rt-stat-k' }, 'Duration')),
        h('div', { className: 'rt-stat-i' }, h('span', { className: 'rt-stat-v' }, UnitPrefs.format(seg.deriv.sample.length, 'm', 2)), h('span', { className: 'rt-stat-k' }, 'Distance')),
        h('div', { className: 'rt-stat-i' }, h('span', { className: 'rt-stat-v' }, '#' + seg.idxLabel), h('span', { className: 'rt-stat-k' }, 'Run order'))),
      paths.some((path) => path.id === node.ref) && h('button', { className: 'rt-openbtn', type: 'button', onClick: () => acq.openInEditor(node.ref) }, h(Icon, { name: 'route', size: 14 }), 'Open in path editor'),
      remove('Remove from routine'));

  } else if (node.type === 'builtin' && node.builtinId === 'bordeaux.wait') {
    glyph = 'pause'; title = 'Wait'; tone = 'wait';
    body = h(React.Fragment, null,
      h(CommandParameterEditor, { key: node.id, id: 'routine-wait-' + safeControlId(node.id), label: 'Wait duration in seconds',
        schema: { kind: 'number' }, parameter: SECONDS, value: node.arguments && node.arguments.durationS,
        onChange: (durationS) => set({ arguments: { durationS } }) }),
      h(EndsSection, { node, routine, catalog, set }),
      remove('Delete wait'));

  } else if (node.type === 'decision') {
    glyph = 'branch'; title = 'Saved condition branch'; tag = 'Legacy';
    body = h(React.Fragment, null,
      Hint('Saved condition: ' + (node.cond || '(unselected)') + '. Its routes are kept. Add a command and select its output for new decisions.'),
      h('div', { className: 'rt-route-names' },
        h('div', null, FieldLabel('When true'), h(DraftText, { className: 'textinput', 'aria-label': 'Name of the true route', value: node.thenLabel, owner: node.id + ':then', spellCheck: false, onCommit: (thenLabel) => thenLabel.trim() && thenLabel.trim() !== node.thenLabel && set({ thenLabel: thenLabel.trim() }) })),
        h('div', null, FieldLabel('When false'), h(DraftText, { className: 'textinput', 'aria-label': 'Name of the false route', value: node.elseLabel, owner: node.id + ':else', spellCheck: false, onCommit: (elseLabel) => elseLabel.trim() && elseLabel.trim() !== node.elseLabel && set({ elseLabel: elseLabel.trim() }) }))),
      // The preview route is chosen on the route lanes in the flow, beside the steps it plays.
      remove('Delete branch'));

  } else if (node.type === 'repeat') {
    glyph = 'repeat'; title = 'Repeat';
    const dynamic = node.times === undefined, previewLimit = node.times ?? 50;
    const passes = Math.min(previewLimit, acq.passes?.[node.id] ?? 1);
    body = h(React.Fragment, null,
      FieldLabel('Repeat mode'),
      h(Seg, { ariaLabel: 'Repeat mode', value: dynamic ? 'dynamic' : 'fixed', options: [{ v: 'fixed', label: 'Fixed count' }, { v: 'dynamic', label: 'Until command output' }],
        onChange: (mode) => set(mode === 'dynamic' ? { times: undefined, until: node.until?.source === 'output' ? node.until
          : { source: 'output', nodeId: node.nodes.findLast(child => child.type === 'function' && child.cat === 'command')?.id || '', output: '', operator: 'eq' } } : { times: 2 }) }),
      !dynamic && h(CommandParameterEditor, { key: node.id + ':times', id: 'routine-repeat-times-' + safeControlId(node.id), label: node.until ? 'Most passes' : 'Passes',
        schema: { kind: 'integer' }, parameter: { min: 1, max: 50 }, value: node.times, onChange: (times) => set({ times }) }),
      h(RepeatStop, { node, catalog, set }),
      node.until && Section('Preview',
        FieldLabel('Passes to preview'),
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

  } else if (node.type === 'end') {
    if (node.scope === 'repeat') {
      glyph = 'exit'; title = 'Exit repeat';
      const repeat = A.locate(routine, A.locate(routine, node.id)?.repeatIds.at(-1))?.node;
      body = h(React.Fragment, null, repeat && Hint('Leaves “' + stepTitle(repeat, paths, catalog) + '”. Later steps in this pass never run.'), remove('Delete exit'));
    } else {
      glyph = 'stop'; title = 'End routine';
      body = h(React.Fragment, null, Hint('Ends the routine here. Later steps never run.'), remove('Delete end'));
    }

  } else if (node.type === 'generatedTrajectory') {
    // A saved definition only: it cannot be added, generated on the desktop, or delivered to a robot runner today.
    glyph = 'route'; title = deployment.label || 'Generated trajectory'; tone = 'bad'; tag = 'Not supported';
    body = h(React.Fragment, null,
      Hint('A saved definition for a path generated while the routine runs. Bordeaux cannot generate or preview it, and no robot runner supports it yet.'),
      Hint('Saved fallback: ' + (node.fallback && node.fallback.type === 'branch' ? 'static steps, kept as saved and not checked (read-only)' : 'safe stop')),
      remove('Remove generated trajectory'));

  } else if (node.type === 'function' && node.cat === 'command') {
    glyph = 'bolt'; title = 'Command'; tone = 'cmd';
    const commands = catalog ? catalog.commands || [] : [];
    const invocationId = node.invocation && node.invocation.commandId || '';
    const selected = commands.find((command) => command.id === invocationId);
    const parameters = selected ? (selected.parameters || []).filter((parameter) => parameter.role === 'argument') : [];
    const saved = node.invocation && node.invocation.arguments || {};
    const branchSteps = A.routeSteps(node.outputBranch?.routes || []);
    const argumentsValue = selected ? Object.fromEntries(parameters.map((parameter) => {
      const value = Object.prototype.hasOwnProperty.call(saved, parameter.name) ? saved[parameter.name] : undefined;
      return [parameter.name, parameterValueError(value, parameter) ? commandArguments(selected)[parameter.name] : value];
    })) : saved;
    body = h(React.Fragment, null,
      catalog
        ? h(ChoiceBrowser, { id: 'routine-command', resetKey: node.id, label: 'Command', value: invocationId,
            items: [{ value: '', label: 'Choose a command', meta: 'No command selected' }, ...commands.map((command) => ({
              value: command.id, label: command.label, meta: (command.parameters || []).filter((parameter) => parameter.role === 'argument').map((parameter) => parameter.label || parameter.name).join(', ') || command.member,
              searchText: command.id + ' ' + command.member,
            }))], placeholder: 'Search commands', emptyText: 'No commands found in this project', icon: 'bolt',
            note: branchSteps ? 'Another command removes ' + plural(branchSteps, 'branch step') + '.' : undefined,
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
              onChange: (value) => set({ invocation: { commandId: selected.id, arguments: { ...argumentsValue, [parameter.name]: value } } }),
            }))),
      h(EndsSection, { node, routine, catalog, set }),
      (selected || node.outputBranch) && h(CommandBranches, { node, command: selected, acq }),
      remove('Delete command'));

  } else {
    // Retained legacy or unknown data: shown and removable, never reinterpreted as new control flow.
    title = deployment.legacy ? (deployment.label || 'Legacy step') : 'Unsupported step'; tone = 'bad'; tag = 'Legacy — cannot deploy';
    body = h(React.Fragment, null,
      Hint('Saved by an earlier Bordeaux format. ' + (node.cat === 'generate' && node.preview
        ? 'The preview plays the path saved with it; nothing is generated. It has no robot contract.'
        : 'The preview ignores it and it has no robot contract.') + ' Its data is kept as saved until you remove it.'),
      remove('Remove unsupported step'));
  }

  return h('div', { className: 'ctxinsp inspector-refresh routine-insp' },
    h('div', { className: 'ctxinsp-hd' },
      h('span', { className: 'ctxinsp-ic' + (tone ? ' ' + tone : '') }, h(Glyph, { name: glyph, size: 15 })),
      h('span', { className: 'ctxinsp-t', title }, title),
      tag && h('span', { className: 'ctxinsp-tag' }, tag),
      h('button', { className: 'ctxinsp-x', type: 'button', title: 'Close', 'aria-label': 'Close step inspector', onClick: () => acq.select(null) }, h(Icon, { name: 'x', size: 14 }))),
    // Keyed by step so an unfinished draft never moves to another step.
    h('div', { className: 'ctxinsp-body', key: node.id },
      h(Problems, { issues, jumps: (run?.issues || []).filter((issue) => issue.code === 'reference-discontinuity' && issue.nodeId === node.id) }),
      body));
}

/** Preview transport. Time is the chosen trace's display time: limits draw as upper bounds, untimed commands as markers. */
export function RoutineTransport(props) {
  const { run, time, playing, controls, running } = props;
  const occurrences = run.steps.filter((step) => step.kind !== 'repeat');
  const activeIdx = run.steps.length && (running || time > 0) ? A.stepAt(run, time) : -1;
  const active = activeIdx >= 0 ? run.steps[activeIdx] : null;
  const ordinal = active ? run.steps.slice(0, activeIdx + 1).filter((step) => step.kind !== 'repeat').length : 0;
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
  const color = (step) => step.kind === 'path' || step.kind === 'gen' ? 'var(--accent)' : step.kind === 'wait' ? 'var(--warn)' : step.kind === 'event' ? 'var(--cmd)' : 'var(--txt-3)';
  const at = (t) => `calc(10px + (100% - 20px) * ${run.total ? t / run.total : 0})`;
  const width = (d) => `calc((100% - 20px) * ${run.total ? d / run.total : 0})`;
  const marks = run.steps.filter((step) => step.t1 <= step.t0 && (step.kind === 'decision' || step.kind === 'end' || step.kind === 'event' || (step.kind === 'repeat' && step.pass > 1)));
  const markClass = (step) => step.kind === 'decision' ? 'rt-timeline-event' : step.kind === 'end' ? 'rt-timeline-end' : step.kind === 'repeat' ? 'rt-timeline-pass' : 'rt-timeline-untimed';
  // Pass numbers only where there is room for them; every tick keeps its descriptive title.
  const editorRef = React.useRef(null);
  const [editorWidth, setEditorWidth] = React.useState(0);
  React.useLayoutEffect(() => {
    const element = editorRef.current; if (!element) return undefined;
    setEditorWidth(element.clientWidth);
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(() => setEditorWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const labelledPasses = new Set();
  if (editorWidth && run.total > 0) {
    let lastX = -Infinity;
    marks.filter((step) => step.kind === 'repeat').forEach((step) => {
      const x = 10 + (editorWidth - 20) * (step.t0 / run.total);
      if (x - lastX >= 16) { labelledPasses.add(step.occurrenceId); lastX = x; }
    });
  }
  const markLabel = (step) => step.kind === 'repeat' ? A.nodeTitle(step.node) + ', pass ' + step.pass : step.kind === 'event' ? A.nodeTitle(step.node) + ' (untimed)' : step.label || A.nodeTitle(step.node);

  return h('div', { className: 'rt-transport timeline' + (running ? ' running' : '') },
    h('div', { className: 'rt-timeline-toolbar' },
      h('div', { className: 'rt-tp-ctl' },
        h('button', { className: 'rt-tp-btn', type: 'button', title: 'Restart preview', 'aria-label': 'Restart routine', onClick: controls.reset }, h(Icon, { name: 'rewind', size: 14 })),
        h('button', { className: 'rt-tp-btn play', type: 'button', disabled: !timedPlayable, title: timedPlayable ? 'Play / pause preview' : 'Nothing in this preview has a duration', 'aria-label': playing ? 'Pause routine playback' : 'Play routine', onClick: controls.toggle }, h(Icon, { name: playing ? 'pause' : 'play', size: 15, fill: !playing }))),
      h('span', { className: 'rt-timeline-time' }, time.toFixed(2), h('small', null, ' / ' + totalLabel)),
      h('span', { className: 'rt-timeline-summary', title: summary || undefined }, summary),
      pass && passes && h('span', { className: 'rt-timeline-pass-now' }, 'Pass ' + pass.pass + ' of ' + passes),
      h('div', { className: 'rt-timeline-step' }, activeIdx >= 0 ? String(ordinal).padStart(2, '0') : '–', h('small', null, '/' + String(occurrences.length).padStart(2, '0')))),
    h('div', { className: 'rt-timeline-editor', ref: editorRef, style: { '--routine-progress': pct } },
      h('span', { className: 'rt-timeline-track' }),
      run.steps.filter((step) => step.t1 > step.t0).map((step) => h('span', { key: step.occurrenceId || step.node.id, className: 'rt-timeline-span' + (step.timing === 'upperBound' ? ' upper' : ''),
        title: (step.timing === 'upperBound' ? 'Up to ' : '') + (step.label || A.nodeTitle(step.node)), style: { left: at(step.t0), width: width(step.t1 - step.t0), '--step-color': color(step) } })),
      marks.map((step) => h('span', { key: 'm' + (step.occurrenceId || step.node.id), className: markClass(step), title: markLabel(step), style: { left: at(step.t0) } }, step.kind === 'repeat' && labelledPasses.has(step.occurrenceId) ? step.pass : null)),
      h('input', { className: 'rt-tp-scrub', type: 'range', 'aria-label': 'Routine playback position', min: 0, max: 1000, value: Math.round(pct * 1000), disabled: !timedPlayable, onChange: (event) => controls.seek((event.target.value / 1000) * run.total) })));
}
