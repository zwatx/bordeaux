import * as React from 'react';
import { minimumBusVoltage } from '../../core/electricalPower';
import '../styles/power-analysis.css';

const h = React.createElement;
const number = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : 'Unachievable';
const GAP = 6, EDGE = 8, MAX_HEIGHT = 420;

/** Problems in the order a reader should act on them; an empty list means none found in this estimate. */
export function powerFindings(report) {
  const findings = [];
  if (report.collapsed) findings.push({ tone: 'bad', text: 'The requested load has no steady battery-voltage solution.' });
  if (report.brownoutRisk) findings.push({ tone: 'bad', text: 'Predicted voltage falls below your minimum bus voltage.' });
  if (report.mainBreakerPeakHeat >= 1 || report.driveBreakerPeakHeat >= 1) findings.push({ tone: 'bad', text: 'Estimated breaker heating reaches its trip level. Review the load duration and curve inputs.' });
  if (report.voltageOverload) findings.push({ tone: 'warn', text: 'Some motors need more voltage than the shared bus leaves available for planning.' });
  if (report.currentOverload) findings.push({ tone: 'warn', text: 'Some motors exceed the configured planning current limit.' });
  return findings;
}

const heat = value => value == null ? { value: 'Not set', unset: true } : { value: `${number(value * 100, 0)}%`, context: 'of trip', bad: value >= 1 };

/** The readout itself: problems first, then the five estimated quantities with the limit each is read against. */
export function PowerReportBody({ report, robot, routine = false, error = '', updating = false, titleId }) {
  const findings = report ? powerFindings(report) : [];
  const unloaded = report?.commandsWithoutLoad?.length || 0;
  const rows = report ? [
    ['Lowest bus voltage', { value: `${number(report.minimumBusVoltageV, 2)} V`, context: `floor ${number(minimumBusVoltage(robot), 2)} V`, bad: report.brownoutRisk || report.collapsed }],
    ['Peak battery current', { value: `${number(report.peakSupplyCurrentA)} A` }],
    ['Peak drive motor current', { value: `${number(report.peakStatorCurrentA)} A`, context: 'per motor', bad: report.currentOverload, tone: 'warn' }],
    ['Peak mechanism current', { value: `${number(report.peakMechanismCurrentA)} A` }],
    ['Main breaker heat', heat(report.mainBreakerPeakHeat)],
    ['Drive breaker heat', heat(report.driveBreakerPeakHeat)],
  ] : [];
  return h(React.Fragment, null,
    h('div', { className: 'power-head' },
      h('h2', { id: titleId, className: 'power-title' }, routine ? 'Routine power estimate' : 'Path power estimate'),
      updating && report && !error && h('span', { className: 'power-updating' }, 'Updating…')),
    h('p', { className: 'power-scope' }, routine
      ? 'Selected preview branches and repeat counts, including waits. Heat carries between paths.'
      : 'Starts at the configured breaker heat. Back-to-back paths can run hotter.'),
    error ? h('p', { className: 'power-error', role: 'alert' }, error)
      : h('div', { className: 'power-verdict', role: 'status' },
        !report ? h('p', null, 'Calculating power…')
          : findings.length ? h('ul', { className: 'power-findings' }, findings.map(finding => h('li', { key: finding.text, 'data-tone': finding.tone }, finding.text)))
            : h('p', null, 'No electrical overload found in this estimate.')),
    report && !error && h('dl', { className: 'power-results', 'data-updating': updating || undefined },
      rows.map(([label, cell]) => h('div', { key: label, 'data-tone': cell.bad ? (cell.tone || 'bad') : undefined },
        h('dt', null, label),
        h('dd', { className: cell.unset ? 'power-value power-unset' : 'power-value' }, cell.value),
        h('dd', { className: 'power-context' }, cell.context || '')))),
    report && !error && unloaded > 0 && h('p', { className: 'power-note power-unloaded' },
      `${unloaded === 1 ? '1 command' : unloaded + ' commands'} started here ${unloaded === 1 ? 'has' : 'have'} no load set, so ${unloaded === 1 ? 'it adds' : 'they add'} no current. Set command loads on the Robot page.`),
    h('p', { className: 'power-note' }, 'Uses your battery condition, command loads and breaker curves. Breaker heat fits one cold-curve point, so it does not certify a no-trip run. Regenerative braking is not credited as extra battery capacity.'));
}

function analyze({ robot, path, trajectory, run }) {
  if (run?.truncated) return Promise.reject(new Error('This routine preview was truncated. A whole-routine heat estimate needs the complete sequence; analyze its individual paths instead.'));
  if (run && (run.duration.unknownCount || run.duration.usesLimits)) return Promise.reject(new Error('This routine contains unknown or conditional durations. A whole-routine heat estimate needs exact timing; analyze its individual paths instead.'));
  let worker, timer;
  const promise = new Promise((resolve, reject) => {
    worker = new Worker(new URL('../assets/path-preview-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = event => {
      clearTimeout(timer); worker.terminate();
      if (event.data.error) reject(new Error(event.data.error.message));
      else if (!event.data.value) reject(new Error('Configure a complete electrical drive model to estimate power.'));
      else resolve(event.data.value);
    };
    worker.onerror = () => { clearTimeout(timer); worker.terminate(); reject(new Error('Power analysis could not finish. Close this report and try again.')); };
    timer = setTimeout(() => { worker.terminate(); reject(new Error('Power analysis exceeded its time limit. Analyze a shorter sequence.')); }, 30000);
    worker.postMessage({ id: 1, mode: 'power', robot, ...(run ? {
      segments: run.segs.map(s => ({ t0: s.t0, t1: s.t1, doc: s.doc, trajectory: s.trajectory })), totalTimeS: run.total,
    } : { path, trajectory }) });
  });
  promise.cancel = () => { clearTimeout(timer); worker?.terminate(); };
  return promise;
}

/**
 * A nonmodal readout anchored to its Power button. The native popover gives light dismiss; focus stays
 * with the button, and the verdict is a live status so it is announced when it arrives.
 */
export function PowerAnalysis({ robot, path, trajectory, run, stale = false }) {
  const [open, setOpen] = React.useState(false);
  const [state, setState] = React.useState({ report: null, error: '', pending: false });
  const trigger = React.useRef(null), panel = React.useRef(null);
  const id = React.useId();
  const available = !stale && (run ? !run.blocked && run.total > 0 : trajectory?.samples?.length > 1);
  const subject = run ? 'routine' : path?.id;

  // A report never carries over to a different path.
  React.useEffect(() => { setState({ report: null, error: '', pending: false }); }, [subject]);

  React.useEffect(() => {
    if (!open) return undefined;
    if (!available) {
      setState({ report: null, error: 'A current path or routine plan is needed to estimate power.', pending: false });
      return undefined;
    }
    let active = true, job;
    setState(previous => ({ ...previous, error: '', pending: true }));
    // Edits while the report is open replan often; analyze the settled plan, not every intermediate one.
    const timer = setTimeout(() => {
      job = analyze({ robot, path, trajectory, run });
      job.then(report => { if (active) setState({ report, error: '', pending: false }); },
        failure => { if (active) setState({ report: null, error: failure.message || String(failure), pending: false }); });
    }, 120);
    return () => { active = false; clearTimeout(timer); job?.cancel(); };
  }, [open, robot, path, trajectory, run, available]);

  React.useLayoutEffect(() => {
    const element = panel.current;
    const toggled = event => setOpen(event.newState === 'open');
    element.addEventListener('toggle', toggled);
    return () => element.removeEventListener('toggle', toggled);
  }, []);

  React.useLayoutEffect(() => {
    if (!open) return undefined;
    const element = panel.current;
    // Choose a side for the full report, so loading and results stay on the same side.
    const place = () => {
      const anchor = trigger.current.getBoundingClientRect();
      const below = window.innerHeight - anchor.bottom - GAP - EDGE, above = anchor.top - GAP - EDGE;
      const opensBelow = below >= MAX_HEIGHT || below >= above;
      element.style.maxHeight = Math.max(0, Math.min(MAX_HEIGHT, opensBelow ? below : above)) + 'px';
      const bounds = element.getBoundingClientRect();
      const top = opensBelow ? anchor.bottom + GAP : anchor.top - GAP - bounds.height;
      element.style.top = Math.max(EDGE, Math.min(top, window.innerHeight - bounds.height - EDGE)) + 'px';
      element.style.left = Math.max(EDGE, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - EDGE)) + 'px';
      element.dataset.positioned = '';
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    window.addEventListener('resize', place);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); delete element.dataset.positioned; };
  }, [open, state]);

  // Moving focus elsewhere closes it, so it never covers the control that takes focus next.
  const leave = event => {
    const next = event.relatedTarget;
    if (next && open && !panel.current.contains(next) && next !== trigger.current) panel.current.hidePopover();
  };
  // Escape closes only the report; it must not also reach the editor's clear-selection shortcut.
  const dismiss = event => {
    if (!open) return;
    if (event.key === 'Tab' && event.currentTarget === trigger.current) {
      panel.current.hidePopover();
      return;
    }
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation();
    panel.current.hidePopover();
    trigger.current?.focus();
  };
  return h(React.Fragment, null,
    h('button', { ref: trigger, type: 'button', className: 'qbtn quiet power-trigger', disabled: !available && !open,
      popovertarget: id, 'aria-expanded': open, 'aria-controls': id, onBlur: leave, onKeyDown: dismiss }, 'Power'),
    h('div', { ref: panel, id, className: 'power-report', popover: 'auto', role: 'region', 'aria-labelledby': id + '-title', onBlur: leave, onKeyDown: dismiss },
      open && h(PowerReportBody, { report: state.report, robot, routine: Boolean(run), error: state.error, updating: state.pending, titleId: id + '-title' })));
}
