import type { RobotCommandCatalog } from "../core/types";
import { inspectLabviewCommands, refreshLabviewCommands, withCachedLabviewCommands, withSessionLabviewCommands } from "./labviewNiInspection";

// NI automation shares one LabVIEW process. Serialize inspections even when a
// different project is selected before the previous request completes.
let inspectionTail: Promise<unknown> = Promise.resolve();
export function queueLabviewOperation<T>(operation: () => Promise<T>): Promise<T> {
  const pending = inspectionTail.catch(() => undefined).then(operation);
  inspectionTail = pending;
  return pending;
}
const pendingInspections = new Map<string, Promise<RobotCommandCatalog | null>>();
export function supportsLiveLabview(platform: string = process.platform): boolean {
  return platform === "win32" || platform === "darwin";
}
function coalesced<T extends RobotCommandCatalog | null>(kind: string, selection: string, cacheDirectory: string, run: () => Promise<T>): Promise<T> {
  const key = JSON.stringify([kind, process.platform === "win32" ? selection.toLowerCase() : selection, cacheDirectory]);
  const running = pendingInspections.get(key);
  if (running) return running as Promise<T>;
  const pending = queueLabviewOperation(run);
  pendingInspections.set(key, pending);
  void pending.finally(() => { if (pendingInspections.get(key) === pending) pendingInspections.delete(key); }).catch(() => undefined);
  return pending;
}
/** Read every candidate VI again (Rescan). */
export function inspectLabviewCommandsQueued(selection: string, cacheDirectory: string): Promise<RobotCommandCatalog> {
  return coalesced("all", selection, cacheDirectory, () => inspectLabviewCommands(selection, cacheDirectory));
}
/** Read only new or changed VIs; null when every definition is current. */
export function refreshLabviewCommandsQueued(selection: string, cacheDirectory: string): Promise<RobotCommandCatalog | null> {
  return coalesced("changed", selection, cacheDirectory, () => refreshLabviewCommands(selection, cacheDirectory));
}

/**
 * Link and Refresh: start from the last known definitions, then read whatever changed from LabVIEW. When LabVIEW
 * can't be reached the known commands stay usable; only a project with no definitions at all reports why.
 */
export async function syncLabviewCommands(selection: string, cacheDirectory: string, catalog: RobotCommandCatalog,
  dependencies: { platform: string; refresh: typeof refreshLabviewCommandsQueued; cached: typeof withCachedLabviewCommands; session?: typeof withSessionLabviewCommands } = {
    platform: process.platform, refresh: refreshLabviewCommandsQueued, cached: withCachedLabviewCommands, session: withSessionLabviewCommands },
): Promise<RobotCommandCatalog> {
  const known = await dependencies.session?.(selection, catalog) ?? await dependencies.cached(selection, catalog, cacheDirectory);
  if (!supportsLiveLabview(dependencies.platform)) return known;
  try {
    return await dependencies.refresh(selection, cacheDirectory) ?? known;
  } catch (error) {
    const fact = error instanceof Error ? error.message : String(error);
    const inspection = known.labviewDiscovery?.inspection;
    if (inspection && inspection.status !== "unavailable") {
      return { ...known, warnings: [...known.warnings, `Using the last known command definitions; LabVIEW could not be read. ${fact}`] };
    }
    const reason = dependencies.platform === "darwin" ? fact : `Bordeaux couldn’t read commands from LabVIEW. ${fact} Open this project in LabVIEW, then refresh commands.`;
    return {
      ...known,
      warnings: [...known.warnings, reason],
      ...(known.labviewDiscovery ? { labviewDiscovery: { ...known.labviewDiscovery, inspection: {
        status: "unavailable" as const,
        commandCount: known.commands.filter(command => command.labviewConnector).length,
        unsupported: inspection?.unsupported ?? [], reason,
      } } } : {}),
    };
  }
}
