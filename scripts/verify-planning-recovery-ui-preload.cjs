const { contextBridge, ipcRenderer } = require('electron');
const noop = () => () => undefined;
contextBridge.exposeInMainWorld('bordeauxAPI', {
  platform: 'darwin', restoreLastProject: () => ipcRenderer.invoke('branches:restore'),
  openRecentRobotProject: () => ipcRenderer.invoke('branches:catalog'),
  saveProject: (project) => ipcRenderer.invoke('branches:save', project),
  autosaveProject: (project) => ipcRenderer.invoke('branches:autosave', project), setDirty: () => undefined,
  exportBdx: () => ipcRenderer.invoke('branches:export'),
  listRecentRobotProjects: async () => [], getMcpStatus: async () => ({ enabled: false }),
  getActiveAgentProposal: async () => null, onMcpStatus: noop, onAgentProposal: noop,
  onMenuCommand: (listener) => { const receive = (_event, command) => listener(command); ipcRenderer.on('branches:menu', receive); return () => ipcRenderer.removeListener('branches:menu', receive); },
});
