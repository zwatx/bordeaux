import { useEffect, useRef, useState } from 'react';
import { ROBOT_TARGETS, allowsCustomPassword } from '../../shared/robotTargets';
import { focusIfAvailable } from '../lib/focusReturn';
import { linkedPathIds } from '../lib/undoHistory';

const message = (error) => (error?.message || String(error || 'File transfer failed'))
  .replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^(?:RobotTransportError|Error):\s*/, '');
// Mirrors main's MAX_BDX_BATCH so Include can refuse before discarding a valid review; main stays authoritative.
export const MAX_PUSH_PATHS = 64;
/** Paths connected to `pathIds` through endpoint or shared-point links, outside them, in project order. */
export function linkedOutside(project, pathIds) {
  const chosen = new Set(pathIds), linked = new Set(linkedPathIds(project, pathIds));
  // Pushable is the toolbar's eligibility rule only; main still decides whether the files can be prepared.
  return project.paths.filter((path) => linked.has(path.id) && !chosen.has(path.id))
    .map((path) => ({ id: path.id, name: path.name, pushable: (path.waypoints?.length || 0) >= 2 }));
}
const disconnected = { monitoring: false, reachability: 'unknown' };
const emptyReview = { preview: null, result: null };
const working = (phase) => ['loading', 'saving', 'probing', 'trusting', 'preparing', 'uploading'].includes(phase);

export function useRobotFilePushController({ getProject, projectKey, catalogKey, bookmarkKey }) {
  const api = window.bordeauxAPI;
  const [view, setView] = useState({ open: false, phase: 'loading', settings: null, editing: false, connection: null, ...disconnected, probe: null, ...emptyReview, error: '', passwordStatus: { custom: false, persistent: false } });
  const [target, setTarget] = useState('roborio');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [directory, setDirectory] = useState(ROBOT_TARGETS.roborio.defaultDirectory);
  // A typed password replaces the one in effect on Connect or Save; useDefault returns to the robot type's default.
  // Main never sends the password back, only its status.
  const [password, setTypedPassword] = useState('');
  const [useDefault, setUseDefault] = useState(false);
  const state = useRef(view);
  const generation = useRef(0);
  const intent = useRef(null);
  const origin = useRef(null);
  const trusted = useRef(null);
  const source = useRef(getProject); source.current = getProject;
  const context = useRef({ projectKey, catalogKey, bookmarkKey });
  const update = (patch) => { state.current = { ...state.current, ...patch }; setView(state.current); };
  const discard = async (preview) => { if (preview) await api.cancelRobotFiles(preview.operationId); };
  const passwordChange = () => !allowsCustomPassword(target) ? { kind: 'keep' } : password ? { kind: 'custom', password } : useDefault ? { kind: 'default' } : { kind: 'keep' };
  const refreshPassword = async () => {
    try { update({ passwordStatus: await api.getRobotFilePassword() }); } catch { /* The status only shapes the field's hint. */ }
  };
  const committedPassword = () => { setTypedPassword(''); setUseDefault(false); return refreshPassword(); };
  // Drafts never outlive the form they were typed in, and a login error is stale once the password changes.
  const discardPasswordDraft = () => { setTypedPassword(''); setUseDefault(false); };
  const setPassword = (value) => { setTypedPassword(value); if (value) setUseDefault(false); if (state.current.error) update({ error: '' }); };
  const useDefaultPassword = () => { setTypedPassword(''); setUseDefault(true); };
  const keepSavedPassword = () => setUseDefault(false);
  const prepare = async () => {
    if (!intent.current) return;
    const request = ++generation.current;
    const captured = intent.current;
    update({ phase: 'preparing', ...emptyReview, error: '' });
    try {
      const preview = captured.scope.kind === 'routine'
        ? await api.prepareRobotRoutine(captured.project, captured.scope.routineId)
        : await api.prepareRobotFiles(captured.project, captured.pathIds);
      if (request !== generation.current || intent.current !== captured) { await discard(preview); return; }
      // The linked note is a renderer-only annotation; it shares the preview's lifecycle and never reaches main.
      update({ preview: { ...preview, linked: captured.linked }, phase: 'review' });
    } catch (error) { if (request === generation.current && intent.current === captured) update({ phase: 'failed', error: message(error) }); }
  };
  useEffect(() => {
    let live = true;
    const request = generation.current;
    api.getRobotFileConnection().then((settings) => {
      if (!live || request !== generation.current) return;
      if (settings) { setTarget(settings.endpoint.target); setHost(settings.endpoint.host); setPort(String(settings.endpoint.port)); setDirectory(settings.endpoint.directory); }
      const connection = settings?.hostKeyFingerprint ? settings : null;
      trusted.current = connection;
      update({ settings, connection, phase: 'idle' });
      if (connection && intent.current) void prepare();
      void refreshPassword();
    }).catch((error) => { if (live && request === generation.current) update({ phase: 'idle', error: message(error) }); });
    return () => { live = false; generation.current += 1; };
  }, []);
  useEffect(() => {
    // Remembered SSH trust is not evidence of a live robot. Start only after explicit Connect or Upload,
    // never when restoring an address or saving locally. Checks do not invalidate immutable file reviews.
    if (!view.monitoring || !view.connection || !api.checkRobotFileConnection) return;
    let live = true, timer;
    const checkedConnection = view.connection;
    const check = async () => {
      if (!live || !state.current.monitoring || state.current.connection !== checkedConnection) return;
      if (!working(state.current.phase)) {
        const request = generation.current;
        let observed = null;
        try { observed = await api.checkRobotFileConnection(); } catch { /* Offline is an ordinary state. */ }
        if (!live || !state.current.monitoring || state.current.connection !== checkedConnection) return;
        const matches = observed?.endpoint.host === checkedConnection.endpoint.host && observed?.endpoint.port === checkedConnection.endpoint.port
          && observed?.hostKeyFingerprint === checkedConnection.hostKeyFingerprint;
        if (request === generation.current) update({ reachability: matches ? 'online' : 'offline' });
      }
      if (live) timer = setTimeout(check, 5_000);
    };
    timer = setTimeout(check, 5_000);
    return () => { live = false; clearTimeout(timer); };
  }, [view.monitoring, view.connection]);
  useEffect(() => {
    const previous = context.current;
    context.current = { projectKey, catalogKey, bookmarkKey };
    if (previous.projectKey === projectKey && previous.catalogKey === catalogKey && previous.bookmarkKey === bookmarkKey) return;
    // Only a push captured from the previous project is stale; the connection itself, and its views, are not.
    const captured = intent.current || state.current.preview || state.current.phase === 'preparing';
    intent.current = null;
    // An already confirmed upload owns its immutable files even after navigation.
    if (!captured || state.current.phase === 'uploading' || state.current.phase === 'saving') return;
    generation.current += 1;
    void discard(state.current.preview).catch(() => undefined);
    update({ ...emptyReview, phase: 'idle', error: 'The project changed. Choose Push again to review the current files.' });
  }, [projectKey, catalogKey, bookmarkKey]);
  // A folder still at the previous type's default follows the new type; a folder the user typed stays.
  // A login error is about the previous type, so choosing another one clears it.
  const chooseTarget = (next) => {
    if (next === target || !ROBOT_TARGETS[next]) return;
    const current = directory.trim();
    if (!current || current === ROBOT_TARGETS[target].defaultDirectory) setDirectory(ROBOT_TARGETS[next].defaultDirectory);
    setTarget(next);
    update({ error: '' });
  };
  const show = () => { if (!state.current.open) origin.current = document.activeElement; update({ open: true }); };
  const returnFocus = () => focusIfAvailable(origin.current);
  const close = () => {
    discardPasswordDraft();
    if (['probing', 'identity'].includes(state.current.phase)) {
      generation.current += 1;
      void api.cancelRobotFileProbe().catch(() => {});
      update({ probe: null, phase: 'idle' });
    }
    update({ open: false });
  };
  const requestPush = async (scope) => {
    show();
    if (working(state.current.phase) && state.current.phase !== 'loading') return;
    if (!['paths', 'routine'].includes(scope?.kind)) {
      intent.current = null;
      void discard(state.current.preview).catch(() => undefined);
      update({ error: 'Choose paths or one routine to push.', phase: 'unsupported', ...emptyReview }); return;
    }
    if (scope.kind === 'paths' ? !scope.pathIds?.length : !scope.routineId) { intent.current = null; update({ error: 'Select paths or one routine to push.', phase: 'failed', preview: null }); return; }
    const previous = state.current.preview;
    const project = structuredClone(source.current()), pathIds = scope.kind === 'paths' ? [...scope.pathIds] : [];
    const captured = intent.current = { project, scope: structuredClone(scope), pathIds, projectKey, linked: scope.kind === 'paths' ? linkedOutside(project, pathIds) : [] };
    const request = generation.current;
    const wasLoading = state.current.phase === 'loading';
    update({ ...emptyReview, error: '', phase: wasLoading ? 'loading' : 'preparing' });
    try { await discard(previous); }
    catch (error) { if (request === generation.current && intent.current === captured) update({ phase: 'failed', error: message(error) }); return; }
    if (request !== generation.current || intent.current !== captured) return;
    if (state.current.connection) await prepare();
    else if (!wasLoading) update({ phase: 'idle' });
  };
  const probeRobot = async () => {
    if (working(state.current.phase)) return;
    const request = ++generation.current;
    update({ phase: 'probing', probe: null, error: '', ...disconnected });
    try {
      const probe = await api.probeRobotFiles({ target, host: host.trim(), port: Number(port), directory: directory.trim() }, passwordChange());
      if (request !== generation.current) return;
      update({ probe, phase: 'identity' });
      const saved = trusted.current;
      if (saved?.endpoint.host === probe.endpoint.host && saved.endpoint.port === probe.endpoint.port
        && saved.hostKeyFingerprint === probe.hostKeyFingerprint) await acceptPairing(probe, request);
    } catch (error) { if (request === generation.current) update({ phase: 'idle', error: message(error) }); }
  };
  const saveSettings = async () => {
    if (working(state.current.phase)) return;
    const request = ++generation.current;
    update({ phase: 'saving', error: '' });
    try {
      const settings = await api.saveRobotFileSettings({ target, host: host.trim(), port: Number(port), directory: directory.trim() }, passwordChange());
      if (request !== generation.current) return;
      const connection = settings.hostKeyFingerprint ? settings : null;
      trusted.current = connection;
      intent.current = null;
      setTarget(settings.endpoint.target); setHost(settings.endpoint.host); setPort(String(settings.endpoint.port)); setDirectory(settings.endpoint.directory);
      update({ settings, connection, editing: false, probe: null, ...emptyReview, phase: 'idle', ...disconnected });
      await committedPassword();
    } catch (error) { if (request === generation.current) update({ phase: 'idle', error: message(error) }); }
  };
  const acceptPairing = async (probe, request) => {
    update({ phase: 'trusting', error: '' });
    try {
      const connection = await api.trustRobotFiles(probe.hostKeyFingerprint);
      if (request !== generation.current) return;
      trusted.current = connection;
      update({ settings: connection, connection, editing: false, probe: null, phase: 'idle', monitoring: true, reachability: 'online' });
      await committedPassword();
      if (intent.current) await prepare();
    } catch (error) { if (request === generation.current) update({ phase: 'identity', error: message(error) }); }
  };
  const confirmPairing = async () => {
    if (working(state.current.phase) || !state.current.probe) return;
    await acceptPairing(state.current.probe, ++generation.current);
  };
  const confirmPush = async () => {
    if (state.current.phase !== 'review' || !state.current.preview) return;
    const operationId = state.current.preview.operationId;
    generation.current += 1; // Older liveness evidence cannot override this transfer's result.
    update({ phase: 'uploading', error: '' });
    try {
      const result = await api.confirmRobotFiles(operationId);
      intent.current = null;
      update({ result, preview: null, phase: 'transferred', monitoring: true, reachability: 'online' });
    }
    catch (error) { update({ phase: 'failed', error: message(error), reachability: 'offline' }); }
  };
  const cancel = async () => {
    const preview = state.current.preview;
    if (!preview) return;
    const uploading = state.current.phase === 'uploading';
    if (!uploading) update({ phase: 'preparing' });
    try {
      const answer = await api.cancelRobotFiles(preview.operationId);
      if (state.current.preview?.operationId !== preview.operationId) return;
      // Canceling a review is a way out, not a destination: close and return focus.
      if (answer.canceled && !uploading) { intent.current = null; update({ preview: null, phase: 'cancelled', open: false }); }
      else if (!answer.canceled) update({ error: 'Transfer can no longer be canceled. Wait for its verified result.', ...(!uploading ? { phase: 'review' } : {}) });
      // Keep the upload locked until its confirmation promise settles.
    } catch (error) {
      // A late failure for an operation that navigation or a new review already replaced changes nothing.
      if (state.current.preview?.operationId !== preview.operationId) return;
      update({ error: message(error), ...(!uploading ? { phase: 'review' } : {}) });
    }
  };
  // Widens this review only: the same captured project with its linked, pushable paths added, then a new review.
  const includeLinked = async (operationId) => {
    const captured = intent.current, reviewed = state.current.preview;
    if (state.current.phase !== 'review' || !captured || captured.scope.kind !== 'paths' || reviewed?.operationId !== operationId) return;
    const add = new Set(captured.linked.filter((path) => path.pushable).map((path) => path.id));
    if (!add.size) return;
    const pathIds = captured.project.paths.map((path) => path.id).filter((id) => add.has(id) || captured.pathIds.includes(id));
    if (pathIds.length > MAX_PUSH_PATHS) { update({ error: 'Push sends at most ' + MAX_PUSH_PATHS + ' paths at once. Including these would make ' + pathIds.length + '.' }); return; }
    const next = intent.current = { project: captured.project, scope: { kind: 'paths', pathIds }, pathIds, projectKey: captured.projectKey, linked: linkedOutside(captured.project, pathIds) };
    const request = ++generation.current;
    update({ phase: 'preparing', ...emptyReview, error: '' });
    try { await discard(reviewed); }
    catch (error) { if (request === generation.current && intent.current === next) update({ phase: 'failed', error: message(error) }); return; }
    if (request === generation.current && intent.current === next) await prepare();
  };
  const chooseAnotherRobot = async () => {
    if (working(state.current.phase)) return;
    const request = ++generation.current;
    const previous = state.current;
    update({ phase: 'preparing' });
    try { await discard(previous.preview); if (request === generation.current) update({ editing: true, connection: null, probe: null, ...emptyReview, phase: 'idle', error: '', ...disconnected }); }
    catch (error) { if (request === generation.current) update({ phase: previous.phase, error: message(error) }); }
  };
  // Edit from the summary starts a fresh form. Back from identity and Change in a review keep the drafts,
  // so the next Connect still uses the password the user typed or the pending default.
  const editConnection = async () => { discardPasswordDraft(); await chooseAnotherRobot(); };
  const connectionHome = async () => {
    if (working(state.current.phase)) return;
    intent.current = null;
    const request = ++generation.current;
    const previous = state.current;
    update({ phase: 'preparing' });
    try { await discard(previous.preview); if (request === generation.current) update({ ...emptyReview, phase: 'idle', error: '' }); }
    catch (error) { if (request === generation.current) update({ phase: previous.phase, error: message(error) }); }
  };
  return { ...view, fileTransfer: true, target, chooseTarget, host, setHost, port, setPort, directory, setDirectory, password, setPassword, useDefault, useDefaultPassword, keepSavedPassword,
    busy: working(view.phase), canRetry: Boolean(intent.current), desktopAvailable: true, deliveryAvailable: true,
    pairing: view.settings,
    connectionLabel: working(view.phase) ? 'Working…' : view.settings ? view.settings.endpoint.host + (view.reachability === 'online' ? ' · connected' : view.reachability === 'offline' ? ' · disconnected' : ' · not connected') : 'Not set up',
    itemStatus: (kind, id) => working(view.phase) && intent.current?.projectKey === projectKey && (kind === 'path' ? intent.current.pathIds.includes(id) : kind === 'routine' && intent.current.scope.routineId === id)
      ? { label: view.phase === 'uploading' ? 'Uploading' : 'Preparing', detail: 'Selected for SFTP upload.', tone: 'pending' }
      : { label: 'Local', detail: 'Saved locally. Push uploads the selected files over SFTP.', tone: 'muted' },
    openConnection: show, close, returnFocus, requestPush, probeRobot, saveSettings, confirmPairing, confirmPush, cancel, includeLinked, chooseAnotherRobot, editConnection, connectionHome,
    retry: () => intent.current && requestPush(intent.current.scope) };
}
