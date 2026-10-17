import type { BordeauxProject, PathConstraints, RobotConfig } from "../types";
import type { ProjectDurabilityContext } from "./projectDurability";
import type { ProjectSession } from "./projectPersistence";

export interface ProjectLocation {
  folderPath: string | null;
  projectPath: string | null;
  /** Source identity of an opened legacy file, independently of its nullable save target. */
  legacyFile?: string;
}

export interface OpenedProject {
  project: BordeauxProject;
  location: ProjectLocation;
  /** Captured by activation, never inferred from a later current-session read. */
  session?: ProjectSession;
}

export interface CreateNamedProjectRequest {
  name: string;
  parentDirectory: string;
  /** Explicit configuration only; paths, routines, commands and links are never imported. */
  template?: { robot: RobotConfig; constraints?: PathConstraints };
}

export type RecentProjectCode = "not-found" | "not-readable" | "unsafe-entry" | "size-limit" | "invalid-project";

export interface RecentProjectEntry {
  /** Identity of the normalized stored path, independent of recent-list order. */
  id: string;
  name: string;
  folderHint: string;
  location: ProjectLocation;
  status: "available" | "missing" | "invalid";
  code?: RecentProjectCode;
  detail?: string;
}

/** Show in Finder/Explorer: a recent by its stable id, or this window's own document by its exact context. */
export type RecentProjectRevealTarget = { id: string } | { current: ProjectDurabilityContext };

export interface ProjectCopyRequest { name: string; parentDirectory: string }
export interface ProjectCopyDefaultsRequest { context: ProjectDurabilityContext; nameHint?: string }
export interface ProjectCopyDefaults { name: string; parentDirectory: string }
