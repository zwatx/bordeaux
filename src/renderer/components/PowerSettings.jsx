import * as React from 'react';
import { REV_40A_ATO_BREAKER, BUSSMANN_185_120A_BREAKER } from '../../core/breakerPresets';
import { UI } from './ui';

const h = React.createElement;
const CURVE_KEYS = ['ratedCurrentA', 'tripTimeAt2xS', 'initialHeat'];
const CAVEAT = 'Trips use the earliest cold trip time at twice rated current; heating and cooling are approximations, not measured temperatures.';

// A breaker is one dropdown: not modeled, its preset, or a custom curve whose fields open beneath it.
function Breaker({ id, name, preset, presetLabel, source, value, onChange, BigNum, Row }) {
  const [custom, setCustom] = React.useState(false);
  const choice = !value ? 'none' : !custom && CURVE_KEYS.every((key) => value[key] === preset[key]) ? 'preset' : 'custom';
  const choose = (next) => {
    setCustom(next === 'custom');
    // Re-picking the shown choice must not write: an unchanged project stays clean.
    const curve = next === 'none' ? undefined : next === 'preset' ? { ...preset } : value || { ...preset };
    if (curve === value || (curve && value && CURVE_KEYS.every((key) => curve[key] === value[key]))) return;
    onChange(curve);
  };
  return h(React.Fragment, null,
    h(Row, { label: name, hint: source + ' ' + CAVEAT },
      h(UI.Dropdown, { id, ariaLabel: name, value: choice, onChange: choose, items: [
        { value: 'none', label: 'Not modeled' },
        { value: 'preset', label: presetLabel, meta: `${preset.ratedCurrentA} A · ${preset.tripTimeAt2xS} s at 2×` },
        { value: 'custom', label: 'Custom curve' },
      ] })),
    choice === 'custom' && [['ratedCurrentA', 'Rating', 'A', 1, 500, 1], ['tripTimeAt2xS', 'Cold trip at 2×', 's', 0.01, 3600, 1], ['initialHeat', 'Initial heat', '%', 0, 100, 100]].map(([key, label, unit, min, max, scale]) =>
      h(Row, { key, label, className: 'settings-sub' },
        h(BigNum, { label: `${name} ${label.toLowerCase()}`, value: value[key] * scale, unit, min, max, precision: 2, step: 1,
          onChange: (v) => onChange({ ...value, [key]: v / scale }) }))));
}

const ADD_ID = 'robot-command-load-add';
/** Matches project validation. */
const MAX_COMMAND_ID_LENGTH = 256;
const seconds = (value) => `${+value.toFixed(2)} s`;

/**
 * Command loads: what each command draws while it runs. Legacy timed loads from older projects stay listed,
 * read-only, until removed; they still apply to every path, so the list says so.
 */
export function PowerSettings({ model, setModel, commands = [], BigNum, Row }) {
  const loads = model.commandLoads || [];
  const bursts = model.loadBursts || [];
  const known = new Map(commands.map((command) => [command.id, command.label || command.id]));
  const name = (id) => known.get(id) || id;
  const configured = new Set(loads.map((load) => load.commandId));
  const choices = commands.filter((command) => !configured.has(command.id))
    .map((command) => ({ value: command.id, label: command.label || command.id, meta: command.label && command.label !== command.id ? command.id : undefined }));
  const setLoads = (next) => setModel(next.length ? { commandLoads: next } : {}, next.length ? [] : ['commandLoads']);
  const setLoad = (index, patch, remove) => setLoads(loads.map((load, i) => {
    if (i !== index) return load;
    const next = { ...load, ...patch };
    if (remove) delete next[remove];
    return next;
  }));
  const add = (commandId) => {
    const id = String(commandId || '').trim();
    if (!id || id.length > MAX_COMMAND_ID_LENGTH || configured.has(id)) return;
    setLoads([...loads, { commandId: id, currentA: 0 }]);
    // The picker returns focus to itself first; then move on to the new (last) load's current.
    requestAnimationFrame(() => requestAnimationFrame(() => [...document.querySelectorAll('.power-load')].at(-1)?.querySelector('input')?.focus()));
  };
  const focusAdd = () => requestAnimationFrame(() => document.getElementById(ADD_ID)?.focus());
  const breaker = (key, title, preset, presetLabel, source) => h(Breaker, { id: 'robot-' + key, name: title, preset, presetLabel, source, value: model[key], BigNum, Row,
    onChange: (value) => setModel(value ? { [key]: value } : {}, value ? [] : [key]) });
  return h(React.Fragment, null,
    h('div', { className: 'settings-card' },
      h(Row, { label: 'Command loads', status: loads.length ? null : 'None',
        hint: 'Battery current a command draws while it runs, on top of Other mechanisms. Path timing reserves every command a path starts. Leave the run time empty when the command runs until a loop limit, a path-end cancel, or the end of the path.' },
        h(UI.Dropdown, { id: ADD_ID, ariaLabel: 'Add command load', value: null, placeholder: 'Add command…', items: choices, onChange: add,
          disabled: loads.length >= 128, allowCustom: true, customLabel: 'Enter command ID', customPlaceholder: 'Command ID', customMaxLength: MAX_COMMAND_ID_LENGTH })),
      loads.map((load, index) => h(Row, { key: load.commandId, label: name(load.commandId), className: 'settings-sub power-load',
        hint: known.has(load.commandId) ? (name(load.commandId) !== load.commandId ? load.commandId : null) : 'Not in the linked robot code. Its events still use this load.' },
        h(BigNum, { label: `${name(load.commandId)} current`, value: load.currentA, unit: 'A', min: 0, max: 500, precision: 1, step: 1,
          onChange: (v) => setLoad(index, { currentA: v }) }),
        h(BigNum, { label: `${name(load.commandId)} run time`, value: load.runTimeS, placeholder: 'Until stopped', clearable: true, unit: 's', min: 0.01, max: 3600, precision: 2, step: 0.1,
          onChange: (v) => setLoad(index, v === undefined ? {} : { runTimeS: v }, v === undefined ? 'runTimeS' : null) }),
        h('button', { type: 'button', className: 'power-remove', title: 'Remove', 'aria-label': `Remove ${name(load.commandId)} load`,
          onClick: () => { setLoads(loads.filter((_, i) => i !== index)); focusAdd(); } }, h(UI.Icon, { name: 'x', size: 14 }))))),
    bursts.length > 0 && h('div', { className: 'settings-card' },
      h(Row, { label: 'Legacy timed loads', hint: 'From an older project. Each one applies to every path and routine at the same times, whatever commands run. Move them to command loads, then remove them.' },
        h('button', { type: 'button', className: 'qbtn', onClick: () => { setModel({}, ['loadBursts']); focusAdd(); } }, 'Remove all')),
      bursts.map((burst, index) => h(Row, { key: index, label: `${seconds(burst.startTimeS)} – ${seconds(burst.endTimeS)}`, className: 'settings-sub power-legacy' },
        h('span', { className: 'settings-status' }, `${+burst.currentA.toFixed(2)} A`),
        h('button', { type: 'button', className: 'power-remove', title: 'Remove', 'aria-label': `Remove timed load ${index + 1}`,
          onClick: () => { const next = bursts.filter((_, i) => i !== index); setModel(next.length ? { loadBursts: next } : {}, next.length ? [] : ['loadBursts']); if (!next.length) focusAdd(); } },
          h(UI.Icon, { name: 'x', size: 14 }))))),
    h('div', { className: 'settings-card' },
      breaker('driveBreaker', 'Drive breaker', REV_40A_ATO_BREAKER, 'REV 40 A ATO', 'One per drive motor. REV preset: published 5 s at 80 A.'),
      breaker('mainBreaker', 'Main breaker', BUSSMANN_185_120A_BREAKER, 'Bussmann 185120F', 'Bussmann preset: about 10 s at 240 A, an approximate fit.')));
}
