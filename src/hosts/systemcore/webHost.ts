/**
 * The SystemCore host: the renderer's host calls answered by the robot's server.py over HTTP.
 *
 * It implements the simple project path (restore, save, autosave, open), which the renderer uses when the
 * desktop's checkpoint and recovery calls are absent, plus robot file push as a local copy on the robot.
 * The browser builds every byte with src/core; the server only stores them in fixed folders.
 */
import type { BordeauxHost, PathExportResult, RobotProjectRestore } from "../contract";
import type { CreateNamedProjectRequest, OpenedProject, ProjectLocation, RecentProjectEntry } from "../../core/project/desktopProjects";
import type { RobotFileConnection, RobotFilePreview, RobotFileResult } from "../../core/robotFileDelivery";
import type { BordeauxProject } from "../../core/types";
import { prepareProjectFile } from "../../core/project/fileFormat";
import { createDemoProject, defaultPathConstraints } from "../../core/project/defaults";
import { PROJECT_NAME_RULE, isPortableProjectName } from "../../core/project/projectName";
import { MAX_FILE_NAME_BYTES, portableFileStem } from "../../core/portableFileName";
import { PROJECT_WORKSPACE_FILE, decodeWorkspace, projectDocuments, workspaceContents, type FolderState } from "../../core/project/folderLayout";
import { buildRobotBinary, type BinaryBindings } from "../../core/export/robotBinary";
import { decodeCommandsFile } from "../../core/export/commandsFile";
import { bdxBindingsFromDefinitions } from "../../core/export/bdxBindings";
import { sha256Hex, utf8Bytes } from "../../core/bytes";
import { validateProject } from "../../core/validation";

interface ServerInfo { projectsRoot: string; pushDirectory: string; defaultPushDirectory: string; lastProject: string | null }
interface Opened { name: string; state: FolderState; workspaceSha256: string }
/** `expectedSha256` is the hash Bordeaux last wrote to this file (null: no file yet); the server refuses other bytes. */
interface FileWrite { file: string; base64: string; expectedSha256: string | null }

/** Without a command list from the desktop, the robot exports paths that use no commands. */
const NO_COMMANDS = bdxBindingsFromDefinitions(null, [], {});
/** Shown where the desktop shows an SSH host key; the robot writes to its own disk. */
const LOCAL_IDENTITY = "SystemCore local folder";

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? undefined
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : `The robot answered ${response.status}`;
    throw new Error(error);
  }
  // Our own server's reply; its shapes are defined in server.py beside this file.
  return value as T;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}

/** The server keeps projects in visible folders of at most 120 characters, as well as the desktop's rules. */
// The server also refuses U+0085 at either end, which Python's strip() removes and JavaScript's trim() keeps.
const robotProjectName = (name: string) => isPortableProjectName(name) && name.trim() === name && !name.startsWith(".") && name.length <= 120 && !/^\u0085|\u0085$/.test(name);

/** A folder name the server and the desktop accept, unused on the robot. */
function freeName(name: string, taken: readonly string[]): string {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "-").replace(/[\uD800-\uDFFF]/gu, "").trim().slice(0, 110);
  // Room for a " (n)" suffix within the byte limit; a device name gains a leading underscore.
  const stem = portableFileStem(cleaned.replace(/^[\s.\u0085]+|[\s.\u0085]+$/g, ""), MAX_FILE_NAME_BYTES - 8).replace(/[\s.\u0085]+$/, "");
  // Anything the strips above still leave unacceptable falls back to a plain name.
  const base = robotProjectName(stem) ? stem : "Robot paths";
  const used = new Set(taken.map((item) => item.toLowerCase()));
  let candidate = base;
  for (let number = 2; used.has(candidate.toLowerCase()); number++) candidate = `${base} (${number})`;
  return candidate;
}

const exportablePaths = (project: BordeauxProject) => project.paths.filter((path) => path.exportable !== false && path.waypoints.length >= 2);

function download(fileName: string, bytes: Uint8Array) {
  const url = URL.createObjectURL(new Blob([bytes.slice()], { type: "application/octet-stream" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: fileName });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** The first BDX filename that another file also uses, ignoring case, as the desktop's Save and Push reject. */
function sharedFileName(files: readonly { fileName: string }[]): string | undefined {
  const seen = new Set<string>();
  for (const { fileName } of files) {
    if (seen.has(fileName.toLowerCase())) return fileName;
    seen.add(fileName.toLowerCase());
  }
  return undefined;
}

export function createSystemcoreHost() {
  let info: Promise<ServerInfo> | null = null;
  let current: Opened | null = null;
  // Save and autosave run one at a time, in call order, so each commit sees the previous one's workspace.
  let tail: Promise<unknown> = Promise.resolve();
  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.catch(() => undefined).then(work);
    tail = next;
    return next;
  };
  // Reviews the server holds; confirm publishes the bytes it checked at review, never new ones from this page.
  const pending = new Map<string, { preview: RobotFilePreview; uploading: boolean }>();
  // The command list a desktop Push left on the robot, read once per page load.
  let commands: Promise<{ bindings: BinaryBindings } | { error: string } | null> | null = null;
  const robotCommands = () => commands ??= fetch("/api/commands").then(async (response) => {
    if (response.status === 404) return null;
    const value = await response.json() as { contents?: string; error?: string };
    if (!response.ok || typeof value.contents !== "string") return { error: value.error || `The robot answered ${response.status}` };
    try { return { bindings: decodeCommandsFile(value.contents) }; } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  });
  const bindings = async () => { const list = await robotCommands(); return list && "bindings" in list ? list.bindings : NO_COMMANDS; };

  const serverInfo = (refresh = false) => (info && !refresh ? info : (info = request<ServerInfo>("/api/info")));
  const location = async (name: string | null): Promise<ProjectLocation> => {
    if (!name) return { folderPath: null, projectPath: null };
    const folderPath = `${(await serverInfo()).projectsRoot}/${name}`;
    return { folderPath, projectPath: `${folderPath}/${PROJECT_WORKSPACE_FILE}` };
  };

  async function open(name: string): Promise<OpenedProject> {
    const workspace = await request<{ contents: string; sha256: string }>(`/api/projects/${encodeURIComponent(name)}/workspace`);
    const { state } = decodeWorkspace(workspace.contents);
    current = { name, state, workspaceSha256: workspace.sha256 };
    await request("/api/settings", { lastProject: name });
    return { project: { ...state.project, name }, location: await location(name) };
  }

  /**
   * Lays out the whole folder in the browser and commits it. Save also builds BDX files; a BDX failure keeps the
   * saved source and reports `exportError`, as the desktop does.
   */
  async function write(project: unknown, options: { bdx: boolean; copy?: boolean; name?: string }) {
    const prepared = prepareProjectFile(project);
    const create = !current || options.copy === true || options.name !== undefined;
    const projects = create && options.name === undefined ? await request<Array<{ name: string }>>("/api/projects") : [];
    const name = options.name ?? (create ? freeName(options.copy ? `${prepared.name} copy` : prepared.name, projects.map((item) => item.name)) : current!.name);
    const canonical: BordeauxProject = { ...prepared, name };
    const previous = create ? null : current!.state;
    const where = await location(name);

    const documents = projectDocuments(canonical, previous?.documentFiles);
    const files = Object.fromEntries(documents.map((document) => [document.file, sha256Hex(document.contents)]));
    const writes: FileWrite[] = documents.map((document) => ({ file: document.file, base64: base64(utf8Bytes(document.contents)),
      expectedSha256: previous?.files[document.file] ?? null }));
    const removes = Object.entries(previous?.files ?? {}).filter(([file]) => !(file in files)).map(([file, sha256]) => ({ file, sha256 }));

    let generatedFiles = previous?.generatedFiles, bdxCount: number | undefined, exportError: string | undefined;
    if (options.bdx) {
      try {
        const used = await bindings();
        const built = exportablePaths(canonical).map((path) => buildRobotBinary(canonical, { kind: "path", id: path.id }, used));
        if (sharedFileName(built)) throw new Error(`Duplicate BDX output filename: ${sharedFileName(built)}`);
        const next = Object.fromEntries(built.map((item) => [`Paths/${item.fileName}`, item.sha256]));
        // Like the sources, each BDX names the bytes Bordeaux last wrote there, so the server keeps any other file.
        writes.push(...built.map((item) => ({ file: `Paths/${item.fileName}`, base64: base64(item.bytes),
          expectedSha256: previous?.generatedFiles?.[`Paths/${item.fileName}`] ?? null })));
        removes.push(...Object.entries(previous?.generatedFiles ?? {}).filter(([file]) => !(file in next)).map(([file, sha256]) => ({ file, sha256 })));
        generatedFiles = next; bdxCount = built.length;
      } catch (error) {
        exportError = error instanceof Error ? error.message : String(error);
      }
    }
    const state: FolderState = { format: "bordeaux-folder/1", projectPath: where.projectPath, project: canonical, files,
      documentFiles: Object.fromEntries(documents.map((document) => [document.key, document.file])), ...(generatedFiles ? { generatedFiles } : {}) };
    const committed = await request<{ workspaceSha256: string; keptBinaries?: string[] }>("/api/commit", {
      name, create, expectedWorkspaceSha256: create ? null : current!.workspaceSha256, writes, removes, workspace: workspaceContents(state) });
    current = { name, state, workspaceSha256: committed.workspaceSha256 };
    // The server leaves a BDX alone when the robot's copy isn't the one Bordeaux wrote; the sources are saved regardless.
    const kept = committed.keptBinaries ?? [];
    if (kept.length) {
      // Bordeaux still owns only what it last wrote there, so record that hash again (none for a file it never wrote).
      // Restoring that copy then lets the next save replace it, and deleting the path removes it.
      const owned = { ...(state.generatedFiles ?? {}) };
      for (const file of kept) {
        const prior = previous?.generatedFiles?.[file];
        if (prior) owned[file] = prior; else delete owned[file];
      }
      const corrected: FolderState = { ...state, generatedFiles: owned };
      const recorded = await request<{ workspaceSha256: string }>("/api/commit", {
        name, create: false, expectedWorkspaceSha256: committed.workspaceSha256, writes: [], removes: [], workspace: workspaceContents(corrected) });
      current = { name, state: corrected, workspaceSha256: recorded.workspaceSha256 };
    }
    if (kept.length && !exportError) {
      exportError = `${kept.join(", ")} on the robot ${kept.length === 1 ? "isn't the file" : "aren't the files"} Bordeaux saved, so Bordeaux left `
        + `${kept.length === 1 ? "it" : "them"} as ${kept.length === 1 ? "it is" : "they are"}. Rename or remove ${kept.length === 1 ? "it" : "them"} on the robot, then save again.`;
      bdxCount = (bdxCount ?? kept.length) - kept.length;
    }
    return { location: where, canonicalProject: canonical, bdxCount, exportError };
  }

  async function connection(): Promise<RobotFileConnection> {
    return { endpoint: { target: "systemcore", host: window.location.hostname, port: 22, directory: (await serverInfo()).pushDirectory }, hostKeyFingerprint: LOCAL_IDENTITY };
  }
  async function useDirectory(directory: string): Promise<RobotFileConnection> {
    await request("/api/settings", { pushDirectory: directory.replace(/\/+$/, "") });
    await serverInfo(true);
    return connection();
  }

  /** A new project on the robot under exactly the chosen name, like the desktop's New project. */
  async function createNamed(request: CreateNamedProjectRequest): Promise<OpenedProject> {
    const name = typeof request?.name === "string" ? request.name.trim() : "";
    if (!isPortableProjectName(name)) throw new Error(PROJECT_NAME_RULE);
    if (!robotProjectName(name)) throw new Error("Choose a project name of at most 120 characters that doesn't start with a dot");
    const project = createDemoProject();
    project.name = name;
    if (request.template) {
      project.robot = structuredClone(request.template.robot);
      project.paths[0].constraints = structuredClone(request.template.constraints ?? defaultPathConstraints(project.robot));
      if (!validateProject(project).ok) throw new Error("Project template robot or limits are invalid");
    }
    // The server refuses a name already on the robot, and the commit records it as the last project.
    const saved = await write(project, { bdx: false, name });
    return { project: saved.canonicalProject, location: saved.location };
  }

  return {
    platform: "web",
    robotDeliveryCapabilities: Object.freeze({ pathPush: true, routinePush: false, fileTransfer: true }),

    restoreLastProject: () => serially(async () => {
      const last = (await serverInfo()).lastProject;
      return last ? open(last).catch(() => null) : null;
    }),
    newProject: async () => { await serially(async () => { current = null; }); },
    getProjectLocation: () => location(current?.name ?? null),
    getProjectCreationDefaults: async () => ({ parentDirectory: (await serverInfo()).projectsRoot }),
    createNamedProject: (createRequest) => serially(() => createNamed(createRequest)),
    // Real locations let the list mark the open project as current instead of listing it twice.
    listRecentProjects: async () => Promise.all((await request<Array<{ name: string }>>("/api/projects")).map(async (project): Promise<RecentProjectEntry> => ({
      id: project.name, name: project.name, folderHint: "On this robot", status: "available", location: await location(project.name) }))),
    openRecentProjectById: (id) => serially(() => open(id)),
    saveProject: (project, saveAs) => serially(async () => ({ saved: true as const, ...await write(project, { bdx: true, copy: saveAs === true }) })),
    autosaveProject: (project) => serially(async () => {
      if (!current) return { saved: false, location: await location(null) };
      try { return { saved: true, location: (await write(project, { bdx: false })).location }; }
      catch (error) { return { saved: false, error: error instanceof Error ? error.message : String(error), location: await location(current.name) }; }
    }),
    validateProject: async (project) => validateProject(project),
    exportBdx: async (project, pathId): Promise<PathExportResult> => {
      const built = buildRobotBinary(prepareProjectFile(project), { kind: "path", id: pathId }, await bindings());
      download(built.fileName, built.bytes);
      return { exported: true, relativePath: built.fileName, sha256: built.sha256, pathCount: built.pathCount, eventCount: built.eventCount, sampleCount: built.sampleCount };
    },

    restoreProjectRobotCode: async (): Promise<RobotProjectRestore> => {
      const list = await robotCommands();
      if (!list) return { status: "unlinked", error: "" };
      if ("error" in list) return { status: "error", error: list.error };
      return { catalog: list.bindings.catalog, bookmarkId: "systemcore", recentProjects: [],
        integration: { runtime: "labview", installed: true, generatedCatalog: false, buildFile: "bordeaux-catalog.json", wrapperAvailable: false } };
    },

    getRobotFileConnection: connection,
    checkRobotFileConnection: connection,
    getRobotFilePassword: async () => ({ custom: false, persistent: false }),
    saveRobotFileSettings: (endpoint) => useDirectory(endpoint.directory),
    probeRobotFiles: (endpoint) => useDirectory(endpoint.directory),
    trustRobotFiles: () => connection(),
    cancelRobotFileProbe: async () => undefined,
    prepareRobotFiles: async (project, pathIds) => {
      const prepared = prepareProjectFile(project), used = await bindings();
      const built = pathIds.map((id) => buildRobotBinary(prepared, { kind: "path", id }, used));
      if (sharedFileName(built)) throw new Error("Selected paths have matching BDX filenames. Rename them before pushing together");
      const target = await connection();
      const held = await request<{ operationId: string; files: Array<{ fileName: string; size: number; sha256: string }> }>("/api/push/prepare", {
        directory: target.endpoint.directory, files: built.map((item) => ({ fileName: item.fileName, sha256: item.sha256, base64: base64(item.bytes) })) });
      if (held.files.length !== built.length || held.files.some((file, index) => file.fileName !== built[index].fileName || file.sha256 !== built[index].sha256)) {
        void request("/api/push/cancel", { operationId: held.operationId }).catch(() => undefined);
        throw new Error("The robot did not hold the files as built. Try again");
      }
      const preview: RobotFilePreview = { operationId: held.operationId, connection: target,
        files: built.map((item, index) => ({ pathId: pathIds[index], name: item.name, fileName: item.fileName, size: held.files[index].size, sha256: held.files[index].sha256 })) };
      pending.set(preview.operationId, { preview, uploading: false });
      return preview;
    },
    prepareRobotRoutine: async () => { throw new Error("Routine push isn't available from the robot yet. Push routines from the desktop app."); },
    confirmRobotFiles: async (operationId): Promise<RobotFileResult> => {
      const operation = pending.get(operationId);
      if (!operation) throw new Error("Review the selected files again before pushing");
      operation.uploading = true;
      try {
        const result = await request<{ directory: string; directoryCreated: boolean }>("/api/push/confirm", { operationId });
        return { state: "transferred", files: operation.preview.files, directory: result.directory, directoryCreated: result.directoryCreated };
      } finally { pending.delete(operationId); }
    },
    cancelRobotFiles: async (operationId) => {
      const operation = pending.get(operationId);
      if (!operation || operation.uploading) return { canceled: false };
      pending.delete(operationId);
      await request("/api/push/cancel", { operationId }).catch(() => undefined);
      return { canceled: true };
    },
  } satisfies Partial<BordeauxHost>;
}
