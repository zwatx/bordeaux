import * as React from 'react';

export function useAppUpdates(api = globalThis.window?.bordeauxAPI) {
  const [state, setState] = React.useState(null);
  // Whether main's update state has been learned: 'pending' until its first event or answer, 'known' after, and
  // 'unavailable' when there is no updater bridge or the first query failed with nothing received. Never inferred from time.
  const [known, setKnown] = React.useState(() => api?.getAppUpdateState ? 'pending' : 'unavailable');
  React.useEffect(() => {
    if (!api?.getAppUpdateState) return;
    let alive = true, received = false;
    const unsubscribe = api.onAppUpdateState((next) => { received = true; if (alive) { setState(next); setKnown('known'); } });
    Promise.resolve(api.getAppUpdateState()).then((next) => { if (alive && !received) { setState(next); setKnown('known'); } },
      () => { if (alive && !received) setKnown('unavailable'); });
    return () => { alive = false; unsubscribe?.(); };
  }, [api]);
  const actions = React.useMemo(() => ({
    onClose: () => api?.setAppUpdatesVisible(false),
    onCheck: () => api?.checkAppUpdates(), onDownload: () => api?.downloadAppUpdate(),
    onCancel: () => api?.cancelAppUpdateDownload(), onInstall: () => api?.installAppUpdate(),
    onOpenReleases: () => api?.openAppUpdateReleases(), onCopyDetails: () => api?.copyAppUpdateDetails(),
  }), [api]);
  return { state, known, actions };
}
