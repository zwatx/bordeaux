import { createHash } from "node:crypto";
import type { RobotCommandCatalog } from "../shared/types";
import type { BinaryBindings, BdxParameterType } from "../shared/export/robotBinary";
import { discoverLabviewProject } from "./labviewProject";
import { withActiveLabviewCommands, withCachedLabviewCommands } from "./labviewNiInspection";
import { parseLabviewXml } from "./labviewProjectDiscovery";

/** Inspected NI type evidence describes bytes only. It never certifies robot execution. */
export function bdxBindingsFromCatalog(catalog: RobotCommandCatalog | null): BinaryBindings {
  const types: BinaryBindings["parameterTypes"] = Object.create(null);
  const definitions = (catalog?.commands ?? []).filter((command) => command.labviewConnector).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((command) => {
    const raw = command.labviewConnector!;
    const parameters: Record<string, BdxParameterType> = Object.create(null);
    const inputs = raw.typeXml.flatMap((xml, index) => {
      if (raw.directions[index] !== 0) return [];
      const root = parseLabviewXml(xml);
      return [{ name: root.elementValueOrEmpty("Name"), root }];
    });
    for (const parameter of command.parameters.filter((item) => item.role === "argument")) {
      const matches = inputs.filter((input) => input.name === parameter.name);
      if (matches.length !== 1) throw new Error(`NI parameter ${command.label}.${parameter.name} has ambiguous or missing saved type evidence`);
      const root = matches[0].root;
      parameters[parameter.name] = { niType: root.name, ...( ["EB", "EW", "EL"].includes(root.name) ? { choices: root.getElements("Choice").map((choice) => choice.value) } : {}) };
    }
    types[command.id] = parameters;
    return { id: command.id, target: raw.target, file: raw.file, parameters: command.parameters.filter((item) => item.role === "argument").map((parameter) => ({ name: parameter.name, type: parameters[parameter.name], schema: parameter.schema, required: parameter.defaultValue === undefined, defaultValue: parameter.defaultValue })) };
  });
  // Preserve the inspected type hash as authoring provenance. The binary writer supplies
  // the dynamic wrapper protocol identity separately; no generated resolver is required.
  // Absolute inspection-machine paths, timestamps and execution claims are deliberately absent.
  const definitionBytes = Buffer.from(JSON.stringify({ schema: "bordeaux-ni-command-types/1", commands: definitions }));
  const catalogId = definitions.length ? "bordeaux-ni-command-types/1" : "";
  const catalogHash = definitions.length ? createHash("sha256").update(definitionBytes).digest("hex") : "";
  return { catalog: { ...(catalog ?? { projectName: "", sourceFileCount: 0, scannedAt: "", warnings: [], commands: [] }),
    runtime: "labview", catalogId, catalogHash, generatedSchemaVersion: "1.3" }, parameterTypes: types,
    definitionJson: definitionBytes.toString("utf8") };
}

export async function prepareBdxBindings(options: { projectFile: string | null; inspectionCacheDirectory: string; activeCatalog?: RobotCommandCatalog | null }): Promise<BinaryBindings> {
  if (!options.projectFile) return bdxBindingsFromCatalog(null);
  const discovered = await discoverLabviewProject(options.projectFile);
  const active = await withActiveLabviewCommands(options.projectFile, discovered, options.activeCatalog);
  return bdxBindingsFromCatalog(active ?? await withCachedLabviewCommands(options.projectFile, discovered, options.inspectionCacheDirectory));
}
