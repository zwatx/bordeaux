import type { BordeauxProject } from "../types";
import type { ProjectLocation } from "./desktopProjects";

export interface ProjectDurabilityContext {
  windowEpoch: string;
  documentSessionId: string;
  targetGeneration: number;
}
export type ProjectDepartureReason = "close" | "quit" | "reload" | "reload-ignoring-cache" | "update";
export interface ProjectUpdateDeparture {
  attemptId: string;
  continuation: "start-install" | "finish-handoff";
}
export interface ProjectDepartureIntent {
  intentId: string;
  reason: ProjectDepartureReason;
  update?: ProjectUpdateDeparture;
}
export interface ProjectDepartureRequest extends ProjectDepartureIntent {
  requestId: string;
  context: ProjectDurabilityContext;
}
export interface StoredProjectRecoveryReceipt {
  recordId: string;
  revision: number;
  digest: string;
}
export interface ProjectDurabilityReceipt {
  receiptId: string;
  requestId: string;
  operationId: string;
  context: ProjectDurabilityContext;
  snapshotRevision: number;
  digest: string;
  kind: "source" | "recovery";
  capturedAt: string;
  completedAt: string;
  storedSnapshot?: StoredProjectRecoveryReceipt;
}
/** A main-owned refusal fact for display and remedies; never write or departure authority. */
export interface ProjectSourceChange { scope: "workspace" | "document"; file?: string }
export interface ProjectCheckpointUpdate {
  requestId: string;
  operationId: string;
  context: ProjectDurabilityContext;
  snapshotRevision: number;
  recovery: "pending" | "saved" | "failed";
  recoveryReceipt?: ProjectDurabilityReceipt;
  source: "pending" | "saved" | "unavailable" | "failed" | "timed-out";
  sourceReceipt?: ProjectDurabilityReceipt;
  sourceFact?: string;
  sourceChange?: ProjectSourceChange;
  recoveryFact?: string;
  /** Structured storage failure; never source/departure authority. */
  recoveryCode?: string;
  location?: ProjectLocation;
  canonicalProject?: BordeauxProject;
}
export type ProjectDepartureResponse = {
  requestId: string;
  context: ProjectDurabilityContext;
} & (
  | { outcome: "draining" | "choosing" | "cancelled" | "invalid-input" | "composing" }
  | { outcome: "busy"; transitionId: string }
  | { outcome: "saved" | "recovery"; receiptId: string; operationId: string; snapshotRevision: number }
  | { outcome: "discard"; confirmed: true }
);
export interface ProjectDepartureResume {
  intentId: string;
  blockedRequestId: string;
  transitionId: string;
  windowEpoch: string;
}
export type ProjectDeparturePhase = "idle" | "requesting" | "draining" | "choosing" | "waiting-transition" | "native-fallback" | "approved" | "retired";
export interface ProjectDeparturePermit {
  permitId: string;
  request: ProjectDepartureRequest;
  basis: "source" | "recovery" | "discard" | "unacknowledged";
  receipt?: ProjectDurabilityReceipt;
}
export interface ProjectDepartureFallback {
  fallbackId: string;
  request: ProjectDepartureRequest;
  cause: "no-response" | "unresponsive" | "renderer-gone" | "busy-timeout";
}
export type ProjectDepartureNativeEvent = "before-quit" | "window-close" | "will-quit" | "reload";
