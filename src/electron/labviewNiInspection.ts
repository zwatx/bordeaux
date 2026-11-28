import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import type { RobotCommandCatalog, RobotCommandDescriptor, RobotCommandParameter, LabviewProjectDiscovery } from "../core/types";
import { discoverLabviewProject, resolveLabviewProject } from "./labviewProject";
import { writeJsonAtomically } from "./projectFiles";
import { decodeLabviewNiInspection, isLabviewControllerFile, typedefs } from "./labviewNiTypes";
import { MAC_WRAPPER_STAGING_NAME, statLabviewLocalPath } from "./labviewProjectDiscovery";
import { runMacLabviewAdapter } from "./labviewMacAdapter";

/*
 * Command definitions come from NI connector inspection, kept per VI.
 *
 * Every inspected VI keeps its own report row plus the size, mtime and SHA-256 of the saved file NI read. Bordeaux
 * always keeps the last known definitions: an edit anywhere in the LabVIEW project never removes commands or blocks
 * export. Only the VIs (and connector typedefs) of the commands an export actually uses are compared, and only a
 * changed or new VI is inspected again, one VI at a time rather than the whole project.
 */
const REPORT_VERSION = "bordeaux-ni-inspection/1";
const EVIDENCE_VERSION = "bordeaux-ni-evidence/2";
const MAX_SOURCES = 1000;
// A full read of a real robot project (462 VIs, one with a 1.6 MB connector type) is about 10 MB, and a project may
// have up to 1000 sources. This bounds a malformed response; it must never reject an ordinary project read.
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const READ_BUDGET_BYTES = 256 * 1024 * 1024;
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const identityPath = (file: string) => process.platform === "win32" ? file.toLowerCase() : file;
const sourceKey = (source: { target: string; file: string }) => `${source.target}\0${source.file}`;
// A file modified this close to (or after) the start of an inspection may not be the version NI read.
const MTIME_SLACK_MS = 2000;
const unsavedRow = (row: Record<string, unknown>) => row.modifiedBefore !== false || row.modifiedAfter !== false;
const missingFile = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException | null)?.code ?? "");

export interface LabviewNiSource { file: string; target: string }
type Inspection = NonNullable<LabviewProjectDiscovery["inspection"]>;
interface FileRecord { sha256: string; size: number; mtimeMs: number }
/** `unsaved`: NI read this VI while LabVIEW held unsaved edits, so its definition may not match the saved file. */
interface SourceRecord extends FileRecord { file: string; target: string; unsaved?: boolean }
interface DependencyRecord extends FileRecord { path: string }
interface NiReport { schemaVersion: string; projectFile: string; labviewVersion: string; inspectedAt: string; dirtyContext: unknown; vis: Array<Record<string, unknown>> }
/** What NI reported for each VI and which saved bytes it read. Survives restart through the user-data cache. */
interface Evidence { projectFile: string; report: NiReport; sources: SourceRecord[]; dependencies: DependencyRecord[] }

// Catalogs built from evidence remember it by their command list, so an export can compare the VIs it uses.
const catalogEvidence = new WeakMap<RobotCommandDescriptor[], Evidence>();
const sessionEvidence = new Map<string, Evidence>();
function rememberEvidence(evidence: Evidence) {
  const key = identityPath(evidence.projectFile);
  sessionEvidence.delete(key);
  sessionEvidence.set(key, evidence);
  if (sessionEvidence.size > 8) sessionEvidence.delete(sessionEvidence.keys().next().value!);
}

// Bound concurrent local I/O. Results keep source order.
async function parallelFiles<T>(items: T[], visit: (item: T) => Promise<void>): Promise<void> {
  let next = 0, failed = false;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(8, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { await visit(items[index]); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
    }
  }));
  if (failed) throw failure;
}

/** Reads saved file identity. A file whose size and mtime match the earlier record is not read again. */
class FileReader {
  private total = 0;
  async record(file: string, previous?: FileRecord): Promise<FileRecord> {
    const stat = await statLabviewLocalPath(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("NI inspection requires regular source files.");
    if (previous?.sha256 && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) return previous;
    if (stat.size > MAX_FILE_BYTES || (this.total += stat.size) > READ_BUDGET_BYTES) throw new Error("NI inspection source hashes exceed the read limit.");
    return { sha256: hash(await fs.readFile(file)), size: stat.size, mtimeMs: stat.mtimeMs };
  }
}

/** Match the legacy project-tree exclusions; filenames alone never confirm a command. */
export function eligibleLabviewLegacySource(item: LabviewProjectDiscovery["items"][number]): boolean {
  return item.status === "present" && !!item.file?.toLowerCase().endsWith(".vi")
    && !item.projectPath.split("/").some((part) => /^(?:Support Code|Framework)$/i.test(part))
    && !/Command Helper\.vi/i.test(item.name)
    && !/_wrapper\.vi$/i.test(item.name)
    && !MAC_WRAPPER_STAGING_NAME.test(item.name)
    && item.name.toLowerCase() !== "bordeaux command wrappers.vi"
    && !["prep command info for wait.vi", "wait for command.vi", "should abort operation.vi", "subsystems.vi"].includes(item.name.toLowerCase());
}

/** Robot-target VIs that may be commands. Discovery only; nothing is hashed here. */
async function candidateSources(selection: string, catalog: RobotCommandCatalog) {
  const { root, projectFile } = await resolveLabviewProject(selection);
  if (!catalog.labviewDiscovery || catalog.labviewDiscovery.truncated) throw new Error("Complete project discovery is required before NI command inspection.");
  // roboRIO and myRIO projects keep robot code under their RT target. A SystemCore project has none: its LabVIEW runs on
  // the robot itself, so robot code sits under My Computer.
  const targets = catalog.labviewDiscovery.targets, rt = targets.filter((target) => target.type === "RT myRIO" || target.type === "RT roboRIO");
  const robotTargets = new Set((rt.length ? rt : targets.filter((target) => target.type === "My Computer")).map((target) => target.name));
  const sources: Array<LabviewNiSource & { path: string }> = [];
  const seen = new Set<string>();
  for (const item of catalog.labviewDiscovery.items) {
    if (!robotTargets.has(item.target) || !eligibleLabviewLegacySource(item)) continue;
    const key = sourceKey({ target: item.target, file: item.file! });
    if (seen.has(key)) continue;
    seen.add(key);
    if (sources.length >= MAX_SOURCES) throw new Error("NI inspection supports at most 1000 VI sources per project.");
    sources.push({ file: item.file!, target: item.target, path: path.resolve(root, item.file!) });
  }
  sources.sort((a, b) => `${a.target}/${a.file}`.localeCompare(`${b.target}/${b.file}`));
  return { root, projectFile, sources };
}

function cachePath(cacheDirectory: string, projectFile: string): string { return path.join(cacheDirectory, `${hash(identityPath(projectFile))}.json`); }
function unavailable(catalog: RobotCommandCatalog, reason: string): RobotCommandCatalog {
  if (!catalog.labviewDiscovery) return catalog;
  return { ...catalog, labviewDiscovery: { ...catalog.labviewDiscovery, inspection: { status: "unavailable", commandCount: 0, unsupported: [], reason } }, warnings: [...catalog.warnings, reason] };
}
function merge(catalog: RobotCommandCatalog, commands: RobotCommandDescriptor[], inspection: Inspection): RobotCommandCatalog {
  if (!catalog.labviewDiscovery) return catalog;
  const memberKey = (member: string) => member.replaceAll("\\", "/").toLowerCase();
  const declared = new Set(catalog.commands.map((command) => memberKey(command.member)));
  const inspectedByMember = new Map<string, RobotCommandDescriptor[]>();
  for (const command of commands) {
    const key = memberKey(command.member), matches = inspectedByMember.get(key);
    if (matches) matches.push(command);
    else inspectedByMember.set(key, [command]);
  }
  const warnings = [...catalog.warnings];
  const canonical = (value: unknown): string => {
    if (!value || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  };
  const merged = catalog.commands.map((command) => {
    const matches = inspectedByMember.get(memberKey(command.member)) ?? [];
    if (!matches.length) return command;
    const inspected = matches[0];
    const inputs = command.parameters.filter((parameter) => parameter.role === "argument");
    const discoveredInputs = inspected.parameters.filter((parameter) => parameter.role === "argument");
    const discoveredByName = new Map<string, RobotCommandParameter[]>();
    for (const parameter of discoveredInputs) {
      const matches = discoveredByName.get(parameter.name);
      if (matches) matches.push(parameter);
      else discoveredByName.set(parameter.name, [parameter]);
    }
    const matchesTypes = inputs.length === discoveredInputs.length && inputs.every((parameter) => {
      const found = discoveredByName.get(parameter.name) ?? [];
      return found.length === 1 && canonical(found[0].schema) === canonical(parameter.schema);
    });
    if (matches.length !== 1 || !matchesTypes) {
      warnings.push(`${command.label}: declared parameters do not match one unambiguous inspected VI. Update the declaration before BDX export.`);
      const { labviewConnector: _connector, ...withoutEvidence } = command;
      return withoutEvidence;
    }
    // The declaration supplies durable IDs and labels; NI supplies saved byte types and command results.
    return { ...command, outputs: inspected.outputs, labviewConnector: inspected.labviewConnector };
  });
  const additions = commands.filter((command) => !declared.has(memberKey(command.member)));
  return { ...catalog, commands: [...merged, ...additions],
    labviewDiscovery: { ...catalog.labviewDiscovery, inspection },
    warnings: [...warnings, ...(commands.length ? [
      `${commands.length} LabVIEW commands identified from NI connector metadata. Robot code owns command execution.`,
    ] : [])] };
}
async function readBoundedJson(file: string): Promise<unknown> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RESPONSE_BYTES) throw new Error("NI inspection response exceeds the file limit or is not a regular file.");
  return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
}

const reportSources = (report: NiReport): LabviewNiSource[] => report.vis.map((row) => ({ file: String(row.file), target: String(row.target) }));
/** Definitions from evidence, merged with the project's current declarations. */
async function catalogFromEvidence(discovered: RobotCommandCatalog, evidence: Evidence, status: "available" | "cached"): Promise<RobotCommandCatalog> {
  const saved = new Map(evidence.sources.map((source) => [sourceKey(source), source]));
  const rows = new Map(evidence.report.vis.map(row => [sourceKey({ file: String(row.file), target: String(row.target) }), row]));
  const knownTypes = new Map(evidence.dependencies.map(dependency => [identityPath(dependency.path), dependency]));
  const verifiedControllers = new Set<string>();
  const reader = new FileReader();
  const discovery = discovered.labviewDiscovery;
  const present = (discovery && !discovery.truncated ? discovery.items : []).filter(item => item.file && item.status === "present");
  const basenames = new Map<string, Set<string>>();
  for (const item of present) {
    const key = sourceKey({ target: item.target, file: path.posix.basename(item.file!).toLowerCase() });
    const files = basenames.get(key) ?? new Set();
    files.add(item.file!);
    basenames.set(key, files);
  }
  const candidates = present.filter(item => isLabviewControllerFile(item.file!));
  await parallelFiles(candidates, async (item) => {
    const key = sourceKey({ target: item.target, file: item.file! });
    const previous = saved.get(key);
    const basenameKey = sourceKey({ target: item.target, file: path.posix.basename(item.file!).toLowerCase() });
    if (!previous?.sha256 || previous.unsaved || basenames.get(basenameKey)?.size !== 1) return;
    try {
      const current = await reader.record(path.resolve(path.dirname(evidence.projectFile), item.file!), previous);
      if (current.sha256 !== previous.sha256) return;
      const row = rows.get(key);
      const extended = (row?.connector as { extendedInformation?: unknown } | undefined)?.extendedInformation;
      if (row?.dependenciesAvailable !== true || !Array.isArray(extended)) return;
      const dependencies = new Set(extended.flatMap(info => typedefs(info, "").paths));
      for (const file of dependencies) {
        const known = knownTypes.get(identityPath(file));
        if (!known?.sha256 || (await reader.record(file, known)).sha256 !== known.sha256) return;
      }
      verifiedControllers.add(key);
    } catch { /* Controller evidence is optional. Missing or unreadable VIs supply no outputs. */ }
  });
  const decoded = decodeLabviewNiInspection(evidence.report, evidence.projectFile, reportSources(evidence.report), verifiedControllers);
  const result = merge(discovered, decoded.commands, { ...decoded.inspection, status });
  catalogEvidence.set(result.commands, evidence);
  return result;
}

function fileRecords<T extends string>(value: unknown, name: T, limit: number): Array<FileRecord & Record<T, string>> {
  if (!Array.isArray(value) || value.length > limit) throw new Error("Saved command evidence is malformed.");
  return value.map((item) => {
    const record = item as Record<string, unknown>;
    if (!record || typeof record[name] !== "string" || typeof record.sha256 !== "string"
      || !Number.isFinite(record.size) || !Number.isFinite(record.mtimeMs)) throw new Error("Saved command evidence is malformed.");
    return { [name]: record[name], sha256: record.sha256, size: record.size, mtimeMs: record.mtimeMs } as FileRecord & Record<T, string>;
  });
}
async function loadEvidence(projectFile: string, cacheDirectory: string): Promise<Evidence | null> {
  const session = sessionEvidence.get(identityPath(projectFile));
  if (session) return session;
  let raw: unknown;
  try { raw = await readBoundedJson(cachePath(cacheDirectory, projectFile)); }
  catch (error) { if (missingFile(error)) return null; throw error; }
  const value = raw as Record<string, unknown> | null;
  const report = value?.report as NiReport | undefined;
  if (!report || typeof report !== "object" || !Array.isArray(report.vis)) throw new Error("Saved command evidence is malformed.");
  if (value!.schemaVersion === EVIDENCE_VERSION) {
    const sources = fileRecords(value!.sources, "file", MAX_SOURCES).map((source, index) => {
      const target = (value!.sources as Array<Record<string, unknown>>)[index].target;
      if (typeof target !== "string") throw new Error("Saved command evidence is malformed.");
      return { ...source, target };
    });
    return { projectFile, report, sources, dependencies: fileRecords(value!.dependencies, "path", 10000) };
  }
  // Earlier caches bound all definitions to one project fingerprint. Keep their definitions; with no per-VI bytes,
  // every used command counts as changed until it is read again.
  if (value!.schemaVersion === REPORT_VERSION) return { projectFile, report, sources: [], dependencies: [] };
  throw new Error("Saved command evidence uses an unknown format.");
}

/** The last known definitions for this project, from this session or the user-data cache. Never removed for edits. */
export async function withCachedLabviewCommands(selection: string, catalog: RobotCommandCatalog, cacheDirectory: string): Promise<RobotCommandCatalog> {
  if (catalog.runtime !== "labview") return catalog;
  const { projectFile } = await resolveLabviewProject(selection);
  try {
    const evidence = await loadEvidence(projectFile, cacheDirectory);
    return evidence ? await catalogFromEvidence(catalog, evidence, "cached") : catalog;
  } catch (error) {
    return unavailable(catalog, `Saved command definitions could not be read: ${errorMessage(error)} Refresh commands to read them from LabVIEW.`);
  }
}

/** This session's definitions for the project, or null before any inspection in this process. */
export async function withSessionLabviewCommands(selection: string, catalog: RobotCommandCatalog): Promise<RobotCommandCatalog | null> {
  const { projectFile } = await resolveLabviewProject(selection);
  const evidence = sessionEvidence.get(identityPath(projectFile));
  if (!evidence) return null;
  try { return await catalogFromEvidence(catalog, evidence, "available"); }
  catch { sessionEvidence.delete(identityPath(projectFile)); return null; }
}

/** Definitions for export: the linked catalog's evidence when it belongs to this project, otherwise the cache. */
export async function withLastKnownLabviewCommands(selection: string, catalog: RobotCommandCatalog, cacheDirectory: string,
  active?: RobotCommandCatalog | null): Promise<RobotCommandCatalog> {
  const { projectFile } = await resolveLabviewProject(selection);
  // This session's latest reading is always the newest; a linked catalog may predate a background re-read.
  const session = sessionEvidence.get(identityPath(projectFile));
  if (session) return catalogFromEvidence(catalog, session, "available");
  const evidence = active && catalogEvidence.get(active.commands);
  if (evidence && identityPath(evidence.projectFile) === identityPath(projectFile)) return catalogFromEvidence(catalog, evidence, "available");
  return withCachedLabviewCommands(projectFile, catalog, cacheDirectory);
}

/**
 * Compares only the VIs of the given commands with the bytes NI read. `missing` commands no longer have a VI on disk;
 * `changed` commands were saved since (or were never read with per-VI evidence) and should be read again.
 */
export async function labviewCommandSourceChanges(selection: string, catalog: RobotCommandCatalog, commandIds: Iterable<string>): Promise<{
  changed: RobotCommandDescriptor[]; missing: RobotCommandDescriptor[];
}> {
  const ids = new Set(commandIds);
  const used = catalog.commands.filter((command) => ids.has(command.id) && command.labviewConnector);
  const changed: RobotCommandDescriptor[] = [], missing: RobotCommandDescriptor[] = [];
  if (!used.length) return { changed, missing };
  const { root } = await resolveLabviewProject(selection);
  const evidence = catalogEvidence.get(catalog.commands);
  const known = new Map((evidence?.sources ?? []).map((source) => [sourceKey(source), source]));
  const reader = new FileReader();
  let typesChanged = !evidence;
  for (const dependency of evidence?.dependencies ?? []) {
    if (typesChanged) break;
    try { typesChanged = (await reader.record(dependency.path, dependency)).sha256 !== dependency.sha256; }
    catch { typesChanged = true; }
  }
  await parallelFiles(used, async (command) => {
    const connector = command.labviewConnector!;
    const before = known.get(sourceKey(connector));
    try {
      const now = await reader.record(path.resolve(root, connector.file), before);
      if (typesChanged || !before || now.sha256 !== before.sha256) changed.push(command);
    } catch (error) {
      if (missingFile(error)) missing.push(command);
      else changed.push(command);
    }
  });
  const order = (list: RobotCommandDescriptor[]) => list.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  return { changed: order(changed), missing: order(missing) };
}

/** A bundled NI inspection file: the source tree's in development, the packaged resources' otherwise. */
export async function labviewInspectionResource(name: string): Promise<string> {
  const development = path.resolve(__dirname, "../../resources/labview-inspection", name);
  const file = await fs.access(development).then(() => development,
    () => path.join((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? "", "labview-inspection", name));
  await fs.access(file);
  return file;
}

export async function runLabviewNiAdapter(requestFile: string, responseFile: string): Promise<void> {
  if (process.platform === "darwin") return runMacLabviewAdapter(requestFile, responseFile, labviewInspectionResource);
  if (process.platform !== "win32") throw new Error("NI inspection requires LabVIEW on Windows or macOS. Saved and declared commands remain available.");
  const script = await labviewInspectionResource("InspectCommands.ps1");
  // A PowerShell reaches only the LabVIEW COM server of its own bitness: 64-bit for LabVIEW 2026, usually 32-bit for
  // LabVIEW 2025 FRC installs. Try 64-bit first; move on only when that LabVIEW is absent or lacks the open project.
  const windows = process.env.SystemRoot ?? "C:\\Windows";
  const shells = [path.join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), path.join(windows, "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe")];
  let notHere: Error | undefined;
  for (const powershell of shells) {
    if (!await fs.access(powershell).then(() => true, () => false)) continue;
    try { return await runInspectionScript(powershell, script, requestFile, responseFile); }
    catch (error) {
      if (!(error instanceof Error) || !PROJECT_ELSEWHERE.test(error.message)) throw error;
      // "Open the project" says more than "this bitness has no LabVIEW", so a later absence doesn't replace it.
      if (!notHere || NO_LABVIEW.test(notHere.message)) notHere = error;
    }
  }
  throw notHere ?? new Error("Windows PowerShell is unavailable for NI command inspection.");
}

const NO_LABVIEW = /LabVIEW COM is not installed for this architecture|LabVIEW COM server is not registered/;
/** InspectCommands.ps1's failures that mean "try the other LabVIEW bitness", not a failed inspection. */
const PROJECT_ELSEWHERE = /LabVIEW COM is not installed for this architecture|LabVIEW COM server is not registered|Open the selected project in one LabVIEW instance|The selected project is not already open in LabVIEW/;
/** LabVIEW 2025 isn't available to script right now (absent, closed, project not open, other version or user). */
export function labviewScriptingUnavailable(error: unknown): boolean {
  return error instanceof Error && (PROJECT_ELSEWHERE.test(error.message)
    || /only in LabVIEW 2025|supports LabVIEW 2025 and LabVIEW 2026|LabVIEW exited before inspection|LabVIEW belongs to another Windows user|Windows PowerShell is unavailable/.test(error.message));
}

function runInspectionScript(powershell: string, script: string, requestFile: string, responseFile: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-RequestFile", requestFile, "-ResponseFile", responseFile],
      { windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, _stdout, stderr) => {
        if (error) reject(new Error(error.killed ? "NI command inspection timed out. LabVIEW was left open." : stderr.trim().slice(0, 2000) || error.message));
        else resolve();
      });
  });
}

type Adapter = (requestFile: string, responseFile: string) => Promise<void>;
/**
 * Reads command definitions from the project already open in LabVIEW. "all" reads every candidate VI; "changed" reads
 * only VIs that are new or saved since the last reading (and returns null when there is nothing to read).
 */
async function inspect(selection: string, cacheDirectory: string, adapter: Adapter, scope: "all" | "changed"): Promise<RobotCommandCatalog | null> {
  const discovered = await discoverLabviewProject(selection);
  const before = await candidateSources(selection, discovered);
  const previous = scope === "changed" || !before.sources.length ? await loadEvidence(before.projectFile, cacheDirectory).catch(() => null) : null;
  if (!before.sources.length && !previous) return scope === "changed" ? null : discovered;
  const known = new Map((previous?.sources ?? []).map((source) => [sourceKey(source), source]));
  const previousRows = new Map((previous?.report.vis ?? []).map((row) => [sourceKey({ target: String(row.target), file: String(row.file) }), row]));
  const reader = new FileReader();
  const records = new Map<string, SourceRecord>();
  await parallelFiles(before.sources, async (source) => {
    const old = known.get(sourceKey(source)), record = await reader.record(source.path, old);
    // A row read from unsaved edits stays flagged until it is read again, even if only its timestamp changed.
    const { unsaved: _unsaved, file: _file, target: _target, ...bytes } = record as SourceRecord;
    records.set(sourceKey(source), { file: source.file, target: source.target, ...bytes, ...(old?.unsaved && old.sha256 === bytes.sha256 ? { unsaved: true } : {}) });
  });
  // A changed connector typedef can change every command that uses it, so those commands are read again.
  let typesChanged = false;
  for (const dependency of previous?.dependencies ?? []) {
    if (typesChanged) break;
    try { typesChanged = (await reader.record(dependency.path, dependency)).sha256 !== dependency.sha256; }
    catch { typesChanged = true; }
  }
  const pending = before.sources.filter((source) => {
    const key = sourceKey(source), row = previousRows.get(key), old = known.get(key);
    return !previous || !row || !old || old.sha256 !== records.get(key)!.sha256 || (typesChanged && row.status === "inspected");
  });
  const current = new Set(before.sources.map(sourceKey));
  const removed = [...previousRows.keys()].some((key) => !current.has(key));
  if (scope === "changed" && previous && !pending.length && !removed) return null;

  const startedAt = Date.now();
  let header: Omit<NiReport, "vis"> = previous?.report ?? { schemaVersion: REPORT_VERSION, projectFile: before.projectFile, labviewVersion: "", inspectedAt: "", dirtyContext: null };
  const inspectedRows = new Map<string, Record<string, unknown>>();
  if (pending.length) {
    let temporary: string | undefined;
    try {
      await fs.mkdir(cacheDirectory, { recursive: true });
      temporary = await fs.mkdtemp(path.join(cacheDirectory, "inspect-"));
      const requestFile = path.join(temporary, "request.json");
      const responseFile = path.join(temporary, "response.json");
      await writeJsonAtomically(requestFile, { schemaVersion: REPORT_VERSION, projectFile: before.projectFile,
        sources: pending.map((source) => ({ file: source.file, target: source.target, path: source.path, sha256: records.get(sourceKey(source))!.sha256 })) });
      await adapter(requestFile, responseFile);
      const response = await readBoundedJson(responseFile) as NiReport;
      // Validates the adapter version, project and that every requested VI was answered exactly once.
      decodeLabviewNiInspection(response, before.projectFile, pending);
      const after = new FileReader();
      for (const source of pending) {
        const record = records.get(sourceKey(source))!;
        if ((await after.record(source.path, record)).sha256 !== record.sha256) throw new Error("Project sources changed during NI inspection. Inspect again after saving your intended source changes.");
      }
      for (const row of response.vis) inspectedRows.set(sourceKey({ target: String(row.target), file: String(row.file) }), row);
      const { vis: _rows, ...rest } = response;
      header = rest;
    } finally { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); }
  }
  const report: NiReport = { ...header, vis: before.sources.map((source) => inspectedRows.get(sourceKey(source)) ?? previousRows.get(sourceKey(source))!) };
  for (const [key, row] of inspectedRows) {
    const record = records.get(key)!;
    if (unsavedRow(row)) record.unsaved = true; else delete record.unsaved;
  }
  const decoded = decodeLabviewNiInspection(report, before.projectFile, before.sources);
  const knownTypes = new Map((previous?.dependencies ?? []).map((dependency) => [identityPath(dependency.path), dependency]));
  const dependencies: DependencyRecord[] = [];
  if (decoded.dependencyPaths.length > 10000) throw new Error("NI type dependencies exceed the file count limit.");
  for (const file of decoded.dependencyPaths) {
    if (!path.isAbsolute(file) || !/\.(?:ctl|lvlib|lvclass)$/i.test(file)) throw new Error("NI type dependencies must be absolute local type-definition paths.");
    try {
      const record = await reader.record(file, knownTypes.get(identityPath(file)));
      // A typedef saved during this inspection is left unverified, so its callers are read again next time.
      dependencies.push({ path: file, ...record, ...(record.mtimeMs >= startedAt - MTIME_SLACK_MS ? { sha256: "" } : {}) });
    }
    catch (error) { if (!missingFile(error)) throw error; } // A typedef NI resolved elsewhere stays unbound; its callers are read again when they change.
  }
  const evidence: Evidence = { projectFile: before.projectFile, report, sources: before.sources.map((source) => records.get(sourceKey(source))!), dependencies };
  // Re-discover auto-populating folders and declarations so the result merges the project as it is now.
  const result = await catalogFromEvidence(await discoverLabviewProject(selection), evidence, "available");
  rememberEvidence(evidence);
  try {
    await fs.mkdir(cacheDirectory, { recursive: true });
    // Definitions read from unsaved VIs serve this session only; after a restart they are read again.
    const saved = evidence.sources.map(({ unsaved, ...source }) => unsaved ? { ...source, sha256: "" } : source);
    await writeJsonAtomically(cachePath(cacheDirectory, before.projectFile), { schemaVersion: EVIDENCE_VERSION, report, sources: saved, dependencies });
  } catch (error) { console.warn("Could not save LabVIEW command definitions:", errorMessage(error)); }
  return result;
}

/** Read every candidate VI in the selected, already-open project; cache in Bordeaux user data only. */
export async function inspectLabviewCommands(selection: string, cacheDirectory: string, adapter: Adapter = runLabviewNiAdapter): Promise<RobotCommandCatalog> {
  return (await inspect(selection, cacheDirectory, adapter, "all"))!;
}

/** Read only VIs that are new or changed since the last reading. Null when every definition is already current. */
export function refreshLabviewCommands(selection: string, cacheDirectory: string, adapter: Adapter = runLabviewNiAdapter): Promise<RobotCommandCatalog | null> {
  return inspect(selection, cacheDirectory, adapter, "changed");
}
