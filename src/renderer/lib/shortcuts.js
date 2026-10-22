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

/** Space belongs to playback in the workspace; text and explicit value choosers own it while editing. */
export function isPlaybackSpace(event, page, doc = document) {
  if (!['plan', 'auto'].includes(page) || event.key !== ' ' || event.defaultPrevented || event.isComposing || event.keyCode === 229
    || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  const target = event.target;
  if (target?.isContentEditable || target?.closest?.('[data-native-chrome],[data-role="issue"],[data-problems-control],.choice-change,input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"],[role="listbox"],[role="menu"],[aria-haspopup],[popovertarget],.seg,.toggle,[role="radio"],[role="checkbox"],[role="switch"]')) return false;
  return ![...doc.querySelectorAll('dialog[open],[role="dialog"],[role="menu"],[role="listbox"],[popover]:popover-open')]
    .some(element => element.getClientRects().length > 0);
}
