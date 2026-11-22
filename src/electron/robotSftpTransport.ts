import type { RobotTargetUsername } from "../core/robotTargets";

/**
 * The SFTP session contract that robot file delivery runs on. robotSsh2Session implements it over ssh2;
 * tests substitute in-memory sessions. Only reviewed .bdx/.bdr files and their temporaries are addressable.
 */

export interface RobotEndpoint {
  host: string;
  port: number;
}

export type RobotRemoteFile =
  | { kind: "pathFile"; directory: string; fileName: string }
  | { kind: "pathTemporary"; directory: string; fileName: string; token: string };

export interface RobotSftpSession {
  readonly hostKeyFingerprint: string;
  /** created refers to the selected directory, not any missing ancestors. */
  ensureDirectory?(directory: string, create: boolean, signal: AbortSignal): Promise<{ created: boolean }>;
  read(file: RobotRemoteFile, maxBytes: number, signal: AbortSignal): Promise<Buffer>;
  write(file: RobotRemoteFile, contents: Buffer, signal: AbortSignal): Promise<void>;
  exists(file: RobotRemoteFile, signal: AbortSignal): Promise<boolean>;
  renameSameDirectory(from: RobotRemoteFile, to: RobotRemoteFile, signal: AbortSignal): Promise<void>;
  remove(file: RobotRemoteFile, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export interface RobotCredentials {
  /** The selected robot target's SSH account. */
  username: RobotTargetUsername;
  password: string;
}

export interface RobotConnectRequest {
  endpoint: RobotEndpoint;
  credentials: RobotCredentials;
  expectedHostKeyFingerprint?: string;
  signal: AbortSignal;
  timeoutMs: number;
}

export type RobotSftpSessionFactory = (request: RobotConnectRequest) => Promise<RobotSftpSession>;

export type RobotTransportErrorCode =
  | "invalid_request"
  | "auth_rejected"
  | "re_pair_required"
  | "unavailable"
  | "cancelled"
  | "timed_out"
  | "transfer_failed";

export class RobotTransportError extends Error {
  constructor(readonly code: RobotTransportErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RobotTransportError";
  }
}
