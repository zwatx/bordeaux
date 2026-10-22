import { useEffect, useRef, useState } from 'react';
import { useRobotFilePushController } from './useRobotFilePushController';
import { focusIfAvailable } from '../lib/focusReturn';

function useUnavailableRobotPushController({ projectKey }) {
  const [open, setOpen] = useState(false);
  const [unavailable, setUnavailable] = useState(null);
  const origin = useRef(null);
  useEffect(() => { setUnavailable(null); }, [projectKey]);
  const returnFocus = () => focusIfAvailable(origin.current);
  const close = () => { setOpen(false); requestAnimationFrame(returnFocus); };
  const show = (scope) => {
    if (!open) origin.current = document.activeElement;
    const routine = scope?.kind === 'routine';
    setUnavailable({ kind: routine ? 'routine' : 'path',
      pathId: scope?.kind === 'paths' && scope.pathIds?.length === 1 ? scope.pathIds[0] : null,
      reason: routine ? 'Push sends paths only. Routines stay local.'
        : 'Robot transfer unavailable. Export the path locally.' });
    setOpen(true);
  };
  return { open, unavailable, phase: 'unavailable', busy: false, error: '', deliveryAvailable: false,
    desktopAvailable: typeof window !== 'undefined' && Boolean(window.bordeauxAPI),
    connectionLabel: 'Robot delivery unavailable',
    itemStatus: () => ({ label: 'Local', tone: 'muted' }),
    requestPush: show, openConnection: () => show(null), close, returnFocus,
    probeRobot: () => {}, confirmPairing: () => {}, refreshStatus: () => {} };
}

export function useRobotPushController(props) {
  // Desktop capabilities are fixed for the lifetime of the renderer. Revision delivery is retired.
  return typeof window !== 'undefined' && window.bordeauxAPI?.robotDeliveryCapabilities?.fileTransfer === true
    ? useRobotFilePushController(props) : useUnavailableRobotPushController(props);
}
