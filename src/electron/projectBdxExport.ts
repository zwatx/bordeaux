import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import type { ProjectLocation } from "../shared/project/desktopProjects";
import type { ProjectCheckpointSaveResult } from "../shared/project/projectPersistence";
import type { ProjectFolderIdentity } from "./projectFolderIdentity";
import { describeProjectWriteError } from "../shared/project/writeErrors";

export class ProjectBdxChangedError extends Error {}

export type ProjectBdxPhase = "admission" | "bindings" | "build" | "revalidate" | "write";
export type ProjectBdxFailureCode = "busy" | "limit" | "timed-out" | "changed" | "failed";
export interface ProjectBdxExportScope {
  operationId: string;
  folderPath: string;
  folderIdentity: ProjectFolderIdentity;
  expectedSourceDigest: string;
  signal: AbortSignal;
  assertCurrent(): void;
  enterPhase(phase: ProjectBdxPhase): void;
  markWriteStarted(): void;
}
export interface ProjectBdxLimits { overallMs?: number; phaseMs?: number; batchMs?: number; now?: () => number }
export const PROJECT_BDX_MAX_OUTSTANDING = 4;
export const projectBdxBudget = (count: number) => Math.min(300_000, Math.max(60_000, 30_000 + 2_000 * count));
export function projectBdxFailure(location: ProjectLocation, error: unknown, partial = false, code: ProjectBdxFailureCode = "failed", blockingExportId?: string): ProjectCheckpointSaveResult {
  const cause = describeProjectWriteError(error), outcome = partial ? "Some BDX files may have been updated." : "No BDX files were changed.";
  return { saved: true, location: { ...location }, exportError: `Project saved; BDX saving did not complete. ${outcome} ${cause}`,
    exportDetails: { cause, partial, code, ...(blockingExportId ? { blockingExportId } : {}) } };
}

/** One export's logical deadline and effect authority. Its owner separately retains physical work until settlement. */
export class ProjectBdxExport implements ProjectBdxExportScope {
  readonly operationId = randomUUID();
  readonly signal: AbortSignal;
  readonly result: Promise<ProjectCheckpointSaveResult>;
  readonly folderPath: string;
  private readonly controller = new AbortController();
  private readonly now: () => number;
  private readonly overallDeadline: number;
  private phaseDeadline: number;
  private timer?: ReturnType<typeof setTimeout>;
  private resolve!: (result: ProjectCheckpointSaveResult) => void;
  private valid = true;
  private logicalSettled = false;
  private writeStarted = false;
  constructor(readonly folderIdentity: ProjectFolderIdentity, readonly expectedSourceDigest: string, private readonly location: ProjectLocation,
    pathCount: number, private readonly isCurrent: () => boolean, private readonly limits: ProjectBdxLimits = {}) {
    for (const duration of [limits.overallMs, limits.phaseMs, limits.batchMs]) if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0)) throw new Error("BDX deadline is invalid");
    this.folderPath = folderIdentity.folderPath; this.signal = this.controller.signal;
    this.now = limits.now ?? (() => performance.now());
    this.overallDeadline = this.now() + (limits.overallMs ?? projectBdxBudget(pathCount));
    this.phaseDeadline = this.overallDeadline;
    this.result = new Promise(resolve => { this.resolve = resolve; });
    this.enterPhase("admission");
  }
  isRunning(): boolean { return this.valid && !this.logicalSettled; }
  private settle(result: ProjectCheckpointSaveResult): void {
    if (this.logicalSettled) return;
    this.logicalSettled = true; clearTimeout(this.timer); this.resolve(result);
  }
  fail(error: unknown, code: ProjectBdxFailureCode = error instanceof ProjectBdxChangedError ? "changed" : "failed"): void {
    if (this.logicalSettled) return;
    this.valid = false; this.controller.abort();
    this.settle(projectBdxFailure(this.location, error, this.writeStarted, code));
  }
  assertCurrent(): void {
    if (!this.valid || this.logicalSettled) throw new Error("BDX export is no longer current");
    if (this.now() >= Math.min(this.overallDeadline, this.phaseDeadline)) {
      const error = new Error("BDX export did not finish in time"); this.fail(error, "timed-out"); throw error;
    }
    if (!this.isCurrent()) { const error = new Error("Project or command definitions changed; save again to generate BDX files"); this.fail(error, "changed"); throw error; }
  }
  enterPhase(phase: ProjectBdxPhase): void {
    this.assertCurrent(); clearTimeout(this.timer);
    this.phaseDeadline = Math.min(this.overallDeadline, this.now() + (phase === "build" ? this.limits.batchMs ?? 120_000 : this.limits.phaseMs ?? 30_000));
    this.timer = setTimeout(() => this.fail(new Error("BDX export did not finish in time"), "timed-out"), Math.max(0, this.phaseDeadline - this.now()));
  }
  markWriteStarted(): void { this.assertCurrent(); this.writeStarted = true; }
  complete(result: ProjectCheckpointSaveResult): void {
    if (this.logicalSettled) return;
    try {
      this.assertCurrent();
      if (!("saved" in result)) throw new Error("BDX export was cancelled after the project source was saved");
      this.valid = false; this.settle({ ...result, location: { ...this.location } });
    } catch (error) { this.fail(error); }
  }
}
