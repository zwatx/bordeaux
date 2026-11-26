/**
 * One bounded, chronological undo journal shared by every editor surface.
 *
 * Each entry belongs to a scope: the path it edits (`path:<id>`), the routine
 * library (`routines`), or the whole project (`project`, for deletions, library moves and
 * applied proposals). A surface undoes the newest entry in one of its scopes.
 * Entries from other surfaces are skipped, but never jumped over when they
 * touched the same state: undoing then would silently rewrite that surface.
 */
import { type Arrangement, captureArrangement, restoreArrangement } from "./libraryOrder";

export type UndoEntry = { scope: string; touches: readonly string[] };

export const UNDO_LIMIT = 80;
export const PROJECT_SCOPE = "project";
export const ROUTINE_SCOPE = "routines";
export const pathScope = (pathId: string) => "path:" + pathId;

/** Scopes the visible surface may undo: the active path or routine library, then project-wide changes. */
export function undoScopes(page: string, activePathId: string | null | undefined): string[] {
  if (page === "plan" && activePathId) return [pathScope(activePathId), PROJECT_SCOPE];
  if (page === "auto") return [ROUTINE_SCOPE, PROJECT_SCOPE];
  return [PROJECT_SCOPE];
}

/** Index of the newest applicable entry, or -1 when none applies or a newer overlapping entry blocks it. */
export function applicableIndex(stack: readonly UndoEntry[], scopes: readonly string[]): number {
  const skipped = new Set<string>();
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const entry = stack[index];
    if (scopes.includes(entry.scope)) return entry.touches.some((key) => skipped.has(key)) ? -1 : index;
    entry.touches.forEach((key) => skipped.add(key));
  }
  return -1;
}

/**
 * `apply` performs an entry and returns the entry that reverses it, or null
 * when the entry can no longer be applied. A refused entry stays in place.
 */
export type ApplyUndo<T extends UndoEntry> = (entry: T) => T | null;

export function createUndoHistory<T extends UndoEntry>(limit = UNDO_LIMIT) {
  let past: T[] = [];
  let future: T[] = [];
  const push = (stack: T[], entry: T) => {
    stack.push(entry);
    if (stack.length > limit) stack.shift();
  };
  const step = (from: T[], to: T[], scopes: readonly string[], apply: ApplyUndo<T>) => {
    const index = applicableIndex(from, scopes);
    if (index < 0) return false;
    const inverse = apply(from[index]);
    if (!inverse) return false;
    from.splice(index, 1);
    push(to, inverse);
    return true;
  };
  return {
    /** Records a new change. Any redo branch is discarded, as in a single linear history. */
    record(entry: T) { push(past, entry); future = []; },
    peekUndo: (scopes: readonly string[]): T | null => past[applicableIndex(past, scopes)] ?? null,
    canUndo: (scopes: readonly string[]) => applicableIndex(past, scopes) >= 0,
    canRedo: (scopes: readonly string[]) => applicableIndex(future, scopes) >= 0,
    undo: (scopes: readonly string[], apply: ApplyUndo<T>) => step(past, future, scopes, apply),
    redo: (scopes: readonly string[], apply: ApplyUndo<T>) => step(future, past, scopes, apply),
    clear() { past = []; future = []; },
    get size() { return { past: past.length, future: future.length }; },
  };
}

type Link = { fromPathId: string; toPathId: string };
type LibraryPath = { id: string; name?: string; folderId?: string; waypoints?: { positionLink?: string }[] };
type Folder = { id: string };
type LinkedProject = { paths: LibraryPath[]; pathLinks?: Link[] | null };
type Project = LinkedProject & { pathFolders?: Folder[] | null; robot: { planning?: unknown }; activeRobotId?: string;
  robots?: { id: string; robot?: { planning?: unknown } }[] };

/** Where a robot's planning is now: `project.robot` while it is selected, its list entry otherwise. Null once removed. */
function robotPlanning(project: Project, robotId: string | undefined): { planning: unknown } | null {
  if (robotId === project.activeRobotId) return { planning: project.robot.planning };
  const entry = project.robots?.find((robot) => robot.id === robotId);
  return entry?.robot ? { planning: entry.robot.planning } : null;
}
type FolderProject = { paths: LibraryPath[]; pathFolders?: Folder[] | null };

/** The paths and every path whose waypoints move with them through endpoint or shared-position links. */
export function linkedPathIds(project: LinkedProject, pathIds: string | readonly string[]): string[] {
  const groups = new Map<string, Set<string>>();
  const adjacent = new Map<string, Set<string>>();
  const join = (a: string, b: string) => {
    if (a === b) return;
    if (!adjacent.has(a)) adjacent.set(a, new Set());
    if (!adjacent.has(b)) adjacent.set(b, new Set());
    adjacent.get(a)!.add(b); adjacent.get(b)!.add(a);
  };
  for (const path of project.paths) {
    for (const waypoint of path.waypoints || []) {
      if (!waypoint.positionLink) continue;
      const members = groups.get(waypoint.positionLink) || new Set<string>();
      members.forEach((member) => join(member, path.id));
      members.add(path.id); groups.set(waypoint.positionLink, members);
    }
  }
  for (const link of project.pathLinks || []) join(link.fromPathId, link.toPathId);
  const queue = [...new Set(typeof pathIds === "string" ? [pathIds] : pathIds)], visited = new Set(queue);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    for (const next of adjacent.get(queue[cursor]) || []) if (!visited.has(next)) { visited.add(next); queue.push(next); }
  }
  return [...visited];
}

const linkKey = (link: Link) => link.fromPathId + "\n" + link.toPathId;
/** Links in `from` that `to` lacks, compared by endpoints. */
const missingLinks = (from: Link[] | null | undefined, to: Link[] | null | undefined) => {
  const present = new Set((to || []).map(linkKey));
  return (from || []).filter((link) => !present.has(linkKey(link)));
};

type Fields = Record<string, unknown>;
const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
/** Structural equality for plain settings values; an undefined field equals a missing one. */
const sameValue = (a: unknown, b: unknown): boolean => Object.is(a, b)
  || (isFields(a) && isFields(b) && [...new Set([...Object.keys(a), ...Object.keys(b)])].every((key) => sameValue(a[key], b[key])));

/**
 * Reverts a `before`→`after` change within `current`. A value edited since the
 * change keeps its newer content: objects present on both sides revert field by
 * field, and an added or removed object reverts only while it is unedited.
 * Returns `current` itself when nothing reverts.
 */
function revertFields(current: unknown, before: unknown, after: unknown): unknown {
  if (sameValue(current, after)) return sameValue(current, before) ? current : before;
  if (!isFields(current) || !isFields(before) || !isFields(after)) return current;
  let next: Fields | null = null;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const value = revertFields(current[key], before[key], after[key]);
    if (value === current[key]) continue;
    next ??= { ...current };
    if (value === undefined) delete next[key]; else next[key] = value;
  }
  return next ?? current;
}

/** Robot planning is also edited on the Robot page outside the journal, so it reverts only the fields a change set. */
const revertPlanning = (current: unknown, change: { before: unknown; after: unknown }) => {
  const base = current ?? {};
  const next = revertFields(base, change.before ?? {}, change.after ?? {});
  if (next === base) return current;
  return change.before === undefined && isFields(next) && Object.values(next).every((value) => value === undefined) ? undefined : next;
};

/** What undoing a whole-project or shared-position change must restore. */
export type ProjectChange = {
  /** Changed paths as they were before; null for a path the change created. */
  paths: { id: string; index: number; path: LibraryPath | null }[];
  links: { restore: Link[]; remove: Link[] } | null;
  /** Planning set on the robot selected at the time; `robotId` is undefined for a project without a robot list. */
  planning?: { before: unknown; after: unknown; robotId?: string };
  activePathId: string | null;
};

/**
 * Captures the change from `before` to `after`. Its touches cover every path
 * linked to a changed path or link endpoint, before or after: restoring an
 * old relationship must not jump over a newer edit to a former neighbor.
 */
export function captureProjectChange(before: Project, after: Project, activePathId: string | null, robotId = after.activeRobotId) {
  const find = (project: Project, id: string) => project.paths.find((path) => path.id === id);
  const pathIds = [...new Set([...before.paths, ...after.paths].map((path) => path.id))].filter((id) => find(before, id) !== find(after, id));
  const restore = missingLinks(before.pathLinks, after.pathLinks), remove = missingLinks(after.pathLinks, before.pathLinks);
  // Planning is compared on one robot: the selected one, or the one an undone entry belongs to.
  const was = robotPlanning(before, robotId), now = robotPlanning(after, robotId);
  const planning = Boolean(was && now && was.planning !== now.planning);
  const seeds = [...pathIds, ...[...restore, ...remove].flatMap((link) => [link.fromPathId, link.toPathId])];
  const touched = new Set([...linkedPathIds(before, seeds), ...linkedPathIds(after, seeds)]);
  const change: ProjectChange = {
    paths: pathIds.map((id) => {
      const index = before.paths.findIndex((path) => path.id === id);
      return { id, index, path: index >= 0 ? before.paths[index] : null };
    }),
    links: restore.length || remove.length ? { restore, remove } : null,
    ...(planning ? { planning: { before: was!.planning, after: now!.planning, robotId } } : {}),
    activePathId,
  };
  return { touches: [...[...touched].map(pathScope), ...(planning ? ["robot.planning"] : [])], change };
}

const withFolder = <P extends { folderId?: string }>(path: P, folderId: string | undefined): P => {
  if (path.folderId === folderId) return path;
  const next = { ...path };
  if (folderId) next.folderId = folderId; else delete next.folderId;
  return next;
};

/** A restored path keeps its current library name and folder; arranging the library is its own entry. */
export const withLibraryFields = <P extends { name?: string; folderId?: string }>(saved: P, current: P): P =>
  withFolder({ ...saved, name: current.name }, current.folderId);

/**
 * Reverses a captured change on the current project. Surviving paths keep
 * their current library name and folder. A restored endpoint link yields to a
 * newer link at the same endpoint, since each end joins at most one path.
 */
export function restoreProjectChange<T extends Project>(project: T, change: ProjectChange): T {
  const folders = new Set((project.pathFolders || []).map((folder) => folder.id));
  let paths: LibraryPath[] = project.paths.filter((path) => !change.paths.some((entry) => !entry.path && entry.id === path.id));
  for (const entry of change.paths.filter((item) => item.path).sort((a, b) => a.index - b.index)) {
    const at = paths.findIndex((path) => path.id === entry.id), current = paths[at];
    if (current) paths = paths.map((path, index) => index === at ? withLibraryFields(entry.path!, current) : path);
    else {
      const restored = withFolder(entry.path!, folders.has(entry.path!.folderId!) ? entry.path!.folderId : undefined);
      paths = [...paths.slice(0, Math.max(0, entry.index)), restored, ...paths.slice(Math.max(0, entry.index))];
    }
  }
  let pathLinks = project.pathLinks;
  if (change.links) {
    const exists = (id: string) => paths.some((path) => path.id === id);
    const links = missingLinks(project.pathLinks, change.links.remove).filter((link) => exists(link.fromPathId) && exists(link.toPathId));
    for (const link of change.links.restore) {
      if (exists(link.fromPathId) && exists(link.toPathId) && !links.some((item) => item.fromPathId === link.fromPathId || item.toPathId === link.toPathId)) links.push(link);
    }
    pathLinks = links;
  }
  // Planning reverts on the robot it was set on, selected or not. A robot removed since keeps nothing to revert.
  const owner = change.planning && robotPlanning(project, change.planning.robotId);
  const planning = owner ? revertPlanning(owner.planning, change.planning!) : undefined;
  if (!owner || planning === owner.planning) return { ...project, paths, pathLinks };
  if (change.planning!.robotId === project.activeRobotId) return { ...project, paths, pathLinks, robot: { ...project.robot, planning } };
  return { ...project, paths, pathLinks, robots: project.robots!.map((robot) => robot.id === change.planning!.robotId ? { ...robot, robot: { ...robot.robot, planning } } : robot) };
}

export type FolderChange = { folder: Folder; index: number; memberIds: string[] };

/** Deletes a folder, leaving its paths in the library, and captures what restores it. */
export function deleteFolder<T extends FolderProject>(project: T, id: string): { change: FolderChange; project: T } | null {
  const folders = project.pathFolders || [], index = folders.findIndex((folder) => folder.id === id);
  if (index < 0) return null;
  const change = { folder: folders[index], index, memberIds: project.paths.filter((path) => path.folderId === id).map((path) => path.id) };
  return { change, project: { ...project, pathFolders: folders.filter((_, at) => at !== index), paths: project.paths.map((path) => path.folderId === id ? withFolder(path, undefined) : path) } };
}

/**
 * Restores a deleted folder at its position. Only former members still
 * outside any folder rejoin it; newer folders and moves stay as they are.
 */
export function restoreFolder<T extends FolderProject>(project: T, change: FolderChange): T | null {
  const folders = project.pathFolders || [];
  if (folders.some((folder) => folder.id === change.folder.id)) return null;
  return { ...project, pathFolders: [...folders.slice(0, change.index), change.folder, ...folders.slice(change.index)],
    paths: project.paths.map((path) => !path.folderId && change.memberIds.includes(path.id) ? withFolder(path, change.folder.id) : path) };
}

export type ProjectEntry = UndoEntry & (
  | { kind: "project" | "waypoints"; change: ProjectChange }
  | { kind: "folder"; restore?: FolderChange | null; folderId?: string }
  | { kind: "library"; arrangement: Arrangement });

/**
 * Applies a project-wide, shared-position, folder, or library arrangement entry. Returns the next
 * project and the entry that reverses it, or null when it no longer applies.
 */
export function applyProjectEntry<T extends Project>(project: T, entry: ProjectEntry, activePathId: string | null): { project: T; inverse: ProjectEntry } | null {
  if (entry.kind === "library") {
    const next = restoreArrangement(project, entry.arrangement);
    return { project: next, inverse: { ...entry, arrangement: captureArrangement(project, next) } };
  }
  if (entry.kind !== "folder") {
    const next = restoreProjectChange(project, entry.change);
    return { project: next, inverse: { ...entry, ...captureProjectChange(project, next, activePathId, entry.change.planning ? entry.change.planning.robotId : next.activeRobotId) } };
  }
  const deleted = entry.restore ? null : deleteFolder(project, entry.folderId!);
  const next = entry.restore ? restoreFolder(project, entry.restore) : deleted?.project;
  return next ? { project: next, inverse: { ...entry, restore: deleted?.change, folderId: entry.restore?.folder.id } } : null;
}
