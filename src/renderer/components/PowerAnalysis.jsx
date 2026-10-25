import * as React from 'react';
import { createPortal } from 'react-dom';
import '../styles/power-analysis.css';

const h = React.createElement;
const number = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : 'Unachievable';

export function PowerAnalysis({ robot, path, trajectory, run, stale = false }) {
  const [open, setOpen] = React.useState(false), [report, setReport] = React.useState(null), [error, setError] = React.useState('');
  const dialog = React.useRef(null), trigger = React.useRef(null);
  const available = !stale && (run ? !run.blocked && run.total > 0 : trajectory?.samples?.length > 1);
  React.useEffect(() => {
    if (!open) return undefined;
    const element = dialog.current;
    element.showModal();
    let active = true, worker, timer;
    setReport(null); setError('');
    const compute = async () => {
      try {
        if (!available) throw new Error('Wait for a current path or routine plan.');
        if (run?.truncated) throw new Error('This routine preview was truncated. A whole-routine heat estimate needs the complete sequence; analyze its individual paths instead.');
        if (run && (run.duration.unknownCount || run.duration.usesLimits)) throw new Error('This routine contains unknown or conditional durations. A whole-routine heat estimate needs exact timing; analyze its individual paths instead.');
        const result = await new Promise((resolve, reject) => {
          worker = new Worker(new URL('../assets/path-preview-worker.js', import.meta.url), { type: 'module' });
          worker.onmessage = event => {
            clearTimeout(timer); worker.terminate();
            event.data.error ? reject(new Error(event.data.error.message)) : resolve(event.data.value);
          };
          worker.onerror = () => { clearTimeout(timer); worker.terminate(); reject(new Error('Power analysis could not finish. Close this view and try again.')); };
          timer = setTimeout(() => { worker.terminate(); reject(new Error('Power analysis exceeded its time limit. Analyze a shorter sequence.')); }, 30000);
          worker.postMessage({ id: 1, mode: 'power', robot, ...(run ? {
            segments: run.segs.map(s => ({ t0: s.t0, t1: s.t1, doc: s.doc, trajectory: s.trajectory })), totalTimeS: run.total,
          } : { path, trajectory }) });
        });
        if (!result) throw new Error('Configure a complete electrical drive model to estimate power.');
        if (active) setReport(result);
      } catch (failure) { if (active) setError(failure.message || String(failure)); }
    };
    void compute();
    return () => { active = false; clearTimeout(timer); worker?.terminate(); element.close(); };
  }, [open, robot, path, trajectory, run, available]);
  const close = () => { dialog.current?.close(); setOpen(false); trigger.current?.focus(); };
  const heat = value => value == null ? 'Not configured' : `${number(value * 100, 0)}% of modeled trip level`;
  return h(React.Fragment, null,
    h('button', { ref: trigger, type: 'button', className: 'qbtn quiet', disabled: !available, onClick: () => setOpen(true) }, 'Power'),
    open && createPortal(h('dialog', { ref: dialog, className: 'power-dialog', 'aria-labelledby': 'power-title', onCancel: event => { event.preventDefault(); close(); } },
      h('div', { className: 'power-dialog-head' }, h('h2', { id: 'power-title' }, run ? 'Routine power estimate' : 'Path power estimate'), h('button', { className: 'qbtn', type: 'button', onClick: close, autoFocus: true }, 'Close')),
      h('p', null, run ? 'Selected preview branches and repeat counts, including waits. Heat carries between paths.' : 'This path starts at the configured initial breaker heat. A sequence of paths can run hotter.'),
      error ? h('p', { role: 'alert' }, error) : !report ? h('p', { role: 'status' }, 'Calculating power…') : h(React.Fragment, null,
        h('dl', { className: 'power-results' }, [
          ['Minimum bus voltage', `${number(report.minimumBusVoltageV, 2)} V`],
          ['Peak battery current', `${number(report.peakSupplyCurrentA)} A`],
          ['Peak drive motor current', `${number(report.peakStatorCurrentA)} A per motor`],
          ['Main breaker peak heat', heat(report.mainBreakerPeakHeat)],
          ['Drive breaker peak heat', heat(report.driveBreakerPeakHeat)],
        ].map(([label, value]) => h('div', { key: label }, h('dt', null, label), h('dd', null, value)))),
        h('div', { className: 'power-findings' },
          report.collapsed && h('p', null, 'The requested load has no steady battery-voltage solution.'),
          report.brownoutRisk && h('p', null, 'Predicted voltage falls below your minimum bus voltage.'),
          report.voltageOverload && h('p', null, 'Some motors need more voltage than the shared bus leaves available for planning.'),
          report.currentOverload && h('p', null, 'Some motors exceed the configured planning current limit.'),
          (report.mainBreakerPeakHeat >= 1 || report.driveBreakerPeakHeat >= 1) && h('p', null, 'Estimated breaker heating reaches its trip level. Review the load duration and curve inputs.'),
          !report.collapsed && !report.brownoutRisk && !report.voltageOverload && !report.currentOverload && !(report.mainBreakerPeakHeat >= 1 || report.driveBreakerPeakHeat >= 1)
            && h('p', null, 'No electrical overload found in this estimate.'))),
      h('p', { className: 'power-limit-note' }, 'Estimates use your battery condition, scheduled mechanism loads and breaker curves. Breaker heating fits one cold-curve point; it does not certify a no-trip condition. Regenerative braking is not credited as extra battery capacity.')),
    document.body));
}
