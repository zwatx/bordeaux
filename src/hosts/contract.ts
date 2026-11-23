/**
 * Everything the renderer may ask of its host, typed once.
 *
 * Electron implements it: preload.ts maps each channel to its method, and main.ts's handle() checks every
 * handler's result against this file. The SystemCore web host implements the subset it supports, and the
 * renderer hides features whose methods are missing.
 *
 * Types only: the sandboxed preload cannot load modules at runtime, so it keeps its own channel table.
 */
import type { AgentProposal, AgentSessionSnapshot } from "../core/agent/types";
import type { AppUpdateState } from "../core/appUpdates";
import type { CreateNamedProjectRequest, OpenedProject, ProjectCopyDefaults, ProjectCopyDefaultsRequest, ProjectLocation, RecentProjectEntry, RecentProjectRevealTarget } from "../core/project/desktopProjects";
import type { ProjectDepartureRequest, ProjectDepartureResponse, ProjectDepartureResume, ProjectDurabilityContext } from "../core/project/projectDurability";
import type {
  ProjectCheckpointRequest, ProjectCheckpointSaveResult, ProjectPersistenceUpdate, ProjectRecoveredFrom, ProjectRecoveryDiscardConfirmation,
  ProjectRecoveryListing, ProjectRecoveryListOptions, ProjectReloadRequest, ProjectReloadResult, ProjectRevealResult, ProjectSaveCheckpointRequest,
  ProjectSession, ProjectStartupDetachResult, ProjectStartupRequest, ProjectStartupResult, ProjectTransitionToken, RestoredProjectRecovery,
} from "../core/project/projectPersistence";
import type { RobotFileConnection, RobotFileEndpoint, RobotFilePreview, RobotFileResult, RobotFileSettings, RobotPasswordChange, RobotPasswordStatus } from "../core/robotFileDelivery";
import type { BordeauxProject, RobotCommandCatalog, RobotDeliveryCapabilities, RobotIntegrationStatus, RobotProjectBookmarkSummary, ValidationResult } from "../core/types";
import type { WindowAction, WindowMenu, WindowMenuAnchor, WindowMenuEntry, WindowState } from "../core/windowChrome";

export type McpStatus = { enabled: boolean; generation: number };
/** Main accepts a snapshot only for the MCP access generation it was published in. */
export type AgentSessionPublication = AgentSessionSnapshot & { accessGeneration: number };

export type PathExportResult = { canceled: true }
  | { exported: true; relativePath: string; sha256: string; pathCount: number; eventCount: number; sampleCount: number };
export type RoutineExportResult = { canceled: true }
  | { exported: true; relativePath: string; sha256: string; pathCount: number; nodeCount: number; commandCount: number };
export interface ProjectAutosaveResult { saved: boolean; error?: string; location: ProjectLocation }
export interface DiagnosticPreview { previewId: string; contents: string; fileName: string }

/** A linked LabVIEW project's command catalog, with the recent robot projects. */
export interface RobotProjectConnection {
  warning?: string;
  catalog: RobotCommandCatalog;
  integration: RobotIntegrationStatus;
  bookmarkId: string;
  recentProjects: RobotProjectBookmarkSummary[];
}
/** Linking also returns the editor reference to store: a project-relative path, or a legacy bookmark. */
export interface RobotProjectLink extends RobotProjectConnection {
  editorLink: { labviewProjectPath: string } | { robotProjectBookmarkId: string };
}
export type RobotProjectRestore = RobotProjectConnection | { suggestion?: { id: string; name: string }; status: string; error: string };

/**
 * Request/response calls, keyed by IPC channel: `method` is the renderer's name for it and `call` its signature.
 * Add a channel here first; the preload table and main's handler then fail to compile until they match.
 */
export interface HostInvokes {
  "window:state": { method: "getWindowState"; call: () => Promise<WindowState> };
  "window:action": { method: "windowAction"; call: (action: WindowAction) => Promise<void> };
  "window:menu": { method: "openWindowMenu"; call: (menu: WindowMenu, anchor: WindowMenuAnchor) => Promise<boolean> };
  "window:menuItems": { method: "getWindowMenu"; call: () => Promise<WindowMenuEntry[]> };
  "window:menuActivate": { method: "activateWindowMenu"; call: (token: string) => Promise<void> };

  "appUpdates:state": { method: "getAppUpdateState"; call: () => Promise<AppUpdateState | undefined> };
  "appUpdates:check": { method: "checkAppUpdates"; call: () => Promise<void> };
  "appUpdates:download": { method: "downloadAppUpdate"; call: () => Promise<void> };
  "appUpdates:cancel": { method: "cancelAppUpdateDownload"; call: () => Promise<void> };
  "appUpdates:install": { method: "installAppUpdate"; call: () => Promise<{ accepted: boolean }> };
  "appUpdates:visible": { method: "setAppUpdatesVisible"; call: (visible: boolean) => Promise<void> };
  "appUpdates:releases": { method: "openAppUpdateReleases"; call: (target?: "release" | "all") => Promise<void> };
  "appUpdates:copyDetails": { method: "copyAppUpdateDetails"; call: () => Promise<void> };

  "robotFiles:connection": { method: "getRobotFileConnection"; call: () => Promise<RobotFileSettings | null> };
  "robotFiles:check": { method: "checkRobotFileConnection"; call: () => Promise<RobotFileConnection | null> };
  /** Never the password itself. */
  "robotFiles:password": { method: "getRobotFilePassword"; call: () => Promise<RobotPasswordStatus> };
  "robotFiles:save": { method: "saveRobotFileSettings"; call: (endpoint: RobotFileEndpoint, password?: RobotPasswordChange) => Promise<RobotFileSettings> };
  "robotFiles:probe": { method: "probeRobotFiles"; call: (endpoint: RobotFileEndpoint, password?: RobotPasswordChange) => Promise<RobotFileConnection> };
  "robotFiles:trust": { method: "trustRobotFiles"; call: (fingerprint: string) => Promise<RobotFileConnection> };
  "robotFiles:prepare": { method: "prepareRobotFiles"; call: (project: BordeauxProject, pathIds: string[]) => Promise<RobotFilePreview> };
  "robotFiles:prepareRoutine": { method: "prepareRobotRoutine"; call: (project: BordeauxProject, routineId: string) => Promise<RobotFilePreview> };
  "robotFiles:confirm": { method: "confirmRobotFiles"; call: (operationId: string) => Promise<RobotFileResult> };
  "robotFiles:cancelProbe": { method: "cancelRobotFileProbe"; call: () => Promise<void> };
  "robotFiles:cancel": { method: "cancelRobotFiles"; call: (operationId: string) => Promise<{ canceled: boolean }> };

  "project:exportBdx": { method: "exportBdx"; call: (project: BordeauxProject, pathId: string) => Promise<PathExportResult> };
  "project:exportRoutine": { method: "exportRoutine"; call: (project: BordeauxProject, routineId: string) => Promise<RoutineExportResult> };
  "project:location": { method: "getProjectLocation"; call: () => Promise<ProjectLocation> };
  "project:openFolder": { method: "openProjectFolder"; call: () => Promise<OpenedProject | null> };
  "project:openFile": { method: "openProjectFile"; call: () => Promise<OpenedProject | null> };
  "project:open": { method: "openProject"; call: () => Promise<OpenedProject | null> };
  "project:openRecent": { method: "openRecentProject"; call: (index: number) => Promise<OpenedProject> };
  "project:listRecent": { method: "listRecentProjects"; call: () => Promise<RecentProjectEntry[]> };
  "project:removeRecent": { method: "removeRecentProject"; call: (id: string) => Promise<{ removed: boolean }> };
  "project:openRecentById": { method: "openRecentProjectById"; call: (id: string) => Promise<OpenedProject> };
  "project:revealRecent": { method: "revealRecentProject"; call: (target: RecentProjectRevealTarget) => Promise<ProjectRevealResult> };
  "project:createNamed": { method: "createNamedProject"; call: (request: CreateNamedProjectRequest) => Promise<OpenedProject> };
  "project:copyDefaults": { method: "getProjectCopyDefaults"; call: (request: ProjectCopyDefaultsRequest) => Promise<ProjectCopyDefaults> };
  "project:creationDefaults": { method: "getProjectCreationDefaults"; call: () => Promise<{ parentDirectory: string }> };
  /** Returns a chosen parent folder without opening or activating anything. */
  "project:chooseParent": { method: "chooseProjectParentDirectory"; call: (current?: string) => Promise<{ parentDirectory: string } | null> };
  "project:restoreLast": { method: "restoreLastProject"; call: () => Promise<OpenedProject | null> };
  "project:new": { method: "newProject"; call: () => Promise<void> };
  "project:save": { method: "saveProject"; call: (project: BordeauxProject, saveAs?: boolean) => Promise<ProjectCheckpointSaveResult> };
  "project:autosave": { method: "autosaveProject"; call: (project: BordeauxProject) => Promise<ProjectAutosaveResult> };
  "project:copyDetails": { method: "copyProjectDetails"; call: (text: string) => Promise<void> };
  "project:session": { method: "getProjectSession"; call: () => Promise<ProjectSession> };
  "project:transitionBegin": { method: "beginProjectTransition"; call: (context: ProjectDurabilityContext) => Promise<ProjectTransitionToken> };
  "project:transitionEnd": { method: "endProjectTransition"; call: (token: ProjectTransitionToken) => Promise<{ ended: boolean; busy?: boolean }> };
  "project:lifecycleReady": { method: "setProjectLifecycleReady"; call: (context: ProjectDurabilityContext, ready: boolean) => Promise<{ accepted: boolean }> };
  "project:startup": { method: "getProjectStartup"; call: (request: ProjectStartupRequest) => Promise<ProjectStartupResult> };
  "project:startupAdopt": { method: "adoptProjectStartup"; call: (startupId: string, transition: ProjectTransitionToken) => Promise<OpenedProject & { session: ProjectSession }> };
  "project:startupCancel": { method: "cancelProjectStartup"; call: (transition: ProjectTransitionToken) => Promise<{ cancelled: boolean; busy?: boolean }> };
  "project:startupDetach": { method: "detachProjectStartup"; call: (request: ProjectStartupRequest) => Promise<ProjectStartupDetachResult> };
  "project:checkpoint": { method: "checkpointProject"; call: (request: ProjectCheckpointRequest) => Promise<ProjectPersistenceUpdate> };
  /** Subscribe before invoking: source completion precedes the existing automatic BDX result. */
  "project:saveWithCheckpoint": { method: "saveProjectWithCheckpoint"; call: (request: ProjectSaveCheckpointRequest) => Promise<ProjectCheckpointSaveResult> };
  "project:checkpointReplay": { method: "getProjectCheckpoint"; call: (context: ProjectDurabilityContext, operationId: string) => Promise<ProjectPersistenceUpdate | null> };
  "project:checkpointCancel": { method: "cancelProjectCheckpoint"; call: (context: ProjectDurabilityContext, operationId: string) => Promise<{ cancelled: boolean }> };
  "project:listRecoveries": { method: "listProjectRecoveries"; call: (options?: ProjectRecoveryListOptions) => Promise<ProjectRecoveryListing> };
  "project:prepareRecoveryDiscard": { method: "prepareProjectRecoveryDiscard"; call: (context: ProjectDurabilityContext, id: string) => Promise<ProjectRecoveryDiscardConfirmation> };
  "project:discardRecovery": { method: "discardProjectRecovery"; call: (context: ProjectDurabilityContext, token: string) => Promise<{ removed: boolean }> };
  "project:restoreRecovery": { method: "restoreProjectRecovery"; call: (context: ProjectDurabilityContext, recordId: string) => Promise<RestoredProjectRecovery> };
  "project:readRecovery": { method: "readProjectRecovery"; call: (context: ProjectDurabilityContext, recordId: string) => Promise<{ project: BordeauxProject; recoveredFrom: ProjectRecoveredFrom }> };
  "project:revealRecovery": { method: "revealProjectRecovery"; call: (id: string) => Promise<void> };
  "project:reloadSource": { method: "reloadProjectSource"; call: (request: ProjectReloadRequest) => Promise<ProjectReloadResult> };
  "project:revealSource": { method: "revealProjectSource"; call: (context: ProjectDurabilityContext, file: string) => Promise<ProjectRevealResult> };
  "project:editingResumed": { method: "noteProjectEditingResumed"; call: (context: ProjectDurabilityContext, installAttemptId: string) => Promise<{ accepted: boolean }> };
  "project:departureResponse": { method: "respondProjectDeparture"; call: (response: ProjectDepartureResponse) => Promise<{ accepted: boolean }> };
  "project:departureResume": { method: "resumeProjectDeparture"; call: (token: ProjectDepartureResume) => Promise<{ accepted: boolean }> };
  "project:validate": { method: "validateProject"; call: (project: BordeauxProject) => Promise<ValidationResult> };

  "diagnostics:preview": { method: "previewBetaDiagnostic"; call: (project: BordeauxProject) => Promise<DiagnosticPreview> };
  "diagnostics:save": { method: "saveBetaDiagnostic"; call: (previewId: string) => Promise<{ saved: boolean }> };

  "robotProject:listRecent": { method: "listRecentRobotProjects"; call: () => Promise<RobotProjectBookmarkSummary[]> };
  "robotProject:restore": { method: "restoreProjectRobotCode"; call: (context: ProjectDurabilityContext) => Promise<RobotProjectRestore> };
  "robotProject:useSuggested": { method: "useSuggestedRobotCode"; call: (context: ProjectDurabilityContext, id: string) => Promise<RobotProjectLink> };
  "robotProject:link": { method: "linkRobotProject"; call: (context: ProjectDurabilityContext) => Promise<RobotProjectLink | null> };
  "robotProject:openRecent": { method: "openRecentRobotProject"; call: (id: string, context: ProjectDurabilityContext) => Promise<RobotProjectLink> };
  "robotProject:refresh": { method: "refreshRobotProject"; call: (context: ProjectDurabilityContext) => Promise<RobotProjectConnection> };
  "robotProject:inspectLabview": { method: "inspectLabviewCommands"; call: (context: ProjectDurabilityContext) => Promise<RobotProjectConnection> };
  "robotProject:ensureWrappers": { method: "ensureCommandWrappers"; call: (context: ProjectDurabilityContext, commandIds: string[]) => Promise<{ created: number }> };
  "robotProject:buildCatalog": { method: "buildRobotCatalog"; call: (context: ProjectDurabilityContext) => Promise<RobotProjectConnection> };

  "agent:getActiveProposal": { method: "getActiveAgentProposal"; call: () => Promise<AgentProposal | null> };
  "agent:getMcpStatus": { method: "getMcpStatus"; call: () => Promise<McpStatus> };
}
export type HostChannel = keyof HostInvokes;
/** What a channel's handler may return; main's handle() enforces it. */
export type HostResult<C extends HostChannel> = Awaited<ReturnType<HostInvokes[C]["call"]>>;
/** Each request/response call under its renderer method name. */
export type HostMethods = { [C in HostChannel as HostInvokes[C]["method"]]: HostInvokes[C]["call"] };

type Unsubscribe = () => void;
/** Pushes from the host. Each returns its unsubscribe function. */
export interface HostEvents {
  onWindowState(handler: (state: WindowState) => void): Unsubscribe;
  onAppUpdateState(handler: (state: AppUpdateState) => void): Unsubscribe;
  onProjectCheckpoint(handler: (update: ProjectPersistenceUpdate) => void): Unsubscribe;
  onProjectDeparture(handler: (request: ProjectDepartureRequest) => void): Unsubscribe;
  onProjectDepartureCancelled(handler: (requestId: string) => void): Unsubscribe;
  /** New command definitions read in the background for the linked project; the link and its reviews stay current. */
  onRobotCatalogChanged(handler: (update: { context: ProjectDurabilityContext; catalog: unknown }) => void): Unsubscribe;
  onMcpStatus(handler: (status: McpStatus) => void): Unsubscribe;
  onAgentProposal(handler: (proposal: AgentProposal) => void): Unsubscribe;
  onMenuCommand(handler: (event: { command: string; payload?: unknown }) => void): Unsubscribe;
}

/** One-way notices to the host. */
export interface HostNotices {
  setDirty(dirty: boolean): void;
  publishAgentSession(snapshot: AgentSessionPublication): void;
  updateAgentProposalStatus(proposalId: string, status: "applied" | "rejected" | "stale", revision?: number): void;
  acknowledgeAgentProposal(proposalId: string, sessionId: string, revision: number, activePathId: string, accepted?: boolean): void;
}

export interface BordeauxHost extends HostMethods, HostEvents, HostNotices {
  platform: string;
  robotDeliveryCapabilities: Readonly<RobotDeliveryCapabilities>;
}
