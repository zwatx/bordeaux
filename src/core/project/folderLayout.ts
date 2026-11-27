/**
 * The project folder format, shared by every host that writes one: the Electron app on a laptop and the
 * SystemCore server on the robot. A folder holds `.bordeaux-workspace.json` (the whole project plus file
 * ownership records), a readable `Paths/*.path`, `Routines/*.routine` and `Robots/*.robot` per document, and generated
 * `Paths/*.bdx`. The workspace is the source: opening a folder reads it, and the readable documents mirror it.
 *
 * This module decides names and bytes only. Hosts own the disk: atomic replacement, journaling, and refusing to
 * touch files whose bytes Bordeaux did not record.
 */
import type { BordeauxProject, PathDoc, RobotConfig } from "../types";
import { MAX_FILE_NAME_BYTES, portableFileStem } from "../portableFileName";
import { utf8ByteLength } from "../bytes";
import { prepareProjectFile, storedProject } from "./fileFormat";
import { projectRobots } from "./robots";
import { robotFileContents, robotFileDetails } from "./robotFile";
import { standalonePathEstimates } from "./commandPower";

export const PROJECT_WORKSPACE_FILE = ".bordeaux-workspace.json";
export const MAX_PROJECT_FILE_BYTES = 16 * 1024 * 1024;
/** A workspace holds the whole project plus its file ownership records. */
export const MAX_WORKSPACE_FILE_BYTES = MAX_PROJECT_FILE_BYTES * 2;

/** `.bordeaux-workspace.json`. Hash records map a folder-relative file to the SHA-256 of bytes Bordeaux wrote. */
export interface FolderState {
  format: "bordeaux-folder/1";
  projectPath: string | null;
  project: BordeauxProject;
  files: Record<string, string>;
  pendingFiles?: Record<string, string>;
  generatedFiles?: Record<string, string>;
  pendingGeneratedFiles?: Record<string, string>;
  /** `path:<id>`, `routine:<id>` or `robot:<id>` to its file, so a rename can keep the same file. */
  documentFiles?: Record<string, string>;
  legacyProjectMirror?: { file: string; hash: string };
  importedFrom?: { file: string; hash: string };
}

/** One managed source document: its ownership key, folder-relative file and contents. */
export interface ProjectDocument { key: string; file: string; contents: string }

/** Files a host may write, replace or remove inside a project folder. Anything else is never touched. */
export const MANAGED_SOURCE_FILE = /^(Paths\/[^/\\]+\.path|Routines\/[^/\\]+\.routine|Robots\/[^/\\]+\.robot)$/i;
export const MANAGED_BINARY_FILE = /^Paths\/[^/\\]+\.bdx$/i;

/**
 * Readers refuse larger files, so writing one would strand the project at its next open or save.
 * Checked against the exact UTF-8 bytes before any write.
 */
export function withinReadLimit(contents: string, maxBytes: number, label: string): string {
  const bytes = utf8ByteLength(contents);
  if (bytes <= maxBytes) return contents;
  const needed = Math.ceil(bytes / (1024 * 1024) * 10) / 10;
  throw new Error(`${label} would be ${needed} MiB, over the ${maxBytes / 1024 / 1024} MiB limit Bordeaux can reopen, so nothing was saved. Split the project or remove unused paths and routines, then save again.`);
}

export const jsonContents = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** The workspace file. Its project is stored as the project file stores it (`storedProject`). */
export function workspaceContents(state: FolderState): string {
  return withinReadLimit(jsonContents({ ...state, project: storedProject(state.project) }), MAX_WORKSPACE_FILE_BYTES, "The project workspace");
}

/** Parses workspace bytes. Throws when the file is not a Bordeaux workspace. */
export function decodeWorkspace(contents: string): { raw: Record<string, unknown>; state: FolderState } {
  const raw = JSON.parse(contents) as Record<string, unknown>;
  if (raw.format !== "bordeaux-folder/1" || !raw.files || typeof raw.files !== "object") throw new Error("This folder already contains an unrelated recovery file");
  return { raw, state: { ...raw, project: prepareProjectFile(raw.project) } as unknown as FolderState };
}

// Room for the widest duplicate suffix (validation allows 1,024 documents of a
// kind) and the longest extension, so every derived name fits in one component.
const DOCUMENT_STEM_BYTES = MAX_FILE_NAME_BYTES - " (99999)".length - ".routine".length;

function safeDocumentName(name: string): string {
  const clean = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").trim().replace(/[. ]+$/, "").slice(0, 120) || "Untitled";
  return portableFileStem(clean, DOCUMENT_STEM_BYTES);
}

/**
 * The readable source document for every path, routine and robot. A document keeps its previous file while that name
 * still fits its current name; otherwise it gets the first free `Name.ext` or `Name (n).ext`, compared without case.
 * A project without a robot list has one robot, "Robot", keyed `robot:robot`. A `.path` can be opened on its own, so it
 * holds the selected robot's transferable details and only the power estimates that robot plans with
 * (standalonePathEstimates).
 */
export function projectDocuments(project: BordeauxProject, previousFiles?: Record<string, string>): ProjectDocument[] {
  const used = new Set<string>();
  const documents = [
    ...project.paths.map((item) => ({ directory: "Paths", extension: "path", item })),
    ...project.routines.map((item) => ({ directory: "Routines", extension: "routine", item })),
    ...projectRobots(project).map(({ id, name, robot }) => ({ directory: "Robots", extension: "robot", item: { id, name, robot } })),
  ].map(({ directory, extension, item }) => {
    const stem = `${directory}/${safeDocumentName(item.name)}`;
    const key = `${extension}:${item.id}`;
    const prior = previousFiles?.[key];
    const suffix = prior?.slice(stem.length);
    const reusable = prior?.startsWith(stem) && (suffix === `.${extension}` || suffix?.match(/^ \([1-9][0-9]*\)\.(path|routine|robot)$/)?.[1] === extension);
    const file = prior && reusable && !used.has(prior.toLowerCase()) ? prior : "";
    if (file) used.add(file.toLowerCase());
    const contents = extension === "robot" ? robotFileContents(item.name, (item as { robot: RobotConfig }).robot)
      : `${JSON.stringify(extension === "path" ? { version: "2.0", field: project.field, ...(project.fieldMigration && { fieldMigration: project.fieldMigration }), robot: robotFileDetails(project.robot), ...standalonePathEstimates(item as PathDoc, project.robot) } : { format: "bordeaux-routine/1", ...item }, null, 2)}\n`;
    return { key, stem, extension, file, contents };
  });
  for (const document of documents) {
    if (document.file) continue;
    let number = 1;
    let file = `${document.stem}.${document.extension}`;
    while (used.has(file.toLowerCase())) file = `${document.stem} (${++number}).${document.extension}`;
    document.file = file; used.add(file.toLowerCase());
  }
  for (const document of documents) withinReadLimit(document.contents, MAX_PROJECT_FILE_BYTES, document.file);
  return documents.map(({ key, file, contents }) => ({ key, file, contents }));
}
