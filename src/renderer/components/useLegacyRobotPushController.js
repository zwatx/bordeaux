import { useEffect, useRef, useState } from 'react';
import { deploymentInputKey, deploymentInputKeys, deploymentItemStatus } from '../lib/deploymentStatus';
import { focusIfAvailable } from '../lib/focusReturn';

const errorMessage = (error) => error?.message || String(error || 'The robot operation failed');
const clone = (value) => structuredClone(value);
const sending = (phase) => ['uploading', 'uploaded', 'staged'].includes(phase);

export function useLegacyRobotPushController({ getProject, projectKey, catalogKey: suppliedCatalogKey, bookmarkKey }) {
  const catalogKey = String(suppliedCatalogKey || '') + ':' + String(bookmarkKey || '');
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const confirmationLock = useRef(false);
  const [pairing, setPairing] = useState(null);
  const [probe, setProbe] = useState(null);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [phase, setPhase] = useState('idle');
  const [preview, setPreview] = useState(null);
  const [retentionPreview, setRetentionPreview] = useState(null);
  const [status, setStatus] = useState(null);
  const [inspection, setInspection] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [unavailable, setUnavailable] = useState(null);
  const [adoptBaseline, setAdoptBaseline] = useState(false);
  const [clock, setClock] = useState(Date.now);
  const intent = useRef(null);
  const generation = useRef(0);
  const inspectGeneration = useRef(0);
  const projectRef = useRef(getProject); projectRef.current = getProject;
  const origin = useRef(null);
  const context = useRef({ projectKey, catalogKey });
  const state = useRef(null);
  const api = typeof window === 'undefined' ? undefined : window.bordeauxAPI;
  const desktopAvailable = Boolean(api?.prepareRobotPush);
  const capabilities = api?.robotDeliveryCapabilities;
  const deliveryAvailable = capabilities?.pathPush === true || capabilities?.routinePush === true;
  const busy = confirming || ['probing', 'pairing', 'preparing', 'retention-preparing', 'uploading', 'uploaded'].includes(phase) || (phase === 'staged' && !result);
  state.current = { phase, preview, retentionPreview, result, busy, confirming };

  useEffect(() => {
    if (!deliveryAvailable) return;
    let live = true;
    api?.getRobotPairing?.().then((saved) => {
      if (!live) return;
      setPairing(saved);
      if (saved) { setHost(saved.endpoint.host); setPort(String(saved.endpoint.port)); }
    }).catch((failure) => { if (live) setError(errorMessage(failure)); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    const previous = context.current;
    context.current = { projectKey, catalogKey };
    if (previous.projectKey === projectKey && previous.catalogKey === catalogKey) return;
    generation.current += 1; inspectGeneration.current += 1;
    intent.current = null; setInspection(null); setStatus(null); setRefreshing(false);
    const current = state.current;
    if (current.preview && current.phase === 'review') void api?.cancelRobotPush(current.preview.operationId).catch(() => undefined);
    if (current.retentionPreview && current.phase === 'retention-review') void api?.cancelRobotRetention(current.retentionPreview.operationId).catch(() => undefined);
    if (current.phase === 'unavailable') return;
    if (!current.confirming && (!sending(current.phase) || current.result)) {
      setPreview(null); setRetentionPreview(null); setResult(null); setPhase('idle');
      setError('The project or Robot catalog changed. Review the update again.');
    }
  }, [projectKey, catalogKey]);

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => api?.onRobotPushState?.((progress) => {
    if (progress.operationId !== state.current.preview?.operationId) return;
    setPhase(progress.state);
    if (progress.state === 'rejected') setResult(progress);
  }), []);
  useEffect(() => api?.onRobotRetentionState?.((progress) => {
    if (progress.operationId !== state.current.retentionPreview?.operationId) return;
    setPhase(progress.state);
    if (progress.state === 'rejected') setResult(progress);
  }), []);

  const show = () => { origin.current = document.activeElement; setOpen(true); };
  const returnFocus = () => focusIfAvailable(origin.current);
  const close = () => {
    setOpen(false);
    requestAnimationFrame(returnFocus);
  };
  const reconcile = (observed) => {
    const current = state.current;
    if (current.result?.state !== 'staged') return;
    const retention = current.retentionPreview;
    const expected = current.preview?.revision || retention?.targetRevision;
    const payload = current.preview?.payloadHash || retention?.payloadHash;
    if (retention?.action === 'pin') {
      if (observed.retention?.revisions.some((entry) => entry.revisionId === expected && entry.payloadSha256 === payload && entry.pinned)) {
        setPhase('pinned'); setResult({ ...current.result, state: 'pinned', reconciled: true });
      }
    } else if (observed.activeRevisionId === expected && observed.activePayloadSha256 === payload) {
      setPhase('active'); setResult({ ...current.result, state: 'active', reconciled: true });
    }
  };
  const refreshStatus = async () => {
    if (!deliveryAvailable) return;
    if (!desktopAvailable || !pairing || refreshing) return;
    const request = ++inspectGeneration.current;
    const captured = clone(projectRef.current());
    const keys = deploymentInputKeys(captured, context.current.catalogKey);
    setRefreshing(true);
    try {
      const checked = await api.inspectRobotLibrary(captured);
      if (request !== inspectGeneration.current) return;
      setStatus(checked.status); setInspection({ ...checked, keys }); setClock(Date.now());
      setError(checked.message || '');
      reconcile(checked.status);
    } catch (failure) {
      if (request !== inspectGeneration.current) return;
      setInspection(null); setStatus(null); setError(errorMessage(failure));
      // History remains available on older runtimes that cannot expose item contents.
      try { const observed = await api.inspectPairedRobot(); if (request === inspectGeneration.current) { setStatus(observed); reconcile(observed); } }
      catch { /* The original, specific read error remains visible. */ }
    } finally { if (request === inspectGeneration.current) setRefreshing(false); }
  };
  const showUnavailable = (scope) => {
    generation.current += 1; inspectGeneration.current += 1;
    const routine = scope?.kind === 'routine';
    const pathId = scope?.kind === 'paths' && scope.pathIds?.length === 1 ? scope.pathIds[0] : null;
    intent.current = null;
    setUnavailable({ kind: routine ? 'routine' : 'path', pathId, reason: routine
      ? 'Routine delivery needs a compatible LabVIEW receiver. Your routine stays saved in this project.'
      : 'Robot delivery needs a compatible LabVIEW BDX receiver. You can export the path file locally.' });
    setPreview(null); setRetentionPreview(null); setProbe(null); setResult(null); setError(''); setRefreshing(false); setPhase('unavailable'); show();
  };
  const openConnection = () => {
    if (!deliveryAvailable) { showUnavailable(null); return; }
    show();
    if (!state.current.busy && !state.current.preview && !state.current.retentionPreview) setError('');
    if (pairing) void refreshStatus();
  };
  const prepareCaptured = async () => {
    if (!intent.current || !desktopAvailable || !deliveryAvailable) return;
    const captured = intent.current;
    const request = ++generation.current;
    setPhase('preparing'); setPreview(null); setRetentionPreview(null); setResult(null); setError(''); setAdoptBaseline(false);
    try {
      const reviewed = await api.prepareRobotPush(captured.project, captured.scope);
      if (request !== generation.current) { await api.cancelRobotPush(reviewed.operationId); return; }
      setPreview(reviewed); setPhase('review');
    } catch (failure) {
      if (request === generation.current) { setPhase('ready'); setError(errorMessage(failure)); }
    }
  };
  const requestPush = async (scope) => {
    if (!desktopAvailable) return;
    const supported = scope?.kind === 'routine' ? capabilities?.routinePush === true : scope?.kind === 'paths' ? capabilities?.pathPush === true : capabilities?.pathPush === true && capabilities?.routinePush === true;
    if (!supported) { showUnavailable(scope); return; }
    setUnavailable(null);
    if (state.current.busy || confirmationLock.current) { show(); return; }
    const old = state.current;
    if (old.preview && old.phase === 'review') await api.cancelRobotPush(old.preview.operationId);
    if (old.retentionPreview && old.phase === 'retention-review') await api.cancelRobotRetention(old.retentionPreview.operationId);
    intent.current = { project: clone(projectRef.current()), scope: clone(scope), projectKey: context.current.projectKey };
    setPreview(null); setRetentionPreview(null); setResult(null); setError(''); show();
    if (pairing) await prepareCaptured(); else setPhase('idle');
  };
  const probeRobot = async () => {
    if (!deliveryAvailable) { showUnavailable(null); return; }
    const request = ++generation.current;
    setPhase('probing'); setError(''); setProbe(null);
    try {
      const observed = await api.probeRobot({ host: host.trim(), port: Number(port) });
      if (request === generation.current) { setProbe(observed); setPhase('pair-review'); }
    } catch (failure) { if (request === generation.current) { setPhase('idle'); setError(errorMessage(failure)); } }
  };
  const confirmPairing = async () => {
    if (!deliveryAvailable) return;
    if (!probe) return;
    setPhase('pairing'); setError('');
    try {
      const saved = await api.confirmRobotPairing(probe.hostKeyFingerprint, probe.status.runtimeId);
      setPairing(saved); setProbe(null); setInspection(null); setStatus(null); setPhase('ready');
      if (intent.current) await prepareCaptured();
    } catch (failure) { setPhase('pair-review'); setError(errorMessage(failure)); }
  };
  const confirmPush = async () => {
    if (!preview || state.current.busy || confirmationLock.current) return;
    confirmationLock.current = true; setConfirming(true);
    setPhase('uploading'); setResult(null); setError('');
    inspectGeneration.current += 1; setInspection(null); setRefreshing(false);
    try {
      const finished = await api.confirmRobotPush(preview.operationId, adoptBaseline);
      setResult(finished); setPhase(finished.state);
      if (finished.receiptWarning) setError(finished.receiptWarning);
      if (finished.state === 'active') void refreshStatus();
    } catch (failure) { setPhase('failed'); setError(errorMessage(failure)); }
    finally { confirmationLock.current = false; setConfirming(false); }
  };
  const cancel = async () => {
    const current = state.current;
    try {
      const operationId = current.retentionPreview?.operationId || current.preview?.operationId;
      if (!operationId) return;
      const answer = current.retentionPreview ? await api.cancelRobotRetention(operationId) : await api.cancelRobotPush(operationId);
      if (answer.canceled && answer.boundary === 'review') { setPhase('cancelled'); setResult({ state: 'cancelled' }); }
      else if (!answer.canceled) setError('This request can no longer be cancelled. Refresh to check the robot.');
    } catch (failure) { setError(errorMessage(failure)); }
  };
  const prepareRetention = async (action, target) => {
    if (!deliveryAvailable) { showUnavailable(null); return; }
    if (state.current.busy) return;
    const request = ++generation.current;
    intent.current = null; setPhase('retention-preparing'); setPreview(null); setRetentionPreview(null); setResult(null); setError('');
    try {
      const reviewed = await api.prepareRobotRetention(clone(projectRef.current()), action, target);
      if (request !== generation.current) { await api.cancelRobotRetention(reviewed.operationId); return; }
      setRetentionPreview(reviewed); setPhase('retention-review');
    } catch (failure) { if (request === generation.current) { setPhase('ready'); setError(errorMessage(failure)); } }
  };
  const confirmRetention = async () => {
    if (!retentionPreview || state.current.busy || confirmationLock.current) return;
    confirmationLock.current = true; setConfirming(true);
    setPhase('uploading'); setResult(null); setError(''); setInspection(null);
    inspectGeneration.current += 1; setRefreshing(false);
    try {
      const finished = await api.confirmRobotRetention(retentionPreview.operationId);
      setResult(finished); setPhase(finished.state);
      if (['active', 'pinned'].includes(finished.state)) void refreshStatus();
    } catch (failure) { setPhase('failed'); setError(errorMessage(failure)); }
    finally { confirmationLock.current = false; setConfirming(false); }
  };
  const connectionHome = () => { if (state.current.busy) return; intent.current = null; setPreview(null); setRetentionPreview(null); setResult(null); setPhase('ready'); setError(''); };
  const chooseAnotherRobot = () => {
    if (state.current.busy) return;
    generation.current += 1; inspectGeneration.current += 1;
    setRefreshing(false);
    if (state.current.phase === 'review' && state.current.preview) void api.cancelRobotPush(state.current.preview.operationId).catch((failure) => setError(errorMessage(failure)));
    if (state.current.phase === 'retention-review' && state.current.retentionPreview) void api.cancelRobotRetention(state.current.retentionPreview.operationId).catch((failure) => setError(errorMessage(failure)));
    setPairing(null); setProbe(null); setPreview(null); setRetentionPreview(null); setInspection(null); setStatus(null); setResult(null); setError(''); setPhase('idle');
  };
  const itemStatus = (kind, id) => {
    const selected = preview?.summary?.pathIds || intent.current?.scope?.pathIds || [];
    const routineSelected = intent.current?.scope?.kind === 'routine' && intent.current.scope.routineId === id;
    if (state.current.busy && intent.current?.projectKey === context.current.projectKey && (kind === 'path' ? selected.includes(id) : routineSelected)) {
      return { label: phase === 'staged' ? 'Awaiting acceptance' : phase === 'preparing' ? 'Preparing' : 'Sending', tone: 'pending' };
    }
    const list = kind === 'path' ? 'paths' : 'routines';
    return deploymentItemStatus(inspection?.comparison?.[list]?.[id], inspection?.keys?.[list]?.[id],
      deploymentInputKey(projectRef.current(), kind, id, context.current.catalogKey), inspection?.verifiedAt, clock);
  };
  const connectionLabel = !deliveryAvailable ? 'Robot delivery unavailable' : busy ? (phase === 'staged' ? 'Awaiting robot' : 'Robot, Working')
    : !pairing ? 'Connect robot' : status ? 'Team ' + pairing.teamNumber : 'Team ' + pairing.teamNumber + ', Not checked';
  return { open, close, returnFocus, pairing, probe, host, setHost, port, setPort, phase, preview, retentionPreview, status, inspection,
    refreshing, result, error, unavailable, deliveryAvailable, adoptBaseline, setAdoptBaseline, desktopAvailable, busy, connectionLabel, itemStatus,
    requestPush, openConnection, refreshStatus, probeRobot, confirmPairing, confirmPush, cancel, prepareRetention,
    confirmRetention, chooseAnotherRobot, connectionHome, retry: () => intent.current && requestPush(intent.current.scope) };
}
