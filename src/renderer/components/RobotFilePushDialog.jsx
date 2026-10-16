import * as React from 'react';
import { UI } from './ui';
import { MAX_PUSH_PATHS } from './useRobotFilePushController';

const h = React.createElement;
const button = (label, onClick, props = {}) => h('button', { type: 'button', className: 'qbtn', onClick, ...props }, label);
const plural = (count) => count + (count === 1 ? ' path' : ' paths');
const kilobytes = (bytes) => (bytes < 1024 ? bytes + ' B' : (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + ' KB');
// Port 22 is the robot default, so the address only carries a port when it differs.
const address = (endpoint) => endpoint.host + (Number(endpoint.port) === 22 ? '' : ':' + endpoint.port);

function Destination({ endpoint, onChange, disabled, status }) {
  return h('div', { className: 'rfp-dest' },
    h('div', { className: 'rfp-dest-text' },
      h('strong', null, address(endpoint), status && h('span', { className: 'rfp-dest-status' + (status === 'Verified' ? ' good' : '') }, status)),
      h('span', null, endpoint.directory)),
    onChange && button('Change', onChange, { className: 'qbtn quiet', disabled }));
}

// States only that these paths are connected through shared or endpoint points, never that an edit moved them.
function Linked({ linked, count, onInclude, disabled }) {
  const names = linked.map((path) => path.name + (path.pushable ? '' : ' (still being drawn)'));
  const shown = names.length > 3 ? names.slice(0, 3).join(', ') + ' and ' + (names.length - 3) + ' more' : names.join(', ');
  const text = names.length === 1 ? 'Linked to ' + shown + ', which is not included.' : 'Linked to ' + names.length + ' paths that are not included: ' + shown + '.';
  const add = linked.filter((path) => path.pushable).length;
  // Main refuses more than 64 paths, so the review states the limit instead of offering a refusal.
  const over = add > 0 && count + add > MAX_PUSH_PATHS;
  return h('p', { className: 'rfp-note rfp-linked', title: names.length > 3 ? names.join(', ') : undefined }, text,
    over ? ' Push sends at most ' + MAX_PUSH_PATHS + ' paths at once.' : null,
    add > 0 && !over ? [' ', button('Include ' + plural(add), onInclude, { key: 'include', disabled })] : null);
}

function Files({ files }) {
  return h('ul', { className: 'rfp-files', 'aria-label': 'Files to upload' }, files.map((file) => h('li', { key: file.pathId },
    h('span', { className: 'rfp-file-name' }, file.name),
    h('span', { className: 'rfp-file-meta', title: file.size.toLocaleString() + ' bytes' }, file.fileName + ' · ' + kilobytes(file.size)))));
}

export function RobotFilePushDialog({ controller: c }) {
  const dialog = React.useRef(null);
  React.useEffect(() => {
    if (c.open && !dialog.current.open) dialog.current.showModal();
    else if (!c.open && dialog.current.open) dialog.current.close();
  }, [c.open]);
  const endpoint = c.preview?.connection.endpoint || c.settings?.endpoint;
  const identity = c.probe && ['identity', 'trusting'].includes(c.phase);
  const files = ['review', 'uploading', 'failed'].includes(c.phase) && c.preview ? c.preview.files : null;
  const setup = !identity && (c.editing || !c.settings) && ['idle', 'probing', 'saving', 'cancelled'].includes(c.phase);
  const summary = !identity && !setup && c.settings && ['idle', 'probing', 'cancelled'].includes(c.phase);
  const working = ['loading', 'preparing'].includes(c.phase) || (c.phase === 'uploading' && !files);
  const invalidEndpoint = !c.host.trim() || !c.directory.trim() || !/^\d+$/.test(c.port) || Number(c.port) < 1 || Number(c.port) > 65535;
  const title = identity ? 'Verify robot' : setup || summary ? 'Robot connection' : 'Push to robot';
  const alert = c.error && h('p', { key: 'alert', className: 'rfp-alert', role: 'alert' }, c.error);
  // A running request keeps its button focusable but inert (the controller ignores repeat presses), so focus is still
  // there when the request fails.
  const hold = c.busy ? { 'aria-disabled': true } : {};
  // A push waiting on this connection makes Connect the way forward; otherwise saving the address is the whole task.
  const waiting = c.canRetry;

  // Each view supplies its body and actions. The footer, and with it the diagnostics portal
  // target, is mounted once so view changes never strand the diagnostics trigger.
  let view = 'fallback', body = null, actions = [], diagnostics = true;
  if (setup) {
    view = 'setup';
    body = [alert, h('div', { key: 'fields', className: 'rfp-fields' },
      h('label', null, 'Host', h('input', { value: c.host, autoFocus: true, autoComplete: 'off', spellCheck: false, placeholder: 'roborio-2468-frc.local', disabled: c.busy, onChange: (e) => c.setHost(e.target.value) })),
      h('label', { className: 'rfp-port' }, 'Port', h('input', { value: c.port, inputMode: 'numeric', disabled: c.busy, onChange: (e) => c.setPort(e.target.value) })),
      h('label', { className: 'rfp-wide' }, 'Folder on robot', h('input', { value: c.directory, spellCheck: false, disabled: c.busy, onChange: (e) => c.setDirectory(e.target.value) }))),
      h('p', { key: 'note', className: 'rfp-note' }, 'Save works without the robot. Connect checks its SSH host key.')];
    // The primary action sits last.
    const save = button(c.phase === 'saving' ? 'Saving…' : 'Save', c.saveSettings, { key: 'save', className: waiting ? 'qbtn' : 'qbtn primary', disabled: invalidEndpoint, ...hold });
    const connect = button(c.phase === 'probing' ? 'Connecting…' : 'Connect', c.probeRobot, { key: 'connect', className: waiting ? 'qbtn primary' : 'qbtn', disabled: invalidEndpoint, ...hold });
    actions = waiting ? [save, connect] : [connect, save];
  } else if (summary) {
    view = 'summary';
    // The endpoint shown is the stored one, so "Saved" is a fact about this computer, never about the robot.
    body = [alert, h(Destination, { key: 'dest', endpoint, status: c.connection ? 'Verified' : 'Saved · not verified' }),
      c.connection && h('p', { key: 'note', className: 'rfp-note' }, 'Select paths in the library, then choose Push.')];
    const done = (!c.connection && waiting) ? null : button('Done', c.close, { key: 'done', className: 'qbtn primary', autoFocus: true });
    actions = [
      button('Edit', c.chooseAnotherRobot, { key: 'edit', disabled: c.busy }),
      !c.connection && button(c.phase === 'probing' ? 'Connecting…' : 'Connect', c.probeRobot, { key: 'connect', className: waiting ? 'qbtn primary' : 'qbtn', ...hold }),
      done,
    ];
  } else if (identity) {
    view = 'identity';
    body = [alert,
      h('p', { key: 'intro' }, h('strong', null, address(c.probe.endpoint)), ' presented this SSH host key. Trust it only if it matches your robot.'),
      h('code', { key: 'key', className: 'rfp-key' }, c.probe.hostKeyFingerprint)];
    actions = [
      button('Back', c.chooseAnotherRobot, { key: 'back', disabled: c.busy }),
      button(c.phase === 'trusting' ? 'Trusting…' : 'Trust host key', c.confirmPairing, { key: 'trust', className: 'qbtn primary', ...hold }),
    ];
  } else if (working) {
    view = 'working'; diagnostics = false;
    body = [h('span', { key: 'spin', className: 'robot-push-spinner' }), c.phase === 'loading' ? 'Loading robot connection…' : c.phase === 'uploading' ? 'Uploading…' : 'Preparing files…'];
  } else if (files) {
    const failed = c.phase === 'failed';
    view = failed ? 'files-failed' : 'files'; diagnostics = failed;
    body = [failed && alert,
      h(Destination, { key: 'dest', endpoint, onChange: c.chooseAnotherRobot, disabled: c.busy }),
      h(Files, { key: 'files', files }),
      c.phase === 'review' && c.preview.linked?.length > 0 && h(Linked, { key: 'linked', linked: c.preview.linked, count: files.length, onInclude: () => c.includeLinked(c.preview.operationId), disabled: c.busy }),
      !failed && alert,
      !failed && h('p', { key: 'note', className: 'rfp-note' }, 'Replaces only these files. Uploading does not run anything.')];
    // Upload is never focused automatically: a held Enter from Push or Trust must not confirm a review.
    actions = failed
      ? [button('Close', c.close, { key: 'close', className: c.canRetry ? 'qbtn' : 'qbtn primary' }), c.canRetry && button('Try again', c.retry, { key: 'retry', className: 'qbtn primary' })]
      : [button(c.phase === 'uploading' ? 'Cancel upload' : 'Cancel', c.cancel, { key: 'cancel', autoFocus: true }),
        h('button', { key: 'upload', type: 'button', className: 'qbtn primary', disabled: c.busy, onClick: c.confirmPush },
          c.phase === 'uploading' && h('span', { className: 'robot-push-spinner', 'aria-hidden': true }),
          c.phase === 'uploading' ? 'Uploading…' : 'Upload ' + plural(files.length))];
  } else if (c.phase === 'transferred' && c.result) {
    view = 'done'; diagnostics = false;
    body = [h('span', { key: 'check', className: 'rfp-check' }, h(UI.Icon, { name: 'check', size: 14, sw: 2.2 })),
      h('div', { key: 'text' }, h('strong', null, plural(c.result.files.length) + ' uploaded'),
        // Only an acknowledged creation of this exact folder is reported; an existing folder needs no mention.
        h('p', null, (c.result.directoryCreated === true ? 'Created robot folder ' + c.result.directory + ' and verified the files there.' : 'Verified in ' + c.result.directory + '.') + ' No routine was activated.'))];
    actions = [button('Done', c.close, { key: 'done', className: 'qbtn primary', autoFocus: true })];
  } else {
    // Failures without a reviewed file list, unsupported requests, and any unexpected state.
    const failed = c.phase === 'failed';
    body = [alert || h('p', { key: 'idle' }, 'Nothing to push right now.')];
    actions = [
      failed && button('Edit connection', c.chooseAnotherRobot, { key: 'edit' }),
      button('Close', c.close, { key: 'close', className: failed && c.canRetry ? 'qbtn' : 'qbtn primary' }),
      failed && c.canRetry && button('Try again', c.retry, { key: 'retry', className: 'qbtn primary' }),
    ];
  }

  return h('dialog', { ref: dialog, className: 'robot-push-dialog robot-manager rfp', 'aria-labelledby': 'robot-file-title', 'aria-busy': c.busy, onCancel: (event) => { event.preventDefault(); c.close(); } },
    h('header', null, h('h2', { id: 'robot-file-title' }, title), h('button', { type: 'button', className: 'robot-push-close', 'aria-label': 'Close robot files', onClick: c.close }, '×')),
    h('div', { key: view, className: 'rfp-body rfp-view-' + view, role: view === 'working' || view === 'done' ? 'status' : undefined }, body),
    h('footer', { className: 'rfp-footer' },
      h('div', { className: 'robot-connection-diagnostics', hidden: !diagnostics }),
      h('div', { className: 'rfp-actions' }, actions)));
}
