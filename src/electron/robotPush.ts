import type { RobotDeploymentSummary } from "../core/export/robotDeployment";
import type {
  RobotActivationExpectation,
  RobotActivationRejectionBoundary,
  RobotActivationResult,
  RobotCredentials,
  RobotPairing,
  RobotRuntimeStatus,
} from "./robotSftpTransport";

export interface RobotPushPreview {
  operationId: string;
  summary?: RobotDeploymentSummary;
  adoptionRequired?: boolean;
  baselineRevision?: string | null;
  receiptWarning?: string;
  state: "review";
  robot: string;
  project: string;
  catalog: string;
  revision: string;
  payloadHash: string;
  size: number;
  transport: "SFTP over SSH";
}

export type RobotPushProgress =
  | { operationId: string; state: "uploaded" | "staged" }
  | { operationId: string; state: "active" }
  | { operationId: string; state: "rejected"; boundary: RobotActivationRejectionBoundary; message: string };

export type RobotPushResult =
  | { operationId: string; state: "active"; acknowledgement: Extract<RobotActivationResult, { state: "active" }>["acknowledgement"] }
  | { operationId: string; state: "rejected"; boundary: RobotActivationRejectionBoundary; message: string }
  | { operationId: string; state: "staged"; boundary: "acknowledgement"; message: string };

export interface RobotPushTransport {
  inspect(pairing: RobotPairing, credentials: RobotCredentials, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<RobotRuntimeStatus>;
  stageRevision(
    pairing: RobotPairing,
    credentials: RobotCredentials,
    revision: { nonce: string; contents: Buffer; sha256: string },
    options: { signal?: AbortSignal; timeoutMs?: number; onState?: (state: "uploaded" | "staged") => void },
  ): Promise<{ state: "staged"; nonce: string; sha256: string; size: number }>;
  waitForActivation(
    pairing: RobotPairing,
    credentials: RobotCredentials,
    expected: RobotActivationExpectation,
    options?: { signal?: AbortSignal; timeoutMs?: number; pollIntervalMs?: number },
  ): Promise<RobotActivationResult>;
}
