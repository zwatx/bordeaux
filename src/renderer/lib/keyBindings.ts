import {
  ariaShortcut, commandForEvent, DEFAULT_RESOLVED_KEY_RULES, formatShortcut, resolveKeyRules, shortcutsFor,
  type CommandId, type KeyContext, type KeyEventLike,
} from "../../core/keyBindings";

/** True on macOS, where "mod" means ⌘. The desktop host reports its platform; the browser host falls back to the user agent. */
export function isMacPlatform(): boolean {
  if (typeof window === "undefined") return false;
  const platform = window.bordeauxAPI?.platform;
  if (platform) return platform === "darwin";
  return typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
}

// The rules key handlers and labels read: defaults until loadKeyRules adds the user's rules from the host.
let rules = DEFAULT_RESOLVED_KEY_RULES;

/** Reads the user's rules from the host. The entry point awaits it before the first render, so labels never change after it. */
export async function loadKeyRules(): Promise<void> {
  try {
    const userRules = await window.bordeauxAPI?.getKeyRules?.();
    if (userRules) rules = resolveKeyRules(userRules);
  } catch (error) {
    // Keys still work with the defaults; the host logs its own read failures.
    console.warn("Using default keys:", error);
  }
}

/** The command a key press runs in `context`, or null. Each handler keeps its own focus checks and passes what it knows. */
export function keyCommand(event: KeyEventLike, context: KeyContext = {}): CommandId | null {
  return commandForEvent(rules, event, context, isMacPlatform());
}

/** Every key for a command, formatted for this platform ("1", "V"; "⇧⌘S" or "Ctrl+Shift+S"). Empty when it has none. */
export function keyLabels(command: CommandId): string[] {
  const mac = isMacPlatform();
  return shortcutsFor(rules, command).map((shortcut) => formatShortcut(shortcut, mac));
}

/** The first key for a command, for tooltips and menus, or "" when it has none. */
export function keyLabel(command: CommandId): string {
  return keyLabels(command)[0] ?? "";
}

/** The `aria-keyshortcuts` value for a command, or undefined when it has no key. */
export function ariaKeys(command: CommandId): string | undefined {
  const mac = isMacPlatform();
  const value = shortcutsFor(rules, command).map((shortcut) => ariaShortcut(shortcut, mac)).join(" ");
  return value || undefined;
}
