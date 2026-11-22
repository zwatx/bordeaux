import { AUTO } from './routineModel';
import { markerInvocations } from '../../core/markerCommands';

// One searchable index of robot commands, shared by the routine Add menu and the inspector's Change command.
// Catalogs are immutable snapshots: an entry is cached per command object and an index per command array, so a
// background catalog refresh rebuilds only what changed and never keeps an old label alive.

// Folders that hold commands without naming a mechanism. Diagnostics folders are named on purpose: they become their
// own dimmed subsystem instead of hiding inside another one.
const GENERIC = new Set(['subsystems', 'subsystem', 'commands', 'command', 'cmds', 'src', 'source', 'robot', 'vis', 'vi', 'sub vis', 'subvis',
  'lib', 'libs', 'library', 'common', 'shared', 'support']);
const DIAGNOSTIC = /^(tests?|testing|sysid|sys id|diagnostics?|debug|tuning|characteri[sz]ation)$/i;
// Old copies and numbered variants rank below the command they shadow.
const LEGACY = /^copy of\b|\bcopy( \d+)?$|\((old|copy|backup|deprecated|unused)\)|\b(old|deprecated|backup|unused)$|\bv\d+$/i;
// A small catalog lists every command; subsystems only help once there are enough commands to group.
export const SMALL_CATALOG = 12;
const IN_ROUTINE_LIMIT = 4;

const entries = new WeakMap(), indexes = new WeakMap(), textIndexes = new WeakMap();
const lower = (text) => String(text || '').toLocaleLowerCase();
const words = (text) => lower(String(text || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2')).split(/[\s_\-()[\]/\\.,:;·]+/u).filter(Boolean);
const lowerFirst = (text) => (/^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text);

/** LabVIEW legacy commands all report a completion status; it says nothing that tells two commands apart. */
export function isCompletionStatus(output) {
  return output?.label === 'Completion status' || (Array.isArray(output?.fieldPath) && output.fieldPath.at(-1) === 'Status' && output.fieldPath.length === 2);
}

function folders(command) {
  return String(command.member || '').replace(/\\/g, '/').split('/').slice(0, -1).map((part) => part.trim()).filter(Boolean);
}

/** The nearest folder that names a mechanism; without one, the label's first word (or "Other" for one-word labels). */
export function subsystemOf(command) {
  const parts = folders(command);
  for (let index = parts.length - 1; index >= 0; index--) {
    const name = parts[index].replace(/[\s_-]+(commands?|cmds|subsystem)$/i, '').trim();
    if (name && !GENERIC.has(name.toLowerCase())) return name;
  }
  // Generated (Java) catalogs carry the owning class instead of folders: frc.robot.subsystems.ShooterSubsystem → Shooter.
  const owner = String(command.ownerType || '');
  if (owner && !/labview/i.test(owner)) {
    const name = owner.split(/[.$]/).pop().replace(/(subsystem|commands?)$/i, '').trim();
    if (name && !GENERIC.has(name.toLowerCase())) return name;
  }
  const label = String(command.label || '').trim().split(/[\s_]+/);
  return label.length > 1 && label[0] ? label[0] : 'Other';
}

/** "Timeout s, Angle deg · reports has note": the inputs and the outputs that tell this command apart. */
export function commandMetaLine(inputs, outputs) {
  return [inputs.map((parameter) => (parameter.label || parameter.name) + (parameter.unit ? ' ' + parameter.unit : '')).join(', '),
    outputs.length ? 'reports ' + outputs.map((output) => lowerFirst(output.label || output.name)).join(', ') : ''].filter(Boolean).join(' · ');
}

/** Everything the pickers show and rank for one command. */
export function commandEntry(command) {
  let entry = entries.get(command);
  if (entry) return entry;
  const label = String(command.label || command.id || '');
  const subsystem = subsystemOf(command);
  const inputs = (command.parameters || []).filter((parameter) => parameter.role === 'argument');
  const outputs = (command.outputs || []).filter((output) => !isCompletionStatus(output));
  const head = label.slice(0, subsystem.length);
  const prefixed = lower(head) === lower(subsystem) && /^[\s_\-:·]+\S/u.test(label.slice(subsystem.length));
  const rest = prefixed ? label.slice(subsystem.length).replace(/^[\s_\-:·]+/u, '') : label;
  const labelWords = words(label), restWords = words(rest);
  const diagnostic = DIAGNOSTIC.test(subsystem) || folders(command).some((part) => DIAGNOSTIC.test(part));
  entry = { id: command.id, command, label, subsystem, key: lower(subsystem), prefix: prefixed ? head : '', rest, inputs, outputs,
    meta: commandMetaLine(inputs, outputs), diagnostic, legacy: LEGACY.test(label.trim()),
    lower: lower(label), restLower: lower(rest), words: labelWords, restWords,
    initials: labelWords.map((word) => word[0]).join(''), restInitials: restWords.map((word) => word[0]).join(''),
    hay: lower([subsystem, ...inputs.flatMap((parameter) => [parameter.label, parameter.name, parameter.unit, parameter.description]),
      ...outputs.flatMap((output) => [output.label, output.name]), command.description, ...(command.semanticTags || []), command.id, command.member, command.ownerType,
      ...(command.parameters || []).filter((parameter) => parameter.role !== 'argument').flatMap((parameter) => [parameter.label, parameter.name])].filter(Boolean).join(' ')) };
  entries.set(command, entry);
  return entry;
}

/**
 * The index for one command array: entries in catalog order, and subsystems with their commands. Subsystems are
 * alphabetical with diagnostics last. `browsable` says whether grouping helps (enough commands in two or more groups).
 */
export function commandIndex(commands) {
  let index = indexes.get(commands);
  if (index) return index;
  // Entries are shared between indexes (they are cached per command), so each index keeps its own catalog order.
  const list = (commands || []).filter((command) => command && command.id).map(commandEntry);
  const byKey = new Map(), order = new Map(list.map((entry, position) => [entry, position]));
  list.forEach((entry) => {
    let subsystem = byKey.get(entry.key);
    if (!subsystem) byKey.set(entry.key, subsystem = { key: entry.key, name: entry.subsystem, entries: [], diagnostic: false, lower: entry.key });
    subsystem.entries.push(entry);
    subsystem.diagnostic = subsystem.diagnostic || entry.diagnostic;
  });
  const subsystems = [...byKey.values()].sort((a, b) => Number(a.diagnostic) - Number(b.diagnostic) || a.name.localeCompare(b.name));
  for (const subsystem of subsystems) {
    const dirs = subsystem.entries.map((entry) => folders(entry.command).join('/'));
    subsystem.folder = dirs.every((dir) => dir === dirs[0]) ? dirs[0] : '';
  }
  const groups = subsystems.filter((subsystem) => subsystem.entries.length > 1);
  index = { entries: list, order, byId: new Map(list.map((entry) => [entry.id, entry])), subsystems, bySubsystem: byKey,
    browsable: list.length > SMALL_CATALOG && groups.length >= 2 };
  indexes.set(commands, index);
  return index;
}

/**
 * How often each command is used: in this routine, and anywhere in the project (routines and path events).
 * Nothing new is saved; `order` lists this routine's commands by first use.
 */
export function commandUsage(routines, paths, routine) {
  const counts = new Map(), order = [];
  const bump = (id, field) => {
    if (typeof id !== 'string' || !id) return;
    let count = counts.get(id);
    if (!count) counts.set(id, count = { routine: 0, project: 0 });
    count[field]++;
    if (field === 'routine' && count.routine === 1) order.push(id);
  };
  const included = (routines || []).some((item) => item?.id === routine?.id);
  for (const item of routines || []) AUTO.walk(item?.nodes, (node) => bump(node.invocation?.commandId, 'project'));
  for (const path of paths || []) for (const marker of path?.markers || []) for (const invocation of markerInvocations(marker)) bump(invocation?.commandId, 'project');
  if (routine) AUTO.walk(routine.nodes, (node) => { bump(node.invocation?.commandId, 'routine'); if (!included) bump(node.invocation?.commandId, 'project'); });
  return { counts, order };
}

function score(entry, terms, query, scoped, usage) {
  const label = scoped ? entry.restLower : entry.lower, wordList = scoped ? entry.restWords : entry.words;
  const initials = terms.length === 1 && query.length >= 2 && (scoped ? entry.restInitials : entry.initials).startsWith(query);
  let total = label === query ? 100 : 0;
  for (const term of terms) {
    let best;
    if (label.startsWith(term)) best = 6;
    else if (wordList.some((word) => word.startsWith(term))) best = 4;
    else if (initials) best = 3;
    else if (entry.lower.includes(term)) best = 1.5;
    else if (entry.hay.includes(term)) best = 0.8;
    else return -1;
    if (wordList.includes(term)) best += 2;
    total += best;
  }
  const use = usage?.counts?.get(entry.id);
  if (use) total += (use.routine ? 1.5 : 0) + Math.min(1, use.project * 0.25);
  if (entry.legacy) total -= 1.5;
  return total - entry.words.length * 0.05;
}

const termsOf = (query) => lower(query).trim().split(/\s+/).filter(Boolean);

/** Ranked matches: every term must match the name or its details; name starts beat word starts, initials and substrings. */
export function searchCommands(index, query, { scope, usage } = {}) {
  const terms = termsOf(query), pool = scope ? index.bySubsystem.get(scope)?.entries || [] : index.entries;
  if (!terms.length) return pool.map((entry) => ({ entry, score: 0 }));
  const joined = terms.join(' '), found = [];
  for (const entry of pool) { const value = score(entry, terms, joined, Boolean(scope), usage); if (value >= 0) found.push({ entry, score: value }); }
  // Diagnostics (Test, SysId) always rank after every other match.
  return found.sort((a, b) => Number(a.entry.diagnostic) - Number(b.entry.diagnostic) || b.score - a.score || index.order.get(a.entry) - index.order.get(b.entry));
}

/** Subsystems whose name starts with the query; one-command groups never get a row. */
export function matchSubsystems(index, query) {
  const text = termsOf(query).join(' ');
  if (!text) return [];
  return index.subsystems.filter((subsystem) => subsystem.entries.length > 1 && subsystem.lower.startsWith(text))
    .map((subsystem) => ({ subsystem, score: (subsystem.lower === text ? 100 : 7) - (subsystem.diagnostic ? 3 : 0) }));
}

/**
 * The command part of a picker as sections of rows, so both pickers show the same thing:
 * - no query: In this routine, Subsystems and Other commands (or every command when the catalog is small);
 * - a query: one ranked list, with matching subsystems first;
 * - inside a subsystem: commands used in the project first, then the rest, without the repeated prefix.
 * Rows are { type: 'subsystem', subsystem } or { type: 'command', entry, showPrefix }; each section carries its best score.
 */
export function commandSections(index, { query = '', scope = null, usage = null } = {}) {
  const terms = termsOf(query), command = (entry, showPrefix) => ({ type: 'command', entry, showPrefix });
  const subsystem = scope && index.bySubsystem.get(scope);
  if (subsystem) {
    if (terms.length) {
      const found = searchCommands(index, query, { scope, usage });
      return found.length ? [{ title: subsystem.name + ' commands', note: plural(found.length, 'match'), best: found[0].score, rows: found.map(({ entry }) => command(entry, false)) }] : [];
    }
    const used = subsystem.entries.filter((entry) => usage?.counts?.get(entry.id)?.project)
      .sort((a, b) => usage.counts.get(b.id).project - usage.counts.get(a.id).project || index.order.get(a) - index.order.get(b));
    const others = subsystem.entries.filter((entry) => !used.includes(entry));
    return [
      used.length && { title: 'Used in this project', best: 0, rows: used.map((entry) => command(entry, false)) },
      others.length && { title: used.length ? 'Other ' + subsystem.name + ' commands' : subsystem.name + ' commands', note: String(others.length), best: 0, rows: others.map((entry) => command(entry, false)) },
    ].filter(Boolean);
  }
  if (terms.length) {
    const groups = index.browsable ? matchSubsystems(index, query) : [], found = searchCommands(index, query, { usage });
    if (!groups.length && !found.length) return [];
    return [{ title: 'Commands', note: plural(found.length, 'match'), best: Math.max(groups[0]?.score ?? -Infinity, found[0]?.score ?? -Infinity),
      rows: [...groups.map(({ subsystem: group }) => ({ type: 'subsystem', subsystem: group })), ...found.map(({ entry }) => command(entry, true))] }];
  }
  if (!index.browsable) return index.entries.length ? [{ title: 'Commands', best: 0, rows: index.entries.map((entry) => command(entry, true)) }] : [];
  const here = (usage?.order || []).map((id) => index.byId.get(id)).filter(Boolean).slice(0, IN_ROUTINE_LIMIT);
  // A command already listed under In this routine isn't repeated under Other commands.
  const listed = new Set(here), groups = index.subsystems.filter((group) => group.entries.length > 1);
  const singles = index.subsystems.filter((group) => group.entries.length === 1 && !listed.has(group.entries[0]));
  return [
    here.length && { title: 'In this routine', best: 0, rows: here.map((entry) => command(entry, true)) },
    { title: 'Subsystems', note: plural(index.entries.length, 'command'), best: 0, rows: groups.map((group) => ({ type: 'subsystem', subsystem: group })) },
    singles.length && { title: 'Other commands', best: 0, rows: singles.map((group) => command(group.entries[0], true)) },
  ].filter(Boolean);
}

/**
 * The same sections as ChoiceBrowser options (the inspector's Change command): the first row of each section names
 * it; subsystem rows open (`enter`); rows inside a subsystem show the short name and keep the full one as `title`.
 */
export function commandChoiceRows(index, query, scope, usage) {
  return commandSections(index, { query, scope, usage }).flatMap((section) => section.rows.map((row, position) => {
    const head = position === 0 ? { section: section.title, sectionNote: section.note } : {};
    if (row.type === 'subsystem') {
      const group = row.subsystem;
      return { ...head, value: 'subsystem:' + group.key, enter: group.key, label: group.name, dim: group.diagnostic,
        meta: plural(group.entries.length, 'command') + (group.diagnostic ? ' · diagnostics' : '') };
    }
    const entry = row.entry, hidden = Boolean(entry.prefix) && !row.showPrefix;
    return { ...head, value: entry.id, label: hidden ? entry.rest : entry.label, title: hidden ? entry.label : undefined, meta: entry.meta, dim: entry.diagnostic };
  }));
}

const choiceItems = new WeakMap();
/** One current-choice item per command: its name, and its subsystem with the meta line. */
export function commandChoiceItems(commands) {
  let items = choiceItems.get(commands);
  if (!items) {
    items = commandIndex(commands).entries.map((entry) => ({ value: entry.id, label: entry.label, meta: [entry.subsystem, entry.meta].filter(Boolean).join(' · ') }));
    choiceItems.set(commands, items);
  }
  return items;
}

/** The subsystem a picker opens on for the current command, when the catalog is large enough to group. */
export function openSubsystem(index, id) {
  const entry = index.byId.get(id);
  return entry && index.browsable && index.bySubsystem.get(entry.key)?.entries.length > 1 ? entry.key : null;
}

/**
 * Ranked search for a plain command list (the path event picker): its command choices in ranked order, then any
 * other matching choice (No command, a missing command). An empty search keeps the list as given.
 */
export function rankCommandChoices(items, commands, query) {
  if (!termsOf(query).length) return items;
  const scores = new Map(searchCommands(commandIndex(commands), query).map(({ entry, score: value }) => [entry.id, value]));
  const ranked = items.filter((item) => scores.has(item.value)).sort((a, b) => scores.get(b.value) - scores.get(a.value));
  return [...ranked, ...rankChoices(items.filter((item) => !scores.has(item.value) && !commandIndex(commands).byId.has(item.value)), query).map(({ item }) => item)];
}

/** Rank ordinary choices (paths, steps) with the same tiers: label start, word start, substring, then details. */
export function rankChoices(items, query) {
  const terms = termsOf(query);
  if (!terms.length) return items.map((item) => ({ item, score: 0 }));
  let text = textIndexes.get(items);
  if (!text) {
    text = items.map((item) => ({ lower: lower(item.label), words: words(item.label), hay: lower([item.meta, item.searchText].filter(Boolean).join(' ')) }));
    textIndexes.set(items, text);
  }
  const joined = terms.join(' '), found = [];
  items.forEach((item, order) => {
    const { lower: label, words: list, hay } = text[order];
    let total = label === joined ? 100 : 0;
    for (const term of terms) {
      const best = label.startsWith(term) ? 6 : list.some((word) => word.startsWith(term)) ? 4 : label.includes(term) ? 1.5 : hay.includes(term) ? 0.8 : -1;
      if (best < 0) return;
      total += best + (list.includes(term) ? 2 : 0);
    }
    found.push({ item, score: total, order });
  });
  return found.sort((a, b) => b.score - a.score || a.order - b.order);
}

/** Text split into plain and matched parts: word starts that begin with a query term are marked. */
export function markMatches(text, query) {
  const terms = termsOf(query);
  if (!terms.length || !text) return [{ text, mark: false }];
  const parts = [];
  for (const piece of String(text).split(/(\s+)/)) {
    const term = terms.filter((candidate) => lower(piece).startsWith(candidate)).sort((a, b) => b.length - a.length)[0];
    if (term) parts.push({ text: piece.slice(0, term.length), mark: true }, { text: piece.slice(term.length), mark: false });
    else parts.push({ text: piece, mark: false });
  }
  return parts.filter((part) => part.text);
}

/** How a command is used, in a few words. */
export function usageText(usage, id) {
  const use = usage?.counts?.get(id);
  if (!use?.project) return 'Not used yet';
  if (use.routine) return use.routine === 1 ? 'Used in this routine' : 'Used ' + use.routine + ' times in this routine';
  return use.project === 1 ? 'Used once in this project' : 'Used ' + use.project + ' times in this project';
}

function plural(count, word) { return count.toLocaleString() + ' ' + word + (count === 1 ? '' : /(s|ch)$/.test(word) ? 'es' : 's'); }
