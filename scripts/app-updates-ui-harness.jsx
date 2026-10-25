import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { AppUpdateDialog } from '../src/renderer/components/AppUpdateDialog';
import { useAppUpdates } from '../src/renderer/components/useAppUpdates';
import { Panels } from '../src/renderer/components/Panels';
import '../src/renderer/styles/app.css';
const h = React.createElement;
let state = { phase: 'idle', currentVersion: '0.2.0-beta.10', version: null, channel: 'beta', visible: false, projectDirty: false, releaseNotes: '', progress: null, error: null, errorStage: null };
const listeners = new Set(), calls = [];
const set = (patch) => { state = { ...state, ...patch }; listeners.forEach(fn => fn(state)); return Promise.resolve(state); };
window.__updateFixture = { set, calls };
window.bordeauxAPI = {
  platform: 'darwin', getAppUpdateState: async () => state,
  onAppUpdateState: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  setAppUpdatesVisible: (visible) => set({ visible }),
  checkAppUpdates: () => { calls.push('check'); return set({ phase: 'checking', error: null }); },
  downloadAppUpdate: () => { calls.push('download'); return set({ phase: 'downloading', progress: { percent: 0, total: 104857600, transferred: 0, bytesPerSecond: 0 } }); },
  cancelAppUpdateDownload: () => { calls.push('cancel'); return set({ phase: 'available', progress: null }); },
  installAppUpdate: () => { calls.push('install'); return set({ phase: 'installing' }); },
  openAppUpdateReleases: () => { calls.push('releases'); return Promise.resolve(); },
  copyAppUpdateDetails: () => { calls.push('copy'); return Promise.resolve(); },
};
function Harness() {
  const { state, actions } = useAppUpdates();
  return h(React.Fragment, null,
    h(Panels.Toolbar, { page: 'robot', editorPage: 'plan', setPage: () => {}, updateState: state, onOpenUpdates: () => window.bordeauxAPI.setAppUpdatesVisible(true), onInstallUpdate: actions.onInstall }),
    h('main', { style: { height: 'calc(100vh - 56px)', padding: 48, background: 'var(--bg-0)' } },
    h('h1', { style: { fontSize: 20 } }, 'Bordeaux'), h('p', null, 'Editor workspace'),
    h('button', { id: 'update-trigger', className: 'qbtn', onClick: () => window.bordeauxAPI.setAppUpdatesVisible(true) }, 'Software updates'),
    h('button', { id: 'editor-action', className: 'qbtn', onClick: () => calls.push('editor') }, 'Editor action'),
    h(AppUpdateDialog, { state, ...actions })));
}
createRoot(document.getElementById('root')).render(h(Harness));
