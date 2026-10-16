import type { RobotCommandCatalog } from "../shared/types";
import { inspectLabviewCommands, withCachedLabviewCommands } from "./labviewNiInspection";
import { discoverLabviewProject } from "./labviewProject";

// NI automation shares one LabVIEW process. Serialize inspections even when a
// different project is selected before the previous request completes.
let inspectionTail: Promise<unknown> = Promise.resolve();
export function inspectLabviewCommandsQueued(selection: string, cacheDirectory: string): Promise<RobotCommandCatalog> {
  const pending = inspectionTail.catch(() => undefined).then(() => inspectLabviewCommands(selection, cacheDirectory));
  inspectionTail = pending;
  return pending;
}

export async function syncLabviewCommands(selection: string, cacheDirectory: string, catalog: RobotCommandCatalog,
  dependencies = { platform: process.platform, inspect: inspectLabviewCommandsQueued, cached: withCachedLabviewCommands, discover: discoverLabviewProject },
): Promise<RobotCommandCatalog> {
  if (dependencies.platform !== "win32") return dependencies.cached(selection, catalog, cacheDirectory);
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
