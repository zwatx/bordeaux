const { contextBridge, ipcRenderer } = require('electron');
const noop = () => () => undefined;
const forbidden = (name) => (...args) => ipcRenderer.invoke('branches:robot-call', name, args);
contextBridge.exposeInMainWorld('bordeauxAPI', {
  ...(process.argv.includes('--updates-ui-fixture') ? {
    getAppUpdateState: () => ipcRenderer.invoke('updates:state'),
    setAppUpdatesVisible: visible => ipcRenderer.invoke('updates:visible', visible),
    onAppUpdateState: handler => { const listener = (_event, state) => handler(state); ipcRenderer.on('updates:changed', listener); return () => ipcRenderer.removeListener('updates:changed', listener); },
  } : {}),
  platform: 'darwin', restoreLastProject: () => ipcRenderer.invoke('branches:restore'),
  openRecentRobotProject: () => ipcRenderer.invoke('branches:catalog'), // Local mocked catalog, no NI/robot connection.
  linkRobotProject: () => ipcRenderer.invoke('branches:catalog'), // Placement mode's late link; the same local mock.
  saveProject: (project) => ipcRenderer.invoke('branches:save', project),
  publishAgentSession: (snapshot) => ipcRenderer.send('branches:published', snapshot.project),
  recordBranchHarnessConfirm: (message) => ipcRenderer.send('branches:confirm', message),
  robotDeliveryCapabilities: Object.freeze({ pathPush: true, routinePush: false, fileTransfer: true }),
  getRobotFileConnection: async () => null, // Local offline settings read, not a transport.
  ...Object.fromEntries(['prepareRobotFiles', 'probeRobotFiles', 'saveRobotFileSettings', 'trustRobotFiles', 'confirmRobotFiles', 'cancelRobotFiles',
    'prepareRobotPush', 'confirmRobotPush', 'cancelRobotPush', 'pinRobotRevision', 'rollbackRobotRevision', 'connectRobot', 'disconnectRobot', 'exportRobot'].map(name => [name, forbidden(name)])),
  autosaveProject: async () => ({ saved: false }), setDirty: () => undefined,
  listRecentRobotProjects: async () => [], getMcpStatus: async () => ({ enabled: true, generation: 1 }),
  getActiveAgentProposal: async () => null, onMcpStatus: noop, onAgentProposal: noop, onMenuCommand: noop,
});
