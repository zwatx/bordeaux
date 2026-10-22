import type { AppUpdateState } from "../shared/appUpdates";
import type { WindowAction, WindowMenu, WindowMenuAnchor, WindowState } from "../shared/windowChrome";
import type { RobotFileEndpoint, RobotFileConnection, RobotFilePreview, RobotFileResult, RobotFileSettings } from "../shared/robotFileDelivery";
import type { RobotPushScope, RobotDeploymentComparison } from "../shared/export/robotDeployment";
import { contextBridge, ipcRenderer } from "electron";
import type { BordeauxProject, RobotDeliveryCapabilities } from "../shared/types";
import type { AgentProposal, AgentSessionSnapshot } from "../shared/agent/types";
import type { RobotEndpoint, RobotPairing, RobotProbe, RobotRuntimeStatus } from "./robotSftpTransport";
import type { RobotPushPreview, RobotPushProgress, RobotPushResult } from "./robotPush";
import type { RobotRetentionOperationResult, RobotRetentionPreview, RobotRetentionProgress } from "./robotRetention";
import type { CreateNamedProjectRequest, OpenedProject, RecentProjectEntry, RecentProjectRevealTarget, ProjectCopyDefaultsRequest, ProjectCopyDefaults } from "../shared/project/desktopProjects";
import type { ProjectCheckpointRequest, ProjectCheckpointSaveResult, ProjectReloadRequest, ProjectReloadResult, ProjectRevealResult, ProjectPersistenceUpdate, ProjectRecoveredFrom, ProjectRecoveryListing, ProjectRecoveryListOptions, ProjectRecoveryDiscardConfirmation, ProjectSaveCheckpointRequest, ProjectSession, ProjectStartupRequest, ProjectStartupResult, ProjectStartupDetachResult, ProjectTransitionToken, RestoredProjectRecovery } from "../shared/project/projectPersistence";
import type { ProjectDepartureRequest, ProjectDepartureResponse, ProjectDepartureResume, ProjectDurabilityContext } from "../shared/project/projectDurability";

type McpStatus = { enabled: boolean; generation: number };
/** Main accepts a snapshot only for the MCP access generation it was published in. */
type AgentSessionPublication = AgentSessionSnapshot & { accessGeneration: number };

const bordeauxAPI = {
  platform: process.platform,
  getWindowState: (): Promise<WindowState> => ipcRenderer.invoke("window:state"),
  windowAction: (action: WindowAction): Promise<void> => ipcRenderer.invoke("window:action", action),
  openWindowMenu: (menu: WindowMenu, anchor: WindowMenuAnchor): Promise<boolean> => ipcRenderer.invoke("window:menu", menu, anchor),
  onWindowState: (handler: (state: WindowState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: WindowState) => handler(state);
    ipcRenderer.on("window:stateChanged", listener);
    return () => ipcRenderer.removeListener("window:stateChanged", listener);
  },
  getAppUpdateState: (): Promise<AppUpdateState> => ipcRenderer.invoke("appUpdates:state"),
  checkAppUpdates: (): Promise<void> => ipcRenderer.invoke("appUpdates:check"),
  downloadAppUpdate: (): Promise<void> => ipcRenderer.invoke("appUpdates:download"),
  cancelAppUpdateDownload: (): Promise<void> => ipcRenderer.invoke("appUpdates:cancel"),
  installAppUpdate: (): Promise<void> => ipcRenderer.invoke("appUpdates:install"),
  setAppUpdatesVisible: (visible: boolean): Promise<void> => ipcRenderer.invoke("appUpdates:visible", visible),
  openAppUpdateReleases: (): Promise<void> => ipcRenderer.invoke("appUpdates:releases"),
  copyAppUpdateDetails: (): Promise<void> => ipcRenderer.invoke("appUpdates:copyDetails"),
  copyProjectDetails: (text: string): Promise<void> => ipcRenderer.invoke("project:copyDetails", text),
  onAppUpdateState: (handler: (state: AppUpdateState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: AppUpdateState) => handler(state);
    ipcRenderer.on("appUpdates:state", listener);
    return () => ipcRenderer.removeListener("appUpdates:state", listener);
  },
  robotDeliveryCapabilities: Object.freeze({ pathPush: true, routinePush: false, fileTransfer: true } satisfies RobotDeliveryCapabilities),
  getRobotFileConnection: (): Promise<RobotFileSettings | null> => ipcRenderer.invoke("robotFiles:connection"),
  saveRobotFileSettings: (endpoint: RobotFileEndpoint): Promise<RobotFileSettings> => ipcRenderer.invoke("robotFiles:save", endpoint),
  probeRobotFiles: (endpoint: RobotFileEndpoint): Promise<RobotFileConnection> => ipcRenderer.invoke("robotFiles:probe", endpoint),
  trustRobotFiles: (fingerprint: string): Promise<RobotFileConnection> => ipcRenderer.invoke("robotFiles:trust", fingerprint),
  prepareRobotFiles: (project: BordeauxProject, pathIds: string[]): Promise<RobotFilePreview> => ipcRenderer.invoke("robotFiles:prepare", project, pathIds),
  confirmRobotFiles: (operationId: string): Promise<RobotFileResult> => ipcRenderer.invoke("robotFiles:confirm", operationId),
  cancelRobotFiles: (operationId: string): Promise<{ canceled: boolean }> => ipcRenderer.invoke("robotFiles:cancel", operationId),
  exportBdx: (project: BordeauxProject, pathId: string) => ipcRenderer.invoke("project:exportBdx", project, pathId),
  getProjectLocation: () => ipcRenderer.invoke("project:location"),
  openProjectFolder: () => ipcRenderer.invoke("project:openFolder"),
  openProjectFile: () => ipcRenderer.invoke("project:openFile"),
  openProject: () => ipcRenderer.invoke("project:open"),
  openRecentProject: (index: number) => ipcRenderer.invoke("project:openRecent", index),
  listRecentProjects: (): Promise<RecentProjectEntry[]> => ipcRenderer.invoke("project:listRecent"),
  removeRecentProject: (id: string): Promise<{ removed: boolean }> => ipcRenderer.invoke("project:removeRecent", id),
  openRecentProjectById: (id: string): Promise<OpenedProject> => ipcRenderer.invoke("project:openRecentById", id),
  revealRecentProject: (target: RecentProjectRevealTarget): Promise<ProjectRevealResult> => ipcRenderer.invoke("project:revealRecent", target),
  createNamedProject: (request: CreateNamedProjectRequest): Promise<OpenedProject> => ipcRenderer.invoke("project:createNamed", request),
  getProjectCopyDefaults: (request: ProjectCopyDefaultsRequest): Promise<ProjectCopyDefaults> => ipcRenderer.invoke("project:copyDefaults", request),
  getProjectCreationDefaults: (): Promise<{ parentDirectory: string }> => ipcRenderer.invoke("project:creationDefaults"),
  /** Returns a chosen parent folder without opening or activating anything. */
  chooseProjectParentDirectory: (current?: string): Promise<{ parentDirectory: string } | null> => ipcRenderer.invoke("project:chooseParent", current),
  restoreLastProject: () => ipcRenderer.invoke("project:restoreLast"),
  newProject: () => ipcRenderer.invoke("project:new"),
  saveProject: (project: BordeauxProject, saveAs = false) => ipcRenderer.invoke("project:save", project, saveAs),
  autosaveProject: (project: BordeauxProject) => ipcRenderer.invoke("project:autosave", project),
  getProjectSession: (): Promise<ProjectSession> => ipcRenderer.invoke("project:session"),
  beginProjectTransition: (context: ProjectDurabilityContext): Promise<ProjectTransitionToken> => ipcRenderer.invoke("project:transitionBegin", context),
  endProjectTransition: (token: ProjectTransitionToken): Promise<{ ended: boolean; busy?: boolean }> => ipcRenderer.invoke("project:transitionEnd", token),
  setProjectLifecycleReady: (context: ProjectDurabilityContext, ready: boolean): Promise<{ accepted: boolean }> => ipcRenderer.invoke("project:lifecycleReady", context, ready),
  getProjectStartup: (request: ProjectStartupRequest): Promise<ProjectStartupResult> => ipcRenderer.invoke("project:startup", request),
  adoptProjectStartup: (startupId: string, transition: ProjectTransitionToken): Promise<OpenedProject & { session: ProjectSession }> => ipcRenderer.invoke("project:startupAdopt", startupId, transition),
  cancelProjectStartup: (transition: ProjectTransitionToken): Promise<{ cancelled: boolean; busy?: boolean }> => ipcRenderer.invoke("project:startupCancel", transition),
  detachProjectStartup: (request: ProjectStartupRequest): Promise<ProjectStartupDetachResult> => ipcRenderer.invoke("project:startupDetach", request),
  checkpointProject: (request: ProjectCheckpointRequest): Promise<ProjectPersistenceUpdate> => ipcRenderer.invoke("project:checkpoint", request),
  /** Subscribe before invoking: source completion precedes the existing automatic BDX result. */
  saveProjectWithCheckpoint: (request: ProjectSaveCheckpointRequest): Promise<ProjectCheckpointSaveResult> => ipcRenderer.invoke("project:saveWithCheckpoint", request),
  getProjectCheckpoint: (context: ProjectDurabilityContext, operationId: string): Promise<ProjectPersistenceUpdate | null> => ipcRenderer.invoke("project:checkpointReplay", context, operationId),
  cancelProjectCheckpoint: (context: ProjectDurabilityContext, operationId: string): Promise<{ cancelled: boolean }> => ipcRenderer.invoke("project:checkpointCancel", context, operationId),
  listProjectRecoveries: (options?: ProjectRecoveryListOptions): Promise<ProjectRecoveryListing> => ipcRenderer.invoke("project:listRecoveries", options),
  prepareProjectRecoveryDiscard: (context: ProjectDurabilityContext, id: string): Promise<ProjectRecoveryDiscardConfirmation> => ipcRenderer.invoke("project:prepareRecoveryDiscard", context, id),
  discardProjectRecovery: (context: ProjectDurabilityContext, token: string): Promise<{ removed: boolean }> => ipcRenderer.invoke("project:discardRecovery", context, token),
  restoreProjectRecovery: (context: ProjectDurabilityContext, recordId: string): Promise<RestoredProjectRecovery> => ipcRenderer.invoke("project:restoreRecovery", context, recordId),
  readProjectRecovery: (context: ProjectDurabilityContext, recordId: string): Promise<{ project: BordeauxProject; recoveredFrom: ProjectRecoveredFrom }> => ipcRenderer.invoke("project:readRecovery", context, recordId),
  revealProjectRecovery: (id: string): Promise<void> => ipcRenderer.invoke("project:revealRecovery", id),
  reloadProjectSource: (request: ProjectReloadRequest): Promise<ProjectReloadResult> => ipcRenderer.invoke("project:reloadSource", request),
  revealProjectSource: (context: ProjectDurabilityContext, file: string): Promise<ProjectRevealResult> => ipcRenderer.invoke("project:revealSource", context, file),
  noteProjectEditingResumed: (context: ProjectDurabilityContext, installAttemptId: string): Promise<{ accepted: boolean }> => ipcRenderer.invoke("project:editingResumed", context, installAttemptId),
  respondProjectDeparture: (response: ProjectDepartureResponse): Promise<{ accepted: boolean }> => ipcRenderer.invoke("project:departureResponse", response),
  resumeProjectDeparture: (token: ProjectDepartureResume): Promise<{ accepted: boolean }> => ipcRenderer.invoke("project:departureResume", token),
  onProjectCheckpoint: (handler: (update: ProjectPersistenceUpdate) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, update: ProjectPersistenceUpdate) => handler(update);
    ipcRenderer.on("project:checkpointUpdate", listener);
    return () => ipcRenderer.removeListener("project:checkpointUpdate", listener);
  },
  onProjectDeparture: (handler: (request: ProjectDepartureRequest) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, request: ProjectDepartureRequest) => handler(request);
    ipcRenderer.on("project:departure", listener);
    return () => ipcRenderer.removeListener("project:departure", listener);
  },
  onProjectDepartureCancelled: (handler: (requestId: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, requestId: string) => handler(requestId);
    ipcRenderer.on("project:departureCancelled", listener);
    return () => ipcRenderer.removeListener("project:departureCancelled", listener);
  },
  previewBetaDiagnostic: (project: BordeauxProject) => ipcRenderer.invoke("diagnostics:preview", project),
  saveBetaDiagnostic: (previewId: string) => ipcRenderer.invoke("diagnostics:save", previewId),
  validateProject: (project: BordeauxProject) => ipcRenderer.invoke("project:validate", project),
  listRecentRobotProjects: () => ipcRenderer.invoke("robotProject:listRecent"),
  restoreProjectRobotCode: (context: ProjectDurabilityContext) => ipcRenderer.invoke("robotProject:restore", context),
  useSuggestedRobotCode: (context: ProjectDurabilityContext, id: string) => ipcRenderer.invoke("robotProject:useSuggested", context, id),
  linkRobotProject: (context: ProjectDurabilityContext) => ipcRenderer.invoke("robotProject:link", context),
  openRecentRobotProject: (id: string, context: ProjectDurabilityContext) => ipcRenderer.invoke("robotProject:openRecent", id, context),
  refreshRobotProject: (context: ProjectDurabilityContext) => ipcRenderer.invoke("robotProject:refresh", context),
  inspectLabviewCommands: (context: ProjectDurabilityContext) => ipcRenderer.invoke("robotProject:inspectLabview", context),
  ensureCommandWrappers: (context: ProjectDurabilityContext, commandIds: string[]) => ipcRenderer.invoke("robotProject:ensureWrappers", context, commandIds),
  buildRobotCatalog: (context: ProjectDurabilityContext) => ipcRenderer.invoke("robotProject:buildCatalog", context),
  getRobotPairing: (): Promise<RobotPairing | null> => ipcRenderer.invoke("robot:getPairing"),
  probeRobot: (endpoint: RobotEndpoint): Promise<RobotProbe> => ipcRenderer.invoke("robot:probe", endpoint),
  confirmRobotPairing: (hostKeyFingerprint: string, runtimeId: string): Promise<RobotPairing> => ipcRenderer.invoke("robot:confirmPairing", hostKeyFingerprint, runtimeId),
  inspectPairedRobot: (): Promise<RobotRuntimeStatus> => ipcRenderer.invoke("robot:inspect"),
  inspectRobotRetention: (project: BordeauxProject): Promise<{ status: RobotRuntimeStatus; localRevisionId: string }> => ipcRenderer.invoke("robot:inspectRetention", project),
  inspectRobotLibrary: (project: BordeauxProject): Promise<{ status: RobotRuntimeStatus; comparison: RobotDeploymentComparison | null; verifiedAt: string; message?: string }> => ipcRenderer.invoke("robot:inspectLibrary", project),
  prepareRobotPush: (project: BordeauxProject, scope?: RobotPushScope): Promise<RobotPushPreview> => ipcRenderer.invoke("robot:preparePush", project, scope),
  confirmRobotPush: (operationId: string, adoptBaseline = false): Promise<RobotPushResult | {
    operationId: string;
    state: "failed" | "cancelled";
    boundary: "upload" | "staging";
    message: string;
  }> => ipcRenderer.invoke("robot:confirmPush", operationId, adoptBaseline),
  cancelRobotPush: (operationId: string): Promise<{ canceled: boolean; boundary?: "review" | "upload" }> => ipcRenderer.invoke("robot:cancelPush", operationId),
  onRobotPushState: (handler: (progress: RobotPushProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: RobotPushProgress) => handler(progress);
    ipcRenderer.on("robot:pushState", listener);
    return () => ipcRenderer.removeListener("robot:pushState", listener);
  },
  prepareRobotRetention: (project: BordeauxProject, action: "rollback" | "pin", target: { revisionId: string; payloadSha256: string }): Promise<RobotRetentionPreview> => ipcRenderer.invoke("robot:prepareRetention", project, action, target),
  confirmRobotRetention: (operationId: string): Promise<RobotRetentionOperationResult | {
    operationId: string;
    state: "failed" | "cancelled";
    boundary: "upload" | "staging";
    message: string;
  }> => ipcRenderer.invoke("robot:confirmRetention", operationId),
  cancelRobotRetention: (operationId: string): Promise<{ canceled: boolean; boundary?: "review" | "upload" }> => ipcRenderer.invoke("robot:cancelRetention", operationId),
  onRobotRetentionState: (handler: (progress: RobotRetentionProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: RobotRetentionProgress) => handler(progress);
    ipcRenderer.on("robot:retentionState", listener);
    return () => ipcRenderer.removeListener("robot:retentionState", listener);
  },
  setDirty: (dirty: boolean) => ipcRenderer.send("project:setDirty", dirty),
  publishAgentSession: (snapshot: AgentSessionPublication) => ipcRenderer.send("agent:publishSession", snapshot),
  updateAgentProposalStatus: (proposalId: string, status: "applied" | "rejected" | "stale", revision?: number) => ipcRenderer.send("agent:proposalStatus", proposalId, status, revision),
  acknowledgeAgentProposal: (proposalId: string, sessionId: string, revision: number, activePathId: string, accepted = true) => ipcRenderer.send("agent:proposalReceipt", proposalId, sessionId, revision, activePathId, accepted),
  getActiveAgentProposal: (): Promise<AgentProposal | null> => ipcRenderer.invoke("agent:getActiveProposal"),
  getMcpStatus: (): Promise<McpStatus> => ipcRenderer.invoke("agent:getMcpStatus"),
  onMcpStatus: (handler: (status: McpStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: McpStatus) => handler(status);
    ipcRenderer.on("agent:mcpStatus", listener);
    return () => ipcRenderer.removeListener("agent:mcpStatus", listener);
  },
  onAgentProposal: (handler: (proposal: AgentProposal) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, proposal: AgentProposal) => handler(proposal);
    ipcRenderer.on("agent:proposal", listener);
    return () => ipcRenderer.removeListener("agent:proposal", listener);
  },
  onMenuCommand: (handler: (event: { command: string; payload?: unknown }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { command: string; payload?: unknown }) => handler(payload);
    ipcRenderer.on("menu-command", listener);
    return () => ipcRenderer.removeListener("menu-command", listener);
  },
};

export type BordeauxAPI = typeof bordeauxAPI;

contextBridge.exposeInMainWorld("bordeauxAPI", bordeauxAPI);
