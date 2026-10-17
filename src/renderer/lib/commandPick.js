import { focusIfAvailable } from './focusReturn';

// Placing a command opens its search once. The request names one placement in one document and path, and is
// spent by the render that first shows that marker selected, whether its chooser opened or not.

/** A request only when the robot catalog can offer commands at placement; otherwise nothing is left pending. */
export const commandPickRequest = (token, { catalog, status, documentKey, pathId, markerId }) =>
  catalog?.commands?.length && status !== 'loading' ? { token, documentKey, pathId, markerId } : null;

/** Whether a request is spent: shown, stale, its marker gone, or its placement's selection no longer pending. */
export function retireCommandPick(pick, { projectKey, docId, markers = [], sel, selPending }) {
  if (!pick) return false;
  const at = markers.findIndex((marker) => marker?.id === pick.markerId);
  return pick.documentKey !== projectKey || pick.pathId !== docId || at < 0 || (sel?.kind === 'em' && sel.idx === at) || !selPending;
}

/** Compare-and-clear: a retirement clears only its own request, never a newer placement's. */
export const clearCommandPick = (token) => (current) => (current?.token === token ? null : current);

/** Command choices; "No command" appears only once one is set, last, so typing never makes it the first match. */
export const commandChoices = (commands = [], invocationId = '') =>
  (invocationId && !commands.some((command) => command.id === invocationId) ? [{ value: invocationId, label: invocationId, meta: 'Not in robot code', badge: 'Missing' }] : [])
    .concat(commands.map((command) => ({ value: command.id, label: command.label, meta: command.member, searchText: [command.description, command.id].filter(Boolean).join(' ') })))
    .concat(invocationId ? [{ value: '', label: 'No command' }] : []);

/**
 * Escape from the closed command trigger clears the selection like Escape on the field; the open search keeps its
 * own first Escape. Focus moves to the first available target only after the clear succeeds.
 */
export function escapeCommandTrigger(event, escapeSelection, targets) {
  if (event.key !== 'Escape' || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
    || event.target !== event.currentTarget.querySelector('.cmd-picker-trigger') || !escapeSelection?.()) return false;
  event.preventDefault();
  targets().some(focusIfAvailable);
  return true;
}
