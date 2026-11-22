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

export function encodeCommandsFile(bindings: BinaryBindings): string {
  return `${JSON.stringify({ format: FORMAT, bindings })}\n`;
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
  const expected = catalog.catalogId ? sha256Hex(definitionJson) : "";
  if (catalog.catalogHash !== expected) throw new Error(`${COMMANDS_FILE_NAME} was changed after the desktop wrote it. Push from the desktop app again.`);
  // Shape and integrity are checked above; the desktop's bindingsFromCatalog produced the rest.
  return value.bindings as unknown as BinaryBindings;
}
