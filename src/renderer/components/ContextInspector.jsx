import { PathLinks } from "../lib/pathLinks";
import { SharedWaypointPosition } from "./SharedWaypointPosition";
import * as React from "react";
import { PM } from "../lib/pathMath";
import { UnitPrefs, formatAngularLimit } from "../lib/unitPreferences";
import { FIELD_DIMS } from "./FieldView";
import { UI } from "./ui";
import { compareExactDecimals, robotParameterValueError, robotSchemaValueError } from "../../shared/robotCommands";

  const h = React.createElement;
  const { Num, DraftText, Toggle, Seg, Icon, Dropdown, ChoiceBrowser, constraintRangeSummary } = UI;
  const { FIELD_W, FIELD_H } = FIELD_DIMS;

  // Anchor meaning lives in each option's tooltip instead of a hint under every anchor control.
  const ANCHOR_OPTIONS = [
    { v: 'param', label: 'Path %', title: 'Moves proportionally when the path changes' },
    { v: 'dist', label: 'Distance', title: 'Keeps its distance from the start when the path changes' },
  ];
  const HEAD_MODES = [{ v: 'manual', label: 'Manual' }, { v: 'tangent', label: 'Tangent' }, { v: 'targets', label: 'Targets' }];

  const handleLen = (w, key) => Math.hypot(w[key].x - w.x, w[key].y - w.y);
  const segNorm = (t) => (t === 'line' || t === 'arc' || t === 'clothoid') ? t : 'bezier';
  const wpName = (i, n) => i === 0 ? 'Start' : i === n - 1 ? 'End' : 'Waypoint ' + i;

  function ConstraintsBody({ c, robot, setC, moreLimits, setMoreLimits }) {
    const rotation = moreLimits ? h('div', { className: 'grid2 compact-fields' },
      h(Num, { label: 'Max \u03c9', value: c.maxAngVel, unit: '\u00b0/s', step: 1, format: formatAngularLimit, onChange: (v) => setC({ maxAngVel: v }) }),
      h(Num, { label: 'Max \u03b1', value: c.maxAngAccel, unit: '\u00b0/s\u00b2', step: 1, format: formatAngularLimit, onChange: (v) => setC({ maxAngAccel: v }) })) : null;
    return h(React.Fragment, null,
      h('div', { className: 'cgroup-h' }, 'Translation'),
      h('div', { className: 'grid2' },
        h(Num, { label: 'Max velocity', value: c.maxVel, unit: 'm/s', min: 0.1, max: robot.maxSpeed, onChange: (v) => setC({ maxVel: v }) }),
        h(Num, { label: 'Max acceleration', value: c.maxAccel, unit: 'm/s\u00b2', min: 0.1, onChange: (v) => setC({ maxAccel: v, maxDecel: v }) })),
      c.maxDecel != null && c.maxDecel !== c.maxAccel && h('div', { className: 'seg-hint' }, 'Saved slowing limit: ' + UnitPrefs.format(c.maxDecel, 'm/s²', 2) + '. Editing acceleration sets both limits.'),
      h(Num, { label: 'Corner acceleration', value: c.maxCentripetalAccel != null ? c.maxCentripetalAccel : c.maxAccel, unit: 'm/s\u00b2', min: 0.1, onChange: (v) => setC({ maxCentripetalAccel: v }) }),
      h('button', { className: 'morebtn' + (moreLimits ? ' on' : ''), type: 'button', 'aria-expanded': moreLimits, onClick: () => setMoreLimits(!moreLimits) }, h('span', null, moreLimits ? 'Fewer limits' : 'Rotation limits'), h(Icon, { name: 'chevron', size: 13 })),
      rotation);
  }

  function RangeLimits({ range, limits, onChange }) {
    const options = [
      ['maxVel', 'Velocity', 'm/s'],
      ['maxAccel', 'Acceleration', 'm/s²'],
      ['maxAngVel', 'Angular velocity', '°/s'],
      ['maxAngAccel', 'Angular acceleration', '°/s²'],
    ];
    const values = { ...range, maxAccel: range.maxAccel ?? range.maxDecel };
    const limitFor = (key) => key === 'maxAccel' ? Math.min(limits.maxAccel, limits.maxDecel ?? limits.maxAccel) : limits[key];
    const change = (key, value) => onChange(key === 'maxAccel' ? { maxAccel: value, maxDecel: value } : { [key]: value });
    const active = options.filter(([key]) => values[key] != null);
    const available = options.filter(([key]) => values[key] == null);
    return h('section', { className: 'range-limits', 'aria-label': 'Zone limits' },
      active.map(([key, label, unit]) => h('div', { key, className: 'range-limit' },
        h(Num, { label, value: values[key], unit, min: 0.01, max: Math.max(limitFor(key), values[key]),
          step: key.startsWith('maxAng') ? 1 : 0.01, precision: 2, format: key.startsWith('maxAng') ? formatAngularLimit : undefined,
          onChange: (value) => change(key, value) }),
        h('button', { type: 'button', className: 'iconbtn', 'aria-label': 'Remove ' + label.toLowerCase() + ' limit',
          title: 'Remove ' + label.toLowerCase() + ' limit', onClick: () => change(key, undefined) }, h(Icon, { name: 'x', size: 14 })))),
      available.length > 0 && h(Dropdown, { id: 'range-add-limit', ariaLabel: 'Add limit', placeholder: 'Add limit',
        value: '', icon: 'plus', compact: true, items: available.map(([value, label]) => ({ value, label })),
        onChange: (key) => change(key, limitFor(key)) }),
      values.maxAccel != null && range.maxDecel !== range.maxAccel && h('div', { className: 'seg-hint' }, 'Saved limits differ for speeding up and slowing down. Editing acceleration sets both.'),
      active.length === 0 && h('div', { className: 'seg-hint' }, 'Uses path limits.'));
  }

  function Stat3(items) {
    return h('div', { className: 'rt-stat' }, items.map((it, i) =>
      h('div', { key: i, className: 'rt-stat-i' }, h('span', { className: 'rt-stat-v', style: it.color ? { color: it.color } : null }, it.v), h('span', { className: 'rt-stat-k' }, it.k))));
  }

  function defaultSchemaValue(schema, depth) {
    const level = depth || 0;
    if (!schema || level > 16) return null;
    if (schema.kind === 'boolean') return false;
    if (schema.kind === 'integer' || schema.kind === 'number') return 0;
    if (schema.kind === 'integerString') return '0';
    if (schema.kind === 'decimalString') return '0';
    if (schema.kind === 'string') return '';
    if (schema.kind === 'enum') return (schema.enumValues || [])[0] || '';
    if (schema.kind === 'array') return [];
    if (schema.kind === 'map' || schema.kind === 'opaque') return {};
    if (schema.kind === 'optional') return null;
    if (schema.kind === 'object') return Object.fromEntries((schema.fields || []).map((field) => [field.name, defaultSchemaValue(field.schema, level + 1)]));
    return null;
  }

  function commandArguments(command) {
    return Object.fromEntries((command.parameters || []).filter((parameter) => parameter.role === 'argument').map((parameter) => [parameter.name, parameterDefaultValue(parameter)]));
  }

  function parameterDefaultValue(parameter) {
    return Object.prototype.hasOwnProperty.call(parameter, 'defaultValue') ? parameter.defaultValue : defaultSchemaValue(parameter.schema, 0);
  }

  function safeControlId(value) {
    return String(value).replace(/[^A-Za-z0-9_-]+/g, '-');
  }

  function simpleRobotName(value) {
    return String(value || '').split('.').pop() || String(value || '');
  }

  function robotIntegerRange(valueType) {
    return { I8: [-128, 127], U8: [0, 255], I16: [-32768, 32767], U16: [0, 65535], I32: [-2147483648, 2147483647], U32: [0, 4294967295] }[valueType] || null;
  }

  // Shared validation accepts any finite number; the SGL encoder also needs it to fit float32.
  function sglOverflowPath(value, schema, location) {
    if (value == null) return null;
    if (schema.kind === 'number') return schema.valueType === 'SGL' && !Number.isFinite(Math.fround(value)) ? location : null;
    if (schema.kind === 'optional') return sglOverflowPath(value, schema.element, location);
    if (schema.kind === 'array') return value.map((item, index) => sglOverflowPath(item, schema.element, location + '[' + index + ']')).find(Boolean) || null;
    if (schema.kind === 'map') return Object.entries(value).map(([key, item]) => sglOverflowPath(item, schema.value, location + '.' + key)).find(Boolean) || null;
    if (schema.kind === 'object') return (schema.fields || []).map((field) => sglOverflowPath(value[field.name], field.schema, location + '.' + field.name)).find(Boolean) || null;
    return null;
  }

  function schemaValueError(value, schema, location) {
    const error = robotSchemaValueError(value, schema, location);
    if (error) return error + '.';
    const overflow = sglOverflowPath(value, schema, location);
    return overflow ? overflow + ' must fit the SGL range.' : '';
  }

  function parameterValueError(value, parameter) {
    const schemaError = schemaValueError(value, parameter.schema, parameter.label || parameter.name);
    if (schemaError) return schemaError;
    const limitError = robotParameterValueError(value, parameter);
    return limitError ? limitError + '.' : '';
  }

  function parameterMetadata(parameter, valueType) {
    if (!parameter) return valueType;
    return [valueType, parameter.unit, parameter.description].filter(Boolean).join(' / ');
  }

  function NumberValueEditor({ id, label, value, integer, valueType, parameter, onChange }) {
    const formatted = Number.isFinite(value) ? String(value) : '';
    const [draft, setDraft] = React.useState(formatted);
    const [error, setError] = React.useState('');
    React.useEffect(() => { setDraft(formatted); setError(''); }, [formatted, id]);
    const validate = (next, commit) => {
      const parsed = Number(next);
      const range = integer ? robotIntegerRange(valueType) : null;
      const message = next.trim() === '' || !Number.isFinite(parsed)
        ? 'Enter a finite number.'
        : valueType === 'SGL' && !Number.isFinite(Math.fround(parsed))
          ? 'Enter a value within the SGL range.'
        : integer && !Number.isSafeInteger(parsed)
          ? 'Enter a whole number.'
          : range && (parsed < range[0] || parsed > range[1])
            ? 'Enter a value from ' + range[0] + ' to ' + range[1] + '.'
          : parameter && parameter.min != null && parsed < parameter.min
            ? 'Enter a value of at least ' + parameter.min + '.'
          : parameter && parameter.max != null && parsed > parameter.max
            ? 'Enter a value of at most ' + parameter.max + '.'
          : '';
      setError(message);
      if (!message && commit) onChange(parsed);
      return !message;
    };
    return h('div', { className: 'cmd-param' },
      h('label', { className: 'fieldlabel', htmlFor: id }, label),
      h('input', {
        id,
        className: 'textinput cmd-param-input',
        type: 'number',
        inputMode: integer ? 'numeric' : 'decimal',
        step: integer ? 1 : 'any',
        min: parameter && parameter.min != null ? parameter.min : undefined,
        max: parameter && parameter.max != null ? parameter.max : undefined,
        value: draft,
        'data-project-draft': true,
        'aria-invalid': !!error,
        'aria-describedby': error ? id + '-error' : id + '-type',
        onChange: (event) => { setDraft(event.target.value); if (error) validate(event.target.value, false); },
        onBlur: (event) => validate(event.currentTarget.value, true),
        onKeyDown: (event) => {
          if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); if (validate(event.currentTarget.value, false)) event.currentTarget.blur(); }
          else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDraft(formatted); setError(''); requestAnimationFrame(() => { if (document.activeElement === event.target) event.target.select(); }); }
        },
      }),
      h('span', { id: id + '-type', className: 'cmd-param-type' }, parameterMetadata(parameter, valueType)),
      error && h('span', { id: id + '-error', className: 'cmd-param-error', role: 'alert' }, error));
  }

  function IntegerStringValueEditor({ id, label, value, valueType, parameter, onChange }) {
    const formatted = typeof value === 'string' ? value : '';
    const [draft, setDraft] = React.useState(formatted);
    const [error, setError] = React.useState('');
    React.useEffect(() => { setDraft(formatted); setError(''); }, [formatted, id]);
    const validate = (next, commit) => {
      let message = schemaValueError(next.trim(), { kind: 'integerString', valueType }, 'Value');
      if (!message && parameter && parameter.min != null && BigInt(next.trim()) < BigInt(parameter.min)) message = 'Enter a value of at least ' + parameter.min + '.';
      if (!message && parameter && parameter.max != null && BigInt(next.trim()) > BigInt(parameter.max)) message = 'Enter a value of at most ' + parameter.max + '.';
      setError(message);
      if (!message && commit) onChange(next.trim());
      return !message;
    };
    return h('div', { className: 'cmd-param' },
      h('label', { className: 'fieldlabel', htmlFor: id }, label),
      h('input', {
        id,
        className: 'textinput cmd-param-input',
        type: 'text',
        inputMode: 'numeric',
        pattern: '[+\\-]?[0-9]+',
        value: draft,
        'data-project-draft': true,
        autoComplete: 'off',
        spellCheck: false,
        'data-lpignore': 'true',
        'data-1p-ignore': true,
        'aria-invalid': !!error,
        'aria-describedby': error ? id + '-error' : id + '-type',
        onChange: (event) => { setDraft(event.target.value); if (error) validate(event.target.value, false); },
        onBlur: (event) => validate(event.currentTarget.value, true),
        onKeyDown: (event) => {
          if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); if (validate(event.currentTarget.value, false)) event.currentTarget.blur(); }
          else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDraft(formatted); setError(''); requestAnimationFrame(() => { if (document.activeElement === event.target) event.target.select(); }); }
        },
      }),
      h('span', { id: id + '-type', className: 'cmd-param-type' }, parameterMetadata(parameter, valueType + ', exact integer')),
      error && h('span', { id: id + '-error', className: 'cmd-param-error', role: 'alert' }, error));
  }

  function DecimalStringValueEditor({ id, label, value, valueType, parameter, onChange }) {
    const formatted = typeof value === 'string' ? value : '';
    const [draft, setDraft] = React.useState(formatted);
    const [error, setError] = React.useState('');
    React.useEffect(() => { setDraft(formatted); setError(''); }, [formatted, id]);
    const validate = (next, commit) => {
      const value = next.trim();
      let message = schemaValueError(value, { kind: 'decimalString', valueType }, 'Value');
      if (!message && parameter && parameter.min != null && compareExactDecimals(value, String(parameter.min)) < 0) message = 'Enter a value of at least ' + parameter.min + '.';
      if (!message && parameter && parameter.max != null && compareExactDecimals(value, String(parameter.max)) > 0) message = 'Enter a value of at most ' + parameter.max + '.';
      setError(message);
      if (!message && commit) onChange(value);
      return !message;
    };
    return h('div', { className: 'cmd-param' },
      h('label', { className: 'fieldlabel', htmlFor: id }, label),
      h('input', {
        id,
        className: 'textinput cmd-param-input',
        type: 'text',
        inputMode: 'decimal',
        value: draft,
        'data-project-draft': true,
        autoComplete: 'off',
        spellCheck: false,
        'data-lpignore': 'true',
        'data-1p-ignore': true,
        'aria-invalid': !!error,
        'aria-describedby': error ? id + '-error' : id + '-type',
        onChange: (event) => { setDraft(event.target.value); if (error) validate(event.target.value, false); },
        onBlur: (event) => validate(event.currentTarget.value, true),
        onKeyDown: (event) => {
          if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); if (validate(event.currentTarget.value, false)) event.currentTarget.blur(); }
          else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDraft(formatted); setError(''); requestAnimationFrame(() => { if (document.activeElement === event.target) event.target.select(); }); }
        },
      }),
      h('span', { id: id + '-type', className: 'cmd-param-type' }, parameterMetadata(parameter, valueType + ', exact decimal')),
      error && h('span', { id: id + '-error', className: 'cmd-param-error', role: 'alert' }, error));
  }

  function JsonValueEditor({ id, label, value, schema, onChange }) {
    const valueType = schema && schema.valueType ? schema.valueType : 'unknown';
    const formatted = JSON.stringify(value == null ? {} : value, null, 2);
    const [draft, setDraft] = React.useState(formatted);
    const [error, setError] = React.useState('');
    React.useEffect(() => { setDraft(formatted); setError(''); }, [formatted, id]);
    const validate = (next, commit) => {
      try {
        const parsed = JSON.parse(next);
        const schemaError = schemaValueError(parsed, schema, 'Value');
        if (schemaError) {
          setError(schemaError);
          return false;
        }
        setError('');
        if (commit) onChange(parsed);
        return true;
      } catch (reason) {
        setError(reason && reason.message ? reason.message : 'Enter valid JSON.');
        return false;
      }
    };
    return h('div', { className: 'cmd-param' },
      h('label', { className: 'fieldlabel', htmlFor: id }, label),
      h('textarea', {
        id,
        className: 'textinput cmd-json-input',
        value: draft,
        'data-project-draft': true,
        rows: 4,
        spellCheck: false,
        autoComplete: 'off',
        'data-lpignore': 'true',
        'data-1p-ignore': true,
        'aria-invalid': !!error,
        'aria-describedby': error ? id + '-error' : id + '-type',
        onChange: (event) => { setDraft(event.target.value); if (error) validate(event.target.value, false); },
        onBlur: (event) => validate(event.currentTarget.value, true),
        onKeyDown: (event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); validate(event.currentTarget.value, true); }
          else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDraft(formatted); setError(''); }
        },
      }),
      h('span', { id: id + '-type', className: 'cmd-param-type' }, valueType + ', JSON' + (schema && schema.kind === 'opaque' ? '. Custom values use JSON' : '')),
      error && h('span', { id: id + '-error', className: 'cmd-param-error', role: 'alert' }, error));
  }

  function CommandParameterEditor({ id, label, schema, parameter, value, onChange, depth }) {
    const level = depth || 0;
    const current = value === undefined ? (parameter ? parameterDefaultValue(parameter) : defaultSchemaValue(schema, level)) : value;
    if (!schema || level > 16) return h(JsonValueEditor, { id, label, value: current, schema: schema || { kind: 'opaque', valueType: 'unknown' }, onChange });
    if (schema.kind === 'boolean') {
      return h('label', { className: 'cmd-check-row', htmlFor: id },
        h('span', null, h('strong', null, label), h('small', null, parameterMetadata(parameter, schema.valueType))),
        h('input', { id, type: 'checkbox', checked: !!current, onChange: (event) => onChange(event.target.checked) }));
    }
    if (schema.kind === 'integer' || schema.kind === 'number') {
      return h(NumberValueEditor, { id, label, value: current, integer: schema.kind === 'integer', valueType: schema.valueType, parameter, onChange });
    }
    if (schema.kind === 'integerString') {
      return h(IntegerStringValueEditor, { id, label, value: current, valueType: schema.valueType, parameter, onChange });
    }
    if (schema.kind === 'decimalString') {
      return h(DecimalStringValueEditor, { id, label, value: current, valueType: schema.valueType, parameter, onChange });
    }
    if (schema.kind === 'string') {
      return h('div', { className: 'cmd-param' },
        h('label', { className: 'fieldlabel', htmlFor: id }, label),
        h('input', { id, className: 'textinput cmd-param-input', type: 'text', value: typeof current === 'string' ? current : '', spellCheck: false, autoComplete: 'off', 'data-lpignore': 'true', 'data-1p-ignore': true, onChange: (event) => onChange(event.target.value) }),
        h('span', { className: 'cmd-param-type' }, parameterMetadata(parameter, schema.valueType)));
    }
    if (schema.kind === 'enum') {
      const options = schema.enumValues || [];
      if (options.length > 0 && options.length <= 3 && options.every((option) => option.length <= 12)) {
        return h('fieldset', { className: 'cmd-choice-group', title: schema.valueType },
          h('legend', { className: 'fieldlabel' }, label),
          h('div', { className: 'cmd-choice-grid', style: { '--choice-count': options.length } },
            options.map((option) => h('label', { className: 'cmd-choice', key: option },
              h('input', { type: 'radio', name: id, value: option, checked: current === option, onChange: () => onChange(option) }),
              h('span', { title: option }, option)))));
      }
      return h(Dropdown, {
        id,
        label,
        value: current == null ? '' : current,
        items: options.map((option) => ({ value: option, label: option })),
        placeholder: 'Choose ' + label.toLowerCase(),
        searchThreshold: 7,
        onChange,
      });
    }
    if (schema.kind === 'optional') {
      const enabled = current !== null && current !== undefined;
      return h('fieldset', { className: 'cmd-param-group' },
        h('legend', null, label),
        h('label', { className: 'cmd-check-row', htmlFor: id + '-enabled' },
          h('span', null, h('strong', null, 'Set value'), h('small', null, schema.valueType)),
          h('input', { id: id + '-enabled', type: 'checkbox', checked: enabled, onChange: (event) => onChange(event.target.checked ? defaultSchemaValue(schema.element, level + 1) : null) })),
        enabled && h(CommandParameterEditor, { id: id + '-value', label: 'Value', schema: schema.element, value: current, onChange, depth: level + 1 }));
    }
    if (schema.kind === 'object') {
      const objectValue = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
      return h('fieldset', { className: 'cmd-param-group' },
        h('legend', null, label),
        h('div', { className: 'cmd-param-type' }, schema.valueType),
        (schema.fields || []).map((field) => h(CommandParameterEditor, {
          key: field.name,
          id: id + '-' + safeControlId(field.name),
          label: field.name,
          schema: field.schema,
          value: objectValue[field.name],
          onChange: (next) => onChange({ ...objectValue, [field.name]: next }),
          depth: level + 1,
        })));
    }
    return h(JsonValueEditor, { id, label, value: current, schema, onChange });
  }

  const JIGGLE_DEFAULTS = { distanceM: 0.03, strokes: 8, startDeg: 45, stepDeg: -45, strokeTimeS: 0.08 };

  function ContextInspector(props) {
    const { doc, sel, derived, actions, drive, robot, robotProject, onClose } = props;
    const [moreLimits, setMoreLimits] = React.useState(false);
    const [jiggleDistance, setJiggleDistance] = React.useState(JIGGLE_DEFAULTS.distanceM);
    const [jiggleStrokes, setJiggleStrokes] = React.useState(JIGGLE_DEFAULTS.strokes);
    const [jiggleStart, setJiggleStart] = React.useState(JIGGLE_DEFAULTS.startDeg);
    const [jiggleStep, setJiggleStep] = React.useState(JIGGLE_DEFAULTS.stepDeg);
    const [jiggleStrokeTime, setJiggleStrokeTime] = React.useState(JIGGLE_DEFAULTS.strokeTimeS);
    const [jiggleError, setJiggleError] = React.useState(false);
    const wps = doc.waypoints;
    const waypointLabel = (index) => PathLinks.waypointName(props.project, doc, index);
    const pathLimits = PM.effectiveConstraints(doc.constraints, robot);
    const isTank = drive === 'tank';
    const n = wps.length;
    const headingMode = isTank ? 'tangent' : (doc.headingMode || 'targets');
    const endpointJiggle = wps[n - 1] && wps[n - 1].jiggle;
    const firstHeadingMode = isTank ? 'tangent' : (wps[0]?.segmentHeadingMode || headingMode);
    const facingOffset = doc.driveBackward ? 180 : 0;
    const endpointSpeed = (index) => {
      const start = index === 0, waypoint = wps[index], stopped = !!waypoint?.stop;
      const label = start ? 'Entry speed' : 'Exit speed';
      return h('div', { className: 'endpoint-speed' },
        h('fieldset', { disabled: stopped, className: 'plain-fieldset' },
          h(Num, { label, value: stopped ? 0 : (start ? doc.startVel : doc.goalVel) || 0, unit: 'm/s', min: 0, max: pathLimits.maxVel,
            onChange: (value) => { if (!stopped) actions.setDoc(start ? { startVel: value } : { goalVel: value }); } })),
        stopped && h('button', { type: 'button', className: 'morebtn', onClick: () => actions.select('wp', index) },
          start ? 'Stopped at entry' : 'Stopped at exit'));
    };
    const initialFacing = () => {
      if (!n) return h('div', { className: 'hint' }, 'Place a waypoint to set initial facing.');
      const followsLaw = firstHeadingMode === 'tangent' || firstHeadingMode === 'lookAt';
      const plannedFacing = derived.metrics?.head?.[0];
      const tangent = derived.sample?.pts?.[0]?.heading;
      const degrees = followsLaw && Number.isFinite(plannedFacing) ? plannedFacing * 180 / Math.PI
        : followsLaw && Number.isFinite(tangent) ? tangent * 180 / Math.PI : wps[0]?.theta || 0;
      return h(React.Fragment, null,
        h(Num, { label: 'Initial robot facing', value: degrees + facingOffset, unit: '\u00b0', step: 1, precision: 1,
          onChange: (value) => actions.setWp(0, { theta: value - facingOffset, thetaOn: true }) }),
      );
    };

    React.useEffect(() => {
      setJiggleDistance(endpointJiggle?.distanceM ?? JIGGLE_DEFAULTS.distanceM);
      setJiggleStrokes(endpointJiggle?.strokes ?? JIGGLE_DEFAULTS.strokes);
      setJiggleStart(endpointJiggle?.startDeg ?? JIGGLE_DEFAULTS.startDeg);
      setJiggleStep(endpointJiggle?.stepDeg ?? JIGGLE_DEFAULTS.stepDeg);
      setJiggleStrokeTime(endpointJiggle?.strokeTimeS ?? JIGGLE_DEFAULTS.strokeTimeS);
      setJiggleError(false);
    }, [doc.id, endpointJiggle?.distanceM, endpointJiggle?.strokes, endpointJiggle?.startDeg, endpointJiggle?.stepDeg, endpointJiggle?.strokeTimeS]);

    let icon = 'route', title = '', tag = null, body = null, headerAction = null;

    if (props.repairMode) {
      // These controls use authored values only. Failed or stale trajectories must
      // not supply anchor conversions, timing, or playback-dependent edits.
      const waypoint = sel.kind === 'wp' && wps[sel.idx];
      const range = sel.kind === 'cr' && doc.ranges?.[sel.idx];
      const target = sel.kind === 'rt' && doc.targets?.[sel.idx];
      const marker = sel.kind === 'em' && doc.markers?.[sel.idx];
      icon = range ? 'gauge' : waypoint ? 'waypoint' : target ? 'rotation' : marker ? 'flag2' : 'route';
      title = range ? range.name || 'Zone' : waypoint ? waypointLabel(sel.idx)
        : target ? 'Rotation target' : marker ? marker.name || 'Command' : doc.name || 'Path';
      const remove = range ? () => actions.delRange(sel.idx) : target ? () => actions.delTarget(sel.idx)
        : marker ? () => actions.delMarker(sel.idx) : waypoint && n > 2 ? () => actions.delWp(sel.idx) : null;
      const removeLabel = range ? 'Delete zone' : target ? 'Delete rotation target' : marker ? 'Delete command' : 'Delete waypoint';
      body = h(React.Fragment, null,
        h('p', { className: 'rt-callout error', role: 'status' }, 'Planning failed. Edit the saved values or remove a feature below to try again. Select other features on the field or timeline.'),
        waypoint && h('div', { className: 'grid2' },
          h(Num, { label: 'X', value: waypoint.x, unit: 'm', onChange: (x) => actions.setWp(sel.idx, { x }) }),
          h(Num, { label: 'Y', value: waypoint.y, unit: 'm', onChange: (y) => actions.setWp(sel.idx, { y }) })),
        target && h(Num, { label: 'Heading', value: target.deg, unit: '°', onChange: (deg) => actions.setTarget(sel.idx, { deg }) }),
        range && h(RangeLimits, { range, limits: pathLimits, onChange: (patch) => actions.setRange(sel.idx, patch) }),
        !waypoint && !range && !target && !marker && h(ConstraintsBody, {
          c: pathLimits, robot, setC: actions.setConstraint, moreLimits, setMoreLimits,
        }),
        remove && h('button', { className: 'delbtn', type: 'button', onClick: remove }, h(Icon, { name: 'trash', size: 15 }), removeLabel));
    }
    else if (!sel.kind) {
      icon = 'route'; title = doc.name || 'Path';
      // Path-level actions live in the header; waypoint placement belongs to the tool rail.
      headerAction = h('button', { className: 'ctxinsp-act', type: 'button', disabled: n < 2 || !actions.canReversePath, 'aria-label': 'Swap start/end',
        title: n < 2 ? 'Place two waypoints to swap start and end' : actions.canReversePath ? 'Swap start/end' : 'Waiting for the current path preview', onClick: () => actions.reversePath() }, h(Icon, { name: 'shuffle', size: 14 }));
      body = h(React.Fragment, null,
        h('div', { className: 'cgroup-h' }, 'Facing'),
        isTank
          ? h('div', { className: 'hint' }, h(Icon, { name: 'info', size: 14 }), 'Tangent only.')
          : h(React.Fragment, null,
              h(Seg, { value: headingMode, options: HEAD_MODES, ariaLabel: 'Default heading', onChange: (v) => actions.setHeadingMode(v) }),
              initialFacing(),
              h('div', { className: 'inrow' },
                h('span', { className: 'inrow-l' }, 'Drive backward'),
                h(Toggle, { on: !!doc.driveBackward, ariaLabel: 'Drive backward', onChange: () => actions.toggleDriveBackward() }))),

        h('div', { className: 'cgroup-h' }, 'Timing'),
        h(Seg, { value: doc.followMode || 'time', ariaLabel: 'Default path follow mode', options: [
          { v: 'time', label: 'Time', title: 'Advance from the robot clock' },
          { v: 'position', label: 'Position', title: 'Advance from measured field position' },
        ], onChange: (v) => actions.setDoc({ followMode: v }) }),

        h('div', { className: 'cgroup-h' }, 'Endpoints'),
        h('div', { className: 'grid2' },
          endpointSpeed(0), endpointSpeed(n - 1)),
        h(ConstraintsBody, {
          c: pathLimits,
          robot,
          setC: actions.setConstraint,
          moreLimits,
          setMoreLimits,
        }));
    }

    else if (sel.kind === 'wp' && wps[sel.idx]) {
      const i = sel.idx, w = wps[i];
      const isStart = i === 0, isEnd = i === n - 1, isAnchor = isStart || isEnd;
      const headingSegment = Math.max(0, Math.min(n - 2, i));
      const waypointHeadingMode = isTank ? 'tangent' : (wps[headingSegment].segmentHeadingMode || headingMode);
      const incomingHeadingMode = i > 0 ? (wps[i - 1].segmentHeadingMode || headingMode) : waypointHeadingMode;
      const mixedHeadingLaw = !isAnchor && incomingHeadingMode !== waypointHeadingMode;
      const continuityOwnedHeading = mixedHeadingLaw && (waypointHeadingMode === 'manual' || waypointHeadingMode === 'targets')
        && (incomingHeadingMode === 'tangent' || incomingHeadingMode === 'lookAt');
      const incomingAuthoredHeading = mixedHeadingLaw && (incomingHeadingMode === 'manual' || incomingHeadingMode === 'targets');
      const interiorHeadingEditor = (headingHint) => h(React.Fragment, null,
        headingHint,
        h('div', { className: 'inrow first' },
          h('span', { className: 'inrow-l' }, 'Pin heading here', h('small', null, 'Otherwise it interpolates')),
          h(Toggle, { on: !!w.thetaOn, ariaLabel: 'Pin heading at waypoint', onChange: (v) => actions.toggleTheta(i, v) })),
        w.thetaOn && h(Num, { label: 'Heading \u03b8', value: w.theta || 0, unit: '\u00b0', step: 1, precision: 1, onChange: (v) => actions.setWp(i, { theta: v }) }));
      icon = 'waypoint'; title = waypointLabel(i);
      body = h(React.Fragment, null,
        h('div', { className: 'grid2' },
          h(Num, { label: 'X', value: w.x, unit: 'm', onChange: (v) => actions.setWp(i, { x: v }) }),
          h(Num, { label: 'Y', value: w.y, unit: 'm', onChange: (v) => actions.setWp(i, { y: v }) })),
        props.project && props.setWaypointPositionLink && h(SharedWaypointPosition, { project: props.project, doc, index: i, onLink: props.setWaypointPositionLink, onName: (at, name) => actions.setWp(at, { positionName: name }) }),

        isTank
          ? h('div', { className: 'hint' }, h(Icon, { name: 'info', size: 14 }), 'Tank \u2014 heading follows the path tangent.')
          : isStart
            ? initialFacing()
          : continuityOwnedHeading
            ? h('div', { className: 'hint' }, h(Icon, { name: 'compass', size: 14 }),
                'The outgoing heading law begins here. The planner turns toward its anchors while the robot keeps moving.')
          : incomingAuthoredHeading
            ? interiorHeadingEditor(h('div', { className: 'hint' }, h(Icon, { name: 'compass', size: 14 }),
                'This heading finishes the incoming ' + incomingHeadingMode + ' law. The outgoing ' + waypointHeadingMode + ' law begins from it continuously.'))
          : waypointHeadingMode === 'lookAt'
            ? h('div', { className: 'hint' }, h(Icon, { name: 'compass', size: 14 }), 'This segment continuously faces its tracked field point. Select the segment to edit or drag it.')
          : waypointHeadingMode === 'tangent'
            ? h(React.Fragment, null,
                h('div', { className: 'hint' }, h(Icon, { name: 'compass', size: 14 }), 'This segment follows the path tangent. Set a manual heading to override only this segment.'),
                h('button', { className: 'qbtn wide', type: 'button', style: { marginTop: '4px' }, onClick: () => { actions.setSegmentHeadingMode(headingSegment, 'manual'); actions.faceWaypoint(i, 'tangent'); } }, h(Icon, { name: 'compass', size: 14 }), 'Set manual heading on segment'))
            : isAnchor
              ? h(React.Fragment, null,
                  h(Num, { label: isStart ? 'Initial robot facing' : 'Final robot facing', value: (w.theta || 0) + facingOffset, unit: '\u00b0', step: 1, precision: 1, onChange: (v) => actions.setWp(i, { theta: v - facingOffset }) }),
                  h('div', { className: 'seg-hint' }, 'Facing does not change the path tangent.'))
              : interiorHeadingEditor(),

        h('div', { className: 'inrow' },
          h('span', { className: 'inrow-l' }, isStart ? 'Stop at entry' : isEnd ? 'Stop at exit' : 'Stop here', h('small', null, isStart ? 'Enter from rest' : 'Decelerate to a full stop')),
          h(Toggle, { on: !!w.stop, ariaLabel: isStart ? 'Stop at entry' : isEnd ? 'Stop at exit' : 'Stop at waypoint', onChange: (v) => actions.setStop(i, v) })),
        w.stop && h(Num, { label: 'Wait at waypoint', value: w.wait || 0, unit: 's', step: 0.1, precision: 1, min: 0, onChange: (v) => actions.setWait(i, v) }),
        !isStart && h('div', { className: 'inrow' },
          h('span', { className: 'inrow-l' }, 'Turn in place', h('small', null, 'Rotate without translating')),
          h(Toggle, { on: !!w.turnInPlace, ariaLabel: 'Turn in place at waypoint', onChange: (v) => actions.setTurnInPlace(i, v) })),
        !isStart && w.turnInPlace && h(React.Fragment, null,
          h(Num, { label: 'Turn to heading', value: w.turnInPlace.headingDeg, unit: '\u00b0', step: 1, precision: 1, onChange: (v) => actions.setTurnInPlaceMeta(i, { headingDeg: v }) }),
          h('div', { className: 'fieldlabel' }, 'Turn direction'),
          h(Seg, { value: w.turnInPlace.direction || 'shortest', ariaLabel: 'Turn direction', options: [{ v: 'shortest', label: 'Shortest' }, { v: 'counterclockwise', label: 'CCW' }, { v: 'clockwise', label: 'CW' }], onChange: (v) => actions.setTurnInPlaceMeta(i, { direction: v }) }),
          h('div', { className: 'seg-hint' }, 'Uses rotation limits.')),
        isAnchor && endpointSpeed(i),
        isAnchor && h('div', { className: 'seg-hint' }, 'Speed along the path; 0 means stopped.'),

        h('div', { className: !isStart && !isEnd ? 'grid2' : '' },
          !isStart && h(Num, { label: 'Incoming tangent', value: handleLen(w, 'prevC'), unit: 'm', min: 0.1, onChange: (v) => actions.setHandleLen(i, 'prevC', v) }),
          !isEnd && h(Num, { label: 'Outgoing tangent', value: handleLen(w, 'nextC'), unit: 'm', min: 0.1, onChange: (v) => actions.setHandleLen(i, 'nextC', v) })),

        isEnd && !isTank && h(React.Fragment, null,
          h('div', { className: 'inrow' },
            h('span', { className: 'inrow-l' }, 'Endpoint jiggle', h('small', null, 'Rapid radial strokes')),
            h(Toggle, { on: !!endpointJiggle, ariaLabel: 'Endpoint jiggle', onChange: (on) => {
              if (!on) { actions.setJiggle(null); setJiggleError(false); return; }
              setJiggleError(!actions.setJiggle({ ...JIGGLE_DEFAULTS }));
            } })),
          endpointJiggle && h(React.Fragment, null,
            h('div', { className: 'grid2 compact-fields' },
              h(Num, { label: 'Distance', value: jiggleDistance, unit: 'm', min: 0.03, max: 1.5, step: 0.01, precision: 2, projectDraft: false, onChange: (v) => { setJiggleDistance(v); setJiggleError(false); } }),
              h(Num, { label: 'Stroke time', value: jiggleStrokeTime, unit: 's', min: 0.08, max: 5, step: 0.05, precision: 2, projectDraft: false, onChange: (v) => { setJiggleStrokeTime(v); setJiggleError(false); } }),
              h(Num, { label: 'Strokes', value: jiggleStrokes, min: 2, max: 12, step: 1, precision: 0, projectDraft: false, onChange: (v) => { setJiggleStrokes(v); setJiggleError(false); } }),
              h(Num, { label: 'First direction', value: jiggleStart, unit: '\u00b0 rel', step: 15, precision: 0, projectDraft: false, onChange: (v) => { setJiggleStart(v); setJiggleError(false); } }),
              h(Num, { label: 'Direction step', value: jiggleStep, unit: '\u00b0', step: 15, precision: 0, projectDraft: false, onChange: (v) => { setJiggleStep(v); setJiggleError(false); } })),
            h('button', { className: 'qbtn wide', type: 'button', onClick: () => setJiggleError(!actions.setJiggle({ distanceM: jiggleDistance, strokes: jiggleStrokes, startDeg: jiggleStart, stepDeg: jiggleStep, strokeTimeS: jiggleStrokeTime })) }, h(Icon, { name: 'route', size: 14 }), 'Update jiggle')),
          endpointJiggle && h('div', { className: 'seg-hint' }, jiggleError ? 'Keep strokes unique and on-field.' : 'Limits may extend the time.')),
        isEnd && isTank && endpointJiggle && h(React.Fragment, null,
          h('div', { className: 'cgroup-h' }, 'Jiggle unavailable'),
          h('div', { className: 'seg-hint' }, 'Arbitrary-direction jiggle requires a swerve drivetrain.'),
          h('button', { className: 'qbtn', type: 'button', onClick: () => actions.setJiggle(null) }, h(Icon, { name: 'x', size: 14 }), 'Remove jiggle')),

        // Every feature inspector ends with the same full-width destructive action.
        !isAnchor && h('button', { className: 'qbtn wide', type: 'button', style: { marginTop: '14px' }, onClick: () => actions.duplicateWp(i) }, h(Icon, { name: 'copy', size: 14 }), 'Duplicate waypoint'),
        actions.moveWpOrder && n > 2 && h('div', { className: 'qrow', style: { marginTop: '8px' } },
          h('button', { className: 'qbtn', type: 'button', disabled: i === 0, onClick: () => actions.moveWpOrder(i, -1) }, 'Move earlier'),
          h('button', { className: 'qbtn', type: 'button', disabled: i === n - 1, onClick: () => actions.moveWpOrder(i, 1) }, 'Move later')),
        n > 2 && h('button', { className: 'delbtn', type: 'button', onClick: () => actions.delWp(i) }, h(Icon, { name: 'trash', size: 15 }), 'Delete waypoint'));
    }

    else if (sel.kind === 'seg' && wps[sel.idx] && wps[sel.idx + 1]) {
      const i = sel.idx;
      const st = segNorm(wps[i].segType);
      icon = 'route'; title = waypointLabel(i) + ' \u2192 ' + waypointLabel(i + 1);
      let segLen = 0, minR = Infinity, dur = 0;
      if (derived.wpFrac && derived.sample.pts.length > 1) {
        const total = derived.sample.length || 1;
        const lo = derived.wpFrac[i], hi = derived.wpFrac[i + 1];
        segLen = (hi - lo) * total;
        const pts = derived.sample.pts;
        for (let k = 0; k < pts.length; k++) { const f = pts[k].s / total; if (f >= lo && f <= hi && pts[k].curv > 1e-4) minR = Math.min(minR, 1 / pts[k].curv); }
        if (derived.prof.t && derived.wpIdx) dur = (derived.prof.t[derived.wpIdx[i + 1]] || 0) - (derived.prof.t[derived.wpIdx[i]] || 0);
      }
      const segLo = derived.wpFrac ? derived.wpFrac[i] : 0, segHi = derived.wpFrac ? derived.wpFrac[i + 1] : 1;
      const affecting = (doc.ranges || []).map((rg, ri) => ({ rg, ri, ef: (derived.effRanges && derived.effRanges[ri]) || rg }))
        .filter((x) => { const lo = Math.min(x.ef.f0, x.ef.f1), hi = Math.max(x.ef.f0, x.ef.f1); return hi >= segLo && lo <= segHi; });
      body = h(React.Fragment, null,
        Stat3([
          { v: UnitPrefs.format(segLen, 'm', 2), k: 'Length' },
          { v: isFinite(minR) ? UnitPrefs.format(minR, 'm', 2) : '\u221e', k: 'Min radius', color: isFinite(minR) && minR < 0.7 ? 'var(--bad)' : null },
          { v: UnitPrefs.format(dur, 's', 2), k: 'Duration' },
        ]),
        h('div', { className: 'fieldlabel' }, 'Path type'),
        h(Seg, { value: st, options: PM.SEGTYPES.map((type) => ({ v: type.id, label: type.label, title: type.hint })), ariaLabel: 'Path type', onChange: (v) => actions.setSegMeta(i, { segType: v }) }),
        h('div', { className: 'fieldlabel' }, 'Timing'),
        h(Seg, { value: wps[i].segmentFollowMode || 'inherit', ariaLabel: 'Segment follow mode', options: [
          { v: 'inherit', label: 'Use path', title: 'Use the path timing' },
          { v: 'time', label: 'Time', title: 'Advance from the robot clock' },
          { v: 'position', label: 'Position', title: 'Advance from measured field position' },
        ], onChange: (v) => actions.setSegMeta(i, { segmentFollowMode: v === 'inherit' ? undefined : v }) }),
        !isTank && h(React.Fragment, null,
          h('div', { className: 'fieldlabel' }, 'Facing'),
          h(Seg, { value: wps[i].segmentHeadingMode || headingMode, options: [...HEAD_MODES, { v: 'lookAt', label: 'Look at' }], ariaLabel: 'Heading on this segment', className: 'seg-heading', onChange: (v) => actions.setSegmentHeadingMode(i, v) })),
        !isTank && wps[i].segmentHeadingMode === 'lookAt' && wps[i].segmentLookAt && h(React.Fragment, null,
          h('div', { className: 'grid2 compact-fields' },
            h(Num, { label: 'Target X', value: wps[i].segmentLookAt.x, unit: 'm', min: 0, max: FIELD_W, onChange: (v) => actions.setSegmentLookAt(i, { x: v }) }),
            h(Num, { label: 'Target Y', value: wps[i].segmentLookAt.y, unit: 'm', min: 0, max: FIELD_H, onChange: (v) => actions.setSegmentLookAt(i, { y: v }) })),
          h('div', { className: 'seg-hint' }, 'Drag target on field.')),
        h('div', { className: 'fieldlabel' }, 'Zones'),
        affecting.length === 0
          ? h('div', { className: 'seg-hint', style: { marginTop: '0' } }, 'None.')
          : h('div', { className: 'segranges' }, affecting.map((x) => {
              const summary = constraintRangeSummary(x.rg, pathLimits, robot);
              const label = summary ? summary.text : (x.rg.name || 'Zone');
              return h('button', { key: x.ri, className: 'segrange', type: 'button', 'aria-label': 'Open zone, ' + (summary ? summary.ariaLabel : label), onClick: () => actions.select('cr', x.ri) },
                h(Icon, { name: 'gauge', size: 13 }), label, summary && x.rg.name ? h('span', { className: 'segrange-nm' }, x.rg.name) : null);
            })),
        h('button', { className: 'qbtn wide', type: 'button', style: { marginTop: '14px' }, onClick: () => actions.insertWp(i) }, h(Icon, { name: 'plus', size: 14 }), 'Insert waypoint'));
    }

    else if (sel.kind === 'rt' && doc.targets[sel.idx]) {
      const t = doc.targets[sel.idx];
      const targetFraction = PM.featureFraction(t, derived.sample);
      const targetDistance = targetFraction * (derived.sample.length || 0);
      const targetAnchor = t.anchor === 'dist' ? 'dist' : 'param';
      let targetSegment = 0;
      if (derived.wpFrac) for (let i = 0; i < derived.wpFrac.length - 1; i++) if (targetFraction >= derived.wpFrac[i] - 1e-6) targetSegment = i;
      const targetHeadingMode = isTank ? 'tangent' : (wps[targetSegment]?.segmentHeadingMode || headingMode);
      icon = 'rotation'; title = 'Rotation target';
      body = h(React.Fragment, null,
        targetHeadingMode !== 'targets' && h('div', { className: 'hint' }, h(Icon, { name: 'info', size: 14 }), 'Inactive on this segment \u2014 switch its heading mode to Targets.'),
        h(Num, { label: 'Target heading', value: t.deg, unit: '\u00b0', step: 1, precision: 1, onChange: (v) => actions.setTarget(sel.idx, { deg: v }) }),
        h('div', { className: 'fieldlabel' }, 'Anchor position'),
        h(Seg, { value: targetAnchor, ariaLabel: 'Anchor position', options: ANCHOR_OPTIONS, onChange: (v) => actions.setTarget(sel.idx, { anchor: v }) }),
        targetAnchor === 'dist'
          ? h(Num, { label: 'Distance from start', value: targetDistance, unit: 'm', step: 0.1, precision: 2, min: 0, max: derived.sample.length || 0, onChange: (v) => actions.setTarget(sel.idx, { d: v }) })
          : h(Num, { label: 'Position along path', value: targetFraction * 100, unit: '%', step: 1, precision: 0, min: 0, max: 100, onChange: (v) => actions.setTarget(sel.idx, { f: v / 100 }) }),
        h('div', { className: 'seg-hint' }, 'Drag the arrow to adjust facing. Shift-click to delete.'),
        h('button', { className: 'delbtn', type: 'button', onClick: () => actions.delTarget(sel.idx) }, h(Icon, { name: 'trash', size: 15 }), 'Delete target'));
    }

    else if (sel.kind === 'em' && doc.markers[sel.idx]) {
      const m = doc.markers[sel.idx];
      const markerFraction = PM.featureFraction(m, derived.sample);
      const markerDistance = markerFraction * (derived.sample.length || 0);
      const markerAnchor = m.anchor === 'dist' ? 'dist' : 'param';
      const schedule = m.schedule || {};
      const catalog = robotProject && robotProject.catalog;


      const commands = catalog ? catalog.commands || [] : [];
      const invocationId = m.invocation && m.invocation.commandId ? m.invocation.commandId : (m.cmd && m.cmd !== 'none' ? m.cmd : '');
      const selectedCommand = commands.find((command) => command.id === invocationId);
      const unresolved = invocationId && !selectedCommand;
      const pendingActionTag = m.actionIntent && m.actionIntent.semanticTag;
      const commandPickerItems = [{ value: '', label: 'No command' }]
        .concat(unresolved ? [{ value: invocationId, label: simpleRobotName(invocationId), meta: 'Saved command is unavailable', badge: 'Missing' }] : [])
        .concat(commands.map((command) => ({
          value: command.id,
          label: command.label,
          meta: (command.parameters || []).filter((parameter) => parameter.role === 'argument').map((parameter) => parameter.label || parameter.name).join(', ') || command.member,
          badge: pendingActionTag && (command.semanticTags || []).includes(pendingActionTag) ? 'Matches action' : '',
          searchText: [command.description, command.id, command.ownerType, command.member].concat(command.semanticTags || [])
            .concat((command.parameters || []).map((parameter) => [parameter.name, parameter.label, parameter.description, parameter.unit, parameter.valueType].filter(Boolean).join(' ')))
            .filter(Boolean)
            .join(' '),
        })));
      const argumentParameters = selectedCommand ? (selectedCommand.parameters || []).filter((parameter) => parameter.role === 'argument') : [];
      const dependencyParameters = selectedCommand ? (selectedCommand.parameters || []).filter((parameter) => parameter.role === 'dependency') : [];
      const invocationArguments = m.invocation && m.invocation.commandId === invocationId ? (m.invocation.arguments || {}) : {};
      const reconciledArguments = Object.fromEntries(argumentParameters.map((parameter) => {
        const saved = Object.prototype.hasOwnProperty.call(invocationArguments, parameter.name) ? invocationArguments[parameter.name] : undefined;
        return [parameter.name, parameterValueError(saved, parameter) ? parameterDefaultValue(parameter) : saved];
      }));
      const argumentNames = new Set(argumentParameters.map((parameter) => parameter.name));
      const argumentSchemaMismatch = !!selectedCommand && (
        Object.keys(invocationArguments).some((name) => !argumentNames.has(name))
        || argumentParameters.some((parameter) => parameterValueError(invocationArguments[parameter.name], parameter))
      );
      const operation = robotProject && robotProject.operation;
      icon = 'flag2'; title = m.name || 'Command';
      body = h(React.Fragment, null,
        h('label', { className: 'fieldlabel first', htmlFor: 'event-marker-name' }, 'Name'),
        h(DraftText, { id: 'event-marker-name', className: 'textinput', value: m.name, owner: doc.id + ':' + (m.id || sel.idx), autoComplete: 'off', spellCheck: false, 'data-lpignore': 'true', 'data-1p-ignore': true, onCommit: (name) => actions.setMarker(sel.idx, { name }) }),

        h('section', { className: 'cmd-command-editor', 'aria-label': 'Marker command' },
          h(ChoiceBrowser, {
            id: 'event-marker-command', resetKey: doc.id + ':' + sel.idx,
            label: 'Command',
            value: invocationId,
            items: catalog ? commandPickerItems : [],
            placeholder: 'Search commands or parameters', emptyText: catalog ? 'No commands found. Check the linked project.' : 'Link a LabVIEW project to discover commands.',
            icon: 'bolt',
            searchThreshold: 6,
            disabled: !catalog || robotProject.status === 'loading',
            onChange: (commandId) => {
              const command = commands.find((candidate) => candidate.id === commandId);
              const resolvesAction = command && pendingActionTag && (command.semanticTags || []).includes(pendingActionTag);
              actions.setMarker(sel.idx, {
                cmd: command ? command.id : 'none',
                invocation: command ? { commandId: command.id, arguments: commandArguments(command) } : undefined,
                actionIntent: resolvesAction ? undefined : m.actionIntent,
              });
            },
          }),
          catalog && commands.length === 0 && h('div', { className: 'seg-hint', role: 'status' }, 'No command VIs found. Check the linked project or refresh commands.'),
          unresolved && h('div', { className: 'cmd-project-error', role: 'status' }, 'This command is not in the linked project. Its saved ID and arguments are unchanged.'),
          selectedCommand && !selectedCommand.labviewConnector && h('div', { className: 'cmd-project-error', role: 'status' }, 'Refresh commands to load this command’s inputs before exporting.'),
          selectedCommand && h('div', {
            className: 'cmd-command-summary',
            title: selectedCommand.source ? selectedCommand.source.file + ':' + selectedCommand.source.line : undefined,
          },
            selectedCommand.description && h('p', { className: 'cmd-command-description' }, selectedCommand.description),
            h('span', { className: 'cmd-command-meta' }, selectedCommand.member)),
          selectedCommand && dependencyParameters.length > 0 && h('div', { className: 'seg-hint' }, simpleRobotName(dependencyParameters[0].valueType) + (dependencyParameters.length > 1 ? ' and ' + (dependencyParameters.length - 1) + ' more dependencies are supplied by robot code.' : ' is supplied by robot code.')),
          argumentSchemaMismatch && h('div', { className: 'cmd-schema-warning', role: 'status' },
            h('span', null, 'Saved arguments no longer match this command.'),
            h('button', { className: 'qbtn', type: 'button', onClick: () => actions.setMarker(sel.idx, { invocation: { ...m.invocation, commandId: selectedCommand.id, arguments: reconciledArguments } }) }, 'Use current defaults')),
          selectedCommand && h('form', { className: 'cmd-parameters', onSubmit: (event) => event.preventDefault() },
            argumentParameters.length === 0
              ? h('div', { className: 'cmd-empty-params' }, 'No parameters')
              : argumentParameters.map((parameter) => h(CommandParameterEditor, {
                  key: doc.id + ':' + sel.idx + ':' + selectedCommand.id + ':' + parameter.name,
                  id: 'event-command-param-' + safeControlId(parameter.name),
                  label: parameter.label || parameter.name,
                  schema: parameter.schema,
                  parameter,
                  value: reconciledArguments[parameter.name],
                  onChange: (value) => actions.setMarker(sel.idx, { invocation: { ...m.invocation, commandId: selectedCommand.id, arguments: { ...reconciledArguments, [parameter.name]: value } } }),
                  depth: 0,
                })),
            h('label', { className: 'cmd-toggle-row', htmlFor: 'event-command-cancel' },
              h('span', { className: 'cmd-toggle-copy' },
                h('strong', null, 'Stop when path ends'),
                h('small', null, 'Cancel this command if it is still running.')),
              h('input', {
                id: 'event-command-cancel',
                className: 'cmd-toggle-input',
                type: 'checkbox',
                checked: m.invocation && m.invocation.cancelOnPathEnd === true,
                onChange: (event) => actions.setMarker(sel.idx, { invocation: { ...m.invocation, commandId: selectedCommand.id, arguments: reconciledArguments, cancelOnPathEnd: event.target.checked } }),
              }),
              h('span', { className: 'cmd-toggle-track', 'aria-hidden': true }, h('span', null))))),
        m.actionIntent && h('div', { className: 'cmd-project-notice', role: 'status' }, 'Choose a command for ' + m.actionIntent.description + '.'),
        h('div', { className: 'cgroup-h' }, 'Execution'),
        m.group && m.group !== 'sequential' && h('div', { className: 'cmd-schema-warning', role: 'status' }, h('span', null, 'This saved group cannot be exported as BDX.'), h('button', { type: 'button', className: 'qbtn', onClick: () => actions.setMarker(sel.idx, { group: 'sequential' }) }, 'Use single command')),
        h('div', { className: 'fieldlabel' }, 'Trigger from'),
        h(Seg, { value: schedule.trigger || 'time', ariaLabel: 'Event trigger', options: [
          { v: 'time', label: 'Time', title: 'Fire when planned time reaches this marker' },
          { v: 'position', label: 'Position', title: 'Fire when measured progress reaches this marker' },
        ], onChange: (v) => actions.setMarker(sel.idx, { schedule: { ...schedule, trigger: v } }) }),
        h('div', { className: 'seg-hint' }, schedule.trigger === 'position' ? 'Measured position.' : 'Planned time.'),
        h('div', { className: 'inrow' },
          h('span', { className: 'inrow-l' }, 'Repeat command', h('small', null, 'While the window is active')),
          h(Toggle, { on: schedule.repeatEveryS != null, ariaLabel: 'Repeat event', onChange: (on) => actions.setMarker(sel.idx, { schedule: { ...schedule, repeatEveryS: on ? 0.1 : undefined } }) })),
        schedule.repeatEveryS != null && h(Num, { label: 'Repeat every', value: schedule.repeatEveryS, unit: 's', min: 0.001, step: 0.02, precision: 3, onChange: (v) => actions.setMarker(sel.idx, { schedule: { ...schedule, repeatEveryS: v } }) }),
        h('div', { className: 'inrow' },
          h('span', { className: 'inrow-l' }, 'End time', h('small', null, 'Expire or stop repeating')),
          h(Toggle, { on: schedule.endTimeS != null, ariaLabel: 'Limit event end time', onChange: (on) => actions.setMarker(sel.idx, { schedule: { ...schedule, endTimeS: on ? (derived.prof.totalTime || 0) : undefined } }) })),
        schedule.endTimeS != null && h(Num, { label: 'End path time', value: schedule.endTimeS, unit: 's', min: 0, max: derived.prof.totalTime || 0, step: 0.1, precision: 2, onChange: (v) => actions.setMarker(sel.idx, { schedule: { ...schedule, endTimeS: v } }) }),
        schedule.conditionId && h('div', { className: 'cmd-project-error' }, 'Legacy condition: ' + schedule.conditionId,
          h('button', { type: 'button', className: 'rt-openbtn', onClick: () => actions.setMarker(sel.idx, { schedule: { ...schedule, conditionId: undefined } }) }, 'Remove legacy condition')),
        h('div', { className: 'marker-position-group' },
          h('div', { className: 'fieldlabel' }, 'Anchor position'),
          h(Seg, { value: markerAnchor, ariaLabel: 'Anchor position', options: ANCHOR_OPTIONS, onChange: (v) => actions.setMarker(sel.idx, { anchor: v }) }),
          markerAnchor === 'dist'
            ? h(Num, { label: 'Distance from start', value: markerDistance, unit: 'm', step: 0.1, precision: 2, min: 0, max: derived.sample.length || 0, onChange: (v) => actions.setMarker(sel.idx, { d: v }) })
            : h(Num, { label: 'Position along path', value: markerFraction * 100, unit: '%', step: 1, precision: 0, min: 0, max: 100, onChange: (v) => actions.setMarker(sel.idx, { f: v / 100 }) }),
          ),
        h('button', { className: 'delbtn', type: 'button', onClick: () => actions.delMarker(sel.idx) }, h(Icon, { name: 'trash', size: 15 }), 'Delete command'));
    }

    else if (sel.kind === 'cr' && doc.ranges && doc.ranges[sel.idx]) {
      const rg = doc.ranges[sel.idx];
      const len = derived.sample.length || 1;
      const effR = (derived.effRanges && derived.effRanges[sel.idx]) || { f0: rg.f0 || 0, f1: rg.f1 || 0 };
      const loF = Math.min(effR.f0, effR.f1), hiF = Math.max(effR.f0, effR.f1);
      const clampFraction = (value) => Math.max(0, Math.min(1, value / 100));
      const rangeAnchor = rg.anchor === 'dist' ? 'dist' : 'param';
      icon = 'gauge'; title = rg.name || 'Zone';
      tag = UnitPrefs.fromCanonical(loF * len, 'm').toFixed(1) + '\u2013' + UnitPrefs.format(hiF * len, 'm', 1);
      body = h(React.Fragment, null,
        h(RangeLimits, { range: rg, limits: pathLimits, onChange: (patch) => actions.setRange(sel.idx, patch) }),
        h('section', { className: 'range-anchor-editor', 'aria-label': 'Zone position' },
          h('div', { className: 'fieldlabel' }, 'Position'),
          h(Seg, { value: rangeAnchor, ariaLabel: 'Position', options: ANCHOR_OPTIONS, onChange: (v) => actions.setRangeAnchor(sel.idx, v) }),
          rangeAnchor === 'dist'
            ? h('div', { className: 'grid2' },
                h(Num, { label: 'Start distance', value: loF * len, unit: 'm', min: 0, max: len, step: 0.1, precision: 2, onChange: (v) => actions.setRange(sel.idx, { d0: Math.min(v, hiF * len) }) }),
                h(Num, { label: 'End distance', value: hiF * len, unit: 'm', min: 0, max: len, step: 0.1, precision: 2, onChange: (v) => actions.setRange(sel.idx, { d1: Math.max(v, loF * len) }) }))
            : h('div', { className: 'grid2' },
                  h(Num, { label: 'Start position', value: loF * 100, unit: '%', min: 0, max: 100, step: 1, precision: 0, onChange: (v) => actions.setRange(sel.idx, { anchor: 'param', f0: Math.min(clampFraction(v), hiF), f1: hiF }) }),
                  h(Num, { label: 'End position', value: hiF * 100, unit: '%', min: 0, max: 100, step: 1, precision: 0, onChange: (v) => actions.setRange(sel.idx, { anchor: 'param', f0: loF, f1: Math.max(clampFraction(v), loF) }) })),
          ),
        h('label', { className: 'fieldlabel', htmlFor: 'constraint-range-label' }, 'Name'),
        h(DraftText, { id: 'constraint-range-label', className: 'textinput', value: rg.name || '', owner: doc.id + ':' + sel.idx, placeholder: 'Zone', autoComplete: 'off', spellCheck: false, 'data-lpignore': 'true', 'data-1p-ignore': true, onCommit: (name) => actions.setRange(sel.idx, { name }) }),
        h('div', { className: 'chint' }, 'Overlapping zones use the lowest limit.'),
        h('button', { className: 'delbtn', type: 'button', onClick: () => actions.delRange(sel.idx) }, h(Icon, { name: 'trash', size: 15 }), 'Delete zone'));
    } else {
      return null;
    }

    return h('div', { className: 'ctxinsp inspector-refresh' },
      h('div', { className: 'ctxinsp-hd' },
        h('span', { className: 'ctxinsp-ic' }, h(Icon, { name: icon, size: 15 })),
        h('span', { className: 'ctxinsp-t', title }, title),
        tag && h('span', { className: 'ctxinsp-tag' }, tag),
        headerAction,
        h('button', { className: 'ctxinsp-x', type: 'button', title: 'Hide inspector', 'aria-label': 'Hide inspector', onClick: onClose }, h(Icon, { name: 'x', size: 14 }))),
      // Keyed by the selected item so an unfinished numeric or text draft never moves to another item.
      h('div', { className: 'ctxinsp-body', key: doc.id + ':' + (sel.kind || 'path') + ':' + sel.idx, inert: props.pending ? '' : undefined }, body));
  }

export { ContextInspector, CommandParameterEditor, commandArguments, parameterValueError, safeControlId };
