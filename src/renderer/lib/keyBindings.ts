import { useEffect, useState } from "react";
import {
  ariaShortcut, commandForEvent, DEFAULT_RESOLVED_KEY_RULES, formatShortcut, matchesShortcut, parseShortcut, resolveKeyRules, shortcutsFor,
  type CommandId, type KeyContext, type KeyEventLike, type KeyRule,
} from "../../core/keyBindings";

/** True on macOS, where "mod" means ⌘. The desktop host reports its platform; the browser host falls back to the user agent. */
export function isMacPlatform(): boolean {
  if (typeof window === "undefined") return false;
  const platform = window.bordeauxAPI?.platform;
  if (platform) return platform === "darwin";
  return typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
}

// The rules key handlers and labels read: defaults until loadKeyRules adds the user's rules from the host.
let userRules: readonly KeyRule[] = [];
let rules = DEFAULT_RESOLVED_KEY_RULES;
let version = 0;
const listeners = new Set<() => void>();

function adopt(next: readonly KeyRule[]): void {
  userRules = next;
  rules = resolveKeyRules(next);
  version += 1;
  listeners.forEach((listener) => listener());
}

/** Reads the user's rules from the host. The entry point awaits it before the first render. */
export async function loadKeyRules(): Promise<void> {
  try {
    const stored = await window.bordeauxAPI?.getKeyRules?.();
    if (stored) adopt(stored);
  } catch (error) {
    // Keys still work with the defaults; the host logs its own read failures.
    console.warn("Using default keys:", error);
  }
}

/** Whether this host can store changed keys. Editing is hidden where it can't. */
export function canEditKeys(): boolean {
  return typeof window !== "undefined" && typeof window.bordeauxAPI?.setKeyRules === "function";
}

/** The user's own rules (defaults excluded), the input to editCommandKeys. */
export function currentUserKeyRules(): readonly KeyRule[] {
  return userRules;
}

/** Stores new user rules through the host and applies what it kept. Throws when the host can't store them. */
export async function saveKeyRules(next: readonly KeyRule[]): Promise<void> {
  const save = window.bordeauxAPI?.setKeyRules;
  if (!save) throw new Error("This host can't store keys");
  adopt(await save([...next]));
}

/** Tells the host a key is being recorded, so the desktop's File menu lets that key through. */
export function setKeyRecording(recording: boolean): void {
  void window.bordeauxAPI?.setKeyRecording?.(recording).catch(() => undefined);
}

/** Re-renders a component when keys change, so its labels stay current. Returns a number that changes with the keys. */
export function useKeyRules(): number {
  const [seen, setSeen] = useState(version);
  useEffect(() => {
    const listener = () => setSeen(version);
    listeners.add(listener);
    listener(); // Keys may have changed between render and subscribing.
    return () => { listeners.delete(listener); };
  }, []);
  return seen;
}

/**
 * The command a key press runs in `context`, or null. Each handler keeps its own focus checks and passes what it knows.
 * A focused control that lists the key in its own aria-keyshortcuts keeps it, such as a routine row's A, unless the
 * listed key is this command's own (Push lists its shortcut).
 */
export function keyCommand(event: KeyEventLike & { target?: EventTarget | null }, context: KeyContext = {}): CommandId | null {
  const mac = isMacPlatform(), command = commandForEvent(rules, event, context, mac);
  const declared = command && (event.target as Element | null)?.closest?.("[aria-keyshortcuts]")?.getAttribute?.("aria-keyshortcuts");
  if (!declared) return command;
  const own = new Set((ariaKeys(command) ?? "").split(" "));
  const local = declared.split(/\s+/).filter((token) => token && !own.has(token));
  return local.some((token) => {
    const shortcut = parseShortcut(token.replace(/Control/g, "ctrl"));
    return shortcut && matchesShortcut(event, shortcut, mac, false);
  }) ? null : command;
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

/** A rule key ("mod+shift+k") formatted for this platform, for messages about a key that isn't bound yet. */
export function formatKey(key: string): string {
  const shortcut = parseShortcut(key);
  return shortcut ? formatShortcut(shortcut, isMacPlatform()) : key;
}

/** The `aria-keyshortcuts` value for a command, or undefined when it has no key. */
export function ariaKeys(command: CommandId): string | undefined {
  const mac = isMacPlatform();
  const value = shortcutsFor(rules, command).map((shortcut) => ariaShortcut(shortcut, mac)).join(" ");
  return value || undefined;
}
