import * as React from 'react';
import { UI } from './ui';
import { MAX_PUSH_PATHS } from './useRobotFilePushController';
import { shortFact } from '../lib/projectLifecycle';
import { UnitPrefs } from '../lib/unitPreferences';
import { ROBOT_TARGETS, allowsCustomPassword } from '../../core/robotTargets';
import { isCommandsFile } from '../../core/export/commandsFile';
import { RobotPathField } from './RobotPathField';

const h = React.createElement;
const button = (label, onClick, props = {}) => h('button', { type: 'button', className: 'qbtn', onClick, ...props }, label);
const plural = (count) => count + (count === 1 ? ' path' : ' paths');
// A SystemCore push may also carry the LabVIEW command list; it is listed but is not a path.
const scopeLabel = (all) => {
  const files = all.filter((file) => !isCommandsFile(file.fileName));
  return files.length === 1 && files[0].fileName.endsWith('.bdr') ? '1 routine' : plural(files.length);
};
const kilobytes = (bytes) => (bytes < 1024 ? bytes + ' B' : (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + ' KB');
// Port 22 is the robot default, so the address only carries a port when it differs.
const address = (endpoint) => endpoint.host + (Number(endpoint.port) === 22 ? '' : ':' + endpoint.port);

function Destination({ endpoint, onChange, disabled, status }) {
  return h('div', { className: 'rfp-dest' },
    h('div', { className: 'rfp-dest-text' },
      h('strong', null, address(endpoint), status && h('span', { className: 'rfp-dest-status' + (status === 'Verified' ? ' good' : '') }, status)),
      h('span', null, ROBOT_TARGETS[endpoint.target].label + ' · ' + endpoint.directory)),
    onChange && button('Change', onChange, { className: 'qbtn quiet', disabled }));
}

// States only that these paths are connected through shared or endpoint points, never that an edit moved them.
function Linked({ linked, count, onInclude, disabled }) {
  const names = linked.map((path) => path.name + (path.pushable ? '' : ' (still being drawn)'));
  const shown = names.length > 3 ? names.slice(0, 3).join(', ') + ' and ' + (names.length - 3) + ' more' : names.join(', ');
  const text = 'Linked paths not included: ' + shown + '.';
  const add = linked.filter((path) => path.pushable).length;
  // Main refuses more than 64 paths, so the review states the limit instead of offering a refusal.
  const over = add > 0 && count + add > MAX_PUSH_PATHS;
  return h('p', { className: 'rfp-note rfp-linked', title: names.length > 3 ? names.join(', ') : undefined }, text,
    over ? ' Push sends at most ' + MAX_PUSH_PATHS + ' paths at once.' : null,
    add > 0 && !over ? [' ', button('Include ' + plural(add), onInclude, { key: 'include', disabled })] : null);
}

// The password row shows its source, never its value: typed, saved, session-only, the robot type's default,
// or a pending return to the default that Save or Connect commits (Keep saved undoes it).
function Password({ c }) {
  const input = React.useRef(null);
  const saved = c.passwordStatus?.custom, persistent = c.passwordStatus?.persistent;
  const pendingDefault = saved && c.useDefault && !c.password;
  const placeholder = pendingDefault ? 'Default password after Save or Connect' : !saved ? 'Default password'
    : persistent ? 'Saved on this computer' : 'Saved until Bordeaux closes';
  // The action changes or disappears when pressed, so focus returns to the field instead of the page.
  const act = (run) => () => { run(); input.current?.focus(); };
  const action = pendingDefault ? button('Keep saved', act(c.keepSavedPassword), { className: 'qbtn quiet', 'aria-label': 'Keep saved password', disabled: c.busy })
    : (saved || c.password) ? button('Use default', act(c.useDefaultPassword), { className: 'qbtn quiet', 'aria-label': 'Use default password', disabled: c.busy }) : null;
  return [h('div', { key: 'password', className: 'rfp-wide rfp-robot' }, h('label', { htmlFor: 'rfp-password' }, 'SSH password'),
    h('div', { className: 'rfp-password' },
      h('input', { ref: input, id: 'rfp-password', type: 'password', value: c.password, autoComplete: 'off', placeholder, disabled: c.busy, onChange: (e) => c.setPassword(e.target.value) }),
      action)),
    !persistent && (c.password || (saved && !pendingDefault)) && h('p', { key: 'session', className: 'rfp-note rfp-wide' }, 'This computer has no secure password storage, so Bordeaux forgets the password when it closes.')];
}

function Files({ files }) {
  return h('ul', { className: 'rfp-files', 'aria-label': 'Files to upload' }, files.map((file) => h('li', { key: file.pathId },
    h('span', { className: 'rfp-file-name' }, file.name),
    h('span', { className: 'rfp-file-meta', title: file.size.toLocaleString() + ' bytes' }, file.fileName + ' · ' + kilobytes(file.size)))));
}

const inventoryFilters = [['all', 'All'], ['paired', 'On both'], ['robotOnly', 'Robot only'], ['localOnly', 'Local only']];
const inventoryStatus = {
  paired: 'Not compared', robotOnly: 'Only on robot', localOnly: 'Only in project', conflict: 'Name conflict',
  same: 'Same', different: 'Different', olderName: 'Older file name', robotUnreadable: 'Unreadable',
  otherPath: 'Another path', localFailed: 'Local build failed', readFailed: 'Read failed', missing: 'Missing on robot',
};
const timeOfDay = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
// A robot file's modified time, against the listing it came from: a time of day when it changed that day, otherwise
// its date, so a file pushed days ago never reads as today's. The cell's title keeps the full timestamp.
const fileTime = (at, listedAt) => {
  const date = new Date(at), listed = new Date(listedAt);
  if (date.toDateString() === listed.toDateString()) return timeOfDay(at);
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', ...(date.getFullYear() !== listed.getFullYear() && { year: 'numeric' }) });
};

function Inventory({ c, filter, setFilter, pane, scroll }) {
  const { rows, missing, truncated } = c.inventory;
  const kindOf = (row) => {
    const verdict = c.verdicts[row.fileName];
    return verdict === 'olderName' ? 'paired' : verdict === 'robotOnly' && row.kind !== 'conflict' ? 'robotOnly' : row.kind;
  };
  const visible = filter === 'all' ? rows : rows.filter(row => kindOf(row) === filter);
  return h(React.Fragment, null,
    h(Destination, { endpoint: c.inventory.endpoint, status: 'Listed ' + timeOfDay(c.inventory.listedAt) }),
    missing && h('p', { className: 'rfp-note' }, 'The folder is missing on the robot. Push creates it when needed.'),
    !missing && !rows.some(row => row.robot) && h('p', { className: 'rfp-note' }, 'No BDX files in this robot folder yet.'),
    truncated && h('p', { className: 'rfp-note' }, 'Showing the first 256 robot files. Local-only paths are omitted from a partial list.'),
    h('div', { className: 'rfp-inventory-filters', role: 'group', 'aria-label': 'Filter robot files' },
      inventoryFilters.map(([kind, label]) => button(label + ' ' + (kind === 'all' ? rows.length : rows.filter(row => kindOf(row) === kind).length),
        () => { if (filter !== kind) { setFilter(kind); if (pane.current) pane.current.scrollTop = 0; } },
        { key: kind, 'aria-pressed': filter === kind }))),
    h('div', { ref: pane, className: 'rfp-inventory-scroll', onScroll: (event) => { scroll.current = event.currentTarget.scrollTop; } },
      visible.length ? h('table', { className: 'rfp-compare-table rfp-inventory-table', 'aria-label': 'Project and robot paths' },
        h('thead', null, h('tr', null, ['Path', 'On robot', 'Status', 'Action'].map(label => h('th', { key: label, scope: 'col' }, label)))),
        h('tbody', null, visible.map(row => {
          const kind = kindOf(row), status = c.verdicts[row.fileName] || row.kind;
          const label = row.robot ? (kind === 'paired' ? 'Compare' : 'Inspect') : row.detail ? '' : 'Push…';
          return h('tr', { key: row.fileName },
            h('th', { scope: 'row' }, h('strong', null, row.name), row.name !== row.fileName && h('small', null, row.fileName)),
            h('td', null, row.robot ? [kilobytes(row.robot.size), row.robot.mtime > 0 && h('small', { key: 'time', title: new Date(row.robot.mtime).toLocaleString() }, fileTime(row.robot.mtime, c.inventory.listedAt))] : '—'),
            h('td', { 'data-verdict': status }, inventoryStatus[status] || inventoryStatus[kind], row.detail && h('small', null, row.detail)),
            h('td', null, label && button(label, () => c.openRobotRow(row),
              { 'aria-label': label.replace('…', '') + ' ' + row.name, 'data-robot-file': row.fileName })));
        }))) : h('p', { className: 'rfp-note' }, 'No paths in this view.')));
}

const formatFact = (value, unit, precision) =>
  typeof value === 'number' && unit ? UnitPrefs.format(value, unit, precision) : value;
const hasChange = ([, a, b]) => a !== '—' && b !== '—' && a !== b;

function EventRows({ changes, counts, robotOnly }) {
  const [expanded, setExpanded] = React.useState(false);
  const reveal = React.useRef(null);
  React.useEffect(() => { if (expanded) reveal.current?.focus(); }, [expanded]);
  const { rows, omitted, unchanged, orderChanged } = changes;
  const previewCount = 4, columns = robotOnly ? 2 : 3;
  const [localCount, robotCount] = counts;
  const time = (value, precision = 2) => UnitPrefs.format(value, 's', precision);
  const cell = (value) => h('td', { className: value == null || value === '—' ? 'rfp-absent' : undefined }, value == null || value === '—' ? 'Not present' : value);
  const first = (index) => index === previewCount ? { ref: reveal, tabIndex: -1 } : {};
  const fullRow = (text, key, className) => h('tr', { key, className }, h('td', { colSpan: columns }, text));
  const summary = [unchanged ? unchanged + ' unchanged' : '', orderChanged ? 'Order differs' : ''].filter(Boolean).join(' · ');
  return h('tbody', { className: 'rfp-events' },
    h('tr', { className: 'rfp-events-head', 'data-changed': !robotOnly && localCount !== robotCount || undefined },
      h('th', { scope: 'row' }, 'Events'), !robotOnly && h('td', null, localCount), h('td', null, robotCount)),
    (expanded ? rows : rows.slice(0, previewCount)).map(({ id, local, robot, values, notes }, index) => {
      const name = (local || robot).name;
      if (!local || !robot) return h('tr', { key: id },
        h('th', { scope: 'row', ...first(index) }, name),
        !robotOnly && cell(local && time(local.time)), cell(robot && time(robot.time)));
      const fields = [];
      if (local.name !== robot.name) fields.push(['Name', local.name, robot.name]);
      if (local.time !== robot.time) {
        let precision = 2;
        while (precision < 6 && time(local.time, precision) === time(robot.time, precision)) precision++;
        fields.push(['Time', time(local.time, precision), time(robot.time, precision)]);
      }
      const rowHeader = (label) => h('th', { scope: 'row', 'aria-label': name + ', ' + label }, label);
      return h(React.Fragment, { key: id },
        h('tr', { className: 'rfp-event-name' }, h('th', { colSpan: columns, ...first(index) }, name)),
        [...fields, ...values].map(([label, a, b], i) => h('tr', { key: i, className: 'rfp-event-row' }, rowHeader(label), cell(a), cell(b))),
        notes.map(([label, detail], i) => label
          ? h('tr', { key: i, className: 'rfp-event-row' }, rowHeader(label), h('td', { colSpan: 2, className: 'rfp-absent' }, detail))
          : fullRow(detail, i, 'rfp-events-foot')));
    }),
    !expanded && rows.length > previewCount && fullRow(button(
      'Show ' + (rows.length - previewCount) + ' more ' + (rows.length - previewCount === 1 ? 'event' : 'events'),
      () => setExpanded(true), { className: 'qbtn quiet' }), 'expand', 'rfp-events-foot'),
    omitted > 0 && (expanded || rows.length <= previewCount) && fullRow('+' + omitted + (omitted === 1 ? ' more event' : ' more events'), 'omitted', 'rfp-events-foot'),
    summary && fullRow(summary, 'summary', 'rfp-events-foot'));
}

function CompareFacts({ rows, label, robotOnly = false, changesOnly = false, eventChanges, eventCounts }) {
  return h('table', { className: 'rfp-compare-table' + (changesOnly ? ' rfp-changed-values' : ''), 'aria-label': label },
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, changesOnly ? 'Changed' : 'Value'),
      !robotOnly && h('th', { scope: 'col' }, 'This computer'), h('th', { scope: 'col' }, 'Robot'))),
    h('tbody', null, rows.map((row) => {
      const [name, a, b, unit] = row, changed = hasChange(row);
      let precision = 2;
      while (changed && precision < 6 && formatFact(a, unit, precision) === formatFact(b, unit, precision)) precision++;
      return h('tr', { key: name, 'data-changed': changed || undefined },
        h('th', { scope: 'row', 'aria-label': changed ? name + ', changed' : undefined }, name),
        !robotOnly && h('td', null, formatFact(a, unit, precision)), h('td', null, formatFact(b, unit, precision)));
    })),
    eventChanges && h(EventRows, { changes: eventChanges, counts: eventCounts, robotOnly }));
}

// A comparison with a local path and readable routes draws both on the field and needs the wide dialog. The desktop
// matches a robot file to a local path by the path ID saved inside it, so an Inspect of a robot-only row can return one.
const showsField = (comparison) => !!comparison?.routes && !comparison.robotOnly && comparison.verdict !== 'robotUnreadable';

function Comparison({ controller: c, verdictRef }) {
  const { verdict, name, robotName, fileName, localError, robotError, local, robot, facts, notes, eventChanges, expectedFileName, robotOnly, routes, widestGap } = c.comparison;
  const verdicts = {
    same: 'The robot file matches what Push would send.',
    different: 'The robot has a different version of ' + name + '.',
    missing: fileName + ' is missing from the robot.',
    otherPath: fileName + ' belongs to another path on the robot (' + robotName + '). Pushing ' + name + ' replaces that file.',
    robotUnreadable: 'Bordeaux couldn’t read ' + fileName + ' · ' + robotError,
    localFailed: 'Bordeaux couldn’t build the local BDX for ' + name + '.',
    robotOnly: name + ' is only on the robot.',
  };
  const gap = facts.find(([label]) => label === 'Approx. route gap')?.[2];
  const values = facts.filter(([label]) => label !== 'Approx. route gap');
  const changes = values.filter((row) => hasChange(row) && (!eventChanges || row[0] !== 'Events'));
  const eventCounts = values.find(([label]) => label === 'Events')?.slice(1);
  const eventProps = eventChanges && eventCounts ? { eventChanges, eventCounts } : {};
  const fingerprint = (file) => file ? kilobytes(file.size) + ' · ' + file.sha256.slice(0, 8) : '—';
  const allValues = [...values, ['File', fingerprint(local), fingerprint(robot)]];
  const table = h(CompareFacts, { rows: robotOnly && eventChanges ? allValues.filter(([label]) => label !== 'Events') : allValues,
    label: 'BDX values for ' + name, robotOnly, ...(robotOnly ? eventProps : {}) });
  const comparisonNotes = notes.length > 0 && h('ul', { className: 'rfp-compare-notes' }, notes.map((note, i) => h('li', { key: i }, note)));
  return h(React.Fragment, null,
    h('p', { tabIndex: -1, ref: verdictRef, className: 'rfp-compare-verdict' }, h('strong', null, verdicts[verdict])),
    robotOnly && name !== fileName && h('p', { className: 'rfp-note' }, fileName),
    expectedFileName && h('p', { className: 'rfp-note' }, 'The robot has this path as ' + fileName + '. Push uses its current filename, ' + expectedFileName + '.'),
    localError && h('p', { className: 'rfp-note' }, 'Local BDX unavailable · ' + localError),
    !showsField(c.comparison) ? h(React.Fragment, null, table, comparisonNotes) :
      h('div', { className: 'rfp-field-review' },
        h(RobotPathField, { routes, verdict, widestGap, gap }),
        h('div', { className: 'rfp-field-changes' },
          (changes.length > 0 || eventChanges) && h(CompareFacts, { rows: changes, label: 'Changed values for ' + name,
            changesOnly: true, ...eventProps }),
          comparisonNotes,
          h('details', { className: 'rfp-all-values' }, h('summary', null, 'All values (' + allValues.length + ')'), table))));
}

export function RobotFilePushDialog({ controller: c }) {
  const dialog = React.useRef(null);
  const verdictRef = React.useRef(null), compareCancel = React.useRef(null);
  const inventoryPane = React.useRef(null), inventoryScroll = React.useRef(0);
  const [filter, setFilter] = React.useState('all');
  React.useEffect(() => {
    if (c.open && !dialog.current.open) dialog.current.showModal();
    else if (!c.open && dialog.current.open) { dialog.current.close(); c.returnFocus(); }
  }, [c.open]);
  React.useEffect(() => {
    if (!c.open) { setFilter('all'); inventoryScroll.current = 0; }
    compareCancel.current?.focus();
    const pane = inventoryPane.current;
    if (c.phase === 'listed' && pane) {
      pane.scrollTop = inventoryScroll.current;
      const row = [...pane.querySelectorAll('[data-robot-file]')].find(button => button.dataset.robotFile === c.row);
      (row || dialog.current.querySelector('.rfp-inventory-filters button'))?.focus();
    }
  }, [c.phase, c.open]);
  React.useEffect(() => { verdictRef.current?.focus(); }, [c.comparison]);
  const endpoint = c.preview?.connection.endpoint || c.settings?.endpoint;
  const identity = c.probe && ['identity', 'trusting'].includes(c.phase);
  const files = ['review', 'uploading', 'failed'].includes(c.phase) && c.preview ? c.preview.files : null;
  const setup = !identity && (c.editing || !c.settings) && ['idle', 'probing', 'saving', 'cancelled'].includes(c.phase);
  const summary = !identity && !setup && c.settings && ['idle', 'probing', 'cancelled'].includes(c.phase);
  const working = ['loading', 'preparing'].includes(c.phase) || (c.phase === 'uploading' && !files);
  const invalidEndpoint = !c.host.trim() || !c.directory.trim() || !/^\d+$/.test(c.port) || Number(c.port) < 1 || Number(c.port) > 65535;
  const compareView = ['comparing', 'compared', 'compare-failed', 'saving-copy'].includes(c.phase);
  const listing = c.phase === 'listing', listed = c.phase === 'listed', listFailed = c.phase === 'list-failed';
  const title = identity ? 'Verify robot' : setup || summary ? (c.servedByRobot ? 'Push folder' : 'Robot connection')
    : listed || listing || listFailed || (compareView && c.inventory) ? 'Robot files'
    : compareView ? c.comparison?.robotOnly ? 'Robot path' : 'Compare with robot' : 'Push to robot';
  const allFiles = c.inventory && button('All files', c.backToRobotFiles, { key: 'all', disabled: c.busy });
  const errorFact = c.error && shortFact(c.error);
  const alert = c.error && h('div', { key: 'alert' },
    h('p', { className: 'rfp-alert', role: 'alert' }, errorFact),
    c.error.replace(/\.$/, '') !== errorFact && h('details', { className: 'rfp-error-details' },
      h('summary', null, 'Details'), h('p', null, c.error)));
  // A running request keeps its button focusable but inert (the controller ignores repeat presses), so focus is still
  // there when the request fails.
  const hold = c.busy ? { 'aria-disabled': true } : {};
  // A push waiting on this connection makes Connect the way forward; otherwise saving the address is the whole task.
  const waiting = c.canRetry;

  // Each view supplies its body and actions. The footer, and with it the diagnostics portal
  // target, is mounted once so view changes never strand the diagnostics trigger.
  let view = 'fallback', body = null, actions = [], downloadNote = null, diagnostics = true;
  if (setup) {
    view = 'setup';
    // An editor served by the robot pushes to that robot, so the push folder is the only choice there.
    body = c.servedByRobot ? [alert, h('div', { key: 'fields', className: 'rfp-fields' },
      h('label', { className: 'rfp-wide' }, 'Folder on robot', h('input', { value: c.directory, spellCheck: false, disabled: c.busy, onChange: (e) => c.setDirectory(e.target.value) }))),
      h('p', { key: 'note', className: 'rfp-note' }, 'Push writes path files here, and robot code reads them from this folder.')] : [alert, h('div', { key: 'fields', className: 'rfp-fields' },
      h('div', { className: 'rfp-wide rfp-robot' }, h('span', { id: 'rfp-robot-label' }, 'Robot'),
        h('div', { className: 'seg', role: 'group', 'aria-labelledby': 'rfp-robot-label', style: { '--seg-count': Object.keys(ROBOT_TARGETS).length } },
          Object.entries(ROBOT_TARGETS).map(([id, target]) => h('button', { key: id, type: 'button', className: 'seg-i' + (c.target === id ? ' on' : ''), 'aria-pressed': c.target === id, disabled: c.busy, onClick: () => c.chooseTarget(id) }, target.label)))),
      h('label', null, 'Host', h('input', { value: c.host, autoFocus: true, autoComplete: 'off', spellCheck: false, placeholder: ROBOT_TARGETS[c.target].hostPlaceholder, disabled: c.busy, onChange: (e) => c.setHost(e.target.value) })),
      h('label', { className: 'rfp-port' }, 'Port', h('input', { value: c.port, inputMode: 'numeric', disabled: c.busy, onChange: (e) => c.setPort(e.target.value) })),
      allowsCustomPassword(c.target) ? h(Password, { c })
        : c.passwordStatus?.custom && h('p', { className: 'rfp-note rfp-wide' }, 'Saving or connecting as ' + ROBOT_TARGETS[c.target].label + ' forgets the custom SSH password.'),
      h('label', { className: 'rfp-wide' }, 'Folder on robot', h('input', { value: c.directory, spellCheck: false, disabled: c.busy, onChange: (e) => c.setDirectory(e.target.value) }))),
      h('p', { key: 'note', className: 'rfp-note' }, 'Save offline. Connect to verify the robot.')];
    // The primary action sits last.
    const save = button(c.phase === 'saving' ? 'Saving…' : 'Save', c.saveSettings, { key: 'save', className: waiting ? 'qbtn' : 'qbtn primary', disabled: invalidEndpoint, ...hold });
    const connect = button(c.phase === 'probing' ? 'Connecting…' : 'Connect', c.probeRobot, { key: 'connect', className: waiting ? 'qbtn primary' : 'qbtn', disabled: invalidEndpoint, ...hold });
    actions = c.servedByRobot ? [save] : waiting ? [save, connect] : [connect, save];
  } else if (summary) {
    view = 'summary';
    // The endpoint shown is the stored one, so "Saved" is a fact about this computer, never about the robot.
    body = [alert, c.servedByRobot
      ? h('div', { key: 'dest', className: 'rfp-dest' }, h('div', { className: 'rfp-dest-text' }, h('strong', null, endpoint.directory), h('span', null, 'Push writes path files here.')))
      : h(Destination, { key: 'dest', endpoint, status: c.reachability === 'offline' ? 'Disconnected' : c.connection ? 'Verified' : 'Saved · not verified' })];
    const done = (!c.connection && waiting) ? null : button('Done', c.close, { key: 'done', className: 'qbtn primary', autoFocus: true });
    actions = [
      button('Edit', c.editConnection, { key: 'edit', disabled: c.busy }),
      c.robotFilesAvailable && c.connection && button('Robot files', c.openRobotFiles, { key: 'files', disabled: c.busy }),
      !c.servedByRobot && (!c.connection || c.reachability === 'offline') && button(c.phase === 'probing' ? 'Connecting…' : 'Connect', c.probeRobot, { key: 'connect', className: waiting ? 'qbtn primary' : 'qbtn', ...hold }),
      done,
    ];
  } else if (identity) {
    view = 'identity';
    body = [alert,
      h('p', { key: 'intro' }, h('strong', null, address(c.probe.endpoint)), ' — verify this key matches your robot.'),
      h('code', { key: 'key', className: 'rfp-key' }, c.probe.hostKeyFingerprint)];
    actions = [
      button('Back', c.chooseAnotherRobot, { key: 'back', disabled: c.busy }),
      button(c.phase === 'trusting' ? 'Trusting…' : 'Trust host key', c.confirmPairing, { key: 'trust', className: 'qbtn primary', ...hold }),
    ];
  } else if (listed || listing || listFailed) {
    view = listed ? 'inventory' : 'compare';
    diagnostics = listFailed;
    if (listed) {
      body = h(Inventory, { c, filter, setFilter, pane: inventoryPane, scroll: inventoryScroll });
      actions = [button('Edit connection', c.editConnection, { key: 'edit' }), button('Refresh', c.openRobotFiles, { key: 'refresh' }),
        button('Done', c.close, { key: 'done', className: 'qbtn primary' })];
    } else if (listing) {
      body = h('p', { role: 'status', className: 'rfp-view-working' }, h('span', { className: 'robot-push-spinner' }), 'Reading files in ' + c.directory + '…');
      actions = [button('Cancel', c.close, { key: 'cancel', ref: compareCancel })];
    } else {
      body = alert;
      actions = [button('Edit connection', c.editConnection, { key: 'edit' }), button('Close', c.close, { key: 'close' }),
        button('Try again', c.openRobotFiles, { key: 'retry', className: 'qbtn primary', ref: compareCancel })];
    }
  } else if (compareView) {
    view = 'compare';
    if (c.phase === 'comparing') {
      diagnostics = false;
      body = h('p', { role: 'status', className: 'rfp-view-working' }, h('span', { className: 'robot-push-spinner' }), c.row ? 'Reading ' + c.row + '…' : 'Reading robot file and preparing the local BDX…');
      actions = [button('Cancel', c.inventory ? c.backToRobotFiles : c.close, { key: 'cancel', ref: compareCancel })];
    } else if (c.comparison) {
      diagnostics = false;
      body = [h(Destination, { key: 'dest', endpoint: c.comparison.endpoint,
        status: 'Read ' + timeOfDay(c.comparison.readAt) }),
      h(Comparison, { key: 'comparison', controller: c, verdictRef })];
      const download = c.comparison.robot && button(c.busy ? 'Downloading…' : 'Download .bdx…', c.saveCopy,
        { key: 'download', className: c.comparison.robotOnly ? 'qbtn primary' : 'qbtn', ...hold });
      if (download) downloadNote = c.error ? h('p', { className: 'rfp-alert', role: 'alert' }, c.error)
        : c.copy && h('p', { className: 'rfp-note', role: 'status' }, 'Saved ' + c.copy.name + ' to ' + c.copy.folder + ' · ' + c.copy.size.toLocaleString() + ' bytes verified');
      actions = [allFiles, download, button('Done', c.close,
        { key: 'done', className: c.comparison.robotOnly && download ? 'qbtn' : 'qbtn primary', disabled: c.busy })];
    } else {
      body = alert;
      actions = [allFiles, c.canRetry && button('Edit connection', c.editConnection, { key: 'edit' }),
        button('Close', c.close, { key: 'close', autoFocus: true }),
        c.canRetry && button('Try again', c.retry, { key: 'retry', className: 'qbtn primary' })];
    }
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
          c.phase === 'uploading' ? 'Uploading…' : 'Upload ' + scopeLabel(files))];
  } else if (c.phase === 'transferred' && c.result) {
    view = 'done'; diagnostics = false;
    body = [h('span', { key: 'check', className: 'rfp-check' }, h(UI.Icon, { name: 'check', size: 14, sw: 2.2 })),
      h('div', { key: 'text' }, h('strong', null, scopeLabel(c.result.files) + ' uploaded'),
        // Only an acknowledged creation of this exact folder is reported; an existing folder needs no mention.
        h('p', null, (c.result.directoryCreated === true ? 'Folder created. ' : '') + 'Verified in ' + c.result.directory + '. Nothing started.'))];
    actions = [c.reachability === 'offline' && button('Connect', c.probeRobot, { key: 'connect' }), button('Done', c.close, { key: 'done', className: 'qbtn primary', autoFocus: true })];
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

  // Robot files keeps one size per view, so expanding values, filtering or downloading never resizes the window. The list
  // and Inspect share a size; Compare uses the field size. A read opens at its request's size, and an Inspect grows once
  // when its file matched a local path and the result draws both routes.
  const filesView = listing || listed || listFailed || compareView;
  const fieldSize = compareView && (!c.inspecting || showsField(c.comparison));
  return h('dialog', { ref: dialog, className: 'robot-push-dialog robot-manager rfp' + (filesView ? ' rfp-robot-files' : '')
      + (fieldSize ? ' rfp-field-dialog' : ''), 'aria-labelledby': 'robot-file-title', 'aria-busy': c.busy,
    onCancel: (event) => { event.preventDefault(); if (c.phase === 'comparing' && c.inventory) c.backToRobotFiles(); else c.close(); } },
    h('header', null, h('h2', { id: 'robot-file-title' }, title), h('button', { type: 'button', className: 'robot-push-close', 'aria-label': 'Close robot files', disabled: c.phase === 'saving-copy', onClick: c.close }, '×')),
    h('div', { key: view, className: 'rfp-body rfp-view-' + view, role: view === 'working' || view === 'done' ? 'status' : undefined }, body),
    h('footer', { className: 'rfp-footer' },
      h('div', { className: 'robot-connection-diagnostics', hidden: !diagnostics }),
      downloadNote && h('div', { className: 'rfp-download-note' }, downloadNote),
      h('div', { className: 'rfp-actions' }, actions)));
}
