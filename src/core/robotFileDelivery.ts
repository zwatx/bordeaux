import { ROBOT_TARGETS, type RobotTargetId } from "./robotTargets";
import type { FieldReference } from "./types";

/** SFTP file delivery confirms stored bytes, never robot activation or execution. */
export const DEFAULT_ROBOT_PATH_DIRECTORY = ROBOT_TARGETS.roborio.defaultDirectory;
/** `target` picks the SSH account and the folders `directory` may sit in. */
export interface RobotFileEndpoint { target: RobotTargetId; host: string; port: number; directory: string }
export interface RobotFileSettings { endpoint: RobotFileEndpoint; hostKeyFingerprint?: string }
/** What Connect or Save does with the SSH password: keep the one in effect, return to the default, or use a typed one. */
export type RobotPasswordChange = { kind: "keep" } | { kind: "default" } | { kind: "custom"; password: string };
/** Sent to the renderer instead of the password: whether a custom one is in effect and whether it survives a restart. */
export interface RobotPasswordStatus { custom: boolean; persistent: boolean }
export interface RobotFileConnection { endpoint: RobotFileEndpoint; hostKeyFingerprint: string }
export interface RobotFilePreview {
  operationId: string;
  connection: RobotFileConnection;
  files: Array<{ pathId: string; name: string; fileName: string; size: number; sha256: string }>;
}
export interface RobotFileResult {
  state: "transferred";
  files: RobotFilePreview["files"];
  directory: string;
  /** True only when this upload received confirmation that it created the destination. */
  directoryCreated: boolean;
}

export type RobotPathFact = [label: string, local: number | string, robot: number | string, unit?: "s" | "m" | "m/s"];
export interface RobotPathRoute {
  field: FieldReference;
  points: [x: number, y: number][];
  endHeading: number;
  width: number;
  length: number;
}
interface RobotPathEventVersion { name: string; time: number }
export interface RobotPathEventChange {
  id: string;
  local?: RobotPathEventVersion;
  robot?: RobotPathEventVersion;
  values: Array<[label: string, local: string, robot: string]>;
  notes: Array<[label: string, detail: string]>;
}
export interface RobotPathComparison {
  id: string;
  endpoint: RobotFileEndpoint;
  readAt: number;
  name: string;
  fileName: string;
  verdict: "same" | "different" | "missing" | "otherPath" | "robotUnreadable" | "localFailed" | "robotOnly";
  local?: { size: number; sha256: string };
  robot?: { size: number; sha256: string };
  localError?: string;
  robotError?: string;
  robotName?: string;
  expectedFileName?: string;
  robotOnly?: boolean;
  routes?: { local?: RobotPathRoute; robot?: RobotPathRoute };
  widestGap?: { local: [number, number]; robot: [number, number] };
  facts: RobotPathFact[];
  notes: string[];
  eventChanges?: { rows: RobotPathEventChange[]; omitted: number; unchanged?: number; orderChanged?: boolean };
}
export type RobotPathCopyResult = { canceled: true } | { name: string; folder: string; size: number };

export interface RobotPathFile { fileName: string; size: number; mtime: number }
export interface RobotPathFiles {
  files: RobotPathFile[];
  missing: boolean;
  truncated: boolean;
}
export interface RobotPathRow {
  fileName: string;
  name: string;
  kind: "paired" | "robotOnly" | "localOnly" | "conflict";
  pathId?: string;
  robot?: RobotPathFile;
  detail?: string;
}
export interface RobotPathInventory {
  endpoint: RobotFileEndpoint;
  listedAt: number;
  rows: RobotPathRow[];
  missing: boolean;
  truncated: boolean;
}
