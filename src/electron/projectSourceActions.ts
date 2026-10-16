import fs from "node:fs/promises";
import path from "node:path";
import type { OpenedProject } from "../shared/project/desktopProjects";
import type { ProjectDurabilityContext } from "../shared/project/projectDurability";
import type { ProjectKeptRecovery, ProjectReloadRequest, ProjectReloadResult, ProjectRevealResult } from "../shared/project/projectPersistence";
import { projectFolderIdentity, sameProjectFolder } from "./projectFolderIdentity";
import { loadProjectSelection, type ProjectSelection, type ProjectSelectionReadOptions } from "./projectOpening";
import { ProjectPersistence, ReloadStale } from "./projectPersistence";
import { ProjectSourceError, sameProjectContext } from "./projectSourcePersistence";

// A new Reload must not hold the modal indefinitely on an unresponsive filesystem.
// Expiry fences activation; it cannot cancel a filesystem read already in progress.
export const PROJECT_RELOAD_READ_MS = 8_000;
class ReloadReadTimedOut extends Error {}
export class ProjectActivationFolderChanged extends Error {}
interface ReloadDependencies {
  persistence: Pick<ProjectPersistence, "beginReload" | "getSession">;
  assertWindowCurrent(): void;
  assertReadable(selected: string, assertCurrent: () => void): Promise<string>;
  activate(selection: ProjectSelection, options: { rememberInBackground: boolean; assertCurrent(): void; committed(): void }): Promise<OpenedProject>;
  readSelection?: (selected: string, options: ProjectSelectionReadOptions) => Promise<ProjectSelection>;
  readTimeoutMs?: number;
}

/** One main-owned reload: keep the exact edits, read fresh authority, then commit. Never writes source. */
export async function reloadProjectSource(request: ProjectReloadRequest, deps: ReloadDependencies): Promise<ProjectReloadResult> {
  deps.assertWindowCurrent();
  const handle = deps.persistence.beginReload(request);
  if ("refused" in handle) return { status: "not-reloaded", code: handle.refused, fact: handle.fact, session: deps.persistence.getSession() };
  let kept: ProjectKeptRecovery | undefined, committed = false, readLive = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fail = (code: Extract<ProjectReloadResult, { status: "not-reloaded" }>["code"], fact: string): Extract<ProjectReloadResult, { status: "not-reloaded" }> =>
    ({ status: "not-reloaded", code, fact, session: deps.persistence.getSession(), ...(kept ? { kept } : {}) });
  try {
    const recovery = await handle.keep();
    if (recovery.status === "failed") return { ...fail(recovery.code, recovery.fact),
      ...(recovery.recoveryCode ? { recoveryCode: recovery.recoveryCode, recoveryFact: recovery.recoveryFact ?? recovery.fact } : {}) };
    kept = recovery.kept;
    const assertCurrent = () => {
      if (!readLive) throw new ReloadReadTimedOut();
      deps.assertWindowCurrent(); handle.assertCurrent();
    };
    const read = async (): Promise<ProjectReloadResult> => {
      assertCurrent();
      const physical = await deps.assertReadable(handle.selectionPath, assertCurrent);
      assertCurrent();
      const selection = await (deps.readSelection ?? loadProjectSelection)(physical, { assertCurrent, requireSource: true });
      assertCurrent();
      const identity = selection.sourceEvidence.identity;
      if (identity.objectKey !== handle.root.objectKey || !sameProjectFolder(identity, handle.root)) throw new ProjectActivationFolderChanged();
      const opened = await deps.activate(selection, { rememberInBackground: true, assertCurrent, committed: () => { committed = true; } });
      if (!opened.session || !sameProjectContext(opened.session.context, deps.persistence.getSession().context)) throw new ReloadStale();
      return { status: "reloaded", opened, session: opened.session, kept: recovery.kept };
    };
    return await Promise.race([read(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { readLive = false; reject(new ReloadReadTimedOut()); }, deps.readTimeoutMs ?? PROJECT_RELOAD_READ_MS);
    })]);
  } catch (error) {
    if (committed) return { status: "superseded", fact: "Another project is now active" };
    if (error instanceof ReloadReadTimedOut) return fail("read-timed-out", "Folder isn’t responding · try again");
    if (error instanceof ReloadStale) return fail("stale", "The project changed while reloading");
    if (error instanceof ProjectActivationFolderChanged) return fail("folder-changed", "Project folder changed. Reopen it or save a copy in a different folder.");
    if (error instanceof ProjectSourceError && error.code === "PROJECT_SOURCE_BUSY") return fail("source-busy", "The folder is busy · try again");
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return fail("source-missing", "The project source is no longer available");
    return fail("read-failed", error instanceof Error ? error.message : "Couldn’t reload the project");
  } finally { readLive = false; clearTimeout(timer); handle.release(); }
}

interface RevealDependencies {
  persistence: Pick<ProjectPersistence, "sourceRoot" | "getSession">;
  assertWindowCurrent(): void;
  reveal(file: string): void;
}
class RevealFolderChanged extends Error {}
const managedDocument = /^(Paths\/[^/\\]+\.path|Routines\/[^/\\]+\.routine)$/;

/** The renderer supplies a managed relative name, never an arbitrary reveal path. */
export async function revealProjectSource(context: ProjectDurabilityContext, file: string, deps: RevealDependencies): Promise<ProjectRevealResult> {
  const no = (code: Extract<ProjectRevealResult, { revealed: false }>["code"], fact: string): ProjectRevealResult => ({ revealed: false, code, fact });
  if (!sameProjectContext(context, deps.persistence.getSession().context)) return no("stale", "The project changed");
  if (typeof file !== "string" || file.length > 512 || file.includes("\0") || !managedDocument.test(file)) return no("invalid", "Couldn’t show file");
  const root = deps.persistence.sourceRoot(context);
  if (!root) return no("not-available", "Couldn’t show file");
  const current = () => {
    deps.assertWindowCurrent();
    const admitted = deps.persistence.sourceRoot(context);
    if (!sameProjectContext(context, deps.persistence.getSession().context) || !admitted || admitted.objectKey !== root.objectKey || !sameProjectFolder(admitted, root)) throw new ReloadStale();
  };
  const verifyRoot = async () => {
    const physical = await projectFolderIdentity(root.folderPath, { assertCurrent: current });
    if (physical.objectKey !== root.objectKey || !sameProjectFolder(physical, root)) throw new RevealFolderChanged();
    return physical;
  };
  try {
    current();
    const physical = await verifyRoot(), [directory, name] = file.split("/");
    const parent = path.join(physical.folderPath, directory), target = path.join(parent, name);
    const parentStat = await fs.lstat(parent); current();
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) return no("invalid", "Couldn’t show file");
    const realParent = await fs.realpath(parent); current();
    if (realParent !== parent) return no("invalid", "Couldn’t show file");
    const stat = await fs.lstat(target); current();
    if (!stat.isFile() || stat.isSymbolicLink()) return no("not-file", "Couldn’t show file");
    await verifyRoot();
    const finalParent = await fs.lstat(parent); current();
    if (!finalParent.isDirectory() || finalParent.isSymbolicLink() || finalParent.dev !== parentStat.dev || finalParent.ino !== parentStat.ino) return no("invalid", "Couldn’t show file");
    // Shell reveal is path based: a later external swap remains an OS/filesystem race.
    deps.reveal(target);
    return { revealed: true };
  } catch (error) {
    if (error instanceof ReloadStale) return no("stale", "The project changed");
    if (error instanceof RevealFolderChanged) return no("folder-changed", "Project folder changed");
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return no("missing", "File isn’t there anymore");
    return no("failed", "Couldn’t show file");
  }
}
