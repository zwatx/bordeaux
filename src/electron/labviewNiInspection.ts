import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import type { RobotCommandCatalog, RobotCommandDescriptor, LabviewProjectDiscovery } from "../shared/types";
import { discoverLabviewProject, resolveLabviewProject, LABVIEW_CATALOG_SOURCE } from "./labviewProject";
import { writeJsonAtomically } from "./projectFiles";
import { decodeLabviewNiInspection } from "./labviewNiTypes";
import { statLabviewLocalPath } from "./labviewProjectDiscovery";

const SCHEMA_VERSION = "bordeaux-ni-inspection/1";
const MAX_SOURCES = 1000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const identityPath = (file: string) => process.platform === "win32" ? file.toLowerCase() : file;
type Source = { file: string; path: string; target: string; sha256: string };
export interface LabviewNiSource { file: string; target: string }
type Inspection = NonNullable<LabviewProjectDiscovery["inspection"]>;
interface Snapshot { projectFile: string; fingerprint: string; declarationHash: string | null; sources: Source[]; typeHashes: Array<{ path: string; sha256: string }> }
// Live connector snapshots are usable for authoring/export in this process, even
// when NI cannot prove saved-state metadata. They never become a saved-source cache.
const activeInspections = new WeakMap<RobotCommandDescriptor[], {
  projectFile: string; fingerprint: string; declarationHash: string | null; dependencies: Array<{ path: string; sha256: string }>;
}>();

/** Match the legacy project-tree exclusions; filenames alone never confirm a command. */
export function eligibleLabviewLegacySource(item: LabviewProjectDiscovery["items"][number]): boolean {
  return item.status === "present" && !!item.file?.toLowerCase().endsWith(".vi")
    && !item.projectPath.split("/").some((part) => /^(?:Support Code|Framework)$/i.test(part))
    && !/Command Helper\.vi/i.test(item.name)
    && !["prep command info for wait.vi", "wait for command.vi", "should abort operation.vi", "subsystems.vi"].includes(item.name.toLowerCase());
}

async function snapshot(selection: string, catalog: RobotCommandCatalog): Promise<Snapshot> {
  const { root, projectFile } = await resolveLabviewProject(selection);
  if (!catalog.labviewDiscovery || catalog.labviewDiscovery.truncated) throw new Error("Complete project discovery is required before NI command inspection.");
  const sources: Source[] = [];
  const typeSources: Array<{ file: string; sha256: string }> = [];
  const seen = new Set<string>();
  const seenTypes = new Set<string>();
  const robotTargets = new Set(catalog.labviewDiscovery.targets.filter((target) => target.type === "RT myRIO" || target.type === "RT roboRIO").map((target) => target.name));
  let totalBytes = 0;
  const bytesHash = async (file: string) => {
    const stat = await statLabviewLocalPath(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("NI inspection requires regular source files.");
    if (stat.size > 32 * 1024 * 1024 || (totalBytes += stat.size) > 256 * 1024 * 1024) throw new Error("NI inspection source hashes exceed the read limit.");
    return hash(await fs.readFile(file));
  };
  for (const item of catalog.labviewDiscovery.items) {
    if (item.status === "present" && item.file && /\.(?:ctl|lvlib|lvclass)$/i.test(item.file) && !seenTypes.has(item.file)) {
      seenTypes.add(item.file);
      typeSources.push({ file: item.file, sha256: await bytesHash(path.resolve(root, item.file)) });
    }
    if (!robotTargets.has(item.target) || !eligibleLabviewLegacySource(item)) continue;
    const key = `${item.target}\0${item.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (sources.length >= MAX_SOURCES) throw new Error("NI inspection supports at most 1000 VI sources per project.");
    const file = path.resolve(root, item.file!);
    sources.push({ file: item.file!, target: item.target, path: file, sha256: await bytesHash(file) });
  }
  sources.sort((a, b) => `${a.target}/${a.file}`.localeCompare(`${b.target}/${b.file}`));
  typeSources.sort((a, b) => a.file.localeCompare(b.file));
  let declarationHash: string | null = null;
  try { declarationHash = await bytesHash(path.join(root, LABVIEW_CATALOG_SOURCE)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return { projectFile, sources, declarationHash, typeHashes: typeSources.map((type) => ({ path: path.resolve(root, type.file), sha256: type.sha256 })),
    fingerprint: hash(JSON.stringify({ projectFile: identityPath(projectFile), projectHash: await bytesHash(projectFile), sources, typeSources })) };
}
function cachePath(cacheDirectory: string, projectFile: string): string { return path.join(cacheDirectory, `${hash(identityPath(projectFile))}.json`); }
function unavailable(catalog: RobotCommandCatalog, status: "unavailable" | "stale", reason: string): RobotCommandCatalog {
  if (!catalog.labviewDiscovery) return catalog;
  return { ...catalog, labviewDiscovery: { ...catalog.labviewDiscovery, inspection: { status, commandCount: 0, unsupported: [], reason } }, warnings: [...catalog.warnings, reason] };
}
function merge(catalog: RobotCommandCatalog, commands: RobotCommandDescriptor[], inspection: Inspection): RobotCommandCatalog {
  if (!catalog.labviewDiscovery) return catalog;
  const memberKey = (member: string) => member.replaceAll("\\", "/").toLowerCase();
  const declared = new Set(catalog.commands.map((command) => memberKey(command.member)));
  const warnings = [...catalog.warnings];
  const canonical = (value: unknown): string => {
    if (!value || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  };
  const merged = catalog.commands.map((command) => {
    const matches = commands.filter((inspected) => memberKey(inspected.member) === memberKey(command.member));
    if (!matches.length) return command;
    const inspected = matches[0];
    const inputs = command.parameters.filter((parameter) => parameter.role === "argument");
    const discoveredInputs = inspected.parameters.filter((parameter) => parameter.role === "argument");
    const matchesTypes = inputs.length === discoveredInputs.length && inputs.every((parameter) => {
      const found = discoveredInputs.filter((candidate) => candidate.name === parameter.name);
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
async function dependencySnapshot(files: string[]): Promise<Array<{ path: string; sha256: string }>> {
  if (files.length > 10000) throw new Error("NI type dependencies exceed the file count limit.");
  let bytes = 0;
  const result: Array<{ path: string; sha256: string }> = [];
  for (const file of files) {
    if (!path.isAbsolute(file) || !/\.(?:ctl|lvlib|lvclass)$/i.test(file)) throw new Error("NI type dependencies must be absolute local type-definition paths.");
    const stat = await statLabviewLocalPath(file);
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024 || (bytes += stat.size) > 128 * 1024 * 1024) throw new Error("NI type dependency hashes exceed the read limit.");
    result.push({ path: file, sha256: hash(await fs.readFile(file)) });
  }
  return result;
}
function preInspectedDependencies(snapshot: Snapshot, paths: string[]): Array<{ path: string; sha256: string }> | null {
  const known = new Map(snapshot.typeHashes.map((type) => [identityPath(type.path), type.sha256]));
  if (paths.some((file) => !path.isAbsolute(file) || !known.has(identityPath(path.resolve(file))))) return null;
  return paths.map((file) => ({ path: file, sha256: known.get(identityPath(path.resolve(file)))! }));
}

/** Passive refresh: portable NI metadata is used only while the project and VI bytes match. */
export async function withCachedLabviewCommands(selection: string, catalog: RobotCommandCatalog, cacheDirectory: string): Promise<RobotCommandCatalog> {
  if (catalog.runtime !== "labview") return catalog;
  const { projectFile } = await resolveLabviewProject(selection);
  let raw: unknown;
  try { raw = await readBoundedJson(cachePath(cacheDirectory, projectFile)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return catalog;
    return unavailable(catalog, "stale", `Cached NI metadata could not be read: ${errorMessage(error)} Inspect commands again.`);
  }
  try {
    const value = raw as { schemaVersion?: unknown; fingerprint?: unknown; report?: unknown; dependencies?: unknown };
    const current = await snapshot(selection, catalog);
    if (value?.schemaVersion !== SCHEMA_VERSION || value.fingerprint !== current.fingerprint) throw new Error("Project or VI sources changed since NI inspection.");
    const decoded = decodeLabviewNiInspection(value.report, current.projectFile, current.sources);
    if (!preInspectedDependencies(current, decoded.dependencyPaths)) throw new Error("NI typedef dependencies were not covered by the project's source fingerprint.");
    if (!decoded.cacheable || JSON.stringify(value.dependencies) !== JSON.stringify(await dependencySnapshot(decoded.dependencyPaths))) throw new Error("NI type definitions changed or the inspection cannot be bound to saved sources.");
    return merge(catalog, decoded.commands, { ...decoded.inspection, status: "cached" });
  } catch (error) { return unavailable(catalog, "stale", `${errorMessage(error)} Inspect commands again.`); }
}

/** Revalidate a main-owned live snapshot without automating NI or claiming saved-state evidence. */
export async function withActiveLabviewCommands(selection: string, catalog: RobotCommandCatalog, active: RobotCommandCatalog | null | undefined): Promise<RobotCommandCatalog | null> {
  const evidence = active && activeInspections.get(active.commands);
  if (!active || !evidence) return null;
  const current = await snapshot(selection, catalog);
  if (identityPath(current.projectFile) !== identityPath(evidence.projectFile)) throw new Error("The active command inspection belongs to another LabVIEW project. Refresh commands before exporting BDX.");
  if (current.fingerprint !== evidence.fingerprint || current.declarationHash !== evidence.declarationHash
    || JSON.stringify(evidence.dependencies) !== JSON.stringify(await dependencySnapshot(evidence.dependencies.map(item => item.path)))) {
    throw new Error("LabVIEW sources, command declarations or type definitions changed since command inspection. Refresh commands before exporting BDX.");
  }
  return active;
}

async function runAdapter(requestFile: string, responseFile: string): Promise<void> {
  if (process.platform !== "win32") throw new Error("NI inspection is available on Windows with LabVIEW installed. Existing cached and declared catalogs remain available.");
  const developmentScript = path.resolve(__dirname, "../../resources/labview-inspection/InspectCommands.ps1");
  const script = await fs.access(developmentScript).then(() => developmentScript,
    () => path.join((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? "", "labview-inspection", "InspectCommands.ps1"));
  await fs.access(script);
  const windows = process.env.SystemRoot ?? "C:\\Windows";
  const powershell32 = path.join(windows, "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe");
  const powershell = await fs.access(powershell32).then(() => powershell32, () => path.join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  await new Promise<void>((resolve, reject) => {
    execFile(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-RequestFile", requestFile, "-ResponseFile", responseFile],
      { windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, _stdout, stderr) => {
        if (error) reject(new Error(error.killed ? "NI command inspection timed out. LabVIEW was left open." : stderr.trim().slice(0, 2000) || error.message));
        else resolve();
      });
  });
}

/** Inspect the selected, already-open project; cache in Bordeaux user data only. */
export async function inspectLabviewCommands(selection: string, cacheDirectory: string, adapter: (requestFile: string, responseFile: string) => Promise<void> = runAdapter): Promise<RobotCommandCatalog> {
  const catalog = await discoverLabviewProject(selection);
  let temporary: string | undefined;
  try {
    const before = await snapshot(selection, catalog);
    await fs.mkdir(cacheDirectory, { recursive: true });
    temporary = await fs.mkdtemp(path.join(cacheDirectory, "inspect-"));
    const requestFile = path.join(temporary, "request.json");
    const responseFile = path.join(temporary, "response.json");
    await writeJsonAtomically(requestFile, { schemaVersion: SCHEMA_VERSION, projectFile: before.projectFile, sources: before.sources });
    await adapter(requestFile, responseFile);
    const report = await readBoundedJson(responseFile);
    const decoded = decodeLabviewNiInspection(report, before.projectFile, before.sources);
    // Re-discover auto folders as well as hashing existing files before accepting the result.
    const refreshed = await discoverLabviewProject(selection);
    const after = await snapshot(selection, refreshed);
    if (before.fingerprint !== after.fingerprint || before.declarationHash !== after.declarationHash) throw new Error("Project sources changed during NI inspection. Inspect again after saving your intended source changes.");
    // Never bind old NI metadata to a hash first observed after inspection.
    const dependencies = preInspectedDependencies(before, decoded.dependencyPaths);
    if (!dependencies) {
      decoded.cacheable = false;
      decoded.inspection.reason = [decoded.inspection.reason,
        "Live inspection only: some typedefs were discovered during NI inspection and were not fingerprinted beforehand; their saved-source identity cannot be verified."].filter(Boolean).join(" ");
    }
    if (decoded.cacheable && dependencies) {
      if (JSON.stringify(dependencies) !== JSON.stringify(await dependencySnapshot(decoded.dependencyPaths))) throw new Error("NI type definitions changed during inspection. Inspect commands again.");
      await writeJsonAtomically(cachePath(cacheDirectory, before.projectFile), { schemaVersion: SCHEMA_VERSION, fingerprint: before.fingerprint, dependencies, report });
    } else await fs.rm(cachePath(cacheDirectory, before.projectFile), { force: true });
    const result = merge(refreshed, decoded.commands, decoded.inspection);
    activeInspections.set(result.commands, { projectFile: after.projectFile, fingerprint: after.fingerprint, declarationHash: after.declarationHash,
      dependencies: await dependencySnapshot(decoded.dependencyPaths) });
    return result;
  } finally { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); }
}
