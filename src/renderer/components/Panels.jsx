import { KeyboardHelp } from './KeyboardHelp';
import * as React from "react";
import { PM } from "../lib/pathMath";
import { UnitPrefs } from "../lib/unitPreferences";
import { shortcutLabel } from "../lib/shortcuts";
import { UI } from "./ui";

  const h = React.createElement;
  const { Icon, IconBtn, Dropdown } = UI;
  const R2D = 180 / Math.PI;

  // A project has three places. They are plain text; the current one is at full strength with a neutral rule.
  const PLACES = [{ id: 'paths', label: 'Paths' }, { id: 'routines', label: 'Routines' }, { id: 'settings', label: 'Settings' }];
  export const placeOf = (page) => page === 'robot' ? 'settings' : page === 'auto' ? 'routines' : 'paths';

  // One bar, read left to right: the project, its places, the current place's actions, then the robot (Push).
  function Toolbar(props) {
    const { page, onPlace, onUndo, onRedo, optimizationOpen, toggleOptimization, optimizationApplied } = props;
    const plan = page === 'plan', current = placeOf(page);
    return h('header', { className: 'toolbar' },
      // App owns the project chip and its flows. The slot has a fixed width, so status changes never move the places.
      h('div', { className: 'tb-project' }, props.project),
      h('nav', { className: 'places', 'aria-label': 'Project sections' }, PLACES.map((place) => h('button', { key: place.id, type: 'button', className: 'place',
        'aria-current': current === place.id ? 'page' : undefined, onClick: () => onPlace?.(place.id) }, place.label))),
      h('div', { className: 'tb-spacer' }),
      h('div', { className: 'tb-actions' },
        plan && h('button', { type: 'button', className: 'tb-text optimizer-toggle', 'aria-expanded': optimizationOpen, onClick: toggleOptimization }, optimizationApplied ? 'Optimized' : 'Optimize'),
        (plan || page === 'auto') && h(IconBtn, { icon: 'undo', onClick: onUndo, disabled: !props.canUndo, label: 'Undo', title: 'Undo (' + shortcutLabel('Z') + ')' }),
        (plan || page === 'auto') && h(IconBtn, { icon: 'redo', onClick: onRedo, disabled: !props.canRedo, label: 'Redo', title: 'Redo (' + shortcutLabel('Z', { shift: true }) + ')' })),
      props.push && h('div', { className: 'tb-push' }, props.push),
      h(UpdateChip, { state: props.updateState, onOpen: props.onOpenUpdates, onInstall: props.onInstallUpdate }),
      h(KeyboardHelp));
  }

  // Update status lives quietly in the toolbar instead of interrupting work with a dialog.
  // A ready update restarts in one click; every other state opens the update panel.
  function UpdateChip({ state, onOpen, onInstall }) {
    const phase = state?.phase;
    const percent = Number.isFinite(state?.progress?.percent) ? Math.round(state.progress.percent) : null;
    const label = phase === 'available' ? 'Update available'
      : phase === 'downloading' ? 'Downloading' + (percent == null ? '…' : ' ' + percent + '%')
      : phase === 'downloaded' ? 'Restart to update'
      : phase === 'installing' ? 'Restarting…'
      : phase === 'error' && state.version ? 'Update failed' : null;
    if (!label) return null;
    const ready = phase === 'downloaded';
    return h('button', { type: 'button', className: 'update-chip ' + phase, onClick: ready ? onInstall : onOpen,
      title: ready ? 'Restart Bordeaux and install ' + state.version : 'Bordeaux ' + (state.version || 'update') },
      h('span', { className: 'update-chip-dot', 'aria-hidden': true }), label);
  }

  const TOOLS = [
    { id: 'select', icon: 'select', label: 'Select / move', key: '1', alternateKey: 'V' },
    { id: 'waypoint', icon: 'waypoint', label: 'Place waypoint', key: '2', alternateKey: 'W' },
    { id: 'rotation', icon: 'rotation', label: 'Rotation target', key: '3', alternateKey: 'R' },
    { id: 'marker', icon: 'flag2', label: 'Place command', key: '4', alternateKey: 'M' },
    { id: 'range', icon: 'gauge', label: 'Zone', key: '5', alternateKey: 'C' },
  ];
  function ToolRail({ tool, setTool }) {
    return h('div', { className: 'toolrail' }, TOOLS.map((t) =>
      h('button', { key: t.id, className: 'toolrail-b' + (tool === t.id ? ' on' : ''), type: 'button', 'aria-label': t.label, 'aria-pressed': tool === t.id, title: t.label + '  (' + t.key + ' or ' + t.alternateKey + ')', onClick: () => setTool(t.id) },
        h(Icon, { name: t.icon, size: 18 }), h('span', { className: 'toolrail-k' }, t.key))));
  }

  function MetricControl({ metric, setMetric, derived }) {
    const M = derived.metrics || {};
    const grad = PM.metricGradient(metric);
    const def = (PM.METRICS || []).find((m) => m.id === metric) || {};
    let lo = '0', hi = '0';
    const displayUnit = def.unit || '';
    if (metric === 'velocity') { lo = '0'; hi = UnitPrefs.fromCanonical(M.vMax || 0, displayUnit).toFixed(1); }
    else if (metric === 'accel') { const a = UnitPrefs.fromCanonical(M.aMax || 0, displayUnit).toFixed(1); lo = '-' + a; hi = '+' + a; }
    else if (metric === 'angvel') { const w = ((M.wMax || 0) * R2D).toFixed(0); lo = '-' + w; hi = '+' + w; }
    else { lo = '0'; hi = UnitPrefs.fromCanonical(M.kMax || 0, displayUnit).toFixed(2); }
    return h('div', { className: 'metricctl' },
      h(Dropdown, { id: 'field-overlay-metric', ariaLabel: 'Field overlay metric', compact: true,
        className: 'metric-dropdown', value: metric,
        items: (PM.METRICS || []).map((m) => ({ value: m.id, label: m.label, meta: UnitPrefs.label(m.unit || '') })),
        onChange: setMetric }),
      h('span', { className: 'metric-swatch', style: { background: grad }, 'aria-hidden': true }),
      h('span', { className: 'metric-range', 'aria-hidden': true }, lo + '\u2013' + hi + ' ' + UnitPrefs.label(displayUnit)));
  }

  function ViewControls({ zoomPct, zoomBy, onFit, showGrid, setShowGrid, graphOpen, alliance, setAlliance, fieldFocus, toggleFieldFocus }) {
    return h('div', { className: 'viewctl' + (graphOpen ? ' graph-open' : '') },
      toggleFieldFocus && h('button', { className: 'vc-text field-focus', type: 'button', 'aria-pressed': fieldFocus,
        onClick: toggleFieldFocus, title: 'Hide or show the path list  (\\)' }, 'Focus'),
      toggleFieldFocus && h('div', { className: 'vc-div' }),
      // Flipping is a view of the field, so it sits with zoom and grid. The path itself never changes.
      setAlliance && h('button', { className: 'vc-text field-flip', type: 'button', 'aria-pressed': alliance === 'red', onClick: () => setAlliance(alliance === 'blue' ? 'red' : 'blue'),
        title: 'Flip the field 180° without changing the path', 'aria-label': 'Flip field 180 degrees' }, 'Flip'),
      setAlliance && h('div', { className: 'vc-div' }),
      h('button', { className: 'vc-btn', type: 'button', title: 'Zoom out', 'aria-label': 'Zoom out', onClick: () => zoomBy(1.18) }, h(Icon, { name: 'zoomout', size: 16 })),
      h('button', { className: 'vc-pct', type: 'button', title: 'Fit field  (F)', onClick: onFit }, zoomPct + '%'),
      h('button', { className: 'vc-btn', type: 'button', title: 'Zoom in', 'aria-label': 'Zoom in', onClick: () => zoomBy(1 / 1.18) }, h(Icon, { name: 'zoomin', size: 16 })),
      h('div', { className: 'vc-div' }),
      h('button', { className: 'vc-btn' + (showGrid ? ' active' : ''), type: 'button', title: 'Toggle field grid  (G)', 'aria-label': 'Toggle field grid', 'aria-pressed': showGrid, onClick: () => setShowGrid(!showGrid) }, h(Icon, { name: 'grid', size: 16 })),
      h('button', { className: 'vc-btn', type: 'button', title: 'Fit field  (F)', 'aria-label': 'Fit field to view', onClick: onFit }, h(Icon, { name: 'fit', size: 16 })));
  }

export const Panels = { Toolbar, ToolRail, MetricControl, ViewControls };
