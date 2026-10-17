import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectLocation } from "../shared/project/desktopProjects";
import type { ProjectRevealResult } from "../shared/project/projectPersistence";
import { PROJECT_WORKSPACE_FILE } from "./projectFiles";
import { loadProjectSelection } from "./projectOpening";
import { recentProjectPathById } from "./recentProjectFiles";

export interface RecentRevealDependencies {
  /** The recent paths main knows now; read again before revealing. */
  recents(): Promise<readonly string[]>;
  /** Main's own open project while `context` is still exactly its document, else null. */
  current(context: unknown): ProjectLocation | null;
  /** Throws once the initiating window, document or transition has moved on. */
  assertWindowCurrent(): void;
  reveal(filename: string): void;
}

class Stale extends Error {}
type Failure = Extract<ProjectRevealResult, { revealed: false }>;
const no = (code: Failure["code"], fact: string): ProjectRevealResult => ({ revealed: false, code, fact });
// The same file kinds the recents listing opens; anything else stored is a folder.
const PROJECT_FILE = /\.(?:bordeaux|json|path|routine)$/i, LEGACY_FILE = /\.bordeaux(?:\.json)?$/i;
const isWorkspace = (place: string) => path.basename(place) === PROJECT_WORKSPACE_FILE;

// What Finder or Explorer selects: the project folder, or a legacy file itself. A symbolic link or special entry is
// never revealed, and the managed workspace file stands for its folder.
async function revealable(place: string, file: boolean): Promise<string | null> {
  const stat = await fs.lstat(place);
  if (stat.isSymbolicLink()) return null;
  if (stat.isDirectory()) return place;
  if (!stat.isFile() || !file) return null;
  return isWorkspace(place) ? revealable(path.dirname(place), false) : place;
}

/**
 * Show a Projects row in the file manager. Read-only: nothing is opened, written, or removed. The renderer names a row
 * only by its stable recent id, or this window's own document by its exact context, so a displayed path is never a
 * shell input; main resolves the place from its own state and checks that state again just before revealing.
 */
export async function revealRecentProject(target: unknown, deps: RecentRevealDependencies): Promise<ProjectRevealResult> {
  const request = target && typeof target === "object" ? target as { id?: unknown; current?: unknown } : {};
  const recent = typeof request.id === "string" && request.id.length <= 128 ? request.id : null;
  if (!recent && !("current" in request)) return no("invalid", "Couldn’t show project");
  const owned = () => { try { deps.assertWindowCurrent(); } catch { throw new Stale(); } };
  // The stored place, and whether it may be a file: a recent's project file, or the current document's own legacy file.
  const place = async (): Promise<[string, boolean]> => {
    owned();
    if (recent) {
      let stored: string;
      try { stored = recentProjectPathById(await deps.recents(), recent); } catch { throw new Stale(); }
      owned();
      return [stored, PROJECT_FILE.test(stored)];
    }
    const location = deps.current(request.current);
    if (!location?.folderPath) throw new Stale();
    const source = location.legacyFile || (location.projectPath && !isWorkspace(location.projectPath) ? location.projectPath : null);
    return source ? [source, true] : [location.folderPath, false];
  };
  try {
    const [stored, file] = await place();
    const shown = await revealable(stored, file).catch(async (error) => {
      // A migrated legacy file may be gone once its workspace exists; the listing shows that folder, so this does too.
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT" || !recent || !LEGACY_FILE.test(stored)) throw error;
      return revealable((await loadProjectSelection(stored, { recordOpened: false })).folderPath, false);
    });
    if (!shown) return no("invalid", "Couldn’t show project");
    if ((await place())[0] !== stored) throw new Stale();
    // Shell reveal is path based: a later external swap remains an OS/filesystem race.
    deps.reveal(shown);
    return { revealed: true };
  } catch (error) {
    if (error instanceof Stale) return no("stale", recent ? "No longer in the list" : "The project changed");
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return no("missing", "Project isn’t there anymore");
    return no("failed", "Couldn’t show project");
  }
}
