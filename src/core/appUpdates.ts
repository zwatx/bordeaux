export type AppUpdateChannel = "beta" | "latest";
export interface AppUpdateProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}
export interface AppUpdateState {
  phase: "idle" | "checking" | "available" | "downloading" | "downloaded" | "installing" | "upToDate" | "error" | "unsupported";
  installStalled?: boolean;
  /** Main-owned attempt identity; a stalled panel may release only its own approval. */
  installAttemptId?: string;
  currentVersion: string;
  version: string | null;
  releaseNotes: string;
  progress: AppUpdateProgress | null;
  error: string | null;
  errorDetails: string | null;
  errorStage: "check" | "download" | "install" | null;
  projectDirty: boolean;
  channel: AppUpdateChannel;
  visible: boolean;
}
