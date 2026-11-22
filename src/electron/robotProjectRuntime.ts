import type { RobotCommandCatalog } from "../core/types";
import { discoverLabviewProject, isLabviewProject } from "./labviewProject";

export type RobotProjectRuntime = "labview";

/** Discover project files without running robot code or requiring installed support. */
export async function availableRobotProjectRuntimes(root: string): Promise<RobotProjectRuntime[]> {
  return await isLabviewProject(root) ? ["labview"] : [];
}

export async function discoverRobotProject(root: string, runtime: RobotProjectRuntime = "labview"): Promise<RobotCommandCatalog> {
  if (runtime !== "labview") throw new Error("Select a LabVIEW project");
  return { ...await discoverLabviewProject(root), runtime: "labview" };
}
