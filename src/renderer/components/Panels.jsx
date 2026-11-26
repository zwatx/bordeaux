import { KeyboardHelp } from './KeyboardHelp';
import * as React from "react";
import { PM } from "../lib/pathMath";
import { UnitPrefs } from "../lib/unitPreferences";
import { keyLabel, keyLabels, useKeyRules } from "../lib/keyBindings";
import { UI } from "./ui";
import { deletionInput } from "./DeletionNotice";

  const h = React.createElement;
  const { Icon, IconBtn, Dropdown } = UI;
  const R2D = 180 / Math.PI;

  // A project has three places. They are plain text; the current one is at full strength with a neutral rule.
  const PLACES = [{ id: 'paths', label: 'Paths' }, { id: 'routines', label: 'Routines' }, { id: 'robot', label: 'Robot' }];
  export const placeOf = (page) => page === 'robot' ? 'robot' : page === 'auto' ? 'routines' : 'paths';

  // One bar, read left to right: the project, its places, the current place's actions, the robot (Push), then app-wide
  // controls: updates, global settings (the gear) and shortcuts.
  function Toolbar(props) {
    useKeyRules();
    const { page, onPlace, onUndo, onRedo, optimizationOpen, toggleOptimization, optimizationApplied } = props;
    const plan = page === 'plan', current = placeOf(page);
    return h('header', { className: 'toolbar' },
      // App owns the project chip and its flows. The slot has a fixed width, so status changes never move the places.
      h('div', { className: 'tb-project' }, props.project),
      h('nav', { className: 'places', style: { '--place-index': PLACES.findIndex(place => place.id === current) }, 'aria-label': 'Project sections' }, PLACES.map((place) => h('button', { key: place.id, type: 'button', className: 'place',
        'aria-current': current === place.id ? 'page' : undefined, onClick: () => onPlace?.(place.id) }, place.label))),
      h('div', { className: 'tb-spacer' }),
      h('div', { className: 'tb-actions' },
        plan && h('button', { type: 'button', className: 'tb-text optimizer-toggle', 'aria-expanded': optimizationOpen, onClick: toggleOptimization }, optimizationApplied ? 'Optimized' : 'Optimize'),
        (plan || page === 'auto') && h(IconBtn, { icon: 'undo', onClick: onUndo, disabled: !props.canUndo, label: 'Undo', title: withKey('Undo', 'edit.undo') }),
        (plan || page === 'auto') && h(IconBtn, { icon: 'redo', onClick: onRedo, disabled: !props.canRedo, label: 'Redo', title: withKey('Redo', 'edit.redo', true) })),
      props.push && h('div', { className: 'tb-push' }, props.push),
      h(UpdateButton, { state: props.updateState, onOpen: props.onOpenUpdates, onInstall: props.onInstallUpdate, onCheck: props.onCheckUpdates }),
      props.appSettings,
      h(KeyboardHelp));
  }

  // Update status is one round icon in the toolbar: check, download, progress, then restart. A ready update opens the
  // restart confirmation; an offered or failed one opens the update notes; otherwise it checks for updates.
  const RING = 2 * Math.PI * 14;
  function UpdateButton({ state, onOpen, onInstall, onCheck }) {
    const phase = state?.phase;
    if (!phase || phase === 'unsupported') return null;
    const version = state.version, failed = phase === 'error' && version ? state.errorStage : null;
    const stalled = phase === 'installing' && state.installStalled;
    const percent = Number.isFinite(state.progress?.percent) ? Math.min(100, Math.max(0, Math.floor(state.progress.percent))) : null;
    const kind = phase === 'downloading' ? 'downloading'
      : phase === 'downloaded' || phase === 'installing' || failed === 'install' ? 'ready'
      : phase === 'available' || failed === 'download' ? 'available' : 'idle';
    const label = phase === 'checking' ? 'Checking for updates…'
      : phase === 'available' ? `Update ${version} ready to download`
      : phase === 'downloading' ? 'Downloading update' + (percent == null ? '' : ` (${percent}%)`)
      : phase === 'downloaded' ? `Update ${version} downloaded. Click to restart and install.`
      : stalled ? 'Restart delayed. Click for options.'
      : phase === 'installing' ? 'Restarting to install…'
      : failed === 'download' ? `Download failed for ${version}. Click for details.`
      : failed === 'install' ? `Install failed for ${version}. Click to retry.`
      : 'Check for updates';
    const busy = phase === 'checking' || phase === 'installing' && !stalled;
    // A failed or delayed step trades the check badge for a red dot.
    const glyph = kind === 'ready' ? h('span', { className: 'update-glyph' }, h(Icon, { name: 'rotatecw', size: 16 }),
        failed || stalled ? h('span', { className: 'update-dot' }) : h('span', { className: 'update-badge' }, h(Icon, { name: 'check', size: 8, sw: 3.5 })))
      : kind === 'available' ? h('span', { className: 'update-glyph' }, h(Icon, { name: 'download', size: 16 }), h('span', { className: 'update-dot' }))
      : kind === 'downloading' ? [h('svg', { key: 'ring', className: 'update-ring', viewBox: '0 0 32 32', 'aria-hidden': true },
          h('circle', { className: 'track', cx: 16, cy: 16, r: 14 }),
          h('circle', { className: 'bar', cx: 16, cy: 16, r: 14, strokeDasharray: RING, strokeDashoffset: RING * (1 - (percent || 0) / 100) })),
        h(Icon, { key: 'icon', name: 'download', size: 16 })]
      : h(Icon, { name: 'refreshcw', size: 16 });
    return h('button', { type: 'button', className: 'update-button ' + kind + (phase === 'checking' ? ' checking' : '') + (failed || stalled ? ' failed' : ''),
      title: label, 'aria-label': label, 'aria-disabled': busy || undefined,
      onClick: busy ? undefined : stalled ? onOpen : kind === 'ready' ? onInstall : kind === 'idle' ? onCheck : onOpen }, glyph);
  }

  /** A tooltip with the command's keys, such as "Fit field  (F)", or just the text when the command has no key. */
  function withKey(text, command, firstOnly = false) {
    const keys = firstOnly ? keyLabel(command) : keyLabels(command).join(' or ');
    return keys ? text + '  (' + keys + ')' : text;
  }

  const TOOLS = [
    { id: 'select', icon: 'select', label: 'Select / move', command: 'tool.select' },
    { id: 'waypoint', icon: 'waypoint', label: 'Place waypoint', command: 'tool.waypoint' },
    { id: 'rotation', icon: 'rotation', label: 'Rotation target', command: 'tool.rotation' },
    { id: 'marker', icon: 'flag2', label: 'Place command', command: 'tool.command' },
    { id: 'range', icon: 'gauge', label: 'Zone', command: 'tool.zone' },
  ];
  function ToolRail({ tool, setTool }) {
    useKeyRules();
    return h('div', { className: 'toolrail' }, TOOLS.map((t) =>
      h('button', { key: t.id, className: 'toolrail-b' + (tool === t.id ? ' on' : ''), type: 'button', 'aria-label': t.label, 'aria-pressed': tool === t.id, title: withKey(t.label, t.command), onClick: () => setTool(t.id) },
        h(Icon, { name: t.icon, size: 18 }), h('span', { className: 'toolrail-k' }, keyLabel(t.command)))));
  }

  function MetricControl({ metric, setMetric, derived, robot }) {
    const M = derived.metrics || {};
    const grad = PM.metricGradient(metric);
    const def = (PM.METRICS || []).find((m) => m.id === metric) || {};
    let lo = '0', hi = '0';
    const displayUnit = def.unit || '';
    if (metric === 'velocity') { lo = '0'; hi = UnitPrefs.fromCanonical(Math.max(0.1, robot?.maxSpeed || M.vMax || 0), displayUnit).toFixed(1); }
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

  // Hiding the path list lives on the library's own header (and its key); the restore strip brings it back.
  function ViewControls({ zoomPct, zoomBy, onFit, showGrid, setShowGrid, graphOpen, onFlip, flipDisabled }) {
    useKeyRules();
    return h('div', { className: 'viewctl' + (graphOpen ? ' graph-open' : '') },
      onFlip && h('button', { className: 'vc-text field-flip', type: 'button', disabled: flipDisabled, ...deletionInput(onFlip),
        title: 'Mirror or rotate this path', 'aria-label': 'Flip path', 'aria-haspopup': 'dialog' }, 'Flip'),
      onFlip && h('div', { className: 'vc-div' }),
      h('button', { className: 'vc-btn', type: 'button', title: 'Zoom out', 'aria-label': 'Zoom out', onClick: () => zoomBy(1.18) }, h(Icon, { name: 'zoomout', size: 16 })),
      h('button', { className: 'vc-pct', type: 'button', title: withKey('Fit field', 'view.fit'), onClick: onFit }, zoomPct + '%'),
      h('button', { className: 'vc-btn', type: 'button', title: 'Zoom in', 'aria-label': 'Zoom in', onClick: () => zoomBy(1 / 1.18) }, h(Icon, { name: 'zoomin', size: 16 })),
      h('div', { className: 'vc-div' }),
      h('button', { className: 'vc-btn' + (showGrid ? ' active' : ''), type: 'button', title: withKey('Toggle field grid', 'view.grid'), 'aria-label': 'Toggle field grid', 'aria-pressed': showGrid, onClick: () => setShowGrid(!showGrid) }, h(Icon, { name: 'grid', size: 16 })),
      h('button', { className: 'vc-btn', type: 'button', title: withKey('Fit field', 'view.fit'), 'aria-label': 'Fit field to view', onClick: onFit }, h(Icon, { name: 'fit', size: 16 })));
  }

export const Panels = { Toolbar, ToolRail, MetricControl, ViewControls };
