import type { BordeauxProject } from "../types";
import type { OpenedProject, ProjectLocation, RecentProjectEntry, ProjectCopyRequest } from "./desktopProjects";
import type { ProjectCheckpointUpdate, ProjectDurabilityContext, StoredProjectRecoveryReceipt } from "./projectDurability";

export type ProjectRecoveryOrigin =
  | { kind: "folder"; folderPath: string; projectPath?: string | null }
  | { kind: "legacy"; folderPath: string; legacyFile: string; projectPath?: string | null }
  | { kind: "untitled"; id: string };
/** A storage fact, never a departure permit or a request-backed receipt. */
export interface ProjectStorageReceipt {
  operationId: string;
  context: ProjectDurabilityContext;
  snapshotRevision: number;
  digest: string;
  capturedAt: string;
  completedAt: string;
  kind: "source" | "recovery";
  storedSnapshot?: StoredProjectRecoveryReceipt;
}
export interface ProjectRecoveredFrom { origin: ProjectRecoveryOrigin; capturedAt: string; receipt: StoredProjectRecoveryReceipt }
export interface ProjectSession {
  context: ProjectDurabilityContext;
  location: ProjectLocation;
  recoveryRecordId: string;
  lifecycleReady: boolean;
  recoveredFrom?: ProjectRecoveredFrom;
  latestSource?: ProjectStorageReceipt;
  latestRecovery?: ProjectStorageReceipt;
  /** Session-local exact source evidence, including authorized folder-name normalization. Never deletes storage. */
  sourceResolution?: { inputDigest: string; savedDigest: string; recoveries: StoredProjectRecoveryReceipt[] };
}
export interface ProjectResumeDescriptor { session: ProjectSession; pendingWrites: Array<{ operationId: string; folderPath: string; phase: "source" | "export" }> }
export interface ProjectCheckpointRequest {
  context: ProjectDurabilityContext;
  snapshotRevision: number;
  project: BordeauxProject;
  /** Only a main-issued active departure nonce admits request-backed receipts. */
  requestId?: string;
}
export interface ProjectBackgroundCheckpoint extends Omit<ProjectCheckpointUpdate, "requestId" | "sourceReceipt" | "recoveryReceipt"> {
  mode: "background";
  sourceReceipt?: ProjectStorageReceipt;
  recoveryReceipt?: ProjectStorageReceipt;
}
export type ProjectPersistenceUpdate = ProjectBackgroundCheckpoint | (ProjectCheckpointUpdate & { mode: "departure" });
export interface ProjectSaveCheckpointRequest extends ProjectCheckpointRequest { saveAs?: boolean; copyTo?: ProjectCopyRequest; transition?: ProjectTransitionToken }
export interface ProjectRecoverySummary {
  id: string;
  recordId: string | null;
  name: string;
  origin?: ProjectRecoveryOrigin;
  updatedAt?: string;
  available: boolean;
  resolved?: { at: string; sourceDigest: string };
  discardable?: boolean;
  receipt?: StoredProjectRecoveryReceipt;
  code?: string;
  fact?: string;
}
export interface ProjectRecoveryListOptions { includeResolved?: boolean }
export interface ProjectRecoveryDiscardConfirmation { token: string; id: string; name: string; updatedAt?: string }
export interface ProjectRecoveryListing { entries: ProjectRecoverySummary[]; limited: boolean; capacity?: { recordCount: number; recordLimit: number; bytes: number; byteLimit: number; full: boolean }; error?: { code: "storage-unavailable"; fact: string } }
export interface RestoredProjectRecovery extends OpenedProject { session: ProjectSession; recoveredFrom: ProjectRecoveredFrom; dirty: true }
export type ProjectCheckpointSaveResult = { canceled: true } | { saved: true; location: ProjectLocation; canonicalProject?: BordeauxProject; bdxCount?: number; exportError?: string;
  exportDetails?: { cause: string; partial: boolean; code?: "busy" | "limit" | "timed-out" | "changed" | "failed"; blockingExportId?: string } };
export interface ProjectTransitionToken { id: string; windowEpoch: string }
export interface ProjectStartupRequest { context: ProjectDurabilityContext; transition: ProjectTransitionToken }
export interface ProjectStartupDetachResult { session: ProjectSession; previous: ProjectResumeDescriptor | null }
export type ProjectStartupResult = {
  startupId: string; session: ProjectSession; recoveries: ProjectRecoveryListing; resuming: boolean;
} & ({ status: "opened"; opened: OpenedProject; needsAdoption: true }
  | { status: "none" }
  | { status: "unavailable"; reason: "missing" | "unreadable" | "invalid" | "recents-unavailable" | "source-busy"; recent: RecentProjectEntry | null; fact: string });

/** Reload carries a main-owned transition, never a departure receipt request. */
export interface ProjectReloadRequest extends ProjectCheckpointRequest { transition: ProjectTransitionToken }
export type ProjectKeptRecovery = ProjectStorageReceipt & { kind: "recovery"; storedSnapshot: StoredProjectRecoveryReceipt };
export type ProjectReloadFailureCode = "not-reloadable" | "busy" | "stale"
  | "recovery-capacity" | "recovery-timed-out" | "recovery-failed"
  | "source-missing" | "source-busy" | "folder-changed" | "read-timed-out" | "read-failed";
export type ProjectReloadResult =
  | { status: "reloaded"; opened: OpenedProject; session: ProjectSession; kept: ProjectKeptRecovery }
  | { status: "not-reloaded"; code: ProjectReloadFailureCode; fact: string; session: ProjectSession;
      kept?: ProjectKeptRecovery; recoveryCode?: string; recoveryFact?: string }
  | { status: "superseded"; fact: string };
export type ProjectRevealResult =
  | { revealed: true }
  | { revealed: false; code: "stale" | "not-available" | "invalid" | "missing" | "not-file" | "folder-changed" | "failed"; fact: string };
