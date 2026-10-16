/** SFTP file delivery confirms stored bytes, never robot activation or execution. */
export const DEFAULT_ROBOT_PATH_DIRECTORY = "/home/lvuser/natinst/bin/Paths";
export interface RobotFileEndpoint { host: string; port: number; directory: string }
export interface RobotFileSettings { endpoint: RobotFileEndpoint; hostKeyFingerprint?: string }
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
