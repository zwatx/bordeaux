import * as React from 'react';
import { commandChoices, escapeCommandTrigger } from '../lib/commandPick';
import { focusIfAvailable } from '../lib/focusReturn';
import { PathLinks } from '../lib/pathLinks';
import { PM } from '../lib/pathMath';
import { UnitPrefs, formatAngularLimit } from '../lib/unitPreferences';
import { commandArguments } from './ContextInspector';
import { commandLabel } from './PathTimeline';
import { fAtT, featureFraction, featurePositionPatch, tAtF, zoneFractions } from './pathTimelineModel';
import { plainProblem } from './planProblems';
import { UI } from './ui';
import { ProblemsMenu } from './ProblemsMenu';

// Docked properties under the field: the selection's everyday values, editable in place.
// Rarer options stay in the full inspector behind More. Labels are a word or two.

const h = React.createElement;
const { Num, DraftText, Toggle, Dropdown, Icon } = UI;
const fmt = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : '–';
const SHAPES = PM.SEGTYPES.map((type) => ({ value: type.id, label: type.label }));
const FACING = [
  { value: 'manual', label: 'Manual' },
  { value: 'tangent', label: 'Tangent' },
  { value: 'targets', label: 'Targets' },
  { value: 'lookAt', label: 'Look at' },
];

function Row({ label, children, className = '' }) {
  return h('div', { className: 'pp-row ' + className }, h('span', { className: 'pp-row-label' }, label), children);
}

function Note({ children }) {
  return h('div', { className: 'pp-note' }, children);
}

export function PathPanel({ doc, sel, derived, tl, robot, drive, project, actions, robotProject, issue, issueStale, onFixIssue, onClearIssue, onMore, moreOpen, playbackStore, problems, commandPickFor, documentKey }) {
  const heading = React.useRef(null);
  const bodyRef = React.useRef(null), live = React.useRef(null), pendingFocus = React.useRef(null);
  React.useEffect(() => () => pendingFocus.current?.(), []);
  /**
   * After a link or unlink, focus follows to the control that replaced the chosen one, in one frame scheduled before
   * the commit. It belongs to this body node, document, path, waypoint and expected link state; any focus claim in
   * between, an open modal, or focus already elsewhere declines it. Returns a cancel for a commit that changed nothing.
   */
  const focusOwned = (selector, expectLinked) => {
    pendingFocus.current?.();
    const body = bodyRef.current, from = document.activeElement, pin = live.current;
    let claimed = false;
    const claim = () => { claimed = true; };
    const done = () => { cancelAnimationFrame(frame); document.removeEventListener('focusin', claim, true); if (pendingFocus.current === done) pendingFocus.current = null; };
    document.addEventListener('focusin', claim, true);
    const frame = requestAnimationFrame(() => {
      const now = live.current, active = document.activeElement;
      done();
      if (!claimed && body?.isConnected && bodyRef.current === body && now.documentKey === pin.documentKey && now.docId === pin.docId && now.kind === 'wp'
        && now.idx === pin.idx && now.linked === expectLinked && (!active || active === document.body || active === from)
        && !document.querySelector('dialog[open],[role="dialog"][aria-modal="true"]')) focusIfAvailable(body.querySelector(selector));
    });
    pendingFocus.current = done;
    return done;
  };
  let linkedNow = null;
  const wps = doc.waypoints;
  const n = wps.length;
  const isTank = drive === 'tank';
  const headingMode = isTank ? 'tangent' : (doc.headingMode || 'targets');
  const facingOffset = doc.driveBackward ? 180 : 0;
  const limits = PM.effectiveConstraints(doc.constraints, robot);
  const name = (index) => PathLinks.waypointName(project, doc, index);
  const timeAt = (f) => tl.empty ? null : tAtF(tl, f);
  const fractionAt = (t) => fAtT(tl, t);
  // A typed time past an end, or inside a stop's wait, can leave the place unchanged; that is not an edit.
  const moveTo = (item, t, apply) => {
    const f = fractionAt(t);
    if (Math.abs(f - featureFraction(item, derived)) > 1e-6) apply(featurePositionPatch(item, f, derived));
  };
  const maxTime = tl.empty ? undefined : tl.total;
  // Linked: which other paths share this point, or one visit to link it to any point in another path.
  const linkedRow = (i) => {
    if (!project || !actions.setWaypointPositionLink) return null;
    const members = PathLinks.positionMembers(project, doc.id, i);
    linkedNow = members.length > 0;
    const link = (target) => {
      const cancel = focusOwned(target ? '[data-link-unlink]' : '#band-waypoint-link', Boolean(target));
      const status = actions.setWaypointPositionLink(i, target);
      if (status !== 'applied') cancel();
      return status;
    };
    if (linkedNow) {
      const names = [...new Set(members.map((member) => member.pathId === doc.id ? 'this path' : project.paths.find((path) => path.id === member.pathId)?.name || 'Untitled path'))];
      const full = names.join(', ');
      return h(Row, { label: 'Linked', className: 'pp-link-row' }, h('span', { className: 'pp-value-text', title: full },
        h('span', { 'aria-hidden': true }, names.length > 2 ? names.slice(0, 2).join(', ') + ', +' + (names.length - 2) : full),
        h('span', { className: 'sr-only' }, 'Linked to ' + full)),
        h('button', { type: 'button', className: 'pp-text-btn', 'data-link-unlink': true, onClick: () => link(null) }, 'Unlink'));
    }
    const choices = PathLinks.linkChoices(project, doc.id, i);
    if (!choices.length) return h(Row, { label: 'Linked' }, h('span', { className: 'pp-value-text' }, 'No other paths'));
    return h(Row, { label: 'Linked' }, h(Dropdown, { key: 'link:' + doc.id + ':' + i, id: 'band-waypoint-link', ariaLabel: 'Link to a point in another path', compact: true,
      placeholder: 'Link to…', value: '', items: choices, searchThreshold: 0, activateFirstMatch: true,
      onChoose: (value) => { const item = choices.find((choice) => choice.value === value); return item ? link({ pathId: item.pathId, index: item.index }) : 'refused'; } }));
  };
  let title = 'Path', sub = null, body = null, remove = null, removeLabel = '';

  if (issue) {
    const plain = plainProblem(issue, n);
    title = plain.text;
    const t0 = timeAt(issue.f0), t1 = timeAt(issue.f1);
    sub = issue.f1 - issue.f0 < 0.999 && t0 != null ? (t1 - t0 > 0.02 ? fmt(t0) + '–' + fmt(t1) + ' s' : fmt(t0) + ' s') : null;
    body = h('div', { className: 'pp-problem ' + (issue.severity || 'error') },
      issueStale && h('p', { className: 'pp-problem-line muted' }, 'Updating…'),
      plain.where && h('p', { className: 'pp-problem-line' }, plain.where),
      plain.values && h('p', { className: 'pp-problem-line num' }, plain.values),
      plain.by && h('p', { className: 'pp-problem-line' }, 'Limit: ' + plain.by),
      plain.fixable && onFixIssue && h('button', { type: 'button', className: 'qbtn pp-action', onClick: () => onFixIssue(issue) }, 'Slow here'),
      plain.engine && h('details', { className: 'pp-details' }, h('summary', null, 'Details'), h('p', null, plain.engine)));
  } else if (sel.kind === 'wp' && wps[sel.idx]) {
    const i = sel.idx, w = wps[i], isStart = i === 0, isEnd = i === n - 1;
    title = name(i);
    const t = timeAt(tl.wpFrac[i] ?? 0);
    sub = t != null ? fmt(t) + ' s' : null;
    const segmentMode = isTank ? 'tangent' : (wps[Math.max(0, Math.min(n - 2, i))].segmentHeadingMode || headingMode);
    const incomingMode = i > 0 ? (wps[i - 1].segmentHeadingMode || headingMode) : segmentMode;
    const continuityOwned = !isStart && !isEnd && incomingMode !== segmentMode
      && (segmentMode === 'manual' || segmentMode === 'targets') && (incomingMode === 'tangent' || incomingMode === 'lookAt');
    let heading = null;
    if (isTank) heading = null;
    else if (isStart) {
      const follows = segmentMode === 'tangent' || segmentMode === 'lookAt';
      const planned = derived.metrics?.head?.[0], tangent = derived.sample?.pts?.[0]?.heading;
      const degrees = follows && Number.isFinite(planned) ? planned * 180 / Math.PI : follows && Number.isFinite(tangent) ? tangent * 180 / Math.PI : w.theta || 0;
      heading = h(Num, { label: 'Facing', value: degrees + facingOffset, unit: '°', step: 1, precision: 1, onChange: (v) => actions.setWp(0, { theta: v - facingOffset, thetaOn: true }) });
    } else if (continuityOwned || segmentMode === 'tangent' || segmentMode === 'lookAt') {
      heading = h(Row, { label: 'Heading' }, h('span', { className: 'pp-value-text' }, segmentMode === 'lookAt' ? 'Faces a point' : 'Follows path'));
    } else if (isEnd) {
      heading = h(Num, { label: 'Facing', value: (w.theta || 0) + facingOffset, unit: '°', step: 1, precision: 1, onChange: (v) => actions.setWp(i, { theta: v - facingOffset }) });
    } else if (w.thetaOn) {
      heading = h('div', { className: 'pp-num-with-action' },
        h(Num, { label: 'Heading', value: w.theta || 0, unit: '°', step: 1, precision: 1, onChange: (v) => actions.setWp(i, { theta: v }) }),
        h('button', { type: 'button', className: 'pp-mini', 'aria-label': 'Free heading', title: 'Free heading', onClick: () => actions.toggleTheta(i, false) }, h(Icon, { name: 'x', size: 12 })));
    } else {
      heading = h(Row, { label: 'Heading' }, h('button', { type: 'button', className: 'pp-text-btn', 'aria-label': 'Set heading here', onClick: () => actions.toggleTheta(i, true) }, 'Free'));
    }
    body = h(React.Fragment, null,
      h(Row, { label: isStart ? 'Start stopped' : isEnd ? 'End stopped' : 'Stop here' },
        h(Toggle, { on: Boolean(w.stop), ariaLabel: isStart ? 'Stop at entry' : isEnd ? 'Stop at exit' : 'Stop at waypoint', onChange: (v) => actions.setStop(i, v) })),
      w.stop && !isStart && h(Num, { label: 'Wait', value: w.wait || 0, unit: 's', step: 0.1, precision: 1, min: 0, max: 15, onChange: (v) => actions.setWait(i, v) }),
      (isStart || isEnd) && !w.stop && h(Num, { label: isStart ? 'Entry speed' : 'Exit speed', value: (isStart ? doc.startVel : doc.goalVel) || 0, unit: 'm/s', min: 0, max: limits.maxVel,
        onChange: (v) => actions.setDoc(isStart ? { startVel: v } : { goalVel: v }) }),
      heading,
      h(Num, { label: 'X', value: w.x, unit: 'm', onChange: (v) => actions.setWp(i, { x: v }) }),
      h(Num, { label: 'Y', value: w.y, unit: 'm', onChange: (v) => actions.setWp(i, { y: v }) }),
      linkedRow(i));
    if (n > 2) { remove = () => actions.delWp(i); removeLabel = 'Delete waypoint'; }
  } else if (sel.kind === 'seg' && wps[sel.idx] && wps[sel.idx + 1]) {
    const i = sel.idx;
    title = name(i) + ' → ' + name(i + 1);
    const t0 = timeAt(tl.wpFrac[i] ?? 0), t1 = timeAt(tl.wpFrac[i + 1] ?? 1);
    sub = t0 != null ? fmt(t1 - t0) + ' s' : null;
    const shape = ['line', 'arc', 'clothoid'].includes(wps[i].segType) ? wps[i].segType : 'bezier';
    body = h(React.Fragment, null,
      h(Row, { label: 'Shape' }, h(Dropdown, { id: 'band-segment-shape', ariaLabel: 'Segment shape', compact: true, value: shape, items: SHAPES, onChange: (v) => actions.setSegMeta(i, { segType: v }) })),
      !isTank && h(Row, { label: 'Facing' }, h(Dropdown, { id: 'band-segment-facing', ariaLabel: 'Facing on this segment', compact: true, value: wps[i].segmentHeadingMode || headingMode, items: FACING, onChange: (v) => actions.setSegmentHeadingMode(i, v) })),
      h('div', { className: 'pp-actions' }, h('button', { type: 'button', className: 'qbtn pp-action', onClick: () => actions.insertWp(i) }, h(Icon, { name: 'plus', size: 13 }), 'Insert waypoint')));
  } else if (sel.kind === 'rt' && doc.targets?.[sel.idx]) {
    const i = sel.idx, target = doc.targets[i];
    const f = featureFraction(target, derived), t = timeAt(f);
    title = 'Rotation target';
    sub = t != null ? fmt(t) + ' s' : null;
    let segment = 0;
    (tl.wpFrac || []).forEach((value, k) => { if (k < n - 1 && f >= value - 1e-6) segment = k; });
    const inactive = !isTank && (wps[segment]?.segmentHeadingMode || headingMode) !== 'targets';
    body = h(React.Fragment, null,
      inactive && h(Row, { label: 'Inactive here', className: 'warn' }, h('button', { type: 'button', className: 'pp-text-btn', onClick: () => actions.setSegmentHeadingMode(segment, 'targets') }, 'Use targets')),
      h(Num, { label: 'Heading', value: target.deg, unit: '°', step: 1, precision: 1, onChange: (v) => actions.setTarget(i, { deg: v }) }),
      t != null && h(Num, { label: 'At', value: t, unit: 's', step: 0.05, precision: 2, min: 0, max: maxTime, onChange: (v) => moveTo(target, v, (patch) => actions.setTarget(i, patch)) }));
    remove = () => actions.delTarget(i); removeLabel = 'Delete target';
  } else if (sel.kind === 'em' && doc.markers?.[sel.idx]) {
    const i = sel.idx, marker = doc.markers[i];
    const catalog = robotProject?.catalog;
    const commands = catalog?.commands || [];
    const invocationId = marker.invocation?.commandId || (marker.cmd && marker.cmd !== 'none' ? marker.cmd : '');
    const selected = commands.find((command) => command.id === invocationId);
    const inputs = selected ? (selected.parameters || []).filter((parameter) => parameter.role === 'argument').length : 0;
    const timed = derived?.markers?.find?.((item) => item.id === marker.id);
    const t = timed && Number.isFinite(timed.timeS) ? timed.timeS : timeAt(featureFraction(marker, derived));
    title = commandLabel(marker, catalog);
    sub = t != null ? fmt(t) + ' s' : null;
    body = h(React.Fragment, null,
      catalog
        // The second Escape, from the closed trigger, clears the selection and leaves focus on this command's chip.
        ? h('div', { className: 'pp-full', onKeyDown: (event) => escapeCommandTrigger(event, actions.escapeSelection,
            () => [event.currentTarget.closest('.path-band')?.querySelector('.pt-chip[data-selection="em:' + i + '"]'), heading.current]) },
          // Keyed by the marker, so a reused index never inherits an open search; placement opens it once at mount.
          h(Dropdown, { key: 'command:' + (marker.id || doc.id + ':' + i), id: 'band-command', ariaLabel: 'Command', value: invocationId, items: commandChoices(commands, invocationId),
            icon: 'bolt', placeholder: 'No command', searchThreshold: 0, activateFirstMatch: true, defaultOpen: commandPickFor != null && commandPickFor === marker.id,
            disabled: robotProject.status === 'loading',
            onChange: (commandId) => {
              const command = commands.find((candidate) => candidate.id === commandId);
              const tag = marker.actionIntent?.semanticTag;
              actions.setMarker(i, {
                cmd: command ? command.id : 'none',
                invocation: command ? { commandId: command.id, arguments: commandArguments(command) } : undefined,
                actionIntent: command && tag && (command.semanticTags || []).includes(tag) ? undefined : marker.actionIntent,
              });
            } }))
        : h(Row, { label: 'Command' }, h('button', { type: 'button', className: 'pp-text-btn', disabled: !robotProject?.link || robotProject.status === 'loading', onClick: () => robotProject.link() },
            robotProject?.status === 'loading' ? 'Loading…' : 'Link robot code…')),
      inputs > 0 && h(Row, { label: inputs === 1 ? '1 input' : inputs + ' inputs' }, h('button', { type: 'button', className: 'pp-text-btn', onClick: onMore }, 'Edit')),
      h('div', { className: 'pp-row pp-text-row' },
        h('label', { className: 'pp-row-label', htmlFor: 'band-marker-name' }, 'Name'),
        h(DraftText, { id: 'band-marker-name', className: 'pp-text', value: marker.name, owner: doc.id + ':' + (marker.id || i), autoComplete: 'off', spellCheck: false, onCommit: (value) => actions.setMarker(i, { name: value }) })),
      t != null && h(Num, { label: 'At', value: t, unit: 's', step: 0.05, precision: 2, min: 0, max: maxTime, onChange: (v) => moveTo(marker, v, (patch) => actions.setMarker(i, patch)) }));
    remove = () => actions.delMarker(i); removeLabel = 'Delete command';
  } else if (sel.kind === 'cr' && doc.ranges?.[sel.idx]) {
    const i = sel.idx, range = doc.ranges[i];
    const span = zoneFractions(doc, derived)[i] || { f0: range.f0 || 0, f1: range.f1 || 0 };
    const f0 = Math.min(span.f0, span.f1), f1 = Math.max(span.f0, span.f1);
    // From is the earlier end whichever authored end that is; each stays on its side of the other.
    const [startEnd, endEnd] = span.f0 <= span.f1 ? [0, 1] : [1, 0];
    const setEnd = (which, f, current) => { if (Math.abs(f - current) > 1e-6) actions.setRangeEnd(i, which, f); };
    const t0 = timeAt(f0), t1 = timeAt(f1);
    title = range.name || 'Zone';
    sub = t0 != null ? fmt(t0) + '–' + fmt(t1) + ' s' : null;
    const others = ['maxAccel', 'maxAngVel', 'maxAngAccel'].filter((key) => range[key] != null).length;
    body = h(React.Fragment, null,
      h('div', { className: 'pp-row pp-text-row' },
        h('label', { className: 'pp-row-label', htmlFor: 'band-zone-name' }, 'Name'),
        h(DraftText, { id: 'band-zone-name', className: 'pp-text', value: range.name || '', placeholder: 'Zone', owner: doc.id + ':' + i, autoComplete: 'off', spellCheck: false, onCommit: (value) => actions.setRange(i, { name: value }) })),
      range.maxVel != null
        ? h('div', { className: 'pp-num-with-action' },
            h(Num, { label: 'Speed', value: range.maxVel, unit: 'm/s', min: 0.01, max: Math.max(limits.maxVel, range.maxVel), onChange: (v) => actions.setRange(i, { maxVel: v }) }),
            h('button', { type: 'button', className: 'pp-mini', 'aria-label': 'Remove speed limit', title: 'Remove speed limit', onClick: () => actions.setRange(i, { maxVel: undefined }) }, h(Icon, { name: 'x', size: 12 })))
        : h(Row, { label: 'Speed' }, h('button', { type: 'button', className: 'pp-text-btn', onClick: () => actions.setRange(i, { maxVel: limits.maxVel }) }, 'Path limit')),
      t0 != null && h(Num, { label: 'From', value: t0, unit: 's', step: 0.05, precision: 2, min: 0, max: maxTime, onChange: (v) => setEnd(startEnd, Math.min(fractionAt(v), f1), f0) }),
      t1 != null && h(Num, { label: 'To', value: t1, unit: 's', step: 0.05, precision: 2, min: 0, max: maxTime, onChange: (v) => setEnd(endEnd, Math.max(fractionAt(v), f0), f1) }),
      others > 0 && h(Row, { label: others === 1 ? '1 more limit' : others + ' more limits' }, h('button', { type: 'button', className: 'pp-text-btn', onClick: onMore }, 'Edit')));
    remove = () => actions.delRange(i); removeLabel = 'Delete zone';
  } else {
    title = 'Path';
    const length = derived?.totalDistance || derived?.sample?.length || 0;
    sub = length > 0 ? UnitPrefs.format(length, 'm', 2) : null;
    const startStopped = Boolean(wps[0]?.stop), endStopped = Boolean(wps[n - 1]?.stop);
    body = h(React.Fragment, null,
      h('div', { className: 'pp-row pp-text-row' },
        h('label', { className: 'pp-row-label', htmlFor: 'band-path-name' }, 'Name'),
        h(DraftText, { id: 'band-path-name', className: 'pp-text', value: doc.name, owner: doc.id, autoComplete: 'off', spellCheck: false,
          onCommit: (value) => { const clean = value.trim(); if (clean && clean !== doc.name) actions.renamePath(clean); } })),
      h(Num, { label: 'Corner accel', value: doc.constraints.maxCentripetalAccel ?? doc.constraints.maxAccel, unit: 'm/s²', min: 0.1, onChange: (v) => actions.setConstraint({ maxCentripetalAccel: v }) }),
      h(Num, { label: 'Turn speed', value: doc.constraints.maxAngVel, unit: '°/s', step: 1, format: formatAngularLimit, min: 1, onChange: (v) => actions.setConstraint({ maxAngVel: v }) }),
      startStopped ? h(Row, { label: 'Entry speed' }, h('button', { type: 'button', className: 'pp-text-btn', onClick: () => actions.select('wp', 0) }, 'Stopped'))
        : h(Num, { label: 'Entry speed', value: doc.startVel || 0, unit: 'm/s', min: 0, max: limits.maxVel, onChange: (v) => actions.setDoc({ startVel: v }) }),
      endStopped ? h(Row, { label: 'Exit speed' }, h('button', { type: 'button', className: 'pp-text-btn', onClick: () => actions.select('wp', n - 1) }, 'Stopped'))
        : h(Num, { label: 'Exit speed', value: doc.goalVel || 0, unit: 'm/s', min: 0, max: limits.maxVel, onChange: (v) => actions.setDoc({ goalVel: v }) }),
      h('div', { className: 'pp-actions' },
        h('button', { type: 'button', className: 'qbtn pp-action', onClick: () => actions.addRangeAt(tl.empty ? 0.5 : fractionAt(playbackStore.getSnapshot().time)) }, h(Icon, { name: 'plus', size: 13 }), 'Add zone')));
  }

  live.current = { documentKey, docId: doc.id, kind: issue ? null : sel.kind, idx: sel.idx, linked: linkedNow };
  const selected = Boolean(sel.kind) || Boolean(issue);
  return h('aside', { className: 'pp', 'aria-label': 'Properties' },
    h('div', { ref: heading, className: 'pp-head', tabIndex: -1 },
      h('div', { className: 'pp-heading' },
        h('span', { className: 'pp-title', title }, title),
        sub && h('span', { className: 'pp-sub' }, sub)),
      h('span', { className: 'pp-head-actions' },
        !issue && h('button', { type: 'button', className: 'pp-more', 'aria-expanded': Boolean(moreOpen), onClick: onMore }, 'More'),
        selected && h('button', { type: 'button', className: 'pp-mini', 'aria-label': 'Clear selection', title: 'Clear selection  (Esc)', onClick: () => (issue && onClearIssue ? onClearIssue() : actions.select(null, -1)) }, h(Icon, { name: 'x', size: 12 })))),
    problems && h(ProblemsMenu, { problems, waypointCount: n, heading }),
    // Keyed by the edited object, so a draft never carries over to another item or path.
    h('div', { ref: bodyRef, className: 'pp-body', key: doc.id + ':' + (issue ? 'issue' : (sel.kind || 'path') + ':' + sel.idx) }, body),
    remove && h('div', { className: 'pp-foot' }, h('button', { type: 'button', className: 'delbtn pp-delete', onClick: remove }, h(Icon, { name: 'trash', size: 14 }), removeLabel)));
}
