import * as React from 'react';
import { REV_40A_ATO_BREAKER, BUSSMANN_185_120A_BREAKER } from '../../shared/breakerPresets';

const h = React.createElement;

function BreakerEditor({ name, value, onChange, BigNum }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState({ ratedCurrentA: undefined, tripTimeAt2xS: undefined, initialHeat: 0 });
  const start = () => { setDraft(value || { ratedCurrentA: undefined, tripTimeAt2xS: undefined, initialHeat: 0 }); setEditing(true); };
  const valid = draft.ratedCurrentA > 0 && draft.tripTimeAt2xS > 0 && draft.initialHeat >= 0 && draft.initialHeat <= 1;
  return h('div', { className: 'power-breaker' },
    h('div', { className: 'rp-subh' }, name),
    !editing ? h(React.Fragment, null,
      h('p', { className: 'rp-note' }, value ? `${value.ratedCurrentA} A · cold trip at 2×: ${value.tripTimeAt2xS} s · initial heat: ${Math.round(value.initialHeat * 100)}%` : 'Not configured. No trip risk is estimated until you enter its curve.'),
      h('button', { type: 'button', className: 'qbtn quiet', onClick: start }, value ? `Edit ${name.toLowerCase()}` : `Configure ${name.toLowerCase()}`),
      value && h('button', { type: 'button', className: 'qbtn quiet', onClick: () => onChange(undefined) }, `Remove ${name.toLowerCase()}`))
      : h(React.Fragment, null,
        h('div', { className: 'rp-two rp-drive-model' },
          [['ratedCurrentA', 'Rating', 'A', 1, 500, 1], ['tripTimeAt2xS', 'Cold trip at 2×', 's', 0.01, 3600, 1], ['initialHeat', 'Initial heat', '%', 0, 100, 100]].map(([key, label, unit, min, max, scale]) =>
            h('div', { className: 'rp-field', key }, h('div', { className: 'rp-flabel' }, label),
              h(BigNum, { label: `${name} ${label.toLowerCase()}`, value: draft[key] === undefined ? undefined : draft[key] * scale, unit, min, max, precision: 2, step: 1,
                onChange: v => setDraft(previous => ({ ...previous, [key]: v / scale })) })))),
        h('div', { className: 'power-actions' },
          h('button', { type: 'button', className: 'qbtn', onClick: () => setEditing(false) }, 'Cancel'),
          h('button', { type: 'button', className: 'qbtn primary', disabled: !valid, onClick: () => { onChange(draft); setEditing(false); } }, `Use ${name.toLowerCase()} curve`))));
}

export function PowerSettings({ model, setModel, BigNum }) {
  const bursts = model.loadBursts || [];
  const setBurst = (index, patch) => setModel({ loadBursts: bursts.map((burst, i) => i === index ? { ...burst, ...patch } : burst) });
  return h(React.Fragment, null,
    h('div', { className: 'rp-note' }, 'Battery voltage is the unloaded voltage. Resistance includes battery, wiring and connectors; use measured values for the battery condition you want to plan for.'),
    h('div', { className: 'rp-field power-minimum' },
      h('div', { className: 'rp-flabel' }, 'Minimum bus voltage', model.minimumBusVoltageV === undefined && h('small', null, 'Default · 7.25 V')),
      h(BigNum, { label: 'Minimum bus voltage', value: model.minimumBusVoltageV, placeholder: '7.25', unit: 'V', min: 1, max: (model.batteryVoltageV ?? 12) - 0.01, precision: 2, step: 0.05, onChange: v => setModel({ minimumBusVoltageV: v }) })),
    model.minimumBusVoltageV !== undefined && h('button', { className: 'qbtn quiet', type: 'button', onClick: () => setModel({}, ['minimumBusVoltageV']) }, 'Use default minimum voltage'),
    h('p', { className: 'rp-note' }, 'Set this above your configured brownout threshold. The default includes 0.5 V above the roboRIO 2 default; confirm it for your robot.'),
    h('div', { className: 'rp-subh' }, 'Mechanism load bursts'),
    h('p', { className: 'rp-note' }, 'Additional battery current above Other mechanisms. Times start at 0 for each path or the selected routine preview. Overlaps add; path timing reserves the peak load throughout.'),
    bursts.map((burst, index) => h('div', { key: index, className: 'power-burst' },
      h('div', { className: 'rp-two rp-drive-model' },
        [['startTimeS', 'Start', 's', 0, burst.endTimeS - 0.01], ['endTimeS', 'End', 's', burst.startTimeS + 0.01, 3600], ['currentA', 'Additional current', 'A', 0, 500]].map(([key, label, unit, min, max]) =>
          h('div', { className: 'rp-field', key }, h('div', { className: 'rp-flabel' }, label), h(BigNum, { label: `Load burst ${index + 1} ${label.toLowerCase()}`, value: burst[key], unit, min, max, precision: 2, step: 0.1, onChange: v => setBurst(index, { [key]: v }) })))),
      h('button', { type: 'button', className: 'qbtn quiet', onClick: () => setModel({ loadBursts: bursts.filter((_, i) => i !== index) }) }, `Remove load burst ${index + 1}`))),
    h('button', { type: 'button', className: 'qbtn quiet', disabled: bursts.length >= 128, onClick: () => setModel({ loadBursts: [...bursts, { startTimeS: 0, endTimeS: 1, currentA: 0 }] }) }, 'Add load burst'),
    h('div', { className: 'rp-subh' }, 'Breaker estimates'),
    h('p', { className: 'rp-note' }, 'Use the earliest trip time at twice rated current from your breaker’s cold trip curve. Heating and cooling are approximations. Initial heat is an assumed starting condition, not a measured temperature. Drive curves apply to one breaker per motor; mechanism branch breakers are not modeled.'),
    h('button', { type: 'button', className: 'qbtn quiet', onClick: () => setModel({ driveBreaker: { ...REV_40A_ATO_BREAKER } }) }, 'Use REV 40 A ATO drive breakers'),
    h('p', { className: 'rp-note' }, 'REV preset: earliest published cold trip at 80 A is 5 s. Starts cold; edit Initial heat for a warm-start estimate.'),
    h(BreakerEditor, { name: 'Drive breaker', value: model.driveBreaker, onChange: value => setModel(value ? { driveBreaker: value } : {}, value ? [] : ['driveBreaker']), BigNum }),
    h('button', { type: 'button', className: 'qbtn quiet', onClick: () => setModel({ mainBreaker: { ...BUSSMANN_185_120A_BREAKER } }) }, 'Use Bussmann 185120F main breaker'),
    h('p', { className: 'rp-note' }, 'Bussmann preset: about 10 s at 240 A, read from the earliest edge of the 18X series graph. This is an approximate cold-curve fit, not an exact trip time.'),
    h(BreakerEditor, { name: 'Main breaker', value: model.mainBreaker, onChange: value => setModel(value ? { mainBreaker: value } : {}, value ? [] : ['mainBreaker']), BigNum }));
}
