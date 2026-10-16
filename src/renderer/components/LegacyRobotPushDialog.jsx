import * as React from 'react';
export { useLegacyRobotPushController as useRobotPushController } from './useLegacyRobotPushController';

const h = React.createElement;
const shortHash = (value) => !value ? 'None' : value.length > 28 ? value.slice(0, 18) + '…' + value.slice(-8) : value;
const detail = (label, value) => h('div', { key: label }, h('dt', null, label), h('dd', null, value));
const action = (label, onClick, props = {}) => h('button', { type: 'button', onClick, ...props }, label);
const names = (items) => items?.length ? items.join(', ') : 'None';

export function LegacyRobotPushDialog({ controller: c, onExportBdx }) {
  const dialog = React.useRef(null);
  React.useEffect(() => {
    const element = dialog.current;
    if (c.open && !element.open) element.showModal();
    else if (!c.open && element.open) element.close();
  }, [c.open]);
  if (c.phase === 'unavailable') return h('dialog', {
    ref: dialog, className: 'robot-push-dialog robot-manager', 'aria-labelledby': 'robot-push-title',
    onCancel: (event) => { event.preventDefault(); c.close(); },
  }, h('header', null, h('h2', { id: 'robot-push-title' }, 'Robot delivery unavailable'),
    action('×', c.close, { className: 'robot-push-close', 'aria-label': 'Close robot delivery' })),
    h('section', { className: 'robot-push-section' }, h('p', null, c.unavailable?.reason || 'A compatible LabVIEW receiver is needed before sending files.'),
      h('div', { className: 'robot-push-actions' }, action('Close', c.close),
        c.unavailable?.pathId && onExportBdx && action('Export path as BDX', () => { c.close(); onExportBdx(c.unavailable.pathId); }, { className: 'primary' }))));
  const summary = c.preview?.summary;
  const review = c.phase === 'review' && c.preview;
  const retentionReview = c.phase === 'retention-review' && c.retentionPreview;
  const preparing = ['preparing', 'retention-preparing'].includes(c.phase);
  const sending = ['uploading', 'uploaded', 'staged'].includes(c.phase) && !c.result;
  const outcome = Boolean(c.result) || ['failed', 'cancelled'].includes(c.phase);
  const title = review ? (summary?.kind === 'project' ? 'Replace robot content' : 'Review push')
    : retentionReview ? (c.retentionPreview.action === 'pin' ? 'Pin revision' : 'Review rollback')
    : preparing ? 'Preparing update' : sending ? 'Sending update' : outcome ? 'Robot update' : 'Robot connection';
  const reviewingIdentity = ['pair-review', 'pairing'].includes(c.phase);
  const accepted = c.phase === 'active' || c.phase === 'pinned';

  const connection = !c.pairing && !reviewingIdentity && !preparing && !sending && !outcome && h('section', { className: 'robot-push-section' },
    h('p', null, 'Connect over USB, Ethernet, or a network where the robot exposes SSH. Saving your project never sends robot data.'),
    h('div', { className: 'robot-push-endpoint' },
      h('label', null, 'Robot host', h('input', { value: c.host, placeholder: 'roborio-2468-frc.local', autoComplete: 'off', spellCheck: false, onChange: (event) => c.setHost(event.target.value) })),
      h('label', null, 'Port', h('input', { value: c.port, inputMode: 'numeric', onChange: (event) => c.setPort(event.target.value) }))),
    h('div', { className: 'robot-push-actions' }, action(c.phase === 'probing' ? 'Connecting…' : 'Connect', c.probeRobot, { className: 'primary', disabled: c.busy || !c.host.trim() })));

  const pairingReview = c.probe && reviewingIdentity && h('section', { className: 'robot-push-section', 'aria-busy': c.phase === 'pairing' },
    h('h3', null, 'Verify robot identity'), h('p', null, 'Confirm these identities against the robot you intend to trust.'),
    h('dl', { className: 'robot-push-details compact' }, detail('Team', c.probe.status.teamNumber), detail('SSH host key', c.probe.hostKeyFingerprint), detail('Runtime', c.probe.status.runtimeId)),
    h('div', { className: 'robot-push-actions' }, action('Back', c.chooseAnotherRobot, { disabled: c.busy }), action(c.phase === 'pairing' ? 'Pairing…' : 'Trust and pair', c.confirmPairing, { className: 'primary', disabled: c.busy })));

  const history = c.pairing && !c.preview && !c.retentionPreview && !preparing && !sending && !outcome && h('section', { className: 'robot-push-section' },
    h('dl', { className: 'robot-push-details compact' }, detail('Robot', 'Team ' + c.pairing.teamNumber), detail('Address', c.pairing.endpoint.host + ':' + c.pairing.endpoint.port),
      detail('Last checked', c.inspection?.verifiedAt ? new Date(c.inspection.verifiedAt).toLocaleTimeString() : 'Not checked'),
      detail('Active revision', c.status ? shortHash(c.status.activeRevisionId) : 'Unknown')),
    h('div', { className: 'robot-push-actions split' }, action(c.refreshing ? 'Checking…' : 'Refresh robot', c.refreshStatus, { disabled: c.refreshing }), action('Pair another robot', c.chooseAnotherRobot)),
    h('details', { className: 'robot-history' }, h('summary', null, 'Revision history and rollback'),
      !c.status?.retention && h('p', null, 'Refresh to load history. Older runtimes may not support retained revisions.'),
      c.status?.retention && h('ul', { className: 'robot-retention-list' }, c.status.retention.revisions.map((entry) => h('li', { key: entry.revisionId },
        h('div', null, h('strong', { title: entry.revisionId }, shortHash(entry.revisionId)),
          h('p', null, [entry.revisionId === c.status.activeRevisionId ? 'Active' : '', entry.pinned ? 'Pinned' : '', entry.availability === 'missing' ? 'Missing on robot' : 'Retained'].filter(Boolean).join(', '))),
        entry.availability === 'retained' && h('div', { className: 'robot-retention-actions' },
          action(entry.pinned ? 'Pinned' : 'Pin', () => c.prepareRetention('pin', entry), { disabled: entry.pinned }),
          action('Roll back', () => c.prepareRetention('rollback', entry), { disabled: entry.revisionId === c.status.activeRevisionId })))))),
    h('details', { className: 'robot-history' }, h('summary', null, 'Replace all robot content'),
      h('p', null, 'Recovery for a new robot configuration or an older runtime: replace the snapshot with all exportable paths and the routine currently selected in this project. Review lists the complete scope. Omitted robot content will be removed.'),
      action('Review full-project replacement', () => c.requestPush({ kind: 'project' }))));

  const pushReview = review && h('section', { className: 'robot-push-section' },
    h('p', { className: 'robot-push-selection' }, names(summary?.selectedNames)),
    h('dl', { className: 'robot-push-details compact' }, detail('Send to', c.preview.robot),
      detail('Adds', names(summary?.addedNames)), detail('Updates', names(summary?.updatedNames)),
      detail('Other paths', summary?.kind === 'project' ? 'Replaced by this project’s exportable paths' : (summary?.preservedPathCount || 0) + ' preserved'),
      detail('Routine', summary?.kind === 'paths' ? (summary.routine ? summary.routine + ', graph preserved' : 'None added') : (summary?.routine || 'None')),
      summary?.kind !== 'paths' && summary?.previousRoutine && detail('Replaces routine', summary.previousRoutine)),
    summary?.kind === 'paths' && summary.routine && h('p', null, 'If this routine uses an updated path, its motion will use the new path.'),
    Boolean(summary?.dependencyNames?.length) && h('p', null, 'Includes required paths: ' + names(summary.dependencyNames)),
    c.preview.receiptWarning && h('p', null, c.preview.receiptWarning),
    c.preview.adoptionRequired && h('label', { className: 'robot-baseline-confirm' },
      h('input', { type: 'checkbox', checked: c.adoptBaseline, onChange: (event) => c.setAdoptBaseline(event.target.checked) }),
      h('span', null, 'Use the robot’s current revision as this project’s baseline. Preserve its other content.')),
    h('details', { className: 'robot-history' }, h('summary', null, 'Technical details'),
      h('dl', { className: 'robot-push-details' }, detail('Project', c.preview.project), detail('Catalog', c.preview.catalog), detail('Revision', c.preview.revision), detail('Payload hash', c.preview.payloadHash), detail('Transfer', c.preview.size.toLocaleString() + ' bytes, SFTP over SSH'))),
    h('p', null, 'This reviewed snapshot is fixed. Later edits stay local. The robot must remain disabled to accept it.'),
    h('div', { className: 'robot-push-actions' }, action('Cancel', c.cancel), action(summary?.kind === 'project' ? 'Replace robot content' : summary?.kind === 'routine' ? 'Push routine' : 'Push ' + (summary?.pathIds?.length === 1 ? 'path' : (summary?.pathIds?.length || '') + ' paths'), c.confirmPush,
      { className: 'primary', disabled: c.busy || (c.preview.adoptionRequired && !c.adoptBaseline) })));

  const retention = retentionReview && h('section', { className: 'robot-push-section' },
    h('p', null, c.retentionPreview.action === 'pin' ? 'Keep this revision available in robot history.' : 'Restore this complete retained snapshot, including its paths and routine.'),
    h('dl', { className: 'robot-push-details compact' }, detail('Robot', c.retentionPreview.robot), detail('Current', shortHash(c.retentionPreview.activeRevision)), detail('Target', shortHash(c.retentionPreview.targetRevision))),
    h('p', null, 'The robot applies this change only while disabled.'),
    h('div', { className: 'robot-push-actions' }, action('Cancel', c.cancel), action(c.retentionPreview.action === 'pin' ? 'Pin revision' : 'Roll back', c.confirmRetention, { className: 'primary', disabled: c.busy })));

  const progress = (preparing || sending) && h('section', { className: 'robot-push-status', role: 'status' },
    h('strong', null, preparing ? 'Validating the selected update…' : c.phase === 'staged' ? 'Waiting for robot acceptance…' : c.phase === 'uploaded' ? 'Upload verified; staging update…' : 'Uploading…'),
    h('p', null, 'You can close this window and keep editing. The robot indicator keeps this operation available.'),
    c.phase === 'uploading' && action('Cancel upload', c.cancel));

  const finished = outcome && h('section', { className: 'robot-push-section robot-push-outcome ' + c.phase, role: accepted ? 'status' : 'alert' },
    h('h3', null, c.phase === 'active' ? 'Accepted by robot' : c.phase === 'pinned' ? 'Revision pinned' : c.phase === 'staged' ? 'Acceptance unconfirmed' : c.phase === 'cancelled' ? 'Update cancelled' : c.phase === 'rejected' ? 'Update rejected' : 'Update failed'),
    h('p', null, accepted ? (c.result?.reconciled ? 'Inspection confirms the reviewed revision is active on the robot.' : 'The robot acknowledged this exact update. Acceptance does not start execution.') : c.error || c.result?.message || 'No new acceptance was confirmed.'),
    h('div', { className: 'robot-push-actions' }, action('Connection and history', c.connectionHome), c.phase === 'staged' && action('Check robot', c.refreshStatus, { disabled: c.refreshing }), !accepted && c.phase !== 'staged' && !c.retentionPreview && action('Review current edits', c.retry)));

  return h('dialog', { ref: dialog, className: 'robot-push-dialog robot-manager', 'aria-labelledby': 'robot-push-title',
    onCancel: (event) => { event.preventDefault(); c.close(); }, onClick: (event) => { if (event.target === dialog.current) { const r = dialog.current.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) c.close(); } } },
    h('header', null, h('h2', { id: 'robot-push-title' }, title), action('×', c.close, { className: 'robot-push-close', 'aria-label': 'Close robot connection' })),
    c.error && (!outcome || accepted) && h('p', { className: 'robot-push-alert', role: 'alert' }, c.error),
    connection, pairingReview, history, pushReview, retention, progress, finished,
    !review && !retentionReview && !preparing && !sending && h('div', { className: 'robot-connection-diagnostics' }));
}

// Explicit legacy integration fixtures import this module; the application does not.
export { LegacyRobotPushDialog as RobotPushDialog };
