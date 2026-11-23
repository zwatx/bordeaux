const { contextBridge, ipcRenderer } = require('electron');
const noop = () => () => undefined;
// MCP access stays off unless a check enables it; proposals then arrive as the main process would send them.
const agent = { status: null, proposal: null, sessions: [], statuses: [] };
const listen = (key) => (listener) => { agent[key] = listener; return () => { if (agent[key] === listener) agent[key] = null; }; };
contextBridge.exposeInMainWorld('bordeauxAPI', {
  robotDeliveryCapabilities: { pathPush: true, routinePush: true, fileTransfer: true },
  platform: 'linux', restoreLastProject: () => ipcRenderer.invoke('library:restore'),
  saveProject: (project) => ipcRenderer.invoke('library:save', project), autosaveProject: async () => ({ saved: false }),
  setDirty: () => undefined, listRecentRobotProjects: async () => [], getMcpStatus: async () => ({ enabled: false }), getActiveAgentProposal: async () => null,
  onMcpStatus: listen('status'), onAgentProposal: listen('proposal'), onMenuCommand: noop,
  publishAgentSession: (snapshot) => { agent.sessions.push(JSON.parse(JSON.stringify(snapshot))); },
  updateAgentProposalStatus: (id, status) => { agent.statuses.push({ id, status }); },
  acknowledgeAgentProposal: (id, _sessionId, _revision, _activePathId, accepted = true) => { if (!accepted) agent.statuses.push({ id, status: 'stale' }); },
  __libraryAgent: {
    setAccess: (enabled, generation) => agent.status?.({ enabled, generation }),
    latestSession: () => agent.sessions.at(-1) || null,
    propose: (proposal) => agent.proposal?.(JSON.parse(JSON.stringify(proposal))),
    statuses: () => agent.statuses.slice(),
  },
  previewBetaDiagnostic: (project) => ipcRenderer.invoke('library:diagnostic-preview', project),
  saveBetaDiagnostic: (previewId) => ipcRenderer.invoke('library:diagnostic-save', previewId),
  // Robot file delivery: a trusted fixture connection; main's library:* handlers record and defer each step.
  getRobotFileConnection: () => ipcRenderer.invoke('library:connection'),
  getRobotFilePassword: async () => ({ custom: false, persistent: false }),
  checkRobotFileConnection: async () => null,
  prepareRobotFiles: (project, pathIds) => ipcRenderer.invoke('library:prepare', project, pathIds),
  confirmRobotFiles: (operationId) => ipcRenderer.invoke('library:confirm', operationId),
  cancelRobotFiles: async () => ({ canceled: true }),
  cancelRobotFileProbe: async () => undefined,
});
