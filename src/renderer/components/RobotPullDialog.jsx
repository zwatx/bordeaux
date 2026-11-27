import * as React from 'react';
import '../styles/robot-push.css';
import { projectRobots, pushConnectionProblem, replaceRobotDetails, robotDetailsOf, selectedRobotId } from '../../core/project/robots';
import { parseRobotFile, robotDetailsProblem, robotFileDetails, robotPushFileConflict, robotPushFileName } from '../../core/project/robotFile';
import { sha256Hex } from '../../core/bytes';
import { ROBOT_TARGETS } from '../../core/robotTargets';
import { introducedProblems, robotFileChanges } from '../lib/robotFileReview';
import { forgetRobotFile, rememberRobotFile } from '../lib/robotFileMemory';
import { focusIfAvailable } from '../lib/focusReturn';
import { shortFact } from '../lib/projectLifecycle';

const h = React.createElement;
const button = (label, onClick, props = {}) => h('button', { type: 'button', className: 'qbtn', onClick, ...props }, label);
const message = (error) => (error?.message || String(error || 'Reading the robot failed'))
  .replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^(?:RobotTransportError|Error):\s*/, '');
const timeOfDay = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const address = (endpoint) => endpoint.host + (Number(endpoint.port) === 22 ? '' : ':' + endpoint.port);
const closed = { open: false, phase: 'idle', robotId: null, robotName: '', fileName: '', choices: [], incoming: null, changes: [], problems: [], endpoint: null, readAt: null, error: '', canConnect: false, canRetry: false, applying: false };
const REPLACED = 'Another project was opened while this review was open. Nothing was applied.';
const CHANGED = 'The project changed while this review was open, so nothing was applied. Pull again to review the robot’s details against the project as it is now.';
const KEPT_CHANGING = 'The project changed while it was checked again for Apply, so nothing was applied. Pull again to review the robot’s details against the project as it is now.';
const detailsText = (project, robotId) => { const details = robotDetailsOf(project, robotId); return details ? JSON.stringify(robotFileDetails(details)) : null; };

/**
 * Pull from robot: an explicit, read-only read of the selected robot's `.robot` file from its push folder, through the
 * same read as comparing pushed paths (`readRobotFiles`). Nothing on the robot, in SSH trust or in a waiting Push
 * review changes. A file that is missing offers the robot files the folder holds; one that fails validation (its
 * structure here, its details through the host's validateProject) is reported and never applied, and details that would
 * give the rest of the project errors it doesn't have now (a tank drive under a path's jiggle) are listed and can't be
 * applied, because Save would refuse the project. Apply hands the file's details to `onApply`, which makes them one
 * undoable change, and only while the project is the one reviewed (`projectEpoch`, which opening a project advances;
 * `projectKey` closes the review when that happens) and the robot's details are as they were reviewed.
 *
 * The check is bound to one project revision (`projectRevision`, which any project change advances): Apply applies
 * straight away only to the revision that was checked. A project changed since (a path edit while a check ran, say) is
 * checked again as it is now, and applied only if nothing changed while that check ran.
 */
export function useRobotPull({ getProject, projectRevision, connection, onApply, projectKey, projectEpoch = () => 0 }) {
  const api = window.bordeauxAPI;
  const [view, setView] = React.useState(closed);
  const state = React.useRef(view);
  const generation = React.useRef(0);
  const origin = React.useRef(null);
  // What the review was made against: the project generation, the revision its check saw and the robot's details then.
  const reviewed = React.useRef({ epoch: null, revision: undefined, details: null });
  const update = (patch) => { state.current = { ...state.current, ...patch }; setView(state.current); };
  const replaced = () => reviewed.current.epoch !== projectEpoch();
  React.useEffect(() => {
    if (state.current.open && state.current.phase !== 'failed' && reviewed.current.epoch !== null && replaced()) {
      generation.current += 1;
      update({ phase: 'failed', error: REPLACED, incoming: null, changes: [], problems: [], canRetry: false, canConnect: false, applying: false });
    }
  }, [projectKey]);
  // The file's details checked as the host checks a project: problems with this robot's details make the file unusable
  // (thrown), and errors they would add elsewhere come back as `problems`.
  const check = async (project, robotId, robot) => {
    const [before, after] = await Promise.all([api.validateProject(project), api.validateProject(replaceRobotDetails(project, robotId, robot))]);
    const index = project.robots?.findIndex((entry) => entry.id === robotId) ?? -1;
    const problem = robotDetailsProblem(after.issues, robotId === selectedRobotId(project) ? '$.robot' : '$.robots[' + index + '].robot');
    if (problem) throw new Error(problem);
    return introducedProblems(project, before.issues, after.issues);
  };
  const read = async (fileName) => {
    const request = ++generation.current;
    update({ phase: 'reading', fileName, incoming: null, changes: [], problems: [], error: '', canConnect: false, canRetry: false });
    try {
      const reading = await api.readRobotFiles([fileName]);
      if (request !== generation.current) return;
      const file = reading.files.find((item) => item.fileName === fileName);
      const found = { endpoint: reading.connection.endpoint, readAt: reading.readAt };
      if (!file?.contents) {
        // Whatever an earlier Push or Pull saw there is gone, so the next Push must not call it the same.
        forgetRobotFile(reading.connection, fileName);
        const choices = (reading.robotConfigs ?? []).filter((name) => name !== fileName);
        update({ ...found, phase: choices.length ? 'choose' : 'missing', choices });
        return;
      }
      const bytes = new Uint8Array(file.contents);
      rememberRobotFile(reading.connection, fileName, sha256Hex(bytes));
      if (replaced()) { update({ ...found, phase: 'failed', error: REPLACED }); return; }
      const revision = projectRevision(), project = getProject(), robotId = state.current.robotId, current = robotDetailsOf(project, robotId);
      if (!current) { update({ ...found, phase: 'failed', error: 'This robot is no longer in the project.' }); return; }
      let incoming, problems;
      try {
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('It is not UTF-8 text.'); }
        incoming = parseRobotFile(text);
        // The host checks the details as it checks a project, so the page doesn't carry the validator.
        problems = await check(project, robotId, incoming.robot);
        if (request !== generation.current) return;
      } catch (error) { if (request === generation.current) update({ ...found, phase: 'invalid', error: message(error) }); return; }
      reviewed.current = { ...reviewed.current, revision, details: detailsText(project, robotId) };
      const changes = robotFileChanges(robotFileDetails(current), incoming.robot);
      update({ ...found, phase: changes.length ? 'review' : 'same', incoming, changes, problems });
    } catch (error) {
      if (request === generation.current) update({ phase: 'failed', error: message(error), canRetry: true, canConnect: Boolean(connection && !connection.servedByRobot) });
    }
  };
  // Starts from the selected robot. A listed robot reads only through its own address, as Push sends only through it.
  const start = () => {
    if (state.current.open) return;
    origin.current = document.activeElement;
    const project = getProject();
    const robotId = selectedRobotId(project), robotName = projectRobots(project).find((robot) => robot.id === robotId)?.name ?? 'Robot';
    const fileName = robotPushFileName(robotName);
    reviewed.current = { epoch: projectEpoch(), revision: undefined, details: null };
    update({ ...closed, open: true, robotId, robotName, fileName });
    // Another robot's name maps to the same file, so what the robot holds there could be either's.
    const conflict = robotPushFileConflict(project, robotId);
    const problem = conflict || (connection?.servedByRobot ? null : pushConnectionProblem(project, connection?.pairing?.endpoint ?? null, 'pulling its details'));
    if (conflict) { update({ phase: 'conflict', error: conflict }); return; }
    if (problem || (!connection?.servedByRobot && !connection?.connection)) {
      update({ phase: 'failed', canConnect: true, error: problem || `Connect to ${robotName} and verify its host key before pulling its details.` });
      return;
    }
    void read(fileName);
  };
  const close = () => {
    generation.current += 1;
    update({ ...closed });
  };
  const returnFocus = () => focusIfAvailable(origin.current);
  // Why Apply must not use this review now, or null: the project was replaced, or the robot's details changed since.
  const stale = (robotId) => replaced() ? REPLACED : detailsText(getProject(), robotId) !== reviewed.current.details ? CHANGED : null;
  const apply = async () => {
    const current = state.current;
    if (current.phase !== 'review' || !current.incoming || current.problems.length || current.applying) return;
    const refuse = (error, canRetry = false) => update({ phase: 'failed', error, canRetry, canConnect: false, applying: false, incoming: null, changes: [], problems: [] });
    let reason = stale(current.robotId);
    if (reason) { generation.current += 1; refuse(reason, reason === CHANGED); return; }
    if (!Object.is(projectRevision(), reviewed.current.revision)) {
      const request = ++generation.current, revision = projectRevision();
      update({ applying: true });
      let problems;
      try { problems = await check(getProject(), current.robotId, current.incoming.robot); }
      catch (error) { if (request === generation.current) update({ phase: 'invalid', error: message(error), applying: false }); return; }
      if (request !== generation.current) return;
      reason = stale(current.robotId) ?? (Object.is(projectRevision(), revision) ? null : KEPT_CHANGING);
      if (reason) { refuse(reason, reason !== REPLACED); return; }
      reviewed.current.revision = revision;
      if (problems.length) { update({ problems, applying: false }); return; }
    }
    const applied = onApply(current.robotId, current.incoming.robot);
    if (applied) close();
    else refuse('This robot is no longer in the project. Nothing changed.');
  };
  const openConnection = () => { close(); connection?.openConnection?.(); };
  return { ...view, available: Boolean(api?.readRobotFiles && api?.validateProject), busy: view.phase === 'reading' || view.applying, start, read, close, returnFocus, apply, openConnection,
    choose: () => update({ phase: 'choose', error: '' }) };
}

function ChangeTable({ changes, robotName }) {
  return h('div', { className: 'rfp-pull-scroll', tabIndex: 0, 'aria-label': 'Changes' },
    h('table', { className: 'rfp-compare-table rfp-pull-table', 'aria-label': 'Changes to ' + robotName },
      h('thead', null, h('tr', null, h('td', null), h('th', { scope: 'col' }, 'This robot'), h('th', { scope: 'col' }, 'On robot'))),
      changes.map(({ section, rows }) => h('tbody', { key: section },
        h('tr', { className: 'rfp-pull-section' }, h('th', { scope: 'rowgroup', colSpan: 3 }, section)),
        rows.map((row) => h('tr', { key: row.label, 'data-changed': true },
          h('th', { scope: 'row' }, row.label), h('td', { className: row.before === 'Not set' ? 'rfp-absent' : undefined }, row.before),
          h('td', { className: row.after === 'Not set' ? 'rfp-absent' : undefined }, row.after)))))));
}

export function RobotPullDialog({ pull: p }) {
  const dialog = React.useRef(null);
  React.useEffect(() => {
    if (p.open && !dialog.current.open) dialog.current.showModal();
    else if (!p.open && dialog.current.open) { dialog.current.close(); p.returnFocus(); }
  }, [p.open]);
  // Each view says which control takes focus (never Apply); the dialog's first control otherwise.
  React.useEffect(() => {
    if (p.open) dialog.current.querySelector('[data-pull-focus]')?.focus();
  }, [p.open, p.phase]);
  const endpoint = p.endpoint;
  const where = endpoint && h('div', { key: 'dest', className: 'rfp-dest' }, h('div', { className: 'rfp-dest-text' },
    h('strong', null, p.fileName, p.readAt && h('span', { className: 'rfp-dest-status' }, 'Read ' + timeOfDay(p.readAt))),
    h('span', null, address(endpoint) + ' · ' + ROBOT_TARGETS[endpoint.target].label + ' · ' + endpoint.directory)));
  const fact = p.error && shortFact(p.error);
  const alert = p.error && h('div', { key: 'alert' }, h('p', { className: 'rfp-alert', role: 'alert' }, fact),
    p.error.replace(/\.$/, '') !== fact && h('details', { className: 'rfp-error-details' }, h('summary', null, 'Details'), h('p', null, p.error)));
  const close = (label = 'Close', primary = true) => button(label, p.close, { key: 'close', className: primary ? 'qbtn primary' : 'qbtn', 'data-pull-focus': true });
  let body = null, actions = [];
  if (p.phase === 'reading') {
    body = h('p', { role: 'status', className: 'rfp-view-working' }, h('span', { className: 'robot-push-spinner' }), 'Reading ' + p.fileName + '…');
    actions = [button('Cancel', p.close, { key: 'cancel', 'data-pull-focus': true })];
  } else if (p.phase === 'choose') {
    body = [where, h('p', { key: 'intro' }, 'The robot has no ' + p.fileName + '. Read robot details from another file in this folder:'),
      h('ul', { key: 'list', className: 'rfp-files rfp-pull-choices', 'aria-label': 'Robot files' }, p.choices.map((name, index) => h('li', { key: name },
        h('span', { className: 'rfp-file-name' }, name.replace(/\.robot$/i, '')),
        button('Read', () => p.read(name), { 'aria-label': 'Read ' + name, 'data-robot-file': name, ...(index === 0 ? { 'data-pull-focus': true } : {}) }))))];
    actions = [close('Cancel', false)];
  } else if (p.phase === 'missing') {
    body = [where, h('p', { key: 'none' }, 'The robot has no robot details in this folder yet. Push with Robot details checked to send them.')];
    actions = [close()];
  } else if (p.phase === 'invalid') {
    body = [where, h('p', { key: 'alert', className: 'rfp-alert', role: 'alert' }, p.fileName + ' can’t be used. ' + p.error + ' Nothing changed.')];
    actions = [p.choices.length > 0 && button('Choose another', p.choose, { key: 'choose' }), close()];
  } else if (p.phase === 'conflict') {
    // Shown whole: the fix (renaming one robot) needs both names.
    body = h('p', { className: 'rfp-alert', role: 'alert' }, p.error);
    actions = [close()];
  } else if (p.phase === 'same') {
    body = [where, h('p', { key: 'same', role: 'status' }, h('strong', null, 'Same as ' + p.robotName + '.'), ' Pulling would change nothing.')];
    actions = [close('Done')];
  } else if (p.phase === 'review') {
    const count = p.changes.reduce((sum, group) => sum + group.rows.length, 0);
    body = [where,
      h('p', { key: 'intro' }, 'Apply replaces ' + p.robotName + '’s details with ' + (count === 1 ? 'this value from the robot.' : 'these ' + count + ' values from the robot.') + ' Undo puts the robot back as it was, until you change it again.'),
      p.incoming.name !== p.robotName && h('p', { key: 'name', className: 'rfp-note' }, 'The file is named for “' + p.incoming.name + '”. Apply keeps the name ' + p.robotName + '.'),
      p.problems.length > 0 && h('div', { key: 'problems', className: 'rfp-pull-problems', role: 'alert' },
        h('p', { className: 'rfp-alert' }, 'Apply would give the project ' + (p.problems.length === 1 ? 'an error' : p.problems.length + ' errors') + ' Save refuses, so it is off. Change ' + (p.problems.length === 1 ? 'this' : 'these') + ' first, then pull again:'),
        h('ul', null, p.problems.map((problem) => h('li', { key: problem }, problem)))),
      h(ChangeTable, { key: 'changes', changes: p.changes, robotName: p.robotName })];
    // Apply is never focused automatically, as Upload isn't: a held Enter must not apply a review.
    actions = [button('Cancel', p.close, { key: 'cancel', 'data-pull-focus': true }),
      button(p.applying ? 'Applying…' : 'Apply', p.apply, { key: 'apply', className: 'qbtn primary', disabled: p.problems.length > 0 || p.applying })];
  } else if (p.phase === 'failed') {
    body = [alert];
    actions = [p.canConnect && button('Open connection', p.openConnection, { key: 'connect', className: p.canRetry ? 'qbtn' : 'qbtn primary' }),
      button('Close', p.close, { key: 'close', 'data-pull-focus': true }),
      p.canRetry && button('Try again', () => p.read(p.fileName), { key: 'retry', className: 'qbtn primary' })];
  }
  return h('dialog', { ref: dialog, className: 'robot-push-dialog robot-manager rfp rfp-pull', 'aria-labelledby': 'robot-pull-title', 'aria-busy': p.busy,
    onCancel: (event) => { event.preventDefault(); p.close(); } },
    h('header', null, h('h2', { id: 'robot-pull-title' }, 'Pull from robot'), h('button', { type: 'button', className: 'robot-push-close', 'aria-label': 'Close pull from robot', onClick: p.close }, '×')),
    h('div', { key: p.phase, className: 'rfp-body rfp-view-pull' }, body),
    h('footer', { className: 'rfp-footer' }, h('div', { className: 'rfp-actions' }, actions)));
}
