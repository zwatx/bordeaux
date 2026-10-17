import type { BordeauxProject, ProjectEditorState } from "../../shared/types";

// Only main-authored link fields are reconciled; a newer explicit selection wins over an older save.
export const sameRobotLink = (a: ProjectEditorState | undefined, b: ProjectEditorState | undefined) => a?.labviewProjectPath === b?.labviewProjectPath && a?.robotProjectBookmarkId === b?.robotProjectBookmarkId;
export function withRobotLink(project: BordeauxProject, link: ProjectEditorState | undefined): BordeauxProject {
  if (sameRobotLink(project.editor, link)) return project;
  const { labviewProjectPath: _path, robotProjectBookmarkId: _bookmark, ...editor } = project.editor || {};
  return { ...project, editor: { ...editor,
    ...(link?.labviewProjectPath !== undefined ? { labviewProjectPath: link.labviewProjectPath } : {}),
    ...(link?.robotProjectBookmarkId ? { robotProjectBookmarkId: link.robotProjectBookmarkId } : {}) } };
}
export function reconcileSavedRobotLink(current: BordeauxProject, captured: BordeauxProject, canonical?: BordeauxProject): BordeauxProject {
  return canonical && sameRobotLink(current.editor, captured.editor) ? withRobotLink(current, canonical.editor) : current;
}
