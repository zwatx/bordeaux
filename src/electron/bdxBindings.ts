import type { RobotCommandCatalog } from "../core/types";
import type { BinaryBindings, BdxParameterType } from "../core/export/robotBinary";
import { bdxBindingsFromDefinitions, type BdxCommandDefinition } from "../core/export/bdxBindings";
import { discoverLabviewProject } from "./labviewProject";
import { labviewCommandSourceChanges, withLastKnownLabviewCommands } from "./labviewNiInspection";
import { parseLabviewXml } from "./labviewProjectDiscovery";

/** Reads each command's saved NI connector types, then assembles bindings in core. */
export function bdxBindingsFromCatalog(catalog: RobotCommandCatalog | null): BinaryBindings {
  const types: BinaryBindings["parameterTypes"] = Object.create(null);
  const definitions: BdxCommandDefinition[] = (catalog?.commands ?? []).filter((command) => command.labviewConnector).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((command) => {
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
  return bdxBindingsFromDefinitions(catalog, definitions, types);
}

/**
 * The used commands' definitions, plus any command sharing a used VI's basename (the robot dispatches by basename,
 * so a new same-named VI makes the file ambiguous). An unrelated command's edit never invalidates a review.
 */
export function usedCommandEvidence(bindings: BinaryBindings, commandIds: Iterable<string>): string {
  const ids = new Set(commandIds), commands = bindings.catalog?.commands ?? [];
  const basename = (file: string | undefined) => file ? file.replaceAll("\\", "/").split("/").pop()!.toLowerCase() : null;
  const names = new Set(commands.filter((command) => ids.has(command.id)).map((command) => basename(command.labviewConnector?.file)).filter(Boolean));
  return JSON.stringify(commands.filter((command) => ids.has(command.id) || names.has(basename(command.labviewConnector?.file)))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    .map((command) => ({ id: command.id, parameters: command.parameters, outputs: command.outputs, connector: command.labviewConnector })));
}

function missingCommands(commands: RobotCommandCatalog["commands"]): string {
  const names = commands.map((command) => `${command.label} (${command.labviewConnector?.file ?? command.member})`);
  return `${names.join(", ")} ${names.length === 1 ? "is" : "are"} no longer in the LabVIEW project. Choose another command or restore the VI.`;
}

function changedCommands(commands: RobotCommandCatalog["commands"]): string {
  const names = commands.map((command) => command.label);
  return `${names.join(", ")} changed in LabVIEW since Bordeaux last read ${names.length === 1 ? "it" : "them"}. `
    + "Open the robot project in LabVIEW on Windows so Bordeaux can read the new inputs, then try again.";
}

/**
 * Bindings for an export. Uses the last known command definitions and checks only the VIs of `commandIds`:
 * a VI that no longer exists, or one that changed and can't be read again through `refresh` (LabVIEW closed), stops
 * the export with its name, since enum orders and saved defaults may have changed. Other project edits are irrelevant.
 */
export async function prepareBdxBindings(options: { projectFile: string | null; inspectionCacheDirectory: string; activeCatalog?: RobotCommandCatalog | null;
  commandIds?: Iterable<string>; refresh?: () => Promise<RobotCommandCatalog | null> }): Promise<BinaryBindings> {
  if (!options.projectFile) return bdxBindingsFromCatalog(null);
  const discovered = await discoverLabviewProject(options.projectFile);
  const ids = [...(options.commandIds ?? [])];
  let catalog = await withLastKnownLabviewCommands(options.projectFile, discovered, options.inspectionCacheDirectory, options.activeCatalog);
  let changes = await labviewCommandSourceChanges(options.projectFile, catalog, ids);
  if (changes.changed.length && options.refresh) {
    // Null means LabVIEW couldn't be read or another read already finished; the newest evidence decides either way.
    const fresh = await options.refresh().catch(() => null);
    catalog = await withLastKnownLabviewCommands(options.projectFile, discovered, options.inspectionCacheDirectory, fresh ?? options.activeCatalog);
    changes = await labviewCommandSourceChanges(options.projectFile, catalog, ids);
  }
  if (changes.missing.length) throw new Error(missingCommands(changes.missing));
  if (changes.changed.length) throw new Error(changedCommands(changes.changed));
  return bdxBindingsFromCatalog(catalog);
}

/**
 * Bindings for the command list a SystemCore keeps: every inspected command whose saved VI still matches what Bordeaux
 * read. A changed VI is read again once through `refresh` (LabVIEW open); any command still changed or missing is left
 * out and named, so the robot can never build a command event from stale types, and edits to commands a push doesn't
 * use never block it.
 */
export async function prepareCommandListBindings(options: { projectFile: string; inspectionCacheDirectory: string; activeCatalog?: RobotCommandCatalog | null;
  refresh?: () => Promise<RobotCommandCatalog | null> }): Promise<{ bindings: BinaryBindings; omitted: string[] }> {
  const discovered = await discoverLabviewProject(options.projectFile);
  let catalog = await withLastKnownLabviewCommands(options.projectFile, discovered, options.inspectionCacheDirectory, options.activeCatalog);
  const inspected = () => catalog.commands.filter((command) => command.labviewConnector).map((command) => command.id);
  let changes = await labviewCommandSourceChanges(options.projectFile, catalog, inspected());
  if (changes.changed.length && options.refresh) {
    const fresh = await options.refresh().catch(() => null);
    catalog = await withLastKnownLabviewCommands(options.projectFile, discovered, options.inspectionCacheDirectory, fresh ?? options.activeCatalog);
    changes = await labviewCommandSourceChanges(options.projectFile, catalog, inspected());
  }
  const stale = [...changes.changed, ...changes.missing];
  const left = new Set(stale.map((command) => command.id));
  return { bindings: bdxBindingsFromCatalog({ ...catalog, commands: catalog.commands.filter((command) => !left.has(command.id)) }),
    omitted: stale.map((command) => command.label) };
}

/** What a reviewed command list promises the robot: its definitions and command descriptions, without discovery details
 * (scan times, file listings) that differ on every read. A push confirms the list only if this is unchanged. */
export function commandListEvidence(bindings: BinaryBindings): string {
  return bindings.definitionJson + "\n" + JSON.stringify(bindings.catalog?.commands ?? []);
}
