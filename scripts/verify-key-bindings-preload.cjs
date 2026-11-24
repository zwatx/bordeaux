// Host for verify-key-bindings: a local project fixture, no robot transport. The platform comes from
// BORDEAUX_KEYS_PLATFORM so one run checks macOS labels (⌘) and another Windows labels (Ctrl).
const { contextBridge, ipcRenderer } = require('electron');
const noop = () => () => undefined;
// Any robot call fails the run: no key in this test may reach a robot.
const forbidden = (name) => (...args) => ipcRenderer.invoke('keys:robot-call', name, args);
contextBridge.exposeInMainWorld('bordeauxAPI', {
  platform: process.env.BORDEAUX_KEYS_PLATFORM || 'win32',
  restoreLastProject: () => ipcRenderer.invoke('keys:restore'),
  saveProject: (project) => ipcRenderer.invoke('keys:save', project),
  robotDeliveryCapabilities: Object.freeze({ pathPush: true, routinePush: false, fileTransfer: true }),
  getRobotFileConnection: async () => null,
  // Key rules go through the harness's main process, which checks them with the built sanitizeUserKeyRules.
  getKeyRules: () => ipcRenderer.invoke('keys:get-rules'),
  setKeyRules: (rules) => ipcRenderer.invoke('keys:set-rules', rules),
  setKeyRecording: (recording) => ipcRenderer.invoke('keys:recording', recording),
  ...Object.fromEntries(['prepareRobotFiles', 'probeRobotFiles', 'saveRobotFileSettings', 'trustRobotFiles', 'confirmRobotFiles', 'cancelRobotFiles',
    'prepareRobotPush', 'confirmRobotPush', 'cancelRobotPush', 'pinRobotRevision', 'rollbackRobotRevision', 'connectRobot', 'disconnectRobot', 'exportRobot'].map(name => [name, forbidden(name)])),
  autosaveProject: async () => ({ saved: false }), setDirty: () => undefined,
  // The Projects sheet reads these when a key opens it; nothing is opened or created.
  listRecentProjects: async () => [], getProjectCreationDefaults: async () => ({ parentDirectory: '/fixture/projects', parentLabel: 'projects' }),
  listRecentRobotProjects: async () => [], getMcpStatus: async () => ({ enabled: false, generation: 1 }),
  getActiveAgentProposal: async () => null, onMcpStatus: noop, onAgentProposal: noop, onMenuCommand: noop,
});
