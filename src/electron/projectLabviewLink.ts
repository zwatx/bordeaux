import fs from "node:fs/promises";
import path from "node:path";
import type { BordeauxProject, ProjectEditorState } from "../shared/types";
import { normalizeLabviewProjectPath } from "../shared/project/labviewLink";
import { resolveLabviewProject, statLabviewLocalPath } from "./labviewProjectDiscovery";

export function relativeLabviewLink(folder: string, projectFile: string): string | null {
  try { return normalizeLabviewProjectPath(path.relative(folder, projectFile)); }
  catch { return null; } // Different Windows drives cannot form a portable link.
}

export function labviewLinkTarget(folder: string | null, editor?: ProjectEditorState): string | null {
  if (!folder || editor?.labviewProjectPath == null) return null;
  return path.resolve(folder, normalizeLabviewProjectPath(editor.labviewProjectPath));
}

/** Portable selection wins, including its explicit missing state. No fallback to an unrelated bookmark. */
export function labviewLinkMatches(editor: ProjectEditorState | undefined, folder: string | null,
  projectFile: string | null, bookmark: string | null): boolean {
  if (!projectFile) return false;
  if (editor?.labviewProjectPath !== undefined) {
    try { return labviewLinkTarget(folder, editor) === projectFile; } catch { return false; }
  }
  return Boolean(bookmark && editor?.robotProjectBookmarkId === bookmark);
}

export async function resolveProjectLabviewLink(folder: string | null, editor: ProjectEditorState | undefined,
  bookmarks: readonly { id: string; projectPath: string }[], assertCurrent: () => void): Promise<string | null> {
  assertCurrent();
  const selection = editor?.labviewProjectPath !== undefined
    ? labviewLinkTarget(folder, editor)
    : bookmarks.find(item => item.id === editor?.robotProjectBookmarkId)?.projectPath;
  if (!selection) return null;
  // Inspect the original spelling before realpath: resolving first would hide junctions and symlinks.
  await statLabviewLocalPath(selection); assertCurrent();
  const resolved = await resolveLabviewProject(selection); assertCurrent();
  return resolved.projectFile;
}

/** Only three direct directories, at most 4096 entries total. Any uncertainty suppresses the proposal. */
export async function suggestProjectLabviewLink(folder: string | null, assertCurrent: () => void): Promise<string | null> {
  if (!folder) return null;
  let directory = folder, inspected = 0, candidate: string | null = null;
  for (let level = 0; level < 3; level += 1) {
    assertCurrent();
    await statLabviewLocalPath(directory); assertCurrent();
    const entries = await fs.opendir(directory);
    try {
      assertCurrent();
      for await (const entry of entries) {
        assertCurrent();
        if (++inspected > 4096) return null;
        if (!entry.name.toLowerCase().endsWith(".lvproj")) continue;
        // Do not advertise a unique choice when another candidate is unreadable or a link.
        if (!entry.isFile() || candidate) return null;
        const file = path.join(directory, entry.name);
        await resolveLabviewProject(file); assertCurrent();
        candidate = file;
      }
    } finally { await entries.close().catch(error => { if ((error as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED") throw error; }); }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return candidate;
}

/** Source serialization may rebase editor context; the captured recovery remains byte-for-byte authored. */
export function rebaseProjectLabviewLink(project: BordeauxProject, from: string | null, to: string,
  linked?: { file: string | null; bookmark: string | null }): BordeauxProject {
  const editor = project.editor;
  if (from === to || (!editor?.robotProjectBookmarkId && editor?.labviewProjectPath === undefined)) return project;
  let file = labviewLinkTarget(from, editor);
  // Untitled explicit links can become portable on their first save. A detached recovery has no trusted base.
  if (editor?.labviewProjectPath === undefined && linked && labviewLinkMatches(editor, from, linked.file, linked.bookmark)) file = linked.file;
  if (editor?.labviewProjectPath === undefined && !file) return project; // Preserve legacy bookmark semantics.
  const labviewProjectPath = file ? relativeLabviewLink(to, file) : null;
  // A portable link is the whole selection; the machine bookmark stays out of the Git-shared file.
  const { robotProjectBookmarkId: _bookmark, ...portable } = editor ?? {};
  return { ...project, editor: labviewProjectPath ? { ...portable, labviewProjectPath } : { ...editor, labviewProjectPath } };
}
