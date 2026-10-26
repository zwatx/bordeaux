import * as React from 'react';
import { REV_40A_ATO_BREAKER, BUSSMANN_185_120A_BREAKER } from '../../shared/breakerPresets';
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

export function PowerSettings({ model, setModel, BigNum, Row }) {
  const bursts = model.loadBursts || [];
  const add = React.useRef(null);
  const setBurst = (index, patch) => setModel({ loadBursts: bursts.map((burst, i) => i === index ? { ...burst, ...patch } : burst) });
  const breaker = (key, name, preset, presetLabel, source) => h(Breaker, { id: 'robot-' + key, name, preset, presetLabel, source, value: model[key], BigNum, Row,
    onChange: (value) => setModel(value ? { [key]: value } : {}, value ? [] : [key]) });
  return h(React.Fragment, null,
    h('div', { className: 'settings-card' },
      h(Row, { label: 'Load bursts', hint: 'Extra current above Other mechanisms, timed from the start of each path or routine preview. Overlapping bursts add; path timing reserves the peak.', status: bursts.length ? null : 'None' },
        h('button', { ref: add, type: 'button', className: 'qbtn', disabled: bursts.length >= 128, onClick: () => setModel({ loadBursts: [...bursts, { startTimeS: 0, endTimeS: 1, currentA: 0 }] }) }, 'Add load burst')),
      // Each burst reads as "start – end, current"; the units name the fields.
      bursts.map((burst, index) => h(Row, { key: index, label: `Burst ${index + 1}`, className: 'settings-sub power-burst' },
        h(BigNum, { label: `Load burst ${index + 1} start`, value: burst.startTimeS, unit: 's', min: 0, max: burst.endTimeS - 0.01, precision: 2, step: 0.1, onChange: (v) => setBurst(index, { startTimeS: v }) }),
        h('span', { className: 'power-dash', 'aria-hidden': true }, '–'),
        h(BigNum, { label: `Load burst ${index + 1} end`, value: burst.endTimeS, unit: 's', min: burst.startTimeS + 0.01, max: 3600, precision: 2, step: 0.1, onChange: (v) => setBurst(index, { endTimeS: v }) }),
        h(BigNum, { label: `Load burst ${index + 1} additional current`, value: burst.currentA, unit: 'A', min: 0, max: 500, precision: 2, step: 0.1, onChange: (v) => setBurst(index, { currentA: v }) }),
        h('button', { type: 'button', className: 'power-remove', title: 'Remove', 'aria-label': `Remove load burst ${index + 1}`,
          onClick: () => { setModel({ loadBursts: bursts.filter((_, i) => i !== index) }); requestAnimationFrame(() => add.current.focus()); } }, h(UI.Icon, { name: 'x', size: 14 }))))),
    h('div', { className: 'settings-card' },
      breaker('driveBreaker', 'Drive breaker', REV_40A_ATO_BREAKER, 'REV 40 A ATO', 'One per drive motor. REV preset: published 5 s at 80 A.'),
      breaker('mainBreaker', 'Main breaker', BUSSMANN_185_120A_BREAKER, 'Bussmann 185120F', 'Bussmann preset: about 10 s at 240 A, an approximate fit.')));
}
