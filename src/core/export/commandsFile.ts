/**
 * The LabVIEW command list a desktop Push sends to a SystemCore, beside the pushed paths.
 *
 * The desktop reads command types from LabVIEW; the robot has no LabVIEW inspection. With this file the robot app
 * can author command events and build the same BDX bytes the desktop would, because both use these bindings.
 */
import type { BinaryBindings } from "./robotBinary";
import { sha256Hex } from "../bytes";

export const COMMANDS_FILE_NAME = "bordeaux-commands.json";
const FORMAT = "bordeaux-commands/1";

export const isCommandsFile = (fileName: string) => fileName === COMMANDS_FILE_NAME;

/**
 * `sha256` covers the whole serialized bindings (catalog, parameter types and definitions), so an edit to any field the
 * BDX writer reads is caught, not only one to the hashed NI definitions.
 */
export function encodeCommandsFile(bindings: BinaryBindings): string {
  return `${JSON.stringify({ format: FORMAT, sha256: sha256Hex(JSON.stringify(bindings)), bindings })}\n`;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads a commands file, refusing one that is malformed or whose definitions do not match their recorded hash. */
export function decodeCommandsFile(contents: string): BinaryBindings {
  const value: unknown = JSON.parse(contents);
  if (!isObject(value) || value.format !== FORMAT || !isObject(value.bindings)) throw new Error(`${COMMANDS_FILE_NAME} is not a Bordeaux command list`);
  const { catalog, parameterTypes, definitionJson } = value.bindings;
  if (!isObject(catalog) || !Array.isArray(catalog.commands) || !isObject(parameterTypes) || typeof definitionJson !== "string") {
    throw new Error(`${COMMANDS_FILE_NAME} is missing its commands or types`);
  }
  const changed = new Error(`${COMMANDS_FILE_NAME} was changed after the desktop wrote it. Push from the desktop app again.`);
  // JSON.parse then JSON.stringify reproduces the desktop's serialization of plain JSON, so the hash is over the same text.
  if (typeof value.sha256 !== "string" || value.sha256 !== sha256Hex(JSON.stringify(value.bindings))) throw changed;
  if (catalog.catalogHash !== (catalog.catalogId ? sha256Hex(definitionJson) : "")) throw changed;
  // Shape and integrity are checked above; the desktop's bindingsFromCatalog produced the rest.
  return value.bindings as unknown as BinaryBindings;
}
