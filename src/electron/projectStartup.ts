import { randomUUID } from "node:crypto";
import path from "node:path";
import type { OpenedProject } from "../shared/project/desktopProjects";
import type { ProjectSession, ProjectStartupRequest, ProjectStartupResult, ProjectStartupDetachResult, ProjectRecoveryListing, ProjectResumeDescriptor, ProjectTransitionToken } from "../shared/project/projectPersistence";
import { loadProjectSelection } from "./projectOpening";
import { listRecentProjects, recentProjectId } from "./recentProjectFiles";
import { sameProjectContext, ProjectSourceError } from "./projectSourcePersistence";

export const PROJECT_STARTUP_READ_TIMEOUT_MS = 10_000;
interface Dependencies {
  getSession(): ProjectSession;
  isTransitionCurrent(token: ProjectTransitionToken): boolean;
  readRecents(): Promise<readonly string[]>;
  getResume(): ProjectResumeDescriptor | null;
  listRecoveries(): Promise<ProjectRecoveryListing>;
  assertReadable(selected: string): Promise<string | void>;
  activate(selected: string, assertCurrent: () => void, committed: () => void): Promise<OpenedProject>;
  timeoutMs?: number;
}
interface Pending { id: string; request: ProjectStartupRequest; valid: boolean; committed: boolean; selected?: string; reject?: (error: Error) => void }
/** One bounded startup probe/adoption slot. Reads never activate unless its live owner explicitly adopts. */
export class ProjectStartup {
  private pending: Pending | null = null;
  constructor(private readonly deps: Dependencies) {}
  private assertCurrent(pending: Pending, beforeCommit = true): void {
    if (!pending.valid || this.pending !== pending || !this.deps.isTransitionCurrent(pending.request.transition)
      || (beforeCommit && !sameProjectContext(pending.request.context, this.deps.getSession().context))) throw new Error("Project startup is no longer current");
  }
  private async bounded<T>(pending: Pending, action: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
      if (pending.committed) return;
      pending.valid = false; reject(new Error("Checking the project did not finish in time"));
    }, this.deps.timeoutMs ?? PROJECT_STARTUP_READ_TIMEOUT_MS); pending.reject = reject; });
    try { return await Promise.race([action(), expired]); } finally { clearTimeout(timer); pending.reject = undefined; }
  }
  isCommitted(token: ProjectTransitionToken): boolean { return Boolean(this.pending?.committed && this.pending.request.transition.id === token?.id && this.pending.request.transition.windowEpoch === token?.windowEpoch); }
  cancel(token: ProjectTransitionToken): { cancelled: boolean; busy?: boolean } {
    const pending = this.pending;
    if (!pending || pending.request.transition.id !== token?.id || pending.request.transition.windowEpoch !== token?.windowEpoch) return { cancelled: false };
    if (pending.committed) return { cancelled: false, busy: true };
    pending.valid = false; this.pending = null; pending.reject?.(new Error("Project startup was cancelled")); return { cancelled: true };
  }
  /** Blank adoption is an explicit guarded transition; it never changes the readonly probe or ends its token. */
  detach(request: ProjectStartupRequest, commit: () => ProjectStartupDetachResult): ProjectStartupDetachResult {
    if (!request?.context || !request.transition || !sameProjectContext(request.context, this.deps.getSession().context)
      || !this.deps.isTransitionCurrent(request.transition)) throw new Error("Project startup owner is no longer current");
    if (this.isCommitted(request.transition)) throw new Error("The startup source was already committed; finish adopting it before continuing");
    if (this.pending && this.pending.request.transition.id !== request.transition.id) throw new Error("Another startup owner is pending");
    this.cancel(request.transition);
    return commit();
  }
  async probe(request: ProjectStartupRequest): Promise<ProjectStartupResult> {
    if (!request?.context || !request.transition || !sameProjectContext(request.context, this.deps.getSession().context) || !this.deps.isTransitionCurrent(request.transition)) throw new Error("Project startup owner is invalid");
    if (this.pending?.valid) throw new Error("A project startup check is already pending");
    const pending: Pending = { id: randomUUID(), request: structuredClone(request), valid: true, committed: false }; this.pending = pending;
    return this.bounded(pending, async () => {
      let recoveries: ProjectRecoveryListing;
      try { recoveries = await this.deps.listRecoveries(); }
      catch { recoveries = { entries: [], limited: false, error: { code: "storage-unavailable", fact: "Recovery storage is unavailable" } }; }
      this.assertCurrent(pending);
      const resume = this.deps.getResume(), common = { startupId: pending.id, session: this.deps.getSession(), recoveries, resuming: Boolean(resume) };
      let recentPaths: readonly string[] = [];
      if (!resume) {
        try { recentPaths = await this.deps.readRecents(); }
        catch { this.assertCurrent(pending); return { ...common, status: "unavailable", reason: "recents-unavailable", recent: null, fact: "Couldn’t check recent projects" }; }
      }
      this.assertCurrent(pending);
      const source = resume?.session.location, selected = resume ? source?.legacyFile || source?.projectPath || source?.folderPath : recentPaths[0];
      if (!selected) return { ...common, status: "none" };
      const recent = { id: recentProjectId(selected), name: path.basename(selected), folderHint: path.dirname(selected), location: source ?? { folderPath: path.dirname(selected), projectPath: selected }, status: "invalid" as const };
      try {
        const physicalSource = await this.deps.assertReadable(selected); this.assertCurrent(pending);
        const [listed] = await listRecentProjects([physicalSource ?? selected]);
        const entry = { ...listed, id: recent.id };
        this.assertCurrent(pending);
        if (entry.status !== "available") return { ...common, status: "unavailable", reason: entry.status === "missing" ? "missing" : entry.code === "not-readable" ? "unreadable" : "invalid", recent: entry, fact: entry.detail ?? "The last project could not be opened" };
        const selection = await loadProjectSelection(physicalSource ?? selected, { recordOpened: false, requireSource: true }); this.assertCurrent(pending);
        if (!selection.projectPath && !selection.legacyFile) return { ...common, status: "unavailable", reason: "invalid", recent: { ...entry, status: "invalid", code: "invalid-project" }, fact: "The last folder has no project source" };
        pending.selected = selected;
        return { ...common, status: "opened", needsAdoption: true, opened: { project: selection.project, location: { folderPath: selection.folderPath, projectPath: selection.projectPath, ...(selection.legacyFile ? { legacyFile: selection.legacyFile } : {}) } } };
      } catch (error) {
        this.assertCurrent(pending);
        const code = (error as NodeJS.ErrnoException)?.code;
        const busy = error instanceof ProjectSourceError && error.code === "PROJECT_SOURCE_BUSY";
        const missing = code === "ENOENT" || code === "ENOTDIR", unreadable = code === "EACCES" || code === "EPERM";
        const fact = busy ? "Folder is busy" : missing ? "Project is no longer available" : unreadable ? "Project cannot be read" : "The last project could not be opened";
        return { ...common, status: "unavailable", reason: busy ? "source-busy" : missing ? "missing" : unreadable ? "unreadable" : "invalid",
          recent: { ...recent, status: missing ? "missing" : "invalid", code: missing ? "not-found" : busy || unreadable ? "not-readable" : "invalid-project", detail: fact }, fact };
      }
    });
  }
  async adopt(startupId: string, transition: ProjectTransitionToken): Promise<OpenedProject & { session: ProjectSession }> {
    const pending = this.pending;
    if (!pending || pending.id !== startupId || pending.request.transition.id !== transition?.id || !pending.selected) throw new Error("Project startup is no longer current");
    this.assertCurrent(pending);
    try {
      const opened = await this.bounded(pending, () => this.deps.activate(pending.selected!, () => this.assertCurrent(pending), () => {
        this.assertCurrent(pending); pending.committed = true;
      }));
      this.assertCurrent(pending, false);
      if (!opened.session || !sameProjectContext(opened.session.context, this.deps.getSession().context)) throw new Error("Project activation is no longer current");
      return { ...opened, session: opened.session };
    } finally { if (this.pending === pending) this.pending = null; }
  }
}
