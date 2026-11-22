import { ROBOT_TARGETS, type RobotTargetId } from "./robotTargets";

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
