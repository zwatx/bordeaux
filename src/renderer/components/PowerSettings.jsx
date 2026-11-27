import * as React from 'react';
import { REV_40A_ATO_BREAKER, BUSSMANN_185_120A_BREAKER } from '../../core/breakerPresets';
import { UI } from './ui';
import { CommandPowerSummary } from './CommandPower';

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

const seconds = (value) => `${+value.toFixed(2)} s`;

/**
 * Loads and breakers: command power is entered on each command use, so this lists the selected robot's estimates with
 * their uses. Legacy timed loads from older projects stay listed, read-only, until removed; they still apply to every
 * path, so the list says so.
 */
export function PowerSettings({ model, setModel, power, BigNum, Row }) {
  const bursts = model.loadBursts || [];
  const focusFirst = () => requestAnimationFrame(() => document.querySelector('#settings-power .settings-card button')?.focus());
  const breaker = (key, title, preset, presetLabel, source) => h(Breaker, { id: 'robot-' + key, name: title, preset, presetLabel, source, value: model[key], BigNum, Row,
    onChange: (value) => setModel(value ? { [key]: value } : {}, value ? [] : [key]) });
  return h(React.Fragment, null,
    h(CommandPowerSummary, { power }),
    bursts.length > 0 && h('div', { className: 'settings-card' },
      h(Row, { label: 'Legacy timed loads', hint: 'From an older project. Each one applies to every path and routine at the same times, whatever commands run. Enter power on the commands that draw it instead, then remove them.' },
        h('button', { type: 'button', className: 'qbtn', onClick: () => { setModel({}, ['loadBursts']); focusFirst(); } }, 'Remove all')),
      bursts.map((burst, index) => h(Row, { key: index, label: `${seconds(burst.startTimeS)} – ${seconds(burst.endTimeS)}`, className: 'settings-sub power-legacy' },
        h('span', { className: 'settings-status' }, `${+burst.currentA.toFixed(2)} A`),
        h('button', { type: 'button', className: 'power-remove', title: 'Remove', 'aria-label': `Remove timed load ${index + 1}`,
          onClick: () => { const next = bursts.filter((_, i) => i !== index); setModel(next.length ? { loadBursts: next } : {}, next.length ? [] : ['loadBursts']); if (!next.length) focusFirst(); } },
          h(UI.Icon, { name: 'x', size: 14 }))))),
    h('div', { className: 'settings-card' },
      breaker('driveBreaker', 'Drive breaker', REV_40A_ATO_BREAKER, 'REV 40 A ATO', 'One per drive motor. REV preset: published 5 s at 80 A.'),
      breaker('mainBreaker', 'Main breaker', BUSSMANN_185_120A_BREAKER, 'Bussmann 185120F', 'Bussmann preset: about 10 s at 240 A, an approximate fit.')));
}
