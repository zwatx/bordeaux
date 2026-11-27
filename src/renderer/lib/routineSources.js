import { commandSections, rankChoices, searchCommands } from './commandIndex';
import { AUTO } from './routineModel';
import { UnitPrefs } from './unitPreferences';

// What the routine source library lists while a step is being added or a path step changed. Rows are plain data for
// one flat, keyboard-navigable list: `group` rows (a path folder or a command subsystem) open and close, `item` rows add
// or choose, `more` rows reveal the next batch, and `label` rows only name a short block.

export const SEARCH_LIMIT = 60;
export const GROUP_LIMIT = 50;
const IN_ROUTINE_LIMIT = 4;

/** Trajectory time as the path library shows it, or why a path has none yet. */
export function pathTime(path, times) {
  const time = times?.[path.id];
  if ((path.waypoints?.length || 0) < 2) return 'Not timed yet';
  return time?.status === 'ready' && Number.isFinite(time.seconds) ? time.seconds.toFixed(2) + ' s' : '';
}

/**
 * Paths in the project's own library order: each folder (in folder order), then paths without a folder. A search ranks
 * names first and folder names after, as one list whose rows name their folder. `closed` holds collapsed folder ids.
 * `continues` holds the ids of paths that start where the robot is at the insertion point; while browsing they are
 * also listed first, under "Continues from here", and keep their place in their folders.
 */
export function pathSourceRows(paths, { folders = [], times = {}, uses = new Map(), query = '', closed = new Set(), current, continues = new Set() } = {}) {
  const folderName = (id) => (id ? folders.find((folder) => folder.id === id)?.name || '' : '');
  const item = (path, inFolder) => ({ type: 'item', key: 'path:' + path.id, kind: 'path', ref: path.id, path, label: path.name || 'Untitled path',
    time: pathTime(path, times), uses: uses.get(path.id) || 0, folder: inFolder ? '' : folderName(path.folderId), current: path.id === current });
  if (query.trim()) {
    const choices = paths.map((path) => ({ path, label: path.name || '', meta: folderName(path.folderId) }));
    return rankChoices(choices, query).map(({ item: choice }) => item(choice.path, false));
  }
  const rows = [];
  const here = paths.filter((path) => continues.has(path.id));
  if (here.length) rows.push({ type: 'label', key: 'label:here', label: 'Continues from here' }, ...here.map((path) => ({ ...item(path, false), key: 'here:path:' + path.id })));
  for (const folder of folders) {
    const members = paths.filter((path) => path.folderId === folder.id);
    if (!members.length) continue;
    const open = !closed.has(folder.id);
    rows.push({ type: 'group', key: 'folder:' + folder.id, id: folder.id, label: folder.name, count: members.length, open });
    if (open) rows.push(...members.map((path) => ({ ...item(path, true), depth: 1 })));
  }
  const loose = paths.filter((path) => !path.folderId || !folders.some((folder) => folder.id === path.folderId));
  if (loose.length && rows.length > here.length + (here.length ? 1 : 0)) rows.push({ type: 'label', key: 'label:loose', label: 'Not in a folder' });
  rows.push(...loose.map((path) => item(path, true)));
  return rows;
}

const commandItem = (entry, showPrefix, depth = 0) => ({ type: 'item', key: 'command:' + entry.id, kind: 'command', command: entry.command, entry,
  label: entry.label, name: showPrefix || !entry.prefix ? entry.label : entry.rest, meta: entry.meta, dim: entry.diagnostic, depth });

/**
 * Commands as a subsystem tree. Browsing shows the routine's own commands first, then every subsystem (diagnostics
 * last, dimmed) with its commands while it is open, and one-command subsystems under "Other commands". A catalog
 * without subsystems lists its commands directly, a batch at a time. A search is one ranked list whose rows keep their subsystem name. `open` holds open
 * subsystem keys and `limits` how many rows each open group (or the search, under '') shows.
 */
export function commandSourceRows(index, { query = '', usage = null, open = new Set(), limits = new Map() } = {}) {
  const more = (scope, shown, total) => (total > shown ? [{ type: 'more', key: 'more:' + scope, scope, label: 'Show ' + Math.min(total - shown, scope ? GROUP_LIMIT : SEARCH_LIMIT * 4).toLocaleString() + ' more', remaining: total - shown, depth: scope ? 1 : 0 }] : []);
  if (query.trim()) {
    const found = searchCommands(index, query, { usage }), limit = limits.get('') || SEARCH_LIMIT;
    return [...found.slice(0, limit).map(({ entry }) => commandItem(entry, true)), ...more('', limit, found.length)];
  }
  if (!index.browsable) { const limit = limits.get('') || SEARCH_LIMIT; return [...index.entries.slice(0, limit).map((entry) => commandItem(entry, true)), ...more('', limit, index.entries.length)]; }
  const rows = [], here = (usage?.order || []).map((id) => index.byId.get(id)).filter(Boolean).slice(0, IN_ROUTINE_LIMIT);
  if (here.length) rows.push({ type: 'label', key: 'label:here', label: 'In this routine' }, ...here.map((entry) => ({ ...commandItem(entry, true), key: 'here:' + entry.id })));
  const groups = index.subsystems.filter((group) => group.entries.length > 1), singles = index.subsystems.filter((group) => group.entries.length === 1);
  const block = (key, label, entries, extra) => {
    const isOpen = open.has(key), limit = limits.get(key) || GROUP_LIMIT;
    rows.push({ type: 'group', key: 'subsystem:' + key, id: key, label, count: entries.length, open: isOpen, ...extra });
    if (isOpen) rows.push(...entries.slice(0, limit).map((entry) => commandItem(entry, key === OTHER, 1)), ...more(key, limit, entries.length));
  };
  for (const group of groups) {
    // Commands used in the project lead their subsystem, as everywhere else commands are offered.
    const ordered = commandSections(index, { scope: group.key, usage }).flatMap((section) => section.rows.map((row) => row.entry));
    block(group.key, group.name, ordered, { dim: group.diagnostic, note: group.diagnostic ? 'diagnostics' : '' });
  }
  if (singles.length) block(OTHER, 'Other commands', singles.map((group) => group.entries[0]));
  return rows;
}
export const OTHER = '\0other';

/** The subsystem key a command is listed under in the tree. */
export function commandGroupKey(index, id) {
  const entry = index.byId.get(id);
  if (!entry) return null;
  return index.bySubsystem.get(entry.key)?.entries.length > 1 ? entry.key : OTHER;
}

/**
 * How a path's start relates to the robot's pose at the insertion point: "Starts here" within a small jump
 * (AUTO.jumpSize), otherwise the distance, like "0.5 m off". Null when there is no pose to compare (the first step).
 */
export function pathStartHint(path, pose, robot) {
  const start = path?.waypoints?.[0];
  if (!pose || !start) return null;
  const distance = Math.hypot(start.x - pose.x, start.y - pose.y);
  return AUTO.jumpSize(distance, robot) === 'small' ? { here: true, text: 'Starts here' } : { here: false, text: UnitPrefs.format(distance, 'm', 1) + ' off' };
}
