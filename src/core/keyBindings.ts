/**
 * Keyboard shortcuts for Bordeaux commands: one ordered list of rules, `{ key, command, when? }`, after t3code's
 * keybindings. Renderer key handlers, the native File menu, the shortcuts dialog and on-screen labels read keys from
 * here, so a key changes in one place. Pure data and string handling: it builds for Electron main, the renderer and
 * workers.
 *
 * The last rule whose key and `when` condition both match an event runs. Each listener passes the context flags it
 * knows; a flag it does not pass is false.
 */

export const COMMAND_IDS = [
  'tool.select', 'tool.waypoint', 'tool.rotation', 'tool.command', 'tool.zone',
  'view.fit', 'view.grid', 'view.focusField', 'visit.next', 'visit.previous',
  'playback.toggle', 'edit.undo', 'edit.redo',
  'project.new', 'project.list', 'project.openFile', 'project.save', 'project.saveCopy',
  'export.bdx', 'robot.push',
] as const;
export type CommandId = (typeof COMMAND_IDS)[number];

/** Names shown in the shortcuts dialog. */
export const COMMAND_LABELS = {
  'tool.select': 'Select / move',
  'tool.waypoint': 'Place waypoint',
  'tool.rotation': 'Place rotation',
  'tool.command': 'Place command',
  'tool.zone': 'Create zone',
  'view.fit': 'Fit field',
  'view.grid': 'Toggle grid',
  'view.focusField': 'Toggle path list',
  'visit.next': 'Next pass through a point',
  'visit.previous': 'Previous pass through a point',
  'playback.toggle': 'Play / pause',
  'edit.undo': 'Undo',
  'edit.redo': 'Redo',
  'project.new': 'New project',
  'project.list': 'Projects',
  'project.openFile': 'Open project file',
  'project.save': 'Save project and BDX files',
  'project.saveCopy': 'Save copy',
  'export.bdx': 'Export selected path as BDX',
  'robot.push': 'Push selected paths',
} as const satisfies Record<CommandId, string>;

/** Flags a `when` condition can name. */
export interface KeyContext {
  /** A text field, select or other editor owns the keyboard. */
  readonly editableFocus?: boolean;
  readonly pathsPage?: boolean;
  readonly routinesPage?: boolean;
}

/**
 * One rule. `key` is modifiers and one key joined by "+", such as "mod+shift+s"; "mod" is ⌘ on macOS and Ctrl
 * elsewhere. A user rule with an empty key unbinds its command: it replaces the defaults and matches nothing.
 */
export interface KeyRule {
  readonly key: string;
  readonly command: CommandId;
  /** A condition over `KeyContext` flags with `!`, `&&`, `||` and parentheses, such as "pathsPage && !editableFocus". */
  readonly when?: string;
}

export const DEFAULT_KEY_RULES: readonly KeyRule[] = [
  { key: '1', command: 'tool.select', when: 'pathsPage' },
  { key: 'v', command: 'tool.select', when: 'pathsPage' },
  { key: '2', command: 'tool.waypoint', when: 'pathsPage' },
  { key: 'w', command: 'tool.waypoint', when: 'pathsPage' },
  { key: '3', command: 'tool.rotation', when: 'pathsPage' },
  { key: 'r', command: 'tool.rotation', when: 'pathsPage' },
  { key: '4', command: 'tool.command', when: 'pathsPage' },
  { key: 'm', command: 'tool.command', when: 'pathsPage' },
  { key: '5', command: 'tool.zone', when: 'pathsPage' },
  { key: 'c', command: 'tool.zone', when: 'pathsPage' },
  { key: 'f', command: 'view.fit', when: 'pathsPage' },
  { key: 'g', command: 'view.grid', when: 'pathsPage' },
  { key: '\\', command: 'view.focusField', when: 'pathsPage' },
  { key: ']', command: 'visit.next', when: 'pathsPage' },
  { key: '[', command: 'visit.previous', when: 'pathsPage' },
  { key: 'space', command: 'playback.toggle', when: 'pathsPage || routinesPage' },
  { key: 'mod+z', command: 'edit.undo', when: '!editableFocus' },
  { key: 'mod+shift+z', command: 'edit.redo', when: '!editableFocus' },
  { key: 'mod+y', command: 'edit.redo', when: '!editableFocus' },
  { key: 'mod+n', command: 'project.new' },
  { key: 'mod+o', command: 'project.list' },
  { key: 'mod+shift+o', command: 'project.openFile' },
  { key: 'mod+s', command: 'project.save' },
  { key: 'mod+shift+s', command: 'project.saveCopy' },
  { key: 'mod+e', command: 'export.bdx' },
  { key: 'mod+shift+p', command: 'robot.push' },
];

/** A parsed key. `key` is lowercase, or " " for Space. */
export interface Shortcut {
  readonly key: string;
  readonly mod: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

export type WhenNode =
  | { readonly type: 'flag'; readonly name: string }
  | { readonly type: 'not'; readonly node: WhenNode }
  | { readonly type: 'and' | 'or'; readonly left: WhenNode; readonly right: WhenNode };

export interface ResolvedKeyRule {
  readonly command: CommandId;
  readonly shortcut: Shortcut;
  readonly when?: WhenNode;
  /** The condition text, so two rules with the same condition can be recognized. */
  readonly whenText?: string;
}

/** Parses "mod+shift+s". Returns null for an empty part, two keys, or no key. */
export function parseShortcut(value: string): Shortcut | null {
  const parts = value.toLowerCase().split('+').map((part) => part.trim());
  // A trailing "+" names the plus key itself, as in "mod++".
  if (parts.length > 1 && parts[parts.length - 1] === '' && parts[parts.length - 2] === '') parts.splice(-2, 2, '+');
  let key: string | null = null, mod = false, ctrl = false, meta = false, shift = false, alt = false;
  for (const part of parts) {
    switch (part) {
      case 'mod': mod = true; break;
      case 'ctrl': case 'control': ctrl = true; break;
      case 'cmd': case 'meta': meta = true; break;
      case 'shift': shift = true; break;
      case 'alt': case 'option': alt = true; break;
      case '': return null;
      default:
        if (key !== null) return null;
        key = part === 'space' ? ' ' : part === 'esc' ? 'escape' : part;
    }
  }
  return key === null ? null : { key, mod, ctrl, meta, shift, alt };
}

const MAX_WHEN_DEPTH = 32;

/** Parses a `when` condition. Returns null when it is malformed. */
export function parseWhen(expression: string): WhenNode | null {
  const tokens = expression.match(/&&|\|\||[!()]|[A-Za-z_][A-Za-z0-9_.-]*|\S/g) ?? [];
  let index = 0;
  const unary = (depth: number): WhenNode | null => {
    if (depth > MAX_WHEN_DEPTH) return null;
    const token = tokens[index];
    if (token === '!') { index += 1; const node = unary(depth + 1); return node && { type: 'not', node }; }
    if (token === '(') {
      index += 1;
      const node = or(depth + 1);
      if (!node || tokens[index] !== ')') return null;
      index += 1;
      return node;
    }
    if (token && /^[A-Za-z_]/.test(token)) { index += 1; return { type: 'flag', name: token }; }
    return null;
  };
  const binary = (type: 'and' | 'or', operator: string, next: (depth: number) => WhenNode | null) => (depth: number): WhenNode | null => {
    let left = next(depth);
    while (left && tokens[index] === operator) {
      index += 1;
      const right = next(depth);
      left = right && { type, left, right };
    }
    return left;
  };
  const and = binary('and', '&&', unary);
  const or = binary('or', '||', and);
  const node = tokens.length ? or(0) : null;
  return node && index === tokens.length ? node : null;
}

export function evaluateWhen(node: WhenNode | undefined, context: KeyContext): boolean {
  if (!node) return true;
  switch (node.type) {
    case 'flag': return context[node.name as keyof KeyContext] === true;
    case 'not': return !evaluateWhen(node.node, context);
    case 'and': return evaluateWhen(node.left, context) && evaluateWhen(node.right, context);
    case 'or': return evaluateWhen(node.left, context) || evaluateWhen(node.right, context);
  }
}

/** Compiles rules in order. A rule with a malformed key or condition is dropped on its own. */
export function compileKeyRules(rules: readonly KeyRule[]): ResolvedKeyRule[] {
  return rules.flatMap((rule) => {
    const shortcut = parseShortcut(rule.key);
    const when = rule.when === undefined ? undefined : parseWhen(rule.when);
    if (!shortcut || when === null) return [];
    return [{ command: rule.command, shortcut, ...(when ? { when, whenText: rule.when!.trim() } : {}) }];
  });
}

export const DEFAULT_RESOLVED_KEY_RULES: readonly ResolvedKeyRule[] = compileKeyRules(DEFAULT_KEY_RULES);

/** The parts of a DOM KeyboardEvent that matching reads. */
export interface KeyEventLike {
  readonly key: string;
  readonly code?: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  getModifierState?(key: 'AltGraph'): boolean;
}

// Digits and punctuation match by physical key, so "1" works on AZERTY, where that key types "&" without Shift.
const PHYSICAL_KEYS: Readonly<Record<string, string>> = {
  Backquote: '`', Backslash: '\\', BracketLeft: '[', BracketRight: ']', Comma: ',', Equal: '=', Minus: '-', Period: '.',
  Quote: "'", Semicolon: ';', Slash: '/', Space: ' ',
  Digit0: '0', Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4', Digit5: '5', Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9',
};

/** Keys an event can match: the typed key, its physical key for digits and punctuation, and its physical letter when the layout types a non-Latin letter or macOS Option changes it. */
function eventKeys(event: KeyEventLike): Set<string> {
  const typed = event.key.toLowerCase() === 'esc' ? 'escape' : event.key.toLowerCase();
  const keys = new Set([typed]);
  const letter = event.code?.match(/^Key([A-Z])$/)?.[1];
  if (letter && !/^[a-z]$/.test(typed)) keys.add(letter.toLowerCase());
  const physical = event.code ? PHYSICAL_KEYS[event.code] : undefined;
  if (physical && !/^[a-z]$/.test(typed)) keys.add(physical);
  return keys;
}

/**
 * Whether an event presses `shortcut`. Two cases stay looser than exact matching, as Bordeaux's handlers always were:
 * "mod" accepts ⌘ or Ctrl on every platform, and a plain letter also fires with Shift held.
 */
export function matchesShortcut(event: KeyEventLike, shortcut: Shortcut, mac: boolean, looseShift = true): boolean {
  // AltGr types characters such as "\" on German layouts; those presses are text, never shortcuts.
  if (!mac && event.getModifierState?.('AltGraph') && !/^[a-z0-9]$/i.test(event.key)) return false;
  const ctrl = !!event.ctrlKey, meta = !!event.metaKey;
  if (shortcut.mod ? !(ctrl || meta) || (shortcut.ctrl && !ctrl) || (shortcut.meta && !meta) : ctrl !== shortcut.ctrl || meta !== shortcut.meta) return false;
  if (!!event.altKey !== shortcut.alt) return false;
  const plainLetter = looseShift && /^[a-z]$/.test(shortcut.key) && !shortcut.mod && !shortcut.ctrl && !shortcut.meta && !shortcut.alt && !shortcut.shift;
  if (!plainLetter && !!event.shiftKey !== shortcut.shift) return false;
  return eventKeys(event).has(shortcut.key);
}

/**
 * The command a key press runs: the last rule whose key and condition both match, or null. An exact match wins over
 * a plain letter accepting Shift, so Shift+V for one command and V for another both work.
 */
export function commandForEvent(rules: readonly ResolvedKeyRule[], event: KeyEventLike, context: KeyContext, mac: boolean): CommandId | null {
  for (const looseShift of [false, true]) {
    for (let index = rules.length - 1; index >= 0; index -= 1) {
      const rule = rules[index]!;
      if (evaluateWhen(rule.when, context) && matchesShortcut(event, rule.shortcut, mac, looseShift)) return rule.command;
    }
  }
  return null;
}

function shortcutId(shortcut: Shortcut): string {
  return [shortcut.key, shortcut.mod, shortcut.ctrl, shortcut.meta, shortcut.shift, shortcut.alt].join('|');
}

/**
 * The keys that run `command`, in rule order. A key is left out when a later rule for another command uses it where
 * both can apply: either rule has no condition, or both have the same one.
 */
export function shortcutsFor(rules: readonly ResolvedKeyRule[], command: CommandId): Shortcut[] {
  const claimed: { id: string; whenText?: string }[] = [];
  const found: Shortcut[] = [];
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index]!, id = shortcutId(rule.shortcut);
    const taken = claimed.some((other) => other.id === id && (!other.whenText || !rule.whenText || other.whenText === rule.whenText));
    claimed.push({ id, whenText: rule.whenText });
    if (!taken && rule.command === command) found.unshift(rule.shortcut);
  }
  return found;
}

function keyName(key: string): string {
  if (key === ' ') return 'Space';
  if (key.length === 1) return key.toUpperCase();
  if (key.startsWith('arrow')) return key.slice(5, 6).toUpperCase() + key.slice(6);
  return key.slice(0, 1).toUpperCase() + key.slice(1);
}

/** "⇧⌘S" on macOS, "Ctrl+Shift+S" elsewhere. */
export function formatShortcut(shortcut: Shortcut, mac: boolean): string {
  const ctrl = shortcut.ctrl || (shortcut.mod && !mac), meta = shortcut.meta || (shortcut.mod && mac);
  if (mac) return (ctrl ? '⌃' : '') + (shortcut.alt ? '⌥' : '') + (shortcut.shift ? '⇧' : '') + (meta ? '⌘' : '') + keyName(shortcut.key);
  return [ctrl && 'Ctrl', shortcut.alt && 'Alt', shortcut.shift && 'Shift', meta && 'Meta', keyName(shortcut.key)].filter(Boolean).join('+');
}

/** The `aria-keyshortcuts` form, such as "Control+Shift+P". */
export function ariaShortcut(shortcut: Shortcut, mac: boolean): string {
  const ctrl = shortcut.ctrl || (shortcut.mod && !mac), meta = shortcut.meta || (shortcut.mod && mac);
  return [ctrl && 'Control', meta && 'Meta', shortcut.alt && 'Alt', shortcut.shift && 'Shift', keyName(shortcut.key)].filter(Boolean).join('+');
}

/** The Electron menu accelerator for a command's first key, such as "CmdOrCtrl+Shift+S", or undefined when it has none. */
export function menuAccelerator(rules: readonly ResolvedKeyRule[], command: CommandId): string | undefined {
  const shortcut = shortcutsFor(rules, command)[0];
  if (!shortcut) return undefined;
  return [shortcut.mod && 'CmdOrCtrl', shortcut.ctrl && 'Ctrl', shortcut.meta && 'Super', shortcut.alt && 'Alt', shortcut.shift && 'Shift',
    keyName(shortcut.key)].filter(Boolean).join('+');
}

// ---- The user's own rules ----
// Hosts store only the user's rules, never the defaults, so new defaults appear without migration. A user rule for a
// command replaces every default rule for that command.

/** Commands the native File menu owns. Electron's menu catches their keys everywhere, even while someone types. */
export const MENU_COMMANDS: ReadonlySet<CommandId> = new Set(['project.new', 'project.list', 'project.openFile', 'project.save', 'project.saveCopy', 'export.bdx']);
/** Commands that work while someone types: the File menu's, and Push, whose key also works from a text field. */
export const TYPING_COMMANDS: ReadonlySet<CommandId> = new Set([...MENU_COMMANDS, 'robot.push']);
// Text fields undo and redo with these; a command that works while typing can't take them.
const TEXT_EDIT_SHORTCUTS = ['mod+z', 'mod+shift+z', 'mod+y'].map((key) => parseShortcut(key)!);
const MAX_USER_RULES = 256;
// Keys the app depends on: selection editing, focus and dialog keys at any modifier, plus clipboard, library rename,
// the Windows menu keys, and the Electron menu roles (zoom, developer tools, full screen, close and quit).
const RESERVED_KEYS = new Set(['escape', 'tab', 'enter', 'backspace', 'delete', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
const RESERVED_SHORTCUTS = ['f2', 'f10', 'shift+f10', 'mod+c', 'mod+v', 'mod+x', 'mod+a', 'alt+f', 'alt+r', 'alt+a', 'alt+v', 'alt+h',
  'mod+=', 'mod+-', 'mod+0', 'mod+shift+i', 'mod+alt+i', 'f11', 'mod+w', 'mod+q']
  .map((key) => parseShortcut(key)!);

/** Why a rule can't be used, or null. */
export type RuleProblem =
  | { readonly kind: 'reserved' }
  | { readonly kind: 'needs-mod' }
  | { readonly kind: 'menu-taken'; readonly by: CommandId };

function hasCommandKey(shortcut: Shortcut): boolean {
  return shortcut.mod || shortcut.ctrl || shortcut.meta;
}

function inList(list: readonly Shortcut[], shortcut: Shortcut): boolean {
  return list.some((entry) => entry.key === shortcut.key && entry.mod === hasCommandKey(shortcut) && entry.shift === shortcut.shift && entry.alt === shortcut.alt);
}

/**
 * Checks one rule against the others. Refused: reserved keys; Space for anything but playback, since Space also
 * presses the focused button; for commands that work while typing, a key without ⌘/Ctrl or a text undo key; two File
 * menu commands on one key.
 */
export function ruleProblem(rules: readonly ResolvedKeyRule[], rule: ResolvedKeyRule): RuleProblem | null {
  const { shortcut } = rule;
  if (RESERVED_KEYS.has(shortcut.key) || inList(RESERVED_SHORTCUTS, shortcut)) return { kind: 'reserved' };
  if (shortcut.key === ' ' && !hasCommandKey(shortcut) && !shortcut.alt && rule.command !== 'playback.toggle') return { kind: 'reserved' };
  if (!TYPING_COMMANDS.has(rule.command)) return null;
  if (!hasCommandKey(shortcut)) return { kind: 'needs-mod' };
  if (inList(TEXT_EDIT_SHORTCUTS, shortcut)) return { kind: 'reserved' };
  if (!MENU_COMMANDS.has(rule.command)) return null;
  const id = shortcutId(rule.shortcut);
  const other = rules.find((candidate) => candidate.command !== rule.command && MENU_COMMANDS.has(candidate.command) && shortcutId(candidate.shortcut) === id);
  return other ? { kind: 'menu-taken', by: other.command } : null;
}

function isCommandId(value: unknown): value is CommandId {
  return typeof value === 'string' && (COMMAND_IDS as readonly string[]).includes(value);
}

/**
 * Reads stored user rules from untrusted JSON. Each rule that is malformed, names an unknown command, or has a
 * `ruleProblem` is dropped on its own, so one bad entry never costs the others. Two File menu commands on one key
 * keep the earlier rule.
 */
export function sanitizeUserKeyRules(value: unknown): KeyRule[] {
  if (!Array.isArray(value)) return [];
  const parsed = value.slice(0, MAX_USER_RULES).flatMap((item): KeyRule[] => {
    if (typeof item !== 'object' || item === null) return [];
    const { key, command, when } = item as Record<string, unknown>;
    if (typeof key !== 'string' || key.length > 64 || !isCommandId(command)) return [];
    if (!key.trim()) return [{ key: '', command }];
    if (when !== undefined && (typeof when !== 'string' || !when.trim() || when.length > 256)) return [];
    const rule: KeyRule = when === undefined ? { key: key.trim(), command } : { key: key.trim(), command, when: when.trim() };
    return compileKeyRules([rule]).length ? [rule] : [];
  });
  const overridden = new Set(parsed.map((rule) => rule.command));
  const accepted = DEFAULT_RESOLVED_KEY_RULES.filter((rule) => !overridden.has(rule.command));
  const menuKeyed = new Set<CommandId>();
  return parsed.filter((rule) => {
    const resolved = compileKeyRules([rule])[0];
    if (!resolved) return true;
    // The File menu shows one key per item, so a second key there would be listed but never work.
    if (MENU_COMMANDS.has(rule.command) && menuKeyed.has(rule.command)) return false;
    if (ruleProblem(accepted, resolved)) return false;
    if (MENU_COMMANDS.has(rule.command)) menuKeyed.add(rule.command);
    accepted.push(resolved);
    return true;
  });
}

/** The rules in effect: defaults for commands the user left alone, then the user's rules, which win ties. */
export function resolveKeyRules(userRules: readonly KeyRule[]): ResolvedKeyRule[] {
  const overridden = new Set(userRules.map((rule) => rule.command));
  return [...DEFAULT_RESOLVED_KEY_RULES.filter((rule) => !overridden.has(rule.command)), ...compileKeyRules(userRules)];
}

// ---- Editing ----

/**
 * The rule key a key press would record, such as "mod+shift+k" or "space", or null for a lone modifier or a key typed
 * with AltGr. "mod" is ⌘ on macOS and Ctrl elsewhere; the other of the two is recorded as itself.
 */
export function keyFromEvent(event: KeyEventLike, mac: boolean): string | null {
  const typed = event.key.toLowerCase();
  if (['control', 'shift', 'alt', 'meta', 'altgraph', 'os', 'dead', 'unidentified', 'process'].includes(typed)) return null;
  if (!mac && event.getModifierState?.('AltGraph') && !/^[a-z0-9]$/.test(typed)) return null;
  const letter = event.code?.match(/^Key([A-Z])$/)?.[1]?.toLowerCase();
  const key = /^[a-z]$/.test(typed) ? typed : letter ?? (event.code ? PHYSICAL_KEYS[event.code] : undefined) ?? (typed === 'esc' ? 'escape' : typed);
  if (!key || key === '+') return null;
  const mod = mac ? event.metaKey : event.ctrlKey, other = mac ? event.ctrlKey : event.metaKey;
  return (mod ? 'mod+' : '') + (other ? (mac ? 'ctrl+' : 'meta+') : '') + (event.altKey ? 'alt+' : '') + (event.shiftKey ? 'shift+' : '') + (key === ' ' ? 'space' : key);
}

/** The keys a command has now, as rule keys: the user's if they changed it, otherwise its defaults. */
export function commandKeys(userRules: readonly KeyRule[], command: CommandId): string[] {
  const mine = userRules.filter((rule) => rule.command === command);
  return (mine.length ? mine : DEFAULT_KEY_RULES.filter((rule) => rule.command === command)).map((rule) => rule.key).filter(Boolean);
}

function sameKey(a: string, b: string): boolean {
  const left = parseShortcut(a), right = parseShortcut(b);
  return !!left && !!right && shortcutId(left) === shortcutId(right);
}

function rulesFor(command: CommandId, keys: readonly string[]): KeyRule[] {
  const when = DEFAULT_KEY_RULES.find((rule) => rule.command === command)?.when;
  if (!keys.length) return [{ key: '', command }];
  return keys.map((key) => (when ? { key, command, when } : { key, command }));
}

/** The result of giving a command new keys: the user's next rules, and each key taken from another command. */
export interface KeyEdit {
  readonly rules: KeyRule[];
  readonly taken: readonly { readonly command: CommandId; readonly key: string }[];
  readonly problem: RuleProblem | null;
}

/**
 * Gives `command` exactly `keys` (use DEFAULT keys with `null`). Another command that has one of those keys loses it,
 * so a key always runs one command; the caller shows what was taken. Commands back at their defaults leave the user's
 * rules, so the stored file lists only real changes. `problem` reports a key that can't be used; `rules` then stays
 * unchanged.
 */
export function editCommandKeys(userRules: readonly KeyRule[], command: CommandId, keys: readonly string[] | null): KeyEdit {
  const wanted = keys ?? DEFAULT_KEY_RULES.filter((rule) => rule.command === command).map((rule) => rule.key);
  const next = MENU_COMMANDS.has(command) ? wanted.slice(-1) : wanted;
  for (const key of next) {
    const resolved = compileKeyRules(rulesFor(command, [key]))[0];
    const problem = resolved && ruleProblem([], resolved);
    if (problem) return { rules: [...userRules], taken: [], problem };
  }
  const taken: { command: CommandId; key: string }[] = [];
  const changed = new Map<CommandId, string[]>([[command, [...next]]]);
  for (const other of COMMAND_IDS) {
    if (other === command) continue;
    const current = commandKeys(userRules, other);
    const kept = current.filter((key) => !next.some((wanted) => sameKey(wanted, key)));
    if (kept.length === current.length) continue;
    current.filter((key) => !kept.includes(key)).forEach((key) => taken.push({ command: other, key }));
    changed.set(other, kept);
  }
  const rules = userRules.filter((rule) => !changed.has(rule.command));
  for (const [id, ids] of changed) {
    const defaults = DEFAULT_KEY_RULES.filter((rule) => rule.command === id).map((rule) => rule.key);
    if (ids.length !== defaults.length || ids.some((key, index) => !sameKey(key, defaults[index]!))) rules.push(...rulesFor(id, ids));
  }
  return { rules, taken, problem: null };
}
