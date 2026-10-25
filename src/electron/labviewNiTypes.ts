import path from "node:path";
import { createHash } from "node:crypto";
import type { XElement } from "builder-util-runtime/out/xml";
import type { RobotCommandDescriptor, RobotCommandOutput, LabviewProjectDiscovery } from "../shared/types";
import type { LabviewNiSource } from "./labviewNiInspection";
import { compileLabviewCatalog } from "./labviewProject";
import { parseLabviewXml } from "./labviewProjectDiscovery";

type Inspection = NonNullable<LabviewProjectDiscovery["inspection"]>;
const record = (raw: unknown, label: string): Record<string, unknown> => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${label} must be an object`);
  return raw as Record<string, unknown>;
};
const text = (raw: unknown, label: string, limit = 1024): string => {
  if (typeof raw !== "string" || raw.length > limit || raw.includes("\0")) throw new Error(`${label} must be bounded text`);
  return raw;
};
const list = (raw: unknown, label: string, limit = 1000): unknown[] => {
  if (!Array.isArray(raw) || raw.length > limit) throw new Error(`${label} must be a bounded array`);
  return raw;
};
const TYPE_METADATA = new Set(["Name", "Val", "NumElts", "Dimsize", "Choice"]);
const children = (xml: XElement) => (xml.elements ?? []).filter((element) => !TYPE_METADATA.has(element.name));

/** NI flattened type XML is data, never an executable input. Unknown representations remain unsupported. */
function parameterSchema(xml: XElement, depth = 0): Record<string, unknown> {
  if (depth > 16) throw new Error("NI argument type nesting exceeds 16 levels");
  // Shared schemas carry min/max on parameters, not nested fields/elements.
  if (depth > 0 && /^U(?:8|16|32|64)$/.test(xml.name)) throw new Error(`Nested NI ${xml.name} bounds require an explicit robot-side type mapping`);
  const scalars: Record<string, Record<string, unknown>> = {
    String: { kind: "string" }, Boolean: { kind: "boolean" }, DBL: { kind: "number", numberType: "DBL" }, SGL: { kind: "number", numberType: "SGL" },
    I8: { kind: "integer", integerType: "I8" }, I16: { kind: "integer", integerType: "I16" }, I32: { kind: "integer", integerType: "I32" },
    U8: { kind: "integer", integerType: "U8" }, U16: { kind: "integer", integerType: "U16" },
    I64: { kind: "integerString", exactIntegerType: "I64" }, U32: { kind: "integerString", exactIntegerType: "U32" }, U64: { kind: "integerString", exactIntegerType: "U64" },
  };
  if (scalars[xml.name]) return scalars[xml.name];
  if (["EW", "EB", "EL"].includes(xml.name)) {
    const choices = xml.getElements("Choice").map((element) => element.value);
    if (!choices.length || choices.length > 1024 || new Set(choices).size !== choices.length || choices.some((choice) => !choice)) throw new Error("NI enum has missing or duplicate choice labels");
    return { kind: "enum", enumValues: choices };
  }
  if (xml.name === "Array") {
    const elements = children(xml);
    if (xml.getElements("Dimsize").length !== 1 || elements.length !== 1) throw new Error("Only one-dimensional NI arrays with an explicit element type are supported");
    return { kind: "array", element: parameterSchema(elements[0], depth + 1) };
  }
  if (xml.name === "Cluster") {
    const elements = children(xml);
    if (elements.length > 256 || Number(xml.elementValueOrEmpty("NumElts")) !== elements.length) throw new Error("NI cluster element count does not match its type");
    const names = elements.map((element) => element.elementValueOrEmpty("Name"));
    if (names.some((name) => !name.trim()) || new Set(names).size !== names.length) throw new Error("NI clusters require unique, nonempty field labels for typed arguments");
    return { kind: "object", fields: elements.map((element, index) => ({ name: names[index], schema: parameterSchema(element, depth + 1) })) };
  }
  throw new Error(`NI ${xml.name} arguments require an explicit robot-side type mapping`);
}
function scalarDefault(value: unknown, schema: Record<string, unknown>): unknown {
  if (schema.kind === "enum" && typeof value === "number") {
    const choices = schema.enumValues as string[];
    if (!Number.isInteger(value) || value < 0 || value >= choices.length) throw new Error("NI saved enum default is outside its declared choices");
    return choices[value];
  }
  if (schema.kind === "integerString" && (typeof value === "string" || typeof value === "number" && Number.isSafeInteger(value))) return String(value);
  return value;
}
function unsignedBounds(xml: XElement): { min?: number | string; max?: number | string } {
  return xml.name === "U8" ? { min: 0, max: 255 } : xml.name === "U16" ? { min: 0, max: 65535 }
    : xml.name === "U32" ? { min: "0", max: "4294967295" } : xml.name === "U64" ? { min: "0", max: "18446744073709551615" } : {};
}
function typedefs(raw: unknown, name: string): { root?: string; paths: string[] } {
  const outer = list(raw, "NI terminal extended information", 4);
  if (outer.length !== 1) throw new Error("Unsupported NI terminal extended information layout");
  const entries = list(outer[0], "NI typedef records", 512);
  let root: string | undefined;
  const paths: string[] = [];
  for (const rawEntry of entries) {
    const entry = list(rawEntry, "NI typedef record", 5);
    if (entry.length !== 5) throw new Error("Unsupported NI typedef record layout");
    const names = list(entry[0], "NI typedef control path", 32).map((part) => text(part, "NI typedef control name"));
    const file = text(entry[1], "NI typedef path", 4096);
    if (typeof entry[2] !== "boolean" || !Number.isInteger(entry[3]) || !Array.isArray(entry[4])) throw new Error("Unsupported NI typedef metadata");
    if (file) paths.push(file);
    if (names.length === 1 && names[0] === name && file) {
      if (root) throw new Error("Duplicate NI root typedef record");
      root = file;
    }
  }
  return { root, paths };
}
function statusCluster(xml: XElement): boolean {
  const fields = children(xml);
  return xml.name === "Cluster" && Number(xml.elementValueOrEmpty("NumElts")) === 3 && fields.length === 3 && fields[0].name === "String" && fields[0].elementValueOrEmpty("Name") === "Name"
    && fields[1].name === "EW" && fields[1].elementValueOrEmpty("Name") === "Status"
    && JSON.stringify(fields[1].getElements("Choice").map((element) => element.value)) === JSON.stringify(["Successful", "Aborted", "Incomplete"])
    && fields[2].name === "Refnum" && fields[2].elementValueOrEmpty("RefKind") === "Notifier";
}

export function decodeLabviewNiInspection(raw: unknown, projectFile: string, sources: LabviewNiSource[]): {
  commands: RobotCommandDescriptor[]; inspection: Inspection; cacheable: boolean; dependencyPaths: string[];
} {
  const report = record(raw, "NI inspection report");
  if (report.schemaVersion !== "bordeaux-ni-inspection/1" || report.labviewVersion !== "25.3.3f3") throw new Error("Unsupported NI connector adapter version. This adapter was validated with LabVIEW 2025 25.3.3f3.");
  if (text(report.projectFile, "NI project file", 4096) !== projectFile) throw new Error("NI inspection report belongs to a different project");
  const inspectedAt = text(report.inspectedAt, "NI inspection timestamp");
  if (!Number.isFinite(Date.parse(inspectedAt))) throw new Error("NI inspection timestamp is invalid");
  const rows = list(report.vis, "NI inspected VIs");
  const requested = new Map(sources.map((source) => [`${source.target}\0${source.file}`, source]));
  if (rows.length !== requested.size) throw new Error("NI inspection did not return every requested VI");
  const seen = new Set<string>();
  const commands: RobotCommandDescriptor[] = [];
  const unsupported: Inspection["unsupported"] = [];
  const dependencyPaths = new Set<string>();
  const cacheBlockers = new Set<string>();
  let cacheable = report.dirtyContext === false;
  if (report.dirtyContext !== false) cacheBlockers.add(report.dirtyContext === true ? "NI reports unsaved items in the inspection instance" : "NI did not provide the inspection instance's saved-state metadata");
  for (const rawRow of rows) {
    const row = record(rawRow, "NI inspected VI");
    const file = text(row.file, "NI source file");
    const target = text(row.target, "NI target name");
    const key = `${target}\0${file}`;
    if (!requested.has(key) || seen.has(key)) throw new Error("NI inspection returned an unexpected or duplicate source");
    seen.add(key);
    if (row.modifiedBefore !== false || row.modifiedAfter !== false) {
      cacheable = false;
      cacheBlockers.add(row.modifiedBefore === true || row.modifiedAfter === true ? "NI reports unsaved VI changes" : "NI did not provide VI saved-state metadata");
    }
    if (row.status === "nonCommand") {
      if (row.viType !== 3) throw new Error("NI non-command classification requires the verified global VI type");
      continue;
    }
    // Failure to inspect an unrelated, clean source does not invalidate the
    // verified command subset. Keep its limitation visible in cached results.
    if (row.status === "unsupported") { unsupported.push({ file, target, reason: text(row.reason, "NI inspection failure", 4096) }); continue; }
    if (row.status !== "inspected") throw new Error("NI inspection returned an unknown VI status");
    if (row.dependenciesAvailable !== true) { cacheable = false; cacheBlockers.add("type dependency metadata is unavailable"); }
    if (row.dependenciesAvailable === true) for (const dependency of list(row.dependencies, "NI type dependencies", 10000)) dependencyPaths.add(text(dependency, "NI dependency path", 4096));
    try {
      const connector = record(row.connector, "NI connector");
      const count = connector.numConnections;
      if (!Number.isInteger(count) || (count as number) < 0 || (count as number) > 64) throw new Error("NI connector count is invalid");
      const arrays = ["captions", "wireRequirements", "ioStatus", "dataTypes", "conNum", "extendedInformation"].map((name) => {
        const values = count === 0 && connector[name] === null ? [] : list(connector[name], `NI ${name}`, 64);
        if (values.length !== count) throw new Error(`NI ${name} does not match the connector count`);
        return values;
      });
      const [captions, requirements, directions, dataTypes, numbers, extended] = arrays;
      if (new Set(numbers).size !== count || numbers.some((value) => !Number.isInteger(value) || (value as number) < 0 || (value as number) > 255)
        || directions.some((value) => value !== 0 && value !== 1) || requirements.some((value) => !Number.isInteger(value) || (value as number) < 0 || (value as number) > 2)) throw new Error("Unsupported NI connector flags or terminal numbers");
      if (dataTypes.some((value) => typeof value === "string" && !value.trim())) throw new Error(row.execState === 0
        ? "NI connector metadata unavailable: VI is broken in the My Computer inspection context; target behavior was not inspected."
        : "NI connector types are unavailable in the My Computer inspection context; target behavior was not inspected.");
      const terminals = dataTypes.map((value, index) => {
        text(captions[index], "NI terminal caption");
        const xml = parseLabviewXml(text(value, "NI terminal XML", 256 * 1024));
        const name = xml.elementValueOrEmpty("Name");
        if (!name.trim() || name.length > 256) throw new Error("NI connector requires a named terminal");
        const type = typedefs(extended[index], name);
        for (const dependency of type.paths) dependencyPaths.add(dependency);
        return { name, xml, direction: directions[index], type, caption: captions[index] as string, terminalNumber: numbers[index] as number };
      });
      const statuses = terminals.filter((terminal) => terminal.type.root && path.win32.basename(terminal.type.root) === "Command Status Info.ctl");
      if (statuses.length !== 2) continue;
      if (!statuses.some((terminal) => terminal.direction === 0) || !statuses.some((terminal) => terminal.direction === 1) || !statuses.every((terminal) => statusCluster(terminal.xml))) throw new Error("Legacy status terminals do not match the observed input/output completion lifecycle");
      const defaults = record(row.defaults, "NI saved defaults");
      const parameters = terminals.filter((terminal) => terminal.direction === 0 && !statuses.includes(terminal)).map((terminal) => {
        const schema = parameterSchema(terminal.xml);
        return { name: terminal.name, schema, ...unsignedBounds(terminal.xml), ...(Object.hasOwn(defaults, terminal.name) ? { defaultValue: scalarDefault(defaults[terminal.name], schema) } : {}) };
      });
      const id = `labview.legacy.${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
      const label = path.posix.basename(file, path.posix.extname(file));
      // Reuse the canonical catalog parser for parameter schemas and saved default validation.
      const checked = compileLabviewCatalog({ schemaVersion: "bordeaux-labview-catalog/1", catalogId: "ni-source-preview", commands: [{ id, label, vi: "Handler.vi", parameters }] }).catalog.commands[0];
      const outputs: RobotCommandOutput[] = [];
      const outputTerminals = terminals.filter((terminal) => terminal.direction === 1 && !statuses.includes(terminal));
      for (const terminal of outputTerminals) {
        try {
          if (outputTerminals.filter((candidate) => candidate.name === terminal.name).length !== 1) throw new Error("NI outputs require unique terminal names");
          const schema = parameterSchema(terminal.xml);
          if (!["boolean", "enum", "number", "integer", "integerString"].includes(String(schema.kind))) throw new Error(`NI ${terminal.xml.name} outputs are not supported for branching; use a Boolean, enum, or numeric output`);
          // Outputs share value types with inputs, but saved indicator values are not result defaults.
          const bounds = unsignedBounds(terminal.xml);
          const output = compileLabviewCatalog({ schemaVersion: "bordeaux-labview-catalog/1", catalogId: "ni-output-preview",
            commands: [{ id, label, vi: "Handler.vi", parameters: [{ name: terminal.name, schema, ...bounds }] }] }).catalog.commands[0].parameters[0];
          outputs.push({ name: terminal.name, schema: output.schema, ...bounds, terminalNumber: terminal.terminalNumber,
            ...(terminal.caption.trim() && terminal.caption !== terminal.name ? { label: terminal.caption } : {}) });
        } catch (error) {
          unsupported.push({ file, target, reason: `Output ${terminal.name} (terminal ${terminal.terminalNumber}): ${error instanceof Error ? error.message : String(error)}` });
        }
      }
      // Status is a useful completed-command result, while Name/notifier remain framework plumbing.
      const completion = statuses.find((terminal) => terminal.direction === 1)!;
      const completionName = `${completion.name}.Status`;
      if (completionName.length > 256 || outputTerminals.some((terminal) => terminal.name === completionName)) {
        unsupported.push({ file, target, reason: `Output ${completionName}: completion result name is too long or conflicts with another terminal name` });
      } else outputs.push({ name: completionName, label: "Completion status", terminalNumber: completion.terminalNumber,
        fieldPath: [completion.name, "Status"], schema: { kind: "enum", valueType: "Enum", enumValues: ["Successful", "Aborted", "Incomplete"] } });
      const description = text(row.description, "NI VI description", 16384);
      commands.push({ ...checked, description, outputs, ownerType: `LabVIEW (${target})`, member: file,
        source: { file, line: 1 }, labviewLegacy: true, runtimeReady: false,
        labviewConnector: { labviewVersion: report.labviewVersion, applicationContext: "My Computer", target, file,
          terminalNumbers: numbers as number[], directions: directions as number[], requirements: requirements as number[],
          captions: captions as string[], typeXml: dataTypes as string[], extendedInfo: extended, defaults } });
    } catch (error) {
      unsupported.push({ file, target, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  commands.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  return { commands, cacheable, dependencyPaths: [...dependencyPaths].sort(), inspection: { status: "available", applicationContext: "My Computer", inspectedAt, commandCount: commands.length, unsupported,
    ...(!cacheable ? { liveOnly: true, reason: `Live inspection only; saved sources unconfirmed: ${[...cacheBlockers].join("; ")}.` } : {}) } };
}
