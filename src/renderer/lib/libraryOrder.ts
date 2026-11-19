/**
 * Library arrangement: the order of paths and folders and which folder holds each path. The library lists folders in
 * `pathFolders` order and each folder's paths (then the unfiled ones) in `paths` order, so arranging only reorders
 * those arrays and sets `folderId`.
 */
type ArrangedPath = { id: string; folderId?: string };
type ArrangedProject = { paths: ArrangedPath[]; pathFolders?: { id: string }[] | null };

export type Arrangement = {
  pathIds: string[];
  folderIds: string[];
  /** The folder (or null) of each path whose folder the change set. */
  folders: Record<string, string | null>;
};

const folderOf = (path: ArrangedPath) => path.folderId || null;
const withFolder = <P extends ArrangedPath>(path: P, folderId: string | null): P => {
  if (folderOf(path) === folderId) return path;
  const next = { ...path };
  if (folderId) next.folderId = folderId; else delete next.folderId;
  return next;
};
const sameOrder = (a: readonly { id: string }[], b: readonly { id: string }[]) => a.length === b.length && a.every((item, index) => item === b[index]);

/**
 * Moves paths, in the given order, into a folder (null for none), before `beforeId` or, without one, after that
 * folder's last remaining path. Returns the project itself when nothing changes or the target is not valid.
 */
export function movePaths<T extends ArrangedProject>(project: T, ids: readonly string[], folderId: string | null, beforeId: string | null = null): T {
  const moving = new Set(ids);
  if (folderId && !(project.pathFolders || []).some((folder) => folder.id === folderId)) return project;
  if (beforeId && moving.has(beforeId)) return project;
  const byId = new Map(project.paths.map((path) => [path.id, path]));
  const moved = [...moving].filter((id) => byId.has(id)).map((id) => withFolder(byId.get(id)!, folderId));
  if (!moved.length) return project;
  const rest = project.paths.filter((path) => !moving.has(path.id));
  let at = beforeId ? rest.findIndex((path) => path.id === beforeId) : -1;
  if (at >= 0 && folderOf(rest[at]) !== folderId) return project;
  if (at < 0) {
    const last = rest.map(folderOf).lastIndexOf(folderId);
    at = last >= 0 ? last + 1 : rest.length;
  }
  const paths = [...rest.slice(0, at), ...moved, ...rest.slice(at)];
  return sameOrder(paths, project.paths) ? project : { ...project, paths };
}

/** Moves a folder before `beforeId`, or to the end without one. */
export function moveFolder<T extends ArrangedProject>(project: T, id: string, beforeId: string | null = null): T {
  const folders = project.pathFolders || [], folder = folders.find((item) => item.id === id);
  if (!folder || beforeId === id) return project;
  const rest = folders.filter((item) => item.id !== id);
  const at = beforeId ? rest.findIndex((item) => item.id === beforeId) : rest.length;
  if (at < 0) return project;
  const pathFolders = [...rest.slice(0, at), folder, ...rest.slice(at)];
  return sameOrder(pathFolders, folders) ? project : { ...project, pathFolders };
}

/** What restores `before`'s arrangement after a change to `after`. */
export function captureArrangement(before: ArrangedProject, after: ArrangedProject): Arrangement {
  const previous = new Map(before.paths.map((path) => [path.id, folderOf(path)]));
  const folders: Record<string, string | null> = {};
  for (const path of after.paths) {
    if (previous.has(path.id) && previous.get(path.id) !== folderOf(path)) folders[path.id] = previous.get(path.id)!;
  }
  return { pathIds: before.paths.map((path) => path.id), folderIds: (before.pathFolders || []).map((folder) => folder.id), folders };
}

/** Puts the listed items back in their recorded order within the places they occupy now; others keep their place. */
function reorderWithin<I extends { id: string }>(items: readonly I[], order: readonly string[]): I[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  const listed = items.filter((item) => rank.has(item.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  let cursor = 0;
  return items.map((item) => rank.has(item.id) ? listed[cursor++] : item);
}

/**
 * Restores a recorded arrangement on the current project. Paths and folders created since keep their place, deleted
 * ones are skipped, and a path whose recorded folder no longer exists keeps its current folder.
 */
export function restoreArrangement<T extends ArrangedProject>(project: T, arrangement: Arrangement): T {
  const existing = new Set((project.pathFolders || []).map((folder) => folder.id));
  const paths = reorderWithin(project.paths, arrangement.pathIds).map((path) => {
    if (!Object.hasOwn(arrangement.folders, path.id)) return path;
    const folderId = arrangement.folders[path.id];
    return folderId && !existing.has(folderId) ? path : withFolder(path, folderId);
  });
  const folders = project.pathFolders || [], pathFolders = reorderWithin(folders, arrangement.folderIds);
  const pathsChanged = paths.some((path, index) => path !== project.paths[index]);
  const foldersChanged = !sameOrder(pathFolders, folders);
  if (!pathsChanged && !foldersChanged) return project;
  return { ...project, ...(pathsChanged ? { paths } : {}), ...(foldersChanged ? { pathFolders } : {}) };
}
