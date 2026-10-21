import type { ProjectCopyDefaultsRequest } from "../shared/project/desktopProjects";
import { app, autoUpdater as nativeAutoUpdater, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from "electron";
import { autoUpdater as updateClient } from "electron-updater";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { robotCatalogSemanticSignature } from "../shared/agent/catalogSignature";
import type { BordeauxProject, RobotCommandCatalog, RobotIntegrationStatus } from "../shared/types";
import { validateProject, validateProjectSource } from "../shared/validation";
import { ProjectBdxChangedError, type ProjectBdxExportScope } from "./projectBdxExport";
import { prepareBdxBindings } from "./bdxBindings";
import { buildBdxBatchOffThread, buildBdxOffThread } from "./bdxWorkerClient";
import { buildLabviewCatalog, LABVIEW_CATALOG_SOURCE, resolveLabviewProject } from "./labviewProject";
import { withCachedLabviewCommands } from "./labviewNiInspection";
import { statLabviewLocalPath } from "./labviewProjectDiscovery";
import { labviewLinkMatches, relativeLabviewLink, rebaseProjectLabviewLink, resolveProjectLabviewLink, suggestProjectLabviewLink } from "./projectLabviewLink";
import { inspectLabviewCommandsQueued, syncLabviewCommands } from "./labviewProjectSync";
import { discoverRobotProject, type RobotProjectRuntime } from "./robotProjectRuntime";
import {
  type RobotProjectBookmark,
  readRobotProjectBookmarks,
  rememberRobotProject,
  summarizeRobotProjectBookmarks,
  writeRobotProjectBookmarks,
} from "./robotProjectBookmarks";
import { autosaveProjectFolder, writeBufferAtomically, openProjectFolder, projectWorkspacePath, writeProjectFolderBdx, type ProjectSourceOwner } from "./projectFiles";
import { loadProjectFolderSelection, loadProjectSelection, type ProjectSelection } from "./projectOpening";
import { createNamedProjectSelection, createProjectCopyFolder, parseNamedProjectRequest, suggestProjectCopy, StaleCopyDefaults, type ProjectCopyMark } from "./projectCreation";
import { ensureProjectsHomeForRequest, projectsHomePath } from "./projectsHome";
import { completeProjectActivation } from "./projectActivation";
import { describeUpdateFailure, OFFICIAL_RELEASES_URL } from "./updateFailure";
import { GitHubReleaseProvider } from "./githubReleaseProvider";
import { listRecentProjects, recentProjectPathById, readRecentProjectFiles, rememberRecentProject, removeRecentProjectById, writeRecentProjectFiles } from "./recentProjectFiles";
import { revealRecentProject } from "./projectRecentActions";
import { AgentBridgeClient, AgentBridgeServer } from "./agentBridge";
import { appUpdateChannel, AppUpdateController, UpdateQuitCoordinator, usesGitHubAppUpdates } from "./appUpdates";
import {
  DiagnosticBundleCapability,
  buildDiagnosticBundle,
  diagnosticFieldPin,
  saveDiagnosticPreview,
  type DiagnosticBundleInput,
} from "./diagnosticBundle";
import { AgentSessionService } from "./agentSession";
import { runAgentPlanningInWorker } from "./agentPlanningWorkerClient";
import { quitAfterMcpInputEnds } from "./mcpStdioLifecycle";
import { serveBordeauxMcp } from "../mcp/server";
import { RobotPairingController, readRobotPairing, writeRobotPairing } from "./robotPairings";
import { connectRobotSftp } from "./robotSsh2Session";
import { RobotFileDelivery, readRobotFileConnection, writeRobotFileConnection } from "./robotFileDelivery";
import type { RobotFileEndpoint } from "../shared/robotFileDelivery";
import { describeProjectWriteError, projectWriteFact, projectWriteFactFromMessage } from "../shared/project/writeErrors";
import { ProjectSourcePersistence, ProjectSourceError, sameProjectContext, canonicalProjectDigest } from "./projectSourcePersistence";
import { projectFolderIdentity, sameProjectFolder } from "./projectFolderIdentity";
import { ProjectPersistence, ReloadStale, type SavedProjectCheckpoint } from "./projectPersistence";
import { reloadProjectSource, revealProjectSource, ProjectActivationFolderChanged } from "./projectSourceActions";
import { ProjectRecoveryStore } from "./projectRecoveryStore";
import { ProjectRecoveryCatalog } from "./projectRecoveryCatalog";
import { ProjectStartup } from "./projectStartup";
import type { ProjectDepartureCoordinator } from "./projectDeparture";
import { ProjectNativeDeparture } from "./projectNativeDeparture";
import type { ProjectDepartureFallback, ProjectDurabilityContext } from "../shared/project/projectDurability";
import type { ProjectCheckpointRequest, ProjectCheckpointSaveResult, ProjectSaveCheckpointRequest, ProjectReloadRequest, ProjectRecoveredFrom, ProjectResumeDescriptor, ProjectStartupRequest, ProjectStartupDetachResult, ProjectTransitionToken } from "../shared/project/projectPersistence";
import {
  BordeauxRobotTransport,
  type RobotEndpoint,
} from "./robotSftpTransport";

// Running the entry file directly makes Electron report its own version.
const applicationVersion: string = app.isPackaged ? app.getVersion() : require("../../package.json").version;
// One BDX worker job accepts at most this many paths.
const MAX_BDX_BATCH = 64;

function readableRobotProjectError(error: unknown, name = "LabVIEW project"): Error { return new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`); }

function ignoreClosedStandardStream(error: NodeJS.ErrnoException): void {
  if (error.code !== "EIO" && error.code !== "EPIPE") throw error;
}

process.stdout.on("error", ignoreClosedStandardStream);
process.stderr.on("error", ignoreClosedStandardStream);

let mainWindow: BrowserWindow | null = null;
let replacingProjectWindow = false;
let recentFiles: string[] = [];
let recentStoreUnavailable = false;
let currentProjectPath: string | null = null;
let currentProjectFolder: string | null = null;
// The opened legacy file stays current until its first workspace save.
let currentLegacyFile: string | null = null;
function projectLocation() { return { folderPath: currentProjectFolder, projectPath: currentProjectPath, ...(currentLegacyFile ? { legacyFile: currentLegacyFile } : {}) }; }
let projectTargetGeneration = 0;
let projectWindowEpoch = randomUUID();
let projectDocumentSession = randomUUID();
let compatibilitySnapshotRevision = 0;
let retiredProjectResume: ProjectResumeDescriptor | null = null;
function projectContext() { return { windowEpoch: projectWindowEpoch, documentSessionId: projectDocumentSession, targetGeneration: projectTargetGeneration }; }
let dirty = false;
let appUpdates: AppUpdateController | null = null;
let updateCheckTimer: NodeJS.Timeout | null = null;
let backgroundShutdownPromise: Promise<void> | null = null;
let backgroundServicesReadyForExit = false;
let finalQuitInProgress = false;
// Quit cleanup is bounded: an aborted robot transfer or agent socket that never settles must
// not keep Bordeaux alive. Native installers (ShipIt on macOS, NSIS on Windows) wait for this
// process to exit, so an update handoff also guarantees exit shortly after it begins.
const QUIT_CLEANUP_LIMIT_MS = 8_000;
const UPDATE_EXIT_GRACE_MS = 15_000;
const updateQuit = new UpdateQuitCoordinator();
let bridgeEnabledAtShutdown = false;

let currentRobotEditor: BordeauxProject["editor"];
let linkedRobotContext: ProjectDurabilityContext | null = null;
let suggestedRobotProject: { id: string; file: string; context: ProjectDurabilityContext } | null = null;
let linkedRobotProjectPath: string | null = null;
let linkedLabviewProjectFile: string | null = null;
let labviewInspectionInProgress = false;
let linkedRobotProjectBookmarkId: string | null = null;
let linkedRobotCatalog: RobotCommandCatalog | null = null;
let robotConnectionGeneration = 0;
let robotProjectBookmarks: RobotProjectBookmark[] = [];
let robotPairings = new RobotPairingController();
const robotTransport = new BordeauxRobotTransport(connectRobotSftp);
let robotFileDelivery = new RobotFileDelivery(null, value => writeRobotFileConnection(robotFileConnectionFile(), value));
const diagnosticBundleCapability = new DiagnosticBundleCapability();
const smokeDirectory = process.env.BORDEAUX_SMOKE_DIRECTORY;
const mcpStdioMode = process.argv.includes("--mcp-stdio");
const enableMcpAccessOnLaunch = process.argv.includes("--enable-mcp-access");
let agentBridge: AgentBridgeServer | null = null;
const proposalReceipts = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

function clearLinkedRobotProject(): void {
  robotConnectionGeneration += 1;
  projectSources.revalidateExports();
  linkedRobotContext = null;
  suggestedRobotProject = null;
  linkedRobotProjectPath = null;
  linkedLabviewProjectFile = null;
  linkedRobotProjectBookmarkId = null;
  linkedRobotCatalog = null;
  agentSessions.refreshRobotCatalog();
}

function rejectProposalReceipts(message: string): void {
  for (const receipt of proposalReceipts.values()) {
    clearTimeout(receipt.timer);
    receipt.reject(new Error(message));
  }
  proposalReceipts.clear();
}

const agentSessions = new AgentSessionService(
  (proposal, requireReceipt) => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) throw new Error("The Bordeaux editor is not ready to preview an agent proposal.");
    if (!requireReceipt) {
      mainWindow.webContents.send("agent:proposal", proposal);
      return;
    }
    const receipt = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        proposalReceipts.delete(proposal.id);
        reject(new Error("The Bordeaux editor did not acknowledge the proposal preview."));
      }, 2_000);
      proposalReceipts.set(proposal.id, { resolve, reject, timer });
    });
    mainWindow.webContents.send("agent:proposal", proposal);
    return receipt;
  },
  () => linkedRobotCatalog,
  runAgentPlanningInWorker,
);

app.setName("Bordeaux");
if (smokeDirectory) app.setPath("userData", smokeDirectory);
app.setAppUserModelId("org.frc2468.bordeaux");
const ownsDesktopInstance = mcpStdioMode || app.requestSingleInstanceLock();
if (!ownsDesktopInstance) app.quit();

const projectRecovery = new ProjectRecoveryStore(userDataPath("recovery"));
const projectRecoveryCatalog = new ProjectRecoveryCatalog(userDataPath("recovery"), projectRecovery, filename => shell.showItemInFolder(filename));
const projectSources: ProjectSourcePersistence = new ProjectSourcePersistence({ getContext: projectContext,
  write: (folder, project, target, options) => {
    options.assertCurrent();
    const linked = sameProjectContext(linkedRobotContext, projectContext()) ? { file: linkedLabviewProjectFile, bookmark: linkedRobotProjectBookmarkId } : undefined;
    return autosaveProjectFolder(folder, rebaseProjectLabviewLink(project, currentProjectFolder, folder, linked), target, options);
  }, commit: (capture, savedProject, target) => {
  projectSources.assertCurrent(capture);
  const legacyFile = currentLegacyFile;
  const linked = sameProjectContext(linkedRobotContext, projectContext());
  if (currentProjectPath !== target) activateProjectTarget(target);
  currentRobotEditor = savedProject.editor;
  if (linked && labviewLinkMatches(savedProject.editor, currentProjectFolder, linkedLabviewProjectFile, linkedRobotProjectBookmarkId)) linkedRobotContext = projectContext();
  else if (linked) clearLinkedRobotProject();
  projectPersistence.sourceTargetCommitted(capture.operationId, projectContext());
  if (legacyFile && path.dirname(path.resolve(legacyFile)) === path.dirname(target)) recentFiles = recentFiles.filter(file => path.resolve(file) !== path.resolve(legacyFile));
  // Active state changes synchronously under the lease; the recents write has no later active-state continuation.
  void rememberFile(path.dirname(target)).catch(error => console.warn("Could not remember the saved project:", error));
  return { context: projectContext(), location: projectLocation() };
} });
const projectPersistence: ProjectPersistence = new ProjectPersistence({ source: projectSources, recovery: projectRecovery, getContext: projectContext, getLocation: projectLocation,
  onUpdate: update => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    try { mainWindow.webContents.send("project:checkpointUpdate", update); }
    catch { console.warn("Could not deliver project checkpoint progress to the editor"); }
  } });
let attachedProjectDeparture: ProjectDepartureCoordinator | null = null;
/** Attach receipt accounting to the actual native event adapter. */
export function attachProjectDepartureCoordinator(coordinator: ProjectDepartureCoordinator): void {
  attachedProjectDeparture = coordinator; projectPersistence.attachDepartureCoordinator(coordinator);
}
export const publishProjectDepartureCheckpoint = (update: import("../shared/project/projectDurability").ProjectCheckpointUpdate) => projectPersistence.handleDepartureUpdate(update);
export const cancelProjectDepartureCheckpoint = (requestId: string) => projectPersistence.handleDepartureCancelled(requestId);
export const captureProjectResumeDescriptor = () => ({ session: projectPersistence.getSession(), pendingWrites: projectSources.pendingWrites() });
export const getRetiredProjectResumeDescriptor = () => retiredProjectResume && structuredClone(retiredProjectResume);
export const getMainProjectTransitionId = () => projectPersistence.getTransitionId();
export const isProjectLifecycleReady = () => projectPersistence.isLifecycleReady();
const fallbackDialogs = new Map<string, { abort: AbortController; owner?: BrowserWindow }>();
const fallbackDialogOwners = new Set<BrowserWindow>();
function sendProjectEvent(channel: string, value: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  try { mainWindow.webContents.send(channel, value); } catch { /* Liveness fallback owns an undeliverable request. */ }
}
function dismissProjectFallback(id: string): void {
  const pending = fallbackDialogs.get(id);
  if (!pending) return;
  fallbackDialogs.delete(id); pending.abort.abort();
  if (pending.owner) {
    // The owner carries no authored document and never becomes the trusted mainWindow.
    if (!pending.owner.isDestroyed()) pending.owner.destroy();
    fallbackDialogOwners.delete(pending.owner);
  }
}
function showProjectFallback(fallback: ProjectDepartureFallback): void {
  const abort = new AbortController();
  let parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  let owner: BrowserWindow | undefined;
  if (!parent) {
    owner = new BrowserWindow({ show: false, width: 1, height: 1, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    fallbackDialogOwners.add(owner); parent = owner;
  }
  fallbackDialogs.set(fallback.fallbackId, { abort, owner });
  const session = mainWindow ? projectPersistence.getSession() : retiredProjectResume?.session;
  const recovery = session?.latestRecovery;
  const detail = recovery ? `Last recovery copy: ${new Date(recovery.capturedAt).toLocaleTimeString()}. Later edits may be lost.` : "No recovery copy yet. Unsaved edits may be lost.";
  const gone = fallback.cause === "renderer-gone";
  const verb = fallback.request.reason === "close" ? "Close" : fallback.request.reason.startsWith("reload") ? "Reload" : fallback.request.reason === "update" ? "Install" : "Quit";
  void dialog.showMessageBox(parent, { type: "warning", title: "Bordeaux", message: gone ? "The editor stopped" : "Bordeaux isn’t responding", detail,
    buttons: [gone ? "Reopen editor" : "Wait", gone ? verb : `${verb} anyway`], defaultId: 0, cancelId: 0, noLink: true, signal: abort.signal,
  }).then(result => {
    if (fallbackDialogs.get(fallback.fallbackId)?.abort !== abort || abort.signal.aborted) return;
    nativeDeparture.coordinator.decideFallback(fallback.fallbackId, result.response === 1 ? "anyway" : gone ? "reopen" : "wait");
  }, error => {
    if (abort.signal.aborted) return;
    console.warn("Could not show project departure fallback:", error);
    nativeDeparture.coordinator.decideFallback(fallback.fallbackId, "aborted");
  }).finally(() => dismissProjectFallback(fallback.fallbackId));
}
const nativeDeparture = new ProjectNativeDeparture({
  getContext: () => mainWindow ? projectContext() : null,
  isRendererAlive: epoch => Boolean(mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed() && !mainWindow.webContents.isCrashed() && projectWindowEpoch === epoch),
  isTrustedSender: (sender, context) => {
    try { assertTrustedSender(sender as Electron.IpcMainInvokeEvent); return sameProjectContext(context, projectContext()); } catch { return false; }
  },
  getTransitionId: getMainProjectTransitionId,
  onRequest: request => { if (projectPersistence.isLifecycleReady()) sendProjectEvent("project:departure", request); },
  onCheckpoint: publishProjectDepartureCheckpoint,
  onCancelled: requestId => { cancelProjectDepartureCheckpoint(requestId); sendProjectEvent("project:departureCancelled", requestId); },
  onFallback: showProjectFallback, onDismissFallback: dismissProjectFallback,
  close: epoch => {
    if (mainWindow && projectWindowEpoch === epoch && !mainWindow.isDestroyed()) mainWindow.close();
    else if (!mainWindow && process.platform !== "darwin") app.quit();
  },
  reload: (epoch, ignoreCache) => {
    if (!mainWindow || mainWindow.isDestroyed() || projectWindowEpoch !== epoch) return;
    retiredProjectResume = captureProjectResumeDescriptor();
    if (ignoreCache) mainWindow.webContents.reloadIgnoringCache(); else mainWindow.webContents.reload();
  },
  quit: () => app.quit(),
  install: () => { void appUpdates?.install(); },
  forceExit: () => { console.warn("Bordeaux did not finish its approved update quit; exiting for the installer."); app.exit(0); },
  exitGraceMs: UPDATE_EXIT_GRACE_MS,
  onReopen: () => {
    const previous = mainWindow;
    if (previous) retiredProjectResume = captureProjectResumeDescriptor();
    projectPersistence.contextChanged();
    replacingProjectWindow = true;
    try {
      mainWindow = null;
      if (previous && !previous.isDestroyed()) previous.destroy();
      createWindow();
    } finally { replacingProjectWindow = false; }
  },
});
attachProjectDepartureCoordinator(nativeDeparture.coordinator);
function appUpdateState() {
  const state = appUpdates?.snapshot();
  return state && { ...state, ...(nativeDeparture.installAttemptId ? { installAttemptId: nativeDeparture.installAttemptId } : {}) };
}
function replaceProjectSession(recoveredFrom?: ProjectRecoveredFrom) {
  currentRobotEditor = undefined;
  projectDocumentSession = randomUUID(); compatibilitySnapshotRevision = 0; projectPersistence.contextChanged(true, recoveredFrom);
}
async function knownRecentProjectPaths(): Promise<string[]> {
  if (!recentStoreUnavailable) return [...recentFiles];
  const previous = recentFiles, epoch = projectWindowEpoch;
  let read: string[];
  try { read = await readRecentProjectFiles(recentProjectsFile()); }
  catch { throw new Error("Couldn’t check recent projects"); }
  if (recentFiles === previous && projectWindowEpoch === epoch) { recentFiles = read; recentStoreUnavailable = false; }
  return [...recentFiles];
}
const projectStartup = new ProjectStartup({ getSession: () => projectPersistence.getSession(), isTransitionCurrent: token => projectPersistence.isTransitionCurrent(token),
  readRecents: knownRecentProjectPaths, getResume: getRetiredProjectResumeDescriptor, listRecoveries: () => projectRecoveryCatalog.list(), assertReadable: assertProjectSourceReadable,
  activate: async (selected, assertCurrent, committed) => {
    const physicalSource = await assertProjectSourceReadable(selected, assertCurrent); assertCurrent();
    const selection = await loadProjectSelection(physicalSource, { assertCurrent, requireSource: true }); assertCurrent();
    return activateProjectSelection(selection, { rememberInBackground: true, assertCurrent, committed });
  } });

function stopBackgroundServices(): Promise<void> {
  diagnosticBundleCapability.clear();
  rejectProposalReceipts("Bordeaux is shutting down.");
  if (backgroundShutdownPromise) return backgroundShutdownPromise;
  const bridge = agentBridge;
  bridgeEnabledAtShutdown = bridge?.enabled === true;
  agentBridge = null;
  backgroundShutdownPromise = Promise.all([robotFileDelivery.stop(), bridge?.stop()]).then(() => undefined);
  return backgroundShutdownPromise;
}

function createAppUpdateController(): AppUpdateController {
  const supported = usesGitHubAppUpdates(
    process.platform,
    process.windowsStore,
    process.env.PORTABLE_EXECUTABLE_FILE !== undefined,
    process.env.APPIMAGE !== undefined,
  );
  const packaged = app.isPackaged;
  if (packaged && supported) {
    updateClient.setFeedURL({ provider: "custom", updateProvider: GitHubReleaseProvider });
    // API asset URLs do not expose sibling blockmap paths. Full downloads retain
    // the manifest checksum and native installer signature verification.
    updateClient.disableDifferentialDownload = true;
  }
  return new AppUpdateController(packaged && supported ? updateClient : null, {
    packaged,
    supported,
    currentVersion: applicationVersion,
    isProjectDirty: () => dirty,
    describeError: (error) => describeUpdateFailure(error instanceof Error ? error.message : String(error)),
    warn: (message, error) => console.warn(message, error),
  }, (state) => {
    // A native installation failure leaves Bordeaux running: cancel the forced exit and,
    // because Electron closes every window before the macOS handoff, bring the editor back.
    if (state.phase === "installing") updateQuit.installing();
    if (state.phase === "error" && state.errorStage === "install") {
      nativeDeparture.installationFailed();
      updateQuit.installFailed();
      if (!updateQuit.quitInProgress && (!mainWindow || mainWindow.isDestroyed())) createWindow();
    }
    sendProjectEvent("appUpdates:state", { ...state, ...(nativeDeparture.installAttemptId ? { installAttemptId: nativeDeparture.installAttemptId } : {}) });
  });
}

// Emitted by Electron on macOS and by electron-updater on Windows and Linux once the
// installer handoff has started.
nativeAutoUpdater.on("before-quit-for-update", () => {
  if (updateQuit.handoff()) nativeDeparture.updateHandoff();
});

function activateProjectTarget(filePath: string | null): void {
  currentProjectPath = filePath;
  currentProjectFolder = filePath ? path.dirname(filePath) : null;
  currentLegacyFile = null;
  projectTargetGeneration += 1;
}

async function rememberFile(filePath: string) {
  recentFiles = rememberRecentProject(recentFiles, filePath);
  app.addRecentDocument(filePath);
  buildMenu();
  try {
    await writeRecentProjectFiles(recentProjectsFile(), recentFiles);
    recentStoreUnavailable = false;
  } catch (error) {
    console.warn("Could not save recent Bordeaux projects:", error);
  }
}

function assertTrustedSender(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error("Unauthorized renderer request");
  }
}

// Smoke tests redirect userData to their fixture directory at startup.
function userDataPath(name: string): string { return path.join(app.getPath("userData"), name); }
function robotProjectBookmarksFile(): string { return userDataPath("robot-projects.json"); }
function recentProjectsFile(): string { return userDataPath("recent-projects.json"); }
function robotPairingFile(): string { return userDataPath("robot-pairing.json"); }
function robotFileConnectionFile(): string { return userDataPath("robot-sftp-connection.json"); }
function labviewDiscoveryCacheDirectory(): string { return userDataPath("labview-discovery"); }

async function rememberLinkedRobotProject(projectPath: string, projectName: string, runtime: RobotProjectRuntime): Promise<{ bookmarkId: string; warning?: string }> {
  robotProjectBookmarks = rememberRobotProject(robotProjectBookmarks, projectPath, projectName, new Date(), runtime);
  const bookmarkId = robotProjectBookmarks[0].id;
  try {
    await writeRobotProjectBookmarks(robotProjectBookmarksFile(), robotProjectBookmarks);
    return { bookmarkId };
  } catch (error) {
    console.warn("Could not save Robot project bookmarks:", error);
    return { bookmarkId, warning: "The project is linked for this session, but Bordeaux could not save it to Recent projects." };
  }
}

function assertRobotProjectContext(context: unknown): asserts context is ProjectDurabilityContext {
  if (!sameProjectContext(context as ProjectDurabilityContext, projectContext())) throw new Error("The Bordeaux project changed. Link robot code again.");
}
function linkedProjectMatches(project: BordeauxProject, folder = currentProjectFolder): boolean {
  return sameProjectContext(linkedRobotContext, projectContext())
    && labviewLinkMatches(project.editor, folder, linkedLabviewProjectFile, linkedRobotProjectBookmarkId);
}
async function connectRobotProject(projectPath: string, runtime: RobotProjectRuntime, inspectedCatalog?: RobotCommandCatalog, cachedOnly = false, canonicalSelection = false) {
  const generation = ++robotConnectionGeneration;
  projectSources.revalidateExports();
  const context = projectContext();
  const guard = () => { assertRobotProjectContext(context); if (generation !== robotConnectionGeneration) throw new Error("LabVIEW project connection was superseded by another project"); };
  await statLabviewLocalPath(projectPath); guard();
  const labviewProject = runtime === "labview" ? await resolveLabviewProject(projectPath, { canonical: canonicalSelection }) : null;
  const selectedPath = projectPath; guard();
  const canonicalPath = labviewProject?.root ?? selectedPath;
  const exactSelection = labviewProject?.projectFile ?? selectedPath;
  const diskCatalog = await discoverRobotProject(exactSelection, runtime); guard();
  const discoveredCatalog = inspectedCatalog ?? (runtime === "labview"
    ? cachedOnly ? await withCachedLabviewCommands(exactSelection, diskCatalog, labviewDiscoveryCacheDirectory()) : await syncLabviewCommands(exactSelection, labviewDiscoveryCacheDirectory(), diskCatalog)
    : diskCatalog);
  const catalog: RobotCommandCatalog = {
    ...discoveredCatalog,
    semanticFingerprint: `sha256:${createHash("sha256").update(robotCatalogSemanticSignature(discoveredCatalog), "utf8").digest("hex")}`,
  };
  const integration: RobotIntegrationStatus = {
    installed: catalog.authoritative === true,
    generatedCatalog: catalog.authoritative === true,
    supportVersion: catalog.supportVersion,
    ...(catalog.catalogHash ? { catalogHash: catalog.catalogHash } : {}),
    buildFile: LABVIEW_CATALOG_SOURCE,
    runtime: "labview",
    wrapperAvailable: true,
  };
  guard();
  const remembered = await rememberLinkedRobotProject(exactSelection, catalog.projectName, runtime);
  guard();
  linkedRobotContext = context;
  suggestedRobotProject = null;
  linkedRobotProjectPath = canonicalPath;
  linkedLabviewProjectFile = labviewProject?.projectFile ?? null;
  linkedRobotProjectBookmarkId = remembered.bookmarkId;
  linkedRobotCatalog = catalog;
  projectSources.revalidateExports();
  agentSessions.refreshRobotCatalog();
  return {
    catalog,
    integration,
    bookmarkId: remembered.bookmarkId,
    recentProjects: summarizeRobotProjectBookmarks(robotProjectBookmarks),
    ...(remembered.warning ? { warning: remembered.warning } : {}),
  };
}

async function replaceRobotProject(projectPath: string, runtime: RobotProjectRuntime, cachedOnly = false) {
  const context = projectContext();
  // Explicit Link/Use/recent authors a new link; existing documents keep their spelling on restore/refresh.
  const pending = connectRobotProject(projectPath, runtime, undefined, cachedOnly, true);
  const generation = robotConnectionGeneration;
  try {
    return await pending;
  } catch (error) {
    if (generation === robotConnectionGeneration && sameProjectContext(context, projectContext())) clearLinkedRobotProject();
    throw error;
  }
}

async function robotExportTargetSnapshot(target: string): Promise<string> {
  try {
    const stat = await fs.promises.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Existing Robot export target must be a regular file");
    if (stat.size > 64 * 1024 * 1024) throw new Error("Existing Robot export target exceeds the 64 MiB safety limit");
    const hash = createHash("sha256").update(await fs.promises.readFile(target)).digest("hex");
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${hash}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

/** Selected exports into a project participate in the same physical lease and ownership journal as Save. */
async function writeSelectedProjectBdx(target: string, bytes: Uint8Array, before: string, assertCurrent: () => void): Promise<void> {
  const parent = path.dirname(target), folder = path.dirname(parent);
  let managed = false;
  if (path.basename(parent).toLowerCase() === "paths") {
    try {
      await fs.promises.lstat(projectWorkspacePath(folder));
      managed = path.basename(parent) === "Paths"
        || await fs.promises.realpath(parent) === await fs.promises.realpath(path.join(folder, "Paths"));
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  assertCurrent();
  const identity = managed ? await projectFolderIdentity(folder, { assertCurrent }) : undefined;
  const release = managed ? await projectSources.holdExport(folder, assertCurrent) : undefined;
  try {
    if (await robotExportTargetSnapshot(target) !== before) throw new Error("BDX destination changed during review; export again");
    assertCurrent();
    if (identity) {
      await writeProjectFolderBdx(identity.folderPath, [{ fileName: path.basename(target), bytes }], { mode: "selected", folderIdentity: identity, assertCurrent });
    } else await writeBufferAtomically(target, bytes, { assertCurrent });
  } finally { release?.(); }
}

// Export and robot transfer reject BDX work that outlives its project target or LabVIEW link.
function captureLinkedProject(project: BordeauxProject) {
  const generation = robotConnectionGeneration, projectGeneration = projectTargetGeneration;
  const projectFile = linkedLabviewProjectFile, bookmark = linkedRobotProjectBookmarkId;
  if (projectFile && !linkedProjectMatches(project)) throw new Error("The linked LabVIEW project does not match this Bordeaux project");
  return {
    bindingOptions: (hasCommands: boolean) => ({ projectFile: hasCommands ? projectFile : null, inspectionCacheDirectory: labviewDiscoveryCacheDirectory(), activeCatalog: linkedRobotCatalog }),
    isCurrent: () => generation === robotConnectionGeneration && projectGeneration === projectTargetGeneration
      && projectFile === linkedLabviewProjectFile && bookmark === linkedRobotProjectBookmarkId,
  };
}

function handle(channel: string, listener: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown) {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedSender(event);
    return listener(event, ...args);
  });
}

function diagnosticCatalog(catalog: RobotCommandCatalog | null): DiagnosticBundleInput["catalog"] {
  if (!catalog?.authoritative || !catalog.catalogId || !catalog.catalogHash || !catalog.supportVersion
    || (catalog.generatedSchemaVersion !== "1.0" && catalog.generatedSchemaVersion !== "1.1" && catalog.generatedSchemaVersion !== "1.2" && catalog.generatedSchemaVersion !== "1.3")) {
    return null;
  }
  return {
    schemaVersion: catalog.generatedSchemaVersion,
    catalogId: catalog.catalogId,
    catalogHash: catalog.catalogHash,
    supportVersion: catalog.supportVersion,
  };
}

function diagnosticIssueCount(error: unknown): number {
  const message = error instanceof Error ? error.message : "";
  return Math.max(1, Math.min(1_000, message.split("\n").filter((line) => line.trim()).length));
}

function createWindow() {
  projectWindowEpoch = randomUUID();
  activateProjectTarget(null);
  replaceProjectSession();
  dirty = false;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    title: "Bordeaux",
    ...(process.platform === "darwin" ? {
      titleBarStyle: "hiddenInset" as const,
      trafficLightPosition: { x: 14, y: 18 },
    } : {}),
    backgroundColor: "#12151b",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const window = mainWindow;
  let windowEpoch = projectWindowEpoch, initialNavigation = true;
  nativeDeparture.documentEntered(projectContext());
  window.once("ready-to-show", () => {
    window.show();
    if (appUpdates?.available && !updateCheckTimer) {
      updateCheckTimer = setTimeout(() => {
        void appUpdates?.check(false);
        updateCheckTimer = setInterval(() => { void appUpdates?.check(false); }, 6 * 60 * 60 * 1000);
        updateCheckTimer.unref();
      }, 10_000);
      updateCheckTimer.unref();
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // A rejected direct reload must not rotate the still-live document epoch. Rotate only after navigation commits.
  window.webContents.on("did-frame-navigate", (_event, _url, _code, _status, isMainFrame) => {
    if (!isMainFrame || mainWindow !== window) return;
    if (initialNavigation) { initialNavigation = false; return; }
    retiredProjectResume = captureProjectResumeDescriptor();
    projectWindowEpoch = randomUUID(); windowEpoch = projectWindowEpoch;
    activateProjectTarget(null); replaceProjectSession(); dirty = false;
    nativeDeparture.documentEntered(projectContext());
    rejectProposalReceipts("The Bordeaux editor reloaded before acknowledging the proposal.");
    agentSessions.resetAccess(agentBridge?.enabled === true);
  });
  window.on("close", event => {
    if (mainWindow === window && !nativeDeparture.windowClose(windowEpoch)) event.preventDefault();
  });
  window.webContents.on("will-prevent-unload", event => {
    if (mainWindow === window && nativeDeparture.preventUnload(windowEpoch)) event.preventDefault();
  });
  window.on("unresponsive", () => { if (mainWindow === window) nativeDeparture.coordinator.notifyUnresponsive(windowEpoch); });
  window.webContents.on("render-process-gone", () => {
    if (mainWindow !== window) return;
    retiredProjectResume = captureProjectResumeDescriptor();
    nativeDeparture.rendererGone(windowEpoch); // Keep the old context until its native fallback decision wins.
    const transitionId = projectPersistence.getTransitionId();
    if (transitionId) { const token = { id: transitionId, windowEpoch }; projectStartup.cancel(token); projectPersistence.endTransition(token); }
    projectPersistence.setLifecycleReady(projectContext(), false);
    projectPersistence.contextChanged(); // Revokes storage while the old fallback still owns this epoch.
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.on("closed", () => {
    if (mainWindow !== window) return;
    const expected = nativeDeparture.isExpectedWindowClose(windowEpoch);
    retiredProjectResume = captureProjectResumeDescriptor();
    if (!expected) nativeDeparture.windowVanished(windowEpoch);
    projectPersistence.contextChanged(); // Fence before removing the old context; preserve an approved quit chain.
    mainWindow = null;
    if (expected) nativeDeparture.windowClosed(windowEpoch);
    rejectProposalReceipts("The Bordeaux editor closed before acknowledging the proposal.");
    agentSessions.resetAccess(agentBridge?.enabled === true);
  });

  void window.loadFile(path.join(__dirname, "../../dist-renderer/index.html"));

  if (process.env.BORDEAUX_SMOKE_TEST === "1") {
    window.webContents.once("did-finish-load", async () => {
      let inputRunning = false;
      const inputTimer = setInterval(() => {
        if (inputRunning || window.isDestroyed()) return;
        inputRunning = true;
        void window.webContents.executeJavaScript('window.__bordeauxSmokeInput || null').then(async (point) => {
          if (!point) return;
          window.focus();
          window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'M' });
          window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'M' });
          await new Promise((resolve) => setTimeout(resolve, 30));
          window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
          window.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
          window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
          await window.webContents.executeJavaScript('window.__bordeauxSmokeInput = null');
        }).catch(() => undefined).finally(() => { inputRunning = false; });
      }, 10);
      try {
        if (!smokeDirectory) throw new Error("Smoke test requires a fixture directory");
        if (process.platform === "darwin") app.focus({ steal: true });
        window.show();
        window.focus();
        const smokeScript = await fs.promises.readFile(path.join(smokeDirectory, "renderer.js"), "utf8");
        const result: Record<string, unknown> = await window.webContents.executeJavaScript(smokeScript);
        if (process.env.BORDEAUX_SMOKE_CAPTURE_PATH) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          const capture = await window.webContents.capturePage();
          await fs.promises.writeFile(process.env.BORDEAUX_SMOKE_CAPTURE_PATH, capture.toPNG());
        }
        const waitForSmoke = async (check: () => boolean | Promise<boolean>, label: string) => {
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
          throw new Error(`Smoke lifecycle timed out: ${label}`);
        };
        const smokeKey = (keyCode: string, modifiers: Electron.KeyboardInputEvent["modifiers"] = []) => {
          window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
          window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
        };
        // The renderer smoke intentionally leaves an invalid numeric draft. Closing must now preserve it.
        if (process.platform === "darwin") app.focus({ steal: true });
        window.focus(); window.webContents.focus();
        await waitForSmoke(() => window.webContents.executeJavaScript("document.hasFocus()"), "native focus");
        smokeKey("Escape"); // Dismiss the update panel used by the final screenshot with actual native input.
        await waitForSmoke(() => window.webContents.executeJavaScript("!document.querySelector('.app-update-dialog')?.open"), "update panel closed");
        window.close();
        await waitForSmoke(async () => !window.isDestroyed() && nativeDeparture.coordinator.snapshot().phase === "idle"
          && await window.webContents.executeJavaScript("document.activeElement?.getAttribute('aria-invalid') === 'true'"), "invalid draft blocks close and retains focus");
        result.invalidDraftBlockedClose = true;
        smokeKey("Home"); smokeKey("End", ["shift"]);
        await waitForSmoke(() => window.webContents.executeJavaScript("document.activeElement?.selectionStart === 0 && document.activeElement.selectionEnd === document.activeElement.value.length"), "native draft selection");
        for (const keyCode of "8.25") {
          window.webContents.sendInputEvent({ type: "keyDown", keyCode });
          window.webContents.sendInputEvent({ type: "char", keyCode });
          window.webContents.sendInputEvent({ type: "keyUp", keyCode });
        }
        await waitForSmoke(() => window.webContents.executeJavaScript("document.hasFocus() && document.activeElement?.value === '8.25'"), "exact valid uncommitted draft");
        const closed = new Promise<void>(resolve => window.once("closed", resolve));
        window.close();
        await Promise.race([closed, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Smoke close did not finish after valid draft")), 15_000))]);
        const filesWritten = fs.existsSync(projectWorkspacePath(smokeDirectory)) && fs.existsSync(path.join(smokeDirectory, "Smoke.bdx")) && fs.existsSync(path.join(smokeDirectory, "Paths")) && fs.existsSync(path.join(smokeDirectory, "Routines"));
        result.filesWritten = filesWritten;
        const closeState = nativeDeparture.coordinator.snapshot(), departure = closeState.permit;
        const closedFolder = closeState.checkpoint?.location?.folderPath;
        const closedSource = closedFolder ? await openProjectFolder(closedFolder, { recordOpened: false }) : null;
        result.closedWithExactSourceReceipt = window.isDestroyed() && departure?.request.reason === "close" && departure.basis === "source"
          && Boolean(closedSource?.project && closedSource.project.robot.driveModel?.gearRatio === 8.25
            && canonicalProjectDigest(closedSource.project) === departure.receipt?.digest);
        clearInterval(inputTimer);
        console.log(`BORDEAUX_SMOKE_RESULT ${JSON.stringify(result)}`);
        await stopBackgroundServices();
        backgroundServicesReadyForExit = true;
        app.exit(0);
      } catch (error) {
        clearInterval(inputTimer);
        console.error("BORDEAUX_SMOKE_FAILED", error);
        app.exit(1);
      }
    });
  }
}

function sendCommand(command: string, payload?: unknown) {
  const update = appUpdates?.snapshot();
  if (update?.phase === "installing" && !update.installStalled) return;
  mainWindow?.webContents.send("menu-command", { command, payload });
}

/** A toggle opens a new access period; the editor publishes for it once notified. */
function syncMcpAccess(): void {
  agentSessions.resetAccess(agentBridge?.enabled === true);
  buildMenu();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("agent:mcpStatus", agentSessions.accessStatus());
}

function reloadProjectWindow(ignoreCache: boolean): void {
  const update = appUpdates?.snapshot();
  if (update?.phase === "installing" && !update.installStalled) return;
  if (mainWindow && !mainWindow.isDestroyed()) nativeDeparture.request(ignoreCache ? "reload-ignoring-cache" : "reload");
}

function updateMenuItem(): Electron.MenuItemConstructorOptions {
  return process.windowsStore
    ? { label: "Updates are managed by Microsoft Store", enabled: false }
    : { label: "Check for updates…", click: () => { void appUpdates?.check(true); } };
}

function buildMenu() {
  const recentSubmenu = recentFiles.length > 0
    ? recentFiles.map((filePath, index) => ({ label: path.basename(filePath), sublabel: filePath, click: () => sendCommand("open-recent", index) }))
    : [{ label: "No recent projects", enabled: false }];

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ label: app.name, submenu: [
      { role: "about" },
      updateMenuItem(),
      { type: "separator" },
      { role: "quit" },
    ] } as Electron.MenuItemConstructorOptions] : []),
    {
      label: "File",
      submenu: [
        // New names a project in its own folder; Projects lists recents. Neither shows the folder picker first.
        { label: "New project…", accelerator: "CmdOrCtrl+N", click: () => sendCommand("new-project") },
        { label: "Projects…", accelerator: "CmdOrCtrl+O", click: () => sendCommand("show-projects") },
        { label: "Open project folder…", click: () => sendCommand("open-project") },
        { label: "Open recent", submenu: recentSubmenu },
        { type: "separator" },
        { label: "Save", accelerator: "CmdOrCtrl+S", click: () => sendCommand("save-project") },
        { label: "Open project file…", accelerator: "CmdOrCtrl+Shift+O", click: () => sendCommand("open-project-file") },
        { label: "Save copy…", accelerator: "CmdOrCtrl+Shift+S", click: () => sendCommand("save-project-as") },
        { type: "separator" },
        { label: "Export selected path as BDX…", accelerator: "CmdOrCtrl+E", click: () => sendCommand("export-bdx") },
        { type: "separator" },
        process.platform === "darwin" ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Robot",
      submenu: [
        { label: "Link robot project…", click: () => sendCommand("robot-link") },
        { label: "Build command catalog…", click: () => sendCommand("robot-build") },
        { type: "separator" },
      ],
    },
    {
      label: "Agents",
      submenu: [
        {
          label: "Enable MCP access",
          type: "checkbox",
          checked: agentBridge?.enabled === true,
          click: () => {
            if (!agentBridge) return;
            const operation = agentBridge.enabled ? agentBridge.stop() : agentBridge.start().then(() => undefined);
            void operation.then(syncMcpAccess, (error) => {
              syncMcpAccess();
              void dialog.showErrorBox("Bordeaux MCP access", error instanceof Error ? error.message : String(error));
            });
          },
        },
        {
          label: agentBridge?.enabled ? "MCP access is available to this user" : "MCP access is off",
          enabled: false,
        },
        { type: "separator" },
        {
          label: "Copy MCP configuration",
          click: () => {
            const electronArgs = app.isPackaged ? ["--mcp-stdio"] : [path.join(__dirname, "main.js"), "--mcp-stdio"];
            const launch = process.platform === "win32"
              ? { command: process.execPath, args: electronArgs }
              : { command: "/usr/bin/env", args: ["-u", "ELECTRON_RUN_AS_NODE", process.execPath, ...electronArgs] };
            clipboard.writeText(JSON.stringify({ mcpServers: { bordeaux: launch } }, null, 2));
          },
        },
      ],
    },
    { label: "View", submenu: [...(!app.isPackaged ? [
      { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => reloadProjectWindow(false) },
      { label: "Force reload", accelerator: "CmdOrCtrl+Shift+R", click: () => reloadProjectWindow(true) },
    ] : []), { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] },
    ...(process.platform === "darwin" ? [] : [{ label: "Help", submenu: [
      updateMenuItem(),
      { type: "separator" },
      { label: `Bordeaux ${applicationVersion}`, enabled: false },
    ] } as Electron.MenuItemConstructorOptions]),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Own the initiating native window, document and transition through every asynchronous open/create step. */
function captureProjectActivation(): () => void {
  const window = mainWindow, context = projectContext(), transition = projectPersistence.getTransitionId();
  return () => {
    if (!window || mainWindow !== window || window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.isCrashed()
      || !sameProjectContext(context, projectContext()) || projectPersistence.getTransitionId() !== transition) {
      throw new Error("The project changed while opening. Choose it again.");
    }
  };
}

/** Classify a stale initiating window/context in process; custom Error fields never cross IPC. */
function captureProjectSourceAction(): () => void {
  const assertCurrent = captureProjectActivation();
  return () => { try { assertCurrent(); } catch { throw new ReloadStale(); } };
}

async function activateProjectSelection(selection: ProjectSelection, options: { rememberInBackground?: boolean; assertCurrent(): void; committed?: () => void }) {
  await projectSources.assertReadable(selection.folderPath, options.assertCurrent);
  const recoveryIdentity = await projectFolderIdentity(selection.folderPath, { assertCurrent: options.assertCurrent });
  if (recoveryIdentity.objectKey !== selection.sourceEvidence.identity.objectKey || !sameProjectFolder(recoveryIdentity, selection.sourceEvidence.identity)) throw new ProjectActivationFolderChanged("Project folder changed while opening. Open it again.");
  options.assertCurrent(); options.committed?.();
  retiredProjectResume = null;
  clearLinkedRobotProject();
  activateProjectTarget(selection.projectPath);
  currentProjectFolder = selection.folderPath;
  currentLegacyFile = selection.legacyFile;
  replaceProjectSession();
  currentRobotEditor = selection.project.editor;
  projectPersistence.admitSource(projectContext(), selection.sourceEvidence, selection.legacyFile);
  dirty = false;
  const generation = projectTargetGeneration, location = projectLocation(), context = projectContext();
  const remembered = rememberFile(selection.recentPath).catch(error => console.warn("Could not remember the opened project:", error));
  return completeProjectActivation(selection.project, {
    generation, location, session: projectPersistence.getSession(),
    remembered: options.rememberInBackground ? Promise.resolve() : remembered,
    currentGeneration: () => sameProjectContext(context, projectContext()) ? projectTargetGeneration : -1,
  });
}

async function openProjectFile(filePath: string, assertCurrent = captureProjectActivation()) {
  assertCurrent();
  const physicalSource = await assertProjectSourceReadable(filePath, assertCurrent);
  const selection = await loadProjectSelection(physicalSource, { assertCurrent });
  return activateProjectSelection(selection, { assertCurrent });
}

async function assertProjectSourceReadable(selected: string, assertCurrent?: () => void) {
  const stat = await fs.promises.lstat(selected).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
  const parent = path.dirname(selected), managed = /\.(path|routine)$/i.test(selected) && ["Paths", "Routines"].includes(path.basename(parent));
  const identity = await projectFolderIdentity(stat?.isDirectory() ? selected : managed ? path.dirname(parent) : parent, { assertCurrent });
  await projectSources.assertReadable(identity.folderPath, assertCurrent); assertCurrent?.();
  return stat?.isDirectory() ? identity.folderPath : managed ? path.join(identity.folderPath, path.basename(parent), path.basename(selected)) : path.join(identity.folderPath, path.basename(selected));
}

handle("project:open", async () => {
  if (smokeDirectory) return openProjectFile(projectWorkspacePath(smokeDirectory));
  return chooseProjectFolder();
});

handle("project:openFile", async () => {
  const assertCurrent = captureProjectActivation();
  const result = await dialog.showOpenDialog(mainWindow!, { title: "Open Bordeaux Project or Path", properties: ["openFile"], filters: [{ name: "Bordeaux Project", extensions: ["bordeaux", "path", "json"] }] });
  if (result.canceled || !result.filePaths[0]) return null;
  return openProjectFile(result.filePaths[0], assertCurrent);
});

handle("project:openRecent", async (_event, rawIndex) => {
  if (!Number.isInteger(rawIndex) || typeof rawIndex !== "number" || rawIndex < 0 || rawIndex >= recentFiles.length) throw new Error("Recent project is no longer available");
  return openProjectFile(recentFiles[rawIndex]);
});

handle("project:listRecent", async () => listRecentProjects(await knownRecentProjectPaths()));

handle("project:removeRecent", async (_event, id) => {
  const previous = recentFiles, next = removeRecentProjectById(previous, id);
  if (next.length === previous.length) return { removed: false };
  recentFiles = next;
  buildMenu();
  try { await writeRecentProjectFiles(recentProjectsFile(), next); }
  catch (error) { if (recentFiles === next) { recentFiles = previous; buildMenu(); } throw error; }
  return { removed: true };
});

// Show in Finder/Explorer: a recent by its stable id, or this window's own admitted project by its exact context.
handle("project:revealRecent", (_event, target) => revealRecentProject(target, {
  recents: knownRecentProjectPaths, assertWindowCurrent: captureProjectSourceAction(), reveal: filename => shell.showItemInFolder(filename),
  current: context => sameProjectContext(context as ProjectDurabilityContext, projectContext()) ? projectLocation() : null,
}));

handle("project:openRecentById", async (_event, id) => {
  const file = recentProjectPathById(recentFiles, id), assertCurrent = captureProjectActivation();
  const physicalSource = await assertProjectSourceReadable(file, assertCurrent);
  const selection = await loadProjectSelection(physicalSource, { assertCurrent });
  assertCurrent();
  if (recentProjectPathById(recentFiles, id) !== file) throw new Error("Recent project is no longer in the list");
  return activateProjectSelection(selection, { assertCurrent });
});

handle("project:createNamed", async (_event, request) => {
  const assertCurrent = captureProjectActivation();
  await ensureProjectsHomeForRequest(request, projectsHome());
  assertCurrent();
  const selection = await createNamedProjectSelection(request);
  // A completed folder remains available even if its initiating window has retired.
  assertCurrent();
  return activateProjectSelection(selection, { assertCurrent });
});

handle("project:restoreLast", async () => {
  if (!recentFiles[0]) return null;
  try {
    return await openProjectFile(recentFiles[0]);
  } catch (error) {
    console.warn("Could not restore the last Bordeaux project:", error);
    return null;
  }
});

handle("project:new", () => {
  retiredProjectResume = null;
  activateProjectTarget(null);
  replaceProjectSession();
  dirty = false;
  clearLinkedRobotProject();
});

handle("project:location", () => projectLocation());
handle("project:session", () => projectPersistence.getSession());
handle("project:transitionBegin", (_event, context) => projectPersistence.beginTransition(context as ReturnType<typeof projectContext>));
handle("project:transitionEnd", (_event, rawToken) => {
  const token = rawToken as ProjectTransitionToken;
  if (projectStartup.isCommitted(token)) return { ended: false, busy: true };
  projectStartup.cancel(token);
  return { ended: projectPersistence.endTransition(token) };
});
handle("project:lifecycleReady", (_event, context, ready) => {
  const accepted = projectPersistence.setLifecycleReady(context as ReturnType<typeof projectContext>, ready as boolean);
  const pending = nativeDeparture.coordinator.snapshot();
  if (accepted && ready === true && pending.phase === "requesting" && pending.request && sameProjectContext(pending.request.context, projectContext())) sendProjectEvent("project:departure", pending.request);
  return { accepted };
});
handle("project:editingResumed", (event, context, attemptId) => {
  const state = appUpdates?.snapshot();
  return { accepted: Boolean(state?.phase === "installing" && state.installStalled && typeof attemptId === "string"
    && nativeDeparture.editingResumed(event, context as ProjectDurabilityContext, attemptId)) };
});
handle("project:startup", (_event, request) => {
  if (dirty) throw new Error("The editor has changes. Use Projects to open another source.");
  return projectStartup.probe(request as ProjectStartupRequest);
});
handle("project:startupAdopt", (_event, startupId, token) => {
  if (typeof startupId !== "string") throw new Error("Project startup is invalid");
  return projectStartup.adopt(startupId, token as ProjectTransitionToken);
});
handle("project:startupCancel", (_event, rawToken) => {
  const token = rawToken as ProjectTransitionToken, result = projectStartup.cancel(token);
  if (result.cancelled) projectPersistence.endTransition(token);
  return result;
});
handle("project:startupDetach", (_event, request) => projectStartup.detach(request as ProjectStartupRequest, () => {
  const captured = retiredProjectResume ?? captureProjectResumeDescriptor();
  const previous = captured.session.location.folderPath || captured.session.latestSource || captured.session.latestRecovery || captured.session.recoveredFrom || captured.pendingWrites.length ? captured : null;
  retiredProjectResume = null;
  activateProjectTarget(null); replaceProjectSession(); dirty = false; clearLinkedRobotProject();
  return { session: projectPersistence.getSession(), previous } satisfies ProjectStartupDetachResult;
}));
handle("project:checkpoint", (_event, request) => projectPersistence.checkpoint(request as ProjectCheckpointRequest));
handle("project:checkpointReplay", (_event, rawContext, operationId) => {
  if (typeof operationId !== "string") throw new Error("Project checkpoint operation is invalid");
  return projectPersistence.replay(rawContext as ReturnType<typeof projectContext>, operationId);
});
handle("project:checkpointCancel", (_event, rawContext, operationId) => {
  if (typeof operationId !== "string") throw new Error("Project checkpoint operation is invalid");
  return { cancelled: projectPersistence.cancel(rawContext as ReturnType<typeof projectContext>, operationId) };
});
handle("project:departureResponse", (event, response) => {
  if (!attachedProjectDeparture) throw new Error("Project departure integration is not attached");
  return { accepted: attachedProjectDeparture.respond(event, response as import("../shared/project/projectDurability").ProjectDepartureResponse) };
});
handle("project:departureResume", (event, token) => {
  if (!attachedProjectDeparture) throw new Error("Project departure integration is not attached");
  return { accepted: attachedProjectDeparture.resume(event, token as import("../shared/project/projectDurability").ProjectDepartureResume) };
});
handle("project:listRecoveries", (_event, options) => {
  if (options !== undefined && (!options || typeof options !== "object" || Array.isArray(options) || (options as { includeResolved?: unknown }).includeResolved !== undefined && typeof (options as { includeResolved?: unknown }).includeResolved !== "boolean")) throw new Error("Recovery listing options are invalid");
  return projectRecoveryCatalog.list({ includeResolved: (options as { includeResolved?: boolean } | undefined)?.includeResolved });
});
handle("project:prepareRecoveryDiscard", async (_event, rawContext, id) => {
  const context = projectContext();
  if (!rawContext || !sameProjectContext(rawContext as ProjectDurabilityContext, context)) throw new Error("Project recovery context is no longer current");
  const confirmation = await projectRecoveryCatalog.prepareDiscard(id, JSON.stringify(context));
  if (!sameProjectContext(context, projectContext())) throw new Error("Project recovery context is no longer current");
  return confirmation;
});
handle("project:discardRecovery", (_event, rawContext, token) => {
  const context = projectContext();
  if (!rawContext || !sameProjectContext(rawContext as ProjectDurabilityContext, context)) throw new Error("Project recovery context is no longer current");
  return projectRecoveryCatalog.discard(token, JSON.stringify(context), () => sameProjectContext(context, projectContext()));
});
handle("project:revealRecovery", (_event, id) => projectRecoveryCatalog.reveal(id));
handle("project:reloadSource", (_event, request) => reloadProjectSource(request as ProjectReloadRequest, {
  persistence: projectPersistence, assertWindowCurrent: captureProjectSourceAction(),
  assertReadable: assertProjectSourceReadable, activate: activateProjectSelection,
}));
handle("project:revealSource", (_event, context, file) => revealProjectSource(context as ProjectDurabilityContext, file as string, {
  persistence: projectPersistence, assertWindowCurrent: captureProjectSourceAction(), reveal: filename => shell.showItemInFolder(filename),
}));
handle("project:restoreRecovery", async (_event, rawContext, rawId) => {
  if (!rawContext || !sameProjectContext(rawContext as ReturnType<typeof projectContext>, projectContext()) || typeof rawId !== "string") throw new Error("Project recovery context is no longer current");
  const restored = await projectPersistence.prepareRestore(rawContext as ReturnType<typeof projectContext>, rawId);
  retiredProjectResume = null;
  clearLinkedRobotProject(); activateProjectTarget(null); replaceProjectSession(restored.recoveredFrom); currentRobotEditor = restored.project.editor; dirty = true;
  return { project: restored.project, location: projectLocation(), session: projectPersistence.getSession(), recoveredFrom: restored.recoveredFrom, dirty: true };
});
handle("project:readRecovery", async (_event, rawContext, rawId) => {
  if (!rawContext || !sameProjectContext(rawContext as ReturnType<typeof projectContext>, projectContext()) || typeof rawId !== "string") throw new Error("Project recovery context is no longer current");
  return projectPersistence.prepareRestore(rawContext as ReturnType<typeof projectContext>, rawId);
});
// New-project location: read-only defaults and a picker that only returns a folder, never opening or activating it.
function projectsHome(): string { return projectsHomePath(app.getPath("documents")); }
handle("project:creationDefaults", () => ({ parentDirectory: projectsHome() }));
handle("project:chooseParent", async (_event, rawCurrent) => {
  const current = typeof rawCurrent === "string" && path.isAbsolute(rawCurrent) && rawCurrent.length <= 4_096 && !rawCurrent.includes("\0") ? rawCurrent : projectsHome();
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: "Choose where to create the project", buttonLabel: "Choose",
    defaultPath: fs.existsSync(current) ? current : app.getPath("documents"),
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return { parentDirectory: result.filePaths[0] };
});
handle("project:openFolder", () => smokeDirectory ? openProjectFile(projectWorkspacePath(smokeDirectory)) : chooseProjectFolder());
async function chooseProjectFolder() {
  const assertCurrent = captureProjectActivation();
  const result = await dialog.showOpenDialog(mainWindow!, { title: "Choose project folder", properties: ["openDirectory", "createDirectory"] });
  if (result.canceled || !result.filePaths[0]) return null;
  return activateProjectFolder(result.filePaths[0], assertCurrent);
}

async function activateProjectFolder(folder: string, assertCurrent: () => void) {
  assertCurrent();
  await projectSources.assertReadable(folder, assertCurrent);
  const identity = await projectFolderIdentity(folder, { assertCurrent });
  const selection = await loadProjectFolderSelection(identity.folderPath, { assertCurrent });
  return activateProjectSelection(selection, { assertCurrent });
}

async function exportSaved(persisted: SavedProjectCheckpoint, scope: ProjectBdxExportScope): Promise<ProjectCheckpointSaveResult> {
  const source = persisted.canonicalProject, savedLocation = persisted.location;
  const selected = source.paths.filter(candidate => candidate.exportable !== false && candidate.waypoints.length >= 2);
  const projectFile = linkedLabviewProjectFile;
  const hasCommands = selected.some(candidate => candidate.markers.some(marker => marker.invocation));
  scope.assertCurrent();
  if (hasCommands && projectFile && !linkedProjectMatches(source, savedLocation.folderPath)) throw new Error("The linked LabVIEW project does not match this project");
  const options = { projectFile: hasCommands ? projectFile : null, inspectionCacheDirectory: labviewDiscoveryCacheDirectory(), activeCatalog: linkedRobotCatalog };
  scope.enterPhase("bindings");
  const bindings = await prepareBdxBindings(options); scope.assertCurrent();
  const files = [];
  for (let start = 0; start < selected.length; start += MAX_BDX_BATCH) {
    scope.enterPhase("build");
    const built = await buildBdxBatchOffThread({ project: source, selections: selected.slice(start, start + MAX_BDX_BATCH).map(candidate => ({ kind: "path", id: candidate.id })), bindings }, scope.signal);
    scope.assertCurrent(); files.push(...built.map(({ fileName, bytes }) => ({ fileName, bytes })));
  }
  scope.enterPhase("revalidate");
  const currentBindings = await prepareBdxBindings(options); scope.assertCurrent();
  if (currentBindings.definitionJson !== bindings.definitionJson) throw new ProjectBdxChangedError("Command definitions changed; save again to generate BDX files");
  scope.enterPhase("write");
  await writeProjectFolderBdx(scope.folderPath, files, { folderIdentity: scope.folderIdentity, expectedSourceDigest: scope.expectedSourceDigest,
    assertCurrent: () => scope.assertCurrent(), onWriteStarted: () => scope.markWriteStarted() });
  scope.assertCurrent(); return { saved: true, location: savedLocation, bdxCount: files.length };
}
function captureBinding() {
  const generation = robotConnectionGeneration, projectFile = linkedLabviewProjectFile, bookmark = linkedRobotProjectBookmarkId;
  return { key: JSON.stringify([generation, projectFile, bookmark]), isCurrent: () => generation === robotConnectionGeneration && projectFile === linkedLabviewProjectFile && bookmark === linkedRobotProjectBookmarkId };
}

async function projectCopyDefaults(raw: unknown) {
  const request = raw as ProjectCopyDefaultsRequest;
  const ctx = () => { if (!sameProjectContext(request?.context, projectContext())) throw new StaleCopyDefaults(); };
  ctx();
  const session = projectPersistence.getSession(), location = session.location, origin = session.recoveredFrom?.origin;
  const kind = origin ? "recovered" : location.legacyFile ? "legacy" : location.folderPath ? "folder" : "untitled";
  const hint = typeof request.nameHint === "string" && request.nameHint.length <= 1_024 ? request.nameHint : "";
  const base = kind === "folder" ? path.basename(location.folderPath!) : hint;
  const parent = origin ? origin.kind === "folder" ? path.dirname(origin.folderPath) : origin.kind === "legacy" ? origin.folderPath : null
    : location.legacyFile ? path.dirname(location.legacyFile) : location.folderPath ? path.dirname(location.folderPath) : null;
  return suggestProjectCopy({ kind, base, parent }, { ctx, home: projectsHome(), deadlineMs: 750 });
}
handle("project:copyDefaults", (_event, request) => projectCopyDefaults(request));

function copyFailure(error: unknown, mark: ProjectCopyMark): unknown {
  if (!(mark.creating || mark.created) || projectPersistence.ownsPendingDestination(mark.claimed)) return error;
  const raw = error instanceof Error ? error.message : String(error);
  if (/Choose another name/.test(raw)) return error;
  const fact = projectWriteFact((error as { code?: unknown })?.code) ?? projectWriteFactFromMessage(raw)
    ?? raw.split(/(?<=\.)\s/)[0].replace(/\.$/, "");
  console.warn("Save copy kept a folder it does not own:", raw);
  return new Error(`${fact} · Choose another name`);
}

/** Named copy admission is distinct from the existing departure/native picker. */
async function saveProjectCopy(request: ProjectSaveCheckpointRequest) {
  const raw = request.copyTo;
  if (request.saveAs === true || request.requestId !== undefined || !raw || typeof raw !== "object" || Array.isArray(raw)
    || (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null)
    || Reflect.ownKeys(raw).length !== 2 || !Object.hasOwn(raw, "name") || !Object.hasOwn(raw, "parentDirectory")) throw new Error("Project save request is invalid");
  if (!projectPersistence.isTransitionCurrent(request.transition!)) throw new Error("The project changed");
  const copyTo = parseNamedProjectRequest(raw);
  const validation = validateProjectSource(request.project);
  if (!validation.ok) throw new Error(validation.issues.map(item => `${item.path}: ${item.message}`).join("\n"));
  const capture = projectPersistence.captureRequest(request);
  const guard = () => {
    projectSources.assertCurrent(capture);
    if (!projectPersistence.isTransitionCurrent(request.transition!)) throw new ProjectSourceError("PROJECT_SOURCE_SUPERSEDED");
  };
  const mark: ProjectCopyMark = { creating: false, created: false };
  try {
    let required!: ProjectSourceOwner;
    try {
      await projectSources.admit(capture, async () => {
        guard(); await ensureProjectsHomeForRequest(copyTo, projectsHome()); guard();
        await projectPersistence.assertNotRecoveredOrigin(path.join(copyTo.parentDirectory, copyTo.name), guard); guard();
        const made = await createProjectCopyFolder(copyTo, { assertCurrent: guard, mark,
          allowExisting: folder => projectPersistence.pendingDestinationFor(folder, guard) }); guard();
        if ("existing" in made) { mark.claimed = made.existing; required = made.existing; }
        else required = await projectPersistence.claimCreatedDestination(capture, made.created, guard, mark);
        guard();
        await projectPersistence.assertDestination(required.identity.folderPath, guard); guard();
      });
      guard();
    } catch (error) { throw copyFailure(error, mark); }
    const folder = required.identity.folderPath;
    return await projectPersistence.saveWithExport(request, { folderPath: folder, projectPath: projectWorkspacePath(folder),
      createProject: true, requiredOwner: required }, capture, exportSaved, captureBinding);
  } finally { projectSources.revoke(capture); }
}

async function saveProjectWithSourceCheckpoint(project: unknown, rawSaveAs: unknown, request?: ProjectSaveCheckpointRequest) {
  const validation = validateProjectSource(project);
  if (!validation.ok) throw new Error(validation.issues.map((item) => `${item.path}: ${item.message}`).join("\n"));
  const sourceGeneration = projectTargetGeneration;
  const captureRequest: ProjectCheckpointRequest = request ?? { context: projectContext(), snapshotRevision: ++compatibilitySnapshotRevision, project: project as BordeauxProject };
  const capture = projectPersistence.captureRequest(captureRequest);
  try {
    const legacyFile = currentLegacyFile;
    let target = rawSaveAs === true ? null : currentProjectPath;
    let createProject = false;
    if (!target) {
      let folder = rawSaveAs === true ? null : currentProjectFolder;
      if (smokeDirectory) target = projectWorkspacePath(smokeDirectory);
      else {
        if (!folder) {
          const result = await dialog.showOpenDialog(mainWindow!, {
            title: "Choose project folder", properties: ["openDirectory", "createDirectory"],
            ...(currentProjectFolder ? { defaultPath: currentProjectFolder } : {}),
          });
          if (result.canceled || !result.filePaths[0]) return { canceled: true };
          folder = result.filePaths[0];
          projectSources.assertCurrent(capture);
          const selectedFolder = folder;
          await projectSources.admit(capture, async () => {
            const guard = () => projectSources.assertCurrent(capture);
            await projectPersistence.assertDestination(selectedFolder, guard); guard();
            if (sourceGeneration !== projectTargetGeneration) throw new Error("The project changed while choosing a folder. Save again.");
            if (!currentProjectFolder || path.resolve(selectedFolder) !== path.resolve(currentProjectFolder)) {
              await projectSources.assertReadable(selectedFolder, guard);
              const existing = await openProjectFolder(selectedFolder, { recordOpened: false, assertCurrent: guard }); guard();
              if (existing.project && !await projectPersistence.isPendingDestination(selectedFolder, guard)) throw new Error("That folder already contains a Bordeaux project. Open it or choose a different folder.");
            }
          });
        }
        target = projectWorkspacePath(folder);
        createProject = target !== currentProjectPath;
      }
    }
    projectSources.assertCurrent(capture);
    return await projectPersistence.saveWithExport(captureRequest, { folderPath: path.dirname(target), projectPath: target, createProject, legacyFile }, capture, exportSaved, captureBinding);
  } finally { projectSources.revoke(capture); }
}
handle("project:save", (_event, project, rawSaveAs) => saveProjectWithSourceCheckpoint(project, rawSaveAs));
handle("project:saveWithCheckpoint", (_event, rawRequest) => {
  const request = rawRequest as ProjectSaveCheckpointRequest;
  return request?.copyTo !== undefined ? saveProjectCopy(request) : saveProjectWithSourceCheckpoint(request?.project, request?.saveAs === true, request);
});

handle("project:autosave", async (_event, project) => {
  const validation = validateProjectSource(project);
  if (!validation.ok) return { saved: false, error: "Finish the invalid field before saving.", location: projectLocation() };
  try {
    const result = await projectPersistence.checkpoint({ context: projectContext(), snapshotRevision: ++compatibilitySnapshotRevision, project: project as BordeauxProject });
    return { saved: result.source === "saved", ...(result.source === "failed" || result.source === "timed-out" ? { error: result.sourceFact } : {}), location: result.location ?? projectLocation() };
  } catch (error) {
    return { saved: false, error: describeProjectWriteError(error), location: projectLocation() };
  }
});

handle("project:exportBdx", async (_event, rawProject, rawPathId) => {
  if (typeof rawPathId !== "string" || !rawPathId.trim()) throw new Error("Select a path before exporting BDX");
  const project = rawProject as BordeauxProject;
  const link = captureLinkedProject(project);
  const assertCurrent = () => {
    if (!link.isCurrent()) throw new Error("The selected project changed during BDX export; export again");
  };
  const hasCommands = project.paths.find((candidate) => candidate.id === rawPathId)?.markers.some((marker) => marker.invocation) === true;
  const bindingOptions = link.bindingOptions(hasCommands);
  const bindings = await prepareBdxBindings(bindingOptions);
  const built = await buildBdxOffThread({ project, selection: { kind: "path", id: rawPathId }, bindings });
  assertCurrent();
  const result = smokeDirectory ? { canceled: false, filePath: path.join(smokeDirectory, "Smoke.bdx") } : await dialog.showSaveDialog(mainWindow!, {
    title: "Export selected path as BDX",
    defaultPath: built.fileName, filters: [{ name: "Bordeaux binary path", extensions: ["bdx"] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const target = result.filePath.toLowerCase().endsWith(".bdx") ? result.filePath : result.filePath + ".bdx";
  const before = await robotExportTargetSnapshot(target);
  if (before !== "missing") {
    const review = await dialog.showMessageBox(mainWindow!, { type: "question", title: "Replace BDX file?", message: path.basename(target),
      detail: `${built.sampleCount} samples · ${built.eventCount} events · ${built.bytes.length} bytes\nThis writes a local path file. Robot code validates compatibility before execution.`,
      buttons: ["Cancel", "Replace"], defaultId: 0, cancelId: 0 });
    if (review.response !== 1) return { canceled: true };
  }
  const currentBindings = await prepareBdxBindings(bindingOptions);
  assertCurrent();
  if (currentBindings.definitionJson !== bindings.definitionJson) throw new Error("NI binding evidence changed during BDX export; review and export again");
  await writeSelectedProjectBdx(target, built.bytes, before, assertCurrent);
  return { exported: true, relativePath: path.basename(target), sha256: built.sha256,
    pathCount: built.pathCount, eventCount: built.eventCount, sampleCount: built.sampleCount };
});

handle("diagnostics:preview", async (_event, rawProject) => {
  const catalog = diagnosticCatalog(linkedRobotCatalog);
  let fieldPin = diagnosticFieldPin(rawProject);
  let exportStatus: DiagnosticBundleInput["export"] = { state: "unavailable" };
  let routinePreflight: DiagnosticBundleInput["routinePreflight"] = { state: "unavailable", issueCount: 0 };
  const matches = Boolean(rawProject && typeof rawProject === "object" && linkedProjectMatches(rawProject as BordeauxProject));
  if (catalog && matches) {
    try {
      const project = rawProject as BordeauxProject;
      const selected = project.paths.find((item) => item.id === project.editor?.activePathId) ?? project.paths[0];
      if (!selected) throw new Error("Select a path before preparing export diagnostics");
      const bindings = await prepareBdxBindings({ projectFile: selected.markers.some((marker) => marker.invocation) ? linkedLabviewProjectFile : null, inspectionCacheDirectory: labviewDiscoveryCacheDirectory(), activeCatalog: linkedRobotCatalog });
      const built = await buildBdxOffThread({ project, selection: { kind: "path", id: selected.id }, bindings });
      fieldPin = {
        id: built.document.field.id,
        revision: built.document.field.revision,
        coordinateSchemaId: built.document.field.coordinateSchemaId,
      };
      exportStatus = {
        state: "generated",
        sha256: `sha256:${built.sha256}`,
        pathCount: built.pathCount,
        eventCount: built.eventCount,
        sampleCount: built.sampleCount,
      };
    } catch (error) {
      exportStatus = { state: "invalid" };
      routinePreflight = { state: "failed", issueCount: diagnosticIssueCount(error) };
    }
  }
  const contents = buildDiagnosticBundle({
    generatedAt: new Date().toISOString(),
    app: {
      version: applicationVersion,
      build: app.isPackaged ? "packaged" : "development",
      channel: appUpdateChannel(applicationVersion),
    },
    os: { platform: process.platform, release: os.release(), arch: process.arch },
    fieldPin,
    catalog,
    export: exportStatus,
    routinePreflight,
    robotAcknowledgement: { state: "not-observed" },
  });
  return diagnosticBundleCapability.preview(contents);
});

handle("diagnostics:save", async (_event, previewId) => {
  try {
    return await saveDiagnosticPreview(previewId, diagnosticBundleCapability, async (fileName) => {
      const result = await dialog.showSaveDialog(mainWindow!, {
        title: "Save Bordeaux beta diagnostic",
        defaultPath: fileName,
        filters: [{ name: "Bordeaux beta diagnostic", extensions: ["json"] }],
      });
      return result.canceled || !result.filePath ? null : result.filePath;
    }, writeBufferAtomically);
  } catch (error) {
    if (error instanceof Error && error.message.includes("no longer current")) throw error;
    throw new Error("Bordeaux could not save the beta diagnostic bundle");
  }
});

handle("project:validate", (_event, project) => validateProject(project));
function rememberExplicitRobotLink(result: Awaited<ReturnType<typeof connectRobotProject>>, context: ProjectDurabilityContext) {
  assertRobotProjectContext(context);
  if (!sameProjectContext(linkedRobotContext, context)) throw new Error("The linked project changed");
  const relative = currentProjectFolder && linkedLabviewProjectFile ? relativeLabviewLink(currentProjectFolder, linkedLabviewProjectFile) : null;
  const editorLink = relative ? { labviewProjectPath: relative } : { robotProjectBookmarkId: result.bookmarkId };
  const { labviewProjectPath: _path, robotProjectBookmarkId: _bookmark, ...editor } = currentRobotEditor ?? {};
  currentRobotEditor = { ...editor, ...editorLink };
  return { ...result, editorLink, ...(!relative && currentProjectFolder ? { warning: "Linked on this computer only; robot code on another drive cannot use a relative link." } : {}) };
}

// Renderer supplies context and opaque proposal ids, never a path or a source snapshot to restore.
async function restoreProjectRobotCode(context: unknown) {
  assertRobotProjectContext(context);
  clearLinkedRobotProject();
  let generation = robotConnectionGeneration;
  const editor = currentRobotEditor, folder = currentProjectFolder;
  // A project that never named robot code stays Not linked; nothing is scanned or proposed for it.
  if (editor?.labviewProjectPath === undefined && !editor?.robotProjectBookmarkId) return { status: "unlinked", error: "" };
  const guard = () => { assertRobotProjectContext(context); if (generation !== robotConnectionGeneration) throw new Error("The robot code selection changed"); };
  // A target absent from this checkout is plain Missing. Its raw ENOENT would read as the Bordeaux folder being gone.
  const loadError = (failure: unknown) => ["ENOENT", "ENOTDIR"].includes((failure as NodeJS.ErrnoException | null)?.code ?? "")
    ? "" : readableRobotProjectError(failure).message;
  let error = "", selection: string | null = null;
  try { selection = await resolveProjectLabviewLink(folder, editor, robotProjectBookmarks, guard); }
  catch (failure) { guard(); error = loadError(failure); }
  guard();
  if (selection) {
    generation += 1; // connect reserves this exact generation synchronously.
    try { return await connectRobotProject(selection, "labview", undefined, true); }
    catch (failure) {
      guard(); // A late failure cannot clear a newer document or connection.
      clearLinkedRobotProject(); generation = robotConnectionGeneration;
      error = loadError(failure);
    }
  }
  guard();
  let candidate: string | null = null;
  // The proposal is advisory: any lookup failure only suppresses it.
  try { candidate = await suggestProjectLabviewLink(folder, guard); }
  catch { guard(); }
  guard();
  if (candidate === selection) candidate = null; // Do not offer the same file that just failed to load.
  if (candidate) suggestedRobotProject = { id: randomUUID(), file: candidate, context: { ...context } };
  return { status: "missing", error,
    ...(suggestedRobotProject ? { suggestion: { id: suggestedRobotProject.id, name: path.basename(suggestedRobotProject.file) } } : {}) };
}
handle("robotProject:restore", (_event, context) => restoreProjectRobotCode(context));
handle("robotProject:useSuggested", async (_event, context, id) => {
  assertRobotProjectContext(context);
  const suggestion = suggestedRobotProject;
  if (!suggestion || suggestion.id !== id || !sameProjectContext(suggestion.context, context)) throw new Error("The suggested robot code changed. Link robot code again.");
  return rememberExplicitRobotLink(await replaceRobotProject(suggestion.file, "labview", true), context);
});
handle("robotProject:listRecent", () => summarizeRobotProjectBookmarks(robotProjectBookmarks));
handle("robotProject:link", async (_event, context) => {
  assertRobotProjectContext(context);
  let selectedPath: string | undefined;
  if (smokeDirectory) {
    selectedPath = path.join(smokeDirectory, "robot-project", "SmokeRobot.lvproj");
  } else {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Link LabVIEW robot project",
      buttonLabel: "Link Project",
      properties: ["openFile", "openDirectory"],
      filters: [{ name: "LabVIEW Project", extensions: ["lvproj"] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    selectedPath = result.filePaths[0];
  }
  try {
    const runtime: RobotProjectRuntime = "labview";
    assertRobotProjectContext(context);
    if ((await statLabviewLocalPath(selectedPath)).isDirectory()) {
      assertRobotProjectContext(context);
      const projects = (await fs.promises.readdir(selectedPath, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".lvproj"));
      if (projects.length > 1) {
        const project = await dialog.showOpenDialog(mainWindow!, {
          title: "Choose LabVIEW project",
          buttonLabel: "Link project",
          defaultPath: selectedPath,
          properties: ["openFile"],
          filters: [{ name: "LabVIEW project", extensions: ["lvproj"] }],
        });
        if (project.canceled || !project.filePaths[0]) return null;
        selectedPath = project.filePaths[0];
      }
    }
    assertRobotProjectContext(context);
    return rememberExplicitRobotLink(await replaceRobotProject(selectedPath, runtime, true), context);
  } catch (error) {
    throw readableRobotProjectError(error, "Selected robot project");
  }
});
handle("robotProject:openRecent", async (_event, rawId, context) => {
  assertRobotProjectContext(context);
  if (typeof rawId !== "string" || rawId.length > 64) throw new Error("Recent robot project selection is invalid");
  const bookmark = robotProjectBookmarks.find((item) => item.id === rawId);
  if (!bookmark) throw new Error("Recent robot project is no longer available");
  try {
    return rememberExplicitRobotLink(await replaceRobotProject(bookmark.projectPath, bookmark.runtime, true), context);
  } catch (error) {
    throw readableRobotProjectError(error, bookmark.projectName);
  }
});
handle("robotProject:refresh", async (_event, context) => {
  assertRobotProjectContext(context);
  if (!linkedRobotProjectPath) throw new Error("Link a robot project before refreshing commands");
  try {
    return await connectRobotProject(linkedLabviewProjectFile ?? linkedRobotProjectPath, "labview");
  } catch (error) {
    const bookmark = robotProjectBookmarks.find((item) => item.id === linkedRobotProjectBookmarkId);
    throw readableRobotProjectError(error, bookmark?.projectName);
  }
});
handle("robotProject:inspectLabview", async (_event, context) => {
  assertRobotProjectContext(context);
  const selection = linkedLabviewProjectFile;
  if (!selection || linkedRobotCatalog?.runtime !== "labview") throw new Error("Link a LabVIEW project before inspecting commands");
  if (labviewInspectionInProgress) throw new Error("LabVIEW command inspection is already in progress");
  const generation = robotConnectionGeneration;
  labviewInspectionInProgress = true;
  try {
    const inspected = await inspectLabviewCommandsQueued(selection, labviewDiscoveryCacheDirectory());
    assertRobotProjectContext(context);
    if (generation !== robotConnectionGeneration || selection !== linkedLabviewProjectFile) throw new Error("The linked project changed during command inspection");
    return await connectRobotProject(selection, "labview", inspected);
  } finally {
    labviewInspectionInProgress = false;
  }
});
handle("robotProject:buildCatalog", async (_event, context) => {
  assertRobotProjectContext(context);
  if (!linkedRobotProjectPath) throw new Error("Link a LabVIEW project before building its command catalog");
  const root = linkedRobotProjectPath;
  const generation = robotConnectionGeneration;
  await buildLabviewCatalog(linkedLabviewProjectFile ?? root);
  assertRobotProjectContext(context);
  if (generation !== robotConnectionGeneration || root !== linkedRobotProjectPath) throw new Error("The linked project changed during catalog build");
  return connectRobotProject(linkedLabviewProjectFile ?? root, "labview");
});

handle("robot:getPairing", () => robotPairings.current());
handle("robot:probe", async (_event, rawEndpoint) => {
  const endpoint = rawEndpoint as RobotEndpoint;
  return robotPairings.probe(() => robotTransport.probe(endpoint, { password: "" }));
});
handle("robot:confirmPairing", async (_event, rawFingerprint, rawRuntimeId) => {
  if (typeof rawFingerprint !== "string" || typeof rawRuntimeId !== "string") {
    throw new Error("Probe the robot before confirming its identity");
  }
  const pairing = await robotPairings.confirm(rawFingerprint, rawRuntimeId, (confirmed) => writeRobotPairing(robotPairingFile(), confirmed));
  return pairing;
});
handle("robot:inspect", async () => {
  const robotPairing = robotPairings.current();
  if (!robotPairing) throw new Error("Pair a robot before inspecting its Bordeaux runtime");
  return robotTransport.inspect(robotPairing, { password: "" });
});
handle("robotFiles:connection", () => robotFileDelivery.settings());
handle("robotFiles:save", (_event, endpoint) => robotFileDelivery.saveSettings(endpoint as RobotFileEndpoint));
handle("robotFiles:probe", (_event, endpoint) => robotFileDelivery.probe(endpoint as RobotFileEndpoint));
handle("robotFiles:trust", (_event, fingerprint) => {
  if (typeof fingerprint !== "string") throw new Error("Review the robot SSH identity first");
  return robotFileDelivery.trust(fingerprint);
});
handle("robotFiles:prepare", async (_event, rawProject, pathIds) => {
  if (!Array.isArray(pathIds)) throw new Error("Select distinct paths to push");
  if (!pathIds.length || pathIds.length > MAX_BDX_BATCH) throw new Error(`Select between 1 and ${MAX_BDX_BATCH} paths to push`);
  if (pathIds.some(id => typeof id !== "string") || new Set(pathIds).size !== pathIds.length) throw new Error("Select distinct paths to push");
  const project = rawProject as BordeauxProject;
  if (!project || !Array.isArray(project.paths)) throw new Error("A valid Bordeaux project is required");
  const pairing = robotFileDelivery.current();
  if (!pairing) throw new Error("Connect a robot before preparing this transfer");
  const link = captureLinkedProject(project);
  const assertCurrent = () => {
    if (!link.isCurrent() || JSON.stringify(pairing) !== JSON.stringify(robotFileDelivery.current())) throw new Error("The project or robot connection changed; review this transfer again");
  };
  const selected = pathIds.map(id => {
    const matches = project.paths.filter(candidate => candidate.id === id);
    if (matches.length !== 1) throw new Error("A selected path is missing or ambiguous");
    return matches[0];
  });
  const bindingOptions = link.bindingOptions(selected.some(candidate => candidate.markers.some(marker => marker.invocation)));
  const bindings = await prepareBdxBindings(bindingOptions);
  assertCurrent();
  const built = await buildBdxBatchOffThread({ project, selections: selected.map(candidate => ({ kind: "path", id: candidate.id })), bindings });
  assertCurrent();
  const files = built.map((file, index) => ({ pathId: selected[index].id, name: selected[index].name, fileName: file.fileName, contents: Buffer.from(file.bytes) }));
  return robotFileDelivery.prepare(files, async () => {
    assertCurrent();
    const current = await prepareBdxBindings(bindingOptions);
    assertCurrent();
    if (current.definitionJson !== bindings.definitionJson) throw new Error("NI parameter evidence changed; review this transfer again");
  });
});
handle("robotFiles:confirm", (_event, operationId) => {
  if (typeof operationId !== "string") throw new Error("Review the files before pushing");
  return robotFileDelivery.confirm(operationId);
});
handle("robotFiles:cancel", (_event, operationId) => {
  if (typeof operationId !== "string") throw new Error("Transfer identifier is invalid");
  return robotFileDelivery.cancel(operationId);
});
const BDX_RECEIVER_UNAVAILABLE = "Robot delivery needs a LabVIEW BDX receiver with verified transfer and activation support. Export a BDX file locally for now.";
for (const channel of ["robot:inspectRetention", "robot:prepareRetention", "robot:inspectLibrary", "robot:preparePush", "robot:confirmPush", "robot:confirmRetention"]) {
  handle(channel, () => { throw new Error(BDX_RECEIVER_UNAVAILABLE); });
}
handle("robot:cancelPush", () => ({ canceled: false }));
handle("robot:cancelRetention", () => ({ canceled: false }));
handle("appUpdates:state", appUpdateState);
handle("appUpdates:check", () => appUpdates?.check(true));
handle("appUpdates:download", () => appUpdates?.download());
handle("appUpdates:cancel", () => appUpdates?.cancelDownload());
handle("appUpdates:install", () => {
  const state = appUpdates?.snapshot();
  return { accepted: Boolean(appUpdates?.available && (state?.phase === "downloaded" || (state?.phase === "error" && state.errorStage === "install")) && nativeDeparture.requestInstall()) };
});
handle("appUpdates:visible", (_event, visible) => {
  if (typeof visible !== "boolean") throw new Error("Update visibility must be a boolean");
  appUpdates?.setVisible(visible);
});
handle("appUpdates:releases", () => shell.openExternal(OFFICIAL_RELEASES_URL));
handle("appUpdates:copyDetails", () => clipboard.writeText(appUpdates?.snapshot().errorDetails || ""));
handle("project:copyDetails", (_event, text) => {
  if (typeof text !== "string" || !text.trim() || text.length > 65_536) throw new Error("Project details must contain 1–65536 characters");
  clipboard.writeText(text);
});
handle("agent:getActiveProposal", () => agentSessions.getActiveProposal());
handle("agent:getMcpStatus", () => agentSessions.accessStatus());
ipcMain.on("project:setDirty", (event, value) => { assertTrustedSender(event); dirty = value === true; appUpdates?.refresh(); });
ipcMain.on("agent:publishSession", (event, value) => {
  assertTrustedSender(event);
  if (agentSessions.publishEditorSnapshot(value) === "invalid") {
    console.warn("Ignored an invalid transient agent session snapshot");
  }
});
ipcMain.on("agent:proposalStatus", (event, rawId, rawStatus, rawRevision) => {
  assertTrustedSender(event);
  if (typeof rawId !== "string" || !["applied", "rejected", "stale"].includes(String(rawStatus))) return;
  agentSessions.updateProposalStatus(rawId, rawStatus as "applied" | "rejected" | "stale", typeof rawRevision === "number" ? rawRevision : undefined);
});
ipcMain.on("agent:proposalReceipt", (event, rawId, rawSessionId, rawRevision, rawActivePathId, rawAccepted) => {
  assertTrustedSender(event);
  if (typeof rawId !== "string" || typeof rawSessionId !== "string" || !Number.isSafeInteger(rawRevision) || rawRevision < 0 || typeof rawActivePathId !== "string") return;
  const receipt = proposalReceipts.get(rawId);
  if (!receipt) return;
  agentSessions.acknowledgeProposal(rawId, rawSessionId, rawRevision, rawActivePathId, rawAccepted !== false);
  proposalReceipts.delete(rawId);
  clearTimeout(receipt.timer);
  receipt.resolve();
});

if (!mcpStdioMode && ownsDesktopInstance) app.on("second-instance", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

if (ownsDesktopInstance) app.whenReady().then(async () => {
  if (mcpStdioMode) {
    app.dock?.hide();
    const server = serveBordeauxMcp(new AgentBridgeClient(app.getPath("userData")));
    quitAfterMcpInputEnds(process.stdin, () => server.close(), () => app.quit(), (error) => {
      console.warn("Could not close the Bordeaux MCP stdio server cleanly:", error);
    });
    return;
  }
  try {
    robotProjectBookmarks = await readRobotProjectBookmarks(robotProjectBookmarksFile());
  } catch (error) {
    robotProjectBookmarks = [];
    console.warn("Could not load Robot project bookmarks:", error);
  }
  try {
    recentFiles = await readRecentProjectFiles(recentProjectsFile());
  } catch (error) {
    recentFiles = [];
    recentStoreUnavailable = true;
    console.warn("Could not load recent Bordeaux projects:", error);
  }
  try {
    robotPairings = new RobotPairingController(await readRobotPairing(robotPairingFile()));
  } catch (error) {
    robotPairings = new RobotPairingController();
    console.warn("Could not load the paired Bordeaux robot:", error);
  }
  try {
    robotFileDelivery = new RobotFileDelivery(await readRobotFileConnection(robotFileConnectionFile()), value => writeRobotFileConnection(robotFileConnectionFile(), value));
  } catch (error) { console.warn("Could not load robot SFTP connection:", error); }
  agentBridge = new AgentBridgeServer(app.getPath("userData"), agentSessions);
  // The Agents menu shows MCP access as off when the bridge cannot start.
  if (enableMcpAccessOnLaunch) await agentBridge.start().catch((error) => console.warn("Could not enable Bordeaux MCP access:", error));
  agentSessions.resetAccess(agentBridge.enabled);
  appUpdates = createAppUpdateController();
  appUpdates.start();
  buildMenu();
  createWindow();
  app.on("activate", () => { if (!replacingProjectWindow && fallbackDialogOwners.size === 0 && BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// Undo an abandoned update quit: restart what cleanup stopped and reopen the editor.
function resumeAfterFailedUpdateQuit(): void {
  updateQuit.resumed();
  finalQuitInProgress = false;
  backgroundServicesReadyForExit = false;
  if (backgroundShutdownPromise) {
    backgroundShutdownPromise = null;
    agentBridge = new AgentBridgeServer(app.getPath("userData"), agentSessions);
    const bridge = agentBridge;
    // A cleanup that timed out may still hold its service; startup then reports the failure.
    if (bridgeEnabledAtShutdown) void bridge.start().catch((error) => console.warn("Could not re-enable Bordeaux MCP access:", error)).finally(() => { agentSessions.resetAccess(bridge.enabled); buildMenu(); });
    else agentSessions.resetAccess(false);
  }
  buildMenu();
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
}

app.on("before-quit", (event) => {
  const decision = updateQuit.inspectBeforeQuit();
  if (decision !== "proceed") {
    updateQuit.beforeQuit(); // Consume a queued failed-install quit without beginning a new one.
    event.preventDefault();
    if (decision === "resume") resumeAfterFailedUpdateQuit();
    return;
  }
  if (!nativeDeparture.beforeQuit()) { event.preventDefault(); return; }
  updateQuit.beforeQuit();
  if (updateCheckTimer) clearTimeout(updateCheckTimer);
  updateCheckTimer = null;
});
app.on("will-quit", (event) => {
  if (updateQuit.abandoned) { event.preventDefault(); resumeAfterFailedUpdateQuit(); return; }
  if (!nativeDeparture.willQuit()) { event.preventDefault(); return; }
  if (backgroundServicesReadyForExit) return;
  event.preventDefault();
  if (finalQuitInProgress) return;
  finalQuitInProgress = true;
  let limit: NodeJS.Timeout | undefined;
  const timedOut = new Promise<void>((resolve) => {
    limit = setTimeout(() => { console.warn("Bordeaux background services did not stop in time; quitting anyway."); resolve(); }, QUIT_CLEANUP_LIMIT_MS);
  });
  void Promise.race([stopBackgroundServices(), timedOut]).catch((error) => {
    console.warn("Could not stop Bordeaux background services cleanly:", error);
  }).finally(() => {
    clearTimeout(limit);
    if (updateQuit.abandoned) { resumeAfterFailedUpdateQuit(); return; }
    if (!nativeDeparture.cleanupMayFinish()) { finalQuitInProgress = false; return; }
    backgroundServicesReadyForExit = true;
    // Electron resets its quitting flag after the canceled will-quit event.
    // A microtask can run before that reset, so resume on the next event-loop turn.
    setImmediate(() => app.quit());
  });
});
app.on("web-contents-created", (_event, contents) => contents.on("will-attach-webview", (event) => event.preventDefault()));
app.on("window-all-closed", () => {
  // Smoke closes the real window, then verifies the saved source receipt before owning process exit.
  if (process.env.BORDEAUX_SMOKE_TEST === "1") return;
  if (process.platform !== "darwin" && !replacingProjectWindow && !mainWindow && fallbackDialogOwners.size === 0) app.quit();
});
