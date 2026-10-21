import type { RobotCommandCatalog } from "../shared/types";
import { inspectLabviewCommands, withCachedLabviewCommands, withSessionLabviewCommands } from "./labviewNiInspection";
import { discoverLabviewProject } from "./labviewProject";

// NI automation shares one LabVIEW process. Serialize inspections even when a
// different project is selected before the previous request completes.
let inspectionTail: Promise<unknown> = Promise.resolve();
export function queueLabviewOperation<T>(operation: () => Promise<T>): Promise<T> {
  const pending = inspectionTail.catch(() => undefined).then(operation);
  inspectionTail = pending;
  return pending;
}
const pendingInspections = new Map<string, Promise<RobotCommandCatalog>>();
export function inspectLabviewCommandsQueued(selection: string, cacheDirectory: string): Promise<RobotCommandCatalog> {
  const key = JSON.stringify([process.platform === "win32" ? selection.toLowerCase() : selection, cacheDirectory]);
  const running = pendingInspections.get(key);
  if (running) return running;
  const pending = queueLabviewOperation(() => inspectLabviewCommands(selection, cacheDirectory));
  pendingInspections.set(key, pending);
  void pending.finally(() => { if (pendingInspections.get(key) === pending) pendingInspections.delete(key); }).catch(() => undefined);
  return pending;
}

export async function syncLabviewCommands(selection: string, cacheDirectory: string, catalog: RobotCommandCatalog,
  dependencies: { platform: string; inspect: typeof inspectLabviewCommandsQueued; cached: typeof withCachedLabviewCommands; discover: typeof discoverLabviewProject; session?: typeof withSessionLabviewCommands } = {
    platform: process.platform, inspect: inspectLabviewCommandsQueued, cached: withCachedLabviewCommands, discover: discoverLabviewProject, session: withSessionLabviewCommands },
): Promise<RobotCommandCatalog> {
  const session = await dependencies.session?.(selection, catalog);
  if (session) return session;
  if (dependencies.platform !== "win32") return dependencies.cached(selection, catalog, cacheDirectory);
  if (dependencies.session) {
    const saved = await dependencies.cached(selection, catalog, cacheDirectory);
    if (saved.labviewDiscovery?.inspection?.status === "cached") return saved;
  }
  try {
    return await dependencies.inspect(selection, cacheDirectory);
  } catch (error) {
    const current = await dependencies.discover(selection);
    const cached = await dependencies.cached(selection, current, cacheDirectory);
    const reason = `Command sync could not inspect LabVIEW. ${error instanceof Error ? error.message : String(error)} Open this project in LabVIEW, then choose Refresh commands to retry.`;
    return {
      ...cached,
      warnings: [...cached.warnings, reason],
      ...(cached.labviewDiscovery ? { labviewDiscovery: { ...cached.labviewDiscovery, inspection: {
        ...cached.labviewDiscovery.inspection,
        status: "unavailable" as const,
        commandCount: cached.commands.filter(command => command.labviewConnector).length,
        unsupported: cached.labviewDiscovery.inspection?.unsupported ?? [], reason,
      } } } : {}),
    };
  }
}
