// Shortcut labels follow the platform: ⇧⌘S on macOS, Ctrl+Shift+S elsewhere.
export function isMacPlatform() {
  if (typeof window === 'undefined') return false;
  const platform = window.bordeauxAPI?.platform;
  if (platform) return platform === 'darwin';
  return typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
}

export function shortcutLabel(key, { shift = false } = {}, mac = isMacPlatform()) {
  return mac ? (shift ? '⇧' : '') + '⌘' + key : 'Ctrl+' + (shift ? 'Shift+' : '') + key;
}

/** The modifier word used in prose, such as "⌘-click" or "Ctrl-click". */
export function modifierName(mac = isMacPlatform()) {
  return mac ? '⌘' : 'Ctrl';
}

/**
 * Space belongs to playback in the workspace. Text entry always keeps it. Other controls (switches, segmented choices,
 * menu buttons, summaries) keep it only when reached from the keyboard; after a mouse click they keep focus but Space
 * still plays and pauses, so a click elsewhere never steals the shortcut.
 */
const TEXT_ENTRY = 'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="color"]):not([type="file"]),textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]';
const KEYBOARD_CONTROLS = '[data-native-chrome],[data-role="issue"],[data-problems-control],details>summary,.choice-change[aria-expanded][aria-controls],input,[role="combobox"],[role="listbox"],[role="menu"],[aria-haspopup],[popovertarget],.seg,.toggle,[role="radio"],[role="checkbox"],[role="switch"]';
// Chromium marks the focused element :focus-visible as soon as any key is pressed, so focus modality is tracked here:
// the element focused by a pointer press (or by a focus restore right after one), until a key operates it.
// Focus restored by a click handler or on the next frame lands well inside this; later script focus does not.
const POINTER_FOCUS_WINDOW_MS = 50;
let pointerFocused = null, tracking = false;
export function trackFocusModality(doc = document, now = () => performance.now()) {
  let pressedAt = -Infinity;
  const down = () => { pressedAt = now(); };
  // Playback claims its Space in a window capture listener, so any key that reaches here (Space included) operated the
  // focused control from the keyboard; that control keeps Space from now on.
  const key = (event) => { pressedAt = -Infinity; if (event.target === pointerFocused) pointerFocused = null; };
  const focusin = (event) => { pointerFocused = now() - pressedAt <= POINTER_FOCUS_WINDOW_MS ? event.target : null; };
  doc.addEventListener('pointerdown', down, true); doc.addEventListener('pointerup', down, true);
  doc.addEventListener('keydown', key, true); doc.addEventListener('focusin', focusin, true);
  tracking = true;
  return () => {
    doc.removeEventListener('pointerdown', down, true); doc.removeEventListener('pointerup', down, true);
    doc.removeEventListener('keydown', key, true); doc.removeEventListener('focusin', focusin, true);
    tracking = false; pointerFocused = null;
  };
}
function keyboardFocused(target) { return !tracking || target !== pointerFocused; }
export function isPlaybackSpace(event, page, doc = document) {
  if (!['plan', 'auto'].includes(page) || event.key !== ' ' || event.defaultPrevented || event.isComposing || event.keyCode === 229
    || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  const target = event.target;
  if (target?.isContentEditable || target?.closest?.(TEXT_ENTRY)) return false;
  if (target?.closest?.(KEYBOARD_CONTROLS) && keyboardFocused(target)) return false;
  if (target?.closest?.('[role="dialog"],dialog')) return false;
  // Open dialogs, menus and popup lists own the keyboard. A hover tooltip is a top-layer popover too, but it owns no keys,
  // and an inline result list (the inspector's command chooser) stays on screen while editing, so neither withholds playback.
  return ![...doc.querySelectorAll('dialog:modal,[role="dialog"]:not([aria-modal="false"]),[role="menu"],[role="listbox"]:not(.choice-results),[popover]:popover-open:not([role="tooltip"])')]
    .some(element => element.getClientRects().length > 0);
}
