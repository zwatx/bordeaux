const { contextBridge, ipcRenderer } = require('electron');
const noop = () => () => undefined;
contextBridge.exposeInMainWorld('bordeauxAPI', {
  platform: process.platform, robotDeliveryCapabilities: { pathPush: false, routinePush: false },
  copyProjectDetails: (text) => ipcRenderer.invoke('fixture:copyDetails', text),
  restoreLastProject: () => ipcRenderer.invoke('fixture:restore'),
  openProject: () => ipcRenderer.invoke('fixture:open', 'folder'),
  openProjectFolder: () => ipcRenderer.invoke('fixture:open', 'new-folder'),
  openProjectFile: () => ipcRenderer.invoke('fixture:open', 'file'),
  newProject: () => ipcRenderer.invoke('fixture:reset'),
  listRecentProjects: () => ipcRenderer.invoke('fixture:recents'),
  removeRecentProject: (id) => ipcRenderer.invoke('fixture:removeRecent', id),
  openRecentProjectById: (id) => ipcRenderer.invoke('fixture:openRecent', id),
  revealRecentProject: (target) => ipcRenderer.invoke('fixture:revealRecent', target),
  createNamedProject: (request) => ipcRenderer.invoke('fixture:create', request),
  getProjectCreationDefaults: () => ipcRenderer.invoke('fixture:defaults'),
  chooseProjectParentDirectory: (current) => ipcRenderer.invoke('fixture:chooseParent', current),
  saveProject: (project, saveAs) => ipcRenderer.invoke('fixture:save', project, saveAs),
  autosaveProject: (project) => ipcRenderer.invoke('fixture:autosave', project),
  setDirty: (dirty) => ipcRenderer.send('fixture:dirty', dirty),
  listRecentRobotProjects: async () => [], getMcpStatus: async () => ({ enabled: false }), getActiveAgentProposal: async () => null,
  onMcpStatus: noop, onAgentProposal: noop, onRobotPushState: noop,
  onMenuCommand: (listener) => { const handler = (_event, command) => listener({ command }); ipcRenderer.on('fixture:menu', handler); return () => ipcRenderer.removeListener('fixture:menu', handler); },
});
