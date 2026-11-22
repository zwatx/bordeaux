import { contextBridge, ipcRenderer } from "electron";
import type { BordeauxHost, HostChannel, HostEvents, HostInvokes, HostMethods, HostNotices } from "../hosts/contract";
import type { RobotDeliveryCapabilities } from "../core/types";

// The sandboxed preload cannot load modules at runtime, so the channel names live here.
// `satisfies` makes each table list exactly the channels and method names in hosts/contract.ts.

const invokeChannels = {
  "window:state": "getWindowState",
  "window:action": "windowAction",
  "window:menu": "openWindowMenu",
  "window:menuItems": "getWindowMenu",
  "window:menuActivate": "activateWindowMenu",
  "appUpdates:state": "getAppUpdateState",
  "appUpdates:check": "checkAppUpdates",
  "appUpdates:download": "downloadAppUpdate",
  "appUpdates:cancel": "cancelAppUpdateDownload",
  "appUpdates:install": "installAppUpdate",
  "appUpdates:visible": "setAppUpdatesVisible",
  "appUpdates:releases": "openAppUpdateReleases",
  "appUpdates:copyDetails": "copyAppUpdateDetails",
  "robotFiles:connection": "getRobotFileConnection",
  "robotFiles:check": "checkRobotFileConnection",
  "robotFiles:password": "getRobotFilePassword",
  "robotFiles:save": "saveRobotFileSettings",
  "robotFiles:probe": "probeRobotFiles",
  "robotFiles:trust": "trustRobotFiles",
  "robotFiles:prepare": "prepareRobotFiles",
  "robotFiles:prepareRoutine": "prepareRobotRoutine",
  "robotFiles:confirm": "confirmRobotFiles",
  "robotFiles:cancelProbe": "cancelRobotFileProbe",
  "robotFiles:cancel": "cancelRobotFiles",
  "project:exportBdx": "exportBdx",
  "project:exportRoutine": "exportRoutine",
  "project:location": "getProjectLocation",
  "project:openFolder": "openProjectFolder",
  "project:openFile": "openProjectFile",
  "project:open": "openProject",
  "project:openRecent": "openRecentProject",
  "project:listRecent": "listRecentProjects",
  "project:removeRecent": "removeRecentProject",
  "project:openRecentById": "openRecentProjectById",
  "project:revealRecent": "revealRecentProject",
  "project:createNamed": "createNamedProject",
  "project:copyDefaults": "getProjectCopyDefaults",
  "project:creationDefaults": "getProjectCreationDefaults",
  "project:chooseParent": "chooseProjectParentDirectory",
  "project:restoreLast": "restoreLastProject",
  "project:new": "newProject",
  "project:save": "saveProject",
  "project:autosave": "autosaveProject",
  "project:copyDetails": "copyProjectDetails",
  "project:session": "getProjectSession",
  "project:transitionBegin": "beginProjectTransition",
  "project:transitionEnd": "endProjectTransition",
  "project:lifecycleReady": "setProjectLifecycleReady",
  "project:startup": "getProjectStartup",
  "project:startupAdopt": "adoptProjectStartup",
  "project:startupCancel": "cancelProjectStartup",
  "project:startupDetach": "detachProjectStartup",
  "project:checkpoint": "checkpointProject",
  "project:saveWithCheckpoint": "saveProjectWithCheckpoint",
  "project:checkpointReplay": "getProjectCheckpoint",
  "project:checkpointCancel": "cancelProjectCheckpoint",
  "project:listRecoveries": "listProjectRecoveries",
  "project:prepareRecoveryDiscard": "prepareProjectRecoveryDiscard",
  "project:discardRecovery": "discardProjectRecovery",
  "project:restoreRecovery": "restoreProjectRecovery",
  "project:readRecovery": "readProjectRecovery",
  "project:revealRecovery": "revealProjectRecovery",
  "project:reloadSource": "reloadProjectSource",
  "project:revealSource": "revealProjectSource",
  "project:editingResumed": "noteProjectEditingResumed",
  "project:departureResponse": "respondProjectDeparture",
  "project:departureResume": "resumeProjectDeparture",
  "project:validate": "validateProject",
  "diagnostics:preview": "previewBetaDiagnostic",
  "diagnostics:save": "saveBetaDiagnostic",
  "robotProject:listRecent": "listRecentRobotProjects",
  "robotProject:restore": "restoreProjectRobotCode",
  "robotProject:useSuggested": "useSuggestedRobotCode",
  "robotProject:link": "linkRobotProject",
  "robotProject:openRecent": "openRecentRobotProject",
  "robotProject:refresh": "refreshRobotProject",
  "robotProject:inspectLabview": "inspectLabviewCommands",
  "robotProject:ensureWrappers": "ensureCommandWrappers",
  "robotProject:buildCatalog": "buildRobotCatalog",
  "agent:getActiveProposal": "getActiveAgentProposal",
  "agent:getMcpStatus": "getMcpStatus",
} as const satisfies { [C in HostChannel]: HostInvokes[C]["method"] };

const eventChannels = {
  onWindowState: "window:stateChanged",
  onAppUpdateState: "appUpdates:state",
  onProjectCheckpoint: "project:checkpointUpdate",
  onProjectDeparture: "project:departure",
  onProjectDepartureCancelled: "project:departureCancelled",
  onRobotCatalogChanged: "robotProject:catalog",
  onMcpStatus: "agent:mcpStatus",
  onAgentProposal: "agent:proposal",
  onMenuCommand: "menu-command",
} as const satisfies { [M in keyof HostEvents]: string };

const noticeChannels = {
  setDirty: "project:setDirty",
  publishAgentSession: "agent:publishSession",
  updateAgentProposalStatus: "agent:proposalStatus",
  acknowledgeAgentProposal: "agent:proposalReceipt",
} as const satisfies { [M in keyof HostNotices]: string };

// IPC carries no types. This is the one place the contract is asserted for the renderer;
// main.ts's handle() checks the other side against the same contract.
const assemble = <T>(entries: Array<[string, unknown]>) => Object.fromEntries(entries) as T;
const methods = assemble<HostMethods>(Object.entries(invokeChannels).map(([channel, method]) =>
  [method, (...args: unknown[]) => ipcRenderer.invoke(channel, ...args)]));
const events = assemble<HostEvents>(Object.entries(eventChannels).map(([method, channel]) => [method, (handler: (payload: unknown) => void) => {
  const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => { ipcRenderer.removeListener(channel, listener); };
}]));
const notices = assemble<HostNotices>(Object.entries(noticeChannels).map(([method, channel]) =>
  [method, (...args: unknown[]) => ipcRenderer.send(channel, ...args)]));

const bordeauxAPI = {
  ...methods,
  ...events,
  ...notices,
  platform: process.platform,
  robotDeliveryCapabilities: Object.freeze({ pathPush: true, routinePush: true, fileTransfer: true } satisfies RobotDeliveryCapabilities),
} satisfies BordeauxHost;

contextBridge.exposeInMainWorld("bordeauxAPI", bordeauxAPI);
