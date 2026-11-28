import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { connectMacLabview } from "./labviewMacSession";
import type { LabviewViServer, LabviewValue } from "./labviewViServer";
import { assertMacLabviewReferenceSaveVersion, MAC_WRAPPER_STAGING_NAME, parseLabviewXml, scanLabviewProject, statLabviewLocalPath } from "./labviewProjectDiscovery";
import { writeJsonAtomically } from "./projectFiles";

interface Source { file: string; target: string; path: string }
interface InspectionRequest {
  schemaVersion: "bordeaux-ni-inspection/1";
  projectFile: string;
  sources: Source[];
}
interface WrapperRequest {
  schemaVersion: "bordeaux-ni-wrapper/1";
  projectFile: string;
  commandFile: string;
  wrapperFile: string;
  terminalCount: number;
  terminalNumbers: number[];
}
interface ReferencesRequest {
  schemaVersion: "bordeaux-ni-wrapper-references/1";
  projectFile: string;
  target: string;
  referencesFile: string;
  description: string;
  marker: string;
  wrapperFiles: string[];
}
type Request = InspectionRequest | WrapperRequest | ReferencesRequest;

interface Helper {
  get(name: string): Promise<LabviewValue>;
  set(name: string, value: LabviewValue): Promise<void>;
  run(): Promise<void>;
}
async function openHelper(server: LabviewViServer, file: string, inputs: Record<string, LabviewValue>): Promise<Helper> {
  const ref = await server.openVi(file);
  const helper: Helper = {
    get: name => server.get(ref, name),
    set: (name, value) => server.set(ref, name, value),
    run: () => server.run(ref),
  };
  for (const [name, value] of Object.entries(inputs)) await helper.set(name, value);
  return helper;
}
function viError(value: LabviewValue): { code: number; detail: string } | null {
  if (!Array.isArray(value) || value.length !== 3 || typeof value[0] !== "boolean" || typeof value[1] !== "number" || typeof value[2] !== "string") {
    throw new Error("Invalid error cluster from the LabVIEW helper.");
  }
  return value[0] ? { code: value[1], detail: value[2].slice(0, 1500) } : null;
}
function errorDetail(error: NonNullable<ReturnType<typeof viError>>): string {
  return `LabVIEW error ${error.code}${error.detail ? `: ${error.detail}` : "."}`;
}

const SCALAR_TYPE = /^<(?:String|Boolean|DBL|SGL|[IU](?:8|16|32|64)|EW|EB|EL)>/;
const MODIFICATION_BITS = ["VI Modifications Bitset", "Front Panel Mods Bitset", "Block Diagram Mods Bitset"];
const CHECK_PROJECT = "Open the selected project in LabVIEW 2026, then refresh commands.";
async function modified(helper: Helper, prefix: string): Promise<boolean | null> {
  if (viError(await helper.get(`${prefix} Error`))) return null;
  let changed = false;
  for (const label of MODIFICATION_BITS) {
    const bits = await helper.get(`${prefix}:${label}`);
    if (typeof bits !== "number" && !(typeof bits === "string" && /^\d+$/.test(bits))) return null;
    changed ||= bits !== 0 && bits !== "0";
  }
  return changed;
}
function containsStatusTypedef(info: LabviewValue): boolean {
  return Array.isArray(info) && Array.isArray(info[0]) && info[0].some(entry =>
    Array.isArray(entry) && Array.isArray(entry[0]) && entry[0].length === 1
    && typeof entry[1] === "string" && path.basename(entry[1]) === "Command Status Info.ctl");
}

async function inspectCommands(helper: Helper, request: InspectionRequest, labviewVersion: string) {
  await helper.set("vi path", "");
  await helper.set("read default", false);
  await helper.run();
  const projectError = viError(await helper.get("error out"));
  if (projectError?.code === 5101) throw new Error(CHECK_PROJECT);
  if (projectError) throw new Error(`Couldn’t read the LabVIEW project context: ${errorDetail(projectError)}`);
  if (await helper.get("Application:Version Number") !== labviewVersion) throw new Error("The LabVIEW VI Server version does not match the running installation.");

  const vis = [];
  for (const source of request.sources) {
    const identity = { file: source.file, target: source.target };
    if (!(await statLabviewLocalPath(source.path)).isFile()) throw new Error("LabVIEW inspection requires regular VI source files.");
    const file = await fs.realpath(source.path);
    await helper.set("vi path", file);
    await helper.set("read default", false);
    await helper.run();
    const error = viError(await helper.get("error out"));
    if (error?.code === 5101) throw new Error(CHECK_PROJECT);
    if (error) { vis.push({ ...identity, status: "unsupported", reason: errorDetail(error) }); continue; }
    if (await helper.get("VI Path") !== file) {
      vis.push({ ...identity, status: "unsupported", reason: "LabVIEW returned a different VI path." });
      continue;
    }
    const viType = await helper.get("VI Type");
    const modifiedBefore = await modified(helper, "Modifications");
    let modifiedAfter = await modified(helper, "Modifications After");
    if (viType === 3) {
      vis.push({ ...identity, modifiedBefore, modifiedAfter, viType, status: "nonCommand" });
      continue;
    }
    const connector = {
      numConnections: await helper.get("Num Connections"),
      captions: await helper.get("Captions"),
      wireRequirements: await helper.get("Wire Requirements"),
      ioStatus: await helper.get("I/O Status"),
      dataTypes: await helper.get("Data Types"),
      conNum: await helper.get("ConNum"),
      extendedInformation: await helper.get("Extended Information"),
    };
    const description = await helper.get("VI Description");
    const execState = await helper.get("Execution:State");
    const defaults: Record<string, string | number | boolean> = Object.create(null);
    const { dataTypes, ioStatus, extendedInformation } = connector;
    // Other project VIs help establish source membership but do not need a round trip for every scalar input.
    if (Array.isArray(dataTypes) && Array.isArray(ioStatus) && Array.isArray(extendedInformation)
      && extendedInformation.filter(containsStatusTypedef).length === 2) {
      await helper.set("read default", true);
      for (const [index, xml] of dataTypes.entries()) {
        if (ioStatus[index] !== 0 || typeof xml !== "string" || !SCALAR_TYPE.test(xml)) continue;
        let name: string;
        try { name = parseLabviewXml(xml).elementValueOrEmpty("Name"); }
        catch { continue; } // The shared connector decoder reports invalid type XML for this VI.
        if (!name.trim() || name.length > 256) continue;
        await helper.set("control name", name);
        await helper.run();
        const failure = viError(await helper.get("error out"));
        if (failure?.code === 5101) throw new Error(CHECK_PROJECT);
        if (failure) continue;
        const beforeDefault = await modified(helper, "Modifications");
        const afterDefault = await modified(helper, "Modifications After");
        if (beforeDefault || afterDefault) modifiedAfter = true;
        else if (modifiedAfter !== true && (beforeDefault === null || afterDefault === null)) modifiedAfter = null;
        const value = await helper.get("Control Value:Get Default");
        if (typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) defaults[name] = value;
      }
    }
    vis.push({ ...identity, modifiedBefore, modifiedAfter, viType, description, execState, defaults, connector, status: "inspected", dependencies: [], dependenciesAvailable: true });
  }
  // LabVIEW's dirty-items list on Mac includes other open projects. Keep the scoped VI flags
  // and typedef paths in each evidence row without vouching for the entire application's saved state.
  return { schemaVersion: request.schemaVersion, projectFile: request.projectFile, labviewVersion, inspectedAt: new Date().toISOString(), dirtyContext: null, platform: "darwin", vis };
}
async function createWrapper(helper: Helper, request: WrapperRequest) {
  await helper.run();
  const failure = viError(await helper.get("error out"));
  if (failure) {
    if (failure.code === 1055) throw new Error(CHECK_PROJECT);
    throw new Error(`Wrapper scripting failed: ${errorDetail(failure)}`);
  }
  const errors = await helper.get("terminal errors");
  if (!Array.isArray(errors) || errors.length !== request.terminalCount) throw new Error("Wrapper terminal count does not match the inspected command. Rescan command inputs.");
  for (const terminal of errors) {
    const error = viError(terminal);
    if (error) throw new Error(`Wrapper terminal wiring failed: ${errorDetail(error)}`);
  }
  return { schemaVersion: request.schemaVersion, wrapperFile: request.wrapperFile, terminalCount: errors.length };
}
async function updateReferences(helper: Helper, request: ReferencesRequest) {
  await helper.run();
  let failure = viError(await helper.get("error out"));
  if (failure?.code === 5003) {
    // Mac LabVIEW can open a project without loading its legacy RT target. Update the file in the
    // desktop context in that case, so the target can load the saved references on its next open.
    const { discovery } = await scanLabviewProject(request.projectFile);
    if (!discovery.truncated && discovery.targets.some(target => target.name === request.target && /^RT (?:myRIO|roboRIO)$/.test(target.type))) {
      await helper.set("target name", "My Computer");
      await helper.run();
      failure = viError(await helper.get("error out"));
    }
  }
  if (failure) {
    switch (failure.code) {
      case 1055: throw new Error("The selected project is not already open in LabVIEW. Open it, then refresh commands.");
      case 5001: throw new Error("The open Bordeaux Command Wrappers.vi is missing its ownership marker. Close or rename it, then refresh commands.");
      case 5002: throw new Error("Bordeaux Command Wrappers.vi has unsaved changes in LabVIEW. Save or revert it, then refresh commands.");
      case 5003: throw new Error(`The project has no target named “${request.target}”. Rescan command inputs.`);
      default: throw new Error(`Updating Bordeaux Command Wrappers.vi failed: ${errorDetail(failure)}`);
    }
  }
  const count = await helper.get("reference count");
  if (count !== request.wrapperFiles.length) throw new Error("Bordeaux Command Wrappers.vi does not reference every command wrapper. Refresh commands to try again.");
  return { schemaVersion: request.schemaVersion, referencesFile: request.referencesFile, referenceCount: count };
}

async function runRequest(request: Request, projectPath: string, directory: string, resource: (name: string) => Promise<string>) {
  const { server, version } = await connectMacLabview();
  const helper = async (name: string, inputs: Record<string, LabviewValue> = {}) => {
    // LabVIEW shares front-panel values between connections to the same VI. Each request gets its
    // own copy, so two Bordeaux processes cannot change each other's project or output paths.
    const file = path.join(directory, `${path.basename(name, ".vi")}-${randomUUID()}.vi`);
    await fs.copyFile(await resource(name), file, fs.constants.COPYFILE_EXCL);
    return openHelper(server, file, { "project path": projectPath, ...inputs });
  };
  try {
    switch (request.schemaVersion) {
      case "bordeaux-ni-inspection/1":
        return await inspectCommands(await helper("InspectCommandsMac.vi"), request, version);
      case "bordeaux-ni-wrapper/1": {
        if (!(await statLabviewLocalPath(request.commandFile)).isFile() || path.dirname(request.wrapperFile) !== path.dirname(request.commandFile)
          || !MAC_WRAPPER_STAGING_NAME.test(path.basename(request.wrapperFile))) throw new Error("Wrapper output must be a Bordeaux temporary VI alongside the command.");
        await fs.lstat(request.wrapperFile).then(() => { throw new Error("The temporary wrapper already exists."); }, (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
        const wrapper = await helper("CreateCommandWrapperMac.vi", {
          "command path": request.commandFile, "wrapper path": request.wrapperFile, "terminal numbers": request.terminalNumbers,
        });
        return await createWrapper(wrapper, request);
      }
      case "bordeaux-ni-wrapper-references/1": {
        if (request.referencesFile !== path.join(path.dirname(request.projectFile), "Bordeaux Command Wrappers.vi")
          || !(await statLabviewLocalPath(request.referencesFile)).isFile()) throw new Error("Wrapper references must be Bordeaux Command Wrappers.vi beside the project.");
        for (const file of request.wrapperFiles) {
          if (!/_wrapper\.vi$/i.test(file) || !(await statLabviewLocalPath(file)).isFile()) throw new Error("Wrapper references require regular command wrapper VIs.");
        }
        const references = await helper("UpdateCommandWrapperReferencesMac.vi", {
          "target name": request.target, "references path": request.referencesFile,
          description: request.description, marker: request.marker, "wrapper paths": request.wrapperFiles,
        });
        return await updateReferences(references, request);
      }
      default: throw new Error("Invalid Bordeaux LabVIEW request.");
    }
  } finally {
    server.close();
  }
}

/** Main-process requests are built from a resolved local project and guarded source or output paths. */
export async function runMacLabviewAdapter(requestFile: string, responseFile: string, resource: (name: string) => Promise<string>): Promise<void> {
  const request = JSON.parse(await fs.readFile(requestFile, "utf8")) as Request;
  if (!(await statLabviewLocalPath(request.projectFile)).isFile()) throw new Error("Select a local LabVIEW project file.");
  const projectPath = await fs.realpath(request.projectFile);
  if (request.schemaVersion === "bordeaux-ni-wrapper-references/1") await assertMacLabviewReferenceSaveVersion(projectPath);
  const directory = path.dirname(requestFile);
  const response = await runRequest(request, projectPath, directory, resource).catch((error: NodeJS.ErrnoException) => {
    // A disconnected inspection has no project writes. Scripting may already have saved its result.
    if (request.schemaVersion !== "bordeaux-ni-inspection/1" || !["ECONNRESET", "EPIPE"].includes(error.code ?? "")) throw error;
    return runRequest(request, projectPath, directory, resource);
  });
  await writeJsonAtomically(responseFile, response);
}
