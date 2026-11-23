import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { RobotCommandCatalog, RobotCommandParameter } from "../core/types";
import { BORDEAUX_WAIT, generatedCatalogHash, parseGeneratedRobotCatalog } from "./robotGeneratedCatalog";
import { writeJsonAtomically } from "./projectFiles";
import { resolveLabviewProject, scanLabviewProject } from "./labviewProjectDiscovery";
export { resolveLabviewProject } from "./labviewProjectDiscovery";

export const LABVIEW_CATALOG_SOURCE = "bordeaux-catalog.json";
export const LABVIEW_SUPPORT_VERSION = "0.4.0";
const MAX_BYTES = 2 * 1024 * 1024;

function object(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${label} must be an object`);
  return raw as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label} has unknown field ${key}`);
}
function list(raw: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(raw) || raw.length > max) throw new Error(`${label} must be an array of at most ${max} entries`);
  return raw;
}
function relativeFile(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 1024 || raw.includes("\\") || raw.includes("\0") || path.posix.isAbsolute(raw)
    || raw.split("/").some((part) => !part || part === "." || part === "..") || /^[A-Za-z]:/.test(raw)) throw new Error("LabVIEW VI must be a relative project path");
  if (!raw.toLowerCase().endsWith(".vi")) throw new Error("LabVIEW binding must name a .vi file");
  return raw;
}
const WIRE_TYPES: Record<string, string> = { boolean: "Boolean", integer: "I32", integerString: "I64", decimalString: "Decimal", number: "DBL", string: "String", enum: "Enum", array: "Array", map: "Map", optional: "Optional", object: "Cluster" };
function schema(raw: unknown, depth = 0): Record<string, unknown> {
  if (depth > 24) throw new Error("LabVIEW schema nesting exceeds 24 levels");
  const value = object(raw, "Parameter schema");
  const kind = String(value.kind);
  keys(value, ["kind", ...(kind === "enum" ? ["enumValues"] : kind === "array" || kind === "optional" ? ["element"] : kind === "map" ? ["value"] : kind === "object" ? ["fields"] : kind === "integer" ? ["integerType"] : kind === "integerString" ? ["exactIntegerType"] : kind === "number" ? ["numberType"] : [])], "Parameter schema");
  if (!Object.hasOwn(WIRE_TYPES, kind)) throw new Error(`Unsupported LabVIEW parameter kind ${kind}`);
  const result: Record<string, unknown> = { kind, valueType: WIRE_TYPES[kind] };
  if (value.integerType !== undefined) {
    if (kind !== "integer" || !["I8", "I16", "I32", "U8", "U16", "U32"].includes(String(value.integerType))) throw new Error("integerType must be I8, I16, I32, U8, U16, or U32 on an integer schema");
    result.valueType = value.integerType;
  }
  if (value.exactIntegerType !== undefined) {
    if (!["I64", "U64", "U32"].includes(String(value.exactIntegerType))) throw new Error("exactIntegerType must be I64, U64, or U32");
    result.valueType = value.exactIntegerType;
  }
  if (value.numberType !== undefined) {
    if (!["SGL", "DBL"].includes(String(value.numberType))) throw new Error("numberType must be SGL or DBL");
    result.valueType = value.numberType;
  }
  if (kind === "enum") result.enumValues = list(value.enumValues, "Enum values", 1024);
  if (kind === "array" || kind === "optional") result.element = schema(value.element, depth + 1);
  if (kind === "map") result.value = schema(value.value, depth + 1);
  if (kind === "object") result.fields = list(value.fields, "Cluster fields", 256).map((rawField) => {
    const field = object(rawField, "Cluster field"); keys(field, ["name", "schema"], "Cluster field");
    return { name: field.name, schema: schema(field.schema, depth + 1) };
  });
  return result;
}
function parameters(raw: unknown): Record<string, unknown>[] {
  return list(raw ?? [], "Parameters", 256).map((item) => {
    const value = object(item, "Parameter");
    keys(value, ["name", "label", "description", "unit", "defaultValue", "min", "max", "schema"], "Parameter");
    const typedSchema = schema(value.schema);
    return { ...value, role: "argument", valueType: typedSchema.valueType, schema: typedSchema };
  });
}

/** Compile only declarative data; never execute a team script or inspect a VI binary. */
export function compileLabviewCatalog(raw: unknown) {
  const source = object(raw, "LabVIEW catalog");
  keys(source, ["schemaVersion", "catalogId", "commands", "conditions", "trajectoryGenerators"], "LabVIEW catalog");
  if (source.schemaVersion !== "bordeaux-labview-catalog/1") throw new Error("LabVIEW catalog must use bordeaux-labview-catalog/1");
  const descriptor = (rawItem: unknown, kind: "command" | "condition" | "generator") => {
    const value = object(rawItem, `LabVIEW ${kind}`);
    keys(value, ["id", "label", "description", "aliases", "semanticTags", "vi", ...(kind === "command" ? ["parameters"] : kind === "generator" ? ["inputs", "limits", "fallbackPolicy"] : [])], `LabVIEW ${kind}`);
    const vi = relativeFile(value.vi);
    const base: Record<string, unknown> = { id: value.id, label: value.label, ownerType: "LabVIEW", member: vi, source: { file: vi, line: 1 } };
    for (const key of ["description", "aliases", "semanticTags"]) if (value[key] !== undefined) base[key] = value[key];
    if (kind === "command") Object.assign(base, { kind: "factory", confidence: "confirmed", parameters: parameters(value.parameters) });
    if (kind === "generator") Object.assign(base, { inputs: parameters(value.inputs).sort((a, b) => String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : 0), limits: value.limits, fallbackPolicy: value.fallbackPolicy, preview: { kind: "runtimeDynamic" } });
    return base;
  };
  const sorted = (items: unknown[], kind: "command" | "condition" | "generator") => items.map((item) => descriptor(item, kind)).sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
  const commands = sorted(list(source.commands, "Commands", 5000), "command");
  const conditions = sorted(list(source.conditions ?? [], "Conditions", 5000), "condition");
  const trajectoryGenerators = sorted(list(source.trajectoryGenerators ?? [], "Trajectory generators", 1024), "generator");
  const document = { schemaVersion: "1.3", supportVersion: LABVIEW_SUPPORT_VERSION, catalogId: source.catalogId, commands, conditions, builtIns: [BORDEAUX_WAIT], trajectoryGenerators,
    catalogHash: generatedCatalogHash(commands, conditions, [BORDEAUX_WAIT], trajectoryGenerators) };
  // One parser owns the catalog contract, including defaults and limits.
  const catalog = parseGeneratedRobotCatalog(document);
  const runtimeParameters = (items: RobotCommandParameter[]) => Object.fromEntries(items.map((parameter) => [parameter.name, {
    ...parameter.schema, ...(parameter.min !== undefined ? { min: parameter.min } : {}), ...(parameter.max !== undefined ? { max: parameter.max } : {}),
  }]));
  const runtimeConfig = {
    compatibility: { catalogId: catalog.catalogId, catalogHash: catalog.catalogHash, supportVersion: catalog.supportVersion,
      fieldId: "REPLACE_WITH_COMPILED_FIELD_ID", fieldRevision: "REPLACE_WITH_COMPILED_FIELD_REVISION", fieldCoordinateSchemaId: "REPLACE_WITH_COMPILED_FIELD_COORDINATE_SCHEMA_ID" },
    commands: catalog.commands.map((command) => ({ id: command.id, parameters: runtimeParameters(command.parameters) })),
    conditions: catalog.conditions.map((condition) => ({ id: condition.id })),
    generators: catalog.trajectoryGenerators.map((generator) => ({ id: generator.id, parameters: runtimeParameters(generator.inputs), limits: generator.limits, fallbackPolicy: generator.fallbackPolicy })),
  };
  return { document, catalog, runtimeConfig };
}

export async function safeLabviewPath(root: string, relative: string, createDirectories = false): Promise<string> {
  if (relative.includes("\\") || relative.includes("\0") || path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => !part || part === "." || part === "..") || /^[A-Za-z]:/.test(relative)) throw new Error("LabVIEW support path must stay inside the project");
  const parts = relative.split("/");
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new Error(`LabVIEW project path ${relative} must use regular files and directories`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (createDirectories && index < parts.length - 1) await fs.mkdir(current);
    }
  }
  return current;
}
export async function readLabviewJson(root: string, relative: string): Promise<unknown> {
  const target = await safeLabviewPath(root, relative);
  const stat = await fs.lstat(target);
  if (stat.size > MAX_BYTES) throw new Error(`${relative} exceeds the 2 MiB read limit`);
  const contents = await fs.readFile(target, "utf8");
  const parsed: unknown = JSON.parse(contents);
  // Match the strict runtime reader: JSON.parse alone silently overwrites duplicate keys.
  const frames: Array<Set<string> | null> = [];
  const tokens = /"(?:[^"\\]|\\.)*"|[{}\[\]:]/g;
  let token: RegExpExecArray | null;
  while ((token = tokens.exec(contents))) {
    const current = token[0];
    if (current === "{" || current === "[") {
      frames.push(current === "{" ? new Set() : null);
      if (frames.length > 64) throw new Error(`${relative} exceeds 64 JSON nesting levels`);
    } else if (current === "}" || current === "]") frames.pop();
    else if (current.startsWith('"') && /^\s*:/.test(contents.slice(tokens.lastIndex))) {
      const key: string = JSON.parse(current);
      const names = frames.at(-1);
      if (names?.has(key)) throw new Error(`${relative} has duplicate JSON key ${key}`);
      names?.add(key);
    }
  }
  return parsed;
}
export async function isLabviewProject(root: string): Promise<boolean> {
  const stat = await fs.lstat(root);
  if (stat.isFile()) return path.extname(root).toLowerCase() === ".lvproj";
  if (!stat.isDirectory()) return false;
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".lvproj"));
}
export async function discoverLabviewProject(selection: string): Promise<RobotCommandCatalog> {
  const { root, projectFile } = await resolveLabviewProject(selection);
  const { discovery: labviewDiscovery, warnings } = await scanLabviewProject(projectFile);
  const summary = { runtime: "labview" as const, projectName: path.basename(projectFile, path.extname(projectFile)),
    sourceFileCount: labviewDiscovery.viCount, scannedAt: new Date().toISOString(), labviewDiscovery };
  let raw: unknown;
  try { raw = await readLabviewJson(root, LABVIEW_CATALOG_SOURCE); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { ...summary, source: "source", authoritative: false, runtimeCommandCount: 0,
      commands: [], conditions: [], trajectoryGenerators: [], warnings: [...warnings,
        "Project sources discovered. Inspect saved VI connectors in LabVIEW to discover command parameters, or declare commands in bordeaux-catalog.json."] };
  }
  const compiled = compileLabviewCatalog(raw);
  let ready = false;
  try {
    // Check handlers even before a first build, so missing declarations have an actionable preview.
    const bindings = await labviewBindings(root, compiled.catalog);
    const built = parseGeneratedRobotCatalog(await readLabviewJson(root, "bordeaux/generated/catalog-v1.json"));
    const bindingManifest = await readLabviewJson(root, "bordeaux/generated/bindings.json");
    ready = built.catalogHash === compiled.catalog.catalogHash && built.catalogId === compiled.catalog.catalogId
      && JSON.stringify(bindingManifest) === JSON.stringify({ projectFile: path.basename(projectFile), catalogHash: built.catalogHash, bindings });
    if (!ready) warnings.push("The selected project, catalog, or VI bindings changed. Build the catalog again before export.");
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
  }
  return { ...compiled.catalog, ...summary, generatedSchemaVersion: "1.3",
    source: ready ? "generated" : "source", authoritative: ready, runtimeCommandCount: ready ? compiled.catalog.commands.length : 0,
    commands: compiled.catalog.commands.map((command) => ({ ...command, runtimeReady: ready })), warnings };
}
export async function buildLabviewCatalog(selection: string): Promise<void> {
  const { root, projectFile } = await resolveLabviewProject(selection);
  const compiled = compileLabviewCatalog(await readLabviewJson(root, LABVIEW_CATALOG_SOURCE));
  const bindings = await labviewBindings(root, compiled.catalog);
  await writeJsonAtomically(await safeLabviewPath(root, "bordeaux/generated/runtime-config.template.json", true), { ...compiled.runtimeConfig, bindings });
  await writeJsonAtomically(await safeLabviewPath(root, "bordeaux/generated/bindings.json", true), { projectFile: path.basename(projectFile), catalogHash: compiled.catalog.catalogHash, bindings });
  await writeJsonAtomically(await safeLabviewPath(root, "bordeaux/generated/catalog-v1.json", true), compiled.document);
}
async function labviewBindings(root: string, catalog: ReturnType<typeof parseGeneratedRobotCatalog>) {
  const hashes = new Map<string, string>();
  let bytes = 0;
  const bindings: Array<{ id: string; kind: string; vi: string; sha256: string }> = [];
  for (const [kind, descriptors] of [["command", catalog.commands], ["condition", catalog.conditions], ["generator", catalog.trajectoryGenerators]] as const) {
    for (const descriptor of descriptors) {
      const vi = descriptor.member;
      if (!hashes.has(vi)) {
        const target = await safeLabviewPath(root, vi);
        const stat = await fs.lstat(target);
        if (stat.size > 32 * 1024 * 1024 || (bytes += stat.size) > 128 * 1024 * 1024) throw new Error("LabVIEW VI bindings exceed the 32 MiB per-file or 128 MiB total limit");
        hashes.set(vi, labviewBytesHash(await fs.readFile(target)));
      }
      bindings.push({ id: descriptor.id, kind, vi, sha256: hashes.get(vi)! });
    }
  }
  return bindings;
}
export function labviewBytesHash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
