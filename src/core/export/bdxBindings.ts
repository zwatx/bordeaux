import type { RobotCommandCatalog, RobotCommandParameter } from "../types";
import type { BdxParameterType, BinaryBindings } from "./robotBinary";
import { sha256Hex, utf8Bytes, utf8Text } from "../bytes";

/** One command's saved NI connector types, as read from LabVIEW by the desktop host. */
export interface BdxCommandDefinition {
  id: string;
  target: string;
  file: string;
  parameters: Array<{ name: string; type: BdxParameterType; schema: RobotCommandParameter["schema"]; required: boolean; defaultValue: unknown }>;
}

/**
 * Binary bindings from already-inspected command types. With no definitions this is the binding every host can
 * build, which exports paths that use no commands.
 * Inspected NI type evidence describes bytes only. It never certifies robot execution.
 */
export function bdxBindingsFromDefinitions(catalog: RobotCommandCatalog | null, definitions: BdxCommandDefinition[], parameterTypes: BinaryBindings["parameterTypes"]): BinaryBindings {
  // Preserve the inspected type hash as authoring provenance. The binary writer supplies
  // the dynamic wrapper protocol identity separately; no generated resolver is required.
  // Absolute inspection-machine paths, timestamps and execution claims are deliberately absent.
  const definitionBytes = utf8Bytes(JSON.stringify({ schema: "bordeaux-ni-command-types/1", commands: definitions }));
  const catalogId = definitions.length ? "bordeaux-ni-command-types/1" : "";
  const catalogHash = definitions.length ? sha256Hex(definitionBytes) : "";
  return { catalog: { ...(catalog ?? { projectName: "", sourceFileCount: 0, scannedAt: "", warnings: [], commands: [] }),
    runtime: "labview", catalogId, catalogHash, generatedSchemaVersion: "1.3" }, parameterTypes,
    definitionJson: utf8Text(definitionBytes) };
}
